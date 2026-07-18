import type { DigitalRangeMeasurementStats } from "./api";

export type DigitalRangeMeasurementId =
  | "frequency"
  | "period"
  | "positive_width"
  | "negative_width"
  | "positive_duty"
  | "negative_duty"
  | "frequencyMax"
  | "frequencyAvg"
  | "frequencyMin"
  | "edgesFalling"
  | "edgesRising"
  | "periodStdDev";

export interface DigitalRangeMeasurementDefinition {
  category: "Time" | "Digital";
  description: string;
  id: DigitalRangeMeasurementId;
  label: string;
  labelHtml: string;
}

export interface FormattedRangeMeasurementValue {
  fullValue: string;
  value: string;
}

export const DIGITAL_RANGE_MEASUREMENT_CATEGORIES: {
  name: "Time" | "Digital";
  measurements: DigitalRangeMeasurementDefinition[];
}[] = [
  {
    name: "Time",
    measurements: [
      {
        id: "frequency",
        category: "Time",
        label: "Frequency",
        labelHtml: "<i>f</i>",
        description: "Average frequency from complete same-edge cycles inside the range.",
      },
      {
        id: "period",
        category: "Time",
        label: "Period",
        labelHtml: "<i>T</i>",
        description: "Average cycle period from same-edge transitions inside the range.",
      },
      {
        id: "positive_width",
        category: "Time",
        label: "Width 1",
        labelHtml: "<i>t</i><sub>high</sub>",
        description: "Average high pulse width inside the selected range.",
      },
      {
        id: "negative_width",
        category: "Time",
        label: "Width 0",
        labelHtml: "<i>t</i><sub>low</sub>",
        description: "Average low pulse width inside the selected range.",
      },
      {
        id: "positive_duty",
        category: "Time",
        label: "Duty 1",
        labelHtml: "<i>D</i><sub>high</sub>",
        description: "Percent of the range spent high.",
      },
      {
        id: "negative_duty",
        category: "Time",
        label: "Duty 0",
        labelHtml: "<i>D</i><sub>low</sub>",
        description: "Percent of the range spent low.",
      },
    ],
  },
  {
    name: "Digital",
    measurements: [
      {
        id: "frequencyMax",
        category: "Digital",
        label: "Maximum Frequency",
        labelHtml: "<i>f</i><sub>max</sub>",
        description: "Frequency of the highest-frequency single cycle.",
      },
      {
        id: "frequencyAvg",
        category: "Digital",
        label: "Average Frequency",
        labelHtml: "<i>f</i><sub>avg</sub>",
        description: "Average frequency of each cycle.",
      },
      {
        id: "frequencyMin",
        category: "Digital",
        label: "Minimum Frequency",
        labelHtml: "<i>f</i><sub>min</sub>",
        description: "Frequency of the lowest-frequency single cycle.",
      },
      {
        id: "edgesFalling",
        category: "Digital",
        label: "No. Falling Edges",
        labelHtml: "No. Falling Edges",
        description: "Count of falling edges.",
      },
      {
        id: "edgesRising",
        category: "Digital",
        label: "No. Rising Edges",
        labelHtml: "No. Rising Edges",
        description: "Count of rising edges.",
      },
      {
        id: "periodStdDev",
        category: "Digital",
        label: "Period Std. Deviation",
        labelHtml: "&sigma;<sub>T</sub>",
        description: "Standard deviation of the periods of each cycle.",
      },
    ],
  },
];

export const DIGITAL_RANGE_MEASUREMENTS = DIGITAL_RANGE_MEASUREMENT_CATEGORIES.flatMap(
  (category) => category.measurements,
);

export const DEFAULT_DIGITAL_RANGE_MEASUREMENTS: DigitalRangeMeasurementId[] =
  DIGITAL_RANGE_MEASUREMENTS.map((measurement) => measurement.id);

const measurementDefinitions = new Map(
  DIGITAL_RANGE_MEASUREMENTS.map((measurement) => [measurement.id, measurement]),
);

export function rangeMeasurementDefinition(id: DigitalRangeMeasurementId) {
  return measurementDefinitions.get(id);
}

export function ensureRangeMeasurementIds(ids: string[] | undefined): DigitalRangeMeasurementId[] {
  if (!ids) return [...DEFAULT_DIGITAL_RANGE_MEASUREMENTS];
  if (ids.length === 0) return [];
  const valid = ids.filter((id): id is DigitalRangeMeasurementId => measurementDefinitions.has(id as DigitalRangeMeasurementId));
  return valid.length > 0 ? valid : [...DEFAULT_DIGITAL_RANGE_MEASUREMENTS];
}

