use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};
use sigpilot_core::DigitalChannelWindow;

use crate::{AnalysisError, ExactU64, Result, SampleRange};

const MAX_WINDOW_EDGES: usize = 4_096;
pub const MAX_RESULT_PAGE: usize = 1_000;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EdgeDirection {
    Rising,
    Falling,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EdgeEvent {
    pub channel: u8,
    pub sample: ExactU64,
    pub direction: EdgeDirection,
    pub before_high: bool,
    pub after_high: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ScanPage<T> {
    pub items: Vec<T>,
    pub coverage: SampleRange,
    pub scanned_edges: ExactU64,
    pub complete: bool,
    pub truncated: bool,
    pub next_start_sample: Option<ExactU64>,
}

pub fn query_edges(
    window: &DigitalChannelWindow,
    direction: Option<EdgeDirection>,
    limit: usize,
) -> Result<ScanPage<EdgeEvent>> {
    validate_window(window)?;
    validate_limit(limit)?;
    let mut high = window.high_before_start;
    let mut items = Vec::with_capacity(limit.min(window.transitions.len()));
    for (position, sample) in window.transitions.iter().copied().enumerate() {
        let event = EdgeEvent {
            channel: window.channel,
            sample: sample.into(),
            direction: if high {
                EdgeDirection::Falling
            } else {
                EdgeDirection::Rising
            },
            before_high: high,
            after_high: !high,
        };
        high = !high;
        if direction.is_some_and(|wanted| wanted != event.direction) {
            continue;
        }
        if items.len() == limit {
            return Ok(page(window, items, position, sample, false, true));
        }
        items.push(event);
    }
    Ok(page(
        window,
        items,
        window.transitions.len(),
        window.end_sample,
        window.complete,
        false,
    ))
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Pulse {
    pub channel: u8,
    pub high: bool,
    pub range: SampleRange,
    pub width_samples: ExactU64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PulseQuery {
    pub range: SampleRange,
    pub high: Option<bool>,
    pub min_width_samples: ExactU64,
    pub max_width_exclusive: Option<ExactU64>,
    pub limit: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PulsePage {
    #[serde(flatten)]
    pub scan: ScanPage<Pulse>,
    pub left_boundary_incomplete: bool,
    pub right_boundary_incomplete: bool,
}

/// Pulses belong to the page containing their opening edge. A single lookahead
/// edge closes the last pulse, even if its closing edge belongs to the next
/// page. This prevents loss or duplication at a page boundary.
pub fn scan_pulses(
    window: &DigitalChannelWindow,
    query: &PulseQuery,
    cancelled: &AtomicBool,
) -> Result<PulsePage> {
    validate_window(window)?;
    validate_limit(query.limit)?;
    query.range.validate(window.capture_sample_count)?;
    if window.start_sample < query.range.start_sample.0
        || window.requested_end_sample != query.range.end_sample.0
        || query.min_width_samples.0 == 0
        || query
            .max_width_exclusive
            .is_some_and(|max| max.0 <= query.min_width_samples.0)
    {
        return Err(AnalysisError::InvalidInput(
            "invalid pulse range or empty width constraint".into(),
        ));
    }
    check_cancelled(cancelled)?;
    let left_boundary_incomplete = window.start_sample == query.range.start_sample.0
        && window.transitions.first().copied() != Some(query.range.start_sample.0);
    let right_boundary_incomplete =
        window.complete && window.next_transition != Some(query.range.end_sample.0);
    let mut high = window.high_before_start;
    let mut items = Vec::with_capacity(query.limit.min(window.transitions.len()));
    for (position, start) in window.transitions.iter().copied().enumerate() {
        if position % 128 == 0 {
            check_cancelled(cancelled)?;
        }
        high = !high;
        let Some(end) = window
            .transitions
            .get(position + 1)
            .copied()
            .or(window.next_transition)
        else {
            continue;
        };
        if end > query.range.end_sample.0 {
            continue;
        }
        let width = end - start;
        if query.high.is_some_and(|wanted| wanted != high)
            || width < query.min_width_samples.0
            || query.max_width_exclusive.is_some_and(|max| width >= max.0)
        {
            continue;
        }
        if items.len() == query.limit {
            return Ok(PulsePage {
                scan: page(window, items, position, start, false, true),
                left_boundary_incomplete,
                right_boundary_incomplete: false,
            });
        }
        items.push(Pulse {
            channel: window.channel,
            high,
            range: SampleRange::new(start, end, window.capture_sample_count)?,
            width_samples: width.into(),
        });
    }
    check_cancelled(cancelled)?;
    Ok(PulsePage {
        scan: page(
            window,
            items,
            window.transitions.len(),
            window.end_sample,
            window.complete,
            false,
        ),
        left_boundary_incomplete,
        right_boundary_incomplete,
    })
}

fn page<T>(
    window: &DigitalChannelWindow,
    items: Vec<T>,
    scanned: usize,
    end: u64,
    complete: bool,
    truncated: bool,
) -> ScanPage<T> {
    ScanPage {
        items,
        coverage: SampleRange {
            start_sample: window.start_sample.into(),
            end_sample: end.into(),
        },
        scanned_edges: ExactU64(scanned as u64),
        complete,
        truncated,
        next_start_sample: (!complete).then_some(end.into()),
    }
}

fn validate_limit(limit: usize) -> Result<()> {
    if limit == 0 || limit > MAX_RESULT_PAGE {
        return Err(AnalysisError::InvalidInput(format!(
            "result limit must be between 1 and {MAX_RESULT_PAGE}"
        )));
    }
    Ok(())
}

fn check_cancelled(cancelled: &AtomicBool) -> Result<()> {
    if cancelled.load(Ordering::Relaxed) {
        Err(AnalysisError::Cancelled)
    } else {
        Ok(())
    }
}

pub(crate) fn validate_window(window: &DigitalChannelWindow) -> Result<()> {
    if window.transitions.len() > MAX_WINDOW_EDGES
        || window.sample_rate_hz == 0
        || window.start_sample >= window.end_sample
        || window.end_sample > window.requested_end_sample
        || window.requested_end_sample > window.capture_sample_count
        || window.complete != (window.end_sample == window.requested_end_sample)
        || window
            .previous_transition
            .is_some_and(|edge| edge >= window.start_sample)
        || window
            .next_transition
            .is_some_and(|edge| edge < window.end_sample || edge >= window.capture_sample_count)
        || (!window.complete && window.next_transition != Some(window.end_sample))
        || window
            .transitions
            .iter()
            .any(|edge| *edge < window.start_sample || *edge >= window.end_sample)
        || window.transitions.windows(2).any(|pair| pair[0] >= pair[1])
    {
        return Err(AnalysisError::InvalidInput(
            "invalid bounded edge window".into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn window() -> DigitalChannelWindow {
        DigitalChannelWindow {
            channel: 2,
            sample_rate_hz: 1_000_000_000,
            capture_sample_count: 20,
            start_sample: 0,
            end_sample: 20,
            requested_end_sample: 20,
            high_before_start: false,
            previous_transition: None,
            next_transition: None,
            transitions: vec![2, 3, 5, 7, 10, 13, 15],
            complete: true,
        }
    }

    fn query() -> PulseQuery {
        PulseQuery {
            range: SampleRange::new(0, 20, 20).unwrap(),
            high: Some(true),
            min_width_samples: 1.into(),
            max_width_exclusive: Some(3.into()),
            limit: 100,
        }
    }

    #[test]
    fn detects_one_and_two_sample_pulses_without_fabricating_capture_boundaries() {
        let result = scan_pulses(&window(), &query(), &AtomicBool::new(false)).unwrap();
        assert_eq!(
            result
                .scan
                .items
                .iter()
                .map(|p| (p.range.start_sample.0, p.width_samples.0))
                .collect::<Vec<_>>(),
            vec![(2, 1), (5, 2)]
        );
        assert!(result.scan.complete);
        assert!(result.left_boundary_incomplete);
        assert!(result.right_boundary_incomplete);
        assert!(!result
            .scan
            .items
            .iter()
            .any(|p| p.range.start_sample.0 == 0 || p.range.start_sample.0 == 15));
    }

    #[test]
    fn pulse_at_window_boundary_is_emitted_once_with_lookahead() {
        let mut first = window();
        first.end_sample = 7;
        first.transitions = vec![2, 3, 5];
        first.next_transition = Some(7);
        first.complete = false;
        let a = scan_pulses(&first, &query(), &AtomicBool::new(false)).unwrap();
        assert_eq!(a.scan.items.len(), 2);
        let mut next = window();
        next.start_sample = 7;
        next.previous_transition = Some(5);
        next.high_before_start = true;
        next.transitions = vec![7, 10, 13, 15];
        let b = scan_pulses(&next, &query(), &AtomicBool::new(false)).unwrap();
        assert!(b.scan.items.is_empty());
        assert!(!a.scan.complete);
        assert_eq!(a.scan.next_start_sample.unwrap().0, 7);
    }

    #[test]
    fn respects_output_limit_cancellation_and_edge_polarity() {
        let edges = query_edges(&window(), Some(EdgeDirection::Rising), 2).unwrap();
        assert_eq!(
            edges.items.iter().map(|e| e.sample.0).collect::<Vec<_>>(),
            vec![2, 5]
        );
        assert_eq!(edges.next_start_sample.unwrap().0, 10);
        assert!(edges.truncated);
        let mut pulse_query = query();
        pulse_query.limit = 1;
        let result = scan_pulses(&window(), &pulse_query, &AtomicBool::new(false)).unwrap();
        assert_eq!(result.scan.next_start_sample.unwrap().0, 5);
        assert!(result.scan.truncated);
        assert!(matches!(
            scan_pulses(&window(), &query(), &AtomicBool::new(true)),
            Err(AnalysisError::Cancelled)
        ));
        assert!(query_edges(&window(), None, MAX_RESULT_PAGE + 1).is_err());
    }

    #[test]
    fn exact_range_end_can_close_a_pulse_but_is_not_an_edge_in_the_range() {
        let mut input = window();
        input.end_sample = 7;
        input.requested_end_sample = 7;
        input.transitions = vec![2, 3, 5];
        input.next_transition = Some(7);
        let mut pulse_query = query();
        pulse_query.range = SampleRange::new(0, 7, 20).unwrap();
        let result = scan_pulses(&input, &pulse_query, &AtomicBool::new(false)).unwrap();
        assert_eq!(result.scan.items.last().unwrap().range.end_sample.0, 7);
        assert!(!result.right_boundary_incomplete);
        assert_eq!(query_edges(&input, None, 100).unwrap().items.len(), 3);
    }
}
