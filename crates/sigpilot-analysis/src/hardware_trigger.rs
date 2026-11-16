//! Offline, driver-bound trigger compilation. Profiles come from trusted Rust
//! registration, never a capability claim supplied by an MCP caller.
use crate::{
    trigger::{self, Event, Issue, Phase, TriggerRule, Validation},
    AnalysisError, EdgeDirection, ExactU64, Result,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sigpilot_core::{
    capture_profile_from_settings, gpio_timing_for_samplerate,
    pxview_profile::{PxlogicDeviceProfile, PXLOGIC_DEVICE_PROFILES},
    resolve_enabled_channels, resolve_pxlogic_capture_plan, CaptureMode, CaptureSettings,
    CaptureTriggerKind,
};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
const MAX_INPUT: usize = 16 * 1024;
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TargetMode {
    Buffer,
    Stream,
}
impl From<TargetMode> for CaptureMode {
    fn from(value: TargetMode) -> Self {
        match value {
            TargetMode::Buffer => Self::Buffer,
            TargetMode::Stream => Self::Stream,
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct HardwareTriggerTarget {
    pub profile_id: String,
    pub mode: TargetMode,
    pub channel_count: u8,
    #[serde(default)]
    pub enabled_channels: Vec<u8>,
    pub sample_rate_hz: ExactU64,
}
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CompilationStatus {
    Supported,
    Unsupported,
    Unverified,
    InvalidModel,
    ProvenUnsatisfiable,
}
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TriggerKind {
    Rising,
    Falling,
    High,
    Low,
}
#[derive(Debug, Clone, Serialize)]
pub struct TriggerSettingsPatch {
    pub trigger_enabled: bool,
    pub trigger_channel: u8,
    pub trigger_kind: TriggerKind,
    pub trigger_high_mask: ExactU64,
    pub trigger_low_mask: ExactU64,
}
#[derive(Debug, Clone, Serialize)]
pub struct TriggerRegister {
    pub symbol: String,
    pub address: ExactU64,
    pub value: ExactU64,
}
#[derive(Debug, Clone, Serialize)]
pub struct TriggerArtifact {
    pub schema_version: String,
    pub profile_version: String,
    pub driver_id: String,
    pub target: HardwareTriggerTarget,
    pub rule: TriggerRule,
    pub selected_channel_mode: String,
    pub settings_patch: TriggerSettingsPatch,
    pub trigger_registers: Vec<TriggerRegister>,
    pub clock_mode: ExactU64,
    pub clock_divider: ExactU64,
    pub normalizations: Vec<Issue>,
    pub unresolved_semantics: Vec<Issue>,
}
#[derive(Debug, Clone, Serialize)]
pub struct TriggerCompilation {
    pub status: CompilationStatus,
    pub validation: Validation,
    pub issues: Vec<Issue>,
    pub target: HardwareTriggerTarget,
    pub artifact: Option<TriggerArtifact>,
    pub candidate_encoding: Option<TriggerArtifact>,
    pub execution_target: String,
    pub hardware_verified: bool,
    pub applied: bool,
}
impl TriggerCompilation {
    fn base(target: HardwareTriggerTarget, validation: Validation) -> Self {
        let status = if !validation.valid {
            CompilationStatus::InvalidModel
        } else if validation.satisfiability == "proven_unsatisfiable" {
            CompilationStatus::ProvenUnsatisfiable
        } else {
            CompilationStatus::Unsupported
        };
        Self {
            status,
            validation,
            issues: vec![],
            target,
            artifact: None,
            candidate_encoding: None,
            execution_target: "offline_compilation".into(),
            hardware_verified: false,
            applied: false,
        }
    }
}
pub trait HardwareTriggerCompiler: Send + Sync {
    /// Stable descriptor <=16 KiB. Registration/call output is bounded; host
    /// code still must obey the cooperative cancellation/execution contract.
    fn descriptor(&self) -> Value;
    fn compile(
        &self,
        target: &HardwareTriggerTarget,
        rule: &TriggerRule,
        cancel: &AtomicBool,
    ) -> Result<TriggerCompilation>;
}
pub struct HardwareTriggerRegistry {
    entries: BTreeMap<String, Arc<dyn HardwareTriggerCompiler>>,
}
impl Default for HardwareTriggerRegistry {
    fn default() -> Self {
        let mut registry = Self {
            entries: BTreeMap::new(),
        };
        for profile in PXLOGIC_DEVICE_PROFILES {
            registry
                .register(Arc::new(PxlogicCompiler {
                    profile,
                    guard_phase: None,
                }))
                .expect("bounded builtin profile");
        }
        for (id, driver, model, source) in [
            (
                "kingst-la2016-no-trigger-v1",
                "kingst-la2016",
                "Kingst current capture path",
                "crates/sigpilot-core/src/kingst_la2016.rs",
            ),
            (
                "fake-no-trigger-v1",
                "fake",
                "SigPilot Demo Source",
                "crates/sigpilot-core/src/fake.rs",
            ),
        ] {
            registry
                .register(Arc::new(NoTriggerCompiler {
                    id: id.into(),
                    driver: driver.into(),
                    model: model.into(),
                    source: source.into(),
                }))
                .unwrap();
        }
        registry
    }
}
impl HardwareTriggerRegistry {
    pub fn register(&mut self, compiler: Arc<dyn HardwareTriggerCompiler>) -> Result<()> {
        let descriptor = compiler.descriptor();
        let id = descriptor["profile_id"]
            .as_str()
            .ok_or_else(|| invalid("profile_id required"))?
            .to_string();
        if id.is_empty()
            || id.len() > 128
            || !id
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
            || self.entries.contains_key(&id)
            || self.entries.len() == 64
            || serde_json::to_vec(&descriptor).map_or(true, |v| v.len() > 16 * 1024)
        {
            return Err(invalid("duplicate/invalid profile or registry budget"));
        }
        let mut catalog = self.catalog();
        catalog.push(descriptor);
        if serde_json::to_vec(&catalog).map_or(true, |v| v.len() > 64 * 1024) {
            return Err(invalid("trigger profile catalog exceeds 64 KiB"));
        }
        self.entries.insert(id, compiler);
        Ok(())
    }
    pub fn catalog(&self) -> Vec<Value> {
        self.entries.values().map(|c| c.descriptor()).collect()
    }
    pub fn get(&self, id: &str) -> Option<Arc<dyn HardwareTriggerCompiler>> {
        self.entries.get(id).cloned()
    }
}
fn invalid(message: &str) -> AnalysisError {
    AnalysisError::InvalidInput(message.into())
}
fn issue(path: impl Into<String>, code: &str, message: &str) -> Issue {
    Issue {
        path: path.into(),
        code: code.into(),
        message: message.into(),
    }
}
pub fn compile_checked(
    compiler: &dyn HardwareTriggerCompiler,
    target: &HardwareTriggerTarget,
    rule: &TriggerRule,
    cancel: &AtomicBool,
) -> Result<TriggerCompilation> {
    if serde_json::to_vec(&(target, rule)).map_or(true, |v| v.len() > MAX_INPUT)
        || target.enabled_channels.len() > 32
    {
        return Err(invalid(
            "trigger compile input exceeds 16 KiB / 32 enabled channels",
        ));
    }
    let descriptor = compiler.descriptor();
    if descriptor["profile_id"] != target.profile_id {
        return Err(invalid("profile identity mismatch"));
    }
    if cancel.load(Ordering::Acquire) {
        return Err(AnalysisError::Cancelled);
    }
    let result = compiler.compile(target, rule, cancel)?;
    let same_target = |other: &HardwareTriggerTarget| {
        let mut expected = target.enabled_channels.clone();
        if expected.is_empty() {
            expected = (0..target.channel_count).collect();
        }
        expected.sort_unstable();
        other.profile_id == target.profile_id
            && other.mode == target.mode
            && other.channel_count == target.channel_count
            && other.sample_rate_hz == target.sample_rate_hz
            && other.enabled_channels == expected
    };
    if result.applied
        || result.hardware_verified
        || result.execution_target != "offline_compilation"
        || !same_target(&result.target)
        || (result.status == CompilationStatus::Supported) != (result.artifact.is_some())
        || (result.candidate_encoding.is_some() && result.status != CompilationStatus::Unverified)
        || serde_json::to_vec(&result).map_or(true, |v| v.len() > 64 * 1024)
    {
        return Err(invalid(
            "compiler violated offline result/target budget contract",
        ));
    }
    for artifact in result
        .artifact
        .iter()
        .chain(result.candidate_encoding.iter())
    {
        if artifact.schema_version != "1"
            || descriptor["version"] != artifact.profile_version
            || descriptor["driver_id"] != artifact.driver_id
            || !same_target(&artifact.target)
            || serde_json::to_value(&artifact.rule).ok() != serde_json::to_value(rule).ok()
            || (result.status == CompilationStatus::Supported
                && !artifact.unresolved_semantics.is_empty())
        {
            return Err(invalid(
                "compiler changed the rule/target or hid unresolved semantics",
            ));
        }
    }
    if cancel.load(Ordering::Acquire) {
        return Err(AnalysisError::Cancelled);
    }
    Ok(result)
}
fn target_validation(
    target: &HardwareTriggerTarget,
    rule: &TriggerRule,
) -> Result<TriggerCompilation> {
    let enabled = resolve_enabled_channels(target.channel_count, &target.enabled_channels)
        .map_err(|e| invalid(&e.to_string()))?;
    let mut normalized = target.clone();
    normalized.enabled_channels = enabled.clone();
    let validation = trigger::validate(rule, &enabled);
    let mut result = TriggerCompilation::base(normalized, validation);
    if target.sample_rate_hz.0 == 0 {
        result.status = CompilationStatus::InvalidModel;
        result.issues.push(issue(
            "target.sample_rate_hz",
            "INVALID_MODEL",
            "positive sample rate required",
        ));
    }
    Ok(result)
}
pub struct PxlogicCompiler {
    pub profile: &'static PxlogicDeviceProfile,
    pub guard_phase: Option<Phase>,
}
impl PxlogicCompiler {
    pub fn profile_id(&self) -> String {
        format!(
            "pxlogic-{:04x}-{:04x}-{}-{}",
            self.profile.vid,
            self.profile.pid,
            self.profile.usb_speed.label(),
            self.profile.logic_mode
        )
    }
}
impl HardwareTriggerCompiler for PxlogicCompiler {
    fn descriptor(&self) -> Value {
        json!({"profile_id":self.profile_id(),"version":"1","driver_id":"pxlogic","model":self.profile.model,"offline_profile":true,
            "usb_identity":{"vid":ExactU64(self.profile.vid as u64),"pid":ExactU64(self.profile.pid as u64),"usb_speed":self.profile.usb_speed.label(),"logic_mode":ExactU64(self.profile.logic_mode as u64)},
            "encoding":"pxlogic_simple_masks_v1","event_types":["edge","level"],"max_stages":1,"pulse_width_comparator":false,"holdoff":false,
            "additional_level_guard_phase":self.guard_phase,"guard_phase_verification":if self.guard_phase.is_some(){"trusted_host_contract"}else{"unverified"},
            "hardware_verified":false,"sampling_quantization":"exact_supported_rates_only","trigger_timing_quantization":"unverified",
            "external_trigger_modes":["close","rising","high","falling","low","either_edge"],"external_internal_combination_semantics":"unverified_not_compiled",
            "source_paths":["crates/sigpilot-core/src/capture.rs","crates/sigpilot-core/src/protocol.rs","crates/sigpilot-core/src/pxview_profile.rs"],
            "channel_modes":self.profile.supported_channel_modes().map(|m|json!({"id":m.id.pxview_name(),"mode":if m.stream {TargetMode::Stream}else{TargetMode::Buffer},"max_channels":m.channels,
                "min_sample_rate_hz":ExactU64(m.min_samplerate_hz),"max_sample_rate_hz":ExactU64(m.max_samplerate_hz),
                "sample_rates_hz":sigpilot_core::supported_samplerates().iter().copied().filter(|r|*r>=m.min_samplerate_hz && *r<=m.max_samplerate_hz).map(ExactU64).collect::<Vec<_>>() })).collect::<Vec<_>>()})
    }
    fn compile(
        &self,
        target: &HardwareTriggerTarget,
        rule: &TriggerRule,
        cancel: &AtomicBool,
    ) -> Result<TriggerCompilation> {
        let mut result = target_validation(target, rule)?;
        if matches!(
            result.status,
            CompilationStatus::InvalidModel | CompilationStatus::ProvenUnsatisfiable
        ) {
            return Ok(result);
        }
        let plan = resolve_pxlogic_capture_plan(
            self.profile,
            target.mode.into(),
            target.channel_count,
            target.sample_rate_hz.0,
        )
        .map_err(|e| invalid(&e.to_string()))?;
        if plan.channel_count != target.channel_count {
            result.issues.push(issue(
                "target.channel_count",
                "CHANNEL_COUNT_WOULD_BE_CLAMPED",
                "requested channel count exceeds this profile/mode",
            ));
        }
        if plan.sample_rate_hz != target.sample_rate_hz.0 {
            result.issues.push(issue(
                "target.sample_rate_hz",
                "SAMPLERATE_WOULD_BE_CLAMPED",
                "requested rate exceeds this profile/mode; no implicit clamp is applied",
            ));
        }
        let clock = gpio_timing_for_samplerate(target.sample_rate_hz.0);
        if clock.is_err() {
            result.issues.push(issue(
                "target.sample_rate_hz",
                "SAMPLERATE_UNSUPPORTED",
                "rate is not in the driver's exact clock table",
            ));
        }
        if rule.steps.len() != 1 {
            result.issues.push(issue(
                "steps",
                "STAGE_COUNT_UNSUPPORTED",
                "simple trigger masks cannot encode temporal sequences",
            ));
        }
        if rule.holdoff_samples.0 > 0 {
            result.issues.push(issue(
                "holdoff_samples",
                "HOLDOFF_UNSUPPORTED",
                "driver has no holdoff field",
            ));
        }
        for (i, step) in rule.steps.iter().enumerate() {
            if matches!(step.event, Event::PulseWidth { .. }) {
                result.issues.push(issue(
                    format!("steps[{i}].event"),
                    "PULSE_WIDTH_COMPARATOR_UNSUPPORTED",
                    "high/low masks are level tests, not pulse-width comparators",
                ));
            }
        }
        if !result.issues.is_empty() {
            return Ok(result);
        }
        let step = &rule.steps[0];
        let channel = step.event.channel();
        let mut normalizations = vec![];
        let mut unresolved = vec![];
        let mut kind = match step.event {
            Event::Edge { direction, .. } => {
                if direction == EdgeDirection::Rising {
                    TriggerKind::Rising
                } else {
                    TriggerKind::Falling
                }
            }
            Event::Level { high, .. } => {
                if high {
                    TriggerKind::High
                } else {
                    TriggerKind::Low
                }
            }
            _ => unreachable!(),
        };
        let mut high_mask = 0u32;
        let mut low_mask = 0u32;
        let mut levels: BTreeMap<u8, BTreeSet<bool>> = BTreeMap::new();
        for (i, guard) in step.guards.iter().enumerate() {
            if cancel.load(Ordering::Acquire) {
                return Err(AnalysisError::Cancelled);
            }
            let path = format!("steps[0].guards[{i}]");
            if guard.channel == channel {
                match step.event {
                    Event::Edge{..}=>normalizations.push(issue(path,"ENTAILED_GUARD_REMOVED","guard is implied by the selected edge and phase")),
                    Event::Level{..} if guard.phase==Phase::After=>normalizations.push(issue(path,"ENTAILED_GUARD_REMOVED","after-phase primary level is implied by the level event")),
                    Event::Level{high,..} if guard.high!=high=>{kind=if high {TriggerKind::Rising}else{TriggerKind::Falling};normalizations.push(issue(path,"LEVEL_TRANSITION_REDUCED_TO_EDGE","primary before/after levels require the corresponding edge"));},
                    Event::Level{..}=>result.issues.push(issue(path,"PREVIOUS_SAMPLE_LEVEL_UNSUPPORTED","a stable primary before-level cannot be encoded by an immediate level mask")),_=>unreachable!(),
                }
                continue;
            }
            levels.entry(guard.channel).or_default().insert(guard.high);
            match self.guard_phase {
                Some(phase) if phase != guard.phase => result.issues.push(issue(
                    path,
                    "GUARD_PHASE_UNSUPPORTED",
                    "profile evaluates additional levels at a different phase",
                )),
                None => unresolved.push(issue(
                    path,
                    "GUARD_PHASE_UNVERIFIED",
                    "register mapping is known; FPGA guard sampling phase requires verification",
                )),
                _ => {}
            }
            if guard.high {
                high_mask |= 1u32 << guard.channel;
            } else {
                low_mask |= 1u32 << guard.channel;
            }
        }
        if levels.values().any(|values| values.len() > 1) {
            result.issues.push(issue("steps[0].guards","GUARD_PHASE_ENCODING_CONFLICT","valid before/after transitions cannot be flattened into contradictory same-sample masks"));
        }
        if !result.issues.is_empty() {
            return Ok(result);
        }
        let settings = CaptureSettings {
            channel_count: target.channel_count,
            enabled_channels: result.target.enabled_channels.clone(),
            sample_rate_hz: target.sample_rate_hz.0,
            mode: target.mode.into(),
            trigger_enabled: true,
            trigger_channel: channel,
            trigger_kind: match kind {
                TriggerKind::Rising => CaptureTriggerKind::Rising,
                TriggerKind::Falling => CaptureTriggerKind::Falling,
                TriggerKind::High => CaptureTriggerKind::High,
                TriggerKind::Low => CaptureTriggerKind::Low,
            },
            trigger_high_mask: high_mask,
            trigger_low_mask: low_mask,
            ..Default::default()
        };
        let profile = capture_profile_from_settings(&settings, target.channel_count)
            .map_err(|e| invalid(&e.to_string()))?;
        let clock = clock.unwrap();
        let artifact = TriggerArtifact {
            schema_version: "1".into(),
            profile_version: "1".into(),
            driver_id: "pxlogic".into(),
            target: result.target.clone(),
            rule: rule.clone(),
            selected_channel_mode: plan.channel_mode.id.pxview_name().into(),
            settings_patch: TriggerSettingsPatch {
                trigger_enabled: true,
                trigger_channel: channel,
                trigger_kind: kind,
                trigger_high_mask: (high_mask as u64).into(),
                trigger_low_mask: (low_mask as u64).into(),
            },
            trigger_registers: [
                (
                    "REG_TRIGGER_ZERO",
                    sigpilot_core::protocol::REG_TRIGGER_ZERO,
                    profile.trigger_zero,
                ),
                (
                    "REG_TRIGGER_ONE",
                    sigpilot_core::protocol::REG_TRIGGER_ONE,
                    profile.trigger_one,
                ),
                (
                    "REG_TRIGGER_RISE",
                    sigpilot_core::protocol::REG_TRIGGER_RISE,
                    profile.trigger_rise,
                ),
                (
                    "REG_TRIGGER_FALL",
                    sigpilot_core::protocol::REG_TRIGGER_FALL,
                    profile.trigger_fall,
                ),
            ]
            .into_iter()
            .map(|(symbol, address, value)| TriggerRegister {
                symbol: symbol.into(),
                address: (address as u64).into(),
                value: (value as u64).into(),
            })
            .collect(),
            clock_mode: (clock.mode as u64).into(),
            clock_divider: (clock.div as u64).into(),
            normalizations,
            unresolved_semantics: unresolved,
        };
        if artifact.unresolved_semantics.is_empty() {
            result.status = CompilationStatus::Supported;
            result.artifact = Some(artifact);
        } else {
            result.status = CompilationStatus::Unverified;
            result.issues = artifact.unresolved_semantics.clone();
            result.candidate_encoding = Some(artifact);
        }
        Ok(result)
    }
}
struct NoTriggerCompiler {
    id: String,
    driver: String,
    model: String,
    source: String,
}
impl HardwareTriggerCompiler for NoTriggerCompiler {
    fn descriptor(&self) -> Value {
        json!({"profile_id":self.id,"version":"1","driver_id":self.driver,"model":self.model,"offline_profile":true,"encoding":"unsupported_current_driver",
        "event_types":[],"max_stages":0,"hardware_verified":false,"source_paths":[self.source],"channel_modes":[]})
    }
    fn compile(
        &self,
        target: &HardwareTriggerTarget,
        rule: &TriggerRule,
        _: &AtomicBool,
    ) -> Result<TriggerCompilation> {
        let mut result = target_validation(target, rule)?;
        if result.status == CompilationStatus::Unsupported {
            result.issues.push(issue(
                "target.profile_id",
                "TRIGGER_UNSUPPORTED_BY_DRIVER",
                "current capture implementation does not apply trigger conditions",
            ));
        }
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::trigger::{Guard, PulseAnchor, Step, Within};
    fn compiler(phase: Option<Phase>) -> PxlogicCompiler {
        PxlogicCompiler {
            profile: &PXLOGIC_DEVICE_PROFILES[0],
            guard_phase: phase,
        }
    }
    fn target(c: &PxlogicCompiler) -> HardwareTriggerTarget {
        HardwareTriggerTarget {
            profile_id: c.profile_id(),
            mode: TargetMode::Stream,
            channel_count: 32,
            enabled_channels: vec![2, 0, 1],
            sample_rate_hz: 1_000_000.into(),
        }
    }
    fn edge() -> TriggerRule {
        TriggerRule {
            schema_version: "1".into(),
            holdoff_samples: 0.into(),
            steps: vec![Step {
                event: Event::Edge {
                    channel: 0,
                    direction: EdgeDirection::Rising,
                },
                guards: vec![],
                within: None,
            }],
        }
    }
    fn run(c: &PxlogicCompiler, t: &HardwareTriggerTarget, r: &TriggerRule) -> TriggerCompilation {
        compile_checked(c, t, r, &AtomicBool::new(false)).unwrap()
    }
    fn register_value(a: &TriggerArtifact, symbol: &str) -> u64 {
        a.trigger_registers
            .iter()
            .find(|r| r.symbol == symbol)
            .unwrap()
            .value
            .0
    }
    #[test]
    fn catalog_is_offline_unique_and_does_not_invent_trigger_support_for_other_drivers() {
        let mut registry = HardwareTriggerRegistry::default();
        let catalog = registry.catalog();
        assert_eq!(catalog.len(), 12);
        assert!(catalog
            .iter()
            .all(|d| d["hardware_verified"] == false && d["offline_profile"] == true));
        assert!(registry.register(Arc::new(compiler(None))).is_err());
        for id in ["kingst-la2016-no-trigger-v1", "fake-no-trigger-v1"] {
            let c = registry.get(id).unwrap();
            let mut t = target(&compiler(None));
            t.profile_id = id.into();
            let result = compile_checked(c.as_ref(), &t, &edge(), &AtomicBool::new(false)).unwrap();
            assert_eq!(result.status, CompilationStatus::Unsupported);
            assert!(result.artifact.is_none());
            assert!(result.candidate_encoding.is_none());
        }
        assert!(registry.get("invented-profile").is_none());
    }
    #[test]
    fn edge_entails_its_primary_guards_and_driver_mapping_uses_exact_masks() {
        let c = compiler(None);
        let mut rule = edge();
        rule.steps[0].guards = vec![
            Guard {
                channel: 0,
                high: false,
                phase: Phase::Before,
            },
            Guard {
                channel: 0,
                high: true,
                phase: Phase::After,
            },
        ];
        let result = run(&c, &target(&c), &rule);
        assert_eq!(result.status, CompilationStatus::Supported);
        assert!(!result.applied && !result.hardware_verified);
        let artifact = result.artifact.unwrap();
        assert_eq!(artifact.target.enabled_channels, vec![0, 1, 2]);
        assert_eq!(artifact.normalizations.len(), 2);
        assert_eq!(register_value(&artifact, "REG_TRIGGER_RISE"), 1);
        assert_eq!(register_value(&artifact, "REG_TRIGGER_ONE"), 0);
        assert_eq!(artifact.clock_mode.0, 7);
        assert_eq!(artifact.clock_divider.0, 99);
        assert_eq!(
            serde_json::to_value(&artifact).unwrap()["trigger_registers"][0]["value"],
            "0"
        );
    }
    #[test]
    fn additional_guard_phase_requires_a_declared_contract_and_never_becomes_a_ready_artifact() {
        let c = compiler(None);
        let mut rule = edge();
        rule.steps[0].guards.push(Guard {
            channel: 1,
            high: false,
            phase: Phase::After,
        });
        let result = run(&c, &target(&c), &rule);
        assert_eq!(result.status, CompilationStatus::Unverified);
        assert!(result.artifact.is_none());
        let candidate = result.candidate_encoding.unwrap();
        assert_eq!(register_value(&candidate, "REG_TRIGGER_ZERO"), 2);
        assert_eq!(candidate.unresolved_semantics.len(), 1);
        let c = compiler(Some(Phase::After));
        let result = run(&c, &target(&c), &rule);
        assert_eq!(result.status, CompilationStatus::Supported);
        assert_eq!(
            register_value(result.artifact.as_ref().unwrap(), "REG_TRIGGER_ZERO"),
            2
        );
        rule.steps[0].guards[0].phase = Phase::Before;
        assert_eq!(
            run(&c, &target(&c), &rule).status,
            CompilationStatus::Unsupported
        );
    }
    #[test]
    fn primary_before_level_can_require_an_edge_or_an_unsupported_stability_test() {
        let c = compiler(None);
        let mut rule = edge();
        rule.steps[0].event = Event::Level {
            channel: 0,
            high: true,
        };
        assert_eq!(
            register_value(
                run(&c, &target(&c), &rule).artifact.as_ref().unwrap(),
                "REG_TRIGGER_ONE"
            ),
            1
        );
        rule.steps[0].guards.push(Guard {
            channel: 0,
            high: false,
            phase: Phase::Before,
        });
        let result = run(&c, &target(&c), &rule);
        assert_eq!(result.status, CompilationStatus::Supported);
        assert_eq!(
            result.artifact.unwrap().settings_patch.trigger_kind,
            TriggerKind::Rising
        );
        rule.steps[0].guards[0].high = true;
        let result = run(&c, &target(&c), &rule);
        assert_eq!(result.validation.satisfiability, "satisfiable_in_model");
        assert_eq!(result.status, CompilationStatus::Unsupported);
        assert_eq!(result.issues[0].code, "PREVIOUS_SAMPLE_LEVEL_UNSUPPORTED");
    }
    #[test]
    fn temporal_pulse_conditions_and_clamping_are_rejected_without_weakening_the_rule() {
        let c = compiler(None);
        let mut t = target(&c);
        let mut rule = edge();
        rule.steps.push(Step {
            event: Event::Level {
                channel: 1,
                high: true,
            },
            guards: vec![],
            within: Some(Within {
                min_samples: 1.into(),
                max_samples: 20.into(),
            }),
        });
        let result = run(&c, &t, &rule);
        assert_eq!(result.status, CompilationStatus::Unsupported);
        assert!(result.artifact.is_none());
        rule = edge();
        rule.steps[0].event = Event::PulseWidth {
            channel: 0,
            high: true,
            min_width_samples: 1.into(),
            max_width_exclusive: 3.into(),
            anchor: PulseAnchor::PulseEnd,
        };
        let result = run(&c, &t, &rule);
        assert_eq!(result.issues[0].code, "PULSE_WIDTH_COMPARATOR_UNSUPPORTED");
        assert!(result.candidate_encoding.is_none());
        rule = edge();
        rule.holdoff_samples = 1.into();
        assert_eq!(run(&c, &t, &rule).issues[0].code, "HOLDOFF_UNSUPPORTED");
        rule = edge();
        t.sample_rate_hz = 100_000_000.into();
        let result = run(&c, &t, &rule);
        assert_eq!(result.issues[0].code, "SAMPLERATE_WOULD_BE_CLAMPED");
        assert_eq!(result.target.sample_rate_hz, t.sample_rate_hz);
        t.sample_rate_hz = 12345.into();
        assert_eq!(run(&c, &t, &rule).issues[0].code, "SAMPLERATE_UNSUPPORTED");
    }
    #[test]
    fn valid_cross_phase_transition_is_not_misreported_as_a_logical_conflict() {
        let c = compiler(None);
        let mut rule = edge();
        rule.steps[0].guards = vec![
            Guard {
                channel: 1,
                high: true,
                phase: Phase::Before,
            },
            Guard {
                channel: 1,
                high: false,
                phase: Phase::After,
            },
        ];
        let result = run(&c, &target(&c), &rule);
        assert_eq!(result.validation.satisfiability, "satisfiable_in_model");
        assert_eq!(result.status, CompilationStatus::Unsupported);
        assert_eq!(result.issues[0].code, "GUARD_PHASE_ENCODING_CONFLICT");
        rule.steps[0].guards.push(Guard {
            channel: 0,
            high: false,
            phase: Phase::After,
        });
        let result = run(&c, &target(&c), &rule);
        assert_eq!(result.status, CompilationStatus::ProvenUnsatisfiable);
        assert!(result.artifact.is_none());
    }
    #[test]
    fn compiler_cancellation_input_and_offline_contract_are_enforced() {
        let c = compiler(None);
        let t = target(&c);
        let mut rule = edge();
        assert!(matches!(
            compile_checked(&c, &t, &rule, &AtomicBool::new(true)),
            Err(AnalysisError::Cancelled)
        ));
        rule.steps[0].guards = vec![
            Guard {
                channel: 0,
                high: false,
                phase: Phase::Before
            };
            500
        ];
        assert!(compile_checked(&c, &t, &rule, &AtomicBool::new(false)).is_err());
        struct Applied(PxlogicCompiler);
        impl HardwareTriggerCompiler for Applied {
            fn descriptor(&self) -> Value {
                self.0.descriptor()
            }
            fn compile(
                &self,
                t: &HardwareTriggerTarget,
                r: &TriggerRule,
                c: &AtomicBool,
            ) -> Result<TriggerCompilation> {
                let mut result = self.0.compile(t, r, c)?;
                result.applied = true;
                Ok(result)
            }
        }
        assert!(compile_checked(
            &Applied(compiler(None)),
            &t,
            &edge(),
            &AtomicBool::new(false)
        )
        .is_err());
    }
}
