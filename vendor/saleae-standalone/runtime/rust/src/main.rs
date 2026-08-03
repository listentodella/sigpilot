use clap::{Args, Parser, Subcommand, ValueEnum};
use saleae_runtime::sal::{self, AnalyzerConfig, ReaderOptions, SalCapture};
use saleae_runtime::{
    decode_sal_capture, default_plugin, simulate_and_decode, FieldValue, Frame, SimulationRun,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command as ProcessCommand, Stdio};
use std::time::Duration;
use wait_timeout::ChildExt;

#[derive(Debug, Parser)]
#[command(
    name = "saleae-runtime",
    version,
    about = "Decode Logic 2 .sal captures with Saleae analyzers"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Show capture channels and saved analyzer configurations.
    Inspect {
        input: PathBuf,
        #[command(flatten)]
        reader: ReaderArgs,
        #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
        format: OutputFormat,
    },
    /// Decode a capture with its saved I2C or SPI analyzer configuration.
    Decode {
        input: PathBuf,
        /// Analyzer type or saved analyzer name. Auto-selects when unambiguous.
        #[arg(short, long)]
        analyzer: Option<String>,
        /// Override an analyzer channel, for example SDA=0 or Enable=none.
        #[arg(long = "channel", value_name = "TITLE=CHANNEL")]
        channels: Vec<String>,
        /// Override a NumberList setting, for example "Clock Phase=1".
        #[arg(long = "setting", value_name = "TITLE=VALUE")]
        settings: Vec<String>,
        /// Override the analyzer plugin path.
        #[arg(long)]
        plugin: Option<PathBuf>,
        #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
        format: OutputFormat,
        /// Skip this many decoded frames.
        #[arg(long, default_value_t = 0)]
        offset: usize,
        /// Print at most this many frames. All frames are decoded when omitted.
        #[arg(long)]
        limit: Option<usize>,
        #[command(flatten)]
        reader: ReaderArgs,
    },
    /// Generate an analyzer's simulation waveform, decode it, and export CSV.
    Simulate {
        /// Analyzer plugin to exercise.
        #[arg(long)]
        plugin: PathBuf,
        /// Destination CSV file.
        #[arg(long)]
        output: PathBuf,
        #[arg(long, default_value_t = 12_000_000)]
        sample_rate: u32,
        #[arg(long, default_value_t = 120_000)]
        sample_count: u64,
    },
    /// Run isolated simulation round trips for every built analyzer.
    SelfTest {
        /// Directory containing lib*_analyzer.so plugins.
        #[arg(long)]
        plugin_dir: Option<PathBuf>,
        /// CSV baseline directory.
        #[arg(long)]
        output_dir: Option<PathBuf>,
        /// Restrict the run to plugin names containing this text.
        #[arg(long)]
        analyzer: Option<String>,
        #[arg(long, default_value_t = 12_000_000)]
        sample_rate: u32,
        #[arg(long, default_value_t = 120_000)]
        sample_count: u64,
        /// Create or replace CSV baselines instead of verifying them.
        #[arg(long)]
        update: bool,
        /// Maximum runtime for one analyzer process.
        #[arg(long, default_value_t = 20)]
        timeout_seconds: u64,
    },
}

#[derive(Debug, Clone, Args)]
struct ReaderArgs {
    /// Path to pxlogic-saleae-graph-sidecar.
    #[arg(long, env = "SALEAE_GRAPH_SIDECAR")]
    sidecar: Option<PathBuf>,
    /// Logic 2 macos-arm64 resource directory.
    #[arg(long, env = "SALEAE_LOGIC_RUNTIME_ROOT")]
    runtime_root: Option<PathBuf>,
}

impl ReaderArgs {
    fn options(&self) -> ReaderOptions {
        ReaderOptions {
            sidecar: self.sidecar.clone(),
            runtime_root: self.runtime_root.clone(),
        }
    }
}

#[derive(Debug, Clone, Copy, ValueEnum, PartialEq, Eq)]
enum OutputFormat {
    Text,
    Json,
}

fn main() {
    if let Err(error) = run(Cli::parse()) {
        eprintln!("error: {error}");
        std::process::exit(2);
    }
}

