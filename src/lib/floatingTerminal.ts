export interface TerminalRect { x: number; y: number; width: number; height: number }
export interface TerminalViewport { width: number; height: number }
const STORAGE_KEY = "sigpilot.terminal.geometry.v1";

export function clampTerminalRect(rect: TerminalRect, viewport: TerminalViewport): TerminalRect {
  const width = Math.min(Math.max(380, rect.width), Math.max(240, viewport.width - 16));
  const height = Math.min(Math.max(220, rect.height), Math.max(160, viewport.height - 76));
  return {
    width, height,
    x: Math.max(8, Math.min(rect.x, viewport.width - width - 8)),
    y: Math.max(36, Math.min(rect.y, viewport.height - height - 40)),
  };
}

export function initialTerminalRect(viewport: TerminalViewport): TerminalRect {
  let rect: TerminalRect = { x: 220, y: viewport.height - 400, width: 700, height: 340 };
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (saved && typeof saved === "object" && ["x", "y", "width", "height"].every(
      (key) => typeof (saved as Record<string, unknown>)[key] === "number"
        && Number.isFinite((saved as Record<string, number>)[key]),
    )) rect = saved as TerminalRect;
  } catch { /* Storage is optional; default geometry remains usable. */ }
  return clampTerminalRect(rect, viewport);
}

export function saveTerminalRect(rect: TerminalRect): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(rect)); } catch { /* Optional preference. */ }
}

/** Keep surrogate pairs intact when splitting large paste input. */
export function terminalInputChunks(data: string): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const char of data) {
    current += char;
    if (current.length >= 8192) { chunks.push(current); current = ""; }
  }
  if (current) chunks.push(current);
  return chunks;
}
