use sigpilot_core::{CaptureData, CaptureMetadata};

use super::*;

pub(crate) fn service() -> WorkbenchService {
    let service = WorkbenchService::default();
    let metadata: CaptureMetadata = serde_json::from_value(serde_json::json!({
        "version": 1, "source_device": "fixture", "sample_rate_hz": 1000000,
        "channel_count": 2, "enabled_channels": [0], "unitsize": 1,
        "sample_count": 16, "captured_at": "2026-11-12T00:00:00Z", "labels": ["D0", "D1"]
    }))
    .unwrap();
    service
        .session("session-a")
        .unwrap()
        .graph
        .replace_capture(CaptureData {
            metadata,
            samples: vec![0; 16],
        })
        .unwrap();
    service
}

fn input(sample: u64) -> AnnotationInput {
    AnnotationInput {
        kind: AnnotationKind::ChannelAnnotation,
        sample: sample.into(),
        end_sample: None,
        channel: Some(0),
        title: "precise point".into(),
        note: String::new(),
        tags: vec!["test".into()],
        evidence_refs: vec![],
        shape: Some(sigpilot_file::WaveformAnnotationShape::Flag),
        color: "#ffc44d".into(),
    }
}

fn request(
    service: &WorkbenchService,
    id: &str,
    operations: Vec<AnnotationOperation>,
) -> ApplyAnnotationsRequest {
    let context = service.context("session-a").unwrap();
    ApplyAnnotationsRequest {
        capture: context.capture,
        expected_annotation_revision: context.annotation_revision,
        request_id: id.into(),
        preview: false,
        operations,
    }
}

fn caller() -> Caller<'static> {
    Caller {
        id: "assistant-a",
        source: AnnotationSource::Assistant,
    }
}

#[test]
fn evidence_is_validated_saved_and_reopened_without_claiming_recomputation() {
    use crate::evidence::{EvidenceDraft, EvidenceVerification};
    let service = service();
    let capture = service.context("session-a").unwrap().capture;
    let evidence = service
        .record_evidence(
            &capture,
            vec![EvidenceDraft {
                range: SampleRange::new(2, 4, 16).unwrap(),
                channels: vec![0],
                provider_id: "sigpilot.pulse_width".into(),
                provider_version: "1".into(),
                parameters: serde_json::json!({"max_width_exclusive":"3"}),
                observed: serde_json::json!({"width_samples":"2"}),
            }],
        )
        .unwrap();
    let mut annotation = input(2);
    annotation.evidence_refs = vec![evidence[0].evidence_ref.clone()];
    let create = request(
        &service,
        "evidence-mark",
        vec![AnnotationOperation::Create {
            id: None,
            annotation,
        }],
    );
    let result = service.apply_annotations(caller(), &create).unwrap();
    assert_eq!(
        result.upserts[0].evidence[0].verification,
        EvidenceVerification::RuntimeComputed
    );
    let mut invalid = input(7);
    invalid.evidence_refs = vec![evidence[0].evidence_ref.clone()];
    assert!(service
        .apply_annotations(
            caller(),
            &request(
                &service,
                "invalid-evidence",
                vec![AnnotationOperation::Create {
                    id: None,
                    annotation: invalid
                }]
            )
        )
        .is_err());
    let mut invalid = input(2);
    invalid.evidence_refs = vec!["evidence-forged".into()];
    assert!(matches!(
        service.apply_annotations(
            caller(),
            &request(
                &service,
                "forged-evidence",
                vec![AnnotationOperation::Create {
                    id: None,
                    annotation: invalid
                }]
            )
        ),
        Err(WorkbenchError::EvidenceNotFound)
    ));
    let path = std::env::temp_dir().join(format!(
        "sigpilot-evidence-{}.pxl",
        uuid::Uuid::new_v4().simple()
    ));
    service
        .save_project("session-a", &path, Default::default())
        .unwrap();
    let project = sigpilot_file::open_pxl_bounded(&path, 16 * 1024 * 1024).unwrap();
    std::fs::remove_file(path).unwrap();
    let reopened = WorkbenchService::default();
    let context = reopened
        .import_capture("reopened", project.capture)
        .unwrap();
    reopened
        .restore_annotations("reopened", &project.session)
        .unwrap();
    let snapshot = reopened.annotation_snapshot(&context.capture).unwrap();
    assert_eq!(
        snapshot[0].evidence[0].verification,
        EvidenceVerification::ImportedSavedNotRecomputed
    );
    assert_eq!(snapshot[0].evidence[0].observed["width_samples"], "2");
    assert_ne!(snapshot[0].value.evidence_refs[0], evidence[0].evidence_ref);
    reopened
        .get_evidence(&context.capture, &snapshot[0].value.evidence_refs, 0.into())
        .unwrap();
    reopened.trim_capture("reopened", 1, 10).unwrap();
    let cropped = reopened.gui_snapshot("reopened").unwrap();
    assert_eq!(cropped.annotations[0].value.sample.0, 1);
    assert!(cropped.annotations[0].value.evidence_refs.is_empty());
    assert_eq!(cropped.annotations[0].archived_evidence.len(), 1);
    assert_eq!(
        cropped.annotations[0].archived_evidence[0].verification,
        EvidenceVerification::ArchivedOriginalCapture
    );
}

