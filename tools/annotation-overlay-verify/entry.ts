import { createElement, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { WaveformAnnotationEditor } from "../../src/components/WaveformAnnotationEditor";
import { WaveformAnnotationsOverlay } from "../../src/components/WaveformAnnotationsOverlay";
import type { WaveformAnnotation } from "../../src/lib/api";
import { applyUiTheme, getUiTheme, setActiveUiTheme } from "../../src/lib/themes";
import i18n from "../../src/i18n";

/**
 * Resolves once the translation namespaces are loaded. Without this the overlay
 * renders t() keys instead of text, and a tooltip assertion would fail for a
 * reason that never happens in the workbench.
 */
export function whenI18nReady(): Promise<void> {
  if (i18n.isInitialized) return Promise.resolve();
  return new Promise((resolve) => {
    i18n.on("initialized", () => resolve());
  });
}

/** The overlay is themed by CSS variables the workbench normally writes at startup. */
export function applyDefaultTheme() {
  const theme = getUiTheme("saleae-dark");
  setActiveUiTheme(theme);
  applyUiTheme(theme);
}

interface Recorder {
  delete: string[];
  edit: string[];
  move: Array<[string, number]>;
  select: Array<string | null>;
}

interface ProbeState {
  annotations: WaveformAnnotation[];
  selectedId: string | null;
  busy: boolean;
}

export interface AnnotationProbe {
  /** Re-render with new data; synchronous so --dump-dom captures the result. */
  render(annotations: WaveformAnnotation[], selectedId: string | null): void;
  setBusy(busy: boolean): void;
  recorder: Recorder;
  reset(): void;
  ids(): string[];
  titledIds(): string[];
  iconPixels(): Array<{ id: string; painted: number; colored: number }>;
  titleRects(): Array<{ id: string; left: number; right: number; text: string }>;
  annotationRects(): Array<{ id: string; left: number; right: number; top: number }>;
  actionsVisible(): boolean;
  tooltipText(): string | null;
  hover(id: string): void;
  unhover(id: string): void;
  click(id: string): void;
  doubleClick(id: string): void;
  drag(id: string, deltaX: number): void;
  press(key: string): void;
}

const CHANNELS = [0, 1];
const ROW_HEIGHTS = [120, 120];
const TOTAL_SAMPLES = 1_000;

/**
 * Synthetic pointer capture: a scripted pointerdown has no active pointer id, so
 * the real capture APIs throw and the drag never starts. Everything else about
 * the drag path (threshold, math, commit) is exercised unchanged.
 */
function shimPointerCapture() {
  const captured = new Set<number>();
  Object.defineProperties(Element.prototype, {
    setPointerCapture: {
      configurable: true,
      value(this: Element, pointerId: number) { captured.add(pointerId); },
    },
    hasPointerCapture: {
      configurable: true,
      value(this: Element, pointerId: number) { return captured.has(pointerId); },
    },
    releasePointerCapture: {
      configurable: true,
      value(this: Element, pointerId: number) { captured.delete(pointerId); },
    },
  });
}

export function mountAnnotationProbe(host: HTMLElement): AnnotationProbe {
  shimPointerCapture();
  const recorder: Recorder = { delete: [], edit: [], move: [], select: [] };
  let current: ProbeState = { annotations: [], selectedId: null, busy: false };
  let applyState: (next: ProbeState) => void = () => {};

  function Probe() {
    const [state, setState] = useState<ProbeState>({ annotations: [], selectedId: null, busy: false });
    current = state;
    applyState = (next) => setState(next);
    return createElement(WaveformAnnotationsOverlay, {
      annotations: state.annotations,
      busy: state.busy,
      onDelete: (id: string) => recorder.delete.push(id),
      onEdit: (annotation: WaveformAnnotation) => recorder.edit.push(annotation.id),
      onMove: (id: string, sample: number) => recorder.move.push([id, sample]),
      onSelect: (id: string | null) => {
        recorder.select.push(id);
        setState((previous) => ({ ...previous, selectedId: id }));
      },
      rowHeights: ROW_HEIGHTS,
      rowTopInsets: [0, 0],
      sampleRateHz: 1_000_000,
      selectedId: state.selectedId,
      sessionId: "probe",
      totalSamples: TOTAL_SAMPLES,
      viewportSamples: TOTAL_SAMPLES,
      viewportStart: 0,
      visibleChannelIndexes: CHANNELS,
    });
  }

  const root = createRoot(host);
  flushSync(() => root.render(createElement(Probe)));

  const node = (id: string) => host.querySelector<HTMLElement>(`[data-user-annotation="${id}"]`);
  const button = (id: string) => node(id)?.querySelector<HTMLElement>(".waveformAnnotationButton") ?? null;

  function pointer(target: HTMLElement, type: string, clientX: number) {
    target.dispatchEvent(
      new PointerEvent(type, { bubbles: true, cancelable: true, clientX, clientY: 60, pointerId: 1, button: 0 }),
    );
  }

  return {
    recorder,
    render(annotations, selectedId) {
      flushSync(() => applyState({ ...current, annotations, selectedId }));
    },
    setBusy(busy) {
      flushSync(() => applyState({ ...current, busy }));
    },
    reset() {
      recorder.delete.length = 0;
      recorder.edit.length = 0;
      recorder.move.length = 0;
      recorder.select.length = 0;
    },
    ids() {
      return Array.from(host.querySelectorAll<HTMLElement>("[data-user-annotation]")).map(
        (element) => element.dataset.userAnnotation ?? "",
      );
    },
    titledIds() {
      return Array.from(host.querySelectorAll<HTMLElement>("[data-user-annotation]"))
        .filter((element) => element.querySelector(".waveformAnnotationTitle"))
        .map((element) => element.dataset.userAnnotation ?? "");
    },
    iconPixels() {
      return Array.from(host.querySelectorAll<HTMLElement>("[data-user-annotation]")).map((element) => {
        const canvas = element.querySelector<HTMLCanvasElement>("canvas.waveformAnnotationIcon");
        if (!canvas) return { id: element.dataset.userAnnotation ?? "", painted: -1, colored: -1 };
        const context = canvas.getContext("2d");
        const pixels = context ? context.getImageData(0, 0, canvas.width, canvas.height).data : null;
        let painted = 0;
        let colored = 0;
        for (let index = 0; pixels && index < pixels.length; index += 4) {
          if (pixels[index + 3] === 0) continue;
          painted += 1;
          if (pixels[index] === 0x58 && pixels[index + 1] === 0xc6 && pixels[index + 2] === 0x67) colored += 1;
        }
        return { id: element.dataset.userAnnotation ?? "", painted, colored };
      });
    },
    titleRects() {
      return Array.from(host.querySelectorAll<HTMLElement>("[data-user-annotation]")).flatMap((element) => {
        const title = element.querySelector<HTMLElement>(".waveformAnnotationTitle");
        if (!title) return [];
        const rect = title.getBoundingClientRect();
        return [{
          id: element.dataset.userAnnotation ?? "",
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          text: title.textContent ?? "",
        }];
      });
    },
    annotationRects() {
      return Array.from(host.querySelectorAll<HTMLElement>("[data-user-annotation]")).map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          id: element.dataset.userAnnotation ?? "",
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          top: Math.round(rect.top),
        };
      });
    },
    actionsVisible() {
      return host.querySelector(".waveformAnnotationActions") !== null;
    },
    tooltipText() {
      return host.querySelector<HTMLElement>('[role="tooltip"]')?.textContent ?? null;
    },
    hover(id) {
      const target = button(id);
      const container = node(id);
      if (!target || !container) return;
      // React synthesises enter/leave from mouseover/mouseout and bails out when
      // relatedTarget is missing, so a bare dispatch never triggers onMouseEnter.
      // The overlay listens on the container, so the over event is sent to both.
      flushSync(() => {
        for (const element of [container, target]) {
          element.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body }));
        }
      });
    },
    unhover(id) {
      const target = button(id);
      if (!target) return;
      flushSync(() => {
        target.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body }));
      });
    },
    click(id) {
      flushSync(() => button(id)?.click());
    },
    doubleClick(id) {
      flushSync(() => {
        button(id)?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
      });
    },
    drag(id, deltaX) {
      const target = button(id);
      if (!target) return;
      flushSync(() => {
        pointer(target, "pointerdown", 40);
        pointer(target, "pointermove", 40 + deltaX);
        pointer(target, "pointerup", 40 + deltaX);
      });
    },
    press(key) {
      flushSync(() => {
        document.body.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
      });
    },
  };
}

