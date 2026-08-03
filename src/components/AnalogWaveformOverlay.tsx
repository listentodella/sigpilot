import { CSSProperties, useEffect, useRef, useState } from "react";
import {
  ANALOG_GRAPH_INSET_PX,
  ANALOG_GRAPH_LEFT_GUTTER_PX,
  ANALOG_VIEW_RANGE_MAX_VOLTS,
  ANALOG_VIEW_RANGE_MIN_VOLTS,
  analogSampleStepInDigitalSamples,
  demoAnalogFrequencyHz,
  sampleDemoAnalogValue,
  UiAnalogChannelSettings,
} from "../lib/analogChannels";
import type { SaleaeGraphChannelLayout } from "../lib/saleaeGraphLayout";
import { saleaeLegacyChannelColor } from "../lib/saleaeChannelColors";
import { SaleaeIcon, type SaleaeIconName } from "./SaleaeIcon";

export interface VisibleAnalogChannel {
  index: number;
  settings: UiAnalogChannelSettings;
}

type MarqueeMode = "x" | "xy" | "y";
type MarqueeIntent = MarqueeMode | "single";

interface AnalogHover {
  graphHeight: number;
  graphRight: number;
  graphTop: number;
  periodEndX: number;
  periodSeconds: number;
  unit: string;
  value: number;
  widthEndX: number;
  widthSeconds: number;
  x: number;
  y: number;
}

interface AnalogHit {
  channelIndex: number;
  graphHeight: number;
  graphTop: number;
  rowHeight: number;
  rowTop: number;
  settings: UiAnalogChannelSettings;
  x: number;
  y: number;
}

interface MarqueeState {
  channelIndex: number;
  currentX: number;
  currentY: number;
  graphHeight: number;
  graphTop: number;
  intent: MarqueeIntent;
  mode: MarqueeMode;
  rowHeight: number;
  rowTop: number;
  startX: number;
  startY: number;
}

type AnalogInteraction =
  | {
      type: "pan";
      channelIndex: number;
      graphHeight: number;
      horizontalDisabled: boolean;
      pointerId: number;
      startOffset: number;
      startRange: number;
      startX: number;
      startY: number;
      verticalActive: boolean;
    }
  | {
      type: "marquee";
      channelIndex: number;
      graphHeight: number;
      graphTop: number;
      intent: MarqueeIntent;
      pointerId: number;
      rowHeight: number;
      rowTop: number;
      settings: UiAnalogChannelSettings;
      startX: number;
      startY: number;
    };

interface AnalogWaveformOverlayProps {
  analogSampleRateHz: number;
  channels: VisibleAnalogChannel[];
  hasCapture: boolean;
  hasDemoData: boolean;
  isLive: boolean;
  layouts: SaleaeGraphChannelLayout[];
  matchChannelColors: boolean;
  onChange: (index: number, patch: Partial<UiAnalogChannelSettings>) => void;
  onViewportChange: (start: number, samples: number) => void;
  onViewportInteractionChange?: (active: boolean) => void;
  digitalSampleRateHz: number;
  totalSamples: number;
  viewportSamples: number;
  viewportStart: number;
}

const VERTICAL_DRAG_THRESHOLD_PX = 5;
const VERTICAL_DRAG_MIN_ANGLE_DEGREES = 60;
const TOOLBAR_ZOOM_FACTOR = 1.1;
const ANALOG_SAMPLE_POINT_DIAMETER_PX = 5;
const ANALOG_SAMPLE_POINT_MIN_SPACING_PX = 6;

