#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const {
  PxlogicCaptureController,
  createLineReader,
} = require('./lib/capture-controller.cjs');
const { normalizeEnabledChannels } = require('./lib/logic-format.cjs');
const { startWebSocketProxy } = require('./lib/websocket-proxy.cjs');

const bridgeRoot = __dirname;
const pxlogicRoot = path.resolve(bridgeRoot, '..', '..');
const SUPPORTED_LOGIC_VERSION = '2.4.46';

function parseArguments(argv) {
  const result = {
    appPath: process.env.SALEAE_LOGIC_APP,
    port: 12472,
    backendPort: undefined,
    pxlogicHelper: process.env.PXLOGIC_USB_SMOKE ||
      path.join(pxlogicRoot, 'target', 'release', 'usb_smoke'),
    pxlogicDevice: undefined,
    bitstreams: process.env.PXLOGIC_BITSTREAM_DIR ||
      path.join(pxlogicRoot, 'resources', 'bitstreams'),
    firmware: process.env.PXLOGIC_MCU_FIRMWARE ||
      path.join(pxlogicRoot, 'resources', 'firmware', 'SCI_LOGIC.bin'),
    enabledChannels: [0, 1, 2, 3],
    sampleRateHz: 25_000_000,
    thresholdVolts: 2.0,
    captureWindowMs: 1000,
    scanSaleaeDevices: false,
    screenQuadrant: undefined,
    remoteDebuggingPort: undefined,
    dryRun: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--app') result.appPath = path.resolve(argv[++index]);
    else if (argument === '--port') result.port = Number(argv[++index]);
    else if (argument === '--backend-port') result.backendPort = Number(argv[++index]);
    else if (argument === '--pxlogic-helper') result.pxlogicHelper = path.resolve(argv[++index]);
    else if (argument === '--pxlogic-device') result.pxlogicDevice = argv[++index];
    else if (argument === '--bitstreams') result.bitstreams = path.resolve(argv[++index]);
    else if (argument === '--firmware') result.firmware = path.resolve(argv[++index]);
    else if (argument === '--enabled-channels') {
      result.enabledChannels = normalizeEnabledChannels(argv[++index]);
    } else if (argument === '--sample-rate') result.sampleRateHz = Number(argv[++index]);
    else if (argument === '--threshold-volts') result.thresholdVolts = Number(argv[++index]);
    else if (argument === '--capture-window-ms') result.captureWindowMs = Number(argv[++index]);
    else if (argument === '--scan-saleae-devices') result.scanSaleaeDevices = true;
    else if (argument === '--screen-quadrant') result.screenQuadrant = Number(argv[++index]);
    else if (argument === '--remote-debugging-port') {
      result.remoteDebuggingPort = Number(argv[++index]);
    } else if (argument === '--dry-run') result.dryRun = true;
    else if (argument === '--help' || argument === '-h') result.help = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }

  for (const [name, port] of [['port', result.port], ['backend port', result.backendPort]]) {
    if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
      throw new Error(`Invalid ${name}: ${port}`);
    }
  }
  if (!Number.isInteger(result.sampleRateHz) || result.sampleRateHz <= 0) {
    throw new Error(`Invalid sample rate: ${result.sampleRateHz}`);
  }
  if (!Number.isFinite(result.thresholdVolts) ||
      result.thresholdVolts < 0 || result.thresholdVolts > 6.668) {
    throw new Error(`Invalid threshold voltage: ${result.thresholdVolts}`);
  }
  if (!Number.isInteger(result.captureWindowMs) || result.captureWindowMs < 10) {
    throw new Error(`Invalid capture window: ${result.captureWindowMs}`);
  }
  if (result.screenQuadrant !== undefined && ![1, 2, 3, 4].includes(result.screenQuadrant)) {
    throw new Error(`Invalid screen quadrant: ${result.screenQuadrant}`);
  }
  if (result.remoteDebuggingPort !== undefined &&
      (!Number.isInteger(result.remoteDebuggingPort) ||
       result.remoteDebuggingPort < 1 || result.remoteDebuggingPort > 65535)) {
    throw new Error(`Invalid remote debugging port: ${result.remoteDebuggingPort}`);
  }
  return result;
}

