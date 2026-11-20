// Token Factory (Nebius, OpenAI-compatible) chat calls with a JSON schema on the answer.
// Three roles, each with its own model. All three are plain instruct models: models that think before
// answering burn max_tokens on hidden reasoning and come back empty (gpt-oss-120b did, Qwen3.5-397B-A17B did).
const URL = "https://api.tokenfactory.nebius.com/v1/chat/completions";
const MAX_RETRIES = 2;

export const roles = {
  // Onboarding parser: a few sentences in, a few tag weights out. Small and fast.
  parser: { model: process.env.PARSER_MODEL || "Qwen/Qwen3-30B-A3B-Instruct-2507", timeoutMs: 20_000, maxTokens: 600 },
  // Ranker: reranks a shortlist of about 30 and writes a line for each pick. Mid-size.
  ranker: { model: process.env.RANKER_MODEL || "Qwen/Qwen3-235B-A22B-Instruct-2507", timeoutMs: 10_000, maxTokens: 1500 },
  // Profile updater: runs in the background, so it can be the biggest and slowest.
  updater: { model: process.env.UPDATER_MODEL || "NousResearch/Hermes-4-405B", timeoutMs: 90_000, maxTokens: 1500 },
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Returns the parsed JSON answer. Throws with the reason when the call fails, times out or is cut off,
// and the caller decides what to fall back to. `schema` is the plain JSON schema of the answer.
export async function chatJson(role, schemaName, schema, messages) {
  const { model, timeoutMs, maxTokens } = roles[role];
  if (!process.env.NEBIUS_API_KEY) throw new Error("NEBIUS_API_KEY is not set");
  const body = JSON.stringify({
    model,
    messages,
    // The docs show the schema directly under json_schema, which returns a 422. It needs name, strict and schema.
    response_format: { type: "json_schema", json_schema: { name: schemaName, strict: true, schema } },
    temperature: 0,
    max_tokens: maxTokens,
  });
  const signal = AbortSignal.timeout(timeoutMs);
  const started = Date.now();

  for (let attempt = 0; ; attempt++) {
    const res = await fetch(URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.NEBIUS_API_KEY}` },
      body,
      signal,
    });
    // 429 is the rate limit. 503 and 529 are "overloaded" and pass on their own.
    if ([429, 503, 529].includes(res.status) && attempt < MAX_RETRIES) {
      const waitSeconds = Number(res.headers.get("retry-after")) || 2 ** (attempt + 1);
      await sleep(Math.min(waitSeconds, 10) * 1000);
      continue;
    }
    if (!res.ok) throw new Error(`Token Factory returned ${res.status}: ${(await res.text()).slice(0, 200)}`);

    const data = await res.json();
    const { prompt_tokens, completion_tokens } = data.usage;
    console.log(`[llm] ${role} ${model} ${Date.now() - started}ms prompt=${prompt_tokens} completion=${completion_tokens}`);
    if (data.choices[0].finish_reason === "length") throw new Error("model output cut off at max_tokens");
    return JSON.parse(data.choices[0].message.content);
  }
}
