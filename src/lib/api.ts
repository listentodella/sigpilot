import { invoke } from "@tauri-apps/api/core";
import {
  UiExtensionFeatureType,
  UiExtensionManifest,
  UiExtensionPackage,
  UiExtensionTemplateRequest,
} from "./extensions";

export type DeviceKind = "Fake" | "Usb";

export interface DeviceInfo {
  id: string;
  kind: DeviceKind;
  vid: number;
  pid: number;
  bus: number | null;
  address: number | null;
  label: string;
  ready: boolean;
}

export interface CaptureSettings {
  device_id: string;
  sample_rate_hz: number;
  channel_count: number;
  duration_ms: number;
  buffer_size_mb: number;
  decode_cross: boolean;
  threshold_volts: number;
  mode: CaptureMode;
}

export type CaptureMode = "Buffer" | "Stream";

export interface CaptureMetadata {
  version: number;
  source_device: string;
  sample_rate_hz: number;
  channel_count: number;
  unitsize: number;
  sample_count: number;
  captured_at: string;
  labels: string[];
}

export interface CaptureSummary {
  metadata: CaptureMetadata;
  bytes: number;
}

export interface TrimCaptureRequest {
  trim_before_sample?: number;
  trim_after_sample?: number;
}

export interface CaptureProgress {
  bytes_read: number;
  bytes_expected: number;
  samples_read: number;
}

export type DiagnosticLevel = "Info" | "Warn" | "Error";

export interface DiagnosticEvent {
  phase: string;
  level: DiagnosticLevel;
  message: string;
}

export type ExportFormat = "Pxcap" | "Sr" | "Vcd";

export interface WaveformRequest {
  start_sample: number;
  sample_count: number;
  pixels: number;
  channels: number[];
}

export interface DigitalRangeMeasurementRequest {
  channel: number;
  start_sample: number;
  end_sample: number;
}

export interface DigitalRangeMeasurementStats {
  channel: number;
  start_sample: number;
  end_sample: number;
  sample_rate_hz: number;
  duration_samples: number;
  high_samples: number;
  low_samples: number;
  rising_edges: number;
  falling_edges: number;
  edge_count: number;
  high_width_count: number;
  low_width_count: number;
  avg_high_width_samples: number | null;
  avg_low_width_samples: number | null;
  cycle_count: number;
  avg_period_samples: number | null;
  min_period_samples: number | null;
  max_period_samples: number | null;
  period_std_dev_samples: number | null;
  avg_frequency_hz: number | null;
  min_frequency_hz: number | null;
  max_frequency_hz: number | null;
  positive_duty: number | null;
  negative_duty: number | null;
  first_sample_high: boolean;
  last_sample_high: boolean;
}

export interface WaveformBin {
  x: number;
  first: boolean;
  last: boolean;
  has_high: boolean;
  has_low: boolean;
  edges: number;
  first_edge_offset: number | null;
  last_edge_offset: number | null;
}

export interface ChannelTile {
  channel: number;
  label: string;
  bins: WaveformBin[];
  packed_bins?: string | null;
  segments: DigitalSegment[];
  rising_edges: number[];
  falling_edges: number[];
}

export interface DigitalSegment {
  start_sample: number;
  end_sample: number;
  high: boolean;
}

export interface WaveformTile {
  start_sample: number;
  sample_count: number;
  pixels: number;
  samples_per_pixel: number;
  channels: ChannelTile[];
}

export interface UartDecodeSettings {
  channel: number;
  baud_rate: number;
  inverted: boolean;
}

export interface I2cDecodeSettings {
  sda_channel: number;
  scl_channel: number;
}

export interface SpiDecodeSettings {
  mosi_channel: number | null;
  miso_channel: number | null;
  clock_channel: number;
  enable_channel: number | null;
  enable_active_low: boolean;
  clock_polarity: boolean;
  clock_phase: boolean;
  bits_per_transfer: number;
  msb_first: boolean;
}

export type AnalyzerDecodeSettings =
  | { protocol: "Uart"; settings: UartDecodeSettings }
  | { protocol: "I2c"; settings: I2cDecodeSettings }
  | { protocol: "Spi"; settings: SpiDecodeSettings };

export interface DecodedChannelValue {
  channel: number;
  role: string;
  label: string;
  value: number;
}

export interface DecodedFrame {
  frame_id: number;
  start_sample: number;
  end_sample: number;
  label: string;
  value: number;
  channel_values: DecodedChannelValue[];
}

export interface AnalyzerBubble {
  type: "SingleBubble" | "MultiBubble";
  frame_id_interval: {
    begin: number;
    end: number;
  };
  start_sample: number;
  end_sample: number;
  display_text: string[];
  result_count: number;
}

export interface UartFrameWindowRequest extends UartDecodeSettings {
  start_sample: number;
  sample_count: number;
  width_px: number;
}

export interface UartFrameWindow {
  bubbles: AnalyzerBubble[];
  frames: DecodedFrame[];
  previous_frame: DecodedFrame | null;
  next_frame: DecodedFrame | null;
}

export type AnalyzerFrameWindow = UartFrameWindow;

export interface AnalyzerTrackRequest {
  channel: number;
  role: string;
}

export interface AnalyzerRenderRequest {
  analyzer_id: string;
  settings: AnalyzerDecodeSettings;
  tracks: AnalyzerTrackRequest[];
}

export interface AnalyzerTrackWindow extends AnalyzerFrameWindow {
  channel: number;
  role: string;
}

export interface AnalyzerRenderResult {
  analyzer_id: string;
  tracks: AnalyzerTrackWindow[];
}

export interface GraphFrameRequest {
  frame_id: number;
  waveform: WaveformRequest;
  analyzer_view?: WaveformRequest | null;
  analyzers: AnalyzerRenderRequest[];
}

export interface GraphFrameResponse {
  frame_id: number;
  revision: number;
  sample_count: number;
  tile: WaveformTile;
  analyzers: AnalyzerRenderResult[];
}

export interface CaptureCallbacks {
  onProgress?: (progress: CaptureProgress) => void;
  onSummary?: (summary: CaptureSummary) => void;
}

const isTauriRuntime = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

let previewCapture: CaptureSummary = {
  metadata: {
    version: 1,
    source_device: "PXLogic Preview",
    sample_rate_hz: 25_000_000,
    channel_count: 16,
    unitsize: 2,
    sample_count: 250_000,
    captured_at: new Date().toISOString(),
    labels: Array.from({ length: 16 }, (_, index) => `D${index}`),
  },
  bytes: 500_000,
};
let previewCaptureRun: { cancelled: boolean } | null = null;
const previewCaptures = new Map<string, CaptureSummary>();
const previewCaptureRevisions = new Map<string, number>();
const previewAnalyzerFrameCache = new Map<string, DecodedFrame[]>();

// Ported from Logic 2.4.43 BaseAnalyzerManager.maximumMarkerResults.
const PREVIEW_MAX_ANALYZER_MARKER_RESULTS = 300;
const PREVIEW_MAX_MULTI_BUBBLE_STRINGS = 400;
const PREVIEW_MAX_PIXEL_WIDTH_FOR_MERGEABLE_FRAME = 15;
const PREVIEW_MAX_PIXELS_BETWEEN_MERGEABLE_FRAMES = 30;
const PREVIEW_CAPTURE_UPDATE_MS = 33;

async function callBackend<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauriRuntime()) {
    throw new Error("Tauri runtime is not available");
  }
  return invoke<T>(command, args);
}

function previewCaptureForSession(sessionId: string) {
  return previewCaptures.get(sessionId) ?? previewCapture;
}

function withPreviewCapture<T>(sessionId: string, callback: () => T): T {
  const previous = previewCapture;
  previewCapture = previewCaptureForSession(sessionId);
  try {
    return callback();
  } finally {
    previewCapture = previous;
  }
}

export function listDevices(): Promise<DeviceInfo[]> {
  if (!isTauriRuntime()) {
    return Promise.resolve([
      {
        id: "fake:pxlogic-demo",
        kind: "Fake",
        vid: 0x1209,
        pid: 0x7100,
        bus: null,
        address: null,
        label: "PXLogic Preview Device",
        ready: true,
      },
    ]);
  }
  return callBackend("list_devices");
}

export function prepareDevice(deviceId: string): Promise<void> {
  if (!isTauriRuntime()) return Promise.resolve();
  return callBackend("prepare_device", { deviceId });
}

