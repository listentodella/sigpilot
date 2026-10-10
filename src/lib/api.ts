import { invoke } from "@tauri-apps/api/core";
import {
  normalizeCaptureViewport,
  normalizeLiveCaptureViewport,
} from "./captureViewport.ts";
import {
  DEFAULT_CAPTURE_VIEW_SECONDS,
  MINIMUM_DEFAULT_CAPTURE_VIEW_SAMPLES,
} from "./liveViewport.ts";
import type {
  UiExtensionFeatureType,
  UiExtensionManifest,
  UiExtensionPackage,
  UiExtensionTemplateRequest,
} from "./extensions.ts";

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
  manufacturer?: string | null;
  product?: string | null;
  serial_number?: string | null;
  usb_speed?: string | null;
  logic_mode?: number | null;
  profile_model?: string | null;
  probe_error?: string | null;
}

export interface HardwareChannelModeInfo {
  id: string;
  stream: boolean;
  channels: number;
  default_sample_rate_hz: number;
  default_sample_limit: number;
  min_sample_rate_hz: number;
  max_sample_rate_hz: number;
  sample_rates: number[];
  description: string;
}

export interface HardwareCaptureCapabilities {
  device_id: string;
  profile_vendor?: string | null;
  profile_model?: string | null;
  usb_speed?: string | null;
  logic_mode?: number | null;
  max_channels: number;
  default_channel_count: number;
  default_sample_rate_hz: number;
  sample_rates: number[];
  threshold_volts: number[];
  channel_modes: HardwareChannelModeInfo[];
}

export interface CaptureSettings {
  device_id: string;
  sample_rate_hz: number;
  channel_count: number;
  enabled_channels: number[];
  duration_ms: number;
  buffer_size_mb: number;
  decode_cross: boolean;
  threshold_volts: number;
  external_trigger_mode: ExternalTriggerMode;
  mode: CaptureMode;
  trigger_enabled: boolean;
  trigger_channel: number;
  trigger_kind: CaptureTriggerKind;
  trigger_high_mask: number;
  trigger_low_mask: number;
  trigger_position_percent: number;
  glitch_filter_enabled: boolean;
  clock_edge: boolean;
  trigger_out_enabled: boolean;
}

export interface PwmSettings {
  enabled: boolean;
  frequency_hz: number;
  duty_percent: number;
}

export interface PwmConfiguration {
  enabled: boolean;
  requested_frequency_hz: number;
  requested_duty_percent: number;
  effective_frequency_hz: number;
  effective_duty_percent: number;
  period_ticks: number;
  high_ticks: number;
}

export type CaptureMode = "Buffer" | "Stream";
export type CaptureTriggerKind = "Rising" | "Falling" | "High" | "Low";
export type ExternalTriggerMode = "Close" | "Rising" | "One" | "Falling" | "Zero" | "Edge";

export interface CaptureTriggerMetadata {
  sample_index: number;
  channel: number;
  kind: CaptureTriggerKind;
}

export interface CaptureMetadata {
  version: number;
  source_device: string;
  sample_rate_hz: number;
  channel_count: number;
  enabled_channels: number[];
  unitsize: number;
  sample_count: number;
  captured_at: string;
  labels: string[];
  trigger?: CaptureTriggerMetadata | null;
}

export interface CaptureSummary {
  metadata: CaptureMetadata;
  bytes: number;
}

export interface OpenCaptureResult {
  summary: CaptureSummary;
  saleae_session: SaleaeSessionMetadata | null;
}

export interface TrimCaptureRequest {
  trim_before_sample?: number;
  trim_after_sample?: number;
}

export interface CaptureProgress {
  bytes_read: number;
  bytes_expected: number;
  samples_read: number;
  sample_memory_bytes: number;
}

