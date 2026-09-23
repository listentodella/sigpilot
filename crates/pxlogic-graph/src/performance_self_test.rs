use std::{
    collections::BTreeMap,
    env, fs, io,
    process::Command,
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use pxlogic_core::{
    generate_sample_words_with_count, AnalyzerDecodeSettings, CaptureData, CaptureSettings,
    DecoderBackendKind, I2cDecodeSettings, PerformanceCapture, PerformanceEvent,
    SaleaeNativeDecoder, SpiDecodeSettings, UartDecodeSettings,
};
use pxlogic_waveform::WaveformRequest;
use serde::{Deserialize, Serialize};

use crate::{AnalyzerRenderRequest, AnalyzerTrackRequest, GraphFrameRequest, GraphSession};

pub const REPORT_SCHEMA: &str = "pxlogic.performance.decoder-self-test";
pub const REPORT_SCHEMA_VERSION: u32 = 1;
pub const DEFAULT_SAMPLE_SIZES: &[u64] = &[250_000, 2_500_000, 25_000_000];
pub const DEFAULT_WARMUP_ITERATIONS: usize = 1;
pub const DEFAULT_MEASURED_ITERATIONS: usize = 10;
pub const DEFAULT_POLL_INTERVAL_MS: u64 = 16;
pub const FIXTURE_CHANNEL_COUNT: u8 = 32;
pub const FIXTURE_SAMPLE_RATE_HZ: u64 = 25_000_000;
pub const FIXTURE_ID_PREFIX: &str = "pxlogic-demo-v1-32ch";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScenarioKind {
    Uart,
    I2c,
    Spi,
    I2cSpi,
}

impl ScenarioKind {
    pub const ALL: [Self; 4] = [Self::Uart, Self::I2c, Self::Spi, Self::I2cSpi];

    pub fn label(self) -> &'static str {
        match self {
            Self::Uart => "uart",
            Self::I2c => "i2c",
            Self::Spi => "spi",
            Self::I2cSpi => "i2c-spi",
        }
    }

    fn settings(self) -> Vec<AnalyzerDecodeSettings> {
        match self {
            Self::Uart => vec![AnalyzerDecodeSettings::Uart(UartDecodeSettings {
                channel: 0,
                baud_rate: 115_200,
                inverted: false,
                ..UartDecodeSettings::default()
            })],
            Self::I2c => vec![AnalyzerDecodeSettings::I2c(I2cDecodeSettings {
                sda_channel: 1,
                scl_channel: 2,
            })],
            Self::Spi => vec![AnalyzerDecodeSettings::Spi(SpiDecodeSettings {
                mosi_channel: Some(3),
                miso_channel: Some(4),
                clock_channel: 5,
                enable_channel: Some(6),
                enable_active_low: true,
                clock_polarity: false,
                clock_phase: false,
                bits_per_transfer: 8,
                msb_first: true,
            })],
            Self::I2cSpi => {
                let mut settings = Self::I2c.settings();
                settings.extend(Self::Spi.settings());
                settings
            }
        }
    }

    fn tracks(self) -> Vec<Vec<AnalyzerTrackRequest>> {
        match self {
            Self::Uart => vec![vec![AnalyzerTrackRequest {
                channel: 0,
                role: "RX".to_string(),
            }]],
            Self::I2c => vec![vec![AnalyzerTrackRequest {
                channel: 1,
                role: "SDA".to_string(),
            }]],
            Self::Spi => vec![vec![AnalyzerTrackRequest {
                channel: 3,
                role: "MOSI".to_string(),
            }]],
            Self::I2cSpi => vec![
                vec![AnalyzerTrackRequest {
                    channel: 1,
                    role: "SDA".to_string(),
                }],
                vec![AnalyzerTrackRequest {
                    channel: 3,
                    role: "MOSI".to_string(),
                }],
            ],
        }
    }

    fn protocols(self) -> Vec<&'static str> {
        match self {
            Self::Uart => vec!["UART"],
            Self::I2c => vec!["I2C"],
            Self::Spi => vec!["SPI"],
            Self::I2cSpi => vec!["I2C", "SPI"],
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SelfTestConfig {
    pub sample_sizes: Vec<u64>,
    pub scenarios: Vec<ScenarioSelection>,
    pub warmup_iterations: usize,
    pub measured_iterations: usize,
    pub poll_interval_ms: u64,
    pub output: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScenarioSelection {
    pub sample_count: u64,
    pub kind: ScenarioKind,
}

impl Default for SelfTestConfig {
    fn default() -> Self {
        Self {
            sample_sizes: DEFAULT_SAMPLE_SIZES.to_vec(),
            scenarios: DEFAULT_SAMPLE_SIZES
                .iter()
                .flat_map(|sample_count| {
                    ScenarioKind::ALL
                        .iter()
                        .copied()
                        .map(move |kind| ScenarioSelection {
                            sample_count: *sample_count,
                            kind,
                        })
                })
                .collect(),
            warmup_iterations: DEFAULT_WARMUP_ITERATIONS,
            measured_iterations: DEFAULT_MEASURED_ITERATIONS,
            poll_interval_ms: DEFAULT_POLL_INTERVAL_MS,
            output: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MetricSummary {
    pub iterations: usize,
    pub min_ms: f64,
    pub p50_ms: f64,
    pub p95_ms: f64,
    pub p99_ms: f64,
    pub max_ms: f64,
}

impl MetricSummary {
    pub fn from_values(values: &[f64]) -> Option<Self> {
        if values.is_empty() {
            return None;
        }
        let mut sorted = values.to_vec();
        sorted.sort_by(f64::total_cmp);
        Some(Self {
            iterations: sorted.len(),
            min_ms: sorted[0],
            p50_ms: nearest_rank(&sorted, 0.50),
            p95_ms: nearest_rank(&sorted, 0.95),
            p99_ms: nearest_rank(&sorted, 0.99),
            max_ms: *sorted.last().unwrap_or(&sorted[0]),
        })
    }
}

pub fn nearest_rank(sorted_values: &[f64], percentile: f64) -> f64 {
    assert!(
        !sorted_values.is_empty(),
        "percentile requires at least one value"
    );
    assert!((0.0..=1.0).contains(&percentile));
    let rank = ((sorted_values.len() as f64) * percentile).ceil() as usize;
    sorted_values[rank.saturating_sub(1).min(sorted_values.len() - 1)]
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PerformanceReport {
    pub schema: String,
    pub schema_version: u32,
    pub generated_unix_ms: u128,
    pub git_revision: String,
    pub git_worktree_dirty: Option<bool>,
    pub build: BuildInfo,
    pub host: HostInfo,
    pub fixture: FixtureInfo,
    pub measurement: MeasurementInfo,
    pub coverage: CoverageInfo,
    pub peak_memory: UnavailableMetric,
    pub scenarios: Vec<ScenarioReport>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BuildInfo {
    pub profile: String,
    pub release_valid: bool,
    pub invalid_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HostInfo {
    pub os: String,
    pub arch: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FixtureInfo {
    pub id_prefix: String,
    pub generator: String,
    pub sample_rate_hz: u64,
    pub channel_count: u8,
    pub sample_sizes: Vec<u64>,
    pub storage: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MeasurementInfo {
    pub warmup_iterations: usize,
    pub measured_iterations: usize,
    pub poll_interval_ms: u64,
    pub percentile: String,
    pub ui_visible_result: UnavailableMetric,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CoverageInfo {
    pub packed_dense_input: CoverageStatus,
    pub sparse_transition_index: CoverageStatus,
    pub explicit_sparse_capture_source: CoverageStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CoverageStatus {
    pub covered: bool,
    pub note: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct UnavailableMetric {
    pub available: bool,
    pub value_ms: Option<f64>,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ScenarioReport {
    pub id: String,
    pub status: String,
    pub sample_count: u64,
    pub protocols: Vec<String>,
    pub analyzer_count: usize,
    pub skip_reason: Option<String>,
    pub failure: Option<String>,
    pub input: ScenarioInput,
    pub first_run: Option<IterationReport>,
    pub warmup_runs: Vec<IterationReport>,
    pub measured_runs: Vec<IterationReport>,
    pub metrics: BTreeMap<String, MetricSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ScenarioInput {
    pub channel_count: u8,
    pub unitsize: u8,
    pub packed_input_bytes: u64,
    pub indexed_edge_count: Option<usize>,
    pub edge_count_reason: Option<String>,
    pub decoder_input: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct IterationReport {
    pub label: String,
    pub total_path_ms: f64,
    pub first_graph_result_ready_ms: Option<f64>,
    pub first_decoded_result_ms: Option<f64>,
    pub complete_decode_ms: Option<f64>,
    pub final_graph_frame_ms: Option<f64>,
    pub decoder_core_path_ms: Option<f64>,
    pub frame_count: usize,
    pub ipc_request_bytes: u64,
    pub ipc_response_bytes: u64,
    pub stage_totals_ms: BTreeMap<String, f64>,
    /// Call count per stage, keyed identically to `stage_totals_ms`. Divide the
    /// total by this to get the per-call cost, which is what says whether a
    /// stage is actually a bottleneck or merely called often.
    #[serde(default)]
    pub stage_counts: BTreeMap<String, u64>,
    /// Every individual call duration per stage, keyed identically to
    /// `stage_totals_ms`. Pooled across iterations so the report carries the
    /// per-call distribution, not just its mean.
    #[serde(default)]
    pub stage_call_ms: BTreeMap<String, Vec<f64>>,
    pub estimated_graph_memory_bytes: Option<u64>,
    pub notes: Vec<String>,
}

pub fn validate_config(config: &SelfTestConfig, release_build: bool) -> Result<(), String> {
    if !release_build {
        return Err(
            "performance self-test requires a release build; use cargo run --release".to_string(),
        );
    }
    if config.sample_sizes.is_empty() || config.scenarios.is_empty() {
        return Err("at least one sample size and scenario are required".to_string());
    }
    if config.warmup_iterations == 0 {
        return Err("warmup iterations must be at least 1".to_string());
    }
    if config.measured_iterations == 0 {
        return Err("measured iterations must be at least 1".to_string());
    }
    if config.poll_interval_ms > 10_000 {
        return Err("poll interval must not exceed 10000 ms".to_string());
    }
    if config.sample_sizes.iter().any(|count| *count == 0) {
        return Err("sample counts must be greater than zero".to_string());
    }
    Ok(())
}

pub fn run(config: &SelfTestConfig) -> PerformanceReport {
    let build = build_info();
    let mut report = base_report(config, build.clone());
    if !build.release_valid {
        report.scenarios = config
            .scenarios
            .iter()
            .copied()
            .map(|selection| {
                skipped_scenario(selection, "debug build is invalid for product benchmarks")
            })
            .collect();
        return report;
    }

    let _sidecar = match SaleaeNativeDecoder::from_env_cached()
        .and_then(|decoder| decoder.decoder_catalog().map(|_| decoder))
    {
        Ok(decoder) => Some(decoder),
        Err(error) => {
            let reason = format!("Saleae sidecar/runtime unavailable: {error}");
            report.scenarios = config
                .scenarios
                .iter()
                .copied()
                .map(|selection| skipped_scenario(selection, &reason))
                .collect();
            report.coverage.packed_dense_input.covered = false;
            report.coverage.sparse_transition_index.covered = false;
            report.coverage.packed_dense_input.note = reason.clone();
            report.coverage.sparse_transition_index.note = reason;
            return report;
        }
    };

    let mut captures = BTreeMap::new();
    for sample_count in &config.sample_sizes {
        let mut settings = CaptureSettings::default();
        settings.sample_rate_hz = FIXTURE_SAMPLE_RATE_HZ;
        settings.channel_count = FIXTURE_CHANNEL_COUNT;
        settings.enabled_channels = (0..FIXTURE_CHANNEL_COUNT).collect();
        match generate_sample_words_with_count(&settings, *sample_count, 4) {
            Ok(capture) => {
                captures.insert(*sample_count, capture);
            }
            Err(error) => {
                for selection in config
                    .scenarios
                    .iter()
                    .copied()
                    .filter(|selection| selection.sample_count == *sample_count)
                {
                    report
                        .scenarios
                        .push(failed_scenario(selection, error.to_string()));
                }
            }
        }
    }

    for selection in config.scenarios.iter().copied() {
        let Some(capture) = captures.get(&selection.sample_count) else {
            if !report
                .scenarios
                .iter()
                .any(|scenario| scenario.id == scenario_id(selection))
            {
                report.scenarios.push(skipped_scenario(
                    selection,
                    "fixture generation failed; see scenario failure entry",
                ));
            }
            continue;
        };
        match run_scenario(selection, capture, config) {
            Ok(scenario) => report.scenarios.push(scenario),
            Err(error) => report.scenarios.push(failed_scenario(selection, error)),
        }
    }

    report
        .scenarios
        .sort_by(|left, right| left.id.cmp(&right.id));
    report.coverage.packed_dense_input.covered = report
        .scenarios
        .iter()
        .any(|scenario| scenario.status == "passed");
    report.coverage.sparse_transition_index.covered = report
        .scenarios
        .iter()
        .any(|scenario| scenario.status == "passed");
    report
}

fn run_scenario(
    selection: ScenarioSelection,
    capture: &CaptureData,
    config: &SelfTestConfig,
) -> Result<ScenarioReport, String> {
    let settings = selection.kind.settings();
    let tracks = selection.kind.tracks();
    let session = GraphSession::default();
    session
        .finish_capture(capture.clone())
        .map_err(|error| format!("failed to build GraphSession fixture: {error}"))?;
    let edge_count = session.digital_edge_count();
    let input = ScenarioInput {
        channel_count: FIXTURE_CHANNEL_COUNT,
        unitsize: capture.metadata.unitsize,
        packed_input_bytes: capture.samples.len() as u64,
        indexed_edge_count: Some(edge_count),
        edge_count_reason: None,
        decoder_input: "GraphSession borrowed sparse transition index".to_string(),
    };

    let first_run = run_iteration(
        &session,
        selection,
        &settings,
        &tracks,
        config.poll_interval_ms,
        "first",
    )?;
    let mut warmup_runs = Vec::with_capacity(config.warmup_iterations);
    for index in 0..config.warmup_iterations {
        warmup_runs.push(run_iteration(
            &session,
            selection,
            &settings,
            &tracks,
            config.poll_interval_ms,
            &format!("warmup-{}", index + 1),
        )?);
    }
    let mut measured_runs = Vec::with_capacity(config.measured_iterations);
    for index in 0..config.measured_iterations {
        measured_runs.push(run_iteration(
            &session,
            selection,
            &settings,
            &tracks,
            config.poll_interval_ms,
            &format!("run-{}", index + 1),
        )?);
    }
    let metrics = summarize_iterations(&measured_runs);

    Ok(ScenarioReport {
        id: scenario_id(selection),
        status: "passed".to_string(),
        sample_count: selection.sample_count,
        protocols: selection
            .kind
            .protocols()
            .into_iter()
            .map(str::to_string)
            .collect(),
        analyzer_count: settings.len(),
        skip_reason: None,
        failure: None,
        input,
        first_run: Some(first_run),
        warmup_runs,
        measured_runs,
        metrics,
    })
}

fn run_iteration(
    session: &GraphSession,
    selection: ScenarioSelection,
    settings: &[AnalyzerDecodeSettings],
    tracks: &[Vec<AnalyzerTrackRequest>],
    poll_interval_ms: u64,
    label: &str,
) -> Result<IterationReport, String> {
    session.reset_analyzer_decode_state();
    let analyzer_requests = settings
        .iter()
        .enumerate()
        .map(|(index, setting)| AnalyzerRenderRequest {
            analyzer_id: format!("{}-{}", selection.kind.label(), index),
            backend: DecoderBackendKind::SaleaeNative,
            settings: setting.clone(),
            tracks: tracks.get(index).cloned().unwrap_or_default(),
        })
        .collect::<Vec<_>>();
    let waveform = WaveformRequest {
        start_sample: 0,
        sample_count: selection.sample_count,
        pixels: 1_200,
        channels: (0..FIXTURE_CHANNEL_COUNT).collect(),
    };
    let started = std::time::Instant::now();
    let capture = PerformanceCapture::start().map_err(str::to_string)?;
    let first_frame = session
        .render_frame(&GraphFrameRequest {
            frame_id: 1,
            waveform: waveform.clone(),
            include_tile: true,
            analyzer_view: None,
            analyzers: analyzer_requests.clone(),
            view: None,
        })
        .map_err(|error| format!("first graph frame failed: {error}"))?;
    let first_graph_result_ready_ms = started.elapsed().as_secs_f64() * 1_000.0;
    let mut first_decoded_result_ms =
        (visible_frame_count(&first_frame) > 0).then_some(first_graph_result_ready_ms);
    let mut frame_count = visible_frame_count(&first_frame);
    let complete_decode_ms = loop {
        let progress = session
            .decode_saleae_native_background_step_batch(settings)
            .map_err(|error| format!("background decode failed: {error}"))?;
        frame_count = frame_count.max(progress.iter().map(|item| item.frame_count).sum());
        if first_decoded_result_ms.is_none() && frame_count > 0 {
            first_decoded_result_ms = Some(started.elapsed().as_secs_f64() * 1_000.0);
        }
        if progress.iter().all(|item| item.complete) {
            break Some(started.elapsed().as_secs_f64() * 1_000.0);
        }
        thread::sleep(Duration::from_millis(poll_interval_ms));
    };
    let final_frame_started = std::time::Instant::now();
    session
        .render_frame(&GraphFrameRequest {
            frame_id: 2,
            waveform,
            include_tile: true,
            analyzer_view: None,
            analyzers: analyzer_requests,
            view: None,
        })
        .map_err(|error| format!("final graph frame failed: {error}"))?;
    let final_graph_frame_ms = final_frame_started.elapsed().as_secs_f64() * 1_000.0;
    let events = capture.finish();

    session.reset_analyzer_decode_state();
    let core_started = std::time::Instant::now();
    let core_capture = PerformanceCapture::start().map_err(str::to_string)?;
    let outputs = session
        .decode_saleae_native_frames_batch(settings)
        .map_err(|error| format!("full decoder path failed: {error}"))?;
    let decoder_core_path_ms = core_started.elapsed().as_secs_f64() * 1_000.0;
    frame_count = frame_count.max(outputs.iter().map(|frames| frames.len()).sum());
    let core_events = core_capture.finish();

    let ipc_request_bytes =
        sum_event_field(&events, "persistent_request_write", "request_bytes").saturating_add(
            sum_event_field(&core_events, "persistent_request_write", "request_bytes"),
        );
    let ipc_response_bytes = sum_event_field(&events, "persistent_response_read", "response_bytes")
        .saturating_add(sum_event_field(
            &events,
            "persistent_response_read",
            "binary_bytes",
        ))
        .saturating_add(sum_event_field(
            &core_events,
            "persistent_response_read",
            "response_bytes",
        ))
        .saturating_add(sum_event_field(
            &core_events,
            "persistent_response_read",
            "binary_bytes",
        ));
    let stage_totals_ms = merge_stage_totals(&events, "user")
        .into_iter()
        .chain(merge_stage_totals(&core_events, "core"))
        .collect();
    let stage_counts = merge_stage_counts(&events, "user")
        .into_iter()
        .chain(merge_stage_counts(&core_events, "core"))
        .collect();
    let stage_call_ms = merge_stage_call_durations(&events, "user")
        .into_iter()
        .chain(merge_stage_call_durations(&core_events, "core"))
        .collect();
    let estimated_graph_memory_bytes = Some(session.capture_memory_usage(0, None).total_bytes);

    Ok(IterationReport {
        label: label.to_string(),
        total_path_ms: started.elapsed().as_secs_f64() * 1_000.0,
        first_graph_result_ready_ms: Some(first_graph_result_ready_ms),
        first_decoded_result_ms,
        complete_decode_ms,
        final_graph_frame_ms: Some(final_graph_frame_ms),
        decoder_core_path_ms: Some(decoder_core_path_ms),
        frame_count,
        ipc_request_bytes,
        ipc_response_bytes,
        stage_totals_ms,
        stage_counts,
        stage_call_ms,
        estimated_graph_memory_bytes,
        notes: vec![
            "first_graph_result_ready_ms is backend GraphFrameResponse readiness, not browser paint"
                .to_string(),
            "decoder_core_path_ms is the synchronous full GraphSession decoder path".to_string(),
        ],
    })
}

fn summarize_iterations(iterations: &[IterationReport]) -> BTreeMap<String, MetricSummary> {
    let mut values: BTreeMap<String, Vec<f64>> = BTreeMap::new();
    for iteration in iterations {
        add_metric(&mut values, "total_path_ms", iteration.total_path_ms);
        add_optional_metric(
            &mut values,
            "first_graph_result_ready_ms",
            iteration.first_graph_result_ready_ms,
        );
        add_optional_metric(
            &mut values,
            "first_decoded_result_ms",
            iteration.first_decoded_result_ms,
        );
        add_optional_metric(
            &mut values,
            "complete_decode_ms",
            iteration.complete_decode_ms,
        );
        add_optional_metric(
            &mut values,
            "final_graph_frame_ms",
            iteration.final_graph_frame_ms,
        );
        add_optional_metric(
            &mut values,
            "decoder_core_path_ms",
            iteration.decoder_core_path_ms,
        );
        add_metric(
            &mut values,
            "ipc_request_bytes",
            iteration.ipc_request_bytes as f64,
        );
        add_metric(
            &mut values,
            "ipc_response_bytes",
            iteration.ipc_response_bytes as f64,
        );
        for (stage, value) in &iteration.stage_totals_ms {
            add_metric(&mut values, &format!("stage.{stage}"), *value);
            // Per-iteration mean, then percentiled across iterations. Taking
            // total_p50 / count_p50 instead would mix two different iterations.
            if let Some(count) = iteration.stage_counts.get(stage) {
                add_metric(&mut values, &format!("stage.{stage}.count"), *count as f64);
                if *count > 0 {
                    add_metric(
                        &mut values,
                        &format!("stage.{stage}.mean_ms"),
                        *value / *count as f64,
                    );
                }
            }
            // Pooled individual call durations. Unlike `mean_ms` this keeps a
            // bimodal stage (cache hit + full decode) visible, because each
            // call is a separate sample. For this key `iterations` in the
            // summary means total calls, not measured iterations.
            if let Some(calls) = iteration.stage_call_ms.get(stage) {
                for call in calls {
                    add_metric(&mut values, &format!("stage.{stage}.call"), *call);
                }
            }
        }
    }
    annotate_bimodal_stages(&mut values);
    values
        .into_iter()
        .filter_map(|(key, values)| {
            MetricSummary::from_values(&values).map(|summary| (key, summary))
        })
        .collect()
}

/// How many times slower than the stage's own median a call must be before it
/// counts as "slow". Relative rather than absolute, so it needs no per-stage
/// tuning: a stage is judged against its own typical cost.
const SLOW_CALL_MULTIPLIER: f64 = 2.0;

/// Enough samples that a median means something.
const MIN_SAMPLES_FOR_BIMODALITY: usize = 4;

/// Quantify a bimodal stage, and stay silent about the rest.
///
/// A stage like `analyzer_render` alternates between a cache hit and a full
/// decode. `p50` and `max` reveal that two branches exist, but not how the
/// calls are split between them or whether the slow branch owns the time —
/// which is exactly what decides whether the stage is worth optimizing.
///
/// Keys are only emitted for stages whose slowest call exceeds
/// `SLOW_CALL_MULTIPLIER` times their median, so **the presence of
/// `stage.<name>.slow_calls` is itself the signal that the stage is bimodal**,
/// and its absence means it is not.
fn annotate_bimodal_stages(values: &mut BTreeMap<String, Vec<f64>>) {
    let mut additions: Vec<(String, f64)> = Vec::new();
    for (key, samples) in values.iter() {
        let Some(stage) = key.strip_suffix(".call") else {
            continue;
        };
        if samples.len() < MIN_SAMPLES_FOR_BIMODALITY {
            continue;
        }
        let Some(summary) = MetricSummary::from_values(samples) else {
            continue;
        };
        let threshold = summary.p50_ms * SLOW_CALL_MULTIPLIER;
        if !(summary.max_ms > threshold) {
            continue;
        }
        let total_ms: f64 = samples.iter().sum();
        let slow: Vec<f64> = samples
            .iter()
            .copied()
            .filter(|sample| *sample > threshold)
            .collect();
        if slow.is_empty() {
            continue;
        }
        additions.push((format!("{stage}.slow_calls"), slow.len() as f64));
        additions.push((
            format!("{stage}.slow_time_share"),
            if total_ms > 0.0 {
                slow.iter().sum::<f64>() / total_ms
            } else {
                0.0
            },
        ));
    }
    for (key, value) in additions {
        values.entry(key).or_default().push(value);
    }
}

fn add_metric(values: &mut BTreeMap<String, Vec<f64>>, key: &str, value: f64) {
    values.entry(key.to_string()).or_default().push(value);
}

fn add_optional_metric(values: &mut BTreeMap<String, Vec<f64>>, key: &str, value: Option<f64>) {
    if let Some(value) = value {
        add_metric(values, key, value);
    }
}

/// One key builder shared by the totals and the counts, so the two maps can
/// never drift apart and a count always describes the total next to it.
fn stage_key(prefix: &str, event: &PerformanceEvent) -> String {
    match &event.backend {
        Some(backend) => format!("{}.{}.{}.{}", prefix, event.component, backend, event.stage),
        None => format!("{}.{}.{}", prefix, event.component, event.stage),
    }
}

fn merge_stage_totals(events: &[PerformanceEvent], prefix: &str) -> BTreeMap<String, f64> {
    let mut totals = BTreeMap::new();
    for event in events {
        *totals.entry(stage_key(prefix, event)).or_insert(0.0) += event.elapsed_ms;
    }
    totals
}

/// How many times each stage ran. Without this a total like
/// `user.graph.analyzer_render = 7.95 ms` cannot be turned into a per-call
/// cost, which is the number that decides whether a stage is a bottleneck.
fn merge_stage_counts(events: &[PerformanceEvent], prefix: &str) -> BTreeMap<String, u64> {
    let mut counts = BTreeMap::new();
    for event in events {
        *counts.entry(stage_key(prefix, event)).or_insert(0) += 1;
    }
    counts
}

/// Every individual call duration per stage.
///
/// A per-iteration mean cannot show that a stage is bimodal — one call served
/// from cache, the next doing the full decode — because the mean averages the
/// two together. Pooling the raw durations keeps the distribution, so a
/// `.call` percentile reveals the expensive branch that the mean hides.
fn merge_stage_call_durations(
    events: &[PerformanceEvent],
    prefix: &str,
) -> BTreeMap<String, Vec<f64>> {
    let mut durations: BTreeMap<String, Vec<f64>> = BTreeMap::new();
    for event in events {
        durations
            .entry(stage_key(prefix, event))
            .or_default()
            .push(event.elapsed_ms);
    }
    durations
}

fn sum_event_field(events: &[PerformanceEvent], stage: &str, field: &str) -> u64 {
    events
        .iter()
        .filter(|event| event.stage == stage)
        .filter_map(|event| event.fields.get(field))
        .filter_map(|value| value.parse::<u64>().ok())
        .sum()
}

fn visible_frame_count(frame: &crate::GraphFrameResponse) -> usize {
    frame
        .analyzers
        .iter()
        .flat_map(|analyzer| analyzer.tracks.iter())
        .map(|track| track.bubbles.len() + track.protocol_markers.len() + track.frame_refs.len())
        .sum()
}

fn scenario_id(selection: ScenarioSelection) -> String {
    format!(
        "{}-{}-{}",
        FIXTURE_ID_PREFIX,
        selection.sample_count,
        selection.kind.label()
    )
}

fn skipped_scenario(selection: ScenarioSelection, reason: &str) -> ScenarioReport {
    ScenarioReport {
        id: scenario_id(selection),
        status: "skipped".to_string(),
        sample_count: selection.sample_count,
        protocols: selection
            .kind
            .protocols()
            .into_iter()
            .map(str::to_string)
            .collect(),
        analyzer_count: selection.kind.settings().len(),
        skip_reason: Some(reason.to_string()),
        failure: None,
        input: skipped_input(selection.sample_count),
        first_run: None,
        warmup_runs: Vec::new(),
        measured_runs: Vec::new(),
        metrics: BTreeMap::new(),
    }
}

fn failed_scenario(selection: ScenarioSelection, error: String) -> ScenarioReport {
    let mut scenario = skipped_scenario(selection, "scenario execution failed");
    scenario.status = "failed".to_string();
    scenario.skip_reason = None;
    scenario.failure = Some(error);
    scenario
}

fn skipped_input(sample_count: u64) -> ScenarioInput {
    ScenarioInput {
        channel_count: FIXTURE_CHANNEL_COUNT,
        unitsize: 4,
        packed_input_bytes: sample_count.saturating_mul(4),
        indexed_edge_count: None,
        edge_count_reason: Some(
            "scenario was skipped before GraphSession fixture indexing".to_string(),
        ),
        decoder_input: "not run".to_string(),
    }
}

fn base_report(config: &SelfTestConfig, build: BuildInfo) -> PerformanceReport {
    let generated_unix_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let (git_revision, git_worktree_dirty) = git_info();
    PerformanceReport {
        schema: REPORT_SCHEMA.to_string(),
        schema_version: REPORT_SCHEMA_VERSION,
        generated_unix_ms,
        git_revision,
        git_worktree_dirty,
        build,
        host: HostInfo {
            os: env::consts::OS.to_string(),
            arch: env::consts::ARCH.to_string(),
        },
        fixture: FixtureInfo {
            id_prefix: FIXTURE_ID_PREFIX.to_string(),
            generator: "pxlogic-core::generate_sample_words_with_count".to_string(),
            sample_rate_hz: FIXTURE_SAMPLE_RATE_HZ,
            channel_count: FIXTURE_CHANNEL_COUNT,
            sample_sizes: config.sample_sizes.clone(),
            storage: "packed dense CaptureData; GraphSession builds borrowed sparse index".to_string(),
        },
        measurement: MeasurementInfo {
            warmup_iterations: config.warmup_iterations,
            measured_iterations: config.measured_iterations,
            poll_interval_ms: config.poll_interval_ms,
            percentile: "nearest-rank; rank=ceil(p*n), one-indexed".to_string(),
            ui_visible_result: UnavailableMetric {
                available: false,
                value_ms: None,
                reason: "browser IPC, React scheduling, and Canvas paint are not observable from the Rust CLI; phase 2".to_string(),
            },
        },
        coverage: CoverageInfo {
            packed_dense_input: CoverageStatus {
                covered: false,
                note: "not run yet".to_string(),
            },
            sparse_transition_index: CoverageStatus {
                covered: false,
                note: "not run yet".to_string(),
            },
            explicit_sparse_capture_source: CoverageStatus {
                covered: false,
                note: "explicit SparseCaptureData source is intentionally outside phase 1; native decode still consumes the GraphSession sparse view".to_string(),
            },
        },
        peak_memory: UnavailableMetric {
            available: false,
            value_ms: None,
            reason: "cross-platform peak RSS sampling is not instrumented; per-run GraphSession allocation estimate is reported instead".to_string(),
        },
        scenarios: Vec::new(),
    }
}

fn build_info() -> BuildInfo {
    if cfg!(debug_assertions) {
        BuildInfo {
            profile: "debug".to_string(),
            release_valid: false,
            invalid_reason: Some("debug assertions are enabled".to_string()),
        }
    } else {
        BuildInfo {
            profile: "release".to_string(),
            release_valid: true,
            invalid_reason: None,
        }
    }
}

fn git_info() -> (String, Option<bool>) {
    let revision = Command::new("git")
        .args(["rev-parse", "HEAD"])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
        .filter(|revision| !revision.is_empty())
        .unwrap_or_else(|| "unavailable".to_string());
    let dirty = Command::new("git")
        .args(["status", "--porcelain"])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| !output.stdout.is_empty());
    (revision, dirty)
}

pub fn write_report(report: &PerformanceReport, output: Option<&str>) -> io::Result<()> {
    let json = serde_json::to_string_pretty(report)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    match output {
        Some(path) if path != "-" => fs::write(path, format!("{json}\n")),
        _ => {
            println!("{json}");
            Ok(())
        }
    }
}

pub fn human_summary(report: &PerformanceReport) -> String {
    let passed = report
        .scenarios
        .iter()
        .filter(|scenario| scenario.status == "passed")
        .count();
    let skipped = report
        .scenarios
        .iter()
        .filter(|scenario| scenario.status == "skipped")
        .count();
    let failed = report
        .scenarios
        .iter()
        .filter(|scenario| scenario.status == "failed")
        .count();
    format!(
        "release_valid={} scenarios: passed={} skipped={} failed={} schema={} revision={}",
        report.build.release_valid,
        passed,
        skipped,
        failed,
        report.schema_version,
        report.git_revision
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nearest_rank_percentiles_are_deterministic() {
        let values = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0, 10.0];
        assert_eq!(nearest_rank(&values, 0.50), 5.0);
        assert_eq!(nearest_rank(&values, 0.95), 10.0);
        assert_eq!(nearest_rank(&values, 0.99), 10.0);
    }

    #[test]
    fn metric_summary_contains_required_percentiles() {
        let summary = MetricSummary::from_values(&[3.0, 1.0, 2.0]).unwrap();
        assert_eq!(summary.iterations, 3);
        assert_eq!(summary.min_ms, 1.0);
        assert_eq!(summary.p50_ms, 2.0);
        assert_eq!(summary.p95_ms, 3.0);
        assert_eq!(summary.p99_ms, 3.0);
        assert_eq!(summary.max_ms, 3.0);
    }

    #[test]
    fn debug_build_is_rejected_and_zero_iterations_are_invalid() {
        let mut config = SelfTestConfig::default();
        assert!(validate_config(&config, false).is_err());
        config.measured_iterations = 0;
        assert!(validate_config(&config, true).is_err());
    }

    fn event(component: &str, backend: Option<&str>, stage: &str, ms: f64) -> PerformanceEvent {
        PerformanceEvent {
            sequence: 0,
            component: component.to_string(),
            backend: backend.map(str::to_string),
            stage: stage.to_string(),
            elapsed_ms: ms,
            fields: BTreeMap::new(),
            detail: String::new(),
        }
    }

    #[test]
    fn stage_counts_use_the_same_keys_as_stage_totals() {
        // The whole point of the counts is that a reader can divide the total
        // beside them. If the two maps ever disagree on a key, the mean is
        // silently wrong, so pin the key sets together.
        let events = vec![
            event("graph", None, "analyzer_render", 4.0),
            event("graph", None, "analyzer_render", 6.0),
            event("graph", None, "waveform_tile", 0.5),
            event("decoder", Some("saleae"), "response_read", 1.0),
            event("decoder", Some("saleae"), "response_read", 3.0),
            event("decoder", Some("saleae"), "response_read", 2.0),
        ];

        let totals = merge_stage_totals(&events, "user");
        let counts = merge_stage_counts(&events, "user");

        assert_eq!(
            totals.keys().collect::<Vec<_>>(),
            counts.keys().collect::<Vec<_>>(),
            "totals and counts must be keyed identically"
        );
        assert_eq!(counts["user.graph.analyzer_render"], 2);
        assert_eq!(totals["user.graph.analyzer_render"], 10.0);
        assert_eq!(counts["user.graph.waveform_tile"], 1);
        // The backend is part of the key, so the same stage name under two
        // backends stays separable.
        assert_eq!(counts["user.decoder.saleae.response_read"], 3);
        assert_eq!(totals["user.decoder.saleae.response_read"], 6.0);
    }

    #[test]
    fn backend_participates_in_the_stage_key() {
        let with_backend = stage_key("user", &event("decoder", Some("saleae"), "read", 1.0));
        let without_backend = stage_key("user", &event("decoder", None, "read", 1.0));
        assert_eq!(with_backend, "user.decoder.saleae.read");
        assert_eq!(without_backend, "user.decoder.read");
        assert_ne!(with_backend, without_backend);
    }

    #[test]
    fn pooled_call_durations_keep_a_bimodal_stage_visible() {
        // The real case this exists for: analyzer_render called twice per
        // iteration, once served from cache and once doing the full decode.
        // The per-iteration mean lands in between and hides both branches;
        // pooling the raw calls keeps them.
        let events = vec![
            event("graph", None, "analyzer_render", 0.2),
            event("graph", None, "analyzer_render", 8.8),
        ];

        let durations = merge_stage_call_durations(&events, "user");
        let calls = &durations["user.graph.analyzer_render"];
        assert_eq!(calls.len(), 2, "each call stays a separate sample");
        assert_eq!(calls[0], 0.2);
        assert_eq!(calls[1], 8.8);

        let mean = merge_stage_totals(&events, "user")["user.graph.analyzer_render"] / 2.0;
        assert!(
            (mean - 4.5).abs() < f64::EPSILON,
            "the mean sits between the two branches and describes neither"
        );
    }

    #[test]
    fn pooled_call_durations_use_the_same_keys_as_stage_totals() {
        let events = vec![
            event("graph", None, "analyzer_render", 1.0),
            event("decoder", Some("saleae"), "response_read", 2.0),
        ];
        let totals = merge_stage_totals(&events, "user");
        let durations = merge_stage_call_durations(&events, "user");
        assert_eq!(
            totals.keys().collect::<Vec<_>>(),
            durations.keys().collect::<Vec<_>>()
        );
    }

    #[test]
    fn bimodal_stage_reports_how_many_calls_are_slow_and_what_they_cost() {
        // Five cache hits and five decodes, mirroring the real analyzer_render
        // shape. Half the calls are slow, but they own almost all the time.
        let mut values: BTreeMap<String, Vec<f64>> = BTreeMap::new();
        values.insert(
            "stage.user.graph.analyzer_render.call".to_string(),
            vec![0.4, 0.5, 0.5, 0.5, 0.6, 8.0, 8.2, 8.4, 8.5, 8.6],
        );

        annotate_bimodal_stages(&mut values);

        let slow = &values["stage.user.graph.analyzer_render.slow_calls"];
        assert_eq!(slow.as_slice(), &[5.0], "the five decode calls are the slow ones");
        let share = values["stage.user.graph.analyzer_render.slow_time_share"][0];
        assert!(
            share > 0.9,
            "half the calls own over 90% of the time, got {share}"
        );
    }

    #[test]
    fn unimodal_stage_gets_no_bimodality_keys() {
        // A stage whose calls are all within 2x of its median is not bimodal,
        // and the absence of the keys is how a reader knows that.
        let mut values: BTreeMap<String, Vec<f64>> = BTreeMap::new();
        values.insert(
            "stage.user.graph.waveform_tile.call".to_string(),
            vec![0.28, 0.29, 0.30, 0.31, 0.32],
        );

        annotate_bimodal_stages(&mut values);

        assert!(!values.contains_key("stage.user.graph.waveform_tile.slow_calls"));
        assert!(!values.contains_key("stage.user.graph.waveform_tile.slow_time_share"));
    }

    #[test]
    fn bimodality_is_skipped_when_there_are_too_few_samples() {
        // With two samples a "median" is not meaningful, so the annotation must
        // not fire and pretend the split is measured.
        let mut values: BTreeMap<String, Vec<f64>> = BTreeMap::new();
        values.insert("stage.x.call".to_string(), vec![0.1, 9.0]);

        annotate_bimodal_stages(&mut values);

        assert!(!values.contains_key("stage.x.slow_calls"));
    }

    #[test]
    fn bimodality_ignores_keys_that_are_not_call_distributions() {
        let mut values: BTreeMap<String, Vec<f64>> = BTreeMap::new();
        values.insert("stage.x".to_string(), vec![1.0, 100.0, 1.0, 100.0]);
        values.insert("stage.x.count".to_string(), vec![2.0, 2.0, 2.0, 2.0]);

        annotate_bimodal_stages(&mut values);

        assert!(!values.contains_key("stage.x.slow_calls"));
        assert!(!values.contains_key("stage.x.count.slow_calls"));
    }

    #[test]
    fn report_serialization_contains_required_schema_fields() {
        let report = base_report(&SelfTestConfig::default(), build_info());
        let value = serde_json::to_value(report).unwrap();
        for field in [
            "schema",
            "schema_version",
            "git_revision",
            "build",
            "host",
            "fixture",
            "measurement",
            "coverage",
            "peak_memory",
            "scenarios",
        ] {
            assert!(value.get(field).is_some(), "missing report field {field}");
        }
        assert_eq!(value["schema"], REPORT_SCHEMA);
        assert_eq!(value["schema_version"], REPORT_SCHEMA_VERSION);
    }

    #[test]
    fn skipped_scenario_keeps_reason_and_counts() {
        let scenario = skipped_scenario(
            ScenarioSelection {
                sample_count: 2_500_000,
                kind: ScenarioKind::I2cSpi,
            },
            "runtime missing",
        );
        assert_eq!(scenario.status, "skipped");
        assert_eq!(scenario.analyzer_count, 2);
        assert_eq!(scenario.skip_reason.as_deref(), Some("runtime missing"));
        assert!(scenario.measured_runs.is_empty());
    }
}
