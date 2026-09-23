import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzerCanRenderTracksLocally,
  buildLocalAnalyzerTrackWindow,
  decodedFramesForAnalyzerTrack,
  localProtocolMarkersForAnalyzerTrack,
  protocolMarkersForAnalyzerTrack,
  reuseAnalyzerTrackWindows,
} from "../src/lib/analyzerTrackWindows.ts";
import { createAnalyzerInstance } from "../src/lib/analyzers.ts";
import { buildAnalyzerFrameWindow } from "../src/lib/api.ts";
import type { AnalyzerTrackWindow, DecodedFrame } from "../src/lib/api.ts";

const frames: DecodedFrame[] = [
  {
    frame_id: 1,
    start_sample: 10,
    end_sample: 20,
    frame_type: "address",
    label: "Address 0x20 Write ACK",
    value: 0x40,
    channel_values: [
      { channel: 0, role: "SDA", label: "Setup Write to [0x20] + ACK", value: 0x40 },
      { channel: 1, role: "SCL", label: "Clock", value: 1 },
    ],
    protocol_markers: [
      { channel: 0, sample: 10, kind: "start" },
      { channel: 1, sample: 12, kind: "up_arrow" },
    ],
  },
  {
    frame_id: 2,
    start_sample: 40,
    end_sample: 50,
    frame_type: "data",
    label: "Data 0x0E ACK",
    value: 0x0e,
    channel_values: [
      { channel: 0, role: "SDA", label: "0x0E + ACK", value: 0x0e },
    ],
    protocol_markers: [
      { channel: 0, sample: 46, kind: "dot" },
      { channel: null, sample: 48, kind: "error_dot" },
    ],
  },
];

test("local analyzer track frames are role-filtered and cached by decoded frame array", () => {
  const first = decodedFramesForAnalyzerTrack(frames, { channel: 0, role: "SDA" });
  const second = decodedFramesForAnalyzerTrack(frames, { channel: 0, role: "SDA" });
  assert.equal(first, second);
  assert.deepEqual(
    first.map((frame) => [frame.frame_id, frame.label, frame.channel_values.length]),
    [
      [1, "Setup Write to [0x20] + ACK", 1],
      [2, "0x0E + ACK", 1],
    ],
  );
});

test("local analyzer track frames prefer exact roles and fall back to the channel value", () => {
  const mixedRoleFrames: DecodedFrame[] = [
    {
      ...frames[0],
      frame_id: 10,
      channel_values: [
        { channel: 0, role: "MOSI", label: "MOSI 0x12", value: 0x12 },
        { channel: 0, role: "MISO", label: "MISO 0x34", value: 0x34 },
      ],
    },
    {
      ...frames[1],
      frame_id: 11,
      channel_values: [
        { channel: 0, role: "DATA", label: "DATA 0x56", value: 0x56 },
      ],
    },
  ];

  assert.deepEqual(
    decodedFramesForAnalyzerTrack(mixedRoleFrames, { channel: 0, role: "MISO" }).map((frame) => [
      frame.frame_id,
      frame.label,
      frame.channel_values[0].role,
    ]),
    [
      [10, "MISO 0x34", "MISO"],
      [11, "DATA 0x56", "DATA"],
    ],
  );
});

test("local analyzer track index skips duplicate exact channel roles per frame", () => {
  const duplicateRoleFrames: DecodedFrame[] = [
    {
      ...frames[0],
      frame_id: 20,
      channel_values: [
        { channel: 0, role: "DATA", label: "first", value: 1 },
        { channel: 0, role: "DATA", label: "second", value: 2 },
      ],
    },
  ];

  const trackFrames = decodedFramesForAnalyzerTrack(duplicateRoleFrames, { channel: 0, role: "DATA" });
  assert.deepEqual(
    trackFrames.map((frame) => [frame.frame_id, frame.label, frame.channel_values[0].value]),
    [[20, "first", 1]],
  );
});

test("local analyzer protocol markers keep the selected channel only", () => {
  assert.deepEqual(localProtocolMarkersForAnalyzerTrack(frames, { channel: 0, role: "SDA" }, 0, 100), [
    { sample: 10, kind: "start" },
    { sample: 46, kind: "dot" },
  ]);
});

test("local analyzer protocol markers are cached and sliced by viewport", () => {
  const first = protocolMarkersForAnalyzerTrack(frames, { channel: 0, role: "SDA" });
  const second = protocolMarkersForAnalyzerTrack(frames, { channel: 0, role: "SDA" });
  assert.equal(first, second);
  assert.deepEqual(localProtocolMarkersForAnalyzerTrack(frames, { channel: 0, role: "SDA" }, 30, 40), [
    { sample: 46, kind: "dot" },
  ]);
});

