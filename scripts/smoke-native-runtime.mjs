#!/usr/bin/env node
import assert from "node:assert/strict";
import { existsSync, readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

const root = resolve(process.argv[2] ?? "resources/native");
const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const exe = process.platform === "win32" ? ".exe" : "";
const sigrok = join(root, "sigrok-analyzer-sidecar");
const saleae = join(root, "saleae-analyzer-sidecar");
const pythonRoot = join(root, "python-runtime");
const pythonExe = join(pythonRoot, "bin", exe ? "python.exe" : "python3");
const env = { ...process.env, PYTHONDONTWRITEBYTECODE: "1" };
if (existsSync(pythonRoot)) env.PYTHONHOME = pythonRoot;
else if (existsSync(join(sigrok, "python-runtime"))) env.PYTHONHOME = join(sigrok, "python-runtime");
else delete env.PYTHONHOME;
delete env.PYTHONPATH;
delete env.DYLD_LIBRARY_PATH;
delete env.DYLD_FRAMEWORK_PATH;
delete env.LD_LIBRARY_PATH;
// Resolve bundled DLLs rather than accidentally relying on a build machine.
if (process.platform === "win32") env.PATH = `${join(pythonRoot, "bin")};${sigrok};${saleae};${join(saleae, "runtime")};${process.env.SystemRoot}\\System32`;
function invoke(binary, args, request) {
  const result = spawnSync(binary, args, { env, encoding: "utf8", input: request && JSON.stringify(request), maxBuffer: 32 * 1024 * 1024 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${binary}: ${result.stderr}`);
  return JSON.parse(result.stdout);
}
const cArgs = ["--decoder-root", join(sigrok, "decoders/c_decoders")];
const pythonArgs = [...cArgs, "--python-decoder-root", join(sigrok, "decoders/python_decoders")];
const sigrokExe = join(sigrok, `sigpilot-sigrok-sidecar${exe}`);
const catalog = invoke(sigrokExe, [...pythonArgs, "--probe", "--catalog"]);
assert.equal(catalog.available, true);
assert.ok(catalog.c_decoder_count >= 200 && catalog.python_decoder_count >= 200);
assert.ok(catalog.decoder_catalog.filter((entry) => entry.runner_status === "generic_sparse_c").length >= 90);
const request = { format: "pxlogic.decoder.v1", sample_rate_hz: 1_000_000, sample_count: 100,
  channel_count: 1, initial_levels: [0], edges: [{ channel: 0, samples: [10, 20, 30, 40] }],
  decoder: { protocol: "guess_bitrate_c", channels: { data: 0 }, options: {} } };
const cResult = invoke(sigrokExe, [...cArgs, "--decode"], request);
assert.equal(cResult.backend, "sigrok_native");
assert.deepEqual(cResult.frames.filter((frame) => frame.row === "Bitrate").map((frame) => frame.texts[0]), ["100000"]);
const pythonResult = invoke(sigrokExe, [...pythonArgs, "--decode"], { ...request,
  edges: [{ channel: 0, samples: [10, 20, 30, 40, 50, 60] }],
  decoder: { protocol: "python:pwm", channels: { data: 0 }, options: { polarity: "active-high" } } });
assert.equal(pythonResult.backend, "sigrok_native");
assert.deepEqual(pythonResult.frames.filter((frame) => frame.row === "Duty cycle").map((frame) => frame.texts[0]), ["50.000000%", "50.000000%"]);
const saleaeExe = join(saleae, `sigpilot-saleae-analyzer-sidecar${exe}`);
const saleaeArgs = ["--runtime-root", join(saleae, "runtime")];
const saleaeProbe = invoke(saleaeExe, [...saleaeArgs, "--probe"]);
assert.equal(saleaeProbe.available, true);
assert.ok(saleaeProbe.protocols.includes("SPI"));
const fixture = JSON.parse(readFileSync(join(project, "testdata/decoders/spi-conformance-v1.json"), "utf8")).cases[0];
const spiResult = invoke(saleaeExe, [...saleaeArgs, "--decode"], fixture);
assert.equal(spiResult.backend, "saleae_native");
assert.ok(spiResult.frames.length > 0);
assert.deepEqual(spiResult.frames.flatMap((frame) => frame.channel_values.filter((value) => value.role === "MOSI").map((value) => value.value)), fixture.expected_words.map((word) => word.mosi));
const scratch = mkdtempSync(join(process.env.PI_SCRATCH_DIR ?? process.env.RUNNER_TEMP ?? tmpdir(), "sigpilot-hla-smoke-"));
try {
  const metadata = JSON.parse(readFileSync(join(pythonRoot, "runtime.json"), "utf8"));
  const pythonProbe = spawnSync(pythonExe, ["-s", "-c", "import sys, ssl, sqlite3, ctypes, zlib; print(sys.version.split()[0])"], { env, encoding: "utf8", timeout: 30_000 });
  assert.equal(pythonProbe.status, 0, pythonProbe.stderr);
  assert.equal(pythonProbe.stdout.trim(), metadata.version);
  writeFileSync(join(scratch, "extension.json"), JSON.stringify({ name: "Packaged smoke", apiVersion: "1.0.0", version: "1.0.0", author: "SigPilot", description: "Original smoke fixture", extensions: { Smoke: { type: "HighLevelAnalyzer", entryPoint: "smoke.Smoke" } } }));
  writeFileSync(join(scratch, "smoke.py"), `from saleae.analyzers import HighLevelAnalyzer, AnalyzerFrame, NumberSetting
class Smoke(HighLevelAnalyzer):
    step = NumberSetting(default=2, min_value=1, max_value=10)
    result_types = {'count': {'format': '{{data.count}}'}}
    def __init__(self):
        self.count = 0
    def decode(self, frame):
        self.count += self.step
        return AnalyzerFrame('count', frame.start_time, frame.end_time, {'count': self.count})
`);
  const initial = { manifest_path: join(scratch, "extension.json"), entry_point: "smoke.Smoke", settings: { step: 3 }, sample_rate_hz: 1_000_000 };
  function hla(requests) {
    const result = spawnSync(pythonExe, ["-s", join(root, "hla-analyzer-sidecar/main.py")], { env, encoding: "utf8", timeout: 30_000,
      input: [...requests, { op: "finish" }].map((request) => JSON.stringify(request)).join("\n") + "\n" });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    const responses = result.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line));
    assert.deepEqual(responses.at(-1), { done: true });
    return responses;
  }
  const inspection = hla([{ ...initial, op: "inspect" }]);
  assert.ok(inspection[0].settings.some((setting) => setting.id === "step" && setting.default === 2));
  const frame = (start) => ({ type: "data", start_sample: start, end_sample: start + 1, data: {} });
  const batches = hla([{ ...initial, op: "start" }, { op: "batch", frames: [frame(10)] }, { op: "batch", frames: [frame(20)] }]);
  assert.deepEqual(batches[0], { ready: true });
  assert.deepEqual(batches.slice(1, 3).map((batch) => batch.frames[0].data.count), [{ Signed: 3 }, { Signed: 6 }]);
  assert.deepEqual(batches.slice(1, 3).map((batch) => batch.frames[0].start_sample), [10, 20]);
} finally { rmSync(scratch, { recursive: true, force: true }); }
console.log("Packaged native runtime: catalogs, C/Python decode, Saleae SPI and HLA inspect/start/batches passed.");
