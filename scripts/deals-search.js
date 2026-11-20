// The deal search: Tavily finds pages, Token Factory turns page text into deal records, and every claim has to
// be backed by an exact quote that appears on the page.
//
//   npm run refresh -- --place "Charlotte, NC"                      search + find stores + import
//   node scripts/deals-search.js --config data/search.json --stream  what the app runs (batches are handed over as they are ready)
//   node scripts/deals-search.js --place "Charlotte, NC" --cached    skip Tavily, reuse scripts/output/pages.json
//
// Steps: plan (Token Factory writes a few queries from what the person wants), search (Tavily, per store), extract
// (Tavily), structure (Token Factory, one call per page slice), verify (literal quote matching, plus a price recheck
// on listing pages), filter and dedupe. Output: scripts/output/deals.json and trace.json.
//
// Verification rules, all in checkDeal:
// - A claim counts only if its quote appears word for word in the page text around the deal's title (the whole page
//   on a single-product page). "..." splits a quote into pieces and every piece must match.
// - A price must appear in its quote, a percent must appear in its quote. A claim that fails is nulled, never kept.
// - A deal type comes from cue words in the verified quote ("in store only", "online only", "doorbuster"), not from the model.
// - An end date counts only if the quote contains that calendar date. Without one the deal ships with no dates.
// - A deal stays only with a verified offer: a sale price, a stated percent off, or a stated dollars off.

import { writeFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { cleanPlace, lookupPlaces } from "../app/place.js";
import { saleDates, toIso } from "../app/public/windows.js";
import { DEFAULT_STORES, STORE_OPTIONS, makeStore, matchStore, resolveStore, storeForUrl } from "../app/store-list.js";
import { acceptableImageUrl } from "../app/image-rules.js";
import { categories } from "../app/tags.js";
import { createImageResolver, mapLimit } from "./images.js";

const { TAVILY_API_KEY, NEBIUS_API_KEY } = process.env;
const MODEL = process.env.STRUCTURE_MODEL ?? "Qwen/Qwen3-235B-A22B-Instruct-2507";
const TOKEN_FACTORY_URL = "https://api.tokenfactory.nebius.com/v1/chat/completions";

const RESULTS_PER_QUERY = 8;
const UNEXTRACTABLE_DOMAINS = ["facebook.com", "instagram.com", "tiktok.com", "reddit.com", "yelp.com", "youtube.com", "x.com", "pinterest.com"];
const MAX_URLS = 130;            // pages read per search; the rest are logged as skipped
const MAX_SUGGESTED = 6;         // other chains the planner may propose
const MAX_URLS_PER_SUGGESTED = 8; // pages read for any one suggested store, which keeps discovery cheap
const EXTRACT_BATCH_SIZE = 20;   // Tavily Extract maximum
const MIN_PAGE_CHARS = 300;      // shorter than this is a JS shell or an error page
const MAX_PAGE_CHARS = 25000;    // keeps each structuring call well under the token limit
const MAX_DEALS_PER_CHUNK = 12;  // per model call, so the JSON reply fits in max_tokens
const MAX_CHUNKS_PER_PAGE = 3;   // a page longer than MAX_PAGE_CHARS is read in slices, up to this many
const DEALS_TO_WRITE = 400;

// Quotes are only valid inside the "evidence": the page text around the deal's title.
const EVIDENCE_CHARS_BEFORE_TITLE = 500;
const EVIDENCE_CHARS_AFTER_TITLE = 1000;
const EVIDENCE_MAX_TITLE_MATCHES = 3;
const SINGLE_PAGE_EVIDENCE_CHARS = 8000; // on a single-product page the page itself is the evidence
const TITLE_ANCHOR_CHARS = [40, 30, 20]; // titles are matched by their start, since the model may tidy the rest
const MIN_QUOTE_PIECE_CHARS = 3;
const SAME_DEAL_OVERLAP = 0.7;           // share of the shorter title's words that must match

const PAGE_CONCURRENCY = 12;
const EXTRACT_CONCURRENCY = 3;
const MAX_RETRIES = 5;
const limits = { requestsPerMinute: 60, tokensPerMinute: 400_000 };
const USE_OF_LIMIT = 0.85;

// Streaming (the app passes --stream): deals are handed over in batches while the search is still running.
const STREAM = process.argv.includes("--stream");
const FIRST_BATCH_DEALS = 6;
const FIRST_BATCH_MAX_SECONDS = 60;
const BATCH_DEALS = 15;

const OUTPUT_DIR = new URL("./output/", import.meta.url);
const BATCH_DIR = new URL("./output/batches/", import.meta.url);
const DEFAULT_CONFIG = new URL("../data/search.json", import.meta.url);

let config;      // { place, radiusMiles, stores: [resolved store], wants, interests }
const stats = { searches: 0, extractRequests: 0, tokenFactoryRequests: 0, rateLimitRetries: 0, promptTokens: 0, completionTokens: 0, steps: {} };
const trace = {
  phase: "start", startedAt: null, finishedAt: null, place: null, models: {},
  plan: { wants: "", usedModel: false, queries: [] },
  stores: [], dropped: {}, extract: null, structure: { pages: 0, done: 0, pageTypes: {} }, batches: [], requests: null,
};
function emitTrace(phase) {
  trace.phase = phase;
  trace.requests = { tavily: { searches: stats.searches, extracts: stats.extractRequests }, tokenFactory: stats.tokenFactoryRequests, tokens: { prompt: stats.promptTokens, completion: stats.completionTokens }, steps: stats.steps };
  console.log(`::trace ${JSON.stringify(trace)}`);
}
const storeTrace = (name) => trace.stores.find((s) => s.name === name);
const countDrop = (reason) => { trace.dropped[reason] = (trace.dropped[reason] ?? 0) + 1; };
let plannedQueries = new Set(); // queries Token Factory wrote from what the person wants: their pages are read first

main().catch((err) => {
  console.error(`\nFAILED: ${err.message}`);
  process.exit(1);
});

async function main() {
  if (!TAVILY_API_KEY || !NEBIUS_API_KEY) {
    throw new Error("TAVILY_API_KEY and NEBIUS_API_KEY must be set (copy .env.example to .env)");
  }
  await mkdir(OUTPUT_DIR, { recursive: true });

  config = await loadConfig(process.argv.slice(2));
  const { blackFriday, cyberMonday } = saleDates();
  const sale = { year: blackFriday.getFullYear(), blackFriday: toIso(blackFriday), cyberMonday: toIso(cyberMonday) };
  console.log(`Place: ${config.place.name}. Stores: ${config.stores.map((s) => s.name).join(", ")}. Black Friday ${sale.blackFriday}, Cyber Monday ${sale.cyberMonday}.`);
  trace.startedAt = new Date().toISOString();
  trace.place = config.place;
  trace.models = { planner: MODEL, structure: MODEL, recheck: MODEL };
  config.suggested = await planSuggestedStores();
  config.planStores = [...config.stores, ...config.suggested];
  trace.stores = config.planStores.map((s) => ({ name: s.name, queries: [], pages: 0, failed: 0, deals: 0, ...(s.suggested ? { suggested: true, reason: s.reason } : {}) }));
  trace.suggested = config.suggested.map((s) => ({ name: s.name, domain: s.domains[0], reason: s.reason }));
  emitTrace("plan");

  const startedMs = Date.now();
  const queue = createQueue();
  const pages = [];
  const results = createResults(startedMs);
  if (STREAM) {
    await rm(BATCH_DIR, { recursive: true, force: true });
    await mkdir(BATCH_DIR, { recursive: true });
  }

  // Pages are read and structured as they arrive: while Tavily is still fetching later pages, Token Factory is
  // already working on the first ones.
  const produce = (async () => {
    if (process.argv.includes("--cached")) {
      const cached = JSON.parse(await readFile(new URL("pages.json", OUTPUT_DIR), "utf8"));
      console.log(`Using ${cached.length} cached pages from scripts/output/pages.json`);
      pages.push(...cached);
      for (const page of cached) if (page.store && storeTrace(page.store)) storeTrace(page.store).pages++;
      trace.structure.pages = cached.length;
      queue.push(...cached);
    } else {
      const urlInfo = new Map();
      await discover(sale, urlInfo);
      emitTrace("extract");
      await extractInto(urlInfo, (batch) => {
        pages.push(...batch);
        trace.structure.pages = pages.length;
        queue.push(...batch);
      });
      await writeFile(new URL("pages.json", OUTPUT_DIR), JSON.stringify(pages, null, 2));
    }
    queue.close();
  })();
  const workers = Array.from({ length: PAGE_CONCURRENCY }, async () => {
    for (let page = await queue.next(); page; page = await queue.next()) {
      let result;
      try {
        result = await structurePage(page, sale);
      } catch (err) {
        console.error(`Structure failed: ${page.url} (${err.message})`);
        result = { pageType: "failed", records: [] };
      }
      trace.structure.done++;
      results.add(result);
      if (trace.structure.done % 3 === 0) emitTrace("structure");
    }
  });
  await Promise.all([produce, ...workers]);

  const { kept, dropped } = results.finish();
  await resolveImages(kept);
  printSummary(pages, kept);
  const place = { ...config.place, radiusMiles: config.radiusMiles };
  const dropList = dropped.map((d) => ({ title: d.title, store: d.store, sourceUrl: d.sourceUrl, dropReason: d.dropReason }));
  await writeFile(new URL("deals.json", OUTPUT_DIR), JSON.stringify({ place, generatedAt: new Date().toISOString(), model: MODEL, stats, deals: kept, suggestions: suggestionList(), dropped: dropList }, null, 2));
  console.log("\nWrote scripts/output/deals.json");

  trace.finishedAt = new Date().toISOString();
  emitTrace("search-done");
  await writeFile(new URL("trace.json", OUTPUT_DIR), JSON.stringify(trace, null, 2));
}

// The planner's suggested stores, as the importer stores them.
const suggestionList = () => (config.suggested ?? []).map((s) => ({ slug: s.slug, name: s.name, domain: s.domains[0], reason: s.reason }));

// ---------- config ----------

// data/search.json (the app writes it) or flags: --place "City, ST", --stores "Best Buy,Under Armour".
async function loadConfig(argv) {
  const flag = (name) => {
    const i = argv.indexOf(name);
    return i === -1 ? null : argv[i + 1] ?? null;
  };
  let raw = {};
  const file = flag("--config");
  const placeText = flag("--place");
  if (file) {
    raw = JSON.parse(await readFile(file, "utf8"));
  } else if (!placeText) {
    try {
      raw = JSON.parse(await readFile(DEFAULT_CONFIG, "utf8"));
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
  }
  let place = cleanPlace(raw.place);
  if (placeText) {
    const [found] = await lookupPlaces(placeText, 1);
    if (!found) throw new Error(`Could not find a place called "${placeText}". Try "City, ST".`);
    place = found;
  }
  if (!place) throw new Error('No place to search. Pass --place "City, ST", or finish onboarding in the app (it writes data/search.json).');

  const names = (flag("--stores") ? flag("--stores").split(",") : Array.isArray(raw.stores) ? raw.stores : []).map((s) => String(s).trim()).filter(Boolean);
  const blocked = Array.isArray(raw.blockedStores) ? raw.blockedStores.filter((s) => typeof s === "string") : [];
  const stores = [...new Map((names.length ? names : DEFAULT_STORES).map((n) => resolveStore(n)).map((s) => [s.slug, s])).values()].filter((s) => !blocked.includes(s.slug));
  return {
    place,
    blocked,
    discover: raw.discover !== false && !argv.includes("--no-discover"),
    radiusMiles: Number.isFinite(raw.radiusMiles) ? raw.radiusMiles : 30,
    stores,
    wants: typeof raw.wants === "string" ? raw.wants.slice(0, 500) : "",
    interests: Array.isArray(raw.interests) ? raw.interests.filter((t) => typeof t === "string").slice(0, 12) : [],
  };
}

// ---------- Step 1: Plan and discover (Tavily Search) ----------

const plannerFormat = {
  type: "json_schema",
  json_schema: {
    name: "search_queries",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        queries: {
          type: "array",
          description: "At most 4 web search queries",
          items: { type: "object", additionalProperties: false, properties: { store: { type: "string" }, query: { type: "string" } }, required: ["store", "query"] },
        },
      },
      required: ["queries"],
    },
  },
};

