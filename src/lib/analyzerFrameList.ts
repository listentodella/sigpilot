import type { DecodedFrame } from "./api.ts";
import {
  analyzerHasLazyNativeFramePlaceholder,
  type AnalyzerDisplayRadix,
  type UiAnalyzerInstance,
} from "./analyzers.ts";

export type AnalyzerFrameListPane = "table" | "terminal";

export interface AnalyzerFrameListSource<TAnalyzer = UiAnalyzerInstance> {
  analyzer: TAnalyzer;
  analyzerId: string;
  color: string;
  decodedFrameCount: number;
  decodedFrameCountEstimated: boolean;
  decodedFrames: DecodedFrame[];
  decodedFramesComplete: boolean;
  displayRadix: AnalyzerDisplayRadix;
  enabled: boolean;
  name: string;
}

export interface AnalyzerFrameListRef {
  framePosition: number;
  sourceIndex: number;
}

export interface AnalyzerFrameListRow<TAnalyzer = UiAnalyzerInstance> {
  analyzer: TAnalyzer;
  frame: DecodedFrame;
  frameIndex: number;
  frameNumber: number;
}

const ANALYZER_FRAME_CHANNEL_ROLES_CACHE = new WeakMap<DecodedFrame[], string[]>();
const ANALYZER_FRAME_BY_ID_CACHE = new WeakMap<DecodedFrame[], Map<number, DecodedFrame>>();
const ANALYZER_FRAME_POSITION_BY_ID_CACHE = new WeakMap<DecodedFrame[], Map<number, number>>();

export function analyzerFrameListSources(
  analyzers: UiAnalyzerInstance[],
  pane: AnalyzerFrameListPane,
): AnalyzerFrameListSource[] {
  return analyzers.map((analyzer) => ({
    analyzer,
    analyzerId: analyzer.id,
    color: analyzer.color,
    decodedFrameCount: analyzer.decodedFrameCount,
    decodedFrameCountEstimated: analyzerHasLazyNativeFramePlaceholder(analyzer),
    decodedFrames: analyzer.decodedFrames,
    decodedFramesComplete: analyzer.decodedFramesComplete,
    displayRadix: analyzer.displayRadix,
    enabled: pane === "table" ? analyzer.showInDataTable : analyzer.streamToTerminal,
    name: analyzer.name,
  }));
}

export function analyzerFrameListSourcesEqual<TAnalyzer>(
  left: AnalyzerFrameListSource<TAnalyzer>[],
  right: AnalyzerFrameListSource<TAnalyzer>[],
) {
  if (left.length !== right.length) return false;
  return left.every((source, index) => {
    const candidate = right[index];
    return candidate != null &&
      source.analyzerId === candidate.analyzerId &&
      source.color === candidate.color &&
      source.decodedFrameCount === candidate.decodedFrameCount &&
      source.decodedFrameCountEstimated === candidate.decodedFrameCountEstimated &&
      source.decodedFrames === candidate.decodedFrames &&
      source.decodedFramesComplete === candidate.decodedFramesComplete &&
      source.displayRadix === candidate.displayRadix &&
      source.enabled === candidate.enabled &&
      source.name === candidate.name;
  });
}

export function countAnalyzerFrameRows<TAnalyzer>(
  sources: AnalyzerFrameListSource<TAnalyzer>[],
) {
  return enabledSourceIndexes(sources).reduce(
    (count, sourceIndex) => count + analyzerFrameSourceCount(sources[sourceIndex]),
    0,
  );
}

export function analyzerFrameListChannelRoles<TAnalyzer>(
  sources: AnalyzerFrameListSource<TAnalyzer>[],
) {
  const roles = new Set<string>();
  for (const sourceIndex of enabledSourceIndexes(sources)) {
    for (const role of analyzerFrameChannelRoles(sources[sourceIndex].decodedFrames)) roles.add(role);
  }
  return [...roles];
}

export function findAnalyzerFrameById(frames: DecodedFrame[], frameId: number) {
  const cached = ANALYZER_FRAME_BY_ID_CACHE.get(frames);
  if (cached) return cached.get(frameId) ?? null;
  const index = new Map<number, DecodedFrame>();
  for (const frame of frames) index.set(frame.frame_id, frame);
  ANALYZER_FRAME_BY_ID_CACHE.set(frames, index);
  return index.get(frameId) ?? null;
}

