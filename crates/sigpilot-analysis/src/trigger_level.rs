//! Build level eligibility from transition boundaries, never by expanding a
//! potentially enormous capture into one candidate per sample.
use crate::{
    trigger::{Event, EventMatch, Phase, Signal, Step},
    AnalysisError, ExactU64, Result, SampleRange,
};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::atomic::{AtomicBool, Ordering},
};
pub(crate) struct LevelCandidates {
    pub events: Vec<EventMatch>,
    pub observations: u64,
    pub guard_rejected: u64,
    pub truncated: bool,
}
pub(crate) fn collect(
    step: &Step,
    range: SampleRange,
    signals: &BTreeMap<u8, Signal>,
    cancel: &AtomicBool,
) -> Result<LevelCandidates> {
    let Event::Level { channel, high } = &step.event else {
        unreachable!()
    };
    let channels: BTreeSet<_> = std::iter::once(*channel)
        .chain(step.guards.iter().map(|g| g.channel))
        .collect();
    let mut boundaries = BTreeSet::from([range.start_sample.0, range.end_sample.0]);
    for channel in channels {
        for &edge in &signals[&channel].edges {
            if cancel.load(Ordering::Acquire) {
                return Err(AnalysisError::Cancelled);
            }
            boundaries.insert(edge);
            // A before-phase guard differs from the after-phase value only at an
            // actual edge sample, so edge+1 is also a semantic boundary.
            if edge + 1 < range.end_sample.0 {
                boundaries.insert(edge + 1);
            }
        }
    }
    let boundaries: Vec<_> = boundaries.into_iter().collect();
    let mut result = LevelCandidates {
        events: vec![],
        observations: 0,
        guard_rejected: 0,
        truncated: false,
    };
    for interval in boundaries.windows(2) {
        if cancel.load(Ordering::Acquire) {
            return Err(AnalysisError::Cancelled);
        }
        let start = interval[0];
        let end = interval[1];
        if signals[channel].high(start, Phase::After) != *high {
            continue;
        }
        result.observations += 1;
        if step
            .guards
            .iter()
            .any(|g| signals[&g.channel].high(start, g.phase) != g.high)
        {
            result.guard_rejected += 1;
            continue;
        }
        if let Some(last) = result
            .events
            .last_mut()
            .filter(|e| e.eligible_range.unwrap().end_sample.0 == start)
        {
            last.eligible_range.as_mut().unwrap().end_sample = ExactU64(end);
            continue;
        }
        if result.events.len() == 4096 {
            result.truncated = true;
            break;
        }
        result.events.push(EventMatch {
            channel: *channel,
            anchor_sample: start.into(),
            confirmation_sample: start.into(),
            range: SampleRange {
                start_sample: start.into(),
                end_sample: (start + 1).into(),
            },
            width_samples: None,
            pulse_range: None,
            eligible_range: Some(SampleRange {
                start_sample: start.into(),
                end_sample: end.into(),
            }),
        });
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        trigger::{simulate, validate, Guard, TriggerRule, Within},
        EdgeDirection,
    };
    fn level(channel: u8, high: bool) -> Step {
        Step {
            event: Event::Level { channel, high },
            guards: vec![],
            within: None,
        }
    }
    fn trace(initial: bool, edges: Vec<u64>) -> Signal {
        Signal {
            high_before_start: initial,
            previous_edge: None,
            edges,
            next_edge: None,
        }
    }
    fn rule(steps: Vec<Step>) -> TriggerRule {
        TriggerRule {
            schema_version: "1".into(),
            steps,
            holdoff_samples: 0.into(),
        }
    }
    #[test]
    fn constant_level_can_match_at_the_start_without_an_invented_edge() {
        let query = rule(vec![level(0, true)]);
        let signals = BTreeMap::from([(0, trace(true, vec![]))]);
        let page = simulate(
            &query,
            SampleRange::new(7, 20, 20).unwrap(),
            &signals,
            &[0],
            100,
            &AtomicBool::new(false),
        )
        .unwrap();
        assert!(page.complete);
        assert_eq!(page.total_matches.0, 1);
        assert_eq!(page.matches[0].anchor_sample.0, 7);
        assert_eq!(
            page.matches[0].stages[0].eligible_range.unwrap(),
            SampleRange::new(7, 20, 20).unwrap()
        );
        let mut invalid = query;
        invalid.steps[0].guards.push(Guard {
            channel: 0,
            high: false,
            phase: Phase::After,
        });
        assert_eq!(
            validate(&invalid, &[0]).satisfiability,
            "proven_unsatisfiable"
        );
        invalid.steps[0].guards[0].phase = Phase::Before;
        assert_ne!(
            validate(&invalid, &[0]).satisfiability,
            "proven_unsatisfiable"
        );
    }
    #[test]
    fn interior_level_anchor_is_selected_when_the_earliest_point_cannot_complete() {
        let mut mid = level(1, true);
        mid.within = Some(Within {
            min_samples: 0.into(),
            max_samples: 20.into(),
        });
        let edge = |channel, within| Step {
            event: Event::Edge {
                channel,
                direction: EdgeDirection::Rising,
            },
            guards: vec![],
            within,
        };
        let query = rule(vec![
            edge(0, None),
            mid,
            edge(
                2,
                Some(Within {
                    min_samples: 0.into(),
                    max_samples: 1.into(),
                }),
            ),
        ]);
        let signals = BTreeMap::from([
            (0, trace(false, vec![2])),
            (1, trace(true, vec![])),
            (2, trace(false, vec![20])),
        ]);
        let page = simulate(
            &query,
            SampleRange::new(0, 30, 30).unwrap(),
            &signals,
            &[0, 1, 2],
            100,
            &AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!(page.total_matches.0, 1);
        assert_eq!(
            page.matches[0]
                .stages
                .iter()
                .map(|e| e.anchor_sample.0)
                .collect::<Vec<_>>(),
            vec![2, 19, 20]
        );
        let query = rule(vec![
            level(1, true),
            edge(
                2,
                Some(Within {
                    min_samples: 0.into(),
                    max_samples: 1.into(),
                }),
            ),
        ]);
        let page = simulate(
            &query,
            SampleRange::new(0, 30, 30).unwrap(),
            &signals,
            &[0, 1, 2],
            100,
            &AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!(page.matches[0].stages[0].anchor_sample.0, 19);
    }
    #[test]
    fn qualified_intervals_agree_with_every_sample_for_before_and_after_guards() {
        for phase in [Phase::Before, Phase::After] {
            for primary in 0u16..16 {
                for guard in 0u16..16 {
                    let trace_from = |pattern: u16| {
                        let mut previous = false;
                        let mut edges = vec![];
                        for sample in 0..8 {
                            let high = pattern & (1 << sample) != 0;
                            if high != previous {
                                edges.push(sample as u64);
                                previous = high;
                            }
                        }
                        trace(false, edges)
                    };
                    let mut step = level(0, true);
                    step.guards.push(Guard {
                        channel: 1,
                        high: false,
                        phase,
                    });
                    let signals =
                        BTreeMap::from([(0, trace_from(primary)), (1, trace_from(guard))]);
                    let page = simulate(
                        &rule(vec![step]),
                        SampleRange::new(0, 8, 8).unwrap(),
                        &signals,
                        &[0, 1],
                        100,
                        &AtomicBool::new(false),
                    )
                    .unwrap();
                    let mut expected = vec![];
                    let mut qualified = false;
                    for sample in 0..8 {
                        let primary_high = primary & (1 << sample) != 0;
                        let guard_high = match phase {
                            Phase::After => guard & (1 << sample) != 0,
                            Phase::Before => sample > 0 && guard & (1 << (sample - 1)) != 0,
                        };
                        let now = primary_high && !guard_high;
                        if now && !qualified {
                            expected.push(sample as u64);
                        }
                        qualified = now;
                    }
                    assert_eq!(
                        page.matches
                            .iter()
                            .map(|m| m.anchor_sample.0)
                            .collect::<Vec<_>>(),
                        expected,
                        "primary={primary} guard={guard} phase={phase:?}"
                    );
                }
            }
        }
    }
    #[test]
    fn huge_held_levels_and_inclusive_delay_bounds_keep_exact_anchors() {
        let shift = (1u64 << 53) + 99;
        let mut next = level(1, true);
        next.within = Some(Within {
            min_samples: 7.into(),
            max_samples: 7.into(),
        });
        let query = rule(vec![
            Step {
                event: Event::Edge {
                    channel: 0,
                    direction: EdgeDirection::Rising,
                },
                guards: vec![],
                within: None,
            },
            next,
        ]);
        let signals =
            BTreeMap::from([(0, trace(false, vec![shift + 2])), (1, trace(true, vec![]))]);
        let page = simulate(
            &query,
            SampleRange::new(shift, shift + u32::MAX as u64, shift + u32::MAX as u64).unwrap(),
            &signals,
            &[0, 1],
            100,
            &AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!(page.matches[0].stages[1].anchor_sample.0, shift + 9);
        assert_eq!(page.inspected_edges.0, 1);
        assert!(matches!(
            simulate(
                &query,
                page.requested_range,
                &signals,
                &[0, 1],
                100,
                &AtomicBool::new(true)
            ),
            Err(AnalysisError::Cancelled)
        ));
    }
    #[test]
    fn temporal_level_choices_match_an_exhaustive_sample_oracle() {
        // Independently enumerate sample choices for edge -> level -> edge.
        // A narrow final window often requires an interior level anchor.
        for pattern in 0u16..256 {
            for (min, max) in [(0u64, 0u64), (0, 1), (1, 3), (3, 5)] {
                let mut previous = false;
                let mut transitions = vec![];
                for at in 0..8 {
                    let high = pattern & (1 << at) != 0;
                    if high != previous {
                        transitions.push(at as u64);
                        previous = high;
                    }
                }
                let mut middle = level(1, true);
                middle.within = Some(Within {
                    min_samples: 0.into(),
                    max_samples: 5.into(),
                });
                let edge = |channel, within| Step {
                    event: Event::Edge {
                        channel,
                        direction: EdgeDirection::Rising,
                    },
                    guards: vec![],
                    within,
                };
                let query = rule(vec![
                    edge(0, None),
                    middle,
                    edge(
                        2,
                        Some(Within {
                            min_samples: min.into(),
                            max_samples: max.into(),
                        }),
                    ),
                ]);
                let signals = BTreeMap::from([
                    (0, trace(false, vec![1])),
                    (1, trace(false, transitions)),
                    (2, trace(false, vec![4, 5, 7])),
                ]);
                let page = simulate(
                    &query,
                    SampleRange::new(0, 8, 8).unwrap(),
                    &signals,
                    &[0, 1, 2],
                    100,
                    &AtomicBool::new(false),
                )
                .unwrap();
                let expected = (1u64..=6)
                    .filter(|at| pattern & (1 << at) != 0)
                    .find_map(|at| {
                        [4u64, 7]
                            .into_iter()
                            .find(|last| *last >= at && *last - at >= min && *last - at <= max)
                            .map(|last| vec![1, at, last])
                    });
                let actual = page.matches.first().map(|m| {
                    m.stages
                        .iter()
                        .map(|s| s.anchor_sample.0)
                        .collect::<Vec<_>>()
                });
                assert_eq!(actual, expected, "pattern={pattern} window=[{min},{max}]");
                assert!(page.complete);
            }
        }
    }
}
