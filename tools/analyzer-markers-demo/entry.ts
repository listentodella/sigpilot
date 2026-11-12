import { drawProtocolMarker, type ProtocolMarkerPalette } from "../../src/lib/analyzerMarkerDrawing";
import { visibleAnalyzerProtocolMarkers } from "../../src/lib/analyzerMarkers";
import { activeThemeChannelColor, activeUiTheme, activeWaveformThemeColors, getUiTheme, setActiveUiTheme } from "../../src/lib/themes";
import { createMarkerDemoLanes, DEMO_SAMPLE_RATE_HZ, DEMO_TOTAL_SAMPLES, MARKER_DESCRIPTIONS, MARKER_KINDS, type MarkerKind, type MarkerDemoLane } from "./fixture";

function element<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing demo element: ${id}`);
  return node as T;
}

const waveform = element<HTMLCanvasElement>("waveform");
const waveformHost = element<HTMLDivElement>("waveform-host");
const targets = element<HTMLDivElement>("waveform-targets");
const gallery = element<HTMLDivElement>("marker-gallery");
const themeSelect = element<HTMLSelectElement>("theme-select");
const scaleSelect = element<HTMLSelectElement>("marker-scale");
const labelsInput = element<HTMLInputElement>("show-labels");
const previewColor = element<HTMLInputElement>("preview-color");
const zoomInput = element<HTMLInputElement>("zoom");
const panInput = element<HTMLInputElement>("pan");
const status = element<HTMLOutputElement>("render-status");
const lanes = createMarkerDemoLanes();
const state = { selected: "up_arrow" as MarkerKind, zoom: 1, start: 0, markerScale: 1, labels: true, previewColor: "#53a9fd" };
const previewCanvases: Array<{ canvas: HTMLCanvasElement; kind: MarkerKind; scale: number }> = [];
let pendingFrame: number | null = null;

function palette(): ProtocolMarkerPalette {
  const theme = activeUiTheme();
  return {
    start: theme.cssVars["--positive"], stop: theme.cssVars["--yellow"],
    error: theme.cssVars["--red"], background: activeWaveformThemeColors().background,
  };
}

function prepareCanvas(canvas: HTMLCanvasElement, width: number, height: number) {
  const dpr = window.devicePixelRatio || 1;
  const pixelWidth = Math.max(1, Math.round(width * dpr));
  const pixelHeight = Math.max(1, Math.round(height * dpr));
  if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
  if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This demo requires a Canvas 2D context.");
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, width, height);
  return context;
}

function drawPreview(canvas: HTMLCanvasElement, kind: MarkerKind, scale: number, width: number, height: number) {
  const context = prepareCanvas(canvas, width, height);
  context.fillStyle = palette().background;
  context.fillRect(0, 0, width, height);
  context.save();
  context.translate(width / 2, height / 2);
  context.scale(scale, scale);
  drawProtocolMarker(context, 0, 0, kind, state.previewColor, palette());
  context.restore();
  canvas.dataset.drawnKind = kind;
}

for (const kind of MARKER_KINDS) {
  const info = MARKER_DESCRIPTIONS[kind];
  const card = document.createElement("button");
  card.type = "button";
  card.className = "marker-card";
  card.dataset.kind = kind;
  card.setAttribute("aria-label", `${info.sdk}：${info.title}`);
  card.setAttribute("aria-pressed", String(kind === state.selected));
  const name = document.createElement("span");
  name.className = "card-kind";
  name.textContent = kind;
  const title = document.createElement("span");
  title.className = "card-title";
  title.textContent = info.title;
  const previews = document.createElement("span");
  previews.className = "card-previews";
  for (const scale of [1, 4]) {
    const box = document.createElement("span");
    const canvas = document.createElement("canvas");
    canvas.setAttribute("aria-hidden", "true");
    const caption = document.createElement("small");
    caption.textContent = `${scale}×`;
    box.append(canvas, caption);
    previews.append(box);
    previewCanvases.push({ canvas, kind, scale });
  }
  card.append(name, title, previews);
  card.addEventListener("click", () => selectMarker(kind));
  gallery.append(card);
}

function viewSamples() { return DEMO_TOTAL_SAMPLES / state.zoom; }
function maxStart() { return DEMO_TOTAL_SAMPLES - viewSamples(); }
function clampStart(start: number) { return Math.min(maxStart(), Math.max(0, start)); }

function selectMarker(kind: MarkerKind) {
  state.selected = kind;
  const marker = lanes.flatMap((lane) => lane.markers).find((item) => item.kind === kind)!;
  if (marker.sample < state.start || marker.sample > state.start + viewSamples()) {
    state.start = clampStart(marker.sample - viewSamples() / 2);
  }
  updateControls();
  scheduleDraw();
}

function updateControls() {
  zoomInput.value = String(state.zoom);
  element<HTMLOutputElement>("zoom-value").textContent = `${state.zoom}×`;
  panInput.disabled = maxStart() === 0;
  panInput.value = maxStart() === 0 ? "0" : String(state.start / maxStart() * 100);
  gallery.querySelectorAll<HTMLButtonElement>(".marker-card").forEach((card) => {
    card.setAttribute("aria-pressed", String(card.dataset.kind === state.selected));
  });
  const info = MARKER_DESCRIPTIONS[state.selected];
  element("detail-kind").textContent = `${state.selected} / AnalyzerResults::${info.sdk}`;
  element("detail-title").textContent = info.title;
  element("detail-description").textContent = info.description;
  element("detail-note").textContent = info.note;
  const lane = lanes.find((item) => item.markers.some((marker) => marker.kind === state.selected))!;
  const marker = lane.markers.find((item) => item.kind === state.selected)!;
  element("sigpilot-example").textContent = `// D${lane.channel} 的 AnalyzerTrackWindow.protocol_markers\nconst markers: AnalyzerProtocolMarker[] = [\n  { sample: ${marker.sample}, kind: "${marker.kind}" },\n];`;
  element("saleae-example").textContent = `// channel 为目标 Channel，sample 为采样点编号\nmResults->AddMarker(\n  ${marker.sample}, AnalyzerResults::${info.sdk}, channel\n);\nmResults->CommitResults();`;
}

