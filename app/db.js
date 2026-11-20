import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dbPath = process.env.DB_PATH || resolve(projectRoot, "data", "blackfriday.db");

mkdirSync(dirname(dbPath), { recursive: true });
export const db = new DatabaseSync(dbPath);
// A search imports deals from another process while the app is running; wait a moment for a lock instead of failing.
db.exec("PRAGMA busy_timeout = 5000");

db.exec(`
  CREATE TABLE IF NOT EXISTS deals (
    id              INTEGER PRIMARY KEY,
    title           TEXT NOT NULL,
    store           TEXT NOT NULL,     -- display name, e.g. "Best Buy"
    store_slug      TEXT NOT NULL,
    deal_type       TEXT CHECK (deal_type IN ('doorbuster', 'online', 'both')),  -- null = the page does not say
    deal_type_quote TEXT,
    inferred_type   TEXT CHECK (inferred_type IN ('doorbuster', 'online', 'both')),  -- a labeled guess, never verified
    inferred_reason TEXT,              -- one short line saying why, at most 80 characters
    sale_price     REAL,              -- verified only; null when the page quote did not check out
    original_price  REAL,
    percent_off     REAL,
    discount_text   TEXT,              -- built from verified quotes only, e.g. "Up to 50% off"
    price_verified  INTEGER NOT NULL DEFAULT 0,
    valid_from      TEXT,              -- YYYY-MM-DD, null = not listed
    valid_to        TEXT,
    window_text     TEXT,              -- as the page words it, e.g. "Fri 5am-11am"
    code            TEXT,
    category        TEXT NOT NULL,
    source_url      TEXT NOT NULL,
    image_url       TEXT,
    image_reliable  INTEGER NOT NULL DEFAULT 0,
    image_source    TEXT CHECK (image_source IN ('retailer-product-page', 'retailer-promo-page', 'image-search')),
    image_checked_at TEXT,
    claims          TEXT NOT NULL,     -- JSON, the source quotes
    region          TEXT,              -- the place slug the search ran for; null shows everywhere
    fetched_at      TEXT NOT NULL,
    imported_at     TEXT NOT NULL,
    UNIQUE (source_url, title)
  );

  -- Branches of a chain near a place, found once with OpenStreetMap Nominatim and cached here.
  CREATE TABLE IF NOT EXISTS store_locations (
    id         INTEGER PRIMARY KEY,
    region     TEXT NOT NULL,
    store_slug TEXT NOT NULL,
    name       TEXT NOT NULL,
    address    TEXT,
    lat        REAL NOT NULL,
    lon        REAL NOT NULL,
    UNIQUE (region, store_slug, lat, lon)
  );

  -- Chains the planner proposed besides the person's own stores, with its one-line reason. Whether a deal is "suggested"
  -- is not stored: it is worked out when a card is built, against the stores the person has right now.
  CREATE TABLE IF NOT EXISTS store_suggestions (
    region     TEXT NOT NULL,
    slug       TEXT NOT NULL,
    name       TEXT NOT NULL,
    domain     TEXT,
    reason     TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (region, slug)
  );

  CREATE TABLE IF NOT EXISTS swipes (
    id         INTEGER PRIMARY KEY,
    deal_id    INTEGER NOT NULL REFERENCES deals(id),
    action     TEXT NOT NULL CHECK (action IN ('save', 'pass', 'must')),
    source     TEXT CHECK (source IN ('ranked', 'random')),  -- ranked = chosen by the profile, random = the exploration slice
    reason     TEXT,           -- vibe, far, pricey or did: the chip tapped after a pass
    delta      TEXT,           -- JSON {tag: amount}: what this swipe added to the weights
    undo       TEXT,           -- JSON: the limits as they were before this swipe's chip
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS saved_items (
    deal_id  INTEGER PRIMARY KEY REFERENCES deals(id),
    fav      INTEGER NOT NULL DEFAULT 0,
    saved_at TEXT NOT NULL,
    done     TEXT CHECK (done IN ('got', 'loved')),
    done_at  TEXT
  );

  -- One local user, so one row each.
  CREATE TABLE IF NOT EXISTS user (
    id           INTEGER PRIMARY KEY CHECK (id = 1),
    stores       TEXT NOT NULL DEFAULT '[]',     -- JSON list of store display names, empty = the default stores
    type_filter  TEXT NOT NULL DEFAULT 'all' CHECK (type_filter IN ('all', 'doorbuster', 'online')),
    store_scope  TEXT NOT NULL DEFAULT 'all' CHECK (store_scope IN ('all', 'mine', 'new')),
    blocked_stores TEXT NOT NULL DEFAULT '[]',   -- JSON list of store slugs the person said no to
    when_window  TEXT NOT NULL DEFAULT 'weekend',
    home_lat     REAL,              -- the current home point only, overwritten, never a history
    home_lon     REAL,
    onboarded    INTEGER NOT NULL DEFAULT 0,
    likes_answer TEXT,              -- what they are looking for, as typed
    vibes        TEXT NOT NULL DEFAULT '[]',
    place        TEXT               -- JSON from app/place.js
  );

  CREATE TABLE IF NOT EXISTS profile (
    id                   INTEGER PRIMARY KEY CHECK (id = 1),
    weights              TEXT NOT NULL DEFAULT '{}',   -- JSON {tag: -1..1}
    max_distance_miles   REAL NOT NULL DEFAULT 30,
    budget_cap           REAL,                         -- null = no cap
    pass_reasons         TEXT NOT NULL DEFAULT '{}',   -- JSON {reason: count}
    narrative            TEXT NOT NULL DEFAULT '',
    narrative_edited     INTEGER NOT NULL DEFAULT 0,   -- 1 until an update has folded the user's edit in
    decayed_at           TEXT,                         -- weights are halved every HALF_LIFE_DAYS from here
    last_update_swipe_id INTEGER NOT NULL DEFAULT 0,   -- the model has seen swipes up to this id
    updated_at           TEXT,                         -- when the model last rewrote it (or it was reset)
    version              INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS profile_log (
    id         INTEGER PRIMARY KEY,
    created_at TEXT NOT NULL,
    kind       TEXT NOT NULL,      -- update, chip, edit, reset, onboarding, loved
    text       TEXT NOT NULL,
    diff       TEXT,               -- JSON, for model updates
    swipe_id   INTEGER             -- set for chips, so undo can remove the entry
  );

  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

  INSERT OR IGNORE INTO user (id) VALUES (1);
  INSERT OR IGNORE INTO profile (id) VALUES (1);
`);

// Columns added after the first schema. CREATE TABLE IF NOT EXISTS does not touch a table that already exists.
function addColumn(table, column, definition) {
  const exists = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
  if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
// The model's labeled guess at where a deal is sold. deal_type stays quote-verified only; this never fills it.
addColumn("deals", "inferred_type", "TEXT CHECK (inferred_type IN ('doorbuster', 'online', 'both'))");
addColumn("deals", "inferred_reason", "TEXT");
addColumn("deals", "image_source", "TEXT CHECK (image_source IN ('retailer-product-page', 'retailer-promo-page', 'image-search'))");
addColumn("deals", "image_checked_at", "TEXT");
addColumn("user", "store_scope", "TEXT NOT NULL DEFAULT 'all' CHECK (store_scope IN ('all', 'mine', 'new'))");
addColumn("user", "blocked_stores", "TEXT NOT NULL DEFAULT '[]'");

export function inTransaction(work) {
  db.exec("BEGIN");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
