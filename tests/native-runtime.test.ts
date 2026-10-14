import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { sealRuntime, verifyRuntime, installRuntime, sourceFingerprint } from "../scripts/native-runtime.mjs";

function temporary(run: (root: string) => void) {
  const root = mkdtempSync(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "native-runtime-test-"));
  try { run(root); } finally { rmSync(root, { recursive: true, force: true }); }
}
function payload(root: string) {
  for (const path of ["saleae-analyzer-sidecar/runtime", "sigrok-analyzer-sidecar/decoders/c_decoders",
    "sigrok-analyzer-sidecar/decoders/python_decoders", "python-runtime/bin", "python-runtime/lib/python3.14/encodings", "hla-analyzer-sidecar/saleae"]) {
    mkdirSync(join(root, path), { recursive: true });
    writeFileSync(join(root, path, "fixture.txt"), "runtime fixture");
  }
  for (const path of ["saleae-analyzer-sidecar/sigpilot-saleae-analyzer-sidecar",
    "sigrok-analyzer-sidecar/sigpilot-sigrok-sidecar", "python-runtime/bin/python3"]) {
    writeFileSync(join(root, path), "executable fixture");
    chmodSync(join(root, path), 0o755);
  }
  writeFileSync(join(root, "python-runtime/runtime.json"), JSON.stringify({ implementation: "cpython", version: "3.14.6",
    stdlib: "lib/python3.14", shared_library: "lib/libpython3.14.so" }));
  writeFileSync(join(root, "python-runtime/lib/libpython3.14.so"), "shared python library");
  writeFileSync(join(root, "python-runtime/lib/python3.14/encodings/__init__.py"), "# encodings");
  for (const path of ["hla-analyzer-sidecar/main.py", "hla-analyzer-sidecar/saleae/analyzers.py",
    "hla-analyzer-sidecar/saleae/data.py", "hla-analyzer-sidecar/saleae/__init__.py"]) writeFileSync(join(root, path), "# original host");
}

test("runtime manifests validate contents, source identity and platform", () => temporary((root) => {
  payload(root);
  sealRuntime(root, "linux-x64", "source-a");
  assert.equal(verifyRuntime(root, "linux-x64", "source-a").platform, "linux-x64");
  assert.throws(() => verifyRuntime(root, "linux-x64", "source-b"), /mismatch/);
  assert.throws(() => verifyRuntime(root, "macos-arm64", "source-a"), /mismatch/);
  writeFileSync(join(root, "sigrok-analyzer-sidecar/decoders/c_decoders/fixture.txt"), "tampered");
  assert.throws(() => verifyRuntime(root, "linux-x64", "source-a"), /integrity failure/);
}));

test("runtime manifests reject missing files, extra files and duplicate entries", () => temporary((root) => {
  payload(root);
  const manifest = sealRuntime(root, "linux-x64", "source-a");
  writeFileSync(join(root, "extra.dll"), "unexpected");
  assert.throws(() => verifyRuntime(root, "linux-x64", "source-a"), /Unexpected/);
  rmSync(join(root, "extra.dll"));
  manifest.files.push(manifest.files[0]);
  writeFileSync(join(root, "native-runtime-manifest.json"), JSON.stringify(manifest));
  assert.throws(() => verifyRuntime(root, "linux-x64", "source-a"), /Duplicate/);
  sealRuntime(root, "linux-x64", "source-a");
  rmSync(join(root, "sigrok-analyzer-sidecar/sigpilot-sigrok-sidecar"));
  assert.throws(() => verifyRuntime(root, "linux-x64", "source-a"), /missing/);
}));

test("native fingerprint ignores frontend changes but follows native source content", () => temporary((root) => {
  assert.equal(spawnSync("git", ["init", "-q", root]).status, 0);
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "native/saleae-analyzer-sidecar"), { recursive: true });
  writeFileSync(join(root, "src/App.tsx"), "frontend v1");
  writeFileSync(join(root, "native/saleae-analyzer-sidecar/main.cpp"), "native v1");
  const first = sourceFingerprint(root);
  writeFileSync(join(root, "src/App.tsx"), "frontend v2");
  assert.equal(sourceFingerprint(root), first);
  writeFileSync(join(root, "native/saleae-analyzer-sidecar/main.cpp"), "native v2");
  assert.notEqual(sourceFingerprint(root), first);
}));

