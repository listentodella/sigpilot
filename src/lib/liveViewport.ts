export const DEFAULT_CAPTURE_VIEW_SECONDS = 1;
export const MINIMUM_DEFAULT_CAPTURE_VIEW_SAMPLES = 100_000;

export function defaultCaptureViewportSamples(
  totalSampleCount: number,
  sampleRateHz: number,
) {
  const totalSamples = Math.max(1, totalSampleCount);
  const sampleRate = Math.max(1, sampleRateHz);
  const preferredSamples = Math.max(
    MINIMUM_DEFAULT_CAPTURE_VIEW_SAMPLES,
    Math.round(sampleRate * DEFAULT_CAPTURE_VIEW_SECONDS),
  );
  return Math.max(1, Math.min(totalSamples, preferredSamples));
}
