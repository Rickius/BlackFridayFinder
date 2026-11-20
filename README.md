# BF Buster

A Tinder-style swipe deck of Black Friday deals near you, for any city. Swipe right to save, left to pass, up for a must-buy. The deck learns from your swipes. Every deal says whether it is a doorbuster (in store), online, or both; a type the page states is marked verified, otherwise it is a labeled guess. Besides the stores you pick, the app finds a few others you did not name and mixes their deals in.

Built on Node 22.13 or newer (it uses the built-in `node:sqlite`). No `npm install` is required.

## Quick start

```
cp .env.example .env     # then add TAVILY_API_KEY and NEBIUS_API_KEY
npm start                # http://127.0.0.1:3000
```

On first start the app loads the sample deck in `app/seed/deals.seed.json` (a real search for Charlotte, NC), so there is something to swipe right away. Answer the onboarding: your city, the stores you shop at, what you are looking for, how you shop. If your city is not the sample's, the app searches for you after onboarding, with live progress on the **Search** tab.

Both keys are needed to search. Get them at [app.tavily.com](https://app.tavily.com) and [tokenfactory.nebius.com](https://tokenfactory.nebius.com). Without `NEBIUS_API_KEY` the deck still works on the deals you already have, ranked by a plain score.

## How deals are found

| Step | What happens | Uses |
| --- | --- | --- |
| Plan | Turns "what are you looking for" into a few search queries, one store each. | Token Factory |
| Search | Per store: one search limited to the store's own site, one open search for its Black Friday ad, one for Cyber Monday online deals. | Tavily Search |
| Read | Fetches the text and images of every page found (up to 80). | Tavily Extract |
| Structure | Turns page text into deal records: title, store, prices, discount, where it is sold, dates, code. | Token Factory |
| Verify | Offers from another season (Halloween, Fourth of July, Easter and so on) and headlines that are not an offer are dropped. Every claim must carry an exact quote from the page, checked by literal string match inside the text around the deal's title. Prices and percents must appear in their own quote. On listing pages a second call confirms the price belongs to this product and not a neighbour. | Token Factory |
| Images | Looks for a photo of each deal on the retailer's own site (see below). | Tavily Search and Extract, Token Factory (text and vision) |
| Stores | For deals you could drive to, finds the nearest branches of the chain in your city and caches them. | OpenStreetMap Nominatim |
| Import | Adds the deals to your local database. Safe to re-run. | SQLite |

What a card promises, and when:

- **Price and discount** are shown only when their quote was found on the page. A price that fails the check is dropped, never guessed. A deal with no verified offer (a sale price, a stated percent off, or a stated dollars off) never reaches the deck.
- **Deal type** (doorbuster / online / both) is verified only when cue words appear in a quote found on the page ("in store only", "online only", "available in store and online", "doorbuster"). "Pick up in store" does not count. `deal_type` is never filled any other way.
- **Likely type** (`inferred_type`, with a one-line `inferred_reason`) is a labeled guess from the same structuring call. The model reads the text around the deal and where the page came from: a retailer's own page with a price and no store limit is probably online, a roundup that says doorbusters or limited hours is probably a doorbuster, a chain that sells both ways with no limit is probably both. It is kept only where the page does not say, it is never verified, and it never overrides `deal_type`. Cards carry both fields so the UI can show a verified badge or a "likely" badge. The Doorbusters/Online filter, the in-store distance rule, the nearest store and the taste tags all use the effective type (`deal_type`, else `inferred_type`). The ranker model never sees the guess, so a "why" line cannot state it as fact.
- **Dates** count only if the quote contains that calendar date. No date: the deal ships and the card says dates are not listed.
- **Images** are used only from a single-product page. Otherwise the card has no photo.
- Every card carries `fetched_at`, so you can see how old it is. Deals change fast and "while supplies last" cannot be verified: the card links to the source page.

## Images

A wrong product photo is worse than none, so a deal gets an image only from the retailer's own site and only when it is clearly that product. For each deal without a reliable image:

1. If the deal's own page is a retailer product page, its `og:image` (a plain fetch, no credits).
2. A Tavily search limited to the retailer's domain, with image descriptions: the matching page's `og:image`, then search images whose description names this product (brand, every model code and size, men's/women's).
3. A Tavily extract of the best matching page, taking an image only with proof (the product id or its name in the image address).

An `og:image` from an editorial roundup (CNET, Forbes, a blog) is never used: it is the article hero. Every candidate must also pass:

- a Token Factory yes/no, "is this page or description the same product?", defaulting to no;
- the URL rules in `app/image-rules.js` (https only; no logos, icons, sprites, placeholders, share cards or video thumbnails; nothing that asks for under 200 px);
- a real fetch: status 200, an `image/*` type, at least 200 px on each side, a photo-like shape (not a 4:1 banner), and it must load with no `Referer` and with a localhost one;
- a vision check by a Token Factory vision model (`VISION_MODEL`, default `nvidia/Nemotron-3.5-Super-VL`): a clean photo of this product, not an infographic, collage, ad, decoration or another model. A promo gets a banner or category photo from the retailer's own promo page, never decoration.

A title that names no product line ("Sony wireless headphones") gets an image only from a retailer page whose title says the same thing, since several different products would fit it. Cards carry `image_url`, `image_source` (`retailer-product-page`, `retailer-promo-page` or `image-search`) and `image_alt` (the deal title). Best Buy images are requested at up to 900 px, Under Armour at 800x1000.

`npm run images` backfills images for the seed and the database without redoing the search (`--seed-only`, `--db-only`, `--retry`, `--limit N`). Answers are cached in `scripts/output/images-cache.json`, so a re-run costs nothing. A deal costs about one Tavily search credit, plus an extract for some, and a few small Token Factory calls.

**Usage terms.** Images are not copied: the card links to the retailer's own image URL and links back to the source page, so they hotlink from the retailer's CDN. The three CDNs tested (Best Buy `pisces.bbystatic.com`, Under Armour `underarmour.scene7.com`, Ollie's `ollies.com`) served browsers with and without a `Referer`. Confirm each retailer's terms before a wider launch.

## Store discovery

The search also finds stores you did not pick. A planner (Token Factory, strict JSON) is given your stores, what you wrote you are looking for, your taste tags and the stores you blocked, and proposes up to 6 other real chains with Black Friday deals, each with its domain and a one-line reason ("Similar to Best Buy: big electronics and appliance sales"). Names and hostnames are validated, and your own and blocked stores are dropped. Each suggested store gets a lighter plan (one search on its own site and one open search, at most 8 pages), then the same structuring, verification, images and store lookups. A deal from any store outside the plan found on a page is dropped ("store not in plan"). Run it off with `--no-discover`.

- A deal is "suggested" when its store is not one of yours (the three defaults count as yours when you picked none). That is worked out when a card is built, so adding a store makes its deals yours at once. Cards carry `suggested` and `suggestion_reason`.
- `storeScope` (`all`, `mine`, `new`) is on the context bar. With `all`, 3 of every 10 cards are reserved for the best suggested deals; "why" lines for them start "A store you did not pick:".
- After a pass, "Not this store" (only on a suggested card) blocks the store; undo brings it back. Blocked stores are kept in `blockedStores`.
- Store affinity: saves and musts against passes per store, smoothed and capped at +-0.5, feed the score for any store; your own stores also get +0.4.
- The Taste tab lists "Stores we think you'll like" with the planner's reason and your saves and passes there.

**Cost.** Discovery adds about 12 Tavily searches, up to 48 extracted pages and roughly 130k Token Factory tokens to a full search, plus the image step for the extra deals.

## The three starter stores

| Store | What the data looks like | What to expect |
| --- | --- | --- |
| Best Buy | Specific products with sale and regular prices, mostly on deal pages and ad coverage. | The richest supply. Best Buy's own site is script-heavy, so many deals come from ad-coverage pages. |
| Ollie's Bargain Outlet | A closeout chain that is mostly in store, with deals in weekly-ad flyers (often images or PDFs). | The thinnest supply. A flyer that is only an image gives no text to verify. |
| Under Armour | Store-wide percent-off promotions, with codes and end dates, more than single products. | Few cards, each a store-level offer with a verified percent and often a code. |

Add more stores in onboarding or the Taste tab. A store the app does not know is searched by name. To give one its own domain, add it to `app/store-list.js`.

## Commands

```
npm start                                       # serve the app
npm run refresh -- --place "Charlotte, NC"      # search + find stores + import from the command line
npm run refresh -- --place "Austin, TX" --stores "Best Buy,Target"
npm run images                                  # find photos for deals that have none (seed and database)
npm run seed                                    # load app/seed/deals.seed.json into the database
npm run export-seed                             # write the deals for charlotte-nc in the database to app/seed/deals.seed.json
npm run import -- path/to/deals.json            # load deals from a file
npm run lift                                    # the learning-lift metric: ranked vs random right-swipe rate
```

Use a scratch database with `DB_PATH=/tmp/test.db npm start`. `node scripts/deals-search.js --place "Charlotte, NC" --cached` re-uses the pages from the last run, which skips Tavily and is the cheap way to work on the structuring and verification steps. A search uses a few dozen Tavily requests and a few hundred thousand model tokens, so be mindful of your own credits.

## How the deck learns

- **Onboarding** has four skippable steps (city, stores, what you are looking for, how you shop). Skip them all and the deck uses Best Buy, Ollie's and Under Armour.
- **Every swipe** nudges tag weights straight away. A bare pass lowers its tags a little. A reason chip after a pass takes its place: "Too far" lowers the max distance, "Too pricey" the budget cap, "Already have it" removes the deal and near-duplicates, "Not my style" lowers the category. Undo takes all of it back.
- **Every 10 swipes, and when you leave the app**, the profile updater model rewrites the weights and the narrative. The Taste tab shows the narrative (editable), the weights, your limits, and the change log.
- **Each batch of cards**: limits filter first (deal type as stated or guessed, distance for in-store deals, budget). About 1 card in 5 is then drawn at random; that slice is also the control for the learning-lift metric. The rest come from a score over the pool (taste, your stores, discount depth, price, distance, ending soon), cut to a shortlist of about 30 that the ranker model reorders and writes the "why this" line for. Lines that claim more than the data says (stock, a deal type the page does not state, a price that is not on the card) are replaced by a plain fact line.
- If a model call fails or times out, the old profile stays, the deck falls back to the score order, and the failure is printed in the server log.

## Models

One per role, each overridable in `.env`. All are plain instruct models.

| Role | Env var | Default |
| --- | --- | --- |
| Search: plan, structure, price recheck | `STRUCTURE_MODEL` | `Qwen/Qwen3-235B-A22B-Instruct-2507` |
| Onboarding parser | `PARSER_MODEL` | `Qwen/Qwen3-30B-A3B-Instruct-2507` |
| Ranker | `RANKER_MODEL` | `Qwen/Qwen3-235B-A22B-Instruct-2507` |
| Profile updater | `UPDATER_MODEL` | `NousResearch/Hermes-4-405B` |
| Photo check (vision) | `VISION_MODEL` | `nvidia/Nemotron-3.5-Super-VL` |

## Project layout

```
app/server.js              HTTP server and API
app/pipeline.js            runs a search from the app and reports progress
app/deals.js               the card, the pool a deck is drawn from, near-duplicates
app/deck.js                builds each batch of cards (score, ranker)
app/stores.js              store branches near a city (Nominatim, cached)
app/image-rules.js         what an accepted image may look like (shared by the resolver and the cards)
app/store-list.js          the stores the app knows and how names are matched
app/public/                the browser app (plain ES modules, no build step)
app/public/windows.js      the Black Friday windows, shared by server and browser
app/public/limits.js       the hard filters, shared by server and browser
app/seed/deals.seed.json   the sample deck loaded on first start
scripts/deals-search.js    the search pipeline
scripts/images.js          finds and checks a photo for a deal
scripts/backfill-images.js npm run images
scripts/locate-stores.js   nearest branches for a batch of deals
data/                      your database and search settings (gitignored)
```

## Privacy

Your city, one home point (rounded to about 100 m, only if you allow device location), swipes, saved list and taste profile are stored in `data/blackfriday.db` on your machine. The home point is used on the server to find the nearest store and its distance; the browser never gets store coordinates and the home point is not kept as history. Searches send your city, your stores and what you typed about what you want to Token Factory and Tavily.

## Attribution

Store branches and city lookups use OpenStreetMap data through Nominatim: (c) OpenStreetMap contributors, licensed under the ODbL. Requests are limited to one per second, carry a descriptive User-Agent, and results are cached.