#[test]
fn measurements_agree_for_packed_and_sparse_captures_at_every_sample() {
    use sigpilot_analysis::measure::{measure_point, measure_range};
    use sigpilot_core::{SparseCaptureData, SparseDigitalChannel};
    let service = service();
    let mut metadata = service
        .session("session-a")
        .unwrap()
        .graph
        .capture()
        .unwrap()
        .metadata
        .clone();
    metadata.sample_count = 20;
    let edges = vec![2, 3, 5, 7, 10, 13, 15];
    let samples = (0..20)
        .map(|at| (edges.partition_point(|edge| *edge <= at) % 2) as u8)
        .collect();
    service
        .session("packed")
        .unwrap()
        .graph
        .replace_capture(CaptureData {
            metadata: metadata.clone(),
            samples,
        })
        .unwrap();
    service
        .session("sparse")
        .unwrap()
        .graph
        .replace_sparse_capture(SparseCaptureData {
            metadata,
            channels: vec![SparseDigitalChannel {
                channel: 0,
                initial_high: false,
                transitions: edges,
            }],
        })
        .unwrap();
    let packed = service.context("packed").unwrap().capture;
    let sparse = service.context("sparse").unwrap().capture;
    for at in 0..20 {
        assert_eq!(
            measure_point(&service.point_window(&packed, 0, at).unwrap().window).unwrap(),
            measure_point(&service.point_window(&sparse, 0, at).unwrap().window).unwrap()
        );
    }
    for start in 0..20 {
        let range = SampleRange::new(start, 20, 20).unwrap();
        assert_eq!(
            measure_range(
                &service.edge_window(&packed, 0, range).unwrap().window,
                range
            )
            .unwrap(),
            measure_range(
                &service.edge_window(&sparse, 0, range).unwrap().window,
                range
            )
            .unwrap()
        );
    }
}

