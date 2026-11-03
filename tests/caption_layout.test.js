import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  backgroundPlateShown,
  backgroundUpdateFromStat,
  captionText,
  cleanPalette,
  elementToRegion,
  dimsFromAspect,
  fallbackRegion,
  ideogramBboxToRect,
  ideogramResolutionWarning,
  indexesAfterClearingSelection,
  selectionAfterRemovingBox,
  snapLayoutDim,
  sceneFromStore,
  offsetAddedRegions,
  nudgeForAddedRegions,
  nextPasteNudge,
  parseCaptionText,
  pasteRegions,
  rectToIdeogramBbox,
  regionCoordsFinite,
  regionLabel,
  remapImportedRegions,
  topRegionIndex,
  staggerLoadedRegion,
  swatchHex,
  transformBoxesContentUniform,
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
    assert.equal(regionLabel({ type: "text", text: 12, desc: 5 }), '"12" — 5');
    assert.equal(regionLabel({ type: "obj", desc: true }), "");
    assert.equal(regionLabel({ type: "obj", desc: { a: 1 } }), "");
    assert.equal(typeof regionLabel({ type: "text", text: 0, desc: false }), "string");
    assert.equal(regionLabel(null), "");
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

  it("keeps the original grid until a row starts past the canvas", () => {
    // Six rows begin on the canvas. The seventh (index 24) used to start
    // at y > 1, so those regions could not be selected or moved.
    for (let i = 0; i < 24; i++) {
      const row = Math.floor(i / 4);
      const col = i % 4;
      const box = fallbackRegion(i);
      near(box.x, 0.02 + col * 0.25);
      near(box.y, 0.02 + row * 0.17);
      near(box.w, 0.22);
      near(box.h, 0.14);
      assert.equal(box.nobbox, true);
    }
    const buried = fallbackRegion(24);
    assert.ok(buried.y < 1, "later fallback starts off the canvas");
    assert.ok(buried.x >= 0 && buried.y >= 0);
    assert.ok(buried.x + buried.w <= 1 + 1e-9);
    assert.ok(buried.y + buried.h <= 1 + 1e-9);
    assert.equal(buried.nobbox, true);
    assert.ok(Math.abs(buried.x - fallbackRegion(0).x) > 1e-6 || Math.abs(buried.y - fallbackRegion(0).y) > 1e-6);
    for (let i = 24; i < 48; i++) {
      const box = fallbackRegion(i);
      assert.ok(box.x >= -1e-9 && box.y >= -1e-9, `index ${i} origin`);
      assert.ok(box.x + box.w <= 1 + 1e-9, `index ${i} x`);
      assert.ok(box.y + box.h <= 1 + 1e-9, `index ${i} y`);
      assert.equal(box.nobbox, true);
    }
  });

  it("rejects NaN coordinates when restoring saved regions", () => {
    assert.equal(regionCoordsFinite({ x: 0.1, y: 0.2, w: 0.3, h: 0.4 }), true);
    assert.equal(regionCoordsFinite({ x: NaN, y: 0.2, w: 0.3, h: 0.4 }), false);
    assert.equal(regionCoordsFinite({ x: 0.1, y: 0.2, w: 0.3 }), false);
  });

  it("exports a usable bbox and drops coordinates that are not finite", () => {
    assert.deepEqual(rectToIdeogramBbox({ x: 0.1, y: 0.2, w: 0.3, h: 0.4 }), [200, 100, 600, 400]);
    // Halves go toward +inf, the same rule the prompt node uses.
    assert.deepEqual(rectToIdeogramBbox({ x: 0.0025, y: 0.0005, w: 0.001, h: 0.001 }), [1, 3, 2, 4]);
    assert.deepEqual(rectToIdeogramBbox({ x: "0.1", y: "0.2", w: "0.3", h: "0.4" }), [200, 100, 600, 400]);
    assert.deepEqual(rectToIdeogramBbox({ x: 0.5, y: 0.6, w: -0.2, h: -0.1 }), [500, 300, 600, 500]);
    assert.equal(rectToIdeogramBbox({ x: Number.NaN, y: 0.2, w: 0.3, h: 0.4 }), null);
    assert.equal(rectToIdeogramBbox({ x: "nope", y: 0, w: 0.2, h: 0.2 }), null);
    assert.equal(rectToIdeogramBbox({ x: true, y: 0, w: 0.2, h: 0.2 }), null);
    assert.deepEqual(rectToIdeogramBbox({}), [0, 0, 0, 0]);
    assert.deepEqual(rectToIdeogramBbox({ x: 1e308, y: 0, w: 1e308, h: 0.2 }), [0, 1000, 200, 1000]);
  });
});

