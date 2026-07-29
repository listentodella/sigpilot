import assert from "node:assert/strict";
import test from "node:test";
import { analyzerViewportTransform } from "../src/lib/analyzerViewportTransform.ts";

test("analyzer overlay remains unchanged for an identical viewport", () => {
  assert.deepEqual(
    analyzerViewportTransform({ start: 100, samples: 1_000 }, { start: 100, samples: 1_000 }, 800),
    { scaleX: 1, translateX: 0 },
  );
});

test("analyzer overlay reuses its snapshot while zooming around the center", () => {
  assert.deepEqual(
    analyzerViewportTransform({ start: 0, samples: 1_000 }, { start: 250, samples: 500 }, 800),
    { scaleX: 2, translateX: -400 },
  );
});

test("analyzer overlay translates a cached viewport during a pan", () => {
  assert.deepEqual(
    analyzerViewportTransform({ start: 100, samples: 1_000 }, { start: 300, samples: 1_000 }, 800),
    { scaleX: 1, translateX: -160 },
  );
});
