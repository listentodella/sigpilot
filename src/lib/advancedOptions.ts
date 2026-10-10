import { readFrameState } from "./frameStore";
import { formatBytes, formatRate, formatSamples } from "./format";
import { LOG_LEVELS, LOG_MODULES, type LogLevel } from "./logger";
import type { LogStatus } from "./api";
import {
  ANIMATION_SCALE_MAX,
  ANIMATION_SCALE_MIN,
  type UiPreferences,
} from "./preferences";
import { waveformDrawSummary } from "./waveformDrawProbe";

// The advanced surface is DATA, not bespoke JSX: one descriptor per control, so
// adding an option is one entry and the renderer never changes. This follows the
// shape of the homage project's hidden developer panel, which drives a whole
// surface from a small `Tool = Button | Switch | Number | Dropdown` union.
//
// Values are read and written through `get`/`set` closures over the preferences
// state, so the panel stays presentational and every control applies live.
//
// Only options that actually exist are listed. An option that would need a
// feature built first (waveform line width) is deliberately absent.
type CommonControl = {
  id: string;
  labelKey: string;
  hintKey: string;
  /** Destructive or hard to reason about: flagged in the UI. */
  danger?: boolean;
  /** Needs an app restart before it takes effect (backend-owned values). */
  restartRequired?: boolean;
};

export type AdvancedControl =
  | (CommonControl & {
      kind: "toggle";
      get: () => boolean;
      set: (value: boolean) => void;
    })
  | (CommonControl & {
      kind: "number";
      get: () => number;
      set: (value: number) => void;
      min: number;
      max: number;
      step: number;
    })
  | (CommonControl & {
      kind: "dropdown";
      get: () => string;
      set: (value: string) => void;
      /** `labelKey`s, so the choices translate with everything else. */
      options: Array<{ labelKey: string; value: string }>;
    })
  | (CommonControl & {
      kind: "button";
      /** Fires on click. May be async; the panel awaits nothing, so a slow
       *  action owns its own progress reporting. */
      run: () => void | Promise<void>;
    })
  | (CommonControl & {
      kind: "readonly";
      value: () => string;
    });

export interface AdvancedSection {
  id: string;
  labelKey: string;
  controls: AdvancedControl[];
}

/**
 * Read-only facts the panel reports. App assembles this so this module never has
 * to know about UiSession.
 */
export interface AdvancedDiagnostics {
  sessionId: string | null;
  sampleCount: number;
  sampleRateHz: number;
  captureBytes: number;
  memoryBufferBytes: number;
  memoryTotalBytes: number;
}

export interface AdvancedOptionsSource {
  preferences: UiPreferences;
  onChangePreferences: (updater: (current: UiPreferences) => UiPreferences) => void;
  diagnostics?: AdvancedDiagnostics;
  /** Copies the full diagnostics bundle to the clipboard. */
  onCopyLogFiles?: () => void | Promise<void>;
  onCopyLogs?: () => void | Promise<void>;
  /** Writes the same bundle to a path the user picks. */
  onSaveLogs?: () => void | Promise<void>;
  /** Deletes the retained log files and starts a fresh one. */
  onClearLogs?: () => void | Promise<void>;
  /** Where the logs live and what they currently cost. */
  logStatus?: LogStatus | null;
}

function formatSpanSeconds(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "—";
  if (seconds < 0.001) return `${(seconds * 1e6).toFixed(0)} µs`;
  if (seconds < 1) return `${(seconds * 1e3).toFixed(2)} ms`;
  return `${seconds.toFixed(3)} s`;
}

