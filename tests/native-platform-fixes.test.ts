import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, lstatSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { normalizePythonRuntime } from "../scripts/normalize-python-runtime.mjs";

function temporary(run: (root: string) => void) {
  const root = mkdtempSync(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "platform-fixes-"));
  try { run(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

test("Python runtime materializes external files, preserves internal links and removes dangling links", () => temporary((root) => {
  const runtime = join(root, "stdlib"); mkdirSync(runtime);
  const outside = join(root, "site custom.py"); writeFileSync(outside, "customization");
  writeFileSync(join(runtime, "inside.py"), "inside");
  symlinkSync(outside, join(runtime, "sitecustomize.py"));
  symlinkSync("inside.py", join(runtime, "alias.py"));
  symlinkSync("missing.py", join(runtime, "dangling.py"));
  normalizePythonRuntime(runtime);
  assert.equal(readFileSync(join(runtime, "sitecustomize.py"), "utf8"), "customization");
  assert.ok(!lstatSync(join(runtime, "sitecustomize.py")).isSymbolicLink());
  assert.ok(lstatSync(join(runtime, "alias.py")).isSymbolicLink());
  assert.ok(!existsSync(join(runtime, "dangling.py")));
  assert.equal(readFileSync(outside, "utf8"), "customization");
}));

test("Python runtime rejects external directory links", () => temporary((root) => {
  const runtime = join(root, "stdlib"); mkdirSync(runtime);
  const outside = join(root, "outside"); mkdirSync(outside);
  symlinkSync(outside, join(runtime, "external"));
  assert.throws(() => normalizePythonRuntime(runtime), /External Python directory/);
}));

test("macOS install repairs an installed Python link conflict only on hosted CI", () => temporary((root) => {
  const bin = join(root, "bin"), python = join(root, "python");
  mkdirSync(bin); mkdirSync(join(python, "bin"), { recursive: true });
  writeFileSync(join(python, "bin/python3.13"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const log = join(root, "calls");
  writeFileSync(join(bin, "brew"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "$TEST_BREW_LOG"\ncase "$*" in\n'install python@3.13') exit 1;;\n'--prefix python@3.13') printf '%s\\n' "$TEST_PYTHON_ROOT";;\nesac\n`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_BREW_LOG: log, TEST_PYTHON_ROOT: python };
  const ci = spawnSync("bash", ["scripts/install-macos-native-deps.sh"], { env: { ...env, GITHUB_ACTIONS: "true" } });
  assert.equal(ci.status, 0, ci.stderr.toString());
  assert.match(readFileSync(log, "utf8"), /link --overwrite python@3.13/);
  writeFileSync(log, "");
  const local = spawnSync("bash", ["scripts/install-macos-native-deps.sh"], { env: { ...env, GITHUB_ACTIONS: "false" } });
  assert.equal(local.status, 1);
  assert.doesNotMatch(readFileSync(log, "utf8"), /link --overwrite/);
  rmSync(join(python, "bin/python3.13"));
  writeFileSync(log, "");
  const missing = spawnSync("bash", ["scripts/install-macos-native-deps.sh"], { env: { ...env, GITHUB_ACTIONS: "true" } });
  assert.notEqual(missing.status, 0);
  assert.doesNotMatch(readFileSync(log, "utf8"), /link --overwrite/);
}));
