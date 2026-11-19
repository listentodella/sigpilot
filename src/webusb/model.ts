import type { UsbId } from "./usb";

export const rates = [
  100_000, 500_000, 1_000_000, 5_000_000, 10_000_000, 25_000_000, 50_000_000,
  100_000_000,
];
export const depths = [1024, 16384, 65536, 262144];
export const thresholds = [1.8, 2, 2.5, 3.3, 5];
export interface Settings {
  channels: number;
  rate: number;
  count: number;
  threshold: number;
}
export interface BufferMode {
  channels: number;
  minRate: number;
  maxRate: number;
}
export interface CaptureProfile {
  channels: number;
  model: string;
  bufferModes: BufferMode[];
}
export interface Capture extends Settings {
  samples: Uint8Array<ArrayBuffer>;
  edges: Uint32Array<ArrayBuffer>[];
  model: string;
  date: string;
}
export type Request =
  | { kind: "connect"; device: UsbId; files: string[] }
  | { kind: "capture"; settings: Settings }
  | { kind: "flash"; file: File }
  | { kind: "close" };
export type Reply =
  | { kind: "status"; message: string }
  | {
      kind: "ready";
      channels: number;
      model: string;
      bufferModes: BufferMode[];
    }
  | { kind: "boot" }
  | { kind: "capture"; capture: Capture }
  | { kind: "closed"; message: string };
