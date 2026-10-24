const { app } = window.comfyAPI.app;

// ─── General-purpose helpers shared across KJNodes JS ───

export function makeUUID() {
  let dt = new Date().getTime()
  const uuid = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = ((dt + Math.random() * 16) % 16) | 0
    dt = Math.floor(dt / 16)
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
  })
  return uuid
}

export function chainCallback(object, property, callback) {
  if (object == undefined) {
    console.error("Tried to add callback to non-existant object")
    return;
  }
  if (property in object) {
    const callback_orig = object[property]
    object[property] = function () {
      const r = callback_orig.apply(this, arguments);
      callback.apply(this, arguments);
      return r
    };
  } else {
    object[property] = callback;
  }
}

export function hideWidgetForGood(node, widget, suffix = '') {
  widget.origType = widget.type
  widget.origComputeSize = widget.computeSize
  widget.origSerializeValue = widget.serializeValue
  widget.computeSize = () => [0, -4]
  widget.type = "converted-widget" + suffix
  if (widget.linkedWidgets) {
    for (const w of widget.linkedWidgets) {
      hideWidgetForGood(node, w, ':' + widget.name)
    }
  }
}

/** Find a widget by input name (V3 input widgets) or widgets array. */
export function findNamedWidget(node, name) {
  const input = node.inputs?.find((i) => i.name === name);
  if (input?.widget) return input.widget;
  return node.widgets?.find((w) => w.name === name);
}

export function nodeClassName(node) {
  return node?.comfyClass || node?.type || "";
}

const STRING_WIDGET_NAMES = new Set([
  "high_level_description", "background", "aesthetics", "lighting", "medium",
  "import_json", "bg_guid", "style_palette_data", "elements_data",
  "photo", "art_style",
]);

function isNameBasedWidgetMap(widgetsValues) {
  if (!widgetsValues || typeof widgetsValues !== "object" || Array.isArray(widgetsValues)) return false;
  const keys = Object.keys(widgetsValues);
  if (!keys.length) return false;
  return keys.some((k) => STRING_WIDGET_NAMES.has(k) || k === "width" || k === "height" || k === "style");
}

export function coerceWidgetValue(widget, value) {
  const name = widget?.name || "";
  if (value == null || value === "") {
    if (name === "width" || name === "height") return 1024;
    if (name === "background_opacity") return 0.5;
    if (name === "scale_mode") return "stretch";
    if (name === "style") return "none";
    return "";
  }

  if (name === "style") {
    if (typeof value === "string") return value || "none";
    if (typeof value === "object" && value !== null && typeof value.style === "string") return value.style;
    return "none";
  }

  if (name === "scale_mode") {
    if (typeof value === "string") return value;
    if (typeof value === "object" && value !== null && typeof value.style === "string") return value.style;
    return "stretch";
  }

  if (name === "width" || name === "height") {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : 1024;
  }

  if (name === "background_opacity") {
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.5;
  }

  if (STRING_WIDGET_NAMES.has(name)) {
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    return "";
  }

  return value;
}

export function sanitizeWidgetValues(node) {
  for (const w of orderedSerializableWidgets(node)) {
    if (!w.name) continue;
    const coerced = coerceWidgetValue(w, w.value);
    if (coerced !== w.value) w.value = coerced;
  }
}

function assignWidgetValue(widget, value, silent) {
  const coerced = coerceWidgetValue(widget, value);
  if (!silent) {
    widget.value = coerced;
    return;
  }
  const cb = widget.callback;
  widget.callback = undefined;
  try {
    widget.value = coerced;
  } finally {
    widget.callback = cb;
  }
}

function orderedSerializableWidgets(node) {
  const list = [];
  const seen = new Set();
  for (const inp of node.inputs || []) {
    const w = inp.widget;
    if (!w || seen.has(w) || w.serialize === false) continue;
    seen.add(w);
    list.push(w);
  }
  for (const w of node.widgets || []) {
    if (!w || seen.has(w) || w.serialize === false) continue;
    seen.add(w);
    list.push(w);
  }
  return list;
}

