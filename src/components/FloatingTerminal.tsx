import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { Maximize2, Minimize2, Minus, Pin, RefreshCw, Terminal, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { clampTerminalRect, initialTerminalRect, saveTerminalRect, terminalInputChunks, type TerminalRect } from "../lib/floatingTerminal";
import { desktopTerminal, type TerminalSession, type TerminalTransport } from "../lib/terminal";
import "./FloatingTerminal.css";

type ShellStatus = "idle" | "starting" | "running" | "exited" | "closing" | "error";
const viewport = () => ({ width: window.innerWidth, height: window.innerHeight });
const inDesktop = () => "__TAURI_INTERNALS__" in window;

/** The transport injection is used by the real PTY browser fixture, not a fake shell. */
export function FloatingTerminal({ transport = desktopTerminal, available = inDesktop() }: {
  transport?: TerminalTransport; available?: boolean;
}) {
  const { t } = useTranslation("terminal");
  const tRef = useRef(t); tRef.current = t;
  const [visible, setVisible] = useState(false);
  const [created, setCreated] = useState(false);
  const [rect, setRect] = useState(() => initialTerminalRect(viewport()));
  const [maximized, setMaximized] = useState(false);
  const [status, setStatus] = useState<ShellStatus>("idle");
  const [sessionInfo, setSessionInfo] = useState<TerminalSession | null>(null);
  const [error, setError] = useState("");
  const [exitCode, setExitCode] = useState<number | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sessionRef = useRef<TerminalSession | null>(null);
  const statusRef = useRef<ShellStatus>(status); statusRef.current = status;
  const visibleRef = useRef(visible); visibleRef.current = visible;
  const generationRef = useRef(0);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputQueue = useRef<{ data: string; id: string }[]>([]);
  const inputSize = useRef(0);
  const writing = useRef(false);
  const rectRef = useRef(rect); rectRef.current = rect;
  const dragRef = useRef<{ mode: "move" | "resize"; pointerId: number; x: number; y: number; rect: TerminalRect } | null>(null);
  const startRef = useRef<() => void>(() => {});

  const show = useCallback(() => { setCreated(true); setVisible(true); }, []);
  const collapse = useCallback(() => {
    termRef.current?.blur(); setVisible(false);
    requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(".floatingTerminalLauncher")?.focus());
  }, []);

  // A module-level event also gives the application header a normal menu entry.
  useEffect(() => {
    const toggle = () => visibleRef.current ? collapse() : show();
    const shortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.code === "Backquote" && !event.altKey) {
        event.preventDefault(); event.stopImmediatePropagation(); toggle();
      }
    };
    window.addEventListener("sigpilot:toggle-terminal", toggle);
    document.addEventListener("keydown", shortcut, true);
    return () => {
      window.removeEventListener("sigpilot:toggle-terminal", toggle);
      document.removeEventListener("keydown", shortcut, true);
    };
  }, [collapse, show]);

  useEffect(() => {
    if (!created || !hostRef.current || !available) return;
    let disposed = false;
    const terminal = new XTerm({
      cursorBlink: true, fontSize: 13, fontFamily: '"Roboto Mono", "SFMono-Regular", Consolas, monospace',
      scrollback: 5000, allowProposedApi: false,
      theme: { background: "#141417", foreground: "#d5d5df", cursor: "#b8d8e6", selectionBackground: "#385261" },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit); terminal.open(hostRef.current);
    termRef.current = terminal; fitRef.current = fit;

    const clearPolling = () => {
      if (pollTimer.current !== null) clearTimeout(pollTimer.current);
      pollTimer.current = null;
    };
    const finishStatus = (value: ShellStatus) => { statusRef.current = value; if (!disposed) setStatus(value); };
    async function poll(id: string, generation: number) {
      if (disposed || generation !== generationRef.current) return;
      try {
        const output = await transport.poll(id);
        if (disposed || generation !== generationRef.current) return;
        const afterWrite = () => {
          if (disposed || generation !== generationRef.current) return;
          if (output.error) setError(output.error);
          if (output.exited) {
            terminal.options.disableStdin = true;
            setExitCode(output.exit_code); finishStatus("exited");
          } else {
            // Even when collapsed we parse output, so PTY buffers never grow without bound.
            pollTimer.current = setTimeout(() => void poll(id, generation), output.data.length ? 0 : visibleRef.current ? 35 : 150);
          }
        };
        if (output.data.length) terminal.write(Uint8Array.from(output.data), afterWrite);
        else afterWrite();
      } catch (e) {
        if (!disposed && generation === generationRef.current) { setError(String(e)); finishStatus("error"); }
      }
    }

    async function start() {
      if (disposed || statusRef.current === "starting" || statusRef.current === "closing") return;
      finishStatus("starting"); setError(""); setExitCode(null); clearPolling();
      inputQueue.current = []; inputSize.current = 0;
      const generation = ++generationRef.current;
      const previous = sessionRef.current; sessionRef.current = null;
      try {
        if (previous) await transport.close(previous.id);
        if (disposed || generation !== generationRef.current) return;
        fit.fit(); terminal.reset();
        const session = await transport.open(Math.min(500, Math.max(2, terminal.cols)), Math.min(200, Math.max(1, terminal.rows)));
        if (disposed || generation !== generationRef.current) { await transport.close(session.id); return; }
        sessionRef.current = session; setSessionInfo(session);
        terminal.options.disableStdin = false; finishStatus("running");
        if (visibleRef.current) terminal.focus();
        void poll(session.id, generation);
      } catch (e) {
        if (!disposed && generation === generationRef.current) { setError(String(e)); finishStatus("error"); }
      }
    }
    startRef.current = () => void start();

    async function drainInput() {
      if (writing.current) return;
      writing.current = true;
      try {
        while (!disposed && inputQueue.current.length) {
          const item = inputQueue.current.shift()!;
          inputSize.current -= item.data.length;
          if (item.id !== sessionRef.current?.id || statusRef.current !== "running") continue;
          try { await transport.write(item.id, item.data); }
          catch (e) { if (!disposed) setError(String(e)); inputQueue.current = []; inputSize.current = 0; break; }
        }
      } finally { writing.current = false; }
    }
    const onData = terminal.onData((data) => {
      const session = sessionRef.current;
      if (!session || statusRef.current !== "running") return;
      if (inputSize.current + data.length > 128 * 1024) { setError(tRef.current("inputTooLarge")); return; }
      inputSize.current += data.length;
      inputQueue.current.push(...terminalInputChunks(data).map((chunk) => ({ id: session.id, data: chunk })));
      void drainInput();
    });

    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    let lastSize = "";
    const observer = new ResizeObserver(() => {
      if (resizeTimer !== null) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (disposed || !visibleRef.current) return;
        fit.fit();
        const session = sessionRef.current;
        const key = `${session?.id}:${terminal.cols}:${terminal.rows}`;
        if (session && statusRef.current === "running" && key !== lastSize) {
          lastSize = key;
          void transport.resize(session.id, Math.min(500, terminal.cols), Math.min(200, terminal.rows))
            .catch((e) => { if (!disposed) setError(String(e)); });
        }
      }, 60);
    });
    observer.observe(hostRef.current);
    void document.fonts.ready.then(() => { if (!disposed && visibleRef.current) { fit.fit(); terminal.refresh(0, terminal.rows - 1); } });
    void start();
    return () => {
      disposed = true; ++generationRef.current; clearPolling();
      if (resizeTimer !== null) clearTimeout(resizeTimer);
      observer.disconnect(); onData.dispose(); terminal.dispose();
      termRef.current = null; fitRef.current = null;
      const session = sessionRef.current; sessionRef.current = null;
      if (session) void transport.close(session.id).catch(() => {});
      inputQueue.current = []; inputSize.current = 0;
      statusRef.current = "idle";
    };
  }, [created, available, transport]);

  useEffect(() => {
    if (visible) {
      const frame = requestAnimationFrame(() => { fitRef.current?.fit(); termRef.current?.focus(); });
      return () => cancelAnimationFrame(frame);
    }
  }, [visible]);

  useEffect(() => {
    const resize = () => setRect((current) => clampTerminalRect(current, viewport()));
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => saveTerminalRect(rect), 200);
    return () => clearTimeout(timer);
  }, [rect]);

  function beginPointer(event: ReactPointerEvent, mode: "move" | "resize") {
    if (event.button !== 0 || maximized || (mode === "move" && (event.target as Element).closest("button"))) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { mode, pointerId: event.pointerId, x: event.clientX, y: event.clientY, rect: rectRef.current };
  }
  function movePointer(event: ReactPointerEvent) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
    setRect(clampTerminalRect(drag.mode === "move"
      ? { ...drag.rect, x: drag.rect.x + dx, y: drag.rect.y + dy }
      : { ...drag.rect, width: drag.rect.width + dx, height: drag.rect.height + dy }, viewport()));
  }
  function endPointer() { dragRef.current = null; }

  async function close() {
    const session = sessionRef.current;
    if (statusRef.current === "starting" || statusRef.current === "closing") return;
    setError(""); setStatus("closing"); statusRef.current = "closing";
    ++generationRef.current;
    if (pollTimer.current !== null) clearTimeout(pollTimer.current);
    termRef.current?.blur(); termRef.current && (termRef.current.options.disableStdin = true);
    try {
      if (session) await transport.close(session.id);
      sessionRef.current = null; setSessionInfo(null);
      statusRef.current = "idle"; setStatus("idle"); setVisible(false);
      setCreated(false);
      requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(".floatingTerminalLauncher")?.focus());
    } catch (e) { setError(String(e)); setStatus("error"); statusRef.current = "error"; }
  }

  const geometry = maximized ? clampTerminalRect({ x: 16, y: 46, width: innerWidth - 32, height: innerHeight - 100 }, viewport()) : rect;
  const shellLabel = sessionInfo?.shell.split(/[\\/]/).pop() ?? t("defaultShell");
  return createPortal(<div className="floatingTerminalRoot" data-terminal-root onKeyDown={(e) => e.stopPropagation()} onKeyUp={(e) => e.stopPropagation()}>
    {!visible && <button type="button" className="floatingTerminalLauncher" aria-label={t("open")} title={`${t("open")} · Ctrl/Cmd + \``} onClick={show}>
      <Terminal size={17} /><span>{t("title")}</span><i className={`terminalStateDot ${status === "running" ? "running" : ""}`} />
    </button>}
    {created && <section className="floatingTerminalWindow" role="region" aria-label={t("title")} hidden={!visible}
      style={{ left: geometry.x, top: geometry.y, width: geometry.width, height: geometry.height }}>
      <header className="floatingTerminalHeader" onPointerDown={(e) => beginPointer(e, "move")} onPointerMove={movePointer} onPointerUp={endPointer} onPointerCancel={endPointer}>
        <Terminal size={15} /><strong>{t("title")}</strong><span className="terminalShellLabel" title={sessionInfo?.shell}>{shellLabel}</span>
        <span className="terminalHeaderSpacer" /><Pin size={13} className="terminalPin" aria-label={t("pinned")} />
        <button type="button" onClick={collapse} title={t("minimize")} aria-label={t("minimize")}><Minus size={15} /></button>
        <button type="button" onClick={() => setMaximized((value) => !value)} title={t(maximized ? "restoreSize" : "maximize")} aria-label={t(maximized ? "restoreSize" : "maximize")}>{maximized ? <Minimize2 size={13} /> : <Maximize2 size={13} />}</button>
        <button type="button" onClick={() => void close()} disabled={status === "starting" || status === "closing"} title={t("close")} aria-label={t("close")}><X size={15} /></button>
      </header>
      <div className="floatingTerminalSessionBar"><i className={`terminalStateDot ${status === "running" ? "running" : ""}`} /><span>{t(status)}</span><span className="terminalCwd" title={sessionInfo?.cwd}>{sessionInfo?.cwd}</span></div>
      {!available && <div className="terminalUnavailable" role="status">{t("desktopRequired")}</div>}
      <div className="floatingTerminalViewport" ref={hostRef} />
      {error && <div className="terminalError" role="alert"><span>{error}</span><button onClick={() => setError("")} aria-label={t("dismissError")}><X size={13} /></button></div>}
      {(status === "exited" || status === "error") && available && <div className="terminalExitBar" role="status"><span>{status === "exited" ? t("exitCode", { code: exitCode ?? "—" }) : t("connectionFailed")}</span><button type="button" onClick={() => startRef.current()}><RefreshCw size={12} />{t("restart")}</button></div>}
      <footer className="floatingTerminalFooter"><span>{t("pinned")}</span><span>{t("resizeHint")}</span></footer>
      {!maximized && <div className="terminalResizeHandle" role="separator" aria-label={t("resize")} tabIndex={0}
        onPointerDown={(e) => beginPointer(e, "resize")} onPointerMove={movePointer} onPointerUp={endPointer} onPointerCancel={endPointer}
        onKeyDown={(e) => { const dx = e.key === "ArrowRight" ? 20 : e.key === "ArrowLeft" ? -20 : 0; const dy = e.key === "ArrowDown" ? 20 : e.key === "ArrowUp" ? -20 : 0;
          if (dx || dy) { e.preventDefault(); setRect((value) => clampTerminalRect({ ...value, width: value.width + dx, height: value.height + dy }, viewport())); } }} />}
    </section>}
  </div>, document.body);
}
