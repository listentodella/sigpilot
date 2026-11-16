//! Exact measurements over bounded original-edge windows.
use crate::{edges::validate_window, AnalysisError, ExactU64, Result, SampleRange};
use serde::Serialize;
use sigpilot_core::DigitalChannelWindow;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Rational {
    pub numerator: String,
    pub denominator: String,
}

fn rational(numerator: u128, denominator: u64) -> Rational {
    Rational {
        numerator: numerator.to_string(),
        denominator: denominator.to_string(),
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct PointMeasurement {
    pub channel: u8,
    pub sample: ExactU64,
    pub high: bool,
    pub observed_range: SampleRange,
    pub opening_sample: Option<ExactU64>,
    pub closing_sample: Option<ExactU64>,
    pub complete_pulse: bool,
    pub observed_width_samples: ExactU64,
    pub pulse_width_samples: Option<ExactU64>,
    pub pulse_width_seconds: Option<Rational>,
    pub period_samples: Option<ExactU64>,
    pub period_seconds: Option<Rational>,
}

/// The point window starts at the cursor and contains the next few edges plus
/// its predecessor. Capture boundaries remain observed bounds, not fake edges.
pub fn measure_point(window: &DigitalChannelWindow) -> Result<PointMeasurement> {
    validate_window(window)?;
    let at_edge = window.transitions.first().copied() == Some(window.start_sample);
    let opening = if at_edge {
        Some(window.start_sample)
    } else {
        window.previous_transition
    };
    let high = window.high_before_start ^ at_edge;
    let future = window
        .transitions
        .iter()
        .copied()
        .filter(|s| *s > window.start_sample)
        .collect::<Vec<_>>();
    let closing = future.first().copied().or(window.next_transition);
    let period_end = future.get(1).copied().or_else(|| {
        (future.len() == 1)
            .then_some(window.next_transition)
            .flatten()
    });
    let start = opening.unwrap_or(0);
    let end = closing.unwrap_or(window.capture_sample_count);
    let width = opening.zip(closing).map(|(a, b)| b - a);
    let period = opening.zip(period_end).map(|(a, b)| b - a);
    Ok(PointMeasurement {
        channel: window.channel,
        sample: window.start_sample.into(),
        high,
        observed_range: SampleRange::new(start, end, window.capture_sample_count)?,
        opening_sample: opening.map(Into::into),
        closing_sample: closing.map(Into::into),
        complete_pulse: width.is_some(),
        observed_width_samples: (end - start).into(),
        pulse_width_samples: width.map(Into::into),
        pulse_width_seconds: width.map(|w| rational(w as u128, window.sample_rate_hz)),
        period_samples: period.map(Into::into),
        period_seconds: period.map(|p| rational(p as u128, window.sample_rate_hz)),
    })
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct RangeMeasurement {
    pub channel: u8,
    pub requested_range: SampleRange,
    pub coverage: SampleRange,
    pub complete: bool,
    pub next_start_sample: Option<ExactU64>,
    pub duration_samples: ExactU64,
    pub duration_seconds: Rational,
    pub high_samples: ExactU64,
    pub low_samples: ExactU64,
    pub positive_duty: Rational,
    pub negative_duty: Rational,
    pub rising_edges: ExactU64,
    pub falling_edges: ExactU64,
    pub complete_high_pulses: ExactU64,
    pub complete_low_pulses: ExactU64,
    pub minimum_complete_width_samples: Option<ExactU64>,
    pub maximum_complete_width_samples: Option<ExactU64>,
    pub left_boundary_incomplete: bool,
    pub right_boundary_incomplete: bool,
}

/// Occupancy measures only [coverage.start, coverage.end); pulse statistics
/// use opening-edge ownership, so a pulse closing on the next page appears once.
pub fn measure_range(
    window: &DigitalChannelWindow,
    original_range: SampleRange,
) -> Result<RangeMeasurement> {
    validate_window(window)?;
    original_range.validate(window.capture_sample_count)?;
    if window.start_sample < original_range.start_sample.0
        || window.requested_end_sample != original_range.end_sample.0
    {
        return Err(AnalysisError::InvalidInput(
            "measurement window does not belong to original_range".into(),
        ));
    }
    let mut high = window.high_before_start;
    let mut position = window.start_sample;
    let mut high_samples = 0u64;
    let mut rising = 0u64;
    let mut falling = 0u64;
    for &edge in &window.transitions {
        if high {
            high_samples += edge - position;
        }
        if high {
            falling += 1;
        } else {
            rising += 1;
        }
        high = !high;
        position = edge;
    }
    if high {
        high_samples += window.end_sample - position;
    }
    let duration = window.end_sample - window.start_sample;
    let mut complete_high = 0u64;
    let mut complete_low = 0u64;
    let mut minimum: Option<u64> = None;
    let mut maximum: Option<u64> = None;
    let mut pulse_high = window.high_before_start;
    for (position, &opening) in window.transitions.iter().enumerate() {
        pulse_high = !pulse_high;
        let Some(closing) = window
            .transitions
            .get(position + 1)
            .copied()
            .or(window.next_transition)
        else {
            continue;
        };
        if closing > original_range.end_sample.0 {
            continue;
        }
        let width = closing - opening;
        if pulse_high {
            complete_high += 1;
        } else {
            complete_low += 1;
        }
        minimum = Some(minimum.map_or(width, |m| m.min(width)));
        maximum = Some(maximum.map_or(width, |m| m.max(width)));
    }
    Ok(RangeMeasurement {
        channel: window.channel,
        requested_range: original_range,
        coverage: SampleRange::new(
            window.start_sample,
            window.end_sample,
            window.capture_sample_count,
        )?,
        complete: window.complete,
        next_start_sample: (!window.complete).then_some(window.end_sample.into()),
        duration_samples: duration.into(),
        duration_seconds: rational(duration as u128, window.sample_rate_hz),
        high_samples: high_samples.into(),
        low_samples: (duration - high_samples).into(),
        positive_duty: rational(high_samples as u128, duration),
        negative_duty: rational((duration - high_samples) as u128, duration),
        rising_edges: rising.into(),
        falling_edges: falling.into(),
        complete_high_pulses: complete_high.into(),
        complete_low_pulses: complete_low.into(),
        minimum_complete_width_samples: minimum.map(Into::into),
        maximum_complete_width_samples: maximum.map(Into::into),
        left_boundary_incomplete: window.start_sample == original_range.start_sample.0
            && window.transitions.first().copied() != Some(window.start_sample),
        right_boundary_incomplete: window.complete
            && window.next_transition != Some(original_range.end_sample.0),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn window() -> DigitalChannelWindow {
        DigitalChannelWindow {
            channel: 0,
            sample_rate_hz: 1000000000,
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
    #[test]
    fn point_does_not_invent_boundary_edges_and_keeps_exact_period() {
        let initial = measure_point(&window()).unwrap();
        assert!(!initial.complete_pulse);
        assert!(initial.pulse_width_samples.is_none());
        let mut point = window();
        point.start_sample = 5;
        point.previous_transition = Some(3);
        point.transitions = vec![5, 7, 10];
        point.end_sample = 13;
        point.next_transition = Some(13);
        point.complete = false;
        let result = measure_point(&point).unwrap();
        assert_eq!(result.pulse_width_samples.unwrap().0, 2);
        assert_eq!(result.period_samples.unwrap().0, 5);
        assert_eq!(result.pulse_width_seconds.unwrap().numerator, "2");
        point.start_sample = 16;
        point.end_sample = 20;
        point.previous_transition = Some(15);
        point.transitions.clear();
        point.next_transition = None;
        point.complete = true;
        point.high_before_start = true;
        assert!(!measure_point(&point).unwrap().complete_pulse);
    }
    #[test]
    fn range_occupancy_and_complete_pulses_have_separate_boundary_semantics() {
        let result = measure_range(&window(), SampleRange::new(0, 20, 20).unwrap()).unwrap();
        assert_eq!((result.high_samples.0, result.low_samples.0), (11, 9));
        assert_eq!((result.rising_edges.0, result.falling_edges.0), (4, 3));
        assert_eq!(
            (result.complete_high_pulses.0, result.complete_low_pulses.0),
            (3, 3)
        );
        assert_eq!(
            result.positive_duty,
            Rational {
                numerator: "11".into(),
                denominator: "20".into()
            }
        );
    }
    #[test]
    fn dense_edge_pages_aggregate_without_losing_a_pulse_at_the_boundary() {
        let mut first = window();
        first.capture_sample_count = 5000;
        first.requested_end_sample = 5000;
        first.end_sample = 4097;
        first.transitions = (1..4097).collect();
        first.next_transition = Some(4097);
        first.complete = false;
        let original = SampleRange::new(0, 5000, 5000).unwrap();
        let result = measure_range(&first, original).unwrap();
        assert_eq!(
            result.complete_high_pulses.0 + result.complete_low_pulses.0,
            4096
        );
        assert_eq!(result.next_start_sample.unwrap().0, 4097);
        assert_eq!(
            result.high_samples.0 + result.low_samples.0,
            result.duration_samples.0
        );
        let mut next = first;
        next.start_sample = 4097;
        next.end_sample = 5000;
        next.previous_transition = Some(4096);
        next.transitions = (4097..5000).collect();
        next.next_transition = None;
        next.complete = true;
        let result = measure_range(&next, original).unwrap();
        assert_eq!(
            result.complete_high_pulses.0 + result.complete_low_pulses.0,
            902
        );
        assert!(!result.left_boundary_incomplete);
    }
}
