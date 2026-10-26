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

export function elementToRegion(el, idx) {
  if (!el || typeof el !== "object") return null;
  const box = {
    type: el.type === "text" ? "text" : "obj",
    text: el.text || "",
    desc: el.desc || "",
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
