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
import enCommon from "./locales/en/common.json";
import enFooter from "./locales/en/footer.json";
import enSettings from "./locales/en/settings.json";
import zhAdvanced from "./locales/zh-CN/advanced.json";
import zhCommon from "./locales/zh-CN/common.json";
import zhFooter from "./locales/zh-CN/footer.json";
import zhSettings from "./locales/zh-CN/settings.json";

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
  ns: ["common", "footer", "advanced", "settings"],
  resources: {
    en: { advanced: enAdvanced, common: enCommon, footer: enFooter, settings: enSettings },
    "zh-CN": { advanced: zhAdvanced, common: zhCommon, footer: zhFooter, settings: zhSettings },
  },
  supportedLngs: ["en", "zh-CN"],
});

export default i18n;