fn run(cli: Cli) -> Result<(), String> {
    match cli.command {
        Command::Inspect {
            input,
            reader,
            format,
        } => {
            let capture = open_capture(&input, &reader.options())?;
            print_inspection(&capture, format)
        }
        Command::Decode {
            input,
            analyzer,
            channels,
            settings,
            plugin,
            format,
            offset,
            limit,
            reader,
        } => {
            let capture = open_capture(&input, &reader.options())?;
            let mut analyzer = select_analyzer(&capture, analyzer.as_deref())?.clone();
            apply_overrides(&mut analyzer, &channels, &settings)?;
            let plugin = plugin.unwrap_or(default_plugin(&analyzer.analyzer_type)?);
            let (frames, legacy_frames) = decode_sal_capture(&capture, &analyzer, &plugin)?;
            print_frames(
                &capture,
                &analyzer,
                &plugin,
                &frames,
                legacy_frames.len(),
                offset,
                limit,
                format,
            )
        }
        Command::Simulate {
            plugin,
            output,
            sample_rate,
            sample_count,
        } => simulate_one(&plugin, &output, sample_rate, sample_count),
        Command::SelfTest {
            plugin_dir,
            output_dir,
            analyzer,
            sample_rate,
            sample_count,
            update,
            timeout_seconds,
        } => run_self_test(
            plugin_dir.unwrap_or_else(default_plugin_dir),
            output_dir.unwrap_or_else(default_simulation_dir),
            analyzer.as_deref(),
            sample_rate,
            sample_count,
            update,
            timeout_seconds,
        ),
    }
}

fn open_capture(path: &Path, options: &ReaderOptions) -> Result<SalCapture, String> {
    if path.file_name().and_then(|name| name.to_str()) == Some("manifest.json") {
        sal::open_transition_manifest(path)
    } else {
        sal::open(path, options)
    }
}

fn default_plugin_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("build")
        .join("lib")
}

fn default_simulation_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("simulation-baselines")
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SimulationSummary {
    analyzer: String,
    plugin: String,
    sample_rate_hz: u32,
    requested_sample_count: u64,
    channel_count: usize,
    transition_count: usize,
    frame_v2_count: usize,
    legacy_frame_count: usize,
}

#[derive(Debug, Serialize)]
struct CsvRow {
    kind: String,
    analyzer: String,
    index: usize,
    #[serde(rename = "type")]
    frame_type: String,
    start_sample: i64,
    end_sample: i64,
    fields_json: String,
    data1: String,
    data2: String,
    flags: String,
}

fn simulate_one(
    plugin: &Path,
    output: &Path,
    sample_rate: u32,
    sample_count: u64,
) -> Result<(), String> {
    let run = simulate_and_decode(plugin, sample_rate, sample_count)?;
    if let Some(parent) = output.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    write_simulation_csv(output, &run)?;
    let summary = SimulationSummary {
        analyzer: run.analyzer.clone(),
        plugin: plugin.display().to_string(),
        sample_rate_hz: sample_rate,
        requested_sample_count: sample_count,
        channel_count: run.channels.len(),
        transition_count: run
            .channels
            .iter()
            .map(|channel| channel.transitions.len())
            .sum(),
        frame_v2_count: run.frames.len(),
        legacy_frame_count: run.legacy_frames.len(),
    };
    println!(
        "{}",
        serde_json::to_string(&summary).map_err(|error| error.to_string())?
    );
    Ok(())
}

fn write_simulation_csv(path: &Path, run: &SimulationRun) -> Result<(), String> {
    let mut writer = csv::Writer::from_path(path).map_err(|error| error.to_string())?;
    for (index, frame) in run.frames.iter().enumerate() {
        writer
            .serialize(CsvRow {
                kind: "frame_v2".to_owned(),
                analyzer: run.analyzer.clone(),
                index,
                frame_type: frame.frame_type.clone(),
                start_sample: frame.start_sample as i64,
                end_sample: frame.end_sample as i64,
                fields_json: serde_json::to_string(&frame.fields)
                    .map_err(|error| error.to_string())?,
                data1: String::new(),
                data2: String::new(),
                flags: String::new(),
            })
            .map_err(|error| error.to_string())?;
    }
    for (index, frame) in run.legacy_frames.iter().enumerate() {
        let (data1, data2) = normalized_legacy_data(&run.analyzer, frame);
        writer
            .serialize(CsvRow {
                kind: "legacy".to_owned(),
                analyzer: run.analyzer.clone(),
                index,
                frame_type: frame.frame_type.to_string(),
                start_sample: frame.start_sample,
                end_sample: frame.end_sample,
                fields_json: String::new(),
                data1,
                data2,
                flags: format!("0x{:02x}", frame.flags),
            })
            .map_err(|error| error.to_string())?;
    }
    writer.flush().map_err(|error| error.to_string())
}

