// The two Token Factory calls that write the profile: the onboarding parser (once) and the profile updater
// (about every 10 swipes, and when the user leaves). Both run off the swipe path. If a call fails, the old
// profile stays, the failure is logged, and the deck keeps working.
import { db } from "./db.js";
import { chatJson } from "./llm.js";
import { addToWeights, logChange, readProfile, reasonLabels, saveProfile } from "./profile.js";
import { storeSlug } from "./stores.js";
import { allTags, tagsFor } from "./tags.js";
import { getUser } from "./user.js";

export const UPDATE_EVERY = 10;
const UPDATE_DELAY_MS = 2500;   // lets a reason chip land first, so the model sees the pass with its reason
const RETRY_AFTER_FAILURE_MS = 60_000;
const MAX_SWIPES_SENT = 40;
const MAX_WEIGHT_STEP = 0.3;    // however much the model asks for, one update moves a weight at most this far

const clamp = (x) => Math.max(-1, Math.min(1, x));
const weightList = { type: "array", items: { type: "object", additionalProperties: false,
  properties: { tag: { type: "string", enum: allTags }, weight: { type: "number" } }, required: ["tag", "weight"] } };

// Weights as the model reads them: two decimals are plenty.
const describeWeights = (weights) => Object.fromEntries(Object.entries(weights).map(([tag, w]) => [tag, Math.round(w * 100) / 100]));

// ---------- onboarding parser ----------

const parserSchema = {
  type: "object", additionalProperties: false,
  properties: { weights: weightList, narrative: { type: "string" } },
  required: ["weights", "narrative"],
};

const parserPrompt = `You turn a person's answers into a starting taste profile for a swipe deck of Black Friday deals.
- weights: only tags the answers support, usually 2 to 6, each from -1 (avoid) to 1 (love). Categories they picked are strong positives (0.4 to 0.6). Infer categories from their free text, but do not invent interests. "doorbusters" means they like in-store deals, "online deals" means they like shopping from home.
- narrative: one plain sentence (at most 160 characters) about what they want, such as "Hunting for a TV and running shoes, happy to drive for a real doorbuster." Empty string if the answers say nothing.
Use only these tags: ${allTags.join(", ")}.`;

// Turns the onboarding answers into starting weights and narrative. With no answers it does nothing.
// If the model is unavailable the picked categories still become weights, so skipping the model costs little.
export async function parseOnboarding({ answer, vibes }) {
  if (!answer && vibes.length === 0) return;
  let weights = vibes.map((tag) => ({ tag, weight: 0.5 }));
  let narrative = vibes.length ? `Starting from the categories you picked: ${vibes.join(", ")}.` : "";
  try {
    const parsed = await chatJson("parser", "starting_profile", parserSchema, [
      { role: "system", content: parserPrompt },
      { role: "user", content: JSON.stringify({ whatTheyAreLookingFor: answer, categoriesTheyPicked: vibes, storesTheyShopAt: getUser().stores }) },
    ]);
    weights = parsed.weights;
    narrative = parsed.narrative.trim() || narrative;
  } catch (err) {
    console.error(`[onboarding parser failed] ${err.message}. Using the picked categories only.`);
  }
  const profile = readProfile();
  for (const { tag, weight } of weights) profile.weights[tag] = clamp(weight);
  profile.narrative = narrative;
  profile.narrativeEdited = false;
  saveProfile(profile);
  logChange("onboarding", `Starting profile from your answers: ${weights.map((w) => w.tag).join(", ") || "nothing yet"}.`);
}

// ---------- profile updater ----------

const updaterSchema = {
  type: "object", additionalProperties: false,
  properties: { weights: weightList, narrative: { type: "string" }, changes: { type: "array", items: { type: "string" } } },
  required: ["weights", "narrative", "changes"],
};

const updaterPrompt = `You maintain the taste profile for a swipe deck of Black Friday deals. You get the current profile, the swipes since the last update (oldest first), and deals the person got and loved. Return the updated tag weights, the narrative, and what changed.
- Weights run from -1 (avoid) to 1 (love), 0 is neutral. Return only the tags whose weight should change, with their new value; every other tag stays. Never change a tag that does not appear in these swipes. Move a weight by at most 0.3 per update, and only on evidence in these swipes. One swipe is weak evidence (move at most 0.1 for a tag seen once); several swipes that agree are strong.
- A swipe with source "random" is a fairer test of taste than one with source "ranked", so give it more weight. Actions: "save" is positive, "must" is strongly positive, "pass" is negative. A pass with reason "Too far", "Too pricey", "Already have it" or "Not this store" says nothing about the kind of deal, so do not lower its tags. A pass with "Not my style" or no reason is a mild negative. Loved deals are the strongest positive.
- narrative: one or two plain sentences, at most 220 characters, such as "Goes for big discounts on electronics and skips anything over $300." The narrative must agree with the weights you return: keep earlier claims the updated weights still support, drop the rest, and add a new claim only when at least 3 of these swipes support it. If narrativeEditedByUser is true the person wrote or corrected it: keep what they said and only add what the new swipes clearly show.
- changes: up to 5 short lines (at most 80 characters each) saying what changed and why, such as "TVs up: saved 4 of 4". Empty list if nothing is worth changing.
- A swipe with suggestedStore true is on a deal from a store the person did NOT pick (the app suggested it). Saving one is evidence about the kind of deal, and a hint they may like that store, not a stated preference for it; a pass on one is weaker evidence against the kind of deal than a pass on a store they chose. Never put a store name in the narrative as a stated preference unless several saves from that store agree.
- The stores, max distance and budget are the person's own settings. Do not change them.
Use only these tags: ${allTags.join(", ")}.`;

