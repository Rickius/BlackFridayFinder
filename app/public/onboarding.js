// The four onboarding steps as HTML: where you are, which stores you shop, what you are looking for, how you shop.
// Every step can be skipped, and the deck works with all of them skipped (no stores picked means the default stores).
import { icon as I } from "./icons.js";
import { BUDGETS, cap, esc } from "./format.js";
import { placePickerHtml } from "./search.js";

export const STEPS = 4;
const examples = ["A 65-inch TV under $500", "Running shoes and gym gear", "Cheap kitchen stuff", "Headphones for gifts"];
const shopModes = [
  ["doorbuster", "In-store doorbusters", "Limited-time deals you go and get.", "bolt"],
  ["online", "Online", "Skip the drive and ship it.", "bag"],
  ["all", "Both", "See everything, each deal labeled.", "store"],
];

// Popular first, then the other suggestions, then any store the person typed. The chips use the index into this list.
export function obStoreNames(state, ob) {
  const suggested = state.storeOptions.map((s) => s.name);
  const popular = state.defaultStores.length ? state.defaultStores : suggested.slice(0, 3);
  const others = suggested.filter((name) => !popular.includes(name));
  const custom = ob.stores.filter((name) => !suggested.includes(name));
  return { popular, others, custom, all: [...popular, ...others, ...custom] };
}

function whereStep(ob, picker) {
  const location = {
    unset: ["Use device location", "Optional. Shows how far each in-store deal is. Never saved as history.", `<button class="btn sm pri" data-act="obLoc">Allow</button>`, "arrow"],
    asking: ["Waiting for your browser", "Choose Allow in the prompt.", "", "arrow"],
    granted: ["Location on", "Distance on each doorbuster. Ranking only.", `<span class="on-tag">On</span>`, "arrow"],
    denied: ["Location off", "Fine. Distances stay hidden and ranking ignores distance.", `<button class="btn sm" data-act="obLoc">Retry</button>`, "off"],
  }[ob.loc];
  const chosen = ob.place
    ? `<div class="wrow"><span class="pl on">${I("pin", 14, 2.4)}&nbsp;${esc(ob.place.name)}</span><button class="btn sm" data-act="obPlaceClear">Change</button></div>`
    : placePickerHtml(picker);
  return `<h1 class="disp">Where are<br><em>you?</em></h1>
    <p class="sub">Pick your city. We look for deals and the stores near it. Everything here is optional.</p>
    <span class="lbl meta">City</span>${chosen}
    <span class="lbl meta">Distance</span>
    <div class="locc"><div class="ic">${I(location[3], 22, 2.2)}</div><div style="flex:1"><b>${location[0]}</b><small>${location[1]}</small></div>${location[2]}</div>`;
}

function storesStep(state, ob) {
  const { popular, others, custom, all } = obStoreNames(state, ob);
  const on = (name) => ob.stores.includes(name);
  const idx = (name) => all.indexOf(name);
  const tiles = popular.map((name) => `<button class="tile ${on(name) ? "on" : ""}" data-act="obStore:${idx(name)}" aria-pressed="${on(name)}">
      <span class="ti">${I("store", 22, 1.9)}</span><b>${esc(name)}</b><span class="tchk">${on(name) ? I("check", 16, 3.2) : ""}</span></button>`).join("");
  const chip = (name) => `<button class="pl ${on(name) ? "on" : ""}" data-act="obStore:${idx(name)}" aria-pressed="${on(name)}">${on(name) ? I("check", 13, 3.4) + "&nbsp;" : ""}${esc(name)}</button>`;
  const none = ob.stores.length === 0
    ? `<div class="hint">${I("spark", 18)}<span>None picked is fine. We start with ${esc(popular.join(", "))}.</span></div>` : "";
  return `<h1 class="disp">Where do<br>you <em>shop?</em></h1>
    <p class="sub">We search these first. We will also suggest other stores that fit what you are looking for.</p>
    <span class="lbl meta">Popular</span><div class="tiles">${tiles}</div>
    <span class="lbl meta">More stores</span><div class="ex" style="margin:0">${others.map(chip).join("")}${custom.map(chip).join("")}</div>
    <span class="lbl meta">Add your own</span>
    <div class="pprow"><input class="ans pin" data-store-q type="text" value="${esc(ob.customStore)}" placeholder="Store name" maxlength="40" autocomplete="off" aria-label="Add a store">
      <button class="btn sm pri" data-act="obStoreAdd">Add</button></div>${none}`;
}