export function startCapture(
  sessionId: string,
  settings: CaptureSettings,
  callbacks: CaptureCallbacks = {},
): Promise<CaptureSummary> {
  if (!isTauriRuntime()) {
    if (previewCaptureRun) previewCaptureRun.cancelled = true;
    const run = { cancelled: false };
    previewCaptureRun = run;
    const unitsize = settings.channel_count > 16 ? 4 : settings.channel_count > 8 ? 2 : 1;
    const timedSamples = Math.max(1, Math.round((settings.sample_rate_hz * settings.duration_ms) / 1000));
    const bufferBytes = Math.max(1, settings.buffer_size_mb) * 1024 * 1024;
    const targetSamples =
      settings.mode === "Stream"
        ? Math.max(1, Math.floor(bufferBytes / unitsize))
        : timedSamples;
    const targetBytes = targetSamples * unitsize;
    const capturedAt = new Date().toISOString();
    const startedAt = performance.now();

    return new Promise((resolve) => {
      function update() {
        const elapsedSeconds = Math.max(0, (performance.now() - startedAt) / 1000);
        const sampleCount = Math.max(
          1,
          Math.min(targetSamples, Math.floor(settings.sample_rate_hz * elapsedSeconds)),
        );
        previewCapture = {
          metadata: {
            version: 1,
            source_device: settings.device_id,
            sample_rate_hz: settings.sample_rate_hz,
            channel_count: settings.channel_count,
            unitsize,
            sample_count: sampleCount,
            captured_at: capturedAt,
            labels: Array.from({ length: settings.channel_count }, (_, index) => `D${index}`),
          },
          bytes: sampleCount * unitsize,
        };
        previewCaptures.set(sessionId, previewCapture);
        previewCaptureRevisions.set(sessionId, (previewCaptureRevisions.get(sessionId) ?? 0) + 1);
        callbacks.onProgress?.({
          bytes_read: previewCapture.bytes,
          bytes_expected: targetBytes,
          samples_read: sampleCount,
        });
        callbacks.onSummary?.(previewCapture);

        if (run.cancelled || sampleCount >= targetSamples) {
          if (previewCaptureRun === run) previewCaptureRun = null;
          resolve(previewCapture);
          return;
        }
        window.setTimeout(update, PREVIEW_CAPTURE_UPDATE_MS);
      }
      window.setTimeout(update, PREVIEW_CAPTURE_UPDATE_MS);
    });
  }
  return callBackend("start_capture", { sessionId, settings });
}

export function cancelCapture(): Promise<void> {
  if (!isTauriRuntime()) {
    if (previewCaptureRun) previewCaptureRun.cancelled = true;
    return Promise.resolve();
  }
  return callBackend("cancel_capture");
}

export function openCapture(sessionId: string, path: string): Promise<CaptureSummary> {
  if (!isTauriRuntime()) {
    previewCaptures.set(sessionId, previewCapture);
    previewCaptureRevisions.set(sessionId, (previewCaptureRevisions.get(sessionId) ?? 0) + 1);
    return Promise.resolve(previewCapture);
  }
  return callBackend("open_capture", { sessionId, path });
}

export function saveCapture(sessionId: string, path: string): Promise<void> {
  if (!isTauriRuntime()) return Promise.resolve();
  return callBackend("save_capture", { sessionId, path });
}

export function exportCapture(sessionId: string, path: string, format: ExportFormat): Promise<void> {
  if (!isTauriRuntime()) return Promise.resolve();
  return callBackend("export_capture", { sessionId, path, format });
}

export function trimCapture(sessionId: string, request: TrimCaptureRequest): Promise<CaptureSummary> {
  if (!isTauriRuntime()) {
    const current = previewCaptureForSession(sessionId);
    const totalSamples = current.metadata.sample_count;
    const safeTotal = Math.max(1, totalSamples);
    const startSample = Math.max(0, Math.min(safeTotal - 1, Math.round(request.trim_before_sample ?? 0)));
    const endSample = Math.max(
      startSample + 1,
      Math.min(safeTotal, Math.round(request.trim_after_sample ?? safeTotal)),
    );
    const sampleCount = Math.max(1, endSample - startSample);
    const nextCapture = {
      metadata: {
        ...current.metadata,
        sample_count: sampleCount,
      },
      bytes: sampleCount * current.metadata.unitsize,
    };
    previewCapture = nextCapture;
    previewCaptures.set(sessionId, nextCapture);
    previewCaptureRevisions.set(sessionId, (previewCaptureRevisions.get(sessionId) ?? 0) + 1);
    return Promise.resolve(nextCapture);
  }
  return callBackend("trim_capture", { sessionId, request });
}

export function getWaveformTile(sessionId: string, request: WaveformRequest): Promise<WaveformTile> {
  if (!isTauriRuntime()) {
    return Promise.resolve(withPreviewCapture(sessionId, () => buildPreviewTile(request)));
  }
  return callBackend("get_waveform_tile", { sessionId, request });
}

export function measureDigitalRange(
  sessionId: string,
  request: DigitalRangeMeasurementRequest,
): Promise<DigitalRangeMeasurementStats> {
  if (!isTauriRuntime()) {
    return Promise.resolve(withPreviewCapture(sessionId, () => measurePreviewDigitalRange(request)));
  }
  return callBackend("measure_digital_range", { sessionId, request });
}

export function decodeAnalyzerFrames(
  sessionId: string,
  settings: AnalyzerDecodeSettings,
): Promise<DecodedFrame[]> {
  if (!isTauriRuntime()) {
    return Promise.resolve(withPreviewCapture(sessionId, () => cachedPreviewAnalyzerFrames(settings)));
  }
  return callBackend("decode_analyzer_frames", { sessionId, settings });
}

export function decodeUartFrames(
  settings: UartDecodeSettings,
  sessionId = "preview",
): Promise<DecodedFrame[]> {
  return decodeAnalyzerFrames(sessionId, { protocol: "Uart", settings });
}

export async function getUartFrameWindow(
  request: UartFrameWindowRequest,
  sessionId = "preview",
): Promise<UartFrameWindow> {
  const frames = await decodeUartFrames(request, sessionId);
  return buildAnalyzerFrameWindow(frames, request.start_sample, request.sample_count, request.width_px);
}

export function renderGraphFrame(
  sessionId: string,
  request: GraphFrameRequest,
): Promise<GraphFrameResponse> {
  if (isTauriRuntime()) {
    return callBackend("render_graph_frame", { sessionId, request });
  }
  return Promise.resolve(
    withPreviewCapture(sessionId, () => {
      const analyzerView = request.analyzer_view ?? request.waveform;
      return {
        frame_id: request.frame_id,
        revision: previewCaptureRevisions.get(sessionId) ?? 0,
        sample_count: previewCapture.metadata.sample_count,
        tile: buildPreviewTile(request.waveform),
        analyzers: request.analyzers.map((analyzer) => {
          return {
            analyzer_id: analyzer.analyzer_id,
            tracks: analyzer.tracks.map((track) =>
              buildPreviewAnalyzerTrackWindow(analyzer.settings, track, analyzerView),
            ),
          };
        }),
      };
    }),
  );
}

function buildPreviewAnalyzerTrackWindow(
  settings: AnalyzerDecodeSettings,
  track: AnalyzerTrackRequest,
  view: WaveformRequest,
): AnalyzerTrackWindow {
  const window =
    settings.protocol === "Uart"
      ? buildPreviewUartFrameWindow({
          ...settings.settings,
          start_sample: view.start_sample,
          sample_count: view.sample_count,
          width_px: view.pixels,
        })
      : buildAnalyzerFrameWindow(
          framesForAnalyzerTrack(cachedPreviewAnalyzerFrames(settings), track),
          view.start_sample,
          view.sample_count,
          view.pixels,
        );
  return {
    channel: track.channel,
    role: track.role,
    ...window,
  };
}

function cachedPreviewAnalyzerFrames(settings: AnalyzerDecodeSettings) {
  const key = JSON.stringify([
    previewCapture.metadata.captured_at,
    previewCapture.metadata.sample_count,
    settings,
  ]);
  const cached = previewAnalyzerFrameCache.get(key);
  if (cached) return cached;
  const frames = buildPreviewAnalyzerFrames(settings);
  if (previewAnalyzerFrameCache.size >= 32) previewAnalyzerFrameCache.clear();
  previewAnalyzerFrameCache.set(key, frames);
  return frames;
}

