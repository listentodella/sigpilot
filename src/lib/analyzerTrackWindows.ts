import {
  buildAnalyzerFrameWindow,
  type AnalyzerProtocolMarker,
  type AnalyzerTrackRequest,
  type AnalyzerTrackWindow,
  type DecodedChannelValue,
  type DecodedFrame,
} from "./api.ts";
import {
  analyzerBubbleRoles,
  analyzerMarkerRoles,
  type UiAnalyzerInstance,
} from "./analyzers.ts";

export const LOCAL_ANALYZER_MARKER_LIMIT = 300;

const LOCAL_ANALYZER_TRACK_FRAME_CACHE = new WeakMap<
  DecodedFrame[],
  Map<string, DecodedFrame[]>
>();
const LOCAL_ANALYZER_TRACK_FRAME_INDEX_CACHE = new WeakMap<
  DecodedFrame[],
  AnalyzerTrackFrameIndex
>();
const LOCAL_ANALYZER_TRACK_MARKER_CACHE = new WeakMap<
  DecodedFrame[],
  Map<string, AnalyzerProtocolMarker[]>
>();
const LOCAL_ANALYZER_TRACK_MARKER_INDEX_CACHE = new WeakMap<
  DecodedFrame[],
  AnalyzerTrackMarkerIndex
>();
const EMPTY_DECODED_FRAMES: DecodedFrame[] = [];
const EMPTY_PROTOCOL_MARKERS: AnalyzerProtocolMarker[] = [];
const LOCAL_ANALYZER_PROTOCOL_MARKER_KINDS = new Set<AnalyzerProtocolMarker["kind"]>([
  "dot",
  "error_dot",
  "square",
  "error_square",
  "up_arrow",
  "down_arrow",
  "x",
  "error_x",
  "start",
  "stop",
  "one",
  "zero",
]);

interface AnalyzerTrackFrameIndex {
  exactByTrack: Map<string, DecodedFrame[]>;
  firstByChannel: Map<number, DecodedFrame[]>;
}

interface AnalyzerTrackMarkerIndex {
  protocolByChannel: Map<number, AnalyzerProtocolMarker[]>;
}

export function analyzerTrackRequestsForAnalyzer(analyzer: UiAnalyzerInstance): AnalyzerTrackRequest[] {
  const roles = [...analyzerBubbleRoles(analyzer), ...analyzerMarkerRoles(analyzer)];
  return roles
    .filter(
      (role, index) =>
        roles.findIndex(
          (candidate) => candidate.channel === role.channel && candidate.title === role.title,
        ) === index,
    )
    .map((role) => ({
      channel: role.channel,
      role: role.title,
    }));
}

export function analyzerCanRenderTracksLocally(
  analyzer: UiAnalyzerInstance,
  decodeSignature: string,
  sessionBusy: boolean,
) {
  return (
    !sessionBusy &&
    analyzer.decodedFramesComplete &&
    analyzer.decodedFrames.length > 0 &&
    analyzer.decodedDecodeSignature === decodeSignature
  );
}

export function decodedFramesForAnalyzerTrack(
  frames: DecodedFrame[],
  track: AnalyzerTrackRequest,
): DecodedFrame[] {
  const cacheKey = analyzerTrackRequestKey(track.channel, track.role);
  let trackCache = LOCAL_ANALYZER_TRACK_FRAME_CACHE.get(frames);
  if (!trackCache) {
    trackCache = new Map();
    LOCAL_ANALYZER_TRACK_FRAME_CACHE.set(frames, trackCache);
  }
  const cached = trackCache.get(cacheKey);
  if (cached) return cached;
  const index = analyzerTrackFrameIndex(frames);
  const exact = index.exactByTrack.get(cacheKey) ?? EMPTY_DECODED_FRAMES;
  const fallback = index.firstByChannel.get(track.channel) ?? EMPTY_DECODED_FRAMES;
  const filtered = mergeExactAndFallbackTrackFrames(exact, fallback);
  trackCache.set(cacheKey, filtered);
  return filtered;
}

