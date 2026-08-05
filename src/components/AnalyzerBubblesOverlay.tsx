import { CSSProperties, MouseEvent, useEffect, useMemo, useRef, useState } from "react";
import { AnalyzerBubble, AnalyzerTrackWindow, WaveformTile } from "../lib/api";
import { analyzerBubbleLayout } from "../lib/analyzerBubbleLayout";
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
import {
  visibleAnalyzerMarkerSamples,
  visibleAnalyzerProtocolMarkers,
} from "../lib/analyzerMarkers";
import { traceAnalyzerPerformance } from "../lib/analyzerPerformance";

const APPROXIMATE_CHARACTER_WIDTH_PX = 6;
const BUBBLE_EDGE_ARROW_WIDTH_PX = 3;
const MAX_MULTI_BUBBLE_COUNT = 99;
const MAX_MULTI_BUBBLE_TEXT_LENGTH = 200;

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

interface AnalyzerBubbleElementBinding {
  endSample: number;
  element: HTMLButtonElement;
  labels: string[];
  multi: boolean;
  resultCount: number;
  startSample: number;
  textElement: HTMLElement | null;
}

interface AnalyzerBubblesOverlayProps {
  analyzers: UiAnalyzerInstance[];
  rowHeights: number[];
  rowTopInsets: number[];
  tile: WaveformTile | null;
  viewportSamples: number;
  viewportStart: number;
  viewportInteracting: boolean;
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
  viewportInteracting,
  visibleChannelIndexes,
  onGoToFrame,
  onOpenTableFrame,
  onSelectFrame,
  onZoomBubble,
}: AnalyzerBubblesOverlayProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const bubbleElementsRef = useRef(new Map<string, AnalyzerBubbleElementBinding>());
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

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const started = performance.now();
      const overlay = overlayRef.current;
      if (!overlay) return;
      const width = Math.max(1, overlay.clientWidth);
      const samples = Math.max(1, viewportSamples);

      bubbleElementsRef.current.forEach(({ endSample, element, labels, multi, resultCount, startSample, textElement }) => {
        const layout = analyzerBubbleLayout(startSample, endSample, viewportStart, samples, width);
        const { overflowLeft, overflowRight, visible } = layout;
        const display = visible ? "flex" : "none";
        if (element.style.display !== display) element.style.display = display;
        if (!visible) return;
        const bubbleWidth = layout.widthPx;
        const transform = `translate3d(${layout.leftPx}px, 0, 0)`;
        const widthStyle = `${bubbleWidth}px`;
        if (element.style.transform !== transform) element.style.transform = transform;
        if (element.style.width !== widthStyle) element.style.width = widthStyle;
        element.classList.toggle("overflowLeft", overflowLeft);
        element.classList.toggle("overflowRight", overflowRight);

        if (!viewportInteracting) {
          const arrowWidth =
            (overflowLeft ? BUBBLE_EDGE_ARROW_WIDTH_PX : 0) +
            (overflowRight ? BUBBLE_EDGE_ARROW_WIDTH_PX : 0);
          const nextText = multi
            ? multiBubbleTextFromValues(labels, resultCount, bubbleWidth - 28)
            : bestFrameText(labels, bubbleWidth - arrowWidth - 6);
          if (textElement && textElement.textContent !== nextText) textElement.textContent = nextText;
        }
      });
      traceAnalyzerPerformance(
        "bubble_dom_update",
        started,
        `elements=${bubbleElementsRef.current.size} interacting=${viewportInteracting}`,
      );
    });
    return () => window.cancelAnimationFrame(frame);
  }, [overlayWidth, viewportSamples, viewportStart, viewportInteracting, bubbleTracks]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
    const started = performance.now();
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
    const nativeMarkerChannels = new Set(
      analyzers.flatMap((analyzer) =>
        analyzer.renderedTracks
          .filter((track) => (track.protocol_markers?.length ?? 0) > 0)
          .map((track) => `${analyzer.id}:${track.channel}`),
      ),
    );
    markerTracks.forEach((track) => {
      if (nativeMarkerChannels.has(`${track.analyzer.id}:${track.role.channel}`)) return;
      const rowIndex = visibleChannelIndexes.indexOf(track.role.channel);
      if (rowIndex < 0) return;
      const channel = tileChannels.get(track.role.channel);
      if (!channel) return;
      const edgeSamples = track.edgeType === "rising" ? channel.rising_edges : channel.falling_edges;
      if (edgeSamples.length === 0) return;
      const inset = Math.max(0, rowTopInsets[rowIndex] ?? 0);
      const trackHeight = Math.max(1, rowHeights[rowIndex] - inset);
      const centerY = rowTops[rowIndex] + inset + trackHeight / 2;
      context.fillStyle = saleaeLegacyChannelColor(track.role.channel);
      context.strokeStyle = context.fillStyle;
      const markerSamples = visibleAnalyzerMarkerSamples(
        edgeSamples,
        viewStart,
        viewEnd - viewStart,
        width,
      );
      for (const sample of markerSamples) {
        const left = ((sample - viewStart) / Math.max(1, viewportSamples)) * width;
        drawAnalyzerMarker(context, left, centerY, track.edgeType);
      }
    });
    analyzers.forEach((analyzer) => {
      analyzer.renderedTracks.forEach((track) => {
        const markers = track.protocol_markers ?? [];
        if (markers.length === 0) return;
        const rowIndex = visibleChannelIndexes.indexOf(track.channel);
        if (rowIndex < 0) return;
        const channel = tileChannels.get(track.channel);
        const allEdgeSamples = channel
          ? [...channel.rising_edges, ...channel.falling_edges].sort((left, right) => left - right)
          : [];
        const inset = Math.max(0, rowTopInsets[rowIndex] ?? 0);
        const trackHeight = Math.max(1, rowHeights[rowIndex] - inset);
        const centerY = rowTops[rowIndex] + inset + trackHeight / 2;
        for (const marker of visibleAnalyzerProtocolMarkers(
          markers,
          viewStart,
          viewEnd - viewStart,
          width,
        )) {
          const edgeSamples = protocolMarkerEdgeSamples(
            analyzer,
            marker.kind,
            channel,
            allEdgeSamples,
          );
          const sample = snapProtocolMarkerToEdge(
            marker.kind,
            marker.sample,
            edgeSamples,
          );
          const left = crispAnalyzerMarkerX(
            ((sample - viewStart) / Math.max(1, viewportSamples)) * width,
          );
          drawProtocolMarker(
            context,
            left,
            centerY,
            marker.kind,
            saleaeLegacyChannelColor(track.channel),
          );
        }
      });
    });
    context.restore();
    traceAnalyzerPerformance("marker_canvas_update", started);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [
    bubbleTracks,
    analyzers,
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
                const bubbleKey = `${track.key}:${bubble.start_sample}:${bubble.frame_id_interval.begin}:${bubble.frame_id_interval.end}`;

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
                    key={bubbleKey}
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
                      left: 0,
                      transform: `translate3d(${Math.max(left, 0)}px, 0, 0)`,
                      width: bubbleWidth,
                      "--analyzer-color": analyzer.color,
                    } as CSSProperties}
                    ref={(element) => {
                      if (element) {
                        bubbleElementsRef.current.set(bubbleKey, {
                          endSample: bubble.end_sample,
                          element,
                          labels: formattedDisplayText,
                          multi,
                          resultCount: bubble.result_count,
                          startSample: bubble.start_sample,
                          textElement: element.querySelector<HTMLElement>(".analyzerBubbleText"),
                        });
                      } else {
                        bubbleElementsRef.current.delete(bubbleKey);
                      }
                    }}
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
      <canvas className="analyzerMarkersCanvas" aria-hidden="true" />
      <div className="analyzerOverlayTransformLayer">
        {renderedContent}
      </div>
    </div>
  );
}

