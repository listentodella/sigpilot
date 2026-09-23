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
  const legacy = (event.nativeEvent ?? event) as WheelEvent & { wheelDeltaY?: number };
  const wheelDeltaY = typeof legacy?.wheelDeltaY === "number" ? legacy.wheelDeltaY : 0;

  // macOS pinch gestures set ctrlKey *and* report wheelDeltaY of ±120, exactly
  // like a clicky wheel. Deciding pinch first stops a pinch becoming a notch.
  const isPinch = event.ctrlKey;

  if (!isPinch && wheelDeltaY !== 0 && Math.abs(wheelDeltaY % WHEEL_NOTCH_DELTA) === 0) {
    const notches = Math.abs(wheelDeltaY) / WHEEL_NOTCH_DELTA;
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
