#!/usr/bin/env node
// Drives a real zoom-and-pan gesture and reports which waveform draw path each
// frame took.
//
// `drawCachedWaveLayer` chooses between six ways of producing pixels, and the
// choice depends on runtime state: how coarse the retained tile is, whether the
// worker's viewport raster happens to cover the current viewport, and which
// caches are still on hand. Which branch a gesture actually takes cannot be read
// off the source, so this measures it.
//
// What to look for: any `stale-tile-raster` or `stale-viewport-raster` entry
// with a `maxStretch` above ~1.05 is a frame the user saw with every stroke that
// much too thick — which is what "the edges look unclear while zooming" is.
//
// Usage: node tools/browser-drive/gesture.mjs
// Requires the dev server on APP_URL (default http://127.0.0.1:1420/).

import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = Number(process.env.CDP_PORT ?? 9338);
const APP_URL = process.env.APP_URL ?? "http://127.0.0.1:1420/";
const profile = mkdtempSync(join(tmpdir(), "pxlogic-gesture-"));
const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--enable-unsafe-swiftshader",
    "--no-sandbox",
    "--window-size=1600,900",
    "about:blank",
  ],
  { stdio: ["ignore", "pipe", "pipe"] },
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForDevtools() {
  for (let i = 0; i < 80; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return (await r.json()).webSocketDebuggerUrl;
    } catch {}
    await sleep(150);
  }
  throw new Error("no devtools");
}

class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    socket.addEventListener("message", (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) reject(new Error(JSON.stringify(m.error)));
        else resolve(m.result);
      }
    });
  }
  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }
}

const wsUrl = await waitForDevtools();
const socket = new WebSocket(wsUrl);
await new Promise((res, rej) => {
  socket.addEventListener("open", res);
  socket.addEventListener("error", rej);
});
const cdp = new Cdp(socket);

const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
const send = (m, p) => cdp.send(m, p, sessionId);
await send("Runtime.enable");
await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { deviceScaleFactor: 2, height: 900, mobile: false, width: 1600 });
await send("Page.navigate", { url: APP_URL });
await sleep(5000);

async function evaluate(expression) {
  const r = await send("Runtime.evaluate", { awaitPromise: true, expression, returnByValue: true });
  if (r.exceptionDetails) return { error: r.exceptionDetails.exception?.description ?? r.exceptionDetails.text };
  return { value: r.result.value };
}

const clickText = (text) => `(() => {
  const wanted = ${JSON.stringify(text)};
  const hit = [...document.querySelectorAll("button, a, [role=button], div[role=button], span")]
    .find((n) => (n.textContent ?? "").trim().includes(wanted) && n.offsetParent !== null);
  if (!hit) return "not found: " + wanted;
  hit.click();
  return "clicked";
})()`;

const notes = [];
const note = (text) => notes.push(text);

// 1. Load the demo device and capture some data.
note(`demo device: ${(await evaluate(clickText("Try a demo Logic device"))).value}`);
await sleep(2500);
note(`capture start: ${(await evaluate(`(() => { const b = document.querySelector(".saleaeCaptureButton"); if (!b) return "no capture button"; b.click(); return "clicked"; })()`)).value}`);
await sleep(6000);
// Stop it again: a live capture keeps moving the viewport on its own, which
// would confound a measurement of what the gesture did.
note(`capture stop: ${(await evaluate(`(() => { const b = document.querySelector(".saleaeCaptureButton"); if (!b) return "no capture button"; b.click(); return "clicked"; })()`)).value}`);
await sleep(2500);

const probePresent = (await evaluate("typeof window.__SIGPILOT_DRAW__")).value;
if (probePresent !== "object") {
  console.log(JSON.stringify({ error: `draw probe missing (got ${probePresent})`, notes }, null, 2));
  process.exit(1);
}

const GRAPH_X = 700;
const GRAPH_Y = 400;

async function wheel(deltaY, steps, delayMs) {
  for (let i = 0; i < steps; i += 1) {
    await send("Input.dispatchMouseEvent", {
      button: "none",
      deltaX: 0,
      deltaY,
      type: "mouseWheel",
      x: GRAPH_X,
      y: GRAPH_Y,
    });
    await sleep(delayMs);
  }
}