let updating = false;
let rerunAfter = false;    // the user left while an update was running: send what came after it started
let lastFailureAt = 0;
let timer = null;
let lastError = null;
export const getUpdateStatus = () => ({ running: updating, error: lastError });

const selectUnseenSwipes = db.prepare(`
  SELECT s.id, s.action, s.source, s.reason, d.title, d.store, d.store_slug, d.sale_price, d.original_price, d.percent_off, d.category, d.deal_type, d.inferred_type
  FROM swipes s JOIN deals d ON d.id = s.deal_id WHERE s.id > ? ORDER BY s.id`);
const selectLovedSince = db.prepare(`
  SELECT d.* FROM saved_items s JOIN deals d ON d.id = s.deal_id WHERE s.done = 'loved' AND s.done_at > ?`);

const countUnseenSwipes = db.prepare("SELECT COUNT(*) AS n FROM swipes WHERE id > ?");
export const unseenSwipeCount = () => countUnseenSwipes.get(readProfile().lastUpdateSwipeId).n;

// Called after every swipe. Once 10 swipes are waiting, the update starts a moment later, not at the next swipe.
export function scheduleUpdateIfDue() {
  if (unseenSwipeCount() < UPDATE_EVERY || timer) return;
  timer = setTimeout(() => {
    timer = null;
    runUpdate();
  }, UPDATE_DELAY_MS);
}

// Called when the user leaves the app: whatever is waiting is worth sending, even if it is under 10.
export function flushUpdate() {
  if (unseenSwipeCount() === 0) return;
  clearTimeout(timer);
  timer = null;
  if (updating) rerunAfter = true;
  else runUpdate();
}

async function runUpdate() {
  if (updating || Date.now() - lastFailureAt < RETRY_AFTER_FAILURE_MS) return;
  updating = true;
  try {
    const before = readProfile();
    const swipes = selectUnseenSwipes.all(before.lastUpdateSwipeId);
    if (swipes.length === 0) return;
    const loved = selectLovedSince.all(before.updatedAt ?? "");
    const user = getUser();
    const mine = new Set(user.activeStores.map(storeSlug));

    const result = await chatJson("updater", "profile_update", updaterSchema, [
      { role: "system", content: updaterPrompt },
      { role: "user", content: JSON.stringify({
        currentProfile: {
          weights: describeWeights(before.weights),
          narrative: before.narrative,
          narrativeEditedByUser: before.narrativeEdited,
          passReasonCounts: before.passReasons,
          stores: user.activeStores,
          dealTypeFilter: user.typeFilter,
          maxDistanceMiles: before.maxDistanceMiles,
          budgetCap: before.budgetCap,
        },
        recentSwipes: swipes.slice(-MAX_SWIPES_SENT).map((s) => ({
          title: s.title, store: s.store, suggestedStore: !mine.has(s.store_slug), tags: tagsFor(s), salePrice: s.sale_price,
          action: s.action, reason: reasonLabels[s.reason] ?? null,
          source: s.source,
        })),
        lovedDeals: loved.map((d) => ({ title: d.title, store: d.store, tags: tagsFor(d) })),
      }) },
    ]);
    // A tag that none of these swipes carried has no new evidence, whatever the model says.
    const seen = new Set([...swipes, ...loved].flatMap((d) => tagsFor(d)));
    applyUpdate(before, result, swipes.at(-1).id, seen);
    lastError = null;
  } catch (err) {
    lastFailureAt = Date.now();
    lastError = err.message;
    console.error(`[profile update failed] ${err.message}. Keeping the old profile.`);
  } finally {
    updating = false;
    if (rerunAfter) {
      rerunAfter = false;
      flushUpdate();
    }
  }
}

// The model saw `before`. Swipes may have landed while it worked, so its changes are added to the
// profile as it is now, not written over it.
function applyUpdate(before, result, lastSwipeId, seenTags) {
  const now = readProfile();
  const delta = {};
  const diffWeights = [];
  for (const { tag, weight } of result.weights) {
    if (!seenTags.has(tag) && !before.narrativeEdited) continue;   // after a narrative edit the person's words count as evidence
    const from = before.weights[tag] ?? 0;
    const to = clamp(Math.max(from - MAX_WEIGHT_STEP, Math.min(from + MAX_WEIGHT_STEP, weight)));
    delta[tag] = to - from;
    if (Math.abs(to - from) >= 0.05) diffWeights.push({ tag, from: Math.round(from * 100) / 100, to: Math.round(to * 100) / 100 });
  }
  addToWeights(now.weights, delta);

  const narrative = result.narrative.trim();
  const editedMeanwhile = now.narrative !== before.narrative;
  const narrativeChanged = Boolean(narrative) && !editedMeanwhile && narrative !== before.narrative;
  if (narrative && !editedMeanwhile) now.narrative = narrative;
  if (!editedMeanwhile) now.narrativeEdited = false;
  now.lastUpdateSwipeId = lastSwipeId;
  now.updatedAt = new Date().toISOString();
  now.version += 1;
  saveProfile(now);

  const notes = result.changes.map((line) => line.trim()).filter(Boolean);
  const summary = notes.length ? notes.join(". ") : "No big changes.";
  logChange("update", `Profile rewritten. ${summary}`, { diff: { weights: diffWeights, notes, narrativeChanged } });
}
