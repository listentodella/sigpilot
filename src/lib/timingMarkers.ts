// Ported from Logic 2.4.43 timingMarkers Store/BaseManager/PairManager/defaults.
export const TIMING_MARKER_COLORS = ["paleRed", "green2", "purple2", "orange2", "fuchsia", "lightBlue"] as const;

export type TimingMarkerColor = (typeof TIMING_MARKER_COLORS)[number];
export type TimingMarkerKind = "pair" | "single";
export type TimingMarkerItemType = "left" | "right" | "root";

export interface UiTimingMarker {
  color: TimingMarkerColor;
  endSample?: number;
  graphPopupOpen: TimingMarkerItemType | null;
  id: string;
  isCaptureTrigger?: boolean;
  isExpanded: boolean;
  label: string;
  note: string;
  sample: number;
  selected: boolean;
  type: TimingMarkerKind;
}

export interface UiTimingMarkerPlacement {
  color: TimingMarkerColor;
  endSample?: number;
  id: string;
  label: string;
  placingSide: "end" | "start";
  sample: number;
  type: TimingMarkerKind;
}

export const TIMING_MARKER_COLOR_VALUES: Record<TimingMarkerColor, string> = {
  paleRed: "hsl(0, 78%, 63%)",
  green2: "hsl(162, 85%, 34%)",
  purple2: "#805dcd",
  orange2: "hsl(28, 86%, 62%)",
  fuchsia: "hsl(334, 58%, 53%)",
  lightBlue: "hsl(198, 70%, 50%)",
};

export const DEFAULT_TIMING_MARKER_COLOR = TIMING_MARKER_COLORS[0];
export const TIMING_MARKER_EDIT_POPUP_WIDTH = 250;
export const TIMING_MARKER_EDIT_POPUP_MARGIN = 5;
export const TIMING_MARKER_HEAD_TOP_PX = 4;
export const TIMING_MARKER_MOVEMENT_THRESHOLD_PX = 5;

export function getNextTimingMarkerNumber(markers: UiTimingMarker[]) {
  const existing = markers
    .map((marker) => Number(marker.label))
    .filter((label) => Number.isFinite(label));
  return existing.length === 0 ? 0 : Math.max(...existing) + 1;
}

export function getDefaultTimingMarkerColor(id: number) {
  return TIMING_MARKER_COLORS[Math.abs(Math.trunc(id)) % TIMING_MARKER_COLORS.length];
}

export function timingMarkerColorValue(color: TimingMarkerColor | undefined) {
  return TIMING_MARKER_COLOR_VALUES[color ?? DEFAULT_TIMING_MARKER_COLOR];
}

export function normalizeTimingMarker(marker: UiTimingMarker, index: number): UiTimingMarker {
  const fallbackLabel = `${index}`;
  const normalized: UiTimingMarker = {
    ...marker,
    color: marker.color ?? getDefaultTimingMarkerColor(index),
    graphPopupOpen: marker.graphPopupOpen ?? null,
    isExpanded: marker.isExpanded ?? false,
    label: marker.label ?? fallbackLabel,
    note: marker.note ?? "",
    selected: Boolean(marker.selected),
  };
  if (normalized.type === "single") {
    delete normalized.endSample;
  }
  return normalized;
}

export function getTimingMarkerFullLabel(marker: UiTimingMarker, itemType: TimingMarkerItemType = "root") {
  if (marker.isCaptureTrigger) return "Trigger";
  if (marker.type === "single") return `T${marker.label}`;
  if (itemType === "left") return `${marker.label}-A`;
  if (itemType === "right") return `${marker.label}-B`;
  return `P${marker.label}`;
}

export function getTimingMarkerValueSample(marker: UiTimingMarker, itemType: TimingMarkerItemType = "root") {
  if (marker.type === "single" || itemType === "left") return marker.sample;
  if (itemType === "right") return marker.endSample;
  return marker.endSample == null ? undefined : Math.abs(marker.endSample - marker.sample);
}

export function orderTimingPairSamples(marker: UiTimingMarker | UiTimingMarkerPlacement) {
  const endSample = marker.endSample ?? marker.sample;
  return {
    leftSample: Math.min(marker.sample, endSample),
    rightSample: Math.max(marker.sample, endSample),
  };
}

