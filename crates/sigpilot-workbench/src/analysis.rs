use crate::{evidence::EvidenceDraft, CaptureRef, Result, WorkbenchError, WorkbenchService};
use serde_json::{json, Value};
use sigpilot_analysis::{
    providers::{AnalysisProvider, ProviderContext},
    SampleRange,
};
use std::{
    collections::BTreeSet,
    sync::{atomic::AtomicBool, Arc},
};
impl WorkbenchService {
    /// Trusted host registration only; no MCP tool installs providers.
    pub fn register_analysis_provider(&self, provider: Arc<dyn AnalysisProvider>) -> Result<()> {
        self.providers
            .write()
            .register(provider)
            .map_err(|e| WorkbenchError::InvalidRequest(e.to_string()))
    }
    pub fn analysis_capabilities(&self) -> Value {
        json!(self.providers.read().catalog())
    }
    pub fn run_analysis_page(
        &self,
        capture: &CaptureRef,
        provider_id: &str,
        channel: u8,
        original_range: SampleRange,
        start: u64,
        parameters: Value,
    ) -> Result<Value> {
        self.run_analysis_page_with_cancel(
            capture,
            provider_id,
            channel,
            original_range,
            start,
            parameters,
            &AtomicBool::new(false),
        )
    }
    pub fn run_analysis_page_with_cancel(
        &self,
        capture: &CaptureRef,
        provider_id: &str,
        channel: u8,
        original_range: SampleRange,
        start: u64,
        parameters: Value,
        cancel: &AtomicBool,
    ) -> Result<Value> {
        crate::check_cancelled(cancel)?;
        if start < original_range.start_sample.0 {
            return Err(WorkbenchError::InvalidRequest(
                "continuation precedes original_range".into(),
            ));
        }
        let p = self
            .providers
            .read()
            .get(provider_id)
            .ok_or(WorkbenchError::ProviderNotFound)?;
        p.validate_parameters(&parameters)
            .map_err(|e| WorkbenchError::InvalidRequest(e.to_string()))?;
        let w = self.edge_window(
            capture,
            channel,
            SampleRange {
                start_sample: start.into(),
                end_sample: original_range.end_sample,
            },
        )?;
        let d = p.descriptor();
        if w.window.transitions.len() > d.max_edges_per_page.0 as usize {
            return Err(WorkbenchError::ResourceLimit("provider edge budget"));
        }
        let requests = p
            .related_channels(channel, &parameters)
            .map_err(WorkbenchError::from)?;
        let mut channels = BTreeSet::from([channel]);
        if requests.len() > 7 || requests.iter().any(|r| !channels.insert(r.channel)) {
            return Err(WorkbenchError::InvalidRequest(
                "provider inputs require distinct channels, maximum eight".into(),
            ));
        }
        let mut related_windows = Vec::with_capacity(requests.len());
        for request in requests {
            crate::check_cancelled(cancel)?;
            let end = original_range
                .end_sample
                .0
                .saturating_add(request.lookahead_samples)
                .min(w.window.capture_sample_count);
            let related = self.edge_window(
                capture,
                request.channel,
                SampleRange {
                    start_sample: start.into(),
                    end_sample: end.into(),
                },
            )?;
            if related.window.transitions.len() > d.max_edges_per_page.0 as usize {
                return Err(WorkbenchError::ResourceLimit(
                    "provider related channel edge budget",
                ));
            }
            related_windows.push(related.window);
        }
        let output = p
            .run(
                ProviderContext {
                    window: &w.window,
                    related_windows: &related_windows,
                    original_range,
                    cancelled: cancel,
                },
                parameters.clone(),
            )
            .map_err(WorkbenchError::from)?;
        crate::check_cancelled(cancel)?;
        if output.evidence.len() > d.max_results_per_page.0 as usize
            || serde_json::to_vec(&output.value)?.len() > 128 * 1024
        {
            return Err(WorkbenchError::ResourceLimit("provider output"));
        }
        if !output.value.is_object()
            || !output.value["complete"].is_boolean()
            || !output.value["coverage"].is_object()
        {
            return Err(WorkbenchError::InvalidRequest(
                "provider result requires object, coverage and complete".into(),
            ));
        }
        let coverage: SampleRange = serde_json::from_value(output.value["coverage"].clone())?;
        if coverage.start_sample.0 != start || coverage.end_sample > w.window.end_sample.into() {
            return Err(WorkbenchError::InvalidRequest(
                "provider coverage exceeds original edge page".into(),
            ));
        }
        crate::check_cancelled(cancel)?;
        let evidence=self.record_evidence(capture,output.evidence.into_iter().map(|e|EvidenceDraft{range:e.range,channels:e.channels,provider_id:d.provider_id.clone(),
            provider_version:d.version.clone(),parameters:json!({"parameters":parameters,"original_range":original_range,"start_sample":start.to_string()}),observed:e.observed}).collect())?;
        let mut page = output.value;
        if let Some(items) = page["items"].as_array_mut() {
            for (item, e) in items.iter_mut().zip(&evidence) {
                item["evidence_ref"] = json!(e.evidence_ref);
            }
        }
        Ok(
            json!({"capture":capture,"provider_id":provider_id,"provider_version":d.version,"page":page,"evidence_refs":evidence.iter().map(|e|&e.evidence_ref).collect::<Vec<_>>()}),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sigpilot_core::{CaptureData, SparseCaptureData, SparseDigitalChannel};
    fn fixture(sparse: bool) -> WorkbenchService {
        let service = crate::tests::service();
        let session = service.session("session-a").unwrap();
        let mut metadata = session.graph.capture_snapshot().unwrap().metadata;
        metadata.enabled_channels = vec![0, 1];
        metadata.sample_count = 40;
        let edges = [vec![10, 15, 20], vec![7, 12, 20, 23]];
        if sparse {
            session
                .graph
                .replace_sparse_capture(SparseCaptureData {
                    metadata,
                    channels: edges
                        .into_iter()
                        .enumerate()
                        .map(|(i, transitions)| SparseDigitalChannel {
                            channel: i as u8,
                            initial_high: false,
                            transitions,
                        })
                        .collect(),
                })
                .unwrap();
        } else {
            let samples = (0..40)
                .map(|s| {
                    edges.iter().enumerate().fold(0u8, |value, (i, e)| {
                        value | (((e.iter().filter(|&&t| t <= s).count() % 2) as u8) << i)
                    })
                })
                .collect();
            session
                .graph
                .replace_capture(CaptureData { metadata, samples })
                .unwrap();
        }
        service
    }
    fn parameters() -> Value {
        json!({"mode":"setup_hold","data_channel":1,"anchor_direction":"rising","min_setup_samples":"3","min_hold_samples":"2"})
    }
    #[test]
    fn multi_channel_inputs_agree_for_dense_and_sparse_and_bind_both_channels_to_evidence() {
        let mut expected = None;
        for sparse in [false, true] {
            let service = fixture(sparse);
            let capture = service.context("session-a").unwrap().capture;
            let result = service
                .run_analysis_page(
                    &capture,
                    "sigpilot.multichannel_timing",
                    0,
                    SampleRange::new(0, 30, 40).unwrap(),
                    0,
                    parameters(),
                )
                .unwrap();
            let mut page = result["page"].clone();
            let refs: Vec<String> =
                serde_json::from_value(result["evidence_refs"].clone()).unwrap();
            let proof = service.get_evidence(&capture, &refs, 0.into()).unwrap();
            assert_eq!(proof["evidence"][0]["channels"], json!([0, 1]));
            assert_eq!(
                proof["evidence"][0]["range"],
                json!({"start_sample":"7","end_sample":"13"})
            );
            assert_eq!(proof["evidence"][1]["observed"]["simultaneous"], true);
            for item in page["items"].as_array_mut().unwrap() {
                item.as_object_mut().unwrap().remove("evidence_ref");
            }
            if let Some(expected) = &expected {
                assert_eq!(&page, expected);
            } else {
                expected = Some(page);
            }
            let mut invalid = parameters();
            invalid["data_channel"] = json!(31);
            assert!(service
                .run_analysis_page(
                    &capture,
                    "sigpilot.multichannel_timing",
                    0,
                    SampleRange::new(0, 30, 40).unwrap(),
                    0,
                    invalid
                )
                .is_err());
            service.trim_capture("session-a", 0, 20).unwrap();
            assert!(matches!(
                service.run_analysis_page(
                    &capture,
                    "sigpilot.multichannel_timing",
                    0,
                    SampleRange::new(0, 30, 40).unwrap(),
                    0,
                    parameters()
                ),
                Err(WorkbenchError::CaptureVersionConflict)
            ));
        }
    }
    #[test]
    fn delay_reads_past_anchor_range_to_finish_the_explicit_response_window() {
        let service = fixture(true);
        let capture = service.context("session-a").unwrap().capture;
        let result=service.run_analysis_page(&capture,"sigpilot.multichannel_timing",0,SampleRange::new(10,11,40).unwrap(),10,
            json!({"mode":"edge_delay","response_channel":1,"anchor_direction":"rising","response_direction":"falling","min_delay_samples":"0","max_delay_samples":"2"})).unwrap();
        assert_eq!(result["page"]["items"][0]["response"]["sample"], "12");
        assert_eq!(result["page"]["items"][0]["delay_samples"], "2");
        assert_eq!(result["page"]["coverage"]["end_sample"], "11");
        assert_eq!(
            result["page"]["input_coverage"][1]["requested_end_sample"],
            "14"
        );
    }
}
