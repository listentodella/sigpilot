import { ChevronDown, Database, Minus, Plus, Trash2 } from "lucide-react";
import { PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react";
import { CaptureMemoryUsage } from "../lib/api";
import { formatBytes } from "../lib/format";

interface MemoryBufferControlProps {
  bufferSizeMb: number;
  busy: boolean;
  memoryUsage: CaptureMemoryUsage | null;
  onBufferSizeChange: (bufferSizeMb: number) => void;
}

export function MemoryBufferControl({
  bufferSizeMb,
  busy,
  memoryUsage,
  onBufferSizeChange,
}: MemoryBufferControlProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const wasBusyRef = useRef(false);
  const dragRef = useRef<{
    pointerId: number;
    x: number;
    y: number;
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const budgetBytes = memoryUsage?.buffer_bytes ?? bufferSizeMb * 1024 * 1024;
  const sampleBytes = memoryUsage?.sample_bytes ?? 0;
  const indexBytes = memoryUsage?.index_bytes ?? 0;
  const analyzerBytes = memoryUsage?.analyzer_bytes ?? 0;
  const totalBytes = memoryUsage?.total_bytes ?? sampleBytes + indexBytes + analyzerBytes;
  const fillPercent = budgetBytes > 0 ? Math.min(100, (totalBytes / budgetBytes) * 100) : 0;

  useEffect(() => {
    if (busy && !wasBusyRef.current) setOpen(true);
    wasBusyRef.current = busy;
  }, [busy]);

  useEffect(() => {
    function handlePointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }

    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, []);

  function startDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    const rect = event.currentTarget.parentElement?.getBoundingClientRect();
    if (!rect) return;
    dragRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      left: position?.left ?? rect.left,
      top: position?.top ?? rect.top,
      width: rect.width,
      height: rect.height,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setPosition({
      left: Math.max(8, Math.min(window.innerWidth - drag.width - 8, drag.left + event.clientX - drag.x)),
      top: Math.max(8, Math.min(window.innerHeight - drag.height - 8, drag.top + event.clientY - drag.y)),
    });
  }

  function stopDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  const normalizedBufferMb = Math.max(512, Math.round(bufferSizeMb / 512) * 512);
  const adjustBuffer = (deltaGb: number) =>
    onBufferSizeChange(Math.max(512, normalizedBufferMb + deltaGb * 1024));

  return (
    <div className="memoryBufferControl" ref={rootRef}>
      <button
        aria-expanded={open}
        className={`memoryBufferButton ${open ? "active" : ""} ${busy ? "recording" : ""}`}
        onClick={() => setOpen((current) => !current)}
        title={`Memory used: ${formatBytes(totalBytes)}`}
        type="button"
      >
        <Database size={14} />
        <span>{formatBytes(totalBytes)}</span>
        <ChevronDown className={open ? "open" : ""} size={11} />
      </button>

      {open && (
        <section
          className="memoryBufferPopover"
          style={position ? { left: position.left, position: "fixed", right: "auto", top: position.top } : undefined}
        >
          <header
            className="memoryBufferPopoverHeader"
            onPointerDown={startDrag}
            onPointerMove={moveDrag}
            onPointerUp={stopDrag}
            onPointerCancel={stopDrag}
          >
            <strong>Memory Buffer</strong>
            <span className={busy ? "recording" : ""}>{busy ? "Recording" : "Ready"}</span>
          </header>

          <div className="memoryBufferFlow" aria-hidden="true">
            <Database size={20} />
            <div className={`memoryFlowDots ${busy ? "flowing" : ""}`}>
              <i />
              <i />
              <i />
            </div>
            <div className="memoryBufferTrack">
              <div className={`memoryBufferFill ${busy ? "flowing" : ""}`} style={{ width: `${fillPercent}%` }} />
            </div>
            <Trash2 size={19} />
          </div>

          <div className="memoryBufferValue">
            <strong>{formatBytes(totalBytes)}</strong>
            <span>/ {formatBytes(budgetBytes)}</span>
          </div>

          <label className="memoryBufferSetter">
            <span>Buffer size</span>
            <div className="memoryBufferStepper">
              <button
                disabled={busy || normalizedBufferMb <= 512}
                onClick={() => adjustBuffer(-0.5)}
                title="Decrease buffer size"
                type="button"
              >
                <Minus size={13} />
              </button>
              <output>{(normalizedBufferMb / 1024).toFixed(1)} GB</output>
              <button
                disabled={busy}
                onClick={() => adjustBuffer(0.5)}
                title="Increase buffer size"
                type="button"
              >
                <Plus size={13} />
              </button>
            </div>
          </label>
        </section>
      )}
    </div>
  );
}
