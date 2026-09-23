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
