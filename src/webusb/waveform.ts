import { strToU8, zipSync } from "fflate";
import type { Capture } from "./model";
import type { WaveformTile } from "../lib/api";

function lowerBound(values: Uint32Array, target: number) {
  let low = 0,
    high = values.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (values[mid] < target) low = mid + 1;
    else high = mid;
  }
  return low;
}
export function level(c: Capture, ch: number, n: number) {
  return !!(
    c.samples[n * Math.ceil(c.channels / 8) + (ch >>> 3)] &
    (1 << (ch & 7))
  );
}
export function nextEdge(
  c: Capture,
  ch: number,
  sample: number,
  forward: boolean,
) {
  const e = c.edges[ch];
  return e[forward ? lowerBound(e, sample + 1) : lowerBound(e, sample) - 1];
}
export function tileFor(
  c: Capture,
  start: number,
  count: number,
  width: number,
): WaveformTile {
  const pixels = Math.min(2048, Math.max(1, Math.round(width)), count);
  const span = count / pixels;
  return {
    start_sample: start,
    sample_count: count,
    pixels,
    samples_per_pixel: span,
    channels: c.edges.map((edges, ch) => {
      const begin = lowerBound(edges, start + 1),
        end = lowerBound(edges, start + count);
      const firstHigh = level(c, ch, start);
      const exact = end - begin <= 2 * pixels;
      const segments = [],
        rising_edges: number[] = [],
        falling_edges: number[] = [];
      if (exact) {
        let from = start,
          high = firstHigh;
        for (let i = begin; i < end; i++) {
          segments.push({ start_sample: from, end_sample: edges[i], high });
          (high ? falling_edges : rising_edges).push(edges[i]);
          from = edges[i];
          high = !high;
        }
        segments.push({ start_sample: from, end_sample: start + count, high });
      }
      const bins = Array.from({ length: pixels }, (_, x) => {
        const from = start + Math.floor((x * count) / pixels);
        const to = start + Math.floor(((x + 1) * count) / pixels);
        const first = level(c, ch, from),
          last = level(c, ch, to - 1);
        const a = lowerBound(edges, from + 1),
          b = lowerBound(edges, to);
        return {
          x,
          first,
          last,
          has_high: first || b > a,
          has_low: !first || b > a,
          edges: b - a,
          first_edge_offset: b > a ? edges[a] - from : null,
          last_edge_offset: b > a ? edges[b - 1] - from : null,
        };
      });
      return {
        channel: ch,
        label: "D" + ch,
        segments,
        rising_edges,
        falling_edges,
        bins,
      };
    }),
  };
}
export function savePxcap(c: Capture) {
  const enabled = Array.from({ length: c.channels }, (_, i) => i);
  const metadata = {
    version: 1,
    source_device: c.model,
    sample_rate_hz: c.rate,
    channel_count: c.channels,
    enabled_channels: enabled,
    unitsize: Math.ceil(c.channels / 8),
    sample_count: c.count,
    captured_at: c.date,
    labels: enabled.map((i) => "D" + i),
  };
  const archive = zipSync(
    {
      "metadata.json": strToU8(JSON.stringify(metadata)),
      "samples.bin": c.samples,
    },
    { level: 0 },
  );
  const url = URL.createObjectURL(
    new Blob([new Uint8Array(archive)], { type: "application/zip" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = "SigPilot-" + c.date.replace(/:/g, "-") + ".pxcap";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
