import assert from "node:assert/strict";
import test from "node:test";
import {
  captureDataWindow,
  maximumCaptureViewportSamples,
  normalizeCaptureViewport,
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
