// Finds the branches near a search's place for every store that has a deal you could drive to, and caches them
// in the store_locations table. Usage: node scripts/locate-stores.js path/to/deals.json
// Map data (c) OpenStreetMap contributors, ODbL.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { locateStore } from "../app/stores.js";

const file = resolve(process.argv[2] ?? "");
const { place, deals } = JSON.parse(readFileSync(file, "utf8"));
if (!place?.slug) throw new Error("The file has no place");

// An online deal (stated or guessed) needs no branch. A deal of unknown type might be in store, so it does.
const stores = [...new Set(deals.filter((d) => (d.dealType ?? d.inferredType) !== "online").map((d) => d.store))];
let total = 0;
for (const store of stores) {
  try {
    const found = await locateStore(place, store);
    total += found;
    console.log(`Branches near ${place.name}: ${store} ${found}`);
  } catch (err) {
    console.error(`Could not look up ${store}: ${err.message}`);
    process.exitCode = 1;
  }
}
if (stores.length === 0) console.log("No in-store deals in this batch, so no branches to look up");
else console.log(`Branches known for ${stores.length} stores: ${total}`);
