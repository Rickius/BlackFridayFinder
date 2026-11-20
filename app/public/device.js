// The iPhone mock on wide screens: the whole device is scaled down to fit the window, and the drag code is told how
// much smaller the screen is than its own pixels, so a card follows the finger or cursor exactly.
const DEVICE = { width: 417, height: 876, margin: 40 };

const wide = () => matchMedia("(min-width: 520px)").matches;

// 1 on a real phone, where there is no frame.
export const deviceScale = () => (wide() ? Number(getComputedStyle(document.documentElement).getPropertyValue("--s")) || 1 : 1);

function fit() {
  const s = Math.min(1, (innerHeight - DEVICE.margin) / DEVICE.height, (innerWidth - DEVICE.margin) / DEVICE.width);
  document.documentElement.style.setProperty("--s", String(Math.max(0.4, Math.round(s * 1000) / 1000)));
}

fit();
addEventListener("resize", fit);