function framesForAnalyzerTrack(frames: DecodedFrame[], track: AnalyzerTrackRequest) {
  const hasChannelValues = frames.some((frame) => frame.channel_values.length > 0);
  if (!hasChannelValues) return frames;
  return frames.flatMap((frame) => {
    const value = frame.channel_values.find(
      (item) => item.channel === track.channel && item.role === track.role,
    );
    if (!value) return [];
    return [
      {
        ...frame,
        label: value.label,
        value: value.value,
        channel_values: [value],
      },
    ];
  });
}

export function releaseGraphSession(sessionId: string): Promise<void> {
  previewCaptures.delete(sessionId);
  previewCaptureRevisions.delete(sessionId);
  if (!isTauriRuntime()) return Promise.resolve();
  return callBackend("release_graph_session", { sessionId });
}

function buildPreviewAnalyzerFrames(settings: AnalyzerDecodeSettings): DecodedFrame[] {
  if (settings.protocol === "Uart") return buildPreviewUartFrames(settings.settings);
  const metadata = previewCapture.metadata;
  const requestedChannels =
    settings.protocol === "I2c"
      ? [settings.settings.sda_channel, settings.settings.scl_channel]
      : [
          settings.settings.mosi_channel,
          settings.settings.miso_channel,
          settings.settings.clock_channel,
          settings.settings.enable_channel,
        ].filter((channel): channel is number => channel !== null);
  if (requestedChannels.some((channel) => channel < 0 || channel >= metadata.channel_count)) return [];
  if (settings.protocol === "I2c") {
    if (settings.settings.sda_channel !== 1 || settings.settings.scl_channel !== 2) return [];
  } else if (
    settings.settings.clock_channel !== 5 ||
    settings.settings.bits_per_transfer !== 8 ||
    !settings.settings.msb_first ||
    settings.settings.clock_polarity ||
    settings.settings.clock_phase ||
    (settings.settings.mosi_channel !== null && settings.settings.mosi_channel !== 3) ||
    (settings.settings.miso_channel !== null && settings.settings.miso_channel !== 4) ||
    (settings.settings.enable_channel !== null && settings.settings.enable_channel !== 6) ||
    (settings.settings.enable_channel === 6 && !settings.settings.enable_active_low)
  ) {
    return [];
  }
  const halfPeriod = Math.max(
    2,
    Math.round(metadata.sample_rate_hz / (settings.protocol === "I2c" ? 200_000 : 2_000_000)),
  );
  const framePeriod =
    settings.protocol === "I2c"
      ? halfPeriod * 18
      : halfPeriod * (settings.settings.bits_per_transfer * 2 + 4);
  const transactionPeriod =
    settings.protocol === "I2c" ? halfPeriod * 60 : halfPeriod * (settings.settings.bits_per_transfer * 2 + 4);
  const sourceFrameCount =
    settings.protocol === "I2c"
      ? Math.ceil(metadata.sample_count / transactionPeriod) * 3
      : Math.ceil(metadata.sample_count / framePeriod);
  const frameStride = Math.max(1, Math.ceil(sourceFrameCount / 100_000));
  const count = Math.min(100_000, Math.ceil(sourceFrameCount / frameStride));
  return Array.from({ length: count }, (_, frameId) => {
    const sourceFrameId = Math.min(sourceFrameCount - 1, frameId * frameStride);
    const byteIndex = sourceFrameId % 3;
    const transaction = Math.floor(sourceFrameId / (settings.protocol === "I2c" ? 3 : 1));
    const startSample =
      settings.protocol === "I2c"
        ? transaction * transactionPeriod + halfPeriod * (4 + byteIndex * 18)
        : transaction * transactionPeriod + halfPeriod * 3;
    const value =
      settings.protocol === "I2c"
        ? [0xa0, 0x2a, 0x55][byteIndex]
        : [0xa5, 0x3c, 0x5a, 0xf0][sourceFrameId % 4];
    const misoValue = (value ^ 0x99) & 0xff;
    const endSample =
      settings.protocol === "I2c"
        ? startSample + halfPeriod * 16 + 1
        : startSample + halfPeriod * (settings.settings.bits_per_transfer - 1) * 2 + 1;
    const spiLabel =
      settings.protocol === "Spi"
        ? [
            settings.settings.mosi_channel === null
              ? null
              : `MOSI 0x${value.toString(16).padStart(2, "0").toUpperCase()}`,
            settings.settings.miso_channel === null
              ? null
              : `MISO ${labelForPreviewByte(misoValue)}`,
          ]
            .filter((label): label is string => label !== null)
            .join(" / ")
        : "";
    const channelValues: DecodedChannelValue[] =
      settings.protocol === "I2c"
        ? [
            {
              channel: settings.settings.sda_channel,
              role: "SDA",
              label:
                byteIndex === 0
                  ? `0x${(value >> 1).toString(16).padStart(2, "0").toUpperCase()} ${value & 1 ? "R" : "W"}`
                  : labelForPreviewByte(value),
              value,
            },
          ]
        : [
            settings.settings.mosi_channel === null
              ? null
              : {
                  channel: settings.settings.mosi_channel,
                  role: "MOSI",
                  label: labelForPreviewByte(value),
                  value,
                },
            settings.settings.miso_channel === null
              ? null
              : {
                  channel: settings.settings.miso_channel,
                  role: "MISO",
                  label: labelForPreviewByte(misoValue),
                  value: misoValue,
                },
          ].filter((entry): entry is DecodedChannelValue => entry !== null);
    return {
      frame_id: sourceFrameId,
      start_sample: startSample,
      end_sample: Math.min(metadata.sample_count, endSample),
      label:
        settings.protocol === "I2c"
          ? byteIndex === 0
            ? `Address 0x${(value >> 1).toString(16).padStart(2, "0").toUpperCase()} Write ACK`
            : `Data 0x${value.toString(16).padStart(2, "0").toUpperCase()} ACK`
          : spiLabel,
      value,
      channel_values: channelValues,
    };
  }).filter((frame) => frame.start_sample < metadata.sample_count && frame.end_sample > frame.start_sample);
}

function buildPreviewUartFrames(settings: UartDecodeSettings): DecodedFrame[] {
  const metadata = previewCapture.metadata;
  return buildPreviewUartFrameWindow({
    ...settings,
    start_sample: 0,
    sample_count: metadata.sample_count,
    width_px: 1000,
  }).frames.slice(0, 4096);
}

function buildPreviewUartFrameWindow(request: UartFrameWindowRequest): UartFrameWindow {
  if (request.channel !== 0 || request.baud_rate <= 0) {
    return emptyUartFrameWindow();
  }
  const metadata = previewCapture.metadata;
  const bitPeriod = metadata.sample_rate_hz / request.baud_rate;
  if (bitPeriod < 2) return emptyUartFrameWindow();

  const startSample = Math.max(0, Math.min(metadata.sample_count, request.start_sample));
  const endSample = Math.max(
    startSample,
    Math.min(metadata.sample_count, startSample + Math.max(1, request.sample_count)),
  );
  const overscanSamples = Math.max(
    Math.round((endSample - startSample) * 0.35),
    Math.round(bitPeriod * PREVIEW_UART_CYCLE_BITS),
  );
  const queryStart = Math.max(0, startSample - overscanSamples);
  const queryEnd = Math.min(metadata.sample_count, endSample + overscanSamples);
  const firstCycle = Math.max(
    0,
    Math.floor((queryStart / bitPeriod - PREVIEW_UART_LEAD_IDLE_BITS) / PREVIEW_UART_CYCLE_BITS) - 1,
  );
  const denseBubbles = buildPreviewDenseUartBubbles(startSample, endSample, bitPeriod, request.width_px);
  const bubbleAccumulators: BubbleAccumulator[] = [];
  const frames: DecodedFrame[] = [];
  let previousFrame: DecodedFrame | null = null;
  let nextFrame: DecodedFrame | null = null;

  for (let cycle = firstCycle; cycle < firstCycle + 1_000_000; cycle += 1) {
    const cycleFirstSample = previewUartCycleStartSample(cycle, bitPeriod);
    if (cycleFirstSample > queryEnd) break;

    for (let byteIndex = 0; byteIndex < PREVIEW_UART_MESSAGE.length; byteIndex += 1) {
      const frame = previewUartFrame(cycle, byteIndex, bitPeriod);
      if (frame.end_sample < queryStart) {
        previousFrame = frame;
        continue;
      }
      if (frame.start_sample > queryEnd) {
        nextFrame = frame;
        return {
          bubbles: denseBubbles ?? finalizeBubbleAccumulators(bubbleAccumulators),
          frames,
          previous_frame: previousFrame,
          next_frame: nextFrame,
        };
      }
      if (frame.end_sample < startSample) {
        previousFrame = frame;
      } else if (frame.start_sample > endSample) {
        nextFrame ??= frame;
      } else {
        if (!denseBubbles) {
          appendFrameToBubbleAccumulators(
            bubbleAccumulators,
            frame,
            Math.max(1, endSample - startSample),
            request.width_px,
          );
        }
        if (frames.length < PREVIEW_MAX_ANALYZER_MARKER_RESULTS) {
          frames.push(frame);
        } else {
          nextFrame ??= frame;
          if (denseBubbles) {
            return {
              bubbles: denseBubbles,
              frames,
              previous_frame: previousFrame,
              next_frame: nextFrame,
            };
          }
        }
      }
    }
  }
  return {
    bubbles: denseBubbles ?? finalizeBubbleAccumulators(bubbleAccumulators),
    frames,
    previous_frame: previousFrame,
    next_frame: nextFrame,
  };
}

