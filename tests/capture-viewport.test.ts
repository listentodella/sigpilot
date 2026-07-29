import assert from "node:assert/strict";
import test from "node:test";
import {
  captureDataWindow,
  maximumLiveCaptureViewportSamples,
  maximumCaptureViewportSamples,
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

test("live capture reserves a 500 second zoom-out range", () => {
  assert.equal(maximumLiveCaptureViewportSamples(1_000_000, 1_000_000), 500_000_000);
  assert.deepEqual(
    normalizeLiveCaptureViewport(-200_000_000, 900_000_000, 1_000_000, 1_000_000),
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
