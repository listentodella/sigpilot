import type { AnalyzerProtocolMarker } from "./api";

export const ANALYZER_MARKER_MINIMUM_GAP_PX = 13;
export const ANALYZER_MARKER_MAXIMUM_RESULTS = 300;

export function visibleAnalyzerMarkerSamples(
  edgeSamples: number[],
  viewportStart: number,
  viewportSamples: number,
  widthPx: number,
): number[] {
  const samples = Math.max(1, viewportSamples);
  const width = Math.max(1, widthPx);
  const viewEnd = viewportStart + samples;
  const minimumGapSamples = (ANALYZER_MARKER_MINIMUM_GAP_PX * samples) / width;
  const first = firstAtOrAfter(edgeSamples, viewportStart);
  const visible: number[] = [];

  for (let index = first; index < edgeSamples.length; index += 1) {
    const sample = edgeSamples[index];
    if (sample > viewEnd) break;

    // Logic 2 asks the graph backend for a minimum marker gap. Crowded results
    // disappear instead of being sampled into a misleading row of arrows.
    const previousGap = index > 0 ? sample - edgeSamples[index - 1] : Number.POSITIVE_INFINITY;
    const nextGap = index + 1 < edgeSamples.length
      ? edgeSamples[index + 1] - sample
      : Number.POSITIVE_INFINITY;
    if (previousGap < minimumGapSamples || nextGap < minimumGapSamples) continue;

    visible.push(sample);
    if (visible.length >= ANALYZER_MARKER_MAXIMUM_RESULTS) break;
  }

  return visible;
}

export function visibleAnalyzerProtocolMarkers(
  markers: AnalyzerProtocolMarker[],
  viewportStart: number,
  viewportSamples: number,
  widthPx: number,
): AnalyzerProtocolMarker[] {
  const samples = Math.max(1, viewportSamples);
  const width = Math.max(1, widthPx);
  const viewEnd = viewportStart + samples;
  const minimumGapSamples = (ANALYZER_MARKER_MINIMUM_GAP_PX * samples) / width;
  const first = firstMarkerAtOrAfter(markers, viewportStart);
  const visible: AnalyzerProtocolMarker[] = [];

  for (let index = first; index < markers.length; index += 1) {
    const marker = markers[index];
    if (marker.sample > viewEnd) break;

    if (isPriorityProtocolMarker(marker.kind)) {
      visible.push(marker);
    } else {
      const previousGap = index > 0
        ? marker.sample - markers[index - 1].sample
        : Number.POSITIVE_INFINITY;
      const nextGap = index + 1 < markers.length
        ? markers[index + 1].sample - marker.sample
        : Number.POSITIVE_INFINITY;
      if (previousGap >= minimumGapSamples && nextGap >= minimumGapSamples) {
        visible.push(marker);
      }
    }

    if (visible.length >= ANALYZER_MARKER_MAXIMUM_RESULTS) break;
  }

  return visible;
}

function firstAtOrAfter(samples: number[], sample: number) {
  let low = 0;
  let high = samples.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (samples[middle] < sample) low = middle + 1;
    else high = middle;
  }
  return low;
}

function firstMarkerAtOrAfter(markers: AnalyzerProtocolMarker[], sample: number) {
  let low = 0;
  let high = markers.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (markers[middle].sample < sample) low = middle + 1;
    else high = middle;
  }
  return low;
}

function isPriorityProtocolMarker(kind: AnalyzerProtocolMarker["kind"]) {
  return kind === "start" || kind === "stop" || kind.startsWith("error_");
}
