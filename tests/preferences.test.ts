import assert from "node:assert/strict";
import test from "node:test";
import {
  captureNameFromSavedPath,
  DEFAULT_UI_PREFERENCES,
  loadUiPreferences,
  normalizeUiPreferences,
  persistUiPreferences,
} from "../src/lib/preferences.ts";

test("preference normalization preserves valid values and restores missing defaults", () => {
  assert.deepEqual(
    normalizeUiPreferences({ matchChannelColors: false, panToTrigger: false }),
    {
      matchChannelColors: false,
      panToTrigger: false,
      renameTabToSavedCapture: false,
    },
  );
  assert.deepEqual(normalizeUiPreferences(null), DEFAULT_UI_PREFERENCES);
});

test("preferences round trip through application storage", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
  const expected = {
    matchChannelColors: false,
    panToTrigger: true,
    renameTabToSavedCapture: true,
  };

  persistUiPreferences(expected, storage);
  assert.deepEqual(loadUiPreferences(storage), expected);
});

test("saved capture names follow Logic filename rename behavior", () => {
  assert.equal(captureNameFromSavedPath("/captures/vehicle-bus.pxcap"), "vehicle-bus");
  assert.equal(captureNameFromSavedPath("C:\\captures\\vehicle.bus.sal"), "vehicle.bus");
  assert.equal(captureNameFromSavedPath("capture"), "capture");
  assert.equal(captureNameFromSavedPath("/"), null);
});
