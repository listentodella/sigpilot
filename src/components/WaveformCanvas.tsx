import { PointerEvent, useEffect, useRef } from "react";
import type { WaveformTile } from "../lib/api";

interface WaveformCanvasProps {
  tile: WaveformTile | null;
  onWidthChange: (width: number) => void;
  sampleRateHz: number;
  totalSamples: number;
  viewportStart: number;
  viewportSamples: number;
  onViewportChange: (start: number, samples: number) => void;
}

const colors = ["#43baeb", "#ffcb46", "#00b140", "#f52a66"];
const graphPaddingLeft = 8;
const graphPaddingRight = 10;
const digitalGraphGutterPx = 8;
const digitalGraphLabelHeightPx = 16;
const digitalMeasurementBoxMinWidthPx = 110;

type EdgeKind = "rising" | "falling";

interface DigitalEdge {
  sample: number;
  kind: EdgeKind;
}

interface HoverMeasurement {
  channelIndex: number;
  pointerX: number;
  anchorKind: EdgeKind;
  widthStart: number;
  widthEnd: number | null;
  periodStart: number;
  periodEnd: number | null;
}

export function WaveformCanvas({
  tile,
  onWidthChange,
  sampleRateHz,
  totalSamples,
  viewportStart,
  viewportSamples,
  onViewportChange,
}: WaveformCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dragRef = useRef<{ x: number; start: number; samples: number } | null>(null);
  const tileRef = useRef<WaveformTile | null>(null);
  const viewportRef = useRef({ start: viewportStart, samples: viewportSamples });
  const sampleRateRef = useRef(sampleRateHz);
  const hoverRef = useRef<HoverMeasurement | null>(null);
  const pendingViewportRef = useRef<{ start: number; samples: number } | null>(null);
  const viewportFrameRef = useRef<number | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const observer = new ResizeObserver(([entry]) => {
      const rect = entry.contentRect;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.floor(rect.width * dpr));
      canvas.height = Math.max(1, Math.floor(rect.height * dpr));
      onWidthChange(Math.max(1, Math.floor(rect.width)));
      draw(canvas, tileRef.current, viewportRef.current.start, viewportRef.current.samples, hoverRef.current, sampleRateRef.current);
    });
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [onWidthChange]);

  useEffect(() => {
    tileRef.current = tile;
    viewportRef.current = { start: viewportStart, samples: viewportSamples };
    sampleRateRef.current = sampleRateHz;
    const canvas = canvasRef.current;
    if (canvas) draw(canvas, tile, viewportStart, viewportSamples, hoverRef.current, sampleRateHz);
  }, [sampleRateHz, tile, viewportSamples, viewportStart]);

  useEffect(() => {
    return () => {
      if (viewportFrameRef.current !== null) {
        cancelAnimationFrame(viewportFrameRef.current);
      }
    };
  }, []);

  function clampViewport(start: number, samples: number) {
    const minSamples = totalSamples ? 1 : 1;
    const nextSamples = Math.max(minSamples, Math.min(totalSamples || samples, Math.round(samples)));
    const maxStart = Math.max(0, (totalSamples || 0) - nextSamples);
    const nextStart = Math.max(0, Math.min(maxStart, Math.round(start)));
    scheduleViewportChange(nextStart, nextSamples);
  }

  function scheduleViewportChange(start: number, samples: number) {
    viewportRef.current = { start, samples };
    const canvas = canvasRef.current;
    if (canvas) draw(canvas, tileRef.current, start, samples, hoverRef.current, sampleRateRef.current);

    pendingViewportRef.current = { start, samples };
    if (viewportFrameRef.current !== null) return;
    viewportFrameRef.current = requestAnimationFrame(() => {
      viewportFrameRef.current = null;
      const next = pendingViewportRef.current;
      pendingViewportRef.current = null;
      if (next) onViewportChange(next.start, next.samples);
    });
  }

  function handleWheel(event: WheelEvent) {
    if (!totalSamples) return;
    event.preventDefault();
    hoverRef.current = null;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const xRatio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    const current = viewportRef.current;

    if (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY) * 1.2) {
      const deltaPixels = normalizeWheelDelta(event.deltaX || event.deltaY, event.deltaMode);
      const deltaSamples = (deltaPixels / Math.max(1, rect.width)) * current.samples;
      clampViewport(current.start + deltaSamples, current.samples);
      return;
    }

    const delta = normalizeWheelDelta(event.deltaY, event.deltaMode);
    const intensity = event.ctrlKey || event.metaKey || event.altKey ? 0.003 : 0.0015;
    const factor = Math.exp(Math.max(-800, Math.min(800, delta)) * intensity);
    const nextSamples = current.samples * factor;
    const anchor = current.start + current.samples * xRatio;
    clampViewport(anchor - nextSamples * xRatio, nextSamples);
  }

  function handlePointerDown(event: PointerEvent<HTMLCanvasElement>) {
    if (!totalSamples) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    hoverRef.current = null;
    dragRef.current = {
      x: event.clientX,
      start: viewportRef.current.start,
      samples: viewportRef.current.samples,
    };
  }

  function handlePointerMove(event: PointerEvent<HTMLCanvasElement>) {
    if (!totalSamples) return;
    if (!dragRef.current) {
      updateHover(event);
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    const deltaPixels = event.clientX - dragRef.current.x;
    const deltaSamples = (-deltaPixels / Math.max(1, rect.width)) * dragRef.current.samples;
    clampViewport(dragRef.current.start + deltaSamples, dragRef.current.samples);
  }

  function handlePointerUp(event: PointerEvent<HTMLCanvasElement>) {
    dragRef.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
    updateHover(event);
  }

  function handlePointerLeave() {
    hoverRef.current = null;
    const canvas = canvasRef.current;
    if (canvas) draw(canvas, tileRef.current, viewportRef.current.start, viewportRef.current.samples, null, sampleRateRef.current);
  }

  function updateHover(event: PointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const x = (event.clientX - rect.left) * dpr;
    const y = (event.clientY - rect.top) * dpr;
    hoverRef.current = findHoverMeasurement(
      canvas,
      tileRef.current,
      viewportRef.current.start,
      viewportRef.current.samples,
      x,
      y,
    );
    draw(canvas, tileRef.current, viewportRef.current.start, viewportRef.current.samples, hoverRef.current, sampleRateRef.current);
  }

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (event: WheelEvent) => handleWheel(event);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  });

  return (
    <canvas
      ref={canvasRef}
      className="waveform-canvas"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onPointerLeave={handlePointerLeave}
    />
  );
}

