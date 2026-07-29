import { MouseEvent as ReactMouseEvent, PointerEvent, useEffect, useRef, useState } from "react";
import type { WaveformTile } from "../lib/api";
import {
  findSaleaeGraphChannelIndexAtY,
  getSaleaeGraphChannelLayout,
} from "../lib/saleaeGraphLayout";
import { saleaeLegacyChannelColor } from "../lib/saleaeChannelColors";
import {
  getHorizontalGraphTicks,
  minimumHorizontalTickSpacingPx,
  SALEAE_DARK_GRIDLINE_PRIMARY,
  SALEAE_DARK_GRIDLINE_SECONDARY,
} from "../lib/saleaeTimingDisplay";

interface WaveformCanvasProps {
  isLive?: boolean;
  rowHeights: number[];
  rowTopInsets?: number[];
  tile: WaveformTile | null;
  onWidthChange: (width: number) => void;
  matchChannelColors?: boolean;
  sampleRateHz: number;
  timeOriginSample?: number;
  showInteractiveMeasurement?: boolean;
  totalSamples: number;
  viewportStart: number;
  viewportSamples: number;
  onOpenContextMenu?: (event: {
    channelIndex: number;
    clientX: number;
    clientY: number;
    sample: number;
  }) => void;
  onViewportChange: (start: number, samples: number) => void;
  onViewportInteractionChange?: (active: boolean) => void;
}

interface RowHitTarget {
  channelIndex: number;
  height: number;
  top: number;
}

