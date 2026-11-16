//! Result-bound cross-frame queries. The retained decode and each returned
//! evidence record refer to the same finalized capture, never GUI table rows.
use crate::{evidence::EvidenceDraft, jobs::JobOutput, Result, WorkbenchError, WorkbenchService};
use serde_json::{json, Value};
use sigpilot_analysis::{
    frames::ProtocolFrame,
    protocol::{query_frame_sequence, query_transactions, FrameSequenceQuery, TransactionQuery},
};
use std::sync::atomic::AtomicBool;

pub(crate) fn frame_value(frame: &ProtocolFrame, result_id: &str) -> Result<Value> {
    let mut value = serde_json::to_value(frame)?;
    value["frame_ref"] = json!({"result_set_id":result_id,"frame_id":frame.frame_id});
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::jobs::JobState;
    use sigpilot_analysis::{
        frames::{FieldFilter, FieldOperator, FieldSchema, FieldValue, FrameQuery, FrameSet},
        protocol::{FrameSequenceStep, SequenceScope},
        SampleRange,
    };
    use std::{
        collections::{BTreeMap, BTreeSet},
        sync::Arc,
        time::{Duration, Instant},
    };
    fn fixture() -> FrameSet {
        let rows = [
            ("start", 1, None, None),
            ("address", 2, Some(80), Some(true)),
            ("data", 3, None, Some(true)),
            ("start", 5, None, None),
            ("address", 6, Some(81), Some(true)),
            ("data", 7, None, Some(false)),
            ("stop", 9, None, None),
            ("start", 11, None, None),
            ("address", 12, Some(81), Some(true)),
            ("data", 13, None, Some(false)),
            ("stop", 15, None, None),
        ];
        let frames = rows
            .into_iter()
            .enumerate()
            .map(|(i, (row, sample, address, ack))| {
                let mut fields = BTreeMap::new();
                if let Some(a) = address {
                    fields.insert("address".into(), FieldValue::Unsigned(a.into()));
                }
                if let Some(a) = ack {
                    fields.insert("ack".into(), FieldValue::Boolean(a));
                }
                ProtocolFrame {
                    frame_id: (i as u64 + 1).into(),
                    range: SampleRange::new(sample, sample + 1, 16).unwrap(),
                    row: row.into(),
                    texts: vec![],
                    fields,
                    configured_channels: vec![0],
                    native_start_sample: sample.into(),
                    native_end_sample: (sample + 1).into(),
                    native_endpoint_policy: "exclusive".into(),
                }
            })
            .collect::<Vec<_>>();
        FrameSet {
            backend: "fixture".into(),
            backend_protocol: "I2C".into(),
            protocol: "I2C".into(),
            processed_range: SampleRange::new(0, 16, 16).unwrap(),
            requested_range: SampleRange::new(0, 16, 16).unwrap(),
            field_schema: vec![
                FieldSchema {
                    name: "address".into(),
                    types: BTreeSet::from([sigpilot_analysis::frames::FieldType::Unsigned]),
                    rows: BTreeSet::from(["address".into()]),
                },
                FieldSchema {
                    name: "ack".into(),
                    types: BTreeSet::from([sigpilot_analysis::frames::FieldType::Boolean]),
                    rows: BTreeSet::from(["address".into(), "data".into()]),
                },
            ],
            schema_scope: "fixture".into(),
            configuration: json!({"protocol":"I2C"}),
            frames,
            diagnostics: vec![],
        }
    }
    fn submit(service: &WorkbenchService, owner: &str, request: &str) -> String {
        let capture = service.context("session-a").unwrap().capture;
        let job = service
            .jobs
            .submit(
                owner,
                capture,
                "decode",
                request,
                request.into(),
                Box::new(|_| Ok(JobOutput::Decode(fixture()))),
            )
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            let state = service.jobs.get(owner, &job.job_id).unwrap().state;
            if state == JobState::Completed {
                break;
            }
            assert_eq!(state == JobState::Failed, false);
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(2));
        }
        job.job_id
    }
    fn sequence() -> FrameSequenceQuery {
        FrameSequenceQuery {
            schema_version: "1".into(),
            scope: SequenceScope::I2cSegment,
            range: None,
            steps: vec![
                FrameSequenceStep {
                    query: FrameQuery {
                        rows: vec!["address".into()],
                        ..Default::default()
                    },
                    within: None,
                },
                FrameSequenceStep {
                    query: FrameQuery {
                        rows: vec!["data".into()],
                        ..Default::default()
                    },
                    within: None,
                },
            ],
        }
    }
    #[test]
    fn sequence_cursor_is_owned_result_and_query_bound_and_evidence_is_capture_bound() {
        let service = Arc::new(crate::tests::service());
        let result = submit(&service, "owner", "first");
        let first = service
            .query_decode_sequence("owner", &result, sequence(), None, 1)
            .unwrap();
        assert_eq!(first["total_matches"], "3");
        assert_eq!(
            first["items"][0]["frames"][0]["frame_ref"]["result_set_id"],
            result
        );
        let cursor = first["next_cursor"].as_str().unwrap();
        let next = service
            .query_decode_sequence("owner", &result, sequence(), Some(cursor), 1)
            .unwrap();
        assert_eq!(next["items"][0]["frames"][0]["frame_id"], "5");
        let replay = service
            .query_decode_sequence("owner", &result, sequence(), Some(cursor), 1)
            .unwrap();
        assert_eq!(replay["items"][0]["frames"], next["items"][0]["frames"]);
        let mut changed = sequence();
        changed.scope = SequenceScope::Stream;
        assert!(service
            .query_decode_sequence("owner", &result, changed, Some(cursor), 1)
            .is_err());
        assert!(service
            .query_decode_transactions(
                "owner",
                &result,
                TransactionQuery::default(),
                Some(cursor),
                1
            )
            .is_err());
        let other = submit(&service, "owner", "second");
        assert!(service
            .query_decode_sequence("owner", &other, sequence(), Some(cursor), 1)
            .is_err());
        assert!(matches!(
            service.query_decode_sequence("stranger", &result, sequence(), None, 1),
            Err(WorkbenchError::JobNotFound)
        ));
        let foreign = submit(&service, "stranger", "foreign");
        assert!(service
            .query_decode_sequence("stranger", &foreign, sequence(), Some(cursor), 1)
            .is_err());
        let capture = service.context("session-a").unwrap().capture;
        let proof = service
            .get_evidence(
                &capture,
                &[first["items"][0]["evidence_ref"].as_str().unwrap().into()],
                0.into(),
            )
            .unwrap();
        assert_eq!(proof["evidence"][0]["parameters"]["result_set_id"], result);
        assert_eq!(
            proof["evidence"][0]["observed"]["frames"][0]["frame_id"],
            "2"
        );
        service.trim_capture("session-a", 0, 10).unwrap();
        let mut empty = sequence();
        empty.steps[0].query.rows = vec!["absent".into()];
        assert!(matches!(
            service.query_decode_sequence("owner", &result, empty, None, 1),
            Err(WorkbenchError::CaptureVersionConflict)
        ));
    }
    #[test]
    fn transaction_paging_returns_segment_evidence_and_parent_metadata() {
        let service = crate::tests::service();
        let result = submit(&service, "owner", "transactions");
        let query = TransactionQuery {
            conditions: vec![FrameQuery {
                fields: vec![FieldFilter {
                    name: "ack".into(),
                    op: FieldOperator::Eq,
                    value: Some(FieldValue::Boolean(false)),
                }],
                ..Default::default()
            }],
            require_complete: true,
            range: None,
        };
        let first = service
            .query_decode_transactions("owner", &result, query.clone(), None, 1)
            .unwrap();
        assert_eq!(first["filter_scope"], "same_i2c_segment");
        assert_eq!(first["items"][0]["segment_ref"]["segment_id"], "4");
        assert_eq!(first["items"][0]["transaction"]["segment_count"], "2");
        assert_eq!(
            first["items"][0]["condition_frames"][0]["frame_ref"]["frame_id"],
            "6"
        );
        let cursor = first["next_cursor"].as_str().unwrap();
        let next = service
            .query_decode_transactions("owner", &result, query, Some(cursor), 1)
            .unwrap();
        assert_eq!(next["complete"], true);
        assert_eq!(next["items"][0]["transaction_ref"]["transaction_id"], "8");
        let capture = service.context("session-a").unwrap().capture;
        let proof = service
            .get_evidence(
                &capture,
                &[first["items"][0]["evidence_ref"].as_str().unwrap().into()],
                0.into(),
            )
            .unwrap();
        assert_eq!(proof["evidence"][0]["range"]["start_sample"], "5");
        assert_eq!(proof["evidence"][0]["observed"]["termination"], "stop");
        assert!(service
            .query_decode_transactions("owner", &result, TransactionQuery::default(), None, 101)
            .is_err());
    }
}
fn channels(frames: &[ProtocolFrame]) -> Vec<u8> {
    let mut channels: Vec<_> = frames
        .iter()
        .flat_map(|f| f.configured_channels.iter().copied())
        .collect();
    channels.sort_unstable();
    channels.dedup();
    channels
}
impl WorkbenchService {
    pub fn protocol_query_capabilities(&self) -> Value {
        json!({"sequence":{"schema_version":"1","scopes":["stream","i2c_segment"],"max_steps":8,"max_comparisons":"1000000",
            "delay_anchor":"frame_start","delay_bounds":"inclusive","selection":"earliest_completable_chain_per_initial_frame"},
            "transactions":{"protocols":["I2C"],"filter_scope":"same_i2c_segment","parent_boundary":"START_to_STOP",
                "repeated_start":"new_segment_same_transaction","incomplete_boundaries":"explicit"},
            "correlation":{"event_anchor":"frame_start","pulse_anchor":"pulse_start","window_bounds":"inclusive","max_edges_per_page":"4096",
                "max_pulse_candidates_per_page":"1000","interpretation":"temporal_cooccurrence","selection":"all_pairs_in_window"},
            "max_page_items":100,"max_query_bytes":"16384","max_frame_payload_bytes":"131072","max_frames":"4096"})
    }

