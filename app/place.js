// A "place" is the city a person shops in. The app, the search pipeline and the store lookup all share
// this shape, so nothing else needs to know which city it is:
//   { name: "Charlotte, NC", city, state, stateName, country, countryCode, lat, lon, slug: "charlotte-nc" }
// Lookups use OpenStreetMap Nominatim: 1 request per second, a User-Agent that names the app, and results
// are cached for the life of the process. Map data (c) OpenStreetMap contributors, ODbL.

const USER_AGENT = "BlackFridayBuster/0.1 (open-source local deal deck)";
const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const MIN_MS_BETWEEN_REQUESTS = 1100;

export const slugify = (text) =>
  String(text).normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

let lastRequestAt = 0;
const cache = new Map();

// Returns up to `limit` settlements (cities, towns, villages) matching the text, best first.
export async function lookupPlaces(query, limit = 5) {
  const text = String(query ?? "").trim();
  if (text.length < 2) return [];
  const key = `${text.toLowerCase()}|${limit}`;
  if (cache.has(key)) return cache.get(key);

  const wait = lastRequestAt + MIN_MS_BETWEEN_REQUESTS - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastRequestAt = Date.now();

  const params = new URLSearchParams({ q: text, format: "jsonv2", addressdetails: "1", featuretype: "settlement", limit: String(limit * 2) });
  const res = await fetch(`${NOMINATIM_URL}?${params}`, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Place lookup failed (${res.status})`);

  const seen = new Set();
  const places = [];
  for (const r of await res.json()) {
    const place = toPlace(r);
    if (!place || seen.has(place.slug)) continue;
    seen.add(place.slug);
    places.push(place);
  }
  const result = places.slice(0, limit);
  cache.set(key, result);
  return result;
}

function toPlace(r) {
  const a = r.address ?? {};
  const city = a.city ?? a.town ?? a.village ?? a.municipality ?? a.hamlet ?? r.name;
  const countryCode = a.country_code?.toLowerCase();
  if (!city || !countryCode) return null;
  const state = countryCode === "us" ? a["ISO3166-2-lvl4"]?.replace("US-", "") ?? null : null;
  const region = state ?? a.state ?? a.country;
  return {
    name: region ? `${city}, ${region}` : city,
    city,
    state,
    stateName: a.state ?? null,
    country: a.country ?? null,
    countryCode,
    lat: Math.round(Number(r.lat) * 1e4) / 1e4,
    lon: Math.round(Number(r.lon) * 1e4) / 1e4,
    slug: slugify(`${city}-${state ?? a.state ?? countryCode}`),
  };
}

// Checks a place that came from the browser or a config file, so nothing odd reaches the pipeline.
export function cleanPlace(place) {
  const isText = (v, max = 120) => typeof v === "string" && v.length > 0 && v.length <= max;
  const isNum = (v, lo, hi) => typeof v === "number" && v >= lo && v <= hi;
  if (!place || !isText(place.city) || !isText(place.name) || !isText(place.countryCode, 3) || !isNum(place.lat, -90, 90) || !isNum(place.lon, -180, 180)) return null;
  return {
    name: place.name, city: place.city, state: place.state ?? null, stateName: place.stateName ?? null,
    country: place.country ?? null, countryCode: place.countryCode.toLowerCase(), lat: place.lat, lon: place.lon,
    slug: slugify(`${place.city}-${place.state ?? place.stateName ?? place.countryCode}`),
  };
}