export function buildLocalAnalyzerTrackWindow(
  frames: DecodedFrame[],
  track: AnalyzerTrackRequest,
  startSample: number,
  sampleCount: number,
  widthPx: number,
): AnalyzerTrackWindow {
  const trackFrames = decodedFramesForAnalyzerTrack(frames, track);
  const window = buildAnalyzerFrameWindow(trackFrames, startSample, sampleCount, widthPx);
  return {
    channel: track.channel,
    protocol_markers: localProtocolMarkersForAnalyzerTrack(frames, track, startSample, sampleCount),
    role: track.role,
    ...window,
    // The full frames already live in analyzer.decodedFrames. Keeping only
    // refs in renderedTracks avoids duplicating large frame objects during
    // local viewport aggregation.
    frames: [],
    previous_frame: null,
    next_frame: null,
  };
}

export function analyzerTrackWindowsEqual(
  left: AnalyzerTrackWindow[],
  right: AnalyzerTrackWindow[],
) {
  if (left.length !== right.length) return false;
  return left.every((track, index) => analyzerTrackWindowEqual(track, right[index]));
}

export function reuseAnalyzerTrackWindows(
  previous: AnalyzerTrackWindow[],
  incoming: AnalyzerTrackWindow[],
) {
  if (previous === incoming) return previous;
  let changed = previous.length !== incoming.length;
  let previousByTrack: Map<string, AnalyzerTrackWindow> | null = null;
  const reused = incoming.map((track, index) => {
    const key = analyzerTrackWindowKey(track);
    const positionalCandidate = previous[index];
    let candidate =
      positionalCandidate && analyzerTrackWindowKey(positionalCandidate) === key
        ? positionalCandidate
        : undefined;
    if (!candidate) {
      changed = true;
      previousByTrack ??= new Map(previous.map((item) => [analyzerTrackWindowKey(item), item]));
      candidate = previousByTrack.get(key);
    }
    if (!candidate || !analyzerTrackWindowEqual(candidate, track)) {
      changed = true;
      return track;
    }
    return candidate;
  });
  return changed ? reused : previous;
}

export function localProtocolMarkersForAnalyzerTrack(
  frames: DecodedFrame[],
  track: AnalyzerTrackRequest,
  startSample: number,
  sampleCount: number,
): AnalyzerProtocolMarker[] {
  const endSample = startSample + sampleCount;
  let markers = markersInSampleWindow(
    protocolMarkersForAnalyzerTrack(frames, track),
    startSample,
    endSample,
    LOCAL_ANALYZER_MARKER_LIMIT,
  );
  if (markers.length === 0 && track.role.toLowerCase() === "sda") {
    markers = markersInSampleWindow(
      sdaFallbackMarkersForAnalyzerTrack(frames, track),
      startSample,
      endSample,
      LOCAL_ANALYZER_MARKER_LIMIT,
    );
  }
  return markers;
}

function analyzerTrackWindowKey(track: Pick<AnalyzerTrackWindow, "channel" | "role">) {
  return `${track.channel}\u0000${track.role}`;
}

function analyzerTrackWindowEqual(
  left: AnalyzerTrackWindow | undefined,
  right: AnalyzerTrackWindow | undefined,
) {
  if (!left || !right) return left === right;
  return (
    left.channel === right.channel &&
	    left.role === right.role &&
	    analyzerBubblesEqual(left.bubbles, right.bubbles) &&
	    analyzerProtocolMarkersEqual(left.protocol_markers, right.protocol_markers) &&
	    analyzerFrameRefsEqual(left.frame_refs ?? [], right.frame_refs ?? []) &&
	    decodedFrameListsEqual(left.frames, right.frames) &&
	    analyzerFrameRefEqual(left.previous_frame_ref ?? null, right.previous_frame_ref ?? null) &&
	    decodedFrameEqual(left.previous_frame, right.previous_frame) &&
	    analyzerFrameRefEqual(left.next_frame_ref ?? null, right.next_frame_ref ?? null) &&
	    decodedFrameEqual(left.next_frame, right.next_frame)
	  );
	}

