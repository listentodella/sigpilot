// WebUSB is not in TypeScript's default DOM library. Keep this surface limited
// to the standard methods used by our window and dedicated worker.
export interface UsbId {
  vendorId: number;
  productId: number;
  serialNumber?: string;
  manufacturerName?: string;
  productName?: string;
}
interface Endpoint {
  endpointNumber: number;
  direction: "in" | "out";
  type: string;
}
interface Configuration {
  configurationValue: number;
  interfaces: {
    interfaceNumber: number;
    alternate: { endpoints: Endpoint[] };
  }[];
}
export interface UsbDevice extends UsbId {
  opened: boolean;
  configuration: Configuration | null;
  configurations: Configuration[];
  open(): Promise<void>;
  close(): Promise<void>;
  selectConfiguration(value: number): Promise<void>;
  claimInterface(id: number): Promise<void>;
  clearHalt(direction: "in" | "out", endpoint: number): Promise<void>;
  transferIn(
    endpoint: number,
    size: number,
  ): Promise<{ status: string; data?: DataView }>;
  transferOut(
    endpoint: number,
    bytes: Uint8Array<ArrayBuffer>,
  ): Promise<{ status: string; bytesWritten: number }>;
}
export interface UsbBus extends EventTarget {
  requestDevice(options: {
    filters: { vendorId: number; productId: number }[];
  }): Promise<UsbDevice>;
  getDevices(): Promise<UsbDevice[]>;
}
export function usbBus(): UsbBus | undefined {
  return (navigator as Navigator & { usb?: UsbBus }).usb;
}
export const filters = [
  { vendorId: 0x1a86, productId: 0x5237 },
  { vendorId: 0x16c0, productId: 0x05dc },
];
export function identify(d: UsbId): UsbId {
  return {
    vendorId: d.vendorId,
    productId: d.productId,
    serialNumber: d.serialNumber,
    manufacturerName: d.manufacturerName,
    productName: d.productName,
  };
}
export function sameDevice(a: UsbId, b: UsbId) {
  return (
    a.vendorId === b.vendorId &&
    a.productId === b.productId &&
    a.serialNumber === b.serialNumber &&
    a.productName === b.productName &&
    a.manufacturerName === b.manufacturerName
  );
}

export class UsbTransport {
  readonly controller = new AbortController();
  get signal() {
    return this.controller.signal;
  }
  constructor(readonly device: UsbDevice) {}

  // Close releases both claimed interfaces and aborts outstanding bulk reads.
  // Always check cancellation after open: a late open can succeed after a timeout.
  async close() {
    this.controller.abort();
    if (this.device.opened) await this.device.close().catch(() => {});
  }
  private async io<T>(run: () => Promise<T>, timeout = 3000): Promise<T> {
    this.signal.throwIfAborted();
    let abort = () => {};
    const interrupted = new Promise<never>((_, reject) => {
      abort = () => reject(this.signal.reason);
      this.signal.addEventListener("abort", abort, { once: true });
    });
    const timer = setTimeout(() => {
      this.controller.abort(new Error("USB 传输超时，请重新连接分析仪。"));
      void this.close();
    }, timeout);
    try {
      return await Promise.race([run(), interrupted]);
    } finally {
      clearTimeout(timer);
      this.signal.removeEventListener("abort", abort);
    }
  }
  async open() {
    const d = this.device;
    if (
      !filters.some(
        (f) => f.vendorId === d.vendorId && f.productId === d.productId,
      ) ||
      !d.manufacturerName?.startsWith("PX")
    )
      throw new Error("设备身份与 PXLogic 不符。");
    await this.io(async () => {
      await d.open();
      if (this.signal.aborted) {
        await this.close();
        this.signal.throwIfAborted();
      }
    });
    if (!d.configuration) await this.io(() => d.selectConfiguration(1));
    const interfaces =
      d.configuration?.interfaces.filter((i) =>
        [0, 1].includes(i.interfaceNumber),
      ) ?? [];
    const endpoints = interfaces.flatMap((i) =>
      i.alternate.endpoints
        .filter((e) => e.type === "bulk")
        .map((e) => e.direction + e.endpointNumber),
    );
    if (
      interfaces.length !== 2 ||
      !["in1", "out1", "in3", "out3"].every((e) => endpoints.includes(e))
    )
      throw new Error("USB 接口或端点与 PXLogic 配置不符。");
    for (const id of [0, 1]) {
      try {
        await this.io(() => d.claimInterface(id));
      } catch (e) {
        throw new Error(
          "无法占用 USB 接口 " +
            id +
            "。请检查系统驱动、权限及占用程序。 " +
            String(e),
        );
      }
    }
  }
  async clear(direction: "in" | "out", endpoint: number) {
    // Older firmware lacks some optional stream endpoints. A missing clear is
    // nonfatal, but a cancelled or timed-out session must never be reused.
    try {
      await this.io(() => this.device.clearHalt(direction, endpoint));
    } catch {
      this.signal.throwIfAborted();
    }
  }
  async send(ep: number, data: Uint8Array<ArrayBuffer>, timeout?: number) {
    const r = await this.io(() => this.device.transferOut(ep, data), timeout);
    if (r.status !== "ok" || r.bytesWritten !== data.length)
      throw new Error("USB 写入不完整，端点 " + ep);
  }
  async receive(ep: number, size: number) {
    const r = await this.io(() => this.device.transferIn(ep, size));
    if (
      r.status !== "ok" ||
      !r.data ||
      !r.data.byteLength ||
      r.data.byteLength > size
    )
      throw new Error("USB 读取失败，端点 " + ep + " (" + r.status + ")");
    return r.data;
  }
  async register(addr: number, value?: number) {
    const bytes = new Uint8Array(16);
    const view = new DataView(bytes.buffer);
    [
      value === undefined ? 0xfefe0001 : 0xfefe0000,
      8,
      addr,
      value ?? 0,
    ].forEach((v, i) => view.setUint32(i * 4, v, true));
    await this.send(1, bytes);
    const reply = await this.receive(1, 16);
    if (reply.byteLength !== 16) throw new Error("USB 寄存器应答长度错误。");
    const result = reply.getUint32(12, true);
    if (value !== undefined && result !== 0xfefefefe)
      throw new Error("USB 寄存器未确认写入 " + addr);
    return result;
  }
}
