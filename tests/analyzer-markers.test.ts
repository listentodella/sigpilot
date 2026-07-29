import assert from "node:assert/strict";
import test from "node:test";
import {
  ANALYZER_MARKER_MAXIMUM_RESULTS,
  visibleAnalyzerMarkerSamples,
} from "../src/lib/analyzerMarkers.ts";

test("dense analyzer edges are omitted instead of sampled into arrows", () => {
  const edges = Array.from({ length: 100 }, (_, index) => index * 10);
  assert.deepEqual(visibleAnalyzerMarkerSamples(edges, 0, 1_000, 1_000), []);
});

test("isolated analyzer edges remain visible", () => {
  assert.deepEqual(
    visibleAnalyzerMarkerSamples([10, 100, 200, 290], 0, 300, 300),
    [10, 100, 200, 290],
  );
});

test("offscreen neighbors suppress markers near a viewport edge", () => {
  assert.deepEqual(visibleAnalyzerMarkerSamples([95, 100, 200], 100, 100, 100), [200]);
});

test("analyzer marker count retains Logic 2's upper bound", () => {
  const edges = Array.from({ length: 500 }, (_, index) => index * 20);
  assert.equal(
    visibleAnalyzerMarkerSamples(edges, 0, 10_000, 10_000).length,
    ANALYZER_MARKER_MAXIMUM_RESULTS,
  );
});
