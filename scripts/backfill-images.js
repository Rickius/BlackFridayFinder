// Finds images for deals that have none, without redoing the search: reads the deals in the seed file and in the
// database, resolves an image for each (see scripts/images.js), and writes them back to both.
//
//   npm run images                  seed and database
//   npm run images -- --seed-only   only app/seed/deals.seed.json
//   npm run images -- --db-only     only the database (data/blackfriday.db, or DB_PATH)
//   npm run images -- --retry       look again at deals that had no match last time
//   npm run images -- --limit 10    only the first 10 deals that need an image (a cheap trial)
//
// Answers are cached in scripts/output/images-cache.json, so running it again costs nothing for deals already looked at.
// A deal costs about 1 Tavily search credit, plus 1 extract credit per 5 pages when it needs one.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { makeStore, resolveStore } from "../app/store-list.js";
import { createImageResolver, mapLimit } from "./images.js";

const { TAVILY_API_KEY, NEBIUS_API_KEY } = process.env;
if (!TAVILY_API_KEY || !NEBIUS_API_KEY) {
  console.error("TAVILY_API_KEY and NEBIUS_API_KEY must be set (copy .env.example to .env)");
  process.exit(1);
}
const MODEL = process.env.STRUCTURE_MODEL ?? "Qwen/Qwen3-235B-A22B-Instruct-2507";
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const limitArg = argv.indexOf("--limit") === -1 ? null : Number(argv[argv.indexOf("--limit") + 1]);
const CONCURRENCY = 4;

const outputDir = new URL("./output/", import.meta.url);
mkdirSync(outputDir, { recursive: true });
const seedPath = fileURLToPath(new URL("../app/seed/deals.seed.json", import.meta.url));

