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
//!
//! The level is also changeable while the app is running. A user hitting a
//! hardware bug cannot restart with `SIGPILOT_LOG=trace` set without losing the
//! state that reproduces it, so the subscriber is installed through a `reload`
//! layer that swaps the filter in place.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use tracing::level_filters::LevelFilter;
use tracing::Level;
use tracing_subscriber::fmt::time::SystemTime;
use tracing_subscriber::fmt::MakeWriter;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::reload;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::Layer as _;

/// Environment variable holding the log level.
const LEVEL_ENV: &str = "SIGPILOT_LOG";

static LOG_PATH: OnceLock<PathBuf> = OnceLock::new();
static LEVEL: AtomicU8 = AtomicU8::new(LEVEL_INFO);
static RELOAD_HANDLE: OnceLock<Mutex<Option<LevelHandle>>> = OnceLock::new();
static WRITER: OnceLock<Tee> = OnceLock::new();

// `Level` has no stable numeric ordering to rely on, so the atomic holds a rank
// of our own. The mapping is duplicated in the frontend's `LOG_LEVELS`.
const LEVEL_ERROR: u8 = 0;
const LEVEL_WARN: u8 = 1;
const LEVEL_INFO: u8 = 2;
const LEVEL_DEBUG: u8 = 3;
const LEVEL_TRACE: u8 = 4;

type BoxedLayer = Box<dyn tracing_subscriber::Layer<tracing_subscriber::Registry> + Send + Sync>;
type LevelHandle = reload::Handle<BoxedLayer, tracing_subscriber::Registry>;

pub fn level_to_str(level: Level) -> &'static str {
    match level {
        Level::ERROR => "error",
        Level::WARN => "warn",
        Level::INFO => "info",
        Level::DEBUG => "debug",
        Level::TRACE => "trace",
    }
}

pub fn level_from_str(value: &str) -> Option<Level> {
    match value.trim().to_ascii_lowercase().as_str() {
        "error" => Some(Level::ERROR),
        "warn" => Some(Level::WARN),
        "info" => Some(Level::INFO),
        "debug" => Some(Level::DEBUG),
        "trace" => Some(Level::TRACE),
        _ => None,
    }
}

fn rank_of(level: &Level) -> u8 {
    match *level {
        Level::ERROR => LEVEL_ERROR,
        Level::WARN => LEVEL_WARN,
        Level::INFO => LEVEL_INFO,
        Level::DEBUG => LEVEL_DEBUG,
        Level::TRACE => LEVEL_TRACE,
    }
}

fn rank_to_level(rank: u8) -> Level {
    match rank {
        LEVEL_ERROR => Level::ERROR,
        LEVEL_WARN => Level::WARN,
        LEVEL_DEBUG => Level::DEBUG,
        LEVEL_TRACE => Level::TRACE,
        _ => Level::INFO,
    }
}

/// The level in effect right now.
pub fn current_level() -> Level {
    rank_to_level(LEVEL.load(Ordering::Relaxed))
}

/// Change the level without restarting. No-op when logging never came up.
pub fn set_level(level: Level) {
    LEVEL.store(rank_of(&level), Ordering::Relaxed);
    let Some(slot) = RELOAD_HANDLE.get() else { return };
    let Ok(guard) = slot.lock() else { return };
    let Some(handle) = guard.as_ref() else { return };
    // Rebuilding the layer is the whole point of `reload`: the writer (and with
    // it the open file) is recreated from the same `Tee`, so nothing is lost.
    let _ = handle.reload(boxed_layer(level));
}

/// Path of the log file, when logging is up.
pub fn log_path() -> Option<&'static PathBuf> {
    LOG_PATH.get()
}

/// How much of the log file an export carries. A session left at `trace` can
/// write hundreds of megabytes, and the part that explains a bug is always at
/// the end.
const EXPORT_TAIL_BYTES: u64 = 16 * 1024 * 1024;

