// Demo defaults only; never infer hardware support from these constants.
export const ANALOG_CHANNEL_COUNT = 16;

type AnalogCapabilities = {
  max_analog_channels?: number | null;
  analog_sample_rates?: readonly number[] | null;
};

export function analogChannelCountForCapabilities(capabilities?: AnalogCapabilities | null): number {
  const count = capabilities?.max_analog_channels;
  return typeof count === "number" && Number.isInteger(count) && count > 0 && count <= 255 ? count : 0;
}

export function analogSampleRateOptionsForCapabilities(capabilities?: AnalogCapabilities | null): number[] {
  if (analogChannelCountForCapabilities(capabilities) === 0) return [];
  return [...new Set(capabilities?.analog_sample_rates ?? [])]
    .filter((rate) => Number.isSafeInteger(rate) && rate > 0)
    .sort((a, b) => a - b);
}

export function analogChannelsForCapabilities(
  capabilities: AnalogCapabilities | null | undefined,
  existing: Partial<UiAnalogChannelSettings>[] = [],
  defaultEnabledCount = 0,
): UiAnalogChannelSettings[] {
  return makeDefaultAnalogChannels(existing, defaultEnabledCount, analogChannelCountForCapabilities(capabilities));
}
export const ANALOG_ROW_MIN_HEIGHT_PX = 160;
export const ANALOG_ROW_DEFAULT_HEIGHT_PX = 280;
export const ANALOG_GRAPH_INSET_PX = 8;
export const ANALOG_GRAPH_LEFT_GUTTER_PX = 44;
export const ANALOG_VIEW_RANGE_MIN_VOLTS = 0.001;
export const ANALOG_VIEW_RANGE_MAX_VOLTS = 100_000;

// Drives the Demo sample grid until the backend advertises synchronized ADC samples and rates.
export const ANALOG_SAMPLE_RATE_OPTIONS = [
  1_000_000,
  2_500_000,
  5_000_000,
  6_250_000,
  10_000_000,
  12_500_000,
  25_000_000,
] as const;

export interface UiAnalogChannelSettings {
  enabled: boolean;
  height: number;
  label: string;
  offsetVolts: number;
  rangeVolts: number;
  unit: string;
  viewOffsetVolts: number;
  viewRangeVolts: number;
}

export function makeDefaultAnalogChannels(
  existing: Partial<UiAnalogChannelSettings>[] = [],
  defaultEnabledCount = 4,
  channelCount = ANALOG_CHANNEL_COUNT,
): UiAnalogChannelSettings[] {
  return Array.from({ length: channelCount }, (_, index) => ({
    enabled: existing[index]?.enabled ?? index < defaultEnabledCount,
    height: Math.max(ANALOG_ROW_MIN_HEIGHT_PX, existing[index]?.height ?? ANALOG_ROW_DEFAULT_HEIGHT_PX),
    label: existing[index]?.label?.trim() || `Analog ${index}`,
    offsetVolts: existing[index]?.offsetVolts ?? 0,
    rangeVolts: Math.max(ANALOG_VIEW_RANGE_MIN_VOLTS, existing[index]?.rangeVolts ?? 20),
    unit: existing[index]?.unit?.trim() || "V",
    viewOffsetVolts: existing[index]?.viewOffsetVolts ?? existing[index]?.offsetVolts ?? 0,
    viewRangeVolts: Math.max(
      ANALOG_VIEW_RANGE_MIN_VOLTS,
      existing[index]?.viewRangeVolts ?? existing[index]?.rangeVolts ?? 20,
    ),
  }));
}

export function cloneAnalogChannels(channels: Partial<UiAnalogChannelSettings>[] | undefined) {
  return makeDefaultAnalogChannels(channels ?? [], 0, channels?.length ?? 0);
}

export function enabledAnalogChannels(channels: UiAnalogChannelSettings[]) {
  return channels
    .map((settings, index) => ({ index, settings }))
    .filter(({ settings }) => settings.enabled);
}

export function sampleDemoAnalogValue(
  channelIndex: number,
  settings: UiAnalogChannelSettings,
  digitalSample: number,
  digitalSampleRateHz: number,
) {
  const timeSeconds = digitalSample / Math.max(1, digitalSampleRateHz);
  const frequencyHz = demoAnalogFrequencyHz(channelIndex);
  const cycle = timeSeconds * frequencyHz;
  const phase = (cycle - Math.floor(cycle)) * Math.PI * 2;
  const amplitude = settings.rangeVolts * (channelIndex === 0 ? 0.38 : 0.3);
  const center = settings.offsetVolts + (channelIndex === 1 ? settings.rangeVolts * 0.08 : 0);
  const harmonic = Math.sin(phase * (channelIndex + 2)) * amplitude * 0.04;
  return center + Math.sin(phase) * amplitude + harmonic;
}

export function demoAnalogFrequencyHz(channelIndex: number) {
  const frequencies = [75_000, 18_000, 6_000, 32_000, 12_000, 4_000, 45_000, 9_000];
  return frequencies[channelIndex % frequencies.length];
}

export function analogSampleStepInDigitalSamples(
  digitalSampleRateHz: number,
  analogSampleRateHz: number,
) {
  return Math.max(Number.EPSILON, digitalSampleRateHz / Math.max(1, analogSampleRateHz));
}
