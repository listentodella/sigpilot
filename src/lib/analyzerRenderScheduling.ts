import type { AnalyzerTrackWindow } from "./api";

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
) {
  const requestSamplesPerPixel = request.sampleCount / Math.max(1, request.pixels);
  const targetSamplesPerPixel = target.sampleCount / Math.max(1, target.pixels);
  const lodRatio = requestSamplesPerPixel / Math.max(Number.EPSILON, targetSamplesPerPixel);
  if (lodRatio < 0.75 || lodRatio > 1.35) return false;

  const requestEnd = request.startSample + request.sampleCount;
  const requiredTargetEnd = target.startSample + target.sampleCount * (isLive ? 0.85 : 1);
  return request.startSample <= target.startSample && requestEnd >= requiredTargetEnd;
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
