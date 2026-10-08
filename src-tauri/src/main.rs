use std::{
    collections::HashMap,
    fs,
    path::Path,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use parking_lot::{Mutex, RwLock};
use std::sync::mpsc;
use sigpilot_core::{
    build_pxview_pwm0_register_script, AnalyzerDecodeSettings, CaptureMetadata, CaptureProgress,
    CaptureSettings, CaptureTriggerMetadata, DecodedFrame, DecoderBackendKind,
    DemoAnalyzerSettings, DeviceInfo, DeviceRegistry, DiagnosticEvent, DiagnosticLevel,
    ExportFormat, FakeBackend, HardwareCaptureCapabilities, PwmConfiguration, PwmSettings,
    SaleaeNativeDecoder, SigrokDecoderCatalog, SigrokNativeDecoder, SparseCaptureData,
};
use sigpilot_graph::{
    AnalyzerFrameTableRequest, AnalyzerFrameTableWindow, CaptureMemoryUsage,
    DigitalPointMeasurement, GraphFrameRequest, GraphFrameResponse, GraphSession,
    NativeAnalyzerDecodeProgress, NearestDigitalTransition, SessionView, ViewIntent, ViewLimits,
};
use sigpilot_waveform::{
    DigitalRangeMeasurementRequest, DigitalRangeMeasurementStats, WaveformRequest, WaveformTile,
};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

#[cfg(feature = "rusb-transport")]
use sigpilot_core::RusbBackend;

type CommandResult<T> = Result<T, String>;

#[derive(Serialize)]
struct PackedBinRange {
    offset: usize,
    length: usize,
}

#[derive(Serialize)]
struct BinaryChannelTile<'a> {
    channel: u8,
    label: &'a str,
    bins: &'a [sigpilot_waveform::WaveformBin],
    #[serde(skip_serializing_if = "Option::is_none")]
    packed_bins: Option<PackedBinRange>,
    segments: &'a [sigpilot_waveform::DigitalSegment],
    rising_edges: &'a [u64],
    falling_edges: &'a [u64],
    #[serde(skip_serializing_if = "Option::is_none")]
    previous_transition: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    next_transition: Option<u64>,
}

#[derive(Serialize)]
struct BinaryWaveformTile<'a> {
    start_sample: u64,
    sample_count: u64,
    pixels: u32,
    samples_per_pixel: f64,
    channels: Vec<BinaryChannelTile<'a>>,
}

#[derive(Serialize)]
struct BinaryGraphFrameResponse<'a> {
    frame_id: u64,
    revision: u64,
    sample_count: u64,
    /// The frontend's frame loop discards a frame that has no viewport, because
    /// drawing against `undefined` would take the canvas tree down with it. The
    /// binary transport has to carry both viewports exactly as the JSON
    /// response does; leaving them out makes every frame unusable.
    view: &'a sigpilot_graph::SessionView,
    data_view: &'a sigpilot_graph::SessionView,
    tile: BinaryWaveformTile<'a>,
    analyzers: &'a [sigpilot_graph::AnalyzerRenderResult],
}

fn encode_graph_frame_response(frame: GraphFrameResponse) -> CommandResult<tauri::ipc::Response> {
    encode_graph_frame_bytes(frame).map(tauri::ipc::Response::new)
}

fn encode_graph_frame_bytes(mut frame: GraphFrameResponse) -> CommandResult<Vec<u8>> {
    let mut binary = Vec::new();
    let packed_ranges = frame
        .tile
        .channels
        .iter_mut()
        .map(|channel| {
            channel.packed_bins.take().map(|packed| {
                let offset = binary.len();
                let length = packed.len();
                binary.extend_from_slice(&packed);
                PackedBinRange { offset, length }
            })
        })
        .collect::<Vec<_>>();
    let channels = frame
        .tile
        .channels
        .iter()
        .zip(packed_ranges)
        .map(|(channel, packed_bins)| BinaryChannelTile {
            channel: channel.channel,
            label: &channel.label,
            bins: &channel.bins,
            packed_bins,
            segments: &channel.segments,
            rising_edges: &channel.rising_edges,
            falling_edges: &channel.falling_edges,
            previous_transition: channel.previous_transition,
            next_transition: channel.next_transition,
        })
        .collect();
    let response = BinaryGraphFrameResponse {
        frame_id: frame.frame_id,
        revision: frame.revision,
        sample_count: frame.sample_count,
        view: &frame.view,
        data_view: &frame.data_view,
        tile: BinaryWaveformTile {
            start_sample: frame.tile.start_sample,
            sample_count: frame.tile.sample_count,
            pixels: frame.tile.pixels,
            samples_per_pixel: frame.tile.samples_per_pixel,
            channels,
        },
        analyzers: &frame.analyzers,
    };
    let header = serde_json::to_vec(&response).map_err(to_string)?;
    let mut output = Vec::with_capacity(13 + header.len() + binary.len());
    output.extend_from_slice(b"PXGF1");
    output.extend_from_slice(&(header.len() as u64).to_le_bytes());
    output.extend_from_slice(&header);
    output.extend_from_slice(&binary);
    Ok(output)
}

#[derive(Clone)]
struct AppState {
    sessions: Arc<RwLock<HashMap<String, Arc<GraphSession>>>>,
    cancel: Arc<AtomicBool>,
    active_capture: Arc<Mutex<Option<ActiveCapture>>>,
    /// Hardware-agnostic device drivers. Every device-id lookup goes through this,
    /// so adding a vendor is a registration change rather than a command-layer change.
    devices: Arc<DeviceRegistry>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            sessions: Arc::default(),
            cancel: Arc::default(),
            active_capture: Arc::default(),
            devices: Arc::new(DeviceRegistry::with_builtin_drivers()),
        }
    }
}

impl AppState {
    fn session(&self, session_id: &str) -> Arc<GraphSession> {
        if let Some(session) = self.sessions.read().get(session_id).cloned() {
            return session;
        }
        let mut sessions = self.sessions.write();
        sessions
            .entry(session_id.to_string())
            .or_insert_with(|| Arc::new(GraphSession::default()))
            .clone()
    }

    fn existing_session(&self, session_id: &str) -> CommandResult<Arc<GraphSession>> {
        self.sessions
            .read()
            .get(session_id)
            .cloned()
            .ok_or_else(|| format!("session {session_id} has no capture data"))
    }

    /// Drop any cached device state, e.g. after a USB error invalidated the FPGA
    /// configuration. The owning driver decides what "cached" means.
    fn forget_prepared_device(&self, device_id: &str) {
        self.devices.invalidate(device_id);
    }
}

#[derive(Debug, Clone)]
struct ActiveCapture {
    device_id: String,
    session_id: String,
}

#[derive(Debug, Clone, Serialize)]
struct CaptureSummary {
    metadata: CaptureMetadata,
    bytes: usize,
}

#[derive(Debug, Clone, Serialize)]
struct OpenCaptureResult {
    summary: CaptureSummary,
    saleae_session: Option<sigpilot_file::SaleaeSessionMetadata>,
}

fn sparse_capture_summary(capture: &SparseCaptureData) -> CaptureSummary {
    let bytes = capture
        .channels
        .iter()
        .map(|channel| channel.transitions.len().saturating_mul(8))
        .sum();
    CaptureSummary {
        metadata: capture.metadata.clone(),
        bytes,
    }
}

#[derive(Debug, Clone, Serialize)]
struct CaptureUpdatedEvent {
    session_id: String,
    summary: CaptureSummary,
}

#[derive(Debug, Clone, Serialize)]
struct CaptureMemoryUpdatedEvent {
    session_id: String,
    usage: CaptureMemoryUsage,
}

#[derive(Debug, Clone, Serialize)]
struct CaptureTriggeredEvent {
    session_id: String,
    trigger: CaptureTriggerMetadata,
}

