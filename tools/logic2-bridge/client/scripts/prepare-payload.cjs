'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repositoryRoot = path.resolve(__dirname, '..', '..', '..', '..');
const bridgeRoot = path.join(repositoryRoot, 'tools', 'logic2-bridge');
const helper = path.join(
  repositoryRoot,
  'target',
  'aarch64-apple-darwin',
  'release',
  'usb_smoke',
);
const nativeHost = path.join(bridgeRoot, 'build', 'graph-host');

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed:\n${result.stderr || result.stdout}`,
    );
  }
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  throw new Error('The complete Logic 2 bridge client can currently be built only on macOS arm64');
}

run('cargo', [
  'build',
  '--release',
  '--bin',
  'usb_smoke',
  '--target',
  'aarch64-apple-darwin',
]);

fs.mkdirSync(path.dirname(nativeHost), { recursive: true });
run('xcrun', [
  'clang',
  '-std=c11',
  '-O2',
  '-Wall',
  '-Wextra',
  path.join(bridgeRoot, 'native', 'graph-host.c'),
  '-o',
  nativeHost,
]);

const helperHelp = spawnSync(helper, ['--help'], { encoding: 'utf8' });
if (helperHelp.status !== 0 || !helperHelp.stdout.includes('--live-cross-only')) {
  throw new Error(`${helper} does not implement the bridge --live-cross-only contract`);
}

for (const executable of [helper, nativeHost]) {
  const architecture = spawnSync('file', [executable], { encoding: 'utf8' });
  if (architecture.status !== 0 || !architecture.stdout.includes('arm64')) {
    throw new Error(`${executable} is not a macOS arm64 executable`);
  }
}

console.log('[logic2-bridge-client] native payload is current and compatible');
