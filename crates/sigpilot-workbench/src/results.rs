//! Explicit immutable retained results. Runtime job ownership is checked when
//! retaining; saved results become shared project data and never resume jobs.
use crate::{
    evidence::EvidenceVerification, jobs::JobOutput, Caller, CaptureRef, Document, Result,
    WorkbenchError, WorkbenchEvent, WorkbenchService,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sigpilot_analysis::{frames::FrameQuery, ExactU64};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{atomic::AtomicBool, Arc},
    time::Instant,
};
const MAX_RESULTS: usize = 16;
const MAX_RESULT_BYTES: usize = 4 * 1024 * 1024;
const MAX_DOCUMENT_BYTES: usize = 8 * 1024 * 1024;
const MAX_REPLAY_BYTES: usize = 256 * 1024;
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RetainedResult {
    pub schema_version: String,
    pub result_set_id: String,
    pub origin_result_set_id: String,
    pub capture: CaptureRef,
    pub origin_capture: CaptureRef,
    pub capture_sample_count: ExactU64,
    pub sample_rate_hz: ExactU64,
    pub author_id: String,
    pub source: crate::AnnotationSource,
    pub verification: EvidenceVerification,
    pub output: Arc<JobOutput>,
}
pub(crate) struct StoredResult {
    pub result: RetainedResult,
    bytes: usize,
}
impl StoredResult {
    fn new(result: RetainedResult) -> Result<Arc<Self>> {
        let bytes = serde_json::to_vec(&result)?.len();
        if bytes > MAX_RESULT_BYTES {
            return Err(WorkbenchError::ResourceLimit(
                "retained result exceeds 4 MiB",
            ));
        }
        Ok(Arc::new(Self { result, bytes }))
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
pub enum ResultOperation {
    Retain { job_id: String },
    Delete { result_set_id: String },
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ApplyResultRequest {
    pub capture: CaptureRef,
    pub expected_result_revision: ExactU64,
    pub request_id: String,
    #[serde(default)]
    pub preview: bool,
    pub operation: ResultOperation,
}
pub(crate) struct Replay {
    owner: String,
    id: String,
    input: String,
    output: Value,
    created: Instant,
    bytes: usize,
}
fn bytes(d: &Document) -> usize {
    d.results.values().map(|s| s.bytes).sum::<usize>()
        + serde_json::to_vec(&d.opaque_results).map_or(MAX_DOCUMENT_BYTES + 1, |v| v.len())
}
fn summary(r: &RetainedResult) -> Value {
    json!({"result_set_id":r.result_set_id,"capture":r.capture,"origin_capture":r.origin_capture,"author_id":r.author_id,"source":r.source,
        "capture_sample_count":r.capture_sample_count,"sample_rate_hz":r.sample_rate_hz,"verification":r.verification,
        "origin_result_set_id":r.origin_result_set_id,"bound_to_current_capture":r.verification!=EvidenceVerification::ArchivedOriginalCapture,
        "output":match r.output.as_ref() {JobOutput::Decode(_)=>r.output.summary(&r.result_set_id),JobOutput::Analysis(_)=>json!({"kind":"analysis","complete":true})}})
}
impl WorkbenchService {
    pub fn result_capabilities(&self) -> Value {
        json!({"schema_version":"1","model":"explicit_immutable_complete_job_snapshots","max_results":MAX_RESULTS,"max_result_bytes":MAX_RESULT_BYTES.to_string(),
        "max_document_bytes":MAX_DOCUMENT_BYTES.to_string(),"persistence":"pxl_project_save","reopen":"shared_saved_not_recomputed","trim":"archive_original_coordinates","unknown_schemas":"preserved_opaque",
        "restore_jobs":false,"replay_retention_seconds":"900","file_write":false})
    }
    pub fn apply_result(&self, caller: Caller<'_>, request: &ApplyResultRequest) -> Result<Value> {
        crate::validate_id(caller.id)?;
        crate::validate_id(&request.request_id)?;
        let input = serde_json::to_string(request)?;
        if input.len() > 16 * 1024 {
            return Err(WorkbenchError::ResourceLimit("result mutation input"));
        }
        let session = self.existing_session(&request.capture.session_id)?;
        let _operation = session.operation.lock();
        let lease = self.lease(&session, &request.capture)?;
        let mut d = session.document.lock();
        crate::synchronize(&mut d, lease.snapshot().capture_generation);
        d.result_replay
            .retain(|r| r.created.elapsed().as_secs() < 900);
        if !request.preview {
            if let Some(r) = d
                .result_replay
                .iter()
                .find(|r| r.owner == caller.id && r.id == request.request_id)
            {
                return if r.input == input {
                    Ok(r.output.clone())
                } else {
                    Err(WorkbenchError::RequestIdConflict)
                };
            }
        }
        if d.result_revision != request.expected_result_revision.0 {
            return Err(WorkbenchError::ResultVersionConflict(d.result_revision));
        }
        let (upsert, deleted) = match &request.operation {
            ResultOperation::Retain { job_id } => {
                let (capture, output) = self.jobs.output(caller.id, job_id)?;
                if capture != request.capture {
                    return Err(WorkbenchError::CaptureVersionConflict);
                }
                let stored = StoredResult::new(RetainedResult {
                    schema_version: "1".into(),
                    result_set_id: job_id.clone(),
                    origin_result_set_id: job_id.clone(),
                    capture: capture.clone(),
                    origin_capture: capture,
                    capture_sample_count: lease.snapshot().metadata.sample_count.into(),
                    sample_rate_hz: lease.snapshot().metadata.sample_rate_hz.into(),
                    author_id: caller.id.into(),
                    source: caller.source,
                    verification: EvidenceVerification::RuntimeComputed,
                    output,
                })?;
                validate(&stored.result, lease.snapshot())?;
                if d.results.contains_key(job_id) {
                    return Err(WorkbenchError::InvalidRequest(
                        "job result is already retained; read its existing snapshot".into(),
                    ));
                }
                if d.results.len() + d.opaque_results.len() >= MAX_RESULTS
                    || bytes(&d) + stored.bytes > MAX_DOCUMENT_BYTES
                {
                    return Err(WorkbenchError::ResourceLimit("retained result document"));
                }
                (Some(stored), None)
            }
            ResultOperation::Delete { result_set_id } => {
                crate::validate_id(result_set_id)?;
                if !d.results.contains_key(result_set_id) {
                    return Err(WorkbenchError::ResultNotFound);
                }
                (None, Some(result_set_id.clone()))
            }
        };
        let head = upsert.as_ref().map(|s| summary(&s.result));
        if serde_json::to_vec(&head)?.len() > 64 * 1024 {
            return Err(WorkbenchError::ResourceLimit(
                "retained result summary exceeds 64 KiB",
            ));
        }
        if request.preview {
            return Ok(
                json!({"capture":request.capture,"result_revision":d.result_revision.to_string(),"preview":true,"upsert":head,"deleted_id":deleted}),
            );
        }
        let revision = d
            .result_revision
            .checked_add(1)
            .ok_or(WorkbenchError::ResourceLimit("result revision overflow"))?;
        if let Some(stored) = upsert {
            d.results
                .insert(stored.result.result_set_id.clone(), stored);
        }
        if let Some(id) = &deleted {
            d.results.remove(id);
        }
        d.result_revision = revision;
        let output = json!({"capture":request.capture,"result_revision":revision.to_string(),"request_id":request.request_id,"upsert":head,"deleted_id":deleted});
        let size = input.len() + output.to_string().len();
        while d.result_replay.len() >= 128
            || d.result_replay.iter().map(|r| r.bytes).sum::<usize>() + size > MAX_REPLAY_BYTES
        {
            d.result_replay.pop_front();
        }
        d.result_replay.push_back(Replay {
            owner: caller.id.into(),
            id: request.request_id.clone(),
            input,
            output: output.clone(),
            bytes: size,
            created: Instant::now(),
        });
        drop(d);
        drop(lease);
        drop(_operation);
        self.publish(WorkbenchEvent::ResultsChanged {
            capture: request.capture.clone(),
            result_revision: revision.into(),
        });
        Ok(output)
    }
    pub fn list_results(
        &self,
        capture: &CaptureRef,
        revision: u64,
        after: Option<&str>,
        limit: usize,
    ) -> Result<Value> {
        if limit == 0 || limit > 16 {
            return Err(WorkbenchError::InvalidRequest(
                "result directory limit must be 1..16".into(),
            ));
        }
        let session = self.existing_session(&capture.session_id)?;
        let lease = self.lease(&session, capture)?;
        let mut d = session.document.lock();
        crate::synchronize(&mut d, lease.snapshot().capture_generation);
        if revision != d.result_revision {
            return Err(WorkbenchError::ResultVersionConflict(d.result_revision));
        }
        if after.is_some_and(|id| !d.results.contains_key(id)) {
            return Err(WorkbenchError::InvalidRequest(
                "unknown result continuation".into(),
            ));
        }
        let mut items = Vec::new();
        let mut truncated = false;
        for (id, s) in d
            .results
            .iter()
            .filter(|(id, _)| after.is_none_or(|a| id.as_str() > a))
        {
            if items.len() == limit {
                truncated = true;
                break;
            }
            let head = json!({"result_set_id":id,"kind":if matches!(s.result.output.as_ref(),JobOutput::Decode(_)){"decode"}else{"analysis"},"verification":s.result.verification,
                "origin_capture":s.result.origin_capture,"bound_to_current_capture":s.result.verification!=EvidenceVerification::ArchivedOriginalCapture,"bytes":s.bytes.to_string()});
            items.push(head);
        }
        Ok(
            json!({"capture":capture,"result_revision":revision.to_string(),"next_after_id":if truncated {items.last().map(|v|v["result_set_id"].clone())}else{None},
            "items":items,"complete":!truncated,"opaque_result_count":d.opaque_results.len().to_string()}),
        )
    }
    pub fn retained_result(&self, capture: &CaptureRef, id: &str) -> Result<Value> {
        let session = self.existing_session(&capture.session_id)?;
        let lease = self.lease(&session, capture)?;
        let mut d = session.document.lock();
        crate::synchronize(&mut d, lease.snapshot().capture_generation);
        let stored = d.results.get(id).ok_or(WorkbenchError::ResultNotFound)?;
        let summary = summary(&stored.result);
        if serde_json::to_vec(&summary)?.len() > 112 * 1024 {
            return Err(WorkbenchError::ResourceLimit(
                "retained summary exceeds page budget",
            ));
        }
        Ok(summary)
    }
    pub fn read_result_chunk(
        &self,
        capture: &CaptureRef,
        id: &str,
        offset: u64,
        max_bytes: usize,
        cancel: &AtomicBool,
    ) -> Result<Value> {
        crate::check_cancelled(cancel)?;
        if !(128..=32768).contains(&max_bytes) {
            return Err(invalid("result chunks require max_bytes 128..32768"));
        }
        let session = self.existing_session(&capture.session_id)?;
        let lease = self.lease(&session, capture)?;
        let mut d = session.document.lock();
        crate::synchronize(&mut d, lease.snapshot().capture_generation);
        let stored = d
            .results
            .get(id)
            .cloned()
            .ok_or(WorkbenchError::ResultNotFound)?;
        drop(d);
        drop(lease);
        let content = serde_json::to_string(&stored.result.output)?;
        let start = usize::try_from(offset).map_err(|_| invalid("result offset overflow"))?;
        if start > content.len() || !content.is_char_boundary(start) {
            return Err(invalid("result offset must be an in-range UTF-8 boundary"));
        }
        let mut end = start.saturating_add(max_bytes).min(content.len());
        while !content.is_char_boundary(end) {
            end -= 1;
        }
        crate::check_cancelled(cancel)?;
        self.validate_capture(capture)?;
        Ok(
            json!({"capture":capture,"result":summary(&stored.result),"encoding":"utf-8","mime_type":"application/json","content_scope":"immutable_original_job_payload","embedded_references":"origin_runtime_only_not_rebound","offset":offset.to_string(),"content":&content[start..end],
            "total_bytes":content.len().to_string(),"complete":end==content.len(),"next_offset":if end==content.len(){None}else{Some(end.to_string())}}),
        )
    }
    /// Runtime job IDs remain private until explicitly retained. A saved project
    /// ID is shared data, with a distinct imported/archived verification state.
    pub(crate) fn result_output(
        &self,
        owner: &str,
        id: &str,
    ) -> Result<(CaptureRef, Arc<JobOutput>)> {
        let sessions = self
            .sessions
            .read()
            .iter()
            .map(|(id, s)| (id.clone(), s.clone()))
            .collect::<Vec<_>>();
        for (session_id, session) in sessions {
            let d = session.document.lock();
            if let Some(s) = d.results.get(id) {
                let capture = s.result.capture.clone();
                let output = s.result.output.clone();
                let archived =
                    s.result.verification == EvidenceVerification::ArchivedOriginalCapture;
                drop(d);
                if archived {
                    return Err(WorkbenchError::CaptureVersionConflict);
                }
                let snapshot = session.graph.capture_snapshot()?;
                if self.reference(&session_id, &snapshot) != capture {
                    return Err(WorkbenchError::CaptureVersionConflict);
                }
                return Ok((capture, output));
            }
        }
        self.jobs.output(owner, id)
    }
    pub(crate) fn result_verification(
        &self,
        capture: &CaptureRef,
        id: &str,
    ) -> EvidenceVerification {
        self.existing_session(&capture.session_id)
            .ok()
            .and_then(|s| {
                s.document
                    .lock()
                    .results
                    .get(id)
                    .map(|r| r.result.verification)
            })
            .unwrap_or(EvidenceVerification::RuntimeComputed)
    }
}
fn invalid(message: &str) -> WorkbenchError {
    WorkbenchError::InvalidRequest(message.into())
}
fn validate(r: &RetainedResult, snapshot: &sigpilot_graph::GraphCaptureSnapshot) -> Result<()> {
    for c in [&r.capture, &r.origin_capture] {
        crate::validate_id(&c.session_id)?;
        crate::validate_id(&c.capture_id)?;
    }
    crate::validate_id(&r.result_set_id)?;
    crate::validate_id(&r.origin_result_set_id)?;
    crate::validate_id(&r.author_id)?;
    if r.schema_version != "1" || r.capture_sample_count.0 == 0 || r.sample_rate_hz.0 == 0 {
        return Err(invalid("invalid retained result metadata"));
    }
    let archived = r.verification == EvidenceVerification::ArchivedOriginalCapture;
    if !archived
        && (r.capture_sample_count.0 != snapshot.metadata.sample_count
            || r.sample_rate_hz.0 != snapshot.metadata.sample_rate_hz)
    {
        return Err(invalid("saved result sample metadata mismatch"));
    }
    match r.output.as_ref() {
        JobOutput::Decode(set) => {
            set.processed_range.validate(r.capture_sample_count.0)?;
            set.requested_range.validate(r.capture_sample_count.0)?;
            if set.frames.len() > 4096
                || set.field_schema.len() > 64
                || set.protocol.len() > 128
                || set.backend.len() > 128
                || set.backend_protocol.len() > 128
                || set.schema_scope.len() > 128
                || set.frames.windows(2).any(|p| {
                    (p[0].range.start_sample, p[0].frame_id)
                        > (p[1].range.start_sample, p[1].frame_id)
                })
            {
                return Err(invalid("saved decode dimensions or ordering"));
            }
            let mut ids = BTreeSet::new();
            for f in &set.frames {
                f.range.validate(r.capture_sample_count.0)?;
                let native_end = match f.native_endpoint_policy.as_str() {
                    "inclusive" => f.native_end_sample.0.checked_add(1),
                    "exclusive" => Some(f.native_end_sample.0),
                    _ => None,
                };
                if f.native_start_sample != f.range.start_sample
                    || native_end != Some(f.range.end_sample.0)
                    || f.configured_channels.iter().collect::<BTreeSet<_>>().len()
                        != f.configured_channels.len()
                {
                    return Err(invalid(
                        "saved native coordinates or channels disagree with the frame",
                    ));
                }
                if !ids.insert(f.frame_id)
                    || f.range.start_sample < set.processed_range.start_sample
                    || f.range.end_sample > set.processed_range.end_sample
                    || f.row.len() > 128
                    || f.texts.len() > 32
                    || f.texts.iter().any(|s| s.len() > 4096)
                    || f.fields.len() > 64
                    || f.configured_channels.len() > 32
                    || f.configured_channels
                        .iter()
                        .any(|c| *c >= 32 || (!archived && !crate::valid_channel(snapshot, *c)))
                {
                    return Err(invalid("invalid saved decode frame"));
                }
                for (name, value) in &f.fields {
                    if name.is_empty() || name.len() > 128 {
                        return Err(invalid("invalid saved field name"));
                    }
                    value.validate()?;
                    if !set.field_schema.iter().any(|s| {
                        s.name == *name
                            && s.types.contains(&value.kind())
                            && s.rows.contains(&f.row)
                    }) {
                        return Err(invalid("saved field differs from its declared schema"));
                    }
                }
            }
            if set
                .field_schema
                .iter()
                .map(|s| &s.name)
                .collect::<BTreeSet<_>>()
                .len()
                != set.field_schema.len()
                || set.field_schema.iter().any(|s| {
                    s.name.is_empty()
                        || s.name.len() > 128
                        || s.types.is_empty()
                        || s.rows.len() > 32
                        || s.rows.iter().any(|r| r.len() > 128)
                })
            {
                return Err(invalid("invalid saved field schema"));
            }
            FrameQuery::default().validate(set)?;
        }
        JobOutput::Analysis(v) => {
            if !v.is_object() || !(v["complete"] == true || v["simulation"]["complete"] == true) {
                return Err(invalid(
                    "only complete analysis job outputs can be retained",
                ));
            }
        }
    }
    Ok(())
}
pub(crate) fn restore(
    values: &[Value],
    capture: &CaptureRef,
    snapshot: &sigpilot_graph::GraphCaptureSnapshot,
) -> Result<(BTreeMap<String, Arc<StoredResult>>, Vec<Value>)> {
    if values.len() > MAX_RESULTS || serde_json::to_vec(values)?.len() > MAX_DOCUMENT_BYTES {
        return Err(WorkbenchError::ResourceLimit("saved result document"));
    }
    let mut results = BTreeMap::new();
    let mut opaque = Vec::new();
    for value in values {
        if serde_json::to_vec(value)?.len() > MAX_RESULT_BYTES {
            return Err(WorkbenchError::ResourceLimit("saved result exceeds 4 MiB"));
        }
        if value["schema_version"] != "1" {
            opaque.push(value.clone());
            continue;
        }
        let mut result: RetainedResult = serde_json::from_value(value.clone())?;
        validate(&result, snapshot)?;
        if result.verification != EvidenceVerification::ArchivedOriginalCapture {
            result.capture = capture.clone();
            result.verification = EvidenceVerification::ImportedSavedNotRecomputed;
        }
        if results.values().any(|s: &Arc<StoredResult>| {
            s.result.origin_result_set_id == result.origin_result_set_id
        }) {
            return Err(invalid("duplicate saved result ID"));
        }
        result.result_set_id = format!("result-{}", uuid::Uuid::new_v4().simple());
        let stored = StoredResult::new(result)?;
        results.insert(stored.result.result_set_id.clone(), stored);
    }
    Ok((results, opaque))
}
pub(crate) fn project_values(d: &Document, archive: bool) -> Result<Vec<Value>> {
    let mut values = d
        .results
        .values()
        .map(|s| {
            let mut r = s.result.clone();
            if archive {
                r.verification = EvidenceVerification::ArchivedOriginalCapture;
            }
            serde_json::to_value(r).map_err(Into::into)
        })
        .collect::<Result<Vec<_>>>()?;
    values.extend(d.opaque_results.iter().map(|v| {
        if archive && v["schema_version"] != "opaque_archive_v1" {
            json!({"schema_version":"opaque_archive_v1","reason":"capture_trimmed","original":v})
        } else {
            v.clone()
        }
    }));
    if serde_json::to_vec(&values)?.len() > MAX_DOCUMENT_BYTES
        || values
            .iter()
            .any(|v| serde_json::to_vec(v).map_or(true, |b| b.len() > MAX_RESULT_BYTES))
    {
        return Err(WorkbenchError::ResourceLimit("result project values"));
    }
    Ok(values)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::jobs::JobState;
    use sigpilot_analysis::{
        frames::{FieldSchema, FieldType, FieldValue, FrameSet, ProtocolFrame},
        SampleRange,
    };
    fn caller() -> Caller<'static> {
        Caller {
            id: "owner",
            source: crate::AnnotationSource::Assistant,
        }
    }
    fn decoded(service: &WorkbenchService) -> String {
        let capture = service.context("session-a").unwrap().capture;
        let range = SampleRange::new(0, 16, 16).unwrap();
        let output = FrameSet {
            backend: "fixture".into(),
            backend_protocol: "fixture".into(),
            protocol: "UART".into(),
            processed_range: range,
            requested_range: range,
            field_schema: vec![FieldSchema {
                name: "data".into(),
                types: BTreeSet::from([FieldType::Unsigned]),
                rows: BTreeSet::from(["data".into()]),
            }],
            schema_scope: "fixture".into(),
            configuration: json!({"baud_rate":"100000"}),
            frames: vec![ProtocolFrame {
                frame_id: 1.into(),
                range: SampleRange::new(2, 5, 16).unwrap(),
                row: "data".into(),
                texts: vec!["0x80".into()],
                fields: BTreeMap::from([("data".into(), FieldValue::Unsigned(128.into()))]),
                configured_channels: vec![0],
                native_start_sample: 2.into(),
                native_end_sample: 4.into(),
                native_endpoint_policy: "inclusive".into(),
            }],
            diagnostics: vec![],
        };
        let job = service
            .jobs
            .submit(
                "owner",
                capture,
                "decode",
                "retain-fixture",
                "fixture".into(),
                Box::new(|_| Ok(JobOutput::Decode(output))),
            )
            .unwrap();
        let deadline = Instant::now() + std::time::Duration::from_secs(3);
        while service.jobs.get("owner", &job.job_id).unwrap().state != JobState::Completed {
            assert!(Instant::now() < deadline);
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
        job.job_id
    }
    fn request(service: &WorkbenchService, id: &str) -> ApplyResultRequest {
        ApplyResultRequest {
            capture: service.context("session-a").unwrap().capture,
            expected_result_revision: 0.into(),
            request_id: "retain".into(),
            preview: false,
            operation: ResultOperation::Retain { job_id: id.into() },
        }
    }
    #[test]
    fn retain_is_owned_atomic_replay_safe_and_reopened_results_are_shared_saved_observations() {
        let service = crate::tests::service();
        let id = decoded(&service);
        let r = request(&service, &id);
        assert!(matches!(
            service.query_decode_frames("other", &id, FrameQuery::default(), None, 10),
            Err(WorkbenchError::JobNotFound)
        ));
        assert!(matches!(
            service.apply_result(
                Caller {
                    id: "other",
                    source: crate::AnnotationSource::Assistant
                },
                &r
            ),
            Err(WorkbenchError::JobNotFound)
        ));
        let mut preview = r.clone();
        preview.preview = true;
        service.apply_result(caller(), &preview).unwrap();
        assert_eq!(
            service
                .context("session-a")
                .unwrap()
                .retained_result_count
                .0,
            0
        );
        let result = service.apply_result(caller(), &r).unwrap();
        assert_eq!(service.apply_result(caller(), &r).unwrap(), result);
        assert!(service
            .query_decode_frames("other", &id, FrameQuery::default(), None, 10)
            .is_ok());
        assert!(matches!(
            service.apply_result(
                caller(),
                &ApplyResultRequest {
                    request_id: "new-stale".into(),
                    ..r.clone()
                }
            ),
            Err(WorkbenchError::ResultVersionConflict(1))
        ));
        let path =
            std::env::temp_dir().join(format!("sigpilot-result-{}.pxl", uuid::Uuid::new_v4()));
        service
            .save_project("session-a", &path, Default::default())
            .unwrap();
        let saved = sigpilot_file::open_pxl_bounded(&path, 1024 * 1024).unwrap();
        let reopened = WorkbenchService::default();
        let mut ids = Vec::new();
        for session_id in ["copy-a", "copy-b"] {
            let c = reopened
                .import_capture(session_id, saved.capture.clone())
                .unwrap()
                .capture;
            reopened
                .restore_annotations(session_id, &saved.session)
                .unwrap();
            let listed = reopened.list_results(&c, 0, None, 16).unwrap();
            let new_id = listed["items"][0]["result_set_id"].as_str().unwrap();
            ids.push(new_id.to_string());
            assert_ne!(new_id, id);
            let found = reopened
                .query_decode_frames("new-assistant", new_id, FrameQuery::default(), None, 10)
                .unwrap();
            assert_eq!(found["capture"], json!(c));
            assert_eq!(found["items"][0]["fields"]["data"]["value"], "128");
            let proof = reopened
                .get_evidence(
                    &c,
                    &[found["items"][0]["evidence_ref"].as_str().unwrap().into()],
                    0.into(),
                )
                .unwrap();
            assert_eq!(
                proof["evidence"][0]["verification"],
                "imported_saved_not_recomputed"
            );
            assert!(matches!(
                reopened.jobs.get("owner", new_id),
                Err(WorkbenchError::JobNotFound)
            ));
            let mut content = String::new();
            let mut offset = 0;
            loop {
                let page = reopened
                    .read_result_chunk(&c, new_id, offset, 128, &AtomicBool::new(false))
                    .unwrap();
                content.push_str(page["content"].as_str().unwrap());
                if page["complete"] == true {
                    break;
                }
                offset = page["next_offset"].as_str().unwrap().parse().unwrap();
            }
            assert_eq!(
                serde_json::from_str::<Value>(&content).unwrap()["data"]["frames"][0]["fields"]
                    ["data"]["value"],
                "128"
            );
        }
        assert_ne!(ids[0], ids[1]);
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn imported_native_coordinates_schema_and_duplicate_channels_are_rejected_atomically() {
        let service = crate::tests::service();
        let id = decoded(&service);
        service
            .apply_result(caller(), &request(&service, &id))
            .unwrap();
        let capture = service.context("session-a").unwrap().capture;
        let metadata = service
            .project_metadata(&capture, Default::default())
            .unwrap();
        for case in 0..4 {
            let mut bad = metadata.clone();
            let data = &mut bad.workbench_results[0]["output"]["data"];
            match case {
                0 => data["frames"][0]["native_end_sample"] = json!("999"),
                1 => data["frames"][0]["native_endpoint_policy"] = json!("unknown"),
                2 => data["frames"][0]["configured_channels"] = json!([0, 0]),
                _ => {
                    let duplicate = data["field_schema"][0].clone();
                    data["field_schema"].as_array_mut().unwrap().push(duplicate);
                }
            }
            let imported = crate::tests::service();
            assert!(imported.restore_annotations("session-a", &bad).is_err());
            assert_eq!(
                imported
                    .context("session-a")
                    .unwrap()
                    .retained_result_count
                    .0,
                0
            );
        }
    }
    #[test]
    fn crop_archives_original_results_unknown_versions_are_preserved_and_invalid_restore_is_atomic()
    {
        let service = crate::tests::service();
        let id = decoded(&service);
        service
            .apply_result(caller(), &request(&service, &id))
            .unwrap();
        let capture = service.context("session-a").unwrap().capture;
        let mut metadata = service
            .project_metadata(&capture, Default::default())
            .unwrap();
        let opaque = json!({"schema_version":"9","future":"kept"});
        metadata.workbench_results.push(opaque.clone());
        let mut invalid = metadata.clone();
        invalid.workbench_results[0]["output"]["data"]["frames"][0]["range"]["end_sample"] =
            json!("999");
        let imported = crate::tests::service();
        assert!(imported.restore_annotations("session-a", &invalid).is_err());
        assert_eq!(
            imported
                .context("session-a")
                .unwrap()
                .retained_result_count
                .0,
            0
        );
        imported
            .restore_annotations("session-a", &metadata)
            .unwrap();
        imported.trim_capture("session-a", 1, 10).unwrap();
        let service = imported;
        let c = service.context("session-a").unwrap().capture;
        let listed = service.list_results(&c, 0, None, 16).unwrap();
        let archived = listed["items"][0]["result_set_id"].as_str().unwrap();
        assert_eq!(listed["items"][0]["bound_to_current_capture"], false);
        assert!(matches!(
            service.query_decode_frames("owner", archived, FrameQuery::default(), None, 10),
            Err(WorkbenchError::CaptureVersionConflict)
        ));
        let values = service
            .project_metadata(&c, Default::default())
            .unwrap()
            .workbench_results;
        assert!(values
            .iter()
            .any(|v| v["schema_version"] == "opaque_archive_v1" && v["original"] == opaque));
        assert_eq!(
            values[0]["output"]["data"]["frames"][0]["range"]["start_sample"],
            "2"
        );
    }
}
