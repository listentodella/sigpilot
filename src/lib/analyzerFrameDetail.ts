import type { DecodedFrame } from "./api.ts";
import { findAnalyzerFramePositionById } from "./analyzerFrameList.ts";

/**
 * The frame a bubble or table selection points at, resolved to the full backend
 * frame so the UI can show the untruncated label. `frameIndex` is the frame id
 * used by `UiAnalyzerInstance.highlightedFrameIndex` and by
 * `AnalyzerFrameListRow.frameIndex`, not an array position: `decodedFrames` may
 * hold a window whose first frame id is not zero.
 */
export interface AnalyzerFrameDetail {
  analyzerId: string;
  frameIndex: number;
  frameNumber: number;
  frame: DecodedFrame;
}

/** Minimal shape of a rendered track window (see `AnalyzerTrackWindow`). */
export interface AnalyzerFrameDetailTrack {
  frames: readonly DecodedFrame[];
  next_frame?: DecodedFrame | null;
  previous_frame?: DecodedFrame | null;
}

/** Minimal analyzer shape needed to resolve a frame locally. */
export interface AnalyzerFrameDetailAnalyzer {
  id: string;
  decodedFrames: DecodedFrame[];
  decodedFrameCount?: number;
  decodedFramesComplete?: boolean;
  renderedTracks?: readonly AnalyzerFrameDetailTrack[];
}

/**
 * The rendered window behind the bubbles the user can click. It is the last
 * local source before the backend round trip, and the only one that still has
 * frames for a lazily summarised analyzer.
 */
function findAnalyzerRenderedTrackFrame(
  analyzer: AnalyzerFrameDetailAnalyzer,
  frameId: number,
): DecodedFrame | null {
  for (const track of analyzer.renderedTracks ?? []) {
    if (track.previous_frame?.frame_id === frameId) return track.previous_frame;
    for (const frame of track.frames) {
      if (frame.frame_id === frameId) return frame;
    }
    if (track.next_frame?.frame_id === frameId) return track.next_frame;
  }
  return null;
}

/**
 * Minimal row shape of `AnalyzerFrameListRow` (see analyzerFrameList.ts).
 */
export interface AnalyzerFrameDetailRow {
  analyzer: { id: string };
  frame: DecodedFrame;
  frameIndex: number;
  frameNumber: number;
}

export interface AnalyzerFrameDetailNeighbors {
  frameCount: number;
  nextIndex: number | null;
  previousIndex: number | null;
}

export interface AnalyzerFrameDetailNeighborsSource {
  decodedFrameCount?: number;
  decodedFrames: DecodedFrame[];
}

/**
 * Stable identity for one analyzer frame, for detail caches and for the async
 * backfill guard that must not paint a stale frame over the current highlight.
 */
export function analyzerFrameDetailKey(analyzerId: string, frameIndex: number) {
  return `${analyzerId}:${frameIndex}`;
}

export function findAnalyzerDecodedFrame(
  frames: readonly DecodedFrame[],
  frameIndex: number,
): DecodedFrame | null {
  for (const frame of frames) {
    if (frame.frame_id === frameIndex) return frame;
  }
  return null;
}

/**
 * Resolve the highlighted frame, preferring the frames already held by the
 * analyzer (which may be a window) and falling back to a table row, which
 * carries both the frame and its 1-based number.
 */
export function resolveAnalyzerFrameDetail({
  analyzers,
  analyzerId,
  frameIndex,
  rows,
}: {
  analyzers: readonly AnalyzerFrameDetailAnalyzer[];
  analyzerId: string | null | undefined;
  frameIndex: number | null | undefined;
  rows?: readonly AnalyzerFrameDetailRow[] | null;
}): AnalyzerFrameDetail | null {
  if (analyzerId == null || analyzerId === "") return null;
  if (frameIndex == null || !Number.isFinite(frameIndex)) return null;
  const index = Math.trunc(frameIndex);

  const analyzer = analyzers.find((candidate) => candidate.id === analyzerId);
  if (analyzer) {
    // The data table numbers frames by their position in the stored list. A
    // decode that reaches MAX_DECODED_FRAMES drops every other frame and
    // doubles its stride, so ids keep gaps: the position is authoritative and
    // `frameIndex + 1` would report the wrong row number.
    const position = findAnalyzerFramePositionById(analyzer.decodedFrames, index);
    if (position >= 0) {
      return {
        analyzerId,
        frame: analyzer.decodedFrames[position],
        frameIndex: index,
        frameNumber: position + 1,
      };
    }
  }

  const row = rows?.find(
    (candidate) => candidate.analyzer.id === analyzerId && candidate.frameIndex === index,
  );
  if (row) {
    return { analyzerId, frame: row.frame, frameIndex: index, frameNumber: row.frameNumber };
  }

  const renderedFrame = analyzer ? findAnalyzerRenderedTrackFrame(analyzer, index) : null;
  if (renderedFrame) {
    return { analyzerId, frame: renderedFrame, frameIndex: index, frameNumber: index + 1 };
  }

  return null;
}

/**
 * Neighbour frame ids around `frameIndex`, clamped to the analyzer frame range.
 * `decodedFrameCount` is authoritative when present (it covers frames that are
 * not loaded yet); otherwise the loaded frame count is used.
 */
export function analyzerFrameDetailNeighbors(
  analyzer: AnalyzerFrameDetailNeighborsSource | null | undefined,
  frameIndex: number | null | undefined,
): AnalyzerFrameDetailNeighbors {
  const declared = analyzer?.decodedFrameCount;
  const declaredCount =
    typeof declared === "number" && Number.isFinite(declared) ? Math.max(0, Math.trunc(declared)) : 0;
  const frames = analyzer?.decodedFrames ?? [];
  const frameCount = Math.max(declaredCount, frames.length);
  if (frameCount <= 0) return { frameCount: 0, nextIndex: null, previousIndex: null };

  const rawIndex =
    frameIndex == null || !Number.isFinite(frameIndex) ? 0 : Math.trunc(frameIndex);
  const position = findAnalyzerFramePositionById(frames, rawIndex);
  if (position >= 0) {
    // The neighbouring frame is the neighbouring stored entry, which stops
    // being `frameIndex + 1` once a decode decimated its frames.
    return {
      frameCount,
      nextIndex: frames[position + 1]?.frame_id ?? null,
      previousIndex: position > 0 ? frames[position - 1].frame_id : null,
    };
  }

  const index = Math.min(frameCount - 1, Math.max(0, rawIndex));
  return {
    frameCount,
    nextIndex: index < frameCount - 1 ? index + 1 : null,
    previousIndex: index > 0 ? index - 1 : null,
  };
}

/**
 * Same format as App.tsx `formatSeconds` (which is module-private there), so the
 * frame detail shows identical start/duration text to the data table.
 */
export function formatAnalyzerFrameSeconds(value: number) {
  const absolute = Math.abs(value);
  if (absolute >= 1) return `${trimAnalyzerFrameDetailNumber(value)} s`;
  if (absolute >= 1e-3) return `${trimAnalyzerFrameDetailNumber(value * 1e3)} ms`;
  if (absolute >= 1e-6) return `${trimAnalyzerFrameDetailNumber(value * 1e6)} us`;
  return `${trimAnalyzerFrameDetailNumber(value * 1e9)} ns`;
}

function trimAnalyzerFrameDetailNumber(value: number) {
  if (!Number.isFinite(value)) return "-";
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}
