export const DEFAULT_CAPTURE_VIEW_SECONDS = 1;
export const MINIMUM_DEFAULT_CAPTURE_VIEW_SAMPLES = 100_000;

/**
 * Upper bound on the "show me what I captured" preview.
 *
 * Only used once a capture has finished. A live session must not use this: it
 * would have to widen the window on every progress update as the sample count
 * grows, which reads as the view zooming out underneath the user.
 */
export const MAXIMUM_CAPTURE_PREVIEW_SAMPLES = 50_000_000;

/**
 * The window a live capture follows: a fixed width at the tail, never narrower
 * than the minimum overview. Deliberately independent of how much has arrived
 * so far, so the view stays still while data streams in.
 */
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

/**
 * The window shown once a capture has stopped.
 *
 * A finished capture is something to look at rather than to follow, so show the
 * whole thing when it fits the preview budget instead of leaving the user parked
 * on the trailing one-second window they were following during the capture. Long
 * captures fall back to the budget so a single frame is never asked to draw an
 * unbounded number of samples.
 */
export function previewCaptureViewportSamples(
  totalSampleCount: number,
  sampleRateHz: number,
) {
  const totalSamples = Math.max(1, totalSampleCount);
  const budget = Math.max(
    defaultCaptureViewportSamples(totalSamples, sampleRateHz),
    MAXIMUM_CAPTURE_PREVIEW_SAMPLES,
  );
  return Math.max(1, Math.min(totalSamples, budget));
}
