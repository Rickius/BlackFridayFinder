// Builds the next batch of cards. Hard constraints filter the pool first. About 1 card in 5 is then drawn at
// random from that pool (the exploration slice, which is also the control for the learning-lift metric). The
// rest come from a deterministic score over the pool, cut to a shortlist of about 30 that the ranker model
// reorders and writes a "why this" line for. If the model fails, the score order is used.
import { cardContext, cardImage, poolFor, storeAffinity, toCard } from "./deals.js";
import { chatJson } from "./llm.js";
import { dealWindows, windowOrder } from "./public/windows.js";
import { readProfile } from "./profile.js";
import { discountPercent, tagsFor } from "./tags.js";
import { getUser } from "./user.js";

const BATCH_SIZE = 10;
const SHORTLIST_SIZE = 30;
const STORE_REPEAT_PENALTY = 0.08;  // per deal from the same store already in the shortlist, so one store cannot fill a whole batch
const MAX_PER_STORE = 3;        // ranked picks from one store in a batch of 10
const PHOTO_BOOST = 1;          // a deal with a product photo outranks any deal without one on score alone
const RANDOM_SHARE = 0.2;
const REPEAT_PENALTY = 0.12;  // per card of the same category already in the shortlist, so no category floods it
const RANDOM_WHY = "Something different.";
const RESERVED_SUGGESTED = 3;   // of every batch of 10, when suggested stores are in play
const OWN_STORE_BOOST = 0.4;
const SUGGESTED_LEAD = "A store you did not pick: ";

const limitsOf = (user, profile) => ({ typeFilter: user.typeFilter, storeScope: user.storeScope, maxDistanceMiles: profile.maxDistanceMiles, budgetCap: profile.budgetCap });

// How many cards each window would show, and how many unswiped deals its limits hide.
export function windowCounts(user, profile) {
  const windows = dealWindows();
  const ctx = cardContext(user);
  return Object.fromEntries(windowOrder.map((key) => {
    const { shown, hidden } = poolFor(windows[key], limitsOf(user, profile), ctx);
    return [key, { shown: shown.length, hidden }];
  }));
}

// ---------- the deterministic score ----------

// Higher is better: tag weights, what their swipes say about the store (any store, within +-0.5), a boost for the
// person's own stores, a deep discount, fitting the budget, being close (in-store deals), and ending soon.
function score(deal, profile, today, ctx, affinity) {
  let total = tagsFor(deal).reduce((sum, tag) => sum + (profile.weights[tag] ?? 0), 0);
  if (cardImage(deal)) total += PHOTO_BOOST;
  total += affinity.get(deal.store_slug)?.score ?? 0;
  if (ctx.userSlugs.has(deal.store_slug)) total += OWN_STORE_BOOST;
  const percent = discountPercent(deal);
  if (percent !== null) total += 0.3 * Math.min(1, percent / 60);
  if (deal.sale_price !== null && profile.budgetCap !== null && profile.budgetCap > 0) {
    total += deal.sale_price <= profile.budgetCap ? 0.15 * (0.5 + 0.5 * (deal.sale_price / profile.budgetCap)) : 0;
  }
  if (deal.distance_miles !== null) total -= (0.4 * deal.distance_miles) / profile.maxDistanceMiles;
  if (deal.valid_to !== null) {
    const daysLeft = (Date.parse(deal.valid_to) - Date.parse(today)) / 86_400_000;
    total += 0.15 * Math.max(0, 1 - daysLeft / 7);
  }
  return total;
}

// Best first, picked one at a time with a penalty for repeating a category. With no profile yet that
// penalty is what gives the first deck a spread of different things.
function shortlist(deals, profile, today, ctx, affinity) {
  const left = deals.map((deal) => ({ deal, score: score(deal, profile, today, ctx, affinity) }));
  const perCategory = {};
  const perStore = {};
  const picked = [];
  while (picked.length < SHORTLIST_SIZE && left.length > 0) {
    const adjusted = (item) => item.score - REPEAT_PENALTY * (perCategory[item.deal.category] ?? 0) - STORE_REPEAT_PENALTY * (perStore[item.deal.store_slug] ?? 0);
    let best = 0;
    left.forEach((item, i) => { if (adjusted(item) > adjusted(left[best])) best = i; });
    const [{ deal }] = left.splice(best, 1);
    perCategory[deal.category] = (perCategory[deal.category] ?? 0) + 1;
    perStore[deal.store_slug] = (perStore[deal.store_slug] ?? 0) + 1;
    picked.push(deal);
  }
  return picked;
}

