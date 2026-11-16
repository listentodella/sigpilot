import { invoke } from "@tauri-apps/api/core";
import type { WaveformAnnotation, SessionView, SaleaeAnalyzerMetadata } from "./api";
import { timingMarkerExactColor, type UiTimingMarker, type TimingMarkerColor } from "./timingMarkers.ts";

export interface CaptureRef {
  session_id: string;
  capture_id: string;
  data_revision: string;
}

export interface WorkbenchContext extends CaptureRef {
  finalized: boolean;
  sample_rate_hz: string;
  sample_count: string;
  channel_count: number;
  enabled_channels: number[];
  annotation_revision: string;
  annotation_count: string;
  report_revision?: string;
  report_count?: string;
  config_revision?: string;
  analyzer_count?: string;
  analyzers_initialized?: boolean;
  result_revision?: string;
  retained_result_count?: string;
  derivation?: Record<string, unknown> | null;
  gui_attached: boolean;
}

export interface AnnotationInput {
  kind: "channel_annotation" | "timing_point" | "timing_pair" | "range_annotation";
  sample: string;
  end_sample?: string | null;
  channel?: number | null;
  title: string;
  note: string;
  shape?: WaveformAnnotation["shape"] | null;
  color: string;
  tags: string[];
  evidence_refs: string[];
}

export interface WorkbenchAnnotation extends AnnotationInput {
  id: string;
  source: "user" | "assistant" | "analysis_provider";
  author_id: string;
}

export interface WorkbenchSnapshot {
  context: WorkbenchContext;
  annotations: WorkbenchAnnotation[];
  undo_batch_id?: string | null;
  analyzers?: WorkbenchAnalyzer[];
}

export interface WorkbenchAnalyzer {
  schema_version: string;
  id: string;
  source: "user" | "assistant" | "analysis_provider";
  author_id: string;
  metadata: SaleaeAnalyzerMetadata;
}

export type AnnotationOperation =
  | { op: "create"; id: string; annotation: AnnotationInput }
  | { op: "update"; id: string; annotation: AnnotationInput }
  | { op: "delete"; id: string };

export interface AnnotationResult {
  capture: CaptureRef;
  annotation_revision: string;
  request_id: string;
  actor_id?: string;
  batch_id?: string | null;
  preview: boolean;
  upserts: WorkbenchAnnotation[];
  deleted_ids: string[];
}

export type WorkbenchEvent =
  | { kind: "results_changed"; capture: CaptureRef; result_revision: string }
  | { kind: "analyzers_changed"; capture: CaptureRef; config_revision: string }
  | { kind: "annotations_changed"; result: AnnotationResult }
  | { kind: "reports_changed"; capture: CaptureRef; report_revision: string; report_count: string }
  | { kind: "focus_requested"; capture: CaptureRef; channels: number[]; view: SessionView }
  | { kind: "session_released"; session_id: string };

export interface McpStatus {
  enabled: boolean;
  can_edit_annotations: boolean;
  instance_id: string | null;
  endpoint: string | null;
  instance_file: string | null;
}
export interface McpClientConfiguration {
  id: string; format: "json" | "toml"; content: string; location: string; docs_url: string;
  registration_command: string | null; install_uri: string | null;
}
export interface McpSetupInfo {
  status: McpStatus; bridge_path: string | null; bridge_available: boolean; connection_file: string;
  supported: boolean; auto_start_requested: boolean; configurations: McpClientConfiguration[];
  endpoint: string; port: number;
}
export interface McpConnectionCheck { ok: boolean; instance_id: string; tool_count: number; transport: string }
export function readMcpSetupInfo(): Promise<McpSetupInfo> { return invoke("mcp_setup_info"); }
export function checkMcpConnection(): Promise<McpConnectionCheck> { return invoke("check_mcp_connection"); }
export function openMcpClient(clientId: string): Promise<void> { return invoke("open_mcp_client", { clientId }); }
export interface McpAuthorizationStatus { pending: {request_id:string;client_name:string;redirect_uri:string}[]; clients:{grant_id:string;client_name:string}[] }
export function readMcpAuthorization():Promise<McpAuthorizationStatus>{return invoke("mcp_authorization_status");}
export function decideMcpAuthorization(requestId:string,allow:boolean):Promise<void>{return invoke("mcp_decide_authorization",{requestId,allow});}
export function revokeMcpAuthorization(grantId:string):Promise<void>{return invoke("mcp_revoke_authorization",{grantId});}

