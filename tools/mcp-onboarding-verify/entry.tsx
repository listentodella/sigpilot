import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { McpSettingsPanel } from "../../src/components/McpSettingsPanel";
import { TimingMarkersOverlay, TimingMarkersPanel } from "../../src/components/timingMarkers/TimingMarkers";
import { readWorkbenchSnapshot, timingMarkersFromWorkbench, workbenchEditToken, type WorkbenchSnapshot } from "../../src/lib/workbench";
import { request } from "./core";
import i18n from "../../src/i18n";

export async function runChecks() {
 if (!i18n.isInitialized) await new Promise<void>((resolve)=>i18n.on("initialized",()=>resolve()));
 await i18n.changeLanguage("en");
 const failures:string[]=[];let checks=0;
 const check=(name:string,ok:boolean)=>{checks++;if(!ok)failures.push(name);};
 const settle=()=>new Promise<void>((resolve)=>setTimeout(resolve,30));
 const host=document.getElementById("host")!;const root=createRoot(host);
 flushSync(()=>root.render(<div className="sidebarPanelContent" style={{width:320,height:760}}><McpSettingsPanel /></div>));
 const wait=async (predicate:()=>boolean)=>{for(let n=0;n<120;n++){if(predicate())return;await settle();}throw new Error("UI condition timed out");};
 const button=(text:string)=>[...host.querySelectorAll<HTMLButtonElement>("button")].find((b)=>b.textContent===text)!;
 await wait(()=>Boolean(button("Enable MCP")&&!button("Enable MCP").disabled));
 check("three clear onboarding steps",host.querySelectorAll(".mcpStepHeading").length===3);
 check("Codex command is the default entry",host.querySelector<HTMLSelectElement>("#mcp-client")!.value==="codex" && host.querySelector<HTMLTextAreaElement>(".mcpCommand")!.value.startsWith("codex mcp add sigpilot --url http://127.0.0.1:"));
 // Closed details can retain layout rectangles while their contents are not painted.
 check("raw configuration collapsed by default",!host.querySelector<HTMLDetailsElement>(".mcpManual")!.open && !host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Agent MCP configuration"]')!.checkVisibility());
 const panel=host.querySelector<HTMLElement>(".mcpPanel")!;check("sidebar scrolls all setup steps",getComputedStyle(panel).overflowY==="auto"&&panel.scrollHeight>panel.clientHeight);
 const permissions=host.querySelector<HTMLInputElement>("#mcp-annotations")!;
 check("defaults read-only and disabled",!permissions.checked && button("Check MCP service").disabled && button("Copy command").disabled);
 flushSync(()=>permissions.click());await wait(()=>!button("Enable MCP").disabled);
 flushSync(()=>root.render(null));flushSync(()=>root.render(<div className="sidebarPanelContent" style={{width:320,height:760}}><McpSettingsPanel /></div>));
 await wait(()=>Boolean(button("Enable MCP")&&!button("Enable MCP").disabled));
 check("permission choice persists while disabled",host.querySelector<HTMLInputElement>("#mcp-annotations")!.checked);
 flushSync(()=>button("Enable MCP").click());
 await wait(()=>Boolean(button("Disable MCP")&&!button("Disable MCP").disabled));
 await request("begin-authorization");
 await wait(()=>Boolean(button("Allow connection")));
 check("OAuth consent request appears in the real panel",host.textContent!.includes("Demo Test Agent"));
 flushSync(()=>button("Deny").click());await wait(()=>!button("Allow connection"));
 check("OAuth denial removes the pending request",true);
 await request("begin-authorization");await wait(()=>Boolean(button("Allow connection")));
 flushSync(()=>button("Allow connection").click());await wait(()=>!button("Allow connection"));
 check("OAuth approval is sent through the panel",true);
 const config=()=>host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Agent MCP configuration"]')!.value;
 const setup=await request("setup",undefined,"GET");
 const initial=JSON.parse(setup.configurations.find((c:{id:string})=>c.id==="generic").content);
 const initialCommand=host.querySelector<HTMLTextAreaElement>(".mcpCommand")!.value;
 check("HTTP config contains only the shared endpoint",initial.mcpServers.sigpilot.url===setup.endpoint&&!initial.mcpServers.sigpilot.command&&!initial.mcpServers.sigpilot.env);
 const select=host.querySelector<HTMLSelectElement>("#mcp-client")!;
 for(const client of ["codex","claude_code","cursor","generic"]){
  flushSync(()=>{select.value=client;select.dispatchEvent(new Event("change",{bubbles:true}));});
  check(`${client} configuration`,client==="codex"?config().startsWith("[mcp_servers.sigpilot]"):JSON.parse(config()).mcpServers.sigpilot.url===initial.mcpServers.sigpilot.url);
  if(client==="codex"||client==="claude_code"){
   const command=host.querySelector<HTMLTextAreaElement>(".mcpCommand")!.value;
   check(`${client} registration command`,command.startsWith(client==="codex"?"codex mcp add sigpilot --url http://127.0.0.1:":"claude mcp add --transport http --scope user sigpilot http://127.0.0.1:")&&!command.includes("--instance-file"));
   flushSync(()=>button("Copy command").click());await wait(()=>Boolean(button("Copied")));
   check(`${client} copies exact command`,(window as unknown as {fixtureClipboard:string}).fixtureClipboard===command);
  }else if(client==="cursor"){
   check("Cursor installer is the primary entry",Boolean(button("Add to Cursor"))&&!host.querySelector(".mcpCommand"));
   flushSync(()=>button("Add to Cursor").click());await wait(()=>host.textContent!.includes("Open request sent"));
   check("Cursor install request does not claim a connection",(window as unknown as {fixtureOpenedClient:string}).fixtureOpenedClient==="cursor"&&!host.querySelector(".mcpCheckSuccess"));
  }else check(`${client} manual fallback visible`,host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Agent MCP configuration"]')!.checkVisibility());
 }
 flushSync(()=>button("Copy configuration").click());await wait(()=>Boolean(button("Copied")));
 check("copy complete configuration",(window as unknown as {fixtureClipboard:string}).fixtureClipboard===config());
 flushSync(()=>button("Check MCP service").click());await wait(()=>Boolean(host.querySelector(".mcpCheckSuccess")));
 check("direct HTTP handshake",host.querySelector(".mcpCheckSuccess")!.textContent!.includes("tools discovered"));
 const before=await readWorkbenchSnapshot("demo");check("real Demo capture",before.context.sample_count==="10048"&&before.context.sample_rate_hz==="1000000");
 const result=await request("mark");check("direct HTTP exact sample",result.sample==="5"&&result.time_us==="5");
 const snapshot=await readWorkbenchSnapshot("demo");check("shared document marker",snapshot.annotations.some((a)=>a.kind==="timing_point"&&a.sample==="5"&&a.title==="MCP test"));
 const renderMarkers=(s:WorkbenchSnapshot)=>{const markers=timingMarkersFromWorkbench(s.annotations,[]);flushSync(()=>root.render(<div style={{position:"relative",width:800,height:420}}>
 <div className="waveformCanvasHost" style={{position:"absolute",top:0,width:800,height:180}} />
 <TimingMarkersOverlay markers={markers} editToken={workbenchEditToken(s)} busy={false} onChangeMarkers={()=>{}} onChangePlacement={()=>{}} onMessage={()=>{}} onAddSingleMarker={()=>{}} onOpenSidebar={()=>{}} onViewportChange={()=>{}} placement={null} viewportInteracting={false} sampleRateHz={1_000_000} rowHeights={[180]} sessionId={s.context.session_id} tile={null} totalSamples={Number(s.context.sample_count)} viewportSamples={20} viewportStart={0}/>
 <div style={{position:"absolute",top:200,width:320}}><TimingMarkersPanel markers={markers} editToken={workbenchEditToken(s)} canUndo={false} onUndo={()=>{}} busy={false} hasCapture={true} onAddMarkerPair={()=>{}} onAddSingleMarker={()=>{}} onChangeMarkers={()=>{}} onMessage={()=>{}} onViewportChange={()=>{}} placementActive={false} sampleRateHz={1_000_000} totalSamples={Number(s.context.sample_count)} viewportSamples={20}/></div></div>));};
 renderMarkers(snapshot);await settle();await settle();
 check("actual waveform marker component",host.querySelectorAll(".timingGraphMarker").length===1 && host.textContent!.includes("MCP test"));
 check("sample 5 projects to 25 percent at 5 microseconds",host.querySelector<HTMLElement>(".timingGraphMarker")?.style.left==="25%" && host.textContent!.includes("5 µs"));
 const saved=await request("reopen");check("Demo source persisted",saved.source_device==="fake:sigpilot-demo");
 const reopened=await readWorkbenchSnapshot("reopened");check("marker survived .pxl save/reopen",reopened.annotations.some((a)=>a.sample==="5"&&a.title==="MCP test"));
 renderMarkers(reopened);await settle();check("reopened marker visible",host.querySelectorAll(".timingGraphMarker").length===1);
 flushSync(()=>root.render(<div className="sidebarPanelContent" style={{width:320,height:760}}><McpSettingsPanel /></div>));await wait(()=>Boolean(button("Disable MCP")&&!button("Disable MCP").disabled));
 flushSync(()=>button("Disable MCP").click());await wait(()=>Boolean(button("Enable MCP")&&!button("Enable MCP").disabled));
 check("disabling revokes self check",button("Check MCP service").disabled&&button("Copy command").disabled&&!host.querySelector(".mcpCheckSuccess"));
 flushSync(()=>button("Enable MCP").click());await wait(()=>Boolean(button("Disable MCP")&&!button("Disable MCP").disabled));
 check("registration command survives restart",host.querySelector<HTMLTextAreaElement>(".mcpCommand")!.value===initialCommand);
 flushSync(()=>button("Check MCP service").click());await wait(()=>Boolean(host.querySelector(".mcpCheckSuccess")));
 check("new instance reconnects",true);
 await i18n.changeLanguage("zh-CN");await settle();
 check("Chinese instructions and command agree",host.textContent!.includes("复制接入命令")&&host.querySelector<HTMLTextAreaElement>(".mcpCommand")!.value===initialCommand);
 return {passed:failures.length===0,checks,failures,source:"fake:sigpilot-demo",sample:"5",time_us:"5",saved_and_reopened:true};
}