// Turns what the person typed ("a TV and running shoes") into a few extra queries aimed at those products at their stores.
async function planQueries(sale) {
  trace.plan.wants = config.wants;
  if (!config.wants.trim()) return [];
  try {
    const reply = await chatJson("plan", plannerFormat, 500, [
      { role: "system", content: `You write web search queries that find specific Black Friday ${sale.year} deal pages for one person.
- Every query names one store from the list (copy its name exactly) and the product or category the person wants, plus "Black Friday ${sale.year}" and a word deal pages use ("deal", "price", "doorbuster", "sale").
- Cover different things the person asked for; do not repeat the same idea. At most 4 queries. Skip anything the stores do not sell.` },
      { role: "user", content: JSON.stringify({ stores: config.stores.map((s) => s.name), lookingFor: config.wants, likes: config.interests }) },
    ]);
    const known = new Map(config.stores.map((s) => [s.name, s]));
    const queries = JSON.parse(reply).queries
      .map(({ store, query }) => ({ store: known.get(store)?.name ?? matchStore(store, config.stores.map((s) => s.name))?.name, query: query.trim() }))
      .filter((q) => q.store && q.query)
      .slice(0, 4);
    trace.plan.usedModel = true;
    return queries;
  } catch (err) {
    console.error(`[query planner failed] ${err.message}. Using the standard queries only.`);
    return [];
  }
}

// ---------- Store discovery ----------

const HOSTNAME = /^(?=.{4,80}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/;
// Sites that are not a chain's own: deal aggregators, social networks, search engines.
const NOT_A_CHAIN = /(?:^|\.)(?:slickdeals|dealnews|retailmenot|bfads|blackfriday|brads?deals|gottadeal|couponfollow|facebook|instagram|tiktok|youtube|reddit|pinterest|twitter|x|google|bing|yahoo|wikipedia|yelp|ebay|aliexpress|temu|shein|wish)\.(?:com|net|org|co|us)$/i;

const suggestFormat = {
  type: "json_schema",
  json_schema: {
    name: "suggested_stores",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        stores: {
          type: "array",
          description: `At most ${MAX_SUGGESTED} other retail chains`,
          items: {
            type: "object", additionalProperties: false,
            properties: { name: { type: "string" }, domain: { type: "string", description: "The chain's own website, like target.com" }, reason: { type: "string" } },
            required: ["name", "domain", "reason"],
          },
        },
      },
      required: ["stores"],
    },
  },
};