async function tavily(endpoint, body) {
  const res = await fetch(`https://api.tavily.com/${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TAVILY_API_KEY}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Tavily ${endpoint} returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// A small Token Factory client for the yes/no check, with a retry on rate limits. Same signature as the search script's.
async function chat(_step, responseFormat, maxTokens, messages, model = MODEL) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch("https://api.tokenfactory.nebius.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${NEBIUS_API_KEY}` },
      body: JSON.stringify({ model, messages, response_format: responseFormat, temperature: 0, max_tokens: maxTokens }),
    });
    if ([429, 503, 529].includes(res.status) && attempt < 5) {
      await new Promise((r) => setTimeout(r, (Number(res.headers.get("retry-after")) || 2 ** (attempt + 1)) * 1000));
      continue;
    }
    if (!res.ok) throw new Error(`Token Factory returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    if (data.choices[0].finish_reason === "length") throw new Error("model output cut off");
    return data.choices[0].message.content;
  }
}

// ---------- load ----------

const seed = !flag("--db-only") && existsSync(seedPath) ? JSON.parse(readFileSync(seedPath, "utf8")) : null;
let db = null;
if (!flag("--seed-only")) ({ db } = await import("../app/db.js"));
const dbRows = db ? db.prepare("SELECT * FROM deals").all() : [];

const fromRow = (r) => ({
  title: r.title, store: r.store, storeSlug: r.store_slug, salePrice: r.sale_price, originalPrice: r.original_price,
  discountText: r.discount_text, sourceUrl: r.source_url, imageUrl: r.image_url, imageReliable: Boolean(r.image_reliable),
});
const everyone = [...(seed?.deals ?? []), ...dbRows.map(fromRow)];
const needs = [];
const seen = new Set();
for (const deal of everyone) {
  const key = `${deal.store}|${deal.title}|${deal.sourceUrl}`;
  if (seen.has(key) || (deal.imageUrl && deal.imageReliable)) continue;
  seen.add(key);
  needs.push(deal);
}
const todo = limitArg ? needs.slice(0, limitArg) : needs;
console.log(`${seed?.deals.length ?? 0} deals in the seed, ${dbRows.length} in the database; ${needs.length} need an image${limitArg ? `, looking at the first ${todo.length}` : ""}.`);

// ---------- resolve ----------

// Stores the planner suggested carry their own domain (in the seed file, and in the database's store_suggestions table).
const suggestedStores = new Map();
for (const s of [...(seed?.suggestions ?? []), ...(db ? db.prepare("SELECT name, domain FROM store_suggestions").all() : [])]) {
  if (s.name && s.domain) suggestedStores.set(s.name, makeStore(s.name, s.domain));
}
const resolver = createImageResolver({
  tavily, chat, storeFor: (name) => suggestedStores.get(name) ?? resolveStore(name), visionModel: process.env.VISION_MODEL || undefined, cacheFile: fileURLToPath(new URL("images-cache.json", outputDir)), retryNegatives: flag("--retry"),
  log: (line) => console.log(line),
});
const resolved = new Map(); // "store|title|sourceUrl" -> result
let done = 0;
await mapLimit(todo, CONCURRENCY, async (deal) => {
  const result = await resolver.resolve(deal);
  if (result) resolved.set(`${deal.store}|${deal.title}|${deal.sourceUrl}`, result);
  done++;
  const mark = result ? `${result.source} ${new URL(result.url).hostname}` : resolver.why(deal) ?? "no match";
  console.log(`[${done}/${todo.length}] ${deal.store} | ${deal.title.slice(0, 55)} -> ${mark}`);
  if (done % 10 === 0) resolver.save();
});
resolver.save();

// ---------- write back ----------

const applyTo = (deal) => {
  const hit = resolved.get(`${deal.store}|${deal.title}|${deal.sourceUrl}`) ?? null;
  return hit && { imageUrl: hit.url, imageSource: hit.source, imageReliable: true, imageCheckedAt: hit.checkedAt };
};
if (seed) {
  for (const deal of seed.deals) Object.assign(deal, applyTo(deal) ?? {});
  writeFileSync(seedPath, JSON.stringify(seed, null, 2) + "\n");
}
if (db) {
  const update = db.prepare("UPDATE deals SET image_url = ?, image_source = ?, image_reliable = 1, image_checked_at = ? WHERE source_url = ? AND title = ? AND store = ?");
  let updated = 0;
  for (const row of dbRows) {
    const hit = applyTo(fromRow(row));
    if (hit) updated += Number(update.run(hit.imageUrl, hit.imageSource, hit.imageCheckedAt, row.source_url, row.title, row.store).changes);
  }
  console.log(`Updated ${updated} database rows.`);
}

// ---------- report ----------

function coverage(label, deals) {
  const stores = [...new Set(deals.map((d) => d.store))];
  console.log(`\nCoverage (${label}):`);
  for (const s of stores) {
    const own = deals.filter((d) => d.store === s);
    const withImage = own.filter((d) => d.imageUrl && d.imageReliable).length;
    const sources = own.reduce((a, d) => (d.imageSource ? ((a[d.imageSource] = (a[d.imageSource] ?? 0) + 1), a) : a), {});
    console.log(`  ${s}: ${withImage}/${own.length} (${Math.round((100 * withImage) / own.length)}%) ${JSON.stringify(sources)}`);
  }
  const all = deals.filter((d) => d.imageUrl && d.imageReliable).length;
  console.log(`  all: ${all}/${deals.length} (${Math.round((100 * all) / Math.max(1, deals.length))}%)`);
}
if (seed) coverage("seed", seed.deals);
if (db) coverage("database", db.prepare("SELECT * FROM deals").all().map((r) => ({ ...fromRow(r), imageSource: r.image_source })));

const s = resolver.stats;
console.log(`\nResolved ${s.resolved}, no match ${s.none}, from cache ${s.cached}. Tavily: ${s.searches} searches, ${s.extractPages} page extracts (about ${s.searches + Math.ceil(s.extractPages / 5)} credits). Token Factory: ${s.llm} text checks, ${s.vision} picture checks. Image fetches: ${s.probes}.`);
console.log("\nHotlinking (does each image host serve a browser with no Referer and with a localhost Referer?):");
for (const [host, h] of Object.entries(s.hotlink)) {
  console.log(`  ${host}: ${h.ok} load with a localhost referer, ${h.blockedWithReferer} blocked with one; all loaded with no referer; sizes e.g. ${h.sizes.slice(0, 2).join(", ")}`);
}
const nones = todo.filter((d) => !resolved.has(`${d.store}|${d.title}|${d.sourceUrl}`)).map((d) => ({ store: d.store, title: d.title, why: resolver.why(d) }));
if (nones.length) {
  const reasons = nones.reduce((a, n) => ((a[n.why ?? "not looked at (an error)"] = (a[n.why ?? "not looked at (an error)"] ?? 0) + 1), a), {});
  console.log("\nNo image because:", JSON.stringify(reasons));
}
