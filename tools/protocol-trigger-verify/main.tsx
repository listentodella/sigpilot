// Real production panel and validator, with explicit component-test props.
// This fixture does not emulate Tauri, a device or a successful acquisition.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { useTranslation } from "react-i18next";
import i18n from "../../src/i18n";
import "../../src/styles.css";
import { ProtocolTriggerPanel } from "../../src/components/ProtocolTriggerPanel";
import { createAnalyzerInstance } from "../../src/lib/analyzers";
import type { CaptureSettings } from "../../src/lib/api";
import { buildProtocolTrigger, defaultProtocolTrigger, ProtocolTriggerValidationError } from "../../src/lib/protocolTrigger";

const analyzers = ["Async Serial", "I2C", "SPI"].map((type, index) => {
  const analyzer = createAnalyzerInstance(type, [], 0, "saleae_native");
  analyzer.id = ["uart", "i2c", "spi"][index]; analyzer.configurationValid = true;
  if (type === "I2C") { analyzer.i2cSdaChannel = 1; analyzer.i2cSclChannel = 2; }
  if (type === "SPI") Object.assign(analyzer, { spiClockChannel:0, spiMosiChannel:1, spiMisoChannel:2, spiEnableChannel:3 });
  return analyzer;
});
const settings: CaptureSettings = {
  device_id:"fake:sigpilot-demo",sample_rate_hz:1_000_000,channel_count:8,enabled_channels:[0,1,2,3,4,5,6,7],
  duration_ms:100,buffer_size_mb:64,decode_cross:true,threshold_volts:2,external_trigger_mode:"Close",mode:"Stream",
  trigger_enabled:false,trigger_channel:0,trigger_kind:"Rising",trigger_high_mask:0,trigger_low_mask:0,
  trigger_position_percent:50,glitch_filter_enabled:false,clock_edge:false,trigger_out_enabled:false,
};
function App() {
  const {t} = useTranslation("analyzers");
  const [state,setState] = useState({...defaultProtocolTrigger(),expanded:true});
  const [busy,setBusy] = useState(false), [readOnly,setReadOnly] = useState(false), [desktop,setDesktop] = useState(true);
  const [mode,setMode] = useState<"Stream"|"Buffer">("Stream");
  const [result,setResult] = useState("");
  function submit() { try { setResult(JSON.stringify(buildProtocolTrigger(state,analyzers,{...settings,mode},desktop) ?? null)); }
    catch(error) { setResult(JSON.stringify({error:error instanceof ProtocolTriggerValidationError ? error.code : String(error)})); } }
  return <main style={{width:380,padding:16,minHeight:780,background:"var(--background-20)",color:"var(--on-background-10)"}}>
    <p style={{fontSize:12,margin:"0 16px 16px"}}>Protocol trigger · component verification</p>
    <div className="fixtureControls" style={{display:"flex",gap:8,flexWrap:"wrap",margin:"0 16px 16px"}}>
      <button id="english" onClick={()=>void i18n.changeLanguage("en")}>English</button>
      <button id="chinese" onClick={()=>void i18n.changeLanguage("zh-CN")}>中文</button>
      <label><input id="busy" type="checkbox" checked={busy} onChange={event=>setBusy(event.target.checked)}/>Busy</label>
      <label><input id="readonly" type="checkbox" checked={readOnly} onChange={event=>setReadOnly(event.target.checked)}/>Read only</label>
      <label><input id="desktop" type="checkbox" checked={desktop} onChange={event=>setDesktop(event.target.checked)}/>Desktop props</label>
      <select id="mode" value={mode} onChange={event=>setMode(event.target.value as typeof mode)}><option>Stream</option><option>Buffer</option></select>
    </div>
    <ProtocolTriggerPanel state={state} onChange={patch=>setState(current=>({...current,...patch}))}
      analyzers={analyzers} settings={{...settings,mode}} disabled={busy||readOnly} desktop={desktop}/>
    <button id="submit" style={{margin:"0 16px"}} disabled={busy||readOnly} onClick={submit}>{t("start")}</button>
    <output id="result" style={{display:"block",fontSize:10,overflowWrap:"anywhere",margin:16}}>{result}</output>
  </main>;
}
void i18n.changeLanguage("en").then(()=>createRoot(document.getElementById("root")!).render(<App/>));