#[test]
fn measurements_preserve_huge_coordinates_and_constant_capture_boundaries() {
    use sigpilot_analysis::measure::{measure_point, measure_range};
    use sigpilot_core::{SparseCaptureData, SparseDigitalChannel};
    let service = service();
    let base = (1u64 << 53) + 1;
    let mut metadata = service
        .session("session-a")
        .unwrap()
        .graph
        .capture()
        .unwrap()
        .metadata
        .clone();
    metadata.sample_count = base + 20;
    service
        .session("huge")
        .unwrap()
        .graph
        .replace_sparse_capture(SparseCaptureData {
            metadata: metadata.clone(),
            channels: vec![SparseDigitalChannel {
                channel: 0,
                initial_high: false,
                transitions: vec![base, base + 2, base + 5],
            }],
        })
        .unwrap();
    let capture = service.context("huge").unwrap().capture;
    let at_edge = measure_point(&service.point_window(&capture, 0, base).unwrap().window).unwrap();
    assert_eq!(at_edge.opening_sample, Some(base.into()));
    assert_eq!(at_edge.pulse_width_samples, Some(2.into()));
    assert_eq!(at_edge.period_samples, Some(5.into()));
    let range = SampleRange::new(base, base + 5, metadata.sample_count).unwrap();
    let measured = measure_range(
        &service.edge_window(&capture, 0, range).unwrap().window,
        range,
    )
    .unwrap();
    assert_eq!((measured.high_samples.0, measured.low_samples.0), (2, 3));
    assert!(!measured.left_boundary_incomplete && !measured.right_boundary_incomplete);
    assert_eq!(
        measured.complete_high_pulses.0 + measured.complete_low_pulses.0,
        2
    );
    service
        .session("constant")
        .unwrap()
        .graph
        .replace_sparse_capture(SparseCaptureData {
            metadata: metadata.clone(),
            channels: vec![SparseDigitalChannel {
                channel: 0,
                initial_high: true,
                transitions: vec![],
            }],
        })
        .unwrap();
    let capture = service.context("constant").unwrap().capture;
    let point = measure_point(&service.point_window(&capture, 0, base).unwrap().window).unwrap();
    assert!(!point.complete_pulse);
    assert_eq!(point.observed_width_samples.0, metadata.sample_count);
    assert_eq!(point.pulse_width_samples, None);
    let measured = measure_range(
        &service.edge_window(&capture, 0, range).unwrap().window,
        range,
    )
    .unwrap();
    assert_eq!((measured.high_samples.0, measured.low_samples.0), (5, 0));
    assert_eq!(
        measured.complete_high_pulses.0 + measured.complete_low_pulses.0,
        0
    );
}

#[test]
fn batch_failure_does_not_publish_or_partially_mutate() {
    let service = service();
    let events = service.subscribe().unwrap();
    let request = request(
        &service,
        "invalid-batch",
        vec![
            AnnotationOperation::Create {
                id: None,
                annotation: input(2),
            },
            AnnotationOperation::Create {
                id: None,
                annotation: input(16),
            },
        ],
    );
    assert!(service.apply_annotations(caller(), &request).is_err());
    let context = service.context("session-a").unwrap();
    assert_eq!(context.annotation_revision.0, 0);
    assert_eq!(context.annotation_count.0, 0);
    assert!(events.try_recv().is_err());
}

#[test]
fn retry_is_idempotent_and_different_input_with_same_id_is_rejected() {
    let service = service();
    let mut request = request(
        &service,
        "request-a",
        vec![AnnotationOperation::Create {
            id: None,
            annotation: input(3),
        }],
    );
    let first = service.apply_annotations(caller(), &request).unwrap();
    let retry = service.apply_annotations(caller(), &request).unwrap();
    assert_eq!(first.upserts[0].id, retry.upserts[0].id);
    assert_eq!(service.context("session-a").unwrap().annotation_count.0, 1);
    request.operations = vec![AnnotationOperation::Create {
        id: None,
        annotation: input(4),
    }];
    assert!(matches!(
        service.apply_annotations(caller(), &request),
        Err(WorkbenchError::RequestIdConflict)
    ));
}

#[test]
fn preview_keeps_version_and_document_unchanged() {
    let service = service();
    let mut request = request(
        &service,
        "preview-a",
        vec![AnnotationOperation::Create {
            id: None,
            annotation: input(5),
        }],
    );
    request.preview = true;
    let preview = service.apply_annotations(caller(), &request).unwrap();
    assert!(preview.preview);
    assert_eq!(preview.annotation_revision.0, 0);
    assert_eq!(service.context("session-a").unwrap().annotation_count.0, 0);
    request.preview = false;
    assert_eq!(
        service
            .apply_annotations(caller(), &request)
            .unwrap()
            .annotation_revision
            .0,
        1
    );
}

#[test]
fn stale_gui_edit_cannot_overwrite_assistant_annotations() {
    let service = service();
    let first = request(
        &service,
        "assistant-edit",
        vec![AnnotationOperation::Create {
            id: None,
            annotation: input(2),
        }],
    );
    let stale = request(
        &service,
        "gui-edit",
        vec![AnnotationOperation::Create {
            id: None,
            annotation: input(7),
        }],
    );
    service.apply_annotations(caller(), &first).unwrap();
    assert!(matches!(
        service.apply_annotations(
            Caller {
                id: "gui",
                source: AnnotationSource::User
            },
            &stale
        ),
        Err(WorkbenchError::AnnotationVersionConflict(1))
    ));
}

