import type {
  AnalyzerBubble,
  AnalyzerDecodeSettings,
  AnalyzerTrackWindow,
  DecoderBackendKind,
  DecodedFrame,
  SaleaeAnalyzerMetadata,
  SigrokDecoderCatalogItem,
  SigrokDecoderChannel,
  SigrokDecoderOption,
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
export const PARALLEL_DATA_KEYS = Array.from({ length: 16 }, (_, index) => `d${index}`);
export const DISPLAY_RADIX_OPTIONS = ["Binary", "Decimal", "Hexadecimal", "Ascii"] as const;
export type AnalyzerDisplayRadix = (typeof DISPLAY_RADIX_OPTIONS)[number];

const EXTERNAL_DECODER_BACKENDS: DecoderBackendKind[] = ["saleae_native", "sigrok_native"];
const CORE_ANALYZER_TYPES = ["Async Serial", "I2C", "SPI"] as const;
const VERIFIED_SIGROK_C_RUNNER_STATUS = "verified_sparse_c";
const CATALOG_ONLY_SIGROK_RUNNER_STATUS = "catalog_only";
const SIGROK_VERIFIED_C_RUNNER_TYPES: Record<string, string> = {
  uart_c: "Async Serial",
  i2c_c: "I2C",
  spi_c: "SPI",
  i2s_c: "I2S",
  can_c: "CAN",
  can_fd_c: "CAN-FD",
  lin_c: "LIN",
  parallel_c: "Simple Parallel",
};

export interface NativeCatalogChannelMetadata {
  id: string;
  name: string;
  desc?: string | null;
  required: boolean;
  order: number;
  typeName?: string | null;
}

export interface NativeCatalogOptionMetadata {
  id: string;
  desc?: string | null;
  defaultValue?: boolean | number | string;
  valueType?: string | null;
  values: Array<boolean | number | string>;
}

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
  nativeDecoderId: string;
  nativeProtocolName: string;
  nativePrimaryChannel: number;
  nativeChannels: Record<string, number | null>;
  nativeOptions: Record<string, boolean | number | string>;
  nativeRunnerStatus?: string | null;
  nativeCatalogKind?: string | null;
  nativeCatalogDescription?: string | null;
  nativeCatalogTags?: string[];
  nativeCatalogChannels?: NativeCatalogChannelMetadata[];
  nativeCatalogOptions?: NativeCatalogOptionMetadata[];
  showInDataTable: boolean;
  streamToTerminal: boolean;
  displayRadix: AnalyzerDisplayRadix;
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

interface NativeAnalyzerDefaults {
  decoderId: string;
  protocolName: string;
  primaryChannel: number;
  channels: Record<string, number | null>;
  options: Record<string, boolean | number | string>;
  runnerStatus?: string | null;
  catalogKind?: string | null;
  catalogDescription?: string | null;
  catalogTags?: string[];
  catalogChannels?: NativeCatalogChannelMetadata[];
  catalogOptions?: NativeCatalogOptionMetadata[];
}

interface NativeAnalyzerDefinition {
  type: string;
  backends: DecoderBackendKind[];
  createDefaults: (channel: number, nextChannel: (offset: number) => number) => NativeAnalyzerDefaults;
  channelRoles: (analyzer: UiAnalyzerInstance) => AnalyzerChannelRole[];
}

const NATIVE_ANALYZER_DEFINITIONS: NativeAnalyzerDefinition[] = [
  {
    type: "I2S",
    backends: EXTERNAL_DECODER_BACKENDS,
    createDefaults: (channel, nextChannel) => ({
      decoderId: "i2s",
      protocolName: "I2S",
      primaryChannel: channel,
      channels: { sck: channel, ws: nextChannel(1), sd: nextChannel(2) },
      options: {
        bit_order: "msb-first",
        clk_edge: "falling-edge",
        word_size: 16,
        frame_transitions: "once-each-word",
        bit_align: "left-aligned",
        bit_shift: "right-shifted by one",
        signed: false,
        ws_polarity: "right-high",
      },
    }),
    channelRoles: (analyzer) => [
      numberChannelRole(analyzer.nativeChannels.sd, "DATA", true, false),
      numberChannelRole(analyzer.nativeChannels.sck, "CLOCK", false, true),
      numberChannelRole(analyzer.nativeChannels.ws, "FRAME", false, false),
    ].filter((role): role is AnalyzerChannelRole => role !== null),
  },
  {
    type: "LIN",
    backends: EXTERNAL_DECODER_BACKENDS,
    createDefaults: (channel) => ({
      decoderId: "lin",
      protocolName: "LIN",
      primaryChannel: channel,
      channels: { rx: channel },
      options: { baudrate: 19_200, version: 2 },
    }),
    channelRoles: (analyzer) => [
      numberChannelRole(analyzer.nativeChannels.rx, "LIN", true, true),
    ].filter((role): role is AnalyzerChannelRole => role !== null),
  },
  {
    type: "CAN",
    backends: EXTERNAL_DECODER_BACKENDS,
    createDefaults: (channel) => ({
      decoderId: "can",
      protocolName: "CAN",
      primaryChannel: channel,
      channels: { can_rx: channel },
      options: { bitrate: 1_000_000, sample_point: 70, inverted: false },
    }),
    channelRoles: (analyzer) => [
      numberChannelRole(analyzer.nativeChannels.can_rx, "CAN", true, true),
    ].filter((role): role is AnalyzerChannelRole => role !== null),
  },
  {
    type: "CAN-FD",
    backends: ["sigrok_native"],
    createDefaults: (channel) => ({
      decoderId: "can_fd",
      protocolName: "CAN-FD",
      primaryChannel: channel,
      channels: { can_rx: channel },
      options: { nominal_bitrate: 1_000_000, fast_bitrate: 2_000_000, sample_point: 70 },
    }),
    channelRoles: (analyzer) => [
      numberChannelRole(analyzer.nativeChannels.can_rx, "CAN-FD", true, true),
    ].filter((role): role is AnalyzerChannelRole => role !== null),
  },
  {
    type: "Simple Parallel",
    backends: EXTERNAL_DECODER_BACKENDS,
    createDefaults: (channel, nextChannel) => {
      const channels: Record<string, number | null> = { clk: nextChannel(1) };
      PARALLEL_DATA_KEYS.forEach((key, bit) => {
        channels[key] = bit === 0 ? channel : null;
      });
      return {
        decoderId: "parallel",
        protocolName: "Parallel",
        primaryChannel: channel,
        channels,
        options: { clock_edge: "rising", clock_state: 0, word_size: 0, endianness: "little" },
      };
    },
    channelRoles: (analyzer) => {
      const data = PARALLEL_DATA_KEYS.map((key) => analyzer.nativeChannels[key]).find(
        (channel): channel is number => typeof channel === "number",
      );
      return typeof data === "number"
        ? [{ channel: data, hasBubbles: true, hasMarkers: true, title: "Data" }]
        : [];
    },
  },
];

function nativeAnalyzerDefinition(type: string) {
  return NATIVE_ANALYZER_DEFINITIONS.find((definition) => definition.type === type) ?? null;
}

function nativeAnalyzerDefaults(
  type: string,
  channel: number,
  nextChannel: (offset: number) => number,
  catalogItem?: SigrokDecoderCatalogItem | null,
): NativeAnalyzerDefaults {
  if (catalogItem) return nativeAnalyzerDefaultsFromCatalog(catalogItem, type, channel, nextChannel);
  return (
    nativeAnalyzerDefinition(type)?.createDefaults(channel, nextChannel) ?? {
      decoderId: "",
      protocolName: type,
      primaryChannel: channel,
      channels: {},
      options: {},
    }
  );
}

function nativeAnalyzerDefaultsFromCatalog(
  item: SigrokDecoderCatalogItem,
  type: string,
  channel: number,
  nextChannel: (offset: number) => number,
): NativeAnalyzerDefaults {
  const channels: Record<string, number | null> = {};
  const requiredChannels = sortedCatalogChannels(item.channels);
  const optionalChannels = sortedCatalogChannels(item.optional_channels);
  requiredChannels.forEach((catalogChannel, index) => {
    channels[catalogChannelId(catalogChannel, index)] = nextChannel(index);
  });
  optionalChannels.forEach((catalogChannel, index) => {
    channels[catalogChannelId(catalogChannel, requiredChannels.length + index)] = null;
  });
  const primaryChannel =
    requiredChannels
      .map((catalogChannel, index) => channels[catalogChannelId(catalogChannel, index)])
      .find((candidate): candidate is number => typeof candidate === "number") ?? channel;

  const options: Record<string, boolean | number | string> = {};
  const catalogOptions = item.options.flatMap((option, index) => {
    const id = catalogOptionId(option, index);
    const values = option.values.flatMap(primitiveCatalogValue);
    const fallback = values[0];
    const value = primitiveCatalogValue(option.default)[0] ?? fallback;
    if (value !== undefined) options[id] = value;
    return [{ id, desc: option.desc, defaultValue: value, valueType: option.value_type, values }];
  });
  const catalogChannels = [
    ...requiredChannels.map((catalogChannel, index) =>
      catalogChannelMetadata(catalogChannel, index, true),
    ),
    ...optionalChannels.map((catalogChannel, index) =>
      catalogChannelMetadata(catalogChannel, requiredChannels.length + index, false),
    ),
  ];

  return {
    decoderId: runnableSigrokDecoderId(item) ?? item.id ?? "",
    protocolName: sigrokCatalogProtocolName(item) || type,
    primaryChannel,
    channels,
    options,
    runnerStatus: item.runner_status,
    catalogKind: item.kind,
    catalogDescription: item.desc,
    catalogTags: [...(item.tags ?? [])],
    catalogChannels,
    catalogOptions,
  };
}

function numberChannelRole(
  channel: unknown,
  title: string,
  hasBubbles: boolean,
  hasMarkers: boolean,
): AnalyzerChannelRole | null {
  return typeof channel === "number" ? { channel, title, hasBubbles, hasMarkers } : null;
}

function sortedCatalogChannels(channels: SigrokDecoderChannel[] | undefined) {
  return [...(channels ?? [])].sort((left, right) => left.order - right.order);
}

function catalogChannelId(channel: SigrokDecoderChannel, fallbackIndex: number) {
  return channel.id?.trim() || channel.name?.trim() || `ch${fallbackIndex}`;
}

function catalogOptionId(option: SigrokDecoderOption, fallbackIndex: number) {
  return option.id?.trim() || option.idn?.trim() || `option${fallbackIndex}`;
}

function catalogChannelName(channel: SigrokDecoderChannel, fallbackIndex: number) {
  return channel.name?.trim() || channel.id?.trim() || `Channel ${fallbackIndex + 1}`;
}

function catalogChannelMetadata(
  channel: SigrokDecoderChannel,
  fallbackIndex: number,
  required: boolean,
): NativeCatalogChannelMetadata {
  return {
    id: catalogChannelId(channel, fallbackIndex),
    name: catalogChannelName(channel, fallbackIndex),
    desc: channel.desc,
    required,
    order: channel.order,
    typeName: channel.type_name,
  };
}

function catalogChannelsForItem(item: SigrokDecoderCatalogItem) {
  const required = sortedCatalogChannels(item.channels).map((channel, index) =>
    catalogChannelMetadata(channel, index, true),
  );
  const optional = sortedCatalogChannels(item.optional_channels).map((channel, index) =>
    catalogChannelMetadata(channel, required.length + index, false),
  );
  return [...required, ...optional];
}

function primitiveCatalogValue(value: unknown): Array<boolean | number | string> {
  if (typeof value === "boolean" || typeof value === "string") return [value];
  if (typeof value === "number" && Number.isFinite(value)) return [value];
  return [];
}

function catalogOptionsForItem(item: SigrokDecoderCatalogItem) {
  return item.options.map((option, index) => ({
    id: catalogOptionId(option, index),
    desc: option.desc,
    defaultValue: primitiveCatalogValue(option.default)[0],
    valueType: option.value_type,
    values: option.values.flatMap(primitiveCatalogValue),
  }));
}

function runnableSigrokDecoderId(item: SigrokDecoderCatalogItem) {
  const id = item.id ?? "";
  return SIGROK_VERIFIED_C_RUNNER_TYPES[id]
    ? id.replace(/_c$/, "").replace(/-/g, "_")
    : null;
}

export function sigrokCatalogDisplayName(item: SigrokDecoderCatalogItem) {
  return (
    compactSigrokCatalogName(item.name) ||
    compactSigrokCatalogName(item.longname) ||
    compactSigrokCatalogName(item.id) ||
    "Sigrok Decoder"
  );
}

export function sigrokCatalogDetailName(item: SigrokDecoderCatalogItem) {
  const longname = compactSigrokCatalogName(item.longname);
  const displayName = sigrokCatalogDisplayName(item);
  return longname && longname !== displayName ? longname : item.desc?.trim() || "";
}

function compactSigrokCatalogName(value?: string | null) {
  return value
    ?.trim()
    .replace(/\s*\((?:C|Python)\)\s*$/i, "")
    .replace(/_c$/i, "")
    .replace(/_/g, " ")
    .trim();
}

function sigrokCatalogProtocolName(item: SigrokDecoderCatalogItem) {
  const runnableId = runnableSigrokDecoderId(item);
  if (runnableId === "can_fd") return "CAN-FD";
  if (runnableId === "i2c") return "I2C";
  if (runnableId) return runnableId.toUpperCase();
  return sigrokCatalogDisplayName(item);
}

export function sigrokCatalogRunnerLabel(status?: string | null) {
  if (status === VERIFIED_SIGROK_C_RUNNER_STATUS) return "Runnable";
  return "Catalog";
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
  catalogItem?: SigrokDecoderCatalogItem | null,
): UiAnalyzerInstance {
  const index = analyzers.length;
  const nextChannel = (offset: number) => (channel + offset) % 32;
  const nativeDefaults = nativeAnalyzerDefaults(type, channel, nextChannel, catalogItem);
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
    nativeDecoderId: nativeDefaults.decoderId,
    nativeProtocolName: nativeDefaults.protocolName,
    nativePrimaryChannel: nativeDefaults.primaryChannel,
    nativeChannels: nativeDefaults.channels,
    nativeOptions: nativeDefaults.options,
    nativeRunnerStatus: nativeDefaults.runnerStatus,
    nativeCatalogKind: nativeDefaults.catalogKind,
    nativeCatalogDescription: nativeDefaults.catalogDescription,
    nativeCatalogTags: nativeDefaults.catalogTags,
    nativeCatalogChannels: nativeDefaults.catalogChannels,
    nativeCatalogOptions: nativeDefaults.catalogOptions,
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

export function createAnalyzerInstanceFromSigrokCatalog(
  item: SigrokDecoderCatalogItem,
  analyzers: UiAnalyzerInstance[],
  channel = 0,
): UiAnalyzerInstance {
  const mappedType = item.id ? SIGROK_VERIFIED_C_RUNNER_TYPES[item.id] : undefined;
  const displayType = mappedType ?? sigrokCatalogDisplayName(item);
  const analyzer = createAnalyzerInstance(displayType, analyzers, channel, "sigrok_native", mappedType ? null : item);
  return {
    ...analyzer,
    nativeRunnerStatus: item.runner_status,
    nativeCatalogKind: item.kind,
    nativeCatalogDescription: item.desc,
    nativeCatalogTags: [...(item.tags ?? [])],
    nativeCatalogChannels: analyzer.nativeCatalogChannels ?? catalogChannelsForItem(item),
    nativeCatalogOptions: analyzer.nativeCatalogOptions ?? catalogOptionsForItem(item),
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

  const nativeDefinition = nativeAnalyzerDefinition(analyzer.type);
  if (nativeDefinition) return nativeDefinition.channelRoles(analyzer);
  if (Array.isArray(analyzer.nativeCatalogChannels)) {
    const roles = analyzer.nativeCatalogChannels
      .map((channel) => {
        const assigned = analyzer.nativeChannels[channel.id];
        if (typeof assigned !== "number") return null;
        const channelKind = `${channel.id} ${channel.name} ${channel.typeName ?? ""}`.toLowerCase();
        const hasMarkers = channelKind.includes("clock") || channelKind.includes("clk");
        return {
          channel: assigned,
          hasBubbles: assigned === analyzer.nativePrimaryChannel || !hasMarkers,
          hasMarkers,
          title: channel.name,
        };
      })
      .filter((role): role is AnalyzerChannelRole => role !== null);
    return roles;
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

export function analyzerSupportsDecoding(
  analyzer: Pick<UiAnalyzerInstance, "type" | "nativeDecoderId" | "nativeCatalogChannels">,
) {
  return CORE_ANALYZER_TYPES.includes(analyzer.type as (typeof CORE_ANALYZER_TYPES)[number]) ||
    nativeAnalyzerDefinition(analyzer.type) !== null ||
    Boolean(analyzer.nativeDecoderId && Array.isArray(analyzer.nativeCatalogChannels));
}

export function analyzerCanRunDecoder(
  analyzer: Pick<
    UiAnalyzerInstance,
    "type" | "nativeDecoderId" | "nativeCatalogChannels" | "nativeRunnerStatus"
  >,
) {
  if (!analyzerSupportsDecoding(analyzer)) return false;
  if (analyzer.nativeRunnerStatus === CATALOG_ONLY_SIGROK_RUNNER_STATUS) return false;
  return !analyzer.nativeRunnerStatus || analyzer.nativeRunnerStatus === VERIFIED_SIGROK_C_RUNNER_STATUS;
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
  if (nativeAnalyzerDefinition(analyzer.type) || Array.isArray(analyzer.nativeCatalogChannels)) {
    return {
      protocol: "Native",
      settings: {
        decoder_id: analyzer.nativeDecoderId,
        protocol_name: analyzer.nativeProtocolName,
        channels: analyzer.nativeChannels,
        options: analyzer.nativeOptions,
        primary_channel: analyzer.nativePrimaryChannel,
      },
    };
  }
  return null;
}

export function restoreSaleaeAnalyzer(
  metadata: SaleaeAnalyzerMetadata,
  analyzers: UiAnalyzerInstance[],
): UiAnalyzerInstance {
  const type =
    metadata.type === "Serial"
      ? "Async Serial"
      : metadata.type === "I2S / PCM"
        ? "I2S"
        : metadata.type;
  const settings = metadata.decode_settings;
  const primaryChannel =
    settings?.protocol === "Uart"
      ? settings.settings.channel
      : settings?.protocol === "I2c"
        ? settings.settings.sda_channel
        : settings?.protocol === "Spi"
          ? (settings.settings.mosi_channel ?? settings.settings.miso_channel ?? settings.settings.clock_channel)
          : settings?.protocol === "Native"
            ? settings.settings.primary_channel
          : 0;
  const restored = {
    ...createAnalyzerInstance(type, analyzers, primaryChannel, metadata.decoder_backend),
    configurationValid: metadata.decode_settings !== undefined,
    name: metadata.name || type,
    color: metadata.color || SALEAE_ANALYZER_COLORS[analyzers.length % SALEAE_ANALYZER_COLORS.length],
    displayRadix: normalizeAnalyzerDisplayRadix(metadata.display_radix),
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
  if (settings?.protocol === "Native") {
    const saleaeMetadata =
      metadata.saleae_metadata && typeof metadata.saleae_metadata === "object"
        ? (metadata.saleae_metadata as Record<string, unknown>)
        : {};
    const catalogChannels = Array.isArray(saleaeMetadata.nativeCatalogChannels)
      ? (saleaeMetadata.nativeCatalogChannels as NativeCatalogChannelMetadata[])
      : restored.nativeCatalogChannels;
    const catalogOptions = Array.isArray(saleaeMetadata.nativeCatalogOptions)
      ? (saleaeMetadata.nativeCatalogOptions as NativeCatalogOptionMetadata[])
      : restored.nativeCatalogOptions;
    return {
      ...restored,
      channel: settings.settings.primary_channel,
      nativeDecoderId: settings.settings.decoder_id,
      nativeProtocolName: settings.settings.protocol_name,
      nativePrimaryChannel: settings.settings.primary_channel,
      nativeChannels: settings.settings.channels,
      nativeOptions: settings.settings.options,
      nativeRunnerStatus:
        typeof saleaeMetadata.nativeRunnerStatus === "string"
          ? saleaeMetadata.nativeRunnerStatus
          : restored.nativeRunnerStatus,
      nativeCatalogKind:
        typeof saleaeMetadata.nativeCatalogKind === "string"
          ? saleaeMetadata.nativeCatalogKind
          : restored.nativeCatalogKind,
      nativeCatalogDescription:
        typeof saleaeMetadata.nativeCatalogDescription === "string"
          ? saleaeMetadata.nativeCatalogDescription
          : restored.nativeCatalogDescription,
      nativeCatalogTags: Array.isArray(saleaeMetadata.nativeCatalogTags)
        ? (saleaeMetadata.nativeCatalogTags as string[])
        : restored.nativeCatalogTags,
      nativeCatalogChannels: catalogChannels,
      nativeCatalogOptions: catalogOptions,
    };
  }
  return restored;
}

export function saleaeAnalyzerMetadata(analyzer: UiAnalyzerInstance): SaleaeAnalyzerMetadata {
  const decodeSettings = analyzerDecodeSettings(analyzer);
  const nativeCatalogMetadata =
    analyzer.nativeCatalogChannels?.length || analyzer.nativeRunnerStatus
      ? {
          nativeRunnerStatus: analyzer.nativeRunnerStatus ?? null,
          nativeCatalogKind: analyzer.nativeCatalogKind ?? null,
          nativeCatalogDescription: analyzer.nativeCatalogDescription ?? null,
          nativeCatalogTags: analyzer.nativeCatalogTags ?? [],
          nativeCatalogChannels: analyzer.nativeCatalogChannels ?? [],
          nativeCatalogOptions: analyzer.nativeCatalogOptions ?? [],
        }
      : null;
  const saleaeMetadata =
    nativeCatalogMetadata === null
      ? analyzer.saleaeMetadata
      : {
          ...(analyzer.saleaeMetadata && typeof analyzer.saleaeMetadata === "object"
            ? (analyzer.saleaeMetadata as Record<string, unknown>)
            : {}),
          ...nativeCatalogMetadata,
        };
  return {
    type: analyzer.type,
    name: analyzer.name,
    color: analyzer.color,
    display_radix: analyzer.displayRadix,
    show_in_data_table: analyzer.showInDataTable,
    stream_to_terminal: analyzer.streamToTerminal,
    decoder_backend: analyzer.decoderBackend,
    ...(decodeSettings ? { decode_settings: decodeSettings } : {}),
    ...(saleaeMetadata == null ? {} : { saleae_metadata: saleaeMetadata }),
  };
}

export function analyzerChannelIndexes(analyzer: UiAnalyzerInstance) {
  return [...new Set(analyzerChannelRoles(analyzer).map((role) => role.channel))];
}

export function analyzerDecodeSignature(analyzer: UiAnalyzerInstance) {
  return JSON.stringify([analyzer.decoderBackend, analyzerDecodeSettings(analyzer)]);
}

export function mergeAnalyzerTrackFrames(
  decodedFrames: DecodedFrame[],
  tracks: AnalyzerTrackWindow[],
) {
  const frames = new Map<string, DecodedFrame>();
  const mergeFrame = (frame: DecodedFrame) => {
    const key = `${frame.frame_id}:${frame.start_sample}:${frame.end_sample}`;
    const existing = frames.get(key);
    if (!existing) {
      frames.set(key, { ...frame, channel_values: [...frame.channel_values] });
      return;
    }
    const channelValues = [...existing.channel_values];
    frame.channel_values.forEach((value) => {
      const index = channelValues.findIndex(
        (candidate) => candidate.channel === value.channel && candidate.role === value.role,
      );
      if (index >= 0) channelValues[index] = value;
      else channelValues.push(value);
    });
    frames.set(key, {
      ...existing,
      frame_type: existing.frame_type || frame.frame_type,
      channel_values: channelValues,
      label:
        channelValues.length > 1
          ? channelValues.map((value) => `${value.role} ${value.label}`).join(" / ")
          : existing.label || frame.label,
    });
  };

  decodedFrames.forEach(mergeFrame);
  tracks.forEach((track) => {
    track.frames.forEach(mergeFrame);
    if (track.previous_frame) mergeFrame(track.previous_frame);
    if (track.next_frame) mergeFrame(track.next_frame);
  });
  return [...frames.values()].sort(
    (left, right) => left.start_sample - right.start_sample || left.frame_id - right.frame_id,
  );
}

export function decoderBackendLabel(backend: DecoderBackendKind) {
  if (backend === "saleae_native") return "Saleae Native";
  if (backend === "sigrok_native") return "Sigrok Native";
  if (backend === "auto") return "Automatic";
  return "Legacy Rust (compatibility only)";
}

export function analyzerBackendOptions(type: string): DecoderBackendKind[] {
  if (CORE_ANALYZER_TYPES.includes(type as (typeof CORE_ANALYZER_TYPES)[number])) {
    return [...EXTERNAL_DECODER_BACKENDS];
  }
  if (type === "sigrok_catalog") return ["sigrok_native"];
  return [...(nativeAnalyzerDefinition(type)?.backends ?? [])];
}

export interface AnalyzerCatalogGroup {
  backend: DecoderBackendKind;
  label: string;
  analyzers: string[];
}

export const ANALYZER_CATALOG_GROUPS: AnalyzerCatalogGroup[] = [
  {
    backend: "saleae_native",
    label: "Saleae Native",
    analyzers: catalogAnalyzersForBackend("saleae_native"),
  },
  {
    backend: "sigrok_native",
    label: "Sigrok Native (PXView)",
    analyzers: catalogAnalyzersForBackend("sigrok_native"),
  },
];

function catalogAnalyzersForBackend(backend: DecoderBackendKind) {
  return [
    ...CORE_ANALYZER_TYPES,
    ...NATIVE_ANALYZER_DEFINITIONS.map((definition) => definition.type),
  ].filter((type) => analyzerBackendOptions(type).includes(backend));
}

export function analyzerCatalogChoiceKey(choice: {
  backend: DecoderBackendKind;
  catalogItem?: SigrokDecoderCatalogItem;
  name: string;
  source?: string;
}) {
  return [
    choice.backend,
    choice.catalogItem?.kind ?? "",
    choice.catalogItem?.id ?? "",
    choice.name,
    choice.source ?? "",
  ].join(":");
}

export function normalizeAnalyzerDisplayRadix(value: unknown): AnalyzerDisplayRadix {
  return DISPLAY_RADIX_OPTIONS.includes(value as AnalyzerDisplayRadix)
    ? (value as AnalyzerDisplayRadix)
    : "Hexadecimal";
}

export function formatAnalyzerText(
  text: string,
  displayRadix: string,
  fallbackValue?: number,
) {
  const radix = normalizeAnalyzerDisplayRadix(displayRadix);
  const source = text || "";
  let replaced = false;
  const withExplicitTokens = source.replace(/0x[0-9a-f]+|0b[01]+/gi, (token) => {
    const parsed = parseNumericToken(token);
    if (!parsed) return token;
    replaced = true;
    return formatAnalyzerValue(parsed.value, radix, parsed.bits);
  });
  if (replaced) return withExplicitTokens;

  const trimmed = source.trim();
  if (/^\d+$/.test(trimmed)) {
    const parsed = Number.parseInt(trimmed, 10);
    if (Number.isFinite(parsed)) {
      return source.replace(trimmed, formatAnalyzerValue(parsed, radix, bitsForValue(parsed)));
    }
  }

  if (source === "" && typeof fallbackValue === "number" && Number.isFinite(fallbackValue)) {
    return formatAnalyzerValue(fallbackValue, radix, bitsForValue(fallbackValue));
  }
  return source;
}

export function formatAnalyzerValue(
  value: number,
  displayRadix: string,
  bits = bitsForValue(value),
): string {
  const radix = normalizeAnalyzerDisplayRadix(displayRadix);
  const normalizedValue = Math.max(0, Math.trunc(value));
  if (radix === "Decimal") return normalizedValue.toString(10);
  if (radix === "Binary") {
    const width = Math.max(1, bits);
    return `0b${normalizedValue.toString(2).padStart(width, "0")}`;
  }
  if (radix === "Ascii") return formatAsciiValue(normalizedValue);

  const digits = Math.max(1, Math.ceil(bits / 4));
  return `0x${normalizedValue.toString(16).toUpperCase().padStart(digits, "0")}`;
}

function parseNumericToken(token: string) {
  if (/^0x/i.test(token)) {
    const digits = token.slice(2);
    const value = Number.parseInt(digits, 16);
    return Number.isFinite(value) ? { bits: Math.max(4, digits.length * 4), value } : null;
  }
  if (/^0b/i.test(token)) {
    const digits = token.slice(2);
    const value = Number.parseInt(digits, 2);
    return Number.isFinite(value) ? { bits: Math.max(1, digits.length), value } : null;
  }
  return null;
}

function bitsForValue(value: number) {
  const normalizedValue = Math.max(0, Math.trunc(value));
  if (normalizedValue <= 0xff) return 8;
  return Math.max(1, Math.ceil(Math.log2(normalizedValue + 1)));
}

function formatAsciiValue(value: number): string {
  const normalizedValue = Math.max(0, Math.trunc(value));
  const byte = normalizedValue & 0xff;
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
  return escaped === null ? formatAnalyzerValue(normalizedValue, "Hexadecimal", bitsForValue(value)) : `'${escaped}'`;
}