function drawLane(context: CanvasRenderingContext2D, lane: MarkerDemoLane, centerY: number, left: number, width: number) {
  const x = (sample: number) => left + (sample - state.start) / viewSamples() * width;
  const y = (high: boolean) => centerY + (high ? -17 : 17);
  let high = lane.initialHigh;
  for (const edge of lane.edges) {
    if (edge < state.start) high = !high;
    else break;
  }
  context.beginPath();
  context.moveTo(left, y(high));
  for (const edge of lane.edges) {
    if (edge < state.start) continue;
    if (edge > state.start + viewSamples()) break;
    context.lineTo(x(edge), y(high));
    high = !high;
    context.lineTo(x(edge), y(high));
  }
  context.lineTo(left + width, y(high));
  context.strokeStyle = activeThemeChannelColor(lane.channel);
  context.lineWidth = 1.5;
  context.stroke();
}

function drawWaveform() {
  const width = waveformHost.clientWidth;
  const height = waveformHost.clientHeight;
  if (width <= 0 || height <= 0) return;
  const context = prepareCanvas(waveform, width, height);
  const colors = activeWaveformThemeColors();
  const light = themeSelect.value === "lab-light";
  const left = width < 600 ? 56 : 155;
  const plotWidth = Math.max(1, width - left - 20);
  const rowHeight = 76;
  const x = (sample: number) => left + (sample - state.start) / viewSamples() * plotWidth;
  context.fillStyle = colors.background;
  context.fillRect(0, 0, width, height);
  context.font = "11px system-ui, sans-serif";
  context.textAlign = "center";
  context.textBaseline = "middle";
  for (let index = 0; index <= 8; index += 1) {
    const gridX = left + index / 8 * plotWidth;
    context.strokeStyle = colors.gridPrimary;
    context.lineWidth = 1;
    context.beginPath(); context.moveTo(gridX, 32); context.lineTo(gridX, height - 18); context.stroke();
    context.fillStyle = light ? "#657388" : "#969fad";
    const micros = (state.start + index / 8 * viewSamples()) / DEMO_SAMPLE_RATE_HZ * 1_000_000;
    context.fillText(`${Number(micros.toFixed(1))} µs`, gridX, 16);
  }
  const fragment = document.createDocumentFragment();
  const visibleKinds: MarkerKind[] = [];
  lanes.forEach((lane, index) => {
    const centerY = 80 + index * rowHeight;
    context.textAlign = "left";
    context.fillStyle = activeThemeChannelColor(lane.channel);
    context.font = "600 11px system-ui, sans-serif";
    context.fillText(`D${lane.channel}`, 17, centerY - (width < 600 ? 0 : 9));
    if (width >= 600) {
      context.fillStyle = light ? "#657388" : "#969fad";
      context.font = "11px system-ui, sans-serif";
      context.fillText(lane.title, 17, centerY + 10);
    }
    context.save();
    context.beginPath(); context.rect(left - 1, centerY - 34, plotWidth + 2, rowHeight); context.clip();
    drawLane(context, lane, centerY, left, plotWidth);
    for (const marker of visibleAnalyzerProtocolMarkers(lane.markers, state.start, viewSamples(), plotWidth)) {
      const centerX = Math.round(x(marker.sample)) + 0.5;
      if (marker.kind === state.selected) {
        context.strokeStyle = light ? "#1463a1" : "#75c2f4";
        context.lineWidth = 1;
        context.beginPath(); context.arc(centerX, centerY, 11 * state.markerScale, 0, Math.PI * 2); context.stroke();
      }
      context.save();
      context.translate(centerX, centerY);
      context.scale(state.markerScale, state.markerScale);
      context.globalAlpha = 0.96;
      context.shadowOffsetY = 1;
      drawProtocolMarker(context, 0, 0, marker.kind, activeThemeChannelColor(lane.channel), palette());
      context.restore();
      if (state.labels) {
        context.textAlign = "center";
        context.fillStyle = light ? "#657388" : "#a9b2bf";
        context.font = "10px ui-monospace, monospace";
        const info = MARKER_DESCRIPTIONS[marker.kind];
        const estimatedLabelWidth = info.sdk.length * 6;
        const labelX = Math.min(left + plotWidth - estimatedLabelWidth / 2, Math.max(left + estimatedLabelWidth / 2, centerX));
        context.fillText(info.sdk, labelX, centerY + 32);
      }
      const target = document.createElement("button");
      target.type = "button";
      target.className = "waveform-target";
      target.style.left = `${centerX}px`;
      target.style.top = `${centerY}px`;
      target.style.width = target.style.height = `${Math.max(28, state.markerScale * 15)}px`;
      target.dataset.kind = marker.kind;
      target.setAttribute("aria-label", `选择 ${MARKER_DESCRIPTIONS[marker.kind].sdk}，采样点 ${marker.sample}`);
      target.title = `${marker.kind} @ ${marker.sample}`;
      target.addEventListener("click", () => selectMarker(marker.kind));
      fragment.append(target);
      visibleKinds.push(marker.kind);
    }
    context.restore();
  });
  targets.replaceChildren(fragment);
  waveform.dataset.renderedKinds = visibleKinds.join(",");
  waveform.dataset.markerScale = String(state.markerScale);
  waveform.dataset.labels = String(state.labels);
  waveform.dataset.viewStart = String(state.start);
  status.textContent = `当前显示 ${visibleKinds.length} / ${MARKER_KINDS.length} 个标识`;
}