function printHelp() {
  console.log(`PXLogic bridge for the official Saleae Logic 2.4.46 macOS arm64 app

Usage:
  node tools/logic2-bridge/index.cjs --app "/path/to/Logic.app" [options]

Options:
  --app PATH                 Official Saleae Logic app; auto-detected when installed
  --port PORT                Logic-facing Graph WebSocket port (default: 12472)
  --backend-port PORT        Private GraphServer port (default: automatic)
  --pxlogic-helper FILE      PXLogic usb_smoke executable
  --pxlogic-device ID        Select one PXLogic USB device
  --bitstreams DIR           PXLogic FPGA bitstream directory
  --firmware FILE            PXLogic MCU firmware image
  --enabled-channels LIST    Initial channels before Logic sends settings (default: 0,1,2,3)
  --sample-rate HZ           Initial sample rate (default: 25000000)
  --threshold-volts V        Initial nominal I/O level (default: 2.0)
  --capture-window-ms MS     PXLogic stream re-arm window (default: 1000)
  --scan-saleae-devices      Also let GraphServer scan physical Saleae devices
  --screen-quadrant N        Place Logic in screen quadrant 1-4
  --remote-debugging-port N  Enable Chromium remote debugging for this Logic process
  --dry-run                  Validate paths, version, and native host build without launching
  --help                     Show this help

No npm install is required.`);
}

function requirePath(target, label, kind = 'any') {
  let stat;
  try {
    stat = fs.statSync(target);
  } catch {
    throw new Error(`${label} was not found: ${target}`);
  }
  if (kind === 'file' && !stat.isFile()) throw new Error(`${label} is not a file: ${target}`);
  if (kind === 'directory' && !stat.isDirectory()) {
    throw new Error(`${label} is not a directory: ${target}`);
  }
}

function installedAppCandidates() {
  const names = ['Saleae Logic.app', 'Logic 2.app', 'Logic.app'];
  const roots = ['/Applications', path.join(os.homedir(), 'Applications')];
  const candidates = roots.flatMap(root => names.map(name => path.join(root, name)));
  const spotlight = spawnSync(
    'mdfind',
    ['kMDItemCFBundleIdentifier == "com.saleae.saleae"'],
    { encoding: 'utf8' },
  );
  if (spotlight.status === 0) {
    candidates.push(...spotlight.stdout.split(/\r?\n/).filter(Boolean));
  }
  return [...new Set(candidates)];
}

function resolveAppPath(explicitPath) {
  if (explicitPath) return path.resolve(explicitPath);
  const found = installedAppCandidates().find(candidate =>
    fs.existsSync(path.join(candidate, 'Contents', 'Info.plist')),
  );
  if (!found) {
    throw new Error('Saleae Logic was not found; pass --app "/path/to/Logic.app"');
  }
  return found;
}