export function findAnalyzerFramePositionById(frames: DecodedFrame[], frameId: number) {
  const cached = ANALYZER_FRAME_POSITION_BY_ID_CACHE.get(frames);
  if (cached) return cached.get(frameId) ?? -1;
  const index = new Map<number, number>();
  for (let position = 0; position < frames.length; position += 1) {
    index.set(frames[position].frame_id, position);
  }
  ANALYZER_FRAME_POSITION_BY_ID_CACHE.set(frames, index);
  return index.get(frameId) ?? -1;
}

export function analyzerFrameListRowsForWindow<TAnalyzer>(
  sources: AnalyzerFrameListSource<TAnalyzer>[],
  start: number,
  end: number,
): AnalyzerFrameListRow<TAnalyzer>[] {
  const totalRows = countAnalyzerFrameRows(sources);
  const window = normalizeWindow(start, end, totalRows);
  if (window.start >= window.end) return [];

  const sourceIndexes = enabledSourceIndexes(sources);
  if (sourceIndexes.length === 1) {
    const sourceIndex = sourceIndexes[0];
    const source = sources[sourceIndex];
    return source.decodedFrames
      .slice(window.start, window.end)
      .map((frame, offset) => analyzerFrameListRow(source, window.start + offset));
  }

  return analyzerFrameListRefsForWindow(sources, window.start, window.end).map((ref) =>
    analyzerFrameListRow(sources[ref.sourceIndex], ref.framePosition),
  );
}

export function analyzerFrameListRowsFromRefs<TAnalyzer>(
  sources: AnalyzerFrameListSource<TAnalyzer>[],
  refs: AnalyzerFrameListRef[],
  start = 0,
  end = refs.length,
): AnalyzerFrameListRow<TAnalyzer>[] {
  const window = normalizeWindow(start, end, refs.length);
  const rows: AnalyzerFrameListRow<TAnalyzer>[] = [];
  for (let index = window.start; index < window.end; index += 1) {
    const ref = refs[index];
    if (!ref) continue;
    const source = sources[ref.sourceIndex];
    if (!source) continue;
    rows.push(analyzerFrameListRow(source, ref.framePosition));
  }
  return rows;
}

export function filterAnalyzerFrameListRefs<TAnalyzer>(
  sources: AnalyzerFrameListSource<TAnalyzer>[],
  matches: (row: AnalyzerFrameListRow<TAnalyzer>) => boolean,
) {
  const refs: AnalyzerFrameListRef[] = [];
  forEachAnalyzerFrameListRef(sources, (ref) => {
    const row = analyzerFrameListRow(sources[ref.sourceIndex], ref.framePosition);
    if (matches(row)) refs.push(ref);
  });
  return refs;
}

export function forEachAnalyzerFrameListRow<TAnalyzer>(
  sources: AnalyzerFrameListSource<TAnalyzer>[],
  visit: (row: AnalyzerFrameListRow<TAnalyzer>) => void,
) {
  forEachAnalyzerFrameListRef(sources, (ref) => {
    visit(analyzerFrameListRow(sources[ref.sourceIndex], ref.framePosition));
  });
}

export function findAnalyzerFrameRefPosition<TAnalyzer>(
  sources: AnalyzerFrameListSource<TAnalyzer>[],
  refs: AnalyzerFrameListRef[],
  analyzerId: string,
  frameIndex: number | null,
) {
  for (let position = 0; position < refs.length; position += 1) {
    const ref = refs[position];
    const source = sources[ref.sourceIndex];
    const frame = source?.decodedFrames[ref.framePosition];
    if (!source || !frame) continue;
    if (source.analyzerId === analyzerId && analyzerFrameIndex(frame, ref.framePosition) === frameIndex) {
      return position;
    }
  }
  return -1;
}

