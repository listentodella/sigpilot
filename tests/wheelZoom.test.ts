import assert from "node:assert/strict";
import test from "node:test";
import {
  isPhysicalWheelZoom,
  wheelZoomFactor,
  WHEEL_ZOOM_PER_NOTCH_POW2,
} from "../src/lib/wheelZoom.ts";

/** A wheel event as WebKit reports it: `wheelDeltaY` is `-3 * deltaY`. */
function webkitWheel(deltaY: number) {
  return { ctrlKey: false, deltaY, wheelDeltaY: -3 * deltaY } as never;
}

/** A wheel event as Chromium reports it: a fixed ±120 per notch. */
function chromiumWheel(wheelDeltaY: number) {
  return { ctrlKey: false, deltaY: wheelDeltaY < 0 ? 1 : -1, wheelDeltaY } as never;
}

test("a WebKit wheel notch is a notch, not a 0.15% nudge", () => {
  // Measured on the client: one notch arrives as deltaY=1, wheelDeltaY=-3.
  // Before this, the ±120 test could not match on WKWebView, so the event fell
  // to the touchpad curve and zoomed by exp(1 * 0.0015) = 1.0015.
  const event = webkitWheel(1);
  assert.equal(isPhysicalWheelZoom(event), true);
  // The factor multiplies the visible span, so one notch in is 2^-0.5.
  assert.equal(wheelZoomFactor(event, -1), Math.pow(2, -WHEEL_ZOOM_PER_NOTCH_POW2));
});

test("one WebKit event is one notch, however far macOS accelerated it", () => {
  // The client logged a single flick as deltaY 1, 7, 14, 22, 27 — macOS
  // accelerating the scroll. Counting those as notches zoomed about ninety
  // times per flick, which is worse than the bug it replaced.
  for (const deltaY of [1, 7, 14, 22, 27]) {
    assert.equal(
      wheelZoomFactor(webkitWheel(deltaY), -1),
      Math.pow(2, -WHEEL_ZOOM_PER_NOTCH_POW2),
      `deltaY=${deltaY} should still be one notch`,
    );
  }
  // So one flick of five events is five notches, not ninety times that. The
  // factor is a multiplier on the visible span, so the magnification is its
  // reciprocal.
  const span = [1, 7, 14, 22, 27].reduce(
    (span, deltaY) => span * wheelZoomFactor(webkitWheel(deltaY), -1),
    1,
  );
  const magnification = 1 / span;
  assert.ok(
    magnification > 5 && magnification < 6,
    `a five-event flick should magnify about 5.7x, got ${magnification}`,
  );
});

test("a Chromium wheel still uses its fixed 120-per-notch unit", () => {
  const event = chromiumWheel(-120);
  assert.equal(isPhysicalWheelZoom(event), true);
  assert.equal(wheelZoomFactor(event, -1), Math.pow(2, -WHEEL_ZOOM_PER_NOTCH_POW2));
  // Two notches in one event is two notches of zoom.
  assert.equal(
    wheelZoomFactor(chromiumWheel(-240), -1),
    Math.pow(2, -WHEEL_ZOOM_PER_NOTCH_POW2 * 2),
  );
});

test("a smooth trackpad stays on the pixel curve", () => {
  // Fractional delta and a wheelDeltaY that is not a multiple of it: neither
  // convention describes this, so it must keep the touchpad behaviour.
  const event = { ctrlKey: false, deltaY: 7.5, wheelDeltaY: -11 } as never;
  assert.equal(isPhysicalWheelZoom(event), false);
  assert.ok(wheelZoomFactor(event, 7.5) < 1.02);
});

test("a pinch gesture is never a notch", () => {
  const event = { ctrlKey: true, deltaY: 1, wheelDeltaY: -3 } as never;
  assert.equal(isPhysicalWheelZoom(event), false);
});
