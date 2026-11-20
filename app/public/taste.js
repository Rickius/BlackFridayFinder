// The profile screen as HTML: the narrative the user can edit, the structured profile (weighted tags, hard limits,
// stores, pass reasons), the change log, and the learning-lift line. `p` is the answer of GET /api/profile.
import { icon as I } from "./icons.js";
import { BUDGETS, cap, esc } from "./format.js";
import { poweredByHtml } from "./search.js";

const LOG_GLYPH = { update: "↻", chip: "−", edit: "✎", reset: "×", onboarding: "★", loved: "♥" };
const percent = (rate) => (rate === null ? "n/a" : `${Math.round(rate * 100)}%`);
const signed = (n) => `${n >= 0 ? "+" : "−"}${Math.abs(n)}`;

function narrativeCard(p, ui) {
  if (ui.editing) {
    return `<div class="hero-q"><textarea data-narr maxlength="600">${esc(p.narrative)}</textarea>
      <div class="row"><button class="btn sm pri" data-act="saveNarr">Save</button><button class="btn sm" data-act="cancelNarr">Cancel</button></div></div>`;
  }
  const text = p.narrative || "Blank slate. Swipe a few deals and we will write this for you.";
  return `<div class="hero-q"><p>${esc(text)}</p><div class="row">
    <button class="btn sm" data-act="editNarr">${I("edit", 14, 2.4)}Edit summary</button>
    ${p.narrativeEdited ? `<span class="meta">Edited by you</span>` : ""}</div></div>`;
}

function updateCard(p) {
  const waiting = Math.min(p.unseenSwipes, p.updateEvery);
  const circumference = 2 * Math.PI * 26;
  const status = p.update.running
    ? "Rewriting your profile now."
    : `${Math.max(0, p.updateEvery - p.unseenSwipes)} more swipes. ${p.lift.total} so far.`;
  const failed = p.update.error
    ? `<div class="sub sm warn-text" style="margin-top:8px">The last update did not go through (${esc(p.update.error)}). The old profile stays and we retry.</div>` : "";
  return `<div class="card2" style="margin-top:12px"><div class="rf">
    <svg width="64" height="64" viewBox="0 0 64 64"><circle cx="32" cy="32" r="26" fill="none" stroke="var(--line)" stroke-width="6"/>
      <circle cx="32" cy="32" r="26" fill="none" stroke="var(--cyan)" stroke-width="6" stroke-linecap="round" stroke-dasharray="${circumference}" stroke-dashoffset="${circumference * (1 - waiting / p.updateEvery)}" transform="rotate(-90 32 32)"/>
      <text x="32" y="37" text-anchor="middle" font-size="16" font-weight="600" fill="var(--ink)" style="font-family:var(--ui)">${waiting}/${p.updateEvery}</text></svg>
    <div><b style="font-size:15px">Next profile rewrite</b><div class="sub sm" style="margin-top:2px">${status}</div></div></div>${failed}</div>`;
}

// One line, directional not proof.
function liftLine(lift) {
  const read = lift.secondReadReached ? "Both reads reached." : lift.firstReadReached ? "First read reached (100). Next at 200." : "First read at 100 swipes.";
  const gap = lift.liftPoints === null ? "Lift: not enough data yet" : `Lift: ${lift.liftPoints > 0 ? "+" : ""}${lift.liftPoints} points`;
  return `<div class="sec meta"><span>Learning lift</span><span>Directional only</span></div>
    <div class="card2"><div class="sub sm"><b style="color:var(--ink)">${gap}</b>. Ranked ${percent(lift.ranked.rate)} right-swiped (${lift.ranked.swipes} swipes),
      random ${percent(lift.random.rate)} (${lift.random.swipes}). ${lift.total} swipes in total. ${read}</div></div>`;
}

function tagsCard(tags) {
  if (tags.length === 0) return `<div class="card2"><div class="sub sm">No tag has moved yet. Swipe a few cards.</div></div>`;
  return `<div class="card2">${tags.map(({ tag, weight }) => `<div class="tb2"><span>${esc(cap(tag))}</span>
    <div class="bar"><i class="${weight < 0 ? "neg" : ""}" style="width:${Math.max(3, Math.abs(weight) * 100)}%"></i></div>
    <span class="v">${signed(Math.round(weight * 100))}</span></div>`).join("")}</div>`;
}

function limitsCard(p) {
  const c = p.constraints;
  const budget = c.budgetCap === null ? "any" : String(c.budgetCap);
  const distance = c.hasHome
    ? `<input class="rg" type="range" min="3" max="50" value="${c.maxDistanceMiles}" data-dist aria-label="Max distance">`
    : `<div class="sub sm">Location is off. Distance is hidden and ignored when ranking.</div>`;
  const budgets = BUDGETS.map(([value, label]) => `<button class="${budget === value ? "on" : ""}" data-act="budget:${value}">${label}</button>`).join("");
  return `<div class="card2">
    <div class="rl"><div class="rt"><span>Max distance</span><span class="meta" data-distval>${c.hasHome ? c.maxDistanceMiles + " mi" : "Off"}</span></div>${distance}
      <div class="sub sm" style="margin-top:6px">Only applies to in-store doorbusters. Online deals are never cut by distance.</div></div>
    <div class="rl"><div class="rt"><span>Budget per item</span><span class="meta">${c.budgetCap === null ? "Any" : "Up to $" + c.budgetCap}</span></div>
      <div class="seg">${budgets}</div></div>
    <div class="rl"><div class="rt"><span>Location</span><button class="btn sm" data-act="${c.hasHome ? "locOff" : "locOn"}">${c.hasHome ? "Turn off" : "Turn on"}</button></div>
      <div class="sub sm">${c.hasHome ? "One home point, used for ranking only. Never kept as history." : "Optional. Shows distance on in-store deals."}</div></div></div>`;
}

