import {
  BUILTIN_UI_THEMES, UI_THEME_STORAGE_KEY, channelColorForTheme, getUiTheme,
  registerUiTheme, waveformColorsForTheme, type UiThemeDefinition, type WaveformThemeColors,
} from "./themes.ts";

export const SEMANTIC_COLOR_FIELDS = [
  { key: "background", group: "surfaces", variable: "--background-0" },
  { key: "workspace", group: "surfaces", variable: "--background-10" },
  { key: "panel", group: "surfaces", variable: "--background-20" },
  { key: "raised", group: "surfaces", variable: "--background-30" },
  { key: "input", group: "surfaces", variable: "--background-40" },
  { key: "hover", group: "surfaces", variable: "--hover-background" },
  { key: "text", group: "text", variable: "--on-background-0" },
  { key: "textPrimary", group: "text", variable: "--on-background-10" },
  { key: "textSecondary", group: "text", variable: "--on-background-20" },
  { key: "textMuted", group: "text", variable: "--on-background-30" },
  { key: "textDisabled", group: "text", variable: "--on-background-40" },
  { key: "border", group: "accents", variable: "--border-10" },
  { key: "borderStrong", group: "accents", variable: "--border-20" },
  { key: "accent", group: "accents", variable: "--lightBlue" },
  { key: "selection", group: "accents", variable: "--selected-highlight" },
  { key: "onAccent", group: "accents", variable: "--on-primary" },
  { key: "neutral", group: "accents", variable: "--other-primary" },
  { key: "onNeutral", group: "accents", variable: "--on-other-primary" },
  { key: "success", group: "states", variable: "--positive" },
  { key: "warning", group: "states", variable: "--yellow" },
  { key: "error", group: "states", variable: "--red" },
  { key: "waveBackground", group: "waveform", wave: "background" },
  { key: "waveText", group: "waveform", wave: "text" },
  { key: "gridPrimary", group: "waveform", wave: "gridPrimary" },
  { key: "gridSecondary", group: "waveform", wave: "gridSecondary" },
  { key: "separator", group: "waveform", wave: "separator" },
  { key: "measurement", group: "waveform", wave: "measurement" },
  { key: "cursor", group: "waveform", wave: "cursor" },
  { key: "monochrome", group: "waveform", wave: "monochrome" },
] as const;
export type SemanticColorKey = typeof SEMANTIC_COLOR_FIELDS[number]["key"];
export type SemanticColors = Record<SemanticColorKey, string>;
export type ChannelOverrides = Record<string, Record<string, string>>;
export interface CustomTheme {
  id: string;
  label: string;
  baseThemeId: string;
  colors: SemanticColors;
  channelColors: string[];
}
export interface ThemeLibrary {
  version: 1;
  themes: CustomTheme[];
  channelOverrides: ChannelOverrides;
}
export interface ThemeChannel {
  id: string;
  label: string;
  enabled: boolean;
}
export interface ThemeChannelContext {
  profileId: string;
  label: string;
  channels: ThemeChannel[];
}
export interface ThemeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}
export function emptyThemeLibrary(): ThemeLibrary {
  return { version: 1, themes: [], channelOverrides: {} };
}

const hexPattern = /^#[0-9a-f]{6}$/i;
export function isThemeHex(value: unknown): boolean {
  return typeof value === "string" && hexPattern.test(value);
}
function rgbHex(r: number, g: number, b: number) {
  return `#${[r, g, b].map((value) => Math.round(Math.max(0, Math.min(255, value))).toString(16).padStart(2, "0")).join("")}`;
}
/** Resolve the built-in CSS color vocabulary without relying on the DOM. */
function resolveColor(value: string, vars: Record<string, string>, backdrop = "#131316", depth = 0): string {
  if (depth > 8) return backdrop;
  if (isThemeHex(value)) return value.toLowerCase();
  value = value.replace(/var\((--[\w-]+)\)/g, (_, key: string) => vars[key] ?? (key === "--white-base" ? "255, 255, 255" : "0, 0, 0"));
  if (value.includes("var(")) return resolveColor(value, vars, backdrop, depth + 1);
  if (isThemeHex(value)) return value.toLowerCase();
  if (value === "white") return "#ffffff";
  if (value === "black") return "#000000";
  const rgb = value.match(/^rgba?\(\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\s*\)$/);
  if (rgb) {
    const alpha = Number(rgb[4] ?? 1);
    const back = [1, 3, 5].map((offset) => parseInt(backdrop.slice(offset, offset + 2), 16));
    return rgbHex(...[1, 2, 3].map((index) => Number(rgb[index]) * alpha + back[index - 1] * (1 - alpha)) as [number, number, number]);
  }
  const hsl = value.match(/^hsl\(\s*([\d.]+),\s*([\d.]+)%,\s*([\d.]+)%\s*\)$/);
  if (hsl) {
    const h = Number(hsl[1]) / 60, s = Number(hsl[2]) / 100, l = Number(hsl[3]) / 100;
    const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(h % 2 - 1)), m = l - c / 2;
    const parts = h < 1 ? [c, x, 0] : h < 2 ? [x, c, 0] : h < 3 ? [0, c, x] : h < 4 ? [0, x, c] : h < 5 ? [x, 0, c] : [c, 0, x];
    return rgbHex(...parts.map((part) => (part + m) * 255) as [number, number, number]);
  }
  return backdrop;
}