const graphPaddingLeft = 0;
const graphPaddingRight = 0;
const digitalGraphGutterPx = 8;
const digitalGraphLabelHeightPx = 16;
const digitalMeasurementBoxMinWidthPx = 110;
const panningAnimationDurationMs = 300;
const liveViewportInterpolationMs = 55;
const packedDigitalBinBytes = 16;
const packedDigitalBinCache = new WeakMap<object, DataView>();
const digitalEdgeCache = new WeakMap<object, DigitalEdge[]>();

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
  isLive = false,
  rowHeights,
  rowTopInsets = [],
  tile,
  onWidthChange,
  matchChannelColors = true,
  sampleRateHz,
  timeOriginSample = 0,
  showInteractiveMeasurement = true,
  totalSamples,
  viewportStart,
  viewportSamples,
  onOpenContextMenu,
  onViewportChange,
  onViewportInteractionChange,
}: WaveformCanvasProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const measurementCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const dragRef = useRef<{ x: number; start: number; samples: number } | null>(null);
  const tileRef = useRef<WaveformTile | null>(null);
  const viewportRef = useRef({ start: viewportStart, samples: viewportSamples });
  const viewportPropsRef = useRef({ start: viewportStart, samples: viewportSamples });
  const sampleRateRef = useRef(sampleRateHz);
  const timeOriginSampleRef = useRef(timeOriginSample);
  const totalSamplesRef = useRef(totalSamples);
  const rowHeightsRef = useRef(rowHeights);
  const rowTopInsetsRef = useRef(rowTopInsets);
  const onViewportChangeRef = useRef(onViewportChange);
  const onViewportInteractionChangeRef = useRef(onViewportInteractionChange);
  const onWidthChangeRef = useRef(onWidthChange);
  const hoverRef = useRef<HoverMeasurement | null>(null);
  const showInteractiveMeasurementRef = useRef(showInteractiveMeasurement);
  const matchChannelColorsRef = useRef(matchChannelColors);
  const hoverNavigationRef = useRef<HoverNavigation | null>(null);
  const pendingViewportRef = useRef<{ start: number; samples: number } | null>(null);
  const viewportFrameRef = useRef<number | null>(null);
  const drawFrameRef = useRef<number | null>(null);
  const animatedViewportFrameRef = useRef<number | null>(null);
  const liveViewportFrameRef = useRef<number | null>(null);
  const wheelInteractionTimerRef = useRef<number | null>(null);
  const viewportInteractionActiveRef = useRef(false);
  const [hoverNavigation, setHoverNavigation] = useState<HoverNavigation | null>(null);
  onViewportChangeRef.current = onViewportChange;
  onViewportInteractionChangeRef.current = onViewportInteractionChange;
  onWidthChangeRef.current = onWidthChange;

  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    const measurementCanvas = measurementCanvasRef.current;
    if (!host || !canvas || !measurementCanvas) return;
    const observer = new ResizeObserver(([entry]) => {
      const rect = entry.contentRect;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.floor(rect.width * dpr));
      canvas.height = Math.max(1, Math.floor(rect.height * dpr));
      measurementCanvas.width = canvas.width;
      measurementCanvas.height = canvas.height;
      onWidthChangeRef.current(Math.max(1, Math.floor(rect.width)));
      scheduleDraw();
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const tileChanged = tileRef.current !== tile;
    const viewportChanged =
      viewportPropsRef.current.start !== viewportStart ||
      viewportPropsRef.current.samples !== viewportSamples;
    const visualViewportChanged =
      viewportRef.current.start !== viewportStart || viewportRef.current.samples !== viewportSamples;
    const graphLayoutChanged =
      sampleRateRef.current !== sampleRateHz ||
      timeOriginSampleRef.current !== timeOriginSample ||
      rowHeightsRef.current !== rowHeights ||
      rowTopInsetsRef.current !== rowTopInsets;
    const interactionChanged = showInteractiveMeasurementRef.current !== showInteractiveMeasurement;
    const colorsChanged = matchChannelColorsRef.current !== matchChannelColors;

    tileRef.current = tile;
    viewportPropsRef.current = { start: viewportStart, samples: viewportSamples };
    if (!isLive) {
      cancelLiveViewportAnimation();
      if (visualViewportChanged) {
        viewportRef.current = { start: viewportStart, samples: viewportSamples };
      }
    } else if (viewportChanged && visualViewportChanged) {
      if (!dragRef.current) {
        animateLiveViewportTo(viewportStart, viewportSamples);
      } else {
        cancelLiveViewportAnimation();
        viewportRef.current = { start: viewportStart, samples: viewportSamples };
      }
    }
    sampleRateRef.current = sampleRateHz;
    timeOriginSampleRef.current = timeOriginSample;
    showInteractiveMeasurementRef.current = showInteractiveMeasurement;
    matchChannelColorsRef.current = matchChannelColors;
    totalSamplesRef.current = totalSamples;
    rowHeightsRef.current = rowHeights;
    rowTopInsetsRef.current = rowTopInsets;
    if (!showInteractiveMeasurement) hoverRef.current = null;
    if (
      tileChanged ||
      (!isLive && visualViewportChanged) ||
      graphLayoutChanged ||
      interactionChanged ||
      colorsChanged
    ) {
      scheduleDraw();
    }
  }, [isLive, matchChannelColors, rowHeights, rowTopInsets, sampleRateHz, showInteractiveMeasurement, tile, timeOriginSample, totalSamples, viewportSamples, viewportStart]);

  useEffect(() => {
    return () => {
      if (viewportFrameRef.current !== null) {
        cancelAnimationFrame(viewportFrameRef.current);
      }
      if (drawFrameRef.current !== null) {
        cancelAnimationFrame(drawFrameRef.current);
      }
      cancelViewportAnimation();
      cancelLiveViewportAnimation();
      if (wheelInteractionTimerRef.current !== null) {
        window.clearTimeout(wheelInteractionTimerRef.current);
      }
      setViewportInteractionActive(false);
    };
  }, []);

  function setNavigation(next: HoverNavigation | null) {
    hoverNavigationRef.current = next;
    setHoverNavigation((current) => (sameHoverNavigation(current, next) ? current : next));
  }

  function drawCurrent() {
    const canvas = canvasRef.current;
    const measurementCanvas = measurementCanvasRef.current;
    if (!canvas || !measurementCanvas) return;
    draw(
      canvas,
      tileRef.current,
      viewportRef.current.start,
      viewportRef.current.samples,
      null,
      sampleRateRef.current,
      timeOriginSampleRef.current,
      rowHeightsRef.current,
      rowTopInsetsRef.current,
      matchChannelColorsRef.current,
    );
    drawMeasurementOverlay(
      measurementCanvas,
      tileRef.current,
      showInteractiveMeasurementRef.current ? hoverRef.current : null,
      viewportRef.current.start,
      viewportRef.current.samples,
      sampleRateRef.current,
      rowHeightsRef.current,
      rowTopInsetsRef.current,
    );
  }

  function scheduleDraw() {
    if (drawFrameRef.current !== null) return;
    drawFrameRef.current = requestAnimationFrame(() => {
      drawFrameRef.current = null;
      drawCurrent();
    });
  }

  function clampViewport(start: number, samples: number) {
    const next = normalizeViewport(start, samples, totalSamplesRef.current);
    scheduleViewportChange(next.start, next.samples);
  }

  function scheduleViewportChange(start: number, samples: number) {
    cancelLiveViewportAnimation();
    viewportRef.current = { start, samples };
    scheduleDraw();
    syncNavigationToViewport(start, samples);

    pendingViewportRef.current = { start, samples };
    if (viewportFrameRef.current !== null) return;
    viewportFrameRef.current = requestAnimationFrame(() => {
      viewportFrameRef.current = null;
      const next = pendingViewportRef.current;
      pendingViewportRef.current = null;
      if (next) onViewportChangeRef.current(next.start, next.samples);
    });
  }

  function animateLiveViewportTo(start: number, samples: number) {
    cancelLiveViewportAnimation();
    const initial = viewportRef.current;
    const startDelta = start - initial.start;
    const samplesDelta = samples - initial.samples;
    const startedAt = performance.now();

    const step = (now: number) => {
      const progress = clamp((now - startedAt) / liveViewportInterpolationMs, 0, 1);
      viewportRef.current = {
        start: initial.start + startDelta * progress,
        samples: initial.samples + samplesDelta * progress,
      };
      scheduleDraw();
      if (progress < 1) {
        liveViewportFrameRef.current = requestAnimationFrame(step);
      } else {
        liveViewportFrameRef.current = null;
      }
    };

    liveViewportFrameRef.current = requestAnimationFrame(step);
  }

  function cancelLiveViewportAnimation() {
    if (liveViewportFrameRef.current !== null) {
      cancelAnimationFrame(liveViewportFrameRef.current);
      liveViewportFrameRef.current = null;
    }
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

    const channelLayout = getSaleaeGraphChannelLayout(
      rowHeightsRef.current,
      tileRef.current?.channels.length ?? 0,
      1,
      rowTopInsetsRef.current,
    )[
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
    setViewportInteractionActive(true);
    if (wheelInteractionTimerRef.current !== null) {
      window.clearTimeout(wheelInteractionTimerRef.current);
    }
    wheelInteractionTimerRef.current = window.setTimeout(() => {
      wheelInteractionTimerRef.current = null;
      if (!dragRef.current) setViewportInteractionActive(false);
    }, 90);
    cancelViewportAnimation();
    cancelLiveViewportAnimation();
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
    if (event.button !== 0) return;
    if (wheelInteractionTimerRef.current !== null) {
      window.clearTimeout(wheelInteractionTimerRef.current);
      wheelInteractionTimerRef.current = null;
    }
    setViewportInteractionActive(true);
    cancelViewportAnimation();
    cancelLiveViewportAnimation();
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
      updateHoverAt(event.clientX, event.clientY);
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    const deltaPixels = event.clientX - dragRef.current.x;
    const deltaSamples = (-deltaPixels / Math.max(1, rect.width)) * dragRef.current.samples;
    clampViewport(dragRef.current.start + deltaSamples, dragRef.current.samples);
  }

  function handlePointerUp(event: PointerEvent<HTMLDivElement>) {
    dragRef.current = null;
    setViewportInteractionActive(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    updateHoverAt(event.clientX, event.clientY);
  }

  function setViewportInteractionActive(active: boolean) {
    if (viewportInteractionActiveRef.current === active) return;
    viewportInteractionActiveRef.current = active;
    onViewportInteractionChangeRef.current?.(active);
  }

  function clearHover() {
    hoverRef.current = null;
    setNavigation(null);
    scheduleDraw();
  }

  function handlePointerLeave(event: PointerEvent<HTMLDivElement>) {
    const graphSurface = event.currentTarget.parentElement;
    if (event.relatedTarget instanceof Node && graphSurface?.contains(event.relatedTarget)) return;
    clearHover();
  }

  function handleContextMenu(event: ReactMouseEvent<HTMLDivElement>) {
    if (!onOpenContextMenu) return;
    event.preventDefault();
    event.stopPropagation();

    const tileSnapshot = tileRef.current;
    if (!tileSnapshot || tileSnapshot.channels.length === 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const channelIndex = findSaleaeGraphChannelIndexAtY(
      getSaleaeGraphChannelLayout(rowHeightsRef.current, tileSnapshot.channels.length, 1, rowTopInsetsRef.current),
      event.clientY - rect.top,
    );
    if (channelIndex === null) return;

    const xRatio = clamp((event.clientX - rect.left) / Math.max(1, rect.width), 0, 1);
    const sample = Math.round(viewportRef.current.start + xRatio * viewportRef.current.samples);
    onOpenContextMenu({
      channelIndex: tileSnapshot.channels[channelIndex]?.channel ?? channelIndex,
      clientX: event.clientX,
      clientY: event.clientY,
      sample,
    });
  }

  function updateHoverAt(clientX: number, clientY: number) {
    const canvas = canvasRef.current;
    const host = hostRef.current;
    if (!canvas || !host) return;
    const rect = host.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const x = (clientX - rect.left) * dpr;
    const y = (clientY - rect.top) * dpr;
    hoverRef.current = showInteractiveMeasurementRef.current
      ? findHoverMeasurement(
          canvas,
          tileRef.current,
          viewportRef.current.start,
          viewportRef.current.samples,
          x,
          y,
          rowHeightsRef.current,
          rowTopInsetsRef.current,
        )
      : null;
    setNavigation(
      findHoverNavigation(
        rect,
        tileRef.current,
        viewportRef.current.start,
        viewportRef.current.samples,
        clientY - rect.top,
        rowHeightsRef.current,
        rowTopInsetsRef.current,
      ),
    );
    scheduleDraw();
  }

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const onWheel = (event: WheelEvent) => handleWheel(event);
    host.addEventListener("wheel", onWheel, { passive: false });
    return () => host.removeEventListener("wheel", onWheel);
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    const graphSurface = host?.parentElement;
    if (!host || !graphSurface) return;

    const handleOverlayPointerMove = (event: globalThis.PointerEvent) => {
      if (dragRef.current || (event.target instanceof Node && host.contains(event.target))) return;
      updateHoverAt(event.clientX, event.clientY);
    };
    const handleGraphSurfaceLeave = () => clearHover();
    graphSurface.addEventListener("pointermove", handleOverlayPointerMove, { passive: true });
    graphSurface.addEventListener("pointerleave", handleGraphSurfaceLeave);
    return () => {
      graphSurface.removeEventListener("pointermove", handleOverlayPointerMove);
      graphSurface.removeEventListener("pointerleave", handleGraphSurfaceLeave);
    };
  }, []);

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
      data-match-channel-colors={matchChannelColors}
      onContextMenu={handleContextMenu}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onPointerLeave={handlePointerLeave}
    >
      <div className="waveformRowHitTargets" aria-hidden="true">
        {getWaveformRowHitTargets(tile, rowHeights, rowTopInsets).map((row) => (
          <div
            className="waveformRowHitTarget"
            data-channel-index={row.channelIndex}
            key={row.channelIndex}
            style={{ height: row.height, top: row.top }}
          />
        ))}
      </div>
      <canvas ref={canvasRef} className="waveform-canvas" />
      <canvas ref={measurementCanvasRef} className="waveformMeasurementCanvas" aria-hidden="true" />
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

function drawMeasurementOverlay(
  canvas: HTMLCanvasElement,
  tile: WaveformTile | null,
  hover: HoverMeasurement | null,
  viewportStart: number,
  viewportSamples: number,
  sampleRateHz: number,
  rowHeights: number[],
  rowTopInsets: number[],
) {
  const context = canvas.getContext("2d");
  if (!context) return;
  context.clearRect(0, 0, canvas.width, canvas.height);
  if (!tile || !hover) return;
  drawHoverMeasurement(
    context,
    canvas,
    tile,
    hover,
    viewportStart,
    viewportSamples,
    sampleRateHz,
    rowHeights,
    rowTopInsets,
  );
}

function getWaveformRowHitTargets(
  tile: WaveformTile | null,
  rowHeights: number[],
  rowTopInsets: number[],
): RowHitTarget[] {
  if (!tile || tile.channels.length === 0) return [];
  const layouts = getSaleaeGraphChannelLayout(rowHeights, tile.channels.length, 1, rowTopInsets);
  return layouts.map((layout, index) => ({
    channelIndex: tile.channels[index]?.channel ?? index,
    height: Math.max(1, layout.height),
    top: layout.top,
  }));
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
  timeOriginSample: number,
  rowHeights: number[],
  rowTopInsets: number[],
  matchChannelColors: boolean,
) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const width = canvas.width;
  const height = canvas.height;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#101013";
  ctx.fillRect(0, 0, width, height);

  drawGridLines(ctx, width, height, viewportStart, viewportSamples, sampleRateHz, timeOriginSample);

  if (!tile || tile.channels.length === 0) {
    ctx.fillStyle = "rgba(255,255,255,0.55)";
    ctx.font = `${12 * devicePixelRatio}px Roboto, Helvetica, Arial, sans-serif`;
    ctx.fillText(
      tile ? "No channels visible" : "No capture loaded",
      24 * devicePixelRatio,
      24 * devicePixelRatio,
    );
    return;
  }

  const dpr = window.devicePixelRatio || 1;
  const channelLayout = getSaleaeGraphChannelLayout(rowHeights, tile.channels.length, dpr, rowTopInsets);
  const left = graphPaddingLeft * dpr;
  const right = width - graphPaddingRight * dpr;
  const usableWidth = Math.max(1, right - left);
  const viewSamples = Math.max(1, viewportSamples || tile.sample_count || 1);
  const viewStart = viewportStart || 0;

  tile.channels.forEach((channel, index) => {
    const layout = channelLayout[index];
    const top = layout.top;
    const laneHeight = layout.height;
    const gutter = Math.min(digitalGraphGutterPx * dpr, Math.max(0, (laneHeight - 2 * dpr) / 2));
    const highY = top + gutter + 0.5 * dpr;
    const transitionHeight = Math.max(dpr, Math.round(laneHeight - 2 * gutter));
    const lowY = highY + transitionHeight - dpr;
    ctx.strokeStyle = "rgba(255,255,255,0.075)";
    ctx.beginPath();
    ctx.moveTo(0, Math.floor(layout.outerTop) + 0.5);
    ctx.lineTo(width, Math.floor(layout.outerTop) + 0.5);
    ctx.stroke();

    const channelColor = matchChannelColors ? saleaeLegacyChannelColor(channel.channel) : "#ffffff";
    if (channel.segments.length > 0) {
      drawDigitalSegments(ctx, {
        color: channelColor,
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
        color: channelColor,
        highY,
        lowY,
        left,
        right,
        viewSamples,
        viewStart,
        tileStart: tile.start_sample,
        samplesPerPixel: tile.samples_per_pixel,
        channel,
        dpr,
      });
    }
  });

  if (hover) {
    drawHoverMeasurement(
      ctx,
      canvas,
      tile,
      hover,
      viewportStart,
      viewportSamples,
      sampleRateHz,
      rowHeights,
      rowTopInsets,
    );
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
  channel: WaveformTile["channels"][number];
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
  const lineWidth = Math.max(1.25 * dpr, 1);
  ctx.lineWidth = lineWidth;
  ctx.lineCap = "butt";
  ctx.lineJoin = "miter";
  ctx.strokeStyle = color;

  const path = new Path2D();
  const viewEnd = viewStart + viewSamples;
  const startIndex = Math.max(0, firstSegmentEndingAtOrAfter(segments, viewStart) - 1);
  for (let index = startIndex; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment.start_sample > viewEnd) break;
    const x0 = xForSample(segment.start_sample, left, right, viewStart, viewSamples);
    const x1 = xForSample(segment.end_sample, left, right, viewStart, viewSamples);
    if (x1 < left || x0 > right) continue;

    const clippedX0 = Math.max(left, x0);
    const clippedX1 = Math.min(right, x1);
    const y = crispY(segment.high ? highY : lowY);
    path.moveTo(clippedX0, y);
    path.lineTo(clippedX1, y);

    const previous = segments[index - 1];
    if (previous && previous.high !== segment.high && x0 >= left - lineWidth && x0 <= right + lineWidth) {
      const edgeX = crispX(clamp(x0, left, right));
      path.moveTo(edgeX, crispY(previous.high ? highY : lowY));
      path.lineTo(edgeX, y);
    }
  }
  ctx.stroke(path);
}

