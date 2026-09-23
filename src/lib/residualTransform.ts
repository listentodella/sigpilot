// The backend owns the viewport and renders each frame for wherever the user
// was at request time. By the time that frame lands the viewport may have moved
// again, so the frontend stretches the pixels it already has instead of waiting
// for another round trip. This is the same job Saleae's `horizontalTransform`
// does; keeping the two viewports on the frame is what makes it possible.
//
// Everything here is in **device pixels**: the raster width and the screen width
// must be measured the same way or the stretch is silently off by the DPR.

import type { SessionView } from "./api";

export interface HorizontalTransform {
  /** Device pixels one raster pixel occupies on screen. */
  m: number;
  /** Where the raster's left edge lands, in device pixels. */
  b: number;
}

export const IDENTITY_TRANSFORM: HorizontalTransform = { b: 0, m: 1 };

/**
 * Maps a raster rendered for `dataView` onto a screen currently showing `view`.
 *
 * `dataRasterWidthPx` is the width the raster was rendered at (its own pixel
 * budget, not the screen's), and `screenWidthPx` is the width it is being drawn
 * onto. Passing the same width for both is correct when the raster was rendered
 * at screen resolution.
 */
export function horizontalTransform(
  dataView: SessionView,
  dataRasterWidthPx: number,
  view: SessionView,
  screenWidthPx: number,
): HorizontalTransform {
  const dataSamplesPerPx = dataView.samples / Math.max(1, dataRasterWidthPx);
  const screenSamplesPerPx = view.samples / Math.max(1, screenWidthPx);
  const m = dataSamplesPerPx / Math.max(Number.EPSILON, screenSamplesPerPx);
  const b =
    ((dataView.start_sample - view.start_sample) /
      Math.max(Number.EPSILON, view.samples)) *
    screenWidthPx;
  // A non-finite or non-positive scale would collapse the raster to nothing;
  // falling back to a plain blit keeps a degenerate frame visible instead of
  // making the graph vanish.
  if (!Number.isFinite(m) || m <= 0 || !Number.isFinite(b)) return IDENTITY_TRANSFORM;
  return { b, m };
}

export function applyHorizontalTransform(x: number, transform: HorizontalTransform) {
  return x * transform.m + transform.b;
}

/** The inverse map, for turning a screen position back into raster pixels. */
export function invertHorizontalTransform(x: number, transform: HorizontalTransform) {
  if (Math.abs(transform.m) < Number.EPSILON) return 0;
  return (x - transform.b) / transform.m;
}

/**
 * How far the transform is from a plain blit. A transform that is essentially
 * identity means the frame is fresh and can be drawn 1:1; anything else is a
 * frame the user has already moved past.
 */
export function transformDeviation(transform: HorizontalTransform) {
  return Math.max(Math.abs(transform.m - 1), Math.abs(transform.b));
}
