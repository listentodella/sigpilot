import assert from "node:assert/strict";
import test from "node:test";
import type { WaveformTile } from "../src/lib/api.ts";
import { activeUiTheme, activeWaveformThemeColors, getUiTheme, setActiveUiTheme, type WaveformThemeColors } from "../src/lib/themes.ts";
import {
  requestViewportRaster,
  requestWaveLayerRender,
  requestViewportRender,
  sameChannelColors,
  sameWaveformThemeColors,
  startWaveLayerWorkerRequest,
  type WaveLayerWorkerState,
} from "../src/lib/waveLayerWorker.ts";

// These cover the worker-request pipeline that used to live inside
// `WaveformCanvas.tsx`, where Node's inability to parse JSX made it unreachable
// from this suite. The regression they exist for is the one a user hit: zoom all
// the way out so each channel collapses to a band, then zoom back in, and the
// edges never came back. The cause was `requestViewportRaster` being reachable
// without the worker ever having been handed a tile, so the ref it guards on
// could never advance and every viewport render was refused — permanently.

interface SentMessage {
  type: string;
  id: number;
  dpr: number;
  height: number;
  width: number;
  channelColors: readonly string[];
  themeColors: WaveformThemeColors;
  tileStart?: number;
  tileSamples?: number;
  viewStart?: number;
  viewSamples?: number;
}

function makeTile(startSample: number, sampleCount: number, samplesPerPixel: number): WaveformTile {
  return {
    channels: [
      {
        // Two packed bins so the transfer path is exercised rather than skipped.
        bins: [],
        channel: 0,
        falling_edges: [],
        label: "D0",
        packed_bins: new Uint8Array(32),
        rising_edges: [],
        segments: [],
      },
    ],
    pixels: Math.max(1, Math.ceil(sampleCount / samplesPerPixel)),
    sample_count: sampleCount,
    samples_per_pixel: samplesPerPixel,
    start_sample: startSample,
  };
}

function makeHarness() {
  const sent: SentMessage[] = [];
  const state: WaveLayerWorkerState = {
    active: null,
    failed: false,
    nextId: 1,
    queued: null,
    viewportActive: null,
    viewportQueued: null,
    worker: {
      postMessage: (message: unknown) => {
        sent.push(message as SentMessage);
      },
    },
  };
  return {
    sent,
    state,
    workerRef: { current: state },
    workerTileRef: { current: null as WaveformTile | null },
  };
}

/** A canvas stand-in: the pipeline only reads these two numbers. */
const target = { height: 400, width: 1200 };
const rows = [200];
const insets = [0];

test("a viewport raster first asks for the tile the worker has to hold", () => {
  const harness = makeHarness();
  const tile = makeTile(0, 100_000, 1);

  requestViewportRaster(
    tile,
    50_000,
    1_000,
    target,
    rows,
    insets,
    true,
    harness.workerRef,
    harness.workerTileRef,
    1_200,
    1,
  );

  assert.equal(harness.sent.length, 1);
  assert.equal(harness.sent[0].type, "render");
  assert.equal(harness.sent[0].tileStart, 0);
  assert.equal(harness.sent[0].tileSamples, 100_000);
});

test("holding a coarser tile still asks for the tile the viewport needs", () => {
  const harness = makeHarness();
  // The state the user's reproduction left behind: the worker holds a coarse
  // tile from the zoomed-out view, and the viewport has moved on.
  const coarse = makeTile(0, 2_500_000, 10);
  const fine = makeTile(49_000, 4_000, 1);
  harness.workerTileRef.current = coarse;

  requestViewportRaster(
    fine,
    50_000,
    1_000,
    target,
    rows,
    insets,
    true,
    harness.workerRef,
    harness.workerTileRef,
    1_200,
    1,
  );

  assert.equal(harness.sent.length, 1);
  assert.equal(harness.sent[0].type, "render");
  // The request must be for the tile the viewport needs, not the one on hand.
  assert.equal(harness.sent[0].tileStart, 49_000);
  assert.equal(harness.sent[0].tileSamples, 4_000);
});

test("once the worker holds the tile the request becomes a transform", () => {
  const harness = makeHarness();
  const tile = makeTile(0, 100_000, 1);
  harness.workerTileRef.current = tile;

  requestViewportRaster(
    tile,
    50_000,
    1_000,
    target,
    rows,
    insets,
    true,
    harness.workerRef,
    harness.workerTileRef,
    1_200,
    1,
  );

  assert.equal(harness.sent.length, 1);
  const message = harness.sent[0];
  assert.equal(message.type, "transform");
  // Overscan is half a viewport on each side, so the raster spans 2000 samples.
  assert.equal(message.viewStart, 49_500);
  assert.equal(message.viewSamples, 2_000);
  assert.equal(message.width, 2_400);
  assert.equal(message.height, 400);
});

