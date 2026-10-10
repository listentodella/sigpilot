import assert from "node:assert/strict";
import test from "node:test";
import { previewApplyViewIntent, previewSetViewLimits, renderGraphFrame } from "../src/lib/api.ts";
import type { ViewIntent } from "../src/lib/api.ts";

// The browser preview path has no Rust session behind it, so it keeps its own
// viewport. These tests pin the two mistakes that made the waveform render as a
// single flat line: pinning the default viewport before a capture had any
// samples, and deriving the tile range from the caller's placeholder instead of
// from the session viewport.

function request(view: ViewIntent | null) {
  return {
    analyzers: [],
    frame_id: 1,
    // A caller driving the viewport deliberately sends an empty range; only
    // `pixels` and `channels` are meaningful.
    waveform: { channels: [0, 1], pixels: 1_350, sample_count: 0, start_sample: 0 },
    view,
  };
}

test("a passive keep_current frame still renders the session viewport", async () => {
  const response = await renderGraphFrame("preview-keep-current", request({ kind: "keep_current" }));

  // The default viewport is derived from the capture, never from the empty range
  // the caller sent. A viewport of one sample is what a flat line looks like.
  assert.ok(
    response.view.samples > 1_000,
    `expected a real viewport, got ${response.view.samples} samples`,
  );
  assert.equal(response.data_view, response.view);

  // The tile has to cover exactly what the viewport claims, or the renderer maps
  // samples to the wrong pixels.
  const start = Math.max(0, Math.floor(response.view.start_sample));
  assert.equal(response.tile.start_sample, start);
  assert.equal(
    response.tile.sample_count,
    Math.ceil(response.view.start_sample + response.view.samples) - start,
  );
  assert.ok(response.tile.pixels > 1, "a one pixel tile cannot show a waveform");
});

test("repeated passive frames keep the same viewport instead of pinning the first", async () => {
  const first = await renderGraphFrame("preview-repeat", request({ kind: "keep_current" }));
  const second = await renderGraphFrame("preview-repeat", request({ kind: "keep_current" }));
  assert.deepEqual(second.view, first.view);
});

test("a set intent moves the viewport and the tile follows", async () => {
  const sessionId = "preview-set";
  const moved = previewApplyViewIntent(sessionId, {
    kind: "set",
    samples: 10_000,
    start_sample: 40_000,
  });
  assert.equal(moved.start_sample, 40_000);
  assert.equal(moved.samples, 10_000);

  const response = await renderGraphFrame(sessionId, request({ kind: "keep_current" }));
  // A gesture is remembered, so the next passive frame stays where it was put.
  assert.deepEqual(response.view, moved);
  assert.equal(response.tile.start_sample, 40_000);
  assert.equal(response.tile.sample_count, 10_000);
});

test("a live session follows the tail rather than fitting the whole capture", () => {
  const sessionId = "preview-live";
  previewSetViewLimits(sessionId, {
    live: true,
    maximum_samples: null,
    sample_rate_hz: 25_000_000,
  });
  const view = previewApplyViewIntent(sessionId, { delta_samples: 0, kind: "pan_samples" });
  // One second of capture at 25 MHz, clamped to what exists.
  assert.equal(view.samples, 250_000);
  assert.equal(view.start_sample, 0);
});

test("a zoom past the preview ceiling does not translate the view", () => {
  const sessionId = "preview-zoom-ceiling";
  previewSetViewLimits(sessionId, {
    live: false,
    maximum_samples: null,
    sample_rate_hz: 25_000_000,
  });

  // Settle on the widest span this session may show, whatever the preview
  // capture's length is: a `set` far past any ceiling comes back clamped to it.
  // Asking for the ceiling instead of computing it keeps the test independent of
  // the demo capture's size.
  const wide = previewApplyViewIntent(sessionId, { kind: "set", samples: 1e12, start_sample: 0 });
  const atCeiling = previewApplyViewIntent(sessionId, {
    kind: "set",
    samples: wide.samples,
    start_sample: 0,
  });
  assert.equal(atCeiling.start_sample, 0);

  // Keep scrolling out. The span cannot grow, so the start must not move either:
  // otherwise every notch past the end of the range slides the trace sideways.
  let view = atCeiling;
  for (let notch = 0; notch < 6; notch += 1) {
    view = previewApplyViewIntent(sessionId, {
      kind: "zoom",
      factor: 1.4142135623730951,
      anchor_ratio: 0.1342925659472422,
    });
    assert.equal(
      view.samples,
      atCeiling.samples,
      `notch ${notch} changed the span past the ceiling`,
    );
    assert.ok(
      Math.abs(view.start_sample - atCeiling.start_sample) < 1,
      `notch ${notch} slid the view: start went from ${atCeiling.start_sample} to ${view.start_sample}`,
    );
  }
});