function multiBubbleTextFromValues(
  displayText: string[],
  resultCount: number,
  availableWidth: number,
) {
  return multiBubbleText(
    {
      display_text: displayText,
      result_count: resultCount,
    },
    availableWidth,
  );
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

function drawProtocolMarker(
  context: CanvasRenderingContext2D,
  centerX: number,
  centerY: number,
  kind: import("../lib/api").AnalyzerProtocolMarker["kind"],
  channelColor: string,
) {
  context.save();
  context.shadowColor = "rgba(0, 0, 0, 0.5)";
  context.shadowBlur = 1;
  context.fillStyle =
    kind === "start"
      ? "#00A86B"
      : kind === "stop"
        ? "#FF8A00"
        : kind.startsWith("error_")
          ? "#E34850"
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
    context.fillStyle = "#131316";
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

function snapProtocolMarkerToEdge(
  kind: import("../lib/api").AnalyzerProtocolMarker["kind"],
  sample: number,
  edgeSamples: number[],
) {
  if (
    edgeSamples.length === 0 ||
    !["one", "zero", "up_arrow", "down_arrow"].includes(kind)
  ) {
    return sample;
  }
  const nearest = nearestSortedSample(edgeSamples, sample);
  if (nearest === null) return sample;
  // These markers are emitted by the analyzer at a protocol sampling edge.
  // Keep them attached even when the sidecar's integer sample and the graph
  // tile differ by a few samples at very high zoom.
  return nearest;
}

function protocolMarkerEdgeSamples(
  analyzer: UiAnalyzerInstance,
  kind: import("../lib/api").AnalyzerProtocolMarker["kind"],
  channel: WaveformTile["channels"][number] | undefined,
  allEdgeSamples: number[],
) {
  if (!channel) return [];
  const decoderId = analyzer.nativeDecoderId.toLowerCase();
  const analyzerType = analyzer.type.toLowerCase();
  if (
    (kind === "one" || kind === "zero") &&
    (decoderId === "swd" || analyzerType === "swd")
  ) {
    return allEdgeSamples;
  }
  if (kind === "up_arrow" || kind === "down_arrow") {
    const clockProtocol =
      decoderId === "spi" ||
      decoderId === "i2s" ||
      decoderId === "smbus" ||
      analyzerType === "spi" ||
      analyzerType === "i2s" ||
      analyzerType === "smbus";
    if (!clockProtocol) return [];
    return kind === "up_arrow" ? channel.rising_edges : channel.falling_edges;
  }
  return [];
}

function nearestSortedSample(samples: number[], target: number) {
  let low = 0;
  let high = samples.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (samples[middle] < target) low = middle + 1;
    else high = middle;
  }
  const right = samples[low] ?? null;
  const left = low > 0 ? samples[low - 1] : null;
  if (left === null) return right;
  if (right === null) return left;
  return Math.abs(left - target) <= Math.abs(right - target) ? left : right;
}

function crispAnalyzerMarkerX(value: number) {
  return Math.round(value) + 0.5;
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

function multiBubbleText(
  bubble: Pick<AnalyzerBubble, "display_text" | "result_count">,
  widthPx: number,
) {
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
