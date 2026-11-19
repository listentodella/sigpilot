import catalog from "../../resources/devices/catalog.json";
import {
  depths,
  rates,
  thresholds,
  type Capture,
  type CaptureProfile,
  type Settings,
} from "./model";
import { UsbTransport } from "./usb";

// Register layout and sequence mirror sigpilot-core/{protocol,capture,rusb_backend}.
const base = 8192;
const reg = {
  control: 0,
  pwm: 4,
  threshold: 8,
  mask: 16,
  gpio: 20,
  div: 24,
  size: 28,
  run: 32,
  zero: 36,
  one: 40,
  rise: 44,
  fall: 48,
  ext: 60,
  triggerOut: 88,
  dma: base + 8,
  readStart: base + 12,
  readEnd: base + 16,
  readMode: base + 20,
  writeStart: base + 24,
  writeEnd: base + 28,
  writeMode: base + 32,
  bytesLow: base + 36,
  bytesHigh: base + 40,
  block: base + 44,
  reset: base + 48,
  firmware: base + 52,
  lanes: base + 76,
  position: base + 80,
  variant: base + 88,
};
const stop = 0xffffffff;
const page = (bytes: number) => Math.ceil(bytes / 4096) * 4096;
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const fpgaHashes = [
  "1b4bf398a4cafd9d2fb0f118982ebc064db22ebdd50db36097610f82ec45ec69",
  "aa2fb803a46886dc77633c7e6fec87ca0a699a3db6a7d22732d3084bd76dd514",
];
const mcuHash =
  "da9b1e4912d3bc3757aa1d1ef71c4a19971bdc7ab66a6d31a9754fa82769ceaa";
