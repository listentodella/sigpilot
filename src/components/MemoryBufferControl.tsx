import { ChevronDown, Database, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
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
        <section className="memoryBufferPopover">
          <header>
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

          <dl className="memoryBufferBreakdown">
            <div>
              <dt>Captured data</dt>
              <dd>{formatBytes(sampleBytes)}</dd>
            </div>
            <div>
              <dt>Waveform index</dt>
              <dd>{formatBytes(indexBytes)}</dd>
            </div>
            <div>
              <dt>Decoder cache</dt>
              <dd>{formatBytes(analyzerBytes)}</dd>
            </div>
            <div className="total">
              <dt>Total tracked</dt>
              <dd>{formatBytes(totalBytes)}</dd>
            </div>
          </dl>

          <label className="memoryBufferSetter">
            <span>Memory buffer size</span>
            <div>
              <input
                disabled={busy}
                min={0.5}
                onChange={(event) => {
                  const valueGb = Number(event.target.value);
                  if (Number.isFinite(valueGb) && valueGb >= 0.5) {
                    onBufferSizeChange(Math.round(valueGb * 1024));
                  }
                }}
                step={0.5}
                type="number"
                value={bufferSizeMb / 1024}
              />
              <span>GB</span>
            </div>
          </label>
        </section>
      )}
    </div>
  );
}
