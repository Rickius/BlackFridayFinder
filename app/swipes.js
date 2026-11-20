// Swipes, the reason chip that can follow a pass, and undo. Each swipe stores what it added to the profile
// (delta) and what its chip changed (undo), so taking it back is exact.
import { db, inTransaction } from "./db.js";
import { HttpError } from "./errors.js";
import { cardContext, nearDuplicateIds, requireDeal, toCard } from "./deals.js";
import { scheduleUpdateIfDue } from "./learn.js";
import {
  addToWeights, lowerBudget, lowerDistance, logChange, readProfile, reasonDelta, reasonLabels, removeLogForSwipe, saveProfile, swipeDelta,
} from "./profile.js";
import { tagsFor } from "./tags.js";
import { getUser, saveUser } from "./user.js";

const selectSwipeForDeal = db.prepare("SELECT id FROM swipes WHERE deal_id = ?");
const selectLastSwipe = db.prepare("SELECT * FROM swipes ORDER BY id DESC LIMIT 1");
const insertSwipe = db.prepare("INSERT INTO swipes (deal_id, action, source, delta, created_at) VALUES (?, ?, ?, ?, ?)");
const deleteSwipe = db.prepare("DELETE FROM swipes WHERE id = ?");
const upsertSaved = db.prepare(`
  INSERT INTO saved_items (deal_id, fav, saved_at) VALUES (?, ?, ?)
  ON CONFLICT (deal_id) DO UPDATE SET fav = excluded.fav, saved_at = excluded.saved_at, done = NULL, done_at = NULL`);
const deleteSaved = db.prepare("DELETE FROM saved_items WHERE deal_id = ?");

const limitsOf = (p) => ({ maxDistanceMiles: p.maxDistanceMiles, budgetCap: p.budgetCap });

export function addSwipe({ dealId, action, source = null }) {
  if (!["save", "pass", "must"].includes(action)) throw new HttpError(400, "action must be save, pass or must");
  if (source !== null && !["ranked", "random"].includes(source)) throw new HttpError(400, "source must be ranked, random or null");
  if (!Number.isInteger(dealId)) throw new HttpError(400, "dealId must be a number");
  const deal = requireDeal(dealId);
  if (selectSwipeForDeal.get(dealId)) throw new HttpError(409, "That deal was already swiped");

  const delta = swipeDelta(tagsFor(deal), action, source);
  const now = new Date().toISOString();
  const swipeId = inTransaction(() => {
    const { lastInsertRowid } = insertSwipe.run(dealId, action, source, JSON.stringify(delta), now);
    if (action !== "pass") upsertSaved.run(dealId, action === "must" ? 1 : 0, now);
    const profile = readProfile();
    addToWeights(profile.weights, delta);
    saveProfile(profile);
    return Number(lastInsertRowid);
  });
  scheduleUpdateIfDue();
  return { ok: true, swipeId };
}

