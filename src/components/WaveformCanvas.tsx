import { PointerEvent, useEffect, useRef, useState } from "react";
import type { WaveformTile } from "../lib/api";
import {
  SALEAE_DEFAULT_DIGITAL_ROW_HEIGHT_PX,
  SALEAE_DIGITAL_ROW_V2_MIN_HEIGHT_PX,
  SALEAE_ROW_V2_SPACING_PX,
  SALEAE_TIME_RULER_HEIGHT_PX,
} from "../lib/saleaeChannelLayout";
import { saleaeLegacyChannelColor } from "../lib/saleaeChannelColors";
import {
  getHorizontalGraphTicks,
  minimumHorizontalTickSpacingPx,
  TimingTick,
} from "../lib/saleaeTimingDisplay";

interface WaveformCanvasProps {
  rowHeights: number[];
  tile: WaveformTile | null;
  onWidthChange: (width: number) => void;
  sampleRateHz: number;
  totalSamples: number;
  viewportStart: number;
  viewportSamples: number;
  onViewportChange: (start: number, samples: number) => void;
}

const graphPaddingLeft = 8;
const graphPaddingRight = 10;
const digitalGraphGutterPx = 8;
const digitalGraphLabelHeightPx = 16;
const digitalMeasurementBoxMinWidthPx = 110;
const timeRulerHeightPx = SALEAE_TIME_RULER_HEIGHT_PX;
const panningAnimationDurationMs = 300;

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

type EdgeNavigationDirection = "previous" | "next";

interface HoverNavigation {
  channelIndex: number;
  topPx: number;
  previousEdge: number | null;
  nextEdge: number | null;
}