async function verify(bytes: ArrayBuffer, hash: string) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  if (
    Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("") !== hash
  )
    throw new Error("设备资源校验失败，请检查文件版本。");
}
async function upload(
  io: UsbTransport,
  payload: Uint8Array<ArrayBuffer>,
  offset: number,
  mode: number,
) {
  await io.clear("out", 3);
  await io.register(reg.writeStart, offset);
  await io.register(reg.writeEnd, offset + payload.length);
  await io.register(reg.writeMode, mode);
  await io.send(3, payload, 30_000);
}
export async function prepare(
  io: UsbTransport,
  files: string[],
  status: (s: string) => void,
) {
  if (files.length !== fpgaHashes.length)
    throw new Error("PXLogic FPGA 资源数量错误。");
  await io.open();
  const fw = await io.register(reg.firmware);
  if (fw === 0x56900000) return null;
  if (fw !== 0x56900028)
    throw new Error(
      "未知 MCU 固件版本 0x" + fw.toString(16) + "，请核实设备型号与固件。",
    );
  const variant = await io.register(reg.variant);
  // Buffer capabilities are identical across link speeds. WebUSB does not
  // expose the negotiated speed, so don't guess it from the descriptor version.
  const profile = catalog.devices.find(
    (p) =>
      Number(p.match.vid) === io.device.vendorId &&
      Number(p.match.pid) === io.device.productId &&
      p.match.variant_code === variant,
  );
  if (!profile) throw new Error("设备型号未列入 PXLogic 直连支持列表。");
  const bufferModes = catalog.channel_modes
    .filter((m) => m.kind === "buffer" && profile.modes.includes(m.id))
    .map((m) => ({
      channels: m.channels,
      minRate: m.min_sample_rate_hz,
      maxRate: m.max_sample_rate_hz,
    }));
  if (!bufferModes.length) throw new Error("设备没有可用的缓冲采集模式。");
  const channels = Math.max(...bufferModes.map((m) => m.channels));
  const model = profile.model.replace(/ U[23] /, " ");
  // Verify both files before putting the FPGA into reset.
  const images = await Promise.all(
    files.map(async (url, i) => {
      const response = await fetch(url, { signal: io.signal });
      if (!response.ok)
        throw new Error("无法加载 FPGA bitfile (" + response.status + ")");
      const bytes = await response.arrayBuffer();
      await verify(bytes, fpgaHashes[i]);
      const padded = new Uint8Array(page(bytes.byteLength));
      padded.set(new Uint8Array(bytes));
      return padded;
    }),
  );
  for (const [i, image] of images.entries()) {
    status(i === 0 ? "正在复位 FPGA…" : "正在加载 FPGA 采集逻辑…");
    await upload(io, image, 0, 4);
  }
  await delay(100);
  io.signal.throwIfAborted();
  return { model, channels, bufferModes } satisfies CaptureProfile;
}
// Only offered after a verified PX identity and a known CH569 loader version.
// The binary is supplied by the user and pinned to the supported release.
export async function flash(io: UsbTransport, file: File) {
  if (file.size === 0 || file.size > 49152)
    throw new Error("MCU 镜像长度错误。");
  const bytes = await file.arrayBuffer();
  await verify(bytes, mcuHash);
  if ((await io.register(reg.firmware)) !== 0x56900000)
    throw new Error("设备已离开引导模式。");
  const payload = new Uint8Array(49152 * 3).fill(255);
  for (let i = 0; i < 3; i++) payload.set(new Uint8Array(bytes), i * 49152);
  await upload(io, payload, 49152, 0);
  // A reset may disconnect before its ACK. Reconnection and the version check
  // in prepare(), not an assumed ACK, determine success.
  try {
    await io.register(reg.reset, 0);
  } catch (e) {
    if (
      io.device.opened &&
      !(e instanceof DOMException && e.name === "NetworkError")
    )
      throw e;
  }
}
export async function acquire(
  io: UsbTransport,
  settings: Settings,
  profile: CaptureProfile,
  cancel: AbortSignal,
): Promise<Capture> {
  const { channels, count, threshold } = settings;
  if (
    ![4, 8, 16, 32].includes(channels) ||
    channels > profile.channels ||
    !depths.includes(count) ||
    !rates.includes(settings.rate) ||
    !thresholds.includes(threshold)
  )
    throw new Error("采集参数超出支持范围。");
  const modes = profile.bufferModes
    .filter((mode) => mode.channels >= channels)
    .sort((a, b) => a.channels - b.channels || a.maxRate - b.maxRate);
  const selected = modes.find(
    (mode) => settings.rate >= mode.minRate && settings.rate <= mode.maxRate,
  ) ?? modes[modes.length - 1];
  if (!selected) throw new Error("设备没有匹配当前通道数的缓冲采集模式。");
  const rate = Math.max(
    selected.minRate,
    Math.min(selected.maxRate, settings.rate),
  );
  const effectiveSettings = { ...settings, rate };
  const date = new Date().toISOString();
  const bytes = (count * channels) / 8;
  // Use the native High Speed cap for all links (DDR acquisition is decoupled
  // from readout). Never interpret USB version as negotiated bandwidth.
  const transfer =
    Math.min(
      page(rate / 800),
      Math.floor(page(600000) / channels / 4096) * 4096,
    ) * channels;
  const total = bytes + transfer;
  await io.register(reg.block, 0);
  await io.clear("in", 2);
  await io.clear("out", 4);
  await io.clear("in", 4);
  const script = [
    [reg.pwm, 12000],
    [reg.threshold, Math.floor(((threshold * 0.5) / 3.334) * 12000)],
    [reg.mask, 0],
    [reg.control, 5],
    [reg.control, 21],
    [reg.control, 5],
    [reg.run, stop],
    [reg.size, transfer],
    [reg.dma, transfer],
    [reg.bytesLow, total],
    [reg.bytesHigh, 0],
    [reg.ext, 0],
    [reg.triggerOut, 0],
    [reg.gpio, 7],
    [reg.div, 100_000_000 / rate - 1],
    [reg.lanes, channels],
    [reg.position, 64],
    [reg.block, 0],
    [reg.mask, 2 ** channels - 1],
    [reg.control, 0],
    [reg.zero, 0],
    [reg.one, 0],
    [reg.rise, 0],
    [reg.fall, 0],
    [reg.run, 0],
  ];
  let raw: Uint8Array<ArrayBuffer>;
  // Abort the wait, then stop acquisition on the independent register
  // endpoints. Worker cleanup closes the handle to cancel a pending DDR read.
  let interrupt!: () => void;
  const cancelled = new Promise<void>((resolve) => {
    interrupt = resolve;
  });
  cancel.addEventListener("abort", interrupt, { once: true });
  try {
    for (const [addr, value] of script) {
      cancel.throwIfAborted();
      await io.register(addr, value);
    }
    await Promise.race([
      delay(10 + Math.ceil((count * 1000) / rate)),
      cancelled,
    ]);
    cancel.throwIfAborted();
    await io.register(reg.readStart, 1);
    await io.register(reg.readEnd, 1 + page(total));
    await io.register(reg.readMode, 2);
    await io.clear("in", 3);
    raw = new Uint8Array(bytes);
    for (let offset = 0; offset < bytes;) {
      cancel.throwIfAborted();
      const part = await Promise.race([io.receive(3, transfer), cancelled]);
      if (!part) throw cancel.reason;
      const take = Math.min(part.byteLength, bytes - offset);
      raw.set(new Uint8Array(part.buffer, part.byteOffset, take), offset);
      offset += take;
    }
  } finally {
    cancel.removeEventListener("abort", interrupt);
    if (!io.signal.aborted) await io.register(reg.run, stop);
  }
  return {
    ...effectiveSettings,
    model: profile.model,
    date,
    ...unpack(raw, count, channels),
  };
}
function unpack(raw: Uint8Array, count: number, channels: number) {
  const unit = Math.ceil(channels / 8);
  const samples = new Uint8Array(count * unit);
  const edges: Uint32Array<ArrayBuffer>[] = [];
  const scratch = new Uint32Array(count);
  for (let lane = 0; lane < channels; lane++) {
    let previous = 0,
      length = 0;
    for (let n = 0; n < count; n++) {
      const offset = (n >>> 6) * channels * 8 + lane * 8 + ((n & 63) >>> 3);
      const high = (raw[offset] >>> (n & 7)) & 1;
      samples[n * unit + (lane >>> 3)] |= high << (lane & 7);
      if (n && high !== previous) scratch[length++] = n;
      previous = high;
    }
    edges.push(scratch.slice(0, length));
  }
  return { samples, edges };
}
