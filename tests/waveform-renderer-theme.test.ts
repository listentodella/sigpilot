import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { getSaleaeGraphChannelLayout } from "../src/lib/saleaeGraphLayout.ts";
import { activeWaveformThemeColors, channelColorForPalette, getUiTheme } from "../src/lib/themes.ts";

// Execute the real Worker in an isolated realm, as in the browser. Record the
// Canvas2D fallback's draw calls, not just the request payload. WebGL and this
// fallback share channelDraws, which resolves the physical channel's color.
function makeRenderer(accelerated = false) {
  const replies: Array<{ type: string; bitmap?: { strokes: string[]; fills: string[]; uniforms: number[][] }; message?: string }> = [];
  class RecordingCanvas {
    width: number;
    height: number;
    strokes: string[] = [];
    fills: string[] = [];
    uniforms: number[][] = [];
    gl = new Proxy({
      getParameter: () => 4096,
      getShaderParameter: () => true,
      getProgramParameter: () => true,
      getUniformLocation: (_program: unknown, name: string) => name,
      clear: () => { this.uniforms = []; },
      uniform4f: (name: string, ...values: number[]) => {
        if (name === "uColor") this.uniforms.push(values);
      },
    }, {
      get: (target, name) => name in target ? target[name as keyof typeof target] :
        (String(name).toUpperCase() === name ? 1 : () => ({})),
    });
    context = {
      strokeStyle: "",
      fillStyle: "",
      lineWidth: 1,
      clearRect: () => { this.strokes = []; this.fills = []; },
      beginPath: () => {},
      moveTo: () => {},
      lineTo: () => {},
      stroke: () => { this.strokes.push(this.context.strokeStyle); },
      fillRect: () => { this.fills.push(this.context.fillStyle); },
    };
    constructor(width: number, height: number) { this.width = width; this.height = height; }
    getContext(kind: string) { return kind === "2d" ? this.context : accelerated && kind === "webgl2" ? this.gl : null; }
    transferToImageBitmap() { return { strokes: [...this.strokes], fills: [...this.fills], uniforms: this.uniforms.map((color) => [...color]) }; }
  }
  const scope = {
    onmessage: null as null | ((event: { data: object }) => void),
    postMessage: (reply: typeof replies[number]) => { replies.push(reply); },
  };
  const source = readFileSync(new URL("../src/workers/waveformRenderer.worker.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  vm.runInNewContext(compiled, {
    self: scope,
    OffscreenCanvas: RecordingCanvas,
    exports: {},
    console: { warn: () => {}, error: () => {} },
    require: (name: string) => {
      if (name === "../lib/saleaeGraphLayout") return { getSaleaeGraphChannelLayout };
      if (name === "../lib/themes") return { channelColorForPalette };
      throw new Error(`Unexpected Worker import: ${name}`);
    },
  });
  return {
    send: (request: object) => {
      assert.ok(scope.onmessage);
      scope.onmessage({ data: request });
      const reply = replies.at(-1);
      assert.equal(reply?.type, "rendered", reply?.message);
      assert.ok(reply?.bitmap);
      return reply.bitmap;
    },
  };
}

function tileRequest(channelColors: readonly string[]) {
  return {
    type: "render", id: 1, width: 100, height: 200, dpr: 1,
    channelColors, matchChannelColors: true, rowHeights: [100, 100], rowTopInsets: [0, 0],
    themeColors: activeWaveformThemeColors(),
    tileStart: 0, tileSamples: 100, samplesPerPixel: 100, packedBins: null,
    // D9 occupies the second visible row: colors must use physical ID, not row.
    channels: [0, 9].map((channel) => ({
      channel, binCount: 0, binOffset: -1, hasExactSegments: false,
      bins: [{ first: true, last: false, has_high: true, has_low: true,
        edges: 4, first_edge_offset: 10, last_edge_offset: 90 }],
    })),
  };
}

