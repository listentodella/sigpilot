import { CSSProperties, MouseEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AnalyzerBubble, AnalyzerTrackWindow, WaveformTile } from "../lib/api";
import {
  ANALYZER_BUBBLES_PADDING_PX,
  ANALYZER_STRIP_HEIGHT_PX,
  AnalyzerChannelRole,
  UiAnalyzerInstance,
  analyzerBubbleRoles,
  analyzerMarkerRoles,
  formatAnalyzerText,
} from "../lib/analyzers";
import { saleaeLegacyChannelColor } from "../lib/saleaeChannelColors";
import { SALEAE_ROW_V2_SPACING_PX } from "../lib/saleaeChannelLayout";

const APPROXIMATE_CHARACTER_WIDTH_PX = 6;
const BUBBLE_EDGE_ARROW_WIDTH_PX = 3;
const MAX_MULTI_BUBBLE_COUNT = 99;
const MAX_MULTI_BUBBLE_TEXT_LENGTH = 200;
const MAX_MARKERS_PER_TRACK = 300;

interface AnalyzerBubbleTrack {
  analyzer: UiAnalyzerInstance;
  key: string;
  role: AnalyzerChannelRole;
  window: AnalyzerTrackWindow | null;
}

interface AnalyzerMarkerTrack {
  analyzer: UiAnalyzerInstance;
  edgeType: "rising" | "falling";
  key: string;
  role: AnalyzerChannelRole;
}

interface AnalyzerBubblesOverlayProps {
  analyzers: UiAnalyzerInstance[];
  rowHeights: number[];
  rowTopInsets: number[];
  tile: WaveformTile | null;
  viewportSamples: number;
  viewportStart: number;
  visibleChannelIndexes: number[];
  onGoToFrame: (analyzerId: string, frameIndex: number) => void;
  onOpenTableFrame: (analyzerId: string, frameIndex: number) => void;
  onSelectFrame: (analyzerId: string, frameIndex: number) => void;
  onZoomBubble: (analyzerId: string, startSample: number, endSample: number, frameIndex: number) => void;
}

