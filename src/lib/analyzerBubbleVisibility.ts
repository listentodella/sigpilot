export interface AnalyzerBubbleSampleSpan {
  start_sample: number;
  end_sample: number;
}

export interface AnalyzerBubbleKeySpan extends AnalyzerBubbleSampleSpan {
  frame_id_interval: {
    begin: number;
    end: number;
  };
}

export interface AnalyzerBubbleKeyTrack {
  key: string;
  bubbles: readonly AnalyzerBubbleKeySpan[];
}

export function analyzerBubbleKey(trackKey: string, bubble: AnalyzerBubbleKeySpan) {
  return `${trackKey}:${bubble.start_sample}:${bubble.frame_id_interval.begin}:${bubble.frame_id_interval.end}`;
}

export function visibleAnalyzerBubbleRange(
  bubbles: readonly AnalyzerBubbleSampleSpan[],
  viewportStart: number,
  viewportSamples: number,
) {
  if (bubbles.length === 0 || viewportSamples <= 0) return [0, 0] as const;
  const viewportEnd = viewportStart + viewportSamples;
  let start = lowerBoundBubbleStart(bubbles, viewportStart);
  while (start > 0 && bubbles[start - 1].end_sample > viewportStart) {
    start -= 1;
  }
  const end = lowerBoundBubbleStart(bubbles, viewportEnd + 1);
  return [start, end] as const;
}

export function paddedAnalyzerBubbleRange(
  bubbles: readonly AnalyzerBubbleSampleSpan[],
  viewportStart: number,
  viewportSamples: number,
  paddingSamples: number,
) {
  if (paddingSamples <= 0) {
    return visibleAnalyzerBubbleRange(bubbles, viewportStart, viewportSamples);
  }
  const paddedStart = Math.max(0, viewportStart - paddingSamples);
  const paddedEnd =
    viewportStart + Math.max(1, viewportSamples) + Math.max(0, paddingSamples);
  return visibleAnalyzerBubbleRange(
    bubbles,
    paddedStart,
    Math.max(1, paddedEnd - paddedStart),
  );
}

function lowerBoundBubbleStart(
  bubbles: readonly AnalyzerBubbleSampleSpan[],
  sample: number,
) {
  let low = 0;
  let high = bubbles.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (bubbles[middle].start_sample < sample) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

export function visibleAnalyzerBubbleKeys(
  tracks: readonly AnalyzerBubbleKeyTrack[],
  viewportStart: number,
  viewportSamples: number,
) {
  const keys = new Set<string>();
  for (const track of tracks) {
    const [start, end] = visibleAnalyzerBubbleRange(
      track.bubbles,
      viewportStart,
      viewportSamples,
    );
    for (let index = start; index < end; index += 1) {
      keys.add(analyzerBubbleKey(track.key, track.bubbles[index]));
    }
  }
  return keys;
}
