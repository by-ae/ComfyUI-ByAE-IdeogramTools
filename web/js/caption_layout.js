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

/** One line for the canvas. Always a string, so drawing can wrap it. */
export function regionLabel(box) {
  if (!box || typeof box !== "object") return "";
  const desc = captionText(box.desc);
  if (box.type === "text") {
    const text = captionText(box.text);
    if (text) return desc ? `"${text}" — ${desc}` : `"${text}"`;
  }
  return desc;
}

export function elementToRegion(el, idx) {
  if (!el || typeof el !== "object") return null;
  const box = {
    type: el.type === "text" ? "text" : "obj",
    text: captionText(el.text),
    desc: captionText(el.desc),
    // Ideogram 4 allows at most five uppercase #RRGGBB colors on an element.
    // Shorthand and other values are dropped here so the editor stores the
    // same colors the prompt will keep.
    palette: cleanPalette(Array.isArray(el.color_palette) ? el.color_palette : [], 5),
  };
  const rect = ideogramBboxToRect(el.bbox);
  if (rect) Object.assign(box, rect);
  else Object.assign(box, fallbackRegion(idx));
  return box;
}

export function regionCoordsFinite(b) {
  return !!b && [b.x, b.y, b.w, b.h].every((n) => typeof n === "number" && Number.isFinite(n));
}

function hitsRegion(mx, my, b, rx, ry) {
  const x1 = b.x;
  const y1 = b.y;
  const x2 = b.x + b.w;
  const y2 = b.y + b.h;
  const near = (cx, cy) => Math.abs(mx - cx) < rx && Math.abs(my - cy) < ry;
  if (near(x1, y1) || near(x2, y1) || near(x1, y2) || near(x2, y2)) return true;
  if (mx >= x1 && mx <= x2 && Math.abs(my - y1) < ry) return true;
  if (mx >= x1 && mx <= x2 && Math.abs(my - y2) < ry) return true;
  if (my >= y1 && my <= y2 && Math.abs(mx - x1) < rx) return true;
  if (my >= y1 && my <= y2 && Math.abs(mx - x2) < rx) return true;
  return mx >= x1 && mx <= x2 && my >= y1 && my <= y2;
}

/**
 * After every selected region is deleted, nothing stays active.
 * Leaving the nearest survivor active made the next Delete remove it too.
 */
export function indexesAfterClearingSelection(count, selected) {
  const total = Number.isInteger(count) && count > 0 ? count : 0;
  const seen = new Set();
  let removed = 0;
  for (const i of selected || []) {
    if (!Number.isInteger(i) || i < 0 || i >= total || seen.has(i)) continue;
    seen.add(i);
    removed += 1;
  }
  return { count: total - removed, selected: [], active: -1 };
}

