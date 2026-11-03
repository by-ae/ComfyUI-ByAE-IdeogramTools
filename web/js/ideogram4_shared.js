/** Shared helpers between the enhanced builder nodes. */

import { nodeClassName } from "./utility.js";

const { app } = window.comfyAPI.app;

export const BUILDER_CLASS = "Ideogram4PromptBuilderKJEnhancedByAE";
export const PREVIEW_UPDATE_CLASS = "Ideogram4PromptBuilderKJPreviewUpdateByAE";
const STORE_API = "/byae/ideogram/stores";

/** Composed form, so a letter plus a combining accent matches the stored preset. */
export function normalizeStoreName(name) {
  return String(name ?? "").trim().normalize("NFC");
}

/**
 * Stored name this save would replace, or null.
 * Saving the preset already linked to the region is an update, not a replacement.
 */
export function savedPresetCollision(existingNames, name, linkedName) {
  const target = normalizeStoreName(name);
  if (!target) return null;
  const match = (existingNames || []).find((entry) => normalizeStoreName(entry) === target);
  if (!match) return null;
  if (linkedName && normalizeStoreName(linkedName) === target) return null;
  return match;
}

export async function loadStores() {
  try {
    const resp = await fetch(STORE_API, {
      signal: AbortSignal.timeout ? AbortSignal.timeout(5000) : undefined
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    return {
      characters: data.characters || {},
      objects: data.objects || {},
      scenes: data.scenes || {},
    };
  } catch (e) {
    // Callers distinguish a failed request from a library that is actually empty.
    console.warn("ByAE Ideogram: failed to load stores", e);
    throw e;
  }
}

export async function saveStoreEntry(bucket, name, data) {
  const safeName = normalizeStoreName(name);
  const resp = await fetch(`${STORE_API}/${bucket}/${encodeURIComponent(safeName)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
    signal: AbortSignal.timeout ? AbortSignal.timeout(5000) : undefined
  });
  if (!resp.ok) {
    let msg = `HTTP ${resp.status}`;
    try {
      const err = await resp.json();
      if (err?.error) msg = err.error;
    } catch (e) { /* ignore */ }
    throw new Error(msg);
  }
  let saved = safeName;
  try {
    const body = await resp.json();
    if (typeof body?.name === "string" && body.name) saved = body.name;
  } catch (e) { /* the write succeeded; keep the name we sent */ }
  return saved;
}

export async function deleteStoreEntry(bucket, name) {
  const safeName = normalizeStoreName(name);
  const resp = await fetch(`${STORE_API}/${bucket}/${encodeURIComponent(safeName)}`, {
    method: "DELETE",
    signal: AbortSignal.timeout ? AbortSignal.timeout(5000) : undefined
  });
  if (!resp.ok) {
    let msg = `HTTP ${resp.status}`;
    try {
      const err = await resp.json();
      if (err?.error) msg = err.error;
    } catch (e) { /* ignore */ }
    throw new Error(msg);
  }
}

function graphNodes(graph) {
  if (!graph || typeof graph !== "object") return [];
  if (Array.isArray(graph._nodes)) return graph._nodes;
  if (Array.isArray(graph.nodes)) return graph.nodes;
  return [];
}

function nestedGraph(node) {
  if (typeof node?.isSubgraphNode !== "function" || !node.isSubgraphNode()) return null;
  const inner = node.subgraph;
  if (!inner || typeof inner !== "object") return null;
  return inner;
}

/**
 * Builders to patch when the workflow is queued.
 * ComfyUI's execution id is the subgraph instance ids and the node id joined
 * with ":". A root node is just its id. The same subgraph definition can sit
 * in more than one instance, so each instance keeps its own path.
 */
export function collectBuilderPromptTargets(graph) {
  const targets = [];
  const walk = (current, path, stack) => {
    if (!current || stack.has(current) || path.length > 32) return;
    stack.add(current);
    for (const node of graphNodes(current)) {
      if (node && nodeClassName(node) === BUILDER_CLASS && node.id != null) {
        targets.push({ node, executionId: [...path, node.id].join(":") });
      }
      const inner = nestedGraph(node);
      if (inner && node.id != null) walk(inner, [...path, node.id], stack);
    }
    stack.delete(current);
  };
  if (graph) walk(graph, [], new Set());
  return targets;
}

export function findBuildersOnGraph(graph) {
  return collectBuilderPromptTargets(graph).map((entry) => entry.node);
}

export function applyBuilderPromptPatches(output, targets) {
  if (!output || typeof output !== "object") return output;
  for (const { node, executionId } of targets || []) {
    const patch = node?.byaeGetPromptInputs?.();
    if (!patch) continue;
    const slot = output[executionId];
    if (!slot) continue;
    slot.inputs = { ...(slot.inputs || {}), ...patch };
  }
  return output;
}

let _bgPushListenerInstalled = false;

/** Listen for server push when Preview BG Update writes a temp file. */
export function installBgUpdateListener() {
  if (_bgPushListenerInstalled) return;
  _bgPushListenerInstalled = true;
  const { api } = window.comfyAPI.api;
  api.addEventListener("byae_ideogram_bg_updated", ({ detail }) => {
    if (!detail?.guid) return;
    const graph = app.graph;
    if (!graph?._nodes) return;
    for (const node of findBuildersOnGraph(graph)) {
      const guid = node.properties?.byae_bg_guid;
      if (guid && guid === detail.guid) {
        node.byaeApplyBgUpdate?.(detail);
      }
    }
  });
}

let _queueHooksInstalled = false;

/** Inject internal editor fields into the workflow prompt (no native backing widgets). */
export function installBuilderQueueHooks() {
  if (_queueHooksInstalled) return;
  _queueHooksInstalled = true;
  const orig = app.graphToPrompt?.bind(app);
  if (!orig) return;
  app.graphToPrompt = async function (...args) {
    const targets = collectBuilderPromptTargets(app.graph);
    for (const { node } of targets) node.byaePersistState?.();
    const res = await orig(...args);
    if (!res?.output) return res;
    applyBuilderPromptPatches(res.output, targets);
    return res;
  };
}
