#!/usr/bin/env node

import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { nativePlatform, verifyRuntime } from "./native-runtime.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(scriptDir, "..");
const shellScript = join(scriptDir, "prepare-tauri-resources.sh");

if (process.env.SIGPILOT_PREBUILT_NATIVE === "1") {
  // Client CI must never silently fall back to native compilation.
  verifyRuntime();
  console.log(`Using verified prebuilt native runtime (${nativePlatform()}).`);
  process.exit(0);
}
if (process.env.SIGPILOT_FORCE_NATIVE_BUILD !== "1") {
  try {
    verifyRuntime();
    console.log(`Native resources unchanged (${nativePlatform()}); skipping build and copy.`);
    process.exit(0);
  } catch {
    // Local development rebuilds automatically when source/payload changed.
  }
}

function bashCandidates() {
  const candidates = [];
  if (process.env.BASH) candidates.push(process.env.BASH);
  candidates.push("bash");
  if (process.platform === "win32") {
    candidates.push(
      "C:\\msys64\\usr\\bin\\bash.exe",
      "C:\\Program Files\\Git\\bin\\bash.exe",
      "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
    );
  }
  return candidates;
}

function runWith(candidate) {
  const result = spawnSync(candidate, [shellScript], {
    cwd: rootDir,
    stdio: "inherit",
    env: {
      ...process.env,
      PATH: process.env.PATH ?? "",
    },
  });
  if (result.error) return result.error;
  process.exit(result.status ?? 1);
}

for (const candidate of bashCandidates()) {
  if (candidate.includes("\\") && !existsSync(candidate)) continue;
  const error = runWith(candidate);
  if (error?.code !== "ENOENT") {
    console.error(`Failed to run ${candidate}: ${error?.message ?? error}`);
    process.exit(1);
  }
}

console.error(
  "bash is required to prepare SigPilot native resources. Install Git Bash or MSYS2 and ensure it is on PATH.",
);
process.exit(1);
