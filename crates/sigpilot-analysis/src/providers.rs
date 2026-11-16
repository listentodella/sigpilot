//! Trusted startup registration. Callers pass parameters, never executable code.
use crate::{AnalysisError, ExactU64, Result, SampleRange};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sigpilot_core::DigitalChannelWindow;
use std::{
    collections::BTreeMap,
    sync::{atomic::AtomicBool, Arc},
};

#[derive(Debug, Clone, Serialize)]
pub struct ProviderDescriptor {
    pub provider_id: String,
    pub version: String,
    pub parameter_schema: Value,
    pub output_schema: Value,
    pub deterministic: bool,
    pub supports_incremental: bool,
    pub cancellable: bool,
    pub input_representation: String,
    pub max_edges_per_page: ExactU64,
    pub max_results_per_page: ExactU64,
}
pub struct ProviderContext<'a> {
    pub window: &'a DigitalChannelWindow,
    pub related_windows: &'a [DigitalChannelWindow],
    pub original_range: SampleRange,
    pub cancelled: &'a AtomicBool,
}
/// Trusted providers declare additional bounded inputs before execution. The
/// host resolves every channel against the same explicit capture revision.
pub struct RelatedChannel {
    pub channel: u8,
    pub lookahead_samples: u64,
}
pub struct ProviderEvidence {
    pub range: SampleRange,
    pub channels: Vec<u8>,
    pub observed: Value,
}
pub struct ProviderPage {
    pub value: Value,
    pub evidence: Vec<ProviderEvidence>,
}
pub trait AnalysisProvider: Send + Sync {
    fn descriptor(&self) -> ProviderDescriptor;
    fn validate_parameters(&self, parameters: &Value) -> Result<()>;
    fn related_channels(&self, _primary: u8, _parameters: &Value) -> Result<Vec<RelatedChannel>> {
        Ok(vec![])
    }
    fn run(&self, context: ProviderContext<'_>, parameters: Value) -> Result<ProviderPage>;
}
pub struct ProviderRegistry {
    providers: BTreeMap<String, Arc<dyn AnalysisProvider>>,
}
impl Default for ProviderRegistry {
    fn default() -> Self {
        let mut registry = Self {
            providers: BTreeMap::new(),
        };
        registry
            .register(Arc::new(PulseWidthProvider))
            .expect("valid built-in provider");
        registry
            .register(Arc::new(RangeMeasureProvider))
            .expect("valid built-in provider");
        registry
            .register(Arc::new(crate::timing::MultiChannelTimingProvider))
            .expect("valid built-in provider");
        registry
    }
}
impl ProviderRegistry {
    pub fn register(&mut self, provider: Arc<dyn AnalysisProvider>) -> Result<()> {
        let d = provider.descriptor();
        if self.providers.len() >= 64
            || d.provider_id.is_empty()
            || d.provider_id.len() > 128
            || !d
                .provider_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
            || d.version.is_empty()
            || d.version.len() > 64
            || d.max_edges_per_page.0 == 0
            || d.max_edges_per_page.0 > 4096
            || d.max_results_per_page.0 == 0
            || d.max_results_per_page.0 > 1000
            || serde_json::to_vec(&d).map_or(true, |s| s.len() > 16 * 1024)
        {
            return Err(AnalysisError::InvalidInput(
                "invalid provider descriptor or registration budget".into(),
            ));
        }
        if self.providers.contains_key(&d.provider_id) {
            return Err(AnalysisError::InvalidInput(
                "provider ID already registered".into(),
            ));
        }
        self.providers.insert(d.provider_id, provider);
        Ok(())
    }
    pub fn catalog(&self) -> Vec<ProviderDescriptor> {
        self.providers.values().map(|p| p.descriptor()).collect()
    }
    pub fn get(&self, id: &str) -> Option<Arc<dyn AnalysisProvider>> {
        self.providers.get(id).cloned()
    }
}
pub(crate) fn exact() -> Value {
    json!({"type":"string","pattern":"^(0|[1-9][0-9]{0,19})$"})
}
pub(crate) fn descriptor(id: &str, schema: Value) -> ProviderDescriptor {
    ProviderDescriptor {
        provider_id: id.into(),
        version: "1".into(),
        parameter_schema: schema,
        output_schema: json!({"type":"object","required":["coverage","complete"],"properties":{"coverage":{"type":"object"},"complete":{"type":"boolean"}}}),
        deterministic: true,
        supports_incremental: false,
        cancellable: true,
        input_representation: "original_digital_edges".into(),
        max_edges_per_page: 4096.into(),
        max_results_per_page: 1000.into(),
    }
}
pub struct PulseWidthProvider;
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PulseParameters {
    high: Option<bool>,
    min_width_samples: ExactU64,
    max_width_exclusive: Option<ExactU64>,
    #[serde(default = "limit")]
    limit: usize,
}
fn limit() -> usize {
    100
}
fn pulse_parameters(parameters: &Value) -> Result<PulseParameters> {
    let p: PulseParameters = serde_json::from_value(parameters.clone())
        .map_err(|e| AnalysisError::InvalidInput(e.to_string()))?;
    if p.min_width_samples.0 == 0
        || p.limit == 0
        || p.limit > 1000
        || p.max_width_exclusive
            .is_some_and(|v| v <= p.min_width_samples)
    {
        return Err(AnalysisError::InvalidInput(
            "invalid pulse parameters".into(),
        ));
    }
    Ok(p)
}
impl AnalysisProvider for PulseWidthProvider {
    fn descriptor(&self) -> ProviderDescriptor {
        descriptor(
            "sigpilot.pulse_width",
            json!({"type":"object","additionalProperties":false,"required":["min_width_samples"],"properties":{
        "high":{"type":["boolean","null"]},"min_width_samples":exact(),"max_width_exclusive":{"anyOf":[exact(),{"type":"null"}]},"limit":{"type":"integer","minimum":1,"maximum":1000,"default":100}}}),
        )
    }
    fn validate_parameters(&self, parameters: &Value) -> Result<()> {
        pulse_parameters(parameters).map(|_| ())
    }
    fn run(&self, c: ProviderContext<'_>, parameters: Value) -> Result<ProviderPage> {
        let p = pulse_parameters(&parameters)?;
        let page = crate::scan_pulses(
            c.window,
            &crate::PulseQuery {
                range: c.original_range,
                high: p.high,
                min_width_samples: p.min_width_samples,
                max_width_exclusive: p.max_width_exclusive,
                limit: p.limit,
            },
            c.cancelled,
        )?;
        let evidence = page
            .scan
            .items
            .iter()
            .map(|p| ProviderEvidence {
                range: p.range,
                channels: vec![p.channel],
                observed: json!(p),
            })
            .collect();
        Ok(ProviderPage {
            value: json!(page),
            evidence,
        })
    }
}
pub struct RangeMeasureProvider;
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Empty {}
impl AnalysisProvider for RangeMeasureProvider {
    fn descriptor(&self) -> ProviderDescriptor {
        descriptor(
            "sigpilot.range_measure",
            json!({"type":"object","additionalProperties":false,"properties":{}}),
        )
    }
    fn validate_parameters(&self, parameters: &Value) -> Result<()> {
        serde_json::from_value::<Empty>(parameters.clone())
            .map(|_| ())
            .map_err(|e| AnalysisError::InvalidInput(e.to_string()))
    }
    fn run(&self, c: ProviderContext<'_>, parameters: Value) -> Result<ProviderPage> {
        self.validate_parameters(&parameters)?;
        if c.cancelled.load(std::sync::atomic::Ordering::Acquire) {
            return Err(AnalysisError::Cancelled);
        }
        let r = crate::measure::measure_range(c.window, c.original_range)?;
        Ok(ProviderPage {
            value: json!(r),
            evidence: vec![ProviderEvidence {
                range: r.coverage,
                channels: vec![r.channel],
                observed: json!(r),
            }],
        })
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn registration_and_parameter_validation_precede_work() {
        let mut r = ProviderRegistry::default();
        assert_eq!(r.catalog().len(), 3);
        assert!(r.register(Arc::new(PulseWidthProvider)).is_err());
        assert!(r
            .get("sigpilot.range_measure")
            .unwrap()
            .validate_parameters(&json!({"script":"fake"}))
            .is_err());
        let w = DigitalChannelWindow {
            channel: 0,
            sample_rate_hz: 1000000,
            capture_sample_count: 10,
            start_sample: 0,
            end_sample: 10,
            requested_end_sample: 10,
            high_before_start: false,
            previous_transition: None,
            next_transition: None,
            transitions: vec![2, 4, 6],
            complete: true,
        };
        let range = SampleRange::new(0, 10, 10).unwrap();
        let cancel = AtomicBool::new(false);
        let p = r
            .get("sigpilot.pulse_width")
            .unwrap()
            .run(
                ProviderContext {
                    window: &w,
                    related_windows: &[],
                    original_range: range,
                    cancelled: &cancel,
                },
                json!({"min_width_samples":"1","high":true}),
            )
            .unwrap();
        assert_eq!(p.evidence.len(), 1);
        assert_eq!(p.value["items"][0]["width_samples"], "2");
        let p = r
            .get("sigpilot.range_measure")
            .unwrap()
            .run(
                ProviderContext {
                    window: &w,
                    related_windows: &[],
                    original_range: range,
                    cancelled: &cancel,
                },
                json!({}),
            )
            .unwrap();
        assert_eq!(p.value["high_samples"], "6");
    }
}
