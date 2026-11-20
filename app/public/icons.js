// Line icons, drawn with currentColor, plus a few solid icons (fillIcon) for the tab bar and the deck buttons.
// Category icons are named after the deal categories.
const paths = {
  deck: 'M4 8l8-4 8 4-8 4zM4 12l8 4 8-4M4 16l8 4 8-4',
  x: 'M6 6l12 12M18 6L6 18',
  heart: 'M12 20s-7-4.5-7-10a4 4 0 0 1 7-2.5A4 4 0 0 1 19 10c0 5.5-7 10-7 10z',
  star: 'M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z',
  bookmark: 'M7 4h10v16l-5-4-5 4z',
  undo: 'M9 14L4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3',
  cal: 'M5 8a3 3 0 0 1 3-3h8a3 3 0 0 1 3 3v9a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3zM5 10h14M9 3v4M15 3v4',
  pin: 'M12 21s6-5.2 6-10a6 6 0 1 0-12 0c0 4.8 6 10 6 10zM12 8.8a2.2 2.2 0 1 0 0 4.4 2.2 2.2 0 0 0 0-4.4z',
  share: 'M12 15V4M8 8l4-4 4 4M5 12v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6',
  ext: 'M14 5h5v5M19 5l-8 8M17 14v4a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1h4',
  check: 'M5 12l5 5 9-10',
  down: 'M6 9l6 6 6-6',
  left: 'M15 6l-6 6 6 6',
  right: 'M9 6l6 6-6 6',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  spark: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.7 1.8 1.8.7-1.8.7L19 21l-.7-1.8-1.8-.7 1.8-.7z',
  arrow: 'M4 11l16-7-7 16-2-7z',
  edit: 'M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16zM14 6l4 4',
  reset: 'M4 12a8 8 0 1 1 3 6.2M4 19v-5h5',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4',
  off: 'M4 4l16 16M10 5.2A6 6 0 0 1 18 11c0 1.6-.7 3.2-1.7 4.6M6.4 7.2A6 6 0 0 0 6 11c0 4.8 6 10 6 10s1.3-1.1 2.7-2.8',
  tag: 'M3 12V4h8l10 10-8 8zM7.5 8.5h.01',
  store: 'M4 9l1.5-5h13L20 9M4 9v11h16V9M4 9a2.7 2.7 0 0 0 5.3 0 2.7 2.7 0 0 0 5.4 0A2.7 2.7 0 0 0 20 9M10 20v-5h4v5',
  bolt: 'M13 3L5 13h6l-1 8 8-10h-6z',
  bag: 'M5 8h14l-1 12H6zM9 8V6a3 3 0 0 1 6 0v2',
  copy: 'M9 8h10a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1zM5 16V5a1 1 0 0 1 1-1h10',
  home: 'M4 11l8-7 8 7M6 9.5V20h12V9.5M10 20v-5.5h4V20',
  tv: 'M3 6h18v11H3zM9 21h6M12 17v4',
  laptop: 'M5 6h14v9H5zM2.5 19h19',
  audio: 'M4 15v-3a8 8 0 0 1 16 0v3M4 15h3v5H5a1 1 0 0 1-1-1zM20 15h-3v5h2a1 1 0 0 0 1-1z',
  gaming: 'M7 8h10a4 4 0 0 1 4 4.5l-.7 3.5a2.2 2.2 0 0 1-3.9.8L15 14H9l-1.4 2.8a2.2 2.2 0 0 1-3.9-.8L3 12.5A4 4 0 0 1 7 8zM8 10.5v3M6.5 12h3M16 11.5h.01M18 13h.01',
  phone: 'M8 3h8a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM11 18h2',
  appliance: 'M6 3h12a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM5 7h14M12 11a4 4 0 1 0 0 8 4 4 0 0 0 0-8z',
  apparel: 'M8 4L3 7l2 4 2-1v10h10V10l2 1 2-4-5-3a4 4 0 0 1-8 0z',
  shoes: 'M3 17v-4l4 1 2-3 2 2 4 1a4 4 0 0 1 4 3v3H3zM8 14l1.5 1M11 13.5l1.2 1.2',
  fitness: 'M6 8v8M3 10v4M18 8v8M21 10v4M6 12h12',
  toys: 'M4 13h7v7H4zM13 13h7v7h-7zM8.5 6h7v7h-7z',
  tools: 'M4 20l9-9M11 7l4-4 6 6-4 4zM10 8l6 6',
  beauty: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.7 1.8 1.8.7-1.8.7L19 21l-.7-1.8-1.8-.7 1.8-.7z',
  closeout: 'M3 12V4h8l10 10-8 8zM7.5 8.5h.01',
  other: 'M5 8h14l-1 12H6zM9 8V6a3 3 0 0 1 6 0v2',
};

export const icon = (name, size = 20, strokeWidth = 2, fill = "none") =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="${fill}" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[name] ?? paths.bag}"/></svg>`;

export const categoryIcon = (category, size = 20, strokeWidth = 2) => icon(paths[category] ? category : "other", size, strokeWidth);

const solid = {
  tag: "M21.41 11.58l-9-9A2 2 0 0011 2H4a2 2 0 00-2 2v7c0 .55.22 1.05.59 1.41l9 9A2 2 0 0012 22c.55 0 1.05-.22 1.41-.59l7-7A2 2 0 0021.41 11.58zM6.5 8A1.5 1.5 0 116.5 5a1.5 1.5 0 010 3z",
  heart: "M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z",
  person: "M12 12a4 4 0 100-8 4 4 0 000 8zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z",
  search: "M15.5 14h-.79l-.28-.27A6.471 6.471 0 0016 9.5 6.5 6.5 0 109.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z",
  sliders: "M3 6h10.2a3 3 0 015.6 0H21v2h-2.2a3 3 0 01-5.6 0H3V6zm0 10h2.2a3 3 0 015.6 0H21v2H10.8a3 3 0 01-5.6 0H3v-2z",
  close: "M6.4 4.99L12 10.59l5.6-5.6 1.41 1.41-5.6 5.6 5.6 5.6-1.41 1.41-5.6-5.6-5.6 5.6-1.41-1.41 5.6-5.6-5.6-5.6L6.4 4.99z",
  open: "M7 7h10v10h-2V10.41l-8.29 8.3-1.42-1.42L13.59 9H7V7z",
  star: "M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z",
  undo: "M12.5 8c-2.65 0-5.05.99-6.9 2.6L2 7v9h9l-3.62-3.62c1.39-1.16 3.16-1.88 5.12-1.88 3.54 0 6.55 2.31 7.6 5.5l2.37-.78C21.47 11.1 17.35 8 12.5 8z",
};

export const fillIcon = (name, size = 24) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="${solid[name]}"/></svg>`;