function buildDiagnosticsSection(diagnostics: AdvancedDiagnostics): AdvancedSection {
  const { sessionId } = diagnostics;
  return {
    id: "diagnostics",
    labelKey: "sectionDiagnostics",
    controls: [
      {
        kind: "readonly",
        id: "diagCapture",
        labelKey: "diagCapture",
        hintKey: "diagCaptureHint",
        value: () => {
          if (!sessionId || diagnostics.sampleCount <= 0) return "—";
          const span = formatSpanSeconds(diagnostics.sampleCount / Math.max(1, diagnostics.sampleRateHz));
          return `${formatSamples(diagnostics.sampleCount)} · ${formatRate(diagnostics.sampleRateHz)} · ${span}`;
        },
      },
      {
        kind: "readonly",
        id: "diagMemory",
        labelKey: "diagMemory",
        hintKey: "diagMemoryHint",
        value: () => {
          const { memoryBufferBytes, memoryTotalBytes, captureBytes } = diagnostics;
          if (memoryBufferBytes <= 0) return captureBytes > 0 ? formatBytes(captureBytes) : "—";
          const percent = Math.min(100, (memoryTotalBytes / memoryBufferBytes) * 100);
          return `${formatBytes(memoryTotalBytes)} / ${formatBytes(memoryBufferBytes)} (${percent.toFixed(0)}%)`;
        },
      },
      {
        kind: "readonly",
        id: "diagFrameLoop",
        labelKey: "diagFrameLoop",
        hintKey: "diagFrameLoopHint",
        value: () => {
          if (!sessionId) return "—";
          const state = readFrameState(sessionId);
          if (!state) return "off";
          return state.ready ? "ready" : "starting";
        },
      },
      {
        kind: "readonly",
        id: "diagDrawPaths",
        labelKey: "diagDrawPaths",
        hintKey: "diagDrawPathsHint",
        value: () => {
          const summary = waveformDrawSummary();
          if (summary.total === 0) return "—";
          const top = summary.paths[0];
          return `${summary.total}× · ${top.path} ${(top.share * 100).toFixed(0)}%`;
        },
      },
    ],
  };
}

/**
 * The logging block. Frontend and backend share one verbosity setting because a
 * bundle that is half-verbose is worse than useless: the layer that stayed quiet
 * is usually the one with the answer.
 *
 * The per-module rows below are an override on that default, not a replacement
 * for it: a module left alone follows the default, so the common case is still
 * one control.
 *
 * Recording is on by default and bounded, not opt-in — see the reasoning on
 * `set_paused` in the backend. What the panel has to do is make the cost
 * visible and give the user one obvious way to get the logs out.
 */
function buildLoggingSection({
  logStatus,
  onClearLogs,
  onCopyLogFiles,
  onCopyLogs,
  onSaveLogs,
  preferences,
  setPreference,
}: {
  logStatus?: LogStatus | null;
  onClearLogs?: () => void | Promise<void>;
  onCopyLogFiles?: () => void | Promise<void>;
  onCopyLogs?: () => void | Promise<void>;
  onSaveLogs?: () => void | Promise<void>;
  preferences: UiPreferences;
  setPreference: <K extends keyof UiPreferences>(key: K, value: UiPreferences[K]) => void;
}): AdvancedSection {
  return {
    controls: [
      {
        get: () => preferences.logLevel,
        hintKey: "logDefaultLevelHint",
        id: "logDefaultLevel",
        kind: "dropdown",
        labelKey: "logDefaultLevel",
        options: LOG_LEVELS.map((level) => ({ labelKey: `logLevel_${level}`, value: level })),
        set: (value) => setPreference("logLevel", value as LogLevel),
      },
      {
        get: () => preferences.logPaused,
        hintKey: "logPausedHint",
        id: "logPaused",
        kind: "toggle",
        labelKey: "logPaused",
        set: (value) => setPreference("logPaused", value),
      },
      {
        hintKey: "logUsageHint",
        id: "logUsage",
        kind: "readonly",
        // Not a translated string here: the panel's readonly rows take a plain
        // value, so the shape is assembled in the app's language via the
        // `logUsage` key below.
        labelKey: "logUsage",
        value: () => {
          if (!logStatus?.available) return "—";
          return `${formatBytes(logStatus.totalBytes)} / ${formatBytes(logStatus.maxFileBytes * logStatus.maxFiles)}`;
        },
      },
      {
        hintKey: "copyLogFilesHint",
        id: "copyLogFiles",
        kind: "button",
        labelKey: "copyLogFiles",
        run: () => onCopyLogFiles?.(),
      },
      {
        hintKey: "copyLogsHint",
        id: "copyLogs",
        kind: "button",
        labelKey: "copyLogs",
        run: () => onCopyLogs?.(),
      },
      {
        hintKey: "saveLogsHint",
        id: "saveLogs",
        kind: "button",
        labelKey: "saveLogs",
        run: () => onSaveLogs?.(),
      },
      {
        danger: true,
        hintKey: "clearLogsHint",
        id: "clearLogs",
        kind: "button",
        labelKey: "clearLogs",
        run: () => onClearLogs?.(),
      },
    ],
    id: "logging",
    labelKey: "sectionLogging",
  };
}