export function findAnalyzerFrameRowPosition<TAnalyzer>(
  sources: AnalyzerFrameListSource<TAnalyzer>[],
  analyzerId: string,
  frameIndex: number | null,
) {
  if (frameIndex == null) return -1;
  const sourceIndexes = enabledSourceIndexes(sources);
  const targetSourceIndex = sourceIndexes.find((sourceIndex) => sources[sourceIndex].analyzerId === analyzerId);
  if (targetSourceIndex == null) return -1;

  const targetSource = sources[targetSourceIndex];
  const targetFramePosition = findAnalyzerFramePositionById(targetSource.decodedFrames, frameIndex);
  if (targetFramePosition < 0) return -1;

  const targetFrame = targetSource.decodedFrames[targetFramePosition];
  const targetSample = targetFrame.start_sample;
  let rowPosition = 0;
  for (const sourceIndex of sourceIndexes) {
    const frames = sources[sourceIndex].decodedFrames;
    if (sourceIndex < targetSourceIndex) {
      rowPosition += upperBoundFrameStart(frames, targetSample);
    } else if (sourceIndex === targetSourceIndex) {
      rowPosition += targetFramePosition;
    } else {
      rowPosition += lowerBoundFrameStart(frames, targetSample);
    }
  }
  return rowPosition;
}

function analyzerFrameListRefsForWindow<TAnalyzer>(
  sources: AnalyzerFrameListSource<TAnalyzer>[],
  start: number,
  end: number,
) {
  const sourceIndexes = enabledSourceIndexes(sources);
  if (sourceIndexes.length === 0 || start >= end) return [];

  const startSample = frameStartSampleAtRank(sources, sourceIndexes, start);
  if (startSample == null) return [];

  const positions = new Array<number>(sources.length).fill(0);
  let rowsBeforeStartSample = 0;
  for (const sourceIndex of sourceIndexes) {
    const frames = sources[sourceIndex].decodedFrames;
    const lower = lowerBoundFrameStart(frames, startSample);
    positions[sourceIndex] = lower;
    rowsBeforeStartSample += lower;
  }

  let tiedRowsToSkip = start - rowsBeforeStartSample;
  for (const sourceIndex of sourceIndexes) {
    if (tiedRowsToSkip <= 0) break;
    const frames = sources[sourceIndex].decodedFrames;
    const upper = upperBoundFrameStart(frames, startSample);
    const skip = Math.min(tiedRowsToSkip, upper - positions[sourceIndex]);
    positions[sourceIndex] += skip;
    tiedRowsToSkip -= skip;
  }

  const refs: AnalyzerFrameListRef[] = [];
  const targetCount = end - start;
  while (refs.length < targetCount) {
    const nextSourceIndex = nextFrameSourceIndex(sources, sourceIndexes, positions);
    if (nextSourceIndex < 0) break;
    refs.push({
      framePosition: positions[nextSourceIndex],
      sourceIndex: nextSourceIndex,
    });
    positions[nextSourceIndex] += 1;
  }
  return refs;
}

function forEachAnalyzerFrameListRef<TAnalyzer>(
  sources: AnalyzerFrameListSource<TAnalyzer>[],
  visit: (ref: AnalyzerFrameListRef) => void,
) {
  const sourceIndexes = enabledSourceIndexes(sources);
  if (sourceIndexes.length === 0) return;

  if (sourceIndexes.length === 1) {
    const sourceIndex = sourceIndexes[0];
    const frames = sources[sourceIndex].decodedFrames;
    for (let framePosition = 0; framePosition < frames.length; framePosition += 1) {
      visit({ framePosition, sourceIndex });
    }
    return;
  }

  const positions = new Array<number>(sources.length).fill(0);
  while (true) {
    const sourceIndex = nextFrameSourceIndex(sources, sourceIndexes, positions);
    if (sourceIndex < 0) return;
    visit({
      framePosition: positions[sourceIndex],
      sourceIndex,
    });
    positions[sourceIndex] += 1;
  }
}

function frameStartSampleAtRank<TAnalyzer>(
  sources: AnalyzerFrameListSource<TAnalyzer>[],
  sourceIndexes: number[],
  rank: number,
) {
  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;
  for (const sourceIndex of sourceIndexes) {
    const frames = sources[sourceIndex].decodedFrames;
    const first = frames[0];
    const last = frames[frames.length - 1];
    if (!first || !last) continue;
    low = Math.min(low, first.start_sample);
    high = Math.max(high, last.start_sample);
  }
  if (!Number.isFinite(low) || !Number.isFinite(high)) return null;

  let left = Math.floor(low);
  let right = Math.floor(high);
  while (left < right) {
    const mid = Math.floor((left + right) / 2);
    if (countFramesAtOrBeforeSample(sources, sourceIndexes, mid) > rank) {
      right = mid;
    } else {
      left = mid + 1;
    }
  }
  return left;
}