export function WaveformCanvas({
  rowHeights,
  tile,
  onWidthChange,
  sampleRateHz,
  totalSamples,
  viewportStart,
  viewportSamples,
  onViewportChange,
}: WaveformCanvasProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dragRef = useRef<{ x: number; start: number; samples: number } | null>(null);
  const tileRef = useRef<WaveformTile | null>(null);
  const viewportRef = useRef({ start: viewportStart, samples: viewportSamples });
  const sampleRateRef = useRef(sampleRateHz);
  const totalSamplesRef = useRef(totalSamples);
  const rowHeightsRef = useRef(rowHeights);
  const hoverRef = useRef<HoverMeasurement | null>(null);
  const hoverNavigationRef = useRef<HoverNavigation | null>(null);
  const pendingViewportRef = useRef<{ start: number; samples: number } | null>(null);
  const viewportFrameRef = useRef<number | null>(null);
  const animatedViewportFrameRef = useRef<number | null>(null);
  const [hoverNavigation, setHoverNavigation] = useState<HoverNavigation | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas) return;
    const observer = new ResizeObserver(([entry]) => {
      const rect = entry.contentRect;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.floor(rect.width * dpr));
      canvas.height = Math.max(1, Math.floor(rect.height * dpr));
      onWidthChange(Math.max(1, Math.floor(rect.width)));
      draw(
        canvas,
        tileRef.current,
        viewportRef.current.start,
        viewportRef.current.samples,
        hoverRef.current,
        sampleRateRef.current,
        rowHeightsRef.current,
      );
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, [onWidthChange]);

  useEffect(() => {
    tileRef.current = tile;
    viewportRef.current = { start: viewportStart, samples: viewportSamples };
    sampleRateRef.current = sampleRateHz;
    totalSamplesRef.current = totalSamples;
    rowHeightsRef.current = rowHeights;
    const canvas = canvasRef.current;
    if (canvas) draw(canvas, tile, viewportStart, viewportSamples, hoverRef.current, sampleRateHz, rowHeights);
  }, [rowHeights, sampleRateHz, tile, totalSamples, viewportSamples, viewportStart]);

  useEffect(() => {
    return () => {
      if (viewportFrameRef.current !== null) {
        cancelAnimationFrame(viewportFrameRef.current);
      }
      cancelViewportAnimation();
    };
  }, []);

  function setNavigation(next: HoverNavigation | null) {
    hoverNavigationRef.current = next;
    setHoverNavigation((current) => (sameHoverNavigation(current, next) ? current : next));
  }

  function clampViewport(start: number, samples: number) {
    const next = normalizeViewport(start, samples, totalSamplesRef.current);
    scheduleViewportChange(next.start, next.samples);
  }

  function scheduleViewportChange(start: number, samples: number) {
    viewportRef.current = { start, samples };
    const canvas = canvasRef.current;
    if (canvas) {
      draw(
        canvas,
        tileRef.current,
        start,
        samples,
        hoverRef.current,
        sampleRateRef.current,
        rowHeightsRef.current,
      );
    }
    syncNavigationToViewport(start, samples);

    pendingViewportRef.current = { start, samples };
    if (viewportFrameRef.current !== null) return;
    viewportFrameRef.current = requestAnimationFrame(() => {
      viewportFrameRef.current = null;
      const next = pendingViewportRef.current;
      pendingViewportRef.current = null;
      if (next) onViewportChange(next.start, next.samples);
    });
  }

  function animateViewportTo(start: number, samples: number) {
    cancelViewportAnimation();
    const target = normalizeViewport(start, samples, totalSamplesRef.current);
    const initial = viewportRef.current;
    const startDelta = target.start - initial.start;
    const samplesDelta = target.samples - initial.samples;
    if (Math.abs(startDelta) < 1 && Math.abs(samplesDelta) < 1) {
      scheduleViewportChange(target.start, target.samples);
      return;
    }

    const startedAt = performance.now();
    const step = (now: number) => {
      const progress = clamp((now - startedAt) / panningAnimationDurationMs, 0, 1);
      const eased = easeOutCubic(progress);
      scheduleViewportChange(initial.start + startDelta * eased, initial.samples + samplesDelta * eased);

      if (progress < 1) {
        animatedViewportFrameRef.current = requestAnimationFrame(step);
      } else {
        animatedViewportFrameRef.current = null;
        scheduleViewportChange(target.start, target.samples);
      }
    };

    animatedViewportFrameRef.current = requestAnimationFrame(step);
  }

  function cancelViewportAnimation() {
    if (animatedViewportFrameRef.current !== null) {
      cancelAnimationFrame(animatedViewportFrameRef.current);
      animatedViewportFrameRef.current = null;
    }
  }

  function syncNavigationToViewport(start: number, samples: number) {
    const currentNavigation = hoverNavigationRef.current;
    const host = hostRef.current;
    if (!currentNavigation || !host) return;

    const channelLayout = getChannelLayout(rowHeightsRef.current, tileRef.current?.channels.length ?? 0)[
      currentNavigation.channelIndex
    ];
    if (!channelLayout) return;
    setNavigation(
      findChannelNavigation(
        tileRef.current,
        currentNavigation.channelIndex,
        start,
        samples,
        channelLayout.top,
        channelLayout.height,
      ),
    );
  }

  function jumpToEdge(direction: EdgeNavigationDirection) {
    const navigation = hoverNavigationRef.current;
    const edgeSample = direction === "next" ? navigation?.nextEdge : navigation?.previousEdge;
    if (edgeSample == null) return;

    const current = viewportRef.current;
    const offset = current.samples * (direction === "next" ? 0.25 : 0.75);
    hoverRef.current = null;
    animateViewportTo(edgeSample - offset, current.samples);
  }

  function handleWheel(event: WheelEvent) {
    if (!totalSamplesRef.current) return;
    event.preventDefault();
    cancelViewportAnimation();
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

  function handlePointerDown(event: PointerEvent<HTMLDivElement>) {
    if (!totalSamplesRef.current) return;
    cancelViewportAnimation();
    event.currentTarget.setPointerCapture(event.pointerId);
    hoverRef.current = null;
    dragRef.current = {
      x: event.clientX,
      start: viewportRef.current.start,
      samples: viewportRef.current.samples,
    };
  }

  function handlePointerMove(event: PointerEvent<HTMLDivElement>) {
    if (!totalSamplesRef.current) return;
    if (!dragRef.current) {
      updateHover(event);
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    const deltaPixels = event.clientX - dragRef.current.x;
    const deltaSamples = (-deltaPixels / Math.max(1, rect.width)) * dragRef.current.samples;
    clampViewport(dragRef.current.start + deltaSamples, dragRef.current.samples);
  }

  function handlePointerUp(event: PointerEvent<HTMLDivElement>) {
    dragRef.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
    updateHover(event);
  }

  function handlePointerLeave() {
    hoverRef.current = null;
    setNavigation(null);
    const canvas = canvasRef.current;
    if (canvas) {
      draw(
        canvas,
        tileRef.current,
        viewportRef.current.start,
        viewportRef.current.samples,
        null,
        sampleRateRef.current,
        rowHeightsRef.current,
      );
    }
  }

  function updateHover(event: PointerEvent<HTMLDivElement>) {
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
      rowHeightsRef.current,
    );
    setNavigation(
      findHoverNavigation(
        rect,
        tileRef.current,
        viewportRef.current.start,
        viewportRef.current.samples,
        event.clientY - rect.top,
        rowHeightsRef.current,
      ),
    );
    draw(
      canvas,
      tileRef.current,
      viewportRef.current.start,
      viewportRef.current.samples,
      hoverRef.current,
      sampleRateRef.current,
      rowHeightsRef.current,
    );
  }

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const onWheel = (event: WheelEvent) => handleWheel(event);
    host.addEventListener("wheel", onWheel, { passive: false });
    return () => host.removeEventListener("wheel", onWheel);
  });

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (!hoverNavigationRef.current || isTextEditingTarget(event.target)) return;
      const isCommandOrCtrl = event.metaKey || event.ctrlKey;
      if (!isCommandOrCtrl) return;

      if (event.key === "ArrowLeft") {
        event.preventDefault();
        jumpToEdge("previous");
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        jumpToEdge("next");
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  });

  return (
    <div
      ref={hostRef}
      className="waveformCanvasHost"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onPointerLeave={handlePointerLeave}
    >
      <canvas ref={canvasRef} className="waveform-canvas" />
      {hoverNavigation?.previousEdge != null && (
        <DigitalNavigationButton
          direction="previous"
          top={hoverNavigation.topPx}
          onNavigate={() => jumpToEdge("previous")}
        />
      )}
      {hoverNavigation?.nextEdge != null && (
        <DigitalNavigationButton
          direction="next"
          top={hoverNavigation.topPx}
          onNavigate={() => jumpToEdge("next")}
        />
      )}
    </div>
  );
}

