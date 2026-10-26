import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  elementToRegion,
  fallbackRegion,
  ideogramBboxToRect,
  regionCoordsFinite,
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
});