fn read_tail(path: &std::path::Path, max_bytes: u64) -> io::Result<String> {
    use std::io::{BufRead, Read, Seek, SeekFrom};

    let length = fs::metadata(path)?.len();
    let mut file = File::open(path)?;
    if length <= max_bytes {
        let mut contents = String::new();
        file.read_to_string(&mut contents)?;
        return Ok(contents);
    }
    file.seek(SeekFrom::Start(length - max_bytes))?;
    let mut reader = io::BufReader::new(file);
    // The seek lands mid-line; drop that fragment rather than emitting a
    // record that looks corrupt.
    let mut discarded = String::new();
    reader.read_line(&mut discarded)?;
    let mut contents = String::from("... (earlier records omitted) ...\n");
    reader.read_to_string(&mut contents)?;
    Ok(contents)
}

/// The single file a user attaches to a bug report.
///
/// Every layer lands in it: the webview's own record (handed in by the
/// frontend, which is the only place it exists), then the backend file. One
/// plain-text file beats an archive here — it can be pasted, grepped and read
/// without unpacking.
pub fn export_bundle(frontend_log: &str) -> String {
    let mut out = String::new();
    out.push_str("=== SigPilot diagnostics ===\n");
    out.push_str(&format!("generated: {}\n", chrono_like_timestamp()));
    out.push_str(&format!("version: {}\n", env!("CARGO_PKG_VERSION")));
    out.push_str(&format!(
        "platform: {} {} ({})\n",
        std::env::consts::OS,
        std::env::consts::ARCH,
        std::env::consts::FAMILY
    ));
    out.push_str(&format!("log level: {}\n", level_to_str(current_level())));

    out.push_str("\n--- frontend log (webview) ---\n");
    let frontend = frontend_log.trim();
    if frontend.is_empty() {
        out.push_str("(empty)\n");
    } else {
        out.push_str(frontend);
        out.push('\n');
    }

    out.push_str("\n--- backend log ---\n");
    match log_path() {
        Some(path) => {
            out.push_str(&format!("file: {}\n\n", path.display()));
            match read_tail(path, EXPORT_TAIL_BYTES) {
                Ok(contents) if contents.trim().is_empty() => out.push_str("(empty)\n"),
                Ok(contents) => out.push_str(&contents),
                Err(error) => out.push_str(&format!("(unreadable: {error})\n")),
            }
        }
        None => out.push_str("(logging unavailable)\n"),
    }
    out
}

/// Seconds since the Unix epoch. `SystemTime` is not `Display`, and pulling a
/// date-time crate in for one header line is not worth it.
fn chrono_like_timestamp() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0)
}

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
    /// `None` when logging never opened its file, which keeps this type usable
    /// as the fallback writer instead of forcing a second code path.
    file: Arc<Mutex<Option<File>>>,
    stderr: bool,
}

impl Tee {
    fn sink(stderr: bool) -> Self {
        Self {
            file: Arc::new(Mutex::new(None)),
            stderr,
        }
    }
}

impl Write for Tee {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        if let Ok(mut file) = self.file.lock() {
            // A logging failure must never take the app down.
            if let Some(file) = file.as_mut() {
                let _ = file.write_all(buf);
            }
        }
        if self.stderr {
            let _ = io::stderr().write_all(buf);
        }
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        if let Ok(mut file) = self.file.lock() {
            if let Some(file) = file.as_mut() {
                let _ = file.flush();
            }
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

/// The recording half of the subscriber, rebuilt whenever the level changes.
fn boxed_layer(level: Level) -> BoxedLayer {
    // `init` always runs first; the fallback keeps this total rather than
    // panicking inside a diagnostic.
    let writer = WRITER
        .get()
        .cloned()
        .unwrap_or_else(|| Tee::sink(io::IsTerminal::is_terminal(&io::stderr())));
    tracing_subscriber::fmt::layer()
        .with_writer(writer)
        .with_ansi(false)
        .with_target(true)
        .with_timer(SystemTime)
        .with_filter(LevelFilter::from_level(level))
        .boxed()
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
        file: Arc::new(Mutex::new(Some(file))),
        stderr: io::IsTerminal::is_terminal(&io::stderr()),
    };
    let _ = WRITER.set(tee);

    let level = level_from_env();
    let (layer, handle) = reload::Layer::new(boxed_layer(level));
    let installed = tracing_subscriber::registry().with(layer).try_init().is_ok();

    if installed {
        LEVEL.store(rank_of(&level), Ordering::Relaxed);
        let _ = RELOAD_HANDLE.set(Mutex::new(Some(handle)));
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