function normalizeWheelDelta(delta: number, deltaMode: number) {
  if (deltaMode === 1) return delta * 16;
  if (deltaMode === 2) return delta * 240;
  return delta;
}

function DigitalNavigationButton({
  direction,
  onNavigate,
  top,
}: {
  direction: EdgeNavigationDirection;
  onNavigate: () => void;
  top: number;
}) {
  const label = direction === "next" ? "Next Edge" : "Previous Edge";
  const shortcutPieces = shortcutPiecesForEdgeNavigation(direction);
  return (
    <button
      type="button"
      className={`digitalNavigationButton ${direction}`}
      style={{ top }}
      aria-label={`${label} (${shortcutPieces.join(" + ")})`}
      onPointerDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        onNavigate();
      }}
    >
      {direction === "next" ? <JumpToNextEdgeIcon /> : <JumpToPreviousEdgeIcon />}
      <span className={`edgeNavigationTooltip ${direction}`} role="tooltip">
        <span>{label}</span>
        <span className="shortcutIcon">
          {shortcutPieces.map((piece, index) => (
            <span className="shortcutPiece" key={`${piece}-${index}`}>
              {piece}
            </span>
          ))}
        </span>
      </span>
    </button>
  );
}

function shortcutPiecesForEdgeNavigation(direction: EdgeNavigationDirection) {
  const isMac =
    typeof navigator !== "undefined" &&
    (/Mac|iPhone|iPad|iPod/.test(navigator.platform) || /Mac/.test(navigator.userAgent));
  return [isMac ? "⌘" : "Ctrl", direction === "next" ? "→" : "←"];
}

function JumpToNextEdgeIcon() {
  return (
    <svg width="16" height="11" viewBox="0 0 16 11" aria-hidden="true">
      <path
        d="M7.12072 5.86709L7.09386 6.30951L7.52986 6.38923L10.2479 6.88626L10.2254 7.01195L6.95778 6.41443L6.86784 6.90627L6.95778 6.41443L6.8932 6.40262L6.90461 6.33797L6.90886 6.31393L6.91074 6.28959L7.1668 2.97831L7.2947 3.00141L7.12072 5.86709Z"
        fill="currentColor"
        stroke="currentColor"
      />
      <path
        d="M14.8043 7.11793C12.1828 1.90948 10.6869 1.79842 7.27213 6.13904"
        stroke="currentColor"
        fill="none"
        strokeWidth="1.5"
      />
      <path d="M6 9H3.09502V2H0" stroke="currentColor" fill="none" strokeWidth="1.5" />
    </svg>
  );
}

