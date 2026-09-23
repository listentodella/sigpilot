import type { WaveformTile } from "./api.ts";
import { findSaleaeGraphChannelIndexAtY, getSaleaeGraphChannelLayout } from "./saleaeGraphLayout.ts";

export function findNearestEdgeSample(
  edgeSamples: number[],
  pointerSample: number,
  samplesPerPixel: number,
  thresholdPx: number,
  rejectCrowdedEdges: boolean,
) {
  if (edgeSamples.length === 0 || samplesPerPixel <= 0) return null;
  const thresholdSamples = thresholdPx * samplesPerPixel;
  const nearestIndex = nearestSortedSampleIndex(edgeSamples, pointerSample, thresholdSamples);
  if (nearestIndex < 0) return null;
  if (rejectCrowdedEdges) {
    const previousGap = nearestIndex > 0
      ? (edgeSamples[nearestIndex] - edgeSamples[nearestIndex - 1]) / samplesPerPixel
      : 0;
    const nextGap = nearestIndex + 1 < edgeSamples.length
      ? (edgeSamples[nearestIndex + 1] - edgeSamples[nearestIndex]) / samplesPerPixel
      : Number.POSITIVE_INFINITY;
    // Logic 2 rejects only transitions surrounded by an unresolvable pulse.
    // A distinct boundary beside one narrow pulse must remain selectable.
    if (previousGap < thresholdPx && nextGap < thresholdPx) return null;
  }
  return edgeSamples[nearestIndex];
}

export function findNearestMergedEdgeSample(
  firstEdgeSamples: number[],
  secondEdgeSamples: number[],
  pointerSample: number,
  samplesPerPixel: number,
  thresholdPx: number,
  rejectCrowdedEdges: boolean,
) {
  if (samplesPerPixel <= 0 || (firstEdgeSamples.length === 0 && secondEdgeSamples.length === 0)) {
    return null;
  }
  if (firstEdgeSamples.length === 0) {
    return findNearestEdgeSample(
      secondEdgeSamples,
      pointerSample,
      samplesPerPixel,
      thresholdPx,
      rejectCrowdedEdges,
    );
  }
  if (secondEdgeSamples.length === 0) {
    return findNearestEdgeSample(
      firstEdgeSamples,
      pointerSample,
      samplesPerPixel,
      thresholdPx,
      rejectCrowdedEdges,
    );
  }

  const thresholdSamples = thresholdPx * samplesPerPixel;
  const firstIndex = nearestSortedSampleIndex(firstEdgeSamples, pointerSample, thresholdSamples);
  const secondIndex = nearestSortedSampleIndex(secondEdgeSamples, pointerSample, thresholdSamples);
  const firstSample = firstIndex >= 0 ? firstEdgeSamples[firstIndex] : null;
  const secondSample = secondIndex >= 0 ? secondEdgeSamples[secondIndex] : null;
  const nearestSample = nearestOfTwoSamples(firstSample, secondSample, pointerSample);
  if (nearestSample === null) return null;

  if (rejectCrowdedEdges) {
    const previousSample = previousMergedSample(firstEdgeSamples, secondEdgeSamples, nearestSample);
    const nextSample = nextMergedSample(firstEdgeSamples, secondEdgeSamples, nearestSample);
    const previousGap = previousSample === null ? 0 : (nearestSample - previousSample) / samplesPerPixel;
    const nextGap = nextSample === null ? Number.POSITIVE_INFINITY : (nextSample - nearestSample) / samplesPerPixel;
    // Logic 2 rejects only transitions surrounded by an unresolvable pulse.
    // A distinct boundary beside one narrow pulse must remain selectable.
    if (previousGap < thresholdPx && nextGap < thresholdPx) return null;
  }

  return nearestSample;
}

export interface WaveformPointerSample {
  channelIndex: number | null;
  rawSample: number;
  sample: number;
  snapped: boolean;
}

