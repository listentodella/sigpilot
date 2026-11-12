import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import * as drawing from "../src/lib/analyzerMarkerDrawing.ts";
import * as markers from "../src/lib/analyzerMarkers.ts";
import * as themes from "../src/lib/themes.ts";
import * as fixture from "../tools/analyzer-markers-demo/fixture.ts";

/** DOM/Canvas contract smoke test, not a browser layout or rasterization test. */
function harness(width = 1_294) {
  const created: DemoElement[] = [];
  class DemoElement {
    tag: string;
    id = "";
    className = "";
    type = "";
    value = "";
    textContent = "";
    checked = false;
    disabled = false;
    clientWidth = width;
    clientHeight = 368;
    width = 0;
    height = 0;
    title = "";
    href = "";
    download = "";
    clicked = false;
    blobType = "";
    style: Record<string, string> = {};
    dataset: Record<string, string> = {};
    attributes: Record<string, string> = {};
    children: DemoElement[] = [];
    events = new Map<string, Array<() => void>>();
    commands: Array<{ method: string; args: unknown[] }> = [];
    context: CanvasRenderingContext2D;

    constructor(tag: string) {
      this.tag = tag;
      const state: Record<string, unknown> = {};
      this.context = new Proxy(state, {
        get: (target, key) => key in target ? target[key as string] : (...args: unknown[]) => {
          this.commands.push({ method: String(key), args });
        },
      }) as unknown as CanvasRenderingContext2D;
      created.push(this);
    }
    append(...nodes: DemoElement[]) {
      this.children.push(...nodes.flatMap((node) => node.tag === "fragment" ? node.children : [node]));
    }
    replaceChildren(...nodes: DemoElement[]) { this.children = []; this.append(...nodes); }
    setAttribute(name: string, value: string) { this.attributes[name] = value; }
    querySelectorAll(selector: string) {
      assert.equal(selector, ".marker-card");
      return this.children.filter((node) => node.className === "marker-card");
    }
    addEventListener(name: string, callback: () => void) {
      const callbacks = this.events.get(name) ?? [];
      callbacks.push(callback);
      this.events.set(name, callbacks);
    }
    dispatch(name: string) { this.events.get(name)?.forEach((callback) => callback()); }
    click() { this.clicked = true; this.dispatch("click"); }
    getContext(type: string) { assert.equal(type, "2d"); return this.context; }
    toBlob(callback: (blob: Blob) => void, type: string) {
      this.blobType = type;
      callback(new Blob(["mock canvas output"], { type }));
    }
  }

  const nodes = new Map<string, DemoElement>();
  const html = readFileSync(new URL("../tools/analyzer-markers-demo/index.html", import.meta.url), "utf8");
  for (const match of html.matchAll(/<([a-z][a-z0-9]*)\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
    const node = new DemoElement(match[1]);
    node.id = match[2];
    node.value = match[0].match(/\bvalue="([^"]*)"/)?.[1] ?? "";
    node.checked = /\bchecked\b/.test(match[0]);
    node.disabled = /\bdisabled\b/.test(match[0]);
    nodes.set(node.id, node);
  }
  nodes.get("theme-select")!.value = "saleae-dark";
  nodes.get("marker-scale")!.value = "1";
  const root = new DemoElement("html");
  const frames = new Map<number, () => void>();
  const windowEvents = new Map<string, () => void>();
  const timers: Array<() => void> = [];
  let frameId = 0;
  let revoked = false;
  const source = readFileSync(new URL("../tools/analyzer-markers-demo/entry.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
  } }).outputText;
  vm.runInNewContext(compiled, {
    exports: {},
    document: {
      getElementById: (id: string) => nodes.get(id),
      createElement: (tag: string) => new DemoElement(tag),
      createDocumentFragment: () => new DemoElement("fragment"),
      documentElement: root,
    },
    window: {
      devicePixelRatio: 2,
      requestAnimationFrame: (callback: () => void) => { frames.set(++frameId, callback); return frameId; },
      addEventListener: (name: string, callback: () => void) => windowEvents.set(name, callback),
      setTimeout: (callback: () => void) => { timers.push(callback); return timers.length; },
    },
    ResizeObserver: class { observe() {} },
    URL: {
      createObjectURL: (blob: Blob) => { assert.equal(blob.type, "image/png"); return "blob:demo-export"; },
      revokeObjectURL: (url: string) => { assert.equal(url, "blob:demo-export"); revoked = true; },
    },
    require(name: string) {
      if (name === "../../src/lib/analyzerMarkerDrawing") return drawing;
      if (name === "../../src/lib/analyzerMarkers") return markers;
      if (name === "../../src/lib/themes") return themes;
      if (name === "./fixture") return fixture;
      throw new Error(`Unexpected demo dependency: ${name}`);
    },
  });
  function flush() {
    const callbacks = [...frames.values()];
    frames.clear();
    callbacks.forEach((callback) => callback());
    assert.equal(frames.size, 0, "static demo must not continuously request frames");
  }
  flush();
  return {
    nodes, root, created, flush,
    waveform: nodes.get("waveform")!,
    card: (kind: string) => nodes.get("marker-gallery")!.children.find((node) => node.dataset.kind === kind)!,
    change(id: string, value: string, event = "change") { nodes.get(id)!.value = value; nodes.get(id)!.dispatch(event); flush(); },
    resize() { windowEvents.get("resize")!(); flush(); },
    flushTimers() { timers.forEach((callback) => callback()); return revoked; },
  };
}

