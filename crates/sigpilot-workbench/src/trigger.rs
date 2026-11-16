use crate::{
    jobs::{JobFailure, JobOutput, JobSnapshot},
    CaptureRef, Result, WorkbenchError, WorkbenchService,
};
use serde_json::{json, Value};
use sigpilot_analysis::{
    trigger::{Signal, TriggerRule},
    SampleRange,
};
use std::{
    collections::BTreeMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

impl WorkbenchService {
    pub fn validate_trigger(&self, capture: &CaptureRef, rule: &TriggerRule) -> Result<Value> {
        let context = self.context(&capture.session_id)?;
        self.validate_capture(capture)?;
        let enabled = if context.enabled_channels.is_empty() {
            (0..context.channel_count).collect::<Vec<_>>()
        } else {
            context.enabled_channels
        };
        Ok(
            json!({"capture":capture,"validation":sigpilot_analysis::trigger::validate(rule,&enabled),"rule":rule}),
        )
    }

    pub fn simulate_trigger(
        self: &Arc<Self>,
        owner: &str,
        capture: CaptureRef,
        range: SampleRange,
        rule: TriggerRule,
        limit: usize,
        request_id: &str,
    ) -> Result<JobSnapshot> {
        let context = self.context(&capture.session_id)?;
        self.validate_capture(&capture)?;
        range
            .validate(context.sample_count.0)
            .map_err(|e| WorkbenchError::InvalidRequest(e.to_string()))?;
        let enabled = if context.enabled_channels.is_empty() {
            (0..context.channel_count).collect::<Vec<_>>()
        } else {
            context.enabled_channels
        };
        let validation = sigpilot_analysis::trigger::validate(&rule, &enabled);
        if !validation.valid || limit == 0 || limit > 1000 {
            return Err(WorkbenchError::InvalidRequest(
                "invalid trigger rule or result limit".into(),
            ));
        }
        let input = serde_json::to_string(
            &json!({"capture":capture,"range":range,"rule":rule,"limit":limit}),
        )?;
        let weak = Arc::downgrade(self);
        let job_capture = capture.clone();
        self.jobs.submit(
            owner,
            capture,
            "trigger_simulation",
            request_id,
            input,
            Box::new(move |cancel| {
                let service = weak
                    .upgrade()
                    .ok_or_else(|| JobFailure::new("SESSION_NOT_FOUND", "workbench exited"))?;
                let signals = if validation.satisfiability == "proven_unsatisfiable" {
                    validation
                        .channels
                        .iter()
                        .map(|c| {
                            (
                                *c,
                                Signal {
                                    high_before_start: false,
                                    previous_edge: None,
                                    edges: vec![],
                                    next_edge: None,
                                },
                            )
                        })
                        .collect()
                } else {
                    service.trigger_signals(&job_capture, range, &validation.channels, cancel)?
                };
                let result = sigpilot_analysis::trigger::simulate(
                    &rule, range, &signals, &enabled, limit, cancel,
                )
                .map_err(|e| {
                    JobFailure::new(
                        if matches!(e, sigpilot_analysis::AnalysisError::Cancelled) {
                            "CANCELLED"
                        } else {
                            "INVALID_INPUT"
                        },
                        e.to_string(),
                    )
                })?;
                service
                    .validate_capture(&job_capture)
                    .map_err(|e| JobFailure::new("VERSION_CONFLICT", e.to_string()))?;
                let drafts = result
                    .matches
                    .iter()
                    .map(|m| crate::evidence::EvidenceDraft {
                        range: m.range,
                        channels: validation.channels.clone(),
                        provider_id: "sigpilot.trigger_simulation".into(),
                        provider_version: "1".into(),
                        parameters: json!({"rule":rule}),
                        observed: json!(m),
                    })
                    .collect();
                let records = service
                    .record_evidence(&job_capture, drafts)
                    .map_err(|e| JobFailure::new("RESOURCE_LIMIT", e.to_string()))?;
                let mut result = serde_json::to_value(result)
                    .map_err(|e| JobFailure::new("INTERNAL_ERROR", e.to_string()))?;
                for (m, e) in result["matches"]
                    .as_array_mut()
                    .unwrap()
                    .iter_mut()
                    .zip(records)
                {
                    m["evidence_ref"] = json!(e.evidence_ref);
                }
                if serde_json::to_vec(&result)
                    .map_err(|e| JobFailure::new("INTERNAL_ERROR", e.to_string()))?
                    .len()
                    > 180 * 1024
                {
                    return Err(JobFailure::new(
                        "RESOURCE_LIMIT",
                        "trigger result exceeds response budget; reduce limit",
                    ));
                }
                Ok(JobOutput::Analysis(
                    json!({"capture":job_capture,"validation":validation,"simulation":result}),
                ))
            }),
        )
    }

    fn trigger_signals(
        &self,
        capture: &CaptureRef,
        range: SampleRange,
        channels: &[u8],
        cancel: &AtomicBool,
    ) -> std::result::Result<BTreeMap<u8, Signal>, JobFailure> {
        let mut signals = BTreeMap::new();
        let mut edges = 0;
        for &channel in channels {
            let mut start = range.start_sample;
            let mut signal = None;
            loop {
                if cancel.load(Ordering::Acquire) {
                    return Err(JobFailure::new("CANCELLED", "trigger read cancelled"));
                }
                let window = self
                    .edge_window(
                        capture,
                        channel,
                        SampleRange {
                            start_sample: start,
                            end_sample: range.end_sample,
                        },
                    )
                    .map_err(|e| JobFailure::new("VERSION_CONFLICT", e.to_string()))?
                    .window;
                edges += window.transitions.len();
                if edges > sigpilot_analysis::trigger::MAX_TRIGGER_EDGES {
                    return Err(JobFailure::new(
                        "RESOURCE_LIMIT",
                        "trigger input exceeds 65536 edges; use a smaller range",
                    ));
                }
                let trace = signal.get_or_insert_with(|| Signal {
                    high_before_start: window.high_before_start,
                    previous_edge: window.previous_transition,
                    edges: vec![],
                    next_edge: None,
                });
                trace.edges.extend(window.transitions);
                trace.next_edge = window.next_transition;
                if window.complete {
                    break;
                }
                start = window.end_sample.into();
            }
            signals.insert(channel, signal.unwrap());
        }
        Ok(signals)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::jobs::JobState;
    use sigpilot_analysis::{
        trigger::{Event, Guard, Phase, Step},
        EdgeDirection, ExactU64,
    };
    #[test]
    fn replay_job_keeps_stage_evidence_and_current_capture_reference() {
        let service = Arc::new(crate::tests::service());
        let capture = service.context("session-a").unwrap().capture;
        let mut data = service
            .session("session-a")
            .unwrap()
            .graph
            .capture()
            .unwrap()
            .as_ref()
            .clone();
        data.samples = vec![0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0];
        service
            .session("session-a")
            .unwrap()
            .graph
            .replace_capture(data)
            .unwrap();
        assert!(service
            .validate_trigger(
                &capture,
                &TriggerRule {
                    schema_version: "1".into(),
                    steps: vec![],
                    holdoff_samples: 0.into()
                }
            )
            .is_err());
        let capture = service.context("session-a").unwrap().capture;
        let rule = TriggerRule {
            schema_version: "1".into(),
            steps: vec![Step {
                event: Event::Edge {
                    channel: 0,
                    direction: EdgeDirection::Rising,
                },
                guards: vec![Guard {
                    channel: 0,
                    high: false,
                    phase: Phase::Before,
                }],
                within: None,
            }],
            holdoff_samples: ExactU64(0),
        };
        let submitted = service
            .simulate_trigger(
                "owner",
                capture.clone(),
                SampleRange::new(0, 16, 16).unwrap(),
                rule,
                100,
                "replay",
            )
            .unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        let job = loop {
            let job = service.jobs.get("owner", &submitted.job_id).unwrap();
            if matches!(job.state, JobState::Completed | JobState::Failed) {
                break job;
            }
            assert!(std::time::Instant::now() < deadline);
            std::thread::sleep(std::time::Duration::from_millis(2));
        };
        assert_eq!(job.state, JobState::Completed, "{:?}", job.error);
        let result = job.result.unwrap();
        assert_eq!(result["simulation"]["total_matches"], "2");
        let reference = result["simulation"]["matches"][0]["evidence_ref"]
            .as_str()
            .unwrap();
        let evidence = service
            .get_evidence(&capture, &[reference.into()], 0.into())
            .unwrap();
        assert_eq!(evidence["evidence"][0]["observed"]["anchor_sample"], "2");
    }
}
