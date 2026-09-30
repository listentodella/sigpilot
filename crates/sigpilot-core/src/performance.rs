use std::{
    collections::BTreeMap,
    sync::{Mutex, OnceLock},
    time::Duration,
};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PerformanceEvent {
    pub sequence: usize,
    pub component: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backend: Option<String>,
    pub stage: String,
    pub elapsed_ms: f64,
    pub fields: BTreeMap<String, String>,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub detail: String,
}

#[derive(Debug)]
struct ActiveCapture {
    id: u64,
    events: Vec<PerformanceEvent>,
}

#[derive(Debug)]
pub struct PerformanceCapture {
    id: u64,
    finished: bool,
}

static ACTIVE_CAPTURE: OnceLock<Mutex<Option<ActiveCapture>>> = OnceLock::new();
static NEXT_CAPTURE_ID: OnceLock<Mutex<u64>> = OnceLock::new();

impl PerformanceCapture {
    pub fn start() -> std::result::Result<Self, &'static str> {
        let mut active = active_capture()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if active.is_some() {
            return Err("a performance timing capture is already active");
        }
        let id = {
            let mut next = NEXT_CAPTURE_ID
                .get_or_init(|| Mutex::new(1))
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let id = *next;
            *next = next.saturating_add(1);
            id
        };
        *active = Some(ActiveCapture {
            id,
            events: Vec::new(),
        });
        Ok(Self {
            id,
            finished: false,
        })
    }

    pub fn finish(mut self) -> Vec<PerformanceEvent> {
        self.finished = true;
        take_capture(self.id)
    }
}

impl Drop for PerformanceCapture {
    fn drop(&mut self) {
        if !self.finished {
            let _ = take_capture(self.id);
        }
    }
}

pub fn record_performance_event(
    component: &str,
    backend: Option<&str>,
    stage: &str,
    elapsed: Duration,
    detail: &str,
) {
    let mut active = active_capture()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let Some(active) = active.as_mut() else {
        return;
    };
    active.events.push(PerformanceEvent {
        sequence: active.events.len(),
        component: component.to_string(),
        backend: backend.map(str::to_string),
        stage: stage.to_string(),
        elapsed_ms: elapsed.as_secs_f64() * 1_000.0,
        fields: parse_timing_fields(detail),
        detail: detail.to_string(),
    });
}

fn active_capture() -> &'static Mutex<Option<ActiveCapture>> {
    ACTIVE_CAPTURE.get_or_init(|| Mutex::new(None))
}

fn take_capture(id: u64) -> Vec<PerformanceEvent> {
    let mut active = active_capture()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if active.as_ref().is_some_and(|capture| capture.id == id) {
        return active
            .take()
            .map(|capture| capture.events)
            .unwrap_or_default();
    }
    Vec::new()
}

fn parse_timing_fields(detail: &str) -> BTreeMap<String, String> {
    detail
        .split_ascii_whitespace()
        .filter_map(|item| item.split_once('='))
        .map(|(key, value)| {
            (
                key.trim_matches(|character: char| {
                    !character.is_ascii_alphanumeric() && character != '_'
                })
                .to_string(),
                value.trim_matches(',').to_string(),
            )
        })
        .filter(|(key, _)| !key.is_empty())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn structured_capture_preserves_timing_fields() {
        let capture = PerformanceCapture::start().unwrap();
        record_performance_event(
            "decoder",
            Some("saleae"),
            "persistent_response_read",
            Duration::from_micros(1_250),
            "response_bytes=42 binary_bytes=128 framed=true",
        );
        let events = capture.finish();

        assert_eq!(events.len(), 1);
        assert_eq!(events[0].component, "decoder");
        assert_eq!(events[0].backend.as_deref(), Some("saleae"));
        assert_eq!(events[0].elapsed_ms, 1.25);
        assert_eq!(events[0].fields["response_bytes"], "42");
        assert_eq!(events[0].fields["binary_bytes"], "128");
    }
}
