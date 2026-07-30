export function findNearestEdgeSample(
  edgeSamples: number[],
  pointerSample: number,
  samplesPerPixel: number,
  thresholdPx: number,
  rejectCrowdedEdges: boolean,
) {
  if (edgeSamples.length === 0 || samplesPerPixel <= 0) return null;
  const thresholdSamples = thresholdPx * samplesPerPixel;
  let nearestIndex = -1;
  let nearestDistance = thresholdSamples;
  for (let index = 0; index < edgeSamples.length; index += 1) {
    const distance = Math.abs(edgeSamples[index] - pointerSample);
    if (distance < nearestDistance) {
      nearestIndex = index;
      nearestDistance = distance;
    }
  }
  if (nearestIndex < 0) return null;
  if (rejectCrowdedEdges) {
    const previousGap = nearestIndex > 0
      ? (edgeSamples[nearestIndex] - edgeSamples[nearestIndex - 1]) / samplesPerPixel
      : Number.POSITIVE_INFINITY;
    const nextGap = nearestIndex + 1 < edgeSamples.length
      ? (edgeSamples[nearestIndex + 1] - edgeSamples[nearestIndex]) / samplesPerPixel
      : Number.POSITIVE_INFINITY;
    if (Math.min(previousGap, nextGap) < thresholdPx) return null;
  }
  return edgeSamples[nearestIndex];
}
