import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Activity,
  Download,
  Globe,
  LogOut,
  Plus,
  RefreshCw,
  Upload,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { WaveformCanvas } from "./WaveformCanvas";
import type {
  AnalyzerDecodeSettings,
  AnalyzerFrameTableWindow,
  CaptureSettings,
  DeviceInfo,
  DigitalPointMeasurement,
  HardwareCaptureCapabilities,
  WaveformTile,
} from "../lib/api";
import {
  exactUiSample,
  type AnnotationInput,
  type AnnotationOperation,
  type AnnotationResult,
  type WorkbenchAnnotation,
  type WorkbenchSnapshot,
} from "../lib/workbench";
import {
  readRemoteSnapshot,
  remoteCapabilities,
  remoteDevices,
  remoteFrame,
  remoteId,
  remoteJson,
  remoteRequest,
  RemoteError,
  sessionPath,
  type RemoteConnection,
  type RemoteSessions,
} from "../lib/remote";
import { normalizeCaptureViewport } from "../lib/captureViewport";

const blankMarker = (): AnnotationInput => ({
  kind: "timing_point",
  sample: "5",
  title: "",
  note: "",
  color: "#e6b35a",
  tags: [],
  evidence_refs: [],
});
const captureRef = (s: WorkbenchSnapshot) => ({
  session_id: s.context.session_id,
  capture_id: s.context.capture_id,
  data_revision: s.context.data_revision,
});
const isAbort = (e: unknown) =>
  e instanceof DOMException && e.name === "AbortError";

