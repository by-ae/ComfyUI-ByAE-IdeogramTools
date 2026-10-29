import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

globalThis.window = {
  comfyAPI: {
    app: {},
    api: { addEventListener() {} },
  },
};

const { loadStores, deleteStoreEntry } = await import("../web/js/ideogram4_shared.js");

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