export function resolveWaveformPointerSample({
  clientX,
  clientY,
  fixedChannelIndex,
  rect,
  rejectCrowdedEdges = true,
  rowHeights,
  rowTopInsets = [],
  thresholdPx = 8,
  tile,
  totalSamples,
  viewportSamples,
  viewportStart,
}: {
  clientX: number;
  clientY: number;
  fixedChannelIndex?: number;
  rect: Pick<DOMRect, "bottom" | "height" | "left" | "right" | "top" | "width">;
  rejectCrowdedEdges?: boolean;
  rowHeights: number[];
  rowTopInsets?: number[];
  thresholdPx?: number;
  tile: WaveformTile | null;
  totalSamples: number;
  viewportSamples: number;
  viewportStart: number;
}): WaveformPointerSample {
  const ratio = clamp((clientX - rect.left) / Math.max(1, rect.width), 0, 1);
  const rawSample = clamp(
    viewportStart + ratio * viewportSamples,
    0,
    Math.max(0, totalSamples),
  );
  if (!tile || clientX < rect.left || clientX > rect.right) {
    return { channelIndex: null, rawSample, sample: rawSample, snapped: false };
  }

  const channelIndex = fixedChannelIndex ?? (
    clientY < rect.top || clientY > rect.bottom
      ? null
      : findSaleaeGraphChannelIndexAtY(
          getSaleaeGraphChannelLayout(rowHeights, tile.channels.length, 1, rowTopInsets),
          clientY - rect.top,
        )
  );
  if (channelIndex == null || !tile.channels[channelIndex]) {
    return { channelIndex: null, rawSample, sample: rawSample, snapped: false };
  }

  const channel = tile.channels[channelIndex];
  const snappedSample = findNearestMergedEdgeSample(
    channel.rising_edges,
    channel.falling_edges,
    rawSample,
    viewportSamples / Math.max(1, rect.width),
    thresholdPx,
    rejectCrowdedEdges,
  );
  return {
    channelIndex,
    rawSample,
    sample: clamp(snappedSample ?? rawSample, 0, Math.max(0, totalSamples)),
    snapped: snappedSample != null,
  };
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, value));
}

function nearestSortedSampleIndex(samples: number[], target: number, maximumDistance: number) {
  const rightIndex = lowerBound(samples, target);
  const leftIndex = rightIndex - 1;
  const leftDistance = leftIndex >= 0 ? Math.abs(samples[leftIndex] - target) : Number.POSITIVE_INFINITY;
  const rightDistance = rightIndex < samples.length ? Math.abs(samples[rightIndex] - target) : Number.POSITIVE_INFINITY;
  const nearestIndex = rightDistance <= leftDistance ? rightIndex : leftIndex;
  if (nearestIndex < 0 || nearestIndex >= samples.length) return -1;
  return Math.abs(samples[nearestIndex] - target) <= maximumDistance ? nearestIndex : -1;
}

function nearestOfTwoSamples(left: number | null, right: number | null, target: number) {
  if (left === null) return right;
  if (right === null) return left;
  const leftDistance = Math.abs(left - target);
  const rightDistance = Math.abs(right - target);
  return rightDistance <= leftDistance ? right : left;
}

function previousMergedSample(left: number[], right: number[], sample: number) {
  return greatestSampleBefore(
    left[lowerBound(left, sample) - 1] ?? null,
    right[lowerBound(right, sample) - 1] ?? null,
  );
}

function nextMergedSample(left: number[], right: number[], sample: number) {
  return leastSampleAfter(
    left[upperBound(left, sample)] ?? null,
    right[upperBound(right, sample)] ?? null,
  );
}

function greatestSampleBefore(left: number | null, right: number | null) {
  if (left === null) return right;
  if (right === null) return left;
  return Math.max(left, right);
}

function leastSampleAfter(left: number | null, right: number | null) {
  if (left === null) return right;
  if (right === null) return left;
  return Math.min(left, right);
}

function lowerBound(samples: number[], sample: number) {
  let low = 0;
  let high = samples.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (samples[middle] < sample) low = middle + 1;
    else high = middle;
  }
  return low;
}

function upperBound(samples: number[], sample: number) {
  let low = 0;
  let high = samples.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (samples[middle] <= sample) low = middle + 1;
    else high = middle;
  }
  return low;
}
