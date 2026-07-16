import { listen } from "@tauri-apps/api/event";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  Activity,
  BarChart3,
  ChevronDown,
  ChevronUp,
  Clock3,
  Download,
  FileDown,
  FolderOpen,
  Maximize2,
  Plus,
  RefreshCw,
  Save,
  Search,
  Settings2,
  SlidersHorizontal,
  Usb,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { CSSProperties, ReactNode, RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import analyzersIcon from "./assets/saleae/sidebar/analyzers.svg";
import cursorsIcon from "./assets/saleae/sidebar/cursors.svg";
import devicesIcon from "./assets/saleae/sidebar/devices.svg";
import extensionsIcon from "./assets/saleae/sidebar/extensions.svg";
import measurementsIcon from "./assets/saleae/sidebar/measurements.svg";
import notesIcon from "./assets/saleae/sidebar/notes.svg";
import recordingSettingsIcon from "./assets/saleae/sidebar/recordingSettings.svg";
import timingMarkersIcon from "./assets/saleae/sidebar/timingMarkers.svg";
import { DeviceStartScreen } from "./components/DeviceStartScreen";
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
  summary: CaptureSummary | null;
  progress: CaptureProgress | null;
  tile: WaveformTile | null;
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
  rangeMeasurements: number;
  markerPairs: number;
  singleMarkers: number;
  notes: string;
}

const DEFAULT_DEVICE_ID = "fake:pxlogic-demo";
const SAMPLE_RATES = [1_000_000, 5_000_000, 10_000_000, 25_000_000, 50_000_000, 100_000_000];
const CHANNEL_COUNTS = [4, 8, 16, 24, 32];

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

