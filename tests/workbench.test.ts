import assert from "node:assert/strict";
import test from "node:test";
import { applyWorkbenchResult, exactUiSample, waveformAnnotationFromWorkbench, waveformAnnotationInput, timingMarkersFromWorkbench, timingMarkerOperations, timingMarkerInput, workbenchEditToken, type WorkbenchAnnotation, type WorkbenchSnapshot } from "../src/lib/workbench.ts";

const annotation: WorkbenchAnnotation = { id: "a", kind: "channel_annotation", source: "assistant", author_id: "assistant", sample: "7", channel: 0,
  title: "short pulse", note: "", shape: "warning", color: "#ffc44d", tags: ["pulse"], evidence_refs: [] };
const snapshot: WorkbenchSnapshot = { context: { session_id: "s", capture_id: "c", data_revision: "1", finalized: true,
  sample_rate_hz: "1000000", sample_count: "20", channel_count: 1, enabled_channels: [0], annotation_revision: "1", annotation_count: "1", gui_attached: true }, annotations: [annotation] };

test("exact GUI conversion rejects coordinates beyond the JavaScript safe range", () => {
  assert.equal(exactUiSample("9007199254740991"), Number.MAX_SAFE_INTEGER);
  assert.throws(() => exactUiSample("9007199254740993"), /UI_PRECISION_LIMIT/);
  assert.throws(() => exactUiSample("07"), /Invalid/);
});

test("events preserve other annotations, ignore stale captures, and require snapshots for gaps", () => {
  const result = { capture: snapshot.context, annotation_revision: "2", request_id: "r", preview: false, upserts: [{ ...annotation, id: "b", sample: "9" }], deleted_ids: [] };
  const updated = applyWorkbenchResult(snapshot, result)!;
  assert.deepEqual(updated.annotations.map((a) => a.id), ["a", "b"]);
  assert.equal(applyWorkbenchResult(updated, result), updated);
  assert.equal(applyWorkbenchResult(snapshot, { ...result, annotation_revision: "4" }), null);
  assert.equal(applyWorkbenchResult(snapshot, { ...result, capture: { ...snapshot.context, capture_id: "old" } }), snapshot);
});

test("GUI edits preserve provider tags and exact sample positions", () => {
  const ui = waveformAnnotationFromWorkbench(annotation);
  assert.equal(ui.source, "assistant");
  const input = waveformAnnotationInput({ ...ui, sample: 9 }, annotation);
  assert.equal(input.sample, "9");
  assert.deepEqual(input.tags, ["pulse"]);
});

test("moving a marker detaches its evidence anchor while a text edit keeps it", () => {
  const bound = { ...annotation, evidence_refs: ["evidence-a"] };
  const ui = waveformAnnotationFromWorkbench(bound);
  assert.deepEqual(waveformAnnotationInput({ ...ui, title: "edited" }, bound).evidence_refs, ["evidence-a"]);
  assert.deepEqual(waveformAnnotationInput({ ...ui, sample: 9 }, bound).evidence_refs, []);
  assert.deepEqual(waveformAnnotationInput({ ...ui, channel: 1 }, bound).evidence_refs, []);
});

test("timing projections preserve UI state, exact custom colors and capture trigger without editing other kinds", () => {
  const point:WorkbenchAnnotation={...annotation,id:"point",kind:"timing_point",channel:undefined,shape:undefined,color:"#123456"};
  const pair:WorkbenchAnnotation={...point,id:"pair",kind:"timing_pair",end_sample:"7"};
  const doc={...snapshot,annotations:[annotation,point,pair]};
  const trigger={id:"capture-trigger",type:"single" as const,isCaptureTrigger:true,sample:0,label:"Trigger",note:"",color:"orange2" as const,selected:false,isExpanded:false,graphPopupOpen:null};
  const markers=timingMarkersFromWorkbench(doc.annotations,[trigger]);
  assert.equal(markers[0].color,"#123456");assert.equal(markers[1].endSample,7);
  assert.deepEqual(timingMarkerOperations(doc,markers.map((m)=>({...m,selected:true,isExpanded:true}))),[]);
  assert.deepEqual(timingMarkerOperations(doc,[trigger]),[{op:"delete",id:"point"},{op:"delete",id:"pair"}]);
  assert.equal(timingMarkersFromWorkbench([],markers)[0],trigger);
  assert.equal(workbenchEditToken(doc),"c/1/1");
});

test("moving either pair endpoint detaches evidence and user undo availability follows the committing actor", () => {
  const pair:WorkbenchAnnotation={...annotation,kind:"timing_pair",channel:undefined,end_sample:"10",evidence_refs:["e"]};
  const marker=timingMarkersFromWorkbench([pair],[])[0];
  assert.deepEqual(timingMarkerInput({...marker,note:"edit"},pair).evidence_refs,["e"]);
  assert.deepEqual(timingMarkerInput({...marker,endSample:11},pair).evidence_refs,[]);
  const result={capture:snapshot.context,annotation_revision:"2",request_id:"r",actor_id:"desktop-user",batch_id:"batch",preview:false,upserts:[],deleted_ids:["a"]};
  assert.equal(applyWorkbenchResult(snapshot,result)?.undo_batch_id,"batch");
  assert.equal(applyWorkbenchResult(snapshot,{...result,actor_id:"assistant"})?.undo_batch_id,null);
});

test("annotation events retain the independent shared analyzer snapshot",()=>{
  const doc={...snapshot,analyzers:[],context:{...snapshot.context,config_revision:"7",analyzers_initialized:true}};
  const result={capture:snapshot.context,annotation_revision:"2",request_id:"r",preview:false,upserts:[],deleted_ids:[]};
  const updated=applyWorkbenchResult(doc,result)!;
  assert.equal(updated.context.config_revision,"7");assert.equal(updated.analyzers,doc.analyzers);
});
