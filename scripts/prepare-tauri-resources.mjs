#!/usr/bin/env node

import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(scriptDir, "..");
const shellScript = join(scriptDir, "prepare-tauri-resources.sh");

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
