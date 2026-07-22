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

use parking_lot::{Mutex, RwLock};
use pxlogic_core::{
    AnalyzerDecodeSettings, CaptureBackend, CaptureData, CaptureMetadata, CaptureProgress,
    CaptureSettings, DecodedFrame, DeviceInfo, DiagnosticEvent, DiagnosticLevel, ExportFormat,
    FakeBackend,
};
use pxlogic_graph::{GraphFrameRequest, GraphFrameResponse, GraphSession};
use pxlogic_waveform::{
    DigitalRangeMeasurementRequest, DigitalRangeMeasurementStats, WaveformRequest, WaveformTile,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

#[cfg(feature = "rusb-transport")]
use pxlogic_core::RusbBackend;

type CommandResult<T> = Result<T, String>;

#[derive(Clone, Default)]
struct AppState {
    sessions: Arc<RwLock<HashMap<String, Arc<GraphSession>>>>,
    cancel: Arc<AtomicBool>,
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
}

#[derive(Debug, Clone, Serialize)]
struct CaptureSummary {
    metadata: CaptureMetadata,
    bytes: usize,
}

#[derive(Debug, Clone, Serialize)]
struct CaptureUpdatedEvent {
    session_id: String,
    summary: CaptureSummary,
}

#[derive(Debug, Clone, Deserialize)]
struct TrimCaptureRequest {
    trim_before_sample: Option<u64>,
    trim_after_sample: Option<u64>,
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
fn prepare_device(device_id: String) -> CommandResult<()> {
    if device_id == FakeBackend::DEVICE_ID {
        return FakeBackend::default()
            .prepare_device(&device_id, None)
            .map_err(to_string);
    }

    #[cfg(feature = "rusb-transport")]
    {
        let real = RusbBackend::default();
        let bitstreams = RusbBackend::load_bitstreams().map_err(to_string)?;
        return real
            .prepare_device(&device_id, bitstreams.as_ref())
            .map_err(to_string);
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
) -> CommandResult<CaptureSummary> {
    state.cancel.store(false, Ordering::Release);
    let cancel = state.cancel.clone();
    let graph = state.session(&session_id);

    let result = tauri::async_runtime::spawn_blocking(move || {
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

        let capture = if settings.device_id == FakeBackend::DEVICE_ID {
            FakeBackend::default().capture_streaming(
                &settings,
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
                match RusbBackend::load_bitstreams() {
                    Ok(bitstreams) => match real.prepare_device_with_trace(
                        &settings.device_id,
                        bitstreams.as_ref(),
                        &mut diagnostics,
                    ) {
                        Ok(()) => real.capture_with_trace_streaming(
                            &settings,
                            &cancel,
                            &mut progress,
                            &mut diagnostics,
                            &mut started,
                            &mut samples,
                        ),
                        Err(error) => Err(error),
                    },
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
fn cancel_capture(state: State<'_, AppState>) -> CommandResult<()> {
    state.cancel.store(true, Ordering::Release);
    Ok(())
}

#[tauri::command]
fn open_capture(
    session_id: String,
    path: String,
    state: State<'_, AppState>,
) -> CommandResult<CaptureSummary> {
    let capture = pxlogic_file::open_pxcap(PathBuf::from(path)).map_err(to_string)?;
    let summary = CaptureSummary {
        metadata: capture.metadata.clone(),
        bytes: capture.samples.len(),
    };
    state
        .session(&session_id)
        .replace_capture(capture)
        .map_err(to_string)?;
    Ok(summary)
}

#[tauri::command]
fn save_capture(session_id: String, path: String, state: State<'_, AppState>) -> CommandResult<()> {
    let capture = state
        .existing_session(&session_id)?
        .capture()
        .ok_or_else(|| "no capture is loaded".to_string())?;
    pxlogic_file::save_pxcap(PathBuf::from(path), &capture).map_err(to_string)
}

#[tauri::command]
fn export_capture(
    session_id: String,
    path: String,
    format: ExportFormat,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    let capture = state
        .existing_session(&session_id)?
        .capture()
        .ok_or_else(|| "no capture is loaded".to_string())?;
    match format {
        ExportFormat::Pxcap => pxlogic_file::save_pxcap(PathBuf::from(path), &capture),
        ExportFormat::Sr => pxlogic_file::export_sr(PathBuf::from(path), &capture),
        ExportFormat::Vcd => pxlogic_file::export_vcd(PathBuf::from(path), &capture),
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
    settings: AnalyzerDecodeSettings,
    state: State<'_, AppState>,
) -> CommandResult<Vec<DecodedFrame>> {
    let session = state.existing_session(&session_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        session
            .decode_frames(&settings)
            .map(|frames| frames.as_ref().clone())
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

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            list_devices,
            prepare_device,
            start_capture,
            cancel_capture,
            open_capture,
            save_capture,
            export_capture,
            trim_capture,
            get_waveform_tile,
            render_graph_frame,
            measure_digital_range,
            decode_analyzer_frames,
            release_graph_session,
            read_extension_package,
            create_extension_template,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run PXLogic Studio");
}
