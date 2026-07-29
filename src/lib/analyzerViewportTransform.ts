export interface AnalyzerViewport {
  start: number;
  samples: number;
}

export function analyzerViewportTransform(
  source: AnalyzerViewport,
  target: AnalyzerViewport,
  widthPx: number,
) {
  const sourceSamples = Math.max(1, source.samples);
  const targetSamples = Math.max(1, target.samples);
  const width = Math.max(1, widthPx);
  return {
    scaleX: sourceSamples / targetSamples,
    translateX: ((source.start - target.start) / targetSamples) * width,
  };
}
