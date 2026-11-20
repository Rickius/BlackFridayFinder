// BF Buster: serves the frontend in app/public and a small JSON API over the SQLite file.
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { buildBatch, windowCounts } from "./deck.js";
import { blockedStoreList, cardContext, cardImage, countDeals, requireDeal, savedCards, suggestedStoreList, toCard } from "./deals.js";
import { cleanPlace, lookupPlaces } from "./place.js";
import { keysPresent, pipelineStatus, startPipeline } from "./pipeline.js";
import { db } from "./db.js";
import { HttpError } from "./errors.js";
import { importDeals, seedFile } from "./import.js";
import { buildIcs } from "./ics.js";
import { UPDATE_EVERY, flushUpdate, getUpdateStatus, parseOnboarding, unseenSwipeCount } from "./learn.js";
import { liftStats } from "./lift.js";
import {
  applyLoved, editNarrative, readLog, readProfile, resetProfile, setLimits,
} from "./profile.js";
import { windowOrder } from "./public/windows.js";
import { DEFAULT_STORES, STORE_OPTIONS, resolveStore, storeSlug } from "./stores.js";
import { addSwipe, applyReason, undoSwipe } from "./swipes.js";
import { allTags, vibeTags } from "./tags.js";
import { getUser, saveUser } from "./user.js";

const publicDir = resolve(dirname(fileURLToPath(import.meta.url)), "public");
const port = Number(process.env.PORT) || 3000;
// Single local user with no login, so listen on this machine only unless told otherwise.
const host = process.env.HOST || "127.0.0.1";

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".otf": "font/otf",
  ".woff2": "font/woff2",
};

// ---------- the sample deck ----------

