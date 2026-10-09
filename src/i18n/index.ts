// i18n bootstrap.
//
// Catalogs are bundled JSON rather than fetched assets: the app ships inside a
// Tauri webview where a locale request would either hit the network or need a
// custom protocol, and the catalogs are small enough that bundling is cheaper
// than the machinery. react-i18next re-renders subscribers on
// `changeLanguage`, so switching takes effect without a reload.
//
// The initial language comes from the persisted UI preference so a Chinese
// user does not see a flash of English before their choice is applied.
import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import { loadUiPreferences } from "../lib/preferences";
import enAdvanced from "./locales/en/advanced.json";
import enAnalyzers from "./locales/en/analyzers.json";
import enExtensions from "./locales/en/extensions.json";
import enChannelMenu from "./locales/en/channelMenu.json";
import enCommon from "./locales/en/common.json";
import enDevice from "./locales/en/device.json";
import enGraph from "./locales/en/graph.json";
import enFooter from "./locales/en/footer.json";
import enMeasurements from "./locales/en/measurements.json";
import enNotes from "./locales/en/notes.json";
import enPanels from "./locales/en/panels.json";
import enSettings from "./locales/en/settings.json";
import enStart from "./locales/en/start.json";
import enToolbar from "./locales/en/toolbar.json";
import zhAdvanced from "./locales/zh-CN/advanced.json";
import zhAnalyzers from "./locales/zh-CN/analyzers.json";
import zhExtensions from "./locales/zh-CN/extensions.json";
import zhChannelMenu from "./locales/zh-CN/channelMenu.json";
import zhCommon from "./locales/zh-CN/common.json";
import zhDevice from "./locales/zh-CN/device.json";
import zhGraph from "./locales/zh-CN/graph.json";
import zhFooter from "./locales/zh-CN/footer.json";
import zhMeasurements from "./locales/zh-CN/measurements.json";
import zhNotes from "./locales/zh-CN/notes.json";
import zhPanels from "./locales/zh-CN/panels.json";
import zhSettings from "./locales/zh-CN/settings.json";
import zhStart from "./locales/zh-CN/start.json";
import zhToolbar from "./locales/zh-CN/toolbar.json";

void i18n.use(initReactI18next).init({
  defaultNS: "common",
  // English is the source language, so it is also the fallback for any key a
  // translation is missing.
  fallbackLng: "en",
  interpolation: {
    // React escapes everything it renders; i18next must not double-escape.
    escapeValue: false,
  },
  lng: loadUiPreferences().locale,
  ns: ["common", "footer", "advanced", "settings", "toolbar", "panels", "notes", "start", "extensions", "analyzers", "graph", "channelMenu", "device", "measurements"],
  resources: {
    en: {
      advanced: enAdvanced,
      analyzers: enAnalyzers,
      channelMenu: enChannelMenu,
      extensions: enExtensions,
      common: enCommon,
      device: enDevice,
      graph: enGraph,
      footer: enFooter,
      measurements: enMeasurements,
      notes: enNotes,
      panels: enPanels,
      settings: enSettings,
      start: enStart,
      toolbar: enToolbar,
    },
    "zh-CN": {
      advanced: zhAdvanced,
      analyzers: zhAnalyzers,
      channelMenu: zhChannelMenu,
      extensions: zhExtensions,
      common: zhCommon,
      device: zhDevice,
      graph: zhGraph,
      footer: zhFooter,
      measurements: zhMeasurements,
      notes: zhNotes,
      panels: zhPanels,
      settings: zhSettings,
      start: zhStart,
      toolbar: zhToolbar,
    },
  },
  supportedLngs: ["en", "zh-CN"],
});

export default i18n;
