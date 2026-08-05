let analyzerTimingEnabled: boolean | null = null;

export function traceAnalyzerPerformance(
  stage: string,
  startedAt: number,
  detail = "",
) {
  if (analyzerTimingEnabled === null) {
    try {
      analyzerTimingEnabled = window.localStorage.getItem("pxlogic:decoder-timing") === "1";
    } catch {
      analyzerTimingEnabled = false;
    }
  }
  if (!analyzerTimingEnabled) return;
  const elapsedMs = performance.now() - startedAt;
  console.debug(
    `[pxlogic-analyzer] stage=${stage} elapsed_ms=${elapsedMs.toFixed(3)}${detail ? ` ${detail}` : ""}`,
  );
}
