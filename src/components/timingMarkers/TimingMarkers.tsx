import {
  CSSProperties,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { WaveformTile } from "../../lib/api";
import { findNearestEdgeSample } from "../../lib/waveformEdgeSnap";
import { findSaleaeGraphChannelIndexAtY, getSaleaeGraphChannelLayout } from "../../lib/saleaeGraphLayout";
import {
  getNextTimingMarkerNumber,
  getTimingMarkerFullLabel,
  formatTimingMarkerFrequency,
  formatTimingMarkerSeconds,
  orderTimingPairSamples,
  TIMING_MARKER_COLORS,
  TIMING_MARKER_MOVEMENT_THRESHOLD_PX,
  timingMarkerColorValue,
  timingMarkerToPlacementMarker,
  TimingMarkerColor,
  TimingMarkerItemType,
  UiTimingMarker,
  UiTimingMarkerPlacement,
} from "../../lib/timingMarkers";
import { SaleaeIcon } from "../SaleaeIcon";

type MarkerUpdater = (updater: (markers: UiTimingMarker[]) => UiTimingMarker[]) => void;
type PlacementUpdater = (
  updater: (placement: UiTimingMarkerPlacement | null) => UiTimingMarkerPlacement | null,
) => void;

interface TimingMarkersOverlayProps {
  markers: UiTimingMarker[];
  onChangeMarkers: MarkerUpdater;
  onChangePlacement: PlacementUpdater;
  onMessage: (message: string) => void;
  onAddSingleMarker: (sample: number) => void;
  onOpenSidebar: () => void;
  onViewportChange: (start: number, samples: number) => void;
  placement: UiTimingMarkerPlacement | null;
  sampleRateHz: number;
  rowHeights: number[];
  rowTopInsets?: number[];
  tile: WaveformTile | null;
  totalSamples: number;
  viewportSamples: number;
  viewportStart: number;
}

interface DragState {
  editOnClick: boolean;
  id: string;
  initialClientX: number;
  itemType: TimingMarkerItemType;
  moved: boolean;
  pointerId: number;
}

interface HoverState {
  id: string;
  itemType: TimingMarkerItemType;
}

interface GraphContextMenuState {
  id: string;
  itemType: TimingMarkerItemType;
  x: number;
  y: number;
}

// Ported from Logic 2.4.43 timingMarkers/GraphMarkers and useHandleTempMarker.
export function TimingMarkersOverlay({
  markers,
  onChangeMarkers,
  onChangePlacement,
  onMessage,
  onAddSingleMarker,
  onOpenSidebar,
  onViewportChange,
  placement,
  sampleRateHz,
  rowHeights,
  rowTopInsets = [],
  tile,
  totalSamples,
  viewportSamples,
  viewportStart,
}: TimingMarkersOverlayProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const [dragging, setDragging] = useState<HoverState | null>(null);
  const [hovered, setHovered] = useState<HoverState | null>(null);
  const [contextMenu, setContextMenu] = useState<GraphContextMenuState | null>(null);

  useEffect(() => {
    const isDragging = Boolean(placement || dragging);
    document.body.classList.toggle("timing-marker-col-resize", isDragging);
    return () => document.body.classList.remove("timing-marker-col-resize");
  }, [dragging, placement]);

  useEffect(() => {
    function handleOutsidePointerDown(event: PointerEvent) {
      if (
        contextMenu &&
        !(event.target as Element | null)?.closest?.("[data-timing-marker-menu]") &&
        !(event.target as Element | null)?.closest?.("[data-finalized-timing-marker]")
      ) {
        setContextMenu(null);
      }
      if ((event.target as Element | null)?.closest?.("[data-timing-marker-interactive]")) return;
      if (!markers.some((marker) => marker.selected || marker.graphPopupOpen)) return;
      onChangeMarkers((current) =>
        current.map((marker) => ({ ...marker, graphPopupOpen: null, selected: false })),
      );
    }
    document.addEventListener("pointerdown", handleOutsidePointerDown);
    return () => document.removeEventListener("pointerdown", handleOutsidePointerDown);
  }, [contextMenu, markers, onChangeMarkers]);

  if (totalSamples <= 0) return null;

  function sampleToPercent(sample: number) {
    return ((sample - viewportStart) / Math.max(1, viewportSamples)) * 100;
  }

  function clientXToSample(clientX: number, clientY?: number, snappingEnabled = true) {
    const root = rootRef.current;
    if (!root) return 0;
    const rect = root.getBoundingClientRect();
    const ratio = clamp((clientX - rect.left) / Math.max(1, rect.width), 0, 1);
    const rawSample = clampSample(viewportStart + ratio * viewportSamples, totalSamples);
    if (!snappingEnabled || !tile || clientY == null) return rawSample;
    const channelIndex = findSaleaeGraphChannelIndexAtY(
      getSaleaeGraphChannelLayout(rowHeights, tile.channels.length, 1, rowTopInsets),
      clientY - rect.top,
    );
    if (channelIndex == null) return rawSample;
    const channel = tile.channels[channelIndex];
    const exactEdges = [...channel.rising_edges, ...channel.falling_edges].sort((left, right) => left - right);
    const snapped = findNearestEdgeSample(
      exactEdges,
      rawSample,
      viewportSamples / Math.max(1, rect.width),
      8,
      true,
    );
    return clampSample(snapped ?? rawSample, totalSamples);
  }

  function selectMarker(id: string, event: Pick<ReactPointerEvent, "button" | "ctrlKey" | "metaKey" | "shiftKey">) {
    onChangeMarkers((current) => selectTimingMarker(current, id, event));
  }

  function openEditPopup(id: string, itemType: TimingMarkerItemType) {
    onChangeMarkers((current) =>
      current.map((marker) => ({
        ...marker,
        graphPopupOpen: marker.id === id ? itemType : null,
        selected: marker.id === id,
      })),
    );
  }

  function updateMarkerPoint(id: string, itemType: TimingMarkerItemType, clientX: number, clientY: number) {
    const sample = clientXToSample(clientX, clientY);
    onChangeMarkers((current) =>
      current.map((marker) => {
        if (marker.id !== id) return marker;
        if (marker.type === "single") {
          return { ...marker, graphPopupOpen: null, sample, selected: true };
        }
        const currentEnd = marker.endSample ?? marker.sample;
        const first = itemType === "left" ? sample : marker.sample;
        const second = itemType === "right" ? sample : currentEnd;
        const ordered = orderTimingPairSamples({ ...marker, sample: first, endSample: second });
        return {
          ...marker,
          endSample: ordered.rightSample,
          graphPopupOpen: null,
          sample: ordered.leftSample,
          selected: true,
        };
      }),
    );
  }

  function beginMarkerDrag(
    id: string,
    itemType: TimingMarkerItemType,
    event: ReactPointerEvent<HTMLDivElement>,
  ) {
    if (event.button !== 0 || placement) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      editOnClick: Boolean((event.target as Element | null)?.closest?.(".timingMarkerHead")),
      id,
      initialClientX: event.clientX,
      itemType,
      moved: false,
      pointerId: event.pointerId,
    };
    setDragging({ id, itemType });
  }

  function moveMarker(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    if (Math.abs(event.clientX - drag.initialClientX) >= TIMING_MARKER_MOVEMENT_THRESHOLD_PX) {
      drag.moved = true;
    }
    updateMarkerPoint(drag.id, drag.itemType, event.clientX, event.clientY);
  }

  function endMarkerDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    dragRef.current = null;
    setDragging(null);
    if (drag.moved) return;
    selectMarker(drag.id, event);
    if (drag.editOnClick) openEditPopup(drag.id, drag.itemType);
  }

  function updatePlacement(clientX: number, clientY: number) {
    const sample = clientXToSample(clientX, clientY);
    onChangePlacement((current) => {
      if (!current) return null;
      if (current.type === "single" || current.placingSide === "start") {
        return { ...current, sample };
      }
      return { ...current, endSample: sample };
    });
  }

  function commitPlacement(event: ReactPointerEvent<HTMLDivElement>) {
    if (!placement || event.button !== 0) return;
    if ((event.target as Element | null)?.closest?.("[data-finalized-timing-marker]")) return;
    event.preventDefault();
    event.stopPropagation();
    const sample = clientXToSample(event.clientX, event.clientY);

    if (placement.type === "pair" && placement.placingSide === "start") {
      onChangePlacement((current) =>
        current
          ? { ...current, endSample: sample, placingSide: "end", sample }
          : null,
      );
      onMessage("Move the pointer and click again to place the second marker");
      return;
    }

    const nextPlacement =
      placement.type === "single"
        ? { ...placement, sample }
        : { ...placement, endSample: sample };
    let marker = timingMarkerToPlacementMarker(nextPlacement);
    if (marker.type === "pair") {
      const ordered = orderTimingPairSamples(marker);
      marker = {
        ...marker,
        sample: ordered.leftSample,
        endSample: ordered.rightSample,
      };
    }
    onChangeMarkers((current) => [
      ...current.map((item) => ({ ...item, graphPopupOpen: null, selected: false })),
      marker,
    ]);
    onChangePlacement(() => null);
    onMessage(marker.type === "pair" ? "Marker pair added" : "Single marker added");
  }

  function addSingleMarkerFromRuler(event: ReactPointerEvent<HTMLDivElement>) {
    if (placement || event.button !== 0 || event.target !== event.currentTarget) return;
    event.preventDefault();
    event.stopPropagation();
    onAddSingleMarker(clientXToSample(event.clientX, event.clientY));
  }

  function openGraphContextMenu(
    id: string,
    itemType: TimingMarkerItemType,
    event: ReactMouseEvent<HTMLDivElement>,
  ) {
    event.preventDefault();
    event.stopPropagation();
    onChangeMarkers((current) =>
      selectTimingMarker(current, id, event).map((marker) => ({
        ...marker,
        graphPopupOpen: null,
      })),
    );
    const root = rootRef.current;
    if (!root) return;
    const rect = root.getBoundingClientRect();
    setContextMenu({
      id,
      itemType,
      x: clamp(event.clientX - rect.left, 0, Math.max(0, rect.width - 218)),
      y: clamp(event.clientY - rect.top, 0, Math.max(0, rect.height - 330)),
    });
  }

  function goToMarkerFromGraphMenu(marker: UiTimingMarker, itemType: TimingMarkerItemType) {
    if (marker.type === "pair" && itemType === "root") {
      const end = marker.endSample ?? marker.sample;
      onViewportChange(
        marker.sample + (end - marker.sample) / 2 - viewportSamples / 2,
        viewportSamples,
      );
      return;
    }
    const sample = markerSample(marker, itemType) ?? marker.sample;
    onViewportChange(sample - viewportSamples / 2, viewportSamples);
  }

  function zoomMarkerPairFromGraphMenu(marker: UiTimingMarker) {
    if (marker.type !== "pair") return;
    const end = marker.endSample ?? marker.sample;
    const span = Math.max(1, end - marker.sample);
    const padding = Math.max(1, span * 0.05);
    onViewportChange(marker.sample - padding, span + padding * 2);
  }

  function ungroupMarkerPairFromGraphMenu(marker: UiTimingMarker) {
    if (marker.type !== "pair") return;
    onChangeMarkers((current) => {
      const remaining = current.filter((item) => item.id !== marker.id);
      let nextLabel = getNextTimingMarkerNumber(remaining);
      const singles = [marker.sample, marker.endSample ?? marker.sample].map((sample, index) => ({
        color: marker.color,
        graphPopupOpen: null,
        id: `${marker.id}-ungrouped-${index}-${Date.now()}`,
        isExpanded: false,
        label: `${nextLabel++}`,
        note: marker.note,
        sample,
        selected: marker.selected,
        type: "single" as const,
      }));
      return [...remaining, ...singles];
    });
    setContextMenu(null);
  }

  function createPairFromSelectedGraphMarkers() {
    onChangeMarkers((current) => {
      const selected = current.filter((marker) => marker.type === "single" && marker.selected);
      if (selected.length !== 2) return current;
      const [left, right] = [...selected].sort((a, b) => a.sample - b.sample);
      const label = getNextTimingMarkerNumber(current);
      return [
        ...current
          .filter((marker) => marker.id !== left.id && marker.id !== right.id)
          .map((marker) => ({ ...marker, graphPopupOpen: null, selected: false })),
        {
          color: left.color,
          endSample: right.sample,
          graphPopupOpen: null,
          id: `marker-pair-${Date.now()}-${label}`,
          isExpanded: false,
          label: `${label}`,
          note: left.note && right.note ? `${left.note}, ${right.note}` : left.note || right.note,
          sample: left.sample,
          selected: true,
          type: "pair",
        },
      ];
    });
    setContextMenu(null);
  }

  const popupMarker = markers.find((marker) => marker.graphPopupOpen);
  const popupItemType = popupMarker?.graphPopupOpen ?? null;
  const popupSample = popupMarker && popupItemType
    ? markerSample(popupMarker, popupItemType)
    : undefined;

  return (
    <div
      className={`timingMarkerStage ${placement ? "placing" : ""}`}
      data-timing-marker-interactive={placement ? "true" : undefined}
      onDoubleClick={(event) => event.stopPropagation()}
      onPointerDown={commitPlacement}
      onPointerMove={(event) => placement && updatePlacement(event.clientX, event.clientY)}
      ref={rootRef}
    >
      {!placement && (
        <div
          className="timingMarkerClickZone"
          data-timing-marker-interactive="true"
          onPointerDown={addSingleMarkerFromRuler}
        />
      )}
      {markers.flatMap((marker) => {
        if (marker.type === "single") {
          return [
            <GraphMarker
              dragging={dragging?.id === marker.id}
              hovered={hovered?.id === marker.id}
              itemType="root"
              key={`${marker.id}-root`}
              marker={marker}
              onContextMenu={openGraphContextMenu}
              onDoubleClick={onOpenSidebar}
              onHover={setHovered}
              onPointerCancel={endMarkerDrag}
              onPointerDown={beginMarkerDrag}
              onPointerMove={moveMarker}
              onPointerUp={endMarkerDrag}
              sample={marker.sample}
              sampleRateHz={sampleRateHz}
              viewportSamples={viewportSamples}
              viewportStart={viewportStart}
            />,
          ];
        }
        const endSample = marker.endSample ?? marker.sample;
        return [
          <GraphMarker
            dragging={dragging?.id === marker.id && dragging.itemType === "left"}
            hovered={hovered?.id === marker.id && hovered.itemType === "left"}
            itemType="left"
            key={`${marker.id}-left`}
            marker={marker}
            onContextMenu={openGraphContextMenu}
            onDoubleClick={onOpenSidebar}
            onHover={setHovered}
            onPointerCancel={endMarkerDrag}
            onPointerDown={beginMarkerDrag}
            onPointerMove={moveMarker}
            onPointerUp={endMarkerDrag}
            sample={marker.sample}
            sampleRateHz={sampleRateHz}
            viewportSamples={viewportSamples}
            viewportStart={viewportStart}
          />,
          <GraphMarker
            dragging={dragging?.id === marker.id && dragging.itemType === "right"}
            hovered={hovered?.id === marker.id && hovered.itemType === "right"}
            itemType="right"
            key={`${marker.id}-right`}
            marker={marker}
            onContextMenu={openGraphContextMenu}
            onDoubleClick={onOpenSidebar}
            onHover={setHovered}
            onPointerCancel={endMarkerDrag}
            onPointerDown={beginMarkerDrag}
            onPointerMove={moveMarker}
            onPointerUp={endMarkerDrag}
            sample={endSample}
            sampleRateHz={sampleRateHz}
            viewportSamples={viewportSamples}
            viewportStart={viewportStart}
          />,
        ];
      })}

      {placement && (
        <TemporaryGraphMarkers
          placement={placement}
          sampleToPercent={sampleToPercent}
          sampleRateHz={sampleRateHz}
        />
      )}

      {contextMenu && (() => {
        const marker = markers.find((item) => item.id === contextMenu.id);
        if (!marker) return null;
        return (
          <TimingMarkerItemMenu
            canCreatePair={marker.type === "single" && markers.filter((item) => item.type === "single" && item.selected).length === 2}
            className="timingMarkerGraphMenu"
            marker={marker}
            onCreatePair={createPairFromSelectedGraphMarkers}
            onDelete={() => {
              onChangeMarkers((current) => current.filter((item) => item.id !== marker.id));
              setContextMenu(null);
            }}
            onDeleteAll={() => {
              onChangeMarkers(() => []);
              setContextMenu(null);
            }}
            onEdit={() => {
              openEditPopup(marker.id, contextMenu.itemType);
              setContextMenu(null);
            }}
            onGoTo={() => {
              goToMarkerFromGraphMenu(marker, contextMenu.itemType);
              setContextMenu(null);
            }}
            onNotify={onMessage}
            onUngroup={() => ungroupMarkerPairFromGraphMenu(marker)}
            onZoom={() => {
              zoomMarkerPairFromGraphMenu(marker);
              setContextMenu(null);
            }}
            showSetAsT0
            style={{ left: contextMenu.x, top: contextMenu.y }}
          />
        );
      })()}

      {popupMarker && popupItemType && popupSample !== undefined && (
        <TimingMarkerEditPopup
          className={sampleToPercent(popupSample) > 72 ? "opensLeft" : "opensRight"}
          marker={popupMarker}
          onClose={() =>
            onChangeMarkers((current) =>
              current.map((marker) => ({ ...marker, graphPopupOpen: null })),
            )
          }
          onDelete={() =>
            onChangeMarkers((current) => current.filter((marker) => marker.id !== popupMarker.id))
          }
          onUpdate={(patch) =>
            onChangeMarkers((current) =>
              current.map((marker) => marker.id === popupMarker.id ? { ...marker, ...patch } : marker),
            )
          }
          style={{ left: `${sampleToPercent(popupSample)}%`, top: 33 }}
        />
      )}
    </div>
  );
}