function JumpToPreviousEdgeIcon() {
  return (
    <svg width="16" height="11" viewBox="0 0 16 11" aria-hidden="true">
      <path
        d="M8.87928 5.86709L8.90614 6.30951L8.47014 6.38923L5.75209 6.88626L5.77456 7.01195L9.04222 6.41443L9.13216 6.90627L9.04222 6.41443L9.1068 6.40262L9.09539 6.33797L9.09114 6.31393L9.08926 6.28959L8.8332 2.97831L8.7053 3.00141L8.87928 5.86709Z"
        fill="currentColor"
        stroke="currentColor"
      />
      <path
        d="M1.19569 7.11793C3.81716 1.90948 5.31308 1.79842 8.72787 6.13904"
        stroke="currentColor"
        fill="none"
        strokeWidth="1.5"
      />
      <path d="M10 9H12.905V2H16" stroke="currentColor" fill="none" strokeWidth="1.5" />
    </svg>
  );
}

function draw(
  canvas: HTMLCanvasElement,
  tile: WaveformTile | null,
  viewportStart: number,
  viewportSamples: number,
  hover: HoverMeasurement | null,
  sampleRateHz: number,
  rowHeights: number[],
) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const width = canvas.width;
  const height = canvas.height;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#101013";
  ctx.fillRect(0, 0, width, height);

  drawTimeGrid(ctx, width, height, viewportStart, viewportSamples, sampleRateHz);

  if (!tile || tile.channels.length === 0) {
    ctx.fillStyle = "rgba(255,255,255,0.55)";
    ctx.font = `${12 * devicePixelRatio}px Roboto, Helvetica, Arial, sans-serif`;
    ctx.fillText(
      tile ? "No channels visible" : "No capture loaded",
      24 * devicePixelRatio,
      (timeRulerHeightPx + 24) * devicePixelRatio,
    );
    return;
  }

  const dpr = window.devicePixelRatio || 1;
  const channelLayout = getChannelLayout(rowHeights, tile.channels.length, dpr);
  const left = graphPaddingLeft * dpr;
  const right = width - graphPaddingRight * dpr;
  const usableWidth = Math.max(1, right - left);
  const viewSamples = Math.max(1, viewportSamples || tile.sample_count || 1);
  const viewStart = viewportStart || 0;

  tile.channels.forEach((channel, index) => {
    const layout = channelLayout[index];
    const top = layout.top;
    const laneHeight = layout.height;
    const highY = top + laneHeight * 0.28;
    const lowY = top + laneHeight * 0.72;
    ctx.strokeStyle = "rgba(255,255,255,0.075)";
    ctx.beginPath();
    ctx.moveTo(0, Math.floor(top) + 0.5);
    ctx.lineTo(width, Math.floor(top) + 0.5);
    ctx.stroke();

    if (channel.segments.length > 0) {
      drawDigitalSegments(ctx, {
        color: saleaeLegacyChannelColor(channel.channel),
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
        color: saleaeLegacyChannelColor(channel.channel),
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
    drawHoverMeasurement(ctx, canvas, tile, hover, viewportStart, viewportSamples, sampleRateHz, rowHeights);
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

function findHoverNavigation(
  rect: DOMRect,
  tile: WaveformTile | null,
  viewportStart: number,
  viewportSamples: number,
  y: number,
  rowHeights: number[],
): HoverNavigation | null {
  if (!tile || tile.channels.length === 0) return null;
  if (y < timeRulerHeightPx) return null;
  const channelLayout = getChannelLayout(rowHeights, tile.channels.length);
  const channelIndex = findChannelIndexAtY(channelLayout, Math.min(rect.height, y));
  if (channelIndex === null) return null;
  const layout = channelLayout[channelIndex];
  return findChannelNavigation(tile, channelIndex, viewportStart, viewportSamples, layout.top, layout.height);
}

function findChannelNavigation(
  tile: WaveformTile | null,
  channelIndex: number,
  viewportStart: number,
  viewportSamples: number,
  channelTop: number,
  laneHeight: number,
): HoverNavigation | null {
  if (!tile || tile.channels.length === 0) return null;
  if (channelIndex < 0 || channelIndex >= tile.channels.length) return null;
  const edges = collectDigitalEdges(tile, channelIndex);
  if (edges.length === 0) return null;

  const viewportEnd = viewportStart + viewportSamples;
  const previousEdge = findPreviousEdge(edges, viewportStart);
  const nextEdge = findNextEdgeSample(edges, viewportEnd);
  if (previousEdge == null && nextEdge == null) return null;

  return {
    channelIndex,
    topPx: channelTop + Math.max(0, laneHeight - 26) / 2,
    previousEdge,
    nextEdge,
  };
}

interface ChannelLayout {
  height: number;
  top: number;
}

function getChannelLayout(rowHeights: number[], channelCount: number, scale = 1): ChannelLayout[] {
  let top = timeRulerHeightPx * scale;
  return Array.from({ length: channelCount }, (_, index) => {
    const height =
      Math.max(
        SALEAE_DIGITAL_ROW_V2_MIN_HEIGHT_PX,
        rowHeights[index] ?? SALEAE_DEFAULT_DIGITAL_ROW_HEIGHT_PX,
      ) * scale;
    const layout = { height, top };
    top += height + SALEAE_ROW_V2_SPACING_PX * scale;
    return layout;
  });
}

function findChannelIndexAtY(layout: ChannelLayout[], y: number) {
  for (let index = 0; index < layout.length; index += 1) {
    const row = layout[index];
    if (y >= row.top && y <= row.top + row.height) return index;
  }
  return null;
}

function findHoverMeasurement(
  canvas: HTMLCanvasElement,
  tile: WaveformTile | null,
  viewportStart: number,
  viewportSamples: number,
  x: number,
  y: number,
  rowHeights: number[],
): HoverMeasurement | null {
  if (!tile || tile.channels.length === 0) return null;
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.width;
  const channelIndex = findChannelIndexAtY(getChannelLayout(rowHeights, tile.channels.length, dpr), y);
  if (channelIndex === null) return null;
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
  rowHeights: number[],
) {
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.width;
  const height = canvas.height;
  const layout = getChannelLayout(rowHeights, tile.channels.length, dpr)[hover.channelIndex];
  if (!layout) return;
  const laneHeight = layout.height;
  const top = layout.top;
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

function findPreviousEdge(edges: DigitalEdge[], sample: number) {
  for (let index = edges.length - 1; index >= 0; index -= 1) {
    if (edges[index].sample < sample) return edges[index].sample;
  }
  return null;
}

function findNextEdgeSample(edges: DigitalEdge[], sample: number) {
  for (const edge of edges) {
    if (edge.sample > sample) return edge.sample;
  }
  return null;
}

function sameHoverNavigation(left: HoverNavigation | null, right: HoverNavigation | null) {
  if (left === right) return true;
  if (!left || !right) return false;
  return (
    left.channelIndex === right.channelIndex &&
    left.topPx === right.topPx &&
    left.previousEdge === right.previousEdge &&
    left.nextEdge === right.nextEdge
  );
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

function normalizeViewport(start: number, samples: number, totalSamples: number) {
  const minSamples = totalSamples ? 1 : 1;
  const nextSamples = Math.max(minSamples, Math.min(totalSamples || samples, Math.round(samples)));
  const maxStart = Math.max(0, (totalSamples || 0) - nextSamples);
  const nextStart = Math.max(0, Math.min(maxStart, Math.round(start)));
  return { start: nextStart, samples: nextSamples };
}

function easeOutCubic(progress: number) {
  return 1 - Math.pow(1 - progress, 3);
}

function isTextEditingTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  return ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || target.isContentEditable;
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

function drawTimeGrid(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  viewportStart: number,
  viewportSamples: number,
  sampleRateHz: number,
) {
  const dpr = window.devicePixelRatio || 1;
  const rulerHeight = timeRulerHeightPx * dpr;
  const left = graphPaddingLeft * dpr;
  const right = width - graphPaddingRight * dpr;
  const usableWidth = Math.max(1, right - left);
  const usableWidthCss = usableWidth / dpr;

  ctx.save();
  ctx.fillStyle = "#131316";
  ctx.fillRect(0, 0, width, rulerHeight);
  const backgroundGradient = ctx.createLinearGradient(0, 0, 0, 20 * dpr);
  backgroundGradient.addColorStop(0, "rgba(0, 0, 0, 0.08)");
  backgroundGradient.addColorStop(1, "rgba(0, 0, 0, 0)");
  ctx.fillStyle = backgroundGradient;
  ctx.fillRect(0, 0, width, 20 * dpr);
  ctx.strokeStyle = "#1a1a1d";
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(0, crispY(rulerHeight));
  ctx.lineTo(width, crispY(rulerHeight));
  ctx.stroke();

  if (!Number.isFinite(sampleRateHz) || sampleRateHz <= 0 || !Number.isFinite(viewportSamples) || viewportSamples <= 0) {
    const fallbackStep = minimumHorizontalTickSpacingPx * dpr;
    for (let x = left; x < right; x += fallbackStep) {
      drawVerticalGridLine(ctx, x, rulerHeight, height, "minor", dpr);
    }
    ctx.restore();
    return;
  }

  const startSeconds = viewportStart / sampleRateHz;
  const viewportSeconds = Math.max(Number.EPSILON, viewportSamples / sampleRateHz);
  const timeSecondsPerPixel = viewportSeconds / usableWidthCss;
  const gridTicks = getHorizontalGraphTicks(startSeconds, timeSecondsPerPixel, usableWidthCss, {
    majorThresholdPx: 0,
    minorThresholdPx: 0,
  });
  const displayTicks = getHorizontalGraphTicks(startSeconds, timeSecondsPerPixel, usableWidthCss, {
    minorThresholdPx: minimumHorizontalTickSpacingPx,
    addClosestOffscreenMajorTicks: true,
    negativeMinorTicks: true,
  });

  for (const tick of gridTicks.majorTicks) {
    drawVerticalGridLine(ctx, left + tick.leftPx * dpr, rulerHeight, height, "major", dpr);
  }
  for (const tick of gridTicks.minorTicks) {
    drawVerticalGridLine(ctx, left + tick.leftPx * dpr, rulerHeight, height, "minor", dpr);
  }

  ctx.font = `700 ${11 * dpr}px Roboto, Helvetica, Arial, sans-serif`;
  ctx.textBaseline = "bottom";
  for (const tick of displayTicks.majorTicks) {
    drawTimingTick(ctx, tick, left, right, rulerHeight, true, dpr);
  }
  for (const tick of displayTicks.minorTicks) {
    drawTimingTick(ctx, tick, left, right, rulerHeight, false, dpr);
  }
  ctx.restore();
}

function drawVerticalGridLine(
  ctx: CanvasRenderingContext2D,
  x: number,
  top: number,
  bottom: number,
  level: "major" | "minor",
  dpr: number,
) {
  if (x < 0 || x > ctx.canvas.width) return;
  ctx.save();
  ctx.strokeStyle = level === "major" ? "#1a1a1d" : "#262629";
  ctx.lineWidth = Math.max(1, dpr);
  ctx.setLineDash([3 * dpr, 3 * dpr]);
  ctx.beginPath();
  ctx.moveTo(crispX(x), top);
  ctx.lineTo(crispX(x), bottom);
  ctx.stroke();
  ctx.restore();
}

function drawTimingTick(
  ctx: CanvasRenderingContext2D,
  tick: TimingTick,
  left: number,
  right: number,
  height: number,
  isMajor: boolean,
  dpr: number,
) {
  const yOffset = isMajor ? height * 0.5 : height - 3 * dpr;
  const x = left + tick.leftPx * dpr;
  let textX = x + (isMajor ? 0 : -2.5 * dpr);
  ctx.save();
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
    ctx.strokeStyle = isMajor ? "#1a1a1d" : "#262629";
    ctx.lineWidth = Math.max(1, dpr);
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(crispX(x), yOffset);
    ctx.lineTo(crispX(x), height);
    ctx.stroke();
  }

  ctx.fillStyle = isMajor ? "#ffffff" : "rgba(255, 255, 255, 0.74)";
  const textWidth = ctx.measureText(tick.label).width;
  const clampedTextX = clamp(textX, left, Math.max(left, right - textWidth));
  ctx.fillText(tick.label, clampedTextX, yOffset);
  ctx.restore();
}
