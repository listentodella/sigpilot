//! Digital timing checks on original sample coordinates. Anchor traversal and
//! the ability to decide a finite timing requirement are reported separately.
use crate::{
    edges::{validate_window, EdgeDirection},
    providers::{
        descriptor, exact, AnalysisProvider, ProviderContext, ProviderDescriptor, ProviderEvidence,
        ProviderPage, RelatedChannel,
    },
    AnalysisError, ExactU64, Result, SampleRange,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sigpilot_core::DigitalChannelWindow;
use std::sync::atomic::Ordering;

pub struct MultiChannelTimingProvider;
#[derive(Debug, Clone, Copy, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum Report {
    #[default]
    All,
    ViolationsAndUnknown,
}
fn limit() -> usize {
    100
}
#[derive(Debug, Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case", deny_unknown_fields)]
enum Parameters {
    SetupHold {
        data_channel: u8,
        anchor_direction: EdgeDirection,
        min_setup_samples: ExactU64,
        min_hold_samples: ExactU64,
        #[serde(default)]
        report: Report,
        #[serde(default = "limit")]
        limit: usize,
    },
    EdgeDelay {
        response_channel: u8,
        anchor_direction: EdgeDirection,
        #[serde(default)]
        response_direction: Option<EdgeDirection>,
        min_delay_samples: ExactU64,
        max_delay_samples: ExactU64,
        #[serde(default)]
        report: Report,
        #[serde(default = "limit")]
        limit: usize,
    },
}
impl Parameters {
    fn channel(&self) -> u8 {
        match self {
            Self::SetupHold { data_channel, .. } => *data_channel,
            Self::EdgeDelay {
                response_channel, ..
            } => *response_channel,
        }
    }
    fn direction(&self) -> EdgeDirection {
        match self {
            Self::SetupHold {
                anchor_direction, ..
            }
            | Self::EdgeDelay {
                anchor_direction, ..
            } => *anchor_direction,
        }
    }
    fn options(&self) -> (Report, usize) {
        match self {
            Self::SetupHold { report, limit, .. } | Self::EdgeDelay { report, limit, .. } => {
                (*report, *limit)
            }
        }
    }
    fn lookahead(&self) -> u64 {
        match self {
            Self::SetupHold {
                min_hold_samples, ..
            } => min_hold_samples.0,
            Self::EdgeDelay {
                max_delay_samples, ..
            } => max_delay_samples.0,
        }
        .saturating_add(1)
    }
}
fn parse(value: &Value) -> Result<Parameters> {
    let p: Parameters = serde_json::from_value(value.clone())
        .map_err(|e| AnalysisError::InvalidInput(e.to_string()))?;
    let (_, limit) = p.options();
    if p.channel() > 31
        || limit == 0
        || limit > 100
        || matches!(&p, Parameters::EdgeDelay{min_delay_samples,max_delay_samples,..} if min_delay_samples > max_delay_samples)
    {
        return Err(AnalysisError::InvalidInput(
            "timing requires a captured channel, limit 1..100 and nonempty inclusive delay bounds"
                .into(),
        ));
    }
    Ok(p)
}
impl AnalysisProvider for MultiChannelTimingProvider {
    fn descriptor(&self) -> ProviderDescriptor {
        let direction = json!({"type":"string","enum":["rising","falling"]});
        let common = json!({"anchor_direction":direction,"report":{"type":"string","enum":["all","violations_and_unknown"],"default":"all"},
            "limit":{"type":"integer","minimum":1,"maximum":100,"default":100}});
        let mut setup = common.clone();
        setup["mode"] = json!({"const":"setup_hold"});
        setup["data_channel"] = json!({"type":"integer","minimum":0,"maximum":31});
        setup["min_setup_samples"] = exact();
        setup["min_hold_samples"] = exact();
        let mut delay = common;
        delay["mode"] = json!({"const":"edge_delay"});
        delay["response_channel"] = json!({"type":"integer","minimum":0,"maximum":31});
        delay["response_direction"] = json!({"anyOf":[direction,{"type":"null"}],"description":"Omit for either edge direction."});
        delay["min_delay_samples"] = exact();
        delay["max_delay_samples"] = exact();
        let mut d = descriptor(
            "sigpilot.multichannel_timing",
            json!({"oneOf":[
            {"type":"object","additionalProperties":false,"required":["mode","data_channel","anchor_direction","min_setup_samples","min_hold_samples"],"properties":setup},
            {"type":"object","additionalProperties":false,"required":["mode","response_channel","anchor_direction","min_delay_samples","max_delay_samples"],"properties":delay}]}),
        );
        d.max_results_per_page = 100.into();
        d.output_schema["description"] = json!("coverage/complete describe anchor traversal; assessments_complete states whether every inspected requirement was decided. Unknown is preserved at capture or edge-budget boundaries. setup/hold includes simultaneous data edges at zero duration. edge_delay selects the first qualifying response at or after each anchor; responses may be shared. All times are original digital sample-grid observations.");
        d
    }
    fn validate_parameters(&self, value: &Value) -> Result<()> {
        parse(value).map(|_| ())
    }
    fn related_channels(&self, primary: u8, value: &Value) -> Result<Vec<RelatedChannel>> {
        let p = parse(value)?;
        if primary == p.channel() {
            return Err(AnalysisError::InvalidInput(
                "timing requires two distinct channels".into(),
            ));
        }
        Ok(vec![RelatedChannel {
            channel: p.channel(),
            lookahead_samples: p.lookahead(),
        }])
    }
    fn run(&self, c: ProviderContext<'_>, value: Value) -> Result<ProviderPage> {
        let p = parse(&value)?;
        let data = c
            .related_windows
            .iter()
            .find(|w| w.channel == p.channel())
            .ok_or_else(|| {
                AnalysisError::InvalidInput("timing related channel window is missing".into())
            })?;
        validate_window(c.window)?;
        validate_window(data)?;
        c.original_range.validate(c.window.capture_sample_count)?;
        if data.channel == c.window.channel
            || data.start_sample != c.window.start_sample
            || data.capture_sample_count != c.window.capture_sample_count
            || data.sample_rate_hz != c.window.sample_rate_hz
            || c.window.start_sample < c.original_range.start_sample.0
            || c.window.requested_end_sample != c.original_range.end_sample.0
            || data.requested_end_sample < c.original_range.end_sample.0
        {
            return Err(AnalysisError::InvalidInput(
                "timing windows must share capture metadata and continuation".into(),
            ));
        }
        if c.cancelled.load(Ordering::Acquire) {
            return Err(AnalysisError::Cancelled);
        }
        let (report, limit) = p.options();
        let mut end = c
            .window
            .end_sample
            .min(data.end_sample)
            .min(c.original_range.end_sample.0);
        let mut high = c.window.high_before_start;
        let mut items = Vec::new();
        let mut evidence = Vec::new();
        let responses = response_edges(data);
        let mut inspected = 0u64;
        let mut met = 0u64;
        let mut violations = 0u64;
        let mut unknown = 0u64;
        let mut scanned = 0u64;
        let mut stop = None;
        for &anchor in &c.window.transitions {
            if anchor >= end {
                break;
            }
            if c.cancelled.load(Ordering::Acquire) {
                return Err(AnalysisError::Cancelled);
            }
            let direction = if high {
                EdgeDirection::Falling
            } else {
                EdgeDirection::Rising
            };
            high = !high;
            if direction != p.direction() {
                scanned += 1;
                continue;
            }
            let (mut item, range) = match &p {
                Parameters::SetupHold {
                    min_setup_samples,
                    min_hold_samples,
                    ..
                } => setup_hold(data, anchor, min_setup_samples.0, min_hold_samples.0)?,
                Parameters::EdgeDelay {
                    response_direction,
                    min_delay_samples,
                    max_delay_samples,
                    ..
                } => edge_delay(
                    data,
                    &responses,
                    anchor,
                    *response_direction,
                    min_delay_samples.0,
                    max_delay_samples.0,
                )?,
            };
            let status = item["status"].as_str().unwrap();
            let emit = report == Report::All || status != "met";
            if emit && items.len() == limit {
                end = anchor;
                stop = Some("result_limit");
                break;
            }
            scanned += 1;
            inspected += 1;
            match status {
                "met" => met += 1,
                "violation" => violations += 1,
                _ => unknown += 1,
            }
            item["anchor"] = json!({"channel":c.window.channel,"sample":anchor.to_string(),"direction":direction});
            item["related_channel"] = json!(data.channel);
            if emit {
                evidence.push(ProviderEvidence {
                    range,
                    channels: vec![c.window.channel, data.channel],
                    observed: item.clone(),
                });
                items.push(item);
            }
        }
        if c.cancelled.load(Ordering::Acquire) {
            return Err(AnalysisError::Cancelled);
        }
        let complete = end == c.original_range.end_sample.0;
        if !complete && stop.is_none() {
            stop = Some("input_edge_budget");
        }
        Ok(ProviderPage {
            evidence,
            value: json!({"items":items,"coverage":{"start_sample":c.window.start_sample.to_string(),"end_sample":end.to_string()},
            "scanned_edges":scanned.to_string(),"inspected_anchors":inspected.to_string(),"met":met.to_string(),"violations":violations.to_string(),"unknown":unknown.to_string(),
            "complete":complete,"truncated":!complete,"next_start_sample":if complete {None}else{Some(end.to_string())},"stop_reason":stop,
            "assessments_complete":unknown==0,"interpretation":"original_digital_sample_grid","sample_rate_hz":c.window.sample_rate_hz.to_string(),
            "input_coverage":[input_coverage(c.window),input_coverage(data)],"response_policy":"independent_first_at_or_after_anchor"}),
        })
    }
}
fn input_coverage(w: &DigitalChannelWindow) -> Value {
    json!({"channel":w.channel,"start_sample":w.start_sample.to_string(),"end_sample":w.end_sample.to_string(),"requested_end_sample":w.requested_end_sample.to_string(),
        "scanned_edges":w.transitions.len().to_string(),"complete":w.complete,"previous_transition":w.previous_transition.map(ExactU64),"next_transition":w.next_transition.map(ExactU64)})
}
#[derive(Debug, Serialize)]
struct Check {
    status: &'static str,
    required_samples: ExactU64,
    actual_samples: Option<ExactU64>,
    lower_bound_samples: ExactU64,
    reason: Option<&'static str>,
}
fn requirement(actual: Option<u64>, lower: u64, minimum: u64) -> Check {
    let (status, reason) = match actual {
        Some(v) => (if v < minimum { "violation" } else { "met" }, None),
        None if lower >= minimum => ("met", Some("capture_boundary_lower_bound")),
        None => ("unknown", Some("capture_boundary")),
    };
    Check {
        status,
        reason,
        required_samples: minimum.into(),
        actual_samples: actual.map(ExactU64),
        lower_bound_samples: actual.unwrap_or(lower).into(),
    }
}
fn setup_hold(
    w: &DigitalChannelWindow,
    anchor: u64,
    setup_min: u64,
    hold_min: u64,
) -> Result<(Value, SampleRange)> {
    // A simultaneous transition is conservatively zero for both requirements;
    // there is no sub-sample ordering information in this capture.
    let pos = w.transitions.partition_point(|&s| s < anchor);
    let next = w.transitions.get(pos).copied().or(w.next_transition);
    let prev = if next == Some(anchor) {
        next
    } else {
        pos.checked_sub(1)
            .map(|i| w.transitions[i])
            .or(w.previous_transition)
    };
    let setup = requirement(prev.map(|s| anchor - s), anchor, setup_min);
    let hold = requirement(
        next.map(|s| s - anchor),
        w.capture_sample_count - 1 - anchor,
        hold_min,
    );
    let status = if setup.status == "violation" || hold.status == "violation" {
        "violation"
    } else if setup.status == "unknown" || hold.status == "unknown" {
        "unknown"
    } else {
        "met"
    };
    let range = SampleRange::new(
        prev.unwrap_or(0),
        next.unwrap_or(w.capture_sample_count - 1) + 1,
        w.capture_sample_count,
    )?;
    Ok((
        json!({"mode":"setup_hold","status":status,"setup":setup,"hold":hold,
        "previous_data_transition":prev.map(ExactU64),"next_data_transition":next.map(ExactU64),"simultaneous":next==Some(anchor)}),
        range,
    ))
}
fn response_edges(w: &DigitalChannelWindow) -> Vec<(u64, EdgeDirection)> {
    let mut high = w.high_before_start;
    w.transitions
        .iter()
        .copied()
        .chain(w.next_transition)
        .map(|s| {
            let direction = if high {
                EdgeDirection::Falling
            } else {
                EdgeDirection::Rising
            };
            high = !high;
            (s, direction)
        })
        .collect()
}
fn edge_delay(
    w: &DigitalChannelWindow,
    edges: &[(u64, EdgeDirection)],
    anchor: u64,
    direction: Option<EdgeDirection>,
    min: u64,
    max: u64,
) -> Result<(Value, SampleRange)> {
    let deadline = anchor.saturating_add(max);
    let begin = edges.partition_point(|(s, _)| *s < anchor);
    let response = edges[begin..]
        .iter()
        .copied()
        .find(|(_, d)| direction.is_none_or(|wanted| wanted == *d));
    let observed_through = w.next_transition.unwrap_or(w.capture_sample_count - 1);
    let (status, reason, latency, response) = match response {
        Some((s, d)) if s <= deadline => (
            if s - anchor < min { "violation" } else { "met" },
            None,
            Some(s - anchor),
            Some((s, d)),
        ),
        _ if deadline <= observed_through => {
            ("violation", Some("no_response_within_window"), None, None)
        }
        _ => (
            "unknown",
            Some(if w.complete && w.next_transition.is_none() {
                "capture_boundary"
            } else {
                "input_edge_budget"
            }),
            None,
            None,
        ),
    };
    let end = response
        .map(|(s, _)| s)
        .unwrap_or(deadline.min(observed_through))
        .min(w.capture_sample_count - 1);
    let range = SampleRange::new(anchor, end + 1, w.capture_sample_count)?;
    Ok((
        json!({"mode":"edge_delay","status":status,"reason":reason,"delay_samples":latency.map(ExactU64),
        "min_delay_samples":min.to_string(),"max_delay_samples":max.to_string(),"response":response.map(|(s,d)|json!({"sample":s.to_string(),"direction":d})),
        "observed_through_sample":observed_through.to_string(),"response_policy":"independent_first_at_or_after_anchor"}),
        range,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;
    fn window(channel: u8, shift: u64, edges: &[u64]) -> DigitalChannelWindow {
        DigitalChannelWindow {
            channel,
            sample_rate_hz: 1_000_000,
            capture_sample_count: shift + 40,
            start_sample: shift,
            end_sample: shift + 30,
            requested_end_sample: shift + 30,
            high_before_start: false,
            previous_transition: None,
            next_transition: None,
            transitions: edges.iter().map(|s| shift + s).collect(),
            complete: true,
        }
    }
    fn run(a: &DigitalChannelWindow, b: &DigitalChannelWindow, p: Value) -> ProviderPage {
        MultiChannelTimingProvider
            .run(
                ProviderContext {
                    window: a,
                    related_windows: std::slice::from_ref(b),
                    original_range: SampleRange::new(
                        a.start_sample,
                        a.requested_end_sample,
                        a.capture_sample_count,
                    )
                    .unwrap(),
                    cancelled: &AtomicBool::new(false),
                },
                p,
            )
            .unwrap()
    }
    fn setup() -> Value {
        json!({"mode":"setup_hold","data_channel":1,"anchor_direction":"rising","min_setup_samples":"3","min_hold_samples":"2"})
    }
    fn delay() -> Value {
        json!({"mode":"edge_delay","response_channel":1,"anchor_direction":"rising","response_direction":"rising","min_delay_samples":"1","max_delay_samples":"5"})
    }
    #[test]
    fn setup_hold_uses_exact_large_coordinates_and_simultaneous_edges_are_zero() {
        let shift = (1u64 << 53) + 17;
        let a = window(0, shift, &[10, 15, 20]);
        let b = window(1, shift, &[7, 12, 20, 23]);
        let page = run(&a, &b, setup());
        assert_eq!(page.value["items"][0]["status"], "met");
        assert_eq!(page.value["items"][0]["setup"]["actual_samples"], "3");
        assert_eq!(page.value["items"][0]["hold"]["actual_samples"], "2");
        assert_eq!(page.value["items"][1]["status"], "violation");
        assert_eq!(page.value["items"][1]["setup"]["actual_samples"], "0");
        assert_eq!(page.value["items"][1]["hold"]["actual_samples"], "0");
        assert_eq!(page.evidence[1].range.start_sample.0, shift + 20);
    }
    #[test]
    fn missing_boundary_edges_return_lower_bounds_and_never_fabricate_a_duration() {
        let a = window(0, 0, &[2, 5, 28]);
        let b = window(1, 0, &[]);
        let mut p = setup();
        p["min_setup_samples"] = json!("3");
        p["min_hold_samples"] = json!("12");
        let page = run(&a, &b, p);
        assert_eq!(page.value["items"][0]["status"], "unknown");
        assert!(page.value["items"][0]["setup"]["actual_samples"].is_null());
        assert_eq!(page.value["items"][1]["hold"]["status"], "unknown");
        assert_eq!(page.value["items"][1]["hold"]["lower_bound_samples"], "11");
        assert_eq!(page.value["complete"], true);
        assert_eq!(page.value["assessments_complete"], false);
    }
    #[test]
    fn setup_hold_uses_neighbors_outside_anchor_range_and_page_boundary() {
        let mut a = window(0, 0, &[10, 15]);
        a.start_sample = 10;
        a.end_sample = 20;
        a.requested_end_sample = 20;
        let mut b = window(1, 0, &[12]);
        b.start_sample = 10;
        b.end_sample = 20;
        b.requested_end_sample = 20;
        b.previous_transition = Some(7);
        b.next_transition = Some(25);
        let page = run(&a, &b, setup());
        assert_eq!(page.value["items"][0]["setup"]["actual_samples"], "3");
        assert_eq!(page.evidence[0].range.start_sample.0, 7);
        a.transitions = vec![15];
        a.high_before_start = false;
        b.start_sample = 10;
        b.transitions.clear();
        b.previous_transition = Some(7);
        b.next_transition = Some(25);
        assert_eq!(
            run(&a, &b, setup()).value["items"][0]["hold"]["actual_samples"],
            "10"
        );
    }
    #[test]
    fn delay_respects_polarity_inclusive_bounds_and_independent_shared_responses() {
        let a = window(0, 0, &[10, 11, 12]);
        let b = window(1, 0, &[9, 11, 15]);
        let page = run(&a, &b, delay());
        assert_eq!(page.value["items"][0]["delay_samples"], "5");
        assert_eq!(page.value["items"][1]["delay_samples"], "3");
        assert_eq!(page.value["items"][0]["response"]["sample"], "15");
        let a = window(0, 0, &[15]);
        let page = run(&a, &b, delay());
        assert_eq!(page.value["items"][0]["delay_samples"], "0");
        assert_eq!(page.value["items"][0]["status"], "violation");
    }
    #[test]
    fn delay_distinguishes_proven_timeout_from_capture_and_input_budget_unknown() {
        let a = window(0, 0, &[10]);
        let b = window(1, 0, &[]);
        let page = run(&a, &b, delay());
        assert_eq!(
            page.value["items"][0]["reason"],
            "no_response_within_window"
        );
        let a = window(0, 0, &[28]);
        let mut p = delay();
        p["max_delay_samples"] = json!("20");
        assert_eq!(
            run(&a, &b, p).value["items"][0]["reason"],
            "capture_boundary"
        );
        let a = window(0, 0, &[10]);
        let mut b = window(1, 0, &[9, 11]);
        b.end_sample = 12;
        b.complete = false;
        b.next_transition = Some(12);
        // The lookahead is rising and decides this particular anchor exactly.
        assert_eq!(run(&a, &b, delay()).value["items"][0]["delay_samples"], "2");
        let mut p = delay();
        p["response_direction"] = json!("falling");
        b.transitions = vec![9, 10, 11];
        b.next_transition = Some(12);
        let a = window(0, 0, &[11]);
        let page = run(&a, &b, p);
        assert_eq!(page.value["items"][0]["delay_samples"], "1");
        b.transitions = vec![9, 10];
        b.next_transition = Some(12);
        let mut p = delay();
        p["response_direction"] = json!("falling");
        let page = run(&a, &b, p);
        assert_eq!(page.value["items"][0]["status"], "unknown");
        assert_eq!(page.value["items"][0]["reason"], "input_edge_budget");
        assert_eq!(page.value["coverage"]["end_sample"], "12");
        assert_eq!(page.value["next_start_sample"], "12");
    }
    #[test]
    fn result_limit_resumes_at_unconsumed_anchor_and_violation_filter_retains_unknown() {
        let a = window(0, 0, &[10, 15, 20]);
        let b = window(1, 0, &[7, 12, 20, 23]);
        let mut p = setup();
        p["limit"] = json!(1);
        let page = run(&a, &b, p);
        assert_eq!(page.value["next_start_sample"], "20");
        assert_eq!(page.value["inspected_anchors"], "1");
        let mut a = a;
        a.start_sample = 20;
        a.transitions = vec![20];
        a.high_before_start = false;
        a.previous_transition = Some(15);
        let mut b = b;
        b.start_sample = 20;
        b.transitions = vec![20, 23];
        b.high_before_start = false;
        b.previous_transition = Some(12);
        let next = run(&a, &b, setup());
        assert_eq!(next.value["items"].as_array().unwrap().len(), 1);
        assert_eq!(next.value["items"][0]["anchor"]["sample"], "20");
        let mut p = setup();
        p["report"] = json!("violations_and_unknown");
        assert_eq!(run(&a, &b, p).value["items"].as_array().unwrap().len(), 1);
    }
    #[test]
    fn channels_parameters_and_cancellation_are_validated_before_execution() {
        assert!(MultiChannelTimingProvider
            .related_channels(1, &setup())
            .is_err());
        let mut p = delay();
        p["max_delay_samples"] = json!("0");
        assert!(parse(&p).is_err());
        p = setup();
        p["script"] = json!("fake");
        assert!(parse(&p).is_err());
        let a = window(0, 0, &[10]);
        let b = window(1, 0, &[]);
        assert!(matches!(
            MultiChannelTimingProvider.run(
                ProviderContext {
                    window: &a,
                    related_windows: &[b],
                    original_range: SampleRange::new(0, 30, 40).unwrap(),
                    cancelled: &AtomicBool::new(true)
                },
                setup()
            ),
            Err(AnalysisError::Cancelled)
        ));
    }
}
