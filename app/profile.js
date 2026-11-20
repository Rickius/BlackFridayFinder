// The taste profile in SQLite: tag weights, hard limits, pass reasons and the narrative, plus the change log.
// Every swipe nudges the weights right away with fixed amounts. The model rewrites them every 10 swipes (learn.js).
import { db } from "./db.js";
import { tagsFor } from "./tags.js";

export const HALF_LIFE_DAYS = 21;
const DAY_MS = 86_400_000;

// How much one swipe moves each tag the deal carries. Random-slice swipes count 1.5x: they are the fairer test.
const SWIPE_AMOUNT = { save: 0.1, must: 0.2, pass: -0.04 };
const NOT_MY_STYLE_AMOUNT = -0.15;  // replaces the bare pass, it does not stack on it
const LOVED_AMOUNT = 0.35;          // "Got it, loved it", the strongest signal
const RANDOM_MULTIPLIER = 1.5;

export const reasonLabels = { vibe: "Not my style", far: "Too far", pricey: "Too pricey", did: "Already have it", store: "Not this store" };

const DISTANCE_STEPS = [25, 15, 10, 5, 3];
const BUDGET_STEPS = [1000, 500, 250, 100, 50, 25];

const clamp = (x) => Math.max(-1, Math.min(1, x));
const selectProfile = db.prepare("SELECT * FROM profile WHERE id = 1");

// ---------- reading and writing ----------

// Old weights fade: they are halved every HALF_LIFE_DAYS. The decay is applied on read and saved with the
// next save, so nothing needs a timer.
export function readProfile(now = Date.now()) {
  const row = selectProfile.get();
  const days = row.decayed_at ? (now - Date.parse(row.decayed_at)) / DAY_MS : 0;
  const fade = 0.5 ** (days / HALF_LIFE_DAYS);
  const weights = Object.fromEntries(Object.entries(JSON.parse(row.weights)).map(([tag, w]) => [tag, w * fade]));
  return {
    weights,
    maxDistanceMiles: row.max_distance_miles,
    budgetCap: row.budget_cap,
    passReasons: JSON.parse(row.pass_reasons),
    narrative: row.narrative,
    narrativeEdited: Boolean(row.narrative_edited),
    decayedAt: new Date(now).toISOString(),
    lastUpdateSwipeId: row.last_update_swipe_id,
    updatedAt: row.updated_at,
    version: row.version,
  };
}

export function saveProfile(p) {
  // Drop float dust and weights that have faded to nothing.
  const kept = Object.entries(p.weights).filter(([, w]) => Math.abs(w) >= 0.005).map(([tag, w]) => [tag, Math.round(clamp(w) * 1000) / 1000]);
  db.prepare(`UPDATE profile SET weights = ?, max_distance_miles = ?, budget_cap = ?, pass_reasons = ?, narrative = ?,
    narrative_edited = ?, decayed_at = ?, last_update_swipe_id = ?, updated_at = ?, version = ? WHERE id = 1`).run(
    JSON.stringify(Object.fromEntries(kept)), p.maxDistanceMiles, p.budgetCap, JSON.stringify(p.passReasons), p.narrative,
    Number(p.narrativeEdited), p.decayedAt, p.lastUpdateSwipeId, p.updatedAt, p.version);
}

// Adds a { tag: amount } delta to the weights. sign -1 takes it back out (undo, or a chip replacing a bare pass).
export function addToWeights(weights, delta, sign = 1) {
  for (const [tag, amount] of Object.entries(delta)) weights[tag] = clamp((weights[tag] ?? 0) + sign * amount);
}

// ---------- what a signal is worth ----------

const spread = (tags, amount) => Object.fromEntries(tags.map((tag) => [tag, amount]));
const sourceMultiplier = (source) => (source === "random" ? RANDOM_MULTIPLIER : 1);