// Besides the stores the person picked, proposes other real chains that run Black Friday deals they would plausibly like.
// The answer is checked here, not trusted: names and hostnames must look right, the person's and blocked stores are
// left out, and a chain with no deals found simply produces nothing.
async function planSuggestedStores() {
  if (!config.discover) return [];
  const taken = new Set([...config.stores.map((s) => s.slug), ...config.blocked]);
  let proposed = [];
  try {
    const reply = await chatJson("discover", suggestFormat, 900, [
      { role: "system", content: `You suggest other retail chains for a Black Friday ${new Date().getFullYear()} deal swipe app. Given the shopper's stores, what they want and their interests, propose up to ${MAX_SUGGESTED} OTHER real, well-known chains that sell what they would plausibly like and that publish Black Friday deals (in store, online, or both) in the United States.
- Never repeat a store the shopper already has or one they blocked. No marketplaces of random sellers, coupon or deal-aggregator sites, or brands that only sell through other retailers.
- domain is the chain's own website, such as target.com (no protocol, no path).
- reason is one short line, at most 90 characters, saying how the chain relates to their stores or wants, such as "Similar to Best Buy: big electronics and appliance sales". Make no claim about this year's deals, prices or stock.` },
      { role: "user", content: JSON.stringify({ shopperStores: config.stores.map((s) => s.name), blockedStores: config.blocked, lookingFor: config.wants || null, likes: config.interests, place: config.place.name }) },
    ]);
    proposed = JSON.parse(reply).stores;
  } catch (err) {
    console.error(`[store discovery failed] ${err.message}. Using a short fixed list.`);
  }
  const out = [];
  const take = (name, domainText, reason) => {
    const domain = String(domainText ?? "").toLowerCase().trim().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/[/?#].*$/, "");
    const clean = String(name ?? "").replace(/\s+/g, " ").trim();
    if (!clean || clean.length > 40 || !HOSTNAME.test(domain) || NOT_A_CHAIN.test(domain)) return;
    const store = makeStore(clean, domain);
    if (!store.slug || taken.has(store.slug) || out.some((s) => s.slug === store.slug)) return;
    out.push({ ...store, reason: String(reason ?? "").replace(/\s+/g, " ").trim().slice(0, 120) || null, suggested: true });
  };
  for (const p of proposed) if (out.length < MAX_SUGGESTED) take(p.name, p.domain, p.reason);
  if (out.length === 0) {
    // The model gave nothing usable: fall back to well-known chains the app already knows, honestly labeled.
    for (const o of STORE_OPTIONS) if (out.length < 3) take(o.name, o.domains[0], "A popular Black Friday retailer");
  }
  console.log(`Discovery: ${out.length ? out.map((s) => s.name).join(", ") : "no other stores"}`);
  return out;
}

// Fills urlInfo: url -> { queries, stores } for every page worth reading.
async function discover(sale, urlInfo) {
  const planned = await planQueries(sale);
  plannedQueries = new Set(planned.map((p) => p.query));
  const specs = [];
  for (const store of config.stores) {
    if (store.domains.length) specs.push({ store, kind: "site", query: `${store.name} Black Friday ${sale.year} doorbusters deals`, domain: store.domains[0] });
    specs.push({ store, kind: "open", query: `${store.name} Black Friday ${sale.year} ad doorbusters in-store deals` });
    specs.push({ store, kind: "open", query: `${store.name} Cyber Monday ${sale.year} online deals` });
  }
  for (const { store, query } of planned) specs.push({ store: config.stores.find((s) => s.name === store), kind: "planned", query });
  // Suggested stores get a lighter plan: one search on their own site and one open search for their ad.
  for (const store of config.suggested) {
    specs.push({ store, kind: "site", query: `${store.name} Black Friday ${sale.year} deals`, domain: store.domains[0] });
    specs.push({ store, kind: "open", query: `${store.name} Black Friday ${sale.year} ad doorbusters` });
  }
  for (const spec of specs) storeTrace(spec.store.name).queries.push(spec.query);
  trace.plan.queries = specs.map(({ store, query, kind, domain }) => ({ store: store.name, query, kind, domain }));

  const suggestedUrls = {};
  const searches = await Promise.allSettled(
    specs.map((spec) =>
      tavily("search", {
        query: spec.query,
        max_results: RESULTS_PER_QUERY,
        search_depth: "basic",
        ...(spec.domain ? { include_domains: [spec.domain] } : { exclude_domains: UNEXTRACTABLE_DOMAINS, time_range: "month" }),
      }),
    ),
  );
  searches.forEach((result, i) => {
    stats.searches++;
    if (result.status === "rejected") {
      console.error(`Search failed for "${specs[i].query}": ${result.reason.message}`);
      return;
    }
    for (const { url } of result.value.results) {
      if (/%7B|\$\{|\{\{/i.test(url)) continue; // an unfilled template address, not a page
      const key = url.split("#")[0];
      // A page on a chain's own site is that chain's page; anything else belongs to the store whose query found it.
      const owner = storeForUrl(key, config.planStores) ?? specs[i].store;
      if (owner.suggested) {
        const mine = (suggestedUrls[owner.name] ??= new Set());
        if (!mine.has(key) && mine.size >= MAX_URLS_PER_SUGGESTED) continue;
        mine.add(key);
      }
      const info = urlInfo.get(key) ?? { queries: [], stores: new Set() };
      info.queries.push(specs[i].query);
      info.stores.add(owner.name);
      urlInfo.set(key, info);
    }
  });
  console.log(`Discover: ${specs.length} queries found ${urlInfo.size} unique URLs`);
}

// ---------- Step 2: Extract (Tavily Extract) ----------

// Returns [{ url, text, images, foundBy, store }]. Failed URLs are logged and dropped.
async function extractInto(urlInfo, onBatch) {
  // First what the person asked for, then the chains' own pages, then everything else.
  const priority = (url) => {
    const { queries } = urlInfo.get(url);
    if (queries.some((q) => plannedQueries.has(q))) return 0;
    const own = storeForUrl(url, config.planStores);
    return own ? (own.suggested ? 2 : 1) : 3;
  };
  const all = [...urlInfo.keys()].sort((a, b) => priority(a) - priority(b));
  const urls = all.slice(0, MAX_URLS);
  if (all.length > urls.length) console.log(`Extract: reading the first ${urls.length} of ${all.length} URLs; ${all.length - urls.length} lower-priority ones skipped`);
  const batches = [];
  for (let i = 0; i < urls.length; i += EXTRACT_BATCH_SIZE) batches.push(urls.slice(i, i + EXTRACT_BATCH_SIZE));

  const storeOf = (url) => [...(urlInfo.get(url)?.stores ?? [])][0];
  let usable = 0;
  let next = 0;
  const worker = async () => {
    while (next < batches.length) {
      const batch = batches[next++];
      stats.extractRequests++;
      let res;
      try {
        res = await tavily("extract", { urls: batch, include_images: true, format: "text", timeout: 30 });
      } catch (err) {
        console.error(`Extract request failed for ${batch.length} URLs: ${err.message}`);
        for (const url of batch) for (const name of urlInfo.get(url).stores) storeTrace(name).failed++;
        continue;
      }
      for (const f of res.failed_results) {
        console.error(`Extract failed: ${f.url} (${f.error})`);
        for (const name of urlInfo.get(f.url)?.stores ?? []) storeTrace(name).failed++;
      }
      const pages = [];
      for (const page of res.results) {
        const info = urlInfo.get(page.url) ?? urlInfo.get(page.url.split("#")[0]);
        if (page.raw_content.length < MIN_PAGE_CHARS) {
          console.error(`Extract too short (${page.raw_content.length} chars): ${page.url}`);
          for (const name of info?.stores ?? []) storeTrace(name).failed++;
          continue;
        }
        for (const name of info?.stores ?? []) storeTrace(name).pages++;
        pages.push({ url: page.url, text: page.raw_content, images: page.images ?? [], foundBy: info?.queries ?? [], store: storeOf(page.url) ?? null });
      }
      usable += pages.length;
      trace.extract = { requested: urls.length, usable, failed: null };
      onBatch(pages);
    }
  };
  await Promise.all(Array.from({ length: EXTRACT_CONCURRENCY }, worker));
  trace.extract = { requested: urls.length, usable, failed: urls.length - usable };
  console.log(`Extract: ${usable} of ${urls.length} URLs gave usable page text`);
}

// ---------- Step 3: Structure (Token Factory) ----------

const PAGE_TYPES = ["single_product", "deal_listing", "store_ad", "sitewide_promo", "article_or_guide", "other"];
const KINDS = ["product_deal", "category_deal", "sitewide_promo", "not_a_deal"];
const nullableNumber = { type: ["number", "null"] };
const nullableString = { type: ["string", "null"] };
const quoteField = { type: "string", description: "Exact text copied from the page that supports this. Empty string if none." };

const dealSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string", description: "The product or offer name, copied from the page" },
    store: { type: "string", description: "The retailer selling it" },
    kind: { type: "string", enum: KINDS },
    category: { type: "string", enum: categories },
    sale_price: { ...nullableNumber, description: "The current discounted price in dollars" },
    sale_price_quote: quoteField,
    original_price: { ...nullableNumber, description: "The regular or was price in dollars" },
    original_price_quote: quoteField,
    percent_off: { ...nullableNumber, description: "Only a percent the page states" },
    discount_quote: quoteField,
    deal_type: { type: "string", enum: ["doorbuster", "online", "both", "unknown"] },
    deal_type_quote: quoteField,
    inferred_type: { type: "string", enum: ["doorbuster", "online", "both", "unknown"], description: "A labeled guess, separate from deal_type" },
    inferred_reason: { type: "string", description: "At most 80 characters: the basis for the guess" },
    valid_from: nullableString,
    valid_to: nullableString,
    dates_quote: quoteField,
    window_quote: quoteField,
    promo_code: nullableString,
    code_quote: quoteField,
    image_url: nullableString,
  },
  required: ["title", "store", "kind", "category", "sale_price", "sale_price_quote", "original_price", "original_price_quote", "percent_off", "discount_quote",
    "deal_type", "deal_type_quote", "inferred_type", "inferred_reason", "valid_from", "valid_to", "dates_quote", "window_quote", "promo_code", "code_quote", "image_url"],
};

const structureFormat = {
  type: "json_schema",
  json_schema: {
    name: "deals_on_page",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      properties: { page_type: { type: "string", enum: PAGE_TYPES }, deals: { type: "array", items: dealSchema } },
      required: ["page_type", "deals"],
    },
  },
};

function buildSystemPrompt(sale) {
  const stores = config.planStores.map((s) => s.name).join(", ");
  return `You extract Black Friday ${sale.year} deals from web page text. The shopper is in ${config.place.name}. Today is ${today()}. The page text was fetched today. The sale runs through Cyber Monday (${sale.cyberMonday}).

First set page_type:
- single_product: the page is about one product or one offer.
- deal_listing: a list of many products, each with its own price.
- store_ad: a store's Black Friday ad or doorbuster list.
- sitewide_promo: a store-wide or category-wide promotion (for example "up to 50% off everything").
- article_or_guide: a blog post or roundup. other: anything else.

Rules:
- Only deals from these stores: ${stores}. Use the store's name exactly as listed. Skip deals from other stores, even when the page lists them. Return at most ${MAX_DEALS_PER_CHUNK}, preferring the best-documented ones (a price and a clear end or type). Return an empty list if the page has none.
- kind is product_deal for one product, category_deal for a discount on a category ("40% off all headphones"), sitewide_promo for a store-wide offer, and not_a_deal for gift cards, credit-card or rewards offers, store hours or closing notices, and generic "Black Friday hub" headings that offer nothing specific.
- title is the product or offer name copied from the page, short, at most 90 characters, without the price or discount words that follow it. Keep the brand and the full model name, number, generation and size exactly as the page gives them ("Sony WH-1000XM5 Headphones", "Samsung 65-inch QN90F TV"), never a shortened "Sony headphones" when the page names the model. Never invent a title.
- Skip any deal the page describes as over, expired, "last year" or from an earlier year's sale. Only this year's sale counts.
- category is what the product itself is (tv, laptop, audio, gaming, phone, appliance, apparel, shoes, fitness, home, toys, tools, beauty). Use closeout only for a surplus or overstock item that fits none of those.
- Never guess. Use null for anything the page does not say. sale_price is the current discounted price. original_price is the regular, was or list price. Do not do arithmetic. percent_off only if the page states a percent. If a price belongs to a different product than this deal, do not use it.
- deal_type: "doorbuster" when the page says this deal is in store (in-store only, doorbuster, in-store pickup is NOT enough), "online" when it is online only, "both" when the page says it is available in store and online, "unknown" otherwise. Do not infer it from the store or the kind of product. deal_type_quote is the exact page text that says it.
- inferred_type is your best guess at where this deal is sold. It is kept apart from deal_type: never copy it into deal_type, which stays "unknown" unless a page quote says it. Base the guess on the page text around the deal and on the "Page source" line:
  - "online": a retailer's own product or promo page that shows a price or code and says nothing about stores; a store-wide percent-off promo or promo code; a direct-to-consumer brand's sale (for example Under Armour).
  - "doorbuster": the text mentions doorbusters, in-store only, limited quantities, "while supplies last", early-morning or limited hours; or the retailer is mainly a physical closeout or outlet chain whose deals appear in a weekly ad or flyer (for example Ollie's).
  - "both": the text says it is available online and in store; or a national chain that sells both ways (for example Best Buy or Target) with a price listed and no limit stated.
  - "unknown": only when the text gives no basis at all. Prefer a guess over "unknown" whenever there is some basis.
  inferred_reason is at most 80 characters, plain words, naming the basis (for example "Retailer's own page, price shown, no store limit").
- Skip offers for another season or holiday: Halloween, costumes, Americana, Fourth of July, Memorial Day, Labor Day, Easter, Valentine's Day, back to school, Mother's and Father's Day. Skip anything that is not a specific product or discount offer (a headline, a how-to, a ranking).
- valid_from and valid_to (YYYY-MM-DD) only if the page states them for this deal, as a calendar date. A weekday or "Black Friday" alone is not a date: use null. Pages often omit the year: use ${sale.year}. dates_quote contains the exact calendar date text.
- window_quote is the exact page text giving the days or hours this deal is on (for example "Fri 5am-11am" or "Thursday 6pm"), "" if none.
- promo_code only if the page gives a code to type in; code_quote contains it.
- Every *_quote must be exact text copied from the page, at most 200 characters, no paraphrase and no rewriting. If the support is in two places, join at most two exact pieces with " ... ". sale_price_quote must contain the sale price as written (for example "$199.99"). discount_quote must contain the percent or dollars-off as written ("40% off", "Save $200"), and may repeat the sale price text.
- image_url must be copied from the candidate image list, and only if the image shows this product. Otherwise null.`;
}

// ---------- verification ----------

const norm = (s) => String(s)
  .replace(/[‘’‛]/g, "'").replace(/[“”]/g, '"').replace(/[–—−]/g, "-").replace(/ /g, " ")
  .replace(/\s+/g, " ").trim().toLowerCase();

// A quote may join pieces of the page with "...". Every piece must appear word for word in the text.
function quoteInText(quote, text) {
  const pieces = String(quote ?? "").split(/\.{3}|…/).map(norm).filter((p) => p.length >= MIN_QUOTE_PIECE_CHARS);
  return pieces.length > 0 && pieces.every((p) => text.includes(p));
}

function findAll(text, needle, max) {
  const found = [];
  if (!needle) return found;
  for (let at = text.indexOf(needle); at !== -1 && found.length < max; at = text.indexOf(needle, at + 1)) found.push(at);
  return found;
}

// The page text a quote may come from. On a single-product page that is the page itself. Anywhere else it is only
// the stretches around the deal's title, so a quote cannot be borrowed from another product.
function evidenceFor(title, pageType, flat) {
  if (pageType === "single_product") return flat.slice(0, SINGLE_PAGE_EVIDENCE_CHARS);
  const lowerTitle = norm(title);
  let starts = [];
  for (const chars of TITLE_ANCHOR_CHARS) {
    starts = findAll(flat, lowerTitle.slice(0, chars), EVIDENCE_MAX_TITLE_MATCHES);
    if (starts.length > 0) break;
  }
  const windows = [];
  for (const at of starts) {
    const from = Math.max(0, at - EVIDENCE_CHARS_BEFORE_TITLE);
    const to = at + EVIDENCE_CHARS_AFTER_TITLE;
    const last = windows.at(-1);
    if (last && from <= last.to) last.to = to;
    else windows.push({ from, to });
  }
  return windows.map((w) => flat.slice(w.from, w.to)).join(" [...] ");
}

// Dollar amounts and percents as written in a quote.
const PRICE = /\$\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?/g;
const pricesIn = (text) => [...norm(text).matchAll(PRICE)].map((m) => Number(`${m[1].replace(/,/g, "")}.${m[2] ?? "0"}`));
const percentsIn = (text) => [...norm(text).matchAll(/(\d+(?:\.\d+)?)\s*%/g)].map((m) => Number(m[1]));
const close = (a, b) => Math.abs(a - b) < 0.011;
const DOLLARS_OFF = /\$\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\s*(?:off|savings?)\b|\bsave\s+(?:up to\s+)?\$\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?/;

// Where the deal is sold, read from the words of its quote. "Pick up in store" is not a type: it is a way to get an online order.
function typeFromQuote(quote) {
  const t = norm(quote).replace(/\b(?:free )?(?:in[\s-]?store|store) pick[\s-]?up\b|\bpick[\s-]?up in[\s-]?store\b|\bpickup\b/g, " ");
  const onlineOnly = /\b(?:online|web)[\s-]?(?:only|exclusive)\b|\bonly online\b/.test(t);
  const storeOnly = /\bin[\s-]?stores?\s+(?:only|exclusive)\b|\bonly in[\s-]?stores?\b|\bstores? only\b/.test(t);
  if (onlineOnly && !storeOnly) return "online";
  if (storeOnly && !onlineOnly) return "doorbuster";
  // The word "doorbuster" counts only as a short label ("Doorbuster!") next to the deal, not inside a sentence about a whole sale.
  const inStore = /\b(?:in[\s-]?stores?|in[\s-]?person)\b/.test(t) || (/\bdoorbusters?\b/.test(t) && t.length <= 60);
  const online = /\bonline\b/.test(t);
  if (inStore && online) return "both";
  return inStore ? "doorbuster" : online ? "online" : null;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH_NAME = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const MONTH_FIRST_DATE = new RegExp(`\\b${MONTH_NAME}\\.?\\s*(\\d{1,2})(?:st|nd|rd|th)?(?:\\s*(?:-|to)\\s*(\\d{1,2}))?\\b(?:,?\\s*(20\\d\\d))?`, "g");
const NUMERIC_DATE = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{4}|\d{2}))?\b/g;
const ISO_DATE = /\b(\d{4})-(\d{2})-(\d{2})\b/g;

