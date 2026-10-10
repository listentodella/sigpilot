//! Diagnostic logging.
//!
//! Hardware failures are close to invisible from the UI: a capture that comes
//! back empty looks the same whether the device is missing, the configuration
//! is wrong, or a driver mis-parsed a response. Two things make those cases
//! debuggable after the fact:
//!
//! * a `tracing` subscriber, so the `tracing::*` calls already spread through
//!   the crates stop being silently dropped, and
//! * log files the user can hand over when something goes wrong.
//!
//! The level comes from `SIGPILOT_LOG` (`error`, `warn`, `info`, `debug`,
//! `trace`). Without it the default is `debug` in a debug build and `info`
//! otherwise, so a development run is verbose by default and a release build is
//! not. It can also be changed while the app runs; see [`set_level`].
//!
//! # Why logging is always on
//!
//! An opt-in switch sounds considerate until you need the log: the moment you
//! wish you had recording enabled is *after* the failure, and you cannot turn it
//! on for a run that already happened. So recording is on by default and the
//! disk cost is bounded instead — see [`MAX_FILE_BYTES`] and [`MAX_FILES`].
//! [`set_paused`] exists for the case that does need silence, like leaving the
//! app open for a multi-hour capture.
//!
//! # Why each launch gets its own file
//!
//! Overwriting would destroy exactly the evidence a crash report needs: the
//! records from the run that died. Files are named
//! `sigpilot-<utc timestamp>-p<part>.log`, which sorts chronologically by name
//! and makes the oldest easy to drop.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use time::OffsetDateTime;
use tracing::Level;
use tracing_subscriber::filter::LevelFilter;
use tracing_subscriber::fmt::time::SystemTime;
use tracing_subscriber::fmt::MakeWriter;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::reload;
use tracing_subscriber::util::SubscriberInitExt;

/// Environment variable holding the log level.
const LEVEL_ENV: &str = "SIGPILOT_LOG";

/// Prefix every file we own starts with, so pruning never touches anything else
/// that happens to live in the log directory.
const LOG_PREFIX: &str = "sigpilot-";

/// Ceiling on one file. Past it the writer rolls over to a new part.
pub const MAX_FILE_BYTES: u64 = 8 * 1024 * 1024;

/// How many files to keep across all launches, so the worst case on disk is
/// `MAX_FILE_BYTES * MAX_FILES` and the user never has to think about it.
pub const MAX_FILES: usize = 5;

/// How much of the retained logs a diagnostics bundle carries. A session left at
/// `trace` can fill every file, and the part that explains a bug is at the end.
pub const DIAGNOSTICS_BYTES: u64 = 512 * 1024;

static LOG_DIRECTORY: OnceLock<PathBuf> = OnceLock::new();
static SINK: OnceLock<Arc<Mutex<Option<Sink>>>> = OnceLock::new();
static LEVEL: AtomicU8 = AtomicU8::new(LEVEL_INFO);
static PAUSED: AtomicBool = AtomicBool::new(false);
static RELOAD_HANDLE: OnceLock<Mutex<Option<LevelHandle>>> = OnceLock::new();

// `Level` has no stable numeric ordering to rely on, so the atomic holds a rank
// of our own. The mapping is duplicated in the frontend's `LOG_LEVELS`.
const LEVEL_ERROR: u8 = 0;
const LEVEL_WARN: u8 = 1;
const LEVEL_INFO: u8 = 2;
const LEVEL_DEBUG: u8 = 3;
const LEVEL_TRACE: u8 = 4;

/// The level filter is what gets reloaded — not the layer that writes.
///
/// `reload::Layer` cannot wrap a layer produced by `Layer::with_filter`: that
/// produces a `Filtered`, which is only handed a `FilterId` when it is
/// registered directly with the subscriber, and `reload` swallows that
/// registration. Every event then trips a `debug_assert!` in `Filtered::id`,
/// which in a debug build is an abort trap on whichever thread logged it.
type LevelHandle = reload::Handle<LevelFilter, tracing_subscriber::Registry>;

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
    // Only the filter is swapped, so the open log file is never touched and no
    // record in flight is lost.
    let _ = handle.modify(|filter| *filter = LevelFilter::from_level(level));
}

/// Stop writing to the file without stopping the app. Stderr keeps going, so a
/// `tauri dev` run still shows what is happening.
pub fn set_paused(paused: bool) {
    PAUSED.store(paused, Ordering::Relaxed);
}

