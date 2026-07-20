import type { AnalyzerBubble, AnalyzerDecodeSettings, DecodedFrame } from "./api";

// Ported from Logic 2.4.43 uikit/utils/colors.ts.
export const SALEAE_ANALYZER_COLORS = [
  "#7EA0F8",
  "#D881F7",
  "#F69898",
  "#75CACA",
  "#D1B56E",
  "#7ACB8C",
  "#95A0B4",
  "#ABA48B",
] as const;

// Ported from Logic 2.4.43 app/utils/defaults.ts.
export const ANALYZER_BUBBLES_HEIGHT_PX = 16;
export const ANALYZER_BUBBLES_PADDING_PX = 4;
export const ANALYZER_STRIP_HEIGHT_PX = ANALYZER_BUBBLES_HEIGHT_PX + ANALYZER_BUBBLES_PADDING_PX;

export interface UiAnalyzerInstance {
  id: string;
  type: string;
  name: string;
  color: string;
  channel: number;
  baudRate: number;
  inverted: boolean;
  i2cSdaChannel: number;
  i2cSclChannel: number;
  spiMosiChannel: number | null;
  spiMisoChannel: number | null;
  spiClockChannel: number;
  spiEnableChannel: number | null;
  spiEnableActiveLow: boolean;
  spiClockPolarity: boolean;
  spiClockPhase: boolean;
  spiBitsPerTransfer: number;
  spiMsbFirst: boolean;
  showInDataTable: boolean;
  streamToTerminal: boolean;
  protocolBubbles: AnalyzerBubble[];
  decodedFrames: DecodedFrame[];
  previousFrame: DecodedFrame | null;
  nextFrame: DecodedFrame | null;
  decodeBusy: boolean;
  highlightedFrameIndex: number | null;
}

export function analyzerDisplayName(type: string, analyzers: UiAnalyzerInstance[]) {
  const matching = analyzers.filter((analyzer) => analyzer.type === type);
  if (matching.length === 0) return type;

  let suffix = 1;
  while (matching.some((analyzer) => analyzer.name === `${type} [${suffix}]`)) suffix += 1;
  return `${type} [${suffix}]`;
}

export function createAnalyzerInstance(
  type: string,
  analyzers: UiAnalyzerInstance[],
  channel = 0,
): UiAnalyzerInstance {
  const index = analyzers.length;
  const nextChannel = (offset: number) => (channel + offset) % 32;
  return {
    id: `analyzer-${Date.now()}-${index}`,
    type,
    name: analyzerDisplayName(type, analyzers),
    color: SALEAE_ANALYZER_COLORS[index % SALEAE_ANALYZER_COLORS.length],
    channel,
    baudRate: 115_200,
    inverted: false,
    i2cSdaChannel: channel,
    i2cSclChannel: nextChannel(1),
    spiMosiChannel: channel,
    spiMisoChannel: nextChannel(1),
    spiClockChannel: nextChannel(2),
    spiEnableChannel: nextChannel(3),
    spiEnableActiveLow: true,
    spiClockPolarity: false,
    spiClockPhase: false,
    spiBitsPerTransfer: 8,
    spiMsbFirst: true,
    showInDataTable: true,
    streamToTerminal: false,
    protocolBubbles: [],
    decodedFrames: [],
    previousFrame: null,
    nextFrame: null,
    decodeBusy: false,
    highlightedFrameIndex: null,
  };
}

export function analyzerStripInsetForChannel(analyzers: UiAnalyzerInstance[], channel: number) {
  return analyzers.filter((analyzer) => analyzer.channel === channel).length * ANALYZER_STRIP_HEIGHT_PX;
}

export function analyzerSupportsDecoding(analyzer: Pick<UiAnalyzerInstance, "type">) {
  return analyzer.type === "Async Serial" || analyzer.type === "I2C" || analyzer.type === "SPI";
}

export function analyzerDecodeSettings(analyzer: UiAnalyzerInstance): AnalyzerDecodeSettings | null {
  if (analyzer.type === "Async Serial") {
    return {
      protocol: "Uart",
      settings: {
        channel: analyzer.channel,
        baud_rate: analyzer.baudRate,
        inverted: analyzer.inverted,
      },
    };
  }
  if (analyzer.type === "I2C") {
    return {
      protocol: "I2c",
      settings: {
        sda_channel: analyzer.i2cSdaChannel,
        scl_channel: analyzer.i2cSclChannel,
      },
    };
  }
  if (analyzer.type === "SPI") {
    return {
      protocol: "Spi",
      settings: {
        mosi_channel: analyzer.spiMosiChannel,
        miso_channel: analyzer.spiMisoChannel,
        clock_channel: analyzer.spiClockChannel,
        enable_channel: analyzer.spiEnableChannel,
        enable_active_low: analyzer.spiEnableActiveLow,
        clock_polarity: analyzer.spiClockPolarity,
        clock_phase: analyzer.spiClockPhase,
        bits_per_transfer: analyzer.spiBitsPerTransfer,
        msb_first: analyzer.spiMsbFirst,
      },
    };
  }
  return null;
}

export function analyzerChannelIndexes(analyzer: UiAnalyzerInstance) {
  const channels =
    analyzer.type === "I2C"
      ? [analyzer.i2cSdaChannel, analyzer.i2cSclChannel]
      : analyzer.type === "SPI"
        ? [
            analyzer.spiMosiChannel,
            analyzer.spiMisoChannel,
            analyzer.spiClockChannel,
            analyzer.spiEnableChannel,
          ]
        : [analyzer.channel];
  return [...new Set(channels.filter((channel): channel is number => channel !== null))];
}

export function analyzerDecodeSignature(analyzer: UiAnalyzerInstance) {
  return JSON.stringify(analyzerDecodeSettings(analyzer));
}
