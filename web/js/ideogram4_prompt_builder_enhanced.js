import {
  chainCallback, addMiddleClickPan, addWheelPassthrough, cursorForBboxMode,
  applyWidgetValues, sanitizeWidgetValues, coerceWidgetValue,
  stripInternalPromptFields, makeUUID,
} from "./utility.js";
import {
  loadStores, saveStoreEntry, deleteStoreEntry, installBuilderQueueHooks, installBgUpdateListener,
} from "./ideogram4_shared.js";
import {
  captionText, cleanPalette, dimsFromAspect, elementToRegion, offsetAddedRegions, pasteRegions,
  rectToIdeogramBbox, regionCoordsFinite, remapImportedRegions, staggerLoadedRegion,
  topRegionIndex,
  transformBoxesContentUniform,
} from "./caption_layout.js";

const { app } = window.comfyAPI.app;
const { api } = window.comfyAPI.api;

let _persistHooksInstalled = false;

function installBuilderPersistHooks() {
  if (_persistHooksInstalled) return;
  _persistHooksInstalled = true;
  api.addEventListener("prompt", () => {
    const graph = app.graph;
    if (!graph?._nodes) return;
    for (const node of graph._nodes) {
      node.byaePersistState?.();
    }
  });
}
installBuilderPersistHooks();
installBgUpdateListener();

const BBOX_PALETTE = ["#46b4e6", "#e68246", "#82e646", "#e646b4", "#e6e646", "#46e6c8"];
const MAX_CANVAS_W = 1024, MAX_CANVAS_H = 768;
const HANDLE = 8;
const MAX_ELEM_COLORS = 5;
const MAX_STYLE_COLORS = 16;
const BG_LOG_PREFIX = "[ByAE Ideogram BG]";

function bgLog(...args) {
  console.log(BG_LOG_PREFIX, ...args);
}

const LAYOUT_DIM_DEFAULT = 1024;
const LAYOUT_OPACITY_DEFAULT = 0.5;