export function AnalyzerBubblesOverlay({
  analyzers,
  rowHeights,
  rowTopInsets,
  tile,
  viewportSamples,
  viewportStart,
  visibleChannelIndexes,
  onGoToFrame,
  onOpenTableFrame,
  onSelectFrame,
  onZoomBubble,
}: AnalyzerBubblesOverlayProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const callbacksRef = useRef({ onGoToFrame, onOpenTableFrame, onSelectFrame, onZoomBubble });
  callbacksRef.current = { onGoToFrame, onOpenTableFrame, onSelectFrame, onZoomBubble };
  const [overlayWidth, setOverlayWidth] = useState(1);
  const [hoveredTrackKey, setHoveredTrackKey] = useState<string | null>(null);
  const rowTops = useMemo(() => {
    let top = 0;
    return rowHeights.map((height) => {
      const current = top;
      top += height + SALEAE_ROW_V2_SPACING_PX;
      return current;
    });
  }, [rowHeights]);
  const bubbleTracks = useMemo<AnalyzerBubbleTrack[]>(
    () =>
      analyzers.flatMap((analyzer) =>
        analyzerBubbleRoles(analyzer).map((role) => ({
          analyzer,
          key: `${analyzer.id}:${role.title}:${role.channel}:bubbles`,
          role,
          window:
            analyzer.renderedTracks.find(
              (track) => track.channel === role.channel && track.role === role.title,
            ) ?? null,
        })),
      ),
    [analyzers],
  );
  const markerTracks = useMemo<AnalyzerMarkerTrack[]>(
    () =>
      analyzers.flatMap((analyzer) =>
        analyzerMarkerRoles(analyzer).map((role) => ({
          analyzer,
          edgeType: analyzerMarkerEdgeType(analyzer),
          key: `${analyzer.id}:${role.title}:${role.channel}:markers`,
          role,
        })),
      ),
    [analyzers],
  );
  const tileChannels = useMemo(
    () => new Map((tile?.channels ?? []).map((channel) => [channel.channel, channel])),
    [tile],
  );
  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;
    const updateWidth = () => setOverlayWidth(Math.max(1, overlay.clientWidth));
    const observer = new ResizeObserver(updateWidth);
    observer.observe(overlay);
    updateWidth();
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!hoveredTrackKey) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      const track = bubbleTracks.find((item) => item.key === hoveredTrackKey);
      if (!track) return;
      const frameWindow = track.window;
      const frameIndex =
        event.key === "ArrowLeft"
          ? frameWindow?.previous_frame?.frame_id ?? null
          : event.key === "ArrowRight"
            ? frameWindow?.next_frame?.frame_id ?? null
            : null;
      if (frameIndex === null) return;
      event.preventDefault();
      callbacksRef.current.onGoToFrame(track.analyzer.id, frameIndex);
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [bubbleTracks, hoveredTrackKey]);

  useLayoutEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;
    const width = Math.max(1, overlay.clientWidth);
    const samples = Math.max(1, viewportSamples);

    overlay.querySelectorAll<HTMLElement>(".analyzerBubble").forEach((element) => {
      const start = Number(element.dataset.bubbleStart);
      const end = Number(element.dataset.bubbleEnd);
      if (!Number.isFinite(start) || !Number.isFinite(end)) return;
      const left = ((start - viewportStart) / samples) * width;
      const right = ((end - viewportStart) / samples) * width;
      const visible = right >= 0 && left <= width;
      element.style.display = visible ? "flex" : "none";
      if (!visible) return;
      element.style.left = `${Math.max(0, left)}px`;
      element.style.width = `${Math.max(1, Math.min(right, width) - Math.max(left, 0))}px`;
      element.classList.toggle("overflowLeft", left < 0);
      element.classList.toggle("overflowRight", right > width);
    });

  }, [overlayWidth, viewportSamples, viewportStart, bubbleTracks, markerTracks, tileChannels]);

  useLayoutEffect(() => {
    const overlay = overlayRef.current;
    const canvas = overlay?.querySelector<HTMLCanvasElement>(".analyzerMarkersCanvas");
    if (!overlay || !canvas) return;
    const width = Math.max(1, overlay.clientWidth);
    const height = Math.max(1, overlay.clientHeight);
    const dpr = window.devicePixelRatio || 1;
    const pixelWidth = Math.max(1, Math.floor(width * dpr));
    const pixelHeight = Math.max(1, Math.floor(height * dpr));
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    const context = canvas.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, pixelWidth, pixelHeight);
    context.save();
    context.scale(dpr, dpr);
    context.lineWidth = 1;
    context.globalAlpha = 0.96;
    context.shadowColor = "rgba(0, 0, 0, 0.45)";
    context.shadowBlur = 1;
    context.shadowOffsetY = 1;

    const viewStart = viewportStart;
    const viewEnd = viewportStart + Math.max(1, viewportSamples);
    markerTracks.forEach((track) => {
      const rowIndex = visibleChannelIndexes.indexOf(track.role.channel);
      if (rowIndex < 0) return;
      const channel = tileChannels.get(track.role.channel);
      if (!channel) return;
      const edgeSamples = track.edgeType === "rising" ? channel.rising_edges : channel.falling_edges;
      if (edgeSamples.length === 0) return;
      const firstIndex = Math.max(0, firstMarkerAtOrAfter(edgeSamples, viewStart - viewportSamples * 0.02));
      const inset = Math.max(0, rowTopInsets[rowIndex] ?? 0);
      const trackHeight = Math.max(1, rowHeights[rowIndex] - inset);
      const centerY = rowTops[rowIndex] + inset + trackHeight / 2;
      context.fillStyle = saleaeLegacyChannelColor(track.role.channel);
      context.strokeStyle = context.fillStyle;
      for (
        let index = firstIndex, rendered = 0;
        index < edgeSamples.length && rendered < MAX_MARKERS_PER_TRACK;
        index += 1
      ) {
        const sample = edgeSamples[index];
        if (sample > viewEnd + viewportSamples * 0.02) break;
        const left = ((sample - viewStart) / Math.max(1, viewportSamples)) * width;
        if (left < -10 || left > width + 10) continue;
        drawAnalyzerMarker(context, left, centerY, track.edgeType);
        rendered += 1;
      }
    });
    context.restore();
  }, [
    markerTracks,
    overlayWidth,
    rowHeights,
    rowTopInsets,
    rowTops,
    tileChannels,
    viewportSamples,
    viewportStart,
    visibleChannelIndexes,
  ]);

  const renderedContent = useMemo(
    () => (
      <>
      <canvas className="analyzerMarkersCanvas" aria-hidden="true" />
      {visibleChannelIndexes.flatMap((channel, rowIndex) => {
        const channelTracks = bubbleTracks.filter((track) => track.role.channel === channel);
        return channelTracks.map((track, trackIndex) => {
          const { analyzer } = track;
          const frameWindow = track.window;
          const bubbles = frameWindow?.bubbles ?? [];
          const previousIndex = frameWindow?.previous_frame?.frame_id ?? null;
          const nextIndex = frameWindow?.next_frame?.frame_id ?? null;
          const hovered = hoveredTrackKey === track.key;

          return (
            <div
              className="analyzerBubbleStrip"
              data-analyzer-track={track.key}
              data-bubble-count={bubbles.length}
              data-first-bubble-start={bubbles[0]?.start_sample ?? ""}
              data-last-bubble-end={bubbles[bubbles.length - 1]?.end_sample ?? ""}
              data-window-state={frameWindow ? "ready" : "pending"}
              key={track.key}
              onMouseEnter={() => setHoveredTrackKey(track.key)}
              onMouseLeave={() =>
                setHoveredTrackKey((current) => (current === track.key ? null : current))
              }
              style={{
                top:
                  rowTops[rowIndex] +
                  trackIndex * ANALYZER_STRIP_HEIGHT_PX +
                  ANALYZER_BUBBLES_PADDING_PX,
              }}
            >
              {bubbles.map((bubble) => {
                const left = ((bubble.start_sample - viewportStart) / Math.max(1, viewportSamples)) * overlayWidth;
                const originalBubbleWidth =
                  ((bubble.end_sample - bubble.start_sample) / Math.max(1, viewportSamples)) * overlayWidth;
                const right = left + originalBubbleWidth;
                const bubbleWidth = Math.max(
                  1,
                  Math.min(originalBubbleWidth + Math.min(0, left), overlayWidth - Math.max(left, 0)),
                );
                const overflowLeft = left < 0;
                const overflowRight = right > overlayWidth;
                const firstFrameIndex = bubble.frame_id_interval.begin;
                const multi = bubble.type === "MultiBubble" || bubble.result_count > 1;
                const highlighted =
                  analyzer.highlightedFrameIndex !== null &&
                  analyzer.highlightedFrameIndex >= bubble.frame_id_interval.begin &&
                  analyzer.highlightedFrameIndex < bubble.frame_id_interval.end;
                const arrowWidth =
                  (overflowLeft ? BUBBLE_EDGE_ARROW_WIDTH_PX : 0) +
                  (overflowRight ? BUBBLE_EDGE_ARROW_WIDTH_PX : 0);
                const formattedDisplayText = bubble.display_text.map((label) =>
                  formatAnalyzerText(label, analyzer.displayRadix),
                );
                const text = multi
                  ? multiBubbleText({ ...bubble, display_text: formattedDisplayText }, bubbleWidth - 28)
                  : bestFrameText(formattedDisplayText, bubbleWidth - arrowWidth - 6);
                const tooltip = multi ? bubbleTooltipText({ ...bubble, display_text: formattedDisplayText }, text) : formattedDisplayText[0] ?? "";

                function handleClick(event: MouseEvent<HTMLButtonElement>) {
                  event.stopPropagation();
                  if (event.metaKey || event.ctrlKey) {
                    callbacksRef.current.onOpenTableFrame(analyzer.id, firstFrameIndex);
                  } else {
                    callbacksRef.current.onSelectFrame(analyzer.id, firstFrameIndex);
                  }
                }

                return (
                  <button
                    className={`analyzerBubble ${multi ? "multi" : ""} ${highlighted ? "highlighted" : ""} ${overflowLeft ? "overflowLeft" : ""} ${overflowRight ? "overflowRight" : ""}`}
                    data-bubble-end={bubble.end_sample}
                    data-bubble-start={bubble.start_sample}
                    key={`${bubble.start_sample}-${bubble.frame_id_interval.begin}-${bubble.frame_id_interval.end}`}
                    onClick={handleClick}
                    onDoubleClick={(event) => {
                      event.stopPropagation();
                      callbacksRef.current.onZoomBubble(
                        analyzer.id,
                        bubble.start_sample,
                        bubble.end_sample,
                        firstFrameIndex,
                      );
                    }}
                    style={{
                      display: right >= 0 && left <= overlayWidth ? "flex" : "none",
                      left: Math.max(left, 0),
                      width: bubbleWidth,
                      "--analyzer-color": analyzer.color,
                    } as CSSProperties}
                    title={`${tooltip}\n${navigator.platform.includes("Mac") ? "⌘" : "Ctrl"}+click to scroll to table row`}
                    type="button"
                  >
                    {!multi && <span className="analyzerBubbleArrow left" />}
                    {multi && (
                      <span className="analyzerBubbleCounter">
                        {bubble.result_count > MAX_MULTI_BUBBLE_COUNT ? `${MAX_MULTI_BUBBLE_COUNT}+` : bubble.result_count}
                      </span>
                    )}
                    <span className="analyzerBubbleText">{text}</span>
                    {!multi && <span className="analyzerBubbleArrow right" />}
                  </button>
                );
              })}

              {hovered && previousIndex !== null && (
                <AnalyzerBubbleNavigationButton
                  direction="previous"
                  onClick={() => callbacksRef.current.onGoToFrame(analyzer.id, previousIndex)}
                />
              )}
              {hovered && nextIndex !== null && (
                <AnalyzerBubbleNavigationButton
                  direction="next"
                  onClick={() => callbacksRef.current.onGoToFrame(analyzer.id, nextIndex)}
                />
              )}
            </div>
          );
        });
      })}
      </>
    ),
    [
      bubbleTracks,
      hoveredTrackKey,
      overlayWidth,
      rowHeights,
      rowTopInsets,
      rowTops,
      visibleChannelIndexes,
    ],
  );

  return (
    <div className="analyzerBubblesOverlay" ref={overlayRef}>
      {renderedContent}
    </div>
  );
}

