import type { WaveformTile } from "./api.ts";
import { captureDataWindow } from "./captureViewport.ts";

export function graphTileCanServeViewport(
  tile: WaveformTile | null,
  viewportStart: number,
  viewportSamples: number,
  totalSamples: number,
  canvasWidth: number,
  channelIndexes: number[],
) {
  if (!tile || tile.channels.length !== channelIndexes.length || viewportSamples <= 0) return false;
  if (tile.channels.some((channel, index) => channel.channel !== channelIndexes[index])) return false;

  const dataWindow = captureDataWindow(viewportStart, viewportSamples, totalSamples);
  const tileEnd = tile.start_sample + tile.sample_count;
  if (dataWindow.start < tile.start_sample || dataWindow.end > tileEnd) return false;

  const viewportSamplesPerPixel = viewportSamples / Math.max(1, canvasWidth);
  const projectedDataPixels = dataWindow.samples /
    Math.max(Number.EPSILON, viewportSamplesPerPixel);
  if (projectedDataPixels <= 1.5) return true;

  // One captured sample is the finest resolution a waveform tile can provide.
  // Sub-sample zoom must accept that physical limit instead of retrying forever.
  const resolvableSamplesPerPixel = Math.max(1, viewportSamplesPerPixel);
  const resolutionRatio = tile.samples_per_pixel / resolvableSamplesPerPixel;
  return resolutionRatio >= 0.5 && resolutionRatio <= 1.75;
}

export function waveformTileRequiresDirectDraw(
  tileSamplesPerPixel: number,
  viewportSamples: number,
  canvasWidth: number,
) {
  if (tileSamplesPerPixel <= 0 || viewportSamples <= 0 || canvasWidth <= 0) return false;
  const viewportSamplesPerPixel = viewportSamples / canvasWidth;
  // Request rounding can make an otherwise 1:1 tile fractionally coarser.
  // Only bypass the raster cache once that magnification could affect a line.
  return tileSamplesPerPixel / viewportSamplesPerPixel > 1.05;
}

// A raster can be blitted 1:1 only while the whole viewport sits inside the
// sample range it was rendered for.
//
// Coverage alone is not enough to mean "1:1", which is worth stating because the
// two are easy to conflate: a raster rendered for a *wider* range still covers a
// viewport that has since been zoomed into, but blitting it now magnifies it by
// the zoom ratio. Use `rasterServesViewport` when the blit has to be pixel
// exact; this one only answers "is there anything to draw".
export function rasterCoversViewport(
  sourceStart: number,
  sourceSamples: number,
  viewportStart: number,
  viewportSamples: number,
) {
  if (!(sourceSamples > 0) || !(viewportSamples > 0)) return false;
  return (
    viewportStart >= sourceStart &&
    viewportStart + viewportSamples <= sourceStart + sourceSamples
  );
}

/**
 * Magnification a blit applies to its source raster.
 *
 * The blit maps by sample range, so the factor is the ratio of the raster's own
 * samples-per-pixel to the viewport's. Above 1 every stroke on screen is that
 * much too thick.
 */
export function rasterMagnification(
  sourceSamples: number,
  sourceWidthPx: number,
  viewportSamples: number,
  canvasWidthPx: number,
) {
  if (sourceSamples <= 0 || sourceWidthPx <= 0 || viewportSamples <= 0 || canvasWidthPx <= 0) return 0;
  return (sourceSamples / sourceWidthPx) / (viewportSamples / canvasWidthPx);
}

/**
 * Whether a cached raster can be used as if it were pixel exact: it has to cover
 * the viewport *and* be at the viewport's scale.
 *
 * Without the scale half, a raster rendered before a zoom-in keeps being reused
 * and progressively magnified, because using it short-circuits the request for a
 * fresh one. That is the difference between a stretch bounded by one frame of
 * gesture — what a backend-driven viewport gives you — and a stretch bounded by
 * however far the user has zoomed since the raster happened to be rendered.
 *
 * The tolerance matches `waveformTileRequiresDirectDraw`: below it the
 * magnification cannot move a line by a visible amount.
 */
export function rasterServesViewport(
  sourceStart: number,
  sourceSamples: number,
  sourceWidthPx: number,
  viewportStart: number,
  viewportSamples: number,
  canvasWidthPx: number,
) {
  if (!rasterCoversViewport(sourceStart, sourceSamples, viewportStart, viewportSamples)) return false;
  const magnification = rasterMagnification(sourceSamples, sourceWidthPx, viewportSamples, canvasWidthPx);
  if (!(magnification > 0)) return false;
  return magnification <= 1.05;
}

// A raster that only partly overlaps is still worth showing: it is drawn cropped
// to the overlap, which is what keeps the trace on screen while a worker render
// is in flight. Falling through to nothing here is what made a zoom look like it
// had erased the waveform.
export function rasterOverlapsViewport(
  sourceStart: number,
  sourceSamples: number,
  viewportStart: number,
  viewportSamples: number,
) {
  if (!(sourceSamples > 0) || !(viewportSamples > 0)) return false;
  return (
    Math.min(sourceStart + sourceSamples, viewportStart + viewportSamples) >
    Math.max(sourceStart, viewportStart)
  );
}