test("native fingerprint follows unstaged tracked deletions", () => temporary((root) => {
  assert.equal(spawnSync("git", ["init", "-q", root]).status, 0);
  mkdirSync(join(root, "native/saleae-analyzer-sidecar"), { recursive: true });
  const source = join(root, "native/saleae-analyzer-sidecar/main.cpp");
  writeFileSync(source, "native source");
  assert.equal(spawnSync("git", ["-C", root, "add", "."]).status, 0);
  const before = sourceFingerprint(root);
  rmSync(source);
  assert.notEqual(sourceFingerprint(root), before);
}));

test("validated tar import restores executable modes and does not replace on mismatch", () => temporary((root) => {
  const source = join(root, "source"), destination = join(root, "installed"), archive = join(root, "runtime.tar.gz");
  mkdirSync(destination);
  writeFileSync(join(destination, ".gitkeep"), "");
  mkdirSync(source); payload(source); sealRuntime(source, "linux-x64", "source-a");
  assert.equal(spawnSync("tar", ["-czf", archive, "-C", source, "."]).status, 0);
  installRuntime(archive, "linux-x64", destination, "source-a");
  assert.equal(readFileSync(join(destination, ".gitkeep"), "utf8"), "");
  verifyRuntime(destination, "linux-x64", "source-a");
  const executable = join(destination, "sigrok-analyzer-sidecar/sigpilot-sigrok-sidecar");
  if (process.platform !== "win32") assert.equal(statSync(executable).mode & 0o777, 0o755);
  assert.throws(() => installRuntime(archive, "linux-x64", destination, "source-b"), /mismatch/);
  assert.equal(readFileSync(executable, "utf8"), "executable fixture");
}));

test("runtime requires a single shared CPython and complete HLA host", () => temporary((root) => {
  payload(root);
  sealRuntime(root, "macos-arm64", "source-a");
  mkdirSync(join(root, "sigrok-analyzer-sidecar/python-runtime"));
  assert.throws(() => sealRuntime(root, "macos-arm64", "source-a"), /Duplicate/);
  rmSync(join(root, "sigrok-analyzer-sidecar/python-runtime"), { recursive: true });
  rmSync(join(root, "hla-analyzer-sidecar/saleae/data.py"));
  assert.throws(() => sealRuntime(root, "macos-arm64", "source-a"), /missing/);
}));

test("client CI consumes native artifacts on hosted runners without native builds", () => {
  const client = readFileSync(new URL("../.github/workflows/build-cross-platform.yml", import.meta.url), "utf8");
  const native = readFileSync(new URL("../.github/workflows/native-runtime.yml", import.meta.url), "utf8");
  assert.doesNotMatch(client, /self-hosted|cache-targets: false|shell: msys2/);
  assert.doesNotMatch(client, /run: .*prepare-tauri-resources|run: .*sigrok-analyzer-sidecar\/verify/);
  assert.match(client, /uses: \.\/\.github\/workflows\/native-runtime.yml/);
  assert.equal((client.match(/SIGPILOT_PREBUILT_NATIVE: '1'/g) ?? []).length, 3);
  assert.match(client, /needs: \[checks, native-windows\]/);
  assert.match(client, /needs: \[checks, native-linux\]/);
  assert.match(client, /needs: \[checks, native-macos\]/);
  assert.equal((client.match(/cache-targets: true/g) ?? []).length, 4);
  assert.match(client, /pattern: sigpilot-\*/);
  assert.match(native, /steps.identity.outputs.source/);
  assert.match(native, /steps.identity.outputs.image/);
  assert.match(native, /steps.cache.outputs.cache-hit != 'true'/);
  assert.match(native, /native\/sigrok-analyzer-sidecar\/verify.sh/);
  assert.match(native, /ctest --test-dir/);
});