export function semanticColorsForTheme(theme: UiThemeDefinition): SemanticColors {
  const vars: Record<string, string> = { "--on-primary": "#ffffff", ...theme.cssVars };
  const background = resolveColor(vars["--background-10"], vars);
  const wave = waveformColorsForTheme(theme);
  return Object.fromEntries(SEMANTIC_COLOR_FIELDS.map((field) => [field.key,
    resolveColor("variable" in field ? vars[field.variable] ?? "#ffffff" : wave[field.wave], vars, background),
  ])) as SemanticColors;
}
export function createCustomTheme(theme: UiThemeDefinition, id = `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`): CustomTheme {
  return {
    id, label: `${theme.label} Custom`,
    baseThemeId: BUILTIN_UI_THEMES.some((base) => base.id === theme.id) ? theme.id : "saleae-dark",
    colors: semanticColorsForTheme(theme),
    channelColors: Array.from({ length: 8 }, (_, index) => channelColorForTheme(theme, index).toLowerCase()),
  };
}
function baseRgb(hex: string) {
  return [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16)).join(", ");
}
function mix(a: string, b: string, ratio: number) {
  return rgbHex(...[1, 3, 5].map((offset) => parseInt(a.slice(offset, offset + 2), 16) * (1 - ratio) + parseInt(b.slice(offset, offset + 2), 16) * ratio) as [number, number, number]);
}
export function customThemeDefinition(custom: CustomTheme): UiThemeDefinition {
  const colors = custom.colors;
  const vars = { ...getUiTheme(custom.baseThemeId).cssVars };
  for (const field of SEMANTIC_COLOR_FIELDS) if ("variable" in field) vars[field.variable] = colors[field.key];
  Object.assign(vars, {
    "--background-0-base": baseRgb(colors.background), "--lightBlue-base": baseRgb(colors.accent),
    "--other-primary-base": baseRgb(colors.neutral), "--on-background-40-base": baseRgb(colors.textDisabled),
    "--surface-10": colors.panel, "--surface-20": colors.raised,
    "--green": colors.success, "--green2": colors.success, "--orange2": colors.warning,
    "--grey900": colors.workspace, "--grey800": colors.panel, "--grey700": colors.raised,
    "--grey600": colors.input, "--grey500": colors.borderStrong, "--grey400": colors.borderStrong,
    "--grey300": mix(colors.panel, colors.text, 0.2), "--grey200": mix(colors.panel, colors.text, 0.3),
    "--grey100": mix(colors.panel, colors.text, 0.4), "--grey50": mix(colors.panel, colors.text, 0.5),
  });
  const wave = Object.fromEntries(SEMANTIC_COLOR_FIELDS.flatMap((field) => "wave" in field ? [[field.wave, colors[field.key]]] : [])) as unknown as WaveformThemeColors;
  return { id: custom.id, label: custom.label, description: "Custom theme", cssVars: vars,
    channelColors: [...custom.channelColors], gridlinePrimary: wave.gridPrimary, gridlineSecondary: wave.gridSecondary, waveformColors: wave };
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object");
  return value as Record<string, unknown>;
}
function onlyKeys(value: Record<string, unknown>, keys: readonly string[]) {
  if (Object.keys(value).some((key) => !keys.includes(key))) throw new Error("Unknown theme field");
}
export function validateCustomTheme(value: unknown): CustomTheme {
  const source = object(value);
  onlyKeys(source, ["id", "label", "baseThemeId", "colors", "channelColors"]);
  if (typeof source.id !== "string" || !/^custom-[a-z0-9-]{1,56}$/.test(source.id)) throw new Error("Invalid custom theme ID");
  if (typeof source.label !== "string" || !source.label.trim() || source.label.trim().length > 80) throw new Error("Theme name must contain 1–80 characters");
  if (!BUILTIN_UI_THEMES.some((theme) => theme.id === source.baseThemeId)) throw new Error("Unknown base theme");
  const colors = object(source.colors);
  onlyKeys(colors, SEMANTIC_COLOR_FIELDS.map((field) => field.key));
  for (const field of SEMANTIC_COLOR_FIELDS) if (!isThemeHex(colors[field.key])) throw new Error(`Invalid color: ${field.key}`);
  if (!Array.isArray(source.channelColors) || source.channelColors.length !== 8 || !source.channelColors.every(isThemeHex)) throw new Error("Exactly eight HEX channel colors are required");
  return { id: source.id, label: source.label.trim(), baseThemeId: source.baseThemeId as string,
    colors: Object.fromEntries(SEMANTIC_COLOR_FIELDS.map((field) => [field.key, (colors[field.key] as string).toLowerCase()])) as SemanticColors,
    channelColors: source.channelColors.map((color: string) => color.toLowerCase()) };
}
export function validateChannelOverrides(value: unknown): ChannelOverrides {
  const profiles = object(value);
  if (Object.keys(profiles).length > 100) throw new Error("Too many device profiles");
  const result: ChannelOverrides = {};
  for (const [profile, candidate] of Object.entries(profiles)) {
    if (!/^[\w .:/()-]{1,160}$/.test(profile) || ["__proto__", "constructor", "prototype"].includes(profile)) throw new Error("Invalid device profile");
    const overrides = object(candidate);
    if (Object.keys(overrides).length > 256) throw new Error("Too many channel overrides");
    const copy: Record<string, string> = {};
    for (const [id, color] of Object.entries(overrides)) {
      if (!/^[DA](0|[1-9]\d{0,2})$/.test(id) || Number(id.slice(1)) >= 256 || !isThemeHex(color)) throw new Error("Invalid channel override");
      copy[id] = (color as string).toLowerCase();
    }
    result[profile] = copy;
  }
  return result;
}
export function parseThemeLibrary(value: unknown): ThemeLibrary {
  const source = object(value);
  onlyKeys(source, ["version", "themes", "channelOverrides"]);
  if (source.version !== 1 || !Array.isArray(source.themes) || source.themes.length > 50) throw new Error("Unsupported theme format or too many themes");
  const themes = source.themes.map(validateCustomTheme);
  if (new Set(themes.map((theme) => theme.id)).size !== themes.length) throw new Error("Duplicate theme IDs");
  return { version: 1, themes, channelOverrides: validateChannelOverrides(source.channelOverrides) };
}
export function registerThemeLibrary(library: ThemeLibrary) {
  for (const theme of library.themes) registerUiTheme(customThemeDefinition(theme));
}
function browserStorage(): ThemeStorage | null {
  try { return typeof window === "undefined" ? null : window.localStorage; } catch { return null; }
}
export function loadThemeLibrary(storage: ThemeStorage | null = browserStorage()): ThemeLibrary {
  try {
    const raw = storage?.getItem(UI_THEME_STORAGE_KEY);
    const library = raw ? parseThemeLibrary(JSON.parse(raw)) : emptyThemeLibrary();
    registerThemeLibrary(library);
    return library;
  } catch { return emptyThemeLibrary(); }
}
export function saveThemeLibrary(library: ThemeLibrary, storage: ThemeStorage | null = browserStorage()) {
  const valid = parseThemeLibrary(library);
  if (!storage) throw new Error("Persistent storage is unavailable");
  storage.setItem(UI_THEME_STORAGE_KEY, JSON.stringify(valid));
  registerThemeLibrary(valid);
  return valid;
}
export function exportCustomTheme(theme: CustomTheme, channelOverrides: ChannelOverrides): string {
  return JSON.stringify(parseThemeLibrary({ version: 1, themes: [theme], channelOverrides }), null, 2);
}
export function importCustomTheme(text: string): ThemeLibrary {
  if (text.length > 256_000) throw new Error("Theme file must be smaller than 256 KB");
  const library = parseThemeLibrary(JSON.parse(text));
  if (library.themes.length !== 1) throw new Error("Import one theme at a time");
  return library;
}
export function themeChannelProfile(model: string, digitalCount: number, analogCount: number): string {
  const safe = model.replace(/[^\w .:/()-]/g, "_").slice(0, 100) || "capture";
  return `${safe}:D${digitalCount}:A${analogCount}`;
}
export function contrastRatio(first: string, second: string): number {
  const luminance = (hex: string) => [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255)
    .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
    .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
  const a = luminance(first), b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