pub fn is_paused() -> bool {
    PAUSED.load(Ordering::Relaxed)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogFileInfo {
    pub name: String,
    pub bytes: u64,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogStatus {
    pub available: bool,
    pub current_file: String,
    pub directory: String,
    pub files: Vec<LogFileInfo>,
    pub level: String,
    pub max_file_bytes: u64,
    pub max_files: usize,
    pub paused: bool,
    pub total_bytes: u64,
}

/// Everything the advanced panel needs to describe the log honestly.
pub fn status() -> LogStatus {
    let directory = log_directory();
    let mut files = Vec::new();
    let mut total_bytes = 0;
    for path in log_files_newest_first(&directory) {
        let bytes = fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
        total_bytes += bytes;
        files.push(LogFileInfo {
            name: path
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default(),
            bytes,
        });
    }
    LogStatus {
        available: SINK.get().is_some_and(|sink| sink.lock().is_ok_and(|sink| sink.is_some())),
        current_file: log_path()
            .map(|path| path.display().to_string())
            .unwrap_or_default(),
        directory: directory.display().to_string(),
        files,
        level: level_to_str(current_level()).to_string(),
        max_file_bytes: MAX_FILE_BYTES,
        max_files: MAX_FILES,
        paused: is_paused(),
        total_bytes,
    }
}

/// Delete every retained file and start a fresh one.
pub fn clear() {
    let directory = log_directory();
    for path in log_files_newest_first(&directory) {
        let _ = fs::remove_file(path);
    }
    let Some(slot) = SINK.get() else { return };
    let Ok(mut guard) = slot.lock() else { return };
    let Some(sink) = guard.as_mut() else { return };
    sink.part = 0;
    sink.open_current();
}

/// Path of the file currently being written, when logging is up.
pub fn log_path() -> Option<PathBuf> {
    let sink = SINK.get()?.lock().ok()?;
    let sink = sink.as_ref()?;
    Some(sink.current_path())
}

/// UTC timestamp for a file name.
///
/// UTC rather than local so the name is reproducible in a bug report whatever
/// the reporter's timezone is.
fn file_stamp(epoch_seconds: i64) -> String {
    let Ok(stamp) = OffsetDateTime::from_unix_timestamp(epoch_seconds) else {
        return "00000000T000000Z".to_string();
    };
    format!(
        "{:04}{:02}{:02}T{:02}{:02}{:02}Z",
        stamp.year(),
        u8::from(stamp.month()),
        stamp.day(),
        stamp.hour(),
        stamp.minute(),
        stamp.second()
    )
}

fn log_file_name(stamp: &str, part: u32) -> String {
    // Zero-padded so a plain string sort is a chronological sort, and the part
    // suffix sorts after the base name rather than before it.
    format!("{LOG_PREFIX}{stamp}-p{part:03}.log")
}

fn now_epoch_seconds() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs() as i64)
        .unwrap_or(0)
}

fn is_log_file(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(|name| name.starts_with(LOG_PREFIX) && name.ends_with(".log"))
        .unwrap_or(false)
}

fn log_files_newest_first(directory: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(directory) else { return Vec::new() };
    let mut files: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_file() && is_log_file(path))
        .collect();
    // Names encode the timestamp and the part, both zero-padded, so byte order
    // is time order.
    files.sort();
    files.reverse();
    files
}

fn prune(directory: &Path) {
    let files = log_files_newest_first(directory);
    for stale in files.into_iter().skip(MAX_FILES) {
        let _ = fs::remove_file(stale);
    }
}

