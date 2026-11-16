import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { WaveformAnnotation } from "../lib/api";
import { WAVEFORM_ANNOTATION_COLORS, WAVEFORM_ANNOTATION_NOTE_LIMIT, WAVEFORM_ANNOTATION_SHAPES, WAVEFORM_ANNOTATION_TITLE_LIMIT } from "../lib/waveformAnnotations";
import { formatTimingMarkerSeconds } from "../lib/timingMarkers";
import { WaveformAnnotationIcon } from "./WaveformAnnotationsOverlay";

interface WaveformAnnotationEditorProps {
  annotation: WaveformAnnotation;
  isNew: boolean;
  channelLabel: string;
  totalSamples: number;
  sampleRateHz: number;
  onSave: (annotation: WaveformAnnotation) => void;
  onDelete: () => void;
  onClose: () => void;
}

const shapeKeys = { flag: "shapeFlag", diamond: "shapeDiamond", warning: "shapeWarning", cross: "shapeCross", dot: "shapeDot", square: "shapeSquare" } as const;

export function WaveformAnnotationEditor({ annotation, isNew, channelLabel, totalSamples, sampleRateHz, onSave, onDelete, onClose }: WaveformAnnotationEditorProps) {
  const { t } = useTranslation("annotations");
  const [draft, setDraft] = useState(annotation);
  const [sampleText, setSampleText] = useState(String(annotation.sample));
  const [submitted, setSubmitted] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const sample = Number(sampleText);
  const validSample = sampleText.trim() !== "" && Number.isSafeInteger(sample) && sample >= 0 && sample < totalSamples;
  const validTitle = draft.title.trim().length > 0;

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    titleRef.current?.focus(); titleRef.current?.select();
    function keydown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault(); event.stopImmediatePropagation(); closeRef.current(); return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex="0"]') ?? []);
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
    document.addEventListener("keydown", keydown, true);
    return () => { document.removeEventListener("keydown", keydown, true); if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);

  return createPortal(<div className="waveformAnnotationBackdrop" data-user-annotation-editor="true"
    onPointerDown={(event) => { event.stopPropagation(); if (event.target === event.currentTarget) onClose(); }}
    onKeyDown={(event) => event.stopPropagation()}>
    <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="waveform-annotation-editor-title" className="waveformAnnotationEditor" data-testid="annotation-editor">
      <header><div><span className="waveformAnnotationSource">{t(annotation.source === "assistant" ? "assistantOwned" : annotation.source === "analysis_provider" ? "analysisOwned" : "userOwned")}</span><h2 id="waveform-annotation-editor-title">{t(isNew ? "addTitle" : "editTitle")}</h2></div>
        <button type="button" aria-label={t("close")} onClick={onClose}><X aria-hidden size={16} /></button></header>
      <form noValidate onSubmit={(event) => {
        event.preventDefault(); setSubmitted(true);
        if (validTitle && validSample) onSave({ ...draft, title: draft.title.trim(), sample });
      }}>
        <div className="waveformAnnotationAnchor">{t("anchor", { channel: annotation.channel, label: channelLabel })} · {formatTimingMarkerSeconds(sample / Math.max(1, sampleRateHz))}</div>
        <label>{t("title")}<input ref={titleRef} value={draft.title} maxLength={WAVEFORM_ANNOTATION_TITLE_LIMIT} placeholder={t("titlePlaceholder")}
          aria-invalid={submitted && !validTitle} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></label>
        {submitted && !validTitle && <p className="waveformAnnotationError" role="alert">{t("titleRequired")}</p>}
        <fieldset><legend>{t("shape")}</legend><div className="waveformAnnotationShapes">
          {WAVEFORM_ANNOTATION_SHAPES.map((shape) => <button key={shape} type="button" aria-pressed={draft.shape === shape} onClick={() => setDraft({ ...draft, shape })}>
            <WaveformAnnotationIcon shape={shape} color={draft.color} /><span>{t(shapeKeys[shape])}</span>
          </button>)}
        </div></fieldset>
        <div className="waveformAnnotationColorRow"><span>{t("color")}</span>
          {WAVEFORM_ANNOTATION_COLORS.map((color) => <button key={color} type="button" className="waveformAnnotationSwatch" aria-label={color} aria-pressed={draft.color.toLowerCase() === color} style={{ background: color }} onClick={() => setDraft({ ...draft, color })} />)}
          <input aria-label={t("color")} type="color" value={draft.color} onChange={(event) => setDraft({ ...draft, color: event.target.value })} />
        </div>
        <label>{t("sample")}<input type="number" min={0} max={totalSamples - 1} step={1} value={sampleText} aria-invalid={submitted && !validSample} onChange={(event) => setSampleText(event.target.value)} /></label>
        {submitted && !validSample && <p className="waveformAnnotationError" role="alert">{t("sampleInvalid")}</p>}
        <label>{t("note")}<textarea value={draft.note} maxLength={WAVEFORM_ANNOTATION_NOTE_LIMIT} rows={3} placeholder={t("notePlaceholder")} onChange={(event) => setDraft({ ...draft, note: event.target.value })} /></label>
        <p className="waveformAnnotationHelp">{t("help")}</p>
        <footer>{!isNew && <button type="button" className="waveformAnnotationDelete" onClick={onDelete}>{t("delete")}</button>}
          <span /><button type="button" onClick={onClose}>{t("cancel")}</button><button type="submit" className="primary">{t("save")}</button>
        </footer>
      </form>
    </div>
  </div>, document.body);
}
