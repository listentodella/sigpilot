//! Finite, explainable offline event sequences and qualified level intervals.
use crate::{AnalysisError, EdgeDirection, ExactU64, Result, SampleRange};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::atomic::{AtomicBool, Ordering},
};

const MAX_STEPS: usize = 8;
const MAX_GUARDS: usize = 16;
pub const MAX_TRIGGER_EDGES: usize = 65_536;
const MAX_CANDIDATES: usize = 4096;
const MAX_COMPARISONS: usize = 1_000_000;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    Before,
    After,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PulseAnchor {
    PulseStart,
    PulseEnd,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Event {
    Level {
        channel: u8,
        high: bool,
    },
    Edge {
        channel: u8,
        direction: EdgeDirection,
    },
    PulseWidth {
        channel: u8,
        high: bool,
        min_width_samples: ExactU64,
        max_width_exclusive: ExactU64,
        anchor: PulseAnchor,
    },
}
impl Event {
    pub fn channel(&self) -> u8 {
        match self {
            Self::Level { channel, .. }
            | Self::Edge { channel, .. }
            | Self::PulseWidth { channel, .. } => *channel,
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Guard {
    pub channel: u8,
    pub high: bool,
    pub phase: Phase,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Within {
    pub min_samples: ExactU64,
    pub max_samples: ExactU64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Step {
    pub event: Event,
    #[serde(default)]
    pub guards: Vec<Guard>,
    pub within: Option<Within>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TriggerRule {
    pub schema_version: String,
    pub steps: Vec<Step>,
    #[serde(default)]
    pub holdoff_samples: ExactU64,
}
#[derive(Debug, Clone, Serialize)]
pub struct Issue {
    pub path: String,
    pub code: String,
    pub message: String,
}
#[derive(Debug, Clone, Serialize)]
pub struct Validation {
    pub valid: bool,
    pub satisfiability: String,
    pub issues: Vec<Issue>,
    pub channels: Vec<u8>,
    pub hardware_status: String,
    pub execution_target: String,
    pub overlap_policy: String,
}

pub fn validate(rule: &TriggerRule, enabled: &[u8]) -> Validation {
    let mut issues = Vec::new();
    let mut invalid = false;
    let mut impossible = false;
    let mut add = |path: String, code: &str, message: &str, structural: bool| {
        invalid |= structural;
        impossible |= !structural;
        issues.push(Issue {
            path,
            code: code.into(),
            message: message.into(),
        });
    };
    if rule.schema_version != "1" || rule.steps.is_empty() || rule.steps.len() > MAX_STEPS {
        add(
            "steps".into(),
            "INVALID_MODEL",
            "schema_version 1 and 1..8 steps required",
            true,
        );
    }
    let mut channels = BTreeSet::new();
    for (index, step) in rule.steps.iter().enumerate() {
        let path = format!("steps[{index}]");
        channels.insert(step.event.channel());
        if step.guards.len() > MAX_GUARDS {
            add(
                format!("{path}.guards"),
                "INVALID_MODEL",
                "at most 16 guards per step",
                true,
            );
        }
        if (index == 0 && step.within.is_some()) || (index > 0 && step.within.is_none()) {
            add(
                format!("{path}.within"),
                "INVALID_MODEL",
                "first step has no window; each following step requires one",
                true,
            );
        }
        if step
            .within
            .as_ref()
            .is_some_and(|w| w.min_samples > w.max_samples)
        {
            add(
                format!("{path}.within"),
                "EMPTY_WINDOW",
                "minimum exceeds maximum delay",
                false,
            );
        }
        if let Event::PulseWidth {
            min_width_samples,
            max_width_exclusive,
            ..
        } = &step.event
        {
            if min_width_samples.0 == 0 {
                add(
                    format!("{path}.event.min_width_samples"),
                    "INVALID_MODEL",
                    "complete pulses have positive widths",
                    true,
                );
            }
            if max_width_exclusive <= min_width_samples {
                add(
                    format!("{path}.event"),
                    "EMPTY_WIDTH_RANGE",
                    "exclusive maximum must exceed minimum width",
                    false,
                );
            }
        }
        let mut guards = BTreeMap::new();
        for (guard_index, guard) in step.guards.iter().enumerate() {
            channels.insert(guard.channel);
            if guards
                .insert((guard.channel, guard.phase), guard.high)
                .is_some_and(|old| old != guard.high)
            {
                add(
                    format!("{path}.guards[{guard_index}]"),
                    "LEVEL_CONFLICT",
                    "same channel and phase require both high and low",
                    false,
                );
            }
            if guard.channel == step.event.channel() {
                let after = match &step.event {
                    Event::Level { high, .. } => *high,
                    Event::Edge { direction, .. } => *direction == EdgeDirection::Rising,
                    Event::PulseWidth { high, anchor, .. } => {
                        if *anchor == PulseAnchor::PulseStart {
                            *high
                        } else {
                            !*high
                        }
                    }
                };
                let expected = if guard.phase == Phase::After {
                    after
                } else {
                    !after
                };
                if !(matches!(step.event, Event::Level { .. }) && guard.phase == Phase::Before)
                    && guard.high != expected
                {
                    add(
                        format!("{path}.guards[{guard_index}]"),
                        "EVENT_LEVEL_CONFLICT",
                        "guard contradicts event level at its selected anchor/phase",
                        false,
                    );
                }
            }
        }
    }
    for channel in &channels {
        if *channel >= 32 || !enabled.contains(channel) {
            add(
                "channels".into(),
                "CHANNEL_UNAVAILABLE",
                "rule uses disabled or unavailable channel",
                true,
            );
        }
    }
    Validation {
        valid: !invalid,
        satisfiability: if invalid {
            "invalid_model"
        } else if impossible {
            "proven_unsatisfiable"
        } else if rule.steps.len() == 1 {
            "satisfiable_in_model"
        } else {
            "inconclusive_cross_stage_constraints"
        }
        .into(),
        issues,
        channels: channels.into_iter().collect(),
        hardware_status: "not_checked_select_offline_profile".into(),
        execution_target: "offline".into(),
        overlap_policy:
            "earliest_complete_chain_for_each_start; positive_holdoff_uses_confirmation_time".into(),
    }
}

#[derive(Debug, Clone)]
pub struct Signal {
    pub high_before_start: bool,
    pub previous_edge: Option<u64>,
    pub edges: Vec<u64>,
    pub next_edge: Option<u64>,
}
impl Signal {
    pub(crate) fn high(&self, sample: u64, phase: Phase) -> bool {
        self.high_before_start
            ^ (self.edges.partition_point(|s| {
                if phase == Phase::Before {
                    *s < sample
                } else {
                    *s <= sample
                }
            }) % 2
                == 1)
    }
}
#[derive(Debug, Clone, Serialize)]
pub struct EventMatch {
    pub channel: u8,
    pub anchor_sample: ExactU64,
    pub confirmation_sample: ExactU64,
    pub range: SampleRange,
    pub width_samples: Option<ExactU64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pulse_range: Option<SampleRange>,
    /// Level conditions hold throughout this sample interval. A selected
    /// anchor may be inside it after applying temporal sequence constraints.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub eligible_range: Option<SampleRange>,
}
#[derive(Debug, Clone, Serialize)]
pub struct StageStats {
    pub step: usize,
    pub candidate_events: ExactU64,
    pub guard_rejected: ExactU64,
    pub sequence_matches: ExactU64,
    pub window_rejected: ExactU64,
    pub suffix_rejected: ExactU64,
}
#[derive(Debug, Clone, Serialize)]
pub struct TriggerMatch {
    pub range: SampleRange,
    pub anchor_sample: ExactU64,
    pub confirmation_sample: ExactU64,
    pub stages: Vec<EventMatch>,
}
#[derive(Debug, Clone, Serialize)]
pub struct Simulation {
    pub status: String,
    pub complete: bool,
    pub stop_reason: Option<String>,
    pub requested_range: SampleRange,
    pub coverage: SampleRange,
    pub inspected_edges: ExactU64,
    pub comparisons: ExactU64,
    pub stages: Vec<StageStats>,
    pub matches: Vec<TriggerMatch>,
    pub total_matches: ExactU64,
    pub results_truncated: bool,
    pub boundary_policy: String,
    pub matching_policy: String,
    pub diagnostic_policy: String,
}

pub fn simulate(
    rule: &TriggerRule,
    range: SampleRange,
    signals: &BTreeMap<u8, Signal>,
    enabled: &[u8],
    limit: usize,
    cancel: &AtomicBool,
) -> Result<Simulation> {
    range.validate(range.end_sample.0)?;
    let validation = validate(rule, enabled);
    if !validation.valid || limit == 0 || limit > 1000 {
        return Err(AnalysisError::InvalidInput(
            "invalid trigger model or result limit".into(),
        ));
    }
    let edges = signals.values().map(|s| s.edges.len()).sum::<usize>();
    if edges > MAX_TRIGGER_EDGES {
        return Err(AnalysisError::InvalidInput(
            "trigger input exceeds 65536 edges".into(),
        ));
    }
    for channel in &validation.channels {
        let signal = signals
            .get(channel)
            .ok_or_else(|| AnalysisError::InvalidInput("missing trigger channel trace".into()))?;
        if signal
            .edges
            .iter()
            .any(|s| *s < range.start_sample.0 || *s >= range.end_sample.0)
            || signal.edges.windows(2).any(|p| p[0] >= p[1])
            || signal
                .previous_edge
                .is_some_and(|s| s >= range.start_sample.0)
            || signal
                .next_edge
                .is_some_and(|s| s < range.end_sample.0 || s == u64::MAX)
        {
            return Err(AnalysisError::InvalidInput(
                "invalid trigger edge trace".into(),
            ));
        }
    }
    let mut result=Simulation {status:"no_observed_match".into(),complete:true,stop_reason:None,requested_range:range,coverage:range,
        inspected_edges:(edges as u64).into(),comparisons:0.into(),stages:Vec::new(),matches:Vec::new(),total_matches:0.into(),results_truncated:false,
        boundary_policy:"complete pulses only; sequence anchors inside requested range; confirmation may use closing edge at range.end".into(),
        matching_policy:"earliest_completable_anchor_per_initial_event_or_qualified_level_interval".into(),
        diagnostic_policy:"guard_rejected counts observations; suffix_rejected counts candidates without a completable suffix; window_rejected counts viable intervals outside selected incoming windows".into()};
    if validation.satisfiability == "proven_unsatisfiable" {
        result.status = "proven_unsatisfiable".into();
        return Ok(result);
    }
    let mut stage_events = Vec::new();
    for (index, step) in rule.steps.iter().enumerate() {
        let signal = &signals[&step.event.channel()];
        let mut events = Vec::new();
        let mut count = 0;
        let mut rejected = 0;
        if matches!(step.event, Event::Level { .. }) {
            let level = crate::trigger_level::collect(step, range, signals, cancel)?;
            events = level.events;
            count = level.observations;
            rejected = level.guard_rejected;
            if level.truncated {
                result.complete = false;
                result.stop_reason = Some("stage_candidate_budget".into());
            }
        } else {
            for (position, &edge) in signal.edges.iter().enumerate() {
                if cancel.load(Ordering::Acquire) {
                    return Err(AnalysisError::Cancelled);
                }
                let after = signal.high_before_start ^ (position % 2 == 0);
                let event = match &step.event {
                    Event::Edge { direction, .. }
                        if (*direction == EdgeDirection::Rising) == after =>
                    {
                        Some(EventMatch {
                            channel: step.event.channel(),
                            anchor_sample: edge.into(),
                            confirmation_sample: edge.into(),
                            range: SampleRange {
                                start_sample: edge.into(),
                                end_sample: (edge + 1).into(),
                            },
                            width_samples: None,
                            pulse_range: None,
                            eligible_range: None,
                        })
                    }
                    Event::PulseWidth {
                        high,
                        min_width_samples,
                        max_width_exclusive,
                        anchor,
                        ..
                    } if *high == after => signal
                        .edges
                        .get(position + 1)
                        .copied()
                        .or(signal.next_edge)
                        .filter(|end| *end <= range.end_sample.0)
                        .and_then(|end| {
                            let width = end - edge;
                            let at = if *anchor == PulseAnchor::PulseStart {
                                edge
                            } else {
                                end
                            };
                            (width >= min_width_samples.0
                                && width < max_width_exclusive.0
                                && at < range.end_sample.0)
                                .then_some(EventMatch {
                                    channel: step.event.channel(),
                                    anchor_sample: at.into(),
                                    confirmation_sample: end.into(),
                                    range: SampleRange {
                                        start_sample: edge.into(),
                                        end_sample: (end + 1).into(),
                                    },
                                    width_samples: Some(width.into()),
                                    pulse_range: Some(SampleRange {
                                        start_sample: edge.into(),
                                        end_sample: end.into(),
                                    }),
                                    eligible_range: None,
                                })
                        }),
                    _ => None,
                };
                if let Some(event) = event {
                    count += 1;
                    if step.guards.iter().any(|guard| {
                        signals[&guard.channel].high(event.anchor_sample.0, guard.phase)
                            != guard.high
                    }) {
                        rejected += 1;
                        continue;
                    }
                    if events.len() == MAX_CANDIDATES {
                        result.complete = false;
                        result.stop_reason = Some("stage_candidate_budget".into());
                        break;
                    }
                    events.push(event);
                }
            }
        }
        result.stages.push(StageStats {
            step: index,
            candidate_events: (count as u64).into(),
            guard_rejected: (rejected as u64).into(),
            sequence_matches: 0.into(),
            window_rejected: 0.into(),
            suffix_rejected: 0.into(),
        });
        stage_events.push(events);
    }
    crate::trigger_search::search(
        rule,
        &stage_events,
        &mut result,
        limit,
        cancel,
        MAX_COMPARISONS,
    )?;
    result.status = if !result.complete {
        "incomplete"
    } else if result.total_matches.0 > 0 {
        "matched"
    } else {
        "no_observed_match"
    }
    .into();
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn edge() -> Step {
        Step {
            event: Event::Edge {
                channel: 0,
                direction: EdgeDirection::Rising,
            },
            guards: vec![],
            within: None,
        }
    }
    #[test]
    fn pulse_end_evidence_contains_the_recorded_closing_point() {
        let rule = TriggerRule {
            schema_version: "1".into(),
            holdoff_samples: 0.into(),
            steps: vec![Step {
                event: Event::PulseWidth {
                    channel: 0,
                    high: true,
                    min_width_samples: 2.into(),
                    max_width_exclusive: 3.into(),
                    anchor: PulseAnchor::PulseEnd,
                },
                guards: vec![],
                within: None,
            }],
        };
        let signals = BTreeMap::from([(
            0,
            Signal {
                high_before_start: false,
                previous_edge: None,
                edges: vec![5, 7],
                next_edge: None,
            },
        )]);
        let result = simulate(
            &rule,
            SampleRange::new(0, 10, 10).unwrap(),
            &signals,
            &[0],
            100,
            &AtomicBool::new(false),
        )
        .unwrap();
        let stage = &result.matches[0].stages[0];
        assert_eq!(stage.anchor_sample.0, 7);
        assert_eq!(
            stage.pulse_range.unwrap(),
            SampleRange::new(5, 7, 10).unwrap()
        );
        assert_eq!(result.matches[0].range, SampleRange::new(5, 8, 10).unwrap());
    }
    #[test]
    fn phase_conflicts_distinguish_valid_before_from_invalid_after() {
        let mut rule = TriggerRule {
            schema_version: "1".into(),
            steps: vec![edge()],
            holdoff_samples: 0.into(),
        };
        rule.steps[0].guards.push(Guard {
            channel: 0,
            high: false,
            phase: Phase::Before,
        });
        assert_eq!(validate(&rule, &[0]).satisfiability, "satisfiable_in_model");
        rule.steps[0].guards[0].phase = Phase::After;
        assert_eq!(validate(&rule, &[0]).satisfiability, "proven_unsatisfiable");
        assert!(!validate(&rule, &[1]).valid);
    }
    #[test]
    fn sequence_matches_precise_pulse_anchor_and_reports_confirmation_separately() {
        let rule = TriggerRule {
            schema_version: "1".into(),
            steps: vec![
                edge(),
                Step {
                    event: Event::PulseWidth {
                        channel: 1,
                        high: true,
                        min_width_samples: 1.into(),
                        max_width_exclusive: 3.into(),
                        anchor: PulseAnchor::PulseStart,
                    },
                    guards: vec![Guard {
                        channel: 2,
                        high: false,
                        phase: Phase::After,
                    }],
                    within: Some(Within {
                        min_samples: 0.into(),
                        max_samples: 5.into(),
                    }),
                },
            ],
            holdoff_samples: 0.into(),
        };
        let signals = [
            (
                0,
                Signal {
                    high_before_start: false,
                    previous_edge: None,
                    edges: vec![2, 10],
                    next_edge: None,
                },
            ),
            (
                1,
                Signal {
                    high_before_start: false,
                    previous_edge: None,
                    edges: vec![5, 7, 15],
                    next_edge: None,
                },
            ),
            (
                2,
                Signal {
                    high_before_start: false,
                    previous_edge: None,
                    edges: vec![],
                    next_edge: None,
                },
            ),
        ]
        .into_iter()
        .collect();
        let result = simulate(
            &rule,
            SampleRange::new(0, 20, 20).unwrap(),
            &signals,
            &[0, 1, 2],
            100,
            &AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!(result.total_matches.0, 1);
        assert_eq!(result.matches[0].anchor_sample.0, 5);
        assert_eq!(result.matches[0].confirmation_sample.0, 7);
        assert_eq!(result.stages[1].candidate_events.0, 1);
        assert!(simulate(
            &rule,
            SampleRange::new(0, 20, 20).unwrap(),
            &signals,
            &[0, 1, 2],
            100,
            &AtomicBool::new(true)
        )
        .is_err());
    }
    #[test]
    fn no_observed_match_does_not_claim_logical_impossibility() {
        let rule = TriggerRule {
            schema_version: "1".into(),
            steps: vec![edge()],
            holdoff_samples: 0.into(),
        };
        let signals = [(
            0,
            Signal {
                high_before_start: true,
                previous_edge: None,
                edges: vec![],
                next_edge: None,
            },
        )]
        .into_iter()
        .collect();
        assert_eq!(
            simulate(
                &rule,
                SampleRange::new(0, 10, 10).unwrap(),
                &signals,
                &[0],
                100,
                &AtomicBool::new(false)
            )
            .unwrap()
            .status,
            "no_observed_match"
        );
        assert_eq!(validate(&rule, &[0]).satisfiability, "satisfiable_in_model");
    }
    #[test]
    fn later_intermediate_candidate_is_checked_when_earliest_cannot_complete() {
        let mut rule = TriggerRule {
            schema_version: "1".into(),
            steps: vec![edge()],
            holdoff_samples: 0.into(),
        };
        for (channel, max) in [(1, 10), (2, 2)] {
            rule.steps.push(Step {
                event: Event::Edge {
                    channel,
                    direction: EdgeDirection::Rising,
                },
                guards: vec![],
                within: Some(Within {
                    min_samples: 0.into(),
                    max_samples: max.into(),
                }),
            });
        }
        let signals = [
            (
                0,
                Signal {
                    high_before_start: false,
                    previous_edge: None,
                    edges: vec![2],
                    next_edge: None,
                },
            ),
            (
                1,
                Signal {
                    high_before_start: false,
                    previous_edge: None,
                    edges: vec![3, 4, 8],
                    next_edge: None,
                },
            ),
            (
                2,
                Signal {
                    high_before_start: false,
                    previous_edge: None,
                    edges: vec![9],
                    next_edge: None,
                },
            ),
        ]
        .into_iter()
        .collect();
        let result = simulate(
            &rule,
            SampleRange::new(0, 20, 20).unwrap(),
            &signals,
            &[0, 1, 2],
            100,
            &AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!(result.total_matches.0, 1);
        assert_eq!(result.matches[0].stages[1].anchor_sample.0, 8);
    }
}