test("the tile request is not repeated while it is still in flight", () => {
  const harness = makeHarness();
  const tile = makeTile(0, 100_000, 1);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    requestViewportRaster(
      tile,
      50_000,
      1_000,
      target,
      rows,
      insets,
      true,
      harness.workerRef,
      harness.workerTileRef,
      1_200,
      1,
    );
  }

  // Without the in-flight check this would be three identical renders, and the
  // worker would answer three times for one tile.
  assert.equal(harness.sent.length, 1);
  assert.equal(harness.sent[0].type, "render");
});

test("a failed worker is not asked for anything", () => {
  const harness = makeHarness();
  harness.state.failed = true;

  requestViewportRaster(
    makeTile(0, 100_000, 1),
    50_000,
    1_000,
    target,
    rows,
    insets,
    true,
    harness.workerRef,
    harness.workerTileRef,
    1_200,
    1,
  );

  assert.equal(harness.sent.length, 0);
});

test("a viewport outside the retained tile is not requested", () => {
  const harness = makeHarness();
  const tile = makeTile(0, 1_000, 1);
  harness.workerTileRef.current = tile;

  requestViewportRaster(
    tile,
    5_000,
    1_000,
    target,
    rows,
    insets,
    true,
    harness.workerRef,
    harness.workerTileRef,
    1_200,
    1,
  );

  // The worker can only address bins it holds, so there is nothing to ask for.
  assert.equal(harness.sent.length, 0);
});

test("the request carries the dpr it was made at", () => {
  const harness = makeHarness();
  const tile = makeTile(0, 100_000, 1);

  requestWaveLayerRender(harness.state, tile, 1_200, 400, rows, insets, true, 2);

  assert.equal(harness.sent.length, 1);
  assert.equal(harness.sent[0].dpr, 2);
});

test("a display scale change is a different request, not a duplicate", () => {
  const harness = makeHarness();
  const tile = makeTile(0, 100_000, 1);

  startWaveLayerWorkerRequest(harness.state, {
    dpr: 1,
    height: 400,
    id: harness.state.nextId++,
    matchChannelColors: true,
    channelColors: activeUiTheme().channelColors,
    themeColors: activeWaveformThemeColors(),
    rowHeights: rows,
    rowTopInsets: insets,
    tile,
    width: 1_200,
  });
  harness.state.active = null;

  requestWaveLayerRender(harness.state, tile, 1_200, 400, rows, insets, true, 2);

  // The raster is scale dependent, so deduping across a dpr change would leave
  // the graph rendering at the previous display's resolution.
  assert.equal(harness.sent.length, 2);
  assert.equal(harness.sent[1].dpr, 2);
});

test("a newer viewport replaces the queued one while a transform is in flight", () => {
  const harness = makeHarness();
  const tile = makeTile(0, 100_000, 1);
  harness.workerTileRef.current = tile;

  // First call starts a transform; the next two arrive while it is in flight.
  for (const start of [50_000, 50_500, 51_000]) {
    requestViewportRaster(
      tile,
      start,
      1_000,
      target,
      rows,
      insets,
      true,
      harness.workerRef,
      harness.workerTileRef,
      1_200,
      1,
    );
  }

  assert.equal(harness.sent.length, 1, "only the first transform is sent immediately");
  assert.equal(harness.sent[0].viewStart, 49_500);
  // Latest-only: the middle viewport is already obsolete by the time it could
  // be rendered, so only the newest survives in the queue.
  assert.equal(harness.state.viewportQueued?.viewStart, 50_500);
});

test("a structurally identical tile is still a different tile", () => {
  const harness = makeHarness();
  const held = makeTile(0, 100_000, 1);
  harness.workerTileRef.current = held;

  requestViewportRaster(
    makeTile(0, 100_000, 1),
    50_000,
    1_000,
    target,
    rows,
    insets,
    true,
    harness.workerRef,
    harness.workerTileRef,
    1_200,
    1,
  );

  // Identity is the cache key, and tiles are replaced rather than mutated, so a
  // fresh object means fresh bins that the worker has not been given.
  assert.equal(harness.sent.length, 1);
  assert.equal(harness.sent[0].type, "render");
});