function layoutDim(value, fallback = LAYOUT_DIM_DEFAULT) {
  if (value == null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(64, Math.min(16384, Math.round(n)));
}

function layoutOpacity(value, fallback = LAYOUT_OPACITY_DEFAULT) {
  if (value == null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

function widgetString(val) {
  if (val == null || val === "") return "";
  if (typeof val === "string") return val;
  if (typeof val === "number" || typeof val === "boolean") return String(val);
  return "";
}

function getStyleKind(node) {
  const styleW = node.widgets?.find((w) => w.name === "style");
  if (!styleW) return "none";
  return coerceWidgetValue(styleW, styleW.value);
}

function coerceScaleMode(value) {
  if (typeof value === "string" && value) return value;
  if (value && typeof value === "object" && typeof value.style === "string") return value.style;
  return "stretch";
}

function clampToMaxCanvas(w, h) {
  if (w > MAX_CANVAS_W || h > MAX_CANVAS_H) {
    const s = Math.min(MAX_CANVAS_W / w, MAX_CANVAS_H / h);
    return [Math.round(w * s), Math.round(h * s)];
  }
  return [w, h];
}

function boxColor(index) { return BBOX_PALETTE[index % BBOX_PALETTE.length]; }

function clamp01(v) { return Math.max(0, Math.min(1, v)); }

function normalizeBoxCoords(b) {
  let x = b.x, y = b.y, w = b.w, h = b.h;
  if (w < 0) { x += w; w = -w; }
  if (h < 0) { y += h; h = -h; }
  x = clamp01(x); y = clamp01(y);
  w = Math.min(w, 1 - x); h = Math.min(h, 1 - y);
  return { ...b, x, y, w: Math.max(0, w), h: Math.max(0, h) };
}

function cloneBox(b) {
  const c = {
    x: b.x, y: b.y, w: b.w, h: b.h,
    type: b.type || "obj", text: b.text || "", desc: b.desc || "",
    palette: Array.isArray(b.palette) ? b.palette.slice() : [],
  };
  if (b.nobbox) c.nobbox = true;
  if (b.storeRef) c.storeRef = { ...b.storeRef };
  return c;
}

function boxPayload(b) {
  return {
    type: b.type || "obj", text: b.text || "", desc: b.desc || "",
    palette: Array.isArray(b.palette) ? b.palette.slice() : [],
  };
}

function injectStyle() {
  if (document.getElementById("byae-ideo-style")) return;
  const s = document.createElement("style");
  s.id = "byae-ideo-style";
  s.textContent = `
    .byae-ideo-wrap { display:flex; flex-direction:column; overflow:hidden; position:relative; pointer-events:auto; gap:4px; width:100%; box-sizing:border-box; }
    .byae-ideo-canvas-wrap { position:relative; flex:0 0 auto; width:100%; border-radius:4px; overflow:hidden; background:#1a1a1a; }
    .byae-ideo-bg { position:absolute; inset:0; width:100%; height:100%; object-fit:fill; pointer-events:none; display:none; }
    .byae-ideo-canvas { cursor:crosshair; display:block; width:100%; height:auto; position:relative; z-index:1; background:transparent; border-radius:4px; outline:none; }
    .byae-ideo-bar { display:flex; align-items:center; gap:6px; font:11px sans-serif; color:#aaa; user-select:none; padding:0 2px; flex:0 0 auto; flex-wrap:wrap; width:100%; box-sizing:border-box; }
    .byae-ideo-bar-spacer { flex:1 1 auto; min-width:4px; }
    .byae-ideo-panel { display:flex; flex-direction:column; gap:5px; padding:6px; background:#262626; border-radius:4px; font:11px sans-serif; color:#bbb; flex:0 0 auto; width:100%; box-sizing:border-box; }
    .byae-ideo-row { display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
    .byae-ideo-btn { background:#333; border:1px solid #555; border-radius:4px; color:#bbb; font:11px sans-serif; cursor:pointer; padding:2px 8px; line-height:16px; white-space:nowrap; flex-shrink:0; }
    .byae-ideo-btn:hover { border-color:#46b4e6; color:#fff; }
    .byae-ideo-btn.active { border-color:#46b4e6; color:#46b4e6; background:#2a3a42; }
    .byae-ideo-area { width:100%; box-sizing:border-box; background:#1d1d1d; border:1px solid #444; border-radius:4px; color:#ddd; font:11px sans-serif; padding:4px 6px; resize:vertical; min-height:36px; }
    .byae-ideo-sw { width:20px; height:20px; border:1px solid #666; border-radius:3px; cursor:pointer; flex-shrink:0; position:relative; }
    .byae-ideo-sw input { position:absolute; opacity:0; width:0; height:0; pointer-events:none; }
    .byae-ideo-inline { position:absolute; box-sizing:border-box; background:rgba(18,18,18,0.92); border:2px solid #46b4e6; border-radius:3px; color:#fff; font:11px sans-serif; padding:3px 4px; resize:none; outline:none; z-index:10; }
    .byae-ideo-modal-back { position:fixed; inset:0; background:rgba(0,0,0,0.55); z-index:9999; display:flex; align-items:center; justify-content:center; }
    .byae-ideo-modal { background:#2a2a2a; border:1px solid #555; border-radius:6px; padding:14px; min-width:260px; font:12px sans-serif; color:#ddd; display:flex; flex-direction:column; gap:8px; }
    .byae-ideo-modal input, .byae-ideo-modal select { background:#1d1d1d; border:1px solid #555; color:#eee; padding:4px 6px; border-radius:4px; font:12px sans-serif; }
    .byae-ideo-size-inp { width:64px; background:#1d1d1d; border:1px solid #555; color:#eee; padding:2px 4px; border-radius:4px; font:11px sans-serif; }
    .byae-ideo-size-sel { max-width:110px; background:#1d1d1d; border:1px solid #555; color:#eee; padding:2px 4px; border-radius:4px; font:11px sans-serif; }
    .byae-ideo-opacity { width:72px; height:14px; accent-color:#46b4e6; vertical-align:middle; cursor:pointer; }
    .byae-ideo-opacity-val { min-width:30px; color:#888; font-size:11px; }
    .byae-ideo-modal-actions { display:flex; gap:8px; justify-content:flex-end; margin-top:4px; }
  `;
  document.head.appendChild(s);
}

function showModal(title, fields, onOk) {
  const back = document.createElement("div");
  back.className = "byae-ideo-modal-back";
  const modal = document.createElement("div");
  modal.className = "byae-ideo-modal";
  const h = document.createElement("div");
  h.textContent = title;
  h.style.fontWeight = "bold";
  modal.appendChild(h);
  const values = {};
  const inputs = [];
  for (const f of fields) {
    const row = document.createElement("div");
    row.style.display = "flex";
    row.style.flexDirection = "column";
    row.style.gap = "3px";
    const lbl = document.createElement("label");
    lbl.textContent = f.label;
    row.appendChild(lbl);
    let inp;
    if (f.type === "select") {
      inp = document.createElement("select");
      for (const opt of f.options) {
        const o = document.createElement("option");
        o.value = opt.value;
        o.textContent = opt.label;
        inp.appendChild(o);
      }
      inp.value = f.default || f.options[0]?.value;
    } else {
      inp = document.createElement("input");
      inp.type = "text";
      inp.value = f.default || "";
      inp.placeholder = f.placeholder || "";
    }
    values[f.key] = inp;
    inputs.push(inp);
    row.appendChild(inp);
    modal.appendChild(row);
  }
  const actions = document.createElement("div");
  actions.className = "byae-ideo-modal-actions";
  const cancelBtn = document.createElement("button");
  cancelBtn.className = "byae-ideo-btn";
  cancelBtn.textContent = "Cancel";
  const okBtn = document.createElement("button");
  okBtn.className = "byae-ideo-btn active";
  okBtn.textContent = "OK";
  actions.appendChild(cancelBtn);
  actions.appendChild(okBtn);
  modal.appendChild(actions);
  back.appendChild(modal);
  document.body.appendChild(back);
  const close = () => back.remove();
  cancelBtn.onclick = close;
  back.addEventListener("mousedown", (e) => { if (e.target === back) close(); });
  okBtn.onclick = () => {
    const result = {};
    for (const f of fields) result[f.key] = values[f.key].value;
    close();
    onOk(result);
  };
  (inputs[0] || okBtn).focus();
}

function sortStoreNames(names) {
  return [...names].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

function showCharObjLoadModal(stores, onOk, onDeleted) {
  const charNames = sortStoreNames(Object.keys(stores.characters));
  const objNames = sortStoreNames(Object.keys(stores.objects));
  const categories = [];
  if (charNames.length) categories.push({ value: "character", label: "Character" });
  if (objNames.length) categories.push({ value: "object", label: "Object" });
  if (!categories.length) {
    alert("No saved characters or objects.");
    return;
  }

  const back = document.createElement("div");
  back.className = "byae-ideo-modal-back";
  const modal = document.createElement("div");
  modal.className = "byae-ideo-modal";
  modal.style.minWidth = "280px";

  const h = document.createElement("div");
  h.textContent = "Load character / object";
  h.style.fontWeight = "bold";
  modal.appendChild(h);

  const catRow = document.createElement("div");
  catRow.style.display = "flex";
  catRow.style.flexDirection = "column";
  catRow.style.gap = "3px";
  const catLbl = document.createElement("label");
  catLbl.textContent = "Category";
  const catSel = document.createElement("select");
  for (const c of categories) {
    const o = document.createElement("option");
    o.value = c.value;
    o.textContent = c.label;
    catSel.appendChild(o);
  }
  catRow.appendChild(catLbl);
  catRow.appendChild(catSel);
  modal.appendChild(catRow);

  const nameRow = document.createElement("div");
  nameRow.style.display = "flex";
  nameRow.style.flexDirection = "column";
  nameRow.style.gap = "3px";
  const nameLbl = document.createElement("label");
  nameLbl.textContent = "Name";
  const nameSel = document.createElement("select");
  nameRow.appendChild(nameLbl);
  nameRow.appendChild(nameSel);
  modal.appendChild(nameRow);

  function namesFor(type) {
    const key = type === "object" ? "objects" : "characters";
    return sortStoreNames(Object.keys(stores[key] || {}));
  }

  function refillNames() {
    const type = catSel.value;
    const names = namesFor(type);
    nameLbl.textContent = type === "object" ? "Object" : "Character";
    nameSel.innerHTML = "";
    for (const n of names) {
      const o = document.createElement("option");
      o.value = n;
      o.textContent = n;
      nameSel.appendChild(o);
    }
    nameSel.disabled = !names.length;
  }

  function rebuildCategories() {
    const prev = catSel.value;
    const categories = [];
    if (Object.keys(stores.characters || {}).length) categories.push({ value: "character", label: "Character" });
    if (Object.keys(stores.objects || {}).length) categories.push({ value: "object", label: "Object" });
    if (!categories.length) {
      close();
      alert("No saved characters or objects.");
      return;
    }
    catSel.innerHTML = "";
    for (const c of categories) {
      const o = document.createElement("option");
      o.value = c.value;
      o.textContent = c.label;
      catSel.appendChild(o);
    }
    catSel.value = categories.some((c) => c.value === prev) ? prev : categories[0].value;
    refillNames();
  }

  catSel.addEventListener("change", refillNames);
  refillNames();

  const actions = document.createElement("div");
  actions.className = "byae-ideo-modal-actions";
  const delBtn = document.createElement("button");
  delBtn.className = "byae-ideo-btn";
  delBtn.textContent = "Delete";
  const cancelBtn = document.createElement("button");
  cancelBtn.className = "byae-ideo-btn";
  cancelBtn.textContent = "Cancel";
  const okBtn = document.createElement("button");
  okBtn.className = "byae-ideo-btn active";
  okBtn.textContent = "Load";
  actions.appendChild(delBtn);
  actions.appendChild(cancelBtn);
  actions.appendChild(okBtn);
  modal.appendChild(actions);
  back.appendChild(modal);
  document.body.appendChild(back);

  const close = () => back.remove();
  cancelBtn.onclick = close;
  back.addEventListener("mousedown", (e) => { if (e.target === back) close(); });
  delBtn.onclick = async () => {
    const type = catSel.value;
    const name = nameSel.value;
    if (!name) return;
    const label = type === "object" ? "object" : "character";
    if (!confirm(`Delete saved ${label} "${name}"? This cannot be undone.`)) return;
    const bucket = type === "object" ? "objects" : "characters";
    try {
      await deleteStoreEntry(bucket, name);
    } catch (e) {
      alert("Failed to delete: " + e.message);
      return;
    }
    delete stores[bucket][name];
    onDeleted?.(type, name);
    rebuildCategories();
  };
  okBtn.onclick = () => {
    const type = catSel.value;
    const name = nameSel.value;
    if (!name) return;
    close();
    onOk({ type, name });
  };
  catSel.focus();
}

function showSceneLoadModal(stores, onLoad) {
  const names = () => Object.keys(stores.scenes || {}).sort();
  if (!names().length) {
    alert("No saved scenes.");
    return;
  }

  const back = document.createElement("div");
  back.className = "byae-ideo-modal-back";
  const modal = document.createElement("div");
  modal.className = "byae-ideo-modal";
  modal.style.minWidth = "280px";

  const h = document.createElement("div");
  h.textContent = "Load Scene";
  h.style.fontWeight = "bold";
  modal.appendChild(h);

  const nameRow = document.createElement("div");
  nameRow.style.display = "flex";
  nameRow.style.flexDirection = "column";
  nameRow.style.gap = "3px";
  const nameLbl = document.createElement("label");
  nameLbl.textContent = "Scene";
  const nameSel = document.createElement("select");
  nameRow.appendChild(nameLbl);
  nameRow.appendChild(nameSel);
  modal.appendChild(nameRow);

  const modeRow = document.createElement("div");
  modeRow.style.display = "flex";
  modeRow.style.flexDirection = "column";
  modeRow.style.gap = "3px";
  const modeLbl = document.createElement("label");
  modeLbl.textContent = "Mode";
  const modeSel = document.createElement("select");
  for (const opt of [
    { value: "additive", label: "Additive (add boxes, select new)" },
    { value: "replace", label: "Replace (clear everything)" },
  ]) {
    const o = document.createElement("option");
    o.value = opt.value;
    o.textContent = opt.label;
    modeSel.appendChild(o);
  }
  modeSel.value = "additive";
  modeRow.appendChild(modeLbl);
  modeRow.appendChild(modeSel);
  modal.appendChild(modeRow);

  const actions = document.createElement("div");
  actions.className = "byae-ideo-modal-actions";
  const delBtn = document.createElement("button");
  delBtn.className = "byae-ideo-btn";
  delBtn.textContent = "Delete";
  const cancelBtn = document.createElement("button");
  cancelBtn.className = "byae-ideo-btn";
  cancelBtn.textContent = "Cancel";
  const okBtn = document.createElement("button");
  okBtn.className = "byae-ideo-btn active";
  okBtn.textContent = "Load";
  actions.appendChild(delBtn);
  actions.appendChild(cancelBtn);
  actions.appendChild(okBtn);
  modal.appendChild(actions);
  back.appendChild(modal);
  document.body.appendChild(back);

  const close = () => back.remove();
  function refill() {
    const list = names();
    if (!list.length) {
      close();
      alert("No saved scenes.");
      return;
    }
    const prev = nameSel.value;
    nameSel.innerHTML = "";
    for (const n of list) {
      const o = document.createElement("option");
      o.value = n;
      o.textContent = n;
      nameSel.appendChild(o);
    }
    if (list.includes(prev)) nameSel.value = prev;
  }
  refill();

  cancelBtn.onclick = close;
  back.addEventListener("mousedown", (e) => { if (e.target === back) close(); });
  delBtn.onclick = async () => {
    const name = nameSel.value;
    if (!name) return;
    if (!confirm(`Delete saved scene "${name}"? This cannot be undone.`)) return;
    try {
      await deleteStoreEntry("scenes", name);
    } catch (e) {
      alert("Failed to delete scene: " + e.message);
      return;
    }
    delete stores.scenes[name];
    refill();
  };
  okBtn.onclick = () => {
    const name = nameSel.value;
    if (!name || !stores.scenes[name]) return;
    const mode = modeSel.value;
    const state = stores.scenes[name];
    close();
    onLoad(state, mode === "replace");
  };
  nameSel.focus();
}

function showPasteJsonSourceModal(onOk) {
  const back = document.createElement("div");
  back.className = "byae-ideo-modal-back";
  const modal = document.createElement("div");
  modal.className = "byae-ideo-modal";
  modal.style.minWidth = "300px";

  const title = document.createElement("div");
  title.textContent = "Paste JSON — source canvas";
  title.style.fontWeight = "bold";
  modal.appendChild(title);

  const hint = document.createElement("div");
  hint.style.cssText = "color:#999; font-size:11px; line-height:1.35;";
  hint.textContent = "Don't care stretches regions to this canvas. A source size or aspect fits them without stretching.";
  modal.appendChild(hint);

  const srcRow = document.createElement("div");
  srcRow.style.display = "flex";
  srcRow.style.flexDirection = "column";
  srcRow.style.gap = "3px";
  const srcLbl = document.createElement("label");
  srcLbl.textContent = "Source sizing";
  const srcSel = document.createElement("select");
  for (const opt of [
    { value: "stretch", label: "Don't Care (just stretch to fit)" },
    { value: "same", label: "Same (current canvas size)" },
    { value: "dimensions", label: "Source width & height" },
    { value: "aspect", label: "Source aspect ratio" },
  ]) {
    const o = document.createElement("option");
    o.value = opt.value;
    o.textContent = opt.label;
    srcSel.appendChild(o);
  }
  srcRow.appendChild(srcLbl);
  srcRow.appendChild(srcSel);
  modal.appendChild(srcRow);

  const dimRow = document.createElement("div");
  dimRow.style.cssText = "display:none; flex-direction:column; gap:6px;";
  const dimInner = document.createElement("div");
  dimInner.style.cssText = "display:flex; gap:8px; flex-wrap:wrap;";
  const wWrap = document.createElement("div");
  wWrap.style.flex = "1";
  wWrap.style.minWidth = "100px";
  const wLbl = document.createElement("label");
  wLbl.textContent = "Width";
  const wInp = document.createElement("input");
  wInp.type = "number";
  wInp.min = "1";
  wInp.value = "1024";
  wWrap.appendChild(wLbl);
  wWrap.appendChild(wInp);
  const hWrap = document.createElement("div");
  hWrap.style.flex = "1";
  hWrap.style.minWidth = "100px";
  const hLbl = document.createElement("label");
  hLbl.textContent = "Height";
  const hInp = document.createElement("input");
  hInp.type = "number";
  hInp.min = "1";
  hInp.value = "1024";
  hWrap.appendChild(hLbl);
  hWrap.appendChild(hInp);
  dimInner.appendChild(wWrap);
  dimInner.appendChild(hWrap);
  dimRow.appendChild(dimInner);
  modal.appendChild(dimRow);

  const aspectRow = document.createElement("div");
  aspectRow.style.display = "none";
  aspectRow.style.flexDirection = "column";
  aspectRow.style.gap = "3px";
  const aspectLbl = document.createElement("label");
  aspectLbl.textContent = "Aspect ratio";
  const aspectInp = document.createElement("input");
  aspectInp.type = "text";
  aspectInp.value = "1:1";
  aspectInp.placeholder = "e.g. 16:9, 2:1, 4:3";
  aspectRow.appendChild(aspectLbl);
  aspectRow.appendChild(aspectInp);
  modal.appendChild(aspectRow);

  function refreshFields() {
    const v = srcSel.value;
    dimRow.style.display = v === "dimensions" ? "flex" : "none";
    aspectRow.style.display = v === "aspect" ? "flex" : "none";
  }
  srcSel.addEventListener("change", refreshFields);

  const actions = document.createElement("div");
  actions.className = "byae-ideo-modal-actions";
  const cancelBtn = document.createElement("button");
  cancelBtn.className = "byae-ideo-btn";
  cancelBtn.textContent = "Cancel";
  const okBtn = document.createElement("button");
  okBtn.className = "byae-ideo-btn active";
  okBtn.textContent = "Paste";
  actions.appendChild(cancelBtn);
  actions.appendChild(okBtn);
  modal.appendChild(actions);
  back.appendChild(modal);
  document.body.appendChild(back);

  const close = () => back.remove();
  cancelBtn.onclick = close;
  back.addEventListener("mousedown", (e) => { if (e.target === back) close(); });
  okBtn.onclick = () => {
    const source = srcSel.value;
    const opts = { source };
    if (source === "dimensions") {
      opts.srcW = Math.max(1, Math.round(Number(wInp.value) || 1024));
      opts.srcH = Math.max(1, Math.round(Number(hInp.value) || 1024));
    } else if (source === "aspect") {
      const dims = dimsFromAspect(aspectInp.value);
      if (!dims) {
        alert("Invalid aspect ratio. Use formats like 16:9, 2:1, or 4:3.");
        return;
      }
      opts.srcW = dims.w;
      opts.srcH = dims.h;
      opts.aspect = aspectInp.value.trim();
    }
    close();
    onOk(opts);
  };

  refreshFields();
  srcSel.focus();
}

app.registerExtension({
  name: "ByAE.Ideogram4PromptBuilderPro",

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== "Ideogram4PromptBuilderKJEnhancedByAE") return;
    injectStyle();
    installBuilderQueueHooks();

    chainCallback(nodeType.prototype, "onNodeCreated", function () {
      const node = this;
      const findW = (n) => node.widgets?.find((w) => w.name === n);

      function ensureProps() {
        if (!node.properties) node.properties = {};
      }

      function stripInternalFields() {
        stripInternalPromptFields(node);
        node.setSize?.(node.size);
      }

      node._boxes = [];
      node._stylePalette = [];
      node._activeIdx = -1;
      node._selected = new Set();
      node._drawing = false;
      node._dragMode = null;
      node._dragStartN = null;
      node._boxAtStart = null;
      node._groupAtStart = null;
      node._boxesAtStart = null;
      node._hoverTitle = null;
      node._areaH = node._areaH || {};
      node._areaObservers = [];
      node._clipBoxes = null;
      node._bgDisplayUrl = null;
      node._bgUrl = null;
      node._bgFileMtime = 0;
      node._layoutW = LAYOUT_DIM_DEFAULT;
      node._layoutH = LAYOUT_DIM_DEFAULT;

      const wrap = document.createElement("div");
      wrap.className = "byae-ideo-wrap";

      const sizeBar = document.createElement("div");
      sizeBar.className = "byae-ideo-bar";
      const sizeLbl = document.createElement("span");
      sizeLbl.textContent = "Size:";
      const wInp = document.createElement("input");
      wInp.className = "byae-ideo-size-inp";
      wInp.type = "number";
      wInp.min = "64";
      wInp.max = "16384";
      wInp.step = "8";
      wInp.title = "Canvas width";
      wInp.value = String(LAYOUT_DIM_DEFAULT);
      const hInp = document.createElement("input");
      hInp.className = "byae-ideo-size-inp";
      hInp.type = "number";
      hInp.min = "64";
      hInp.max = "16384";
      hInp.step = "8";
      hInp.title = "Canvas height";
      hInp.value = String(LAYOUT_DIM_DEFAULT);
      const scaleSel = document.createElement("select");
      scaleSel.className = "byae-ideo-size-sel";
      scaleSel.title = "Scale mode on Update Size";
      for (const opt of [
        "center", "top-left", "top", "top-right", "center-left",
        "center-right", "bottom-left", "bottom", "bottom-right", "stretch",
      ]) {
        const o = document.createElement("option");
        o.value = opt;
        o.textContent = opt;
        scaleSel.appendChild(o);
      }
      const updateSizeBtn = document.createElement("button");
      updateSizeBtn.className = "byae-ideo-btn";
      updateSizeBtn.textContent = "Update Size";
      updateSizeBtn.title = "Apply width/height to the preview and scale regions";
      const sizePendingSpan = document.createElement("span");
      sizePendingSpan.style.cssText = "color:#888; font-size:11px; white-space:nowrap;";
      const opacityLbl = document.createElement("span");
      opacityLbl.textContent = "Bg:";
      opacityLbl.title = "Background opacity over black";
      const opacityInp = document.createElement("input");
      opacityInp.className = "byae-ideo-opacity";
      opacityInp.type = "range";
      opacityInp.min = "0";
      opacityInp.max = "100";
      opacityInp.step = "5";
      opacityInp.value = "50";
      const opacityVal = document.createElement("span");
      opacityVal.className = "byae-ideo-opacity-val";
      const sizeBarSpacer = document.createElement("span");
      sizeBarSpacer.className = "byae-ideo-bar-spacer";

      const bar = document.createElement("div");
      bar.className = "byae-ideo-bar";
      const hint = document.createElement("span");
      hint.style.flex = "1";
      const copyBtn = document.createElement("button");
      copyBtn.className = "byae-ideo-btn";
      copyBtn.textContent = "Copy JSON";
      const importBtn = document.createElement("button");
      importBtn.className = "byae-ideo-btn";
      importBtn.textContent = "Paste JSON";
      const clearBtn = document.createElement("button");
      clearBtn.className = "byae-ideo-btn";
      clearBtn.textContent = "Clear all";
      const tokenSpan = document.createElement("span");
      tokenSpan.style.cssText = "color:#888; white-space:nowrap;";
      bar.appendChild(hint);
      bar.appendChild(tokenSpan);
      bar.appendChild(copyBtn);
      bar.appendChild(importBtn);
      bar.appendChild(clearBtn);

      const sceneBar = document.createElement("div");
      sceneBar.className = "byae-ideo-bar";
      const sceneLbl = document.createElement("span");
      sceneLbl.textContent = "Scene:";
      const sceneSaveBtn = document.createElement("button");
      sceneSaveBtn.className = "byae-ideo-btn";
      sceneSaveBtn.textContent = "Save";
      const sceneLoadBtn = document.createElement("button");
      sceneLoadBtn.className = "byae-ideo-btn";
      sceneLoadBtn.textContent = "Load";
      sceneBar.appendChild(sceneLbl);
      sceneBar.appendChild(sceneSaveBtn);
      sceneBar.appendChild(sceneLoadBtn);

      const styleBar = document.createElement("div");
      styleBar.className = "byae-ideo-bar";
      const styleLbl = document.createElement("span");
      styleLbl.textContent = "Style colors:";
      styleBar.appendChild(styleLbl);

      const canvasWrap = document.createElement("div");
      canvasWrap.className = "byae-ideo-canvas-wrap";
      const bgImgEl = document.createElement("img");
      bgImgEl.className = "byae-ideo-bg";
      bgImgEl.alt = "";
      bgImgEl.decoding = "async";
      bgImgEl.addEventListener("load", () => drawCanvas());
      bgImgEl.addEventListener("error", () => {
        node._bgDisplayUrl = null;
        syncBgDisplay();
        drawCanvas();
      });
      const canvasEl = document.createElement("canvas");
      canvasEl.className = "byae-ideo-canvas";
      canvasEl.tabIndex = 0;
      canvasWrap.appendChild(bgImgEl);
      canvasWrap.appendChild(canvasEl);
      let ctx = canvasEl.getContext("2d");

      function getEditorHost() {
        const el = node.ideoEditor?.element;
        if (el?.isConnected) return el;
        if (wrap.isConnected) return wrap;
        return el || wrap;
      }

      function getLiveCanvas() {
        const host = getEditorHost();
        const live = host?.querySelector?.(".byae-ideo-canvas") || canvasEl;
        const bg = host?.querySelector?.(".byae-ideo-bg") || bgImgEl;
        const drawCtx = live.getContext("2d");
        ctx = drawCtx;
        return { canvasEl: live, bgImgEl: bg, ctx: drawCtx };
      }

      addWheelPassthrough(wrap);
      addMiddleClickPan(canvasEl);

      const panel = document.createElement("div");
      panel.className = "byae-ideo-panel";

      sizeBar.appendChild(sizeLbl);
      sizeBar.appendChild(wInp);
      sizeBar.appendChild(hInp);
      sizeBar.appendChild(scaleSel);
      sizeBar.appendChild(updateSizeBtn);
      sizeBar.appendChild(opacityLbl);
      sizeBar.appendChild(opacityInp);
      sizeBar.appendChild(opacityVal);
      sizeBar.appendChild(sizeBarSpacer);
      sizeBar.appendChild(sizePendingSpan);
      wrap.appendChild(sizeBar);
      wrap.appendChild(bar);
      wrap.appendChild(sceneBar);
      wrap.appendChild(styleBar);
      wrap.appendChild(canvasWrap);
      wrap.appendChild(panel);

      const TOOLBAR_H = 22;
      node._widgetHeight = 400;
      node.ideoEditor = node.addDOMWidget("ideo_editor", "Ideogram4 Pro Editor", wrap, {
        serialize: false, hideOnZoom: false,
        getMinHeight: () => node._widgetHeight,
      });
      node.ideoEditor.computeSize = function () {
        const w = Math.max(200, Math.round((node.size?.[0] || 380) - 30));
        return [w, node._widgetHeight || 400];
      };
      node.resizable = true;

      function editorInnerWidth() {
        return Math.max(200, Math.round((node.size?.[0] || 380) - 30));
      }

      function syncDomLayout() {
        const nodeW = editorInnerWidth();
        wrap.style.width = `${nodeW}px`;
        wrap.style.boxSizing = "border-box";
        const host = wrap.parentElement;
        if (host && host !== document.body) {
          host.style.width = `${nodeW}px`;
          host.style.boxSizing = "border-box";
        }
      }

      stripInternalFields();
      syncDomLayout();

      function setSelection(indices) {
        node._selected = new Set(indices.filter((i) => i >= 0 && i < node._boxes.length));
        if (node._selected.size === 0) node._activeIdx = -1;
        else if (!node._selected.has(node._activeIdx)) node._activeIdx = [...node._selected].pop();
      }

      function addToSelection(idx) {
        if (idx < 0 || idx >= node._boxes.length) return;
        node._selected.add(idx);
        node._activeIdx = idx;
      }

      function singleSelect(idx) {
        if (idx < 0) { node._selected = new Set(); node._activeIdx = -1; return; }
        node._selected = new Set([idx]);
        node._activeIdx = idx;
      }

      function groupBbox(indices) {
        const idxs = [...indices];
        if (!idxs.length) return null;
        let minX = 1, minY = 1, maxX = 0, maxY = 0;
        for (const i of idxs) {
          const b = node._boxes[i];
          minX = Math.min(minX, b.x);
          minY = Math.min(minY, b.y);
          maxX = Math.max(maxX, b.x + b.w);
          maxY = Math.max(maxY, b.y + b.h);
        }
        return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
      }

      function setCanvasSize(cw, ch) {
        const { canvasEl: c } = getLiveCanvas();
        if (c.width !== cw || c.height !== ch) {
          c.width = cw;
          c.height = ch;
        }
        c.style.aspectRatio = `${cw} / ${ch}`;
        if (node.graph) node.graph.setDirtyCanvas(true, true);
        drawCanvas();
      }

      function syncCanvasToDims() {
        const w = layoutDim(node._layoutW);
        const h = layoutDim(node._layoutH);
        const [cw, ch] = clampToMaxCanvas(w, h);
        const { canvasEl: c } = getLiveCanvas();
        if (cw !== c.width || ch !== c.height) setCanvasSize(cw, ch);
        else drawCanvas();
      }

      function roundDim(v) {
        return Math.max(64, Math.min(16384, Math.round(layoutDim(v) / 8) * 8));
      }

      function readLayoutDimsFromDom() {
        return { w: roundDim(wInp.value), h: roundDim(hInp.value) };
      }

      function readUiState() {
        const { w, h } = readLayoutDimsFromDom();
        return {
          w,
          h,
          scale: scaleSel.value || "stretch",
          opacity: layoutOpacity(Number(opacityInp.value) / 100),
        };
      }

      function writeUiState(state) {
        const w = layoutDim(state.w);
        const h = layoutDim(state.h);
        const scale = state.scale || "stretch";
        const opacity = layoutOpacity(state.opacity);
        wInp.value = String(w);
        hInp.value = String(h);
        scaleSel.value = coerceScaleMode(scale);
        const pct = Math.round(opacity * 100);
        opacityInp.value = String(pct);
        opacityVal.textContent = pct + "%";
      }

      function persistEditorState() {
        const ui = readUiState();
        ensureProps();
        node.properties.byae_layout_w = ui.w;
        node.properties.byae_layout_h = ui.h;
        node.properties.byae_scale_mode = ui.scale;
        node.properties.byae_bg_opacity = ui.opacity;
        node.properties.byae_layout_applied_w = layoutDim(node._layoutW);
        node.properties.byae_layout_applied_h = layoutDim(node._layoutH);
        node.properties.byae_elements_data = node._boxes.length ? JSON.stringify(node._boxes) : "";
        node.properties.byae_style_palette_data = node._stylePalette.length ? JSON.stringify(node._stylePalette) : "";
        node.properties.byae_bg_guid = ensureBgGuid();
      }

      function ensureBgGuid() {
        ensureProps();
        if (!node.properties.byae_bg_guid) {
          node.properties.byae_bg_guid = makeUUID();
        }
        return node.properties.byae_bg_guid;
      }

      function restoreEditorState(info) {
        ensureProps();
        if (info?.properties) Object.assign(node.properties, info.properties);
        const p = node.properties;
        const ui = {
          w: layoutDim(p.byae_layout_w ?? LAYOUT_DIM_DEFAULT),
          h: layoutDim(p.byae_layout_h ?? LAYOUT_DIM_DEFAULT),
          scale: coerceScaleMode(p.byae_scale_mode),
          opacity: layoutOpacity(p.byae_bg_opacity),
        };
        writeUiState(ui);
        node._layoutW = layoutDim(p.byae_layout_applied_w ?? ui.w);
        node._layoutH = layoutDim(p.byae_layout_applied_h ?? ui.h);
        ensureBgGuid();
        if (p.byae_elements_data) {
          try {
            const parsed = JSON.parse(p.byae_elements_data);
            if (Array.isArray(parsed)) {
              node._boxes = parsed
                .filter(regionCoordsFinite)
                .map((b) => normalizeBoxCoords(b));
              node._activeIdx = node._boxes.length ? 0 : -1;
              node._selected = node._boxes.length ? new Set([0]) : new Set();
            }
          } catch (e) {
            console.error("ByAE Ideogram: failed to parse elements_data:", e);
          }
        }
        if (p.byae_style_palette_data) {
          try {
            const sp = JSON.parse(p.byae_style_palette_data);
            if (Array.isArray(sp)) node._stylePalette = sp.filter((c) => typeof c === "string");
          } catch (e) {
            console.error("ByAE Ideogram: failed to parse style_palette_data:", e);
          }
        }
        return ui;
      }

      function getPromptInputs() {
        persistEditorState();
        const ui = readUiState();
        return {
          width: ui.w,
          height: ui.h,
          scale_mode: ui.scale,
          background_opacity: ui.opacity,
          elements_data: node.properties.byae_elements_data || "",
          style_palette_data: node.properties.byae_style_palette_data || "",
          bg_guid: ensureBgGuid(),
        };
      }

      node.byaePersistState = persistEditorState;
      node.byaeGetPromptInputs = getPromptInputs;

      function syncDomFromLayoutWidgets() {
        restoreEditorState({ properties: node.properties });
      }

      function syncLayoutWidgetsFromDom() {
        persistEditorState();
      }

      function refreshSizePendingHint() {
        const { w, h } = readLayoutDimsFromDom();
        const lw = layoutDim(node._layoutW);
        const lh = layoutDim(node._layoutH);
        if (w !== lw || h !== lh) {
          sizePendingSpan.textContent = `preview ${lw}×${lh} → ${w}×${h}`;
          updateSizeBtn.classList.add("active");
        } else {
          sizePendingSpan.textContent = `preview ${lw}×${lh}`;
          updateSizeBtn.classList.remove("active");
        }
      }

      function applyUpdateSize() {
        applyLayoutDimChange();
        syncCanvasToDims();
        drawCanvas();
        commit();
        fitNode();
        refreshSizePendingHint();
      }

      for (const el of [wInp, hInp, scaleSel, updateSizeBtn, opacityInp]) {
        el.addEventListener("mousedown", (e) => e.stopPropagation());
        el.addEventListener("wheel", (e) => e.stopPropagation());
      }
      for (const el of [wInp, hInp]) {
        el.addEventListener("input", () => refreshSizePendingHint());
        el.addEventListener("change", () => {
          syncLayoutWidgetsFromDom();
          persistEditorState();
          refreshSizePendingHint();
        });
      }
      scaleSel.addEventListener("change", () => {
        syncLayoutWidgetsFromDom();
        persistEditorState();
      });
      updateSizeBtn.addEventListener("click", () => {
        syncLayoutWidgetsFromDom();
        applyUpdateSize();
        persistEditorState();
      });
      syncDomFromLayoutWidgets();

      function recalcWidgetHeight() {
        if (canvasEl.width <= 0 || canvasEl.height <= 0) {
          node._widgetHeight = 400;
          return;
        }
        const contentH = panel.offsetTop + panel.offsetHeight;
        if (contentH > 0) node._widgetHeight = contentH + 10;
        else {
          const ch = Math.round(Math.max(100, editorInnerWidth()) * (canvasEl.height / canvasEl.width));
          node._widgetHeight = Number.isFinite(ch) ? ch + TOOLBAR_H + 90 : 400;
        }
      }

      function fitNode() {
        syncDomLayout();
        recalcWidgetHeight();
        const minH = node.computeSize()[1];
        if (node.size[1] < minH) node.setSize([node.size[0], minH]);
        syncDomLayout();
      }

      function toPx(b) {
        const { canvasEl: c } = getLiveCanvas();
        return {
          x1: b.x * c.width, y1: b.y * c.height,
          x2: (b.x + b.w) * c.width, y2: (b.y + b.h) * c.height,
        };
      }

      function mouseN(e) {
        const { canvasEl: c } = getLiveCanvas();
        const r = c.getBoundingClientRect();
        return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
      }

      function wrapLines(text, maxW) {
        const lines = [];
        for (const para of text.split("\n")) {
          let line = "";
          for (const word of para.split(/\s+/)) {
            if (!word) continue;
            const test = line ? line + " " + word : word;
            if (line && ctx.measureText(test).width > maxW) { lines.push(line); line = word; }
            else line = test;
          }
          lines.push(line);
        }
        return lines;
      }

      function normalizeBox(b) { return normalizeBoxCoords(b); }

      function applyLayoutDimChange() {
        const { w: newW, h: newH } = readLayoutDimsFromDom();
        const oldW = layoutDim(node._layoutW);
        const oldH = layoutDim(node._layoutH);
        const mode = scaleSel.value || "stretch";
        if (mode !== "stretch" && node._boxes.length && (oldW !== newW || oldH !== newH)) {
          node._boxes = transformBoxesContentUniform(node._boxes, oldW, oldH, newW, newH, mode);
          serialize();
        }
        node._layoutW = newW;
        node._layoutH = newH;
      }

      function rectHitTestN(mx, my, x1, y1, x2, y2, rx, ry) {
        const h = (cx, cy) => Math.abs(mx - cx) < rx && Math.abs(my - cy) < ry;
        if (h(x1, y1)) return "resize-tl";
        if (h(x2, y1)) return "resize-tr";
        if (h(x1, y2)) return "resize-bl";
        if (h(x2, y2)) return "resize-br";
        if (mx >= x1 && mx <= x2 && Math.abs(my - y1) < ry) return "resize-t";
        if (mx >= x1 && mx <= x2 && Math.abs(my - y2) < ry) return "resize-b";
        if (my >= y1 && my <= y2 && Math.abs(mx - x1) < rx) return "resize-l";
        if (my >= y1 && my <= y2 && Math.abs(mx - x2) < rx) return "resize-r";
        if (mx >= x1 && mx <= x2 && my >= y1 && my <= y2) return "move";
        return null;
      }

      function boxesAt(mN) {
        const rx = HANDLE / canvasEl.width, ry = HANDLE / canvasEl.height;
        const res = [];
        for (let i = node._boxes.length - 1; i >= 0; i--) {
          const b = node._boxes[i];
          const mode = rectHitTestN(mN.x, mN.y, b.x, b.y, b.x + b.w, b.y + b.h, rx, ry);
          if (mode) res.push({ index: i, mode });
        }
        const ai = res.findIndex((c) => c.index === node._activeIdx);
        if (ai > 0) res.unshift(res.splice(ai, 1)[0]);
        return res;
      }

      // Shift-click and double-click follow paint order. boxesAt pulls the
      // active region to the front so its handles win a drag, which made it
      // impossible to toggle or edit the region drawn on top of it.
      function topIndexAt(mN) {
        const { canvasEl: c } = getLiveCanvas();
        if (!(c.width > 0) || !(c.height > 0)) return -1;
        return topRegionIndex(node._boxes, mN.x, mN.y, HANDLE / c.width, HANDLE / c.height);
      }

      function groupHitTest(mN) {
        if (node._selected.size <= 1) return null;
        const g = groupBbox(node._selected);
        if (!g || g.w < 0.001 || g.h < 0.001) return null;
        const rx = HANDLE / canvasEl.width, ry = HANDLE / canvasEl.height;
        return rectHitTestN(mN.x, mN.y, g.x, g.y, g.x + g.w, g.y + g.h, rx, ry);
      }

      function hitTest(mN) {
        const gh = groupHitTest(mN);
        if (gh) return { index: -1, mode: gh, group: true };
        const cands = boxesAt(mN);
        if (!cands.length) return null;
        return cands.find((c) => c.index === node._activeIdx && c.mode !== "move") || cands[0];
      }

      function tagRects() {
        ctx.font = "bold 10px sans-serif";
        const W = canvasEl.width, H = canvasEl.height, h = 14;
        const placed = [], rects = [];
        const hits = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
        for (let i = 0; i < node._boxes.length; i++) {
          const b = node._boxes[i];
          const x1 = b.x * W, y1 = b.y * H, x2 = (b.x + b.w) * W, y2 = (b.y + b.h) * H;
          const tag = (b.type === "text" ? "T" : "O") + (i + 1);
          const w = ctx.measureText(tag).width + 8;
          let pick = [x1, y1];
          for (const [cx, cy] of [[x1, y1], [x2 - w, y1], [x2 - w, y2 - h], [x1, y2 - h]]) {
            if (!placed.some((p) => hits({ x: cx, y: cy, w, h }, p))) { pick = [cx, cy]; break; }
          }
          const r = { x: pick[0], y: pick[1], w, h, tag };
          placed.push(r);
          rects[i] = r;
        }
        return rects;
      }

      function titleAt(mN) {
        const px = mN.x * canvasEl.width, py = mN.y * canvasEl.height;
        const rects = tagRects();
        for (let i = node._boxes.length - 1; i >= 0; i--) {
          const r = rects[i];
          if (r && px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h) return i;
        }
        return null;
      }

      function rectsOverlapN(a, b) {
        return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
      }

      function normalizeMarquee(m0, m1) {
        const x = Math.min(m0.x, m1.x), y = Math.min(m0.y, m1.y);
        return { x, y, w: Math.abs(m1.x - m0.x), h: Math.abs(m1.y - m0.y) };
      }

      function boxesInMarquee(m0, m1) {
        const m = normalizeMarquee(m0, m1);
        if (m.w < 0.002 && m.h < 0.002) return [];
        const hits = [];
        for (let i = 0; i < node._boxes.length; i++) {
          if (rectsOverlapN(m, node._boxes[i])) hits.push(i);
        }
        return hits;
      }

      function applyMarqueeSelection() {
        if (!node._marqueeStartN || !node._marqueeEndN) return;
        const hits = boxesInMarquee(node._marqueeStartN, node._marqueeEndN);
        node._selected = new Set([...(node._marqueeBaseSel || []), ...hits]);
        if (node._selected.size && !node._selected.has(node._activeIdx))
          node._activeIdx = [...node._selected][node._selected.size - 1];
        if (!node._selected.size) node._activeIdx = -1;
      }

      function shiftClickBox(idx) {
        if (idx < 0 || idx >= node._boxes.length) return;
        if (node._selected.has(idx)) {
          node._selected.delete(idx);
          if (node._activeIdx === idx)
            node._activeIdx = node._selected.size ? [...node._selected][node._selected.size - 1] : -1;
        } else {
          addToSelection(idx);
        }
      }

      function pickForSelection(mN, cycle, _shiftKey) {
        const cands = boxesAt(mN);
        if (!cands.length) return null;
        const ah = cands.find((c) => c.index === node._activeIdx && c.mode !== "move");
        if (ah && !cycle) return ah;
        const ti = titleAt(mN);
        if (ti !== null && !cycle) return { index: ti, mode: "move" };
        if (cycle && cands.length > 1) {
          const pos = cands.findIndex((c) => c.index === node._activeIdx);
          return cands[(pos + 1) % cands.length];
        }
        return cands.find((c) => c.index === node._activeIdx && c.mode !== "move") || cands[0];
      }

      function applyDrag(mode, start, dN) {
        let { x, y, w, h } = start;
        const dx = dN.x, dy = dN.y;
        switch (mode) {
          case "move": x += dx; y += dy; x = clamp01(Math.min(x, 1 - w)); y = clamp01(Math.min(y, 1 - h)); break;
          case "draw":
          case "resize-br": w += dx; h += dy; break;
          case "resize-tl": x += dx; y += dy; w -= dx; h -= dy; break;
          case "resize-tr": y += dy; w += dx; h -= dy; break;
          case "resize-bl": x += dx; w -= dx; h += dy; break;
          case "resize-t": y += dy; h -= dy; break;
          case "resize-b": h += dy; break;
          case "resize-l": x += dx; w -= dx; break;
          case "resize-r": w += dx; break;
        }
        return mode === "move" ? { ...start, x, y } : normalizeBox({ ...start, x, y, w, h });
      }

      function applyGroupDrag(mode, groupStart, dN, boxesStart) {
        const ng = applyDrag(mode, groupStart, dN);
        const result = {};
        const idxs = [...node._selected];
        for (let j = 0; j < idxs.length; j++) {
          const sb = boxesStart[j];
          const relX = (sb.x - groupStart.x) / groupStart.w;
          const relY = (sb.y - groupStart.y) / groupStart.h;
          const relW = sb.w / groupStart.w;
          const relH = sb.h / groupStart.h;
          result[idxs[j]] = normalizeBox({
            ...sb,
            x: ng.x + relX * ng.w,
            y: ng.y + relY * ng.h,
            w: relW * ng.w,
            h: relH * ng.h,
          });
        }
        return result;
      }

      function syncOpacityFromWidget() {
        const v = layoutOpacity(node.properties?.byae_bg_opacity);
        const pct = Math.round(v * 100);
        opacityInp.value = String(pct);
        opacityVal.textContent = pct + "%";
        syncBgDisplay();
      }

      function syncOpacityToWidget() {
        const v = layoutOpacity(Number(opacityInp.value) / 100);
        const pct = Math.round(v * 100);
        opacityInp.value = String(pct);
        opacityVal.textContent = pct + "%";
        ensureProps();
        node.properties.byae_bg_opacity = v;
        syncBgDisplay();
        drawCanvas();
      }

      function getBgOpacity() {
        return layoutOpacity(Number(opacityInp.value) / 100);
      }

      opacityInp.addEventListener("input", syncOpacityToWidget);
      syncOpacityFromWidget();

      let _rafPending = false;
      function drawCanvas() {
        if (_rafPending) return;
        _rafPending = true;
        requestAnimationFrame(() => { _rafPending = false; _draw(); });
      }

      function _draw() {
        const { canvasEl: c, ctx: drawCtx } = getLiveCanvas();
        const W = c.width, H = c.height;
        if (W <= 0 || H <= 0) return;
        ctx = drawCtx;

        ctx.clearRect(0, 0, W, H);
        if (!node._bgDisplayUrl) {
          ctx.fillStyle = "#1a1a1a";
          ctx.fillRect(0, 0, W, H);
        }

        const order = node._boxes.map((_, i) => i).filter((i) => !node._selected.has(i) || i !== node._activeIdx);
        for (const i of [...node._selected]) {
          if (i !== node._activeIdx && !order.includes(i)) order.push(i);
        }
        if (node._activeIdx >= 0 && !order.includes(node._activeIdx)) order.push(node._activeIdx);

        const tagR = tagRects();
        for (const i of order) {
          const b = node._boxes[i];
          const col = boxColor(i);
          const selected = node._selected.has(i);
          const active = i === node._activeIdx;
          const { x1, y1, x2, y2 } = toPx(b);
          const w = x2 - x1, h = y2 - y1;
          ctx.fillStyle = col + (selected ? "44" : "22");
          ctx.fillRect(x1, y1, w, h);
          if (b.nobbox) ctx.setLineDash([6, 4]);
          ctx.strokeStyle = col;
          ctx.lineWidth = active || selected ? 2 : 1;
          ctx.strokeRect(x1, y1, w, h);
          ctx.setLineDash([]);
          if (active || (selected && node._selected.size === 1)) {
            ctx.fillStyle = col;
            for (const [hx, hy] of [[x1, y1], [x2, y1], [x1, y2], [x2, y2]])
              ctx.fillRect(hx - 4, hy - 4, 8, 8);
          }
          ctx.save();
          ctx.beginPath();
          ctx.rect(x1, y1, w, h);
          ctx.clip();
          let body = b.desc || "";
          if (b.type === "text" && b.text) body = `"${b.text}"` + (body ? " — " + body : "");
          if (body) {
            ctx.font = "11px sans-serif";
            ctx.fillStyle = "#fff";
            ctx.shadowColor = "#000";
            ctx.shadowBlur = 2;
            const pad = 4, lh = 13;
            let ty = y1 + 14 + 11;
            for (const line of wrapLines(body, w - pad * 2)) {
              if (ty > y1 + h) break;
              ctx.fillText(line, x1 + pad, ty);
              ty += lh;
            }
            ctx.shadowBlur = 0;
          }
          if (b.palette?.length) {
            for (let p = 0; p < b.palette.length; p++) {
              ctx.fillStyle = b.palette[p];
              ctx.fillRect(x1 + 2 + p * 9, y2 - 9, 7, 7);
              ctx.strokeStyle = "#000";
              ctx.lineWidth = 1;
              ctx.strokeRect(x1 + 2 + p * 9, y2 - 9, 7, 7);
            }
          }
          const tr = tagR[i];
          ctx.font = "bold 10px sans-serif";
          ctx.fillStyle = col;
          ctx.fillRect(tr.x, tr.y, tr.w, 14);
          if (i === node._hoverTitle) {
            ctx.fillStyle = "rgba(255,255,255,0.25)";
            ctx.fillRect(tr.x, tr.y, tr.w, 14);
            ctx.strokeStyle = "#fff";
            ctx.lineWidth = 1;
            ctx.strokeRect(tr.x + 0.5, tr.y + 0.5, tr.w - 1, 13);
          }
          ctx.fillStyle = "#000";
          ctx.fillText(tr.tag, tr.x + 4, tr.y + 11);
          ctx.restore();
        }

        if (node._selected.size > 1) {
          const g = groupBbox(node._selected);
          if (g) {
            const { x1, y1, x2, y2 } = toPx(g);
            ctx.strokeStyle = "#ffffff";
            ctx.lineWidth = 1;
            ctx.setLineDash([4, 3]);
            ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
            ctx.setLineDash([]);
            ctx.fillStyle = "#fff";
            for (const [hx, hy] of [[x1, y1], [x2, y1], [x1, y2], [x2, y2]])
              ctx.fillRect(hx - 4, hy - 4, 8, 8);
          }
        }

        if (node._dragMode === "marquee" && node._marqueeStartN && node._marqueeEndN) {
          const m = normalizeMarquee(node._marqueeStartN, node._marqueeEndN);
          const { x1, y1, x2, y2 } = toPx(m);
          ctx.fillStyle = "rgba(70, 180, 230, 0.15)";
          ctx.fillRect(x1, y1, x2 - x1, y2 - y1);
          ctx.strokeStyle = "#46b4e6";
          ctx.lineWidth = 1;
          ctx.setLineDash([4, 3]);
          ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
          ctx.setLineDash([]);
        }
      }

      function serialize() {
        persistEditorState();
      }

      function commit() { persistEditorState(); renderPanel(); drawCanvas(); updateTokens(); }

      function removeBox(i) {
        node._boxes.splice(i, 1);
        const newSel = new Set();
        for (const s of node._selected) {
          if (s < i) newSel.add(s);
          else if (s > i) newSel.add(s - 1);
        }
        node._selected = newSel;
        if (node._boxes.length === 0) node._activeIdx = -1;
        else if (i <= node._activeIdx) node._activeIdx = Math.max(0, node._activeIdx - 1);
        if (node._activeIdx >= 0 && !node._selected.has(node._activeIdx)) {
          if (node._selected.size) node._activeIdx = [...node._selected][0];
        }
      }

      function removeSelected() {
        const toRemove = [...node._selected].sort((a, b) => b - a);
        for (const i of toRemove) removeBox(i);
        node._selected = new Set();
      }

      canvasEl.addEventListener("mousedown", (e) => {
        if (e.button === 2) {
          e.preventDefault();
          const hit = hitTest(mouseN(e));
          if (hit?.group) return;
          if (hit) {
            singleSelect(hit.index);
            removeBox(hit.index);
          } else if (node._activeIdx >= 0) removeBox(node._activeIdx);
          commit();
          fitNode();
          return;
        }
        if (e.button !== 0) return;
        canvasEl.focus();
        node._hoverTitle = null;
        const mN = mouseN(e);

        if (e.shiftKey) {
          node._dragMode = "marquee";
          node._marqueeStartN = mN;
          node._marqueeEndN = mN;
          node._marqueeBaseSel = new Set(node._selected);
          node._drawing = true;
          node._dragStartN = mN;
          document.addEventListener("mousemove", onMove);
          document.addEventListener("mouseup", onUp);
          e.preventDefault();
          e.stopPropagation();
          drawCanvas();
          return;
        }

        const gh = groupHitTest(mN);
        if (gh && node._selected.size > 1) {
          node._dragMode = gh;
          node._groupAtStart = groupBbox(node._selected);
          node._boxesAtStart = [...node._selected].map((i) => ({ ...node._boxes[i] }));
          node._drawing = true;
          node._dragStartN = mN;
          document.addEventListener("mousemove", onMove);
          document.addEventListener("mouseup", onUp);
          e.preventDefault();
          e.stopPropagation();
          return;
        }

        const hit = pickForSelection(mN, e.altKey, false);
        if (hit) {
          if (node._selected.has(hit.index) && node._selected.size > 1) {
            node._activeIdx = hit.index;
          } else singleSelect(hit.index);

          if (node._selected.size > 1 && hit.mode === "move") {
            node._dragMode = "move";
            node._groupAtStart = groupBbox(node._selected);
            node._boxesAtStart = [...node._selected].map((i) => ({ ...node._boxes[i] }));
          } else {
            node._dragMode = hit.mode;
            node._boxAtStart = { ...node._boxes[hit.index] };
          }
        } else {
          node._selected = new Set();
          node._dragMode = "draw";
          const nb = { x: mN.x, y: mN.y, w: 0, h: 0, type: "obj", text: "", desc: "", palette: [] };
          node._boxes.push(nb);
          node._activeIdx = node._boxes.length - 1;
          singleSelect(node._activeIdx);
          node._boxAtStart = { ...nb };
        }
        node._drawing = true;
        node._dragStartN = mN;
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
        e.preventDefault();
        e.stopPropagation();
        drawCanvas();
      });

      canvasEl.addEventListener("mousemove", (e) => {
        if (node._drawing) return;
        const mN = mouseN(e);
        const ti = titleAt(mN);
        if (ti !== node._hoverTitle) { node._hoverTitle = ti; drawCanvas(); }
        if (ti !== null) { canvasEl.style.cursor = "pointer"; return; }
        const gh = groupHitTest(mN);
        if (gh) { canvasEl.style.cursor = cursorForBboxMode(gh) || "crosshair"; return; }
        const hit = hitTest(mN);
        canvasEl.style.cursor = hit ? (cursorForBboxMode(hit.mode) || "crosshair") : "crosshair";
      });

      canvasEl.addEventListener("mouseleave", () => {
        if (node._hoverTitle !== null) { node._hoverTitle = null; drawCanvas(); }
      });

      let inlineTa = null;
      function closeInlineEditor() {
        if (inlineTa) { inlineTa.remove(); inlineTa = null; }
      }

      function openInlineEditor(idx) {
        closeInlineEditor();
        const b = node._boxes[idx];
        if (!b) return;
        singleSelect(idx);
        const dw = canvasEl.offsetWidth, dh = canvasEl.offsetHeight;
        const ox = canvasEl.offsetLeft, oy = canvasEl.offsetTop;
        const w = Math.min(dw, Math.max(70, b.w * dw));
        const h = Math.min(dh, Math.max(42, b.h * dh));
        const left = Math.max(ox, Math.min(ox + b.x * dw, ox + dw - w));
        const top = Math.max(oy, Math.min(oy + b.y * dh, oy + dh - h));
        const ta = document.createElement("textarea");
        ta.className = "byae-ideo-inline";
        ta.value = b.desc || "";
        ta.style.left = left + "px";
        ta.style.top = top + "px";
        ta.style.width = w + "px";
        ta.style.height = h + "px";
        ta.style.borderColor = boxColor(idx);
        stopProp(ta);
        wrap.appendChild(ta);
        inlineTa = ta;
        ta.focus();
        ta.select();
        const orig = b.desc || "";
        let cancelled = false;
        ta.addEventListener("input", () => { b.desc = ta.value; drawCanvas(); updateTokens(); });
        ta.addEventListener("keydown", (e) => {
          e.stopPropagation();
          if (e.key === "Escape") { cancelled = true; b.desc = orig; ta.blur(); }
          else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) ta.blur();
        });
        ta.addEventListener("blur", () => {
          if (!cancelled) b.desc = ta.value;
          closeInlineEditor();
          commit();
        });
      }

      canvasEl.addEventListener("dblclick", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const top = topIndexAt(mouseN(e));
        if (top >= 0) openInlineEditor(top);
      });

      canvasEl.addEventListener("keydown", (e) => {
        if (e.ctrlKey || e.metaKey) {
          if (e.key === "c" || e.key === "C") {
            e.preventDefault();
            e.stopPropagation();
            const src = node._selected.size ? [...node._selected] : (node._activeIdx >= 0 ? [node._activeIdx] : []);
            if (!src.length) return;
            node._clipBoxes = src.map((i) => cloneBox(node._boxes[i]));
            return;
          }
          if (e.key === "v" || e.key === "V") {
            e.preventDefault();
            e.stopPropagation();
            if (!node._clipBoxes?.length) return;
            const newIdxs = [];
            for (const nb of pasteRegions(node._clipBoxes.map((b) => cloneBox(b)))) {
              node._boxes.push(nb);
              newIdxs.push(node._boxes.length - 1);
            }
            setSelection(newIdxs);
            commit();
            fitNode();
            return;
          }
        }
        if ((e.key === "Delete" || e.key === "Backspace") && !node._drawing) {
          e.preventDefault();
          e.stopPropagation();
          if (node._selected.size > 1) removeSelected();
          else if (node._activeIdx >= 0) removeBox(node._activeIdx);
          commit();
          fitNode();
        }
      });

      function onMove(e) {
        if (!node._drawing) return;
        const mN = mouseN(e);

        if (node._dragMode === "marquee") {
          node._marqueeEndN = mN;
          applyMarqueeSelection();
          drawCanvas();
          return;
        }

        const dN = { x: mN.x - node._dragStartN.x, y: mN.y - node._dragStartN.y };

        if (node._groupAtStart && node._boxesAtStart) {
          const updated = applyGroupDrag(node._dragMode, node._groupAtStart, dN, node._boxesAtStart);
          for (const [idx, nb] of Object.entries(updated)) {
            delete nb.nobbox;
            node._boxes[+idx] = nb;
          }
        } else if (node._boxAtStart != null && node._activeIdx >= 0) {
          const nb = applyDrag(node._dragMode, node._boxAtStart, dN);
          delete nb.nobbox;
          node._boxes[node._activeIdx] = nb;
        }
        drawCanvas();
      }

      function onUp(e) {
        if (!node._drawing) return;
        node._drawing = false;
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);

        if (node._dragMode === "marquee") {
          const mN = e ? mouseN(e) : node._marqueeEndN;
          const dx = Math.abs(mN.x - node._marqueeStartN.x);
          const dy = Math.abs(mN.y - node._marqueeStartN.y);
          if (dx < 0.008 && dy < 0.008) {
            node._selected = new Set(node._marqueeBaseSel || []);
            const top = topIndexAt(mN);
            if (top >= 0) shiftClickBox(top);
            else if (!node._selected.size) node._activeIdx = -1;
          } else {
            node._marqueeEndN = mN;
            applyMarqueeSelection();
          }
          node._dragMode = null;
          node._marqueeStartN = null;
          node._marqueeEndN = null;
          node._marqueeBaseSel = null;
          commit();
          return;
        }

        node._groupAtStart = null;
        node._boxesAtStart = null;
        const b = node._boxes[node._activeIdx];
        if (b && (b.w < 0.005 || b.h < 0.005) && node._dragMode === "draw") removeBox(node._activeIdx);
        node._boxAtStart = null;
        commit();
      }

      canvasEl.addEventListener("contextmenu", (e) => e.preventDefault());

      function clearAll() {
        closeInlineEditor();
        node._boxes = [];
        node._activeIdx = -1;
        node._selected = new Set();
        node._stylePalette = [];
        setWidgetVal("high_level_description", "");
        setWidgetVal("background", "");
        setWidgetVal("aesthetics", "");
        setWidgetVal("lighting", "");
        setWidgetVal("medium", "");
        setWidgetVal("style", "none");
        commit();
        rebuildStylePalette();
        fitNode();
      }

      clearBtn.addEventListener("mousedown", (e) => e.stopPropagation());
      clearBtn.addEventListener("click", clearAll);

      function pyJson(v, lvl = 0) {
        if (v === null) return "null";
        if (typeof v === "number" || typeof v === "boolean") return String(v);
        if (typeof v === "string") return JSON.stringify(v);
        const pad = "    ".repeat(lvl + 1), end = "    ".repeat(lvl);
        if (Array.isArray(v)) {
          if (!v.length) return "[]";
          if (v.every((x) => x === null || typeof x !== "object"))
            return "[" + v.map((x) => pyJson(x, lvl)).join(", ") + "]";
          return "[\n" + v.map((x) => pad + pyJson(x, lvl + 1)).join(",\n") + "\n" + end + "]";
        }
        const keys = Object.keys(v);
        if (!keys.length) return "{}";
        return "{\n" + keys.map((k) => pad + JSON.stringify(k) + ": " + pyJson(v[k], lvl + 1)).join(",\n") + "\n" + end + "}";
      }

      function getW(name) {
        if (name.startsWith("style.")) {
          const field = name.slice(6);
          const w = findW(field) || findW(name);
          return widgetString(w?.value);
        }
        return widgetString(findW(name)?.value);
      }

      function buildCaption() {
        const cap = {};
        const hld = getW("high_level_description").trim();
        if (hld) cap.high_level_description = hld;
        const kind = getStyleKind(node);
        if (kind !== "none") {
          const sd = { aesthetics: getW("aesthetics"), lighting: getW("lighting") };
          if (kind === "photo") { sd.photo = getW("style.photo"); sd.medium = getW("medium"); }
          else { sd.medium = getW("medium"); sd.art_style = getW("style.art_style"); }
          const pal = cleanPalette(node._stylePalette, MAX_STYLE_COLORS);
          if (pal.length) sd.color_palette = pal;
          cap.style_description = sd;
        }
        const elements = node._boxes.map((b) => {
          const etype = b.type === "text" ? "text" : "obj";
          const el = { type: etype };
          if (!b.nobbox) {
            const bbox = rectToIdeogramBbox(b);
            if (bbox) el.bbox = bbox;
          }
          if (etype === "text") el.text = captionText(b.text);
          el.desc = captionText(b.desc);
          const pal = cleanPalette(b.palette, MAX_ELEM_COLORS);
          if (pal.length) el.color_palette = pal;
          return el;
        });
        cap.compositional_deconstruction = { background: getW("background"), elements };
        return pyJson(cap);
      }

      function updateTokens() {
        try {
          tokenSpan.textContent = "~" + Math.ceil(buildCaption().length / 4) + " tok";
        } catch (e) {
          tokenSpan.textContent = "";
        }
      }

      async function doCopy() {
        const txt = buildCaption();
        try {
          await navigator.clipboard.writeText(txt);
          copyBtn.textContent = "Copied";
          setTimeout(() => (copyBtn.textContent = "Copy JSON"), 900);
        } catch (e) {
          window.prompt("Copy the caption JSON:", txt);
        }
      }

      copyBtn.addEventListener("mousedown", (e) => e.stopPropagation());
      copyBtn.addEventListener("click", doCopy);

      function setWidgetVal(name, val) {
        if (name.startsWith("style.")) {
          const field = name.slice(6);
          const w = findW(field) || findW(name);
          if (!w) return;
          const coerced = coerceWidgetValue(w, val);
          w.value = coerced;
          w.callback?.(coerced);
          return;
        }
        const w = findW(name);
        if (!w) return;
        const coerced = coerceWidgetValue(w, val);
        w.value = coerced;
        w.callback?.(coerced);
      }

      function bboxElemToBox(el, idx) {
        return elementToRegion(el, idx);
      }

      function remapImportedBoxes(boxes, importOpts = { source: "stretch" }) {
        const { w: newW, h: newH } = readLayoutDimsFromDom();
        return remapImportedRegions(boxes, {
          source: importOpts.source,
          srcW: importOpts.srcW,
          srcH: importOpts.srcH,
          aspect: importOpts.aspect,
          destW: newW,
          destH: newH,
          mode: scaleSel.value || "stretch",
        });
      }

      function applyCaption(cap, importOpts = { source: "stretch" }) {
        const cd = (cap && cap.compositional_deconstruction) || {};
        const els = Array.isArray(cd.elements) ? cd.elements : [];
        node._boxes = remapImportedBoxes(
          els.map((el, i) => bboxElemToBox(el, i)).filter(Boolean),
          importOpts,
        );
        node._activeIdx = node._boxes.length ? 0 : -1;
        node._selected = node._boxes.length ? new Set([0]) : new Set();
        setWidgetVal("high_level_description", cap.high_level_description || "");
        setWidgetVal("background", cd.background || "");
        const sd = cap.style_description || {};
        let kind = "none";
        if (typeof sd.photo === "string") kind = "photo";
        else if (typeof sd.art_style === "string") kind = "art_style";
        setWidgetVal("style", kind);
        if (kind === "photo") setWidgetVal("style.photo", sd.photo || "");
        else if (kind === "art_style") setWidgetVal("style.art_style", sd.art_style || "");
        setWidgetVal("aesthetics", sd.aesthetics || "");
        setWidgetVal("lighting", sd.lighting || "");
        setWidgetVal("medium", sd.medium || "");
        node._stylePalette = Array.isArray(sd.color_palette) ? sd.color_palette.slice() : [];
      }

      function tryParseCaption(t) {
        if (!t) return null;
        try {
          const o = JSON.parse(t);
          return (o && typeof o === "object" && o.compositional_deconstruction) ? o : null;
        } catch (e) { return null; }
      }

      async function doImport() {
        let cap = null, txt = "";
        try {
          txt = (await navigator.clipboard.readText() || "").trim();
          cap = tryParseCaption(txt);
        } catch (e) {
          console.warn("ByAE Ideogram: clipboard read failed:", e);
        }
        if (!cap) {
          txt = (window.prompt("Paste Ideogram 4 caption JSON:", "") || "").trim();
          cap = tryParseCaption(txt);
        }
        if (!cap) { if (txt) alert("Not a valid Ideogram 4 caption JSON."); return; }
        showPasteJsonSourceModal((importOpts) => {
          closeInlineEditor();
          applyCaption(cap, importOpts);
          commit();
          rebuildStylePalette();
          refreshSizePendingHint();
          fitNode();
        });
      }

      importBtn.addEventListener("mousedown", (e) => e.stopPropagation());
      importBtn.addEventListener("click", doImport);

      function captureSceneState() {
        return {
          boxes: node._boxes.map(cloneBox),
          stylePalette: node._stylePalette.slice(),
          widgets: {
            high_level_description: getW("high_level_description"),
            background: getW("background"),
            aesthetics: getW("aesthetics"),
            lighting: getW("lighting"),
            medium: getW("medium"),
            style: getStyleKind(node),
            photo: getW("style.photo"),
            art_style: getW("style.art_style"),
          },
        };
      }

      function applySceneState(state, replace) {
        if (replace) clearAll();
        const startIdx = node._boxes.length;
        const incoming = (state.boxes || []).map(cloneBox);
        const placed = replace ? incoming : offsetAddedRegions(incoming);
        const newIdxs = [];
        for (const nb of placed) {
          node._boxes.push(nb);
          newIdxs.push(startIdx + newIdxs.length);
        }
        if (replace) {
          setWidgetVal("high_level_description", state.widgets?.high_level_description || "");
          setWidgetVal("background", state.widgets?.background || "");
          setWidgetVal("aesthetics", state.widgets?.aesthetics || "");
          setWidgetVal("lighting", state.widgets?.lighting || "");
          setWidgetVal("medium", state.widgets?.medium || "");
          const kind = state.widgets?.style || "none";
          setWidgetVal("style", kind);
          if (kind === "photo") setWidgetVal("style.photo", state.widgets?.photo || "");
          else if (kind === "art_style") setWidgetVal("style.art_style", state.widgets?.art_style || "");
          node._stylePalette = Array.isArray(state.stylePalette) ? state.stylePalette.slice() : [];
          rebuildStylePalette();
        }
        setSelection(newIdxs.length ? newIdxs : (node._boxes.length ? [0] : []));
      }

      sceneSaveBtn.addEventListener("mousedown", (e) => e.stopPropagation());
      sceneSaveBtn.addEventListener("click", () => {
        showModal("Save Scene", [{ key: "name", label: "Scene name", placeholder: "my-scene" }], async (r) => {
          const name = (r.name || "").trim();
          if (!name) return;
          try {
            await saveStoreEntry("scenes", name, captureSceneState());
            console.log("ByAE Ideogram: saved scene:", name);
          } catch (e) {
            console.error("ByAE Ideogram: failed to save scene:", e);
            alert("Failed to save scene: " + e.message);
          }
        });
      });

      sceneLoadBtn.addEventListener("mousedown", (e) => e.stopPropagation());
      sceneLoadBtn.addEventListener("click", async () => {
        let stores;
        try {
          stores = await loadStores();
        } catch (e) {
          console.error("ByAE Ideogram: failed to load stores:", e);
          alert("Failed to load scene stores: " + e.message);
          return;
        }
        showSceneLoadModal(stores, (state, replace) => {
          closeInlineEditor();
          applySceneState(state, replace);
          commit();
          fitNode();
        });
      });

      function stopProp(el) {
        for (const ev of ["mousedown", "pointerdown", "wheel"]) el.addEventListener(ev, (e) => e.stopPropagation());
      }

      function buildSwatchRow(container, arr, max, onEdit, onStruct) {
        arr.forEach((hex, i) => {
          const sw = document.createElement("div");
          sw.className = "byae-ideo-sw";
          sw.style.background = hex;
          sw.title = "Click to edit · right-click to remove";
          const inp = document.createElement("input");
          inp.type = "color";
          inp.value = hex;
          stopProp(sw);
          sw.addEventListener("click", () => inp.click());
          sw.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            e.stopPropagation();
            arr.splice(i, 1);
            onStruct();
          });
          inp.addEventListener("input", () => { arr[i] = inp.value; sw.style.background = inp.value; onEdit(); });
          sw.appendChild(inp);
          container.appendChild(sw);
        });
        if (arr.length < max) {
          const add = document.createElement("button");
          add.className = "byae-ideo-btn";
          add.textContent = "+";
          stopProp(add);
          add.addEventListener("click", () => { arr.push("#ffffff"); onStruct(); });
          container.appendChild(add);
        }
      }

      function rebuildStylePalette() {
        while (styleBar.children.length > 1) styleBar.removeChild(styleBar.lastChild);
        buildSwatchRow(styleBar, node._stylePalette, MAX_STYLE_COLORS,
          () => { serialize(); drawCanvas(); },
          () => { serialize(); drawCanvas(); rebuildStylePalette(); fitNode(); });
      }

      function makeArea(field, value, placeholder, onInput, defaultH) {
        const ta = document.createElement("textarea");
        ta.className = "byae-ideo-area";
        ta.placeholder = placeholder;
        ta.value = value || "";
        const h = node._areaH[field] || defaultH;
        if (h) ta.style.height = h + "px";
        stopProp(ta);
        ta.addEventListener("input", onInput);
        const ro = new ResizeObserver(() => {
          if (ta.offsetHeight > 0) { node._areaH[field] = ta.offsetHeight; fitNode(); }
        });
        ro.observe(ta);
        node._areaObservers.push(ro);
        return ta;
      }

      async function persistBoxToStore(b, type, name) {
        const bucket = type === "object" ? "objects" : "characters";
        try {
          await saveStoreEntry(bucket, name, boxPayload(b));
          b.storeRef = { type, name };
          commit();
          console.log("ByAE Ideogram: saved", type, name);
        } catch (e) {
          console.error("ByAE Ideogram: failed to save:", e);
          alert("Failed to save: " + e.message);
        }
      }

      function doSaveStore(saveAs) {
        const b = node._boxes[node._activeIdx];
        if (!b) return;
        if (!saveAs && b.storeRef?.type && b.storeRef?.name) {
          persistBoxToStore(b, b.storeRef.type, b.storeRef.name);
          return;
        }
        const defaultType = b.storeRef?.type || "character";
        const defaultName = b.storeRef?.name || "";
        showModal(saveAs ? "Save As" : "Save", [
          { key: "type", label: "Type", type: "select", options: [
            { value: "character", label: "Character" },
            { value: "object", label: "Object" },
          ], default: defaultType },
          { key: "name", label: "Name", default: defaultName, placeholder: "name" },
        ], (r) => {
          const name = (r.name || "").trim();
          if (!name) return;
          persistBoxToStore(b, r.type, name);
        });
      }

      function forgetStoreRef(type, name) {
        let changed = false;
        for (const b of node._boxes) {
          if (b.storeRef && b.storeRef.type === type && b.storeRef.name === name) {
            delete b.storeRef;
            changed = true;
          }
        }
        if (changed) commit();
      }

      async function doLoadStore() {
        let stores;
        try {
          stores = await loadStores();
        } catch (e) {
          console.error("ByAE Ideogram: failed to load stores:", e);
          alert("Failed to load character/object stores: " + e.message);
          return;
        }
        showCharObjLoadModal(stores, ({ type, name }) => {
          const bucket = type === "object" ? stores.objects : stores.characters;
          const data = bucket[name];
          if (!data) return;
          const placed = staggerLoadedRegion(node._boxes.length);
          const nb = {
            x: placed.x, y: placed.y, w: placed.w, h: placed.h,
            type: data.type || "obj",
            text: data.text || "",
            desc: data.desc || "",
            palette: Array.isArray(data.palette) ? data.palette.slice() : [],
            storeRef: { type, name },
          };
          node._boxes.push(nb);
          singleSelect(node._boxes.length - 1);
          commit();
          fitNode();
        }, forgetStoreRef);
      }

      function renderPanel() {
        for (const ro of node._areaObservers) ro.disconnect();
        node._areaObservers = [];
        panel.innerHTML = "";
        const b = node._boxes[node._activeIdx];
        if (!b) {
          hint.textContent = "Drag to add · shift+drag select · shift+click toggle · ctrl+c/v";
          const p = document.createElement("div");
          p.style.color = "#888";
          p.textContent = node._boxes.length ? "Click a region to edit it." : "No regions yet.";
          panel.appendChild(p);
          requestAnimationFrame(fitNode);
          return;
        }

        const col = boxColor(node._activeIdx);
        const selNote = node._selected.size > 1 ? ` · ${node._selected.size} selected` : "";
        hint.innerHTML = `Editing <b style="color:${col}">region ${node._activeIdx + 1}</b>${selNote} · shift+drag · ctrl+c/v`;

        const storeRow = document.createElement("div");
        storeRow.className = "byae-ideo-row";
        const storeLbl = document.createElement("span");
        storeLbl.textContent = "Character / object:";
        storeRow.appendChild(storeLbl);
        const saveBtn = document.createElement("button");
        saveBtn.className = "byae-ideo-btn";
        saveBtn.textContent = "Save";
        saveBtn.title = b.storeRef ? "Overwrite saved entry" : "Save to character/object store";
        const saveAsBtn = document.createElement("button");
        saveAsBtn.className = "byae-ideo-btn";
        saveAsBtn.textContent = "Save As";
        const loadBtn = document.createElement("button");
        loadBtn.className = "byae-ideo-btn";
        loadBtn.textContent = "Load";
        loadBtn.title = "Load a saved character/object into the scene (adds new box)";
        stopProp(saveBtn);
        stopProp(saveAsBtn);
        stopProp(loadBtn);
        saveBtn.addEventListener("click", () => doSaveStore(false));
        saveAsBtn.addEventListener("click", () => doSaveStore(true));
        loadBtn.addEventListener("click", doLoadStore);
        storeRow.appendChild(saveBtn);
        if (b.storeRef) storeRow.appendChild(saveAsBtn);
        storeRow.appendChild(loadBtn);
        if (b.storeRef) {
          const refLbl = document.createElement("span");
          refLbl.style.color = "#888";
          refLbl.textContent = `(${b.storeRef.type}: ${b.storeRef.name})`;
          storeRow.appendChild(refLbl);
        }
        panel.appendChild(storeRow);

        const typeRow = document.createElement("div");
        typeRow.className = "byae-ideo-row";
        const lbl = document.createElement("span");
        lbl.textContent = "type:";
        typeRow.appendChild(lbl);
        for (const t of ["obj", "text"]) {
          const btn = document.createElement("button");
          btn.className = "byae-ideo-btn" + (b.type === t ? " active" : "");
          btn.textContent = t;
          stopProp(btn);
          btn.addEventListener("click", () => { b.type = t; commit(); });
          typeRow.appendChild(btn);
        }
        panel.appendChild(typeRow);

        if (b.type === "text") {
          panel.appendChild(makeArea("text", b.text, "text to render (verbatim)",
            function () { b.text = this.value; serialize(); drawCanvas(); updateTokens(); }));
        }

        panel.appendChild(makeArea("desc", b.desc, "description of this region",
          function () { b.desc = this.value; serialize(); drawCanvas(); updateTokens(); }, 110));

        const palRow = document.createElement("div");
        palRow.className = "byae-ideo-row";
        const pl = document.createElement("span");
        pl.textContent = "colors:";
        palRow.appendChild(pl);
        b.palette = b.palette || [];
        buildSwatchRow(palRow, b.palette, MAX_ELEM_COLORS,
          () => { serialize(); drawCanvas(); }, commit);
        panel.appendChild(palRow);

        requestAnimationFrame(fitNode);
      }

      function syncBgDisplay() {
        const { bgImgEl: bg } = getLiveCanvas();
        const url = node._bgDisplayUrl || "";
        const op = getBgOpacity();
        if (!bg) return;
        if (url && op > 0) {
          if (bg.dataset.byaeSrc !== url) {
            bg.dataset.byaeSrc = url;
            bg.src = url;
          }
          bg.style.opacity = String(op);
          bg.style.display = "block";
        } else {
          delete bg.dataset.byaeSrc;
          bg.removeAttribute("src");
          bg.style.display = "none";
        }
      }

      function applyBgDisplay(displayUrl) {
        node._bgDisplayUrl = displayUrl || null;
        node._bgUrl = displayUrl || null;
        syncBgDisplay();
        drawCanvas();
      }

      function bgStatUrl(guid) {
        return `/byae/ideogram/bg/${encodeURIComponent(guid)}/stat`;
      }

      function expectedBgFilename(guid) {
        return `byae_ideogram_bg_${guid}.png`;
      }

      function applyBgFromDetail(detail) {
        if (!detail?.url) return;
        const mtime = detail.mtime || Date.now();
        if (mtime <= (node._bgFileMtime || 0)) return;
        node._bgFileMtime = mtime;
        bgLog("background update", detail.path || expectedBgFilename(detail.guid), "mtime=", mtime);
        applyBgDisplay(`${detail.url}&t=${mtime}`);
      }

      node.byaeApplyBgUpdate = applyBgFromDetail;

      async function loadExistingBgOnce() {
        const guid = ensureBgGuid();
        try {
          const resp = await fetch(bgStatUrl(guid), { credentials: "same-origin" });
          if (!resp.ok) return;
          const data = await resp.json();
          if (data.exists && data.url) applyBgFromDetail(data);
        } catch (e) {
          console.warn("ByAE Ideogram: initial bg check failed:", e);
        }
      }

      for (const name of ["background", "high_level_description", "aesthetics", "lighting", "medium", "style"]) {
        const w = findW(name);
        if (w) chainCallback(w, "callback", () => updateTokens());
      }

      let _resizing = false;
      chainCallback(node, "onResize", function () {
        if (_resizing) return;
        _resizing = true;
        syncDomLayout();
        recalcWidgetHeight();
        const minH = node.computeSize()[1];
        if (node.size[1] < minH) node.size[1] = minH;
        syncDomLayout();
        drawCanvas();
        _resizing = false;
      });

      chainCallback(node, "onRemoved", function () {
        closeInlineEditor();
        for (const ro of node._areaObservers) ro.disconnect();
        node._areaObservers = [];
        delete node.byaePersistState;
        delete node.byaeGetPromptInputs;
        delete node.byaeApplyBgUpdate;
      });

      chainCallback(node, "onSerialize", function (info) {
        persistEditorState();
        info.properties = { ...(info.properties || {}), ...(node.properties || {}) };
      });

      chainCallback(node, "onConfigure", function (info) {
        ensureProps();
        if (info?.properties) Object.assign(node.properties, info.properties);
        stripInternalFields();
        sanitizeWidgetValues(node);
        if (info?.widgets_values && typeof info.widgets_values === "object" && !Array.isArray(info.widgets_values)) {
          applyWidgetValues(node, info.widgets_values, { silent: true });
        }
        sanitizeWidgetValues(node);
        restoreEditorState(info);
        sanitizeWidgetValues(node);
        syncDomLayout();
        syncCanvasToDims();
        rebuildStylePalette();
        renderPanel();
        loadExistingBgOnce();
        drawCanvas();
        updateTokens();
        refreshSizePendingHint();
        requestAnimationFrame(fitNode);
        setTimeout(() => { stripInternalFields(); restoreEditorState(info); syncDomLayout(); }, 50);
        setTimeout(() => { stripInternalFields(); }, 250);
      });

      setTimeout(() => {
        stripInternalFields();
        sanitizeWidgetValues(node);
        restoreEditorState({ properties: node.properties });
        sanitizeWidgetValues(node);
        if (node.size[0] < 380) node.setSize([380, node.size[1]]);
        syncDomLayout();
        syncCanvasToDims();
        rebuildStylePalette();
        renderPanel();
        loadExistingBgOnce();
        drawCanvas();
        updateTokens();
        refreshSizePendingHint();
        syncOpacityFromWidget();
        fitNode();
        syncDomLayout();
      }, 0);
    });
  },
});
