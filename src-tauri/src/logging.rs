//! Diagnostic logging.
//!
//! Hardware failures are close to invisible from the UI: a capture that comes
//! back empty looks the same whether the device is missing, the configuration
//! is wrong, or a driver mis-parsed a response. Two things make those cases
//! debuggable after the fact:
//!
//! * a `tracing` subscriber, so the `tracing::*` calls already spread through
//!   the crates stop being silently dropped, and
//! * a log file the user can hand over when something goes wrong.
//!
//! The level comes from `SIGPILOT_LOG` (`error`, `warn`, `info`, `debug`,
//! `trace`). Without it the default is `debug` in a debug build and `info`
//! otherwise, so a development run is verbose by default and a release build is
//! not.
//!
//! Everything goes to one file per run, and to stderr as well when stderr is a
//! terminal, which is what `tauri dev` shows.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};

use tracing_subscriber::fmt::MakeWriter;
use tracing_subscriber::fmt::time::SystemTime;

/// Environment variable holding the log level.
const LEVEL_ENV: &str = "SIGPILOT_LOG";

static LOG_PATH: OnceLock<PathBuf> = OnceLock::new();

/// Directory the log lives in, following each platform's convention for
/// application logs rather than scattering files next to the binary.
///
/// `SIGPILOT_LOG_DIR` overrides it, which is what the self-test uses and what a
/// user needs when the default location is not writable.
fn log_directory() -> PathBuf {
    if let Some(dir) = std::env::var_os("SIGPILOT_LOG_DIR") {
        return PathBuf::from(dir);
    }

    #[cfg(target_os = "macos")]
    {
        if let Some(home) = std::env::var_os("HOME") {
            return PathBuf::from(home).join("Library/Logs/SigPilot");
        }
    }

    #[cfg(target_os = "windows")]
    {
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            return PathBuf::from(local).join("SigPilot").join("logs");
        }
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        if let Some(state) = std::env::var_os("XDG_STATE_HOME") {
            return PathBuf::from(state).join("sigpilot");
        }
        if let Some(home) = std::env::var_os("HOME") {
            return PathBuf::from(home).join(".local/state/sigpilot");
        }
    }

    std::env::temp_dir().join("sigpilot-logs")
}

fn level_from_env() -> tracing::Level {
    let raw = std::env::var(LEVEL_ENV).ok();
    let default = if cfg!(debug_assertions) {
        tracing::Level::DEBUG
    } else {
        tracing::Level::INFO
    };
    match raw.as_deref().map(str::trim).map(str::to_ascii_lowercase) {
        Some(value) if value == "error" => tracing::Level::ERROR,
        Some(value) if value == "warn" => tracing::Level::WARN,
        Some(value) if value == "info" => tracing::Level::INFO,
        Some(value) if value == "debug" => tracing::Level::DEBUG,
        Some(value) if value == "trace" => tracing::Level::TRACE,
        _ => default,
    }
}

/// Writes each record to the log file and, when attached to a terminal, to
/// stderr as well.
#[derive(Clone)]
struct Tee {
    file: Arc<Mutex<File>>,
    stderr: bool,
}

impl Write for Tee {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        if let Ok(mut file) = self.file.lock() {
            // A logging failure must never take the app down.
            let _ = file.write_all(buf);
        }
        if self.stderr {
            let _ = io::stderr().write_all(buf);
        }
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        if let Ok(mut file) = self.file.lock() {
            let _ = file.flush();
        }
        if self.stderr {
            let _ = io::stderr().flush();
        }
        Ok(())
    }
}

impl<'a> MakeWriter<'a> for Tee {
    type Writer = Tee;

    fn make_writer(&'a self) -> Self::Writer {
        self.clone()
    }
}

/// Install the subscriber. Safe to call more than once; later calls do nothing.
///
/// Returns the path of the log file, or `None` when logging could not be set up
/// at all — which is deliberately not fatal, since losing logs is much better
/// than losing the app.
pub fn init() -> Option<&'static PathBuf> {
    if LOG_PATH.get().is_some() {
        return LOG_PATH.get();
    }

    let directory = log_directory();
    if fs::create_dir_all(&directory).is_err() {
        return None;
    }
    let path = directory.join("sigpilot.log");
    let Ok(file) = OpenOptions::new().create(true).append(true).open(&path) else {
        return None;
    };

    let tee = Tee {
        file: Arc::new(Mutex::new(file)),
        stderr: io::IsTerminal::is_terminal(&io::stderr()),
    };

    let installed = tracing_subscriber::fmt()
        .with_writer(tee)
        .with_max_level(level_from_env())
        .with_ansi(false)
        .with_target(true)
        .with_timer(SystemTime)
        .try_init()
        .is_ok();

    if installed {
        let _ = LOG_PATH.set(path);
        LOG_PATH.get()
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_land_in_the_log_file() {
        // Point the log at a scratch directory so the test does not write into
        // the user's real log location.
        let directory = std::env::temp_dir().join(format!(
            "sigpilot-logging-test-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&directory);
        std::env::set_var("SIGPILOT_LOG_DIR", &directory);

        let path = init().expect("logging should initialise");
        assert_eq!(path, &directory.join("sigpilot.log"));

        // The fmt layer writes synchronously, so the record is on disk by the
        // time the macro returns.
        tracing::info!(marker = "logging-self-test", "hello from the test");

        let contents = fs::read_to_string(path).expect("log file should exist");
        assert!(
            contents.contains("logging-self-test"),
            "log file did not contain the record: {contents:?}"
        );
        assert!(contents.contains("hello from the test"));

        let _ = fs::remove_dir_all(&directory);
    }
}
