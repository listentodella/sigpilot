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

export interface DecodedFrame {
  frame_id: number;
  start_sample: number;
  end_sample: number;
  label: string;
  value: number;
}

export interface UartFrameWindowRequest extends UartDecodeSettings {
  start_sample: number;
  sample_count: number;
  width_px: number;
}

export interface UartFrameWindow {
  frames: DecodedFrame[];
  previous_frame: DecodedFrame | null;
  next_frame: DecodedFrame | null;
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

// Ported from Logic 2.4.43 BaseAnalyzerManager.maximumMarkerResults.
const PREVIEW_MAX_ANALYZER_MARKER_RESULTS = 300;
const PREVIEW_CAPTURE_UPDATE_MS = 33;

async function callBackend<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauriRuntime()) {
    throw new Error("Tauri runtime is not available");
  }
  return invoke<T>(command, args);
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
  return callBackend("start_capture", { settings });
}

export function cancelCapture(): Promise<void> {
  if (!isTauriRuntime()) {
    if (previewCaptureRun) previewCaptureRun.cancelled = true;
    return Promise.resolve();
  }
  return callBackend("cancel_capture");
}

export function openCapture(path: string): Promise<CaptureSummary> {
  if (!isTauriRuntime()) return Promise.resolve(previewCapture);
  return callBackend("open_capture", { path });
}

export function saveCapture(path: string): Promise<void> {
  if (!isTauriRuntime()) return Promise.resolve();
  return callBackend("save_capture", { path });
}

export function exportCapture(path: string, format: ExportFormat): Promise<void> {
  if (!isTauriRuntime()) return Promise.resolve();
  return callBackend("export_capture", { path, format });
}

export function getWaveformTile(request: WaveformRequest): Promise<WaveformTile> {
  if (!isTauriRuntime()) return Promise.resolve(buildPreviewTile(request));
  return callBackend("get_waveform_tile", { request });
}

export function decodeUartFrames(settings: UartDecodeSettings): Promise<DecodedFrame[]> {
  if (!isTauriRuntime()) {
    return Promise.resolve(buildPreviewUartFrames(settings));
  }
  return callBackend("decode_uart_frames", { settings });
}

export async function getUartFrameWindow(request: UartFrameWindowRequest): Promise<UartFrameWindow> {
  if (!isTauriRuntime()) {
    return Promise.resolve(buildPreviewUartFrameWindow(request));
  }
  const frames = await callBackend<DecodedFrame[]>("decode_uart_frames", {
    settings: {
      channel: request.channel,
      baud_rate: request.baud_rate,
      inverted: request.inverted,
    },
  });
  return buildFrameWindowFromFrames(frames, request.start_sample, request.sample_count);
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
    return { frames: [], previous_frame: null, next_frame: null };
  }
  const metadata = previewCapture.metadata;
  const bitPeriod = metadata.sample_rate_hz / request.baud_rate;
  if (bitPeriod < 2) return { frames: [], previous_frame: null, next_frame: null };

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
        if (frames.length >= PREVIEW_MAX_ANALYZER_MARKER_RESULTS) {
          nextFrame ??= frame;
          return {
            frames,
            previous_frame: previousFrame,
            next_frame: nextFrame,
          };
        }
        frames.push(frame);
      }
    }
  }
  return {
    frames,
    previous_frame: previousFrame,
    next_frame: nextFrame,
  };
}

function buildFrameWindowFromFrames(
  frames: DecodedFrame[],
  startSample: number,
  sampleCount: number,
): UartFrameWindow {
  const endSample = startSample + sampleCount;
  const normalized = frames.map((frame, index) => ({
    ...frame,
    frame_id: frame.frame_id ?? index,
  }));
  const visible = normalized.filter((frame) => frame.end_sample >= startSample && frame.start_sample <= endSample);
  const limited = visible.slice(0, PREVIEW_MAX_ANALYZER_MARKER_RESULTS);
  return {
    frames: limited,
    previous_frame: [...normalized].reverse().find((frame) => frame.end_sample < startSample) ?? null,
    next_frame:
      visible.length > PREVIEW_MAX_ANALYZER_MARKER_RESULTS
        ? visible[PREVIEW_MAX_ANALYZER_MARKER_RESULTS]
        : normalized.find((frame) => frame.start_sample > endSample) ?? null,
  };
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
  };
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

const PREVIEW_EXACT_SEGMENT_LIMIT = 12_000;
const PREVIEW_BIN_SEGMENT_LIMIT = 180_000;
const PREVIEW_UART_BAUD = 115_200;

function buildPreviewExactDigitalData(
  startSample: number,
  endSample: number,
  pixels: number,
  channel: number,
  sampleRateHz: number,
): PreviewDigitalData {
  const exactLimit = Math.max(4096, pixels * 96);
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
  return buildPreviewPulseDigitalSegments(startSample, endSample, channel, maxSegments);
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