export function buildAnalyzerFrameWindow(
  frames: DecodedFrame[],
  startSample: number,
  sampleCount: number,
  widthPx: number,
): AnalyzerFrameWindow {
  const endSample = startSample + sampleCount;
  const firstCandidate = lowerBoundFrameEnd(frames, startSample);
  const visibleEnd = upperBoundFrameStart(frames, endSample, firstCandidate);
  const visibleCount = Math.max(0, visibleEnd - firstCandidate);
  const limitedEnd = Math.min(visibleEnd, firstCandidate + PREVIEW_MAX_ANALYZER_MARKER_RESULTS);
  const limited = frames.slice(firstCandidate, limitedEnd);
  const bubbles =
    visibleCount > PREVIEW_MAX_ANALYZER_MARKER_RESULTS * 4
      ? buildDenseAnalyzerBubbles(frames, firstCandidate, visibleEnd)
      : buildAnalyzerBubblesFromFrames(
          frames.slice(firstCandidate, visibleEnd),
          sampleCount,
          widthPx,
        );
  return {
    bubbles,
    frames: limited,
    previous_frame: firstCandidate > 0 ? frames[firstCandidate - 1] : null,
    next_frame:
      visibleCount > PREVIEW_MAX_ANALYZER_MARKER_RESULTS
        ? frames[firstCandidate + PREVIEW_MAX_ANALYZER_MARKER_RESULTS]
        : visibleEnd < frames.length
          ? frames[visibleEnd]
          : null,
  };
}

function buildDenseAnalyzerBubbles(frames: DecodedFrame[], begin: number, end: number): AnalyzerBubble[] {
  const count = Math.max(0, end - begin);
  if (count === 0) return [];
  const bucketSize = Math.ceil(count / PREVIEW_MAX_ANALYZER_MARKER_RESULTS);
  const bubbles: AnalyzerBubble[] = [];
  for (let bucketBegin = begin; bucketBegin < end; bucketBegin += bucketSize) {
    const bucketEnd = Math.min(end, bucketBegin + bucketSize);
    const first = frames[bucketBegin];
    const last = frames[bucketEnd - 1];
    const displayText = frames
      .slice(bucketBegin, Math.min(bucketEnd, bucketBegin + 12))
      .map((frame) => frame.label);
    bubbles.push({
      type: bucketEnd - bucketBegin === 1 ? "SingleBubble" : "MultiBubble",
      frame_id_interval: { begin: first.frame_id, end: last.frame_id + 1 },
      start_sample: first.start_sample,
      end_sample: last.end_sample,
      display_text: displayText,
      result_count: bucketEnd - bucketBegin,
    });
  }
  return bubbles;
}

function lowerBoundFrameEnd(frames: DecodedFrame[], sample: number) {
  let low = 0;
  let high = frames.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (frames[middle].end_sample < sample) low = middle + 1;
    else high = middle;
  }
  return low;
}

function upperBoundFrameStart(frames: DecodedFrame[], sample: number, low = 0) {
  let start = low;
  let high = frames.length;
  while (start < high) {
    const middle = (start + high) >>> 1;
    if (frames[middle].start_sample <= sample) start = middle + 1;
    else high = middle;
  }
  return start;
}

interface BubbleAccumulator extends AnalyzerBubble {
  last_frame_end_sample: number;
  last_frame_width_px: number;
}

function emptyUartFrameWindow(): UartFrameWindow {
  return { bubbles: [], frames: [], previous_frame: null, next_frame: null };
}

function buildAnalyzerBubblesFromFrames(
  frames: DecodedFrame[],
  viewportSamples: number,
  widthPx: number,
): AnalyzerBubble[] {
  const accumulators: BubbleAccumulator[] = [];
  frames.forEach((frame) =>
    appendFrameToBubbleAccumulators(accumulators, frame, viewportSamples, widthPx),
  );
  return enforceMaximumBubbleResults(finalizeBubbleAccumulators(accumulators));
}

function appendFrameToBubbleAccumulators(
  accumulators: BubbleAccumulator[],
  frame: DecodedFrame,
  viewportSamples: number,
  widthPx: number,
) {
  const safeViewportSamples = Math.max(1, viewportSamples);
  const frameWidthPx = Math.max(
    0,
    ((frame.end_sample - frame.start_sample) / safeViewportSamples) * Math.max(1, widthPx),
  );
  const previous = accumulators[accumulators.length - 1];
  const gapPx = previous
    ? ((frame.start_sample - previous.last_frame_end_sample) / safeViewportSamples) * Math.max(1, widthPx)
    : Number.POSITIVE_INFINITY;
  const shouldMerge =
    Boolean(previous) &&
    frameWidthPx <= PREVIEW_MAX_PIXEL_WIDTH_FOR_MERGEABLE_FRAME &&
    previous.last_frame_width_px <= PREVIEW_MAX_PIXEL_WIDTH_FOR_MERGEABLE_FRAME &&
    gapPx <= PREVIEW_MAX_PIXELS_BETWEEN_MERGEABLE_FRAMES;

  if (previous && shouldMerge) {
    previous.type = "MultiBubble";
    previous.end_sample = Math.max(previous.end_sample, frame.end_sample);
    previous.frame_id_interval.end = Math.max(previous.frame_id_interval.end, frame.frame_id + 1);
    previous.result_count += 1;
    previous.last_frame_end_sample = frame.end_sample;
    previous.last_frame_width_px = frameWidthPx;
    if (previous.display_text.length < PREVIEW_MAX_MULTI_BUBBLE_STRINGS) {
      previous.display_text.push(frame.label);
    }
    return;
  }

  accumulators.push({
    type: "SingleBubble",
    frame_id_interval: { begin: frame.frame_id, end: frame.frame_id + 1 },
    start_sample: frame.start_sample,
    end_sample: frame.end_sample,
    display_text: [frame.label],
    result_count: 1,
    last_frame_end_sample: frame.end_sample,
    last_frame_width_px: frameWidthPx,
  });
}

function finalizeBubbleAccumulators(accumulators: BubbleAccumulator[]): AnalyzerBubble[] {
  return accumulators.map(
    ({ last_frame_end_sample, last_frame_width_px, ...bubble }) => bubble,
  );
}

function enforceMaximumBubbleResults(bubbles: AnalyzerBubble[]): AnalyzerBubble[] {
  if (bubbles.length <= PREVIEW_MAX_ANALYZER_MARKER_RESULTS) return bubbles;
  const bucketSize = Math.ceil(bubbles.length / PREVIEW_MAX_ANALYZER_MARKER_RESULTS);
  const merged: AnalyzerBubble[] = [];
  for (let index = 0; index < bubbles.length; index += bucketSize) {
    const bucket = bubbles.slice(index, index + bucketSize);
    if (bucket.length === 1) {
      merged.push(bucket[0]);
      continue;
    }
    merged.push(mergeBubbles(bucket));
  }
  return merged;
}