function normalizeWheelDelta(delta: number, deltaMode: number) {
  if (deltaMode === 1) return delta * 16;
  if (deltaMode === 2) return delta * 240;
  return delta;
}

function draw(
  canvas: HTMLCanvasElement,
  tile: WaveformTile | null,
  viewportStart: number,
  viewportSamples: number,
  hover: HoverMeasurement | null,
  sampleRateHz: number,
) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const width = canvas.width;
  const height = canvas.height;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#101013";
  ctx.fillRect(0, 0, width, height);

  drawGrid(ctx, width, height);

  if (!tile || tile.channels.length === 0) {
    ctx.fillStyle = "rgba(255,255,255,0.55)";
    ctx.font = `${12 * devicePixelRatio}px Roboto, Helvetica, Arial, sans-serif`;
    ctx.fillText("No capture loaded", 24 * devicePixelRatio, 36 * devicePixelRatio);
    return;
  }

  const dpr = window.devicePixelRatio || 1;
  const laneHeight = Math.max(34 * dpr, height / tile.channels.length);
  const left = graphPaddingLeft * dpr;
  const right = width - graphPaddingRight * dpr;
  const usableWidth = Math.max(1, right - left);
  const viewSamples = Math.max(1, viewportSamples || tile.sample_count || 1);
  const viewStart = viewportStart || 0;

  tile.channels.forEach((channel, index) => {
    const top = index * laneHeight;
    const highY = top + laneHeight * 0.28;
    const lowY = top + laneHeight * 0.72;
    ctx.strokeStyle = "rgba(255,255,255,0.075)";
    ctx.beginPath();
    ctx.moveTo(0, Math.floor(top) + 0.5);
    ctx.lineTo(width, Math.floor(top) + 0.5);
    ctx.stroke();

    if (channel.segments.length > 0) {
      drawDigitalSegments(ctx, {
        color: colors[index % colors.length],
        highY,
        lowY,
        left,
        right,
        viewSamples,
        viewStart,
        segments: channel.segments,
        dpr,
      });
    } else {
      drawDigitalChannel(ctx, {
        color: colors[index % colors.length],
        highY,
        lowY,
        left,
        right,
        viewSamples,
        viewStart,
        tileStart: tile.start_sample,
        samplesPerPixel: tile.samples_per_pixel,
        bins: channel.bins,
        dpr,
      });
    }
  });

  if (hover) {
    drawHoverMeasurement(ctx, canvas, tile, hover, viewportStart, viewportSamples, sampleRateHz);
  }
}

