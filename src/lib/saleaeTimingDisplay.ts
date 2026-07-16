import { Decimal } from "decimal.js";

// Ported from Logic 2.4.43:
// app/utils/timingDisplay.ts and shared/utils metric-prefix helpers.
export const minimumHorizontalTickSpacingPx = 45;
export const timeTickExpansionPx = minimumHorizontalTickSpacingPx;

// Logic 2.4.43 DarkTheme border-10 / border-20, used by useGridlineColors().
export const SALEAE_DARK_GRIDLINE_PRIMARY = "#303136";
export const SALEAE_DARK_GRIDLINE_SECONDARY = "#57575E";

export interface TimingTick {
  leftPx: number;
  isOutOfRange?: boolean;
  value: number;
  label: string;
}

export interface HorizontalTimingTicks {
  majorTicks: TimingTick[];
  minorTicks: TimingTick[];
}

const metricPrefixes = [
  { magnitude: 1e24, degree: 8, prefix: "Y" },
  { magnitude: 1e21, degree: 7, prefix: "Z" },
  { magnitude: 1e18, degree: 6, prefix: "E" },
  { magnitude: 1e15, degree: 5, prefix: "P" },
  { magnitude: 1e12, degree: 4, prefix: "T" },
  { magnitude: 1e9, degree: 3, prefix: "G" },
  { magnitude: 1e6, degree: 2, prefix: "M" },
  { magnitude: 1e3, degree: 1, prefix: "k" },
  { magnitude: 1, degree: 0, prefix: "" },
  { magnitude: 1e-3, degree: -1, prefix: "m" },
  { magnitude: 1e-6, degree: -2, prefix: "µ" },
  { magnitude: 1e-9, degree: -3, prefix: "n" },
  { magnitude: 1e-12, degree: -4, prefix: "p" },
  { magnitude: 1e-15, degree: -5, prefix: "f" },
  { magnitude: 1e-18, degree: -6, prefix: "a" },
  { magnitude: 1e-21, degree: -7, prefix: "z" },
  { magnitude: 1e-24, degree: -8, prefix: "y" },
] as const;

const defaultMetricPrefix = { magnitude: 1, degree: 0, prefix: "" };
const maxMetricPrefix = metricPrefixes[0];
const minMetricPrefix = metricPrefixes[metricPrefixes.length - 1];
const approxLimit = Number.EPSILON * 10;

function compareApprox(a: number, b: number) {
  return Math.abs(a - b) < approxLimit;
}

function findPrefix(magnitude: number) {
  const match = metricPrefixes.find((prefix) => prefix.magnitude === magnitude);
  if (!match && magnitude > maxMetricPrefix.magnitude) return maxMetricPrefix;
  if (!match && magnitude < minMetricPrefix.magnitude) return minMetricPrefix;
  return match ?? defaultMetricPrefix;
}

function getFriendlyDegree(value: number, threshold = 100) {
  if (value === 0) return 0;
  const absoluteValue = Math.abs(value);
  const degree = Math.floor(Math.log10(absoluteValue) / 3);
  if (absoluteValue >= 1) return degree;
  const adjustedByDegree = absoluteValue * Math.pow(1000, -degree);
  return adjustedByDegree >= threshold ? degree + 1 : degree;
}

function getMetricPrefixByDegree(value: number, degree: number) {
  const prefix = findPrefix(Math.pow(1000, degree));
  return {
    adjustedValue: value / prefix.magnitude,
    prefix: prefix.prefix,
  };
}

function getPrefixForDegree(degree: number) {
  return findPrefix(Math.pow(1000, degree)).prefix;
}

export function precisionRemainder(numerator: number, denominator: number) {
  return new Decimal(numerator).modulo(new Decimal(denominator)).toNumber();
}

export function roundNumberToPosition(value: number, decimalPlaces: number) {
  return Number.parseFloat(value.toFixed(Math.round(decimalPlaces)));
}