export function exactUiSample(value: string): number {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error("Invalid exact sample coordinate");
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new Error("UI_PRECISION_LIMIT");
  return result;
}

export function sameCapture(a: CaptureRef, b: CaptureRef): boolean {
  return a.session_id === b.session_id && a.capture_id === b.capture_id && a.data_revision === b.data_revision;
}

export function waveformAnnotationFromWorkbench(annotation: WorkbenchAnnotation): WaveformAnnotation {
  if (annotation.kind !== "channel_annotation" || annotation.channel == null) throw new Error("Expected channel annotation");
  return { id: annotation.id, sample: exactUiSample(annotation.sample), channel: annotation.channel,
    shape: annotation.shape ?? "flag", title: annotation.title, note: annotation.note, color: annotation.color, source: annotation.source };
}

export function timingMarkersFromWorkbench(annotations: WorkbenchAnnotation[], previous: UiTimingMarker[]): UiTimingMarker[] {
  const ui = new Map(previous.map((m) => [m.id, m]));
  const markers = annotations.filter((a) => a.kind === "timing_point" || a.kind === "timing_pair").map((a): UiTimingMarker => {
    const old = ui.get(a.id);
    return { id: a.id, source: a.source, type: a.kind === "timing_pair" ? "pair" : "single", sample: exactUiSample(a.sample),
      endSample: a.end_sample == null ? undefined : exactUiSample(a.end_sample), label: a.title, note: a.note,
      color: old && timingMarkerExactColor(old.color) === a.color.toLowerCase() ? old.color : a.color as TimingMarkerColor,
      selected: old?.selected ?? false, graphPopupOpen: old?.graphPopupOpen ?? null, isExpanded: old?.isExpanded ?? false };
  });
  return [...markers, ...previous.filter((m) => m.isCaptureTrigger)];
}

export function timingMarkerInput(marker: UiTimingMarker, previous?: WorkbenchAnnotation): AnnotationInput {
  const end = marker.type === "pair" ? marker.endSample ?? marker.sample : undefined;
  if (!Number.isSafeInteger(marker.sample) || marker.sample < 0 || (end != null && (!Number.isSafeInteger(end) || end < marker.sample))) throw new Error("UI_PRECISION_LIMIT");
  return { kind: marker.type === "pair" ? "timing_pair" : "timing_point", sample: String(marker.sample), end_sample: end == null ? undefined : String(end),
    title: marker.label, note: marker.note, color: timingMarkerExactColor(marker.color), tags: previous?.tags ?? [],
    evidence_refs: previous?.sample === String(marker.sample) && (previous.end_sample ?? undefined) === (end == null ? undefined : String(end)) ? previous.evidence_refs : [] };
}

/** Only timing semantics participate; other kinds and the capture trigger are untouched. */
export function timingMarkerOperations(snapshot: WorkbenchSnapshot, next: UiTimingMarker[]): AnnotationOperation[] {
  const previous = new Map(snapshot.annotations.filter((a) => a.kind === "timing_point" || a.kind === "timing_pair").map((a) => [a.id, a]));
  const operations: AnnotationOperation[] = [];
  for (const marker of next.filter((m) => !m.isCaptureTrigger)) {
    const old = previous.get(marker.id);
    const annotation = timingMarkerInput(marker, old);
    if (!old) operations.push({ op: "create", id: marker.id, annotation });
    else if (old.kind !== annotation.kind || old.sample !== annotation.sample || (old.end_sample ?? undefined) !== annotation.end_sample
      || old.title !== annotation.title || old.note !== annotation.note || old.color.toLowerCase() !== annotation.color) operations.push({ op: "update", id: marker.id, annotation });
    previous.delete(marker.id);
  }
  for (const id of previous.keys()) operations.push({ op: "delete", id });
  return operations;
}