interface GraphMarkerProps {
  dragging: boolean;
  hovered: boolean;
  itemType: TimingMarkerItemType;
  marker: UiTimingMarker;
  onContextMenu: (id: string, itemType: TimingMarkerItemType, event: ReactMouseEvent<HTMLDivElement>) => void;
  onDoubleClick: () => void;
  onHover: (hover: HoverState | null) => void;
  onPointerCancel: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerDown: (id: string, itemType: TimingMarkerItemType, event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => void;
  sample: number;
  sampleRateHz: number;
  viewportSamples: number;
  viewportStart: number;
}

function GraphMarker({
  dragging,
  hovered,
  itemType,
  marker,
  onContextMenu,
  onDoubleClick,
  onHover,
  onPointerCancel,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  sample,
  sampleRateHz,
  viewportSamples,
  viewportStart,
}: GraphMarkerProps) {
  const left = ((sample - viewportStart) / Math.max(1, viewportSamples)) * 100;
  if (left < -1 || left > 101) return null;
  const selected = marker.selected || dragging;
  const color = timingMarkerColorValue(marker.color);
  const deltaSamples = marker.type === "pair" && marker.endSample !== undefined
    ? marker.endSample - marker.sample
    : undefined;
  const showSummary = hovered && !dragging && marker.graphPopupOpen !== itemType;

  return (
    <div
      className={`timingGraphMarker ${itemType} ${selected ? "selected" : ""} ${dragging ? "dragging" : ""}`}
      data-finalized-timing-marker="true"
      data-timing-marker-interactive="true"
      onContextMenu={(event) => onContextMenu(marker.id, itemType, event)}
      onDoubleClick={(event) => {
        event.stopPropagation();
        onDoubleClick();
      }}
      onPointerCancel={onPointerCancel}
      onPointerDown={(event) => onPointerDown(marker.id, itemType, event)}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      style={{ "--timing-marker-color": color, left: `${left}%` } as CSSProperties}
    >
      <div className="timingMarkerHitLine">
        <span className="timingMarkerVisibleLine" />
      </div>
      <button
        aria-label={`${getTimingMarkerFullLabel(marker, itemType)} timing marker`}
        className={`timingMarkerHead ${itemType}`}
        onMouseEnter={() => onHover({ id: marker.id, itemType })}
        onMouseLeave={() => onHover(null)}
        type="button"
      >
        {itemType === "root" ? (
          <SaleaeIcon className="timingMarkerHeadShape" name="timeMarker" />
        ) : (
          <span className="timingMarkerPairHeadShape" />
        )}
        <span className="timingMarkerHeadText">{marker.label}</span>
      </button>
      {dragging && (
        <TimingMarkerSummary
          className="draggingSummary"
          deltaSamples={deltaSamples}
          itemType={itemType}
          marker={marker}
          sample={sample}
          sampleRateHz={sampleRateHz}
        />
      )}
      {showSummary && (
        <TimingMarkerSummary
          className={left > 75 ? "opensLeft" : ""}
          deltaSamples={deltaSamples}
          itemType={itemType}
          marker={marker}
          sample={sample}
          sampleRateHz={sampleRateHz}
        />
      )}
    </div>
  );
}

function TemporaryGraphMarkers({
  placement,
  sampleRateHz,
  sampleToPercent,
}: {
  placement: UiTimingMarkerPlacement;
  sampleRateHz: number;
  sampleToPercent: (sample: number) => number;
}) {
  const marker = timingMarkerToPlacementMarker(placement);
  const ordered = placement.type === "pair" && placement.endSample !== undefined
    ? orderTimingPairSamples(placement)
    : null;
  const points: Array<{ itemType: TimingMarkerItemType; sample: number }> = placement.type === "single"
    ? [{ itemType: "root", sample: placement.sample }]
    : [
        { itemType: "left", sample: ordered?.leftSample ?? placement.sample },
        ...(placement.endSample === undefined
          ? []
          : [{ itemType: "right" as const, sample: ordered?.rightSample ?? placement.endSample }]),
      ];
  const deltaSamples = placement.endSample === undefined ? undefined : Math.abs(placement.endSample - placement.sample);
  const movingItemType: TimingMarkerItemType = placement.type === "single"
    ? "root"
    : placement.placingSide === "start"
      ? "left"
      : (placement.endSample ?? placement.sample) < placement.sample
        ? "left"
        : "right";

  return (
    <>
      {points.map(({ itemType, sample }) => {
        const left = sampleToPercent(sample);
        return (
          <div
            className={`timingGraphMarker temporary ${itemType}`}
            key={`${placement.id}-${itemType}`}
            style={{
              "--timing-marker-color": timingMarkerColorValue(placement.color),
              left: `${left}%`,
            } as CSSProperties}
          >
            <div className="timingMarkerHitLine">
              <span className="timingMarkerVisibleLine" />
            </div>
            <div className={`timingMarkerHead ${itemType}`}>
              {itemType === "root" ? (
                <SaleaeIcon className="timingMarkerHeadShape" name="timeMarker" />
              ) : (
                <span className="timingMarkerPairHeadShape" />
              )}
              <SaleaeIcon className="timingMarkerPlacementPlus" name="plus" size={8} />
            </div>
            {itemType === movingItemType && (
              <TimingMarkerSummary
                className="draggingSummary"
                deltaSamples={deltaSamples}
                itemType={itemType}
                marker={marker}
                sample={sample}
                sampleRateHz={sampleRateHz}
              />
            )}
          </div>
        );
      })}
    </>
  );
}

function TimingMarkerSummary({
  className = "",
  deltaSamples,
  marker,
  sample,
  sampleRateHz,
}: {
  className?: string;
  deltaSamples?: number;
  itemType: TimingMarkerItemType;
  marker: UiTimingMarker;
  sample: number;
  sampleRateHz: number;
}) {
  return (
    <div className={`timingMarkerSummaryPopup ${className}`}>
      <span>{formatTimingMarkerSeconds(sample / Math.max(1, sampleRateHz))}</span>
      {deltaSamples !== undefined && (
        <>
          <span>Δ {formatTimingMarkerSeconds(deltaSamples / Math.max(1, sampleRateHz))}</span>
          {deltaSamples > 0 && <span>{formatTimingMarkerFrequency(sampleRateHz / deltaSamples)}</span>}
        </>
      )}
      {marker.note && <span>{marker.note}</span>}
    </div>
  );
}

interface TimingMarkersPanelProps {
  busy: boolean;
  hasCapture: boolean;
  markers: UiTimingMarker[];
  onAddMarkerPair: () => void;
  onAddSingleMarker: () => void;
  onChangeMarkers: MarkerUpdater;
  onMessage: (message: string) => void;
  onViewportChange: (start: number, samples: number) => void;
  placementActive: boolean;
  sampleRateHz: number;
  totalSamples: number;
  viewportSamples: number;
}

// Ported from timingMarkers/sidebar/{BaseItem,MarkerItem,PairItem,Note}.
export function TimingMarkersPanel({
  busy,
  hasCapture,
  markers,
  onAddMarkerPair,
  onAddSingleMarker,
  onChangeMarkers,
  onMessage,
  onViewportChange,
  placementActive,
  sampleRateHz,
  totalSamples,
  viewportSamples,
}: TimingMarkersPanelProps) {
  const [addOpen, setAddOpen] = useState(false);
  const [editMarkerId, setEditMarkerId] = useState<string | null>(null);
  const [menuMarkerId, setMenuMarkerId] = useState<string | null>(null);
  const sortedMarkers = useMemo(
    () => [...markers].sort((left, right) => markerSortValue(left) - markerSortValue(right)),
    [markers],
  );
  const editMarker = markers.find((marker) => marker.id === editMarkerId) ?? null;

  useEffect(() => {
    if (menuMarkerId && !markers.some((marker) => marker.id === menuMarkerId)) setMenuMarkerId(null);
    if (editMarkerId && !markers.some((marker) => marker.id === editMarkerId)) setEditMarkerId(null);
  }, [editMarkerId, markers, menuMarkerId]);

  function startPlacement(type: "pair" | "single") {
    setAddOpen(false);
    if (!hasCapture || busy || placementActive) return;
    if (type === "pair") onAddMarkerPair();
    else onAddSingleMarker();
  }

  function updateMarker(id: string, patch: Partial<UiTimingMarker>) {
    onChangeMarkers((current) =>
      current.map((marker) => marker.id === id ? { ...marker, ...patch } : marker),
    );
  }

  function selectMarker(id: string, event: { button?: number; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) {
    onChangeMarkers((current) => selectTimingMarker(current, id, event));
  }

  function goToMarker(marker: UiTimingMarker, itemType: TimingMarkerItemType = "root") {
    if (marker.type === "pair" && itemType === "root") {
      const start = marker.sample;
      const end = marker.endSample ?? start;
      const center = start + (end - start) / 2;
      onViewportChange(center - viewportSamples / 2, viewportSamples);
    } else {
      const sample = markerSample(marker, itemType) ?? marker.sample;
      onViewportChange(sample - viewportSamples / 2, viewportSamples);
    }
  }

  function zoomPair(marker: UiTimingMarker) {
    if (marker.type !== "pair") return;
    const end = marker.endSample ?? marker.sample;
    const span = Math.max(1, end - marker.sample);
    const padding = Math.max(1, span * 0.05);
    onViewportChange(marker.sample - padding, span + padding * 2);
  }

  function ungroupPair(marker: UiTimingMarker) {
    if (marker.type !== "pair") return;
    onChangeMarkers((current) => {
      const withoutPair = current.filter((item) => item.id !== marker.id);
      let nextNumber = getNextTimingMarkerNumber(withoutPair);
      const samples = [marker.sample, marker.endSample ?? marker.sample];
      const singles = samples.map((sample, index): UiTimingMarker => ({
        color: marker.color,
        graphPopupOpen: null,
        id: `${marker.id}-ungrouped-${index}-${Date.now()}`,
        isExpanded: false,
        label: `${nextNumber++}`,
        note: marker.note,
        sample,
        selected: marker.selected,
        type: "single",
      }));
      return [...withoutPair, ...singles];
    });
    setMenuMarkerId(null);
  }

  function createPairFromSelected() {
    onChangeMarkers((current) => {
      const selected = current.filter((marker) => marker.type === "single" && marker.selected);
      if (selected.length !== 2) return current;
      const [left, right] = [...selected].sort((a, b) => a.sample - b.sample);
      const label = getNextTimingMarkerNumber(current);
      const pair: UiTimingMarker = {
        color: left.color,
        endSample: right.sample,
        graphPopupOpen: null,
        id: `marker-pair-${Date.now()}-${label}`,
        isExpanded: false,
        label: `${label}`,
        note: left.note && right.note ? `${left.note}, ${right.note}` : left.note || right.note,
        sample: left.sample,
        selected: true,
        type: "pair",
      };
      return [
        ...current.filter((marker) => marker.id !== left.id && marker.id !== right.id)
          .map((marker) => ({ ...marker, selected: false })),
        pair,
      ];
    });
    setMenuMarkerId(null);
  }

  function deleteMarker(id: string) {
    onChangeMarkers((current) => current.filter((marker) => marker.id !== id));
    setMenuMarkerId(null);
    setEditMarkerId((current) => current === id ? null : current);
  }

  return (
    <div className="timingMarkersSidebarPanel" data-timing-marker-interactive="true">
      <div className="timingMarkersTitleRow">
        <span>Timing Markers</span>
        <div className="markerAddMenu">
          <button
            aria-label="Add timing marker"
            className={`sidebarCircleButton ${addOpen ? "active" : ""}`}
            disabled={!hasCapture || busy || placementActive}
            onClick={() => setAddOpen((open) => !open)}
            type="button"
          >
            <SaleaeIcon name="plus" size={10} />
          </button>
          {addOpen && (
            <div className="markerAddPopover">
              <button onClick={() => startPlacement("pair")} type="button">
                <span>Add Marker Pair</span>
                <small>{primaryShortcut("T")}</small>
              </button>
              <button onClick={() => startPlacement("single")} type="button">
                <span>Add Single Marker</span>
                <small>{primaryShortcut("Shift+T")}</small>
              </button>
            </div>
          )}
        </div>
      </div>

      {sortedMarkers.length === 0 ? (
        <div className="timingMarkersEmptyState">
          <div className="timingMarkersEmptyArt">
            <SaleaeIcon name="timeMarker" />
            <SaleaeIcon name="markerStop" />
            <SaleaeIcon name="markerStop" />
          </div>
          <span>Click "+" to add Timing Markers</span>
        </div>
      ) : (
        <div className="timingMarkerList">
          {sortedMarkers.map((marker) => (
            <div className="timingMarkerListGroup" key={marker.id}>
              <TimingMarkerListItem
                editOpen={editMarkerId === marker.id}
                itemType="root"
                marker={marker}
                menuOpen={menuMarkerId === marker.id}
                onEdit={() => {
                  setMenuMarkerId(null);
                  setEditMarkerId(marker.id);
                }}
                onGoTo={() => goToMarker(marker)}
                onMenuToggle={() => setMenuMarkerId((current) => current === marker.id ? null : marker.id)}
                onSelect={(event) => selectMarker(marker.id, event)}
                onToggleExpanded={marker.type === "pair"
                  ? () => updateMarker(marker.id, { isExpanded: !marker.isExpanded })
                  : undefined}
                onZoom={marker.type === "pair" ? () => zoomPair(marker) : undefined}
                sampleRateHz={sampleRateHz}
              />
              {menuMarkerId === marker.id && (
                <TimingMarkerItemMenu
                  canCreatePair={marker.type === "single" && markers.filter((item) => item.type === "single" && item.selected).length === 2}
                  marker={marker}
                  onCreatePair={createPairFromSelected}
                  onDelete={() => deleteMarker(marker.id)}
                  onDeleteAll={() => {
                    onChangeMarkers(() => []);
                    setMenuMarkerId(null);
                  }}
                  onEdit={() => {
                    setMenuMarkerId(null);
                    setEditMarkerId(marker.id);
                  }}
                  onGoTo={() => goToMarker(marker)}
                  onNotify={onMessage}
                  onUngroup={() => ungroupPair(marker)}
                  onZoom={() => zoomPair(marker)}
                  showSetAsT0={marker.type === "single"}
                />
              )}
              {marker.type === "pair" && marker.isExpanded && (
                <>
                  <TimingMarkerListItem
                    editOpen={false}
                    itemType="left"
                    marker={marker}
                    menuOpen={false}
                    onGoTo={() => goToMarker(marker, "left")}
                    onMenuToggle={() => {}}
                    onSelect={(event) => selectMarker(marker.id, event)}
                    sampleRateHz={sampleRateHz}
                    showMenuButton={false}
                  />
                  <TimingMarkerListItem
                    editOpen={false}
                    itemType="right"
                    marker={marker}
                    menuOpen={false}
                    onGoTo={() => goToMarker(marker, "right")}
                    onMenuToggle={() => {}}
                    onSelect={(event) => selectMarker(marker.id, event)}
                    sampleRateHz={sampleRateHz}
                    showMenuButton={false}
                  />
                </>
              )}
            </div>
          ))}
        </div>
      )}

      {editMarker && (
        <TimingMarkerEditPopup
          className="sidebarTimingMarkerEditPopup"
          marker={editMarker}
          onClose={() => setEditMarkerId(null)}
          onDelete={() => deleteMarker(editMarker.id)}
          onUpdate={(patch) => updateMarker(editMarker.id, patch)}
          style={{ right: 5, top: 42 }}
        />
      )}
    </div>
  );
}

interface TimingMarkerListItemProps {
  editOpen: boolean;
  itemType: TimingMarkerItemType;
  marker: UiTimingMarker;
  menuOpen: boolean;
  onEdit?: () => void;
  onGoTo: () => void;
  onMenuToggle: () => void;
  onSelect: (event: { button?: number; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) => void;
  onToggleExpanded?: () => void;
  onZoom?: () => void;
  sampleRateHz: number;
  showMenuButton?: boolean;
}

function TimingMarkerListItem({
  editOpen,
  itemType,
  marker,
  menuOpen,
  onGoTo,
  onMenuToggle,
  onSelect,
  onToggleExpanded,
  onZoom,
  sampleRateHz,
  showMenuButton = true,
}: TimingMarkerListItemProps) {
  const value = markerValueLabel(marker, itemType, sampleRateHz);
  return (
    <div
      className={`timingMarkerBaseItem ${itemType !== "root" ? "pairChild" : ""} ${marker.selected ? "selected" : ""} ${menuOpen || editOpen ? "open" : ""}`}
      onClick={(event) => onSelect(event)}
      onContextMenu={(event) => {
        event.preventDefault();
        onSelect(event);
        if (showMenuButton) onMenuToggle();
      }}
      onDoubleClick={(event) => {
        event.stopPropagation();
        onGoTo();
      }}
    >
      {onToggleExpanded && (
        <button
          aria-label={marker.isExpanded ? "Collapse marker pair" : "Expand marker pair"}
          className={`timingMarkerExpandButton ${marker.isExpanded ? "expanded" : ""}`}
          onClick={(event) => {
            event.stopPropagation();
            onToggleExpanded();
          }}
          type="button"
        >
          <SaleaeIcon name="arrowHead" />
        </button>
      )}
      <div className="timingMarkerItemContent">
        <SaleaeIcon
          className="timingMarkerItemIcon"
          name={itemType === "root" ? "markerBullet" : "markerStop"}
          style={{ color: timingMarkerColorValue(marker.color) }}
        />
        <span className="timingMarkerItemLabel">{getTimingMarkerFullLabel(marker, itemType)}</span>
        {marker.type === "pair" && itemType === "root" ? (
          <SaleaeIcon className="timingMarkerItemEquals" name="arrow" />
        ) : (
          <span className="timingMarkerItemEquals">=</span>
        )}
        <span className="timingMarkerItemValue" title={value}>{value}</span>
        {marker.note && <TimingMarkerNote note={marker.note} />}
      </div>
      <div className="timingMarkerItemActions">
        <button
          aria-label={marker.type === "pair" && itemType === "root" ? "Go to pair" : "Go to marker"}
          className="timingMarkerItemActionButton"
          onClick={(event) => {
            event.stopPropagation();
            onGoTo();
          }}
          onDoubleClick={(event) => {
            event.stopPropagation();
            onZoom?.();
          }}
          title={marker.type === "pair" && itemType === "root" ? "Go to pair\nDouble click to zoom" : "Go to marker"}
          type="button"
        >
          <SaleaeIcon name="goto" />
        </button>
        {showMenuButton && (
          <button
            aria-label="Marker menu"
            className="timingMarkerItemActionButton"
            onClick={(event) => {
              event.stopPropagation();
              onMenuToggle();
            }}
            title="Marker menu"
            type="button"
          >
            <SaleaeIcon name="verticalThreeDots" size={16} />
          </button>
        )}
      </div>
    </div>
  );
}

function TimingMarkerNote({ note }: { note: string }) {
  return (
    <span className="timingMarkerNote" title={note}>
      {note}
    </span>
  );
}

function TimingMarkerItemMenu({
  canCreatePair,
  className = "",
  marker,
  onCreatePair,
  onDelete,
  onDeleteAll,
  onEdit,
  onGoTo,
  onNotify,
  onUngroup,
  onZoom,
  showSetAsT0,
  style,
}: {
  canCreatePair: boolean;
  className?: string;
  marker: UiTimingMarker;
  onCreatePair: () => void;
  onDelete: () => void;
  onDeleteAll: () => void;
  onEdit: () => void;
  onGoTo: () => void;
  onNotify: (message: string) => void;
  onUngroup: () => void;
  onZoom: () => void;
  showSetAsT0: boolean;
  style?: CSSProperties;
}) {
  return (
    <div
      className={`timingMarkerItemMenu ${className}`}
      data-timing-marker-interactive="true"
      data-timing-marker-menu="true"
      style={style}
    >
      {canCreatePair && <button onClick={onCreatePair} type="button">Create Pair</button>}
      {canCreatePair && <div className="timingMarkerMenuSeparator" />}
      <button onClick={onEdit} type="button">Edit</button>
      <div className="timingMarkerMenuSeparator" />
      <button onClick={onGoTo} type="button">{marker.type === "pair" ? "Go to Pair" : "Go to Marker"}</button>
      {marker.type === "pair" && <button onClick={onZoom} type="button">Zoom on Pair</button>}
      {marker.type === "pair" && <button onClick={onUngroup} type="button">Ungroup Pair</button>}
      {showSetAsT0 && (
        <button onClick={() => onNotify("Set as T0 is reserved for the capture time-zero service")} type="button">
          Set as T0
        </button>
      )}
      <div className="timingMarkerMenuSeparator" />
      <button onClick={() => onNotify("Delete Data is available from the graph channel context menu") } type="button">
        {marker.type === "pair" ? "Delete Data Outside Pair" : "Delete Data"}
      </button>
      <div className="timingMarkerMenuSeparator" />
      <button onClick={onDelete} type="button">Delete</button>
      <button onClick={onDeleteAll} type="button">Delete All</button>
    </div>
  );
}

interface TimingMarkerEditPopupProps {
  className?: string;
  marker: UiTimingMarker;
  onClose: () => void;
  onDelete: () => void;
  onUpdate: (patch: Partial<UiTimingMarker>) => void;
  style?: CSSProperties;
}

function TimingMarkerEditPopup({
  className = "",
  marker,
  onClose,
  onDelete,
  onUpdate,
  style,
}: TimingMarkerEditPopupProps) {
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; x: number; y: number } | null>(null);
  const [offset, setOffset] = useState({ x: 0, y: 0 });

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  function stopDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    dragRef.current = null;
  }

  return (
    <div
      className={`timingMarkerEditPopup ${className}`}
      data-timing-marker-interactive="true"
      onPointerCancel={stopDrag}
      onPointerDown={(event) => {
        event.stopPropagation();
        if ((event.target as Element | null)?.closest?.(".timingMarkerPopupControl")) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        dragRef.current = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          x: offset.x,
          y: offset.y,
        };
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        event.stopPropagation();
        setOffset({
          x: drag.x + event.clientX - drag.startX,
          y: drag.y + event.clientY - drag.startY,
        });
      }}
      onPointerUp={stopDrag}
      style={{ ...style, transform: `translate(${offset.x}px, ${offset.y}px)` }}
    >
      <textarea
        autoFocus
        className="timingMarkerPopupControl"
        onChange={(event) => onUpdate({ note: event.target.value })}
        onKeyDown={(event) => {
          if (!event.shiftKey && event.key === "Enter") {
            event.preventDefault();
            onClose();
          }
        }}
        placeholder="Comment here..."
        rows={3}
        value={marker.note}
      />
      <div className="timingMarkerEditFooter timingMarkerPopupControl">
        <div className="timingMarkerColorChoices">
          {TIMING_MARKER_COLORS.map((color) => (
            <button
              aria-label={`Use ${color} marker color`}
              className={marker.color === color ? "selected" : ""}
              key={color}
              onClick={() => onUpdate({ color })}
              style={{ color: timingMarkerColorValue(color) }}
              type="button"
            >
              <SaleaeIcon name="timeMarker" />
            </button>
          ))}
        </div>
        <button className="timingMarkerEditDelete" onClick={onDelete} title="Delete" type="button">
          <SaleaeIcon name="trash" size={14} />
        </button>
      </div>
    </div>
  );
}