test("tile and viewport messages carry the main thread theme palette", () => {
  const previous = activeUiTheme();
  try {
    const theme = getUiTheme("midnight-aurora");
    setActiveUiTheme(theme);
    const harness = makeHarness();
    const tile = makeTile(0, 100_000, 1);
    requestWaveLayerRender(harness.state, tile, 1_200, 400, rows, insets, true, 1);
    harness.workerTileRef.current = tile;
    requestViewportRaster(tile, 50_000, 1_000, target, rows, insets, true,
      harness.workerRef, harness.workerTileRef, 1_200, 1);
    assert.deepEqual(harness.sent.map((message) => message.type), ["render", "transform"]);
    for (const message of harness.sent) {
      assert.deepEqual(message.channelColors, activeUiTheme().channelColors);
      assert.deepEqual(message.themeColors, activeWaveformThemeColors());
    }
  } finally {
    setActiveUiTheme(previous);
  }
});

test("a palette change queues a fresh tile and viewport even without a viewport or tile change", () => {
  const harness = makeHarness();
  const tile = makeTile(0, 100_000, 1);
  const first = getUiTheme("saleae-dark").channelColors;
  const next = getUiTheme("lab-light").channelColors;
  requestWaveLayerRender(harness.state, tile, 1_200, 400, rows, insets, true, 1, first);
  requestViewportRender(harness.state, tile, 1_200, 400, rows, insets, true, 0, 1_000, 1, first);
  requestWaveLayerRender(harness.state, tile, 1_200, 400, rows, insets, true, 1, [...first]);
  assert.equal(harness.state.queued, null, "equivalent palettes are deduplicated");
  requestWaveLayerRender(harness.state, tile, 1_200, 400, rows, insets, true, 1, next);
  requestViewportRender(harness.state, tile, 1_200, 400, rows, insets, true, 0, 1_000, 1, next);
  assert.deepEqual(harness.state.queued?.channelColors, next);
  assert.deepEqual(harness.state.viewportQueued?.channelColors, next);
  assert.equal(sameChannelColors(first, next), false, "old-color raster cannot be reused");
});

test("rapid palette changes retain only the newest queued palette", () => {
  const harness = makeHarness();
  const tile = makeTile(0, 100_000, 1);
  for (const theme of ["saleae-dark", "midnight-aurora", "terminal-green"]) {
    const palette = getUiTheme(theme).channelColors;
    requestWaveLayerRender(harness.state, tile, 1_200, 400, rows, insets, true, 1, palette);
    requestViewportRender(harness.state, tile, 1_200, 400, rows, insets, true, 0, 1_000, 1, palette);
  }
  assert.equal(harness.sent.length, 2);
  assert.deepEqual(harness.state.queued?.channelColors, getUiTheme("terminal-green").channelColors);
  assert.deepEqual(harness.state.viewportQueued?.channelColors, getUiTheme("terminal-green").channelColors);
});

test("switching back to the in-flight palette cancels the obsolete queued palette", () => {
  const harness = makeHarness();
  const tile = makeTile(0, 100_000, 1);
  for (const theme of ["saleae-dark", "lab-light", "saleae-dark"]) {
    const palette = getUiTheme(theme).channelColors;
    requestWaveLayerRender(harness.state, tile, 1_200, 400, rows, insets, true, 1, palette);
    requestViewportRender(harness.state, tile, 1_200, 400, rows, insets, true, 0, 1_000, 1, palette);
  }
  assert.equal(harness.state.queued, null);
  assert.equal(harness.state.viewportQueued, null);
  assert.equal(harness.sent.length, 2);
});

test("semantic render colors invalidate tile and viewport requests with an unchanged palette", () => {
  const harness = makeHarness();
  const tile = makeTile(0, 100_000, 1);
  const palette = activeUiTheme().channelColors;
  const first = activeWaveformThemeColors();
  for (const key of ["separator", "monochrome", "text"] as const) {
    const next = { ...first, [key]: "#123456" };
    harness.state.active = null;
    harness.state.viewportActive = null;
    requestWaveLayerRender(harness.state, tile, 1_200, 400, rows, insets, false, 1, palette, first);
    requestViewportRender(harness.state, tile, 1_200, 400, rows, insets, false, 0, 1_000, 1, palette, first);
    requestWaveLayerRender(harness.state, tile, 1_200, 400, rows, insets, false, 1, palette, { ...first });
    requestViewportRender(harness.state, tile, 1_200, 400, rows, insets, false, 0, 1_000, 1, palette, { ...first });
    assert.equal(harness.state.queued, null);
    assert.equal(harness.state.viewportQueued, null);
    requestWaveLayerRender(harness.state, tile, 1_200, 400, rows, insets, false, 1, palette, next);
    requestViewportRender(harness.state, tile, 1_200, 400, rows, insets, false, 0, 1_000, 1, palette, next);
    assert.deepEqual(harness.state.queued?.themeColors, next);
    assert.deepEqual(harness.state.viewportQueued?.themeColors, next);
    assert.equal(sameWaveformThemeColors(first, next), false, `${key} invalidates cached render colors`);
  }
});
