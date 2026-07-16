import { ChevronDown, ChevronUp, Maximize2, ZoomIn, ZoomOut } from "lucide-react";
import { ReactNode, useEffect, useRef, useState } from "react";
import {
  AnalyzerCommands,
  CommandPayload,
  MarkerCommands,
  MeasurementCommands,
  UiCommand,
} from "../lib/sidebar";

type MenuName = "analyzers" | "markers" | null;

interface LogicToolbarProps {
  busy: boolean;
  hasCapture: boolean;
  onStart: () => void;
  onStop: () => void;
  onCommand: (command: UiCommand, payload?: CommandPayload) => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
}

export function LogicToolbar({
  busy,
  hasCapture,
  onStart,
  onStop,
  onCommand,
  onZoomIn,
  onZoomOut,
  onFit,
}: LogicToolbarProps) {
  const [openMenu, setOpenMenu] = useState<MenuName>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handlePointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpenMenu(null);
      }
    }

    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, []);

  const captureTooltip = busy ? "Stop" : "Start";

  return (
    <div className="saleaeToolbarWrapper" ref={rootRef}>
      <div className="saleaeToolbar" role="toolbar" aria-label="Capture tools">
        <div className="saleaeCaptureButtons">
          <ToolbarButton
            className="saleaeCaptureButton"
            isActive={busy}
            title={captureTooltip}
            onClick={busy ? onStop : onStart}
          >
            {busy ? <StopRecordingIcon /> : <StartRecordingIcon />}
          </ToolbarButton>
        </div>

        <PopoverButton
          isActive={openMenu === "analyzers"}
          title="Add Analyzer"
          onClick={() => setOpenMenu((current) => (current === "analyzers" ? null : "analyzers"))}
        >
          <AnalyzersIcon />
          {openMenu === "analyzers" ? <ChevronUp size={10} strokeWidth={2} /> : <ChevronDown size={10} strokeWidth={2} />}
        </PopoverButton>
        {openMenu === "analyzers" && (
          <ToolbarMenu className="analyzerMenu">
            {["Async Serial", "I2C", "SPI", "CAN", "I2S", "Manchester"].map((name) => (
              <button
                className="toolbarMenuItem"
                key={name}
                onClick={() => {
                  setOpenMenu(null);
                  onCommand(AnalyzerCommands.AddAnalyzer, { analyzerName: name });
                }}
              >
                <span>{name}</span>
                <small>Analyzer</small>
              </button>
            ))}
          </ToolbarMenu>
        )}

        <ToolbarButton title="Add Range Measurement" onClick={() => onCommand(MeasurementCommands.AddRange)}>
          <RangeMeasurementIcon />
        </ToolbarButton>

        <PopoverButton
          isActive={openMenu === "markers"}
          title="Add Timing Markers"
          onClick={() => setOpenMenu((current) => (current === "markers" ? null : "markers"))}
        >
          <TimingMarkersIcon />
          {openMenu === "markers" ? <ChevronUp size={10} strokeWidth={2} /> : <ChevronDown size={10} strokeWidth={2} />}
        </PopoverButton>
        {openMenu === "markers" && (
          <ToolbarMenu className="markerMenu">
            <button
              className="toolbarMenuItem"
              onClick={() => {
                setOpenMenu(null);
                onCommand(MarkerCommands.AddPair);
              }}
            >
              <span>Add Marker Pair</span>
              <small>A1 / A2</small>
            </button>
            <button
              className="toolbarMenuItem"
              onClick={() => {
                setOpenMenu(null);
                onCommand(MarkerCommands.AddMarker);
              }}
            >
              <span>Add Single Marker</span>
              <small>T1</small>
            </button>
          </ToolbarMenu>
        )}
      </div>

      <div className="saleaeToolbarAux" aria-label="View tools">
        <ToolbarIconButton title="Zoom in" disabled={!hasCapture} onClick={onZoomIn}>
          <ZoomIn size={14} />
        </ToolbarIconButton>
        <ToolbarIconButton title="Zoom out" disabled={!hasCapture} onClick={onZoomOut}>
          <ZoomOut size={14} />
        </ToolbarIconButton>
        <ToolbarIconButton title="Fit capture" disabled={!hasCapture} onClick={onFit}>
          <Maximize2 size={14} />
        </ToolbarIconButton>
      </div>
    </div>
  );
}