#[test]
fn disabled_channel_and_mismatched_kinds_are_rejected() {
    let service = service();
    let mut annotation = input(3);
    annotation.channel = Some(1);
    let request = request(
        &service,
        "disabled-channel",
        vec![AnnotationOperation::Create {
            id: None,
            annotation,
        }],
    );
    assert!(service.apply_annotations(caller(), &request).is_err());
    let mut annotation = input(3);
    annotation.end_sample = Some(6.into());
    let request = ApplyAnnotationsRequest {
        operations: vec![AnnotationOperation::Create {
            id: None,
            annotation,
        }],
        request_id: "wrong-kind".into(),
        ..request
    };
    assert!(service.apply_annotations(caller(), &request).is_err());
}

#[test]
fn all_marker_kinds_share_gui_document_and_persist_exact_boundaries() {
    let service = service();
    service.set_gui_attached("session-a", true).unwrap();
    let mut point = input(3);
    point.kind = AnnotationKind::TimingPoint;
    point.channel = None;
    let mut pair = point.clone();
    pair.kind = AnnotationKind::TimingPair;
    pair.end_sample = Some(3.into());
    let mut range = input(3);
    range.kind = AnnotationKind::RangeAnnotation;
    range.end_sample = Some(16.into());
    let result = service
        .apply_annotations(
            caller(),
            &request(
                &service,
                "kinds",
                vec![
                    AnnotationOperation::Create {
                        id: Some("point".into()),
                        annotation: point,
                    },
                    AnnotationOperation::Create {
                        id: Some("pair".into()),
                        annotation: pair.clone(),
                    },
                    AnnotationOperation::Create {
                        id: Some("range".into()),
                        annotation: range,
                    },
                ],
            ),
        )
        .unwrap();
    assert_eq!(
        service.gui_snapshot("session-a").unwrap().annotations.len(),
        3
    );
    pair.end_sample = Some(16.into());
    assert!(service
        .apply_annotations(
            caller(),
            &request(
                &service,
                "outside-point",
                vec![AnnotationOperation::Update {
                    id: "pair".into(),
                    annotation: pair
                }]
            )
        )
        .is_err());
    let metadata = service
        .project_metadata(
            &result.capture,
            sigpilot_file::SaleaeSessionMetadata::default(),
        )
        .unwrap();
    assert!(metadata.user_annotations.is_empty());
    assert_eq!(metadata.workbench_annotations.len(), 3);
    let reopened = crate::tests::service();
    reopened.set_gui_attached("session-a", true).unwrap();
    reopened
        .restore_annotations("session-a", &metadata)
        .unwrap();
    let snapshot = reopened.gui_snapshot("session-a").unwrap();
    assert_eq!(
        snapshot
            .annotations
            .iter()
            .find(|a| a.id == "range")
            .unwrap()
            .value
            .end_sample
            .unwrap()
            .0,
        16
    );
    assert_eq!(
        snapshot
            .annotations
            .iter()
            .find(|a| a.id == "pair")
            .unwrap()
            .value
            .end_sample
            .unwrap()
            .0,
        3
    );
}

#[test]
fn pagination_is_revision_bound_and_source_is_kept_on_edit() {
    let service = service();
    let create = request(
        &service,
        "create",
        vec![
            AnnotationOperation::Create {
                id: None,
                annotation: input(1),
            },
            AnnotationOperation::Create {
                id: None,
                annotation: input(2),
            },
        ],
    );
    let result = service.apply_annotations(caller(), &create).unwrap();
    let a = service
        .list_annotations(&result.capture, 1, None, 1)
        .unwrap();
    let b = service
        .list_annotations(&result.capture, 1, a.next_after_id.as_deref(), 1)
        .unwrap();
    assert_eq!(a.annotations.len(), 1);
    assert_eq!(b.annotations.len(), 1);
    assert_ne!(a.annotations[0].id, b.annotations[0].id);
    let edit = request(
        &service,
        "edit",
        vec![AnnotationOperation::Update {
            id: a.annotations[0].id.clone(),
            annotation: input(9),
        }],
    );
    let edited = service
        .apply_annotations(
            Caller {
                id: "gui",
                source: AnnotationSource::User,
            },
            &edit,
        )
        .unwrap();
    assert_eq!(edited.upserts[0].source, AnnotationSource::Assistant);
    assert!(matches!(
        service.list_annotations(&result.capture, 1, None, 1),
        Err(WorkbenchError::AnnotationVersionConflict(2))
    ));
}

