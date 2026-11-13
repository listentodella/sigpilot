import React from "react";
import { createRoot } from "react-dom/client";
import { FloatingTerminal } from "../../src/components/FloatingTerminal";
import type { TerminalTransport, TerminalOutput } from "../../src/lib/terminal";
import "../../src/i18n";
import i18n from "../../src/i18n";
import "../../src/styles.css";

const observations = { output: "", writes: [] as string[], resizes: [] as number[][], opens: [] as string[], closes: [] as string[], shortcutLeaks: 0 };
Object.assign(window, { terminalObservations: observations });
const decoder = new TextDecoder();
async function request<T>(method: string, value: object): Promise<T> {
  const response = await fetch(`/fixture/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result;
}
const transport: TerminalTransport = {
  async open(cols, rows) { const info = await request<{ id: string; shell: string; cwd: string }>("open", { cols, rows }); observations.opens.push(info.id); return info; },
  async poll(id) { const output = await request<TerminalOutput>("poll", { id }); observations.output = (observations.output + decoder.decode(Uint8Array.from(output.data), { stream: true })).slice(-1024 * 1024); return output; },
  async write(id, data) { observations.writes.push(data); await request("write", { id, data }); },
  async resize(id, cols, rows) { observations.resizes.push([cols, rows]); await request("resize", { id, cols, rows }); },
  async close(id) { observations.closes.push(id); await request("close", { id }); },
};
document.addEventListener("keydown", (event) => { if (event.key === "w" || event.key === "ArrowUp") observations.shortcutLeaks++; });
void i18n.changeLanguage("zh-CN");
createRoot(document.getElementById("root")!).render(<React.StrictMode><main style={{ padding: 24 }}>
  <h2>SigPilot · Demo 波形工作区</h2><p>终端验证使用真实系统 shell；页面不注册任何 AI agent。</p>
  <svg width="1100" height="350" style={{ background: "#18181b", border: "1px solid #333" }}>
    {["#ffb81c", "#00b140", "#0085ca", "#ff5e8e"].map((color, i) => <g key={color} transform={`translate(0, ${i*80})`}><text x="14" y="40" fill="#bbb">D{i}</text><path d="M 60 55 H 150 V 20 H 250 V 55 H 350 V 20 H 450 V 55 H 570 V 20 H 650 V 55 H 850 V 20 H 1000" fill="none" stroke={color} /></g>)}
  </svg><FloatingTerminal transport={transport} available /></main></React.StrictMode>);
