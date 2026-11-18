import ReactDOM from "react-dom/client";
import "./i18n";
import "./styles.css";
import "./remote.css";
import { RemoteWorkbench } from "./components/RemoteWorkbench";
ReactDOM.createRoot(document.getElementById("root")!).render(
  <RemoteWorkbench />,
);
