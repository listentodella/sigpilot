import assert from "node:assert/strict";
import test from "node:test";
import {
  isChannelDeleteDataVisible,
  resolveChannelTrimAnchorSample,
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
