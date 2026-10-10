import type { CaptureSettings, HardwareCaptureCapabilities } from "./api.ts";

/** Unknown devices expose no selectable inputs until their driver responds. */
export function maxDigitalChannelsForCapabilities(
  capabilities: HardwareCaptureCapabilities | null | undefined,
  mode: CaptureSettings["mode"],
): number {
  if (!capabilities) return 0;
  const maximum = capabilities.max_channels;
  if (!Number.isInteger(maximum) || maximum < 1 || maximum > 32) return 0;
  const modes = capabilities.channel_modes.filter((entry) => entry.stream === (mode === "Stream"));
  if (modes.length === 0) return maximum;
  const counts = modes.map((entry) => entry.channels).filter((count) => Number.isInteger(count) && count > 0);
  return Math.min(maximum, Math.max(0, ...counts));
}