function scheduleDraw() {
  if (pendingFrame !== null) return;
  pendingFrame = window.requestAnimationFrame(() => {
    pendingFrame = null;
    for (const item of previewCanvases) drawPreview(item.canvas, item.kind, item.scale, item.scale === 1 ? 28 : 68, 62);
    drawPreview(element<HTMLCanvasElement>("detail-preview"), state.selected, 4, 112, 96);
    drawWaveform();
  });
}

function changeTheme() {
  setActiveUiTheme(getUiTheme(themeSelect.value));
  document.documentElement.dataset.theme = themeSelect.value;
  document.documentElement.style.colorScheme = themeSelect.value === "lab-light" ? "light" : "dark";
  state.previewColor = activeThemeChannelColor(6);
  previewColor.value = state.previewColor;
  scheduleDraw();
}

themeSelect.addEventListener("change", changeTheme);
previewColor.addEventListener("input", () => { state.previewColor = previewColor.value; scheduleDraw(); });
scaleSelect.addEventListener("change", () => { state.markerScale = Number(scaleSelect.value); scheduleDraw(); });
labelsInput.addEventListener("change", () => { state.labels = labelsInput.checked; scheduleDraw(); });
zoomInput.addEventListener("input", () => {
  const center = state.start + viewSamples() / 2;
  state.zoom = Number(zoomInput.value);
  state.start = clampStart(center - viewSamples() / 2);
  updateControls(); scheduleDraw();
});
panInput.addEventListener("input", () => { state.start = Number(panInput.value) / 100 * maxStart(); scheduleDraw(); });
element("reset-view").addEventListener("click", () => {
  state.zoom = 1; state.start = 0; updateControls(); scheduleDraw();
});
element<HTMLButtonElement>("export-png").addEventListener("click", () => {
  drawWaveform();
  waveform.toBlob((blob) => {
    if (!blob) { status.textContent = "PNG 导出失败，请重试。"; return; }
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url; anchor.download = "sigpilot-protocol-markers.png";
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }, "image/png");
});
new ResizeObserver(scheduleDraw).observe(waveformHost);
window.addEventListener("resize", scheduleDraw);
changeTheme();
updateControls();