// ---------- the ranker model ----------

const rankerSchema = {
  type: "object", additionalProperties: false,
  properties: { picks: { type: "array", items: { type: "object", additionalProperties: false,
    properties: { id: { type: "integer" }, why: { type: "string" } }, required: ["id", "why"] } } },
  required: ["picks"],
};

const rankerPrompt = `You rank Black Friday deals for one person's swipe deck. You get their taste profile and a shortlist of deals that already passed their hard limits. Pick the best deals for them, best first, and write a one-line "why" for each.
- Pick exactly the number asked for, only ids from the shortlist, each at most once. Every id in mustInclude must be among your picks.
- Favor what they like and avoid what they dislike. Prefer variety over near-identical deals, and a mix of stores.
- why: one plain, positive sentence, at most 90 characters, such as "Best Buy doorbuster: 40% off, and you like TVs." Lead with a concrete fact from the deal data (store, sale price, percent off, doorbuster window, end date) and connect it to something in their likes only when it really matches. The dislikes are only for ranking: never mention them, never say a deal is less ideal, and never mention budget. No filler such as "fits your taste" or "great deal", and no claims the data does not make.
- If suggestedStore is true, the store is one the person did NOT pick (the app suggests it): begin the line with "A store you did not pick:" and then one verified fact from the data. Say nothing else about that store (never that it is similar to another, better, popular or trusted).
- Say doorbuster, in store or online only when dealType says so; when dealType is null say nothing about where it is sold. Use only the prices and percent shown in the data. Never say a product is in stock, available, or selling fast. Mention distance only when distanceMiles is given. Never mention weights, scores or "the profile".`;

// What the model sees of a deal. Only verified facts: a price that did not check out is already null, and the
// where-it-is-sold type is the page's own (null when the page does not say). A guessed type is used for ranking
// (the score and the filter) but is never shown to the model, so it cannot end up in a line as fact.
const brief = (d) => ({
  id: d.id, title: d.title, store: d.store, suggestedStore: Boolean(d.suggested), dealType: d.deal_type,
  salePrice: d.sale_price, originalPrice: d.original_price, percentOff: discountPercent(d), discountText: d.discount_text,
  window: d.window_text, endsOn: d.valid_to,
  // A distance says "you can go there for this deal", so it is only given when the page says it is sold in store.
  distanceMiles: d.distance_miles === null || (d.deal_type !== "doorbuster" && d.deal_type !== "both") ? null : Math.round(d.distance_miles * 10) / 10,
  tags: tagsFor(d, { verifiedOnly: true }),
});

const likedTags = (profile, sign) =>
  Object.entries(profile.weights).filter(([, w]) => w * sign >= 0.15).sort((a, b) => (b[1] - a[1]) * sign).map(([tag]) => tag);

const dollars = (n) => `$${Number.isInteger(n) ? n : n.toFixed(2)}`;
const amountsIn = (text) => (text.match(/\$\s*\d[\d,]*(?:\.\d+)?/g) ?? []).map((s) => Number(s.replace(/[$,\s]/g, "")));

