import assert from "node:assert/strict";
import test from "node:test";
import {
  SEMANTIC_COLOR_FIELDS, contrastRatio, createCustomTheme, customThemeDefinition,
  emptyThemeLibrary, exportCustomTheme, importCustomTheme, loadThemeLibrary,
  parseThemeLibrary, saveThemeLibrary, semanticColorsForTheme, themeChannelProfile,
  validateCustomTheme,
} from "../src/lib/customThemes.ts";
import {
  BUILTIN_UI_THEMES, activeThemeChannelColor, activeUiTheme, activeWaveformThemeColors,
  applyUiTheme, channelColorForPalette, getUiTheme, normalizeThemeId, setActiveUiTheme, unregisterUiTheme,
} from "../src/lib/themes.ts";
import { loadUiPreferences, persistUiPreferences } from "../src/lib/preferences.ts";

function memoryStorage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}

test("every built-in theme copies to a complete safe editable HEX palette", () => {
  for (const theme of BUILTIN_UI_THEMES) {
    const copy = createCustomTheme(theme, `custom-test-${theme.id}`);
    assert.equal(copy.channelColors.length, 8);
    assert.deepEqual(validateCustomTheme(copy), copy);
    for (const field of SEMANTIC_COLOR_FIELDS) assert.match(copy.colors[field.key], /^#[0-9a-f]{6}$/);
    assert.equal(copy.colors.workspace, theme.cssVars["--grey900"].toLowerCase());
    assert.notEqual(copy.colors.textPrimary, copy.colors.panel);
  }
});

test("semantic colors map consistently to CSS, canvas, grid and channel colors", () => {
  const copy = createCustomTheme(getUiTheme("lab-light"), "custom-semantic-test");
  copy.colors.panel = "#123456";
  copy.colors.accent = "#abcdef";
  copy.colors.separator = "#010203";
  copy.colors.monochrome = "#456789";
  const theme = customThemeDefinition(copy);
  assert.equal(theme.cssVars["--background-20"], "#123456");
  assert.equal(theme.cssVars["--surface-10"], "#123456");
  assert.equal(theme.cssVars["--lightBlue-base"], "171, 205, 239");
  setActiveUiTheme(theme);
  assert.equal(activeWaveformThemeColors().separator, "#010203");
  assert.equal(activeWaveformThemeColors().monochrome, "#456789");
  assert.deepEqual(semanticColorsForTheme(theme), copy.colors);
  setActiveUiTheme(getUiTheme("saleae-dark"));
});

test("theme library and selected preference survive a fresh registration", () => {
  const storage = memoryStorage();
  const theme = createCustomTheme(getUiTheme("midnight-aurora"), "custom-persist-test");
  const library = { ...emptyThemeLibrary(), themes: [theme], channelOverrides: { "test:D16:A2": { D8: "#112233", A0: "#aabbcc" } } };
  saveThemeLibrary(library, storage);
  persistUiPreferences({ ...loadUiPreferences(storage), themeId: theme.id }, storage);
  unregisterUiTheme(theme.id);
  assert.equal(normalizeThemeId(theme.id), "saleae-dark");
  assert.deepEqual(loadThemeLibrary(storage), library);
  assert.equal(loadUiPreferences(storage).themeId, theme.id);
  unregisterUiTheme(theme.id);
});

test("JSON round trip preserves palette and device overrides without CSS payloads", () => {
  const theme = createCustomTheme(getUiTheme("solarized-night"), "custom-export-test");
  const overrides = { "device:D32:A4": { D0: "#123456", D8: "#abcdef", A0: "#ff0000" } };
  const text = exportCustomTheme(theme, overrides);
  assert.deepEqual(importCustomTheme(text), { version: 1, themes: [theme], channelOverrides: overrides });
  assert.equal(text.includes("cssVars"), false);
});

test("imports reject unknown fields, script/CSS colors, oversized and unsupported formats", () => {
  const theme = createCustomTheme(getUiTheme("saleae-dark"), "custom-validation-test");
  const library = { ...emptyThemeLibrary(), themes: [theme] };
  assert.throws(() => importCustomTheme("not JSON"));
  assert.throws(() => importCustomTheme(" ".repeat(256_001)));
  assert.throws(() => parseThemeLibrary({ ...library, version: 2 }));
  assert.throws(() => parseThemeLibrary({ ...library, themes: [theme, theme] }));
  assert.throws(() => validateCustomTheme({ ...theme, cssVars: { "--background-0": "url(https://bad)" } }));
  assert.throws(() => validateCustomTheme({ ...theme, id: "saleae-dark" }));
  assert.throws(() => validateCustomTheme({ ...theme, label: " " }));
  assert.throws(() => validateCustomTheme({ ...theme, colors: { ...theme.colors, background: "url(javascript:bad)" } }));
  assert.throws(() => validateCustomTheme({ ...theme, channelColors: ["#123456"] }));
  assert.throws(() => parseThemeLibrary({ ...library, channelOverrides: JSON.parse('{"__proto__":{"D0":"#123456"}}') }));
  assert.throws(() => parseThemeLibrary({ ...library, channelOverrides: { device: { D256: "#123456" } } }));
});

test("corrupt or unavailable storage falls back safely; failed save does not register a theme", () => {
  assert.deepEqual(loadThemeLibrary({ getItem: () => "broken", setItem: () => {} }), emptyThemeLibrary());
  assert.deepEqual(loadThemeLibrary({ getItem: () => { throw new Error("blocked"); }, setItem: () => {} }), emptyThemeLibrary());
  const theme = createCustomTheme(getUiTheme("saleae-dark"), "custom-storage-error-test");
  assert.throws(() => saveThemeLibrary({ ...emptyThemeLibrary(), themes: [theme] }, { getItem: () => null, setItem: () => { throw new Error("quota"); } }));
  assert.equal(normalizeThemeId(theme.id), "saleae-dark");
});

test("D/A overrides use physical IDs and resolved digital palette preserves unmodified repetition", () => {
  const theme = getUiTheme("midnight-aurora");
  setActiveUiTheme(theme, { D8: "#112233", D31: "#445566", A0: "#778899" });
  assert.equal(activeThemeChannelColor(0), theme.channelColors[0]);
  assert.equal(activeThemeChannelColor(8), "#112233");
  assert.equal(activeThemeChannelColor(0, "A"), "#778899");
  assert.equal(activeThemeChannelColor(8, "A"), theme.channelColors[0]);
  for (const index of [0, 1, 8, 9, 16, 31]) {
    assert.equal(channelColorForPalette(activeUiTheme().channelColors, index), activeThemeChannelColor(index));
  }
  setActiveUiTheme(getUiTheme("lab-light"), { D8: "#112233" });
  assert.equal(activeThemeChannelColor(8), "#112233");
  assert.equal(activeThemeChannelColor(16), getUiTheme("lab-light").channelColors[0]);
  setActiveUiTheme(theme);
  assert.equal(activeThemeChannelColor(8), theme.channelColors[0]);
  setActiveUiTheme(getUiTheme("saleae-dark"));
});

test("returning from a draft restores derived CSS variables as well as waveform colors", () => {
  const styles = new Map<string, string>();
  const root = { dataset: {} as Record<string, string>, style: { setProperty: (key: string, value: string) => styles.set(key, value) } };
  const theme = createCustomTheme(getUiTheme("lab-light"), "custom-preview-test");
  theme.colors.onAccent = "#123456";
  applyUiTheme(customThemeDefinition(theme), root as unknown as HTMLElement);
  assert.equal(styles.get("--on-primary"), "#123456");
  applyUiTheme(getUiTheme("saleae-dark"), root as unknown as HTMLElement);
  assert.equal(root.dataset.theme, "saleae-dark");
  assert.equal(styles.get("--background-20"), "var(--grey800)");
  assert.notEqual(styles.get("--on-primary"), "#123456");
  assert.equal(styles.get("--wave-background"), getUiTheme("saleae-dark").cssVars["--grey900"]);
});

test("profiles distinguish model and channel layout, contrast checks are deterministic", () => {
  assert.notEqual(themeChannelProfile("Device", 8, 0), themeChannelProfile("Device", 16, 0));
  assert.notEqual(themeChannelProfile("Device", 8, 0), themeChannelProfile("Device", 8, 2));
  assert.equal(contrastRatio("#ffffff", "#000000"), 21);
  assert.equal(contrastRatio("#abcdef", "#abcdef"), 1);
});