test("local analyzer protocol markers sort and deduplicate unordered decoder output", () => {
  const unorderedFrames: DecodedFrame[] = [
    {
      ...frames[0],
      protocol_markers: [
        { channel: 0, sample: 80, kind: "stop" },
        { channel: 0, sample: 10, kind: "start" },
        { channel: 0, sample: 10, kind: "start" },
        { channel: 0, sample: 50, kind: "dot" },
      ],
    },
  ];
  assert.deepEqual(localProtocolMarkersForAnalyzerTrack(unorderedFrames, { channel: 0, role: "SDA" }, 0, 100), [
    { sample: 10, kind: "start" },
    { sample: 50, kind: "dot" },
    { sample: 80, kind: "stop" },
  ]);
});

test("local analyzer protocol markers sample dense windows without exceeding the marker limit", () => {
  const denseFrames: DecodedFrame[] = Array.from({ length: 400 }, (_, index) => ({
    frame_id: index,
    start_sample: index * 10,
    end_sample: index * 10 + 1,
    frame_type: "bit",
    label: `${index % 2}`,
    value: index % 2,
    channel_values: [{ channel: 0, role: "SWDIO", label: `${index % 2}`, value: index % 2 }],
    protocol_markers: [{ channel: 0, sample: index * 10, kind: index % 2 === 0 ? "zero" : "one" }],
  }));
  const markers = localProtocolMarkersForAnalyzerTrack(denseFrames, { channel: 0, role: "SWDIO" }, 0, 4_000);
  assert.equal(markers.length, 300);
  assert.deepEqual(markers[0], { sample: 0, kind: "zero" });
  assert.deepEqual(markers[markers.length - 1], { sample: 3_990, kind: "one" });
});

test("local analyzer windows reuse the shared bubble aggregation path", () => {
  const window = buildLocalAnalyzerTrackWindow(frames, { channel: 0, role: "SDA" }, 0, 100, 200);
  assert.equal(window.channel, 0);
  assert.equal(window.role, "SDA");
  assert.equal(window.frames.length, 0);
  assert.deepEqual(window.frame_refs?.map((frame) => frame.start_sample), [10, 40]);
  assert.equal(window.bubbles.length, 2);
  assert.equal(window.protocol_markers.length, 2);
});

test("high zoom keeps dense decoded frames as individual bubbles", () => {
  const denseFrames: DecodedFrame[] = Array.from({ length: 1_201 }, (_, frameId) => ({
    frame_id: frameId,
    start_sample: frameId * 5,
    end_sample: frameId * 5 + 100,
    frame_type: "data",
    label: `0x${(frameId & 0xff).toString(16).padStart(2, "0")}`,
    value: frameId & 0xff,
    channel_values: [],
    protocol_markers: [],
  }));

  const window = buildAnalyzerFrameWindow(denseFrames, 0, 10_000, 2_000);

  assert.equal(window.bubbles.length, denseFrames.length);
  assert.ok(window.bubbles.every((bubble) => bubble.type === "SingleBubble"));

  const overview = buildAnalyzerFrameWindow(denseFrames, 0, 10_000, 100);
  assert.equal(overview.bubbles.length, 1);
  assert.equal(overview.bubbles[0].type, "MultiBubble");
  assert.equal(overview.bubbles[0].result_count, denseFrames.length);
});

test("local analyzer protocol markers synthesize I2C start and stop fallbacks", () => {
  const fallbackFrames: DecodedFrame[] = [
    { ...frames[0], frame_type: "start", protocol_markers: [] },
    { ...frames[1], frame_type: "stop", protocol_markers: [] },
  ];
  assert.deepEqual(
    localProtocolMarkersForAnalyzerTrack(fallbackFrames, { channel: 0, role: "SDA" }, 0, 100),
    [
      { sample: 10, kind: "start" },
      { sample: 40, kind: "stop" },
    ],
  );
});

test("local analyzer protocol markers fall back per viewport, not per full capture", () => {
  const mixedFrames: DecodedFrame[] = [
    { ...frames[0], frame_type: "start", protocol_markers: [] },
    {
      ...frames[1],
      start_sample: 80,
      end_sample: 90,
      protocol_markers: [{ channel: 0, sample: 86, kind: "dot" }],
    },
  ];
  assert.deepEqual(
    localProtocolMarkersForAnalyzerTrack(mixedFrames, { channel: 0, role: "SDA" }, 0, 30),
    [{ sample: 10, kind: "start" }],
  );
  assert.deepEqual(
    localProtocolMarkersForAnalyzerTrack(mixedFrames, { channel: 0, role: "SDA" }, 70, 30),
    [{ sample: 86, kind: "dot" }],
  );
});