export interface CaptureMemoryUsage {
  buffer_bytes: number;
  sample_bytes: number;
  index_bytes: number;
  analyzer_bytes: number;
  total_bytes: number;
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

export interface NearestDigitalTransitionRequest {
  channel: number;
  sample: number;
}

export interface NearestDigitalTransition {
  previous_sample: number | null;
  sample: number;
  next_sample: number | null;
}

export interface DigitalPointMeasurementRequest {
  channel: number;
  sample: number;
}

export interface DigitalPointMeasurement {
  channel: number;
  cursor_sample: number;
  high: boolean;
  width_start_sample: number;
  width_end_sample: number;
  period_end_sample: number | null;
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
  packed_bins?: Uint8Array | null;
  segments: DigitalSegment[];
  rising_edges: number[];
  falling_edges: number[];
  previous_transition?: number | null;
  next_transition?: number | null;
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
  data_bits: number;
  stop_bits: number;
  parity: "none" | "even" | "odd";
  msb_first: boolean;
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

export type NativeOptionValue = boolean | number | string;

export interface SigrokDecoderCatalog {
  decoders: SigrokDecoderCatalogItem[];
  c_decoder_count: number;
  python_decoder_count: number;
}

export interface SigrokDecoderCatalogItem {
  id?: string | null;
  name?: string | null;
  longname?: string | null;
  desc?: string | null;
  license?: string | null;
  kind?: string | null;
  runner_status?: string | null;
  inputs: string[];
  outputs: string[];
  tags: string[];
  channels: SigrokDecoderChannel[];
  optional_channels: SigrokDecoderChannel[];
  options: SigrokDecoderOption[];
  annotations?: unknown[];
  annotation_rows?: unknown[];
  binary?: unknown[];
}

export interface SigrokDecoderChannel {
  id?: string | null;
  name?: string | null;
  desc?: string | null;
  order: number;
  type: number;
  type_name?: string | null;
  idn?: string | null;
}

export interface SigrokDecoderOption {
  id?: string | null;
  idn?: string | null;
  desc?: string | null;
  value_type?: string | null;
  default?: unknown;
  values: unknown[];
}

export interface NativeDecodeSettings {
  decoder_id: string;
  protocol_name: string;
  channels: Record<string, number | null>;
  options: Record<string, NativeOptionValue>;
  primary_channel: number;
}

export type AnalyzerDecodeSettings =
  | { protocol: "Uart"; settings: UartDecodeSettings }
  | { protocol: "I2c"; settings: I2cDecodeSettings }
  | { protocol: "Spi"; settings: SpiDecodeSettings }
  | { protocol: "Native"; settings: NativeDecodeSettings };

export type DecoderBackendKind = "auto" | "saleae_native" | "sigrok_native" | "legacy_rust";

export interface DemoAnalyzerSettings {
  backend: DecoderBackendKind;
  settings: AnalyzerDecodeSettings;
}

export interface SaleaeAnalyzerMetadata {
  type: string;
  name: string;
  color: string;
  display_radix: string;
  show_in_data_table: boolean;
  stream_to_terminal: boolean;
  decoder_backend: DecoderBackendKind;
  decode_settings?: AnalyzerDecodeSettings;
  saleae_metadata?: unknown;
}

export interface SaleaeSessionMetadata {
  name: string;
  notes: string;
  analyzers: SaleaeAnalyzerMetadata[];
}

type PreviewDemoSignal =
  | { kind: "Pulse" }
  | { kind: "Uart"; settings: UartDecodeSettings }
  | { kind: "I2c"; role: "Sda" | "Scl"; settings: I2cDecodeSettings }
  | { kind: "Spi"; role: "Mosi" | "Miso" | "Clock" | "Enable"; settings: SpiDecodeSettings };

export interface DecodedChannelValue {
  channel: number;
  role: string;
  label: string;
  texts?: string[];
  value: number;
}

export interface DecodedFrame {
  frame_id: number;
  start_sample: number;
  end_sample: number;
  frame_type: string;
  label: string;
  value: number;
  channel_values: DecodedChannelValue[];
  protocol_markers?: Array<{
    channel: number | null;
    sample: number;
    kind: AnalyzerProtocolMarker["kind"];
  }>;
}

export interface AnalyzerFrameRef {
  frame_id: number;
  start_sample: number;
  end_sample: number;
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
  frame_refs?: AnalyzerFrameRef[];
  frames: DecodedFrame[];
  previous_frame_ref?: AnalyzerFrameRef | null;
  previous_frame: DecodedFrame | null;
  next_frame_ref?: AnalyzerFrameRef | null;
  next_frame: DecodedFrame | null;
}

export type AnalyzerFrameWindow = UartFrameWindow;

export interface AnalyzerTrackRequest {
  channel: number;
  role: string;
}

export interface AnalyzerRenderRequest {
  analyzer_id: string;
  backend: DecoderBackendKind;
  settings: AnalyzerDecodeSettings;
  tracks: AnalyzerTrackRequest[];
}

export interface AnalyzerTrackWindow extends AnalyzerFrameWindow {
  channel: number;
  protocol_markers: AnalyzerProtocolMarker[];
  role: string;
}

export interface AnalyzerProtocolMarker {
  sample: number;
  kind:
    | "dot"
    | "error_dot"
    | "square"
    | "error_square"
    | "up_arrow"
    | "down_arrow"
    | "x"
    | "error_x"
    | "start"
    | "stop"
    | "one"
    | "zero";
}

export interface AnalyzerRenderResult {
  analyzer_id: string;
  tracks: AnalyzerTrackWindow[];
}

export interface AnalyzerDecodeBatchRequest {
  analyzer_id: string;
  backend: DecoderBackendKind;
  settings: AnalyzerDecodeSettings;
}

export interface AnalyzerDecodeBatchResult {
  analyzer_id: string;
  frames: DecodedFrame[];
}

export interface AnalyzerDecodeBatchSummaryResult {
  analyzer_id: string;
  frame_count: number;
}

export interface AnalyzerDecodeBackgroundProgressResult {
  analyzer_id: string;
  frame_count: number;
  processed_edges: number;
  total_edges: number;
  progress: number;
  complete: boolean;
  cancelled: boolean;
}

export interface AnalyzerDecodeFrameSliceRequest {
  backend: DecoderBackendKind;
  end: number;
  settings: AnalyzerDecodeSettings;
  start: number;
}

export interface AnalyzerDecodeFrameSliceResult {
  frame_count: number;
  frames: DecodedFrame[];
}

export interface AnalyzerFrameTableRequest {
  analyzer_id: string;
  analyzer_name: string;
  backend: DecoderBackendKind;
  display_radix: string;
  settings: AnalyzerDecodeSettings;
}

export interface AnalyzerFrameTableRow {
  analyzer_id: string;
  frame: DecodedFrame;
  frame_index: number;
  frame_number: number;
}

export interface AnalyzerFrameTableWindow {
  roles: string[];
  row_count: number;
  rows: AnalyzerFrameTableRow[];
}

// The backend owns the viewport. A gesture is described as an intent and the
// authoritative result comes back in `GraphFrameResponse.view`, so the frontend
// never clamps a copy of its own.
export interface SessionView {
  start_sample: number;
  samples: number;
}

export type ViewIntent =
  /** Render wherever the session already is. The per-frame loop sends this when
   * no new gesture arrived, which keeps an in-flight glide running. */
  | { kind: "keep_current" }
  | { kind: "set"; start_sample: number; samples: number }
  /** Shift the viewport by a delta. A delta rather than a destination is what
   * makes this safe while a glide is running: the backend applies it to whatever
   * the view is at that moment, so the caller never has to guess a position it
   * may be behind on. `duration_ms` behaves as it does on `zoom`. */
  | { kind: "pan_samples"; delta_samples: number; duration_ms?: number }
  /** Multiply the visible span around `anchor_ratio`. `duration_ms` above zero
   * glides to the result instead of jumping to it; the backend computes the
   * anchored target either way, so the anchor arithmetic stays in one place.
   *
   * Discrete input (one wheel notch, one keypress) passes a duration because a
   * single hard step reads as a jump. Continuous input (a touchpad stream)
   * leaves it at zero — it already updates every frame. */
  | { kind: "zoom"; factor: number; anchor_ratio: number; duration_ms?: number }
  /** Glide to a viewport over `duration_ms`. The backend owns the animation. */
  | { kind: "animate_to"; start_sample: number; samples: number; duration_ms: number };

export interface GraphFrameRequest {
  frame_id: number;
  waveform: WaveformRequest;
  include_tile?: boolean;
  analyzer_view?: WaveformRequest | null;
  analyzers: AnalyzerRenderRequest[];
  /**
   * When present the backend applies this gesture and renders the session's own
   * viewport. `waveform` then only supplies `pixels` and `channels`.
   */
  view?: ViewIntent | null;
}

export interface GraphFrameResponse {
  frame_id: number;
  revision: number;
  sample_count: number;
  /** The authoritative viewport this frame was rendered for. */
  view: SessionView;
  /**
   * The viewport the returned data was computed for. It trails `view` whenever
   * the user kept moving while the frame was in flight, and the gap between the
   * two is exactly what the residual pixel transform stretches.
   */
  data_view: SessionView;
  tile: WaveformTile;
  analyzers: AnalyzerRenderResult[];
}

export interface CaptureCallbacks {
  onProgress?: (progress: CaptureProgress) => void;
  onSummary?: (summary: CaptureSummary) => void;
  onTrigger?: (trigger: CaptureTriggerMetadata) => void;
}

export const isTauriRuntime = () =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

let previewCapture: CaptureSummary = {
  metadata: {
    version: 1,
    source_device: "SigPilot Preview",
    sample_rate_hz: 25_000_000,
    channel_count: 8,
    enabled_channels: Array.from({ length: 8 }, (_, index) => index),
    unitsize: 1,
    sample_count: 250_000,
    captured_at: new Date().toISOString(),
    labels: Array.from({ length: 8 }, (_, index) => `D${index}`),
  },
  bytes: 250_000,
};
interface PreviewCaptureRun {
  cancelled: boolean;
  cancel: () => void;
}

let previewCaptureRun: PreviewCaptureRun | null = null;
const previewCaptures = new Map<string, CaptureSummary>();
const previewCaptureRevisions = new Map<string, number>();
const previewAnalyzerFrameCache = new Map<string, DecodedFrame[]>();
const previewDemoSignalsBySession = new Map<string, PreviewDemoSignal[]>();
let previewDemoSignals: PreviewDemoSignal[] = [];

// Ported from Logic 2.4.43 BaseAnalyzerManager. Bubble responses may grow
// with the viewport; the fixed 300-result limit is reserved for marker lists.
const PREVIEW_MAX_ANALYZER_MARKER_RESULTS = 300;
const PREVIEW_MAX_ANALYZER_BUBBLE_RESULTS = 4_096;
const PREVIEW_MAX_MULTI_BUBBLE_STRINGS = 400;
const PREVIEW_MAX_PIXEL_WIDTH_FOR_MERGEABLE_FRAME = 15;
const PREVIEW_MAX_PIXELS_BETWEEN_MERGEABLE_FRAMES = 30;
const PREVIEW_CAPTURE_UPDATE_MS = 50;
const PREVIEW_SAMPLE_RATES = [
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
const PREVIEW_PULSE_SIGNAL: PreviewDemoSignal = { kind: "Pulse" };
const PREVIEW_BIN_EDGE_SCAN_LIMIT = 96;
const PREVIEW_SIGROK_DECODER_CATALOG: SigrokDecoderCatalog = {
  c_decoder_count: 3,
  python_decoder_count: 2,
  decoders: [
    {
      id: "spi_c",
      name: "SPI(C)",
      longname: "Serial Peripheral Interface (C)",
      desc: "SPI protocol decoder (C implementation, faster than Python)",
      license: "gplv2+",
      kind: "c",
      runner_status: "verified_sparse_c",
      inputs: ["logic"],
      outputs: ["spi"],
      tags: ["Embedded/industrial"],
      channels: [{ id: "clk", name: "CLK", desc: "Clock", order: 0, type: 0, type_name: "clock" }],
      optional_channels: [
        { id: "miso", name: "MISO", desc: "Master in, slave out", order: 1, type: 1, type_name: "serial_data" },
        { id: "mosi", name: "MOSI", desc: "Master out, slave in", order: 2, type: 1, type_name: "serial_data" },
        { id: "cs", name: "CS#", desc: "Chip-select", order: 3, type: -1, type_name: "common" },
      ],
      options: [
        { id: "cs_polarity", desc: "CS# polarity", value_type: "s", default: "active-low", values: ["active-low", "active-high"] },
        { id: "cpol", desc: "Clock polarity", value_type: "t", default: 0, values: [0, 1] },
        { id: "cpha", desc: "Clock phase", value_type: "t", default: 0, values: [0, 1] },
        { id: "bitorder", desc: "Bit order", value_type: "s", default: "msb-first", values: ["msb-first", "lsb-first"] },
      ],
    },
    {
      id: "qspi_c",
      name: "Smart QSPI(C)",
      longname: "Quad Serial Peripheral Interface (C)",
      desc: "Full-duplex, synchronous, serial bus compatible with Dual SPI and Quad SPI interfaces.",
      license: "gplv2+",
      kind: "c",
      runner_status: "generic_sparse_c",
      inputs: ["logic"],
      outputs: ["spi"],
      tags: ["Embedded/industrial"],
      channels: [
        { id: "clk", name: "CLK", desc: "Clock", order: 0, type: 0, type_name: "clock" },
        { id: "io0", name: "IO0", desc: "Data i/o 0", order: 1, type: 1, type_name: "serial_data" },
      ],
      optional_channels: [
        { id: "io1", name: "IO1", desc: "Data i/o 1", order: 2, type: 1, type_name: "serial_data" },
        { id: "io2", name: "IO2", desc: "Data i/o 2", order: 3, type: 1, type_name: "serial_data" },
        { id: "io3", name: "IO3", desc: "Data i/o 3", order: 4, type: 1, type_name: "serial_data" },
        { id: "cs", name: "CS#", desc: "Chip-select", order: 5, type: -1, type_name: "common" },
      ],
      options: [
        { id: "cs_polarity", desc: "CS# polarity", value_type: "s", default: "active-low", values: ["active-low", "active-high"] },
        { id: "bitorder", desc: "Bit order", value_type: "s", default: "msb-first", values: ["msb-first", "lsb-first"] },
        { id: "twolinesmode", desc: "TwoLinesMode", value_type: "s", default: "spi", values: ["spi", "dspi", "qspi"] },
      ],
    },
    {
      id: "modbus_c",
      name: "Modbus(C)",
      longname: "Modbus RTU (C)",
      desc: "Industrial Modbus RTU protocol decoder.",
      license: "gplv2+",
      kind: "c",
      runner_status: "catalog_only",
      inputs: ["uart"],
      outputs: ["modbus"],
      tags: ["Embedded/industrial"],
      channels: [],
      optional_channels: [],
      options: [],
    },
    {
      id: "jtag",
      name: "JTAG",
      longname: "Joint Test Action Group (IEEE 1149.1)",
      desc: "Protocol for testing, debugging, and flashing ICs.",
      license: "gplv2+",
      kind: "python",
      runner_status: "catalog_only",
      inputs: ["logic"],
      outputs: ["jtag"],
      tags: ["Debug/trace"],
      channels: [
        { id: "tdi", name: "TDI", desc: "Test data input", order: 0, type: -1, type_name: "common" },
        { id: "tdo", name: "TDO", desc: "Test data output", order: 1, type: -1, type_name: "common" },
        { id: "tck", name: "TCK", desc: "Test clock", order: 2, type: -1, type_name: "common" },
        { id: "tms", name: "TMS", desc: "Test mode select", order: 3, type: -1, type_name: "common" },
      ],
      optional_channels: [
        { id: "trst", name: "TRST#", desc: "Test reset", order: 4, type: -1, type_name: "common" },
      ],
      options: [],
    },
    {
      id: "usb_power_delivery",
      name: "USB Power Delivery",
      longname: "USB Power Delivery",
      desc: "USB Type-C Power Delivery packet decoder.",
      license: "gplv2+",
      kind: "python",
      runner_status: "catalog_only",
      inputs: ["logic"],
      outputs: ["usb_pd"],
      tags: ["USB"],
      channels: [{ id: "cc", name: "CC", desc: "Configuration channel", order: 0, type: -1, type_name: "common" }],
      optional_channels: [],
      options: [],
    },
  ],
};

function buildPreviewDemoSignals(
  channelCount: number,
  analyzers: AnalyzerDecodeSettings[],
): PreviewDemoSignal[] {
  const signals = Array.from({ length: channelCount }, () => PREVIEW_PULSE_SIGNAL);
  const claimed = new Set<number>();

  const canClaim = (channels: number[]) =>
    channels.length > 0 &&
    new Set(channels).size === channels.length &&
    channels.every((channel) => channel >= 0 && channel < channelCount && !claimed.has(channel));
  const claim = (channel: number, signal: PreviewDemoSignal) => {
    signals[channel] = signal;
    claimed.add(channel);
  };

  analyzers.forEach((analyzer) => {
    if (analyzer.protocol === "Uart") {
      const channels = [analyzer.settings.channel];
      if (canClaim(channels)) claim(channels[0], { kind: "Uart", settings: analyzer.settings });
      return;
    }

    if (analyzer.protocol === "I2c") {
      const channels = [analyzer.settings.sda_channel, analyzer.settings.scl_channel];
      if (!canClaim(channels)) return;
      claim(channels[0], { kind: "I2c", role: "Sda", settings: analyzer.settings });
      claim(channels[1], { kind: "I2c", role: "Scl", settings: analyzer.settings });
      return;
    }

    if (analyzer.protocol === "Native") return;

    const roles = [
      analyzer.settings.mosi_channel === null
        ? null
        : ([analyzer.settings.mosi_channel, "Mosi"] as const),
      analyzer.settings.miso_channel === null
        ? null
        : ([analyzer.settings.miso_channel, "Miso"] as const),
      [analyzer.settings.clock_channel, "Clock"] as const,
      analyzer.settings.enable_channel === null
        ? null
        : ([analyzer.settings.enable_channel, "Enable"] as const),
    ].filter((role): role is readonly [number, "Mosi" | "Miso" | "Clock" | "Enable"] => role !== null);
    if (roles.length < 2 || !canClaim(roles.map(([channel]) => channel))) return;
    roles.forEach(([channel, role]) => claim(channel, { kind: "Spi", role, settings: analyzer.settings }));
  });

  return signals;
}

function previewSignalForChannel(channel: number) {
  return previewDemoSignals[channel] ?? PREVIEW_PULSE_SIGNAL;
}

function previewUartSettingsAreSimulated(settings: UartDecodeSettings) {
  const signal = previewSignalForChannel(settings.channel);
  return signal.kind === "Uart" && samePreviewUartSettings(signal.settings, settings);
}

function previewI2cSettingsAreSimulated(settings: I2cDecodeSettings) {
  const sda = previewSignalForChannel(settings.sda_channel);
  const scl = previewSignalForChannel(settings.scl_channel);
  return (
    sda.kind === "I2c" &&
    sda.role === "Sda" &&
    scl.kind === "I2c" &&
    scl.role === "Scl" &&
    samePreviewI2cSettings(sda.settings, settings) &&
    samePreviewI2cSettings(scl.settings, settings)
  );
}

function previewSpiSettingsAreSimulated(settings: SpiDecodeSettings) {
  const roles = [
    settings.mosi_channel === null ? null : ([settings.mosi_channel, "Mosi"] as const),
    settings.miso_channel === null ? null : ([settings.miso_channel, "Miso"] as const),
    [settings.clock_channel, "Clock"] as const,
    settings.enable_channel === null ? null : ([settings.enable_channel, "Enable"] as const),
  ].filter((role): role is readonly [number, "Mosi" | "Miso" | "Clock" | "Enable"] => role !== null);
  return roles.every(([channel, role]) => {
    const signal = previewSignalForChannel(channel);
    return signal.kind === "Spi" && signal.role === role && samePreviewSpiSettings(signal.settings, settings);
  });
}

function samePreviewUartSettings(left: UartDecodeSettings, right: UartDecodeSettings) {
  return left.channel === right.channel && left.baud_rate === right.baud_rate && left.inverted === right.inverted;
}

function samePreviewI2cSettings(left: I2cDecodeSettings, right: I2cDecodeSettings) {
  return left.sda_channel === right.sda_channel && left.scl_channel === right.scl_channel;
}

function samePreviewSpiSettings(left: SpiDecodeSettings, right: SpiDecodeSettings) {
  return (
    left.mosi_channel === right.mosi_channel &&
    left.miso_channel === right.miso_channel &&
    left.clock_channel === right.clock_channel &&
    left.enable_channel === right.enable_channel &&
    left.enable_active_low === right.enable_active_low &&
    left.clock_polarity === right.clock_polarity &&
    left.clock_phase === right.clock_phase &&
    left.bits_per_transfer === right.bits_per_transfer &&
    left.msb_first === right.msb_first
  );
}

function previewBitMask(bits: number) {
  if (bits >= 53) return Number.MAX_SAFE_INTEGER;
  return 2 ** Math.max(1, bits) - 1;
}

/**
 * Writes a line into the application log from the webview.
 *
 * Frontend problems are otherwise invisible in the file the backend writes: an
 * event that never arrived and a handler that declined to act look identical.
 * Fire-and-forget, because a diagnostic must never break the thing it measures.
 */
export function frontendLog(message: string, level: "info" | "warn" | "error" = "info") {
  if (!isTauriRuntime()) return;
  void invoke("frontend_log", { level, message }).catch(() => {});
}

/**
 * Applies the same verbosity to the backend log and returns the level that
 * ended up in effect, so the UI can show what the backend actually did.
 */
export async function applyBackendLogLevel(level: string): Promise<string> {
  if (!isTauriRuntime()) return level;
  try {
    return await invoke<string>("set_log_level", { level });
  } catch {
    return level;
  }
}

export async function readLogStatus(): Promise<LogStatus | null> {
  if (!isTauriRuntime()) return null;
  try {
    return await invoke<LogStatus>("log_status");
  } catch {
    return null;
  }
}

export async function setLogPaused(paused: boolean): Promise<void> {
  await callBackend("set_log_paused", { paused });
}

export async function clearLogs(): Promise<void> {
  await callBackend("clear_logs");
}

/**
 * The diagnostics text, for the clipboard.
 *
 * The frontend passes its own log because the webview is the only place it
 * exists; the backend adds version, platform and every retained log file.
 */
export async function readDiagnostics(frontendLogText: string, maxBytes?: number): Promise<string> {
  return callBackend<string>("read_diagnostics", {
    frontendLog: frontendLogText,
    maxBytes: maxBytes ?? null,
  });
}

/**
 * Writes the diagnostics bundle to a path the user chose.
 *
 * Secondary to the clipboard: attaching a file is still the better move when
 * the report goes somewhere that takes attachments.
 */
export async function exportLogs(path: string, frontendLogText: string): Promise<void> {
  await callBackend("export_logs", { frontendLog: frontendLogText, path });
}

export interface LogFileInfo {
  name: string;
  bytes: number;
}

export interface LogStatus {
  available: boolean;
  currentFile: string;
  directory: string;
  files: LogFileInfo[];
  level: string;
  maxFileBytes: number;
  maxFiles: number;
  paused: boolean;
  totalBytes: number;
}

async function callBackend<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauriRuntime()) {
    throw new Error("Tauri runtime is not available");
  }
  return invoke<T>(command, args);
}

interface PackedBinRange {
  offset: number;
  length: number;
}

export function decodeBinaryGraphFrame(payload: Uint8Array | ArrayBuffer | number[]): GraphFrameResponse {
  const bytes = payload instanceof Uint8Array
    ? payload
    : payload instanceof ArrayBuffer
      ? new Uint8Array(payload)
      : Uint8Array.from(payload);
  if (
    bytes.length < 13 ||
    bytes[0] !== 0x50 ||
    bytes[1] !== 0x58 ||
    bytes[2] !== 0x47 ||
    bytes[3] !== 0x46 ||
    bytes[4] !== 0x31
  ) {
    throw new Error("Invalid graph frame response");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLength = Number(view.getBigUint64(5, true));
  const headerStart = 13;
  const binaryStart = headerStart + headerLength;
  if (!Number.isSafeInteger(headerLength) || binaryStart > bytes.length) {
    throw new Error("Invalid graph frame header length");
  }
  const response = JSON.parse(
    new TextDecoder().decode(bytes.subarray(headerStart, binaryStart)),
  ) as GraphFrameResponse;
  for (const channel of response.tile.channels) {
    const range = channel.packed_bins as unknown as PackedBinRange | null | undefined;
    if (!range) {
      channel.packed_bins = null;
      continue;
    }
    const begin = binaryStart + range.offset;
    const end = begin + range.length;
    if (
      !Number.isSafeInteger(range.offset) ||
      !Number.isSafeInteger(range.length) ||
      range.offset < 0 ||
      range.length < 0 ||
      begin < binaryStart ||
      end > bytes.length
    ) {
      throw new Error("Invalid packed waveform range");
    }
    channel.packed_bins = bytes.subarray(begin, end);
  }
  return response;
}

async function callGraphFrameBackend(
  sessionId: string,
  request: GraphFrameRequest,
): Promise<GraphFrameResponse> {
  const payload = await invoke<Uint8Array | ArrayBuffer | number[]>("render_graph_frame", {
    sessionId,
    request,
  });
  return decodeBinaryGraphFrame(payload);
}

/** How the backend clamps viewports. `total_samples` is not part of this: the
 * backend reads it from the capture so the two can never disagree. */
export interface ViewLimits {
  live: boolean;
  maximum_samples: number | null;
  sample_rate_hz: number;
}

/**
 * Applies a gesture to the session viewport and returns the authoritative
 * result. This is the entry point for viewport changes that are not already
 * carried by a frame request: zoom to fit, jump to an edge, scrollbar drags.
 *
 * Returns `null` outside Tauri, where there is no backend to own the viewport.
 */
export async function applyGraphViewIntent(
  sessionId: string,
  intent: ViewIntent,
): Promise<SessionView | null> {
  if (!isTauriRuntime()) return previewApplyViewIntent(sessionId, intent);
  return invoke<SessionView>("apply_graph_view_intent", { sessionId, intent });
}

/**
 * Updates the clamping policy and returns the re-clamped current viewport, so a
 * capture that grew or a mode that changed cannot leave a stale view in place.
 */
export async function setGraphViewLimits(
  sessionId: string,
  limits: ViewLimits,
): Promise<SessionView | null> {
  if (!isTauriRuntime()) return previewSetViewLimits(sessionId, limits);
  return invoke<SessionView>("set_graph_view_limits", { sessionId, limits });
}

function previewCaptureForSession(sessionId: string) {
  return previewCaptures.get(sessionId) ?? previewCapture;
}

function withPreviewCapture<T>(sessionId: string, callback: () => T): T {
  const previous = previewCapture;
  const previousSignals = previewDemoSignals;
  previewCapture = previewCaptureForSession(sessionId);
  previewDemoSignals =
    previewDemoSignalsBySession.get(sessionId) ?? buildPreviewDemoSignals(previewCapture.metadata.channel_count, []);
  try {
    return callback();
  } finally {
    previewCapture = previous;
    previewDemoSignals = previousSignals;
  }
}

export function listDevices(): Promise<DeviceInfo[]> {
  if (!isTauriRuntime()) {
    return Promise.resolve([
      {
        id: "fake:sigpilot-demo",
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
      },
    ]);
  }
  return callBackend("list_devices");
}

export function deviceCapabilities(deviceId: string): Promise<HardwareCaptureCapabilities> {
  if (!isTauriRuntime()) {
    return Promise.resolve(previewDeviceCapabilities(deviceId));
  }
  return callBackend("device_capabilities", { deviceId });
}

export function sigrokDecoderCatalog(): Promise<SigrokDecoderCatalog> {
  if (!isTauriRuntime()) return Promise.resolve(PREVIEW_SIGROK_DECODER_CATALOG);
  return callBackend("sigrok_decoder_catalog");
}

export function saleaeDecoderCatalog(): Promise<SigrokDecoderCatalog> {
  if (!isTauriRuntime()) return Promise.resolve({ decoders: [], c_decoder_count: 0, python_decoder_count: 0 });
  return callBackend("saleae_decoder_catalog");
}

function previewDeviceCapabilities(deviceId: string): HardwareCaptureCapabilities {
  const channelModes: HardwareChannelModeInfo[] = [
    {
      id: "DEMO_STREAM32",
      stream: true,
      channels: 32,
      default_sample_rate_hz: 25_000_000,
      default_sample_limit: 0,
      min_sample_rate_hz: 2_000,
      max_sample_rate_hz: 100_000_000,
      sample_rates: PREVIEW_SAMPLE_RATES,
      description: "Use 32 Channels (Max 100MHz)",
    },
    {
      id: "DEMO_BUFFER32",
      stream: false,
      channels: 32,
      default_sample_rate_hz: 25_000_000,
      default_sample_limit: 250_000_000,
      min_sample_rate_hz: 2_000,
      max_sample_rate_hz: 100_000_000,
      sample_rates: PREVIEW_SAMPLE_RATES,
      description: "Use 32 Channels (Max 100MHz)",
    },
  ];
  return {
    device_id: deviceId,
    profile_vendor: null,
    profile_model: "SigPilot Preview Device",
    usb_speed: null,
    logic_mode: null,
    max_channels: 32,
    default_channel_count: 8,
    default_sample_rate_hz: 25_000_000,
    sample_rates: PREVIEW_SAMPLE_RATES,
    threshold_volts: [1.8, 2.5, 3.3, 5.0],
    channel_modes: channelModes,
  };
}

export function prepareDevice(deviceId: string): Promise<void> {
  if (!isTauriRuntime()) return Promise.resolve();
  return callBackend("prepare_device", { deviceId });
}

export function configurePwm(deviceId: string, settings: PwmSettings): Promise<PwmConfiguration> {
  if (!Number.isFinite(settings.frequency_hz) || settings.frequency_hz < 1 || settings.frequency_hz > 1_000_000) {
    return Promise.reject(new Error("PWM0 frequency must be between 1 and 1000000 Hz"));
  }
  if (!Number.isFinite(settings.duty_percent) || settings.duty_percent < 0 || settings.duty_percent > 100) {
    return Promise.reject(new Error("PWM0 duty must be between 0 and 100%"));
  }
  if (!isTauriRuntime()) {
    const periodTicks = Math.floor(125_000_000 / settings.frequency_hz);
    const highTicks = Math.floor((periodTicks * settings.duty_percent) / 100);
    return Promise.resolve({
      enabled: settings.enabled,
      requested_frequency_hz: settings.frequency_hz,
      requested_duty_percent: settings.duty_percent,
      effective_frequency_hz: 125_000_000 / periodTicks,
      effective_duty_percent: (highTicks * 100) / periodTicks,
      period_ticks: periodTicks,
      high_ticks: highTicks,
    });
  }
  return callBackend("configure_pwm", { deviceId, settings });
}

export function startCapture(
  sessionId: string,
  settings: CaptureSettings,
  callbacks: CaptureCallbacks = {},
  demoAnalyzers: DemoAnalyzerSettings[] = [],
): Promise<CaptureSummary> {
  if (!isTauriRuntime()) {
    previewCaptureRun?.cancel();
    let finishRun = () => {};
    const run: PreviewCaptureRun = {
      cancelled: false,
      cancel: () => {
        if (run.cancelled) return;
        run.cancelled = true;
        finishRun();
      },
    };
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
    const trigger = settings.trigger_enabled
      ? {
          sample_index: Math.max(
            0,
            Math.min(
              targetSamples - 1,
              Math.floor((targetSamples * Math.max(0, Math.min(100, settings.trigger_position_percent))) / 100),
            ),
          ),
          channel: settings.trigger_channel,
          kind: settings.trigger_kind,
        }
      : null;
    if (trigger) callbacks.onTrigger?.(trigger);
    previewDemoSignalsBySession.set(
      sessionId,
      buildPreviewDemoSignals(
        settings.channel_count,
        demoAnalyzers.map((analyzer) => analyzer.settings),
      ),
    );

    return new Promise((resolve) => {
      let updateTimer: number | null = null;
      let finished = false;
      finishRun = () => {
        if (finished) return;
        finished = true;
        if (updateTimer !== null) window.clearTimeout(updateTimer);
        if (previewCaptureRun === run) previewCaptureRun = null;
        resolve(previewCapture);
      };

      function update() {
        if (finished) return;
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
            enabled_channels:
              settings.enabled_channels.length > 0
                ? [...settings.enabled_channels]
                : Array.from({ length: settings.channel_count }, (_, index) => index),
            unitsize,
            sample_count: sampleCount,
            captured_at: capturedAt,
            labels: Array.from({ length: settings.channel_count }, (_, index) => `D${index}`),
            trigger,
          },
          bytes: sampleCount * unitsize,
        };
        previewCaptures.set(sessionId, previewCapture);
        previewCaptureRevisions.set(sessionId, (previewCaptureRevisions.get(sessionId) ?? 0) + 1);
        callbacks.onProgress?.({
          bytes_read: previewCapture.bytes,
          bytes_expected: targetBytes,
          samples_read: sampleCount,
          sample_memory_bytes: previewCapture.bytes,
        });
        callbacks.onSummary?.(previewCapture);

        if (run.cancelled || sampleCount >= targetSamples) {
          finishRun();
          return;
        }
        updateTimer = window.setTimeout(update, PREVIEW_CAPTURE_UPDATE_MS);
      }
      update();
    });
  }
  return callBackend("start_capture", { sessionId, settings, demoAnalyzers });
}

