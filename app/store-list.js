// The stores the app knows about and how a store name is matched. No database in here, so scripts can use it.
import { slugify } from "./place.js";

// domains: where the chain's own pages live (Tavily include_domains). aliases: spellings a page might use.
export const STORE_OPTIONS = [
  { name: "Best Buy", slug: "best-buy", domains: ["bestbuy.com"], aliases: ["bestbuy"] },
  { name: "Ollie's Bargain Outlet", slug: "ollies", domains: ["ollies.com", "ollies.us"], aliases: ["ollies", "olliesbargainoutlet"] },
  { name: "Under Armour", slug: "under-armour", domains: ["underarmour.com"], aliases: ["underarmour"] },
  { name: "Target", slug: "target", domains: ["target.com"], aliases: ["target"] },
  { name: "Walmart", slug: "walmart", domains: ["walmart.com"], aliases: ["walmart"] },
  { name: "Home Depot", slug: "home-depot", domains: ["homedepot.com"], aliases: ["homedepot", "thehomedepot"] },
  { name: "Lowe's", slug: "lowes", domains: ["lowes.com"], aliases: ["lowes"] },
  { name: "Nike", slug: "nike", domains: ["nike.com"], aliases: ["nike"] },
  { name: "Dick's Sporting Goods", slug: "dicks", domains: ["dickssportinggoods.com"], aliases: ["dicks", "dickssportinggoods"] },
  { name: "Kohl's", slug: "kohls", domains: ["kohls.com"], aliases: ["kohls"] },
  { name: "Macy's", slug: "macys", domains: ["macys.com"], aliases: ["macys"] },
  { name: "Amazon", slug: "amazon", domains: ["amazon.com"], aliases: ["amazon"] },
];

export const DEFAULT_STORES = ["Best Buy", "Ollie's Bargain Outlet", "Under Armour"];

const normalize = (text) => String(text).toLowerCase().replace(/[^a-z0-9]/g, "");

// A store name from the app or a page, as { name, slug, domains, aliases }. A custom name has no domains.
export function resolveStore(name) {
  const clean = String(name).trim();
  const key = normalize(clean);
  const known = STORE_OPTIONS.find((o) => normalize(o.name) === key || o.aliases.includes(key));
  return known ?? { name: clean, slug: slugify(clean), domains: [], aliases: [key] };
}

export const storeSlug = (name) => resolveStore(name).slug;

// A store the planner suggested: a name and the chain's own domain. Known chains keep their known entry.
export function makeStore(name, domain) {
  const known = resolveStore(name);
  if (known.domains.length) return known;
  return { name: known.name, slug: known.slug, domains: [domain], aliases: known.aliases };
}

const asStore = (s) => (typeof s === "string" ? resolveStore(s) : s);

// Which of `stores` (display names or resolved stores) is this page text talking about? Returns the resolved store or null.
export function matchStore(text, stores) {
  const key = normalize(text);
  if (!key) return null;
  return stores.map(asStore).find((s) => s.aliases.some((a) => a.length >= 3 && (key === a || key.includes(a)))) ?? null;
}

// A page on a chain's own domain is that chain's page, whatever else the model says.
export function storeForUrl(url, stores) {
  let host;
  try {
    host = new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
  return stores.map(asStore).find((s) => s.domains.some((d) => host === d || host.endsWith(`.${d}`))) ?? null;
}