// True if the quote contains a calendar date (month and day) matching `iso`. A weekday alone does not count. A year in the quote must match too.
function quoteShowsDate(quote, iso) {
  const [year, month, day] = iso.split("-").map(Number);
  const text = norm(quote);
  const dates = [];
  for (const m of text.matchAll(MONTH_FIRST_DATE)) dates.push({ month: MONTHS.indexOf(m[1].slice(0, 3)) + 1, from: Number(m[2]), to: Number(m[3] ?? m[2]), year: m[4] ? Number(m[4]) : null });
  for (const m of text.matchAll(NUMERIC_DATE)) {
    const y = m[3] ? Number(m[3]) : null;
    dates.push({ month: Number(m[1]), from: Number(m[2]), to: Number(m[2]), year: y && y < 100 ? 2000 + y : y });
  }
  for (const m of text.matchAll(ISO_DATE)) dates.push({ month: Number(m[2]), from: Number(m[3]), to: Number(m[3]), year: Number(m[1]) });
  return dates.some((d) => d.month === month && d.from <= day && day <= d.to && (d.year === null || d.year === year));
}

const validIso = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s ?? "") && !Number.isNaN(Date.parse(s));
const TIME_OF_DAY = /(?:\d\s*(?:a\.?m\.?|p\.?m\.?)\b|\b\d{1,2}:\d{2}\b|\bnoon\b|\bmidnight\b|\ball[\s-]?day\b)/i;

