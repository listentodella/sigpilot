interface CaptureTriggerMarkerProps {
  triggerSample?: number;
  viewportSamples: number;
  viewportStart: number;
}

// Ported from Logic 2.4.43 TriggerMarkerRender's dashed trigger line.
export function CaptureTriggerMarker({
  triggerSample,
  viewportSamples,
  viewportStart,
}: CaptureTriggerMarkerProps) {
  if (
    triggerSample == null ||
    triggerSample < viewportStart ||
    triggerSample > viewportStart + viewportSamples
  ) {
    return null;
  }

  const ratio = (triggerSample - viewportStart) / Math.max(1, viewportSamples);
  return <div aria-hidden className="captureTriggerGraphLine" style={{ left: `${ratio * 100}%` }} />;
}