function selectTimingMarker(
  markers: UiTimingMarker[],
  id: string,
  event: { button?: number; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean },
) {
  const targetIndex = markers.findIndex((marker) => marker.id === id);
  if (targetIndex < 0) return markers;
  if (event.button === 2 && markers[targetIndex].selected) return markers;
  if (event.metaKey || event.ctrlKey) {
    return markers.map((marker) => marker.id === id ? { ...marker, selected: !marker.selected } : marker);
  }
  if (event.shiftKey) {
    const anchorIndex = markers.findIndex((marker) => marker.selected);
    if (anchorIndex >= 0) {
      const start = Math.min(anchorIndex, targetIndex);
      const end = Math.max(anchorIndex, targetIndex);
      return markers.map((marker, index) => ({ ...marker, selected: index >= start && index <= end }));
    }
  }
  return markers.map((marker) => ({
    ...marker,
    graphPopupOpen: marker.id === id ? marker.graphPopupOpen : null,
    selected: marker.id === id,
  }));
}

function markerSample(marker: UiTimingMarker, itemType: TimingMarkerItemType) {
  if (marker.type === "single" || itemType === "left") return marker.sample;
  if (itemType === "right") return marker.endSample;
  return marker.sample;
}

function markerValueLabel(marker: UiTimingMarker, itemType: TimingMarkerItemType, sampleRateHz: number) {
  if (marker.type === "pair" && itemType === "root") {
    const deltaSamples = Math.max(0, (marker.endSample ?? marker.sample) - marker.sample);
    const deltaSeconds = deltaSamples / Math.max(1, sampleRateHz);
    const frequency = deltaSeconds > 0 ? ` (${formatTimingMarkerFrequency(1 / deltaSeconds)})` : "";
    return `Δ${formatTimingMarkerSeconds(deltaSeconds)}${frequency}`;
  }
  const sample = markerSample(marker, itemType);
  return sample === undefined ? "..." : formatTimingMarkerSeconds(sample / Math.max(1, sampleRateHz));
}

function markerSortValue(marker: UiTimingMarker) {
  const numeric = Number(marker.label);
  return Number.isFinite(numeric) ? numeric : Number.MAX_SAFE_INTEGER;
}

function clampSample(sample: number, totalSamples: number) {
  return Math.max(0, Math.min(Math.max(0, totalSamples - 1), Math.round(sample)));
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, value));
}

function primaryShortcut(suffix: "T" | "Shift+T") {
  const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform);
  if (suffix === "Shift+T") return isMac ? "Shift+Cmd+T" : "Shift+Ctrl+T";
  return isMac ? "Cmd+T" : "Ctrl+T";
}

export type { MarkerUpdater, PlacementUpdater, TimingMarkerColor };
