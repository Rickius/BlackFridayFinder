// The picture on a deal: the retailer's photo when there is one, otherwise a flat brand-colour panel with a big,
// quiet category icon. The panel always renders underneath, so a photo that fails, is tiny, or is still loading
// leaves the panel showing (no broken-image flash, no layout shift: the panel has a fixed size).
import { categoryIcon } from "./icons.js";
import { esc, toneOf } from "./format.js";

const MIN_WIDTH = 120;       // a photo narrower than this is an icon or a tracker, not a product shot
const WIDE_ASPECT = 1.6;     // wider than this is a lifestyle banner: fill the panel instead of fitting inside it
const PORTRAIT_ASPECT = 0.95; // taller than this is a model or studio shot: fit it by height, whole, with its backdrop colour on the sides
const CORNER_SPREAD = 40;    // corners further apart than this are not one backdrop (a scene, or a product at the edge): keep white
const HOLD = 12;             // decoded images kept alive so a redraw is instant

// url -> { ok, wide }. Every photo we have seen keeps its verdict, so a redraw paints a good one at once
// and never draws a bad one again.
const seen = new Map();
const held = [];

function judge(img) {
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  return !w || !h || w < MIN_WIDTH ? { ok: false } : { ok: true, wide: w / h > WIDE_ASPECT, portrait: w / h < PORTRAIT_ASPECT };
}

// Fetches and decodes photos ahead of time. The first `eager` get high priority (the cards about to be on top).
export function preloadPhotos(deals, eager = 2) {
  deals.forEach((deal, i) => {
    const url = deal.image_url;
    if (!url || seen.has(url)) return;
    seen.set(url, null); // in flight
    const img = new Image();
    img.referrerPolicy = "no-referrer";
    img.fetchPriority = i < eager ? "high" : "auto";
    img.decoding = "async";
    img.src = url;
    img.decode().then(
      () => {
        seen.set(url, judge(img));
        held.push(img);
        if (held.length > HOLD) held.shift();
        requestBackdrop(url, deal.id);
      },
      () => seen.set(url, { ok: false }),
    );
  });
}

// ---------- the backdrop colour ----------
// The card behind a photo takes the photo's own backdrop colour (grey studio paper, white, ...), read from its four
// corners, so the picture never looks pasted onto a different colour. Pixels are read from the server's same-origin
// copy of the photo (/api/img/:id), because most hosts do not allow reading theirs. When the corners disagree the card
// stays white. url -> "rgb(r,g,b)" | null (unknown, or not one backdrop).
const backdrops = new Map();
const asked = new Set();

function backdropOf(img) {
  const W = 32;
  const H = Math.max(8, Math.round((W * img.naturalHeight) / img.naturalWidth));
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, W, H);
  const corners = [[0, 0], [W - 3, 0], [0, H - 3], [W - 3, H - 3]].map(([x, y]) => {
    const px = ctx.getImageData(x, y, 3, 3).data; // throws when the host does not allow reading pixels
    const sum = [0, 0, 0];
    let n = 0;
    for (let i = 0; i < px.length; i += 4) {
      if (px[i + 3] < 200) continue; // transparent: not a backdrop
      sum[0] += px[i]; sum[1] += px[i + 1]; sum[2] += px[i + 2];
      n++;
    }
    return n ? sum.map((s) => s / n) : null;
  });
  if (corners.some((c) => !c)) return null;
  const channels = [0, 1, 2];
  const spread = Math.max(...channels.map((k) => Math.max(...corners.map((c) => c[k])) - Math.min(...corners.map((c) => c[k]))));
  if (spread > CORNER_SPREAD) return null;
  const mean = channels.map((k) => Math.round(corners.reduce((s, c) => s + c[k], 0) / corners.length));
  return `rgb(${mean.join(",")})`;
}

function paintBackdrop(url, color) {
  if (!color) return;
  document.querySelectorAll(".art img.photo").forEach((img) => {
    if (img.getAttribute("src") === url) img.closest(".art").style.setProperty("--bg", color);
  });
}

// A second request, for the server's copy of the same file, only to read its corners. The picture itself loads as before.
function requestBackdrop(url, dealId) {
  if (!url || !dealId || asked.has(url)) return;
  asked.add(url);
  const probe = new Image();
  probe.src = `/api/img/${dealId}`;
  probe.decode().then(
    () => {
      let color = null;
      try { color = backdropOf(probe); } catch { /* the canvas is tainted: keep white */ }
      backdrops.set(url, color);
      paintBackdrop(url, color);
    },
    () => backdrops.set(url, null),
  );
}

const verdict = (url) => (url ? seen.get(url) ?? null : null);

// Whether the photo is worth showing, and where it came from: the details sheet credits it.
export const photoUsable = (deal) => Boolean(deal.image_url) && verdict(deal.image_url)?.ok !== false;

// `extra` adds classes to the panel ("mini" for thumbnails). `eager` is for cards about to be on top, including the
// one right behind it, so its photo is already painted when the card above is swiped away.
export function artHtml(deal, extra = "", { eager = false } = {}) {
  const v = verdict(deal.image_url);
  const photo = photoUsable(deal)
    ? `<img class="photo${v?.ok ? " ready" : ""}${v?.wide ? " wide" : ""}${v?.portrait ? " portrait" : ""}" src="${esc(deal.image_url)}" data-deal="${deal.id}" alt="${esc(deal.image_alt || deal.title)}" draggable="false" decoding="${v?.ok ? "sync" : "async"}" referrerpolicy="no-referrer" loading="${eager ? "eager" : "lazy"}"${eager ? ` fetchpriority="high"` : ""}>`
    : "";
  const icon = `<span class="ico">${categoryIcon(deal.category, 96, 1.4)}</span>`;
  return `<div class="art ${extra}${photo && v?.ok ? " has" : ""}" style="--tone:${toneOf(deal)}${photo && backdrops.get(deal.image_url) ? `;--bg:${backdrops.get(deal.image_url)}` : ""}">${icon}${photo}</div>`;
}

// Photos arrive after the markup is on the page: judge each one, fade it in, or drop it for the panel.
document.addEventListener("load", (e) => {
  const img = e.target;
  if (!img.classList?.contains("photo")) return;
  const v = judge(img);
  seen.set(img.getAttribute("src"), v);
  if (!v.ok) return img.remove();
  img.classList.toggle("wide", Boolean(v.wide));
  img.classList.toggle("portrait", Boolean(v.portrait));
  img.classList.add("ready");
  img.closest(".art")?.classList.add("has");
  requestBackdrop(img.getAttribute("src"), img.dataset.deal);
  paintBackdrop(img.getAttribute("src"), backdrops.get(img.getAttribute("src")));
}, true);

document.addEventListener("error", (e) => {
  const img = e.target;
  if (!img.classList?.contains("photo")) return;
  seen.set(img.getAttribute("src"), { ok: false });
  img.remove();
}, true);
