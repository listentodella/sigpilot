import { PointerEvent, useEffect, useRef, useState } from "react";
import { useSessionViewport } from "../lib/useSessionViewport";

interface StripChartScrollbarProps {
  onViewportStartChange: (startSample: number) => void;
  sessionId?: string;
  totalSamples: number;
  viewportSamples: number;
  viewportStart: number;
}

interface ScrollbarGeometry {
  barWidthPx: number;
  leftPx: number;
}

const minimumBarWidthPx = 25;
const panningAnimationDurationMs = 300;

// Ported from Logic 2.4.43 services/stripChartScrollbar/index.tsx.
export function stripChartScrollbarGeometry(
  totalSamples: number,
  viewportStart: number,
  viewportSamples: number,
  graphWidthPx: number,
): ScrollbarGeometry {
  const width = Math.max(0, graphWidthPx);
  if (width === 0) return { barWidthPx: 0, leftPx: 0 };

  const total = Math.max(0, totalSamples);
  const view = total > 0 ? Math.max(1, Math.min(total, viewportSamples)) : 0;
  const unboundedBarWidthPx = Math.round((total !== 0 ? view / total : 1) * width);
  const barWidthPx = Math.min(width, Math.max(minimumBarWidthPx, unboundedBarWidthPx));
  const remainingTrackPx = width - barWidthPx;

  let leftPositionRatio = 1;
  if (view < total) {
    leftPositionRatio = clamp(viewportStart / Math.max(1, total - view), 0, 1);
  }

  return {
    barWidthPx,
    leftPx: leftPositionRatio * remainingTrackPx,
  };
}

export function stripChartPixelToSample(
  leftPx: number,
  totalSamples: number,
  viewportSamples: number,
  graphWidthPx: number,
  barWidthPx: number,
) {
  const total = Math.max(0, totalSamples);
  const view = total > 0 ? Math.max(1, Math.min(total, viewportSamples)) : 0;
  const remainingTrackPx = Math.max(0, graphWidthPx - barWidthPx);
  const leftPositionRatio = remainingTrackPx !== 0 ? leftPx / remainingTrackPx : 0;
  return clamp(leftPositionRatio, 0, 1) * Math.max(0, total - view);
}

export function StripChartScrollbar({
  onViewportStartChange,
  sessionId,
  totalSamples,
  viewportSamples,
  viewportStart,
}: StripChartScrollbarProps) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ pointerId: number; startLeftPx: number; startX: number } | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const [trackWidthPx, setTrackWidthPx] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  // The thumb follows the live viewport so it never lags a pan or zoom.
  const viewport = useSessionViewport(sessionId, viewportStart, viewportSamples);
  const geometry = stripChartScrollbarGeometry(
    totalSamples,
    viewport.start,
    viewport.samples,
    trackWidthPx,
  );

  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    const observer = new ResizeObserver(([entry]) => setTrackWidthPx(entry.contentRect.width));
    observer.observe(track);
    return () => observer.disconnect();
  }, []);

  useEffect(() => () => cancelPanAnimation(), []);

  function cancelPanAnimation() {
    if (animationFrameRef.current !== null) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
  }

  function sampleForLeft(leftPx: number) {
    return stripChartPixelToSample(
      leftPx,
      totalSamples,
      viewport.samples,
      trackWidthPx,
      geometry.barWidthPx,
    );
  }

  function animatePan(targetStart: number) {
    cancelPanAnimation();
    const initialStart = viewport.start;
    const delta = targetStart - initialStart;
    if (Math.abs(delta) < 1) {
      onViewportStartChange(targetStart);
      return;
    }

    const startedAt = performance.now();
    const step = (now: number) => {
      const progress = clamp((now - startedAt) / panningAnimationDurationMs, 0, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      onViewportStartChange(initialStart + delta * eased);
      if (progress < 1) {
        animationFrameRef.current = requestAnimationFrame(step);
      } else {
        animationFrameRef.current = null;
        onViewportStartChange(targetStart);
      }
    };
    animationFrameRef.current = requestAnimationFrame(step);
  }

  function finishDrag(event: PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setIsDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  if (totalSamples <= 0) return null;

  return (
    <div
      aria-label="Capture horizontal scroll"
      aria-orientation="horizontal"
      aria-valuemax={Math.max(0, totalSamples - viewport.samples)}
      aria-valuemin={0}
      aria-valuenow={Math.round(viewport.start)}
      className="stripChartScrollBar"
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        const rect = event.currentTarget.getBoundingClientRect();
        animatePan(sampleForLeft(event.clientX - rect.left));
      }}
      ref={trackRef}
      role="scrollbar"
    >
      <div
        className={`stripChartScrollThumb ${isDragging ? "dragging" : ""}`}
        onPointerCancel={finishDrag}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          event.stopPropagation();
          cancelPanAnimation();
          event.currentTarget.setPointerCapture(event.pointerId);
          dragRef.current = {
            pointerId: event.pointerId,
            startLeftPx: geometry.leftPx,
            startX: event.clientX,
          };
          setIsDragging(true);
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current;
          if (!drag || drag.pointerId !== event.pointerId) return;
          event.preventDefault();
          onViewportStartChange(sampleForLeft(drag.startLeftPx + event.clientX - drag.startX));
        }}
        onPointerUp={finishDrag}
        style={{
          transform: `translateX(${geometry.leftPx}px)`,
          width: geometry.barWidthPx,
        }}
      />
    </div>
  );
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, value));
}