/**
 * Ten rows would bury the buttons that actually get used, so they get their own
 * collapsible section — the same mechanism every other section uses, rather than
 * a nesting kind the renderer would then have to know about.
 */
function buildLogModuleSection({
  preferences,
  setModuleLevel,
}: {
  preferences: UiPreferences;
  setModuleLevel: (moduleId: string, level: LogLevel) => void;
}): AdvancedSection {
  return {
    controls: LOG_MODULES.map((module) => ({
      get: () => preferences.logModuleLevels[module.id] ?? preferences.logLevel,
      hintKey: "logModuleHint",
      id: `logModule_${module.id}`,
      kind: "dropdown",
      labelKey: module.labelKey,
      options: LOG_LEVELS.map((level) => ({ labelKey: `logLevel_${level}`, value: level })),
      set: (value: string) => setModuleLevel(module.id, value as LogLevel),
    })),
    id: "logModules",
    labelKey: "sectionLogModules",
  };
}

export function buildAdvancedSections({
  diagnostics,
  logStatus,
  onChangePreferences,
  onClearLogs,
  onCopyLogFiles,
  onCopyLogs,
  onSaveLogs,
  preferences,
}: AdvancedOptionsSource): AdvancedSection[] {
  const setPreference = <K extends keyof UiPreferences>(key: K, value: UiPreferences[K]) =>
    onChangePreferences((current) => ({ ...current, [key]: value }));
  const setModuleLevel = (moduleId: string, level: LogLevel) =>
    onChangePreferences((current) => ({
      ...current,
      logModuleLevels: { ...current.logModuleLevels, [moduleId]: level },
    }));

  return [
    {
      id: "display",
      labelKey: "sectionDisplay",
      controls: [
        {
          kind: "toggle",
          id: "showGridLines",
          labelKey: "gridLines",
          hintKey: "gridLinesHint",
          get: () => preferences.showGridLines,
          set: (value) => setPreference("showGridLines", value),
        },
        {
          kind: "toggle",
          id: "matchChannelColors",
          labelKey: "matchChannelColors",
          hintKey: "matchChannelColorsHint",
          get: () => preferences.matchChannelColors,
          set: (value) => setPreference("matchChannelColors", value),
        },
      ],
    },
    {
      id: "behavior",
      labelKey: "sectionBehavior",
      controls: [
        {
          kind: "toggle",
          id: "panToTrigger",
          labelKey: "panToTrigger",
          hintKey: "panToTriggerHint",
          get: () => preferences.panToTrigger,
          set: (value) => setPreference("panToTrigger", value),
        },
        {
          kind: "toggle",
          id: "renameTabToSavedCapture",
          labelKey: "renameTabToSavedCapture",
          hintKey: "renameTabToSavedCaptureHint",
          get: () => preferences.renameTabToSavedCapture,
          set: (value) => setPreference("renameTabToSavedCapture", value),
        },
      ],
    },
    {
      id: "performance",
      labelKey: "sectionPerformance",
      controls: [
        {
          kind: "number",
          id: "animationScale",
          labelKey: "animationScale",
          hintKey: "animationScaleHint",
          get: () => preferences.animationScale,
          set: (value) => setPreference("animationScale", value),
          min: ANIMATION_SCALE_MIN,
          max: ANIMATION_SCALE_MAX,
          step: 0.1,
        },
      ],
    },
    buildLoggingSection({
      logStatus,
      onClearLogs,
      onCopyLogFiles,
      onCopyLogs,
      onSaveLogs,
      preferences,
      setPreference,
    }),
    buildLogModuleSection({ preferences, setModuleLevel }),
    ...(diagnostics ? [buildDiagnosticsSection(diagnostics)] : []),
  ];
}
