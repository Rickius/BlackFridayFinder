// Black Friday deals frontend. The server is the source of truth for deals, swipes, saved items and the profile.
// The browser holds a buffer of ready cards and refills it in the background, so a swipe never waits on a model.
import { fillIcon, icon as I } from "./icons.js";
import { artHtml, photoUsable, preloadPhotos } from "./art.js";
import "./device.js";
import { celebrate } from "./confetti.js";
import { attachSwipe, flyAway } from "./swipe.js";
import { passesLimits } from "./limits.js";
import { onboardingHtml, obStoreNames } from "./onboarding.js";
import { newPicker, placeResultsHtml, poweredByHtml, searchScreenHtml } from "./search.js";
import { tasteHtml } from "./taste.js";
import {
  dealWindows, discountPercent, distanceLabel, effectiveType, endsText, esc, fmtDay, inWindow, isExpired, isInStore, mapUrl,
  money, offPill, seenLabel, sourceName, typeInfo, windowLine, windowOrder,
} from "./format.js";

const root = document.querySelector("#root");
const toastEl = document.querySelector("#toast");

const REFILL_BELOW = 5;       // fetch another batch in the background when fewer cards than this are left
const scopeChoices = [["all", "All stores"], ["mine", "Mine only"], ["new", "New to me"]];
const typeChoices = [["all", "For you"], ["doorbuster", "Doorbusters"], ["online", "Online"]];

const state = {
  booting: true,
  loadError: null,
  // from GET /api/state
  onboarded: false,
  stores: [],
  defaultStores: [],
  storeOptions: [],
  typeFilter: "all",
  storeScope: "all",    // all | mine | new: which stores the deck draws from
  blockedStores: [],   // [{ name, slug }] stores the person muted with "Not this store"
  suggestedStores: [], // stores they did not pick but may like, from the server
  when: "weekend",
  hasHome: false,
  constraints: { maxDistanceMiles: 30, budgetCap: null },
  counts: {},
  saved: [],
  canUndo: false,
  hasDeals: true,
  place: null,         // the city the person hunts near
  keys: { tavily: false, tokenFactory: false },
  searching: false,    // a search is running on the server
  tags: [],
  vibeTags: [],
  profileVersion: null, // the last profile version seen, to notice a background rewrite
  // the deck
  buffer: [],          // cards fetched for the current window, best first
  history: [],         // cards swiped this session, so undo can bring the exact card back
  refilling: false,
  exhausted: false,    // the last refill found nothing new
  // screens
  tab: "deck",
  savedTab: "toget",
  menuOpen: false,
  expanded: null,      // id of the deal whose details are open
  ob: { step: 0, stores: [], customStore: "", answer: "", vibes: [], typeFilter: "all", budget: null, loc: "unset", place: null, busy: false },
  picker: newPicker("obPlace"), // the city search box, used by onboarding and the Search tab
  pipeline: null,      // GET /api/pipeline, loaded when the search tab opens
  searchUi: { changing: false, open: {} },
  taste: null,         // GET /api/profile, loaded when the taste tab opens
  tasteUi: { editing: false, confirmReset: false, storesDirty: false, customStore: "" },
};
let swiping = false;
let enterNext = false;   // the next card to come up plays its entrance once
let tasteTimer;
let searchTimer;
let placeTimer;
let placeSeq = 0;

const actionFor = { right: "save", left: "pass", up: "must" };

// ---------- talking to the server ----------