interface DigitalChannelDrawArgs {
  color: string;
  highY: number;
  lowY: number;
  left: number;
  right: number;
  viewSamples: number;
  viewStart: number;
  tileStart: number;
  samplesPerPixel: number;
  bins: WaveformTile["channels"][number]["bins"];
  dpr: number;
}

interface DigitalSegmentsDrawArgs {
  color: string;
  highY: number;
  lowY: number;
  left: number;
  right: number;
  viewSamples: number;
  viewStart: number;
  segments: WaveformTile["channels"][number]["segments"];
  dpr: number;
}

function drawDigitalSegments(ctx: CanvasRenderingContext2D, args: DigitalSegmentsDrawArgs) {
  const { color, highY, lowY, left, right, viewSamples, viewStart, segments, dpr } = args;
  ctx.lineWidth = Math.max(1.25 * dpr, 1);
  ctx.lineCap = "butt";
  ctx.lineJoin = "miter";
  ctx.strokeStyle = color;

  const path = new Path2D();
  segments.forEach((segment, index) => {
    const x0 = xForSample(segment.start_sample, left, right, viewStart, viewSamples);
    const x1 = xForSample(segment.end_sample, left, right, viewStart, viewSamples);
    if (x1 < left || x0 > right) return;

    const clippedX0 = Math.max(left, x0);
    const clippedX1 = Math.min(right, x1);
    const y = crispY(segment.high ? highY : lowY);
    path.moveTo(clippedX0, y);
    path.lineTo(clippedX1, y);

    const previous = segments[index - 1];
    if (previous && previous.high !== segment.high && x0 >= left && x0 <= right) {
      path.moveTo(crispX(x0), crispY(previous.high ? highY : lowY));
      path.lineTo(crispX(x0), y);
    }
  });
  ctx.stroke(path);
}

function drawDigitalChannel(ctx: CanvasRenderingContext2D, args: DigitalChannelDrawArgs) {
  const {
    color,
    highY,
    lowY,
    left,
    right,
    viewSamples,
    viewStart,
    tileStart,
    samplesPerPixel,
    bins,
    dpr,
  } = args;
  const lineWidth = Math.max(1.25 * dpr, 1);
  ctx.lineWidth = lineWidth;
  ctx.lineCap = "butt";
  ctx.lineJoin = "miter";
  ctx.strokeStyle = color;
  ctx.fillStyle = withAlpha(color, 0.9);

  const stablePath = new Path2D();
  const edgePath = new Path2D();

  bins.forEach((bin, binIndex) => {
    const sample0 = tileStart + binIndex * samplesPerPixel;
    const sample1 = sample0 + samplesPerPixel;
    const x0 = xForSample(sample0, left, right, viewStart, viewSamples);
    const x1 = xForSample(sample1, left, right, viewStart, viewSamples);
    if (x1 < left || x0 > right) return;

    const clippedX0 = Math.max(left, x0);
    const clippedX1 = Math.min(right, x1);
    const y0 = crispY(bin.first ? highY : lowY);
    const y1 = crispY(bin.last ? highY : lowY);
    const binWidth = Math.max(1, clippedX1 - clippedX0);

    if (bin.has_high && bin.has_low) {
      if (bin.edges <= 1 && bin.first_edge_offset != null) {
        const edgeX = Math.max(left, Math.min(right, xForSample(sample0 + bin.first_edge_offset, left, right, viewStart, viewSamples)));
        stablePath.moveTo(clippedX0, y0);
        stablePath.lineTo(edgeX, y0);
        edgePath.moveTo(crispX(edgeX), y0);
        edgePath.lineTo(crispX(edgeX), y1);
        stablePath.moveTo(edgeX, y1);
        stablePath.lineTo(clippedX1, y1);
        return;
      }

      const denseLeft = Math.floor(clippedX0);
      const denseWidth = Math.max(1, Math.ceil(binWidth));
      ctx.globalAlpha = 0.78;
      ctx.fillRect(denseLeft, Math.min(highY, lowY), denseWidth, Math.abs(lowY - highY));
      ctx.globalAlpha = 1;
      return;
    }

    stablePath.moveTo(clippedX0, y0);
    stablePath.lineTo(clippedX1, y0);
  });

  ctx.stroke(stablePath);
  ctx.stroke(edgePath);
}

