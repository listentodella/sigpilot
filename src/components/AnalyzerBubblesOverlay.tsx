import { CSSProperties, MouseEvent, useEffect, useMemo, useRef, useState } from "react";
import { AnalyzerFrameRef, AnalyzerTrackWindow, WaveformTile } from "../lib/api";
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
import { useSessionViewport } from "../lib/useSessionViewport";
import { useSessionFrameState } from "../lib/useFrameState";
import { saleaeLegacyChannelColor } from "../lib/saleaeChannelColors";
import { activeUiTheme, activeWaveformThemeColors } from "../lib/themes";
import { SALEAE_ROW_V2_SPACING_PX } from "../lib/saleaeChannelLayout";
import {
  mergeSortedSamples,
  nearestSortedSample,
  visibleAnalyzerMarkerSamples,
  visibleAnalyzerProtocolMarkers,
} from "../lib/analyzerMarkers";
import {
  analyzerBubbleKey,
  paddedAnalyzerBubbleRange,
  type AnalyzerBubbleKeyTrack,
  visibleAnalyzerBubbleKeys,
  visibleAnalyzerBubbleRange,
} from "../lib/analyzerBubbleVisibility";
import { traceAnalyzerPerformance } from "../lib/analyzerPerformance";

const APPROXIMATE_CHARACTER_WIDTH_PX = 6;
const BUBBLE_EDGE_ARROW_WIDTH_PX = 3;
const MAX_MULTI_BUBBLE_COUNT = 99;
const MAX_MULTI_BUBBLE_TEXT_LENGTH = 200;
const EMPTY_EDGE_SAMPLES: number[] = [];
const EMPTY_FORMATTED_BUBBLE_TEXT: string[] = [];
const FORMATTED_BUBBLE_TEXT_CACHE = new WeakMap<string[], Map<string, string[]>>();
const MERGED_EDGE_SAMPLE_CACHE = new WeakMap<WaveformTile["channels"][number], number[]>();
const QUOTED_HEX_LABEL_PATTERN = /^'(.+)'\s+(0x[0-9A-F]+)$/i;

interface AnalyzerBubbleTrack {
  analyzerId: string;
  color: string;
  displayRadix: UiAnalyzerInstance["displayRadix"];
  highlightedFrameIndex: number | null;
  key: string;
  role: AnalyzerChannelRole;
  window: AnalyzerTrackWindow | null;
}

interface AnalyzerMarkerTrack {
  analyzerId: string;
  edgeType: "rising" | "falling";
  key: string;
  role: AnalyzerChannelRole;
}

interface AnalyzerProtocolMarkerTrack {
  analyzerId: string;
  analyzerTypeKey: string;
  channel: number;
  markers: AnalyzerTrackWindow["protocol_markers"];
  nativeDecoderKey: string;
}

interface AnalyzerProtocolMarkerSource {
  analyzerTypeKey: string;
  nativeDecoderKey: string;
}

interface AnalyzerBubbleElementBinding {
  endSample: number;
  element: HTMLButtonElement;
  labels: string[];
  lastDisplay?: string;
  lastOverflowLeft?: boolean;
  lastOverflowRight?: boolean;
  lastText?: string;
  lastTransform?: string;
  lastWidthStyle?: string;
  multi: boolean;
  resultCount: number;
  startSample: number;
  textElement: HTMLElement | null;
}

interface AnalyzerBubblesOverlayProps {
  analyzers: UiAnalyzerInstance[];
  rowHeights: number[];
  rowTopInsets: number[];
  sessionId?: string;
  tile: WaveformTile | null;
  themeRevision?: number;
  viewportSamples: number;
  viewportStart: number;
  visibleChannelIndexes: number[];
  onGoToFrame: (analyzerId: string, frameIndex: number, frame?: AnalyzerFrameRef) => void;
  onOpenTableFrame: (analyzerId: string, frameIndex: number) => void;
  onSelectFrame: (analyzerId: string, frameIndex: number) => void;
  onAnalyzerError?: (message: string) => void;
  onZoomBubble: (analyzerId: string, startSample: number, endSample: number, frameIndex: number) => void;
}

