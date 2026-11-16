import { createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { AnalyzerSettingsDialog } from "../../src/components/AnalyzerSettingsDialog";
import { analyzersFromWorkbench, commitWorkbenchAnalyzers, mergeAnalyzerSnapshot } from "../../src/lib/workbenchAnalyzers";
import { readWorkbenchSnapshot, type WorkbenchSnapshot } from "../../src/lib/workbench";
import type { UiAnalyzerInstance } from "../../src/lib/analyzers";

export async function runChecks() {
  const failures:string[]=[];let checks=0;
  const check=(name:string,condition:boolean)=>{checks++;if(!condition)failures.push(name);};
  const settle=()=>new Promise<void>(resolve=>setTimeout(resolve,0));
  const snapshot=await readWorkbenchSnapshot("gui-fixture");
  const initial=analyzersFromWorkbench(snapshot,[]);initial[0].decodedFrameCount=17;
  let current:{snapshot:WorkbenchSnapshot;analyzers:UiAnalyzerInstance[];editor:{analyzer:UiAnalyzerInstance;snapshot:WorkbenchSnapshot}|null;message:string}=
    {snapshot,analyzers:initial,editor:{analyzer:{...initial[0]},snapshot},message:""};
  let replace:(next:typeof current)=>void=()=>{};let mutation:Promise<void>|null=null;let attempts=0;let saves=0;
  function Probe() {
    const [state,setState]=useState(current);current=state;replace=setState;
    const save=(analyzer:UiAnalyzerInstance)=>{attempts++;mutation=(async()=>{
      try {
        const saved=await commitWorkbenchAnalyzers(current.editor!.snapshot,current.analyzers.map(a=>a.id===analyzer.id?analyzer:a));
        const merged=mergeAnalyzerSnapshot(current.snapshot,saved);saves++;
        setState({...current,snapshot:merged,analyzers:analyzersFromWorkbench(merged,current.analyzers),editor:null,message:"saved"});
      } catch(error) {
        const fresh=await readWorkbenchSnapshot("gui-fixture");
        setState({...current,snapshot:fresh,analyzers:analyzersFromWorkbench(fresh,current.analyzers),message:String(error)});
      }
    })();};
    return state.editor?createElement(AnalyzerSettingsDialog,{analyzer:state.editor.analyzer,capturedChannelCount:2,channelEnabled:[true,true],channelLabels:["D0","D1"],
      onCancel:()=>setState({...current,editor:null}),onSave:save}):createElement("p",null,state.message);
  }
  const host=document.getElementById("host")!;const root=createRoot(host);flushSync(()=>root.render(createElement(Probe)));await settle();
  const rate=()=>host.querySelector<HTMLInputElement>('input[type="number"]')!;
  const save=()=>host.querySelector<HTMLButtonElement>('.analyzerDialogFooter button.primary')!;
  const input=(value:string)=>flushSync(()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(rate(),value);rate().dispatchEvent(new Event("input",{bubbles:true}));});
  const reopen=()=>flushSync(()=>replace({...current,editor:{analyzer:{...current.analyzers[0]},snapshot:current.snapshot}}));
  const refresh=async()=>{const fresh=await readWorkbenchSnapshot("gui-fixture");flushSync(()=>replace({...current,snapshot:fresh,analyzers:analyzersFromWorkbench(fresh,current.analyzers)}));};
  const rpc=async(operation:unknown,revision:string)=>{
    const {session_id,capture_id,data_revision}=current.snapshot.context;
    const response=await fetch("/fixture/mcp",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{
      _meta:{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientInfo":{name:"gui-fixture-assistant",version:"1"},"io.modelcontextprotocol/clientCapabilities":{}},
      name:"sigpilot_configure_analyzer",arguments:{capture:{session_id,capture_id,data_revision},expected_config_revision:revision,request_id:crypto.randomUUID(),operation}}})});
    const result=await response.json();if(!response.ok || result.error || result.result?.isError)throw new Error(JSON.stringify(result));return result.result.structuredContent;
  };
  check("MCP-created configuration is visible in real dialog",rate().value==="100000" && current.analyzers[0].id==="uart");
  input("-1");check("invalid draft cannot submit",save().disabled && attempts===0);
  input("9600");flushSync(()=>save().click());await mutation;await settle();
  check("GUI save reaches shared service and closes dialog",saves===1 && !current.editor && current.snapshot.context.config_revision==="2" && current.analyzers[0].baudRate===9600);
  check("stable identity, provenance and cache invalidation",current.analyzers[0].id==="uart" && current.analyzers[0].decodedFrameCount===0 && current.snapshot.analyzers?.[0].author_id==="assistant");
  reopen();await settle();input("19200");
  await rpc({op:"update",id:"uart",name:"Assistant edit",config:{protocol:"UART",settings:{channel:0,baud_rate:"57600"}}},"2");await refresh();await settle();
  flushSync(()=>save().click());await mutation;await settle();
  check("stale dialog cannot overwrite concurrent MCP edit",saves===1 && attempts===2 && !!current.editor && current.snapshot.context.config_revision==="3" && current.analyzers[0].baudRate===57600 && current.message.includes("configuration revision"));
  flushSync(()=>replace({...current,editor:null}));reopen();await settle();input("19200");
  flushSync(()=>save().click());await mutation;await settle();
  check("reopened editor uses fresh revision",saves===2 && !current.editor && current.snapshot.context.config_revision==="4" && current.analyzers[0].baudRate===19200);
  await rpc({op:"delete",id:"uart"},"4");await refresh();
  check("MCP deletion removes the authoritative GUI instance",current.snapshot.context.config_revision==="5" && current.analyzers.length===0);
  check("analyzer edits leave annotations independent",current.snapshot.context.annotation_revision==="0" && current.snapshot.annotations.length===0);
  flushSync(()=>root.unmount());return {passed:failures.length===0,checks,failures,attempts,saves,real_shared_service:true};
}
