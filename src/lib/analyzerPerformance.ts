import { migrateLegacyKey } from "./legacyStorage.ts";

let analyzerTimingEnabled: boolean | null = null;

const DECODER_TIMING_KEY = "sigpilot:decoder-timing";
const LEGACY_DECODER_TIMING_KEY = "pxlogic:decoder-timing";

export function traceAnalyzerPerformance(
  stage: string,
  startedAt: number,
  detail = "",
) {
  if (analyzerTimingEnabled === null) {
    try {
      migrateLegacyKey(window.localStorage, DECODER_TIMING_KEY, LEGACY_DECODER_TIMING_KEY);
      analyzerTimingEnabled = window.localStorage.getItem(DECODER_TIMING_KEY) === "1";
    } catch {
      analyzerTimingEnabled = false;
    }
  }
  if (!analyzerTimingEnabled) return;
  const elapsedMs = performance.now() - startedAt;
  console.debug(
    `[sigpilot-analyzer] stage=${stage} elapsed_ms=${elapsedMs.toFixed(3)}${detail ? ` ${detail}` : ""}`,
  );
}