function firstMarkerAtOrAfter(samples: number[], sample: number) {
  let low = 0;
  let high = samples.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (samples[middle] < sample) low = middle + 1;
    else high = middle;
  }
  return low;
}

function drawAnalyzerMarker(
  context: CanvasRenderingContext2D,
  centerX: number,
  centerY: number,
  edgeType: "rising" | "falling",
) {
  const width = 9;
  const height = 6;
  const left = centerX - width / 2;
  const top = centerY - height / 2;
  context.beginPath();
  if (edgeType === "rising") {
    context.moveTo(left, top + height);
    context.lineTo(centerX, top);
    context.lineTo(left + width, top + height);
  } else {
    context.moveTo(left, top);
    context.lineTo(centerX, top + height);
    context.lineTo(left + width, top);
  }
  context.closePath();
  context.fill();
  context.stroke();
}

function analyzerMarkerEdgeType(analyzer: UiAnalyzerInstance): "rising" | "falling" {
  if (analyzer.type === "SPI") {
    return analyzer.spiClockPolarity === analyzer.spiClockPhase ? "rising" : "falling";
  }
  return "rising";
}

function AnalyzerBubbleNavigationButton({
  direction,
  onClick,
}: {
  direction: "previous" | "next";
  onClick: () => void;
}) {
  const shortcut = navigator.platform.includes("Mac") ? "⌘" : "Ctrl";
  return (
    <button
      aria-label={`${direction === "next" ? "Next" : "Previous"} Data`}
      className={`analyzerBubbleNavigationButton ${direction}`}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      onDoubleClick={(event) => event.stopPropagation()}
      type="button"
    >
      {direction === "next" ? <NextBubbleIcon /> : <PreviousBubbleIcon />}
      <span className={`analyzerBubbleNavigationTooltip ${direction}`}>
        <span>{direction === "next" ? "Next Data" : "Previous Data"}</span>
        <span className="shortcutIcon">
          <span className="shortcutPiece">{shortcut}</span>
          <span className="shortcutPiece">{direction === "next" ? "→" : "←"}</span>
        </span>
      </span>
    </button>
  );
}