function mergeBubbles(bubbles: AnalyzerBubble[]): AnalyzerBubble {
  const first = bubbles[0];
  const last = bubbles[bubbles.length - 1];
  const displayText: string[] = [];
  for (const bubble of bubbles) {
    for (const text of bubble.display_text) {
      if (displayText.length >= PREVIEW_MAX_MULTI_BUBBLE_STRINGS) break;
      displayText.push(text);
    }
    if (displayText.length >= PREVIEW_MAX_MULTI_BUBBLE_STRINGS) break;
  }
  return {
    type: "MultiBubble",
    frame_id_interval: {
      begin: first.frame_id_interval.begin,
      end: last.frame_id_interval.end,
    },
    start_sample: first.start_sample,
    end_sample: last.end_sample,
    display_text: displayText,
    result_count: bubbles.reduce((count, bubble) => count + bubble.result_count, 0),
  };
}

function buildPreviewDenseUartBubbles(
  startSample: number,
  endSample: number,
  bitPeriod: number,
  widthPx: number,
): AnalyzerBubble[] | null {
  const viewportSamples = Math.max(1, endSample - startSample);
  const frameWidthPx = ((10 * bitPeriod) / viewportSamples) * Math.max(1, widthPx);
  const largestInterFrameGapPx =
    (((PREVIEW_UART_LEAD_IDLE_BITS + PREVIEW_UART_TRAIL_IDLE_BITS) * bitPeriod) / viewportSamples) *
    Math.max(1, widthPx);
  if (
    frameWidthPx > PREVIEW_MAX_PIXEL_WIDTH_FOR_MERGEABLE_FRAME ||
    largestInterFrameGapPx > PREVIEW_MAX_PIXELS_BETWEEN_MERGEABLE_FRAMES
  ) {
    return null;
  }

  const firstFrame = findPreviewFrame(startSample, endSample, bitPeriod, "first");
  const lastFrame = findPreviewFrame(startSample, endSample, bitPeriod, "last");
  if (!firstFrame || !lastFrame || lastFrame.frame_id < firstFrame.frame_id) return [];

  const resultCount = lastFrame.frame_id - firstFrame.frame_id + 1;
  const displayText: string[] = [];
  for (
    let frameId = firstFrame.frame_id;
    frameId <= lastFrame.frame_id && displayText.length < PREVIEW_MAX_MULTI_BUBBLE_STRINGS;
    frameId += 1
  ) {
    displayText.push(previewUartFrameById(frameId, bitPeriod).label);
  }

  return [
    {
      type: resultCount === 1 ? "SingleBubble" : "MultiBubble",
      frame_id_interval: { begin: firstFrame.frame_id, end: lastFrame.frame_id + 1 },
      start_sample: firstFrame.start_sample,
      end_sample: lastFrame.end_sample,
      display_text: displayText,
      result_count: resultCount,
    },
  ];
}

function findPreviewFrame(
  startSample: number,
  endSample: number,
  bitPeriod: number,
  direction: "first" | "last",
): DecodedFrame | null {
  if (direction === "first") {
    const firstCycle = Math.max(
      0,
      Math.floor((startSample / bitPeriod - PREVIEW_UART_LEAD_IDLE_BITS) / PREVIEW_UART_CYCLE_BITS) - 1,
    );
    let frameId = firstCycle * PREVIEW_UART_MESSAGE.length;
    for (let attempts = 0; attempts < PREVIEW_UART_MESSAGE.length * 4_000; attempts += 1, frameId += 1) {
      const frame = previewUartFrameById(frameId, bitPeriod);
      if (frame.start_sample > endSample) return null;
      if (frame.end_sample >= startSample) return frame;
    }
    return null;
  }

  const lastCycle = Math.max(
    0,
    Math.floor((endSample / bitPeriod - PREVIEW_UART_LEAD_IDLE_BITS) / PREVIEW_UART_CYCLE_BITS) + 1,
  );
  let frameId = (lastCycle + 1) * PREVIEW_UART_MESSAGE.length - 1;
  for (let attempts = 0; attempts < PREVIEW_UART_MESSAGE.length * 4_000 && frameId >= 0; attempts += 1, frameId -= 1) {
    const frame = previewUartFrameById(frameId, bitPeriod);
    if (frame.end_sample < startSample) return null;
    if (frame.start_sample <= endSample) return frame;
  }
  return null;
}

const PREVIEW_UART_MESSAGE = Array.from(new TextEncoder().encode("PXLogic demo\n"));
const PREVIEW_UART_LEAD_IDLE_BITS = 4;
const PREVIEW_UART_TRAIL_IDLE_BITS = 8;
const PREVIEW_UART_CYCLE_BITS =
  PREVIEW_UART_LEAD_IDLE_BITS + PREVIEW_UART_MESSAGE.length * 10 + PREVIEW_UART_TRAIL_IDLE_BITS;

function previewUartCycleStartSample(cycle: number, bitPeriod: number) {
  return Math.round((cycle * PREVIEW_UART_CYCLE_BITS + PREVIEW_UART_LEAD_IDLE_BITS) * bitPeriod);
}

function previewUartFrame(cycle: number, byteIndex: number, bitPeriod: number): DecodedFrame {
  const frameId = cycle * PREVIEW_UART_MESSAGE.length + byteIndex;
  const startSample = Math.round(
    (cycle * PREVIEW_UART_CYCLE_BITS + PREVIEW_UART_LEAD_IDLE_BITS + byteIndex * 10) * bitPeriod,
  );
  const endSample = Math.round(startSample + 10 * bitPeriod);
  const value = PREVIEW_UART_MESSAGE[byteIndex];
  return {
    frame_id: frameId,
    start_sample: startSample,
    end_sample: endSample,
    label: labelForPreviewByte(value),
    value,
    channel_values: [
      {
        channel: 0,
        role: "Input",
        label: labelForPreviewByte(value),
        value,
      },
    ],
  };
}

function previewUartFrameById(frameId: number, bitPeriod: number): DecodedFrame {
  const cycle = Math.floor(frameId / PREVIEW_UART_MESSAGE.length);
  const byteIndex = frameId % PREVIEW_UART_MESSAGE.length;
  return previewUartFrame(cycle, byteIndex, bitPeriod);
}

function labelForPreviewByte(value: number) {
  return `0x${value.toString(16).padStart(2, "0").toUpperCase()}`;
}

export function readExtensionPackage(path: string): Promise<UiExtensionPackage> {
  if (!isTauriRuntime()) {
    return Promise.reject(new Error("Loading an extension from disk requires the desktop app"));
  }
  return callBackend("read_extension_package", { path });
}

export function createExtensionTemplate(request: UiExtensionTemplateRequest): Promise<UiExtensionPackage> {
  if (!isTauriRuntime()) {
    return Promise.resolve(buildPreviewExtensionPackage(request));
  }
  return callBackend("create_extension_template", { request });
}

function buildPreviewExtensionPackage(request: UiExtensionTemplateRequest): UiExtensionPackage {
  const title = request.name.trim() || previewExtensionName(request.path);
  const featureName = title || "My Extension";
  const entryPoint =
    request.type === "HighLevelAnalyzer"
      ? "HighLevelAnalyzer.Hla"
      : `${request.type}.${request.type === "AnalogMeasurement" ? "MyAnalogMeasurer" : "MyDigitalMeasurer"}`;
  const feature: UiExtensionManifest["extensions"][string] = {
    entryPoint,
    type: request.type,
    ...(request.type === "HighLevelAnalyzer"
      ? {}
      : {
          metrics: {
            metricKey: {
              name: "<metric_name>",
              notation: "<short_notation>",
            },
          },
        }),
  };
  return {
    manifest: {
      apiVersion: "1.0.0",
      author: request.author.trim() || "shy coder",
      description: request.description,
      extensions: { [featureName]: feature },
      name: featureName,
      version: "0.0.1",
    },
    path: request.path,
    readme: `# ${featureName}\n\nGenerated PXLogic extension template for ${extensionTypeName(request.type)}.`,
  };
}

function previewExtensionName(path: string) {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized.split("/").pop() || "My Extension";
}

function extensionTypeName(type: UiExtensionFeatureType) {
  if (type === "HighLevelAnalyzer") return "a high-level analyzer";
  if (type === "DigitalMeasurement") return "a digital measurement";
  return "an analog measurement";
}

