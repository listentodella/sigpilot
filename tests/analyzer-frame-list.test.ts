import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzerHasLazyNativeFramePlaceholder,
  analyzerUsesLazyNativeSummary,
  createAnalyzerInstance,
  lazyNativeAnalyzerFrameCount,
} from "../src/lib/analyzers.ts";
import {
  analyzerFrameListRowsForWindow,
  analyzerFrameListRowsFromRefs,
  analyzerFrameListChannelRoles,
  countAnalyzerFrameRows,
  filterAnalyzerFrameListRefs,
  findAnalyzerFrameById,
  findAnalyzerFramePositionById,
  findAnalyzerFrameRefPosition,
  findAnalyzerFrameRowPosition,
  type AnalyzerFrameListSource,
} from "../src/lib/analyzerFrameList.ts";
import type { DecodedFrame } from "../src/lib/api.ts";

interface TestAnalyzer {
  id: string;
  name: string;
}

function frame(frameId: number, startSample: number): DecodedFrame {
  return {
    channel_values: [],
    end_sample: startSample + 1,
    frame_id: frameId,
    frame_type: "data",
    label: `F${frameId}`,
    protocol_markers: [],
    start_sample: startSample,
    value: frameId,
  };
}

function frameWithRoles(frameId: number, startSample: number, roles: string[]): DecodedFrame {
  return {
    ...frame(frameId, startSample),
    channel_values: roles.map((role, index) => ({
      channel: index,
      label: `${role}${frameId}`,
      role,
      value: frameId + index,
    })),
  };
}

function source(
  analyzerId: string,
  starts: number[],
  enabled = true,
): AnalyzerFrameListSource<TestAnalyzer> {
  return {
    analyzer: { id: analyzerId, name: analyzerId },
    analyzerId,
    color: "#fff",
    decodedFrameCount: starts.length,
    decodedFrameCountEstimated: false,
    decodedFrames: starts.map((startSample, index) => frame(index + 100, startSample)),
    decodedFramesComplete: true,
    displayRadix: "Hexadecimal",
    enabled,
    name: analyzerId,
  };
}

test("analyzer frame windows merge enabled sources by time and source order", () => {
  const sources = [
    source("a", [0, 10, 20, 30, 40]),
    source("disabled", [1, 2, 3], false),
    source("b", [5, 10, 20, 35]),
  ];

  assert.equal(countAnalyzerFrameRows(sources), 9);

  const rows = analyzerFrameListRowsForWindow(sources, 2, 7);

  assert.deepEqual(
    rows.map((row) => `${row.analyzer.id}:${row.frame.start_sample}:#${row.frameNumber}`),
    ["a:10:#2", "b:10:#2", "a:20:#3", "b:20:#3", "a:30:#4"],
  );
});

test("analyzer frame row count can come from backend summary without local frames", () => {
  const sources = [
    source("complete", [0, 10, 20]),
    {
      ...source("summary", []),
      decodedFrameCount: 500,
      decodedFrames: [],
      decodedFramesComplete: false,
    },
  ];

  assert.equal(countAnalyzerFrameRows(sources), 503);
});

test("native analyzer lazy summary keeps data panes reachable without full decode", () => {
  const analyzer = createAnalyzerInstance("SPI", [], 0, "saleae_native");

  assert.equal(analyzerUsesLazyNativeSummary(analyzer.decoderBackend), true);
  assert.equal(analyzerUsesLazyNativeSummary("legacy_rust"), false);
  assert.equal(lazyNativeAnalyzerFrameCount(analyzer), 1);
  assert.equal(
    lazyNativeAnalyzerFrameCount({
      ...analyzer,
      decodedFrameCount: 128,
    }),
    128,
  );
  assert.equal(
    analyzerHasLazyNativeFramePlaceholder({
      ...analyzer,
      decodedFrameCount: 1,
      decodedFrames: [],
      decodedFramesComplete: false,
    }),
    true,
  );
  assert.equal(
    analyzerHasLazyNativeFramePlaceholder({
      ...analyzer,
      decodedFrameCount: 1,
      decodedFrames: [frame(1, 10)],
      decodedFramesComplete: false,
    }),
    false,
  );
  assert.equal(
    analyzerHasLazyNativeFramePlaceholder({
      ...analyzer,
      decodeProgress: 100,
      decodedFrameCount: 128,
      decodedFrames: [],
      decodedFramesComplete: false,
    }),
    false,
  );
});