function storesCard(p, ui, defaultStores) {
  const own = p.constraints.stores ?? [];
  const names = own.length ? own : defaultStores;
  const chips = names.map((name, i) => `<span class="pl on st">${esc(name)}<button data-act="storeDel:${i}" aria-label="Remove ${esc(name)}">${I("x", 12, 3)}</button></span>`).join("");
  const find = ui.storesDirty
    ? `<button class="btn pri block" style="margin-top:12px" data-act="startSearch">${I("search", 16, 2.4)}Find deals for these stores</button>` : "";
  return `<div class="card2"><div class="ex" style="margin:0 0 12px">${chips || `<span class="sub sm">No stores yet.</span>`}</div>
    <div class="pprow"><input class="ans pin" data-store-q type="text" value="${esc(ui.customStore ?? "")}" placeholder="Add a store" maxlength="40" autocomplete="off" aria-label="Add a store">
      <button class="btn sm pri" data-act="storeAdd">Add</button></div>
    <div class="sub sm" style="margin-top:8px">${own.length ? "We search these first, and also suggest other stores that fit what you like." : "Using the default stores. Add or remove to make the list yours."}</div>${find}</div>`;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// Stores the person did not pick, with deals found for them. Add makes one of their own.
function suggestedCard(list) {
  if (list.length === 0) {
    return `<div class="card2"><div class="sub sm">Nothing yet. When a search finds deals at stores you did not pick, the best fits show up here.</div></div>`;
  }
  return `<div class="card2">${list.map((s, i) => {
    const stats = [plural(s.deals ?? 0, "deal"), s.saves ? `${s.saves} saved` : ""].filter(Boolean).join(" · ");
    return `<div class="srow"><div class="sname"><b>${esc(s.name)}</b>${s.reason ? `<small>${esc(s.reason)}</small>` : ""}<small>${esc(stats)}</small></div>
      <button class="btn sm pri" data-act="storeSuggest:${i}" aria-label="Add ${esc(s.name)} to your stores">${I("plus", 14, 2.6)}Add</button></div>`;
  }).join("")}<div class="sub sm" style="margin-top:10px">Tap "Not this store" after a pass to mute one for good.</div></div>`;
}

function mutedCard(list) {
  return `<div class="card2">${list.map((s) => `<div class="srow"><div class="sname"><b>${esc(s.name)}</b><small>Hidden from your deck</small></div>
      <button class="btn sm" data-act="unmute:${esc(s.slug)}" aria-label="Unmute ${esc(s.name)}">Unmute</button></div>`).join("")}</div>`;
}

function logCard(log) {
  if (log.length === 0) return `<div class="card2"><div class="sub sm">Nothing changed yet.</div></div>`;
  return `<div class="card2">${log.map((entry) => {
    const moves = (entry.diff?.weights ?? []).map((w) => `${w.tag} ${signed(Math.round((w.to - w.from) * 100))}`).join(", ");
    return `<div class="lg"><b>${LOG_GLYPH[entry.kind] ?? "·"}</b><span>${esc(entry.text)}${moves ? `<small>${esc(moves)}</small>` : ""}</span></div>`;
  }).join("")}</div>`;
}

export function tasteHtml(p, ui, models, { defaultStores = [], suggestedStores = [], blockedStores = [] } = {}) {
  const updater = models?.updater?.split("/").pop();
  const attribution = updater ? `<div class="attrib meta">${I("spark", 12, 2.2)}Profile written by ${esc(updater)} on Token Factory</div>` : "";
  const confirm = ui.confirmReset
    ? `<div class="confirm"><div class="permc"><h3 class="disp">Reset your profile?</h3>
        <p>We forget what we learned: tag weights, limits, pass reasons and the summary. Saved deals and your stores stay put.</p>
        <div class="row"><button class="btn" data-act="resetNo">Keep it</button><button class="btn warn" data-act="resetYes">Reset</button></div></div></div>`
    : "";
  return `<div class="ph"><div><h1 class="disp">Profile</h1><p>What the deck thinks you like. Correct it anytime.</p></div></div>
    <div class="page">${narrativeCard(p, ui)}${attribution}${updateCard(p)}
      <div class="sec meta"><span>Taste tags</span><span>Strength</span></div>${tagsCard(p.tags)}
      <div class="sec meta"><span>Your stores</span></div>${storesCard(p, ui, defaultStores)}
      <div class="sec meta"><span>Stores we think you'll like</span></div>${suggestedCard(suggestedStores)}
      ${blockedStores.length ? `<div class="sec meta"><span>Muted stores</span></div>${mutedCard(blockedStores)}` : ""}
      <div class="sec meta"><span>Hard limits</span></div>${limitsCard(p)}
      <div class="sec meta"><span>Change log</span></div>${logCard(p.log)}
      ${liftLine(p.lift)}
      <div style="display:flex;gap:10px;margin-top:26px"><button class="btn warn" style="flex:1" data-act="resetAsk">${I("reset", 15, 2.4)}Reset profile</button></div>
      <div class="pwrap">${poweredByHtml()}</div>
    </div>${confirm}`;
}
