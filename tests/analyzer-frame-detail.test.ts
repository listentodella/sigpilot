import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzerFrameDetailKey,
  analyzerFrameDetailNeighbors,
  resolveAnalyzerFrameDetail,
  type AnalyzerFrameDetailAnalyzer,
  type AnalyzerFrameDetailRow,
} from "../src/lib/analyzerFrameDetail.ts";
import type { DecodedFrame } from "../src/lib/api.ts";

function frame(frameId: number, label = `F${frameId}`): DecodedFrame {
  return {
    channel_values: [],
    end_sample: frameId * 10 + 9,
    frame_id: frameId,
    frame_type: "data",
    label,
    protocol_markers: [],
    start_sample: frameId * 10,
    value: frameId,
  };
}

function analyzer(
  id: string,
  frames: DecodedFrame[],
  extra: Partial<AnalyzerFrameDetailAnalyzer> = {},
): AnalyzerFrameDetailAnalyzer {
  return { decodedFrames: frames, id, ...extra };
}

function row(
  analyzerId: string,
  frameIndex: number,
  frameValue: DecodedFrame,
  frameNumber: number,
): AnalyzerFrameDetailRow {
  return {
    analyzer: { id: analyzerId },
    frame: frameValue,
    frameIndex,
    frameNumber,
  };
}

test("resolveAnalyzerFrameDetail prefers the analyzer's decoded frames", () => {
  const detail = resolveAnalyzerFrameDetail({
    analyzers: [analyzer("i2c", [frame(0), frame(1), frame(4, "local text")])],
    analyzerId: "i2c",
    frameIndex: 4,
    rows: [row("i2c", 4, frame(4, "row text"), 5)],
  });

  assert.equal(detail?.analyzerId, "i2c");
  assert.equal(detail?.frameIndex, 4);
  assert.equal(detail?.frame.label, "local text");
  // The stored position, matching the data table: the row's own number is not
  // copied over a frame that resolved from memory.
  assert.equal(detail?.frameNumber, 3);
});

test("resolveAnalyzerFrameDetail falls back to a table row", () => {
  const detail = resolveAnalyzerFrameDetail({
    analyzers: [analyzer("hla", [frame(7)])],
    analyzerId: "hla",
    frameIndex: 3,
    rows: [row("other", 3, frame(3, "wrong analyzer"), 4), row("hla", 3, frame(3, "row text"), 4)],
  });

  assert.equal(detail?.frame.label, "row text");
  assert.equal(detail?.frameNumber, 4);
});

test("resolveAnalyzerFrameDetail returns null when neither source matches", () => {
  assert.equal(
    resolveAnalyzerFrameDetail({
      analyzers: [analyzer("hla", [frame(0)])],
      analyzerId: "hla",
      frameIndex: 9,
      rows: [row("hla", 8, frame(8), 9)],
    }),
    null,
  );
  assert.equal(
    resolveAnalyzerFrameDetail({
      analyzers: [],
      analyzerId: null,
      frameIndex: null,
      rows: null,
    }),
    null,
  );
  assert.equal(
    resolveAnalyzerFrameDetail({
      analyzers: [analyzer("hla", [])],
      analyzerId: "missing",
      frameIndex: 0,
      rows: [],
    }),
    null,
  );
});

test("resolveAnalyzerFrameDetail matches the frame by id, not by array position", () => {
  const detail = resolveAnalyzerFrameDetail({
    analyzers: [analyzer("hla", [frame(7)], { decodedFrameCount: 900, decodedFramesComplete: false })],
    analyzerId: "hla",
    frameIndex: 7,
    rows: [],
  });

  assert.equal(detail?.frame.frame_id, 7);
  assert.equal(detail?.frameNumber, 1);
});

test("resolveAnalyzerFrameDetail keeps a 2000 character label verbatim", () => {
  const longLabel =
    "I2C @0x6A READ UI.MANIDL (0x00) 12 34 MANIDL: manid=18; ".repeat(40).slice(0, 2000);
  assert.equal(longLabel.length, 2000);

  const longFrame = { ...frame(12), label: longLabel };
  const allowed = resolveAnalyzerFrameDetail({
    analyzers: [analyzer("hla", [longFrame])],
    analyzerId: "hla",
    frameIndex: 12,
    rows: [],
  });
  const fromRows = resolveAnalyzerFrameDetail({
    analyzers: [],
    analyzerId: "hla",
    frameIndex: 12,
    rows: [row("hla", 12, longFrame, 13)],
  });

  assert.equal(allowed?.frame.label, longLabel);
  assert.equal(allowed?.frame.label.length, 2000);
  assert.equal(fromRows?.frame.label, longLabel);
  assert.equal(fromRows?.frame.label.length, 2000);
});

