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
import { frontendLog } from "./api";

export const LOG_LEVELS = ["error", "warn", "info", "debug", "trace"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

export const DEFAULT_LOG_LEVEL: LogLevel = "info";

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

export function setLogLevel(level: LogLevel) {
  activeLevel = level;
}

export function logLevel(): LogLevel {
  return activeLevel;
}

export interface LogEntry {
  at: number;
  level: LogLevel;
  message: string;
  scope: string;
}

// ~2000 entries is a few hundred kilobytes, which is still comfortable to
// attach to a bug report and long enough to cover a whole capture session.
const RING_CAPACITY = 2000;
const ring: LogEntry[] = [];

export function logRecord(level: LogLevel, scope: string, message: string) {
  if (LEVEL_RANK[level] > LEVEL_RANK[activeLevel]) return;
  ring.push({ at: Date.now(), level, message, scope });
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

export function createLogger(scope: string): Logger {
  return {
    debug: (message) => logRecord("debug", scope, message),
    error: (message) => logRecord("error", scope, message),
    info: (message) => logRecord("info", scope, message),
    trace: (message) => logRecord("trace", scope, message),
    warn: (message) => logRecord("warn", scope, message),
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
        `${new Date(entry.at).toISOString()} ${entry.level.toUpperCase().padEnd(5)} ${entry.scope}: ${entry.message}`,
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
