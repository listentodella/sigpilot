import type {
  AnalyzerBubble,
  AnalyzerDecodeSettings,
  AnalyzerTrackWindow,
  DecoderBackendKind,
  DecodedFrame,
  SaleaeAnalyzerMetadata,
} from "./api";

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
  decoderBackend: DecoderBackendKind;
  configurationValid: boolean;
  channel: number;
  baudRate: number;
  inverted: boolean;
  uartDataBits: number;
  uartStopBits: number;
  uartParity: "none" | "even" | "odd";
  uartMsbFirst: boolean;
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
  displayRadix: string;
  saleaeMetadata: unknown | null;
  protocolBubbles: AnalyzerBubble[];
  decodedFrames: DecodedFrame[];
  previousFrame: DecodedFrame | null;
  nextFrame: DecodedFrame | null;
  renderedTracks: AnalyzerTrackWindow[];
  renderedDecodeSignature: string | null;
  decodeBusy: boolean;
  highlightedFrameIndex: number | null;
}

export interface AnalyzerChannelRole {
  channel: number;
  hasBubbles: boolean;
  hasMarkers: boolean;
  title: string;
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
  decoderBackend: DecoderBackendKind = "sigrok_native",
): UiAnalyzerInstance {
  const index = analyzers.length;
  const nextChannel = (offset: number) => (channel + offset) % 32;
  return {
    id: `analyzer-${Date.now()}-${index}`,
    type,
    name: analyzerDisplayName(type, analyzers),
    color: SALEAE_ANALYZER_COLORS[index % SALEAE_ANALYZER_COLORS.length],
    decoderBackend,
    configurationValid: true,
    channel,
    baudRate: 115_200,
    inverted: false,
    uartDataBits: 8,
    uartStopBits: 1,
    uartParity: "none",
    uartMsbFirst: false,
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
    displayRadix: "Hexadecimal",
    saleaeMetadata: null,
    protocolBubbles: [],
    decodedFrames: [],
    previousFrame: null,
    nextFrame: null,
    renderedTracks: [],
    renderedDecodeSignature: null,
    decodeBusy: false,
    highlightedFrameIndex: null,
  };
}

export function analyzerChannelRoles(analyzer: UiAnalyzerInstance): AnalyzerChannelRole[] {
  if (analyzer.type === "I2C") {
    return [
      {
        channel: analyzer.i2cSdaChannel,
        hasBubbles: true,
        hasMarkers: false,
        title: "SDA",
      },
      {
        channel: analyzer.i2cSclChannel,
        hasBubbles: false,
        hasMarkers: true,
        title: "SCL",
      },
    ];
  }

  if (analyzer.type === "SPI") {
    return [
      analyzer.spiMosiChannel === null
        ? null
        : {
            channel: analyzer.spiMosiChannel,
            hasBubbles: true,
            hasMarkers: false,
            title: "MOSI",
          },
      analyzer.spiMisoChannel === null
        ? null
        : {
            channel: analyzer.spiMisoChannel,
            hasBubbles: true,
            hasMarkers: false,
            title: "MISO",
          },
      {
        channel: analyzer.spiClockChannel,
        hasBubbles: false,
        hasMarkers: true,
        title: "Clock",
      },
      analyzer.spiEnableChannel === null
        ? null
        : {
            channel: analyzer.spiEnableChannel,
            hasBubbles: false,
            hasMarkers: false,
            title: "Enable",
          },
    ].filter((role): role is AnalyzerChannelRole => role !== null);
  }

  return [
    {
      channel: analyzer.channel,
      hasBubbles: true,
      hasMarkers: false,
      title: "Input",
    },
  ];
}

export function analyzerBubbleRoles(analyzer: UiAnalyzerInstance) {
  return analyzerChannelRoles(analyzer).filter((role) => role.hasBubbles);
}

export function analyzerMarkerRoles(analyzer: UiAnalyzerInstance) {
  return analyzerChannelRoles(analyzer).filter((role) => role.hasMarkers);
}

export function analyzerChannelRoleLabel(analyzer: UiAnalyzerInstance, role: AnalyzerChannelRole) {
  return `${analyzer.name} - ${role.title}`;
}

export function analyzerStripInsetForChannel(analyzers: UiAnalyzerInstance[], channel: number) {
  return analyzers.reduce(
    (height, analyzer) =>
      height + analyzerBubbleRoles(analyzer).filter((role) => role.channel === channel).length * ANALYZER_STRIP_HEIGHT_PX,
    0,
  );
}

export function analyzerSupportsDecoding(analyzer: Pick<UiAnalyzerInstance, "type">) {
  return analyzer.type === "Async Serial" || analyzer.type === "I2C" || analyzer.type === "SPI";
}

