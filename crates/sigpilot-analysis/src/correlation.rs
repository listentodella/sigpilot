//! Temporal cooccurrence between explicitly selected decoded frames and
//! complete original-edge pulses. It makes no assertion about a root cause.
use crate::{
    edges::{scan_pulses, Pulse, PulseQuery},
    frames::{FrameQuery, FrameSet, ProtocolFrame, MAX_DECODE_FRAMES, MAX_FRAME_PAGE_BYTES},
    protocol::{validate_set, MAX_PROTOCOL_QUERY_BYTES},
    AnalysisError, ExactU64, Result, SampleRange,
};
use serde::{Deserialize, Serialize};
use sigpilot_core::DigitalChannelWindow;
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CorrelationQuery {
    pub events: FrameQuery,
    pub original_range: SampleRange,
    pub before_samples: ExactU64,
    pub after_samples: ExactU64,
    pub high: Option<bool>,
    pub min_width_samples: ExactU64,
    pub max_width_exclusive: ExactU64,
}
#[derive(Debug, Clone, Serialize)]
pub struct PulseCorrelation {
    pub frame: ProtocolFrame,
    pub pulse: Pulse,
    pub delta_samples: String,
}
#[derive(Debug, Clone, Serialize)]
pub struct CorrelationPage {
    pub items: Vec<PulseCorrelation>,
    pub coverage: SampleRange,
    pub scanned_edges: ExactU64,
    pub inspected_frames: ExactU64,
    pub selected_events: ExactU64,
    pub pulse_candidates: ExactU64,
    pub pulse_scan_complete: bool,
    pub page_complete: bool,
    pub complete: bool,
    pub left_boundary_incomplete: bool,
    pub right_boundary_incomplete: bool,
    pub next_offset: Option<usize>,
    pub next_start_sample: Option<ExactU64>,
}