function findHoverMeasurement(
  canvas: HTMLCanvasElement,
  tile: WaveformTile | null,
  viewportStart: number,
  viewportSamples: number,
  x: number,
  y: number,
): HoverMeasurement | null {
  if (!tile || tile.channels.length === 0) return null;
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.width;
  const height = canvas.height;
  const laneHeight = Math.max(34 * dpr, height / tile.channels.length);
  const channelIndex = Math.max(0, Math.min(tile.channels.length - 1, Math.floor(y / laneHeight)));
  const channel = tile.channels[channelIndex];
  const left = graphPaddingLeft * dpr;
  const right = width - graphPaddingRight * dpr;
  const viewSamples = Math.max(1, viewportSamples || tile.sample_count || 1);
  const pointerSample = viewportStart + ((Math.max(left, Math.min(right, x)) - left) / Math.max(1, right - left)) * viewSamples;
  const edges = collectDigitalEdges(tile, channelIndex);
  if (edges.length === 0) return null;

  const thresholdSamples = (14 * dpr * viewSamples) / Math.max(1, right - left);
  const nearestEdge = edges.reduce(
    (best, edge) => {
      const distance = Math.abs(edge.sample - pointerSample);
      return distance < best.distance ? { edge, distance } : best;
    },
    { edge: edges[0], distance: Math.abs(edges[0].sample - pointerSample) },
  );
  const snapped = nearestEdge.distance <= thresholdSamples;
  if (!snapped) {
    return null;
  }

  const risingEdges = channel.rising_edges.length
    ? channel.rising_edges
    : edges.filter((edge) => edge.kind === "rising").map((edge) => edge.sample);
  const fallingEdges = channel.falling_edges.length
    ? channel.falling_edges
    : edges.filter((edge) => edge.kind === "falling").map((edge) => edge.sample);
  const anchorKind = nearestEdge.edge.kind;
  const sameKindEdges = anchorKind === "rising" ? risingEdges : fallingEdges;
  const oppositeKindEdges = anchorKind === "rising" ? fallingEdges : risingEdges;
  const widthStart = nearestEdge.edge.sample;
  const widthEnd = findNextEdge(oppositeKindEdges, widthStart);
  const periodEnd = findNextEdge(sameKindEdges, widthStart);

  return {
    channelIndex,
    pointerX: x,
    anchorKind,
    widthStart,
    widthEnd,
    periodStart: widthStart,
    periodEnd,
  };
}

function drawHoverMeasurement(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  tile: WaveformTile,
  hover: HoverMeasurement,
  viewportStart: number,
  viewportSamples: number,
  sampleRateHz: number,
) {
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.width;
  const height = canvas.height;
  const laneHeight = Math.max(34 * dpr, height / tile.channels.length);
  const top = hover.channelIndex * laneHeight;
  const bottom = Math.min(height, top + laneHeight);
  const left = graphPaddingLeft * dpr;
  const right = width - graphPaddingRight * dpr;
  const viewSamples = Math.max(1, viewportSamples);
  const widthStartX = xForSample(hover.widthStart, left, right, viewportStart, viewSamples);
  const widthEndX = hover.widthEnd == null ? null : xForSample(hover.widthEnd, left, right, viewportStart, viewSamples);
  const periodStartX = xForSample(hover.periodStart, left, right, viewportStart, viewSamples);
  const periodEndX =
    hover.periodEnd == null ? null : xForSample(hover.periodEnd, left, right, viewportStart, viewSamples);
  const widthSamples =
    hover.widthEnd == null ? null : Math.max(0, Math.round(hover.widthEnd - hover.widthStart));
  const periodSamples =
    hover.periodEnd == null ? null : Math.max(0, Math.round(hover.periodEnd - hover.periodStart));

  ctx.save();

  if (widthEndX != null && widthSamples != null) {
    drawDistanceMeasurement(ctx, {
      label: formatDuration(widthSamples, sampleRateHz),
      startX: widthStartX,
      endX: widthEndX,
      rowTop: top,
      rowBottom: bottom,
      graphLeft: left,
      graphRight: right,
      placement: "top",
      dpr,
    });
  }

  if (periodEndX != null && periodSamples != null) {
    drawDistanceMeasurement(ctx, {
      label: formatDuration(periodSamples, sampleRateHz),
      startX: periodStartX,
      endX: periodEndX,
      rowTop: top,
      rowBottom: bottom,
      graphLeft: left,
      graphRight: right,
      placement: "bottom",
      dpr,
    });
  }

  drawDigitalExtraData(ctx, {
    hover,
    widthSamples,
    periodSamples,
    sampleRateHz,
    rowTop: top,
    rowBottom: bottom,
    canvasWidth: width,
    graphLeft: left,
    isFirstRow: hover.channelIndex === 0,
    isLastRow: hover.channelIndex === tile.channels.length - 1,
    dpr,
  });
  ctx.restore();
}

