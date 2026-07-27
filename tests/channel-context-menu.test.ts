import assert from "node:assert/strict";
import test from "node:test";
import {
  isChannelDeleteDataVisible,
  resolveChannelTrimAnchorSample,
  resolveChannelTrimRange,
} from "../src/lib/channelContextMenu.ts";

test("Delete Data follows Logic trim availability", () => {
  assert.equal(isChannelDeleteDataVisible(true), true);
  assert.equal(isChannelDeleteDataVisible(false), false);
});

test("channel labels trim from the current viewport start", () => {
  assert.equal(resolveChannelTrimAnchorSample(undefined, 2_048.4, 10_000), 2_048);
});

test("graph context menus trim from the clicked sample", () => {
  assert.equal(resolveChannelTrimAnchorSample(7_500.7, 2_048, 10_000), 7_501);
  assert.equal(resolveChannelTrimAnchorSample(-10, 2_048, 10_000), 0);
  assert.equal(resolveChannelTrimAnchorSample(12_000, 2_048, 10_000), 10_000);
});

test("Delete Data preview resolves the preserved capture range", () => {
  assert.deepEqual(
    resolveChannelTrimRange({
      clickedSample: 2_500,
      mode: "before",
      totalSamples: 10_000,
      viewportSamples: 1_000,
      viewportStart: 2_000,
    }),
    { trimBefore: 2_500, trimStart: 2_500, trimEnd: 10_000 },
  );
  assert.deepEqual(
    resolveChannelTrimRange({
      clickedSample: 2_500,
      mode: "after",
      totalSamples: 10_000,
      viewportSamples: 1_000,
      viewportStart: 2_000,
    }),
    { trimAfter: 2_500, trimStart: 0, trimEnd: 2_500 },
  );
  assert.deepEqual(
    resolveChannelTrimRange({
      clickedSample: undefined,
      mode: "offscreen",
      totalSamples: 10_000,
      viewportSamples: 1_000,
      viewportStart: 2_000,
    }),
    { trimBefore: 2_000, trimAfter: 3_000, trimStart: 2_000, trimEnd: 3_000 },
  );
});

test("channel label Delete Data previews from the viewport center", () => {
  assert.deepEqual(
    resolveChannelTrimRange({
      clickedSample: undefined,
      mode: "before",
      totalSamples: 10_000,
      viewportSamples: 1_000,
      viewportStart: 2_000,
    }),
    { trimBefore: 2_500, trimStart: 2_500, trimEnd: 10_000 },
  );
  assert.deepEqual(
    resolveChannelTrimRange({
      clickedSample: undefined,
      mode: "after",
      totalSamples: 10_000,
      viewportSamples: 1_000,
      viewportStart: 2_000,
    }),
    { trimAfter: 2_500, trimStart: 0, trimEnd: 2_500 },
  );
});
