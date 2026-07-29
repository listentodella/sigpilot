import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzerRenderRequestIntervalMs,
  analyzerRenderViewportCanServe,
  preserveLiveAnalyzerTracks,
} from "../src/lib/analyzerRenderScheduling.ts";
import type { AnalyzerTrackWindow } from "../src/lib/api.ts";

test("interactive analyzer renders keep following the viewport", () => {
  assert.equal(analyzerRenderRequestIntervalMs(true, false), 50);
  assert.equal(analyzerRenderRequestIntervalMs(false, true), 80);
  assert.equal(analyzerRenderRequestIntervalMs(false, false), 40);
});

test("stale analyzer aggregation cannot serve a substantially finer LOD", () => {
  assert.equal(
    analyzerRenderViewportCanServe(
      { startSample: 0, sampleCount: 2_000, pixels: 1_000 },
      { startSample: 500, sampleCount: 500, pixels: 1_000 },
      false,
    ),
    false,
  );
});

test("live analyzer renders tolerate a small amount of right-edge lag", () => {
  assert.equal(
    analyzerRenderViewportCanServe(
      { startSample: 0, sampleCount: 900, pixels: 900 },
      { startSample: 0, sampleCount: 1_000, pixels: 1_000 },
      true,
    ),
    true,
  );
});

test("viewport whitespace does not invalidate an analyzer render", () => {
  assert.equal(
    analyzerRenderViewportCanServe(
      { startSample: 0, sampleCount: 1_000, pixels: 400 },
      { startSample: -750, sampleCount: 2_500, pixels: 1_000 },
      false,
      { startSample: 0, sampleCount: 1_000 },
    ),
    true,
  );
});

test("empty live updates preserve the previous analyzer snapshot", () => {
  const previous = [trackWindow([bubble(10, 20)])];
  const incoming = [trackWindow([])];
  assert.equal(preserveLiveAnalyzerTracks(previous, incoming)[0], previous[0]);
});

function trackWindow(bubbles: AnalyzerTrackWindow["bubbles"]): AnalyzerTrackWindow {
  return {
    bubbles,
    channel: 0,
    frames: [],
    next_frame: null,
    previous_frame: null,
    role: "MOSI",
  };
}

function bubble(start: number, end: number): AnalyzerTrackWindow["bubbles"][number] {
  return {
    display_text: ["0x01"],
    end_sample: end,
    frame_id_interval: { begin: start, end },
    result_count: 1,
    start_sample: start,
    type: "SingleBubble",
  };
}
