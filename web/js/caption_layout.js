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

const FALLBACK_COLS = 4;
const FALLBACK_W = 0.22;
const FALLBACK_H = 0.14;
const FALLBACK_X0 = 0.02;
const FALLBACK_Y0 = 0.02;
const FALLBACK_XSTEP = 0.25;
const FALLBACK_YSTEP = 0.17;

function fallbackOrigin(index) {
  const row = Math.floor(index / FALLBACK_COLS);
  const col = index % FALLBACK_COLS;
  return {
    x: FALLBACK_X0 + col * FALLBACK_XSTEP,
    y: FALLBACK_Y0 + row * FALLBACK_YSTEP,
  };
}

function countFallback(pred) {
  let count = 0;
  while (count < 10000 && pred(count)) count += 1;
  return count;
}

// Rows whose top is still on the canvas keep the original spacing. The next
// row used to start below the canvas, where it could not be selected.
const FALLBACK_LEGACY = countFallback((i) => fallbackOrigin(i).y < 1);
const FALLBACK_FIT = countFallback((i) => fallbackOrigin(i).y + FALLBACK_H <= 1);

export function fallbackRegion(index) {
  const i = Number.isInteger(index) && index >= 0 ? index : 0;
  const origin = fallbackOrigin(i);
  if (i < FALLBACK_LEGACY || FALLBACK_FIT <= 0) {
    return { x: origin.x, y: origin.y, w: FALLBACK_W, h: FALLBACK_H, nobbox: true };
  }
  const extra = i - FALLBACK_LEGACY;
  const page = Math.floor(extra / FALLBACK_FIT);
  const slot = extra % FALLBACK_FIT;
  const slotOrigin = fallbackOrigin(slot);
  // A small shift per lap keeps the wrapped region from covering the same
  // pixels as the region already in that cell. Clamp so the shift stays inside.
  const shift = 0.01 * ((page % 4) + 1);
  return normalizeBoxCoords({
    x: slotOrigin.x + shift,
    y: slotOrigin.y + shift,
    w: FALLBACK_W,
    h: FALLBACK_H,
    nobbox: true,
  });
}

/**
 * Ideogram 4 caption object from pasted text, or null.
 * One leading byte-order mark is ignored. compositional_deconstruction has
 * to be an object: an array is truthy and would otherwise clear the canvas.
 */
export function parseCaptionText(text) {
  if (typeof text !== "string") return null;
  let raw = text.trim();
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1).trim();
  if (!raw) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const cd = parsed.compositional_deconstruction;
  if (!cd || typeof cd !== "object" || Array.isArray(cd)) return null;
  return parsed;
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

/**
 * Selection after one region is removed.
 * Deleting the last selected region leaves nothing active. Leaving the
 * previous region active made the next Delete remove it too.
 */
export function selectionAfterRemovingBox(count, selected, active, removed) {
  const total = Number.isInteger(count) && count > 0 ? count : 0;
  const current = [];
  const seen = new Set();
  for (const i of selected || []) {
    if (!Number.isInteger(i) || i < 0 || i >= total || seen.has(i)) continue;
    seen.add(i);
    current.push(i);
  }
  let nextActive = Number.isInteger(active) ? active : -1;
  if (!Number.isInteger(removed) || removed < 0 || removed >= total) {
    return { count: total, selected: current, active: nextActive };
  }
  const nextSelected = [];
  for (const i of current) {
    if (i < removed) nextSelected.push(i);
    else if (i > removed) nextSelected.push(i - 1);
  }
  const nextCount = total - 1;
  if (nextCount === 0) nextActive = -1;
  else if (removed <= nextActive) nextActive = Math.max(0, nextActive - 1);
  if (nextActive >= 0 && !nextSelected.includes(nextActive)) {
    nextActive = nextSelected.length ? nextSelected[0] : -1;
  }
  return { count: nextCount, selected: nextSelected, active: nextActive };
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
  // A dict of colors is what the prompt node accepts. Anything that is not a
  // list or a plain object is dropped. Iterating a number used to throw.
  let list;
  if (Array.isArray(colors)) list = colors;
  else if (colors && typeof colors === "object") list = Object.values(colors);
  else return [];
  const out = [];
  for (const color of list) {
    const hex = normalizeHex(color);
    if (!hex) continue;
    out.push(hex);
    if (limit != null && out.length >= limit) break;
  }
  return out;
}

