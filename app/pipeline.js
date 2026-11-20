// Runs the deal search from inside the app: write the search config from the person's answers, then run
// deals-search as a child process. While it searches it hands over verified deals in batches; each batch gets its
// store branches looked up and is imported straight away, in the background, so the deck has deals to show
// a minute or two in instead of when the whole search is done.
// The state is kept in memory for the page that shows progress; the last finished run's trace also lives
// on disk (scripts/output/trace.json), so "how did the last search work" survives a restart.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HttpError } from "./errors.js";
import { roles } from "./llm.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const searchFile = join(root, "data", "search.json");
const traceFile = join(root, "scripts", "output", "trace.json");
const MAX_LOG_LINES = 40;

const SEARCH = { script: join(root, "scripts", "deals-search.js"), args: ["--config", searchFile, "--stream"] };
const LOCATE = join(root, "scripts", "locate-stores.js");
const IMPORT = join(root, "app", "import.js");

const job = { running: false, step: null, startedAt: null, finishedAt: null, error: null, log: [], trace: null, summary: null, imported: { added: 0, updated: 0, batches: 0 } };

export const keysPresent = () => ({ tavily: Boolean(process.env.TAVILY_API_KEY), tokenFactory: Boolean(process.env.NEBIUS_API_KEY) });

// The model behind each job in the whole system, for the Search tab.
export const modelNames = () => ({
  planner: process.env.STRUCTURE_MODEL || "Qwen/Qwen3-235B-A22B-Instruct-2507",
  structure: process.env.STRUCTURE_MODEL || "Qwen/Qwen3-235B-A22B-Instruct-2507",
  recheck: process.env.STRUCTURE_MODEL || "Qwen/Qwen3-235B-A22B-Instruct-2507",
  parser: roles.parser.model,
  ranker: roles.ranker.model,
  updater: roles.updater.model,
  vision: process.env.VISION_MODEL || "nvidia/Nemotron-3.5-Super-VL",
});

function lastTrace() {
  try {
    return JSON.parse(readFileSync(traceFile, "utf8"));
  } catch {
    return null;
  }
}

export function pipelineStatus() {
  return { ...job, log: job.log.slice(-MAX_LOG_LINES), trace: job.trace ?? lastTrace(), keys: keysPresent(), models: modelNames() };
}

// `answers` is { place, radiusMiles, stores, wants, interests }. Returns right away; poll pipelineStatus().
export function startPipeline(answers) {
  if (job.running) throw new HttpError(409, "A search is already running");
  const keys = keysPresent();
  if (!keys.tavily || !keys.tokenFactory) {
    const missing = [!keys.tavily && "TAVILY_API_KEY", !keys.tokenFactory && "NEBIUS_API_KEY"].filter(Boolean).join(" and ");
    throw new HttpError(400, `Add ${missing} to .env and restart the app. Finding deals needs both.`);
  }
  if (!answers.place) throw new HttpError(400, "Choose your city first");

  mkdirSync(dirname(searchFile), { recursive: true });
  writeFileSync(searchFile, JSON.stringify(answers, null, 2));
  Object.assign(job, { running: true, step: "search", startedAt: new Date().toISOString(), finishedAt: null, error: null, log: [], trace: null, summary: null, imported: { added: 0, updated: 0, batches: 0 } });
  runSearch().catch((err) => finish(err.message));
  return { ok: true };
}

function finish(error = null) {
  Object.assign(job, { running: false, step: null, finishedAt: new Date().toISOString(), error });
  if (!error) job.trace = lastTrace() ?? job.trace;
}

async function runSearch() {
  // Batches wait in line and are processed one at a time (the branch lookup must stay under 1 request a second),
  // while the search keeps going.
  let line = Promise.resolve();
  const onBatch = (file) => {
    line = line.then(() => processBatch(file)).catch((err) => job.log.push(`Batch failed: ${err.message}`));
  };
  const code = await runStep(SEARCH.script, SEARCH.args, onBatch);
  job.step = "import"; // the search is over; the last batches may still be on their way in
  await line;
  if (code !== 0) return finish(`The search failed. ${job.log.at(-1) ?? ""}`.trim());
  const { added, updated } = job.imported;
  job.summary = `Added ${added}, updated ${updated}`;
  finish();
}

async function processBatch(file) {
  // A lookup that fails still leaves the deals usable, just without a nearest store.
  const located = await runStep(LOCATE, [file]);
  if (located !== 0) job.log.push("Finding nearby stores did not finish; adding the deals without them.");
  await runStep(IMPORT, [file]);
  job.imported.batches++;
}

function runStep(script, args, onBatch) {
  return new Promise((resolveStep) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: root, env: process.env });
    const onLine = (line) => {
      if (line.startsWith("::trace ")) {
        try {
          job.trace = JSON.parse(line.slice(8));
        } catch { /* a partial line; the next snapshot replaces it */ }
        return;
      }
      if (line.startsWith("::batch ")) {
        onBatch?.(line.slice(8).trim());
        return;
      }
      if (!line.trim()) return;
      const imported = line.match(/^Added (\d+), updated (\d+)/);
      if (imported) {
        job.imported.added += Number(imported[1]);
        job.imported.updated += Number(imported[2]);
      }
      job.log.push(line.slice(0, 220));
      if (job.log.length > MAX_LOG_LINES * 2) job.log.splice(0, MAX_LOG_LINES);
    };
    for (const stream of [child.stdout, child.stderr]) {
      let rest = "";
      stream.on("data", (chunk) => {
        const lines = (rest + chunk).split("\n");
        rest = lines.pop();
        lines.forEach(onLine);
      });
      stream.on("end", () => rest && onLine(rest));
    }
    child.on("error", (err) => {
      job.log.push(err.message);
      resolveStep(1);
    });
    child.on("close", (code) => resolveStep(code ?? 1));
  });
}
