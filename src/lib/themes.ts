export const UI_THEME_STORAGE_KEY = "sigpilot.themes.v1";

export interface UiThemeTokens {
  [cssVariable: string]: string;
}

export interface UiThemeDefinition {
  id: string;
  label: string;
  description: string;
  cssVars: UiThemeTokens;
  channelColors: readonly string[];
  gridlinePrimary: string;
  gridlineSecondary: string;
  waveformColors?: WaveformThemeColors;
}

const SALEAE_CHANNEL_COLORS = [
  "#d4d4d4",
  "#C79579",
  "#FF6D7F",
  "#FFB45B",
  "#e8d836",
  "#58c667",
  "#53A9FD",
  "#AF92FB",
] as const;

const SHARED_LAYOUT_VARS: UiThemeTokens = {
  "--main-toolbar-height": "31px",
  "--channel-label-width": "184px",
  "--bottom-bar-height": "40px",
  "--sidebar-panel-width": "300px",
  "--sidebar-tabs-width": "47px",
};

function tokens(values: UiThemeTokens): UiThemeTokens {
  return { ...SHARED_LAYOUT_VARS, ...values };
}

export const BUILTIN_UI_THEMES: readonly UiThemeDefinition[] = [
  {
    id: "saleae-dark",
    label: "Saleae Dark",
    description: "The original SigPilot dark workspace.",
    cssVars: tokens({
      "--lightBlue-base": "38, 163, 217",
      "--lightBlue": "rgb(var(--lightBlue-base))",
      "--green": "hsl(150, 100%, 30%)",
      "--green2": "hsl(162, 85%, 34%)",
      "--yellow": "hsl(45, 95%, 71%)",
      "--orange2": "hsl(28, 86%, 62%)",
      "--red": "hsl(7, 69%, 54%)",
      "--grey50": "#49494d",
      "--grey100": "#424246",
      "--grey200": "#3b3b3f",
      "--grey300": "#343438",
      "--grey400": "#2d2d30",
      "--grey500": "#262629",
      "--grey600": "#1f1f22",
      "--grey700": "#1a1a1d",
      "--grey800": "#18181b",
      "--grey900": "#131316",
      "--background-0-base": "19, 19, 22",
      "--background-0": "rgb(var(--background-0-base))",
      "--background-10": "var(--grey900)",
      "--background-20": "var(--grey800)",
      "--background-30": "var(--grey700)",
      "--background-40": "var(--grey600)",
      "--hover-background": "#3a3a3e",
      "--on-background-0": "#ffffff",
      "--surface-10": "var(--grey800)",
      "--surface-20": "var(--grey700)",
      "--border-10": "var(--grey700)",
      "--border-20": "var(--grey500)",
      "--on-background-10": "rgba(var(--white-base), 0.92)",
      "--on-background-20": "rgba(var(--white-base), 0.74)",
      "--on-background-30": "rgba(var(--white-base), 0.55)",
      "--on-background-40": "#4a4a4b",
      "--selected-highlight": "#26a3d9",
      "--positive": "#00994d",
      "--other-primary": "#d4d4d4",
      "--other-primary-base": "212, 212, 212",
      "--on-other-primary": "#141415",
    }),
    channelColors: SALEAE_CHANNEL_COLORS,
    gridlinePrimary: "#303136",
    gridlineSecondary: "#57575E",
  },
  {
    id: "midnight-aurora",
    label: "Midnight Aurora",
    description: "Deep navy surfaces with cyan and violet accents.",
    cssVars: tokens({
      "--lightBlue-base": "76, 201, 240",
      "--lightBlue": "rgb(var(--lightBlue-base))",
      "--green": "#39d98a",
      "--green2": "#22b573",
      "--yellow": "#f8d66d",
      "--orange2": "#ff9f68",
      "--red": "#ff6b81",
      "--grey50": "#42516b",
      "--grey100": "#35425b",
      "--grey200": "#2c3850",
      "--grey300": "#253047",
      "--grey400": "#202a3e",
      "--grey500": "#1b2436",
      "--grey600": "#172032",
      "--grey700": "#131b2c",
      "--grey800": "#101726",
      "--grey900": "#0b1220",
      "--background-0-base": "11, 18, 32",
      "--background-0": "rgb(var(--background-0-base))",
      "--background-10": "var(--grey900)",
      "--background-20": "var(--grey800)",
      "--background-30": "var(--grey700)",
      "--background-40": "var(--grey600)",
      "--hover-background": "#263652",
      "--on-background-0": "#f4f8ff",
      "--surface-10": "var(--grey800)",
      "--surface-20": "var(--grey700)",
      "--border-10": "var(--grey700)",
      "--border-20": "var(--grey500)",
      "--on-background-10": "rgba(244, 248, 255, 0.94)",
      "--on-background-20": "rgba(220, 232, 250, 0.76)",
      "--on-background-30": "rgba(190, 210, 238, 0.58)",
      "--on-background-40": "#71819d",
      "--selected-highlight": "#4cc9f0",
      "--positive": "#29c980",
      "--other-primary": "#d6e7ff",
      "--other-primary-base": "214, 231, 255",
      "--on-other-primary": "#101827",
    }),
    channelColors: ["#e6edf7", "#f59eaa", "#ffb86c", "#f4e285", "#78e08f", "#62d6ff", "#a78bfa", "#f0abfc"],
    gridlinePrimary: "#263653",
    gridlineSecondary: "#4b6085",
  },
  {
    id: "solarized-night",
    label: "Solarized Night",
    description: "Low-contrast blue-green surfaces with warm signal colors.",
    cssVars: tokens({
      "--lightBlue-base": "42, 161, 152",
      "--lightBlue": "rgb(var(--lightBlue-base))",
      "--green": "#859900",
      "--green2": "#2aa198",
      "--yellow": "#b58900",
      "--orange2": "#cb4b16",
      "--red": "#dc322f",
      "--grey50": "#586e75",
      "--grey100": "#4a6269",
      "--grey200": "#3f555c",
      "--grey300": "#344950",
      "--grey400": "#2c3d43",
      "--grey500": "#263238",
      "--grey600": "#202b30",
      "--grey700": "#1b2529",
      "--grey800": "#162022",
      "--grey900": "#102024",
      "--background-0-base": "16, 32, 36",
      "--background-0": "rgb(var(--background-0-base))",
      "--background-10": "var(--grey900)",
      "--background-20": "var(--grey800)",
      "--background-30": "var(--grey700)",
      "--background-40": "var(--grey600)",
      "--hover-background": "#30474b",
      "--on-background-0": "#fdf6e3",
      "--surface-10": "var(--grey800)",
      "--surface-20": "var(--grey700)",
      "--border-10": "var(--grey700)",
      "--border-20": "var(--grey500)",
      "--on-background-10": "rgba(253, 246, 227, 0.94)",
      "--on-background-20": "rgba(238, 232, 213, 0.78)",
      "--on-background-30": "rgba(181, 190, 178, 0.64)",
      "--on-background-40": "#71827e",
      "--selected-highlight": "#2aa198",
      "--positive": "#859900",
      "--other-primary": "#eee8d5",
      "--other-primary-base": "238, 232, 213",
      "--on-other-primary": "#102024",
    }),
    channelColors: ["#eee8d5", "#dc322f", "#cb4b16", "#b58900", "#859900", "#2aa198", "#268bd2", "#6c71c4"],
    gridlinePrimary: "#273b3f",
    gridlineSecondary: "#536b6c",
  },
  {
    id: "terminal-green",
    label: "Terminal Green",
    description: "A focused black-and-green instrument terminal.",
    cssVars: tokens({
      "--lightBlue-base": "105, 255, 122",
      "--lightBlue": "rgb(var(--lightBlue-base))",
      "--green": "#00e676",
      "--green2": "#69f0ae",
      "--yellow": "#f4ff81",
      "--orange2": "#ffab40",
      "--red": "#ff5252",
      "--grey50": "#3b5140",
      "--grey100": "#2c402f",
      "--grey200": "#253629",
      "--grey300": "#1e2c22",
      "--grey400": "#18251b",
      "--grey500": "#142019",
      "--grey600": "#101a14",
      "--grey700": "#0d1510",
      "--grey800": "#0a110c",
      "--grey900": "#060b07",
      "--background-0-base": "6, 11, 7",
      "--background-0": "rgb(var(--background-0-base))",
      "--background-10": "var(--grey900)",
      "--background-20": "var(--grey800)",
      "--background-30": "var(--grey700)",
      "--background-40": "var(--grey600)",
      "--hover-background": "#1d3822",
      "--on-background-0": "#effff1",
      "--surface-10": "var(--grey800)",
      "--surface-20": "var(--grey700)",
      "--border-10": "var(--grey700)",
      "--border-20": "var(--grey500)",
      "--on-background-10": "rgba(239, 255, 241, 0.94)",
      "--on-background-20": "rgba(200, 240, 205, 0.76)",
      "--on-background-30": "rgba(145, 190, 151, 0.62)",
      "--on-background-40": "#5b8061",
      "--selected-highlight": "#69ff7a",
      "--positive": "#00e676",
      "--other-primary": "#d9ffdf",
      "--other-primary-base": "217, 255, 223",
      "--on-other-primary": "#08100a",
    }),
    channelColors: ["#d9ffdf", "#ff8080", "#ffc266", "#f6ff80", "#80ff9a", "#66e0ff", "#a78bfa", "#ff8bd4"],
    gridlinePrimary: "#18311d",
    gridlineSecondary: "#3b6744",
  },
  {
    id: "lab-light",
    label: "Lab Light",
    description: "A bright paper-like workspace for well-lit benches.",
    cssVars: tokens({
      "--lightBlue-base": "19, 105, 170",
      "--lightBlue": "rgb(var(--lightBlue-base))",
      "--green": "#087f5b",
      "--green2": "#0f9d75",
      "--yellow": "#9a6700",
      "--orange2": "#c2410c",
      "--red": "#c92a2a",
      "--grey50": "#667085",
      "--grey100": "#98a2b3",
      "--grey200": "#c5cad3",
      "--grey300": "#d0d5dd",
      "--grey400": "#d8dde6",
      "--grey500": "#e1e5eb",
      "--grey600": "#e8ebf0",
      "--grey700": "#eef1f5",
      "--grey800": "#f5f7fa",
      "--grey900": "#fbfcfe",
      "--background-0-base": "255, 255, 255",
      "--background-0": "rgb(var(--background-0-base))",
      "--background-10": "var(--grey900)",
      "--background-20": "var(--grey800)",
      "--background-30": "var(--grey700)",
      "--background-40": "var(--grey600)",
      "--hover-background": "#e6f0f8",
      "--on-background-0": "#101828",
      "--surface-10": "var(--grey800)",
      "--surface-20": "var(--grey700)",
      "--border-10": "var(--grey600)",
      "--border-20": "var(--grey300)",
      "--on-background-10": "rgba(16, 24, 40, 0.94)",
      "--on-background-20": "rgba(52, 64, 84, 0.78)",
      "--on-background-30": "rgba(71, 84, 103, 0.66)",
      "--on-background-40": "#667085",
      "--selected-highlight": "#1369aa",
      "--positive": "#087f5b",
      "--other-primary": "#344054",
      "--other-primary-base": "52, 64, 84",
      "--on-other-primary": "#ffffff",
    }),
    channelColors: ["#344054", "#c92a2a", "#c2410c", "#9a6700", "#087f5b", "#1369aa", "#6741d9", "#a61e4d"],
    gridlinePrimary: "#d0d5dd",
    gridlineSecondary: "#98a2b3",
  },
];