function bestFrameText(displayText: string[], widthPx: number) {
  const candidates = displayText.flatMap((label) => {
    const quoted = label.match(/^'(.+)'\s+(0x[0-9A-F]+)$/i);
    return quoted ? [label, quoted[1], quoted[2]] : [label];
  });
  const sorted = [...candidates].sort((left, right) => right.length - left.length);
  return (
    sorted.find((candidate) => candidate.length * APPROXIMATE_CHARACTER_WIDTH_PX < widthPx) ??
    sorted[sorted.length - 1] ??
    ""
  );
}

function multiBubbleText(bubble: AnalyzerBubble, widthPx: number) {
  const text = bubble.display_text.map((label) => bestFrameText([label], widthPx)).join("·");
  const suffix = bubble.display_text.length < bubble.result_count ? "..." : "";
  const output = `${text}${suffix}`;
  return output.length > MAX_MULTI_BUBBLE_TEXT_LENGTH
    ? `${output.slice(0, MAX_MULTI_BUBBLE_TEXT_LENGTH)}...`
    : output;
}

function bubbleTooltipText(bubble: AnalyzerBubble, bubbleText: string) {
  const text = bubble.display_text.join("·");
  const output = text || bubbleText;
  const clipped = output.length > 80 ? `${output.slice(0, 80)}...` : output;
  if (bubble.type === "MultiBubble" || bubble.result_count > 1) {
    return `[${bubble.result_count} results] ${clipped}`;
  }
  return clipped;
}