export function snapMinorValue(value: number) {
  const order = Math.floor(Math.log10(Math.abs(value)));
  if (order >= 1) return Math.round(value);
  return roundNumberToPosition(value, Math.abs(order) + 1);
}

export function getNextLargerSpan(span: number, divisors: number[] = []) {
  const order = Math.ceil(Math.log10(span));
  const newSpan = Math.pow(10, order);
  divisors.sort((left, right) => right - left);
  for (const divisor of divisors) {
    if (newSpan / divisor >= span) return newSpan / divisor;
  }
  return newSpan;
}

export function getTicksSpan(valuePerPixel: number, minimumSpacingPx: number, divisors: number[] = []) {
  return getNextLargerSpan(valuePerPixel * minimumSpacingPx, divisors);
}

export function getHorizontalMajorTickSpan(minorTickSpan: number) {
  return minorTickSpan * 10;
}

function getLargerPower10Span(span: number) {
  const power = Math.ceil(Math.log10(Math.abs(span)));
  const absolutePowerValue = 10 ** Math.abs(power);
  return power < 0 ? 1 / absolutePowerValue : absolutePowerValue;
}

export function getRawTicks(
  startingValue: number,
  valuePerPixel: number,
  distancePx: number,
  minimumSpacingPx: number,
  overlapPx: number,
  divisors: number[] = [],
) {
  const spanValues = getTicksSpan(valuePerPixel, minimumSpacingPx, divisors);
  const spanValuesDecimal = new Decimal(spanValues);
  const spanPx = spanValues / valuePerPixel;
  let currentValueDecimal = new Decimal(startingValue);
  let currentPx = -overlapPx;

  currentValueDecimal = currentValueDecimal.sub(new Decimal(overlapPx).mul(new Decimal(valuePerPixel)));
  const remainderDecimal = currentValueDecimal.modulo(spanValuesDecimal);
  const offsetSecondsDecimal = currentValueDecimal.isPositive()
    ? spanValuesDecimal.sub(remainderDecimal)
    : remainderDecimal.abs();

  if (!remainderDecimal.isZero()) {
    currentValueDecimal = currentValueDecimal.add(offsetSecondsDecimal);
    currentPx += offsetSecondsDecimal.toNumber() / valuePerPixel;
  }

  const ticks: { positionPx: number; value: number }[] = [];
  const endingPx = distancePx + overlapPx;
  do {
    ticks.push({ positionPx: currentPx, value: currentValueDecimal.toNumber() });
    currentPx += spanPx;
    currentValueDecimal = currentValueDecimal.add(spanValuesDecimal);
  } while (currentPx <= endingPx);
  return ticks;
}

export function getMinorLabelTime(remainderSeconds: number, span: number) {
  const degree = getFriendlyDegree(getLargerPower10Span(span));
  const prefix = getMetricPrefixByDegree(remainderSeconds, degree);
  const adjustedValue = snapMinorValue(prefix.adjustedValue);
  return `${adjustedValue > 0 ? "+" : ""}${adjustedValue} ${prefix.prefix}s`;
}

export function getMajorLabelTime(
  timeSeconds: number,
  span: number,
  trimLeadingZeros = true,
  trimTrailingZeros = false,
) {
  if (timeSeconds === 0) return "0 s";

  let startingDegree = Math.max(Math.floor(Math.log10(Math.abs(timeSeconds)) / 3), 0);
  const endingDegree = Math.floor(Math.log10(Math.abs(span)) / 3);
  let signString = "";
  let positiveTime = timeSeconds;
  if (positiveTime < 0) {
    signString = "- ";
    positiveTime = Math.abs(positiveTime);
  }

  positiveTime += 1000 ** endingDegree / 100;
  if (startingDegree < endingDegree) startingDegree = endingDegree;

  const slices: { slice: number; degree: number }[] = [];
  for (let degree = startingDegree; degree >= endingDegree; degree -= 1) {
    slices.push({
      slice: Math.trunc(positiveTime * Math.pow(1000, -degree)) % 1000,
      degree,
    });
  }

  if (trimLeadingZeros && slices.some(({ slice }) => slice !== 0)) {
    while (slices[0].slice === 0) slices.shift();
  }
  if (trimTrailingZeros) {
    while (slices.length > 1 && slices[slices.length - 1].slice === 0) slices.pop();
  }

  return signString + slices.map(({ slice, degree }) => `${slice} ${getPrefixForDegree(degree)}s`).join(" : ");
}