function likesStep(ob, tags) {
  return `<h1 class="disp">What are<br>you <em>hunting?</em></h1>
    <p class="sub">Say it in your own words. The more specific, the better the search.</p>
    <textarea class="ans" data-ans maxlength="500" placeholder="A 65-inch TV, running shoes, something for the kitchen…">${esc(ob.answer)}</textarea>
    <div class="ex">${examples.map((text) => `<button class="pl xs" data-act="obEx" data-text="${esc(text)}">${esc(text)}</button>`).join("")}</div>
    <div class="hint" style="margin-top:14px">${I("spark", 18)}<span>Token Factory reads this to plan the searches and set your starting taste profile.</span></div>
    <span class="lbl meta">Or pick the aisles</span>
    <div class="ex" style="margin:0">${tags.map((tag) =>
      `<button class="pl ${ob.vibes.includes(tag) ? "on" : ""}" data-act="obVibe:${esc(tag)}" aria-pressed="${ob.vibes.includes(tag)}">${esc(cap(tag))}</button>`).join("")}</div>`;
}

function shopStep(ob) {
  const budget = ob.budget === null ? "any" : String(ob.budget);
  const options = shopModes.map(([key, title, sub, ic]) => `<button class="opt ${ob.typeFilter === key ? "on" : ""}" data-act="obMode:${key}" aria-pressed="${ob.typeFilter === key}">
      <span class="oi">${I(ic, 24, 2)}</span><span class="ot"><b>${title}</b><small>${sub}</small></span>
      <span class="rd">${ob.typeFilter === key ? I("check", 14, 3.4) : ""}</span></button>`).join("");
  return `<h1 class="disp">How do<br>you <em>shop?</em></h1>
    <p class="sub">Change it anytime from the deck.</p>
    <span class="lbl meta">Deals to show</span><div class="opts">${options}</div>
    <span class="lbl meta">Most you will spend on one thing</span>
    <div class="seg">${BUDGETS.map(([value, label]) => `<button class="${budget === value ? "on" : ""}" data-act="obBudget:${value}">${label}</button>`).join("")}</div>`;
}

export function onboardingHtml(ob, state, picker) {
  const last = ob.step === STEPS - 1;
  const body = [whereStep(ob, picker), storesStep(state, ob), likesStep(ob, state.vibeTags), shopStep(ob)][ob.step];
  const next = last
    ? `<button class="btn pri" style="flex:1" data-act="obFinish" ${ob.busy ? "disabled" : ""}>${ob.busy ? "Setting up…" : `Start swiping ${I("right", 17, 2.8)}`}</button>`
    : `<button class="btn pri" style="flex:1" data-act="obNext">Next ${I("right", 17, 2.8)}</button>`;
  const back = ob.step > 0 ? `<button class="btn round" data-act="obBack" aria-label="Back" ${ob.busy ? "disabled" : ""}>${I("left", 18, 2.8)}</button>` : "";
  return `<div class="ob">
    <div class="obtop"><div class="prog">${Array.from({ length: STEPS }, (_, i) => `<i class="${i <= ob.step ? "on" : ""}"></i>`).join("")}</div>
      <button class="skip" data-act="${last ? "obDefaults" : "obNext"}" ${ob.busy ? "disabled" : ""}>${last ? "Use defaults" : "Skip"}</button></div>
    <div class="obbody">${body}</div>
    <div class="obfoot">${back}${next}</div></div>`;
}
