import assert from "node:assert/strict";
import test from "node:test";
import { findNearestEdgeSample } from "../src/lib/waveformEdgeSnap";

test("edge snapping respects the pixel threshold", () => {
  assert.equal(findNearestEdgeSample([200, 600], 210, 10, 10, false), 200);
  assert.equal(findNearestEdgeSample([200, 600], 350, 10, 10, false), null);
});

test("timing marker snapping rejects visually crowded edge pairs", () => {
  assert.equal(findNearestEdgeSample([200, 250], 200, 10, 8, true), null);
});

test("empty exact edge data cannot produce a timing marker snap", () => {
  assert.equal(findNearestEdgeSample([], 200, 10, 8, true), null);
});