function rgba(hex: string) {
  return `rgba(${parseInt(hex.slice(1, 3), 16)},${parseInt(hex.slice(3, 5), 16)},${parseInt(hex.slice(5, 7), 16)},1)`;
}

test("real Worker paints dense bins using the supplied theme and physical channel IDs", () => {
  const renderer = makeRenderer();
  for (const themeId of ["saleae-dark", "midnight-aurora", "lab-light"]) {
    const palette = getUiTheme(themeId).channelColors;
    const bitmap = renderer.send(tileRequest(palette));
    assert.deepEqual(Array.from(bitmap.fills), [rgba(palette[0]), rgba(palette[1])]);
  }
});

test("real Worker recolors retained bins on transform and preserves color-match opt-out", () => {
  const renderer = makeRenderer();
  renderer.send(tileRequest(getUiTheme("saleae-dark").channelColors));
  const request = {
    type: "transform", id: 2, width: 100, height: 200, dpr: 1,
    channelColors: ["#123456", "#abcdef"], matchChannelColors: true,
    themeColors: activeWaveformThemeColors(),
    rowHeights: [100, 100], rowTopInsets: [0, 0], viewStart: 0, viewSamples: 100,
  };
  const recolored = renderer.send(request);
  assert.deepEqual(Array.from(recolored.fills), [rgba("#123456"), rgba("#abcdef")]);
  const monochrome = renderer.send({ ...request, id: 3, matchChannelColors: false });
  assert.deepEqual(Array.from(monochrome.fills), [rgba(request.themeColors.monochrome), rgba(request.themeColors.monochrome)]);
});

test("real Worker uses explicit separator and monochrome colors for tiles and retained transforms", () => {
  const renderer = makeRenderer();
  const request = {
    ...tileRequest(["#ffffff"]), matchChannelColors: false,
    themeColors: { ...activeWaveformThemeColors(), separator: "rgba(12,34,56,0.3)", monochrome: "#123456" },
  };
  const tile = renderer.send(request);
  assert.deepEqual(Array.from(tile.strokes.slice(0, 2)), [request.themeColors.separator, request.themeColors.separator]);
  assert.deepEqual(Array.from(tile.fills), [rgba("#123456"), rgba("#123456")]);
  const themeColors = { ...request.themeColors, separator: "#abcdef80", monochrome: "rgba(65,43,21,0.5)" };
  const viewport = renderer.send({
    ...request, type: "transform", id: 2, viewStart: 0, viewSamples: 100, themeColors,
  });
  assert.deepEqual(Array.from(viewport.strokes.slice(0, 2)), [themeColors.separator, themeColors.separator]);
  assert.deepEqual(Array.from(viewport.fills), ["rgba(65,43,21,0.5)", "rgba(65,43,21,0.5)"]);
});

test("WebGL separator uniforms and monochrome draws honor each request including alpha", () => {
  const renderer = makeRenderer(true);
  const request = {
    ...tileRequest(["#ffffff"]), matchChannelColors: false,
    themeColors: { ...activeWaveformThemeColors(), separator: "rgba(12,34,56,0.3)", monochrome: "#12345680" },
  };
  const tile = renderer.send(request);
  assert.deepEqual(Array.from(tile.uniforms, (color) => Array.from(color)), [
    [12 / 255, 34 / 255, 56 / 255, 0.3],
    [18 / 255, 52 / 255, 86 / 255, 128 / 255],
    [18 / 255, 52 / 255, 86 / 255, 128 / 255],
  ]);
  const viewport = renderer.send({
    ...request, type: "transform", id: 2, viewStart: 0, viewSamples: 100,
    themeColors: { ...request.themeColors, separator: "#abc", monochrome: "rgb(65,43,21)" },
  });
  assert.deepEqual(Array.from(viewport.uniforms, (color) => Array.from(color)), [
    [170 / 255, 187 / 255, 204 / 255, 1],
    [65 / 255, 43 / 255, 21 / 255, 1],
    [65 / 255, 43 / 255, 21 / 255, 1],
  ]);
});
