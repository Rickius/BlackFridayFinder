// Labels derived from a deal card: money, dates, deal type, the poster headline, links. No DOM in here.
import { dealWindows, inWindow, parseIso, toIso, windowOrder } from "./windows.js";

export { dealWindows, inWindow, windowOrder };

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAYS_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const esc = (text) => String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
export const cap = (text) => (text ? text[0].toUpperCase() + text.slice(1) : text);
export const today = () => toIso(new Date());

export const BUDGETS = [["any", "Any"], ["50", "$50"], ["100", "$100"], ["250", "$250"], ["500", "$500"]];

// ---------- money ----------

export const money = (n) => "$" + (Number.isInteger(n) ? n.toLocaleString("en-US") : n.toFixed(2));

// The discount as a percent: the page's own figure, or worked out from the two prices.
export function discountPercent(deal) {
  if (typeof deal.percent_off === "number" && deal.percent_off > 0) return Math.round(deal.percent_off);
  if (deal.sale_price !== null && deal.original_price && deal.original_price > deal.sale_price) {
    return Math.round((1 - deal.sale_price / deal.original_price) * 100);
  }
  return null;
}

// Category -> flat panel colour when the deal has no photo.
const TONES = { tv: "#817FFF", laptop: "#817FFF", audio: "#817FFF", gaming: "#817FFF", phone: "#817FFF",
  apparel: "#79DEEB", shoes: "#79DEEB", fitness: "#79DEEB", home: "#F49EFF", appliance: "#F49EFF", closeout: "#F49EFF" };
export const toneOf = (deal) => TONES[deal.category] ?? "#80AF9B";

// The ink pill on the photo: "45% off" in the display font. Without a percent: dollars off, then a short discount
// phrase (smaller type), then plain "Deal". Never invents a figure the deal does not carry.
export function offPill(deal) {
  const percent = discountPercent(deal);
  if (percent) return { text: `${percent}% off`, small: false };
  const text = (deal.discount_text ?? "").trim();
  const dollars = text.match(/\$\s?(\d[\d,]*(?:\.\d+)?)\s*(?:off|back)/i);
  if (dollars) return { text: `$${dollars[1]} off`, small: false };
  const pct = text.match(/(\d{1,3})\s*%/);
  if (pct) return { text: `${pct[1]}% off`, small: false };
  if (/\bbogo\b|buy\s+(?:one|1)\b.*\bget\s+(?:one|1)\b/i.test(text)) return { text: "BOGO", small: false };
  if (/free\s+shipping/i.test(text)) return { text: "Free shipping", small: true };
  if (text && text.length <= 14) return { text, small: true };
  return { text: "Deal", small: false };
}

// ---------- deal type ----------

const TYPES = {
  doorbuster: { tone: "door", label: "Doorbuster · In store", short: "Doorbuster", icon: "bolt", guess: "Likely in store", guessShort: "Likely in store" },
  online: { tone: "online", label: "Online", short: "Online", icon: "bag", guess: "Likely online", guessShort: "Likely online" },
  both: { tone: "both", label: "In store + online", short: "In store + online", icon: "store", guess: "Likely in store + online", guessShort: "Likely in store + online" },
};

// The type the page states (deal_type) wins. Without one, the model's labeled guess (inferred_type) stands in.
export const effectiveType = (deal) => deal.deal_type ?? deal.inferred_type ?? null;

// How a deal's type is shown. A verified type gets the solid look. A guess gets a dashed chip with an "unverified"
// note, never the verified look. With neither, the "Type unverified" chip.
export function typeInfo(deal) {
  const verified = TYPES[deal.deal_type];
  if (verified) return { ...verified, chip: verified.tone, guess: false };
  const g = TYPES[deal.inferred_type];
  if (g) return { chip: `guess ${g.tone}`, label: g.guess, short: `${g.guessShort} (unverified)`, icon: g.icon, guess: true };
  return { chip: "unk", label: "Type unverified", short: "Type unverified", icon: "tag", guess: false };
}

// Anything that is not online is a place you might have to go to: show distance and the map for it.
export const isInStore = (deal) => effectiveType(deal) !== "online";

// ---------- dates ----------

export function fmtDay(iso, long = false) {
  const d = parseIso(iso);
  const monthDay = `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  return long ? `${DAYS_LONG[d.getDay()]}, ${monthDay}` : `${DAYS[d.getDay()]} ${monthDay}`;
}

const shortDate = (iso) => { const d = parseIso(iso); return `${MONTHS[d.getMonth()]} ${d.getDate()}`; };
export const isExpired = (deal) => deal.valid_to !== null && deal.valid_to < today();

// One line saying when the deal runs. Never invents a date.
export function windowLine(deal) {
  if (isExpired(deal)) return `Ended ${fmtDay(deal.valid_to)}`;
  if (deal.window_text) return deal.window_text;
  if (deal.valid_to) return `Ends ${fmtDay(deal.valid_to)}`;
  return "Dates not listed";
}

// The cream pill on the photo: when it ends, as short as it can be.
export function endsText(deal) {
  if (isExpired(deal)) return `Ended ${shortDate(deal.valid_to)}`;
  const win = (deal.window_text ?? "").replace(/,?\s*(in[- ]store( only)?|online( only)?)\s*$/i, "").trim();
  if (win && win.length <= 22) return win;
  if (deal.valid_to) return `Ends ${shortDate(deal.valid_to)}`;
  if (win) return win.slice(0, 21).replace(/[\s,]+\S*$/, "") + "…";
  return "Dates not listed";
}

export const seenLabel = (deal) => {
  const d = new Date(deal.fetched_at);
  return Number.isNaN(d.getTime()) ? "Seen recently" : `Seen ${MONTHS[d.getMonth()]} ${d.getDate()}`;
};

// ---------- links, distance ----------

export const mapUrl = (deal) =>
  deal.nearest_store
    ? "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent([deal.nearest_store.name, deal.nearest_store.address].filter(Boolean).join(", "))
    : null;

export const sourceName = (deal) => {
  try {
    return new URL(deal.source_url).hostname.replace(/^www\./, "");
  } catch {
    return "source";
  }
};

export function distanceLabel(deal) {
  if (!isInStore(deal) || deal.distance_miles === null || deal.distance_miles === undefined) return null;
  return `${deal.distance_miles.toFixed(deal.distance_miles < 10 ? 1 : 0)} mi`;
}
