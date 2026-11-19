import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  Cable,
  Download,
  Play,
  Unplug,
  Usb,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import resetUrl from "../../resources/bitstreams/hspi_ddr_RST.bin?url";
import mainUrl from "../../resources/bitstreams/hspi_ddr.bin?url";
import licenseUrl from "../../resources/bitstreams/LICENSE.txt?url";
import { WaveformCanvas } from "../components/WaveformCanvas";
import {
  depths,
  rates,
  thresholds,
  type Capture,
  type Reply,
  type Request,
  type Settings,
} from "./model";
import { filters, identify, usbBus } from "./usb";
import { level, nextEdge, savePxcap, tileFor } from "./waveform";

type Phase =
  | "idle"
  | "choosing"
  | "connecting"
  | "ready"
  | "capturing"
  | "boot"
  | "flashing"
  | "closing";
const rateLabel = (rate: number) =>
  rate < 1e6 ? rate / 1000 + " kHz" : rate / 1e6 + " MHz";
function PlatformHelp() {
  return (
    <details className="usbHelp">
      <summary>连接条件与系统驱动</summary>
      <p>
        通过 HTTPS 或 localhost，用支持 WebUSB 的 Chrome 或 Edge
        打开此页。先退出占用分析仪的桌面软件。
      </p>
      <dl>
        <dt>Windows</dt>
        <dd>
          采集所需的 USB 接口 0 和 1 均需绑定
          WinUSB。请检查设备管理器中的驱动与厂商提供的安装说明。
        </dd>
        <dt>Linux</dt>
        <dd>
          当前用户需要 USB 设备的读写权限。安装匹配本机设备 VID/PID 的 udev
          规则，再重新插拔。
        </dd>
        <dt>macOS</dt>
        <dd>
          通过系统 USB
          栈访问。所需接口需同时空闲，请退出占用接口的程序或检查厂商驱动。
        </dd>
      </dl>
      <p>固件更新后若设备重新枚举，请再次点击连接并选择运行态设备。</p>
      <a href={licenseUrl} target="_blank" rel="noreferrer">
        FPGA bitfile 许可
      </a>
    </details>
  );
}
function Waveform({ c }: { c: Capture }) {
  const [width, setWidth] = useState(800);
  const [view, setView] = useState({ start: 0, count: c.count });
  const [ch, setCh] = useState(0),
    [cursor, setCursor] = useState(0);
  const rows = useMemo(
    () => Array.from({ length: c.channels }, () => 62),
    [c.channels],
  );
  const tile = useMemo(
    () => tileFor(c, view.start, view.count, width),
    [c, view, width],
  );
  function viewport(start: number, span: number) {
    const count = Math.max(1, Math.min(c.count, Math.round(span)));
    const clipped = Math.min(c.count - count, Math.max(0, Math.round(start)));
    setView((old) =>
      old.start === clipped && old.count === count
        ? old
        : { start: clipped, count },
    );
  }
  function jump(n: number) {
    setCursor(n);
    if (n < view.start || n >= view.start + view.count)
      viewport(n - view.count / 2, view.count);
  }
  const prev = nextEdge(c, ch, cursor, false),
    next = nextEdge(c, ch, cursor, true);
  return (
    <>
      <div className="usbWaveTools">
        <strong>数字波形</strong>
        <span>
          {c.channels} 通道 · {rateLabel(c.rate)} · {c.count.toLocaleString()}{" "}
          样点
        </span>
        <button
          aria-label="放大"
          onClick={() => viewport(cursor - view.count / 4, view.count / 2)}
        >
          <ZoomIn size={15} />
        </button>
        <button
          aria-label="缩小"
          onClick={() => viewport(cursor - view.count, view.count * 2)}
        >
          <ZoomOut size={15} />
        </button>
        <button onClick={() => viewport(0, c.count)}>全览</button>
        <button id="save" onClick={() => savePxcap(c)}>
          <Download size={14} />
          保存 .pxcap
        </button>
      </div>
      <div className="remoteWaveScroll">
        <div
          className="remoteWaveRows"
          style={{ height: c.channels * 62 + 28 }}
        >
          <div className="remoteChannelLabels">
            {rows.map((_, i) => (
              <div key={i}>D{i}</div>
            ))}
          </div>
          <div
            className="remoteWaveCanvas"
            data-start={view.start}
            data-span={view.count}
          >
            <WaveformCanvas
              sessionId={"usb-" + c.date}
              rowHeights={rows}
              tile={tile}
              onWidthChange={setWidth}
              sampleRateHz={c.rate}
              totalSamples={c.count}
              showInteractiveMeasurement={false}
              showGridLines
              viewportStart={view.start}
              viewportSamples={view.count}
              onViewportChange={viewport}
              onOpenContextMenu={(e) => {
                setCh(e.channelIndex);
                jump(Math.max(0, Math.min(c.count - 1, Math.round(e.sample))));
              }}
            />
            {cursor >= view.start && cursor < view.start + view.count && (
              <div
                className="usbCursor"
                style={{
                  left: ((cursor - view.start) / view.count) * 100 + "%",
                }}
              />
            )}
          </div>
        </div>
      </div>
      <div className="usbInspect">
        <label>
          测量通道
          <select value={ch} onChange={(e) => setCh(Number(e.target.value))}>
            {rows.map((_, i) => (
              <option key={i} value={i}>
                D{i}
              </option>
            ))}
          </select>
        </label>
        <label>
          游标样点
          <input
            id="sample"
            type="number"
            min={0}
            max={c.count - 1}
            value={cursor}
            onChange={(e) =>
              jump(
                Math.max(0, Math.min(c.count - 1, Math.trunc(+e.target.value))),
              )
            }
          />
        </label>
        <output id="level">
          D{ch} = {Number(level(c, ch, cursor))} ·{" "}
          {((cursor / c.rate) * 1e6).toLocaleString(undefined, {
            maximumFractionDigits: 3,
          })}{" "}
          µs
        </output>
        <button disabled={prev === undefined} onClick={() => jump(prev)}>
          上一边沿
        </button>
        <button
          id="next"
          disabled={next === undefined}
          onClick={() => jump(next)}
        >
          下一边沿
        </button>
      </div>
    </>
  );
}
export function WebUsbWorkbench() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [status, setStatus] = useState("等待连接分析仪"),
    [model, setModel] = useState("");
  const [maxChannels, setMaxChannels] = useState(32);
  const [settings, setSettings] = useState<Settings>({
    channels: 8,
    rate: 1e6,
    count: 16384,
    threshold: 2,
  });
  const [capture, setCapture] = useState<Capture | null>(null);
  const [firmware, setFirmware] = useState<File | null>(null);
  const worker = useRef<Worker | null>(null);
  const supported = window.isSecureContext && !!usbBus();
  useEffect(() => {
    const release = () => {
      worker.current?.terminate();
      worker.current = null;
    };
    const leave = () => {
      release();
      setPhase("idle");
      setModel("");
      setStatus("页面已离开，请重新连接设备。");
    };
    window.addEventListener("pagehide", leave);
    return () => {
      window.removeEventListener("pagehide", leave);
      release();
    };
  }, []);
  const post = (req: Request) => worker.current?.postMessage(req);
  async function connect() {
    setPhase("choosing");
    setFirmware(null);
    try {
      // requestDevice must be invoked directly by the user's click, in Window.
      const device = await usbBus()!.requestDevice({ filters });
      const w = new Worker(new URL("./device.worker.ts", import.meta.url), {
        type: "module",
      });
      worker.current = w;
      function finish(message: string) {
        if (worker.current !== w) return;
        w.terminate();
        worker.current = null;
        setPhase("idle");
        setModel("");
        setStatus(message);
      }
      w.onerror = (event) => finish(event.message || "USB Worker 无法启动。");
      w.onmessage = (event: MessageEvent<Reply>) => {
        if (worker.current !== w) return;
        const reply = event.data;
        if (reply.kind === "closed") {
          finish(reply.message);
          return;
        }
        if (reply.kind === "status") setStatus(reply.message);
        if (reply.kind === "boot") {
          setPhase("boot");
          setStatus("已识别 CH569 引导模式");
        }
        if (reply.kind === "ready") {
          setMaxChannels(reply.channels);
          setSettings((old) => ({
            ...old,
            channels: Math.min(old.channels, reply.channels),
          }));
          setModel(reply.model);
          setStatus("设备就绪");
          setPhase("ready");
        }
        if (reply.kind === "capture") {
          setCapture(reply.capture);
          setStatus("采集完成");
          setPhase("ready");
        }
      };
      setPhase("connecting");
      setStatus("正在核验设备身份与固件…");
      post({
        kind: "connect",
        device: identify(device),
        files: [resetUrl, mainUrl].map(
          (u) => new URL(u, document.baseURI).href,
        ),
      });
    } catch (e) {
      setPhase("idle");
      setStatus(
        e instanceof DOMException && e.name === "NotFoundError"
          ? "未选择设备，可以重新连接。"
          : String(e),
      );
    }
  }
  function runCapture() {
    setPhase("capturing");
    setStatus("正在缓冲采集…");
    post({ kind: "capture", settings });
  }
  const close = () => {
    setPhase("closing");
    setStatus("正在释放 USB 接口…");
    post({ kind: "close" });
  };
  function select(
    label: string,
    key: keyof Settings,
    choices: number[],
    display: (n: number) => string = String,
  ) {
    return (
      <label>
        {label}
        <select
          name={key}
          value={settings[key]}
          disabled={phase !== "idle" && phase !== "ready"}
          onChange={(e) =>
            setSettings({ ...settings, [key]: Number(e.target.value) })
          }
        >
          {choices.map((v) => (
            <option key={v} value={v}>
              {display(v)}
            </option>
          ))}
        </select>
      </label>
    );
  }
  return (
    <main className="remoteWorkbench usbWorkbench" data-phase={phase}>
      <header className="usbHeader">
        <Activity size={24} />
        <strong>SigPilot</strong>
        <span>WebUSB 工作台</span>
      </header>
      <div className="usbLayout">
        <aside>
          <h2>
            <Usb size={18} /> 本机设备
          </h2>
          {model && <strong>{model}</strong>}
          <p role="status">
            {!supported
              ? !window.isSecureContext
                ? "请通过 HTTPS 或 localhost 打开此页。"
                : "当前浏览器未提供 WebUSB。请使用支持此功能的 Chrome 或 Edge。"
              : status}
          </p>
          {phase === "idle" || phase === "choosing" ? (
            <button
              className="remotePrimary"
              id="connect"
              disabled={!supported || phase !== "idle"}
              onClick={connect}
            >
              <Cable size={15} />
              连接 USB 分析仪
            </button>
          ) : (
            <button
              id="disconnect"
              disabled={phase === "closing" || phase === "flashing"}
              onClick={close}
            >
              <Unplug size={15} />
              {phase === "capturing" ? "取消采集并断开" : "断开连接"}
            </button>
          )}
          {phase === "boot" || phase === "flashing" ? (
            <section>
              <h2>更新 MCU 固件</h2>
              <p>
                此操作会写入设备并使 USB 重新枚举。请选择 PXLogic 的
                SCI_LOGIC.bin，写入完成前请保持供电。
              </p>
              <input
                aria-label="MCU 固件"
                type="file"
                accept=".bin"
                disabled={phase !== "boot"}
                onChange={(e) => setFirmware(e.target.files?.[0] ?? null)}
              />
              <button
                id="flash"
                disabled={!firmware || phase !== "boot"}
                onClick={() => {
                  if (firmware) {
                    setPhase("flashing");
                    setStatus("正在写入 MCU 固件…");
                    post({ kind: "flash", file: firmware });
                  }
                }}
              >
                写入固件并重启设备
              </button>
            </section>
          ) : (
            <section>
              <h2>缓冲采集</h2>
              {select("采样率", "rate", rates, rateLabel)}
              {select(
                "输入通道",
                "channels",
                [4, 8, 16, 32].filter((n) => n <= maxChannels),
                (n) => "D0 – D" + (n - 1),
              )}
              {select(
                "采集深度",
                "count",
                depths,
                (n) => n.toLocaleString() + " 样点",
              )}
              {select("阈值电压", "threshold", thresholds, (n) => n + " V")}
              <button
                id="capture"
                className="remotePrimary"
                disabled={phase !== "ready"}
                onClick={runCapture}
              >
                <Play size={14} />
                开始采集
              </button>
            </section>
          )}
          <PlatformHelp />
        </aside>
        <article>
          {capture ? (
            <Waveform key={capture.date} c={capture} />
          ) : (
            <div className="usbEmpty">
              <Activity size={36} />
              <h2>等待第一段波形</h2>
              <p>连接本机 PXLogic 分析仪，设置采样率后开始采集。</p>
            </div>
          )}
        </article>
      </div>
    </main>
  );
}
