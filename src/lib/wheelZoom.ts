/**
 * Wheel zoom factor, following Saleae Logic 2.
 *
 * Shared by the digital canvas (time axis) and the analog overlay (voltage
 * axis) so both axes step by the same amount for the same gesture.
 */

/** Legacy `wheelDelta` is a fixed ±120 per notch on every mouse wheel. */
export const WHEEL_NOTCH_DELTA = 120;

/**
 * WebKit reports a line-granular wheel as `wheelDeltaY = -3 * deltaY`.
 *
 * Which means the ±120 test below can never match on macOS, where the webview is
 * WKWebView — every wheel event fell through to the touchpad curve. Measured on
 * the running client, one notch arrives as `deltaY=1, wheelDeltaY=-3`, and the
 * touchpad curve turns that into 1.0015: a 0.15% zoom per notch, which reads as
 * "the wheel does nothing".
 */
export const WEBKIT_WHEEL_DELTA_PER_LINE = 3;

/**
 * Most notches a single event may count as.
 *
 * Chromium can coalesce two notches into one event, and its fixed ±120 per
 * notch makes that visible, so the count is taken from the delta — but capped,
 * because nothing legitimate reports dozens.
 */
export const MAX_NOTCHES_PER_EVENT = 3;

/**
 * Zoom per notch, as a power of two. Matches Logic 2: one notch is
 * `2^0.5` ≈ 1.41, i.e. ±41% on the visible span.
 */
export const WHEEL_ZOOM_PER_NOTCH_POW2 = 0.5;

/** Smooth touchpads have no notches to count, so they keep the pixel curve. */
export const TOUCHPAD_ZOOM_INTENSITY = 0.0015;
export const TOUCHPAD_ZOOM_INTENSITY_COARSE = 0.003;
export const TOUCHPAD_MAX_DELTA = 800;

/**
 * How long a discrete zoom step takes to glide into place.
 *
 * Only discrete input gets a glide. Logic 2 splits its zoom the same way and
 * passes `animationDurationScale * 0.1` — 100 ms at the default scale — for a
 * physical wheel, while a touchpad streams and gets `duration: 0`.
 *
 * This is a scale rather than a bare number so the feel stays adjustable, and it
 * is a live value rather than a constant because the advanced options panel
 * exposes it — the same control Logic 2 keeps in its hidden developer menu
 * ("Animation Scale"). Gestures read it when they fire, so a change applies to
 * the next gesture without a reload; the choice is persisted in
 * `UiPreferences.animationScale`.
 *
 * History: it was pinned to 0 to isolate a report of markers and the trace
 * drifting intermittently after a zoom, but the glide that report was about is
 * the frontend `animateViewport` rAF loop, which this value does not control, so
 * the bisect settled nothing. This backend glide (zoom and pan_samples carrying
 * `duration_ms` into a `ViewAnimation`) had never run in a build before being
 * re-enabled, and still wants hardware verification: a timing marker must stay
 * pinned to the trace through the glide and after it settles, and repeated
 * keypresses mid-glide must retarget from the current view instead of compounding.
 */
export const ZOOM_ANIMATION_DURATION_SCALE_DEFAULT = 1;
export const ZOOM_ANIMATION_DURATION_SCALE_MIN = 0;
export const ZOOM_ANIMATION_DURATION_SCALE_MAX = 3;
export const ZOOM_ANIMATION_BASE_MS = 100;

let zoomAnimationDurationScale = ZOOM_ANIMATION_DURATION_SCALE_DEFAULT;

/** Applies the persisted preference; clamped so a bad value cannot disable or stall the glide. */
export function setZoomAnimationDurationScale(scale: number) {
  zoomAnimationDurationScale = Number.isFinite(scale)
    ? Math.min(ZOOM_ANIMATION_DURATION_SCALE_MAX, Math.max(ZOOM_ANIMATION_DURATION_SCALE_MIN, scale))
    : ZOOM_ANIMATION_DURATION_SCALE_DEFAULT;
}

/** The glide duration for one discrete step, in milliseconds. */
export function zoomAnimationDurationMs() {
  return ZOOM_ANIMATION_BASE_MS * zoomAnimationDurationScale;
}

/**
 * The wheel fields the zoom factor needs. Both a React wheel event and a plain
 * `WheelEvent` satisfy it, so one helper serves both call sites.
 */
export interface WheelZoomInput {
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  nativeEvent?: WheelEvent & { wheelDeltaY?: number };
  wheelDeltaY?: number;
}

