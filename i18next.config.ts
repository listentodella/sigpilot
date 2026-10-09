import { defineConfig } from "i18next-cli";

// The catalog layout mirrors the runtime import in src/i18n/index.ts: one JSON
// file per namespace per locale, bundled by Vite.
//
// `pnpm i18n:extract` scans the source for `t()` keys and updates the primary
// language (en); `pnpm i18n:lint` reports hardcoded strings that would never be
// translated, which is the guard that keeps new features from re-hardcoding
// text. `--ci` on both makes them usable as a CI gate.
export default defineConfig({
  locales: ["en", "zh-CN"],
  extract: {
    defaultNS: "common",
    input: ["src/**/*.{ts,tsx}"],
    output: "src/i18n/locales/{{language}}/{{namespace}}.json",
  },
});
