export function isChannelDeleteDataVisible(hasCapture: boolean) {
  return hasCapture;
}

export function resolveChannelTrimAnchorSample(
  clickedSample: number | undefined,
  viewportStart: number,
  totalSamples: number,
) {
  const anchor = clickedSample ?? viewportStart;
  return Math.max(0, Math.min(totalSamples, Math.round(anchor)));
}
