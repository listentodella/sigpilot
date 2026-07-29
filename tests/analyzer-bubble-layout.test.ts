import assert from "node:assert/strict";
import test from "node:test";
import { analyzerBubbleLayout } from "../src/lib/analyzerBubbleLayout.ts";

test("analyzer bubbles receive exact viewport coordinates", () => {
  assert.deepEqual(analyzerBubbleLayout(250, 500, 0, 1_000, 800), {
    leftPx: 200,
    overflowLeft: false,
    overflowRight: false,
    visible: true,
    widthPx: 200,
  });
});

test("analyzer bubbles clip at both viewport edges", () => {
  assert.deepEqual(analyzerBubbleLayout(50, 250, 100, 100, 600), {
    leftPx: 0,
    overflowLeft: true,
    overflowRight: true,
    visible: true,
    widthPx: 600,
  });
});

test("offscreen analyzer bubbles are omitted", () => {
  assert.equal(analyzerBubbleLayout(0, 50, 100, 100, 600).visible, false);
  assert.equal(analyzerBubbleLayout(250, 300, 100, 100, 600).visible, false);
});
