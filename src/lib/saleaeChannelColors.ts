// Ported from Logic 2.4.43 app/services/themes/builtin.ts.
export const SALEAE_LEGACY_CHANNEL_COLORS = [
  "#d4d4d4",
  "#C79579",
  "#FF6D7F",
  "#FFB45B",
  "#e8d836",
  "#58c667",
  "#53A9FD",
  "#AF92FB",
] as const;

export function saleaeLegacyChannelColor(channelIndex: number) {
  const normalizedIndex = Math.abs(Math.trunc(channelIndex)) % SALEAE_LEGACY_CHANNEL_COLORS.length;
  return SALEAE_LEGACY_CHANNEL_COLORS[normalizedIndex];
}
