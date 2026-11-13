use sigpilot_terminal::{SessionInfo, TerminalManager, TerminalOutput};
use std::sync::Arc;
use tauri::{Manager, State};

#[derive(Default)]
pub struct TerminalState(pub Arc<TerminalManager>);

#[tauri::command]
pub async fn terminal_open(
    app: tauri::AppHandle,
    state: State<'_, TerminalState>,
    cols: u16,
    rows: u16,
) -> Result<SessionInfo, String> {
    let cwd = app.path().home_dir().map_err(|e| e.to_string())?;
    let manager = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || manager.open(&cwd, cols, rows))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn terminal_poll(
    state: State<'_, TerminalState>,
    id: String,
) -> Result<TerminalOutput, String> {
    state.0.poll(&id)
}

#[tauri::command]
pub async fn terminal_write(
    state: State<'_, TerminalState>,
    id: String,
    data: String,
) -> Result<(), String> {
    let manager = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || manager.write(&id, data.as_bytes()))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn terminal_resize(
    state: State<'_, TerminalState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    state.0.resize(&id, cols, rows)
}

#[tauri::command]
pub async fn terminal_close(state: State<'_, TerminalState>, id: String) -> Result<(), String> {
    let manager = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || manager.close(&id))
        .await
        .map_err(|e| e.to_string())?
}
