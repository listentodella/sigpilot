import assert from "node:assert/strict";
import test from "node:test";
import { decodeBinaryGraphFrame } from "../src/lib/api.ts";

test("binary graph frame restores packed waveform bytes without base64", () => {
  const header = new TextEncoder().encode(JSON.stringify({
    frame_id: 3,
    revision: 4,
    sample_count: 64,
    tile: {
      start_sample: 0,
      sample_count: 64,
      pixels: 1,
      samples_per_pixel: 64,
      channels: [{
        channel: 0,
        label: "D0",
        bins: [],
        packed_bins: { offset: 1, length: 3 },
        segments: [],
        rising_edges: [],
        falling_edges: [],
      }],
    },
    analyzers: [],
  }));
  const binary = Uint8Array.of(0xaa, 1, 2, 3, 0xbb);
  const payload = new Uint8Array(13 + header.length + binary.length);
  payload.set(new TextEncoder().encode("PXGF1"), 0);
  new DataView(payload.buffer).setBigUint64(5, BigInt(header.length), true);
  payload.set(header, 13);
  payload.set(binary, 13 + header.length);

  const frame = decodeBinaryGraphFrame(payload);

  assert.equal(frame.frame_id, 3);
  assert.deepEqual(Array.from(frame.tile.channels[0].packed_bins ?? []), [1, 2, 3]);
});

test("binary graph frame rejects an out-of-range waveform slice", () => {
  const header = new TextEncoder().encode(JSON.stringify({
    frame_id: 0,
    revision: 0,
    sample_count: 1,
    tile: {
      start_sample: 0,
      sample_count: 1,
      pixels: 1,
      samples_per_pixel: 1,
      channels: [{
        channel: 0,
        label: "D0",
        bins: [],
        packed_bins: { offset: 10, length: 10 },
        segments: [],
        rising_edges: [],
        falling_edges: [],
      }],
    },
    analyzers: [],
  }));
  const payload = new Uint8Array(13 + header.length);
  payload.set(new TextEncoder().encode("PXGF1"), 0);
  new DataView(payload.buffer).setBigUint64(5, BigInt(header.length), true);
  payload.set(header, 13);

  assert.throws(() => decodeBinaryGraphFrame(payload), /packed waveform range/);
});
