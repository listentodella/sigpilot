#!/usr/bin/env node
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(process.argv[2] ?? "resources/native");
const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const exe = process.platform === "win32" ? ".exe" : "";
const sigrok = join(root, "sigrok-analyzer-sidecar");
const saleae = join(root, "saleae-analyzer-sidecar");
const env = { ...process.env, PYTHONDONTWRITEBYTECODE: "1" };
if (existsSync(join(sigrok, "python-runtime"))) env.PYTHONHOME = join(sigrok, "python-runtime");
else delete env.PYTHONHOME;
// Resolve bundled DLLs rather than accidentally relying on a build machine.
if (process.platform === "win32") env.PATH = `${sigrok};${saleae};${join(saleae, "runtime")};${process.env.SystemRoot}\\System32`;
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
console.log("Packaged native runtime: catalogs, C/Python decode and Saleae SPI fixture passed.");
