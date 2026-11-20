// Reading deals: the card the browser gets, the pool a deck is drawn from, and "already have it" near-duplicates.
import { db } from "./db.js";
import { HttpError } from "./errors.js";
import { haversineMiles } from "./geo.js";
import { acceptableImageUrl } from "./image-rules.js";
import { passesLimits } from "./public/limits.js";
import { inWindow } from "./public/windows.js";
import { STORE_OPTIONS, locationsByStore, storeSlug } from "./stores.js";
import { effectiveType } from "./tags.js";
import { getUser } from "./user.js";

export const dealOrder = "ORDER BY d.store, COALESCE(d.valid_to, '9999-12-31'), d.title";

// An image is shown only when the resolver marked it reliable (a retailer's own page or image for this deal) and it
// is an https URL that is not a logo, icon or placeholder. Under Armour's "_DEFAULT" product shots are real photos.
export function cardImage(deal) {
  return deal.image_reliable && acceptableImageUrl(deal.image_url) ? deal.image_url : null;
}

const selectSuggestions = db.prepare("SELECT slug, name, domain, reason FROM store_suggestions WHERE region = ?");

// What card building needs besides the deal: the home point, the place, the known branches of each chain, the stores the
// person has right now (the defaults count as theirs when they picked none), the stores they blocked, and the planner's
// reasons. A deal is "suggested" when its store is not one of the person's stores; that is worked out here, never stored.
export function cardContext(user = getUser()) {
  const region = user.place?.slug ?? null;
  return {
    home: user.home,
    place: user.place,
    locs: locationsByStore(region),
    userSlugs: new Set(user.activeStores.map(storeSlug)),
    blocked: new Set(user.blockedStores),
    suggestions: new Map(selectSuggestions.all(region ?? "").map((r) => [r.slug, r])),
  };
}

// The nearest branch to the home point (or to the city centre when there is no home point; then the distance
// stays unknown and only the address is shown). A deal that is online (stated or guessed) has no branch;
// doorbuster, both and unknown types do.
function nearestBranch(deal, { home, place, locs }) {
  const none = { nearest_store: null, distance_miles: null };
  if (effectiveType(deal) === "online") return none;
  const origin = home ?? (place ? { lat: place.lat, lon: place.lon } : null);
  const branches = locs.get(deal.store_slug) ?? [];
  if (!origin || branches.length === 0) return none;
  let best = null;
  let bestMiles = Infinity;
  for (const branch of branches) {
    const miles = haversineMiles(origin, branch);
    if (miles < bestMiles) [best, bestMiles] = [branch, miles];
  }
  return { nearest_store: { name: best.name, address: best.address }, distance_miles: home ? bestMiles : null };
}

// What the browser gets for a card. Coordinates stay on the server.
export function toCard(deal, ctx = cardContext()) {
  const suggested = !ctx.userSlugs.has(deal.store_slug);
  const card = {
    id: deal.id, title: deal.title, store: deal.store, store_slug: deal.store_slug,
    deal_type: deal.deal_type, deal_type_quote: deal.deal_type_quote,
    inferred_type: deal.inferred_type, inferred_reason: deal.inferred_reason,
    sale_price: deal.sale_price, original_price: deal.original_price, percent_off: deal.percent_off, discount_text: deal.discount_text,
    price_verified: Boolean(deal.price_verified),
    valid_from: deal.valid_from, valid_to: deal.valid_to, window_text: deal.window_text, code: deal.code,
    category: deal.category, source_url: deal.source_url, image_url: cardImage(deal), image_source: cardImage(deal) ? deal.image_source ?? null : null, image_alt: deal.title,
    fetched_at: deal.fetched_at,
    claims: JSON.parse(deal.claims),
    suggested, suggestion_reason: suggested ? ctx.suggestions.get(deal.store_slug)?.reason ?? null : null,
    ...nearestBranch(deal, ctx),
  };
  if (deal.saved_at !== undefined) Object.assign(card, { fav: deal.fav, done: deal.done, saved_at: deal.saved_at });
  return card;
}

const selectDeal = db.prepare("SELECT * FROM deals WHERE id = ?");

export function requireDeal(id) {
  const deal = selectDeal.get(id);
  if (!deal) throw new HttpError(404, `No deal with id ${id}`);
  return deal;
}

const selectSaved = db.prepare(
  `SELECT d.*, s.fav, s.done, s.saved_at FROM saved_items s JOIN deals d ON d.id = s.deal_id ${dealOrder}`);
export const savedCards = (ctx = cardContext()) => selectSaved.all().map((row) => toCard(row, ctx));

const selectUnswiped = db.prepare(
  `SELECT d.* FROM deals d WHERE (? IS NULL OR d.region IS NULL OR d.region = ?) AND (d.valid_to IS NULL OR d.valid_to >= ?)
   AND d.id NOT IN (SELECT deal_id FROM swipes) ${dealOrder}`);
const selectHave = db.prepare(
  "SELECT d.id, d.title, d.store_slug FROM swipes s JOIN deals d ON d.id = s.deal_id WHERE s.reason = 'did'");

// ---------- near-duplicates ----------

const FILLER = new Set(["the", "a", "an", "of", "at", "in", "for", "and", "with", "to", "off", "deal", "sale", "black", "friday"]);
const words = (title) => new Set((title.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => !FILLER.has(w) && !/^20\d\d$/.test(w)));