async function drag(fromX, toX, steps, delayMs) {
  await send("Input.dispatchMouseEvent", { button: "left", buttons: 1, clickCount: 1, type: "mousePressed", x: fromX, y: GRAPH_Y });
  for (let i = 1; i <= steps; i += 1) {
    const x = fromX + ((toX - fromX) * i) / steps;
    await send("Input.dispatchMouseEvent", { button: "left", buttons: 1, type: "mouseMoved", x, y: GRAPH_Y });
    await sleep(delayMs);
  }
  await send("Input.dispatchMouseEvent", { button: "left", buttons: 0, clickCount: 1, type: "mouseReleased", x: toX, y: GRAPH_Y });
}

const summary = async (label) => {
  // Read the raw records rather than the page's summary: the max alone cannot
  // distinguish "one bad frame while a render was in flight" from "every frame
  // of the gesture was wrong", and those call for different fixes.
  const records = (await evaluate("window.__SIGPILOT_DRAW__.recent()")).value ?? [];
  const byPath = new Map();
  for (const record of records) {
    if (!byPath.has(record.path)) byPath.set(record.path, []);
    byPath.get(record.path).push(record.stretch);
  }
  const percentile = (values, fraction) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
  };
  const paths = [...byPath.entries()]
    .map(([path, values]) => ({
      count: values.length,
      max: Number(Math.max(...values).toFixed(3)),
      median: Number(percentile(values, 0.5).toFixed(3)),
      p90: Number(percentile(values, 0.9).toFixed(3)),
      path,
      share: records.length > 0 ? Number((values.length / records.length).toFixed(3)) : 0,
    }))
    .sort((left, right) => right.count - left.count);
  return { label, paths, total: records.length };
};

const phases = [];

// 2. Zoom in hard. This is what drives the tile raster coarser than the viewport,
//    which is the branch the stale-raster fallback lives in.
await evaluate("window.__SIGPILOT_DRAW__.reset()");
await wheel(-120, 40, 90);
await sleep(900);
phases.push(await summary("zoom in (40 wheel steps)"));

// 3. Pan at that zoom: the viewport leaves the cached viewport raster's coverage,
//    which is the condition the fallback is meant to cover.
await evaluate("window.__SIGPILOT_DRAW__.reset()");
await drag(900, 300, 24, 40);
await sleep(900);
phases.push(await summary("pan left at zoom"));

// 4. Zoom back out, the gesture the user described as the trigger.
await evaluate("window.__SIGPILOT_DRAW__.reset()");
await wheel(120, 40, 90);
await sleep(900);
phases.push(await summary("zoom out (40 wheel steps)"));

// 5. Round trip: out to the far end and back in, which is the reported repro.
await evaluate("window.__SIGPILOT_DRAW__.reset()");
await wheel(120, 60, 60);
await sleep(600);
const farOut = await summary("zoomed far out");
await evaluate("window.__SIGPILOT_DRAW__.reset()");
await wheel(-120, 60, 60);
await sleep(1200);
phases.push(farOut, await summary("back in after far out"));

const recent = (await evaluate("window.__SIGPILOT_DRAW__.recent().filter((r) => r.path.startsWith('stale')).slice(-25)")).value;
const state = (await evaluate(`(() => {
  const f = window.__SIGPILOT_FRAMES__;
  if (!f) return "no hook";
  const ids = f.sessions();
  return { health: f.health(), states: ids.map((id) => [id, f.state(id)]) };
})()`)).value;

// 6. Steady state, no input at all. The scale gate that stops a zoom-in from
//    reusing one raster must not reject a raster that is already correct, or
//    every idle frame would re-request a render the worker has already done.
await evaluate("window.__SIGPILOT_DRAW__.reset()");
await sleep(2500);
const steady = await summary("steady state, no input");

const shot = await send("Page.captureScreenshot", {
  clip: { height: 300, scale: 2, width: 700, x: 110, y: 55 },
  format: "png",
});
writeFileSync("/tmp/pxgl/gesture.png", Buffer.from(shot.data, "base64"));

console.log(JSON.stringify({ notes, phases, steady, recentStaleDraws: recent, state }, null, 2));
console.log("screenshot: /tmp/pxgl/gesture.png");

await cdp.send("Target.closeTarget", { targetId });
socket.close();
chrome.kill("SIGKILL");
