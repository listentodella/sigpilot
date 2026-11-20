//! Opt-in local desktop verification. Excluded from release builds.
//!
//! A developer launches a debug binary with an explicit local script path to
//! exercise the real WebView/PTY/IPC. No HTTP endpoint or MCP tool exposes this.
use std::sync::atomic::{AtomicBool, Ordering};

static RAN: AtomicBool = AtomicBool::new(false);

pub fn on_page_load(webview: &tauri::Webview, payload: &tauri::webview::PageLoadPayload<'_>) {
    if payload.event() != tauri::webview::PageLoadEvent::Finished {
        return;
    }
    let Some(path) = std::env::var_os("SIGPILOT_VERIFY_SCRIPT") else {
        return;
    };
    if RAN.swap(true, Ordering::AcqRel) {
        return;
    }
    let path = std::path::PathBuf::from(path);
    let result = (|| -> Result<(), String> {
        if !path.is_absolute()
            || std::fs::metadata(&path).map_err(|e| e.to_string())?.len() > 256 * 1024
        {
            return Err(
                "Verification script must be an absolute local path of at most 256 KiB".into(),
            );
        }
        let script = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
        if std::env::var_os("SIGPILOT_VERIFY_VISIBLE").is_some() {
            // Explicit QA windows may otherwise stay on another macOS Space
            // and never paint. This affects only the isolated debug launch.
            webview
                .window()
                .set_visible_on_all_workspaces(true)
                .map_err(|e| e.to_string())?;
            webview
                .window()
                .set_always_on_top(true)
                .map_err(|e| e.to_string())?;
            webview.window().show().map_err(|e| e.to_string())?;
        }
        // A background WKWebView can defer paints/animation frames. The explicit
        // local verification launch needs a visible, focused window for UI QA.
        webview.window().set_focus().map_err(|e| e.to_string())?;
        webview.eval(&script).map_err(|e| e.to_string())
    })();
    if let Err(error) = result {
        tracing::error!(%error, "desktop verification script failed");
    }
}
