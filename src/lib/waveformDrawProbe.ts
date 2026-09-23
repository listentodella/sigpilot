// Dev-only instrumentation for the waveform draw path.
//
// `drawCachedWaveLayer` picks between six ways of putting pixels on screen, and
// the choice depends on state that only exists at runtime: how coarse the
// retained tile is, whether the worker's viewport raster happens to cover the
// current viewport, and which caches are still on hand. Reasoning about which
// branch a gesture takes from the source is how you end up fixing the wrong one,
// so this records what actually happened instead.
//
// The number that matters is `stretch`: how many times the blitted raster is
// magnified. 1 means pixel exact. Above 1 every stroke on screen is that much
// too thick, which is what "the edges look unclear while zooming" looks like
// numerically.
//
// Dev-only: `enabled` is false in a production build, so the recording calls are
// tree-shaken and the accounting costs nothing.

export type WaveformDrawPath =
  /** The worker's viewport raster: rendered at the scale the user is looking at. */
  | "viewport-raster"
  /** The retained tile raster, magnified because nothing better was on hand. */
  | "stale-tile-raster"
  /** An older viewport raster, still overlapping but for a different viewport. */
  | "stale-viewport-raster"
  /** Main-thread canvas2d render in view space: correct, but synchronous. */
  | "view-space-render"
  /** The tile raster blitted at its native scale (viewport is coarser than it). */
  | "tile-raster"
  /** Nothing but exact edge segments: no raster was usable at all. */
  | "exact-segments";

export interface WaveformDrawRecord {
  path: WaveformDrawPath;
  /** Magnification applied to the blitted raster. 1 is pixel exact. */
  stretch: number;
  /** Samples the viewport is being shown at, per CSS pixel. */
  viewportSamplesPerPixel: number;
}

const RECENT_LIMIT = 400;
const enabled = Boolean(import.meta.env?.DEV);

const counts = new Map<WaveformDrawPath, number>();
const worstStretch = new Map<WaveformDrawPath, number>();
const recent: WaveformDrawRecord[] = [];

export function recordWaveformDraw(record: WaveformDrawRecord) {
  if (!enabled) return;
  counts.set(record.path, (counts.get(record.path) ?? 0) + 1);
  const worst = worstStretch.get(record.path) ?? 0;
  if (record.stretch > worst) worstStretch.set(record.path, record.stretch);
  recent.push(record);
  if (recent.length > RECENT_LIMIT) recent.shift();
}

export function resetWaveformDrawProbe() {
  counts.clear();
  worstStretch.clear();
  recent.length = 0;
}

export function waveformDrawSummary() {
  const total = [...counts.values()].reduce((sum, value) => sum + value, 0);
  return {
    paths: [...counts.entries()]
      .map(([path, count]) => ({
        count,
        maxStretch: Number((worstStretch.get(path) ?? 0).toFixed(3)),
        path,
        share: total > 0 ? Number((count / total).toFixed(3)) : 0,
      }))
      .sort((left, right) => right.count - left.count),
    total,
  };
}

if (enabled && typeof window !== "undefined") {
  (window as unknown as { __PXLOGIC_DRAW__?: unknown }).__PXLOGIC_DRAW__ = {
    recent: () => [...recent],
    reset: resetWaveformDrawProbe,
    summary: waveformDrawSummary,
  };
}
