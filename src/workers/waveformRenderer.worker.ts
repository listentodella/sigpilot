import {
  getSaleaeGraphChannelLayout,
  type SaleaeGraphChannelLayout,
} from "../lib/saleaeGraphLayout";
import { saleaeLegacyChannelColor } from "../lib/saleaeChannelColors";

// Packed digital bins are 16 bytes: flags, edge count, first edge offset,
// last edge offset. That maps 1:1 onto one RGBA32UI texel, so the GPU can read
// a bin with a single texelFetch and the CPU never has to unpack it.
const packedDigitalBinBytes = 16;
const uint32PerBin = packedDigitalBinBytes / 4;
const digitalGraphGutterPx = 8;
const noEdgeOffset = 0xffffffff;

// Each bin expands on the GPU into five candidate quads:
//   0: dense fill, or a flat level line
//   1: precise pulse left leg
//   2: precise pulse riser
//   3: precise pulse right leg
//   4: level transition from the previous bin
// Quads that do not apply collapse to zero area, so a bin always costs a fixed
// 30 vertices and the CPU never branches per bin.
const quadsPerBin = 5;
const verticesPerQuad = 6;
const verticesPerBin = quadsPerBin * verticesPerQuad;

const separatorAlpha = 0.075;
// Logic fills a ONE_OR_MORE_TRANSITIONS run at full opacity (see
// `DigitalCanvas.tsx` in the recovered source). A translucent fill makes a
// busy region look washed out and its vertical edges muddy.
const denseFillAlpha = 1;

// A worker has no `invoke`, so anything it writes to the console dies with the
// worker's devtools session and never reaches the log file. Forwarding through
// `postMessage` lets the main thread put it in the record alongside everything
// else, which is the whole point of the diagnostics export.
//
// The pass is attached because a bare renderer message says nothing about which
// draw produced it: tiles and viewports share every code path below this.
const nativeWarn = console.warn.bind(console);
const nativeError = console.error.bind(console);
console.warn = (...args: unknown[]) => {
  nativeWarn(...args);
  self.postMessage({ level: "warn", message: describePass(args), type: "log" });
};
console.error = (...args: unknown[]) => {
  nativeError(...args);
  self.postMessage({ level: "error", message: describePass(args), type: "log" });
};

let currentPass = "startup";

function describePass(args: unknown[]) {
  return `[${currentPass}] ${describe(args)}`;
}

function describe(args: unknown[]) {
  return args
    .map((arg) => (arg instanceof Error ? (arg.stack ?? arg.message) : String(arg)))
    .join(" ");
}

interface WorkerBin {
  edges: number;
  first: boolean;
  first_edge_offset: number | null;
  has_high: boolean;
  has_low: boolean;
  last: boolean;
}

interface WorkerChannel {
  // `binOffset` is a bin index into the shared packed texture. A negative value
  // marks a channel that arrived as JSON bins and still needs packing.
  binCount: number;
  binOffset: number;
  bins: WorkerBin[] | null;
  channel: number;
  hasExactSegments: boolean;
}

interface TileRenderRequest {
  type: "render";
  channels: WorkerChannel[];
  dpr: number;
  height: number;
  id: number;
  matchChannelColors: boolean;
  packedBins: Uint8Array | null;
  rowHeights: number[];
  rowTopInsets: number[];
  samplesPerPixel: number;
  tileSamples: number;
  tileStart: number;
  width: number;
}

interface ViewportRenderRequest {
  type: "transform";
  dpr: number;
  height: number;
  id: number;
  matchChannelColors: boolean;
  rowHeights: number[];
  rowTopInsets: number[];
  viewSamples: number;
  viewStart: number;
  width: number;
}

type RenderRequest = TileRenderRequest | ViewportRenderRequest;

interface RenderResponse {
  bitmap: ImageBitmap;
  id: number;
  kind: LayerKind;
  type: "rendered";
}

interface ErrorResponse {
  id: number;
  kind: LayerKind;
  message: string;
  type: "renderError";
}

type LayerKind = "tile" | "viewport";

// ---------------------------------------------------------------------------
// Retained layer
// ---------------------------------------------------------------------------

interface RetainedLayer {
  channels: WorkerChannel[];
  packedBins: Uint32Array | null;
  packedBinCount: number;
  samplesPerPixel: number;
  tileSamples: number;
  tileStart: number;
  version: number;
}