interface BubbleDomViewport {
  samples: number;
  start: number;
}

export function AnalyzerBubblesOverlay({
  analyzers,
  rowHeights,
  rowTopInsets,
  sessionId,
  tile,
  themeRevision = 0,
  viewportSamples: viewportSamplesProp,
  viewportStart: viewportStartProp,
  visibleChannelIndexes,
  onGoToFrame,
  onOpenTableFrame,
  onSelectFrame,
  onZoomBubble,
  onAnalyzerError,
}: AnalyzerBubblesOverlayProps) {
  // Once the workbench has wired this session into the backend frame loop, the
  // analyzer tracks arrive on every frame — already aggregated for the viewport
  // that frame was rendered for. Reading them from the loop is what keeps the
  // bubble aggregation in step with a zoom instead of trailing it by a whole
  // request round trip, which is what made the bubbles look wrong while moving.
  const frameState = useSessionFrameState(sessionId);
  const liveFrame = frameState?.ready ? frameState : null;
  const analyzerErrorMessage = useMemo(
    () => liveFrame?.analyzers.find((result) => result.error)?.error ?? null,
    [liveFrame],
  );
  const reportedAnalyzerErrorRef = useRef<string | null>(null);
  useEffect(() => {
    if (!analyzerErrorMessage || reportedAnalyzerErrorRef.current === analyzerErrorMessage) return;
    reportedAnalyzerErrorRef.current = analyzerErrorMessage;
    onAnalyzerError?.(analyzerErrorMessage);
  }, [analyzerErrorMessage, onAnalyzerError]);
  const effectiveAnalyzers = useMemo(() => {
    if (!liveFrame || liveFrame.analyzers.length === 0) return analyzers;
    // A failed analyzer reports no tracks; keeping the previous ones avoids
    // blanking a row that is still showing its last good bubbles.
    const tracksById = new Map<string, AnalyzerTrackWindow[]>(
      liveFrame.analyzers
        .filter((result) => !result.error)
        .map((result) => [result.analyzer_id, result.tracks] as const),
    );
    return analyzers.map((analyzer) => {
      const tracks = tracksById.get(analyzer.id);
      return tracks ? { ...analyzer, renderedTracks: tracks } : analyzer;
    });
  }, [analyzers, liveFrame]);
  const effectiveTile = liveFrame?.tile ?? tile;

  // The overlay draws its own lightweight preview while the viewport is moving.
  // Reading the live viewport keeps that preview locked to the waveform instead
  // of trailing it by one workbench render.
  const liveViewport = useSessionViewport(sessionId, viewportStartProp, viewportSamplesProp);
  const viewportStart = liveFrame ? liveFrame.view.start_sample : liveViewport.start;
  const viewportSamples = liveFrame ? liveFrame.view.samples : liveViewport.samples;
  const overlayRef = useRef<HTMLDivElement>(null);
  const bubbleElementsRef = useRef(new Map<string, AnalyzerBubbleElementBinding>());
  const visibleBubbleKeysRef = useRef(new Set<string>());
  const callbacksRef = useRef({ onGoToFrame, onOpenTableFrame, onSelectFrame, onZoomBubble });
  callbacksRef.current = { onGoToFrame, onOpenTableFrame, onSelectFrame, onZoomBubble };
  const [overlayWidth, setOverlayWidth] = useState(1);
  const [bubbleDomViewport, setBubbleDomViewport] = useState<BubbleDomViewport>(() => ({
    samples: Math.max(1, viewportSamples),
    start: viewportStart,
  }));
  const [hoveredTrackKey, setHoveredTrackKey] = useState<string | null>(null);
  const rowTops = useMemo(() => {
    let top = 0;
    return rowHeights.map((height) => {
      const current = top;
      top += height + SALEAE_ROW_V2_SPACING_PX;
      return current;
    });
  }, [rowHeights]);
  const bubbleTracks = useStableAnalyzerBubbleTracks(effectiveAnalyzers);
  const bubbleTracksByChannel = useMemo(() => {
    const tracksByChannel = new Map<number, AnalyzerBubbleTrack[]>();
    bubbleTracks.forEach((track) => {
      const tracks = tracksByChannel.get(track.role.channel);
      if (tracks) tracks.push(track);
      else tracksByChannel.set(track.role.channel, [track]);
    });
    return tracksByChannel;
  }, [bubbleTracks]);
  const markerTracks = useStableAnalyzerMarkerTracks(effectiveAnalyzers);
  const protocolMarkerTracks = useStableAnalyzerProtocolMarkerTracks(effectiveAnalyzers);
  const tileChannels = useMemo(
    () => new Map((effectiveTile?.channels ?? []).map((channel) => [channel.channel, channel])),
    [effectiveTile],
  );
  const visibleChannelRows = useMemo(
    () => new Map(visibleChannelIndexes.map((channel, rowIndex) => [channel, rowIndex])),
    [visibleChannelIndexes],
  );
  const nativeMarkerChannels = useMemo(
    () =>
      new Set(
        protocolMarkerTracks.map((track) => `${track.analyzerId}:${track.channel}`),
      ),
    [protocolMarkerTracks],
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

  // `bubbleDomViewport` decides *which* bubbles have an element, and nothing
  // else: geometry and text are written imperatively every frame. Rebuilding the
  // element set is the expensive part, so it is refreshed only once the viewport
  // leaves the comfortable middle of the current window. Freezing it during a
  // gesture — as this used to — is what made the DOM reappear one frame with
  // stale sizes.
  useEffect(() => {
    const samples = Math.max(1, viewportSamples);
    setBubbleDomViewport((current) => {
      const insideMiddle =
        viewportStart >= current.start + current.samples * 0.25 &&
        viewportStart + samples <= current.start + current.samples * 0.75;
      // The window also has to stay at the right scale. Zooming out widens the
      // viewport past a window sized for the old zoom, and any bubble beyond it
      // would have no element until the next refresh — a visible gap.
      const sameScale = Math.abs(samples * 3 - current.samples) <= current.samples * 0.25;
      if (insideMiddle && sameScale) return current;
      // Re-centre with a viewport of padding on each side.
      return { samples: samples * 3, start: viewportStart - samples };
    });
  }, [viewportSamples, viewportStart]);

  useEffect(() => {
    if (!hoveredTrackKey) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      const track = bubbleTracks.find((item) => item.key === hoveredTrackKey);
      if (!track) return;
      const frameWindow = track.window;
      const frame =
        event.key === "ArrowLeft"
          ? frameWindow?.previous_frame_ref ?? frameWindow?.previous_frame ?? null
          : event.key === "ArrowRight"
            ? frameWindow?.next_frame_ref ?? frameWindow?.next_frame ?? null
            : null;
      if (frame === null) return;
      event.preventDefault();
      callbacksRef.current.onGoToFrame(track.analyzerId, frame.frame_id, frame);
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
      const nextVisibleKeys = visibleBubbleElementKeys(
        bubbleTracksByChannel,
        visibleChannelIndexes,
        viewportStart,
        samples,
      );
      const keysToUpdate = new Set(nextVisibleKeys);
      visibleBubbleKeysRef.current.forEach((key) => keysToUpdate.add(key));

      keysToUpdate.forEach((key) => {
        const binding = bubbleElementsRef.current.get(key);
        if (!binding) return;
        const { endSample, element, labels, multi, resultCount, startSample, textElement } = binding;
        if (!nextVisibleKeys.has(key)) {
          if (binding.lastDisplay !== "none") {
            element.style.display = "none";
            binding.lastDisplay = "none";
          }
          return;
        }
        const layout = analyzerBubbleLayout(startSample, endSample, viewportStart, samples, width);
        const { overflowLeft, overflowRight, visible } = layout;
        const display = visible ? "flex" : "none";
        if (binding.lastDisplay !== display) {
          element.style.display = display;
          binding.lastDisplay = display;
        }
        if (!visible) return;
        const bubbleWidth = layout.widthPx;
        const transform = `translate3d(${layout.leftPx}px, 0, 0)`;
        const widthStyle = `${bubbleWidth}px`;
        if (binding.lastTransform !== transform) {
          element.style.transform = transform;
          binding.lastTransform = transform;
        }
        if (binding.lastWidthStyle !== widthStyle) {
          element.style.width = widthStyle;
          binding.lastWidthStyle = widthStyle;
        }
        if (binding.lastOverflowLeft !== overflowLeft) {
          element.classList.toggle("overflowLeft", overflowLeft);
          binding.lastOverflowLeft = overflowLeft;
        }
        if (binding.lastOverflowRight !== overflowRight) {
          element.classList.toggle("overflowRight", overflowRight);
          binding.lastOverflowRight = overflowRight;
        }

        const arrowWidth =
          (overflowLeft ? BUBBLE_EDGE_ARROW_WIDTH_PX : 0) +
          (overflowRight ? BUBBLE_EDGE_ARROW_WIDTH_PX : 0);
        const nextText = multi
          ? multiBubbleTextFromValues(labels, resultCount, bubbleWidth - 28)
          : bestFrameText(labels, bubbleWidth - arrowWidth - 6);
        if (binding.lastText !== nextText) {
          if (textElement) textElement.textContent = nextText;
          binding.lastText = nextText;
        }
      });
      visibleBubbleKeysRef.current = nextVisibleKeys;
      traceAnalyzerPerformance(
        "bubble_dom_update",
        started,
        `elements=${bubbleElementsRef.current.size} visible=${nextVisibleKeys.size} updated=${keysToUpdate.size}`,
      );
    });
    return () => window.cancelAnimationFrame(frame);
  }, [
    overlayWidth,
    viewportSamples,
    viewportStart,
    bubbleTracksByChannel,
    visibleChannelIndexes,
  ]);

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
      const viewSamples = Math.max(1, viewportSamples);
      // Bubbles are always drawn as DOM. Logic has a single rendering path for
      // them, and the canvas preview this replaced was the reason the text sat
      // left-aligned while the viewport moved and snapped to centred once it
      // stopped: the preview and the DOM disagreed about alignment.
      markerTracks.forEach((track) => {
        if (nativeMarkerChannels.has(`${track.analyzerId}:${track.role.channel}`)) return;
        const rowIndex = visibleChannelRows.get(track.role.channel);
        if (rowIndex === undefined) return;
        const channel = tileChannels.get(track.role.channel);
        if (!channel) return;
        const edgeSamples = track.edgeType === "rising" ? channel.rising_edges : channel.falling_edges;
        if (edgeSamples.length === 0) return;
        const inset = Math.max(0, rowTopInsets[rowIndex] ?? 0);
        const trackHeight = Math.max(1, rowHeights[rowIndex] - inset);
        const centerY = rowTops[rowIndex] + inset + trackHeight / 2;
        context.fillStyle = saleaeLegacyChannelColor(track.role.channel);
        context.strokeStyle = context.fillStyle;
        const markerSamples = visibleAnalyzerMarkerSamples(edgeSamples, viewStart, viewSamples, width);
        for (const sample of markerSamples) {
          const left = ((sample - viewStart) / viewSamples) * width;
          drawAnalyzerMarker(context, left, centerY, track.edgeType);
        }
      });
      protocolMarkerTracks.forEach((track) => {
        const rowIndex = visibleChannelRows.get(track.channel);
        if (rowIndex === undefined) return;
        const channel = tileChannels.get(track.channel);
        const inset = Math.max(0, rowTopInsets[rowIndex] ?? 0);
        const trackHeight = Math.max(1, rowHeights[rowIndex] - inset);
        const centerY = rowTops[rowIndex] + inset + trackHeight / 2;
        for (const marker of visibleAnalyzerProtocolMarkers(track.markers, viewStart, viewSamples, width)) {
          const edgeSamples = protocolMarkerEdgeSamples(
            track,
            marker.kind,
            channel,
          );
          const sample = snapProtocolMarkerToEdge(marker.kind, marker.sample, edgeSamples);
          const left = crispAnalyzerMarkerX(((sample - viewStart) / viewSamples) * width);
          drawProtocolMarker(
            context,
            left,
            centerY,
            marker.kind,
            saleaeLegacyChannelColor(track.channel),
          );
        }
      });
      context.restore();
      traceAnalyzerPerformance("marker_canvas_update", started);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [
    bubbleTracksByChannel,
    markerTracks,
    nativeMarkerChannels,
    overlayWidth,
    protocolMarkerTracks,
    rowHeights,
    rowTopInsets,
    rowTops,
    tileChannels,
    viewportSamples,
    viewportStart,
    visibleChannelIndexes,
    visibleChannelRows,
    themeRevision,
  ]);

  const renderedContent = useMemo(
    () => (
      <>
        {visibleChannelIndexes.flatMap((channel, rowIndex) => {
          const channelTracks = bubbleTracksByChannel.get(channel) ?? [];
          return channelTracks.map((track, trackIndex) => {
            const frameWindow = track.window;
            const bubbles = frameWindow?.bubbles ?? [];
            // The window already carries a viewport of padding on each side, so
            // it is used as-is: this decides which bubbles get an element, and
            // nothing about where they sit.
            const [renderStartIndex, renderEndIndex] = paddedAnalyzerBubbleRange(
              bubbles,
              bubbleDomViewport.start,
              bubbleDomViewport.samples,
              0,
            );
            const renderedBubbles = bubbles.slice(renderStartIndex, renderEndIndex);
            const previousFrame = frameWindow?.previous_frame_ref ?? frameWindow?.previous_frame ?? null;
            const nextFrame = frameWindow?.next_frame_ref ?? frameWindow?.next_frame ?? null;
            const previousIndex = previousFrame?.frame_id ?? null;
            const nextIndex = nextFrame?.frame_id ?? null;
            const hovered = hoveredTrackKey === track.key;

            return (
              <div
                className="analyzerBubbleStrip"
                data-analyzer-track={track.key}
                data-bubble-count={bubbles.length}
                data-first-bubble-start={bubbles[0]?.start_sample ?? ""}
                data-last-bubble-end={bubbles[bubbles.length - 1]?.end_sample ?? ""}
                data-rendered-bubble-count={renderedBubbles.length}
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
                {renderedBubbles.map((bubble) => {
                  // Built against the *live* viewport, not the element window.
                  // The window is deliberately wider than the screen, so using
                  // it here would place every bubble at a fraction of its real
                  // position until the update effect ran — a visible flash on
                  // every rebuild.
                  const viewSamples = Math.max(1, viewportSamples);
                  const left = ((bubble.start_sample - viewportStart) / viewSamples) * overlayWidth;
                  const originalBubbleWidth =
                    ((bubble.end_sample - bubble.start_sample) / viewSamples) * overlayWidth;
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
                    track.highlightedFrameIndex !== null &&
                    track.highlightedFrameIndex >= bubble.frame_id_interval.begin &&
                    track.highlightedFrameIndex < bubble.frame_id_interval.end;
                  const arrowWidth =
                    (overflowLeft ? BUBBLE_EDGE_ARROW_WIDTH_PX : 0) +
                    (overflowRight ? BUBBLE_EDGE_ARROW_WIDTH_PX : 0);
                  const formattedDisplayText = formattedBubbleDisplayText(
                    bubble.display_text,
                    track.displayRadix,
                  );
                  const text = multi
                    ? multiBubbleText(formattedDisplayText, bubble.result_count, bubbleWidth - 28)
                    : bestFrameText(formattedDisplayText, bubbleWidth - arrowWidth - 6);
                  const tooltip = multi
                    ? bubbleTooltipText(formattedDisplayText, bubble.result_count, multi, text)
                    : formattedDisplayText[0] ?? "";
                  const bubbleKey = analyzerBubbleKey(track.key, bubble);

                  function handleClick(event: MouseEvent<HTMLButtonElement>) {
                    event.stopPropagation();
                    if (event.metaKey || event.ctrlKey) {
                      callbacksRef.current.onOpenTableFrame(track.analyzerId, firstFrameIndex);
                    } else {
                      callbacksRef.current.onSelectFrame(track.analyzerId, firstFrameIndex);
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
                          track.analyzerId,
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
                        "--analyzer-color": track.color,
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
                    onClick={() =>
                      callbacksRef.current.onGoToFrame(
                        track.analyzerId,
                        previousIndex,
                        previousFrame ?? undefined,
                      )
                    }
                  />
                )}
                {hovered && nextIndex !== null && (
                  <AnalyzerBubbleNavigationButton
                    direction="next"
                    onClick={() =>
                      callbacksRef.current.onGoToFrame(
                        track.analyzerId,
                        nextIndex,
                        nextFrame ?? undefined,
                      )
                    }
                  />
                )}
              </div>
            );
          });
        })}
      </>
    ),
    [
      bubbleTracksByChannel,
      bubbleDomViewport,
      hoveredTrackKey,
      rowTops,
      visibleChannelIndexes,
      // `viewportStart` / `viewportSamples` / `overlayWidth` are read above but
      // deliberately absent here. Listing them would rebuild every bubble
      // element on every frame of a gesture; the update effect rewrites position,
      // width and text imperatively, so the values captured at the last rebuild
      // are only a starting point. They are re-read whenever this memo does run,
      // which is what keeps a rebuild from flashing stale geometry.
    ],
  );

  return (
    <div className="analyzerBubblesOverlay" ref={overlayRef}>
      <canvas className="analyzerMarkersCanvas" aria-hidden="true" />
      <div className="analyzerOverlayTransformLayer">{renderedContent}</div>
    </div>
  );
}

function visibleBubbleElementKeys(
  bubbleTracksByChannel: Map<number, AnalyzerBubbleTrack[]>,
  visibleChannelIndexes: number[],
  viewportStart: number,
  viewportSamples: number,
) {
  const tracks: AnalyzerBubbleKeyTrack[] = [];
  for (const channel of visibleChannelIndexes) {
    for (const track of bubbleTracksByChannel.get(channel) ?? []) {
      tracks.push({
        key: track.key,
        bubbles: track.window?.bubbles ?? [],
      });
    }
  }
  return visibleAnalyzerBubbleKeys(tracks, viewportStart, viewportSamples);
}

function multiBubbleTextFromValues(
  displayText: string[],
  resultCount: number,
  availableWidth: number,
) {
  return multiBubbleText(displayText, resultCount, availableWidth);
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
      ? activeUiTheme().cssVars["--positive"]
      : kind === "stop"
        ? activeUiTheme().cssVars["--yellow"]
        : kind.startsWith("error_")
          ? activeUiTheme().cssVars["--red"]
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
    context.fillStyle = activeWaveformThemeColors().background;
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
  analyzer: AnalyzerProtocolMarkerSource,
  kind: import("../lib/api").AnalyzerProtocolMarker["kind"],
  channel: WaveformTile["channels"][number] | undefined,
) {
  if (!channel) return [];
  if (
    (kind === "one" || kind === "zero") &&
    (analyzer.nativeDecoderKey === "swd" || analyzer.analyzerTypeKey === "swd")
  ) {
    return mergedEdgeSamples(channel);
  }
  if (kind === "up_arrow" || kind === "down_arrow") {
    const clockProtocol =
      analyzer.nativeDecoderKey === "spi" ||
      analyzer.nativeDecoderKey === "i2s" ||
      analyzer.nativeDecoderKey === "smbus" ||
      analyzer.analyzerTypeKey === "spi" ||
      analyzer.analyzerTypeKey === "i2s" ||
      analyzer.analyzerTypeKey === "smbus";
    if (!clockProtocol) return [];
    return kind === "up_arrow" ? channel.rising_edges : channel.falling_edges;
  }
  return [];
}

function mergedEdgeSamples(channel: WaveformTile["channels"][number]) {
  const cached = MERGED_EDGE_SAMPLE_CACHE.get(channel);
  if (cached) return cached;
  const merged = mergeSortedSamples(channel.rising_edges, channel.falling_edges);
  MERGED_EDGE_SAMPLE_CACHE.set(channel, merged);
  return merged;
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

function useStableAnalyzerBubbleTracks(analyzers: UiAnalyzerInstance[]) {
  const cacheRef = useRef<AnalyzerBubbleTrack[] | null>(null);
  return useMemo(() => {
    const next = analyzers.flatMap((analyzer) => {
      const renderedTracksByRole = new Map(
        analyzer.renderedTracks.map((track) => [analyzerTrackRoleKey(track.channel, track.role), track]),
      );
      return analyzerBubbleRoles(analyzer).map((role) => ({
        analyzerId: analyzer.id,
        color: analyzer.color,
        displayRadix: analyzer.displayRadix,
        highlightedFrameIndex: analyzer.highlightedFrameIndex,
        key: `${analyzer.id}:${role.title}:${role.channel}:bubbles`,
        role,
        window: renderedTracksByRole.get(analyzerTrackRoleKey(role.channel, role.title)) ?? null,
      }));
    });
    const cached = cacheRef.current;
    if (cached && analyzerBubbleTracksEqual(cached, next)) return cached;
    cacheRef.current = next;
    return next;
  }, [analyzers]);
}

function analyzerTrackRoleKey(channel: number, role: string) {
  return `${channel}\u0000${role}`;
}

function useStableAnalyzerMarkerTracks(analyzers: UiAnalyzerInstance[]) {
  const cacheRef = useRef<AnalyzerMarkerTrack[] | null>(null);
  return useMemo(() => {
    const next = analyzers.flatMap((analyzer) =>
      analyzerMarkerRoles(analyzer).map((role) => ({
        analyzerId: analyzer.id,
        edgeType: analyzerMarkerEdgeType(analyzer),
        key: `${analyzer.id}:${role.title}:${role.channel}:markers`,
        role,
      })),
    );
    const cached = cacheRef.current;
    if (cached && analyzerMarkerTracksEqual(cached, next)) return cached;
    cacheRef.current = next;
    return next;
  }, [analyzers]);
}

function useStableAnalyzerProtocolMarkerTracks(analyzers: UiAnalyzerInstance[]) {
  const cacheRef = useRef<AnalyzerProtocolMarkerTrack[] | null>(null);
  return useMemo(() => {
    const next = analyzers.flatMap((analyzer) =>
      analyzer.renderedTracks.flatMap((track) => {
        const markers = track.protocol_markers ?? [];
        if (markers.length === 0) return [];
        return [
          {
            analyzerId: analyzer.id,
            analyzerTypeKey: analyzer.type.toLowerCase(),
            channel: track.channel,
            markers,
            nativeDecoderKey: analyzer.nativeDecoderId.toLowerCase(),
          },
        ];
      }),
    );
    const cached = cacheRef.current;
    if (cached && analyzerProtocolMarkerTracksEqual(cached, next)) return cached;
    cacheRef.current = next;
    return next;
  }, [analyzers]);
}

function analyzerBubbleTracksEqual(left: AnalyzerBubbleTrack[], right: AnalyzerBubbleTrack[]) {
  if (left.length !== right.length) return false;
  return left.every((track, index) => {
    const candidate = right[index];
    return Boolean(
      candidate &&
        track.analyzerId === candidate.analyzerId &&
        track.color === candidate.color &&
        track.displayRadix === candidate.displayRadix &&
        track.highlightedFrameIndex === candidate.highlightedFrameIndex &&
        track.key === candidate.key &&
        track.window === candidate.window &&
        analyzerRolesEqual(track.role, candidate.role),
    );
  });
}

function analyzerMarkerTracksEqual(left: AnalyzerMarkerTrack[], right: AnalyzerMarkerTrack[]) {
  if (left.length !== right.length) return false;
  return left.every((track, index) => {
    const candidate = right[index];
    return Boolean(
      candidate &&
        track.analyzerId === candidate.analyzerId &&
        track.edgeType === candidate.edgeType &&
        track.key === candidate.key &&
        analyzerRolesEqual(track.role, candidate.role),
    );
  });
}

function analyzerProtocolMarkerTracksEqual(
  left: AnalyzerProtocolMarkerTrack[],
  right: AnalyzerProtocolMarkerTrack[],
) {
  if (left.length !== right.length) return false;
  return left.every((track, index) => {
    const candidate = right[index];
    return Boolean(
      candidate &&
        track.analyzerId === candidate.analyzerId &&
        track.analyzerTypeKey === candidate.analyzerTypeKey &&
        track.channel === candidate.channel &&
        track.markers === candidate.markers &&
        track.nativeDecoderKey === candidate.nativeDecoderKey,
    );
  });
}

function analyzerRolesEqual(left: AnalyzerChannelRole, right: AnalyzerChannelRole) {
  return (
    left.channel === right.channel &&
    left.hasBubbles === right.hasBubbles &&
    left.hasMarkers === right.hasMarkers &&
    left.title === right.title
  );
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
  let best = "";
  let bestLength = -1;
  let shortest = "";
  let shortestLength = Number.POSITIVE_INFINITY;
  const visit = (candidate: string) => {
    const length = candidate.length;
    if (length * APPROXIMATE_CHARACTER_WIDTH_PX < widthPx && length > bestLength) {
      best = candidate;
      bestLength = length;
    }
    if (length <= shortestLength) {
      shortest = candidate;
      shortestLength = length;
    }
  };
  for (const label of displayText) visitFrameTextCandidates(label, visit);
  return best || shortest;
}

function bestSingleFrameText(label: string, widthPx: number) {
  let best = "";
  let bestLength = -1;
  let shortest = "";
  let shortestLength = Number.POSITIVE_INFINITY;
  visitFrameTextCandidates(label, (candidate) => {
    const length = candidate.length;
    if (length * APPROXIMATE_CHARACTER_WIDTH_PX < widthPx && length > bestLength) {
      best = candidate;
      bestLength = length;
    }
    if (length <= shortestLength) {
      shortest = candidate;
      shortestLength = length;
    }
  });
  return best || shortest;
}

function visitFrameTextCandidates(label: string, visit: (candidate: string) => void) {
  const quoted = label.match(QUOTED_HEX_LABEL_PATTERN);
  visit(label);
  if (quoted) {
    visit(quoted[1]);
    visit(quoted[2]);
  }
}

function multiBubbleText(
  displayText: string[],
  resultCount: number,
  widthPx: number,
) {
  let text = "";
  displayText.forEach((label, index) => {
    if (index > 0) text += "·";
    text += bestSingleFrameText(label, widthPx);
  });
  const suffix = displayText.length < resultCount ? "..." : "";
  const output = `${text}${suffix}`;
  return output.length > MAX_MULTI_BUBBLE_TEXT_LENGTH
    ? `${output.slice(0, MAX_MULTI_BUBBLE_TEXT_LENGTH)}...`
    : output;
}

function bubbleTooltipText(
  displayText: string[],
  resultCount: number,
  multi: boolean,
  bubbleText: string,
) {
  const text = displayText.join("·");
  const output = text || bubbleText;
  const clipped = output.length > 80 ? `${output.slice(0, 80)}...` : output;
  if (multi || resultCount > 1) {
    return `[${resultCount} results] ${clipped}`;
  }
  return clipped;
}

function formattedBubbleDisplayText(
  displayText: string[],
  displayRadix: UiAnalyzerInstance["displayRadix"],
) {
  if (displayText.length === 0) return EMPTY_FORMATTED_BUBBLE_TEXT;
  let cachedByRadix = FORMATTED_BUBBLE_TEXT_CACHE.get(displayText);
  if (!cachedByRadix) {
    cachedByRadix = new Map();
    FORMATTED_BUBBLE_TEXT_CACHE.set(displayText, cachedByRadix);
  }
  const cached = cachedByRadix.get(displayRadix);
  if (cached) return cached;
  const formatted = displayText.map((label) => formatAnalyzerText(label, displayRadix));
  cachedByRadix.set(displayRadix, formatted);
  return formatted;
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
