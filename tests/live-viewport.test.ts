import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultCaptureViewportSamples,
  previewCaptureViewportSamples,
} from "../src/lib/liveViewport.ts";

test("live capture initially fits all samples while the default window fills", () => {
  assert.equal(defaultCaptureViewportSamples(25_000_000, 100_000_000), 25_000_000);
});

test("live capture defaults to roughly one second at the selected sample rate", () => {
  assert.equal(defaultCaptureViewportSamples(250_000_000, 100_000_000), 100_000_000);
  assert.equal(defaultCaptureViewportSamples(5_000_000, 1_000_000), 1_000_000);
});

test("low sample rates retain a useful minimum overview", () => {
  assert.equal(defaultCaptureViewportSamples(500_000, 10_000), 100_000);
  assert.equal(defaultCaptureViewportSamples(50_000, 10_000), 50_000);
});

test("a finished capture previews the whole thing", () => {
  // The live default would have shown one second of these; the preview shows all
  // of it, because a finished capture is something to look at rather than follow.
  assert.equal(previewCaptureViewportSamples(5_000_000, 1_000_000), 5_000_000);
  assert.equal(previewCaptureViewportSamples(500_000, 10_000), 500_000);
  assert.equal(previewCaptureViewportSamples(25_000_000, 100_000_000), 25_000_000);
});

test("the preview stays bounded for captures too large to draw at once", () => {
  const samples = previewCaptureViewportSamples(250_000_000, 100_000_000);
  assert.equal(samples, 100_000_000);
  assert.ok(
    samples < 250_000_000,
    "a capture beyond the budget should be windowed, not shown whole",
  );
});

test("the preview is never narrower than the live default", () => {
  // Both share the one-second floor, so stopping a capture can only widen the
  // view or leave it alone — never zoom in past what the user was following.
  for (const [total, rate] of [
    [5_000_000, 1_000_000],
    [500_000, 10_000],
    [25_000_000, 100_000_000],
    [250_000_000, 100_000_000],
  ] as const) {
    assert.ok(
      previewCaptureViewportSamples(total, rate) >= defaultCaptureViewportSamples(total, rate),
      `preview narrower than live default for ${total} samples at ${rate} Hz`,
    );
  }
});
