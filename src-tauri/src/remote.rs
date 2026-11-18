use crate::{AppState, CommandResult};
use serde::Serialize;
use sigpilot_remote::{Asset, CaptureController, CaptureFuture, RemoteServer, Settings, Status};
use std::{path::PathBuf, sync::Arc};
use tauri::{AppHandle, Manager, State};

#[derive(Default)]
pub struct RemoteState(pub tokio::sync::Mutex<Option<RemoteServer>>);
struct DesktopController(AppHandle);
impl CaptureController for DesktopController {
    fn devices(&self) -> Result<Vec<sigpilot_core::DeviceInfo>, String> {
        Ok(self.0.state::<AppState>().devices.list_devices())
    }
    fn capabilities(&self, id: &str) -> Result<sigpilot_core::HardwareCaptureCapabilities, String> {
        self.0
            .state::<AppState>()
            .devices
            .capabilities(id)
            .map_err(|e| e.to_string())
    }
    fn start(
        &self,
        id: String,
        settings: sigpilot_core::CaptureSettings,
        analyzers: Vec<sigpilot_core::AnalyzerDecodeSettings>,
    ) -> CaptureFuture {
        let app = self.0.clone();
        Box::pin(async move {
            let demo = analyzers
                .into_iter()
                .map(|settings| sigpilot_core::DemoAnalyzerSettings {
                    backend: sigpilot_core::DecoderBackendKind::Auto,
                    settings,
                })
                .collect();
            let summary = crate::start_capture(
                app.clone(),
                app.state::<AppState>(),
                id,
                settings,
                Some(demo),
            )
            .await?;
            serde_json::to_value(summary).map_err(|e| e.to_string())
        })
    }
    fn cancel(&self, id: &str) -> Result<(), String> {
        let state = self.0.state::<AppState>();
        let active = state.active_capture.lock();
        if !active.as_ref().is_some_and(|a| a.session_id == id) {
            return Err("This remote capture is not active; refresh its status".into());
        }
        state
            .cancel
            .store(true, std::sync::atomic::Ordering::Release);
        Ok(())
    }
}
fn directory(app: &AppHandle) -> CommandResult<PathBuf> {
    app.path()
        .app_data_dir()
        .map(|p| p.join("remote-workbench"))
        .map_err(|e| e.to_string())
}
fn settings(app: &AppHandle) -> Settings {
    directory(app)
        .ok()
        .and_then(|p| std::fs::read(p.join("settings.json")).ok())
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}
fn lan_url(port: u16) -> Option<String> {
    let socket = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("192.0.2.1:9").ok()?;
    let ip = socket.local_addr().ok()?.ip();
    if ip.is_unspecified() || ip.is_loopback() {
        return None;
    }
    Some(format!("http://{ip}:{port}"))
}
#[derive(Serialize)]
pub struct Setup {
    status: Status,
    suggested_lan_url: Option<String>,
}
#[tauri::command]
pub async fn remote_setup(app: AppHandle, state: State<'_, RemoteState>) -> CommandResult<Setup> {
    let current = state.0.lock().await;
    let status = current
        .as_ref()
        .map(RemoteServer::status)
        .unwrap_or_else(|| Status {
            settings: settings(&app),
            ..Status::default()
        });
    Ok(Setup {
        suggested_lan_url: lan_url(status.settings.port),
        status,
    })
}
#[tauri::command]
pub async fn configure_remote(
    app: AppHandle,
    state: State<'_, RemoteState>,
    enabled: bool,
    settings: Settings,
) -> CommandResult<Status> {
    let mut current = state.0.lock().await;
    if let Some(server) = current.take() {
        server.stop().await;
    }
    let directory = directory(&app)?;
    std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    if enabled {
        let assets_app = app.clone();
        let assets = Arc::new(move |path: &str| {
            assets_app
                .asset_resolver()
                .get(path.to_string())
                .map(|a| Asset {
                    bytes: a.bytes,
                    mime: a.mime_type,
                })
        });
        let workbench = app.state::<AppState>().workbench.clone();
        let events = app.state::<AppState>().remote_events.clone();
        *current = Some(
            RemoteServer::start(
                workbench,
                Arc::new(DesktopController(app)),
                events,
                settings.clone(),
                directory.clone(),
                assets,
            )
            .await
            .map_err(|e| e.to_string())?,
        );
    }
    std::fs::write(
        directory.join("settings.json"),
        serde_json::to_vec(&settings).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    Ok(current
        .as_ref()
        .map(RemoteServer::status)
        .unwrap_or_else(|| Status {
            settings,
            ..Status::default()
        }))
}
#[tauri::command]
pub async fn revoke_remote_client(
    state: State<'_, RemoteState>,
    client_id: String,
) -> CommandResult<()> {
    if let Some(server) = state.0.lock().await.as_ref() {
        server.revoke(&client_id);
    }
    Ok(())
}
