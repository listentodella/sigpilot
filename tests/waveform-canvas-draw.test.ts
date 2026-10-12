import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import * as themes from "../src/lib/themes.ts";
import * as layout from "../src/lib/saleaeGraphLayout.ts";
import * as timing from "../src/lib/saleaeTimingDisplay.ts";
import * as coverage from "../src/lib/waveformTileCoverage.ts";
import * as workerPipeline from "../src/lib/waveLayerWorker.ts";

function harness() {
  const strokes: string[] = [], fills: string[] = [], images: unknown[] = [];
  const effects: Array<() => void | (() => void)> = [];
  let cleanups: Array<void | (() => void)> = [];
  const frames = new Map<number, () => void>();
  let nextFrameId = 1;
  const resizeObservers: Array<{ callback: (entries: any[]) => void; active: boolean }> = [];
  const host = { parentElement: { addEventListener() {}, removeEventListener() {} },
    addEventListener() {}, removeEventListener() {} };
  const canvas: any = { width: 800, height: 200 };
  const context: any = { canvas, clearRect() {}, fillRect() { fills.push(this.fillStyle); },
    save() {}, restore() {}, setLineDash() {}, beginPath() {}, moveTo() {}, lineTo() {},
    stroke() { strokes.push(this.strokeStyle); }, fillText() {}, drawImage(image: unknown) { images.push(image); },
  };
  canvas.getContext = () => context;
  class Path { moveTo() {} lineTo() {} }
  const source = readFileSync(new URL("../src/components/WaveformCanvas.tsx", import.meta.url), "utf8");
  const compiled = ts.transpileModule(`${source}\nexport { draw };`, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  const exports: any = {};
  vm.runInNewContext(compiled.replaceAll("import.meta.url", '"file:///unused-worker-url"'), {
    exports, Path2D: Path, window: { devicePixelRatio: 1, clearTimeout() {} }, devicePixelRatio: 1,
    requestAnimationFrame(callback: () => void) {
      const id = nextFrameId++;
      frames.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id: number) { frames.delete(id); },
    ResizeObserver: class {
      callback: (entries: any[]) => void;
      active = false;
      constructor(callback: (entries: any[]) => void) { this.callback = callback; resizeObservers.push(this); }
      observe() { this.active = true; }
      disconnect() { this.active = false; }
    },
    document: { createElement: () => canvas, addEventListener() {}, removeEventListener() {} },
    require(name: string) {
      if (name === "react") return {
        useEffect: (effect: () => void | (() => void)) => effects.push(effect),
        useRef: (current: unknown) => ({ current }),
        useState: (initial: unknown) => [initial, () => {}],
      };
      if (name === "react/jsx-runtime") {
        const jsx = (type: string, props: any) => {
          if (props.ref) props.ref.current = type === "canvas" ? canvas : host;
          return { type, props };
        };
        return { jsx, jsxs: jsx };
      }
      if (name === "../lib/useFrameState") return { useSessionFrameState: () => null };
      if (name === "../lib/viewportStore") return { writeSessionViewport() {}, clearSessionViewport() {} };
      if (name === "../lib/themes") return themes;
      if (name === "../lib/saleaeGraphLayout") return layout;
      if (name === "../lib/saleaeTimingDisplay") return timing;
      if (name === "../lib/waveformTileCoverage") return coverage;
      if (name === "../lib/waveLayerWorker") return workerPipeline;
      if (name === "../lib/waveformDrawProbe") return { recordWaveformDraw() {} };
      return {};
    },
  });
  const cache = { current: null as any };
  const viewportCache = { current: null as any };
  return { strokes, fills, images, cache, viewportCache,
    mount() {
      exports.WaveformCanvas({ sessionId: "strict-replay", rowHeights: [100], rowTopInsets: [0], tile,
        sampleRateHz: 1_000_000, totalSamples: 100, viewportStart: 0, viewportSamples: 100,
        onWidthChange() {}, onViewportChange() {} });
      cleanups = effects.map((effect) => effect());
    },
    replayEffects() {
      cleanups.forEach((cleanup) => cleanup?.());
      cleanups = effects.map((effect) => effect());
    },
    resize() {
      resizeObservers.filter((observer) => observer.active).forEach((observer) =>
        observer.callback([{ contentRect: { width: 800, height: 200 } }]));
    },
    flushFrames() {
      const pending = [...frames.values()];
      frames.clear();
      pending.forEach((callback) => callback());
    },
    pendingFrames: () => frames.size,
    unmount() { cleanups.forEach((cleanup) => cleanup?.()); },
    draw(tile: any, worker: any = null, matchChannelColors = true) {
    exports.draw(canvas, tile, 0, tile.sample_count, null, 1_000_000, 0, true, [100], [0], matchChannelColors,
      cache, viewportCache, { current: worker }, { current: null });
  } };
}
const tile = {
  pixels: 800, start_sample: 0, sample_count: 100, samples_per_pixel: 1,
  channels: [{ channel: 0, bins: [], segments: [{ start_sample: 0, end_sample: 50, high: false }, { start_sample: 50, end_sample: 100, high: true }] }],
};

test("actual capture canvas draws grid and exact waveforms with the default theme", () => {
  themes.setActiveUiTheme(themes.getUiTheme("saleae-dark"));
  const renderer = harness();
  renderer.draw(tile);
  assert.ok(renderer.fills.includes(themes.activeWaveformThemeColors().background));
  assert.ok(renderer.strokes.includes(themes.activeWaveformThemeColors().gridPrimary));
  assert.ok(renderer.strokes.includes(themes.activeThemeChannelColor(0)));
});

test("actual capture canvas draws while a worker request is in flight", () => {
  const renderer = harness();
  const messages: any[] = [];
  renderer.draw(tile, { active: null, queued: null, viewportActive: null, viewportQueued: null, nextId: 1, failed: false,
    worker: { postMessage: (message: any) => messages.push(message) } });
  assert.equal(messages[0].type, "render");
  assert.ok(renderer.strokes.includes(themes.activeThemeChannelColor(0)));
});

const denseTile = {
  pixels: 800, start_sample: 0, sample_count: 8000, samples_per_pixel: 10,
  channels: [{ channel: 0, segments: [], bins: [{
    first: true, last: false, has_high: true, has_low: true,
    edges: 4, first_edge_offset: 1, last_edge_offset: 9,
  }] }],
};

function pendingWorker() {
  const messages: any[] = [];
  return { messages, state: { active: null, queued: null, viewportActive: null, viewportQueued: null,
    nextId: 1, failed: false, worker: { postMessage: (message: any) => messages.push(message) } } };
}

test("dense capture remains visible before the first worker bitmap arrives", () => {
  themes.setActiveUiTheme(themes.getUiTheme("saleae-dark"));
  const renderer = harness();
  const worker = pendingWorker();
  renderer.draw(denseTile, worker.state);
  assert.equal(worker.messages[0].type, "render");
  assert.ok(renderer.fills.some((color) => color !== themes.activeWaveformThemeColors().background),
    "aggregated bins must be painted while the worker is pending");
});

test("theme-invalidated dense caches are repainted immediately, including monochrome mode", () => {
  for (const matchChannelColors of [true, false]) {
    themes.setActiveUiTheme(themes.getUiTheme("saleae-dark"));
    const renderer = harness();
    const oldBitmap = {};
    renderer.cache.current = {
      canvas: oldBitmap, tile: denseTile, width: 800, height: 200,
      rowHeights: [100], rowTopInsets: [0], matchChannelColors,
      channelColors: themes.activeUiTheme().channelColors, themeColors: themes.activeWaveformThemeColors(),
    };
    themes.setActiveUiTheme(themes.getUiTheme("lab-light"), { D0: "#123456" });
    const worker = pendingWorker();
    renderer.draw(denseTile, worker.state, matchChannelColors);
    const color = matchChannelColors ? "#123456" : themes.activeWaveformThemeColors().monochrome;
    assert.ok(renderer.strokes.includes(color), "paint bins in the current theme without waiting for the worker");
    assert.ok(renderer.fills.some((fill) => fill !== themes.activeWaveformThemeColors().background));
    assert.equal(renderer.images.length, 0, "do not display the old theme bitmap");
    assert.equal(worker.messages[0].channelColors[0], "#123456");
  }
  themes.setActiveUiTheme(themes.getUiTheme("saleae-dark"));
});

test("packed binary bins remain visible while a worker render is pending", () => {
  themes.setActiveUiTheme(themes.getUiTheme("saleae-dark"));
  const bytes = new Uint8Array(16);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 1 | 4 | 8, true);
  view.setUint32(4, 4, true);
  view.setUint32(8, 1, true);
  view.setUint32(12, 9, true);
  const packedTile = { ...denseTile, channels: [{ ...denseTile.channels[0], bins: [], packed_bins: bytes }] };
  const renderer = harness();
  const worker = pendingWorker();
  renderer.draw(packedTile, worker.state);
  assert.ok(renderer.fills.some((color) => color !== themes.activeWaveformThemeColors().background));
  assert.deepEqual(worker.messages[0].packedBins, bytes, "fallback must not detach or mutate capture bins");
});

