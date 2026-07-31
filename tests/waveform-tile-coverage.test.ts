import assert from "node:assert/strict";
import test from "node:test";
import type { WaveformTile } from "../src/lib/api.ts";
import {
  graphTileCanServeViewport,
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