interface DistanceMeasurementDrawArgs {
  label: string;
  startX: number;
  endX: number;
  rowTop: number;
  rowBottom: number;
  graphLeft: number;
  graphRight: number;
  placement: "top" | "bottom";
  dpr: number;
}

function drawDistanceMeasurement(ctx: CanvasRenderingContext2D, args: DistanceMeasurementDrawArgs) {
  const { label, startX, endX, rowTop, rowBottom, graphLeft, graphRight, placement, dpr } = args;
  if (endX < graphLeft || startX > graphRight) return;

  const gutter = digitalGraphGutterPx * dpr;
  const arrowY = placement === "top" ? rowTop + gutter / 2 : rowBottom - gutter / 2;
  const guideTop = placement === "top" ? rowTop : rowBottom - gutter;
  const guideBottom = placement === "top" ? rowTop + gutter : rowBottom;
  const clippedStart = clamp(startX, graphLeft, graphRight);
  const clippedEnd = clamp(endX, graphLeft, graphRight);
  if (clippedEnd - clippedStart <= 5 * dpr) return;

  const color = "rgba(255, 255, 255, 0.46)";
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = Math.max(1, dpr);

  if (startX >= graphLeft && startX <= graphRight) {
    drawMeasurementGuide(ctx, startX, guideTop, guideBottom, dpr);
  }
  if (endX >= graphLeft && endX <= graphRight) {
    drawMeasurementGuide(ctx, endX, guideTop, guideBottom, dpr);
  }

  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(crispX(clippedStart), crispY(arrowY));
  ctx.lineTo(crispX(clippedEnd), crispY(arrowY));
  ctx.stroke();

  if (startX >= graphLeft && startX <= graphRight) {
    drawMeasurementArrowhead(ctx, crispX(startX), crispY(arrowY), "left", dpr);
  }
  if (endX >= graphLeft && endX <= graphRight) {
    drawMeasurementArrowhead(ctx, crispX(endX), crispY(arrowY), "right", dpr);
  }

  drawMeasurementLabel(ctx, {
    label,
    startX,
    endX,
    arrowY,
    graphLeft,
    graphRight,
    placement,
    dpr,
  });
  ctx.restore();
}

function drawMeasurementGuide(
  ctx: CanvasRenderingContext2D,
  x: number,
  top: number,
  bottom: number,
  dpr: number,
) {
  ctx.save();
  ctx.setLineDash([2 * dpr, 3 * dpr]);
  ctx.beginPath();
  ctx.moveTo(crispX(x), crispY(top));
  ctx.lineTo(crispX(x), crispY(bottom));
  ctx.stroke();
  ctx.restore();
}

function drawMeasurementArrowhead(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  side: "left" | "right",
  dpr: number,
) {
  const length = 6 * dpr;
  const halfHeight = 2.5 * dpr;
  ctx.beginPath();
  ctx.moveTo(x, y);
  if (side === "left") {
    ctx.lineTo(x + length, y - halfHeight);
    ctx.lineTo(x + length, y + halfHeight);
  } else {
    ctx.lineTo(x - length, y - halfHeight);
    ctx.lineTo(x - length, y + halfHeight);
  }
  ctx.closePath();
  ctx.fill();
}

