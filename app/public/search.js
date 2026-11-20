// The Search tab: where we search, progress for each store, what was searched and dropped, and who does what
// (Tavily finds and reads pages, Token Factory plans, structures, verifies, ranks and learns).
// Also the city picker, which onboarding reuses. `pipeline` is the answer of GET /api/pipeline; its `trace`
// fills in while a search runs, so every field here may be empty or missing.
import { icon as I } from "./icons.js";
import { esc } from "./format.js";

const shortModel = (name) => String(name ?? "").split("/").pop();
const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

// ---------- the city picker ----------

export const newPicker = (act) => ({ query: "", results: [], status: "idle", error: "", act });

// The part under the input, redrawn on its own so typing never loses focus.
export function placeResultsHtml(picker) {
  if (picker.status === "loading") return `<div class="pnote meta">Looking up cities…</div>`;
  if (picker.status === "error") return `<div class="pnote meta err">${esc(picker.error)}</div>`;
  if (picker.status === "empty") return `<div class="pnote meta">No match. Try "City, State".</div>`;
  return `<div class="pres">${picker.results.map((place, i) => {
    const where = place.countryCode === "us" ? "" : place.country ? ` · ${esc(place.country)}` : "";
    return `<button class="pl" data-act="${picker.act}:${i}">${I("pin", 13, 2.4)}&nbsp;${esc(place.name)}${where}</button>`;
  }).join("")}</div>`;
}

export function placePickerHtml(picker) {
  return `<div class="pp"><div class="pprow">
      <input class="ans pin" data-place-q type="text" value="${esc(picker.query)}" placeholder="City, State (like Charlotte, NC)" maxlength="80" autocomplete="off" aria-label="City">
      <button class="btn sm pri" data-act="placeSearch">Search</button></div>
    <div data-place-results>${placeResultsHtml(picker)}</div></div>`;
}

// Quiet line naming the two services, linking to this tab.
export const poweredByHtml = () =>
  `<button class="powered" data-act="tab:search" aria-label="How deals are found">${I("search", 13, 2.4)}<span>Search by <b>Tavily</b></span><i>·</i><span>Intelligence by <b>Token Factory</b></span></button>`;

// ---------- progress by store ----------

function storeRows(state, pipeline) {
  const found = pipeline.trace?.stores ?? [];
  const running = Boolean(pipeline.running);
  if (found.length === 0) {
    const names = state.stores.length ? state.stores : state.defaultStores;
    if (!names.length) return `<div class="card2"><div class="sub sm">Nothing searched yet.</div></div>`;
    return `<div class="card2">${names.map((name) => `<div class="srow"><span class="sdot ${running ? "active" : ""}"></span>
      <div class="sname"><b>${esc(name)}</b><small>${running ? "Waiting its turn" : "Not searched yet"}</small></div></div>`).join("")}</div>`;
  }
  return `<div class="card2">${found.map((s) => {
    const state_ = s.deals > 0 ? "done" : running ? "active" : "none";
    const failed = s.failed ? `, ${s.failed} unreadable` : "";
    return `<div class="srow"><span class="sdot ${state_}"></span>
      <div class="sname"><b class="sl"><span>${esc(s.name)}</span>${s.suggested ? `<span class="sug">Suggested</span>` : ""}</b>${s.suggested && s.reason ? `<small>${esc(s.reason)}</small>` : ""}<small>${plural(s.queries?.length ?? 0, "search", "searches")} · ${plural(s.pages ?? 0, "page")} read${failed}</small></div>
      <div class="scount"><b>${s.deals ?? 0}</b><small>deals</small></div></div>`;
  }).join("")}</div>`;
}

// ---------- what we searched, what was dropped ----------

const DROP_WORDS = {
  "price not verified": "The price on the card was not on the page",
  "no verified offer": "No price or discount the page backs up",
  expired: "The sale had already ended",
  duplicate: "Same deal as one already kept",
  "not a deal": "Not an offer (a product page with no discount)",
  "other store": "From a store we were not looking for",
  "store not in plan": "From a store we were not looking for",
};

function details(key, ui, title, body) {
  return `<details class="dt" data-d="${key}" ${ui.open?.[key] ? "open" : ""}><summary>${title}</summary>${body}</details>`;
}

function searchedHtml(t, ui) {
  const stores = t?.stores ?? [];
  const queryCount = stores.reduce((n, s) => n + (s.queries?.length ?? 0), 0);
  const queryRows = stores.map((s) => `<div class="qgroup"><b>${esc(s.name)}</b>${(s.queries ?? []).map((q) => `<div class="qr"><span class="q">${esc(q)}</span></div>`).join("")}</div>`).join("")
    || `<div class="sub sm">Nothing yet.</div>`;
  const dropped = Object.entries(t?.dropped ?? {}).sort((a, b) => b[1] - a[1]);
  const total = dropped.reduce((n, [, c]) => n + c, 0);
  const dropRows = dropped.map(([reason, n]) => `<div class="qr"><span class="q">${esc(DROP_WORDS[reason] ?? reason)}</span><span class="rc">${n}</span></div>`).join("")
    || `<div class="sub sm">${t ? "Nothing was dropped." : "Shown when a search finishes."}</div>`;
  return `${details("queries", ui, `Search queries (${queryCount})`, queryRows)}
    ${details("dropped", ui, `Why deals were dropped${total ? ` (${total})` : ""}`, dropRows)}`;
}