function NextBubbleIcon() {
  return (
    <svg aria-hidden="true" height="11" viewBox="0 0 18 11" width="18">
      <path d="M9.024 5.867 8.997 6.31l.436.08 2.719.496-.023.126-3.268-.598-.065-.011.012-.065.262-3.36.128.023-.174 2.866Z" fill="currentColor" stroke="currentColor" />
      <path d="M16.708 7.118c-2.622-5.209-4.118-5.32-7.532-.979" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M1.01 1.981h4.846L7 4.981l-1.144 3H1.01L0 4.981l1.01-3Z" fill="currentColor" />
    </svg>
  );
}

function PreviousBubbleIcon() {
  return (
    <svg aria-hidden="true" height="11" viewBox="0 0 18 11" width="18">
      <path d="m8.879 5.867.027.443-.436.08-2.718.496.023.126 3.267-.598.065-.011-.012-.065-.262-3.36-.128.023.174 2.866Z" fill="currentColor" stroke="currentColor" />
      <path d="M1.196 7.118c2.621-5.209 4.117-5.32 7.532-.979" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M17.123 2.662a.998.998 0 0 0-.948-.681h-3.438a1 1 0 0 0-.935.643l-.763 2a1 1 0 0 0 0 .713l.763 2a1 1 0 0 0 .935.644h3.438a.998.998 0 0 0 .948-.681l.673-2a1 1 0 0 0 0-.638l-.673-2Z" fill="currentColor" />
    </svg>
  );
}