async function api(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body && JSON.stringify(body),
    });
  } catch {
    throw new Error("Can't reach the server. Is it still running?");
  }
  const data = await res.json();
  if (!res.ok) {
    const err = new Error(data.error ?? `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

async function load() {
  try {
    Object.assign(state, await api("GET", "/api/state"), { loadError: null });
  } catch (err) {
    state.loadError = err.message;
  }
}

// Sends a change. On failure the user sees the server's message and the caller still reloads to resync.
async function send(method, path, body) {
  try {
    return await api(method, path, body);
  } catch (err) {
    toast(err.message);
  }
}

async function change(method, path, body, message) {
  const result = await send(method, path, body);
  if (result && message) toast(message);
  await load();
  render();
}

let toastTimer;
function toast(message) {
  toastEl.textContent = message;
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), 2200);
}

// ---------- derived data ----------

const hostOf = (url) => {
  try {
    return new URL(url, location.href).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
};
const findDeal = (id) => state.buffer.find((d) => d.id === id) ?? state.saved.find((d) => d.id === id);
const limits = () => ({ typeFilter: state.typeFilter, storeScope: state.storeScope, ...state.constraints });
// Hard constraints are applied to buffered cards right away, so a changed limit shows up on the next card.
const deckCards = () => state.buffer.filter((card) => passesLimits(card, limits()));
const toGet = () => state.saved.filter((d) => !d.done);
const gotIt = () => state.saved.filter((d) => d.done);

// ---------- the buffer ----------

async function refill() {
  if (state.refilling) return;
  state.refilling = true;
  try {
    const { cards } = await api("POST", "/api/deck", { exclude: state.buffer.map((c) => c.id) });
    const known = new Set(state.buffer.map((c) => c.id));
    state.buffer.push(...cards.filter((c) => !known.has(c.id)));
    preloadPhotos(deckCards().slice(0, 5));
    state.exhausted = cards.length === 0;
  } catch (err) {
    toast(err.message);
  } finally {
    state.refilling = false;
  }
  // Redraw only if the screen is waiting for a card (the deck may have emptied while this was on its way),
  // so a refill never disturbs the reason chips or a card being dragged.
  if (state.tab === "deck" && state.onboarded && !root.querySelector(".card.top")) render();
}

function refillIfLow() {
  if (!state.exhausted && deckCards().length < REFILL_BELOW) refill();
}

// Throws the buffer away (a different window, a moved home point, a reset) and fetches fresh cards.
function restartDeck() {
  state.buffer = [];
  state.exhausted = false;
  const filling = refill();
  render();
  return filling;
}

// ---------- the card ----------

// A store the person did not pick but may like: a small cyan-outline tag, never louder than the deal.
const suggestedTag = (deal) => (deal.suggested ? `<span class="sug" title="A store you did not pick">Suggested</span>` : "");

// A verified type is a solid chip. A guess is a dashed chip with a small "unverified" note, never styled like a verified one.
const typeChip = (deal) => {
  const t = typeInfo(deal);
  return `<span class="chip ${t.chip}" ${t.guess ? `title="The page does not say. This is our guess."` : ""}>${I(t.icon, 14, 2.2)}${t.label}${t.guess ? "<small>unverified</small>" : ""}</span>`;
};

// The backend cuts a reason at a fixed length, sometimes mid-word: drop a dangling scrap and say it was cut.
const tidyReason = (text) => (/[.!?)"']$/.test(text) ? text : text.replace(/\s+\S{1,2}$/, "").replace(/[,;:\s-]+$/, "") + "…");

// The same thing, small, for saved tickets.
const typeTag = (deal) => {
  const t = typeInfo(deal);
  if (!t.guess && t.chip === "unk") return "";
  return `<span class="tg ${t.chip}" ${t.guess ? `title="Unverified guess"` : ""}>${I(t.icon, 11, 2.4)}${t.guess ? t.label : t.short}</span>`;
};

function priceHtml(deal) {
  if (deal.sale_price !== null) {
    return `<div class="prices"><b class="now">${money(deal.sale_price)}</b>${deal.original_price ? `<s class="was">${money(deal.original_price)}</s>` : ""}</div>`;
  }
  if (deal.discount_text) {
    // Many promo titles are the offer itself, and a bare "40% off" is already on the photo: say it once.
    const [t, d] = [deal.title, deal.discount_text].map((x) => x.toLowerCase().replace(/[^a-z0-9%$]+/g, " ").trim());
    const bare = /^(up to |extra |save )?\$?\d[\d,.]*%?( off| back)?$/.test(d);
    const words = d.split(" ");
    const echoed = words.length >= 3 && words.filter((w) => t.includes(w)).length / words.length >= 0.7; // the title already says most of it
    return t.includes(d) || d.includes(t) || bare || echoed ? "" : `<div class="prices"><b class="now txt">${esc(deal.discount_text)}</b></div>`;
  }
  return `<div class="prices"><b class="now txt dim">Price not listed</b></div>`;
}

// Same idea as the old "unverified" chips: the quiet state looks intentional, never hidden.
const priceChip = (deal, full = false) => deal.price_verified
  ? `<span class="chip ok">${I("check", 13, 3)}${full ? "Price checked on page" : "Price checked"}</span>`
  : `<span class="chip unv">${I("tag", 13, 2.2)}Price unverified</span>`;

function cardHtml(deal, position) {
  const off = offPill(deal);
  const distance = distanceLabel(deal);
  const top = position === "top";
  const enter = top && enterNext ? " enter" : "";
  return `<article class="card ${position}${enter}" data-id="${deal.id}"${top ? "" : ` aria-hidden="true"`}>
    <div class="pp">${artHtml(deal, "", { eager: position !== "n2" })}
      <span class="pill off ${off.small ? "sm" : ""}">${esc(off.text)}</span>
      <span class="pill ends">${esc(endsText(deal))}</span>
      <div class="stamp save">Save</div><div class="stamp pass">Pass</div><div class="stamp must">Must have</div>
    </div>
    <div class="info">
      <div class="sline"><span class="sl"><span class="store">${esc(deal.store)}${distance ? ` · ${distance}` : ""}</span>${suggestedTag(deal)}</span><a class="src" data-nodrag ${top ? "" : `tabindex="-1" `}href="${esc(deal.source_url)}" target="_blank" rel="noopener"><span>${esc(sourceName(deal))}</span>${I("ext", 11, 2.4)}</a></div>
      <h2 class="ttl">${esc(deal.title)}</h2>
      ${priceHtml(deal)}
      ${deal.why ? `<div class="why">${I("spark", 14, 2)}<span>${esc(deal.why)}${deal.by_model ? `<em class="tag-tf" title="Ordered and explained by Token Factory">TF</em>` : ""}</span></div>` : ""}
      <div class="chips2">${typeChip(deal)}${priceChip(deal)}</div>
    </div>
  </article>`;
}

// The title, the filter button and the deal-type chips.
function headerHtml() {
  const c = state.constraints;
  const filtered = state.when !== "weekend" || state.storeScope !== "all" || c.budgetCap !== null || c.maxDistanceMiles !== 30;
  const chips = typeChoices.map(([key, label]) =>
    `<button class="tc ${state.typeFilter === key ? "on" : ""}" data-act="type:${key}" aria-pressed="${state.typeFilter === key}">${label}</button>`).join("");
  return `<header class="hdr"><div class="hl"><span class="live"><i></i>Live deals</span><h1 class="disp">Black Friday</h1></div>
      <button class="fbtn ${filtered ? "on" : ""}" data-act="menu" aria-label="Filter deals" aria-haspopup="dialog" aria-expanded="${state.menuOpen}">${fillIcon("sliders", 24)}</button></header>
    <div class="chiprow" role="group" aria-label="Deal type">${chips}</div>`;
}

// The filter button opens this: which part of the sale to look at, with how many deals each has.
function sheetHtml(windows) {
  const rows = windowOrder.map((key) => `<button class="wopt ${key === state.when ? "on" : ""}" data-act="when:${key}" aria-pressed="${key === state.when}">
      <span class="wt"><b>${windows[key].label}</b><small>${windows[key].range}</small></span>
      <span class="ct">${state.counts[key]?.shown ?? 0}</span><span class="rd">${key === state.when ? I("check", 13, 3.4) : ""}</span></button>`).join("");
  return `<div class="sheetbg"><div class="sheet" role="dialog" aria-label="Filter deals"><div class="grab"></div>
      <h2 class="disp">Filter deals</h2><p class="sub sm">Pick the part of the sale and which stores to look at. Budget and distance live in your profile.</p>
      <span class="lbl meta">When</span>${rows}
      <span class="lbl meta">Stores</span>
      <div class="seg" role="group" aria-label="Which stores">${scopeChoices.map(([key, label]) => `<button class="${state.storeScope === key ? "on" : ""}" data-act="scope:${key}" aria-pressed="${state.storeScope === key}">${label}</button>`).join("")}</div>
      <div class="row"><button class="btn" data-act="clearLimits">Clear limits</button><button class="btn pri" data-act="menuClose">Done</button></div></div></div>`;
}

const radarHtml = `<div class="radar"><i></i><i></i><i></i><b></b></div>`;

function waitingHtml() {
  return `<div class="empty">${radarHtml}<h2 class="disp">Finding deals</h2><p>Picking cards for you.</p></div>`;
}

function emptyHtml(windows) {
  const keysOk = state.keys.tavily && state.keys.tokenFactory;
  if (state.searching) {
    return `<div class="empty">${radarHtml}<h2 class="disp">Hunting</h2>
      <p>Finding deals near ${esc(state.place?.name ?? "you")}. The first ones usually show up within a couple of minutes.</p>
      <button class="btn pri" data-act="tab:search">Watch progress</button>${poweredByHtml()}</div>`;
  }
  if (!state.hasDeals) {
    if (!state.place) {
      return `<div class="empty">${radarHtml}<h2 class="disp">Where are you?</h2>
        <p>Pick a city to find deals and stores near you.</p>
        <button class="btn pri" data-act="tab:search">${I("pin", 16, 2.4)}Pick a city</button>${poweredByHtml()}</div>`;
    }
    const action = keysOk
      ? `<button class="btn pri" data-act="startSearch">${I("search", 16, 2.4)}Find deals</button>`
      : `<p class="meta">Finding deals needs TAVILY_API_KEY and NEBIUS_API_KEY in .env.</p><button class="btn pri" data-act="tab:search">See setup</button>`;
    return `<div class="empty">${radarHtml}<h2 class="disp">No deals near ${esc(state.place.city)} yet</h2>
      <p>We search the stores you picked, plus a few we think you will like, and find the branches near ${esc(state.place.name)}.</p>${action}${poweredByHtml()}</div>`;
  }
  const label = windows[state.when].label;
  // Cards held back by a limit that was just changed count too, before the server's numbers arrive.
  const hidden = Math.max(state.counts[state.when]?.hidden ?? 0, state.buffer.length - deckCards().length);
  const widerKey = windowOrder.slice(windowOrder.indexOf(state.when) + 1).find((key) => state.counts[key]?.shown > 0);
  const widen = widerKey
    ? `<button class="btn pri block" data-act="when:${widerKey}">Widen to ${windows[widerKey].label} · ${state.counts[widerKey].shown} new</button>`
    : `<p class="meta">That is every window.</p>`;
  const limited = hidden > 0
    ? `<p>${hidden} deal${hidden > 1 ? "s" : ""} for ${label} ${hidden > 1 ? "are" : "is"} hidden by your limits: deal type, distance or budget.</p>
       <button class="btn block" data-act="clearLimits">Clear limits</button>`
    : `<p>You have swiped through everything for ${label}. Run a new search to find more.</p>`;
  return `<div class="empty">${radarHtml}<h2 class="disp">Nothing new yet</h2>${limited}${widen}
    <button class="btn block" data-act="tab:search">${I("search", 16, 2.4)}Find more deals</button>${poweredByHtml()}</div>`;
}

// Shown over a populated deck while a search is still adding deals in the background.
const stripText = () => {
  const added = state.pipeline?.imported?.added ?? 0;
  return added ? `Still hunting · ${added} deals found so far` : "Still hunting for more deals";
};
const stripHtml = () => `<button class="strip" data-act="tab:search" data-strip><i class="beat"></i><span>${esc(stripText())}</span></button>`;
function paintStrip() {
  const el = root.querySelector("[data-strip] span");
  if (el) el.textContent = stripText();
}

function deckHtml(windows) {
  const cards = deckCards();
  const off = cards.length ? "" : "disabled";
  const stack = cards.length
    ? [2, 1, 0].filter((i) => cards[i]).map((i) => cardHtml(cards[i], ["top", "n1", "n2"][i])).join("")
    : state.refilling ? waitingHtml() : emptyHtml(windows);
  const openDeal = cards[0]
    ? `<a class="db s" href="${esc(cards[0].source_url)}" target="_blank" rel="noopener" aria-label="Open this deal in the store">${fillIcon("open", 22)}</a>`
    : `<button class="db s" disabled aria-label="Open this deal in the store">${fillIcon("open", 22)}</button>`;
  return `${headerHtml()}
    ${state.searching && cards.length ? stripHtml() : ""}
    <div class="deckwrap">${stack}</div>
    <div class="dock">
      <button class="db s" data-act="undo" aria-label="Undo" ${state.canUndo ? "" : "disabled"}>${fillIcon("undo", 20)}</button>
      <button class="db l pass" data-act="swipe:left" aria-label="Pass on this deal" ${off}>${fillIcon("close", 28)}</button>
      <button class="db xl save" data-act="swipe:right" aria-label="Save this deal" ${off}>${fillIcon("heart", 36)}</button>
      <button class="db l must" data-act="swipe:up" aria-label="Mark as a must-have" ${off}>${fillIcon("star", 28)}</button>
      ${openDeal}
    </div>`;
}

// ---------- saved list ----------

function ticketHtml(deal, gotTab) {
  const expired = isExpired(deal);
  const price = deal.sale_price !== null
    ? `${money(deal.sale_price)}${deal.original_price ? ` <s>${money(deal.original_price)}</s>` : ""}`
    : deal.discount_text ? esc(deal.discount_text) : "Price not listed";
  const map = isInStore(deal) && mapUrl(deal);
  const open = `<a href="${esc(deal.source_url)}" target="_blank" rel="noopener">${I("ext", 12, 2.6)}Open deal</a>`;
  const buttons = gotTab
    ? `${open}${deal.done === "loved" ? "" : `<button class="lv" data-act="done:${deal.id}:loved">${I("heart", 12, 2.6)}Loved it</button>`}`
    : `${expired ? "" : `<a href="/api/deals/${deal.id}.ics" download>${I("cal", 12, 2.6)}Reminder</a>`}
       ${map ? `<a href="${esc(map)}" target="_blank" rel="noopener">${I("pin", 12, 2.6)}Map</a>` : ""}${open}
       <button class="lv" data-act="done:${deal.id}:got">${I("check", 12, 3)}Got it</button>`;
  const corner = gotTab
    ? `<div class="stampd disp">${deal.done === "loved" ? "Loved it" : "Got it"}</div>`
    : `<div class="mu">
         <button class="${deal.fav ? "on" : ""}" data-act="fav:${deal.id}" aria-label="${deal.fav ? "Remove must-have" : "Mark as must-have"}" aria-pressed="${Boolean(deal.fav)}">${I("star", 15, 2.2, deal.fav ? "currentColor" : "none")}</button>
         <button data-act="unsave:${deal.id}" aria-label="Remove from saved">${I("x", 15, 2.6)}</button>
       </div>`;
  return `<div class="tk ${gotTab ? "got" : expired ? "ended" : ""}">
    <button class="th" data-act="expand:${deal.id}" aria-label="Details">${artHtml(deal, "mini")}</button>
    <div class="tb">
      <button class="tt disp" data-act="expand:${deal.id}">${esc(deal.title)}</button>
      <div class="ts pr"><b>${price}</b>${typeTag(deal)}</div>
      <div class="ts ${expired && !gotTab ? "bad" : ""}">${esc(windowLine(deal))}</div>
      <div class="ta meta">${buttons}</div>
    </div>${corner}</div>`;
}

function storeGroupsHtml(list, gotTab) {
  const stores = [...new Set(list.map((d) => d.store))];
  return stores.map((store) => {
    const deals = list.filter((d) => d.store === store).sort((a, b) => b.fav - a.fav);
    const near = deals.find((d) => isInStore(d) && d.nearest_store);
    const where = near
      ? `<a class="sw" href="${esc(mapUrl(near))}" target="_blank" rel="noopener">${I("pin", 12, 2.6)}${esc([near.nearest_store.name, near.nearest_store.address].filter(Boolean).join(" · "))}</a>`
      : "";
    return `<div class="sg"><span class="sgl"><b class="disp">${esc(store)}</b>${suggestedTag(deals[0])}</span><span class="meta">${deals.length} ${deals.length === 1 ? "deal" : "deals"}</span></div>${where}${deals.map((d) => ticketHtml(d, gotTab)).join("")}`;
  }).join("");
}

function savedHtml() {
  const pending = toGet();
  const got = gotIt();
  let body;
  if (state.savedTab === "got") {
    body = got.length
      ? storeGroupsHtml(got, true)
      : `<div class="hint">${I("check", 18)}<span>Mark deals you picked up as "Got it". "Loved it" is the strongest signal we get.</span></div>`;
  } else {
    body = pending.length
      ? storeGroupsHtml(pending, false)
      : `<div class="hint">${I("bookmark", 18)}<span>Nothing saved yet. Swipe right on something good.</span></div>`;
  }
  return `<div class="ph"><div><h1 class="disp">Saved</h1><p>${pending.length} to get · ${got.length} got</p></div>
      <button class="btn sm pri" data-act="shareList">${I("share", 15, 2.6)}Share list</button></div>
    <div class="tabs">
      <button class="${state.savedTab === "toget" ? "on" : ""}" data-act="savedTab:toget">To get · ${pending.length}</button>
      <button class="${state.savedTab === "got" ? "on" : ""}" data-act="savedTab:got">Got it · ${got.length}</button>
    </div>
    <div class="page">${body}<div class="pwrap">${poweredByHtml()}</div></div>`;
}

function tasteScreenHtml() {
  if (!state.taste) return `<div class="ph"><div><h1 class="disp">Profile</h1><p>Loading.</p></div></div><div class="page"></div>`;
  return tasteHtml(state.taste, state.tasteUi, state.pipeline?.models, { defaultStores: state.defaultStores, suggestedStores: state.suggestedStores, blockedStores: state.blockedStores });
}

// ---------- details ----------

const claimRows = [["price", "Price"], ["type", "Deal type"], ["dates", "Dates"]];

function detailHtml(deal) {
  const isTop = deckCards()[0]?.id === deal.id;
  const expired = isExpired(deal);
  const distance = distanceLabel(deal);
  const off = offPill(deal);
  const map = isInStore(deal) && mapUrl(deal);
  const near = deal.nearest_store;
  const kind = effectiveType(deal);
  const branch = near
    ? `${esc(near.name)}${near.address ? `<br><span class="mut">${esc(near.address)}</span>` : ""}`
    : kind === null ? "Not listed on the page" : "Nearest branch not found yet";
  const where = kind === "online"
    ? deal.deal_type ? "Online" : `Probably online<br><span class="mut">The page does not say.</span>`
    : `${branch}${map ? `<br><a href="${esc(map)}" target="_blank" rel="noopener">Open in maps</a>` : ""}`;
  const dates = deal.valid_from && deal.valid_to && deal.valid_from !== deal.valid_to ? `${fmtDay(deal.valid_from)} to ${fmtDay(deal.valid_to)}` : "";
  const verifyRows = claimRows.map(([key, label]) => {
    const claim = deal.claims?.[key];
    const ok = claim?.status === "verified" && claim.quote;
    const chip = ok ? `<span class="chip ok">${I("check", 13, 3)}${label} checked</span>` : `<span class="chip unv">${I("tag", 13, 2.2)}${label} unverified</span>`;
    return `<div class="fcr">${chip}<q class="${ok ? "" : "nq"}">${esc(ok ? claim.quote : "The page does not say. Double-check before you go.")}</q></div>`;
  }).join("");
  const cta = isTop
    ? `<button class="db l pass" data-act="swipe:left" aria-label="Pass on this deal">${fillIcon("close", 26)}</button>
       <button class="db xl save" data-act="swipe:right" aria-label="Save this deal">${fillIcon("heart", 34)}</button>
       <button class="db l must" data-act="swipe:up" aria-label="Mark as a must-have">${fillIcon("star", 26)}</button>`
    : `${expired ? "" : `<a class="btn pri" style="flex:1" href="/api/deals/${deal.id}.ics" download>${I("cal", 17, 2.2)}Reminder</a>`}
       <a class="btn" style="flex:1" href="${esc(deal.source_url)}" target="_blank" rel="noopener">${I("ext", 17, 2.2)}Open deal</a>`;
  return `<div class="det"><div class="dscroll">
      <div class="dhero"><div class="pp">${artHtml(deal, "", { eager: true })}<span class="pill off ${off.small ? "sm" : ""}">${esc(off.text)}</span></div>
        <button class="back" data-act="close" aria-label="Back">${I("left", 22, 2.4)}</button></div>
      <div class="dbody">
        <div class="chips2" style="margin:0 0 4px">${typeChip(deal)}${priceChip(deal, true)}</div>
        ${!deal.deal_type && deal.inferred_type && deal.inferred_reason ? `<p class="gwhy"><b>Why we think so</b>${esc(tidyReason(deal.inferred_reason))}</p>` : ""}
        <div class="dk-kick sl" style="margin-top:16px"><span>${esc(deal.store)}</span>${suggestedTag(deal)}</div>
        <h2 class="disp ${deal.title.length > 90 ? "xl" : deal.title.length > 55 ? "lg" : ""}">${esc(deal.title)}</h2>
        <div class="dprice">${priceHtml(deal)}</div>
        <div class="kv">
          <span class="k meta">When</span><span>${esc(windowLine(deal))}${dates ? `<br><span class="mut">${esc(dates)}</span>` : ""}</span>
          <span class="k meta">Where</span><span>${where}</span>
          ${deal.suggested ? `<span class="k meta">Why this store</span><span>${esc(deal.suggestion_reason || "A store you did not pick that fits what you like.")}<br><span class="mut">Not one of your stores.</span></span>` : ""}
          ${distance ? `<span class="k meta">Distance</span><span>${distance}</span>` : ""}
          ${deal.code ? `<span class="k meta">Code</span><span class="code"><code>${esc(deal.code)}</code><button class="btn sm" data-act="copy:${deal.id}">${I("copy", 13, 2.2)}Copy</button></span>` : ""}
          <span class="k meta">Source</span><span><a href="${esc(deal.source_url)}" target="_blank" rel="noopener">${esc(sourceName(deal))}</a></span>
        </div>
        ${deal.why ? `<div class="why dk">${I("spark", 16, 2)}<span>${esc(deal.why)}</span></div>` : ""}
        <div class="meta mut">Checked against the page by Token Factory · ${esc(seenLabel(deal))}</div><div class="fc">${verifyRows}</div>
        ${photoUsable(deal) ? `<p class="credit meta mut">Photo: ${esc(hostOf(deal.image_url))}</p>` : ""}
      </div></div>
      <div class="dcta">${cta}</div></div>`;
}

function errorHtml() {
  return `<div class="empty"><h2 class="disp">Can't load deals</h2><p>${esc(state.loadError)}</p>
    <button class="btn pri" data-act="retry">Try again</button></div>`;
}

function navHtml() {
  const count = toGet().length;
  const tabs = [["deck", "Deals", "tag"], ["saved", "Saved", "heart"], ["search", "Search", "search"], ["taste", "Profile", "person"]];
  return `<nav class="nav" aria-label="Main">${tabs.map(([key, label, ic]) =>
    `<button class="${state.tab === key ? "on" : ""}" data-act="tab:${key}" ${state.tab === key ? `aria-current="page"` : ""}>${fillIcon(ic, 24)}<span>${label}</span>${key === "saved" ? `<span class="n" aria-label="${count} saved">${count}</span>` : ""}</button>`).join("")}</nav>`;
}

// ---------- rendering ----------

// Every redraw rebuilds the screen, so the scrollers remember where they were. Only while the person stays on the same
// screen: a new tab or onboarding step starts at the top.
const SCROLLERS = [".page", ".obbody", ".dscroll"];
let lastScreen = null;

function render() {
  const windows = dealWindows();
  const screen = state.onboarded ? `${state.tab}:${state.expanded ?? ""}` : `ob${state.ob.step}`;
  const scrolled = screen === lastScreen ? SCROLLERS.map((sel) => [sel, root.querySelector(sel)?.scrollTop ?? 0]) : [];
  lastScreen = screen;
  let html;
  if (state.loadError) {
    html = errorHtml();
  } else if (state.booting) {
    html = waitingHtml();
  } else if (!state.onboarded) {
    html = onboardingHtml(state.ob, state, state.picker);
  } else {
    html = state.tab === "deck" ? deckHtml(windows)
      : state.tab === "saved" ? savedHtml()
        : state.tab === "search" ? searchScreenHtml(state, state.pipeline, state.searchUi, state.picker) : tasteScreenHtml();
    html += navHtml();
    const open = state.expanded && findDeal(state.expanded);
    if (open) html += detailHtml(open);
    if (state.menuOpen && state.tab === "deck") html += sheetHtml(windows);
  }
  enterNext = false;
  if (state.tab === "deck" && state.onboarded) preloadPhotos(deckCards().slice(0, 5));
  root.innerHTML = html;
  for (const [sel, top] of scrolled) {
    const el = root.querySelector(sel);
    if (el) el.scrollTop = top;
  }
  if (state.onboarded && !state.booting && state.tab === "deck") wireDeck();
}

// ---------- the deck: swiping ----------

function showIntent(card, direction, strength) {
  for (const [dir, stamp] of Object.entries({ right: "save", left: "pass", up: "must" })) {
    const el = card.querySelector(`.stamp.${stamp}`);
    if (el) el.style.opacity = dir === direction ? Math.min(1, strength) : 0;
  }
}

// A profile rewrite finishes in the background. The next swipe's answer carries the new version.
function noticeProfileVersion(version) {
  if (state.profileVersion !== null && version > state.profileVersion) toast("Profile updated");
  state.profileVersion = version;
}

async function swipe(direction) {
  const card = deckCards()[0];
  if (!card || swiping) return;
  swiping = true;
  try {
    if (state.expanded) {
      state.expanded = null;
      render();
    }
    const el = root.querySelector(".card.top");
    showIntent(el, direction, 1);
    let sent;
    try {
      [, sent] = await Promise.all([
        flyAway(el, direction),
        api("POST", "/api/swipes", { dealId: card.id, action: actionFor[direction], source: card.source }),
      ]);
    } catch (err) {
      toast(err.message);
      // The server already has a swipe for this deal, so the card must go or it would be stuck on top.
      if (err.status === 409) state.buffer = state.buffer.filter((c) => c.id !== card.id);
      render();
      return;
    }
    state.buffer = state.buffer.filter((c) => c.id !== card.id);
    state.history.push(card);
    if (direction === "right" && !celebrate(root.parentElement)) toast("Saved to your list"); // confetti, or the toast when motion is reduced
    if (direction === "up") toast("Marked as a must-have");
    noticeProfileVersion(sent.profileVersion);
    await load();
    refillIfLow();   // before the redraw, so an emptied deck shows "finding deals", not "nothing new"
    enterNext = true;
    render();
  } finally {
    swiping = false;
  }
}

async function undo() {
  if (swiping || !state.canUndo) return;
  let result;
  try {
    result = await api("POST", "/api/swipes/undo");
  } catch (err) {
    toast(err.message);
    return;
  }
  state.constraints = result.constraints;
  // Bring back the card exactly as it was, with its why line. After a reload the server's copy is all there is.
  const card = state.history.find((c) => c.id === result.card.id) ?? result.card;
  state.history = state.history.filter((c) => c.id !== card.id);
  // Make sure the restored card is in the window the user is looking at.
  const windows = dealWindows();
  if (!inWindow(card, windows[state.when])) {
    state.when = windowOrder.find((key) => inWindow(card, windows[key])) ?? state.when;
    state.buffer = [];
    await send("PUT", "/api/user", { when: state.when });
  }
  state.buffer = [card, ...state.buffer.filter((c) => c.id !== card.id)];
  state.exhausted = false;
  toast("Undone");
  await load();
  enterNext = true;
  render();
}

// ---------- context bar ----------

async function setWhen(key) {
  state.when = key;
  state.menuOpen = false;
  await send("PUT", "/api/user", { when: key });
  await Promise.all([load(), restartDeck()]);
  render();
}

async function setTypeFilter(key) {
  if (state.typeFilter === key) return;
  state.typeFilter = key;
  state.exhausted = false;
  render(); // the buffered cards are re-filtered right now
  await send("PUT", "/api/user", { typeFilter: key });
  await load();
  refillIfLow();
  render();
}

async function setStoreScope(key) {
  if (state.storeScope === key) return;
  state.storeScope = key;
  state.menuOpen = false;
  state.exhausted = false;
  await send("PUT", "/api/user", { storeScope: key });
  await Promise.all([load(), restartDeck()]);
  render();
}

async function clearLimits() {
  await send("PUT", "/api/profile", { maxDistanceMiles: 30, budgetCap: null });
  await send("PUT", "/api/user", { typeFilter: "all", storeScope: "all" });
  await load();
  await restartDeck();
}

// ---------- the deck gestures ----------

function wireDeck() {
  const card = root.querySelector(".card.top");
  if (!card) return;
  const next = root.querySelector(".card.n1");
  const after = root.querySelector(".card.n2");
  attachSwipe(card, {
    onMove(dx, dy, intent) {
      if (swiping) return;
      card.style.animation = "none";
      card.style.transition = "none";
      card.style.transform = `translate(${dx}px,${dy}px) rotate(${dx / 24}deg)`;
      const pull = Math.hypot(dx, dy);
      showIntent(card, intent, pull / 120);
      const k = Math.min(1, pull / 180);
      // The cards behind move up one step as the top one leaves.
      if (next) {
        next.style.transition = "none";
        next.style.transform = `translateY(${12 - 12 * k}px) scale(${0.95 + 0.05 * k})`;
      }
      if (after) {
        after.style.transition = "none";
        after.style.transform = `translateY(${24 - 12 * k}px) scale(${0.9 + 0.05 * k})`;
        after.style.opacity = String(0.7 + 0.3 * k);
      }
    },
    onRelease(direction) {
      if (swiping) return;
      if (direction) return swipe(direction);
      card.style.transition = "transform .45s cubic-bezier(.2,1.5,.4,1)";
      card.style.transform = "";
      showIntent(card, null, 0);
      for (const el of [next, after]) {
        if (!el) continue;
        el.style.transition = "transform .3s ease-out, opacity .3s ease-out";
        el.style.transform = "";
        el.style.opacity = "";
      }
    },
    onTap() {
      if (swiping) return;
      state.expanded = Number(card.dataset.id);
      render();
    },
  });
}

// ---------- onboarding ----------

function getPosition() {
  return new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 10_000, maximumAge: 600_000 }));
}

// Asks the browser for the position and stores it as the one home point. Throws when it is denied.
async function useDeviceLocation() {
  const { coords } = await getPosition();
  await api("PUT", "/api/user", { home: { lat: coords.latitude, lon: coords.longitude } });
  state.hasHome = true;
}

async function askLocationInOnboarding() {
  state.ob.loc = "asking";
  render();
  try {
    await useDeviceLocation();
    state.ob.loc = "granted";
  } catch {
    state.ob.loc = "denied";
  }
  render();
}

// Adds a typed store name to a list, reusing a suggestion's exact spelling when it matches one.
const MAX_STORES = 12; // the server refuses a longer list, so the buttons stop here with a message instead of failing the save
const tooManyStores = () => toast(`You can pick up to ${MAX_STORES} stores. Remove one to add another.`);

function withStore(list, text) {
  const name = text.trim().replace(/\s+/g, " ");
  if (!name) return list;
  const suggested = state.storeOptions.map((s) => s.name).find((n) => n.toLowerCase() === name.toLowerCase());
  const final = suggested ?? name;
  if (list.some((n) => n.toLowerCase() === final.toLowerCase())) return list;
  if (list.length >= MAX_STORES) {
    tooManyStores();
    return list;
  }
  return [...list, final];
}

async function finishOnboarding() {
  const { stores, typeFilter, budget, answer, vibes, place } = state.ob;
  state.ob.busy = true;
  render();
  try {
    await api("PUT", "/api/user", { stores, typeFilter, onboarded: true, ...(place ? { place } : {}) });
    if (budget !== null) await api("PUT", "/api/profile", { budgetCap: budget });
    // Skipped prompts send nothing. If the model is down the server still turns the picked vibes into weights.
    if (answer.trim() || vibes.length) await api("POST", "/api/onboarding/parse", { answer: answer.trim(), vibes });
  } catch (err) {
    state.ob.busy = false;
    toast(err.message);
    render();
    return;
  }
  state.booting = true;
  render();
  await load();
  state.booting = false;
  // A new city has no deals yet: go and fetch some, or show how to set the keys up.
  if (state.place && !state.hasDeals) {
    if (state.keys.tavily && state.keys.tokenFactory) return startSearch();
    state.tab = "search";
    render();
    loadPipeline();
    return;
  }
  await restartDeck();
}

// ---------- the city picker ----------

function paintPlaceResults() {
  const el = root.querySelector("[data-place-results]");
  if (el) el.innerHTML = placeResultsHtml(state.picker);
}

// Redraws only the results under the box, so typing never loses focus. Old answers are ignored.
async function runPlaceSearch() {
  clearTimeout(placeTimer);
  const picker = state.picker;
  const query = picker.query.trim();
  if (query.length < 2) {
    Object.assign(picker, { results: [], status: "idle" });
    return paintPlaceResults();
  }
  const mine = ++placeSeq;
  picker.status = "loading";
  paintPlaceResults();
  try {
    const { places } = await api("GET", `/api/places?q=${encodeURIComponent(query)}`);
    if (mine !== placeSeq) return;
    Object.assign(picker, { results: places, status: places.length ? "ok" : "empty" });
  } catch (err) {
    if (mine !== placeSeq) return;
    Object.assign(picker, { results: [], status: "error", error: err.message });
  }
  paintPlaceResults();
}

async function choosePlace(index) {
  const place = state.picker.results[index];
  if (!place || !(await send("PUT", "/api/user", { place }))) return;
  state.searchUi.changing = false;
  state.picker = newPicker("pickPlace");
  state.exhausted = false;
  await load();
  toast(`Hunting near ${place.name}`);
  render();
  restartDeck();
}

// ---------- the search tab ----------

// Deals the server has imported so far in the current search (null until the first poll, which adopts the number).
let seenImported = null;
let leaveSearchOnFirstDeals = false;

// Polls while a search runs, on any tab: the search hands deals over in batches and the deck takes them as they land.
async function loadPipeline() {
  clearTimeout(searchTimer);
  const wasSearching = state.searching;
  try {
    state.pipeline = await api("GET", "/api/pipeline");
  } catch (err) {
    toast(err.message);
    return;
  }
  state.searching = state.pipeline.running;
  const added = state.pipeline.imported?.added ?? 0;
  if (state.tab === "search") render();
  else paintStrip();
  if (seenImported === null) seenImported = added;
  else if (added > seenImported) {
    seenImported = added;
    await newDealsArrived();
  }
  if (state.pipeline.running) {
    searchTimer = setTimeout(loadPipeline, state.tab === "search" ? 1500 : 3000);
  } else if (wasSearching) {
    await load();
    toast(state.pipeline.error ? "The search did not finish" : state.pipeline.summary ?? "Search finished");
    await newDealsArrived();
    render(); // the strip goes away
  }
}

// A batch was imported. Bring it into the deck without throwing the buffer away, so a card being swiped stays put.
async function newDealsArrived() {
  await load();
  state.exhausted = false;
  if (leaveSearchOnFirstDeals && state.tab === "search" && state.hasDeals) {
    leaveSearchOnFirstDeals = false;
    state.tab = "deck";
    toast("First deals are in. More are on the way.");
    render();
  }
  if (deckCards().length < REFILL_BELOW * 2) await refill();
}

async function startSearch() {
  try {
    await api("POST", "/api/pipeline/start");
  } catch (err) {
    toast(err.message);
    if (err.status !== 409) {
      state.tab = "search";
      render();
      loadPipeline();
      return;
    }
  }
  state.tasteUi.storesDirty = false;
  seenImported = 0;
  leaveSearchOnFirstDeals = deckCards().length === 0; // a first search: go to the cards as soon as there are some
  state.tab = "search";
  state.expanded = null;
  state.searching = true;
  state.pipeline = { ...(state.pipeline ?? {}), running: true, step: "search", error: null, summary: null, log: [], trace: null };
  render();
  loadPipeline();
}

// ---------- taste view ----------

async function loadTaste() {
  clearTimeout(tasteTimer);
  try {
    state.taste = await api("GET", "/api/profile");
    if (!state.pipeline) state.pipeline = await api("GET", "/api/pipeline").catch(() => null); // only for the model names
  } catch (err) {
    toast(err.message);
    return;
  }
  state.profileVersion = state.taste.version;
  await load(); // the suggested and muted store lists live in the state
  render();
  // A rewrite that is still running finishes in a few seconds: look again.
  if (state.taste.update.running && state.tab === "taste") tasteTimer = setTimeout(() => !state.tasteUi.editing && loadTaste(), 2000);
}

async function saveNarrative() {
  const text = root.querySelector("[data-narr]").value.trim();
  if (!text) return toast("The summary can't be empty. Use Reset profile to start over.");
  if (await send("PUT", "/api/profile", { narrative: text })) toast("Saved. Your wording is kept");
  state.tasteUi.editing = false;
  await loadTaste();
}

async function setLimit(limit) {
  const result = await send("PUT", "/api/profile", limit);
  if (result) {
    state.constraints = result.constraints;
    state.exhausted = false;
  }
  await load();
  refillIfLow();
  await loadTaste();
}

// The person's own stores, or the defaults when they have none. Any change makes "find deals" worth offering.
const currentStores = () => (state.taste?.constraints.stores?.length ? state.taste.constraints.stores : state.defaultStores);

async function setStores(names) {
  const list = [...new Set(names)].slice(0, MAX_STORES);
  state.tasteUi.customStore = "";
  if (!(await send("PUT", "/api/user", { stores: list }))) return;
  state.tasteUi.storesDirty = true;
  state.exhausted = false;
  await load();
  await loadTaste();
  root.querySelector("[data-store-q]")?.focus();
}

// "Add" on a suggested store: it joins the person's stores, and its deals stop being suggestions.
async function addSuggested(index) {
  const store = state.suggestedStores[index];
  if (!store) return;
  if (!currentStores().includes(store.name) && currentStores().length >= MAX_STORES) return tooManyStores();
  if (!(await send("PUT", "/api/user", { stores: [...new Set([...currentStores(), store.name])] }))) return;
  toast(`${store.name} added to your stores`);
  state.exhausted = false;
  await load();
  await loadTaste();
  restartDeck();
}

async function unmuteStore(slug) {
  const left = state.blockedStores.filter((s) => s.slug !== slug).map((s) => s.slug);
  if (!(await send("PUT", "/api/user", { blockedStores: left }))) return;
  toast("Store unmuted");
  state.exhausted = false;
  await load();
  await loadTaste();
  restartDeck();
}

async function resetProfile() {
  state.tasteUi.confirmReset = false;
  if (await send("POST", "/api/profile/reset")) toast("Profile reset");
  state.taste = null;
  await load();
  render();
  await loadTaste();
  restartDeck();
}

async function setLocation(on) {
  try {
    if (on) await useDeviceLocation();
    else await api("PUT", "/api/user", { home: null });
  } catch (err) {
    toast(on ? "The browser blocked location. Distances stay hidden." : err.message);
    return;
  }
  toast(on ? "Location on. Distances are back" : "Location off. Distances hidden");
  await load();
  await loadTaste();
  restartDeck(); // the buffered cards carry distances from the old home point
}

// ---------- saved list ----------

async function copyShareText() {
  const deals = toGet();
  if (deals.length === 0) return toast("Nothing saved yet");
  const lines = ["My Black Friday list"];
  for (const store of [...new Set(deals.map((d) => d.store))]) {
    lines.push("", store.toUpperCase());
    for (const d of deals.filter((x) => x.store === store).sort((a, b) => b.fav - a.fav)) {
      const price = d.sale_price !== null ? ` · ${money(d.sale_price)}${d.original_price ? ` (was ${money(d.original_price)})` : ""}` : d.discount_text ? ` · ${d.discount_text}` : "";
      lines.push(`- ${d.title}${d.fav ? " (must have)" : ""}${price} · ${typeInfo(d).short} · ${windowLine(d)}`, `  ${d.source_url}`);
    }
  }
  try {
    await navigator.clipboard.writeText(lines.join("\n"));
    toast("List copied. Paste it to a friend");
  } catch {
    toast("Couldn't copy. The browser blocked clipboard access");
  }
}

async function copyCode(id) {
  const code = findDeal(id)?.code;
  if (!code) return;
  try {
    await navigator.clipboard.writeText(code);
    toast(`Copied ${code}`);
  } catch {
    toast("Couldn't copy. The browser blocked clipboard access");
  }
}

// ---------- input ----------

document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-act]");
  if (state.menuOpen && !e.target.closest(".sheet, .fbtn")) {
    state.menuOpen = false;
    render();
  }
  if (!el) return;
  const [act, arg, extra] = el.dataset.act.split(":");
  const id = Number(arg);
  const ob = state.ob;
  switch (act) {
    case "menu": state.menuOpen = !state.menuOpen; render(); break;
    case "menuClose": state.menuOpen = false; render(); break;
    case "when": setWhen(arg); break;
    case "type": setTypeFilter(arg); break;
    case "scope": setStoreScope(arg); break;
    case "storeSuggest": addSuggested(id); break;
    case "unmute": unmuteStore(arg); break;
    case "tab":
      state.tab = arg;
      state.expanded = null;
      state.tasteUi = { ...state.tasteUi, editing: false, confirmReset: false };
      clearTimeout(searchTimer);
      if (arg === "taste") state.taste = null;
      if (arg === "search") {
        state.picker = newPicker("pickPlace");
        state.searchUi.changing = false;
      }
      render();
      if (arg === "taste") loadTaste();
      if (arg === "search") loadPipeline();
      break;
    case "startSearch": startSearch(); break;
    case "changeCity": state.searchUi.changing = !state.searchUi.changing; state.picker = newPicker("pickPlace"); render(); break;
    case "pickPlace": choosePlace(id); break;
    case "placeSearch": runPlaceSearch(); break;
    case "savedTab": state.savedTab = arg; render(); break;
    case "swipe": swipe(arg); break;
    case "undo": undo(); break;
    case "clearLimits": state.menuOpen = false; clearLimits(); break;
    case "expand": state.expanded = id; render(); break;
    case "close": state.expanded = null; render(); break;
    case "copy": copyCode(id); break;
    case "unsave": change("DELETE", `/api/saved/${id}`, undefined, "Removed from saved"); break;
    case "fav": change("PATCH", `/api/saved/${id}`, { fav: !findDeal(id).fav }); break;
    case "done": change("PATCH", `/api/saved/${id}`, { done: extra }, extra === "loved" ? "Logged: got it, loved it" : "Marked as got it"); break;
    case "shareList": copyShareText(); break;
    case "retry": load().then(render); break;
    // onboarding
    case "obNext": ob.step += 1; render(); break;
    case "obBack": ob.step -= 1; render(); break;
    case "obPlace": ob.place = state.picker.results[id] ?? null; render(); break;
    case "obPlaceClear": ob.place = null; state.picker = newPicker("obPlace"); render(); break;
    case "obLoc": askLocationInOnboarding(); break;
    case "obStore": {
      const name = obStoreNames(state, ob).all[id];
      if (!ob.stores.includes(name) && ob.stores.length >= MAX_STORES) {
        tooManyStores();
        break;
      }
      ob.stores = ob.stores.includes(name) ? ob.stores.filter((n) => n !== name) : [...ob.stores, name];
      render();
      break;
    }
    case "obStoreAdd":
      ob.stores = withStore(ob.stores, ob.customStore);
      ob.customStore = "";
      render();
      root.querySelector("[data-store-q]")?.focus();
      break;
    case "obEx": ob.answer = el.dataset.text; render(); break;
    case "obVibe": ob.vibes = ob.vibes.includes(arg) ? ob.vibes.filter((v) => v !== arg) : [...ob.vibes, arg]; render(); break;
    case "obMode": ob.typeFilter = arg; render(); break;
    case "obBudget": ob.budget = arg === "any" ? null : Number(arg); render(); break;
    case "obDefaults": finishOnboarding(); break;
    case "obFinish": finishOnboarding(); break;
    // taste view
    case "editNarr": state.tasteUi.editing = true; render(); root.querySelector("[data-narr]").focus(); break;
    case "saveNarr": saveNarrative(); break;
    case "cancelNarr": state.tasteUi.editing = false; render(); break;
    case "budget": setLimit({ budgetCap: arg === "any" ? null : Number(arg) }); break;
    case "storeDel": setStores(currentStores().filter((_, i) => i !== id)); break;
    case "storeAdd": setStores(withStore(currentStores(), state.tasteUi.customStore)); break;
    case "locOn": setLocation(true); break;
    case "locOff": setLocation(false); break;
    case "resetAsk": state.tasteUi.confirmReset = true; render(); break;
    case "resetNo": state.tasteUi.confirmReset = false; render(); break;
    case "resetYes": resetProfile(); break;
  }
});

// Typing in a box must not redraw the screen under the cursor, so these only copy the value into state.
document.addEventListener("input", (e) => {
  if (e.target.matches("[data-ans]")) state.ob.answer = e.target.value;
  if (e.target.matches("[data-store-q]")) {
    if (state.onboarded) state.tasteUi.customStore = e.target.value;
    else state.ob.customStore = e.target.value;
  }
  if (e.target.matches("[data-place-q]")) {
    state.picker.query = e.target.value;
    clearTimeout(placeTimer);
    placeTimer = setTimeout(runPlaceSearch, 500);
  }
  if (e.target.matches("[data-dist]")) root.querySelector("[data-distval]").textContent = `${e.target.value} mi`;
});
// On a phone the keyboard covers the lower half. While a box in onboarding has focus, give the scroll area room
// below it and bring the box to the middle, so it is never hidden under the keyboard or the Next bar.
document.addEventListener("focusin", (e) => {
  if (!e.target.matches?.(".obbody input, .obbody textarea")) return;
  root.querySelector(".ob")?.classList.add("kb");
  setTimeout(() => e.target.scrollIntoView({ block: "center", behavior: "smooth" }), 320);
});
document.addEventListener("focusout", (e) => {
  if (e.target.matches?.(".obbody input, .obbody textarea")) root.querySelector(".ob")?.classList.remove("kb");
});
document.addEventListener("change", (e) => {
  if (e.target.matches("[data-dist]")) setLimit({ maxDistanceMiles: Number(e.target.value) });
});

// <details> sections keep their open state across the redraws that progress polling causes.
document.addEventListener("toggle", (e) => {
  const section = e.target.closest?.("details[data-d]");
  if (section) state.searchUi.open[section.dataset.d] = section.open;
}, true);

document.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.target.matches("[data-place-q]")) {
    e.preventDefault();
    runPlaceSearch();
    return;
  }
  if (e.key === "Enter" && e.target.matches("[data-store-q]")) {
    e.preventDefault();
    root.querySelector("[data-act='obStoreAdd'], [data-act='storeAdd']")?.click();
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey || e.target.matches("input, textarea")) return;
  if (e.key === "Escape") {
    state.expanded = null;
    state.menuOpen = false;
    render();
    return;
  }
  if (state.tab !== "deck" || state.expanded || state.loadError || state.booting || !state.onboarded) return;
  const direction = { ArrowRight: "right", ArrowLeft: "left", ArrowUp: "up" }[e.key];
  const top = deckCards()[0];
  if (direction) {
    e.preventDefault();
    swipe(direction);
  } else if (e.key === "Enter" && top && !e.target.closest("button, a")) {
    state.expanded = top.id;
    render();
  } else if (e.key.toLowerCase() === "z") {
    undo();
  }
});

// When the user leaves, whatever swipes are waiting go to the profile updater. keepalive lets the request
// outlive the page. Both events fire on a close, and the server ignores the second when nothing is waiting.
const leaving = () => fetch("/api/profile/flush", { method: "POST", keepalive: true });
document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && leaving());
addEventListener("pagehide", leaving);

// One place for anything unexpected.
addEventListener("unhandledrejection", (e) => toast(`Something went wrong: ${e.reason?.message ?? e.reason}`));
addEventListener("error", (e) => toast(`Something went wrong: ${e.message}`));

render();
await load();
if (state.onboarded) {
  state.booting = false;
  await restartDeck();
  if (state.searching) loadPipeline(); // the page was reloaded during a search
} else {
  Object.assign(state.ob, { stores: [...state.stores], typeFilter: state.typeFilter, loc: state.hasHome ? "granted" : "unset", place: state.place });
  state.booting = false;
  render();
}
