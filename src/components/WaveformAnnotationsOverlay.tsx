import { Pencil, Trash2 } from "lucide-react";
import { CSSProperties, PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { WaveformAnnotation } from "../lib/api";
import { drawWaveformAnnotationIcon } from "../lib/waveformAnnotationDrawing";
import { layoutWaveformAnnotations, waveformAnnotationDragSample, type WaveformAnnotationShape } from "../lib/waveformAnnotations";
import { formatTimingMarkerSeconds } from "../lib/timingMarkers";
import { useSessionViewport } from "../lib/useSessionViewport";
import { useSessionFrameState } from "../lib/useFrameState";

export function WaveformAnnotationIcon({ shape, color }: { shape: WaveformAnnotationShape; color: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = canvas.height = Math.round(18 * dpr);
    const context = canvas.getContext("2d");
    if (!context) return;
    context.scale(dpr, dpr);
    drawWaveformAnnotationIcon(context, shape, color);
  }, [shape, color]);
  return <canvas ref={ref} className="waveformAnnotationIcon" width={18} height={18} aria-hidden="true" />;
}

interface AnnotationDrag {
  editToken?: string;
  id: string;
  pointerId: number;
  initialSample: number;
  initialX: number;
  width: number;
  samples: number;
  moved: boolean;
  sample: number;
}

interface WaveformAnnotationsOverlayProps {
  editToken?: string;
  annotations: WaveformAnnotation[];
  selectedId: string | null;
  sessionId: string;
  rowHeights: number[];
  rowTopInsets: number[];
  visibleChannelIndexes: number[];
  viewportStart: number;
  viewportSamples: number;
  totalSamples: number;
  sampleRateHz: number;
  busy: boolean;
  onSelect: (id: string | null) => void;
  onEdit: (annotation: WaveformAnnotation) => void;
  onMove: (id: string, sample: number, token?: string) => void;
  onDelete: (id: string) => void;
}