    pub fn query_decode_sequence(
        &self,
        owner: &str,
        result_id: &str,
        query: FrameSequenceQuery,
        cursor: Option<&str>,
        limit: usize,
    ) -> Result<Value> {
        self.query_decode_sequence_with_cancel(
            owner,
            result_id,
            query,
            cursor,
            limit,
            &AtomicBool::new(false),
        )
    }
    pub fn query_decode_sequence_with_cancel(
        &self,
        owner: &str,
        result_id: &str,
        query: FrameSequenceQuery,
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
        let serialized = format!("sequence:{}", serde_json::to_string(&query)?);
        let offset = self.frame_query_offset(owner, result_id, &serialized, cursor)?;
        let page = query_frame_sequence(set, &query, offset, limit, cancel)
            .map_err(WorkbenchError::from)?;
        crate::check_cancelled(cancel)?;
        let evidence=self.record_result_evidence(&capture,result_id,page.items.iter().map(|item|EvidenceDraft {
            range:item.range,channels:channels(&item.frames),provider_id:"sigpilot.frame_sequence".into(),provider_version:"1".into(),
            parameters:json!({"result_set_id":result_id,"query":query,"configuration":set.configuration}),observed:json!(item),
        }).collect())?;
        let mut items = Vec::new();
        for (item, record) in page.items.iter().zip(evidence) {
            let frames = item
                .frames
                .iter()
                .map(|f| frame_value(f, result_id))
                .collect::<Result<Vec<_>>>()?;
            items.push(
                json!({"range":item.range,"frames":frames,"evidence_ref":record.evidence_ref}),
            );
        }
        self.validate_capture(&capture)?;
        crate::check_cancelled(cancel)?;
        let cursor = self.frame_query_cursor(owner, result_id, serialized, page.next_offset);
        Ok(
            json!({"capture":capture,"result_set_id":result_id,"items":items,"candidate_counts":page.candidate_counts,
            "comparisons":page.comparisons,"inspected_frames":page.inspected_frames,"total_matches":page.total_matches,
            "search_complete":page.search_complete,"complete":page.complete,"truncated":!page.complete,"stop_reason":page.stop_reason,"next_cursor":cursor,
            "processed_range":set.processed_range,"requested_range":set.requested_range,"filter_scope":query.scope,"delay_anchor":"frame_start",
            "selection":"earliest_completable_chain_per_initial_frame","missing_fields":"unknown_does_not_match"}),
        )
    }

