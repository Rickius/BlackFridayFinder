// Search, find nearby stores, and add to the deck in one go, for the command line or a scheduled job.
//
//   npm run refresh -- --place "Charlotte, NC"
//   npm run refresh -- --place "Charlotte, NC" --stores "Best Buy,Under Armour"
//   npm run refresh                          uses data/search.json (the app writes it when you search from the app)
//
// The three steps are the same ones the app's "Find deals" button runs.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = (file) => fileURLToPath(new URL(file, import.meta.url));
const deals = here("./output/deals.json");
const steps = [
  [here("./deals-search.js"), process.argv.slice(2)],
  [here("./locate-stores.js"), [deals]],
  [here("../app/import.js"), [deals]],
];

for (const [script, args] of steps) {
  const run = spawnSync(process.execPath, ["--env-file-if-exists=.env", script, ...args], { stdio: "inherit" });
  if (run.status !== 0) process.exit(run.status ?? 1);
}
