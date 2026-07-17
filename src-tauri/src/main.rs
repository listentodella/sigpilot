use std::{
    fs,
    path::Path,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

use parking_lot::Mutex;
use pxlogic_core::{
    decode_uart, CaptureBackend, CaptureData, CaptureMetadata, CaptureProgress, CaptureSettings,
    DecodedFrame, DeviceInfo, DiagnosticEvent, DiagnosticLevel, ExportFormat, FakeBackend,
    UartDecodeSettings,
};
use pxlogic_waveform::{WaveformRequest, WaveformTile};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

#[cfg(feature = "rusb-transport")]
use pxlogic_core::RusbBackend;

type CommandResult<T> = Result<T, String>;

#[derive(Clone, Default)]
struct AppState {
    current_capture: Arc<Mutex<Option<CaptureData>>>,
    cancel: Arc<AtomicBool>,
}

#[derive(Debug, Clone, Serialize)]
struct CaptureSummary {
    metadata: CaptureMetadata,
    bytes: usize,
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
    settings: CaptureSettings,
) -> CommandResult<CaptureSummary> {
    state.cancel.store(false, Ordering::Release);
    let cancel = state.cancel.clone();
    let current_capture = state.current_capture.clone();

    let result = tauri::async_runtime::spawn_blocking(move || {
        let mut progress = |event: CaptureProgress| {
            let _ = app.emit("capture_progress", &event);
        };
        let mut diagnostics = |event: DiagnosticEvent| {
            let _ = app.emit("usb_diagnostic", &event);
        };

        let capture = if settings.device_id == FakeBackend::DEVICE_ID {
            FakeBackend::default().capture(&settings, &cancel, &mut progress)
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
                        Ok(()) => real.capture_with_trace(
                            &settings,
                            &cancel,
                            &mut progress,
                            &mut diagnostics,
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
                let summary = CaptureSummary {
                    metadata: capture.metadata.clone(),
                    bytes: capture.samples.len(),
                };
                *current_capture.lock() = Some(capture);
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
fn open_capture(path: String, state: State<'_, AppState>) -> CommandResult<CaptureSummary> {
    let capture = pxlogic_file::open_pxcap(PathBuf::from(path)).map_err(to_string)?;
    let summary = CaptureSummary {
        metadata: capture.metadata.clone(),
        bytes: capture.samples.len(),
    };
    *state.current_capture.lock() = Some(capture);
    Ok(summary)
}

#[tauri::command]
fn save_capture(path: String, state: State<'_, AppState>) -> CommandResult<()> {
    let capture = state
        .current_capture
        .lock()
        .clone()
        .ok_or_else(|| "no capture is loaded".to_string())?;
    pxlogic_file::save_pxcap(PathBuf::from(path), &capture).map_err(to_string)
}

#[tauri::command]
fn export_capture(
    path: String,
    format: ExportFormat,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    let capture = state
        .current_capture
        .lock()
        .clone()
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
    request: TrimCaptureRequest,
    state: State<'_, AppState>,
) -> CommandResult<CaptureSummary> {
    let mut guard = state.current_capture.lock();
    let capture = guard
        .as_mut()
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

    capture.samples = capture.samples[byte_start..byte_end].to_vec();
    capture.metadata.sample_count = end - start;

    Ok(CaptureSummary {
        metadata: capture.metadata.clone(),
        bytes: capture.samples.len(),
    })
}

#[tauri::command]
fn get_waveform_tile(
    request: WaveformRequest,
    state: State<'_, AppState>,
) -> CommandResult<WaveformTile> {
    let capture = state
        .current_capture
        .lock()
        .clone()
        .ok_or_else(|| "no capture is loaded".to_string())?;
    pxlogic_waveform::build_tile(&capture, &request).map_err(to_string)
}

#[tauri::command]
fn decode_uart_frames(
    settings: UartDecodeSettings,
    state: State<'_, AppState>,
) -> CommandResult<Vec<DecodedFrame>> {
    let capture = state
        .current_capture
        .lock()
        .clone()
        .ok_or_else(|| "no capture is loaded".to_string())?;
    decode_uart(&capture, &settings).map_err(to_string)
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
            decode_uart_frames,
            read_extension_package,
            create_extension_template,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run PXLogic Studio");
}
