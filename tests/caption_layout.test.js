import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  captionText,
  cleanPalette,
  elementToRegion,
  fallbackRegion,
  ideogramBboxToRect,
  offsetAddedRegions,
  pasteRegions,
  rectToIdeogramBbox,
  regionCoordsFinite,
  staggerLoadedRegion,
} from "../web/js/caption_layout.js";

describe("ideogram bbox import", () => {
  it("maps ymin, xmin, ymax, xmax onto x, y, w, h", () => {
    const box = elementToRegion({
      type: "text",
      text: "Hello",
      desc: "A greeting",
      bbox: [100, 200, 300, 400],
      color_palette: ["#FF0000"],
    }, 0);
    assert.equal(box.type, "text");
    assert.equal(box.text, "Hello");
    assert.equal(box.palette[0], "#FF0000");
    assert.equal(box.x, 0.2);
    assert.equal(box.y, 0.1);
    assert.equal(box.w, 0.2);
    assert.equal(box.h, 0.2);
    assert.equal(box.nobbox, undefined);
  });

  it("turns numeric caption text into strings and drops other types", () => {
    const box = elementToRegion({ type: "text", text: 12, desc: 5, bbox: [0, 0, 10, 10] }, 0);
    assert.equal(box.text, "12");
    assert.equal(box.desc, "5");
    assert.equal(captionText(true), "");
    assert.equal(captionText(Number.NaN), "");
    assert.equal(captionText(" keep "), " keep ");
  });

  it("swaps inverted axes so the region can be hit-tested", () => {
    const rect = ideogramBboxToRect([400, 300, 100, 200]);
    assert.deepEqual(rect, { x: 0.2, y: 0.1, w: 0.1, h: 0.3 });
  });

  it("clamps coordinates to the 0-1000 caption range", () => {
    const rect = ideogramBboxToRect([-100, -50, 1500, 2000]);
    assert.deepEqual(rect, { x: 0, y: 0, w: 1, h: 1 });
  });

  it("accepts numeric strings", () => {
    const rect = ideogramBboxToRect(["100", "200", "300", "400"]);
    assert.deepEqual(rect, { x: 0.2, y: 0.1, w: 0.2, h: 0.2 });
  });

  it("places non-numeric bboxes on the non-overlapping grid at their index", () => {
    const good = elementToRegion({ type: "obj", desc: "ok", bbox: [0, 0, 100, 100] }, 0);
    const bad = elementToRegion({ type: "obj", desc: "bad", bbox: ["nope", 0, 10, 10] }, 1);
    assert.equal(good.nobbox, undefined);
    assert.equal(bad.nobbox, true);
    assert.equal(bad.x, fallbackRegion(1).x);
    assert.equal(bad.y, fallbackRegion(1).y);
    assert.notEqual(bad.x, fallbackRegion(0).x);
  });

  it("does not overlap a full row of fallback regions", () => {
    const boxes = [0, 1, 2, 3, 4].map((i) => fallbackRegion(i));
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i];
        const b = boxes[j];
        const overlapX = a.x < b.x + b.w && a.x + a.w > b.x;
        const overlapY = a.y < b.y + b.h && a.y + a.h > b.y;
        assert.equal(overlapX && overlapY, false, `region ${i} overlaps ${j}`);
      }
    }
  });

  it("rejects NaN coordinates when restoring saved regions", () => {
    assert.equal(regionCoordsFinite({ x: 0.1, y: 0.2, w: 0.3, h: 0.4 }), true);
    assert.equal(regionCoordsFinite({ x: NaN, y: 0.2, w: 0.3, h: 0.4 }), false);
    assert.equal(regionCoordsFinite({ x: 0.1, y: 0.2, w: 0.3 }), false);
  });

  it("exports a usable bbox and drops coordinates that are not finite", () => {
    assert.deepEqual(rectToIdeogramBbox({ x: 0.1, y: 0.2, w: 0.3, h: 0.4 }), [200, 100, 600, 400]);
    assert.deepEqual(rectToIdeogramBbox({ x: "0.1", y: "0.2", w: "0.3", h: "0.4" }), [200, 100, 600, 400]);
    assert.deepEqual(rectToIdeogramBbox({ x: 0.5, y: 0.6, w: -0.2, h: -0.1 }), [500, 300, 600, 500]);
    assert.equal(rectToIdeogramBbox({ x: Number.NaN, y: 0.2, w: 0.3, h: 0.4 }), null);
    assert.equal(rectToIdeogramBbox({ x: "nope", y: 0, w: 0.2, h: 0.2 }), null);
    assert.equal(rectToIdeogramBbox({ x: true, y: 0, w: 0.2, h: 0.2 }), null);
    assert.deepEqual(rectToIdeogramBbox({}), [0, 0, 0, 0]);
    assert.deepEqual(rectToIdeogramBbox({ x: 1e308, y: 0, w: 1e308, h: 0.2 }), [0, 1000, 200, 1000]);
  });
});