function getLeftMajorTickValue(firstTick: number, majorSpanSeconds: number) {
  const firstTickDecimal = new Decimal(firstTick);
  const remainder = new Decimal(precisionRemainder(firstTick, majorSpanSeconds));
  let leftTickValue = firstTickDecimal.sub(remainder);
  if (firstTickDecimal.lessThan(0)) leftTickValue = leftTickValue.sub(majorSpanSeconds);
  return leftTickValue.toNumber();
}

function filterTicksOutOfRange(ticks: TimingTick[], widthPx: number, threshold: number) {
  return ticks.filter((tick) => tick.leftPx <= widthPx + threshold && tick.leftPx >= -threshold);
}

export function getHorizontalGraphTicks(
  leftEdgeTimeSeconds: number,
  timeSecondsPerPixel: number,
  widthPx: number,
  options: {
    majorThresholdPx?: number;
    minorThresholdPx?: number;
    addClosestOffscreenMajorTicks?: boolean;
    negativeMinorTicks?: boolean;
  } = {},
): HorizontalTimingTicks {
  const allTicks = getRawTicks(
    leftEdgeTimeSeconds,
    timeSecondsPerPixel,
    widthPx,
    minimumHorizontalTickSpacingPx,
    timeTickExpansionPx,
  );

  const minorSpanSeconds = getTicksSpan(timeSecondsPerPixel, minimumHorizontalTickSpacingPx);
  const majorSpanSeconds = snapMinorValue(getHorizontalMajorTickSpan(minorSpanSeconds));
  let minorTicks: TimingTick[] = [];
  let majorTicks: TimingTick[] = [];

  allTicks.forEach(({ positionPx, value }) => {
    let remainder = precisionRemainder(value, majorSpanSeconds);
    if (
      compareApprox(remainder, 0) ||
      compareApprox(remainder, majorSpanSeconds) ||
      compareApprox(-remainder, majorSpanSeconds)
    ) {
      majorTicks.push({
        leftPx: positionPx,
        value,
        label: getMajorLabelTime(value, majorSpanSeconds),
      });
      return;
    }

    if (!options.negativeMinorTicks && remainder < 0) remainder += majorSpanSeconds;
    minorTicks.push({
      leftPx: positionPx,
      value,
      label: getMinorLabelTime(remainder, minorSpanSeconds),
    });
  });

  if (options.majorThresholdPx !== undefined) {
    majorTicks = filterTicksOutOfRange(majorTicks, widthPx, options.majorThresholdPx);
  }

  if (
    options.addClosestOffscreenMajorTicks &&
    allTicks.length > 0 &&
    (majorTicks.length === 0 || majorTicks[0].leftPx >= widthPx * 0.49)
  ) {
    const leftMajorTickValue = getLeftMajorTickValue(allTicks[0].value, majorSpanSeconds);
    majorTicks.unshift({
      leftPx: 0,
      value: leftMajorTickValue,
      isOutOfRange: true,
      label: getMajorLabelTime(leftMajorTickValue, majorSpanSeconds),
    });
  }

  if (options.minorThresholdPx !== undefined) {
    minorTicks = filterTicksOutOfRange(minorTicks, widthPx, options.minorThresholdPx);
  }

  return { majorTicks, minorTicks };
}
