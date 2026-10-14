#!/usr/bin/env node
// Manifest layout regressions, using synthetic payloads, not a native rebuild.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sealRuntime, verifyRuntime } from "./native-runtime.mjs";

const scratch = mkdtempSync(join(process.env.PI_SCRATCH_DIR ?? process.env.RUNNER_TEMP ?? tmpdir(), "sigpilot-python-layout-"));
function file(root, path, content = "fixture") {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), content);
}
try {
  for (const platform of ["macos-arm64", "macos-x64", "linux-x64", "windows-x64"]) {
    const root = join(scratch, platform);
    const windows = platform === "windows-x64", exe = windows ? ".exe" : "";
    for (const path of [`saleae-analyzer-sidecar/sigpilot-saleae-analyzer-sidecar${exe}`,
      "saleae-analyzer-sidecar/runtime/module", `sigrok-analyzer-sidecar/sigpilot-sigrok-sidecar${exe}`,
      "sigrok-analyzer-sidecar/decoders/c_decoders/module", "sigrok-analyzer-sidecar/decoders/python_decoders/module",
      "hla-analyzer-sidecar/saleae/data.py", "hla-analyzer-sidecar/saleae/__init__.py",
      `python-runtime/bin/${windows ? "python.exe" : "python3"}`, "hla-analyzer-sidecar/main.py", "hla-analyzer-sidecar/saleae/analyzers.py",
      "python-runtime/lib/python3.13/encodings/__init__.py", `python-runtime/${windows ? "bin/python313.dll" : "lib/libpython3.13.so"}`]) file(root, path);
    file(root, "python-runtime/runtime.json", JSON.stringify({ implementation: "cpython", version: "3.13.0",
      stdlib: "lib/python3.13", shared_library: windows ? "bin/python313.dll" : "lib/libpython3.13.so" }));
    const fingerprint = "layout-test";
    const manifest = sealRuntime(root, platform, fingerprint);
    assert.equal(manifest.schema, 2);
    verifyRuntime(root, platform, fingerprint);
    rmSync(join(root, "hla-analyzer-sidecar/main.py"));
    assert.throws(() => verifyRuntime(root, platform, fingerprint), /missing hla-analyzer-sidecar\/main.py/);
    file(root, "hla-analyzer-sidecar/main.py");
    mkdirSync(join(root, "sigrok-analyzer-sidecar/python-runtime"));
    assert.throws(() => sealRuntime(root, platform, fingerprint), /Duplicate Sigrok Python runtime/);
    rmSync(join(root, "sigrok-analyzer-sidecar/python-runtime"), { recursive: true });
    rmSync(join(root, "python-runtime/lib/python3.13/encodings/__init__.py"));
    assert.throws(() => sealRuntime(root, platform, fingerprint), /Missing Python encodings stdlib/);
  }
  console.log("Shared CPython manifest layout: all four platforms passed.");
} finally { rmSync(scratch, { recursive: true, force: true }); }
