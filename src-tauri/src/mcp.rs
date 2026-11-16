use super::{to_string, AppState, CommandResult};
use sigpilot_mcp::desktop::{DesktopMcpServer, DesktopMcpStatus};
use sigpilot_mcp::onboarding::{self, Preferences, SetupInfo};
use sigpilot_workbench::{
    AnnotationSource, ApplyAnnotationsRequest, ApplyAnnotationsResult, Caller, WorkbenchService,
    WorkbenchSnapshot,
};
use std::{
    sync::{mpsc::RecvTimeoutError, Arc},
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager, State};

#[tauri::command]
pub fn workbench_snapshot(
    session_id: String,
    state: State<'_, AppState>,
) -> CommandResult<WorkbenchSnapshot> {
    state
        .workbench
        .set_gui_attached(&session_id, true)
        .map_err(to_string)?;
    state.workbench.gui_snapshot(&session_id).map_err(to_string)
}

#[tauri::command]
pub fn workbench_apply_annotations(
    request: ApplyAnnotationsRequest,
    state: State<'_, AppState>,
) -> CommandResult<ApplyAnnotationsResult> {
    state
        .workbench
        .apply_annotations(
            Caller {
                id: "desktop-user",
                source: AnnotationSource::User,
            },
            &request,
        )
        .map_err(to_string)
}

#[tauri::command]
pub fn workbench_undo_annotations(
    request: sigpilot_workbench::undo::UndoAnnotationsRequest,
    state: State<'_, AppState>,
) -> CommandResult<ApplyAnnotationsResult> {
    state
        .workbench
        .undo_annotations(
            Caller {
                id: "desktop-user",
                source: AnnotationSource::User,
            },
            &request,
        )
        .map_err(to_string)
}

#[tauri::command]
pub fn workbench_replace_analyzers(
    request: sigpilot_workbench::analyzers::ReplaceAnalyzersRequest,
    state: State<'_, AppState>,
) -> CommandResult<serde_json::Value> {
    state
        .workbench
        .replace_analyzers(
            Caller {
                id: "desktop-user",
                source: AnnotationSource::User,
            },
            &request,
        )
        .map_err(to_string)
}

#[tauri::command]
pub async fn mcp_status(state: State<'_, AppState>) -> CommandResult<DesktopMcpStatus> {
    Ok(state
        .mcp
        .lock()
        .await
        .as_ref()
        .map(DesktopMcpServer::status)
        .unwrap_or_else(DesktopMcpStatus::disabled))
}

