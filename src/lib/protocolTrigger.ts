import type { AnalyzerDecodeSettings, CaptureSettings } from "./api.ts";
import { analyzerDecodeSettings, type UiAnalyzerInstance } from "./analyzers.ts";

export type ProtocolTriggerDecoder = Extract<AnalyzerDecodeSettings, { protocol: "Uart" | "I2c" | "Spi" }>;
export type ProtocolTriggerCondition =
  | { type: "uart_sequence"; bytes: number[] }
  | { type: "i2c"; address: number | null; event: "address" | "data" | "nack"; data: number | null }
  | { type: "spi_sequence"; values: number[]; line: "mosi" | "miso" };

export interface ProtocolTriggerConfig {
  analyzer_id: string;
  decoder: ProtocolTriggerDecoder;
  condition: ProtocolTriggerCondition;
  pre_trigger_ms: number;
  post_trigger_ms: number;
  max_wait_ms: number;
}

export interface UiAnalyzerTriggerState {
  analyzerId: string;
  enabled: boolean;
  expanded: boolean;
  query: string;
  i2cAddress: string;
  i2cEvent: "address" | "data" | "nack";
  i2cData: string;
  spiLine: "mosi" | "miso";
  preTriggerMs: number;
  postTriggerMs: number;
  maxWaitMs: number;
}

export function defaultProtocolTrigger(): UiAnalyzerTriggerState {
  return { analyzerId: "", enabled: false, expanded: false, query: "", i2cAddress: "",
    i2cEvent: "nack", i2cData: "", spiLine: "mosi", preTriggerMs: 100, postTriggerMs: 20, maxWaitMs: 10_000 };
}

export type ProtocolTriggerErrorCode = "desktopOnly" | "select" | "stream" | "hardware" | "duration" |
  "hex" | "length" | "value" | "channels" | "uartFormat" | "uartRate" | "spiFormat" | "spiLine" | "rawFormat";
export class ProtocolTriggerValidationError extends Error {
  readonly code: ProtocolTriggerErrorCode;
  constructor(code: ProtocolTriggerErrorCode) { super(code); this.code = code; }
}
function fail(code: ProtocolTriggerErrorCode): never { throw new ProtocolTriggerValidationError(code); }

/** Reject unsupported catalog/HLA configurations rather than substituting defaults. */
export function protocolTriggerDecoder(analyzer: UiAnalyzerInstance): ProtocolTriggerDecoder | null {
  const decoder = analyzerDecodeSettings(analyzer);
  return decoder && ["Uart", "I2c", "Spi"].includes(decoder.protocol) ? decoder as ProtocolTriggerDecoder : null;
}

export function parseTriggerHex(input: string, bits: number, maxLength = 64): number[] {
  const tokens = input.trim().split(/[\s,]+/).filter(Boolean);
  if (!tokens.length || tokens.length > maxLength) fail("length");
  return tokens.map((token) => {
    if (!/^(?:0x)?[0-9a-f]+$/i.test(token)) fail("hex");
    const value = Number.parseInt(token.replace(/^0x/i, ""), 16);
    if (!Number.isSafeInteger(value) || value < 0 || value > 2 ** bits - 1) fail("value");
    return value;
  });
}

export function buildProtocolTrigger(
  state: UiAnalyzerTriggerState, analyzers: UiAnalyzerInstance[], settings: CaptureSettings, desktop: boolean,
): ProtocolTriggerConfig | undefined {
  if (!state.enabled) return undefined;
  if (!desktop) fail("desktopOnly");
  const analyzer = analyzers.find((item) => item.id === state.analyzerId);
  const decoder = analyzer ? protocolTriggerDecoder(analyzer) : null;
  if (!decoder) fail("select");
  if (settings.mode !== "Stream") fail("stream");
  if (!settings.decode_cross && settings.device_id !== "fake:sigpilot-demo" && !settings.device_id.startsWith("usb-kingst:")) fail("rawFormat");
  if (settings.trigger_enabled || settings.external_trigger_mode !== "Close" || settings.trigger_out_enabled) fail("hardware");
  if (![state.preTriggerMs, state.postTriggerMs, state.maxWaitMs].every(Number.isSafeInteger) ||
      state.preTriggerMs < 0 || state.postTriggerMs < 0 || state.maxWaitMs < 1 ||
      state.preTriggerMs > 60_000 || state.postTriggerMs > 60_000 || state.maxWaitMs > 3_600_000) fail("duration");
  let channels: Array<number | null>;
  let condition: ProtocolTriggerCondition;
  switch (decoder.protocol) {
    case "Uart": {
      const config = decoder.settings;
      if (!Number.isInteger(config.data_bits) || config.data_bits < 5 || config.data_bits > 8 ||
          ![1, 1.5, 2].includes(config.stop_bits) || !["none", "even", "odd"].includes(config.parity)) fail("uartFormat");
      if (!Number.isInteger(config.baud_rate) || config.baud_rate <= 0 || settings.sample_rate_hz < config.baud_rate * 8) fail("uartRate");
      channels = [config.channel];
      condition = { type: "uart_sequence", bytes: parseTriggerHex(state.query, config.data_bits) };
      break;
    }
    case "I2c":
      channels = [decoder.settings.sda_channel, decoder.settings.scl_channel];
      condition = { type: "i2c", event: state.i2cEvent,
        address: state.i2cAddress.trim() ? parseTriggerHex(state.i2cAddress, 7, 1)[0] : null,
        data: state.i2cEvent !== "address" && state.i2cData.trim() ? parseTriggerHex(state.i2cData, 8, 1)[0] : null };
      break;
    case "Spi": {
      const config = decoder.settings;
      if (!Number.isInteger(config.bits_per_transfer) || config.bits_per_transfer < 1 || config.bits_per_transfer > 32) fail("spiFormat");
      if ((state.spiLine === "mosi" ? config.mosi_channel : config.miso_channel) === null) fail("spiLine");
      channels = [config.clock_channel, config.mosi_channel, config.miso_channel, config.enable_channel];
      condition = { type: "spi_sequence", line: state.spiLine, values: parseTriggerHex(state.query, config.bits_per_transfer) };
      break;
    }
  }
  const active = channels.filter((channel): channel is number => channel !== null);
  if (new Set(active).size !== active.length || active.some((channel) => !Number.isInteger(channel) || channel < 0 ||
      channel >= settings.channel_count || (settings.enabled_channels.length > 0 && !settings.enabled_channels.includes(channel)))) fail("channels");
  return { analyzer_id: state.analyzerId, decoder, condition, pre_trigger_ms: state.preTriggerMs,
    post_trigger_ms: state.postTriggerMs, max_wait_ms: state.maxWaitMs };
}
