// Frontend diagnostic log.
//
// The backend writes a `tracing` log file (see `src-tauri/src/logging.rs`), but
// a webview-only failure leaves nothing behind: a message that never arrived and
// a handler that decided not to act are indistinguishable. So the frontend keeps
// its own record, and mirrors the levels worth keeping into the backend file so
// there is one place to look.
//
// Two properties matter here:
//
// * The buffer is a ring. A diagnostic that grows without bound eventually
//   becomes the outage it was meant to explain.
// * Every path out of here is failure-tolerant. Logging must never take down
//   the thing it measures.
//
// Verbosity is per module, not global. The module table is the same one the
// backend filters on, so "capture is quiet, transport is loud" is one setting
// the user can express instead of a level that drowns the module they care
// about.
import { frontendLog } from "./api";

export const LOG_LEVELS = ["error", "warn", "info", "debug", "trace"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

export const DEFAULT_LOG_LEVEL: LogLevel = "info";

/**
 * The filterable modules, in the order the panel lists them.
 *
 * `labelKey` is an i18n key in the `advanced` namespace; the module id doubles
 * as the target suffix, so `target: "sigpilot::capture"` is `capture` here.
 */
export const LOG_MODULES = [
  { id: "main", labelKey: "logModule_main" },
  { id: "device", labelKey: "logModule_device" },
  { id: "capture", labelKey: "logModule_capture" },
  { id: "transport", labelKey: "logModule_transport" },
  { id: "decoders", labelKey: "logModule_decoders" },
  { id: "graph", labelKey: "logModule_graph" },
  { id: "rendering", labelKey: "logModule_rendering" },
  { id: "measurements", labelKey: "logModule_measurements" },
  { id: "extensions", labelKey: "logModule_extensions" },
  { id: "webview", labelKey: "logModule_webview" },
] as const;

export type LogModuleId = (typeof LOG_MODULES)[number]["id"];

const MODULE_IDS: readonly string[] = LOG_MODULES.map((module) => module.id);

/** The frontend's own records: the webview is a module like any other. */
export const WEBVIEW_MODULE: LogModuleId = "webview";
/** Records the waveform worker forwards up; it has no other way to reach the log. */
export const RENDERING_MODULE: LogModuleId = "rendering";

export function isLogModuleId(value: unknown): value is LogModuleId {
  return typeof value === "string" && MODULE_IDS.includes(value);
}

export function moduleTarget(module: LogModuleId): string {
  return `sigpilot::${module}`;
}

/** The module a target names, or null for anything outside the table. */
export function moduleOfTarget(target: string): LogModuleId | null {
  const suffix = target.startsWith("sigpilot::") ? target.slice("sigpilot::".length) : target;
  return isLogModuleId(suffix) ? suffix : null;
}

/**
 * Drop anything the table does not recognise.
 *
 * A stale id from an older build, or a hand-edited preferences blob, must not
 * become a filter that silently matches no records.
 */
export function normalizeLogModuleLevels(value: unknown): Record<string, LogLevel> {
  if (!value || typeof value !== "object") return {};
  const source = value as Record<string, unknown>;
  const levels: Record<string, LogLevel> = {};
  for (const module of LOG_MODULES) {
    const level = source[module.id];
    if (isLogLevel(level)) levels[module.id] = level;
  }
  return levels;
}

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 3,
  error: 0,
  info: 2,
  trace: 4,
  warn: 1,
};

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === "string" && (LOG_LEVELS as readonly string[]).includes(value);
}

let activeLevel: LogLevel = DEFAULT_LOG_LEVEL;
let moduleLevels: Record<string, LogLevel> = {};
let paused = false;

/** The default level, for every module without an override. */
export function setLogLevel(level: LogLevel) {
  activeLevel = level;
}

export function logLevel(): LogLevel {
  return activeLevel;
}

/** Replace the per-module overrides wholesale; an empty map means "all default". */
export function setLogModuleLevels(levels: Record<string, LogLevel>) {
  moduleLevels = normalizeLogModuleLevels(levels);
}

export function logModuleLevels(): Record<string, LogLevel> {
  return { ...moduleLevels };
}

