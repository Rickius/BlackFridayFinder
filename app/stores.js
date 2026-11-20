// Where a chain's branches are near a place, cached in the database. The store list itself lives in store-list.js.
// Branch lookups use OpenStreetMap Nominatim: 1 request per second, a User-Agent that names the app, results cached in
// the store_locations table. Map data (c) OpenStreetMap contributors, ODbL.
import { db } from "./db.js";
import { resolveStore } from "./store-list.js";

export { DEFAULT_STORES, STORE_OPTIONS, matchStore, resolveStore, storeForUrl, storeSlug } from "./store-list.js";

const USER_AGENT = "BlackFridayBuster/0.1 (open-source local deal deck)";
const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const MIN_MS_BETWEEN_REQUESTS = 1100;
const BOX_DEGREES = 0.5;       // search box around the city centre, about 35 miles each way
const MAX_BRANCHES = 5;

const normalize = (text) => String(text).toLowerCase().replace(/[^a-z0-9]/g, "");

const selectLocations = db.prepare("SELECT name, address, lat, lon FROM store_locations WHERE region = ? AND store_slug = ?");
const insertLocation = db.prepare(
  "INSERT OR IGNORE INTO store_locations (region, store_slug, name, address, lat, lon) VALUES (?, ?, ?, ?, ?, ?)");

export const hasLocations = (region, slug) => selectLocations.all(region, slug).length > 0;
export const addLocation = ({ region, store_slug, name, address, lat, lon }) =>
  insertLocation.run(region, store_slug, name, address ?? null, lat, lon);

export function locationsByStore(region) {
  const map = new Map();
  for (const row of db.prepare("SELECT store_slug, name, address, lat, lon FROM store_locations WHERE region = ?").all(region ?? "")) {
    map.set(row.store_slug, [...(map.get(row.store_slug) ?? []), row]);
  }
  return map;
}

let lastRequestAt = 0;

function addressOf(a = {}) {
  const street = [a.house_number, a.road].filter(Boolean).join(" ");
  const town = a.city ?? a.town ?? a.village ?? a.suburb ?? a.municipality;
  const state = a["ISO3166-2-lvl4"]?.replace(/^[A-Z]{2}-/, "") ?? a.state;
  return [street, town, [state, a.postcode].filter(Boolean).join(" ")].filter(Boolean).join(", ");
}

// Finds up to MAX_BRANCHES branches of the store near the place and caches them. Returns how many are known.
// Branches whose name does not contain the store's name are ignored (Nominatim also returns neighbours).
export async function locateStore(place, storeName) {
  const store = resolveStore(storeName);
  const known = selectLocations.all(place.slug, store.slug).length;
  if (known > 0) return known;

  const wait = lastRequestAt + MIN_MS_BETWEEN_REQUESTS - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastRequestAt = Date.now();

  const box = [place.lon - BOX_DEGREES, place.lat + BOX_DEGREES, place.lon + BOX_DEGREES, place.lat - BOX_DEGREES].map((n) => n.toFixed(4)).join(",");
  const query = store.name.replace(/\s+(bargain outlet|sporting goods)$/i, "");
  const params = new URLSearchParams({ q: query, format: "jsonv2", addressdetails: "1", viewbox: box, bounded: "1", limit: "20" });
  const res = await fetch(`${NOMINATIM_URL}?${params}`, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Store lookup failed (${res.status})`);

  let added = 0;
  for (const r of await res.json()) {
    const name = r.name || r.display_name?.split(",")[0] || store.name;
    if (!normalize(name).includes(normalize(query))) continue;
    if (added >= MAX_BRANCHES) break;
    insertLocation.run(place.slug, store.slug, name, addressOf(r.address) || null, Number(r.lat), Number(r.lon));
    added++;
  }
  return added;
}
