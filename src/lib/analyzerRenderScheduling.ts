import type { AnalyzerTrackRequest, AnalyzerTrackWindow } from "./api";

export interface AnalyzerRenderViewport {
  pixels: number;
  sampleCount: number;
  startSample: number;
}

export function analyzerRenderRequestIntervalMs(
  isInteracting: boolean,
  isLive: boolean,
) {
  if (isInteracting) return 50;
  if (isLive) return 80;
  return 40;
}

export function analyzerRenderViewportCanServe(
  request: AnalyzerRenderViewport,
  target: AnalyzerRenderViewport,
  isLive: boolean,
  availableData?: Pick<AnalyzerRenderViewport, "sampleCount" | "startSample">,
) {
  const targetSamplesPerPixel = target.sampleCount / Math.max(1, target.pixels);
  const requestEnd = request.startSample + request.sampleCount;
  const dataStart = availableData?.startSample ?? target.startSample;
  const dataEnd = availableData
    ? availableData.startSample + availableData.sampleCount
    : target.startSample + target.sampleCount;
  const targetStart = Math.max(target.startSample, dataStart);
  const targetEnd = Math.min(target.startSample + target.sampleCount, dataEnd);
  const projectedDataPixels = Math.max(0, targetEnd - targetStart) /
    Math.max(Number.EPSILON, targetSamplesPerPixel);
  if (projectedDataPixels > 1.5) {
    const requestSamplesPerPixel = request.sampleCount / Math.max(1, request.pixels);
    const lodRatio = requestSamplesPerPixel / Math.max(Number.EPSILON, targetSamplesPerPixel);
    if (lodRatio < 0.75 || lodRatio > 1.35) return false;
  }
  const requiredTargetEnd = targetStart + Math.max(0, targetEnd - targetStart) * (isLive ? 0.85 : 1);
  return request.startSample <= targetStart && requestEnd >= requiredTargetEnd;
}

export function preserveLiveAnalyzerTracks(
  previous: AnalyzerTrackWindow[],
  incoming: AnalyzerTrackWindow[],
) {
  return incoming.map((track) => {
    if (track.bubbles.length > 0) return track;
    return previous.find(
      (candidate) => candidate.channel === track.channel && candidate.role === track.role,
    ) ?? track;
  });
}

export function analyzerRenderedTracksMatchRequests(
  renderedTracks: Pick<AnalyzerTrackWindow, "channel" | "role">[],
  requestedTracks: AnalyzerTrackRequest[],
) {
  return (
    renderedTracks.length === requestedTracks.length &&
    requestedTracks.every((track) =>
      renderedTracks.some(
        (renderedTrack) =>
          renderedTrack.channel === track.channel && renderedTrack.role === track.role,
      ),
    )
  );
}

/**
 * Progress shown while a native analyzer batch is running.
 *
 * The curve flattens quickly, which is deliberate: it should look like it is
 * waiting, not like it is nearly finished.
 */
export function analyzerRenderProgress(elapsedMs: number) {
  return Math.min(94, 8 + 86 * (1 - Math.exp(-elapsedMs / 2_400)));
}

/**
 * Next progress value for one analyzer, or `null` when nothing should change.
 *
 * The sampler ticks every 100 ms, so returning the current value on a flat part
 * of the curve is the difference between "one session write per visible change"
 * and "a full workbench re-render ten times a second". Callers must treat `null`
 * as "leave the session alone"; writing an equal value still allocates a new
 * session object and re-runs every derived computation in the workbench.
 */
export function nextAnalyzerRenderProgress(
  currentProgress: number,
  elapsedMs: number,
): number | null {
  const next = Math.max(currentProgress, analyzerRenderProgress(elapsedMs));
  return next === currentProgress ? null : next;
}
