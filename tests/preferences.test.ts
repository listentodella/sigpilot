import assert from "node:assert/strict";
import test from "node:test";
import {
  captureNameFromSavedPath,
  DEFAULT_UI_PREFERENCES,
  loadUiPreferences,
  normalizeUiPreferences,
  persistUiPreferences,
  type UiPreferences,
} from "../src/lib/preferences.ts";

test("preference normalization preserves valid values and restores missing defaults", () => {
  // The normalizer's contract is a COMPLETE preference set — every field the
  // settings surfaces read is present, whatever the stored blob held. Comparing
  // against a partial literal is what let this test go stale as fields were
  // added, so the expectation is derived from the defaults instead.
  assert.deepEqual(normalizeUiPreferences({ matchChannelColors: false, panToTrigger: false }), {
    ...DEFAULT_UI_PREFERENCES,
    matchChannelColors: false,
    panToTrigger: false,
  });
  assert.deepEqual(normalizeUiPreferences(null), DEFAULT_UI_PREFERENCES);

  // A value the normalizer does not accept is replaced, not passed through — the
  // whole point of validating rather than trusting the blob.
  assert.deepEqual(
    normalizeUiPreferences({ matchChannelColors: "yes", logLevel: "verbose" }),
    DEFAULT_UI_PREFERENCES,
  );
});

test("preferences round trip through application storage", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
  // Off-default in every kind of field, so a normalizer that dropped or ignored
  // one would fail this rather than coincidentally agree with the defaults.
  const expected: UiPreferences = {
    ...DEFAULT_UI_PREFERENCES,
    animationScale: 2,
    locale: "zh-CN",
    logLevel: "debug",
    logModuleLevels: { graph: "trace" },
    logPaused: true,
    matchChannelColors: false,
    panToTrigger: false,
    renameTabToSavedCapture: true,
    showGridLines: false,
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