fn normalized_legacy_data(analyzer: &str, frame: &saleae_runtime::LegacyFrame) -> (String, String) {
    let data1 = format!("0x{:016x}", frame.data1);
    let data2 = if analyzer.eq_ignore_ascii_case("Midi") {
        // MIDI stores an S8 channel in the first byte of a legacy union.
        format!("0x{:02x}", frame.data2 & 0xff)
    } else if analyzer.eq_ignore_ascii_case("USB LS and FS") && frame.frame_type == 13 {
        // USB control-transfer fields store a transient const-char* in mData2.
        String::new()
    } else {
        format!("0x{:016x}", frame.data2)
    };
    (data1, data2)
}

#[derive(Debug, Serialize)]
struct CompatibilityEntry {
    plugin: String,
    status: String,
    summary: Option<SimulationSummary>,
    error: Option<String>,
}

#[allow(clippy::too_many_arguments)]
fn run_self_test(
    plugin_dir: PathBuf,
    output_dir: PathBuf,
    selector: Option<&str>,
    sample_rate: u32,
    sample_count: u64,
    update: bool,
    timeout_seconds: u64,
) -> Result<(), String> {
    fs::create_dir_all(&output_dir).map_err(|error| error.to_string())?;
    let mut plugins = fs::read_dir(&plugin_dir)
        .map_err(|error| format!("cannot read {}: {error}", plugin_dir.display()))?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("lib") && name.ends_with("_analyzer.so"))
        })
        .filter(|path| {
            selector.is_none_or(|selector| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.contains(selector))
            })
        })
        .collect::<Vec<_>>();
    plugins.sort();
    if plugins.is_empty() {
        return Err("no matching analyzer plugins found".to_owned());
    }

    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    let temporary = tempfile::tempdir().map_err(|error| error.to_string())?;
    let mut entries = Vec::with_capacity(plugins.len());

    for plugin in plugins {
        let file_name = plugin
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| format!("invalid plugin path {}", plugin.display()))?;
        let baseline_name = file_name
            .strip_prefix("lib")
            .and_then(|name| name.strip_suffix("_analyzer.so"))
            .unwrap_or(file_name);
        let actual = temporary.path().join(format!("{baseline_name}.csv"));
        let baseline = output_dir.join(format!("{baseline_name}.csv"));
        let (analyzer_sample_rate, analyzer_sample_count) =
            simulation_parameters(baseline_name, sample_rate, sample_count);

        let mut child = ProcessCommand::new(&executable)
            .arg("simulate")
            .arg("--plugin")
            .arg(&plugin)
            .arg("--output")
            .arg(&actual)
            .arg("--sample-rate")
            .arg(analyzer_sample_rate.to_string())
            .arg("--sample-count")
            .arg(analyzer_sample_count.to_string())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| error.to_string())?;

        let timed_out = child
            .wait_timeout(Duration::from_secs(timeout_seconds))
            .map_err(|error| error.to_string())?
            .is_none();
        if timed_out {
            child.kill().map_err(|error| error.to_string())?;
        }
        let process_output = child
            .wait_with_output()
            .map_err(|error| error.to_string())?;
        let stdout = String::from_utf8_lossy(&process_output.stdout);
        let stderr = String::from_utf8_lossy(&process_output.stderr);

        let result = if baseline_name == "mcs04"
            && !process_output.status.success()
            && stderr.contains("analyzer generated no simulation channels")
        {
            Ok((
                "generator-unavailable".to_owned(),
                SimulationSummary {
                    analyzer: "MCS-4 Bus".to_owned(),
                    plugin: plugin.display().to_string(),
                    sample_rate_hz: analyzer_sample_rate,
                    requested_sample_count: analyzer_sample_count,
                    channel_count: 0,
                    transition_count: 0,
                    frame_v2_count: 0,
                    legacy_frame_count: 0,
                },
            ))
        } else if timed_out {
            Err(format!("timed out after {timeout_seconds}s"))
        } else if !process_output.status.success() {
            Err(stderr.trim().to_owned())
        } else {
            let summary = serde_json::from_str::<SimulationSummary>(stdout.trim())
                .map_err(|error| format!("invalid child summary: {error}; output={stdout}"))?;
            if update {
                fs::copy(&actual, &baseline).map_err(|error| error.to_string())?;
                Ok(("baseline-updated".to_owned(), summary))
            } else if !baseline.exists() {
                Err(format!(
                    "missing baseline {}; run with --update",
                    baseline.display()
                ))
            } else if fs::read(&actual).map_err(|error| error.to_string())?
                != fs::read(&baseline).map_err(|error| error.to_string())?
            {
                Err(format!("CSV differs from {}", baseline.display()))
            } else {
                Ok(("matched".to_owned(), summary))
            }
        };

        match result {
            Ok((status, summary)) => {
                println!(
                    "{:<28} {:<16} v2={} legacy={} transitions={}",
                    baseline_name,
                    status,
                    summary.frame_v2_count,
                    summary.legacy_frame_count,
                    summary.transition_count
                );
                entries.push(CompatibilityEntry {
                    plugin: file_name.to_owned(),
                    status,
                    summary: Some(summary),
                    error: None,
                });
            }
            Err(error) => {
                println!("{baseline_name:<28} failed           {error}");
                entries.push(CompatibilityEntry {
                    plugin: file_name.to_owned(),
                    status: "failed".to_owned(),
                    summary: None,
                    error: Some(error),
                });
            }
        }
    }

    let report = output_dir.join("compatibility.json");
    fs::write(
        &report,
        serde_json::to_vec_pretty(&entries).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    let failures = entries.iter().filter(|entry| entry.error.is_some()).count();
    if failures == 0 {
        Ok(())
    } else {
        Err(format!(
            "{failures} analyzer(s) failed; see {}",
            report.display()
        ))
    }
}