interface MeasurementLabelDrawArgs {
  label: string;
  startX: number;
  endX: number;
  arrowY: number;
  graphLeft: number;
  graphRight: number;
  placement: "top" | "bottom";
  dpr: number;
}

function drawMeasurementLabel(ctx: CanvasRenderingContext2D, args: MeasurementLabelDrawArgs) {
  const { label, startX, endX, arrowY, graphLeft, graphRight, placement, dpr } = args;
  const paddingX = 4 * dpr;
  const labelHeight = digitalGraphLabelHeightPx * dpr;
  const clippedStart = clamp(startX, graphLeft, graphRight);
  const clippedEnd = clamp(endX, graphLeft, graphRight);
  const distance = clippedEnd - clippedStart;

  ctx.font = `${12 * dpr}px Roboto, Helvetica, Arial, sans-serif`;
  const labelWidth = ctx.measureText(label).width + paddingX * 2;
  const preferredX = distance < 100 * dpr ? clippedEnd + 4 * dpr : (clippedStart + clippedEnd - labelWidth) / 2;
  const minX = graphLeft + 2 * dpr;
  const maxX = Math.max(minX, graphRight - labelWidth - 2 * dpr);
  const boxX = clamp(preferredX, minX, maxX);
  const boxY = placement === "top" ? arrowY + 1 * dpr : arrowY - labelHeight - 1 * dpr;

  ctx.fillStyle = "rgba(43, 43, 48, 0.84)";
  roundRect(ctx, boxX, boxY, labelWidth, labelHeight, 2 * dpr);
  ctx.fill();

  ctx.fillStyle = "rgba(255, 255, 255, 0.92)";
  ctx.fillText(label, boxX + paddingX, boxY + labelHeight * 0.72);
}

interface DigitalExtraDataDrawArgs {
  hover: HoverMeasurement;
  widthSamples: number | null;
  periodSamples: number | null;
  sampleRateHz: number;
  rowTop: number;
  rowBottom: number;
  canvasWidth: number;
  graphLeft: number;
  isFirstRow: boolean;
  isLastRow: boolean;
  dpr: number;
}

function drawDigitalExtraData(ctx: CanvasRenderingContext2D, args: DigitalExtraDataDrawArgs) {
  const {
    hover,
    widthSamples,
    periodSamples,
    sampleRateHz,
    rowTop,
    rowBottom,
    canvasWidth,
    graphLeft,
    isFirstRow,
    isLastRow,
    dpr,
  } = args;
  if (widthSamples == null || widthSamples <= 0 || sampleRateHz <= 0) return;

  const lines: string[] = [];
  if (periodSamples != null && periodSamples > 0) {
    lines.push(`Duty: ${trim((widthSamples / periodSamples) * 100)} %`);
    lines.push(`Freq: ${formatFrequency(sampleRateHz / periodSamples)}`);
  }
  lines.push(`width^-1: ${formatFrequency(sampleRateHz / widthSamples)}`);

  const padding = 5 * dpr;
  const lineHeight = 18 * dpr;
  const minWidth = digitalMeasurementBoxMinWidthPx * dpr;
  ctx.font = `${12 * dpr}px Roboto, Helvetica, Arial, sans-serif`;
  const boxWidth = Math.max(minWidth, Math.max(...lines.map((line) => ctx.measureText(line).width)) + padding * 2);
  const boxHeight = lines.length * lineHeight + padding * 2;
  const margin = 30 * dpr;
  const placeOnLeft = hover.pointerX > canvasWidth / 2;
  const preferredX = placeOnLeft ? graphLeft + margin : canvasWidth - boxWidth - margin;
  const boxX = clamp(preferredX, graphLeft + 2 * dpr, Math.max(graphLeft + 2 * dpr, canvasWidth - boxWidth - 2 * dpr));
  const boxY = isFirstRow
    ? rowTop + 5 * dpr
    : isLastRow
      ? rowBottom - boxHeight - 5 * dpr
      : rowTop + (rowBottom - rowTop - boxHeight) / 2;

  ctx.fillStyle = "rgba(16, 16, 19, 0.9)";
  ctx.strokeStyle = "rgba(255, 255, 255, 0.18)";
  ctx.lineWidth = Math.max(1, dpr);
  roundRect(ctx, boxX, boxY, boxWidth, boxHeight, 4 * dpr);
  ctx.fill();
  ctx.stroke();

  lines.forEach((line, index) => {
    ctx.fillStyle = "rgba(255, 255, 255, 0.72)";
    ctx.fillText(line, boxX + padding, boxY + padding + (index + 0.78) * lineHeight);
  });
}

