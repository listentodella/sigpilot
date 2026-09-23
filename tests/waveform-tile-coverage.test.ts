import assert from "node:assert/strict";
import test from "node:test";
import type { WaveformTile } from "../src/lib/api.ts";
import {
  graphTileCanServeViewport,
  rasterCoversViewport,
  rasterMagnification,
  rasterOverlapsViewport,
  rasterServesViewport,
  waveformTileRequiresDirectDraw,
} from "../src/lib/waveformTileCoverage.ts";

test("a native-resolution tile serves a sub-sample viewport after an edge jump", () => {
  const tile = makeTile(12_495_703, 131, 1);

  assert.equal(
    graphTileCanServeViewport(
      tile,
      12_495_767.57,
      1.71,
      156_947_500,
      1_361,
      [0],
    ),
    true,
  );
});

test("an old edge-navigation tile cannot serve a distant viewport", () => {
  const tile = makeTile(12_489_358, 2_916, 1.12);

  assert.equal(
    graphTileCanServeViewport(
      tile,
      12_495_767.57,
      1.71,
      156_947_500,
      1_361,
      [0],
    ),
    false,
  );
});

test("a genuinely coarse tile is rejected at an ordinary zoom level", () => {
  const tile = makeTile(0, 10_000, 10);

  assert.equal(graphTileCanServeViewport(tile, 2_000, 1_000, 20_000, 1_000, [0]), false);
});

test("native-resolution bins are drawn directly when the viewport magnifies them", () => {
  assert.equal(waveformTileRequiresDirectDraw(1, 240, 1_200), true);
});

test("a cached tile remains valid when its pixels are not magnified", () => {
  assert.equal(waveformTileRequiresDirectDraw(1, 1_200, 1_200), false);
  assert.equal(waveformTileRequiresDirectDraw(1.001, 1_200, 1_200), false);
  assert.equal(waveformTileRequiresDirectDraw(0.5, 1_200, 1_200), false);
});

test("a raster is blitted 1:1 only while the viewport sits inside it", () => {
  // Raster covers samples 1_000..2_000.
  assert.equal(rasterCoversViewport(1_000, 1_000, 1_200, 400), true);
  assert.equal(rasterCoversViewport(1_000, 1_000, 1_000, 1_000), true);
  // Viewport pokes out on the right / left / both.
  assert.equal(rasterCoversViewport(1_000, 1_000, 1_800, 400), false);
  assert.equal(rasterCoversViewport(1_000, 1_000, 900, 400), false);
  assert.equal(rasterCoversViewport(1_000, 1_000, 500, 2_000), false);
  // Degenerate inputs never claim coverage.
  assert.equal(rasterCoversViewport(1_000, 0, 1_000, 100), false);
  assert.equal(rasterCoversViewport(1_000, 1_000, 1_000, 0), false);
});

test("a partially overlapping raster still counts as drawable", () => {
  // The regression this pins: the magnified path used to fall through to
  // drawing nothing when the cached raster did not fully cover the viewport,
  // which made a zoom look like it had erased the waveform.
  assert.equal(rasterOverlapsViewport(1_000, 1_000, 1_800, 400), true);
  assert.equal(rasterOverlapsViewport(1_000, 1_000, 900, 400), true);
  assert.equal(rasterOverlapsViewport(1_000, 1_000, 500, 2_000), true);
  // Touching exactly at the edge is not an overlap: there is nothing to draw.
  assert.equal(rasterOverlapsViewport(1_000, 1_000, 2_000, 400), false);
  assert.equal(rasterOverlapsViewport(1_000, 1_000, 600, 400), false);
  assert.equal(rasterOverlapsViewport(1_000, 0, 1_000, 100), false);
});

function makeTile(startSample: number, sampleCount: number, samplesPerPixel: number): WaveformTile {
  return {
    channels: [{
      bins: [],
      channel: 0,
      falling_edges: [],
      label: "D0",
      rising_edges: [],
      segments: [],
    }],
    pixels: Math.max(1, Math.ceil(sampleCount / samplesPerPixel)),
    sample_count: sampleCount,
    samples_per_pixel: samplesPerPixel,
    start_sample: startSample,
  };
}

// Coverage and scale are separate questions, and conflating them is what let a
// zoom-in reuse one raster for a whole gesture. These pin the distinction.

test("magnification is 1 when the raster matches the viewport scale", () => {
  // 1000 samples over 1000 px shown as 1000 samples over 1000 px.
  assert.equal(rasterMagnification(1_000, 1_000, 1_000, 1_000), 1);
});

test("magnification reports the zoom ratio since the raster was rendered", () => {
  // The raster covers 30x more samples at the same width, so blitting the
  // current viewport out of it magnifies by 30.
  assert.equal(rasterMagnification(30_000, 1_000, 1_000, 1_000), 30);
});

test("magnification is 0 for degenerate inputs rather than Infinity", () => {
  assert.equal(rasterMagnification(0, 1_000, 1_000, 1_000), 0);
  assert.equal(rasterMagnification(1_000, 0, 1_000, 1_000), 0);
  assert.equal(rasterMagnification(1_000, 1_000, 0, 1_000), 0);
  assert.equal(rasterMagnification(1_000, 1_000, 1_000, 0), 0);
});

test("a raster rendered for a wider range covers a zoomed-in viewport but does not serve it", () => {
  const sourceStart = 0;
  const sourceSamples = 30_000;
  const sourceWidth = 1_000;
  const viewportStart = 10_000;
  const viewportSamples = 1_000;
  const canvasWidth = 1_000;

  // Coverage alone says yes, which is exactly the trap.
  assert.equal(rasterCoversViewport(sourceStart, sourceSamples, viewportStart, viewportSamples), true);
  // Serving it would magnify by 30x, so the caller has to refuse and refresh.
  assert.equal(
    rasterServesViewport(sourceStart, sourceSamples, sourceWidth, viewportStart, viewportSamples, canvasWidth),
    false,
  );
});

test("a raster at the viewport scale and range serves it", () => {
  assert.equal(rasterServesViewport(10_000, 1_000, 1_000, 10_000, 1_000, 1_000), true);
});

test("magnification up to 5 percent still serves, matching the direct-draw tolerance", () => {
  // 1050 samples over 1000 px against a 1000/1000 viewport is 1.05.
  assert.equal(rasterServesViewport(10_000, 1_050, 1_000, 10_000, 1_000, 1_000), true);
  // 1060 is past it.
  assert.equal(rasterServesViewport(10_000, 1_060, 1_000, 10_000, 1_000, 1_000), false);
});

test("a raster that no longer covers the viewport never serves it", () => {
  // Right scale, wrong range: the viewport has panned off the end.
  assert.equal(rasterServesViewport(0, 1_000, 1_000, 5_000, 1_000, 1_000), false);
});

test("a raster finer than the viewport serves it", () => {
  // Same range but rendered with twice the pixels, so magnification is 0.5.
  // Downscaling loses no detail, so it is allowed.
  assert.equal(rasterMagnification(1_000, 2_000, 1_000, 1_000), 0.5);
  assert.equal(rasterServesViewport(10_000, 1_000, 2_000, 10_000, 1_000, 1_000), true);
});

