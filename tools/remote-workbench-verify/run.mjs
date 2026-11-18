// Real production frontend + Rust Demo server, inside the Instabox cgroup.
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import { networkInterfaces } from "node:os";
import assert from "node:assert/strict";

if (
  process.platform !== "linux" ||
  !execFileSync("uname", ["-r"], { encoding: "utf8" }).includes("instabox")
)
  throw new Error("Use Instabox");
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function freePort() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}
const dir = await mkdtemp(path.resolve(".verification/remote-browser-"));
const address = process.argv.includes("--lan")
  ? Object.values(networkInterfaces()).flat().find((nic) => nic && !nic.internal && nic.family === "IPv4")?.address
  : "127.0.0.1";
if (!address) throw new Error("LAN verification needs an IPv4 interface");
const port = await freePort(),
  debugPort = await freePort();
const backend = spawn(
  "target/debug/examples/remote_gui_fixture",
  [String(port), dir, address],
  { stdio: ["ignore", "ignore", "pipe"] },
);
let backendErrors = "";
backend.stderr.on("data", (b) => (backendErrors += b.toString()));
let chrome, ws;
let chromeErrors = "";
const report = { passed: false, checks: [] };
const pending = new Map();
let nextId = 0;
async function until(f, label, timeout = 15000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      const value = await f();
      if (value) return value;
    } catch (e) {
      last = e;
    }
    await delay(150);
  }
  throw new Error(`${label}: ${last?.message ?? "timed out"}`);
}
async function cdp(method, params = {}, sessionId) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP timeout: ${method}`));
    }, 20000);
    pending.set(id, {
      resolve: (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
    });
    ws.send(
      JSON.stringify({
        id,
        method,
        params,
        ...(sessionId ? { sessionId } : {}),
      }),
    );
  });
}
async function evaluate(sessionId, expression) {
  const r = await cdp(
    "Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: true },
    sessionId,
  );
  if (r.exceptionDetails)
    throw new Error(
      r.exceptionDetails.exception?.description ?? r.exceptionDetails.text,
    );
  return r.result.value;
}
async function page(url) {
  const { browserContextId } = await cdp("Target.createBrowserContext");
  const { targetId } = await cdp("Target.createTarget", {
    url,
    browserContextId,
  });
  const { sessionId } = await cdp("Target.attachToTarget", {
    targetId,
    flatten: true,
  });
  await cdp("Page.enable", {}, sessionId);
  return sessionId;
}
const fill = (selector, value, index = 0) =>
  `(()=>{const e=document.querySelectorAll(${JSON.stringify(selector)})[${index}];if(!e)throw new Error('Missing input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`;
async function login(session, code, name) {
  await until(
    () =>
      evaluate(session, "!!document.querySelector('input[name=access-code]')"),
    "login loaded",
  );
  await evaluate(session, fill("input[name=browser-name]", name));
  await evaluate(session, fill("input[name=access-code]", code));
  await evaluate(
    session,
    "document.querySelector('.remoteLogin form').requestSubmit()",
  );
  await until(
    () =>
      evaluate(session, "!!document.querySelector('.remoteWaveCanvas canvas')"),
    "real Demo waveform loaded",
  );
}
async function mark(session, sample, title) {
  await evaluate(
    session,
    "document.querySelectorAll('.remoteSidebar nav button')[0].click()",
  );
  await evaluate(session, fill(".remoteSidebarContent form input", sample));
  await evaluate(session, fill(".remoteSidebarContent form input", title, 1));
  await evaluate(
    session,
    "document.querySelector('.remoteSidebarContent form').requestSubmit()",
  );
  await until(
    () =>
      evaluate(
        session,
        `[...document.querySelectorAll('[data-marker-sample]')].some(e=>e.dataset.markerSample===${JSON.stringify(sample)}&&e.textContent.includes(${JSON.stringify(title)}))&&!document.querySelector('.remoteSidebarContent form .remotePrimary').disabled`,
      ),
    `marker ${sample}`,
  );
}
try {
  const setup = await until(async () => {
    if (backend.exitCode !== null) throw new Error(backendErrors);
    return JSON.parse(await readFile(path.join(dir, "setup.json"), "utf8"));
  }, "Rust server ready");
  const affinity = (await readFile("/proc/self/status", "utf8")).match(
    /^Cpus_allowed_list:\s*(\d+)/m,
  )[1];
  chrome = spawn(
    "/usr/bin/taskset",
    [
      "-c",
      affinity,
      "/usr/bin/chromium",
      "--headless=new",
      "--no-sandbox",
      "--no-zygote",
      "--disable-gpu",
      "--in-process-gpu",
      "--enable-features=NetworkServiceInProcess,NetworkServiceInProcess2",
      "--disable-features=AudioServiceOutOfProcess,MediaRouter,OptimizationHints",
      "--disable-webgl",
      "--disable-software-rasterizer",
      "--disable-dev-shm-usage",
      "--disable-background-networking",
      "--disable-extensions",
      "--disable-sync",
      "--disable-breakpad",
      "--num-raster-threads=1",
      "--js-flags=--single-threaded",
      "--renderer-process-limit=2",
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${path.join(dir, "chromium")}`,
      "--window-size=1440,1000",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  chrome.stderr.on("data", (b) => (chromeErrors += b.toString()));
  const version = await until(async () => {
    const r = await fetch(`http://127.0.0.1:${debugPort}/json/version`);
    return r.json();
  }, "Chromium ready");
  ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((r, j) => {
    ws.addEventListener("open", r, { once: true });
    ws.addEventListener("error", j, { once: true });
  });
  ws.addEventListener("message", (e) => {
    const v = JSON.parse(e.data);
    const p = pending.get(v.id);
    if (p) {
      pending.delete(v.id);
      if (v.error) p.reject(new Error(JSON.stringify(v.error)));
      else p.resolve(v.result);
    }
  });
  for (const target of (await cdp("Target.getTargets")).targetInfos)
    if (target.type === "page")
      await cdp("Target.closeTarget", { targetId: target.targetId });
  const a = await page(`http://${address}:${port}`),
    b = await page(`http://${address}:${port}`);
  await login(a, setup.access_code, "Alice browser");
  await login(b, setup.access_code, "Bob browser");
  assert.match(
    await evaluate(
      a,
      "document.querySelector('.remoteCaptureInfo').textContent",
    ),
    /10048/,
  );
  const painted = await until(
    () =>
      evaluate(
        a,
        "(()=>{const c=document.querySelector('.waveform-canvas');if(!c?.width)return false;const p=c.getContext('2d').getImageData(0,0,c.width,c.height).data;const colors=new Set();for(let i=0;i<p.length;i+=4)if(p[i+3])colors.add(`${p[i]},${p[i+1]},${p[i+2]}`);return colors.size>4;})()",
      ),
    "waveform raster painted",
  );
  assert.equal(painted, true);
  report.checks.push("Real Rust Demo: 1 MHz, 10048 samples, painted waveform");
  for (const [session, start] of [
    [a, "0"],
    [b, "4000"],
  ]) {
    await evaluate(session, fill(".remoteViewToolbar input", start));
    await evaluate(session, fill(".remoteViewToolbar input", "1000", 1));
    await evaluate(
      session,
      "document.querySelector('.remoteViewToolbar button').click()",
    );
  }
  await until(
    () =>
      evaluate(
        b,
        "document.querySelector('.remoteWaveCanvas').dataset.start==='4000'",
      ),
    "Bob independent viewport",
  );
  assert.equal(
    await evaluate(
      a,
      "document.querySelector('.remoteWaveCanvas').dataset.start",
    ),
    "0",
  );
  report.checks.push("Two authorized browsers keep independent viewports");
  await mark(a, "5", "remote marker five");
  await until(
    () => evaluate(b, "!!document.querySelector('[data-marker-sample=\"5\"]')"),
    "shared sample 5 marker",
  );
  assert.match(
    await evaluate(
      b,
      "document.querySelector('[data-marker-sample=\"5\"]').textContent",
    ),
    /5 μs/,
  );
  assert.equal(
    await evaluate(
      b,
      "document.querySelector('.remoteSectionHeading button').disabled",
    ),
    true,
  );
  report.checks.push(
    "Sample 5 marker shared at 5 μs; another browser cannot undo it",
  );
  await cdp("Network.enable", {}, a);
  await cdp(
    "Network.emulateNetworkConditions",
    { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 },
    a,
  );
  await until(
    () => evaluate(a, "!!document.querySelector('.remoteConnection.offline')"),
    "offline state",
    35000,
  );
  await mark(b, "7", "while Alice was offline");
  await cdp(
    "Network.emulateNetworkConditions",
    {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    },
    a,
  );
  await until(
    () =>
      evaluate(
        a,
        "!!document.querySelector('[data-marker-sample=\"7\"]')&&!document.querySelector('.remoteConnection.offline')",
      ),
    "reconnect resynchronization",
    20000,
  );
  assert.equal(
    await evaluate(
      b,
      "document.querySelector('.remoteWaveCanvas').dataset.start",
    ),
    "4000",
  );
  report.checks.push(
    "Reconnect restores shared annotations without resetting either viewport",
  );
  // Exercise the update UI, which must send only the typed annotation fields.
  await evaluate(
    b,
    "document.querySelector('[data-marker-sample=\"7\"]').querySelectorAll('button')[1].click()",
  );
  await until(
    () =>
      evaluate(
        b,
        "document.querySelector('.remoteSidebarContent form input').value==='7'",
      ),
    "marker edit ready",
  );
  await evaluate(b, fill(".remoteSidebarContent form input", "8"));
  await evaluate(
    b,
    "document.querySelector('.remoteSidebarContent form').requestSubmit()",
  );
  await until(
    () => evaluate(a, "!!document.querySelector('[data-marker-sample=\"8\"]')"),
    "shared marker update",
  );
  report.checks.push(
    "Marker editing uses capture identity and annotation revision",
  );
  await evaluate(
    a,
    "document.querySelectorAll('.remoteSidebar nav button')[1].click()",
  );
  await evaluate(
    a,
    "document.querySelector('.remoteSidebarContent form').requestSubmit()",
  );
  const firstRow = await until(
    () =>
      evaluate(a, "document.querySelector('[data-decode-row]')?.textContent"),
    "UART decode rows",
  );
  assert.ok(firstRow);
  await evaluate(a, "document.querySelector('[data-decode-row]').click()");
  await until(
    () =>
      evaluate(
        a,
        "Number(document.querySelector('.remoteWaveCanvas').dataset.span)<1000",
      ),
    "decode row waveform focus",
  );
  report.checks.push(
    "UART results come from the host decoder and locate the waveform",
  );
  const screenshot = await cdp(
    "Page.captureScreenshot",
    { format: "png", captureBeyondViewport: false },
    a,
  );
  await writeFile(
    ".verification/remote-workbench.png",
    Buffer.from(screenshot.data, "base64"),
  );
  const saved = await evaluate(
    a,
    "(async()=>{const response=await fetch('/api/v1/sessions/demo/download');if(!response.ok)throw new Error('download failed');const bytes=new Uint8Array(await response.arrayBuffer());return btoa(Array.from(bytes,b=>String.fromCharCode(b)).join(''));})()",
  );
  const file = path.join(dir, "saved.pxl");
  await writeFile(file, Buffer.from(saved, "base64"));
  const { root } = await cdp("DOM.getDocument", {}, b);
  const { nodeId } = await cdp(
    "DOM.querySelector",
    { nodeId: root.nodeId, selector: "input[type=file]" },
    b,
  );
  await cdp("DOM.setFileInputFiles", { nodeId, files: [file] }, b);
  await until(
    () =>
      evaluate(
        b,
        "document.querySelector('.remoteCaptureBar select').value!=='demo'&&!!document.querySelector('[data-marker-sample=\"5\"]')",
      ),
    "file import roundtrip",
  );
  report.checks.push(
    "Production import UI reopens .pxl with the precise marker preserved",
  );
  const importedId = await evaluate(
    b,
    "document.querySelector('.remoteCaptureBar select').value",
  );
  await evaluate(
    b,
    "document.querySelector('.remoteCaptureBar button:last-of-type').click()",
  );
  await until(
    () =>
      evaluate(
        b,
        `![...document.querySelectorAll('.remoteCaptureBar select option')].some(o=>o.value===${JSON.stringify(importedId)})`,
      ),
    "release imported capture",
  );
  await evaluate(
    a,
    "document.querySelectorAll('.remoteSidebar nav button')[2].click()",
  );
  await until(
    () =>
      evaluate(
        a,
        "!!document.querySelector('.remoteSidebarContent form') && !document.querySelector('.remoteSidebarContent form .remotePrimary').disabled",
      ),
    "acquisition controls ready",
  );
  await evaluate(
    a,
    "document.querySelector('.remoteSidebarContent form').requestSubmit()",
  );
  await until(
    () =>
      evaluate(
        a,
        "document.querySelector('.remoteJob')?.textContent.includes('completed')&&document.querySelector('.remoteCaptureBar select').value.startsWith('remote-')&&!!document.querySelector('.remoteWaveCanvas canvas')",
      ),
    "remote acquisition completed",
  );
  report.checks.push(
    "Browser acquired a new Demo capture and closed its own imported workspace",
  );
  await writeFile(path.join(dir, "revoke-all"), "1");
  await until(
    () => evaluate(a, "!!document.querySelector('.remoteLogin')"),
    "Alice revoked",
  );
  await until(
    () => evaluate(b, "!!document.querySelector('.remoteLogin')"),
    "Bob revoked",
  );
  report.checks.push("Host revocation returns both browsers to login");
  report.passed = true;
} catch (e) {
  report.error = e.stack;
  report.chromium = chromeErrors.slice(-5000);
} finally {
  ws?.close();
  chrome?.kill("SIGTERM");
  backend.kill("SIGTERM");
  await delay(250);
  if (chrome?.exitCode === null) chrome.kill("SIGKILL");
  if (backend.exitCode === null) backend.kill("SIGKILL");
  await rm(dir, { recursive: true, force: true });
  await writeFile(
    ".verification/remote-browser-report.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report));
}
if (!report.passed) process.exitCode = 1;
