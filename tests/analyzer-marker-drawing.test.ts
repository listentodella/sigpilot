import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { drawProtocolMarker } from "../src/lib/analyzerMarkerDrawing.ts";
import { visibleAnalyzerProtocolMarkers } from "../src/lib/analyzerMarkers.ts";
import { createMarkerDemoLanes, DEMO_TOTAL_SAMPLES, MARKER_DESCRIPTIONS, MARKER_KINDS } from "../tools/analyzer-markers-demo/fixture.ts";

const palette = { start: "#00aa00", stop: "#ffaa00", error: "#ff0000", background: "#131316" };
const channelColor = "#53a9fd";

function recordingContext() {
  const calls: Array<{ method: string; args: unknown[]; color: string; stroke: string; font: string }> = [];
  const stack: Array<Record<string, unknown>> = [];
  const state: Record<string, unknown> = { fillStyle: "#initial", strokeStyle: "#initial", font: "10px serif" };
  const context = new Proxy(state, {
    get(target, key) {
      if (key in target) return target[key as string];
      return (...args: unknown[]) => {
        calls.push({ method: String(key), args, color: String(state.fillStyle), stroke: String(state.strokeStyle), font: String(state.font) });
        if (key === "save") stack.push({ ...state });
        if (key === "restore") {
          const saved = stack.pop();
          assert.ok(saved, "restore must have a matching save");
          Object.keys(state).forEach((name) => delete state[name]);
          Object.assign(state, saved);
        }
      };
    },
  }) as unknown as CanvasRenderingContext2D;
  return { context, calls, stack, state };
}

function render(kind: (typeof MARKER_KINDS)[number]) {
  const recording = recordingContext();
  drawProtocolMarker(recording.context, 20, 30, kind, channelColor, palette);
  return recording;
}

test("demo covers every supported API kind and SDK enum, exactly once", () => {
  const source = ts.createSourceFile("api.ts", readFileSync(new URL("../src/lib/api.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
  const markerInterface = source.statements.find((node) => ts.isInterfaceDeclaration(node) && node.name.text === "AnalyzerProtocolMarker");
  assert.ok(markerInterface && ts.isInterfaceDeclaration(markerInterface));
  const kind = markerInterface.members.find((node) => ts.isPropertySignature(node) && node.name.getText(source) === "kind");
  assert.ok(kind && ts.isPropertySignature(kind) && kind.type && ts.isUnionTypeNode(kind.type));
  const apiKinds = kind.type.types.map((node) => {
    assert.ok(ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal));
    return node.literal.text;
  });
  const sdk = readFileSync(new URL("../vendor/saleae-standalone/sdk/AnalyzerSDK/include/AnalyzerResults.h", import.meta.url), "utf8");
  const enumBody = sdk.match(/enum MarkerType\s*\{([^}]+)\}/)?.[1];
  assert.ok(enumBody);
  assert.deepEqual(MARKER_KINDS, apiKinds);
  assert.deepEqual(MARKER_KINDS.map((item) => MARKER_DESCRIPTIONS[item].sdk), enumBody.split(",").map((name) => name.trim()).filter(Boolean));
  const kinds = createMarkerDemoLanes().flatMap((lane) => lane.markers.map((marker) => marker.kind));
  assert.equal(kinds.length, 12);
  assert.deepEqual([...kinds].sort(), [...apiKinds].sort());
});

for (const kind of MARKER_KINDS) {
  test(`${kind} paints using its correct color and restores canvas state`, () => {
    const { calls, state, stack } = render(kind);
    const paint = calls.find((call) => call.method === "stroke" || call.method === "fill");
    assert.ok(paint);
    const color = kind === "start" ? palette.start : kind === "stop" ? palette.stop : kind.startsWith("error_") ? palette.error : channelColor;
    assert.equal(paint.stroke, color);
    assert.equal(paint.color, kind === "one" || kind === "zero" ? palette.background : color);
    assert.equal(calls[0].method, "save");
    assert.equal(calls.at(-1)?.method, "restore");
    assert.deepEqual(state, { fillStyle: "#initial", strokeStyle: "#initial", font: "10px serif" });
    assert.equal(stack.length, 0);
  });
}

test("circle and square markers preserve their application sizes", () => {
  assert.deepEqual(render("dot").calls.find((call) => call.method === "arc")?.args, [20, 30, 2, 0, Math.PI * 2]);
  assert.deepEqual(render("start").calls.find((call) => call.method === "arc")?.args, [20, 30, 3.5, 0, Math.PI * 2]);
  assert.deepEqual(render("square").calls.find((call) => call.method === "rect")?.args, [17.5, 27.5, 5, 5]);
  assert.deepEqual(render("stop").calls.find((call) => call.method === "rect")?.args, [16.5, 26.5, 7, 7]);
});

test("up and down arrows have opposite orientations", () => {
  const vertices = (kind: "up_arrow" | "down_arrow") => render(kind).calls.filter((call) => call.method === "moveTo" || call.method === "lineTo").map((call) => call.args);
  assert.deepEqual(vertices("up_arrow"), [[15.5, 33], [20, 27], [24.5, 33]]);
  assert.deepEqual(vertices("down_arrow"), [[15.5, 27], [20, 33], [24.5, 27]]);
});

test("One and Zero paint the appropriate digit over the waveform background", () => {
  for (const kind of ["one", "zero"] as const) {
    const { calls } = render(kind);
    const text = calls.find((call) => call.method === "fillText");
    assert.ok(text);
    assert.deepEqual(text.args, [kind === "one" ? "1" : "0", 20, 30]);
    assert.equal(text.color, channelColor);
    assert.equal(text.font, "600 9px Roboto, system-ui, sans-serif");
    assert.equal(calls.filter((call) => call.method === "quadraticCurveTo").length, 4);
  }
});

test("X and ErrorX share cross geometry, not error semantics", () => {
  const paths = (kind: "x" | "error_x") => render(kind).calls.filter((call) => call.method === "moveTo" || call.method === "lineTo").map((call) => call.args);
  assert.deepEqual(paths("x"), [[17, 27], [23, 33], [23, 27], [17, 33]]);
  assert.deepEqual(paths("x"), paths("error_x"));
});

test("fixture markers are ordered, in range, and visible at desktop and mobile widths", () => {
  for (const lane of createMarkerDemoLanes()) {
    assert.ok(lane.edges.every((sample, index) => sample >= 0 && sample <= DEMO_TOTAL_SAMPLES && (!index || sample > lane.edges[index - 1])));
    assert.ok(lane.markers.every((marker, index) => marker.sample >= 0 && marker.sample <= DEMO_TOTAL_SAMPLES && (!index || marker.sample > lane.markers[index - 1].sample)));
    for (const width of [280, 1_000]) {
      assert.deepEqual(visibleAnalyzerProtocolMarkers(lane.markers, 0, DEMO_TOTAL_SAMPLES, width), lane.markers);
    }
    for (const marker of lane.markers) {
      if (marker.kind !== "up_arrow" && marker.kind !== "down_arrow") continue;
      const index = lane.edges.indexOf(marker.sample);
      assert.ok(index >= 0);
      const rising = lane.initialHigh ? index % 2 === 1 : index % 2 === 0;
      assert.equal(rising, marker.kind === "up_arrow");
    }
  }
});