// `transform` requests re-render the tile that is already resident. Only the
// viewport uniforms change, so the bins stay on the GPU and no Rust round trip
// is needed while the user pans or zooms inside the tile's coverage.
let retainedLayer: RetainedLayer | null = null;
let layerVersion = 0;

// ---------------------------------------------------------------------------
// Job queue
// ---------------------------------------------------------------------------

let pendingTile: TileRenderRequest | null = null;
let pendingViewport: ViewportRenderRequest | null = null;
let draining = false;

self.onmessage = (event: MessageEvent<RenderRequest>) => {
  const request = event.data;
  if (!request || request.width <= 0 || request.height <= 0) return;
  if (request.type === "render") {
    pendingTile = request;
  } else if (request.type === "transform") {
    // Viewport renders coalesce to the newest request so a fast zoom gesture
    // never queues a backlog of stale frames.
    pendingViewport = request;
  } else {
    return;
  }
  drainQueue();
};

function drainQueue() {
  if (draining) return;
  draining = true;
  try {
    // Tile renders carry new data and always win; viewport renders are the
    // cheap refinement that follows.
    while (pendingTile || pendingViewport) {
      if (pendingTile) {
        const request = pendingTile;
        pendingTile = null;
        runTileRender(request);
        continue;
      }
      const request = pendingViewport;
      pendingViewport = null;
      if (request) runViewportRender(request);
    }
  } finally {
    draining = false;
  }
}

function runTileRender(request: TileRenderRequest) {
  // The pass label is set before the renderer is built: constructing the
  // fallback is itself a `console.warn`, and it belongs to the draw that asked
  // for it. `tile`/`viewport` plus the request id and size is enough to find the
  // draw in a trace.
  currentPass = `tile#${request.id} ${request.width}x${request.height}`;
  const renderer = rendererFor("tile");
  if (!renderer) return;
  try {
    postRendered("tile", request.id, renderer.renderTile(request));
  } catch (error) {
    postRenderError("tile", request.id, error);
  }
}

function runViewportRender(request: ViewportRenderRequest) {
  currentPass = `viewport#${request.id} ${request.width}x${request.height}`;
  const renderer = rendererFor("viewport");
  if (!renderer) return;
  try {
    postRendered("viewport", request.id, renderer.renderViewport(request));
  } catch (error) {
    postRenderError("viewport", request.id, error);
  }
}

function postRendered(kind: LayerKind, id: number, bitmap: ImageBitmap) {
  const response: RenderResponse = { bitmap, id, kind, type: "rendered" };
  self.postMessage(response, { transfer: [bitmap] });
}

function postRenderError(kind: LayerKind, id: number, error: unknown) {
  const response: ErrorResponse = {
    id,
    kind,
    message: error instanceof Error ? error.message : String(error),
    type: "renderError",
  };
  self.postMessage(response);
}

// ---------------------------------------------------------------------------
// Renderer selection
// ---------------------------------------------------------------------------

interface LayerRenderer {
  renderTile(request: TileRenderRequest): ImageBitmap;
  renderViewport(request: ViewportRenderRequest): ImageBitmap;
}

const renderers: Partial<Record<LayerKind, LayerRenderer>> = {};
let acceleratedUnavailable = false;

function rendererFor(kind: LayerKind): LayerRenderer | null {
  const existing = renderers[kind];
  if (existing) return existing;
  if (typeof OffscreenCanvas === "undefined") return null;
  if (!acceleratedUnavailable) {
    try {
      const renderer = new WebGlLayerRenderer();
      renderers[kind] = renderer;
      return renderer;
    } catch (error) {
      // WebKit builds without worker WebGL2 fall back to the software path
      // instead of losing waveform rendering entirely.
      console.warn("WebGL2 waveform renderer unavailable, using canvas2d", error);
      acceleratedUnavailable = true;
    }
  }
  const fallback = new Canvas2dLayerRenderer();
  renderers[kind] = fallback;
  return fallback;
}

// ---------------------------------------------------------------------------
// Shared geometry and packing
// ---------------------------------------------------------------------------

interface ChannelGeometry {
  highY: number;
  lowY: number;
  separatorY: number;
}

interface ChannelDraw {
  binCount: number;
  binOffset: number;
  color: [number, number, number, number];
  highY: number;
  lowY: number;
}

interface LayoutArgs {
  dpr: number;
  matchChannelColors: boolean;
  rowHeights: number[];
  rowTopInsets: number[];
}