fn simulation_parameters(
    analyzer: &str,
    default_sample_rate: u32,
    default_sample_count: u64,
) -> (u32, u64) {
    match analyzer {
        // The official USB generator begins with millisecond-scale idle/reset periods.
        "usb" => (
            default_sample_rate.max(24_000_000),
            default_sample_count.max(1_200_000),
        ),
        _ => (default_sample_rate, default_sample_count),
    }
}

fn select_analyzer<'a>(
    capture: &'a SalCapture,
    selector: Option<&str>,
) -> Result<&'a AnalyzerConfig, String> {
    if let Some(selector) = selector {
        return capture
            .session
            .analyzers
            .iter()
            .find(|analyzer| {
                analyzer.is_supported()
                    && (analyzer.name.eq_ignore_ascii_case(selector)
                        || analyzer.analyzer_type.eq_ignore_ascii_case(selector))
            })
            .ok_or_else(|| format!("capture has no supported analyzer named {selector}"));
    }

    let compatible = capture.compatible_analyzers();
    match compatible.as_slice() {
        [analyzer] => Ok(analyzer),
        [] => Err("capture has no compatible saved I2C or SPI analyzer".to_owned()),
        analyzers => Err(format!(
            "multiple analyzers are compatible ({}); select one with --analyzer",
            analyzers
                .iter()
                .map(|analyzer| analyzer.name.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        )),
    }
}

fn apply_overrides(
    analyzer: &mut AnalyzerConfig,
    channel_overrides: &[String],
    number_overrides: &[String],
) -> Result<(), String> {
    for assignment in channel_overrides {
        let (title, value) = split_assignment(assignment)?;
        let setting = setting_mut(analyzer, title, "Channel")?;
        setting.setting["value"] = if value.eq_ignore_ascii_case("none") {
            Value::Null
        } else {
            json!(value
                .parse::<u32>()
                .map_err(|_| format!("invalid channel in {assignment}"))?)
        };
    }
    for assignment in number_overrides {
        let (title, value) = split_assignment(assignment)?;
        let setting = setting_mut(analyzer, title, "NumberList")?;
        setting.setting["value"] = json!(value
            .parse::<f64>()
            .map_err(|_| format!("invalid numeric value in {assignment}"))?);
    }
    Ok(())
}

fn split_assignment(assignment: &str) -> Result<(&str, &str), String> {
    let (title, value) = assignment
        .split_once('=')
        .ok_or_else(|| format!("expected TITLE=VALUE, got {assignment}"))?;
    let title = title.trim();
    let value = value.trim();
    if title.is_empty() || value.is_empty() {
        return Err(format!("expected TITLE=VALUE, got {assignment}"));
    }
    Ok((title, value))
}

fn setting_mut<'a>(
    analyzer: &'a mut AnalyzerConfig,
    title: &str,
    expected_kind: &str,
) -> Result<&'a mut sal::AnalyzerSetting, String> {
    let setting = analyzer
        .settings
        .iter_mut()
        .find(|setting| setting.title.eq_ignore_ascii_case(title))
        .ok_or_else(|| format!("{} has no setting named {title}", analyzer.name))?;
    if setting.kind() != Some(expected_kind) {
        return Err(format!("{title} is not a {expected_kind} setting"));
    }
    Ok(setting)
}