fn read_tail(path: &Path, max_bytes: u64) -> io::Result<String> {
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

/// The text a user pastes into a bug report.
///
/// Every layer lands in it: the webview's own record (handed in by the
/// frontend, which is the only place it exists), then the retained backend
/// files. One plain-text blob beats an archive here — it pastes, it greps, and
/// it needs no unpacking.
pub fn diagnostics(frontend_log: &str, max_bytes: u64) -> String {
    let mut out = String::new();
    out.push_str("=== SigPilot diagnostics ===\n");
    out.push_str(&format!("generated (unix): {}\n", now_epoch_seconds()));
    out.push_str(&format!("version: {}\n", env!("CARGO_PKG_VERSION")));
    out.push_str(&format!(
        "platform: {} {} ({})\n",
        std::env::consts::OS,
        std::env::consts::ARCH,
        std::env::consts::FAMILY
    ));
    out.push_str(&format!("log level: {}\n", level_to_str(current_level())));
    out.push_str(&format!("recording paused: {}\n", is_paused()));

    out.push_str("\n--- frontend log (webview) ---\n");
    let frontend = frontend_log.trim();
    if frontend.is_empty() {
        out.push_str("(empty)\n");
    } else {
        out.push_str(frontend);
        out.push('\n');
    }

    let files = log_files_newest_first(&log_directory());
    out.push_str("\n--- backend log ---\n");
    if files.is_empty() {
        out.push_str("(no log files)\n");
        return out;
    }
    // Share the budget across the retained files so a deep session cannot
    // produce a paste that no issue tracker will accept.
    let per_file = (max_bytes / files.len() as u64).max(4096);
    let mut budget = max_bytes;
    for (index, path) in files.iter().enumerate() {
        if budget == 0 {
            out.push_str(&format!(
                "... ({} earlier file(s) omitted, {max_bytes} byte budget reached)\n",
                files.len() - index
            ));
            break;
        }
        let name = path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        out.push_str(&format!("\n[{name}]\n"));
        match read_tail(path, per_file.min(budget)) {
            Ok(contents) if contents.trim().is_empty() => out.push_str("(empty)\n"),
            Ok(contents) => {
                budget = budget.saturating_sub(contents.len() as u64);
                out.push_str(&contents);
                if !contents.ends_with('\n') {
                    out.push('\n');
                }
            }
            Err(error) => out.push_str(&format!("(unreadable: {error})\n")),
        }
    }
    out
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

fn level_from_env() -> Level {
    let raw = std::env::var(LEVEL_ENV).ok();
    let default = if cfg!(debug_assertions) {
        Level::DEBUG
    } else {
        Level::INFO
    };
    match raw.as_deref().map(str::trim).map(str::to_ascii_lowercase).as_deref() {
        Some("error") => Level::ERROR,
        Some("warn") => Level::WARN,
        Some("info") => Level::INFO,
        Some("debug") => Level::DEBUG,
        Some("trace") => Level::TRACE,
        _ => default,
    }
}

/// The file half of the writer: one part of this launch's file, rolling over
/// into the next part when it reaches [`MAX_FILE_BYTES`].
struct Sink {
    directory: PathBuf,
    stem: String,
    part: u32,
    file: Option<File>,
    written: u64,
}

impl Sink {
    fn open(directory: PathBuf, stem: String) -> Self {
        let mut sink = Self {
            directory,
            stem,
            part: 0,
            file: None,
            written: 0,
        };
        sink.open_current();
        sink
    }

    fn path(&self, part: u32) -> PathBuf {
        self.directory.join(log_file_name(&self.stem, part))
    }

    fn current_path(&self) -> PathBuf {
        self.path(self.part)
    }

    fn open_current(&mut self) {
        self.file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.current_path())
            .ok();
        self.written = self
            .file
            .as_ref()
            .and_then(|file| file.metadata().ok())
            .map(|meta| meta.len())
            .unwrap_or(0);
    }

    /// Move to the next part, dropping the oldest file if the retention budget
    /// is now exceeded.
    fn roll(&mut self) {
        self.file = None;
        self.part = self.part.saturating_add(1);
        self.open_current();
        prune(&self.directory);
    }

    fn write(&mut self, buf: &[u8]) {
        if self.written + buf.len() as u64 > MAX_FILE_BYTES && self.written > 0 {
            self.roll();
        }
        if let Some(file) = self.file.as_mut() {
            // A logging failure must never take the app down.
            if file.write_all(buf).is_ok() {
                self.written += buf.len() as u64;
            }
        }
    }
}

/// Writes each record to the log file and, when attached to a terminal, to
/// stderr as well.
#[derive(Clone)]
struct Tee {
    sink: Arc<Mutex<Option<Sink>>>,
    stderr: bool,
}

impl Write for Tee {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        if !is_paused() {
            if let Ok(mut guard) = self.sink.lock() {
                if let Some(sink) = guard.as_mut() {
                    sink.write(buf);
                }
            }
        }
        if self.stderr {
            let _ = io::stderr().write_all(buf);
        }
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        if let Ok(mut guard) = self.sink.lock() {
            if let Some(sink) = guard.as_mut() {
                if let Some(file) = sink.file.as_mut() {
                    let _ = file.flush();
                }
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

/// Install the subscriber. Safe to call more than once; later calls do nothing.
///
/// Returns the log directory, or `None` when logging could not be set up at all
/// — which is deliberately not fatal, since losing logs is much better than
/// losing the app.
pub fn init() -> Option<&'static PathBuf> {
    if LOG_DIRECTORY.get().is_some() {
        return LOG_DIRECTORY.get();
    }

    let directory = log_directory();
    if fs::create_dir_all(&directory).is_err() {
        return None;
    }
    // A previous run may have died with a full disk or a stale lock; make room
    // before adding another file to the set.
    prune(&directory);

    let sink = Arc::new(Mutex::new(Some(Sink::open(
        directory.clone(),
        file_stamp(now_epoch_seconds()),
    ))));
    let _ = SINK.set(sink);
    let _ = LOG_DIRECTORY.set(directory.clone());

    let tee = Tee {
        sink: SINK
            .get()
            .expect("SINK was just set")
            .clone(),
        stderr: io::IsTerminal::is_terminal(&io::stderr()),
    };

    let level = level_from_env();
    // The filter is its own layer ahead of the writer, so it gates everything
    // behind it and can be swapped without disturbing the file.
    let (filter, handle) = reload::Layer::new(LevelFilter::from_level(level));
    let installed = tracing_subscriber::registry()
        .with(filter)
        .with(
            tracing_subscriber::fmt::layer()
                .with_writer(tee)
                .with_ansi(false)
                .with_target(true)
                .with_timer(SystemTime),
        )
        .try_init()
        .is_ok();

    if installed {
        LEVEL.store(rank_of(&level), Ordering::Relaxed);
        let _ = RELOAD_HANDLE.set(Mutex::new(Some(handle)));
        Some(LOG_DIRECTORY.get().expect("LOG_DIRECTORY was just set"))
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Records reach the file, and the level can be changed afterwards without
    /// restarting — including through the callsite shape `frontend_log` uses.
    ///
    /// One test rather than two on purpose: the subscriber can only be
    /// installed once per process, so two tests would race on `init`.
    ///
    /// This is also the regression test for a crash. The subscriber used to be
    /// installed as a `reload` layer wrapping a layer built with
    /// `with_filter`. That pairing produces a `Filtered`, which is only handed
    /// a `FilterId` when it is registered directly with the subscriber, and
    /// `reload` swallows the registration — so every event tripped a
    /// `debug_assert!` in `Filtered::id`, an abort trap on whichever thread
    /// logged it. Reproduced before the fix; passes after.
    #[test]
    fn records_land_in_the_file_and_follow_the_level() {
        // Point the log at a scratch directory so the test does not write into
        // the user's real log location.
        let directory = std::env::temp_dir().join(format!(
            "sigpilot-logging-test-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&directory);
        std::env::set_var("SIGPILOT_LOG_DIR", &directory);

        let logged = init().expect("logging should initialise");
        assert_eq!(logged, &directory);

        // The fmt layer writes synchronously, so a record is on disk by the
        // time the macro returns.
        tracing::info!(marker = "logging-self-test", "hello from the test");

        // Mirror `frontend_log`: an explicit target is what webview records
        // carry, and it is the callsite shape that used to abort.
        set_level(Level::WARN);
        tracing::info!(target: "sigpilot_webview", marker = "level-test-suppressed", "must not be written");

        set_level(Level::INFO);
        tracing::info!(target: "sigpilot_webview", marker = "level-test-emitted", "must be written");

        let current = log_files_newest_first(&directory)
            .into_iter()
            .next()
            .expect("this launch should have a log file");
        let contents = fs::read_to_string(&current).expect("log file should exist");
        assert!(
            contents.contains("logging-self-test"),
            "log file did not contain the record: {contents:?}"
        );
        assert!(contents.contains("hello from the test"));
        assert!(
            !contents.contains("level-test-suppressed"),
            "an info record was written while the level was `warn`: {contents:?}"
        );
        assert!(
            contents.contains("level-test-emitted"),
            "the info record is missing after raising the level: {contents:?}"
        );

        let _ = fs::remove_dir_all(&directory);
    }

    /// Retention has to hold across launches, and file names have to sort so
    /// that "oldest" and "newest" are decidable without a timestamp parse.
    #[test]
    fn retention_keeps_the_newest_files_across_launches() {
        let directory = std::env::temp_dir().join(format!(
            "sigpilot-logging-prune-test-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&directory);
        fs::create_dir_all(&directory).expect("scratch directory");

        for launch in 0..(MAX_FILES + 3) {
            for part in 0..2 {
                let name = log_file_name(&file_stamp(1_700_000_000 + launch as i64), part as u32);
                fs::write(directory.join(name), b"x").expect("write scratch log");
            }
        }
        // Something that is not ours must survive.
        fs::write(directory.join("notes.txt"), b"keep me").expect("write bystander");

        prune(&directory);

        let kept: Vec<String> = log_files_newest_first(&directory)
            .into_iter()
            .map(|path| path.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert_eq!(kept.len(), MAX_FILES, "pruning kept the wrong number of files");
        assert!(
            !kept.iter().any(|name| name.contains("1700000000")),
            "pruning kept the oldest launch: {kept:?}"
        );
        assert!(
            kept[0].contains(&file_stamp(1_700_000_000 + (MAX_FILES + 2) as i64)),
            "the newest launch is not first: {kept:?}"
        );
        assert!(
            directory.join("notes.txt").exists(),
            "pruning deleted a file it does not own"
        );

        let _ = fs::remove_dir_all(&directory);
    }
}
