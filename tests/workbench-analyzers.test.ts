import assert from "node:assert/strict";
import test from "node:test";
import { createAnalyzerInstance, saleaeAnalyzerMetadata } from "../src/lib/analyzers.ts";
import { analyzerMetadataList, analyzersFromWorkbench, mergeAnalyzerSnapshot, sameAnalyzerSettings } from "../src/lib/workbenchAnalyzers.ts";
import type { WorkbenchSnapshot } from "../src/lib/workbench.ts";

function fixture() {
  const instance=createAnalyzerInstance("Async Serial",[],0,"saleae_native");
  instance.configurationValid=true;instance.id="uart";instance.decodedFrameCount=17;
  const metadata=saleaeAnalyzerMetadata(instance,[instance]);
  const snapshot:WorkbenchSnapshot={context:{session_id:"s",capture_id:"c",data_revision:"1",finalized:true,sample_rate_hz:"1000000",sample_count:"20",channel_count:1,
    enabled_channels:[0],annotation_revision:"0",annotation_count:"0",gui_attached:true,config_revision:"1",analyzers_initialized:true},annotations:[],
    analyzers:[{schema_version:"1",id:instance.id,source:"assistant",author_id:"assistant",metadata}]};
  return {instance,snapshot};
}
test("unchanged shared settings keep caches despite object key order",()=>{
  const {instance,snapshot}=fixture();
  const metadata=snapshot.analyzers![0].metadata;
  snapshot.analyzers![0].metadata=Object.fromEntries(Object.entries(metadata).reverse()) as typeof metadata;
  assert.equal(analyzersFromWorkbench(snapshot,[instance])[0],instance);
  assert(sameAnalyzerSettings([instance],[{...instance,decodedFrameCount:99,highlightedFrameIndex:2}]));
});
test("changed settings keep stable IDs and invalidate old decoded data",()=>{
  const {instance,snapshot}=fixture();
  const settings=snapshot.analyzers![0].metadata.decode_settings!;
  assert.equal(settings.protocol,"Uart");if(settings.protocol!=="Uart")throw new Error("fixture");settings.settings.baud_rate=57600;
  const updated=analyzersFromWorkbench(snapshot,[instance]);
  assert.equal(updated[0].id,"uart");assert.equal(updated[0].baudRate,57600);assert.equal(updated[0].decodedFrameCount,0);
  assert(!sameAnalyzerSettings(updated,[instance]));
  assert.equal((analyzerMetadataList(updated)[0].saleae_metadata as {uiAnalyzerId:string}).uiAnalyzerId,"uart");
});
test("authoritative order and deletion apply while uninitialized captures keep local presets",()=>{
  const {instance,snapshot}=fixture();
  const second={...instance,id:"second",name:"second"};
  snapshot.analyzers!.unshift({...snapshot.analyzers![0],id:"second",metadata:saleaeAnalyzerMetadata(second,[second,instance])});
  assert.deepEqual(analyzersFromWorkbench(snapshot,[instance,second]).map(a=>a.id),["second","uart"]);
  snapshot.analyzers=[];assert.deepEqual(analyzersFromWorkbench(snapshot,[instance]),[]);
  snapshot.context.analyzers_initialized=false;assert.equal(analyzersFromWorkbench(snapshot,[instance])[0],instance);
});
test("saving config preserves later marker changes and ignores an older config response",()=>{
  const {snapshot}=fixture();
  const previous={...snapshot,context:{...snapshot.context,annotation_revision:"2"},annotations:[{kind:"timing_point" as const,id:"point",source:"user" as const,author_id:"user",title:"point",note:"",color:"red",tags:[],evidence_refs:[],sample:"5"}]};
  const incoming={...snapshot,context:{...snapshot.context,config_revision:"2"}};
  const merged=mergeAnalyzerSnapshot(previous,incoming);
  assert.equal(merged.context.config_revision,"2");assert.equal(merged.context.annotation_revision,"2");assert.equal(merged.annotations,previous.annotations);
  assert.equal(mergeAnalyzerSnapshot(merged,snapshot),merged);
});
