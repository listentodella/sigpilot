import assert from "node:assert/strict";
import test from "node:test";
import { findNearestEdgeSample, resolveWaveformPointerSample } from "../src/lib/waveformEdgeSnap";

test("edge snapping respects the pixel threshold", () => {
  assert.equal(findNearestEdgeSample([200, 600], 210, 10, 10, false), 200);
  assert.equal(findNearestEdgeSample([200, 600], 350, 10, 10, false), null);
});

test("timing marker snapping rejects visually crowded edge pairs", () => {
  assert.equal(findNearestEdgeSample([200, 250], 200, 10, 8, true), null);
});

test("a narrow preceding pulse does not suppress the next distinct edge", () => {
  assert.equal(findNearestEdgeSample([150, 200, 400], 200, 10, 8, true), 200);
});

test("empty exact edge data cannot produce a timing marker snap", () => {
  assert.equal(findNearestEdgeSample([], 200, 10, 8, true), null);
});

test("edge snapping includes the configured pixel threshold", () => {
  assert.equal(findNearestEdgeSample([200], 280, 10, 8, false), 200);
});

test("waveform pointer snapping can stay fixed to the range start channel", () => {
  const tile = {
    start_sample: 0,
    sample_count: 1_000,
    pixels: 100,
    samples_per_pixel: 10,
    channels: [
      { channel: 0, label: "D0", bins: [], segments: [], rising_edges: [200], falling_edges: [] },
      { channel: 1, label: "D1", bins: [], segments: [], rising_edges: [700], falling_edges: [] },
    ],
  };
  const hit = resolveWaveformPointerSample({
    clientX: 21,
    clientY: 75,
    fixedChannelIndex: 0,
    rect: { bottom: 100, height: 100, left: 0, right: 100, top: 0, width: 100 },
    rowHeights: [48, 48],
    tile,
    totalSamples: 1_000,
    viewportSamples: 1_000,
    viewportStart: 0,
  });
  assert.equal(hit.channelIndex, 0);
  assert.equal(hit.sample, 200);
  assert.equal(hit.snapped, true);
});