export function analyzerDecodeSettings(analyzer: UiAnalyzerInstance): AnalyzerDecodeSettings | null {
  if (!analyzer.configurationValid) return null;
  if (analyzer.type === "Async Serial") {
    return {
      protocol: "Uart",
      settings: {
        channel: analyzer.channel,
        baud_rate: analyzer.baudRate,
        inverted: analyzer.inverted,
        data_bits: analyzer.uartDataBits,
        stop_bits: analyzer.uartStopBits,
        parity: analyzer.uartParity,
        msb_first: analyzer.uartMsbFirst,
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

export function restoreSaleaeAnalyzer(
  metadata: SaleaeAnalyzerMetadata,
  analyzers: UiAnalyzerInstance[],
): UiAnalyzerInstance {
  const type = metadata.type === "Serial" ? "Async Serial" : metadata.type;
  const settings = metadata.decode_settings;
  const primaryChannel =
    settings?.protocol === "Uart"
      ? settings.settings.channel
      : settings?.protocol === "I2c"
        ? settings.settings.sda_channel
        : settings?.protocol === "Spi"
          ? (settings.settings.mosi_channel ?? settings.settings.miso_channel ?? settings.settings.clock_channel)
          : 0;
  const restored = {
    ...createAnalyzerInstance(type, analyzers, primaryChannel, metadata.decoder_backend),
    configurationValid: metadata.decode_settings !== undefined,
    name: metadata.name || type,
    color: metadata.color || SALEAE_ANALYZER_COLORS[analyzers.length % SALEAE_ANALYZER_COLORS.length],
    displayRadix: metadata.display_radix || "Hexadecimal",
    showInDataTable: metadata.show_in_data_table,
    streamToTerminal: metadata.stream_to_terminal,
    saleaeMetadata: metadata.saleae_metadata ?? null,
  };

  if (settings?.protocol === "Uart") {
    return {
      ...restored,
      channel: settings.settings.channel,
      baudRate: settings.settings.baud_rate,
      inverted: settings.settings.inverted,
      uartDataBits: settings.settings.data_bits,
      uartStopBits: settings.settings.stop_bits,
      uartParity: settings.settings.parity,
      uartMsbFirst: settings.settings.msb_first,
    };
  }
  if (settings?.protocol === "I2c") {
    return {
      ...restored,
      channel: settings.settings.sda_channel,
      i2cSdaChannel: settings.settings.sda_channel,
      i2cSclChannel: settings.settings.scl_channel,
    };
  }
  if (settings?.protocol === "Spi") {
    return {
      ...restored,
      channel:
        settings.settings.mosi_channel ??
        settings.settings.miso_channel ??
        settings.settings.clock_channel,
      spiMosiChannel: settings.settings.mosi_channel,
      spiMisoChannel: settings.settings.miso_channel,
      spiClockChannel: settings.settings.clock_channel,
      spiEnableChannel: settings.settings.enable_channel,
      spiEnableActiveLow: settings.settings.enable_active_low,
      spiClockPolarity: settings.settings.clock_polarity,
      spiClockPhase: settings.settings.clock_phase,
      spiBitsPerTransfer: settings.settings.bits_per_transfer,
      spiMsbFirst: settings.settings.msb_first,
    };
  }
  return restored;
}

export function saleaeAnalyzerMetadata(analyzer: UiAnalyzerInstance): SaleaeAnalyzerMetadata {
  const decodeSettings = analyzerDecodeSettings(analyzer);
  return {
    type: analyzer.type,
    name: analyzer.name,
    color: analyzer.color,
    display_radix: analyzer.displayRadix,
    show_in_data_table: analyzer.showInDataTable,
    stream_to_terminal: analyzer.streamToTerminal,
    decoder_backend: analyzer.decoderBackend,
    ...(decodeSettings ? { decode_settings: decodeSettings } : {}),
    ...(analyzer.saleaeMetadata == null ? {} : { saleae_metadata: analyzer.saleaeMetadata }),
  };
}

export function analyzerChannelIndexes(analyzer: UiAnalyzerInstance) {
  return [...new Set(analyzerChannelRoles(analyzer).map((role) => role.channel))];
}

export function analyzerDecodeSignature(analyzer: UiAnalyzerInstance) {
  return JSON.stringify([analyzer.decoderBackend, analyzerDecodeSettings(analyzer)]);
}

export function decoderBackendLabel(backend: DecoderBackendKind) {
  if (backend === "saleae_native") return "Saleae Native";
  if (backend === "sigrok_native") return "Sigrok Native";
  if (backend === "auto") return "Automatic";
  return "Compatibility";
}

export function analyzerBackendOptions(type: string): DecoderBackendKind[] {
  if (type === "SPI") return ["saleae_native", "sigrok_native", "legacy_rust"];
  if (type === "Async Serial" || type === "I2C") return ["sigrok_native", "legacy_rust"];
  return ["legacy_rust"];
}

export interface AnalyzerCatalogGroup {
  backend: DecoderBackendKind;
  label: string;
  analyzers: string[];
}

export const ANALYZER_CATALOG_GROUPS: AnalyzerCatalogGroup[] = [
  { backend: "saleae_native", label: "Saleae Native", analyzers: ["SPI"] },
  {
    backend: "sigrok_native",
    label: "Sigrok Native (PXView)",
    analyzers: ["Async Serial", "I2C", "SPI"],
  },
  {
    backend: "legacy_rust",
    label: "Compatibility",
    analyzers: ["Async Serial", "I2C", "SPI", "CAN", "I2S", "Manchester"],
  },
];
