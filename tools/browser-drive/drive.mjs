#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = Number(process.env.CDP_PORT ?? 9336);
const profile = mkdtempSync(join(tmpdir(), "pxlogic-cdp-"));
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

const consoleLines = [];
socket.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.method === "Runtime.consoleAPICalled") {
    const text = (m.params.args ?? []).map((a) => a.value ?? a.description ?? a.type).join(" ");
    if (!text.includes("React DevTools")) consoleLines.push(`[${m.params.type}] ${text.slice(0, 220)}`);
  }
  if (m.method === "Runtime.exceptionThrown") {
    const d = m.params.exceptionDetails;
    consoleLines.push(`[EXCEPTION] ${(d.exception?.description ?? d.text).slice(0, 400)}`);
  }
});

const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
const send = (m, p) => cdp.send(m, p, sessionId);
await send("Runtime.enable");
await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", {
  deviceScaleFactor: 2,
  height: 900,
  mobile: false,
  width: 1600,
});
await send("Page.navigate", { url: "http://127.0.0.1:1420/" });
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

const CANVAS_INK = `(() => {
  const canvases = [...document.querySelectorAll("canvas")];
  return canvases.map((c) => {
    const ctx = c.getContext("2d");
    let ink = null;
    if (ctx && c.width > 0 && c.height > 0) {
      try {
        const data = ctx.getImageData(0, 0, c.width, c.height).data;
        let nonBackground = 0;
        for (let i = 0; i < data.length; i += 4 * 41) {
          const r = data[i], g = data[i+1], b = data[i+2], a = data[i+3];
          if (a > 20 && (Math.abs(r - 16) > 14 || Math.abs(g - 16) > 14 || Math.abs(b - 19) > 14)) nonBackground += 1;
        }
        ink = nonBackground;
      } catch (e) { ink = "unreadable"; }
    }
    return { cls: c.className, w: c.width, h: c.height, ink };
  });
})()`;

const steps = [];
await evaluate(clickText("Try a demo Logic device"));
await sleep(2500);
steps.push({ label: "before capture", canvases: (await evaluate(CANVAS_INK)).value });

await evaluate(`(() => { const b = document.querySelector(".saleaeCaptureButton"); if (!b) return "no capture button"; b.click(); return "clicked capture"; })()`);
await sleep(4000);
steps.push({ label: "during capture", canvases: (await evaluate(CANVAS_INK)).value });
steps.push({ label: "status", body: (await evaluate("document.body.innerText.slice(-260)")).value });

await sleep(6000);
steps.push({ label: "after capture", canvases: (await evaluate(CANVAS_INK)).value });


steps.push({ label: "frame state", value: (await evaluate(`(() => {
  const f = window.__PXLOGIC_FRAMES__;
  if (!f) return "no hook";
  const ids = f.sessions();
  return { health: f.health(), ids, states: ids.map((id) => [id, f.state(id)]) };
})()`)).value });

const shot = await send("Page.captureScreenshot", { format: "png" });
writeFileSync("/tmp/pxgl/app-capture.png", Buffer.from(shot.data, "base64"));
const clip = await send("Page.captureScreenshot", {
  clip: { height: 300, scale: 2, width: 700, x: 110, y: 55 },
  format: "png",
});
writeFileSync("/tmp/pxgl/app-clip.png", Buffer.from(clip.data, "base64"));

console.log(JSON.stringify({ steps, console: consoleLines.slice(-25) }, null, 2));
console.log("screenshot: /tmp/pxgl/app-capture.png");

await cdp.send("Target.closeTarget", { targetId });
socket.close();
chrome.kill("SIGKILL");
