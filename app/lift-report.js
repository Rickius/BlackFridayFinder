// Prints the learning-lift metric. Usage: npm run lift
import { CAVEAT, FIRST_READ, SECOND_READ, liftStats } from "./lift.js";

const stats = liftStats();
const percent = (rate) => (rate === null ? "n/a" : `${Math.round(rate * 1000) / 10}%`);
const line = (name, g) => `${name.padEnd(7)} ${String(g.swipes).padStart(4)} swipes, ${String(g.rights).padStart(4)} right-swipes, rate ${percent(g.rate)}`;

console.log(line("ranked", stats.ranked));
console.log(line("random", stats.random));
console.log(stats.liftPoints === null
  ? "Lift: not enough data yet (needs at least one ranked and one random swipe)"
  : `Lift: ${stats.liftPoints > 0 ? "+" : ""}${stats.liftPoints} points (target: ranked at least 15 points higher)`);
console.log(`Swipes so far: ${stats.total}`);
console.log(`First read (${FIRST_READ} swipes): ${stats.firstReadReached ? "reached" : `not yet, ${FIRST_READ - stats.total} to go`}`);
console.log(`Second read (${SECOND_READ} swipes): ${stats.secondReadReached ? "reached" : `not yet, ${SECOND_READ - stats.total} to go`}`);
console.log(CAVEAT);
