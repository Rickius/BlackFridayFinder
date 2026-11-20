// The hard constraints. The server applies them to the pool and the browser to cards it already holds,
// so a changed limit takes effect on the next card. Only a verified mismatch drops a deal: when the
// price or the distance is unknown, the deal stays.
//
// typeFilter: "all" | "doorbuster" | "online".
// - "doorbuster" keeps in-store-only deals. A deal sold both ways is an ordinary deal, not a doorbuster.
// - "online" keeps online deals and deals sold both ways.
// A type the page states (deal_type) wins. Otherwise the model's labeled guess (inferred_type) is used,
// because a filter that only matched the few verified types would show almost nothing.
// Distance only matters for a deal you would have to drive to: an in-store-only deal.
// storeScope: "all" | "mine" | "new". card.suggested is true when the deal's store is not one of the user's stores.
export function passesLimits(card, { typeFilter = "all", storeScope = "all", maxDistanceMiles, budgetCap }) {
  if (storeScope === "mine" && card.suggested) return false;
  if (storeScope === "new" && !card.suggested) return false;
  const type = card.deal_type ?? card.inferred_type ?? null;
  if (typeFilter === "doorbuster" && type !== "doorbuster") return false;
  if (typeFilter === "online" && type !== "online" && type !== "both") return false;
  if (type === "doorbuster" && card.distance_miles !== null && card.distance_miles > maxDistanceMiles) return false;
  if (budgetCap !== null && card.sale_price !== null && card.sale_price > budgetCap) return false;
  return true;
}
