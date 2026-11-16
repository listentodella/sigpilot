//! Backward temporal interval reachability followed by earliest viable
//! anchors. Level intervals cannot be reduced to one greedy point: a later
//! interior point may be the only one that can complete the remaining steps.
use crate::{
    trigger::{EventMatch, Simulation, TriggerMatch, TriggerRule},
    AnalysisError, Result, SampleRange,
};
use std::sync::atomic::{AtomicBool, Ordering};
#[derive(Clone, Copy)]
struct Viable {
    range: SampleRange,
    event: usize,
}
fn domain(event: &EventMatch) -> SampleRange {
    event.eligible_range.unwrap_or(SampleRange {
        start_sample: event.anchor_sample,
        end_sample: (event.anchor_sample.0 + 1).into(),
    })
}
fn merge(mut ranges: Vec<SampleRange>) -> Vec<SampleRange> {
    ranges.sort_by_key(|r| (r.start_sample, r.end_sample));
    let mut result: Vec<SampleRange> = vec![];
    for range in ranges {
        if let Some(last) = result
            .last_mut()
            .filter(|r| r.end_sample >= range.start_sample)
        {
            last.end_sample = last.end_sample.max(range.end_sample);
        } else {
            result.push(range);
        }
    }
    result
}
fn compare(result: &mut Simulation, cancel: &AtomicBool, max: usize) -> Result<bool> {
    if cancel.load(Ordering::Acquire) {
        return Err(AnalysisError::Cancelled);
    }
    if result.comparisons.0 == max as u64 {
        result.complete = false;
        result.stop_reason = Some("sequence_comparison_budget".into());
        return Ok(false);
    }
    result.comparisons.0 += 1;
    Ok(true)
}
fn select(
    events: &[EventMatch],
    viable: &[Viable],
    min: u64,
    max: u64,
    event: Option<usize>,
) -> Option<EventMatch> {
    let first = viable.partition_point(|v| v.range.end_sample.0 <= min);
    for v in &viable[first..] {
        if v.range.start_sample.0 > max {
            break;
        }
        if event.is_some_and(|e| e != v.event) {
            continue;
        }
        let at = v.range.start_sample.0.max(min);
        let mut result = events[v.event].clone();
        if result.eligible_range.is_some() {
            result.anchor_sample = at.into();
            result.confirmation_sample = at.into();
            result.range = SampleRange {
                start_sample: at.into(),
                end_sample: (at + 1).into(),
            };
        }
        return Some(result);
    }
    None
}
pub(crate) fn search(
    rule: &TriggerRule,
    events: &[Vec<EventMatch>],
    result: &mut Simulation,
    limit: usize,
    cancel: &AtomicBool,
    max: usize,
) -> Result<()> {
    let mut viable: Vec<Vec<Viable>> = vec![vec![]; events.len()];
    let last = events.len() - 1;
    viable[last] = events[last]
        .iter()
        .enumerate()
        .map(|(i, e)| Viable {
            range: domain(e),
            event: i,
        })
        .collect();
    let mut domains = viable[last].len();
    for stage in (0..last).rev() {
        let window = rule.steps[stage + 1].within.as_ref().unwrap();
        let preimages = merge(
            viable[stage + 1]
                .iter()
                .filter_map(|v| {
                    let end = v.range.end_sample.0.checked_sub(window.min_samples.0)?;
                    let start = v.range.start_sample.0.saturating_sub(window.max_samples.0);
                    (start < end).then_some(SampleRange {
                        start_sample: start.into(),
                        end_sample: end.into(),
                    })
                })
                .collect(),
        );
        for (i, event) in events[stage].iter().enumerate() {
            let own = domain(event);
            let count = viable[stage].len();
            let first = preimages.partition_point(|r| r.end_sample <= own.start_sample);
            for other in &preimages[first..] {
                if other.start_sample >= own.end_sample {
                    break;
                }
                if !compare(result, cancel, max)? {
                    return Ok(());
                }
                let range = SampleRange {
                    start_sample: own.start_sample.max(other.start_sample),
                    end_sample: own.end_sample.min(other.end_sample),
                };
                viable[stage].push(Viable { range, event: i });
                domains += 1;
                if domains > 65536 {
                    result.complete = false;
                    result.stop_reason = Some("temporal_interval_budget".into());
                    return Ok(());
                }
            }
            if viable[stage].len() == count {
                result.stages[stage].suffix_rejected.0 += 1;
            }
        }
    }
    let mut confirmed: Option<u64> = None;
    for (event, initial) in events[0].iter().enumerate() {
        if !compare(result, cancel, max)? {
            break;
        }
        let own = domain(initial);
        let min = if rule.holdoff_samples.0 == 0 {
            own.start_sample.0
        } else {
            match confirmed.and_then(|c| c.checked_add(rule.holdoff_samples.0)) {
                Some(value) => value.max(own.start_sample.0),
                None if confirmed.is_some() => continue,
                None => own.start_sample.0,
            }
        };
        let Some(start) = select(
            &events[0],
            &viable[0],
            min,
            own.end_sample.0 - 1,
            Some(event),
        ) else {
            continue;
        };
        let mut chain = vec![start];
        for stage in 1..events.len() {
            if !compare(result, cancel, max)? {
                return Ok(());
            }
            let previous = chain.last().unwrap().anchor_sample.0;
            let window = rule.steps[stage].within.as_ref().unwrap();
            let Some(min) = previous.checked_add(window.min_samples.0) else {
                unreachable!("backward reachability excludes overflowing minimum")
            };
            let max = previous.saturating_add(window.max_samples.0);
            let before = viable[stage].partition_point(|v| v.range.end_sample.0 <= min);
            let after = viable[stage].partition_point(|v| v.range.start_sample.0 <= max);
            result.stages[stage].window_rejected.0 += (before + viable[stage].len() - after) as u64;
            chain.push(
                select(&events[stage], &viable[stage], min, max, None)
                    .expect("backward reachability guarantees a completable successor"),
            );
        }
        let at = chain.iter().map(|e| e.confirmation_sample.0).max().unwrap();
        confirmed = Some(at);
        result.total_matches.0 += 1;
        for stat in &mut result.stages {
            stat.sequence_matches.0 += 1;
        }
        if result.matches.len() == limit {
            result.results_truncated = true;
            continue;
        }
        result.matches.push(TriggerMatch {
            range: SampleRange {
                start_sample: chain.iter().map(|e| e.range.start_sample).min().unwrap(),
                end_sample: chain.iter().map(|e| e.range.end_sample).max().unwrap(),
            },
            anchor_sample: chain.last().unwrap().anchor_sample,
            confirmation_sample: at.into(),
            stages: chain,
        });
    }
    Ok(())
}