export function AnalogWaveformOverlay({
  analogSampleRateHz,
  channels,
  hasCapture,
  hasDemoData,
  isLive,
  layouts,
  matchChannelColors,
  onChange,
  onViewportChange,
  onViewportInteractionChange,
  digitalSampleRateHz,
  totalSamples,
  viewportSamples,
  viewportStart,
}: AnalogWaveformOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const activeToolRef = useRef<MarqueeMode | null>(null);
  const lastAnalogHitRef = useRef<AnalogHit | null>(null);
  const interactionRef = useRef<AnalogInteraction | null>(null);
  const latestRef = useRef({
    analogSampleRateHz,
    channels,
    digitalSampleRateHz,
    hasData: hasCapture && hasDemoData,
    isLive,
    layouts,
    onChange,
    onViewportChange,
    onViewportInteractionChange,
    totalSamples,
    viewportSamples,
    viewportStart,
  });
  const hoverFrameRef = useRef<number | null>(null);
  const pendingHoverRef = useRef<AnalogHover | null>(null);
  const [activeTool, setActiveTool] = useState<MarqueeMode | null>(null);
  const [hover, setHover] = useState<AnalogHover | null>(null);
  const [marquee, setMarquee] = useState<MarqueeState | null>(null);

  latestRef.current = {
    analogSampleRateHz,
    channels,
    digitalSampleRateHz,
    hasData: hasCapture && hasDemoData,
    isLive,
    layouts,
    onChange,
    onViewportChange,
    onViewportInteractionChange,
    totalSamples,
    viewportSamples,
    viewportStart,
  };
  activeToolRef.current = activeTool;

  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas) return;

    const draw = () => {
      const rect = host.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const width = Math.max(1, Math.floor(rect.width * dpr));
      const height = Math.max(1, Math.floor(rect.height * dpr));
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) return;
      context.clearRect(0, 0, width, height);
      context.save();
      context.scale(dpr, dpr);

      channels.forEach(({ index, settings }, rowIndex) => {
        const layout = layouts[rowIndex];
        if (!layout) return;
        drawAnalogRow(context, {
          analogSampleRateHz,
          color: matchChannelColors ? saleaeLegacyChannelColor(index) : "#d4d4d4",
          digitalSampleRateHz,
          hasData: hasCapture && hasDemoData,
          height: layout.height,
          index,
          settings,
          top: layout.top,
          totalSamples,
          viewportSamples,
          viewportStart,
          width: rect.width,
        });
      });
      context.restore();
    };

    const observer = new ResizeObserver(draw);
    observer.observe(host);
    draw();
    return () => observer.disconnect();
  }, [
    analogSampleRateHz,
    channels,
    digitalSampleRateHz,
    hasCapture,
    hasDemoData,
    layouts,
    matchChannelColors,
    totalSamples,
    viewportSamples,
    viewportStart,
  ]);

  useEffect(() => {
    const host = hostRef.current;
    const viewport = host?.parentElement;
    if (!host || !viewport) return;

    const updateHover = (clientX: number, clientY: number) => {
      const latest = latestRef.current;
      if (!latest.hasData || interactionRef.current) {
        lastAnalogHitRef.current = null;
        queueHover(null);
        return;
      }
      const hit = findAnalogHit(viewport, latest.channels, latest.layouts, clientX, clientY);
      if (!hit || latest.totalSamples <= 0) {
        lastAnalogHitRef.current = null;
        queueHover(null);
        return;
      }
      lastAnalogHitRef.current = hit;
      if (hit.x < ANALOG_GRAPH_LEFT_GUTTER_PX) {
        queueHover(null);
        return;
      }
      const rect = viewport.getBoundingClientRect();
      const graphWidth = Math.max(1, rect.width - ANALOG_GRAPH_LEFT_GUTTER_PX);
      const ratio = clamp((hit.x - ANALOG_GRAPH_LEFT_GUTTER_PX) / graphWidth, 0, 1);
      const sample = latest.viewportStart + ratio * latest.viewportSamples;
      const value = sampleDemoAnalogValue(
        hit.channelIndex,
        hit.settings,
        sample,
        latest.digitalSampleRateHz,
      );
      const y = analogValueToY(value, hit.settings, hit.graphTop, hit.graphHeight);
      if (y < hit.graphTop || y > hit.graphTop + hit.graphHeight) {
        queueHover(null);
        return;
      }
      const periodSamples =
        latest.digitalSampleRateHz / demoAnalogFrequencyHz(hit.channelIndex);
      const widthEndSample = findNextAnalogSameValueSample(
        hit.channelIndex,
        hit.settings,
        sample,
        latest.digitalSampleRateHz,
        periodSamples,
      );
      const pixelsPerSample = graphWidth / Math.max(1, latest.viewportSamples);
      queueHover({
        graphHeight: hit.graphHeight,
        graphRight: rect.width,
        graphTop: hit.graphTop,
        periodEndX: hit.x + periodSamples * pixelsPerSample,
        periodSeconds: periodSamples / Math.max(1, latest.digitalSampleRateHz),
        unit: hit.settings.unit,
        value,
        widthEndX: hit.x + (widthEndSample - sample) * pixelsPerSample,
        widthSeconds: (widthEndSample - sample) / Math.max(1, latest.digitalSampleRateHz),
        x: hit.x,
        y,
      });
    };

    const handlePointerDown = (event: PointerEvent) => {
      if (event.button !== 0 || isAnalogToolbarTarget(event.target)) return;
      const latest = latestRef.current;
      const hit = findAnalogHit(viewport, latest.channels, latest.layouts, event.clientX, event.clientY);
      if (!hit) return;

      const modifierIntent: MarqueeIntent | null =
        event.metaKey || event.ctrlKey ? (event.shiftKey ? "single" : "xy") : null;
      const intent = activeToolRef.current ?? modifierIntent;
      queueHover(null);

      if (intent) {
        event.preventDefault();
        event.stopPropagation();
        interactionRef.current = {
          type: "marquee",
          channelIndex: hit.channelIndex,
          graphHeight: hit.graphHeight,
          graphTop: hit.graphTop,
          intent,
          pointerId: event.pointerId,
          rowHeight: hit.rowHeight,
          rowTop: hit.rowTop,
          settings: { ...hit.settings },
          startX: hit.x,
          startY: hit.y,
        };
        setMarquee({
          channelIndex: hit.channelIndex,
          currentX: hit.x,
          currentY: hit.y,
          graphHeight: hit.graphHeight,
          graphTop: hit.graphTop,
          intent,
          mode: intent === "single" ? "x" : intent,
          rowHeight: hit.rowHeight,
          rowTop: hit.rowTop,
          startX: hit.x,
          startY: hit.y,
        });
        latest.onViewportInteractionChange?.(true);
        return;
      }

      interactionRef.current = {
        type: "pan",
        channelIndex: hit.channelIndex,
        graphHeight: hit.graphHeight,
        horizontalDisabled: hit.x < ANALOG_GRAPH_LEFT_GUTTER_PX,
        pointerId: event.pointerId,
        startOffset: hit.settings.viewOffsetVolts,
        startRange: hit.settings.viewRangeVolts,
        startX: event.clientX,
        startY: event.clientY,
        verticalActive: false,
      };
      if (hit.x < ANALOG_GRAPH_LEFT_GUTTER_PX) {
        event.preventDefault();
        event.stopPropagation();
        latest.onViewportInteractionChange?.(true);
      }
    };

    const handlePointerMove = (event: PointerEvent) => {
      const interaction = interactionRef.current;
      if (!interaction) {
        if (isAnalogToolbarTarget(event.target)) {
          queueHover(null);
          return;
        }
        updateHover(event.clientX, event.clientY);
        return;
      }
      if (interaction.pointerId !== event.pointerId) return;

      if (interaction.type === "marquee") {
        event.preventDefault();
        event.stopPropagation();
        const rect = viewport.getBoundingClientRect();
        const x = clamp(event.clientX - rect.left, ANALOG_GRAPH_LEFT_GUTTER_PX, rect.width);
        const y = clamp(event.clientY - rect.top, interaction.graphTop, interaction.graphTop + interaction.graphHeight);
        const mode = resolveMarqueeMode(interaction.intent, x - interaction.startX, y - interaction.startY);
        setMarquee({
          channelIndex: interaction.channelIndex,
          currentX: x,
          currentY: y,
          graphHeight: interaction.graphHeight,
          graphTop: interaction.graphTop,
          intent: interaction.intent,
          mode,
          rowHeight: interaction.rowHeight,
          rowTop: interaction.rowTop,
          startX: interaction.startX,
          startY: interaction.startY,
        });
        return;
      }

      const deltaX = event.clientX - interaction.startX;
      const deltaY = event.clientY - interaction.startY;
      if (interaction.horizontalDisabled) {
        event.preventDefault();
        event.stopPropagation();
      }
      if (!interaction.verticalActive) {
        const displacement = Math.abs(deltaY);
        const angle = Math.atan2(displacement, Math.abs(deltaX)) * (180 / Math.PI);
        if (
          displacement > VERTICAL_DRAG_THRESHOLD_PX * (window.devicePixelRatio || 1) &&
          angle > VERTICAL_DRAG_MIN_ANGLE_DEGREES
        ) {
          interaction.verticalActive = true;
          latestRef.current.onViewportInteractionChange?.(true);
        }
      }
      if (interaction.verticalActive) {
        latestRef.current.onChange(interaction.channelIndex, {
          viewOffsetVolts:
            interaction.startOffset + (deltaY / Math.max(1, interaction.graphHeight)) * interaction.startRange,
        });
      }
    };

    const finishPointerInteraction = (event: PointerEvent) => {
      const interaction = interactionRef.current;
      if (!interaction || interaction.pointerId !== event.pointerId) return;
      interactionRef.current = null;

      if (interaction.type === "marquee") {
        event.preventDefault();
        event.stopPropagation();
        const rect = viewport.getBoundingClientRect();
        const endX = clamp(event.clientX - rect.left, ANALOG_GRAPH_LEFT_GUTTER_PX, rect.width);
        const endY = clamp(event.clientY - rect.top, interaction.graphTop, interaction.graphTop + interaction.graphHeight);
        applyMarqueeZoom(interaction, endX, endY, rect.width, latestRef.current);
        setMarquee(null);
        if (activeToolRef.current) setActiveTool(null);
      }
      latestRef.current.onViewportInteractionChange?.(false);
      updateHover(event.clientX, event.clientY);
    };

    const handleWheel = (event: WheelEvent) => {
      if (isAnalogToolbarTarget(event.target)) return;
      const latest = latestRef.current;
      const hit = findAnalogHit(viewport, latest.channels, latest.layouts, event.clientX, event.clientY);
      if (!hit) return;
      const overVoltageRuler = hit.x < ANALOG_GRAPH_LEFT_GUTTER_PX;
      if (!event.metaKey && !event.ctrlKey && !overVoltageRuler) return;
      event.preventDefault();
      event.stopPropagation();
      queueHover(null);

      const scale = event.shiftKey ? 0.1 : 1;
      const delta = normalizeWheelDelta(event.deltaY, event.deltaMode);
      const factor = Math.exp(clamp(delta, -800, 800) * 0.0015 * scale);
      const nextRange = clamp(
        hit.settings.viewRangeVolts * factor,
        ANALOG_VIEW_RANGE_MIN_VOLTS,
        ANALOG_VIEW_RANGE_MAX_VOLTS,
      );
      if (Math.abs(nextRange - hit.settings.viewRangeVolts) < Number.EPSILON) return;
      const yRatio = clamp((hit.y - hit.graphTop) / Math.max(1, hit.graphHeight), 0, 1);
      const anchorValue = analogYToValue(hit.y, hit.settings, hit.graphTop, hit.graphHeight);
      latest.onChange(hit.channelIndex, {
        viewOffsetVolts: anchorValue - nextRange * (0.5 - yRatio),
        viewRangeVolts: nextRange,
      });
    };

    const handlePointerLeave = () => {
      if (!interactionRef.current) {
        lastAnalogHitRef.current = null;
        queueHover(null);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && (interactionRef.current?.type === "marquee" || activeToolRef.current)) {
        event.preventDefault();
        interactionRef.current = null;
        setMarquee(null);
        setActiveTool(null);
        latestRef.current.onViewportInteractionChange?.(false);
        return;
      }
      if (isTextEditingTarget(event.target)) return;
      const hit = lastAnalogHitRef.current;
      if (!hit) return;
      const latest = latestRef.current;
      const settings = latest.channels.find(({ index }) => index === hit.channelIndex)?.settings;
      if (!settings) return;

      if ((event.metaKey || event.ctrlKey) && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
        event.preventDefault();
        event.stopImmediatePropagation();
        const factor = event.key === "ArrowUp" ? 0.5 : 2;
        const nextRange = clamp(
          settings.viewRangeVolts * factor,
          ANALOG_VIEW_RANGE_MIN_VOLTS,
          ANALOG_VIEW_RANGE_MAX_VOLTS,
        );
        const yRatio = clamp((hit.y - hit.graphTop) / Math.max(1, hit.graphHeight), 0, 1);
        const anchorValue = analogYToValue(hit.y, settings, hit.graphTop, hit.graphHeight);
        latest.onChange(hit.channelIndex, {
          viewOffsetVolts: anchorValue - nextRange * (0.5 - yRatio),
          viewRangeVolts: nextRange,
        });
        queueHover(null);
        return;
      }

      if (!event.metaKey && !event.ctrlKey && !event.altKey && event.key.toLowerCase() === "f" && !latest.isLive) {
        event.preventDefault();
        event.stopImmediatePropagation();
        latest.onChange(hit.channelIndex, {
          viewOffsetVolts: settings.offsetVolts,
          viewRangeVolts: settings.rangeVolts,
        });
        queueHover(null);
      }
    };

    viewport.addEventListener("pointerdown", handlePointerDown, true);
    viewport.addEventListener("pointermove", handlePointerMove, true);
    viewport.addEventListener("pointerup", finishPointerInteraction, true);
    viewport.addEventListener("pointercancel", finishPointerInteraction, true);
    viewport.addEventListener("pointerleave", handlePointerLeave);
    viewport.addEventListener("wheel", handleWheel, { capture: true, passive: false });
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      viewport.removeEventListener("pointerdown", handlePointerDown, true);
      viewport.removeEventListener("pointermove", handlePointerMove, true);
      viewport.removeEventListener("pointerup", finishPointerInteraction, true);
      viewport.removeEventListener("pointercancel", finishPointerInteraction, true);
      viewport.removeEventListener("pointerleave", handlePointerLeave);
      viewport.removeEventListener("wheel", handleWheel, true);
      document.removeEventListener("keydown", handleKeyDown);
      if (hoverFrameRef.current !== null) cancelAnimationFrame(hoverFrameRef.current);
    };

    function queueHover(next: AnalogHover | null) {
      pendingHoverRef.current = next;
      if (hoverFrameRef.current !== null) return;
      hoverFrameRef.current = requestAnimationFrame(() => {
        hoverFrameRef.current = null;
        setHover(pendingHoverRef.current);
      });
    }
  }, []);

  function changeVerticalRange(index: number, settings: UiAnalogChannelSettings, factor: number) {
    onChange(index, {
      viewRangeVolts: clamp(
        settings.viewRangeVolts * factor,
        ANALOG_VIEW_RANGE_MIN_VOLTS,
        ANALOG_VIEW_RANGE_MAX_VOLTS,
      ),
    });
  }

  return (
    <div className={`analogWaveformOverlay ${activeTool ? "selectingRange" : ""}`} ref={hostRef}>
      <canvas aria-hidden="true" className="analogWaveformCanvas" ref={canvasRef} />
      {hover && <AnalogInstantMeasurement hover={hover} />}
      {marquee && <AnalogMarquee state={marquee} />}
      {channels.map(({ index, settings }, rowIndex) => {
        const layout = layouts[rowIndex];
        if (!layout) return null;
        return (
          <div
            className="analogWaveformToolbar"
            key={index}
            style={
              {
                "--analog-channel-color": saleaeLegacyChannelColor(index),
                height: layout.height,
                top: layout.top,
              } as CSSProperties
            }
          >
            <div className="analogVerticalTools">
              <div className="analogVerticalToolsExpanded">
                <AnalogToolButton
                  active={activeTool === "xy"}
                  icon="marqueeZoomXY"
                  label="XY Range Zoom"
                  onClick={() => setActiveTool((current) => (current === "xy" ? null : "xy"))}
                  shortcut="Cmd/Ctrl + drag"
                />
                <AnalogToolButton
                  active={activeTool === "y"}
                  icon="marqueeZoomY"
                  label="Y Range Zoom"
                  onClick={() => setActiveTool((current) => (current === "y" ? null : "y"))}
                  shortcut="Cmd/Ctrl + Shift + drag"
                />
                <AnalogToolButton
                  active={activeTool === "x"}
                  icon="marqueeZoomX"
                  label="X Range Zoom"
                  onClick={() => setActiveTool((current) => (current === "x" ? null : "x"))}
                  shortcut="Cmd/Ctrl + Shift + drag"
                />
                <AnalogToolButton
                  icon="zoomOutVertical"
                  label="Y Zoom Out"
                  onClick={() => changeVerticalRange(index, settings, TOOLBAR_ZOOM_FACTOR)}
                  shortcut="Cmd/Ctrl + Down"
                />
                <AnalogToolButton
                  icon="zoomInVertical"
                  label="Y Zoom In"
                  onClick={() => changeVerticalRange(index, settings, 1 / TOOLBAR_ZOOM_FACTOR)}
                  shortcut="Cmd/Ctrl + Up"
                />
              </div>
              <AnalogToolButton
                disabled={isLive}
                icon="fitVertical"
                label={isLive ? "Y Fit disabled when recording" : "Y Fit"}
                onClick={() =>
                  onChange(index, {
                    viewOffsetVolts: settings.offsetVolts,
                    viewRangeVolts: settings.rangeVolts,
                  })
                }
                shortcut="F"
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function AnalogToolButton({
  active = false,
  disabled = false,
  icon,
  label,
  onClick,
  shortcut,
}: {
  active?: boolean;
  disabled?: boolean;
  icon: SaleaeIconName;
  label: string;
  onClick: () => void;
  shortcut?: string;
}) {
  return (
    <button
      aria-label={label}
      className={active ? "active" : ""}
      data-shortcut={shortcut}
      data-tooltip={label}
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      onPointerDown={(event) => event.stopPropagation()}
      type="button"
    >
      <SaleaeIcon name={icon} />
    </button>
  );
}

function AnalogMarquee({ state }: { state: MarqueeState }) {
  const left = state.mode === "y" ? ANALOG_GRAPH_LEFT_GUTTER_PX : Math.min(state.startX, state.currentX);
  const top = state.mode === "x" ? state.graphTop : Math.min(state.startY, state.currentY);
  const width = state.mode === "y" ? `calc(100% - ${ANALOG_GRAPH_LEFT_GUTTER_PX}px)` : Math.abs(state.currentX - state.startX);
  const height = state.mode === "x" ? state.graphHeight : Math.abs(state.currentY - state.startY);
  return (
    <div
      aria-hidden="true"
      className={`analogMarquee analogMarquee-${state.mode}`}
      style={{ height, left, top, width }}
    />
  );
}

function AnalogInstantMeasurement({ hover }: { hover: AnalogHover }) {
  const bottom = hover.graphTop + hover.graphHeight;
  const showDistances = hover.widthEndX - hover.x > 5;
  return (
    <div className="analogHoverReadout" aria-hidden="true">
      <span
        className="analogMeasurementVertical"
        style={{ height: Math.max(0, hover.y - hover.graphTop), left: hover.x, top: hover.graphTop }}
      />
      {showDistances && (
        <span
          className="analogMeasurementVertical"
          style={{ height: Math.max(0, bottom - hover.y), left: hover.x, top: hover.y }}
        />
      )}
      <span className="analogHoverPoint" style={{ left: hover.x, top: hover.y }}>
        <span className="analogHoverDot" />
      </span>
      <span
        className="analogHoverVoltage"
        style={{ right: hover.graphRight - hover.x + 6, top: hover.y - 8 }}
      >
        {formatVoltage(hover.value, hover.unit)}
      </span>
      {showDistances && (
        <>
          <AnalogMeasurementDistance
            endX={hover.widthEndX}
            graphRight={hover.graphRight}
            label={formatTime(hover.widthSeconds)}
            startX={hover.x}
            y={hover.graphTop + 7}
          />
          <AnalogMeasurementDistance
            endX={hover.periodEndX}
            graphRight={hover.graphRight}
            label={formatTime(hover.periodSeconds)}
            labelAbove
            startX={hover.x}
            y={bottom - 7}
          />
        </>
      )}
      {showDistances && hover.widthEndX <= hover.graphRight && (
        <span
          className="analogMeasurementVertical"
          style={{ height: Math.max(0, hover.y - hover.graphTop), left: hover.widthEndX, top: hover.graphTop }}
        />
      )}
      {showDistances && hover.periodEndX <= hover.graphRight && (
        <span
          className="analogMeasurementVertical"
          style={{ height: Math.max(0, bottom - hover.y), left: hover.periodEndX, top: hover.y }}
        />
      )}
    </div>
  );
}

function AnalogMeasurementDistance({
  endX,
  graphRight,
  label,
  labelAbove = false,
  startX,
  y,
}: {
  endX: number;
  graphRight: number;
  label: string;
  labelAbove?: boolean;
  startX: number;
  y: number;
}) {
  const left = Math.max(ANALOG_GRAPH_LEFT_GUTTER_PX, startX);
  const right = Math.min(graphRight, endX);
  const distance = right - left;
  if (distance <= 5) return null;
  const centered = distance >= 100;
  return (
    <span className="analogMeasurementDistance">
      <span className="analogMeasurementArrow" style={{ left, top: y, width: distance }}>
        {startX > ANALOG_GRAPH_LEFT_GUTTER_PX && <span className="analogMeasurementArrowLeft" />}
        {endX <= graphRight && <span className="analogMeasurementArrowRight" />}
      </span>
      <span
        className={`analogMeasurementLabel ${centered ? "centered" : "atEnd"}`}
        style={{ left: centered ? (left + right) / 2 : right + 4, top: labelAbove ? y - 16 : y }}
      >
        {label}
      </span>
    </span>
  );
}

function applyMarqueeZoom(
  interaction: Extract<AnalogInteraction, { type: "marquee" }>,
  endX: number,
  endY: number,
  width: number,
  latest: {
    onChange: (index: number, patch: Partial<UiAnalogChannelSettings>) => void;
    onViewportChange: (start: number, samples: number) => void;
    viewportSamples: number;
    viewportStart: number;
  },
) {
  const mode = resolveMarqueeMode(
    interaction.intent,
    endX - interaction.startX,
    endY - interaction.startY,
  );
  if (mode !== "y" && Math.abs(endX - interaction.startX) > 1) {
    const graphWidth = Math.max(1, width - ANALOG_GRAPH_LEFT_GUTTER_PX);
    const startRatio = clamp((interaction.startX - ANALOG_GRAPH_LEFT_GUTTER_PX) / graphWidth, 0, 1);
    const endRatio = clamp((endX - ANALOG_GRAPH_LEFT_GUTTER_PX) / graphWidth, 0, 1);
    const startSample = latest.viewportStart + Math.min(startRatio, endRatio) * latest.viewportSamples;
    const samples = Math.abs(endRatio - startRatio) * latest.viewportSamples;
    latest.onViewportChange(startSample, Math.max(1, samples));
  }
  if (mode !== "x" && Math.abs(endY - interaction.startY) > 1) {
    const firstValue = analogYToValue(
      interaction.startY,
      interaction.settings,
      interaction.graphTop,
      interaction.graphHeight,
    );
    const secondValue = analogYToValue(
      endY,
      interaction.settings,
      interaction.graphTop,
      interaction.graphHeight,
    );
    latest.onChange(interaction.channelIndex, {
      viewOffsetVolts: (firstValue + secondValue) / 2,
      viewRangeVolts: clamp(
        Math.abs(firstValue - secondValue),
        ANALOG_VIEW_RANGE_MIN_VOLTS,
        ANALOG_VIEW_RANGE_MAX_VOLTS,
      ),
    });
  }
}

function resolveMarqueeMode(intent: MarqueeIntent, deltaX: number, deltaY: number): MarqueeMode {
  if (intent !== "single") return intent;
  return Math.abs(deltaX) > Math.abs(deltaY) ? "x" : "y";
}

function findAnalogHit(
  viewport: HTMLElement,
  channels: VisibleAnalogChannel[],
  layouts: SaleaeGraphChannelLayout[],
  clientX: number,
  clientY: number,
): AnalogHit | null {
  const rect = viewport.getBoundingClientRect();
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  if (x < 0 || x > rect.width || y < 0 || y > rect.height) return null;
  const rowIndex = layouts.findIndex((layout) => y >= layout.top && y <= layout.top + layout.height);
  const channel = channels[rowIndex];
  const layout = layouts[rowIndex];
  if (!channel || !layout) return null;
  return {
    channelIndex: channel.index,
    graphHeight: Math.max(30, layout.height - ANALOG_GRAPH_INSET_PX * 2),
    graphTop: layout.top + ANALOG_GRAPH_INSET_PX,
    rowHeight: layout.height,
    rowTop: layout.top,
    settings: channel.settings,
    x,
    y,
  };
}

function isAnalogToolbarTarget(target: EventTarget | null) {
  return target instanceof Element && Boolean(target.closest(".analogVerticalTools"));
}

function analogYToValue(
  y: number,
  settings: UiAnalogChannelSettings,
  graphTop: number,
  graphHeight: number,
) {
  const ratio = (y - graphTop) / Math.max(1, graphHeight);
  return settings.viewOffsetVolts + settings.viewRangeVolts * (0.5 - ratio);
}

function analogValueToY(
  value: number,
  settings: UiAnalogChannelSettings,
  graphTop: number,
  graphHeight: number,
) {
  const minVoltage = settings.viewOffsetVolts - settings.viewRangeVolts / 2;
  return graphTop + graphHeight - ((value - minVoltage) / settings.viewRangeVolts) * graphHeight;
}

function findNextAnalogSameValueSample(
  channelIndex: number,
  settings: UiAnalogChannelSettings,
  sample: number,
  digitalSampleRateHz: number,
  periodSamples: number,
) {
  const target = sampleDemoAnalogValue(channelIndex, settings, sample, digitalSampleRateHz);
  const slices = 256;
  const firstOffset = Math.max(periodSamples / 10_000, 1e-6);
  let previousSample = sample + firstOffset;
  let previousDelta =
    sampleDemoAnalogValue(channelIndex, settings, previousSample, digitalSampleRateHz) - target;

  for (let slice = 1; slice <= slices; slice += 1) {
    const nextSample = sample + (periodSamples * slice) / slices;
    const nextDelta =
      sampleDemoAnalogValue(channelIndex, settings, nextSample, digitalSampleRateHz) - target;
    if (nextDelta === 0 || previousDelta === 0 || Math.sign(nextDelta) !== Math.sign(previousDelta)) {
      let low = previousSample;
      let high = nextSample;
      let lowDelta = previousDelta;
      for (let iteration = 0; iteration < 24; iteration += 1) {
        const middle = (low + high) / 2;
        const middleDelta =
          sampleDemoAnalogValue(channelIndex, settings, middle, digitalSampleRateHz) - target;
        if (middleDelta === 0) return middle;
        if (Math.sign(middleDelta) === Math.sign(lowDelta)) {
          low = middle;
          lowDelta = middleDelta;
        } else {
          high = middle;
        }
      }
      return (low + high) / 2;
    }
    previousSample = nextSample;
    previousDelta = nextDelta;
  }
  return sample + periodSamples;
}

function drawAnalogRow(
  context: CanvasRenderingContext2D,
  options: {
    analogSampleRateHz: number;
    color: string;
    digitalSampleRateHz: number;
    hasData: boolean;
    height: number;
    index: number;
    settings: UiAnalogChannelSettings;
    top: number;
    totalSamples: number;
    viewportSamples: number;
    viewportStart: number;
    width: number;
  },
) {
  const {
    analogSampleRateHz,
    color,
    digitalSampleRateHz,
    hasData,
    height,
    index,
    settings,
    top,
    totalSamples,
    viewportSamples,
    viewportStart,
    width,
  } = options;
  const graphTop = top + ANALOG_GRAPH_INSET_PX;
  const graphHeight = Math.max(30, height - ANALOG_GRAPH_INSET_PX * 2);

  context.save();
  context.beginPath();
  context.rect(0, top, width, height);
  context.clip();
  context.fillStyle = "#101013";
  context.fillRect(0, top, width, height);

  context.font = '10px "Roboto Mono", ui-monospace, monospace';
  context.textBaseline = "middle";
  context.setLineDash([4, 4]);
  for (let tick = 0; tick <= 4; tick += 1) {
    const ratio = tick / 4;
    const y = graphTop + ratio * graphHeight;
    const value = settings.viewOffsetVolts + settings.viewRangeVolts * (0.5 - ratio);
    context.strokeStyle = tick === 2 ? "rgba(255,255,255,0.14)" : "rgba(255,255,255,0.10)";
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(ANALOG_GRAPH_LEFT_GUTTER_PX, y + 0.5);
    context.lineTo(width, y + 0.5);
    context.stroke();
    context.fillStyle = "rgba(255,255,255,0.78)";
    context.fillText(formatVoltage(value, settings.unit), 6, y);
  }
  context.setLineDash([]);

  if (!hasData || totalSamples <= 0 || viewportSamples <= 0) {
    context.fillStyle = "rgba(255,255,255,0.38)";
    context.font = '11px Roboto, "Helvetica Neue", sans-serif';
    context.textAlign = "center";
    context.fillText(
      "No analog data",
      ANALOG_GRAPH_LEFT_GUTTER_PX + (width - ANALOG_GRAPH_LEFT_GUTTER_PX) / 2,
      graphTop + graphHeight / 2,
    );
    context.restore();
    return;
  }

  const graphWidth = Math.max(1, width - ANALOG_GRAPH_LEFT_GUTTER_PX);
  const sampleAtX = (x: number) =>
    viewportStart +
    (x / graphWidth) * viewportSamples;
  const xAtSample = (sample: number) =>
    ANALOG_GRAPH_LEFT_GUTTER_PX + ((sample - viewportStart) / viewportSamples) * graphWidth;
  const sampleStep = analogSampleStepInDigitalSamples(
    digitalSampleRateHz,
    analogSampleRateHz,
  );
  const sampleSpacingPx = (sampleStep / viewportSamples) * graphWidth;
  const showSamplePoints = sampleSpacingPx > ANALOG_SAMPLE_POINT_MIN_SPACING_PX;

  context.strokeStyle = color;
  context.lineWidth = 1;
  context.globalAlpha = 0.95;
  context.beginPath();
  if (showSamplePoints) {
    const lastCaptureSample = Math.max(0, totalSamples - 1);
    const firstAnalogIndex = Math.max(0, Math.floor(viewportStart / sampleStep) - 1);
    const lastAnalogIndex = Math.min(
      Math.floor(lastCaptureSample / sampleStep),
      Math.ceil((viewportStart + viewportSamples) / sampleStep) + 1,
    );
    for (let analogIndex = firstAnalogIndex; analogIndex <= lastAnalogIndex; analogIndex += 1) {
      const sample = analogIndex * sampleStep;
      const x = xAtSample(sample);
      const value = sampleDemoAnalogValue(index, settings, sample, digitalSampleRateHz);
      const y = analogValueToY(value, settings, graphTop, graphHeight);
      if (analogIndex === firstAnalogIndex) context.moveTo(x, y);
      else context.lineTo(x, y);
    }
  } else {
    for (let x = ANALOG_GRAPH_LEFT_GUTTER_PX; x <= width; x += 1) {
      const sample = sampleAtX(x - ANALOG_GRAPH_LEFT_GUTTER_PX);
      const value = sampleDemoAnalogValue(index, settings, sample, digitalSampleRateHz);
      const y = analogValueToY(value, settings, graphTop, graphHeight);
      if (x === ANALOG_GRAPH_LEFT_GUTTER_PX) context.moveTo(x, y);
      else context.lineTo(x, y);
    }
  }
  context.stroke();

  if (showSamplePoints) {
    const radius = ANALOG_SAMPLE_POINT_DIAMETER_PX / 2;
    const firstAnalogIndex = Math.max(0, Math.ceil(viewportStart / sampleStep));
    const lastAnalogIndex = Math.min(
      Math.floor((totalSamples - 1) / sampleStep),
      Math.floor((viewportStart + viewportSamples) / sampleStep),
    );
    context.fillStyle = color;
    context.beginPath();
    for (let analogIndex = firstAnalogIndex; analogIndex <= lastAnalogIndex; analogIndex += 1) {
      const sample = analogIndex * sampleStep;
      const x = xAtSample(sample);
      const value = sampleDemoAnalogValue(index, settings, sample, digitalSampleRateHz);
      const y = analogValueToY(value, settings, graphTop, graphHeight);
      context.moveTo(x + radius, y);
      context.arc(x, y, radius, 0, Math.PI * 2);
    }
    context.fill();
  }
  context.restore();
}

function formatVoltage(value: number, unit: string) {
  const absolute = Math.abs(value);
  if (absolute > 0 && absolute < 1) return `${formatCompact(value * 1_000)} m${unit}`;
  return `${formatCompact(value)} ${unit}`;
}

function formatTime(seconds: number) {
  const absolute = Math.abs(seconds);
  if (absolute >= 1) return `${formatCompact(seconds)} s`;
  if (absolute >= 1e-3) return `${formatCompact(seconds * 1e3)} ms`;
  if (absolute >= 1e-6) return `${formatCompact(seconds * 1e6)} us`;
  return `${formatCompact(seconds * 1e9)} ns`;
}

function formatCompact(value: number) {
  if (!Number.isFinite(value)) return "-";
  if (Number.isInteger(value)) return String(value);
  const absolute = Math.abs(value);
  const digits = absolute >= 100 ? 1 : absolute >= 10 ? 2 : 3;
  return value.toFixed(digits).replace(/0+$/, "").replace(/\.$/, "");
}

function normalizeWheelDelta(delta: number, mode: number) {
  if (mode === WheelEvent.DOM_DELTA_LINE) return delta * 16;
  if (mode === WheelEvent.DOM_DELTA_PAGE) return delta * window.innerHeight;
  return delta;
}

function isTextEditingTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.matches("input, textarea, select, [role='textbox']");
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, value));
}