#[tauri::command]
pub async fn configure_mcp(
    enabled: bool,
    can_edit_annotations: bool,
    port: Option<u16>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<DesktopMcpStatus> {
    let mut server = state.mcp.lock().await;
    let directory = instance_directory(&app)?;
    let mut preferences = onboarding::read_preferences(&directory).map_err(to_string)?;
    preferences.port = port.unwrap_or(preferences.port);
    onboarding::validate_port(preferences.port).map_err(to_string)?;
    if !enabled {
        onboarding::save_preferences(
            &directory,
            &Preferences {
                enabled: false,
                can_edit: can_edit_annotations,
                port: preferences.port,
            },
        )
        .map_err(to_string)?;
        if let Some(old) = server.take() {
            old.stop().await;
        }
        return Ok(DesktopMcpStatus::disabled());
    }
    if let Some(existing) = server.as_ref() {
        let status = existing.status();
        if status.enabled
            && status.can_edit_annotations == can_edit_annotations
            && status.endpoint == Some(format!("http://127.0.0.1:{}/mcp", preferences.port))
        {
            return Ok(status);
        }
    }
    if let Some(old) = server.take() {
        old.stop().await;
    }
    let started = DesktopMcpServer::start_on_port(
        state.workbench.clone(),
        &directory,
        can_edit_annotations,
        preferences.port,
    )
    .await
    .map_err(to_string)?;
    onboarding::save_preferences(
        &directory,
        &Preferences {
            enabled: true,
            can_edit: can_edit_annotations,
            port: preferences.port,
        },
    )
    .map_err(to_string)?;
    let status = started.status();
    *server = Some(started);
    Ok(status)
}

fn instance_directory(app: &AppHandle) -> CommandResult<std::path::PathBuf> {
    let parent = app.path().app_local_data_dir().map_err(to_string)?;
    std::fs::create_dir_all(&parent).map_err(to_string)?;
    Ok(parent.join("mcp-instances"))
}
fn bridge_source(app: &AppHandle) -> Option<std::path::PathBuf> {
    let name = if cfg!(windows) {
        "sigpilot-mcp-bridge.exe"
    } else {
        "sigpilot-mcp-bridge"
    };
    let mut candidates = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            candidates.push(parent.join(name));
        }
    }
    if let Ok(resources) = app.path().resource_dir() {
        candidates.push(resources.join(name));
    }
    #[cfg(debug_assertions)]
    candidates.push(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join(format!(
                "sigpilot-mcp-bridge-{}{}",
                env!("SIGPILOT_TARGET"),
                if cfg!(windows) { ".exe" } else { "" }
            )),
    );
    candidates.into_iter().find(|path| {
        let Ok(m) = std::fs::metadata(path) else {
            return false;
        };
        if !m.is_file() {
            return false;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if m.permissions().mode() & 0o111 == 0 {
                return false;
            }
        }
        true
    })
}
fn bridge_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    static BRIDGE: std::sync::OnceLock<Option<std::path::PathBuf>> = std::sync::OnceLock::new();
    BRIDGE
        .get_or_init(|| {
            let source = bridge_source(app)?;
            if !cfg!(unix) {
                return Some(source);
            }
            match instance_directory(app).and_then(|directory| {
                onboarding::install_bridge(&directory, &source).map_err(to_string)
            }) {
                Ok(path) => Some(path),
                Err(error) => {
                    eprintln!("MCP bridge preparation failed: {error}");
                    None
                }
            }
        })
        .clone()
}
#[tauri::command]
pub async fn mcp_setup_info(
    app: AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<SetupInfo> {
    let server = state.mcp.lock().await;
    let status = server
        .as_ref()
        .map(DesktopMcpServer::status)
        .unwrap_or_else(DesktopMcpStatus::disabled);
    let directory = instance_directory(&app)?;
    let bridge = if cfg!(unix) { bridge_path(&app) } else { None };
    onboarding::setup_info(status, &directory, bridge).map_err(to_string)
}
#[tauri::command]
pub async fn check_mcp_connection(state: State<'_, AppState>) -> CommandResult<serde_json::Value> {
    let server = state.mcp.lock().await;
    let status = server
        .as_ref()
        .map(DesktopMcpServer::status)
        .unwrap_or_else(DesktopMcpStatus::disabled);
    if !status.enabled {
        return Err("Enable MCP before running the connection check".into());
    }
    server
        .as_ref()
        .ok_or("MCP is disabled")?
        .check_http()
        .await
        .map_err(to_string)
}
/// Launch only the known client installer; the frontend cannot supply a URL or command.
#[tauri::command]
pub async fn open_mcp_client(client_id: String, app: AppHandle) -> CommandResult<()> {
    if client_id != "cursor" {
        return Err("This client has no supported installation link".into());
    }
    let directory = instance_directory(&app)?;
    let preferences = onboarding::read_preferences(&directory).map_err(to_string)?;
    let uri =
        onboarding::http_configurations(&format!("http://127.0.0.1:{}/mcp", preferences.port))
            .into_iter()
            .find(|c| c.id == client_id)
            .and_then(|c| c.install_uri)
            .ok_or("Client installation link unavailable")?;
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::UI::Shell::ShellExecuteW;
        let operation: Vec<u16> = "open".encode_utf16().chain(Some(0)).collect();
        let uri: Vec<u16> = std::ffi::OsStr::new(&uri)
            .encode_wide()
            .chain(Some(0))
            .collect();
        let result = unsafe {
            ShellExecuteW(
                std::ptr::null_mut(),
                operation.as_ptr(),
                uri.as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                1,
            )
        };
        if result as isize <= 32 {
            return Err(
                "Could not open Cursor. Install Cursor or use manual configuration.".into(),
            );
        }
        return Ok(());
    }
    #[cfg(not(windows))]
    let mut command = tokio::process::Command::new(if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    });
    #[cfg(not(windows))]
    let output = tokio::time::timeout(
        Duration::from_secs(10),
        command.arg(uri).kill_on_drop(true).output(),
    )
    .await
    .map_err(|_| "Opening the client timed out".to_string())?
    .map_err(to_string)?;
    #[cfg(not(windows))]
    if !output.status.success() {
        return Err(format!(
            "Could not open Cursor. Install Cursor or use manual configuration. {}",
            String::from_utf8_lossy(&output.stderr)
                .chars()
                .take(512)
                .collect::<String>()
        ));
    }
    Ok(())
}
pub fn restore_mcp(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let result: CommandResult<()> = async {
            let directory = instance_directory(&app)?;
            let preferences = onboarding::read_preferences(&directory).map_err(to_string)?;
            if preferences.enabled {
                // Refresh the stable executable before agents reconnect on startup.
                if cfg!(unix) {
                    let _ = bridge_path(&app);
                }
                let state = app.state::<AppState>();
                let mut server = state.mcp.lock().await;
                // A user action may have already changed the preference.
                let current = onboarding::read_preferences(&directory).map_err(to_string)?;
                if current.enabled && server.is_none() {
                    *server = Some(
                        DesktopMcpServer::start_on_port(
                            state.workbench.clone(),
                            &directory,
                            current.can_edit,
                            current.port,
                        )
                        .await
                        .map_err(to_string)?,
                    );
                }
            }
            Ok(())
        }
        .await;
        if let Err(error) = result {
            eprintln!("MCP auto-start failed: {error}");
        }
    });
}