function countFramesAtOrBeforeSample<TAnalyzer>(
  sources: AnalyzerFrameListSource<TAnalyzer>[],
  sourceIndexes: number[],
  sample: number,
) {
  let count = 0;
  for (const sourceIndex of sourceIndexes) {
    count += upperBoundFrameStart(sources[sourceIndex].decodedFrames, sample);
  }
  return count;
}

function nextFrameSourceIndex<TAnalyzer>(
  sources: AnalyzerFrameListSource<TAnalyzer>[],
  sourceIndexes: number[],
  positions: number[],
) {
  let bestSourceIndex = -1;
  let bestFramePosition = -1;
  let bestFrame: DecodedFrame | null = null;
  for (const sourceIndex of sourceIndexes) {
    const framePosition = positions[sourceIndex];
    const frame = sources[sourceIndex].decodedFrames[framePosition];
    if (!frame) continue;
    if (
      !bestFrame ||
      frame.start_sample < bestFrame.start_sample ||
      (frame.start_sample === bestFrame.start_sample &&
        (sourceIndex < bestSourceIndex ||
          (sourceIndex === bestSourceIndex && framePosition < bestFramePosition)))
    ) {
      bestFrame = frame;
      bestSourceIndex = sourceIndex;
      bestFramePosition = framePosition;
    }
  }
  return bestSourceIndex;
}

function analyzerFrameListRow<TAnalyzer>(
  source: AnalyzerFrameListSource<TAnalyzer>,
  framePosition: number,
): AnalyzerFrameListRow<TAnalyzer> {
  const frame = source.decodedFrames[framePosition];
  return {
    analyzer: source.analyzer,
    frame,
    frameIndex: analyzerFrameIndex(frame, framePosition),
    frameNumber: framePosition + 1,
  };
}

function analyzerFrameIndex(frame: DecodedFrame, framePosition: number) {
  return frame.frame_id ?? framePosition;
}

function analyzerFrameChannelRoles(frames: DecodedFrame[]) {
  const cached = ANALYZER_FRAME_CHANNEL_ROLES_CACHE.get(frames);
  if (cached) return cached;
  const roles: string[] = [];
  const seen = new Set<string>();
  for (const frame of frames) {
    for (const value of frame.channel_values) {
      if (seen.has(value.role)) continue;
      seen.add(value.role);
      roles.push(value.role);
    }
  }
  ANALYZER_FRAME_CHANNEL_ROLES_CACHE.set(frames, roles);
  return roles;
}

function enabledSourceIndexes<TAnalyzer>(sources: AnalyzerFrameListSource<TAnalyzer>[]) {
  const indexes: number[] = [];
  for (let sourceIndex = 0; sourceIndex < sources.length; sourceIndex += 1) {
    const source = sources[sourceIndex];
    if (source.enabled && analyzerFrameSourceCount(source) > 0) indexes.push(sourceIndex);
  }
  return indexes;
}

function analyzerFrameSourceCount<TAnalyzer>(source: AnalyzerFrameListSource<TAnalyzer>) {
  if (source.decodedFrameCountEstimated && source.decodedFrames.length === 0) return 0;
  return Math.max(source.decodedFrameCount, source.decodedFrames.length);
}

function lowerBoundFrameStart(frames: DecodedFrame[], sample: number) {
  let low = 0;
  let high = frames.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (frames[mid].start_sample < sample) low = mid + 1;
    else high = mid;
  }
  return low;
}

function upperBoundFrameStart(frames: DecodedFrame[], sample: number) {
  let low = 0;
  let high = frames.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (frames[mid].start_sample <= sample) low = mid + 1;
    else high = mid;
  }
  return low;
}

function normalizeWindow(start: number, end: number, totalRows: number) {
  const total = Math.max(0, Math.trunc(totalRows));
  const windowStart = Math.min(total, Math.max(0, Math.trunc(start)));
  const windowEnd = Math.max(windowStart, Math.min(total, Math.trunc(end)));
  return { end: windowEnd, start: windowStart };
}
