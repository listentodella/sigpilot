//! Bounded acquisition jobs shared by authenticated MCP adapters.
//!
//! A submitted job outlives its HTTP request. Only its owning authorization
//! grant can stop/release it; controller cancellation is always session-scoped.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sigpilot_analysis::ExactU64;
use sigpilot_core::{
    protocol_trigger::{validate_request as validate_protocol_trigger, ProtocolTriggerConfig},
    AnalyzerDecodeSettings, CaptureMode, CaptureSettings, DeviceInfo, HardwareCaptureCapabilities,
};
use sigpilot_workbench::WorkbenchService;
use std::{
    collections::{BTreeMap, HashSet},
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

pub type CaptureFuture = Pin<Box<dyn Future<Output = std::result::Result<Value, String>> + Send>>;
pub trait CaptureController: Send + Sync {
    fn devices(&self) -> std::result::Result<Vec<DeviceInfo>, String>;
    fn capabilities(&self, id: &str) -> std::result::Result<HardwareCaptureCapabilities, String>;
    fn start(
        &self,
        session_id: String,
        settings: CaptureSettings,
        analyzers: Vec<AnalyzerDecodeSettings>,
        protocol_trigger: Option<ProtocolTriggerConfig>,
    ) -> CaptureFuture;
    fn cancel(&self, session_id: &str) -> std::result::Result<(), String>;
    fn released(&self, _session_id: &str) {}
}

const MAX_JOBS: usize = 32;
const MAX_CAPTURES: usize = 8;
const RETENTION: Duration = Duration::from_secs(15 * 60);
fn default_threshold() -> f64 {
    1.8
}
fn default_timeout() -> u64 {
    60_000
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AcquisitionMode {
    Buffer,
    Stream,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StartCaptureRequest {
    pub request_id: String,
    pub device_id: String,
    pub sample_rate_hz: ExactU64,
    pub enabled_channels: Vec<u8>,
    pub mode: AcquisitionMode,
    pub duration_ms: u64,
    pub buffer_size_mb: u64,
    #[serde(default = "default_threshold")]
    pub threshold_volts: f64,
    #[serde(default = "default_timeout")]
    pub timeout_ms: u64,
    #[serde(default)]
    pub analyzers: Vec<AnalyzerDecodeSettings>,
    #[serde(default)]
    pub protocol_trigger: Option<ProtocolTriggerConfig>,
    #[serde(default)]
    pub hardware_trigger: Option<HardwareTrigger>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HardwareTrigger {
    pub channel: u8,
    pub kind: sigpilot_core::CaptureTriggerKind,
    #[serde(default)]
    pub high_mask: u32,
    #[serde(default)]
    pub low_mask: u32,
    #[serde(default = "default_position")]
    pub position_percent: u8,
}
fn default_position() -> u8 {
    50
}
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CaptureState {
    Running,
    Completed,
    Cancelled,
    Failed,
    TimedOut,
}
#[derive(Debug, Clone, Serialize)]
pub struct CaptureStatus {
    pub job_id: String,
    pub session_id: String,
    pub device_id: String,
    pub state: CaptureState,
    pub cancel_requested: bool,
    pub released: bool,
    pub samples_read: ExactU64,
    pub summary: Option<Value>,
    pub context: Option<Value>,
    pub error: Option<String>,
}
struct Entry {
    owner: String,
    request_id: String,
    input: String,
    status: CaptureStatus,
    ended: Option<Instant>,
}
#[derive(Default)]
struct State {
    jobs: BTreeMap<String, Entry>,
    shutting_down: bool,
    revoked_owners: HashSet<String>,
}
pub struct CaptureService {
    workbench: Arc<WorkbenchService>,
    controller: Arc<dyn CaptureController>,
    runtime: tokio::runtime::Handle,
    state: Mutex<State>,
}
#[derive(Debug)]
pub struct CaptureError {
    pub code: &'static str,
    pub message: String,
}
impl CaptureError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}
type Result<T> = std::result::Result<T, CaptureError>;

impl CaptureService {
    pub fn new(
        workbench: Arc<WorkbenchService>,
        controller: Arc<dyn CaptureController>,
        runtime: tokio::runtime::Handle,
    ) -> Arc<Self> {
        Arc::new(Self {
            workbench,
            controller,
            runtime,
            state: Mutex::new(State::default()),
        })
    }
    pub fn capabilities(&self) -> Value {
        json!({"available":true,"max_capture_bytes":"67108864","max_timeout_ms":60000,"max_retained_captures":MAX_CAPTURES,"max_retained_jobs":MAX_JOBS,"request_replay_seconds":RETENTION.as_secs(),"one_running_capture":true,"modes":["buffer","stream"],"hardware_trigger":"pxlogic_only","protocol_trigger":true,"new_session_only":true})
    }
    pub fn devices(&self) -> Result<Value> {
        let devices = self
            .controller
            .devices()
            .map_err(|e| CaptureError::new("DEVICE_ERROR", e))?;
        if devices.len() > 64 {
            return Err(CaptureError::new(
                "RESOURCE_LIMIT",
                "More than 64 devices; narrow the host setup",
            ));
        }
        Ok(json!({"devices":devices}))
    }
    pub fn device_capabilities(&self, id: &str) -> Result<Value> {
        check_id(id)?;
        let caps = self
            .controller
            .capabilities(id)
            .map_err(|e| CaptureError::new("DEVICE_ERROR", e))?;
        let mut value = serde_json::to_value(caps)
            .map_err(|e| CaptureError::new("INVALID_INPUT", e.to_string()))?;
        exact_numbers(&mut value);
        Ok(json!({"device":value,"capture_limits":self.capabilities()}))
    }
    pub fn start(
        self: &Arc<Self>,
        owner: &str,
        request: StartCaptureRequest,
    ) -> Result<CaptureStatus> {
        check_id(owner)?;
        check_id(&request.request_id)?;
        check_id(&request.device_id)?;
        let input = serde_json::to_string(&request)
            .map_err(|e| CaptureError::new("INVALID_INPUT", e.to_string()))?;
        if input.len() > 16 * 1024 {
            return Err(CaptureError::new(
                "RESOURCE_LIMIT",
                "Capture request exceeds 16 KiB",
            ));
        }
        {
            let mut state = self.state.lock().unwrap();
            if let Some(entry) = state
                .jobs
                .values_mut()
                .find(|e| e.owner == owner && e.request_id == request.request_id)
            {
                if entry.input != input {
                    return Err(CaptureError::new(
                        "REQUEST_ID_CONFLICT",
                        "request_id was already used with different capture parameters",
                    ));
                }
                self.refresh_entry(entry);
                return Ok(entry.status.clone());
            }
        }
        let caps = self
            .controller
            .capabilities(&request.device_id)
            .map_err(|e| CaptureError::new("DEVICE_ERROR", e))?;
        let settings = validate(&request, &caps)?;
        let mut state = self.state.lock().unwrap();
        // Recheck after USB capability lookup; concurrent retries must not arm twice.
        if let Some(entry) = state
            .jobs
            .values_mut()
            .find(|e| e.owner == owner && e.request_id == request.request_id)
        {
            if entry.input != input {
                return Err(CaptureError::new(
                    "REQUEST_ID_CONFLICT",
                    "request_id was already used with different capture parameters",
                ));
            }
            self.refresh_entry(entry);
            return Ok(entry.status.clone());
        }
        if state.revoked_owners.contains(owner) {
            return Err(CaptureError::new(
                "ACCESS_DENIED",
                "This client's acquisition authorization was revoked",
            ));
        }
        if state.shutting_down {
            return Err(CaptureError::new(
                "SERVICE_STOPPING",
                "MCP acquisition service is stopping",
            ));
        }
        if state
            .jobs
            .values()
            .any(|e| e.status.state == CaptureState::Running)
        {
            return Err(CaptureError::new(
                "DEVICE_BUSY",
                "An MCP capture is already running",
            ));
        }
        // GUI may have closed a capture; acknowledge that without retaining a phantom budget.
        for entry in state.jobs.values_mut() {
            self.refresh_entry(entry);
        }
        state
            .jobs
            .retain(|_, e| !e.status.released || e.ended.is_none_or(|at| at.elapsed() < RETENTION));
        if state.jobs.len() >= MAX_JOBS {
            return Err(CaptureError::new(
                "RESOURCE_LIMIT",
                "Capture replay history is full; retry after its 15-minute retention window",
            ));
        }
        if state.jobs.values().filter(|e| !e.status.released).count() >= MAX_CAPTURES
            || self
                .workbench
                .session_ids()
                .iter()
                .filter(|id| id.starts_with("mcp-"))
                .count()
                >= MAX_CAPTURES
        {
            return Err(CaptureError::new(
                "RESOURCE_LIMIT",
                "Release an owned completed capture before recording more (8 retained captures)",
            ));
        }
        let status = CaptureStatus {
            job_id: format!("capture-{}", uuid::Uuid::new_v4().simple()),
            session_id: format!("mcp-{}", uuid::Uuid::new_v4().simple()),
            device_id: request.device_id.clone(),
            state: CaptureState::Running,
            cancel_requested: false,
            released: false,
            samples_read: ExactU64(0),
            summary: None,
            context: None,
            error: None,
        };
        self.workbench
            .session(&status.session_id)
            .map_err(|e| CaptureError::new("RESOURCE_LIMIT", e.to_string()))?;
        state.jobs.insert(
            status.job_id.clone(),
            Entry {
                owner: owner.into(),
                request_id: request.request_id.clone(),
                input,
                status: status.clone(),
                ended: None,
            },
        );
        drop(state);
        let service = self.clone();
        let task_id = status.job_id.clone();
        self.runtime.spawn(async move {
            service.run(task_id, settings, request).await;
        });
        Ok(status)
    }
    async fn run(
        self: Arc<Self>,
        id: String,
        settings: CaptureSettings,
        request: StartCaptureRequest,
    ) {
        let session = {
            let state = self.state.lock().unwrap();
            let e = &state.jobs[&id];
            e.status.session_id.clone()
        };
        {
            let mut state = self.state.lock().unwrap();
            let entry = state.jobs.get_mut(&id).unwrap();
            if entry.status.cancel_requested {
                entry.status.state = CaptureState::Cancelled;
                entry.ended = Some(Instant::now());
                return;
            }
        }
        // Start inside a supervised Tokio task so a controller panic becomes a
        // failed job rather than leaving its running slot occupied forever.
        let controller = self.controller.clone();
        let start_session = session.clone();
        let mut task = tokio::spawn(async move {
            controller
                .start(
                    start_session,
                    settings,
                    request.analyzers,
                    request.protocol_trigger,
                )
                .await
        });
        let timeout = Duration::from_millis(request.timeout_ms);
        let started = Instant::now();
        let mut timed_out = false;
        let result = loop {
            tokio::select! {
                result=&mut task=>break result.map_err(|e|format!("Capture controller failed: {e}")).and_then(|v|v),
                _=tokio::time::sleep(Duration::from_millis(20))=>{
                    let cancel={let mut state=self.state.lock().unwrap();let entry=state.jobs.get_mut(&id).unwrap();
                        if started.elapsed()>=timeout&&!entry.status.cancel_requested{timed_out=true;entry.status.cancel_requested=true;}
                        entry.status.cancel_requested};
                    // Retry until the driver actually owns this exact session.
                    // Never cancel a GUI/remote job that won the hardware lock.
                    if cancel{let _=self.controller.cancel(&session);}
                }
            }
        };
        let context = self
            .workbench
            .context(&session)
            .ok()
            .and_then(|v| serde_json::to_value(v).ok());
        let samples = self
            .workbench
            .existing_session(&session)
            .ok()
            .map_or(0, |s| s.graph.sample_count());
        let mut state = self.state.lock().unwrap();
        let entry = state.jobs.get_mut(&id).unwrap();
        entry.status.samples_read = ExactU64(samples);
        entry.status.context = context;
        entry.status.state = if timed_out {
            CaptureState::TimedOut
        } else if entry.status.cancel_requested {
            CaptureState::Cancelled
        } else if result.is_ok() {
            CaptureState::Completed
        } else {
            CaptureState::Failed
        };
        match result {
            Ok(mut summary) => {
                exact_numbers(&mut summary);
                entry.status.summary = Some(summary);
            }
            Err(error) => entry.status.error = Some(error),
        }
        if timed_out {
            entry.status.error=Some("Capture exceeded the requested timeout; stopping finished and available data was retained".into());
        }
        entry.ended = Some(Instant::now());
    }
    /// Refresh availability for replay as well as polling: GUI close can
    /// release a capture independently of this acquisition job record.
    fn refresh_entry(&self, entry: &mut Entry) {
        if let Ok(session) = self.workbench.existing_session(&entry.status.session_id) {
            entry.status.samples_read = ExactU64(session.graph.sample_count());
        } else if entry.status.state != CaptureState::Running {
            entry.status.released = true;
        }
        if entry.status.released {
            entry.status.context = None;
        }
    }
    pub fn status(&self, owner: &str, id: &str) -> Result<CaptureStatus> {
        let mut state = self.state.lock().unwrap();
        let entry = owned(&mut state, owner, id)?;
        self.refresh_entry(entry);
        Ok(entry.status.clone())
    }
    pub fn stop(&self, owner: &str, id: &str) -> Result<CaptureStatus> {
        let mut state = self.state.lock().unwrap();
        let entry = owned(&mut state, owner, id)?;
        if entry.status.state == CaptureState::Running {
            entry.status.cancel_requested = true;
        }
        self.refresh_entry(entry);
        Ok(entry.status.clone())
    }
    pub fn release(&self, owner: &str, id: &str) -> Result<CaptureStatus> {
        let mut state = self.state.lock().unwrap();
        let entry = owned(&mut state, owner, id)?;
        if entry.status.state == CaptureState::Running {
            return Err(CaptureError::new(
                "CAPTURE_RUNNING",
                "Stop the capture and poll until terminal before releasing it",
            ));
        }
        if !entry.status.released {
            self.workbench.release_session(&entry.status.session_id);
            self.controller.released(&entry.status.session_id);
            entry.status.released = true;
            entry.status.context = None;
        }
        Ok(entry.status.clone())
    }
    /// Called when desktop MCP is disabled/reconfigured. Do not drop capture
    /// futures: their workers must finish cancellation before the lock is reused.
    pub fn cancel_owner(&self, owner: &str) {
        let mut state = self.state.lock().unwrap();
        state.revoked_owners.insert(owner.into());
        for entry in state.jobs.values_mut().filter(|e| e.owner == owner) {
            if entry.status.state == CaptureState::Running {
                entry.status.cancel_requested = true;
            }
        }
    }
    pub fn cancel_all(&self) {
        let mut state = self.state.lock().unwrap();
        state.shutting_down = true;
        for entry in state.jobs.values_mut() {
            if entry.status.state == CaptureState::Running {
                entry.status.cancel_requested = true;
            }
        }
    }
}
fn owned<'a>(state: &'a mut State, owner: &str, id: &str) -> Result<&'a mut Entry> {
    state
        .jobs
        .get_mut(id)
        .filter(|e| e.owner == owner)
        .ok_or_else(|| {
            CaptureError::new(
                "CAPTURE_JOB_NOT_FOUND",
                "No owned acquisition job has that ID",
            )
        })
}
fn check_id(id: &str) -> Result<()> {
    if id.is_empty() || id.len() > 128 || id.chars().any(char::is_control) {
        Err(CaptureError::new(
            "INVALID_INPUT",
            "Identifiers must contain 1–128 non-control characters",
        ))
    } else {
        Ok(())
    }
}
fn validate(
    request: &StartCaptureRequest,
    caps: &HardwareCaptureCapabilities,
) -> Result<CaptureSettings> {
    let invalid = |message: &str| CaptureError::new("INVALID_INPUT", message);
    if !(1..=60_000).contains(&request.duration_ms)
        || !(1..=60_000).contains(&request.timeout_ms)
        || !(1..=64).contains(&request.buffer_size_mb)
    {
        return Err(invalid(
            "duration_ms and timeout_ms require 1–60000; buffer_size_mb requires 1–64",
        ));
    }
    if request.enabled_channels.is_empty()
        || request.enabled_channels.len() > 32
        || request
            .enabled_channels
            .iter()
            .enumerate()
            .any(|(i, c)| *c >= caps.max_channels || request.enabled_channels[..i].contains(c))
    {
        return Err(invalid(
            "Choose distinct enabled digital channels from the actual device capabilities",
        ));
    }
    let channels = request.enabled_channels.iter().copied().max().unwrap() + 1;
    let stream = request.mode == AcquisitionMode::Stream;
    if !caps.channel_modes.iter().any(|m| {
        m.stream == stream
            && m.channels >= channels
            && m.sample_rates.contains(&request.sample_rate_hz.0)
    }) {
        return Err(invalid(
            "Unsupported channel span, capture mode or sample rate; inspect device capabilities",
        ));
    }
    if !request.threshold_volts.is_finite()
        || !(0.0..=6.668).contains(&request.threshold_volts)
        || (!caps.threshold_volts.is_empty()
            && !caps
                .threshold_volts
                .iter()
                .any(|v| (*v - request.threshold_volts).abs() < 1e-6))
    {
        return Err(invalid(
            "Unsupported digital threshold; use a device threshold_volts value",
        ));
    }
    let mut settings = CaptureSettings {
        device_id: request.device_id.clone(),
        sample_rate_hz: request.sample_rate_hz.0,
        channel_count: channels,
        enabled_channels: request.enabled_channels.clone(),
        duration_ms: request.duration_ms,
        buffer_size_mb: request.buffer_size_mb,
        threshold_volts: request.threshold_volts,
        mode: if stream {
            CaptureMode::Stream
        } else {
            CaptureMode::Buffer
        },
        decode_cross: true,
        ..Default::default()
    };
    if let Some(trigger) = &request.hardware_trigger {
        if !request.device_id.starts_with("usb:")
            || caps.profile_vendor.as_deref() != Some("PX_Tool")
        {
            return Err(invalid(
                "Hardware triggering is available only for PXLogic devices",
            ));
        }
        if request.protocol_trigger.is_some() {
            return Err(invalid(
                "Choose hardware or software protocol triggering, not both",
            ));
        }
        if trigger.position_percent > 100 {
            return Err(invalid("Hardware trigger position_percent must be 0–100"));
        }
        settings.trigger_enabled = true;
        settings.trigger_channel = trigger.channel;
        settings.trigger_kind = trigger.kind;
        settings.trigger_high_mask = trigger.high_mask;
        settings.trigger_low_mask = trigger.low_mask;
        settings.trigger_position_percent = trigger.position_percent;
        sigpilot_core::capture_profile_from_settings(&settings, channels)
            .map_err(|e| invalid(&e.to_string()))?;
    }
    // Kingst returns all physical channels even for a narrow enabled subset;
    // use device width for the preflight to avoid underestimating buffer mode.
    let width = sigpilot_core::unitsize_for_channel_count(
        if request.device_id.starts_with("usb-kingst:") {
            caps.max_channels
        } else {
            channels
        },
    )
    .map_err(|e| invalid(&e.to_string()))?;
    let samples = sigpilot_core::sample_count_from_settings(&settings, width)
        .map_err(|e| invalid(&e.to_string()))?;
    if samples
        .checked_mul(u64::from(width))
        .is_none_or(|b| b > request.buffer_size_mb * 1024 * 1024)
    {
        return Err(invalid(
            "Requested sample rate × duration exceeds the configured capture buffer",
        ));
    }
    if request.analyzers.len() > 8 {
        return Err(invalid("At most 8 typed Demo analyzers are allowed"));
    }
    for decoder in &request.analyzers {
        validate_analyzer(decoder, &settings).map_err(|e| invalid(&e))?;
    }
    if let Some(trigger) = &request.protocol_trigger {
        validate_protocol_trigger(trigger, &settings).map_err(|e| invalid(&e))?;
        if trigger
            .max_wait_ms
            .saturating_add(trigger.post_trigger_ms)
            .saturating_add(5000)
            > request.timeout_ms
        {
            return Err(invalid("timeout_ms must cover protocol max_wait_ms + post_trigger_ms + 5000 ms delivery grace (at most 60000)"));
        }
    }
    Ok(settings)
}
fn validate_analyzer(
    decoder: &AnalyzerDecodeSettings,
    settings: &CaptureSettings,
) -> std::result::Result<(), String> {
    use sigpilot_core::protocol_trigger::{
        I2cTriggerEvent, ProtocolTriggerCondition, SpiTriggerLine,
    };
    let condition=match decoder{AnalyzerDecodeSettings::Uart(_)=>ProtocolTriggerCondition::UartSequence{bytes:vec![0]},AnalyzerDecodeSettings::I2c(_)=>ProtocolTriggerCondition::I2c{address:None,event:I2cTriggerEvent::Address,data:None},AnalyzerDecodeSettings::Spi(s)=>ProtocolTriggerCondition::SpiSequence{values:vec![0],line:if s.mosi_channel.is_some(){SpiTriggerLine::Mosi}else{SpiTriggerLine::Miso}},_=>return Err("Capture accepts only typed UART/I2C/SPI analyzers; Native/HLA execution is not allowed".into())};
    let mut stream = settings.clone();
    stream.mode = CaptureMode::Stream;
    stream.trigger_enabled = false;
    validate_protocol_trigger(
        &ProtocolTriggerConfig {
            analyzer_id: "capture-preflight".into(),
            decoder: decoder.clone(),
            condition,
            pre_trigger_ms: 0,
            post_trigger_ms: 0,
            max_wait_ms: 1,
        },
        &stream,
    )
}
fn exact_numbers(value: &mut Value) {
    match value {
        Value::Object(map) => {
            for (key, value) in map.iter_mut() {
                if matches!(
                    key.as_str(),
                    "sample_rate_hz"
                        | "default_sample_rate_hz"
                        | "min_sample_rate_hz"
                        | "max_sample_rate_hz"
                        | "default_sample_limit"
                        | "sample_count"
                        | "sample_index"
                        | "trigger_sample"
                        | "retained_start_sample"
                        | "bytes"
                ) {
                    if let Some(n) = value.as_u64() {
                        *value = Value::String(n.to_string());
                    }
                } else if key == "sample_rates" || key == "analog_sample_rates" {
                    if let Value::Array(values) = value {
                        for v in values {
                            if let Some(n) = v.as_u64() {
                                *v = Value::String(n.to_string());
                            }
                        }
                    }
                } else {
                    exact_numbers(value)
                }
            }
        }
        Value::Array(values) => {
            for value in values {
                exact_numbers(value)
            }
        }
        _ => {}
    }
}

pub(crate) fn is_capture_tool(name: &str) -> bool {
    matches!(
        name,
        "sigpilot_list_devices"
            | "sigpilot_get_device_capabilities"
            | "sigpilot_start_capture"
            | "sigpilot_get_capture_status"
            | "sigpilot_stop_capture"
            | "sigpilot_release_capture"
    )
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DeviceRequest {
    device_id: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct JobRequest {
    job_id: String,
}
pub(crate) fn execute(
    service: &Arc<CaptureService>,
    owner: &str,
    can_capture: bool,
    name: &str,
    arguments: Value,
) -> Result<Value> {
    fn parse<T: serde::de::DeserializeOwned>(v: Value) -> Result<T> {
        serde_json::from_value(v).map_err(|e| CaptureError::new("INVALID_INPUT", e.to_string()))
    }
    fn value(v: impl Serialize) -> Result<Value> {
        serde_json::to_value(v).map_err(|e| CaptureError::new("INTERNAL_ERROR", e.to_string()))
    }
    match name {
        "sigpilot_list_devices" => {
            let _: crate::EmptyRequest = parse(arguments)?;
            service.devices()
        }
        "sigpilot_get_device_capabilities" => {
            let r: DeviceRequest = parse(arguments)?;
            service.device_capabilities(&r.device_id)
        }
        "sigpilot_start_capture" if can_capture => value(service.start(owner, parse(arguments)?)?),
        "sigpilot_get_capture_status" => {
            let r: JobRequest = parse(arguments)?;
            value(service.status(owner, &r.job_id)?)
        }
        "sigpilot_stop_capture" => {
            let r: JobRequest = parse(arguments)?;
            value(service.stop(owner, &r.job_id)?)
        }
        "sigpilot_release_capture" => {
            let r: JobRequest = parse(arguments)?;
            value(service.release(owner, &r.job_id)?)
        }
        _ => Err(CaptureError::new(
            "ACCESS_DENIED",
            "The desktop has not enabled MCP acquisition",
        )),
    }
}
pub(crate) fn tool_catalog(can_capture: bool) -> Vec<rmcp::model::Tool> {
    let id = json!({"type":"string","minLength":1,"maxLength":128});
    let exact = json!({"type":"string","pattern":"^(0|[1-9][0-9]{0,19})$"});
    let channel = json!({"type":"integer","minimum":0,"maximum":31});
    let optional_channel = json!({"type":["integer","null"],"minimum":0,"maximum":31});
    let decoder = json!({"oneOf":[
        {"type":"object","additionalProperties":false,"required":["protocol","settings"],"properties":{"protocol":{"const":"Uart"},"settings":{"type":"object","additionalProperties":false,"required":["channel","baud_rate","inverted"],"properties":{"channel":channel,"baud_rate":{"type":"integer","minimum":1,"maximum":4294967295u64},"inverted":{"type":"boolean"},"data_bits":{"type":"integer","minimum":5,"maximum":8,"default":8},"stop_bits":{"type":"number","enum":[1,1.5,2],"default":1},"parity":{"type":"string","enum":["none","even","odd"],"default":"none"},"msb_first":{"type":"boolean","default":false}}}}},
        {"type":"object","additionalProperties":false,"required":["protocol","settings"],"properties":{"protocol":{"const":"I2c"},"settings":{"type":"object","additionalProperties":false,"required":["sda_channel","scl_channel"],"properties":{"sda_channel":channel,"scl_channel":channel}}}},
        {"type":"object","additionalProperties":false,"required":["protocol","settings"],"properties":{"protocol":{"const":"Spi"},"settings":{"type":"object","additionalProperties":false,"required":["clock_channel","enable_active_low","clock_polarity","clock_phase","bits_per_transfer","msb_first"],"properties":{"mosi_channel":optional_channel,"miso_channel":optional_channel,"clock_channel":channel,"enable_channel":optional_channel,"enable_active_low":{"type":"boolean"},"clock_polarity":{"type":"boolean"},"clock_phase":{"type":"boolean"},"bits_per_transfer":{"type":"integer","minimum":1,"maximum":64},"msb_first":{"type":"boolean"}}}}}
    ]});
    let trigger = json!({"type":"object","additionalProperties":false,"required":["analyzer_id","decoder","condition","pre_trigger_ms","post_trigger_ms","max_wait_ms"],"properties":{
        "analyzer_id":id,"decoder":decoder,"pre_trigger_ms":{"type":"integer","minimum":0,"maximum":60000},"post_trigger_ms":{"type":"integer","minimum":0,"maximum":60000},"max_wait_ms":{"type":"integer","minimum":1,"maximum":55000},
        "condition":{"oneOf":[
            {"type":"object","additionalProperties":false,"required":["type","bytes"],"properties":{"type":{"const":"uart_sequence"},"bytes":{"type":"array","minItems":1,"maxItems":64,"items":{"type":"integer","minimum":0,"maximum":255}}}},
            {"type":"object","additionalProperties":false,"required":["type","event"],"properties":{"type":{"const":"i2c"},"event":{"type":"string","enum":["address","data","nack"]},"address":{"type":["integer","null"],"minimum":0,"maximum":127},"data":{"type":["integer","null"],"minimum":0,"maximum":255}}},
            {"type":"object","additionalProperties":false,"required":["type","values","line"],"properties":{"type":{"const":"spi_sequence"},"line":{"type":"string","enum":["mosi","miso"]},"values":{"type":"array","minItems":1,"maxItems":64,"items":{"type":"integer","minimum":0,"maximum":9007199254740991u64}}}}
        ]}
    }});
    let mut tools=vec![
        crate::tool("sigpilot_list_devices","Enumerate currently attached USB devices and the real Demo source. Does not prepare firmware, start acquisition or change outputs. Device IDs must be used exactly as returned.",json!({}),&[],true,true),
        crate::tool("sigpilot_get_device_capabilities","Read actual device channel modes, supported sample rates, thresholds and MCP acquisition budgets. Sample rates and sample limits are exact decimal strings. May probe device descriptors but does not load firmware or start sampling.",json!({"device_id":id}),&["device_id"],true,true),
    ];
    if can_capture {
        tools.push(crate::tool("sigpilot_start_capture","Start a bounded digital acquisition in a NEW session, never overwrite an existing waveform. May prepare device firmware/FPGA before sampling. Inspect device capabilities first. sample_rate_hz is a decimal string; other bounded sizes are JSON integers. Buffer uses duration_ms; Stream runs until stopped, buffer full, protocol match or timeout_ms. At most 64 MiB, 60 seconds and 8 retained captures. Hardware edge/level triggers are PXLogic-only, with an explicit timeout; external triggers and outputs are not exposed. Optional typed analyzers configure Demo generation and GUI; protocol_trigger is the desktop software trigger, with timeout >= max_wait+post+5000 ms. Returns a job immediately; poll get_capture_status for finalized capture/context. Use same request_id and parameters to replay for15minutes; disconnect/cancel of this MCP request does NOT stop acquisition.",json!({"request_id":id,"device_id":id,"sample_rate_hz":exact,"enabled_channels":{"type":"array","minItems":1,"maxItems":32,"uniqueItems":true,"items":channel},"mode":{"type":"string","enum":["buffer","stream"]},"duration_ms":{"type":"integer","minimum":1,"maximum":60000},"buffer_size_mb":{"type":"integer","minimum":1,"maximum":64},"threshold_volts":{"type":"number","minimum":0,"maximum":6.668,"default":1.8},"timeout_ms":{"type":"integer","minimum":1,"maximum":60000,"default":60000},"analyzers":{"type":"array","maxItems":8,"items":decoder},"protocol_trigger":trigger,"hardware_trigger":{"type":"object","additionalProperties":false,"required":["channel","kind"],"properties":{"channel":channel,"kind":{"type":"string","enum":["Rising","Falling","High","Low"]},"high_mask":{"type":"integer","minimum":0,"maximum":4294967295u64,"default":0},"low_mask":{"type":"integer","minimum":0,"maximum":4294967295u64,"default":0},"position_percent":{"type":"integer","minimum":0,"maximum":100,"default":50}}}}),&["request_id","device_id","sample_rate_hz","enabled_channels","mode","duration_ms","buffer_size_mb"],false,true));
    }
    // Poll/stop/release remain available if permission was disabled after a job
    // was accepted. They cannot affect another caller's or GUI's acquisition.
    tools.extend([
        crate::tool("sigpilot_get_capture_status","Poll an owned acquisition job. running/completed/cancelled/failed/timed_out are distinct. cancel_requested does not mean the driver has stopped. samples_read and finalized coordinates are decimal strings. Completed context is usable by existing analysis/marker tools; released means its capture is no longer available.",json!({"job_id":id}),&["job_id"],true,true),
        crate::tool("sigpilot_stop_capture","Request stopping only your own acquisition job. Safe to retry before the driver starts or after it finishes; poll until terminal. Partial acquired data is retained. Cannot stop desktop-user or another client's capture.",json!({"job_id":id}),&["job_id"],false,true),
        crate::tool("sigpilot_release_capture","Release your completed acquisition and its memory, closing its desktop tab. Running jobs must first be stopped and polled to terminal. Safe to retry; the request replay record remains and will not silently restart acquisition.",json!({"job_id":id}),&["job_id"],false,true),
    ]);
    tools
}

#[cfg(test)]
mod tests {
    use super::*;
    use sigpilot_core::{DecoderBackendKind, DemoAnalyzerSettings, DeviceDriver, FakeBackend};
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    struct DemoController {
        workbench: Arc<WorkbenchService>,
        active: Arc<Mutex<Option<String>>>,
        cancel: Arc<AtomicBool>,
        starts: Arc<AtomicUsize>,
        delay_ms: u64,
    }
    impl CaptureController for DemoController {
        fn devices(&self) -> std::result::Result<Vec<DeviceInfo>, String> {
            DeviceDriver::list_devices(&sigpilot_core::fake::FakeDriver::default())
                .map_err(|e| e.to_string())
        }
        fn capabilities(
            &self,
            id: &str,
        ) -> std::result::Result<HardwareCaptureCapabilities, String> {
            DeviceDriver::capabilities(&sigpilot_core::fake::FakeDriver::default(), id)
                .map_err(|e| e.to_string())
        }
        fn start(
            &self,
            id: String,
            settings: CaptureSettings,
            analyzers: Vec<AnalyzerDecodeSettings>,
            trigger: Option<ProtocolTriggerConfig>,
        ) -> CaptureFuture {
            let workbench = self.workbench.clone();
            let active = self.active.clone();
            let cancel = self.cancel.clone();
            let starts = self.starts.clone();
            let delay = self.delay_ms;
            Box::pin(async move {
                tokio::time::sleep(Duration::from_millis(delay)).await;
                tokio::task::spawn_blocking(move || {
                    starts.fetch_add(1, Ordering::AcqRel);
                    {
                        let mut slot = active.lock().unwrap();
                        if slot.is_some() {
                            return Err("Another capture is already running".into());
                        }
                        *slot = Some(id.clone());
                        cancel.store(false, Ordering::Release);
                    }
                    struct Guard(Arc<Mutex<Option<String>>>);
                    impl Drop for Guard {
                        fn drop(&mut self) {
                            *self.0.lock().unwrap() = None;
                        }
                    }
                    let _guard = Guard(active);
                    let graph = workbench.session(&id).unwrap().graph.clone();
                    let controller = std::cell::RefCell::new(trigger.map(
                        sigpilot_graph::protocol_trigger_capture::ProtocolTriggerCapture::new,
                    ));
                    let capture = FakeBackend
                        .capture_streaming_with_analyzers(
                            &settings,
                            &analyzers
                                .into_iter()
                                .map(|settings| DemoAnalyzerSettings {
                                    backend: DecoderBackendKind::LegacyRust,
                                    settings,
                                })
                                .collect::<Vec<_>>(),
                            &cancel,
                            &mut |_| {},
                            &mut |metadata| {
                                graph.begin_capture(metadata.clone()).unwrap();
                                if let Some(c) = controller.borrow_mut().as_mut() {
                                    c.start(metadata).unwrap();
                                }
                            },
                            &mut |bytes| {
                                graph.append_samples(bytes).unwrap();
                                if let Some(c) = controller.borrow_mut().as_mut() {
                                    c.feed(bytes).unwrap();
                                    if c.should_stop() {
                                        cancel.store(true, Ordering::Release);
                                    }
                                }
                            },
                        )
                        .map_err(|e| e.to_string())?;
                    let output = if let Some(c) = controller.borrow_mut().as_mut() {
                        let (metadata, bytes, report) = c.finish(&graph, capture, false)?;
                        Ok(json!({"metadata":metadata,"bytes":bytes,"protocol_trigger":report}))
                    } else {
                        let summary =
                            json!({"metadata":capture.metadata,"bytes":capture.samples.len()});
                        graph.finish_capture(capture).map_err(|e| e.to_string())?;
                        Ok(summary)
                    };
                    output
                })
                .await
                .map_err(|e| e.to_string())?
            })
        }
        fn cancel(&self, id: &str) -> std::result::Result<(), String> {
            if self.active.lock().unwrap().as_deref() == Some(id) {
                self.cancel.store(true, Ordering::Release);
                Ok(())
            } else {
                Err("requested session is not active".into())
            }
        }
    }
    fn setup(delay_ms: u64) -> (Arc<CaptureService>, Arc<DemoController>) {
        let workbench = Arc::new(WorkbenchService::default());
        let controller = Arc::new(DemoController {
            workbench: workbench.clone(),
            active: Arc::new(Mutex::new(None)),
            cancel: Arc::new(AtomicBool::new(false)),
            starts: Arc::new(AtomicUsize::new(0)),
            delay_ms,
        });
        (
            CaptureService::new(
                workbench,
                controller.clone(),
                tokio::runtime::Handle::current(),
            ),
            controller,
        )
    }
    fn request(id: &str) -> StartCaptureRequest {
        StartCaptureRequest {
            request_id: id.into(),
            device_id: FakeBackend::DEVICE_ID.into(),
            sample_rate_hz: ExactU64(1_000_000),
            enabled_channels: vec![0, 1, 2, 3],
            mode: AcquisitionMode::Buffer,
            duration_ms: 10,
            buffer_size_mb: 1,
            threshold_volts: 1.8,
            timeout_ms: 1000,
            analyzers: vec![],
            protocol_trigger: None,
            hardware_trigger: None,
        }
    }
    async fn done(service: &CaptureService, owner: &str, id: &str) -> CaptureStatus {
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                let s = service.status(owner, id).unwrap();
                if s.state != CaptureState::Running {
                    return s;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap()
    }
    #[tokio::test]
    async fn real_demo_capture_replay_and_release_keep_exact_context() {
        let (service, controller) = setup(0);
        let r = request("one");
        let first = service.start("owner", r.clone()).unwrap();
        let replay = service.start("owner", r.clone()).unwrap();
        assert_eq!(first.job_id, replay.job_id);
        let mut conflict = r.clone();
        conflict.duration_ms = 20;
        assert_eq!(
            service.start("owner", conflict).unwrap_err().code,
            "REQUEST_ID_CONFLICT"
        );
        let complete = done(&service, "owner", &first.job_id).await;
        assert_eq!(complete.state, CaptureState::Completed);
        assert_eq!(controller.starts.load(Ordering::Acquire), 1);
        assert!(complete.context.is_some());
        assert_eq!(
            complete.summary.as_ref().unwrap()["metadata"]["sample_count"],
            "10048"
        );
        assert_eq!(
            complete.summary.as_ref().unwrap()["metadata"]["sample_rate_hz"],
            "1000000"
        );
        assert_eq!(
            service.status("other", &first.job_id).unwrap_err().code,
            "CAPTURE_JOB_NOT_FOUND"
        );
        assert!(service.stop("other", &first.job_id).is_err());
        assert!(service.release("other", &first.job_id).is_err());
        // Closing the desktop tab bypasses CaptureService::release. The first
        // repeated start must observe release without starting hardware again.
        service.workbench.release_session(&first.session_id);
        let closed_replay = service.start("owner", r.clone()).unwrap();
        assert_eq!(closed_replay.job_id, first.job_id);
        assert!(closed_replay.released && closed_replay.context.is_none());
        let closed_stop = service.stop("owner", &first.job_id).unwrap();
        assert!(closed_stop.released && closed_stop.context.is_none());
        assert!(service.release("owner", &first.job_id).unwrap().released);
        assert!(service.release("owner", &first.job_id).unwrap().released);
        assert!(service.start("owner", r).unwrap().released);
        assert_eq!(controller.starts.load(Ordering::Acquire), 1);
        assert!(service.workbench.session_ids().is_empty());
    }
    #[tokio::test]
    async fn cancellation_before_driver_lock_retries_without_touching_other_session() {
        let (service, controller) = setup(70);
        let mut r = request("late");
        r.mode = AcquisitionMode::Stream;
        let job = service.start("owner", r).unwrap();
        // Allow the task to enter the delayed controller, then request stop.
        tokio::time::sleep(Duration::from_millis(10)).await;
        service.stop("owner", &job.job_id).unwrap();
        assert_eq!(
            service.status("owner", &job.job_id).unwrap().state,
            CaptureState::Running
        );
        assert!(service.release("owner", &job.job_id).is_err());
        assert_eq!(
            service.start("other", request("busy")).unwrap_err().code,
            "DEVICE_BUSY"
        );
        let complete = done(&service, "owner", &job.job_id).await;
        assert_eq!(complete.state, CaptureState::Cancelled);
        assert!(complete.cancel_requested);
        assert!(controller.active.lock().unwrap().is_none());
    }
    #[tokio::test]
    async fn deadline_and_service_shutdown_wait_for_driver_stop() {
        let (service, controller) = setup(0);
        let mut r = request("deadline");
        r.mode = AcquisitionMode::Stream;
        r.timeout_ms = 30;
        let job = service.start("owner", r).unwrap();
        let end = done(&service, "owner", &job.job_id).await;
        assert_eq!(end.state, CaptureState::TimedOut);
        assert!(end.summary.is_some());
        assert!(controller.active.lock().unwrap().is_none());
        let mut r = request("shutdown");
        r.mode = AcquisitionMode::Stream;
        let job = service.start("owner", r).unwrap();
        service.cancel_all();
        assert_eq!(
            done(&service, "owner", &job.job_id).await.state,
            CaptureState::Cancelled
        );
        assert_eq!(
            service.start("owner", request("reject")).unwrap_err().code,
            "SERVICE_STOPPING"
        );
    }
    #[tokio::test]
    async fn permission_and_capabilities_fail_before_device_start() {
        let (service, controller) = setup(0);
        let mut adapter =
            crate::McpAdapter::new(service.workbench.clone(), vec![], false, "owner".into());
        adapter.capture_service = Some(service.clone());
        assert!(adapter
            .tool_catalog()
            .iter()
            .any(|t| t.name == "sigpilot_list_devices"));
        assert!(!adapter
            .tool_catalog()
            .iter()
            .any(|t| t.name == "sigpilot_start_capture"));
        assert_eq!(
            execute(
                &service,
                "owner",
                false,
                "sigpilot_start_capture",
                serde_json::to_value(request("deny")).unwrap()
            )
            .unwrap_err()
            .code,
            "ACCESS_DENIED"
        );
        for r in [
            StartCaptureRequest {
                sample_rate_hz: ExactU64(123456),
                ..request("rate")
            },
            StartCaptureRequest {
                enabled_channels: vec![0, 0],
                ..request("duplicate")
            },
            StartCaptureRequest {
                duration_ms: 60000,
                ..request("budget")
            },
            StartCaptureRequest {
                threshold_volts: 99.0,
                ..request("threshold")
            },
        ] {
            assert!(service.start("owner", r).is_err());
        }
        assert_eq!(controller.starts.load(Ordering::Acquire), 0);
        assert!(service.workbench.session_ids().is_empty());
        let caps = service.device_capabilities(FakeBackend::DEVICE_ID).unwrap();
        assert!(caps["device"]["sample_rates"][0].is_string());
    }
    #[tokio::test]
    async fn revoked_owner_and_previous_service_captures_cannot_bypass_limits() {
        let (service, controller) = setup(0);
        service.cancel_owner("revoked");
        assert_eq!(
            service
                .start("revoked", request("after-revoke"))
                .unwrap_err()
                .code,
            "ACCESS_DENIED"
        );
        for index in 0..MAX_CAPTURES {
            service
                .workbench
                .session(&format!("mcp-previous-{index}"))
                .unwrap();
        }
        assert_eq!(
            service
                .start("owner", request("retention"))
                .unwrap_err()
                .code,
            "RESOURCE_LIMIT"
        );
        assert_eq!(controller.starts.load(Ordering::Acquire), 0);
    }
    #[test]
    fn hardware_trigger_checks_driver_masks_and_protocol_conflict() {
        let mut r = request("hardware");
        r.hardware_trigger = Some(HardwareTrigger {
            channel: 0,
            kind: sigpilot_core::CaptureTriggerKind::Rising,
            high_mask: 0,
            low_mask: 0,
            position_percent: 50,
        });
        let mut caps =
            DeviceDriver::capabilities(&sigpilot_core::fake::FakeDriver::default(), &r.device_id)
                .unwrap();
        assert!(validate(&r, &caps).is_err());
        r.device_id = "usb:1a86:5237:1:1".into();
        caps.profile_vendor = Some("PX_Tool".into());
        assert!(validate(&r, &caps).unwrap().trigger_enabled);
        r.hardware_trigger.as_mut().unwrap().high_mask = 2;
        r.hardware_trigger.as_mut().unwrap().low_mask = 2;
        assert!(validate(&r, &caps).is_err());
        r.hardware_trigger.as_mut().unwrap().low_mask = 0;
        r.protocol_trigger = Some(ProtocolTriggerConfig {
            analyzer_id: "x".into(),
            decoder: AnalyzerDecodeSettings::Uart(Default::default()),
            condition: sigpilot_core::protocol_trigger::ProtocolTriggerCondition::UartSequence {
                bytes: vec![0],
            },
            pre_trigger_ms: 1,
            post_trigger_ms: 1,
            max_wait_ms: 1,
        });
        assert!(validate(&r, &caps).is_err());
    }
    #[tokio::test]
    async fn real_demo_software_trigger_returns_cropped_t0_for_analysis() {
        let (service, _) = setup(0);
        let decoder = AnalyzerDecodeSettings::Uart(sigpilot_core::UartDecodeSettings {
            baud_rate: 100000,
            ..Default::default()
        });
        let mut r = request("protocol");
        r.mode = AcquisitionMode::Stream;
        r.timeout_ms = 6000;
        r.analyzers = vec![decoder.clone()];
        r.protocol_trigger = Some(ProtocolTriggerConfig {
            analyzer_id: "uart".into(),
            decoder,
            condition: sigpilot_core::protocol_trigger::ProtocolTriggerCondition::UartSequence {
                bytes: b"demo".to_vec(),
            },
            pre_trigger_ms: 2,
            post_trigger_ms: 3,
            max_wait_ms: 100,
        });
        let job = service.start("owner", r).unwrap();
        let end = done(&service, "owner", &job.job_id).await;
        assert_eq!(end.state, CaptureState::Completed);
        let summary = end.summary.unwrap();
        assert_eq!(summary["metadata"]["trigger"]["protocol"], "UART");
        assert!(summary["metadata"]["trigger"]["sample_index"].is_string());
        assert_eq!(summary["protocol_trigger"]["status"], "matched");
        assert_eq!(summary["metadata"]["sample_count"], "4240");
    }
}