// Share of the shorter title's words that the other title has too.
export function titleOverlap(a, b) {
  const [x, y] = [words(a), words(b)];
  const shared = [...x].filter((w) => y.has(w)).length;
  return shared / Math.max(1, Math.min(x.size, y.size));
}

// The same store and a similar title: "Sony WH-1000XM5 Headphones" and "Sony WH-1000XM5 Wireless Headphones".
export function isNearDuplicate(a, b) {
  if (a.id === b.id) return true;
  return a.store_slug === b.store_slug && titleOverlap(a.title, b.title) >= 0.7 && Math.min(words(a.title).size, words(b.title).size) >= 2;
}

// ---------- the pool ----------

// Unswiped deals running in a window, with distance and `suggested` filled in. `limits` is { typeFilter, storeScope,
// maxDistanceMiles, budgetCap }. A blocked store never shows. Returns { shown, hidden }: shown passed every limit and was
// not marked "already have it".
export function poolFor(window, limits, ctx = cardContext(), todayIso = new Date().toLocaleDateString("en-CA")) {
  const region = ctx.place?.slug ?? null;
  const have = selectHave.all();
  const shown = [];
  let hidden = 0;
  for (const row of selectUnswiped.all(region, region, todayIso)) {
    if (ctx.blocked.has(row.store_slug) || !inWindow(row, window)) continue;
    const deal = { ...row, ...nearestBranch(row, ctx), suggested: !ctx.userSlugs.has(row.store_slug) };
    if (passesLimits(deal, limits) && !have.some((d) => isNearDuplicate(deal, d))) shown.push(deal);
    else hidden++;
  }
  return { shown, hidden };
}

// Every unswiped deal (any window) that is a near-duplicate of this one, so a chip can drop them from the deck.
export function nearDuplicateIds(deal) {
  return selectUnswiped.all(null, null, "0000-00-00").filter((d) => isNearDuplicate(d, deal)).map((d) => d.id);
}

// How many deals exist for the place (blocked stores left out).
export function countDeals(region, blocked = new Set()) {
  return db.prepare("SELECT store_slug FROM deals WHERE ? IS NULL OR region IS NULL OR region = ?").all(region, region)
    .filter((row) => !blocked.has(row.store_slug)).length;
}

// ---------- what the swipes say about each store ----------

const selectStoreSwipes = db.prepare("SELECT d.store_slug, s.action, s.reason FROM swipes s JOIN deals d ON d.id = s.deal_id");
const AFFINITY_MAX = 0.5;

// Per store: saves (a must counts double) against passes, smoothed so a couple of swipes say little, and clamped to
// +-0.5. A pass that says "too far", "too pricey" or "already have it" is not about the store, so it does not count.
export function storeAffinity() {
  const byStore = new Map();
  for (const { store_slug: slug, action, reason } of selectStoreSwipes.all()) {
    const e = byStore.get(slug) ?? { saves: 0, passes: 0, weighted: 0 };
    if (action === "save") { e.saves++; e.weighted += 1; }
    else if (action === "must") { e.saves++; e.weighted += 2; }
    else if (reason === null || reason === "vibe") { e.passes++; e.weighted -= 1; }
    byStore.set(slug, e);
  }
  for (const e of byStore.values()) {
    const total = Math.abs(e.weighted) + e.saves + e.passes;
    e.score = Math.max(-AFFINITY_MAX, Math.min(AFFINITY_MAX, AFFINITY_MAX * (e.weighted / (total + 3))));
  }
  return byStore;
}

// ---------- stores in the state ----------

const storeInfo = (slug, ctx, name = null) => {
  const known = STORE_OPTIONS.find((o) => o.slug === slug);
  const suggestion = ctx.suggestions.get(slug);
  return { name: name ?? suggestion?.name ?? known?.name ?? slug, slug, domain: suggestion?.domain ?? known?.domains[0] ?? null, reason: suggestion?.reason ?? null };
};

export function blockedStoreList(ctx) {
  const names = new Map(db.prepare("SELECT DISTINCT store_slug, store FROM deals").all().map((r) => [r.store_slug, r.store]));
  return [...ctx.blocked].map((slug) => {
    const { name } = storeInfo(slug, ctx, names.get(slug));
    return { name, slug };
  });
}

// Stores that are not the person's, have deals still to see in this place, and are not blocked. Best affinity first.
export function suggestedStoreList(ctx, todayIso = new Date().toLocaleDateString("en-CA")) {
  const region = ctx.place?.slug ?? null;
  const affinity = storeAffinity();
  const found = new Map();
  for (const row of selectUnswiped.all(region, region, todayIso)) {
    if (ctx.userSlugs.has(row.store_slug) || ctx.blocked.has(row.store_slug)) continue;
    const e = found.get(row.store_slug) ?? { ...storeInfo(row.store_slug, ctx, row.store), deals: 0 };
    e.deals++;
    found.set(row.store_slug, e);
  }
  return [...found.values()]
    .map((e) => ({ ...e, saves: affinity.get(e.slug)?.saves ?? 0, passes: affinity.get(e.slug)?.passes ?? 0, _score: affinity.get(e.slug)?.score ?? 0 }))
    .sort((a, b) => b._score - a._score || b.deals - a.deals)
    .map(({ _score, ...rest }) => rest);
}