// The repo ships a deck from a real search. It loads on first boot, and again whenever a newer one ships (the
// generatedAt stamp changes), so an existing database picks up fresh deals and photos. Deals are matched by source
// page and title, so swipes and saved deals stay put. Leftovers of an older seed that were never swiped or saved
// and have no photo are cleared out. A person set on another city does not get it.
function loadSeed() {
  if (!existsSync(seedFile)) return;
  try {
    const seed = JSON.parse(readFileSync(seedFile, "utf8"));
    const loaded = db.prepare("SELECT value FROM meta WHERE key = 'seed_generated_at'").get()?.value;
    if (loaded && loaded === seed.generatedAt) return;
    const place = getUser().place;
    if (place && seed.place?.slug && place.slug !== seed.place.slug) return;
    const { added, updated } = importDeals(seed);

    const inSeed = new Set((seed.deals ?? []).map((d) => `${d.sourceUrl}\n${String(d.title ?? "").trim()}`));
    const stale = db.prepare(`SELECT id, source_url, title FROM deals WHERE region = ? AND image_url IS NULL
      AND id NOT IN (SELECT deal_id FROM swipes) AND id NOT IN (SELECT deal_id FROM saved_items)`).all(seed.place?.slug ?? null);
    const remove = db.prepare("DELETE FROM deals WHERE id = ?");
    let cleared = 0;
    for (const row of stale) {
      if (!inSeed.has(`${row.source_url}\n${row.title}`)) { remove.run(row.id); cleared++; }
    }
    db.prepare("INSERT INTO meta (key, value) VALUES ('seed_generated_at', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(seed.generatedAt ?? "");
    console.log(`Loaded the sample deck from ${seed.generatedAt?.slice(0, 10) ?? "earlier"} for ${seed.place?.name ?? "the sample city"}: ${added} new, ${updated} refreshed${cleared ? `, ${cleared} old ones without photos cleared` : ""}. Run a search from the app to refresh them.`);
  } catch (err) {
    console.warn(`Could not load the sample deck (${err.message}).`);
  }
}

// ---------- saved list ----------

const selectSavedItem = db.prepare("SELECT done FROM saved_items WHERE deal_id = ?");
const deleteSaved = db.prepare("DELETE FROM saved_items WHERE deal_id = ?");
const updateFav = db.prepare("UPDATE saved_items SET fav = ? WHERE deal_id = ?");
const updateDone = db.prepare("UPDATE saved_items SET done = ?, done_at = ? WHERE deal_id = ?");

function updateSaved(dealId, { fav, done }) {
  const wasLoved = selectSavedItem.get(dealId)?.done === "loved";
  const changes = [];
  if (typeof fav === "boolean") changes.push(updateFav.run(Number(fav), dealId));
  if (done !== undefined) {
    if (done !== null && !["got", "loved"].includes(done)) throw new HttpError(400, "done must be got, loved or null");
    changes.push(updateDone.run(done, done && new Date().toISOString(), dealId));
  }
  if (changes.length === 0) throw new HttpError(400, "Send fav (boolean) or done (got or loved)");
  if (changes.some((c) => c.changes === 0)) throw new HttpError(404, "That deal is not in your saved list");
  // "Got it, loved it" is the strongest signal the profile gets.
  if (done === "loved" && !wasLoved) applyLoved(requireDeal(dealId));
  return { ok: true };
}

// ---------- state, user and profile ----------

const limitsOf = (profile) => ({ maxDistanceMiles: profile.maxDistanceMiles, budgetCap: profile.budgetCap });

function getState() {
  const user = getUser();
  const profile = readProfile();
  const ctx = cardContext(user);
  return {
    onboarded: user.onboarded,
    stores: user.stores,
    defaultStores: DEFAULT_STORES,
    storeOptions: STORE_OPTIONS.map(({ name, slug }) => ({ name, slug })),
    typeFilter: user.typeFilter,
    storeScope: user.storeScope,
    blockedStores: blockedStoreList(ctx),
    suggestedStores: suggestedStoreList(ctx),
    when: user.when,
    hasHome: user.home !== null,
    constraints: limitsOf(profile),
    counts: windowCounts(user, profile),
    saved: savedCards(ctx),
    canUndo: db.prepare("SELECT COUNT(*) AS n FROM swipes").get().n > 0,
    hasDeals: countDeals(user.place?.slug ?? null, ctx.blocked) > 0,
    place: user.place,
    wants: user.likesAnswer ?? "",
    keys: keysPresent(),
    searching: pipelineStatus().running,
    tags: allTags,
    vibeTags,
  };
}

// What the deal search needs to know about the person. Written to data/search.json when a search starts.
function searchAnswers() {
  const user = getUser();
  const profile = readProfile();
  const liked = Object.entries(profile.weights).filter(([, w]) => w >= 0.3).sort((a, b) => b[1] - a[1]).map(([tag]) => tag);
  return {
    place: user.place,
    radiusMiles: profile.maxDistanceMiles,
    stores: user.activeStores,
    blockedStores: user.blockedStores,
    discover: true,
    wants: user.likesAnswer ?? "",
    interests: [...new Set([...user.vibes, ...liked])].slice(0, 12),
  };
}

function getProfileView() {
  const profile = readProfile();
  const user = getUser();
  const tags = Object.entries(profile.weights)
    .map(([tag, weight]) => ({ tag, weight: Math.round(weight * 100) / 100 }))
    .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight))
    .slice(0, 10);
  return {
    version: profile.version,
    narrative: profile.narrative,
    narrativeEdited: profile.narrativeEdited,
    tags,
    constraints: {
      ...limitsOf(profile), stores: user.activeStores, typeFilter: user.typeFilter, storeScope: user.storeScope,
      blockedStores: blockedStoreList(cardContext(user)), hasHome: user.home !== null,
    },
    passReasons: profile.passReasons,
    log: readLog(),
    unseenSwipes: unseenSwipeCount(),
    updateEvery: UPDATE_EVERY,
    update: getUpdateStatus(),
    lift: liftStats(),
  };
}

const isBoolean = (value) => typeof value === "boolean";
const isNumberIn = (value, min, max) => typeof value === "number" && value >= min && value <= max;
const TYPE_FILTERS = ["all", "doorbuster", "online"];
const STORE_SCOPES = ["all", "mine", "new"];
const MAX_BLOCKED = 50;
const MAX_STORES = 12;
const MAX_STORE_NAME = 40;

// A list of store display names: trimmed, one per store, known stores under their proper name.
function cleanStores(list) {
  if (!Array.isArray(list) || list.length > MAX_STORES || !list.every((s) => typeof s === "string" && s.trim().length > 0 && s.trim().length <= MAX_STORE_NAME)) {
    throw new HttpError(400, `stores must be a list of up to ${MAX_STORES} store names (1 to ${MAX_STORE_NAME} characters each)`);
  }
  const bySlug = new Map();
  for (const name of list) {
    const store = resolveStore(name);
    if (store.slug && !bySlug.has(store.slug)) bySlug.set(store.slug, store.name);
  }
  return [...bySlug.values()];
}