interface ToolbarButtonProps {
  children: ReactNode;
  className?: string;
  disabled?: boolean;
  isActive?: boolean;
  title: string;
  onClick: () => void;
}

function ToolbarButton({ children, className = "", disabled = false, isActive = false, title, onClick }: ToolbarButtonProps) {
  return (
    <button
      className={`saleaeToolbarItem saleaeToolbarButton ${isActive ? "active" : ""} ${className}`}
      disabled={disabled}
      title={title}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  );
}

function PopoverButton(props: ToolbarButtonProps) {
  return <ToolbarButton {...props} className={`saleaeToggleButton ${props.className ?? ""}`} />;
}

function ToolbarIconButton({ children, disabled, title, onClick }: ToolbarButtonProps) {
  return (
    <button className="saleaeAuxButton" disabled={disabled} title={title} onClick={onClick} type="button">
      {children}
    </button>
  );
}

function ToolbarMenu({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`toolbarMenu ${className}`}>{children}</div>;
}

function StartRecordingIcon() {
  return (
    <svg width="16" height="18" viewBox="0 0 16 18" fill="none" aria-hidden="true">
      <path
        d="M14.45 8.128a1 1 0 0 1 0 1.744l-12.96 7.29A1 1 0 0 1 0 16.29V1.71A1 1 0 0 1 1.49.838l12.96 7.29z"
        fill="currentColor"
      />
    </svg>
  );
}

function StopRecordingIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <rect width="14" height="14" rx="1" fill="currentColor" />
    </svg>
  );
}

function AnalyzersIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <g fill="currentColor">
        <path d="M9.668 4.017V12H8.047V4.017h1.62zM11.19 7.41v1.327H9.258V7.41h1.932zm.31-3.394v1.332H9.258V4.017H11.5zM7.092 4v8H5.538V5.886L4 6.473V5.19L6.92 4h.172z" />
      </g>
      <path
        d="M4.58 14 1.152 8 4.58 2h6.84l3.428 6-3.428 6H4.58z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function RangeMeasurementIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <g fill="currentColor">
        <path d="M7.89 3.703h-.92v1.413h.92c.27 0 .502.044.695.133.193.084.34.22.44.408.104.185.156.43.156.734 0 .224-.048.423-.144.595-.093.172-.23.309-.412.409a1.346 1.346 0 0 1-.648.144c-.213 0-.41-.046-.59-.138a1.143 1.143 0 0 1-.424-.385 1.04 1.04 0 0 1-.15-.553H5c0 .44.085.822.255 1.142.17.317.396.58.677.788.282.204.597.356.944.457.348.1.697.15 1.049.15.436 0 .841-.056 1.216-.168.374-.117.7-.285.979-.505.278-.22.494-.491.648-.812A2.49 2.49 0 0 0 11 6.421c0-.345-.064-.657-.191-.938a1.94 1.94 0 0 0-.556-.715 2.455 2.455 0 0 0-.695-.387c.208-.1.393-.22.556-.359.24-.204.423-.437.55-.697a1.83 1.83 0 0 0 .197-.824c0-.545-.123-1.002-.37-1.37A2.238 2.238 0 0 0 9.458.288C9.02.096 8.508 0 7.925 0c-.506 0-.973.098-1.402.295a2.527 2.527 0 0 0-1.025.823c-.255.357-.382.78-.382 1.269h1.813c0-.193.05-.357.15-.493.1-.14.23-.247.388-.319.162-.076.332-.114.51-.114.247 0 .448.048.602.144a.865.865 0 0 1 .353.379c.078.16.116.343.116.547 0 .237-.042.443-.127.62a.876.876 0 0 1-.382.408c-.17.096-.386.144-.649.144z" />
        <path d="M2 8H0v8h2v-3h12v3h2V8h-2v3H2V8z" />
      </g>
    </svg>
  );
}

function TimingMarkersIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <g fill="currentColor">
        <path
          fillRule="evenodd"
          clipRule="evenodd"
          d="M1 0a1 1 0 0 0-1 1v15h2V9h8a1 1 0 0 0 1-1V1a1 1 0 0 0-1-1H1zm8 2H2v5h7V2z"
        />
        <path d="M5 12v-2h2v1h7V6h-2V4h3a1 1 0 0 1 1 1v11h-2v-3H6a1 1 0 0 1-1-1z" />
      </g>
    </svg>
  );
}