function buildPreviewTile(request: WaveformRequest): WaveformTile {
  const metadata = previewCapture.metadata;
  const startSample = Math.max(0, Math.min(metadata.sample_count, Math.round(request.start_sample)));
  const requestedEnd = Math.max(startSample + 1, startSample + Math.max(1, Math.round(request.sample_count)));
  const endSample = Math.min(metadata.sample_count, requestedEnd);
  const sampleCount = Math.max(1, endSample - startSample);
  const pixels = Math.max(1, Math.min(Math.ceil(sampleCount), Math.max(1, Math.round(request.pixels))));
  const samplesPerPixel = sampleCount / pixels;
  const channels = request.channels.length
    ? request.channels.filter((channel) => channel < metadata.channel_count)
    : Array.from({ length: metadata.channel_count }, (_, index) => index);

  return {
    start_sample: startSample,
    sample_count: sampleCount,
    pixels,
    samples_per_pixel: samplesPerPixel,
    channels: channels.map((channel) => {
      const bins = buildPreviewBins(startSample, sampleCount, pixels, channel, metadata.sample_rate_hz);
      const exact = buildPreviewExactDigitalData(
        startSample,
        endSample,
        pixels,
        channel,
        metadata.sample_rate_hz,
      );
      return {
        channel,
        label: metadata.labels[channel] ?? `D${channel}`,
        segments: exact.segments,
        rising_edges: exact.rising_edges,
        falling_edges: exact.falling_edges,
        bins,
      };
    }),
  };
}

interface PreviewDigitalData {
  segments: DigitalSegment[];
  rising_edges: number[];
  falling_edges: number[];
}

interface PreviewSampleStats {
  count: number;
  max: number | null;
  min: number | null;
  sum: number;
  sumSquares: number;
}

const PREVIEW_EXACT_SEGMENT_LIMIT = 12_000;
const PREVIEW_BIN_SEGMENT_LIMIT = 180_000;
const PREVIEW_MEASUREMENT_SEGMENT_LIMIT = 2_000_000;
const PREVIEW_UART_BAUD = 115_200;

function measurePreviewDigitalRange(request: DigitalRangeMeasurementRequest): DigitalRangeMeasurementStats {
  const metadata = previewCapture.metadata;
  if (request.channel < 0 || request.channel >= metadata.channel_count) {
    throw new Error("invalid digital range channel");
  }
  const maxStart = Math.max(0, metadata.sample_count - 1);
  const startSample = Math.max(0, Math.min(maxStart, Math.round(request.start_sample)));
  const endSample = Math.max(startSample + 1, Math.min(metadata.sample_count, Math.round(request.end_sample)));
  const data = buildPreviewDigitalSegments(
    startSample,
    endSample,
    request.channel,
    metadata.sample_rate_hz,
    PREVIEW_MEASUREMENT_SEGMENT_LIMIT,
  );
  if (!data) {
    return emptyPreviewDigitalRangeStats(request.channel, startSample, endSample, metadata.sample_rate_hz);
  }
  const boundaryAdjustedData = addPreviewRangeBoundaryEdges(
    data,
    request.channel,
    startSample,
    endSample,
    metadata.sample_count,
    metadata.sample_rate_hz,
  );
  return measurePreviewDigitalSegments(
    request.channel,
    startSample,
    endSample,
    metadata.sample_rate_hz,
    boundaryAdjustedData,
  );
}

function addPreviewRangeBoundaryEdges(
  data: PreviewDigitalData,
  channel: number,
  startSample: number,
  endSample: number,
  totalSamples: number,
  sampleRateHz: number,
): PreviewDigitalData {
  const rising_edges = [...data.rising_edges];
  const falling_edges = [...data.falling_edges];
  const firstHigh = previewDigitalLevelAt(startSample, channel, sampleRateHz);
  if (startSample > 0) {
    const beforeHigh = previewDigitalLevelAt(startSample - 1, channel, sampleRateHz);
    if (beforeHigh !== firstHigh) {
      (firstHigh ? rising_edges : falling_edges).push(startSample);
    }
  }
  if (endSample < totalSamples) {
    const lastHigh = previewDigitalLevelAt(endSample - 1, channel, sampleRateHz);
    const afterHigh = previewDigitalLevelAt(endSample, channel, sampleRateHz);
    if (lastHigh !== afterHigh) {
      (afterHigh ? rising_edges : falling_edges).push(endSample);
    }
  }
  rising_edges.sort((a, b) => a - b);
  falling_edges.sort((a, b) => a - b);
  return { ...data, rising_edges, falling_edges };
}

function emptyPreviewDigitalRangeStats(
  channel: number,
  startSample: number,
  endSample: number,
  sampleRateHz: number,
): DigitalRangeMeasurementStats {
  const durationSamples = Math.max(1, endSample - startSample);
  return {
    channel,
    start_sample: startSample,
    end_sample: endSample,
    sample_rate_hz: sampleRateHz,
    duration_samples: durationSamples,
    high_samples: 0,
    low_samples: durationSamples,
    rising_edges: 0,
    falling_edges: 0,
    edge_count: 0,
    high_width_count: 0,
    low_width_count: 0,
    avg_high_width_samples: null,
    avg_low_width_samples: null,
    cycle_count: 0,
    avg_period_samples: null,
    min_period_samples: null,
    max_period_samples: null,
    period_std_dev_samples: null,
    avg_frequency_hz: null,
    min_frequency_hz: null,
    max_frequency_hz: null,
    positive_duty: null,
    negative_duty: null,
    first_sample_high: false,
    last_sample_high: false,
  };
}

function measurePreviewDigitalSegments(
  channel: number,
  startSample: number,
  endSample: number,
  sampleRateHz: number,
  data: PreviewDigitalData,
): DigitalRangeMeasurementStats {
  const durationSamples = Math.max(1, endSample - startSample);
  const highWidths = makePreviewSampleStats();
  const lowWidths = makePreviewSampleStats();
  const risingPeriods = makePreviewSampleStats();
  const fallingPeriods = makePreviewSampleStats();
  let highSamples = 0;
  let lastRising: number | null = null;
  let lastFalling: number | null = null;
  let firstSampleHigh = false;
  let lastSampleHigh = false;

  data.segments.forEach((segment, index) => {
    const width = Math.max(0, Math.min(endSample, segment.end_sample) - Math.max(startSample, segment.start_sample));
    if (index === 0) firstSampleHigh = segment.high;
    lastSampleHigh = segment.high;
    if (width <= 0) return;
    if (segment.high) {
      highSamples += width;
      pushPreviewSampleStats(highWidths, width);
    } else {
      pushPreviewSampleStats(lowWidths, width);
    }
  });

  data.rising_edges.forEach((edge) => {
    if (lastRising !== null) pushPreviewSampleStats(risingPeriods, edge - lastRising);
    lastRising = edge;
  });
  data.falling_edges.forEach((edge) => {
    if (lastFalling !== null) pushPreviewSampleStats(fallingPeriods, edge - lastFalling);
    lastFalling = edge;
  });

  const periodStats = risingPeriods.count > 0 ? risingPeriods : fallingPeriods;
  const avgPeriod = averagePreviewSampleStats(periodStats);
  const maxPeriod = periodStats.max;
  const minPeriod = periodStats.min;
  const lowSamples = Math.max(0, durationSamples - highSamples);

  return {
    channel,
    start_sample: startSample,
    end_sample: endSample,
    sample_rate_hz: sampleRateHz,
    duration_samples: durationSamples,
    high_samples: highSamples,
    low_samples: lowSamples,
    rising_edges: data.rising_edges.length,
    falling_edges: data.falling_edges.length,
    edge_count: data.rising_edges.length + data.falling_edges.length,
    high_width_count: highWidths.count,
    low_width_count: lowWidths.count,
    avg_high_width_samples: averagePreviewSampleStats(highWidths),
    avg_low_width_samples: averagePreviewSampleStats(lowWidths),
    cycle_count: periodStats.count,
    avg_period_samples: avgPeriod,
    min_period_samples: minPeriod,
    max_period_samples: maxPeriod,
    period_std_dev_samples: stdDevPreviewSampleStats(periodStats),
    avg_frequency_hz: avgPeriod && avgPeriod > 0 ? sampleRateHz / avgPeriod : null,
    min_frequency_hz: maxPeriod && maxPeriod > 0 ? sampleRateHz / maxPeriod : null,
    max_frequency_hz: minPeriod && minPeriod > 0 ? sampleRateHz / minPeriod : null,
    positive_duty: (highSamples / durationSamples) * 100,
    negative_duty: (lowSamples / durationSamples) * 100,
    first_sample_high: firstSampleHigh,
    last_sample_high: lastSampleHigh,
  };
}

