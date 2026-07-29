export const MIN_CAPTURE_DATA_VISIBLE_RATIO = 0.4;

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

// Logic 2's DataLimited mode permits zooming and panning while at least 40%
// of the viewport still intersects captured data.
export function normalizeCaptureViewport(
  start: number,
  samples: number,
  totalSamples: number,
): CaptureViewport {
  const total = Math.max(1, Math.round(totalSamples));
  const nextSamples = Math.max(
    1,
    Math.min(maximumCaptureViewportSamples(total), Math.round(samples)),
  );
  const minimumStart = Math.ceil(-(1 - MIN_CAPTURE_DATA_VISIBLE_RATIO) * nextSamples);
  const maximumStart = Math.floor(total - MIN_CAPTURE_DATA_VISIBLE_RATIO * nextSamples);
  const nextStart = Math.max(minimumStart, Math.min(maximumStart, Math.round(start)));
  return { samples: nextSamples, start: nextStart };
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
