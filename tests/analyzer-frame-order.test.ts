import assert from "node:assert/strict";
import test from "node:test";
import { mergeAnalyzerTrackFrames, normalizeDecodedFrameOrder } from "../src/lib/analyzers.ts";
import type { AnalyzerTrackWindow, DecodedFrame } from "../src/lib/api.ts";

function frame(frameId: number, startSample: number): DecodedFrame {
  return {
    frame_id: frameId,
    start_sample: startSample,
    end_sample: startSample + 1,
    frame_type: "data",
    label: `F${frameId}`,
    value: frameId,
    channel_values: [],
    protocol_markers: [],
  };
}

test("decoded frame order normalization keeps already ordered arrays stable", () => {
  const frames = [frame(1, 10), frame(2, 20), frame(3, 20)];

  assert.equal(normalizeDecodedFrameOrder(frames), frames);
});

test("decoded frame order normalization sorts only when needed", () => {
  const frames = [frame(3, 30), frame(1, 10), frame(2, 20)];
  const ordered = normalizeDecodedFrameOrder(frames);

  assert.notEqual(ordered, frames);
  assert.deepEqual(
    ordered.map((item) => [item.frame_id, item.start_sample]),
    [
      [1, 10],
      [2, 20],
      [3, 30],
    ],
  );
  assert.deepEqual(
    frames.map((item) => item.frame_id),
    [3, 1, 2],
  );
});

test("large decoded frame merges use cached frame indexes", () => {
  const frames = Array.from({ length: 1_500 }, (_, index) => ({
    ...frame(index, index * 10),
    channel_values: [
      {
        channel: 0,
        label: `A${index}`,
        role: "A",
        texts: [`A${index}`],
        value: index,
      },
    ],
  }));
  const incoming = {
    ...frame(1_200, 12_000),
    channel_values: [
      {
        channel: 1,
        label: "B1200",
        role: "B",
        texts: ["B1200"],
        value: 1_200,
      },
    ],
  };
  const track: AnalyzerTrackWindow = {
    bubbles: [],
    channel: 1,
    frames: [incoming],
    next_frame: null,
    previous_frame: null,
    protocol_markers: [],
    role: "B",
  };

  const merged = mergeAnalyzerTrackFrames(frames, [track]);

  assert.notEqual(merged, frames);
  assert.equal(merged.length, frames.length);
  assert.deepEqual(
    merged[1_200].channel_values.map((value) => value.role),
    ["A", "B"],
  );
});

test("rendered analyzer frame cache trims around the incoming window", () => {
  const frames = Array.from({ length: 20 }, (_, index) => frame(index, index * 10));
  const track: AnalyzerTrackWindow = {
    bubbles: [],
    channel: 0,
    frames: [frames[12]],
    next_frame: frames[13],
    previous_frame: frames[11],
    protocol_markers: [],
    role: "Data",
  };

  const merged = mergeAnalyzerTrackFrames(frames, [track], 5);

  assert.notEqual(merged, frames);
  assert.equal(merged.length, 5);
  assert.deepEqual(
    merged.map((item) => item.frame_id),
    [10, 11, 12, 13, 14],
  );
});
