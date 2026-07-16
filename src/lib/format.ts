export function formatRate(rate: number): string {
  if (rate >= 1_000_000_000) return `${trim(rate / 1_000_000_000)} GHz`;
  if (rate >= 1_000_000) return `${trim(rate / 1_000_000)} MHz`;
  if (rate >= 1_000) return `${trim(rate / 1_000)} kHz`;
  return `${rate} Hz`;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${trim(bytes / (1024 * 1024))} MiB`;
  if (bytes >= 1024) return `${trim(bytes / 1024)} KiB`;
  return `${bytes} B`;
}

export function formatSamples(samples: number): string {
  if (samples >= 1_000_000) return `${trim(samples / 1_000_000)} MS`;
  if (samples >= 1_000) return `${trim(samples / 1_000)} kS`;
  return `${samples} S`;
}

function trim(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}
