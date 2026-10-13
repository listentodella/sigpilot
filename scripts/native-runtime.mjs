#!/usr/bin/env node
// Native runtime packages are independent of frontend/Rust revisions. No native
// compiler or Bash is invoked when a client consumes a verified package.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, writeFileSync,
  mkdirSync, mkdtempSync, rmSync, renameSync, chmodSync } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RESOURCE_ROOT = join(ROOT, "resources/native");
const MANIFEST = "native-runtime-manifest.json";
const SCHEMA = 1;
const SOURCE_PATHS = ["native/sigrok-analyzer-sidecar", "native/saleae-analyzer-sidecar",
  "vendor/pxview-sigrokdecode", "vendor/saleae-standalone", "vendor/nlohmann-json",
  "scripts/prepare-tauri-resources.sh", "scripts/prepare-tauri-resources.mjs", "scripts/native-runtime.mjs",
  "scripts/smoke-native-runtime.mjs", "scripts/normalize-python-runtime.mjs", "scripts/install-macos-native-deps.sh",
  ".github/workflows/native-runtime.yml", "testdata/decoders"];
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

const TAR = process.platform === "win32" ? join(process.env.SystemRoot ?? "C:/Windows", "System32/tar.exe") : "tar";
function run(program, args, options = {}) {
  const result = spawnSync(program, args, { cwd: ROOT, encoding: "utf8", ...options });
  if (result.error || result.status !== 0) throw new Error(`${program} failed: ${result.error?.message ?? result.stderr}`);
  return result.stdout;
}

export function nativePlatform() {
  const arch = process.env.SIGPILOT_MACOS_ARCH ?? process.arch;
  if (process.platform === "win32") return "windows-x64";
  if (process.platform === "linux" && arch === "x64") return "linux-x64";
  if (process.platform === "darwin") return `macos-${arch === "x86_64" ? "x64" : arch}`;
  throw new Error(`Unsupported native runtime platform: ${process.platform}/${arch}`);
}

export function sourceFingerprint(root = ROOT) {
  const result = spawnSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...SOURCE_PATHS],
    { cwd: root, encoding: "utf8" });
  if (result.error || result.status !== 0) throw new Error("Cannot enumerate native runtime sources");
  const hash = createHash("sha256");
  for (const path of [...new Set(result.stdout.split("\0").filter(Boolean))].sort()) {
    // git ls-files includes tracked deletions until they are staged. Omission
    // must change the hash, not make local native builds unusable.
    if (!existsSync(join(root, path))) continue;
    // Ignore local build products even in older checkouts without an ignore rule.
    if (path.split("/").includes("target")) continue;
    hash.update(path).update("\0").update(readFileSync(join(root, path))).update("\0");
  }
  return hash.digest("hex");
}

function safePath(path) {
  if (!path || path.includes("\\") || path.startsWith("/") || path.split("/").some((part) => !part || part === "." || part === "..") || /^[a-z]:/i.test(path)) {
    throw new Error(`Unsafe runtime path: ${path}`);
  }
  return path;
}

function inventory(root, prefix = "") {
  const files = [];
  for (const name of readdirSync(join(root, prefix)).sort()) {
    const path = prefix ? `${prefix}/${name}` : name;
    if (path === MANIFEST || path === ".gitkeep") continue;
    safePath(path);
    const full = join(root, path), stat = lstatSync(full);
    if (stat.isDirectory()) files.push(...inventory(root, path));
    else if (stat.isFile()) files.push({ path, sha256: sha256(readFileSync(full)), mode: stat.mode & 0o777 });
    else if (stat.isSymbolicLink()) {
      const link = readlinkSync(full);
      const target = relative(root, resolve(dirname(full), link));
      if (target.startsWith("..") || resolve(link) === link) throw new Error(`External runtime symlink: ${path}`);
      files.push({ path, link });
    } else throw new Error(`Unsupported runtime entry: ${path}`);
  }
  return files;
}

function requirePayload(root, platform) {
  if (!["windows-x64", "linux-x64", "macos-arm64", "macos-x64"].includes(platform)) throw new Error(`Unsupported package platform: ${platform}`);
  const exe = platform.startsWith("windows") ? ".exe" : "";
  for (const path of [`saleae-analyzer-sidecar/sigpilot-saleae-analyzer-sidecar${exe}`,
    "saleae-analyzer-sidecar/runtime", `sigrok-analyzer-sidecar/sigpilot-sigrok-sidecar${exe}`,
    "sigrok-analyzer-sidecar/decoders/c_decoders", "sigrok-analyzer-sidecar/decoders/python_decoders",
    ...(!platform.startsWith("macos") ? ["sigrok-analyzer-sidecar/python-runtime"] : [])]) {
    if (!existsSync(join(root, path))) throw new Error(`Native runtime is missing ${path}`);
  }
}

