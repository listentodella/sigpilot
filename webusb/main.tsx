import ReactDOM from "react-dom/client";
import "../src/i18n";
import App from "../src/App";
import "../src/styles.css";
import { enableWebUsbRuntime } from "../src/webusb/bridge";

enableWebUsbRuntime();
ReactDOM.createRoot(document.getElementById("root")!).render(
  <App />,
);
