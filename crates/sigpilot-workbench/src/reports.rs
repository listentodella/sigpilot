//! Immutable bundles of selected server evidence, independent of annotations.
//! Saving a project persists observations; reopening never claims recomputation.
use crate::{
    evidence::{EvidenceRecord, EvidenceVerification},
    Caller, CaptureRef, Document, Result, WorkbenchError, WorkbenchEvent, WorkbenchService,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sigpilot_analysis::ExactU64;
use sigpilot_graph::GraphCaptureSnapshot;
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
    time::{Instant, SystemTime, UNIX_EPOCH},
};

const MAX_REPORTS: usize = 32;
const MAX_REPORT_BYTES: usize = 512 * 1024;
const MAX_DOCUMENT_BYTES: usize = 4 * 1024 * 1024;
const MAX_FINDING_BYTES: usize = 96 * 1024;
const PAGE_BYTES: usize = 112 * 1024;
const REPLAY_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Report {
    pub schema_version: String,
    pub report_id: String,
    pub capture: CaptureRef,
    pub origin_capture: CaptureRef,
    pub capture_sample_count: ExactU64,
    pub sample_rate_hz: ExactU64,
    pub title: String,
    pub note: String,
    pub author_id: String,
    pub source: crate::AnnotationSource,
    pub created_unix_ms: ExactU64,
    pub verification: EvidenceVerification,
    pub findings: Vec<EvidenceRecord>,
}
pub(crate) struct StoredReport {
    pub report: Report,
    bytes: usize,
}
impl StoredReport {
    fn new(report: Report) -> Result<Arc<Self>> {
        let bytes = serde_json::to_vec(&report)?.len();
        if bytes > MAX_REPORT_BYTES {
            return Err(WorkbenchError::ResourceLimit("report exceeds 512 KiB"));
        }
        Ok(Arc::new(Self { report, bytes }))
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
pub enum ReportOperation {
    Create {
        title: String,
        #[serde(default)]
        note: String,
        evidence_refs: Vec<String>,
    },
    Delete {
        report_id: String,
    },
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ApplyReportRequest {
    pub capture: CaptureRef,
    pub expected_report_revision: ExactU64,
    pub request_id: String,
    #[serde(default)]
    pub preview: bool,
    pub operation: ReportOperation,
}
pub(crate) struct Replay {
    owner: String,
    id: String,
    input: String,
    output: Value,
    created: Instant,
    bytes: usize,
}

fn summary(report: &Report) -> Value {
    json!({"report_id":report.report_id,"schema_version":report.schema_version,"title":report.title,"note":report.note,
        "author_id":report.author_id,"source":report.source,"created_unix_ms":report.created_unix_ms,
        "capture":report.capture,"origin_capture":report.origin_capture,"capture_sample_count":report.capture_sample_count,
        "sample_rate_hz":report.sample_rate_hz,"verification":report.verification,
        "bound_to_current_capture":report.verification!=EvidenceVerification::ArchivedOriginalCapture,"finding_count":report.findings.len().to_string()})
}
fn bytes(document: &Document) -> usize {
    document.reports.values().map(|r| r.bytes).sum::<usize>()
        + document
            .opaque_reports
            .iter()
            .map(|v| serde_json::to_vec(v).map_or(MAX_DOCUMENT_BYTES + 1, |b| b.len()))
            .sum::<usize>()
}
fn invalid(message: &str) -> WorkbenchError {
    WorkbenchError::InvalidRequest(message.into())
}
fn validate_text(title: &str, note: &str) -> Result<()> {
    if title.trim().is_empty() || title.len() > 640 || note.len() > 4096 {
        return Err(invalid(
            "report requires a title <=640 bytes and a note <=4096 bytes",
        ));
    }
    Ok(())
}

impl WorkbenchService {
    pub(crate) fn report_for_export(
        &self,
        capture: &CaptureRef,
        revision: u64,
        id: &str,
    ) -> Result<Arc<StoredReport>> {
        crate::validate_id(id)?;
        let session = self.existing_session(&capture.session_id)?;
        let lease = self.lease(&session, capture)?;
        let mut document = session.document.lock();
        crate::synchronize(&mut document, lease.snapshot().capture_generation);
        if revision != document.report_revision {
            return Err(WorkbenchError::ReportVersionConflict(
                document.report_revision,
            ));
        }
        document
            .reports
            .get(id)
            .cloned()
            .ok_or(WorkbenchError::ReportNotFound)
    }
    pub fn report_capabilities(&self) -> Value {
        json!({"schema_version":"1","model":"immutable_selected_evidence_bundles","max_reports_per_capture":MAX_REPORTS,
            "max_findings_per_report":64,"max_finding_bytes":MAX_FINDING_BYTES.to_string(),"max_report_bytes":MAX_REPORT_BYTES.to_string(),
            "max_document_bytes":MAX_DOCUMENT_BYTES.to_string(),"max_page_bytes":PAGE_BYTES.to_string(),"persistence":"pxl_project_save",
            "import_verification":"imported_saved_not_recomputed","trim_policy":"archive_original_capture","unknown_schemas":"preserved_opaque",
            "write_scope":"shared_memory_document","file_write":false,"export_formats":["json","markdown"],"export_max_chunk_bytes":"32768","replay_retention_seconds":"900","max_replay_entries":128,"max_replay_bytes":REPLAY_BYTES.to_string()})
    }
    /// Single immutable creation/deletion with CAS and bounded owner-scoped replay.
    pub fn apply_report(&self, caller: Caller<'_>, request: &ApplyReportRequest) -> Result<Value> {
        crate::validate_id(caller.id)?;
        crate::validate_id(&request.request_id)?;
        let input = serde_json::to_string(request)?;
        if input.len() > 16 * 1024 {
            return Err(WorkbenchError::ResourceLimit("report input exceeds 16 KiB"));
        }
        let session = self.existing_session(&request.capture.session_id)?;
        // Cropping snapshots and archives reports before replacing the graph.
        // A concurrent write must wait and then fail its old capture identity.
        let _operation = session.operation.lock();
        let lease = self.lease(&session, &request.capture)?;
        let mut document = session.document.lock();
        crate::synchronize(&mut document, lease.snapshot().capture_generation);
        document
            .report_replay
            .retain(|r| r.created.elapsed().as_secs() < 900);
        if !request.preview {
            if let Some(replay) = document
                .report_replay
                .iter()
                .find(|r| r.owner == caller.id && r.id == request.request_id)
            {
                return if replay.input == input {
                    Ok(replay.output.clone())
                } else {
                    Err(WorkbenchError::RequestIdConflict)
                };
            }
        }
        if document.report_revision != request.expected_report_revision.0 {
            return Err(WorkbenchError::ReportVersionConflict(
                document.report_revision,
            ));
        }
        let mut deleted = None;
        let mut upsert = None;
        match &request.operation {
            ReportOperation::Create {
                title,
                note,
                evidence_refs,
            } => {
                validate_text(title, note)?;
                if evidence_refs.is_empty()
                    || evidence_refs.len() > 64
                    || evidence_refs.iter().collect::<BTreeSet<_>>().len() != evidence_refs.len()
                {
                    return Err(invalid("1..64 distinct server evidence refs required"));
                }
                let findings = evidence_refs
                    .iter()
                    .map(|id| self.resolve_evidence(&request.capture, id, &document))
                    .collect::<Result<Vec<_>>>()?;
                if findings
                    .iter()
                    .any(|f| serde_json::to_vec(f).map_or(true, |v| v.len() > MAX_FINDING_BYTES))
                {
                    return Err(WorkbenchError::ResourceLimit(
                        "individual report finding exceeds 96 KiB",
                    ));
                }
                let report = Report {
                    schema_version: "1".into(),
                    report_id: format!("report-{}", uuid::Uuid::new_v4().simple()),
                    capture: request.capture.clone(),
                    origin_capture: request.capture.clone(),
                    capture_sample_count: lease.snapshot().metadata.sample_count.into(),
                    sample_rate_hz: lease.snapshot().metadata.sample_rate_hz.into(),
                    title: title.clone(),
                    note: note.clone(),
                    author_id: caller.id.into(),
                    source: caller.source,
                    created_unix_ms: u64::try_from(
                        SystemTime::now()
                            .duration_since(UNIX_EPOCH)
                            .map_err(|_| invalid("system clock predates epoch"))?
                            .as_millis(),
                    )
                    .map_err(|_| invalid("timestamp overflow"))?
                    .into(),
                    verification: if findings
                        .iter()
                        .all(|f| f.verification == EvidenceVerification::RuntimeComputed)
                    {
                        EvidenceVerification::RuntimeComputed
                    } else {
                        EvidenceVerification::ImportedSavedNotRecomputed
                    },
                    findings,
                };
                let stored = StoredReport::new(report)?;
                if document.reports.len() + document.opaque_reports.len() >= MAX_REPORTS
                    || bytes(&document) + stored.bytes > MAX_DOCUMENT_BYTES
                {
                    return Err(WorkbenchError::ResourceLimit(
                        "report document exceeds 32 reports / 4 MiB",
                    ));
                }
                upsert = Some(stored);
            }
            ReportOperation::Delete { report_id } => {
                crate::validate_id(report_id)?;
                if !document.reports.contains_key(report_id) {
                    return Err(WorkbenchError::ReportNotFound);
                }
                deleted = Some(report_id.clone());
            }
        }
        let next = if request.preview {
            document.report_revision
        } else {
            document
                .report_revision
                .checked_add(1)
                .ok_or_else(|| invalid("report revision overflow"))?
        };
        let mut upsert_summary = upsert.as_ref().map(|r| summary(&r.report));
        if request.preview {
            if let Some(s) = &mut upsert_summary {
                s["report_id"] = Value::Null;
            }
        }
        let output = json!({"capture":request.capture,"report_revision":ExactU64(next),"request_id":request.request_id,"preview":request.preview,"upsert":upsert_summary,"deleted_id":deleted});
        if request.preview {
            return Ok(output);
        }
        let replay_bytes = input.len() + serde_json::to_vec(&output)?.len();
        if let Some(stored) = upsert {
            document
                .reports
                .insert(stored.report.report_id.clone(), stored);
        }
        if let Some(id) = deleted {
            document.reports.remove(&id);
        }
        document.report_revision = next;
        while document.report_replay.len() >= 128
            || document
                .report_replay
                .iter()
                .map(|r| r.bytes)
                .sum::<usize>()
                + replay_bytes
                > REPLAY_BYTES
        {
            document.report_replay.pop_front();
        }
        document.report_replay.push_back(Replay {
            owner: caller.id.into(),
            id: request.request_id.clone(),
            input,
            output: output.clone(),
            created: Instant::now(),
            bytes: replay_bytes,
        });
        let count = document.reports.len();
        drop(document);
        drop(lease);
        self.publish(WorkbenchEvent::ReportsChanged {
            capture: request.capture.clone(),
            report_revision: next.into(),
            report_count: (count as u64).into(),
        });
        Ok(output)
    }
    pub fn list_reports(
        &self,
        capture: &CaptureRef,
        revision: u64,
        after_id: Option<&str>,
        limit: usize,
    ) -> Result<Value> {
        if limit == 0 || limit > 100 {
            return Err(invalid("report list limit must be 1..100"));
        }
        let session = self.existing_session(&capture.session_id)?;
        let lease = self.lease(&session, capture)?;
        let mut document = session.document.lock();
        crate::synchronize(&mut document, lease.snapshot().capture_generation);
        if revision != document.report_revision {
            return Err(WorkbenchError::ReportVersionConflict(
                document.report_revision,
            ));
        }
        if after_id.is_some_and(|id| !document.reports.contains_key(id)) {
            return Err(invalid("unknown report list continuation"));
        }
        let mut items = vec![];
        let mut truncated = false;
        for (_, report) in document
            .reports
            .iter()
            .filter(|(id, _)| after_id.is_none_or(|after| id.as_str() > after))
        {
            if items.len() == limit {
                truncated = true;
                break;
            }
            items.push(summary(&report.report));
            if serde_json::to_vec(&items)?.len() > PAGE_BYTES {
                items.pop();
                truncated = true;
                break;
            }
        }
        let next = if truncated {
            items.last().map(|s| s["report_id"].clone())
        } else {
            None
        };
        Ok(
            json!({"capture":capture,"report_revision":ExactU64(revision),"items":items,"total_reports":document.reports.len().to_string(),"opaque_report_count":document.opaque_reports.len().to_string(),"next_after_id":next,"complete":!truncated}),
        )
    }
    pub fn read_report(
        &self,
        capture: &CaptureRef,
        id: &str,
        start: usize,
        limit: usize,
    ) -> Result<Value> {
        crate::validate_id(id)?;
        if limit == 0 || limit > 64 {
            return Err(invalid("finding page limit must be 1..64"));
        }
        let session = self.existing_session(&capture.session_id)?;
        let lease = self.lease(&session, capture)?;
        let mut document = session.document.lock();
        crate::synchronize(&mut document, lease.snapshot().capture_generation);
        let stored = document
            .reports
            .get(id)
            .cloned()
            .ok_or(WorkbenchError::ReportNotFound)?;
        drop(document);
        drop(lease);
        if start > stored.report.findings.len() {
            return Err(invalid("report page starts beyond finding count"));
        }
        let mut findings = vec![];
        let mut next = start;
        let head = summary(&stored.report);
        while next < stored.report.findings.len() && findings.len() < limit {
            findings.push(stored.report.findings[next].clone());
            if serde_json::to_vec(&json!({"report":head,"findings":findings}))?.len() > PAGE_BYTES {
                findings.pop();
                break;
            }
            next += 1;
        }
        if findings.is_empty() && next < stored.report.findings.len() {
            return Err(WorkbenchError::ResourceLimit(
                "report finding cannot fit page budget",
            ));
        }
        let complete = next == stored.report.findings.len();
        Ok(
            json!({"capture":capture,"report":head,"findings":findings,"start_index":start.to_string(),"next_index":if complete{None}else{Some(next.to_string())},"complete":complete,"page_byte_budget":PAGE_BYTES.to_string(),"payload_scope":"selected_observations_not_full_analysis_coverage"}),
        )
    }
}

/// Restore all reports before changing the document. Unknown versions are
/// preserved verbatim with a bounded allocation and are never activated.
pub(crate) fn restore(
    values: &[Value],
    capture: &CaptureRef,
    snapshot: &GraphCaptureSnapshot,
) -> Result<(BTreeMap<String, Arc<StoredReport>>, Vec<Value>)> {
    if values.len() > MAX_REPORTS || serde_json::to_vec(values)?.len() > MAX_DOCUMENT_BYTES {
        return Err(WorkbenchError::ResourceLimit("saved report document"));
    }
    let mut reports = BTreeMap::new();
    let mut opaque = vec![];
    for value in values {
        if serde_json::to_vec(value)?.len() > MAX_REPORT_BYTES {
            return Err(WorkbenchError::ResourceLimit(
                "saved report exceeds 512 KiB",
            ));
        }
        if value["schema_version"] != "1" {
            opaque.push(value.clone());
            continue;
        }
        let mut report: Report = serde_json::from_value(value.clone())?;
        crate::validate_id(&report.report_id)?;
        crate::validate_id(&report.author_id)?;
        validate_text(&report.title, &report.note)?;
        for c in [&report.capture, &report.origin_capture] {
            crate::validate_id(&c.session_id)?;
            crate::validate_id(&c.capture_id)?;
        }
        if report.capture_sample_count.0 == 0
            || report.sample_rate_hz.0 == 0
            || report.findings.is_empty()
            || report.findings.len() > 64
        {
            return Err(invalid("invalid saved report metadata/findings"));
        }
        let archived = report.verification == EvidenceVerification::ArchivedOriginalCapture;
        if !archived
            && (report.capture_sample_count.0 != snapshot.metadata.sample_count
                || report.sample_rate_hz.0 != snapshot.metadata.sample_rate_hz)
        {
            return Err(invalid("saved report disagrees with capture metadata"));
        }
        let mut ids = BTreeSet::new();
        for record in &mut report.findings {
            crate::validate_id(&record.evidence_ref)?;
            if !ids.insert(record.evidence_ref.clone())
                || record.capture != report.capture
                || record.capture_sample_count != report.capture_sample_count
                || record.sample_rate_hz != report.sample_rate_hz
                || record.channels.len() > 32
                || record
                    .channels
                    .iter()
                    .any(|c| *c >= 32 || (!archived && !crate::valid_channel(snapshot, *c)))
                || record.provider_id.is_empty()
                || record.provider_id.len() > 128
                || record.provider_version.is_empty()
                || record.provider_version.len() > 128
                || (!archived
                    && record.verification == EvidenceVerification::ArchivedOriginalCapture)
            {
                return Err(invalid("saved report evidence identity/metadata mismatch"));
            }
            record
                .range
                .validate(report.capture_sample_count.0)
                .map_err(|e| invalid(&e.to_string()))?;
            if serde_json::to_vec(record)?.len() > MAX_FINDING_BYTES {
                return Err(WorkbenchError::ResourceLimit(
                    "saved report finding exceeds 96 KiB",
                ));
            }
            if archived {
                record.verification = EvidenceVerification::ArchivedOriginalCapture;
            } else {
                record.evidence_ref = format!("evidence-{}", uuid::Uuid::new_v4().simple());
                record.capture = capture.clone();
                record.verification = EvidenceVerification::ImportedSavedNotRecomputed;
            }
        }
        if !archived {
            report.capture = capture.clone();
            report.verification = EvidenceVerification::ImportedSavedNotRecomputed;
        }
        let stored = StoredReport::new(report)?;
        if reports
            .insert(stored.report.report_id.clone(), stored)
            .is_some()
        {
            return Err(invalid("duplicate saved report ID"));
        }
    }
    if reports.values().map(|r| r.bytes).sum::<usize>() + serde_json::to_vec(&opaque)?.len()
        > MAX_DOCUMENT_BYTES
    {
        return Err(WorkbenchError::ResourceLimit("restored report document"));
    }
    Ok((reports, opaque))
}
pub(crate) fn project_values(document: &Document, archive: bool) -> Result<Vec<Value>> {
    let mut values = document
        .reports
        .values()
        .map(|stored| {
            let mut report = stored.report.clone();
            if archive {
                report.verification = EvidenceVerification::ArchivedOriginalCapture;
                for f in &mut report.findings {
                    f.verification = EvidenceVerification::ArchivedOriginalCapture;
                }
            }
            serde_json::to_value(report)
        })
        .collect::<std::result::Result<Vec<_>, _>>()?;
    values.extend(document.opaque_reports.iter().map(|v| {
        if archive && v["schema_version"] != "opaque_archive_v1" {
            json!({"schema_version":"opaque_archive_v1","reason":"capture_trimmed","original":v})
        } else {
            v.clone()
        }
    }));
    if values.len() > MAX_REPORTS
        || serde_json::to_vec(&values)?.len() > MAX_DOCUMENT_BYTES
        || values
            .iter()
            .any(|v| serde_json::to_vec(v).map_or(true, |b| b.len() > MAX_REPORT_BYTES))
    {
        return Err(WorkbenchError::ResourceLimit(
            "serialized report document exceeds its import budget",
        ));
    }
    Ok(values)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{evidence::EvidenceDraft, AnnotationSource};
    use sigpilot_analysis::SampleRange;
    fn caller() -> Caller<'static> {
        Caller {
            id: "assistant",
            source: AnnotationSource::Assistant,
        }
    }
    fn records(service: &WorkbenchService, size: usize) -> Vec<String> {
        let capture = service.context("session-a").unwrap().capture;
        service
            .record_evidence(
                &capture,
                [2, 7, 10]
                    .into_iter()
                    .map(|sample| EvidenceDraft {
                        range: SampleRange::new(sample, sample + 1, 16).unwrap(),
                        channels: vec![0],
                        provider_id: "test.measure".into(),
                        provider_version: "1".into(),
                        parameters: json!({"threshold_samples":"2"}),
                        observed: json!({"sample":sample.to_string(),"detail":"x".repeat(size)}),
                    })
                    .collect(),
            )
            .unwrap()
            .into_iter()
            .map(|r| r.evidence_ref)
            .collect()
    }
    fn request(service: &WorkbenchService, refs: Vec<String>, id: &str) -> ApplyReportRequest {
        let c = service.context("session-a").unwrap();
        ApplyReportRequest {
            capture: c.capture,
            expected_report_revision: c.report_revision,
            request_id: id.into(),
            preview: false,
            operation: ReportOperation::Create {
                title: "Selected observations".into(),
                note: "Possible timing issue; cause unconfirmed".into(),
                evidence_refs: refs,
            },
        }
    }
    #[test]
    fn immutable_report_mutations_are_previewable_atomic_and_replay_safe() {
        let service = crate::tests::service();
        let refs = records(&service, 0);
        let events = service.subscribe().unwrap();
        let r = request(&service, refs.clone(), "create");
        let mut preview = r.clone();
        preview.preview = true;
        let p = service.apply_report(caller(), &preview).unwrap();
        assert!(p["upsert"]["report_id"].is_null());
        assert_eq!(p["report_revision"], "0");
        assert!(events.try_recv().is_err());
        let applied = service.apply_report(caller(), &r).unwrap();
        assert_eq!(applied["report_revision"], "1");
        assert_eq!(service.apply_report(caller(), &r).unwrap(), applied);
        assert_eq!(
            service.context("session-a").unwrap().annotation_revision.0,
            0
        );
        assert!(matches!(
            events.try_recv().unwrap().as_ref(),
            WorkbenchEvent::ReportsChanged { .. }
        ));
        assert!(events.try_recv().is_err());
        let mut different = r.clone();
        different.operation = ReportOperation::Create {
            title: "changed".into(),
            note: String::new(),
            evidence_refs: refs,
        };
        assert!(matches!(
            service.apply_report(caller(), &different),
            Err(WorkbenchError::RequestIdConflict)
        ));
        let mut stale = r.clone();
        stale.request_id = "stale".into();
        assert!(matches!(
            service.apply_report(caller(), &stale),
            Err(WorkbenchError::ReportVersionConflict(1))
        ));
        let forged = request(&service, vec!["evidence-forged".into()], "forged");
        assert!(matches!(
            service.apply_report(caller(), &forged),
            Err(WorkbenchError::EvidenceNotFound)
        ));
        let id = applied["upsert"]["report_id"].as_str().unwrap();
        let mut delete = request(&service, vec![], "delete");
        delete.operation = ReportOperation::Delete {
            report_id: id.into(),
        };
        assert_eq!(
            service.apply_report(caller(), &delete).unwrap()["deleted_id"],
            id
        );
        assert!(matches!(
            service.read_report(&r.capture, id, 0, 1),
            Err(WorkbenchError::ReportNotFound)
        ));
    }
    #[test]
    fn reports_survive_project_reopen_without_markers_and_rebind_saved_evidence() {
        let service = crate::tests::service();
        let refs = records(&service, 0);
        let r = request(&service, refs.clone(), "save");
        let created = service.apply_report(caller(), &r).unwrap();
        let id = created["upsert"]["report_id"].as_str().unwrap();
        let path = std::env::temp_dir().join(format!(
            "sigpilot-reports-{}.pxl",
            uuid::Uuid::new_v4().simple()
        ));
        service
            .save_project("session-a", &path, Default::default())
            .unwrap();
        let project = sigpilot_file::open_pxl_bounded(&path, 16 * 1024 * 1024).unwrap();
        std::fs::remove_file(path).unwrap();
        assert!(project.session.workbench_annotations.is_empty());
        assert_eq!(project.session.workbench_reports.len(), 1);
        let reopened = WorkbenchService::default();
        let context = reopened
            .import_capture("reopened", project.capture)
            .unwrap();
        reopened
            .restore_annotations("reopened", &project.session)
            .unwrap();
        let page = reopened.read_report(&context.capture, id, 0, 20).unwrap();
        assert_eq!(
            page["report"]["verification"],
            "imported_saved_not_recomputed"
        );
        assert_eq!(page["report"]["origin_capture"], json!(r.capture));
        let new_id = page["findings"][0]["evidence_ref"].as_str().unwrap();
        assert_ne!(new_id, refs[0]);
        assert_eq!(page["findings"][0]["capture"], json!(context.capture));
        assert_eq!(
            reopened
                .get_evidence(&context.capture, &[new_id.into()], 0.into())
                .unwrap()["evidence"][0]["observed"]["sample"],
            "2"
        );
        assert!(matches!(
            reopened.get_evidence(&context.capture, &[refs[0].clone()], 0.into()),
            Err(WorkbenchError::EvidenceNotFound)
        ));
    }
    #[test]
    fn finding_pages_obey_byte_budget_and_invalid_imports_never_replace_the_document() {
        let service = crate::tests::service();
        let refs = records(&service, 50_000);
        let r = request(&service, refs, "pages");
        let created = service.apply_report(caller(), &r).unwrap();
        let id = created["upsert"]["report_id"].as_str().unwrap();
        let page = service.read_report(&r.capture, id, 0, 64).unwrap();
        assert_eq!(page["findings"].as_array().unwrap().len(), 2);
        assert_eq!(page["next_index"], "2");
        assert_eq!(
            service.read_report(&r.capture, id, 2, 64).unwrap()["complete"],
            true
        );
        let mut metadata = service
            .project_metadata(&r.capture, Default::default())
            .unwrap();
        metadata.workbench_reports[0]["findings"][0]["capture"]["capture_id"] = json!("foreign");
        let fresh = crate::tests::service();
        assert!(fresh.restore_annotations("session-a", &metadata).is_err());
        assert_eq!(fresh.context("session-a").unwrap().report_count.0, 0);
        let oversized = records(&fresh, MAX_FINDING_BYTES);
        let r = request(&fresh, oversized, "too-large");
        assert!(matches!(
            fresh.apply_report(caller(), &r),
            Err(WorkbenchError::ResourceLimit(_))
        ));
        assert_eq!(fresh.context("session-a").unwrap().report_revision.0, 0);
    }
    #[test]
    fn trimming_archives_original_coordinates_and_preserves_unknown_versions_opaquely() {
        let service = crate::tests::service();
        let refs = records(&service, 0);
        let r = request(&service, refs.clone(), "archive");
        let created = service.apply_report(caller(), &r).unwrap();
        let id = created["upsert"]["report_id"].as_str().unwrap();
        let metadata = service
            .project_metadata(&r.capture, Default::default())
            .unwrap();
        let future = json!({"schema_version":"2","report_id":"future","plugin_payload":{"sample":"9007199254740995"}});
        let mut metadata = metadata;
        metadata.workbench_reports.push(future.clone());
        let fresh = crate::tests::service();
        fresh.restore_annotations("session-a", &metadata).unwrap();
        let c = fresh.context("session-a").unwrap().capture;
        assert_eq!(
            fresh
                .project_metadata(&c, Default::default())
                .unwrap()
                .workbench_reports[1],
            future
        );
        fresh.trim_capture("session-a", 4, 12).unwrap();
        let current = fresh.context("session-a").unwrap().capture;
        let page = fresh.read_report(&current, id, 0, 64).unwrap();
        assert_eq!(page["report"]["bound_to_current_capture"], false);
        assert_eq!(page["findings"][0]["range"]["start_sample"], "2");
        assert_eq!(page["report"]["verification"], "archived_original_capture");
        let old_ref = page["findings"][0]["evidence_ref"].as_str().unwrap();
        assert!(matches!(
            fresh.get_evidence(&current, &[old_ref.into()], 0.into()),
            Err(WorkbenchError::EvidenceNotFound)
        ));
        let saved = fresh
            .project_metadata(&current, Default::default())
            .unwrap();
        assert_eq!(saved.workbench_reports[1]["original"], future);
        fresh.trim_capture("session-a", 1, 7).unwrap();
        let current = fresh.context("session-a").unwrap().capture;
        assert_eq!(
            fresh
                .project_metadata(&current, Default::default())
                .unwrap()
                .workbench_reports[1]["original"],
            future
        );
    }
}
