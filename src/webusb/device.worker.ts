import { acquire, flash, prepare } from "./pxlogic";
import type { Request, Reply } from "./model";
import { sameDevice, usbBus, UsbTransport, type UsbDevice } from "./usb";

const send = (reply: Reply, transfer: Transferable[] = []) =>
  (self as unknown as Worker).postMessage(reply, transfer);
let io: UsbTransport | undefined;
let profile: import("./model").CaptureProfile | null = null;
let captureCancel: AbortController | undefined;
let busy = false,
  closed = false,
  inBootloader = false,
  flashing = false;
async function finish(message: string) {
  if (closed) return;
  closed = true;
  await io?.close();
  send({ kind: "closed", message });
}
usbBus()?.addEventListener("disconnect", (event) => {
  if ((event as Event & { device: UsbDevice }).device === io?.device)
    void finish(
      flashing
        ? "设备已离线，请等待重新枚举，再连接以核验 MCU 版本。"
        : "USB 设备已拔出。",
    );
});
self.onmessage = async (event: MessageEvent<Request>) => {
  const req = event.data;
  if (req.kind === "close") {
    if (captureCancel)
      captureCancel.abort(new Error("采集已取消，USB 已断开。"));
    else await finish("已断开 USB 连接。");
    return;
  }
  if (busy || closed) return;
  busy = true;
  try {
    if (req.kind === "connect" && !io) {
      const bus = usbBus();
      if (!bus)
        throw new Error(
          "此浏览器未向 Worker 提供 WebUSB。请使用桌面版 Chrome 或 Edge。",
        );
      const matches = (await bus.getDevices()).filter((d) =>
        sameDevice(d, req.device),
      );
      if (closed) return;
      if (matches.length !== 1)
        throw new Error(
          "无法唯一识别授权的设备，请仅保留一个同型号设备后重新选择。",
        );
      io = new UsbTransport(matches[0]);
      profile = await prepare(io, req.files, (message) =>
        send({ kind: "status", message }),
      );
      inBootloader = !profile;
      if (!closed)
        send(profile ? { kind: "ready", ...profile } : { kind: "boot" });
    } else if (req.kind === "capture" && io && profile) {
      captureCancel = new AbortController();
      const capture = await acquire(
        io,
        req.settings,
        profile,
        captureCancel.signal,
      );
      captureCancel.signal.throwIfAborted();
      if (!closed)
        send({ kind: "capture", capture }, [
          capture.samples.buffer,
          ...capture.edges.map((e) => e.buffer),
        ]);
    } else if (req.kind === "flash" && io && inBootloader) {
      flashing = true;
      await flash(io, req.file);
      await finish("已提交 MCU 更新。等待设备重新枚举，再点击连接以核验版本。");
    }
  } catch (e) {
    await finish(e instanceof Error ? e.message : String(e));
  } finally {
    busy = false;
    captureCancel = undefined;
  }
};
