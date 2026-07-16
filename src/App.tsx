import { listen } from "@tauri-apps/api/event";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  Activity,
  BarChart3,
  ChevronDown,
  ChevronUp,
  Copy,
  Clock3,
  Download,
  FileDown,
  FolderOpen,
  GripVertical,
  Maximize2,
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
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
  RefObject,
  UIEvent as ReactUIEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import analyzersIcon from "./assets/saleae/sidebar/analyzers.svg";
import cursorsIcon from "./assets/saleae/sidebar/cursors.svg";
import devicesIcon from "./assets/saleae/sidebar/devices.svg";
import extensionsIcon from "./assets/saleae/sidebar/extensions.svg";
import measurementsIcon from "./assets/saleae/sidebar/measurements.svg";
import notesIcon from "./assets/saleae/sidebar/notes.svg";
import recordingSettingsIcon from "./assets/saleae/sidebar/recordingSettings.svg";
import timingMarkersIcon from "./assets/saleae/sidebar/timingMarkers.svg";
import { CaptureNotesPanel } from "./components/CaptureNotesPanel";
import { DeviceStartScreen } from "./components/DeviceStartScreen";
import { ExtensionsPanel } from "./components/ExtensionsPanel";
import { LogicToolbar } from "./components/LogicToolbar";
import { WaveformCanvas } from "./components/WaveformCanvas";
import {
  cancelCapture,
  CaptureProgress,
  CaptureSettings,
  CaptureSummary,
  decodeUartFrames,
  DecodedFrame,
  DeviceInfo,
  DiagnosticEvent,
  exportCapture,
  getWaveformTile,
  listDevices,
  openCapture,
  saveCapture,
  startCapture,
  WaveformTile,
} from "./lib/api";
import { formatBytes, formatRate, formatSamples } from "./lib/format";
import {
  fitSaleaeDigitalRowsToViewport,
  makeSaleaeDigitalRowHeights,
  saleaeChannelContentHeight,
  saleaeChannelResizeHandleTop,
  SALEAE_DIGITAL_ROW_V2_MIN_HEIGHT_PX,
  SALEAE_ROW_V2_SPACING_PX,
} from "./lib/saleaeChannelLayout";
import { saleaeLegacyChannelColor } from "./lib/saleaeChannelColors";
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

type FooterPopover = "devices" | "newSession" | "zoom" | null;

interface UiSession {
  id: string;
  name: string;
  selectedDevice: string;
  settings: CaptureSettings;
  deviceSettings: UiDeviceSettings;
  channelLabels: string[];
  channelHeights: number[];
  manualChannelLayout: boolean;
  graphScrollTop: number;
  summary: CaptureSummary | null;
  progress: CaptureProgress | null;
  tile: WaveformTile | null;
  cursorState: UiCursorState;
  canvasWidth: number;
  viewportStart: number;
  viewportSamples: number;
  decodeChannel: number;
  decodeBaud: number;
  decodeInverted: boolean;
  decodedFrames: DecodedFrame[];
  diagnostics: DiagnosticEvent[];
  busy: boolean;
  decodeBusy: boolean;
  message: string;
  analyzers: string[];
  analyzerDataPane: "table" | "terminal";
  rangeMeasurements: UiRangeMeasurement[];
  timingMarkers: UiTimingMarker[];
  notes: string;
}

type UiRecordingMode = "FreeRun" | "Timer" | "Trigger";
type UiTriggerEdge = "Rising Edge" | "Falling Edge" | "High Pulse" | "Low Pulse";

interface UiDeviceSettings {
  bufferSizeMb: number;
  captureMode: UiRecordingMode;
  digitalChannels: boolean[];
  glitchFilterEnabled: boolean;
  glitchFilterNs: number;
  singleShotEnabled: boolean;
  singleShotHighResolution: boolean;
  singleShotPostTriggerMs: number;
  singleShotPreTriggerMs: number;
  triggerHoldoffMs: number;
  triggerChannel: number;
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
  color: string;
  endSample: number;
  id: string;
  name: string;
  note: string;
  selected: boolean;
  startSample: number;
}

interface UiTimingMarker {
  endSample?: number;
  id: string;
  name: string;
  note: string;
  sample: number;
  selected: boolean;
  type: "pair" | "single";
}

const DEFAULT_DEVICE_ID = "fake:pxlogic-demo";
const SAMPLE_RATES = [1_000_000, 5_000_000, 10_000_000, 25_000_000, 50_000_000, 100_000_000];
const CHANNEL_COUNTS = [1, 4, 8, 16, 24, 32];
const BUILT_IN_ANALYZERS = ["Async Serial", "I2C", "SPI", "CAN", "I2S", "Manchester"];
const RANGE_COLORS = ["#43baeb", "#ffcb46", "#00b140", "#f52a66"];

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
    channel_count: 16,
    duration_ms: 10,
    decode_cross: true,
    threshold_volts: 2.0,
    mode: "Buffer",
  };
}

function makeDigitalChannels(channelCount: number) {
  return Array.from({ length: 32 }, (_, index) => index < channelCount);
}

function channelLabelsForCount(channelCount: number, existing: string[] = []) {
  return Array.from({ length: Math.max(1, channelCount) }, (_, index) => existing[index] ?? `D${index}`);
}

function captureChannelLimit(session: UiSession) {
  return Math.max(1, session.summary?.metadata.channel_count ?? session.settings.channel_count);
}

function isDigitalChannelEnabled(session: UiSession, channelIndex: number) {
  return session.deviceSettings.digitalChannels[channelIndex] ?? channelIndex < session.settings.channel_count;
}

function visibleDigitalChannelIndexes(session: UiSession) {
  const limit = captureChannelLimit(session);
  return Array.from({ length: limit }, (_, index) => index).filter((index) =>
    isDigitalChannelEnabled(session, index),
  );
}

function highestEnabledDigitalChannel(channels: boolean[], fallback = 0) {
  return channels.reduce((highest, enabled, index) => (enabled ? index : highest), fallback);
}