// A "why" that says something the deal data does not support would contradict the card. Returns true if it does.
function claimsMoreThanKnown(why, d) {
  const named = `${d.title} ${d.store}`;
  if (/\b(in[\s-]?stock|stock|supplies|availab|selling fast|sold out)\b/i.test(why)) return true;
  // Near, close and "at your store" all mean "sold in a store near you": only a verified in-store deal may say it.
  const verifiedInStore = d.deal_type === "doorbuster" || d.deal_type === "both";
  if ((d.distance_miles === null || !verifiedInStore) && /\b(near|nearby|nearest|close|closest|miles?|drive|minutes? away|local|your (?:local )?store|at your)\b/i.test(why)) return true;
  if (/\b(doorbusters?|in[\s-]?store)\b/i.test(why) && d.deal_type !== "doorbuster" && d.deal_type !== "both" && !/doorbuster|in[\s-]?store/i.test(named)) return true;
  if (/\bonline\b/i.test(why) && d.deal_type !== "online" && d.deal_type !== "both" && !/online/i.test(named)) return true;
  const known = [d.sale_price, d.original_price].filter((n) => n !== null);
  if (amountsIn(why).some((amount) => !known.some((k) => Math.abs(k - amount) < 0.01))) return true;
  const percent = discountPercent(d);
  return [...why.matchAll(/(\d+(?:\.\d+)?)\s*%/g)].some((m) => percent === null || Math.abs(Number(m[1]) - percent) > 0.5);
}

// The card's facts in a line, for when the model fails or says something the data does not back up.
function fallbackWhy(deal, profile) {
  const liked = tagsFor(deal, { verifiedOnly: true }).filter((tag) => (profile.weights[tag] ?? 0) >= 0.15).slice(0, 2);
  const percent = discountPercent(deal);
  const offer = deal.sale_price !== null ? dollars(deal.sale_price) : deal.discount_text ?? (percent !== null ? `${percent}% off` : "a deal");
  if (deal.suggested) return liked.length ? `${SUGGESTED_LEAD}matches what you like: ${liked.join(", ")}.` : `${SUGGESTED_LEAD}${offer} at ${deal.store}.`;
  if (liked.length) return `Matches what you like: ${liked.join(", ")}.`;
  const type = deal.deal_type === "doorbuster" ? " doorbuster" : deal.deal_type === "online" ? " online deal" : "";
  return `${deal.store}${type}: ${offer}.`;
}

// A card from a store the person did not pick says so, whatever the model wrote.
const withLead = (line, deal) => {
  if (!deal.suggested) return line;
  const rest = line.replace(/^a store you did not pick\w*\s*[:,.-]?\s*/i, "");
  return `${SUGGESTED_LEAD}${rest.charAt(0).toLowerCase()}${rest.slice(1)}`;
};

async function rerank(candidates, count, profile, user, mustInclude) {
  const { picks } = await chatJson("ranker", "ranked_picks", rankerSchema, [
    { role: "system", content: rankerPrompt },
    { role: "user", content: JSON.stringify({
      pick: count,
      mustInclude: mustInclude.map((d) => d.id),
      person: {
        narrative: profile.narrative, likes: likedTags(profile, 1), dislikes: likedTags(profile, -1),
        stores: user.activeStores, wantsToShop: user.typeFilter === "all" ? "in store and online" : user.typeFilter === "doorbuster" ? "in store" : "online",
      },
      shortlist: candidates.map(brief),
    }) },
  ]);
  const byId = new Map(candidates.map((d) => [d.id, d]));
  const ranked = [];
  for (const { id, why } of picks) {
    const deal = byId.get(id);
    if (!deal) continue;
    byId.delete(id);
    const line = why.trim().slice(0, 120);
    ranked.push({ deal, byModel: true, why: line && !claimsMoreThanKnown(line, deal) ? withLead(line, deal).slice(0, 140) : fallbackWhy(deal, profile) });
  }
  // Fill from the score order if the model returned too few valid ids.
  for (const deal of byId.values()) {
    if (ranked.length >= count) break;
    ranked.push({ deal, byModel: false, why: fallbackWhy(deal, profile) });
  }
  return ranked.slice(0, count);
}

