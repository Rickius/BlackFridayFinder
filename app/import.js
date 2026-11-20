// Loads deal records from a JSON file into the database.
// Usage: node app/import.js [path/to/deals.json]
// Safe to re-run: a deal is identified by source URL + title, and re-importing refreshes its price and dates.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { db, inTransaction } from "./db.js";
import { acceptableImageUrl } from "./image-rules.js";
import { addLocation, resolveStore } from "./stores.js";
import { categories } from "./tags.js";

export const seedFile = resolve(dirname(fileURLToPath(import.meta.url)), "seed", "deals.seed.json");

const columns = [
  "title", "store", "store_slug", "deal_type", "deal_type_quote", "inferred_type", "inferred_reason", "sale_price", "original_price", "percent_off", "discount_text",
  "price_verified", "valid_from", "valid_to", "window_text", "code", "category", "source_url", "image_url", "image_reliable",
  "image_source", "image_checked_at", "claims", "region", "fetched_at", "imported_at",
];
// Re-importing a deal refreshes its price and dates but must not erase an image that was already resolved for it.
const keepImage = {
  image_url: "COALESCE(excluded.image_url, deals.image_url)",
  image_source: "COALESCE(excluded.image_source, deals.image_source)",
  image_checked_at: "COALESCE(excluded.image_checked_at, deals.image_checked_at)",
  image_reliable: "CASE WHEN excluded.image_url IS NOT NULL THEN excluded.image_reliable ELSE deals.image_reliable END",
};
const upsert = db.prepare(`
  INSERT INTO deals (${columns.join(", ")}) VALUES (${columns.map((c) => ":" + c).join(", ")})
  ON CONFLICT (source_url, title) DO UPDATE SET ${columns.map((c) => `${c} = ${keepImage[c] ?? `excluded.${c}`}`).join(", ")}`);
const findExisting = db.prepare("SELECT id FROM deals WHERE source_url = ? AND title = ?");
const upsertSuggestion = db.prepare(`
  INSERT INTO store_suggestions (region, slug, name, domain, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT (region, slug) DO UPDATE SET name = excluded.name, domain = excluded.domain, reason = excluded.reason`);

function localDate(d = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const TYPES = ["doorbuster", "online", "both"];
const IMAGE_SOURCES = ["retailer-product-page", "retailer-promo-page", "image-search"];
const number = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);
const isoDate = (value) => (/^\d{4}-\d{2}-\d{2}$/.test(value ?? "") ? value : null);

// Returns a reason string when the record must not reach the deck, otherwise null.
function skipReason(rec, today) {
  if (!rec.title || typeof rec.title !== "string") return "no title";
  if (!rec.store || typeof rec.store !== "string") return "no store";
  if (!/^https?:\/\//.test(rec.sourceUrl ?? "")) return "no http(s) source URL";
  if (!rec.priceVerified) return "no verified offer";
  if (isoDate(rec.validTo) && rec.validTo < today) return "already ended";
  return null;
}

function toRow(rec, region) {
  const store = resolveStore(rec.store);
  const imageOk = Boolean(rec.imageReliable) && acceptableImageUrl(rec.imageUrl);
  return {
    title: rec.title.trim(),
    store: store.name,
    store_slug: store.slug,
    deal_type: TYPES.includes(rec.dealType) ? rec.dealType : null,
    deal_type_quote: rec.dealType ? rec.dealTypeQuote ?? null : null,
    // A guess, kept apart from deal_type: it only counts when the model gave a known type, and it needs its reason.
    inferred_type: TYPES.includes(rec.inferredType) && rec.inferredReason ? rec.inferredType : null,
    inferred_reason: TYPES.includes(rec.inferredType) && rec.inferredReason ? String(rec.inferredReason).slice(0, 80) : null,
    sale_price: number(rec.salePrice),
    original_price: number(rec.originalPrice),
    percent_off: number(rec.percentOff),
    discount_text: rec.discountText || null,
    price_verified: 1,
    valid_from: isoDate(rec.validFrom),
    valid_to: isoDate(rec.validTo),
    window_text: rec.windowText || null,
    code: rec.code || null,
    category: categories.includes(rec.category) ? rec.category : "other",
    source_url: rec.sourceUrl,
    // An image counts only when the resolver marked it reliable and it passes the same rules the card applies.
    image_url: imageOk ? rec.imageUrl : null,
    image_reliable: imageOk ? 1 : 0,
    image_source: imageOk && IMAGE_SOURCES.includes(rec.imageSource) ? rec.imageSource : null,
    image_checked_at: imageOk ? rec.imageCheckedAt ?? null : null,
    claims: JSON.stringify(rec.claims ?? {}),
    region,
    fetched_at: rec.fetchedAt ?? new Date().toISOString(),
    imported_at: new Date().toISOString(),
  };
}

// `json` is a deals file: { place, deals, stores?, suggestions? }. Returns { added, updated, skipped, branches }.
export function importDeals(json) {
  const records = Array.isArray(json) ? json : json.deals;
  if (!Array.isArray(records)) throw new Error("The file has no deals array");
  const region = json.place?.slug ?? null; // the city this file was searched for (deals-search writes it)
  const today = localDate();
  const skipped = {};
  let added = 0;
  let updated = 0;
  let branches = 0;

  inTransaction(() => {
    for (const rec of records) {
      const reason = skipReason(rec, today);
      if (reason) {
        skipped[reason] = (skipped[reason] ?? 0) + 1;
        continue;
      }
      const row = toRow(rec, region);
      const exists = findExisting.get(row.source_url, row.title);
      upsert.run(row);
      if (exists) updated++;
      else added++;
    }
    // The stores the planner proposed for this place, with its reasons (the Taste tab shows them).
    for (const s of region ? json.suggestions ?? [] : []) {
      if (typeof s.slug === "string" && typeof s.name === "string") {
        upsertSuggestion.run(region, s.slug, s.name.slice(0, 60), typeof s.domain === "string" ? s.domain.slice(0, 80) : null, typeof s.reason === "string" ? s.reason.slice(0, 160) : null, new Date().toISOString());
      }
    }
    // Branches that came along (the seed carries them), so in-store deals have somewhere to point to.
    for (const b of json.stores ?? []) {
      if (typeof b.region === "string" && typeof b.store_slug === "string" && number(b.lat) !== null && number(b.lon) !== null) {
        addLocation(b);
        branches++;
      }
    }
  });
  return { added, updated, skipped, branches };
}

function main() {
  const file = resolve(process.argv[2] ?? seedFile);
  const { added, updated, skipped, branches } = importDeals(JSON.parse(readFileSync(file, "utf8")));
  const skippedText = Object.entries(skipped).map(([why, n]) => `${n} ${why}`).join(", ") || "none";
  console.log(`Read ${file}`);
  console.log(`Added ${added}, updated ${updated}, skipped: ${skippedText}${branches ? `, ${branches} store branches` : ""}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (err) {
    console.error(`Import failed: ${err.message}`);
    process.exitCode = 1;
  }
}