function channelDraws(args: LayoutArgs, channels: WorkerChannel[]) {
  const layouts = getSaleaeGraphChannelLayout(
    args.rowHeights,
    channels.length,
    args.dpr,
    args.rowTopInsets,
  );
  const draws: ChannelDraw[] = [];
  const separators: number[] = [];
  channels.forEach((channel, index) => {
    const layout = layouts[index];
    const geometry = geometryForLayout(layout, args.dpr);
    separators.push(geometry.separatorY);
    if (channel.hasExactSegments || channel.binCount <= 0) return;
    draws.push({
      binCount: channel.binCount,
      binOffset: channel.binOffset,
      color: colorToRgba(
        args.matchChannelColors ? saleaeLegacyChannelColor(channel.channel) : "#ffffff",
      ),
      highY: geometry.highY,
      lowY: geometry.lowY,
    });
  });
  return { draws, separators };
}

function geometryForLayout(layout: SaleaeGraphChannelLayout, dpr: number): ChannelGeometry {
  const gutter = Math.min(digitalGraphGutterPx * dpr, Math.max(0, (layout.height - 2 * dpr) / 2));
  const highY = layout.top + gutter + 0.5 * dpr;
  const transitionHeight = Math.max(dpr, Math.round(layout.height - 2 * gutter));
  return {
    highY,
    lowY: highY + transitionHeight - dpr,
    separatorY: Math.floor(layout.outerTop) + 0.5,
  };
}

function colorToRgba(color: string): [number, number, number, number] {
  const hex = color.trim();
  if (hex.startsWith("#")) {
    const body = hex.slice(1);
    if (body.length === 3) {
      return [
        Number.parseInt(body[0] + body[0], 16) / 255,
        Number.parseInt(body[1] + body[1], 16) / 255,
        Number.parseInt(body[2] + body[2], 16) / 255,
        1,
      ];
    }
    if (body.length >= 6) {
      return [
        Number.parseInt(body.slice(0, 2), 16) / 255,
        Number.parseInt(body.slice(2, 4), 16) / 255,
        Number.parseInt(body.slice(4, 6), 16) / 255,
        1,
      ];
    }
  }
  return [1, 1, 1, 1];
}

function rgbaCss(color: [number, number, number, number], alpha: number) {
  return `rgba(${Math.round(color[0] * 255)},${Math.round(color[1] * 255)},${Math.round(
    color[2] * 255,
  )},${alpha})`;
}

// The binary frame path already hands over packed bins laid out back to back.
// Channels that arrived as JSON bins are packed here, once, so the GPU path can
// treat every channel identically and no per-bin work survives past this call.
function prepareBins(channels: WorkerChannel[], packed: Uint8Array | null): Uint32Array | null {
  const packedView = packed
    ? new Uint32Array(packed.buffer, packed.byteOffset, Math.floor(packed.byteLength / uint32PerBin))
    : null;
  const packedBinCount = packedView ? Math.floor(packedView.length / uint32PerBin) : 0;

  let legacyBinCount = 0;
  for (const channel of channels) {
    if (channel.binOffset < 0) legacyBinCount += channel.bins?.length ?? 0;
  }
  if (packedBinCount === 0 && legacyBinCount === 0) return null;

  const combined = new Uint32Array((packedBinCount + legacyBinCount) * uint32PerBin);
  if (packedView) combined.set(packedView, 0);

  let cursor = packedBinCount;
  for (const channel of channels) {
    if (channel.binOffset >= 0) continue;
    const bins = channel.bins;
    channel.binOffset = cursor;
    channel.binCount = bins?.length ?? 0;
    if (!bins) continue;
    for (const bin of bins) {
      const base = cursor * uint32PerBin;
      combined[base] =
        (bin.first ? 1 : 0) |
        (bin.last ? 2 : 0) |
        (bin.has_high ? 4 : 0) |
        (bin.has_low ? 8 : 0);
      combined[base + 1] = bin.edges >>> 0;
      combined[base + 2] = bin.first_edge_offset == null ? noEdgeOffset : bin.first_edge_offset >>> 0;
      combined[base + 3] = noEdgeOffset;
      cursor += 1;
    }
  }
  return combined;
}

function retainTile(request: TileRenderRequest, bins: Uint32Array | null) {
  layerVersion += 1;
  retainedLayer = {
    channels: request.channels,
    packedBins: bins,
    packedBinCount: bins ? Math.floor(bins.length / uint32PerBin) : 0,
    samplesPerPixel: request.samplesPerPixel,
    tileSamples: request.tileSamples,
    tileStart: request.tileStart,
    version: layerVersion,
  };
  return retainedLayer;
}