fn print_inspection(capture: &SalCapture, format: OutputFormat) -> Result<(), String> {
    if format == OutputFormat::Json {
        let channels = capture
            .channels
            .iter()
            .map(|channel| {
                json!({
                    "index": channel.index,
                    "label": capture.session.labels.get(usize::from(channel.index)),
                    "initial_high": channel.initial_high,
                    "transition_count": channel.transitions.len(),
                })
            })
            .collect::<Vec<_>>();
        let output = json!({
            "source": capture.source,
            "session": capture.session.name,
            "sample_rate_hz": capture.sample_rate_hz,
            "sample_count": capture.sample_count,
            "duration_seconds": capture.duration_seconds,
            "channels": channels,
            "analyzers": capture.session.analyzers,
        });
        println!(
            "{}",
            serde_json::to_string_pretty(&output).map_err(|error| error.to_string())?
        );
        return Ok(());
    }

    println!("Capture: {}", capture.source);
    println!("Session: {}", capture.session.name);
    println!("Sample rate: {} Hz", capture.sample_rate_hz);
    println!(
        "Samples: {} ({:.9} s)",
        capture.sample_count, capture.duration_seconds
    );
    println!("Channels:");
    for channel in &capture.channels {
        let label = capture
            .session
            .labels
            .get(usize::from(channel.index))
            .map(String::as_str)
            .unwrap_or("");
        println!(
            "  D{} {:<16} initial={} transitions={}",
            channel.index,
            label,
            if channel.initial_high { "high" } else { "low" },
            channel.transitions.len()
        );
    }
    println!("Analyzers:");
    for analyzer in &capture.session.analyzers {
        let status = if analyzer.is_supported() && analyzer.is_compatible(capture) {
            "ready"
        } else if analyzer.is_supported() {
            "missing channels"
        } else {
            "unsupported"
        };
        println!(
            "  {} ({}) [{status}]",
            analyzer.name, analyzer.analyzer_type
        );
        for setting in &analyzer.settings {
            let value = &setting.setting["value"];
            println!("    {} = {}", setting.title, value);
        }
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn print_frames(
    capture: &SalCapture,
    analyzer: &AnalyzerConfig,
    plugin: &PathBuf,
    frames: &[Frame],
    legacy_count: usize,
    offset: usize,
    limit: Option<usize>,
    format: OutputFormat,
) -> Result<(), String> {
    let selected = frames
        .iter()
        .skip(offset)
        .take(limit.unwrap_or(usize::MAX))
        .collect::<Vec<_>>();
    if format == OutputFormat::Json {
        let output = json!({
            "source": capture.source,
            "analyzer": analyzer.name,
            "analyzer_type": analyzer.analyzer_type,
            "plugin": plugin,
            "sample_rate_hz": capture.sample_rate_hz,
            "frame_count": frames.len(),
            "legacy_frame_count": legacy_count,
            "offset": offset,
            "returned_frame_count": selected.len(),
            "frames": selected,
        });
        println!(
            "{}",
            serde_json::to_string_pretty(&output).map_err(|error| error.to_string())?
        );
        return Ok(());
    }

    println!(
        "{} / {}: {} frames ({} legacy)",
        capture.source,
        analyzer.name,
        frames.len(),
        legacy_count
    );
    for frame in &selected {
        let fields = frame
            .fields
            .iter()
            .map(|field| format!("{}={}", field.key, display_value(&field.value)))
            .collect::<Vec<_>>()
            .join(" ");
        println!(
            "{} [{}..{}] {:.9}s {}",
            frame.frame_type,
            frame.start_sample,
            frame.end_sample,
            frame.start_sample as f64 / capture.sample_rate_hz as f64,
            fields
        );
    }
    if offset.saturating_add(selected.len()) < frames.len() {
        println!(
            "... {} more frames; use --offset/--limit to page",
            frames.len() - offset.saturating_add(selected.len())
        );
    }
    Ok(())
}

fn display_value(value: &FieldValue) -> String {
    match value {
        FieldValue::String(value) => value.clone(),
        FieldValue::Double(value) => value.to_string(),
        FieldValue::Integer(value) => value.to_string(),
        FieldValue::Boolean(value) => value.to_string(),
        FieldValue::Byte(value) => format!("0x{value:02x}"),
        FieldValue::Bytes(value) => value
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<Vec<_>>()
            .join(""),
    }
}