function collectDigitalEdges(tile: WaveformTile, channelIndex: number): DigitalEdge[] {
  const channel = tile.channels[channelIndex];
  if (!channel) return [];
  if (channel.rising_edges.length || channel.falling_edges.length) {
    return [
      ...channel.rising_edges.map((sample) => ({ sample, kind: "rising" as const })),
      ...channel.falling_edges.map((sample) => ({ sample, kind: "falling" as const })),
    ].sort((a, b) => a.sample - b.sample);
  }
  const edges: DigitalEdge[] = [];
  channel.bins.forEach((bin, binIndex) => {
    if (!bin.edges || !(bin.has_high && bin.has_low)) return;
    const sample0 = tile.start_sample + binIndex * tile.samples_per_pixel;
    const first = bin.first_edge_offset == null ? tile.samples_per_pixel / 2 : bin.first_edge_offset;
    edges.push({ sample: sample0 + first, kind: bin.first ? "falling" : "rising" });
    if (bin.edges > 1 && bin.last_edge_offset != null && bin.last_edge_offset !== bin.first_edge_offset) {
      edges.push({ sample: sample0 + bin.last_edge_offset, kind: bin.last ? "rising" : "falling" });
    }
  });
  return edges.sort((a, b) => a.sample - b.sample);
}

function findNextEdge(edges: number[], sample: number) {
  for (const edge of edges) {
    if (edge > sample) return edge;
  }
  return null;
}

function xForSample(sample: number, left: number, right: number, viewStart: number, viewSamples: number) {
  return left + ((sample - viewStart) / viewSamples) * Math.max(1, right - left);
}

function crispX(value: number) {
  return Math.round(value) + 0.5;
}

function crispY(value: number) {
  return Math.round(value) + 0.5;
}

function withAlpha(color: string, alpha: number) {
  if (!color.startsWith("#") || color.length !== 7) return color;
  const r = Number.parseInt(color.slice(1, 3), 16);
  const g = Number.parseInt(color.slice(3, 5), 16);
  const b = Number.parseInt(color.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function formatDuration(samples: number, sampleRateHz: number) {
  if (!Number.isFinite(samples) || !Number.isFinite(sampleRateHz) || sampleRateHz <= 0) return "--";
  const seconds = samples / sampleRateHz;
  if (seconds < 1e-9) return `${trim(seconds * 1e12)} ps`;
  if (seconds < 1e-6) return `${trim(seconds * 1e9)} ns`;
  if (seconds < 1e-3) return `${trim(seconds * 1e6)} us`;
  if (seconds < 1) return `${trim(seconds * 1e3)} ms`;
  return `${trim(seconds)} s`;
}

function formatFrequency(hz: number) {
  if (!Number.isFinite(hz)) return "--";
  const value = Math.abs(hz);
  if (value >= 1e9) return `${trim(hz / 1e9)} GHz`;
  if (value >= 1e6) return `${trim(hz / 1e6)} MHz`;
  if (value >= 1e3) return `${trim(hz / 1e3)} kHz`;
  return `${trim(hz)} Hz`;
}

function trim(value: number) {
  if (Math.abs(value) >= 100) return value.toFixed(0);
  if (Math.abs(value) >= 10) return value.toFixed(1).replace(/\.0$/, "");
  return value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + width, y, x + width, y + height, radius);
  ctx.arcTo(x + width, y + height, x, y + height, radius);
  ctx.arcTo(x, y + height, x, y, radius);
  ctx.arcTo(x, y, x + width, y, radius);
  ctx.closePath();
}

function drawGrid(ctx: CanvasRenderingContext2D, width: number, height: number) {
  const dpr = window.devicePixelRatio || 1;
  ctx.strokeStyle = "rgba(255,255,255,0.06)";
  ctx.lineWidth = 1;
  const step = 96 * dpr;
  for (let x = 0; x < width; x += step) {
    ctx.beginPath();
    ctx.moveTo(Math.floor(x) + 0.5, 0);
    ctx.lineTo(Math.floor(x) + 0.5, height);
    ctx.stroke();
  }
}
