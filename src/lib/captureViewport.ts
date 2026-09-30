export const MIN_CAPTURE_DATA_VISIBLE_RATIO = 0.4;
export const LIVE_CAPTURE_RESERVED_VIEW_SECONDS = 500;

/**
 * The finest horizontal span worth showing, in seconds.
 *
 * Below this the viewport stops resolving signal edges and starts resolving
 * individual samples: the renderer has more per-sample work to do every frame
 * while showing the user nothing they can act on. Mirrors
 * `MINIMUM_VIEW_SECONDS` in `crates/sigpilot-graph/src/view_state.rs`, which is
 * the authority when the backend owns the viewport.
 */
export const MINIMUM_VIEW_SECONDS = 5e-6;

/**
 * `MINIMUM_VIEW_SECONDS` expressed in samples for a given sample rate.
 *
 * Must stay finite for any input. `Math.max(1, NaN)` is NaN, not 1, so a session
 * whose sample rate is missing or not a number would otherwise put NaN into
 * `viewportSamples` — which then serialises to `null` in the frame request (the
 * backend rejects the whole frame) and paints NaN into every width derived from
 * the viewport.
 */
export function minimumViewportSamples(sampleRateHz: number) {
  const rate = Number.isFinite(sampleRateHz) && sampleRateHz > 0 ? sampleRateHz : 1;
  return Math.max(1, rate * MINIMUM_VIEW_SECONDS);
}

export interface CaptureViewport {
  samples: number;
  start: number;
}

export interface CaptureDataWindow {
  end: number;
  samples: number;
  start: number;
}

export function maximumCaptureViewportSamples(totalSamples: number) {
  const total = Math.max(1, totalSamples);
  return Math.ceil(total / MIN_CAPTURE_DATA_VISIBLE_RATIO);
}

export function maximumLiveCaptureViewportSamples(
  totalSamples: number,
  sampleRateHz: number,
) {
  const reservedSamples = Math.round(
    Math.max(1, sampleRateHz) * LIVE_CAPTURE_RESERVED_VIEW_SECONDS,
  );
  return Math.max(maximumCaptureViewportSamples(totalSamples), reservedSamples);
}

export function maximumDataViewportSamples(totalSamples: number, sampleRateHz: number) {
  return maximumLiveCaptureViewportSamples(totalSamples, sampleRateHz);
}

// Logic 2's DataLimited mode permits zooming and panning while at least 40%
// of the viewport still intersects captured data.
export function normalizeCaptureViewport(
  start: number,
  samples: number,
  totalSamples: number,
  maximumSamples?: number,
): CaptureViewport {
  const total = Math.max(1, totalSamples);
  const dataLimitedMaximum = maximumCaptureViewportSamples(total);
  const maximum = Math.max(dataLimitedMaximum, Math.round(maximumSamples ?? 0));
  const nextSamples = Math.max(
    1,
    Math.min(maximum, samples),
  );
  if (nextSamples > dataLimitedMaximum) {
    return { samples: nextSamples, start: 0 };
  }
  const minimumStart = -(1 - MIN_CAPTURE_DATA_VISIBLE_RATIO) * nextSamples;
  const maximumStart = total - MIN_CAPTURE_DATA_VISIBLE_RATIO * nextSamples;
  const nextStart = Math.max(minimumStart, Math.min(maximumStart, start));
  return { samples: nextSamples, start: nextStart };
}

export function normalizeLiveCaptureViewport(
  start: number,
  samples: number,
  totalSamples: number,
  sampleRateHz: number,
  maximumSamples?: number,
): CaptureViewport {
  const total = Math.max(1, totalSamples);
  const nextSamples = Math.max(
    1,
    Math.min(
      Math.max(
        maximumLiveCaptureViewportSamples(total, sampleRateHz),
        Math.round(maximumSamples ?? 0),
      ),
      samples,
    ),
  );

  if (nextSamples >= total) {
    return { samples: nextSamples, start: 0 };
  }
  return normalizeCaptureViewport(start, nextSamples, total, maximumSamples);
}

export function captureDataWindow(
  viewportStart: number,
  viewportSamples: number,
  totalSamples: number,
): CaptureDataWindow {
  const total = Math.max(0, Math.round(totalSamples));
  const start = Math.max(0, Math.floor(viewportStart));
  const end = Math.max(start, Math.min(total, Math.ceil(viewportStart + viewportSamples)));
  return { end, samples: end - start, start };
}
