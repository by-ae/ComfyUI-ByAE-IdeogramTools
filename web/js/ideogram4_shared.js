/** Shared helpers between the enhanced builder nodes. */

import { nodeClassName } from "./utility.js";

const { app } = window.comfyAPI.app;

export const BUILDER_CLASS = "Ideogram4PromptBuilderKJEnhancedByAE";
export const PREVIEW_UPDATE_CLASS = "Ideogram4PromptBuilderKJPreviewUpdateByAE";
const STORE_API = "/byae/ideogram/stores";

const EMPTY_STORES = () => ({ characters: {}, objects: {}, scenes: {} });

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
    console.warn("ByAE Ideogram: failed to load stores", e);
    return EMPTY_STORES();
  }
}

export async function saveStoreEntry(bucket, name, data) {
  const resp = await fetch(`${STORE_API}/${bucket}/${encodeURIComponent(name)}`, {
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
}

export async function deleteStoreEntry(bucket, name) {
  const resp = await fetch(`${STORE_API}/${bucket}/${encodeURIComponent(name)}`, {
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

export function findBuildersOnGraph(graph) {
  if (!graph?._nodes) return [];
  return graph._nodes.filter((n) => nodeClassName(n) === BUILDER_CLASS);
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
    const builders = findBuildersOnGraph(app.graph);
    for (const n of builders) n.byaePersistState?.();
    const res = await orig(...args);
    if (!res?.output) return res;
    for (const n of builders) {
      const patch = n.byaeGetPromptInputs?.();
      if (!patch) continue;
      const key = String(n.id);
      if (!res.output[key]) continue;
      res.output[key].inputs = { ...(res.output[key].inputs || {}), ...patch };
    }
    return res;
  };
}
