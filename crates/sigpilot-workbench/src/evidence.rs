//! Immutable evidence, validated references and portable annotation snapshots.
use crate::{AnnotationInput, CaptureRef, Document, Result, WorkbenchError, WorkbenchService};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sigpilot_analysis::{ExactU64, SampleRange};
use std::{
    collections::VecDeque,
    sync::Arc,
    time::{Duration, Instant},
};

const MAX_EVIDENCE: usize = 4096;
const MAX_EVIDENCE_BYTES: usize = 8 * 1024 * 1024;
const MAX_RECORD_BYTES: usize = 256 * 1024;
const RETENTION: Duration = Duration::from_secs(900);

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceVerification {
    RuntimeComputed,
    ImportedSavedNotRecomputed,
    ArchivedOriginalCapture,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct EvidenceRecord {
    pub evidence_ref: String,
    pub capture: CaptureRef,
    pub capture_sample_count: ExactU64,
    pub sample_rate_hz: ExactU64,
    pub range: SampleRange,
    pub channels: Vec<u8>,
    pub provider_id: String,
    pub provider_version: String,
    pub parameters: Value,
    pub observed: Value,
    pub verification: EvidenceVerification,
}

pub struct EvidenceDraft {
    pub range: SampleRange,
    pub channels: Vec<u8>,
    pub provider_id: String,
    pub provider_version: String,
    pub parameters: Value,
    pub observed: Value,
}

struct Entry {
    record: Arc<EvidenceRecord>,
    bytes: usize,
    created: Instant,
}
#[derive(Default)]
pub(crate) struct EvidenceRegistry {
    entries: Mutex<VecDeque<Entry>>,
}
impl EvidenceRegistry {
    fn register(&self, records: Vec<EvidenceRecord>) -> Result<Vec<EvidenceRecord>> {
        let mut entries = Vec::new();
        let mut bytes = 0;
        for record in &records {
            let size = serde_json::to_vec(record)?.len();
            if size > MAX_RECORD_BYTES {
                return Err(WorkbenchError::ResourceLimit(
                    "individual evidence exceeds 256 KiB",
                ));
            }
            bytes += size;
            entries.push(Entry {
                record: Arc::new(record.clone()),
                bytes: size,
                created: Instant::now(),
            });
        }
        if entries.len() > MAX_EVIDENCE || bytes > MAX_EVIDENCE_BYTES {
            return Err(WorkbenchError::ResourceLimit("evidence batch"));
        }
        let mut registry = self.entries.lock();
        registry.retain(|e| e.created.elapsed() < RETENTION);
        while registry.len() + entries.len() > MAX_EVIDENCE
            || registry.iter().map(|e| e.bytes).sum::<usize>() + bytes > MAX_EVIDENCE_BYTES
        {
            registry.pop_front();
        }
        registry.extend(entries);
        Ok(records)
    }
    fn get(&self, capture: &CaptureRef, id: &str) -> Option<EvidenceRecord> {
        let entries = self.entries.lock();
        entries
            .iter()
            .find(|e| {
                e.created.elapsed() < RETENTION
                    && e.record.evidence_ref == id
                    && e.record.capture == *capture
            })
            .map(|e| e.record.as_ref().clone())
    }
}

impl WorkbenchService {
    pub fn record_evidence(
        &self,
        capture: &CaptureRef,
        drafts: Vec<EvidenceDraft>,
    ) -> Result<Vec<EvidenceRecord>> {
        self.record_evidence_with_verification(
            capture,
            drafts,
            EvidenceVerification::RuntimeComputed,
        )
    }
    pub(crate) fn record_result_evidence(
        &self,
        capture: &CaptureRef,
        id: &str,
        drafts: Vec<EvidenceDraft>,
    ) -> Result<Vec<EvidenceRecord>> {
        self.record_evidence_with_verification(
            capture,
            drafts,
            self.result_verification(capture, id),
        )
    }
    fn record_evidence_with_verification(
        &self,
        capture: &CaptureRef,
        drafts: Vec<EvidenceDraft>,
        verification: EvidenceVerification,
    ) -> Result<Vec<EvidenceRecord>> {
        let session = self.existing_session(&capture.session_id)?;
        let lease = self.lease(&session, capture)?;
        let mut records = Vec::new();
        for draft in drafts {
            draft
                .range
                .validate(lease.snapshot().metadata.sample_count)
                .map_err(|e| WorkbenchError::InvalidRequest(e.to_string()))?;
            if draft.channels.len() > 32
                || draft
                    .channels
                    .iter()
                    .any(|c| !crate::valid_channel(lease.snapshot(), *c))
                || draft.provider_id.is_empty()
                || draft.provider_id.len() > 128
                || draft.provider_version.is_empty()
                || draft.provider_version.len() > 128
            {
                return Err(WorkbenchError::InvalidRequest(
                    "invalid evidence channel/provider".into(),
                ));
            }
            records.push(EvidenceRecord {
                evidence_ref: format!("evidence-{}", uuid::Uuid::new_v4().simple()),
                capture: capture.clone(),
                capture_sample_count: lease.snapshot().metadata.sample_count.into(),
                sample_rate_hz: lease.snapshot().metadata.sample_rate_hz.into(),
                range: draft.range,
                channels: draft.channels,
                provider_id: draft.provider_id,
                provider_version: draft.provider_version,
                parameters: draft.parameters,
                observed: draft.observed,
                verification,
            });
        }
        self.evidence.register(records)
    }

    pub(crate) fn annotation_evidence(
        &self,
        capture: &CaptureRef,
        input: &AnnotationInput,
        document: &Document,
    ) -> Result<Vec<EvidenceRecord>> {
        let mut records = Vec::new();
        let mut endpoints = (false, false);
        for id in &input.evidence_refs {
            let record = self.resolve_evidence(capture, id, document)?;
            let contains = |sample: ExactU64| {
                sample >= record.range.start_sample && sample < record.range.end_sample
            };
            let pair = input.kind == crate::AnnotationKind::TimingPair;
            let start = contains(input.sample);
            let end = input.end_sample.is_some_and(contains);
            if (if pair {
                !start && !end
            } else {
                !start
                    || input
                        .end_sample
                        .is_some_and(|e| e > record.range.end_sample)
            }) || input.channel.is_some_and(|c| !record.channels.contains(&c))
            {
                return Err(WorkbenchError::InvalidRequest(
                    "annotation anchor/channel lies outside its evidence".into(),
                ));
            }
            endpoints.0 |= start;
            endpoints.1 |= end;
            records.push(record);
        }
        if input.kind == crate::AnnotationKind::TimingPair
            && !records.is_empty()
            && (!endpoints.0 || !endpoints.1)
        {
            return Err(WorkbenchError::InvalidRequest(
                "both timing pair points require evidence anchors".into(),
            ));
        }
        Ok(records)
    }

    pub(crate) fn resolve_evidence(
        &self,
        capture: &CaptureRef,
        id: &str,
        document: &Document,
    ) -> Result<EvidenceRecord> {
        self.evidence
            .get(capture, id)
            .or_else(|| {
                document
                    .annotations
                    .values()
                    .flat_map(|a| a.annotation.evidence.iter())
                    .chain(
                        document
                            .reports
                            .values()
                            .filter(|r| {
                                r.report.verification
                                    != EvidenceVerification::ArchivedOriginalCapture
                            })
                            .flat_map(|r| r.report.findings.iter()),
                    )
                    .find(|e| e.evidence_ref == id && e.capture == *capture)
                    .cloned()
            })
            .ok_or(WorkbenchError::EvidenceNotFound)
    }

    /// Attached annotations carry their evidence snapshot beyond registry eviction.
    pub fn get_evidence(
        &self,
        capture: &CaptureRef,
        refs: &[String],
        context_samples: ExactU64,
    ) -> Result<Value> {
        if refs.is_empty() || refs.len() > 8 || context_samples.0 > 1_000_000 {
            return Err(WorkbenchError::InvalidRequest(
                "1..8 refs and at most 1000000 context samples required".into(),
            ));
        }
        let session = self.existing_session(&capture.session_id)?;
        let lease = self.lease(&session, capture)?;
        let records = {
            let document = session.document.lock();
            refs.iter()
                .map(|id| self.resolve_evidence(capture, id, &document))
                .collect::<Result<Vec<_>>>()?
        };
        drop(lease);
        if serde_json::to_vec(&records)?.len() > 192 * 1024 {
            return Err(WorkbenchError::ResourceLimit(
                "request fewer evidence refs; evidence response exceeds 192 KiB",
            ));
        }
        let mut contexts = Vec::new();
        let mut contexts_complete = true;
        if context_samples.0 > 0 {
            let mut remaining = 128;
            for record in &records {
                let range = SampleRange {
                    start_sample: record
                        .range
                        .start_sample
                        .0
                        .saturating_sub(context_samples.0)
                        .into(),
                    end_sample: record
                        .range
                        .end_sample
                        .0
                        .saturating_add(context_samples.0)
                        .min(record.capture_sample_count.0)
                        .into(),
                };
                for &channel in &record.channels {
                    if remaining == 0 {
                        contexts_complete = false;
                        break;
                    }
                    let window = self.edge_window(capture, channel, range)?;
                    let page =
                        sigpilot_analysis::query_edges(&window.window, None, remaining.min(8))
                            .map_err(|e| WorkbenchError::InvalidRequest(e.to_string()))?;
                    remaining -= page.items.len();
                    contexts_complete &= page.complete;
                    contexts.push(json!({"evidence_ref":record.evidence_ref,"channel":channel,"range":range,"page":page}));
                }
            }
        }
        Ok(
            json!({"capture":capture,"evidence":records,"contexts":contexts,"context_edge_budget":"128","complete":true,"contexts_complete":contexts_complete}),
        )
    }

    pub(crate) fn restore_evidence(
        &self,
        annotation: &mut crate::WorkbenchAnnotation,
        capture: &CaptureRef,
        snapshot: &sigpilot_graph::GraphCaptureSnapshot,
    ) -> Result<()> {
        let count = snapshot.metadata.sample_count;
        let rate = snapshot.metadata.sample_rate_hz;
        if annotation.evidence.len() != annotation.value.evidence_refs.len()
            || annotation.archived_evidence.len() > 16
        {
            return Err(WorkbenchError::InvalidRequest(
                "saved annotation evidence snapshot is missing or oversized".into(),
            ));
        }
        let mut drafts = Vec::new();
        let mut endpoints = (false, false);
        for (id, record) in annotation
            .value
            .evidence_refs
            .iter()
            .zip(&annotation.evidence)
        {
            if record.evidence_ref != *id
                || record.verification == EvidenceVerification::ArchivedOriginalCapture
                || record.capture_sample_count.0 != count
                || record.sample_rate_hz.0 != rate
                || record.channels.len() > 32
                || record
                    .channels
                    .iter()
                    .any(|c| !crate::valid_channel(snapshot, *c))
                || record.provider_id.is_empty()
                || record.provider_id.len() > 128
                || record.provider_version.is_empty()
                || record.provider_version.len() > 128
            {
                return Err(WorkbenchError::InvalidRequest(
                    "saved evidence disagrees with annotation/capture metadata".into(),
                ));
            }
            record
                .range
                .validate(count)
                .map_err(|e| WorkbenchError::InvalidRequest(e.to_string()))?;
            let contains = |sample: ExactU64| {
                sample >= record.range.start_sample && sample < record.range.end_sample
            };
            let start = contains(annotation.value.sample);
            let end = annotation.value.end_sample.is_some_and(contains);
            let pair = annotation.value.kind == crate::AnnotationKind::TimingPair;
            if (if pair {
                !start && !end
            } else {
                !start
                    || annotation
                        .value
                        .end_sample
                        .is_some_and(|s| s > record.range.end_sample)
            }) || annotation
                .value
                .channel
                .is_some_and(|c| !record.channels.contains(&c))
            {
                return Err(WorkbenchError::InvalidRequest(
                    "saved evidence disagrees with annotation anchor".into(),
                ));
            }
            endpoints.0 |= start;
            endpoints.1 |= end;
            let mut restored = record.clone();
            restored.evidence_ref = format!("evidence-{}", uuid::Uuid::new_v4().simple());
            restored.capture = capture.clone();
            restored.verification = EvidenceVerification::ImportedSavedNotRecomputed;
            drafts.push(restored);
        }
        if annotation.value.kind == crate::AnnotationKind::TimingPair
            && !drafts.is_empty()
            && (!endpoints.0 || !endpoints.1)
        {
            return Err(WorkbenchError::InvalidRequest(
                "saved timing pair needs evidence for both recorded points".into(),
            ));
        }
        for archived in &mut annotation.archived_evidence {
            archived.verification = EvidenceVerification::ArchivedOriginalCapture;
        }
        annotation.evidence = self.evidence.register(drafts)?;
        annotation.value.evidence_refs = annotation
            .evidence
            .iter()
            .map(|e| e.evidence_ref.clone())
            .collect();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn timing_pair_binds_each_point_to_its_own_evidence_and_excludes_range_end() {
        let service = crate::tests::service();
        let capture = service.context("session-a").unwrap().capture;
        let records = service
            .record_evidence(
                &capture,
                [2, 7]
                    .into_iter()
                    .map(|sample| EvidenceDraft {
                        range: SampleRange::new(sample, sample + 1, 16).unwrap(),
                        channels: vec![0],
                        provider_id: "test".into(),
                        provider_version: "1".into(),
                        parameters: json!({}),
                        observed: json!({"sample":sample.to_string()}),
                    })
                    .collect(),
            )
            .unwrap();
        let mut pair = AnnotationInput {
            kind: crate::AnnotationKind::TimingPair,
            sample: 2.into(),
            end_sample: Some(7.into()),
            channel: None,
            title: "two edges".into(),
            note: String::new(),
            tags: vec![],
            evidence_refs: records.iter().map(|r| r.evidence_ref.clone()).collect(),
            shape: None,
            color: "#ffffff".into(),
        };
        let doc = Document::default();
        assert_eq!(
            service
                .annotation_evidence(&capture, &pair, &doc)
                .unwrap()
                .len(),
            2
        );
        pair.end_sample = Some(8.into());
        assert!(service.annotation_evidence(&capture, &pair, &doc).is_err());
        pair.end_sample = Some(7.into());
        pair.evidence_refs.pop();
        assert!(service.annotation_evidence(&capture, &pair, &doc).is_err());
        pair.evidence_refs = records.iter().map(|r| r.evidence_ref.clone()).collect();
        service
            .apply_annotations(
                crate::Caller {
                    id: "owner",
                    source: crate::AnnotationSource::Assistant,
                },
                &crate::ApplyAnnotationsRequest {
                    capture: capture.clone(),
                    expected_annotation_revision: 0.into(),
                    request_id: "pair-save".into(),
                    preview: false,
                    operations: vec![crate::AnnotationOperation::Create {
                        id: Some("pair".into()),
                        annotation: pair,
                    }],
                },
            )
            .unwrap();
        let path = std::env::temp_dir().join(format!(
            "sigpilot-pair-{}.pxl",
            uuid::Uuid::new_v4().simple()
        ));
        service
            .save_project("session-a", &path, Default::default())
            .unwrap();
        let project = sigpilot_file::open_pxl_bounded(&path, 1024 * 1024).unwrap();
        std::fs::remove_file(path).unwrap();
        let reopened = WorkbenchService::default();
        let context = reopened
            .import_capture("reopened", project.capture)
            .unwrap();
        reopened
            .restore_annotations("reopened", &project.session)
            .unwrap();
        let annotations = reopened.annotation_snapshot(&context.capture).unwrap();
        assert_eq!(annotations[0].evidence.len(), 2);
        assert!(annotations[0]
            .evidence
            .iter()
            .all(|e| e.verification == EvidenceVerification::ImportedSavedNotRecomputed));
        let mut invalid = project.session;
        invalid.workbench_annotations[0]["end_sample"] = json!("8");
        let fresh = crate::tests::service();
        assert!(fresh.restore_annotations("session-a", &invalid).is_err());
        assert!(fresh
            .annotation_snapshot(&fresh.context("session-a").unwrap().capture)
            .unwrap()
            .is_empty());
    }
    #[test]
    fn an_annotation_snapshot_keeps_evidence_resolvable_after_registry_expiry() {
        let service = crate::tests::service();
        let capture = service.context("session-a").unwrap().capture;
        let records = service
            .record_evidence(
                &capture,
                vec![EvidenceDraft {
                    range: SampleRange::new(2, 4, 16).unwrap(),
                    channels: vec![0],
                    provider_id: "test".into(),
                    provider_version: "1".into(),
                    parameters: json!({}),
                    observed: json!({"width_samples":"2"}),
                }],
            )
            .unwrap();
        let input = AnnotationInput {
            kind: crate::AnnotationKind::ChannelAnnotation,
            sample: 2.into(),
            end_sample: None,
            channel: Some(0),
            title: "proof".into(),
            note: String::new(),
            tags: vec![],
            evidence_refs: vec![records[0].evidence_ref.clone()],
            shape: None,
            color: "#ffffff".into(),
        };
        service
            .apply_annotations(
                crate::Caller {
                    id: "owner",
                    source: crate::AnnotationSource::Assistant,
                },
                &crate::ApplyAnnotationsRequest {
                    capture: capture.clone(),
                    expected_annotation_revision: 0.into(),
                    request_id: "mark".into(),
                    preview: false,
                    operations: vec![crate::AnnotationOperation::Create {
                        id: None,
                        annotation: input,
                    }],
                },
            )
            .unwrap();
        for entry in service.evidence.entries.lock().iter_mut() {
            entry.created = Instant::now() - RETENTION;
        }
        assert!(service
            .evidence
            .get(&capture, &records[0].evidence_ref)
            .is_none());
        let result = service
            .get_evidence(&capture, &[records[0].evidence_ref.clone()], 2.into())
            .unwrap();
        assert_eq!(result["evidence"][0]["observed"]["width_samples"], "2");
    }
    #[test]
    fn independent_report_keeps_evidence_after_runtime_registry_expiry() {
        let service = crate::tests::service();
        let capture = service.context("session-a").unwrap().capture;
        let record = service
            .record_evidence(
                &capture,
                vec![EvidenceDraft {
                    range: SampleRange::new(2, 3, 16).unwrap(),
                    channels: vec![0],
                    provider_id: "test".into(),
                    provider_version: "1".into(),
                    parameters: json!({}),
                    observed: json!({"sample":"2"}),
                }],
            )
            .unwrap()
            .remove(0);
        service
            .apply_report(
                crate::Caller {
                    id: "owner",
                    source: crate::AnnotationSource::Assistant,
                },
                &crate::reports::ApplyReportRequest {
                    capture: capture.clone(),
                    expected_report_revision: 0.into(),
                    request_id: "keep-report".into(),
                    preview: false,
                    operation: crate::reports::ReportOperation::Create {
                        title: "Persist observation".into(),
                        note: String::new(),
                        evidence_refs: vec![record.evidence_ref.clone()],
                    },
                },
            )
            .unwrap();
        for entry in service.evidence.entries.lock().iter_mut() {
            entry.created = Instant::now() - RETENTION;
        }
        assert!(service
            .evidence
            .get(&capture, &record.evidence_ref)
            .is_none());
        assert_eq!(
            service
                .get_evidence(&capture, &[record.evidence_ref], 0.into())
                .unwrap()["evidence"][0]["observed"]["sample"],
            "2"
        );
        assert!(service.annotation_snapshot(&capture).unwrap().is_empty());
    }
}