function makePreviewSampleStats(): PreviewSampleStats {
  return { count: 0, max: null, min: null, sum: 0, sumSquares: 0 };
}

function pushPreviewSampleStats(stats: PreviewSampleStats, value: number) {
  if (!Number.isFinite(value) || value <= 0) return;
  stats.count += 1;
  stats.sum += value;
  stats.sumSquares += value * value;
  stats.min = stats.min === null ? value : Math.min(stats.min, value);
  stats.max = stats.max === null ? value : Math.max(stats.max, value);
}

function averagePreviewSampleStats(stats: PreviewSampleStats) {
  return stats.count > 0 ? stats.sum / stats.count : null;
}

function stdDevPreviewSampleStats(stats: PreviewSampleStats) {
  if (stats.count === 0) return null;
  const average = stats.sum / stats.count;
  return Math.sqrt(Math.max(0, stats.sumSquares / stats.count - average * average));
}

function buildPreviewExactDigitalData(
  startSample: number,
  endSample: number,
  pixels: number,
  channel: number,
  sampleRateHz: number,
): PreviewDigitalData {
  const exactLimit = Math.max(4096, pixels * 8);
  if (endSample <= startSample || endSample - startSample > exactLimit) {
    return { segments: [], rising_edges: [], falling_edges: [] };
  }
  return (
    buildPreviewDigitalSegments(startSample, endSample, channel, sampleRateHz, PREVIEW_EXACT_SEGMENT_LIMIT) ?? {
      segments: [],
      rising_edges: [],
      falling_edges: [],
    }
  );
}

function buildPreviewBins(
  startSample: number,
  sampleCount: number,
  pixels: number,
  channel: number,
  sampleRateHz: number,
): WaveformBin[] {
  const endSample = startSample + sampleCount;
  const segments = buildPreviewDigitalSegments(
    startSample,
    endSample,
    channel,
    sampleRateHz,
    PREVIEW_BIN_SEGMENT_LIMIT,
  );

  if (segments) {
    return summarizePreviewSegmentsToBins(
      segments.segments,
      startSample,
      sampleCount,
      pixels,
      (sample) => previewDigitalLevelAt(sample, channel, sampleRateHz),
    );
  }

  return summarizePreviewChannelBySampling(startSample, sampleCount, pixels, channel, sampleRateHz);
}

function buildPreviewDigitalSegments(
  startSample: number,
  endSample: number,
  channel: number,
  sampleRateHz: number,
  maxSegments: number,
): PreviewDigitalData | null {
  if (channel === 0) {
    return buildPreviewUartDigitalSegments(startSample, endSample, sampleRateHz, maxSegments);
  }
  if (channel === 1 || channel === 2) {
    return buildPreviewI2cDigitalSegments(startSample, endSample, channel, sampleRateHz, maxSegments);
  }
  if (channel >= 3 && channel <= 6) {
    return buildPreviewSpiDigitalSegments(startSample, endSample, channel, sampleRateHz, maxSegments);
  }
  return buildPreviewPulseDigitalSegments(startSample, endSample, channel, maxSegments);
}

function buildPreviewI2cDigitalSegments(
  startSample: number,
  endSample: number,
  channel: number,
  sampleRateHz: number,
  maxSegments: number,
): PreviewDigitalData | null {
  const halfPeriod = Math.max(2, Math.round(sampleRateHz / 200_000));
  return buildPreviewPeriodicDigitalSegments(
    startSample,
    endSample,
    halfPeriod,
    maxSegments,
    (sample) => previewI2cLevelAt(sample, channel, sampleRateHz),
  );
}

function buildPreviewSpiDigitalSegments(
  startSample: number,
  endSample: number,
  channel: number,
  sampleRateHz: number,
  maxSegments: number,
): PreviewDigitalData | null {
  const halfPeriod = Math.max(2, Math.round(sampleRateHz / 2_000_000));
  return buildPreviewPeriodicDigitalSegments(
    startSample,
    endSample,
    halfPeriod,
    maxSegments,
    (sample) => previewSpiLevelAt(sample, channel, sampleRateHz),
  );
}

function buildPreviewPeriodicDigitalSegments(
  startSample: number,
  endSample: number,
  halfPeriod: number,
  maxSegments: number,
  levelAt: (sample: number) => boolean,
): PreviewDigitalData | null {
  if (endSample <= startSample) return { segments: [], rising_edges: [], falling_edges: [] };
  const firstBoundary = (Math.floor(startSample / halfPeriod) + 1) * halfPeriod;
  const boundaryCount = Math.max(0, Math.ceil((endSample - firstBoundary) / halfPeriod));
  if (boundaryCount > maxSegments) return null;

  const segments: DigitalSegment[] = [];
  const rising_edges: number[] = [];
  const falling_edges: number[] = [];
  let previous = levelAt(startSample);
  let runStart = startSample;
  for (let boundary = firstBoundary; boundary < endSample; boundary += halfPeriod) {
    const current = levelAt(boundary);
    if (current === previous) continue;
    segments.push({ start_sample: runStart, end_sample: boundary, high: previous });
    (current ? rising_edges : falling_edges).push(boundary);
    if (segments.length > maxSegments) return null;
    runStart = boundary;
    previous = current;
  }
  segments.push({ start_sample: runStart, end_sample: endSample, high: previous });
  return { segments, rising_edges, falling_edges };
}

function previewI2cByte(frame: number) {
  return [0xa0, 0x2a, 0x55][positiveModulo(frame, 3)];
}

function previewI2cLevelAt(sample: number, channel: number, sampleRateHz: number) {
  const halfPeriod = Math.max(2, Math.round(sampleRateHz / 200_000));
  const phase = positiveModulo(Math.floor(sample / halfPeriod), 60);
  if (phase < 2) return true;
  if (phase === 2) return channel === 2;
  const dataPhase = phase - 3;
  if (dataPhase < 54) {
    const byteIndex = Math.floor(dataPhase / 18);
    const bitIndex = Math.floor((dataPhase % 18) / 2);
    const byte = previewI2cByte(byteIndex);
    if (channel === 2) return dataPhase % 2 === 1;
    return bitIndex === 8 ? false : (byte & (1 << (7 - bitIndex))) !== 0;
  }
  if (phase === 57) return false;
  if (phase === 58) return channel === 2;
  return true;
}

function previewSpiLevelAt(sample: number, channel: number, sampleRateHz: number) {
  const halfPeriod = Math.max(2, Math.round(sampleRateHz / 2_000_000));
  const phase = positiveModulo(Math.floor(sample / halfPeriod), 20);
  const active = phase >= 2 && phase < 18;
  if (channel === 6) return !active;
  if (channel === 5) return active && phase % 2 === 1;
  if (!active) return false;
  const bitIndex = Math.floor((phase - 2) / 2);
  const word = [0xa5, 0x3c, 0x5a, 0xf0][Math.floor(sample / (halfPeriod * 20)) % 4];
  const value = channel === 3 ? word : word ^ 0x99;
  return (value & (1 << (7 - bitIndex))) !== 0;
}

function buildPreviewUartDigitalSegments(
  startSample: number,
  endSample: number,
  sampleRateHz: number,
  maxSegments: number,
): PreviewDigitalData | null {
  const bitPeriod = sampleRateHz / PREVIEW_UART_BAUD;
  if (bitPeriod < 2) return buildPreviewPulseDigitalSegments(startSample, endSample, 0, maxSegments);
  const firstBit = Math.max(0, Math.floor(startSample / bitPeriod));
  const lastBit = Math.max(firstBit, Math.floor(Math.max(startSample, endSample - 1) / bitPeriod));
  if (lastBit - firstBit > maxSegments) return null;

  const segments: DigitalSegment[] = [];
  const rising_edges: number[] = [];
  const falling_edges: number[] = [];
  let previousHigh = previewUartLevelAtBit(firstBit);
  let runStart = startSample;

  for (let bit = firstBit; bit <= lastBit; bit += 1) {
    const high = previewUartLevelAtBit(bit);
    const bitStart = Math.max(startSample, Math.round(bit * bitPeriod));
    const bitEnd = Math.min(endSample, Math.round((bit + 1) * bitPeriod));
    if (bitEnd <= startSample || bitStart >= endSample) continue;

    if (high !== previousHigh && bitStart > runStart) {
      segments.push({ start_sample: runStart, end_sample: bitStart, high: previousHigh });
      if (high) {
        rising_edges.push(bitStart);
      } else {
        falling_edges.push(bitStart);
      }
      runStart = bitStart;
      previousHigh = high;
    }
  }

  if (endSample > runStart) {
    segments.push({ start_sample: runStart, end_sample: endSample, high: previousHigh });
  }
  return { segments, rising_edges, falling_edges };
}