function analyzerBubblesEqual(
  left: AnalyzerTrackWindow["bubbles"],
  right: AnalyzerTrackWindow["bubbles"],
) {
  if (left.length !== right.length) return false;
  return left.every((bubble, index) => {
    const candidate = right[index];
    return candidate != null &&
      bubble.type === candidate.type &&
      bubble.start_sample === candidate.start_sample &&
      bubble.end_sample === candidate.end_sample &&
      bubble.result_count === candidate.result_count &&
      bubble.frame_id_interval.begin === candidate.frame_id_interval.begin &&
      bubble.frame_id_interval.end === candidate.frame_id_interval.end &&
      stringArraysEqual(bubble.display_text, candidate.display_text);
  });
}

function analyzerProtocolMarkersEqual(
  left: AnalyzerTrackWindow["protocol_markers"],
  right: AnalyzerTrackWindow["protocol_markers"],
) {
  if (left.length !== right.length) return false;
  return left.every((marker, index) => {
    const candidate = right[index];
    return candidate != null &&
      marker.sample === candidate.sample &&
      marker.kind === candidate.kind;
  });
}

function analyzerFrameRefsEqual(
  left: NonNullable<AnalyzerTrackWindow["frame_refs"]>,
  right: NonNullable<AnalyzerTrackWindow["frame_refs"]>,
) {
  if (left.length !== right.length) return false;
  return left.every((frame, index) => analyzerFrameRefEqual(frame, right[index]));
}

function analyzerFrameRefEqual(
  left: NonNullable<AnalyzerTrackWindow["frame_refs"]>[number] | null,
  right: NonNullable<AnalyzerTrackWindow["frame_refs"]>[number] | null,
) {
  return (
    left === right ||
    Boolean(
      left &&
        right &&
        left.frame_id === right.frame_id &&
        left.start_sample === right.start_sample &&
        left.end_sample === right.end_sample,
    )
  );
}

function decodedFrameListsEqual(
  left: DecodedFrame[],
  right: DecodedFrame[],
) {
  if (left.length !== right.length) return false;
  return left.every((frame, index) => decodedFrameEqual(frame, right[index]));
}

function decodedFrameEqual(
  left: DecodedFrame | null | undefined,
  right: DecodedFrame | null | undefined,
) {
  if (left === right) return true;
  if (!left || !right) return left === right;
  return (
    left.frame_id === right.frame_id &&
    left.start_sample === right.start_sample &&
    left.end_sample === right.end_sample &&
    left.frame_type === right.frame_type &&
    left.label === right.label &&
    left.value === right.value &&
    decodedChannelValuesEqual(left.channel_values, right.channel_values)
  );
}

function decodedChannelValuesEqual(
  left: DecodedChannelValue[],
  right: DecodedChannelValue[],
) {
  if (left.length !== right.length) return false;
  return left.every((value, index) => {
    const candidate = right[index];
    return candidate != null &&
      value.channel === candidate.channel &&
      value.role === candidate.role &&
      value.label === candidate.label &&
      value.value === candidate.value &&
      stringArraysEqual(value.texts ?? [], candidate.texts ?? []);
  });
}

