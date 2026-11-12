import assert from "node:assert/strict";
import test from "node:test";
import type { WaveformAnnotation } from "../src/lib/api.ts";
import { drawWaveformAnnotationIcon } from "../src/lib/waveformAnnotationDrawing.ts";
import {
  WAVEFORM_ANNOTATION_NOTE_LIMIT,
  WAVEFORM_ANNOTATION_SHAPES,
  WAVEFORM_ANNOTATION_TITLE_LIMIT,
  clampWaveformAnnotationSample,
  layoutWaveformAnnotations,
  normalizeWaveformAnnotations,
  trimWaveformAnnotations,
  waveformAnnotationDragSample,
} from "../src/lib/waveformAnnotations.ts";

function annotation(patch: Partial<WaveformAnnotation> = {}): WaveformAnnotation {
  return {
    id: "annotation-1",
    sample: 100,
    channel: 1,
    shape: "flag",
    color: "#53a9fd",
    title: "Enter HDR-DDR",
    note: "Confirm the mode change",
    ...patch,
  };
}

function recordingContext() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const stack: Array<Record<string, unknown>> = [];
  const state: Record<string, unknown> = {
    strokeStyle: "#initial",
    fillStyle: "#initial",
    lineWidth: 1,
    lineJoin: "miter",
    lineCap: "butt",
  };
  const context = new Proxy(state, {
    get(target, key) {
      if (key in target) return target[key as string];
      return (...args: unknown[]) => {
        calls.push({ method: String(key), args });
        if (key === "save") stack.push({ ...state });
        if (key === "restore") {
          const saved = stack.pop();
          assert.ok(saved, "restore must have a matching save");
          for (const name of Object.keys(state)) delete state[name];
          Object.assign(state, saved);
        }
      };
    },
  }) as unknown as CanvasRenderingContext2D;
  return { context, calls, stack, state };
}

test("normalizeWaveformAnnotations accepts valid entries and rejects untrusted ones", () => {
  const accepted = normalizeWaveformAnnotations(
    [
      annotation(),
      annotation({ id: "annotation-2", sample: 0, channel: 0, shape: "warning", note: "" }),
    ],
    1_000,
    8,
  );
  assert.deepEqual(accepted.map((item) => item.id), ["annotation-1", "annotation-2"]);

  const rejected = normalizeWaveformAnnotations(
    [
      null,
      "flag",
      annotation({ id: "" }),
      annotation({ id: "annotation-1", sample: -1 }),
      annotation({ id: "annotation-3", sample: 1_000 }),
      annotation({ id: "annotation-4", sample: 12.5 }),
      annotation({ id: "annotation-5", channel: 8 }),
      annotation({ id: "annotation-6", channel: -1 }),
      annotation({ id: "annotation-7", channel: 1.5 }),
      annotation({ id: "annotation-8", shape: "star" as WaveformAnnotation["shape"] }),
      annotation({ id: "annotation-9", color: "red" }),
      annotation({ id: "annotation-10", color: "#fff" }),
      annotation({ id: "annotation-11", title: "   " }),
    ],
    1_000,
    8,
  );
  assert.deepEqual(rejected, []);

  const deduped = normalizeWaveformAnnotations(
    [annotation({ id: "dup", sample: 10 }), annotation({ id: "dup", sample: 20 })],
    1_000,
    8,
  );
  assert.deepEqual(deduped.map((item) => [item.id, item.sample]), [["dup", 10]]);
  assert.deepEqual(normalizeWaveformAnnotations([annotation()], 0, 8), []);
  assert.deepEqual(normalizeWaveformAnnotations([annotation()], 1_000, 0), []);
  assert.deepEqual(normalizeWaveformAnnotations("nope", 1_000, 8), []);
});

test("imported titles and notes are trimmed and length-capped", () => {
  const [imported] = normalizeWaveformAnnotations(
    [
      annotation({
        title: `  ${"x".repeat(WAVEFORM_ANNOTATION_TITLE_LIMIT + 40)}  `,
        note: "n".repeat(WAVEFORM_ANNOTATION_NOTE_LIMIT + 100),
      }),
    ],
    1_000,
    8,
  );
  assert.equal(imported.title.length, WAVEFORM_ANNOTATION_TITLE_LIMIT);
  assert.equal(imported.note.length, WAVEFORM_ANNOTATION_NOTE_LIMIT);
  assert.ok(!imported.title.startsWith(" "));
});

test("samples clamp into the capture instead of landing outside it", () => {
  assert.equal(clampWaveformAnnotationSample(-40, 500), 0);
  assert.equal(clampWaveformAnnotationSample(499.6, 500), 499);
  assert.equal(clampWaveformAnnotationSample(5_000, 500), 499);
  assert.equal(clampWaveformAnnotationSample(Number.NaN, 500), 0);
  assert.equal(clampWaveformAnnotationSample(12, Number.POSITIVE_INFINITY), 0);
  assert.equal(clampWaveformAnnotationSample(12, 0), 0);
});

test("trimming drops discarded annotations and re-anchors the survivors", () => {
  const trimmed = trimWaveformAnnotations(
    [
      annotation({ id: "before", sample: 99 }),
      annotation({ id: "first", sample: 100 }),
      annotation({ id: "middle", sample: 250 }),
      annotation({ id: "last", sample: 399 }),
      annotation({ id: "after", sample: 400 }),
    ],
    100,
    300,
  );
  assert.deepEqual(
    trimmed.map((item) => [item.id, item.sample]),
    [["first", 0], ["middle", 150], ["last", 299]],
  );
  assert.deepEqual(trimWaveformAnnotations([annotation({ sample: 5 })], 10, 100), []);
});

