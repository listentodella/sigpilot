import { CSSProperties, MouseEvent, useEffect, useMemo, useRef, useState } from "react";
import type { AnalyzerBubble } from "../lib/api";
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

interface AnalyzerBubblesOverlayProps {
  analyzers: UiAnalyzerInstance[];
  rowHeights: number[];
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
  viewportSamples,
  viewportStart,
  visibleChannelIndexes,
  onGoToFrame,
  onOpenTableFrame,
  onSelectFrame,
  onZoomBubble,
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
          const bubbles = analyzer.protocolBubbles.filter(
            (bubble) => bubble.end_sample >= viewportStart && bubble.start_sample <= viewportEnd,
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
              {bubbles.map((bubble) => {
                const left = ((bubble.start_sample - viewportStart) / Math.max(1, viewportSamples)) * overlayWidth;
                const originalBubbleWidth =
                  ((bubble.end_sample - bubble.start_sample) / Math.max(1, viewportSamples)) * overlayWidth;
                const right = left + originalBubbleWidth;
                if (right < 0 || left > overlayWidth) return null;

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
                const text = multi
                  ? multiBubbleText(bubble, bubbleWidth - 28)
                  : bestFrameText(bubble.display_text, bubbleWidth - arrowWidth - 6);
                const tooltip = multi
                  ? bubbleTooltipText(bubble, text)
                  : bubble.display_text[0] ?? "";

                function handleClick(event: MouseEvent<HTMLButtonElement>) {
                  event.stopPropagation();
                  if (event.metaKey || event.ctrlKey) {
                    onOpenTableFrame(analyzer.id, firstFrameIndex);
                  } else {
                    onSelectFrame(analyzer.id, firstFrameIndex);
                  }
                }

                return (
                  <button
                    className={`analyzerBubble ${multi ? "multi" : ""} ${highlighted ? "highlighted" : ""} ${overflowLeft ? "overflowLeft" : ""} ${overflowRight ? "overflowRight" : ""}`}
                    key={`${bubble.start_sample}-${bubble.frame_id_interval.begin}-${bubble.frame_id_interval.end}`}
                    onClick={handleClick}
                    onDoubleClick={(event) => {
                      event.stopPropagation();
                      onZoomBubble(analyzer.id, bubble.start_sample, bubble.end_sample, firstFrameIndex);
                    }}
                    style={{
                      left: Math.max(left, 0),
                      width: bubbleWidth,
                      "--analyzer-color": analyzer.color,
                    } as CSSProperties}
                    title={`${tooltip}\n${navigator.platform.includes("Mac") ? "⌘" : "Ctrl"}+click to scroll to table row`}
                    type="button"
                  >
                    {!multi && overflowLeft && <span className="analyzerBubbleArrow left" />}
                    {multi && (
                      <span className="analyzerBubbleCounter">
                        {bubble.result_count > MAX_MULTI_BUBBLE_COUNT ? `${MAX_MULTI_BUBBLE_COUNT}+` : bubble.result_count}
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
