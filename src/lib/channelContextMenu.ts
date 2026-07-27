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

export type ChannelDeleteDataMode = "before" | "after" | "offscreen";

export interface ChannelTrimRange {
  trimEnd: number;
  trimStart: number;
}

export interface ChannelTrimPreview extends ChannelTrimRange {
  trimAfter?: number;
  trimBefore?: number;
}

export function resolveChannelTrimRange({
  clickedSample,
  mode,
  totalSamples,
  viewportSamples,
  viewportStart,
}: {
  clickedSample: number | undefined;
  mode: ChannelDeleteDataMode;
  totalSamples: number;
  viewportSamples: number;
  viewportStart: number;
}): ChannelTrimPreview | null {
  const total = Math.max(0, Math.round(totalSamples));
  if (total <= 1) return null;

  const anchor = resolveChannelTrimAnchorSample(
    clickedSample,
    mode === "offscreen" ? viewportStart : viewportStart + viewportSamples / 2,
    total,
  );
  const viewStart = Math.max(0, Math.min(total - 1, Math.round(viewportStart)));
  const viewEnd = Math.max(viewStart + 1, Math.min(total, Math.round(viewportStart + viewportSamples)));
  const start =
    mode === "before"
      ? Math.min(total - 1, anchor)
      : mode === "offscreen"
        ? viewStart
        : 0;
  const end =
    mode === "after"
      ? Math.max(1, Math.min(total, anchor))
      : mode === "offscreen"
        ? viewEnd
        : total;

  if (end <= start) return null;
  return {
    ...(mode === "after" || mode === "offscreen" ? { trimAfter: end } : {}),
    ...(mode === "before" || mode === "offscreen" ? { trimBefore: start } : {}),
    trimEnd: end,
    trimStart: start,
  };
}
