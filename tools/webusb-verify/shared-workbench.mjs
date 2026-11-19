// Simulate WebUSB in Chromium and exercise the shared desktop workbench entry.
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { unzipSync } from "fflate";

const build = path.resolve("dist-webusb");
const fixture = await readFile(new URL("./fixture.js", import.meta.url), "utf8");
const dir = await mkdtemp(path.join(tmpdir(), "sigpilot-shared-webusb-"));
let mode = "working", trace = [], ws, chrome;
const server = createServer(async (req, res) => {
  try {
    if (req.url === "/trace") {
      let body = "";
      for await (const chunk of req) body += chunk;
      trace.push(JSON.parse(body));
      res.end();
      return;
    }
    const url = new URL(req.url, "http://localhost");
    const script = "globalThis.fixtureMode=" + JSON.stringify(mode) + ";\n" + fixture;
    if (url.pathname === "/fixture.js") {
      res.setHeader("Content-Type", "text/javascript");
      res.end(script);
      return;
    }
    if (!url.pathname.startsWith("/lab/")) throw Error("unknown path");
    const file = path.resolve(build, url.pathname.slice(5) || "index.html");
    if (!file.startsWith(build + path.sep)) throw Error("invalid path");
    let data = await readFile(file);
    if (file.endsWith("index.html")) data = Buffer.from(data.toString().replace("<head>", '<head><script src="/fixture.js"></script>'));
    if (path.basename(file).startsWith("device.worker-")) data = Buffer.concat([Buffer.from(script + "\n"), data]);
    res.writeHead(200, { "Content-Type": file.endsWith(".html") ? "text/html" : file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "application/octet-stream", "Cache-Control": "no-store" });
    res.end(data);
  } catch {
    res.writeHead(404); res.end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}/lab/`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, label, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await fn().catch(() => null);
    if (result) return result;
    await sleep(80);
  }
  const state = await evaluate("({url:location.href,usb:typeof navigator.usb,buttons:[...document.querySelectorAll('button')].map((button)=>button.innerText),text:document.body.innerText.slice(0,1600)})").catch((error) => String(error));
  throw new Error(`${label} timed out; trace=${JSON.stringify(trace.slice(-8))}; state=${JSON.stringify(state)}`);
}

let seq = 0;
const pending = new Map();
function cdp(method, params = {}) {
  const id = ++seq;
  return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
}
async function evaluate(expression) {
  const result = await cdp("Runtime.evaluate", { expression, returnByValue: true, userGesture: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result.value;
}
async function page(nextMode) {
  mode = nextMode; trace = [];
  await cdp("Page.navigate", { url: base + "?" + nextMode });
  await until(() => evaluate("!!document.querySelector('.logic-root')"), "shared app load");
}
async function click(selector) { await evaluate(`document.querySelector(${JSON.stringify(selector)})?.click()`); }

try {
  const browserBinary = process.platform === "darwin"
    ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    : "chromium";
  const chromeArgs = ["--headless=new", "--window-size=1440,950", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--disable-background-networking", "--disable-extensions", "--disable-webgl", "--disable-software-rasterizer", "--disable-breakpad", "--remote-debugging-port=0", "--user-data-dir=" + dir, "about:blank"];
  chrome = spawn(browserBinary, chromeArgs, { stdio: "ignore" });
  const port = await until(async () => (await readFile(path.join(dir, "DevToolsActivePort"), "utf8")).split("\n")[0], "Chromium");
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  ws = new WebSocket(targets.find((target) => target.type === "page").webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  ws.onmessage = (event) => { const value = JSON.parse(event.data), item = pending.get(value.id); if (!item) return; pending.delete(value.id); value.error ? item.reject(new Error(value.error.message)) : item.resolve(value.result); };
  await cdp("Runtime.enable"); await cdp("Page.enable");
  await cdp("Page.setDownloadBehavior", { behavior: "allow", downloadPath: dir });

  await page("unsupported");
  assert.equal(await evaluate("typeof navigator.usb"), "undefined");
  assert(await evaluate("!!document.querySelector('.saleaeToolbar') && !!document.querySelector('.saleaeSidebarRoot')"));
  assert(await evaluate("Array.from(document.querySelectorAll('button')).some((button) => /USB/i.test(button.innerText) && /connect|连接/i.test(button.innerText))"));

  await page("working");
  assert.equal(await evaluate("typeof navigator.usb"), "object");
  assert.equal(await evaluate("[...document.querySelectorAll('.saleaeToolbar, .saleaeSidebarRoot, .logic-windowbar')].length"), 3);
  assert(await evaluate("!!document.querySelector('.demoDeviceButton')"));
  await click(".demoDeviceButton");
  assert(await evaluate("!!document.querySelector('.deviceSettingsPanel')"));
  await click(".saleaeCaptureButton");
  await until(() => evaluate("/Capture complete|采集完成/.test(document.body.innerText)"), "demo capture completion", 30000);
  await until(() => evaluate("!!document.querySelector('.waveformCanvasHost canvas')"), "demo waveform canvas");
  assert.equal(await evaluate("document.querySelector('.channelCounter')?.innerText.includes('8')"), true);
  assert.equal(trace.some((item) => item[0] === "open" || item[0] === "claim"), false);
  await click(".window-actions button");
  const demoFile = await until(async () => (await readdir(dir)).find((name) => name.startsWith("SigPilot-Demo-") && name.endsWith(".pxcap")), "demo pxcap download");
  const demoArchive = unzipSync(await readFile(path.join(dir, demoFile)));
  const demoMetadata = JSON.parse(Buffer.from(demoArchive["metadata.json"]).toString());
  assert.equal(demoMetadata.source_device, "fake:sigpilot-demo");
  assert.equal(Buffer.from(demoArchive["samples.bin"]).length, demoMetadata.sample_count * demoMetadata.unitsize);
  await click(".saleaeCaptureButton");
  await until(() => evaluate("!document.querySelector('.saleaeCaptureButton')?.classList.contains('active')"), "demo capture stop", 10000);

  await page("working");
  const connectButton = await until(() => evaluate("Array.from(document.querySelectorAll('button')).find((button) => /USB/i.test(button.innerText) && /connect|连接/i.test(button.innerText))?.innerText"), "WebUSB connect control");
  await evaluate(`(()=>{const button=Array.from(document.querySelectorAll('button')).find((item)=>/USB/i.test(item.innerText)&&/connect|连接/i.test(item.innerText));if(!button)throw Error('WebUSB connect button missing');button.click();})()`);
  await until(() => evaluate("!!document.querySelector('.deviceSettingsPanel')"), "shared device settings panel");
  assert(await evaluate("!!document.querySelector('.saleaeToolbar') && !!document.querySelector('.saleaeSidebarRoot')"));
  assert(await evaluate("/Long-running loop capture is not available yet.|长时间循环采集尚未支持/.test(document.body.innerText)"));
  assert(connectButton);

  await evaluate(`(()=>{const labels=[...document.querySelectorAll('.deviceSettingsPanel label')];const label=labels.find((item)=>/capture depth|采集深度/i.test(item.innerText));if(!label)throw Error('capture depth control missing');const select=label.querySelector('select');select.value='16384';select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await evaluate(`(()=>{const labels=[...document.querySelectorAll('.deviceSettingsPanel label')];const label=labels.find((item)=>/active channels|启用的通道数/i.test(item.innerText));if(!label)throw Error('channel count control missing');const select=label.querySelector('select');select.value='16';select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await click(".saleaeCaptureButton");
  await until(() => evaluate("/Capture complete|采集完成/.test(document.querySelector('.window-status span')?.innerText||'')"), "capture completion", 30000);
  await until(() => evaluate("!!document.querySelector('.waveformCanvasHost canvas')"), "shared desktop waveform canvas");
  assert(await evaluate("document.querySelector('.channelCounter')?.innerText.includes('16')"));

  await evaluate(`(()=>{const button=Array.from(document.querySelectorAll('.window-actions button')).find((item)=>/save|保存/i.test(item.innerText));if(!button)throw Error('save button missing');button.click();})()`);
  const file = await until(async () => (await readdir(dir)).find((name) => name.endsWith(".pxcap") && !name.startsWith("SigPilot-Demo-")), "pxcap download");
  const archive = unzipSync(await readFile(path.join(dir, file)));
  const metadata = JSON.parse(Buffer.from(archive["metadata.json"]).toString());
  assert.deepEqual([metadata.channel_count, metadata.sample_count, metadata.sample_rate_hz], [16, 16384, 25000000]);
  assert.equal(Buffer.from(archive["samples.bin"]).length, 32768);
  assert(trace.some((item) => item[0] === "claim" && item[1] === 1));
  assert(trace.some((item) => item[0] === "write" && item[1] === 8268 && item[2] === 16));

  await sleep(250);
  const screenshot = await cdp("Page.captureScreenshot", { format: "png" });
  await mkdir(".verification", { recursive: true });
  await writeFile(".verification/webusb-shared-workbench.png", Buffer.from(screenshot.data, "base64"));
  console.log(JSON.stringify({ checks: ["shared desktop shell", "browser-only demo capture without USB authorization", "demo waveform and pxcap download", "finite WebUSB capture limitation is disclosed", "browser USB authorization", "device settings and exact depth selection", "simulated 16-channel acquisition rendered in shared WaveformCanvas", "pxcap download and metadata"], screenshot: ".verification/webusb-shared-workbench.png", browser: execFileSync(browserBinary, ["--version"], { encoding: "utf8" }).trim() }, null, 2));
} finally {
  ws?.close(); chrome?.kill("SIGKILL"); server.closeAllConnections(); server.close();
  await rm(dir, { force: true, recursive: true, maxRetries: 4, retryDelay: 100 });
}
