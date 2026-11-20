// A short confetti drop and a "Great find!" label for a saved deal. It lives in its own layer on top of the phone,
// ignores pointer events entirely (swiping, tapping and the buttons all keep working underneath), and removes itself.
// With reduced motion requested nothing moves: the caller shows its usual toast instead.

const COLORS = ["#79DEEB", "#817FFF", "#F49EFF", "#80AF9B", "#1F1E1E"];
const PIECES = 46;
const LIFETIME_MS = 2900;

const rand = (min, max) => min + Math.random() * (max - min);
const pick = (list) => list[Math.floor(Math.random() * list.length)];

export const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

let current = null;

// Each piece falls with plain CSS (see .celebrate i): the per-piece numbers go in as custom properties.
function piece(height) {
  const el = document.createElement("i");
  const round = Math.random() < 0.3;
  const size = rand(6, 11);
  const spin = rand(240, 900) * (Math.random() < 0.5 ? -1 : 1);
  el.style.cssText = [
    `left:${rand(2, 98)}%`,
    `width:${round ? size : size * 0.7}px`,
    `height:${round ? size : size * 1.5}px`,
    `background:${pick(COLORS)}`,
    round ? "border-radius:50%" : "",
    `--dx:${rand(-70, 70)}px`,
    `--fall:${height + 40}px`,
    `--spin:${spin}deg`,
    `animation-duration:${rand(1500, 2500)}ms`,
    `animation-delay:${rand(0, 350)}ms`,
  ].join(";");
  return el;
}

// `host` is the element the layer sits in (the phone), which clips it.
export function celebrate(host, label = "Great find!") {
  if (reducedMotion()) return false;
  current?.remove();
  const layer = document.createElement("div");
  layer.className = "celebrate";
  layer.setAttribute("aria-hidden", "true");
  for (let i = 0; i < PIECES; i++) layer.append(piece(host.clientHeight));
  const tag = document.createElement("div");
  tag.className = "greatfind";
  tag.textContent = label;
  layer.append(tag);
  host.append(layer);
  current = layer;
  setTimeout(() => {
    layer.remove();
    if (current === layer) current = null;
  }, LIFETIME_MS);
  return true;
}
