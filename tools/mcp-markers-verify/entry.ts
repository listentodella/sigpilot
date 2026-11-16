import { createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { TimingMarkersOverlay, TimingMarkersPanel } from "../../src/components/timingMarkers/TimingMarkers";
import { RangeAnnotationsOverlay } from "../../src/components/RangeAnnotationsOverlay";
import { timingMarkersFromWorkbench, timingMarkerOperations, workbenchEditToken, type WorkbenchSnapshot } from "../../src/lib/workbench";
import type { UiTimingMarker } from "../../src/lib/timingMarkers";
import i18n from "../../src/i18n";

export async function runChecks() {
  if (!i18n.isInitialized) await new Promise<void>((resolve) => i18n.on("initialized", () => resolve()));
  const failures:string[]=[];
  const check=(name:string,ok:boolean)=>{if(!ok)failures.push(name);};
  const settle=()=>new Promise<void>((resolve)=>setTimeout(resolve,0));
  const capture={session_id:"probe",capture_id:"c",data_revision:"1"};
  const base={source:"assistant" as const,author_id:"assistant",title:"0",note:"observed",color:"#123456",tags:[],evidence_refs:[]};
  const snapshot:WorkbenchSnapshot={context:{...capture,annotation_revision:"1",annotation_count:"3",finalized:true,sample_rate_hz:"1000000",sample_count:"20",
    channel_count:1,enabled_channels:[0],gui_attached:true},undo_batch_id:"batch",annotations:[
    {...base,id:"point",kind:"timing_point",sample:"5"},
    {...base,id:"pair",kind:"timing_pair",sample:"3",end_sample:"9",title:"1"},
    {...base,id:"range",kind:"range_annotation",sample:"3",end_sample:"20",channel:0,title:"window"},
  ]};
  const trigger:UiTimingMarker={id:"capture-trigger",isCaptureTrigger:true,type:"single",sample:2,label:"Trigger",note:"",color:"orange2",selected:false,isExpanded:false,graphPopupOpen:null};
  let current={snapshot,markers:timingMarkersFromWorkbench(snapshot.annotations,[trigger])};
  let replace:(state:typeof current)=>void=()=>{};
  let writes=0,conflicts=0,undos=0;
  let lastSample:string|undefined;
  function Probe() {
    const [state,setState]=useState(current);current=state;replace=setState;
    const change=(updater:(markers:UiTimingMarker[])=>UiTimingMarker[],token?:string)=>{
      if(token && token!==workbenchEditToken(current.snapshot)){conflicts++;return;}
      const next=updater(current.markers);
      const operations=timingMarkerOperations(current.snapshot,next);
      if(operations.length){writes++;lastSample=operations[0].op!=="delete"?operations[0].annotation.sample:undefined;}
      setState({...current,markers:next});
    };
    return createElement("div",null,
      createElement("div",{className:"waveformCanvasHost",style:{position:"absolute",inset:0,width:800,height:180}}),
      createElement(TimingMarkersOverlay,{markers:state.markers,editToken:workbenchEditToken(state.snapshot),busy:false,onChangeMarkers:change,
        onChangePlacement:()=>{},onMessage:()=>{},onAddSingleMarker:()=>{},onOpenSidebar:()=>{},onViewportChange:()=>{},placement:null,
        viewportInteracting:false,sampleRateHz:1000000,rowHeights:[180],sessionId:"probe",tile:null,totalSamples:20,viewportSamples:20,viewportStart:0}),
      createElement(RangeAnnotationsOverlay,{annotations:state.snapshot.annotations,sessionId:"probe",rowHeights:[180],rowTopInsets:[0],visibleChannelIndexes:[0],
        viewportStart:0,viewportSamples:20,busy:false,onDelete:()=>{}}),
      createElement("div",{style:{position:"absolute",top:200,width:300}},createElement(TimingMarkersPanel,{markers:state.markers,editToken:workbenchEditToken(state.snapshot),canUndo:true,onUndo:()=>{undos++;},busy:false,hasCapture:true,
        onAddMarkerPair:()=>{},onAddSingleMarker:()=>{},onChangeMarkers:change,onMessage:()=>{},onViewportChange:()=>{},placementActive:false,sampleRateHz:1000000,totalSamples:20,viewportSamples:20})));
  }
  const captured=new Set<number>();
  Object.defineProperties(Element.prototype,{setPointerCapture:{configurable:true,value:(id:number)=>captured.add(id)},
    hasPointerCapture:{configurable:true,value:(id:number)=>captured.has(id)},releasePointerCapture:{configurable:true,value:(id:number)=>captured.delete(id)}});
  const host=document.getElementById("host")!;
  const root=createRoot(host);flushSync(()=>root.render(createElement(Probe)));await settle();await settle();
  const heads=()=>[...host.querySelectorAll<HTMLElement>(".timingGraphMarker")];
  const point=()=>heads().find((n)=>n.querySelector(".timingMarkerHeadText")?.textContent==="0")!;
  const pointer=(target:HTMLElement,type:string,x:number)=>flushSync(()=>target.dispatchEvent(new PointerEvent(type,{bubbles:true,cancelable:true,clientX:x+host.getBoundingClientRect().left,clientY:30,pointerId:1,button:0})));
  check("point/pair/trigger projection",heads().length===4);
  check("custom color",point().style.getPropertyValue("--timing-marker-color")==="#123456");
  check("range boundary",host.querySelector<HTMLElement>('[data-range-end="20"]')?.style.width==="85%");
  const target=point();pointer(target,"pointerdown",200);pointer(target,"pointermove",240);
  check("drag is preview only",writes===0);
  const changed={...snapshot,context:{...snapshot.context,annotation_revision:"2"},annotations:snapshot.annotations.map((a)=>a.id==="point"?{...a,sample:"7"}:a)};
  flushSync(()=>replace({snapshot:changed,markers:timingMarkersFromWorkbench(changed.annotations,current.markers)}));
  pointer(target,"pointerup",240);check("drag retains start revision",conflicts===1 && writes===0 && current.markers.find((m)=>m.id==="point")?.sample===7);
  const fresh=point();pointer(fresh,"pointerdown",280);pointer(fresh,"pointermove",320);pointer(fresh,"pointerup",320);
  check("fresh drag commits once",writes===1 && lastSample==="8");
  const triggerHead=heads().find((n)=>n.textContent?.includes("Trigger"))!;
  pointer(triggerHead,"pointerdown",80);pointer(triggerHead,"pointermove",400);pointer(triggerHead,"pointerup",400);
  check("capture trigger is immutable",writes===1 && current.markers.find((m)=>m.isCaptureTrigger)?.sample===2);
  const undo=host.querySelector<HTMLButtonElement>('.markerAddMenu button[title]');flushSync(()=>undo?.click());
  check("undo entry",undos===1);
  flushSync(()=>root.unmount());
  return {passed:failures.length===0,checks:8,failures,writes,conflicts};
}
