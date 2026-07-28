use std::{
    collections::{HashMap, HashSet},
    fs,
    path::Path,
    path::PathBuf,
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use parking_lot::{Mutex, RwLock};
use pxlogic_core::{
    build_pxview_pwm0_register_script, generic_logic_capture_capabilities,
    pxlogic_capture_capabilities_from_profile, resolve_pxlogic_device_profile,
    AnalyzerDecodeSettings, CaptureBackend, CaptureData, CaptureMetadata, CaptureProgress,
    CaptureSettings, CaptureTriggerMetadata, DecodedFrame, DecoderBackendKind, DeviceInfo,
    DeviceKind, DiagnosticEvent, DiagnosticLevel, ExportFormat, FakeBackend,
    HardwareCaptureCapabilities, PwmConfiguration, PwmSettings, PxUsbSpeed, SigrokDecoderCatalog,
    SigrokNativeDecoder, SparseCaptureData,
};
use pxlogic_graph::{GraphFrameRequest, GraphFrameResponse, GraphSession};
use pxlogic_waveform::{
    DigitalRangeMeasurementRequest, DigitalRangeMeasurementStats, WaveformRequest, WaveformTile,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

#[cfg(feature = "rusb-transport")]
use pxlogic_core::RusbBackend;

type CommandResult<T> = Result<T, String>;

#[derive(Clone, Default)]
struct AppState {
    sessions: Arc<RwLock<HashMap<String, Arc<GraphSession>>>>,
    cancel: Arc<AtomicBool>,
    active_capture: Arc<Mutex<Option<ActiveCapture>>>,
    prepared_devices: Arc<Mutex<HashSet<String>>>,
    prepare_lock: Arc<Mutex<()>>,
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

    fn forget_prepared_device(&self, device_id: &str) {
        self.prepared_devices.lock().remove(device_id);
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
    saleae_session: Option<pxlogic_file::SaleaeSessionMetadata>,
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
fn list_devices() -> CommandResult<Vec<DeviceInfo>> {
    let fake = FakeBackend::default();
    let mut devices = fake.list_devices().map_err(to_string)?;

    #[cfg(feature = "rusb-transport")]
    {
        let real = RusbBackend::default();
        if let Ok(mut usb_devices) = real.list_devices() {
            devices.append(&mut usb_devices);
        }
    }

    Ok(devices)
}

#[tauri::command]
fn device_capabilities(device_id: String) -> CommandResult<HardwareCaptureCapabilities> {
    if device_id == FakeBackend::DEVICE_ID {
        return Ok(generic_logic_capture_capabilities(
            device_id,
            "PXLogic Preview Device",
        ));
    }

    let devices = list_devices()?;
    let device = devices
        .iter()
        .find(|device| device.id == device_id)
        .ok_or_else(|| format!("device {device_id} is not currently connected"))?;
    capture_capabilities_for_device(device)
}

fn capture_capabilities_for_device(
    device: &DeviceInfo,
) -> CommandResult<HardwareCaptureCapabilities> {
    if device.kind == DeviceKind::Fake {
        return Ok(generic_logic_capture_capabilities(
            device.id.clone(),
            device
                .profile_model
                .clone()
                .unwrap_or_else(|| device.label.clone()),
        ));
    }

    let speed = px_usb_speed_from_device_info(device).ok_or_else(|| {
        format!(
            "device {} does not report a PXView-supported USB speed",
            device.id
        )
    })?;
    let profile = resolve_pxlogic_device_profile(device.vid, device.pid, speed, device.logic_mode)
        .ok_or_else(|| format!("no PXView profile matched device {}", device.id))?;
    Ok(pxlogic_capture_capabilities_from_profile(
        device.id.clone(),
        profile,
    ))
}

fn px_usb_speed_from_device_info(device: &DeviceInfo) -> Option<PxUsbSpeed> {
    match device.usb_speed.as_deref() {
        Some("high") => Some(PxUsbSpeed::High),
        Some("super" | "super-plus") => Some(PxUsbSpeed::Super),
        _ => None,
    }
}

#[cfg(feature = "rusb-transport")]
fn prepare_real_device_cached(
    state: &AppState,
    device_id: &str,
    sink: &mut dyn FnMut(DiagnosticEvent),
) -> pxlogic_core::Result<()> {
    let _prepare_guard = state.prepare_lock.lock();
    if state.prepared_devices.lock().contains(device_id) {
        sink(DiagnosticEvent {
            phase: "prepare".to_string(),
            level: DiagnosticLevel::Info,
            message: format!("FPGA already prepared for {device_id}; reusing process cache"),
        });
        return Ok(());
    }

    sink(DiagnosticEvent {
        phase: "prepare".to_string(),
        level: DiagnosticLevel::Info,
        message: format!("preparing FPGA for {device_id}"),
    });
    let result = (|| {
        let real = RusbBackend::default();
        let bitstreams = RusbBackend::load_bitstreams()?;
        real.prepare_device_with_trace(device_id, bitstreams.as_ref(), sink)
    })();
    if result.is_ok() {
        state.prepared_devices.lock().insert(device_id.to_string());
        sink(DiagnosticEvent {
            phase: "prepare".to_string(),
            level: DiagnosticLevel::Info,
            message: format!("FPGA prepared for {device_id}; future captures will skip upload"),
        });
    } else {
        state.forget_prepared_device(device_id);
    }
    result
}

#[tauri::command]
async fn prepare_device(
    app: AppHandle,
    state: State<'_, AppState>,
    device_id: String,
) -> CommandResult<()> {
    if device_id == FakeBackend::DEVICE_ID {
        return FakeBackend::default()
            .prepare_device(&device_id, None)
            .map_err(to_string);
    }

    #[cfg(feature = "rusb-transport")]
    {
        let app_state = state.inner().clone();
        return tauri::async_runtime::spawn_blocking(move || {
            let diagnostics_app = app.clone();
            let mut diagnostics = |event: DiagnosticEvent| {
                let _ = diagnostics_app.emit("usb_diagnostic", &event);
            };
            prepare_real_device_cached(&app_state, &device_id, &mut diagnostics).map_err(to_string)
        })
        .await
        .map_err(|error| error.to_string())?;
    }

    #[allow(unreachable_code)]
    Err("real USB backend is not enabled in this build".to_string())
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

    #[cfg(feature = "rusb-transport")]
    {
        let app_state = state.inner().clone();
        return tauri::async_runtime::spawn_blocking(move || {
            let real = RusbBackend::default();
            let diagnostics_app = app.clone();
            let mut diagnostics = |event: DiagnosticEvent| {
                let _ = diagnostics_app.emit("usb_diagnostic", &event);
            };
            prepare_real_device_cached(&app_state, &device_id, &mut diagnostics)
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

#[tauri::command]
async fn start_capture(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    settings: CaptureSettings,
    demo_analyzers: Option<Vec<AnalyzerDecodeSettings>>,
) -> CommandResult<CaptureSummary> {
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
        let progress_app = app.clone();
        let mut progress = |event: CaptureProgress| {
            let _ = progress_app.emit("capture_progress", &event);
        };
        let diagnostics_app = app.clone();
        let mut diagnostics = |event: DiagnosticEvent| {
            let _ = diagnostics_app.emit("usb_diagnostic", &event);
        };
        let graph_error = Arc::new(Mutex::new(None::<String>));
        let started_graph = graph.clone();
        let started_error = graph_error.clone();
        let mut started = move |metadata: &CaptureMetadata| {
            if let Err(error) = started_graph.begin_capture(metadata.clone()) {
                *started_error.lock() = Some(error.to_string());
            }
        };
        let samples_graph = graph.clone();
        let samples_error = graph_error.clone();
        let update_app = app.clone();
        let update_session_id = session_id.clone();
        let mut last_update = Instant::now()
            .checked_sub(Duration::from_secs(1))
            .unwrap_or_else(Instant::now);
        let mut samples = move |chunk: &[u8]| {
            if samples_error.lock().is_some() {
                return;
            }
            if let Err(error) = samples_graph.append_samples(chunk) {
                *samples_error.lock() = Some(error.to_string());
                return;
            }
            if last_update.elapsed() < Duration::from_millis(33) {
                return;
            }
            last_update = Instant::now();
            if let Some(metadata) = samples_graph.metadata() {
                let summary = CaptureSummary {
                    bytes: usize::try_from(metadata.sample_count)
                        .unwrap_or(usize::MAX)
                        .saturating_mul(usize::from(metadata.unitsize)),
                    metadata,
                };
                let _ = update_app.emit(
                    "capture_updated",
                    &CaptureUpdatedEvent {
                        session_id: update_session_id.clone(),
                        summary,
                    },
                );
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

        let capture = if settings.device_id == FakeBackend::DEVICE_ID {
            FakeBackend::default().capture_streaming_with_analyzers(
                &settings,
                demo_analyzers.as_deref().unwrap_or_default(),
                &cancel,
                &mut progress,
                &mut started,
                &mut samples,
            )
        } else {
            #[cfg(feature = "rusb-transport")]
            {
                let real = RusbBackend::default();
                diagnostics(DiagnosticEvent {
                    phase: "prepare".to_string(),
                    level: DiagnosticLevel::Info,
                    message: "auto prepare before capture".to_string(),
                });
                match prepare_real_device_cached(&app_state, &settings.device_id, &mut diagnostics)
                {
                    Ok(()) => real.capture_with_trace_streaming(
                        &settings,
                        &cancel,
                        &mut progress,
                        &mut diagnostics,
                        &mut started,
                        &mut samples,
                        &mut triggered,
                    ),
                    Err(error) => Err(error),
                }
            }
            #[cfg(not(feature = "rusb-transport"))]
            {
                Err(pxlogic_core::CoreError::UnsupportedDevice)
            }
        };

        match capture {
            Ok(capture) => {
                *active_capture.lock() = None;
                if let Some(error) = graph_error.lock().take() {
                    return Err(error);
                }
                let summary = CaptureSummary {
                    metadata: capture.metadata.clone(),
                    bytes: capture.samples.len(),
                };
                graph.finish_capture(capture).map_err(to_string)?;
                let _ = app.emit("capture_completed", &summary);
                Ok(summary)
            }
            Err(error) => {
                *active_capture.lock() = None;
                #[cfg(feature = "rusb-transport")]
                if settings.device_id != FakeBackend::DEVICE_ID
                    && matches!(error, pxlogic_core::CoreError::Usb(_))
                {
                    app_state.forget_prepared_device(&settings.device_id);
                }
                let message = error.to_string();
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

fn locate_saleae_runtime_root() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("PXLOGIC_SALEAE_RUNTIME_ROOT") {
        return Some(PathBuf::from(path));
    }
    saleae_runtime_root_candidates()
        .into_iter()
        .find(|path| is_saleae_graph_runtime_root(path))
}

fn saleae_runtime_root_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(current) = std::env::current_dir() {
        push_saleae_runtime_root_candidates(&mut candidates, &current);
    }
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    push_saleae_runtime_root_candidates(&mut candidates, &manifest_dir);
    if let Some(workspace_root) = manifest_dir.parent() {
        push_saleae_runtime_root_candidates(&mut candidates, workspace_root);
    }
    if let Ok(exe) = std::env::current_exe() {
        for ancestor in exe.ancestors().take(8) {
            push_saleae_runtime_root_candidates(&mut candidates, ancestor);
        }
    }
    candidates.extend([
        PathBuf::from("/Applications/Saleae Logic.app/Contents/Resources/macos-arm64"),
        PathBuf::from("/Applications/Logic 2.app/Contents/Resources/macos-arm64"),
    ]);
    if let Some(home) = std::env::var_os("HOME") {
        let home = PathBuf::from(home);
        candidates.push(home.join("Applications/Saleae Logic.app/Contents/Resources/macos-arm64"));
        candidates.push(home.join("Applications/Logic 2.app/Contents/Resources/macos-arm64"));
        candidates.push(home.join("Downloads/Saleae Logic.app/Contents/Resources/macos-arm64"));
        candidates.push(home.join("Downloads/Logic 2.app/Contents/Resources/macos-arm64"));
    }
    dedup_pathbufs(candidates)
}

fn push_saleae_runtime_root_candidates(candidates: &mut Vec<PathBuf>, base: &Path) {
    candidates.push(base.join("vendor").join("saleae-runtime-2.4.43"));
    candidates.push(
        base.join("target")
            .join("native")
            .join("saleae-runtime-2.4.43"),
    );
    candidates.push(
        base.join("resources")
            .join("native")
            .join("saleae-runtime-2.4.43"),
    );
    candidates.push(
        base.join("Resources")
            .join("resources")
            .join("native")
            .join("saleae-runtime-2.4.43"),
    );
}

fn is_saleae_graph_runtime_root(path: &Path) -> bool {
    path.join("libAnalyzer.dylib").is_file()
        && path.join("libgraph_server_shared.dylib").is_file()
        && path.join("pythonlibs/lib/python314.zip").is_file()
        && path
            .join("pythonlibs/lib/python3.14/site-packages/saleae")
            .is_dir()
        && path
            .join("pythonlibs/lib/python3.14/site-packages/numpy")
            .is_dir()
}

fn locate_saleae_graph_sidecar() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("PXLOGIC_SALEAE_GRAPH_SIDECAR") {
        return Some(PathBuf::from(path));
    }
    saleae_graph_sidecar_candidates()
        .into_iter()
        .find(|path| path.is_file())
}

fn saleae_graph_sidecar_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(current) = std::env::current_dir() {
        push_saleae_graph_sidecar_candidates(&mut candidates, &current);
    }
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    push_saleae_graph_sidecar_candidates(&mut candidates, &manifest_dir);
    if let Some(workspace_root) = manifest_dir.parent() {
        push_saleae_graph_sidecar_candidates(&mut candidates, workspace_root);
    }
    if let Ok(exe) = std::env::current_exe() {
        for ancestor in exe.ancestors().take(8) {
            push_saleae_graph_sidecar_candidates(&mut candidates, ancestor);
        }
    }
    dedup_pathbufs(candidates)
}

fn push_saleae_graph_sidecar_candidates(candidates: &mut Vec<PathBuf>, base: &Path) {
    candidates.push(
        base.join("resources")
            .join("native")
            .join("saleae-graph-sidecar")
            .join("pxlogic-saleae-graph-sidecar"),
    );
    candidates.push(
        base.join("Resources")
            .join("resources")
            .join("native")
            .join("saleae-graph-sidecar")
            .join("pxlogic-saleae-graph-sidecar"),
    );
    candidates.push(
        base.join("target")
            .join("native")
            .join("saleae-graph-sidecar")
            .join("pxlogic-saleae-graph-sidecar"),
    );
}

fn dedup_pathbufs(paths: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut deduped = Vec::new();
    for path in paths {
        if !deduped.iter().any(|existing| existing == &path) {
            deduped.push(path);
        }
    }
    deduped
}

fn convert_saleae_capture(path: &Path) -> CommandResult<PathBuf> {
    let sidecar = locate_saleae_graph_sidecar().ok_or_else(|| {
        "Saleae .sal support requires the native graph sidecar; build native/saleae-graph-sidecar/build.sh first"
            .to_string()
    })?;
    let runtime_root = locate_saleae_runtime_root().ok_or_else(|| {
        "Saleae .sal support requires the bundled GraphServer runtime; rebuild the app resources"
            .to_string()
    })?;
    let suffix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let output = std::env::temp_dir().join(format!(
        "pxlogic-saleae-sal-{}-{suffix}",
        std::process::id()
    ));
    fs::create_dir_all(&output).map_err(to_string)?;
    let result = Command::new(&sidecar)
        .arg("--runtime-root")
        .arg(runtime_root)
        .arg("--convert-sal")
        .arg(path)
        .arg(&output)
        .output()
        .map_err(|error| format!("failed to start Saleae graph sidecar: {error}"))?;
    if !result.status.success() {
        let detail = String::from_utf8_lossy(&result.stderr).trim().to_string();
        let _ = fs::remove_dir_all(&output);
        return Err(if detail.is_empty() {
            format!("Saleae .sal conversion failed with {}", result.status)
        } else {
            format!("Saleae .sal conversion failed: {detail}")
        });
    }
    if !output.join("manifest.json").is_file() {
        let _ = fs::remove_dir_all(&output);
        return Err("Saleae graph sidecar completed without a transition manifest".to_string());
    }
    Ok(output)
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
        .is_some_and(|extension| extension.eq_ignore_ascii_case("sal"))
    {
        let converted = convert_saleae_capture(&source_path)?;
        let result = pxlogic_file::open_saleae_transition_session(converted.join("manifest.json"))
            .map_err(to_string);
        let _ = fs::remove_dir_all(&converted);
        let imported = result?;
        let capture = imported.capture;
        let bytes = fs::metadata(&source_path)
            .map(|metadata| usize::try_from(metadata.len()).unwrap_or(usize::MAX))
            .unwrap_or_default();
        let summary = CaptureSummary {
            metadata: capture.metadata.clone(),
            bytes,
        };
        state
            .session(&session_id)
            .replace_sparse_capture(capture)
            .map_err(to_string)?;
        return Ok(OpenCaptureResult {
            summary,
            saleae_session: Some(imported.session),
        });
    }

    if source_path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("pxl"))
    {
        let project = pxlogic_file::open_pxl(source_path).map_err(to_string)?;
        let summary = match project.capture {
            pxlogic_file::PxlogicProjectCapture::Packed(capture) => {
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
            pxlogic_file::PxlogicProjectCapture::Sparse(capture) => {
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

    let capture = pxlogic_file::open_pxcap(source_path).map_err(to_string)?;
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
    saleae_session: Option<pxlogic_file::SaleaeSessionMetadata>,
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
            return pxlogic_file::save_pxl_packed(path, &capture, &metadata).map_err(to_string);
        }
        if let Some(capture) = session.sparse_capture() {
            return pxlogic_file::save_pxl_sparse(path, &capture, &metadata).map_err(to_string);
        }
        return Err("no capture is loaded".to_string());
    }

    let capture = session
        .capture()
        .ok_or_else(|| "this save format requires a packed capture".to_string())?;
    pxlogic_file::save_pxcap(path, &capture).map_err(to_string)
}

fn export_saleae_capture(
    session: &GraphSession,
    path: &Path,
    saleae_session: &pxlogic_file::SaleaeSessionMetadata,
) -> CommandResult<()> {
    let sidecar = locate_saleae_graph_sidecar().ok_or_else(|| {
        "Saleae .sal export requires the native graph sidecar; build native/saleae-graph-sidecar/build.sh first"
            .to_string()
    })?;
    let runtime_root = locate_saleae_runtime_root().ok_or_else(|| {
        "Saleae .sal export requires the bundled GraphServer runtime; rebuild the app resources"
            .to_string()
    })?;
    let suffix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let staging = std::env::temp_dir().join(format!(
        "pxlogic-saleae-export-{}-{suffix}",
        std::process::id()
    ));
    fs::create_dir_all(&staging).map_err(to_string)?;

    let manifest_result = if let Some(capture) = session.capture() {
        pxlogic_file::write_saleae_packed_export_manifest_with_session(
            &staging,
            &capture,
            saleae_session,
        )
    } else if let Some(capture) = session.sparse_capture() {
        pxlogic_file::write_saleae_sparse_export_manifest_with_session(
            &staging,
            &capture,
            saleae_session,
        )
    } else {
        let _ = fs::remove_dir_all(&staging);
        return Err("no capture is loaded".to_string());
    };
    let manifest = match manifest_result {
        Ok(manifest) => manifest,
        Err(error) => {
            let _ = fs::remove_dir_all(&staging);
            return Err(error.to_string());
        }
    };
    let temporary_output = staging.join("capture.sal");
    let result = Command::new(&sidecar)
        .arg("--runtime-root")
        .arg(runtime_root)
        .arg("--create-sal")
        .arg(manifest)
        .arg(&temporary_output)
        .output()
        .map_err(|error| format!("failed to start Saleae graph sidecar: {error}"));
    let result = match result {
        Ok(result) => result,
        Err(error) => {
            let _ = fs::remove_dir_all(&staging);
            return Err(error);
        }
    };
    if !result.status.success() {
        let detail = String::from_utf8_lossy(&result.stderr).trim().to_string();
        let _ = fs::remove_dir_all(&staging);
        return Err(if detail.is_empty() {
            format!("Saleae .sal export failed with {}", result.status)
        } else {
            format!("Saleae .sal export failed: {detail}")
        });
    }
    if !temporary_output.is_file() {
        let _ = fs::remove_dir_all(&staging);
        return Err("Saleae graph sidecar completed without a .sal archive".to_string());
    }
    if let Some(parent) = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        fs::create_dir_all(parent).map_err(to_string)?;
    }
    let rename_result = fs::rename(&temporary_output, path).map_err(to_string);
    let _ = fs::remove_dir_all(&staging);
    rename_result
}

#[tauri::command]
fn export_capture(
    session_id: String,
    path: String,
    format: ExportFormat,
    saleae_session: Option<pxlogic_file::SaleaeSessionMetadata>,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    let session = state.existing_session(&session_id)?;
    if format == ExportFormat::Sal {
        return export_saleae_capture(
            &session,
            Path::new(&path),
            &saleae_session.unwrap_or_default(),
        );
    }
    let capture = session
        .capture()
        .ok_or_else(|| "this export format requires a packed capture".to_string())?;
    match format {
        ExportFormat::Pxcap => pxlogic_file::save_pxcap(PathBuf::from(path), &capture),
        ExportFormat::Sr => pxlogic_file::export_sr(PathBuf::from(path), &capture),
        ExportFormat::Vcd => pxlogic_file::export_vcd(PathBuf::from(path), &capture),
        ExportFormat::Sal => unreachable!(),
    }
    .map_err(to_string)
}

#[tauri::command]
fn trim_capture(
    session_id: String,
    request: TrimCaptureRequest,
    state: State<'_, AppState>,
) -> CommandResult<CaptureSummary> {
    let session = state.existing_session(&session_id)?;
    let capture = session
        .capture()
        .ok_or_else(|| "no capture is loaded".to_string())?;
    let total_samples = capture.metadata.sample_count;
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

    let unit_size = usize::from(capture.metadata.unitsize);
    if unit_size == 0 {
        return Err("capture has invalid unit size".to_string());
    }
    let byte_start = usize::try_from(start)
        .map_err(|_| "trim start is too large".to_string())?
        .checked_mul(unit_size)
        .ok_or_else(|| "trim start byte offset overflowed".to_string())?;
    let byte_end = usize::try_from(end)
        .map_err(|_| "trim end is too large".to_string())?
        .checked_mul(unit_size)
        .ok_or_else(|| "trim end byte offset overflowed".to_string())?;
    if byte_end > capture.samples.len() || byte_start > byte_end {
        return Err("capture sample buffer is shorter than metadata".to_string());
    }

    let mut metadata = capture.metadata.clone();
    metadata.sample_count = end - start;
    metadata.trigger = metadata.trigger.and_then(|mut trigger| {
        if trigger.sample_index < start || trigger.sample_index >= end {
            return None;
        }
        trigger.sample_index -= start;
        Some(trigger)
    });
    let capture = CaptureData {
        metadata,
        samples: capture.samples[byte_start..byte_end].to_vec(),
    };
    let summary = CaptureSummary {
        metadata: capture.metadata.clone(),
        bytes: capture.samples.len(),
    };
    session.replace_capture(capture).map_err(to_string)?;

    Ok(summary)
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
            "pxlogic-screenshot-{}-{}.png",
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
            "pxlogic-analyzer-export-{}-{}.csv",
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
                analyzer_view: None,
                analyzers: Vec::new(),
            })
            .map(|frame| frame.tile)
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
        pxlogic_waveform::measure_digital_range(&capture, &request).map_err(to_string)
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
        let sample_count = session.sample_count();
        session
            .decode_frames_with_backend_for_view(
                &settings,
                backend,
                &WaveformRequest {
                    start_sample: 0,
                    sample_count,
                    pixels: 1_200,
                    channels: Vec::new(),
                },
            )
            .map(|frames| frames.as_ref().clone())
            .map_err(to_string)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn sigrok_decoder_catalog() -> CommandResult<SigrokDecoderCatalog> {
    tauri::async_runtime::spawn_blocking(move || {
        SigrokNativeDecoder::from_env()
            .and_then(|decoder| decoder.decoder_catalog())
            .map_err(to_string)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn render_graph_frame(
    session_id: String,
    request: GraphFrameRequest,
    state: State<'_, AppState>,
) -> CommandResult<GraphFrameResponse> {
    let session = state.existing_session(&session_id)?;
    tauri::async_runtime::spawn_blocking(move || session.render_frame(&request).map_err(to_string))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
fn release_graph_session(session_id: String, state: State<'_, AppState>) -> CommandResult<()> {
    state.sessions.write().remove(&session_id);
    Ok(())
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
        "# {title}\n\n## Getting started\n\n1. Update the generated Python entry point for your needs.\n2. Test the extension in PXLogic.\n3. Update this README.\n4. Publish the extension when it is ready.\n"
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
    let native_dir = resource_dir.join("native");
    let sigrok_dir = native_dir.join("sigrok-analyzer-sidecar");
    #[cfg(target_os = "windows")]
    let sigrok_executable = "pxlogic-sigrok-sidecar.exe";
    #[cfg(not(target_os = "windows"))]
    let sigrok_executable = "pxlogic-sigrok-sidecar";

    set_bundled_path(
        "PXLOGIC_BITSTREAM_DIR",
        resource_dir.join("bitstreams"),
        true,
    );
    set_bundled_path(
        "PXLOGIC_SIGROK_SIDECAR",
        sigrok_dir.join(sigrok_executable),
        false,
    );
    set_bundled_path(
        "PXLOGIC_SIGROK_DECODER_ROOT",
        sigrok_dir.join("decoders/c_decoders"),
        true,
    );
    set_bundled_path(
        "PXLOGIC_SIGROK_PYTHON_DECODER_ROOT",
        sigrok_dir.join("decoders/python_decoders"),
        true,
    );

    #[cfg(target_os = "macos")]
    {
        set_bundled_path(
            "PXLOGIC_SALEAE_SIDECAR",
            native_dir
                .join("saleae-analyzer-sidecar")
                .join("pxlogic-saleae-analyzer-sidecar"),
            false,
        );
        set_bundled_path(
            "PXLOGIC_SALEAE_GRAPH_SIDECAR",
            native_dir
                .join("saleae-graph-sidecar")
                .join("pxlogic-saleae-graph-sidecar"),
            false,
        );
        set_bundled_path(
            "PXLOGIC_SALEAE_RUNTIME_ROOT",
            native_dir.join("saleae-runtime-2.4.43"),
            true,
        );
    }
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            configure_bundled_resources(app)?;
            Ok(())
        })
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
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
            render_graph_frame,
            measure_digital_range,
            decode_analyzer_frames,
            sigrok_decoder_catalog,
            release_graph_session,
            read_extension_package,
            create_extension_template,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run PXLogic Studio");
}
