import resetUrl from "../../resources/bitstreams/hspi_ddr_RST.bin?url";
import mainUrl from "../../resources/bitstreams/hspi_ddr.bin?url";
import { savePxcap, tileFor } from "./waveform";
import type { Capture, CaptureProfile } from "./model";
import type { CaptureCallbacks, CaptureSettings, CaptureSummary, HardwareCaptureCapabilities, DeviceInfo, WaveformRequest, WaveformTile, NearestDigitalTransition, DigitalPointMeasurement, DigitalRangeMeasurementStats } from "../lib/api";
import { filters, identify, sameDevice, usbBus, type UsbDevice } from "./usb";
import type { Reply, Request } from "./model";

let runtimeEnabled = false;
export const WEBUSB_DEMO_DEVICE_ID = "fake:sigpilot-demo";

export function enableWebUsbRuntime() {
  runtimeEnabled = true;
}

export function webUsbAvailable() {
  return runtimeEnabled && typeof window !== "undefined";
}

function deviceId(device: UsbDevice) {
  const serial = device.serialNumber?.trim() || "anonymous";
  return `webusb:${device.vendorId.toString(16)}:${device.productId.toString(16)}:${serial}`;
}

function toDeviceInfo(device: UsbDevice): DeviceInfo {
  return {
    id: deviceId(device),
    kind: "Usb",
    vid: device.vendorId,
    pid: device.productId,
    bus: null,
    address: null,
    label: device.productName || `PXLogic ${device.vendorId.toString(16)}:${device.productId.toString(16)}`,
    ready: true,
    manufacturer: device.manufacturerName ?? null,
    product: device.productName ?? null,
    serial_number: device.serialNumber ?? null,
    usb_speed: null,
    logic_mode: null,
    profile_model: device.productName ?? "PXLogic WebUSB",
    probe_error: null,
  };
}

export function isWebUsbDemoDevice(id: string) {
  return id === WEBUSB_DEMO_DEVICE_ID;
}

export function webUsbDemoDeviceInfo(): DeviceInfo {
  return {
    id: WEBUSB_DEMO_DEVICE_ID,
    kind: "Fake",
    vid: 0x1209,
    pid: 0x7100,
    bus: null,
    address: null,
    label: "SigPilot Preview Device",
    ready: true,
    manufacturer: "SigPilot",
    product: "Preview Device",
    serial_number: null,
    usb_speed: null,
    logic_mode: null,
    profile_model: "SigPilot Preview Device",
    probe_error: null,
  };
}

interface PendingCapture {
  resolve: (capture: Capture) => void;
  reject: (error: unknown) => void;
}

let worker: Worker | null = null;
let connectedDevice: UsbDevice | null = null;
let profile: CaptureProfile | null = null;
let pendingCapture: PendingCapture | null = null;
let pendingConnect: { resolve: (profile: CaptureProfile) => void; reject: (error: unknown) => void } | null = null;
const captures = new Map<string, Capture>();
const captureDeviceIds = new Map<string, string>();

function lowerBound(values: Uint32Array, target: number) {
  let low = 0, high = values.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (values[mid] < target) low = mid + 1;
    else high = mid;
  }
  return low;
}

function post(request: Request) {
  worker?.postMessage(request);
}

function stopWorker() {
  worker?.terminate();
  worker = null;
  connectedDevice = null;
  profile = null;
  pendingCapture = null;
  pendingConnect = null;
}