test("analyzerFrameDetailKey is stable and analyzer scoped", () => {
  assert.equal(analyzerFrameDetailKey("i2c", 12), "i2c:12");
  assert.equal(analyzerFrameDetailKey("i2c", 12), analyzerFrameDetailKey("i2c", 12));
  assert.notEqual(analyzerFrameDetailKey("i2c", 12), analyzerFrameDetailKey("spi", 12));
  assert.notEqual(analyzerFrameDetailKey("i2c", 12), analyzerFrameDetailKey("i2c", 13));
});

test("analyzerFrameDetailNeighbors clamps to the first and last frame", () => {
  const frames = [frame(0), frame(1), frame(2)];
  const source = analyzer("hla", frames);

  assert.deepEqual(analyzerFrameDetailNeighbors(source, 0), {
    frameCount: 3,
    nextIndex: 1,
    previousIndex: null,
  });
  assert.deepEqual(analyzerFrameDetailNeighbors(source, 1), {
    frameCount: 3,
    nextIndex: 2,
    previousIndex: 0,
  });
  assert.deepEqual(analyzerFrameDetailNeighbors(source, 2), {
    frameCount: 3,
    nextIndex: null,
    previousIndex: 1,
  });
  assert.deepEqual(analyzerFrameDetailNeighbors(source, 9), {
    frameCount: 3,
    nextIndex: null,
    previousIndex: 1,
  });
  assert.deepEqual(analyzerFrameDetailNeighbors(source, -4), {
    frameCount: 3,
    nextIndex: 1,
    previousIndex: null,
  });
});

test("analyzerFrameDetailNeighbors falls back to the loaded frame count", () => {
  const frames = [frame(0), frame(1)];
  assert.deepEqual(analyzerFrameDetailNeighbors({ decodedFrames: frames }, 0), {
    frameCount: 2,
    nextIndex: 1,
    previousIndex: null,
  });
  assert.deepEqual(analyzerFrameDetailNeighbors({ decodedFrames: frames, decodedFrameCount: 500 }, 4), {
    frameCount: 500,
    nextIndex: 5,
    previousIndex: 3,
  });
  assert.deepEqual(analyzerFrameDetailNeighbors(analyzer("hla", frames), 0), {
    frameCount: 2,
    nextIndex: 1,
    previousIndex: null,
  });
  assert.deepEqual(analyzerFrameDetailNeighbors(null, 0), {
    frameCount: 0,
    nextIndex: null,
    previousIndex: null,
  });
  assert.deepEqual(analyzerFrameDetailNeighbors({ decodedFrames: [] }, 0), {
    frameCount: 0,
    nextIndex: null,
    previousIndex: null,
  });
});

test("resolveAnalyzerFrameDetail numbers frames by stored position when ids have gaps", () => {
  // A decode that reaches MAX_DECODED_FRAMES drops every other frame, so the
  // stored ids are 0, 2, 4 while the data table numbers them 1, 2, 3.
  const frames = [frame(0), frame(2), frame(4, "decimated text")];
  const detail = resolveAnalyzerFrameDetail({
    analyzers: [analyzer("hla", frames, { decodedFrameCount: 5 })],
    analyzerId: "hla",
    frameIndex: 4,
    rows: [],
  });

  assert.equal(detail?.frame.label, "decimated text");
  assert.equal(detail?.frameIndex, 4);
  assert.equal(detail?.frameNumber, 3);
});

test("resolveAnalyzerFrameDetail falls back to the rendered track window", () => {
  const rendered = frame(12, "from rendered window");
  const detail = resolveAnalyzerFrameDetail({
    analyzers: [
      {
        decodedFrames: [],
        decodedFrameCount: 40_000,
        decodedFramesComplete: false,
        id: "saleae",
        renderedTracks: [{ frames: [frame(11), rendered], next_frame: null, previous_frame: null }],
      },
    ],
    analyzerId: "saleae",
    frameIndex: 12,
    rows: [],
  });

  assert.equal(detail?.frame.label, "from rendered window");
  assert.equal(detail?.frameNumber, 13);
});

test("resolveAnalyzerFrameDetail prefers stored frames over a rendered window", () => {
  const detail = resolveAnalyzerFrameDetail({
    analyzers: [
      {
        decodedFrames: [frame(3, "stored text")],
        id: "saleae",
        renderedTracks: [{ frames: [frame(3, "rendered text")] }],
      },
    ],
    analyzerId: "saleae",
    frameIndex: 3,
    rows: [],
  });

  assert.equal(detail?.frame.label, "stored text");
});

test("analyzerFrameDetailNeighbors walks the stored frames when ids have gaps", () => {
  const source = analyzer("hla", [frame(0), frame(2), frame(4)], { decodedFrameCount: 6 });

  assert.deepEqual(analyzerFrameDetailNeighbors(source, 2), {
    frameCount: 6,
    nextIndex: 4,
    previousIndex: 0,
  });
  assert.deepEqual(analyzerFrameDetailNeighbors(source, 4), {
    frameCount: 6,
    nextIndex: null,
    previousIndex: 2,
  });
});
