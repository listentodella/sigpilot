import { CircleHelp, Minus, Plus } from "lucide-react";
import { PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react";
import dataCapturedWave from "../assets/saleae/memory-buffer/data-captured-wave.svg";
import { CaptureMemoryUsage } from "../lib/api";
import { formatBytes } from "../lib/format";

interface MemoryBufferControlProps {
  bufferSizeMb: number;
  busy: boolean;
  memoryUsage: CaptureMemoryUsage | null;
  onBufferSizeChange: (bufferSizeMb: number) => void;
}

interface DragState {
  pointerId: number;
  x: number;
  y: number;
  left: number;
  top: number;
  width: number;
  height: number;
}

export function MemoryBufferControl({
  bufferSizeMb,
  busy,
  memoryUsage,
  onBufferSizeChange,
}: MemoryBufferControlProps) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const wasBusyRef = useRef(false);
  const dragRef = useRef<DragState | null>(null);
  const budgetBytes = memoryUsage?.buffer_bytes ?? bufferSizeMb * 1024 * 1024;
  const sampleBytes = memoryUsage?.sample_bytes ?? 0;
  const indexBytes = memoryUsage?.index_bytes ?? 0;
  const analyzerBytes = memoryUsage?.analyzer_bytes ?? 0;
  const totalBytes = memoryUsage?.total_bytes ?? sampleBytes + indexBytes + analyzerBytes;
  const fillPercent = budgetBytes > 0 ? Math.min(100, (totalBytes / budgetBytes) * 100) : 0;
  const normalizedBufferMb = Math.max(512, Math.round(bufferSizeMb / 512) * 512);

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
        <CachingIcon />
        <span className="memoryBufferButtonStack">
          <strong>{formatBytes(totalBytes)}</strong>
          <small>BUFFER</small>
        </span>
        <CaretIcon />
      </button>

      {open && (
        <section
          className="memoryBufferPopover"
          style={position ? { bottom: "auto", left: position.left, right: "auto", top: position.top } : undefined}
        >
          <header
            className="memoryBufferPopoverHeader"
            onPointerCancel={stopDrag}
            onPointerDown={startDrag}
            onPointerMove={moveDrag}
            onPointerUp={stopDrag}
          >
            <strong>Memory Buffer</strong>
            <span title="Maximum memory reserved for captured waveform data">
              <CircleHelp size={14} />
            </span>
          </header>

          <div className="memoryBufferAction">
            <div className="memoryBufferFlow">
              <DeviceSourceIcon />
              <DataPathIcon flowing={busy} />
              <div className="memoryBufferProgress">
                <div className="memoryBufferProgressFrame" />
                <div className="memoryBufferWaveClip" style={{ width: `${fillPercent}%` }}>
                  <img className={busy ? "flowing" : ""} src={dataCapturedWave} alt="" />
                </div>
              </div>
              <DataPathIcon flowing={false} />
              <TrashIcon />
            </div>
            <div className="memoryBufferValue">
              <strong>{(totalBytes / 1024 ** 3).toFixed(1)}</strong>
              <span>/{(budgetBytes / 1024 ** 3).toFixed(1)} GB</span>
            </div>
          </div>

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
            <button disabled={busy} onClick={() => adjustBuffer(0.5)} title="Increase buffer size" type="button">
              <Plus size={13} />
            </button>
          </div>
        </section>
      )}
    </div>
  );
}

function CachingIcon() {
  return (
    <svg className="memoryBufferCachingIcon" width="16" height="18" viewBox="0 0 16 18" fill="none" aria-hidden="true">
      <rect x="0.5" y="12.5" width="15" height="5" rx="0.5" stroke="currentColor" />
      <path fill="currentColor" d="M11 14h2v2h-2zM8 14h2v2H8z" />
      <path d="M8 0v9M5 6l3 3 3-3" stroke="currentColor" />
    </svg>
  );
}

function CaretIcon() {
  return (
    <svg className="memoryBufferCaret" width="8" height="5" viewBox="0 0 8 5" fill="none" aria-hidden="true">
      <path d="M7 1L4 4 1 1" stroke="currentColor" strokeLinecap="square" />
    </svg>
  );
}

function DeviceSourceIcon() {
  return (
    <svg width="17" height="12" viewBox="0 0 17 12" fill="none" aria-hidden="true">
      <g stroke="currentColor" strokeLinecap="round" strokeLinejoin="bevel">
        <path d="M8.496 11.175c-.358 0-1.244-.004-2.413-.538L2.545 8.853C1.689 8.412 1 7.995 1 6.315c0-1.07-.1-2.151 1.545-2.993l3.538-1.784C7.25 1.006 8.146 1 8.503 1c.359 0 1.245.004 2.414.538l3.538 1.784c1.644.842 1.544 1.923 1.544 2.993 0 1.68-.688 2.097-1.544 2.538l-3.538 1.784c-1.166.532-2.063.538-2.42.538z" />
        <path d="M10.37 10.855c-.571.18-.886.175-.886-1.104 0-1.279.428-1.658 1.428-2.212l3.538-1.784c.441-.205.949-.419 1.22-.158.158.153.201.483.196 1.03-.007.77-.117 1.147-.31 1.407M6.632 10.855c.57.18.885.175.885-1.104 0-1.279-.429-1.658-1.428-2.212L2.55 5.755c-.44-.205-.948-.419-1.22-.158-.157.153-.2.483-.195 1.03.007.77.117 1.147.31 1.407" />
      </g>
    </svg>
  );
}

function DataPathIcon({ flowing }: { flowing: boolean }) {
  return (
    <svg className={flowing ? "memoryDataPath flowing" : "memoryDataPath"} width="16" height="4" viewBox="0 0 16 4" fill="none" aria-hidden="true">
      <g>
        {flowing && <rect x="-6" width="4" height="4" rx="2" fill="currentColor" />}
        <rect x="0.5" y="0.5" width="3" height="3" rx="1.5" fill={flowing ? "currentColor" : "none"} stroke="currentColor" />
        <rect x="6.5" y="0.5" width="3" height="3" rx="1.5" fill={flowing ? "currentColor" : "none"} stroke="currentColor" />
        <rect x="12.5" y="0.5" width="3" height="3" rx="1.5" fill={flowing ? "currentColor" : "none"} stroke="currentColor" />
      </g>
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg className="memoryBufferTrash" width="15" height="14" viewBox="0 0 15 14" fill="none" aria-hidden="true">
      <path d="M3.489 13.06L2.565 5.5h9.87l-.924 7.56a.5.5 0 01-.496.44h-7.03a.5.5 0 01-.496-.44zM6 .5h3A1.5 1.5 0 0110.5 2v1.5h-6V2A1.5 1.5 0 016 .5z" stroke="currentColor" />
      <rect x="1.5" y="3.5" width="12" height="2" rx="0.5" stroke="currentColor" />
      <path fill="currentColor" d="M5 7h1v5H5zM9 7h1v5H9zM7 7h1v5H7z" />
    </svg>
  );
}
