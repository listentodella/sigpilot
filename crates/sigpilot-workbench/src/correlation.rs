//! Bounded event/pulse correlation over an owned decode and the same original
//! capture. Result pagination and edge-scan continuation are kept separate.
use crate::{
    evidence::EvidenceDraft, jobs::JobOutput, protocol::frame_value, Result, WorkbenchError,
    WorkbenchService,
};
use serde_json::{json, Value};
use sigpilot_analysis::{
    correlation::{correlate_pulses, CorrelationQuery},
    SampleRange,
};
use std::sync::atomic::AtomicBool;
impl WorkbenchService {
    pub fn correlate_decode_pulses(
        &self,
        owner: &str,
        result_id: &str,
        channel: u8,
        query: CorrelationQuery,
        start: u64,
        cursor: Option<&str>,
        limit: usize,
    ) -> Result<Value> {
        self.correlate_decode_pulses_with_cancel(
            owner,
            result_id,
            channel,
            query,
            start,
            cursor,
            limit,
            &AtomicBool::new(false),
        )
    }
    pub fn correlate_decode_pulses_with_cancel(
        &self,
        owner: &str,
        result_id: &str,
        channel: u8,
        query: CorrelationQuery,
        start: u64,
        cursor: Option<&str>,
        limit: usize,
        cancel: &AtomicBool,
    ) -> Result<Value> {
        crate::check_cancelled(cancel)?;
        let (capture, output) = self.result_output(owner, result_id)?;
        self.validate_capture(&capture)?;
        let JobOutput::Decode(set) = output.as_ref() else {
            return Err(WorkbenchError::InvalidRequest(
                "result set is not a decode".into(),
            ));
        };
        if start < query.original_range.start_sample.0 {
            return Err(WorkbenchError::InvalidRequest(
                "continuation precedes original_range".into(),
            ));
        }
        let serialized = format!(
            "correlation:{}",
            serde_json::to_string(
                &json!({"channel":channel,"query":query,"start_sample":start.to_string()})
            )?
        );
        let offset = self.frame_query_offset(owner, result_id, &serialized, cursor)?;
        let window = self.edge_window(
            &capture,
            channel,
            SampleRange {
                start_sample: start.into(),
                end_sample: query.original_range.end_sample,
            },
        )?;
        let page = correlate_pulses(set, &window.window, &query, offset, limit, cancel)
            .map_err(WorkbenchError::from)?;
        crate::check_cancelled(cancel)?;
        let mut drafts = Vec::new();
        for item in &page.items {
            drafts.push(EvidenceDraft{range:item.frame.range,channels:item.frame.configured_channels.clone(),provider_id:"sigpilot.decode.frame".into(),provider_version:"1".into(),
                parameters:json!({"result_set_id":result_id,"query":query.events,"configuration":set.configuration}),observed:json!(item.frame)});
            drafts.push(EvidenceDraft{range:item.pulse.range,channels:vec![channel],provider_id:"sigpilot.pulse_width".into(),provider_version:"1".into(),
                parameters:json!({"result_set_id":result_id,"correlation_query":query,"start_sample":start.to_string()}),observed:json!(item.pulse)});
        }
        crate::check_cancelled(cancel)?;
        let evidence = self.record_result_evidence(&capture, result_id, drafts)?;
        let mut items = Vec::new();
        for (item, records) in page.items.iter().zip(evidence.chunks_exact(2)) {
            let mut frame = frame_value(&item.frame, result_id)?;
            frame["evidence_ref"] = json!(records[0].evidence_ref);
            let mut pulse = serde_json::to_value(&item.pulse)?;
            pulse["evidence_ref"] = json!(records[1].evidence_ref);
            items.push(json!({"frame":frame,"pulse":pulse,"delta_samples":item.delta_samples,"evidence_refs":[records[0].evidence_ref,records[1].evidence_ref]}));
        }
        self.validate_capture(&capture)?;
        crate::check_cancelled(cancel)?;
        let cursor = self.frame_query_cursor(owner, result_id, serialized, page.next_offset);
        Ok(
            json!({"capture":capture,"result_set_id":result_id,"items":items,"coverage":page.coverage,"original_range":query.original_range,
            "processed_range":set.processed_range,"requested_range":set.requested_range,"scanned_edges":page.scanned_edges,"inspected_frames":page.inspected_frames,
            "selected_events":page.selected_events,"pulse_candidates":page.pulse_candidates,"pulse_scan_complete":page.pulse_scan_complete,
            "page_complete":page.page_complete,"complete":page.complete,"truncated":!page.complete,"next_cursor":cursor,"next_start_sample":page.next_start_sample,
            "left_boundary_incomplete":page.left_boundary_incomplete,"right_boundary_incomplete":page.right_boundary_incomplete,
            "delta_definition":"pulse_start_minus_frame_start","association_window":"inclusive_around_frame_start","event_semantics":"caller_selected_frames",
            "interpretation":"temporal_cooccurrence","sample_rate_hz":window.window.sample_rate_hz.to_string()}),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::jobs::JobState;
    use sigpilot_analysis::frames::{FrameQuery, FrameSet, ProtocolFrame};
    use sigpilot_core::{CaptureData, SparseCaptureData, SparseDigitalChannel};
    use std::{
        collections::BTreeMap,
        time::{Duration, Instant},
    };
    fn setup(sparse: bool) -> (WorkbenchService, String) {
        let service = crate::tests::service();
        let session = service.existing_session("session-a").unwrap();
        let metadata = session.graph.capture_snapshot().unwrap().metadata.clone();
        if sparse {
            session
                .graph
                .replace_sparse_capture(SparseCaptureData {
                    metadata,
                    channels: vec![SparseDigitalChannel {
                        channel: 0,
                        initial_high: false,
                        transitions: vec![2, 3, 5, 7, 10, 13, 15],
                    }],
                })
                .unwrap();
        } else {
            let samples = (0..16)
                .map(|s| {
                    u8::from([2, 3, 5, 7, 10, 13, 15].iter().filter(|&&t| t <= s).count() % 2 == 1)
                })
                .collect();
            session
                .graph
                .replace_capture(CaptureData { metadata, samples })
                .unwrap();
        }
        let capture = service.context("session-a").unwrap().capture;
        let range = SampleRange::new(0, 16, 16).unwrap();
        let set = FrameSet {
            backend: "fixture".into(),
            backend_protocol: "fixture".into(),
            protocol: "fixture".into(),
            processed_range: range,
            requested_range: range,
            field_schema: vec![],
            schema_scope: "fixture".into(),
            configuration: json!({}),
            diagnostics: vec![],
            frames: [4, 5, 6]
                .into_iter()
                .enumerate()
                .map(|(i, s)| ProtocolFrame {
                    frame_id: (i as u64 + 1).into(),
                    range: SampleRange::new(s, s + 1, 16).unwrap(),
                    row: "selected_event".into(),
                    texts: vec![],
                    fields: BTreeMap::new(),
                    configured_channels: vec![0],
                    native_start_sample: s.into(),
                    native_end_sample: (s + 1).into(),
                    native_endpoint_policy: "exclusive".into(),
                })
                .collect(),
        };
        let job = service
            .jobs
            .submit(
                "owner",
                capture,
                "decode",
                "correlation",
                "fixture".into(),
                Box::new(|_| Ok(JobOutput::Decode(set))),
            )
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        while service.jobs.get("owner", &job.job_id).unwrap().state != JobState::Completed {
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(2));
        }
        (service, job.job_id)
    }
    fn query() -> CorrelationQuery {
        CorrelationQuery {
            events: FrameQuery::default(),
            original_range: SampleRange::new(0, 16, 16).unwrap(),
            before_samples: 1.into(),
            after_samples: 1.into(),
            high: Some(true),
            min_width_samples: 1.into(),
            max_width_exclusive: 3.into(),
        }
    }
    #[test]
    fn dense_and_sparse_agree_and_each_association_has_two_independent_evidence_records() {
        for sparse in [false, true] {
            let (service, result) = setup(sparse);
            let page = service
                .correlate_decode_pulses("owner", &result, 0, query(), 0, None, 100)
                .unwrap();
            assert_eq!(page["complete"], true);
            assert_eq!(page["interpretation"], "temporal_cooccurrence");
            assert_eq!(
                page["items"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|v| v["delta_samples"].as_str().unwrap())
                    .collect::<Vec<_>>(),
                vec!["1", "0", "-1"]
            );
            let item = &page["items"][0];
            assert_eq!(item["frame"]["frame_ref"]["result_set_id"], result);
            let capture = service.context("session-a").unwrap().capture;
            let refs: Vec<String> = serde_json::from_value(item["evidence_refs"].clone()).unwrap();
            let proof = service.get_evidence(&capture, &refs, 0.into()).unwrap();
            assert_eq!(proof["evidence"][0]["range"]["start_sample"], "4");
            assert_eq!(proof["evidence"][1]["range"]["start_sample"], "5");
            assert_eq!(proof["evidence"][1]["observed"]["width_samples"], "2");
        }
    }
    #[test]
    fn result_cursor_binds_scan_parameters_and_stale_or_foreign_results_fail() {
        let (service, result) = setup(true);
        let first = service
            .correlate_decode_pulses("owner", &result, 0, query(), 0, None, 1)
            .unwrap();
        let cursor = first["next_cursor"].as_str().unwrap();
        assert!(first["next_start_sample"].is_null());
        let next = service
            .correlate_decode_pulses("owner", &result, 0, query(), 0, Some(cursor), 1)
            .unwrap();
        assert_eq!(next["items"][0]["delta_samples"], "0");
        assert!(service
            .correlate_decode_pulses("owner", &result, 0, query(), 5, Some(cursor), 1)
            .is_err());
        let mut changed = query();
        changed.after_samples = 0.into();
        assert!(service
            .correlate_decode_pulses("owner", &result, 0, changed, 0, Some(cursor), 1)
            .is_err());
        assert!(matches!(
            service.correlate_decode_pulses("stranger", &result, 0, query(), 0, None, 1),
            Err(WorkbenchError::JobNotFound)
        ));
        service.trim_capture("session-a", 0, 10).unwrap();
        assert!(matches!(
            service.correlate_decode_pulses("owner", &result, 0, query(), 0, None, 1),
            Err(WorkbenchError::CaptureVersionConflict)
        ));
    }
}