function ensureWorker() {
  if (worker) return worker;
  const next = new Worker(new URL("./device.worker.ts", import.meta.url), { type: "module" });
  worker = next;
  next.onerror = (event) => {
    const error = new Error(event.message || "WebUSB worker failed");
    pendingCapture?.reject(error);
    pendingConnect?.reject(error);
    stopWorker();
  };
  next.onmessage = (event: MessageEvent<Reply>) => {
    const reply = event.data;
    if (reply.kind === "status") return;
    if (reply.kind === "ready") {
      profile = { channels: reply.channels, model: reply.model, bufferModes: reply.bufferModes };
      pendingConnect?.resolve(profile);
      pendingConnect = null;
      return;
    }
    if (reply.kind === "boot") {
      const error = new Error("设备处于 CH569 引导模式，请先使用 WebUSB 固件更新入口。");
      pendingConnect?.reject(error);
      pendingConnect = null;
      stopWorker();
      return;
    }
    if (reply.kind === "capture") {
      const pending = pendingCapture;
      pendingCapture = null;
      pending?.resolve(reply.capture);
      return;
    }
    if (reply.kind === "closed") {
      const error = new Error(reply.message);
      pendingCapture?.reject(error);
      pendingConnect?.reject(error);
      pendingCapture = null;
      pendingConnect = null;
      stopWorker();
    }
  };
  return next;
}

async function authorizedDevice(id: string) {
  const devices = await usbBus()?.getDevices() ?? [];
  const match = devices.find((device) => deviceId(device) === id);
  if (!match) throw new Error("设备尚未授权，请点击连接 WebUSB 并在浏览器对话框中选择设备。");
  return match;
}

export async function listWebUsbDevices(): Promise<DeviceInfo[]> {
  const bus = usbBus();
  const physical = !webUsbAvailable() || !window.isSecureContext || !bus
    ? []
    : (await bus.getDevices())
      .filter((device) => filters.some((filter) => filter.vendorId === device.vendorId && filter.productId === device.productId))
      .map(toDeviceInfo);
  return [...physical, webUsbDemoDeviceInfo()];
}

export async function requestWebUsbDevice() {
  const bus = usbBus();
  if (!webUsbAvailable() || !window.isSecureContext || !bus) throw new Error("当前浏览器未提供 WebUSB，请使用 Chrome 或 Edge 并通过 HTTPS 或 localhost 打开。");
  const device = await bus.requestDevice({ filters });
  await connectWebUsbDevice(device);
  return toDeviceInfo(device);
}

export async function connectWebUsbDevice(device?: UsbDevice) {
  const next = device ?? (await authorizedDevice((await listWebUsbDevices())[0]?.id ?? ""));
  if (connectedDevice && sameDevice(connectedDevice, next) && profile) return profile;
  stopWorker();
  ensureWorker();
  connectedDevice = next;
  const connected = new Promise<CaptureProfile>((resolve, reject) => {
    pendingConnect = { resolve, reject };
  });
  post({
    kind: "connect",
    device: identify(next),
    files: [resetUrl, mainUrl].map((url) => new URL(url, document.baseURI).href),
  });
  return connected;
}

export async function webUsbCapabilities(deviceIdValue: string): Promise<HardwareCaptureCapabilities> {
  const current = await authorizedDevice(deviceIdValue);
  const next = await connectWebUsbDevice(current);
  const modes = next.bufferModes.map((mode, index) => ({
    id: `WEBUSB_BUFFER_${mode.channels}_${index}`,
    stream: false,
    channels: mode.channels,
    default_sample_rate_hz: Math.min(25_000_000, mode.maxRate),
    default_sample_limit: 262_144,
    min_sample_rate_hz: mode.minRate,
    max_sample_rate_hz: mode.maxRate,
    sample_rates: [100_000, 500_000, 1_000_000, 5_000_000, 10_000_000, 25_000_000, 50_000_000, 100_000_000].filter((rate) => rate >= mode.minRate && rate <= mode.maxRate),
    description: `WebUSB buffer · ${mode.channels} channels`,
  }));
  return {
    device_id: deviceIdValue,
    profile_vendor: "PX",
    profile_model: next.model,
    usb_speed: null,
    logic_mode: null,
    max_channels: next.channels,
    max_analog_channels: 0,
    analog_sample_rates: [],
    default_channel_count: Math.min(8, next.channels),
    default_sample_rate_hz: modes[0]?.default_sample_rate_hz ?? 25_000_000,
    sample_rates: Array.from(new Set(modes.flatMap((mode) => mode.sample_rates))).sort((a, b) => a - b),
    threshold_volts: [1.8, 2, 2.5, 3.3, 5],
    channel_modes: modes,
  };
}