// Undo deletes the last swipe, so the deal returns to the deck and its signal is gone: the weights it
// added, the limit its chip changed, the pass-reason count and the change-log line.
export function undoSwipe() {
  const last = selectLastSwipe.get();
  if (!last) throw new HttpError(409, "Nothing to undo");
  const deal = requireDeal(last.deal_id);

  const profile = inTransaction(() => {
    deleteSwipe.run(last.id);
    if (last.action !== "pass") deleteSaved.run(last.deal_id);
    const p = readProfile();
    addToWeights(p.weights, JSON.parse(last.delta ?? "{}"), -1);
    const { unblock, ...profileUndo } = JSON.parse(last.undo ?? "{}");
    Object.assign(p, profileUndo);
    if (unblock) saveUser({ blockedStores: getUser().blockedStores.filter((slug) => slug !== unblock) });
    if (last.reason) {
      const label = reasonLabels[last.reason];
      p.passReasons[label] -= 1;
      if (p.passReasons[label] <= 0) delete p.passReasons[label];
    }
    // The next swipe may reuse this id, and the model must still see it as new.
    p.lastUpdateSwipeId = Math.min(p.lastUpdateSwipeId, last.id - 1);
    saveProfile(p);
    removeLogForSwipe(last.id);
    return p;
  });

  const card = { ...toCard(deal), source: last.source, why: null };
  return { ok: true, card, constraints: limitsOf(profile) };
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const money = (cap) => (cap === null ? "any" : `$${cap}`);

// What each chip does besides replacing the bare pass. Each one changes the profile `p` and the `undo` record,
// and returns the toast, the change-log line, and (for "Already have it") the ids to drop from the browser's buffer.
const reasonEffects = {
  vibe: ({ deal }) => ({
    message: "Noted: fewer deals like this",
    log: `Not my style on "${deal.title}": lowered ${tagsFor(deal)[0] ?? "this kind of deal"}.`,
  }),

  far: ({ deal, miles, p, undo }) => {
    const next = lowerDistance(p.maxDistanceMiles, miles);
    if (next === p.maxDistanceMiles) {
      const why = miles === null ? "no distance known" : "already the lowest step";
      return {
        message: miles === null ? "Noted. No distance for this one, so the limit stays" : `Max distance stays at ${next} mi`,
        log: `Too far on "${deal.title}": ${why}, so the limit stays at ${next} mi.`,
      };
    }
    undo.maxDistanceMiles = p.maxDistanceMiles;
    const log = `Too far on "${deal.title}": max distance ${p.maxDistanceMiles} to ${next} mi.`;
    p.maxDistanceMiles = next;
    return { message: `Max distance is now ${next} mi`, log };
  },

  pricey: ({ deal, p, undo }) => {
    const next = lowerBudget(p.budgetCap, deal.sale_price);
    if (next === p.budgetCap) {
      const why = deal.sale_price === null ? "no price listed" : "nothing lower to set";
      return {
        message: deal.sale_price === null ? "Noted. No price for this one, so the cap stays" : "Budget cap stays as it is",
        log: `Too pricey on "${deal.title}": ${why}, so the cap stays.`,
      };
    }
    undo.budgetCap = p.budgetCap;
    const log = `Too pricey on "${deal.title}": budget ${money(p.budgetCap)} to ${money(next)}.`;
    p.budgetCap = next;
    return { message: `Budget cap is now ${money(next)}`, log };
  },

  // Only for a card from a store the person did not pick. The store leaves the deck for good (until undo, or they add it),
  // and no category weight changes: the reason is about the store, not the kind of deal.
  store: ({ deal, undo }) => {
    const slug = deal.store_slug;
    saveUser({ blockedStores: [...new Set([...getUser().blockedStores, slug])] });
    undo.unblock = slug;
    const removedIds = db.prepare("SELECT id FROM deals WHERE store_slug = ? AND id != ? AND id NOT IN (SELECT deal_id FROM swipes)").all(slug, deal.id).map((r) => r.id);
    const extra = removedIds.length ? `, with ${plural(removedIds.length, "other deal")}` : "";
    return { message: `${deal.store} hidden${extra}`, log: `Not this store on "${deal.title}": ${deal.store} will not show up again${extra}.`, removedIds };
  },

  did: ({ deal }) => {
    const removedIds = nearDuplicateIds(deal).filter((id) => id !== deal.id);
    const extra = removedIds.length ? `, plus ${plural(removedIds.length, "near-duplicate")}` : "";
    return { message: `Hidden for good${extra}`, log: `Already have it: "${deal.title}" removed${extra}.`, removedIds };
  },
};

// The chip tapped after a pass. It takes the place of the bare pass: the small category down-weight is taken back,
// then the reason does its own job. A reason about distance, price or a repeat never lowers the category.
export function applyReason({ swipeId, reason }) {
  if (!reasonLabels[reason]) throw new HttpError(400, "reason must be vibe, far, pricey, did or store");
  const last = selectLastSwipe.get();
  if (!last || last.id !== swipeId) throw new HttpError(409, "That swipe is no longer the last one");
  if (last.action !== "pass") throw new HttpError(400, "Reasons only go with a pass");
  if (last.reason) throw new HttpError(409, "That pass already has a reason");

  const deal = { ...requireDeal(last.deal_id) };
  const card = toCard(deal, cardContext());
  if (reason === "store" && !card.suggested) throw new HttpError(400, "\"Not this store\" only goes with a card from a store you did not pick");
  const miles = card.distance_miles;

  return inTransaction(() => {
    const p = readProfile();
    const undo = {};
    addToWeights(p.weights, JSON.parse(last.delta), -1);
    const delta = reasonDelta(tagsFor(deal), reason, last.source);
    addToWeights(p.weights, delta);

    const { message, log, removedIds = [] } = reasonEffects[reason]({ deal, miles, p, undo });

    const label = reasonLabels[reason];
    p.passReasons[label] = (p.passReasons[label] ?? 0) + 1;
    saveProfile(p);
    db.prepare("UPDATE swipes SET reason = ?, delta = ?, undo = ? WHERE id = ?").run(reason, JSON.stringify(delta), JSON.stringify(undo), last.id);
    logChange("chip", log, { swipeId: last.id });
    return { ok: true, message, removedIds, constraints: limitsOf(p) };
  });
}