// Offers for another season, and headlines that are not an offer. Checked on the title and the offer quotes only,
// so a roundup that mentions Halloween elsewhere does not sink its other deals.
const OUT_OF_SEASON = /\b(halloween|costumes?|americana|fourth of july|4th of july|july 4(?:th)?|independence day|memorial day|labor day|easter|valentine'?s?|back[\s-]to[\s-]school|st\.? patrick'?s?|mother'?s day|father'?s day|spring break|summer)\b/i;
const HEADLINE = /^(?:top \d+|best (?:of|deals?|black|early|cyber)|how (?:to|we|i)\b|why\b|what (?:to|is|are)\b|when\b|where\b|\d+ (?:best|top|things|ways)\b)|\?$/i;

// What the product is, from its name. The model's guess is only used when the name says nothing, and "closeout"
// stays only for stores that sell closeouts.
const CATEGORY_RULES = [
  ["shoes", /\b(shoes?|sneakers?|cleats?|boots?|slides|sandals?|trainers?)\b/],
  ["tv", /\b(tvs?|oled|qled|televisions?)\b/],
  ["laptop", /\b(laptops?|macbook|chromebook|notebook|omnibook|thinkpad|surface pro)\b/],
  ["audio", /\b(headphones?|earbuds?|airpods|soundbar|speakers?|beats|bose|sonos)\b/],
  ["gaming", /\b(playstation|ps5|xbox|nintendo|switch|gaming|controller|steam deck|video games?)\b/],
  ["phone", /\b(iphone|galaxy|pixel|ipad|tablet|smartphone|apple watch|smartwatch)\b/],
  ["appliance", /\b(refrigerator|fridge|washer|dryer|dishwasher|vacuum|air fryer|microwave|blender|keurig|espresso|coffee maker|oven|range|stove|instant pot|dehumidifier)\b/],
  ["tools", /\b(drill|tool set|generator|saw|wrench|socket|toolbox)\b/],
  ["toys", /\b(lego|toys?|dolls?|puzzles?|plush|kinetic sand|nerf|barbie|play-?doh)\b/],
  ["fitness", /\b(dumbbells?|kettlebell|treadmill|yoga|fitness|weights?|resistance bands?|water bottle|gym bag|backpack|duffel|football|basketball|baseball|soccer)\b/],
  ["apparel", /\b(shirts?|tees?|t-shirts?|hoodies?|sweatshirts?|jackets?|pants|shorts|leggings|fleece|polo|joggers?|vests?|jerseys?|socks?|bras?|tanks?|pullovers?|sweaters?|coats?|apparel|clothing|hats?|beanies?|gloves)\b/],
  ["beauty", /\b(makeup|skincare|perfume|cologne|shampoo|lotion|fragrance)\b/],
  ["home", /\b(blankets?|decor|candles?|bedding|sheets|towels?|rugs?|furniture|kitchen|cookware|storage|christmas|holiday)\b/],
];

