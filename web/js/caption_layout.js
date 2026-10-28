/** Pure region layout helpers for Ideogram 4 captions. No DOM. */

export function finiteCoord(value) {
  if (typeof value === "boolean" || value == null) return null;
  if (typeof value === "string") {
    if (value.trim() === "") return null;
  } else if (typeof value !== "number") {
    return null;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clampBboxAxis(value) {
  return Math.max(0, Math.min(1000, value));
}

/** Ideogram bbox is [ymin, xmin, ymax, xmax] in 0-1000, origin top-left. */
export function ideogramBboxToRect(bbox) {
  if (!Array.isArray(bbox) || bbox.length !== 4) return null;
  const coords = bbox.map(finiteCoord);
  if (coords.some((v) => v == null)) return null;
  let [ymin, xmin, ymax, xmax] = coords;
  if (ymin > ymax) [ymin, ymax] = [ymax, ymin];
  if (xmin > xmax) [xmin, xmax] = [xmax, xmin];
  ymin = clampBboxAxis(ymin);
  xmin = clampBboxAxis(xmin);
  ymax = clampBboxAxis(ymax);
  xmax = clampBboxAxis(xmax);
  return {
    x: xmin / 1000,
    y: ymin / 1000,
    w: (xmax - xmin) / 1000,
    h: (ymax - ymin) / 1000,
  };
}

function scaleAxis(value) {
  if (value >= 1) return 1000;
  if (value <= 0) return 0;
  return Math.max(0, Math.min(1000, Math.round(value * 1000)));
}

/** Editor x/y/w/h (0-1) to Ideogram [ymin, xmin, ymax, xmax], or null if unusable. */
export function rectToIdeogramBbox(box) {
  if (!box || typeof box !== "object") return null;
  const x = finiteCoord(box.x ?? 0);
  const y = finiteCoord(box.y ?? 0);
  const w = finiteCoord(box.w ?? 0);
  const h = finiteCoord(box.h ?? 0);
  if (x == null || y == null || w == null || h == null) return null;
  let ymin = scaleAxis(y);
  let xmin = scaleAxis(x);
  let ymax = scaleAxis(y + h);
  let xmax = scaleAxis(x + w);
  if (ymin > ymax) [ymin, ymax] = [ymax, ymin];
  if (xmin > xmax) [xmin, xmax] = [xmax, xmin];
  return [ymin, xmin, ymax, xmax];
}

export function fallbackRegion(index) {
  const i = Number.isInteger(index) && index >= 0 ? index : 0;
  const row = Math.floor(i / 4);
  const col = i % 4;
  return {
    x: 0.02 + col * 0.25,
    y: 0.02 + row * 0.17,
    w: 0.22,
    h: 0.14,
    nobbox: true,
  };
}

/** Caption text. Finite numbers are kept; other non-strings are dropped. */
export function captionText(value) {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

export function elementToRegion(el, idx) {
  if (!el || typeof el !== "object") return null;
  const box = {
    type: el.type === "text" ? "text" : "obj",
    text: captionText(el.text),
    desc: captionText(el.desc),
    palette: Array.isArray(el.color_palette) ? el.color_palette.slice() : [],
  };
  const rect = ideogramBboxToRect(el.bbox);
  if (rect) Object.assign(box, rect);
  else Object.assign(box, fallbackRegion(idx));
  return box;
}

export function regionCoordsFinite(b) {
  return !!b && [b.x, b.y, b.w, b.h].every((n) => typeof n === "number" && Number.isFinite(n));
}

const HEX6 = /^#[0-9A-F]{6}$/;
const HEX3 = /^#[0-9A-F]{3}$/;

/** Ideogram 4 accepts uppercase #RRGGBB. #RGB is expanded; anything else is dropped. */
export function normalizeHex(color) {
  if (typeof color !== "string") return null;
  const text = color.trim().toUpperCase();
  if (HEX6.test(text)) return text;
  if (HEX3.test(text)) return "#" + text.slice(1).split("").map((ch) => ch + ch).join("");
  return null;
}

export function cleanPalette(colors, limit) {
  const out = [];
  for (const color of colors || []) {
    const hex = normalizeHex(color);
    if (!hex) continue;
    out.push(hex);
    if (limit != null && out.length >= limit) break;
  }
  return out;
}

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

function normalizeBoxCoords(b) {
  let x = b.x;
  let y = b.y;
  let w = b.w;
  let h = b.h;
  if (typeof x !== "number" || !Number.isFinite(x)) x = 0;
  if (typeof y !== "number" || !Number.isFinite(y)) y = 0;
  if (typeof w !== "number" || !Number.isFinite(w)) w = 0;
  if (typeof h !== "number" || !Number.isFinite(h)) h = 0;
  if (w < 0) { x += w; w = -w; }
  if (h < 0) { y += h; h = -h; }
  x = clamp01(x);
  y = clamp01(y);
  w = Math.min(w, 1 - x);
  h = Math.min(h, 1 - y);
  return { ...b, x, y, w: Math.max(0, w), h: Math.max(0, h) };
}

/** Move every region by the same nudge, then keep it inside the canvas. */
export function offsetAddedRegions(boxes, nudge = 0.05) {
  return (boxes || []).map((b) => normalizeBoxCoords({
    ...b,
    x: (typeof b.x === "number" && Number.isFinite(b.x) ? b.x : 0) + nudge,
    y: (typeof b.y === "number" && Number.isFinite(b.y) ? b.y : 0) + nudge,
  }));
}

/** Ctrl+V: nudge a copy so it is visible, and do not keep the source store link. */
export function pasteRegions(boxes, nudge = 0.03) {
  return offsetAddedRegions(boxes, nudge).map((b) => {
    const copy = {
      ...b,
      palette: Array.isArray(b.palette) ? b.palette.slice() : [],
    };
    delete copy.storeRef;
    return copy;
  });
}

/**
 * Place a character/object loaded into the scene.
 * Indexes 0-16 keep the original 0.04 diagonal from (0.1, 0.1). Later indexes
 * tile a 0.25x0.20 grid that stays inside the canvas.
 */
export function staggerLoadedRegion(index) {
  const origin = 0.1;
  const step = 0.04;
  const w = 0.25;
  const h = 0.2;
  const i = Number.isInteger(index) && index >= 0 ? index : 0;
  const diagonalCount = Math.floor((1 - w - origin) / step) + 1;
  if (i < diagonalCount) {
    return normalizeBoxCoords({
      x: origin + i * step,
      y: origin + i * step,
      w,
      h,
    });
  }
  const extra = i - diagonalCount;
  const cols = Math.max(1, Math.floor((1 - w) / w) + 1);
  const rows = Math.max(1, Math.floor((1 - h) / h) + 1);
  const slot = extra % (cols * rows);
  const col = slot % cols;
  const row = Math.floor(slot / cols);
  return normalizeBoxCoords({ x: col * w, y: row * h, w, h });
}