/** Index of the topmost region under a normalized point, or -1. Later boxes are drawn above earlier ones. */
export function topRegionIndex(boxes, x, y, rx = 0, ry = 0) {
  const list = boxes || [];
  for (let i = list.length - 1; i >= 0; i--) {
    const b = list[i];
    if (!regionCoordsFinite(b)) continue;
    if (hitsRegion(x, y, b, rx, ry)) return i;
  }
  return -1;
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

/** Lowercase #rrggbb for input[type=color]. Anything else is unusable there. */
export function swatchHex(color) {
  const hex = normalizeHex(color);
  return hex ? hex.toLowerCase() : null;
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

const SCALE_ANCHORS = {
  center: [0.5, 0.5],
  "top-left": [0, 0],
  top: [0.5, 0],
  "top-right": [1, 0],
  "center-left": [0, 0.5],
  "center-right": [1, 0.5],
  "bottom-left": [0, 1],
  bottom: [0.5, 1],
  "bottom-right": [1, 1],
};

/**
 * Empty when width and height suit the open Ideogram 4 model.
 * Otherwise a note of that model's rule. The hosted API uses its own preset
 * list, so this does not say a size is invalid there.
 * https://github.com/ideogram-oss/ideogram4/blob/main/docs/inference.md
 */
export function ideogramResolutionWarning(width, height) {
  const w = Number(width);
  const h = Number(height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return "";
  const multiple = Number.isInteger(w) && Number.isInteger(h) && w % 16 === 0 && h % 16 === 0;
  const inRange = w >= 256 && h >= 256 && w <= 2048 && h <= 2048;
  const ratio = w / h;
  const ratioOk = ratio >= 1 / 6 && ratio <= 6;
  if (multiple && inRange && ratioOk) return "";
  return "Open Ideogram 4 model: multiples of 16, each side 256-2048, aspect at most 6:1";
}

export function dimsFromAspect(aspectStr) {
  const m = String(aspectStr || "").trim().match(/^(\d+(?:\.\d+)?)\s*[:/x×]\s*(\d+(?:\.\d+)?)$/i);
  if (!m) return null;
  const aw = parseFloat(m[1]);
  const ah = parseFloat(m[2]);
  if (!(aw > 0) || !(ah > 0)) return null;
  if (aw >= ah) return { w: 1024, h: Math.max(1, Math.round((1024 * ah) / aw)) };
  return { w: Math.max(1, Math.round((1024 * aw) / ah)), h: 1024 };
}

function contentBoundsPx(boxes, layoutW, layoutH) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let any = false;
  for (const b of boxes || []) {
    if (!regionCoordsFinite(b)) continue;
    any = true;
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.w);
    maxY = Math.max(maxY, b.y + b.h);
  }
  if (!any || !(maxX > minX) || !(maxY > minY)) return null;
  return {
    minX: minX * layoutW,
    minY: minY * layoutH,
    maxX: maxX * layoutW,
    maxY: maxY * layoutH,
    w: (maxX - minX) * layoutW,
    h: (maxY - minY) * layoutH,
  };
}

function anchorPointOnRect(rect, mode) {
  const [ax, ay] = SCALE_ANCHORS[mode] || [0.5, 0.5];
  return [rect.minX + ax * rect.w, rect.minY + ay * rect.h];
}

function anchorPointOnCanvas(canvasW, canvasH, mode) {
  const [ax, ay] = SCALE_ANCHORS[mode] || [0.5, 0.5];
  return [ax * canvasW, ay * canvasH];
}

/** Uniform scale of region content. Blank margins are cropped; content is not enlarged. */
export function transformBoxesContentUniform(boxes, oldW, oldH, newW, newH, mode) {
  const anchor = SCALE_ANCHORS[mode];
  if (!anchor || oldW <= 0 || oldH <= 0 || newW <= 0 || newH <= 0) return boxes;
  const content = contentBoundsPx(boxes, oldW, oldH);
  if (!content) return boxes;

  const s = Math.min(1, Math.min(newW / content.w, newH / content.h));
  const anchorOld = anchorPointOnRect(content, mode);
  const anchorNew = anchorPointOnCanvas(newW, newH, mode);

  return boxes.map((box) => {
    const ox = box.x * oldW;
    const oy = box.y * oldH;
    const ow = box.w * oldW;
    const oh = box.h * oldH;
    return normalizeBoxCoords({
      ...box,
      x: (anchorNew[0] + s * (ox - anchorOld[0])) / newW,
      y: (anchorNew[1] + s * (oy - anchorOld[1])) / newH,
      w: (s * ow) / newW,
      h: (s * oh) / newH,
    });
  });
}

/**
 * Map pasted regions from a source canvas onto destW x destH.
 * "stretch" keeps normalized coordinates. An anchor mode pins a uniform fit.
 * Scale mode "stretch" centers that fit: the paste dialog's Don't care option
 * is the path that leaves normalized coordinates unchanged.
 */
export function remapImportedRegions(boxes, opts = {}) {
  const list = boxes || [];
  const source = opts.source || "stretch";
  if (source === "stretch") return list;
  const destW = opts.destW;
  const destH = opts.destH;
  if (!(destW > 0) || !(destH > 0)) return list;
  let srcW = destW;
  let srcH = destH;
  if (source === "dimensions") {
    srcW = Number(opts.srcW);
    srcH = Number(opts.srcH);
    if (!(srcW > 0)) srcW = 1024;
    if (!(srcH > 0)) srcH = 1024;
  } else if (source === "aspect") {
    const dims = dimsFromAspect(opts.aspect || "1:1");
    if (!dims) return list;
    srcW = dims.w;
    srcH = dims.h;
  } else if (source !== "same") {
    return list;
  }
  if (srcW === destW && srcH === destH) return list;
  const mode = Object.prototype.hasOwnProperty.call(SCALE_ANCHORS, opts.mode) ? opts.mode : "center";
  return transformBoxesContentUniform(list, srcW, srcH, destW, destH, mode);
}