export function sealRuntime(root = RESOURCE_ROOT, platform = nativePlatform(), fingerprint = sourceFingerprint()) {
  requirePayload(root, platform);
  const manifest = { schema: SCHEMA, platform, sourceFingerprint: fingerprint,
    toolchain: process.env.SIGPILOT_NATIVE_TOOLCHAIN ?? "local", files: inventory(root) };
  writeFileSync(join(root, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export function verifyRuntime(root = RESOURCE_ROOT, platform = nativePlatform(), fingerprint = sourceFingerprint()) {
  const manifest = JSON.parse(readFileSync(join(root, MANIFEST), "utf8"));
  if (manifest.schema !== SCHEMA || manifest.platform !== platform || manifest.sourceFingerprint !== fingerprint) {
    throw new Error("Native runtime source/platform mismatch; rebuild or download the matching runtime package");
  }
  requirePayload(root, platform);
  if (!Array.isArray(manifest.files) || !manifest.files.length) throw new Error("Empty native runtime manifest");
  const actual = inventory(root), expected = new Map();
  for (const file of manifest.files) {
    safePath(file.path);
    if (expected.has(file.path)) throw new Error(`Duplicate runtime entry: ${file.path}`);
    expected.set(file.path, file);
  }
  if (actual.length !== expected.size) throw new Error("Unexpected or missing runtime files");
  for (const file of actual) {
    const entry = expected.get(file.path);
    if (!entry || file.sha256 !== entry.sha256 || file.link !== entry.link) throw new Error(`Native runtime integrity failure: ${file.path}`);
    // GitHub artifact ZIPs discard modes; tar plus this manifest restores them.
    if (!file.link && process.platform !== "win32") chmodSync(join(root, file.path), entry.mode);
  }
  return manifest;
}

export function installRuntime(archive, platform, destination = RESOURCE_ROOT, fingerprint = sourceFingerprint()) {
  const scratch = mkdtempSync(join(tmpdir(), "sigpilot-native-"));
  try {
    const entries = run(TAR, ["-tzf", resolve(archive)]).split(/\r?\n/).filter(Boolean);
    for (const entry of entries) {
      const normalized = entry.replace(/^\.\//, "").replace(/\/$/, "");
      if (normalized) safePath(normalized);
    }
    run(TAR, ["-xzf", resolve(archive), "-C", scratch]);
    verifyRuntime(scratch, platform, fingerprint);
    mkdirSync(dirname(destination), { recursive: true });
    const staging = `${destination}.staging-${process.pid}`;
    rmSync(staging, { recursive: true, force: true });
    // Extract on the destination filesystem so the final directory rename is safe.
    mkdirSync(staging, { recursive: true });
    try {
      run(TAR, ["-xzf", resolve(archive), "-C", staging]);
      verifyRuntime(staging, platform, fingerprint);
      if (existsSync(join(destination, ".gitkeep"))) writeFileSync(join(staging, ".gitkeep"), readFileSync(join(destination, ".gitkeep")));
      rmSync(destination, { recursive: true, force: true });
      renameSync(staging, destination);
    } finally { rmSync(staging, { recursive: true, force: true }); }
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

export function packRuntime(archive, platform = nativePlatform()) {
  verifyRuntime(RESOURCE_ROOT, platform);
  mkdirSync(dirname(resolve(archive)), { recursive: true });
  run(TAR, ["-czf", resolve(archive), "-C", RESOURCE_ROOT, MANIFEST, "saleae-analyzer-sidecar", "sigrok-analyzer-sidecar"]);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, arg, platform] = process.argv.slice(2);
    switch (command) {
      case "fingerprint": console.log(sourceFingerprint()); break;
      case "platform": console.log(nativePlatform()); break;
      case "seal": sealRuntime(RESOURCE_ROOT, arg ?? nativePlatform()); break;
      case "verify": verifyRuntime(RESOURCE_ROOT, arg ?? nativePlatform()); break;
      case "pack": packRuntime(arg, platform ?? nativePlatform()); break;
      case "install": installRuntime(arg, platform ?? nativePlatform()); break;
      default: throw new Error("Usage: native-runtime.mjs fingerprint|platform|seal [platform]|verify [platform]|pack ARCHIVE [platform]|install ARCHIVE [platform]");
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