function requireRetainedLayer() {
  if (!retainedLayer) throw new Error("no retained layer for viewport render");
  return retainedLayer;
}

// ---------------------------------------------------------------------------
// WebGL2 renderer
// ---------------------------------------------------------------------------

const waveVertexSource = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;

uniform usampler2D uBins;
uniform int uBinsWidth;
uniform int uBinBase;
uniform float uX0Base;
uniform float uBinWidth;
uniform float uSamplesPerPixel;
uniform float uHighY;
uniform float uLowY;
uniform float uLineWidth;
uniform vec2 uResolution;

in vec2 aCorner;

out float vAlpha;

const uint FLAG_FIRST = 1u;
const uint FLAG_LAST = 2u;
const uint FLAG_HIGH = 4u;
const uint FLAG_LOW = 8u;
const uint NO_EDGE_OFFSET = 0xffffffffu;

uvec4 readBin(int index) {
  return texelFetch(uBins, ivec2(index % uBinsWidth, index / uBinsWidth), 0);
}

void main() {
  int quad = gl_VertexID / 6;
  int bin = gl_InstanceID;
  vec2 unit = aCorner;

  uvec4 self = readBin(uBinBase + bin);
  uint flags = self.x;
  uint edgeCount = self.y;
  uint firstEdgeOffset = self.z;

  bool isFirst = (flags & FLAG_FIRST) != 0u;
  bool isLast = (flags & FLAG_LAST) != 0u;
  bool hasHigh = (flags & FLAG_HIGH) != 0u;
  bool hasLow = (flags & FLAG_LOW) != 0u;

  bool prevLast = false;
  bool prevDense = false;
  if (bin > 0) {
    uvec4 prev = readBin(uBinBase + bin - 1);
    prevLast = (prev.x & FLAG_LAST) != 0u;
    prevDense = (prev.x & FLAG_HIGH) != 0u && (prev.x & FLAG_LOW) != 0u;
  }

  float x0 = uX0Base + float(bin) * uBinWidth;
  float x1 = x0 + uBinWidth;
  float yFirst = isFirst ? uHighY : uLowY;
  float yLast = isLast ? uHighY : uLowY;
  float halfWidth = uLineWidth * 0.5;

  bool pulse = hasHigh && hasLow && edgeCount <= 1u && firstEdgeOffset != NO_EDGE_OFFSET;
  bool dense = hasHigh && hasLow && !pulse;
  // A riser is only needed between two constant-level bins, where the two level
  // lines would otherwise not connect. When either side is a dense bin its fill
  // already spans the lane, and drawing a line at every bin boundary turns a
  // busy region into a striped block instead of a solid one.
  bool transition = bin > 0 && prevLast != isFirst && !dense && !prevDense;

  vec2 position = vec2(x0, yFirst);
  vAlpha = 0.0;

  if (quad == 0) {
    if (dense) {
      // Span the level lines' outer edges, the way Logic's transition rect does:
      // stopping at the line centres leaves a hairline gap along the block.
      float top = min(uHighY, uLowY) - halfWidth;
      float bottom = max(uHighY, uLowY) + halfWidth;
      position = vec2(mix(x0, x1, unit.x), mix(top, bottom, unit.y));
      vAlpha = ${denseFillAlpha.toFixed(2)};
    } else if (!pulse) {
      position = vec2(mix(x0, x1, unit.x), mix(yFirst - halfWidth, yFirst + halfWidth, unit.y));
      vAlpha = 1.0;
    }
  } else if (pulse) {
    float edgeX = x0 + (float(firstEdgeOffset) / max(uSamplesPerPixel, 1.0)) * uBinWidth;
    if (quad == 1) {
      position = vec2(mix(x0, edgeX, unit.x), mix(yFirst - halfWidth, yFirst + halfWidth, unit.y));
    } else if (quad == 2) {
      position = vec2(mix(edgeX - halfWidth, edgeX + halfWidth, unit.x), mix(yFirst, yLast, unit.y));
    } else if (quad == 3) {
      position = vec2(mix(edgeX, x1, unit.x), mix(yLast - halfWidth, yLast + halfWidth, unit.y));
    }
    vAlpha = 1.0;
  } else if (quad == 4 && transition) {
    float prevY = prevLast ? uHighY : uLowY;
    position = vec2(mix(x0 - halfWidth, x0 + halfWidth, unit.x), mix(prevY, yFirst, unit.y));
    vAlpha = 1.0;
  }

  vec2 clip = vec2(
    position.x / uResolution.x * 2.0 - 1.0,
    1.0 - position.y / uResolution.y * 2.0
  );
  gl_Position = vec4(clip, 0.0, 1.0);
}
`;

const waveFragmentSource = `#version 300 es
precision highp float;

