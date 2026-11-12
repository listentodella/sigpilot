import type { WaveformAnnotationShape } from "./waveformAnnotations";

/** Outlined, user-owned symbols deliberately differ from filled decoder markers. */
export function drawWaveformAnnotationIcon(context: CanvasRenderingContext2D, shape: WaveformAnnotationShape, color: string) {
  context.save();
  context.strokeStyle = color;
  context.fillStyle = color;
  context.lineWidth = 1.6;
  context.lineJoin = "round";
  context.lineCap = "round";
  context.beginPath();
  if (shape === "flag") {
    context.moveTo(4, 15); context.lineTo(4, 3); context.lineTo(14, 3);
    context.lineTo(11, 6); context.lineTo(14, 9); context.lineTo(4, 9);
  } else if (shape === "diamond") {
    context.moveTo(9, 2.5); context.lineTo(15.5, 9); context.lineTo(9, 15.5);
    context.lineTo(2.5, 9); context.closePath();
  } else if (shape === "warning") {
    context.moveTo(9, 2.5); context.lineTo(16, 15); context.lineTo(2, 15); context.closePath();
    context.moveTo(9, 6.5); context.lineTo(9, 10.5);
    context.moveTo(9, 12.5); context.lineTo(9, 12.7);
  } else if (shape === "cross") {
    context.moveTo(4, 4); context.lineTo(14, 14);
    context.moveTo(14, 4); context.lineTo(4, 14);
  } else if (shape === "dot") {
    context.arc(9, 9, 4.5, 0, Math.PI * 2);
  } else {
    context.rect(4, 4, 10, 10);
  }
  context.stroke();
  context.restore();
}
