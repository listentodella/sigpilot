import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

async function mountApp() {
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