function categoryFor(title, modelCategory, storeSlug) {
  const name = norm(title);
  const rule = CATEGORY_RULES.find(([, pattern]) => pattern.test(name));
  if (rule) return rule[0];
  if (modelCategory === "closeout" && storeSlug !== "ollies") return "other";
  return categories.includes(modelCategory) ? modelCategory : "other";
}

// "TCL QM8L QLED (65-Inch): Save $1,502 (60% Off)" is a product name followed by its price. Keep the name.
function tidyTitle(title) {
  const tidy = title.replace(/^\$\d[\d,.]*\s+/, "").replace(/\s*(?::|\s[-–])\s*(?:save|only|from|\$\d|\d+% off).*$/i, "").trim();
  return tidy.length >= 8 ? tidy : title;
}

const recheckFormat = {
  type: "json_schema",
  json_schema: {
    name: "offer_recheck",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      properties: { belongs: { type: "boolean" }, quote: { type: "string", description: "Exact text from the page that shows the price or percent next to this product's name" } },
      required: ["belongs", "quote"],
    },
  },
};

// On a listing, a price can sit next to a neighbor's title. A second, small call sees only the text around this deal
// and says whether the offer belongs to it, with a quote.
async function offerBelongs(deal, evidence) {
  const shown = evidence.slice(0, 2500);
  const reply = await chatJson("recheck", recheckFormat, 300, [
    { role: "system", content: `You check one extracted deal against the page text around it. Answer belongs=true only if the price or discount below is attached to THIS product's own name and not to a neighboring product. Give the exact text that shows it. If you cannot show it, belongs=false and quote is "".` },
    { role: "user", content: JSON.stringify({ product: deal.title, store: deal.store, salePrice: deal.sale_price, percentOff: deal.percent_off }) + `\n\nPage text:\n${shown}` },
  ]);
  const { belongs, quote } = JSON.parse(reply);
  if (!belongs || !quoteInText(quote, evidence)) return false;
  const amounts = pricesIn(quote);
  const percents = percentsIn(quote);
  return (deal.sale_price !== null && amounts.some((a) => close(a, deal.sale_price))) || (deal.percent_off !== null && percents.some((p) => Math.abs(p - deal.percent_off) < 0.5));
}

// Turns one model deal into a record, or a record with a dropReason.
async function checkDeal(d, pageType, page, flat, images, season) {
  const title = d.title.replace(/\s+/g, " ").trim(); // the page's own words, used to find the deal on the page
  const drop = (dropReason, store = d.store) => {
    countDrop(dropReason);
    return { title, store, sourceUrl: page.url, dropReason };
  };
  if (d.kind === "not_a_deal") return drop("not a deal");
  if (OUT_OF_SEASON.test(`${title} ${d.discount_quote} ${d.sale_price_quote}`)) return drop("out of season");
  if (HEADLINE.test(title) || title.length > 110) return drop("not a specific offer");
  const store = storeForUrl(page.url, config.planStores) ?? matchStore(d.store, config.planStores);
  if (!store) return drop("store not in plan");

  const evidence = evidenceFor(title, pageType, flat);
  if (!evidence) return drop("title not on the page", store.name);
  // A page that never mentions this year, or that names an earlier year next to the deal, is last year's sale.
  const thisYear = String(season.year);
  if (!storeForUrl(page.url, config.planStores) && !flat.includes(thisYear)) return drop("page is not about this year's sale", store.name);
  const earlierYears = new RegExp(`\\b(?:${[1, 2, 3].map((n) => season.year - n).join("|")})\\b`);
  if (earlierYears.test(evidence) && !evidence.includes(thisYear)) return drop("from an earlier sale", store.name);
  const claim = (quote) => quoteInText(quote, evidence);

  // Offer: a sale price, a stated percent off, or a stated dollars off. Each needs its own quote.
  let sale = d.sale_price !== null && d.sale_price > 0 && claim(d.sale_price_quote) && pricesIn(d.sale_price_quote).some((p) => close(p, d.sale_price)) ? d.sale_price : null;
  let original = d.original_price !== null && claim(d.original_price_quote) && pricesIn(d.original_price_quote).some((p) => close(p, d.original_price)) ? d.original_price : null;
  if (original !== null && sale !== null && original <= sale) original = null;
  const percentClaim = d.percent_off !== null && claim(d.discount_quote) && percentsIn(d.discount_quote).some((p) => Math.abs(p - d.percent_off) < 0.5);
  let percent = percentClaim ? d.percent_off : null;
  const discountQuoteOk = claim(d.discount_quote);
  const dollarsMatch = discountQuoteOk ? norm(d.discount_quote).match(DOLLARS_OFF) : null;
  let dollarsOff = dollarsMatch ? Number(`${(dollarsMatch[1] ?? dollarsMatch[3]).replace(/,/g, "")}.${dollarsMatch[2] ?? dollarsMatch[4] ?? "0"}`) : null;
  const upTo = percentClaim && /\bup to\b/.test(norm(d.discount_quote));

  // A listing may have put a neighbor's price next to this title. Ask once more, with only the nearby text.
  if (pageType !== "single_product" && (sale !== null || percent !== null)) {
    let belongs = true;
    try {
      belongs = await offerBelongs({ title, store: store.name, sale_price: sale, percent_off: percent }, evidence);
    } catch (err) {
      console.error(`Recheck failed for "${title}": ${err.message}`);
      belongs = false;
    }
    if (!belongs) [sale, original, percent, dollarsOff] = [null, null, null, null];
  }

  if (sale === null && percent === null && dollarsOff === null) return drop(d.sale_price !== null || d.percent_off !== null ? "price did not check out" : "no verified offer", store.name);
  if (d.kind !== "sitewide_promo" && sale === null && /^(?:black friday|cyber monday|holiday)\b.*\b(?:deals?|sale|ad|event|savings?|hub)$/i.test(title)) return drop("generic page heading", store.name);

  if (original !== null && sale !== null && percent === null) percent = Math.round((1 - sale / original) * 100);
  const discountText = percent !== null && percentClaim
    ? `${upTo ? "Up to " : ""}${percent}% off`
    : dollarsOff !== null ? `$${dollarsOff} off` : null;

  // Where it is sold: from the words of a verified quote, never from the model's label alone.
  const typeQuote = d.deal_type !== "unknown" && claim(d.deal_type_quote) ? d.deal_type_quote.trim() : "";
  const dealType = typeQuote ? typeFromQuote(typeQuote) : null;

  // The model's labeled guess. It never fills dealType, and it is only kept where the page does not say.
  const guess = ["doorbuster", "online", "both"].includes(d.inferred_type) ? d.inferred_type : null;
  const reason = guess ? String(d.inferred_reason ?? "").replace(/\s+/g, " ").trim().slice(0, 80) : "";
  const inferredType = guess && reason && !dealType ? guess : null;

  // Dates: each counts only if the date appears in a verified quote. No date is fine.
  const datesOk = claim(d.dates_quote);
  const dateOf = (iso) => (datesOk && validIso(iso) && quoteShowsDate(d.dates_quote, iso) ? iso : null);
  let validFrom = dateOf(d.valid_from);
  let validTo = dateOf(d.valid_to);
  if (validFrom && validTo && validFrom > validTo) [validFrom, validTo] = [null, null];
  if (validTo && validTo < today()) return drop("already ended", store.name);

  const windowText = d.window_quote && claim(d.window_quote) && TIME_OF_DAY.test(d.window_quote) && d.window_quote.length <= 90 ? d.window_quote.replace(/\s+/g, " ").trim() : null;
  const code = d.promo_code && /^[A-Za-z0-9]{3,20}$/.test(d.promo_code) && claim(d.code_quote) && norm(d.code_quote).includes(d.promo_code.toLowerCase()) ? d.promo_code : null;
  // Only a retailer's own single-product page may supply the image here (an article's picture is its hero, not the product).
  // Every other deal gets its image from the image step, which checks that it is the same product.
  const image = pageType === "single_product" && storeForUrl(page.url, config.planStores) && d.image_url && images.includes(d.image_url) && acceptableImageUrl(d.image_url) ? d.image_url : null;

  const offerQuote = [sale !== null && d.sale_price_quote, discountText && d.discount_quote].filter(Boolean).join(" ... ").slice(0, 300);
  return {
    title: tidyTitle(title),
    store: store.name,
    storeSlug: store.slug,
    dealType,
    dealTypeQuote: dealType ? typeQuote : null,
    inferredType,
    inferredReason: inferredType ? reason : null,
    salePrice: sale,
    originalPrice: original,
    percentOff: upTo ? null : percent,
    discountText,
    priceVerified: true,
    validFrom,
    validTo,
    windowText,
    code,
    category: categoryFor(title, d.category, store.slug),
    sourceUrl: page.url,
    imageUrl: image,
    imageReliable: Boolean(image),
    imageSource: image ? "retailer-product-page" : null,
    imageCheckedAt: image ? new Date().toISOString() : null,
    claims: {
      price: { status: "verified", quote: offerQuote },
      type: { status: dealType ? "verified" : "unverified", quote: dealType ? typeQuote : "" },
      dates: { status: validTo || validFrom ? "verified" : "unverified", quote: validTo || validFrom ? d.dates_quote.trim() : "" },
    },
    fetchedAt: new Date().toISOString(),
    pageType,
  };
}