/** Only used to repair workflows saved with a name-based widgets_values map. */
export function applyWidgetValues(node, widgetsValues, { silent = false } = {}) {
  if (!widgetsValues || !node.widgets) return;
  if (isNameBasedWidgetMap(widgetsValues)) {
    for (const name of Object.keys(widgetsValues)) {
      const w = findNamedWidget(node, name);
      if (!w || w.serialize === false) continue;
      assignWidgetValue(w, widgetsValues[name], silent);
    }
    return;
  }
  if (Array.isArray(widgetsValues)) {
    const ordered = orderedSerializableWidgets(node);
    for (let i = 0; i < ordered.length && i < widgetsValues.length; i++) {
      const w = ordered[i];
      if (!w?.name) continue;
      assignWidgetValue(w, widgetsValues[i], silent);
    }
  }
}

// ─── Graph coordinate helpers ───

export function clientToCanvas(lgCanvas, clientX, clientY) {
  const rect = lgCanvas.canvas.getBoundingClientRect();
  return [
    (clientX - rect.left) / lgCanvas.ds.scale - lgCanvas.ds.offset[0],
    (clientY - rect.top) / lgCanvas.ds.scale - lgCanvas.ds.offset[1],
  ];
}

export function getNodeAtPoint(graph, cx, cy) {
  for (let i = graph._nodes.length - 1; i >= 0; i--) {
    if (graph._nodes[i].isPointInside(cx, cy)) return graph._nodes[i];
  }
  return null;
}

export function typesCompatible(a, b) {
  if (a === "*" || b === "*") return true;
  if (a === b) return true;
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.toUpperCase() === b.toUpperCase()) return true;
  // ComfyUI accepts union types like "STRING,INT" — match if any token overlaps
  if (a.includes(",") || b.includes(",")) {
    const aTokens = a.toUpperCase().split(",").map(s => s.trim()).filter(Boolean);
    const bTokens = b.toUpperCase().split(",").map(s => s.trim()).filter(Boolean);
    if (aTokens.includes("*") || bTokens.includes("*")) return true;
    return aTokens.some(t => bTokens.includes(t));
  }
  return false;
}

// ─── Slot position helper ───
// Uses modern API (DOM-registered positions in Vue mode) with legacy fallback
export function getSlotPos(node, isInput, slotIdx) {
  if (isInput && node.getInputPos) return node.getInputPos(slotIdx);
  if (!isInput && node.getOutputPos) return node.getOutputPos(slotIdx);
  const out = [0, 0];
  node.getConnectionPos(isInput, slotIdx, out);
  return out;
}