export function cancelCapture(): Promise<void> {
  if (!isTauriRuntime()) {
    previewCaptureRun?.cancel();
    return Promise.resolve();
  }
  return callBackend("cancel_capture");
}

export function openCapture(sessionId: string, path: string): Promise<OpenCaptureResult> {
  if (!isTauriRuntime()) {
    previewCaptures.set(sessionId, previewCapture);
    previewCaptureRevisions.set(sessionId, (previewCaptureRevisions.get(sessionId) ?? 0) + 1);
    return Promise.resolve({ summary: previewCapture, saleae_session: null });
  }
  return callBackend("open_capture", { sessionId, path });
}

export function saveCapture(
  sessionId: string,
  path: string,
  saleaeSession?: SaleaeSessionMetadata,
): Promise<void> {
  if (!isTauriRuntime()) return Promise.resolve();
  return callBackend("save_capture", { sessionId, path, saleaeSession });
}

export function exportCapture(
  sessionId: string,
  path: string,
  format: ExportFormat,
): Promise<void> {
  if (!isTauriRuntime()) return Promise.resolve();
  return callBackend("export_capture", { sessionId, path, format });
}

export function writeTextFile(path: string, contents: string): Promise<void> {
  if (!isTauriRuntime()) {
    console.info(`writeTextFile preview: ${path}`, contents);
    return Promise.resolve();
  }
  return callBackend("write_text_file", { path, contents });
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
    const trigger = current.metadata.trigger;
    const adjustedTrigger =
      trigger && trigger.sample_index >= startSample && trigger.sample_index < endSample
        ? { ...trigger, sample_index: trigger.sample_index - startSample }
        : null;
    const nextCapture = {
      metadata: {
        ...current.metadata,
        sample_count: sampleCount,
        trigger: adjustedTrigger,
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
  return callGraphFrameBackend(sessionId, {
    frame_id: 0,
    waveform: request,
    include_tile: true,
    analyzer_view: null,
    analyzers: [],
  }).then((frame) => frame.tile);
}

export function nearestDigitalTransition(
  sessionId: string,
  request: NearestDigitalTransitionRequest,
): Promise<NearestDigitalTransition | null> {
  if (isTauriRuntime()) {
    return callBackend("nearest_digital_transition", { sessionId, request });
  }
  const radius = 2_048;
  const start = Math.max(0, Math.round(request.sample) - radius);
  return getWaveformTile(sessionId, {
    channels: [request.channel],
    pixels: radius * 2,
    sample_count: radius * 2,
    start_sample: start,
  }).then((tile) => {
    const channel = tile.channels[0];
    if (!channel) return null;
    const edges = [...channel.rising_edges, ...channel.falling_edges].sort((left, right) => left - right);
    if (edges.length === 0) return null;
    const nearestIndex = edges.reduce(
      (best, edge, index) =>
        Math.abs(edge - request.sample) < Math.abs(edges[best] - request.sample) ? index : best,
      0,
    );
    return {
      previous_sample: edges[nearestIndex - 1] ?? null,
      sample: edges[nearestIndex],
      next_sample: edges[nearestIndex + 1] ?? null,
    };
  });
}

export function measureDigitalPoint(
  sessionId: string,
  request: DigitalPointMeasurementRequest,
): Promise<DigitalPointMeasurement | null> {
  if (!isTauriRuntime()) {
    return Promise.resolve(withPreviewCapture(sessionId, () => measurePreviewDigitalPoint(request)));
  }
  return callBackend("measure_digital_point", { sessionId, request });
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
  backend: DecoderBackendKind = "legacy_rust",
): Promise<DecodedFrame[]> {
  if (!isTauriRuntime()) {
    return Promise.resolve(withPreviewCapture(sessionId, () => cachedPreviewAnalyzerFrames(settings)));
  }
  return callBackend("decode_analyzer_frames", { sessionId, backend, settings });
}

export function decodeAnalyzerFrameBatch(
  sessionId: string,
  requests: AnalyzerDecodeBatchRequest[],
): Promise<AnalyzerDecodeBatchResult[]> {
  if (!isTauriRuntime()) {
    return Promise.resolve(
      withPreviewCapture(sessionId, () =>
        requests.map((request) => ({
          analyzer_id: request.analyzer_id,
          frames: cachedPreviewAnalyzerFrames(request.settings),
        })),
      ),
    );
  }
  return callBackend("decode_analyzer_frame_batch", { sessionId, requests });
}

export function decodeAnalyzerFrameBatchSummary(
  sessionId: string,
  requests: AnalyzerDecodeBatchRequest[],
): Promise<AnalyzerDecodeBatchSummaryResult[]> {
  if (!isTauriRuntime()) {
    return Promise.resolve(
      withPreviewCapture(sessionId, () =>
        requests.map((request) => ({
          analyzer_id: request.analyzer_id,
          frame_count: cachedPreviewAnalyzerFrames(request.settings).length,
        })),
      ),
    );
  }
  return callBackend("decode_analyzer_frame_batch_summary", { sessionId, requests });
}

export function decodeSaleaeAnalyzerBackgroundStep(
  sessionId: string,
  requests: AnalyzerDecodeBatchRequest[],
): Promise<AnalyzerDecodeBackgroundProgressResult[]> {
  if (!isTauriRuntime()) {
    return Promise.resolve(
      withPreviewCapture(sessionId, () =>
        requests.map((request) => {
          const frameCount = cachedPreviewAnalyzerFrames(request.settings).length;
          return {
            analyzer_id: request.analyzer_id,
            frame_count: frameCount,
            processed_edges: 1,
            total_edges: 1,
            progress: 1,
            complete: true,
            cancelled: false,
          };
        }),
      ),
    );
  }
  return callBackend("decode_saleae_analyzer_background_step", { sessionId, requests });
}

export function decodeAnalyzerFrameSlice(
  sessionId: string,
  request: AnalyzerDecodeFrameSliceRequest,
): Promise<AnalyzerDecodeFrameSliceResult> {
  if (!isTauriRuntime()) {
    return Promise.resolve(
      withPreviewCapture(sessionId, () => {
        const frames = cachedPreviewAnalyzerFrames(request.settings);
        const start = Math.max(0, Math.min(frames.length, Math.trunc(request.start)));
        const end = Math.max(start, Math.min(frames.length, Math.trunc(request.end)));
        return {
          frame_count: frames.length,
          frames: frames.slice(start, end),
        };
      }),
    );
  }
  return callBackend("decode_analyzer_frame_slice", { sessionId, request });
}

export function decodeAnalyzerFrameTableWindow(
  sessionId: string,
  requests: AnalyzerFrameTableRequest[],
  start: number,
  end: number,
): Promise<AnalyzerFrameTableWindow> {
  if (!isTauriRuntime()) {
    return Promise.resolve(
      withPreviewCapture(sessionId, () =>
        buildPreviewAnalyzerFrameTableWindow(requests, start, end),
      ),
    );
  }
  return callBackend("decode_analyzer_frame_table_window", { sessionId, requests, start, end });
}

export function decodeAnalyzerFrameTableSearchWindow(
  sessionId: string,
  requests: AnalyzerFrameTableRequest[],
  query: string,
  start: number,
  end: number,
): Promise<AnalyzerFrameTableWindow> {
  if (!isTauriRuntime()) {
    return Promise.resolve(
      withPreviewCapture(sessionId, () =>
        buildPreviewAnalyzerFrameTableSearchWindow(requests, query, start, end),
      ),
    );
  }
  return callBackend("decode_analyzer_frame_table_search_window", {
    sessionId,
    requests,
    query,
    start,
    end,
  });
}

export function decodeUartFrames(
  settings: UartDecodeSettings,
  sessionId = "preview",
): Promise<DecodedFrame[]> {
  return decodeAnalyzerFrames(sessionId, { protocol: "Uart", settings }, "legacy_rust");
}

export async function getUartFrameWindow(
  request: UartFrameWindowRequest,
  sessionId = "preview",
): Promise<UartFrameWindow> {
  const frames = await decodeUartFrames(request, sessionId);
  return buildAnalyzerFrameWindow(frames, request.start_sample, request.sample_count, request.width_px);
}

// --- Browser preview viewport -------------------------------------------------
// Mirrors what `GraphSession` does in Rust: an authoritative viewport per
// session plus the clamping limits. It exists so `pnpm dev` exercises the same
// intent protocol the desktop build uses, rather than a shortcut that would hide
// integration mistakes until someone ran the real thing.

interface PreviewViewLimits {
  live: boolean;
  maximum_samples: number | null;
  sample_rate_hz: number;
}

const previewViews = new Map<string, { samples: number; start: number }>();
const previewViewLimits = new Map<string, PreviewViewLimits>();

function previewLimitsFor(sessionId: string): PreviewViewLimits {
  const existing = previewViewLimits.get(sessionId);
  if (existing) return existing;
  const capture = previewCaptureForSession(sessionId);
  return {
    live: false,
    maximum_samples: null,
    sample_rate_hz: capture.metadata.sample_rate_hz,
  };
}

function normalizePreviewView(sessionId: string, start: number, samples: number) {
  const capture = previewCaptureForSession(sessionId);
  const total = Math.max(1, capture.metadata.sample_count);
  const limits = previewLimitsFor(sessionId);
  const viewport = limits.live
    ? normalizeLiveCaptureViewport(
        start,
        samples,
        total,
        limits.sample_rate_hz,
        limits.maximum_samples ?? undefined,
      )
    : normalizeCaptureViewport(start, samples, total, limits.maximum_samples ?? undefined);
  return { samples: viewport.samples, start: viewport.start };
}

function defaultPreviewView(sessionId: string) {
  const capture = previewCaptureForSession(sessionId);
  const limits = previewLimitsFor(sessionId);
  const total = Math.max(1, capture.metadata.sample_count);
  const preferred = Math.max(
    MINIMUM_DEFAULT_CAPTURE_VIEW_SAMPLES,
    Math.round(Math.max(1, limits.sample_rate_hz) * DEFAULT_CAPTURE_VIEW_SECONDS),
  );
  const samples = Math.min(total, preferred);
  return limits.live
    ? { samples, start: Math.max(0, total - samples) }
    : { samples, start: 0 };
}

function applyPreviewIntent(
  current: { samples: number; start: number },
  intent: ViewIntent,
): { samples: number; start: number } {
  switch (intent.kind) {
    case "keep_current":
      return current;
    case "set":
    case "animate_to":
      return { samples: intent.samples, start: intent.start_sample };
    case "pan_samples":
      return { samples: current.samples, start: current.start + intent.delta_samples };
    case "zoom": {
      const factor = Math.min(1_000, Math.max(0.001, intent.factor));
      const anchor = Math.min(1, Math.max(0, intent.anchor_ratio));
      const anchorSample = current.start + current.samples * anchor;
      const samples = Math.max(1, current.samples * factor);
      return { samples, start: anchorSample - samples * anchor };
    }
  }
}

/**
 * The current viewport, *without* storing it. A session that has never been
 * moved keeps recomputing its default, which is what lets a live capture follow
 * the tail as samples stream in. Materializing the default here would pin
 * whatever the capture happened to contain at that instant — including nothing
 * at all, which collapses the viewport to a single sample.
 */
function previewSessionView(sessionId: string): SessionView {
  const stored = previewViews.get(sessionId);
  const current = stored ?? defaultPreviewView(sessionId);
  const normalized = normalizePreviewView(sessionId, current.start, current.samples);
  return { samples: normalized.samples, start_sample: normalized.start };
}

function applyPreviewViewIntent(sessionId: string, intent: ViewIntent): SessionView {
  const current = previewViews.get(sessionId) ?? defaultPreviewView(sessionId);
  const next = applyPreviewIntent(current, intent);
  const normalized = normalizePreviewView(sessionId, next.start, next.samples);
  // A gesture is a real decision, so this one is remembered.
  previewViews.set(sessionId, normalized);
  return { samples: normalized.samples, start_sample: normalized.start };
}

export function previewSetViewLimits(sessionId: string, limits: ViewLimits): SessionView {
  previewViewLimits.set(sessionId, {
    live: limits.live,
    maximum_samples: limits.maximum_samples,
    sample_rate_hz: limits.sample_rate_hz,
  });
  // Re-clamp whatever the session already had. A session that never moved stays
  // on its default, so a live one keeps following the tail.
  const stored = previewViews.get(sessionId);
  if (stored) {
    const normalized = normalizePreviewView(sessionId, stored.start, stored.samples);
    previewViews.set(sessionId, normalized);
    return { samples: normalized.samples, start_sample: normalized.start };
  }
  return previewSessionView(sessionId);
}

export function previewApplyViewIntent(sessionId: string, intent: ViewIntent): SessionView {
  return applyPreviewViewIntent(sessionId, intent);
}

export function renderGraphFrame(
  sessionId: string,
  request: GraphFrameRequest,
): Promise<GraphFrameResponse> {
  if (isTauriRuntime()) {
    return callGraphFrameBackend(sessionId, request);
  }
  return Promise.resolve(
    withPreviewCapture(sessionId, () => {
      // The browser preview has no backend to own the viewport, so it keeps the
      // same state the Rust session keeps. Echoing the caller's range instead
      // would be wrong now that callers deliberately send an empty one when they
      // are driving the viewport with an intent.
      // `keep_current` is what the per-frame loop sends when nothing moved, so it
      // must be passive: remembering it would freeze a live session's tail
      // follow at whatever it happened to be on the first frame.
      const view =
        request.view && request.view.kind !== "keep_current"
          ? applyPreviewViewIntent(sessionId, request.view)
          : previewSessionView(sessionId);
      // Whenever the caller is driving the viewport, the range comes from the
      // session view — including for a passive `keep_current`, which is what the
      // per-frame loop sends. Falling back to the caller's own range there would
      // use the placeholder it deliberately sends and render a single sample.
      const waveform = request.view
        ? {
            ...request.waveform,
            start_sample: Math.max(0, Math.floor(view.start_sample)),
            sample_count: Math.max(
              1,
              Math.ceil(view.start_sample + view.samples) -
                Math.max(0, Math.floor(view.start_sample)),
            ),
          }
        : request.waveform;
      const analyzerView = request.analyzer_view ?? waveform;
      return {
        frame_id: request.frame_id,
        revision: previewCaptureRevisions.get(sessionId) ?? 0,
        sample_count: previewCapture.metadata.sample_count,
        view,
        data_view: view,
        tile: request.include_tile === false ? emptyPreviewTile(waveform) : buildPreviewTile(waveform),
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
    protocol_markers: [],
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

function buildPreviewAnalyzerFrameTableWindow(
  requests: AnalyzerFrameTableRequest[],
  start: number,
  end: number,
): AnalyzerFrameTableWindow {
  const sources = requests
    .map((request) => ({
      analyzerId: request.analyzer_id,
      frames: cachedPreviewAnalyzerFrames(request.settings),
    }))
    .filter((source) => source.frames.length > 0);
  const rowCount = sources.reduce((count, source) => count + source.frames.length, 0);
  const roles = previewAnalyzerFrameTableRoles(sources);
  const windowStart = Math.min(rowCount, Math.max(0, Math.trunc(start)));
  const windowEnd = Math.max(windowStart, Math.min(rowCount, Math.trunc(end)));
  if (windowStart >= windowEnd || sources.length === 0) {
    return { roles, row_count: rowCount, rows: [] };
  }
  if (sources.length === 1) {
    const source = sources[0];
    return {
      roles,
      row_count: rowCount,
      rows: source.frames.slice(windowStart, windowEnd).map((frame, offset) => ({
        analyzer_id: source.analyzerId,
        frame,
        frame_index: frame.frame_id,
        frame_number: windowStart + offset + 1,
      })),
    };
  }

  const positions = Array.from({ length: sources.length }, () => 0);
  const rows: AnalyzerFrameTableRow[] = [];
  for (let rowIndex = 0; rowIndex < windowEnd; rowIndex += 1) {
    const sourceIndex = nextPreviewAnalyzerTableSourceIndex(sources, positions);
    if (sourceIndex < 0) break;
    const framePosition = positions[sourceIndex];
    const frame = sources[sourceIndex].frames[framePosition];
    if (rowIndex >= windowStart) {
      rows.push({
        analyzer_id: sources[sourceIndex].analyzerId,
        frame,
        frame_index: frame.frame_id,
        frame_number: framePosition + 1,
      });
    }
    positions[sourceIndex] += 1;
  }
  return { roles, row_count: rowCount, rows };
}

function buildPreviewAnalyzerFrameTableSearchWindow(
  requests: AnalyzerFrameTableRequest[],
  query: string,
  start: number,
  end: number,
): AnalyzerFrameTableWindow {
  const fullWindow = buildPreviewAnalyzerFrameTableWindow(requests, 0, Number.MAX_SAFE_INTEGER);
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return buildPreviewAnalyzerFrameTableWindow(requests, start, end);
  const matching = fullWindow.rows.filter((row) =>
    previewAnalyzerFrameSearchText(row, requests).includes(normalizedQuery),
  );
  const windowStart = Math.min(matching.length, Math.max(0, Math.trunc(start)));
  const windowEnd = Math.max(windowStart, Math.min(matching.length, Math.trunc(end)));
  return {
    roles: fullWindow.roles,
    row_count: matching.length,
    rows: matching.slice(windowStart, windowEnd),
  };
}

function previewAnalyzerFrameSearchText(
  row: AnalyzerFrameTableRow,
  requests: AnalyzerFrameTableRequest[],
) {
  const request = requests.find((item) => item.analyzer_id === row.analyzer_id);
  const analyzerName = request?.analyzer_name ?? row.analyzer_id;
  const displayRadix = request?.display_radix ?? "Hexadecimal";
  let text = `${analyzerName} ${row.frame_number} ${row.frame.frame_type} ${formatPreviewAnalyzerText(row.frame.label, displayRadix, row.frame.value)}`;
  for (const value of row.frame.channel_values) {
    text += ` ${value.role} ${formatPreviewAnalyzerText(value.label, displayRadix, value.value)}`;
  }
  return text.toLowerCase();
}

function formatPreviewAnalyzerText(text: string, displayRadix: string, fallbackValue?: number) {
  const source = text || "";
  let replaced = false;
  const withExplicitTokens = source.replace(/0x[0-9a-f]+|0b[01]+/gi, (token) => {
    const parsed = parsePreviewAnalyzerNumericToken(token);
    if (!parsed) return token;
    replaced = true;
    return formatPreviewAnalyzerValue(parsed.value, displayRadix, parsed.bits);
  });
  if (replaced) return withExplicitTokens;
  const trimmed = source.trim();
  if (/^\d+$/.test(trimmed)) {
    const parsed = Number.parseInt(trimmed, 10);
    if (Number.isFinite(parsed)) {
      return source.replace(trimmed, formatPreviewAnalyzerValue(parsed, displayRadix, previewBitsForAnalyzerValue(parsed)));
    }
  }
  if (source === "" && typeof fallbackValue === "number" && Number.isFinite(fallbackValue)) {
    return formatPreviewAnalyzerValue(fallbackValue, displayRadix, previewBitsForAnalyzerValue(fallbackValue));
  }
  return source;
}

function parsePreviewAnalyzerNumericToken(token: string) {
  if (/^0x/i.test(token)) {
    const digits = token.slice(2);
    const value = Number.parseInt(digits, 16);
    return Number.isFinite(value) ? { bits: Math.max(8, digits.length * 4), value } : null;
  }
  if (/^0b/i.test(token)) {
    const digits = token.slice(2);
    const value = Number.parseInt(digits, 2);
    return Number.isFinite(value) ? { bits: Math.max(1, digits.length), value } : null;
  }
  return null;
}

function formatPreviewAnalyzerValue(value: number, displayRadix: string, bits = previewBitsForAnalyzerValue(value)) {
  const normalizedValue = Math.max(0, Math.trunc(value));
  if (displayRadix === "Decimal") return normalizedValue.toString(10);
  if (displayRadix === "Binary") return `0b${normalizedValue.toString(2).padStart(Math.max(1, bits), "0")}`;
  if (displayRadix === "Ascii") return formatPreviewAsciiAnalyzerValue(normalizedValue);
  return `0x${normalizedValue.toString(16).toUpperCase().padStart(Math.max(1, Math.ceil(bits / 4)), "0")}`;
}

function previewBitsForAnalyzerValue(value: number) {
  const normalizedValue = Math.max(0, Math.trunc(value));
  if (normalizedValue <= 0xff) return 8;
  return Math.max(1, Math.ceil(Math.log2(normalizedValue + 1)));
}

function formatPreviewAsciiAnalyzerValue(value: number): string {
  const byte = value & 0xff;
  const escaped =
    byte === 0x09
      ? "\\t"
      : byte === 0x0a
        ? "\\n"
        : byte === 0x0d
          ? "\\r"
          : byte === 0x27
            ? "\\'"
            : byte === 0x5c
              ? "\\\\"
              : byte >= 0x20 && byte <= 0x7e
                ? String.fromCharCode(byte)
                : null;
  return escaped === null ? formatPreviewAnalyzerValue(value, "Hexadecimal", previewBitsForAnalyzerValue(value)) : `'${escaped}'`;
}

function previewAnalyzerFrameTableRoles(
  sources: Array<{ analyzerId: string; frames: DecodedFrame[] }>,
) {
  const roles: string[] = [];
  for (const source of sources) {
    for (const frame of source.frames) {
      for (const value of frame.channel_values) {
        if (!roles.includes(value.role)) roles.push(value.role);
      }
    }
  }
  return roles;
}

function nextPreviewAnalyzerTableSourceIndex(
  sources: Array<{ analyzerId: string; frames: DecodedFrame[] }>,
  positions: number[],
) {
  let bestSourceIndex = -1;
  let bestFrame: DecodedFrame | null = null;
  for (let sourceIndex = 0; sourceIndex < sources.length; sourceIndex += 1) {
    const frame = sources[sourceIndex].frames[positions[sourceIndex]];
    if (!frame) continue;
    if (
      !bestFrame ||
      frame.start_sample < bestFrame.start_sample ||
      (frame.start_sample === bestFrame.start_sample && sourceIndex < bestSourceIndex)
    ) {
      bestSourceIndex = sourceIndex;
      bestFrame = frame;
    }
  }
  return bestSourceIndex;
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
  previewDemoSignalsBySession.delete(sessionId);
  if (!isTauriRuntime()) return Promise.resolve();
  return callBackend("release_graph_session", { sessionId });
}

function buildPreviewAnalyzerFrames(settings: AnalyzerDecodeSettings): DecodedFrame[] {
  if (settings.protocol === "Uart") return buildPreviewUartFrames(settings.settings);
  if (settings.protocol === "Native") return [];
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
    if (!previewI2cSettingsAreSimulated(settings.settings)) return [];
  } else if (!previewSpiSettingsAreSimulated(settings.settings)) {
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
    const value = settings.protocol === "I2c"
      ? [0x40, 0x90, 0x90][byteIndex]
      : (0x4c + sourceFrameId) & previewBitMask(settings.settings.bits_per_transfer);
    const misoValue = (value + 1) & 0xff;
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
                  ? `Setup Write to [${labelForPreviewByte(value >> 1)}] + ACK`
                  : `${labelForPreviewByte(value)} + ${byteIndex === 2 ? "NAK" : "ACK"}`,
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
      frame_type:
        settings.protocol === "I2c" ? (byteIndex === 0 ? "address" : "data") : "result",
      label:
        settings.protocol === "I2c"
          ? byteIndex === 0
            ? `Address ${labelForPreviewByte(value >> 1)} Write ACK`
            : `Data 0x${value.toString(16).padStart(2, "0").toUpperCase()} ${byteIndex === 2 ? "NAK" : "ACK"}`
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
  if (!previewUartSettingsAreSimulated(request) || request.baud_rate <= 0) {
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
  const previousFrame = firstCandidate > 0 ? frames[firstCandidate - 1] : null;
  const nextFrame =
    visibleCount > PREVIEW_MAX_ANALYZER_MARKER_RESULTS
      ? frames[firstCandidate + PREVIEW_MAX_ANALYZER_MARKER_RESULTS]
      : visibleEnd < frames.length
        ? frames[visibleEnd]
        : null;
  const bubbles = buildAnalyzerBubblesFromFrameRange(
    frames,
    firstCandidate,
    visibleEnd,
    sampleCount,
    widthPx,
  );
  return {
    bubbles,
    frame_refs: limited.map(analyzerFrameRef),
    frames: limited,
    previous_frame_ref: previousFrame ? analyzerFrameRef(previousFrame) : null,
    previous_frame: previousFrame,
    next_frame_ref: nextFrame ? analyzerFrameRef(nextFrame) : null,
    next_frame: nextFrame,
  };
}

function analyzerFrameRef(frame: DecodedFrame): AnalyzerFrameRef {
  return {
    frame_id: frame.frame_id,
    start_sample: frame.start_sample,
    end_sample: frame.end_sample,
  };
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

function buildAnalyzerBubblesFromFrameRange(
  frames: DecodedFrame[],
  begin: number,
  end: number,
  viewportSamples: number,
  widthPx: number,
): AnalyzerBubble[] {
  const accumulators: BubbleAccumulator[] = [];
  for (let index = begin; index < end; index += 1) {
    appendFrameToBubbleAccumulators(accumulators, frames[index], viewportSamples, widthPx);
  }
  return enforceMaximumBubbleResults(finalizeBubbleAccumulators(accumulators), widthPx);
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

function enforceMaximumBubbleResults(bubbles: AnalyzerBubble[], widthPx: number): AnalyzerBubble[] {
  const maximumResults = Math.min(
    PREVIEW_MAX_ANALYZER_BUBBLE_RESULTS,
    Math.max(PREVIEW_MAX_ANALYZER_MARKER_RESULTS, Math.ceil(widthPx)),
  );
  if (bubbles.length <= maximumResults) return bubbles;
  const bucketSize = Math.ceil(bubbles.length / maximumResults);
  const merged: AnalyzerBubble[] = [];
  for (let index = 0; index < bubbles.length; index += bucketSize) {
    const bucketEnd = Math.min(bubbles.length, index + bucketSize);
    if (bucketEnd - index === 1) {
      merged.push(bubbles[index]);
      continue;
    }
    merged.push(mergeBubbleRange(bubbles, index, bucketEnd));
  }
  return merged;
}

function mergeBubbleRange(bubbles: AnalyzerBubble[], begin: number, end: number): AnalyzerBubble {
  const first = bubbles[begin];
  const last = bubbles[end - 1];
  const displayText: string[] = [];
  let resultCount = 0;
  for (let index = begin; index < end; index += 1) {
    const bubble = bubbles[index];
    resultCount += bubble.result_count;
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
    result_count: resultCount,
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

const PREVIEW_UART_MESSAGE = Array.from(new TextEncoder().encode("SigPilot demo\n"));
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
    frame_type: "data",
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
    readme: `# ${featureName}\n\nGenerated SigPilot extension template for ${extensionTypeName(request.type)}.`,
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
      const [previousTransition, nextTransition] = findPreviewTransitionsOutsideRange(
        channel,
        startSample,
        endSample,
        metadata.sample_count,
        metadata.sample_rate_hz,
      );
      return {
        channel,
        label: metadata.labels[channel] ?? `D${channel}`,
        segments: exact.segments,
        rising_edges: exact.rising_edges,
        falling_edges: exact.falling_edges,
        previous_transition: previousTransition,
        next_transition: nextTransition,
        bins,
      };
    }),
  };
}

function emptyPreviewTile(request: WaveformRequest): WaveformTile {
  return {
    start_sample: Math.max(0, Math.round(request.start_sample)),
    sample_count: 0,
    pixels: Math.max(0, Math.round(request.pixels)),
    samples_per_pixel: 0,
    channels: [],
  };
}

function findPreviewTransitionsOutsideRange(
  channel: number,
  startSample: number,
  endSample: number,
  totalSamples: number,
  sampleRateHz: number,
): [number | null, number | null] {
  return [
    findPreviewTransition(channel, startSample, totalSamples, sampleRateHz, "previous"),
    findPreviewTransition(channel, endSample, totalSamples, sampleRateHz, "next"),
  ];
}

function measurePreviewDigitalPoint(
  request: DigitalPointMeasurementRequest,
): DigitalPointMeasurement | null {
  const metadata = previewCapture.metadata;
  if (request.channel < 0 || request.channel >= metadata.channel_count || metadata.sample_count <= 0) {
    return null;
  }
  const cursorSample = Math.max(
    0,
    Math.min(metadata.sample_count - 1, Math.round(request.sample)),
  );
  const widthStart = findPreviewTransition(
    request.channel,
    cursorSample + 1,
    metadata.sample_count,
    metadata.sample_rate_hz,
    "previous",
  );
  const widthEnd = findPreviewTransition(
    request.channel,
    cursorSample + 1,
    metadata.sample_count,
    metadata.sample_rate_hz,
    "next",
  );
  if (widthStart == null || widthEnd == null) return null;

  return {
    channel: request.channel,
    cursor_sample: cursorSample,
    high: previewDigitalLevelAt(cursorSample, request.channel, metadata.sample_rate_hz),
    width_start_sample: widthStart,
    width_end_sample: widthEnd,
    period_end_sample: findPreviewTransition(
      request.channel,
      widthEnd + 1,
      metadata.sample_count,
      metadata.sample_rate_hz,
      "next",
    ),
  };
}

function findPreviewTransition(
  channel: number,
  boundary: number,
  totalSamples: number,
  sampleRateHz: number,
  direction: "previous" | "next",
) {
  const signal = previewSignalForChannel(channel);
  if (signal.kind === "Pulse") {
    return findPreviewPulseTransition(previewPulseProfile(channel), boundary, totalSamples, direction);
  }

  const bitPeriod = signal.kind === "Uart" ? sampleRateHz / Math.max(1, signal.settings.baud_rate) : 0;
  if (signal.kind === "Uart" && bitPeriod < 2) {
    return findPreviewPulseTransition(previewPulseProfile(channel), boundary, totalSamples, direction);
  }
  const step =
    signal.kind === "Uart"
      ? bitPeriod
      : signal.kind === "I2c"
        ? Math.max(2, Math.round(sampleRateHz / 200_000))
        : Math.max(2, Math.round(sampleRateHz / 2_000_000));
  let candidateIndex =
    direction === "previous"
      ? Math.ceil(boundary / step) - 1
      : Math.max(1, Math.floor(boundary / step));

  for (let attempts = 0; attempts < 8_192 && candidateIndex > 0; attempts += 1) {
    const edgeSample = Math.round(candidateIndex * step);
    if (direction === "previous" && edgeSample >= boundary) {
      candidateIndex -= 1;
      continue;
    }
    if (direction === "next" && edgeSample < boundary) {
      candidateIndex += 1;
      continue;
    }
    if (edgeSample <= 0 || edgeSample >= totalSamples) return null;

    const before =
      signal.kind === "Uart"
        ? previewUartLevelAtBit(candidateIndex - 1, signal.settings)
        : previewDigitalLevelAt(edgeSample - 1, channel, sampleRateHz);
    const after =
      signal.kind === "Uart"
        ? previewUartLevelAtBit(candidateIndex, signal.settings)
        : previewDigitalLevelAt(edgeSample, channel, sampleRateHz);
    if (before !== after) return edgeSample;
    candidateIndex += direction === "previous" ? -1 : 1;
  }
  return null;
}

function findPreviewPulseTransition(
  profile: PreviewPulseProfile,
  boundary: number,
  totalSamples: number,
  direction: "previous" | "next",
) {
  const cycleStart = Math.floor(boundary / profile.cycleSamples) * profile.cycleSamples;
  const boundaries = profile.cumulative.slice(0, -1);
  if (direction === "previous") {
    for (let index = boundaries.length - 1; index >= 0; index -= 1) {
      const edgeSample = cycleStart + boundaries[index];
      if (edgeSample > 0 && edgeSample < boundary) return edgeSample;
    }
    const edgeSample = cycleStart - profile.cycleSamples + boundaries[boundaries.length - 1];
    return edgeSample > 0 && edgeSample < boundary ? edgeSample : null;
  }

  for (const offset of boundaries) {
    const edgeSample = cycleStart + offset;
    if (edgeSample > 0 && edgeSample >= boundary && edgeSample < totalSamples) return edgeSample;
  }
  const edgeSample = cycleStart + profile.cycleSamples;
  return edgeSample > 0 && edgeSample >= boundary && edgeSample < totalSamples ? edgeSample : null;
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
    buildPreviewDigitalSegments(
      startSample,
      endSample,
      channel,
      sampleRateHz,
      PREVIEW_EXACT_SEGMENT_LIMIT,
    ) ?? { segments: [], rising_edges: [], falling_edges: [] }
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
  const signal = previewSignalForChannel(channel);
  if (signal.kind === "Uart") {
    return buildPreviewUartDigitalSegments(
      startSample,
      endSample,
      sampleRateHz,
      maxSegments,
      channel,
      signal.settings,
    );
  }
  if (signal.kind === "I2c") {
    return buildPreviewI2cDigitalSegments(
      startSample,
      endSample,
      sampleRateHz,
      maxSegments,
      signal.settings,
      signal.role,
    );
  }
  if (signal.kind === "Spi") {
    return buildPreviewSpiDigitalSegments(
      startSample,
      endSample,
      sampleRateHz,
      maxSegments,
      signal.settings,
      signal.role,
    );
  }
  return buildPreviewPulseDigitalSegments(startSample, endSample, channel, maxSegments);
}

function buildPreviewI2cDigitalSegments(
  startSample: number,
  endSample: number,
  sampleRateHz: number,
  maxSegments: number,
  settings: I2cDecodeSettings,
  role: "Sda" | "Scl",
): PreviewDigitalData | null {
  const halfPeriod = Math.max(2, Math.round(sampleRateHz / 200_000));
  return buildPreviewPeriodicDigitalSegments(
    startSample,
    endSample,
    halfPeriod,
    maxSegments,
    (sample) => previewI2cLevelAt(sample, sampleRateHz, settings, role),
  );
}

function buildPreviewSpiDigitalSegments(
  startSample: number,
  endSample: number,
  sampleRateHz: number,
  maxSegments: number,
  settings: SpiDecodeSettings,
  role: "Mosi" | "Miso" | "Clock" | "Enable",
): PreviewDigitalData | null {
  const halfPeriod = Math.max(2, Math.round(sampleRateHz / 2_000_000));
  return buildPreviewPeriodicDigitalSegments(
    startSample,
    endSample,
    halfPeriod,
    maxSegments,
    (sample) => previewSpiLevelAt(sample, sampleRateHz, settings, role),
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

function previewI2cByte(byteIndex: number) {
  return [0x40, 0x90, 0x90][positiveModulo(byteIndex, 3)];
}

function previewI2cLevelAt(
  sample: number,
  sampleRateHz: number,
  _settings: I2cDecodeSettings,
  role: "Sda" | "Scl",
) {
  const halfPeriod = Math.max(2, Math.round(sampleRateHz / 200_000));
  const phase = positiveModulo(Math.floor(sample / halfPeriod), 60);
  if (phase < 2) return true;
  if (phase === 2) return role === "Scl";
  const dataPhase = phase - 3;
  if (dataPhase < 54) {
    const byteIndex = Math.floor(dataPhase / 18);
    const bitIndex = Math.floor((dataPhase % 18) / 2);
    const byte = previewI2cByte(byteIndex);
    if (role === "Scl") return dataPhase % 2 === 1;
    if (bitIndex === 8) return byteIndex === 2;
    return (byte & (1 << (7 - bitIndex))) !== 0;
  }
  if (phase === 57) return false;
  if (phase === 58) return role === "Scl";
  return true;
}

function previewSpiLevelAt(
  sample: number,
  sampleRateHz: number,
  settings: SpiDecodeSettings,
  role: "Mosi" | "Miso" | "Clock" | "Enable",
) {
  const halfPeriod = Math.max(2, Math.round(sampleRateHz / 2_000_000));
  const transferHalfPeriods = Math.max(1, settings.bits_per_transfer) * 2 + 4;
  const phase = positiveModulo(Math.floor(sample / halfPeriod), transferHalfPeriods);
  const active = phase >= 2 && phase < transferHalfPeriods - 2;
  if (role === "Enable") return active !== settings.enable_active_low;
  if (role === "Clock") return (active && phase % 2 === 1) !== settings.clock_polarity;
  if (!active) return false;
  const wireBit = Math.min(settings.bits_per_transfer - 1, Math.floor((phase - 2) / 2));
  const bitIndex = settings.msb_first ? settings.bits_per_transfer - 1 - wireBit : wireBit;
  const transferIndex = Math.floor(sample / (halfPeriod * transferHalfPeriods));
  const mosi = (0x4c + transferIndex) & previewBitMask(settings.bits_per_transfer);
  const value = role === "Mosi" ? mosi : (mosi + 1) & previewBitMask(settings.bits_per_transfer);
  return Math.floor(value / 2 ** bitIndex) % 2 === 1;
}

function buildPreviewUartDigitalSegments(
  startSample: number,
  endSample: number,
  sampleRateHz: number,
  maxSegments: number,
  channel: number,
  settings: UartDecodeSettings,
): PreviewDigitalData | null {
  const bitPeriod = sampleRateHz / Math.max(1, settings.baud_rate);
  if (bitPeriod < 2) return buildPreviewPulseDigitalSegments(startSample, endSample, channel, maxSegments);
  const firstBit = Math.max(0, Math.floor(startSample / bitPeriod));
  const lastBit = Math.max(firstBit, Math.floor(Math.max(startSample, endSample - 1) / bitPeriod));
  if (lastBit - firstBit > maxSegments) return null;

  const segments: DigitalSegment[] = [];
  const rising_edges: number[] = [];
  const falling_edges: number[] = [];
  let previousHigh = previewUartLevelAtBit(firstBit, settings);
  let runStart = startSample;

  for (let bit = firstBit; bit <= lastBit; bit += 1) {
    const high = previewUartLevelAtBit(bit, settings);
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

function previewUartLevelAtBit(bitIndex: number, settings?: UartDecodeSettings) {
  const cycleBit = positiveModulo(bitIndex, PREVIEW_UART_CYCLE_BITS);
  if (cycleBit < PREVIEW_UART_LEAD_IDLE_BITS) return settings?.inverted ? false : true;
  const messageBit = cycleBit - PREVIEW_UART_LEAD_IDLE_BITS;
  if (messageBit >= PREVIEW_UART_MESSAGE.length * 10) return settings?.inverted ? false : true;

  const byte = PREVIEW_UART_MESSAGE[Math.floor(messageBit / 10)];
  const frameBit = messageBit % 10;
  const high = frameBit === 0 ? false : frameBit === 9 ? true : ((byte >> (frameBit - 1)) & 1) !== 0;
  return settings?.inverted ? !high : high;
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
  const signal = previewSignalForChannel(channel);
  const uartSettings = signal.kind === "Uart" ? signal.settings : null;
  const bitPeriod = uartSettings ? sampleRateHz / Math.max(1, uartSettings.baud_rate) : 0;
  const transitionScanPeriod = previewTransitionScanPeriod(signal, sampleRateHz);
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

    if (uartSettings && bitPeriod >= 2) {
      const firstBoundary = Math.floor(sample0 / bitPeriod) + 1;
      const lastBoundary = Math.floor(sample1 / bitPeriod);
      if (lastBoundary - firstBoundary > 32) {
        hasHigh = true;
        hasLow = true;
        edges = 2;
      } else {
        for (let boundary = firstBoundary; boundary <= lastBoundary; boundary += 1) {
          const previous = previewUartLevelAtBit(boundary - 1, uartSettings);
          const next = previewUartLevelAtBit(boundary, uartSettings);
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
    } else if (transitionScanPeriod !== null) {
      const firstBoundary = Math.floor(sample0 / transitionScanPeriod) + 1;
      const lastBoundary = Math.ceil(sample1 / transitionScanPeriod) - 1;
      const boundaryCount = Math.max(0, lastBoundary - firstBoundary + 1);

      if (boundaryCount > PREVIEW_BIN_EDGE_SCAN_LIMIT) {
        hasHigh = true;
        hasLow = true;
        edges = 2;
      } else {
        for (let boundary = firstBoundary; boundary <= lastBoundary; boundary += 1) {
          const edgeSample = boundary * transitionScanPeriod;
          const previous = previewDigitalLevelAt(Math.max(0, edgeSample - 1), channel, sampleRateHz);
          const next = previewDigitalLevelAt(edgeSample, channel, sampleRateHz);
          hasHigh ||= previous || next;
          hasLow ||= !previous || !next;
          if (previous !== next) {
            edges += 1;
            const offset = Math.max(0, Math.round(edgeSample - sample0));
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

function previewTransitionScanPeriod(signal: PreviewDemoSignal, sampleRateHz: number) {
  if (signal.kind === "I2c") return Math.max(2, Math.round(sampleRateHz / 200_000));
  if (signal.kind === "Spi") return Math.max(2, Math.round(sampleRateHz / 2_000_000));
  return null;
}

function previewDigitalLevelAt(sample: number, channel: number, sampleRateHz: number) {
  const signal = previewSignalForChannel(channel);
  if (signal.kind === "Uart") {
    const bitPeriod = sampleRateHz / Math.max(1, signal.settings.baud_rate);
    if (bitPeriod >= 2) return previewUartLevelAtBit(Math.floor(sample / bitPeriod), signal.settings);
  } else if (signal.kind === "I2c") {
    return previewI2cLevelAt(sample, sampleRateHz, signal.settings, signal.role);
  } else if (signal.kind === "Spi") {
    return previewSpiLevelAt(sample, sampleRateHz, signal.settings, signal.role);
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