uniform vec4 uColor;

in float vAlpha;

out vec4 fragColor;

void main() {
  float alpha = uColor.a * vAlpha;
  fragColor = vec4(uColor.rgb * alpha, alpha);
}
`;

const solidVertexSource = `#version 300 es
precision highp float;

uniform vec2 uResolution;

in vec2 aCorner;
in vec4 aRect;

void main() {
  vec2 position = aRect.xy + aCorner * aRect.zw;
  vec2 clip = vec2(
    position.x / uResolution.x * 2.0 - 1.0,
    1.0 - position.y / uResolution.y * 2.0
  );
  gl_Position = vec4(clip, 0.0, 1.0);
}
`;

const solidFragmentSource = `#version 300 es
precision highp float;

uniform vec4 uColor;

out vec4 fragColor;

void main() {
  float alpha = uColor.a;
  fragColor = vec4(uColor.rgb * alpha, alpha);
}
`;

function buildCornerTable() {
  const corners = [
    [0, 0],
    [1, 0],
    [0, 1],
    [0, 1],
    [1, 0],
    [1, 1],
  ];
  const table = new Float32Array(verticesPerBin * 2);
  for (let quad = 0; quad < quadsPerBin; quad += 1) {
    for (let corner = 0; corner < verticesPerQuad; corner += 1) {
      const slot = (quad * verticesPerQuad + corner) * 2;
      table[slot] = corners[corner][0];
      table[slot + 1] = corners[corner][1];
    }
  }
  return table;
}

const cornerTable = buildCornerTable();

interface DrawArgs {
  channels: WorkerChannel[];
  dpr: number;
  matchChannelColors: boolean;
  packedBins: Uint32Array | null;
  packedBinCount: number;
  rowHeights: number[];
  rowTopInsets: number[];
  samplesPerPixel: number;
  viewSamples: number;
  viewStart: number;
  width: number;
  height: number;
}

class WebGlLayerRenderer implements LayerRenderer {
  private readonly canvas: OffscreenCanvas;
  private readonly gl: WebGL2RenderingContext;
  private readonly waveProgram: WebGLProgram;
  private readonly solidProgram: WebGLProgram;
  private readonly waveVao: WebGLVertexArrayObject;
  private readonly solidVao: WebGLVertexArrayObject;
  private readonly rectBuffer: WebGLBuffer;
  private readonly maxTextureSize: number;
  private readonly waveUniforms: Record<string, WebGLUniformLocation | null>;
  private readonly solidUniforms: Record<string, WebGLUniformLocation | null>;
  private binsTexture: WebGLTexture | null = null;
  private binsTextureWidth = 1;
  private uploadedLayerVersion = -1;
  private uploadScratch = new Uint32Array(0);
  private separatorScratch = new Float32Array(0);

  constructor() {
    this.canvas = new OffscreenCanvas(1, 1);
    const gl = this.canvas.getContext("webgl2", {
      alpha: true,
      // Digital channels are drawn as 1.25px strokes. Without multisampling the
      // rasteriser snaps them to whole pixels, which is visibly harder than the
      // antialiased canvas2d output this renderer replaces.
      antialias: true,
      depth: false,
      desynchronized: true,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
      stencil: false,
    });
    if (!gl) throw new Error("webgl2 context unavailable");
    this.gl = gl;
    this.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;

    this.waveProgram = createProgram(gl, waveVertexSource, waveFragmentSource);
    this.solidProgram = createProgram(gl, solidVertexSource, solidFragmentSource);
    this.waveUniforms = collectUniforms(gl, this.waveProgram, [
      "uBins",
      "uBinsWidth",
      "uBinBase",
      "uX0Base",
      "uBinWidth",
      "uSamplesPerPixel",
      "uHighY",
      "uLowY",
      "uLineWidth",
      "uResolution",
      "uColor",
    ]);
    this.solidUniforms = collectUniforms(gl, this.solidProgram, ["uResolution", "uColor"]);

    const cornerBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, cornerBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, cornerTable, gl.STATIC_DRAW);

    this.waveVao = gl.createVertexArray();
    gl.bindVertexArray(this.waveVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, cornerBuffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.rectBuffer = gl.createBuffer();
    this.solidVao = gl.createVertexArray();
    gl.bindVertexArray(this.solidVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, cornerBuffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.rectBuffer);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.bindVertexArray(null);

    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.blendEquation(gl.FUNC_ADD);
    gl.clearColor(0, 0, 0, 0);
  }

  renderTile(request: TileRenderRequest): ImageBitmap {
    const channels = request.channels.map((channel) => ({ ...channel }));
    const bins = prepareBins(channels, request.packedBins);
    const layer = retainTile({ ...request, channels }, bins);
    return this.draw({
      channels: layer.channels,
      dpr: request.dpr,
      height: request.height,
      matchChannelColors: request.matchChannelColors,
      packedBins: layer.packedBins,
      packedBinCount: layer.packedBinCount,
      rowHeights: request.rowHeights,
      rowTopInsets: request.rowTopInsets,
      samplesPerPixel: layer.samplesPerPixel,
      viewSamples: layer.tileSamples,
      viewStart: layer.tileStart,
      width: request.width,
    });
  }

  renderViewport(request: ViewportRenderRequest): ImageBitmap {
    const layer = requireRetainedLayer();
    return this.draw({
      channels: layer.channels,
      dpr: request.dpr,
      height: request.height,
      matchChannelColors: request.matchChannelColors,
      packedBins: layer.packedBins,
      packedBinCount: layer.packedBinCount,
      rowHeights: request.rowHeights,
      rowTopInsets: request.rowTopInsets,
      samplesPerPixel: layer.samplesPerPixel,
      viewSamples: request.viewSamples,
      viewStart: request.viewStart,
      width: request.width,
    });
  }

  private draw(args: DrawArgs): ImageBitmap {
    const gl = this.gl;
    const { width, height } = args;
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    gl.viewport(0, 0, width, height);
    gl.clear(gl.COLOR_BUFFER_BIT);

    const { draws, separators } = channelDraws(
      {
        dpr: args.dpr,
        matchChannelColors: args.matchChannelColors,
        rowHeights: args.rowHeights,
        rowTopInsets: args.rowTopInsets,
      },
      args.channels,
    );

    this.drawSeparators(width, height, separators);

    const layer = retainedLayer;
    if (!args.packedBins || args.packedBinCount <= 0 || draws.length === 0 || !layer) {
      return this.canvas.transferToImageBitmap();
    }

    // Re-uploading only when the tile actually changed is what makes a viewport
    // transform O(1): pan and zoom become a uniform update plus one draw call.
    this.uploadBins(layer);

    const viewSamples = Math.max(Number.EPSILON, args.viewSamples);
    // x(sample) = ((sample - viewStart) / viewSamples) * width, so bin i starts
    // at originX + i * binWidth with both terms constant per frame.
    const originX = ((layer.tileStart - args.viewStart) / viewSamples) * width;
    const binWidth = (args.samplesPerPixel / viewSamples) * width;

    gl.useProgram(this.waveProgram);
    gl.bindVertexArray(this.waveVao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.binsTexture);
    gl.uniform1i(this.waveUniforms.uBins, 0);
    gl.uniform1i(this.waveUniforms.uBinsWidth, this.binsTextureWidth);
    gl.uniform1f(this.waveUniforms.uX0Base, originX);
    gl.uniform1f(this.waveUniforms.uBinWidth, binWidth);
    gl.uniform1f(
      this.waveUniforms.uSamplesPerPixel,
      Math.max(Number.EPSILON, args.samplesPerPixel),
    );
    // Logic draws level lines 1 CSS pixel tall; anything thicker softens the
    // edge the user is trying to line a cursor up with.
    gl.uniform1f(this.waveUniforms.uLineWidth, Math.max(args.dpr, 1));
    gl.uniform2f(this.waveUniforms.uResolution, width, height);

    for (const draw of draws) {
      gl.uniform1i(this.waveUniforms.uBinBase, draw.binOffset);
      gl.uniform1f(this.waveUniforms.uHighY, draw.highY);
      gl.uniform1f(this.waveUniforms.uLowY, draw.lowY);
      gl.uniform4f(
        this.waveUniforms.uColor,
        draw.color[0],
        draw.color[1],
        draw.color[2],
        draw.color[3],
      );
      gl.drawArraysInstanced(gl.TRIANGLES, 0, verticesPerBin, draw.binCount);
    }

    gl.bindVertexArray(null);
    return this.canvas.transferToImageBitmap();
  }

  private drawSeparators(width: number, height: number, separators: number[]) {
    if (separators.length === 0) return;
    const gl = this.gl;
    const needed = separators.length * 4;
    if (this.separatorScratch.length < needed) this.separatorScratch = new Float32Array(needed);
    const rects = this.separatorScratch;
    separators.forEach((y, index) => {
      rects[index * 4] = 0;
      rects[index * 4 + 1] = y;
      rects[index * 4 + 2] = width;
      rects[index * 4 + 3] = 1;
    });
    gl.useProgram(this.solidProgram);
    gl.bindVertexArray(this.solidVao);
    gl.uniform2f(this.solidUniforms.uResolution, width, height);
    gl.uniform4f(this.solidUniforms.uColor, 1, 1, 1, separatorAlpha);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.rectBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, rects.subarray(0, needed), gl.DYNAMIC_DRAW);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, verticesPerQuad, separators.length);
    gl.bindVertexArray(null);
  }

  private uploadBins(layer: RetainedLayer) {
    if (this.uploadedLayerVersion === layer.version && this.binsTexture) return;
    const gl = this.gl;
    const bins = layer.packedBins;
    if (!bins || layer.packedBinCount <= 0) {
      this.uploadedLayerVersion = layer.version;
      return;
    }
    const width = Math.min(layer.packedBinCount, this.maxTextureSize);
    const rows = Math.ceil(layer.packedBinCount / width);
    const texelCount = width * rows * uint32PerBin;
    if (this.uploadScratch.length !== texelCount) this.uploadScratch = new Uint32Array(texelCount);
    const scratch = this.uploadScratch;
    scratch.fill(0);
    scratch.set(bins.subarray(0, Math.min(bins.length, texelCount)));

    if (!this.binsTexture) {
      this.binsTexture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.binsTexture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    } else {
      gl.bindTexture(gl.TEXTURE_2D, this.binsTexture);
    }
    this.binsTextureWidth = width;
    this.uploadedLayerVersion = layer.version;
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA32UI,
      width,
      rows,
      0,
      gl.RGBA_INTEGER,
      gl.UNSIGNED_INT,
      scratch,
    );
  }
}

function createProgram(gl: WebGL2RenderingContext, vertexSource: string, fragmentSource: string) {
  const program = gl.createProgram();
  const vertex = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`program link failed: ${gl.getProgramInfoLog(program) ?? ""}`);
  }
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  return program;
}

function compileShader(gl: WebGL2RenderingContext, type: number, source: string) {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("shader allocation failed");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(`shader compile failed: ${gl.getShaderInfoLog(shader) ?? ""}`);
  }
  return shader;
}

function collectUniforms(gl: WebGL2RenderingContext, program: WebGLProgram, names: string[]) {
  const uniforms: Record<string, WebGLUniformLocation | null> = {};
  for (const name of names) uniforms[name] = gl.getUniformLocation(program, name);
  return uniforms;
}

// ---------------------------------------------------------------------------
// Canvas2D fallback
// ---------------------------------------------------------------------------

class Canvas2dLayerRenderer implements LayerRenderer {
  private readonly canvas: OffscreenCanvas;

  constructor() {
    this.canvas = new OffscreenCanvas(1, 1);
  }

  renderTile(request: TileRenderRequest): ImageBitmap {
    const channels = request.channels.map((channel) => ({ ...channel }));
    const bins = prepareBins(channels, request.packedBins);
    const layer = retainTile({ ...request, channels }, bins);
    return this.paint({
      channels: layer.channels,
      dpr: request.dpr,
      height: request.height,
      matchChannelColors: request.matchChannelColors,
      packedBins: layer.packedBins,
      rowHeights: request.rowHeights,
      rowTopInsets: request.rowTopInsets,
      samplesPerPixel: layer.samplesPerPixel,
      viewSamples: layer.tileSamples,
      viewStart: layer.tileStart,
      width: request.width,
    });
  }

  renderViewport(request: ViewportRenderRequest): ImageBitmap {
    const layer = requireRetainedLayer();
    return this.paint({
      channels: layer.channels,
      dpr: request.dpr,
      height: request.height,
      matchChannelColors: request.matchChannelColors,
      packedBins: layer.packedBins,
      rowHeights: request.rowHeights,
      rowTopInsets: request.rowTopInsets,
      samplesPerPixel: layer.samplesPerPixel,
      viewSamples: request.viewSamples,
      viewStart: request.viewStart,
      width: request.width,
    });
  }

  private paint(args: Omit<DrawArgs, "packedBinCount">): ImageBitmap {
    const { width, height } = args;
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    const context = this.canvas.getContext("2d");
    if (!context) throw new Error("canvas2d context unavailable");
    context.clearRect(0, 0, width, height);

    const { draws, separators } = channelDraws(
      {
        dpr: args.dpr,
        matchChannelColors: args.matchChannelColors,
        rowHeights: args.rowHeights,
        rowTopInsets: args.rowTopInsets,
      },
      args.channels,
    );

    context.strokeStyle = `rgba(255,255,255,${separatorAlpha})`;
    context.lineWidth = 1;
    for (const y of separators) {
      context.beginPath();
      context.moveTo(0, y);
      context.lineTo(width, y);
      context.stroke();
    }

    const bins = args.packedBins;
    if (!bins) return this.canvas.transferToImageBitmap();

    const viewSamples = Math.max(Number.EPSILON, args.viewSamples);
    const tileStart = retainedLayer?.tileStart ?? 0;
    const originX = ((tileStart - args.viewStart) / viewSamples) * width;
    const binWidth = (args.samplesPerPixel / viewSamples) * width;
    const lineWidth = Math.max(args.dpr, 1);

    for (const draw of draws) {
      const cssColor = rgbaCss(draw.color, 1);
      context.lineWidth = lineWidth;
      context.lineCap = "butt";
      context.lineJoin = "miter";
      context.strokeStyle = cssColor;
      context.beginPath();
      let previousLastHigh: boolean | null = null;
      let previousDense = false;
      for (let bin = 0; bin < draw.binCount; bin += 1) {
        const base = (draw.binOffset + bin) * uint32PerBin;
        const flags = bins[base];
        const edgeCount = bins[base + 1];
        const firstEdgeOffset = bins[base + 2];
        const isFirst = (flags & 1) !== 0;
        const isLast = (flags & 2) !== 0;
        const hasHigh = (flags & 4) !== 0;
        const hasLow = (flags & 8) !== 0;
        const x0 = originX + bin * binWidth;
        const x1 = x0 + binWidth;
        const yFirst = isFirst ? draw.highY : draw.lowY;
        const yLast = isLast ? draw.highY : draw.lowY;

        const dense = hasHigh && hasLow && !(edgeCount <= 1 && firstEdgeOffset !== noEdgeOffset);
        // Same rule as the GPU path: a riser only connects two constant-level
        // bins. Next to a dense bin the fill already spans the lane, and a line
        // at every bin boundary would stripe the block.
        if (previousLastHigh !== null && previousLastHigh !== isFirst && !dense && !previousDense) {
          const edgeX = Math.round(x0) + 0.5;
          context.moveTo(edgeX, previousLastHigh ? draw.highY : draw.lowY);
          context.lineTo(edgeX, yFirst);
        }
        previousLastHigh = isLast;
        previousDense = dense;

        if (hasHigh && hasLow) {
          if (edgeCount <= 1 && firstEdgeOffset !== noEdgeOffset) {
            const edgeX = x0 + (firstEdgeOffset / Math.max(args.samplesPerPixel, 1)) * binWidth;
            const crispEdgeX = Math.round(edgeX) + 0.5;
            context.moveTo(x0, yFirst);
            context.lineTo(edgeX, yFirst);
            context.moveTo(crispEdgeX, yFirst);
            context.lineTo(crispEdgeX, yLast);
            context.moveTo(edgeX, yLast);
            context.lineTo(x1, yLast);
          } else {
            context.fillStyle = cssColor;
            context.fillRect(
              Math.floor(x0),
              Math.min(draw.highY, draw.lowY) - lineWidth * 0.5,
              Math.max(1, Math.ceil(x1 - x0)),
              Math.abs(draw.lowY - draw.highY) + lineWidth,
            );
          }
          continue;
        }
        context.moveTo(x0, yFirst);
        context.lineTo(x1, yFirst);
      }
      context.stroke();
    }
    return this.canvas.transferToImageBitmap();
  }
}

export {};
