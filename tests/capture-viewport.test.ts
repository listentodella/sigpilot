import assert from "node:assert/strict";
import test from "node:test";
import {
  captureDataWindow,
  maximumCaptureViewportSamples,
  maximumDataViewportSamples,
  maximumLiveCaptureViewportSamples,
  minimumViewportSamples,
  normalizeCaptureViewport,
  normalizeLiveCaptureViewport,
} from "../src/lib/captureViewport.ts";

test("DataLimited zoom permits a viewport 2.5 times wider than the capture", () => {
  assert.equal(maximumCaptureViewportSamples(1_000), 2_500);
  assert.deepEqual(normalizeCaptureViewport(-750, 10_000, 1_000), {
    samples: 2_500,
    start: -750,
  });
});

test("DataLimited pan keeps at least 40 percent captured data visible", () => {
  assert.deepEqual(normalizeCaptureViewport(-10_000, 500, 1_000), {
    samples: 500,
    start: -300,
  });
  assert.deepEqual(normalizeCaptureViewport(10_000, 500, 1_000), {
    samples: 500,
    start: 800,
  });
});

test("viewport normalization preserves a fractional zoom anchor", () => {
  assert.deepEqual(normalizeCaptureViewport(125.25, 500.5, 10_000), {
    start: 125.25,
    samples: 500.5,
  });
});

test("a completed capture can preserve the wider viewport selected while recording", () => {
  assert.deepEqual(
    normalizeCaptureViewport(0, 500_000_000, 1_000_000, 500_000_000),
    { samples: 500_000_000, start: 0 },
  );
  assert.deepEqual(
    normalizeCaptureViewport(0, 900_000_000, 1_000_000, 500_000_000),
    { samples: 500_000_000, start: 0 },
  );
  assert.equal(normalizeCaptureViewport(0, 500_000_000, 1_000_000).samples, 2_500_000);
});

test("live capture reserves a 500 second zoom-out range", () => {
  assert.equal(maximumLiveCaptureViewportSamples(1_000_000, 1_000_000), 500_000_000);
  assert.deepEqual(
    normalizeLiveCaptureViewport(-200_000_000, 900_000_000, 1_000_000, 1_000_000),
    { samples: 500_000_000, start: 0 },
  );
});

test("loaded data uses the same 500 second zoom-out range as capture", () => {
  const maximum = maximumDataViewportSamples(1_000_000, 1_000_000);
  assert.equal(maximum, 500_000_000);
  assert.deepEqual(
    normalizeCaptureViewport(200_000, 900_000_000, 1_000_000, maximum),
    { samples: 500_000_000, start: 0 },
  );
});

test("live wide viewports stay left anchored as capture data grows", () => {
  const initial = normalizeLiveCaptureViewport(0, 500_000_000, 2_000_000, 1_000_000);
  const growing = normalizeLiveCaptureViewport(
    initial.start,
    initial.samples,
    20_000_000,
    1_000_000,
  );
  assert.deepEqual(initial, { samples: 500_000_000, start: 0 });
  assert.deepEqual(growing, { samples: 500_000_000, start: 0 });
});

test("backend data windows exclude viewport whitespace", () => {
  assert.deepEqual(captureDataWindow(-750, 2_500, 1_000), {
    end: 1_000,
    samples: 1_000,
    start: 0,
  });
  assert.deepEqual(captureDataWindow(-100, 500, 1_000), {
    end: 400,
    samples: 400,
    start: 0,
  });
});

test("the minimum span stays finite for any sample rate", () => {
  // `Math.max(1, NaN)` is NaN, not 1. A non-finite rate used to put NaN straight
  // into `viewportSamples`, which serialises to `null` in the frame request (the
  // backend rejects the whole frame) and paints NaN into every width derived from
  // the viewport, the scrollbar included.
  for (const rate of [Number.NaN, 0, -1, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    const minimum = minimumViewportSamples(rate);
    assert.ok(Number.isFinite(minimum), `expected a finite minimum for rate ${rate}, got ${minimum}`);
    assert.ok(minimum >= 1, `expected a minimum of at least one sample for rate ${rate}, got ${minimum}`);
  }

  // A real rate still scales: 5 µs at 100 MHz is 500 samples. Compared with a
  // tolerance because 100_000_000 * 5e-6 is 500.00000000000006 in binary floating
  // point, which is not the interesting part of this test.
  const scaled = minimumViewportSamples(100_000_000);
  assert.ok(Math.abs(scaled - 500) < 1e-6, `expected ~500 samples at 100 MHz, got ${scaled}`);
});

test("a finished capture is framed by its own length, not the live reserve", () => {
  // The real numbers from the reproduction: 9.54 s at 25 MHz. The live ceiling
  // is 500 s — 12.5 billion samples — and while the capture streams that is a
  // legitimate window to be looking at.
  const totalSamples = 238_551_040;
  const sampleRateHz = 25_000_000;
  const liveCeiling = maximumLiveCaptureViewportSamples(totalSamples, sampleRateHz);
  assert.equal(liveCeiling, 12_500_000_000);

  // When the capture ends, the same window is re-pinned — and it must come back
  // bounded by the data. Preserved as-is, a nine-second capture is framed at five
  // hundred seconds: the trace is squeezed into a fortieth of the window and the
  // bus disturbance the user was looking for is a sub-pixel sliver. The overview
  // zoom exists precisely to rule that out.
  const finishedCeiling = maximumCaptureViewportSamples(totalSamples);
  assert.equal(finishedCeiling, 596_377_600);

  const pinned = normalizeCaptureViewport(0, liveCeiling, totalSamples, finishedCeiling);
  assert.equal(pinned.samples, finishedCeiling);
  // Still 2.5x the data, so the capture keeps its familiar proportion.
  assert.equal(pinned.samples / totalSamples, 2.5);
  assert.equal(pinned.start, 0);

  // A window the user had panned keeps its position, only its width is pulled in.
  const panned = normalizeCaptureViewport(-100_000_000, liveCeiling, totalSamples, finishedCeiling);
  assert.equal(panned.samples, finishedCeiling);
  assert.equal(panned.start, -100_000_000);
});
