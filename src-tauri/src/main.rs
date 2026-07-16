use std::{
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
use serde::Serialize;
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
            get_waveform_tile,
            decode_uart_frames,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run PXLogic Studio");
}
