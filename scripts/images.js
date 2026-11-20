// Finds a photo for a deal. A wrong product photo is worse than none, so an image is accepted only when it comes from
// the retailer's own site AND clearly belongs to this product (or, for a store-wide promo, to the retailer's promo page).
//
// Order of attempts for a deal that has no reliable image yet:
//   (a) the deal's own page, when it is a retailer's own product or deal page: its og:image (plain fetch, no credits)
//   (b) Tavily Search for the deal's title limited to the retailer's domain, with image descriptions:
//       the matching product page's og:image, then search images whose description names this product
//   (c) Tavily Extract of the best matching retailer page, taking an image only with proof (the product's id or name in the URL)
// Never taken: an og:image from an editorial roundup (cnet, forbes, a blog). It is the article hero, not the product.
//
// Every candidate must pass, in order: the title/description match (brand + every model and size token), a Token Factory
// yes/no ("same product?", default no), the shared URL rules (app/image-rules.js), a real fetch (status 200, an image
// content type, real size of at least 200 px and a photo-like shape), and a vision check of the picture itself: a clean
// photo of this product, not an infographic, collage, ad, decoration or a different model. A title that names no product
// line ("Sony wireless headphones") gets no image: several different products would fit it.
// Everything is cached in scripts/output/images-cache.json, so a re-run costs nothing.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { MIN_IMAGE_SIDE, acceptableImageUrl } from "../app/image-rules.js";
import { resolveStore } from "../app/store-list.js";

const PAGE_UA = "BlackFridayBuster/0.1 (open-source local deal deck)";
const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const LOCAL_REFERER = "http://localhost:3000/";
const TAVILY_GAP_MS = 450;        // keeps searches and extracts at about 2 a second
const PROBE_BYTES = 131072;       // enough of the file to read its size
const MAX_CANDIDATES = 6;         // images probed per deal before giving up

