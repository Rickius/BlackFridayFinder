// The learning-lift metric from the PRD: right-swipe rate on ranked cards minus right-swipe rate on random
// cards, over all swipes. A "right-swipe" is a save or a must-do.
import { db } from "./db.js";

export const FIRST_READ = 100;
export const SECOND_READ = 200;
export const CAVEAT = "Directional, not statistical proof. With about 20 random swipes at the first read the random rate "
  + "swings by roughly 11 points either way, so a 15-point gap is a strong hint and the 200-swipe read is the one to trust.";

const selectBySource = db.prepare(
  "SELECT source, COUNT(*) AS swipes, SUM(action IN ('save', 'must')) AS rights FROM swipes WHERE source IS NOT NULL GROUP BY source");

export function liftStats() {
  const bySource = Object.fromEntries(selectBySource.all().map((row) => [row.source, row]));
  const group = (source) => {
    const { swipes = 0, rights = 0 } = bySource[source] ?? {};
    return { swipes, rights, rate: swipes ? rights / swipes : null };
  };
  const ranked = group("ranked");
  const random = group("random");
  const total = db.prepare("SELECT COUNT(*) AS n FROM swipes").get().n;
  return {
    ranked,
    random,
    liftPoints: ranked.rate !== null && random.rate !== null ? Math.round((ranked.rate - random.rate) * 1000) / 10 : null,
    total,
    firstReadReached: total >= FIRST_READ,
    secondReadReached: total >= SECOND_READ,
  };
}
