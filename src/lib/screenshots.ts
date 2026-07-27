import { Image as TauriImage } from "@tauri-apps/api/image";
import { invoke } from "@tauri-apps/api/core";
import { writeImage } from "@tauri-apps/plugin-clipboard-manager";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";

export type ScreenshotDestination = "File" | "Clipboard";

export interface ScreenshotSettings {
  destination: ScreenshotDestination;
  filePath?: string;
}

export interface ScreenshotCaptureRect {
  height: number;
  width: number;
  x: number;
  y: number;
}

export interface TakeScreenshotOptions {
  connectedDeviceName?: string;
  rect?: ScreenshotCaptureRect;
  sessionName?: string;
  settings: ScreenshotSettings;
}

export interface TakeScreenshotResult {
  filePath?: string;
  message?: string;
}

const SCREENSHOT_SETTINGS_KEY = "pxlogic.screenshot-settings.v1";
const SCREENSHOT_BACKGROUND = "#131316";

export const SCREENSHOT_DELAY_MS = 300;
export const DEFAULT_SCREENSHOT_SETTINGS: ScreenshotSettings = { destination: "File" };

export function loadScreenshotSettings(): ScreenshotSettings {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(SCREENSHOT_SETTINGS_KEY) ?? "null") as
      | Partial<ScreenshotSettings>
      | null;
    if (!parsed || (parsed.destination !== "File" && parsed.destination !== "Clipboard")) {
      return { ...DEFAULT_SCREENSHOT_SETTINGS };
    }
    return {
      destination: parsed.destination,
      filePath: typeof parsed.filePath === "string" && parsed.filePath ? parsed.filePath : undefined,
    };
  } catch {
    return { ...DEFAULT_SCREENSHOT_SETTINGS };
  }
}

export function persistScreenshotSettings(settings: ScreenshotSettings) {
  try {
    window.localStorage.setItem(SCREENSHOT_SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Screenshot capture still works when persistent storage is unavailable.
  }
}

export async function takeScreenshot(options: TakeScreenshotOptions): Promise<TakeScreenshotResult> {
  const canvas = await captureAppCanvas(options.rect);
  if (options.settings.destination === "Clipboard") {
    await writeCanvasToClipboard(canvas);
    return { message: "Screenshot copied to clipboard" };
  }

  const defaultPath = await getNextScreenshotPath(options);
  const selectedExtension = screenshotExtension(defaultPath);
  const filters = selectedExtension === "jpg" || selectedExtension === "jpeg"
    ? [
        { name: "JPEG", extensions: ["jpg", "jpeg"] },
        { name: "PNG", extensions: ["png"] },
      ]
    : [
        { name: "PNG", extensions: ["png"] },
        { name: "JPEG", extensions: ["jpg", "jpeg"] },
      ];

  if (!isTauriRuntime()) {
    const fileName = basename(defaultPath);
    const blob = await canvasToBlob(canvas, screenshotMimeType(fileName));
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.download = fileName;
    anchor.href = href;
    anchor.click();
    URL.revokeObjectURL(href);
    return { filePath: fileName, message: `Screenshot saved as ${fileName}` };
  }

  const dialogPath = await saveDialog({ defaultPath, filters });
  if (!dialogPath) return {};
  const chosenPath = ensureScreenshotExtension(dialogPath, selectedExtension);
  const mimeType = screenshotMimeType(chosenPath);
  const dataUrl = canvas.toDataURL(mimeType, mimeType === "image/jpeg" ? 0.8 : undefined);
  await invoke("write_screenshot_file", {
    request: { dataBase64: dataUrl, path: chosenPath },
  });
  return {
    filePath: chosenPath,
    message: `Screenshot saved as ${basename(chosenPath)}`,
  };
}

async function captureAppCanvas(rect?: ScreenshotCaptureRect) {
  if (isTauriRuntime()) return captureNativeAppCanvas(rect);
  return captureBrowserAppCanvas(rect);
}

async function captureNativeAppCanvas(rect?: ScreenshotCaptureRect) {
  const root = document.querySelector<HTMLElement>(".logic-root");
  if (!root) throw new Error("screenshot root is not available");
  const rootRect = root.getBoundingClientRect();
  const requested = clampScreenshotRect(rootRect, rect);
  const restoreHidden = hideScreenshotChrome();
  let encoded: string;
  try {
    encoded = await invoke<string>("capture_screenshot_png");
  } finally {
    restoreHidden();
  }
  const image = await loadScreenshotImage(`data:image/png;base64,${encoded}`);
  const scaleX = image.naturalWidth / Math.max(1, window.innerWidth);
  const scaleY = image.naturalHeight / Math.max(1, window.innerHeight);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(requested.width * scaleX));
  canvas.height = Math.max(1, Math.round(requested.height * scaleY));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("screenshot canvas is unavailable");
  context.drawImage(
    image,
    Math.round(requested.x * scaleX),
    Math.round(requested.y * scaleY),
    canvas.width,
    canvas.height,
    0,
    0,
    canvas.width,
    canvas.height,
  );
  return canvas;
}