export async function prepareWebUsbDevice(deviceIdValue: string) {
  await connectWebUsbDevice(await authorizedDevice(deviceIdValue));
}

function captureSettings(settings: CaptureSettings, profileValue: CaptureProfile) {
  const supportedChannels = [4, 8, 16, 32].filter((count) => count <= profileValue.channels);
  const channels = supportedChannels.find((count) => count >= settings.channel_count) ?? supportedChannels[supportedChannels.length - 1] ?? 4;
  const depths = [1024, 16_384, 65_536, 262_144];
  const desired = Math.max(1, Math.round(settings.sample_rate_hz * Math.max(0.001, settings.duration_ms) / 1000));
  const count = depths.reduce((best, value) => Math.abs(value - desired) < Math.abs(best - desired) ? value : best, depths[0]);
  const mode = profileValue.bufferModes.filter((value) => value.channels >= channels).sort((a, b) => a.channels - b.channels || a.maxRate - b.maxRate)[0];
  const rate = Math.max(mode?.minRate ?? 100_000, Math.min(mode?.maxRate ?? settings.sample_rate_hz, settings.sample_rate_hz));
  return { channels, rate, count, threshold: settings.threshold_volts };
}

export async function startWebUsbCapture(sessionId: string, settings: CaptureSettings, callbacks: CaptureCallbacks = {}): Promise<CaptureSummary> {
  const current = profile ?? await connectWebUsbDevice();
  if (pendingCapture) throw new Error("已有 WebUSB 采集正在进行。");
  const converted = captureSettings(settings, current);
  const run = new Promise<Capture>((resolve, reject) => { pendingCapture = { resolve, reject }; });
  post({ kind: "capture", settings: converted });
  const capture = await run;
  captures.set(sessionId, capture);
  captureDeviceIds.set(sessionId, settings.device_id);
  const summary: CaptureSummary = {
    metadata: {
      version: 1,
      source_device: settings.device_id,
      sample_rate_hz: capture.rate,
      channel_count: capture.channels,
      enabled_channels: Array.from({ length: capture.channels }, (_, index) => index),
      unitsize: Math.ceil(capture.channels / 8),
      sample_count: capture.count,
      captured_at: capture.date,
      labels: Array.from({ length: capture.channels }, (_, index) => `D${index}`),
    },
    bytes: capture.samples.byteLength,
  };
  callbacks.onProgress?.({ bytes_read: summary.bytes, bytes_expected: summary.bytes, samples_read: capture.count, sample_memory_bytes: summary.bytes });
  callbacks.onSummary?.(summary);
  return summary;
}

export async function startWebUsbDemoCapture(
  sessionId: string,
  settings: CaptureSettings,
  callbacks: CaptureCallbacks = {},
): Promise<CaptureSummary> {
  const channels = Math.max(1, Math.min(32, settings.channel_count));
  const unitsize = Math.ceil(channels / 8);
  const depths = [1024, 16_384, 65_536, 262_144];
  const requested = Math.max(1, Math.round(settings.sample_rate_hz * Math.max(0.001, settings.duration_ms) / 1000));
  const count = depths.reduce((best, value) => Math.abs(value - requested) < Math.abs(best - requested) ? value : best, depths[0]);
  const samples = new Uint8Array(count * unitsize);
  const edgesByChannel = Array.from({ length: channels }, () => [] as number[]);
  const previous = new Uint8Array(channels);
  for (let sample = 0; sample < count; sample++) {
    for (let channel = 0; channel < channels; channel++) {
      const period = 32 * (2 ** Math.min(channel, 8));
      const high = Math.floor(sample / period) % 2 === 1;
      if (high) samples[sample * unitsize + (channel >>> 3)] |= 1 << (channel & 7);
      if (sample > 0 && Number(high) !== previous[channel]) edgesByChannel[channel].push(sample);
      previous[channel] = Number(high);
    }
  }
  const capture: Capture = {
    channels,
    rate: settings.sample_rate_hz,
    count,
    threshold: settings.threshold_volts,
    samples,
    edges: edgesByChannel.map((edges) => Uint32Array.from(edges)),
    model: "SigPilot Preview Device",
    date: new Date().toISOString(),
  };
  captures.set(sessionId, capture);
  captureDeviceIds.set(sessionId, WEBUSB_DEMO_DEVICE_ID);
  const summary: CaptureSummary = {
    metadata: {
      version: 1,
      source_device: WEBUSB_DEMO_DEVICE_ID,
      sample_rate_hz: capture.rate,
      channel_count: capture.channels,
      enabled_channels: Array.from({ length: capture.channels }, (_, index) => index),
      unitsize,
      sample_count: capture.count,
      captured_at: capture.date,
      labels: Array.from({ length: capture.channels }, (_, index) => `D${index}`),
    },
    bytes: capture.samples.byteLength,
  };
  callbacks.onProgress?.({ bytes_read: summary.bytes, bytes_expected: summary.bytes, samples_read: capture.count, sample_memory_bytes: summary.bytes });
  callbacks.onSummary?.(summary);
  return summary;
}