test("dragging converts pixels to samples and never leaves the capture", () => {
  // 1000 px wide showing 500 samples: one pixel is half a sample.
  assert.equal(waveformAnnotationDragSample(200, 100, 1_000, 500, 4_000), 250);
  assert.equal(waveformAnnotationDragSample(200, -10_000, 1_000, 500, 4_000), 0);
  assert.equal(waveformAnnotationDragSample(200, 10_000, 1_000, 500, 4_000), 3_999);
  assert.equal(waveformAnnotationDragSample(200, 50, 0, 500, 4_000), 200);
  assert.equal(waveformAnnotationDragSample(200, 50, 1_000, Number.NaN, 4_000), 200);
});

test("layout anchors each annotation to its channel row and viewport sample", () => {
  const layouts = layoutWaveformAnnotations(
    [
      annotation({ id: "a", sample: 100, channel: 0 }),
      annotation({ id: "b", sample: 250, channel: 1 }),
      annotation({ id: "offscreen", sample: 2_000, channel: 1 }),
    ],
    [0, 1],
    [100, 100],
    [0, 0],
    0,
    1_000,
    1_000,
    null,
  );
  assert.deepEqual(layouts.map((layout) => layout.annotation.id), ["a", "b"]);
  assert.deepEqual(layouts.map((layout) => [layout.x, layout.y]), [[100, 13], [250, 117]]);
  assert.deepEqual(layouts.map((layout) => layout.titleWidth), [160, 160]);
  assert.deepEqual(layouts.map((layout) => layout.titleSide), ["right", "right"]);
  assert.deepEqual(layouts.map((layout) => layout.stemHeight), [26, 26]);
});

test("crowded titles collapse while the symbols stay", () => {
  const layouts = layoutWaveformAnnotations(
    [annotation({ id: "a", sample: 100 }), annotation({ id: "b", sample: 110 })],
    [1],
    [100],
    [0],
    0,
    1_000,
    1_000,
    null,
  );
  assert.deepEqual(layouts.map((layout) => layout.titleWidth), [0, 160]);
  assert.deepEqual(layouts.map((layout) => layout.x), [100, 110]);
});

test("a selected annotation near the right edge flips its title inward", () => {
  const near = layoutWaveformAnnotations(
    [annotation({ id: "a", sample: 980, channel: 1 })],
    [1],
    [100],
    [0],
    0,
    1_000,
    1_000,
    "a",
  );
  assert.equal(near[0].titleSide, "left");
  assert.equal(near[0].titleWidth, 160);

  const unselected = layoutWaveformAnnotations(
    [annotation({ id: "a", sample: 980, channel: 1 })],
    [1],
    [100],
    [0],
    0,
    1_000,
    1_000,
    null,
  );
  assert.equal(unselected[0].titleSide, "right");
});

test("row top insets move annotations with their row", () => {
  const [layout] = layoutWaveformAnnotations(
    [annotation({ sample: 0, channel: 0 })],
    [0],
    [100],
    [12],
    0,
    1_000,
    1_000,
    null,
  );
  assert.equal(layout.y, 25);
  assert.equal(layout.stemHeight, 20);
});

test("degenerate layout inputs produce no annotations instead of NaN positions", () => {
  const layouts = layoutWaveformAnnotations(
    [annotation()],
    [1],
    [100],
    [0],
    0,
    0,
    0,
    null,
  );
  assert.deepEqual(layouts, []);
});

test("every annotation shape draws a distinct outlined symbol", () => {
  const signatures = new Map<string, string>();
  for (const shape of WAVEFORM_ANNOTATION_SHAPES) {
    const { context, calls, stack, state } = recordingContext();
    drawWaveformAnnotationIcon(context, shape, "#58c667");

    assert.equal(calls[0].method, "save");
    assert.equal(calls.at(-1)?.method, "restore");
    assert.equal(stack.length, 0);
    assert.equal(state.strokeStyle, "#initial");
    assert.equal(state.lineWidth, 1);
    assert.equal(calls.filter((call) => call.method === "stroke").length, 1);
    // User marks stay hollow so they are never mistaken for decoder results.
    assert.equal(calls.filter((call) => call.method === "fill").length, 0);

    const stroke = calls.find((call) => call.method === "stroke")!;
    const painted = calls.filter((call) =>
      ["beginPath", "moveTo", "lineTo", "arc", "rect", "closePath"].includes(call.method),
    );
    assert.equal(painted[0].method, "beginPath");
    assert.equal(painted[1].args.length > 0, true);
    assert.equal(calls[1].method, "beginPath");
    assert.equal(stroke.args.length, 0);

    const signature = calls
      .filter((call) => ["moveTo", "lineTo", "arc", "rect", "closePath"].includes(call.method))
      .map((call) => `${call.method}(${call.args.join(",")})`)
      .join("|");
    assert.ok(signature.length > 0, `${shape} must build a path`);
    signatures.set(shape, signature);
  }
  assert.equal(new Set(signatures.values()).size, WAVEFORM_ANNOTATION_SHAPES.length);
  assert.ok(signatures.get("dot")!.startsWith("arc(9,9,4.5,0,6.283"));
  assert.ok(signatures.get("square")!.startsWith("rect(4,4,10,10)"));
  assert.ok(signatures.get("cross")!.includes("moveTo(4,4)|lineTo(14,14)"));
});