export interface AnnotationEditorProbe {
  saveCalls: WaveformAnnotation[];
  deleteCalls: number;
  closeCalls: number;
  dialog(): HTMLElement | null;
  titleInput(): HTMLInputElement | null;
  titleValue(): string;
  errors(): string[];
  setTitle(value: string): void;
  setSample(value: string): void;
  submit(): void;
  cancel(): void;
  remove(): void;
  pressEscape(): void;
  unmount(): void;
}

/** Mounts the editor dialog the same way the workbench does: through a portal. */
export function mountAnnotationEditor(annotation: WaveformAnnotation, isNew: boolean): AnnotationEditorProbe {
  const saveCalls: WaveformAnnotation[] = [];
  const counters = { deleteCalls: 0, closeCalls: 0 };
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  flushSync(() =>
    root.render(
      createElement(WaveformAnnotationEditor, {
        annotation,
        channelLabel: "D0 · SDA",
        isNew,
        onClose: () => { counters.closeCalls += 1; },
        onDelete: () => { counters.deleteCalls += 1; },
        onSave: (saved: WaveformAnnotation) => { saveCalls.push(saved); },
        sampleRateHz: 1_000_000,
        totalSamples: TOTAL_SAMPLES,
      }),
    ),
  );

  const dialog = () => document.querySelector<HTMLElement>('[data-testid="annotation-editor"]');
  const titleInput = () => dialog()?.querySelector<HTMLInputElement>('input[maxlength="80"]') ?? null;
  /**
   * React tracks the last value it wrote to a controlled input, so assigning
   * `.value` directly is ignored. The prototype setter bypasses that cache and
   * the dispatched input event is what React actually listens for.
   */
  function setValue(element: HTMLInputElement | HTMLTextAreaElement | null, value: string) {
    if (!element) return;
    const prototype = element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    flushSync(() => {
      setter?.call(element, value);
      element.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  return {
    saveCalls,
    get deleteCalls() { return counters.deleteCalls; },
    get closeCalls() { return counters.closeCalls; },
    dialog,
    titleInput,
    titleValue() {
      return titleInput()?.value ?? "";
    },
    errors() {
      return Array.from(dialog()?.querySelectorAll<HTMLElement>('[role="alert"]') ?? []).map(
        (element) => element.textContent ?? "",
      );
    },
    setTitle(value) {
      setValue(titleInput(), value);
    },
    setSample(value) {
      setValue(dialog()?.querySelector<HTMLInputElement>('input[type="number"]') ?? null, value);
    },
    submit() {
      flushSync(() => dialog()?.querySelector<HTMLButtonElement>('button[type="submit"]')?.click());
    },
    cancel() {
      const footer = dialog()?.querySelector("footer");
      const button = footer?.querySelector<HTMLButtonElement>("button:not(.primary):not(.waveformAnnotationDelete)");
      flushSync(() => button?.click());
    },
    remove() {
      flushSync(() => dialog()?.querySelector<HTMLButtonElement>(".waveformAnnotationDelete")?.click());
    },
    pressEscape() {
      // Dispatched from the focused control, like a real keystroke. Dispatching
      // on document instead would be claimed by the overlay's capture-phase
      // handler, which only yields for events originating inside the dialog.
      const target = document.activeElement ?? dialog() ?? document.body;
      flushSync(() => {
        target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      });
    },
    unmount() {
      flushSync(() => root.unmount());
      host.remove();
    },
  };
}
