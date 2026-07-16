import { invoke } from "@tauri-apps/api/core";

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
  start_sample: number;
  end_sample: number;
  label: string;
  value: number;
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

export function startCapture(settings: CaptureSettings): Promise<CaptureSummary> {
  if (!isTauriRuntime()) {
    const sampleCount = Math.max(1, Math.round((settings.sample_rate_hz * settings.duration_ms) / 1000));
    previewCapture = {
      metadata: {
        version: 1,
        source_device: settings.device_id,
        sample_rate_hz: settings.sample_rate_hz,
        channel_count: settings.channel_count,
        unitsize: settings.channel_count > 16 ? 4 : 2,
        sample_count: sampleCount,
        captured_at: new Date().toISOString(),
        labels: Array.from({ length: settings.channel_count }, (_, index) => `D${index}`),
      },
      bytes: sampleCount * (settings.channel_count > 16 ? 4 : 2),
    };
    return new Promise((resolve) => window.setTimeout(() => resolve(previewCapture), 280));
  }
  return callBackend("start_capture", { settings });
}

export function cancelCapture(): Promise<void> {
  if (!isTauriRuntime()) return Promise.resolve();
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
    return Promise.resolve(
      Array.from({ length: 18 }, (_, index) => ({
        start_sample: 900 + index * 7_200,
        end_sample: 900 + index * 7_200 + 1_400,
        label: `0x${((index * 29 + settings.channel) & 0xff).toString(16).padStart(2, "0").toUpperCase()}`,
        value: (index * 29 + settings.channel) & 0xff,
      })),
    );
  }
  return callBackend("decode_uart_frames", { settings });
}

function buildPreviewTile(request: WaveformRequest): WaveformTile {
  const metadata = previewCapture.metadata;
  const sampleCount = Math.max(1, request.sample_count);
  const pixels = Math.max(1, Math.min(Math.ceil(sampleCount), request.pixels));
  const samplesPerPixel = sampleCount / pixels;
  const channels = request.channels.length
    ? request.channels.filter((channel) => channel < metadata.channel_count)
    : Array.from({ length: metadata.channel_count }, (_, index) => index);

  return {
    start_sample: request.start_sample,
    sample_count: sampleCount,
    pixels,
    samples_per_pixel: samplesPerPixel,
    channels: channels.map((channel) => {
      const period = 24 + channel * 11;
      const phase = channel * 7;
      const exact = buildPreviewExactDigitalData(request.start_sample, sampleCount, period, phase);
      return {
        channel,
        label: metadata.labels[channel] ?? `D${channel}`,
        segments: exact.segments,
        rising_edges: exact.rising_edges,
        falling_edges: exact.falling_edges,
        bins: Array.from({ length: pixels }, (_, x) => {
          const sample0 = request.start_sample + x * samplesPerPixel;
          const sample1 = sample0 + samplesPerPixel;
          const first = Math.floor((sample0 + phase) / period) % 2 === 0;
          const last = Math.floor((sample1 + phase) / period) % 2 === 0;
          const firstEdge = nextPreviewEdge(sample0, period, phase);
          const lastEdge = previousPreviewEdge(sample1, period, phase);
          const hasEdge = firstEdge !== null && firstEdge > sample0 && firstEdge <= sample1;
          const multiEdge = firstEdge !== null && lastEdge !== null && lastEdge > firstEdge;
          return {
            x,
            first,
            last,
            has_high: first || last || hasEdge || multiEdge,
            has_low: !first || !last || hasEdge || multiEdge,
            edges: multiEdge ? 2 : hasEdge ? 1 : 0,
            first_edge_offset: hasEdge ? Math.max(0, Math.round(firstEdge - sample0)) : null,
            last_edge_offset: multiEdge ? Math.max(0, Math.round(lastEdge - sample0)) : hasEdge ? Math.max(0, Math.round(firstEdge - sample0)) : null,
          };
        }),
      };
    }),
  };
}

function buildPreviewExactDigitalData(startSample: number, sampleCount: number, period: number, phase: number) {
  const endSample = startSample + sampleCount;
  const segments: DigitalSegment[] = [];
  const rising_edges: number[] = [];
  const falling_edges: number[] = [];
  let cursor = startSample;
  let high = previewStateAt(cursor, period, phase);

  while (cursor < endSample) {
    const edge = nextPreviewEdge(cursor, period, phase);
    const segmentEnd = edge == null ? endSample : Math.min(endSample, edge);
    if (segmentEnd > cursor) {
      segments.push({ start_sample: cursor, end_sample: segmentEnd, high });
    }
    if (edge == null || edge >= endSample) break;
    high = !high;
    if (high) {
      rising_edges.push(edge);
    } else {
      falling_edges.push(edge);
    }
    cursor = edge;
  }

  return { segments, rising_edges, falling_edges };
}

function previewStateAt(sample: number, period: number, phase: number) {
  return Math.floor((sample + phase) / period) % 2 === 0;
}

function nextPreviewEdge(sample: number, period: number, phase: number) {
  const nextBoundary = (Math.floor((sample + phase) / period) + 1) * period - phase;
  return Number.isFinite(nextBoundary) ? nextBoundary : null;
}

function previousPreviewEdge(sample: number, period: number, phase: number) {
  const previousBoundary = Math.floor((sample + phase) / period) * period - phase;
  return Number.isFinite(previousBoundary) ? previousBoundary : null;
}