export function formatDeltaTime(stats: DigitalRangeMeasurementStats | null, sampleRateHz?: number) {
  if (!stats) return "...";
  return formatSampleDuration(stats.duration_samples, stats.sample_rate_hz || sampleRateHz || 1);
}

export function formatRangeMeasurementValue(
  id: DigitalRangeMeasurementId,
  stats: DigitalRangeMeasurementStats | null,
): FormattedRangeMeasurementValue {
  if (!stats) return { value: "...", fullValue: "Measurement pending" };
  switch (id) {
    case "frequency":
    case "frequencyAvg":
      return formatFrequencyValue(stats.avg_frequency_hz);
    case "frequencyMax":
      return formatFrequencyValue(stats.max_frequency_hz);
    case "frequencyMin":
      return formatFrequencyValue(stats.min_frequency_hz);
    case "period":
      return formatSamplesAsSeconds(stats.avg_period_samples, stats.sample_rate_hz);
    case "periodStdDev":
      return formatSamplesAsSeconds(stats.period_std_dev_samples, stats.sample_rate_hz);
    case "positive_width":
      return formatSamplesAsSeconds(stats.avg_high_width_samples, stats.sample_rate_hz);
    case "negative_width":
      return formatSamplesAsSeconds(stats.avg_low_width_samples, stats.sample_rate_hz);
    case "positive_duty":
      return formatPercentValue(stats.positive_duty);
    case "negative_duty":
      return formatPercentValue(stats.negative_duty);
    case "edgesFalling":
      return formatCountValue(stats.falling_edges);
    case "edgesRising":
      return formatCountValue(stats.rising_edges);
  }
}

export function copyRangeMeasurementValues({
  channelIndex,
  measurementIds,
  name,
  note,
  stats,
}: {
  channelIndex: number;
  measurementIds: DigitalRangeMeasurementId[];
  name: string;
  note: string;
  stats: DigitalRangeMeasurementStats | null;
}) {
  const rows = [`${name}\tD${channelIndex}`, `Delta T\t${formatDeltaTime(stats)}`];
  measurementIds.forEach((id) => {
    const definition = rangeMeasurementDefinition(id);
    if (!definition) return;
    const value = formatRangeMeasurementValue(id, stats).value;
    if (value === "N/A" || value === "...") return;
    rows.push(`${definition.label}\t${value}`);
  });
  if (note.trim()) rows.push(`Comment\t${note.trim()}`);
  return rows.join("\n");
}

export function formatSampleDuration(samples: number, sampleRateHz: number) {
  return formatSeconds(samples / Math.max(1, sampleRateHz));
}

function formatSamplesAsSeconds(samples: number | null, sampleRateHz: number): FormattedRangeMeasurementValue {
  if (samples == null || !Number.isFinite(samples) || samples <= 0) return invalidValue();
  const seconds = samples / Math.max(1, sampleRateHz);
  return { value: formatSeconds(seconds), fullValue: `${seconds} s` };
}

function formatFrequencyValue(value: number | null): FormattedRangeMeasurementValue {
  if (value == null || !Number.isFinite(value) || value <= 0) return invalidValue();
  return { value: formatFrequency(value), fullValue: `${value} Hz` };
}

function formatPercentValue(value: number | null): FormattedRangeMeasurementValue {
  if (value == null || !Number.isFinite(value)) return invalidValue();
  return { value: `${trimNumber(value)}%`, fullValue: `${value}%` };
}

function formatCountValue(value: number): FormattedRangeMeasurementValue {
  return { value: String(value), fullValue: String(value) };
}

function invalidValue(): FormattedRangeMeasurementValue {
  return { value: "N/A", fullValue: "N/A" };
}

function formatFrequency(rate: number): string {
  if (Math.abs(rate) >= 1_000_000_000) return `${trimNumber(rate / 1_000_000_000)} GHz`;
  if (Math.abs(rate) >= 1_000_000) return `${trimNumber(rate / 1_000_000)} MHz`;
  if (Math.abs(rate) >= 1_000) return `${trimNumber(rate / 1_000)} kHz`;
  return `${trimNumber(rate)} Hz`;
}

function formatSeconds(value: number) {
  const absolute = Math.abs(value);
  if (!Number.isFinite(value)) return "N/A";
  if (absolute >= 1) return `${trimNumber(value)} s`;
  if (absolute >= 1e-3) return `${trimNumber(value * 1e3)} ms`;
  if (absolute >= 1e-6) return `${trimNumber(value * 1e6)} us`;
  return `${trimNumber(value * 1e9)} ns`;
}

function trimNumber(value: number) {
  if (!Number.isFinite(value)) return "N/A";
  if (Number.isInteger(value)) return String(value);
  return value.toPrecision(3).replace(/\.?0+($|e)/, "$1");
}