#[tauri::command]
pub async fn mcp_authorization_status(
    state: State<'_, AppState>,
) -> CommandResult<sigpilot_mcp::oauth::AuthorizationStatus> {
    let server = state.mcp.lock().await;
    match server.as_ref().and_then(|s| s.authorization()) {
        Some(auth) => auth.status().map_err(to_string),
        None => Ok(sigpilot_mcp::oauth::AuthorizationStatus {
            pending: vec![],
            clients: vec![],
        }),
    }
}
#[tauri::command]
pub async fn mcp_decide_authorization(
    request_id: String,
    allow: bool,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    let server = state.mcp.lock().await;
    server
        .as_ref()
        .and_then(|s| s.authorization())
        .ok_or("Enable MCP first")?
        .decide(&request_id, allow)
        .map_err(to_string)
}
#[tauri::command]
pub async fn mcp_revoke_authorization(
    grant_id: String,
    state: State<'_, AppState>,
) -> CommandResult<()> {
    let server = state.mcp.lock().await;
    server
        .as_ref()
        .and_then(|s| s.authorization())
        .ok_or("Enable MCP first")?
        .revoke(&grant_id)
        .map_err(to_string)
}

pub fn bridge_workbench_events(
    app: AppHandle,
    workbench: Arc<WorkbenchService>,
) -> std::io::Result<()> {
    let receiver = workbench.subscribe().map_err(std::io::Error::other)?;
    std::thread::Builder::new()
        .name("sigpilot-workbench-events".into())
        .spawn(move || {
            let mut receiver = receiver;
            loop {
                match receiver.recv_timeout(Duration::from_secs(1)) {
                    Ok(event) => {
                        let _ = app.emit("workbench_event", event.as_ref());
                    }
                    Err(RecvTimeoutError::Timeout) => {}
                    Err(RecvTimeoutError::Disconnected) => {
                        match workbench.subscribe() {
                            Ok(next) => receiver = next,
                            Err(_) => break,
                        }
                        let _ = app.emit("workbench_resync_required", ());
                    }
                }
            }
        })?;
    Ok(())
}
