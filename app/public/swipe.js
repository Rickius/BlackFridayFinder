import { deviceScale } from "./device.js";

// Drag gestures for the top card. Pointer events cover touch and mouse.

// While dragging, show the matching stamp early; on release, require a longer pull.
const liveIntent = (dx, dy) => (dy < -60 && -dy > Math.abs(dx) * 0.9 ? "up" : dx > 40 ? "right" : dx < -40 ? "left" : null);
const releaseIntent = (dx, dy) => (dy < -110 && -dy > Math.abs(dx) * 0.9 ? "up" : dx > 100 ? "right" : dx < -100 ? "left" : null);

// onMove(dx, dy, intent) while dragging, onRelease(direction or null) after a drag, onTap() for a tap.
export function attachSwipe(card, { onMove, onRelease, onTap }) {
  let startX = 0;
  let startY = 0;
  let dx = 0;
  let dy = 0;
  let dragging = false;
  let moved = false;

  card.style.touchAction = "none";

  card.addEventListener("pointerdown", (e) => {
    if (e.target.closest("[data-nodrag]")) return;
    startX = e.clientX;
    startY = e.clientY;
    dx = dy = 0;
    dragging = true;
    moved = false;
    card.setPointerCapture(e.pointerId);
  });

  card.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const k = deviceScale();
    dx = (e.clientX - startX) / k;
    dy = (e.clientY - startY) / k;
    if (Math.hypot(dx, dy) > 7) moved = true;
    if (moved) onMove(dx, dy, liveIntent(dx, dy));
  });

  const finish = (cancelled) => {
    if (!dragging) return;
    dragging = false;
    if (!moved) {
      if (!cancelled) onTap();
      return;
    }
    onRelease(cancelled ? null : releaseIntent(dx, dy));
  };
  card.addEventListener("pointerup", () => finish(false));
  card.addEventListener("pointercancel", () => finish(true));
}

// Slides the card off screen in the swipe direction. Resolves when it is gone.
export function flyAway(card, direction) {
  const w = innerWidth;
  const h = innerHeight;
  const target = {
    right: `translate(${w}px,-20px) rotate(14deg)`,
    left: `translate(${-w}px,-20px) rotate(-14deg)`,
    up: `translate(0,${-h}px)`,
  }[direction];
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const animation = card.animate(
    [{ transform: getComputedStyle(card).transform, opacity: 1 }, { transform: target, opacity: 0 }],
    { duration: reduceMotion ? 1 : 280, easing: "ease-out", fill: "forwards" },
  );
  return animation.finished;
}