// ---------- who does what ----------

const TF_ROLES = [
  ["planner", "Planner", "Turns what you typed into search queries and suggests other stores"],
  ["structure", "Structure", "Reads each page and pulls out the deals"],
  ["recheck", "Recheck", "Checks every price and date against the page text"],
  ["ranker", "Ranker", "Orders your deck and writes the why line"],
  ["parser", "Parser", "Reads your onboarding answers"],
  ["updater", "Updater", "Rewrites your taste profile every 10 swipes"],
];

function whoDoesWhatHtml(pipeline) {
  const models = pipeline.trace?.models ?? pipeline.models ?? {};
  return `<div class="card2 who">
    <div class="wh"><span class="vb">Tavily</span><b>Finds and reads pages</b></div>
    <div class="sub sm">Searches the web and extracts the text of each store page.</div>
    <div class="wh" style="margin-top:16px"><span class="vb ink">Token Factory</span><b>Plans, structures, verifies, ranks, learns</b></div>
    ${TF_ROLES.map(([key, name, what]) => `<div class="role"><div><b>${name}</b><span>${what}</span></div><code>${esc(shortModel(pipeline.models?.[key] ?? models[key]) || "not set")}</code></div>`).join("")}</div>`;
}

// ---------- the screen ----------

function placeCard(state, pipeline, ui, picker) {
  const running = Boolean(pipeline.running);
  const keys = pipeline.keys ?? state.keys ?? {};
  const missing = [!keys.tavily && "TAVILY_API_KEY", !keys.tokenFactory && "NEBIUS_API_KEY"].filter(Boolean);
  const choosing = !state.place || ui.changing;
  const where = state.place
    ? `<div class="wrow"><span class="pl on">${I("pin", 14, 2.4)}&nbsp;${esc(state.place.name)}</span>
        <button class="btn sm" data-act="changeCity" ${running ? "disabled" : ""}>${ui.changing ? "Cancel" : "Change city"}</button></div>`
    : `<div class="sub sm" style="margin-bottom:10px">Pick your city and we will look for deals and stores near it.</div>`;
  let action = "";
  if (state.place) {
    action = missing.length
      ? `<div class="setup"><b>Add ${missing.join(" and ")} to .env, then restart</b>
          <p>Finding deals needs both services. Get the Tavily key at <b>app.tavily.com</b> and the Token Factory key (NEBIUS_API_KEY) at <b>tokenfactory.nebius.com</b>.</p></div>`
      : `<button class="btn pri block" style="margin-top:14px" data-act="startSearch" ${running ? "disabled" : ""}>${running ? `<span class="spin"></span>Searching…` : `${I("search", 17, 2.4)}Find deals`}</button>`;
  }
  return `<div class="card2">${where}${choosing ? placePickerHtml(picker) : ""}${action}</div>`;
}

export function searchScreenHtml(state, pipeline, ui, picker) {
  const p = pipeline ?? { running: false, trace: null, log: [], keys: state.keys, models: {} };
  const subtitle = state.place ? `Hunting near ${esc(state.place.name)}` : "Pick a city to start";
  const error = p.error ? `<div class="banner err">${I("x", 16, 3)}<span>${esc(p.error)}</span></div>` : "";
  const status = p.running
    ? `<div class="banner"><i class="beat"></i><span>Searching. ${p.imported?.added ?? 0} deals added so far. The deck fills as they land.</span></div>`
    : p.summary ? `<div class="banner ok">${I("check", 16, 3.4)}<span>${esc(p.summary)}</span></div>` : "";
  const log = (p.log ?? []).length ? `<pre class="runlog">${p.log.map(esc).join("\n")}</pre>` : `<div class="sub sm">No log yet.</div>`;
  return `<div class="ph"><div><h1 class="disp">Find deals</h1><p>${subtitle}</p></div></div>
    <div class="page">
      ${placeCard(state, p, ui, picker)}
      ${error}${status}
      <div class="sec meta"><span>Stores</span><span>${p.trace?.finishedAt && !p.running ? "Last run" : p.running ? "Running" : "Not run yet"}</span></div>
      ${storeRows(state, p)}
      <p class="sub sm" style="margin:10px 2px 0">We search your stores first. The planner also suggests a few other stores that fit what you like. They carry a <span class="sug">Suggested</span> tag, and you can mute any of them with "Not this store".</p>
      <div class="sec meta"><span>What we searched</span></div>
      ${searchedHtml(p.trace, ui)}
      <div class="sec meta"><span>Who does what</span></div>
      ${whoDoesWhatHtml(p)}
      <div class="sec meta"><span>Run log</span></div>
      ${details("log", ui, "Show the log", log)}
      <div class="pwrap">${poweredByHtml()}</div>
    </div>`;
}