// Returns { pageType, records }. Records are every deal the model found, each either checked or carrying a dropReason.
async function structurePage(page, sale) {
  const images = page.images.slice(0, 15);
  const flat = norm(page.text);
  const system = buildSystemPrompt(sale);
  const starts = [];
  for (let from = 0; from < page.text.length && starts.length < MAX_CHUNKS_PER_PAGE; from += MAX_PAGE_CHARS) starts.push(from);

  const slices = await Promise.all(starts.map(async (from) => {
    const reply = await chatJson("structure", structureFormat, 8000, [
      { role: "system", content: system },
      { role: "user", content: `Page URL: ${page.url}\nPage source: ${storeForUrl(page.url, config.planStores) ? `the retailer's own website (${storeForUrl(page.url, config.planStores).name})` : "a third-party site (news, roundup, coupon or ad-aggregator page)"}\n\nCandidate images:\n${images.join("\n") || "(none)"}\n\nPage text:\n${page.text.slice(from, from + MAX_PAGE_CHARS)}` },
    ]);
    const parsed = JSON.parse(reply);
    const checked = await Promise.all(parsed.deals.map((d) => checkDeal(d, parsed.page_type, page, flat, images, sale)));
    return { pageType: parsed.page_type, records: checked };
  }));
  return { pageType: slices[0].pageType, records: slices.flatMap((slice) => slice.records) };
}

// ---------- Step 5: Images ----------

// Looks for a photo for every kept deal that has none (see scripts/images.js for the rules). Deals that gain one are handed
// over again as a last batch; the importer keeps whatever it already has and only adds the image. A re-run reads the cache.
async function resolveImages(kept) {
  const need = kept.filter((d) => !(d.imageUrl && d.imageReliable));
  trace.images = { total: kept.length, withImage: kept.length - need.length, resolving: need.length > 0, bySource: {}, credits: 0 };
  emitTrace("images");
  if (need.length === 0) return;
  console.log(`Images: ${need.length} of ${kept.length} deals need a photo`);
  const resolver = createImageResolver({
    tavily, chat: chatJson, visionModel: process.env.VISION_MODEL || undefined, storeFor: (name) => config.planStores.find((s) => s.name === name) ?? resolveStore(name), cacheFile: fileURLToPath(new URL("images-cache.json", OUTPUT_DIR)),
    retryNegatives: process.argv.includes("--retry-images"), log: (line) => console.error(line),
  });
  const gained = [];
  let done = 0;
  await mapLimit(need, 4, async (deal) => {
    const found = await resolver.resolve(deal);
    if (found) {
      Object.assign(deal, { imageUrl: found.url, imageSource: found.source, imageReliable: true, imageCheckedAt: found.checkedAt });
      gained.push(deal);
    }
    trace.images.withImage = kept.filter((d) => d.imageUrl && d.imageReliable).length;
    if (++done % 5 === 0) {
      resolver.save();
      emitTrace("images");
    }
  });
  resolver.save();
  const s = resolver.stats;
  stats.searches += s.searches;
  stats.extractRequests += s.extractPages;
  Object.assign(trace.images, {
    resolving: false,
    withImage: kept.filter((d) => d.imageUrl && d.imageReliable).length,
    bySource: kept.reduce((a, d) => (d.imageSource ? ((a[d.imageSource] = (a[d.imageSource] ?? 0) + 1), a) : a), {}),
    credits: s.searches + Math.ceil(s.extractPages / 5),
    hotlink: s.hotlink,
  });
  for (const t of trace.stores) t.images = kept.filter((d) => d.store === t.name && d.imageUrl && d.imageReliable).length;
  console.log(`Images: ${gained.length} found (${trace.images.withImage}/${kept.length} deals now have one), about ${trace.images.credits} Tavily credits`);
  if (STREAM && gained.length) {
    const file = new URL("batch-images.json", BATCH_DIR);
    writeFileSync(file, JSON.stringify({ place: { ...config.place, radiusMiles: config.radiusMiles }, generatedAt: new Date().toISOString(), model: MODEL, deals: gained, suggestions: suggestionList() }, null, 2));
    console.log(`::batch ${fileURLToPath(file)}`);
  }
  emitTrace("images");
}

// ---------- Step 4: Dedupe and hand over ----------

const FILLER = new Set(["the", "a", "an", "of", "at", "in", "for", "and", "with", "to", "off", "deal", "sale", "black", "friday"]);
const words = (s) => new Set((norm(s).match(/[a-z0-9]+/g) ?? []).filter((w) => !FILLER.has(w) && !/^20\d\d$/.test(w)));

function isSameDeal(a, b) {
  if (a.storeSlug !== b.storeSlug) return false;
  const [x, y] = [words(a.title), words(b.title)];
  const overlap = [...x].filter((w) => y.has(w)).length / Math.max(1, Math.min(x.size, y.size));
  const prices = a.salePrice === b.salePrice || a.salePrice === null || b.salePrice === null;
  return overlap >= SAME_DEAL_OVERLAP && Math.min(x.size, y.size) >= 2 && prices;
}

// A single-product page beats a listing; more verified facts beat fewer.
const qualityRank = (d) => (d.pageType === "single_product" ? 4 : 0) + (d.salePrice !== null ? 2 : 0) + (d.dealType ? 1 : 0) + (d.validTo ? 1 : 0) + (d.imageUrl ? 1 : 0);

// Collects structured pages as they finish. Duplicates are caught as deals arrive, against what was already kept,
// so a deal is only ever handed over once. In streaming mode, kept deals leave in batches as soon as enough are ready.
function createResults(startedMs) {
  const kept = [];
  const dropped = [];
  const sent = new Set();
  let fresh = [];

  function sendBatch() {
    if (fresh.length === 0) return;
    const number = trace.batches.length + 1;
    trace.batches.push({ number, deals: fresh.length, secondsIn: Math.round((Date.now() - startedMs) / 1000) });
    fresh.forEach((d) => sent.add(d));
    if (STREAM) {
      const file = new URL(`batch-${number}.json`, BATCH_DIR);
      const place = { ...config.place, radiusMiles: config.radiusMiles };
      writeFileSync(file, JSON.stringify({ place, generatedAt: new Date().toISOString(), model: MODEL, deals: fresh, suggestions: suggestionList() }, null, 2));
      console.log(`::batch ${fileURLToPath(file)}`);
    }
    fresh = [];
    emitTrace("structure");
  }

  const ready = () => fresh.length >= (trace.batches.length === 0 ? FIRST_BATCH_DEALS : BATCH_DEALS)
    || (trace.batches.length === 0 && fresh.length > 0 && Date.now() - startedMs > FIRST_BATCH_MAX_SECONDS * 1000);

  return {
    add({ pageType, records }) {
      trace.structure.pageTypes[pageType] = (trace.structure.pageTypes[pageType] ?? 0) + 1;
      for (const d of records) {
        if (d.dropReason) {
          dropped.push(d);
          continue;
        }
        const twinIndex = kept.findIndex((k) => isSameDeal(k, d));
        if (twinIndex !== -1) {
          const twin = kept[twinIndex];
          // A better copy replaces one that has not been handed over yet.
          if (qualityRank(d) > qualityRank(twin) && !sent.has(twin)) {
            kept[twinIndex] = d;
            fresh = fresh.map((f) => (f === twin ? d : f));
            dropped.push({ ...twin, dropReason: `duplicate of "${d.title}"` });
          } else {
            dropped.push({ ...d, dropReason: `duplicate of "${twin.title}"` });
          }
          countDrop("duplicate");
        } else if (kept.length >= DEALS_TO_WRITE) {
          dropped.push({ ...d, dropReason: "over the deal cap" });
          countDrop("over the deal cap");
        } else {
          kept.push(d);
          fresh.push(d);
        }
      }
      for (const s of trace.stores) s.deals = kept.filter((k) => k.store === s.name).length;
      if (ready()) sendBatch();
    },
    finish() {
      sendBatch();
      return { kept, dropped };
    },
  };
}

// A queue that workers wait on: pages go in as Tavily returns them and come out as Token Factory workers free up.
function createQueue() {
  const items = [];
  const waiting = [];
  let closed = false;
  return {
    push(...pages) {
      for (const page of pages) {
        const waiter = waiting.shift();
        if (waiter) waiter(page);
        else items.push(page);
      }
    },
    close() {
      closed = true;
      while (waiting.length) waiting.shift()(null);
    },
    next() {
      if (items.length) return Promise.resolve(items.shift());
      if (closed) return Promise.resolve(null);
      return new Promise((resolve) => waiting.push(resolve));
    },
  };
}

function printSummary(pages, kept) {
  console.log(`\n${pages.length} pages read, ${kept.length} deals kept`);
  for (const s of trace.stores) console.log(`  ${s.name}: ${s.pages} pages (${s.failed} failed), ${s.deals} deals, ${s.images ?? 0} with a photo`);
  for (const s of trace.stores) {
    const own = kept.filter((d) => d.store === s.name);
    const count = (pick) => JSON.stringify(own.reduce((a, d) => { const t = pick(d); if (t !== undefined) a[t ?? "none"] = (a[t ?? "none"] ?? 0) + 1; return a; }, {}));
    console.log(`  ${s.name} types: verified ${count((d) => (d.dealType ? d.dealType : undefined))}, guessed ${count((d) => (d.inferredType ? d.inferredType : undefined))}, no type ${own.filter((d) => !d.dealType && !d.inferredType).length}`);
  }
  const reasons = Object.entries(trace.dropped).map(([why, n]) => `${n} ${why}`).join(", ");
  console.log(`Dropped: ${reasons || "none"}`);
  for (const [step, s] of Object.entries(stats.steps)) {
    console.log(`  ${step}: ${s.requests} calls, ${s.promptTokens} prompt + ${s.completionTokens} completion tokens`);
  }
  console.log(`Token Factory tokens: ${stats.promptTokens} prompt, ${stats.completionTokens} completion.`);
}

// ---------- API clients (the system boundary) ----------

async function tavily(endpoint, body) {
  const res = await fetch(`https://api.tavily.com/${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TAVILY_API_KEY}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Tavily ${endpoint} returned ${res.status}: ${await res.text()}`);
  return res.json();
}

// Calls Token Factory and returns the message content. Paces requests and retries on 429.
// `step` only labels the usage numbers.
async function chatJson(step, responseFormat, maxTokens, messages, model = MODEL) {
  const stepStats = (stats.steps[step] ??= { requests: 0, promptTokens: 0, completionTokens: 0 });
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const budget = await waitForSlot(Math.ceil(JSON.stringify(messages).length / 3.5) + Math.round(maxTokens * 0.3));
    stats.tokenFactoryRequests++;
    stepStats.requests++;
    const res = await fetch(TOKEN_FACTORY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${NEBIUS_API_KEY}` },
      body: JSON.stringify({ model, messages, response_format: responseFormat, temperature: 0, max_tokens: maxTokens }),
    });
    // The account's real limits are in the headers of every answer.
    const rpm = Number(res.headers.get("x-ratelimit-limit-requests"));
    const tpm = Number(res.headers.get("x-ratelimit-limit-tokens"));
    if (rpm > 0) limits.requestsPerMinute = rpm;
    if (tpm > 0) limits.tokensPerMinute = tpm;
    // 429 is the rate limit. 503 and 529 are "overloaded" and pass on their own, so they are retried too.
    if ([429, 503, 529].includes(res.status) && attempt < MAX_RETRIES) {
      stats.rateLimitRetries++;
      const waitSeconds = Number(res.headers.get("retry-after")) || 2 ** (attempt + 1);
      await sleep(waitSeconds * 1000);
      continue;
    }
    if (!res.ok) throw new Error(`Token Factory returned ${res.status}: ${await res.text()}`);
    const data = await res.json();
    budget.tokens = data.usage.prompt_tokens + data.usage.completion_tokens;
    for (const s of [stats, stepStats]) {
      s.promptTokens += data.usage.prompt_tokens;
      s.completionTokens += data.usage.completion_tokens;
    }
    if (data.choices[0].finish_reason === "length") throw new Error("model output cut off at max_tokens");
    return data.choices[0].message.content;
  }
}

// ---------- Small helpers ----------

const today = () => new Date().toLocaleDateString("en-CA");

// Spaces requests to the account's rate limit and keeps a running count of tokens used in the last minute, so
// many pages can be in flight without tripping the tokens-per-minute limit. Returns the log entry, whose token
// count is corrected once the real usage is known.
let nextSlot = 0;
const tokenLog = [];
async function waitForSlot(estimatedTokens) {
  const gap = 60_000 / (limits.requestsPerMinute * USE_OF_LIMIT);
  const now = Date.now();
  const startAt = Math.max(now, nextSlot);
  nextSlot = startAt + gap;
  await sleep(startAt - now);
  for (;;) {
    const cutoff = Date.now() - 60_000;
    while (tokenLog.length && tokenLog[0].at < cutoff) tokenLog.shift();
    const used = tokenLog.reduce((sum, e) => sum + e.tokens, 0);
    if (tokenLog.length === 0 || used + estimatedTokens <= limits.tokensPerMinute * USE_OF_LIMIT) break;
    await sleep(Math.max(150, tokenLog[0].at + 60_000 - Date.now()));
  }
  const entry = { at: Date.now(), tokens: estimatedTokens };
  tokenLog.push(entry);
  return entry;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