function makeSession(id: string, name: string, deviceId: string, source?: UiSession): UiSession {
  const settings = source ? { ...source.settings, device_id: deviceId } : defaultSettings(deviceId);
  return {
    id,
    name,
    selectedDevice: deviceId,
    settings,
    summary: null,
    progress: null,
    tile: null,
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
    rangeMeasurements: 0,
    markerPairs: 0,
    singleMarkers: 0,
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
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [selectedPanel, setSelectedPanel] = useState<SidebarPanel | undefined>(undefined);
  const [footerPopover, setFooterPopover] = useState<FooterPopover>(null);
  const [startupMessage, setStartupMessage] = useState("Ready");

  const footerRef = useRef<HTMLElement>(null);
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
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  const activeSession = useMemo(
    () => sessions.find((session) => session.id === activeSessionId) ?? null,
    [activeSessionId, sessions],
  );

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
          summary: event.payload,
          viewportStart: 0,
          viewportSamples: Math.min(event.payload.metadata.sample_count, 100_000),
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
    () =>
      activeSession?.summary?.metadata.labels ??
      Array.from({ length: activeSession?.settings.channel_count ?? 16 }, (_, index) => `D${index}`),
    [activeSession?.settings.channel_count, activeSession?.summary?.metadata.labels],
  );

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
          updateSession(sessionSnapshot.id, (session) => ({ ...session, tile: next }));
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
        summary: next,
        viewportStart: 0,
        viewportSamples: Math.min(next.metadata.sample_count, 100_000),
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
    updateSession(target.id, (session) => ({
      ...session,
      selectedDevice: summary.metadata.source_device || session.selectedDevice,
      settings: {
        ...session.settings,
        device_id: summary.metadata.source_device || session.selectedDevice,
        sample_rate_hz: summary.metadata.sample_rate_hz,
        channel_count: summary.metadata.channel_count,
      },
      summary,
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
    updateSession(activeSession.id, (session) => ({ ...session, settings: { ...session.settings, ...patch } }));
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
      rangeMeasurements: session.rangeMeasurements + 1,
      message: "Range measurement added",
    }));
  }

  function handleAddMarkerPair() {
    openSidebarPanel("timingMarkers");
    if (!activeSession) return;
    updateSession(activeSession.id, (session) => ({
      ...session,
      markerPairs: session.markerPairs + 1,
      message: "Marker pair added",
    }));
  }

  function handleAddSingleMarker() {
    openSidebarPanel("timingMarkers");
    if (!activeSession) return;
    updateSession(activeSession.id, (session) => ({
      ...session,
      singleMarkers: session.singleMarkers + 1,
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
        setSelectedPanel(undefined);
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
                  {activeSession ? `${channelLabels.length} Channels` : "Select Device"}
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
                <div className="graph rowV2">
                  <div className="contentContainer rowV2">
                    <div className="labelsBackground" />
                    <div
                      className="channelLabels"
                      style={{ gridTemplateRows: `repeat(${Math.max(1, channelLabels.length)}, minmax(34px, 1fr))` }}
                    >
                      {channelLabels.map((label, index) => (
                        <button className="channelRow" key={`${label}-${index}`} title={label}>
                          <span className={`channelHeader channel${index % 4} digital small focusable`}>
                            <span className="channelNumber">{index}</span>
                          </span>
                          <span className="channelText">
                            <strong>{label}</strong>
                            <small>D{index}</small>
                          </span>
                        </button>
                      ))}
                    </div>
                    <div className="graphViewport">
                      <WaveformCanvas
                        tile={activeSession.tile}
                        onWidthChange={(width) =>
                          updateSession(activeSession.id, (session) => ({ ...session, canvasWidth: width }))
                        }
                        sampleRateHz={activeSession.summary?.metadata.sample_rate_hz ?? activeSession.settings.sample_rate_hz}
                        totalSamples={totalSamples}
                        viewportStart={activeSession.viewportStart}
                        viewportSamples={activeSession.viewportSamples}
                        onViewportChange={(start, samples) => updateViewport(activeSession.id, start, samples)}
                      />
                    </div>
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

          {activeSession && (
            <RightSidebar
              devices={devices}
              onCreateSession={createSessionFromFooter}
              onDecode={() => handleDecode(activeSession.id)}
              onRefreshDevices={refreshDevices}
              onSelectDevice={setSelectedDeviceForActive}
              onSelectPanel={toggleSidebarPanel}
              onUpdateSession={(updater) => updateSession(activeSession.id, updater)}
              onUpdateSettings={updateActiveSettings}
              onViewportChange={(start, samples) => updateViewport(activeSession.id, start, samples)}
              selectedDevice={selectedDevice}
              selectedPanel={selectedPanel}
              session={activeSession}
            />
          )}
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
  onCreateSession,
  onDecode,
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
  onCreateSession: (deviceId?: string) => void;
  onDecode: () => void;
  onRefreshDevices: () => void;
  onSelectDevice: (deviceId: string) => void;
  onSelectPanel: (panel: SidebarPanel | undefined) => void;
  onUpdateSession: (updater: (session: UiSession) => UiSession) => void;
  onUpdateSettings: (patch: Partial<CaptureSettings>) => void;
  onViewportChange: (start: number, samples: number) => void;
  selectedDevice: string;
  selectedPanel: SidebarPanel | undefined;
  session: UiSession;
}) {
  return (
    <aside className="saleaeSidebarRoot">
      {selectedPanel && (
        <section className="sidebarActiveComponent">
          <SidebarPanelContent
            devices={devices}
            onCreateSession={onCreateSession}
            onDecode={onDecode}
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
                disabled={!allowed.isSelectable}
                key={panel}
                onClick={() => onSelectPanel(isSelected ? undefined : panel)}
                title={allowed.disabledReason ?? title}
                type="button"
              >
                <SaleaeSidebarIcon iconUrl={meta.iconUrl} />
                {panel === "measurements" && session.rangeMeasurements > 0 && <span className="indicatorDot" />}
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
  onCreateSession,
  onDecode,
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
  onCreateSession: (deviceId?: string) => void;
  onDecode: () => void;
  onRefreshDevices: () => void;
  onSelectDevice: (deviceId: string) => void;
  onUpdateSession: (updater: (session: UiSession) => UiSession) => void;
  onUpdateSettings: (patch: Partial<CaptureSettings>) => void;
  onViewportChange: (start: number, samples: number) => void;
  panel: SidebarPanel;
  selectedDevice: string;
  session: UiSession;
}) {
  const meta = panelMeta[panel];
  return (
    <div className="sidebarPanelContent">
      <header className="sidebarPanelHeader">
        <span>
          <SaleaeSidebarIcon iconUrl={meta.iconUrl} />
          {meta.label}
        </span>
      </header>
      {panel === "devices" && (
        <DeviceSettingsPanel
          devices={devices}
          onCreateSession={onCreateSession}
          onRefreshDevices={onRefreshDevices}
          onSelectDevice={onSelectDevice}
          selectedDevice={selectedDevice}
        />
      )}
      {panel === "recordingSettings" && <RecordingSettingsPanel onUpdateSettings={onUpdateSettings} session={session} />}
      {panel === "analyzers" && (
        <AnalyzersPanel
          onDecode={onDecode}
          onUpdateSession={onUpdateSession}
          onViewportChange={onViewportChange}
          session={session}
        />
      )}
      {panel === "cursors" && <SimpleListPanel emptyText="No cursors" rows={["Center cursor", "A1 / A2 timing cursors"]} />}
      {panel === "measurements" && (
        <MeasurementsPanel
          onAdd={() => onUpdateSession((current) => ({ ...current, rangeMeasurements: current.rangeMeasurements + 1 }))}
          session={session}
        />
      )}
      {panel === "timingMarkers" && <TimingMarkersPanel onUpdateSession={onUpdateSession} session={session} />}
      {panel === "extensions" && <SimpleListPanel emptyText="No extensions" rows={["Marketplace", "Custom analyzers"]} />}
      {panel === "notes" && (
        <textarea
          className="notesEditor"
          onChange={(event) => onUpdateSession((current) => ({ ...current, notes: event.target.value }))}
          placeholder="Capture notes"
          value={session.notes}
        />
      )}
    </div>
  );
}

function DeviceSettingsPanel({
  devices,
  onCreateSession,
  onRefreshDevices,
  onSelectDevice,
  selectedDevice,
}: {
  devices: DeviceInfo[];
  onCreateSession: (deviceId?: string) => void;
  onRefreshDevices: () => void;
  onSelectDevice: (deviceId: string) => void;
  selectedDevice: string;
}) {
  return (
    <div className="sidebarSection">
      <DeviceMenuRows
        devices={devices}
        onCreateSession={onCreateSession}
        onRefreshDevices={onRefreshDevices}
        onSelectDevice={onSelectDevice}
        selectedDevice={selectedDevice}
      />
    </div>
  );
}

function RecordingSettingsPanel({
  onUpdateSettings,
  session,
}: {
  onUpdateSettings: (patch: Partial<CaptureSettings>) => void;
  session: UiSession;
}) {
  return (
    <div className="sidebarForm">
      <label className="stack-field">
        <span>Capture mode</span>
        <select value={session.settings.mode} onChange={(event) => onUpdateSettings({ mode: event.target.value as CaptureSettings["mode"] })}>
          <option value="Buffer">Buffer</option>
          <option value="Stream">Stream</option>
        </select>
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
      <label className="stack-field">
        <span>Channels</span>
        <select
          value={session.settings.channel_count}
          onChange={(event) => onUpdateSettings({ channel_count: Number(event.target.value) })}
        >
          {CHANNEL_COUNTS.map((count) => (
            <option key={count} value={count}>
              {count} digital
            </option>
          ))}
        </select>
      </label>
      <label className="stack-field">
        <span>Duration</span>
        <input
          min={1}
          onChange={(event) => onUpdateSettings({ duration_ms: Number(event.target.value) })}
          type="number"
          value={session.settings.duration_ms}
        />
      </label>
      <label className="stack-field">
        <span>Threshold</span>
        <input
          min={0}
          onChange={(event) => onUpdateSettings({ threshold_volts: Number(event.target.value) })}
          step={0.1}
          type="number"
          value={session.settings.threshold_volts}
        />
      </label>
      <label className="toggle-field panel-toggle">
        <input
          checked={session.settings.decode_cross}
          onChange={(event) => onUpdateSettings({ decode_cross: event.target.checked })}
          type="checkbox"
        />
        Decode crossing edges
      </label>
    </div>
  );
}

function AnalyzersPanel({
  onDecode,
  onUpdateSession,
  onViewportChange,
  session,
}: {
  onDecode: () => void;
  onUpdateSession: (updater: (session: UiSession) => UiSession) => void;
  onViewportChange: (start: number, samples: number) => void;
  session: UiSession;
}) {
  const channelCount = session.summary?.metadata.channel_count ?? session.settings.channel_count;
  return (
    <div className="analyzerPanel">
      <section className="inspector-card">
        <div className="inspector-title">
          <span>
            <SlidersHorizontal size={14} />
            Analyzer
          </span>
          <small>UART</small>
        </div>
        <label className="stack-field">
          <span>Input channel</span>
          <select
            value={session.decodeChannel}
            onChange={(event) => onUpdateSession((current) => ({ ...current, decodeChannel: Number(event.target.value) }))}
          >
            {Array.from({ length: channelCount }, (_, index) => (
              <option value={index} key={index}>
                D{index}
              </option>
            ))}
          </select>
        </label>
        <label className="stack-field">
          <span>Baud rate</span>
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
      </section>

      <section className="inspector-card fill">
        <div className="inspector-title">
          <span>
            <BarChart3 size={14} />
            Frames
          </span>
          <small>{session.decodedFrames.length}</small>
        </div>
        <div className="result-list">
          {session.decodedFrames.length === 0 ? (
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
      </section>

      <section className="inspector-card trace-card">
        <div className="inspector-title">
          <span>
            <Settings2 size={14} />
            USB Trace
          </span>
          <small>{session.diagnostics.length}</small>
        </div>
        <div className="trace-list">
          {session.diagnostics.length === 0 ? (
            <div className="empty-result">No USB events</div>
          ) : (
            session.diagnostics.slice(-80).map((event, index) => (
              <div className={`trace-row trace-${event.level.toLowerCase()}`} key={`${event.phase}-${index}`}>
                <span>{event.phase}</span>
                <small>{event.message}</small>
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
}

function MeasurementsPanel({ onAdd, session }: { onAdd: () => void; session: UiSession }) {
  return (
    <div className="sidebarSection">
      <button className="panel-action" onClick={onAdd} type="button">
        <Plus size={15} />
        Add Range Measurement
      </button>
      <SimpleListPanel
        emptyText="No range measurements"
        rows={Array.from({ length: session.rangeMeasurements }, (_, index) => `Range ${index + 1}`)}
      />
    </div>
  );
}

function TimingMarkersPanel({
  onUpdateSession,
  session,
}: {
  onUpdateSession: (updater: (session: UiSession) => UiSession) => void;
  session: UiSession;
}) {
  return (
    <div className="sidebarSection">
      <button
        className="panel-action"
        onClick={() => onUpdateSession((current) => ({ ...current, markerPairs: current.markerPairs + 1 }))}
        type="button"
      >
        <Plus size={15} />
        Add Marker Pair
      </button>
      <button
        className="panel-action"
        onClick={() => onUpdateSession((current) => ({ ...current, singleMarkers: current.singleMarkers + 1 }))}
        type="button"
      >
        <Plus size={15} />
        Add Single Marker
      </button>
      <SimpleListPanel
        emptyText="No timing markers"
        rows={[
          ...Array.from({ length: session.markerPairs }, (_, index) => `Pair ${index + 1}`),
          ...Array.from({ length: session.singleMarkers }, (_, index) => `Marker ${index + 1}`),
        ]}
      />
    </div>
  );
}

function SimpleListPanel({ emptyText, rows }: { emptyText: string; rows: string[] }) {
  return (
    <div className="simplePanelList">
      {rows.length === 0 ? (
        <div className="empty-result">{emptyText}</div>
      ) : (
        rows.map((row) => (
          <div className="simplePanelRow" key={row}>
            <Clock3 size={13} />
            <span>{row}</span>
          </div>
        ))
      )}
    </div>
  );
}