function stringArraysEqual(left: string[], right: string[]) {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

export function protocolMarkersForAnalyzerTrack(
  frames: DecodedFrame[],
  track: AnalyzerTrackRequest,
): AnalyzerProtocolMarker[] {
  return cachedTrackMarkers(
    LOCAL_ANALYZER_TRACK_MARKER_CACHE,
    frames,
    `${track.channel}\u0000${track.role}\u0000protocol`,
    () => analyzerTrackMarkerIndex(frames).protocolByChannel.get(track.channel) ?? EMPTY_PROTOCOL_MARKERS,
  );
}

function sdaFallbackMarkersForAnalyzerTrack(
  frames: DecodedFrame[],
  track: AnalyzerTrackRequest,
): AnalyzerProtocolMarker[] {
  if (track.role.toLowerCase() !== "sda") return EMPTY_PROTOCOL_MARKERS;
  return cachedTrackMarkers(
    LOCAL_ANALYZER_TRACK_MARKER_CACHE,
    frames,
    "sda-fallback",
    () => buildSdaFallbackMarkers(frames),
  );
}

function cachedTrackMarkers(
  cache: WeakMap<DecodedFrame[], Map<string, AnalyzerProtocolMarker[]>>,
  frames: DecodedFrame[],
  cacheKey: string,
  build: () => AnalyzerProtocolMarker[],
) {
  let trackCache = cache.get(frames);
  if (!trackCache) {
    trackCache = new Map();
    cache.set(frames, trackCache);
  }
  const cached = trackCache.get(cacheKey);
  if (cached) return cached;
  const markers = build();
  trackCache.set(cacheKey, markers);
  return markers;
}

function analyzerTrackFrameIndex(frames: DecodedFrame[]) {
  const cached = LOCAL_ANALYZER_TRACK_FRAME_INDEX_CACHE.get(frames);
  if (cached) return cached;

  const index: AnalyzerTrackFrameIndex = {
    exactByTrack: new Map(),
    firstByChannel: new Map(),
  };
  frames.forEach((frame) => {
    if (frame.channel_values.length === 1) {
      const value = frame.channel_values[0];
      appendIndexedTrackFrame(
        index.exactByTrack,
        analyzerTrackRequestKey(value.channel, value.role),
        frame,
        value,
      );
      appendIndexedTrackFrame(index.firstByChannel, value.channel, frame, value);
      return;
    }
    const firstValuesByChannel: DecodedChannelValue[] = [];
    const emittedExactKeys: string[] = [];
    frame.channel_values.forEach((value) => {
      if (!firstValuesByChannel.some((candidate) => candidate.channel === value.channel)) {
        firstValuesByChannel.push(value);
      }
      const exactKey = analyzerTrackRequestKey(value.channel, value.role);
      if (emittedExactKeys.includes(exactKey)) return;
      emittedExactKeys.push(exactKey);
      appendIndexedTrackFrame(index.exactByTrack, exactKey, frame, value);
    });
    firstValuesByChannel.forEach((value) => {
      appendIndexedTrackFrame(index.firstByChannel, value.channel, frame, value);
    });
  });

  LOCAL_ANALYZER_TRACK_FRAME_INDEX_CACHE.set(frames, index);
  return index;
}

function analyzerTrackMarkerIndex(frames: DecodedFrame[]) {
  const cached = LOCAL_ANALYZER_TRACK_MARKER_INDEX_CACHE.get(frames);
  if (cached) return cached;

  const protocolByChannel = new Map<number, AnalyzerProtocolMarker[]>();
  frames.forEach((frame) => {
    frame.protocol_markers?.forEach((marker) => {
      if (marker.channel === null || !LOCAL_ANALYZER_PROTOCOL_MARKER_KINDS.has(marker.kind)) return;
      const markers = protocolByChannel.get(marker.channel);
      const next = { sample: marker.sample, kind: marker.kind };
      if (markers) markers.push(next);
      else protocolByChannel.set(marker.channel, [next]);
    });
  });
  protocolByChannel.forEach((markers, channel) => {
    protocolByChannel.set(channel, sortAndDeduplicateMarkers(markers));
  });

  const index = {
    protocolByChannel,
  };
  LOCAL_ANALYZER_TRACK_MARKER_INDEX_CACHE.set(frames, index);
  return index;
}

function buildSdaFallbackMarkers(frames: DecodedFrame[]) {
  const markers: AnalyzerProtocolMarker[] = [];
  frames.forEach((frame) => {
    if (frame.frame_type === "start" || frame.frame_type === "Start" || frame.frame_type === "START") {
      markers.push({ sample: frame.start_sample, kind: "start" });
    } else if (frame.frame_type === "stop" || frame.frame_type === "Stop" || frame.frame_type === "STOP") {
      markers.push({ sample: frame.start_sample, kind: "stop" });
    } else if (frame.frame_type.length !== 4 && frame.frame_type.length !== 5) {
      return;
    } else {
      const frameType = frame.frame_type.toLowerCase();
      if (frameType === "start" || frameType === "stop") {
        markers.push({ sample: frame.start_sample, kind: frameType });
      }
    }
  });
  return sortAndDeduplicateMarkers(markers);
}

function appendIndexedTrackFrame<K>(
  index: Map<K, DecodedFrame[]>,
  key: K,
  frame: DecodedFrame,
  value: DecodedChannelValue,
) {
  const indexed = decodedFrameWithSingleChannelValue(frame, value);
  const frames = index.get(key);
  if (frames) frames.push(indexed);
  else index.set(key, [indexed]);
}

function mergeExactAndFallbackTrackFrames(
  exact: DecodedFrame[],
  fallback: DecodedFrame[],
) {
  if (exact.length === 0) return fallback;
  if (fallback.length === 0) return exact;

  const merged: DecodedFrame[] = [];
  let exactIndex = 0;
  let fallbackIndex = 0;
  while (exactIndex < exact.length || fallbackIndex < fallback.length) {
    if (fallbackIndex >= fallback.length) {
      merged.push(exact[exactIndex++]);
      continue;
    }
    if (exactIndex >= exact.length) {
      merged.push(fallback[fallbackIndex++]);
      continue;
    }
    const exactFrame = exact[exactIndex];
    const fallbackFrame = fallback[fallbackIndex];
    const order = compareDecodedFrameIdentity(exactFrame, fallbackFrame);
    if (order < 0) {
      merged.push(exactFrame);
      exactIndex += 1;
    } else if (order > 0) {
      merged.push(fallbackFrame);
      fallbackIndex += 1;
    } else {
      merged.push(exactFrame);
      exactIndex += 1;
      fallbackIndex += 1;
    }
  }
  return merged;
}

function analyzerTrackRequestKey(channel: number, role: string) {
  return `${channel}\u0000${role}`;
}

function compareDecodedFrameIdentity(left: DecodedFrame, right: DecodedFrame) {
  return (
    left.start_sample - right.start_sample ||
    left.frame_id - right.frame_id ||
    left.end_sample - right.end_sample
  );
}

function sortAndDeduplicateMarkers(markers: AnalyzerProtocolMarker[]) {
  if (markers.length <= 1) return markers;
  if (!markersAreOrdered(markers)) {
    markers.sort(compareProtocolMarkers);
  }
  let writeIndex = 1;
  for (let readIndex = 1; readIndex < markers.length; readIndex += 1) {
    const marker = markers[readIndex];
    const previous = markers[writeIndex - 1];
    if (marker.sample === previous.sample && marker.kind === previous.kind) continue;
    markers[writeIndex] = marker;
    writeIndex += 1;
  }
  markers.length = writeIndex;
  return markers;
}

function markersAreOrdered(markers: AnalyzerProtocolMarker[]) {
  for (let index = 1; index < markers.length; index += 1) {
    if (compareProtocolMarkers(markers[index - 1], markers[index]) > 0) return false;
  }
  return true;
}

function compareProtocolMarkers(left: AnalyzerProtocolMarker, right: AnalyzerProtocolMarker) {
  return left.sample - right.sample || left.kind.localeCompare(right.kind);
}

function markersInSampleWindow(
  markers: AnalyzerProtocolMarker[],
  startSample: number,
  endSample: number,
  limit = Number.POSITIVE_INFINITY,
) {
  const begin = lowerBoundMarkerSample(markers, startSample);
  const end = upperBoundMarkerSample(markers, endSample, begin);
  const count = Math.max(0, end - begin);
  if (count === 0 || limit <= 0) return EMPTY_PROTOCOL_MARKERS;
  if (count <= limit) return markers.slice(begin, end);
  const limitedCount = Math.max(1, Math.floor(limit));
  const last = count - 1;
  return Array.from({ length: limitedCount }, (_, index) =>
    markers[begin + Math.floor((index * last) / Math.max(1, limitedCount - 1))],
  );
}

function decodedFrameWithSingleChannelValue(
  frame: DecodedFrame,
  value: DecodedChannelValue,
): DecodedFrame {
  return {
    ...frame,
    label: value.label,
    value: value.value,
    channel_values: [value],
  };
}

function lowerBoundMarkerSample(markers: AnalyzerProtocolMarker[], sample: number) {
  let low = 0;
  let high = markers.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (markers[middle].sample < sample) low = middle + 1;
    else high = middle;
  }
  return low;
}

function upperBoundMarkerSample(markers: AnalyzerProtocolMarker[], sample: number, low = 0) {
  let start = low;
  let high = markers.length;
  while (start < high) {
    const middle = (start + high) >>> 1;
    if (markers[middle].sample <= sample) start = middle + 1;
    else high = middle;
  }
  return start;
}