test("demo draws all 12 markers and 24 gallery previews without a device", () => {
  const demo = harness();
  assert.deepEqual(demo.waveform.dataset.renderedKinds.split(",").sort(), [...fixture.MARKER_KINDS].sort());
  assert.equal(demo.nodes.get("marker-gallery")!.children.length, 12);
  const previews = demo.created.filter((node) => node.tag === "canvas" && node.id === "");
  assert.equal(previews.length, 24);
  assert.ok(previews.every((node) => node.dataset.drawnKind && node.commands.some((call) => call.method === "fill" || call.method === "stroke")));
  assert.equal(demo.waveform.width, 2 * demo.waveform.clientWidth);
  assert.equal(demo.nodes.get("render-status")!.textContent, "当前显示 12 / 12 个标识");
});

test("every marker selects its matching preview, explanation, and SDK example", () => {
  const demo = harness();
  for (const kind of fixture.MARKER_KINDS) {
    demo.card(kind).click();
    demo.flush();
    assert.equal(demo.card(kind).attributes["aria-pressed"], "true");
    assert.equal(demo.nodes.get("detail-preview")!.dataset.drawnKind, kind);
    assert.ok(demo.nodes.get("sigpilot-example")!.textContent.includes(`kind: "${kind}"`));
    assert.ok(demo.nodes.get("saleae-example")!.textContent.includes(`AnalyzerResults::${fixture.MARKER_DESCRIPTIONS[kind].sdk}`));
  }
  const target = demo.nodes.get("waveform-targets")!.children.find((node) => node.dataset.kind === "one")!;
  target.click(); demo.flush();
  assert.ok(demo.nodes.get("detail-note")!.textContent.includes("IBI 接受"));
});

test("zoom, pan, offscreen selection, reset and mobile redraw keep valid markers", () => {
  const demo = harness();
  demo.change("zoom", "3", "input");
  assert.equal(demo.waveform.dataset.viewStart, "400");
  assert.equal(demo.nodes.get("pan")!.disabled, false);
  demo.change("pan", "100", "input");
  assert.equal(demo.waveform.dataset.viewStart, "800");
  demo.card("start").click(); demo.flush();
  assert.equal(demo.waveform.dataset.viewStart, "0");
  assert.ok(demo.waveform.dataset.renderedKinds.split(",").includes("start"));
  demo.nodes.get("reset-view")!.click(); demo.flush();
  assert.equal(demo.nodes.get("pan")!.disabled, true);
  assert.equal(demo.waveform.dataset.renderedKinds.split(",").length, 12);
  demo.nodes.get("waveform-host")!.clientWidth = 330;
  demo.resize();
  assert.equal(demo.waveform.width, 660);
  assert.equal(demo.waveform.dataset.renderedKinds.split(",").length, 12);
});

test("theme, preview color, marker scale and labels update the display", () => {
  const demo = harness();
  demo.change("theme-select", "lab-light");
  assert.equal(demo.root.dataset.theme, "lab-light");
  assert.equal(demo.root.style.colorScheme, "light");
  assert.equal(themes.activeUiTheme().id, "lab-light");
  demo.change("preview-color", "#123456", "input");
  demo.change("marker-scale", "4");
  assert.equal(demo.waveform.dataset.markerScale, "4");
  assert.ok(demo.waveform.commands.some((call) => call.method === "scale" && call.args[0] === 4));
  demo.nodes.get("show-labels")!.checked = false;
  demo.nodes.get("show-labels")!.dispatch("change"); demo.flush();
  assert.equal(demo.waveform.dataset.labels, "false");
});

test("PNG export requests the correct filename and releases its object URL", () => {
  const demo = harness();
  demo.nodes.get("export-png")!.click();
  assert.equal(demo.waveform.blobType, "image/png");
  const anchor = demo.created.find((node) => node.tag === "a")!;
  assert.equal(anchor.download, "sigpilot-protocol-markers.png");
  assert.equal(anchor.href, "blob:demo-export");
  assert.equal(anchor.clicked, true);
  assert.equal(demo.flushTimers(), true);
});