    pub fn query_decode_transactions(
        &self,
        owner: &str,
        result_id: &str,
        query: TransactionQuery,
        cursor: Option<&str>,
        limit: usize,
    ) -> Result<Value> {
        self.query_decode_transactions_with_cancel(
            owner,
            result_id,
            query,
            cursor,
            limit,
            &AtomicBool::new(false),
        )
    }
    pub fn query_decode_transactions_with_cancel(
        &self,
        owner: &str,
        result_id: &str,
        query: TransactionQuery,
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
        let serialized = format!("transactions:{}", serde_json::to_string(&query)?);
        let offset = self.frame_query_offset(owner, result_id, &serialized, cursor)?;
        let page =
            query_transactions(set, &query, offset, limit, cancel).map_err(WorkbenchError::from)?;
        crate::check_cancelled(cancel)?;
        let evidence=self.record_result_evidence(&capture,result_id,page.items.iter().map(|item|EvidenceDraft {
            range:item.range,channels:set.frames.first().map_or_else(Vec::new,|f|f.configured_channels.clone()),
            provider_id:"sigpilot.i2c_transactions".into(),provider_version:"1".into(),
            parameters:json!({"result_set_id":result_id,"query":query,"configuration":set.configuration}),observed:json!(item),
        }).collect())?;
        let mut items = Vec::new();
        for (item, record) in page.items.iter().zip(evidence) {
            let mut value = serde_json::to_value(item)?;
            value["condition_frames"] = json!(item
                .condition_frames
                .iter()
                .map(|f| frame_value(f, result_id))
                .collect::<Result<Vec<_>>>()?);
            value["transaction_ref"] =
                json!({"result_set_id":result_id,"transaction_id":item.transaction.transaction_id});
            value["segment_ref"] = json!({"result_set_id":result_id,"segment_id":item.segment_id});
            value["evidence_ref"] = json!(record.evidence_ref);
            items.push(value);
        }
        self.validate_capture(&capture)?;
        crate::check_cancelled(cancel)?;
        let cursor = self.frame_query_cursor(owner, result_id, serialized, page.next_offset);
        Ok(
            json!({"capture":capture,"result_set_id":result_id,"items":items,"inspected_frames":page.inspected_frames,
            "complete":page.complete,"truncated":!page.complete,"next_cursor":cursor,"processed_range":set.processed_range,"requested_range":set.requested_range,
            "filter_scope":"same_i2c_segment","context_scope":"processed_prefix","witnesses_may_precede_requested_range":true,
            "missing_fields":"unknown_does_not_match"}),
        )
    }
}