#[derive(Debug, Clone, Deserialize)]
struct TrimCaptureRequest {
    trim_before_sample: Option<u64>,
    trim_after_sample: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
struct NearestDigitalTransitionRequest {
    channel: u8,
    sample: u64,
}

#[derive(Debug, Clone, Deserialize)]
struct DigitalPointMeasurementRequest {
    channel: u8,
    sample: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScreenshotPathRequest {
    connected_device_name: Option<String>,
    previous_path: Option<String>,
    session_name: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WriteScreenshotRequest {
    data_base64: String,
    path: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WriteTextFileRequest {
    contents: String,
    path: String,
}

#[derive(Debug, Clone, Deserialize)]
struct AnalyzerDecodeBatchRequest {
    analyzer_id: String,
    backend: DecoderBackendKind,
    settings: AnalyzerDecodeSettings,
}

#[derive(Debug, Clone, Serialize)]
struct AnalyzerDecodeBatchResult {
    analyzer_id: String,
    frames: Vec<DecodedFrame>,
}

#[derive(Debug, Clone, Serialize)]
struct AnalyzerDecodeBatchSummaryResult {
    analyzer_id: String,
    frame_count: usize,
}

#[derive(Debug, Clone, Serialize)]
struct AnalyzerDecodeBackgroundProgressResult {
    analyzer_id: String,
    frame_count: usize,
    processed_edges: usize,
    total_edges: usize,
    progress: f64,
    complete: bool,
    cancelled: bool,
}

#[derive(Debug, Clone, Deserialize)]
struct AnalyzerDecodeFrameSliceRequest {
    backend: DecoderBackendKind,
    end: usize,
    settings: AnalyzerDecodeSettings,
    start: usize,
}

#[derive(Debug, Clone, Serialize)]
struct AnalyzerDecodeFrameSliceResult {
    frame_count: usize,
    frames: Vec<DecodedFrame>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExtensionTemplateRequest {
    author: String,
    description: String,
    name: String,
    path: String,
    #[serde(rename = "type")]
    extension_type: String,
}

#[derive(Debug, Clone, Serialize)]
struct ExtensionPackage {
    manifest: serde_json::Value,
    path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    readme: Option<String>,
}

#[tauri::command]
fn list_devices(state: State<'_, AppState>) -> CommandResult<Vec<DeviceInfo>> {
    Ok(state.devices.list_devices())
}

#[tauri::command]
fn device_capabilities(
    state: State<'_, AppState>,
    device_id: String,
) -> CommandResult<HardwareCaptureCapabilities> {
    state
        .devices
        .capabilities(&device_id)
        .map_err(|error| format!("device {device_id} is not currently connected ({error})"))
}

/// Prepare any device, whichever driver owns it.
///
/// The owning driver owns the prepare cache, so "already prepared?" is answered
/// by whoever actually flashed the FPGA.
fn prepare_device_cached(
    state: &AppState,
    device_id: &str,
    sink: &mut dyn FnMut(DiagnosticEvent),
) -> sigpilot_core::Result<()> {
    let result = state.devices.prepare(device_id, sink);
    if result.is_err() {
        // A failed prepare must not leave a stale "already prepared" answer behind.
        state.devices.invalidate(device_id);
    }
    result
}

#[tauri::command]
async fn prepare_device(
    app: AppHandle,
    state: State<'_, AppState>,
    device_id: String,
) -> CommandResult<()> {
    let app_state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let diagnostics_app = app.clone();
        let mut diagnostics = |event: DiagnosticEvent| {
            let _ = diagnostics_app.emit("usb_diagnostic", &event);
        };
        prepare_device_cached(&app_state, &device_id, &mut diagnostics).map_err(to_string)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn configure_pwm(
    app: AppHandle,
    state: State<'_, AppState>,
    device_id: String,
    settings: PwmSettings,
) -> CommandResult<PwmConfiguration> {
    if let Some(active) = state.active_capture.lock().clone() {
        return Err(format!(
            "cannot configure PWM0 while session {} is capturing from {}",
            active.session_id, active.device_id
        ));
    }
    if device_id == FakeBackend::DEVICE_ID {
        return build_pxview_pwm0_register_script(&settings)
            .map(|(configuration, _)| configuration)
            .map_err(to_string);
    }

    // The Kingst LA series has PWM outputs, but this driver does not implement
    // them. Falling through to the PXLogic path below would resolve a PXLogic
    // profile for a Kingst device and fail with "unsupported PXLogic device",
    // which points at the wrong thing entirely.
    if sigpilot_core::kingst_la2016::owns(&device_id) {
        tracing::warn!(device_id, "PWM requested for a Kingst device, which does not implement it");
        return Err("PWM output is not implemented for Kingst LA series devices".to_string());
    }

    tracing::debug!(device_id, frequency_hz = settings.frequency_hz, "configure_pwm");

    #[cfg(feature = "rusb-transport")]
    {
        let app_state = state.inner().clone();
        return tauri::async_runtime::spawn_blocking(move || {
            let real = RusbBackend::default();
            let diagnostics_app = app.clone();
            let mut diagnostics = |event: DiagnosticEvent| {
                let _ = diagnostics_app.emit("usb_diagnostic", &event);
            };
            prepare_device_cached(&app_state, &device_id, &mut diagnostics)
                .map_err(to_string)?;
            real.configure_pwm0_with_trace(&device_id, &settings, &mut diagnostics)
                .map_err(to_string)
        })
        .await
        .map_err(|error| error.to_string())?;
    }

    #[allow(unreachable_code)]
    Err("real USB backend is not enabled in this build".to_string())
}

/// Writes a line from the webview into the application log.
///
/// Without this the log file is backend-only, which makes a frontend problem
/// undiagnosable from it: an event that never arrived and a handler that decided
/// not to act leave exactly the same trace, which is none.
#[tauri::command]
fn frontend_log(level: Option<String>, message: String) {
    match level.as_deref() {
        Some("warn") => tracing::warn!(target: "sigpilot_webview", "{message}"),
        Some("error") => tracing::error!(target: "sigpilot_webview", "{message}"),
        _ => tracing::info!(target: "sigpilot_webview", "{message}"),
    }
}

/// Publishes capture UI updates from a thread of its own.
///
/// The capture thread must never wait on the webview. `emit` serialises the
/// payload and hands it to the IPC channel, and when the webview is busy that
/// takes milliseconds; for those milliseconds no USB read is in flight, the
/// device's FIFO overflows and the stream stops. That is the same failure mode
/// as a buffer reallocation, and it fired thirty times a second from inside the
/// read loop.
#[derive(Clone)]
struct UiPublisher {
    sender: mpsc::SyncSender<UiMessage>,
}

enum UiMessage {
    Progress(CaptureProgress, CaptureMemoryUpdatedEvent),
    Updated(CaptureUpdatedEvent),
    Diagnostic(DiagnosticEvent),
}

impl UiMessage {
    fn emit(self, app: &AppHandle) {
        match self {
            UiMessage::Progress(progress, memory) => {
                let _ = app.emit("capture_progress", &progress);
                let _ = app.emit("capture_memory_updated", &memory);
            }
            UiMessage::Updated(event) => {
                let _ = app.emit("capture_updated", &event);
            }
            UiMessage::Diagnostic(event) => {
                let _ = app.emit("usb_diagnostic", &event);
            }
        }
    }
}

impl UiPublisher {
    fn new(app: AppHandle) -> Self {
        // Capacity one, and `try_send` rather than `send`: a full queue drops the
        // incoming update instead of waiting for room. The queue drains within one
        // update interval, so the cost is showing a progress value one tick old —
        // not worth blocking a USB read for. The worker exits when the last
        // publisher handle goes away and the channel closes.
        let (sender, receiver) = mpsc::sync_channel::<UiMessage>(1);
        std::thread::Builder::new()
            .name("sigpilot-ui".to_string())
            .spawn(move || {
                while let Ok(message) = receiver.recv() {
                    message.emit(&app);
                }
            })
            .ok();
        Self { sender }
    }

    /// Hands over an update without waiting for the webview.
    fn send(&self, message: UiMessage) {
        let _ = self.sender.try_send(message);
    }
}

#[tauri::command]
async fn start_capture(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    settings: CaptureSettings,
    demo_analyzers: Option<Vec<DemoAnalyzerSettings>>,
) -> CommandResult<CaptureSummary> {
    // The entry log is what makes a failed capture explainable after the fact:
    // it records which device was asked for and with what configuration, so a
    // later error can be attributed to the request rather than guessed at.
    tracing::info!(
        session_id,
        device_id = %settings.device_id,
        sample_rate_hz = settings.sample_rate_hz,
        channel_count = settings.channel_count,
        enabled_channels = ?settings.enabled_channels,
        decode_cross = settings.decode_cross,
        duration_ms = settings.duration_ms,
        buffer_size_mb = settings.buffer_size_mb,
        threshold_volts = settings.threshold_volts,
        mode = ?settings.mode,
        trigger_enabled = settings.trigger_enabled,
        "start_capture requested"
    );

    state.cancel.store(false, Ordering::Release);
    let cancel = state.cancel.clone();
    let graph = state.session(&session_id);
    let active_capture = state.active_capture.clone();
    let app_state = state.inner().clone();

    let result = tauri::async_runtime::spawn_blocking(move || {
        *active_capture.lock() = Some(ActiveCapture {
            device_id: settings.device_id.clone(),
            session_id: session_id.clone(),
        });
        let buffer_bytes = settings.buffer_size_mb.saturating_mul(1024 * 1024);
        let publisher = UiPublisher::new(app.clone());
        let progress_app = publisher.clone();
        let progress_graph = graph.clone();
        let progress_session_id = session_id.clone();
        let progress_cancel = cancel.clone();
        let mut last_progress_emit = Instant::now()
            .checked_sub(Duration::from_secs(1))
            .unwrap_or_else(Instant::now);
        let mut progress = |event: CaptureProgress| {
            let usage =
                progress_graph.capture_memory_usage(buffer_bytes, Some(event.sample_memory_bytes));
            if usage.total_bytes >= buffer_bytes {
                // The only thing that stops a capture from this side, so record
                // the numbers when it fires: "it stopped early" is otherwise
                // impossible to tell from "the device went quiet".
                tracing::info!(
                    samples_read = event.samples_read,
                    sample_memory_bytes = event.sample_memory_bytes,
                    total_bytes = usage.total_bytes,
                    buffer_bytes,
                    "capture buffer limit reached; stopping"
                );
                progress_cancel.store(true, Ordering::Release);
            }
            // Capture values are informational UI state. Publishing every USB
            // transfer couples React work to hardware throughput, so keep this
            // at Logic 2's 5 Hz status cadence while enforcing memory limits on
            // every callback above.
            if last_progress_emit.elapsed() < Duration::from_millis(200) {
                return;
            }
            last_progress_emit = Instant::now();
            progress_app.send(UiMessage::Progress(
                event,
                CaptureMemoryUpdatedEvent {
                    session_id: progress_session_id.clone(),
                    usage,
                },
            ));
        };
        let diagnostics_app = publisher.clone();
        let mut diagnostics = |event: DiagnosticEvent| {
            diagnostics_app.send(UiMessage::Diagnostic(event));
        };
        let graph_error = Arc::new(Mutex::new(None::<String>));
        // Cross-lane packing is a PXLogic wire format, and `decode_cross`
        // defaults to true in the client, so gating on it alone routes every
        // Kingst capture down the packed path. That path expects
        // `append_cross_lanes`, which the Kingst driver never produces, so the
        // graph received nothing while the capture ran — no live waveform — and
        // only got the samples when `finish_capture` replaced the capture.
        let use_packed_graph = settings.device_id != FakeBackend::DEVICE_ID
            && !sigpilot_core::kingst_la2016::owns(&settings.device_id)
            && settings.decode_cross;
        let started_graph = graph.clone();
        let started_error = graph_error.clone();
        let mut started = move |metadata: &CaptureMetadata| {
            if let Err(error) = started_graph.begin_capture(metadata.clone()) {
                *started_error.lock() = Some(error.to_string());
            }
        };
        let samples_graph = graph.clone();
        let samples_error = graph_error.clone();
        let update_app = publisher.clone();
        let update_session_id = session_id.clone();
        let mut last_update = Instant::now()
            .checked_sub(Duration::from_secs(1))
            .unwrap_or_else(Instant::now);
        let mut samples = move |chunk: &[u8]| {
            if samples_error.lock().is_some() {
                return;
            }
            if !use_packed_graph {
                if let Err(error) = samples_graph.append_samples(chunk) {
                    *samples_error.lock() = Some(error.to_string());
                    return;
                }
            }
            let metadata = samples_graph.metadata();
            if last_update.elapsed() < Duration::from_millis(50) {
                return;
            }
            last_update = Instant::now();
            if let Some(metadata) = metadata {
                // The viewport is clamped to the count the client is told, so a
                // waveform that stops growing on screen while the capture
                // continues means this number is wrong. Record it rather than
                // guessing which layer lost it.
                tracing::debug!(
                    sample_count = metadata.sample_count,
                    graph_sample_count = samples_graph.sample_count(),
                    "capture_updated"
                );
                let summary = CaptureSummary {
                    bytes: usize::try_from(metadata.sample_count)
                        .unwrap_or(usize::MAX)
                        .saturating_mul(usize::from(metadata.unitsize)),
                    metadata,
                };
                update_app.send(UiMessage::Updated(CaptureUpdatedEvent {
                    session_id: update_session_id.clone(),
                    summary,
                }));
            }
        };
        let cross_graph = graph.clone();
        let cross_error = graph_error.clone();
        let mut cross_lanes = move |enabled_channels: &[u8], chunk: &[u8]| {
            if cross_error.lock().is_some() {
                return;
            }
            if let Err(error) = cross_graph.append_cross_lanes(enabled_channels, chunk, false) {
                *cross_error.lock() = Some(error.to_string());
            }
        };
        let trigger_graph = graph.clone();
        let trigger_error = graph_error.clone();
        let trigger_app = app.clone();
        let trigger_session_id = session_id.clone();
        let mut triggered = move |trigger: &CaptureTriggerMetadata| {
            if let Err(error) = trigger_graph.set_trigger(trigger.clone()) {
                *trigger_error.lock() = Some(error.to_string());
                return;
            }
            let _ = trigger_app.emit(
                "capture_triggered",
                &CaptureTriggeredEvent {
                    session_id: trigger_session_id.clone(),
                    trigger: trigger.clone(),
                },
            );
        };

        // TODO(capture-path): this branch is the last place the command layer still
        // knows which driver it is talking to. Enumeration, capability resolution and
        // `prepare` all go through `DeviceRegistry` now; capture does not, because the
        // demo source (`capture_streaming_with_analyzers`) and real hardware
        // (`capture_with_trace_streaming`) have genuinely different entry points.
        // Unifying them means moving capture onto `DeviceDriver` with a shared
        // `CaptureSink`, which touches the hot path and is deferred.
        let route = if settings.device_id == FakeBackend::DEVICE_ID {
            "demo"
        } else if sigpilot_core::kingst_la2016::owns(&settings.device_id) {
            "kingst"
        } else {
            "pxlogic"
        };
        tracing::debug!(route, device_id = %settings.device_id, "capture route selected");

        let capture = if settings.device_id == FakeBackend::DEVICE_ID {
            FakeBackend::default().capture_streaming_with_analyzers(
                &settings,
                demo_analyzers.as_deref().unwrap_or_default(),
                &cancel,
                &mut progress,
                &mut started,
                &mut samples,
            )
        } else if sigpilot_core::kingst_la2016::owns(&settings.device_id) {
            // The Kingst LA series samples into its own SDRAM and is downloaded
            // afterwards, so it hands back a complete capture instead of
            // streaming through `samples`. `started` still has to run, because
            // that is what tells the graph session a capture began.
            #[cfg(feature = "rusb-transport")]
            {
                // `started` opens the graph session and `samples` feeds it, so
                // the waveform grows while the capture runs instead of landing
                // in one piece at the end. `capture` calls `started` itself,
                // before any data exists.
                sigpilot_core::kingst_la2016::capture(
                    &settings.device_id,
                    &settings,
                    &cancel,
                    &mut started,
                    &mut samples,
                    &mut diagnostics,
                    &mut progress,
                )
            }
            #[cfg(not(feature = "rusb-transport"))]
            {
                Err(sigpilot_core::CoreError::UnsupportedDevice)
            }
        } else {
            #[cfg(feature = "rusb-transport")]
            {
                let real = RusbBackend::default();
                diagnostics(DiagnosticEvent {
                    phase: "prepare".to_string(),
                    level: DiagnosticLevel::Info,
                    message: "auto prepare before capture".to_string(),
                });
                match prepare_device_cached(&app_state, &settings.device_id, &mut diagnostics)
                {
                    Ok(()) => real.capture_with_trace_streaming(
                        &settings,
                        &cancel,
                        &mut progress,
                        &mut diagnostics,
                        &mut started,
                        &mut samples,
                        &mut cross_lanes,
                        &mut triggered,
                    ),
                    Err(error) => Err(error),
                }
            }
            #[cfg(not(feature = "rusb-transport"))]
            {
                Err(sigpilot_core::CoreError::UnsupportedDevice)
            }
        };

        match capture {
            Ok(capture) => {
                *active_capture.lock() = None;
                tracing::info!(
                    source_device = %capture.metadata.source_device,
                    sample_count = capture.metadata.sample_count,
                    channel_count = capture.metadata.channel_count,
                    unitsize = capture.metadata.unitsize,
                    sample_rate_hz = capture.metadata.sample_rate_hz,
                    bytes = capture.samples.len(),
                    "capture finished"
                );
                if let Some(error) = graph_error.lock().take() {
                    return Err(error);
                }
                let summary = CaptureSummary {
                    metadata: capture.metadata.clone(),
                    bytes: capture.samples.len(),
                };
                graph.finish_capture(capture).map_err(to_string)?;
                let _ = app.emit(
                    "capture_memory_updated",
                    &CaptureMemoryUpdatedEvent {
                        session_id: session_id.clone(),
                        usage: graph.capture_memory_usage(buffer_bytes, None),
                    },
                );
                let _ = app.emit("capture_completed", &summary);
                Ok(summary)
            }
            Err(error) => {
                *active_capture.lock() = None;
                #[cfg(feature = "rusb-transport")]
                if settings.device_id != FakeBackend::DEVICE_ID
                    && matches!(error, sigpilot_core::CoreError::Usb(_))
                {
                    app_state.forget_prepared_device(&settings.device_id);
                }
                let message = error.to_string();
                tracing::error!(
                    device_id = %settings.device_id,
                    error = %message,
                    "capture failed"
                );
                let _ = app.emit(
                    "usb_diagnostic",
                    &DiagnosticEvent {
                        phase: "error".to_string(),
                        level: DiagnosticLevel::Error,
                        message: message.clone(),
                    },
                );
                let _ = app.emit("capture_failed", &message);
                Err(message)
            }
        }
    })
    .await
    .map_err(|error| error.to_string())?;

    result
}

#[tauri::command]
fn cancel_capture(app: AppHandle, state: State<'_, AppState>) -> CommandResult<()> {
    state.cancel.store(true, Ordering::Release);
    let active_capture = state.active_capture.lock().clone();
    if let Some(active_capture) = active_capture {
        let _ = app.emit(
            "usb_diagnostic",
            &DiagnosticEvent {
                phase: "capture".to_string(),
                level: DiagnosticLevel::Info,
                message: format!(
                    "stop requested for {} on {}; cancelling the active USB read",
                    active_capture.session_id, active_capture.device_id
                ),
            },
        );
    }

    Ok(())
}

#[tauri::command]
fn open_capture(
    session_id: String,
    path: String,
    state: State<'_, AppState>,
) -> CommandResult<OpenCaptureResult> {
    let source_path = PathBuf::from(&path);
    if source_path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("pxl"))
    {
        let project = sigpilot_file::open_pxl(source_path).map_err(to_string)?;
        let summary = match project.capture {
            sigpilot_file::PxlogicProjectCapture::Packed(capture) => {
                let summary = CaptureSummary {
                    metadata: capture.metadata.clone(),
                    bytes: capture.samples.len(),
                };
                state
                    .session(&session_id)
                    .replace_capture(capture)
                    .map_err(to_string)?;
                summary
            }
            sigpilot_file::PxlogicProjectCapture::Sparse(capture) => {
                let summary = sparse_capture_summary(&capture);
                state
                    .session(&session_id)
                    .replace_sparse_capture(capture)
                    .map_err(to_string)?;
                summary
            }
        };
        return Ok(OpenCaptureResult {
            summary,
            saleae_session: Some(project.session),
        });
    }

    let capture = sigpilot_file::open_pxcap(source_path).map_err(to_string)?;
    let summary = CaptureSummary {
        metadata: capture.metadata.clone(),
        bytes: capture.samples.len(),
    };
    state
        .session(&session_id)
        .replace_capture(capture)
        .map_err(to_string)?;
    Ok(OpenCaptureResult {
        summary,
        saleae_session: None,
    })
}

#[tauri::command]
fn save_capture(
    session_id: String,
    path: String,
    saleae_session: Option<sigpilot_file::SaleaeSessionMetadata>,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    let session = state.existing_session(&session_id)?;
    let path = PathBuf::from(path);
    if path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("pxl"))
    {
        let metadata = saleae_session.unwrap_or_default();
        if let Some(capture) = session.capture() {
            return sigpilot_file::save_pxl_packed(path, &capture, &metadata).map_err(to_string);
        }
        if let Some(capture) = session.sparse_capture() {
            return sigpilot_file::save_pxl_sparse(path, &capture, &metadata).map_err(to_string);
        }
        return Err("no capture is loaded".to_string());
    }

    let capture = session
        .capture()
        .ok_or_else(|| "this save format requires a packed capture".to_string())?;
    sigpilot_file::save_pxcap(path, &capture).map_err(to_string)
}

#[tauri::command]
fn export_capture(
    session_id: String,
    path: String,
    format: ExportFormat,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    let session = state.existing_session(&session_id)?;
    let capture = session
        .capture()
        .ok_or_else(|| "this export format requires a packed capture".to_string())?;
    match format {
        ExportFormat::Pxcap => sigpilot_file::save_pxcap(PathBuf::from(path), &capture),
        ExportFormat::Sr => sigpilot_file::export_sr(PathBuf::from(path), &capture),
        ExportFormat::Vcd => sigpilot_file::export_vcd(PathBuf::from(path), &capture),
    }
    .map_err(to_string)
}

#[tauri::command]
async fn trim_capture(
    session_id: String,
    request: TrimCaptureRequest,
    state: State<'_, AppState>,
) -> CommandResult<CaptureSummary> {
    let session = state.existing_session(&session_id)?;
    let total_samples = session.sample_count();
    if total_samples == 0 {
        return Err("capture is empty".to_string());
    }

    let start = request.trim_before_sample.unwrap_or(0).min(total_samples);
    let end = request
        .trim_after_sample
        .unwrap_or(total_samples)
        .min(total_samples);
    if end <= start {
        return Err("delete data interval would remove the entire capture".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let (metadata, bytes) = session.trim_capture(start, end).map_err(to_string)?;
        Ok(CaptureSummary { metadata, bytes })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ParsedScreenshotPath {
    basename_without_index: String,
    dirname: PathBuf,
    extension: String,
    index: Option<u64>,
}

fn screenshot_numeric_index(basename: &str) -> Option<(usize, usize, u64)> {
    let bytes = basename.as_bytes();
    for start in 0..bytes.len() {
        if bytes[start] != b'_' {
            continue;
        }
        let mut end = start + 1;
        while end < bytes.len() && bytes[end].is_ascii_digit() {
            end += 1;
        }
        if end > start + 1 {
            let index = basename[start + 1..end].parse().ok()?;
            return Some((start, end, index));
        }
    }
    None
}

fn parse_screenshot_path(path: &Path) -> ParsedScreenshotPath {
    let dirname = path.parent().unwrap_or_else(|| Path::new("")).to_path_buf();
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| format!(".{extension}"))
        .unwrap_or_default();
    let basename = path
        .file_stem()
        .and_then(|basename| basename.to_str())
        .unwrap_or_default()
        .to_string();
    let (basename_without_index, index) = match screenshot_numeric_index(&basename) {
        Some((start, end, index)) => {
            let mut without_index = basename;
            without_index.replace_range(start..end, "");
            (without_index, Some(index))
        }
        None => (basename, None),
    };
    ParsedScreenshotPath {
        basename_without_index,
        dirname,
        extension,
        index,
    }
}

fn increment_screenshot_path(path: &Path) -> PathBuf {
    let parsed = parse_screenshot_path(path);
    let next_index = parsed.index.map_or(2, |index| index + 1);
    parsed.dirname.join(format!(
        "{}_{}{}",
        parsed.basename_without_index, next_index, parsed.extension
    ))
}

fn is_default_session_name(name: &str) -> bool {
    name.strip_prefix("Session ").is_some_and(|suffix| {
        !suffix.is_empty() && suffix.bytes().all(|byte| byte.is_ascii_digit())
    })
}

fn next_screenshot_path_with_exists(
    home_dir: &Path,
    request: &ScreenshotPathRequest,
    path_exists: impl Fn(&Path) -> bool,
) -> PathBuf {
    let parsed_previous = request
        .previous_path
        .as_deref()
        .map(Path::new)
        .map(parse_screenshot_path);
    let extension = parsed_previous
        .as_ref()
        .map(|parsed| parsed.extension.as_str())
        .filter(|extension| !extension.is_empty())
        .unwrap_or(".png");
    let derived_basename = match request.session_name.as_deref() {
        Some(session_name) if !is_default_session_name(session_name) => session_name,
        _ => request
            .connected_device_name
            .as_deref()
            .unwrap_or("Logic 2"),
    };
    let derived_path = home_dir.join(format!("{derived_basename}{extension}"));

    let next_path = match (&request.previous_path, &parsed_previous) {
        (Some(previous_path), Some(previous)) => {
            let previous_was_derived = is_default_session_name(&previous.basename_without_index)
                || request.connected_device_name.as_deref()
                    == Some(previous.basename_without_index.as_str())
                || previous.basename_without_index == "Logic 2";
            if previous_was_derived {
                let derived = parse_screenshot_path(&derived_path);
                if previous.basename_without_index == derived.basename_without_index {
                    PathBuf::from(previous_path)
                } else {
                    derived_path
                }
            } else {
                PathBuf::from(previous_path)
            }
        }
        _ => derived_path,
    };

    if path_exists(&next_path) {
        increment_screenshot_path(&next_path)
    } else {
        next_path
    }
}

#[tauri::command]
fn next_screenshot_path(app: AppHandle, request: ScreenshotPathRequest) -> CommandResult<String> {
    let home_dir = app.path().home_dir().map_err(to_string)?;
    Ok(
        next_screenshot_path_with_exists(&home_dir, &request, Path::exists)
            .to_string_lossy()
            .to_string(),
    )
}

#[tauri::command]
fn write_screenshot_file(request: WriteScreenshotRequest) -> CommandResult<()> {
    let path = PathBuf::from(&request.path);
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !matches!(extension.as_str(), "png" | "jpg" | "jpeg") {
        return Err("screenshots must use a .png, .jpg, or .jpeg extension".to_string());
    }
    let encoded = request
        .data_base64
        .split_once(',')
        .map_or(request.data_base64.as_str(), |(_, data)| data);
    let bytes = BASE64_STANDARD.decode(encoded).map_err(to_string)?;
    if bytes.is_empty() {
        return Err("screenshot image is empty".to_string());
    }
    fs::write(path, bytes).map_err(to_string)
}

#[tauri::command]
fn write_text_file(request: WriteTextFileRequest) -> CommandResult<()> {
    let path = PathBuf::from(&request.path);
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !matches!(extension.as_str(), "csv" | "txt") {
        return Err("analyzer exports must use a .csv or .txt extension".to_string());
    }
    if let Some(parent) = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        fs::create_dir_all(parent).map_err(to_string)?;
    }
    fs::write(path, request.contents).map_err(to_string)
}

#[cfg(target_os = "macos")]
#[tauri::command]
async fn capture_screenshot_png(app: AppHandle) -> CommandResult<String> {
    use block2::RcBlock;
    use objc2::runtime::AnyObject;
    use objc2_app_kit::{
        NSBitmapImageFileType, NSBitmapImageRep, NSBitmapImageRepPropertyKey, NSImage,
    };
    use objc2_foundation::{NSDictionary, NSError};
    use objc2_web_kit::WKWebView;

    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main webview is unavailable".to_string())?;
    let (sender, receiver) = std::sync::mpsc::sync_channel::<CommandResult<String>>(1);
    window
        .with_webview(move |webview| unsafe {
            let view: &WKWebView = &*webview.inner().cast();
            let completion = RcBlock::new(move |image: *mut NSImage, error: *mut NSError| {
                let result = if !error.is_null() {
                    Err("WKWebView screenshot failed".to_string())
                } else if image.is_null() {
                    Err("WKWebView returned an empty screenshot".to_string())
                } else {
                    let image = &*image;
                    image
                        .TIFFRepresentation()
                        .ok_or_else(|| "screenshot TIFF encoding failed".to_string())
                        .and_then(|tiff| {
                            NSBitmapImageRep::imageRepWithData(&tiff)
                                .ok_or_else(|| "screenshot bitmap conversion failed".to_string())
                        })
                        .and_then(|bitmap| {
                            let properties =
                                NSDictionary::<NSBitmapImageRepPropertyKey, AnyObject>::new();
                            bitmap
                                .representationUsingType_properties(
                                    NSBitmapImageFileType::PNG,
                                    &properties,
                                )
                                .ok_or_else(|| "screenshot PNG encoding failed".to_string())
                        })
                        .map(|png| BASE64_STANDARD.encode(png.to_vec()))
                };
                let _ = sender.send(result);
            });
            view.takeSnapshotWithConfiguration_completionHandler(None, &completion);
        })
        .map_err(to_string)?;

    tauri::async_runtime::spawn_blocking(move || {
        receiver
            .recv_timeout(Duration::from_secs(10))
            .map_err(|_| "WKWebView screenshot timed out".to_string())?
    })
    .await
    .map_err(to_string)?
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
async fn capture_screenshot_png(_app: AppHandle) -> CommandResult<String> {
    Err("native screenshots are not supported on this platform".to_string())
}

#[cfg(test)]
mod screenshot_tests {
    use super::*;

    fn request(
        previous_path: Option<&str>,
        session_name: Option<&str>,
        connected_device_name: Option<&str>,
    ) -> ScreenshotPathRequest {
        ScreenshotPathRequest {
            connected_device_name: connected_device_name.map(str::to_string),
            previous_path: previous_path.map(str::to_string),
            session_name: session_name.map(str::to_string),
        }
    }

    #[test]
    fn screenshot_path_matches_logic_derived_name_rules() {
        let home = Path::new("/Users/tester");
        assert_eq!(
            next_screenshot_path_with_exists(
                home,
                &request(None, Some("Session 1"), Some("Logic Pro 8")),
                |_| false,
            ),
            home.join("Logic Pro 8.png")
        );
        assert_eq!(
            next_screenshot_path_with_exists(
                home,
                &request(None, Some("powertrain"), Some("Logic Pro 8")),
                |_| false,
            ),
            home.join("powertrain.png")
        );
    }

    #[test]
    fn screenshot_path_preserves_custom_names_and_increments_existing_files() {
        let home = Path::new("/Users/tester");
        assert_eq!(
            next_screenshot_path_with_exists(
                home,
                &request(
                    Some("/tmp/custom_4.jpeg"),
                    Some("Session 2"),
                    Some("PXLogic U2"),
                ),
                |path| path == Path::new("/tmp/custom_4.jpeg"),
            ),
            PathBuf::from("/tmp/custom_5.jpeg")
        );
    }

    #[test]
    fn screenshot_path_preserves_the_previous_name_when_the_device_changes() {
        let home = Path::new("/Users/tester");
        assert_eq!(
            next_screenshot_path_with_exists(
                home,
                &request(
                    Some("/Users/tester/Logic Pro 8_2.png"),
                    Some("Session 3"),
                    Some("PXLogic U2"),
                ),
                |_| false,
            ),
            PathBuf::from("/Users/tester/Logic Pro 8_2.png")
        );
    }

    #[test]
    fn screenshot_writer_decodes_data_urls_and_rejects_unknown_extensions() {
        let path = std::env::temp_dir().join(format!(
            "sigpilot-screenshot-{}-{}.png",
            std::process::id(),
            std::thread::current().name().unwrap_or("test")
        ));
        write_screenshot_file(WriteScreenshotRequest {
            data_base64: "data:image/png;base64,c25hcHNob3Q=".to_string(),
            path: path.to_string_lossy().to_string(),
        })
        .expect("valid screenshot data should be written");
        assert_eq!(
            fs::read(&path).expect("screenshot file should exist"),
            b"snapshot"
        );
        fs::remove_file(&path).expect("temporary screenshot should be removable");

        assert!(write_screenshot_file(WriteScreenshotRequest {
            data_base64: "c25hcHNob3Q=".to_string(),
            path: path.with_extension("txt").to_string_lossy().to_string(),
        })
        .is_err());
    }

    #[test]
    fn analyzer_text_writer_allows_csv_and_txt_only() {
        let path = std::env::temp_dir().join(format!(
            "sigpilot-analyzer-export-{}-{}.csv",
            std::process::id(),
            std::thread::current().name().unwrap_or("test")
        ));
        write_text_file(WriteTextFileRequest {
            contents: "Type,Value\nData,0x5A\n".to_string(),
            path: path.to_string_lossy().to_string(),
        })
        .expect("valid analyzer export should be written");
        assert_eq!(
            fs::read_to_string(&path).expect("analyzer export should exist"),
            "Type,Value\nData,0x5A\n"
        );
        fs::remove_file(&path).expect("temporary analyzer export should be removable");

        assert!(write_text_file(WriteTextFileRequest {
            contents: "not html".to_string(),
            path: path.with_extension("html").to_string_lossy().to_string(),
        })
        .is_err());
    }
}

#[tauri::command]
async fn get_waveform_tile(
    session_id: String,
    request: WaveformRequest,
    state: State<'_, AppState>,
) -> CommandResult<WaveformTile> {
    let session = state.existing_session(&session_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        session
            .render_frame(&GraphFrameRequest {
                frame_id: 0,
                waveform: request,
                include_tile: true,
                analyzer_view: None,
                analyzers: Vec::new(),
                view: None,
            })
            .map(|frame| frame.tile)
            .map_err(to_string)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn nearest_digital_transition(
    session_id: String,
    request: NearestDigitalTransitionRequest,
    state: State<'_, AppState>,
) -> CommandResult<Option<NearestDigitalTransition>> {
    let session = state.existing_session(&session_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        session
            .nearest_transition(request.channel, request.sample)
            .map_err(to_string)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn measure_digital_point(
    session_id: String,
    request: DigitalPointMeasurementRequest,
    state: State<'_, AppState>,
) -> CommandResult<Option<DigitalPointMeasurement>> {
    let session = state.existing_session(&session_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        session
            .measure_point(request.channel, request.sample)
            .map_err(to_string)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn measure_digital_range(
    session_id: String,
    request: DigitalRangeMeasurementRequest,
    state: State<'_, AppState>,
) -> CommandResult<DigitalRangeMeasurementStats> {
    let capture = state
        .existing_session(&session_id)?
        .capture()
        .ok_or_else(|| "no capture is loaded".to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        sigpilot_waveform::measure_digital_range(&capture, &request).map_err(to_string)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn decode_analyzer_frames(
    session_id: String,
    backend: DecoderBackendKind,
    settings: AnalyzerDecodeSettings,
    state: State<'_, AppState>,
) -> CommandResult<Vec<DecodedFrame>> {
    let session = state.existing_session(&session_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        session
            .decode_frames_with_backend(&settings, backend)
            .map(|frames| frames.as_ref().clone())
            .map_err(to_string)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn decode_analyzer_frame_batch(
    session_id: String,
    requests: Vec<AnalyzerDecodeBatchRequest>,
    state: State<'_, AppState>,
) -> CommandResult<Vec<AnalyzerDecodeBatchResult>> {
    let session = state.existing_session(&session_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        decode_analyzer_batch_for_session(session, requests)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn decode_analyzer_frame_batch_summary(
    session_id: String,
    requests: Vec<AnalyzerDecodeBatchRequest>,
    state: State<'_, AppState>,
) -> CommandResult<Vec<AnalyzerDecodeBatchSummaryResult>> {
    let session = state.existing_session(&session_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        decode_analyzer_batch_summary_for_session(session, requests)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn decode_saleae_analyzer_background_step(
    session_id: String,
    requests: Vec<AnalyzerDecodeBatchRequest>,
    state: State<'_, AppState>,
) -> CommandResult<Vec<AnalyzerDecodeBackgroundProgressResult>> {
    if requests
        .iter()
        .any(|request| request.backend != DecoderBackendKind::SaleaeNative)
    {
        return Err("background decoder steps currently support Saleae Native only".to_string());
    }
    let session = state.existing_session(&session_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let settings = requests
            .iter()
            .map(|request| request.settings.clone())
            .collect::<Vec<_>>();
        let progress = session
            .decode_saleae_native_background_step_batch(&settings)
            .map_err(to_string)?;
        if progress.len() != requests.len() {
            return Err(format!(
                "Saleae background decode returned {} results for {} requests",
                progress.len(),
                requests.len()
            ));
        }
        Ok(requests
            .into_iter()
            .zip(progress)
            .map(
                |(request, progress): (
                    AnalyzerDecodeBatchRequest,
                    NativeAnalyzerDecodeProgress,
                )| {
                    AnalyzerDecodeBackgroundProgressResult {
                        analyzer_id: request.analyzer_id,
                        frame_count: progress.frame_count,
                        processed_edges: progress.processed_edges,
                        total_edges: progress.total_edges,
                        progress: progress.progress,
                        complete: progress.complete,
                        cancelled: progress.cancelled,
                    }
                },
            )
            .collect())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn decode_analyzer_frame_slice(
    session_id: String,
    request: AnalyzerDecodeFrameSliceRequest,
    state: State<'_, AppState>,
) -> CommandResult<AnalyzerDecodeFrameSliceResult> {
    let session = state.existing_session(&session_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let (frame_count, frames) = session
            .decode_frame_slice_with_backend(
                &request.settings,
                request.backend,
                request.start,
                request.end,
            )
            .map_err(to_string)?;
        Ok(AnalyzerDecodeFrameSliceResult {
            frame_count,
            frames,
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn decode_analyzer_frame_table_window(
    session_id: String,
    requests: Vec<AnalyzerFrameTableRequest>,
    start: usize,
    end: usize,
    state: State<'_, AppState>,
) -> CommandResult<AnalyzerFrameTableWindow> {
    let session = state.existing_session(&session_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        session
            .decode_frame_table_window(&requests, start, end)
            .map_err(to_string)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn decode_analyzer_frame_table_search_window(
    session_id: String,
    requests: Vec<AnalyzerFrameTableRequest>,
    query: String,
    start: usize,
    end: usize,
    state: State<'_, AppState>,
) -> CommandResult<AnalyzerFrameTableWindow> {
    let session = state.existing_session(&session_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        session
            .decode_frame_table_search_window(&requests, &query, start, end)
            .map_err(to_string)
    })
    .await
    .map_err(|error| error.to_string())?
}

fn decode_analyzer_batch_for_session(
    session: Arc<GraphSession>,
    requests: Vec<AnalyzerDecodeBatchRequest>,
) -> CommandResult<Vec<AnalyzerDecodeBatchResult>> {
    if requests.is_empty() {
        return Ok(Vec::new());
    }

    let mut results: Vec<Option<AnalyzerDecodeBatchResult>> = vec![None; requests.len()];
    let saleae_indices = requests
        .iter()
        .enumerate()
        .filter_map(|(index, request)| {
            (request.backend == DecoderBackendKind::SaleaeNative).then_some(index)
        })
        .collect::<Vec<_>>();

    if saleae_indices.len() > 1 {
        let settings = saleae_indices
            .iter()
            .map(|index| requests[*index].settings.clone())
            .collect::<Vec<_>>();
        let decoded = session
            .decode_saleae_native_frames_batch(&settings)
            .map_err(to_string)?;
        for (index, frames) in saleae_indices.iter().copied().zip(decoded) {
            results[index] = Some(AnalyzerDecodeBatchResult {
                analyzer_id: requests[index].analyzer_id.clone(),
                frames: frames.as_ref().clone(),
            });
        }
    }

    let remaining = requests
        .into_iter()
        .enumerate()
        .filter(|(index, _)| results[*index].is_none())
        .collect::<Vec<_>>();
    let decoded_remaining = if remaining.len() <= 1 {
        remaining
            .into_iter()
            .map(|(index, request)| {
                decode_analyzer_batch_item(&session, request).map(|result| (index, result))
            })
            .collect::<CommandResult<Vec<_>>>()?
    } else {
        remaining
            .into_par_iter()
            .map(|(index, request)| {
                decode_analyzer_batch_item(&session, request).map(|result| (index, result))
            })
            .collect::<CommandResult<Vec<_>>>()?
    };

    for (index, result) in decoded_remaining {
        results[index] = Some(result);
    }

    results
        .into_iter()
        .map(|result| result.ok_or_else(|| "analyzer batch decode omitted a result".to_string()))
        .collect()
}

fn decode_analyzer_batch_item(
    session: &GraphSession,
    request: AnalyzerDecodeBatchRequest,
) -> CommandResult<AnalyzerDecodeBatchResult> {
    let frames = session
        .decode_frames_with_backend(&request.settings, request.backend)
        .map(|frames| frames.as_ref().clone())
        .map_err(to_string)?;
    Ok(AnalyzerDecodeBatchResult {
        analyzer_id: request.analyzer_id,
        frames,
    })
}

fn decode_analyzer_batch_summary_for_session(
    session: Arc<GraphSession>,
    requests: Vec<AnalyzerDecodeBatchRequest>,
) -> CommandResult<Vec<AnalyzerDecodeBatchSummaryResult>> {
    if requests.is_empty() {
        return Ok(Vec::new());
    }

    let mut results: Vec<Option<AnalyzerDecodeBatchSummaryResult>> = vec![None; requests.len()];
    let saleae_indices = requests
        .iter()
        .enumerate()
        .filter_map(|(index, request)| {
            (request.backend == DecoderBackendKind::SaleaeNative).then_some(index)
        })
        .collect::<Vec<_>>();

    if saleae_indices.len() > 1 {
        let settings = saleae_indices
            .iter()
            .map(|index| requests[*index].settings.clone())
            .collect::<Vec<_>>();
        let decoded = session
            .decode_saleae_native_frames_batch(&settings)
            .map_err(to_string)?;
        for (index, frames) in saleae_indices.iter().copied().zip(decoded) {
            results[index] = Some(AnalyzerDecodeBatchSummaryResult {
                analyzer_id: requests[index].analyzer_id.clone(),
                frame_count: frames.len(),
            });
        }
    }

    let remaining = requests
        .into_iter()
        .enumerate()
        .filter(|(index, _)| results[*index].is_none())
        .collect::<Vec<_>>();
    let decoded_remaining = if remaining.len() <= 1 {
        remaining
            .into_iter()
            .map(|(index, request)| {
                decode_analyzer_batch_summary_item(&session, request).map(|result| (index, result))
            })
            .collect::<CommandResult<Vec<_>>>()?
    } else {
        remaining
            .into_par_iter()
            .map(|(index, request)| {
                decode_analyzer_batch_summary_item(&session, request).map(|result| (index, result))
            })
            .collect::<CommandResult<Vec<_>>>()?
    };

    for (index, result) in decoded_remaining {
        results[index] = Some(result);
    }

    results
        .into_iter()
        .map(|result| result.ok_or_else(|| "analyzer batch summary omitted a result".to_string()))
        .collect()
}

fn decode_analyzer_batch_summary_item(
    session: &GraphSession,
    request: AnalyzerDecodeBatchRequest,
) -> CommandResult<AnalyzerDecodeBatchSummaryResult> {
    let frame_count = session
        .decode_frame_count_with_backend(&request.settings, request.backend)
        .map_err(to_string)?;
    Ok(AnalyzerDecodeBatchSummaryResult {
        analyzer_id: request.analyzer_id,
        frame_count,
    })
}

#[cfg(test)]
mod analyzer_decode_batch_tests {
    use sigpilot_core::{
        capture::generate_sample_words_with_count, CaptureSettings, I2cDecodeSettings,
        SpiDecodeSettings,
    };

    use super::*;

    fn demo_session() -> Arc<GraphSession> {
        let mut settings = CaptureSettings::default();
        settings.channel_count = 16;
        let capture = generate_sample_words_with_count(&settings, 250_000, 2)
            .expect("demo capture should be generated");
        let session = Arc::new(GraphSession::default());
        session
            .begin_capture(capture.metadata.clone())
            .expect("capture should start");
        session
            .append_samples(&capture.samples)
            .expect("samples should append");
        session
    }

    #[test]
    fn analyzer_batch_decode_preserves_request_order() {
        let session = demo_session();
        let output = decode_analyzer_batch_for_session(
            session,
            vec![
                AnalyzerDecodeBatchRequest {
                    analyzer_id: "i2c-analyzer".to_string(),
                    backend: DecoderBackendKind::LegacyRust,
                    settings: AnalyzerDecodeSettings::I2c(I2cDecodeSettings::default()),
                },
                AnalyzerDecodeBatchRequest {
                    analyzer_id: "spi-analyzer".to_string(),
                    backend: DecoderBackendKind::LegacyRust,
                    settings: AnalyzerDecodeSettings::Spi(SpiDecodeSettings::default()),
                },
            ],
        )
        .expect("batch decode should succeed");

        assert_eq!(output.len(), 2);
        assert_eq!(output[0].analyzer_id, "i2c-analyzer");
        assert_eq!(output[1].analyzer_id, "spi-analyzer");
        assert!(
            output.iter().all(|result| !result.frames.is_empty()),
            "each analyzer should return decoded frames"
        );
    }

    #[test]
    fn analyzer_batch_summary_preserves_request_order_without_returning_frames() {
        let session = demo_session();
        let output = decode_analyzer_batch_summary_for_session(
            session,
            vec![
                AnalyzerDecodeBatchRequest {
                    analyzer_id: "i2c-analyzer".to_string(),
                    backend: DecoderBackendKind::LegacyRust,
                    settings: AnalyzerDecodeSettings::I2c(I2cDecodeSettings::default()),
                },
                AnalyzerDecodeBatchRequest {
                    analyzer_id: "spi-analyzer".to_string(),
                    backend: DecoderBackendKind::LegacyRust,
                    settings: AnalyzerDecodeSettings::Spi(SpiDecodeSettings::default()),
                },
            ],
        )
        .expect("batch decode summary should succeed");

        assert_eq!(output.len(), 2);
        assert_eq!(output[0].analyzer_id, "i2c-analyzer");
        assert_eq!(output[1].analyzer_id, "spi-analyzer");
        assert!(
            output.iter().all(|result| result.frame_count > 0),
            "each analyzer should report decoded frame counts"
        );
    }
}

#[cfg(test)]
mod graph_frame_ipc_tests {
    use super::*;

    #[test]
    fn graph_frame_binary_transport_separates_packed_bins_from_json() {
        let packed = vec![1, 2, 3, 4, 5, 6, 7, 8];
        let frame = GraphFrameResponse {
            frame_id: 7,
            revision: 11,
            sample_count: 128,
            view: SessionView::new(32.0, 64.0),
            data_view: SessionView::new(32.0, 64.0),
            tile: WaveformTile {
                start_sample: 32,
                sample_count: 64,
                pixels: 4,
                samples_per_pixel: 16.0,
                channels: vec![sigpilot_waveform::ChannelTile {
                    channel: 2,
                    label: "D2".to_string(),
                    bins: Vec::new(),
                    packed_bins: Some(packed.clone()),
                    segments: Vec::new(),
                    rising_edges: vec![40],
                    falling_edges: vec![48],
                    previous_transition: Some(24),
                    next_transition: Some(104),
                }],
            },
            analyzers: Vec::new(),
        };

        let encoded = encode_graph_frame_bytes(frame).unwrap();
        assert_eq!(&encoded[..5], b"PXGF1");
        let header_length = u64::from_le_bytes(encoded[5..13].try_into().unwrap()) as usize;
        let binary_start = 13 + header_length;
        let header: serde_json::Value = serde_json::from_slice(&encoded[13..binary_start]).unwrap();
        assert_eq!(header["frame_id"], 7);
        assert_eq!(header["tile"]["channels"][0]["packed_bins"]["offset"], 0);
        assert_eq!(
            header["tile"]["channels"][0]["packed_bins"]["length"],
            packed.len()
        );
        assert_eq!(&encoded[binary_start..], packed);
    }

    #[test]
    fn graph_frame_binary_transport_carries_both_viewports() {
        // Regression: the binary transport shipped `tile` and `analyzers` but
        // dropped `view` and `data_view`. The frontend's frame loop rejects a
        // response without them — it cannot draw against an undefined viewport
        // — so every frame was discarded with "frame response is missing its
        // viewport" and no waveform ever appeared.
        let frame = GraphFrameResponse {
            frame_id: 1,
            revision: 1,
            sample_count: 128,
            view: SessionView::new(32.0, 64.0),
            data_view: SessionView::new(16.0, 64.0),
            tile: WaveformTile {
                start_sample: 0,
                sample_count: 128,
                pixels: 4,
                samples_per_pixel: 32.0,
                channels: Vec::new(),
            },
            analyzers: Vec::new(),
        };

        let encoded = encode_graph_frame_bytes(frame).unwrap();
        let header_length = u64::from_le_bytes(encoded[5..13].try_into().unwrap()) as usize;
        let header: serde_json::Value =
            serde_json::from_slice(&encoded[13..13 + header_length]).unwrap();

        assert!(
            header.get("view").is_some_and(|view| !view.is_null()),
            "binary frame response must carry the authoritative viewport"
        );
        assert!(
            header.get("data_view").is_some_and(|view| !view.is_null()),
            "binary frame response must carry the data viewport"
        );
        // The two are distinct on purpose: the frame loop stretches the gap
        // between them while a gesture is in flight.
        assert_ne!(header["view"], header["data_view"]);
    }
}

#[tauri::command]
async fn sigrok_decoder_catalog() -> CommandResult<SigrokDecoderCatalog> {
    tauri::async_runtime::spawn_blocking(move || {
        SigrokNativeDecoder::from_env_cached()
            .and_then(|decoder| decoder.decoder_catalog())
            .map_err(to_string)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn saleae_decoder_catalog() -> CommandResult<SigrokDecoderCatalog> {
    tauri::async_runtime::spawn_blocking(move || {
        let decoder = SaleaeNativeDecoder::from_env_cached().map_err(to_string)?;
        let catalog = decoder.decoder_catalog().map_err(to_string)?;
        warm_saleae_native_sidecar_async(Some(decoder), Duration::ZERO);
        Ok(catalog)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn render_graph_frame(
    session_id: String,
    request: GraphFrameRequest,
    state: State<'_, AppState>,
) -> CommandResult<tauri::ipc::Response> {
    let session = state.existing_session(&session_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        session
            .render_frame(&request)
            .map_err(to_string)
            .and_then(encode_graph_frame_response)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
fn release_graph_session(session_id: String, state: State<'_, AppState>) -> CommandResult<()> {
    state.sessions.write().remove(&session_id);
    Ok(())
}

/// Applies a gesture to the session viewport and returns the authoritative
/// result. This is the entry point for every viewport change that is not already
/// carried by a frame request: zoom to fit, jump to an edge, and scrollbar drags.
#[tauri::command]
fn apply_graph_view_intent(
    session_id: String,
    intent: ViewIntent,
    state: State<'_, AppState>,
) -> CommandResult<SessionView> {
    let session = state.existing_session(&session_id)?;
    Ok(session.apply_view_intent(&intent))
}

/// Tells the session how to clamp viewports. `total_samples` is not part of this
/// because the backend reads it from the capture itself.
#[tauri::command]
fn set_graph_view_limits(
    session_id: String,
    limits: ViewLimits,
    state: State<'_, AppState>,
) -> CommandResult<SessionView> {
    let session = state.existing_session(&session_id)?;
    session.set_view_limits(limits);
    // Re-normalize the current viewport against the new limits so a capture that
    // grew or a mode that changed cannot leave a stale view in place.
    let current = session.session_view();
    Ok(session.set_session_view(current.start_sample, current.samples))
}

#[tauri::command]
fn read_extension_package(path: String) -> CommandResult<ExtensionPackage> {
    let manifest_path = PathBuf::from(&path);
    let contents = fs::read_to_string(&manifest_path).map_err(to_string)?;
    let manifest = serde_json::from_str(&contents).map_err(to_string)?;
    let readme = read_extension_readme(&manifest_path);
    Ok(ExtensionPackage {
        manifest,
        path,
        readme,
    })
}

#[tauri::command]
fn create_extension_template(request: ExtensionTemplateRequest) -> CommandResult<ExtensionPackage> {
    let directory = PathBuf::from(&request.path);
    if directory.exists() {
        return Err("the extension directory already exists; choose a new location".to_string());
    }
    fs::create_dir_all(&directory).map_err(to_string)?;

    let parsed_name = directory
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("My Extension");
    let title = if request.name.trim().is_empty() {
        parsed_name.to_string()
    } else {
        request.name.trim().to_string()
    };
    let author = if request.author.trim().is_empty() {
        "shy coder".to_string()
    } else {
        request.author.trim().to_string()
    };
    let entry_point = match request.extension_type.as_str() {
        "HighLevelAnalyzer" => "HighLevelAnalyzer.Hla".to_string(),
        "DigitalMeasurement" => "DigitalMeasurement.MyDigitalMeasurer".to_string(),
        "AnalogMeasurement" => "AnalogMeasurement.MyAnalogMeasurer".to_string(),
        other => return Err(format!("unsupported extension type: {other}")),
    };
    let feature = if request.extension_type == "HighLevelAnalyzer" {
        serde_json::json!({
            "type": request.extension_type,
            "entryPoint": entry_point,
        })
    } else {
        serde_json::json!({
            "type": request.extension_type,
            "entryPoint": entry_point,
            "metrics": {
                "metricKey": {
                    "name": "<metric_name>",
                    "notation": "<short_notation>"
                }
            }
        })
    };
    let manifest = serde_json::json!({
        "name": title,
        "apiVersion": "1.0.0",
        "author": author,
        "version": "0.0.1",
        "description": request.description,
        "extensions": {
            title.clone(): feature
        }
    });

    let manifest_path = directory.join("extension.json");
    let readme_path = directory.join("README.md");
    let python_path = directory.join(format!("{}.py", request.extension_type));
    let readme = format!(
        "# {title}\n\n## Getting started\n\n1. Update the generated Python entry point for your needs.\n2. Test the extension in SigPilot.\n3. Update this README.\n4. Publish the extension when it is ready.\n"
    );
    let python = extension_python_template(&request.extension_type)?;
    fs::write(
        &manifest_path,
        serde_json::to_string_pretty(&manifest).map_err(to_string)?,
    )
    .map_err(to_string)?;
    fs::write(&readme_path, &readme).map_err(to_string)?;
    fs::write(python_path, python).map_err(to_string)?;

    Ok(ExtensionPackage {
        manifest,
        path: manifest_path.to_string_lossy().to_string(),
        readme: Some(readme),
    })
}

fn read_extension_readme(manifest_path: &Path) -> Option<String> {
    let directory = manifest_path.parent()?;
    ["README.md", "readme.md", "Readme.md"]
        .iter()
        .find_map(|name| fs::read_to_string(directory.join(name)).ok())
}

fn extension_python_template(extension_type: &str) -> CommandResult<&'static str> {
    match extension_type {
        "HighLevelAnalyzer" => Ok(
            "from saleae.analyzers import HighLevelAnalyzer, AnalyzerFrame\n\n\nclass Hla(HighLevelAnalyzer):\n    result_types = {\"frame\": {\"format\": \"{{data.value}}\"}}\n\n    def decode(self, frame: AnalyzerFrame):\n        return AnalyzerFrame(\"frame\", frame.start_time, frame.end_time, {\"value\": frame.type})\n",
        ),
        "DigitalMeasurement" => Ok(
            "class MyDigitalMeasurer:\n    def __init__(self, requested_measurements):\n        self.requested_measurements = requested_measurements\n\n    def process_data(self, data):\n        pass\n\n    def measure(self):\n        return {\"metricKey\": 0}\n",
        ),
        "AnalogMeasurement" => Ok(
            "class MyAnalogMeasurer:\n    def __init__(self, requested_measurements):\n        self.requested_measurements = requested_measurements\n\n    def process_data(self, data):\n        pass\n\n    def measure(self):\n        return {\"metricKey\": 0}\n",
        ),
        other => Err(format!("unsupported extension type: {other}")),
    }
}

fn to_string(error: impl std::fmt::Display) -> String {
    error.to_string()
}

fn set_bundled_path(name: &str, path: PathBuf, directory: bool) {
    let exists = if directory {
        path.is_dir()
    } else {
        path.is_file()
    };
    if exists && std::env::var_os(name).is_none() {
        std::env::set_var(name, path);
    }
}

fn configure_bundled_resources(app: &tauri::App) -> tauri::Result<()> {
    let resource_dir = app.path().resource_dir()?.join("resources");
    let bundled_native_dir = resource_dir.join("native");
    #[cfg(debug_assertions)]
    let native_dir = {
        let workspace_native_dir =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../resources/native");
        if workspace_native_dir.is_dir() {
            workspace_native_dir
        } else {
            bundled_native_dir
        }
    };
    #[cfg(not(debug_assertions))]
    let native_dir = bundled_native_dir;
    let sigrok_dir = native_dir.join("sigrok-analyzer-sidecar");
    #[cfg(target_os = "windows")]
    let sigrok_executable = "sigpilot-sigrok-sidecar.exe";
    #[cfg(not(target_os = "windows"))]
    let sigrok_executable = "sigpilot-sigrok-sidecar";

    set_bundled_path(
        "SIGPILOT_BITSTREAM_DIR",
        resource_dir.join("bitstreams"),
        true,
    );
    set_bundled_path(
        "SIGPILOT_SIGROK_SIDECAR",
        sigrok_dir.join(sigrok_executable),
        false,
    );
    set_bundled_path(
        "SIGPILOT_SIGROK_DECODER_ROOT",
        sigrok_dir.join("decoders/c_decoders"),
        true,
    );
    set_bundled_path(
        "SIGPILOT_SIGROK_PYTHON_DECODER_ROOT",
        sigrok_dir.join("decoders/python_decoders"),
        true,
    );

    #[cfg(windows)]
    let saleae_executable = "sigpilot-saleae-analyzer-sidecar.exe";
    #[cfg(not(windows))]
    let saleae_executable = "sigpilot-saleae-analyzer-sidecar";
    set_bundled_path(
        "SIGPILOT_SALEAE_SIDECAR",
        native_dir
            .join("saleae-analyzer-sidecar")
            .join(saleae_executable),
        false,
    );
    set_bundled_path(
        "SIGPILOT_SALEAE_RUNTIME_ROOT",
        native_dir.join("saleae-analyzer-sidecar").join("runtime"),
        true,
    );
    Ok(())
}

fn warm_saleae_native_sidecar_async(decoder: Option<SaleaeNativeDecoder>, delay: Duration) {
    let _ = std::thread::Builder::new()
        .name("saleae-native-warmup".to_string())
        .spawn(move || {
            if !delay.is_zero() {
                std::thread::sleep(delay);
            }
            let decoder = match decoder {
                Some(decoder) => Ok(decoder),
                None => SaleaeNativeDecoder::from_env_cached(),
            };
            match decoder {
                Ok(decoder) => {
                    let _ = decoder.decoder_catalog();
                    decoder.warm_persistent_pool();
                }
                Err(error) => {
                    tracing::debug!(
                        target: "sigpilot::decoder_performance",
                        component = "tauri",
                        stage = "saleae_native_warmup_unavailable",
                        detail = %error
                    );
                }
            }
        });
}

fn warm_sigrok_native_catalog_async(delay: Duration) {
    let _ = std::thread::Builder::new()
        .name("sigrok-native-warmup".to_string())
        .spawn(move || {
            if !delay.is_zero() {
                std::thread::sleep(delay);
            }
            match SigrokNativeDecoder::from_env_cached() {
                Ok(decoder) => {
                    let _ = decoder.decoder_catalog();
                }
                Err(error) => {
                    tracing::debug!(
                        target: "sigpilot::decoder_performance",
                        component = "tauri",
                        stage = "sigrok_native_warmup_unavailable",
                        detail = %error
                    );
                }
            }
        });
}

mod logging;

fn main() {
    // Install the log sink before anything else, so a failure during start-up
    // is recorded too. Losing logs is much better than losing the app, so a
    // failure here is not fatal.
    match logging::init() {
        Some(path) => tracing::info!("SigPilot starting, log file {}", path.display()),
        None => tracing::warn!(
            "SigPilot starting without a log file; set SIGPILOT_LOG to control the level"
        ),
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            configure_bundled_resources(app)?;
            warm_saleae_native_sidecar_async(None, Duration::from_millis(350));
            warm_sigrok_native_catalog_async(Duration::from_millis(350));
            Ok(())
        })
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            frontend_log,
            list_devices,
            device_capabilities,
            prepare_device,
            configure_pwm,
            start_capture,
            cancel_capture,
            open_capture,
            save_capture,
            export_capture,
            trim_capture,
            capture_screenshot_png,
            next_screenshot_path,
            write_screenshot_file,
            write_text_file,
            get_waveform_tile,
            nearest_digital_transition,
            measure_digital_point,
            render_graph_frame,
            measure_digital_range,
            decode_analyzer_frames,
            decode_analyzer_frame_batch,
            decode_analyzer_frame_batch_summary,
            decode_saleae_analyzer_background_step,
            decode_analyzer_frame_slice,
            decode_analyzer_frame_table_window,
            decode_analyzer_frame_table_search_window,
            saleae_decoder_catalog,
            sigrok_decoder_catalog,
            release_graph_session,
            apply_graph_view_intent,
            set_graph_view_limits,
            read_extension_package,
            create_extension_template,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run SigPilot");
}
