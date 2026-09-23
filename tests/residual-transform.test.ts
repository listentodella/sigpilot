import assert from "node:assert/strict";
import test from "node:test";
import {
  IDENTITY_TRANSFORM,
  applyHorizontalTransform,
  horizontalTransform,
  invertHorizontalTransform,
  transformDeviation,
} from "../src/lib/residualTransform.ts";

const view = (start_sample: number, samples: number) => ({ samples, start_sample });

test("a raster rendered for the view being shown needs no stretch", () => {
  const current = view(1_000, 500);
  const transform = horizontalTransform(current, 800, current, 800);
  assert.equal(transform.m, 1);
  assert.equal(transform.b, 0);
  assert.equal(transformDeviation(transform), 0);
});

test("the raster centre sample lands on the screen position of that sample", () => {
  // The invariant the whole residual transform rests on. If this ever breaks,
  // panning and zooming will drift instead of merely lagging.
  const dataView = view(2_000, 4_000);
  const currentView = view(3_000, 1_000);
  const rasterWidth = 1_600;
  const screenWidth = 900;
  const transform = horizontalTransform(dataView, rasterWidth, currentView, screenWidth);

  const centreRasterX = rasterWidth / 2;
  const centreSample = dataView.start_sample + dataView.samples / 2;
  const expectedScreenX = ((centreSample - currentView.start_sample) / currentView.samples) * screenWidth;

  assert.ok(Math.abs(applyHorizontalTransform(centreRasterX, transform) - expectedScreenX) < 1e-6);
});

test("a coarser raster is magnified and a finer one is minified", () => {
  const currentView = view(0, 1_000);

  // Data covers more samples over the same pixel budget: it must be blown up.
  const coarse = horizontalTransform(view(0, 2_000), 1_000, currentView, 1_000);
  assert.ok(coarse.m > 1, `expected magnification, got m=${coarse.m}`);
  assert.ok(Math.abs(coarse.m - 2) < 1e-9);

  // Data covers fewer samples: it must be shrunk.
  const fine = horizontalTransform(view(0, 500), 1_000, currentView, 1_000);
  assert.ok(Math.abs(fine.m - 0.5) < 1e-9);
});

test("panning shows up as a pure offset with no scale change", () => {
  const dataView = view(1_000, 500);
  const currentView = view(1_100, 500);
  const transform = horizontalTransform(dataView, 800, currentView, 800);

  assert.equal(transform.m, 1);
  // The raster's left edge sits 100 samples to the left of the viewport start,
  // which is 100 * (800 / 500) device pixels off screen.
  assert.ok(Math.abs(transform.b - (-160)) < 1e-9);
});

test("the inverse map round-trips", () => {
  const transform = horizontalTransform(view(500, 2_000), 1_200, view(900, 800), 1_000);
  for (const x of [0, 137.5, 999]) {
    const roundTripped = invertHorizontalTransform(applyHorizontalTransform(x, transform), transform);
    assert.ok(Math.abs(roundTripped - x) < 1e-6, `${x} -> ${roundTripped}`);
  }
});

test("degenerate inputs fall back to a plain blit instead of producing NaN", () => {
  assert.deepEqual(horizontalTransform(view(0, 1_000), 0, view(0, 1_000), 0), IDENTITY_TRANSFORM);
  assert.deepEqual(horizontalTransform(view(0, 0), 0, view(0, 0), 0), IDENTITY_TRANSFORM);
  assert.equal(invertHorizontalTransform(10, { b: 0, m: 0 }), 0);
});

test("deviation reports whichever of scale or offset is further from a blit", () => {
  assert.equal(transformDeviation({ b: 0, m: 1 }), 0);
  assert.equal(transformDeviation({ b: 0, m: 1.25 }), 0.25);
  assert.equal(transformDeviation({ b: -3, m: 1 }), 3);
});
