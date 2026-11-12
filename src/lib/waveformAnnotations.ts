import type { WaveformAnnotation } from "./api";
import { getSaleaeGraphChannelLayout } from "./saleaeGraphLayout.ts";

export const WAVEFORM_ANNOTATION_SHAPES = ["flag", "diamond", "warning", "cross", "dot", "square"] as const;
export const WAVEFORM_ANNOTATION_COLORS = ["#53a9fd", "#af92fb", "#58c667", "#ffb45b", "#ff6d7f", "#d4d4d4"] as const;
export const WAVEFORM_ANNOTATION_TITLE_LIMIT = 80;
export const WAVEFORM_ANNOTATION_NOTE_LIMIT = 4_000;
export type WaveformAnnotationShape = (typeof WAVEFORM_ANNOTATION_SHAPES)[number];

/** Imported project data is untrusted; bad entries must not break a capture. */
export function normalizeWaveformAnnotations(input: unknown, totalSamples: number, channelCount: number): WaveformAnnotation[] {
  if (!Array.isArray(input) || !Number.isFinite(totalSamples) || totalSamples <= 0) return [];
  const ids = new Set<string>();
  const annotations: WaveformAnnotation[] = [];
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    if (typeof row.id !== "string" || !row.id.trim() || ids.has(row.id)) continue;
    if (!Number.isSafeInteger(row.sample) || (row.sample as number) < 0 || (row.sample as number) >= totalSamples) continue;
    if (!Number.isInteger(row.channel) || (row.channel as number) < 0 || (row.channel as number) >= channelCount || (row.channel as number) > 255) continue;
    if (!WAVEFORM_ANNOTATION_SHAPES.includes(row.shape as WaveformAnnotationShape)) continue;
    if (typeof row.color !== "string" || !/^#[0-9a-f]{6}$/i.test(row.color)) continue;
    const title = typeof row.title === "string" ? row.title.trim().slice(0, WAVEFORM_ANNOTATION_TITLE_LIMIT) : "";
    if (!title) continue;
    ids.add(row.id);
    annotations.push({
      id: row.id, sample: row.sample as number, channel: row.channel as number,
      shape: row.shape as WaveformAnnotationShape, color: row.color, title,
      note: typeof row.note === "string" ? row.note.slice(0, WAVEFORM_ANNOTATION_NOTE_LIMIT) : "",
    });
  }
  return annotations;
}

export function clampWaveformAnnotationSample(sample: number, totalSamples: number): number {
  if (!Number.isFinite(sample) || !Number.isFinite(totalSamples)) return 0;
  return Math.max(0, Math.min(Math.max(0, Math.floor(totalSamples) - 1), Math.round(sample)));
}

export function trimWaveformAnnotations(annotations: WaveformAnnotation[], trimStart: number, remainingSamples: number): WaveformAnnotation[] {
  const end = trimStart + remainingSamples;
  return annotations.filter((item) => item.sample >= trimStart && item.sample < end)
    .map((item) => ({ ...item, sample: item.sample - trimStart }));
}

export function waveformAnnotationDragSample(initialSample: number, deltaX: number, width: number, viewportSamples: number, totalSamples: number): number {
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(viewportSamples)) return clampWaveformAnnotationSample(initialSample, totalSamples);
  return clampWaveformAnnotationSample(initialSample + deltaX / width * viewportSamples, totalSamples);
}

export interface WaveformAnnotationLayout {
  annotation: WaveformAnnotation;
  x: number;
  y: number;
  stemHeight: number;
  titleWidth: number;
  titleSide: "left" | "right";
}

export function layoutWaveformAnnotations(
  annotations: WaveformAnnotation[], channels: number[], rowHeights: number[], rowTopInsets: number[],
  viewportStart: number, viewportSamples: number, width: number, selectedId: string | null,
): WaveformAnnotationLayout[] {
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(viewportSamples) || viewportSamples <= 0) return [];
  const rows = getSaleaeGraphChannelLayout(rowHeights, channels.length, 1, rowTopInsets);
  const layouts: WaveformAnnotationLayout[] = [];
  channels.forEach((channel, index) => {
    const row = rows[index];
    const visible = annotations.filter((item) => item.channel === channel && item.sample >= viewportStart && item.sample <= viewportStart + viewportSamples)
      .sort((a, b) => a.sample - b.sample || a.id.localeCompare(b.id));
    const y = row.top + Math.min(13, row.height / 2);
    visible.forEach((annotation, position) => {
      const x = (annotation.sample - viewportStart) / viewportSamples * width;
      const nextX = position + 1 < visible.length ? (visible[position + 1].sample - viewportStart) / viewportSamples * width : width;
      const selected = annotation.id === selectedId;
      const titleSide = selected && width - x < 190 ? "left" : "right";
      const available = titleSide === "left" ? x - 17 : (selected ? width : nextX) - x - 24;
      const titleWidth = available >= 42 ? Math.min(160, available) : 0;
      layouts.push({ annotation, x, y, stemHeight: Math.max(0, row.top + row.height / 2 - y - 11), titleWidth, titleSide });
    });
  });
  return layouts;
}
