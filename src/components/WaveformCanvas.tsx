import { MouseEvent as ReactMouseEvent, PointerEvent, useEffect, useRef, useState } from "react";
import { measureDigitalPoint, type WaveformTile } from "../lib/api";
import {
  normalizeCaptureViewport,
  normalizeLiveCaptureViewport,
} from "../lib/captureViewport";
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
import { findNearestEdgeSample } from "../lib/waveformEdgeSnap";
import { waveformTileRequiresDirectDraw } from "../lib/waveformTileCoverage";

interface WaveformCanvasProps {
  isLive?: boolean;
  sessionId: string;
  rowHeights: number[];
  rowTopInsets?: number[];
  tile: WaveformTile | null;
  onWidthChange: (width: number) => void;
  matchChannelColors?: boolean;
  maximumViewportSamples?: number;
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
  onPointerPositionChange?: (xRatio: number) => void;
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

interface WaveLayerCache {
  canvas: HTMLCanvasElement;
  height: number;
  matchChannelColors: boolean;
  rowHeights: number[];
  rowTopInsets: number[];
  tile: WaveformTile;
  width: number;
}

interface WaveLayerCacheRef {
  current: WaveLayerCache | null;
}

type EdgeKind = "rising" | "falling";

interface DigitalEdge {
  sample: number;
  kind: EdgeKind;
}

interface EdgeJumpMeasurement {
  endChannelIndex: number;
  endSample: number;
  pointerX: number;
  pointerY: number;
  snapped: boolean;
  startChannelIndex: number;
  startSample: number;
}

interface HoverMeasurement {
  channelIndex: number;
  pointerX: number;
  widthStart: number;
  widthEnd: number;
  periodStart: number;
  periodEnd: number | null;
}

interface HoverMeasurementTarget {
  channel: number;
  channelIndex: number;
  pointerX: number;
  sample: number;
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
  sessionId,
  rowHeights,
  rowTopInsets = [],
  tile,
  onWidthChange,
  matchChannelColors = true,
  maximumViewportSamples,
  sampleRateHz,
  timeOriginSample = 0,
  showInteractiveMeasurement = true,
  totalSamples,
  viewportStart,
  viewportSamples,
  onOpenContextMenu,
  onPointerPositionChange,
  onViewportChange,
  onViewportInteractionChange,
}: WaveformCanvasProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const measurementCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const waveLayerCacheRef = useRef<WaveLayerCache | null>(null);
  const dragRef = useRef<{ x: number; start: number; samples: number } | null>(null);
  const tileRef = useRef<WaveformTile | null>(null);
  const viewportRef = useRef({ start: viewportStart, samples: viewportSamples });
  const viewportPropsRef = useRef({ start: viewportStart, samples: viewportSamples });
  const sampleRateRef = useRef(sampleRateHz);
  const sessionIdRef = useRef(sessionId);
  const isLiveRef = useRef(isLive);
  const maximumViewportSamplesRef = useRef(maximumViewportSamples);
  const timeOriginSampleRef = useRef(timeOriginSample);
  const totalSamplesRef = useRef(totalSamples);
  const rowHeightsRef = useRef(rowHeights);
  const rowTopInsetsRef = useRef(rowTopInsets);
  const onViewportChangeRef = useRef(onViewportChange);
  const onPointerPositionChangeRef = useRef(onPointerPositionChange);
  const onViewportInteractionChangeRef = useRef(onViewportInteractionChange);
  const onWidthChangeRef = useRef(onWidthChange);
  const hoverRef = useRef<HoverMeasurement | null>(null);
  const hoverMeasurementTargetRef = useRef<HoverMeasurementTarget | null>(null);
  const hoverMeasurementPendingRef = useRef<HoverMeasurementTarget | null>(null);
  const hoverMeasurementTimerRef = useRef<number | null>(null);
  const hoverMeasurementInFlightRef = useRef(false);
  const hoverMeasurementGenerationRef = useRef(0);
  const edgeJumpRef = useRef<EdgeJumpMeasurement | null>(null);
  const pointerDownRef = useRef<{ x: number; y: number } | null>(null);
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
  onPointerPositionChangeRef.current = onPointerPositionChange;
  onViewportInteractionChangeRef.current = onViewportInteractionChange;
  onWidthChangeRef.current = onWidthChange;
  sessionIdRef.current = sessionId;

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
    maximumViewportSamplesRef.current = maximumViewportSamples;
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
    isLiveRef.current = isLive;
    timeOriginSampleRef.current = timeOriginSample;
    showInteractiveMeasurementRef.current = showInteractiveMeasurement;
    matchChannelColorsRef.current = matchChannelColors;
    totalSamplesRef.current = totalSamples;
    rowHeightsRef.current = rowHeights;
    rowTopInsetsRef.current = rowTopInsets;
    if (!showInteractiveMeasurement) cancelHoverMeasurementRequest();
    if (tileChanged && edgeJumpRef.current && hostRef.current) {
      const rect = hostRef.current.getBoundingClientRect();
      updateEdgeJumpAt(
        rect.left + edgeJumpRef.current.pointerX,
        rect.top + edgeJumpRef.current.pointerY,
      );
    }
    if (
      tileChanged ||
      (!isLive && visualViewportChanged) ||
      graphLayoutChanged ||
      interactionChanged ||
      colorsChanged
    ) {
      scheduleDraw();
    }
  }, [isLive, matchChannelColors, maximumViewportSamples, rowHeights, rowTopInsets, sampleRateHz, showInteractiveMeasurement, tile, timeOriginSample, totalSamples, viewportSamples, viewportStart]);

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
      cancelHoverMeasurementRequest();
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
      waveLayerCacheRef,
    );
    drawMeasurementOverlay(
      measurementCanvas,
      tileRef.current,
      showInteractiveMeasurementRef.current ? hoverRef.current : null,
      edgeJumpRef.current,
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
    const next = normalizeViewport(
      start,
      samples,
      totalSamplesRef.current,
      isLiveRef.current,
      sampleRateRef.current,
      maximumViewportSamplesRef.current,
    );
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
    const target = normalizeViewport(
      start,
      samples,
      totalSamplesRef.current,
      isLiveRef.current,
      sampleRateRef.current,
      maximumViewportSamplesRef.current,
    );
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
    cancelHoverMeasurementRequest();
    edgeJumpRef.current = null;
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
      if (!dragRef.current) {
        setViewportInteractionActive(false);
        updateHoverAt(event.clientX, event.clientY);
      }
    }, 90);
    cancelViewportAnimation();
    cancelLiveViewportAnimation();
    cancelHoverMeasurementRequest();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const xRatio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    onPointerPositionChangeRef.current?.(xRatio);
    const current = viewportRef.current;

    if (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY) * 1.2) {
      const deltaPixels = normalizeWheelDelta(event.deltaX || event.deltaY, event.deltaMode);
      const deltaSamples = (deltaPixels / Math.max(1, rect.width)) * current.samples;
      clampViewport(current.start + deltaSamples, current.samples);
      if (edgeJumpRef.current) updateEdgeJumpAt(event.clientX, event.clientY);
      return;
    }

    const delta = normalizeWheelDelta(event.deltaY, event.deltaMode);
    const intensity = event.ctrlKey || event.metaKey || event.altKey ? 0.003 : 0.0015;
    const factor = Math.exp(Math.max(-800, Math.min(800, delta)) * intensity);
    const requestedSamples = current.samples * factor;
    const nextSamples = normalizeViewport(
      current.start,
      requestedSamples,
      totalSamplesRef.current,
      isLiveRef.current,
      sampleRateRef.current,
      maximumViewportSamplesRef.current,
    ).samples;
    if (Math.abs(nextSamples - current.samples) < 0.001) return;
    const anchor = current.start + current.samples * xRatio;
    clampViewport(anchor - nextSamples * xRatio, nextSamples);
    if (edgeJumpRef.current) updateEdgeJumpAt(event.clientX, event.clientY);
  }

  function handlePointerDown(event: PointerEvent<HTMLDivElement>) {
    if (!totalSamplesRef.current) return;
    if (event.button !== 0) return;
    if (edgeJumpRef.current) {
      event.preventDefault();
      event.stopPropagation();
      edgeJumpRef.current = null;
      pointerDownRef.current = null;
      scheduleDraw();
      return;
    }
    if (wheelInteractionTimerRef.current !== null) {
      window.clearTimeout(wheelInteractionTimerRef.current);
      wheelInteractionTimerRef.current = null;
    }
    setViewportInteractionActive(true);
    cancelViewportAnimation();
    cancelLiveViewportAnimation();
    event.currentTarget.setPointerCapture(event.pointerId);
    cancelHoverMeasurementRequest();
    pointerDownRef.current = { x: event.clientX, y: event.clientY };
    dragRef.current = {
      x: event.clientX,
      start: viewportRef.current.start,
      samples: viewportRef.current.samples,
    };
  }

  function handlePointerMove(event: PointerEvent<HTMLDivElement>) {
    if (!totalSamplesRef.current) return;
    if (edgeJumpRef.current) {
      updateEdgeJumpAt(event.clientX, event.clientY);
      return;
    }
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
    const pointerDown = pointerDownRef.current;
    pointerDownRef.current = null;
    dragRef.current = null;
    setViewportInteractionActive(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const clickDistance = pointerDown
      ? Math.hypot(event.clientX - pointerDown.x, event.clientY - pointerDown.y)
      : Number.POSITIVE_INFINITY;
    if (clickDistance <= 4 && startEdgeJumpAt(event.clientX, event.clientY)) return;
    updateHoverAt(event.clientX, event.clientY);
  }

  function setViewportInteractionActive(active: boolean) {
    if (viewportInteractionActiveRef.current === active) return;
    viewportInteractionActiveRef.current = active;
    onViewportInteractionChangeRef.current?.(active);
  }

  function clearHover() {
    cancelHoverMeasurementRequest();
    setNavigation(null);
    scheduleDraw();
  }

  function cancelHoverMeasurementRequest() {
    hoverMeasurementGenerationRef.current += 1;
    hoverMeasurementTargetRef.current = null;
    hoverMeasurementPendingRef.current = null;
    hoverRef.current = null;
    if (hoverMeasurementTimerRef.current !== null) {
      window.clearTimeout(hoverMeasurementTimerRef.current);
      hoverMeasurementTimerRef.current = null;
    }
  }

  function queueHoverMeasurement(target: HoverMeasurementTarget) {
    hoverMeasurementTargetRef.current = target;
    const current = hoverRef.current;
    if (
      current?.channelIndex === target.channelIndex &&
      target.sample > current.widthStart &&
      target.sample < current.widthEnd
    ) {
      current.pointerX = target.pointerX;
      scheduleDraw();
      return;
    }

    hoverRef.current = null;
    hoverMeasurementPendingRef.current = target;
    if (hoverMeasurementTimerRef.current !== null || hoverMeasurementInFlightRef.current) return;
    hoverMeasurementTimerRef.current = window.setTimeout(() => {
      hoverMeasurementTimerRef.current = null;
      void runHoverMeasurementRequest();
    }, 16);
  }

  async function runHoverMeasurementRequest() {
    const target = hoverMeasurementPendingRef.current;
    if (!target || hoverMeasurementInFlightRef.current) return;
    hoverMeasurementPendingRef.current = null;
    hoverMeasurementInFlightRef.current = true;
    const generation = hoverMeasurementGenerationRef.current;
    try {
      const measurement = await measureDigitalPoint(sessionIdRef.current, {
        channel: target.channel,
        sample: Math.round(target.sample),
      });
      const latest = hoverMeasurementTargetRef.current;
      if (
        generation === hoverMeasurementGenerationRef.current &&
        measurement &&
        latest?.channel === measurement.channel &&
        latest.sample >= measurement.width_start_sample &&
        latest.sample < measurement.width_end_sample
      ) {
        hoverMeasurementPendingRef.current = null;
        hoverRef.current = {
          channelIndex: latest.channelIndex,
          pointerX: latest.pointerX,
          widthStart: measurement.width_start_sample,
          widthEnd: measurement.width_end_sample,
          periodStart: measurement.width_start_sample,
          periodEnd: measurement.period_end_sample,
        };
        scheduleDraw();
      }
    } catch {
      // The active capture may be replaced while this request is in flight.
    } finally {
      hoverMeasurementInFlightRef.current = false;
      if (hoverMeasurementPendingRef.current) {
        hoverMeasurementTimerRef.current = window.setTimeout(() => {
          hoverMeasurementTimerRef.current = null;
          void runHoverMeasurementRequest();
        }, 0);
      }
    }
  }

  function startEdgeJumpAt(clientX: number, clientY: number) {
    const hit = findEdgeHitAtClientPoint(
      hostRef.current,
      tileRef.current,
      viewportRef.current.start,
      viewportRef.current.samples,
      rowHeightsRef.current,
      rowTopInsetsRef.current,
      clientX,
      clientY,
      10,
      false,
    );
    if (!hit) return false;
    const rect = hostRef.current?.getBoundingClientRect();
    if (!rect) return false;
    edgeJumpRef.current = {
      startSample: hit.sample,
      startChannelIndex: hit.channelIndex,
      endSample: hit.sample,
      endChannelIndex: hit.channelIndex,
      pointerX: clientX - rect.left,
      pointerY: clientY - rect.top,
      snapped: true,
    };
    cancelHoverMeasurementRequest();
    setNavigation(null);
    scheduleDraw();
    return true;
  }

  function updateEdgeJumpAt(clientX: number, clientY: number) {
    const current = edgeJumpRef.current;
    const host = hostRef.current;
    if (!current || !host) return;
    const rect = host.getBoundingClientRect();
    onPointerPositionChangeRef.current?.(
      clamp((clientX - rect.left) / Math.max(1, rect.width), 0, 1),
    );
    const hit = findEdgeHitAtClientPoint(
      host,
      tileRef.current,
      viewportRef.current.start,
      viewportRef.current.samples,
      rowHeightsRef.current,
      rowTopInsetsRef.current,
      clientX,
      clientY,
      10,
      false,
    );
    const rawSample = viewportRef.current.start
      + clamp((clientX - rect.left) / Math.max(1, rect.width), 0, 1) * viewportRef.current.samples;
    edgeJumpRef.current = {
      ...current,
      endSample: hit?.sample ?? rawSample,
      endChannelIndex: hit?.channelIndex ?? channelIndexAtClientY(
        rect,
        tileRef.current,
        rowHeightsRef.current,
        rowTopInsetsRef.current,
        clientY,
      ) ?? current.endChannelIndex,
      pointerX: clamp(clientX - rect.left, 0, rect.width),
      pointerY: clamp(clientY - rect.top, 0, rect.height),
      snapped: Boolean(hit),
    };
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
    onPointerPositionChangeRef.current?.(
      clamp((clientX - rect.left) / Math.max(1, rect.width), 0, 1),
    );
    const dpr = window.devicePixelRatio || 1;
    const x = (clientX - rect.left) * dpr;
    const y = (clientY - rect.top) * dpr;
    const tileSnapshot = tileRef.current;
    const channelIndex = tileSnapshot
      ? findSaleaeGraphChannelIndexAtY(
          getSaleaeGraphChannelLayout(
            rowHeightsRef.current,
            tileSnapshot.channels.length,
            dpr,
            rowTopInsetsRef.current,
          ),
          y,
        )
      : null;
    const sample = viewportRef.current.start
      + clamp(x / Math.max(1, canvas.width), 0, 1) * viewportRef.current.samples;
    if (
      showInteractiveMeasurementRef.current &&
      tileSnapshot &&
      channelIndex !== null &&
      sample >= 0 &&
      sample < totalSamplesRef.current
    ) {
      queueHoverMeasurement({
        channel: tileSnapshot.channels[channelIndex].channel,
        channelIndex,
        pointerX: x,
        sample,
      });
    } else {
      cancelHoverMeasurementRequest();
    }
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
      if (edgeJumpRef.current) {
        updateEdgeJumpAt(event.clientX, event.clientY);
        return;
      }
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
      if (event.key === "Escape" && edgeJumpRef.current) {
        event.preventDefault();
        edgeJumpRef.current = null;
        scheduleDraw();
        return;
      }
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
  edgeJump: EdgeJumpMeasurement | null,
  viewportStart: number,
  viewportSamples: number,
  sampleRateHz: number,
  rowHeights: number[],
  rowTopInsets: number[],
) {
  const context = canvas.getContext("2d");
  if (!context) return;
  context.clearRect(0, 0, canvas.width, canvas.height);
  if (!tile) return;
  if (hover) {
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
  if (edgeJump) {
    drawEdgeJumpMeasurement(
      context,
      canvas,
      tile,
      edgeJump,
      viewportStart,
      viewportSamples,
      sampleRateHz,
      rowHeights,
      rowTopInsets,
    );
  }
}

function drawEdgeJumpMeasurement(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  tile: WaveformTile,
  measurement: EdgeJumpMeasurement,
  viewportStart: number,
  viewportSamples: number,
  sampleRateHz: number,
  rowHeights: number[],
  rowTopInsets: number[],
) {
  const dpr = window.devicePixelRatio || 1;
  const layouts = getSaleaeGraphChannelLayout(rowHeights, tile.channels.length, dpr, rowTopInsets);
  const startLayout = layouts[measurement.startChannelIndex];
  const endLayout = layouts[measurement.endChannelIndex];
  if (!startLayout || !endLayout) return;

  const startX = xForSample(measurement.startSample, 0, canvas.width, viewportStart, viewportSamples);
  const endX = measurement.snapped
    ? xForSample(measurement.endSample, 0, canvas.width, viewportStart, viewportSamples)
    : measurement.pointerX * dpr;
  const startY = startLayout.top + startLayout.height / 2;
  const endY = measurement.snapped
    ? endLayout.top + endLayout.height / 2
    : measurement.pointerY * dpr;
  const deltaSamples = Math.abs(Math.round(measurement.endSample - measurement.startSample));
  const color = "rgb(255, 166, 64)";

  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = Math.max(1, dpr);
  ctx.beginPath();
  ctx.moveTo(startX, startY);
  const middleX = (startX + endX) / 2;
  ctx.bezierCurveTo(middleX, startY, middleX, endY, endX, endY);
  ctx.stroke();
  drawEdgeJumpTarget(ctx, startX, startY, dpr);
  if (measurement.snapped) drawEdgeJumpTarget(ctx, endX, endY, dpr);

  if (Math.hypot(endX - startX, endY - startY) > 20 * dpr) {
    const duration = formatDuration(deltaSamples, sampleRateHz);
    const label = `${duration} / ${deltaSamples.toLocaleString()} samples`;
    drawEdgeJumpPopup(ctx, label, measurement.pointerX * dpr, measurement.pointerY * dpr, canvas, dpr);
  }
  ctx.restore();
}

function drawEdgeJumpTarget(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  dpr: number,
) {
  const radius = 2.5 * dpr;
  ctx.fillRect(x - 0.5 * dpr, y - radius, dpr, radius * 2);
  ctx.fillRect(x - radius, y - 0.5 * dpr, radius * 2, dpr);
}

function drawEdgeJumpPopup(
  ctx: CanvasRenderingContext2D,
  label: string,
  pointerX: number,
  pointerY: number,
  canvas: HTMLCanvasElement,
  dpr: number,
) {
  const paddingX = 9 * dpr;
  const height = 28 * dpr;
  ctx.font = `${12 * dpr}px Roboto, Helvetica, Arial, sans-serif`;
  const width = ctx.measureText(label).width + paddingX * 2;
  const preferLeft = pointerX > canvas.width / 2;
  const rawX = preferLeft ? pointerX - width - 14 * dpr : pointerX + 14 * dpr;
  const x = clamp(rawX, 4 * dpr, Math.max(4 * dpr, canvas.width - width - 4 * dpr));
  const y = clamp(pointerY - height - 10 * dpr, 4 * dpr, Math.max(4 * dpr, canvas.height - height - 4 * dpr));
  ctx.fillStyle = "rgba(30, 30, 34, 0.96)";
  ctx.strokeStyle = "rgba(255, 255, 255, 0.24)";
  roundRect(ctx, x, y, width, height, 3 * dpr);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = "rgba(255, 255, 255, 0.94)";
  ctx.fillText(label, x + paddingX, y + height * 0.68);
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
  waveLayerCacheRef: WaveLayerCacheRef,
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
  drawCachedWaveLayer(
    ctx,
    canvas,
    tile,
    viewportStart,
    viewportSamples,
    rowHeights,
    rowTopInsets,
    matchChannelColors,
    waveLayerCacheRef,
  );

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

function drawCachedWaveLayer(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  tile: WaveformTile,
  viewportStart: number,
  viewportSamples: number,
  rowHeights: number[],
  rowTopInsets: number[],
  matchChannelColors: boolean,
  cacheRef: WaveLayerCacheRef,
) {
  if (tile.sample_count <= 0 || viewportSamples <= 0) return;
  // A tile includes overscan and its pixel budget is expressed in CSS pixels.
  // Render that full budget at the display DPR so cropping the visible window
  // remains 1:1. Using only the viewport width here stretches every vertical
  // transition by the overscan ratio (normally about 2x).
  const dpr = window.devicePixelRatio || 1;
  const canvasCssWidth = canvas.width / dpr;
  if (
    waveformTileRequiresDirectDraw(
      tile.samples_per_pixel,
      viewportSamples,
      canvasCssWidth,
    )
  ) {
    // At sub-sample pixel scales the backend has already reached its physical
    // 1 sample/pixel limit. Magnifying the cached raster would magnify its
    // stroke width too, so draw the small set of visible bins in view space.
    renderWaveLayer(
      canvas,
      tile,
      rowHeights,
      rowTopInsets,
      matchChannelColors,
      viewportStart,
      viewportSamples,
    );
    drawExactWaveSegments(
      ctx,
      canvas,
      tile,
      viewportStart,
      viewportSamples,
      rowHeights,
      rowTopInsets,
      matchChannelColors,
    );
    return;
  }
  const layerWidth = Math.max(1, Math.round(tile.pixels * dpr));
  let cache = cacheRef.current;
  if (
    !cache ||
    cache.tile !== tile ||
    cache.width !== layerWidth ||
    cache.height !== canvas.height ||
    cache.rowHeights !== rowHeights ||
    cache.rowTopInsets !== rowTopInsets ||
    cache.matchChannelColors !== matchChannelColors
  ) {
    const layer = document.createElement("canvas");
    layer.width = layerWidth;
    layer.height = canvas.height;
    renderWaveLayer(layer, tile, rowHeights, rowTopInsets, matchChannelColors);
    cache = {
      canvas: layer,
      height: canvas.height,
      matchChannelColors,
      rowHeights,
      rowTopInsets,
      tile,
      width: layerWidth,
    };
    cacheRef.current = cache;
  }

  const tileStart = tile.start_sample;
  const tileEnd = tileStart + tile.sample_count;
  const viewportEnd = viewportStart + viewportSamples;
  const visibleStart = Math.max(tileStart, viewportStart);
  const visibleEnd = Math.min(tileEnd, viewportEnd);
  if (visibleEnd <= visibleStart) return;

  const sourceX = ((visibleStart - tileStart) / tile.sample_count) * cache.width;
  const sourceWidth = ((visibleEnd - visibleStart) / tile.sample_count) * cache.width;
  const destinationX = ((visibleStart - viewportStart) / viewportSamples) * canvas.width;
  const destinationWidth = ((visibleEnd - visibleStart) / viewportSamples) * canvas.width;
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(
    cache.canvas,
    sourceX,
    0,
    Math.max(Number.EPSILON, sourceWidth),
    cache.height,
    destinationX,
    0,
    destinationWidth,
    canvas.height,
  );
  ctx.restore();

  drawExactWaveSegments(
    ctx,
    canvas,
    tile,
    viewportStart,
    viewportSamples,
    rowHeights,
    rowTopInsets,
    matchChannelColors,
  );
}

function drawExactWaveSegments(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  tile: WaveformTile,
  viewportStart: number,
  viewportSamples: number,
  rowHeights: number[],
  rowTopInsets: number[],
  matchChannelColors: boolean,
) {
  const dpr = window.devicePixelRatio || 1;
  const channelLayout = getSaleaeGraphChannelLayout(
    rowHeights,
    tile.channels.length,
    dpr,
    rowTopInsets,
  );
  const left = graphPaddingLeft * dpr;
  const right = canvas.width - graphPaddingRight * dpr;
  const viewSamples = Math.max(1, viewportSamples);

  tile.channels.forEach((channel, index) => {
    if (channel.segments.length === 0) return;
    const layout = channelLayout[index];
    const gutter = Math.min(
      digitalGraphGutterPx * dpr,
      Math.max(0, (layout.height - 2 * dpr) / 2),
    );
    const highY = layout.top + gutter + 0.5 * dpr;
    const transitionHeight = Math.max(dpr, Math.round(layout.height - 2 * gutter));
    const lowY = highY + transitionHeight - dpr;
    drawDigitalSegments(ctx, {
      color: matchChannelColors ? saleaeLegacyChannelColor(channel.channel) : "#ffffff",
      highY,
      lowY,
      left,
      right,
      viewSamples,
      viewStart: viewportStart,
      segments: channel.segments,
      dpr,
    });
  });
}

function renderWaveLayer(
  canvas: HTMLCanvasElement,
  tile: WaveformTile,
  rowHeights: number[],
  rowTopInsets: number[],
  matchChannelColors: boolean,
  viewportStart = tile.start_sample,
  viewportSamples = tile.sample_count,
) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.width;
  const channelLayout = getSaleaeGraphChannelLayout(rowHeights, tile.channels.length, dpr, rowTopInsets);
  const left = graphPaddingLeft * dpr;
  const right = width - graphPaddingRight * dpr;
  const viewSamples = Math.max(Number.EPSILON, viewportSamples);
  const viewStart = viewportStart;

  tile.channels.forEach((channel, index) => {
    const layout = channelLayout[index];
    const laneHeight = layout.height;
    const gutter = Math.min(digitalGraphGutterPx * dpr, Math.max(0, (laneHeight - 2 * dpr) / 2));
    const highY = layout.top + gutter + 0.5 * dpr;
    const transitionHeight = Math.max(dpr, Math.round(laneHeight - 2 * gutter));
    const lowY = highY + transitionHeight - dpr;
    ctx.strokeStyle = "rgba(255,255,255,0.075)";
    ctx.beginPath();
    ctx.moveTo(0, Math.floor(layout.outerTop) + 0.5);
    ctx.lineTo(width, Math.floor(layout.outerTop) + 0.5);
    ctx.stroke();

    const channelColor = matchChannelColors ? saleaeLegacyChannelColor(channel.channel) : "#ffffff";
    if (channel.segments.length === 0) {
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

interface DigitalExtraDataLine {
  label: string;
  value: string;
  superscript?: string;
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

  const lines: DigitalExtraDataLine[] = [];
  if (periodSamples != null && periodSamples > 0) {
    lines.push({
      label: "Duty",
      value: `${formatRounded((widthSamples / periodSamples) * 100, 2)} %`,
    });
    lines.push({ label: "Freq", value: formatFrequency(sampleRateHz / periodSamples) });
    lines.push({ label: "Period", value: formatDuration(periodSamples, sampleRateHz) });
  }
  lines.push({
    label: "width",
    superscript: "-1",
    value: formatFrequency(sampleRateHz / widthSamples),
  });

  const padding = 5 * dpr;
  const lineHeight = 18 * dpr;
  const minWidth = digitalMeasurementBoxMinWidthPx * dpr;
  const boxWidth = Math.max(
    minWidth,
    Math.max(...lines.map((line) => measureDigitalExtraDataLine(ctx, line, dpr))) + padding * 2,
  );
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

  ctx.fillStyle = "rgba(255, 255, 255, 0.72)";
  lines.forEach((line, index) =>
    drawDigitalExtraDataLine(
      ctx,
      line,
      boxX + padding,
      boxY + padding + (index + 0.78) * lineHeight,
      dpr,
    ),
  );
}

function measureDigitalExtraDataLine(
  ctx: CanvasRenderingContext2D,
  line: DigitalExtraDataLine,
  dpr: number,
) {
  ctx.font = `${12 * dpr}px Roboto, Helvetica, Arial, sans-serif`;
  let width = ctx.measureText(line.label).width;
  if (line.superscript) {
    ctx.font = `${8 * dpr}px Roboto, Helvetica, Arial, sans-serif`;
    width += ctx.measureText(line.superscript).width;
  }
  ctx.font = `${12 * dpr}px Roboto, Helvetica, Arial, sans-serif`;
  return width + ctx.measureText(`: ${line.value}`).width;
}

function drawDigitalExtraDataLine(
  ctx: CanvasRenderingContext2D,
  line: DigitalExtraDataLine,
  x: number,
  baseline: number,
  dpr: number,
) {
  ctx.font = `${12 * dpr}px Roboto, Helvetica, Arial, sans-serif`;
  ctx.fillText(line.label, x, baseline);
  let cursor = x + ctx.measureText(line.label).width;
  if (line.superscript) {
    ctx.font = `${8 * dpr}px Roboto, Helvetica, Arial, sans-serif`;
    ctx.fillText(line.superscript, cursor, baseline - 5 * dpr);
    cursor += ctx.measureText(line.superscript).width;
  }
  ctx.font = `${12 * dpr}px Roboto, Helvetica, Arial, sans-serif`;
  ctx.fillText(`: ${line.value}`, cursor, baseline);
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

interface EdgeHit {
  channelIndex: number;
  sample: number;
}

function channelIndexAtClientY(
  rect: DOMRect,
  tile: WaveformTile | null,
  rowHeights: number[],
  rowTopInsets: number[],
  clientY: number,
) {
  if (!tile) return null;
  return findSaleaeGraphChannelIndexAtY(
    getSaleaeGraphChannelLayout(rowHeights, tile.channels.length, 1, rowTopInsets),
    clientY - rect.top,
  );
}

function findEdgeHitAtClientPoint(
  host: HTMLElement | null,
  tile: WaveformTile | null,
  viewportStart: number,
  viewportSamples: number,
  rowHeights: number[],
  rowTopInsets: number[],
  clientX: number,
  clientY: number,
  thresholdPx: number,
  rejectCrowdedEdges: boolean,
): EdgeHit | null {
  if (!host || !tile || viewportSamples <= 0) return null;
  const rect = host.getBoundingClientRect();
  const channelIndex = channelIndexAtClientY(rect, tile, rowHeights, rowTopInsets, clientY);
  if (channelIndex == null) return null;
  const edges = collectDigitalEdges(tile, channelIndex);
  if (edges.length === 0) return null;
  const channel = tile.channels[channelIndex];
  if (rejectCrowdedEdges && channel.rising_edges.length === 0 && channel.falling_edges.length === 0) {
    return null;
  }
  const pointerSample = viewportStart
    + clamp((clientX - rect.left) / Math.max(1, rect.width), 0, 1) * viewportSamples;
  const samplesPerPixel = viewportSamples / Math.max(1, rect.width);
  const sample = findNearestEdgeSample(
    edges.map((edge) => edge.sample),
    pointerSample,
    samplesPerPixel,
    thresholdPx,
    rejectCrowdedEdges,
  );
  return sample == null ? null : { channelIndex, sample };
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
  if (seconds < 1e-9) return `${formatRounded(seconds * 1e12, 3)} ps`;
  if (seconds < 1e-6) return `${formatRounded(seconds * 1e9, 0)} ns`;
  if (seconds < 1e-3) return `${formatRounded(seconds * 1e6, 3)} us`;
  if (seconds < 1) return `${formatRounded(seconds * 1e3, 6)} ms`;
  return `${formatRounded(seconds, 9)} s`;
}

function formatFrequency(hz: number) {
  if (!Number.isFinite(hz)) return "--";
  const value = Math.abs(hz);
  if (value >= 1e9) return `${formatRounded(hz / 1e9, 3)} GHz`;
  if (value >= 1e6) return `${formatRounded(hz / 1e6, 3)} MHz`;
  if (value >= 1e3) return `${formatRounded(hz / 1e3, 3)} kHz`;
  return `${formatRounded(hz, 3)} Hz`;
}

function formatRounded(value: number, places: number) {
  return Number(value.toFixed(places)).toString();
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function normalizeViewport(
  start: number,
  samples: number,
  totalSamples: number,
  isLive: boolean,
  sampleRateHz: number,
  maximumViewportSamples?: number,
) {
  return isLive
    ? normalizeLiveCaptureViewport(
        start,
        samples,
        totalSamples,
        sampleRateHz,
        maximumViewportSamples,
      )
    : normalizeCaptureViewport(start, samples, totalSamples, maximumViewportSamples);
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