describe("canvas size fields", () => {
  it("snaps a typed size to a multiple of 8 inside 64-16384", () => {
    assert.equal(snapLayoutDim(1024), 1024);
    assert.equal(snapLayoutDim(1001), 1000);
    assert.equal(snapLayoutDim(1004), 1008);
    assert.equal(snapLayoutDim(67), 64);
    assert.equal(snapLayoutDim(63), 64);
    assert.equal(snapLayoutDim(16384), 16384);
    assert.equal(snapLayoutDim(16385), 16384);
    assert.equal(snapLayoutDim(16380), 16384);
    assert.equal(snapLayoutDim(1920), 1920);
    assert.equal(snapLayoutDim("1080"), 1080);
  });

  it("uses the default when the field is empty or not a positive number", () => {
    assert.equal(snapLayoutDim(""), 1024);
    assert.equal(snapLayoutDim("  "), 1024);
    assert.equal(snapLayoutDim(0), 1024);
    assert.equal(snapLayoutDim(-20), 1024);
    assert.equal(snapLayoutDim(Number.NaN), 1024);
    assert.equal(snapLayoutDim(null), 1024);
    assert.equal(snapLayoutDim(undefined, 512), 512);
  });
});

describe("open model canvas size", () => {
  const note = "Open Ideogram 4 model: multiples of 16, each side 256-2048, aspect at most 6:1";

  it("accepts sizes the inference reference allows", () => {
    assert.equal(ideogramResolutionWarning(1024, 1024), "");
    assert.equal(ideogramResolutionWarning(256, 256), "");
    assert.equal(ideogramResolutionWarning(2048, 2048), "");
    assert.equal(ideogramResolutionWarning(1920, 1088), "");
    assert.equal(ideogramResolutionWarning(1536, 256), "");
    assert.equal(ideogramResolutionWarning(256, 1536), "");
  });

  it("notes a size the open model will not run", () => {
    assert.equal(ideogramResolutionWarning(1920, 1080), note);
    assert.equal(ideogramResolutionWarning(64, 64), note);
    assert.equal(ideogramResolutionWarning(2880, 1440), note);
    assert.equal(ideogramResolutionWarning(1552, 256), note);
  });
});

describe("deleting a selection", () => {
  it("removes only the selected regions and leaves nothing active", () => {
    const ending = indexesAfterClearingSelection(3, [0, 2]);
    assert.deepEqual(ending, { count: 1, selected: [], active: -1 });
  });

  it("counts each selected index once and ignores indexes outside the list", () => {
    const ending = indexesAfterClearingSelection(2, [0, 0, 5, -1]);
    assert.deepEqual(ending, { count: 1, selected: [], active: -1 });
  });

  it("drops every region when the whole canvas is selected", () => {
    const ending = indexesAfterClearingSelection(4, [0, 1, 2, 3]);
    assert.deepEqual(ending, { count: 0, selected: [], active: -1 });
  });
});

describe("removing one region", () => {
  it("does not focus a neighbor after the selected region is deleted", () => {
    assert.deepEqual(selectionAfterRemovingBox(3, [1], 1, 1), {
      count: 2, selected: [], active: -1,
    });
  });

  it("keeps the other selected region and shifts later indexes", () => {
    assert.deepEqual(selectionAfterRemovingBox(4, [0, 2], 2, 0), {
      count: 3, selected: [1], active: 1,
    });
  });

  it("moves the active region with an earlier deletion and keeps selection order", () => {
    assert.deepEqual(selectionAfterRemovingBox(4, [3, 1], 3, 0), {
      count: 3, selected: [2, 0], active: 2,
    });
  });

  it("points at the remaining selection when the active region goes away", () => {
    assert.deepEqual(selectionAfterRemovingBox(3, [0, 2], 2, 2), {
      count: 2, selected: [0], active: 0,
    });
  });

  it("clears the canvas when the last region is removed", () => {
    assert.deepEqual(selectionAfterRemovingBox(1, [0], 0, 0), {
      count: 0, selected: [], active: -1,
    });
  });

  it("ignores an index that is not on the canvas", () => {
    assert.deepEqual(selectionAfterRemovingBox(2, [0], 0, 5), {
      count: 2, selected: [0], active: 0,
    });
  });
});