/** User-owned data only. Decoder frames are never read or mutated here. */
export function WaveformAnnotationsOverlay({ annotations, selectedId, sessionId, rowHeights, rowTopInsets, visibleChannelIndexes, viewportStart, viewportSamples, totalSamples, sampleRateHz, busy, editToken, onSelect, onEdit, onMove, onDelete }: WaveformAnnotationsOverlayProps) {
  const { t } = useTranslation("annotations");
  const rootRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<AnnotationDrag | null>(null);
  const [width, setWidth] = useState(1);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ id: string; sample: number } | null>(null);
  const live = useSessionFrameState(sessionId);
  const viewport = useSessionViewport(sessionId, viewportStart, viewportSamples);
  const start = live?.view.start_sample ?? viewport.start;
  const samples = live?.view.samples ?? viewport.samples;
  const callbacks = useRef({ onSelect, onEdit, onMove, onDelete, annotations, selectedId, busy });
  callbacks.current = { onSelect, onEdit, onMove, onDelete, annotations, selectedId, busy };

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const update = () => setWidth(Math.max(1, root.clientWidth));
    const observer = new ResizeObserver(update);
    observer.observe(root);
    update();
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    function outside(event: PointerEvent) {
      if ((event.target as Element | null)?.closest?.("[data-user-annotation], [data-user-annotation-editor]")) return;
      callbacks.current.onSelect(null);
      setHoveredId(null);
    }
    function keydown(event: KeyboardEvent) {
      const state = callbacks.current;
      if (!state.selectedId || state.busy || (event.target as Element | null)?.closest?.('input, textarea, select, [contenteditable="true"], [data-user-annotation-editor]')) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const annotation = state.annotations.find((item) => item.id === state.selectedId);
      if (!annotation || !["Delete", "Backspace", "Enter", "Escape"].includes(event.key)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.key === "Escape") state.onSelect(null);
      else if (event.key === "Enter") state.onEdit(annotation);
      else state.onDelete(annotation.id);
    }
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", keydown, true);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", keydown, true);
      dragRef.current = null;
    };
  }, []);

  const displayedAnnotations = useMemo(() => preview ? annotations.map((item) => item.id === preview.id ? { ...item, sample: preview.sample } : item) : annotations, [annotations, preview]);
  const layouts = useMemo(() => layoutWaveformAnnotations(displayedAnnotations, visibleChannelIndexes, rowHeights, rowTopInsets, start, samples, width, selectedId), [displayedAnnotations, visibleChannelIndexes, rowHeights, rowTopInsets, start, samples, width, selectedId]);

  function startDrag(annotation: WaveformAnnotation, event: ReactPointerEvent<HTMLButtonElement>) {
    event.stopPropagation();
    if (event.button !== 0 || busy) return;
    event.preventDefault();
    onSelect(annotation.id);
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { id: annotation.id, editToken, pointerId: event.pointerId, initialSample: annotation.sample, initialX: event.clientX, width, samples, moved: false, sample: annotation.sample };
  }
  function moveDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    const drag = dragRef.current;
    if (!drag || event.pointerId !== drag.pointerId) return;
    event.stopPropagation();
    if (!drag.moved && Math.abs(event.clientX - drag.initialX) < 3) return;
    drag.moved = true;
    drag.sample = waveformAnnotationDragSample(drag.initialSample, event.clientX - drag.initialX, drag.width, drag.samples, totalSamples);
    setPreview({ id: drag.id, sample: drag.sample });
    setHoveredId(null);
  }
  function finishDrag(event: ReactPointerEvent<HTMLButtonElement>, commit: boolean) {
    const drag = dragRef.current;
    if (!drag || event.pointerId !== drag.pointerId) return;
    event.stopPropagation();
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setPreview(null);
    if (commit && drag.moved && drag.sample !== drag.initialSample && !busy) onMove(drag.id, drag.sample, drag.editToken);
  }
  function passWheel(event: ReactWheelEvent<HTMLDivElement>) {
    const host = rootRef.current?.parentElement?.querySelector<HTMLElement>(".waveformCanvasHost");
    if (!host) return;
    event.preventDefault(); event.stopPropagation();
    const source = event.nativeEvent;
    host.dispatchEvent(new WheelEvent("wheel", {
      bubbles: true, cancelable: true, clientX: source.clientX, clientY: source.clientY,
      deltaX: source.deltaX, deltaY: source.deltaY, deltaZ: source.deltaZ, deltaMode: source.deltaMode,
      ctrlKey: source.ctrlKey, metaKey: source.metaKey, shiftKey: source.shiftKey, altKey: source.altKey,
    }));
  }

  return <div ref={rootRef} className="waveformAnnotationsOverlay" data-testid="waveform-annotations">
    {layouts.map((layout) => {
      const item = layout.annotation;
      const selected = item.id === selectedId;
      const tooltipWidth = Math.min(280, Math.max(100, width - 16));
      const tooltipLeft = Math.max(8, Math.min(layout.x + 14, width - tooltipWidth - 8)) - layout.x;
      return <div key={item.id} data-user-annotation={item.id} data-annotation-sample={item.sample} data-annotation-channel={item.channel}
        className={`waveformAnnotation ${selected ? "selected" : ""} ${preview?.id === item.id ? "dragging" : ""} ${layout.titleSide}`}
        style={{ left: layout.x, top: layout.y, "--annotation-color": item.color } as CSSProperties}
        onMouseEnter={() => setHoveredId(item.id)} onMouseLeave={() => setHoveredId(null)} onWheel={passWheel}>
        <span className="waveformAnnotationStem" style={{ height: layout.stemHeight }} />
        <button type="button" className="waveformAnnotationButton" aria-pressed={selected}
          aria-label={t("annotationAria", { title: item.title, channel: item.channel, sample: item.sample })}
          aria-describedby={hoveredId === item.id ? `annotation-note-${item.id}` : undefined}
          onClick={(event) => { event.stopPropagation(); onSelect(item.id); }}
          onPointerDown={(event) => startDrag(item, event)} onPointerMove={moveDrag}
          onPointerUp={(event) => finishDrag(event, true)} onPointerCancel={(event) => finishDrag(event, false)}
          onLostPointerCapture={(event) => finishDrag(event, false)}
          onDoubleClick={(event) => { event.stopPropagation(); if (!busy) onEdit(item); }}
          onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); if (!busy) onEdit(item); }}>
          <WaveformAnnotationIcon shape={item.shape} color={item.color} />
          {layout.titleWidth > 0 && <span className="waveformAnnotationTitle" style={{ maxWidth: layout.titleWidth }}>{item.title}</span>}
        </button>
        {selected && !busy && !preview && <div className="waveformAnnotationActions" onPointerDown={(event) => event.stopPropagation()}>
          <button type="button" aria-label={t("edit")} title={t("edit")} onClick={(event) => { event.stopPropagation(); onEdit(item); }}><Pencil aria-hidden size={12} /></button>
          <button type="button" aria-label={t("delete")} title={t("delete")} onClick={(event) => { event.stopPropagation(); onDelete(item.id); }}><Trash2 aria-hidden size={12} /></button>
        </div>}
        {hoveredId === item.id && !preview && <div id={`annotation-note-${item.id}`} role="tooltip" className="waveformAnnotationTooltip" style={{ left: tooltipLeft, width: tooltipWidth }}>
          <span className="waveformAnnotationSource">{t(item.source === "assistant" ? "assistantOwned" : item.source === "analysis_provider" ? "analysisOwned" : "userOwned")}</span>
          <strong>{item.title}</strong>
          <span>{t("tooltipPosition", { channel: item.channel, sample: item.sample, time: formatTimingMarkerSeconds(item.sample / Math.max(1, sampleRateHz)) })}</span>
          {item.note && <p>{item.note}</p>}
        </div>}
      </div>;
    })}
  </div>;
}