function tileForVisibleChannels(tile: WaveformTile | null, channelIndexes: number[], labels: string[]) {
  if (!tile) return null;
  const visible = new Set(channelIndexes);
  return {
    ...tile,
    channels: tile.channels
      .filter((channel) => visible.has(channel.channel))
      .map((channel) => ({
        ...channel,
        label: labels[channel.channel] ?? channel.label,
      })),
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

function defaultDeviceSettings(channelCount: number): UiDeviceSettings {
  return {
    bufferSizeMb: 1024,
    captureMode: "Timer",
    digitalChannels: makeDigitalChannels(channelCount),
    glitchFilterEnabled: false,
    glitchFilterNs: 10,
    singleShotEnabled: false,
    singleShotHighResolution: false,
    singleShotPostTriggerMs: 5,
    singleShotPreTriggerMs: 5,
    triggerHoldoffMs: 0,
    triggerChannel: 0,
    triggerEdge: "Rising Edge",
    triggerSamplingEnabled: false,
    triggerSamplingPriority: "Sample Rate",
    triggerSamplingRateHz: 25_000_000,
    triggerPulseWidthUs: 10,
    trimAfterCapture: true,
  };
}

function defaultCursorState(sampleCount = 100_000, channelCount = 16): UiCursorState {
  return {
    visible: false,
    x1Sample: Math.max(0, Math.round(sampleCount * 0.25)),
    x2Sample: Math.max(1, Math.round(sampleCount * 0.75)),
    y1Channel: 0,
    y2Channel: Math.min(1, Math.max(0, channelCount - 1)),
  };
}

function createRangeMeasurement(session: UiSession): UiRangeMeasurement {
  const totalSamples = session.summary?.metadata.sample_count ?? Math.max(1, session.viewportSamples);
  const width = Math.max(16, Math.round(session.viewportSamples * 0.28));
  const start = Math.max(0, Math.min(totalSamples - width, Math.round(session.viewportStart + session.viewportSamples * 0.36)));
  const end = Math.max(start + 1, Math.min(totalSamples, start + width));
  const index = session.rangeMeasurements.length;
  return {
    color: RANGE_COLORS[index % RANGE_COLORS.length],
    endSample: end,
    id: `range-${Date.now()}-${index}`,
    name: `Range ${index + 1}`,
    note: "",
    selected: true,
    startSample: start,
  };
}

function createTimingMarker(session: UiSession, type: "pair" | "single"): UiTimingMarker {
  const totalSamples = session.summary?.metadata.sample_count ?? Math.max(1, session.viewportSamples);
  const center = Math.max(0, Math.min(totalSamples - 1, Math.round(session.viewportStart + session.viewportSamples * 0.5)));
  const width = Math.max(16, Math.round(session.viewportSamples * 0.22));
  const index = session.timingMarkers.filter((marker) => marker.type === type).length + 1;
  return {
    endSample: type === "pair" ? Math.min(totalSamples, center + width) : undefined,
    id: `marker-${Date.now()}-${type}-${index}`,
    name: type === "pair" ? `Pair ${index}` : `Marker ${index}`,
    note: "",
    sample: type === "pair" ? Math.max(0, center - width) : center,
    selected: true,
    type,
  };
}

function makeSession(id: string, name: string, deviceId: string, source?: UiSession): UiSession {
  const settings = source ? { ...source.settings, device_id: deviceId } : defaultSettings(deviceId);
  return {
    id,
    name,
    selectedDevice: deviceId,
    settings,
    deviceSettings: source
      ? { ...source.deviceSettings, digitalChannels: [...source.deviceSettings.digitalChannels] }
      : defaultDeviceSettings(settings.channel_count),
    channelLabels: source
      ? channelLabelsForCount(settings.channel_count, source.channelLabels)
      : channelLabelsForCount(settings.channel_count),
    channelHeights: source
      ? makeSaleaeDigitalRowHeights(32, source.channelHeights ?? [])
      : makeSaleaeDigitalRowHeights(),
    manualChannelLayout: source?.manualChannelLayout ?? false,
    graphScrollTop: 0,
    summary: null,
    progress: null,
    tile: null,
    cursorState: source
      ? { ...source.cursorState }
      : defaultCursorState(100_000, settings.channel_count),
    canvasWidth: 1000,
    viewportStart: 0,
    viewportSamples: 50_000,
    decodeChannel: 0,
    decodeBaud: 115_200,
    decodeInverted: false,
    decodedFrames: [],
    diagnostics: [],
    busy: false,
    decodeBusy: false,
    message: "Ready",
    analyzers: [],
    analyzerDataPane: "table",
    rangeMeasurements: [],
    timingMarkers: [],
    notes: "",
  };
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
  const [draftSelectedDevice, setDraftSelectedDevice] = useState(DEFAULT_DEVICE_ID);
  const [sessions, setSessions] = useState<UiSession[]>([]);
  const [extensions, setExtensions] = useState<UiExtensionRecord[]>(loadUiExtensions);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [selectedPanel, setSelectedPanel] = useState<SidebarPanel | undefined>(undefined);
  const [footerPopover, setFooterPopover] = useState<FooterPopover>(null);
  const [editingChannel, setEditingChannel] = useState<number | null>(null);
  const [channelContextMenu, setChannelContextMenu] = useState<{ channelIndex: number; x: number; y: number } | null>(null);
  const [graphViewportHeight, setGraphViewportHeight] = useState(0);
  const [startupMessage, setStartupMessage] = useState("Ready");

  const footerRef = useRef<HTMLElement>(null);
  const graphScrollerRef = useRef<HTMLDivElement>(null);
  const channelContextMenuRef = useRef<HTMLDivElement>(null);
  const graphScrollFrameRef = useRef<number | null>(null);
  const pendingGraphScrollRef = useRef<{ sessionId: string; scrollTop: number } | null>(null);
  const sessionsRef = useRef<UiSession[]>([]);
  const activeSessionIdRef = useRef<string | null>(null);
  const captureSessionRef = useRef<string | null>(null);
  const sidebarShortcutRef = useRef<{ timeout: number | null; waiting: boolean }>({ timeout: null, waiting: false });
  const tileRequestSeq = useRef(0);
  const sessionCounter = useRef(1);

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  useEffect(() => {
    saveUiExtensions(extensions);
  }, [extensions]);

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

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

  useEffect(() => {
    return () => {
      if (graphScrollFrameRef.current !== null) {
        window.cancelAnimationFrame(graphScrollFrameRef.current);
      }
    };
  }, []);

  const selectedDevice = activeSession?.selectedDevice ?? draftSelectedDevice;
  const selected = useMemo(
    () => devices.find((device) => device.id === selectedDevice) ?? null,
    [devices, selectedDevice],
  );

  const updateSession = useCallback((sessionId: string, updater: (session: UiSession) => UiSession) => {
    setSessions((current) => current.map((session) => (session.id === sessionId ? updater(session) : session)));
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
    } catch (error) {
      setStartupMessage(String(error));
    }
  }, []);

  useEffect(() => {
    refreshDevices();
  }, [refreshDevices]);

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
        updateSession(targetId, (session) => ({ ...session, progress: event.payload }));
      }).catch(() => () => {}),
      listen<CaptureSummary>("capture_completed", (event) => {
        const targetId = captureSessionRef.current;
        if (!targetId) return;
        updateSession(targetId, (session) => ({
          ...session,
          channelLabels: channelLabelsForCount(event.payload.metadata.channel_count, session.channelLabels),
          summary: summaryWithLabels(event.payload, session.channelLabels),
          viewportStart: 0,
          viewportSamples: Math.min(event.payload.metadata.sample_count, 100_000),
          cursorState: {
            ...defaultCursorState(event.payload.metadata.sample_count, event.payload.metadata.channel_count),
            visible: session.cursorState.visible,
          },
          decodedFrames: [],
          message: "Capture complete",
        }));
      }).catch(() => () => {}),
      listen<string>("capture_failed", (event) => {
        const targetId = captureSessionRef.current ?? activeSessionIdRef.current;
        if (!targetId) {
          setStartupMessage(event.payload);
          return;
        }
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
      void Promise.all(subscriptions).then((unlisten) => unlisten.forEach((dispose) => dispose()));
    };
  }, [updateSession]);

  const channelLabels = useMemo(
    () => {
      const count = activeSession?.summary?.metadata.channel_count ?? activeSession?.settings.channel_count ?? 16;
      const labels = activeSession?.summary?.metadata.labels.length
        ? activeSession.summary.metadata.labels
        : activeSession?.channelLabels;
      return channelLabelsForCount(count, labels);
    },
    [
      activeSession?.channelLabels,
      activeSession?.settings.channel_count,
      activeSession?.summary?.metadata.channel_count,
      activeSession?.summary?.metadata.labels,
    ],
  );
  const visibleChannelIndexes = useMemo(
    () => (activeSession ? visibleDigitalChannelIndexes(activeSession) : []),
    [activeSession],
  );
  const visibleChannelLabels = useMemo(
    () => visibleChannelIndexes.map((channelIndex) => channelLabels[channelIndex] ?? `D${channelIndex}`),
    [channelLabels, visibleChannelIndexes],
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
    [activeSession, graphViewportHeight, visibleChannelIndexes],
  );
  const visibleTile = useMemo(
    () => tileForVisibleChannels(activeSession?.tile ?? null, visibleChannelIndexes, channelLabels),
    [activeSession?.tile, channelLabels, visibleChannelIndexes],
  );
  const graphContentHeight = Math.max(graphViewportHeight, saleaeChannelContentHeight(visibleChannelHeights));

  const totalSamples = activeSession?.summary?.metadata.sample_count ?? 0;
  const progressPercent =
    activeSession?.progress && activeSession.progress.bytes_expected > 0
      ? Math.min(100, (activeSession.progress.bytes_read / activeSession.progress.bytes_expected) * 100)
      : 0;
  const visibleStart = activeSession?.summary ? formatSamples(activeSession.viewportStart) : "0 S";
  const visibleWindow = activeSession?.summary ? formatSamples(activeSession.viewportSamples) : "0 S";
  const activeSettings = activeSession?.settings ?? defaultSettings(selectedDevice);
  const activeMessage = activeSession?.message ?? startupMessage;

  const updateViewport = useCallback(
    (sessionId: string, start: number, samples: number) => {
      updateSession(sessionId, (session) => {
        const sessionTotalSamples = session.summary?.metadata.sample_count ?? 0;
        if (!sessionTotalSamples) {
          return { ...session, viewportStart: 0, viewportSamples: 0 };
        }
        const nextSamples = Math.max(1, Math.min(sessionTotalSamples, Math.round(samples)));
        const maxStart = Math.max(0, sessionTotalSamples - nextSamples);
        return {
          ...session,
          viewportStart: Math.max(0, Math.min(maxStart, Math.round(start))),
          viewportSamples: nextSamples,
        };
      });
    },
    [updateSession],
  );

  const zoomViewport = useCallback(
    (factor: number) => {
      if (!activeSession?.summary) return;
      const anchor = activeSession.viewportStart + activeSession.viewportSamples / 2;
      const nextSamples = activeSession.viewportSamples * factor;
      updateViewport(activeSession.id, anchor - nextSamples / 2, nextSamples);
    },
    [activeSession, updateViewport],
  );

  const fitViewport = useCallback(() => {
    if (!activeSession?.summary) return;
    updateViewport(activeSession.id, 0, activeSession.summary.metadata.sample_count);
  }, [activeSession, updateViewport]);

  useEffect(() => {
    if (!activeSession?.summary) {
      tileRequestSeq.current += 1;
      return;
    }

    const requestSeq = tileRequestSeq.current + 1;
    tileRequestSeq.current = requestSeq;
    const sessionSnapshot = activeSession;
    const timeout = window.setTimeout(async () => {
      try {
        const overscan = Math.max(64, sessionSnapshot.viewportSamples);
        const requestStart = Math.max(0, sessionSnapshot.viewportStart - overscan);
        const requestEnd = Math.min(
          sessionSnapshot.summary!.metadata.sample_count,
          sessionSnapshot.viewportStart + sessionSnapshot.viewportSamples + overscan,
        );
        const requestSamples = Math.max(1, requestEnd - requestStart);
        const pixelScale = requestSamples / Math.max(1, sessionSnapshot.viewportSamples);
        const maxPixels = sessionSnapshot.summary!.metadata.channel_count > 16 ? 1800 : 2600;
        const next = await getWaveformTile({
          start_sample: requestStart,
          sample_count: requestSamples,
          pixels: Math.max(480, Math.min(maxPixels, Math.round(sessionSnapshot.canvasWidth * pixelScale))),
          channels: [],
        });
        if (requestSeq === tileRequestSeq.current) {
          updateSession(sessionSnapshot.id, (session) => ({
            ...session,
            tile: {
              ...next,
              channels: next.channels.map((channel) => ({
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
      }
    }, 28);
    return () => window.clearTimeout(timeout);
  }, [
    activeSession?.canvasWidth,
    activeSession?.id,
    activeSession?.summary,
    activeSession?.viewportSamples,
    activeSession?.viewportStart,
    updateSession,
  ]);

  async function runCaptureForSession(session: UiSession, deviceId: string) {
    const captureDevice = devices.find((device) => device.id === deviceId) ?? selected;
    const nextSettings = { ...session.settings, device_id: deviceId };
    captureSessionRef.current = session.id;
    setDraftSelectedDevice(deviceId);
    updateSession(session.id, (current) => ({
      ...current,
      selectedDevice: deviceId,
      settings: nextSettings,
      busy: true,
      progress: null,
      decodedFrames: [],
      diagnostics: [],
      message: captureDevice?.kind === "Usb" ? "Preparing device and capturing" : "Capturing",
    }));
    try {
      const next = await startCapture(nextSettings);
      updateSession(session.id, (current) => ({
        ...current,
        channelLabels: channelLabelsForCount(next.metadata.channel_count, current.channelLabels),
        summary: summaryWithLabels(next, current.channelLabels),
        viewportStart: 0,
        viewportSamples: Math.min(next.metadata.sample_count, 100_000),
        cursorState: {
          ...defaultCursorState(next.metadata.sample_count, next.metadata.channel_count),
          visible: current.cursorState.visible,
        },
        decodedFrames: [],
        message: "Capture complete",
      }));
    } catch (error) {
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

  async function handleDecode(sessionId = activeSession?.id) {
    const session = sessionsRef.current.find((item) => item.id === sessionId);
    if (!session?.summary) return;
    updateSession(session.id, (current) => ({ ...current, decodeBusy: true }));
    try {
      const frames = await decodeUartFrames({
        channel: session.decodeChannel,
        baud_rate: session.decodeBaud,
        inverted: session.decodeInverted,
      });
      updateSession(session.id, (current) => ({
        ...current,
        decodedFrames: frames,
        message: `Decoded ${frames.length} UART frame${frames.length === 1 ? "" : "s"}`,
      }));
    } catch (error) {
      updateSession(session.id, (current) => ({ ...current, message: String(error) }));
    } finally {
      updateSession(session.id, (current) => ({ ...current, decodeBusy: false }));
    }
  }

  useEffect(() => {
    if (!activeSession?.summary) return;
    void handleDecode(activeSession.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSession?.summary?.metadata.captured_at]);

  async function handleCancel() {
    await cancelCapture();
    const targetId = captureSessionRef.current ?? activeSession?.id;
    if (targetId) {
      updateSession(targetId, (session) => ({ ...session, busy: false, message: "Cancel requested" }));
    }
    captureSessionRef.current = null;
  }

  async function loadCaptureIntoSession(summary: CaptureSummary) {
    const target =
      activeSession && !activeSession.summary
        ? activeSession
        : createSession(summary.metadata.source_device || selectedDevice, activeSession ?? undefined);
    const labels = channelLabelsForCount(summary.metadata.channel_count, summary.metadata.labels);
    updateSession(target.id, (session) => ({
      ...session,
      selectedDevice: summary.metadata.source_device || session.selectedDevice,
      settings: {
        ...session.settings,
        device_id: summary.metadata.source_device || session.selectedDevice,
        sample_rate_hz: summary.metadata.sample_rate_hz,
        channel_count: summary.metadata.channel_count,
      },
      deviceSettings: {
        ...session.deviceSettings,
        digitalChannels: makeDigitalChannels(summary.metadata.channel_count),
        triggerChannel: Math.min(session.deviceSettings.triggerChannel, Math.max(0, summary.metadata.channel_count - 1)),
      },
      channelLabels: labels,
      cursorState: defaultCursorState(summary.metadata.sample_count, summary.metadata.channel_count),
      summary: summaryWithLabels(summary, labels),
      tile: null,
      viewportStart: 0,
      viewportSamples: Math.min(summary.metadata.sample_count, 100_000),
      decodedFrames: [],
      message: "Capture opened",
    }));
    setActiveSessionId(target.id);
  }

  async function handleOpen() {
    try {
      const path = await openDialog({
        multiple: false,
        filters: [{ name: "PXLogic Capture", extensions: ["pxcap"] }],
      });
      if (typeof path !== "string") return;
      const next = await openCapture(path);
      await loadCaptureIntoSession(next);
    } catch (error) {
      try {
        const next = await openCapture("preview");
        await loadCaptureIntoSession(next);
        updateSession(activeSessionIdRef.current ?? "", (session) => ({ ...session, message: "Preview capture loaded" }));
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
    if (!activeSession?.summary) return;
    try {
      const path = await saveDialog({
        defaultPath: `${activeSession.name || "capture"}.pxcap`,
        filters: [{ name: "PXLogic Capture", extensions: ["pxcap"] }],
      });
      if (!path) return;
      await saveCapture(path);
      updateSession(activeSession.id, (session) => ({ ...session, message: "Capture saved" }));
    } catch (error) {
      updateSession(activeSession.id, (session) => ({ ...session, message: String(error) }));
    }
  }

  async function handleExport(format: "Sr" | "Vcd") {
    if (!activeSession?.summary) return;
    const ext = format === "Sr" ? "sr" : "vcd";
    try {
      const path = await saveDialog({
        defaultPath: `${activeSession.name || "capture"}.${ext}`,
        filters: [{ name: format === "Sr" ? "Sigrok Session" : "Value Change Dump", extensions: [ext] }],
      });
      if (!path) return;
      await exportCapture(path, format);
      updateSession(activeSession.id, (session) => ({ ...session, message: `${ext.toUpperCase()} exported` }));
    } catch (error) {
      updateSession(activeSession.id, (session) => ({ ...session, message: String(error) }));
    }
  }

  function setSelectedDeviceForActive(deviceId: string) {
    setDraftSelectedDevice(deviceId);
    if (!activeSession) return;
    updateSession(activeSession.id, (session) => ({
      ...session,
      selectedDevice: deviceId,
      settings: { ...session.settings, device_id: deviceId },
    }));
  }

  function updateActiveSettings(patch: Partial<CaptureSettings>) {
    if (!activeSession) return;
    updateSession(activeSession.id, (session) => ({
      ...session,
      channelLabels:
        patch.channel_count == null
          ? session.channelLabels
          : channelLabelsForCount(patch.channel_count, session.channelLabels),
      settings: { ...session.settings, ...patch },
    }));
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
      while (digitalChannels.length <= channelIndex) digitalChannels.push(false);
      digitalChannels[channelIndex] = enabled;
      const highestEnabled = highestEnabledDigitalChannel(digitalChannels);
      const channelCount = Math.max(1, highestEnabled + 1);
      return {
        ...session,
        channelLabels: channelLabelsForCount(channelCount, session.channelLabels),
        settings: { ...session.settings, channel_count: channelCount },
        deviceSettings: {
          ...session.deviceSettings,
          digitalChannels,
          triggerChannel: Math.min(session.deviceSettings.triggerChannel, highestEnabled),
        },
        message: `D${channelIndex} ${digitalChannels[channelIndex] ? "shown and enabled" : "hidden and disabled"}`,
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
    openSidebarPanel("analyzers");
    if (!activeSession) return;
    updateSession(activeSession.id, (session) => ({
      ...session,
      analyzers: session.analyzers.includes("Async Serial") ? session.analyzers : [...session.analyzers, "Async Serial"],
      decodeChannel: channelIndex,
      message: `Async Serial assigned to D${channelIndex}`,
    }));
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
      handleAddAnalyzer(payload?.analyzerName ?? "Async Serial");
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

  function handleAddAnalyzer(name: string) {
    openSidebarPanel("analyzers");
    if (!activeSession) return;
    updateSession(activeSession.id, (session) => ({
      ...session,
      analyzers: session.analyzers.includes(name) ? session.analyzers : [...session.analyzers, name],
      message: `${name} analyzer selected`,
    }));
  }

  function handleAddRangeMeasurement() {
    openSidebarPanel("measurements");
    if (!activeSession) return;
    updateSession(activeSession.id, (session) => ({
      ...session,
      rangeMeasurements: [
        ...session.rangeMeasurements.map((range) => ({ ...range, selected: false })),
        createRangeMeasurement(session),
      ],
      message: "Range measurement added",
    }));
  }

  function handleAddMarkerPair() {
    openSidebarPanel("timingMarkers");
    if (!activeSession) return;
    updateSession(activeSession.id, (session) => ({
      ...session,
      timingMarkers: [
        ...session.timingMarkers.map((marker) => ({ ...marker, selected: false })),
        createTimingMarker(session, "pair"),
      ],
      message: "Marker pair added",
    }));
  }

  function handleAddSingleMarker() {
    openSidebarPanel("timingMarkers");
    if (!activeSession) return;
    updateSession(activeSession.id, (session) => ({
      ...session,
      timingMarkers: [
        ...session.timingMarkers.map((marker) => ({ ...marker, selected: false })),
        createTimingMarker(session, "single"),
      ],
      message: "Single marker added",
    }));
  }

  function closeSession(sessionId: string) {
    const target = sessions.find((session) => session.id === sessionId);
    if (!target || target.busy) return;
    const nextSessions = sessions.filter((session) => session.id !== sessionId);
    const targetIndex = sessions.findIndex((session) => session.id === sessionId);
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
    createSession(deviceId, activeSession ?? undefined);
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
    function clearSidebarSequence() {
      shortcutState.waiting = false;
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

      if (hasCommandModifier && !event.altKey && key === "g") {
        event.preventDefault();
        clearSidebarSequence();
        invokeCommand(MeasurementCommands.AddRange);
        return;
      }

      if (hasCommandModifier && !event.altKey && key === "t") {
        event.preventDefault();
        clearSidebarSequence();
        invokeCommand(event.shiftKey ? MarkerCommands.AddMarker : MarkerCommands.AddPair);
        return;
      }

      if (event.metaKey || event.ctrlKey || event.altKey) return;

      if (shortcutState.waiting) {
        const command = SIDEBAR_SHORTCUT_TO_COMMAND[key];
        clearSidebarSequence();
        if (command) {
          event.preventDefault();
          invokeCommand(command);
        }
        return;
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
        shortcutState.waiting = true;
        shortcutState.timeout = window.setTimeout(clearSidebarSequence, 900);
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      clearSidebarSequence();
      document.removeEventListener("keydown", handleKeyDown);
    };
  });

  const zoomLabel =
    activeSession?.summary && activeSession.canvasWidth > 0
      ? `${formatSamples(Math.max(1, Math.round(activeSession.viewportSamples / activeSession.canvasWidth)))}/px`
      : "Zoom";

  return (
    <main className="logic-root">
      <section className="appContent">
        <header className="logic-windowbar">
          <div className="product-mark">
            <Activity size={15} />
            <span>PXLogic</span>
          </div>
          <div className="window-status">
            <span>{activeMessage}</span>
          </div>
          <div className="window-actions">
            <button className="tool-button text-tool" title="Open capture" onClick={handleOpen}>
              <FolderOpen size={14} />
              Open
            </button>
            <button className="tool-button" title="Save capture" onClick={handleSave} disabled={!activeSession?.summary}>
              <Save size={14} />
            </button>
            <button
              className="tool-button text-tool"
              title="Export SR"
              onClick={() => handleExport("Sr")}
              disabled={!activeSession?.summary}
            >
              <FileDown size={14} />
              SR
            </button>
            <button
              className="tool-button text-tool"
              title="Export VCD"
              onClick={() => handleExport("Vcd")}
              disabled={!activeSession?.summary}
            >
              <Download size={14} />
              VCD
            </button>
          </div>
        </header>

        <section className={`mainArea ${activeSession ? "" : "emptySession"}`}>
          <section className="graphRowsMain">
            <div className="topArea">
              <div className="channelLabelHeader">
                <span className="channelCounter">
                  {activeSession ? `${visibleChannelIndexes.length} Channels` : "Select Device"}
                </span>
              </div>
              <div className="aboveGraph">
                <div className="timingDisplay">
                  <span>{visibleStart}</span>
                  <span>{visibleWindow}</span>
                  <span>
                    {activeSession?.summary
                      ? formatRate(activeSession.summary.metadata.sample_rate_hz)
                      : formatRate(activeSettings.sample_rate_hz)}
                  </span>
                </div>
                <LogicToolbar
                  busy={Boolean(activeSession?.busy)}
                  hasCapture={Boolean(activeSession?.summary)}
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
                    <div
                      className="channelLabels"
                      style={{
                        gridTemplateRows:
                          visibleChannelHeights.length > 0
                            ? visibleChannelHeights.map((height) => `${height}px`).join(" ")
                            : undefined,
                      }}
                    >
                      {visibleChannelIndexes.map((channelIndex, rowIndex) => (
                        <ChannelLabelRow
                          index={channelIndex}
                          isEditing={editingChannel === channelIndex}
                          isEnabled
                          isTrigger={activeSession.deviceSettings.triggerChannel === channelIndex}
                          key={channelIndex}
                          label={visibleChannelLabels[rowIndex]}
                          onContextMenu={(event) => {
                            event.preventDefault();
                            setEditingChannel(null);
                            setChannelContextMenu({ channelIndex, x: event.clientX, y: event.clientY });
                          }}
                          onEditEnd={() => setEditingChannel(null)}
                          onEditStart={() => {
                            setChannelContextMenu(null);
                            setEditingChannel(channelIndex);
                          }}
                          onRename={(name) => renameChannelLabel(channelIndex, name)}
                        />
                      ))}
                    </div>
                    {channelContextMenu && (
                      <ChannelContextMenu
                        channelIndex={channelContextMenu.channelIndex}
                        isEnabled={
                          activeSession.deviceSettings.digitalChannels[channelContextMenu.channelIndex] ??
                          channelContextMenu.channelIndex < activeSession.settings.channel_count
                        }
                        isTrigger={activeSession.deviceSettings.triggerChannel === channelContextMenu.channelIndex}
                        onAddAnalyzer={() => addAnalyzerForChannel(channelContextMenu.channelIndex)}
                        onClose={() => setChannelContextMenu(null)}
                        onRename={() => {
                          setEditingChannel(channelContextMenu.channelIndex);
                          setChannelContextMenu(null);
                        }}
                        onSetTrigger={() => setTriggerChannel(channelContextMenu.channelIndex)}
                        onToggleChannel={() =>
                          setChannelEnabled(
                            channelContextMenu.channelIndex,
                            !(
                              activeSession.deviceSettings.digitalChannels[channelContextMenu.channelIndex] ??
                              channelContextMenu.channelIndex < activeSession.settings.channel_count
                            ),
                          )
                        }
                        refElement={channelContextMenuRef}
                        x={channelContextMenu.x}
                        y={channelContextMenu.y}
                      />
                    )}
                    <div className="graphViewport">
                      <WaveformCanvas
                        rowHeights={visibleChannelHeights}
                        tile={visibleTile}
                        onWidthChange={(width) =>
                          updateSession(activeSession.id, (session) => ({ ...session, canvasWidth: width }))
                        }
                        sampleRateHz={activeSession.summary?.metadata.sample_rate_hz ?? activeSession.settings.sample_rate_hz}
                        totalSamples={totalSamples}
                        viewportStart={activeSession.viewportStart}
                        viewportSamples={activeSession.viewportSamples}
                        onViewportChange={(start, samples) => updateViewport(activeSession.id, start, samples)}
                      />
                      <CursorOverlay
                        onUpdateSession={(updater) => updateSession(activeSession.id, updater)}
                        session={activeSession}
                      />
                      <RangeMeasurementsOverlay
                        onUpdateSession={(updater) => updateSession(activeSession.id, updater)}
                        session={activeSession}
                      />
                      <TimingMarkersOverlay
                        onUpdateSession={(updater) => updateSession(activeSession.id, updater)}
                        session={activeSession}
                      />
                    </div>
                    {visibleChannelIndexes.slice(0, -1).map((channelIndex, rowIndex) => (
                      <ChannelResizeHandle
                        channelIndex={channelIndex}
                        height={visibleChannelHeights[rowIndex]}
                        key={channelIndex}
                        onResize={(height) => setChannelHeight(channelIndex, height)}
                        top={saleaeChannelResizeHandleTop(visibleChannelHeights, rowIndex)}
                      />
                    ))}
                  </div>
                </div>

                {activeSession.summary && (
                  <div className="horizontalScrollBar">
                    <input
                      type="range"
                      min={0}
                      max={Math.max(0, totalSamples - activeSession.viewportSamples)}
                      value={activeSession.viewportStart}
                      onChange={(event) => updateViewport(activeSession.id, Number(event.target.value), activeSession.viewportSamples)}
                    />
                    <input
                      type="range"
                      min={totalSamples ? 1 : 1}
                      max={totalSamples || 1_000_000}
                      value={activeSession.viewportSamples}
                      onChange={(event) => updateViewport(activeSession.id, activeSession.viewportStart, Number(event.target.value))}
                    />
                  </div>
                )}
              </>
            ) : (
              <DeviceStartScreen
                busy={false}
                devices={devices}
                onOpenCapture={handleOpen}
                onRefreshDevices={refreshDevices}
                onSelectDevice={setSelectedDeviceForActive}
                onStartWithDevice={handleStartWithDevice}
                selectedDevice={selectedDevice}
              />
            )}
          </section>

          <RightSidebar
            devices={devices}
            extensions={extensions}
            onChangeExtensions={(updater) => setExtensions((current) => updater(current))}
            onCreateSession={createSessionFromFooter}
            onDecode={() => activeSession && handleDecode(activeSession.id)}
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
            onUpdateSession={(updater) => {
              if (activeSession) updateSession(activeSession.id, updater);
            }}
            onUpdateSettings={updateActiveSettings}
            onViewportChange={(start, samples) => {
              if (activeSession) updateViewport(activeSession.id, start, samples);
            }}
            selectedDevice={selectedDevice}
            selectedPanel={selectedPanel}
            session={activeSession}
          />
        </section>

        <BottomBar
          activeSessionId={activeSessionId}
          devices={devices}
          footerPopover={footerPopover}
          onCloseSession={closeSession}
          onCreateSession={createSessionFromFooter}
          onRefreshDevices={refreshDevices}
          onRenameSession={(sessionId, name) =>
            updateSession(sessionId, (session) => ({ ...session, name: name.trim() ? name : session.name }))
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
  index,
  isEditing,
  isEnabled,
  isTrigger,
  label,
  onContextMenu,
  onEditEnd,
  onEditStart,
  onRename,
}: {
  index: number;
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
      className={`channelRow ${isEnabled ? "" : "disabled"} ${isTrigger ? "triggerChannel" : ""}`}
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
      </span>
    </div>
  );
}

function ChannelResizeHandle({
  channelIndex,
  height,
  onResize,
  top,
}: {
  channelIndex: number;
  height: number;
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
      aria-label={`Resize D${channelIndex} height`}
      aria-orientation="horizontal"
      aria-valuemin={SALEAE_DIGITAL_ROW_V2_MIN_HEIGHT_PX}
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
        onResize(Math.max(SALEAE_DIGITAL_ROW_V2_MIN_HEIGHT_PX, drag.startHeight + event.clientY - drag.startY));
      }}
      onPointerUp={finishDrag}
      role="separator"
      style={{ top, height: SALEAE_ROW_V2_SPACING_PX }}
      tabIndex={0}
      title={`Drag to resize D${channelIndex}`}
    />
  );
}

function ChannelContextMenu({
  channelIndex,
  isEnabled,
  isTrigger,
  onAddAnalyzer,
  onClose,
  onRename,
  onSetTrigger,
  onToggleChannel,
  refElement,
  x,
  y,
}: {
  channelIndex: number;
  isEnabled: boolean;
  isTrigger: boolean;
  onAddAnalyzer: () => void;
  onClose: () => void;
  onRename: () => void;
  onSetTrigger: () => void;
  onToggleChannel: () => void;
  refElement: RefObject<HTMLDivElement>;
  x: number;
  y: number;
}) {
  const menuLeft = typeof window === "undefined" ? x : Math.max(8, Math.min(x, window.innerWidth - 230));
  const menuTop = typeof window === "undefined" ? y : Math.max(8, Math.min(y, window.innerHeight - 190));

  function run(action: () => void) {
    action();
    onClose();
  }

  return (
    <div
      className="channelContextMenu"
      onContextMenu={(event) => event.preventDefault()}
      ref={refElement}
      role="menu"
      style={{ left: menuLeft, top: menuTop }}
    >
      <div className="channelContextHeader">D{channelIndex}</div>
      <button onClick={() => run(onRename)} role="menuitem" type="button">
        Rename
      </button>
      <button onClick={() => run(onToggleChannel)} role="menuitem" type="button">
        {isEnabled ? "Disable Channel" : "Enable Channel"}
      </button>
      <button className={isTrigger ? "active" : ""} onClick={() => run(onSetTrigger)} role="menuitem" type="button">
        Set as Trigger
      </button>
      <button onClick={() => run(onAddAnalyzer)} role="menuitem" type="button">
        Add Analyzer
      </button>
    </div>
  );
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
  onUpdateSession,
  session,
}: {
  onUpdateSession: (updater: (session: UiSession) => UiSession) => void;
  session: UiSession;
}) {
  const dragRef = useRef<{ edge: "start" | "end"; id: string } | null>(null);
  const totalSamples = session.summary?.metadata.sample_count ?? 0;
  if (!session.summary || totalSamples <= 0 || session.rangeMeasurements.length === 0) return null;

  function sampleToPercent(sample: number) {
    const ratio = (sample - session.viewportStart) / Math.max(1, session.viewportSamples);
    return Math.max(0, Math.min(1, ratio)) * 100;
  }

  function clientXToSample(clientX: number, host: HTMLElement) {
    const rect = host.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
    return Math.max(0, Math.min(totalSamples, Math.round(session.viewportStart + ratio * session.viewportSamples)));
  }

  function selectRange(id: string) {
    onUpdateSession((current) => ({
      ...current,
      rangeMeasurements: current.rangeMeasurements.map((range) => ({ ...range, selected: range.id === id })),
    }));
  }

  function updateDraggedRange(clientX: number, host: HTMLElement) {
    const drag = dragRef.current;
    if (!drag) return;
    const sample = clientXToSample(clientX, host);
    onUpdateSession((current) => ({
      ...current,
      rangeMeasurements: current.rangeMeasurements.map((range) => {
        if (range.id !== drag.id) return range;
        if (drag.edge === "start") {
          return { ...range, startSample: Math.max(0, Math.min(sample, range.endSample - 1)), selected: true };
        }
        return { ...range, endSample: Math.min(totalSamples, Math.max(sample, range.startSample + 1)), selected: true };
      }),
    }));
  }

  function handlePointerDown(
    id: string,
    edge: "start" | "end",
    event: ReactPointerEvent<HTMLButtonElement>,
  ) {
    const host = event.currentTarget.parentElement?.parentElement;
    if (!host) return;
    dragRef.current = { edge, id };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.stopPropagation();
    selectRange(id);
    updateDraggedRange(event.clientX, host);
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLButtonElement>) {
    const host = event.currentTarget.parentElement?.parentElement;
    if (!host || !dragRef.current) return;
    event.stopPropagation();
    updateDraggedRange(event.clientX, host);
  }

  function handlePointerUp(event: ReactPointerEvent<HTMLButtonElement>) {
    dragRef.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
    event.stopPropagation();
  }

  return (
    <div className="rangeOverlay" aria-hidden="false">
      {session.rangeMeasurements.map((range) => {
        const left = sampleToPercent(range.startSample);
        const right = sampleToPercent(range.endSample);
        const width = Math.max(0, right - left);
        if (right <= 0 || left >= 100) return null;
        return (
          <div
            className={`rangeBand ${range.selected ? "selected" : ""}`}
            key={range.id}
            onPointerDown={(event) => {
              event.stopPropagation();
              selectRange(range.id);
            }}
            style={{ left: `${left}%`, width: `${width}%`, "--range-color": range.color } as CSSProperties}
          >
            <button
              aria-label={`${range.name} start`}
              className="rangeEdge start"
              onPointerDown={(event) => handlePointerDown(range.id, "start", event)}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerUp}
              type="button"
            />
            <button
              aria-label={`${range.name} end`}
              className="rangeEdge end"
              onPointerDown={(event) => handlePointerDown(range.id, "end", event)}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerUp}
              type="button"
            />
          </div>
        );
      })}
    </div>
  );
}

function TimingMarkersOverlay({
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
              aria-label={`${marker.name} start`}
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
                aria-label={`${marker.name} end`}
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
  onRename,
  onSelect,
  session,
}: {
  isActive: boolean;
  onClose: () => void;
  onRename: (name: string) => void;
  onSelect: () => void;
  session: UiSession;
}) {
  return (
    <div className={`sessionTab ${isActive ? "active" : ""}`} role="tab" aria-selected={isActive} onClick={onSelect}>
      {isActive ? (
        <input
          aria-label="Session name"
          value={session.name}
          onChange={(event) => onRename(event.target.value)}
          onClick={(event) => event.stopPropagation()}
        />
      ) : (
        <span>{session.name}</span>
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
    </div>
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
  devices,
  extensions,
  onChangeExtensions,
  onCreateSession,
  onDecode,
  onNotify,
  onRefreshDevices,
  onSelectDevice,
  onSelectPanel,
  onUpdateSession,
  onUpdateSettings,
  onViewportChange,
  selectedDevice,
  selectedPanel,
  session,
}: {
  devices: DeviceInfo[];
  extensions: UiExtensionRecord[];
  onChangeExtensions: (updater: (extensions: UiExtensionRecord[]) => UiExtensionRecord[]) => void;
  onCreateSession: (deviceId?: string) => void;
  onDecode: () => void;
  onNotify: (message: string) => void;
  onRefreshDevices: () => void;
  onSelectDevice: (deviceId: string) => void;
  onSelectPanel: (panel: SidebarPanel | undefined) => void;
  onUpdateSession: (updater: (session: UiSession) => UiSession) => void;
  onUpdateSettings: (patch: Partial<CaptureSettings>) => void;
  onViewportChange: (start: number, samples: number) => void;
  selectedDevice: string;
  selectedPanel: SidebarPanel | undefined;
  session: UiSession | null;
}) {
  return (
    <aside className="saleaeSidebarRoot">
      {selectedPanel && (
        <section className="sidebarActiveComponent">
          <SidebarPanelContent
            devices={devices}
            extensions={extensions}
            onChangeExtensions={onChangeExtensions}
            onCreateSession={onCreateSession}
            onDecode={onDecode}
            onNotify={onNotify}
            onRefreshDevices={onRefreshDevices}
            onSelectDevice={onSelectDevice}
            onUpdateSession={onUpdateSession}
            onUpdateSettings={onUpdateSettings}
            onViewportChange={onViewportChange}
            panel={selectedPanel}
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
  devices,
  extensions,
  onChangeExtensions,
  onCreateSession,
  onDecode,
  onNotify,
  onRefreshDevices,
  onSelectDevice,
  onUpdateSession,
  onUpdateSettings,
  onViewportChange,
  panel,
  selectedDevice,
  session,
}: {
  devices: DeviceInfo[];
  extensions: UiExtensionRecord[];
  onChangeExtensions: (updater: (extensions: UiExtensionRecord[]) => UiExtensionRecord[]) => void;
  onCreateSession: (deviceId?: string) => void;
  onDecode: () => void;
  onNotify: (message: string) => void;
  onRefreshDevices: () => void;
  onSelectDevice: (deviceId: string) => void;
  onUpdateSession: (updater: (session: UiSession) => UiSession) => void;
  onUpdateSettings: (patch: Partial<CaptureSettings>) => void;
  onViewportChange: (start: number, samples: number) => void;
  panel: SidebarPanel;
  selectedDevice: string;
  session: UiSession | null;
}) {
  const meta = panelMeta[panel];
  return (
    <div className="sidebarPanelContent">
      {panel !== "extensions" && panel !== "notes" && (
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
          selectedDevice={selectedDevice}
          session={session}
        />
      )}
      {panel === "recordingSettings" && session && (
        <RecordingSettingsPanel
          onUpdateSession={onUpdateSession}
          onUpdateSettings={onUpdateSettings}
          session={session}
        />
      )}
      {panel === "analyzers" && session && (
        <AnalyzersPanel
          availableAnalyzers={[
            ...BUILT_IN_ANALYZERS,
            ...extensions
              .filter((extension) => extension.installed && extension.enabled)
              .flatMap((extension) =>
                Object.entries(extension.manifest.extensions)
                  .filter(([, feature]) => feature.type === "HighLevelAnalyzer")
                  .map(([name]) => name),
              ),
          ].filter((name, index, analyzers) => analyzers.indexOf(name) === index)}
          onDecode={onDecode}
          onUpdateSession={onUpdateSession}
          onViewportChange={onViewportChange}
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
          onAdd={() =>
            onUpdateSession((current) => ({
              ...current,
              rangeMeasurements: [
                ...current.rangeMeasurements.map((range) => ({ ...range, selected: false })),
                createRangeMeasurement(current),
              ],
            }))
          }
          onUpdateSession={onUpdateSession}
          onViewportChange={onViewportChange}
          session={session}
        />
      )}
      {panel === "timingMarkers" && session && <TimingMarkersPanel onUpdateSession={onUpdateSession} session={session} />}
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
  selectedDevice,
  session,
}: {
  devices: DeviceInfo[];
  onRefreshDevices: () => void;
  onSelectDevice: (deviceId: string) => void;
  onUpdateSession: (updater: (session: UiSession) => UiSession) => void;
  onUpdateSettings: (patch: Partial<CaptureSettings>) => void;
  selectedDevice: string;
  session: UiSession;
}) {
  const [showDeviceInfo, setShowDeviceInfo] = useState(false);
  const selected = devices.find((device) => device.id === selectedDevice);
  const enabledChannels = selected
    ? session.deviceSettings.digitalChannels.filter(Boolean).length
    : session.settings.channel_count;
  const digitalChannels = session.deviceSettings.digitalChannels;

  function updateDeviceSettings(patch: Partial<UiDeviceSettings>) {
    onUpdateSession((current) => ({
      ...current,
      deviceSettings: {
        ...current.deviceSettings,
        ...patch,
        digitalChannels: patch.digitalChannels
          ? [...patch.digitalChannels]
          : [...current.deviceSettings.digitalChannels],
      },
    }));
  }

  function setChannelCount(channelCount: number) {
    onUpdateSettings({ channel_count: channelCount });
    updateDeviceSettings({
      digitalChannels: makeDigitalChannels(channelCount),
      triggerChannel: Math.min(session.deviceSettings.triggerChannel, Math.max(0, channelCount - 1)),
    });
  }

  function toggleDigitalChannel(index: number) {
    const nextChannels = [...digitalChannels];
    nextChannels[index] = !nextChannels[index];
    const highestEnabled = highestEnabledDigitalChannel(nextChannels);
    onUpdateSettings({ channel_count: Math.max(1, highestEnabled + 1) });
    onUpdateSession((current) => ({
      ...current,
      deviceSettings: {
        ...current.deviceSettings,
        digitalChannels: nextChannels,
        triggerChannel: Math.min(current.deviceSettings.triggerChannel, highestEnabled),
      },
      message: `D${index} ${nextChannels[index] ? "shown and enabled" : "hidden and disabled"}`,
    }));
  }

  function selectAllDigitalChannels(enabled: boolean) {
    const nextCount = enabled ? 32 : 1;
    onUpdateSettings({ channel_count: nextCount });
    onUpdateSession((current) => ({
      ...current,
      deviceSettings: {
        ...current.deviceSettings,
        digitalChannels: enabled ? Array.from({ length: 32 }, () => true) : Array.from({ length: 32 }, () => false),
        triggerChannel: 0,
      },
      message: enabled ? "All 32 digital channels shown and enabled" : "All digital channels hidden and disabled",
    }));
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

        <label className="stack-field">
          <span>Sample rate</span>
          <select
            value={session.settings.sample_rate_hz}
            onChange={(event) => onUpdateSettings({ sample_rate_hz: Number(event.target.value) })}
          >
            {SAMPLE_RATES.map((rate) => (
              <option key={rate} value={rate}>
                {formatRate(rate)}
              </option>
            ))}
          </select>
        </label>
        <label className="stack-field">
          <span>Active channels</span>
          <select value={session.settings.channel_count} onChange={(event) => setChannelCount(Number(event.target.value))}>
            {CHANNEL_COUNTS.map((count) => (
              <option key={count} value={count}>
                {count} digital
              </option>
            ))}
          </select>
        </label>
        <label className="stack-field">
          <span>Digital threshold</span>
          <input
            min={0}
            onChange={(event) => onUpdateSettings({ threshold_volts: Number(event.target.value) })}
            step={0.1}
            type="number"
            value={session.settings.threshold_volts}
          />
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
              onClick={() => updateDeviceSettings({ captureMode: mode })}
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
            <label className="stack-field">
              <span>Trigger channel</span>
              <select
                value={session.deviceSettings.triggerChannel}
                onChange={(event) => updateDeviceSettings({ triggerChannel: Number(event.target.value) })}
              >
                {Array.from({ length: Math.max(1, session.settings.channel_count) }, (_, index) => (
                  <option key={index} value={index}>
                    D{index}
                  </option>
                ))}
              </select>
            </label>
            <label className="stack-field">
              <span>Trigger type</span>
              <select
                value={session.deviceSettings.triggerEdge}
                onChange={(event) => updateDeviceSettings({ triggerEdge: event.target.value as UiTriggerEdge })}
              >
                {(["Rising Edge", "Falling Edge", "High Pulse", "Low Pulse"] as UiTriggerEdge[]).map((edge) => (
                  <option key={edge} value={edge}>
                    {edge}
                  </option>
                ))}
              </select>
            </label>
            <label className="stack-field">
              <span>Pulse width us</span>
              <input
                min={0}
                onChange={(event) => updateDeviceSettings({ triggerPulseWidthUs: Number(event.target.value) })}
                type="number"
                value={session.deviceSettings.triggerPulseWidthUs}
              />
            </label>
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
        <label className="toggle-field panel-toggle">
          <input
            checked={session.deviceSettings.glitchFilterEnabled}
            onChange={(event) => updateDeviceSettings({ glitchFilterEnabled: event.target.checked })}
            type="checkbox"
          />
          Glitch filter
        </label>
        {session.deviceSettings.glitchFilterEnabled && (
          <label className="stack-field">
            <span>Glitch filter width ns</span>
            <input
              min={1}
              onChange={(event) => updateDeviceSettings({ glitchFilterNs: Number(event.target.value) })}
              type="number"
              value={session.deviceSettings.glitchFilterNs}
            />
          </label>
        )}
        <label className="stack-field">
          <span>Buffer size</span>
          <select
            value={session.deviceSettings.bufferSizeMb}
            onChange={(event) => updateDeviceSettings({ bufferSizeMb: Number(event.target.value) })}
          >
            {[256, 512, 1024, 2048, 4096].map((size) => (
              <option key={size} value={size}>
                {formatBytes(size * 1024 * 1024)}
              </option>
            ))}
          </select>
        </label>
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

      {session.busy && <div className="deviceSettingsDisabledOverlay">Settings are disabled during capture</div>}
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

function RecordingSettingsPanel({
  onUpdateSettings,
  onUpdateSession,
  session,
}: {
  onUpdateSession: (updater: (session: UiSession) => UiSession) => void;
  onUpdateSettings: (patch: Partial<CaptureSettings>) => void;
  session: UiSession;
}) {
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

  return (
    <div className="recordingSettingsPanel">
      <section className="deviceSettingsBlock">
        <div className="deviceSettingsBlockTitle">
          <span>Recording Type</span>
          <small>{session.deviceSettings.captureMode}</small>
        </div>
        <div className="recordingTypeGrid">
          {(["FreeRun", "Timer", "Trigger"] as UiRecordingMode[]).map((mode) => (
            <button
              className={session.deviceSettings.captureMode === mode ? "active" : ""}
              key={mode}
              onClick={() => updateDeviceSettings({ captureMode: mode })}
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
              {SAMPLE_RATES.map((rate) => (
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
              {SAMPLE_RATES.map((rate) => (
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
              <span>Trigger Settings</span>
              <small>Digital</small>
            </div>
            <label className="stack-field">
              <span>Trigger channel</span>
              <select
                value={session.deviceSettings.triggerChannel}
                onChange={(event) => updateDeviceSettings({ triggerChannel: Number(event.target.value) })}
              >
                {Array.from({ length: Math.max(1, session.settings.channel_count) }, (_, index) => (
                  <option key={index} value={index}>
                    D{index}
                  </option>
                ))}
              </select>
            </label>
            <label className="stack-field">
              <span>Trigger type</span>
              <select
                value={session.deviceSettings.triggerEdge}
                onChange={(event) => updateDeviceSettings({ triggerEdge: event.target.value as UiTriggerEdge })}
              >
                {(["Rising Edge", "Falling Edge", "High Pulse", "Low Pulse"] as UiTriggerEdge[]).map((edge) => (
                  <option key={edge} value={edge}>
                    {edge}
                  </option>
                ))}
              </select>
            </label>
            <label className="stack-field">
              <span>Holdoff ms</span>
              <input
                min={0}
                onChange={(event) => updateDeviceSettings({ triggerHoldoffMs: Number(event.target.value) })}
                type="number"
                value={session.deviceSettings.triggerHoldoffMs}
              />
            </label>
          </section>

          <section className="deviceSettingsBlock compact">
            <div className="deviceSettingsBlockTitle">
              <span>Single Shot</span>
              <small>{session.deviceSettings.singleShotEnabled ? "On" : "Off"}</small>
            </div>
            <label className="toggle-field panel-toggle">
              <input
                checked={session.deviceSettings.singleShotEnabled}
                onChange={(event) => updateDeviceSettings({ singleShotEnabled: event.target.checked })}
                type="checkbox"
              />
              Enable single shot
            </label>
            <label className="toggle-field panel-toggle">
              <input
                checked={session.deviceSettings.singleShotHighResolution}
                onChange={(event) => updateDeviceSettings({ singleShotHighResolution: event.target.checked })}
                type="checkbox"
              />
              High resolution
            </label>
            <div className="twoColumnFields">
              <label className="stack-field">
                <span>Pre-trigger ms</span>
                <input
                  min={0}
                  onChange={(event) => updateDeviceSettings({ singleShotPreTriggerMs: Number(event.target.value) })}
                  type="number"
                  value={session.deviceSettings.singleShotPreTriggerMs}
                />
              </label>
              <label className="stack-field">
                <span>Post-trigger ms</span>
                <input
                  min={0}
                  onChange={(event) => updateDeviceSettings({ singleShotPostTriggerMs: Number(event.target.value) })}
                  type="number"
                  value={session.deviceSettings.singleShotPostTriggerMs}
                />
              </label>
            </div>
          </section>

          <section className="deviceSettingsBlock compact">
            <div className="deviceSettingsBlockTitle">
              <span>Trigger Sampling</span>
              <small>{session.deviceSettings.triggerSamplingEnabled ? "Manual" : "Auto"}</small>
            </div>
            <label className="toggle-field panel-toggle">
              <input
                checked={session.deviceSettings.triggerSamplingEnabled}
                onChange={(event) => updateDeviceSettings({ triggerSamplingEnabled: event.target.checked })}
                type="checkbox"
              />
              Manual trigger sample rate
            </label>
            <label className="stack-field">
              <span>Sample rate</span>
              <select
                disabled={!session.deviceSettings.triggerSamplingEnabled}
                value={session.deviceSettings.triggerSamplingRateHz}
                onChange={(event) => updateDeviceSettings({ triggerSamplingRateHz: Number(event.target.value) })}
              >
                {SAMPLE_RATES.map((rate) => (
                  <option key={rate} value={rate}>
                    {formatRate(rate)}
                  </option>
                ))}
              </select>
            </label>
            <label className="stack-field">
              <span>Priority</span>
              <select
                disabled={!session.deviceSettings.triggerSamplingEnabled}
                value={session.deviceSettings.triggerSamplingPriority}
                onChange={(event) =>
                  updateDeviceSettings({ triggerSamplingPriority: event.target.value as UiDeviceSettings["triggerSamplingPriority"] })
                }
              >
                <option value="Sample Rate">Sample Rate</option>
                <option value="Duration">Duration</option>
              </select>
            </label>
          </section>
        </>
      )}
    </div>
  );
}

function AnalyzersPanel({
  availableAnalyzers,
  onDecode,
  onUpdateSession,
  onViewportChange,
  session,
}: {
  availableAnalyzers: string[];
  onDecode: () => void;
  onUpdateSession: (updater: (session: UiSession) => UiSession) => void;
  onViewportChange: (start: number, samples: number) => void;
  session: UiSession;
}) {
  const [selectorOpen, setSelectorOpen] = useState(false);
  const channelCount = session.summary?.metadata.channel_count ?? session.settings.channel_count;
  const hasAsyncSerial = session.analyzers.includes("Async Serial");

  function addAnalyzer(name: string) {
    onUpdateSession((current) => ({
      ...current,
      analyzers: current.analyzers.includes(name) ? current.analyzers : [...current.analyzers, name],
      message: `${name} analyzer selected`,
    }));
    setSelectorOpen(false);
  }

  function removeAnalyzer(name: string) {
    onUpdateSession((current) => ({
      ...current,
      analyzers: current.analyzers.filter((analyzer) => analyzer !== name),
      message: `${name} analyzer removed`,
    }));
  }

  function moveAnalyzer(name: string, direction: -1 | 1) {
    onUpdateSession((current) => {
      const index = current.analyzers.indexOf(name);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= current.analyzers.length) return current;
      const analyzers = [...current.analyzers];
      [analyzers[index], analyzers[target]] = [analyzers[target], analyzers[index]];
      return { ...current, analyzers };
    });
  }

  return (
    <div className="analyzersSidebarPanel">
      <section className="analyzersSelectorSection">
        <div className="sidebarTitleRow">
          <div className="sidebarTitleText">Analyzers</div>
          <button className={`sidebarCircleButton ${selectorOpen ? "active" : ""}`} onClick={() => setSelectorOpen((open) => !open)} type="button">
            <Plus size={13} />
          </button>
        </div>

        {selectorOpen && (
          <div className="analyzerSelectionPopover">
            {availableAnalyzers.map((name) => (
              <button
                className="analyzerSelectionItem"
                disabled={session.analyzers.includes(name)}
                key={name}
                onClick={() => addAnalyzer(name)}
                type="button"
              >
                <span>{name}</span>
                <small>{name === "Async Serial" ? "Built-in UART decoder" : "Analyzer"}</small>
              </button>
            ))}
          </div>
        )}

        {session.analyzers.length === 0 ? (
          <div className="suggestedAnalyzers">
            <div className="suggestedAnalyzersTitle">Suggested Analyzers</div>
            {availableAnalyzers.slice(0, 4).map((name) => (
              <button className="suggestedAnalyzerItem" key={name} onClick={() => addAnalyzer(name)} type="button">
                <SlidersHorizontal size={13} />
                <span>{name}</span>
              </button>
            ))}
          </div>
        ) : (
          <div className="activeAnalyzerList">
            {session.analyzers.map((name, index) => (
              <div className="activeAnalyzerItem" key={name}>
                <div className="activeAnalyzerHeader">
                  <GripVertical size={13} />
                  <span className="analyzerColorIndicator" />
                  <strong>{name}</strong>
                  <div className="analyzerRowActions">
                    <button disabled={index === 0} onClick={() => moveAnalyzer(name, -1)} title="Move up" type="button">
                      <ChevronUp size={12} />
                    </button>
                    <button
                      disabled={index === session.analyzers.length - 1}
                      onClick={() => moveAnalyzer(name, 1)}
                      title="Move down"
                      type="button"
                    >
                      <ChevronDown size={12} />
                    </button>
                    <button onClick={() => removeAnalyzer(name)} title="Delete" type="button">
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>

                {name === "Async Serial" ? (
                  <div className="analyzerSettingsGrid">
                    <label className="stack-field">
                      <span>Input channel</span>
                      <select
                        value={session.decodeChannel}
                        onChange={(event) => onUpdateSession((current) => ({ ...current, decodeChannel: Number(event.target.value) }))}
                      >
                        {Array.from({ length: channelCount }, (_, channelIndex) => (
                          <option value={channelIndex} key={channelIndex}>
                            D{channelIndex}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="stack-field">
                      <span>Bit rate</span>
                      <input
                        min={300}
                        onChange={(event) => onUpdateSession((current) => ({ ...current, decodeBaud: Number(event.target.value) }))}
                        type="number"
                        value={session.decodeBaud}
                      />
                    </label>
                    <label className="toggle-field panel-toggle">
                      <input
                        checked={session.decodeInverted}
                        onChange={(event) => onUpdateSession((current) => ({ ...current, decodeInverted: event.target.checked }))}
                        type="checkbox"
                      />
                      Inverted
                    </label>
                    <button className="panel-action" onClick={onDecode} disabled={!session.summary || session.decodeBusy} type="button">
                      <Search size={15} />
                      Decode
                    </button>
                  </div>
                ) : (
                  <div className="analyzerPendingSettings">
                    <label className="stack-field">
                      <span>Input channel</span>
                      <select disabled>
                        <option>D0</option>
                      </select>
                    </label>
                    <button className="panel-action" disabled type="button">
                      <Settings2 size={15} />
                      Configure
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="analyzerDataSection">
        <div className="sidebarTitleRow tight">
          <div className="sidebarTitleText">
            Data
            <small>{session.decodedFrames.length}</small>
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
              <button
                disabled={session.decodedFrames.length === 0}
                onClick={() => void navigator.clipboard?.writeText(session.decodedFrames.map((frame) => frame.label).join("\n"))}
                type="button"
              >
                <Copy size={12} />
                Copy
              </button>
            </div>
            <div className="result-list analyzerFramesList">
              {!hasAsyncSerial ? (
                <div className="empty-result">Add Async Serial to decode UART frames</div>
              ) : session.decodedFrames.length === 0 ? (
                <div className="empty-result">No frames</div>
              ) : (
                session.decodedFrames.slice(0, 200).map((frame, index) => (
                  <button
                    className="decode-row"
                    key={`${frame.start_sample}-${index}`}
                    onClick={() => onViewportChange(frame.start_sample, Math.max(128, frame.end_sample - frame.start_sample))}
                    type="button"
                  >
                    <span>{frame.label}</span>
                    <small>{formatSamples(frame.start_sample)}</small>
                  </button>
                ))
              )}
            </div>
          </div>
        ) : (
          <div className="analyzerTerminal">
            {session.decodedFrames.length === 0 ? (
              <div className="empty-result">No terminal data</div>
            ) : (
              session.decodedFrames.slice(0, 200).map((frame, index) => (
                <div className="terminalLine" key={`${frame.start_sample}-${index}`}>
                  <span>{formatSamples(frame.start_sample)}</span>
                  <strong>{frame.label}</strong>
                </div>
              ))
            )}
          </div>
        )}
      </section>
    </div>
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
  onUpdateSession,
  onViewportChange,
  session,
}: {
  onAdd: () => void;
  onUpdateSession: (updater: (session: UiSession) => UiSession) => void;
  onViewportChange: (start: number, samples: number) => void;
  session: UiSession;
}) {
  const sampleRateHz = session.summary?.metadata.sample_rate_hz ?? session.settings.sample_rate_hz;

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
      rangeMeasurements: current.rangeMeasurements.map((range) => ({ ...range, selected: range.id === id })),
    }));
  }

  function deleteRange(id: string) {
    onUpdateSession((current) => ({
      ...current,
      rangeMeasurements: current.rangeMeasurements.filter((range) => range.id !== id),
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
    const metrics = computeRangeMetrics(session, range, sampleRateHz);
    const content = [
      range.name,
      `Duration\t${metrics.duration}`,
      `Edges\t${metrics.edges}`,
      `Frequency\t${metrics.frequency}`,
      `Duty\t${metrics.duty}`,
      `Width 1\t${metrics.width1}`,
    ].join("\n");
    void navigator.clipboard?.writeText(content);
  }

  return (
    <div className="measurementsSidebarPanel">
      <div className="sidebarTitleRow">
        <div className="sidebarTitleText">Measurements</div>
        <button className="sidebarCircleButton" onClick={onAdd} type="button">
          <Plus size={13} />
        </button>
      </div>

      {session.rangeMeasurements.length === 0 ? (
        <div className="emptyMeasurementState">
          <BarChart3 size={24} />
          <span>Click "+" to add Measurements</span>
        </div>
      ) : (
        <div className="rangeMeasurementList">
          {session.rangeMeasurements.map((range) => {
            const metrics = computeRangeMetrics(session, range, sampleRateHz);
            return (
              <section
                className={`rangeMeasurementItem ${range.selected ? "selected" : ""}`}
                key={range.id}
                onClick={() => selectRange(range.id)}
                style={{ "--range-color": range.color } as CSSProperties}
              >
                <div className="rangeMeasurementHeader">
                  <span className="rangeColorSwatch" />
                  <input
                    aria-label="Range name"
                    onChange={(event) => updateRange(range.id, { name: event.target.value })}
                    value={range.name}
                  />
                  <div className="rangeMeasurementActions">
                    <button onClick={() => copyRange(range)} title="Copy" type="button">
                      <Copy size={12} />
                    </button>
                    <button onClick={() => goToRange(range)} title="Go to Range" type="button">
                      <Search size={12} />
                    </button>
                    <button onClick={() => goToRange(range, true)} title="Zoom on Range" type="button">
                      <Maximize2 size={12} />
                    </button>
                    <button onClick={() => deleteRange(range.id)} title="Delete" type="button">
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>
                <div className="rangeMetricsGrid">
                  <MetricCell label="Duration" value={metrics.duration} />
                  <MetricCell label="Edges" value={String(metrics.edges)} />
                  <MetricCell label="Frequency" value={metrics.frequency} />
                  <MetricCell label="Duty" value={metrics.duty} />
                  <MetricCell label="Width 1" value={metrics.width1} />
                </div>
                <textarea
                  className="rangeNote"
                  onChange={(event) => updateRange(range.id, { note: event.target.value })}
                  placeholder="Add note"
                  value={range.note}
                />
              </section>
            );
          })}
          <button className="panel-action" onClick={deleteAll} type="button">
            <Trash2 size={15} />
            Delete All
          </button>
        </div>
      )}
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

function computeRangeMetrics(session: UiSession, range: UiRangeMeasurement, sampleRateHz: number) {
  const start = Math.min(range.startSample, range.endSample);
  const end = Math.max(range.startSample, range.endSample);
  const durationSamples = Math.max(1, end - start);
  const channel = session.tile?.channels[0];
  const edges = channel
    ? [...channel.rising_edges, ...channel.falling_edges].filter((sample) => sample >= start && sample <= end).length
    : 0;
  const risingEdges = channel?.rising_edges.filter((sample) => sample >= start && sample <= end) ?? [];
  const periodSamples =
    risingEdges.length >= 2
      ? risingEdges[1] - risingEdges[0]
      : channel
        ? [...channel.rising_edges, ...channel.falling_edges]
            .filter((sample) => sample >= start && sample <= end)
            .sort((a, b) => a - b)
            .slice(0, 2)
            .reduce((delta, sample, index, samples) => (index === 1 ? sample - samples[0] : delta), 0)
        : 0;

  let highSamples = 0;
  let width1Samples = 0;
  if (channel) {
    channel.segments.forEach((segment) => {
      if (!segment.high) return;
      const overlapStart = Math.max(start, segment.start_sample);
      const overlapEnd = Math.min(end, segment.end_sample);
      const overlap = Math.max(0, overlapEnd - overlapStart);
      highSamples += overlap;
      width1Samples = Math.max(width1Samples, overlap);
    });
  }

  const duty = durationSamples > 0 ? (highSamples / durationSamples) * 100 : 0;
  return {
    duration: formatSeconds(durationSamples / Math.max(1, sampleRateHz)),
    duty: highSamples > 0 ? `${trimNumber(duty)}%` : "-",
    edges,
    frequency: periodSamples > 0 ? formatRate(sampleRateHz / periodSamples) : "-",
    width1: width1Samples > 0 ? formatSeconds(width1Samples / Math.max(1, sampleRateHz)) : "-",
  };
}

function TimingMarkersPanel({
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
                    onChange={(event) => updateMarker(marker.id, { name: event.target.value })}
                    value={marker.name}
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
