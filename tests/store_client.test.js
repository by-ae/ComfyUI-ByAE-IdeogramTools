import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

const appSingleton = {};
globalThis.window = {
  comfyAPI: {
    // The frontend exposes the app module here, and the module's `app` export
    // is the graph owner. The shared helpers read that export once.
    app: { app: appSingleton },
    api: { addEventListener() {} },
  },
};

const {
  loadStores, deleteStoreEntry, saveStoreEntry, normalizeStoreName, savedPresetCollision,
  BUILDER_CLASS, collectBuilderPromptTargets, applyBuilderPromptPatches, findBuildersOnGraph,
  installBuilderQueueHooks,
} = await import("../web/js/ideogram4_shared.js");

describe("loadStores", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns the three buckets from a successful response", async () => {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        characters: { Ada: { desc: "a" } },
        objects: {},
        scenes: { Scene: { boxes: [] } },
      }),
    });
    const stores = await loadStores();
    assert.deepEqual(stores.characters.Ada, { desc: "a" });
    assert.deepEqual(stores.objects, {});
    assert.deepEqual(stores.scenes.Scene, { boxes: [] });
  });

  it("returns empty buckets when the server has no presets", async () => {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({}),
    });
    const stores = await loadStores();
    assert.deepEqual(stores, { characters: {}, objects: {}, scenes: {} });
  });

  it("throws when the store request fails instead of looking empty", async () => {
    globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
    await assert.rejects(loadStores(), /HTTP 500/);
  });

  it("throws when the network request fails", async () => {
    globalThis.fetch = async () => {
      throw new Error("network down");
    };
    await assert.rejects(loadStores(), /network down/);
  });
});

describe("savedPresetCollision", () => {
  it("names a different preset that would be replaced", () => {
    assert.equal(savedPresetCollision(["Ada", "Bea"], "Bea"), "Bea");
    assert.equal(savedPresetCollision(["Ada"], "Cara"), null);
    assert.equal(savedPresetCollision(["Ada"], "  "), null);
    assert.equal(savedPresetCollision([], "Ada"), null);
  });

  it("does not treat an update of the linked preset as a replacement", () => {
    assert.equal(savedPresetCollision(["Ada"], "Ada", "Ada"), null);
    assert.equal(savedPresetCollision(["Ada", "Bea"], "Bea", "Ada"), "Bea");
  });

  it("matches a composed name to the stored spelling", () => {
    const nfd = "Émilie".normalize("NFD");
    assert.equal(savedPresetCollision(["Émilie"], nfd), "Émilie");
    assert.equal(savedPresetCollision(["Émilie"], ` ${nfd} `, "Émilie"), null);
  });
});

describe("saveStoreEntry", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("sends the composed name and returns the stored name", async () => {
    const nfd = "Émilie".normalize("NFD");
    let called;
    globalThis.fetch = async (url, opts) => {
      called = { url, method: opts.method, body: opts.body };
      return { ok: true, json: async () => ({ ok: true, name: "Émilie" }) };
    };
    const saved = await saveStoreEntry("characters", nfd, { desc: "a" });
    assert.equal(called.method, "PUT");
    assert.equal(called.url, "/byae/ideogram/stores/characters/%C3%89milie");
    assert.equal(called.body, JSON.stringify({ desc: "a" }));
    assert.equal(saved, "Émilie");
  });
});

describe("deleteStoreEntry", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("sends DELETE to the encoded preset name", async () => {
    let called;
    globalThis.fetch = async (url, opts) => {
      called = { url, method: opts.method };
      return { ok: true, json: async () => ({ ok: true }) };
    };
    await deleteStoreEntry("characters", "Émilie");
    assert.equal(called.method, "DELETE");
    assert.equal(called.url, "/byae/ideogram/stores/characters/%C3%89milie");
  });

  it("sends a composed form of a unicode name", async () => {
    const nfd = "Émilie".normalize("NFD");
    const nfc = "Émilie".normalize("NFC");
    assert.notEqual(nfd, nfc);
    assert.equal(normalizeStoreName(`  ${nfd}  `), nfc);
    let called;
    globalThis.fetch = async (url, opts) => {
      called = { url, method: opts.method };
      return { ok: true, json: async () => ({ ok: true }) };
    };
    await deleteStoreEntry("characters", nfd);
    assert.equal(called.method, "DELETE");
    assert.equal(called.url, "/byae/ideogram/stores/characters/%C3%89milie");
  });

  it("encodes spaces in scene names", async () => {
    let called;
    globalThis.fetch = async (url, opts) => {
      called = { url, method: opts.method };
      return { ok: true, json: async () => ({ ok: true }) };
    };
    await deleteStoreEntry("scenes", "My Scene");
    assert.equal(called.method, "DELETE");
    assert.equal(called.url, "/byae/ideogram/stores/scenes/My%20Scene");
  });

  it("uses the server error message", async () => {
    globalThis.fetch = async () => ({
      ok: false,
      status: 404,
      json: async () => ({ error: "Entry not found" }),
    });
    await assert.rejects(deleteStoreEntry("scenes", "Gone"), /Entry not found/);
  });

  it("falls back to the status when the body is not JSON", async () => {
    globalThis.fetch = async () => ({
      ok: false,
      status: 500,
      json: async () => {
        throw new Error("nope");
      },
    });
    await assert.rejects(deleteStoreEntry("objects", "Box"), /HTTP 500/);
  });
});