pub fn correlate_pulses(
    set: &FrameSet,
    window: &DigitalChannelWindow,
    query: &CorrelationQuery,
    offset: usize,
    limit: usize,
    cancel: &AtomicBool,
) -> Result<CorrelationPage> {
    validate_set(set)?;
    query.events.validate(set)?;
    if limit == 0
        || limit > 100
        || offset >= 1000 * MAX_DECODE_FRAMES
        || serde_json::to_vec(query).map_or(true, |v| v.len() > MAX_PROTOCOL_QUERY_BYTES)
    {
        return Err(AnalysisError::InvalidInput(
            "correlation requires limit 1..100 and query <=16 KiB".into(),
        ));
    }
    let pulse_page = scan_pulses(
        window,
        &PulseQuery {
            range: query.original_range,
            high: query.high,
            min_width_samples: query.min_width_samples,
            max_width_exclusive: Some(query.max_width_exclusive),
            limit: 1000,
        },
        cancel,
    )?;
    let mut events = Vec::new();
    for (i, frame) in set.frames.iter().enumerate() {
        if cancel.load(Ordering::Acquire) {
            return Err(AnalysisError::Cancelled);
        }
        if frame.range.start_sample < set.requested_range.end_sample
            && frame.range.end_sample > set.requested_range.start_sample
            && query.events.matches(frame)
        {
            events.push((i, frame));
        }
    }
    let mut page = CorrelationPage {
        items: vec![],
        coverage: pulse_page.scan.coverage,
        scanned_edges: pulse_page.scan.scanned_edges,
        inspected_frames: (set.frames.len() as u64).into(),
        selected_events: (events.len() as u64).into(),
        pulse_candidates: (pulse_page.scan.items.len() as u64).into(),
        pulse_scan_complete: pulse_page.scan.complete,
        page_complete: false,
        complete: false,
        left_boundary_incomplete: pulse_page.left_boundary_incomplete,
        right_boundary_incomplete: pulse_page.right_boundary_incomplete,
        next_offset: None,
        next_start_sample: None,
    };
    let mut bytes = 0;
    // A cursor encodes the unconsumed (pulse index, original frame index).
    // Skip earlier pulses without enumerating a potentially large product.
    for (pi, pulse) in pulse_page
        .scan
        .items
        .iter()
        .enumerate()
        .skip(offset / MAX_DECODE_FRAMES)
    {
        let low = pulse
            .range
            .start_sample
            .0
            .saturating_sub(query.after_samples.0);
        let high = pulse
            .range
            .start_sample
            .0
            .saturating_add(query.before_samples.0);
        let first = events.partition_point(|(_, f)| f.range.start_sample.0 < low);
        for &(fi, frame) in &events[first..] {
            if frame.range.start_sample.0 > high {
                break;
            }
            if cancel.load(Ordering::Acquire) {
                return Err(AnalysisError::Cancelled);
            }
            let position = pi * MAX_DECODE_FRAMES + fi;
            if position < offset {
                continue;
            }
            let item = PulseCorrelation {
                frame: query.events.project(frame),
                pulse: pulse.clone(),
                delta_samples: (i128::from(pulse.range.start_sample.0)
                    - i128::from(frame.range.start_sample.0))
                .to_string(),
            };
            let size = serde_json::to_vec(&item)
                .map_err(|e| AnalysisError::InvalidInput(e.to_string()))?
                .len();
            if size > MAX_FRAME_PAGE_BYTES {
                return Err(AnalysisError::InvalidInput(
                    "individual correlation exceeds 128 KiB; use field projection".into(),
                ));
            }
            if page.items.len() == limit || bytes + size > MAX_FRAME_PAGE_BYTES {
                page.next_offset = Some(position);
                return Ok(page);
            }
            bytes += size;
            page.items.push(item);
        }
    }
    page.page_complete = true;
    page.complete = pulse_page.scan.complete;
    page.next_start_sample = pulse_page.scan.next_start_sample;
    Ok(page)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    fn fixture(shift: u64) -> (FrameSet, DigitalChannelWindow, CorrelationQuery) {
        let range = SampleRange::new(shift, shift + 20, shift + 20).unwrap();
        let frames = [4, 5, 6]
            .into_iter()
            .enumerate()
            .map(|(i, s)| ProtocolFrame {
                frame_id: (i as u64 + 1).into(),
                range: SampleRange::new(shift + s, shift + s + 1, shift + 20).unwrap(),
                row: "selected_event".into(),
                fields: BTreeMap::new(),
                texts: vec![],
                configured_channels: vec![0],
                native_start_sample: (shift + s).into(),
                native_end_sample: (shift + s + 1).into(),
                native_endpoint_policy: "exclusive".into(),
            })
            .collect();
        let set = FrameSet {
            backend: "fixture".into(),
            backend_protocol: "fixture".into(),
            protocol: "fixture".into(),
            requested_range: range,
            processed_range: range,
            frames,
            configuration: serde_json::json!({}),
            field_schema: vec![],
            schema_scope: "fixture".into(),
            diagnostics: vec![],
        };
        let window = DigitalChannelWindow {
            channel: 0,
            sample_rate_hz: 1_000_000,
            capture_sample_count: shift + 20,
            start_sample: shift,
            end_sample: shift + 20,
            requested_end_sample: shift + 20,
            high_before_start: false,
            transitions: [2, 3, 5, 7, 10, 13, 15]
                .into_iter()
                .map(|s| shift + s)
                .collect(),
            previous_transition: None,
            next_transition: None,
            complete: true,
        };
        let query = CorrelationQuery {
            events: FrameQuery::default(),
            original_range: range,
            before_samples: 1.into(),
            after_samples: 1.into(),
            high: Some(true),
            min_width_samples: 1.into(),
            max_width_exclusive: 3.into(),
        };
        (set, window, query)
    }
    #[test]
    fn exact_signed_offsets_inclusive_radius_and_product_paging() {
        let shift = (1u64 << 53) + 31;
        let (set, window, query) = fixture(shift);
        let first = correlate_pulses(&set, &window, &query, 0, 1, &AtomicBool::new(false)).unwrap();
        assert_eq!(first.items.len(), 1);
        assert_eq!(first.items[0].delta_samples, "1");
        assert!(!first.page_complete);
        assert!(first.next_start_sample.is_none());
        let second = correlate_pulses(
            &set,
            &window,
            &query,
            first.next_offset.unwrap(),
            1,
            &AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!(second.items[0].delta_samples, "0");
        assert_eq!(second.items[0].pulse.range.start_sample.0, shift + 5);
        let third = correlate_pulses(
            &set,
            &window,
            &query,
            second.next_offset.unwrap(),
            1,
            &AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!(third.items[0].delta_samples, "-1");
        assert!(third.complete);
        assert!(third.next_offset.is_none());
        assert!(first.left_boundary_incomplete && first.right_boundary_incomplete);
    }
    #[test]
    fn truncated_edge_scan_keeps_coverage_and_never_invents_boundary_pulses() {
        let (mut set, mut window, mut query) = fixture(0);
        set.frames[0].range = SampleRange::new(2, 3, 20).unwrap();
        query.before_samples = 0.into();
        query.after_samples = 0.into();
        window.end_sample = 5;
        window.transitions = vec![2, 3];
        window.next_transition = Some(5);
        window.complete = false;
        let page =
            correlate_pulses(&set, &window, &query, 0, 100, &AtomicBool::new(false)).unwrap();
        assert!(page.page_complete);
        assert!(!page.complete);
        assert_eq!(page.next_start_sample.unwrap().0, 5);
        assert_eq!(page.coverage.end_sample.0, 5);
        assert_eq!(page.items.len(), 1);
        assert_eq!(page.items[0].pulse.range.end_sample.0, 3);
        window.start_sample = 5;
        window.end_sample = 20;
        window.transitions = vec![5];
        window.high_before_start = false;
        window.previous_transition = Some(3);
        window.next_transition = None;
        window.complete = true;
        assert!(
            correlate_pulses(&set, &window, &query, 0, 100, &AtomicBool::new(false))
                .unwrap()
                .items
                .is_empty()
        );
    }
    #[test]
    fn no_selected_events_is_explicit_and_cancellation_and_types_are_checked() {
        let (set, window, mut query) = fixture(0);
        query.events.rows = vec!["absent".into()];
        let page =
            correlate_pulses(&set, &window, &query, 0, 100, &AtomicBool::new(false)).unwrap();
        assert!(page.items.is_empty());
        assert!(page.complete);
        assert_eq!(page.selected_events.0, 0);
        assert!(matches!(
            correlate_pulses(&set, &window, &query, 0, 100, &AtomicBool::new(true)),
            Err(AnalysisError::Cancelled)
        ));
        query.events.projection = vec!["invented".into()];
        assert!(correlate_pulses(&set, &window, &query, 0, 100, &AtomicBool::new(false)).is_err());
    }
    #[test]
    fn pair_pagination_must_finish_before_resuming_a_capped_pulse_scan() {
        let (mut set, mut window, mut query) = fixture(0);
        let range = SampleRange::new(0, 2105, 2105).unwrap();
        set.frames.truncate(1);
        set.requested_range = range;
        set.processed_range = range;
        window.capture_sample_count = 2105;
        window.end_sample = 2105;
        window.requested_end_sample = 2105;
        window.transitions = (2..2103).collect();
        query.original_range = range;
        query.before_samples = 2105.into();
        query.after_samples = 2105.into();
        query.high = None;
        query.max_width_exclusive = 2.into();
        let mut offset = 0;
        let mut samples = std::collections::BTreeSet::new();
        let final_page = loop {
            let page =
                correlate_pulses(&set, &window, &query, offset, 100, &AtomicBool::new(false))
                    .unwrap();
            assert!(!page.pulse_scan_complete);
            assert_eq!(page.pulse_candidates.0, 1000);
            for pair in &page.items {
                assert!(samples.insert(pair.pulse.range.start_sample.0));
            }
            if let Some(next) = page.next_offset {
                assert!(page.next_start_sample.is_none());
                offset = next;
            } else {
                break page;
            }
        };
        assert!(final_page.page_complete);
        assert!(!final_page.complete);
        assert_eq!(samples.len(), 1000);
        assert_eq!(final_page.next_start_sample.unwrap().0, 1002);
        assert_eq!(final_page.coverage.end_sample.0, 1002);
        window.start_sample = 1002;
        window.previous_transition = Some(1001);
        window.transitions = (1002..2103).collect();
        let resumed =
            correlate_pulses(&set, &window, &query, 0, 100, &AtomicBool::new(false)).unwrap();
        assert_eq!(resumed.items[0].pulse.range.start_sample.0, 1002);
    }
}
