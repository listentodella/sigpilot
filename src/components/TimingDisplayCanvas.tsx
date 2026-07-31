import { useEffect, useRef } from "react";
import {
  getHorizontalGraphTicks,
  minimumHorizontalTickSpacingPx,
  SALEAE_DARK_GRIDLINE_PRIMARY,
  SALEAE_DARK_GRIDLINE_SECONDARY,
  TimingTick,
} from "../lib/saleaeTimingDisplay";
import {
  SALEAE_ROW_V2_CONTAINER_PADDING_PX,
  SALEAE_ROW_V2_SPACING_PX,
  SALEAE_TIME_RULER_HEIGHT_PX,
} from "../lib/saleaeChannelLayout";

interface TimingDisplayCanvasProps {
  graphWidthPx: number;
  sampleRateHz: number;
  timeOriginSample?: number;
  viewportSamples: number;
  viewportStart: number;
}

const timingDisplayHeightPx = SALEAE_TIME_RULER_HEIGHT_PX;
const timingGraphInsetLeftPx = SALEAE_ROW_V2_CONTAINER_PADDING_PX + SALEAE_ROW_V2_SPACING_PX;

// Ported from Logic 2.4.43 TimingDisplay/ConnectedTimingDisplay and drawTick.
export function TimingDisplayCanvas({
  graphWidthPx,
  sampleRateHz,
  timeOriginSample = 0,
  viewportSamples,
  viewportStart,
}: TimingDisplayCanvasProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const timingRef = useRef({ graphWidthPx, sampleRateHz, timeOriginSample, viewportSamples, viewportStart });

  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas) return;

    const drawCurrent = () => {
      const timing = timingRef.current;
      drawTimingDisplay(
        canvas,
        timing.viewportStart,
        timing.viewportSamples,
        timing.sampleRateHz,
        timing.graphWidthPx,
        timing.timeOriginSample,
      );
    };
    const observer = new ResizeObserver(([entry]) => {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.floor(entry.contentRect.width * dpr));
      canvas.height = Math.max(1, Math.floor(timingDisplayHeightPx * dpr));
      drawCurrent();
    });
    observer.observe(host);
    drawCurrent();
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    timingRef.current = { graphWidthPx, sampleRateHz, timeOriginSample, viewportSamples, viewportStart };
    const canvas = canvasRef.current;
    if (canvas) drawTimingDisplay(canvas, viewportStart, viewportSamples, sampleRateHz, graphWidthPx, timeOriginSample);
  }, [graphWidthPx, sampleRateHz, timeOriginSample, viewportSamples, viewportStart]);

  return (
    <div className="timingDisplayCanvasHost" ref={hostRef}>
      <canvas aria-label="Capture time ruler" className="timingDisplayCanvas" ref={canvasRef} />
    </div>
  );
}

function drawTimingDisplay(
  canvas: HTMLCanvasElement,
  viewportStart: number,
  viewportSamples: number,
  sampleRateHz: number,
  graphWidthPx: number,
  timeOriginSample: number,
) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const dpr = window.devicePixelRatio || 1;
  const width = canvas.width;
  const height = canvas.height;
  const widthCss = width / dpr;
  const heightCss = height / dpr;
  const graphDisplayWidthCss = Math.max(1, widthCss - timingGraphInsetLeftPx);

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#131316";
  ctx.fillRect(0, 0, width, height);

  const backgroundGradient = ctx.createLinearGradient(0, 0, 0, 20 * dpr);
  backgroundGradient.addColorStop(0, "rgba(0, 0, 0, 0.08)");
  backgroundGradient.addColorStop(1, "rgba(0, 0, 0, 0)");
  ctx.fillStyle = backgroundGradient;
  ctx.fillRect(0, 0, width, 20 * dpr);

  ctx.strokeStyle = SALEAE_DARK_GRIDLINE_PRIMARY;
  ctx.lineWidth = Math.max(1, dpr);
  ctx.beginPath();
  ctx.moveTo(0, crisp(height - dpr * 0.5));
  ctx.lineTo(width, crisp(height - dpr * 0.5));
  ctx.stroke();

  if (
    !Number.isFinite(sampleRateHz) ||
    sampleRateHz <= 0 ||
    !Number.isFinite(viewportSamples) ||
    viewportSamples <= 0 ||
    widthCss <= 0
  ) {
    return;
  }

  const startSeconds = (viewportStart - timeOriginSample) / sampleRateHz;
  const timeSecondsPerPixel = viewportSamples / sampleRateHz / Math.max(1, graphWidthPx || widthCss);
  const { majorTicks, minorTicks } = getHorizontalGraphTicks(
    startSeconds,
    timeSecondsPerPixel,
    graphDisplayWidthCss,
    {
      minorThresholdPx: minimumHorizontalTickSpacingPx,
      addClosestOffscreenMajorTicks: true,
      negativeMinorTicks: true,
    },
  );

  ctx.font = `700 ${11 * dpr}px Roboto, Helvetica, Arial, sans-serif`;
  ctx.textBaseline = "bottom";
  for (const tick of majorTicks) drawTick(ctx, tick, heightCss, true, timingGraphInsetLeftPx, dpr);
  for (const tick of minorTicks) drawTick(ctx, tick, heightCss, false, timingGraphInsetLeftPx, dpr);
}

function drawTick(
  ctx: CanvasRenderingContext2D,
  tick: TimingTick,
  heightCss: number,
  isMajor: boolean,
  leftInsetCss: number,
  dpr: number,
) {
  const yOffset = (isMajor ? heightCss * 0.5 : heightCss - 3) * dpr;
  const x = (leftInsetCss + tick.leftPx) * dpr;
  let textX = x + (isMajor ? 0 : -2.5 * dpr);

  if (tick.isOutOfRange) {
    const arrowWidth = 4 * dpr;
    const arrowHeight = 6 * dpr;
    const arrowY = (yOffset - arrowHeight) / 2 + dpr;
    ctx.fillStyle = "#26a3d9";
    ctx.beginPath();
    ctx.moveTo(x, arrowY);
    ctx.lineTo(x + arrowWidth, arrowY + arrowHeight / 2);
    ctx.lineTo(x, arrowY + arrowHeight);
    ctx.closePath();
    ctx.fill();
    textX += arrowWidth + 2 * dpr;
  } else {
    ctx.strokeStyle = isMajor ? SALEAE_DARK_GRIDLINE_PRIMARY : SALEAE_DARK_GRIDLINE_SECONDARY;
    ctx.lineWidth = Math.max(1, dpr);
    ctx.beginPath();
    ctx.moveTo(crisp(x), yOffset);
    ctx.lineTo(crisp(x), heightCss * dpr);
    ctx.stroke();
  }

  ctx.fillStyle = "#ffffff";
  ctx.fillText(tick.label, textX, yOffset);
}

function crisp(value: number) {
  return Math.round(value) + 0.5;
}
