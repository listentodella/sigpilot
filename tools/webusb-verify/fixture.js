// Loaded only by the verification HTTP server, into both Window and Worker.
// Captured words are the sample index modulo 2^N, transformed into wire lanes.
(() => {
  const mode = globalThis.fixtureMode;
  if (mode === "unsupported") {
    Object.defineProperty(navigator, "usb", { value: undefined });
    return;
  }
  const bus = new EventTarget();
  const trace = (entry) =>
    fetch("/trace", { method: "POST", body: JSON.stringify(entry) });
  let authorized = false,
    cmd,
    addr,
    value,
    offset = 0,
    rejectRead;
  const registers = new Map();
  const config = {
    configurationValue: 1,
    interfaces: [
      {
        interfaceNumber: 0,
        alternate: { endpoints: ["out1", "in1", "in2"].map(ep) },
      },
      { interfaceNumber: 1, alternate: { endpoints: ["in3", "out3"].map(ep) } },
    ],
  };
  function ep(s) {
    return {
      direction: s.slice(0, -1),
      endpointNumber: Number(s.at(-1)),
      type: "bulk",
    };
  }
  const device = {
    vendorId: 0x16c0,
    productId: 0x05dc,
    manufacturerName: mode === "identity" ? "Other" : "PX_Tool",
    productName: "PX-Logic",
    serialNumber: "fixture",
    opened: false,
    configuration: null,
    configurations: [config],
    async open() {
      this.opened = true;
      await trace(["open"]);
    },
    async close() {
      this.opened = false;
      rejectRead?.(new Error("disconnected"));
      await trace(["close"]);
    },
    async selectConfiguration(n) {
      if (n !== 1) throw Error("wrong configuration");
      this.configuration = config;
    },
    async claimInterface(n) {
      await trace(["claim", n]);
      if (mode === "denied" && n === 1) throw Error("access denied");
    },
    async clearHalt() {},
    async transferOut(n, data) {
      if (!this.opened) throw Error("device closed");
      if (n === 3) {
        const hash = Array.from(
          new Uint8Array(await crypto.subtle.digest("SHA-256", data)),
          (b) => b.toString(16).padStart(2, "0"),
        ).join("");
        await trace(["payload", data.length, hash]);
        return { status: "ok", bytesWritten: data.length };
      }
      if (n !== 1 || data.length !== 16) throw Error("bad OUT packet");
      const d = new DataView(data.buffer, data.byteOffset, data.byteLength);
      cmd = d.getUint32(0, true);
      addr = d.getUint32(8, true);
      value = d.getUint32(12, true);
      if (d.getUint32(4, true) !== 8 || ![0xfefe0000, 0xfefe0001].includes(cmd))
        throw Error("bad register header");
      if (cmd === 0xfefe0000) {
        registers.set(addr, value);
        await trace(["write", addr, value]);
      }
      return { status: "ok", bytesWritten: 16 };
    },
    async transferIn(n, size) {
      if (n === 1) {
        const data = new DataView(new ArrayBuffer(mode === "short" ? 15 : 16));
        const fw = mode.startsWith("boot")
          ? 0x56900000
          : mode === "firmware"
            ? 0x1234
            : 0x56900028;
        if (data.byteLength === 16)
          data.setUint32(
            12,
            cmd === 0xfefe0000
              ? mode === "ack"
                ? 0
                : 0xfefefefe
              : addr === 8244
                ? fw
                : 1,
            true,
          );
        return { status: "ok", data };
      }
      if (n !== 3 || registers.get(8212) !== 2) throw Error("bad DDR request");
      if (mode === "timeout" || mode === "cancel" || mode === "unplug") {
        await trace(["pending"]);
        if (mode === "unplug")
          setTimeout(
            () =>
              bus.dispatchEvent(
                Object.assign(new Event("disconnect"), { device }),
              ),
            20,
          );
        return new Promise((_, reject) => {
          rejectRead = reject;
        });
      }
      const lanes = registers.get(8268);
      // Deliberately fragment the first lane stripe and overrun the final sample.
      const bytes = new Uint8Array(Math.min(offset === 0 ? 13 : size, 16384));
      for (let j = 0; j < bytes.length; j++, offset++) {
        const lane = Math.floor(offset / 8) % lanes;
        const start = Math.floor(offset / (8 * lanes)) * 64 + (offset % 8) * 8;
        for (let bit = 0; bit < 8; bit++)
          bytes[j] |= (((start + bit) >>> lane) & 1) << bit;
      }
      return { status: "ok", data: new DataView(bytes.buffer) };
    },
  };
  bus.getDevices = async () =>
    typeof document === "undefined"
      ? mode === "ambiguous"
        ? [device, { ...device }]
        : [device]
      : !authorized
        ? []
        : mode === "ambiguous"
          ? [device, { ...device }]
          : [device];
  bus.requestDevice = async ({ filters }) => {
    if (
      !filters.some(
        (f) =>
          f.vendorId === device.vendorId && f.productId === device.productId,
      )
    )
      throw Error("incorrect filters");
    if (mode === "dismiss")
      throw new DOMException("no selection", "NotFoundError");
    authorized = true;
    return device;
  };
  Object.defineProperty(navigator, "usb", { value: bus });
})();
