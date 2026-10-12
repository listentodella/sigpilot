import assert from "node:assert/strict";
import test from "node:test";
import { loadUiPreferences, persistUiPreferences } from "../src/lib/preferences.ts";
import {
  BUILTIN_UI_THEMES,
  channelColorForTheme,
  getUiTheme,
  listUiThemes,
  normalizeThemeId,
  registerUiTheme,
  unregisterUiTheme,
} from "../src/lib/themes.ts";

test("built-in themes are distinct and provide complete palettes", () => {
  assert.equal(BUILTIN_UI_THEMES.length, 5);
  assert.equal(new Set(BUILTIN_UI_THEMES.map((theme) => theme.id)).size, BUILTIN_UI_THEMES.length);
  for (const theme of BUILTIN_UI_THEMES) {
    assert.ok(theme.channelColors.length >= 8);
    assert.match(theme.channelColors[0], /^#[0-9a-f]{6}$/i);
    assert.notEqual(theme.gridlinePrimary, theme.gridlineSecondary);
    assert.ok(theme.cssVars["--background-10"]);
    assert.ok(theme.cssVars["--selected-highlight"]);
  }
});

test("theme lookup normalizes unknown selections to the default", () => {
  assert.equal(normalizeThemeId("midnight-aurora"), "midnight-aurora");
  assert.equal(normalizeThemeId("missing-theme"), "saleae-dark");
  assert.equal(getUiTheme("missing-theme").id, "saleae-dark");
  assert.equal(channelColorForTheme(getUiTheme("terminal-green"), 8), getUiTheme("terminal-green").channelColors[0]);
});

test("third-party themes can be registered, replaced and removed", () => {
  const theme = {
    id: "test-theme",
    label: "Test Theme",
    description: "A test palette",
    cssVars: { "--background-10": "#101010" },
    channelColors: ["#123456", "#abcdef"],
    gridlinePrimary: "#202020",
    gridlineSecondary: "#404040",
  } as const;
  registerUiTheme(theme);
  assert.equal(getUiTheme("test-theme").label, "Test Theme");
  assert.ok(listUiThemes().some((item) => item.id === "test-theme"));
  assert.equal(channelColorForTheme(theme, 2), "#123456");
  registerUiTheme({ ...theme, label: "Updated Test Theme" });
  assert.equal(getUiTheme("test-theme").label, "Updated Test Theme");
  assert.equal(unregisterUiTheme("test-theme"), true);
  assert.equal(unregisterUiTheme("test-theme"), false);
  assert.equal(unregisterUiTheme("saleae-dark"), false);
});

test("invalid third-party themes are rejected", () => {
  assert.throws(() => registerUiTheme({
    id: "Bad Theme",
    label: "Bad",
    description: "",
    cssVars: {},
    channelColors: ["red"],
    gridlinePrimary: "#000000",
    gridlineSecondary: "#111111",
  }));
});

test("theme selection survives preference persistence without changing capture preferences", () => {
  const entries = new Map<string, string>();
  const storage = {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => { entries.set(key, value); },
    removeItem: (key: string) => { entries.delete(key); },
  };
  const before = loadUiPreferences(storage);
  persistUiPreferences({ ...before, themeId: "midnight-aurora" }, storage);
  const restored = loadUiPreferences(storage);
  assert.equal(restored.themeId, "midnight-aurora");
  assert.equal(restored.matchChannelColors, before.matchChannelColors);
  assert.equal(restored.panToTrigger, before.panToTrigger);
  assert.equal(restored.locale, before.locale);
});
