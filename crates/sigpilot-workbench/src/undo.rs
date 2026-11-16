//! Compare-and-swap undo of one atomic annotation batch, with bounded retention.
use crate::{
    document_bytes, synchronize, validate_annotation, validate_id, ApplyAnnotationsResult, Caller,
    CaptureRef, Document, Replay, Result, StoredAnnotation, WorkbenchError, WorkbenchEvent,
    WorkbenchService,
};
use serde::{Deserialize, Serialize};
use sigpilot_analysis::ExactU64;
use std::{
    collections::BTreeMap,
    sync::Arc,
    time::{Duration, Instant},
};

const MAX_UNDO_BYTES: usize = 2 * 1024 * 1024;
const MAX_UNDO_BATCHES: usize = 128;
const RETENTION: Duration = Duration::from_secs(900);

pub(crate) struct UndoRecord {
    batch_id: String,
    owner: String,
    before_revision: u64,
    after_revision: u64,
    before: BTreeMap<String, Option<Arc<StoredAnnotation>>>,
    bytes: usize,
    created: Instant,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UndoAnnotationsRequest {
    pub capture: CaptureRef,
    pub expected_annotation_revision: ExactU64,
    pub batch_id: String,
    pub request_id: String,
    #[serde(default)]
    pub preview: bool,
}

pub(crate) fn record(
    document: &mut Document,
    owner: &str,
    result: &ApplyAnnotationsResult,
) -> Result<UndoRecord> {
    let mut before = BTreeMap::new();
    for id in result
        .upserts
        .iter()
        .map(|a| &a.id)
        .chain(&result.deleted_ids)
    {
        before.insert(id.clone(), document.annotations.get(id).cloned());
    }
    let bytes = before
        .iter()
        .map(|(id, a)| id.len() + a.as_ref().map_or(0, |a| a.encoded_bytes))
        .sum::<usize>();
    // A later undo must also fit the response budget, before the original edit
    // commits. Large batches can be split explicitly by the caller.
    if bytes > 200 * 1024 {
        return Err(WorkbenchError::ResourceLimit(
            "undo snapshot exceeds 200 KiB; reduce annotation batch",
        ));
    }
    Ok(UndoRecord {
        batch_id: result.batch_id.clone().unwrap(),
        owner: owner.into(),
        before_revision: document.revision,
        after_revision: result.annotation_revision.0,
        before,
        bytes,
        created: Instant::now(),
    })
}

pub(crate) fn available(document: &Document, owner: &str) -> Option<String> {
    document
        .undo
        .iter()
        .rev()
        .find(|r| {
            r.owner == owner
                && r.after_revision == document.revision
                && r.created.elapsed() < RETENTION
        })
        .map(|r| r.batch_id.clone())
}

pub(crate) fn retain(document: &mut Document, record: UndoRecord) {
    document.undo.retain(|r| r.created.elapsed() < RETENTION);
    while document.undo.len() >= MAX_UNDO_BATCHES
        || document.undo.iter().map(|r| r.bytes).sum::<usize>() + record.bytes > MAX_UNDO_BYTES
    {
        document.undo.pop_front();
    }
    document.undo.push_back(record);
}

impl WorkbenchService {
    pub fn undo_annotations(
        &self,
        caller: Caller<'_>,
        request: &UndoAnnotationsRequest,
    ) -> Result<ApplyAnnotationsResult> {
        validate_id(caller.id)?;
        validate_id(&request.request_id)?;
        validate_id(&request.batch_id)?;
        let input = format!("undo:{}", serde_json::to_string(request)?);
        let session = self.existing_session(&request.capture.session_id)?;
        let _operation = session.operation.lock();
        let lease = self.lease(&session, &request.capture)?;
        let mut document = session.document.lock();
        synchronize(&mut document, lease.snapshot().capture_generation);
        if !request.preview {
            if let Some(replay) = document
                .replay
                .iter()
                .find(|r| r.owner == caller.id && r.request_id == request.request_id)
            {
                if replay.input != input {
                    return Err(WorkbenchError::RequestIdConflict);
                }
                return Ok(replay.result.clone());
            }
        }
        if document.revision != request.expected_annotation_revision.0 {
            return Err(WorkbenchError::AnnotationVersionConflict(document.revision));
        }
        let record = document
            .undo
            .iter()
            .find(|r| {
                r.batch_id == request.batch_id
                    && r.owner == caller.id
                    && r.created.elapsed() < RETENTION
            })
            .ok_or(WorkbenchError::UndoNotFound)?;
        if record.after_revision != document.revision {
            return Err(WorkbenchError::AnnotationVersionConflict(document.revision));
        }
        let before_revision = record.before_revision;
        let mut next = document.annotations.clone();
        let mut upserts = Vec::new();
        let mut deleted_ids = Vec::new();
        for (id, previous) in &record.before {
            if let Some(item) = previous {
                validate_annotation(
                    &item.annotation.value,
                    lease.snapshot(),
                    document.gui_attached,
                )?;
                next.insert(id.clone(), item.clone());
                upserts.push(item.annotation.clone());
            } else if next.remove(id).is_some() {
                deleted_ids.push(id.clone());
            }
        }
        if document_bytes(&next) > crate::MAX_DOCUMENT_BYTES {
            return Err(WorkbenchError::ResourceLimit("undo annotation document"));
        }
        let revision = if request.preview {
            document.revision
        } else {
            document
                .revision
                .checked_add(1)
                .ok_or(WorkbenchError::ResourceLimit("revision counter"))?
        };
        let result = ApplyAnnotationsResult {
            capture: request.capture.clone(),
            annotation_revision: revision.into(),
            request_id: request.request_id.clone(),
            actor_id: caller.id.into(),
            batch_id: None,
            preview: request.preview,
            upserts,
            deleted_ids,
        };
        let result_bytes = serde_json::to_vec(&result)?.len();
        if result_bytes > 256 * 1024 {
            return Err(WorkbenchError::ResourceLimit("undo response"));
        }
        if request.preview {
            return Ok(result);
        }
        document.annotations = next;
        document.revision = revision;
        document.undo.retain(|r| r.batch_id != request.batch_id);
        // The restored state is exactly the previous stack state. Rebase only
        // that record, never skip an intervening edit or another caller's batch.
        if let Some(previous) = document
            .undo
            .iter_mut()
            .rev()
            .find(|r| r.after_revision == before_revision)
        {
            previous.after_revision = revision;
        }
        let bytes = input.len() + result_bytes;
        while document.replay_bytes + bytes > crate::MAX_REPLAY_BYTES {
            if let Some(old) = document.replay.pop_front() {
                document.replay_bytes -= old.bytes;
            } else {
                break;
            }
        }
        document.replay_bytes += bytes;
        document.replay.push_back(Replay {
            owner: caller.id.into(),
            request_id: request.request_id.clone(),
            input,
            result: result.clone(),
            bytes,
        });
        self.publish(WorkbenchEvent::AnnotationsChanged {
            result: result.clone(),
        });
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        AnnotationInput, AnnotationKind, AnnotationOperation, AnnotationSource,
        ApplyAnnotationsRequest,
    };
    fn apply(
        service: &WorkbenchService,
        id: &str,
        operations: Vec<AnnotationOperation>,
    ) -> ApplyAnnotationsResult {
        let context = service.context("session-a").unwrap();
        service
            .apply_annotations(
                Caller {
                    id: "owner",
                    source: AnnotationSource::Assistant,
                },
                &ApplyAnnotationsRequest {
                    capture: context.capture,
                    expected_annotation_revision: context.annotation_revision,
                    request_id: id.into(),
                    preview: false,
                    operations,
                },
            )
            .unwrap()
    }
    fn annotation(sample: u64) -> AnnotationInput {
        AnnotationInput {
            kind: AnnotationKind::ChannelAnnotation,
            sample: sample.into(),
            end_sample: None,
            channel: Some(0),
            title: "mark".into(),
            note: String::new(),
            tags: vec![],
            evidence_refs: vec![],
            shape: None,
            color: "#ffffff".into(),
        }
    }
    #[test]
    fn undo_restores_deleted_provenance_is_atomic_and_retry_safe() {
        let service = crate::tests::service();
        let created = apply(
            &service,
            "create",
            vec![AnnotationOperation::Create {
                id: Some("a".into()),
                annotation: annotation(2),
            }],
        );
        let deleted = apply(
            &service,
            "delete",
            vec![AnnotationOperation::Delete { id: "a".into() }],
        );
        let mut request = UndoAnnotationsRequest {
            capture: deleted.capture.clone(),
            expected_annotation_revision: deleted.annotation_revision,
            batch_id: deleted.batch_id.unwrap(),
            request_id: "undo-delete".into(),
            preview: true,
        };
        let caller = || Caller {
            id: "owner",
            source: AnnotationSource::Assistant,
        };
        assert_eq!(
            service
                .undo_annotations(caller(), &request)
                .unwrap()
                .upserts[0],
            created.upserts[0]
        );
        assert_eq!(service.context("session-a").unwrap().annotation_count.0, 0);
        request.preview = false;
        let restored = service.undo_annotations(caller(), &request).unwrap();
        assert_eq!(restored.upserts[0], created.upserts[0]);
        assert_eq!(
            service
                .undo_annotations(caller(), &request)
                .unwrap()
                .annotation_revision,
            restored.annotation_revision
        );
        assert_eq!(service.context("session-a").unwrap().annotation_count.0, 1);
        assert!(matches!(
            service.undo_annotations(
                Caller {
                    id: "other",
                    source: AnnotationSource::Assistant
                },
                &request
            ),
            Err(WorkbenchError::AnnotationVersionConflict(_))
        ));
    }
    #[test]
    fn intervening_edit_prevents_undo_and_capture_replacement_invalidates_history() {
        let service = crate::tests::service();
        let created = apply(
            &service,
            "create",
            vec![AnnotationOperation::Create {
                id: Some("a".into()),
                annotation: annotation(2),
            }],
        );
        let changed = apply(
            &service,
            "change",
            vec![AnnotationOperation::Update {
                id: "a".into(),
                annotation: annotation(3),
            }],
        );
        let request = UndoAnnotationsRequest {
            capture: changed.capture,
            expected_annotation_revision: changed.annotation_revision,
            batch_id: created.batch_id.unwrap(),
            request_id: "undo".into(),
            preview: false,
        };
        assert!(matches!(
            service.undo_annotations(
                Caller {
                    id: "owner",
                    source: AnnotationSource::Assistant
                },
                &request
            ),
            Err(WorkbenchError::AnnotationVersionConflict(_))
        ));
        service.trim_capture("session-a", 0, 10).unwrap();
        assert!(matches!(
            service.undo_annotations(
                Caller {
                    id: "owner",
                    source: AnnotationSource::Assistant
                },
                &request
            ),
            Err(WorkbenchError::CaptureVersionConflict)
        ));
    }
    #[test]
    fn sequential_undo_rebases_only_the_restored_previous_state() {
        let service = crate::tests::service();
        let created = apply(
            &service,
            "create",
            vec![AnnotationOperation::Create {
                id: Some("a".into()),
                annotation: annotation(2),
            }],
        );
        let updated = apply(
            &service,
            "update",
            vec![AnnotationOperation::Update {
                id: "a".into(),
                annotation: annotation(3),
            }],
        );
        let caller = || Caller {
            id: "owner",
            source: AnnotationSource::Assistant,
        };
        let first = service
            .undo_annotations(
                caller(),
                &UndoAnnotationsRequest {
                    capture: updated.capture.clone(),
                    expected_annotation_revision: updated.annotation_revision,
                    batch_id: updated.batch_id.unwrap(),
                    request_id: "undo-update".into(),
                    preview: false,
                },
            )
            .unwrap();
        assert_eq!(first.upserts[0].value.sample.0, 2);
        let second = service
            .undo_annotations(
                caller(),
                &UndoAnnotationsRequest {
                    capture: first.capture,
                    expected_annotation_revision: first.annotation_revision,
                    batch_id: created.batch_id.unwrap(),
                    request_id: "undo-create".into(),
                    preview: false,
                },
            )
            .unwrap();
        assert_eq!(second.annotation_revision.0, 4);
        assert_eq!(service.context("session-a").unwrap().annotation_count.0, 0);
    }
}
