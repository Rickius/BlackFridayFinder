// The Black Friday time windows, shared by the server (deck, counts) and the browser (context bar). No DOM.
// Dates are local calendar dates as "YYYY-MM-DD". Black Friday is the day after US Thanksgiving (4th Thursday of November).

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n) => String(n).padStart(2, "0");

export const toIso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const parseIso = (iso) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
};
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const shortDay = (d) => `${DAYS[d.getDay()]} ${MONTHS[d.getMonth()]} ${d.getDate()}`;

export function thanksgiving(year) {
  const firstThursday = 1 + ((4 - new Date(year, 10, 1).getDay() + 7) % 7);
  return new Date(year, 10, firstThursday + 21);
}

// The dates of this year's sale, or next year's once Cyber Monday has passed.
export function saleDates(now = new Date()) {
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  for (let year = now.getFullYear(); ; year++) {
    const turkey = thanksgiving(year);
    const cyberMonday = addDays(turkey, 4);
    if (cyberMonday >= todayStart) return { thanksgiving: turkey, blackFriday: addDays(turkey, 1), cyberMonday };
  }
}

export const windowOrder = ["weekend", "bf", "all"];

// { key: { label, short, from, to, range } }. "all" runs from today with no end.
export function dealWindows(now = new Date()) {
  const { thanksgiving: turkey, blackFriday, cyberMonday } = saleDates(now);
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return {
    weekend: { label: "Thanksgiving to Cyber Monday", short: "BF weekend", from: toIso(turkey), to: toIso(cyberMonday), range: `${shortDay(turkey)} – ${shortDay(cyberMonday)}` },
    bf: { label: "Black Friday", short: "Black Friday", from: toIso(blackFriday), to: toIso(blackFriday), range: shortDay(blackFriday) },
    all: { label: "Every live deal", short: "All deals", from: toIso(todayStart), to: "9999-12-31", range: `From ${shortDay(todayStart)}` },
  };
}

// A deal is in a window when its dates overlap it. A deal with no dates is treated as running the whole sale.
export const inWindow = (deal, window) =>
  (deal.valid_to === null || deal.valid_to >= window.from) && (deal.valid_from === null || deal.valid_from <= window.to);
