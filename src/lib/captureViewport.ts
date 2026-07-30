export const MIN_CAPTURE_DATA_VISIBLE_RATIO = 0.4;
export const LIVE_CAPTURE_RESERVED_VIEW_SECONDS = 500;

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
  const total = Math.max(1, Math.round(totalSamples));
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

// Logic 2's DataLimited mode permits zooming and panning while at least 40%
// of the viewport still intersects captured data.
export function normalizeCaptureViewport(
  start: number,
  samples: number,
  totalSamples: number,
  maximumSamples?: number,
): CaptureViewport {
  const total = Math.max(1, Math.round(totalSamples));
  const dataLimitedMaximum = maximumCaptureViewportSamples(total);
  const maximum = Math.max(dataLimitedMaximum, Math.round(maximumSamples ?? 0));
  const nextSamples = Math.max(
    1,
    Math.min(maximum, Math.round(samples)),
  );
  if (nextSamples > dataLimitedMaximum) {
    return { samples: nextSamples, start: 0 };
  }
  const minimumStart = Math.ceil(-(1 - MIN_CAPTURE_DATA_VISIBLE_RATIO) * nextSamples);
  const maximumStart = Math.floor(total - MIN_CAPTURE_DATA_VISIBLE_RATIO * nextSamples);
  const nextStart = Math.max(minimumStart, Math.min(maximumStart, Math.round(start)));
  return { samples: nextSamples, start: nextStart };
}

export function normalizeLiveCaptureViewport(
  start: number,
  samples: number,
  totalSamples: number,
  sampleRateHz: number,
  maximumSamples?: number,
): CaptureViewport {
  const total = Math.max(1, Math.round(totalSamples));
  const nextSamples = Math.max(
    1,
    Math.min(
      Math.max(
        maximumLiveCaptureViewportSamples(total, sampleRateHz),
        Math.round(maximumSamples ?? 0),
      ),
      Math.round(samples),
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
