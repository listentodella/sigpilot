import React from "react";
import ReactDOM from "react-dom/client";
// Initialises i18next (and applies the persisted locale) before the first render.
import "./i18n";
import App from "./App";
import "./styles.css";
import { installConsoleCapture, setLogLevel } from "./lib/logger";
import { loadUiPreferences } from "./lib/preferences";

async function mountApp() {
  // Capture as early as possible: everything logged during startup is part of
  // the record a bug report needs, and none of it can be recovered later.
  setLogLevel(loadUiPreferences().logLevel);
  installConsoleCapture();

  if (document.fonts) {
    try {
      await Promise.all([
        document.fonts.load('400 12px "Roboto"'),
        document.fonts.load('400 12px "Roboto Mono"'),
      ]);
    } catch {
      // Font fallbacks keep the application usable if an asset cannot load.
    }
  }

  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

void mountApp();
