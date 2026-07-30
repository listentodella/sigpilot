import { X } from "lucide-react";
import { PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CaptureMemoryUsage } from "../lib/api";

interface MemoryBufferControlProps {
  busy: boolean;
  memoryUsage: CaptureMemoryUsage | null;
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

export function MemoryBufferControl({ busy, memoryUsage }: MemoryBufferControlProps) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const wasBusyRef = useRef(false);
  const dragRef = useRef<DragState | null>(null);
  const budgetBytes = memoryUsage?.buffer_bytes ?? 0;
  const totalBytes = memoryUsage?.total_bytes ?? 0;
  const fillPercent = budgetBytes > 0 ? Math.min(100, (totalBytes / budgetBytes) * 100) : 0;
  const memoryLabel = formatMemoryUsed(totalBytes);

  useEffect(() => {
    if (busy && !wasBusyRef.current) setOpen(true);
    if (!busy) setOpen(false);
    wasBusyRef.current = busy;
  }, [busy]);

  function startDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
    const rect = panelRef.current?.getBoundingClientRect();
    if (!rect) return;
    dragRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      left: rect.left,
      top: rect.top,
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

  if (!busy || !open) return null;

  return createPortal(
    <div
      className="captureMemoryProgress"
      onPointerCancel={stopDrag}
      onPointerDown={startDrag}
      onPointerMove={moveDrag}
      onPointerUp={stopDrag}
      ref={panelRef}
      style={position ? { bottom: "auto", left: position.left, right: "auto", top: position.top } : undefined}
    >
      <button
        aria-label="Hide capture progress"
        className="captureMemoryProgressClose"
        onClick={() => setOpen(false)}
        title="Hide capture progress"
        type="button"
      >
        <X size={12} strokeWidth={2} />
      </button>
      <div className="captureMemoryProgressSpacer" />
      <div className="captureMemoryProgressLabels">
        <span>Memory</span>
        <span>{memoryLabel}</span>
      </div>
      <div className="captureMemoryProgressTrack" aria-label={`Memory used ${fillPercent.toFixed(1)}%`}>
        <div className="captureMemoryProgressFill" style={{ width: `${fillPercent}%` }} />
      </div>
    </div>,
    document.body,
  );
}

function formatMemoryUsed(bytes: number) {
  if (bytes <= 0) return "0 MB";
  const units = bytes >= 1_000_000_000 ? { divisor: 1_000_000_000, label: "GB" } : { divisor: 1_000_000, label: "MB" };
  return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(bytes / units.divisor)} ${units.label}`;
}
