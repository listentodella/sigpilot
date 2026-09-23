import type { WaveformTile } from "./api";

// The worker-request pipeline for the waveform layer.
//
// This lives outside the component on purpose. It is a small state machine —
// at most one tile render and one viewport transform in flight, with
// latest-only queues behind each — and it is where the bug that made a deep
// zoom-out followed by a zoom-in permanently banded the graph lived. Sitting
// inside `WaveformCanvas.tsx` it was unreachable from `node --test`, because
// Node cannot parse the component's JSX. Keeping it here means the real
// functions are testable, rather than a predicate extracted alongside them
// that would only duplicate the same condition.

export const packedDigitalBinBytes = 16;

/**
 * The only part of a `Worker` this module touches. A real `Worker` satisfies it,
 * and so does a recording stub, which is what makes the pipeline testable.
 */
export interface WaveLayerWorkerPort {
  postMessage(message: unknown, transfer?: Transferable[]): void;
}

/** The only part of a canvas this module touches. */
export interface RasterTarget {
  height: number;
  width: number;
}

export interface WaveLayerWorkerRequest {
  /** Read at request time so a display change re-rasterises at the new scale. */
  dpr: number;
  height: number;
  id: number;
  matchChannelColors: boolean;
  rowHeights: number[];
  rowTopInsets: number[];
  tile: WaveformTile;
  width: number;
}

export interface ViewportWorkerRequest extends WaveLayerWorkerRequest {
  viewSamples: number;
  viewStart: number;
}

export interface WaveLayerWorkerState {
  active: WaveLayerWorkerRequest | null;
  failed: boolean;
  nextId: number;
  queued: WaveLayerWorkerRequest | null;
  viewportActive: ViewportWorkerRequest | null;
  viewportQueued: ViewportWorkerRequest | null;
  worker: WaveLayerWorkerPort;
}

export interface WaveLayerWorkerRef {
  current: WaveLayerWorkerState | null;
}

export interface WorkerChannelPayload {
  binCount: number;
  binOffset: number;
  bins: WaveformTile["channels"][number]["bins"] | null;
  channel: number;
  hasExactSegments: boolean;
}

export function sameNumberArray(left: number[], right: number[]) {
  return left === right || (left.length === right.length && left.every((value, index) => value === right[index]));
}

export function sameWaveLayerWorkerRequest(left: WaveLayerWorkerRequest | null, right: WaveLayerWorkerRequest) {
  return Boolean(
    left &&
    left.tile === right.tile &&
    left.width === right.width &&
    left.height === right.height &&
    left.dpr === right.dpr &&
    sameNumberArray(left.rowHeights, right.rowHeights) &&
    sameNumberArray(left.rowTopInsets, right.rowTopInsets) &&
    left.matchChannelColors === right.matchChannelColors,
  );
}

export function sameViewportWorkerRequest(left: ViewportWorkerRequest | null, right: ViewportWorkerRequest) {
  return Boolean(
    left &&
    left.tile === right.tile &&
    left.width === right.width &&
    left.height === right.height &&
    left.dpr === right.dpr &&
    left.viewStart === right.viewStart &&
    left.viewSamples === right.viewSamples &&
    sameNumberArray(left.rowHeights, right.rowHeights) &&
    sameNumberArray(left.rowTopInsets, right.rowTopInsets) &&
    left.matchChannelColors === right.matchChannelColors,
  );
}

// All packed bins are concatenated into one buffer so a tile costs a single
// transferable upload and the worker can address every channel through one
// RGBA32UI texture. Channels that only carry JSON bins are marked with a
// negative offset and packed inside the worker, off the main thread.
export function buildWorkerChannels(tile: WaveformTile) {
  let packedBytes = 0;
  for (const channel of tile.channels) {
    const packed = channel.packed_bins;
    if (packed && packed.byteLength >= packedDigitalBinBytes) packedBytes += packed.byteLength;
  }
  const combined = packedBytes > 0 ? new Uint8Array(packedBytes) : null;
  let byteOffset = 0;
  const channels: WorkerChannelPayload[] = tile.channels.map((channel) => {
    const hasExactSegments = channel.segments.length > 0;
    const packed = channel.packed_bins;
    if (combined && packed && packed.byteLength >= packedDigitalBinBytes) {
      const binCount = Math.floor(packed.byteLength / packedDigitalBinBytes);
      combined.set(packed.subarray(0, binCount * packedDigitalBinBytes), byteOffset);
      const binOffset = byteOffset / packedDigitalBinBytes;
      byteOffset += binCount * packedDigitalBinBytes;
      return { binCount, binOffset, bins: null, channel: channel.channel, hasExactSegments };
    }
    return {
      binCount: 0,
      binOffset: -1,
      bins: packed ? null : channel.bins,
      channel: channel.channel,
      hasExactSegments,
    };
  });
  return { channels, combined };
}

