import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { exactUiSample, type WorkbenchAnnotation } from "../lib/workbench";
import { useSessionViewport } from "../lib/useSessionViewport";

/** Saved range annotations share the document; transient measurements remain separate. */
export function RangeAnnotationsOverlay({ annotations, sessionId, rowHeights, rowTopInsets, visibleChannelIndexes, viewportStart, viewportSamples, busy, onDelete }: {
  annotations: WorkbenchAnnotation[]; sessionId: string; rowHeights: number[]; rowTopInsets: number[]; visibleChannelIndexes: number[];
  viewportStart: number; viewportSamples: number; busy: boolean; onDelete: (id: string) => void;
}) {
  const { t } = useTranslation("annotations");
  const view = useSessionViewport(sessionId, viewportStart, viewportSamples);
  const ranges = annotations.filter((a) => a.kind === "range_annotation" && a.end_sample != null && a.channel != null).map((a) => ({
    annotation: a, start: exactUiSample(a.sample), end: exactUiSample(a.end_sample!), row: visibleChannelIndexes.indexOf(a.channel!),
  })).filter((r) => r.row >= 0 && r.end > view.start && r.start < view.start + view.samples);
  return <div className="waveformRangeAnnotations" style={{ position: "absolute", inset: 0, pointerEvents: "none", overflow: "hidden" }}>
    {ranges.map(({ annotation: a, start, end, row }) => {
      const top = rowHeights.slice(0, row).reduce((sum, h) => sum + h, 0) + (rowTopInsets[row] ?? 0);
      const left = Math.max(0, (start - view.start) / view.samples * 100);
      const right = Math.min(100, (end - view.start) / view.samples * 100);
      return <div key={a.id} data-user-annotation={a.id} data-range-start={a.sample} data-range-end={a.end_sample}
        style={{ position: "absolute", left: `${left}%`, width: `${right - left}%`, top, height: Math.max(24, rowHeights[row] - (rowTopInsets[row] ?? 0)),
          background: `${a.color}18`, borderLeft: `2px solid ${a.color}`, borderRight: `2px solid ${a.color}` } as CSSProperties}>
        <span style={{ display: "inline-flex", maxWidth: "100%", pointerEvents: "auto", background: "var(--surface-color, #24262b)", color: a.color }}
          title={`${t(a.source === "assistant" ? "assistantOwned" : a.source === "analysis_provider" ? "analysisOwned" : "userOwned")}\nD${a.channel} [${a.sample}, ${a.end_sample})\n${a.note}`}>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.title}</span>
          {!busy && <button type="button" aria-label={t("delete")} onClick={(e) => { e.stopPropagation(); onDelete(a.id); }}>×</button>}
        </span>
      </div>;
    })}
  </div>;
}