describe("overlapping regions", () => {
  const boxes = [
    { x: 0, y: 0, w: 0.8, h: 0.8, desc: "under" },
    { x: 0.2, y: 0.2, w: 0.2, h: 0.2, desc: "over" },
    { x: Number.NaN, y: 0.2, w: 0.2, h: 0.2, desc: "bad" },
  ];

  it("picks the later region, which is the one drawn on top", () => {
    assert.equal(topRegionIndex(boxes, 0.3, 0.3), 1);
    assert.equal(topRegionIndex(boxes, 0.05, 0.05), 0);
    assert.equal(topRegionIndex(boxes, 0.95, 0.95), -1);
  });

  it("still hits a handle that sits just outside the region", () => {
    assert.equal(topRegionIndex(boxes, 0.8, 0.4, 0.02, 0.02), 0);
    assert.equal(topRegionIndex([{ x: 0.5, y: 0.5, w: 0.1, h: 0.1 }], 0.62, 0.55, 0.03, 0.03), 0);
  });
});

describe("background image plate", () => {
  it("is black only while a reference image is actually drawn", () => {
    assert.equal(backgroundPlateShown("/view?filename=bg.png", 0.5), true);
    assert.equal(backgroundPlateShown("/view?filename=bg.png", 1), true);
    assert.equal(backgroundPlateShown("/view?filename=bg.png", 0), false);
    assert.equal(backgroundPlateShown("", 0.5), false);
    assert.equal(backgroundPlateShown(null, 0.5), false);
  });
});

describe("background file check", () => {
  const url = "/view?filename=byae_ideogram_bg_abc.png&type=temp&subfolder=";

  it("applies a newer file and cache-busts the view url", () => {
    const update = backgroundUpdateFromStat(10, { exists: true, mtime: 22.5, url });
    assert.deepEqual(update, { mtime: 22.5, displayUrl: `${url}&t=22.5` });
  });

  it("accepts a push that does not say exists", () => {
    const update = backgroundUpdateFromStat(0, { mtime: 4, url });
    assert.equal(update.displayUrl, `${url}&t=4`);
  });

  it("ignores a missing file, an older mtime, and a stat with no url", () => {
    assert.equal(backgroundUpdateFromStat(0, { exists: false, mtime: 9, url }), null);
    assert.equal(backgroundUpdateFromStat(9, { exists: true, mtime: 9, url }), null);
    assert.equal(backgroundUpdateFromStat(9, { exists: true, mtime: 8, url }), null);
    assert.equal(backgroundUpdateFromStat(0, { exists: true, mtime: 9 }), null);
    assert.equal(backgroundUpdateFromStat(0, null), null);
    assert.equal(backgroundUpdateFromStat(0, { exists: true, mtime: Number.NaN, url }), null);
    assert.equal(backgroundUpdateFromStat(Number.NaN, { mtime: 0, url }), null);
  });
});

