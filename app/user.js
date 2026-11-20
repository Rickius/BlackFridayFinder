// The single local user: their stores, the deal-type filter, the time window, the home point and the onboarding answers.
import { db } from "./db.js";
import { DEFAULT_STORES } from "./stores.js";

const selectUser = db.prepare("SELECT * FROM user WHERE id = 1");

export function getUser() {
  const row = selectUser.get();
  const stores = JSON.parse(row.stores);
  return {
    stores,                                              // what the person picked ([] means they skipped it)
    activeStores: stores.length ? stores : DEFAULT_STORES, // what the app searches and shows
    typeFilter: row.type_filter,
    storeScope: row.store_scope,
    blockedStores: JSON.parse(row.blocked_stores),   // slugs
    when: row.when_window,
    home: row.home_lat === null ? null : { lat: row.home_lat, lon: row.home_lon },
    onboarded: Boolean(row.onboarded),
    likesAnswer: row.likes_answer,
    vibes: JSON.parse(row.vibes),
    place: row.place ? JSON.parse(row.place) : null,
  };
}

// Overwrites only the fields given. `home: null` forgets the home point.
export function saveUser({ stores, typeFilter, storeScope, blockedStores, when, home, onboarded, likesAnswer, vibes, place }) {
  const set = (column, value) => db.prepare(`UPDATE user SET ${column} = ? WHERE id = 1`).run(value);
  if (stores !== undefined) set("stores", JSON.stringify(stores));
  if (typeFilter !== undefined) set("type_filter", typeFilter);
  if (storeScope !== undefined) set("store_scope", storeScope);
  if (blockedStores !== undefined) set("blocked_stores", JSON.stringify(blockedStores));
  if (when !== undefined) set("when_window", when);
  if (home !== undefined) db.prepare("UPDATE user SET home_lat = ?, home_lon = ? WHERE id = 1").run(home?.lat ?? null, home?.lon ?? null);
  if (onboarded !== undefined) set("onboarded", Number(onboarded));
  if (likesAnswer !== undefined) set("likes_answer", likesAnswer);
  if (vibes !== undefined) set("vibes", JSON.stringify(vibes));
  if (place !== undefined) set("place", place && JSON.stringify(place));
}