export const swipeDelta = (tags, action, source) => spread(tags, SWIPE_AMOUNT[action] * sourceMultiplier(source));
export const lovedDelta = (tags) => spread(tags, LOVED_AMOUNT);

// What a pass with a chip adds instead of the bare pass. Only "Not my style" says anything about the category.
export const reasonDelta = (tags, reason, source) => (reason === "vibe" ? spread(tags, NOT_MY_STYLE_AMOUNT * sourceMultiplier(source)) : {});

// "Too far" on a deal this far away: the next step down. Nothing happens when the distance is unknown.
export function lowerDistance(current, dealMiles) {
  if (dealMiles === null) return current;
  return DISTANCE_STEPS.find((step) => step < dealMiles && step < current) ?? Math.min(current, 3);
}

export function lowerBudget(current, price) {
  if (price === null || price === 0) return current;
  // A cheap deal never drops the cap to $0, which would hide every priced deal: the cap just stays.
  return BUDGET_STEPS.find((step) => step < price && step < (current ?? Infinity)) ?? current;
}

// "Got it, loved it" in the Done bucket: a strong push on every tag the deal carries.
export function applyLoved(deal) {
  const p = readProfile();
  addToWeights(p.weights, lovedDelta(tagsFor(deal)));
  saveProfile(p);
  logChange("loved", `"Got it, loved it" on ${deal.title}. Strongest signal: more like it.`);
}

// ---------- the change log ----------

export function logChange(kind, text, { diff = null, swipeId = null } = {}) {
  db.prepare("INSERT INTO profile_log (created_at, kind, text, diff, swipe_id) VALUES (?, ?, ?, ?, ?)")
    .run(new Date().toISOString(), kind, text, diff && JSON.stringify(diff), swipeId);
}

export const removeLogForSwipe = (swipeId) => db.prepare("DELETE FROM profile_log WHERE swipe_id = ?").run(swipeId);

export const readLog = (limit = 25) =>
  db.prepare("SELECT created_at, kind, text, diff FROM profile_log ORDER BY id DESC LIMIT ?").all(limit)
    .map((row) => ({ ...row, diff: row.diff && JSON.parse(row.diff) }));

// ---------- edits and reset ----------

export function editNarrative(text) {
  const p = readProfile();
  p.narrative = text;
  p.narrativeEdited = true;
  saveProfile(p);
  logChange("edit", "You edited your summary. The next update keeps your wording.");
}

export function setLimits({ maxDistanceMiles, budgetCap }) {
  const p = readProfile();
  const notes = [];
  if (maxDistanceMiles !== undefined && maxDistanceMiles !== p.maxDistanceMiles) {
    notes.push(`max distance ${p.maxDistanceMiles} to ${maxDistanceMiles} mi`);
    p.maxDistanceMiles = maxDistanceMiles;
  }
  if (budgetCap !== undefined && budgetCap !== p.budgetCap) {
    notes.push(`budget ${p.budgetCap === null ? "any" : "$" + p.budgetCap} to ${budgetCap === null ? "any" : "$" + budgetCap}`);
    p.budgetCap = budgetCap;
  }
  if (notes.length === 0) return;
  saveProfile(p);
  logChange("edit", `You set ${notes.join(" and ")}.`);
}

// Forgets what was learned: weights, limits, pass reasons, narrative and the log. Swipes and saved deals stay.
// The model is told to look only at swipes from here on.
export function resetProfile(latestSwipeId) {
  const fresh = {
    weights: {}, maxDistanceMiles: 30, budgetCap: null, passReasons: {}, narrative: "", narrativeEdited: false,
    decayedAt: new Date().toISOString(), lastUpdateSwipeId: latestSwipeId, updatedAt: new Date().toISOString(),
    version: readProfile().version + 1,
  };
  saveProfile(fresh);
  db.exec("DELETE FROM profile_log");
  logChange("reset", "Profile reset. Starting from a blank slate.");
}