function updateUser(body) {
  const patch = {};
  if ("stores" in body) {
    patch.stores = cleanStores(body.stores);
    // Adding a store you blocked brings it back.
    const added = new Set(patch.stores.map(storeSlug));
    const blocked = getUser().blockedStores;
    if (blocked.some((slug) => added.has(slug)) && !("blockedStores" in body)) patch.blockedStores = blocked.filter((slug) => !added.has(slug));
  }
  if ("storeScope" in body) {
    if (!STORE_SCOPES.includes(body.storeScope)) throw new HttpError(400, `storeScope must be one of ${STORE_SCOPES.join(", ")}`);
    patch.storeScope = body.storeScope;
  }
  if ("blockedStores" in body) {
    const list = body.blockedStores;
    if (!Array.isArray(list) || list.length > MAX_BLOCKED || !list.every((slug) => typeof slug === "string" && /^[a-z0-9-]{1,60}$/.test(slug))) {
      throw new HttpError(400, `blockedStores must be a list of up to ${MAX_BLOCKED} store slugs`);
    }
    patch.blockedStores = [...new Set(list)];
  }
  if ("typeFilter" in body) {
    if (!TYPE_FILTERS.includes(body.typeFilter)) throw new HttpError(400, `typeFilter must be one of ${TYPE_FILTERS.join(", ")}`);
    patch.typeFilter = body.typeFilter;
  }
  if ("when" in body) {
    if (!windowOrder.includes(body.when)) throw new HttpError(400, `when must be one of ${windowOrder.join(", ")}`);
    patch.when = body.when;
  }
  if ("home" in body) {
    if (body.home !== null && !(isNumberIn(body.home?.lat, -90, 90) && isNumberIn(body.home?.lon, -180, 180))) {
      throw new HttpError(400, "home must be null or { lat, lon }");
    }
    // About 100 m is plenty for "how far is it", and it is the only place we ever keep.
    patch.home = body.home && { lat: Math.round(body.home.lat * 1000) / 1000, lon: Math.round(body.home.lon * 1000) / 1000 };
  }
  if ("place" in body) {
    const place = body.place === null ? null : cleanPlace(body.place);
    if (body.place !== null && !place) throw new HttpError(400, "place must come from the city search (GET /api/places)");
    patch.place = place;
  }
  if ("onboarded" in body) {
    if (!isBoolean(body.onboarded)) throw new HttpError(400, "onboarded must be true or false");
    patch.onboarded = body.onboarded;
  }
  saveUser(patch);
  return { ok: true };
}

async function parseOnboardingAnswers({ answer = "", vibes = [] }) {
  if (typeof answer !== "string" || answer.length > 500) throw new HttpError(400, "answer must be text of at most 500 characters");
  if (!Array.isArray(vibes) || !vibes.every((tag) => allTags.includes(tag))) throw new HttpError(400, "vibes must be known tags");
  saveUser({ likesAnswer: answer.trim(), vibes });
  await parseOnboarding({ answer: answer.trim(), vibes });
  return { ok: true };
}

function updateProfile({ narrative, maxDistanceMiles, budgetCap }) {
  if (narrative !== undefined) {
    if (typeof narrative !== "string" || narrative.trim() === "" || narrative.length > 600) {
      throw new HttpError(400, "narrative must be text of 1 to 600 characters");
    }
    editNarrative(narrative.trim());
  }
  if (maxDistanceMiles !== undefined && !isNumberIn(maxDistanceMiles, 1, 100)) throw new HttpError(400, "maxDistanceMiles must be 1 to 100");
  if (budgetCap !== undefined && budgetCap !== null && !isNumberIn(budgetCap, 0, 100_000)) throw new HttpError(400, "budgetCap must be a number or null");
  setLimits({ maxDistanceMiles, budgetCap });
  return { ok: true, constraints: limitsOf(readProfile()) };
}

function resetEverythingLearned() {
  const last = db.prepare("SELECT MAX(id) AS id FROM swipes").get().id ?? 0;
  resetProfile(last);
  return { ok: true };
}

// ---------- HTTP plumbing ----------

async function readJson(req) {
  if (!req.headers["content-type"]?.startsWith("application/json")) {
    throw new HttpError(415, "Send the body as application/json");
  }
  let text = "";
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 10_000) throw new HttpError(413, "Request body too large");
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new HttpError(400, "Request body is not valid JSON");
  }
  if (typeof body !== "object" || body === null) throw new HttpError(400, "Request body must be a JSON object");
  return body;
}

const sendJson = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
};

// The browser reads a photo's corner pixels to colour the card behind it, and a canvas can only read pixels of a
// same-origin image. This serves the image already stored for one deal (looked up by id, never by a URL the browser
// supplies), so it is not an open proxy. Redirects are refused, the type and size are checked, and the browser caches it.
const IMAGE_FETCH_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const MAX_IMAGE_BYTES = 3_000_000;