export function waveformAnnotationInput(annotation: WaveformAnnotation, previous?: WorkbenchAnnotation): AnnotationInput {
  if (!Number.isSafeInteger(annotation.sample) || annotation.sample < 0) throw new Error("UI_PRECISION_LIMIT");
  return { kind: "channel_annotation", sample: String(annotation.sample), channel: annotation.channel,
    shape: annotation.shape, title: annotation.title, note: annotation.note, color: annotation.color,
    tags: previous?.tags ?? [], evidence_refs: previous?.sample === String(annotation.sample) && previous.channel === annotation.channel ? previous.evidence_refs : [] };
}

/** Stale events are ignored; gaps must be repaired with an authoritative snapshot. */
export function applyWorkbenchResult(snapshot: WorkbenchSnapshot, result: AnnotationResult): WorkbenchSnapshot | null {
  if (!sameCapture(snapshot.context, result.capture) || result.preview) return snapshot;
  const current = BigInt(snapshot.context.annotation_revision);
  const next = BigInt(result.annotation_revision);
  if (next <= current) return snapshot;
  if (next !== current + 1n) return null;
  const deleted = new Set(result.deleted_ids);
  const upserts = new Map(result.upserts.map((annotation) => [annotation.id, annotation]));
  const annotations = snapshot.annotations.filter((a) => !deleted.has(a.id) && !upserts.has(a.id)).concat(result.upserts);
  return { ...snapshot, context: { ...snapshot.context, annotation_revision: result.annotation_revision, annotation_count: String(annotations.length) }, annotations,
    undo_batch_id: result.actor_id === "desktop-user" ? result.batch_id : null };
}

export function workbenchEditToken(snapshot: WorkbenchSnapshot | null): string | undefined {
  return snapshot ? `${snapshot.context.capture_id}/${snapshot.context.data_revision}/${snapshot.context.annotation_revision}` : undefined;
}

export function readWorkbenchSnapshot(sessionId: string): Promise<WorkbenchSnapshot> {
  return invoke("workbench_snapshot", { sessionId });
}

export function replaceWorkbenchAnalyzers(snapshot: WorkbenchSnapshot, analyzers: SaleaeAnalyzerMetadata[]): Promise<{capture: CaptureRef; config_revision: string}> {
  const {session_id, capture_id, data_revision} = snapshot.context;
  if (snapshot.context.config_revision == null) throw new Error("Analyzer configuration snapshot unavailable");
  return invoke("workbench_replace_analyzers", {request: {capture: {session_id, capture_id, data_revision},
    expected_config_revision: snapshot.context.config_revision, request_id: crypto.randomUUID(), analyzers}});
}

export function applyWorkbenchAnnotations(snapshot: WorkbenchSnapshot, operations: AnnotationOperation[]): Promise<AnnotationResult> {
  const { session_id, capture_id, data_revision } = snapshot.context;
  return invoke("workbench_apply_annotations", { request: { capture: { session_id, capture_id, data_revision },
    expected_annotation_revision: snapshot.context.annotation_revision, request_id: crypto.randomUUID(), preview: false, operations } });
}

export function undoWorkbenchAnnotations(snapshot: WorkbenchSnapshot): Promise<AnnotationResult> {
  if (!snapshot.undo_batch_id) throw new Error("UNDO_NOT_FOUND");
  const { session_id, capture_id, data_revision } = snapshot.context;
  return invoke("workbench_undo_annotations", { request: { capture: { session_id, capture_id, data_revision },
    expected_annotation_revision: snapshot.context.annotation_revision, batch_id: snapshot.undo_batch_id, request_id: crypto.randomUUID(), preview: false } });
}

export function readMcpStatus(): Promise<McpStatus> { return invoke("mcp_status"); }
export function configureMcp(enabled: boolean, canEditAnnotations: boolean,port?:number): Promise<McpStatus> {
  return invoke("configure_mcp", { enabled, canEditAnnotations,port });
}
