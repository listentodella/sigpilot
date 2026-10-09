import { migrateLegacyKey } from "./legacyStorage.ts";

export const SUPPORTED_LOCALES = ["en", "zh-CN"] as const;
export type AppLocale = (typeof SUPPORTED_LOCALES)[number];
export const DEFAULT_LOCALE: AppLocale = "en";

export function isAppLocale(value: unknown): value is AppLocale {
  return typeof value === "string" && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

/**
 * The locale to use before the user has chosen one. `navigator.language` is a
 * BCP-47 tag, so match on its language subtag and otherwise stay on English.
 */
export function initialLocale(): AppLocale {
  const preferred = typeof navigator === "undefined" ? "" : navigator.language;
  return preferred.toLowerCase().startsWith("zh") ? "zh-CN" : DEFAULT_LOCALE;
}

export interface UiPreferences {
  locale: AppLocale;
  animationScale: number;
  matchChannelColors: boolean;
  panToTrigger: boolean;
  renameTabToSavedCapture: boolean;
  showGridLines: boolean;
}

/** Bounds for `animationScale`: 0 is instant, 1 is the 100 ms default, 3 is 300 ms. */
export const ANIMATION_SCALE_MIN = 0;
export const ANIMATION_SCALE_MAX = 3;

interface PreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

const UI_PREFERENCES_KEY = "sigpilot.preferences.v1";
const LEGACY_UI_PREFERENCES_KEY = "pxlogic.preferences.v1";

export const DEFAULT_UI_PREFERENCES: UiPreferences = {
  locale: DEFAULT_LOCALE,
  animationScale: 1,
  matchChannelColors: true,
  panToTrigger: true,
  renameTabToSavedCapture: false,
  showGridLines: true,
};

export function normalizeUiPreferences(value: unknown): UiPreferences {
  if (!value || typeof value !== "object") return { ...DEFAULT_UI_PREFERENCES };
  const candidate = value as Partial<UiPreferences>;
  return {
    locale: isAppLocale(candidate.locale) ? candidate.locale : DEFAULT_UI_PREFERENCES.locale,
    animationScale:
      typeof candidate.animationScale === "number" && Number.isFinite(candidate.animationScale)
        ? Math.min(ANIMATION_SCALE_MAX, Math.max(ANIMATION_SCALE_MIN, candidate.animationScale))
        : DEFAULT_UI_PREFERENCES.animationScale,
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
    showGridLines:
      typeof candidate.showGridLines === "boolean"
        ? candidate.showGridLines
        : DEFAULT_UI_PREFERENCES.showGridLines,
  };
}

export function loadUiPreferences(storage = browserPreferenceStorage()): UiPreferences {
  if (!storage) return { ...DEFAULT_UI_PREFERENCES };
  migrateLegacyKey(storage, UI_PREFERENCES_KEY, LEGACY_UI_PREFERENCES_KEY);
  try {
    const stored = storage.getItem(UI_PREFERENCES_KEY);
    // First run (nothing stored yet): follow the OS language rather than
    // starting every user on English.
    if (stored === null) return normalizeUiPreferences({ locale: initialLocale() });
    return normalizeUiPreferences(JSON.parse(stored));
  } catch {
    return normalizeUiPreferences({ locale: initialLocale() });
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
