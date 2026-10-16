import { ChevronLeft, ChevronRight, Copy, Table2 } from "lucide-react";
import { CSSProperties, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatAnalyzerText, type UiAnalyzerInstance } from "../lib/analyzers";
import {
  analyzerFrameDetailKey,
  findAnalyzerDecodedFrame,
  formatAnalyzerFrameSeconds,
  type AnalyzerFrameDetail as AnalyzerFrameDetailData,
  type AnalyzerFrameDetailNeighbors,
} from "../lib/analyzerFrameDetail";
import type { DecodedFrame } from "../lib/api";

/**
 * Read-only panel for the selected analyzer frame. The bubbles on the waveform
 * can only render a heuristic prefix of a frame label, so the full text lives
 * here: wrapped, scrollable and selectable, with navigation between frames.
 */
export function AnalyzerFrameDetail({
  analyzer,
  detail,
  neighbors,
  onOpenInTable,
  onSelectFrame,
  sampleRateHz,
}: {
  analyzer: UiAnalyzerInstance | null;
  detail: AnalyzerFrameDetailData | null;
  neighbors: AnalyzerFrameDetailNeighbors;
  onOpenInTable: (analyzerId: string, frameIndex: number) => void;
  onSelectFrame: (analyzerId: string, frameIndex: number, frame?: DecodedFrame) => void;
  sampleRateHz: number;
}) {
  const { t } = useTranslation("analyzers");
  const [copiedKey, setCopiedKey] = useState("");
  const copiedTimerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
    },
    [],
  );

  if (!detail) return null;

  const frame = detail.frame;
  const detailKey = analyzerFrameDetailKey(detail.analyzerId, detail.frameIndex);
  const copied = copiedKey === detailKey;
  const analyzerName = analyzer?.name ?? detail.analyzerId;
  const displayRadix = analyzer?.displayRadix ?? "Hexadecimal";
  const sampleRate = Math.max(1, sampleRateHz);
  const previousFrame =
    neighbors.previousIndex === null
      ? null
      : findAnalyzerDecodedFrame(analyzer?.decodedFrames ?? [], neighbors.previousIndex);
  const nextFrame =
    neighbors.nextIndex === null
      ? null
      : findAnalyzerDecodedFrame(analyzer?.decodedFrames ?? [], neighbors.nextIndex);

  const selectNeighbor = (frameIndex: number, frameAtIndex: DecodedFrame | null) => {
    onSelectFrame(detail.analyzerId, frameIndex, frameAtIndex ?? undefined);
  };

  const copyFrameText = () => {
    void navigator.clipboard
      ?.writeText(frame.label)
      .then(() => {
        setCopiedKey(detailKey);
        if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
        copiedTimerRef.current = window.setTimeout(() => {
          copiedTimerRef.current = null;
          setCopiedKey((current) => (current === detailKey ? "" : current));
        }, 1200);
      })
      .catch(() => {
        setCopiedKey("");
      });
  };

  return (
    <div
      aria-label={t("frameDetail")}
      className="analyzerFrameDetail"
      style={{ "--analyzer-color": analyzer?.color ?? "var(--border-20)" } as CSSProperties}
    >
      <div className="analyzerFrameDetailHeader">
        <span className="decodeAnalyzerDot" title={analyzerName} />
        <span className="analyzerFrameDetailName" title={analyzerName}>
          {analyzerName}
        </span>
        <span className="analyzerFrameDetailNumber">#{detail.frameNumber}</span>
        {frame.frame_type ? (
          <span className="analyzerFrameDetailType" title={frame.frame_type}>
            {frame.frame_type}
          </span>
        ) : null}
        <div className="analyzerFrameDetailActions">
          <button
            aria-label={copied ? t("copied") : t("copyFrameText")}
            onClick={copyFrameText}
            title={copied ? t("copied") : t("copyFrameText")}
            type="button"
          >
            <Copy size={12} />
          </button>
          <button
            aria-label={t("previousFrame")}
            disabled={neighbors.previousIndex === null}
            onClick={() => {
              if (neighbors.previousIndex !== null) selectNeighbor(neighbors.previousIndex, previousFrame);
            }}
            title={t("previousFrame")}
            type="button"
          >
            <ChevronLeft size={13} />
          </button>
          <button
            aria-label={t("nextFrame")}
            disabled={neighbors.nextIndex === null}
            onClick={() => {
              if (neighbors.nextIndex !== null) selectNeighbor(neighbors.nextIndex, nextFrame);
            }}
            title={t("nextFrame")}
            type="button"
          >
            <ChevronRight size={13} />
          </button>
          <button
            aria-label={t("openInTable")}
            onClick={() => onOpenInTable(detail.analyzerId, detail.frameIndex)}
            title={t("openInTable")}
            type="button"
          >
            <Table2 size={12} />
          </button>
        </div>
      </div>
      <div className="analyzerFrameDetailMeta">
        <span className="analyzerFrameDetailMetaItem">
          <span className="analyzerFrameDetailMetaLabel">{t("start")}</span>
          <span className="analyzerFrameDetailMetaValue">
            {formatAnalyzerFrameSeconds(frame.start_sample / sampleRate)}
          </span>
        </span>
        <span className="analyzerFrameDetailMetaItem">
          <span className="analyzerFrameDetailMetaLabel">{t("duration")}</span>
          <span className="analyzerFrameDetailMetaValue">
            {formatAnalyzerFrameSeconds((frame.end_sample - frame.start_sample) / sampleRate)}
          </span>
        </span>
        <span className="analyzerFrameDetailMetaItem">
          <span className="analyzerFrameDetailMetaLabel">{t("startSample")}</span>
          <span className="analyzerFrameDetailMetaValue">{frame.start_sample}</span>
        </span>
      </div>
      <div className="analyzerFrameDetailText">{frame.label}</div>
      {frame.channel_values.length > 0 ? (
        <div className="analyzerFrameDetailChannels">
          {frame.channel_values.map((value) => (
            <span className="analyzerFrameDetailChannel" key={`${value.channel}-${value.role}`}>
              <span className="analyzerFrameDetailChannelRole">{value.role}</span>
              <span className="analyzerFrameDetailChannelValue">
                {formatAnalyzerText(value.label, displayRadix, value.value)}
              </span>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
