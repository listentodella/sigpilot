import type { AnalyzerProtocolMarker } from "./api";

export interface ProtocolMarkerPalette {
  start: string;
  stop: string;
  error: string;
  background: string;
}

/** Shared by the capture overlay and marker demo; coordinates are CSS pixels. */
export function drawProtocolMarker(
  context: CanvasRenderingContext2D,
  centerX: number,
  centerY: number,
  kind: AnalyzerProtocolMarker["kind"],
  channelColor: string,
  palette: ProtocolMarkerPalette,
) {
  context.save();
  context.shadowColor = "rgba(0, 0, 0, 0.5)";
  context.shadowBlur = 1;
  context.fillStyle =
    kind === "start"
      ? palette.start
      : kind === "stop"
        ? palette.stop
        : kind.startsWith("error_")
          ? palette.error
          : channelColor;
  context.strokeStyle = context.fillStyle;
  context.lineWidth = 1.25;
  context.beginPath();
  if (kind === "start") {
    context.arc(centerX, centerY, 3.5, 0, Math.PI * 2);
    context.fill();
  } else if (kind === "dot" || kind === "error_dot") {
    context.arc(centerX, centerY, 2, 0, Math.PI * 2);
    context.fill();
  } else if (kind === "stop" || kind === "square" || kind === "error_square") {
    const side = kind === "stop" ? 7 : 5;
    context.rect(centerX - side / 2, centerY - side / 2, side, side);
    context.fill();
  } else if (kind === "up_arrow" || kind === "down_arrow") {
    const rising = kind === "up_arrow";
    context.moveTo(centerX - 4.5, centerY + (rising ? 3 : -3));
    context.lineTo(centerX, centerY + (rising ? -3 : 3));
    context.lineTo(centerX + 4.5, centerY + (rising ? 3 : -3));
    context.closePath();
    context.fill();
  } else if (kind === "one" || kind === "zero") {
    drawRoundedRect(context, centerX - 6.5, centerY - 6.5, 13, 13, 2);
    context.fillStyle = palette.background;
    context.fill();
    context.stroke();
    context.fillStyle = channelColor;
    context.font = "600 9px Roboto, system-ui, sans-serif";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(kind === "one" ? "1" : "0", centerX, centerY);
  } else {
    context.moveTo(centerX - 3, centerY - 3);
    context.lineTo(centerX + 3, centerY + 3);
    context.moveTo(centerX + 3, centerY - 3);
    context.lineTo(centerX - 3, centerY + 3);
    context.stroke();
  }
  context.restore();
}

function drawRoundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  const right = x + width;
  const bottom = y + height;
  context.beginPath();
  context.moveTo(x + radius, y);
  context.lineTo(right - radius, y);
  context.quadraticCurveTo(right, y, right, y + radius);
  context.lineTo(right, bottom - radius);
  context.quadraticCurveTo(right, bottom, right - radius, bottom);
  context.lineTo(x + radius, bottom);
  context.quadraticCurveTo(x, bottom, x, bottom - radius);
  context.lineTo(x, y + radius);
  context.quadraticCurveTo(x, y, x + radius, y);
  context.closePath();
}
