import { activeThemeChannelColor } from "./themes.ts";

// Compatibility API retained for existing components. The active UI theme now
// supplies the palette; callers do not need to know where the colors come from.
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

export function saleaeLegacyChannelColor(channelIndex: number, kind: "D" | "A" = "D") {
  return activeThemeChannelColor(channelIndex, kind);
}
