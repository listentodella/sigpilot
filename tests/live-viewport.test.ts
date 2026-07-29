import assert from "node:assert/strict";
import test from "node:test";
import { defaultCaptureViewportSamples } from "../src/lib/liveViewport.ts";

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