async function sendDealImage(res, dealId) {
  const url = cardImage(requireDeal(dealId));
  if (!url) throw new HttpError(404, "That deal has no photo");
  let upstream;
  try {
    upstream = await fetch(url, {
      headers: { "User-Agent": IMAGE_FETCH_UA, Accept: "image/avif,image/webp,image/*,*/*;q=0.8" },
      redirect: "error",
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    throw new HttpError(502, "Could not fetch that photo");
  }
  const type = upstream.headers.get("content-type") ?? "";
  if (!upstream.ok || !type.startsWith("image/")) throw new HttpError(502, "That photo is not available");
  const body = Buffer.from(await upstream.arrayBuffer());
  if (body.length > MAX_IMAGE_BYTES) throw new HttpError(502, "That photo is too large");
  res.writeHead(200, { "Content-Type": type, "Cache-Control": "public, max-age=86400" });
  res.end(body);
}

async function handleApi(req, res, pathname) {
  const imageMatch = req.method === "GET" && pathname.match(/^\/api\/img\/(\d+)$/);
  if (imageMatch) return sendDealImage(res, Number(imageMatch[1]));
  const idMatch = pathname.match(/^\/api\/(saved|deals)\/(\d+)(\.ics)?$/);
  const id = idMatch && Number(idMatch[2]);
  const route = `${req.method} ${pathname}`;
  const reply = (body) => sendJson(res, 200, body);

  switch (route) {
    case "GET /api/state": return reply(getState());
    case "POST /api/deck": {
      const { exclude = [] } = await readJson(req);
      if (!Array.isArray(exclude) || !exclude.every(Number.isInteger)) throw new HttpError(400, "exclude must be a list of deal ids");
      return reply({ cards: await buildBatch(exclude) });
    }
    case "POST /api/swipes": return reply({ ...addSwipe(await readJson(req)), profileVersion: readProfile().version });
    case "POST /api/swipes/undo": return reply(undoSwipe());
    case "POST /api/swipes/reason": return reply(applyReason(await readJson(req)));
    case "PUT /api/user": return reply(updateUser(await readJson(req)));
    case "GET /api/places": {
      const q = new URL(req.url, "http://localhost").searchParams.get("q") ?? "";
      if (q.length > 80) throw new HttpError(400, "Search text is too long");
      try {
        return reply({ places: await lookupPlaces(q) });
      } catch (err) {
        throw new HttpError(502, `City search is unavailable right now (${err.message})`);
      }
    }
    case "GET /api/pipeline": return reply(pipelineStatus());
    case "POST /api/pipeline/start": return reply(startPipeline(searchAnswers()));
    case "POST /api/onboarding/parse": return reply(await parseOnboardingAnswers(await readJson(req)));
    case "GET /api/profile": return reply(getProfileView());
    case "PUT /api/profile": return reply(updateProfile(await readJson(req)));
    case "POST /api/profile/reset": return reply(resetEverythingLearned());
    case "POST /api/profile/flush": // the browser is being closed or hidden: send what is waiting to the model
      flushUpdate();
      return reply({ ok: true });
  }

  if (idMatch?.[1] === "saved" && req.method === "PATCH") return reply(updateSaved(id, await readJson(req)));
  if (idMatch?.[1] === "saved" && req.method === "DELETE") {
    deleteSaved.run(id);
    return reply({ ok: true });
  }
  if (idMatch?.[1] === "deals" && idMatch[3] && req.method === "GET") {
    const deal = requireDeal(id);
    const slug = deal.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50) || "deal";
    res.writeHead(200, {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `attachment; filename="${slug}.ics"`,
    });
    return res.end(buildIcs(toCard(deal)));
  }
  throw new HttpError(404, "No such API route");
}

// ---------- static files ----------

async function serveStatic(res, pathname) {
  const relative = pathname === "/" ? "index.html" : normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  const file = join(publicDir, relative);
  if (!file.startsWith(publicDir + sep)) throw new HttpError(403, "Forbidden");
  let body;
  try {
    body = await readFile(file);
  } catch (err) {
    if (err.code === "ENOENT" || err.code === "EISDIR") throw new HttpError(404, "Not found");
    throw err;
  }
  res.writeHead(200, { "Content-Type": contentTypes[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-cache" });
  res.end(body);
}

// ---------- server ----------

const server = createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, "http://localhost");
    if (pathname.startsWith("/api/")) await handleApi(req, res, pathname);
    else if (req.method === "GET") await serveStatic(res, decodeURIComponent(pathname));
    else throw new HttpError(405, "Method not allowed");
  } catch (err) {
    if (!(err instanceof HttpError)) console.error(err);
    const status = err.status ?? 500;
    sendJson(res, status, { error: err.status ? err.message : "Server error, see the server log" });
  }
});

loadSeed();
server.listen(port, host, () => {
  console.log(`BF Buster running at http://${host}:${port}`);
  if (!process.env.NEBIUS_API_KEY) {
    console.warn("NEBIUS_API_KEY is not set: the deck uses the plain score order and the profile will not be rewritten by the model.");
  }
});