/**
 * Whether this event came from a clicky mouse wheel rather than a touchpad or a
 * pinch gesture.
 *
 * A physical wheel reports a fixed ±120 per notch in the legacy `wheelDeltaY`
 * field regardless of device, OS or browser zoom; smooth input reports arbitrary
 * values. Logic 2 uses the same test (`wheelDelta % (120 / zoomFactor) === 0`)
 * and, more importantly, uses it to decide *how* to apply the zoom, not just how
 * much — which is why this is exported rather than kept local.
 */
export function isPhysicalWheelZoom(event: WheelZoomInput): boolean {
  // macOS pinch gestures set ctrlKey *and* report wheelDeltaY of ±120, exactly
  // like a clicky wheel. Deciding pinch first stops a pinch becoming a notch.
  if (event.ctrlKey) return false;
  return wheelNotchUnit(event) !== null;
}

/**
 * How many legacy `wheelDeltaY` units one notch is on this platform, or `null`
 * when the event is not a discrete wheel at all.
 *
 * Two conventions have to be told apart. Chromium reports a fixed ±120 per notch
 * whatever the speed; WebKit reports `-3 * deltaY`, where `deltaY` is a whole
 * number of lines that macOS accelerates with how fast the wheel is turned.
 */
function wheelNotchUnit(event: WheelZoomInput): number | null {
  const legacy = (event.nativeEvent ?? event) as WheelEvent & { wheelDeltaY?: number };
  const wheelDeltaY = typeof legacy?.wheelDeltaY === "number" ? legacy.wheelDeltaY : 0;
  if (wheelDeltaY === 0) return null;
  if (Math.abs(wheelDeltaY % WHEEL_NOTCH_DELTA) === 0) return WHEEL_NOTCH_DELTA;
  // The WebKit shape: a whole number of lines, and a delta that is exactly the
  // documented multiple of it. A smooth trackpad reports neither.
  const deltaY = legacy.deltaY;
  if (
    Number.isInteger(deltaY) &&
    deltaY !== 0 &&
    Math.abs(wheelDeltaY) === WEBKIT_WHEEL_DELTA_PER_LINE * Math.abs(deltaY)
  ) {
    return WEBKIT_WHEEL_DELTA_PER_LINE;
  }
  return null;
}

/**
 * Compute the zoom factor for one wheel event.
 *
 * A physical mouse wheel reports a fixed ±120 per notch in the legacy
 * `wheelDeltaY` field regardless of device, OS or browser zoom, whereas
 * `deltaY` in pixels varies a lot between devices — on macOS a single notch can
 * be well under 100 px, which is why the raw-pixel curve felt slow.
 *
 * So: count notches for clicky wheels, where one notch is always the same
 * step, and fall back to the pixel curve for smooth input. That is exactly what
 * Logic 2 does. Both sides treat the factor as a multiplier on the visible
 * span, so `factor < 1` zooms in on both: the direction stays SigPilot's
 * existing one, taken from the sign of the normalised delta, and only the
 * magnitude changes.
 *
 * @param normalizedDelta `deltaY` already converted to pixels via each
 *   component's own `deltaMode` conversion. Only its sign is used here.
 * @param scale Logic 2's "fine" zoom. Pass `shiftKey ? 0.1 : 1` for a tenfold
 *   finer step, which is what the analog overlay already did.
 */
export function wheelZoomFactor(
  event: WheelZoomInput,
  normalizedDelta: number,
  scale: number = 1,
): number {
  const unit = wheelNotchUnit(event);
  if (unit !== null) {
    const legacy = (event.nativeEvent ?? event) as WheelEvent & { wheelDeltaY?: number };
    const notches =
      unit === WHEEL_NOTCH_DELTA
        ? // Chromium: a fixed ±120 per notch, so the delta counts notches.
          Math.min(
            MAX_NOTCHES_PER_EVENT,
            Math.max(1, Math.abs(legacy.wheelDeltaY as number) / WHEEL_NOTCH_DELTA),
          )
        : // WebKit: `deltaY` is how far macOS decided the scroll should go, not how
          // many ticks the wheel made. One flick arrives as a run of events with
          // rising deltas — the client logged 1, 7, 14, 22, 27 — and counting
          // those as notches zoomed by about ninety times per flick. The tick
          // count is the event count.
          1;
    const direction = normalizedDelta < 0 ? -1 : 1;
    return Math.pow(2, direction * WHEEL_ZOOM_PER_NOTCH_POW2 * scale * notches);
  }

  const intensity =
    event.ctrlKey || event.metaKey || event.altKey
      ? TOUCHPAD_ZOOM_INTENSITY_COARSE
      : TOUCHPAD_ZOOM_INTENSITY;
  const clamped = Math.max(-TOUCHPAD_MAX_DELTA, Math.min(TOUCHPAD_MAX_DELTA, normalizedDelta));
  return Math.exp(clamped * intensity * scale);
}