/** What a module is filtered at, which is the default unless it overrides it. */
export function levelForModule(module: LogModuleId | null): LogLevel {
  if (!module) return activeLevel;
  return moduleLevels[module] ?? activeLevel;
}

/**
 * Stop accumulating.
 *
 * Pausing is about the disk, but the webview buffer is memory the user is
 * paying for too, and a paused run that keeps a full ring is a bug report
 * about a different program.
 */
export function setPaused(value: boolean) {
  paused = value;
}

export function isPaused() {
  return paused;
}

export interface LogEntry {
  at: number;
  level: LogLevel;
  message: string;
  /** Sub-source within the module, e.g. `console` or `waveformWorker`. */
  scope: string;
  /** Always `sigpilot::<module>`; the panel's filter matches on this. */
  target: string;
}

// ~2000 entries is a few hundred kilobytes, which is still comfortable to
// attach to a bug report and long enough to cover a whole capture session.
const RING_CAPACITY = 2000;
const ring: LogEntry[] = [];

/**
 * @param module The module this record belongs to. Defaults to the webview,
 *   which is where frontend-originated statements land unless they say
 *   otherwise.
 */
export function logRecord(
  level: LogLevel,
  scope: string,
  message: string,
  module: LogModuleId = WEBVIEW_MODULE,
) {
  if (paused) return;
  if (LEVEL_RANK[level] > LEVEL_RANK[levelForModule(module)]) return;
  ring.push({ at: Date.now(), level, message, scope, target: moduleTarget(module) });
  if (ring.length > RING_CAPACITY) ring.splice(0, ring.length - RING_CAPACITY);
  // debug/trace stay webview-only: forwarding them would turn every draw into
  // an IPC round trip and make the log file useless.
  if (level !== "debug" && level !== "trace") {
    frontendLog(`[${scope}] ${message}`, level);
  }
}

export interface Logger {
  debug: (message: string) => void;
  error: (message: string) => void;
  info: (message: string) => void;
  trace: (message: string) => void;
  warn: (message: string) => void;
}

export function createLogger(scope: string, module: LogModuleId = WEBVIEW_MODULE): Logger {
  return {
    debug: (message) => logRecord("debug", scope, message, module),
    error: (message) => logRecord("error", scope, message, module),
    info: (message) => logRecord("info", scope, message, module),
    trace: (message) => logRecord("trace", scope, message, module),
    warn: (message) => logRecord("warn", scope, message, module),
  };
}

export const appLog = createLogger("app");

export function logSnapshot(): LogEntry[] {
  return ring.slice();
}

export function clearLogBuffer() {
  ring.length = 0;
}

export function formatLogEntries(entries: LogEntry[]): string {
  return entries
    .map(
      (entry) =>
        `${new Date(entry.at).toISOString()} ${entry.level.toUpperCase().padEnd(5)} ${entry.target} ${entry.scope}: ${entry.message}`,
    )
    .join("\n");
}

function stringifyArgument(value: unknown): string {
  if (value instanceof Error) return value.stack ?? value.message;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

let consoleCaptureInstalled = false;

/**
 * Route `console.*` into the log as well.
 *
 * Library and browser warnings are exactly the kind of thing a bug report needs
 * and the kind of thing nobody thinks to log explicitly, so they are captured
 * rather than left to scroll past in a console the user never opened.
 */
export function installConsoleCapture() {
  if (consoleCaptureInstalled) return;
  consoleCaptureInstalled = true;

  // `frontendLog` and the Tauri shims can console out on failure; capturing
  // that output would feed the log back into itself.
  let forwarding = false;
  const patch = (name: "debug" | "error" | "info" | "warn", level: LogLevel) => {
    const original = console[name].bind(console);
    console[name] = (...args: unknown[]) => {
      original(...args);
      if (forwarding) return;
      forwarding = true;
      try {
        logRecord(level, "console", args.map(stringifyArgument).join(" "));
      } finally {
        forwarding = false;
      }
    };
  };

  patch("debug", "debug");
  patch("info", "info");
  patch("warn", "warn");
  patch("error", "error");
}
