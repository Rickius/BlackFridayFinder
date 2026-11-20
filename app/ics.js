// Builds a one-deal reminder .ics: an all-day event on the day the deal ends, or on Black Friday when the page
// gives no end date, with the store address and the source link.
import { saleDates, toIso } from "./public/windows.js";

const escapeText = (text) => text.replace(/[\\;,]/g, "\\$&").replace(/\r?\n/g, "\\n");
const compactDate = (isoDate) => isoDate.replaceAll("-", "");

function nextDay(isoDate) {
  const [y, m, d] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

// `card` is the deal as toCard builds it.
export function buildIcs(card) {
  const date = card.valid_to ?? toIso(saleDates().blackFriday);
  const price = card.sale_price !== null ? `$${card.sale_price}` : card.discount_text;
  const summary = `${card.store}: ${card.title}${price ? ` (${price})` : ""}`;
  const where = card.nearest_store ? [card.nearest_store.name, card.nearest_store.address].filter(Boolean).join(", ") : "";
  const notes = [
    card.window_text && `When: ${card.window_text}`,
    card.valid_to ? `Ends ${card.valid_to}` : "End date not listed on the page",
    card.code && `Code: ${card.code}`,
    `Source: ${card.source_url}`,
  ].filter(Boolean).join("\n");
  const stamp = new Date().toISOString().replace(/[-:]|\.\d{3}/g, "");

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//BF Buster//EN",
    "BEGIN:VEVENT",
    `UID:${card.id}@bfbuster.local`,
    `DTSTAMP:${stamp}`,
    `DTSTART;VALUE=DATE:${compactDate(date)}`,
    `DTEND;VALUE=DATE:${compactDate(nextDay(date))}`,
    `SUMMARY:${escapeText(summary)}`,
    ...(where ? [`LOCATION:${escapeText(where)}`] : []),
    `URL:${card.source_url}`,
    `DESCRIPTION:${escapeText(notes)}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.join("\r\n") + "\r\n";
}