let registeredThemes: UiThemeDefinition[] = [...BUILTIN_UI_THEMES];

export function listUiThemes(): readonly UiThemeDefinition[] {
  return registeredThemes;
}

export function getUiTheme(id: string | null | undefined): UiThemeDefinition {
  return registeredThemes.find((theme) => theme.id === id) ?? BUILTIN_UI_THEMES[0];
}

export function registerUiTheme(theme: UiThemeDefinition): UiThemeDefinition {
  validateUiTheme(theme);
  registeredThemes = [...registeredThemes.filter((item) => item.id !== theme.id), freezeTheme(theme)];
  return getUiTheme(theme.id);
}

export function unregisterUiTheme(id: string): boolean {
  if (BUILTIN_UI_THEMES.some((theme) => theme.id === id)) return false;
  const next = registeredThemes.filter((theme) => theme.id !== id);
  const changed = next.length !== registeredThemes.length;
  registeredThemes = next;
  return changed;
}

export function normalizeThemeId(id: unknown): string {
  return typeof id === "string" && registeredThemes.some((theme) => theme.id === id)
    ? id
    : BUILTIN_UI_THEMES[0].id;
}

export function applyUiTheme(theme: UiThemeDefinition, root: HTMLElement = document.documentElement) {
  root.dataset.theme = theme.id;
  const defaults = BUILTIN_UI_THEMES[0].cssVars;
  for (const [name, value] of Object.entries({ ...defaults, ...theme.cssVars })) root.style.setProperty(name, value);
  for (const [key, value] of Object.entries(waveformColorsForTheme(theme))) root.style.setProperty(`--wave-${key}`, value);
  const vars = { ...defaults, ...theme.cssVars };
  const rgb = (hex: string) => [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16)).join(", ");
  const text = vars["--on-background-0"];
  root.style.setProperty("--on-primary", vars["--on-primary"] ?? (theme.id === "lab-light" ? "#ffffff" : "#131316"));
  for (const [base, color] of Object.entries({ "--on-background-0-base": text, "--on-background-20-base": vars["--on-background-20"], "--selected-highlight-base": vars["--selected-highlight"] })) {
    root.style.setProperty(base, /^#[0-9a-f]{6}$/i.test(color) ? rgb(color) : rgb(text));
  }
  root.style.setProperty("--on-background-40-base", /^#[0-9a-f]{6}$/i.test(vars["--on-background-40"]) ? rgb(vars["--on-background-40"]) : rgb(text));
}

export function channelColorForTheme(theme: UiThemeDefinition, channelIndex: number) {
  return channelColorForPalette(theme.channelColors, channelIndex);
}

export function channelColorForPalette(palette: readonly string[], channelIndex: number) {
  const colors = palette.length > 0 ? palette : SALEAE_CHANNEL_COLORS;
  return colors[Math.abs(Math.trunc(channelIndex)) % colors.length];
}

function validateUiTheme(theme: UiThemeDefinition) {
  if (!theme || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(theme.id)) {
    throw new Error("Theme id must contain 2-64 lowercase letters, digits, or hyphens");
  }
  if (!theme.label.trim()) throw new Error("Theme label must not be empty");
  if (!theme.channelColors.length) throw new Error("Theme must define at least one channel color");
  if (!theme.gridlinePrimary || !theme.gridlineSecondary) throw new Error("Theme must define gridline colors");
  for (const color of theme.channelColors) {
    if (!/^#[0-9a-f]{6}$/i.test(color)) throw new Error(`Invalid channel color: ${color}`);
  }
}

function freezeTheme(theme: UiThemeDefinition): UiThemeDefinition {
  return Object.freeze({
    ...theme,
    cssVars: Object.freeze({ ...theme.cssVars }),
    channelColors: Object.freeze([...theme.channelColors]),
  });
}

for (const theme of BUILTIN_UI_THEMES) validateUiTheme(theme);

export interface WaveformThemeColors {
  background: string;
  text: string;
  gridPrimary: string;
  gridSecondary: string;
  separator: string;
  measurement: string;
  cursor: string;
  monochrome: string;
}

export function waveformColorsForTheme(theme: UiThemeDefinition): WaveformThemeColors {
  return theme.waveformColors ?? {
    background: theme.id === "lab-light" ? "#fbfcfe" : theme.cssVars["--grey900"] ?? "#101013",
    text: theme.cssVars["--on-background-0"] ?? "#ffffff",
    gridPrimary: theme.gridlinePrimary,
    gridSecondary: theme.gridlineSecondary,
    separator: theme.gridlinePrimary,
    measurement: theme.id === "lab-light" ? "#c2410c" : "#ffa640",
    cursor: theme.id === "lab-light" ? "#1369aa" : "#d4d4d4",
    monochrome: theme.cssVars["--on-background-0"] ?? "#ffffff",
  };
}

let activeTheme = BUILTIN_UI_THEMES[0];
let sourceTheme = activeTheme;
let activeOverrides: Readonly<Record<string, string>> = {};
let activeWaveColors = waveformColorsForTheme(activeTheme);

export function setActiveUiTheme(theme: UiThemeDefinition, overrides: Readonly<Record<string, string>> = {}) {
  sourceTheme = theme;
  activeOverrides = overrides;
  const indices = Object.keys(overrides).filter((key) => /^D\d+$/.test(key)).map((key) => Number(key.slice(1)));
  const size = Math.ceil(Math.max(256, theme.channelColors.length, ...indices.map((index) => index + 1)) / theme.channelColors.length) * theme.channelColors.length;
  activeTheme = indices.length ? { ...theme, channelColors: Array.from({ length: size }, (_, index) => overrides[`D${index}`] ?? channelColorForTheme(theme, index)) } : theme;
  activeWaveColors = waveformColorsForTheme(theme);
}

export function activeUiTheme() {
  return activeTheme;
}

export function activeWaveformThemeColors() {
  return activeWaveColors;
}

export function activeThemeChannelColor(channelIndex: number, kind: "D" | "A" = "D") {
  return activeOverrides[`${kind}${channelIndex}`] ?? channelColorForTheme(sourceTheme, channelIndex);
}
