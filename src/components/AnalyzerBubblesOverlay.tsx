import { CSSProperties, MouseEvent, useEffect, useMemo, useRef, useState } from "react";
import type { DecodedFrame } from "../lib/api";
import {
  ANALYZER_BUBBLES_PADDING_PX,
  ANALYZER_STRIP_HEIGHT_PX,
  UiAnalyzerInstance,
} from "../lib/analyzers";
import { SALEAE_ROW_V2_SPACING_PX } from "../lib/saleaeChannelLayout";

const APPROXIMATE_CHARACTER_WIDTH_PX = 6;
const BUBBLE_EDGE_ARROW_WIDTH_PX = 3;
const MAX_MULTI_BUBBLE_COUNT = 99;
const MAX_MULTI_BUBBLE_TEXT_LENGTH = 200;
// Ported from Logic 2.4.43 BaseAnalyzerManager.
const MAX_PIXEL_WIDTH_FOR_MERGEABLE_FRAME = 15;
const MAX_PIXELS_BETWEEN_MERGEABLE_FRAMES = 30;

interface AnalyzerBubblesOverlayProps {
  analyzers: UiAnalyzerInstance[];
  rowHeights: number[];
  viewportSamples: number;
  viewportStart: number;
  visibleChannelIndexes: number[];
  onGoToFrame: (analyzerId: string, frameIndex: number) => void;
  onOpenTableFrame: (analyzerId: string, frameIndex: number) => void;
  onSelectFrame: (analyzerId: string, frameIndex: number) => void;
  onZoomFrame: (analyzerId: string, frameIndex: number) => void;
}

interface BubbleGroup {
  endSample: number;
  frames: Array<{ frame: DecodedFrame; frameIndex: number }>;
  startSample: number;
}