function readAppVersion(appPath) {
  const plist = path.join(appPath, 'Contents', 'Info.plist');
  const result = spawnSync(
    '/usr/libexec/PlistBuddy',
    ['-c', 'Print :CFBundleShortVersionString', plist],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(`Could not read Logic version from ${plist}: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

function resolveRuntime(options) {
  const appPath = resolveAppPath(options.appPath);
  const version = readAppVersion(appPath);
  if (version !== SUPPORTED_LOGIC_VERSION) {
    throw new Error(
      `Unsupported Logic version ${version}. This hook currently supports only ` +
      `${SUPPORTED_LOGIC_VERSION}; refusing to patch an unknown GraphServer build.`,
    );
  }
  const runtimeRoot = path.join(appPath, 'Contents', 'Resources', 'macos-arm64');
  const executable = path.join(appPath, 'Contents', 'MacOS', 'Logic');
  const sharedLibrary = path.join(runtimeRoot, 'libgraph_server_shared.dylib');
  const pythonHome = path.join(runtimeRoot, 'pythonlibs');
  requirePath(executable, 'Logic executable', 'file');
  requirePath(sharedLibrary, 'GraphServer library', 'file');
  requirePath(pythonHome, 'Logic Python runtime', 'directory');
  return { appPath, version, runtimeRoot, executable, sharedLibrary, pythonHome };
}

function ensureNativeHost() {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    throw new Error('PXLogic Logic 2 bridge currently requires macOS arm64');
  }
  const source = path.join(bridgeRoot, 'native', 'graph-host.c');
  const outputDirectory = path.join(bridgeRoot, 'build');
  const executable = path.join(outputDirectory, 'graph-host');
  fs.mkdirSync(outputDirectory, { recursive: true });
  const needsBuild = !fs.existsSync(executable) ||
    fs.statSync(source).mtimeMs > fs.statSync(executable).mtimeMs;
  if (needsBuild) {
    console.log('[logic2-bridge] compiling version-locked native GraphServer host');
    const result = spawnSync(
      'xcrun',
      ['clang', '-std=c11', '-O2', '-Wall', '-Wextra', source, '-o', executable],
      { cwd: bridgeRoot, encoding: 'utf8' },
    );
    if (result.status !== 0) {
      throw new Error(`Failed to compile native host:\n${result.stderr || result.stdout}`);
    }
  }
  return executable;
}

function findAvailableTcpPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : undefined;
      server.close(error => {
        if (error) reject(error);
        else if (!port) reject(new Error('Could not allocate a GraphServer port'));
        else resolve(port);
      });
    });
  });
}

function waitForNativeGraph(host, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) reject(new Error('Timed out waiting for the native GraphServer'));
    }, timeoutMs);
    createLineReader(host.stdout, line => {
      const match = line.match(/^GRAPH_WS_READY ws:\/\/127\.0\.0\.1:(\d+)\/saleae$/);
      if (match && !settled) {
        settled = true;
        clearTimeout(timeout);
        resolve(Number(match[1]));
      } else {
        console.log(line);
      }
    });
    host.once('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new Error(
        `Native GraphServer exited before ready (${signal || `code ${code}`})`,
      ));
    });
    host.once('error', error => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
  });
}

async function waitForExit(child) {
  if (child.exitCode !== null) return { code: child.exitCode, signal: child.signalCode };
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const runtime = resolveRuntime(options);
  requirePath(options.pxlogicHelper, 'PXLogic USB helper', 'file');
  requirePath(options.bitstreams, 'PXLogic bitstream directory', 'directory');
  requirePath(options.firmware, 'PXLogic MCU firmware', 'file');
  const nativeHost = ensureNativeHost();
  console.log(`[logic2-bridge] official Logic ${runtime.version}: ${runtime.appPath}`);
  console.log(`[logic2-bridge] PXLogic helper: ${options.pxlogicHelper}`);
  if (options.dryRun) {
    console.log('[logic2-bridge] validation successful');
    return;
  }

  const stateRoot = path.join(
    os.homedir(),
    'Library',
    'Application Support',
    'PXLogic',
    'logic2-bridge',
  );
  const calibrationRoot = path.join(stateRoot, 'mso-calibration');
  const logPath = path.join(stateRoot, 'graphio.log');
  fs.mkdirSync(calibrationRoot, { recursive: true });
  const backendPort = options.backendPort ?? await findAvailableTcpPort();
  if (backendPort === options.port) {
    throw new Error('The public proxy and private GraphServer ports must differ');
  }

  const host = spawn(nativeHost, [
    runtime.sharedLibrary,
    runtime.pythonHome,
    logPath,
    calibrationRoot,
    String(backendPort),
    options.scanSaleaeDevices ? '1' : '0',
  ], {
    cwd: stateRoot,
    env: process.env,
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  host.stdin.on('error', error => {
    if (error.code !== 'EPIPE') console.error(`[logic2-bridge] host input failed: ${error.message}`);
  });

  let controller;
  let proxy;
  let logic;
  let stopping = false;
  let stopPromise;
  const stop = signal => {
    if (stopPromise) return stopPromise;
    stopping = true;
    stopPromise = (async () => {
      await controller?.shutdown();
      await proxy?.close();
      if (logic?.exitCode === null) logic.kill(signal);
      if (host.exitCode === null) host.kill(signal);
    })();
    return stopPromise;
  };
  process.once('SIGINT', () => void stop('SIGINT'));
  process.once('SIGTERM', () => void stop('SIGTERM'));

  try {
    const actualBackendPort = await waitForNativeGraph(host);
    controller = new PxlogicCaptureController(options, host);
    proxy = await startWebSocketProxy({
      port: options.port,
      backendPort: actualBackendPort,
      observeText: message => controller.observeRequest(message),
    });
    console.log(`[logic2-bridge] Graph WebSocket ready: ws://127.0.0.1:${options.port}/saleae`);

    const logicArguments = ['--useExistingGraph', '--graphPort', String(options.port)];
    if (options.screenQuadrant !== undefined) {
      logicArguments.push('--screenQuadrant', String(options.screenQuadrant));
    }
    if (options.remoteDebuggingPort !== undefined) {
      logicArguments.push(`--remote-debugging-port=${options.remoteDebuggingPort}`);
    }
    logic = spawn(runtime.executable, logicArguments, {
      cwd: stateRoot,
      env: process.env,
      stdio: 'inherit',
    });
    const exit = await waitForExit(logic);
    console.log(`[logic2-bridge] Logic exited (${exit.signal || exit.code})`);
    if (!stopping && exit.code) process.exitCode = exit.code;
  } finally {
    await controller?.shutdown();
    await proxy?.close();
    if (host.exitCode === null) {
      host.kill('SIGTERM');
      await Promise.race([
        waitForExit(host),
        new Promise(resolve => setTimeout(resolve, 3000)),
      ]);
    }
  }
}

module.exports = {
  SUPPORTED_LOGIC_VERSION,
  installedAppCandidates,
  parseArguments,
  readAppVersion,
  resolveAppPath,
  resolveRuntime,
};

if (require.main === module) {
  main().catch(error => {
    console.error(`[logic2-bridge] fatal: ${error.message}`);
    process.exitCode = 1;
  });
}