// ─── Middle-click pan passthrough for DOM widgets ───
// Allows panning the LiteGraph canvas via middle-click drag on any DOM element
export function addMiddleClickPan(element) {
  const onMouseDown = (e) => {
    if (e.button !== 1) return;
    e.preventDefault();
    const ds = app.canvas?.ds;
    if (!ds) return;
    const startX = e.clientX, startY = e.clientY;
    const startOffsetX = ds.offset[0], startOffsetY = ds.offset[1];
    const onMove = (me) => {
      ds.offset[0] = startOffsetX + (me.clientX - startX);
      ds.offset[1] = startOffsetY + (me.clientY - startY);
      app.canvas.setDirty(true, true);
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };
  element.addEventListener('mousedown', onMouseDown);
  return () => element.removeEventListener('mousedown', onMouseDown);
}

export function getGraphLink(graph, linkId) {
  if (linkId == null || !graph) return null;
  for (const links of [graph.links, graph._links]) {
    if (!links) continue;
    if (typeof links.get === "function") {
      const link = links.get(linkId);
      if (link) return link;
    } else if (links[linkId] != null) {
      return links[linkId];
    }
  }
  return null;
}

export function normalizeGraphNodeId(id) {
  if (id == null) return null;
  const base = String(id).split(":")[0];
  const n = Number(base);
  return Number.isFinite(n) ? n : base;
}

export function getGraphNode(graph, id) {
  if (!graph || id == null) return null;
  const tries = new Set([id, String(id), normalizeGraphNodeId(id), String(normalizeGraphNodeId(id))]);
  const raw = String(id);
  if (raw.includes(":")) tries.add(raw.split(":")[0]);
  for (const t of tries) {
    const n = graph.getNodeById?.(t);
    if (n) return n;
  }
  return graph._nodes?.find((n) => {
    const nid = String(n.id);
    return nid === String(id)
      || normalizeGraphNodeId(nid) === normalizeGraphNodeId(id);
  }) ?? null;
}

function _addUpstreamId(ids, id) {
  if (id == null) return;
  ids.add(id);
  ids.add(String(id));
  const norm = normalizeGraphNodeId(id);
  ids.add(norm);
  ids.add(String(norm));
}

/** IMAGE wire chain upstream of a named input (not every node dependency). */
export function collectUpstreamNodeIds(node, inputName = "image", depth = 24) {
  const ids = new Set();
  if (!node?.graph) return ids;
  const slot = node.inputs.findIndex((inp) => inp.name === inputName);
  const idx = slot >= 0 ? slot : 0;
  const input = node.inputs[idx];
  if (!input?.link) return ids;

  function walk(n, d) {
    if (!n || d <= 0) return;
    _addUpstreamId(ids, n.id);

    const inputs = n.inputs || [];
    const slots = isPassthroughNode(n)
      ? inputs.map((_, i) => i)
      : inputs.map((inp, i) => i).filter((i) => {
        const type = String(inputs[i]?.type || "").toUpperCase();
        return type.includes("IMAGE");
      });

    for (const i of slots) {
      const inp = inputs[i];
      if (!inp?.link) continue;
      const link = getGraphLink(n.graph, inp.link);
      if (!link) continue;
      const up = getGraphNode(n.graph, link.origin_id);
      if (up) walk(up, d - 1);
    }
  }

  const link = getGraphLink(node.graph, input.link);
  if (!link) return ids;
  const origin = getGraphNode(node.graph, link.origin_id);
  if (origin) walk(origin, depth);
  return ids;
}

/** Scan upstream ids for a cached or live preview URL (closest nodes first). */
export function findPreviewUrlInUpstream(graph, upstreamIds, getExecUrl) {
  const ordered = upstreamIds instanceof Set ? [...upstreamIds] : upstreamIds;
  for (const id of ordered) {
    const cached = getExecUrl?.(id);
    if (cached) return { url: cached, nodeId: id, via: "cache" };
  }
  for (const id of ordered) {
    const n = getGraphNode(graph, id);
    const hit = resolveNodeImagePreview(n);
    if (hit?.url) return { ...hit, via: "node" };
  }
  return null;
}

export function upstreamContainsNode(upstreamIds, executedId) {
  if (!upstreamIds?.size || executedId == null) return false;
  const norm = normalizeGraphNodeId(executedId);
  return upstreamIds.has(executedId)
    || upstreamIds.has(String(executedId))
    || upstreamIds.has(norm)
    || upstreamIds.has(String(norm));
}

export function isPassthroughNode(node) {
  if (!node) return false;
  if (node.isVirtualNode) return true;
  const t = String(node.type || node.comfyClass || "");
  return t === "Reroute" || t.includes("Reroute");
}

/** Best-effort preview for a single graph node (any type). No graph walking. */
export function resolveNodeImagePreview(srcNode) {
  if (!srcNode) return null;

  if (srcNode.imgs?.length > 0 && srcNode.imgs[0]?.src) {
    return { url: srcNode.imgs[0].src, isVideo: false, nodeId: srcNode.id };
  }

  const vpWidget = srcNode.widgets?.find((w) => w.name === "videopreview");
  if (vpWidget?.videoEl?.src) {
    return { isVideo: true, videoEl: vpWidget.videoEl, nodeId: srcNode.id };
  }

  const fileW = srcNode.widgets?.find((w) => w.name === "image" || w.name === "video");
  if (fileW?.value) {
    let subfolder = "", fname = fileW.value;
    const lastSlash = fname.lastIndexOf("/");
    if (lastSlash >= 0) { subfolder = fname.substring(0, lastSlash); fname = fname.substring(lastSlash + 1); }
    const url = `/view?filename=${encodeURIComponent(fname)}&type=${fileW.name === "video" ? "input" : "input"}&subfolder=${encodeURIComponent(subfolder)}`;
    return { url, isVideo: fileW.name === "video", nodeId: srcNode.id };
  }

  return null;
}

/** Follow passthrough links to the first non-virtual upstream node (for onExecuted hooks). */
export function resolveUpstreamTerminalNode(node, inputSlot, depth = 12) {
  if (!node?.graph || depth <= 0) return null;
  const input = node.inputs?.[inputSlot];
  if (!input?.link) return null;
  const link = getGraphLink(node.graph, input.link);
  if (!link) return null;
  const srcNode = getGraphNode(node.graph, link.origin_id);
  if (!srcNode) return null;
  if (isPassthroughNode(srcNode)) {
    for (let i = 0; i < (srcNode.inputs?.length || 0); i++) {
      if (srcNode.inputs[i]?.link == null) continue;
      const up = resolveUpstreamTerminalNode(srcNode, i, depth - 1);
      if (up) return up;
    }
    return null;
  }
  return srcNode;
}

/** Walk upstream from node.inputs[inputSlot] to find a displayable image source. */
export function resolveUpstreamImagePreview(node, inputSlot, { depth = 12, visited, getExecUrl } = {}) {
  if (!node?.graph || depth <= 0) return null;
  const input = node.inputs?.[inputSlot];
  if (!input?.link) return null;
  const link = getGraphLink(node.graph, input.link);
  if (!link) return null;
  const srcNode = getGraphNode(node.graph, link.origin_id);
  if (!srcNode) return null;

  visited = visited || new Set();
  const visitKey = String(srcNode.id);
  if (visited.has(visitKey)) return null;
  visited.add(visitKey);

  if (isPassthroughNode(srcNode)) {
    for (let i = 0; i < (srcNode.inputs?.length || 0); i++) {
      const up = resolveUpstreamImagePreview(srcNode, i, { depth: depth - 1, visited, getExecUrl });
      if (up) return up;
    }
    return null;
  }

  const direct = resolveNodeImagePreview(srcNode);
  if (direct?.url || direct?.isVideo) return direct;

  if (getExecUrl) {
    const cached = getExecUrl(srcNode.id);
    if (cached) return { url: cached, isVideo: false, nodeId: srcNode.id };
  }

  for (let i = 0; i < (srcNode.inputs?.length || 0); i++) {
    const inp = srcNode.inputs[i];
    if (inp?.link == null) continue;
    const type = String(inp.type || "").toUpperCase();
    if (type !== "IMAGE" && !type.includes("IMAGE")) continue;
    const up = resolveUpstreamImagePreview(srcNode, i, { depth: depth - 1, visited, getExecUrl });
    if (up) return up;
  }
  return null;
}

// ─── Resolve preview image/video from a connected source node ───
export function resolveSourcePreview(node, inputSlot) {
  return resolveUpstreamImagePreview(node, inputSlot);
}

/** Remove incoming IMAGE links (builder nodes never take IMAGE sockets). */
export function removeIncomingImageLinks(node) {
  const graph = node?.graph;
  if (!graph?.links) return;
  const links = graph.links;
  const entries = links instanceof Map ? [...links.entries()] : Object.entries(links);
  for (const [linkId, link] of entries) {
    if (!link || link.target_id !== node.id) continue;
    const inp = node.inputs?.[link.target_slot];
    const linkType = String(link.type || inp?.type || "").toUpperCase();
    const inpType = String(inp?.type || "").toUpperCase();
    if (linkType.includes("IMAGE") || inpType.includes("IMAGE")) {
      if (typeof graph.removeLink === "function") graph.removeLink(linkId);
      else if (links instanceof Map) links.delete(linkId);
      else delete links[linkId];
    }
  }
}

/** Drop stale wires targeting hidden/removed builder inputs (e.g. old preview_image_data links). */
export function removeIncomingLinksToInputNames(node, inputNames) {
  const graph = node?.graph;
  if (!graph?.links || !node?.inputs) return;
  const blocked = new Set(inputNames);
  const links = graph.links;
  const entries = links instanceof Map ? [...links.entries()] : Object.entries(links);
  for (const [linkId, link] of entries) {
    if (!link || link.target_id !== node.id) continue;
    const inp = node.inputs[link.target_slot];
    if (!inp || blocked.has(inp.name)) {
      if (typeof graph.removeLink === "function") graph.removeLink(linkId);
      else if (links instanceof Map) links.delete(linkId);
      else delete links[linkId];
    }
  }
}

/** Internal prompt fields owned by the custom editor — not shown as native widgets. */
export const INTERNAL_PROMPT_INPUTS = new Set([
  "width", "height", "scale_mode", "background_opacity",
  "elements_data", "style_palette_data", "bg_guid",
]);

/** Remove internal inputs/widgets from the node UI; values are injected at queue time. */
export function stripInternalPromptFields(node) {
  if (!node) return;
  removeIncomingImageLinks(node);
  removeIncomingLinksToInputNames(node, [...INTERNAL_PROMPT_INPUTS, "image"]);

  for (let i = (node.inputs?.length || 0) - 1; i >= 0; i--) {
    const inp = node.inputs[i];
    if (!inp || !INTERNAL_PROMPT_INPUTS.has(inp.name)) continue;
    const w = inp.widget;
    if (w && node.widgets) {
      const wi = node.widgets.indexOf(w);
      if (wi >= 0) node.widgets.splice(wi, 1);
    }
    node.removeInput?.(i);
  }

  if (node.widgets) {
    node.widgets = node.widgets.filter((w) => !INTERNAL_PROMPT_INPUTS.has(w?.name));
  }
}

// ─── Source input watcher ───
// Watches a named IMAGE input for connection changes and source widget changes.
// Calls onChange(sources) when connections change or the source node's image/video widget changes.
// sources: array of { url, isVideo, videoEl } per connected IMAGE input matching inputName (or all if inputName is null).
// Returns a cleanup function.
export function watchImageInputs(node, inputName, onChange) {
  let watchedWidgets = [];

  function unwatchWidgets() {
    for (const entry of watchedWidgets) {
      if (entry.isExecutedHook) entry.widget.onExecuted = entry.origCb;
      else entry.widget.callback = entry.origCb;
    }
    watchedWidgets = [];
  }

  function resolve() {
    if (!node.inputs) return [];
    const slots = inputName
      ? node.inputs.map((inp, i) => inp.name === inputName ? i : -1).filter(i => i >= 0)
      : node.inputs.map((inp, i) => inp.type === "IMAGE" ? i : -1).filter(i => i >= 0);
    return slots.map(i => resolveSourcePreview(node, i)).filter(s => s !== null);
  }

  function watch() {
    unwatchWidgets();
    if (!node.inputs || !node.graph) return;
    const slots = inputName
      ? node.inputs.map((inp, i) => inp.name === inputName ? i : -1).filter(i => i >= 0)
      : node.inputs.map((inp, i) => inp.type === "IMAGE" ? i : -1).filter(i => i >= 0);
    for (const slotIdx of slots) {
      const input = node.inputs[slotIdx];
      if (!input || input.link == null) continue;
      const link = getGraphLink(node.graph, input.link);
      if (!link) continue;
      const srcNode = getGraphNode(node.graph, link.origin_id);
      if (!srcNode) continue;
      const w = srcNode.widgets?.find(w => w.name === "image" || w.name === "video");
      if (w) {
        const origCb = w.callback;
        w.callback = function (...args) {
          if (origCb) origCb.apply(this, args);
          setTimeout(() => onChange(resolve()), 100);
        };
        watchedWidgets.push({ widget: w, origCb });
      }
      const prevExecuted = srcNode.onExecuted;
      srcNode.onExecuted = function (_output) {
        const r = prevExecuted?.apply(this, arguments);
        setTimeout(() => onChange(resolve()), 60);
        return r;
      };
      watchedWidgets.push({ widget: srcNode, origCb: prevExecuted, isExecutedHook: true });
    }
  }

  chainCallback(node, "onConnectionsChange", function (type) {
    // Only react to input connection changes, not output
    if (type != null && type !== 1) return;
    setTimeout(() => {
      watch();
      onChange(resolve());
    }, 100);
  });

  chainCallback(node, "onRemoved", unwatchWidgets);

  return unwatchWidgets;
}

// ─── Video frame capture ───
// Draws the current frame of a video element to a fresh canvas at native resolution.
// If the video isn't decoded yet (readyState < 2), waits once for "loadeddata" before capturing.
// Calls callback(canvas) with the resulting canvas. Caller decides whether to use it directly
// (drawImage accepts canvas) or convert via toDataURL.
export function captureVideoFrame(videoEl, callback) {
  const capture = () => {
    if (!videoEl.videoWidth || !videoEl.videoHeight) return;
    const c = document.createElement("canvas");
    c.width = videoEl.videoWidth;
    c.height = videoEl.videoHeight;
    c.getContext("2d").drawImage(videoEl, 0, 0);
    callback(c);
  };
  if (videoEl.readyState >= 2) {
    capture();
  } else {
    const onReady = () => { videoEl.removeEventListener("loadeddata", onReady); capture(); };
    videoEl.addEventListener("loadeddata", onReady);
  }
}

// ─── Bounding box hit test ───
// Tests whether (mx, my) hits a corner handle or the interior of a rect defined by (x1, y1)–(x2, y2).
// Returns "resize-tl", "resize-tr", "resize-bl", "resize-br", "resize-t", "resize-b", "resize-l", "resize-r", "move", or null.
export function rectHitTest(mx, my, x1, y1, x2, y2, radius) {
  const hit = (cx, cy) => Math.abs(mx - cx) < radius && Math.abs(my - cy) < radius;
  // Corners first (higher priority)
  if (hit(x1, y1)) return "resize-tl";
  if (hit(x2, y1)) return "resize-tr";
  if (hit(x1, y2)) return "resize-bl";
  if (hit(x2, y2)) return "resize-br";
  // Edges
  if (mx >= x1 && mx <= x2 && Math.abs(my - y1) < radius) return "resize-t";
  if (mx >= x1 && mx <= x2 && Math.abs(my - y2) < radius) return "resize-b";
  if (my >= y1 && my <= y2 && Math.abs(mx - x1) < radius) return "resize-l";
  if (my >= y1 && my <= y2 && Math.abs(mx - x2) < radius) return "resize-r";
  // Interior
  if (mx >= x1 && mx <= x2 && my >= y1 && my <= y2) return "move";
  return null;
}

// Returns the appropriate CSS cursor for a bbox hit mode string.
export function cursorForBboxMode(mode) {
  if (mode === "move") return "move";
  if (mode === "resize-tl" || mode === "resize-br") return "nwse-resize";
  if (mode === "resize-tr" || mode === "resize-bl") return "nesw-resize";
  if (mode === "resize-t" || mode === "resize-b") return "ns-resize";
  if (mode === "resize-l" || mode === "resize-r") return "ew-resize";
  return null;
}

// ─── Wheel zoom passthrough for DOM widgets ───
// Re-dispatches wheel events to the LiteGraph canvas for zoom
export function addWheelPassthrough(element) {
  element.addEventListener("wheel", (e) => {
    const gc = document.getElementById("graph-canvas");
    if (gc) {
      gc.dispatchEvent(new WheelEvent(e.type, e));
      e.preventDefault();
    }
  }, { passive: false });
}