function hideScreenshotChrome() {
  const elements = Array.from(
    document.querySelectorAll<HTMLElement>(
      ".channelContextMenu, .screenshotCaptureFeedback, .screenshotToast, .trimDialogLayer, .channelTrimOverlay, .waveformRowHitTargets",
    ),
  );
  const previous = elements.map((element) => element.style.display);
  elements.forEach((element) => {
    element.style.display = "none";
  });
  return () => {
    elements.forEach((element, index) => {
      element.style.display = previous[index] ?? "";
    });
  };
}

async function captureBrowserAppCanvas(rect?: ScreenshotCaptureRect) {
  const root = document.querySelector<HTMLElement>(".logic-root");
  if (!root) throw new Error("screenshot root is not available");
  await document.fonts?.ready;

  const rootRect = root.getBoundingClientRect();
  const requested = clampScreenshotRect(rootRect, rect);
  const graphCanvas = rect ? captureBrowserGraphCanvasRect(requested) : null;
  if (graphCanvas) return graphCanvas;

  const width = Math.max(1, Math.round(requested.width));
  const height = Math.max(1, Math.round(requested.height));
  const scale = rect ? window.devicePixelRatio || 1 : 1;
  const { default: html2canvas } = await import("html2canvas");

  try {
    return await html2canvas(root, {
      backgroundColor: SCREENSHOT_BACKGROUND,
      height,
      ignoreElements: (element) =>
        element instanceof HTMLCanvasElement && (element.width <= 0 || element.height <= 0),
      logging: false,
      onclone: (clonedDocument) => {
        clonedDocument
          .querySelectorAll<HTMLElement>(
            ".channelContextMenu, .screenshotCaptureFeedback, .screenshotToast, .trimDialogLayer, .channelTrimOverlay, .waveformRowHitTargets",
          )
          .forEach((element) => {
            element.style.display = "none";
          });
      },
      scale,
      scrollX: 0,
      scrollY: 0,
      useCORS: true,
      width,
      windowHeight: Math.round(rootRect.height),
      windowWidth: Math.round(rootRect.width),
      x: Math.round(requested.x - rootRect.left),
      y: Math.round(requested.y - rootRect.top),
    });
  } catch (error) {
    const fallbackCanvas = rect ? captureBrowserGraphCanvasRect(requested) : null;
    if (fallbackCanvas) return fallbackCanvas;
    throw error;
  }
}