// No store fills a batch: past MAX_PER_STORE ranked picks, the next-best deal from another store takes the slot.
// Reserved suggested deals are exempt, and when nothing else is on offer the pick stays.
function capPerStore(picks, candidates, profile, keep) {
  const counts = {};
  const spare = candidates.filter((d) => !picks.some((p) => p.deal.id === d.id));
  return picks.map((pick) => {
    const slug = pick.deal.store_slug;
    if (keep.has(pick.deal.id) || (counts[slug] ?? 0) < MAX_PER_STORE) {
      counts[slug] = (counts[slug] ?? 0) + 1;
      return pick;
    }
    const at = spare.findIndex((d) => (counts[d.store_slug] ?? 0) < MAX_PER_STORE);
    if (at === -1) return pick;
    const [deal] = spare.splice(at, 1);
    counts[deal.store_slug] = (counts[deal.store_slug] ?? 0) + 1;
    return { deal, byModel: false, why: fallbackWhy(deal, profile) };
  });
}

// `reserved` are suggested deals that must be in the batch. The model orders and explains them with the rest; if it
// drops one, that one takes the place of the last pick that was not reserved.
async function rankedPicks(pool, count, profile, user, today, ctx, affinity, reserved) {
  if (count === 0) return [];
  const candidates = [...new Map([...reserved, ...shortlist(pool, profile, today, ctx, affinity)].map((d) => [d.id, d])).values()];
  let picks;
  try {
    picks = await rerank(candidates, count, profile, user, reserved);
  } catch (err) {
    console.error(`[ranker failed] ${err.message}. Using the score order.`);
    picks = candidates.slice(0, count).map((deal) => ({ deal, byModel: false, why: fallbackWhy(deal, profile) }));
  }
  const keep = new Set(reserved.map((d) => d.id));
  for (const deal of reserved) {
    if (picks.some((p) => p.deal.id === deal.id)) continue;
    const at = picks.findLastIndex((p) => !keep.has(p.deal.id));
    if (at !== -1) picks[at] = { deal, byModel: false, why: fallbackWhy(deal, profile) };
  }
  return capPerStore(picks, candidates, profile, keep);
}

// ---------- the batch ----------

function sample(items, count) {
  const copy = [...items];
  for (let i = 0; i < count; i++) {
    const j = i + Math.floor(Math.random() * (copy.length - i));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, count);
}

// `exclude` is the ids the browser already holds, so a refill never repeats a card.
export async function buildBatch(exclude) {
  const user = getUser();
  const profile = readProfile();
  const today = new Date().toLocaleDateString("en-CA");
  const ctx = cardContext(user);
  const affinity = storeAffinity();
  const { shown } = poolFor(dealWindows()[user.when], limitsOf(user, profile), ctx, today);
  const unseen = shown.filter((d) => !exclude.includes(d.id));
  // Listings with a photo come first: a picture sells a deal. Deals without one only fill in once fewer than a
  // full batch of pictured deals is left.
  const withPhoto = unseen.filter(cardImage);
  const pool = withPhoto.length >= BATCH_SIZE ? withPhoto : unseen;

  // Exactly 2 random cards in a batch of 10, in unpredictable places. Rounding up or down by chance keeps small batches at 1 in 5 on average.
  const size = Math.min(BATCH_SIZE, pool.length);
  const randomPlaces = new Set(sample([...Array(size).keys()], Math.floor(size * RANDOM_SHARE + Math.random())));
  const slots = Array.from({ length: size }, (_, i) => (randomPlaces.has(i) ? "random" : "ranked"));
  const randoms = sample(pool, randomPlaces.size);
  const rest = pool.filter((d) => !randoms.includes(d));
  const rankedCount = slots.filter((s) => s === "ranked").length;
  // With every store in play, 3 of the 10 slots go to the best suggested deals (fewer if there are not that many).
  const reserveCount = user.storeScope === "all" ? Math.min(RESERVED_SUGGESTED, rankedCount) : 0;
  const reserved = reserveCount ? shortlist(rest.filter((d) => d.suggested), profile, today, ctx, affinity).slice(0, reserveCount) : [];
  const ranked = await rankedPicks(rest, rankedCount, profile, user, today, ctx, affinity, reserved);

  return slots.map((slot) => {
    if (slot === "random") return { ...toCard(randoms.pop(), ctx), source: "random", why: RANDOM_WHY };
    const { deal, why, byModel } = ranked.shift();
    return { ...toCard(deal, ctx), source: "ranked", why, by_model: byModel };
  });
}
