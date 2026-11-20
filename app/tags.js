// The tag vocabulary. Profile weights are keyed by these, and the model is only allowed to use them.

export const categories = ["tv", "laptop", "audio", "gaming", "phone", "appliance", "apparel", "shoes", "fitness", "home", "toys", "tools", "beauty", "closeout", "other"];

const categoryTags = {
  tv: "TVs",
  laptop: "laptops",
  audio: "headphones & audio",
  gaming: "gaming",
  phone: "phones & tablets",
  appliance: "appliances",
  apparel: "apparel",
  shoes: "shoes",
  fitness: "fitness gear",
  home: "home & kitchen",
  toys: "toys",
  tools: "tools",
  beauty: "beauty",
  closeout: "closeouts",
};

// The category tags, shown as chips in onboarding.
export const vibeTags = Object.values(categoryTags);
export const allTags = [...vibeTags, "doorbusters", "online deals", "big discount", "under $50"];

export const BIG_DISCOUNT_PERCENT = 40;
export const UNDER_PRICE = 50;

// How deep a deal's discount is, as a percent: the stated percent, or worked out from two verified prices.
export function discountPercent(deal) {
  if (deal.percent_off !== null && deal.percent_off !== undefined) return deal.percent_off;
  if (deal.sale_price !== null && deal.original_price > 0 && deal.sale_price < deal.original_price) {
    return Math.round((1 - deal.sale_price / deal.original_price) * 100);
  }
  return null;
}

// Where a deal is sold, for filtering, ranking and distance: the type the page states, else the model's labeled guess.
// Never use this to tell the person something as fact; for that use deal_type alone.
export const effectiveType = (deal) => deal.deal_type ?? deal.inferred_type ?? null;

// The tags a deal carries. By default the type tags follow the effective type (so ranking can use the guess);
// verifiedOnly keeps them to the type the page states, for anything the person or the ranker model reads as fact.
export function tagsFor(deal, { verifiedOnly = false } = {}) {
  const tags = [];
  if (categoryTags[deal.category]) tags.push(categoryTags[deal.category]);
  const type = verifiedOnly ? deal.deal_type : effectiveType(deal);
  if (type === "doorbuster" || type === "both") tags.push("doorbusters");
  if (type === "online" || type === "both") tags.push("online deals");
  const percent = discountPercent(deal);
  if (percent !== null && percent >= BIG_DISCOUNT_PERCENT) tags.push("big discount");
  if (deal.sale_price !== null && deal.sale_price !== undefined && deal.sale_price < UNDER_PRICE) tags.push("under $50");
  return tags;
}