export function AnalyzerBubblesOverlay({
  analyzers,
  rowHeights,
  viewportSamples,
  viewportStart,
  visibleChannelIndexes,
  onGoToFrame,
  onOpenTableFrame,
  onSelectFrame,
  onZoomFrame,
}: AnalyzerBubblesOverlayProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const [overlayWidth, setOverlayWidth] = useState(1);
  const [hoveredAnalyzerId, setHoveredAnalyzerId] = useState<string | null>(null);
  const rowTops = useMemo(() => {
    let top = 0;
    return rowHeights.map((height) => {
      const current = top;
      top += height + SALEAE_ROW_V2_SPACING_PX;
      return current;
    });
  }, [rowHeights]);
  const viewportEnd = viewportStart + viewportSamples;

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
    if (!hoveredAnalyzerId) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      const analyzer = analyzers.find((item) => item.id === hoveredAnalyzerId);
      if (!analyzer) return;
      const frameIndex =
        event.key === "ArrowLeft"
          ? analyzer.previousFrame?.frame_id ?? null
          : event.key === "ArrowRight"
            ? analyzer.nextFrame?.frame_id ?? null
            : null;
      if (frameIndex === null) return;
      event.preventDefault();
      onGoToFrame(analyzer.id, frameIndex);
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [analyzers, hoveredAnalyzerId, onGoToFrame, viewportEnd, viewportStart]);

  return (
    <div className="analyzerBubblesOverlay" ref={overlayRef}>
      {visibleChannelIndexes.flatMap((channel, rowIndex) => {
        const channelAnalyzers = analyzers.filter((analyzer) => analyzer.channel === channel);
        return channelAnalyzers.map((analyzer, analyzerIndex) => {
          const groups = groupFramesForViewport(
            analyzer.decodedFrames,
            viewportStart,
            viewportSamples,
            overlayWidth,
          );
          const previousIndex = analyzer.previousFrame?.frame_id ?? null;
          const nextIndex = analyzer.nextFrame?.frame_id ?? null;
          const hovered = hoveredAnalyzerId === analyzer.id;

          return (
            <div
              className="analyzerBubbleStrip"
              key={analyzer.id}
              onMouseEnter={() => setHoveredAnalyzerId(analyzer.id)}
              onMouseLeave={() => setHoveredAnalyzerId((current) => current === analyzer.id ? null : current)}
              style={{
                top: rowTops[rowIndex] + analyzerIndex * ANALYZER_STRIP_HEIGHT_PX + ANALYZER_BUBBLES_PADDING_PX,
              }}
            >
              {groups.map((group) => {
                const originalLeft = ((group.startSample - viewportStart) / Math.max(1, viewportSamples)) * 100;
                const originalRight = ((group.endSample - viewportStart) / Math.max(1, viewportSamples)) * 100;
                const left = Math.max(0, originalLeft);
                const right = Math.min(100, originalRight);
                const width = Math.max(100 / overlayWidth, right - left);
                const widthPx = (width / 100) * overlayWidth;
                const overflowLeft = originalLeft < 0;
                const overflowRight = originalRight > 100;
                const first = group.frames[0];
                const multi = group.frames.length > 1;
                const highlighted = group.frames.some(
                  ({ frameIndex }) => analyzer.highlightedFrameIndex === frameIndex,
                );
                const arrowWidth =
                  (overflowLeft ? BUBBLE_EDGE_ARROW_WIDTH_PX : 0) +
                  (overflowRight ? BUBBLE_EDGE_ARROW_WIDTH_PX : 0);
                const text = multi
                  ? multiBubbleText(group.frames.map(({ frame }) => frame), widthPx - 28)
                  : bestFrameText(first.frame.label, widthPx - arrowWidth - 6);
                const tooltip = multi
                  ? `[${group.frames.length} results] ${group.frames.map(({ frame }) => frame.label).join("·").slice(0, 80)}${group.frames.map(({ frame }) => frame.label).join("·").length > 80 ? "..." : ""}`
                  : first.frame.label;

                function handleClick(event: MouseEvent<HTMLButtonElement>) {
                  event.stopPropagation();
                  if (event.metaKey || event.ctrlKey) {
                    onOpenTableFrame(analyzer.id, first.frameIndex);
                  } else {
                    onSelectFrame(analyzer.id, first.frameIndex);
                  }
                }

                return (
                  <button
                    className={`analyzerBubble ${multi ? "multi" : ""} ${highlighted ? "highlighted" : ""} ${overflowLeft ? "overflowLeft" : ""} ${overflowRight ? "overflowRight" : ""}`}
                    key={`${group.startSample}-${first.frameIndex}`}
                    onClick={handleClick}
                    onDoubleClick={(event) => {
                      event.stopPropagation();
                      onZoomFrame(analyzer.id, first.frameIndex);
                    }}
                    style={{
                      left: `${left}%`,
                      width: `${width}%`,
                      "--analyzer-color": analyzer.color,
                    } as CSSProperties}
                    title={`${tooltip}\n${navigator.platform.includes("Mac") ? "⌘" : "Ctrl"}+click to scroll to table row`}
                    type="button"
                  >
                    {!multi && overflowLeft && <span className="analyzerBubbleArrow left" />}
                    {multi && (
                      <span className="analyzerBubbleCounter">
                        {group.frames.length > MAX_MULTI_BUBBLE_COUNT ? `${MAX_MULTI_BUBBLE_COUNT}+` : group.frames.length}
                      </span>
                    )}
                    <span className="analyzerBubbleText">{text}</span>
                    {!multi && overflowRight && <span className="analyzerBubbleArrow right" />}
                  </button>
                );
              })}

              {hovered && previousIndex !== null && (
                <AnalyzerBubbleNavigationButton
                  direction="previous"
                  onClick={() => onGoToFrame(analyzer.id, previousIndex)}
                />
              )}
              {hovered && nextIndex !== null && (
                <AnalyzerBubbleNavigationButton
                  direction="next"
                  onClick={() => onGoToFrame(analyzer.id, nextIndex)}
                />
              )}
            </div>
          );
        });
      })}
    </div>
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

function groupFramesForViewport(
  frames: DecodedFrame[],
  viewportStart: number,
  viewportSamples: number,
  overlayWidth: number,
) {
  const viewportEnd = viewportStart + viewportSamples;
  const visible = frames
    .map((frame, frameIndex) => ({ frame, frameIndex: frame.frame_id ?? frameIndex }))
    .filter(({ frame }) => frame.end_sample >= viewportStart && frame.start_sample <= viewportEnd);
  const groups: BubbleGroup[] = [];

  visible.forEach((entry) => {
    const widthPx =
      ((entry.frame.end_sample - entry.frame.start_sample) / Math.max(1, viewportSamples)) * overlayWidth;
    const previous = groups[groups.length - 1];
    const previousFrame = previous?.frames[previous.frames.length - 1]?.frame;
    const gapPx = previous
      ? ((entry.frame.start_sample - previous.endSample) / Math.max(1, viewportSamples)) * overlayWidth
      : Number.POSITIVE_INFINITY;
    const previousWidthPx = previousFrame
      ? ((previousFrame.end_sample - previousFrame.start_sample) / Math.max(1, viewportSamples)) * overlayWidth
      : Number.POSITIVE_INFINITY;
    const shouldMerge =
      Boolean(previous) &&
      widthPx <= MAX_PIXEL_WIDTH_FOR_MERGEABLE_FRAME &&
      previousWidthPx <= MAX_PIXEL_WIDTH_FOR_MERGEABLE_FRAME &&
      gapPx <= MAX_PIXELS_BETWEEN_MERGEABLE_FRAMES;

    if (previous && shouldMerge) {
      previous.frames.push(entry);
      previous.endSample = Math.max(previous.endSample, entry.frame.end_sample);
    } else {
      groups.push({
        endSample: entry.frame.end_sample,
        frames: [entry],
        startSample: entry.frame.start_sample,
      });
    }
  });
  return groups;
}

function bestFrameText(label: string, widthPx: number) {
  const quoted = label.match(/^'(.+)'\s+(0x[0-9A-F]+)$/i);
  const candidates = quoted ? [label, quoted[1], quoted[2]] : [label];
  const sorted = [...candidates].sort((left, right) => right.length - left.length);
  return (
    sorted.find((candidate) => candidate.length * APPROXIMATE_CHARACTER_WIDTH_PX < widthPx) ??
    sorted[sorted.length - 1] ??
    ""
  );
}

function multiBubbleText(frames: DecodedFrame[], widthPx: number) {
  const text = frames.map((frame) => bestFrameText(frame.label, widthPx)).join("·");
  return text.length > MAX_MULTI_BUBBLE_TEXT_LENGTH
    ? `${text.slice(0, MAX_MULTI_BUBBLE_TEXT_LENGTH)}...`
    : text;
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
