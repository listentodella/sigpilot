export interface AnalyzerBubbleLayout {
  leftPx: number;
  overflowLeft: boolean;
  overflowRight: boolean;
  visible: boolean;
  widthPx: number;
}

export function analyzerBubbleLayout(
  startSample: number,
  endSample: number,
  viewportStart: number,
  viewportSamples: number,
  viewportWidthPx: number,
): AnalyzerBubbleLayout {
  const samples = Math.max(1, viewportSamples);
  const width = Math.max(1, viewportWidthPx);
  const left = ((startSample - viewportStart) / samples) * width;
  const right = ((endSample - viewportStart) / samples) * width;
  const clippedLeft = Math.max(0, left);

  return {
    leftPx: clippedLeft,
    overflowLeft: left < 0,
    overflowRight: right > width,
    visible: right >= 0 && left <= width,
    widthPx: Math.max(1, Math.min(right, width) - clippedLeft),
  };
}