describe("color palettes", () => {
  it("uppercases #RRGGBB, expands #RGB, and drops values Ideogram rejects", () => {
    assert.deepEqual(
      cleanPalette([null, "", "red", "#fff", "#aabbcc", 1, true, "#12"]),
      ["#FFFFFF", "#AABBCC"],
    );
  });

  it("turns a pasted element palette into colors the picker can edit", () => {
    const box = elementToRegion({
      type: "obj",
      desc: "shirt",
      bbox: [0, 0, 100, 100],
      color_palette: ["#fff", "red", "#aabbcc", "#123456", "#ABCDEF", "#010203", "extra"],
    }, 0);
    assert.deepEqual(box.palette, ["#FFFFFF", "#AABBCC", "#123456", "#ABCDEF", "#010203"]);
    assert.equal(swatchHex("#fff"), "#ffffff");
    assert.equal(swatchHex("#AABBCC"), "#aabbcc");
    assert.equal(swatchHex("red"), null);
    assert.equal(swatchHex("#GG0000"), null);
  });

  it("stops at the caller limit", () => {
    const colors = Array.from({ length: 20 }, (_, i) => `#${i.toString(16).padStart(6, "0")}`);
    assert.equal(cleanPalette(colors, 5).length, 5);
    assert.equal(cleanPalette(colors, 16).length, 16);
    assert.deepEqual(cleanPalette(colors, 2), ["#000000", "#000001"]);
  });

  it("reads a palette object and ignores values that are not a color list", () => {
    // The prompt node accepts a dict of colors. A number used to throw here
    // while the scene was already cleared.
    assert.deepEqual(cleanPalette({ c2: "#00ff00", c1: "#fff" }), ["#00FF00", "#FFFFFF"]);
    assert.deepEqual(cleanPalette(5), []);
    assert.deepEqual(cleanPalette("#fff"), []);
    assert.deepEqual(cleanPalette(true), []);
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

  it("keeps the first offset when that copy is not already on the canvas", () => {
    const saved = [{ x: 0.1, y: 0.2, w: 0.2, h: 0.2, desc: "a" }];
    assert.equal(nudgeForAddedRegions([], saved), 0.05);
    assert.equal(nudgeForAddedRegions(saved, saved), 0.05);
  });

  it("steps the offset when another add would cover the previous copy", () => {
    const saved = [
      { x: 0.1, y: 0.2, w: 0.04, h: 0.04, desc: "a" },
      { x: 0.5, y: 0.5, w: 0.04, h: 0.04, desc: "b" },
    ];
    const first = offsetAddedRegions(saved, 0.05);
    const nudge = nudgeForAddedRegions(first, saved);
    assert.equal(nudge, 0.1);
    const second = offsetAddedRegions(saved, nudge);
    near(second[0].x - first[0].x, 0.05);
    near(second[1].y - first[1].y, 0.05);
    const overlapX = first[0].x < second[0].x + second[0].w && first[0].x + first[0].w > second[0].x;
    const overlapY = first[0].y < second[0].y + second[0].h && first[0].y + first[0].h > second[0].y;
    assert.equal(overlapX && overlapY, false);
  });

  it("does not step when only one region of the scene already matches", () => {
    const saved = [
      { x: 0.1, y: 0.1, w: 0.1, h: 0.1 },
      { x: 0.5, y: 0.5, w: 0.1, h: 0.1 },
    ];
    const existing = offsetAddedRegions([saved[0]], 0.05);
    assert.equal(nudgeForAddedRegions(existing, saved), 0.05);
  });

  it("steps the other way when a further copy would shrink to nothing", () => {
    const saved = [{ x: 0.8, y: 0.8, w: 0.2, h: 0.2, desc: "corner" }];
    const existing = [];
    const placed = [];
    for (let n = 0; n < 6; n++) {
      const nudge = nudgeForAddedRegions(existing, saved);
      const copy = offsetAddedRegions(saved, nudge);
      assert.ok(copy[0].w > 0, `copy ${n} width collapsed at nudge ${nudge}`);
      assert.ok(copy[0].h > 0, `copy ${n} height collapsed at nudge ${nudge}`);
      assert.ok(copy[0].x + copy[0].w <= 1 + 1e-9);
      assert.ok(copy[0].y + copy[0].h <= 1 + 1e-9);
      existing.push(...copy);
      placed.push(copy[0]);
    }
    near(placed[0].x, 0.85);
    near(placed[0].w, 0.15);
    const reversed = placed.find((b) => b.w > 0.15);
    assert.ok(reversed, "a later copy should keep the saved size by stepping back");
    near(reversed.w, 0.2);
    near(reversed.h, 0.2);
  });
});

describe("saved scenes", () => {
  it("keeps a normal scene and does not share its palette array", () => {
    const src = {
      boxes: [{
        x: 0.1, y: 0.2, w: 0.3, h: 0.4,
        type: "text", text: "Hi", desc: "d",
        palette: ["#fff"],
        nobbox: true,
        storeRef: { type: "character", name: "Ada" },
      }],
      stylePalette: ["#abc"],
      widgets: { background: "room", style: "photo", photo: "35mm" },
    };
    const scene = sceneFromStore(src);
    near(scene.boxes[0].x, 0.1);
    near(scene.boxes[0].y, 0.2);
    near(scene.boxes[0].w, 0.3);
    near(scene.boxes[0].h, 0.4);
    assert.equal(scene.boxes[0].type, "text");
    assert.equal(scene.boxes[0].text, "Hi");
    assert.equal(scene.boxes[0].nobbox, true);
    assert.deepEqual(scene.boxes[0].palette, ["#FFFFFF"]);
    assert.deepEqual(scene.boxes[0].storeRef, { type: "character", name: "Ada" });
    assert.deepEqual(scene.stylePalette, ["#AABBCC"]);
    assert.equal(scene.widgets.background, "room");
    scene.boxes[0].palette.push("#000000");
    assert.deepEqual(src.boxes[0].palette, ["#fff"]);
  });

  it("skips unusable regions and still reads the rest", () => {
    const scene = sceneFromStore({
      boxes: [null, { x: "0.2", y: "0.3", w: "0.4", h: "0.1", desc: "ok", palette: 5 }, "x", {}],
      stylePalette: { a: "#abc" },
      widgets: { background: "room" },
    });
    assert.equal(scene.boxes.length, 1);
    assert.equal(scene.boxes[0].desc, "ok");
    near(scene.boxes[0].x, 0.2);
    near(scene.boxes[0].w, 0.4);
    assert.deepEqual(scene.boxes[0].palette, []);
    assert.deepEqual(scene.stylePalette, ["#AABBCC"]);
  });

  it("turns a negative width into a region that stays on the canvas", () => {
    const scene = sceneFromStore({
      boxes: [{ x: 0.5, y: 0.4, w: -0.2, h: 0.2, desc: "flip" }],
    });
    near(scene.boxes[0].x, 0.3);
    near(scene.boxes[0].y, 0.4);
    near(scene.boxes[0].w, 0.2);
    near(scene.boxes[0].h, 0.2);
  });

  it("rejects a value that is not a scene so replace cannot clear the canvas", () => {
    assert.equal(sceneFromStore(null), null);
    assert.equal(sceneFromStore([]), null);
    assert.equal(sceneFromStore({ desc: "character", palette: ["#FFFFFF"] }), null);
    assert.equal(sceneFromStore({ boxes: "nope" }), null);
    assert.equal(sceneFromStore({ boxes: null }), null);
    assert.equal(sceneFromStore({ boxes: [null, "x", {}] }), null);
    const empty = sceneFromStore({ boxes: [], widgets: {}, stylePalette: [] });
    assert.deepEqual(empty.boxes, []);
    assert.deepEqual(empty.stylePalette, []);
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

  it("steps the nudge so a second paste does not cover the first", () => {
    const box = { x: 0.1, y: 0.2, w: 0.02, h: 0.02, desc: "copy" };
    assert.equal(nextPasteNudge(0), 0.03);
    assert.equal(nextPasteNudge(1), 0.06);
    assert.equal(nextPasteNudge(2), 0.09);
    const first = pasteRegions([box], nextPasteNudge(0));
    const second = pasteRegions([box], nextPasteNudge(1));
    near(first[0].x, 0.13);
    near(second[0].x, 0.16);
    near(second[0].y - first[0].y, 0.03);
    const overlapX = first[0].x < second[0].x + second[0].w && first[0].x + first[0].w > second[0].x;
    const overlapY = first[0].y < second[0].y + second[0].h && first[0].y + first[0].h > second[0].y;
    assert.equal(overlapX && overlapY, false);
  });

  it("steps back when the next paste would flatten a region on the edge", () => {
    const box = { x: 0.96, y: 0.5, w: 0.04, h: 0.2, desc: "edge" };
    const first = pasteRegions([box], nextPasteNudge(0));
    const second = pasteRegions([box], nextPasteNudge(1));
    near(first[0].x, 0.99);
    near(first[0].w, 0.01);
    assert.ok(second[0].w > 0);
    assert.ok(second[0].h > 0);
    near(second[0].w, box.w);
    near(second[0].h, box.h);
    near(second[0].x, 0.9);
    near(second[0].y, 0.44);
    assert.equal(second[0].desc, "edge");
  });

  it("reverses every region together so the pasted layout does not shear", () => {
    const boxes = [
      { x: 0.9, y: 0.4, w: 0.08, h: 0.1, desc: "a" },
      { x: 0.7, y: 0.2, w: 0.08, h: 0.1, desc: "b" },
    ];
    const placed = pasteRegions(boxes, 0.12);
    near(placed[0].w, 0.08);
    near(placed[1].w, 0.08);
    near(placed[0].x - placed[1].x, boxes[0].x - boxes[1].x);
    near(placed[0].y - placed[1].y, boxes[0].y - boxes[1].y);
    near(placed[0].x, 0.78);
    near(placed[1].x, 0.58);
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

describe("pasted caption text", () => {
  it("accepts a caption with a leading byte-order mark", () => {
    const cap = parseCaptionText(
      '\uFEFF{"compositional_deconstruction":{"background":"sky","elements":[]}}',
    );
    assert.equal(cap.compositional_deconstruction.background, "sky");
  });

  it("rejects text that is not a caption object", () => {
    assert.equal(parseCaptionText(""), null);
    assert.equal(parseCaptionText("\uFEFF"), null);
    assert.equal(parseCaptionText("{nope"), null);
    assert.equal(parseCaptionText("[]"), null);
    assert.equal(parseCaptionText('{"compositional_deconstruction":[]}'), null);
    assert.equal(parseCaptionText('{"high_level_description":"only"}'), null);
  });
});

describe("pasted caption layout", () => {
  const box = { x: 0, y: 0, w: 0.25, h: 0.25, type: "obj", desc: "corner" };

  it("leaves normalized coordinates alone when the source size does not matter", () => {
    const same = remapImportedRegions([box], {
      source: "stretch", destW: 512, destH: 512, mode: "center",
    });
    assert.equal(same[0].x, 0);
    assert.equal(same[0].w, 0.25);
    const matched = remapImportedRegions([box], {
      source: "dimensions", srcW: 512, srcH: 512, destW: 512, destH: 512, mode: "center",
    });
    assert.equal(matched[0].w, 0.25);
  });

  it("fits a source canvas onto the destination even when scale mode is stretch", () => {
    // 256px box at the origin of a 1024 canvas, placed on a 512 canvas.
    // Stretch used to ignore the source size. The default scale mode is stretch,
    // so the dialog's dimension choice did nothing.
    const placed = remapImportedRegions([box], {
      source: "dimensions",
      srcW: 1024,
      srcH: 1024,
      destW: 512,
      destH: 512,
      mode: "stretch",
    });
    near(placed[0].x, 0.25);
    near(placed[0].y, 0.25);
    near(placed[0].w, 0.5);
    near(placed[0].h, 0.5);
    assert.equal(placed[0].desc, "corner");
  });

  it("keeps an anchor mode when the source canvas is a different size", () => {
    const placed = remapImportedRegions([box], {
      source: "dimensions",
      srcW: 1024,
      srcH: 1024,
      destW: 512,
      destH: 512,
      mode: "top-left",
    });
    near(placed[0].x, 0);
    near(placed[0].y, 0);
    near(placed[0].w, 0.5);
    near(placed[0].h, 0.5);
  });

  it("uses an aspect ratio as the source canvas", () => {
    assert.deepEqual(dimsFromAspect("16:9"), { w: 1024, h: 576 });
    assert.equal(dimsFromAspect("nope"), null);
    const wide = { x: 0, y: 0, w: 1, h: 1, desc: "full" };
    const placed = remapImportedRegions([wide], {
      source: "aspect",
      aspect: "2:1",
      destW: 512,
      destH: 512,
      mode: "center",
    });
    // Source is 1024x512, content fills it, destination is square.
    // Uniform fit is limited by height: 512/512 = 1, width scale 512/1024 = 0.5, s = 0.5.
    near(placed[0].w, 1);
    near(placed[0].h, 0.5);
    near(placed[0].x, 0);
    near(placed[0].y, 0.25);
  });

  it("does not let one bad coordinate destroy the other regions", () => {
    const good = { x: 0.25, y: 0.25, w: 0.5, h: 0.5, desc: "ok" };
    const bad = { x: 0.1, y: Number.NaN, w: 0.2, h: 0.2, desc: "bad" };
    const placed = transformBoxesContentUniform([good, bad], 1024, 1024, 512, 512, "center");
    near(placed[0].x, 0);
    near(placed[0].y, 0);
    near(placed[0].w, 1);
    near(placed[0].h, 1);
    assert.equal(placed[1].desc, "bad");
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
