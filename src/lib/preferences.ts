export interface UiPreferences {
  matchChannelColors: boolean;
  panToTrigger: boolean;
  renameTabToSavedCapture: boolean;
}

interface PreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const UI_PREFERENCES_KEY = "pxlogic.preferences.v1";

export const DEFAULT_UI_PREFERENCES: UiPreferences = {
  matchChannelColors: true,
  panToTrigger: true,
  renameTabToSavedCapture: false,
};

export function normalizeUiPreferences(value: unknown): UiPreferences {
  if (!value || typeof value !== "object") return { ...DEFAULT_UI_PREFERENCES };
  const candidate = value as Partial<UiPreferences>;
  return {
    matchChannelColors:
      typeof candidate.matchChannelColors === "boolean"
        ? candidate.matchChannelColors
        : DEFAULT_UI_PREFERENCES.matchChannelColors,
    panToTrigger:
      typeof candidate.panToTrigger === "boolean"
        ? candidate.panToTrigger
        : DEFAULT_UI_PREFERENCES.panToTrigger,
    renameTabToSavedCapture:
      typeof candidate.renameTabToSavedCapture === "boolean"
        ? candidate.renameTabToSavedCapture
        : DEFAULT_UI_PREFERENCES.renameTabToSavedCapture,
  };
}

export function loadUiPreferences(storage = browserPreferenceStorage()): UiPreferences {
  if (!storage) return { ...DEFAULT_UI_PREFERENCES };
  try {
    return normalizeUiPreferences(JSON.parse(storage.getItem(UI_PREFERENCES_KEY) ?? "null"));
  } catch {
    return { ...DEFAULT_UI_PREFERENCES };
  }
}

export function persistUiPreferences(
  preferences: UiPreferences,
  storage = browserPreferenceStorage(),
) {
  if (!storage) return;
  try {
    storage.setItem(UI_PREFERENCES_KEY, JSON.stringify(normalizeUiPreferences(preferences)));
  } catch {
    // Preferences remain usable for this process when persistent storage is unavailable.
  }
}

export function captureNameFromSavedPath(path: string) {
  const fileName = path.split(/[\\/]/).filter(Boolean).pop();
  if (!fileName) return null;
  const extensionIndex = fileName.lastIndexOf(".");
  return extensionIndex > 0 ? fileName.slice(0, extensionIndex) : fileName;
}

function browserPreferenceStorage(): PreferenceStorage | null {
  return typeof window === "undefined" ? null : window.localStorage;
}