function builderNode(id, patch) {
  return {
    id,
    comfyClass: BUILDER_CLASS,
    byaeGetPromptInputs() {
      return patch || { width: 1000, bg_guid: `g${id}` };
    },
  };
}

describe("builder prompt targets", () => {
  it("patches a root builder and leaves an unrelated node with the same id alone", () => {
    const root = builderNode(3);
    const nested = builderNode(55, { width: 800, elements_data: "[]" });
    const subgraph = {
      id: 99,
      comfyClass: "Subgraph",
      isSubgraphNode() { return true; },
      subgraph: { _nodes: [nested] },
    };
    const unrelated = { id: 55, comfyClass: "Note" };
    const graph = { _nodes: [root, unrelated, subgraph] };
    const targets = collectBuilderPromptTargets(graph);
    assert.deepEqual(targets.map((entry) => entry.executionId), ["3", "99:55"]);
    assert.deepEqual(findBuildersOnGraph(graph).map((node) => node.id), [3, 55]);

    const output = {
      "3": { inputs: { background: "room" } },
      "55": { inputs: { background: "keep" } },
      "99:55": { inputs: { background: "room" } },
    };
    applyBuilderPromptPatches(output, targets);
    assert.equal(output["3"].inputs.width, 1000);
    assert.equal(output["3"].inputs.background, "room");
    assert.equal(output["3"].inputs.bg_guid, "g3");
    assert.deepEqual(output["55"].inputs, { background: "keep" });
    assert.equal(output["99:55"].inputs.width, 800);
    assert.equal(output["99:55"].inputs.elements_data, "[]");
    assert.equal(output["99:55"].inputs.background, "room");
  });

  it("keeps the instance path through nested subgraphs and a shared definition", () => {
    const deep = builderNode(55);
    const mid = {
      id: 7,
      isSubgraphNode() { return true; },
      subgraph: { nodes: [deep] },
    };
    const outer = {
      id: 99,
      isSubgraphNode() { return true; },
      subgraph: { _nodes: [mid] },
    };
    const shared = { _nodes: [builderNode(4)] };
    const left = { id: 10, isSubgraphNode() { return true; }, subgraph: shared };
    const right = { id: 11, isSubgraphNode() { return true; }, subgraph: shared };
    const targets = collectBuilderPromptTargets({ _nodes: [outer, left, right] });
    assert.deepEqual(
      targets.map((entry) => entry.executionId),
      ["99:7:55", "10:4", "11:4"],
    );
  });

  it("does not walk a node that is not a subgraph, and it stops on a cycle", () => {
    const hidden = builderNode(4);
    const plain = {
      id: 8,
      isSubgraphNode() { return false; },
      subgraph: { _nodes: [hidden] },
    };
    assert.deepEqual(collectBuilderPromptTargets({ _nodes: [plain] }), []);

    const graph = { _nodes: [] };
    const loop = {
      id: 1,
      comfyClass: BUILDER_CLASS,
      isSubgraphNode() { return true; },
      subgraph: graph,
    };
    graph._nodes.push(loop);
    const targets = collectBuilderPromptTargets(graph);
    assert.equal(targets.length, 1);
    assert.equal(targets[0].executionId, "1");
  });

  it("uses _nodes when both lists exist and does not invent a missing prompt entry", () => {
    const shown = builderNode(3);
    const hidden = builderNode(2);
    const targets = collectBuilderPromptTargets({ _nodes: [shown], nodes: [hidden] });
    assert.deepEqual(targets.map((entry) => entry.executionId), ["3"]);
    const output = {};
    applyBuilderPromptPatches(output, targets);
    assert.deepEqual(output, {});
    assert.equal(applyBuilderPromptPatches(null, targets), null);
  });

  it("queues a nested builder on its execution id", async () => {
    const nested = builderNode(55, { width: 640, height: 480 });
    nested.byaePersistState = () => { nested.persisted = true; };
    const root = builderNode(3);
    const subgraph = {
      id: 99,
      isSubgraphNode() { return true; },
      subgraph: { _nodes: [nested] },
    };
    const output = {
      "3": { inputs: {} },
      "55": { inputs: { width: 5 } },
      "99:55": {},
    };
    const app = appSingleton;
    app.graph = { _nodes: [root, subgraph] };
    app.graphToPrompt = async () => ({ output, workflow: {} });
    installBuilderQueueHooks();
    const res = await app.graphToPrompt();
    assert.equal(nested.persisted, true);
    assert.equal(res.output["3"].inputs.width, 1000);
    assert.equal(res.output["55"].inputs.width, 5);
    assert.equal(res.output["99:55"].inputs.width, 640);
    assert.equal(res.output["99:55"].inputs.height, 480);
  });
});