function firstSegmentEndingAtOrAfter(
  segments: WaveformTile["channels"][number]["segments"],
  sample: number,
) {
  let low = 0;
  let high = segments.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (segments[middle].end_sample < sample) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
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
    channel,
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
  let previousBinIndex: number | null = null;
  let previousLastHigh: boolean | null = null;
  const firstVisibleBin = Math.max(
    0,
    Math.floor((viewStart - tileStart) / Math.max(Number.EPSILON, samplesPerPixel)) - 1,
  );
  const lastVisibleBin = Math.ceil(
    (viewStart + viewSamples - tileStart) / Math.max(Number.EPSILON, samplesPerPixel),
  ) + 1;

  forEachDigitalBin(channel, (binIndex, first, last, hasHigh, hasLow, edges, firstEdgeOffset) => {
    const sample0 = tileStart + binIndex * samplesPerPixel;
    const sample1 = sample0 + samplesPerPixel;
    const x0 = xForSample(sample0, left, right, viewStart, viewSamples);
    const x1 = xForSample(sample1, left, right, viewStart, viewSamples);
    if (x1 < left) {
      previousBinIndex = binIndex;
      previousLastHigh = last;
      return;
    }
    if (x0 > right) return;

    const clippedX0 = Math.max(left, x0);
    const clippedX1 = Math.min(right, x1);
    const y0 = crispY(first ? highY : lowY);
    const y1 = crispY(last ? highY : lowY);
    const binWidth = Math.max(1, clippedX1 - clippedX0);

    if (
      previousBinIndex === binIndex - 1 &&
      previousLastHigh !== null &&
      previousLastHigh !== first &&
      x0 >= left - lineWidth &&
      x0 <= right + lineWidth
    ) {
      const edgeX = crispX(clamp(x0, left, right));
      edgePath.moveTo(edgeX, crispY(previousLastHigh ? highY : lowY));
      edgePath.lineTo(edgeX, y0);
    }
    previousBinIndex = binIndex;
    previousLastHigh = last;

    if (hasHigh && hasLow) {
      if (edges <= 1 && firstEdgeOffset != null) {
        const edgeX = Math.max(left, Math.min(right, xForSample(sample0 + firstEdgeOffset, left, right, viewStart, viewSamples)));
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
  }, firstVisibleBin, lastVisibleBin);

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
  rowTopInsets: number[],
): HoverNavigation | null {
  if (!tile || tile.channels.length === 0) return null;
  const channelLayout = getSaleaeGraphChannelLayout(rowHeights, tile.channels.length, 1, rowTopInsets);
  const channelIndex = findHoverChannelIndexAtY(channelLayout, clamp(y, 0, Math.max(0, rect.height - 0.001)));
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
  const channel = tile.channels[channelIndex];

  const viewportEnd = viewportStart + viewportSamples;
  const previousEdge = findPreviousEdge(edges, viewportStart) ?? channel.previous_transition ?? null;
  const nextEdge = findNextEdgeSample(edges, viewportEnd) ?? channel.next_transition ?? null;
  if (previousEdge == null && nextEdge == null) return null;

  return {
    channelIndex,
    topPx: channelTop + Math.max(0, laneHeight - 26) / 2,
    previousEdge,
    nextEdge,
  };
}

function findHoverChannelIndexAtY(
  layout: ReturnType<typeof getSaleaeGraphChannelLayout>,
  y: number,
) {
  for (let index = 0; index < layout.length; index += 1) {
    const row = layout[index];
    const nextTop = layout[index + 1]?.outerTop ?? row.outerTop + row.outerHeight;
    if (y >= row.outerTop && y < nextTop) return index;
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
  rowTopInsets: number[],
): HoverMeasurement | null {
  if (!tile || tile.channels.length === 0) return null;
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.width;
  const channelIndex = findSaleaeGraphChannelIndexAtY(
    getSaleaeGraphChannelLayout(rowHeights, tile.channels.length, dpr, rowTopInsets),
    y,
  );
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
  rowTopInsets: number[],
) {
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.width;
  const height = canvas.height;
  const layout = getSaleaeGraphChannelLayout(rowHeights, tile.channels.length, dpr, rowTopInsets)[hover.channelIndex];
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
  const cached = digitalEdgeCache.get(channel);
  if (cached) return cached;
  if (channel.rising_edges.length || channel.falling_edges.length) {
    const edges = [
      ...channel.rising_edges.map((sample) => ({ sample, kind: "rising" as const })),
      ...channel.falling_edges.map((sample) => ({ sample, kind: "falling" as const })),
    ].sort((a, b) => a.sample - b.sample);
    digitalEdgeCache.set(channel, edges);
    return edges;
  }
  const edges: DigitalEdge[] = [];
  forEachDigitalBin(channel, (binIndex, firstHigh, lastHigh, hasHigh, hasLow, edgeCount, firstEdgeOffset, lastEdgeOffset) => {
    if (!edgeCount || !(hasHigh && hasLow)) return;
    const sample0 = tile.start_sample + binIndex * tile.samples_per_pixel;
    const first = firstEdgeOffset == null ? tile.samples_per_pixel / 2 : firstEdgeOffset;
    edges.push({ sample: sample0 + first, kind: firstHigh ? "falling" : "rising" });
    if (edgeCount > 1 && lastEdgeOffset != null && lastEdgeOffset !== firstEdgeOffset) {
      edges.push({ sample: sample0 + lastEdgeOffset, kind: lastHigh ? "rising" : "falling" });
    }
  });
  edges.sort((a, b) => a.sample - b.sample);
  digitalEdgeCache.set(channel, edges);
  return edges;
}

type DigitalBinVisitor = (
  index: number,
  first: boolean,
  last: boolean,
  hasHigh: boolean,
  hasLow: boolean,
  edges: number,
  firstEdgeOffset: number | null,
  lastEdgeOffset: number | null,
) => void;

function forEachDigitalBin(
  channel: WaveformTile["channels"][number],
  visit: DigitalBinVisitor,
  startIndex = 0,
  endIndex = Number.MAX_SAFE_INTEGER,
) {
  if (!channel.packed_bins) {
    const begin = Math.max(0, Math.min(channel.bins.length, Math.floor(startIndex)));
    const end = Math.max(begin, Math.min(channel.bins.length, Math.ceil(endIndex)));
    for (let index = begin; index < end; index += 1) {
      const bin = channel.bins[index];
      visit(
        index,
        bin.first,
        bin.last,
        bin.has_high,
        bin.has_low,
        bin.edges,
        bin.first_edge_offset,
        bin.last_edge_offset,
      );
    }
    return;
  }

  let view = packedDigitalBinCache.get(channel);
  if (!view) {
    const binary = atob(channel.packed_bins);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    view = new DataView(bytes.buffer);
    packedDigitalBinCache.set(channel, view);
  }
  const count = Math.floor(view.byteLength / packedDigitalBinBytes);
  const begin = Math.max(0, Math.min(count, Math.floor(startIndex)));
  const end = Math.max(begin, Math.min(count, Math.ceil(endIndex)));
  for (let index = begin; index < end; index += 1) {
    const offset = index * packedDigitalBinBytes;
    const flags = view.getUint32(offset, true);
    const firstEdgeOffset = view.getUint32(offset + 8, true);
    const lastEdgeOffset = view.getUint32(offset + 12, true);
    visit(
      index,
      (flags & 1) !== 0,
      (flags & 2) !== 0,
      (flags & 4) !== 0,
      (flags & 8) !== 0,
      view.getUint32(offset + 4, true),
      firstEdgeOffset !== 0xffffffff ? firstEdgeOffset : null,
      lastEdgeOffset !== 0xffffffff ? lastEdgeOffset : null,
    );
  }
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

function drawGridLines(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  viewportStart: number,
  viewportSamples: number,
  sampleRateHz: number,
  timeOriginSample: number,
) {
  const dpr = window.devicePixelRatio || 1;
  const left = graphPaddingLeft * dpr;
  const right = width - graphPaddingRight * dpr;
  const usableWidth = Math.max(1, right - left);
  const usableWidthCss = usableWidth / dpr;

  ctx.save();
  if (!Number.isFinite(sampleRateHz) || sampleRateHz <= 0 || !Number.isFinite(viewportSamples) || viewportSamples <= 0) {
    const fallbackStep = minimumHorizontalTickSpacingPx * dpr;
    for (let x = left; x < right; x += fallbackStep) {
      drawVerticalGridLine(ctx, x, 0, height, "minor", dpr);
    }
    ctx.restore();
    return;
  }

  const startSeconds = (viewportStart - timeOriginSample) / sampleRateHz;
  const viewportSeconds = Math.max(Number.EPSILON, viewportSamples / sampleRateHz);
  const timeSecondsPerPixel = viewportSeconds / usableWidthCss;
  const gridTicks = getHorizontalGraphTicks(startSeconds, timeSecondsPerPixel, usableWidthCss, {
    majorThresholdPx: 0,
    minorThresholdPx: 0,
  });
  for (const tick of gridTicks.majorTicks) {
    drawVerticalGridLine(ctx, left + tick.leftPx * dpr, 0, height, "major", dpr);
  }
  for (const tick of gridTicks.minorTicks) {
    drawVerticalGridLine(ctx, left + tick.leftPx * dpr, 0, height, "minor", dpr);
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
  ctx.strokeStyle = level === "major" ? SALEAE_DARK_GRIDLINE_PRIMARY : SALEAE_DARK_GRIDLINE_SECONDARY;
  ctx.lineWidth = Math.max(1, dpr);
  ctx.setLineDash([3 * dpr, 3 * dpr]);
  ctx.beginPath();
  ctx.moveTo(crispX(x), top);
  ctx.lineTo(crispX(x), bottom);
  ctx.stroke();
  ctx.restore();
}