#[test]
fn replacing_capture_invalidates_references_and_marks() {
    let service = service();
    let request = request(
        &service,
        "create",
        vec![AnnotationOperation::Create {
            id: None,
            annotation: input(4),
        }],
    );
    service.apply_annotations(caller(), &request).unwrap();
    let session = service.existing_session("session-a").unwrap();
    let capture = session.graph.capture().unwrap();
    session
        .graph
        .replace_capture(capture.as_ref().clone())
        .unwrap();
    assert!(matches!(
        service.apply_annotations(caller(), &request),
        Err(WorkbenchError::CaptureVersionConflict)
    ));
    let context = service.context("session-a").unwrap();
    assert_ne!(context.capture.capture_id, request.capture.capture_id);
    assert_eq!(context.annotation_count.0, 0);
}

#[test]
fn slow_event_subscribers_are_disconnected_without_unbounded_queues() {
    let service = service();
    let events = service.subscribe().unwrap();
    for index in 0..17 {
        service.publish(WorkbenchEvent::SessionReleased {
            session_id: format!("session-{index}"),
        });
    }
    for _ in 0..16 {
        events.recv().unwrap();
    }
    assert!(events.recv().is_err());
    assert!(service.subscribe().is_ok());
}

#[test]
fn project_save_and_restore_keep_ids_samples_and_assistant_provenance() {
    let service = service();
    service.set_gui_attached("session-a", true).unwrap();
    let mut request = request(
        &service,
        "create-persisted",
        vec![AnnotationOperation::Create {
            id: Some("stable-gui-id".into()),
            annotation: input(7),
        }],
    );
    let result = service.apply_annotations(caller(), &request).unwrap();
    request.request_id = "collision".into();
    request.expected_annotation_revision = 1.into();
    assert!(service.apply_annotations(caller(), &request).is_err());
    let metadata = service
        .project_metadata(&result.capture, Default::default())
        .unwrap();
    assert_eq!(metadata.user_annotations[0].sample, 7);
    let path = std::env::temp_dir().join(format!("sigpilot-workbench-{}.pxl", service.runtime_id));
    service
        .save_project("session-a", &path, Default::default())
        .unwrap();
    let saved_project = sigpilot_file::open_pxl(&path).unwrap();
    std::fs::remove_file(path).unwrap();
    assert_eq!(
        saved_project.session.workbench_annotations,
        metadata.workbench_annotations
    );
    let restored = self::service();
    restored
        .restore_annotations("session-a", &metadata)
        .unwrap();
    let snapshot = restored.gui_snapshot("session-a").unwrap();
    assert_eq!(snapshot.annotations[0], result.upserts[0]);
    assert_eq!(snapshot.annotations[0].source, AnnotationSource::Assistant);
}

#[test]
fn trim_rebases_retained_annotations_and_invalidates_old_writes() {
    let service = service();
    let create = request(
        &service,
        "before-trim",
        vec![
            AnnotationOperation::Create {
                id: None,
                annotation: input(2),
            },
            AnnotationOperation::Create {
                id: None,
                annotation: input(7),
            },
        ],
    );
    let before = service.apply_annotations(caller(), &create).unwrap();
    service.trim_capture("session-a", 4, 12).unwrap();
    let after = service.gui_snapshot("session-a").unwrap();
    assert_ne!(after.context.capture.capture_id, before.capture.capture_id);
    assert_eq!(after.annotations.len(), 1);
    assert_eq!(after.annotations[0].value.sample.0, 3);
    assert_eq!(after.annotations[0].source, AnnotationSource::Assistant);
    assert!(matches!(
        service.apply_annotations(caller(), &create),
        Err(WorkbenchError::CaptureVersionConflict)
    ));
}
