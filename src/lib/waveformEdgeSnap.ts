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
  let nearestIndex = -1;
  let nearestDistance = thresholdSamples;
  for (let index = 0; index < edgeSamples.length; index += 1) {
    const distance = Math.abs(edgeSamples[index] - pointerSample);
    if (distance <= nearestDistance) {
      nearestIndex = index;
      nearestDistance = distance;
    }
  }
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
  const exactEdges = [...channel.rising_edges, ...channel.falling_edges].sort((left, right) => left - right);
  const snappedSample = findNearestEdgeSample(
    exactEdges,
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
