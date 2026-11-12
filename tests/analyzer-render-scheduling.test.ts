import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzerRenderProgress,
  analyzerRenderRequestIntervalMs,
  analyzerRenderedTracksMatchRequests,
  analyzerRenderViewportCanServe,
  nextAnalyzerRenderProgress,
  preserveLiveAnalyzerTracks,
} from "../src/lib/analyzerRenderScheduling.ts";
import type { AnalyzerTrackWindow } from "../src/lib/api.ts";

/**
 * The progress sampler ticks every 100 ms while a native analyzer batch runs.
 * Reporting "no change" on the flat part of the curve is what keeps a working
 * analyzer from re-rendering the whole workbench ten times a second.
 */
test("a flat progress curve reports no change instead of a new session write", () => {
  // Mid-curve the value moves, so the caller must write.
  const first = nextAnalyzerRenderProgress(0, 100);
  assert.ok(first !== null && first > 0);

  // Ticking again at the same elapsed time cannot move it.
  assert.equal(nextAnalyzerRenderProgress(first, 100), null);

  // Once the curve saturates, further ticks must all report no change, however
  // long the analyzer works.
  const saturated = analyzerRenderProgress(600_000);
  for (const elapsed of [600_000, 600_100, 601_000, 900_000]) {
    assert.equal(nextAnalyzerRenderProgress(saturated, elapsed), null);
  }
});

test("progress never goes backwards and stays below the completion mark", () => {
  let progress = 0;
  for (const elapsed of [0, 100, 500, 2_400, 10_000, 60_000]) {
    const next = nextAnalyzerRenderProgress(progress, elapsed);
    if (next === null) continue;
    assert.ok(next >= progress, `progress fell from ${progress} to ${next}`);
    progress = next;
  }
  assert.ok(progress <= 94, "the sampler must not claim completion");
  assert.equal(analyzerRenderProgress(0), 8);
});

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

test("subpixel live data does not cause endless analyzer LOD retries", () => {
  assert.equal(
    analyzerRenderViewportCanServe(
      { startSample: 0, sampleCount: 1_000, pixels: 1 },
      { startSample: 0, sampleCount: 500_000_000, pixels: 1_000 },
      true,
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

test("rendered analyzer tracks match requests independent of order", () => {
  const rendered = [
    { ...trackWindow([]), channel: 1, role: "SCL" },
    { ...trackWindow([]), channel: 0, role: "SDA" },
  ];
  assert.equal(
    analyzerRenderedTracksMatchRequests(rendered, [
      { channel: 0, role: "SDA" },
      { channel: 1, role: "SCL" },
    ]),
    true,
  );
  assert.equal(
    analyzerRenderedTracksMatchRequests(rendered, [
      { channel: 0, role: "SDA" },
      { channel: 2, role: "SDA" },
    ]),
    false,
  );
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