export function webUsbCaptureForSession(sessionId: string) {
  return captures.get(sessionId) ?? null;
}

export function releaseWebUsbCapture(sessionId: string) {
  captures.delete(sessionId);
  captureDeviceIds.delete(sessionId);
}

export function webUsbDeviceIdForSession(sessionId: string) {
  return captureDeviceIds.get(sessionId) ?? `webusb:${profile?.model ?? "PXLogic"}`;
}

export function webUsbTile(sessionId: string, request: WaveformRequest): WaveformTile {
  const capture = captures.get(sessionId);
  if (!capture) throw new Error("此会话没有 WebUSB 采集数据。");
  const tile = tileFor(capture, request.start_sample, request.sample_count, request.pixels);
  const channels = request.channels.length ? new Set(request.channels) : null;
  return channels ? { ...tile, channels: tile.channels.filter((channel) => channels.has(channel.channel)) } : tile;
}

export function webUsbNearestTransition(sessionId: string, channel: number, sample: number): NearestDigitalTransition | null {
  const capture = captures.get(sessionId);
  const edges = capture?.edges[channel];
  if (!capture || !edges) return null;
  let low = 0, high = edges.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (edges[mid] < sample) low = mid + 1;
    else high = mid;
  }
  if (!edges.length) return null;
  const before = Math.max(0, low - 1);
  const after = Math.min(edges.length - 1, low);
  const index = Math.abs(edges[before] - sample) <= Math.abs(edges[after] - sample) ? before : after;
  return { previous_sample: edges[index - 1] ?? null, sample: edges[index], next_sample: edges[index + 1] ?? null };
}

export function webUsbMeasurePoint(sessionId: string, channel: number, sample: number): DigitalPointMeasurement | null {
  const capture = captures.get(sessionId);
  const edges = capture?.edges[channel];
  if (!capture || !edges || channel < 0 || channel >= capture.channels || capture.count < 1) return null;
  const cursor = Math.max(0, Math.min(capture.count - 1, Math.round(sample)));
  let low = 0, high = edges.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (edges[mid] <= cursor) low = mid + 1;
    else high = mid;
  }
  const start = low > 0 ? edges[low - 1] : 0;
  const end = edges[low] ?? capture.count - 1;
  const periodEnd = edges[low + 1] ?? null;
  const byte = capture.samples[cursor * Math.ceil(capture.channels / 8) + (channel >>> 3)];
  return { channel, cursor_sample: cursor, high: Boolean(byte & (1 << (channel & 7))), width_start_sample: start, width_end_sample: end, period_end_sample: periodEnd };
}