test("local analyzer rendering is gated by decoded settings signature and live state", () => {
  const analyzer = {
    ...createAnalyzerInstance("I2C", [], 0, "saleae_native"),
    decodedFrameCount: frames.length,
    decodedFrames: frames,
    decodedFramesComplete: true,
    decodedDecodeSignature: "current",
  };
  assert.equal(analyzerCanRenderTracksLocally(analyzer, "current", false), true);
  assert.equal(analyzerCanRenderTracksLocally(analyzer, "old", false), false);
  assert.equal(analyzerCanRenderTracksLocally(analyzer, "current", true), false);
  assert.equal(
    analyzerCanRenderTracksLocally({ ...analyzer, decodedFramesComplete: false }, "current", false),
    false,
  );
});

test("local analyzer track windows reuse unchanged array and track objects", () => {
  const previous = [
    trackWindow(0, "SDA", [{ sample: 10, kind: "start" }]),
    trackWindow(1, "SCL", [{ sample: 12, kind: "up_arrow" }]),
  ];
  const same = [
    trackWindow(0, "SDA", [{ sample: 10, kind: "start" }]),
    trackWindow(1, "SCL", [{ sample: 12, kind: "up_arrow" }]),
  ];
  assert.equal(reuseAnalyzerTrackWindows(previous, same), previous);

  const changed = [
    trackWindow(0, "SDA", [{ sample: 10, kind: "start" }]),
    trackWindow(1, "SCL", [{ sample: 20, kind: "up_arrow" }]),
  ];
  const reused = reuseAnalyzerTrackWindows(previous, changed);
  assert.notEqual(reused, previous);
  assert.equal(reused[0], previous[0]);
  assert.notEqual(reused[1], previous[1]);
});

test("local analyzer track windows reuse keyed objects when order changes", () => {
  const previous = [
    trackWindow(0, "SDA", [{ sample: 10, kind: "start" }]),
    trackWindow(1, "SCL", [{ sample: 12, kind: "up_arrow" }]),
  ];
  const reordered = [
    trackWindow(1, "SCL", [{ sample: 12, kind: "up_arrow" }]),
    trackWindow(0, "SDA", [{ sample: 10, kind: "start" }]),
  ];

  const reused = reuseAnalyzerTrackWindows(previous, reordered);

  assert.notEqual(reused, previous);
  assert.equal(reused[0], previous[1]);
  assert.equal(reused[1], previous[0]);
});

test("local analyzer track windows compare lightweight frame refs", () => {
  const previous = [
    {
      ...trackWindow(0, "SDA", []),
      frame_refs: [{ frame_id: 1, start_sample: 10, end_sample: 20 }],
      previous_frame_ref: { frame_id: 0, start_sample: 0, end_sample: 5 },
      next_frame_ref: { frame_id: 2, start_sample: 30, end_sample: 40 },
    },
  ];
  const same = [
    {
      ...trackWindow(0, "SDA", []),
      frame_refs: [{ frame_id: 1, start_sample: 10, end_sample: 20 }],
      previous_frame_ref: { frame_id: 0, start_sample: 0, end_sample: 5 },
      next_frame_ref: { frame_id: 2, start_sample: 30, end_sample: 40 },
    },
  ];
  const changed = [
    {
      ...trackWindow(0, "SDA", []),
      frame_refs: [{ frame_id: 1, start_sample: 12, end_sample: 20 }],
      previous_frame_ref: { frame_id: 0, start_sample: 0, end_sample: 5 },
      next_frame_ref: { frame_id: 2, start_sample: 30, end_sample: 40 },
    },
  ];

  assert.equal(reuseAnalyzerTrackWindows(previous, same), previous);
  assert.notEqual(reuseAnalyzerTrackWindows(previous, changed), previous);
});

function trackWindow(
  channel: number,
  role: string,
  protocolMarkers: AnalyzerTrackWindow["protocol_markers"],
): AnalyzerTrackWindow {
  return {
    bubbles: [
      {
        display_text: ["0x01"],
        end_sample: 20,
        frame_id_interval: { begin: 1, end: 2 },
        result_count: 1,
        start_sample: 10,
        type: "SingleBubble",
      },
    ],
    channel,
    frames: [],
    next_frame: null,
    previous_frame: null,
    protocol_markers: protocolMarkers,
    role,
  };
}