// Hosts that serve each retailer's product images. A search image is accepted only from these (or the retailer's domain).
const STORE_IMAGE_HOSTS = {
  "best-buy": ["bbystatic.com"],
  "under-armour": ["underarmour.scene7.com", "underarmour.com"],
  ollies: ["ollies.com", "ollies.us"],
  target: ["target.scene7.com", "target.com"],
  walmart: ["walmartimages.com", "walmart.com"],
  "home-depot": ["thdstatic.com", "homedepot.com"],
  lowes: ["mobileimages.lowes.com", "lowes.com"],
  nike: ["static.nike.com", "nike.com"],
  dicks: ["dks.scene7.com", "dickssportinggoods.com"],
  kohls: ["media.kohlsimg.com", "kohls.com"],
  macys: ["slimages.macysassets.com", "macys.com"],
  amazon: ["m.media-amazon.com", "amazon.com"],
};
const EDITORIAL_SUBDOMAIN = /^(?:corporate|investors?|press|about|careers|news|blog)\./i;
const TRACKER_HOST = /facebook|doubleclick|googletagmanager|google-analytics|analytics|adservice|pixel|scorecardresearch|criteo/i;
// A product, deal or article page on a retailer (a collection or search page is not one product).
const PRODUCT_PATH = /\/(?:products?|p|dp|ip|pd|itm)\/|\.p(?:[?#]|$)|\/site\/.+\/\d+\.p|\/blogs?\/[^/]+\/[^/]+/i;
// An image whose description says it is a diagram, an ad or a graphic is not a photo of the product.
const NON_PHOTO_DESCRIPTION = /\b(?:dimensions?|diagram|infographic|chart|size comparison|specifications?|illustration|logo|badge)\b/i;
const MIN_ASPECT = 0.4;
const MAX_ASPECT = 2.2;
const BANNER_NAME = /hero|banner|promo|campaign|black[-_]?friday|cyber|sale|collection|homepage/i;
const PROMO_TITLE = /\d+\s*%|\bup to\b|\bextra\b|\bsitewide\b|\bstorewide\b|\bselect\b|\byour (?:first )?order\b|\bthree or more\b|\bentire\b|\boutlet items\b|\bbuy \w+ or more\b|\ball\b.*\bitems\b/i;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hostOf = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
};
const pathOf = (url) => {
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
};
const hostIn = (host, list) => list.some((d) => host === d || host.endsWith(`.${d}`));

// ---------- matching a deal title against a page title or an image description ----------

const FILLER = new Set(["the", "a", "an", "and", "with", "for", "of", "in", "on", "at", "to", "by", "from", "new", "class", "series", "edition",
  "pack", "pk", "ct", "count", "select", "only", "off", "save", "deal", "deals", "sale", "black", "friday", "cyber", "monday", "inch", "us"]);
const AUDIENCE = new Set(["mens", "womens", "boys", "girls", "kids", "youth", "toddler", "infant", "unisex"]);

function norm(text) {
  return String(text).toLowerCase()
    .replace(/[’‘`]/g, "'").replace(/[″”“]/g, '"')
    .replace(/(\d+(?:\.\d+)?)\s*(?:-\s*)?(?:inch(?:es)?\b|in\b\.?|")/g, "$1 ")
    .replace(/(\d)\s+(gb|tb|w|oz|qt|mm|mp|hz)\b/g, "$1$2")
    .replace(/'/g, "");
}
// Words of a deal title, each hyphenated part on its own ("WH-1000XM5" gives "wh" and "1000xm5").
const parts = (text) => norm(text).match(/[a-z0-9]+/g) ?? [];
// Words of a candidate, with hyphenated runs also joined ("wh-1000xm5" also gives "wh1000xm5").
function wordSet(text) {
  const t = norm(text);
  const set = new Set(t.match(/[a-z0-9]+/g) ?? []);
  for (const m of t.matchAll(/[a-z0-9]+(?:-[a-z0-9]+)+/g)) set.add(m[0].replace(/-/g, ""));
  return set;
}
const has = (set, w) => set.has(w) || set.has(w.replace(/s$/, "")) || set.has(`${w}s`);

function dealTerms(deal, store) {
  const storeWords = new Set([...parts(store.name), ...store.aliases]);
  // "4 pack" and "512GB" do not change what the product looks like, so they are not required to match.
  const title = norm(deal.title).replace(/\b\d+\s*-?\s*(?:pack|pk|ct|count|piece|pc|pcs|set)\b/g, " ").replace(/\b\d+\s*(?:gb|tb|mb)\b/g, " ");
  const words = parts(title).filter((w) => !FILLER.has(w) && !storeWords.has(w));
  return {
    brand: words.find((w) => /^[a-z]+$/.test(w)) ?? null,
    model: words.filter((w) => /^(?=.*[a-z])(?=.*\d)[a-z0-9]+$/.test(w) && !/^\d+(?:st|nd|rd|th)$/.test(w)),
    numbers: words.filter((w) => /^[1-9]\d{0,3}$/.test(w) && !/^20[2-3]\d$/.test(w)),
    all: new Set(words),
    audience: words.filter((w) => AUDIENCE.has(w)),
    rest: words.filter((w) => /^[a-z]{3,}$/.test(w) && !AUDIENCE.has(w)),
  };
}

// Words that name a different edition when they are on the candidate but not in the deal ("Pro" for an Air, "Ultra" for a plain model).
const VARIANT_WORDS = ["ultra", "pro", "max", "plus", "mini", "lite", "se", "air", "fe", "elite"];
const SPEC_TOKEN = /^\d+(?:k|hz|gb|tb|mp|w|mm|oz|qt|in|inch|ft|lb|v|mah|nits|x\d+)$/;

// Brand, every model code and size, the audience (men's / women's), and most of the other descriptive words. The
// candidate must not name a different edition: no variant word and (for a title with no model code of its own) no
// model code that the deal title lacks.
function matchesProduct(text, t, headline = text) {
  if (!t.brand) return false;
  const set = wordSet(text);
  const head = wordSet(headline);
  if (!has(set, t.brand)) return false;
  if (![...t.model, ...t.numbers, ...t.audience].every((w) => has(set, w))) return false;
  // A title with a model code is pinned down by it; a generic title ("Sony headphones") must not land on a named edition.
  if (t.model.length === 0 && VARIANT_WORDS.some((w) => head.has(w) && !t.all.has(w))) return false;
  if (t.model.length === 0 && [...head].some((w) => w.length >= 5 && /^(?=.*[a-z])(?=.*\d)[a-z0-9]+$/.test(w) && !SPEC_TOKEN.test(w) && !/^\d+(?:st|nd|rd|th)$/.test(w) && !t.all.has(w))) return false;
  if (t.rest.length === 0) return true;
  const hit = t.rest.filter((w) => has(set, w)).length;
  return hit / t.rest.length >= (t.model.length + t.numbers.length > 0 ? 0.5 : 0.8);
}

// A store-wide or category promo: the words that make it distinctive ("outlet", "appliances") must be on the page.
const PROMO_FILLER = new Set(["extra", "off", "select", "items", "item", "your", "first", "order", "orders", "buy", "three", "more", "entire", "all", "sitewide", "storewide", "up", "any", "when", "you", "devices", "deals"]);
function promoWords(deal, store) {
  const storeWords = new Set([...parts(store.name), ...store.aliases]);
  return parts(deal.title).filter((w) => /^[a-z]{3,}$/.test(w) && !FILLER.has(w) && !PROMO_FILLER.has(w) && !storeWords.has(w));
}
const SALE_PAGE = /black[-\s]?friday|cyber|sale|deals?|clearance|outlet|doorbusters?|collection/i;
function matchesPromoPage(text, words) {
  if (!SALE_PAGE.test(text)) return false;
  if (words.length === 0) return true;
  const set = wordSet(text);
  return words.filter((w) => has(set, w)).length / words.length >= 0.5;
}

// A generic-looking title ("UA Icon Fleece Men's Pants") is trusted only against a retailer page whose title says the same
// thing: every word of the deal is there, and at most one extra plain word (no model code, variant or audience word).
function exactTitlePage(pageTitle, t, store) {
  const storeWords = new Set([...parts(store.name), ...store.aliases]);
  const words = parts(pageTitle).filter((w) => !FILLER.has(w) && !storeWords.has(w));
  const set = new Set(words);
  const inDeal = (w) => t.all.has(w) || t.all.has(w.replace(/s$/, "")) || t.all.has(`${w}s`);
  if (![...t.all].every((w) => has(set, w))) return false;
  const extras = words.filter((w) => !inDeal(w));
  return extras.length <= 1 && extras.every((w) => /^[a-z]+$/.test(w) && !VARIANT_WORDS.includes(w) && !AUDIENCE.has(w));
}

export const isPromoDeal = (deal, store) => PROMO_TITLE.test(deal.title) || parts(deal.title)[0] === parts(store.name)[0];

function cleanTitle(title, store) {
  const storeRe = new RegExp(`^${store.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*[:\\-–]\\s*`, "i");
  return title.replace(storeRe, "").replace(/\s+/g, " ").trim().slice(0, 120);
}

// ---------- reading an image's real size from its first bytes ----------

function imageSize(buf) {
  if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  if (buf.length > 10 && buf.toString("ascii", 0, 4) === "GIF8") return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    for (let i = 2; i + 9 < buf.length;) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { i += 2; continue; }
      i += 2 + buf.readUInt16BE(i + 2);
    }
    return null;
  }
  if (buf.length > 30 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
    const kind = buf.toString("ascii", 12, 16);
    if (kind === "VP8 ") return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
    if (kind === "VP8L") {
      const [b0, b1, b2, b3] = [buf[21], buf[22], buf[23], buf[24]];
      return { w: 1 + (((b1 & 0x3f) << 8) | b0), h: 1 + (((b3 & 0xf) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)) };
    }
    if (kind === "VP8X") return { w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) };
  }
  // AVIF (and HEIC) keep the size in an "ispe" box: 4 bytes of version/flags, then width and height.
  const ispe = buf.indexOf("ispe");
  if (ispe !== -1 && buf.length > ispe + 16 && /ftyp(?:avif|avis|mif1|heic)/.test(buf.toString("latin1", 4, 16))) {
    return { w: buf.readUInt32BE(ispe + 8), h: buf.readUInt32BE(ispe + 12) };
  }
  return null;
}

// Retailer image CDNs shrink the picture when the address says so (Best Buy's search images say maxWidth=345, too soft
// for a phone card). Asking for up to 900 px stays sharp without the multi-megabyte original.
export function fullSizeUrl(url) {
  if (hostOf(url) === "underarmour.scene7.com" && /[?&]wid=/.test(url)) {
    return url.replace(/([?&]rp=)[^&]*/i, "$1standard-0pad%7Cpdp").replace(/([?&]wid=)\d+/i, "$1800").replace(/([?&]hei=)\d+/i, "$11000");
  }
  if (hostOf(url).endsWith("bbystatic.com")) return `${url.replace(/;max(?:Height|Width)=\d+/gi, "").replace(/\?.*$/, "")};maxHeight=900;maxWidth=900`;
  return url;
}

// Fetches the start of the image the way a browser would. { ok, reason, width, height, type }.
export async function probeImage(url, referer = null) {
  const headers = { "User-Agent": BROWSER_UA, Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8" };
  if (referer) headers.Referer = referer;
  let res;
  try {
    res = await fetch(url, { headers, redirect: "follow", signal: AbortSignal.timeout(12_000) });
  } catch (err) {
    return { ok: false, reason: `request failed (${err.cause?.code ?? err.name})` };
  }
  const type = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    return { ok: false, reason: `status ${res.status}`, type };
  }
  if (!/^https:\/\//.test(res.url) || !type.startsWith("image/") || type === "image/svg+xml") {
    await res.body?.cancel().catch(() => {});
    return { ok: false, reason: `not an https image (${type || "no type"})`, type };
  }
  const chunks = [];
  let total = 0;
  const reader = res.body.getReader();
  try {
    while (total < PROBE_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const buf = Buffer.concat(chunks);
  if (buf.length < 1500) return { ok: false, reason: `too small (${buf.length} bytes)`, type };
  const size = imageSize(buf);
  if (!size) return { ok: false, reason: "could not read the image size", type };
  if (Math.min(size.w, size.h) < MIN_IMAGE_SIDE) return { ok: false, reason: `only ${size.w}x${size.h}`, type, width: size.w, height: size.h };
  return { ok: true, type, width: size.w, height: size.h };
}

// ---------- the resolver ----------

const sameFormat = {
  type: "json_schema",
  json_schema: {
    name: "same_product",
    strict: true,
    schema: { type: "object", additionalProperties: false, properties: { same: { type: "boolean" } }, required: ["same"] },
  },
};
const SAME_PRODUCT_SYSTEM = `You check whether a retailer web page, or the description of an image on it, is about the same product as a deal. Answer same=true only if it clearly names the same product: same brand, same model and the same size or variant. A category or search page, a similar model, a different size, an accessory or a bundle is NOT the same. When unsure, answer false.`;
const photoFormat = {
  type: "json_schema",
  json_schema: {
    name: "photo_check",
    strict: true,
    schema: { type: "object", additionalProperties: false, properties: { clean_photo: { type: "boolean" }, shows_product: { type: "boolean" }, seen: { type: "string" } }, required: ["clean_photo", "shows_product", "seen"] },
  },
};
const promoPhotoFormat = {
  type: "json_schema",
  json_schema: {
    name: "promo_photo_check",
    strict: true,
    schema: { type: "object", additionalProperties: false, properties: { illustrates: { type: "boolean" }, seen: { type: "string" } }, required: ["illustrates", "seen"] },
  },
};
const PHOTO_SYSTEM = `You check a picture for a shopping deal card. clean_photo=true for a studio shot, or a photo of the product in use or in a room, where the product is clearly the subject. Text or logos shown on the product's own screen do not count against it. It is false for an infographic, spec sheet, dimensions diagram, collage of features, an ad with marketing text laid over it, a banner, a decoration, or a bundle that is mostly other items. shows_product=true only if the main item shown is the deal's product (same brand and kind of product; if a model name is printed on it, it must not contradict the deal). seen: what the picture shows in at most 15 words, including any model name printed on it.`;
const PROMO_PHOTO_SYSTEM = `You check a picture for a store promotion card. illustrates=true only if the picture is a sale banner or hero for that retailer, or a photo of products from the promoted category. It is false for decoration, patterns, icons, charts, logos, or products that have nothing to do with the offer. seen: what it shows in at most 15 words.`;
const SPECIFIC_SYSTEM = `Decide whether a deal title names a specific product model or product line (for example "Sony WH-1000XM5", "KitchenAid Artisan stand mixer", "Beats Studio Pro", "Oura Ring 5", "Ninja UltraCrush"), as opposed to only a brand plus a generic description (for example "Sony wireless noise cancelling headphones", "Insignia refrigerator", "Samsung smart TV"). specific=true only for the former.`;
const specificFormat = {
  type: "json_schema",
  json_schema: { name: "specific_title", strict: true, schema: { type: "object", additionalProperties: false, properties: { specific: { type: "boolean" } }, required: ["specific"] } },
};
const SAME_PROMO_SYSTEM = `You check whether a retailer web page is the retailer's own page for a promotion, so that a banner image from it fairly illustrates the offer. Answer same=true only if the page is that retailer's sale, Black Friday, outlet or category page that matches the offer. A page about something else, or a single unrelated product, is NOT a match. When unsure, answer false.`;

export function createImageResolver({ tavily, chat, storeFor = resolveStore, visionModel = "nvidia/Nemotron-3.5-Super-VL", cacheFile, retryNegatives = false, log = () => {} }) {
  const cache = existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, "utf8")) : {};
  for (const k of ["decisions", "searches", "extracts", "meta", "llm", "vision", "specific"]) cache[k] ??= {};
  const stats = { searches: 0, extractPages: 0, llm: 0, vision: 0, probes: 0, resolved: 0, none: 0, cached: 0, hotlink: {} };
  let nextTavilyAt = 0;
  let dirty = false;

  const save = () => {
    if (dirty) writeFileSync(cacheFile, JSON.stringify(cache));
    dirty = false;
  };

  async function tavilyCall(endpoint, body) {
    const wait = Math.max(0, nextTavilyAt - Date.now());
    nextTavilyAt = Math.max(Date.now(), nextTavilyAt) + TAVILY_GAP_MS;
    await sleep(wait);
    for (let attempt = 0; ; attempt++) {
      try {
        return await tavily(endpoint, body);
      } catch (err) {
        if (attempt < 3 && /\b(429|432|433|5\d\d)\b/.test(err.message)) {
          await sleep(1500 * 2 ** attempt);
          continue;
        }
        throw err;
      }
    }
  }

  async function search(query, store) {
    const key = `${store.slug}|${query}`;
    if (cache.searches[key]) return cache.searches[key];
    stats.searches++;
    const res = await tavilyCall("search", {
      query, include_domains: store.domains, max_results: 4, search_depth: "basic", include_images: true, include_image_descriptions: true,
    });
    const out = {
      results: (res.results ?? []).map((r) => ({ url: r.url, title: r.title ?? "", content: (r.content ?? "").slice(0, 500) })),
      images: (res.images ?? []).map((i) => (typeof i === "string" ? { url: i, description: "" } : { url: i.url, description: i.description ?? "" })),
    };
    cache.searches[key] = out;
    dirty = true;
    return out;
  }

  async function extractImages(url) {
    if (cache.extracts[url]) return cache.extracts[url];
    stats.extractPages++;
    const res = await tavilyCall("extract", { urls: [url], include_images: true, format: "text", timeout: 30 });
    const images = (res.results?.[0]?.images ?? []).filter((i) => typeof i === "string");
    cache.extracts[url] = images;
    dirty = true;
    return images;
  }

  // The page's own title and og:image by a plain fetch (no credits). Only ever called for a retailer's domain.
  async function pageMeta(url) {
    if (url in cache.meta) return cache.meta[url];
    let meta = null;
    try {
      const res = await fetch(url, { headers: { "User-Agent": PAGE_UA, Accept: "text/html" }, redirect: "follow", signal: AbortSignal.timeout(10_000) });
      if (res.ok && /html/i.test(res.headers.get("content-type") ?? "")) {
        const html = (await res.text()).slice(0, 400_000);
        const tag = (prop) => {
          const re = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']+)["']|<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']${prop}["']`, "i");
          const m = html.match(re);
          return m ? (m[1] ?? m[2]) : null;
        };
        const raw = tag("og:image:secure_url") ?? tag("og:image") ?? tag("twitter:image");
        let ogImage = null;
        try {
          ogImage = raw ? new URL(raw.replace(/&amp;/g, "&"), res.url).toString() : null;
        } catch { /* a malformed address is no image */ }
        meta = { finalUrl: res.url, title: (tag("og:title") ?? html.match(/<title[^>]*>([^<]*)/i)?.[1] ?? "").replace(/\s+/g, " ").trim(), ogImage };
      }
    } catch { /* an unreachable page has no meta; the search route still works */ }
    cache.meta[url] = meta;
    dirty = true;
    return meta;
  }

  async function sameProduct(system, deal, store, candidate) {
    const key = `${system === SAME_PROMO_SYSTEM ? "promo" : "product"}|${store.slug}|${deal.title}|${candidate.kind}|${candidate.title}|${candidate.text}`.slice(0, 600);
    if (key in cache.llm) return cache.llm[key];
    stats.llm++;
    let same = false;
    try {
      const reply = await chat("images", sameFormat, 60, [
        { role: "system", content: system },
        { role: "user", content: JSON.stringify({ deal: { title: deal.title, store: store.name }, candidate: { kind: candidate.kind, title: candidate.title, text: candidate.text.slice(0, 400), url: candidate.url } }) },
      ]);
      same = JSON.parse(reply).same === true;
    } catch (err) {
      log(`  (the same-product check failed for "${deal.title}": ${err.message}; counting it as no)`);
      return false; // not cached: a later run may succeed
    }
    cache.llm[key] = same;
    dirty = true;
    return same;
  }

  // Does the title name a specific product (line), so that one retailer page or photo can be trusted to be it?
  async function titleIsSpecific(deal, store) {
    const key = `${store.slug}|${deal.title}`;
    if (key in cache.specific) return cache.specific[key];
    stats.llm++;
    try {
      const reply = await chat("images", specificFormat, 60, [
        { role: "system", content: SPECIFIC_SYSTEM },
        { role: "user", content: JSON.stringify({ title: deal.title, store: store.name }) },
      ]);
      cache.specific[key] = JSON.parse(reply).specific === true;
      dirty = true;
      return cache.specific[key];
    } catch (err) {
      log(`  (the specific-title check failed for "${deal.title}": ${err.message}; counting it as generic)`);
      return false;
    }
  }

  // Looks at the picture itself. Default no: an error or an unreadable answer rejects the picture and is not cached.
  async function looksRight(deal, store, url, promo) {
    const key = `${promo ? "promo" : "product"}|${store.slug}|${deal.title}|${url}`;
    if (key in cache.vision) return cache.vision[key];
    stats.vision++;
    const content = [{ type: "text", text: `${promo ? "Promotion" : "Deal"}: ${deal.title} (${store.name})` }, { type: "image_url", image_url: { url } }];
    for (const maxTokens of [2500, 6000]) {
      try {
        const reply = await chat("vision", promo ? promoPhotoFormat : photoFormat, maxTokens, [
          { role: "system", content: promo ? PROMO_PHOTO_SYSTEM : PHOTO_SYSTEM },
          { role: "user", content },
        ], visionModel);
        const r = JSON.parse(reply);
        const ok = promo ? r.illustrates === true : r.clean_photo === true && r.shows_product === true;
        if (!ok) log(`  vision says no (${r.seen}): ${url.slice(0, 80)}`);
        cache.vision[key] = ok;
        dirty = true;
        return ok;
      } catch (err) {
        if (!/cut off/.test(err.message)) {
          log(`  (the picture check failed for "${deal.title}": ${err.message}; rejecting it)`);
          return false;
        }
      }
    }
    return false;
  }

  const isRetailerUrl = (url, store) => {
    const host = hostOf(url);
    return hostIn(host, store.domains) && !EDITORIAL_SUBDOMAIN.test(host);
  };
  const imageHostOk = (url, store) => {
    const host = hostOf(url);
    if (TRACKER_HOST.test(host)) return false;
    if (hostIn(host, [...store.domains, ...(STORE_IMAGE_HOSTS[store.slug] ?? [])])) return true;
    // A chain's image host usually carries its name (walmartimages.com, neweggimages.com); a shared CDN does not count.
    const label = (store.domains[0] ?? "").split(".").slice(-2, -1)[0] ?? "";
    return label.length >= 4 && host.split(".").slice(-2, -1)[0].startsWith(label);
  };

  // The first of these candidates that loads is the answer. Returns { url, source, hotlink } or null.
  async function firstThatLoads(candidates, deal, store, promo = false) {
    const seen = new Set();
    for (const c of candidates) {
      if (seen.size >= MAX_CANDIDATES) break;
      if (seen.has(c.url) || !acceptableImageUrl(c.url)) continue;
      seen.add(c.url);
      stats.probes++;
      let url = fullSizeUrl(c.url);
      let plain = await probeImage(url);
      if (!plain.ok && url !== c.url) {
        url = c.url;
        plain = await probeImage(url);
      }
      if (!plain.ok) {
        log(`  rejected ${c.url.slice(0, 90)} (${plain.reason})`);
        continue;
      }
      const aspect = plain.width / plain.height;
      if (aspect < MIN_ASPECT || aspect > MAX_ASPECT) {
        log(`  rejected ${c.url.slice(0, 90)} (a ${plain.width}x${plain.height} strip, not a photo)`);
        continue;
      }
      if (!(await looksRight(deal, store, url, promo))) continue;
      const local = await probeImage(url, LOCAL_REFERER);
      const host = hostOf(url);
      const h = (stats.hotlink[host] ??= { ok: 0, blockedWithReferer: 0, sizes: [] });
      if (local.ok) h.ok++;
      else h.blockedWithReferer++;
      h.sizes.push(`${plain.width}x${plain.height}`);
      return { url, source: c.source, hotlink: { noReferer: true, localhostReferer: local.ok }, width: plain.width, height: plain.height };
    }
    return null;
  }

  // The best image of a page from Tavily Extract, taken only with proof it is this page's product: the product id from
  // the page's address, or most of the product's name, appears in the image's address.
  function proofImages(images, pageUrl, deal, store) {
    const ids = [...pathOf(pageUrl).matchAll(/\d{5,}/g)].map((m) => m[0]);
    const nameWords = parts(deal.title).filter((w) => w.length >= 4 && !FILLER.has(w));
    return images
      .filter((u) => acceptableImageUrl(u) && imageHostOk(u, store))
      .map((u, i) => {
        const lower = norm(decodeURIComponent(u.split("?")[0]));
        const idHit = ids.some((id) => u.includes(id));
        const nameHits = nameWords.filter((w) => lower.includes(w)).length;
        return { url: u, score: (idHit ? 10 : 0) + (nameHits >= 2 ? 6 : 0) - i * 0.01 };
      })
      .filter((x) => x.score >= 6)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.url);
  }

  async function productImage(deal, store) {
    const terms = dealTerms(deal, store);
    if (!terms.brand) return { none: "the title has no brand to match on" };
    // A title with a model code or size pins the product down; otherwise ask whether it names a product line at all.
    const specific = terms.model.length > 0 || terms.numbers.length > 0 || (await titleIsSpecific(deal, store));
    const titleOk = (title) => specific || exactTitlePage(title, terms, store);
    const pageText = (r) => `${r.title} ${r.content ?? ""} ${pathOf(r.url).replace(/[-_/]/g, " ")}`;
    const pageHead = (r) => `${r.title} ${pathOf(r.url).replace(/[-_/]/g, " ")}`;

    // (a) the deal's own page, when it is a retailer's own product page
    if (isRetailerUrl(deal.sourceUrl, store) && PRODUCT_PATH.test(pathOf(deal.sourceUrl))) {
      const meta = await pageMeta(deal.sourceUrl);
      if (meta?.ogImage && titleOk(meta.title) && matchesProduct(`${meta.title} ${pathOf(deal.sourceUrl).replace(/[-_/]/g, " ")}`, terms)) {
        const found = await firstThatLoads([{ url: meta.ogImage, source: "retailer-product-page" }], deal, store);
        if (found) return found;
      }
    }

    // (b) search the retailer's own site for this product
    const found = await search(`${cleanTitle(deal.title, store)} ${store.name}`, store);
    const pages = [];
    for (const r of found.results) {
      if (pages.length >= 2) break;
      if (!isRetailerUrl(r.url, store) || !PRODUCT_PATH.test(pathOf(r.url)) || !titleOk(r.title) || !matchesProduct(pageText(r), terms, pageHead(r))) continue;
      if (await sameProduct(SAME_PRODUCT_SYSTEM, deal, store, { kind: "page", title: r.title, text: r.content, url: r.url })) pages.push(r);
    }
    for (const page of pages) {
      const meta = await pageMeta(page.url);
      if (meta?.ogImage && matchesProduct(`${meta.title} ${pathOf(page.url).replace(/[-_/]/g, " ")}`, terms)) {
        const hit = await firstThatLoads([{ url: meta.ogImage, source: "retailer-product-page" }], deal, store);
        if (hit) return hit;
      }
    }
    // Images in the search answer, each with a description of what it shows: it must name this product.
    const described = [];
    // For a generic-looking title the photo must come with an exact-title retailer page, not just a description.
    for (const img of specific || pages.length > 0 ? found.images : []) {
      if (described.length >= 5) break;
      if (!imageHostOk(img.url, store) || !acceptableImageUrl(img.url) || !img.description || NON_PHOTO_DESCRIPTION.test(img.description)) continue;
      if (hostOf(img.url).endsWith("bbystatic.com") && !/\/images\/products\//.test(img.url)) continue; // Best Buy keeps product shots there; the rest are marketing art
      if (!matchesProduct(img.description, terms)) continue;
      if (await sameProduct(SAME_PRODUCT_SYSTEM, deal, store, { kind: "image", title: pages[0]?.title ?? "", text: img.description, url: img.url })) {
        described.push({ url: img.url, source: "image-search" });
      }
    }
    // Best Buy's main product shot is named by SKU (6505727_rd.jpg); UUID-named pictures are gallery and marketing art.
    described.sort((a, b) => Number(/\/products\/\d{3,}\/\d+_/.test(b.url)) - Number(/\/products\/\d{3,}\/\d+_/.test(a.url)));
    const hit = await firstThatLoads(described, deal, store);
    if (hit) return hit;

    // (c) extract the matching page and take an image only with proof
    for (const page of pages) {
      const images = await extractImages(page.url);
      const proven = proofImages(images, page.url, deal, store).map((url) => ({ url, source: "retailer-product-page" }));
      const picked = await firstThatLoads(proven, deal, store);
      if (picked) return picked;
    }
    return { none: pages.length || described.length ? "no image on the matching page could be verified" : "no matching retailer page or image" };
  }

  async function promoImage(deal, store) {
    const words = promoWords(deal, store);
    const query = `${store.name} ${cleanTitle(deal.title, store).replace(/\b(?:when you buy|your (?:first )?order)\b/gi, "")} Black Friday`;
    const found = await search(query, store);
    const pages = [];
    for (const r of found.results) {
      if (pages.length >= 2) break;
      if (!isRetailerUrl(r.url, store) || !matchesPromoPage(pageText(r), words)) continue;
      if (await sameProduct(SAME_PROMO_SYSTEM, deal, store, { kind: "page", title: r.title, text: r.content, url: r.url })) pages.push(r);
    }
    function pageText(r) {
      return `${r.title} ${r.content ?? ""} ${pathOf(r.url).replace(/[-_/]/g, " ")}`;
    }
    for (const page of pages) {
      const meta = await pageMeta(page.url);
      if (meta?.ogImage) {
        const hit = await firstThatLoads([{ url: meta.ogImage, source: "retailer-promo-page" }], deal, store, true);
        if (hit) return hit;
      }
      const images = (await extractImages(page.url)).filter((u) => acceptableImageUrl(u) && imageHostOk(u, store));
      const ordered = [...images.filter((u) => BANNER_NAME.test(u)), ...images].map((url) => ({ url, source: "retailer-promo-page" }));
      const hit = await firstThatLoads(ordered, deal, store, true);
      if (hit) return hit;
    }
    return { none: pages.length ? "no banner on the matching promo page could be verified" : "no matching retailer promo page" };
  }

  return {
    stats,
    save,
    cacheSize: () => Object.keys(cache.decisions).length,
    // Resolves one deal ({ title, store, sourceUrl, imageUrl?, imageReliable? }). Returns { url, source, checkedAt, ... } or null.
    async resolve(deal) {
      if (deal.imageUrl && deal.imageReliable) return null;
      const store = storeFor(deal.store);
      const key = `${store.slug}|${norm(deal.title)}`;
      const known = cache.decisions[key];
      if (known && (known.url || !retryNegatives)) {
        stats.cached++;
        return known.url ? known : null;
      }
      if (store.domains.length === 0) return null;
      let outcome;
      try {
        outcome = isPromoDeal(deal, store) ? await promoImage(deal, store) : await productImage(deal, store);
      } catch (err) {
        log(`Image lookup failed for "${deal.title}": ${err.message}`);
        return null; // a failure is not a "no": try again next run
      }
      const checkedAt = new Date().toISOString();
      if (outcome.url) {
        cache.decisions[key] = { ...outcome, checkedAt };
        stats.resolved++;
      } else {
        cache.decisions[key] = { none: outcome.none, checkedAt };
        stats.none++;
      }
      dirty = true;
      return outcome.url ? cache.decisions[key] : null;
    },
    why: (deal) => {
      const store = storeFor(deal.store);
      return cache.decisions[`${store.slug}|${norm(deal.title)}`]?.none ?? null;
    },
  };
}

// Runs fn over items with at most `limit` in flight.
export async function mapLimit(items, limit, fn) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