export function startWaveLayerWorkerRequest(state: WaveLayerWorkerState, request: WaveLayerWorkerRequest) {
  state.active = request;
  const { tile } = request;
  const { channels, combined } = buildWorkerChannels(tile);
  state.worker.postMessage(
    {
      type: "render",
      id: request.id,
      width: request.width,
      height: request.height,
      dpr: request.dpr,
      rowHeights: request.rowHeights,
      rowTopInsets: request.rowTopInsets,
      matchChannelColors: request.matchChannelColors,
      tileStart: tile.start_sample,
      tileSamples: tile.sample_count,
      samplesPerPixel: tile.samples_per_pixel,
      packedBins: combined,
      channels,
    },
    combined ? [combined.buffer] : [],
  );
}

export function startViewportWorkerRequest(state: WaveLayerWorkerState, request: ViewportWorkerRequest) {
  state.viewportActive = request;
  state.worker.postMessage({
    type: "transform",
    id: request.id,
    width: request.width,
    height: request.height,
    dpr: request.dpr,
    rowHeights: request.rowHeights,
    rowTopInsets: request.rowTopInsets,
    matchChannelColors: request.matchChannelColors,
    viewStart: request.viewStart,
    viewSamples: request.viewSamples,
  });
}

export function requestWaveLayerRender(
  state: WaveLayerWorkerState,
  tile: WaveformTile,
  width: number,
  height: number,
  rowHeights: number[],
  rowTopInsets: number[],
  matchChannelColors: boolean,
  dpr: number,
) {
  const request: WaveLayerWorkerRequest = {
    dpr,
    height,
    id: state.nextId++,
    matchChannelColors,
    rowHeights,
    rowTopInsets,
    tile,
    width,
  };
  if (sameWaveLayerWorkerRequest(state.active, request)) return;
  if (state.active) {
    if (!sameWaveLayerWorkerRequest(state.queued, request)) state.queued = request;
    return;
  }
  startWaveLayerWorkerRequest(state, request);
}

export function requestViewportRender(
  state: WaveLayerWorkerState,
  tile: WaveformTile,
  width: number,
  height: number,
  rowHeights: number[],
  rowTopInsets: number[],
  matchChannelColors: boolean,
  viewStart: number,
  viewSamples: number,
  dpr: number,
) {
  const request: ViewportWorkerRequest = {
    dpr,
    height,
    id: state.nextId++,
    matchChannelColors,
    rowHeights,
    rowTopInsets,
    tile,
    viewSamples,
    viewStart,
    width,
  };
  if (sameViewportWorkerRequest(state.viewportActive, request)) return;
  if (state.viewportActive) {
    // Latest-only: a zoom gesture produces a new viewport every frame and every
    // earlier one is already obsolete by the time it could be rendered.
    state.viewportQueued = request;
    return;
  }
  startViewportWorkerRequest(state, request);
}

/**
 * Requests a raster the worker re-renders at the scale the user is looking at,
 * rather than magnifying the retained tile raster.
 *
 * The raster has to stay inside the retained tile because the worker can only
 * address bins it already holds. Overscan absorbs the viewport drift between the
 * request and the response, exactly like the tile raster's own overscan.
 *
 * The `workerTileRef` guard below is load-bearing. The worker can only
 * re-rasterise bins it holds, and the only thing that hands it bins is a tile
 * render, so this path must not be reachable without one having been sent. It
 * used to be: `workerTileRef` only advanced on a tile response, and this
 * function was reached from a branch that never requested a tile, so every
 * viewport render was refused and the ref never advanced. The graph then stayed
 * stuck on a coarse raster stretched to fit — banded, with no edges ever coming
 * back — which is exactly what a deep zoom-out followed by a zoom-in looked
 * like. Enforcing the dependency here rather than trusting the caller keeps any
 * future call site safe.
 */
export function requestViewportRaster(
  tile: WaveformTile,
  viewportStart: number,
  viewportSamples: number,
  target: RasterTarget,
  rowHeights: number[],
  rowTopInsets: number[],
  matchChannelColors: boolean,
  workerRef: WaveLayerWorkerRef,
  workerTileRef: { current: WaveformTile | null },
  layerWidth: number,
  dpr: number,
) {
  const worker = workerRef.current;
  if (!worker || worker.failed) return;
  if (workerTileRef.current !== tile) {
    requestWaveLayerRender(
      worker,
      tile,
      layerWidth,
      target.height,
      rowHeights,
      rowTopInsets,
      matchChannelColors,
      dpr,
    );
    return;
  }
  const tileStart = tile.start_sample;
  const tileEnd = tileStart + tile.sample_count;
  const overscan = Math.max(64, Math.ceil(viewportSamples * 0.5));
  const renderStart = Math.max(tileStart, Math.floor(viewportStart - overscan));
  const renderEnd = Math.min(tileEnd, Math.ceil(viewportStart + viewportSamples + overscan));
  if (renderStart > viewportStart || renderEnd < viewportStart + viewportSamples) return;
  const renderSamples = renderEnd - renderStart;
  if (renderSamples <= 0) return;
  const rasterWidth = Math.max(1, Math.round((target.width * renderSamples) / viewportSamples));
  requestViewportRender(
    worker,
    tile,
    rasterWidth,
    target.height,
    rowHeights,
    rowTopInsets,
    matchChannelColors,
    renderStart,
    renderSamples,
    dpr,
  );
}