function previewUartLevelAtBit(bitIndex: number) {
  const cycleBit = positiveModulo(bitIndex, PREVIEW_UART_CYCLE_BITS);
  if (cycleBit < PREVIEW_UART_LEAD_IDLE_BITS) return true;
  const messageBit = cycleBit - PREVIEW_UART_LEAD_IDLE_BITS;
  if (messageBit >= PREVIEW_UART_MESSAGE.length * 10) return true;

  const byte = PREVIEW_UART_MESSAGE[Math.floor(messageBit / 10)];
  const frameBit = messageBit % 10;
  if (frameBit === 0) return false;
  if (frameBit === 9) return true;
  return ((byte >> (frameBit - 1)) & 1) !== 0;
}

function buildPreviewPulseDigitalSegments(
  startSample: number,
  endSample: number,
  channel: number,
  maxSegments: number,
): PreviewDigitalData | null {
  const profile = previewPulseProfile(channel);
  const segments: DigitalSegment[] = [];
  const rising_edges: number[] = [];
  const falling_edges: number[] = [];
  let cycleStart = startSample - positiveModulo(startSample, profile.cycleSamples);
  let runIndex = runIndexAtCycleOffset(profile, startSample - cycleStart);

  while (cycleStart < endSample) {
    const runStart = cycleStart + profile.cumulative[runIndex];
    const runEnd = cycleStart + profile.cumulative[runIndex + 1];
    const visibleStart = Math.max(startSample, runStart);
    const visibleEnd = Math.min(endSample, runEnd);
    const high = runIndex % 2 === 1;
    if (visibleEnd > visibleStart) {
      segments.push({ start_sample: visibleStart, end_sample: visibleEnd, high });
      if (segments.length > maxSegments) return null;
    }

    if (runEnd > startSample && runEnd < endSample) {
      const nextHigh = (runIndex + 1) % 2 === 1;
      if (nextHigh) {
        rising_edges.push(runEnd);
      } else {
        falling_edges.push(runEnd);
      }
    }

    runIndex += 1;
    if (runIndex >= profile.runs.length) {
      runIndex = 0;
      cycleStart += profile.cycleSamples;
    }
  }

  return { segments, rising_edges, falling_edges };
}

function summarizePreviewSegmentsToBins(
  segments: DigitalSegment[],
  startSample: number,
  sampleCount: number,
  pixels: number,
  levelAt: (sample: number) => boolean,
): WaveformBin[] {
  const samplesPerPixel = sampleCount / pixels;
  const bins: WaveformBin[] = [];
  let segmentIndex = 0;

  for (let x = 0; x < pixels; x += 1) {
    const sample0 = startSample + x * samplesPerPixel;
    const sample1 = Math.min(startSample + sampleCount, sample0 + samplesPerPixel);
    while (segments[segmentIndex + 1] && segments[segmentIndex].end_sample <= sample0) {
      segmentIndex += 1;
    }

    const first = levelAt(sample0);
    const last = levelAt(Math.max(sample0, sample1 - Math.min(0.5, samplesPerPixel / 2)));
    let hasHigh = first || last;
    let hasLow = !first || !last;
    let edges = 0;
    let firstEdgeOffset: number | null = null;
    let lastEdgeOffset: number | null = null;

    for (let index = segmentIndex; index < segments.length; index += 1) {
      const segment = segments[index];
      if (segment.start_sample >= sample1) break;
      if (segment.end_sample <= sample0) continue;
      hasHigh ||= segment.high;
      hasLow ||= !segment.high;
      if (segment.start_sample > sample0 && segment.start_sample <= sample1) {
        edges += 1;
        const offset = Math.max(0, Math.round(segment.start_sample - sample0));
        firstEdgeOffset ??= offset;
        lastEdgeOffset = offset;
      }
    }

    bins.push({
      x,
      first,
      last,
      has_high: hasHigh,
      has_low: hasLow,
      edges,
      first_edge_offset: firstEdgeOffset,
      last_edge_offset: lastEdgeOffset,
    });
  }

  return bins;
}

function summarizePreviewChannelBySampling(
  startSample: number,
  sampleCount: number,
  pixels: number,
  channel: number,
  sampleRateHz: number,
): WaveformBin[] {
  const samplesPerPixel = sampleCount / pixels;
  const bitPeriod = sampleRateHz / PREVIEW_UART_BAUD;
  return Array.from({ length: pixels }, (_, x) => {
    const sample0 = startSample + x * samplesPerPixel;
    const sample1 = sample0 + samplesPerPixel;
    const first = previewDigitalLevelAt(sample0, channel, sampleRateHz);
    const last = previewDigitalLevelAt(Math.max(sample0, sample1 - Math.min(0.5, samplesPerPixel / 2)), channel, sampleRateHz);
    let hasHigh = first || last;
    let hasLow = !first || !last;
    let edges = 0;
    let firstEdgeOffset: number | null = null;
    let lastEdgeOffset: number | null = null;

    if (channel === 0 && bitPeriod >= 2) {
      const firstBoundary = Math.floor(sample0 / bitPeriod) + 1;
      const lastBoundary = Math.floor(sample1 / bitPeriod);
      if (lastBoundary - firstBoundary > 32) {
        hasHigh = true;
        hasLow = true;
        edges = 2;
      } else {
        for (let boundary = firstBoundary; boundary <= lastBoundary; boundary += 1) {
          const previous = previewUartLevelAtBit(boundary - 1);
          const next = previewUartLevelAtBit(boundary);
          hasHigh ||= previous || next;
          hasLow ||= !previous || !next;
          if (previous !== next) {
            edges += 1;
            const offset = Math.max(0, Math.round(boundary * bitPeriod - sample0));
            firstEdgeOffset ??= offset;
            lastEdgeOffset = offset;
          }
        }
      }
    }

    return {
      x,
      first,
      last,
      has_high: hasHigh,
      has_low: hasLow,
      edges,
      first_edge_offset: firstEdgeOffset,
      last_edge_offset: lastEdgeOffset,
    };
  });
}

function previewDigitalLevelAt(sample: number, channel: number, sampleRateHz: number) {
  if (channel === 0) {
    const bitPeriod = sampleRateHz / PREVIEW_UART_BAUD;
    if (bitPeriod >= 2) return previewUartLevelAtBit(Math.floor(sample / bitPeriod));
  }

  if (channel === 1 || channel === 2) return previewI2cLevelAt(sample, channel, sampleRateHz);
  if (channel >= 3 && channel <= 6) return previewSpiLevelAt(sample, channel, sampleRateHz);

  const profile = previewPulseProfile(channel);
  const offset = positiveModulo(Math.floor(sample), profile.cycleSamples);
  return runIndexAtCycleOffset(profile, offset) % 2 === 1;
}

interface PreviewPulseProfile {
  cumulative: number[];
  cycleSamples: number;
  runs: number[];
}

const previewPulseProfileCache = new Map<number, PreviewPulseProfile>();

function previewPulseProfile(channel: number): PreviewPulseProfile {
  const cached = previewPulseProfileCache.get(channel);
  if (cached) return cached;

  let random = (0x6d2b79f5 ^ Math.imul(channel, 0x9e3779b9)) >>> 0;
  const runs = Array.from({ length: 256 }, () => {
    random = (Math.imul(random, 1_664_525) + 1_013_904_223) >>> 0;
    return 1 + ((random >>> 17) & 0x7fff);
  });
  const cumulative = [0];
  runs.forEach((run) => cumulative.push(cumulative[cumulative.length - 1] + run));
  const profile = { cumulative, cycleSamples: cumulative[cumulative.length - 1], runs };
  previewPulseProfileCache.set(channel, profile);
  return profile;
}

function runIndexAtCycleOffset(profile: PreviewPulseProfile, offset: number) {
  let low = 0;
  let high = profile.runs.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (offset < profile.cumulative[mid]) {
      high = mid - 1;
    } else if (offset >= profile.cumulative[mid + 1]) {
      low = mid + 1;
    } else {
      return mid;
    }
  }
  return 0;
}

function positiveModulo(value: number, modulo: number) {
  return ((value % modulo) + modulo) % modulo;
}