function captureBrowserGraphCanvasRect(requested: ScreenshotCaptureRect) {
  const graphViewport = document.querySelector<HTMLElement>(".graphViewport");
  const viewportRect = graphViewport?.getBoundingClientRect();
  if (!graphViewport || !viewportRect || !rectsOverlap(requested, viewportRect)) return null;

  const sourceCanvases = Array.from(graphViewport.querySelectorAll<HTMLCanvasElement>("canvas")).filter(
    (canvas) => canvas.width > 0 && canvas.height > 0,
  );
  if (sourceCanvases.length === 0) return null;

  const outputScale = window.devicePixelRatio || 1;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(requested.width * outputScale));
  canvas.height = Math.max(1, Math.round(requested.height * outputScale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("screenshot canvas is unavailable");
  context.fillStyle = SCREENSHOT_BACKGROUND;
  context.fillRect(0, 0, canvas.width, canvas.height);

  let drewSource = false;
  for (const source of sourceCanvases) {
    const sourceRect = source.getBoundingClientRect();
    const overlap = intersectScreenshotRects(requested, sourceRect);
    if (!overlap) continue;

    const sourceScaleX = source.width / Math.max(1, sourceRect.width);
    const sourceScaleY = source.height / Math.max(1, sourceRect.height);
    context.drawImage(
      source,
      Math.round((overlap.x - sourceRect.left) * sourceScaleX),
      Math.round((overlap.y - sourceRect.top) * sourceScaleY),
      Math.round(overlap.width * sourceScaleX),
      Math.round(overlap.height * sourceScaleY),
      Math.round((overlap.x - requested.x) * outputScale),
      Math.round((overlap.y - requested.y) * outputScale),
      Math.round(overlap.width * outputScale),
      Math.round(overlap.height * outputScale),
    );
    drewSource = true;
  }

  return drewSource ? canvas : null;
}

function rectsOverlap(a: ScreenshotCaptureRect, b: DOMRect) {
  return a.x < b.right && a.x + a.width > b.left && a.y < b.bottom && a.y + a.height > b.top;
}

function intersectScreenshotRects(a: ScreenshotCaptureRect, b: DOMRect): ScreenshotCaptureRect | null {
  const left = Math.max(a.x, b.left);
  const top = Math.max(a.y, b.top);
  const right = Math.min(a.x + a.width, b.right);
  const bottom = Math.min(a.y + a.height, b.bottom);
  if (right <= left || bottom <= top) return null;
  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  };
}

async function writeCanvasToClipboard(canvas: HTMLCanvasElement) {
  if (isTauriRuntime()) {
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("screenshot image is unavailable");
    const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
    const rgba = new Uint8Array(
      imageData.data.buffer,
      imageData.data.byteOffset,
      imageData.data.byteLength,
    );
    const image = await TauriImage.new(rgba, canvas.width, canvas.height);
    try {
      await writeImage(image);
    } finally {
      await image.close();
    }
    return;
  }

  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
    throw new Error("image clipboard is not available in this browser");
  }
  const blob = await canvasToBlob(canvas, "image/png");
  await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
}

function clampScreenshotRect(rootRect: DOMRect, rect?: ScreenshotCaptureRect) {
  const requested = rect ?? {
    x: rootRect.left,
    y: rootRect.top,
    width: rootRect.width,
    height: rootRect.height,
  };
  const left = Math.max(rootRect.left, requested.x);
  const top = Math.max(rootRect.top, requested.y);
  const right = Math.min(rootRect.right, requested.x + requested.width);
  const bottom = Math.min(rootRect.bottom, requested.y + requested.height);
  return {
    x: left,
    y: top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top),
  };
}

function loadScreenshotImage(source: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new window.Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("native screenshot decoding failed"));
    image.src = source;
  });
}

async function getNextScreenshotPath(options: TakeScreenshotOptions) {
  if (isTauriRuntime()) {
    return invoke<string>("next_screenshot_path", {
      request: {
        connectedDeviceName: options.connectedDeviceName,
        previousPath: options.settings.filePath,
        sessionName: options.sessionName,
      },
    });
  }

  const sessionName = options.sessionName;
  const basename = sessionName && !/^Session \d+$/.test(sessionName)
    ? sessionName
    : options.connectedDeviceName || "Logic 2";
  return options.settings.filePath || `${basename}.png`;
}

function canvasToBlob(canvas: HTMLCanvasElement, mimeType: string) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("screenshot encoding failed"))),
      mimeType,
      mimeType === "image/jpeg" ? 0.8 : undefined,
    );
  });
}

function basename(path: string) {
  return path.split(/[\\/]/).filter(Boolean).pop() || "Logic 2.png";
}

function screenshotExtension(path: string) {
  return basename(path).split(".").pop()?.toLowerCase() || "png";
}

function screenshotMimeType(path: string) {
  const extension = screenshotExtension(path);
  return extension === "jpg" || extension === "jpeg" ? "image/jpeg" : "image/png";
}

function ensureScreenshotExtension(path: string, preferredExtension: string) {
  const extension = screenshotExtension(path);
  if (extension === "png" || extension === "jpg" || extension === "jpeg") return path;
  const fallback = preferredExtension === "jpg" || preferredExtension === "jpeg" ? preferredExtension : "png";
  return `${path}.${fallback}`;
}

function isTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}
