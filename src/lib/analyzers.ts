import type { DecodedFrame } from "./api";

// Ported from Logic 2.4.43 uikit/utils/colors.ts.
export const SALEAE_ANALYZER_COLORS = [
  "#7EA0F8",
  "#D881F7",
  "#F69898",
  "#75CACA",
  "#D1B56E",
  "#7ACB8C",
  "#95A0B4",
  "#ABA48B",
] as const;

// Ported from Logic 2.4.43 app/utils/defaults.ts.
export const ANALYZER_BUBBLES_HEIGHT_PX = 16;
export const ANALYZER_BUBBLES_PADDING_PX = 4;
export const ANALYZER_STRIP_HEIGHT_PX = ANALYZER_BUBBLES_HEIGHT_PX + ANALYZER_BUBBLES_PADDING_PX;

export interface UiAnalyzerInstance {
  id: string;
  type: string;
  name: string;
  color: string;
  channel: number;
  baudRate: number;
  inverted: boolean;
  showInDataTable: boolean;
  streamToTerminal: boolean;
  decodedFrames: DecodedFrame[];
  previousFrame: DecodedFrame | null;
  nextFrame: DecodedFrame | null;
  decodeBusy: boolean;
  highlightedFrameIndex: number | null;
}

export function analyzerDisplayName(type: string, analyzers: UiAnalyzerInstance[]) {
  const matching = analyzers.filter((analyzer) => analyzer.type === type);
  if (matching.length === 0) return type;

  let suffix = 1;
  while (matching.some((analyzer) => analyzer.name === `${type} [${suffix}]`)) suffix += 1;
  return `${type} [${suffix}]`;
}

export function createAnalyzerInstance(
  type: string,
  analyzers: UiAnalyzerInstance[],
  channel = 0,
): UiAnalyzerInstance {
  const index = analyzers.length;
  return {
    id: `analyzer-${Date.now()}-${index}`,
    type,
    name: analyzerDisplayName(type, analyzers),
    color: SALEAE_ANALYZER_COLORS[index % SALEAE_ANALYZER_COLORS.length],
    channel,
    baudRate: 115_200,
    inverted: false,
    showInDataTable: true,
    streamToTerminal: false,
    decodedFrames: [],
    previousFrame: null,
    nextFrame: null,
    decodeBusy: false,
    highlightedFrameIndex: null,
  };
}

export function analyzerStripInsetForChannel(analyzers: UiAnalyzerInstance[], channel: number) {
  return analyzers.filter((analyzer) => analyzer.channel === channel).length * ANALYZER_STRIP_HEIGHT_PX;
}

export function analyzerSupportsDecoding(analyzer: Pick<UiAnalyzerInstance, "type">) {
  return analyzer.type === "Async Serial";
}