export function webUsbMeasureRange(sessionId: string, channel: number, startValue: number, endValue: number): DigitalRangeMeasurementStats {
  const capture = captures.get(sessionId);
  if (!capture || channel < 0 || channel >= capture.channels) throw new Error("invalid digital range channel");
  const start = Math.max(0, Math.min(capture.count - 1, Math.round(Math.min(startValue, endValue))));
  const end = Math.max(start + 1, Math.min(capture.count, Math.round(Math.max(startValue, endValue))));
  const edges = capture.edges[channel];
  const edgeStart = lowerBound(edges, start + 1);
  const edgeEnd = lowerBound(edges, end);
  const relevant = Array.from(edges.slice(edgeStart, edgeEnd));
  const sampleHigh = (n: number) => Boolean(capture.samples[n * Math.ceil(capture.channels / 8) + (channel >>> 3)] & (1 << (channel & 7)));
  const firstHigh = sampleHigh(start), lastHigh = sampleHigh(end - 1);
  const boundaryStart = start > 0 && sampleHigh(start - 1) !== firstHigh;
  const rising = relevant.filter((edge) => sampleHigh(edge)).length + (boundaryStart && firstHigh ? 1 : 0);
  const falling = relevant.length - relevant.filter((edge) => sampleHigh(edge)).length + (boundaryStart && !firstHigh ? 1 : 0);
  let highSamples = 0;
  for (let n = start; n < end; n++) if (sampleHigh(n)) highSamples++;
  const lowSamples = end - start - highSamples;
  const positions = [start, ...relevant, end];
  const highWidths: number[] = [], lowWidths: number[] = [];
  for (let index = 0; index + 1 < positions.length; index++) {
    const width = positions[index + 1] - positions[index];
    (index % 2 === 0 ? (firstHigh ? highWidths : lowWidths) : (firstHigh ? lowWidths : highWidths)).push(width);
  }
  const periodEdges = [...(start > 0 ? [edges[Math.max(0, lowerBound(edges, start) - 1)]].filter((edge) => edge != null) : []), ...relevant];
  const periods: number[] = [];
  for (let index = 2; index < periodEdges.length; index++) periods.push(periodEdges[index] - periodEdges[index - 2]);
  const avg = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  const avgPeriod = avg(periods);
  const sampleRate = capture.rate;
  const sortedPeriods = [...periods].sort((a, b) => a - b);
  const variance = avgPeriod == null ? null : avg(periods.map((value) => (value - avgPeriod) ** 2));
  const duration = end - start;
  return {
    channel, start_sample: start, end_sample: end, sample_rate_hz: sampleRate,
    duration_samples: duration, high_samples: highSamples, low_samples: lowSamples,
    rising_edges: rising, falling_edges: falling, edge_count: rising + falling,
    high_width_count: highWidths.length,
    low_width_count: lowWidths.length,
    avg_high_width_samples: avg(highWidths),
    avg_low_width_samples: avg(lowWidths),
    cycle_count: periods.length, avg_period_samples: avgPeriod,
    min_period_samples: sortedPeriods[0] ?? null, max_period_samples: sortedPeriods[sortedPeriods.length - 1] ?? null,
    period_std_dev_samples: variance == null ? null : Math.sqrt(variance),
    avg_frequency_hz: avgPeriod && avgPeriod > 0 ? sampleRate / avgPeriod : null,
    min_frequency_hz: sortedPeriods.length ? sampleRate / sortedPeriods[sortedPeriods.length - 1] : null,
    max_frequency_hz: sortedPeriods.length ? sampleRate / sortedPeriods[0] : null,
    positive_duty: duration ? highSamples / duration : null,
    negative_duty: duration ? lowSamples / duration : null,
    first_sample_high: firstHigh, last_sample_high: lastHigh,
  };
}

export function cancelWebUsbCapture() {
  post({ kind: "close" });
}

export function disconnectWebUsb() {
  if (worker) post({ kind: "close" });
}

export function saveWebUsbCapture(sessionId: string) {
  const capture = captures.get(sessionId);
  if (!capture) throw new Error("没有可保存的 WebUSB 采集。");
  savePxcap(capture);
}
