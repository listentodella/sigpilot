import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzerBubbleKey,
  paddedAnalyzerBubbleRange,
  visibleAnalyzerBubbleKeys,
  visibleAnalyzerBubbleRange,
} from "../src/lib/analyzerBubbleVisibility.ts";

test("visible analyzer bubble range trims to the viewport and preserves overlaps", () => {
  const bubbles = [
    { start_sample: 0, end_sample: 10 },
    { start_sample: 12, end_sample: 24 },
    { start_sample: 18, end_sample: 30 },
    { start_sample: 40, end_sample: 52 },
  ];

  assert.deepEqual(visibleAnalyzerBubbleRange(bubbles, 15, 12), [1, 3]);
  assert.deepEqual(visibleAnalyzerBubbleRange(bubbles, 41, 4), [3, 4]);
  assert.deepEqual(visibleAnalyzerBubbleRange(bubbles, 60, 10), [4, 4]);
});

test("padded analyzer bubble range includes nearby offscreen bubbles", () => {
  const bubbles = [
    { start_sample: 0, end_sample: 8 },
    { start_sample: 24, end_sample: 32 },
    { start_sample: 48, end_sample: 56 },
    { start_sample: 80, end_sample: 88 },
  ];

  assert.deepEqual(paddedAnalyzerBubbleRange(bubbles, 40, 12, 16), [1, 3]);
  assert.deepEqual(paddedAnalyzerBubbleRange(bubbles, 40, 12, 0), [2, 3]);
});

test("padded analyzer bubble range clamps before sample zero", () => {
  const bubbles = [
    { start_sample: 0, end_sample: 8 },
    { start_sample: 16, end_sample: 24 },
    { start_sample: 40, end_sample: 48 },
  ];

  assert.deepEqual(paddedAnalyzerBubbleRange(bubbles, 4, 8, 20), [0, 2]);
});

test("visible analyzer bubble keys only include visible bubbles across tracks", () => {
  const firstTrack = {
    key: "i2c:data:0:bubbles",
    bubbles: [
      { start_sample: 0, end_sample: 8, frame_id_interval: { begin: 0, end: 1 } },
      { start_sample: 16, end_sample: 24, frame_id_interval: { begin: 1, end: 2 } },
      { start_sample: 48, end_sample: 56, frame_id_interval: { begin: 2, end: 3 } },
    ],
  };
  const secondTrack = {
    key: "spi:mosi:1:bubbles",
    bubbles: [
      { start_sample: 12, end_sample: 18, frame_id_interval: { begin: 3, end: 4 } },
      { start_sample: 64, end_sample: 72, frame_id_interval: { begin: 4, end: 5 } },
    ],
  };

  assert.deepEqual(
    visibleAnalyzerBubbleKeys([firstTrack, secondTrack], 10, 20),
    new Set([
      analyzerBubbleKey(firstTrack.key, firstTrack.bubbles[1]),
      analyzerBubbleKey(secondTrack.key, secondTrack.bubbles[0]),
    ]),
  );
});