/**
 * The reference image is drawn with CSS opacity. The black plate is what
 * that opacity blends over, matching the preview. Hidden when there is no
 * image, so the empty canvas stays the editor gray.
 */
export function backgroundPlateShown(url, opacity) {
  return Boolean(url) && Number(opacity) > 0;
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

const SCENE_BOX_KEYS = ["x", "y", "w", "h", "desc", "text", "palette", "type", "nobbox", "storeRef"];

function sceneCoord(value) {
  const n = finiteCoord(value);
  return n == null ? 0 : n;
}

function sceneRegion(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (!SCENE_BOX_KEYS.some((key) => Object.prototype.hasOwnProperty.call(raw, key))) return null;
  const region = normalizeBoxCoords({
    x: sceneCoord(raw.x),
    y: sceneCoord(raw.y),
    w: sceneCoord(raw.w),
    h: sceneCoord(raw.h),
    type: typeof raw.type === "string" && raw.type ? raw.type : "obj",
    text: captionText(raw.text),
    desc: captionText(raw.desc),
    palette: cleanPalette(raw.palette, 5),
  });
  if (raw.nobbox) region.nobbox = true;
  const ref = raw.storeRef;
  if (ref && typeof ref === "object" && !Array.isArray(ref)) {
    const type = ref.type === "object" || ref.type === "character" ? ref.type : null;
    const name = captionText(ref.name);
    if (type && name) region.storeRef = { type, name };
  }
  return region;
}

/**
 * Regions and fields from a saved scene, or null when the value is not one.
 * Callers must check null before clearing the canvas. A list of unusable
 * regions is null so replace mode does not wipe the editor for junk data.
 */
export function sceneFromStore(state) {
  if (!state || typeof state !== "object" || Array.isArray(state)) return null;
  if (!("boxes" in state) && !("widgets" in state) && !("stylePalette" in state)) return null;
  if ("boxes" in state && !Array.isArray(state.boxes)) return null;
  const rawBoxes = Array.isArray(state.boxes) ? state.boxes : [];
  const boxes = [];
  for (const raw of rawBoxes) {
    const region = sceneRegion(raw);
    if (region) boxes.push(region);
  }
  if (rawBoxes.length > 0 && boxes.length === 0) return null;
  const widgets = state.widgets && typeof state.widgets === "object" && !Array.isArray(state.widgets)
    ? state.widgets
    : {};
  return {
    boxes,
    stylePalette: cleanPalette(state.stylePalette, 16),
    widgets,
  };
}

/** Move every region by the same nudge, then keep it inside the canvas. */
export function offsetAddedRegions(boxes, nudge = 0.05) {
  return (boxes || []).map((b) => normalizeBoxCoords({
    ...b,
    x: (typeof b.x === "number" && Number.isFinite(b.x) ? b.x : 0) + nudge,
    y: (typeof b.y === "number" && Number.isFinite(b.y) ? b.y : 0) + nudge,
  }));
}

function regionRectKey(b) {
  const r = (n) => Math.round(n * 1e6) / 1e6;
  return `${r(b.x)},${r(b.y)},${r(b.w)},${r(b.h)}`;
}

/** A positive width or height that the nudge crushed to an empty edge. */
function regionWasFlattened(source, placed) {
  if (!source || !placed) return false;
  if (typeof source.w === "number" && source.w > 0 && !(placed.w > 0)) return true;
  if (typeof source.h === "number" && source.h > 0 && !(placed.h > 0)) return true;
  return false;
}

function placementFlattens(source, placed) {
  const src = source || [];
  for (let i = 0; i < src.length; i++) {
    if (regionWasFlattened(src[i], placed[i])) return true;
  }
  return false;
}

function placedArea(boxes) {
  let area = 0;
  for (const b of boxes || []) {
    const w = typeof b.w === "number" && b.w > 0 ? b.w : 0;
    const h = typeof b.h === "number" && b.h > 0 ? b.h : 0;
    area += w * h;
  }
  return area;
}

function classifyAddedNudge(incoming, nudge, have) {
  const placed = offsetAddedRegions(incoming, nudge);
  const finite = placed.filter(regionCoordsFinite);
  return {
    nudge,
    flat: placementFlattens(incoming, placed),
    hidden: finite.length > 0 && finite.every((b) => have.has(regionRectKey(b))),
    area: placedArea(placed),
  };
}

/**
 * Offset for an additive scene load. The first copy uses `step`. A later load
 * of the same scene steps further so the new regions are not hidden under the
 * previous copy. A partial overlap is left alone. If the next step would crush
 * a region against the canvas edge, the whole scene steps the other way.
 */
export function nudgeForAddedRegions(existing, incoming, step = 0.05) {
  const base = typeof step === "number" && Number.isFinite(step) && step > 0 ? step : 0.05;
  const have = new Set((existing || []).filter(regionCoordsFinite).map(regionRectKey));
  let sawFlat = false;
  let best = base;
  let bestArea = -1;
  const remember = (choice) => {
    if (choice.area > bestArea) {
      best = choice.nudge;
      bestArea = choice.area;
    }
  };
  for (let n = 1; n <= 16; n++) {
    const choice = classifyAddedNudge(incoming, base * n, have);
    if (choice.flat) {
      sawFlat = true;
      remember(choice);
      break;
    }
    remember(choice);
    if (!choice.hidden) return choice.nudge;
  }
  if (!sawFlat) return base * 16;
  for (let n = 1; n <= 16; n++) {
    const choice = classifyAddedNudge(incoming, -base * n, have);
    remember(choice);
    if (!choice.flat && !choice.hidden) return choice.nudge;
  }
  return best;
}

/** Each Ctrl+V moves this far from the copied region. The next paste adds another step. */
export const PASTE_NUDGE = 0.03;

export function nextPasteNudge(previousPastes) {
  const done = Number.isInteger(previousPastes) && previousPastes > 0 ? previousPastes : 0;
  return PASTE_NUDGE * (done + 1);
}

function copyPastedRegion(b) {
  const copy = {
    ...b,
    palette: Array.isArray(b.palette) ? b.palette.slice() : [],
  };
  delete copy.storeRef;
  return copy;
}

/**
 * Ctrl+V: nudge a copy so it is visible, and do not keep the source store link.
 * The same nudge is applied to every region. If that would flatten one against
 * the edge, the whole paste steps the opposite way instead of shearing.
 */
export function pasteRegions(boxes, nudge = PASTE_NUDGE) {
  const forward = offsetAddedRegions(boxes, nudge);
  let placed = forward;
  if (placementFlattens(boxes, forward)) {
    const back = offsetAddedRegions(boxes, -nudge);
    if (!placementFlattens(boxes, back) || placedArea(back) > placedArea(forward)) {
      placed = back;
    }
  }
  return placed.map(copyPastedRegion);
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
 * Side length for the size fields and the width/height outputs.
 * Round, clamp to 64-16384, then round to a multiple of 8 (the node step).
 * Ties on a half step go to the larger multiple. An empty or non-positive
 * value keeps the fallback, which the editor uses as 1024.
 * The open model's multiple-of-16 rule is a separate note and does not
 * change this number.
 */
export function snapLayoutDim(value, fallback = 1024) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  const clamped = Math.max(64, Math.min(16384, Math.round(n)));
  const snapped = Math.round(clamped / 8) * 8;
  return Math.max(64, Math.min(16384, snapped));
}

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
