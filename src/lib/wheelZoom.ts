/**
 * Wheel zoom factor, following Saleae Logic 2.
 *
 * Shared by the digital canvas (time axis) and the analog overlay (voltage
 * axis) so both axes step by the same amount for the same gesture.
 */

/** Legacy `wheelDelta` is a fixed ±120 per notch on every mouse wheel. */
export const WHEEL_NOTCH_DELTA = 120;

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
 * This is a scale rather than a bare number so the feel stays adjustable without
 * editing the logic, mirroring Logic 2's "Animation Scale" developer option.
 *
 * TEMPORARILY 0 — diagnostic bisect, not a tuning choice.
 *
 * Markers and the trace were reported drifting after a zoom, intermittently.
 * Setting this to zero takes the glide out of the picture entirely: every zoom
 * becomes instantaneous and no view animation runs at all. If the drift survives
 * that, it is not the animation; if it goes away, it is. Restore to 1 once the
 * answer is known.
 */
export const ZOOM_ANIMATION_DURATION_SCALE = 0;
export const ZOOM_ANIMATION_DURATION_MS = 100 * ZOOM_ANIMATION_DURATION_SCALE;

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
  const legacy = (event.nativeEvent ?? event) as WheelEvent & { wheelDeltaY?: number };
  const wheelDeltaY = typeof legacy?.wheelDeltaY === "number" ? legacy.wheelDeltaY : 0;
  return wheelDeltaY !== 0 && Math.abs(wheelDeltaY % WHEEL_NOTCH_DELTA) === 0;
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
 * span, so `factor < 1` zooms in on both: the direction stays pxlogic's
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
  if (isPhysicalWheelZoom(event)) {
    const legacy = (event.nativeEvent ?? event) as WheelEvent & { wheelDeltaY?: number };
    const notches = Math.abs(legacy.wheelDeltaY as number) / WHEEL_NOTCH_DELTA;
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