test("native analyzer lazy placeholder does not count as table rows", () => {
  const sources = [
    source("complete", [0, 10]),
    {
      ...source("lazy", []),
      decodedFrameCount: 1,
      decodedFrameCountEstimated: true,
      decodedFrames: [],
      decodedFramesComplete: false,
    },
  ];

  assert.equal(countAnalyzerFrameRows(sources), 2);
  assert.deepEqual(
    analyzerFrameListRowsForWindow(sources, 0, 5).map((row) => row.analyzer.id),
    ["complete", "complete"],
  );
});

test("analyzer frame row lookup honors same-sample tie breaking", () => {
  const sources = [
    source("a", [0, 10, 20, 30, 40]),
    source("b", [5, 10, 20, 35]),
  ];

  assert.equal(findAnalyzerFrameRowPosition(sources, "a", 101), 2);
  assert.equal(findAnalyzerFrameRowPosition(sources, "b", 101), 3);
  assert.equal(findAnalyzerFrameRowPosition(sources, "b", 102), 5);
  assert.equal(findAnalyzerFrameRowPosition(sources, "missing", 101), -1);
});

test("analyzer frame search refs can be windowed without materializing all rows", () => {
  const sources = [
    source("a", [0, 10, 20, 30, 40]),
    source("b", [5, 10, 20, 35]),
  ];

  const refs = filterAnalyzerFrameListRefs(sources, (row) => row.frame.start_sample >= 20);

  assert.equal(findAnalyzerFrameRefPosition(sources, refs, "a", 102), 0);
  assert.equal(findAnalyzerFrameRefPosition(sources, refs, "b", 102), 1);

  const rows = analyzerFrameListRowsFromRefs(sources, refs, 1, 4);
  assert.deepEqual(
    rows.map((row) => `${row.analyzer.id}:${row.frame.start_sample}`),
    ["b:20", "a:30", "b:35"],
  );
});

test("analyzer frame windows can jump directly into a large merged list", () => {
  const even = Array.from({ length: 10_000 }, (_, index) => index * 2);
  const odd = Array.from({ length: 10_000 }, (_, index) => index * 2 + 1);
  const sources = [source("even", even), source("odd", odd)];

  const rows = analyzerFrameListRowsForWindow(sources, 19_990, 20_000);

  assert.deepEqual(
    rows.map((row) => `${row.analyzer.id}:${row.frame.start_sample}`),
    [
      "even:19990",
      "odd:19991",
      "even:19992",
      "odd:19993",
      "even:19994",
      "odd:19995",
      "even:19996",
      "odd:19997",
      "even:19998",
      "odd:19999",
    ],
  );
});

test("analyzer frame channel roles preserve first-seen order across sources", () => {
  const sources = [
    {
      ...source("a", []),
      decodedFrames: [
        frameWithRoles(1, 0, ["MOSI", "Clock"]),
        frameWithRoles(2, 10, ["MISO", "MOSI"]),
      ],
    },
    {
      ...source("b", []),
      decodedFrames: [frameWithRoles(3, 20, ["Ack", "Clock"])],
    },
  ];

  assert.deepEqual(analyzerFrameListChannelRoles(sources), ["MOSI", "Clock", "MISO", "Ack"]);
});

test("analyzer frame id lookup indexes decoded frame arrays", () => {
  const frames = [frame(42, 0), frame(7, 5), frame(100, 10)];

  assert.equal(findAnalyzerFrameById(frames, 7), frames[1]);
  assert.equal(findAnalyzerFrameById(frames, 9), null);
  assert.equal(findAnalyzerFramePositionById(frames, 100), 2);
  assert.equal(findAnalyzerFramePositionById(frames, 9), -1);
});