export function timingMarkerToPlacementMarker(placement: UiTimingMarkerPlacement): UiTimingMarker {
  return {
    color: placement.color,
    endSample: placement.endSample,
    graphPopupOpen: null,
    id: placement.id,
    isExpanded: false,
    label: placement.label,
    note: "",
    sample: placement.sample,
    selected: true,
    type: placement.type,
  };
}

// Ported from shared/utils/{getLabelForTime,getLimitedValueLabel,getMetricPrefix}.
const METRIC_PREFIXES = ["y", "z", "a", "f", "p", "n", "µ", "m", "", "k", "M", "G", "T", "P", "E", "Z", "Y"] as const;
const MIN_METRIC_DEGREE = -8;
const MAX_METRIC_DEGREE = 8;

export function formatTimingMarkerSeconds(seconds: number) {
  if (!Number.isFinite(seconds)) return "-";
  if (Math.abs(seconds) < 1) {
    return formatLimitedMetricValue(seconds, "s", 1e-9);
  }
  const time = seconds.toLocaleString("en-US", {
    minimumFractionDigits: 9,
    maximumFractionDigits: 9,
    useGrouping: true,
  });
  const microIndex = time.length - 6;
  const nanoIndex = time.length - 3;
  return `${time.slice(0, microIndex)} ${time.slice(microIndex, nanoIndex)} ${time.slice(nanoIndex)} s`;
}

export function formatTimingMarkerFrequency(hz: number, places = 2) {
  if (!Number.isFinite(hz)) return "-";
  return formatLimitedMetricValue(hz, "Hz", 1e-9, places);
}

function formatLimitedMetricValue(value: number, unit: string, resolution: number, placesLimit?: number) {
  const roundedResolution = roundToNearestPowerOfTen(resolution);
  const resolutionPower = Math.log10(roundedResolution);
  let degree = friendlyMetricDegree(value, 1000);
  let prefixPower = degree * 3;
  let places = prefixPower - resolutionPower;
  if (placesLimit !== undefined && placesLimit < places) places = placesLimit;

  if (resolutionPower - 3 >= prefixPower) return `0 ${unit}`;

  let adjustedValue = value / Math.pow(1000, degree);
  let roundedValue = roundDecimal(adjustedValue, places);
  let prefix = metricPrefixForDegree(degree);

  if (Math.round(roundedValue * Math.pow(10, places)) === 0) prefix = "";

  if (Math.abs(roundedValue) >= 1000) {
    degree = Math.min(MAX_METRIC_DEGREE, degree + 1);
    prefixPower = degree * 3;
    prefix = metricPrefixForDegree(degree);
    adjustedValue = value / Math.pow(1000, degree);
    if (placesLimit === undefined) places = prefixPower - resolutionPower;
    roundedValue = roundDecimal(adjustedValue, places);
  }

  return `${roundedValue} ${prefix}${unit}`;
}

function friendlyMetricDegree(value: number, threshold: number) {
  if (value === 0) return 0;
  const absolute = Math.abs(value);
  const degree = Math.floor(Math.log10(absolute) / 3);
  if (absolute >= 1) return clampMetricDegree(degree);
  const adjusted = absolute * Math.pow(1000, -degree);
  return clampMetricDegree(adjusted >= threshold ? degree + 1 : degree);
}

function metricPrefixForDegree(degree: number) {
  return METRIC_PREFIXES[clampMetricDegree(degree) - MIN_METRIC_DEGREE];
}

function clampMetricDegree(degree: number) {
  return Math.max(MIN_METRIC_DEGREE, Math.min(MAX_METRIC_DEGREE, degree));
}

function roundToNearestPowerOfTen(value: number) {
  if (value === 0) return 0;
  const magnitude = Math.floor(Math.log10(Math.abs(value)));
  const lower = Math.pow(10, magnitude);
  const upper = Math.pow(10, magnitude + 1);
  return Math.abs(value) >= upper / 2 ? upper : lower;
}

function roundDecimal(value: number, places: number) {
  if (!Number.isFinite(value)) return value;
  if (places >= 0) {
    const scale = Math.pow(10, places);
    return Math.round((value + Math.sign(value) * Number.EPSILON) * scale) / scale;
  }
  const scale = Math.pow(10, -places);
  return Math.round(value / scale) * scale;
}