describe("color palettes", () => {
  it("uppercases #RRGGBB, expands #RGB, and drops values Ideogram rejects", () => {
    assert.deepEqual(
      cleanPalette([null, "", "red", "#fff", "#aabbcc", 1, true, "#12"]),
      ["#FFFFFF", "#AABBCC"],
    );
  });

  it("stops at the caller limit", () => {
    const colors = Array.from({ length: 20 }, (_, i) => `#${i.toString(16).padStart(6, "0")}`);
    assert.equal(cleanPalette(colors, 5).length, 5);
    assert.equal(cleanPalette(colors, 16).length, 16);
    assert.deepEqual(cleanPalette(colors, 2), ["#000000", "#000001"]);
  });
});

function near(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} is not near ${expected}`);
}

describe("added scenes", () => {
  it("shifts every region by the same amount so the layout stays intact", () => {
    const boxes = [
      { x: 0.1, y: 0.2, w: 0.2, h: 0.2, type: "obj", desc: "a" },
      { x: 0.5, y: 0.6, w: 0.2, h: 0.1, type: "text", text: "T", desc: "b" },
    ];
    const placed = offsetAddedRegions(boxes, 0.05);
    near(placed[0].x, 0.15);
    near(placed[0].y, 0.25);
    near(placed[1].x, 0.55);
    near(placed[1].y, 0.65);
    near(placed[1].x - placed[0].x, boxes[1].x - boxes[0].x);
    near(placed[1].y - placed[0].y, boxes[1].y - boxes[0].y);
    near(placed[0].w, boxes[0].w);
    near(placed[1].h, boxes[1].h);
    assert.equal(placed[1].text, "T");
  });

  it("keeps a nudged region inside the canvas", () => {
    const placed = offsetAddedRegions([{ x: 0.9, y: 0.9, w: 0.2, h: 0.2 }], 0.05);
    near(placed[0].x, 0.95);
    near(placed[0].y, 0.95);
    assert.ok(placed[0].x + placed[0].w <= 1 + 1e-9);
    assert.ok(placed[0].y + placed[0].h <= 1 + 1e-9);
    near(placed[0].w, 0.05);
  });
});

describe("pasted regions", () => {
  it("nudges by the paste offset and stays inside the canvas", () => {
    const placed = pasteRegions([
      { x: 0.9, y: 0.9, w: 0.2, h: 0.2, desc: "edge", palette: ["#FFFFFF"] },
    ]);
    near(placed[0].x, 0.93);
    near(placed[0].y, 0.93);
    near(placed[0].w, 0.07);
    near(placed[0].h, 0.07);
    assert.ok(placed[0].x + placed[0].w <= 1 + 1e-9);
    assert.ok(placed[0].y + placed[0].h <= 1 + 1e-9);
    assert.equal(placed[0].desc, "edge");
  });

  it("does not keep the source store link or share its palette array", () => {
    const src = [{
      x: 0.1, y: 0.2, w: 0.2, h: 0.2,
      palette: ["#FFFFFF"],
      storeRef: { type: "character", name: "Ada" },
    }];
    const placed = pasteRegions(src);
    near(placed[0].x, 0.13);
    near(placed[0].y, 0.23);
    near(placed[0].w, 0.2);
    assert.equal(placed[0].storeRef, undefined);
    placed[0].palette.push("#000000");
    assert.deepEqual(src[0].palette, ["#FFFFFF"]);
    assert.deepEqual(src[0].storeRef, { type: "character", name: "Ada" });
  });
});

describe("loaded characters and objects", () => {
  it("keeps the original diagonal stagger while the region still fits", () => {
    for (let i = 0; i <= 16; i++) {
      const box = staggerLoadedRegion(i);
      near(box.x, 0.1 + i * 0.04);
      near(box.y, 0.1 + i * 0.04);
      near(box.w, 0.25);
      near(box.h, 0.2);
      assert.ok(box.x + box.w <= 1 + 1e-9, `index ${i} leaves the canvas`);
    }
  });

  it("tiles later regions inside the canvas instead of sliding off it", () => {
    const box = staggerLoadedRegion(17);
    near(box.x, 0);
    near(box.y, 0);
    near(box.w, 0.25);
    near(box.h, 0.2);
    const next = staggerLoadedRegion(18);
    near(next.x, 0.25);
    near(next.y, 0);
    for (let i = 0; i < 80; i++) {
      const placed = staggerLoadedRegion(i);
      assert.ok(placed.x >= -1e-9 && placed.y >= -1e-9, `index ${i} origin`);
      assert.ok(placed.x + placed.w <= 1 + 1e-9, `index ${i} x`);
      assert.ok(placed.y + placed.h <= 1 + 1e-9, `index ${i} y`);
    }
  });
});
