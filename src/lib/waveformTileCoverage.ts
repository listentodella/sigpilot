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