test("a matching dense raster still uses the cached worker bitmap", () => {
  themes.setActiveUiTheme(themes.getUiTheme("saleae-dark"));
  const renderer = harness();
  const bitmap = {};
  renderer.cache.current = {
    canvas: bitmap, tile: denseTile, width: 800, height: 200,
    rowHeights: [100], rowTopInsets: [0], matchChannelColors: true,
    channelColors: themes.activeUiTheme().channelColors, themeColors: themes.activeWaveformThemeColors(),
  };
  const worker = pendingWorker();
  renderer.draw(denseTile, worker.state);
  assert.deepEqual(renderer.images, [bitmap]);
  assert.equal(worker.messages.length, 0);
  assert.deepEqual(renderer.fills, [themes.activeWaveformThemeColors().background]);
});

test("StrictMode effect replay releases cancelled frames and draws after remount", () => {
  themes.setActiveUiTheme(themes.getUiTheme("saleae-dark"));
  const renderer = harness();
  renderer.mount();
  assert.equal(renderer.pendingFrames(), 1, "theme effect schedules the first draw");
  // React reuses refs during StrictMode's setup -> cleanup -> setup replay.
  // Replay before the first RAF executes, just as the browser does on mount.
  renderer.replayEffects();
  renderer.resize();
  assert.equal(renderer.pendingFrames(), 1, "a cancelled RAF must not block a new draw");
  renderer.flushFrames();
  assert.ok(renderer.fills.includes(themes.activeWaveformThemeColors().background));
  assert.ok(renderer.strokes.includes(themes.activeThemeChannelColor(0)));
  renderer.resize();
  assert.equal(renderer.pendingFrames(), 1, "later redraws continue to schedule");
  renderer.unmount();
  assert.equal(renderer.pendingFrames(), 0, "unmount cancels outstanding draws");
});
