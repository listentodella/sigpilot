// Serve the built site from a subdirectory and exercise it in real Chromium.
// A fixture is served only for USB methods; no device hooks enter the build.
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { unzipSync } from "fflate";

const build = path.resolve("dist-webusb"),
  fixture = await readFile(new URL("./fixture.js", import.meta.url), "utf8");
const dir = await mkdtemp(path.join(tmpdir(), "sigpilot-webusb-"));
let mode = "working",
  trace = [],
  failures = [],
  checks = [],
  ws,
  chrome;
const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".ttf": "font/ttf",
};
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
    const script =
      "globalThis.fixtureMode=" + JSON.stringify(mode) + ";\n" + fixture;
    if (url.pathname === "/fixture.js") {
      res.setHeader("Content-Type", "text/javascript");
      res.end(script);
      return;
    }
    if (!url.pathname.startsWith("/lab/")) throw Error("unknown path");
    const file = path.resolve(build, url.pathname.slice(5) || "index.html");
    if (!file.startsWith(build + path.sep)) throw Error("invalid path");
    let data = await readFile(file);
    if (file.endsWith("index.html") && mode !== "native")
      data = Buffer.from(
        data
          .toString()
          .replace("<head>", '<head><script src="/fixture.js"></script>'),
      );
    if (mode !== "native" && path.basename(file).startsWith("device.worker-"))
      data = Buffer.concat([Buffer.from(script + "\n"), data]);
    if (
      mode === "bad-bitfile" &&
      path.basename(file).startsWith("hspi_ddr_RST")
    )
      data[10] ^= 255;
    res.writeHead(200, {
      "Content-Type": types[path.extname(file)] ?? "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = "http://127.0.0.1:" + server.address().port + "/lab/";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(f, label) {
  const end = Date.now() + 14000;
  let last;
  while (Date.now() < end) {
    try {
      const result = await f();
      if (result) return result;
    } catch (e) {
      last = e;
    }
    await sleep(80);
  }
  throw Error(
    label +
      " timed out: " +
      (last ?? "") +
      "; trace " +
      JSON.stringify(trace.slice(-6)) +
      "; " +
      failures.slice(-2),
  );
}
let seq = 0;
const pending = new Map();
function cdp(method, params = {}) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const r = await cdp("Runtime.evaluate", {
    expression,
    returnByValue: true,
    userGesture: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails)
    throw Error(
      r.exceptionDetails.exception?.description ?? r.exceptionDetails.text,
    );
  return r.result.value;
}
const phase = () => evaluate("document.querySelector('main')?.dataset.phase");
const status = () =>
  evaluate("document.querySelector('[role=status]')?.innerText");
const click = (id) =>
  evaluate("document.getElementById(" + JSON.stringify(id) + ").click()");
async function page(scenario) {
  mode = scenario;
  trace = [];
  await cdp("Page.navigate", { url: base + "?" + scenario });
  await until(
    async () =>
      await evaluate(
        "location.search===" +
          JSON.stringify("?" + scenario) +
          " && !!document.getElementById('connect')",
      ),
    "load " + scenario,
  );
}
const waitPhase = (p) => until(async () => (await phase()) === p, "phase " + p);
async function connect(scenario, expected) {
  await page(scenario);
  await click("connect");
  await waitPhase(expected);
}
async function rejected(scenario, reason) {
  await page(scenario);
  await click("connect");
  await until(
    async () => (await phase()) === "idle" && reason.test(await status()),
    scenario,
  );
  assert.equal(await phase(), "idle");
  checks.push(scenario);
}
function digest(b) {
  return createHash("sha256").update(b).digest("hex");
}
try {
  const cpu = (await readFile("/proc/self/status", "utf8")).match(
    /^Cpus_allowed_list:\s*(\d+)/m,
  )[1];
  chrome = spawn(
    "taskset",
    [
      "-c",
      cpu,
      "chromium",
      "--headless=new",
      "--window-size=1440,950",
      "--no-sandbox",
      "--no-zygote",
      "--disable-gpu",
      "--in-process-gpu",
      "--disable-dev-shm-usage",
      "--disable-background-networking",
      "--disable-extensions",
      "--disable-webgl",
      "--disable-software-rasterizer",
      "--disable-breakpad",
      "--num-raster-threads=1",
      "--renderer-process-limit=2",
      "--enable-features=NetworkServiceInProcess,NetworkServiceInProcess2",
      "--disable-features=AudioServiceOutOfProcess,MediaRouter",
      "--remote-debugging-port=0",
      "--user-data-dir=" + dir,
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  const port = await until(
    async () =>
      (await readFile(path.join(dir, "DevToolsActivePort"), "utf8")).split(
        "\n",
      )[0],
    "Chromium",
  );
  const targets = await (
    await fetch("http://127.0.0.1:" + port + "/json/list")
  ).json();
  ws = new WebSocket(
    targets.find((t) => t.type === "page").webSocketDebuggerUrl,
  );
  await new Promise((r, j) => {
    ws.onopen = r;
    ws.onerror = j;
  });
  ws.onmessage = (e) => {
    const v = JSON.parse(e.data),
      p = pending.get(v.id);
    if (p) {
      pending.delete(v.id);
      if (v.error) p.reject(Error(v.error.message));
      else p.resolve(v.result);
    } else if (v.method === "Runtime.exceptionThrown")
      failures.push(v.params.exceptionDetails.text);
  };
  await cdp("Runtime.enable");
  await cdp("Page.enable");
  await cdp("Page.setDownloadBehavior", {
    behavior: "allow",
    downloadPath: dir,
  });
  await page("native");
  assert.deepEqual(
    await evaluate(
      "(async()=>[window.isSecureContext,typeof navigator.usb.requestDevice,(await navigator.usb.getDevices()).length])()",
    ),
    [true, "function", 0],
  );
  checks.push(
    "native WebUSB API on loopback, no authorized hardware in Instabox",
  );
  await page("unsupported");
  assert(await evaluate("document.querySelector('#connect').disabled"));
  checks.push("unsupported browser");
  await rejected("dismiss", /未选择/);
  await rejected("identity", /身份/);
  assert.equal(trace.length, 0);
  await rejected("ambiguous", /唯一/);
  assert.equal(trace.length, 0);
  await rejected("denied", /接口 1/);
  assert.deepEqual(trace, [["open"], ["claim", 0], ["claim", 1], ["close"]]);
  await rejected("short", /长度/);
  await rejected("firmware", /未知 MCU/);
  await rejected("bad-bitfile", /校验失败/);
  assert(!trace.some((v) => v[0] === "write"));
  await rejected("ack", /未确认/);
  await connect("working", "ready");
  const expectedPayloads = [];
  for (const name of ["hspi_ddr_RST.bin", "hspi_ddr.bin"]) {
    const bytes = await readFile("resources/bitstreams/" + name);
    const padded = Buffer.alloc(Math.ceil(bytes.length / 4096) * 4096);
    bytes.copy(padded);
    expectedPayloads.push(["payload", padded.length, digest(padded)]);
  }
  assert.deepEqual(
    trace.filter((v) => v[0] === "payload"),
    expectedPayloads,
  );
  assert.deepEqual(
    trace.filter((v) => v[0] === "write").map((v) => v.slice(1)),
    [
      [8216, 0],
      [8220, 765952],
      [8224, 4],
      [8216, 0],
      [8220, 765952],
      [8224, 4],
    ],
  );
  checks.push("verified FPGA reset and main payloads in order");
  trace = [];
  await evaluate(
    "(()=>{const el=document.querySelector('[name=channels]');el.value='16';el.dispatchEvent(new Event('change',{bubbles:true}));})()",
  );
  await click("capture");
  await until(
    () => evaluate("!!document.querySelector('.remoteWaveCanvas canvas')"),
    "actual waveform",
  );
  await waitPhase("ready");
  const writes = trace.filter((v) => v[0] === "write").map((v) => v.slice(1));
  assert.deepEqual(writes, [
    [8236, 0],
    [4, 12000],
    [8, 3599],
    [16, 0],
    [0, 5],
    [0, 21],
    [0, 5],
    [32, 0xffffffff],
    [28, 65536],
    [8200, 65536],
    [8228, 98304],
    [8232, 0],
    [60, 0],
    [88, 0],
    [20, 7],
    [24, 99],
    [8268, 16],
    [8272, 64],
    [8236, 0],
    [16, 65535],
    [0, 0],
    [36, 0],
    [40, 0],
    [44, 0],
    [48, 0],
    [32, 0],
    [8204, 1],
    [8208, 98305],
    [8212, 2],
    [32, 0xffffffff],
  ]);
  await click("next");
  assert.match(
    await evaluate("document.querySelector('#level').textContent"),
    /D0 = 1/,
  );
  await evaluate("document.querySelector('[aria-label=放大]').click()");
  await until(
    () =>
      evaluate(
        "+document.querySelector('.remoteWaveCanvas').dataset.span<16384",
      ),
    "zoom",
  );
  await click("save");
  const file = await until(
    async () => (await readdir(dir)).find((f) => f.endsWith(".pxcap")),
    "download",
  );
  const archive = unzipSync(await readFile(path.join(dir, file)));
  const meta = JSON.parse(Buffer.from(archive["metadata.json"]).toString());
  assert.deepEqual(
    [meta.channel_count, meta.unitsize, meta.sample_count, meta.sample_rate_hz],
    [16, 2, 16384, 1000000],
  );
  const samples = Buffer.from(archive["samples.bin"]);
  assert.equal(samples.length, 32768);
  for (let n = 0; n < 16384; n++) assert.equal(samples.readUInt16LE(2 * n), n);
  // A narrow window shows individual transitions in the review screenshot.
  for (let i = 0; i < 7; i++)
    await evaluate("document.querySelector('[aria-label=放大]').click()");
  await sleep(350);
  const screen = await cdp("Page.captureScreenshot", { format: "png" });
  await writeFile(
    ".verification/webusb-workbench.png",
    Buffer.from(screen.data, "base64"),
  );
  checks.push(
    "DDR register sequence, fragmented 16-channel capture, exact edges, zoom and .pxcap sample-by-sample",
  );
  await click("disconnect");
  await waitPhase("idle");
  assert(await evaluate("!!document.querySelector('#save')"));
  for (const scenario of ["timeout", "unplug", "cancel"]) {
    await connect(scenario, "ready");
    await click("capture");
    await until(() => trace.some((v) => v[0] === "pending"), "blocked read");
    if (scenario === "cancel") await click("disconnect");
    await waitPhase("idle");
    if (scenario === "cancel")
      assert.deepEqual(trace.slice(-2), [["write", 32, 0xffffffff], ["close"]]);
    assert(trace.some((v) => v[0] === "close"));
    assert(!(await evaluate("!!document.querySelector('#save')")));
    assert.match(
      await status(),
      { timeout: /超时/, unplug: /拔出/, cancel: /断开/ }[scenario],
    );
    checks.push(scenario);
  }
  async function firmwareFile(file) {
    const dom = await cdp("DOM.getDocument");
    const input = await cdp("DOM.querySelector", {
      nodeId: dom.root.nodeId,
      selector: "input[type=file]",
    });
    await cdp("DOM.setFileInputFiles", {
      nodeId: input.nodeId,
      files: [path.resolve(file)],
    });
    await click("flash");
  }
  await connect("boot-invalid", "boot");
  assert(!trace.some((v) => v[0] === "write"));
  await firmwareFile("package.json");
  await waitPhase("idle");
  assert.match(await status(), /校验失败/);
  assert(!trace.some((v) => v[0] === "write"));
  await connect("boot", "boot");
  await firmwareFile("resources/firmware/SCI_LOGIC.bin");
  await waitPhase("idle");
  const block = Buffer.alloc(49152, 255);
  (await readFile("resources/firmware/SCI_LOGIC.bin")).copy(block);
  assert.deepEqual(
    trace.filter((v) => v[0] === "payload"),
    [["payload", 147456, digest(Buffer.concat([block, block, block]))]],
  );
  assert.deepEqual(
    trace.filter((v) => v[0] === "write").map((v) => v.slice(1)),
    [
      [8216, 49152],
      [8220, 196608],
      [8224, 0],
      [8240, 0],
    ],
  );
  mode = "working";
  await click("connect");
  await waitPhase("ready");
  checks.push("bootloader, explicit verified MCU image and reauthorization");
  assert.deepEqual(failures, []);
  console.log(
    JSON.stringify(
      {
        checks,
        device: "simulated USB transport",
        browser: execFileSync("chromium", ["--version"], {
          encoding: "utf8",
        }).trim(),
      },
      null,
      2,
    ),
  );
} finally {
  ws?.close();
  chrome?.kill("SIGKILL");
  server.closeAllConnections();
  server.close();
  await rm(dir, {
    force: true,
    recursive: true,
    maxRetries: 4,
    retryDelay: 100,
  });
}