export function RemoteWorkbench() {
  const { t, i18n } = useTranslation("remote");
  const [connection, setConnection] = useState<RemoteConnection | null>(null);
  const [code, setCode] = useState(""),
    [name, setName] = useState("Browser");
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [online, setOnline] = useState(true);
  const [listing, setListing] = useState<RemoteSessions>({
    sessions: [],
    captures: [],
  });
  const [selected, setSelected] = useState("");
  const [snapshot, setSnapshot] = useState<WorkbenchSnapshot | null>(null);
  const [tick, setTick] = useState(0),
    [tile, setTile] = useState<WaveformTile | null>(null),
    [width, setWidth] = useState(1000);
  const [view, setView] = useState({ start_sample: 0, samples: 1000 });
  const [jumpStart, setJumpStart] = useState("0"),
    [jumpSpan, setJumpSpan] = useState("1000");
  const [tab, setTab] = useState<"markers" | "decode" | "acquire">("markers");
  const [marker, setMarker] = useState<AnnotationInput>(blankMarker),
    [editing, setEditing] = useState<string | null>(null);
  const editingRevision = useRef<string | null>(null);
  const [undo, setUndo] = useState<{
    batch: string;
    revision: string;
    session: string;
  } | null>(null);
  const [measurement, setMeasurement] = useState<
    DigitalPointMeasurement | null | undefined
  >();
  const [devices, setDevices] = useState<DeviceInfo[]>([]),
    [device, setDevice] = useState("");
  const [caps, setCaps] = useState<HardwareCaptureCapabilities | null>(null);
  const [rate, setRate] = useState(1000000),
    [channels, setChannels] = useState(4),
    [duration, setDuration] = useState(10),
    [buffer, setBuffer] = useState(16);
  const [mode, setMode] = useState<"Buffer" | "Stream">("Buffer"),
    [threshold, setThreshold] = useState(2);
  const [protocol, setProtocol] = useState("uart"),
    [query, setQuery] = useState(""),
    [page, setPage] = useState(0);
  const [decodeRows, setDecodeRows] = useState<AnalyzerFrameTableWindow | null>(
    null,
  );
  const [parameters, setParameters] = useState({
    channel: 0,
    baud: 115200,
    sda: 0,
    scl: 1,
    clock: 2,
    mosi: "0",
    miso: "1",
    enable: "3",
    inverted: false,
    dataBits: 8,
    stopBits: 1,
    parity: "none",
    msb: false,
    cpol: false,
    cpha: false,
    bits: 8,
    activeLow: true,
  });
  const fileInput = useRef<HTMLInputElement>(null);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const refresh = useCallback(() => setTick((v) => v + 1), []);
  const fail = useCallback((e: unknown) => {
    if (isAbort(e)) return;
    if (e instanceof RemoteError && e.status === 401) {
      setConnection(null);
      setSnapshot(null);
      setTile(null);
    }
    setError(String(e instanceof Error ? e.message : e));
  }, []);
  async function action(f: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await f();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    const abort = new AbortController();
    void remoteJson<RemoteConnection>("/connection", undefined, abort.signal)
      .then(setConnection)
      .catch((e) => {
        if (!isAbort(e) && !(e instanceof RemoteError && e.status === 401))
          fail(e);
      });
    return () => abort.abort();
  }, [fail]);
  useEffect(() => {
    if (!connection) return;
    const abort = new AbortController();
    let cursor = "0";
    const offline = () => setOnline(false);
    window.addEventListener("offline", offline);
    window.addEventListener("online", refresh);
    const run = async () => {
      let backoff = 1000;
      while (!abort.signal.aborted) {
        try {
          const events = await remoteJson<{
            sequence: string;
            resync: boolean;
            events: unknown[];
          }>("/events", { after: cursor }, abort.signal);
          cursor = events.sequence;
          setOnline(navigator.onLine);
          backoff = 1000;
          // Coalesce bursts: a slow browser cannot create an unbounded event queue.
          refresh();
          if (events.resync || events.events.length) {
            await new Promise((r) => setTimeout(r, 200));
          }
        } catch (e) {
          if (isAbort(e)) break;
          if (e instanceof RemoteError && e.status === 401) {
            fail(e);
            break;
          }
          setOnline(false);
          await new Promise((r) => setTimeout(r, backoff));
          backoff = Math.min(5000, backoff * 2);
          if (!abort.signal.aborted) refresh();
        }
      }
    };
    void run();
    return () => {
      abort.abort();
      window.removeEventListener("offline", offline);
      window.removeEventListener("online", refresh);
    };
  }, [connection, fail, refresh]);
  useEffect(() => {
    if (!connection) return;
    const abort = new AbortController();
    void remoteJson<RemoteSessions>("/sessions", undefined, abort.signal)
      .then((v) => {
        setListing(v);
        setOnline(navigator.onLine);
        setSelected((old) =>
          v.sessions.some((s) => s.id === old) ||
          v.captures.some((j) => j.session_id === old && j.state === "running")
            ? old
            : (v.sessions[0]?.id ?? ""),
        );
      })
      .catch((e) => {
        if (!isAbort(e)) {
          setOnline(false);
          fail(e);
        }
      });
    return () => abort.abort();
  }, [connection, tick, fail]);
  useEffect(() => {
    setSnapshot(null);
    setTile(null);
    setUndo(null);
    setDecodeRows(null);
    setMeasurement(undefined);
    setEditing(null);
  }, [selected]);
  const listed = listing.sessions.some((session) => session.id === selected);
  useEffect(() => {
    if (!connection || !selected || !listed) return;
    const abort = new AbortController();
    void readRemoteSnapshot(selected, abort.signal)
      .then((v) => {
        try {
          exactUiSample(v.context.sample_count);
          exactUiSample(v.context.sample_rate_hz);
        } catch {
          throw new Error(t("precision"));
        }
        setSnapshot(v);
      })
      .catch(fail);
    return () => abort.abort();
  }, [connection, selected, listed, tick, fail, t]);
  const context = snapshot?.context;
  const total = context ? exactUiSample(context.sample_count) : 0;
  const sampleRate = context ? exactUiSample(context.sample_rate_hz) : 1;
  const channelList = context?.enabled_channels ?? [];
  const currentSession = listing.sessions.find((s) => s.id === selected);
  useEffect(() => {
    if (context?.capture_id) {
      setView({
        start_sample: 0,
        samples: Math.max(1, Math.min(total, 10000)),
      });
      setTile(null);
    }
  }, [context?.capture_id]);
  const viewport = useCallback(
    (start: number, samples: number) => {
      const v = normalizeCaptureViewport(start, samples, total);
      setView({
        start_sample: Math.max(0, Math.round(v.start)),
        samples: Math.max(1, Math.round(v.samples)),
      });
    },
    [total],
  );
  useEffect(() => {
    setJumpStart(String(Math.round(view.start_sample)));
    setJumpSpan(String(Math.round(view.samples)));
  }, [view]);
  useEffect(() => {
    if (!snapshot || !total || !online) return;
    const abort = new AbortController();
    const timer = setTimeout(() => {
      void remoteFrame(
        selected,
        captureRef(snapshot),
        {
          frame_id: tick,
          waveform: {
            start_sample: Math.floor(view.start_sample),
            sample_count: Math.ceil(view.samples),
            pixels: Math.max(1, Math.min(4096, Math.round(width))),
            channels: channelList,
          },
          analyzers: [],
        },
        abort.signal,
      )
        .then((v) => setTile(v.tile))
        .catch((e) => {
          if (e instanceof RemoteError && e.status === 409) {
            refresh();
          } else fail(e);
        });
    }, 65);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [snapshot, selected, view, width, online, tick, fail, refresh]);
  useEffect(() => {
    if (!connection) return;
    let active = true;
    void remoteDevices()
      .then((v) => {
        if (active) {
          setDevices(v);
          setDevice((old) => old || v.find((d) => d.ready)?.id || "");
        }
      })
      .catch(fail);
    return () => {
      active = false;
    };
  }, [connection, fail]);
  useEffect(() => {
    if (!device) return;
    let active = true;
    void remoteCapabilities(device)
      .then((v) => {
        if (active) {
          setCaps(v);
          setChannels(Math.min(32, v.default_channel_count));
          setRate(v.default_sample_rate_hz);
          setThreshold(v.threshold_volts[0] ?? 2);
        }
      })
      .catch(fail);
    return () => {
      active = false;
    };
  }, [device, fail]);

  function jump(sample: string, span?: number) {
    viewport(exactUiSample(sample), span ?? view.samples);
  }
  function formatSample(sample: string | number) {
    return `${sample} · ${((Number(sample) / sampleRate) * 1e6).toLocaleString(undefined, { maximumFractionDigits: 3 })} μs`;
  }
  async function mutate(operations: AnnotationOperation[]) {
    if (!snapshot) return;
    const id = selected;
    const revision = operations.some((op) => op.op === "update")
      ? editingRevision.current
      : snapshot.context.annotation_revision;
    const result = await remoteJson<AnnotationResult>(
      sessionPath(id, "annotations"),
      {
        capture: captureRef(snapshot),
        expected_annotation_revision: revision,
        request_id: remoteId(),
        operations,
      },
    );
    if (selectedRef.current === id) {
      setUndo(
        result.batch_id
          ? {
              batch: result.batch_id,
              revision: result.annotation_revision,
              session: id,
            }
          : null,
      );
      setSnapshot(await readRemoteSnapshot(id));
      setEditing(null);
      setMarker(blankMarker());
    }
    refresh();
  }
  function protocolSettings(): AnalyzerDecodeSettings {
    const optional = (value: string) => (value === "" ? null : Number(value));
    if (protocol === "i2c")
      return {
        protocol: "I2c",
        settings: { sda_channel: parameters.sda, scl_channel: parameters.scl },
      };
    if (protocol === "spi")
      return {
        protocol: "Spi",
        settings: {
          mosi_channel: optional(parameters.mosi),
          miso_channel: optional(parameters.miso),
          clock_channel: parameters.clock,
          enable_channel: optional(parameters.enable),
          enable_active_low: parameters.activeLow,
          clock_polarity: parameters.cpol,
          clock_phase: parameters.cpha,
          bits_per_transfer: parameters.bits,
          msb_first: parameters.msb,
        },
      };
    return {
      protocol: "Uart",
      settings: {
        channel: parameters.channel,
        baud_rate: parameters.baud,
        inverted: parameters.inverted,
        data_bits: parameters.dataBits,
        stop_bits: parameters.stopBits,
        parity: parameters.parity as "none" | "even" | "odd",
        msb_first: parameters.msb,
      },
    };
  }
  async function search(nextPage: number) {
    if (!snapshot) return;
    const id = selected;
    const rows = await remoteJson<AnalyzerFrameTableWindow>(
      sessionPath(id, "decode"),
      {
        capture: captureRef(snapshot),
        settings: protocolSettings(),
        query,
        start: nextPage * 50,
        end: (nextPage + 1) * 50,
      },
    );
    if (selectedRef.current === id) {
      setDecodeRows(rows);
      setPage(nextPage);
    }
  }
  async function startCapture() {
    const settings: CaptureSettings = {
      device_id: device,
      sample_rate_hz: rate,
      channel_count: channels,
      enabled_channels: Array.from({ length: channels }, (_, i) => i),
      duration_ms: duration,
      buffer_size_mb: buffer,
      decode_cross: true,
      threshold_volts: threshold,
      external_trigger_mode: "Close",
      mode,
      trigger_enabled: false,
      trigger_channel: 0,
      trigger_kind: "Rising",
      trigger_high_mask: 0,
      trigger_low_mask: 0,
      trigger_position_percent: 50,
      glitch_filter_enabled: false,
      clock_edge: false,
      trigger_out_enabled: false,
    };
    const job = await remoteJson<{ session_id: string }>("/captures", {
      settings,
    });
    setSelected(job.session_id);
    refresh();
  }
  const numberField = (
    label: string,
    value: number,
    onChange: (v: number) => void,
    min = 0,
    max?: number,
  ) => (
    <label>
      {t(label)}
      <input
        type="number"
        step={label === "stopBits" || label === "threshold" ? "any" : 1}
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
  const parameterNumber = (
    label: string,
    key:
      | "channel"
      | "baud"
      | "sda"
      | "scl"
      | "clock"
      | "dataBits"
      | "stopBits"
      | "bits",
  ) =>
    numberField(label, parameters[key], (v) =>
      setParameters((p) => ({ ...p, [key]: v })),
    );
  const parameterCheck = (
    label: string,
    key: "inverted" | "msb" | "cpol" | "cpha" | "activeLow",
  ) => (
    <label className="remoteCheck">
      <input
        type="checkbox"
        checked={parameters[key]}
        onChange={(e) =>
          setParameters((p) => ({ ...p, [key]: e.target.checked }))
        }
      />
      {t(label)}
    </label>
  );

  if (!connection)
    return (
      <main className="remoteLogin">
        <div className="remoteBrand">
          <Activity size={26} />
          SigPilot <span>REMOTE</span>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void action(async () => {
              setConnection(
                await remoteJson<RemoteConnection>("/login", {
                  code: code.trim(),
                  name,
                }),
              );
              setCode("");
              setOnline(true);
              refresh();
            });
          }}
        >
          <Globe size={32} />
          <h1>{t("loginTitle")}</h1>
          <p>{t("loginHint")}</p>
          <label>
            {t("browserName")}
            <input
              name="browser-name"
              required
              maxLength={80}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label>
            {t("code")}
            <input
              name="access-code"
              type="password"
              autoComplete="off"
              required
              maxLength={128}
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </label>
          <button className="remotePrimary" disabled={busy}>
            {t(busy ? "working" : "login")}
          </button>
          {error && (
            <p className="remoteError" role="alert">
              {error}
            </p>
          )}
          <button
            type="button"
            className="remoteLanguage"
            onClick={() =>
              void i18n.changeLanguage(
                i18n.language === "zh-CN" ? "en" : "zh-CN",
              )
            }
          >
            中文 / English
          </button>
        </form>
      </main>
    );

  return (
    <main className="remoteWorkbench">
      <header className="remoteHeader">
        <div className="remoteBrand">
          <Activity size={22} />
          SigPilot <span>REMOTE</span>
        </div>
        <div className={`remoteConnection ${online ? "" : "offline"}`}>
          <i />
          {online ? connection.client.name : t("offline")}
        </div>
        <span className="remotePermission">
          {t(connection.can_edit ? "allowEdit" : "readonly")}
        </span>
        <button aria-label={t("refresh")} onClick={refresh}>
          <RefreshCw size={16} />
        </button>
        <button
          className="remoteLanguage"
          onClick={() =>
            void i18n.changeLanguage(i18n.language === "zh-CN" ? "en" : "zh-CN")
          }
        >
          中文 / EN
        </button>
        <button
          onClick={() =>
            void action(async () => {
              await remoteJson("/logout", {});
              setConnection(null);
              setSnapshot(null);
            })
          }
        >
          <LogOut size={15} />
          {t("logout")}
        </button>
      </header>
      <div className="remoteCaptureBar">
        <label>
          {t("sessions")}
          <select
            aria-label={t("sessions")}
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            disabled={busy}
          >
            {listing.sessions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.metadata.source_device} · {s.id}
              </option>
            ))}
          </select>
        </label>
        {context && (
          <span className="remoteCaptureInfo">
            {(sampleRate / 1e6).toLocaleString()} MHz · {context.sample_count}{" "}
            samples · {t(context.finalized ? "ready" : "live")}
          </span>
        )}
        <input
          ref={fileInput}
          hidden
          type="file"
          accept=".pxl"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (!f) return;
            void action(async () => {
              if (
                !f.name.toLowerCase().endsWith(".pxl") ||
                f.size > 32 * 1024 * 1024
              )
                throw new Error(t("fileLimit"));
              const v = await (
                await remoteRequest("/sessions/import", f, undefined, true)
              ).json();
              setSelected(v.session_id);
              refresh();
            });
          }}
        />
        <button
          disabled={!connection.can_edit || busy || !online}
          onClick={() => fileInput.current?.click()}
        >
          <Upload size={14} />
          {t("import")}
        </button>
        <button
          disabled={!snapshot || busy || !online}
          onClick={() =>
            void action(async () => {
              const response = await remoteRequest(
                sessionPath(selected, "download"),
              );
              const url = URL.createObjectURL(await response.blob());
              const a = document.createElement("a");
              a.href = url;
              a.download = "sigpilot-capture.pxl";
              a.click();
              setTimeout(() => URL.revokeObjectURL(url), 1000);
            })
          }
        >
          <Download size={14} />
          {t("download")}
        </button>
        <button
          disabled={
            !snapshot ||
            !context?.finalized ||
            !currentSession?.owned ||
            busy ||
            !online
          }
          onClick={() =>
            void action(async () => {
              if (!snapshot) return;
              await remoteJson(sessionPath(selected, "release"), {
                capture: captureRef(snapshot),
              });
              setSelected("");
              refresh();
            })
          }
        >
          {t("close")}
        </button>
      </div>
      {error && (
        <div className="remoteError" role="alert">
          {error}{" "}
          <button
            onClick={() => {
              setError("");
              refresh();
            }}
          >
            {t("refresh")}
          </button>
        </div>
      )}
      <div className="remoteBody">
        <section className="remoteWaveArea">
          <div className="remoteViewToolbar">
            <label>
              {t("startSample")}
              <input
                aria-label={t("startSample")}
                inputMode="numeric"
                value={jumpStart}
                onChange={(e) => setJumpStart(e.target.value)}
              />
            </label>
            <label>
              {t("span")}
              <input
                aria-label={t("span")}
                inputMode="numeric"
                value={jumpSpan}
                onChange={(e) => setJumpSpan(e.target.value)}
              />
            </label>
            <button
              disabled={!snapshot}
              onClick={() => {
                try {
                  viewport(
                    exactUiSample(jumpStart),
                    Math.max(1, exactUiSample(jumpSpan)),
                  );
                } catch (e) {
                  fail(e);
                }
              }}
            >
              {t("jump")}
            </button>
            <button disabled={!snapshot} onClick={() => viewport(0, total)}>
              {t("fit")}
            </button>
            <button
              aria-label={t("zoomIn")}
              disabled={!snapshot}
              onClick={() => viewport(view.start_sample, view.samples / 2)}
            >
              <ZoomIn size={16} />
            </button>
            <button
              aria-label={t("zoomOut")}
              disabled={!snapshot}
              onClick={() => viewport(view.start_sample, view.samples * 2)}
            >
              <ZoomOut size={16} />
            </button>
          </div>
          {snapshot && total > 0 ? (
            <div className="remoteWaveScroll">
              <div
                className="remoteWaveRows"
                style={{ height: Math.max(220, channelList.length * 62 + 28) }}
              >
                <div className="remoteChannelLabels">
                  {channelList.map((ch) => (
                    <div key={ch}>
                      D{ch}
                      <small>
                        {currentSession?.metadata.labels[ch] !== `D${ch}`
                          ? currentSession?.metadata.labels[ch]
                          : ""}
                      </small>
                    </div>
                  ))}
                </div>
                <div
                  className="remoteWaveCanvas"
                  data-start={view.start_sample}
                  data-span={view.samples}
                >
                  <WaveformCanvas
                    sessionId={`browser-${connection.client.id}-${selected}`}
                    rowHeights={channelList.map(() => 62)}
                    tile={tile}
                    onWidthChange={setWidth}
                    sampleRateHz={sampleRate}
                    totalSamples={total}
                    viewportStart={view.start_sample}
                    viewportSamples={view.samples}
                    onViewportChange={viewport}
                    showInteractiveMeasurement={false}
                    showGridLines
                    isLive={!context?.finalized}
                    onOpenContextMenu={(e) => {
                      setTab("markers");
                      setEditing(null);
                      setMarker({
                        ...blankMarker(),
                        sample: String(
                          Math.max(
                            0,
                            Math.min(total - 1, Math.round(e.sample)),
                          ),
                        ),
                      });
                    }}
                  />
                  <div className="remoteMarkerOverlay" aria-hidden="true">
                    {snapshot.annotations.map((a) => {
                      const x =
                        ((Number(a.sample) - view.start_sample) /
                          view.samples) *
                        100;
                      const end =
                        a.end_sample == null
                          ? x
                          : ((Number(a.end_sample) - view.start_sample) /
                              view.samples) *
                            100;
                      const y =
                        a.kind === "channel_annotation"
                          ? channelList.indexOf(a.channel ?? 0) * 62 + 20
                          : 0;
                      return (
                        <div key={a.id}>
                          {a.end_sample != null && end >= 0 && x <= 100 && (
                            <div
                              className="remoteMarkerRange"
                              style={{
                                left: `${Math.max(0, x)}%`,
                                width: `${Math.max(0, Math.min(100, end) - Math.max(0, x))}%`,
                                background: a.color,
                              }}
                            />
                          )}
                          {x >= 0 && x <= 100 && (
                            <div
                              className="remoteMarkerLine"
                              style={{
                                left: `${x}%`,
                                top: y,
                                borderColor: a.color,
                              }}
                            >
                              <span style={{ background: a.color }}>
                                {a.title || t(a.kind)}
                              </span>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="remoteEmpty">
              <Activity size={40} />
              <p>{t("empty")}</p>
            </div>
          )}
          <footer className="remoteWaveFooter">
            <span>{t("viewHint")}</span>
            {busy && <span>{t("working")}</span>}
          </footer>
          {listing.captures.map((job) => (
            <div className="remoteJob" key={job.id}>
              <span>
                {job.session_id} · {job.state}
                {job.error && ` · ${job.error}`}
              </span>
              {job.state === "running" && job.owned && (
                <button
                  disabled={busy}
                  onClick={() =>
                    void action(async () => {
                      await remoteJson(`/captures/${job.id}/cancel`, {});
                      refresh();
                    })
                  }
                >
                  {t("stop")}
                </button>
              )}
            </div>
          ))}
        </section>
        <aside className="remoteSidebar">
          <nav>
            {(["markers", "decode", "acquire"] as const).map((id) => (
              <button
                key={id}
                className={tab === id ? "active" : ""}
                onClick={() => setTab(id)}
              >
                {t(id)}
              </button>
            ))}
          </nav>
          <div className="remoteSidebarContent">
            {tab === "markers" && (
              <>
                <div className="remoteSectionHeading">
                  <h2>{t("markers")}</h2>
                  <button
                    disabled={
                      !snapshot ||
                      !connection.can_edit ||
                      busy ||
                      !online ||
                      !undo ||
                      undo.session !== selected ||
                      undo.revision !== context?.annotation_revision
                    }
                    onClick={() =>
                      void action(async () => {
                        if (!snapshot || !undo) return;
                        await remoteJson(sessionPath(selected, "undo"), {
                          capture: captureRef(snapshot),
                          expected_annotation_revision:
                            context?.annotation_revision,
                          batch_id: undo.batch,
                          request_id: remoteId(),
                        });
                        setUndo(null);
                        refresh();
                      })
                    }
                  >
                    {t("undo")}
                  </button>
                </div>
                <form
                  className="remoteForm"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void action(() =>
                      mutate([
                        {
                          op: editing ? "update" : "create",
                          id: editing ?? remoteId(),
                          annotation: marker,
                        },
                      ]),
                    );
                  }}
                >
                  <label>
                    {t("kind")}
                    <select
                      value={marker.kind}
                      onChange={(e) =>
                        setMarker((m) => ({
                          ...m,
                          kind: e.target.value as AnnotationInput["kind"],
                          end_sample:
                            e.target.value === "timing_pair" ||
                            e.target.value === "range_annotation"
                              ? (m.end_sample ?? m.sample)
                              : undefined,
                          channel:
                            e.target.value === "channel_annotation"
                              ? (m.channel ?? channelList[0] ?? 0)
                              : undefined,
                        }))
                      }
                    >
                      {[
                        "timing_point",
                        "timing_pair",
                        "channel_annotation",
                        "range_annotation",
                      ].map((k) => (
                        <option key={k} value={k}>
                          {t(k)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="remoteFormRow">
                    <label>
                      {t("sample")}
                      <input
                        aria-label={t("sample")}
                        required
                        inputMode="numeric"
                        pattern="[0-9]+"
                        value={marker.sample}
                        onChange={(e) =>
                          setMarker((m) => ({
                            ...m,
                            sample: e.target.value,
                            evidence_refs: [],
                          }))
                        }
                      />
                    </label>
                    {(marker.kind === "timing_pair" ||
                      marker.kind === "range_annotation") && (
                      <label>
                        {t("endSample")}
                        <input
                          required
                          inputMode="numeric"
                          pattern="[0-9]+"
                          value={marker.end_sample ?? ""}
                          onChange={(e) =>
                            setMarker((m) => ({
                              ...m,
                              end_sample: e.target.value,
                              evidence_refs: [],
                            }))
                          }
                        />
                      </label>
                    )}
                  </div>
                  {marker.kind === "channel_annotation" &&
                    numberField(
                      "channel",
                      marker.channel ?? 0,
                      (v) =>
                        setMarker((m) => ({
                          ...m,
                          channel: v,
                          evidence_refs: [],
                        })),
                      0,
                      (context?.channel_count ?? 1) - 1,
                    )}
                  <label>
                    {t("markerTitle")}
                    <input
                      aria-label={t("markerTitle")}
                      maxLength={200}
                      value={marker.title}
                      onChange={(e) =>
                        setMarker((m) => ({ ...m, title: e.target.value }))
                      }
                    />
                  </label>
                  <label>
                    {t("note")}
                    <textarea
                      maxLength={4000}
                      rows={2}
                      value={marker.note}
                      onChange={(e) =>
                        setMarker((m) => ({ ...m, note: e.target.value }))
                      }
                    />
                  </label>
                  <div className="remoteFormRow">
                    <label>
                      {t("color")}
                      <input
                        type="color"
                        value={marker.color}
                        onChange={(e) =>
                          setMarker((m) => ({ ...m, color: e.target.value }))
                        }
                      />
                    </label>
                    <button
                      className="remotePrimary"
                      disabled={
                        !snapshot || !connection.can_edit || busy || !online
                      }
                    >
                      <Plus size={14} />
                      {t(editing ? "save" : "add")}
                    </button>
                    {editing && (
                      <button
                        type="button"
                        onClick={() => {
                          setEditing(null);
                          setMarker(blankMarker());
                        }}
                      >
                        {t("cancel")}
                      </button>
                    )}
                  </div>
                </form>
                <div className="remoteMarkerList">
                  {!snapshot?.annotations.length && <p>{t("noMarkers")}</p>}
                  {snapshot?.annotations.map((a: WorkbenchAnnotation) => (
                    <article key={a.id} data-marker-sample={a.sample}>
                      <button
                        className="remoteMarkerJump"
                        onClick={() => jump(a.sample)}
                      >
                        <i style={{ background: a.color }} />
                        <strong>{a.title || t(a.kind)}</strong>
                      </button>
                      <code>
                        {formatSample(a.sample)}
                        {a.end_sample != null &&
                          ` → ${formatSample(a.end_sample)}`}
                      </code>
                      {a.note && <p>{a.note}</p>}
                      <div>
                        <button
                          disabled={!connection.can_edit || busy || !online}
                          onClick={() => {
                            editingRevision.current =
                              snapshot.context.annotation_revision;
                            setEditing(a.id);
                            setMarker({
                              kind: a.kind,
                              sample: a.sample,
                              end_sample: a.end_sample,
                              channel: a.channel,
                              title: a.title,
                              note: a.note,
                              color: a.color,
                              shape: a.shape,
                              tags: a.tags ?? [],
                              evidence_refs: a.evidence_refs ?? [],
                            });
                          }}
                        >
                          {t("edit")}
                        </button>
                        <button
                          disabled={!connection.can_edit || busy || !online}
                          onClick={() =>
                            void action(() =>
                              mutate([{ op: "delete", id: a.id }]),
                            )
                          }
                        >
                          {t("delete")}
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
                <hr />
                <h2>{t("measurement")}</h2>
                <div className="remoteForm">
                  {numberField(
                    "channel",
                    parameters.channel,
                    (v) => setParameters((p) => ({ ...p, channel: v })),
                    0,
                    (context?.channel_count ?? 1) - 1,
                  )}
                  <button
                    disabled={!snapshot || busy || !online}
                    onClick={() =>
                      void action(async () => {
                        if (!snapshot) return;
                        setMeasurement(
                          await remoteJson(
                            sessionPath(selected, "measurement"),
                            {
                              capture: captureRef(snapshot),
                              request: {
                                channel: parameters.channel,
                                sample: marker.sample,
                              },
                            },
                          ),
                        );
                      })
                    }
                  >
                    {t("measure")} · {marker.sample}
                  </button>
                </div>
                {measurement === null && <p>{t("noMeasurement")}</p>}
                {measurement && (
                  <p className="remoteMeasurement">
                    {t("width")}:{" "}
                    {formatSample(
                      measurement.width_end_sample -
                        measurement.width_start_sample,
                    )}
                    {measurement.period_end_sample != null && (
                      <>
                        <br />
                        {t("period")}:{" "}
                        {formatSample(
                          measurement.period_end_sample -
                            measurement.width_start_sample,
                        )}
                      </>
                    )}
                  </p>
                )}
              </>
            )}
            {tab === "decode" && (
              <>
                <h2>{t("decode")}</h2>
                <form
                  className="remoteForm"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void action(() => search(0));
                  }}
                >
                  <label>
                    {t("protocol")}
                    <select
                      value={protocol}
                      onChange={(e) => {
                        setProtocol(e.target.value);
                        setDecodeRows(null);
                      }}
                    >
                      <option value="uart">UART</option>
                      <option value="i2c">I²C</option>
                      <option value="spi">SPI</option>
                    </select>
                  </label>
                  {protocol === "uart" && (
                    <>
                      <div className="remoteFormRow">
                        {parameterNumber("channel", "channel")}
                        {parameterNumber("baud", "baud")}
                      </div>
                      <div className="remoteFormRow">
                        {parameterNumber("dataBits", "dataBits")}
                        {parameterNumber("stopBits", "stopBits")}
                      </div>
                      <label>
                        {t("parity")}
                        <select
                          value={parameters.parity}
                          onChange={(e) =>
                            setParameters((p) => ({
                              ...p,
                              parity: e.target.value,
                            }))
                          }
                        >
                          <option>none</option>
                          <option>even</option>
                          <option>odd</option>
                        </select>
                      </label>
                      {parameterCheck("inverted", "inverted")}
                      {parameterCheck("msb", "msb")}
                    </>
                  )}
                  {protocol === "i2c" && (
                    <div className="remoteFormRow">
                      {parameterNumber("sda", "sda")}
                      {parameterNumber("scl", "scl")}
                    </div>
                  )}
                  {protocol === "spi" && (
                    <>
                      {parameterNumber("clock", "clock")}
                      {(["mosi", "miso", "enable"] as const).map((k) => (
                        <label key={k}>
                          {t(k === "enable" ? "enableChannel" : k)}
                          <input
                            type="number"
                            min={0}
                            value={parameters[k]}
                            onChange={(e) =>
                              setParameters((p) => ({
                                ...p,
                                [k]: e.target.value,
                              }))
                            }
                          />
                        </label>
                      ))}
                      {parameterNumber("bits", "bits")}
                      {parameterCheck("activeLow", "activeLow")}
                      {parameterCheck("cpol", "cpol")}
                      {parameterCheck("cpha", "cpha")}
                      {parameterCheck("msb", "msb")}
                    </>
                  )}
                  <label>
                    {t("query")}
                    <input
                      aria-label={t("query")}
                      value={query}
                      maxLength={512}
                      onChange={(e) => setQuery(e.target.value)}
                    />
                  </label>
                  <button
                    className="remotePrimary"
                    disabled={!snapshot || busy || !online}
                  >
                    {t("search")}
                  </button>
                </form>
                {decodeRows && (
                  <>
                    <p>
                      {t("rows")}: {decodeRows.row_count}
                    </p>
                    <div className="remoteDecodeRows">
                      {decodeRows.rows.map((row) => (
                        <button
                          key={row.frame_index}
                          data-decode-row={row.frame_index}
                          onClick={() =>
                            viewport(
                              row.frame.start_sample,
                              Math.max(
                                10,
                                (row.frame.end_sample -
                                  row.frame.start_sample) *
                                  3,
                              ),
                            )
                          }
                        >
                          <strong>{row.frame.label}</strong>
                          <code>{formatSample(row.frame.start_sample)}</code>
                          <small>{row.frame.frame_type}</small>
                        </button>
                      ))}
                      {!decodeRows.rows.length && <p>{t("noRows")}</p>}
                    </div>
                    <div className="remoteFormRow">
                      <button
                        disabled={page === 0 || busy}
                        onClick={() => void action(() => search(page - 1))}
                      >
                        {t("previous")}
                      </button>
                      <span>{page + 1}</span>
                      <button
                        disabled={
                          (page + 1) * 50 >= decodeRows.row_count || busy
                        }
                        onClick={() => void action(() => search(page + 1))}
                      >
                        {t("next")}
                      </button>
                    </div>
                  </>
                )}
              </>
            )}
            {tab === "acquire" && (
              <>
                <h2>{t("acquire")}</h2>
                <p>{t("acquireLimit")}</p>
                {!connection.can_capture && (
                  <p className="remoteNotice">{t("permissionMissing")}</p>
                )}
                <form
                  className="remoteForm"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void action(startCapture);
                  }}
                >
                  <label>
                    {t("device")}
                    <select
                      value={device}
                      onChange={(e) => setDevice(e.target.value)}
                    >
                      {devices.map((d) => (
                        <option key={d.id} value={d.id} disabled={!d.ready}>
                          {d.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    {t("mode")}
                    <select
                      value={mode}
                      onChange={(e) =>
                        setMode(e.target.value as "Buffer" | "Stream")
                      }
                    >
                      <option>Buffer</option>
                      <option>Stream</option>
                    </select>
                  </label>
                  {numberField("rate", rate, setRate, 1)}
                  {caps && (
                    <small>
                      {caps.sample_rates.map((r) => `${r / 1e6}M`).join(" · ")}
                    </small>
                  )}
                  <div className="remoteFormRow">
                    {numberField(
                      "channels",
                      channels,
                      setChannels,
                      1,
                      Math.min(32, caps?.max_channels ?? 32),
                    )}
                    {numberField("duration", duration, setDuration, 1, 60000)}
                  </div>
                  <div className="remoteFormRow">
                    {numberField("buffer", buffer, setBuffer, 1, 64)}
                    {numberField("threshold", threshold, setThreshold, 0)}
                  </div>
                  <button
                    className="remotePrimary"
                    disabled={
                      !connection.can_capture ||
                      !device ||
                      busy ||
                      !online ||
                      listing.captures.some((j) => j.state === "running")
                    }
                  >
                    {t("start")}
                  </button>
                </form>
              </>
            )}
          </div>
        </aside>
      </div>
    </main>
  );
}
