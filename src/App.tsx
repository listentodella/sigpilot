import { listen } from "@tauri-apps/api/event";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  Activity,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Copy,
  Clock3,
  FileDown,
  FolderOpen,
  GripVertical,
  Maximize2,
  MoreVertical,
  Minus,
  Plus,
  RefreshCw,
  Save,
  Search,
  Settings2,
  SlidersHorizontal,
  Table2,
  Terminal,
  Trash2,
  Usb,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import {
  CSSProperties,
  Fragment,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
  RefObject,
  UIEvent as ReactUIEvent,
  WheelEvent as ReactWheelEvent,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  DragDropContext,
  Draggable,
  DraggableProvidedDragHandleProps,
  DropResult,
  Droppable,
  DroppableProps,
} from "react-beautiful-dnd";
import analyzersIcon from "./assets/saleae/sidebar/analyzers.svg";
import cursorsIcon from "./assets/saleae/sidebar/cursors.svg";
import devicesIcon from "./assets/saleae/sidebar/devices.svg";
import extensionsIcon from "./assets/saleae/sidebar/extensions.svg";
import measurementsIcon from "./assets/saleae/sidebar/measurements.svg";
import notesIcon from "./assets/saleae/sidebar/notes.svg";
import recordingSettingsIcon from "./assets/saleae/sidebar/recordingSettings.svg";
import timingMarkersIcon from "./assets/saleae/sidebar/timingMarkers.svg";
import triggerFallingIcon from "./assets/saleae/trigger/falling.svg";
import triggerPulseHighIcon from "./assets/saleae/trigger/pulse-high.svg";
import triggerPulseLowIcon from "./assets/saleae/trigger/pulse-low.svg";
import triggerRisingIcon from "./assets/saleae/trigger/rising.svg";
import emptyMeasurementArt from "./assets/saleae/empty_measurement.svg";
import { CaptureNotesPanel } from "./components/CaptureNotesPanel";
import { AnalyzerBubblesOverlay } from "./components/AnalyzerBubblesOverlay";
import { AnalyzerSettingsDialog } from "./components/AnalyzerSettingsDialog";
import { DeviceStartScreen } from "./components/DeviceStartScreen";
import { ExtensionsPanel } from "./components/ExtensionsPanel";
import { LogicToolbar } from "./components/LogicToolbar";
import { PreferencesDialog } from "./components/PreferencesDialog";
import { SaleaeIcon } from "./components/SaleaeIcon";
import { AnalyzerLibraryMenu } from "./components/AnalyzerLibraryMenu";
import type { AnalyzerLibraryChoice } from "./components/AnalyzerLibraryMenu";
import { AnalogWaveformOverlay } from "./components/AnalogWaveformOverlay";
import { StripChartScrollbar } from "./components/StripChartScrollbar";
import { TimingDisplayCanvas } from "./components/TimingDisplayCanvas";
import {
  TimingMarkersOverlay,
  TimingMarkersPanel,
} from "./components/timingMarkers/TimingMarkers";
import { WaveformCanvas } from "./components/WaveformCanvas";
import { resolveWaveformPointerSample } from "./lib/waveformEdgeSnap";
import { graphTileCanServeViewport } from "./lib/waveformTileCoverage";
import { virtualListWindow } from "./lib/virtualList";
import { defaultCaptureViewportSamples, previewCaptureViewportSamples } from "./lib/liveViewport";
import {
  maximumDataViewportSamples,
  minimumViewportSamples,
  normalizeCaptureViewport,
  normalizeLiveCaptureViewport,
} from "./lib/captureViewport";
import {
  analyzerRenderRequestIntervalMs,
  analyzerRenderedTracksMatchRequests,
  analyzerRenderViewportCanServe,
  preserveLiveAnalyzerTracks,
} from "./lib/analyzerRenderScheduling";
import { traceAnalyzerPerformance } from "./lib/analyzerPerformance";
import {
  dispatchSessionViewIntent,
  ensureSessionFrameLoop,
  hasSessionFrameLoop,
  invalidateSessionFrame,
  readFrameHealth,
  readFrameState,
  releaseSessionFrameLoop,
  setSessionFrameLive,
  subscribeFrameHealth,
} from "./lib/frameStore";
import { ZOOM_ANIMATION_DURATION_MS } from "./lib/wheelZoom";
import {
  analyzerCanRenderTracksLocally,
  analyzerTrackRequestsForAnalyzer,
  buildLocalAnalyzerTrackWindow,
  reuseAnalyzerTrackWindows,
} from "./lib/analyzerTrackWindows";
import {
  analyzerFrameListChannelRoles,
  analyzerFrameListRowsForWindow,
  analyzerFrameListRowsFromRefs,
  analyzerFrameListSources,
  countAnalyzerFrameRows,
  filterAnalyzerFrameListRefs,
  findAnalyzerFrameById,
  findAnalyzerFrameRefPosition,
  findAnalyzerFrameRowPosition,
  forEachAnalyzerFrameListRow,
  type AnalyzerFrameListRef,
  type AnalyzerFrameListRow,
} from "./lib/analyzerFrameList";
import {
	  cancelCapture,
	  AnalyzerFrameRef,
	  AnalyzerTrackWindow,
  CaptureMemoryUsage,
  CaptureProgress,
  CaptureSettings,
  CaptureSummary,
  CaptureTriggerKind,
  CaptureTriggerMetadata,
		  configurePwm,
		  decodeAnalyzerFrameBatch,
		  decodeSaleaeAnalyzerBackgroundStep,
  decodeAnalyzerFrameTableSearchWindow,
  decodeAnalyzerFrameTableWindow,
  decodeAnalyzerFrames,
  DecodedChannelValue,
  DecodedFrame,
  DecoderBackendKind,
  deviceCapabilities,
  DeviceInfo,
  DigitalRangeMeasurementStats,
  DiagnosticEvent,
  ExternalTriggerMode,
  exportCapture,
  HardwareCaptureCapabilities,
  HardwareChannelModeInfo,
  isTauriRuntime,
  listDevices,
  measureDigitalRange,
  nearestDigitalTransition,
  openCapture,
  OpenCaptureResult,
  prepareDevice,
  releaseGraphSession,
  renderGraphFrame,
  saveCapture,
  saleaeDecoderCatalog,
  setGraphViewLimits,
  SigrokDecoderCatalog,
  sigrokDecoderCatalog,
  SigrokDecoderCatalogItem,
  startCapture,
  trimCapture,
  ViewIntent,
  writeTextFile,
  WaveformTile,
} from "./lib/api";
import { formatBytes, formatRate, formatSamples } from "./lib/format";
import {
  ChannelDeleteDataMode,
  ChannelTrimPreview,
  isChannelDeleteDataVisible,
  resolveChannelTrimRange,
} from "./lib/channelContextMenu";
import {
  ANALYZER_CATALOG_GROUPS,
  AnalyzerDisplayRadix,
  analyzerCanRunDecoder,
  analyzerCatalogChoiceKey,
  analyzerChannelIndexes,
  analyzerChannelRoleLabel,
  analyzerChannelRoles,
  analyzerDecodeSettings,
  analyzerDecodeSignature as getAnalyzerDecodeSignature,
  analyzerHasLazyNativeFramePlaceholder,
  analyzerUsesLazyNativeSummary,
  decoderBackendLabel,
  DISPLAY_RADIX_OPTIONS,
  formatAnalyzerText,
  analyzerStripInsetForChannel,
  createAnalyzerInstanceFromSigrokCatalog,
  createAnalyzerInstanceFromSaleaeCatalog,
  lazyNativeAnalyzerFrameCount,
  mergeAnalyzerTrackFrames,
  normalizeDecodedFrameOrder,
  normalizeAnalyzerDisplayRadix,
  SALEAE_ANALYZER_COLORS,
  createAnalyzerInstance,
  restoreSaleaeAnalyzer,
  saleaeAnalyzerMetadata,
  sigrokCatalogDetailName,
  sigrokCatalogDisplayName,
  UiAnalyzerInstance,
} from "./lib/analyzers";
import {
  SALEAE_DEFAULT_DIGITAL_ROW_HEIGHT_PX,
  fitSaleaeDigitalRowsToViewport,
  makeSaleaeDigitalRowHeights,
  saleaeChannelContentHeight,
  saleaeChannelResizeHandleTop,
  SALEAE_DIGITAL_ROW_V2_MIN_HEIGHT_PX,
  SALEAE_ROW_V2_SPACING_PX,
} from "./lib/saleaeChannelLayout";
import { saleaeLegacyChannelColor } from "./lib/saleaeChannelColors";
import {
  ANALOG_ROW_MIN_HEIGHT_PX,
  ANALOG_SAMPLE_RATE_OPTIONS,
  ANALOG_VIEW_RANGE_MIN_VOLTS,
  cloneAnalogChannels,
  enabledAnalogChannels,
  makeDefaultAnalogChannels,
  UiAnalogChannelSettings,
} from "./lib/analogChannels";
import {
  loadUiExtensions,
  saveUiExtensions,
  UiExtensionRecord,
} from "./lib/extensions";
import {
  AnalyzerCommands,
  CommandPayload,
  MarkerCommands,
  MeasurementCommands,
  SIDEBAR_COMMAND_TO_PANEL,
  SIDEBAR_PANELS,
  SIDEBAR_PANEL_SHORTCUTS,
  SIDEBAR_SHORTCUT_TO_COMMAND,
  SidebarCommands,
  SidebarPanel,
  UiCommand,
} from "./lib/sidebar";
import {
  findSaleaeGraphChannelIndexAtY,
  getSaleaeGraphChannelLayout,
} from "./lib/saleaeGraphLayout";
import {
  loadScreenshotSettings,
  persistScreenshotSettings,
  ScreenshotCaptureRect,
  ScreenshotDestination,
  takeScreenshot,
} from "./lib/screenshots";
import {
  captureNameFromSavedPath,
  loadUiPreferences,
  persistUiPreferences,
} from "./lib/preferences";
import {
  copyRangeMeasurementValues,
  DEFAULT_DIGITAL_RANGE_MEASUREMENTS,
  DIGITAL_RANGE_MEASUREMENT_CATEGORIES,
  DigitalRangeMeasurementId,
  ensureRangeMeasurementIds,
  formatDeltaTime,
  formatRangeMeasurementValue,
  rangeMeasurementDefinition,
} from "./lib/rangeMeasurements";
import {
  getDefaultTimingMarkerColor,
  getNextTimingMarkerNumber,
  normalizeTimingMarker,
  TimingMarkerKind,
  UiTimingMarker,
  UiTimingMarkerPlacement,
} from "./lib/timingMarkers";

type FooterPopover = "devices" | "newSession" | "zoom" | null;

const GRAPH_MIN_WIDTH = 50;
const GRAPH_ROW_LABEL_MAX_WIDTH = 293;
const SIDEBAR_DEFAULT_WIDTH = 300;
const SIDEBAR_MIN_WIDTH = 300;
const SIDEBAR_TABS_CHANGER_WIDTH = 47;

// Routes the waveform through the backend-owned frame loop instead of the
// frontend's tile pipeline (level-of-detail bands, request rate limits, raster
// caches and the fallback chain). Flipping this to `true` is the whole switch:
// the old path stays intact underneath until the new one has been validated on
// real captures.
const USE_BACKEND_FRAME_LOOP = true;

interface UiSession {
  id: string;
  name: string;
  readOnly: boolean;
  selectedDevice: string;
  settings: CaptureSettings;
  deviceSettings: UiDeviceSettings;
  channelOrder: number[];
  channelLabels: string[];
  channelHeights: number[];
  hiddenDigitalChannels: boolean[];
  manualChannelLayout: boolean;
  showInteractiveMeasurement: boolean;
  graphScrollTop: number;
  summary: CaptureSummary | null;
  progress: CaptureProgress | null;
  memoryUsage: CaptureMemoryUsage | null;
  tile: WaveformTile | null;
  cursorState: UiCursorState;
  canvasWidth: number;
  viewportStart: number;
  viewportSamples: number;
  viewportMaxSamples: number | null;
  liveViewportMode: "auto" | "manual";
  diagnostics: DiagnosticEvent[];
  busy: boolean;
  message: string;
  analyzers: UiAnalyzerInstance[];
  analyzerDataPane: "table" | "terminal";
  analyzerTrigger: UiAnalyzerTriggerState;
  rangePlacement: UiRangePlacement | null;
  rangeMeasurements: UiRangeMeasurement[];
  timingMarkerPlacement: UiTimingMarkerPlacement | null;
  timingMarkers: UiTimingMarker[];
  notes: string;
}

interface PendingCaptureUiUpdate {
  progress?: CaptureProgress;
  memoryUsage?: CaptureMemoryUsage;
  summary?: CaptureSummary;
}

interface CaptureUpdatedEvent {
  session_id: string;
  summary: CaptureSummary;
}

interface CaptureMemoryUpdatedEvent {
  session_id: string;
  usage: CaptureMemoryUsage;
}

interface CaptureTriggeredEvent {
  session_id: string;
  trigger: CaptureTriggerMetadata;
}

interface UiAnalyzerTriggerState {
  analyzerId: string;
  enabled: boolean;
  expanded: boolean;
  holdoffSeconds: number;
  query: string;
}

interface AnalyzerEditState {
  analyzer: UiAnalyzerInstance;
  isNew: boolean;
  sessionId: string;
}

type UiRecordingMode = "FreeRun" | "Timer" | "Trigger";
type UiTriggerEdge = "Rising Edge" | "Falling Edge" | "High Pulse" | "Low Pulse";
type UiTriggerCondition = "Ignore" | "Low" | "High";

interface UiDeviceSettings {
  analogChannels: UiAnalogChannelSettings[];
  analogSampleRateHz: number;
  bufferSizeMb: number;
  captureMode: UiRecordingMode;
  clockNegedge: boolean;
  digitalChannels: boolean[];
  externalTriggerMode: ExternalTriggerMode;
  glitchFilterEnabled: boolean;
  pwmDutyPercent: number;
  pwmEffectiveDutyPercent: number | null;
  pwmEffectiveFrequencyHz: number | null;
  pwmEnabled: boolean;
  pwmFrequencyHz: number;
  singleShotEnabled: boolean;
  singleShotHighResolution: boolean;
  singleShotPostTriggerMs: number;
  singleShotPreTriggerMs: number;
  triggerHoldoffMs: number;
  triggerOutEnabled: boolean;
  triggerChannel: number;
  triggerConditions: UiTriggerCondition[];
  triggerEdge: UiTriggerEdge;
  triggerSamplingEnabled: boolean;
  triggerSamplingPriority: "Sample Rate" | "Duration";
  triggerSamplingRateHz: number;
  triggerPulseWidthUs: number;
  trimAfterCapture: boolean;
}

interface UiCursorState {
  visible: boolean;
  x1Sample: number;
  x2Sample: number;
  y1Channel: number;
  y2Channel: number;
}

interface UiRangeMeasurement {
  annotationsVisible: boolean;
  channelIndex: number;
  color: string;
  endSample: number;
  expanded: boolean;
  id: string;
  measurementError: string | null;
  measurements: DigitalRangeMeasurementId[];
  measurementStats: DigitalRangeMeasurementStats | null;
  measurementStatsBusy: boolean;
  measurementStatsKey: string | null;
  name: string;
  note: string;
  selected: boolean;
  showTooltip: boolean;
  startSample: number;
  tooltipPosition: { x: number; y: number } | null;
}

interface UiRangePlacement {
  channelIndex: number | null;
  currentSample: number | null;
  startedBy: "command" | "selectionKey";
  startSample: number | null;
}

type ChannelContextMenuSource = "label" | "graph";

interface ChannelContextMenuState {
  channelIndex: number;
  sample?: number;
  source: ChannelContextMenuSource;
  x: number;
  y: number;
}

interface PendingChannelTrim {
  mode: ChannelDeleteDataMode;
  range: ChannelTrimPreview;
  sessionId: string;
}

interface ScreenshotNotification {
  body: string;
  heading: string;
  id: number;
  type: "error" | "success";
}

const ANALYZER_FRAME_ROW_SEARCH_TEXT_CACHE = new WeakMap<DecodedFrame, Map<string, string>>();

const DEFAULT_DEVICE_ID = "fake:sigpilot-demo";
const DEFAULT_BUFFER_SIZE_MB = 1024;
const DEFAULT_DEMO_BUFFER_SIZE_MB = 4096;
const SCREENSHOT_CONTEXT_MENU_CLOSE_DELAY_MS = 300;
const SCREENSHOT_WINDOW_CONTEXT_MENU_CLOSE_DELAY_MS = 100;
const SCREENSHOT_FEEDBACK_VISIBLE_MS = 520;
const SCREENSHOT_NOTIFICATION_VISIBLE_MS = 4_000;
const ANALYZER_TABLE_HEADER_HEIGHT_PX = 28;
const ANALYZER_TABLE_ROW_HEIGHT_PX = 28;
const ANALYZER_TERMINAL_ROW_HEIGHT_PX = 18;
const ANALYZER_LIST_OVERSCAN_ROWS = 12;
const ANALYZER_RENDERED_FRAME_CACHE_LIMIT = 5_000;
const FALLBACK_SAMPLE_RATES = [
  2_000,
  5_000,
  10_000,
  20_000,
  40_000,
  50_000,
  100_000,
  200_000,
  400_000,
  500_000,
  1_000_000,
  2_000_000,
  4_000_000,
  5_000_000,
  10_000_000,
  20_000_000,
  25_000_000,
  50_000_000,
  100_000_000,
];
const FALLBACK_CHANNEL_COUNTS = [1, 2, 4, 8, 16, 24, 32];
const FALLBACK_THRESHOLD_VOLTAGES = [0.8, 1.0, 1.2, 1.5, 1.8, 2.0, 2.5, 3.0, 3.3, 5.0];
  const RANGE_COLORS = [
  "hsl(334, 58%, 53%)",
  "hsl(150, 100%, 30%)",
  "hsl(198, 70%, 50%)",
  "hsl(7, 69%, 54%)",
];

function clampSidebarPanelWidth(width: number) {
  const maxWidth =
    typeof window === "undefined"
      ? SIDEBAR_DEFAULT_WIDTH
      : Math.max(
          SIDEBAR_MIN_WIDTH,
          window.innerWidth - SIDEBAR_TABS_CHANGER_WIDTH - GRAPH_ROW_LABEL_MAX_WIDTH - GRAPH_MIN_WIDTH,
        );
  return Math.max(SIDEBAR_MIN_WIDTH, Math.min(maxWidth, Math.round(width)));
}

function clampFixedPopoverRect(
  anchorRect: DOMRect,
  width: number,
  height: number,
  options: { align?: "start" | "end"; gap?: number } = {},
) {
  const align = options.align ?? "end";
  const gap = options.gap ?? 6;
  const viewportWidth = typeof window === "undefined" ? width + 16 : window.innerWidth;
  const viewportHeight = typeof window === "undefined" ? height + 16 : window.innerHeight;
  const preferredLeft = align === "start" ? anchorRect.left : anchorRect.right - width;
  const preferredTop = anchorRect.bottom + gap;
  const top =
    preferredTop + height > viewportHeight - 8
      ? Math.max(8, anchorRect.top - height - gap)
      : Math.max(8, preferredTop);
  return {
    left: Math.max(8, Math.min(preferredLeft, viewportWidth - width - 8)),
    top,
  };
}

const panelMeta: Record<
  SidebarPanel,
  {
    label: string;
    iconUrl: string;
  }
> = {
  devices: { label: "Device Settings", iconUrl: devicesIcon },
  recordingSettings: { label: "Recording Settings", iconUrl: recordingSettingsIcon },
  analyzers: { label: "Analyzers", iconUrl: analyzersIcon },
  cursors: { label: "Cursors", iconUrl: cursorsIcon },
  measurements: { label: "Measurements", iconUrl: measurementsIcon },
  timingMarkers: { label: "Timing Markers", iconUrl: timingMarkersIcon },
  extensions: { label: "Extensions", iconUrl: extensionsIcon },
  notes: { label: "Notes", iconUrl: notesIcon },
};

function defaultSettings(deviceId: string): CaptureSettings {
  return {
    device_id: deviceId,
    sample_rate_hz: 25_000_000,
    channel_count: 8,
    enabled_channels: Array.from({ length: 8 }, (_, index) => index),
    duration_ms: 10,
    buffer_size_mb: defaultBufferSizeMb(deviceId),
    decode_cross: true,
    threshold_volts: 2.0,
    external_trigger_mode: "Close",
    mode: "Stream",
    trigger_enabled: false,
    trigger_channel: 0,
    trigger_kind: "Rising",
    trigger_high_mask: 0,
    trigger_low_mask: 0,
    trigger_position_percent: 50,
    glitch_filter_enabled: false,
    clock_edge: false,
    trigger_out_enabled: false,
  };
}

function defaultBufferSizeMb(deviceId: string) {
  return deviceId === DEFAULT_DEVICE_ID || deviceId.toLowerCase().includes("demo")
    ? DEFAULT_DEMO_BUFFER_SIZE_MB
    : DEFAULT_BUFFER_SIZE_MB;
}

function backendCaptureMode(mode: UiRecordingMode): CaptureSettings["mode"] {
  // A triggered recording must use the FPGA's finite buffer path so the
  // programmed post-trigger window can stop deterministically.
  return mode === "FreeRun" ? "Stream" : "Buffer";
}

function captureTriggerKind(edge: UiTriggerEdge): CaptureTriggerKind {
  if (edge === "Falling Edge") return "Falling";
  if (edge === "High Pulse") return "High";
  if (edge === "Low Pulse") return "Low";
  return "Rising";
}

function settingsFromDeviceSettings(session: UiSession, deviceId: string): CaptureSettings {
  const deviceSettings = session.deviceSettings;
  const captureMode = backendCaptureMode(deviceSettings.captureMode);
  const sampleRateHz =
    deviceSettings.captureMode === "Trigger" && deviceSettings.triggerSamplingEnabled
      ? deviceSettings.triggerSamplingRateHz
      : session.settings.sample_rate_hz;
  const triggerWindowMs = Math.max(
    0,
    deviceSettings.singleShotPreTriggerMs + deviceSettings.singleShotPostTriggerMs,
  );
  const triggerPositionPercent =
    triggerWindowMs > 0
      ? Math.round((Math.max(0, deviceSettings.singleShotPreTriggerMs) / triggerWindowMs) * 100)
      : 50;
  const enabledChannels = enabledChannelIndexes(
    deviceSettings.digitalChannels,
    session.settings.channel_count,
  );
  const triggerMasks = (deviceSettings.triggerConditions ?? []).reduce(
    (masks, condition, channel) => {
      if (channel === deviceSettings.triggerChannel || channel >= session.settings.channel_count) return masks;
      if (!enabledChannels.includes(channel)) return masks;
      const bit = 2 ** channel;
      if (condition === "High") masks.high += bit;
      if (condition === "Low") masks.low += bit;
      return masks;
    },
    { high: 0, low: 0 },
  );
  return {
    ...session.settings,
    clock_edge: deviceSettings.clockNegedge,
    device_id: deviceId,
    buffer_size_mb: deviceSettings.bufferSizeMb,
    duration_ms: deviceSettings.captureMode === "Trigger" ? Math.max(1, triggerWindowMs) : session.settings.duration_ms,
    enabled_channels: enabledChannels,
    external_trigger_mode: deviceSettings.externalTriggerMode,
    glitch_filter_enabled: deviceSettings.glitchFilterEnabled,
    mode: captureMode,
    sample_rate_hz: sampleRateHz,
    trigger_channel: deviceSettings.triggerChannel,
    trigger_enabled: deviceSettings.captureMode === "Trigger",
    trigger_kind: captureTriggerKind(deviceSettings.triggerEdge),
    trigger_high_mask: triggerMasks.high,
    trigger_low_mask: triggerMasks.low,
    trigger_position_percent: Math.max(0, Math.min(100, triggerPositionPercent)),
    trigger_out_enabled: deviceSettings.triggerOutEnabled,
  };
}

function hardwareModesForCaptureMode(
  capabilities: HardwareCaptureCapabilities | null | undefined,
  mode: CaptureSettings["mode"],
) {
  if (!capabilities) return [];
  const stream = mode === "Stream";
  return capabilities.channel_modes.filter((channelMode) => channelMode.stream === stream);
}

function maxChannelsForCapabilities(
  capabilities: HardwareCaptureCapabilities | null | undefined,
  mode: CaptureSettings["mode"],
) {
  const modes = hardwareModesForCaptureMode(capabilities, mode);
  return Math.max(1, ...(modes.length > 0 ? modes.map((channelMode) => channelMode.channels) : [capabilities?.max_channels ?? 32]));
}

function channelCountOptionsForCapabilities(
  capabilities: HardwareCaptureCapabilities | null | undefined,
  mode: CaptureSettings["mode"],
  current?: number,
) {
  const maxChannels = maxChannelsForCapabilities(capabilities, mode);
  const options = FALLBACK_CHANNEL_COUNTS.filter((count) => count <= maxChannels);
  if (current != null && current >= 1 && current <= maxChannels) options.push(current);
  if (!options.includes(maxChannels)) options.push(maxChannels);
  return uniqueSortedNumbers(options);
}

function sampleRateOptionsForCapabilities(
  capabilities: HardwareCaptureCapabilities | null | undefined,
  mode: CaptureSettings["mode"],
  channelCount: number,
) {
  if (!capabilities) return FALLBACK_SAMPLE_RATES;
  const matchingModes = hardwareModesForCaptureMode(capabilities, mode).filter(
    (channelMode) => channelMode.channels >= channelCount,
  );
  const rates =
    matchingModes.length > 0
      ? matchingModes.flatMap((channelMode) => channelMode.sample_rates)
      : capabilities.sample_rates;
  return uniqueSortedNumbers(rates.length > 0 ? rates : FALLBACK_SAMPLE_RATES);
}

function sampleRateSelectOptionsForCapabilities(
  capabilities: HardwareCaptureCapabilities | null | undefined,
  mode: CaptureSettings["mode"],
  channelCount: number,
  current: number,
) {
  const options = sampleRateOptionsForCapabilities(capabilities, mode, channelCount);
  if (!options.includes(current)) return uniqueSortedNumbers([...options, current]);
  return options;
}

function thresholdOptionsForCapabilities(
  capabilities: HardwareCaptureCapabilities | null | undefined,
  current: number,
) {
  const configured = capabilities?.threshold_volts?.filter((voltage) => Number.isFinite(voltage) && voltage > 0) ?? [];
  return uniqueSortedNumbers([...FALLBACK_THRESHOLD_VOLTAGES, ...configured, current]);
}

function selectedHardwareChannelMode(
  capabilities: HardwareCaptureCapabilities | null | undefined,
  mode: CaptureSettings["mode"],
  channelCount: number,
  sampleRateHz: number,
): HardwareChannelModeInfo | null {
  const modes = hardwareModesForCaptureMode(capabilities, mode);
  if (modes.length === 0) return null;
  const maxChannels = Math.max(1, ...modes.map((channelMode) => channelMode.channels));
  const effectiveChannelCount = Math.max(1, Math.min(channelCount, maxChannels));
  const capableModes = modes.filter((channelMode) => channelMode.channels >= effectiveChannelCount);
  const inRange = capableModes
    .filter(
      (channelMode) =>
        sampleRateHz >= channelMode.min_sample_rate_hz && sampleRateHz <= channelMode.max_sample_rate_hz,
    )
    .sort(
      (left, right) =>
        left.channels - right.channels || left.max_sample_rate_hz - right.max_sample_rate_hz,
    );
  if (inRange[0]) return inRange[0];
  return (
    capableModes.sort(
      (left, right) =>
        right.max_sample_rate_hz - left.max_sample_rate_hz || left.channels - right.channels,
    )[0] ?? null
  );
}

function clampCaptureSettingsToCapabilities(
  settings: CaptureSettings,
  capabilities: HardwareCaptureCapabilities | null | undefined,
): CaptureSettings {
  if (!capabilities) return settings;
  const mode = settings.mode;
  const maxChannels = maxChannelsForCapabilities(capabilities, mode);
  const channelCount = Math.max(1, Math.min(settings.channel_count, maxChannels));
  const enabledChannels = settings.enabled_channels.filter(
    (channel, index, channels) =>
      Number.isInteger(channel) &&
      channel >= 0 &&
      channel < channelCount &&
      channels.indexOf(channel) === index,
  );
  const selectedMode = selectedHardwareChannelMode(
    capabilities,
    mode,
    channelCount,
    settings.sample_rate_hz,
  );
  const boundedSampleRate = selectedMode
    ? Math.max(
        selectedMode.min_sample_rate_hz,
        Math.min(settings.sample_rate_hz, selectedMode.max_sample_rate_hz),
      )
    : settings.sample_rate_hz;
  return {
    ...settings,
    channel_count: channelCount,
    enabled_channels: enabledChannels,
    sample_rate_hz: nearestSampleRate(
      sampleRateOptionsForCapabilities(capabilities, mode, channelCount),
      boundedSampleRate,
    ),
  };
}

function nearestSampleRate(sampleRates: number[], target: number) {
  if (sampleRates.length === 0) return target;
  return sampleRates.reduce((nearest, rate) =>
    Math.abs(rate - target) < Math.abs(nearest - target) ? rate : nearest,
  );
}

function uniqueSortedNumbers(values: number[]) {
  return Array.from(new Set(values.filter((value) => Number.isFinite(value)))).sort((left, right) => left - right);
}

function makeDigitalChannels(channelCount: number) {
  return Array.from({ length: 32 }, (_, index) => index < channelCount);
}

function enabledChannelIndexes(channels: boolean[], channelCount: number) {
  return channels
    .slice(0, Math.max(1, channelCount))
    .flatMap((enabled, index) => (enabled ? [index] : []));
}

function metadataEnabledChannels(metadata: CaptureSummary["metadata"]) {
  const channels = metadata.enabled_channels ?? [];
  return channels.length > 0
    ? channels.filter(
        (channel, index) =>
          Number.isInteger(channel) &&
          channel >= 0 &&
          channel < metadata.channel_count &&
          channels.indexOf(channel) === index,
      )
    : Array.from({ length: metadata.channel_count }, (_, index) => index);
}

function digitalChannelsForMetadata(metadata: CaptureSummary["metadata"]) {
  const enabled = new Set(metadataEnabledChannels(metadata));
  return Array.from({ length: 32 }, (_, index) => enabled.has(index));
}

function makeHiddenDigitalChannels(existing: boolean[] = []) {
  return Array.from({ length: 32 }, (_, index) => existing[index] ?? false);
}

function channelLabelsForCount(channelCount: number, existing: string[] = []) {
  return Array.from({ length: Math.max(1, channelCount) }, (_, index) => existing[index] ?? `D${index}`);
}

function channelOrderForCount(channelCount: number, existing: number[] = []) {
  const count = Math.max(1, channelCount);
  const validExisting = existing.filter(
    (channel, index) => Number.isInteger(channel) && channel >= 0 && channel < count && existing.indexOf(channel) === index,
  );
  const missing = Array.from({ length: count }, (_, index) => index).filter((channel) => !validExisting.includes(channel));
  return [...validExisting, ...missing];
}

function captureChannelLimit(session: UiSession) {
  return Math.max(
    1,
    session.summary?.metadata.channel_count ?? 0,
    session.settings.channel_count,
    highestEnabledDigitalChannel(session.deviceSettings.digitalChannels) + 1,
  );
}

function isDigitalChannelEnabled(session: UiSession, channelIndex: number) {
  return session.deviceSettings.digitalChannels[channelIndex] ?? channelIndex < session.settings.channel_count;
}

function visibleDigitalChannelIndexes(session: UiSession) {
  const limit = captureChannelLimit(session);
  const order = channelOrderForCount(limit, session.channelOrder);
  return order.filter(
    (index) => isDigitalChannelEnabled(session, index) && !(session.hiddenDigitalChannels[index] ?? false),
  );
}

function highestEnabledDigitalChannel(channels: boolean[], fallback = 0) {
  return channels.reduce((highest, enabled, index) => (enabled ? index : highest), fallback);
}

function tileForVisibleChannels(tile: WaveformTile | null, channelIndexes: number[], labels: string[]) {
  if (!tile) return null;
  const channelsByIndex = new Map(tile.channels.map((channel) => [channel.channel, channel]));
  return {
    ...tile,
    channels: channelIndexes.map((channelIndex) => {
      const channel = channelsByIndex.get(channelIndex);
      if (!channel) {
        return {
          channel: channelIndex,
          label: labels[channelIndex] ?? `D${channelIndex}`,
          bins: [],
          segments: [],
          rising_edges: [],
          falling_edges: [],
        };
      }
      return {
        ...channel,
        label: labels[channelIndex] ?? channel.label,
      };
    }),
  };
}

function summaryWithLabels(summary: CaptureSummary, labels: string[]): CaptureSummary {
  return {
    ...summary,
    metadata: {
      ...summary.metadata,
      labels: channelLabelsForCount(summary.metadata.channel_count, labels),
    },
  };
}

function syncSessionWithEffectiveCaptureMetadata(session: UiSession, summary: CaptureSummary): UiSession {
  const enabledChannels = metadataEnabledChannels(summary.metadata);
  const triggerChannel = enabledChannels.includes(session.deviceSettings.triggerChannel)
    ? session.deviceSettings.triggerChannel
    : (enabledChannels[0] ?? 0);
  return {
    ...session,
    selectedDevice: summary.metadata.source_device || session.selectedDevice,
    settings: {
      ...session.settings,
      device_id: summary.metadata.source_device || session.settings.device_id,
      sample_rate_hz: summary.metadata.sample_rate_hz,
      channel_count: summary.metadata.channel_count,
      enabled_channels: enabledChannels,
    },
    deviceSettings: {
      ...session.deviceSettings,
      digitalChannels: digitalChannelsForMetadata(summary.metadata),
      triggerChannel,
    },
    channelLabels: channelLabelsForCount(summary.metadata.channel_count, session.channelLabels),
  };
}

function applyLiveCaptureSummary(session: UiSession, summary: CaptureSummary): UiSession {
  const syncedSession = syncSessionWithEffectiveCaptureMetadata(session, summary);
  const previousSamples = session.summary?.metadata.sample_count ?? 0;
  const wasFollowingLiveEdge =
    previousSamples === 0 ||
    session.viewportStart + session.viewportSamples >=
      previousSamples - Math.max(1, Math.round(session.viewportSamples * 0.05));
  const requestedViewportSamples =
    session.liveViewportMode === "auto"
      ? defaultCaptureViewportSamples(
          summary.metadata.sample_count,
          summary.metadata.sample_rate_hz,
        )
      : session.viewportSamples;
  const requestedViewportStart = session.liveViewportMode === "auto" || wasFollowingLiveEdge
    ? summary.metadata.sample_count - requestedViewportSamples
    : session.viewportStart;
  const viewport = normalizeLiveCaptureViewport(
    requestedViewportStart,
    requestedViewportSamples,
    summary.metadata.sample_count,
    summary.metadata.sample_rate_hz,
    session.viewportMaxSamples ?? undefined,
  );

  return {
    ...syncedSession,
    summary: summaryWithLabels(summary, syncedSession.channelLabels),
    viewportStart: viewport.start,
    viewportSamples: viewport.samples,
    viewportMaxSamples: session.viewportMaxSamples,
    message: "Capturing",
  };
}

function initialCaptureViewport(summary: CaptureSummary) {
  const totalSamples = Math.max(1, summary.metadata.sample_count);
  const viewportMaxSamples = maximumDataViewportSamples(
    totalSamples,
    summary.metadata.sample_rate_hz,
  );
  const viewportSamples = defaultCaptureViewportSamples(
    summary.metadata.sample_count,
    summary.metadata.sample_rate_hz,
  );
  const triggerSample = summary.metadata.trigger?.sample_index;
  const viewportStart =
    triggerSample == null
      ? 0
      : Math.max(0, Math.min(totalSamples - viewportSamples, triggerSample - viewportSamples / 2));
  return { viewportMaxSamples, viewportSamples, viewportStart };
}

function completedCaptureViewport(
  session: UiSession,
  summary: CaptureSummary,
  panToTrigger: boolean,
) {
  const totalSamples = Math.max(1, summary.metadata.sample_count);
  const dataViewportMaxSamples = maximumDataViewportSamples(
    totalSamples,
    summary.metadata.sample_rate_hz,
  );
  if (session.liveViewportMode === "manual") {
    const viewportMaxSamples = Math.max(
      dataViewportMaxSamples,
      Math.round(session.viewportSamples),
    );
    const viewport = normalizeCaptureViewport(
      session.viewportStart,
      session.viewportSamples,
      totalSamples,
      viewportMaxSamples,
    );
    return {
      viewportMaxSamples,
      viewportSamples: viewport.samples,
      viewportStart: viewport.start,
    };
  }
  if (panToTrigger) {
    return {
      ...initialCaptureViewport(summary),
      viewportMaxSamples: dataViewportMaxSamples,
    };
  }
  // The capture just finished and the user never took control of the view, so
  // show them what they captured rather than leaving them parked on the trailing
  // window they were following while it streamed in. `preserveCaptureViewport`
  // used to run here, which kept that trailing window — a finished capture
  // therefore opened showing only its last second, with no overview of the rest.
  const preview = normalizeCaptureViewport(
    0,
    previewCaptureViewportSamples(
      summary.metadata.sample_count,
      summary.metadata.sample_rate_hz,
    ),
    totalSamples,
    dataViewportMaxSamples,
  );
  return {
    viewportMaxSamples: dataViewportMaxSamples,
    viewportSamples: preview.samples,
    viewportStart: preview.start,
  };
}

function applyCaptureTrigger(session: UiSession, trigger: CaptureTriggerMetadata): UiSession {
  const triggerMarker = {
    color: "orange2" as const,
    graphPopupOpen: null,
    id: "capture-trigger",
    isCaptureTrigger: true,
    isExpanded: false,
    label: "Trigger",
    note: `D${trigger.channel} ${trigger.kind.toLowerCase()} edge`,
    sample: Math.max(0, Math.round(trigger.sample_index)),
    selected: false,
    type: "single" as const,
  };
  return {
    ...session,
    summary: session.summary
      ? {
          ...session.summary,
          metadata: { ...session.summary.metadata, trigger },
        }
      : session.summary,
    timingMarkers: [...session.timingMarkers.filter((marker) => !marker.isCaptureTrigger), triggerMarker],
    message: `Triggered on D${trigger.channel} (${trigger.kind})`,
  };
}

function applyTrimmedCapture(
  session: UiSession,
  summary: CaptureSummary,
  trimStart: number,
  mode: "before" | "after" | "offscreen",
): UiSession {
  const labels = channelLabelsForCount(summary.metadata.channel_count, session.channelLabels);
  const totalSamples = Math.max(1, summary.metadata.sample_count);
  const shiftSample = (sample: number) => Math.max(0, Math.min(totalSamples, Math.round(sample - trimStart)));
  const shiftPoint = (sample: number) => Math.max(0, Math.min(totalSamples - 1, Math.round(sample - trimStart)));
  const viewportSamples = Math.max(1, Math.min(totalSamples, session.viewportSamples));

  return {
    ...session,
    analyzers: session.analyzers.map((analyzer) => ({
      ...analyzer,
      protocolBubbles: [],
      decodedFrameCount: 0,
      decodedFrames: [],
      decodedFramesComplete: false,
      decodedDecodeSignature: null,
      previousFrame: null,
      nextFrame: null,
      renderedTracks: [],
      renderedViewport: null,
      renderedDecodeSignature: null,
      renderBusy: false,
      renderProgress: 0,
      decodeBusy: false,
      decodeProgress: 0,
      highlightedFrameIndex: null,
    })),
    channelLabels: labels,
    cursorState: defaultCursorState(totalSamples, summary.metadata.channel_count),
    message:
      mode === "before"
        ? "Deleted data before point"
        : mode === "after"
          ? "Deleted data after point"
          : "Deleted off-screen data",
    rangePlacement: null,
    timingMarkerPlacement: null,
    rangeMeasurements: session.rangeMeasurements
      .map((range) => {
        const startSample = shiftSample(range.startSample);
        const endSample = shiftSample(range.endSample);
        return {
          ...range,
          startSample: Math.min(startSample, endSample),
          endSample: Math.max(startSample, endSample),
          measurementError: null,
          measurementStats: null,
          measurementStatsBusy: false,
          measurementStatsKey: null,
          measurements: ensureRangeMeasurementIds(range.measurements),
          tooltipPosition: range.tooltipPosition ?? null,
        };
      })
      .filter((range) => range.endSample > range.startSample),
    summary: summaryWithLabels(summary, labels),
    tile: null,
    timingMarkers: session.timingMarkers
      .map((marker) => {
        const sample = shiftPoint(marker.sample);
        const endSample = marker.endSample == null ? undefined : Math.max(sample + 1, shiftSample(marker.endSample));
        return {
          ...normalizeTimingMarker(marker, Number(marker.label) || 0),
          sample,
          endSample: endSample == null ? undefined : Math.min(totalSamples, endSample),
          graphPopupOpen: null,
        };
      })
      .filter((marker) => marker.type === "single" || (marker.endSample ?? marker.sample + 1) > marker.sample),
    viewportSamples,
    viewportStart: 0,
  };
}

function isDemoDevice(deviceId: string) {
  return deviceId.startsWith("fake:");
}

function analogChannelsForDevice(
  deviceId: string,
  existing?: Partial<UiAnalogChannelSettings>[],
  preserveExisting = false,
) {
  const channels = makeDefaultAnalogChannels(existing, isDemoDevice(deviceId) ? 4 : 0);
  if (preserveExisting || isDemoDevice(deviceId)) return channels;
  return channels.map((channel) => ({ ...channel, enabled: false }));
}

function defaultDeviceSettings(
  channelCount: number,
  bufferSizeMb = DEFAULT_BUFFER_SIZE_MB,
  deviceId = DEFAULT_DEVICE_ID,
): UiDeviceSettings {
  return {
    analogChannels: analogChannelsForDevice(deviceId),
    analogSampleRateHz: 6_250_000,
    bufferSizeMb,
    captureMode: "FreeRun",
    clockNegedge: false,
    digitalChannels: makeDigitalChannels(channelCount),
    externalTriggerMode: "Close",
    glitchFilterEnabled: true,
    pwmDutyPercent: 50,
    pwmEffectiveDutyPercent: null,
    pwmEffectiveFrequencyHz: null,
    pwmEnabled: false,
    pwmFrequencyHz: 1_000,
    singleShotEnabled: false,
    singleShotHighResolution: false,
    singleShotPostTriggerMs: 1_000,
    singleShotPreTriggerMs: 0,
    triggerHoldoffMs: 0,
    triggerOutEnabled: false,
    triggerChannel: 0,
    triggerConditions: Array.from({ length: 32 }, () => "Ignore"),
    triggerEdge: "Rising Edge",
    triggerSamplingEnabled: false,
    triggerSamplingPriority: "Sample Rate",
    triggerSamplingRateHz: 25_000_000,
    triggerPulseWidthUs: 10,
    trimAfterCapture: true,
  };
}

function defaultCursorState(sampleCount = 100_000, channelCount = 8): UiCursorState {
  return {
    visible: false,
    x1Sample: Math.max(0, Math.round(sampleCount * 0.25)),
    x2Sample: Math.max(1, Math.round(sampleCount * 0.75)),
    y1Channel: 0,
    y2Channel: Math.min(1, Math.max(0, channelCount - 1)),
  };
}

function createRangeMeasurement(
  session: UiSession,
  channelIndex: number,
  startSample: number,
  endSample: number,
): UiRangeMeasurement {
  const totalSamples = Math.max(1, session.summary?.metadata.sample_count ?? session.viewportSamples);
  const start = Math.max(0, Math.min(totalSamples - 1, Math.round(Math.min(startSample, endSample))));
  const end = Math.max(start + 1, Math.min(totalSamples, Math.round(Math.max(startSample, endSample))));
  const index = session.rangeMeasurements.length;
  return {
    annotationsVisible: true,
    channelIndex,
    color: RANGE_COLORS[0],
    endSample: end,
    expanded: false,
    id: `range-${Date.now()}-${index}`,
    measurementError: null,
    measurements: [...DEFAULT_DIGITAL_RANGE_MEASUREMENTS],
    measurementStats: null,
    measurementStatsBusy: false,
    measurementStatsKey: null,
    name: `M${index}`,
    note: "",
    selected: true,
    showTooltip: true,
    startSample: start,
    tooltipPosition: null,
  };
}

function createTimingMarker(
  session: UiSession,
  type: TimingMarkerKind,
  sample?: number,
  endSample?: number,
): UiTimingMarker {
  const totalSamples = session.summary?.metadata.sample_count ?? Math.max(1, session.viewportSamples);
  const center = clampSamplePoint(
    sample ?? Math.round(session.viewportStart + session.viewportSamples * 0.5),
    totalSamples,
  );
  const width = Math.max(16, Math.round(session.viewportSamples * 0.22));
  const labelNumber = getNextTimingMarkerNumber(session.timingMarkers);
  const pairEndSample = clampSamplePoint(endSample ?? center + width, totalSamples);
  const pairStart = Math.min(type === "pair" && endSample == null ? center - width : center, pairEndSample);
  const pairEnd = Math.max(type === "pair" && endSample == null ? center - width : center, pairEndSample);
  return {
    color: getDefaultTimingMarkerColor(labelNumber),
    endSample: type === "pair" ? clampSamplePoint(pairEnd, totalSamples) : undefined,
    graphPopupOpen: null,
    id: `marker-${Date.now()}-${type}-${labelNumber}`,
    isExpanded: false,
    label: `${labelNumber}`,
    note: "",
    sample: type === "pair" ? clampSamplePoint(pairStart, totalSamples) : center,
    selected: true,
    type,
  };
}

function createTimingMarkerPlacement(
  session: UiSession,
  type: TimingMarkerKind,
  sample?: number,
): UiTimingMarkerPlacement {
  const labelNumber = getNextTimingMarkerNumber(session.timingMarkers);
  const totalSamples = session.summary?.metadata.sample_count ?? Math.max(1, session.viewportSamples);
  return {
    color: getDefaultTimingMarkerColor(labelNumber),
    id: `marker-temp-${Date.now()}-${type}-${labelNumber}`,
    label: `${labelNumber}`,
    placingSide: "start",
    sample: clampSamplePoint(
      sample ?? Math.round(session.viewportStart + session.viewportSamples * 0.5),
      totalSamples,
    ),
    type,
  };
}

function clampSamplePoint(sample: number, totalSamples: number) {
  return Math.max(0, Math.min(Math.max(0, totalSamples - 1), Math.round(sample)));
}

function makeSession(id: string, name: string, deviceId: string, source?: UiSession): UiSession {
  const settings = source ? { ...source.settings, device_id: deviceId } : defaultSettings(deviceId);
  const preserveSourceAnalogChannels = source?.selectedDevice === deviceId;
  return {
    id,
    name,
    readOnly: false,
    selectedDevice: deviceId,
    settings,
    deviceSettings: source
      ? {
          ...source.deviceSettings,
          analogChannels: analogChannelsForDevice(
            deviceId,
            source.deviceSettings.analogChannels,
            preserveSourceAnalogChannels,
          ),
          analogSampleRateHz: source.deviceSettings.analogSampleRateHz ?? 6_250_000,
          digitalChannels: [...source.deviceSettings.digitalChannels],
        }
      : defaultDeviceSettings(settings.channel_count, settings.buffer_size_mb, deviceId),
    channelOrder: channelOrderForCount(32, source?.channelOrder),
    channelLabels: source
      ? channelLabelsForCount(settings.channel_count, source.channelLabels)
      : channelLabelsForCount(settings.channel_count),
    channelHeights: source
      ? makeSaleaeDigitalRowHeights(32, source.channelHeights ?? [])
      : makeSaleaeDigitalRowHeights(),
    hiddenDigitalChannels: makeHiddenDigitalChannels(source?.hiddenDigitalChannels),
    manualChannelLayout: source?.manualChannelLayout ?? false,
    showInteractiveMeasurement: source?.showInteractiveMeasurement ?? true,
    graphScrollTop: 0,
    summary: null,
    progress: null,
    memoryUsage: null,
    tile: null,
    cursorState: source
      ? { ...source.cursorState }
      : defaultCursorState(100_000, settings.channel_count),
    canvasWidth: 1000,
    viewportStart: 0,
    viewportSamples: 50_000,
    viewportMaxSamples: null,
    liveViewportMode: "auto",
    diagnostics: [],
    busy: false,
    message: "Ready",
    analyzers: source
      ? source.analyzers.map((analyzer, index) => ({
          ...analyzer,
          id: `${id}-analyzer-${index}`,
          protocolBubbles: [],
          decodedFrameCount: 0,
          decodedFrames: [],
          decodedFramesComplete: false,
          decodedDecodeSignature: null,
          previousFrame: null,
          nextFrame: null,
          renderedTracks: [],
          renderedViewport: null,
          renderedDecodeSignature: null,
          renderBusy: false,
          renderProgress: 0,
          decodeBusy: false,
          decodeProgress: 0,
          highlightedFrameIndex: null,
        }))
      : [],
    analyzerDataPane: "table",
    analyzerTrigger: {
      analyzerId: "",
      enabled: false,
      expanded: false,
      holdoffSeconds: 0.1,
      query: "",
    },
    rangePlacement: null,
    rangeMeasurements: [],
    timingMarkerPlacement: null,
    timingMarkers: [],
    notes: "",
  };
}

function highlightAnalyzerFrameInSession(
  session: UiSession,
  analyzerId: string,
  frameId: number | null,
) {
  let changed = false;
  const analyzers = session.analyzers.map((analyzer) => {
    const highlightedFrameIndex = analyzer.id === analyzerId ? frameId : null;
    if (analyzer.highlightedFrameIndex === highlightedFrameIndex) return analyzer;
    changed = true;
    return { ...analyzer, highlightedFrameIndex };
  });
  return changed ? { ...session, analyzers } : session;
}

function findAnalyzerRenderedTrackFrameById(
  analyzer: UiAnalyzerInstance,
  frameId: number,
): DecodedFrame | AnalyzerFrameRef | null {
  for (const track of analyzer.renderedTracks) {
    if (track.previous_frame_ref?.frame_id === frameId) return track.previous_frame_ref;
    if (track.previous_frame?.frame_id === frameId) return track.previous_frame;
    for (const frame of track.frame_refs ?? []) {
      if (frame.frame_id === frameId) return frame;
    }
    for (const frame of track.frames) {
      if (frame.frame_id === frameId) return frame;
    }
    if (track.next_frame_ref?.frame_id === frameId) return track.next_frame_ref;
    if (track.next_frame?.frame_id === frameId) return track.next_frame;
  }
  return null;
}

interface SidebarPanelAllowed {
  disabledReason?: string;
  isSelectable: boolean;
  isVisible: boolean;
}

function isMsoSession(session: UiSession | null | undefined) {
  if (!session) return false;
  const source = `${session.selectedDevice} ${session.summary?.metadata.source_device ?? ""}`.toLowerCase();
  return source.includes("mso") || source.includes("logic pro");
}

function getSidebarPanelAllowed(panel: SidebarPanel, session: UiSession | null | undefined): SidebarPanelAllowed {
  const hasActiveSession = Boolean(session);
  const isMso = isMsoSession(session);

  if (panel === "recordingSettings") {
    return {
      disabledReason: isMso ? undefined : "Recording Settings is available for Logic Pro / MSO sessions",
      isSelectable: hasActiveSession && isMso,
      isVisible: !hasActiveSession || isMso,
    };
  }

  if (panel === "cursors") {
    return {
      disabledReason: isMso ? undefined : "Cursors are available for Logic Pro / MSO sessions",
      isSelectable: hasActiveSession && isMso,
      isVisible: isMso,
    };
  }

  if (panel === "extensions") {
    return { isSelectable: true, isVisible: true };
  }

  return {
    disabledReason: hasActiveSession ? undefined : "Create or open a session first",
    isSelectable: hasActiveSession,
    isVisible: true,
  };
}

export default function App() {
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [deviceCapabilitiesById, setDeviceCapabilitiesById] = useState<Record<string, HardwareCaptureCapabilities>>({});
  const [draftSelectedDevice, setDraftSelectedDevice] = useState(DEFAULT_DEVICE_ID);
  const [sessions, setSessions] = useState<UiSession[]>([]);
  const [extensions, setExtensions] = useState<UiExtensionRecord[]>(loadUiExtensions);
  const [sigrokCatalog, setSigrokCatalog] = useState<SigrokDecoderCatalog | null>(null);
  const [saleaeCatalog, setSaleaeCatalog] = useState<SigrokDecoderCatalog | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [selectedPanel, setSelectedPanel] = useState<SidebarPanel | undefined>(undefined);
  const [sidebarPanelWidth, setSidebarPanelWidth] = useState(SIDEBAR_DEFAULT_WIDTH);
  const [footerPopover, setFooterPopover] = useState<FooterPopover>(null);
  const [editingChannel, setEditingChannel] = useState<number | null>(null);
  const [channelReorderActive, setChannelReorderActive] = useState(false);
  const [channelContextMenu, setChannelContextMenu] = useState<ChannelContextMenuState | null>(null);
  const [pendingChannelTrim, setPendingChannelTrim] = useState<PendingChannelTrim | null>(null);
  const [screenshotNotification, setScreenshotNotification] = useState<ScreenshotNotification | null>(null);
  const [screenshotSettings, setScreenshotSettings] = useState(loadScreenshotSettings);
  const [preferences, setPreferences] = useState(loadUiPreferences);
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const [analyzerInEdit, setAnalyzerInEdit] = useState<AnalyzerEditState | null>(null);
  const [graphViewportHeight, setGraphViewportHeight] = useState(0);
  const [graphRequestEpoch, setGraphRequestEpoch] = useState(0);
  const [analyzerRenderRequestEpoch, setAnalyzerRenderRequestEpoch] = useState(0);
  const [graphViewportInteracting, setGraphViewportInteracting] = useState(false);
  const graphPointerRatioRef = useRef(0.5);
  const [startupMessage, setStartupMessage] = useState("Ready");

  const footerRef = useRef<HTMLElement>(null);
  const graphScrollerRef = useRef<HTMLDivElement>(null);
  const channelContextMenuRef = useRef<HTMLDivElement>(null);
  const channelContextMenuSnapshotRef = useRef<ChannelContextMenuState | null>(null);
  const graphScrollFrameRef = useRef<number | null>(null);
  const pendingGraphScrollRef = useRef<{ sessionId: string; scrollTop: number } | null>(null);
  const sessionsRef = useRef<UiSession[]>([]);
  const activeSessionIdRef = useRef<string | null>(null);
  const captureSessionRef = useRef<string | null>(null);
  const pendingCaptureUiRef = useRef(new Map<string, PendingCaptureUiUpdate>());
  const captureUiFrameRef = useRef<number | null>(null);
  const sidebarShortcutRef = useRef<{ prefix: "m" | "n" | null; timeout: number | null }>({
    prefix: null,
    timeout: null,
  });
  const tileRequestSeq = useRef(0);
  const graphRequestInFlightRef = useRef(false);
  const graphRequestPendingRef = useRef(false);
  const graphRequestLastStartedAtRef = useRef(0);
  const analyzerRenderRequestSeq = useRef(0);
  const analyzerRenderRequestInFlightRef = useRef(false);
  const analyzerRenderRequestPendingRef = useRef(false);
  const analyzerRenderRequestLastStartedAtRef = useRef(0);
  const analyzerRenderRequestTimerRef = useRef<number | null>(null);
  const analyzerRenderRequestDirtyRef = useRef(false);
  const analyzerRequestSeq = useRef<Record<string, number>>({});
  const rangeMeasurementRequestSeq = useRef<Record<string, number>>({});
  const viewportAnimationRef = useRef<number | null>(null);
  const graphViewportInteractionSourcesRef = useRef(new Set<"animation" | "waveform">());
  const graphViewportInteractingRef = useRef(false);
  const lastPointerXRef = useRef<number | null>(null);
  const sessionCounter = useRef(1);
  const preparingDeviceIdsRef = useRef(new Set<string>());
  const screenshotInProgressRef = useRef(false);
  const preferencesRef = useRef(preferences);
  preferencesRef.current = preferences;

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  useEffect(() => {
    saveUiExtensions(extensions);
  }, [extensions]);

  useEffect(() => {
    persistScreenshotSettings(screenshotSettings);
  }, [screenshotSettings]);

  useEffect(() => {
    if (!screenshotNotification) return;
    const timeout = window.setTimeout(() => {
      setScreenshotNotification((current) =>
        current?.id === screenshotNotification.id ? null : current,
      );
    }, SCREENSHOT_NOTIFICATION_VISIBLE_MS);
    return () => window.clearTimeout(timeout);
  }, [screenshotNotification]);

  useEffect(() => {
    persistUiPreferences(preferences);
  }, [preferences]);

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  useEffect(() => {
    const rememberPointerPosition = (event: PointerEvent) => {
      lastPointerXRef.current = event.clientX;
    };
    document.addEventListener("pointermove", rememberPointerPosition, { passive: true });
    return () => document.removeEventListener("pointermove", rememberPointerPosition);
  }, []);

  useEffect(() => {
    function handleResize() {
      setSidebarPanelWidth((width) => clampSidebarPanelWidth(width));
    }
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  const activeSession = useMemo(
    () => sessions.find((session) => session.id === activeSessionId) ?? null,
    [activeSessionId, sessions],
  );

  useEffect(() => {
    const scroller = graphScrollerRef.current;
    if (!scroller || !activeSession) {
      setGraphViewportHeight(0);
      return;
    }

    const updateHeight = () => setGraphViewportHeight(Math.max(0, Math.floor(scroller.clientHeight)));
    const observer = new ResizeObserver(updateHeight);
    observer.observe(scroller);
    updateHeight();
    const frame = window.requestAnimationFrame(() => {
      scroller.scrollTop = activeSession.graphScrollTop;
    });
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [activeSession?.id]);

  // Only the channel label column scrolls the rows.
  //
  // The waveform column and every overlay layered over it — timing markers,
  // analyzer bubbles, range bands — sit inside this same scroll container, but the
  // waveform binds its wheel listener to the canvas host. A wheel that landed on an
  // overlay therefore reached neither of them: it bubbled to the scroller and moved
  // the rows instead of zooming. Zooming the time axis and scrolling the rows are
  // separate gestures and must not be reachable from the same place.
  //
  // The listener is native rather than `onWheel` because React attaches wheel at
  // the root as passive, where `preventDefault` does nothing.
  useEffect(() => {
    const scroller = graphScrollerRef.current;
    if (!scroller) return;

    const onWheel = (event: WheelEvent) => {
      const target = event.target as HTMLElement | null;
      // Over the label column: leave it alone so the rows scroll.
      if (target?.closest(".channelLabels")) return;
      // Anywhere else in the graph: the rows must not move.
      event.preventDefault();
      // The host already saw this one and zoomed. An overlay that swallowed it
      // instead gets the wheel handed on, so the gesture still zooms there.
      if (target?.closest(".waveformCanvasHost")) return;
      const host = scroller.querySelector<HTMLElement>(".waveformCanvasHost");
      if (!host) return;
      const source = event;
      host.dispatchEvent(new WheelEvent("wheel", {
        altKey: source.altKey,
        bubbles: true,
        cancelable: true,
        clientX: source.clientX,
        clientY: source.clientY,
        ctrlKey: source.ctrlKey,
        deltaMode: source.deltaMode,
        deltaX: source.deltaX,
        deltaY: source.deltaY,
        deltaZ: source.deltaZ,
        metaKey: source.metaKey,
        shiftKey: source.shiftKey,
      }));
    };

    scroller.addEventListener("wheel", onWheel, { passive: false });
    return () => scroller.removeEventListener("wheel", onWheel);
  }, [activeSession?.id]);

  useEffect(() => {
    return () => {
      if (graphScrollFrameRef.current !== null) {
        window.cancelAnimationFrame(graphScrollFrameRef.current);
      }
      if (viewportAnimationRef.current !== null) {
        window.cancelAnimationFrame(viewportAnimationRef.current);
      }
    };
  }, []);

  const selectedDevice = activeSession?.selectedDevice ?? draftSelectedDevice;
  const selected = useMemo(
    () => devices.find((device) => device.id === selectedDevice) ?? null,
    [devices, selectedDevice],
  );
  const selectedCapabilities = deviceCapabilitiesById[selectedDevice] ?? null;
  const capabilitiesForDevice = useCallback(
    (deviceId: string) => deviceCapabilitiesById[deviceId] ?? null,
    [deviceCapabilitiesById],
  );
  const availableAnalyzers = useMemo<AnalyzerLibraryChoice[]>(() => {
    const choices: AnalyzerLibraryChoice[] = [
      ...ANALYZER_CATALOG_GROUPS.flatMap((group) =>
        group.analyzers.map((name) => ({
          name,
          backend: group.backend,
          runnerStatus: group.runnerStatus,
          source: group.label,
        })),
      ),
      ...(sigrokCatalog?.decoders ?? [])
        .filter((item) => item.id || item.name || item.longname)
        .map((item) => ({
          backend: "sigrok_native" as const,
          catalogItem: item,
          description: [sigrokCatalogDetailName(item), item.desc?.trim()]
            .filter((part, index, parts) => part && parts.indexOf(part) === index)
            .join(" - ") || null,
          name: sigrokCatalogDisplayName(item),
          runnerStatus: item.runner_status,
          source: item.kind === "python" ? "Sigrok Python Decoders" : "Sigrok C Decoders",
        })),
      ...(saleaeCatalog?.decoders ?? [])
        .filter((item) => item.id || item.name || item.longname)
        .filter((item) => !["serial", "i2c", "spi", "i2s", "can", "lin", "simple_parallel"].includes(item.id ?? ""))
        .map((item) => ({
          backend: "saleae_native" as const,
          catalogItem: item,
          description: [sigrokCatalogDetailName(item), item.desc?.trim()]
            .filter((part, index, parts) => part && parts.indexOf(part) === index)
            .join(" - ") || null,
          name: sigrokCatalogDisplayName(item),
          runnerStatus: item.runner_status,
          source: "Saleae Native",
        })),
      ...extensions
        .filter((extension) => extension.installed && extension.enabled)
        .flatMap((extension) =>
          Object.entries(extension.manifest.extensions)
            .filter(([, feature]) => feature.type === "HighLevelAnalyzer")
            .map(([name]) => ({ name, backend: "legacy_rust" as const, source: "Extension" })),
        ),
    ];
    const seen = new Set<string>();
    return choices.filter((choice) => {
      const key = analyzerCatalogChoiceKey(choice);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [extensions, saleaeCatalog, sigrokCatalog]);

  const updateSession = useCallback((sessionId: string, updater: (session: UiSession) => UiSession) => {
    setSessions((current) => {
      let changed = false;
      const next = current.map((session) => {
        if (session.id !== sessionId) return session;
        const updated = updater(session);
        if (updated !== session) changed = true;
        return updated;
      });
      return changed ? next : current;
    });
  }, []);

  const queueCaptureUiUpdate = useCallback((sessionId: string, update: PendingCaptureUiUpdate) => {
    const pending = pendingCaptureUiRef.current;
    pending.set(sessionId, { ...pending.get(sessionId), ...update });
    if (captureUiFrameRef.current !== null) return;
    captureUiFrameRef.current = window.requestAnimationFrame(() => {
      captureUiFrameRef.current = null;
      const updates = new Map(pendingCaptureUiRef.current);
      pendingCaptureUiRef.current.clear();
      setSessions((current) =>
        current.map((session) => {
          const next = updates.get(session.id);
          if (!next) return session;
          let updated = session;
          if (next.progress) {
            const indexBytes = updated.memoryUsage?.index_bytes ?? 0;
            const analyzerBytes = updated.memoryUsage?.analyzer_bytes ?? 0;
            updated = {
              ...updated,
              progress: next.progress,
              memoryUsage: {
                buffer_bytes: updated.settings.buffer_size_mb * 1024 * 1024,
                sample_bytes: next.progress.sample_memory_bytes,
                index_bytes: indexBytes,
                analyzer_bytes: analyzerBytes,
                total_bytes: next.progress.sample_memory_bytes + indexBytes + analyzerBytes,
              },
            };
          }
          if (next.memoryUsage) updated = { ...updated, memoryUsage: next.memoryUsage };
          if (next.summary) updated = applyLiveCaptureSummary(updated, next.summary);
          return updated;
        }),
      );
    });
  }, []);

  const createSession = useCallback(
    (deviceId = draftSelectedDevice, source?: UiSession) => {
      const index = sessionCounter.current;
      sessionCounter.current += 1;
      const session = makeSession(`session-${Date.now()}-${index}`, `Session ${index}`, deviceId, source);
      setSessions((current) => [...current, session]);
      setActiveSessionId(session.id);
      return session;
    },
    [draftSelectedDevice],
  );

  const refreshDevices = useCallback(async () => {
    try {
      const next = await listDevices();
      setDevices(next);
      setDraftSelectedDevice((current) => (next.some((device) => device.id === current) ? current : next[0]?.id ?? current));
      setStartupMessage(`${next.length} device source${next.length === 1 ? "" : "s"}`);

      const physicalDevices = next.filter(
        (device) =>
          device.kind === "Usb" &&
          device.ready &&
          !preparingDeviceIdsRef.current.has(device.id),
      );
      if (physicalDevices.length > 0) {
        physicalDevices.forEach((device) => preparingDeviceIdsRef.current.add(device.id));
        setStartupMessage(
          `${next.length} device source${next.length === 1 ? "" : "s"}; preparing FPGA in background`,
        );
        void Promise.allSettled(physicalDevices.map((device) => prepareDevice(device.id))).then((results) => {
          physicalDevices.forEach((device) => preparingDeviceIdsRef.current.delete(device.id));
          const failure = results.find(
            (result): result is PromiseRejectedResult => result.status === "rejected",
          );
          if (failure) {
            setStartupMessage(`FPGA preparation failed: ${String(failure.reason)}`);
          } else {
            setStartupMessage(
              `${next.length} device source${next.length === 1 ? "" : "s"}; FPGA ready`,
            );
          }
        });
      }
    } catch (error) {
      setStartupMessage(String(error));
    }
  }, []);

  useEffect(() => {
    refreshDevices();
  }, [refreshDevices]);

  useEffect(() => {
    let cancelled = false;
    void sigrokDecoderCatalog()
      .then((catalog) => {
        if (cancelled) return;
        setSigrokCatalog(catalog);
        const total = catalog.decoders.length;
        setStartupMessage(
          (current) =>
            current === "Ready"
              ? total > 0
                ? `Loaded ${total} Sigrok decoder${total === 1 ? "" : "s"}`
                : "Sigrok decoder catalog is empty"
              : current,
        );
      })
      .catch((error) => {
        if (!cancelled) setStartupMessage(`Sigrok catalog: ${String(error)}`);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void saleaeDecoderCatalog()
      .then((catalog) => {
        if (!cancelled) setSaleaeCatalog(catalog);
      })
      .catch((error) => {
        if (!cancelled) setStartupMessage(`Saleae catalog: ${String(error)}`);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void deviceCapabilities(selectedDevice)
      .then((capabilities) => {
        if (cancelled) return;
        setDeviceCapabilitiesById((current) => ({
          ...current,
          [selectedDevice]: capabilities,
          [capabilities.device_id]: capabilities,
        }));
      })
      .catch((error) => {
        if (!cancelled) setStartupMessage(`Capabilities: ${String(error)}`);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedDevice, selected?.logic_mode, selected?.pid, selected?.usb_speed, selected?.vid]);

  useEffect(() => {
    if (!activeSession || !selectedCapabilities) return;
    updateSession(activeSession.id, (session) => {
      if (session.selectedDevice !== selectedDevice) return session;
      const nextSettings = clampCaptureSettingsToCapabilities(session.settings, selectedCapabilities);
      if (
        nextSettings.sample_rate_hz === session.settings.sample_rate_hz &&
        nextSettings.channel_count === session.settings.channel_count &&
        nextSettings.mode === session.settings.mode
      ) {
        return session;
      }
      const channelCountChanged = nextSettings.channel_count !== session.settings.channel_count;
      const digitalChannels = channelCountChanged
        ? makeDigitalChannels(nextSettings.channel_count)
        : session.deviceSettings.digitalChannels;
      return {
        ...session,
        channelLabels: channelCountChanged
          ? channelLabelsForCount(nextSettings.channel_count, session.channelLabels)
          : session.channelLabels,
        deviceSettings: {
          ...session.deviceSettings,
          digitalChannels,
          triggerChannel: Math.min(session.deviceSettings.triggerChannel, Math.max(0, nextSettings.channel_count - 1)),
        },
        settings: {
          ...nextSettings,
          enabled_channels: enabledChannelIndexes(digitalChannels, nextSettings.channel_count),
        },
      };
    });
  }, [activeSession?.id, selectedCapabilities, selectedDevice, updateSession]);

  useEffect(() => {
    function handlePointerDown(event: PointerEvent) {
      if (!footerRef.current?.contains(event.target as Node)) {
        setFooterPopover(null);
      }
      if (!channelContextMenuRef.current?.contains(event.target as Node)) {
        setChannelContextMenu(null);
      }
    }

    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, []);

  useEffect(() => {
    const subscriptions = [
      listen<CaptureProgress>("capture_progress", (event) => {
        const targetId = captureSessionRef.current;
        if (!targetId) return;
        queueCaptureUiUpdate(targetId, { progress: event.payload });
      }).catch(() => () => {}),
      listen<CaptureMemoryUpdatedEvent>("capture_memory_updated", (event) => {
        const { session_id: sessionId, usage } = event.payload;
        queueCaptureUiUpdate(sessionId, { memoryUsage: usage });
      }).catch(() => () => {}),
      listen<CaptureUpdatedEvent>("capture_updated", (event) => {
        const { session_id: sessionId, summary } = event.payload;
        queueCaptureUiUpdate(sessionId, { summary });
      }).catch(() => () => {}),
      listen<CaptureTriggeredEvent>("capture_triggered", (event) => {
        const { session_id: sessionId, trigger } = event.payload;
        updateSession(sessionId, (session) => applyCaptureTrigger(session, trigger));
      }).catch(() => () => {}),
      listen<CaptureSummary>("capture_completed", (event) => {
        const targetId = captureSessionRef.current;
        if (!targetId) return;
        pendingCaptureUiRef.current.delete(targetId);
        updateSession(targetId, (session) => {
          const syncedSession = syncSessionWithEffectiveCaptureMetadata(session, event.payload);
          const initialViewport = completedCaptureViewport(
            session,
            event.payload,
            preferencesRef.current.panToTrigger,
          );
          return {
            ...syncedSession,
            rangePlacement: null,
            timingMarkerPlacement: null,
            summary: summaryWithLabels(event.payload, syncedSession.channelLabels),
            ...initialViewport,
            cursorState: {
              ...defaultCursorState(event.payload.metadata.sample_count, event.payload.metadata.channel_count),
              visible: syncedSession.cursorState.visible,
            },
            analyzers: syncedSession.analyzers.map((analyzer) => ({
              ...analyzer,
              protocolBubbles: [],
              decodedFrameCount: 0,
              decodedFrames: [],
              decodedFramesComplete: false,
              decodedDecodeSignature: null,
              previousFrame: null,
              nextFrame: null,
              renderedTracks: [],
              renderedViewport: null,
              renderedDecodeSignature: null,
              renderBusy: false,
              renderProgress: 0,
              decodeBusy: false,
              decodeProgress: 0,
              highlightedFrameIndex: null,
            })),
            message: "Capture complete",
          };
        });
      }).catch(() => () => {}),
      listen<string>("capture_failed", (event) => {
        const targetId = captureSessionRef.current ?? activeSessionIdRef.current;
        if (!targetId) {
          setStartupMessage(event.payload);
          return;
        }
        pendingCaptureUiRef.current.delete(targetId);
        updateSession(targetId, (session) => ({ ...session, busy: false, message: event.payload }));
      }).catch(() => () => {}),
      listen<DiagnosticEvent>("usb_diagnostic", (event) => {
        const targetId = captureSessionRef.current ?? activeSessionIdRef.current;
        if (!targetId) return;
        updateSession(targetId, (session) => ({
          ...session,
          diagnostics: [...session.diagnostics.slice(-80), event.payload],
          message: `${event.payload.phase}: ${event.payload.message}`,
        }));
      }).catch(() => () => {}),
    ];
    return () => {
      if (captureUiFrameRef.current !== null) {
        window.cancelAnimationFrame(captureUiFrameRef.current);
        captureUiFrameRef.current = null;
      }
      pendingCaptureUiRef.current.clear();
      void Promise.all(subscriptions).then((unlisten) => unlisten.forEach((dispose) => dispose()));
    };
  }, [queueCaptureUiUpdate, updateSession]);

  const channelLabels = useMemo(
    () => {
      if (!activeSession) return channelLabelsForCount(16);
      return channelLabelsForCount(captureChannelLimit(activeSession), activeSession.channelLabels);
    },
    [
      activeSession?.channelLabels,
      activeSession?.deviceSettings.digitalChannels,
      activeSession?.hiddenDigitalChannels,
      activeSession?.settings.channel_count,
      activeSession?.summary?.metadata.channel_count,
    ],
  );
  const visibleChannelIndexes = useMemo(
    () => (activeSession ? visibleDigitalChannelIndexes(activeSession) : []),
    [
      activeSession?.channelOrder,
      activeSession?.deviceSettings.digitalChannels,
      activeSession?.hiddenDigitalChannels,
      activeSession?.settings.channel_count,
      activeSession?.summary?.metadata.channel_count,
    ],
  );
  const visibleChannelSignature = visibleChannelIndexes.join(",");
  // The frame loop re-reads these on every frame, so it must not close over a
  // render-scoped value: a channel visibility change would otherwise be frozen
  // into the loop for as long as the session lives.
  const visibleChannelIndexesRef = useRef(visibleChannelIndexes);
  visibleChannelIndexesRef.current = visibleChannelIndexes;
  const graphAnalyzerDecodeSignature =
    activeSession?.analyzers
      .map((analyzer) => `${analyzer.id}:${getAnalyzerDecodeSignature(analyzer)}:${analyzer.displayRadix}`)
      .join("|") ?? "";
  const visibleChannelLabels = useMemo(
    () => visibleChannelIndexes.map((channelIndex) => channelLabels[channelIndex] ?? `D${channelIndex}`),
    [channelLabels, visibleChannelIndexes],
  );
  const activePendingChannelTrim =
    pendingChannelTrim?.sessionId === activeSession?.id ? pendingChannelTrim : null;
  const contextMenuChannelRows = useMemo(
    () => {
      if (!activeSession) return [];
      const count = Math.max(32, captureChannelLimit(activeSession), activeSession.channelLabels.length);
      const labels = channelLabelsForCount(count, activeSession.channelLabels);
      return channelOrderForCount(count, activeSession.channelOrder)
        .filter((index) => isDigitalChannelEnabled(activeSession, index))
        .map((index) => ({
          index,
          isHidden: activeSession.hiddenDigitalChannels[index] ?? false,
          isSelectable: true,
          label: labels[index] ?? `D${index}`,
        }));
    },
    [activeSession],
  );
  const visibleChannelHeights = useMemo(
    () =>
      activeSession
        ? fitSaleaeDigitalRowsToViewport({
            availableHeight: graphViewportHeight,
            channelIndexes: visibleChannelIndexes,
            storedHeights: activeSession.channelHeights,
            manualLayout: activeSession.manualChannelLayout,
          })
        : [],
    [
      activeSession?.channelHeights,
      activeSession?.manualChannelLayout,
      graphViewportHeight,
      visibleChannelSignature,
    ],
  );
  const visibleAnalyzerInsets = useMemo(
    () =>
      activeSession
        ? visibleChannelIndexes.map((channelIndex) =>
            analyzerStripInsetForChannel(activeSession.analyzers, channelIndex),
          )
        : [],
    [activeSession?.analyzers, graphAnalyzerDecodeSignature, visibleChannelSignature],
  );
  const visibleOuterRowHeights = useMemo(
    () => visibleChannelHeights.map((height, index) => height + (visibleAnalyzerInsets[index] ?? 0)),
    [visibleAnalyzerInsets, visibleChannelHeights],
  );
  const visibleAnalogChannelEntries = useMemo(
    () => (activeSession ? enabledAnalogChannels(activeSession.deviceSettings.analogChannels) : []),
    [activeSession?.deviceSettings.analogChannels],
  );
  const visibleAnalogRowHeights = useMemo(
    () => visibleAnalogChannelEntries.map(({ settings }) => settings.height),
    [visibleAnalogChannelEntries],
  );
  const allVisibleRowHeights = useMemo(
    () => [...visibleOuterRowHeights, ...visibleAnalogRowHeights],
    [visibleAnalogRowHeights, visibleOuterRowHeights],
  );
  const visibleChannelLayouts = useMemo(
    () => getSaleaeGraphChannelLayout(visibleOuterRowHeights, visibleChannelIndexes.length),
    [visibleOuterRowHeights, visibleChannelIndexes.length],
  );
  const visibleAnalogLayouts = useMemo(
    () =>
      getSaleaeGraphChannelLayout(allVisibleRowHeights, allVisibleRowHeights.length).slice(
        visibleOuterRowHeights.length,
      ),
    [allVisibleRowHeights, visibleOuterRowHeights.length],
  );
  const visibleTile = useMemo(
    () => tileForVisibleChannels(activeSession?.tile ?? null, visibleChannelIndexes, channelLabels),
    [activeSession?.tile, channelLabels, visibleChannelIndexes],
  );
  const graphContentHeight = Math.max(graphViewportHeight, saleaeChannelContentHeight(allVisibleRowHeights));

  const totalSamples = activeSession?.summary?.metadata.sample_count ?? 0;
  const progressPercent =
    activeSession?.settings.mode === "Stream" && activeSession.memoryUsage && activeSession.memoryUsage.buffer_bytes > 0
      ? Math.min(100, (activeSession.memoryUsage.total_bytes / activeSession.memoryUsage.buffer_bytes) * 100)
      : activeSession?.progress && activeSession.progress.bytes_expected > 0
        ? Math.min(100, (activeSession.progress.bytes_read / activeSession.progress.bytes_expected) * 100)
        : 0;
  const activeSettings = activeSession?.settings ?? defaultSettings(selectedDevice);
  const activeMessage = activeSession?.message ?? startupMessage;

  useEffect(() => {
    if (channelContextMenu) {
      channelContextMenuSnapshotRef.current = channelContextMenu;
    }
  }, [channelContextMenu]);

  const updateViewport = useCallback(
    (sessionId: string, start: number, samples: number) => {
      updateSession(sessionId, (session) => {
        const sessionTotalSamples = session.summary?.metadata.sample_count ?? 0;
        if (!sessionTotalSamples) {
          return { ...session, viewportStart: 0, viewportSamples: 0 };
        }
        const minimumSamples = minimumViewportSamples(session.summary?.metadata.sample_rate_hz ?? 1);
        // Widen around the centre the view is *already* at, not around the centre
        // the request was computed from.
        //
        // The requested centre is anchor-derived, so it moves with the pointer.
        // Widening around it would hold the span at the floor while the start kept
        // following the anchor — which reads as "zooming turned into panning" every
        // time a key is held at the limit. The view is already at the floor by then,
        // so there is nothing to move.
        const currentCenter = session.viewportStart + session.viewportSamples / 2;
        const requestedSamples = Math.max(samples, minimumSamples);
        const requestedStart =
          samples >= minimumSamples ? start : currentCenter - minimumSamples / 2;
        const viewport = session.busy
          ? normalizeLiveCaptureViewport(
              requestedStart,
              requestedSamples,
              sessionTotalSamples,
              session.summary!.metadata.sample_rate_hz,
              session.viewportMaxSamples ?? undefined,
            )
          : normalizeCaptureViewport(
              requestedStart,
              requestedSamples,
              sessionTotalSamples,
              session.viewportMaxSamples ?? undefined,
            );
        return {
          ...session,
          // The last line of defence for the viewport. Every consumer downstream
          // assumes a finite pair: NaN in `viewportSamples` serialises to `null` in
          // the frame request (the backend rejects the whole frame and the graph
          // goes blank) and paints NaN into every width derived from the viewport,
          // the scrollbar included. Keeping the previous value is the least
          // surprising thing to do with a value that is not a number.
          viewportStart: Number.isFinite(viewport.start) ? viewport.start : session.viewportStart,
          viewportSamples: Number.isFinite(viewport.samples) ? viewport.samples : session.viewportSamples,
          liveViewportMode: session.busy ? "manual" : session.liveViewportMode,
        };
      });
    },
    [updateSession],
  );

  const setGraphViewportInteraction = useCallback(
    (source: "animation" | "waveform", active: boolean) => {
      const sources = graphViewportInteractionSourcesRef.current;
      const wasActive = sources.size > 0;
      if (source === "waveform" && active && viewportAnimationRef.current !== null) {
        window.cancelAnimationFrame(viewportAnimationRef.current);
        viewportAnimationRef.current = null;
        sources.delete("animation");
      }
      if (active) sources.add(source);
      else sources.delete(source);
      const isActive = sources.size > 0;
      graphViewportInteractingRef.current = isActive;
      if (wasActive !== isActive) setGraphViewportInteracting(isActive);
    },
    [],
  );

  const animateViewport = useCallback(
    (sessionId: string, start: number, samples: number, durationMs = 300) => {
      if (viewportAnimationRef.current !== null) {
        window.cancelAnimationFrame(viewportAnimationRef.current);
        // Clear the handle as well: leaving the cancelled id behind made later
        // calls cancel a dead frame, and any early return below used to keep the
        // stale handle alive.
        viewportAnimationRef.current = null;
      }
      const session = sessionsRef.current.find((item) => item.id === sessionId);
      const total = session?.summary?.metadata.sample_count ?? 0;
      if (!session || total <= 0) return;

      const target = session.busy
        ? normalizeLiveCaptureViewport(
            start,
            samples,
            total,
            session.summary!.metadata.sample_rate_hz,
            session.viewportMaxSamples ?? undefined,
          )
        : normalizeCaptureViewport(
            start,
            samples,
            total,
            session.viewportMaxSamples ?? undefined,
          );
      const targetSamples = target.samples;
      const targetStart = target.start;
      const initialStart = session.viewportStart;
      const initialSamples = session.viewportSamples;
      const startedAt = performance.now();
      setGraphViewportInteraction("animation", true);

      const step = (now: number) => {
        const progress = Math.max(0, Math.min(1, (now - startedAt) / durationMs));
        const eased = 1 - Math.pow(1 - progress, 3);
        updateViewport(
          sessionId,
          initialStart + (targetStart - initialStart) * eased,
          initialSamples + (targetSamples - initialSamples) * eased,
        );
        if (progress < 1) {
          viewportAnimationRef.current = window.requestAnimationFrame(step);
        } else {
          viewportAnimationRef.current = null;
          setGraphViewportInteraction("animation", false);
        }
      };

      viewportAnimationRef.current = window.requestAnimationFrame(step);
    },
    [setGraphViewportInteraction, updateViewport],
  );

  /**
   * Apply one discrete viewport step — a keypress — with the same glide a
   * physical wheel notch gets.
   *
   * A single hard step reads as a jump, which is why it is animated at all.
   * Continuous input (a touchpad stream) deliberately is not: it already updates
   * every frame, so interpolating each event would only fight itself. Logic 2
   * splits its zoom the same way and animates a physical wheel but not a touchpad.
   *
   * The backend owns view animations whenever a frame loop is wired, so the
   * intent goes there and the glide is interpolated against the same clock the
   * data is rendered with — the reason `apply_view_intent` exists. Without a loop
   * (the browser preview) the frontend runs the glide itself, with the same
   * duration so the two paths do not feel different.
   */
  const stepViewport = useCallback(
    (
      sessionId: string,
      intent: ViewIntent,
      fallbackStart: number,
      fallbackSamples: number,
    ) => {
      if (hasSessionFrameLoop(sessionId)) {
        dispatchSessionViewIntent(sessionId, intent);
        return;
      }
      animateViewport(sessionId, fallbackStart, fallbackSamples, ZOOM_ANIMATION_DURATION_MS);
    },
    [animateViewport],
  );

  const zoomViewport = useCallback(
    (factor: number) => {
      if (!activeSession?.summary) return;
      const anchor = activeSession.viewportStart + activeSession.viewportSamples / 2;
      const requestedSamples = activeSession.viewportSamples * factor;
      const nextSamples = activeSession.busy
        ? normalizeLiveCaptureViewport(
            activeSession.viewportStart,
            requestedSamples,
            activeSession.summary.metadata.sample_count,
            activeSession.summary.metadata.sample_rate_hz,
            activeSession.viewportMaxSamples ?? undefined,
          ).samples
        : normalizeCaptureViewport(
            activeSession.viewportStart,
            requestedSamples,
            activeSession.summary.metadata.sample_count,
            activeSession.viewportMaxSamples ?? undefined,
          ).samples;
      if (nextSamples === Math.round(activeSession.viewportSamples)) return;
      // While a capture is backend-driven the frame loop owns the viewport, and
      // the backend's `view` is authoritative. Writing the session store
      // directly is overwritten by the next frame, which is what made the zoom
      // buttons appear to do nothing or to fight the display. Dispatch the
      // intent, exactly as the keyboard path does.
      stepViewport(
        activeSession.id,
        { anchor_ratio: 0.5, duration_ms: ZOOM_ANIMATION_DURATION_MS, factor, kind: "zoom" },
        anchor - nextSamples / 2,
        nextSamples,
      );
    },
    [activeSession, stepViewport],
  );

  const fitViewport = useCallback(() => {
    if (!activeSession?.summary) return;
    updateViewport(activeSession.id, 0, activeSession.summary.metadata.sample_count);
  }, [activeSession, updateViewport]);

  // The backend-owned frame loop. One per session, created when a capture is
  // loaded and driven by requestAnimationFrame from then on — deliberately
  // outside React, because a pan or zoom frame must not re-render the workbench.
  useEffect(() => {
    if (!USE_BACKEND_FRAME_LOOP) return;
    const session = activeSession;
    if (!session?.summary) return;
    const sessionId = session.id;
    const currentSession = () => sessionsRef.current.find((item) => item.id === sessionId);

    ensureSessionFrameLoop(sessionId, {
      analyzers: () => {
        const live = currentSession();
        if (!live) return [];
        return live.analyzers.flatMap((analyzer) => {
          const settings = analyzerDecodeSettings(analyzer);
          if (!settings || !analyzerCanRunDecoder(analyzer)) return [];
          const tracks = analyzerTrackRequestsForAnalyzer(analyzer);
          if (tracks.length === 0) return [];
          return [
            {
              analyzer_id: analyzer.id,
              backend: analyzer.decoderBackend,
              settings,
              tracks,
            },
          ];
        });
      },
      channels: () => {
        const live = currentSession();
        return live ? visibleDigitalChannelIndexes(live) : [];
      },
      onError: (error) => {
        updateSession(sessionId, (current) => ({ ...current, message: String(error) }));
      },
      request: (intent, frameId, state) => {
        const live = currentSession();
        const channels = live ? visibleDigitalChannelIndexes(live) : [];
        // `pixels` is a CSS-pixel budget, matching what the tile pipeline used to
        // send: the canvas multiplies it by the device pixel ratio when it picks
        // a raster width. Sending device pixels here would make it do that twice.
        //
        // Guard the non-finite case: `Math.min(maxPixels, NaN)` is NaN, NaN
        // serialises to `null`, and the backend then rejects the entire frame with
        // `invalid type: null, expected u32`. That blanks the graph and nothing but
        // Fit Capture brings it back, so a bad measurement must not escape here.
        const measuredWidth = live?.canvasWidth;
        const cssWidth =
          typeof measuredWidth === "number" && Number.isFinite(measuredWidth)
            ? Math.max(1, Math.round(measuredWidth))
            : 1_000;
        const maxPixels = channels.length > 16 ? 1_800 : 2_600;
        const pixels = Math.max(1, Math.min(maxPixels, cssWidth));
        // Analyzer tracks ride along on the frame, exactly as they do in Logic.
        // That is what keeps the bubble aggregation in step with a zoom: the
        // backend aggregates for the viewport it is rendering, so the frontend
        // never draws bubbles merged for a scale the user has left behind.
        const analyzers = live
          ? live.analyzers.flatMap((analyzer) => {
              const settings = analyzerDecodeSettings(analyzer);
              if (!settings || !analyzerCanRunDecoder(analyzer)) return [];
              const tracks = analyzerTrackRequestsForAnalyzer(analyzer);
              if (tracks.length === 0) return [];
              return [
                {
                  analyzer_id: analyzer.id,
                  backend: analyzer.decoderBackend,
                  settings,
                  tracks,
                },
              ];
            })
          : [];
        // The range is a placeholder the backend replaces with the session
        // viewport, but it has to be *valid*: a backend build that predates the
        // intent protocol ignores `view` and renders this range, and an empty one
        // would be rejected outright. The last known viewport is the closest
        // thing to what we are about to ask for.
        //
        // Guarded for the same reason as `pixels` — a non-finite value serialises
        // to `null` and takes the whole frame down with it.
        const viewStart = state.ready && Number.isFinite(state.view.start_sample) ? state.view.start_sample : 0;
        const viewSamples = state.ready && Number.isFinite(state.view.samples) ? state.view.samples : 1;
        const rangeStart = Math.max(0, Math.floor(viewStart));
        const rangeSamples = Math.max(1, Math.ceil(viewStart + viewSamples) - rangeStart);
        return renderGraphFrame(sessionId, {
          frame_id: frameId,
          waveform: {
            start_sample: rangeStart,
            sample_count: rangeSamples,
            pixels,
            channels: channels.length > 0 ? channels : [255],
          },
          analyzer_view: null,
          analyzers,
          view: intent,
        });
      },
      widthPx: () => {
        const live = currentSession();
        const measured = live?.canvasWidth;
        return typeof measured === "number" && Number.isFinite(measured)
          ? Math.max(1, Math.round(measured))
          : 1_000;
      },
    });
    return () => releaseSessionFrameLoop(sessionId);
  }, [
    activeSession?.id,
    activeSession?.summary?.metadata.captured_at,
    updateSession,
  ]);

  // A live capture keeps producing samples, so the loop must keep asking, and
  // the backend has to know it is live: that is what makes it follow a fixed
  // window at the tail instead of fitting the whole capture on every frame.
  const previousSessionBusyRef = useRef(false);
  useEffect(() => {
    if (!USE_BACKEND_FRAME_LOOP) return;
    const session = activeSession;
    if (!session?.id || !session.summary) return;
    setSessionFrameLive(session.id, session.busy);
    void setGraphViewLimits(session.id, {
      live: session.busy,
      maximum_samples: session.viewportMaxSamples ?? null,
      sample_rate_hz: session.summary.metadata.sample_rate_hz,
    }).catch(() => {
      // The loop's own failure handling covers this; the limits are a hint.
    });
    if (previousSessionBusyRef.current && !session.busy) {
      // Leaving follow mode must not snap back to the start of the capture, so
      // pin the viewport the user was already looking at.
      const state = readFrameState(session.id);
      if (state?.ready) {
        dispatchSessionViewIntent(session.id, {
          kind: "set",
          samples: state.view.samples,
          start_sample: state.view.start_sample,
        });
      }
    }
    previousSessionBusyRef.current = session.busy;
  }, [activeSession?.busy, activeSession?.id, activeSession?.summary, activeSession?.viewportMaxSamples]);

  // Circuit breaker. The backend frame loop replaces the tile pipeline, so if it
  // stops producing usable frames the graph would have no other source. When the
  // loop reports repeated failures the workbench tears it down and the old
  // pipeline takes over again on the next render.
  const [frameLoopHealthy, setFrameLoopHealthy] = useState(false);
  useEffect(() => {
    if (!USE_BACKEND_FRAME_LOOP) return;
    const sessionId = activeSession?.id;
    if (!sessionId || !activeSession?.summary) return;
    setFrameLoopHealthy(readFrameHealth(sessionId));
    return subscribeFrameHealth(sessionId, setFrameLoopHealthy);
  }, [activeSession?.id, activeSession?.summary]);

  useEffect(() => {
    if (!USE_BACKEND_FRAME_LOOP) return;
    const sessionId = activeSession?.id;
    if (!sessionId || frameLoopHealthy) return;
    releaseSessionFrameLoop(sessionId);
  }, [activeSession?.id, frameLoopHealthy]);

  // Channel selection and layout changes do not move the viewport, but they do
  // change what a frame contains, so the loop needs a nudge.
  useEffect(() => {
    if (!USE_BACKEND_FRAME_LOOP) return;
    if (!activeSession?.id) return;
    invalidateSessionFrame(activeSession.id);
  }, [activeSession?.id, visibleChannelSignature]);

  useEffect(() => {
    if (USE_BACKEND_FRAME_LOOP && frameLoopHealthy) {
      // The backend frame loop owns the waveform end to end; running this
      // pipeline alongside it would only issue a second set of requests.
      tileRequestSeq.current += 1;
      return;
    }
    if (!activeSession?.summary) {
      tileRequestSeq.current += 1;
      return;
    }

    const sessionSnapshot = activeSession;
    if (
      !sessionSnapshot.busy &&
      graphTileCanServeViewport(
        sessionSnapshot.tile,
        sessionSnapshot.viewportStart,
        sessionSnapshot.viewportSamples,
        sessionSnapshot.summary!.metadata.sample_count,
        sessionSnapshot.canvasWidth,
        visibleChannelIndexes,
      )
    ) {
      return;
    }

    const requestSeq = tileRequestSeq.current + 1;
    tileRequestSeq.current = requestSeq;
    // Live viewport movement is interpolated by WaveformCanvas. A 20 Hz
    // latest-only tile cadence leaves the main thread enough time to paint and
    // mirrors Logic's preference for dropping stale backend frames.
    const minimumRequestIntervalMs = sessionSnapshot.busy ? 50 : 24;
    const requestDelay = Math.max(
      0,
      minimumRequestIntervalMs - (performance.now() - graphRequestLastStartedAtRef.current),
    );
    const requestTimer = window.setTimeout(() => {
      if (graphRequestInFlightRef.current) {
        graphRequestPendingRef.current = true;
        return;
      }
      graphRequestInFlightRef.current = true;
      graphRequestLastStartedAtRef.current = performance.now();
      void (async () => {
      try {
        const overscan = Math.max(64, Math.ceil(sessionSnapshot.viewportSamples * 0.5));
        // Viewport coordinates are fractional so a marker can remain exactly
        // under the zoom anchor. Graph requests target integer samples only.
        const requestStart = Math.max(0, Math.floor(sessionSnapshot.viewportStart - overscan));
        const requestEnd = Math.min(
          sessionSnapshot.summary!.metadata.sample_count,
          Math.ceil(sessionSnapshot.viewportStart + sessionSnapshot.viewportSamples + overscan),
        );
        const requestSamples = Math.max(1, requestEnd - requestStart);
        const pixelScale = requestSamples / Math.max(1, sessionSnapshot.viewportSamples);
        const maxPixels = visibleChannelIndexes.length > 16 ? 1800 : 2600;
        const renderPixels = Math.max(
          1,
          Math.min(maxPixels, Math.round(sessionSnapshot.canvasWidth * pixelScale)),
        );
        const next = await renderGraphFrame(sessionSnapshot.id, {
          frame_id: requestSeq,
          waveform: {
            start_sample: requestStart,
            sample_count: requestSamples,
            pixels: renderPixels,
            channels: visibleChannelIndexes.length > 0 ? visibleChannelIndexes : [255],
          },
          analyzer_view: null,
          analyzers: [],
        });
        const latestSession = sessionsRef.current.find((session) => session.id === sessionSnapshot.id);
        const latestVisibleChannels = latestSession
          ? visibleDigitalChannelIndexes(latestSession)
          : [];
        const canServeLatestViewport =
          latestSession != null &&
          activeSessionIdRef.current === sessionSnapshot.id &&
          next.frame_id === requestSeq &&
          latestVisibleChannels.length > 0 &&
          graphTileCanServeViewport(
            next.tile,
            latestSession.viewportStart,
            latestSession.viewportSamples,
            latestSession.summary!.metadata.sample_count,
            latestSession.canvasWidth,
            latestVisibleChannels,
          );
        if (canServeLatestViewport) {
          updateSession(sessionSnapshot.id, (session) => ({
            ...session,
            tile: {
              ...next.tile,
              channels: next.tile.channels.map((channel) => ({
                ...channel,
                label: session.channelLabels[channel.channel] ?? channel.label,
              })),
            },
          }));
        }
      } catch (error) {
        if (requestSeq === tileRequestSeq.current) {
          updateSession(sessionSnapshot.id, (session) => ({ ...session, message: String(error) }));
        }
      } finally {
        graphRequestInFlightRef.current = false;
        if (graphRequestPendingRef.current) {
          graphRequestPendingRef.current = false;
          setGraphRequestEpoch((epoch) => epoch + 1);
        }
      }
      })();
    }, requestDelay);
    return () => window.clearTimeout(requestTimer);
  }, [
    activeSession?.canvasWidth,
    activeSession?.busy,
    activeSession?.id,
    activeSession?.summary?.metadata.captured_at,
    activeSession?.summary?.metadata.sample_count,
    activeSession?.viewportSamples,
    activeSession?.viewportStart,
    graphRequestEpoch,
    frameLoopHealthy,
    updateSession,
    visibleChannelSignature,
  ]);

  useEffect(() => {
    if (USE_BACKEND_FRAME_LOOP && frameLoopHealthy) {
      // Analyzer tracks now ride along on each frame, already aggregated for the
      // viewport that frame rendered. Running this pipeline alongside it would
      // render every analyzer twice per cycle.
      analyzerRenderRequestSeq.current += 1;
      analyzerRenderRequestDirtyRef.current = false;
      return;
    }
    if (!activeSession?.summary) {
      analyzerRenderRequestSeq.current += 1;
      analyzerRenderRequestDirtyRef.current = false;
      return;
    }
    if (!activeSession.analyzers.some(analyzerCanRunDecoder)) {
      analyzerRenderRequestSeq.current += 1;
      analyzerRenderRequestDirtyRef.current = false;
      return;
    }

    analyzerRenderRequestDirtyRef.current = true;
    if (analyzerRenderRequestInFlightRef.current) {
      if (graphViewportInteracting) analyzerRenderRequestSeq.current += 1;
      analyzerRenderRequestPendingRef.current = true;
      return;
    }
    if (analyzerRenderRequestTimerRef.current !== null) return;

    const minimumRequestIntervalMs = analyzerRenderRequestIntervalMs(
      graphViewportInteracting,
      activeSession.busy,
    );
    const requestDelay = Math.max(
      0,
      minimumRequestIntervalMs -
        (performance.now() - analyzerRenderRequestLastStartedAtRef.current),
    );
    analyzerRenderRequestTimerRef.current = window.setTimeout(() => {
      analyzerRenderRequestTimerRef.current = null;
      if (analyzerRenderRequestInFlightRef.current) {
        analyzerRenderRequestPendingRef.current = true;
        return;
      }

      const sessionSnapshot = sessionsRef.current.find(
        (session) => session.id === activeSessionIdRef.current,
      );
      if (!sessionSnapshot?.summary) return;
      const overscan = Math.max(64, Math.ceil(sessionSnapshot.viewportSamples * 0.5));
      const requestStart = Math.max(0, Math.floor(sessionSnapshot.viewportStart - overscan));
      const requestEnd = Math.min(
        sessionSnapshot.summary.metadata.sample_count,
        Math.ceil(sessionSnapshot.viewportStart + sessionSnapshot.viewportSamples + overscan),
      );
      const requestSamples = Math.max(1, requestEnd - requestStart);
      const pixelScale = requestSamples / Math.max(1, sessionSnapshot.viewportSamples);
      const renderPixels = Math.max(
        1,
        Math.min(2_600, Math.round(sessionSnapshot.canvasWidth * pixelScale)),
      );
      const requestedAnalyzerViewport = {
        pixels: renderPixels,
        sampleCount: requestSamples,
        startSample: requestStart,
      };
      const analyzerRequestItems = sessionSnapshot.analyzers.flatMap((analyzer) => {
        const settings = analyzerDecodeSettings(analyzer);
        if (!settings || !analyzerCanRunDecoder(analyzer)) return [];
        const tracks = analyzerTrackRequestsForAnalyzer(analyzer);
        if (tracks.length === 0) return [];
        const signature = getAnalyzerDecodeSignature(analyzer);
        return [
          {
            analyzer,
            request: {
              analyzer_id: analyzer.id,
              backend: analyzer.decoderBackend,
              settings,
              tracks,
            },
            signature,
          },
        ];
      });
      const analyzerRequests = analyzerRequestItems.map((item) => item.request);
      if (analyzerRequests.length === 0) return;
      const analyzerRequestItemsById = new Map(
        analyzerRequestItems.map((item) => [item.analyzer.id, item]),
      );
      const requestDecodeSignatures = new Map(
        analyzerRequestItems.map((item) => [item.analyzer.id, item.signature]),
      );
      const localAnalyzerIds = new Set<string>();
      const localAnalyzerResults: Array<{ analyzer_id: string; tracks: AnalyzerTrackWindow[] }> = [];
      const backendAnalyzerRequests = [];
      const localRenderStartedAt = performance.now();
      let localTrackCount = 0;
      let servedAnalyzerCount = 0;
      for (const { analyzer, request, signature } of analyzerRequestItems) {
        if (
          analyzer.renderedDecodeSignature === signature &&
          analyzer.renderedViewport &&
          analyzerRenderedTracksMatchRequests(analyzer.renderedTracks, request.tracks) &&
          analyzerRenderViewportCanServe(
            analyzer.renderedViewport,
            requestedAnalyzerViewport,
            sessionSnapshot.busy,
            {
              sampleCount: sessionSnapshot.summary.metadata.sample_count,
              startSample: 0,
            },
          )
        ) {
          servedAnalyzerCount += 1;
          continue;
        }
        if (
          analyzerCanRenderTracksLocally(analyzer, signature, sessionSnapshot.busy) &&
          !isTauriRuntime()
        ) {
          localTrackCount += request.tracks.length;
          localAnalyzerIds.add(analyzer.id);
          localAnalyzerResults.push({
            analyzer_id: analyzer.id,
            tracks: request.tracks.map((track) =>
              buildLocalAnalyzerTrackWindow(
                analyzer.decodedFrames,
                track,
                requestStart,
                requestSamples,
                renderPixels,
              ),
            ),
          });
        } else {
          backendAnalyzerRequests.push(request);
        }
      }
      if (localTrackCount > 0) {
        traceAnalyzerPerformance(
          "local_track_window",
          localRenderStartedAt,
          `analyzers=${localAnalyzerResults.length} tracks=${localTrackCount}`,
        );
      }
      if (localAnalyzerResults.length === 0 && backendAnalyzerRequests.length === 0) {
        analyzerRenderRequestDirtyRef.current = servedAnalyzerCount !== analyzerRequests.length;
        return;
      }

      analyzerRenderRequestDirtyRef.current = false;
      analyzerRenderRequestInFlightRef.current = true;
      analyzerRenderRequestLastStartedAtRef.current = performance.now();
      const requestSeq = analyzerRenderRequestSeq.current + 1;
      analyzerRenderRequestSeq.current = requestSeq;
      const pendingRenderAnalyzerIds = new Set(
        backendAnalyzerRequests
          .map((request) => analyzerRequestItemsById.get(request.analyzer_id))
          .filter((item): item is (typeof analyzerRequestItems)[number] =>
            Boolean(
              item &&
                item.analyzer.renderedDecodeSignature !== item.signature,
            ),
          )
          .map((item) => item.analyzer.id),
      );
      if (pendingRenderAnalyzerIds.size > 0) {
        updateSession(sessionSnapshot.id, (session) => ({
          ...session,
          analyzers: session.analyzers.map((analyzer) =>
            pendingRenderAnalyzerIds.has(analyzer.id)
              ? {
                  ...analyzer,
                  renderBusy: true,
                  renderProgress: Math.max(5, Math.min(94, analyzer.renderProgress)),
                }
              : analyzer,
          ),
        }));
      }
      const renderStartedAt = performance.now();
      const renderProgressTimer =
        pendingRenderAnalyzerIds.size > 0
          ? window.setInterval(() => {
              const elapsed = performance.now() - renderStartedAt;
              // The native analyzer is a batch API. Keep the UI moving while
              // it is working, then only show the checkmark after the result
              // has been committed.
              const progress = Math.min(94, 8 + 86 * (1 - Math.exp(-elapsed / 2_400)));
              updateSession(sessionSnapshot.id, (session) => ({
                ...session,
                analyzers: session.analyzers.map((analyzer) =>
                  pendingRenderAnalyzerIds.has(analyzer.id) && analyzer.renderBusy
                    ? { ...analyzer, renderProgress: Math.max(analyzer.renderProgress, progress) }
                    : analyzer,
                ),
              }));
            }, 100)
          : null;
      void (async () => {
        try {
          let backendAnalyzerResults: Array<{ analyzer_id: string; tracks: AnalyzerTrackWindow[] }> = [];
          if (backendAnalyzerRequests.length > 0) {
            const next = await renderGraphFrame(sessionSnapshot.id, {
              frame_id: requestSeq,
              waveform: {
                start_sample: requestStart,
                sample_count: requestSamples,
                pixels: renderPixels,
                channels: [255],
              },
              include_tile: false,
              analyzer_view: {
                start_sample: requestStart,
                sample_count: requestSamples,
                pixels: renderPixels,
                channels: [],
              },
              analyzers: backendAnalyzerRequests,
            });
            if (next.frame_id !== requestSeq) return;
            backendAnalyzerResults = next.analyzers;
          }
          if (
            requestSeq === analyzerRenderRequestSeq.current &&
            activeSessionIdRef.current === sessionSnapshot.id
          ) {
            const commitStarted = performance.now();
            const analyzerResults = new Map(
              [...localAnalyzerResults, ...backendAnalyzerResults].map((result) => [
                result.analyzer_id,
                result,
              ]),
            );
            const requestedTrackCounts = new Map(
              analyzerRequests.map((request) => [request.analyzer_id, request.tracks.length]),
            );
            updateSession(sessionSnapshot.id, (session) => {
              const nextAnalyzers = session.analyzers.map((analyzer) => {
                const result = analyzerResults.get(analyzer.id);
                if (!result) return analyzer;
                const requestedTrackCount = requestedTrackCounts.get(analyzer.id) ?? 0;
                const incomingTracks =
                  result.tracks.length === 0 && requestedTrackCount > 0
                    ? analyzer.renderedTracks
                    : result.tracks;
                const preservedTracks = session.busy
                  ? preserveLiveAnalyzerTracks(analyzer.renderedTracks, incomingTracks)
                  : incomingTracks;
                const renderedTracks = reuseAnalyzerTrackWindows(analyzer.renderedTracks, preservedTracks);
                const decodedFrames = localAnalyzerIds.has(analyzer.id)
                  ? analyzer.decodedFrames
                  : mergeAnalyzerTrackFrames(
                      analyzer.decodedFrames,
                      incomingTracks,
                      ANALYZER_RENDERED_FRAME_CACHE_LIMIT,
                    );
                const renderedDecodeSignature =
                  requestDecodeSignatures.get(analyzer.id) ?? analyzer.renderedDecodeSignature;
                const renderedViewport =
                  analyzerResults.has(analyzer.id)
                    ? requestedAnalyzerViewport
                    : analyzer.renderedViewport;
                const renderBusy = pendingRenderAnalyzerIds.has(analyzer.id)
                  ? false
                  : analyzer.renderBusy;
                const renderProgress = pendingRenderAnalyzerIds.has(analyzer.id)
                  ? 100
                  : analyzer.renderProgress;
                if (
                  decodedFrames === analyzer.decodedFrames &&
                  renderedTracks === analyzer.renderedTracks &&
                  renderedDecodeSignature === analyzer.renderedDecodeSignature &&
                  renderedViewport === analyzer.renderedViewport &&
                  renderBusy === analyzer.renderBusy &&
                  renderProgress === analyzer.renderProgress
                ) {
                  return analyzer;
                }
                return {
                  ...analyzer,
                  decodedFrames,
                  renderedTracks,
                  renderedDecodeSignature,
                  renderedViewport,
                  renderBusy,
                  renderProgress,
                };
              });
              const changedAnalyzerCount = nextAnalyzers.reduce(
                (count, analyzer, index) => count + (analyzer === session.analyzers[index] ? 0 : 1),
                0,
              );
              traceAnalyzerPerformance(
                "state_commit",
                commitStarted,
                `analyzers=${nextAnalyzers.length} changed=${changedAnalyzerCount}`,
              );
              if (changedAnalyzerCount === 0) return session;
              return { ...session, analyzers: nextAnalyzers };
            });
          }
        } catch (error) {
          if (requestSeq === analyzerRenderRequestSeq.current) {
            updateSession(sessionSnapshot.id, (session) => ({
              ...session,
              analyzers: session.analyzers.map((analyzer) =>
                pendingRenderAnalyzerIds.has(analyzer.id)
                  ? { ...analyzer, renderBusy: false, renderProgress: 0 }
                  : analyzer,
              ),
              message: String(error),
            }));
          }
        } finally {
          if (renderProgressTimer !== null) window.clearInterval(renderProgressTimer);
          analyzerRenderRequestInFlightRef.current = false;
          if (
            analyzerRenderRequestPendingRef.current ||
            analyzerRenderRequestDirtyRef.current
          ) {
            analyzerRenderRequestPendingRef.current = false;
            setAnalyzerRenderRequestEpoch((epoch) => epoch + 1);
          }
        }
      })();
    }, requestDelay);
  }, [
    activeSession?.busy,
    activeSession?.canvasWidth,
    activeSession?.id,
    activeSession?.summary?.metadata.captured_at,
    activeSession?.summary?.metadata.sample_count,
    activeSession?.viewportSamples,
    activeSession?.viewportStart,
    analyzerRenderRequestEpoch,
    frameLoopHealthy,
    graphAnalyzerDecodeSignature,
    graphViewportInteracting,
    updateSession,
  ]);

  useEffect(() => {
    return () => {
      if (analyzerRenderRequestTimerRef.current !== null) {
        window.clearTimeout(analyzerRenderRequestTimerRef.current);
      }
      analyzerRenderRequestSeq.current += 1;
    };
  }, []);

  const rangeMeasurementSignature =
    activeSession?.rangeMeasurements
      .map((range) => `${range.id}:${range.channelIndex}:${range.startSample}:${range.endSample}`)
      .join("|") ?? "";

  useEffect(() => {
    if (!activeSession?.summary || activeSession.rangeMeasurements.length === 0) return;
    const sessionSnapshot = activeSession;
    const timeout = window.setTimeout(() => {
      sessionSnapshot.rangeMeasurements.forEach((range) => {
        const statsKey = [
          sessionSnapshot.summary!.metadata.captured_at,
          sessionSnapshot.summary!.metadata.sample_count,
          range.channelIndex,
          range.startSample,
          range.endSample,
        ].join(":");
        if (range.measurementStatsKey === statsKey && range.measurementStats && !range.measurementError) {
          return;
        }

        const requestKey = `${sessionSnapshot.id}:${range.id}`;
        const requestSeq = (rangeMeasurementRequestSeq.current[requestKey] ?? 0) + 1;
        rangeMeasurementRequestSeq.current[requestKey] = requestSeq;
        updateSession(sessionSnapshot.id, (current) => ({
          ...current,
          rangeMeasurements: current.rangeMeasurements.map((item) =>
            item.id === range.id
              ? {
                  ...item,
                  measurementError: null,
                  measurementStatsBusy: true,
                  measurements: ensureRangeMeasurementIds(item.measurements),
                }
              : item,
          ),
        }));

        void measureDigitalRange(sessionSnapshot.id, {
          channel: range.channelIndex,
          start_sample: range.startSample,
          end_sample: range.endSample,
        })
          .then((stats) => {
            if (requestSeq !== rangeMeasurementRequestSeq.current[requestKey]) return;
            updateSession(sessionSnapshot.id, (current) => ({
              ...current,
              rangeMeasurements: current.rangeMeasurements.map((item) =>
                item.id === range.id
                  ? {
                      ...item,
                      measurementError: null,
                      measurementStats: stats,
                      measurementStatsBusy: false,
                      measurementStatsKey: statsKey,
                      measurements: ensureRangeMeasurementIds(item.measurements),
                    }
                  : item,
              ),
            }));
          })
          .catch((error) => {
            if (requestSeq !== rangeMeasurementRequestSeq.current[requestKey]) return;
            updateSession(sessionSnapshot.id, (current) => ({
              ...current,
              rangeMeasurements: current.rangeMeasurements.map((item) =>
                item.id === range.id
                  ? {
                      ...item,
                      measurementError: String(error),
                      measurementStatsBusy: false,
                      measurementStatsKey: statsKey,
                    }
                  : item,
              ),
            }));
          });
      });
    }, 45);
    return () => window.clearTimeout(timeout);
  }, [
    activeSession?.id,
    activeSession?.summary?.metadata.captured_at,
    activeSession?.summary?.metadata.sample_count,
    rangeMeasurementSignature,
    updateSession,
  ]);

  async function runCaptureForSession(session: UiSession, deviceId: string) {
    if (session.readOnly) {
      updateSession(session.id, (current) => ({
        ...current,
        message: "Opened capture cannot be overwritten. Create a new session to start capturing data.",
      }));
      return;
    }
    const captureDevice = devices.find((device) => device.id === deviceId) ?? selected;
    const nextSettings = clampCaptureSettingsToCapabilities(
      settingsFromDeviceSettings(session, deviceId),
      capabilitiesForDevice(deviceId),
    );
    if (nextSettings.enabled_channels.length === 0) {
      updateSession(session.id, (current) => ({
        ...current,
        message: "Enable at least one digital channel before starting capture",
      }));
      return;
    }
    captureSessionRef.current = session.id;
    setDraftSelectedDevice(deviceId);
    updateSession(session.id, (current) => ({
      ...current,
      selectedDevice: deviceId,
      settings: nextSettings,
      busy: true,
      // Carry the user's zoom into the next capture in this session.
      //
      // Saleae's free-run/timer preset does the same thing ("ZoomOnly"): the time
      // scale survives a re-capture and only the pan is reset. Two details matter
      // here. `liveViewportMode` has to come along too, because otherwise
      // applyLiveCaptureSummary recomputes the default window from
      // `defaultCaptureViewportSamples` and silently discards the zoom we just
      // kept. And the zoom is only carried when the session already holds a
      // capture — on a first capture there is no user intent to preserve.
      liveViewportMode: current.summary ? "manual" : "auto",
      viewportStart: 0,
      viewportSamples: current.summary ? current.viewportSamples : 1,
      viewportMaxSamples: null,
      progress: null,
      memoryUsage: {
        buffer_bytes: nextSettings.buffer_size_mb * 1024 * 1024,
        sample_bytes: 0,
        index_bytes: 0,
        analyzer_bytes: 0,
        total_bytes: 0,
      },
      rangePlacement: null,
      rangeMeasurements: [],
      timingMarkerPlacement: null,
      timingMarkers: [],
      analyzers: current.analyzers.map((analyzer) => ({
        ...analyzer,
        protocolBubbles: [],
        decodedFrameCount: 0,
        decodedFrames: [],
        decodedFramesComplete: false,
        decodedDecodeSignature: null,
        previousFrame: null,
        nextFrame: null,
        renderedTracks: [],
        renderedViewport: null,
        renderedDecodeSignature: null,
        renderBusy: false,
        renderProgress: 0,
        decodeBusy: false,
        decodeProgress: 0,
        highlightedFrameIndex: null,
      })),
      diagnostics: [],
      message:
        nextSettings.trigger_enabled && captureDevice?.kind === "Usb"
          ? `Preparing device; waiting for ${nextSettings.trigger_kind.toLowerCase()} trigger on D${nextSettings.trigger_channel}`
          : captureDevice?.kind === "Usb"
            ? "Preparing device and capturing"
            : "Capturing",
    }));
    try {
      const demoAnalyzers = session.analyzers
        .filter(analyzerCanRunDecoder)
        .flatMap((analyzer) => {
          const settings = analyzerDecodeSettings(analyzer);
          return settings === null ? [] : [{ backend: analyzer.decoderBackend, settings }];
        });
      const next = await startCapture(
        session.id,
        nextSettings,
        {
          onProgress: (progress) => {
            queueCaptureUiUpdate(session.id, { progress });
          },
          onSummary: (summary) => {
            queueCaptureUiUpdate(session.id, { summary });
          },
          onTrigger: (trigger) => {
            updateSession(session.id, (current) => applyCaptureTrigger(current, trigger));
          },
        },
        demoAnalyzers,
      );
      pendingCaptureUiRef.current.delete(session.id);
      updateSession(session.id, (current) => {
        const completedViewport = completedCaptureViewport(
          current,
          next,
          preferencesRef.current.panToTrigger,
        );
        return {
          ...applyLiveCaptureSummary(current, next),
          ...completedViewport,
          cursorState: {
            ...defaultCursorState(next.metadata.sample_count, next.metadata.channel_count),
            visible: current.cursorState.visible,
          },
          analyzers: current.analyzers.map((analyzer) => ({
            ...analyzer,
            protocolBubbles: [],
            decodedFrameCount: 0,
            decodedFrames: [],
            decodedFramesComplete: false,
            decodedDecodeSignature: null,
            previousFrame: null,
            nextFrame: null,
            renderedTracks: [],
            renderedViewport: null,
            renderedDecodeSignature: null,
            renderBusy: false,
            renderProgress: 0,
            decodeBusy: false,
            decodeProgress: 0,
            highlightedFrameIndex: null,
          })),
          message: "Capture complete",
        };
      });
    } catch (error) {
      pendingCaptureUiRef.current.delete(session.id);
      updateSession(session.id, (current) => ({ ...current, message: String(error) }));
    } finally {
      updateSession(session.id, (current) => ({ ...current, busy: false }));
      if (captureSessionRef.current === session.id) {
        captureSessionRef.current = null;
      }
    }
  }

  async function handleCapture() {
    const session = activeSession ?? createSession(selectedDevice);
    await runCaptureForSession(session, session.selectedDevice);
  }

  async function handleStartWithDevice(deviceId: string) {
    const session = activeSession ?? createSession(deviceId);
    await runCaptureForSession({ ...session, selectedDevice: deviceId, settings: { ...session.settings, device_id: deviceId } }, deviceId);
  }

  async function handleDecodeAnalyzer(sessionId: string, analyzerId: string, silent = false) {
    const session = sessionsRef.current.find((item) => item.id === sessionId);
    const analyzer = session?.analyzers.find((item) => item.id === analyzerId);
    if (!session?.summary || !analyzer || !analyzerCanRunDecoder(analyzer)) return;
    const settings = analyzerDecodeSettings(analyzer);
    if (!settings) return;
    const requestKey = `${sessionId}:${analyzerId}`;
    const requestSeq = (analyzerRequestSeq.current[requestKey] ?? 0) + 1;
    analyzerRequestSeq.current[requestKey] = requestSeq;
    const decodeStartedAt = performance.now();
    const decodeProgressTimer = window.setInterval(() => {
      const elapsed = performance.now() - decodeStartedAt;
      const progress = Math.min(94, 6 + 88 * (1 - Math.exp(-elapsed / 2_000)));
      const current = sessionsRef.current.find((item) => item.id === sessionId);
      if (!current?.analyzers.some((item) => item.id === analyzerId && item.decodeBusy)) return;
      updateSession(session.id, (currentSession) => ({
        ...currentSession,
        analyzers: currentSession.analyzers.map((item) =>
          item.id === analyzerId && item.decodeBusy
            ? { ...item, decodeProgress: Math.max(item.decodeProgress, progress) }
            : item,
        ),
      }));
    }, 100);
    updateSession(session.id, (current) => ({
      ...current,
      analyzers: current.analyzers.map((item) =>
        item.id === analyzerId
          ? { ...item, decodeBusy: true, decodeProgress: Math.max(5, item.decodeProgress) }
          : item,
      ),
    }));
    try {
      const useLazySummary = analyzerUsesLazyNativeSummary(analyzer.decoderBackend);
      const frames = useLazySummary
        ? []
        : normalizeDecodedFrameOrder(
            await decodeAnalyzerFrames(session.id, settings, analyzer.decoderBackend),
          );
      const frameCount = useLazySummary ? lazyNativeAnalyzerFrameCount(analyzer) : frames.length;
      if (requestSeq !== analyzerRequestSeq.current[requestKey]) return;
      updateSession(session.id, (current) => ({
        ...current,
        analyzers: current.analyzers.map((item) =>
          item.id === analyzerId
            ? {
                ...item,
                protocolBubbles: [],
                decodedFrameCount: frameCount,
                decodedFrames: frames,
                decodedFramesComplete: !useLazySummary,
                decodedDecodeSignature: getAnalyzerDecodeSignature(item),
                previousFrame: null,
                nextFrame: null,
                decodeBusy: false,
                decodeProgress: useLazySummary ? 0 : 100,
                highlightedFrameIndex: null,
              }
            : item,
        ),
        message: silent
          ? current.message
          : useLazySummary
            ? `${analyzer.name} ready; visible data will decode as you browse`
            : `Decoded ${frameCount} frame${frameCount === 1 ? "" : "s"} with ${analyzer.name}`,
      }));
      setAnalyzerRenderRequestEpoch((epoch) => epoch + 1);
    } catch (error) {
      if (requestSeq !== analyzerRequestSeq.current[requestKey]) return;
      updateSession(session.id, (current) => ({
        ...current,
        analyzers: current.analyzers.map((item) =>
          item.id === analyzerId ? { ...item, decodeBusy: false, decodeProgress: 0 } : item,
        ),
        message: String(error),
      }));
    } finally {
      window.clearInterval(decodeProgressTimer);
    }
  }

  async function handleDecodeAnalyzerBatch(sessionId: string, analyzerIds: string[], silent = true) {
    const session = sessionsRef.current.find((item) => item.id === sessionId);
    if (!session?.summary || analyzerIds.length === 0) return;
    const requestedIds = new Set(analyzerIds);
    const requests = session.analyzers.flatMap((analyzer) => {
      if (!requestedIds.has(analyzer.id) || !analyzerCanRunDecoder(analyzer)) return [];
      const settings = analyzerDecodeSettings(analyzer);
      const signature = getAnalyzerDecodeSignature(analyzer);
      if (!settings || analyzer.decodedDecodeSignature === signature) return [];
      return [{
        analyzer,
        backend: analyzer.decoderBackend,
        requestSeq: (analyzerRequestSeq.current[`${sessionId}:${analyzer.id}`] ?? 0) + 1,
        settings,
        signature,
      }];
    });
    if (requests.length === 0) return;
    requests.forEach((request) => {
      analyzerRequestSeq.current[`${sessionId}:${request.analyzer.id}`] = request.requestSeq;
    });
    const requestIds = new Set(requests.map((request) => request.analyzer.id));
    const decodeStartedAt = performance.now();
    const decodeProgressTimer = window.setInterval(() => {
      const elapsed = performance.now() - decodeStartedAt;
      const progress = Math.min(94, 6 + 88 * (1 - Math.exp(-elapsed / 2_000)));
      const current = sessionsRef.current.find((item) => item.id === sessionId);
      if (!current?.analyzers.some((item) => requestIds.has(item.id) && item.decodeBusy)) return;
      updateSession(sessionId, (currentSession) => ({
        ...currentSession,
        analyzers: currentSession.analyzers.map((item) =>
          requestIds.has(item.id) && item.decodeBusy
            ? { ...item, decodeProgress: Math.max(item.decodeProgress, progress) }
            : item,
        ),
      }));
    }, 100);
    updateSession(sessionId, (current) => ({
      ...current,
      analyzers: current.analyzers.map((item) =>
        requestIds.has(item.id)
          ? { ...item, decodeBusy: true, decodeProgress: Math.max(5, item.decodeProgress) }
          : item,
      ),
    }));

    try {
      const lazySummaryRequests = requests.filter((request) =>
        analyzerUsesLazyNativeSummary(request.backend),
      );
      const fullRequests = requests.filter((request) => !lazySummaryRequests.includes(request));
      const decoded = fullRequests.length > 0
        ? await decodeAnalyzerFrameBatch(
            sessionId,
            fullRequests.map((request) => ({
              analyzer_id: request.analyzer.id,
              backend: request.backend,
              settings: request.settings,
            })),
          )
        : [];
      const decodedByAnalyzer = new Map(
        decoded.map((result) => [
          result.analyzer_id,
          normalizeDecodedFrameOrder(result.frames),
        ]),
      );
      const summarizedByAnalyzer = new Map(
        lazySummaryRequests.map((request) => [
          request.analyzer.id,
          lazyNativeAnalyzerFrameCount(request.analyzer),
        ]),
      );
      const signaturesByAnalyzer = new Map(
        requests.map((request) => [request.analyzer.id, request.signature]),
      );
      const validIds = new Set(
        requests
          .filter((request) =>
            analyzerRequestSeq.current[`${sessionId}:${request.analyzer.id}`] === request.requestSeq,
          )
          .map((request) => request.analyzer.id),
      );
      if (validIds.size === 0) return;
      updateSession(sessionId, (current) => ({
        ...current,
        analyzers: current.analyzers.map((item) => {
          if (!validIds.has(item.id)) return item;
          const frames = decodedByAnalyzer.get(item.id);
          const summarizedFrameCount = summarizedByAnalyzer.get(item.id);
          if (!frames && summarizedFrameCount === undefined) {
            return { ...item, decodeBusy: false, decodeProgress: 0 };
          }
          if (summarizedFrameCount !== undefined) {
            return {
              ...item,
              protocolBubbles: [],
              decodedFrameCount: summarizedFrameCount,
              decodedFrames: [],
              decodedFramesComplete: false,
              decodedDecodeSignature: signaturesByAnalyzer.get(item.id) ?? getAnalyzerDecodeSignature(item),
              previousFrame: null,
              nextFrame: null,
              decodeBusy: false,
              decodeProgress: 0,
              highlightedFrameIndex: null,
            };
          }
          const completeFrames = frames ?? [];
          return {
            ...item,
            protocolBubbles: [],
            decodedFrameCount: completeFrames.length,
            decodedFrames: completeFrames,
            decodedFramesComplete: true,
            decodedDecodeSignature: signaturesByAnalyzer.get(item.id) ?? getAnalyzerDecodeSignature(item),
            previousFrame: null,
            nextFrame: null,
            decodeBusy: false,
            decodeProgress: 100,
            highlightedFrameIndex: null,
          };
        }),
        message: silent
          ? current.message
          : `Decoded ${validIds.size} analyzer${validIds.size === 1 ? "" : "s"}`,
      }));
      setAnalyzerRenderRequestEpoch((epoch) => epoch + 1);
    } catch (error) {
      updateSession(sessionId, (current) => ({
        ...current,
        analyzers: current.analyzers.map((item) =>
          requestIds.has(item.id) ? { ...item, decodeBusy: false, decodeProgress: 0 } : item,
        ),
        message: String(error),
      }));
    } finally {
      window.clearInterval(decodeProgressTimer);
    }
  }

  async function handleWarmSaleaeNativeAnalyzers(sessionId: string, analyzerIds: string[]) {
    const session = sessionsRef.current.find((item) => item.id === sessionId);
    if (!session?.summary || session.busy || analyzerIds.length === 0) return;
    const captureIdentity = `${session.summary.metadata.captured_at}:${session.summary.metadata.sample_count}`;
    const requestedIds = new Set(analyzerIds);
    const requests = session.analyzers.flatMap((analyzer) => {
      const signature = getAnalyzerDecodeSignature(analyzer);
      if (
        !requestedIds.has(analyzer.id) ||
        analyzer.decoderBackend !== "saleae_native" ||
        analyzer.decodedFramesComplete ||
        analyzer.decodeBusy ||
        analyzer.decodeProgress >= 100 ||
        analyzer.decodedDecodeSignature !== signature ||
        analyzer.decodedFrameCount <= 0 ||
        !analyzerCanRunDecoder(analyzer)
      ) {
        return [];
      }
      const settings = analyzerDecodeSettings(analyzer);
      if (!settings) return [];
      return [{
        analyzer,
        requestSeq: (analyzerRequestSeq.current[`${sessionId}:${analyzer.id}`] ?? 0) + 1,
        settings,
        signature,
      }];
    });
    if (requests.length === 0) return;

    requests.forEach((request) => {
      analyzerRequestSeq.current[`${sessionId}:${request.analyzer.id}`] = request.requestSeq;
    });
    const requestIds = new Set(requests.map((request) => request.analyzer.id));
    const signaturesByAnalyzer = new Map(
      requests.map((request) => [request.analyzer.id, request.signature]),
    );
    const decodeStartedAt = performance.now();
    updateSession(sessionId, (current) => ({
      ...current,
      analyzers: current.analyzers.map((item) =>
        requestIds.has(item.id)
          ? { ...item, decodeBusy: true, decodeProgress: Math.max(1, item.decodeProgress) }
          : item,
      ),
    }));

    try {
      while (true) {
        const progressResults = await decodeSaleaeAnalyzerBackgroundStep(
          sessionId,
          requests.map((request) => ({
            analyzer_id: request.analyzer.id,
            backend: request.analyzer.decoderBackend,
            settings: request.settings,
          })),
        );
        const validIds = new Set(
          requests
            .filter((request) =>
              analyzerRequestSeq.current[`${sessionId}:${request.analyzer.id}`] === request.requestSeq,
            )
            .map((request) => request.analyzer.id),
        );
        const currentSession = sessionsRef.current.find((item) => item.id === sessionId);
        const currentCaptureIdentity = currentSession?.summary
          ? `${currentSession.summary.metadata.captured_at}:${currentSession.summary.metadata.sample_count}`
          : null;
        if (validIds.size === 0 || currentCaptureIdentity !== captureIdentity) return;
        const progressByAnalyzer = new Map(
          progressResults.map((progress) => [progress.analyzer_id, progress]),
        );
        const cancelled = progressResults.some((progress) => progress.cancelled);
        const paused = !cancelled && graphViewportInteractingRef.current;
        updateSession(sessionId, (current) => ({
          ...current,
          analyzers: current.analyzers.map((item) => {
            if (!validIds.has(item.id)) return item;
            const progress = progressByAnalyzer.get(item.id);
            const signature = signaturesByAnalyzer.get(item.id);
            if (!progress || !signature || getAnalyzerDecodeSignature(item) !== signature) {
              return { ...item, decodeBusy: false, decodeProgress: 0 };
            }
            const progressPercent = progress.complete
              ? 100
              : Math.max(1, Math.min(99, progress.progress * 100));
            return {
              ...item,
              decodedFrameCount: Math.max(item.decodedFrameCount, progress.frame_count),
              decodedDecodeSignature: signature,
              decodeBusy: !progress.complete && !cancelled && !paused,
              decodeProgress: cancelled ? item.decodeProgress : progressPercent,
            };
          }),
        }));
        setAnalyzerRenderRequestEpoch((epoch) => epoch + 1);

        if (cancelled || paused) return;
        if (progressResults.every((progress) => progress.complete)) {
          traceAnalyzerPerformance(
            "background_native_decode",
            decodeStartedAt,
            `analyzers=${progressResults.length} frames=${progressResults.reduce((count, progress) => count + progress.frame_count, 0)}`,
          );
          return;
        }
        await new Promise<void>((resolve) => window.setTimeout(resolve, 16));
      }
    } catch (error) {
      updateSession(sessionId, (current) => ({
        ...current,
        analyzers: current.analyzers.map((item) =>
          requestIds.has(item.id) ? { ...item, decodeBusy: false, decodeProgress: 0 } : item,
        ),
        message: String(error),
      }));
    }
  }

  const analyzerDecodeSignature =
    activeSession?.analyzers
      .map((analyzer) => `${analyzer.id}:${getAnalyzerDecodeSignature(analyzer)}`)
      .join("|") ?? "";

  const saleaeNativeBackgroundDecodeSignature =
    activeSession?.analyzers
      .flatMap((analyzer) => {
        const signature = getAnalyzerDecodeSignature(analyzer);
        if (
          analyzer.decoderBackend !== "saleae_native" ||
          analyzer.decodedFramesComplete ||
          analyzer.decodeBusy ||
          analyzer.decodeProgress >= 100 ||
          analyzer.decodedDecodeSignature !== signature ||
          analyzer.decodedFrameCount <= 0
        ) {
          return [];
        }
        return [`${analyzer.id}:${signature}:${analyzer.decodedFrameCount}:${analyzer.decodedFrames.length}`];
      })
      .join("|") ?? "";

  useEffect(() => {
    if (
      !activeSession?.summary ||
      activeSession.busy ||
      activeSession.analyzers.length === 0
    ) return;
    const timeout = window.setTimeout(() => {
      void handleDecodeAnalyzerBatch(
        activeSession.id,
        activeSession.analyzers.map((analyzer) => analyzer.id),
        true,
      );
    }, 20);
    return () => window.clearTimeout(timeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    activeSession?.id,
    activeSession?.busy,
    activeSession?.summary?.metadata.captured_at,
    activeSession?.summary?.metadata.sample_count,
    analyzerDecodeSignature,
  ]);

  useEffect(() => {
    if (
      !activeSession?.summary ||
      activeSession.busy ||
      graphViewportInteracting ||
      !saleaeNativeBackgroundDecodeSignature
    ) return;
    const analyzerIds = activeSession.analyzers.flatMap((analyzer) => {
      const signature = getAnalyzerDecodeSignature(analyzer);
      if (
        analyzer.decoderBackend !== "saleae_native" ||
        analyzer.decodedFramesComplete ||
        analyzer.decodeBusy ||
        analyzer.decodeProgress >= 100 ||
        analyzer.decodedDecodeSignature !== signature ||
        analyzer.decodedFrameCount <= 0
      ) {
        return [];
      }
      return [analyzer.id];
    });
    if (analyzerIds.length === 0) return;
    const timeout = window.setTimeout(() => {
      void handleWarmSaleaeNativeAnalyzers(activeSession.id, analyzerIds);
    }, 650);
    return () => window.clearTimeout(timeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    activeSession?.id,
    activeSession?.busy,
    activeSession?.summary?.metadata.captured_at,
    activeSession?.summary?.metadata.sample_count,
    graphViewportInteracting,
    saleaeNativeBackgroundDecodeSignature,
  ]);

  async function handleCancel() {
    const targetId = captureSessionRef.current ?? activeSession?.id;
    if (targetId) {
      updateSession(targetId, (session) => ({ ...session, message: "Stopping capture" }));
    }
    try {
      await cancelCapture();
    } catch (error) {
      if (targetId) {
        updateSession(targetId, (session) => ({ ...session, message: String(error) }));
      }
    }
  }

  async function loadCaptureIntoSession(opened: OpenCaptureResult, targetSession?: UiSession, sourcePath?: string) {
    const { summary, saleae_session: saleaeSession } = opened;
    const target =
      targetSession ??
      (activeSession && !activeSession.summary
        ? activeSession
        : createSession(summary.metadata.source_device || selectedDevice, activeSession ?? undefined));
    const labels = channelLabelsForCount(summary.metadata.channel_count, summary.metadata.labels);
    const enabledChannels = metadataEnabledChannels(summary.metadata);
    const initialViewport = initialCaptureViewport(summary);
    const restoredAnalyzers = saleaeSession?.analyzers.reduce<UiAnalyzerInstance[]>(
      (analyzers, metadata) => [...analyzers, restoreSaleaeAnalyzer(metadata, analyzers)],
      [],
    );
    updateSession(target.id, (session) => ({
      ...session,
      name: captureNameFromSavedPath(sourcePath ?? "") || saleaeSession?.name.trim() || session.name,
      readOnly: true,
      notes: saleaeSession?.notes ?? session.notes,
      selectedDevice: summary.metadata.source_device || session.selectedDevice,
      settings: {
        ...session.settings,
        device_id: summary.metadata.source_device || session.selectedDevice,
        sample_rate_hz: summary.metadata.sample_rate_hz,
        channel_count: summary.metadata.channel_count,
        enabled_channels: enabledChannels,
      },
      deviceSettings: {
        ...session.deviceSettings,
        digitalChannels: digitalChannelsForMetadata(summary.metadata),
        triggerChannel: enabledChannels.includes(session.deviceSettings.triggerChannel)
          ? session.deviceSettings.triggerChannel
          : (enabledChannels[0] ?? 0),
      },
      hiddenDigitalChannels: makeHiddenDigitalChannels(),
      channelLabels: labels,
      cursorState: defaultCursorState(summary.metadata.sample_count, summary.metadata.channel_count),
      rangePlacement: null,
      timingMarkerPlacement: null,
      summary: summaryWithLabels(summary, labels),
      tile: null,
      ...initialViewport,
      analyzers:
        restoredAnalyzers ??
        session.analyzers.map((analyzer) => ({
          ...analyzer,
          protocolBubbles: [],
          decodedFrameCount: 0,
          decodedFrames: [],
          decodedFramesComplete: false,
          decodedDecodeSignature: null,
          previousFrame: null,
          nextFrame: null,
          renderedTracks: [],
          renderedViewport: null,
          renderedDecodeSignature: null,
          renderBusy: false,
          renderProgress: 0,
          decodeBusy: false,
          decodeProgress: 0,
          highlightedFrameIndex: null,
        })),
      message:
        restoredAnalyzers && restoredAnalyzers.length > 0
          ? `Capture opened - ${restoredAnalyzers.length} analyzer${restoredAnalyzers.length === 1 ? "" : "s"} restored`
          : "Capture opened",
    }));
    setActiveSessionId(target.id);
  }

  async function handleOpen() {
    let target: UiSession | null = null;
    let sourcePath: string | null = null;
    try {
      const path = await openDialog({
        multiple: false,
        filters: [{ name: "Logic Capture", extensions: ["pxl", "pxcap"] }],
      });
      if (typeof path !== "string") return;
      sourcePath = path;
      target =
        activeSession && !activeSession.summary
          ? activeSession
          : createSession(selectedDevice, activeSession ?? undefined);
      const opened = await openCapture(target.id, path);
      await loadCaptureIntoSession(opened, target, path);
    } catch (error) {
      try {
        target ??=
          activeSession && !activeSession.summary
            ? activeSession
            : createSession(selectedDevice, activeSession ?? undefined);
        const opened = await openCapture(target.id, "preview");
        await loadCaptureIntoSession(opened, target, sourcePath ?? undefined);
        updateSession(target.id, (session) => ({ ...session, message: "Preview capture loaded" }));
      } catch {
        if (activeSession) {
          updateSession(activeSession.id, (session) => ({ ...session, message: String(error) }));
        } else {
          setStartupMessage(String(error));
        }
      }
    }
  }

  async function handleSave() {
    if (!activeSession?.summary || activeSession.busy) return;
    try {
      const path = await saveDialog({
        defaultPath: `${activeSession.name || "capture"}.pxl`,
        filters: [
          { name: "SigPilot Project", extensions: ["pxl"] },
          { name: "Sigrok Session", extensions: ["sr"] },
          { name: "Value Change Dump", extensions: ["vcd"] },
        ],
      });
      if (!path) return;
      const requestedExtension = path.split(".").pop()?.toLowerCase();
      const extension = ["pxl", "sr", "vcd"].includes(requestedExtension ?? "")
        ? requestedExtension
        : "pxl";
      const outputPath = requestedExtension === extension ? path : `${path}.pxl`;
      if (extension === "sr" || extension === "vcd") {
        await exportCapture(activeSession.id, outputPath, extension === "sr" ? "Sr" : "Vcd");
      } else {
        await saveCapture(activeSession.id, outputPath, {
          name: activeSession.name,
          notes: activeSession.notes,
          analyzers: activeSession.analyzers.map(saleaeAnalyzerMetadata),
        });
      }
      const savedName =
        extension !== "sr" && extension !== "vcd" && preferences.renameTabToSavedCapture
          ? captureNameFromSavedPath(outputPath)
          : null;
      updateSession(activeSession.id, (session) => ({
        ...session,
        name: savedName || session.name,
        message:
          extension === "sr"
            ? "Sigrok session exported"
            : extension === "vcd"
              ? "VCD exported"
              : "Capture saved",
      }));
    } catch (error) {
      updateSession(activeSession.id, (session) => ({ ...session, message: String(error) }));
    }
  }

  function setSelectedDeviceForActive(deviceId: string) {
    setDraftSelectedDevice(deviceId);
    if (!activeSession) return;
    updateSession(activeSession.id, (session) => {
      const bufferSizeMb = defaultBufferSizeMb(deviceId);
      const nextSettings = clampCaptureSettingsToCapabilities(
        {
          ...session.settings,
          buffer_size_mb: bufferSizeMb,
          device_id: deviceId,
        },
        capabilitiesForDevice(deviceId),
      );
      const channelCountChanged = nextSettings.channel_count !== session.settings.channel_count;
      const digitalChannels = channelCountChanged
        ? makeDigitalChannels(nextSettings.channel_count)
        : session.deviceSettings.digitalChannels;
      return {
        ...session,
        channelLabels: channelCountChanged
          ? channelLabelsForCount(nextSettings.channel_count, session.channelLabels)
          : session.channelLabels,
        deviceSettings: {
          ...session.deviceSettings,
          analogChannels: analogChannelsForDevice(
            deviceId,
            session.deviceSettings.analogChannels,
            session.selectedDevice === deviceId,
          ),
          bufferSizeMb,
          digitalChannels,
          pwmEffectiveDutyPercent: null,
          pwmEffectiveFrequencyHz: null,
          triggerChannel: Math.min(session.deviceSettings.triggerChannel, Math.max(0, nextSettings.channel_count - 1)),
        },
        selectedDevice: deviceId,
        settings: {
          ...nextSettings,
          enabled_channels: enabledChannelIndexes(digitalChannels, nextSettings.channel_count),
        },
      };
    });
  }

  function updateActiveSettings(patch: Partial<CaptureSettings>) {
    if (!activeSession) return;
    updateSession(activeSession.id, (session) => {
      const nextSettings = clampCaptureSettingsToCapabilities(
        { ...session.settings, ...patch },
        capabilitiesForDevice(patch.device_id ?? session.selectedDevice),
      );
      const channelCountChanged = nextSettings.channel_count !== session.settings.channel_count;
      return {
        ...session,
        channelLabels: channelCountChanged
          ? channelLabelsForCount(nextSettings.channel_count, session.channelLabels)
          : session.channelLabels,
        deviceSettings: {
          ...session.deviceSettings,
          triggerChannel: Math.min(session.deviceSettings.triggerChannel, Math.max(0, nextSettings.channel_count - 1)),
        },
        settings: nextSettings,
      };
    });
  }

  function renameChannelLabel(channelIndex: number, name: string) {
    if (!activeSession) return;
    const nextName = name.trim() || `D${channelIndex}`;
    updateSession(activeSession.id, (session) => {
      const count = session.summary?.metadata.channel_count ?? session.settings.channel_count;
      const labels = channelLabelsForCount(count, session.channelLabels);
      labels[channelIndex] = nextName;
      return {
        ...session,
        channelLabels: labels,
        summary: session.summary ? summaryWithLabels(session.summary, labels) : session.summary,
        tile: session.tile
          ? {
              ...session.tile,
              channels: session.tile.channels.map((channel) =>
                channel.channel === channelIndex ? { ...channel, label: nextName } : channel,
              ),
            }
          : session.tile,
        message: `D${channelIndex} renamed to ${nextName}`,
      };
    });
  }

  function setChannelEnabled(channelIndex: number, enabled: boolean) {
    if (!activeSession) return;
    updateSession(activeSession.id, (session) => {
      const digitalChannels = [...session.deviceSettings.digitalChannels];
      const hiddenDigitalChannels = makeHiddenDigitalChannels(session.hiddenDigitalChannels);
      while (digitalChannels.length <= channelIndex) digitalChannels.push(false);
      digitalChannels[channelIndex] = enabled;
      hiddenDigitalChannels[channelIndex] = false;
      const highestEnabled = highestEnabledDigitalChannel(digitalChannels);
      const channelCount = Math.max(1, highestEnabled + 1);
      const enabledChannels = enabledChannelIndexes(digitalChannels, channelCount);
      return {
        ...session,
        channelLabels: channelLabelsForCount(channelCount, session.channelLabels),
        settings: {
          ...session.settings,
          channel_count: channelCount,
          enabled_channels: enabledChannels,
        },
        deviceSettings: {
          ...session.deviceSettings,
          digitalChannels,
          triggerChannel: enabledChannels.includes(session.deviceSettings.triggerChannel)
            ? session.deviceSettings.triggerChannel
            : (enabledChannels[0] ?? 0),
        },
        hiddenDigitalChannels,
        message: `D${channelIndex} ${digitalChannels[channelIndex] ? "shown and enabled" : "hidden and disabled"}`,
      };
    });
  }

  function hideChannelRow(channelIndex: number) {
    if (!activeSession) return;
    updateSession(activeSession.id, (session) => {
      const hiddenDigitalChannels = makeHiddenDigitalChannels(session.hiddenDigitalChannels);
      hiddenDigitalChannels[channelIndex] = true;
      return {
        ...session,
        hiddenDigitalChannels,
        message: `D${channelIndex} hidden`,
      };
    });
  }

  function toggleChannelRowVisibility(channelIndex: number) {
    if (!activeSession) return;
    updateSession(activeSession.id, (session) => {
      const hiddenDigitalChannels = makeHiddenDigitalChannels(session.hiddenDigitalChannels);
      hiddenDigitalChannels[channelIndex] = !hiddenDigitalChannels[channelIndex];
      return {
        ...session,
        hiddenDigitalChannels,
        message: `D${channelIndex} ${hiddenDigitalChannels[channelIndex] ? "hidden" : "shown"}`,
      };
    });
  }

  function showAllChannelRows() {
    if (!activeSession) return;
    updateSession(activeSession.id, (session) => ({
      ...session,
      hiddenDigitalChannels: makeHiddenDigitalChannels(),
      message: "All channels shown",
    }));
  }

  function resetChannelNames() {
    if (!activeSession) return;
    updateSession(activeSession.id, (session) => {
      const count = Math.max(32, captureChannelLimit(session), session.channelLabels.length);
      const labels = Array.from({ length: count }, (_, index) => `D${index}`);
      return {
        ...session,
        channelLabels: labels,
        summary: session.summary ? summaryWithLabels(session.summary, labels) : session.summary,
        tile: session.tile
          ? {
              ...session.tile,
              channels: session.tile.channels.map((channel) => ({
                ...channel,
                label: labels[channel.channel] ?? `D${channel.channel}`,
              })),
            }
          : session.tile,
        message: "Channel names reset",
      };
    });
  }

  function setChannelHeight(channelIndex: number, height: number) {
    if (!activeSession) return;
    updateSession(activeSession.id, (session) => {
      const channelHeights = makeSaleaeDigitalRowHeights(32, session.channelHeights);
      if (!session.manualChannelLayout) {
        visibleChannelIndexes.forEach((visibleChannelIndex, rowIndex) => {
          channelHeights[visibleChannelIndex] =
            visibleChannelHeights[rowIndex] ?? channelHeights[visibleChannelIndex];
        });
      }
      channelHeights[channelIndex] = Math.max(SALEAE_DIGITAL_ROW_V2_MIN_HEIGHT_PX, height);
      return {
        ...session,
        channelHeights,
        manualChannelLayout: true,
      };
    });
  }

  function updateAnalogChannel(channelIndex: number, patch: Partial<UiAnalogChannelSettings>) {
    if (!activeSession) return;
    updateSession(activeSession.id, (session) => {
      const analogChannels = cloneAnalogChannels(session.deviceSettings.analogChannels);
      const current = analogChannels[channelIndex];
      if (!current) return session;
      analogChannels[channelIndex] = {
        ...current,
        ...patch,
        height: Math.max(ANALOG_ROW_MIN_HEIGHT_PX, patch.height ?? current.height),
        rangeVolts: Math.max(ANALOG_VIEW_RANGE_MIN_VOLTS, patch.rangeVolts ?? current.rangeVolts),
        viewRangeVolts: Math.max(
          ANALOG_VIEW_RANGE_MIN_VOLTS,
          patch.viewRangeVolts ?? current.viewRangeVolts,
        ),
      };
      return {
        ...session,
        deviceSettings: { ...session.deviceSettings, analogChannels },
      };
    });
  }

  function reorderVisibleChannels(sourceIndex: number, destinationIndex: number) {
    if (!activeSession || sourceIndex === destinationIndex) return;
    updateSession(activeSession.id, (session) => {
      const visibleChannels = visibleDigitalChannelIndexes(session);
      if (
        sourceIndex < 0 ||
        sourceIndex >= visibleChannels.length ||
        destinationIndex < 0 ||
        destinationIndex >= visibleChannels.length
      ) {
        return session;
      }

      const nextVisibleChannels = [...visibleChannels];
      const [sourceChannel] = nextVisibleChannels.splice(sourceIndex, 1);
      nextVisibleChannels.splice(destinationIndex, 0, sourceChannel);

      const visibleSet = new Set(visibleChannels);
      let nextVisibleIndex = 0;
      const nextOrder = channelOrderForCount(32, session.channelOrder).map((channel) =>
        visibleSet.has(channel) ? nextVisibleChannels[nextVisibleIndex++] : channel,
      );
      return {
        ...session,
        channelOrder: nextOrder,
        message: (session.channelLabels[sourceChannel] ?? `D${sourceChannel}`) + " moved",
      };
    });
  }

  function beginChannelReorder() {
    setEditingChannel(null);
    setChannelContextMenu(null);
    setChannelReorderActive(true);
  }

  function finishChannelReorder(result: DropResult) {
    setChannelReorderActive(false);
    if (!result.destination) return;
    reorderVisibleChannels(result.source.index, result.destination.index);
  }

  function matchAllDigitalChannelHeights(channelIndex: number) {
    if (!activeSession) return;
    updateSession(activeSession.id, (session) => {
      const channelHeights = makeSaleaeDigitalRowHeights(32, session.channelHeights);
      if (!session.manualChannelLayout) {
        visibleChannelIndexes.forEach((visibleChannelIndex, rowIndex) => {
          channelHeights[visibleChannelIndex] =
            visibleChannelHeights[rowIndex] ?? channelHeights[visibleChannelIndex];
        });
      }
      const sourceHeight =
        channelHeights[channelIndex] ??
        visibleChannelHeights[visibleChannelIndexes.indexOf(channelIndex)] ??
        SALEAE_DEFAULT_DIGITAL_ROW_HEIGHT_PX;
      session.deviceSettings.digitalChannels.forEach((enabled, index) => {
        if (enabled) channelHeights[index] = sourceHeight;
      });
      return {
        ...session,
        channelHeights,
        manualChannelLayout: true,
        message: "Digital channel heights matched",
      };
    });
  }

  function fitAllRowsToWindowHeight() {
    if (!activeSession) return;
    updateSession(activeSession.id, (session) => ({
      ...session,
      manualChannelLayout: false,
      message: "Rows fit to window height",
    }));
  }

  function toggleAutoLayout() {
    if (!activeSession) return;
    updateSession(activeSession.id, (session) => {
      const autoLayout = session.manualChannelLayout;
      return {
        ...session,
        manualChannelLayout: !autoLayout,
        message: autoLayout ? "Auto Layout enabled" : "Auto Layout disabled",
      };
    });
  }

  function toggleInteractiveMeasurement() {
    if (!activeSession) return;
    updateSession(activeSession.id, (session) => ({
      ...session,
      showInteractiveMeasurement: !session.showInteractiveMeasurement,
      message: `Interactive measurement ${session.showInteractiveMeasurement ? "hidden" : "shown"}`,
    }));
  }

  function previewChannelTrim(mode: ChannelDeleteDataMode) {
    const menu = channelContextMenu;
    if (!activeSession?.summary || !menu) return;

    const total = activeSession.summary.metadata.sample_count;
    const range = resolveChannelTrimRange({
      clickedSample: menu.sample,
      mode,
      totalSamples: total,
      viewportSamples: activeSession.viewportSamples,
      viewportStart: activeSession.viewportStart,
    });
    if (!range) return;

    setChannelContextMenu(null);
    setPendingChannelTrim({
      mode,
      range,
      sessionId: activeSession.id,
    });
    updateSession(activeSession.id, (session) => ({
      ...session,
      message: "Review highlighted data before deleting",
    }));

    if (mode === "offscreen") {
      const preservedSamples = Math.max(1, range.trimEnd - range.trimStart);
      const padding = preservedSamples * 0.2;
      const targetStart = Math.max(0, range.trimStart - padding);
      const targetEnd = Math.min(total, range.trimEnd + padding);
      animateViewport(activeSession.id, targetStart, targetEnd - targetStart);
      return;
    }

    const anchor = mode === "before" ? range.trimStart : range.trimEnd;
    if (
      anchor < activeSession.viewportStart ||
      anchor > activeSession.viewportStart + activeSession.viewportSamples
    ) {
      animateViewport(activeSession.id, anchor - activeSession.viewportSamples / 2, activeSession.viewportSamples);
    }
  }

  async function confirmPendingChannelTrim() {
    const pending = pendingChannelTrim;
    if (!pending) return;
    const session = sessionsRef.current.find((item) => item.id === pending.sessionId);
    if (!session?.summary) {
      setPendingChannelTrim(null);
      return;
    }

    setPendingChannelTrim(null);
    updateSession(pending.sessionId, (current) => ({
      ...current,
      message: "Deleting data...",
    }));
    try {
      const nextSummary = await trimCapture(pending.sessionId, {
        trim_before_sample: pending.range.trimStart,
        trim_after_sample: pending.range.trimEnd,
      });
      updateSession(pending.sessionId, (current) =>
        applyTrimmedCapture(current, nextSummary, pending.range.trimStart, pending.mode),
      );
    } catch (error) {
      updateSession(pending.sessionId, (current) => ({ ...current, message: String(error) }));
    }
  }

  function cancelPendingChannelTrim() {
    setPendingChannelTrim(null);
    if (activeSession) {
      updateSession(activeSession.id, (session) => ({ ...session, message: "Delete Data canceled" }));
    }
  }

  function takeContextScreenshot(target: "channel" | "window") {
    if (!activeSession || screenshotInProgressRef.current) return;

    let rect: ScreenshotCaptureRect | undefined;
    if (target === "channel") {
      const menu = channelContextMenu ?? channelContextMenuSnapshotRef.current;
      if (!menu) return;
      const rowIndex = visibleChannelIndexes.indexOf(menu.channelIndex);
      if (rowIndex < 0) return;
      rect = resolveChannelScreenshotRect(menu.channelIndex, rowIndex, {
        analyzerInset: visibleAnalyzerInsets[rowIndex] ?? 0,
        fallbackHeight: visibleChannelHeights[rowIndex] ?? SALEAE_DEFAULT_DIGITAL_ROW_HEIGHT_PX,
        fallbackTop: visibleChannelLayouts[rowIndex]?.outerTop,
      }) ?? undefined;
      if (!rect) return;
    } else {
      const root = document.querySelector<HTMLElement>(".logic-root");
      const rootRect = root?.getBoundingClientRect();
      if (rootRect) {
        rect = {
          x: rootRect.left,
          y: rootRect.top,
          width: rootRect.width,
          height: rootRect.height,
        };
      }
    }

    const sessionId = activeSession.id;
    const sessionName = activeSession.name;
    const device = devices.find((item) => item.id === activeSession.selectedDevice);
    const connectedDeviceName = device?.profile_model || device?.product || device?.label;
    const settings = { ...screenshotSettings };
    const captureRect = rect;
    setChannelContextMenu(null);
    channelContextMenuSnapshotRef.current = null;
    if (captureRect) showScreenshotCaptureFeedback(captureRect, target, SCREENSHOT_FEEDBACK_VISIBLE_MS);
    screenshotInProgressRef.current = true;
    window.setTimeout(() => {
      void takeScreenshot({
        connectedDeviceName,
        rect: target === "channel" ? captureRect : undefined,
        sessionName,
        settings,
      })
        .then((result) => {
          if (result.filePath) {
            setScreenshotSettings((current) => ({ ...current, filePath: result.filePath }));
          }
          if (result.message) {
            updateSession(sessionId, (session) => ({ ...session, message: result.message ?? session.message }));
            showScreenshotNotification({
              body: screenshotNotificationBody(result.message),
              heading: "Screenshot Taken",
              type: "success",
            });
          }
        })
        .catch((error) => {
          const errorMessage = `Screenshot failed: ${String(error)}`;
          updateSession(sessionId, (session) => ({ ...session, message: errorMessage }));
          showScreenshotNotification({
            body: "An error occurred while taking a screenshot. Please try again.",
            heading: "Screenshot Error",
            type: "error",
          });
        })
        .finally(() => {
          screenshotInProgressRef.current = false;
        });
    }, target === "window" ? SCREENSHOT_WINDOW_CONTEXT_MENU_CLOSE_DELAY_MS : SCREENSHOT_CONTEXT_MENU_CLOSE_DELAY_MS);
  }

  function showScreenshotNotification(notification: Omit<ScreenshotNotification, "id">) {
    setScreenshotNotification({
      ...notification,
      id: Date.now(),
    });
  }

  function setScreenshotDestination(destination: ScreenshotDestination) {
    setScreenshotSettings((current) => ({ ...current, destination }));
  }

  function handleGraphScroll(event: ReactUIEvent<HTMLDivElement>) {
    if (!activeSession) return;
    pendingGraphScrollRef.current = {
      sessionId: activeSession.id,
      scrollTop: event.currentTarget.scrollTop,
    };
    if (graphScrollFrameRef.current !== null) return;
    graphScrollFrameRef.current = window.requestAnimationFrame(() => {
      graphScrollFrameRef.current = null;
      const pending = pendingGraphScrollRef.current;
      pendingGraphScrollRef.current = null;
      if (!pending) return;
      updateSession(pending.sessionId, (session) => ({
        ...session,
        graphScrollTop: pending.scrollTop,
      }));
    });
  }

  function setTriggerChannel(channelIndex: number) {
    if (!activeSession) return;
    updateSession(activeSession.id, (session) => ({
      ...session,
      deviceSettings: {
        ...session.deviceSettings,
        captureMode: "Trigger",
        triggerChannel: channelIndex,
      },
      message: `D${channelIndex} selected as trigger channel`,
    }));
    openSidebarPanel("devices");
  }

  function addAnalyzerForChannel(channelIndex: number) {
    if (!activeSession) return;
    setAnalyzerInEdit({
      analyzer: createAnalyzerInstance("Async Serial", activeSession.analyzers, channelIndex, "sigrok_native"),
      isNew: true,
      sessionId: activeSession.id,
    });
  }

  function beginAddAnalyzer(
    name: string,
    channelIndex?: number,
    decoderBackend: DecoderBackendKind = "sigrok_native",
    catalogItem?: SigrokDecoderCatalogItem | null,
  ) {
    if (!activeSession) return;
    const firstEnabledChannel = activeSession.deviceSettings.digitalChannels.findIndex(Boolean);
    const startChannel = channelIndex ?? Math.max(0, firstEnabledChannel);
    setAnalyzerInEdit({
      analyzer: catalogItem
        ? decoderBackend === "saleae_native"
          ? createAnalyzerInstanceFromSaleaeCatalog(catalogItem, activeSession.analyzers, startChannel)
          : createAnalyzerInstanceFromSigrokCatalog(catalogItem, activeSession.analyzers, startChannel)
        : createAnalyzerInstance(name, activeSession.analyzers, startChannel, decoderBackend),
      isNew: true,
      sessionId: activeSession.id,
    });
  }

  function beginEditAnalyzer(analyzerId: string) {
    if (!activeSession) return;
    const analyzer = activeSession.analyzers.find((item) => item.id === analyzerId);
    if (!analyzer) return;
    setAnalyzerInEdit({ analyzer: { ...analyzer }, isNew: false, sessionId: activeSession.id });
  }

  function saveAnalyzerSettings(analyzer: UiAnalyzerInstance) {
    const editor = analyzerInEdit;
    if (!editor) return;
    updateSession(editor.sessionId, (session) => {
      const digitalChannels = [...session.deviceSettings.digitalChannels];
      const hiddenDigitalChannels = makeHiddenDigitalChannels(session.hiddenDigitalChannels);
      const analyzerChannels = analyzerChannelIndexes(analyzer);
      const highestAnalyzerChannel = analyzerChannels.length > 0 ? Math.max(...analyzerChannels) : -1;
      if (highestAnalyzerChannel >= 0) {
        while (digitalChannels.length <= highestAnalyzerChannel) digitalChannels.push(false);
        analyzerChannels.forEach((channel) => {
          digitalChannels[channel] = true;
          hiddenDigitalChannels[channel] = false;
        });
      }
      const channelCount = Math.max(session.settings.channel_count, highestAnalyzerChannel + 1);
      const enabledChannels = enabledChannelIndexes(digitalChannels, channelCount);
      const nextAnalyzers = editor.isNew
        ? [...session.analyzers, analyzer]
        : session.analyzers.map((item) => (item.id === analyzer.id ? analyzer : item));
      return {
        ...session,
        analyzers: nextAnalyzers,
        channelLabels: channelLabelsForCount(channelCount, session.channelLabels),
        hiddenDigitalChannels,
        deviceSettings: { ...session.deviceSettings, digitalChannels },
        settings: {
          ...session.settings,
          channel_count: channelCount,
          enabled_channels: enabledChannels,
        },
        message: `${analyzer.name} settings saved`,
      };
    });
    setAnalyzerInEdit(null);
    window.setTimeout(() => void handleDecodeAnalyzer(editor.sessionId, analyzer.id), 0);
  }

  function selectAnalyzerFrame(sessionId: string, analyzerId: string, frameId: number) {
    updateSession(sessionId, (session) => highlightAnalyzerFrameInSession(session, analyzerId, frameId));
  }

  function goToAnalyzerFrame(
    analyzerId: string,
    frameId: number,
    zoom: boolean,
    providedFrame?: DecodedFrame | AnalyzerFrameRef,
  ) {
    const session = sessionsRef.current.find((item) => item.id === activeSessionIdRef.current);
    const analyzer = session?.analyzers.find((item) => item.id === analyzerId);
    const frame =
      providedFrame ??
      (analyzer ? findAnalyzerFrameById(analyzer.decodedFrames, frameId) : null) ??
      (analyzer ? findAnalyzerRenderedTrackFrameById(analyzer, frameId) : null) ??
      null;
    if (!session || !frame) return;
    selectAnalyzerFrame(session.id, analyzerId, frameId);
    const frameSamples = Math.max(1, frame.end_sample - frame.start_sample);
    if (zoom) {
      const padding = frameSamples * 0.05;
      animateViewport(session.id, frame.start_sample - padding, frameSamples + padding * 2);
    } else {
      const center = frame.start_sample + frameSamples / 2;
      animateViewport(session.id, center - session.viewportSamples / 2, session.viewportSamples);
    }
  }

  function zoomAnalyzerBubble(analyzerId: string, startSample: number, endSample: number, frameId: number) {
    const session = sessionsRef.current.find((item) => item.id === activeSessionIdRef.current);
    if (!session) return;
    selectAnalyzerFrame(session.id, analyzerId, frameId);
    const span = Math.max(1, endSample - startSample);
    const padding = span * 0.05;
    animateViewport(session.id, startSample - padding, span + padding * 2);
  }

  function openAnalyzerTableFrame(analyzerId: string, frameId: number) {
    if (!activeSession) return;
    setSelectedPanel("analyzers");
    updateSession(activeSession.id, (session) => {
      const highlighted = highlightAnalyzerFrameInSession(session, analyzerId, frameId);
      return highlighted.analyzerDataPane === "table"
        ? highlighted
        : { ...highlighted, analyzerDataPane: "table" };
    });
  }

  function openSidebarPanel(panel: SidebarPanel) {
    const allowed = getSidebarPanelAllowed(panel, activeSession);
    if (!allowed.isVisible || !allowed.isSelectable) {
      if (activeSession && allowed.disabledReason) {
        updateSession(activeSession.id, (session) => ({ ...session, message: allowed.disabledReason ?? session.message }));
      }
      return;
    }
    setSelectedPanel(panel);
  }

  function toggleSidebarPanel(panel: SidebarPanel | undefined) {
    if (!panel) {
      setSelectedPanel(undefined);
      return;
    }
    if (selectedPanel === panel) {
      setSelectedPanel(undefined);
      return;
    }
    openSidebarPanel(panel);
  }

  function invokeCommand(command: UiCommand, payload?: CommandPayload) {
    if (command === SidebarCommands.CloseSidebar) {
      setSelectedPanel(undefined);
      return;
    }

    const sidebarPanel = SIDEBAR_COMMAND_TO_PANEL[command];
    if (sidebarPanel) {
      openSidebarPanel(sidebarPanel);
      return;
    }

    if (command === AnalyzerCommands.AddAnalyzer) {
      const catalogItem = payload?.analyzerCatalogId
        ? (payload.analyzerBackend === "saleae_native" ? saleaeCatalog : sigrokCatalog)?.decoders.find(
            (item) => item.id === payload.analyzerCatalogId,
          )
        : undefined;
      handleAddAnalyzer(
        catalogItem
          ? {
              backend: payload?.analyzerBackend ?? "sigrok_native",
              catalogItem,
              description: [sigrokCatalogDetailName(catalogItem), catalogItem.desc?.trim()]
                .filter((part, index, parts) => part && parts.indexOf(part) === index)
                .join(" - ") || null,
              name: sigrokCatalogDisplayName(catalogItem),
              runnerStatus: catalogItem.runner_status,
              source:
                payload?.analyzerBackend === "saleae_native"
                  ? "Saleae Native"
                  : catalogItem.kind === "python"
                    ? "Sigrok Python Decoders"
                    : "Sigrok C Decoders",
            }
          : payload?.analyzerName ?? "Async Serial",
        payload?.analyzerBackend ?? "sigrok_native",
      );
      return;
    }

    if (command === MeasurementCommands.AddRange) {
      handleAddRangeMeasurement();
      return;
    }

    if (command === MarkerCommands.AddPair) {
      handleAddMarkerPair();
      return;
    }

    if (command === MarkerCommands.AddMarker) {
      handleAddSingleMarker();
    }
  }

  function handleAddAnalyzer(
    choiceOrName: AnalyzerLibraryChoice | string,
    backend: DecoderBackendKind = "sigrok_native",
  ) {
    if (typeof choiceOrName === "string") {
      beginAddAnalyzer(choiceOrName, undefined, backend);
      return;
    }
    beginAddAnalyzer(choiceOrName.name, undefined, choiceOrName.backend, choiceOrName.catalogItem);
  }

  function handleAddRangeMeasurement() {
    openSidebarPanel("measurements");
    if (!activeSession) return;
    if (activeSession.rangePlacement) return;
    if (!activeSession.summary) {
      updateSession(activeSession.id, (session) => ({
        ...session,
        message: "Capture data before adding a range measurement",
      }));
      return;
    }
    if (activeSession.busy) {
      updateSession(activeSession.id, (session) => ({
        ...session,
        message: "Range measurements are disabled while recording",
      }));
      return;
    }
    updateSession(activeSession.id, (session) => ({
      ...session,
      rangePlacement: {
        channelIndex: null,
        currentSample: null,
        startedBy: "command",
        startSample: null,
      },
      message: "Click and drag over a channel to add a range measurement",
    }));
  }

  function handleAddMarkerPair() {
    openSidebarPanel("timingMarkers");
    if (!activeSession) return;
    if (!activeSession.summary) {
      updateSession(activeSession.id, (session) => ({
        ...session,
        message: "Capture data before adding a marker pair",
      }));
      return;
    }
    if (activeSession.busy) {
      updateSession(activeSession.id, (session) => ({
        ...session,
        message: "Timing markers are disabled while recording",
      }));
      return;
    }
    if (activeSession.timingMarkerPlacement) return;
    updateSession(activeSession.id, (session) => ({
      ...session,
      timingMarkerPlacement: createTimingMarkerPlacement(
        session,
        "pair",
        initialTimingMarkerSample(session),
      ),
      timingMarkers: session.timingMarkers.map((marker) => ({ ...marker, selected: false })),
      message: "Click twice on the graph to place a marker pair",
    }));
  }

  function handleAddSingleMarker() {
    openSidebarPanel("timingMarkers");
    if (!activeSession) return;
    if (!activeSession.summary) {
      updateSession(activeSession.id, (session) => ({
        ...session,
        message: "Capture data before adding a single marker",
      }));
      return;
    }
    if (activeSession.busy) {
      updateSession(activeSession.id, (session) => ({
        ...session,
        message: "Timing markers are disabled while recording",
      }));
      return;
    }
    if (activeSession.timingMarkerPlacement) return;
    updateSession(activeSession.id, (session) => ({
      ...session,
      timingMarkerPlacement: createTimingMarkerPlacement(
        session,
        "single",
        initialTimingMarkerSample(session),
      ),
      timingMarkers: session.timingMarkers.map((marker) => ({ ...marker, selected: false })),
      message: "Click on the graph to place a single marker",
    }));
  }

  function initialTimingMarkerSample(session: UiSession) {
    const pointerX = lastPointerXRef.current;
    const stage = document.querySelector<HTMLElement>(".timingMarkerStage");
    if (pointerX == null || !stage) return undefined;
    const rect = stage.getBoundingClientRect();
    if (pointerX < rect.left || pointerX > rect.right) return undefined;
    const ratio = (pointerX - rect.left) / Math.max(1, rect.width);
    const total = session.summary?.metadata.sample_count ?? session.viewportSamples;
    return clampSamplePoint(session.viewportStart + ratio * session.viewportSamples, total);
  }

  function addSingleMarkerAtSample(sample: number) {
    if (!activeSession?.summary || activeSession.busy || activeSession.timingMarkerPlacement) return;
    updateSession(activeSession.id, (session) => ({
      ...session,
      timingMarkers: [
        ...session.timingMarkers.map((marker) => ({ ...marker, graphPopupOpen: null, selected: false })),
        createTimingMarker(session, "single", sample),
      ],
      message: "Single marker added",
    }));
  }

  function closeSession(sessionId: string) {
    const target = sessions.find((session) => session.id === sessionId);
    if (!target || target.busy) return;
    const nextSessions = sessions.filter((session) => session.id !== sessionId);
    const targetIndex = sessions.findIndex((session) => session.id === sessionId);
    void releaseGraphSession(sessionId);
    setSessions(nextSessions);
    if (activeSessionId === sessionId) {
      const nextActive = nextSessions[Math.min(targetIndex, nextSessions.length - 1)] ?? null;
      setActiveSessionId(nextActive?.id ?? null);
      if (!nextActive) {
        setSelectedPanel((panel) => (panel === "extensions" ? panel : undefined));
      }
    }
  }

  function createSessionFromFooter(deviceId = selectedDevice) {
    setFooterPopover(null);
    createSession(deviceId);
  }

  function createSessionFromStartScreen(deviceId: string) {
    setDraftSelectedDevice(deviceId);
    createSession(deviceId);
  }

  function duplicateSessionSetup(sessionId: string) {
    const source = sessions.find((session) => session.id === sessionId);
    if (!source || source.busy) return;
    setFooterPopover(null);
    createSession(source.selectedDevice, source);
  }

  useEffect(() => {
    if (!selectedPanel) return;
    const allowed = getSidebarPanelAllowed(selectedPanel, activeSession);
    if (!allowed.isVisible || !allowed.isSelectable) {
      setSelectedPanel(undefined);
    }
  }, [activeSession, selectedPanel]);

  useEffect(() => {
    const shortcutState = sidebarShortcutRef.current;
    function clearShortcutSequence() {
      shortcutState.prefix = null;
      if (shortcutState.timeout !== null) {
        window.clearTimeout(shortcutState.timeout);
        shortcutState.timeout = null;
      }
    }

    function isEditableTarget(target: EventTarget | null) {
      if (!(target instanceof HTMLElement)) return false;
      const tagName = target.tagName.toLowerCase();
      return tagName === "input" || tagName === "textarea" || tagName === "select" || target.isContentEditable;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (isEditableTarget(event.target)) return;

      const key = event.key.toLowerCase();
      const hasCommandModifier = event.metaKey || event.ctrlKey;
      const hasSelectedTimingMarker = Boolean(activeSession?.timingMarkers.some((marker) => marker.selected));

      if (key === "escape" && activeSession?.timingMarkerPlacement) {
        event.preventDefault();
        updateSession(activeSession.id, (session) => ({
          ...session,
          timingMarkerPlacement: null,
          message: "Timing marker placement canceled",
        }));
        return;
      }

      if (key === "escape" && hasSelectedTimingMarker && activeSession) {
        event.preventDefault();
        updateSession(activeSession.id, (session) => ({
          ...session,
          timingMarkers: session.timingMarkers.map((marker) => ({
            ...marker,
            graphPopupOpen: null,
            selected: false,
          })),
        }));
        return;
      }

      if (!hasCommandModifier && !event.altKey && (key === "backspace" || key === "delete") && hasSelectedTimingMarker && activeSession) {
        event.preventDefault();
        updateSession(activeSession.id, (session) => {
          const deleted = session.timingMarkers.filter((marker) => marker.selected && !marker.isCaptureTrigger).length;
          return {
            ...session,
            timingMarkers: session.timingMarkers.filter((marker) => !marker.selected || marker.isCaptureTrigger),
            message: `${deleted} timing marker${deleted === 1 ? "" : "s"} deleted`,
          };
        });
        return;
      }

      if (hasCommandModifier && !event.altKey && key === "a" && hasSelectedTimingMarker && activeSession) {
        event.preventDefault();
        updateSession(activeSession.id, (session) => ({
          ...session,
          timingMarkers: session.timingMarkers.map((marker) => ({ ...marker, selected: true })),
        }));
        return;
      }

      if (hasCommandModifier && !event.altKey && key === "g") {
        event.preventDefault();
        clearShortcutSequence();
        invokeCommand(MeasurementCommands.AddRange);
        return;
      }

      if (hasCommandModifier && !event.altKey && key === "t") {
        event.preventDefault();
        clearShortcutSequence();
        invokeCommand(event.shiftKey ? MarkerCommands.AddMarker : MarkerCommands.AddPair);
        return;
      }

      if (key === "shift" && activeSession?.summary && !activeSession.rangePlacement && !event.repeat) {
        updateSession(activeSession.id, (session) => ({
          ...session,
          rangePlacement: {
            channelIndex: null,
            currentSample: null,
            startedBy: "selectionKey",
            startSample: null,
          },
          message: "Click and drag over a channel to add a range measurement",
        }));
        return;
      }

      if (event.metaKey || event.ctrlKey || event.altKey) return;

      if (shortcutState.prefix) {
        const prefix = shortcutState.prefix;
        clearShortcutSequence();
        if (prefix === "m" && key === "d" && hasSelectedTimingMarker && activeSession) {
          event.preventDefault();
          updateSession(activeSession.id, (session) => {
            const deleted = session.timingMarkers.filter((marker) => marker.selected).length;
            return {
              ...session,
              timingMarkers: session.timingMarkers.filter((marker) => !marker.selected),
              message: `${deleted} timing marker${deleted === 1 ? "" : "s"} deleted`,
            };
          });
          return;
        }
        const command = prefix === "n" ? SIDEBAR_SHORTCUT_TO_COMMAND[key] : undefined;
        if (command) {
          event.preventDefault();
          invokeCommand(command);
        }
        return;
      }

      if (activeSession?.summary) {
        const viewportCenter = activeSession.viewportStart + activeSession.viewportSamples / 2;
        const viewportAnchor = activeSession.viewportStart + activeSession.viewportSamples * graphPointerRatioRef.current;
        if (key === "arrowup" || key === "=" || key === "w") {
          event.preventDefault();
          event.stopImmediatePropagation();
          const samples = activeSession.viewportSamples * 0.5;
          stepViewport(
            activeSession.id,
            {
              anchor_ratio: graphPointerRatioRef.current,
              duration_ms: ZOOM_ANIMATION_DURATION_MS,
              factor: 0.5,
              kind: "zoom",
            },
            viewportAnchor - samples * graphPointerRatioRef.current,
            samples,
          );
          return;
        }
        if (key === "arrowdown" || key === "-" || key === "s") {
          event.preventDefault();
          event.stopImmediatePropagation();
          const samples = activeSession.viewportSamples * 2;
          stepViewport(
            activeSession.id,
            {
              anchor_ratio: graphPointerRatioRef.current,
              duration_ms: ZOOM_ANIMATION_DURATION_MS,
              factor: 2,
              kind: "zoom",
            },
            viewportAnchor - samples * graphPointerRatioRef.current,
            samples,
          );
          return;
        }
        if (key === "arrowleft" || key === "a") {
          event.preventDefault();
          event.stopImmediatePropagation();
          stepViewport(
            activeSession.id,
            {
              delta_samples: -activeSession.viewportSamples / 3,
              duration_ms: ZOOM_ANIMATION_DURATION_MS,
              kind: "pan_samples",
            },
            activeSession.viewportStart - activeSession.viewportSamples / 3,
            activeSession.viewportSamples,
          );
          return;
        }
        if (key === "arrowright" || key === "d") {
          event.preventDefault();
          event.stopImmediatePropagation();
          stepViewport(
            activeSession.id,
            {
              delta_samples: activeSession.viewportSamples / 3,
              duration_ms: ZOOM_ANIMATION_DURATION_MS,
              kind: "pan_samples",
            },
            activeSession.viewportStart + activeSession.viewportSamples / 3,
            activeSession.viewportSamples,
          );
          return;
        }
      }

      if (key === "c" && getSidebarPanelAllowed("cursors", activeSession).isSelectable && activeSession) {
        event.preventDefault();
        updateSession(activeSession.id, (session) => ({
          ...session,
          cursorState: { ...session.cursorState, visible: !session.cursorState.visible },
        }));
        return;
      }

      if (key === "n") {
        event.preventDefault();
        shortcutState.prefix = "n";
        shortcutState.timeout = window.setTimeout(clearShortcutSequence, 900);
        return;
      }

      if (key === "m" && hasSelectedTimingMarker) {
        event.preventDefault();
        shortcutState.prefix = "m";
        shortcutState.timeout = window.setTimeout(clearShortcutSequence, 900);
      }
    }

    function handleKeyUp(event: KeyboardEvent) {
      if (isEditableTarget(event.target)) return;
      if (event.key.toLowerCase() !== "shift") return;
      if (activeSession?.rangePlacement?.startedBy !== "selectionKey") return;
      if (activeSession.rangePlacement.startSample !== null) return;
      updateSession(activeSession.id, (session) => ({
        ...session,
        rangePlacement: null,
        message: "Range measurement placement canceled",
      }));
    }

    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("keyup", handleKeyUp);
    return () => {
      clearShortcutSequence();
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("keyup", handleKeyUp);
    };
  });

  // The footer reports the horizontal range — the time the viewport spans — rather
  // than samples per pixel. "S/px" describes the renderer's sampling, which is not
  // something the user reasons about; the span is, and it is the number Logic 2
  // shows in this corner.
  const zoomLabel =
    activeSession?.summary && activeSession.viewportSamples > 0
      ? formatSeconds(
          activeSession.viewportSamples /
            Math.max(1, activeSession.summary.metadata.sample_rate_hz),
        )
      : "Zoom";
  const analyzerEditSession = analyzerInEdit
    ? sessions.find((session) => session.id === analyzerInEdit.sessionId) ?? null
    : null;

  return (
    <main className="logic-root">
      <section className="appContent">
        <header className="logic-windowbar">
          <div className="product-mark">
            <Activity size={15} />
            <span>SigPilot</span>
          </div>
          <div className="window-status">
            <span>{activeMessage}</span>
          </div>
          <div className="window-actions">
            <button className="tool-button text-tool" title="Open capture" onClick={handleOpen}>
              <FolderOpen size={14} />
              Open
            </button>
            <button
              className="tool-button text-tool"
              title="Save capture"
              onClick={handleSave}
              disabled={!activeSession?.summary || activeSession.busy}
            >
              <Save size={14} />
              Save
            </button>
          </div>
        </header>

        <section className={`mainArea ${activeSession ? "" : "emptySession"}`}>
          <section className="graphRowsMain">
            <div className="topArea">
              <div className="channelLabelHeader">
                <span className="channelCounter">
                  {activeSession
                    ? `${visibleChannelIndexes.length + visibleAnalogChannelEntries.length} Channels`
                    : "Select Device"}
                </span>
              </div>
              <div className="aboveGraph">
                <TimingDisplayCanvas
                  graphWidthPx={activeSession?.canvasWidth ?? 0}
                  sampleRateHz={activeSession?.summary?.metadata.sample_rate_hz ?? activeSettings.sample_rate_hz}
                  sessionId={activeSession?.id}
                  timeOriginSample={activeSession?.summary?.metadata.trigger?.sample_index ?? 0}
                  viewportSamples={activeSession?.summary ? activeSession.viewportSamples : 0}
                  viewportStart={activeSession?.summary ? activeSession.viewportStart : 0}
                />
                <LogicToolbar
                  availableAnalyzers={availableAnalyzers}
                  busy={Boolean(activeSession?.busy)}
                  hasCapture={Boolean(activeSession?.summary)}
                  memoryUsage={activeSession?.memoryUsage ?? null}
                  readOnly={Boolean(activeSession?.readOnly)}
                  onCommand={invokeCommand}
                  onFit={fitViewport}
                  onStart={handleCapture}
                  onStop={handleCancel}
                  onZoomIn={() => zoomViewport(0.5)}
                  onZoomOut={() => zoomViewport(2)}
                />
              </div>
            </div>

            {activeSession ? (
              <>
                <div className="graph rowV2" onScroll={handleGraphScroll} ref={graphScrollerRef}>
                  <div
                    className="contentContainer rowV2"
                    style={{ height: graphContentHeight, minHeight: graphContentHeight }}
                  >
                    <div className="labelsBackground" />
                    <DragDropContext
                      onDragEnd={finishChannelReorder}
                      onDragStart={beginChannelReorder}
                    >
                      <StrictModeDroppable droppableId={`channel-labels-${activeSession.id}`}>
                        {(droppableProvided) => (
                          <div
                            className={`channelLabels ${channelReorderActive ? "reorderingActive" : ""}`}
                            ref={droppableProvided.innerRef}
                            {...droppableProvided.droppableProps}
                          >
                            {visibleChannelIndexes.map((channelIndex, rowIndex) => (
                              <Draggable
                                draggableId={`channel-${channelIndex}`}
                                index={rowIndex}
                                key={channelIndex}
                              >
                                {(draggableProvided, draggableSnapshot) => (
                                  <div
                                    className={[
                                      "channelDragItem",
                                      draggableSnapshot.isDragging ? "dragging" : "",
                                      draggableSnapshot.isDropAnimating ? "dropping" : "",
                                    ]
                                      .filter(Boolean)
                                      .join(" ")}
                                    data-channel-index={channelIndex}
                                    ref={draggableProvided.innerRef}
                                    {...draggableProvided.draggableProps}
                                    onMouseDown={() => {
                                      const { activeElement } = document;
                                      if (activeElement instanceof HTMLElement) activeElement.blur();
                                    }}
                                    style={{
                                      ...draggableProvided.draggableProps.style,
                                      height: visibleOuterRowHeights[rowIndex],
                                      zIndex: draggableSnapshot.isDragging ? 5000 : undefined,
                                    }}
                                  >
                                    <div className="channelLabelCell">
                                      <ChannelLabelRow
                                        analyzers={activeSession.analyzers}
                                        dragHandleProps={draggableProvided.dragHandleProps}
                                        index={channelIndex}
                                        isDragging={draggableSnapshot.isDragging}
                                        isEditing={editingChannel === channelIndex}
                                        isEnabled
                                        isTrigger={activeSession.deviceSettings.triggerChannel === channelIndex}
                                        label={visibleChannelLabels[rowIndex]}
                                        onContextMenu={(event) => {
                                          event.preventDefault();
                                          setEditingChannel(null);
                                          setChannelContextMenu({
                                            channelIndex,
                                            source: "label",
                                            x: event.clientX,
                                            y: event.clientY,
                                          });
                                        }}
                                        onEditEnd={() => setEditingChannel(null)}
                                        onEditStart={() => {
                                          setChannelContextMenu(null);
                                          setEditingChannel(channelIndex);
                                        }}
                                        onRename={(name) => renameChannelLabel(channelIndex, name)}
                                      />
                                    </div>
                                    <div className="channelDragWaveformGhost" aria-hidden="true">
                                      {channelReorderActive && (
                                        <ChannelDragWaveformPreview
                                          rowHeight={visibleOuterRowHeights[rowIndex]}
                                          rowTop={visibleChannelLayouts[rowIndex]?.outerTop ?? 0}
                                        />
                                      )}
                                    </div>
                                  </div>
                                )}
                              </Draggable>
                            ))}
                            {droppableProvided.placeholder}
                            {visibleAnalogChannelEntries.map(({ index, settings }, analogRowIndex) => (
                              <div
                                className="channelDragItem analogChannelDragItem"
                                data-analog-channel-index={index}
                                key={`analog-${index}`}
                                style={{ height: visibleAnalogRowHeights[analogRowIndex] }}
                              >
                                <div className="channelLabelCell">
                                  <AnalogChannelLabelRow index={index} settings={settings} />
                                </div>
                                <div className="channelDragWaveformGhost" aria-hidden="true" />
                              </div>
                            ))}
                          </div>
                        )}
                      </StrictModeDroppable>
                    </DragDropContext>
                    {channelContextMenu && (
                      <ChannelContextMenu
                        channelIndex={channelContextMenu.channelIndex}
                        channelLabel={channelLabels[channelContextMenu.channelIndex] ?? `D${channelContextMenu.channelIndex}`}
                        autoLayoutEnabled={!activeSession.manualChannelLayout}
                        channelRows={contextMenuChannelRows}
                        hasCapture={Boolean(activeSession.summary)}
                        hasHiddenChannels={contextMenuChannelRows.some((row) => row.isSelectable && row.isHidden)}
                        interactiveMeasurementVisible={activeSession.showInteractiveMeasurement}
                        onClose={() => setChannelContextMenu(null)}
                        onDeleteDataAfter={() => previewChannelTrim("after")}
                        onDeleteDataBefore={() => previewChannelTrim("before")}
                        onDeleteDataOffscreen={() => previewChannelTrim("offscreen")}
                        onFitAllRows={fitAllRowsToWindowHeight}
                        onHideChannel={() => hideChannelRow(channelContextMenu.channelIndex)}
                        onMatchAllHeights={() => matchAllDigitalChannelHeights(channelContextMenu.channelIndex)}
                        onOpenSettings={() => setPreferencesOpen(true)}
                        onResetChannelNames={resetChannelNames}
                        onScreenshotChannel={() => takeContextScreenshot("channel")}
                        onScreenshotWindow={() => takeContextScreenshot("window")}
                        onShowAllChannels={showAllChannelRows}
                        onSetScreenshotDestination={setScreenshotDestination}
                        onToggleAutoLayout={toggleAutoLayout}
                        onToggleChannelVisibility={toggleChannelRowVisibility}
                        onToggleInteractiveMeasurement={toggleInteractiveMeasurement}
                        refElement={channelContextMenuRef}
                        screenshotDestination={screenshotSettings.destination}
                        x={channelContextMenu.x}
                        y={channelContextMenu.y}
                      />
                    )}
                    <div className="graphViewport">
                      <WaveformCanvas
                        isLive={activeSession.busy}
                        sessionId={activeSession.id}
                        maximumViewportSamples={activeSession.viewportMaxSamples ?? undefined}
                        rowHeights={visibleOuterRowHeights}
                        rowTopInsets={visibleAnalyzerInsets}
                        tile={visibleTile}
                        matchChannelColors={preferences.matchChannelColors}
                        onWidthChange={(width) =>
                          updateSession(activeSession.id, (session) => ({
                            ...session,
                            // Never let a non-finite measurement reach the frame
                            // request: it would serialise to `null` and the backend
                            // would reject every frame, blanking the graph.
                            canvasWidth: Number.isFinite(width) ? Math.max(1, width) : session.canvasWidth,
                          }))
                        }
                        sampleRateHz={activeSession.summary?.metadata.sample_rate_hz ?? activeSession.settings.sample_rate_hz}
                        timeOriginSample={activeSession.summary?.metadata.trigger?.sample_index ?? 0}
                        showInteractiveMeasurement={activeSession.showInteractiveMeasurement}
                        totalSamples={totalSamples}
                        viewportStart={activeSession.viewportStart}
                        viewportSamples={activeSession.viewportSamples}
                        onOpenContextMenu={({ channelIndex, clientX, clientY, sample }) => {
                          setEditingChannel(null);
                          setChannelContextMenu({
                            channelIndex,
                            sample,
                            source: "graph",
                            x: clientX,
                            y: clientY,
                          });
                        }}
                        onPointerPositionChange={(xRatio) => {
                          graphPointerRatioRef.current = xRatio;
                        }}
                        onViewportChange={(start, samples) => updateViewport(activeSession.id, start, samples)}
                        onViewportInteractionChange={(active) =>
                          setGraphViewportInteraction("waveform", active)
                        }
                      />
                      <AnalogWaveformOverlay
                        analogSampleRateHz={activeSession.deviceSettings.analogSampleRateHz}
                        channels={visibleAnalogChannelEntries}
                        digitalSampleRateHz={activeSession.summary?.metadata.sample_rate_hz ?? activeSession.settings.sample_rate_hz}
                        hasCapture={Boolean(activeSession.summary)}
                        hasDemoData={selected?.kind === "Fake"}
                        isLive={activeSession.busy}
                        layouts={visibleAnalogLayouts}
                        matchChannelColors={preferences.matchChannelColors}
                        onChange={updateAnalogChannel}
                        onViewportChange={(start, samples) => updateViewport(activeSession.id, start, samples)}
                        onViewportInteractionChange={(active) =>
                          setGraphViewportInteraction("waveform", active)
                        }
                        sessionId={activeSession.id}
                        totalSamples={totalSamples}
                        viewportSamples={activeSession.viewportSamples}
                        viewportStart={activeSession.viewportStart}
                      />
                      <AnalyzerBubblesOverlay
                        analyzers={activeSession.analyzers}
                        onGoToFrame={(analyzerId, frameIndex, frame) =>
                          goToAnalyzerFrame(analyzerId, frameIndex, false, frame)
                        }
                        onOpenTableFrame={openAnalyzerTableFrame}
                        onSelectFrame={(analyzerId, frameIndex) =>
                          selectAnalyzerFrame(activeSession.id, analyzerId, frameIndex)
                        }
                        onZoomBubble={zoomAnalyzerBubble}
                        rowHeights={visibleOuterRowHeights}
                        rowTopInsets={visibleAnalyzerInsets}
                        sessionId={activeSession.id}
                        tile={visibleTile}
                        viewportSamples={activeSession.viewportSamples}
                        viewportStart={activeSession.viewportStart}
                        visibleChannelIndexes={visibleChannelIndexes}
                      />
                      <CursorOverlay
                        onUpdateSession={(updater) => updateSession(activeSession.id, updater)}
                        session={activeSession}
                      />
                      <RangeMeasurementsOverlay
                        onOpenExtensions={() => setSelectedPanel("extensions")}
                        onUpdateSession={(updater) => updateSession(activeSession.id, updater)}
                        rowHeights={visibleOuterRowHeights}
                        rowTopInsets={visibleAnalyzerInsets}
                        session={activeSession}
                        tile={visibleTile}
                        visibleChannelIndexes={visibleChannelIndexes}
                      />
                      {activePendingChannelTrim && (
                        <ChannelTrimOverlay
                          range={activePendingChannelTrim.range}
                          viewportSamples={activeSession.viewportSamples}
                          viewportStart={activeSession.viewportStart}
                        />
                      )}
                    </div>
                    {visibleChannelIndexes.map((channelIndex, rowIndex) => (
                      <ChannelResizeHandle
                        channelIndex={channelIndex}
                        height={visibleChannelHeights[rowIndex]}
                        key={channelIndex}
                        onResize={(height) => setChannelHeight(channelIndex, height)}
                        top={saleaeChannelResizeHandleTop(visibleOuterRowHeights, rowIndex)}
                      />
                    ))}
                    {visibleAnalogChannelEntries.map(({ index, settings }, rowIndex) => (
                      <ChannelResizeHandle
                        channelIndex={index}
                        height={settings.height}
                        key={`analog-resize-${index}`}
                        label={`A${index}`}
                        minHeight={ANALOG_ROW_MIN_HEIGHT_PX}
                        onResize={(height) => updateAnalogChannel(index, { height })}
                        top={saleaeChannelResizeHandleTop(
                          allVisibleRowHeights,
                          visibleOuterRowHeights.length + rowIndex,
                        )}
                      />
                    ))}
                  </div>
                </div>

                {activeSession.summary && (
                  <div className="horizontalScrollBar">
                    <StripChartScrollbar
                      onViewportStartChange={(startSample) =>
                        updateViewport(activeSession.id, startSample, activeSession.viewportSamples)
                      }
                      sessionId={activeSession.id}
                      totalSamples={totalSamples}
                      viewportSamples={activeSession.viewportSamples}
                      viewportStart={activeSession.viewportStart}
                    />
                  </div>
                )}
                {activeSession.summary && (
                  <TimingMarkersOverlay
                    markers={activeSession.timingMarkers}
                    onChangeMarkers={(updater) =>
                      updateSession(activeSession.id, (session) => ({
                        ...session,
                        timingMarkers: updater(session.timingMarkers),
                      }))
                    }
                    onChangePlacement={(updater) =>
                      updateSession(activeSession.id, (session) => ({
                        ...session,
                        timingMarkerPlacement: updater(session.timingMarkerPlacement),
                      }))
                    }
                    onMessage={(message) =>
                      updateSession(activeSession.id, (session) => ({ ...session, message }))
                    }
                    onAddSingleMarker={addSingleMarkerAtSample}
                    onOpenSidebar={() => openSidebarPanel("timingMarkers")}
                    onViewportChange={(start, samples) =>
                      stepViewport(
                        activeSession.id,
                        {
                          duration_ms: ZOOM_ANIMATION_DURATION_MS,
                          kind: "animate_to",
                          samples,
                          start_sample: start,
                        },
                        start,
                        samples,
                      )
                    }
                    placement={activeSession.timingMarkerPlacement}
                    rowHeights={visibleOuterRowHeights}
                    rowTopInsets={visibleAnalyzerInsets}
                    sampleRateHz={activeSession.summary.metadata.sample_rate_hz}
                    sessionId={activeSession.id}
                    tile={visibleTile}
                    totalSamples={totalSamples}
                    viewportSamples={activeSession.viewportSamples}
                    viewportStart={activeSession.viewportStart}
                    viewportInteracting={graphViewportInteracting}
                  />
                )}
              </>
            ) : (
              <DeviceStartScreen
                busy={false}
                devices={devices}
                onCreateSessionWithDevice={createSessionFromStartScreen}
                onOpenCapture={handleOpen}
                onRefreshDevices={refreshDevices}
                onSelectDevice={setSelectedDeviceForActive}
                selectedDevice={selectedDevice}
              />
            )}
          </section>

          <RightSidebar
            availableAnalyzers={availableAnalyzers}
            devices={devices}
            extensions={extensions}
            onChangeExtensions={(updater) => setExtensions((current) => updater(current))}
            onCreateSession={createSessionFromFooter}
            onAddAnalyzer={handleAddAnalyzer}
            onAddRangeMeasurement={handleAddRangeMeasurement}
            onAddMarkerPair={handleAddMarkerPair}
            onAddSingleMarker={handleAddSingleMarker}
            onDecodeAnalyzer={(analyzerId) => activeSession && handleDecodeAnalyzer(activeSession.id, analyzerId)}
            onEditAnalyzer={beginEditAnalyzer}
            onGoToAnalyzerFrame={(analyzerId, frameIndex, zoom, frame) =>
              goToAnalyzerFrame(analyzerId, frameIndex, zoom, frame)
            }
            onNotify={(message) => {
              if (activeSession) {
                updateSession(activeSession.id, (session) => ({ ...session, message }));
              } else {
                setStartupMessage(message);
              }
            }}
            onRefreshDevices={refreshDevices}
            onSelectDevice={setSelectedDeviceForActive}
            onSelectPanel={toggleSidebarPanel}
            onSidebarPanelWidthChange={(width) => setSidebarPanelWidth(clampSidebarPanelWidth(width))}
            onUpdateSession={(updater) => {
              if (activeSession) updateSession(activeSession.id, updater);
            }}
            onUpdateSettings={updateActiveSettings}
            onViewportChange={(start, samples) => {
              if (activeSession) {
                stepViewport(
                  activeSession.id,
                  {
                    duration_ms: ZOOM_ANIMATION_DURATION_MS,
                    kind: "animate_to",
                    samples,
                    start_sample: start,
                  },
                  start,
                  samples,
                );
              }
            }}
            selectedDevice={selectedDevice}
            selectedCapabilities={selectedCapabilities}
            selectedPanel={selectedPanel}
            sidebarPanelWidth={sidebarPanelWidth}
            session={activeSession}
          />
        </section>

        {activePendingChannelTrim && activeSession && (
          <ChannelTrimDialog
            mode={activePendingChannelTrim.mode}
            onCancel={cancelPendingChannelTrim}
            onConfirm={() => void confirmPendingChannelTrim()}
            range={activePendingChannelTrim.range}
            sampleRateHz={activeSession.summary?.metadata.sample_rate_hz}
          />
        )}
        {screenshotNotification && (
          <ScreenshotToast
            body={screenshotNotification.body}
            heading={screenshotNotification.heading}
            onClose={() => setScreenshotNotification(null)}
            type={screenshotNotification.type}
          />
        )}
        {analyzerInEdit && analyzerEditSession && (
          <AnalyzerSettingsDialog
            analyzer={analyzerInEdit.analyzer}
            capturedChannelCount={analyzerEditSession.summary?.metadata.channel_count ?? 0}
            channelEnabled={analyzerEditSession.deviceSettings.digitalChannels}
            channelLabels={
              channelLabelsForCount(
                captureChannelLimit(analyzerEditSession),
                analyzerEditSession.channelLabels,
              )
            }
            onCancel={() => setAnalyzerInEdit(null)}
            onSave={saveAnalyzerSettings}
          />
        )}

        {preferencesOpen && (
          <PreferencesDialog
            onChange={setPreferences}
            onClose={() => setPreferencesOpen(false)}
            preferences={preferences}
          />
        )}

        <BottomBar
          activeSessionId={activeSessionId}
          devices={devices}
          footerPopover={footerPopover}
          onCloseSession={closeSession}
          onCreateSession={createSessionFromFooter}
          onDuplicateSession={duplicateSessionSetup}
          onRefreshDevices={refreshDevices}
          onRenameSession={(sessionId, name) =>
            updateSession(sessionId, (session) =>
              session.readOnly ? session : { ...session, name: name.trim() ? name : session.name },
            )
          }
          onSelectDevice={setSelectedDeviceForActive}
          onSelectSession={setActiveSessionId}
          onSetFooterPopover={setFooterPopover}
          onZoomFit={fitViewport}
          onZoomIn={() => zoomViewport(0.5)}
          onZoomOut={() => zoomViewport(2)}
          progressPercent={progressPercent}
          refElement={footerRef}
          selectedDevice={selectedDevice}
          selectedDeviceReady={Boolean(selected?.ready)}
          sessions={sessions}
          status={activeMessage}
          summary={activeSession?.summary ?? null}
          zoomLabel={zoomLabel}
        />
      </section>
    </main>
  );
}

function StrictModeDroppable({ children, ...props }: DroppableProps) {
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setEnabled(true));
    return () => {
      window.cancelAnimationFrame(frame);
      setEnabled(false);
    };
  }, []);

  if (!enabled) return null;
  return <Droppable {...props}>{children}</Droppable>;
}

function SaleaeSidebarIcon({ iconUrl }: { iconUrl: string }) {
  return (
    <span
      aria-hidden="true"
      className="saleaeSidebarIcon"
      style={{ "--sidebar-icon-url": `url(${iconUrl})` } as CSSProperties}
    />
  );
}

function ChannelLabelRow({
  analyzers,
  dragHandleProps,
  index,
  isDragging,
  isEditing,
  isEnabled,
  isTrigger,
  label,
  onContextMenu,
  onEditEnd,
  onEditStart,
  onRename,
}: {
  analyzers: UiAnalyzerInstance[];
  dragHandleProps: DraggableProvidedDragHandleProps | null | undefined;
  index: number;
  isDragging: boolean;
  isEditing: boolean;
  isEnabled: boolean;
  isTrigger: boolean;
  label: string;
  onContextMenu: (event: ReactMouseEvent<HTMLDivElement>) => void;
  onEditEnd: () => void;
  onEditStart: () => void;
  onRename: (name: string) => void;
}) {
  const [draft, setDraft] = useState(label);
  const inputRef = useRef<HTMLInputElement>(null);
  const analyzerRoleRows = useMemo(
    () =>
      analyzers.flatMap((analyzer) =>
        analyzerChannelRoles(analyzer)
          .filter((role) => role.channel === index)
          .map((role) => ({
            color: analyzer.color,
            id: `${analyzer.id}-${role.title}`,
            label: analyzerChannelRoleLabel(analyzer, role),
          })),
      ),
    [analyzers, index],
  );

  useEffect(() => {
    if (!isEditing) {
      setDraft(label);
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [isEditing, label]);

  function commit() {
    onRename(draft);
    onEditEnd();
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      commit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      setDraft(label);
      onEditEnd();
    }
  }

  return (
    <div
      className={["channelRow", isEnabled ? "" : "disabled", isTrigger ? "triggerChannel" : "", isDragging ? "reordering" : ""].filter(Boolean).join(" ")}
      data-channel-index={index}
      {...dragHandleProps}
      onContextMenu={onContextMenu}
      onDoubleClick={onEditStart}
      role="button"
      style={
        {
          "--channel-color": saleaeLegacyChannelColor(index),
        } as CSSProperties
      }
      tabIndex={0}
      title={`${label} - double click to rename`}
    >
      <span className="channelHeader digital small focusable">
        <span className="channelNumber">{index}</span>
      </span>
      <span className="channelText">
        {isEditing ? (
          <input
            aria-label={`Rename D${index}`}
            className="channelNameInput"
            onBlur={commit}
            onChange={(event) => setDraft(event.target.value)}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={handleKeyDown}
            ref={inputRef}
            value={draft}
          />
        ) : (
          <strong>{label}</strong>
        )}
        <small>
          D{index}
          {isTrigger ? " - trigger" : ""}
        </small>
        {analyzerRoleRows.length > 0 && (
          <span className="channelAnalyzerSubtitle">
            {analyzerRoleRows.map((row) => (
              <span className="channelAnalyzerSubtitleRow" key={row.id}>
                <span className="channelAnalyzerSquare" style={{ background: row.color }} />
                <span>{row.label}</span>
              </span>
            ))}
          </span>
        )}
      </span>
    </div>
  );
}

function AnalogChannelLabelRow({
  index,
  settings,
}: {
  index: number;
  settings: UiAnalogChannelSettings;
}) {
  return (
    <div
      className="analogChannelLabelRow"
      style={{ "--analog-channel-color": saleaeLegacyChannelColor(index) } as CSSProperties}
      title={`${settings.label} analog channel`}
    >
      <span className="analogChannelRail">
        <span className="analogChannelBadge">{index}</span>
        <span className="analogChannelRailTicks" aria-hidden="true" />
      </span>
      <span className="channelText">
        <strong>{settings.label}</strong>
        <small>A{index} · Analog</small>
      </span>
    </div>
  );
}

function ChannelDragWaveformPreview({ rowHeight, rowTop }: { rowHeight: number; rowTop: number }) {
  const previewRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const preview = previewRef.current;
    const source = document.querySelector<HTMLCanvasElement>(".graphViewport .waveform-canvas");
    if (!preview || !source) return;

    const sourceRect = source.getBoundingClientRect();
    if (sourceRect.width <= 0 || sourceRect.height <= 0) return;
    const scaleX = source.width / sourceRect.width;
    const scaleY = source.height / sourceRect.height;
    const sourceY = Math.max(0, Math.round(rowTop * scaleY));
    const sourceHeight = Math.max(1, Math.min(source.height - sourceY, Math.round(rowHeight * scaleY)));

    preview.width = Math.max(1, Math.round(sourceRect.width * scaleX));
    preview.height = sourceHeight;
    const context = preview.getContext("2d");
    context?.drawImage(
      source,
      0,
      sourceY,
      source.width,
      sourceHeight,
      0,
      0,
      preview.width,
      preview.height,
    );
  }, [rowHeight, rowTop]);

  return <canvas className="channelDragWaveformPreview" ref={previewRef} />;
}

function ChannelResizeHandle({
  channelIndex,
  height,
  label,
  minHeight = SALEAE_DIGITAL_ROW_V2_MIN_HEIGHT_PX,
  onResize,
  top,
}: {
  channelIndex: number;
  height: number;
  label?: string;
  minHeight?: number;
  onResize: (height: number) => void;
  top: number;
}) {
  const dragRef = useRef<{ pointerId: number; startHeight: number; startY: number } | null>(null);

  function finishDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (!dragRef.current || dragRef.current.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  return (
    <div
      aria-label={`Resize ${label ?? `D${channelIndex}`} height`}
      aria-orientation="horizontal"
      aria-valuemin={minHeight}
      aria-valuenow={Math.round(height)}
      className="channelResizeHandle"
      onPointerCancel={finishDrag}
      onPointerDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.setPointerCapture(event.pointerId);
        dragRef.current = {
          pointerId: event.pointerId,
          startHeight: height,
          startY: event.clientY,
        };
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        event.preventDefault();
        onResize(Math.max(minHeight, drag.startHeight + event.clientY - drag.startY));
      }}
      onPointerUp={finishDrag}
      role="separator"
      style={{ top, height: SALEAE_ROW_V2_SPACING_PX }}
      tabIndex={0}
      title={`Drag to resize ${label ?? `D${channelIndex}`}`}
    />
  );
}

function ChannelTrimOverlay({
  range,
  viewportSamples,
  viewportStart,
}: {
  range: ChannelTrimPreview;
  viewportSamples: number;
  viewportStart: number;
}) {
  const scale = 100 / Math.max(1, viewportSamples);
  const leftWidth =
    range.trimBefore === undefined
      ? 0
      : Math.max(0, Math.min(100, (range.trimBefore - viewportStart) * scale));
  const rightWidth =
    range.trimAfter === undefined
      ? 0
      : Math.max(0, Math.min(100, (viewportStart + viewportSamples - range.trimAfter) * scale));

  return (
    <div className="channelTrimOverlay" aria-hidden="true">
      {leftWidth > 0 && <div className="channelTrimStripe left" style={{ width: `${leftWidth}%` }} />}
      {rightWidth > 0 && <div className="channelTrimStripe right" style={{ width: `${rightWidth}%` }} />}
    </div>
  );
}

function ScreenshotToast({
  body,
  heading,
  onClose,
  type,
}: {
  body: string;
  heading: string;
  onClose: () => void;
  type: "error" | "success";
}) {
  return createPortal(
    <section className={`screenshotToast ${type}`} role="status" aria-live="polite">
      <div className="screenshotToastIcon" aria-hidden="true">
        {type === "success" ? <Check size={14} /> : <X size={14} />}
      </div>
      <div className="screenshotToastCopy">
        <h2>{heading}</h2>
        <p>{body}</p>
      </div>
      <button aria-label="Dismiss screenshot notification" onClick={onClose} type="button">
        <X size={14} />
      </button>
    </section>,
    document.body,
  );
}

function ChannelTrimDialog({
  mode,
  onCancel,
  onConfirm,
  range,
  sampleRateHz,
}: {
  mode: ChannelDeleteDataMode;
  onCancel: () => void;
  onConfirm: () => void;
  range: ChannelTrimPreview;
  sampleRateHz?: number;
}) {
  const keptSamples = Math.max(0, range.trimEnd - range.trimStart);
  const modeLabel =
    mode === "before"
      ? "before this point"
      : mode === "after"
        ? "after this point"
        : "outside the current view";
  const duration = sampleRateHz && sampleRateHz > 0
    ? formatTrimDuration(keptSamples / sampleRateHz)
    : null;

  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onCancel]);

  return createPortal(
    <div
      className="trimDialogLayer"
      onMouseDown={(event) => event.target === event.currentTarget && onCancel()}
      role="presentation"
    >
      <section
        className="trimDialog"
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="trim-dialog-title"
      >
        <header className="trimDialogHeader">
          <h2 id="trim-dialog-title">Delete Data</h2>
          <button aria-label="Cancel Delete Data" onClick={onCancel} type="button">
            <X size={16} />
          </button>
        </header>
        <div className="trimDialogContent">
          <h3>Are you sure?</h3>
          <p>This operation is irreversible. Analyzers will be restarted.</p>
          <p className="trimDialogDetail">
            The highlighted data {modeLabel} will be removed. {duration ? `${duration} remains selected.` : `${formatSamples(keptSamples)} remain selected.`}
          </p>
        </div>
        <footer className="trimDialogActions">
          <button className="trimDialogButton transparent" onClick={onCancel} type="button">
            Cancel
          </button>
          <button className="trimDialogButton primary" onClick={onConfirm} type="button">
            Yes, Delete
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}

function formatTrimDuration(seconds: number) {
  const absolute = Math.abs(seconds);
  if (absolute >= 1) return `${trimCompactNumber(seconds)} s`;
  if (absolute >= 1e-3) return `${trimCompactNumber(seconds * 1e3)} ms`;
  if (absolute >= 1e-6) return `${trimCompactNumber(seconds * 1e6)} us`;
  return `${trimCompactNumber(seconds * 1e9)} ns`;
}

function trimCompactNumber(value: number) {
  return Number(value.toFixed(3)).toString();
}

function screenshotNotificationBody(message: string) {
  if (message === "Screenshot copied to clipboard") return "Screenshot copied to clipboard.";
  const saved = message.match(/^Screenshot saved as (.+)$/);
  if (saved) return `"${saved[1]}" saved to disk.`;
  return message;
}

function resolveChannelScreenshotRect(
  channelIndex: number,
  rowIndex: number,
  fallback: {
    analyzerInset: number;
    fallbackHeight: number;
    fallbackTop?: number;
  },
): ScreenshotCaptureRect | null {
  const graphViewport = document.querySelector<HTMLElement>(".graphViewport");
  const viewportRect = graphViewport?.getBoundingClientRect();
  if (!graphViewport || !viewportRect) return null;

  const selector = `.waveformRowHitTarget[data-channel-index="${channelIndex}"]`;
  const hitTarget = graphViewport.querySelector<HTMLElement>(selector);
  const hitTargetRect = hitTarget?.getBoundingClientRect();
  if (hitTargetRect && hitTargetRect.width > 0 && hitTargetRect.height > 0) {
    return {
      x: viewportRect.left,
      y: hitTargetRect.top,
      width: viewportRect.width,
      height: hitTargetRect.height,
    };
  }

  const labelRow = document.querySelector<HTMLElement>(
    `.channelDragItem[data-channel-index="${channelIndex}"]`,
  );
  const labelRect = labelRow?.getBoundingClientRect();
  if (labelRect && labelRect.height > 0) {
    return {
      x: viewportRect.left,
      y: labelRect.top + fallback.analyzerInset,
      width: viewportRect.width,
      height: Math.max(1, Math.min(fallback.fallbackHeight, labelRect.height - fallback.analyzerInset)),
    };
  }

  const top = fallback.fallbackTop ?? rowIndex * fallback.fallbackHeight;
  return {
    x: viewportRect.left,
    y: viewportRect.top + top + fallback.analyzerInset,
    width: viewportRect.width,
    height: fallback.fallbackHeight,
  };
}

function showScreenshotCaptureFeedback(
  rect: ScreenshotCaptureRect,
  target: "channel" | "window",
  visibleMs: number,
) {
  document.querySelectorAll(".screenshotCaptureFeedback").forEach((element) => element.remove());
  const element = document.createElement("div");
  element.className = `screenshotCaptureFeedback ${target}`;
  element.style.height = `${rect.height}px`;
  element.style.left = `${rect.x}px`;
  element.style.top = `${rect.y}px`;
  element.style.width = `${rect.width}px`;
  document.body.appendChild(element);
  window.setTimeout(() => element.remove(), visibleMs);
}

function ChannelContextMenu({
  autoLayoutEnabled,
  channelIndex,
  channelLabel,
  channelRows,
  hasCapture,
  hasHiddenChannels,
  interactiveMeasurementVisible,
  onClose,
  onDeleteDataAfter,
  onDeleteDataBefore,
  onDeleteDataOffscreen,
  onFitAllRows,
  onHideChannel,
  onMatchAllHeights,
  onOpenSettings,
  onResetChannelNames,
  onScreenshotChannel,
  onScreenshotWindow,
  onSetScreenshotDestination,
  onShowAllChannels,
  onToggleAutoLayout,
  onToggleChannelVisibility,
  onToggleInteractiveMeasurement,
  refElement,
  screenshotDestination,
  x,
  y,
}: {
  autoLayoutEnabled: boolean;
  channelIndex: number;
  channelLabel: string;
  channelRows: { index: number; isHidden: boolean; isSelectable: boolean; label: string }[];
  hasCapture: boolean;
  hasHiddenChannels: boolean;
  interactiveMeasurementVisible: boolean;
  onClose: () => void;
  onDeleteDataAfter: () => void;
  onDeleteDataBefore: () => void;
  onDeleteDataOffscreen: () => void;
  onFitAllRows: () => void;
  onHideChannel: () => void;
  onMatchAllHeights: () => void;
  onOpenSettings: () => void;
  onResetChannelNames: () => void;
  onScreenshotChannel: () => void;
  onScreenshotWindow: () => void;
  onSetScreenshotDestination: (destination: ScreenshotDestination) => void;
  onShowAllChannels: () => void;
  onToggleAutoLayout: () => void;
  onToggleChannelVisibility: (channelIndex: number) => void;
  onToggleInteractiveMeasurement: () => void;
  refElement: RefObject<HTMLDivElement>;
  screenshotDestination: ScreenshotDestination;
  x: number;
  y: number;
}) {
  const menuWidth = 286;
  const submenuWidth = 286;
  const opensLeft = typeof window !== "undefined" && x + menuWidth + submenuWidth + 12 > window.innerWidth;
  const menuLeft =
    typeof window === "undefined" ? x : Math.max(8, Math.min(x, window.innerWidth - menuWidth - 8));
  const menuTop = typeof window === "undefined" ? y : Math.max(8, Math.min(y, window.innerHeight - 540));

  function run(action: () => void, close = true) {
    action();
    if (close) onClose();
  }

  const screenshotDestinationLabel =
    screenshotDestination === "File" ? "Save to File" : "Copy to Clipboard";

  return (
    <div
      className={`channelContextMenu saleaeContextMenu ${opensLeft ? "submenuLeft" : ""}`}
      onContextMenu={(event) => event.preventDefault()}
      ref={refElement}
      role="menu"
      style={{ left: menuLeft, top: menuTop }}
    >
      <ChannelMenuSelectionItem
        label="Resize All Digital Channels to Match"
        onClick={() => run(onMatchAllHeights)}
        tooltip={`Resize the Y-height of all Digital Channels to match D${channelIndex}.`}
      />
      <ChannelMenuSelectionItem
        label="Fit all Rows to Window Height"
        onClick={() => run(onFitAllRows)}
        tooltip="Fit Y-height of all channels to window height"
      />
      <ChannelMenuSelectionItem
        label="Auto Layout"
        onClick={() => run(onToggleAutoLayout)}
        selected={autoLayoutEnabled}
        tooltip="Automatically manage channel height to fit the window"
      />
      <ChannelMenuSeparator />
      <ChannelMenuSelectionItem
        label="Show Interactive Measurement"
        onClick={() => run(onToggleInteractiveMeasurement, false)}
        selected={interactiveMeasurementVisible}
        tooltip="Display a measurement as the mouse moves over the waveform."
      />
      <ChannelMenuSeparator />
      {isChannelDeleteDataVisible(hasCapture) && (
        <>
          <ChannelMenuSubmenu label="Delete Data">
            <ChannelMenuSelectionItem label="Before This Point" onClick={() => run(onDeleteDataBefore)} />
            <ChannelMenuSelectionItem label="After This Point" onClick={() => run(onDeleteDataAfter)} />
            <ChannelMenuSelectionItem label="Off Screen" onClick={() => run(onDeleteDataOffscreen)} />
          </ChannelMenuSubmenu>
          <ChannelMenuSeparator />
        </>
      )}
      <ChannelMenuSelectionItem label="Hide Channel" onClick={() => run(onHideChannel)} />
      <ChannelMenuSubmenu label="Show/Hide Channels">
        <ChannelMenuItem
          disabled={!hasHiddenChannels}
          label="Show All Channels"
          onClick={() => run(onShowAllChannels, false)}
        />
        <ChannelMenuSeparator />
        <div className="channelVisibilityRows">
          {channelRows.map((row) => (
            <ChannelMenuSelectionItem
              disabled={!row.isSelectable}
              key={row.index}
              label={`${row.index}. ${row.label}`}
              onClick={() => run(() => onToggleChannelVisibility(row.index), false)}
              selected={row.isSelectable && !row.isHidden}
            />
          ))}
        </div>
      </ChannelMenuSubmenu>
      <ChannelMenuSeparator />
      <ChannelMenuSelectionItem
        label="Reset Channel Names"
        onClick={() => run(onResetChannelNames)}
        tooltip="Reset all the Channels Names to their default labels."
      />
      <ChannelMenuSeparator />
      <ChannelMenuSelectionItem label="Settings" onClick={() => run(onOpenSettings)} />
      <ChannelMenuSeparator />
      <ChannelMenuSelectionItem
        label={`Screenshot ${channelLabel}`}
        onClick={() => run(onScreenshotChannel)}
      />
      <ChannelMenuSelectionItem
        label="Screenshot Window"
        onClick={() => run(onScreenshotWindow)}
      />
      <ChannelMenuSubmenu label={`Screenshot Destination [${screenshotDestinationLabel}]`}>
        <ChannelMenuSelectionItem
          label="Save to File"
          onClick={() => run(() => onSetScreenshotDestination("File"), false)}
          selected={screenshotDestination === "File"}
        />
        <ChannelMenuSelectionItem
          label="Copy to Clipboard"
          onClick={() => run(() => onSetScreenshotDestination("Clipboard"), false)}
          selected={screenshotDestination === "Clipboard"}
        />
      </ChannelMenuSubmenu>
    </div>
  );
}

function ChannelMenuSubmenu({
  children,
  disabled = false,
  label,
  tooltip,
}: {
  children: ReactNode;
  disabled?: boolean;
  label: string;
  tooltip?: string;
}) {
  return (
    <div className={`channelContextSubmenu ${disabled ? "disabled" : ""}`} role="none">
      <button
        className="channelContextItem selectable submenuTrigger"
        data-tooltip={tooltip}
        disabled={disabled}
        role="menuitem"
        type="button"
      >
        <span className="channelContextCheckmark" />
        <span className="channelContextLabel">{label}</span>
        <ChevronRight aria-hidden size={14} />
      </button>
      {!disabled && (
        <div className="channelContextSubmenuPanel" role="menu">
          {children}
        </div>
      )}
    </div>
  );
}

function ChannelMenuItem({
  disabled = false,
  label,
  onClick,
  shortcut,
  tooltip,
}: {
  disabled?: boolean;
  label: string;
  onClick: () => void;
  shortcut?: string;
  tooltip?: string;
}) {
  return (
    <button
      className="channelContextItem"
      data-tooltip={tooltip}
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        if (!disabled) onClick();
      }}
      role="menuitem"
      type="button"
    >
      <span className="channelContextLabel">{label}</span>
      {shortcut && <span className="channelContextShortcut">{shortcut}</span>}
    </button>
  );
}

function ChannelMenuSelectionItem({
  disabled = false,
  label,
  onClick,
  selected = false,
  shortcut,
  tooltip,
}: {
  disabled?: boolean;
  label: string;
  onClick: () => void;
  selected?: boolean;
  shortcut?: string;
  tooltip?: string;
}) {
  return (
    <button
      className={`channelContextItem selectable ${selected ? "selected" : ""}`}
      data-tooltip={tooltip}
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        if (!disabled) onClick();
      }}
      role="menuitemcheckbox"
      aria-checked={selected}
      type="button"
    >
      <span className="channelContextCheckmark">{selected && <Check aria-hidden size={12} />}</span>
      <span className="channelContextLabel">{label}</span>
      {shortcut && <span className="channelContextShortcut">{shortcut}</span>}
    </button>
  );
}

function ChannelMenuSeparator() {
  return <div className="channelContextSeparator" role="separator" />;
}

function CursorOverlay({
  onUpdateSession,
  session,
}: {
  onUpdateSession: (updater: (session: UiSession) => UiSession) => void;
  session: UiSession;
}) {
  const dragRef = useRef<"x1Sample" | "x2Sample" | null>(null);
  const totalSamples = session.summary?.metadata.sample_count ?? 0;
  if (!session.cursorState.visible || !session.summary || totalSamples <= 0) return null;

  function sampleToPercent(sample: number) {
    const ratio = (sample - session.viewportStart) / Math.max(1, session.viewportSamples);
    return Math.max(0, Math.min(1, ratio)) * 100;
  }

  function updateCursorFromClientX(clientX: number, host: HTMLElement) {
    const key = dragRef.current;
    if (!key) return;
    const rect = host.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
    const sample = Math.round(session.viewportStart + ratio * session.viewportSamples);
    const nextSample = Math.max(0, Math.min(totalSamples - 1, sample));
    onUpdateSession((current) => ({
      ...current,
      cursorState: { ...current.cursorState, [key]: nextSample },
    }));
  }

  function handlePointerDown(key: "x1Sample" | "x2Sample", event: ReactPointerEvent<HTMLButtonElement>) {
    const host = event.currentTarget.parentElement;
    if (!host) return;
    dragRef.current = key;
    event.currentTarget.setPointerCapture(event.pointerId);
    event.stopPropagation();
    updateCursorFromClientX(event.clientX, host);
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLButtonElement>) {
    const host = event.currentTarget.parentElement;
    if (!host || !dragRef.current) return;
    event.stopPropagation();
    updateCursorFromClientX(event.clientX, host);
  }

  function handlePointerUp(event: ReactPointerEvent<HTMLButtonElement>) {
    dragRef.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
    event.stopPropagation();
  }

  return (
    <div className="cursorOverlay" aria-hidden="false">
      {(["x1Sample", "x2Sample"] as const).map((key, index) => {
        const label = index === 0 ? "x1" : "x2";
        const sample = session.cursorState[key];
        return (
          <button
            aria-label={`${label} cursor`}
            className={`xCursorLine ${label}`}
            key={key}
            onPointerDown={(event) => handlePointerDown(key, event)}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
            style={{ left: `${sampleToPercent(sample)}%` }}
            type="button"
          >
            <span>{label}</span>
          </button>
        );
      })}
    </div>
  );
}

function RangeMeasurementsOverlay({
  onOpenExtensions,
  onUpdateSession,
  rowHeights,
  rowTopInsets,
  session,
  tile,
  visibleChannelIndexes,
}: {
  onOpenExtensions: () => void;
  onUpdateSession: (updater: (session: UiSession) => UiSession) => void;
  rowHeights: number[];
  rowTopInsets: number[];
  session: UiSession;
  tile: WaveformTile | null;
  visibleChannelIndexes: number[];
}) {
  const dragRef = useRef<{ edge: "start" | "end"; id: string } | null>(null);
  const placementDragRef = useRef<{ channelIndex: number; pointerId: number; startSample: number; startX: number } | null>(null);
  const lastPlacementPointerRef = useRef<{ x: number; y: number } | null>(null);
  const rangeSnapRequestRef = useRef(0);
  const totalSamples = session.summary?.metadata.sample_count ?? 0;
  const rowLayout = useMemo(
    () => getSaleaeGraphChannelLayout(rowHeights, visibleChannelIndexes.length, 1, rowTopInsets),
    [rowHeights, rowTopInsets, visibleChannelIndexes.length],
  );

  useEffect(() => {
    if (!session.rangePlacement) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      placementDragRef.current = null;
      onUpdateSession((current) => ({
        ...current,
        rangePlacement: null,
        message: "Range measurement placement canceled",
      }));
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onUpdateSession, session.rangePlacement]);

  useEffect(() => {
    if (!session.rangeMeasurements.some((range) => range.showTooltip)) return;
    function handlePointerDown(event: PointerEvent) {
      const target = event.target as HTMLElement | null;
      if (
        target?.closest(
          ".rangeMeasurementTooltip, .rangeBand, .rangeMeasurementItem, .measurementAddPopover, .rangeMeasurementAddMenu, .rangeMeasurementSettingsMenu, .rangeItemMenu",
        )
      ) {
        return;
      }
      onUpdateSession((current) => ({
        ...current,
        rangeMeasurements: current.rangeMeasurements.map((range) => ({ ...range, showTooltip: false })),
      }));
    }
    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => document.removeEventListener("pointerdown", handlePointerDown, true);
  }, [onUpdateSession, session.rangeMeasurements]);

  function sampleToPercent(sample: number) {
    const ratio = (sample - session.viewportStart) / Math.max(1, session.viewportSamples);
    return ratio * 100;
  }

  function clientXToSample(clientX: number, host: HTMLElement) {
    const rect = host.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
    return Math.max(0, Math.min(totalSamples, Math.round(session.viewportStart + ratio * session.viewportSamples)));
  }

  function pointerToPlacement(clientX: number, clientY: number, host: HTMLElement, fixedChannelIndex?: number) {
    const rect = host.getBoundingClientRect();
    const fixedRowIndex = fixedChannelIndex == null ? undefined : visibleChannelIndexes.indexOf(fixedChannelIndex);
    const resolved = resolveWaveformPointerSample({
      clientX,
      clientY,
      fixedChannelIndex: fixedRowIndex != null && fixedRowIndex >= 0 ? fixedRowIndex : undefined,
      rect,
      rowHeights,
      rowTopInsets,
      tile,
      totalSamples,
      viewportSamples: session.viewportSamples,
      viewportStart: session.viewportStart,
    });
    const rowIndex = resolved.channelIndex;
    if (rowIndex === null) return null;
    const channelIndex = visibleChannelIndexes[rowIndex];
    if (channelIndex == null) return null;
    return {
      channelIndex,
      sourceChannel: tile?.channels[rowIndex]?.channel ?? channelIndex,
      rawSample: resolved.rawSample,
      sample: Math.round(resolved.sample),
    };
  }

  function requestRangePlacementSnap(
    clientX: number,
    clientY: number,
    host: HTMLElement,
    fixedChannelIndex?: number,
  ) {
    const next = pointerToPlacement(clientX, clientY, host, fixedChannelIndex);
    if (!next) return;
    const requestId = rangeSnapRequestRef.current + 1;
    rangeSnapRequestRef.current = requestId;
    void nearestDigitalTransition(session.id, {
      channel: next.sourceChannel,
      sample: Math.round(next.rawSample),
    }).then((transition) => {
      if (!transition || requestId !== rangeSnapRequestRef.current) return;
      const samplesPerPixel = session.viewportSamples / Math.max(1, host.clientWidth);
      const withinThreshold = Math.abs(transition.sample - next.rawSample) <= samplesPerPixel * 8;
      const previousGap = transition.previous_sample == null
        ? 0
        : (transition.sample - transition.previous_sample) / samplesPerPixel;
      const nextGap = transition.next_sample == null
        ? Number.POSITIVE_INFINITY
        : (transition.next_sample - transition.sample) / samplesPerPixel;
      const pulseIsWideEnough = previousGap >= 8 || nextGap >= 8;
      if (!withinThreshold || !pulseIsWideEnough) return;
      onUpdateSession((current) => {
        const placement = current.rangePlacement;
        if (!placement) return current;
        return {
          ...current,
          rangePlacement: {
            ...placement,
            channelIndex: placement.startSample === null ? next.channelIndex : placement.channelIndex,
            currentSample: Math.round(transition.sample),
          },
        };
      });
    }).catch(() => {
      // Coarse tile data remains the immediate placement fallback.
    });
  }

  function selectRange(id: string, showTooltip = false) {
    onUpdateSession((current) => ({
      ...current,
      rangeMeasurements: current.rangeMeasurements.map((range) => ({
        ...range,
        selected: range.id === id,
        showTooltip: range.id === id ? showTooltip || range.showTooltip : false,
      })),
    }));
  }

  function updateDraggedRange(clientX: number, host: HTMLElement) {
    const drag = dragRef.current;
    if (!drag) return;
    const draggedRange = session.rangeMeasurements.find((range) => range.id === drag.id);
    if (!draggedRange) return;
    const hostRect = host.getBoundingClientRect();
    const sample = pointerToPlacement(
      clientX,
      hostRect.top + hostRect.height / 2,
      host,
      draggedRange.channelIndex,
    )?.sample ?? clientXToSample(clientX, host);
    onUpdateSession((current) => ({
      ...current,
      rangeMeasurements: current.rangeMeasurements.map((range) => {
        if (range.id !== drag.id) return range;
        if (drag.edge === "start") {
          if (sample > range.endSample) {
            dragRef.current = { ...drag, edge: "end" };
            return { ...range, startSample: range.endSample, endSample: sample, selected: true, showTooltip: true };
          }
          return { ...range, startSample: Math.max(0, Math.min(sample, range.endSample - 1)), selected: true, showTooltip: true };
        }
        if (sample < range.startSample) {
          dragRef.current = { ...drag, edge: "start" };
          return { ...range, startSample: sample, endSample: range.startSample, selected: true, showTooltip: true };
        }
        return { ...range, endSample: Math.min(totalSamples, Math.max(sample, range.startSample + 1)), selected: true, showTooltip: true };
      }),
    }));
  }

  function handlePointerDown(
    id: string,
    edge: "start" | "end",
    event: ReactPointerEvent<HTMLButtonElement>,
  ) {
    const host = event.currentTarget.closest(".rangeOverlay") as HTMLElement | null;
    if (!host) return;
    dragRef.current = { edge, id };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.stopPropagation();
    selectRange(id, true);
    updateDraggedRange(event.clientX, host);
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLButtonElement>) {
    const host = event.currentTarget.closest(".rangeOverlay") as HTMLElement | null;
    if (!host || !dragRef.current) return;
    event.stopPropagation();
    updateDraggedRange(event.clientX, host);
  }

  function handlePointerUp(event: ReactPointerEvent<HTMLButtonElement>) {
    dragRef.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
    event.stopPropagation();
  }

  function updatePlacementHover(clientX: number, clientY: number, host: HTMLElement) {
    if (!session.rangePlacement) return;
    const next = pointerToPlacement(
      clientX,
      clientY,
      host,
      session.rangePlacement.startSample !== null ? session.rangePlacement.channelIndex ?? undefined : undefined,
    );
    onUpdateSession((current) => {
      if (!current.rangePlacement) return current;
      return {
        ...current,
        rangePlacement: {
          ...current.rangePlacement,
          channelIndex: next?.channelIndex ?? null,
          currentSample: next?.sample ?? null,
        },
      };
    });
    requestRangePlacementSnap(
      clientX,
      clientY,
      host,
      session.rangePlacement.startSample !== null ? session.rangePlacement.channelIndex ?? undefined : undefined,
    );
  }

  function finishPlacement(channelIndex: number, startSample: number, endSample: number) {
    onUpdateSession((current) => ({
      ...current,
      rangePlacement: null,
      rangeMeasurements: [
        ...current.rangeMeasurements.map((range) => ({ ...range, selected: false, showTooltip: false })),
        createRangeMeasurement(current, channelIndex, startSample, endSample),
      ],
      message: "Range measurement added",
    }));
  }

  function handlePlacementPointerDown(event: PointerEvent, host: HTMLElement) {
    if (!session.rangePlacement || event.button !== 0) return;
    const next = pointerToPlacement(
      event.clientX,
      event.clientY,
      host,
      session.rangePlacement.startSample !== null ? session.rangePlacement.channelIndex ?? undefined : undefined,
    );
    if (!next) return;
    event.preventDefault();
    event.stopPropagation();

    if (session.rangePlacement.startSample !== null) {
      finishPlacement(session.rangePlacement.channelIndex ?? next.channelIndex, session.rangePlacement.startSample, next.sample);
      return;
    }

    placementDragRef.current = {
      channelIndex: next.channelIndex,
      pointerId: event.pointerId,
      startSample: next.sample,
      startX: event.clientX,
    };
    onUpdateSession((current) => ({
      ...current,
      rangePlacement: current.rangePlacement
        ? {
            ...current.rangePlacement,
            channelIndex: next.channelIndex,
            currentSample: next.sample,
            startSample: next.sample,
          }
        : current.rangePlacement,
    }));
  }

  function handlePlacementPointerUp(event: PointerEvent, host: HTMLElement) {
    if (!session.rangePlacement) return;
    const drag = placementDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const next = pointerToPlacement(event.clientX, event.clientY, host, drag.channelIndex);
    placementDragRef.current = null;
    if (!next) return;
    const distance = Math.abs(event.clientX - drag.startX);
    if (distance > 2) {
      event.preventDefault();
      event.stopPropagation();
      finishPlacement(drag.channelIndex, drag.startSample, next.sample);
    }
  }

  useEffect(() => {
    if (!session.rangePlacement) {
      lastPlacementPointerRef.current = null;
      return;
    }
    const host = document.querySelector<HTMLElement>(".waveformCanvasHost");
    if (!host) return;
    const placementHost = host;
    function insideHost(clientX: number, clientY: number) {
      const rect = placementHost.getBoundingClientRect();
      return clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
    }
    function handleMove(event: PointerEvent) {
      lastPlacementPointerRef.current = { x: event.clientX, y: event.clientY };
      const hasStart = session.rangePlacement?.startSample !== null;
      if (hasStart || insideHost(event.clientX, event.clientY)) {
        updatePlacementHover(event.clientX, event.clientY, placementHost);
      }
    }
    function handleDown(event: PointerEvent) {
      if (event.button !== 0 || !insideHost(event.clientX, event.clientY)) return;
      lastPlacementPointerRef.current = { x: event.clientX, y: event.clientY };
      handlePlacementPointerDown(event, placementHost);
    }
    function handleUp(event: PointerEvent) {
      if (!placementDragRef.current) return;
      handlePlacementPointerUp(event, placementHost);
    }
    document.addEventListener("pointermove", handleMove, { passive: true });
    document.addEventListener("pointerdown", handleDown, true);
    document.addEventListener("pointerup", handleUp, true);
    document.addEventListener("pointercancel", handleUp, true);
    return () => {
      document.removeEventListener("pointermove", handleMove);
      document.removeEventListener("pointerdown", handleDown, true);
      document.removeEventListener("pointerup", handleUp, true);
      document.removeEventListener("pointercancel", handleUp, true);
    };
  }, [
    rowHeights,
    rowTopInsets,
    session.rangePlacement?.channelIndex,
    session.rangePlacement?.startSample,
    session.rangePlacement?.startedBy,
    session.viewportSamples,
    session.viewportStart,
    tile,
    totalSamples,
    visibleChannelIndexes,
  ]);

  useEffect(() => {
    if (!session.rangePlacement || !lastPlacementPointerRef.current) return;
    const host = document.querySelector<HTMLElement>(".waveformCanvasHost");
    if (!host) return;
    const { x, y } = lastPlacementPointerRef.current;
    updatePlacementHover(x, y, host);
  }, [session.viewportSamples, session.viewportStart, tile]);

  if (!session.summary || totalSamples <= 0 || (session.rangeMeasurements.length === 0 && !session.rangePlacement)) {
    return null;
  }

  function updateTooltipRange(id: string, patch: Partial<UiRangeMeasurement>) {
    onUpdateSession((current) => ({
      ...current,
      rangeMeasurements: current.rangeMeasurements.map((range) =>
        range.id === id ? { ...range, ...patch } : range,
      ),
    }));
  }

  function passWheelToWaveform(event: ReactWheelEvent<HTMLElement>) {
    const host = document.querySelector<HTMLElement>(".waveformCanvasHost");
    if (!host) return;
    event.preventDefault();
    event.stopPropagation();
    const source = event.nativeEvent;
    host.dispatchEvent(new WheelEvent("wheel", {
      altKey: source.altKey,
      bubbles: true,
      cancelable: true,
      clientX: source.clientX,
      clientY: source.clientY,
      ctrlKey: source.ctrlKey,
      deltaMode: source.deltaMode,
      deltaX: source.deltaX,
      deltaY: source.deltaY,
      deltaZ: source.deltaZ,
      metaKey: source.metaKey,
      shiftKey: source.shiftKey,
    }));
  }

  const placingPreview =
    session.rangePlacement?.channelIndex !== null &&
    session.rangePlacement?.currentSample !== null
      ? session.rangePlacement
      : null;

  return (
    <div
      className={`rangeOverlay ${session.rangePlacement ? "placing" : ""}`}
      aria-hidden="false"
    >
      {session.rangeMeasurements.map((range) => {
        const rowIndex = visibleChannelIndexes.indexOf(range.channelIndex);
        const row = rowIndex >= 0 ? rowLayout[rowIndex] : undefined;
        if (!row) return null;
        const startPct = sampleToPercent(range.startSample);
        const endPct = sampleToPercent(range.endSample);
        const left = Math.max(0, Math.min(100, startPct));
        const right = Math.max(0, Math.min(100, endPct));
        const width = Math.max(0, right - left);
        if (endPct <= 0 || startPct >= 100 || width <= 0) return null;
        return (
          <div
            className={`rangeBand ${range.selected ? "selected" : ""}`}
            key={range.id}
            onWheel={passWheelToWaveform}
            onPointerDown={(event) => {
              event.stopPropagation();
              selectRange(range.id, true);
            }}
            style={
              {
                height: row.height,
                left: `${left}%`,
                top: row.top,
                width: `${width}%`,
                "--range-color": range.color,
              } as CSSProperties
            }
          >
            <span className="rangeCenterFill" />
            {startPct >= 0 && startPct <= 100 && (
              <button
                aria-label={`${range.name} start`}
                className="rangeEdge start"
                onPointerDown={(event) => handlePointerDown(range.id, "start", event)}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerCancel={handlePointerUp}
                type="button"
              />
            )}
            {endPct >= 0 && endPct <= 100 && (
              <button
                aria-label={`${range.name} end`}
                className="rangeEdge end"
                onPointerDown={(event) => handlePointerDown(range.id, "end", event)}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerCancel={handlePointerUp}
                type="button"
              />
            )}
          </div>
        );
      })}
      {placingPreview && (
        <PlacingRangePreview
          placement={placingPreview}
          rowLayout={rowLayout}
          sampleToPercent={sampleToPercent}
          visibleChannelIndexes={visibleChannelIndexes}
        />
      )}
      {session.rangeMeasurements.map((range) => {
        if (!range.selected || !range.showTooltip) return null;
        const rowIndex = visibleChannelIndexes.indexOf(range.channelIndex);
        const row = rowIndex >= 0 ? rowLayout[rowIndex] : undefined;
        if (!row) return null;
        return (
          <RangeMeasurementTooltip
            key={`${range.id}-tooltip`}
            onDelete={() =>
              onUpdateSession((current) => ({
                ...current,
                rangeMeasurements: current.rangeMeasurements.filter((item) => item.id !== range.id),
              }))
            }
            onUpdate={(patch) => updateTooltipRange(range.id, patch)}
            onOpenExtensions={onOpenExtensions}
            range={range}
            sampleRateHz={session.summary?.metadata.sample_rate_hz ?? session.settings.sample_rate_hz}
            style={
              range.tooltipPosition
                ? ({
                    left: range.tooltipPosition.x,
                    top: range.tooltipPosition.y,
                    transform: "none",
                  } as CSSProperties)
                : ({
                    left: `clamp(236px, ${(sampleToPercent(range.startSample) + sampleToPercent(range.endSample)) / 2}%, calc(100% - 236px))`,
                    top: row.top + 10,
                  } as CSSProperties)
            }
          />
        );
      })}
    </div>
  );
}

function PlacingRangePreview({
  placement,
  rowLayout,
  sampleToPercent,
  visibleChannelIndexes,
}: {
  placement: UiRangePlacement;
  rowLayout: ReturnType<typeof getSaleaeGraphChannelLayout>;
  sampleToPercent: (sample: number) => number;
  visibleChannelIndexes: number[];
}) {
  if (placement.channelIndex === null || placement.currentSample === null) return null;
  const rowIndex = visibleChannelIndexes.indexOf(placement.channelIndex);
  const row = rowIndex >= 0 ? rowLayout[rowIndex] : undefined;
  if (!row) return null;
  const start = placement.startSample ?? placement.currentSample;
  const startPct = sampleToPercent(start);
  const endPct = sampleToPercent(placement.currentSample);
  if (placement.startSample === null) {
    if (startPct < 0 || startPct > 100) return null;
    return (
      <div
        className="placingRangeIndicator"
        style={
          {
            height: row.height,
            left: `${startPct}%`,
            top: row.top,
            "--range-color": RANGE_COLORS[0],
          } as CSSProperties
        }
      />
    );
  }
  const left = Math.max(0, Math.min(100, Math.min(startPct, endPct)));
  const right = Math.max(0, Math.min(100, Math.max(startPct, endPct)));
  const width = Math.max(0.25, right - left);
  return (
    <div
      className="placingRangeBand"
      style={
        {
          height: row.height,
          left: `${left}%`,
          top: row.top,
          width: `${width}%`,
          "--range-color": RANGE_COLORS[0],
        } as CSSProperties
      }
    >
      <span />
    </div>
  );
}

function RangeMeasurementTooltip({
  onDelete,
  onOpenExtensions,
  onUpdate,
  range,
  sampleRateHz,
  style,
}: {
  onDelete: () => void;
  onOpenExtensions: () => void;
  onUpdate: (patch: Partial<UiRangeMeasurement>) => void;
  range: UiRangeMeasurement;
  sampleRateHz: number;
  style: CSSProperties;
}) {
  const [addOpen, setAddOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const dragRef = useRef<{ offsetX: number; offsetY: number; pointerId: number } | null>(null);
  const tooltipRef = useRef<HTMLElement | null>(null);
  const measurementIds = ensureRangeMeasurementIds(range.measurements);
  const stats = range.measurementStats;
  const deltaSeconds = stats
    ? stats.duration_samples / Math.max(1, stats.sample_rate_hz || sampleRateHz)
    : null;
  const displayedMeasurements = measurementIds.flatMap((id) => {
    const definition = rangeMeasurementDefinition(id);
    if (!definition) return [];
    return [{ definition, formatted: formatRangeMeasurementValue(id, stats) }];
  });

  function copyRange() {
    void navigator.clipboard?.writeText(
      copyRangeMeasurementValues({
        channelIndex: range.channelIndex,
        measurementIds,
        name: range.name,
        note: range.note,
        stats,
      }),
    );
  }

  function boundedTooltipPosition(clientX: number, clientY: number, tooltip: HTMLElement) {
    const overlay = tooltip.closest(".rangeOverlay") as HTMLElement | null;
    const drag = dragRef.current;
    if (!overlay || !drag) return null;
    const overlayRect = overlay.getBoundingClientRect();
    const tooltipRect = tooltip.getBoundingClientRect();
    const maxX = Math.max(0, overlayRect.width - tooltipRect.width);
    const maxY = Math.max(0, overlayRect.height - tooltipRect.height);
    return {
      x: Math.max(0, Math.min(maxX, clientX - overlayRect.left - drag.offsetX)),
      y: Math.max(0, Math.min(maxY, clientY - overlayRect.top - drag.offsetY)),
    };
  }

  function isTooltipDragTargetBlocked(target: EventTarget | null) {
    return Boolean(
      (target as HTMLElement | null)?.closest(
        "button, input, textarea, .rangeMeasurementAddMenu, .rangeMeasurementSettingsMenu",
      ),
    );
  }

  function beginTooltipDrag(clientX: number, clientY: number, tooltip: HTMLElement, pointerId: number) {
    const tooltipRect = tooltip.getBoundingClientRect();
    dragRef.current = {
      offsetX: clientX - tooltipRect.left,
      offsetY: clientY - tooltipRect.top,
      pointerId,
    };
  }

  function handleDragPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (isTooltipDragTargetBlocked(event.target)) return;
    const tooltip = event.currentTarget.closest(".rangeMeasurementTooltip") as HTMLElement | null;
    const overlay = tooltip?.closest(".rangeOverlay") as HTMLElement | null;
    if (!tooltip || !overlay || event.button !== 0) return;
    beginTooltipDrag(event.clientX, event.clientY, tooltip, event.pointerId);
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  }

  function handleDragMouseDown(event: ReactMouseEvent<HTMLDivElement>) {
    if (isTooltipDragTargetBlocked(event.target) || event.button !== 0) return;
    const tooltip = tooltipRef.current;
    if (!tooltip) return;
    beginTooltipDrag(event.clientX, event.clientY, tooltip, -1);
    const handleMouseMove = (moveEvent: MouseEvent) => {
      const position = boundedTooltipPosition(moveEvent.clientX, moveEvent.clientY, tooltip);
      if (position) onUpdate({ tooltipPosition: position });
      moveEvent.preventDefault();
    };
    const handleMouseUp = (upEvent: MouseEvent) => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      dragRef.current = null;
      upEvent.preventDefault();
    };
    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    event.preventDefault();
    event.stopPropagation();
  }

  function handleDragPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const tooltip = event.currentTarget.closest(".rangeMeasurementTooltip") as HTMLElement | null;
    if (!tooltip) return;
    const position = boundedTooltipPosition(event.clientX, event.clientY, tooltip);
    if (position) onUpdate({ tooltipPosition: position });
    event.preventDefault();
    event.stopPropagation();
  }

  function handleDragPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    event.preventDefault();
    event.stopPropagation();
  }

  return (
    <section
      ref={tooltipRef}
      className="rangeMeasurementTooltip"
      onPointerDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      style={
        {
          ...style,
          "--range-color": range.color,
        } as CSSProperties
      }
    >
      <div className="rangeTooltipGrid">
        <RangeMetricCell
          fullValue={deltaSeconds == null ? "Measurement pending" : `${deltaSeconds} s`}
          label="Delta T"
          labelHtml="&Delta;T"
          value={formatDeltaTime(stats, sampleRateHz)}
        />
        {displayedMeasurements.map(({ definition, formatted }) => (
          <RangeMetricCell
            fullValue={formatted.fullValue}
            key={definition.id}
            label={definition.label}
            labelHtml={definition.labelHtml}
            value={range.measurementStatsBusy && !stats ? "..." : formatted.value}
          />
        ))}
      </div>
      {range.measurementError && <div className="rangeMeasurementError">{range.measurementError}</div>}
      <div
        className="rangeTooltipDragBar"
        onMouseDown={handleDragMouseDown}
        onPointerDown={handleDragPointerDown}
        onPointerMove={handleDragPointerMove}
        onPointerUp={handleDragPointerUp}
        onPointerCancel={handleDragPointerUp}
        title="Drag to move"
      >
        <div className="rangeTooltipPopoverHost">
          <button
            className={`rangeTooltipIconButton ${addOpen ? "selected" : ""}`}
            onClick={() => {
              setSettingsOpen(false);
              setAddOpen((open) => !open);
            }}
            title="Add or Remove Measurements"
            type="button"
          >
            <SaleaeIcon name="plus" size={12} />
          </button>
          {addOpen && (
            <RangeMeasurementAddMenu
              measurementIds={measurementIds}
              onChange={(measurements) => onUpdate({ measurements })}
              onOpenExtensions={onOpenExtensions}
            />
          )}
        </div>
        <div className="rangeTooltipPopoverHost">
          <button
            className={`rangeTooltipIconButton ${settingsOpen ? "selected" : ""}`}
            onClick={() => {
              setAddOpen(false);
              setSettingsOpen((open) => !open);
            }}
            title="Annotation Setting"
            type="button"
          >
            <SaleaeIcon name="gear" size={13} />
          </button>
          {settingsOpen && (
            <RangeMeasurementSettingsMenu
              annotationsVisible={range.annotationsVisible}
              onChange={(annotationsVisible) => onUpdate({ annotationsVisible })}
            />
          )}
        </div>
        <button className="rangeTooltipIconButton" onClick={copyRange} title="Copy" type="button">
          <SaleaeIcon name="copy" size={13} />
        </button>
      </div>
      <div className="rangeTooltipCommentBox">
        <textarea
          onChange={(event) => onUpdate({ note: event.target.value })}
          placeholder="Comment here"
          rows={1}
          value={range.note}
        />
        <div className="rangeTooltipLowerPart">
          <div className="rangeTooltipColorGrid">
            {RANGE_COLORS.map((color) => (
              <button
                aria-label={`Use ${color}`}
                className={color === range.color ? "selected" : ""}
                key={color}
                onClick={() => onUpdate({ color })}
                style={{ "--range-color": color } as CSSProperties}
                type="button"
              >
                {color === range.color ? <SaleaeIcon name="checkmark" size={10} /> : null}
              </button>
            ))}
          </div>
          <button className="rangeTooltipIconButton" onClick={onDelete} title="Delete" type="button">
            <SaleaeIcon name="trash" size={14} />
          </button>
        </div>
      </div>
    </section>
  );
}

function RangeMetricCell({
  fullValue,
  label,
  labelHtml,
  value,
}: {
  fullValue: string;
  label: string;
  labelHtml: string;
  value: string;
}) {
  return (
    <div className="rangeMetricCell">
      <span aria-label={label} dangerouslySetInnerHTML={{ __html: labelHtml }} title={label} />
      <strong title={fullValue}>{value}</strong>
    </div>
  );
}

function RangeMeasurementAddMenu({
  measurementIds,
  onChange,
  onOpenExtensions,
}: {
  measurementIds: DigitalRangeMeasurementId[];
  onChange: (measurementIds: DigitalRangeMeasurementId[]) => void;
  onOpenExtensions: () => void;
}) {
  const [search, setSearch] = useState("");
  const selected = new Set(measurementIds);
  const filteredCategories = DIGITAL_RANGE_MEASUREMENT_CATEGORIES.map((category) => ({
    ...category,
    measurements: category.measurements.filter((measurement) => {
      const query = search.trim().toLowerCase();
      if (!query) return true;
      return (
        measurement.label.toLowerCase().includes(query) ||
        measurement.description.toLowerCase().includes(query)
      );
    }),
  })).filter((category) => category.measurements.length > 0);

  function toggle(id: DigitalRangeMeasurementId) {
    if (selected.has(id)) {
      onChange(measurementIds.filter((measurementId) => measurementId !== id));
      return;
    }
    onChange([...measurementIds, id]);
  }

  return (
    <div className="rangeMeasurementAddMenu" onClick={(event) => event.stopPropagation()}>
      <div className="rangeMeasurementAddSearch">
        <Search size={13} />
        <input
          autoFocus
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search..."
          value={search}
        />
      </div>
      <div className="rangeMeasurementAddActions">
        <button onClick={() => onChange([...DEFAULT_DIGITAL_RANGE_MEASUREMENTS])} type="button">
          All
        </button>
        <button onClick={() => onChange([])} type="button">
          Clear
        </button>
      </div>
      <div className="rangeMeasurementAddList">
        {filteredCategories.map((category) => (
          <section key={category.name}>
            <strong>{category.name}</strong>
            {category.measurements.map((measurement) => {
              const enabled = selected.has(measurement.id);
              return (
                <button
                  className={enabled ? "enabled" : ""}
                  key={measurement.id}
                  onClick={() => toggle(measurement.id)}
                  title={measurement.description}
                  type="button"
                >
                  <span
                    aria-label={measurement.label}
                    dangerouslySetInnerHTML={{ __html: measurement.labelHtml }}
                    title={measurement.label}
                  />
                  <span className="rangeMeasurementAddToggle">
                    <SaleaeIcon name={enabled ? "minus" : "plus"} size={8} />
                  </span>
                </button>
              );
            })}
          </section>
        ))}
      </div>
      <button className="rangeMeasurementMoreButton" onClick={onOpenExtensions} type="button">
        <SaleaeSidebarIcon iconUrl={extensionsIcon} />
        Install More Measurements
      </button>
    </div>
  );
}

function RangeMeasurementSettingsMenu({
  annotationsVisible,
  onChange,
}: {
  annotationsVisible: boolean;
  onChange: (annotationsVisible: boolean) => void;
}) {
  return (
    <div className="rangeMeasurementSettingsMenu" onClick={(event) => event.stopPropagation()}>
      <label>
        <span>Display Annotations</span>
        <span className={`saleaeSwitch ${annotationsVisible ? "checked" : ""}`}>
          <input
            checked={annotationsVisible}
            onChange={(event) => onChange(event.target.checked)}
            type="checkbox"
          />
          <span className="saleaeSwitchTrack">
            <span className="saleaeSwitchIcon checkedIcon">
              <SaleaeIcon name="checkmark" size={8} />
            </span>
            <span className="saleaeSwitchIcon uncheckedIcon">
              <SaleaeIcon name="cross" size={8} />
            </span>
            <span className="saleaeSwitchHandle" />
          </span>
        </span>
      </label>
    </div>
  );
}

function LegacyTimingMarkersOverlay({
  onUpdateSession,
  session,
}: {
  onUpdateSession: (updater: (session: UiSession) => UiSession) => void;
  session: UiSession;
}) {
  const dragRef = useRef<{ edge: "end" | "start"; id: string } | null>(null);
  const totalSamples = session.summary?.metadata.sample_count ?? 0;
  if (!session.summary || totalSamples <= 0 || session.timingMarkers.length === 0) return null;

  function sampleToPercent(sample: number) {
    const ratio = (sample - session.viewportStart) / Math.max(1, session.viewportSamples);
    return Math.max(0, Math.min(1, ratio)) * 100;
  }

  function clientXToSample(clientX: number, host: HTMLElement) {
    const rect = host.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
    return Math.max(0, Math.min(totalSamples, Math.round(session.viewportStart + ratio * session.viewportSamples)));
  }

  function selectMarker(id: string) {
    onUpdateSession((current) => ({
      ...current,
      timingMarkers: current.timingMarkers.map((marker) => ({ ...marker, selected: marker.id === id })),
    }));
  }

  function updateDraggedMarker(clientX: number, host: HTMLElement) {
    const drag = dragRef.current;
    if (!drag) return;
    const sample = clientXToSample(clientX, host);
    onUpdateSession((current) => ({
      ...current,
      timingMarkers: current.timingMarkers.map((marker) => {
        if (marker.id !== drag.id) return marker;
        if (marker.type === "single" || drag.edge === "start") {
          return {
            ...marker,
            sample: marker.type === "pair" ? Math.min(sample, (marker.endSample ?? sample + 1) - 1) : sample,
            selected: true,
          };
        }
        return { ...marker, endSample: Math.max(sample, marker.sample + 1), selected: true };
      }),
    }));
  }

  function handlePointerDown(
    id: string,
    edge: "end" | "start",
    event: ReactPointerEvent<HTMLButtonElement>,
  ) {
    const host = event.currentTarget.parentElement?.parentElement;
    if (!host) return;
    dragRef.current = { edge, id };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.stopPropagation();
    selectMarker(id);
    updateDraggedMarker(event.clientX, host);
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLButtonElement>) {
    const host = event.currentTarget.parentElement?.parentElement;
    if (!host || !dragRef.current) return;
    event.stopPropagation();
    updateDraggedMarker(event.clientX, host);
  }

  function handlePointerUp(event: ReactPointerEvent<HTMLButtonElement>) {
    dragRef.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
    event.stopPropagation();
  }

  return (
    <div className="timingMarkerOverlay" aria-hidden="false">
      {session.timingMarkers.map((marker) => {
        const start = sampleToPercent(marker.sample);
        const end = sampleToPercent(marker.endSample ?? marker.sample);
        const width = Math.max(0, end - start);
        return (
          <div
            className={`timingMarkerBand ${marker.type} ${marker.selected ? "selected" : ""}`}
            key={marker.id}
            onPointerDown={(event) => {
              event.stopPropagation();
              selectMarker(marker.id);
            }}
            style={{ left: `${start}%`, width: `${marker.type === "pair" ? width : 0}%` }}
          >
            <button
              aria-label={`${marker.label} start`}
              className="timingMarkerLine start"
              onPointerDown={(event) => handlePointerDown(marker.id, "start", event)}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerUp}
              type="button"
            >
              <span>{marker.type === "pair" ? "A1" : "T"}</span>
            </button>
            {marker.type === "pair" && (
              <button
                aria-label={`${marker.label} end`}
                className="timingMarkerLine end"
                onPointerDown={(event) => handlePointerDown(marker.id, "end", event)}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerCancel={handlePointerUp}
                type="button"
              >
                <span>A2</span>
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

function BottomBar({
  activeSessionId,
  devices,
  footerPopover,
  onCloseSession,
  onCreateSession,
  onDuplicateSession,
  onRefreshDevices,
  onRenameSession,
  onSelectDevice,
  onSelectSession,
  onSetFooterPopover,
  onZoomFit,
  onZoomIn,
  onZoomOut,
  progressPercent,
  refElement,
  selectedDevice,
  selectedDeviceReady,
  sessions,
  status,
  summary,
  zoomLabel,
}: {
  activeSessionId: string | null;
  devices: DeviceInfo[];
  footerPopover: FooterPopover;
  onCloseSession: (sessionId: string) => void;
  onCreateSession: (deviceId?: string) => void;
  onDuplicateSession: (sessionId: string) => void;
  onRefreshDevices: () => void;
  onRenameSession: (sessionId: string, name: string) => void;
  onSelectDevice: (deviceId: string) => void;
  onSelectSession: (sessionId: string) => void;
  onSetFooterPopover: (popover: FooterPopover) => void;
  onZoomFit: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  progressPercent: number;
  refElement: RefObject<HTMLElement>;
  selectedDevice: string;
  selectedDeviceReady: boolean;
  sessions: UiSession[];
  status: string;
  summary: CaptureSummary | null;
  zoomLabel: string;
}) {
  const physicalCount = devices.filter((device) => device.kind === "Usb").length;
  const deviceButtonText = physicalCount > 0 ? `${physicalCount} Device${physicalCount === 1 ? "" : "s"}` : "Disconnected";

  return (
    <footer className="bottomBar saleaeBottomBar" ref={refElement}>
      <div className="footerDeviceMenu">
        <FooterButton selected={footerPopover === "devices"} onClick={() => onSetFooterPopover(footerPopover === "devices" ? null : "devices")}>
          <Usb size={14} />
          <span>{deviceButtonText}</span>
        </FooterButton>
        {footerPopover === "devices" && (
          <FooterPopoverBox className="deviceMenuPopover" align="left">
            <div className="footerMenuHeading">{physicalCount > 0 ? "Connected Devices" : "Demo Devices"}</div>
            <DeviceMenuRows
              devices={devices}
              onCreateSession={onCreateSession}
              onRefreshDevices={onRefreshDevices}
              onSelectDevice={onSelectDevice}
              selectedDevice={selectedDevice}
            />
          </FooterPopoverBox>
        )}
      </div>

      <div className="sessionTabs" role="tablist" aria-label="Capture sessions">
        {sessions.map((session) => (
          <SessionTab
            isActive={session.id === activeSessionId}
            key={session.id}
            onClose={() => onCloseSession(session.id)}
            onDuplicate={() => onDuplicateSession(session.id)}
            onRename={(name) => onRenameSession(session.id, name)}
            onSelect={() => onSelectSession(session.id)}
            session={session}
          />
        ))}
      </div>

      {sessions.length > 0 && (
        <div className="newSessionMenu">
          <button
            className={`newSessionButton ${footerPopover === "newSession" ? "selected" : ""}`}
            title="Create a new session"
            onClick={() => onSetFooterPopover(footerPopover === "newSession" ? null : "newSession")}
            type="button"
          >
            <Plus size={14} />
          </button>
          {footerPopover === "newSession" && (
            <FooterPopoverBox className="deviceMenuPopover newSessionPopover" align="left">
              <div className="footerMenuHeading">New Session</div>
              <DeviceMenuRows
                devices={devices}
                onCreateSession={onCreateSession}
                onRefreshDevices={onRefreshDevices}
                selectedDevice={selectedDevice}
              />
            </FooterPopoverBox>
          )}
        </div>
      )}

      <div className="bottomStatus">
        <div className="capture-progress">
          <div className="progress-track">
            <div className="progress-fill" style={{ width: `${progressPercent}%` }} />
          </div>
          <span>{status}</span>
        </div>
        <span>{summary ? formatSamples(summary.metadata.sample_count) : "No samples"}</span>
        <span>{summary ? formatBytes(summary.bytes) : "0 B"}</span>
        <span>{selectedDeviceReady ? "Device ready" : "No device"}</span>
      </div>

      <div className="zoomFooterMenu">
        <FooterButton selected={footerPopover === "zoom"} disabled={!summary} onClick={() => onSetFooterPopover(footerPopover === "zoom" ? null : "zoom")}>
          <span>{zoomLabel}</span>
        </FooterButton>
        {footerPopover === "zoom" && (
          <FooterPopoverBox className="zoomMenuPopover" align="right">
            <button className="footerMenuItem" onClick={onZoomIn} type="button">
              <ZoomIn size={14} />
              Zoom In
            </button>
            <button className="footerMenuItem" onClick={onZoomOut} type="button">
              <ZoomOut size={14} />
              Zoom Out
            </button>
            <button className="footerMenuItem" onClick={onZoomFit} type="button">
              <Maximize2 size={14} />
              Fit Capture
            </button>
          </FooterPopoverBox>
        )}
      </div>
    </footer>
  );
}

function SessionTab({
  isActive,
  onClose,
  onDuplicate,
  onRename,
  onSelect,
  session,
}: {
  isActive: boolean;
  onClose: () => void;
  onDuplicate: () => void;
  onRename: (name: string) => void;
  onSelect: () => void;
  session: UiSession;
}) {
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("blur", close);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [contextMenu]);

  return (
    <div
      className={`sessionTab ${isActive ? "active" : ""}`}
      role="tab"
      aria-selected={isActive}
      onClick={onSelect}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onSelect();
        setContextMenu({ x: event.clientX, y: event.clientY });
      }}
    >
      {isActive && !session.readOnly ? (
        <input
          aria-label="Session name"
          value={session.name}
          onChange={(event) => onRename(event.target.value)}
          onClick={(event) => event.stopPropagation()}
        />
      ) : (
        <span>{session.name}</span>
      )}
      {session.readOnly && (
        <ReadOnlyLockIcon />
      )}
      <button
        aria-label={`Close ${session.name}`}
        disabled={session.busy}
        onClick={(event) => {
          event.stopPropagation();
          onClose();
        }}
        title={session.busy ? "Tab can't be closed while a capture is in progress" : "Close tab"}
        type="button"
      >
        <X size={12} />
      </button>
      {isActive && <div className="sessionTabLine" />}
      {contextMenu && createPortal(
        <div
          className="sessionTabContextMenu saleaeContextMenu"
          onContextMenu={(event) => event.preventDefault()}
          onPointerDown={(event) => event.stopPropagation()}
          role="menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            disabled={session.busy}
            onClick={() => {
              setContextMenu(null);
              onDuplicate();
            }}
            role="menuitem"
            type="button"
          >
            <Copy size={13} />
            <span>Duplicate Session Setup</span>
          </button>
        </div>,
        document.body,
      )}
    </div>
  );
}

function ReadOnlyLockIcon() {
  return (
    <svg
      aria-label="Read-only session"
      className="sessionTabLock"
      width="10"
      height="14"
      viewBox="0 0 10 14"
      fill="none"
      role="img"
    >
      <path
        d="M3.009 6.409h5.496a.952.952 0 0 1 .952.955v5.684a.952.952 0 0 1-.952.952H.955A.955.955 0 0 1 0 13.048V7.364a.955.955 0 0 1 .955-.955h2.054Z"
        fill="currentColor"
        opacity="0.61"
      />
      <path
        d="M1.073 3.834V6.41h1.784V3.834c0-.524.2-1.026.555-1.396a1.86 1.86 0 0 1 2.679 0c.355.37.554.872.554 1.396V6.41H8.43V3.834C8.43 1.716 6.783 0 4.751 0 2.72 0 1.073 1.716 1.073 3.834Z"
        fill="currentColor"
        opacity="0.61"
      />
    </svg>
  );
}

function FooterButton({
  children,
  disabled = false,
  onClick,
  selected = false,
}: {
  children: ReactNode;
  disabled?: boolean;
  onClick: () => void;
  selected?: boolean;
}) {
  return (
    <button className={`footerButton ${selected ? "selected" : ""}`} disabled={disabled} onClick={onClick} type="button">
      <span className="footerButtonContent">{children}</span>
      {selected ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
    </button>
  );
}

function FooterPopoverBox({
  align,
  children,
  className = "",
}: {
  align: "left" | "right";
  children: ReactNode;
  className?: string;
}) {
  return <div className={`footerPopover ${align === "right" ? "right" : "left"} ${className}`}>{children}</div>;
}

function DeviceMenuRows({
  devices,
  onCreateSession,
  onRefreshDevices,
  onSelectDevice,
  selectedDevice,
}: {
  devices: DeviceInfo[];
  onCreateSession: (deviceId?: string) => void;
  onRefreshDevices: () => void;
  onSelectDevice?: (deviceId: string) => void;
  selectedDevice: string;
}) {
  return (
    <div className="deviceMenuRows">
      {devices.map((device) => (
        <button
          className={`deviceMenuRow ${device.id === selectedDevice ? "selected" : ""}`}
          key={device.id}
          onClick={() => {
            onSelectDevice?.(device.id);
            onCreateSession(device.id);
          }}
          type="button"
        >
          <Usb size={15} />
          <span>{device.label}</span>
          <small>{device.kind === "Usb" ? "Connected" : "Demo"}</small>
        </button>
      ))}
      <button className="deviceMenuRow" onClick={onRefreshDevices} type="button">
        <RefreshCw size={15} />
        <span>Refresh Devices</span>
        <small>Scan</small>
      </button>
    </div>
  );
}

function RightSidebar({
  availableAnalyzers,
  devices,
  extensions,
  onChangeExtensions,
  onAddAnalyzer,
  onAddRangeMeasurement,
  onAddMarkerPair,
  onAddSingleMarker,
  onCreateSession,
  onDecodeAnalyzer,
  onEditAnalyzer,
  onGoToAnalyzerFrame,
  onNotify,
  onRefreshDevices,
  onSelectDevice,
  onSelectPanel,
  onSidebarPanelWidthChange,
  onUpdateSession,
  onUpdateSettings,
  onViewportChange,
  selectedDevice,
  selectedCapabilities,
  selectedPanel,
  sidebarPanelWidth,
  session,
}: {
  availableAnalyzers: AnalyzerLibraryChoice[];
  devices: DeviceInfo[];
  extensions: UiExtensionRecord[];
  onChangeExtensions: (updater: (extensions: UiExtensionRecord[]) => UiExtensionRecord[]) => void;
  onAddAnalyzer: (choiceOrName: AnalyzerLibraryChoice | string, backend?: DecoderBackendKind) => void;
  onAddRangeMeasurement: () => void;
  onAddMarkerPair: () => void;
  onAddSingleMarker: () => void;
  onCreateSession: (deviceId?: string) => void;
  onDecodeAnalyzer: (analyzerId: string) => void;
  onEditAnalyzer: (analyzerId: string) => void;
  onGoToAnalyzerFrame: (analyzerId: string, frameIndex: number, zoom: boolean, frame?: DecodedFrame) => void;
  onNotify: (message: string) => void;
  onRefreshDevices: () => void;
  onSelectDevice: (deviceId: string) => void;
  onSelectPanel: (panel: SidebarPanel | undefined) => void;
  onSidebarPanelWidthChange: (width: number) => void;
  onUpdateSession: (updater: (session: UiSession) => UiSession) => void;
  onUpdateSettings: (patch: Partial<CaptureSettings>) => void;
  onViewportChange: (start: number, samples: number) => void;
  selectedDevice: string;
  selectedCapabilities: HardwareCaptureCapabilities | null;
  selectedPanel: SidebarPanel | undefined;
  sidebarPanelWidth: number;
  session: UiSession | null;
}) {
  const resizeHandleRef = useRef<HTMLDivElement | null>(null);
  const resizeDragRef = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);
  const resizeListenersCleanupRef = useRef<(() => void) | null>(null);

  function stopResize() {
    resizeListenersCleanupRef.current?.();
    resizeListenersCleanupRef.current = null;
    const drag = resizeDragRef.current;
    const handle = resizeHandleRef.current;
    if (drag && handle?.hasPointerCapture(drag.pointerId)) {
      handle.releasePointerCapture(drag.pointerId);
    }
    resizeDragRef.current = null;
    document.body.classList.remove("sidebar-resizing");
  }

  useEffect(() => stopResize, []);

  function handleResizePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (!selectedPanel || event.button !== 0) return;
    const handle = resizeHandleRef.current;
    if (!handle) return;
    event.preventDefault();
    event.stopPropagation();
    resizeListenersCleanupRef.current?.();
    handle.setPointerCapture(event.pointerId);
    resizeDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: sidebarPanelWidth,
    };
    document.body.classList.add("sidebar-resizing");

    const handlePointerMove = (nativeEvent: PointerEvent) => {
      const drag = resizeDragRef.current;
      if (!drag || nativeEvent.pointerId !== drag.pointerId) return;
      onSidebarPanelWidthChange(drag.startWidth + (drag.startX - nativeEvent.clientX));
    };

    const handlePointerUp = (nativeEvent: PointerEvent) => {
      const drag = resizeDragRef.current;
      if (!drag || nativeEvent.pointerId !== drag.pointerId) return;
      stopResize();
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);
    resizeListenersCleanupRef.current = () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
    };
  }

  return (
    <aside
      className="saleaeSidebarRoot"
      style={{ "--sidebar-panel-width": `${sidebarPanelWidth}px` } as CSSProperties}
    >
      {selectedPanel && (
        <section className="sidebarActiveComponent">
          <div
            ref={resizeHandleRef}
            aria-label="Resize sidebar"
            className="sidebarResizeHandle"
            onPointerDown={handleResizePointerDown}
            role="separator"
          />
          <SidebarPanelContent
            availableAnalyzers={availableAnalyzers}
            devices={devices}
            extensions={extensions}
            onChangeExtensions={onChangeExtensions}
            onAddAnalyzer={onAddAnalyzer}
            onAddRangeMeasurement={onAddRangeMeasurement}
            onAddMarkerPair={onAddMarkerPair}
            onAddSingleMarker={onAddSingleMarker}
            onCreateSession={onCreateSession}
            onDecodeAnalyzer={onDecodeAnalyzer}
            onEditAnalyzer={onEditAnalyzer}
            onGoToAnalyzerFrame={onGoToAnalyzerFrame}
            onNotify={onNotify}
            onRefreshDevices={onRefreshDevices}
            onSelectDevice={onSelectDevice}
            onSelectPanel={onSelectPanel}
            onUpdateSession={onUpdateSession}
            onUpdateSettings={onUpdateSettings}
            onViewportChange={onViewportChange}
            panel={selectedPanel}
            selectedCapabilities={selectedCapabilities}
            selectedDevice={selectedDevice}
            session={session}
          />
        </section>
      )}
      <nav className="panelSwitcher" aria-label="Sidebar panels">
        <div className="panelSwitcherTopSection">
          {SIDEBAR_PANELS.map((panel) => {
            const meta = panelMeta[panel];
            const allowed = getSidebarPanelAllowed(panel, session);
            if (!allowed.isVisible) return null;
            const isSelected = selectedPanel === panel;
            const shortcut = SIDEBAR_PANEL_SHORTCUTS[panel];
            const title = shortcut ? `${meta.label} (${shortcut})` : meta.label;
            return (
              <button
                className={`singleSwitcher ${allowed.isSelectable ? "selectableSwitcher" : "disabledSwitcher"} ${isSelected ? "selectedSwitcher" : ""}`}
                aria-disabled={!allowed.isSelectable}
                aria-label={title}
                data-help-tooltip={allowed.disabledReason ?? title}
                data-help-tooltip-at="left"
                key={panel}
                onClick={() => {
                  if (allowed.isSelectable) onSelectPanel(isSelected ? undefined : panel);
                }}
                type="button"
              >
                <SaleaeSidebarIcon iconUrl={meta.iconUrl} />
                {panel === "measurements" && session?.rangeMeasurements.length ? <span className="indicatorDot" /> : null}
              </button>
            );
          })}
        </div>
      </nav>
    </aside>
  );
}

function SidebarPanelContent({
  availableAnalyzers,
  devices,
  extensions,
  onChangeExtensions,
  onAddAnalyzer,
  onAddRangeMeasurement,
  onAddMarkerPair,
  onAddSingleMarker,
  onCreateSession,
  onDecodeAnalyzer,
  onEditAnalyzer,
  onGoToAnalyzerFrame,
  onNotify,
  onRefreshDevices,
  onSelectDevice,
  onSelectPanel,
  onUpdateSession,
  onUpdateSettings,
  onViewportChange,
  panel,
  selectedCapabilities,
  selectedDevice,
  session,
}: {
  availableAnalyzers: AnalyzerLibraryChoice[];
  devices: DeviceInfo[];
  extensions: UiExtensionRecord[];
  onChangeExtensions: (updater: (extensions: UiExtensionRecord[]) => UiExtensionRecord[]) => void;
  onAddAnalyzer: (choiceOrName: AnalyzerLibraryChoice | string, backend?: DecoderBackendKind) => void;
  onAddRangeMeasurement: () => void;
  onAddMarkerPair: () => void;
  onAddSingleMarker: () => void;
  onCreateSession: (deviceId?: string) => void;
  onDecodeAnalyzer: (analyzerId: string) => void;
  onEditAnalyzer: (analyzerId: string) => void;
  onGoToAnalyzerFrame: (analyzerId: string, frameIndex: number, zoom: boolean, frame?: DecodedFrame) => void;
  onNotify: (message: string) => void;
  onRefreshDevices: () => void;
  onSelectDevice: (deviceId: string) => void;
  onSelectPanel: (panel: SidebarPanel | undefined) => void;
  onUpdateSession: (updater: (session: UiSession) => UiSession) => void;
  onUpdateSettings: (patch: Partial<CaptureSettings>) => void;
  onViewportChange: (start: number, samples: number) => void;
  panel: SidebarPanel;
  selectedCapabilities: HardwareCaptureCapabilities | null;
  selectedDevice: string;
  session: UiSession | null;
}) {
  const meta = panelMeta[panel];
  return (
    <div className="sidebarPanelContent">
      {panel !== "extensions" && panel !== "notes" && panel !== "timingMarkers" && (
        <header className="sidebarPanelHeader">
          <span>
            <SaleaeSidebarIcon iconUrl={meta.iconUrl} />
            {meta.label}
          </span>
        </header>
      )}
      {panel === "devices" && session && (
        <DeviceSettingsPanel
          devices={devices}
          onRefreshDevices={onRefreshDevices}
          onSelectDevice={onSelectDevice}
          onUpdateSession={onUpdateSession}
          onUpdateSettings={onUpdateSettings}
          selectedCapabilities={selectedCapabilities}
          selectedDevice={selectedDevice}
          session={session}
        />
      )}
      {panel === "recordingSettings" && session && (
        <RecordingSettingsPanel
          onUpdateSession={onUpdateSession}
          onUpdateSettings={onUpdateSettings}
          selectedCapabilities={selectedCapabilities}
          session={session}
        />
      )}
      {panel === "analyzers" && session && (
        <AnalyzersPanel
          availableAnalyzers={availableAnalyzers}
          onAddAnalyzer={onAddAnalyzer}
          onDecodeAnalyzer={onDecodeAnalyzer}
          onEditAnalyzer={onEditAnalyzer}
          onGoToAnalyzerFrame={onGoToAnalyzerFrame}
          onUpdateSession={onUpdateSession}
          session={session}
        />
      )}
      {panel === "cursors" && session && (
        <CursorsPanel
          onUpdateSession={onUpdateSession}
          sampleRateHz={session.summary?.metadata.sample_rate_hz ?? session.settings.sample_rate_hz}
          session={session}
        />
      )}
      {panel === "measurements" && session && (
        <MeasurementsPanel
          onAdd={onAddRangeMeasurement}
          onOpenExtensions={() => onSelectPanel("extensions")}
          onUpdateSession={onUpdateSession}
          onViewportChange={onViewportChange}
          session={session}
        />
      )}
      {panel === "timingMarkers" && session && (
        <TimingMarkersPanel
          busy={session.busy}
          hasCapture={Boolean(session.summary)}
          markers={session.timingMarkers}
          onAddMarkerPair={onAddMarkerPair}
          onAddSingleMarker={onAddSingleMarker}
          onChangeMarkers={(updater) =>
            onUpdateSession((current) => ({ ...current, timingMarkers: updater(current.timingMarkers) }))
          }
          onMessage={(message) => onUpdateSession((current) => ({ ...current, message }))}
          onViewportChange={onViewportChange}
          placementActive={Boolean(session.timingMarkerPlacement)}
          sampleRateHz={session.summary?.metadata.sample_rate_hz ?? session.settings.sample_rate_hz}
          totalSamples={session.summary?.metadata.sample_count ?? 0}
          viewportSamples={session.viewportSamples}
        />
      )}
      {panel === "extensions" && (
        <ExtensionsPanel
          busy={Boolean(session?.busy)}
          extensions={extensions}
          onChange={onChangeExtensions}
          onNotify={onNotify}
        />
      )}
      {panel === "notes" && session && (
        <CaptureNotesPanel
          notes={session.notes}
          onChange={(notes) => onUpdateSession((current) => ({ ...current, notes }))}
        />
      )}
    </div>
  );
}

function DeviceSettingsPanel({
  devices,
  onRefreshDevices,
  onSelectDevice,
  onUpdateSession,
  onUpdateSettings,
  selectedCapabilities,
  selectedDevice,
  session,
}: {
  devices: DeviceInfo[];
  onRefreshDevices: () => void;
  onSelectDevice: (deviceId: string) => void;
  onUpdateSession: (updater: (session: UiSession) => UiSession) => void;
  onUpdateSettings: (patch: Partial<CaptureSettings>) => void;
  selectedCapabilities: HardwareCaptureCapabilities | null;
  selectedDevice: string;
  session: UiSession;
}) {
  const [showDeviceInfo, setShowDeviceInfo] = useState(false);
  const [pwmBusy, setPwmBusy] = useState(false);
  const selected = devices.find((device) => device.id === selectedDevice);
  const activeBackendMode = backendCaptureMode(session.deviceSettings.captureMode);
  const maxDigitalChannels = maxChannelsForCapabilities(selectedCapabilities, activeBackendMode);
  const sampleRateOptions = sampleRateSelectOptionsForCapabilities(
    selectedCapabilities,
    activeBackendMode,
    session.settings.channel_count,
    session.settings.sample_rate_hz,
  );
  const thresholdOptions = thresholdOptionsForCapabilities(
    selectedCapabilities,
    session.settings.threshold_volts,
  );
  const channelCountOptions = channelCountOptionsForCapabilities(
    selectedCapabilities,
    activeBackendMode,
    session.settings.channel_count,
  );
  const selectedChannelMode = selectedHardwareChannelMode(
    selectedCapabilities,
    activeBackendMode,
    session.settings.channel_count,
    session.settings.sample_rate_hz,
  );
  const enabledChannels = selected
    ? session.deviceSettings.digitalChannels.slice(0, maxDigitalChannels).filter(Boolean).length
    : session.settings.channel_count;
  const digitalChannels = Array.from(
    { length: maxDigitalChannels },
    (_, index) => session.deviceSettings.digitalChannels[index] ?? index < session.settings.channel_count,
  );
  const analogChannels = cloneAnalogChannels(session.deviceSettings.analogChannels);

  function updateDeviceSettings(patch: Partial<UiDeviceSettings>) {
    onUpdateSession((current) => ({
      ...current,
      deviceSettings: {
        ...current.deviceSettings,
        ...patch,
        analogChannels: patch.analogChannels
          ? cloneAnalogChannels(patch.analogChannels)
          : cloneAnalogChannels(current.deviceSettings.analogChannels),
        digitalChannels: patch.digitalChannels
          ? [...patch.digitalChannels]
          : [...current.deviceSettings.digitalChannels],
      },
    }));
  }

  function setCaptureMode(mode: UiRecordingMode) {
    updateDeviceSettings({ captureMode: mode });
  }

  function setChannelCount(channelCount: number) {
    const nextSettings = clampCaptureSettingsToCapabilities(
      { ...session.settings, channel_count: channelCount, mode: activeBackendMode },
      selectedCapabilities,
    );
    onUpdateSettings({
      channel_count: nextSettings.channel_count,
      enabled_channels: Array.from({ length: nextSettings.channel_count }, (_, index) => index),
      sample_rate_hz: nextSettings.sample_rate_hz,
    });
    onUpdateSession((current) => ({
      ...current,
      deviceSettings: {
        ...current.deviceSettings,
        digitalChannels: makeDigitalChannels(nextSettings.channel_count),
        triggerChannel: Math.min(session.deviceSettings.triggerChannel, Math.max(0, nextSettings.channel_count - 1)),
      },
      hiddenDigitalChannels: makeHiddenDigitalChannels(),
    }));
  }

  function toggleDigitalChannel(index: number) {
    if (index >= maxDigitalChannels) return;
    const nextChannels = [...digitalChannels];
    nextChannels[index] = !nextChannels[index];
    const highestEnabled = highestEnabledDigitalChannel(nextChannels);
    const nextSettings = clampCaptureSettingsToCapabilities(
      { ...session.settings, channel_count: Math.max(1, highestEnabled + 1), mode: activeBackendMode },
      selectedCapabilities,
    );
    const nextEnabledChannels = enabledChannelIndexes(nextChannels, nextSettings.channel_count);
    onUpdateSettings({
      channel_count: nextSettings.channel_count,
      enabled_channels: nextEnabledChannels,
      sample_rate_hz: nextSettings.sample_rate_hz,
    });
    onUpdateSession((current) => ({
      ...current,
      deviceSettings: {
        ...current.deviceSettings,
        digitalChannels: nextChannels,
        triggerChannel: nextEnabledChannels.includes(current.deviceSettings.triggerChannel)
          ? current.deviceSettings.triggerChannel
          : (nextEnabledChannels[0] ?? 0),
      },
      hiddenDigitalChannels: nextChannels[index]
        ? makeHiddenDigitalChannels(current.hiddenDigitalChannels).map((hidden, hiddenIndex) =>
            hiddenIndex === index ? false : hidden,
          )
        : current.hiddenDigitalChannels,
      message: `D${index} ${nextChannels[index] ? "shown and enabled" : "hidden and disabled"}`,
    }));
  }

  function selectAllDigitalChannels(enabled: boolean) {
    const nextCount = enabled ? maxDigitalChannels : 1;
    onUpdateSettings({
      channel_count: nextCount,
      enabled_channels: enabled ? Array.from({ length: nextCount }, (_, index) => index) : [],
    });
    onUpdateSession((current) => ({
      ...current,
      deviceSettings: {
        ...current.deviceSettings,
        digitalChannels: makeDigitalChannels(enabled ? nextCount : 0),
        triggerChannel: 0,
      },
      hiddenDigitalChannels: makeHiddenDigitalChannels(),
      message: enabled ? `All ${nextCount} digital channels shown and enabled` : "All digital channels hidden and disabled",
    }));
  }

  function updateAnalogDeviceChannel(index: number, patch: Partial<UiAnalogChannelSettings>) {
    const nextChannels = cloneAnalogChannels(analogChannels);
    const current = nextChannels[index];
    if (!current) return;
    nextChannels[index] = {
      ...current,
      ...patch,
      rangeVolts: Math.max(0.1, patch.rangeVolts ?? current.rangeVolts),
      viewRangeVolts: Math.max(0.1, patch.viewRangeVolts ?? current.viewRangeVolts),
    };
    updateDeviceSettings({ analogChannels: nextChannels });
  }

  function selectAllAnalogChannels(enabled: boolean) {
    updateDeviceSettings({
      analogChannels: analogChannels.map((channel) => ({ ...channel, enabled })),
    });
  }

  function toggleAnalogChannel(index: number) {
    updateAnalogDeviceChannel(index, { enabled: !analogChannels[index]?.enabled });
  }

  async function applyPwm0() {
    if (!selected || pwmBusy || session.busy) return;
    setPwmBusy(true);
    try {
      const configuration = await configurePwm(selectedDevice, {
        duty_percent: session.deviceSettings.pwmDutyPercent,
        enabled: session.deviceSettings.pwmEnabled,
        frequency_hz: session.deviceSettings.pwmFrequencyHz,
      });
      onUpdateSession((current) => ({
        ...current,
        deviceSettings: {
          ...current.deviceSettings,
          digitalChannels: [...current.deviceSettings.digitalChannels],
          pwmEffectiveDutyPercent: configuration.effective_duty_percent,
          pwmEffectiveFrequencyHz: configuration.effective_frequency_hz,
        },
        message: `PWM0 ${configuration.enabled ? "enabled" : "disabled"} at ${formatRate(configuration.effective_frequency_hz)}, ${trimNumber(configuration.effective_duty_percent)}% duty`,
      }));
    } catch (error) {
      onUpdateSession((current) => ({ ...current, message: String(error) }));
    } finally {
      setPwmBusy(false);
    }
  }

  return (
    <div className="deviceSettingsPanel">
      <section className="deviceSettingsHeader">
        <div className="deviceSettingsTitle">
          <strong>{selected?.label ?? "Disconnected"}</strong>
          <small>{selected?.kind === "Usb" ? "Connected Logic Device" : "Demo Logic Device"}</small>
        </div>
        <button className="deviceSettingsSmallButton" onClick={() => setShowDeviceInfo((open) => !open)} type="button">
          Device Information
        </button>
      </section>

      {showDeviceInfo && (
        <section className="deviceInfoPanel">
          <InfoRow label="Device ID" value={selectedDevice} />
          <InfoRow label="VID / PID" value={selected ? `${hex16(selected.vid)} / ${hex16(selected.pid)}` : "-"} />
          <InfoRow label="USB Address" value={selected?.bus == null ? "Simulation" : `${selected.bus}:${selected.address}`} />
          <InfoRow label="USB Speed" value={selected?.usb_speed ?? "-"} />
          <InfoRow label="Manufacturer" value={selected?.manufacturer ?? "-"} />
          <InfoRow label="Product" value={selected?.product ?? "-"} />
          <InfoRow label="PXView Profile" value={selected?.profile_model ?? "-"} />
          <InfoRow label="PXView Channel Mode" value={selectedChannelMode?.description ?? "-"} />
          <InfoRow label="Logic Mode" value={selected?.logic_mode == null ? "-" : hex32(selected.logic_mode)} />
          {selected?.probe_error && <InfoRow label="Probe" value={selected.probe_error} />}
          <InfoRow label="Capture Buffer" value={formatBytes(session.deviceSettings.bufferSizeMb * 1024 * 1024)} />
          <button className="deviceSettingsSmallButton" onClick={onRefreshDevices} type="button">
            <RefreshCw size={13} />
            Refresh Devices
          </button>
        </section>
      )}

      <section className="deviceSettingsBlock">
        <div className="deviceSettingsBlockTitle">
          <span>Digital</span>
          <div className="deviceSettingsActions">
            <button type="button" onClick={() => selectAllDigitalChannels(true)}>
              All
            </button>
            <button type="button" onClick={() => selectAllDigitalChannels(false)}>
              Clear
            </button>
          </div>
        </div>

        <div className="channelPickerGrid">
          {digitalChannels.map((enabled, index) => (
            <button
              className={`channelPickerButton ${enabled ? "enabled" : ""}`}
              key={index}
              onClick={() => toggleDigitalChannel(index)}
              style={
                {
                  "--channel-color": saleaeLegacyChannelColor(index),
                } as CSSProperties
              }
              title={`${enabled ? "Hide and disable" : "Show and enable"} D${index}`}
              type="button"
            >
              {index}
            </button>
          ))}
        </div>

        <div className="twoColumnFields captureInputRow">
          <label className="stack-field">
            <span>Sample rate</span>
            <select
              value={session.settings.sample_rate_hz}
              onChange={(event) => onUpdateSettings({ sample_rate_hz: Number(event.target.value) })}
            >
              {sampleRateOptions.map((rate) => (
                <option key={rate} value={rate}>
                  {formatRate(rate)}
                </option>
              ))}
            </select>
          </label>
          <ThresholdVoltageField
            disabled={session.busy || session.readOnly}
            onChange={(threshold_volts) => onUpdateSettings({ threshold_volts })}
            presets={thresholdOptions}
            value={session.settings.threshold_volts}
          />
        </div>
        <label className="stack-field">
          <span>Active channels</span>
          <select value={session.settings.channel_count} onChange={(event) => setChannelCount(Number(event.target.value))}>
            {channelCountOptions.map((count) => (
              <option key={count} value={count}>
                {count} digital
              </option>
            ))}
          </select>
        </label>
        {selectedChannelMode && (
          <div className="deviceSettingsModeHint">{selectedChannelMode.description}</div>
        )}
      </section>

      <section className="deviceSettingsBlock analogDeviceSettingsBlock">
        <div className="deviceSettingsBlockTitle">
          <span>Analog</span>
          <div className="deviceSettingsActions">
            <button type="button" onClick={() => selectAllAnalogChannels(true)}>
              All
            </button>
            <button type="button" onClick={() => selectAllAnalogChannels(false)}>
              Clear
            </button>
          </div>
        </div>
        <div className="channelPickerGrid">
          {analogChannels.map((channel, index) => (
            <button
              className={`channelPickerButton ${channel.enabled ? "enabled" : ""}`}
              key={index}
              onClick={() => toggleAnalogChannel(index)}
              style={{ "--channel-color": saleaeLegacyChannelColor(index) } as CSSProperties}
              title={`${channel.enabled ? "Hide and disable" : "Show and enable"} A${index}`}
              type="button"
            >
              {index}
            </button>
          ))}
        </div>
        <label className="stack-field">
          <span>Sample rate</span>
          <select
            value={session.deviceSettings.analogSampleRateHz}
            onChange={(event) => updateDeviceSettings({ analogSampleRateHz: Number(event.target.value) })}
          >
            {ANALOG_SAMPLE_RATE_OPTIONS.map((rate) => (
              <option key={rate} value={rate}>
                {formatRate(rate)}
              </option>
            ))}
          </select>
        </label>
      </section>

      <section className="deviceSettingsBlock">
        <div className="deviceSettingsBlockTitle">
          <span>Capture Mode</span>
          <small>{session.deviceSettings.captureMode}</small>
        </div>
        <div className="modeButtonGroup">
          {(["FreeRun", "Timer", "Trigger"] as UiRecordingMode[]).map((mode) => (
            <button
              className={session.deviceSettings.captureMode === mode ? "active" : ""}
              key={mode}
              onClick={() => setCaptureMode(mode)}
              type="button"
            >
              {mode === "FreeRun" ? "Looping" : mode}
            </button>
          ))}
        </div>

        {session.deviceSettings.captureMode === "Timer" && (
          <label className="stack-field">
            <span>After time</span>
            <input
              min={1}
              onChange={(event) => onUpdateSettings({ duration_ms: Number(event.target.value) })}
              type="number"
              value={session.settings.duration_ms}
            />
          </label>
        )}

        {session.deviceSettings.captureMode === "Trigger" && (
          <div className="triggerSettingsGrid">
            <TriggerSettingsEditor
              channelLabels={session.channelLabels}
              channelCount={session.settings.channel_count}
              conditions={session.deviceSettings.triggerConditions ?? []}
              edge={session.deviceSettings.triggerEdge}
              triggerChannel={session.deviceSettings.triggerChannel}
              onChange={(patch) => updateDeviceSettings(patch)}
            />
            <TriggerDurationField
              valueMs={session.deviceSettings.singleShotPostTriggerMs}
              onChange={(singleShotPostTriggerMs) => updateDeviceSettings({ singleShotPostTriggerMs })}
            />
          </div>
        )}
      </section>

      <section className="deviceSettingsBlock compact">
        <label className="toggle-field panel-toggle">
          <input
            checked={session.deviceSettings.trimAfterCapture}
            onChange={(event) => updateDeviceSettings({ trimAfterCapture: event.target.checked })}
            type="checkbox"
          />
          Trim after capture
        </label>
        <label className="stack-field">
          <span>Glitch filter</span>
          <select
            onChange={(event) => updateDeviceSettings({ glitchFilterEnabled: event.target.value === "one-sample" })}
            value={session.deviceSettings.glitchFilterEnabled ? "one-sample" : "none"}
          >
            <option value="none">None</option>
            <option value="one-sample">1 sample clock</option>
          </select>
        </label>
        <MemoryBufferSizeSetter
          bufferSizeMb={session.deviceSettings.bufferSizeMb}
          disabled={session.busy || session.readOnly}
          onChange={(bufferSizeMb) => {
            updateDeviceSettings({ bufferSizeMb });
            onUpdateSettings({ buffer_size_mb: bufferSizeMb });
          }}
        />
      </section>

      <section className="deviceSettingsBlock compact">
        <div className="deviceSettingsBlockTitle">
          <span>Hardware I/O</span>
          <small>SigPilot</small>
        </div>
        <label className="stack-field">
          <span>Ext Trigger Mode</span>
          <select
            value={session.deviceSettings.externalTriggerMode}
            onChange={(event) =>
              updateDeviceSettings({ externalTriggerMode: event.target.value as ExternalTriggerMode })
            }
          >
            {(
              [
                ["Close", "close"],
                ["Rising", "Rising"],
                ["One", "One"],
                ["Falling", "Falling"],
                ["Zero", "Zero"],
                ["Edge", "Edge"],
              ] as [ExternalTriggerMode, string][]
            ).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="toggle-field panel-toggle">
          <input
            checked={session.deviceSettings.clockNegedge}
            onChange={(event) => updateDeviceSettings({ clockNegedge: event.target.checked })}
            type="checkbox"
          />
          Using Clock Negedge
        </label>
        <label className="toggle-field panel-toggle">
          <input
            checked={session.deviceSettings.triggerOutEnabled}
            onChange={(event) => updateDeviceSettings({ triggerOutEnabled: event.target.checked })}
            type="checkbox"
          />
          En Trigger Out
        </label>
      </section>

      <section className="deviceSettingsBlock compact">
        <div className="deviceSettingsBlockTitle">
          <span>PWM0 Output</span>
          <small>125 MHz clock</small>
        </div>
        <label className="toggle-field panel-toggle">
          <input
            checked={session.deviceSettings.pwmEnabled}
            onChange={(event) => updateDeviceSettings({ pwmEnabled: event.target.checked })}
            type="checkbox"
          />
          PWM0 EN
        </label>
        <div className="pwmSettingsGrid">
          <label className="stack-field">
            <span>PWM0 Freq (Hz)</span>
            <input
              max={1_000_000}
              min={1}
              onChange={(event) => updateDeviceSettings({ pwmFrequencyHz: Number(event.target.value) })}
              step={1}
              type="number"
              value={session.deviceSettings.pwmFrequencyHz}
            />
          </label>
          <label className="stack-field">
            <span>PWM0 Duty (%)</span>
            <input
              max={100}
              min={0}
              onChange={(event) => updateDeviceSettings({ pwmDutyPercent: Number(event.target.value) })}
              step={1}
              type="number"
              value={session.deviceSettings.pwmDutyPercent}
            />
          </label>
        </div>
        {session.deviceSettings.pwmEffectiveFrequencyHz != null &&
          session.deviceSettings.pwmEffectiveDutyPercent != null && (
            <div className="pwmEffectiveValue">
              Effective {formatRate(session.deviceSettings.pwmEffectiveFrequencyHz)} / {trimNumber(session.deviceSettings.pwmEffectiveDutyPercent)}%
            </div>
          )}
        <button
          className="deviceSettingsSmallButton pwmApplyButton"
          disabled={!selected || pwmBusy || session.busy}
          onClick={() => void applyPwm0()}
          type="button"
        >
          <SlidersHorizontal size={13} />
          {pwmBusy ? "Applying..." : "Apply PWM0"}
        </button>
      </section>

      <section className="deviceSettingsBlock compact">
        <div className="deviceSettingsBlockTitle">
          <span>Connected Devices</span>
          <small>{enabledChannels} active</small>
        </div>
        <DeviceMenuRows
          devices={devices}
          onCreateSession={() => undefined}
          onRefreshDevices={onRefreshDevices}
          onSelectDevice={onSelectDevice}
          selectedDevice={selectedDevice}
        />
      </section>

      {(session.busy || session.readOnly) && (
        <div className="deviceSettingsDisabledOverlay">
          {session.readOnly ? "This is a read-only session" : "Settings are disabled during capture"}
        </div>
      )}
    </div>
  );
}

function MemoryBufferSizeSetter({
  bufferSizeMb,
  disabled,
  onChange,
}: {
  bufferSizeMb: number;
  disabled: boolean;
  onChange: (bufferSizeMb: number) => void;
}) {
  const valueGb = Math.max(0.5, Math.round((bufferSizeMb / 1024) * 100) / 100);
  const [draftValue, setDraftValue] = useState(String(valueGb));

  useEffect(() => {
    setDraftValue(String(valueGb));
  }, [valueGb]);

  function setValue(nextValueGb: number) {
    if (!Number.isFinite(nextValueGb)) return;
    const normalizedValue = Math.max(0.5, Math.round(nextValueGb * 100) / 100);
    setDraftValue(String(normalizedValue));
    onChange(Math.round(normalizedValue * 1024));
  }

  function commitDraftValue() {
    const parsedValue = Number(draftValue);
    if (!Number.isFinite(parsedValue)) {
      setDraftValue(String(valueGb));
      return;
    }
    setValue(parsedValue);
  }

  return (
    <div className={`memoryBufferSizeSetter ${disabled ? "disabled" : ""}`}>
      <span className="memoryBufferSizeLabel">Memory buffer size</span>
      <div className="memoryBufferValueSetter">
        <button
          aria-label="Decrease memory buffer size"
          disabled={disabled || valueGb <= 0.5}
          onClick={() => setValue(valueGb - 0.5)}
          title="Decrease memory buffer size"
          type="button"
        >
          <Minus size={16} strokeWidth={2.5} />
        </button>
        <label className="memoryBufferValueInput">
          <input
            aria-label="Memory buffer size"
            disabled={disabled}
            min={0.5}
            onBlur={commitDraftValue}
            onChange={(event) => setDraftValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
              if (event.key === "Escape") {
                setDraftValue(String(valueGb));
                event.currentTarget.blur();
              }
            }}
            step={0.5}
            type="number"
            value={draftValue}
          />
          <span>GB</span>
        </label>
        <button
          aria-label="Increase memory buffer size"
          disabled={disabled}
          onClick={() => setValue(valueGb + 0.5)}
          title="Increase memory buffer size"
          type="button"
        >
          <Plus size={16} strokeWidth={2.5} />
        </button>
      </div>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="deviceInfoRow">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function hex16(value: number) {
  return `0x${value.toString(16).padStart(4, "0").toUpperCase()}`;
}

function hex32(value: number) {
  return `0x${value.toString(16).padStart(8, "0").toUpperCase()}`;
}

function formatSeconds(value: number) {
  const absolute = Math.abs(value);
  if (absolute >= 1) return `${trimNumber(value)} s`;
  if (absolute >= 1e-3) return `${trimNumber(value * 1e3)} ms`;
  if (absolute >= 1e-6) return `${trimNumber(value * 1e6)} us`;
  return `${trimNumber(value * 1e9)} ns`;
}

function trimNumber(value: number) {
  if (!Number.isFinite(value)) return "-";
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}

function ThresholdVoltageField({
  disabled,
  onChange,
  presets,
  value,
}: {
  disabled: boolean;
  onChange: (value: number) => void;
  presets: number[];
  value: number;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(() => trimNumber(value));
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => setText(trimNumber(value)), [value]);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!hostRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [open]);

  function commit(raw: string) {
    const next = Number(raw);
    if (!Number.isFinite(next) || next < 0 || next > 6.668) return;
    onChange(next);
  }

  return (
    <label className="stack-field thresholdVoltageField">
      <span>Threshold</span>
      <div className={`thresholdVoltageControl ${open ? "open" : ""}`} ref={hostRef}>
        <input
          aria-label="Threshold voltage"
          disabled={disabled}
          inputMode="decimal"
          max={6.668}
          min={0}
          onBlur={(event) => commit(event.currentTarget.value)}
          onChange={(event) => {
            setText(event.currentTarget.value);
            commit(event.currentTarget.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") {
              setText(trimNumber(value));
              event.currentTarget.blur();
            }
          }}
          step={0.001}
          type="number"
          value={text}
        />
        <span>V</span>
        <button
          aria-expanded={open}
          aria-haspopup="listbox"
          disabled={disabled}
          onClick={() => setOpen((current) => !current)}
          title="Threshold presets"
          type="button"
        >
          <ChevronDown size={14} />
        </button>
        {open && (
          <div className="thresholdVoltageMenu" role="listbox">
            {presets.map((preset) => (
              <button
                aria-selected={Math.abs(value - preset) < 0.0005}
                key={preset}
                onClick={() => {
                  setText(trimNumber(preset));
                  onChange(preset);
                  setOpen(false);
                }}
                role="option"
                type="button"
              >
                {trimNumber(preset)} V
              </button>
            ))}
          </div>
        )}
      </div>
    </label>
  );
}

function TriggerSettingsEditor({
  channelLabels,
  channelCount,
  conditions,
  edge,
  onChange,
  triggerChannel,
}: {
  channelLabels: string[];
  channelCount: number;
  conditions: UiTriggerCondition[];
  edge: UiTriggerEdge;
  onChange: (patch: Partial<UiDeviceSettings>) => void;
  triggerChannel: number;
}) {
  const channels = Array.from({ length: Math.max(1, channelCount) }, (_, index) => index);
  const activeConditions = channels.filter((channel) => channel !== triggerChannel && (conditions[channel] ?? "Ignore") !== "Ignore").length;
  function setCondition(channel: number, condition: UiTriggerCondition) {
    const next = Array.from({ length: 32 }, (_, index) => conditions[index] ?? "Ignore");
    next[channel] = next[channel] === condition ? "Ignore" : condition;
    onChange({ triggerConditions: next });
  }

  return (
    <div className="triggerEditor">
      <div className="triggerPatternRow">
        <div className="triggerEdgeChoices" role="group" aria-label="Trigger edge">
          <TriggerEdgePicker edge={edge} onChange={onChange} />
        </div>
        <TriggerChannelPicker channelLabels={channelLabels} channels={channels} onChange={onChange} triggerChannel={triggerChannel} />
      </div>
      <details className="triggerConditions" open={activeConditions > 0}>
        <summary>Other channel conditions{activeConditions > 0 ? ` (${activeConditions})` : ""}</summary>
        <div className="triggerConditionRows">
          {channels.filter((channel) => channel !== triggerChannel).map((channel) => {
            const condition = conditions[channel] ?? "Ignore";
            return (
              <div className="triggerConditionRow" key={channel}>
                <TriggerChannelIdentifier channel={channel} name={channelLabels[channel] ?? `D${channel}`} />
                <div className="triggerConditionChoices" role="group" aria-label={`D${channel} trigger condition`}>
                  {(["Low", "High"] as const).map((value) => (
                    <button
                      aria-pressed={condition === value}
                      className={condition === value ? "active" : ""}
                      key={value}
                      onClick={() => setCondition(channel, value)}
                      type="button"
                    >
                      {value === "Low" ? "Lo" : "Hi"}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </details>
    </div>
  );
}

function TriggerEdgePicker({ edge, onChange }: {
  edge: UiTriggerEdge;
  onChange: (patch: Partial<UiDeviceSettings>) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { const close = (event: PointerEvent) => { if (!ref.current?.contains(event.target as Node)) setOpen(false); }; window.addEventListener("pointerdown", close); return () => window.removeEventListener("pointerdown", close); }, []);
  const options: Array<{ icon: string; label: UiTriggerEdge; }> = [
    { icon: triggerRisingIcon, label: "Rising Edge" },
    { icon: triggerFallingIcon, label: "Falling Edge" },
    { icon: triggerPulseHighIcon, label: "High Pulse" },
    { icon: triggerPulseLowIcon, label: "Low Pulse" },
  ];
  const selected = options.find((option) => option.label === edge) ?? options[0];
  return <div className="triggerPicker" ref={ref}><button aria-expanded={open} aria-haspopup="listbox" onClick={() => setOpen(!open)} title={edge} type="button"><TriggerTypeIcon icon={selected.icon} /><ChevronDown size={14} /></button>{open && <div className="triggerPickerMenu" role="listbox">{options.map((option) => <button aria-selected={edge === option.label} key={option.label} onClick={() => { onChange({ triggerEdge: option.label }); setOpen(false); }} role="option" type="button"><TriggerTypeIcon icon={option.icon} /><span>{option.label}</span>{edge === option.label && <Check size={16} />}</button>)}</div>}</div>;
}

function TriggerChannelPicker({ channelLabels, channels, onChange, triggerChannel }: {
  channelLabels: string[];
  channels: number[];
  onChange: (patch: Partial<UiDeviceSettings>) => void;
  triggerChannel: number;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { const close = (event: PointerEvent) => { if (!ref.current?.contains(event.target as Node)) setOpen(false); }; window.addEventListener("pointerdown", close); return () => window.removeEventListener("pointerdown", close); }, []);
  const name = (channel: number) => channelLabels[channel] ?? `D${channel}`;
  return <div className="triggerChannelPicker" ref={ref}><button aria-expanded={open} aria-haspopup="listbox" onClick={() => setOpen(!open)} type="button"><TriggerChannelIdentifier channel={triggerChannel} name={name(triggerChannel)} /><ChevronDown size={14} /></button>{open && <div className="triggerChannelMenu" role="listbox">{channels.map((channel) => <button aria-selected={channel === triggerChannel} key={channel} onClick={() => { onChange({ triggerChannel: channel }); setOpen(false); }} role="option" type="button"><TriggerChannelIdentifier channel={channel} name={name(channel)} />{channel === triggerChannel && <Check size={16} />}</button>)}</div>}</div>;
}

function TriggerTypeIcon({ icon }: { icon: string }) {
  return <span aria-hidden="true" className="triggerTypeIcon" style={{ "--trigger-type-icon": `url(${icon})` } as CSSProperties} />;
}

function TriggerChannelIdentifier({ channel, name }: { channel: number; name: string }) {
  return <span className="triggerChannelIdentifier"><span className="triggerChannelNumber" style={{ color: saleaeLegacyChannelColor(channel) }}>{String(channel).padStart(2, "0")}.</span><span className="triggerChannelName">{name}</span></span>;
}

function TriggerDurationField({ onChange, valueMs }: { onChange: (valueMs: number) => void; valueMs: number }) {
  return <label className="stack-field triggerDurationField"><span>Capture duration after trigger</span><div><input min={0.001} onChange={(event) => onChange(Math.max(1, Math.round(Number(event.target.value) * 1_000)))} step={0.001} type="number" value={trimNumber(valueMs / 1_000)} /><span>s</span></div></label>;
}

function RecordingSettingsPanel({
  onUpdateSettings,
  onUpdateSession,
  selectedCapabilities,
  session,
}: {
  onUpdateSession: (updater: (session: UiSession) => UiSession) => void;
  onUpdateSettings: (patch: Partial<CaptureSettings>) => void;
  selectedCapabilities: HardwareCaptureCapabilities | null;
  session: UiSession;
}) {
  const activeBackendMode = backendCaptureMode(session.deviceSettings.captureMode);
  const sampleRateOptions = sampleRateSelectOptionsForCapabilities(
    selectedCapabilities,
    activeBackendMode,
    session.settings.channel_count,
    session.settings.sample_rate_hz,
  );
  const triggerSampleRateOptions = sampleRateSelectOptionsForCapabilities(
    selectedCapabilities,
    activeBackendMode,
    session.settings.channel_count,
    session.deviceSettings.triggerSamplingRateHz,
  );
  const selectedChannelMode = selectedHardwareChannelMode(
    selectedCapabilities,
    activeBackendMode,
    session.settings.channel_count,
    session.settings.sample_rate_hz,
  );

  function updateDeviceSettings(patch: Partial<UiDeviceSettings>) {
    onUpdateSession((current) => ({
      ...current,
      deviceSettings: {
        ...current.deviceSettings,
        ...patch,
        digitalChannels: [...current.deviceSettings.digitalChannels],
      },
    }));
  }

  function setCaptureMode(mode: UiRecordingMode) {
    updateDeviceSettings({ captureMode: mode });
  }

  return (
    <div className="recordingSettingsPanel">
      <section className="deviceSettingsBlock">
        <div className="deviceSettingsBlockTitle">
          <span>Recording Type</span>
          <small>{selectedChannelMode?.description ?? session.deviceSettings.captureMode}</small>
        </div>
        <div className="recordingTypeGrid">
          {(["FreeRun", "Timer", "Trigger"] as UiRecordingMode[]).map((mode) => (
            <button
              className={session.deviceSettings.captureMode === mode ? "active" : ""}
              key={mode}
              onClick={() => setCaptureMode(mode)}
              type="button"
            >
              <span>{mode === "FreeRun" ? "Looping" : mode}</span>
              <small>{mode === "FreeRun" ? "Free Run" : mode === "Timer" ? "Timed" : "Event"}</small>
            </button>
          ))}
        </div>
      </section>

      {session.deviceSettings.captureMode === "FreeRun" && (
        <section className="deviceSettingsBlock">
          <div className="deviceSettingsBlockTitle">
            <span>Free Run Settings</span>
            <small>Continuous</small>
          </div>
          <label className="stack-field">
            <span>Continuous sample rate</span>
            <select
              value={session.settings.sample_rate_hz}
              onChange={(event) => onUpdateSettings({ sample_rate_hz: Number(event.target.value) })}
            >
              {sampleRateOptions.map((rate) => (
                <option key={rate} value={rate}>
                  {formatRate(rate)}
                </option>
              ))}
            </select>
          </label>
          <label className="toggle-field panel-toggle">
            <input
              checked={session.deviceSettings.trimAfterCapture}
              onChange={(event) => updateDeviceSettings({ trimAfterCapture: event.target.checked })}
              type="checkbox"
            />
            Trim after capture
          </label>
        </section>
      )}

      {session.deviceSettings.captureMode === "Timer" && (
        <section className="deviceSettingsBlock">
          <div className="deviceSettingsBlockTitle">
            <span>Timer Settings</span>
            <small>{formatRate(session.settings.sample_rate_hz)}</small>
          </div>
          <label className="stack-field">
            <span>Stop after ms</span>
            <input
              min={1}
              onChange={(event) => onUpdateSettings({ duration_ms: Number(event.target.value) })}
              type="number"
              value={session.settings.duration_ms}
            />
          </label>
          <label className="stack-field">
            <span>Sample rate</span>
            <select
              value={session.settings.sample_rate_hz}
              onChange={(event) => onUpdateSettings({ sample_rate_hz: Number(event.target.value) })}
            >
              {sampleRateOptions.map((rate) => (
                <option key={rate} value={rate}>
                  {formatRate(rate)}
                </option>
              ))}
            </select>
          </label>
        </section>
      )}

      {session.deviceSettings.captureMode === "Trigger" && (
        <>
          <section className="deviceSettingsBlock">
            <div className="deviceSettingsBlockTitle">
              <span>Pattern and Channel</span>
              <small>Digital trigger</small>
            </div>
            <TriggerSettingsEditor
              channelLabels={session.channelLabels}
              channelCount={session.settings.channel_count}
              conditions={session.deviceSettings.triggerConditions ?? []}
              edge={session.deviceSettings.triggerEdge}
              triggerChannel={session.deviceSettings.triggerChannel}
              onChange={(patch) => updateDeviceSettings(patch)}
            />
          </section>
          <section className="deviceSettingsBlock compact">
            <div className="deviceSettingsBlockTitle">
              <span>Capture Window</span>
              <small>Stops after trigger</small>
            </div>
            <TriggerDurationField
              valueMs={session.deviceSettings.singleShotPostTriggerMs}
              onChange={(singleShotPostTriggerMs) => updateDeviceSettings({ singleShotPostTriggerMs })}
            />
          </section>
        </>
      )}
    </div>
  );
}

function AnalyzersPanel({
  availableAnalyzers,
  onAddAnalyzer,
  onDecodeAnalyzer,
  onEditAnalyzer,
  onGoToAnalyzerFrame,
  onUpdateSession,
  session,
}: {
  availableAnalyzers: AnalyzerLibraryChoice[];
  onAddAnalyzer: (choiceOrName: AnalyzerLibraryChoice | string, backend?: DecoderBackendKind) => void;
  onDecodeAnalyzer: (analyzerId: string) => void;
  onEditAnalyzer: (analyzerId: string) => void;
  onGoToAnalyzerFrame: (analyzerId: string, frameIndex: number, zoom: boolean, frame?: DecodedFrame) => void;
  onUpdateSession: (updater: (session: UiSession) => UiSession) => void;
  session: UiSession;
}) {
  const [selectorOpen, setSelectorOpen] = useState(false);
  const [selectorAnchorRect, setSelectorAnchorRect] = useState<DOMRect | null>(null);
  const [activeAnalyzerMenu, setActiveAnalyzerMenu] = useState<{ analyzerId: string; anchorRect: DOMRect } | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [tableViewport, setTableViewport] = useState({ height: 0, scrollTop: 0 });
  const [tableBackendWindow, setTableBackendWindow] = useState<{
    end: number;
    key: string;
    roles: string[];
    rowCount: number;
    rows: AnalyzerFrameListRow[];
    start: number;
  } | null>(null);
  const [tableSearchBackendWindow, setTableSearchBackendWindow] = useState<{
    end: number;
    key: string;
    roles: string[];
    rowCount: number;
    rows: AnalyzerFrameListRow[];
    start: number;
  } | null>(null);
  const [terminalViewport, setTerminalViewport] = useState({ height: 0, scrollTop: 0 });
  const [terminalBackendWindow, setTerminalBackendWindow] = useState<{
    end: number;
    key: string;
    rowCount: number;
    rows: AnalyzerFrameListRow[];
    start: number;
  } | null>(null);
  const selectorButtonRef = useRef<HTMLButtonElement>(null);
  const tableBodyRef = useRef<HTMLDivElement>(null);
  const terminalBodyRef = useRef<HTMLDivElement>(null);
  const tableBackendWindowSeqRef = useRef(0);
  const tableSearchBackendWindowSeqRef = useRef(0);
  const tableSearchHydrationSeqRef = useRef(0);
  const terminalBackendWindowSeqRef = useRef(0);

  function addAnalyzer(choice: AnalyzerLibraryChoice) {
    setSelectorOpen(false);
    setSelectorAnchorRect(null);
    onAddAnalyzer(choice);
  }

  function toggleAnalyzerSelector() {
    setActiveAnalyzerMenu(null);
    if (selectorOpen) {
      setSelectorOpen(false);
      setSelectorAnchorRect(null);
      return;
    }
    const rect = selectorButtonRef.current?.getBoundingClientRect();
    if (rect) setSelectorAnchorRect(rect);
    setSelectorOpen(true);
  }

  function removeAnalyzer(analyzerId: string) {
    onUpdateSession((current) => ({
      ...current,
      analyzers: current.analyzers.filter((analyzer) => analyzer.id !== analyzerId),
      message: "Analyzer removed",
    }));
  }

  function moveAnalyzer(analyzerId: string, direction: -1 | 1) {
    onUpdateSession((current) => {
      const index = current.analyzers.findIndex((analyzer) => analyzer.id === analyzerId);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= current.analyzers.length) return current;
      const analyzers = [...current.analyzers];
      [analyzers[index], analyzers[target]] = [analyzers[target], analyzers[index]];
      return { ...current, analyzers };
    });
  }

  function reorderAnalyzer(sourceIndex: number, destinationIndex: number) {
    if (sourceIndex === destinationIndex) return;
    onUpdateSession((current) => {
      if (
        sourceIndex < 0 ||
        sourceIndex >= current.analyzers.length ||
        destinationIndex < 0 ||
        destinationIndex >= current.analyzers.length
      ) {
        return current;
      }
      const analyzers = [...current.analyzers];
      const [moved] = analyzers.splice(sourceIndex, 1);
      analyzers.splice(destinationIndex, 0, moved);
      return { ...current, analyzers, message: `${moved.name} moved` };
    });
  }

  function finishAnalyzerReorder(result: DropResult) {
    if (!result.destination) return;
    setActiveAnalyzerMenu(null);
    reorderAnalyzer(result.source.index, result.destination.index);
  }

  function updateAnalyzerItem(analyzerId: string, updater: (analyzer: UiAnalyzerInstance) => UiAnalyzerInstance) {
    onUpdateSession((current) => ({
      ...current,
      analyzers: current.analyzers.map((analyzer) => (analyzer.id === analyzerId ? updater(analyzer) : analyzer)),
    }));
  }

  const tableFrameSources = useMemo(
    () => analyzerFrameListSources(session.analyzers, "table"),
    [session.analyzers],
  );
  const tableFrameCount = useMemo(
    () => countAnalyzerFrameRows(tableFrameSources),
    [tableFrameSources],
  );
  const deferredSearchQuery = useDeferredValue(searchQuery);
  const normalizedSearch = deferredSearchQuery.trim().toLowerCase();
  const tableBackendRequests = useMemo(() => {
    if (session.analyzerDataPane !== "table" || normalizedSearch || !session.summary) return [];
    const enabledAnalyzers = session.analyzers.filter(
      (analyzer) =>
        analyzer.showInDataTable &&
        !analyzerHasLazyNativeFramePlaceholder(analyzer) &&
        Math.max(analyzer.decodedFrameCount, analyzer.decodedFrames.length) > 0 &&
        analyzer.decodedDecodeSignature === getAnalyzerDecodeSignature(analyzer),
    );
    if (
      enabledAnalyzers.length === 0 ||
      !enabledAnalyzers.some(
        (analyzer) => !analyzer.decodedFramesComplete && analyzer.decodedFrameCount > 0,
      )
    ) {
      return [];
    }
    const requests = enabledAnalyzers.flatMap((analyzer) => {
      const settings = analyzerDecodeSettings(analyzer);
      if (!settings || !analyzerCanRunDecoder(analyzer)) return [];
      return [
        {
          analyzer,
          request: {
            analyzer_id: analyzer.id,
            analyzer_name: analyzer.name,
            backend: analyzer.decoderBackend,
            display_radix: analyzer.displayRadix,
            settings,
          },
        },
      ];
    });
    return requests.length === enabledAnalyzers.length ? requests : [];
  }, [
    normalizedSearch,
    session.analyzerDataPane,
    session.analyzers,
    session.summary,
  ]);
  const tableBackendWindowEnabled = tableBackendRequests.length > 0;
  const tableBackendRequestKey = useMemo(
    () =>
      tableBackendWindowEnabled
        ? JSON.stringify(
            tableBackendRequests.map(({ analyzer, request }) => [
              analyzer.id,
              analyzer.name,
              analyzer.color,
              analyzer.displayRadix,
              analyzer.decodedDecodeSignature,
              analyzer.decodedFrameCount,
              request.backend,
              request.settings,
            ]),
          )
        : "",
    [tableBackendRequests, tableBackendWindowEnabled],
  );
  const tableSearchBackendRequests = useMemo(() => {
    if (!normalizedSearch || session.analyzerDataPane !== "table" || !session.summary) return [];
    const enabledAnalyzers = session.analyzers.filter(
      (analyzer) =>
        analyzer.showInDataTable &&
        Math.max(analyzer.decodedFrameCount, analyzer.decodedFrames.length) > 0 &&
        analyzer.decodedDecodeSignature === getAnalyzerDecodeSignature(analyzer),
    );
    if (enabledAnalyzers.length === 0) return [];
    if (
      !enabledAnalyzers.some(
        (analyzer) => !analyzer.decodedFramesComplete && analyzer.decodedFrameCount > 0,
      )
    ) {
      return [];
    }
    const requests = enabledAnalyzers.flatMap((analyzer) => {
      const settings = analyzerDecodeSettings(analyzer);
      if (!settings || !analyzerCanRunDecoder(analyzer)) return [];
      return [
        {
          analyzer,
          request: {
            analyzer_id: analyzer.id,
            analyzer_name: analyzer.name,
            backend: analyzer.decoderBackend,
            display_radix: analyzer.displayRadix,
            settings,
          },
        },
      ];
    });
    return requests.length === enabledAnalyzers.length ? requests : [];
  }, [normalizedSearch, session.analyzerDataPane, session.analyzers, session.summary]);
  const tableSearchBackendWindowEnabled = tableSearchBackendRequests.length > 0;
  const tableSearchBackendRequestKey = useMemo(
    () =>
      tableSearchBackendWindowEnabled
        ? JSON.stringify([
            normalizedSearch,
            tableSearchBackendRequests.map(({ analyzer, request }) => [
              analyzer.id,
              analyzer.name,
              analyzer.color,
              analyzer.displayRadix,
              analyzer.decodedDecodeSignature,
              analyzer.decodedFrameCount,
              request.backend,
              request.settings,
            ]),
          ])
        : "",
    [normalizedSearch, tableSearchBackendRequests, tableSearchBackendWindowEnabled],
  );
  const tableSearchHydrationRequests = useMemo(() => {
    if (tableSearchBackendWindowEnabled) return [];
    if (!normalizedSearch || session.analyzerDataPane !== "table" || !session.summary) return [];
    return session.analyzers.flatMap((analyzer) => {
      if (
        !analyzer.showInDataTable ||
        analyzer.decodedFramesComplete ||
        analyzer.decodedFrameCount <= 0 ||
        analyzer.decodedDecodeSignature !== getAnalyzerDecodeSignature(analyzer)
      ) {
        return [];
      }
      const settings = analyzerDecodeSettings(analyzer);
      if (!settings || !analyzerCanRunDecoder(analyzer)) return [];
      return [
        {
          analyzerId: analyzer.id,
          backend: analyzer.decoderBackend,
          settings,
          signature: getAnalyzerDecodeSignature(analyzer),
        },
      ];
    });
  }, [
    normalizedSearch,
    session.analyzerDataPane,
    session.analyzers,
    session.summary,
    tableSearchBackendWindowEnabled,
  ]);
  const filteredTableFrameRefs = useMemo<AnalyzerFrameListRef[] | null>(() => {
    if (session.analyzerDataPane !== "table") return [];
    if (tableSearchBackendWindowEnabled) return null;
    if (!normalizedSearch) return null;
    const started = performance.now();
    const refs = filterAnalyzerFrameListRefs(tableFrameSources, (row) =>
      analyzerFrameRowSearchText(row).includes(normalizedSearch),
    );
    traceAnalyzerPerformance(
      "table_filter",
      started,
      `rows=${tableFrameCount} matches=${refs.length}`,
    );
    return refs;
  }, [
    normalizedSearch,
    session.analyzerDataPane,
    tableFrameCount,
    tableFrameSources,
    tableSearchBackendWindowEnabled,
  ]);
  const tableSearchBackendWindowMatches =
    tableSearchBackendWindowEnabled &&
    tableSearchBackendWindow?.key === tableSearchBackendRequestKey;
  const tableBackendWindowKeyMatches =
    tableBackendWindowEnabled &&
    tableBackendWindow?.key === tableBackendRequestKey;
  const filteredTableFrameCount = tableSearchBackendWindowEnabled
    ? tableSearchBackendWindowMatches && tableSearchBackendWindow
      ? tableSearchBackendWindow.rowCount
      : tableFrameCount
    : tableBackendWindowKeyMatches && tableBackendWindow
      ? tableBackendWindow.rowCount
    : filteredTableFrameRefs
      ? filteredTableFrameRefs.length
      : tableFrameCount;
  const tableDataColumns = useMemo(() => {
    if (session.analyzerDataPane !== "table") return [];
    if (tableSearchBackendWindowMatches && tableSearchBackendWindow) {
      return tableSearchBackendWindow.roles;
    }
    if (tableBackendWindowKeyMatches && tableBackendWindow) {
      return tableBackendWindow.roles;
    }
    return analyzerFrameListChannelRoles(tableFrameSources);
  }, [
    session.analyzerDataPane,
    tableBackendRequestKey,
    tableBackendWindow,
    tableBackendWindowKeyMatches,
    tableFrameSources,
    tableSearchBackendWindow,
    tableSearchBackendWindowMatches,
  ]);
  // The go-to button owns its own column, placed directly left of the frame
  // number. It used to be rendered last with no matching column, so it fell into
  // an implicit auto-sized track whose position moved with the data columns (and
  // the CSS pinned it to the right edge of the visible area on top of that).
  const tableGridTemplate = `18px 24px 48px 75px 110px 80px${tableDataColumns.length > 0 ? ` repeat(${tableDataColumns.length}, minmax(75px, 1fr))` : ""}`;
  const tableMinimumWidth = 331 + tableDataColumns.length * 75;
  const syncTableVisibleRight = useCallback(() => {
    const table = tableBodyRef.current;
    if (!table) return;
    const visibleRight = Math.max(0, table.scrollWidth - table.clientWidth - table.scrollLeft);
    table.style.setProperty("--table-visible-right", `${visibleRight}px`);
  }, []);
  const syncTableViewport = useCallback(() => {
    const table = tableBodyRef.current;
    if (!table) return;
    const next = { height: table.clientHeight, scrollTop: table.scrollTop };
    setTableViewport((current) =>
      current.height === next.height && current.scrollTop === next.scrollTop ? current : next,
    );
  }, []);
  const handleTableScroll = useCallback(() => {
    syncTableVisibleRight();
    syncTableViewport();
  }, [syncTableViewport, syncTableVisibleRight]);
  const terminalFrameSources = useMemo(
    () => analyzerFrameListSources(session.analyzers, "terminal"),
    [session.analyzers],
  );
  const terminalFrameCount = useMemo(
    () => countAnalyzerFrameRows(terminalFrameSources),
    [terminalFrameSources],
  );
  const terminalBackendRequests = useMemo(() => {
    if (session.analyzerDataPane !== "terminal" || !session.summary) return [];
    const enabledAnalyzers = session.analyzers.filter(
      (analyzer) =>
        analyzer.streamToTerminal &&
        Math.max(analyzer.decodedFrameCount, analyzer.decodedFrames.length) > 0 &&
        analyzer.decodedDecodeSignature === getAnalyzerDecodeSignature(analyzer),
    );
    if (
      enabledAnalyzers.length === 0 ||
      !enabledAnalyzers.some(
        (analyzer) => !analyzer.decodedFramesComplete && analyzer.decodedFrameCount > 0,
      )
    ) {
      return [];
    }
    const requests = enabledAnalyzers.flatMap((analyzer) => {
      const settings = analyzerDecodeSettings(analyzer);
      if (!settings || !analyzerCanRunDecoder(analyzer)) return [];
      return [
        {
          analyzer,
          request: {
            analyzer_id: analyzer.id,
            analyzer_name: analyzer.name,
            backend: analyzer.decoderBackend,
            display_radix: analyzer.displayRadix,
            settings,
          },
        },
      ];
    });
    return requests.length === enabledAnalyzers.length ? requests : [];
  }, [session.analyzerDataPane, session.analyzers, session.summary]);
  const terminalBackendWindowEnabled = terminalBackendRequests.length > 0;
  const terminalBackendRequestKey = useMemo(
    () =>
      terminalBackendWindowEnabled
        ? JSON.stringify(
            terminalBackendRequests.map(({ analyzer, request }) => [
              analyzer.id,
              analyzer.name,
              analyzer.displayRadix,
              analyzer.decodedDecodeSignature,
              analyzer.decodedFrameCount,
              request.backend,
              request.settings,
            ]),
          )
        : "",
    [terminalBackendRequests, terminalBackendWindowEnabled],
  );
  const syncTerminalViewport = useCallback(() => {
    const terminal = terminalBodyRef.current;
    if (!terminal) return;
    const next = { height: terminal.clientHeight, scrollTop: terminal.scrollTop };
    setTerminalViewport((current) =>
      current.height === next.height && current.scrollTop === next.scrollTop ? current : next,
    );
  }, []);
  const tableWindow = virtualListWindow(
    filteredTableFrameCount,
    ANALYZER_TABLE_ROW_HEIGHT_PX,
    tableViewport.scrollTop,
    tableViewport.height,
    ANALYZER_TABLE_HEADER_HEIGHT_PX,
    ANALYZER_LIST_OVERSCAN_ROWS,
  );
  const tableBackendWindowMatches =
    tableBackendWindowEnabled &&
    tableBackendWindow?.key === tableBackendRequestKey &&
    tableBackendWindow.start === tableWindow.start &&
    tableBackendWindow.end === tableWindow.end;
  const tableSearchBackendWindowRowsMatch =
    tableSearchBackendWindowEnabled &&
    tableSearchBackendWindow?.key === tableSearchBackendRequestKey &&
    tableSearchBackendWindow.start === tableWindow.start &&
    tableSearchBackendWindow.end === tableWindow.end;
  const visibleTableFrames = useMemo(
    () => {
      if (tableSearchBackendWindowRowsMatch && tableSearchBackendWindow) return tableSearchBackendWindow.rows;
      if (tableSearchBackendWindowEnabled) return [];
      if (tableBackendWindowMatches && tableBackendWindow) return tableBackendWindow.rows;
      if (tableBackendWindowEnabled) return [];
      return filteredTableFrameRefs
          ? analyzerFrameListRowsFromRefs(tableFrameSources, filteredTableFrameRefs, tableWindow.start, tableWindow.end)
          : analyzerFrameListRowsForWindow(tableFrameSources, tableWindow.start, tableWindow.end);
    },
    [
      filteredTableFrameRefs,
      tableBackendWindow,
      tableBackendWindowEnabled,
      tableBackendWindowMatches,
      tableFrameSources,
      tableSearchBackendWindow,
      tableSearchBackendWindowEnabled,
      tableSearchBackendWindowRowsMatch,
      tableWindow.end,
      tableWindow.start,
    ],
  );
  const terminalBackendWindowKeyMatches =
    terminalBackendWindowEnabled &&
    terminalBackendWindow?.key === terminalBackendRequestKey;
  const terminalEffectiveFrameCount =
    terminalBackendWindowKeyMatches && terminalBackendWindow
      ? terminalBackendWindow.rowCount
      : terminalFrameCount;
  const terminalWindow = virtualListWindow(
    terminalEffectiveFrameCount,
    ANALYZER_TERMINAL_ROW_HEIGHT_PX,
    terminalViewport.scrollTop,
    terminalViewport.height,
    0,
    ANALYZER_LIST_OVERSCAN_ROWS,
  );
  const terminalBackendWindowMatches =
    terminalBackendWindowKeyMatches &&
    terminalBackendWindow &&
    terminalBackendWindow.start === terminalWindow.start &&
    terminalBackendWindow.end === terminalWindow.end;
  const visibleTerminalFrames = useMemo(
    () => {
      if (terminalBackendWindowMatches && terminalBackendWindow) return terminalBackendWindow.rows;
      if (terminalBackendWindowEnabled) return [];
      return analyzerFrameListRowsForWindow(terminalFrameSources, terminalWindow.start, terminalWindow.end);
    },
    [
      terminalBackendWindow,
      terminalBackendWindowEnabled,
      terminalBackendWindowMatches,
      terminalFrameSources,
      terminalWindow.end,
      terminalWindow.start,
    ],
  );
  const sampleRateHz = session.summary?.metadata.sample_rate_hz ?? session.settings.sample_rate_hz;

  useEffect(() => {
    if (!tableBackendWindowEnabled || session.analyzerDataPane !== "table" || normalizedSearch) {
      return;
    }
    const requestKey = tableBackendRequestKey;
    const requestStart = tableWindow.start;
    const requestEnd = tableWindow.end;
    const seq = tableBackendWindowSeqRef.current + 1;
    tableBackendWindowSeqRef.current = seq;
    const analyzerById = new Map(tableBackendRequests.map(({ analyzer }) => [analyzer.id, analyzer]));
    const started = performance.now();
    void decodeAnalyzerFrameTableWindow(
      session.id,
      tableBackendRequests.map(({ request }) => request),
      requestStart,
      requestEnd,
    ).then((window) => {
      if (tableBackendWindowSeqRef.current !== seq) return;
      const rows = window.rows.flatMap((row): AnalyzerFrameListRow[] => {
        const analyzer = analyzerById.get(row.analyzer_id);
        if (!analyzer) return [];
        return [
          {
            analyzer,
            frame: row.frame,
            frameIndex: row.frame_index,
            frameNumber: row.frame_number,
          },
        ];
      });
      traceAnalyzerPerformance(
        "table_backend_window",
        started,
        `rows=${rows.length} total=${window.row_count} start=${requestStart} end=${requestEnd}`,
      );
      setTableBackendWindow({
        end: requestEnd,
        key: requestKey,
        roles: window.roles,
        rowCount: window.row_count,
        rows,
        start: requestStart,
      });
    }).catch((error) => {
      if (tableBackendWindowSeqRef.current !== seq) return;
      onUpdateSession((current) => ({ ...current, message: String(error) }));
    });
  }, [
    normalizedSearch,
    onUpdateSession,
    session.analyzerDataPane,
    session.id,
    tableBackendRequestKey,
    tableBackendRequests,
    tableBackendWindowEnabled,
    tableWindow.end,
    tableWindow.start,
  ]);

  useEffect(() => {
    if (!tableSearchBackendWindowEnabled || session.analyzerDataPane !== "table" || !normalizedSearch) {
      return;
    }
    const requestKey = tableSearchBackendRequestKey;
    const requestStart = tableWindow.start;
    const requestEnd = tableWindow.end;
    const seq = tableSearchBackendWindowSeqRef.current + 1;
    tableSearchBackendWindowSeqRef.current = seq;
    const analyzerById = new Map(tableSearchBackendRequests.map(({ analyzer }) => [analyzer.id, analyzer]));
    const started = performance.now();
    void decodeAnalyzerFrameTableSearchWindow(
      session.id,
      tableSearchBackendRequests.map(({ request }) => request),
      normalizedSearch,
      requestStart,
      requestEnd,
    ).then((window) => {
      if (tableSearchBackendWindowSeqRef.current !== seq) return;
      const rows = window.rows.flatMap((row): AnalyzerFrameListRow[] => {
        const analyzer = analyzerById.get(row.analyzer_id);
        if (!analyzer) return [];
        return [
          {
            analyzer,
            frame: row.frame,
            frameIndex: row.frame_index,
            frameNumber: row.frame_number,
          },
        ];
      });
      traceAnalyzerPerformance(
        "table_backend_search_window",
        started,
        `rows=${rows.length} matches=${window.row_count} start=${requestStart} end=${requestEnd}`,
      );
      setTableSearchBackendWindow({
        end: requestEnd,
        key: requestKey,
        roles: window.roles,
        rowCount: window.row_count,
        rows,
        start: requestStart,
      });
    }).catch((error) => {
      if (tableSearchBackendWindowSeqRef.current !== seq) return;
      onUpdateSession((current) => ({ ...current, message: String(error) }));
    });
  }, [
    normalizedSearch,
    onUpdateSession,
    session.analyzerDataPane,
    session.id,
    tableSearchBackendRequestKey,
    tableSearchBackendRequests,
    tableSearchBackendWindowEnabled,
    tableWindow.end,
    tableWindow.start,
  ]);

  useEffect(() => {
    if (tableSearchHydrationRequests.length === 0) return;
    const seq = tableSearchHydrationSeqRef.current + 1;
    tableSearchHydrationSeqRef.current = seq;
    const started = performance.now();
    void Promise.all(
      tableSearchHydrationRequests.map(async (request) => ({
        ...request,
        frames: normalizeDecodedFrameOrder(
          await decodeAnalyzerFrames(session.id, request.settings, request.backend),
        ),
      })),
    ).then((results) => {
      if (tableSearchHydrationSeqRef.current !== seq) return;
      const resultsByAnalyzer = new Map(results.map((result) => [result.analyzerId, result]));
      traceAnalyzerPerformance(
        "table_search_hydrate",
        started,
        `analyzers=${results.length} frames=${results.reduce((count, result) => count + result.frames.length, 0)}`,
      );
      onUpdateSession((current) => ({
        ...current,
        analyzers: current.analyzers.map((analyzer) => {
          const result = resultsByAnalyzer.get(analyzer.id);
          if (!result || getAnalyzerDecodeSignature(analyzer) !== result.signature) return analyzer;
          return {
            ...analyzer,
            decodedFrameCount: result.frames.length,
            decodedFrames: result.frames,
            decodedFramesComplete: true,
            decodedDecodeSignature: result.signature,
          };
        }),
      }));
    }).catch((error) => {
      if (tableSearchHydrationSeqRef.current !== seq) return;
      onUpdateSession((current) => ({ ...current, message: String(error) }));
    });
  }, [onUpdateSession, session.id, tableSearchHydrationRequests]);

  useEffect(() => {
    if (!terminalBackendWindowEnabled || session.analyzerDataPane !== "terminal") {
      return;
    }
    const requestKey = terminalBackendRequestKey;
    const requestStart = terminalWindow.start;
    const requestEnd = terminalWindow.end;
    const seq = terminalBackendWindowSeqRef.current + 1;
    terminalBackendWindowSeqRef.current = seq;
    const analyzerById = new Map(terminalBackendRequests.map(({ analyzer }) => [analyzer.id, analyzer]));
    const started = performance.now();
    void decodeAnalyzerFrameTableWindow(
      session.id,
      terminalBackendRequests.map(({ request }) => request),
      requestStart,
      requestEnd,
    ).then((window) => {
      if (terminalBackendWindowSeqRef.current !== seq) return;
      const rows = window.rows.flatMap((row): AnalyzerFrameListRow[] => {
        const analyzer = analyzerById.get(row.analyzer_id);
        if (!analyzer) return [];
        return [
          {
            analyzer,
            frame: row.frame,
            frameIndex: row.frame_index,
            frameNumber: row.frame_number,
          },
        ];
      });
      traceAnalyzerPerformance(
        "terminal_backend_window",
        started,
        `rows=${rows.length} total=${window.row_count} start=${requestStart} end=${requestEnd}`,
      );
      setTerminalBackendWindow({
        end: requestEnd,
        key: requestKey,
        rowCount: window.row_count,
        rows,
        start: requestStart,
      });
    }).catch((error) => {
      if (terminalBackendWindowSeqRef.current !== seq) return;
      onUpdateSession((current) => ({ ...current, message: String(error) }));
    });
  }, [
    onUpdateSession,
    session.analyzerDataPane,
    session.id,
    terminalBackendRequestKey,
    terminalBackendRequests,
    terminalBackendWindowEnabled,
    terminalWindow.end,
    terminalWindow.start,
  ]);

  async function exportAnalyzer(analyzerId: string, format: "csv" | "txt") {
    const analyzer = session.analyzers.find((item) => item.id === analyzerId);
    if (!analyzer || Math.max(analyzer.decodedFrameCount, analyzer.decodedFrames.length) === 0) return;
    try {
      let analyzerForExport = analyzer;
      if (!analyzer.decodedFramesComplete) {
        const settings = analyzerDecodeSettings(analyzer);
        if (!settings || !analyzerCanRunDecoder(analyzer)) return;
        const frames = normalizeDecodedFrameOrder(
          await decodeAnalyzerFrames(session.id, settings, analyzer.decoderBackend),
        );
        analyzerForExport = {
          ...analyzer,
          decodedFrameCount: frames.length,
          decodedFrames: frames,
          decodedFramesComplete: true,
          decodedDecodeSignature: getAnalyzerDecodeSignature(analyzer),
        };
        onUpdateSession((current) => ({
          ...current,
          analyzers: current.analyzers.map((item) => (item.id === analyzerId ? analyzerForExport : item)),
        }));
      }
      const path = await saveDialog({
        defaultPath: `${safeExportFileName(session.name || "capture")}-${safeExportFileName(analyzerForExport.name || analyzerForExport.type)}.${format}`,
        filters: [
          {
            name: format === "csv" ? "CSV" : "Text",
            extensions: [format],
          },
        ],
      });
      if (!path) return;
      await writeTextFile(path, analyzerExportText(analyzerForExport, sampleRateHz, format));
      onUpdateSession((current) => ({
        ...current,
        message: `${analyzerForExport.name} ${format.toUpperCase()} exported`,
      }));
    } catch (error) {
      onUpdateSession((current) => ({ ...current, message: String(error) }));
    }
  }

  const highlightedFrame = session.analyzers
    .map((analyzer) => ({
      analyzerId: analyzer.id,
      frameIndex: analyzer.highlightedFrameIndex,
      }))
    .find(({ frameIndex }) => frameIndex !== null);
  const suggestedAnalyzers = availableAnalyzers.filter((choice) => !choice.catalogItem).slice(0, 4);
  const openAnalyzerMenu = activeAnalyzerMenu
    ? session.analyzers.find((analyzer) => analyzer.id === activeAnalyzerMenu.analyzerId) ?? null
    : null;

  useEffect(() => {
    if (!highlightedFrame || session.analyzerDataPane !== "table") return;
    const targetIndex = normalizedSearch
      ? findAnalyzerFrameRefPosition(
          tableFrameSources,
          filteredTableFrameRefs ?? [],
          highlightedFrame.analyzerId,
          highlightedFrame.frameIndex,
        )
      : findAnalyzerFrameRowPosition(tableFrameSources, highlightedFrame.analyzerId, highlightedFrame.frameIndex);
    const table = tableBodyRef.current;
    if (!table || targetIndex < 0) return;
    const rowTop = ANALYZER_TABLE_HEADER_HEIGHT_PX + targetIndex * ANALYZER_TABLE_ROW_HEIGHT_PX;
    const rowBottom = rowTop + ANALYZER_TABLE_ROW_HEIGHT_PX;
    const visibleTop = table.scrollTop + ANALYZER_TABLE_HEADER_HEIGHT_PX;
    const visibleBottom = table.scrollTop + table.clientHeight;
    if (rowTop < visibleTop) {
      table.scrollTop = Math.max(0, rowTop - ANALYZER_TABLE_HEADER_HEIGHT_PX);
    } else if (rowBottom > visibleBottom) {
      table.scrollTop = Math.max(0, rowBottom - table.clientHeight);
    }
    syncTableViewport();
  }, [
    filteredTableFrameRefs,
    highlightedFrame?.analyzerId,
    highlightedFrame?.frameIndex,
    normalizedSearch,
    session.analyzerDataPane,
    tableFrameSources,
    syncTableViewport,
  ]);

  useLayoutEffect(() => {
    if (session.analyzerDataPane !== "table") return;
    const table = tableBodyRef.current;
    if (!table) return;
    const contentHeight =
      ANALYZER_TABLE_HEADER_HEIGHT_PX + filteredTableFrameCount * ANALYZER_TABLE_ROW_HEIGHT_PX;
    const maximumScrollTop = Math.max(0, contentHeight - table.clientHeight);
    if (table.scrollTop > maximumScrollTop) table.scrollTop = maximumScrollTop;
    syncTableViewport();
  }, [filteredTableFrameCount, session.analyzerDataPane, syncTableViewport]);

  useEffect(() => {
    if (session.analyzerDataPane !== "table") return;
    const table = tableBodyRef.current;
    if (!table) return;
    const syncTable = () => {
      syncTableVisibleRight();
      syncTableViewport();
    };
    const observer = new ResizeObserver(syncTable);
    observer.observe(table);
    const frame = window.requestAnimationFrame(syncTable);
    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(frame);
    };
  }, [session.analyzerDataPane, syncTableViewport, syncTableVisibleRight, tableMinimumWidth]);

  useEffect(() => {
    if (session.analyzerDataPane !== "terminal") return;
    const terminal = terminalBodyRef.current;
    if (!terminal) return;
    const observer = new ResizeObserver(syncTerminalViewport);
    observer.observe(terminal);
    const frame = window.requestAnimationFrame(syncTerminalViewport);
    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(frame);
    };
  }, [session.analyzerDataPane, syncTerminalViewport]);

  useEffect(() => {
    if (!selectorOpen && !activeAnalyzerMenu) return;
    const close = () => {
      setSelectorOpen(false);
      setSelectorAnchorRect(null);
      setActiveAnalyzerMenu(null);
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [activeAnalyzerMenu, selectorOpen]);

  return (
    <div className="analyzersSidebarPanel">
      <section className="analyzersSelectorSection">
        <div className="sidebarTitleRow">
          <div className="sidebarTitleText">Analyzers</div>
          <button
            aria-expanded={selectorOpen}
            aria-haspopup="menu"
            className={`sidebarCircleButton ${selectorOpen ? "active" : ""}`}
            onClick={toggleAnalyzerSelector}
            ref={selectorButtonRef}
            type="button"
          >
            <Plus size={13} />
          </button>
        </div>

        {selectorOpen && selectorAnchorRect && (
          <AnalyzerSelectionPopover
            anchorRect={selectorAnchorRect}
            choices={availableAnalyzers}
            onClose={() => {
              setSelectorOpen(false);
              setSelectorAnchorRect(null);
            }}
            onSelect={addAnalyzer}
          />
        )}

        {session.analyzers.length === 0 ? (
          <div className="suggestedAnalyzers">
            <div className="suggestedAnalyzersTitle">Suggested Analyzers</div>
            {suggestedAnalyzers.map((choice) => (
              <button
                className="suggestedAnalyzerItem"
                key={analyzerCatalogChoiceKey(choice)}
                onClick={() => addAnalyzer(choice)}
                type="button"
              >
                <SlidersHorizontal size={13} />
                <span>{choice.name}</span>
                <small>{choice.source}</small>
              </button>
            ))}
          </div>
        ) : (
          <DragDropContext onDragEnd={finishAnalyzerReorder} onDragStart={() => setActiveAnalyzerMenu(null)}>
            <StrictModeDroppable droppableId={`analyzer-list-${session.id}`}>
              {(droppableProvided) => (
                <div
                  className="activeAnalyzerList"
                  ref={droppableProvided.innerRef}
                  {...droppableProvided.droppableProps}
                >
                  {session.analyzers.map((analyzer, index) => (
                    <Draggable draggableId={analyzer.id} index={index} key={analyzer.id}>
                      {(draggableProvided, draggableSnapshot) => {
                        const analyzerBusy = analyzer.decodeBusy || analyzer.renderBusy;
                        const analyzerProgress = analyzer.renderBusy
                          ? analyzer.renderProgress
                          : analyzer.decodeBusy
                            ? analyzer.decodeProgress
                            : Math.max(analyzer.decodeProgress, analyzer.renderProgress);
                        const analyzerComplete = !analyzerBusy && analyzerProgress >= 100;
                        return (
                          <div
                            className={`activeAnalyzerItem ${draggableSnapshot.isDragging ? "dragging" : ""}`}
                            ref={draggableProvided.innerRef}
                            {...draggableProvided.draggableProps}
                            style={{
                              ...draggableProvided.draggableProps.style,
                              zIndex: draggableSnapshot.isDragging ? 5000 : undefined,
                            }}
                          >
                            <div className="activeAnalyzerHeader">
                              <span
                                aria-label={`Move ${analyzer.name}`}
                                className="analyzerDragHandle"
                                title="Drag to reorder"
                                {...draggableProvided.dragHandleProps}
                              >
                                <GripVertical size={13} />
                              </span>
                              <span className="analyzerColorIndicator" style={{ background: analyzer.color }} />
                              <button className="analyzerNameButton" onDoubleClick={() => onEditAnalyzer(analyzer.id)} type="button">
                                <strong title={analyzer.nativeCatalogDescription ?? analyzer.type}>{analyzer.name}</strong>
                                <small>
                                  {decoderBackendLabel(analyzer.decoderBackend)} · {analyzerPhysicalChannelSummary(analyzer)}
                                  {analyzer.nativeRunnerStatus === "catalog_only" ? " · Catalog only" : ""}
                                </small>
                              </button>
                              <span
                                aria-label={
                                  analyzerBusy
                                    ? `${Math.round(analyzerProgress)}% decoded`
                                    : analyzerComplete
                                      ? "Decoder complete"
                                      : "Decoder idle"
                                }
                                className={`analyzerDecodeStatus ${analyzerBusy ? "busy" : ""} ${analyzerComplete ? "complete" : ""}`}
                                title={
                                  analyzerBusy
                                    ? `Decoding ${Math.round(analyzerProgress)}%`
                                    : analyzerComplete
                                      ? "Decoding complete"
                                      : "Decoder idle"
                                }
                              >
                                {analyzerBusy ? (
                                  <span className="analyzerDecodeProgressBadge">
                                    <AnalyzerProgressRing value={analyzerProgress} />
                                    <span>{Math.round(analyzerProgress)}%</span>
                                  </span>
                                ) : analyzerComplete ? (
                                  <span className="analyzerDecodeCompleteBadge">
                                    <Check size={13} />
                                  </span>
                                ) : null}
                              </span>
                              <button
                                aria-expanded={activeAnalyzerMenu?.analyzerId === analyzer.id}
                                aria-haspopup="menu"
                                className={`analyzerKebabButton ${activeAnalyzerMenu?.analyzerId === analyzer.id ? "active" : ""}`}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  const rect = event.currentTarget.getBoundingClientRect();
                                  setSelectorOpen(false);
                                  setSelectorAnchorRect(null);
                                  setActiveAnalyzerMenu((current) =>
                                    current?.analyzerId === analyzer.id ? null : { analyzerId: analyzer.id, anchorRect: rect },
                                  );
                                }}
                                title="Analyzer menu"
                                type="button"
                              >
                                <MoreVertical size={15} />
                              </button>
                            </div>
                          </div>
                        );
                      }}
                    </Draggable>
                  ))}
                  {droppableProvided.placeholder}
                </div>
              )}
            </StrictModeDroppable>
          </DragDropContext>
        )}
        {activeAnalyzerMenu && openAnalyzerMenu && (
          <AnalyzerItemMenu
            anchorRect={activeAnalyzerMenu.anchorRect}
            analyzer={openAnalyzerMenu}
            canMoveDown={
              session.analyzers.findIndex((candidate) => candidate.id === openAnalyzerMenu.id) <
              session.analyzers.length - 1
            }
            canMoveUp={session.analyzers.findIndex((candidate) => candidate.id === openAnalyzerMenu.id) > 0}
            canRestart={Boolean(session.summary) && !openAnalyzerMenu.decodeBusy && analyzerCanRunDecoder(openAnalyzerMenu)}
            onClose={() => setActiveAnalyzerMenu(null)}
            onDelete={() => removeAnalyzer(openAnalyzerMenu.id)}
            onEdit={() => onEditAnalyzer(openAnalyzerMenu.id)}
            onExport={(format) => void exportAnalyzer(openAnalyzerMenu.id, format)}
            onMove={(direction) => moveAnalyzer(openAnalyzerMenu.id, direction)}
            onRestart={() => onDecodeAnalyzer(openAnalyzerMenu.id)}
            onUpdate={(updater) => updateAnalyzerItem(openAnalyzerMenu.id, updater)}
          />
        )}
      </section>

      <AnalyzerTriggerView
        onUpdateSession={onUpdateSession}
        session={session}
      />

      <section className="analyzerDataSection">
        <div className="sidebarTitleRow tight">
          <div className="sidebarTitleText">
            Data
            <small>{session.analyzerDataPane === "terminal" ? terminalEffectiveFrameCount : filteredTableFrameCount}</small>
          </div>
          <div className="dataPaneButtons">
            <button
              className={session.analyzerDataPane === "table" ? "active" : ""}
              onClick={() => onUpdateSession((current) => ({ ...current, analyzerDataPane: "table" }))}
              title="Data Table"
              type="button"
            >
              <Table2 size={13} />
            </button>
            <button
              className={session.analyzerDataPane === "terminal" ? "active" : ""}
              onClick={() => onUpdateSession((current) => ({ ...current, analyzerDataPane: "terminal" }))}
              title="Terminal"
              type="button"
            >
              <Terminal size={13} />
            </button>
          </div>
        </div>

        {session.analyzerDataPane === "table" ? (
          <div className="analyzerDataTable">
            <div className="analyzerDataToolbar">
              <div className="analyzerSearchField">
                <Search size={13} />
                <input
                  aria-label="Search analyzer results"
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder="Type to search"
                  type="search"
                  value={searchQuery}
                />
              </div>
              <button
                aria-label="Copy analyzer data"
                disabled={filteredTableFrameCount === 0}
                onClick={async () => {
                  const rows: string[] = [];
                  let columns = tableDataColumns;
                  const appendRow = ({ analyzer, frame, frameNumber }: AnalyzerFrameListRow, roles = columns) => {
                    rows.push([
                      frameNumber,
                      frame.frame_type,
                      formatSeconds(frame.start_sample / Math.max(1, sampleRateHz)),
                      formatSeconds((frame.end_sample - frame.start_sample) / Math.max(1, sampleRateHz)),
                      ...roles.map(
                        (role) => {
                          const value = frame.channel_values.find((item) => item.role === role);
                          return value ? formatAnalyzerChannelValue(analyzer, value) : "";
                        },
                      ),
                    ].join("\t"));
                  };
                  if (tableSearchBackendWindowEnabled) {
                    const analyzerById = new Map(tableSearchBackendRequests.map(({ analyzer }) => [analyzer.id, analyzer]));
                    const window = await decodeAnalyzerFrameTableSearchWindow(
                      session.id,
                      tableSearchBackendRequests.map(({ request }) => request),
                      normalizedSearch,
                      0,
                      filteredTableFrameCount,
                    );
                    columns = window.roles;
                    window.rows.forEach((row) => {
                      const analyzer = analyzerById.get(row.analyzer_id);
                      if (!analyzer) return;
                      appendRow({
                        analyzer,
                        frame: row.frame,
                        frameIndex: row.frame_index,
                        frameNumber: row.frame_number,
                      }, columns);
                    });
                  } else if (tableBackendWindowEnabled && !filteredTableFrameRefs) {
                    const analyzerById = new Map(tableBackendRequests.map(({ analyzer }) => [analyzer.id, analyzer]));
                    const window = await decodeAnalyzerFrameTableWindow(
                      session.id,
                      tableBackendRequests.map(({ request }) => request),
                      0,
                      filteredTableFrameCount,
                    );
                    columns = window.roles;
                    window.rows.forEach((row) => {
                      const analyzer = analyzerById.get(row.analyzer_id);
                      if (!analyzer) return;
                      appendRow({
                        analyzer,
                        frame: row.frame,
                        frameIndex: row.frame_index,
                        frameNumber: row.frame_number,
                      }, columns);
                    });
                  } else if (filteredTableFrameRefs) {
                    analyzerFrameListRowsFromRefs(tableFrameSources, filteredTableFrameRefs).forEach((row) => appendRow(row));
                  } else {
                    forEachAnalyzerFrameListRow(tableFrameSources, appendRow);
                  }
                  const header = ["Frame", "Type", "Start", "Duration", ...columns].join("\t");
                  void navigator.clipboard?.writeText([header, ...rows].join("\n"));
                }}
                title="Copy"
                type="button"
              >
                <Copy size={12} />
              </button>
            </div>
            <div className="analyzerFramesList" onScroll={handleTableScroll} ref={tableBodyRef}>
              <div
                className="analyzerTableHeader"
                aria-hidden="true"
                style={{ gridTemplateColumns: tableGridTemplate, minWidth: tableMinimumWidth }}
              >
                <span />
                <span />
                <span>#</span>
                <span>Type</span>
                <span>Start</span>
                <span>Duration</span>
                {tableDataColumns.map((role) => <span key={role}>{role}</span>)}
              </div>
              {session.analyzers.length === 0 ? (
                <div className="empty-result">No analyzers</div>
              ) : tableFrameCount === 0 ? (
                <div className="empty-result">
                  {session.analyzers.some((analyzer) => analyzer.decodeBusy) ? "Analyzing..." : "No frames"}
                </div>
              ) : tableSearchBackendWindowEnabled && !tableSearchBackendWindowRowsMatch ? (
                <div className="empty-result">Loading matching data...</div>
              ) : filteredTableFrameCount === 0 ? (
                <div className="empty-result">No matching frames</div>
              ) : tableBackendWindowEnabled && !tableBackendWindowMatches ? (
                <div className="empty-result">Loading data...</div>
              ) : (
                <>
                  <div
                    aria-hidden="true"
                    className="analyzerVirtualSpacer"
                    style={{ height: tableWindow.startPaddingPx, minWidth: tableMinimumWidth }}
                  />
                  {visibleTableFrames.map(({ analyzer, frame, frameIndex, frameNumber }) => {
                    const selected =
                      highlightedFrame?.analyzerId === analyzer.id && highlightedFrame.frameIndex === frameIndex;
                    return (
                      <div
                        className={`decode-row ${selected ? "selected" : ""}`}
                        data-analyzer-frame={`${analyzer.id}:${frameIndex}`}
                        key={`${analyzer.id}-${frame.start_sample}-${frameIndex}`}
                        onClick={() =>
                          onUpdateSession((current) =>
                            highlightAnalyzerFrameInSession(current, analyzer.id, frameIndex),
                          )
                        }
                        style={{
                          "--analyzer-color": analyzer.color,
                          gridTemplateColumns: tableGridTemplate,
                          minWidth: tableMinimumWidth,
                        } as CSSProperties}
                      >
                      <span className="decodeAnalyzerDot" title={analyzer.name} />
                      <button
                        className="analyzerGoToButton"
                        onClick={(event) => {
                          event.stopPropagation();
                          onGoToAnalyzerFrame(analyzer.id, frameIndex, false, frame);
                        }}
                        onDoubleClick={(event) => {
                          event.stopPropagation();
                          onGoToAnalyzerFrame(analyzer.id, frameIndex, true, frame);
                        }}
                        title={"Go to data\nDouble click to zoom"}
                        type="button"
                      >
                        <SaleaeGoToIcon />
                      </button>
                      <span className="analyzerFrameNumber">{frameNumber}</span>
                      <span className="analyzerDataCell">
                        <HighlightedAnalyzerText query={deferredSearchQuery} text={frame.frame_type} />
                      </span>
                      <span className="analyzerTimeCell">{formatSeconds(frame.start_sample / Math.max(1, sampleRateHz))}</span>
                      <span className="analyzerTimeCell">
                        {formatSeconds((frame.end_sample - frame.start_sample) / Math.max(1, sampleRateHz))}
                      </span>
                      {tableDataColumns.map((role) => (
                        <span className="analyzerDataCell" key={role}>
                          <HighlightedAnalyzerText
                            query={deferredSearchQuery}
                            text={formatAnalyzerTableRoleValue(analyzer, frame, role)}
                          />
                        </span>
                      ))}
                      </div>
                    );
                  })}
                  <div
                    aria-hidden="true"
                    className="analyzerVirtualSpacer"
                    style={{ height: tableWindow.endPaddingPx, minWidth: tableMinimumWidth }}
                  />
                </>
              )}
            </div>
          </div>
        ) : (
          <div className="analyzerTerminal" onScroll={syncTerminalViewport} ref={terminalBodyRef}>
            {terminalEffectiveFrameCount === 0 ? (
              <div className="empty-result">No terminal data</div>
            ) : terminalBackendWindowEnabled && !terminalBackendWindowMatches ? (
              <div className="empty-result">Loading terminal data...</div>
            ) : (
              <>
                <div
                  aria-hidden="true"
                  className="analyzerVirtualSpacer"
                  style={{ height: terminalWindow.startPaddingPx }}
                />
                {visibleTerminalFrames.map(({ analyzer, frame, frameIndex, frameNumber }) => (
                  <div className="terminalLine" key={`${analyzer.id}-${frame.start_sample}-${frameIndex}`}>
                    <span>#{frameNumber}</span>
                    <span>{formatSamples(frame.start_sample)}</span>
                    <strong>{formatAnalyzerFrameLabel(analyzer, frame)}</strong>
                  </div>
                ))}
                <div
                  aria-hidden="true"
                  className="analyzerVirtualSpacer"
                  style={{ height: terminalWindow.endPaddingPx }}
                />
              </>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

function analyzerFrameRowSearchText(row: AnalyzerFrameListRow) {
  const { analyzer, frame, frameNumber } = row;
  const cacheKey = `${analyzer.id}\u0000${analyzer.name}\u0000${analyzer.displayRadix}\u0000${frameNumber}`;
  const cachedFrame = ANALYZER_FRAME_ROW_SEARCH_TEXT_CACHE.get(frame);
  const cached = cachedFrame?.get(cacheKey);
  if (cached) return cached;
  let text = `${analyzer.name} ${frameNumber} ${frame.frame_type} ${formatAnalyzerFrameLabel(analyzer, frame)}`;
  for (const value of frame.channel_values) {
    text += ` ${value.role} ${formatAnalyzerChannelValue(analyzer, value)}`;
  }
  const normalized = text.toLowerCase();
  if (cachedFrame) cachedFrame.set(cacheKey, normalized);
  else ANALYZER_FRAME_ROW_SEARCH_TEXT_CACHE.set(frame, new Map([[cacheKey, normalized]]));
  return normalized;
}

function AnalyzerProgressRing({ value }: { value: number }) {
  const radius = 5;
  const circumference = 2 * Math.PI * radius;
  const progress = Math.max(0, Math.min(100, value));
  return (
    <svg aria-hidden="true" className="analyzerProgressRing" viewBox="0 0 12 12">
      <circle className="analyzerProgressRingTrack" cx="6" cy="6" r={radius} />
      <circle
        className="analyzerProgressRingValue"
        cx="6"
        cy="6"
        r={radius}
        style={{
          strokeDasharray: circumference,
          strokeDashoffset: circumference * (1 - progress / 100),
        }}
      />
    </svg>
  );
}

function AnalyzerSelectionPopover({
  anchorRect,
  choices,
  onClose,
  onSelect,
}: {
  anchorRect: DOMRect;
  choices: AnalyzerLibraryChoice[];
  onClose: () => void;
  onSelect: (choice: AnalyzerLibraryChoice) => void;
}) {
  const width = 432;
  const height = Math.min(460, Math.max(260, typeof window === "undefined" ? 460 : window.innerHeight - 86));
  const position = clampFixedPopoverRect(anchorRect, width, height, { align: "end", gap: 8 });
  return createPortal(
    <div className="analyzerFloatingLayer" onPointerDown={onClose} role="presentation">
      <div
        className="analyzerSelectionPopover"
        onPointerDown={(event) => event.stopPropagation()}
        role="presentation"
        style={{ ...position, width }}
      >
        <AnalyzerLibraryMenu choices={choices} onSelect={onSelect} />
      </div>
    </div>,
    document.body,
  );
}

function AnalyzerItemMenu({
  analyzer,
  anchorRect,
  canMoveDown,
  canMoveUp,
  canRestart,
  onClose,
  onDelete,
  onEdit,
  onExport,
  onMove,
  onRestart,
  onUpdate,
}: {
  analyzer: UiAnalyzerInstance;
  anchorRect: DOMRect;
  canMoveDown: boolean;
  canMoveUp: boolean;
  canRestart: boolean;
  onClose: () => void;
  onDelete: () => void;
  onEdit: () => void;
  onExport: (format: "csv" | "txt") => void;
  onMove: (direction: -1 | 1) => void;
  onRestart: () => void;
  onUpdate: (updater: (analyzer: UiAnalyzerInstance) => UiAnalyzerInstance) => void;
}) {
  const width = 238;
  const position = clampFixedPopoverRect(anchorRect, width, 500, { align: "end", gap: 4 });
  const runAction = (action: () => void) => {
    onClose();
    action();
  };
  const restartTitle = analyzerCanRunDecoder(analyzer)
    ? "Restart analyzer"
    : "Decoder runner is not available yet";
  const canExport = Math.max(analyzer.decodedFrameCount, analyzer.decodedFrames.length) > 0;

  return createPortal(
    <div className="analyzerFloatingLayer" onPointerDown={onClose} role="presentation">
      <div
        className="activeAnalyzerMenu saleaeContextMenu"
        onPointerDown={(event) => event.stopPropagation()}
        role="menu"
        style={{ ...position, width }}
      >
        <button onClick={() => runAction(onEdit)} role="menuitem" type="button">
          <Settings2 size={13} />
          <span>Settings...</span>
        </button>
        <div className="analyzerMenuColorBlock" role="group" aria-label="Select Color">
          <span>Select Color</span>
          <div className="analyzerMenuColorGrid">
            {SALEAE_ANALYZER_COLORS.map((color) => (
              <button
                aria-label={`Color ${color}`}
                className={color.toLowerCase() === analyzer.color.toLowerCase() ? "selected" : ""}
                key={color}
                onClick={() => runAction(() => onUpdate((item) => ({ ...item, color })))}
                style={{ "--swatch-color": color } as CSSProperties}
                type="button"
              >
                {color.toLowerCase() === analyzer.color.toLowerCase() && <Check size={11} />}
              </button>
            ))}
          </div>
        </div>
        <button
          disabled={!canRestart}
          onClick={() => runAction(onRestart)}
          role="menuitem"
          title={canRestart ? "Restart analyzer" : restartTitle}
          type="button"
        >
          <RefreshCw size={13} />
          <span>Restart</span>
        </button>
        <button disabled={!canMoveUp} onClick={() => runAction(() => onMove(-1))} role="menuitem" type="button">
          <ChevronUp size={13} />
          <span>Move Up</span>
        </button>
        <button disabled={!canMoveDown} onClick={() => runAction(() => onMove(1))} role="menuitem" type="button">
          <ChevronDown size={13} />
          <span>Move Down</span>
        </button>
        <div className="analyzerMenuDivider" role="separator" />
        <button
          aria-checked={analyzer.streamToTerminal}
          onClick={() => runAction(() => onUpdate((item) => ({ ...item, streamToTerminal: !item.streamToTerminal })))}
          role="menuitemcheckbox"
          type="button"
        >
          <span className="analyzerMenuCheck">{analyzer.streamToTerminal && <Check size={12} />}</span>
          <span>Stream to Terminal</span>
        </button>
        <button
          aria-checked={analyzer.showInDataTable}
          onClick={() => runAction(() => onUpdate((item) => ({ ...item, showInDataTable: !item.showInDataTable })))}
          role="menuitemcheckbox"
          type="button"
        >
          <span className="analyzerMenuCheck">{analyzer.showInDataTable && <Check size={12} />}</span>
          <span>Show in Data Table</span>
        </button>
        <div className="analyzerMenuDivider" role="separator" />
        {DISPLAY_RADIX_OPTIONS.map((radix) => (
          <button
            aria-checked={analyzer.displayRadix === radix}
            key={radix}
            onClick={() => runAction(() => onUpdate((item) => ({ ...item, displayRadix: normalizeAnalyzerDisplayRadix(radix) })))}
            role="menuitemradio"
            type="button"
          >
            <span className="analyzerMenuCheck">{analyzer.displayRadix === radix && <Check size={12} />}</span>
            <span>{radix}</span>
          </button>
        ))}
        <div className="analyzerMenuDivider" role="separator" />
        <button
          disabled={!canExport}
          onClick={() => runAction(() => onExport("csv"))}
          role="menuitem"
          title={canExport ? "Export decoded analyzer data to CSV" : "No decoded frames to export"}
          type="button"
        >
          <FileDown size={13} />
          <span>Export CSV</span>
        </button>
        <button
          disabled={!canExport}
          onClick={() => runAction(() => onExport("txt"))}
          role="menuitem"
          title={canExport ? "Export decoded analyzer data to TXT" : "No decoded frames to export"}
          type="button"
        >
          <FileDown size={13} />
          <span>Export TXT</span>
        </button>
        <div className="analyzerMenuDivider" role="separator" />
        <button className="danger" onClick={() => runAction(onDelete)} role="menuitem" type="button">
          <Trash2 size={13} />
          <span>Delete</span>
        </button>
      </div>
    </div>,
    document.body,
  );
}

function analyzerPhysicalChannelSummary(analyzer: UiAnalyzerInstance) {
  const channels = analyzerChannelIndexes(analyzer);
  if (channels.length === 0) return "Catalog";
  if (channels.length === 1) return `D${channels[0]}`;
  return `${channels.length} channels`;
}

function formatAnalyzerFrameLabel(analyzer: UiAnalyzerInstance, frame: DecodedFrame) {
  return formatAnalyzerText(frame.label, analyzer.displayRadix, frame.value);
}

function formatAnalyzerChannelValue(analyzer: UiAnalyzerInstance, value: DecodedChannelValue) {
  return formatAnalyzerText(value.label, analyzer.displayRadix, value.value);
}

function formatAnalyzerTableRoleValue(
  analyzer: UiAnalyzerInstance,
  frame: DecodedFrame,
  role: string,
) {
  const value = frame.channel_values.find((item) => item.role === role);
  return value ? formatAnalyzerChannelValue(analyzer, value) : "";
}

function analyzerExportText(
  analyzer: UiAnalyzerInstance,
  sampleRateHz: number,
  format: "csv" | "txt",
) {
  const roles: string[] = [];
  analyzer.decodedFrames.forEach((frame) => {
    frame.channel_values.forEach((value) => {
      if (!roles.includes(value.role)) roles.push(value.role);
    });
  });
  const headers = ["Frame", "Type", "Start", "Duration", "Label", ...roles];
  const rows = analyzer.decodedFrames
    .slice()
    .sort((left, right) => left.start_sample - right.start_sample || left.frame_id - right.frame_id)
    .map((frame, framePosition) => [
      (framePosition + 1).toString(),
      frame.frame_type,
      formatSeconds(frame.start_sample / Math.max(1, sampleRateHz)),
      formatSeconds((frame.end_sample - frame.start_sample) / Math.max(1, sampleRateHz)),
      formatAnalyzerFrameLabel(analyzer, frame),
      ...roles.map((role) => formatAnalyzerTableRoleValue(analyzer, frame, role)),
    ]);
  const delimiter = format === "csv" ? "," : "\t";
  const escapeCell = format === "csv" ? csvCell : txtCell;
  return [headers, ...rows].map((row) => row.map(escapeCell).join(delimiter)).join("\n");
}

function csvCell(value: string) {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, "\"\"")}"` : value;
}

function txtCell(value: string) {
  return value.replace(/\r?\n/g, " ");
}

function safeExportFileName(value: string) {
  return value.replace(/[<>:"/\\|?*\x00-\x1f]+/g, "_").trim() || "analyzer";
}

function AnalyzerTriggerView({
  onUpdateSession,
  session,
}: {
  onUpdateSession: (updater: (session: UiSession) => UiSession) => void;
  session: UiSession;
}) {
  const trigger = session.analyzerTrigger;
  const selectedAnalyzer = session.analyzers.find((analyzer) => analyzer.id === trigger.analyzerId);

  function updateTrigger(patch: Partial<UiAnalyzerTriggerState>) {
    onUpdateSession((current) => ({
      ...current,
      analyzerTrigger: { ...current.analyzerTrigger, ...patch },
    }));
  }

  return (
    <section className={`analyzerTriggerView ${trigger.expanded ? "expanded" : ""}`}>
      <div className="analyzerTriggerHeader">
        <button
          aria-expanded={trigger.expanded}
          className="analyzerTriggerExpandButton"
          onClick={() => updateTrigger({ expanded: !trigger.expanded })}
          type="button"
        >
          <ChevronRight size={11} />
          <strong>Trigger View</strong>
          <Activity
            aria-label="Experimental"
            data-help-tooltip="Experimental! Partial match of your query against a single analyzer result"
            size={11}
          />
        </button>
        <span
          className="saleaeSwitch analyzerTriggerSwitch"
          data-help-tooltip="Analyzer Trigger is not available for this device"
        >
          <input aria-label="Enable Analyzer Trigger" checked={false} disabled readOnly type="checkbox" />
          <span className="saleaeSwitchTrack">
            <span className="saleaeSwitchHandle" />
          </span>
        </span>
      </div>
      <div className="analyzerTriggerBody" aria-hidden={!trigger.expanded}>
        <label className="stack-field">
          <span>Analyzer</span>
          <select
            disabled={session.analyzers.length === 0}
            onChange={(event) => updateTrigger({ analyzerId: event.target.value })}
            value={selectedAnalyzer?.id ?? ""}
          >
            <option value="">Select analyzer...</option>
            {session.analyzers.map((analyzer) => (
              <option key={analyzer.id} value={analyzer.id}>{analyzer.name}</option>
            ))}
          </select>
        </label>
        <div className="analyzerTriggerQueryGrid">
          <label className="stack-field">
            <span>Query</span>
            <input
              disabled
              onChange={(event) => updateTrigger({ query: event.target.value })}
              placeholder="Value [Hexadecimal]"
              type="text"
              value={trigger.query}
            />
          </label>
          <label className="stack-field">
            <span>Holdoff</span>
            <input
              disabled
              min={0.1}
              onChange={(event) => updateTrigger({ holdoffSeconds: Number(event.target.value) })}
              step={0.1}
              type="number"
              value={trigger.holdoffSeconds}
            />
          </label>
        </div>
      </div>
    </section>
  );
}

function HighlightedAnalyzerText({ query, text }: { query: string; text: string }) {
  const normalized = query.trim();
  if (!normalized) return <>{text}</>;
  const index = text.toLowerCase().indexOf(normalized.toLowerCase());
  if (index < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, index)}
      <mark>{text.slice(index, index + normalized.length)}</mark>
      {text.slice(index + normalized.length)}
    </>
  );
}

function SaleaeGoToIcon() {
  return (
    <svg aria-hidden="true" height="8" viewBox="0 0 9 8" width="9">
      <path
        clipRule="evenodd"
        d="M8.38251 3.28221L8.75336 2.90909L8.38251 2.53597L5.86198 0L5.11699 0.746248L6.77722 2.41665C5.40072 2.44137 4.30341 2.52756 3.43081 2.68882C2.38124 2.88278 1.60603 3.19407 1.06057 3.68567C0.502764 4.1884 0.24287 4.82691 0.119121 5.54781C-3.76701e-05 6.24197 -1.99676e-05 7.06173 0 7.96527V8H1C1 7.05398 1.00156 6.31786 1.10471 5.71699C1.20478 5.13398 1.39254 4.73268 1.73005 4.4285C2.0799 4.11319 2.64764 3.85048 3.61253 3.67217C4.40473 3.52577 5.4306 3.44213 6.76172 3.41712L5.11699 5.07193L5.86198 5.81818L8.38251 3.28221Z"
        fill="currentColor"
        fillRule="evenodd"
      />
    </svg>
  );
}

function CursorsPanel({
  onUpdateSession,
  sampleRateHz,
  session,
}: {
  onUpdateSession: (updater: (session: UiSession) => UiSession) => void;
  sampleRateHz: number;
  session: UiSession;
}) {
  const cursor = session.cursorState;
  const deltaSamples = Math.abs(cursor.x2Sample - cursor.x1Sample);
  const deltaSeconds = deltaSamples / Math.max(1, sampleRateHz);
  const frequency = deltaSeconds > 0 ? 1 / deltaSeconds : 0;
  const channelCount = session.summary?.metadata.channel_count ?? session.settings.channel_count;
  const rows = [
    ["x1", formatSeconds(cursor.x1Sample / Math.max(1, sampleRateHz)), ""],
    ["x2", formatSeconds(cursor.x2Sample / Math.max(1, sampleRateHz)), ""],
    ["Δx", formatSeconds(deltaSeconds), ""],
    ["1/Δx", frequency > 0 ? formatRate(frequency) : "-", ""],
    ["y1", cursor.visible ? "Digital" : "-", `D${cursor.y1Channel}`],
    ["y2", cursor.visible ? "Digital" : "-", `D${cursor.y2Channel}`],
    ["Δy", cursor.visible ? "1 state" : "-", ""],
  ];

  function updateCursor(patch: Partial<UiCursorState>) {
    onUpdateSession((current) => ({
      ...current,
      cursorState: { ...current.cursorState, ...patch },
    }));
  }

  function copyRows() {
    const content = rows.map((row) => row.filter(Boolean).join("\t")).join("\n");
    void navigator.clipboard?.writeText(content);
  }

  return (
    <div className="cursorsSettingsPanel">
      <section className="deviceSettingsBlock compact">
        <div className="deviceSettingsBlockTitle">
          <span>Cursors</span>
          <button className="deviceSettingsSmallButton" onClick={copyRows} type="button">
            <Copy size={12} />
            Copy
          </button>
        </div>
        <label className="toggle-field panel-toggle">
          <input
            checked={cursor.visible}
            onChange={(event) => updateCursor({ visible: event.target.checked })}
            type="checkbox"
          />
          Cursors On
        </label>
      </section>

      <table className="cursorsTable">
        <tbody>
          {rows.map(([label, value, channel]) => (
            <tr className={!cursor.visible ? "hiddenCursorRow" : ""} key={label}>
              <th>{label}</th>
              <td>{value}</td>
              <td>{channel}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <section className="deviceSettingsBlock compact">
        <div className="deviceSettingsBlockTitle">
          <span>Y Cursor Channels</span>
        </div>
        <div className="twoColumnFields">
          <label className="stack-field">
            <span>y1</span>
            <select
              value={cursor.y1Channel}
              onChange={(event) => updateCursor({ y1Channel: Number(event.target.value) })}
            >
              {Array.from({ length: channelCount }, (_, index) => (
                <option key={index} value={index}>
                  D{index}
                </option>
              ))}
            </select>
          </label>
          <label className="stack-field">
            <span>y2</span>
            <select
              value={cursor.y2Channel}
              onChange={(event) => updateCursor({ y2Channel: Number(event.target.value) })}
            >
              {Array.from({ length: channelCount }, (_, index) => (
                <option key={index} value={index}>
                  D{index}
                </option>
              ))}
            </select>
          </label>
        </div>
      </section>
    </div>
  );
}

function MeasurementsPanel({
  onAdd,
  onOpenExtensions,
  onUpdateSession,
  onViewportChange,
  session,
}: {
  onAdd: () => void;
  onOpenExtensions: () => void;
  onUpdateSession: (updater: (session: UiSession) => UiSession) => void;
  onViewportChange: (start: number, samples: number) => void;
  session: UiSession;
}) {
  const [addOpen, setAddOpen] = useState(false);
  const [openMenuFor, setOpenMenuFor] = useState<string | null>(null);
  const sampleRateHz = session.summary?.metadata.sample_rate_hz ?? session.settings.sample_rate_hz;
  const canAdd = Boolean(session.summary) && !session.busy;

  function updateRange(id: string, patch: Partial<UiRangeMeasurement>) {
    onUpdateSession((current) => ({
      ...current,
      rangeMeasurements: current.rangeMeasurements.map((range) =>
        range.id === id ? { ...range, ...patch } : range,
      ),
    }));
  }

  function selectRange(id: string) {
    onUpdateSession((current) => ({
      ...current,
      rangeMeasurements: current.rangeMeasurements.map((range) => ({
        ...range,
        selected: range.id === id,
        showTooltip: range.id === id,
      })),
    }));
  }

  function deleteRange(id: string) {
    onUpdateSession((current) => ({
      ...current,
      rangeMeasurements: current.rangeMeasurements.filter((range) => {
        const target = current.rangeMeasurements.find((item) => item.id === id);
        return target?.selected ? !range.selected : range.id !== id;
      }),
    }));
  }

  function deleteAll() {
    onUpdateSession((current) => ({ ...current, rangeMeasurements: [] }));
  }

  function goToRange(range: UiRangeMeasurement, zoom = false) {
    const span = Math.max(1, range.endSample - range.startSample);
    const padding = zoom ? Math.round(span * 0.08) : Math.round(session.viewportSamples * 0.5);
    const start = Math.max(0, range.startSample - padding);
    const samples = zoom ? span + padding * 2 : session.viewportSamples;
    onViewportChange(start, samples);
    selectRange(range.id);
  }

  function copyRange(range: UiRangeMeasurement) {
    void navigator.clipboard?.writeText(
      copyRangeMeasurementValues({
        channelIndex: range.channelIndex,
        measurementIds: ensureRangeMeasurementIds(range.measurements),
        name: range.name,
        note: range.note,
        stats: range.measurementStats,
      }),
    );
  }

  function addRangeFromMenu() {
    setAddOpen(false);
    onAdd();
  }

  return (
    <div className="measurementsSidebarPanel">
      <div className="sidebarTitleRow">
        <div className="sidebarTitleText">Measurements</div>
        <div className="measurementAddMenu">
          <button
            className="sidebarCircleButton"
            data-help-tooltip="Click and drag to select a range or click to start and end a range"
            disabled={!canAdd}
            onClick={() => setAddOpen((open) => !open)}
            title={canAdd ? "Add Measurement" : "Disabled while recording and before the first capture"}
            type="button"
          >
            <Plus size={13} />
          </button>
          {addOpen && (
            <div className="measurementAddPopover">
              <button className="popover-row" onClick={addRangeFromMenu} type="button">
                <span>Add Measurement</span>
                <small>Cmd/Ctrl+G</small>
              </button>
            </div>
          )}
        </div>
      </div>

      {session.rangeMeasurements.length === 0 ? (
        <div className="emptyMeasurementState">
          <img alt="" draggable={false} src={emptyMeasurementArt} />
          <span>Click "+" to add Measurements</span>
        </div>
      ) : (
        <div className="rangeMeasurementList">
          {session.rangeMeasurements.map((range) => {
            const stats = range.measurementStats;
            const measurementIds = ensureRangeMeasurementIds(range.measurements);
            const displayedMeasurements = measurementIds.flatMap((id) => {
              const definition = rangeMeasurementDefinition(id);
              if (!definition) return [];
              return [{ definition, formatted: formatRangeMeasurementValue(id, stats) }];
            });
            return (
              <section
                className="rangeMeasurementItem"
                key={range.id}
                onClick={() => selectRange(range.id)}
                onDoubleClick={() => goToRange(range)}
                style={{ "--range-color": range.color } as CSSProperties}
              >
                <button
                  className={`rangeExpandButton ${range.expanded ? "expanded" : ""}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    updateRange(range.id, { expanded: !range.expanded });
                  }}
                  title={range.expanded ? "Collapse" : "Expand"}
                  type="button"
                >
                  <SaleaeIcon name="arrowHead" size={6} />
                </button>
                <span className="rangeColorSwatch" />
                <div className="rangeLabelContainer" title={range.name}>
                  <input
                    aria-label="Range name"
                    onChange={(event) => updateRange(range.id, { name: event.target.value })}
                    onClick={(event) => event.stopPropagation()}
                    style={{ width: `${Math.min(14, Math.max(2, range.name.length + 1))}ch` }}
                    value={range.name}
                  />
                  <span className="rangeDirectionArrow"><SaleaeIcon name="arrow" /></span>
                </div>
                <div className="rangeValueContainer">
                  <strong className="rangeDeltaValue">Δ{formatDeltaTime(stats, sampleRateHz)}</strong>
                </div>
                <div className="rangeCommentContainer">
                  <RangeCommentBubble note={range.note} />
                </div>
                <div className="rangeMeasurementActions">
                  <button
                    className="rangeGotoButton"
                    onClick={(event) => {
                      event.stopPropagation();
                      goToRange(range);
                    }}
                    title="Go to range. Double click to zoom."
                    type="button"
                  >
                    <SaleaeIcon name="goto" size={10} />
                  </button>
                  <button
                    className="rangeMenuButton"
                    onClick={(event) => {
                      event.stopPropagation();
                      setOpenMenuFor((current) => (current === range.id ? null : range.id));
                    }}
                    title="More"
                    type="button"
                  >
                    <SaleaeIcon name="verticalThreeDots" size={14} />
                  </button>
                  {openMenuFor === range.id && (
                    <div className="rangeItemMenu" onClick={(event) => event.stopPropagation()}>
                      <button className="purple" onClick={onOpenExtensions} type="button">
                        Find More Measurements
                      </button>
                      <button onClick={() => goToRange(range)} type="button">
                        Go to Range
                      </button>
                      <button onClick={() => goToRange(range, true)} type="button">
                        Zoom on Range
                      </button>
                      <button onClick={() => copyRange(range)} type="button">
                        Copy
                      </button>
                      <button onClick={() => deleteRange(range.id)} type="button">
                        {range.selected ? "Delete Selected" : "Delete"}
                      </button>
                      <button onClick={deleteAll} type="button">
                        Delete All
                      </button>
                    </div>
                  )}
                </div>
                {range.expanded &&
                  displayedMeasurements.map(({ definition, formatted }) => (
                    <Fragment key={definition.id}>
                      <span
                        aria-label={definition.label}
                        className="rangeSidebarMetricLabel"
                        dangerouslySetInnerHTML={{ __html: definition.labelHtml }}
                        title={definition.label}
                      />
                      <span className="rangeSidebarMetricValue" title={formatted.fullValue}>
                        {range.measurementStatsBusy && !stats ? "..." : formatted.value}
                      </span>
                    </Fragment>
                  ))}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

function RangeCommentBubble({ note }: { note: string }) {
  if (!note) return null;
  return (
    <div className="rangeCommentBubble" title={note}>
      <div>{note}</div>
    </div>
  );
}

function MetricCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="metricCell">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function LegacyTimingMarkersPanel({
  onUpdateSession,
  session,
}: {
  onUpdateSession: (updater: (session: UiSession) => UiSession) => void;
  session: UiSession;
}) {
  const [addOpen, setAddOpen] = useState(false);
  const sampleRateHz = session.summary?.metadata.sample_rate_hz ?? session.settings.sample_rate_hz;

  function addMarker(type: "pair" | "single") {
    onUpdateSession((current) => ({
      ...current,
      timingMarkers: [
        ...current.timingMarkers.map((marker) => ({ ...marker, selected: false })),
        createTimingMarker(current, type),
      ],
    }));
    setAddOpen(false);
  }

  function updateMarker(id: string, patch: Partial<UiTimingMarker>) {
    onUpdateSession((current) => ({
      ...current,
      timingMarkers: current.timingMarkers.map((marker) =>
        marker.id === id ? { ...marker, ...patch } : marker,
      ),
    }));
  }

  function selectMarker(id: string) {
    onUpdateSession((current) => ({
      ...current,
      timingMarkers: current.timingMarkers.map((marker) => ({ ...marker, selected: marker.id === id })),
    }));
  }

  function deleteMarker(id: string) {
    onUpdateSession((current) => ({
      ...current,
      timingMarkers: current.timingMarkers.filter((marker) => marker.id !== id),
    }));
  }

  return (
    <div className="timingMarkersSidebarPanel">
      <div className="sidebarTitleRow">
        <div className="sidebarTitleText">Timing Markers</div>
        <div className="markerAddMenu">
          <button className={`sidebarCircleButton ${addOpen ? "active" : ""}`} onClick={() => setAddOpen((open) => !open)} type="button">
            <Plus size={13} />
          </button>
          {addOpen && (
            <div className="markerAddPopover">
              <button onClick={() => addMarker("pair")} type="button">
                <span>Add Marker Pair</span>
                <small>Cmd/Ctrl+T</small>
              </button>
              <button onClick={() => addMarker("single")} type="button">
                <span>Add Single Marker</span>
                <small>Shift+Cmd/Ctrl+T</small>
              </button>
            </div>
          )}
        </div>
      </div>

      {session.timingMarkers.length === 0 ? (
        <div className="emptyMeasurementState">
          <Clock3 size={24} />
          <span>Click "+" to add Timing Markers</span>
        </div>
      ) : (
        <div className="timingMarkerList">
          {session.timingMarkers.map((marker) => {
            const duration =
              marker.type === "pair" && marker.endSample !== undefined
                ? formatSeconds(Math.abs(marker.endSample - marker.sample) / Math.max(1, sampleRateHz))
                : formatSeconds(marker.sample / Math.max(1, sampleRateHz));
            return (
              <section
                className={`timingMarkerItem ${marker.selected ? "selected" : ""}`}
                key={marker.id}
                onClick={() => selectMarker(marker.id)}
              >
                <div className="rangeMeasurementHeader">
                  <span className={`markerTypeBadge ${marker.type}`}>{marker.type === "pair" ? "A" : "T"}</span>
                  <input
                    aria-label="Marker name"
                    onChange={(event) => updateMarker(marker.id, { label: event.target.value })}
                    value={marker.label}
                  />
                  <div className="rangeMeasurementActions">
                    <button
                      onClick={() => {
                        onUpdateSession((current) => ({
                          ...current,
                          timingMarkers: current.timingMarkers.map((item) => ({ ...item, selected: item.id === marker.id })),
                          viewportStart: Math.max(0, marker.sample - Math.round(current.viewportSamples / 2)),
                        }));
                      }}
                      title="Go to Marker"
                      type="button"
                    >
                      <Search size={12} />
                    </button>
                    <button
                      onClick={() => {
                        const span = marker.type === "pair" && marker.endSample ? Math.abs(marker.endSample - marker.sample) : session.viewportSamples;
                        onUpdateSession((current) => ({
                          ...current,
                          timingMarkers: current.timingMarkers.map((item) => ({ ...item, selected: item.id === marker.id })),
                          viewportStart: Math.max(0, marker.sample - Math.round(span * 0.1)),
                          viewportSamples: Math.round(Math.max(128, span * 1.2)),
                        }));
                      }}
                      title="Zoom"
                      type="button"
                    >
                      <Maximize2 size={12} />
                    </button>
                    <button onClick={() => deleteMarker(marker.id)} title="Delete" type="button">
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>
                <div className="markerSummary">
                  <MetricCell label={marker.type === "pair" ? "Delta" : "Time"} value={duration} />
                  <MetricCell label="Sample" value={formatSamples(marker.sample)} />
                </div>
                <textarea
                  className="rangeNote"
                  onChange={(event) => updateMarker(marker.id, { note: event.target.value })}
                  placeholder="Add note"
                  value={marker.note}
                />
              </section>
            );
          })}
          <button
            className="panel-action"
            onClick={() => onUpdateSession((current) => ({ ...current, timingMarkers: [] }))}
            type="button"
          >
            <Trash2 size={15} />
            Delete All
          </button>
        </div>
      )}
    </div>
  );
}
