// Writes the deals in the database for one place (and the store branches near it) to app/seed/deals.seed.json,
// the deck a fresh clone starts with. Usage: node scripts/export-seed.js [place-slug]   (default: charlotte-nc)
// Run it against the database that holds a real search, then commit the file.
import { writeFileSync } from "node:fs";
import { db } from "../app/db.js";
import { seedFile } from "../app/import.js";
import { cleanPlace, lookupPlaces } from "../app/place.js";
import { getUser } from "../app/user.js";

const slug = process.argv[2] ?? "charlotte-nc";
const rows = db.prepare("SELECT * FROM deals WHERE region = ? ORDER BY store, title").all(slug);
if (rows.length === 0) throw new Error(`No deals stored for ${slug}. Run a search for it first.`);

// The place the search ran for is saved with the user; otherwise look "charlotte-nc" up as "charlotte, nc".
const saved = getUser().place;
const place = saved?.slug === slug ? saved : cleanPlace((await lookupPlaces(slug.replace(/-/g, " ").replace(/ (\w\w)$/, ", $1"), 1))[0]);
if (place?.slug !== slug) throw new Error(`Could not rebuild the place ${slug}`);

const deals = rows.map((r) => ({
  title: r.title, store: r.store, storeSlug: r.store_slug, dealType: r.deal_type, dealTypeQuote: r.deal_type_quote, inferredType: r.inferred_type, inferredReason: r.inferred_reason,
  salePrice: r.sale_price, originalPrice: r.original_price, percentOff: r.percent_off, discountText: r.discount_text,
  priceVerified: Boolean(r.price_verified), validFrom: r.valid_from, validTo: r.valid_to, windowText: r.window_text, code: r.code,
  category: r.category, sourceUrl: r.source_url, imageUrl: r.image_url, imageReliable: Boolean(r.image_reliable),
  imageSource: r.image_source, imageCheckedAt: r.image_checked_at,
  claims: JSON.parse(r.claims), fetchedAt: r.fetched_at,
}));
const stores = db.prepare("SELECT region, store_slug, name, address, lat, lon FROM store_locations WHERE region = ?").all(slug);
const suggestions = db.prepare("SELECT slug, name, domain, reason FROM store_suggestions WHERE region = ? ORDER BY name").all(slug);

writeFileSync(seedFile, JSON.stringify({ place, generatedAt: new Date().toISOString(), deals, stores, suggestions }, null, 2) + "\n");
console.log(`Wrote ${deals.length} deals, ${stores.length} store branches and ${suggestions.length} suggested stores for ${place.name} to ${seedFile}`);
