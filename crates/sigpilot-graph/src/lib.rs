use std::{
    collections::{HashMap, HashSet},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

use parking_lot::{Mutex, RwLock};
use sigpilot_core::{
    resolve_enabled_channels, AnalyzerDecodeSettings, CaptureData, CaptureMetadata,
    CaptureTriggerMetadata, DecodedChannelValue, DecodedFrame, DecodedProtocolMarker,
    DecoderBackend, DecoderBackendKind, I2cDecodeSettings, SaleaeAsyncDecodeStep,
    SaleaeNativeDecoder, SigrokNativeDecoder, SparseCaptureData, SparseCaptureView,
    SparseDigitalChannel, SparseDigitalChannelView, SpiDecodeSettings, UartDecodeSettings,
};
use sigpilot_waveform::{ChannelTile, DigitalSegment, WaveformBin, WaveformRequest, WaveformTile};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use thiserror::Error;

pub mod performance_self_test;
pub mod view_state;

pub use view_state::{
    default_capture_view_samples, ease_out_cubic, maximum_view_samples, minimum_view_samples,
    normalize_capture_view, normalize_live_capture_view, SessionView, ViewAnimation, ViewIntent,
    ViewLimits,
};

const MAX_CHANNELS: u8 = 32;
const MAX_DECODED_FRAMES: usize = 100_000;

// Logic 2.4.43 BaseAnalyzerManager render limits. Bubble responses may grow
// with the viewport; the fixed 300-result limit is reserved for marker lists.
const MAX_ANALYZER_MARKER_RESULTS: usize = 300;
const MAX_ANALYZER_BUBBLE_RESULTS: usize = 4_096;
const MAX_MULTI_BUBBLE_STRINGS: usize = 400;
const MAX_PIXEL_WIDTH_FOR_MERGEABLE_FRAME: f64 = 15.0;
const MAX_PIXELS_BETWEEN_MERGEABLE_FRAMES: f64 = 30.0;
const MAX_COARSE_EDGE_MARKERS: usize = 400;
const PACKED_DIGITAL_BIN_BYTES: usize = 16;
const MAX_EXACT_SAMPLES_PER_PIXEL: u64 = 8;
const PIXELS_PER_EXACT_TRANSITION: u32 = 10;
const NATIVE_VIEW_EDGE_BUDGET: usize = 32_768;
const NATIVE_FIT_MAX_CHUNKS: usize = 16;
const NATIVE_FIT_EDGES_PER_CHUNK: usize = 1_024;
const NATIVE_CONTEXT_EDGES: usize = 256;
const NATIVE_CACHE_REUSE_EDGES: usize = 128;
const NATIVE_BACKGROUND_BODY_EDGES: usize = 131_072;
const NATIVE_BACKGROUND_CONTEXT_EDGES: usize = 4_096;
const MAX_ANALYZER_WINDOW_CACHE_ENTRIES: usize = 64;
const MAX_PARALLEL_ANALYZER_RENDERS: usize = 4;
const MAX_DEFAULT_PARALLEL_NATIVE_WINDOW_DECODES: usize = 4;
const MAX_PARALLEL_NATIVE_BACKGROUND_STEPS: usize = 4;
const MAX_PARALLEL_ANALYZER_TRACK_RENDERS: usize = 4;
const NATIVE_WINDOW_DECODE_WORKERS_ENV: &str = "SIGPILOT_NATIVE_WINDOW_DECODE_WORKERS";
static NEXT_GRAPH_SESSION_ID: AtomicU64 = AtomicU64::new(1);

fn trace_graph_timing(stage: &str, started: Instant, detail: &str) {
    let elapsed = started.elapsed();
    let elapsed_ms = elapsed.as_secs_f64() * 1_000.0;
    sigpilot_core::record_performance_event("graph", None, stage, elapsed, detail);
    tracing::debug!(
        target: "sigpilot::graph",
        component = "graph",
        stage,
        elapsed_ms,
        detail
    );
    if sigpilot_core::product_env("SIGPILOT_DECODER_TIMING").is_some() {
        eprintln!("[sigpilot-graph] stage={stage} elapsed_ms={elapsed_ms:.3} {detail}");
    }
}

pub type Result<T> = std::result::Result<T, GraphError>;

#[derive(Debug, Error)]
pub enum GraphError {
    #[error("capture graph is empty")]
    EmptyGraph,
    #[error("capture metadata is invalid")]
    InvalidMetadata,
    #[error("sample chunk is not aligned to the capture unit size")]
    UnalignedSamples,
    #[error("waveform request is invalid")]
    InvalidWaveformRequest,
    #[error("capture trim range is invalid")]
    InvalidTrimRange,
    #[error("analyzer settings are invalid: {0}")]
    InvalidAnalyzer(String),
    #[error("failed to serialize analyzer settings: {0}")]
    AnalyzerCacheKey(#[from] serde_json::Error),
    #[error("decoder backend failed: {0}")]
    DecoderBackend(String),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AnalyzerTrackRequest {
    pub channel: u8,
    pub role: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AnalyzerRenderRequest {
    pub analyzer_id: String,
    #[serde(default)]
    pub backend: DecoderBackendKind,
    pub settings: AnalyzerDecodeSettings,
    #[serde(default)]
    pub tracks: Vec<AnalyzerTrackRequest>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AnalyzerFrameTableRequest {
    pub analyzer_id: String,
    #[serde(default)]
    pub analyzer_name: String,
    #[serde(default)]
    pub backend: DecoderBackendKind,
    #[serde(default)]
    pub display_radix: String,
    pub settings: AnalyzerDecodeSettings,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AnalyzerFrameTableRow {
    pub analyzer_id: String,
    pub frame: DecodedFrame,
    pub frame_index: u64,
    pub frame_number: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AnalyzerFrameTableWindow {
    pub roles: Vec<String>,
    pub row_count: usize,
    pub rows: Vec<AnalyzerFrameTableRow>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NativeAnalyzerDecodeProgress {
    pub frame_count: usize,
    pub processed_edges: usize,
    pub total_edges: usize,
    pub progress: f64,
    pub complete: bool,
    pub cancelled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GraphFrameRequest {
    pub frame_id: u64,
    pub waveform: WaveformRequest,
    #[serde(default = "default_include_graph_tile")]
    pub include_tile: bool,
    #[serde(default)]
    pub analyzer_view: Option<WaveformRequest>,
    #[serde(default)]
    pub analyzers: Vec<AnalyzerRenderRequest>,
    /// When present, the backend applies this gesture to the session viewport and
    /// renders that instead of `waveform`'s range. `waveform` still carries the
    /// resolution and channel selection, so a caller migrating over can keep
    /// sending its old range without it being used.
    #[serde(default)]
    pub view: Option<ViewIntent>,
}

fn default_include_graph_tile() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GraphFrameResponse {
    pub frame_id: u64,
    pub revision: u64,
    pub sample_count: u64,
    /// The authoritative viewport this frame was rendered for.
    pub view: SessionView,
    /// The viewport the returned data was actually computed for. It trails
    /// `view` whenever the user kept moving while this frame was in flight, and
    /// the gap between the two is exactly what the frontend's residual pixel
    /// transform stretches. Saleae calls this `dataViewState`.
    pub data_view: SessionView,
    pub tile: WaveformTile,
    pub analyzers: Vec<AnalyzerRenderResult>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AnalyzerRenderResult {
    pub analyzer_id: String,
    pub tracks: Vec<AnalyzerTrackWindow>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AnalyzerTrackWindow {
    pub channel: u8,
    pub role: String,
    pub bubbles: Vec<AnalyzerBubble>,
    pub protocol_markers: Vec<AnalyzerProtocolMarker>,
    pub frame_refs: Vec<AnalyzerFrameRef>,
    pub previous_frame_ref: Option<AnalyzerFrameRef>,
    pub next_frame_ref: Option<AnalyzerFrameRef>,
    pub frames: Vec<DecodedFrame>,
    pub previous_frame: Option<DecodedFrame>,
    pub next_frame: Option<DecodedFrame>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub struct AnalyzerFrameRef {
    pub frame_id: u64,
    pub start_sample: u64,
    pub end_sample: u64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub struct AnalyzerProtocolMarker {
    pub sample: u64,
    pub kind: AnalyzerProtocolMarkerKind,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AnalyzerProtocolMarkerKind {
    Dot,
    ErrorDot,
    Square,
    ErrorSquare,
    UpArrow,
    DownArrow,
    X,
    ErrorX,
    Start,
    Stop,
    One,
    Zero,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AnalyzerBubble {
    #[serde(rename = "type")]
    pub bubble_type: AnalyzerBubbleType,
    pub frame_id_interval: FrameIdInterval,
    pub start_sample: u64,
    pub end_sample: u64,
    pub display_text: Vec<String>,
    pub result_count: u64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum AnalyzerBubbleType {
    SingleBubble,
    MultiBubble,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub struct FrameIdInterval {
    pub begin: u64,
    pub end: u64,
}

#[derive(Debug, Clone)]
struct DigitalChannelIndex {
    initial_high: bool,
    edges: Vec<u64>,
}

impl DigitalChannelIndex {
    fn new() -> Self {
        Self {
            initial_high: false,
            edges: Vec::new(),
        }
    }

    fn edge_count_at_or_before(&self, sample: u64) -> usize {
        self.edges.partition_point(|edge| *edge <= sample)
    }

    fn first_edge_after(&self, sample: u64) -> usize {
        self.edge_count_at_or_before(sample)
    }

    fn first_edge_at_or_after(&self, sample: u64) -> usize {
        self.edges.partition_point(|edge| *edge < sample)
    }

    fn level_at(&self, sample: u64) -> bool {
        self.initial_high ^ (self.edge_count_at_or_before(sample) % 2 == 1)
    }

    fn level_after_edge(&self, edge_index: usize) -> bool {
        self.initial_high ^ ((edge_index + 1) % 2 == 1)
    }

    fn edge(&self, edge_index: usize) -> u64 {
        self.edges[edge_index]
    }
}

/// Incremental, 32-channel digital graph used by capture, rendering and analyzers.
///
/// Raw samples are inspected exactly once while they are appended. All viewport
/// requests afterwards use sorted edge indexes and therefore scale with pixels,
/// not with capture duration.
#[derive(Debug, Clone)]
pub struct DigitalGraph {
    metadata: CaptureMetadata,
    channels: Vec<DigitalChannelIndex>,
    sample_count: u64,
    last_word: Option<u32>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub struct NearestDigitalTransition {
    pub previous_sample: Option<u64>,
    pub sample: u64,
    pub next_sample: Option<u64>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub struct DigitalPointMeasurement {
    pub channel: u8,
    pub cursor_sample: u64,
    pub high: bool,
    pub width_start_sample: u64,
    pub width_end_sample: u64,
    pub period_end_sample: Option<u64>,
}

impl DigitalGraph {
    pub fn new(mut metadata: CaptureMetadata) -> Result<Self> {
        validate_metadata(&metadata)?;
        metadata.sample_count = 0;
        Ok(Self {
            channels: (0..metadata.channel_count)
                .map(|_| DigitalChannelIndex::new())
                .collect(),
            metadata,
            sample_count: 0,
            last_word: None,
        })
    }

    pub fn from_capture(capture: &CaptureData) -> Result<Self> {
        let expected_bytes = usize::try_from(capture.metadata.sample_count)
            .ok()
            .and_then(|samples| samples.checked_mul(usize::from(capture.metadata.unitsize)))
            .ok_or(GraphError::InvalidMetadata)?;
        if capture.samples.len() < expected_bytes {
            return Err(GraphError::InvalidMetadata);
        }

        let mut graph = Self::new(capture.metadata.clone())?;
        graph.append_interleaved(&capture.samples[..expected_bytes])?;
        graph.metadata.sample_count = graph.sample_count;
        Ok(graph)
    }

    pub fn from_sparse_capture(capture: &SparseCaptureData) -> Result<Self> {
        let mut graph = Self::new(capture.metadata.clone())?;
        graph.sample_count = capture.metadata.sample_count;
        graph.metadata.sample_count = capture.metadata.sample_count;
        for sparse_channel in &capture.channels {
            if sparse_channel.channel >= capture.metadata.channel_count {
                return Err(GraphError::InvalidMetadata);
            }
            let index = &mut graph.channels[usize::from(sparse_channel.channel)];
            index.initial_high = sparse_channel.initial_high;
            if sparse_channel
                .transitions
                .windows(2)
                .any(|window| window[0] >= window[1])
                || sparse_channel
                    .transitions
                    .iter()
                    .any(|sample| *sample >= capture.metadata.sample_count)
            {
                return Err(GraphError::InvalidMetadata);
            }
            index.edges.clone_from(&sparse_channel.transitions);
        }
        Ok(graph)
    }

    fn sparse_view(&self) -> SparseCaptureView<'_> {
        SparseCaptureView {
            metadata: &self.metadata,
            channels: self
                .channels
                .iter()
                .enumerate()
                .map(|(channel, index)| SparseDigitalChannelView {
                    channel: channel as u8,
                    initial_high: index.initial_high,
                    transitions: &index.edges,
                })
                .collect(),
        }
    }

    fn trim(&mut self, start: u64, end: u64) -> Result<()> {
        if start >= end || end > self.sample_count {
            return Err(GraphError::InvalidTrimRange);
        }

        for channel in &mut self.channels {
            const fn shifted_edge(edge: u64, start: u64) -> u64 {
                edge - start
            }

            let initial_high = channel.level_at(start);
            let first_edge = channel.edges.partition_point(|edge| *edge <= start);
            let end_edge = channel.edges.partition_point(|edge| *edge < end);
            let retained_edges = end_edge.saturating_sub(first_edge);
            channel.edges.copy_within(first_edge..end_edge, 0);
            channel.edges.truncate(retained_edges);
            channel
                .edges
                .iter_mut()
                .for_each(|edge| *edge = shifted_edge(*edge, start));
            channel.initial_high = initial_high;
        }

        self.metadata = trimmed_metadata(&self.metadata, start, end)?;
        self.sample_count = end - start;
        self.last_word = Some(self.channels.iter().enumerate().fold(
            0u32,
            |word, (channel_index, channel)| {
                word | (u32::from(channel.level_at(self.sample_count - 1)) << channel_index)
            },
        ));
        Ok(())
    }

    pub fn append_interleaved(&mut self, samples: &[u8]) -> Result<u64> {
        let unit_size = usize::from(self.metadata.unitsize);
        if unit_size == 0 || samples.len() % unit_size != 0 {
            return Err(GraphError::UnalignedSamples);
        }
        for bytes in samples.chunks_exact(unit_size) {
            let word =
                read_word(bytes, self.metadata.unitsize).ok_or(GraphError::InvalidMetadata)?;
            let sample = self.sample_count;
            if let Some(previous) = self.last_word {
                let valid_mask = channel_mask(self.metadata.channel_count);
                let mut changed = (previous ^ word) & valid_mask;
                while changed != 0 {
                    let channel = changed.trailing_zeros() as usize;
                    self.channels[channel].edges.push(sample);
                    changed &= changed - 1;
                }
            } else {
                for channel in 0..self.metadata.channel_count {
                    self.channels[usize::from(channel)].initial_high =
                        word & (1u32 << channel) != 0;
                }
            }
            self.last_word = Some(word);
            self.sample_count = self.sample_count.saturating_add(1);
        }
        self.metadata.sample_count = self.sample_count;
        Ok(self.sample_count)
    }

    /// Appends PXLogic `LA_CROSS_DATA` without first transposing every sample
    /// into an interleaved word. Each lane is a little-endian 64-sample bitset.
    pub fn append_cross_lanes(
        &mut self,
        enabled_channels: &[u8],
        input: &[u8],
        reverse_bits_in_word: bool,
    ) -> Result<u64> {
        let enabled_channels =
            resolve_enabled_channels(self.metadata.channel_count, enabled_channels)
                .map_err(|_| GraphError::InvalidMetadata)?;
        if enabled_channels != self.metadata.enabled_channels {
            return Err(GraphError::InvalidMetadata);
        }
        let stripe_bytes = enabled_channels
            .len()
            .checked_mul(8)
            .ok_or(GraphError::InvalidMetadata)?;
        if stripe_bytes == 0 || input.len() % stripe_bytes != 0 {
            return Err(GraphError::UnalignedSamples);
        }

        for stripe in input.chunks_exact(stripe_bytes) {
            let stripe_start = self.sample_count;
            let mut next_word = 0u32;
            for (lane, physical_channel) in enabled_channels.iter().copied().enumerate() {
                let offset = lane * 8;
                let mut word = u64::from_le_bytes(
                    stripe[offset..offset + 8]
                        .try_into()
                        .expect("fixed cross-lane word"),
                );
                if reverse_bits_in_word {
                    word = word.reverse_bits();
                }

                let first_high = word & 1 != 0;
                let channel = &mut self.channels[usize::from(physical_channel)];
                if let Some(previous_word) = self.last_word {
                    let previous_high = previous_word & (1u32 << physical_channel) != 0;
                    if previous_high != first_high {
                        channel.edges.push(stripe_start);
                    }
                } else {
                    channel.initial_high = first_high;
                }

                // Bit n is set when sample n differs from sample n - 1. Bit 0
                // represents the boundary handled above and is discarded.
                let mut transitions = (word ^ (word << 1)) & !1u64;
                while transitions != 0 {
                    let bit = transitions.trailing_zeros() as u64;
                    channel.edges.push(stripe_start.saturating_add(bit));
                    transitions &= transitions - 1;
                }
                if word >> 63 != 0 {
                    next_word |= 1u32 << physical_channel;
                }
            }
            self.last_word = Some(next_word);
            self.sample_count = self.sample_count.saturating_add(64);
        }
        self.metadata.sample_count = self.sample_count;
        Ok(self.sample_count)
    }

    pub fn metadata(&self) -> &CaptureMetadata {
        &self.metadata
    }

    pub fn sample_count(&self) -> u64 {
        self.sample_count
    }

    pub fn nearest_transition(
        &self,
        channel: u8,
        sample: u64,
    ) -> Result<Option<NearestDigitalTransition>> {
        let index = self
            .channels
            .get(usize::from(channel))
            .ok_or(GraphError::InvalidWaveformRequest)?;
        let right = index.first_edge_at_or_after(sample);
        let left = right.checked_sub(1);
        let nearest_index = match (left, index.edges.get(right)) {
            (Some(left), Some(right_sample)) => {
                let left_sample = index.edge(left);
                if sample.saturating_sub(left_sample) <= right_sample.saturating_sub(sample) {
                    left
                } else {
                    right
                }
            }
            (Some(left), None) => left,
            (None, Some(_)) => right,
            (None, None) => return Ok(None),
        };
        Ok(Some(NearestDigitalTransition {
            previous_sample: nearest_index
                .checked_sub(1)
                .and_then(|previous| index.edges.get(previous).copied()),
            sample: index.edge(nearest_index),
            next_sample: index.edges.get(nearest_index + 1).copied(),
        }))
    }

    pub fn measure_point(
        &self,
        channel: u8,
        sample: u64,
    ) -> Result<Option<DigitalPointMeasurement>> {
        let index = self
            .channels
            .get(usize::from(channel))
            .ok_or(GraphError::InvalidWaveformRequest)?;
        if self.sample_count == 0 {
            return Ok(None);
        }

        let cursor_sample = sample.min(self.sample_count - 1);
        let width_end_index = index.first_edge_after(cursor_sample);
        let Some(width_start_index) = width_end_index.checked_sub(1) else {
            return Ok(None);
        };
        let Some(&width_end_sample) = index.edges.get(width_end_index) else {
            return Ok(None);
        };
        let width_start_sample = index.edge(width_start_index);

        Ok(Some(DigitalPointMeasurement {
            channel,
            cursor_sample,
            high: index.level_at(cursor_sample),
            width_start_sample,
            width_end_sample,
            period_end_sample: index.edges.get(width_end_index + 1).copied(),
        }))
    }

    fn set_trigger(&mut self, trigger: CaptureTriggerMetadata) {
        self.metadata.trigger = Some(trigger);
    }

    fn finish_metadata(&mut self, metadata: CaptureMetadata) -> Result<()> {
        validate_metadata(&metadata)?;
        let enabled_channels = metadata_enabled_channels(&metadata)?;
        let current_enabled_channels = metadata_enabled_channels(&self.metadata)?;
        if metadata.sample_count != self.sample_count
            || metadata.channel_count != self.metadata.channel_count
            || enabled_channels != current_enabled_channels
            || metadata.unitsize != self.metadata.unitsize
            || metadata.sample_rate_hz != self.metadata.sample_rate_hz
        {
            return Err(GraphError::InvalidMetadata);
        }
        self.metadata = metadata;
        Ok(())
    }

    pub fn build_tile(&self, request: &WaveformRequest) -> Result<WaveformTile> {
        if request.pixels == 0 || request.sample_count == 0 {
            return Err(GraphError::InvalidWaveformRequest);
        }

        let start = request.start_sample.min(self.sample_count);
        let end = start
            .saturating_add(request.sample_count)
            .min(self.sample_count);
        let visible_samples = end.saturating_sub(start);
        if visible_samples == 0 {
            return Ok(WaveformTile {
                start_sample: start,
                sample_count: 0,
                pixels: request.pixels,
                samples_per_pixel: 0.0,
                channels: Vec::new(),
            });
        }

        let bin_count = u64::from(request.pixels).min(visible_samples).max(1) as u32;
        let samples_per_bin = visible_samples as f64 / f64::from(bin_count);
        let requested_channels = requested_channels(request, self.metadata.channel_count);
        let exact_limit = u64::from(request.pixels)
            .saturating_mul(MAX_EXACT_SAMPLES_PER_PIXEL)
            .max(4096);
        let include_exact = visible_samples <= exact_limit;
        let build_channel = |channel| {
            self.build_channel_tile(
                channel,
                start,
                end,
                bin_count,
                samples_per_bin,
                include_exact,
            )
        };
        let channels: Vec<ChannelTile> = if requested_channels.len() > 4 {
            requested_channels
                .into_par_iter()
                .map(build_channel)
                .collect()
        } else {
            requested_channels.into_iter().map(build_channel).collect()
        };

        // `debug`, not `trace`: this is the statement that explains what the
        // renderer was actually handed, and a user who turns the `rendering`
        // module up to debug gets nothing at all if it sits at trace.
        tracing::debug!(
            target: "sigpilot::rendering",
            start_sample = start,
            visible_samples,
            pixels = bin_count,
            samples_per_pixel = samples_per_bin,
            channels = channels.len(),
            // The exact path is dropped once a viewport is dense enough that
            // individual transitions stop being drawn, which is the switch that
            // makes a zoomed-out waveform look different from a zoomed-in one.
            exact = include_exact,
            exact_limit_samples = exact_limit,
            "waveform tile built"
        );

        Ok(WaveformTile {
            start_sample: start,
            sample_count: visible_samples,
            pixels: bin_count,
            samples_per_pixel: samples_per_bin,
            channels,
        })
    }

    fn build_channel_tile(
        &self,
        channel: u8,
        start: u64,
        end: u64,
        bin_count: u32,
        samples_per_bin: f64,
        include_exact: bool,
    ) -> ChannelTile {
        let index = &self.channels[usize::from(channel)];
        let visible_samples = end - start;
        let mut bins = Vec::with_capacity(bin_count as usize);
        for x in 0..bin_count {
            let bin_start =
                start + ((f64::from(x) * samples_per_bin).floor() as u64).min(visible_samples);
            let bin_end = start
                + ((f64::from(x + 1) * samples_per_bin).ceil() as u64)
                    .min(visible_samples)
                    .max(1);
            bins.push(summarize_indexed_bin(index, x, bin_start, bin_end));
        }

        // PXView switches from individual transition lines to pixel-level
        // activity once the edge count exceeds roughly one transition per ten
        // pixels. This also bounds IPC payloads and frontend Path2D work.
        let first_edge = index.first_edge_after(start);
        let edge_end = index.first_edge_at_or_after(end);
        let exact_transition_budget = (bin_count / PIXELS_PER_EXACT_TRANSITION).max(1) as usize;
        let include_exact =
            include_exact && edge_end.saturating_sub(first_edge) < exact_transition_budget;
        let (segments, rising_edges, falling_edges) = if include_exact {
            exact_channel_data(index, start, end)
        } else {
            let (rising, falling) = sampled_channel_edges(index, start, end);
            (Vec::new(), rising, falling)
        };
        let previous_transition = index
            .first_edge_at_or_after(start)
            .checked_sub(1)
            .map(|edge_index| index.edge(edge_index));
        let next_edge_index = index.first_edge_at_or_after(end);
        let next_transition =
            (next_edge_index < index.edges.len()).then(|| index.edge(next_edge_index));
        let label = self
            .metadata
            .labels
            .get(usize::from(channel))
            .cloned()
            .unwrap_or_else(|| format!("D{channel}"));

        let packed_bins = pack_digital_bins(&bins);
        ChannelTile {
            channel,
            label,
            bins: Vec::new(),
            packed_bins: Some(packed_bins),
            segments,
            rising_edges,
            falling_edges,
            previous_transition,
            next_transition,
        }
    }

    fn decode(&self, settings: &AnalyzerDecodeSettings) -> Result<Vec<DecodedFrame>> {
        self.decode_from(settings, 0)
    }

    fn decode_from(
        &self,
        settings: &AnalyzerDecodeSettings,
        start_sample: u64,
    ) -> Result<Vec<DecodedFrame>> {
        match settings {
            AnalyzerDecodeSettings::Uart(settings) => self.decode_uart_from(settings, start_sample),
            AnalyzerDecodeSettings::I2c(settings) => self.decode_i2c_from(settings, start_sample),
            AnalyzerDecodeSettings::Spi(settings) => self.decode_spi_from(settings, start_sample),
            AnalyzerDecodeSettings::Native(settings) => Err(GraphError::InvalidAnalyzer(format!(
                "{} requires a Saleae Native or Sigrok Native decoder backend",
                settings.protocol_name
            ))),
        }
    }

    fn decode_uart_from(
        &self,
        settings: &UartDecodeSettings,
        start_sample: u64,
    ) -> Result<Vec<DecodedFrame>> {
        self.validate_channel(settings.channel)?;
        if settings.baud_rate == 0 {
            return Err(GraphError::InvalidAnalyzer(
                "UART baud rate must be non-zero".to_string(),
            ));
        }
        let bit_period = self.metadata.sample_rate_hz as f64 / f64::from(settings.baud_rate);
        if bit_period < 2.0 {
            return Err(GraphError::InvalidAnalyzer(
                "sample rate is too low for the selected UART baud rate".to_string(),
            ));
        }

        let channel = &self.channels[usize::from(settings.channel)];
        let mut collector = FrameCollector::default();
        let resume_sample = start_sample.saturating_sub((bit_period * 11.0).ceil() as u64);
        let mut edge_index = channel.first_edge_at_or_after(resume_sample);
        while edge_index < channel.edges.len() {
            let sample = channel.edge(edge_index);
            let physical_after = channel.level_after_edge(edge_index);
            let logical_after = physical_after ^ settings.inverted;
            if logical_after
                || sample.saturating_add((10.0 * bit_period).ceil() as u64) >= self.sample_count
                || (self.level_at_offset(settings.channel, sample, bit_period * 0.5)?
                    ^ settings.inverted)
            {
                edge_index += 1;
                continue;
            }

            let mut value = 0u8;
            let mut valid = true;
            for bit_index in 0..8 {
                let bit_sample =
                    sample + (bit_period * (1.5 + f64::from(bit_index))).round() as u64;
                if bit_sample >= self.sample_count {
                    valid = false;
                    break;
                }
                if self.level_at(settings.channel, bit_sample)? ^ settings.inverted {
                    value |= 1u8 << bit_index;
                }
            }
            let stop_sample = sample + (bit_period * 9.5).round() as u64;
            if valid
                && stop_sample < self.sample_count
                && (self.level_at(settings.channel, stop_sample)? ^ settings.inverted)
            {
                let label = label_for_value(u64::from(value), 8);
                collector.push(DecodedFrame {
                    frame_id: 0,
                    start_sample: sample,
                    end_sample: sample + (bit_period * 10.0).ceil() as u64,
                    frame_type: "data".to_string(),
                    label: label.clone(),
                    value: u64::from(value),
                    channel_values: vec![DecodedChannelValue {
                        channel: settings.channel,
                        role: "Input".to_string(),
                        label: label.clone(),
                        texts: vec![label],
                        value: u64::from(value),
                    }],
                    protocol_markers: Vec::new(),
                });
                let skip_until = sample + (bit_period * 9.0).floor() as u64;
                edge_index = channel.edges.partition_point(|edge| *edge < skip_until);
            } else {
                edge_index += 1;
            }
        }
        Ok(collector.finish())
    }

    fn decode_i2c_from(
        &self,
        settings: &I2cDecodeSettings,
        start_sample: u64,
    ) -> Result<Vec<DecodedFrame>> {
        self.validate_channel(settings.sda_channel)?;
        self.validate_channel(settings.scl_channel)?;
        if settings.sda_channel == settings.scl_channel {
            return Err(GraphError::InvalidAnalyzer(
                "I2C SDA and SCL must use different channels".to_string(),
            ));
        }
        if self.sample_count < 2 {
            return Ok(Vec::new());
        }

        let sda_index = &self.channels[usize::from(settings.sda_channel)];
        let scl_index = &self.channels[usize::from(settings.scl_channel)];
        let resume_sample = self.i2c_resume_sample(settings, start_sample);
        let mut sda_edge = sda_index.first_edge_at_or_after(resume_sample);
        let mut scl_edge = scl_index.first_edge_at_or_after(resume_sample);
        let previous_sample = resume_sample.saturating_sub(1);
        let mut previous_sda = sda_index.level_at(previous_sample);
        let mut previous_scl = scl_index.level_at(previous_sample);
        let mut active = false;
        let mut byte = 0u8;
        let mut bit_count = 0u8;
        let mut byte_index = 0u64;
        let mut byte_start = 0u64;
        let mut collector = FrameCollector::default();

        while sda_edge < sda_index.edges.len() || scl_edge < scl_index.edges.len() {
            let next_sda = sda_index.edges.get(sda_edge).copied().unwrap_or(u64::MAX);
            let next_scl = scl_index.edges.get(scl_edge).copied().unwrap_or(u64::MAX);
            let sample = next_sda.min(next_scl);
            if sample == u64::MAX {
                break;
            }

            let mut sda = previous_sda;
            let mut scl = previous_scl;
            if next_sda == sample {
                sda = !sda;
                sda_edge += 1;
            }
            if next_scl == sample {
                scl = !scl;
                scl_edge += 1;
            }

            let start = previous_sda && !sda && scl;
            let stop = !previous_sda && sda && scl;
            if start {
                active = true;
                byte = 0;
                bit_count = 0;
                byte_index = 0;
                byte_start = sample;
            } else if stop && active {
                active = false;
                bit_count = 0;
            } else if active && !previous_scl && scl {
                if bit_count < 8 {
                    if bit_count == 0 {
                        byte_start = sample;
                    }
                    byte = (byte << 1) | u8::from(sda);
                    bit_count += 1;
                } else {
                    let acknowledged = !sda;
                    let bubble_label = if byte_index == 0 {
                        format!(
                            "Setup {} to [0x{:02X}] + {}",
                            if byte & 1 == 0 { "Write" } else { "Read" },
                            byte >> 1,
                            if acknowledged { "ACK" } else { "NAK" }
                        )
                    } else {
                        format!(
                            "{} + {}",
                            label_for_value(u64::from(byte), 8),
                            if acknowledged { "ACK" } else { "NAK" }
                        )
                    };
                    let label = if byte_index == 0 {
                        format!(
                            "Address 0x{:02X} {} {}",
                            byte >> 1,
                            if byte & 1 == 0 { "Write" } else { "Read" },
                            if acknowledged { "ACK" } else { "NAK" }
                        )
                    } else {
                        format!(
                            "Data {} {}",
                            label_for_value(u64::from(byte), 8),
                            if acknowledged { "ACK" } else { "NAK" }
                        )
                    };
                    collector.push(DecodedFrame {
                        frame_id: 0,
                        start_sample: byte_start,
                        end_sample: sample.saturating_add(1),
                        frame_type: if byte_index == 0 { "address" } else { "data" }.to_string(),
                        label,
                        value: u64::from(byte),
                        channel_values: vec![DecodedChannelValue {
                            channel: settings.sda_channel,
                            role: "SDA".to_string(),
                            label: bubble_label.clone(),
                            texts: vec![bubble_label],
                            value: u64::from(byte),
                        }],
                        protocol_markers: Vec::new(),
                    });
                    byte = 0;
                    bit_count = 0;
                    byte_index += 1;
                }
            }
            previous_sda = sda;
            previous_scl = scl;
        }
        Ok(collector.finish())
    }

    fn i2c_resume_sample(&self, settings: &I2cDecodeSettings, start_sample: u64) -> u64 {
        if start_sample == 0 {
            return 0;
        }
        let sda = &self.channels[usize::from(settings.sda_channel)];
        let scl = &self.channels[usize::from(settings.scl_channel)];
        let mut edge = sda.first_edge_at_or_after(start_sample);
        while edge > 0 {
            edge -= 1;
            let sample = sda.edge(edge);
            if scl.level_at(sample) {
                return sample;
            }
        }
        0
    }

    fn decode_spi_from(
        &self,
        settings: &SpiDecodeSettings,
        start_sample: u64,
    ) -> Result<Vec<DecodedFrame>> {
        self.validate_channel(settings.clock_channel)?;
        for channel in [
            settings.mosi_channel,
            settings.miso_channel,
            settings.enable_channel,
        ]
        .into_iter()
        .flatten()
        {
            self.validate_channel(channel)?;
            if channel == settings.clock_channel {
                return Err(GraphError::InvalidAnalyzer(
                    "SPI clock must use a different channel than data and enable".to_string(),
                ));
            }
        }
        if settings.mosi_channel.is_none() && settings.miso_channel.is_none() {
            return Err(GraphError::InvalidAnalyzer(
                "SPI requires a MOSI or MISO channel".to_string(),
            ));
        }
        if !(1..=64).contains(&settings.bits_per_transfer) {
            return Err(GraphError::InvalidAnalyzer(
                "SPI bits per transfer must be between 1 and 64".to_string(),
            ));
        }

        let clock = &self.channels[usize::from(settings.clock_channel)];
        let sample_rising_edge = settings.clock_polarity == settings.clock_phase;
        let mut collector = FrameCollector::default();
        let mut transfer_start = 0u64;
        let mut bit_count = 0u8;
        let mut mosi_value = 0u64;
        let mut miso_value = 0u64;

        let resume_edge = settings.enable_channel.map_or(0, |enable_channel| {
            let enable = &self.channels[usize::from(enable_channel)];
            let mut edge = enable.first_edge_at_or_after(start_sample);
            while edge > 0 {
                edge -= 1;
                let asserted = enable.level_after_edge(edge) != settings.enable_active_low;
                if asserted {
                    return clock.first_edge_at_or_after(enable.edge(edge));
                }
            }
            0
        });
        for (edge_index, sample) in clock.edges.iter().copied().enumerate().skip(resume_edge) {
            let rising = clock.level_after_edge(edge_index);
            if rising != sample_rising_edge {
                continue;
            }
            let enabled = settings.enable_channel.map_or(Ok(true), |channel| {
                self.level_at(channel, sample)
                    .map(|level| level != settings.enable_active_low)
            })?;
            if !enabled {
                bit_count = 0;
                mosi_value = 0;
                miso_value = 0;
                continue;
            }
            if bit_count == 0 {
                transfer_start = sample;
            }
            if let Some(channel) = settings.mosi_channel {
                mosi_value = append_spi_bit(
                    mosi_value,
                    self.level_at(channel, sample)?,
                    bit_count,
                    settings.bits_per_transfer,
                    settings.msb_first,
                );
            }
            if let Some(channel) = settings.miso_channel {
                miso_value = append_spi_bit(
                    miso_value,
                    self.level_at(channel, sample)?,
                    bit_count,
                    settings.bits_per_transfer,
                    settings.msb_first,
                );
            }
            bit_count += 1;

            if bit_count == settings.bits_per_transfer {
                let mut channel_values = Vec::new();
                if let Some(channel) = settings.mosi_channel {
                    channel_values.push(DecodedChannelValue {
                        channel,
                        role: "MOSI".to_string(),
                        label: label_for_value(mosi_value, settings.bits_per_transfer),
                        texts: vec![label_for_value(mosi_value, settings.bits_per_transfer)],
                        value: mosi_value,
                    });
                }
                if let Some(channel) = settings.miso_channel {
                    channel_values.push(DecodedChannelValue {
                        channel,
                        role: "MISO".to_string(),
                        label: label_for_value(miso_value, settings.bits_per_transfer),
                        texts: vec![label_for_value(miso_value, settings.bits_per_transfer)],
                        value: miso_value,
                    });
                }
                let label = match (settings.mosi_channel, settings.miso_channel) {
                    (Some(_), Some(_)) => format!(
                        "MOSI {} / MISO {}",
                        label_for_value(mosi_value, settings.bits_per_transfer),
                        label_for_value(miso_value, settings.bits_per_transfer)
                    ),
                    (Some(_), None) => format!(
                        "MOSI {}",
                        label_for_value(mosi_value, settings.bits_per_transfer)
                    ),
                    (None, Some(_)) => format!(
                        "MISO {}",
                        label_for_value(miso_value, settings.bits_per_transfer)
                    ),
                    (None, None) => unreachable!(),
                };
                collector.push(DecodedFrame {
                    frame_id: 0,
                    start_sample: transfer_start,
                    end_sample: sample.saturating_add(1),
                    frame_type: "result".to_string(),
                    label,
                    value: settings.mosi_channel.map_or(miso_value, |_| mosi_value),
                    channel_values,
                    protocol_markers: Vec::new(),
                });
                bit_count = 0;
                mosi_value = 0;
                miso_value = 0;
            }
        }
        Ok(collector.finish())
    }

    fn validate_channel(&self, channel: u8) -> Result<()> {
        if channel < self.metadata.channel_count {
            Ok(())
        } else {
            Err(GraphError::InvalidAnalyzer(format!(
                "channel {channel} is outside the capture"
            )))
        }
    }

    fn level_at(&self, channel: u8, sample: u64) -> Result<bool> {
        self.validate_channel(channel)?;
        if sample >= self.sample_count {
            return Err(GraphError::InvalidAnalyzer(format!(
                "sample {sample} is outside the capture"
            )));
        }
        Ok(self.channels[usize::from(channel)].level_at(sample))
    }

    fn level_at_offset(&self, channel: u8, start: u64, offset: f64) -> Result<bool> {
        self.level_at(channel, start.saturating_add(offset.round() as u64))
    }
}

fn sparse_capture_view(capture: &SparseCaptureData) -> SparseCaptureView<'_> {
    SparseCaptureView {
        metadata: &capture.metadata,
        channels: capture
            .channels
            .iter()
            .map(|channel| SparseDigitalChannelView {
                channel: channel.channel,
                initial_high: channel.initial_high,
                transitions: &channel.transitions,
            })
            .collect(),
    }
}

fn empty_waveform_tile(request: &WaveformRequest) -> WaveformTile {
    WaveformTile {
        start_sample: request.start_sample,
        sample_count: 0,
        pixels: request.pixels,
        samples_per_pixel: 0.0,
        channels: Vec::new(),
    }
}

/// Per-UI-session graph state. Analyzer frames are cached by settings and are
/// invalidated whenever new samples arrive.
#[derive(Debug)]
pub struct GraphSession {
    instance_id: u64,
    graph: RwLock<Option<DigitalGraph>>,
    capture: RwLock<Option<Arc<CaptureData>>>,
    sparse_capture: RwLock<Option<Arc<SparseCaptureData>>>,
    analyzer_cache: Mutex<HashMap<String, AnalyzerCacheEntry>>,
    native_window_cache: Mutex<HashMap<NativeWindowCacheKey, NativeWindowCacheEntry>>,
    native_background_cache: Mutex<HashMap<String, NativeBackgroundDecodeState>>,
    analyzer_generation: AtomicU64,
    revision: AtomicU64,
    /// Authoritative viewport. `None` until a caller sets one, in which case the
    /// session falls back to fitting the whole capture.
    view: Mutex<Option<SessionView>>,
    /// An in-flight glide. It is resolved by `session_view` against the wall
    /// clock rather than stepped by the frontend, so the animated view and the
    /// view the data was rendered for share one time source.
    view_animation: Mutex<Option<ViewAnimation>>,
    view_limits: Mutex<ViewLimits>,
}

impl Default for GraphSession {
    fn default() -> Self {
        let instance_id = NEXT_GRAPH_SESSION_ID.fetch_add(1, Ordering::Relaxed);
        tracing::info!(
            target: "sigpilot::graph",
            session_id = instance_id,
            "graph session created"
        );
        Self {
            instance_id,
            graph: RwLock::new(None),
            capture: RwLock::new(None),
            sparse_capture: RwLock::new(None),
            analyzer_cache: Mutex::new(HashMap::new()),
            native_window_cache: Mutex::new(HashMap::new()),
            native_background_cache: Mutex::new(HashMap::new()),
            analyzer_generation: AtomicU64::new(0),
            revision: AtomicU64::new(0),
            view: Mutex::new(None),
            view_animation: Mutex::new(None),
            view_limits: Mutex::new(ViewLimits::default()),
        }
    }
}

#[derive(Debug, Clone)]
struct AnalyzerCacheEntry {
    decoded_sample_count: u64,
    complete: bool,
    frames: Arc<Vec<DecodedFrame>>,
    table_roles: Arc<Vec<String>>,
    table_search_texts: Arc<Mutex<HashMap<String, Arc<Vec<String>>>>>,
    table_search_matches: Arc<Mutex<HashMap<String, Arc<Vec<usize>>>>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct NativeWindowCacheKey {
    analyzer_key: String,
    start_sample: u64,
    end_sample: u64,
}

#[derive(Debug, Clone)]
struct NativeWindowCacheEntry {
    decoded_sample_count: u64,
    start_sample: u64,
    end_sample: u64,
    frames: Arc<Vec<DecodedFrame>>,
}

#[derive(Debug)]
struct NativeBackgroundDecodeState {
    generation: u64,
    decoded_sample_count: u64,
    next_driver_edge: usize,
    total_driver_edges: usize,
    frames: Vec<DecodedFrame>,
    async_decode_id: String,
    async_started: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct NativeBackgroundWindow {
    body_edge_begin: usize,
    body_edge_end: usize,
    retain_start_sample: u64,
    retain_end_sample: u64,
    decode_start_sample: u64,
    decode_end_sample: u64,
}

struct NativeBackgroundPending<'a> {
    key: String,
    settings: &'a AnalyzerDecodeSettings,
    window: NativeBackgroundWindow,
    progress_numerator: usize,
    progress_denominator: usize,
}

struct NativeBackgroundDecoded {
    key: String,
    window: NativeBackgroundWindow,
    frames: Arc<Vec<DecodedFrame>>,
}

struct SaleaeBatchRenderState<'a> {
    request_index: usize,
    request: &'a AnalyzerRenderRequest,
    full_cache_key: String,
    window_cache_key: String,
    windows: Vec<(u64, u64)>,
    missing_windows: Vec<(u64, u64)>,
    frames: Vec<DecodedFrame>,
    window_entries: Vec<NativeWindowCacheEntry>,
}

struct SaleaeBatchWindowDecodeResult {
    pending_index: usize,
    start_sample: u64,
    end_sample: u64,
    frames: Arc<Vec<DecodedFrame>>,
}

struct SaleaeBatchFinalizedRender {
    request_index: usize,
    full_cache_key: String,
    window_cache_key: String,
    window_cache_entry: AnalyzerCacheEntry,
    full_cache_entry: Option<(String, AnalyzerCacheEntry)>,
    window_entries: Vec<NativeWindowCacheEntry>,
    render: AnalyzerRenderResult,
}

#[derive(Debug, Clone)]
struct AnalyzerFrameTableSource {
    analyzer_id: String,
    analyzer_name_search: String,
    display_radix: String,
    frames: Arc<Vec<DecodedFrame>>,
    roles: Arc<Vec<String>>,
    search_texts: Option<Arc<Vec<String>>>,
    search_matches: Option<Arc<Vec<usize>>>,
}

fn analyzer_cache_entry(
    decoded_sample_count: u64,
    frames: Arc<Vec<DecodedFrame>>,
) -> AnalyzerCacheEntry {
    let table_roles = Arc::new(analyzer_frame_roles(&frames));
    AnalyzerCacheEntry {
        decoded_sample_count,
        complete: true,
        frames,
        table_roles,
        table_search_texts: Arc::new(Mutex::new(HashMap::new())),
        table_search_matches: Arc::new(Mutex::new(HashMap::new())),
    }
}

fn partial_analyzer_cache_entry(
    decoded_sample_count: u64,
    frames: Arc<Vec<DecodedFrame>>,
) -> AnalyzerCacheEntry {
    let mut entry = analyzer_cache_entry(decoded_sample_count, frames);
    entry.complete = false;
    entry
}

fn decoded_frame_vec_allocated_bytes(frames: &Vec<DecodedFrame>) -> u64 {
    frames.iter().fold(
        u64::try_from(
            frames
                .capacity()
                .saturating_mul(std::mem::size_of::<DecodedFrame>()),
        )
        .unwrap_or(u64::MAX),
        |bytes, frame| {
            let frame_strings = frame
                .frame_type
                .capacity()
                .saturating_add(frame.label.capacity());
            let channel_values = frame.channel_values.iter().fold(
                frame
                    .channel_values
                    .capacity()
                    .saturating_mul(std::mem::size_of::<DecodedChannelValue>()),
                |channel_bytes, value| {
                    channel_bytes
                        .saturating_add(value.role.capacity())
                        .saturating_add(value.label.capacity())
                },
            );
            bytes
                .saturating_add(u64::try_from(frame_strings).unwrap_or(u64::MAX))
                .saturating_add(u64::try_from(channel_values).unwrap_or(u64::MAX))
        },
    )
}

fn decoded_frames_allocated_bytes(entry: &AnalyzerCacheEntry) -> u64 {
    let frame_bytes = decoded_frame_vec_allocated_bytes(entry.frames.as_ref());
    let role_bytes = entry.table_roles.iter().fold(
        u64::try_from(
            entry
                .table_roles
                .capacity()
                .saturating_mul(std::mem::size_of::<String>()),
        )
        .unwrap_or(u64::MAX),
        |bytes, role| bytes.saturating_add(u64::try_from(role.capacity()).unwrap_or(u64::MAX)),
    );
    let search_text_bytes =
        entry
            .table_search_texts
            .lock()
            .values()
            .fold(0u64, |cache_bytes, texts| {
                cache_bytes.saturating_add(
                    texts.iter().fold(
                        u64::try_from(
                            texts
                                .capacity()
                                .saturating_mul(std::mem::size_of::<String>()),
                        )
                        .unwrap_or(u64::MAX),
                        |bytes, text| {
                            bytes.saturating_add(u64::try_from(text.capacity()).unwrap_or(u64::MAX))
                        },
                    ),
                )
            });
    let search_match_bytes =
        entry
            .table_search_matches
            .lock()
            .values()
            .fold(0u64, |cache_bytes, matches| {
                cache_bytes.saturating_add(
                    u64::try_from(
                        matches
                            .capacity()
                            .saturating_mul(std::mem::size_of::<usize>()),
                    )
                    .unwrap_or(u64::MAX),
                )
            });
    frame_bytes
        .saturating_add(role_bytes)
        .saturating_add(search_text_bytes)
        .saturating_add(search_match_bytes)
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub struct CaptureMemoryUsage {
    pub buffer_bytes: u64,
    pub sample_bytes: u64,
    pub index_bytes: u64,
    pub analyzer_bytes: u64,
    pub total_bytes: u64,
}

impl GraphSession {
    pub fn capture_memory_usage(
        &self,
        buffer_bytes: u64,
        in_flight_sample_bytes: Option<u64>,
    ) -> CaptureMemoryUsage {
        let sample_bytes = in_flight_sample_bytes.unwrap_or_else(|| {
            if let Some(capture) = self.capture.read().as_ref() {
                return u64::try_from(capture.samples.capacity()).unwrap_or(u64::MAX);
            }
            self.sparse_capture
                .read()
                .as_ref()
                .map(|capture| {
                    capture.channels.iter().fold(0u64, |bytes, channel| {
                        bytes.saturating_add(
                            u64::try_from(channel.transitions.capacity())
                                .unwrap_or(u64::MAX)
                                .saturating_mul(std::mem::size_of::<u64>() as u64),
                        )
                    })
                })
                .unwrap_or(0)
        });
        let index_bytes = self
            .graph
            .read()
            .as_ref()
            .map(|graph| {
                graph.channels.iter().fold(0u64, |bytes, channel| {
                    bytes.saturating_add(
                        u64::try_from(channel.edges.capacity())
                            .unwrap_or(u64::MAX)
                            .saturating_mul(std::mem::size_of::<u64>() as u64),
                    )
                })
            })
            .unwrap_or(0);
        let analyzer_bytes =
            self.analyzer_cache
                .lock()
                .values()
                .fold(0u64, |bytes, entry| {
                    bytes.saturating_add(decoded_frames_allocated_bytes(entry))
                })
                .saturating_add(self.native_window_cache.lock().values().fold(
                    0u64,
                    |bytes, entry| {
                        bytes.saturating_add(decoded_frame_vec_allocated_bytes(
                            entry.frames.as_ref(),
                        ))
                    },
                ))
                .saturating_add(self.native_background_cache.lock().values().fold(
                    0u64,
                    |bytes, state| {
                        bytes.saturating_add(decoded_frame_vec_allocated_bytes(&state.frames))
                    },
                ));
        CaptureMemoryUsage {
            buffer_bytes,
            sample_bytes,
            index_bytes,
            analyzer_bytes,
            total_bytes: sample_bytes
                .saturating_add(index_bytes)
                .saturating_add(analyzer_bytes),
        }
    }

    pub fn begin_capture(&self, metadata: CaptureMetadata) -> Result<()> {
        tracing::info!(
            target: "sigpilot::capture",
            session_id = self.instance_id,
            device_id = metadata.source_device.as_str(),
            sample_rate_hz = metadata.sample_rate_hz,
            channels = metadata.channel_count,
            enabled_channels = metadata.enabled_channels.len(),
            "graph capture opened"
        );
        *self.graph.write() = Some(DigitalGraph::new(metadata)?);
        *self.capture.write() = None;
        *self.sparse_capture.write() = None;
        self.clear_analyzer_caches();
        self.bump_revision();
        Ok(())
    }

    pub fn append_samples(&self, samples: &[u8]) -> Result<u64> {
        let count = self
            .graph
            .write()
            .as_mut()
            .ok_or(GraphError::EmptyGraph)?
            .append_interleaved(samples)?;
        self.bump_revision();
        // Runs once per streamed chunk, so this stays at trace: the totals are
        // what explain a graph that stopped growing, and they are logged once at
        // `finish_capture` rather than per chunk.
        tracing::trace!(
            target: "sigpilot::capture",
            session_id = self.instance_id,
            appended_samples = count,
            chunk_bytes = samples.len(),
            total_samples = self.sample_count(),
            "appended streamed samples"
        );
        Ok(count)
    }

    pub fn append_cross_lanes(
        &self,
        enabled_channels: &[u8],
        samples: &[u8],
        reverse_bits_in_word: bool,
    ) -> Result<u64> {
        let count = self
            .graph
            .write()
            .as_mut()
            .ok_or(GraphError::EmptyGraph)?
            .append_cross_lanes(enabled_channels, samples, reverse_bits_in_word)?;
        self.bump_revision();
        Ok(count)
    }

    pub fn set_trigger(&self, trigger: CaptureTriggerMetadata) -> Result<()> {
        self.graph
            .write()
            .as_mut()
            .ok_or(GraphError::EmptyGraph)?
            .set_trigger(trigger);
        self.bump_revision();
        Ok(())
    }

    pub fn replace_capture(&self, capture: CaptureData) -> Result<()> {
        let graph = DigitalGraph::from_capture(&capture)?;
        *self.graph.write() = Some(graph);
        *self.capture.write() = Some(Arc::new(capture));
        *self.sparse_capture.write() = None;
        self.clear_analyzer_caches();
        self.bump_revision();
        Ok(())
    }

    pub fn finish_capture(&self, capture: CaptureData) -> Result<()> {
        let indexed_samples = self
            .graph
            .read()
            .as_ref()
            .map(DigitalGraph::sample_count)
            .unwrap_or(0);
        // The graph accumulated samples as they streamed in, and the final
        // metadata counts what the device says it sent. When they disagree, the
        // graph is rebuilt from the capture rather than relabelled — and that
        // fallback is invisible from the outside, so it is worth a line: a
        // rebuilt graph is a capture that visibly jumps at the end.
        if indexed_samples != capture.metadata.sample_count {
            tracing::warn!(
                target: "sigpilot::capture",
                session_id = self.instance_id,
                streamed_samples = indexed_samples,
                metadata_samples = capture.metadata.sample_count,
                "streamed sample count disagrees with the final metadata; rebuilding the graph"
            );
            return self.replace_capture(capture);
        }
        let finalized = self
            .graph
            .write()
            .as_mut()
            .ok_or(GraphError::EmptyGraph)
            .and_then(|graph| graph.finish_metadata(capture.metadata.clone()));
        if finalized.is_err() {
            tracing::warn!(
                target: "sigpilot::capture",
                session_id = self.instance_id,
                streamed_samples = indexed_samples,
                error = finalized.as_ref().err().map(|error| error.to_string()),
                "finalizing the streamed metadata failed; rebuilding the graph"
            );
            return self.replace_capture(capture);
        }
        *self.capture.write() = Some(Arc::new(capture));
        *self.sparse_capture.write() = None;
        self.bump_revision();
        tracing::info!(
            target: "sigpilot::capture",
            session_id = self.instance_id,
            samples = indexed_samples,
            "capture finished"
        );
        Ok(())
    }

    pub fn replace_sparse_capture(&self, capture: SparseCaptureData) -> Result<()> {
        let graph = DigitalGraph::from_sparse_capture(&capture)?;
        *self.graph.write() = Some(graph);
        *self.capture.write() = None;
        *self.sparse_capture.write() = Some(Arc::new(capture));
        self.clear_analyzer_caches();
        self.bump_revision();
        Ok(())
    }

    pub fn trim_capture(&self, start: u64, end: u64) -> Result<(CaptureMetadata, usize)> {
        tracing::info!(
            target: "sigpilot::capture",
            session_id = self.instance_id,
            start_sample = start,
            end_sample = end,
            held_samples = self.sample_count(),
            "trimming capture"
        );
        let mut graph = self.graph.write();
        let graph = graph.as_mut().ok_or_else(|| {
            tracing::error!(
                target: "sigpilot::capture",
                session_id = self.instance_id,
                "cannot trim: the session holds no capture"
            );
            GraphError::EmptyGraph
        })?;
        if start >= end || end > graph.sample_count() {
            tracing::warn!(
                target: "sigpilot::capture",
                session_id = self.instance_id,
                start_sample = start,
                end_sample = end,
                held_samples = graph.sample_count(),
                "trim range is empty or runs past the end of the capture"
            );
            return Err(GraphError::InvalidTrimRange);
        }
        let metadata = trimmed_metadata(graph.metadata(), start, end)?;

        let mut packed_capture = self.capture.write();
        let mut sparse_capture = self.sparse_capture.write();
        let bytes = if let Some(capture) = packed_capture.as_mut() {
            trim_packed_capture(capture, metadata.clone(), start, end)?
        } else if let Some(capture) = sparse_capture.as_mut() {
            trim_sparse_capture(capture, metadata.clone(), start, end)?
        } else {
            tracing::error!(
                target: "sigpilot::capture",
                session_id = self.instance_id,
                start_sample = start,
                end_sample = end,
                "cannot trim: neither a packed nor a sparse capture is held"
            );
            return Err(GraphError::EmptyGraph);
        };

        graph.trim(start, end)?;
        self.clear_analyzer_caches();
        self.bump_revision();
        tracing::info!(
            target: "sigpilot::capture",
            session_id = self.instance_id,
            first_sample = start,
            kept_samples = end - start,
            metadata_sample_count = metadata.sample_count,
            kept_bytes = bytes,
            "capture trimmed"
        );
        Ok((metadata, bytes))
    }

    pub fn capture(&self) -> Option<Arc<CaptureData>> {
        self.capture.read().clone()
    }

    pub fn sparse_capture(&self) -> Option<Arc<SparseCaptureData>> {
        self.sparse_capture.read().clone()
    }

    pub fn metadata(&self) -> Option<CaptureMetadata> {
        self.graph
            .read()
            .as_ref()
            .map(|graph| graph.metadata().clone())
    }

    pub fn sample_count(&self) -> u64 {
        self.graph
            .read()
            .as_ref()
            .map(DigitalGraph::sample_count)
            .unwrap_or(0)
    }

    /// Returns the total number of indexed digital transitions across all channels.
    pub fn digital_edge_count(&self) -> usize {
        self.graph
            .read()
            .as_ref()
            .map(|graph| {
                graph
                    .channels
                    .iter()
                    .map(|channel| channel.edges.len())
                    .sum()
            })
            .unwrap_or(0)
    }

    /// Invalidates decoded analyzer output while preserving capture and waveform indexes.
    ///
    /// This is useful after an external decoder runtime changes and for repeated
    /// performance measurements that must not time an in-memory frame cache hit.
    pub fn reset_analyzer_decode_state(&self) {
        self.clear_analyzer_caches();
    }

    pub fn nearest_transition(
        &self,
        channel: u8,
        sample: u64,
    ) -> Result<Option<NearestDigitalTransition>> {
        self.graph
            .read()
            .as_ref()
            .ok_or(GraphError::EmptyGraph)?
            .nearest_transition(channel, sample)
    }

    pub fn measure_point(
        &self,
        channel: u8,
        sample: u64,
    ) -> Result<Option<DigitalPointMeasurement>> {
        let measurement = self
            .graph
            .read()
            .as_ref()
            .ok_or(GraphError::EmptyGraph)?
            .measure_point(channel, sample)?;
        match &measurement {
            Some(measured) => tracing::debug!(
                target: "sigpilot::measurements",
                session_id = self.instance_id,
                channel,
                sample,
                level = measured.high,
                width_start_sample = measured.width_start_sample,
                width_end_sample = measured.width_end_sample,
                width_samples = measured.width_end_sample.saturating_sub(measured.width_start_sample),
                "point measurement computed"
            ),
            // `None` is a real answer — the cursor sits on a channel with no
            // transitions around it — so it is logged rather than swallowed.
            None => tracing::debug!(
                target: "sigpilot::measurements",
                session_id = self.instance_id,
                channel,
                sample,
                "no transition near the measured sample; width and period are unavailable"
            ),
        }
        Ok(measurement)
    }

    pub fn revision(&self) -> u64 {
        self.revision.load(Ordering::Acquire)
    }

    pub fn decode_frames(
        &self,
        settings: &AnalyzerDecodeSettings,
    ) -> Result<Arc<Vec<DecodedFrame>>> {
        let key = serde_json::to_string(settings)?;
        let sample_count = self.sample_count();
        let cached = self.analyzer_cache.lock().remove(&key);
        if let Some(entry) = cached {
            if entry.decoded_sample_count == sample_count {
                let frames = entry.frames.clone();
                self.analyzer_cache.lock().insert(key, entry);
                return Ok(frames);
            }
            let frames = {
                let graph_guard = self.graph.read();
                let graph = graph_guard.as_ref().ok_or(GraphError::EmptyGraph)?;
                let resume_sample = entry
                    .frames
                    .last()
                    .map(|frame| frame.start_sample)
                    .unwrap_or(entry.decoded_sample_count.saturating_sub(1));
                let incremental = graph.decode_from(settings, resume_sample)?;
                let cached_frames =
                    Arc::try_unwrap(entry.frames).unwrap_or_else(|frames| frames.as_ref().clone());
                Arc::new(merge_incremental_frames(
                    cached_frames,
                    incremental,
                    resume_sample,
                ))
            };
            let result = frames.clone();
            self.analyzer_cache
                .lock()
                .insert(key, analyzer_cache_entry(sample_count, frames));
            return Ok(result);
        }

        let frames = Arc::new(
            self.graph
                .read()
                .as_ref()
                .ok_or(GraphError::EmptyGraph)?
                .decode(settings)?,
        );
        let mut cache = self.analyzer_cache.lock();
        let entry = cache
            .entry(key)
            .or_insert_with(|| analyzer_cache_entry(sample_count, frames.clone()));
        if entry.decoded_sample_count < sample_count {
            *entry = analyzer_cache_entry(sample_count, frames.clone());
        }
        Ok(entry.frames.clone())
    }

    pub fn decode_frames_with_backend(
        &self,
        settings: &AnalyzerDecodeSettings,
        backend: DecoderBackendKind,
    ) -> Result<Arc<Vec<DecodedFrame>>> {
        if matches!(
            backend,
            DecoderBackendKind::Auto | DecoderBackendKind::LegacyRust
        ) {
            if let AnalyzerDecodeSettings::Native(settings) = settings {
                // A rejection with a cause: the analyzer is native-only and the
                // selected backend cannot run it, which is otherwise reported to
                // the user as an empty analyzer.
                tracing::warn!(
                    target: "sigpilot::decoders",
                    session_id = self.instance_id,
                    backend = ?backend,
                    decoder = settings.protocol_name.as_str(),
                    "decode rejected: the Legacy Rust backend implements only UART, I2C and SPI"
                );
                return Err(GraphError::InvalidAnalyzer(format!(
                    "{} cannot use the Legacy Rust decoder backend",
                    settings.protocol_name
                )));
            }
            return self.decode_frames(settings);
        }
        let packed_capture = self.capture();
        let sparse_capture = self.sparse_capture();
        if packed_capture.is_none() && sparse_capture.is_none() {
            // Native sidecars are batch decoders. Keep live bubbles available
            // from the indexed graph, then replace them after finish_capture().
            if matches!(settings, AnalyzerDecodeSettings::Native(_)) {
                tracing::debug!(
                    target: "sigpilot::decoders",
                    session_id = self.instance_id,
                    backend = ?backend,
                    samples = self.sample_count(),
                    "no finished capture to decode yet; returning no frames until the capture completes"
                );
                return Ok(Arc::new(Vec::new()));
            }
            return self.decode_frames(settings);
        }

        let key = native_full_analyzer_cache_key(backend, settings)?;
        let sample_count = self.sample_count();
        if let Some(entry) = self.analyzer_cache.lock().get(&key) {
            if entry.decoded_sample_count == sample_count {
                return Ok(entry.frames.clone());
            }
        }

        let decode_indexed = |decoder: &dyn DecoderBackend| {
            if packed_capture.is_some() {
                let graph = self.graph.read();
                let capture = graph
                    .as_ref()
                    .ok_or_else(|| {
                        sigpilot_core::CoreError::Decode("capture graph is empty".to_string())
                    })?
                    .sparse_view();
                decoder.decode_sparse_view(&capture, settings)
            } else if let Some(capture) = &sparse_capture {
                decoder.decode_sparse(capture.as_ref(), settings)
            } else {
                unreachable!();
            }
        };
        let decode_started = Instant::now();
        let output = match backend {
            DecoderBackendKind::SaleaeNative => {
                let decoder = SaleaeNativeDecoder::from_env_cached().map_err(|error| {
                    tracing::error!(
                        target: "sigpilot::decoders",
                        session_id = self.instance_id,
                        backend = "saleae",
                        error = error.to_string(),
                        "the Saleae sidecar could not be located or configured"
                    );
                    GraphError::DecoderBackend(error.to_string())
                })?;
                decode_indexed(&decoder)
            }
            DecoderBackendKind::SigrokNative => {
                let decoder = SigrokNativeDecoder::from_env_cached().map_err(|error| {
                    tracing::error!(
                        target: "sigpilot::decoders",
                        session_id = self.instance_id,
                        backend = "sigrok",
                        error = error.to_string(),
                        "the sigrok sidecar could not be located or configured"
                    );
                    GraphError::DecoderBackend(error.to_string())
                })?;
                decode_indexed(&decoder)
            }
            DecoderBackendKind::Auto | DecoderBackendKind::LegacyRust => unreachable!(),
        }
        .map_err(|error| {
            // The decoder name travels with the failure because "the analyzer
            // shows nothing" is otherwise unattributable.
            tracing::error!(
                target: "sigpilot::decoders",
                session_id = self.instance_id,
                backend = ?backend,
                samples = sample_count,
                elapsed_ms = decode_started.elapsed().as_secs_f64() * 1_000.0,
                error = error.to_string(),
                "decode failed"
            );
            GraphError::DecoderBackend(error.to_string())
        })?;
        let output_frame_count = output.frames.len();
        tracing::info!(
            target: "sigpilot::decoders",
            session_id = self.instance_id,
            backend = ?backend,
            frames = output_frame_count,
            samples = sample_count,
            elapsed_ms = decode_started.elapsed().as_secs_f64() * 1_000.0,
            "decode finished"
        );
        trace_graph_timing(
            "backend_decode",
            decode_started,
            &format!("backend={backend:?} output_frames={output_frame_count}"),
        );
        let conversion_started = Instant::now();
        let frames = Arc::new(output.into_decoded_frames());
        trace_graph_timing(
            "frame_conversion",
            conversion_started,
            &format!("backend={backend:?} frames={}", frames.len()),
        );
        self.analyzer_cache
            .lock()
            .insert(key, analyzer_cache_entry(sample_count, frames.clone()));
        Ok(frames)
    }

    pub fn decode_saleae_native_frames_batch(
        &self,
        settings: &[AnalyzerDecodeSettings],
    ) -> Result<Vec<Arc<Vec<DecodedFrame>>>> {
        if settings.is_empty() {
            return Ok(Vec::new());
        }
        if settings.len() == 1 {
            return Ok(vec![self.decode_frames_with_backend(
                &settings[0],
                DecoderBackendKind::SaleaeNative,
            )?]);
        }

        let sample_count = self.sample_count();
        let mut results: Vec<Option<Arc<Vec<DecodedFrame>>>> = vec![None; settings.len()];
        let mut pending_indices = Vec::new();
        let mut pending_settings = Vec::new();
        let mut pending_keys = Vec::new();

        for (index, setting) in settings.iter().enumerate() {
            let key = native_full_analyzer_cache_key(DecoderBackendKind::SaleaeNative, setting)?;
            if let Some(entry) = self.analyzer_cache.lock().get(&key) {
                if entry.decoded_sample_count == sample_count {
                    results[index] = Some(entry.frames.clone());
                    continue;
                }
            }
            pending_indices.push(index);
            pending_settings.push(setting.clone());
            pending_keys.push(key);
        }

        if pending_indices.is_empty() {
            return results
                .into_iter()
                .map(|frames| {
                    frames.ok_or_else(|| {
                        GraphError::DecoderBackend(
                            "Saleae batch decode omitted cached analyzer output".to_string(),
                        )
                    })
                })
                .collect();
        }

        let has_native_capture = self.capture().is_some() || self.sparse_capture().is_some();
        if pending_indices.len() == 1 || !has_native_capture || sample_count == 0 {
            for index in pending_indices {
                results[index] = Some(self.decode_frames_with_backend(
                    &settings[index],
                    DecoderBackendKind::SaleaeNative,
                )?);
            }
            return results
                .into_iter()
                .map(|frames| {
                    frames.ok_or_else(|| {
                        GraphError::DecoderBackend(
                            "Saleae batch decode omitted fallback analyzer output".to_string(),
                        )
                    })
                })
                .collect();
        }

        let decoder = SaleaeNativeDecoder::from_env_cached()
            .map_err(|error| GraphError::DecoderBackend(error.to_string()))?;
        let setting_refs = pending_settings.iter().collect::<Vec<_>>();
        let decode_started = Instant::now();
        let outputs = if let Some(capture) = self.sparse_capture() {
            let capture = sparse_capture_view(capture.as_ref());
            decoder.decode_sparse_view_window_batch(&capture, 0, sample_count, &setting_refs)
        } else {
            let graph_guard = self.graph.read();
            let graph = graph_guard.as_ref().ok_or(GraphError::EmptyGraph)?;
            let capture = graph.sparse_view();
            decoder.decode_sparse_view_window_batch(&capture, 0, sample_count, &setting_refs)
        }
        .map_err(|error| GraphError::DecoderBackend(error.to_string()))?;

        let Some(outputs) = outputs else {
            for index in pending_indices {
                results[index] = Some(self.decode_frames_with_backend(
                    &settings[index],
                    DecoderBackendKind::SaleaeNative,
                )?);
            }
            return results
                .into_iter()
                .map(|frames| {
                    frames.ok_or_else(|| {
                        GraphError::DecoderBackend(
                            "Saleae batch decode omitted nonpersistent analyzer output".to_string(),
                        )
                    })
                })
                .collect();
        };

        let conversion_started = Instant::now();
        let decoded_frames = if outputs.len() > 1 {
            outputs
                .into_par_iter()
                .map(|output| Arc::new(output.into_decoded_frames()))
                .collect::<Vec<_>>()
        } else {
            outputs
                .into_iter()
                .map(|output| Arc::new(output.into_decoded_frames()))
                .collect::<Vec<_>>()
        };
        let decoded_frame_count = decoded_frames
            .iter()
            .map(|frames| frames.len())
            .sum::<usize>();
        trace_graph_timing(
            "saleae_full_batch_frame_conversion",
            conversion_started,
            &format!(
                "analyzers={} frames={decoded_frame_count}",
                decoded_frames.len()
            ),
        );
        for ((index, key), frames) in pending_indices
            .into_iter()
            .zip(pending_keys)
            .zip(decoded_frames)
        {
            self.analyzer_cache
                .lock()
                .insert(key, analyzer_cache_entry(sample_count, frames.clone()));
            results[index] = Some(frames);
        }
        trace_graph_timing(
            "saleae_full_batch_decode",
            decode_started,
            &format!(
                "analyzers={} frames={decoded_frame_count}",
                pending_settings.len()
            ),
        );

        results
            .into_iter()
            .map(|frames| {
                frames.ok_or_else(|| {
                    GraphError::DecoderBackend(
                        "Saleae batch decode omitted analyzer output".to_string(),
                    )
                })
            })
            .collect()
    }

    pub fn decode_saleae_native_background_step_batch(
        &self,
        settings: &[AnalyzerDecodeSettings],
    ) -> Result<Vec<NativeAnalyzerDecodeProgress>> {
        if settings.is_empty() {
            return Ok(Vec::new());
        }
        if let Some(capture) = self.sparse_capture() {
            let capture = sparse_capture_view(capture.as_ref());
            return self.decode_saleae_native_background_step_for_capture(settings, &capture);
        }
        if self.capture().is_some() {
            let graph = self.graph.read();
            let graph = graph.as_ref().ok_or(GraphError::EmptyGraph)?;
            let capture = graph.sparse_view();
            return self.decode_saleae_native_background_step_for_capture(settings, &capture);
        }
        Err(GraphError::EmptyGraph)
    }

    fn decode_saleae_native_background_step_for_capture<'a>(
        &self,
        settings: &[AnalyzerDecodeSettings],
        capture: &SparseCaptureView<'a>,
    ) -> Result<Vec<NativeAnalyzerDecodeProgress>> {
        let started = Instant::now();
        let sample_count = capture.metadata.sample_count;
        let generation = self.analyzer_generation.load(Ordering::Acquire);
        let mut unique_settings = Vec::new();
        let mut seen_keys = HashSet::new();
        for setting in settings {
            let key = native_full_analyzer_cache_key(DecoderBackendKind::SaleaeNative, setting)?;
            if seen_keys.insert(key.clone()) {
                unique_settings.push((key, setting));
            }
        }

        let complete_keys = {
            let cache = self.analyzer_cache.lock();
            unique_settings
                .iter()
                .filter_map(|(key, _)| {
                    cache
                        .get(key)
                        .filter(|entry| {
                            entry.decoded_sample_count == sample_count && entry.complete
                        })
                        .map(|entry| (key.clone(), entry.frames.len()))
                })
                .collect::<HashMap<_, _>>()
        };

        if let Some(progress) = self.try_decode_saleae_native_async_background_step(
            &capture,
            settings,
            &unique_settings,
            &complete_keys,
            sample_count,
            generation,
        )? {
            trace_graph_timing(
                "saleae_background_async_step",
                started,
                &format!(
                    "analyzers={} completed={} progress_edges={}/{}",
                    progress.len(),
                    progress.iter().filter(|item| item.complete).count(),
                    progress
                        .iter()
                        .map(|item| item.processed_edges)
                        .sum::<usize>(),
                    progress.iter().map(|item| item.total_edges).sum::<usize>()
                ),
            );
            return Ok(progress);
        }

        let mut pending = Vec::new();
        let mut completed_empty_keys = Vec::new();
        {
            let mut cache = self.native_background_cache.lock();
            for (key, setting) in &unique_settings {
                if complete_keys.contains_key(key) {
                    continue;
                }
                let driver = native_driver_channel(capture, setting)?;
                let total_driver_edges = driver.transitions.len();
                let state =
                    cache
                        .entry(key.clone())
                        .or_insert_with(|| NativeBackgroundDecodeState {
                            generation,
                            decoded_sample_count: sample_count,
                            next_driver_edge: 0,
                            total_driver_edges,
                            frames: Vec::new(),
                            async_decode_id: native_async_decode_id(
                                self.instance_id,
                                generation,
                                key,
                            ),
                            async_started: false,
                        });
                if state.generation != generation
                    || state.decoded_sample_count != sample_count
                    || state.total_driver_edges != total_driver_edges
                {
                    *state = NativeBackgroundDecodeState {
                        generation,
                        decoded_sample_count: sample_count,
                        next_driver_edge: 0,
                        total_driver_edges,
                        frames: Vec::new(),
                        async_decode_id: native_async_decode_id(self.instance_id, generation, key),
                        async_started: false,
                    };
                }
                if total_driver_edges == 0 {
                    completed_empty_keys.push(key.clone());
                    continue;
                }
                if state.next_driver_edge >= total_driver_edges {
                    continue;
                }
                let window = native_background_window(
                    capture,
                    setting,
                    state.next_driver_edge,
                    NATIVE_BACKGROUND_BODY_EDGES,
                )?;
                pending.push(NativeBackgroundPending {
                    key: key.clone(),
                    settings: setting,
                    window,
                    progress_numerator: state.next_driver_edge,
                    progress_denominator: total_driver_edges,
                });
            }
        }

        if !completed_empty_keys.is_empty()
            && self.analyzer_generation.load(Ordering::Acquire) == generation
        {
            {
                let mut background = self.native_background_cache.lock();
                for key in &completed_empty_keys {
                    if let Some(state) = background.get_mut(key) {
                        state.next_driver_edge = state.total_driver_edges;
                    }
                }
            }
            let mut analyzer = self.analyzer_cache.lock();
            for key in completed_empty_keys {
                analyzer.insert(
                    key,
                    analyzer_cache_entry(sample_count, Arc::new(Vec::new())),
                );
            }
        }

        pending.sort_by(|left, right| {
            let left_progress = (left.progress_numerator as u128)
                .saturating_mul(right.progress_denominator as u128);
            let right_progress = (right.progress_numerator as u128)
                .saturating_mul(left.progress_denominator as u128);
            left_progress.cmp(&right_progress)
        });
        pending.truncate(MAX_PARALLEL_NATIVE_BACKGROUND_STEPS);

        let mut decoded = Vec::new();
        let mut uncached = Vec::new();
        for task in pending {
            if let Some(frames) = self.cached_native_window_frames(
                &task.key,
                sample_count,
                task.window.decode_start_sample,
                task.window.decode_end_sample,
            ) {
                decoded.push(NativeBackgroundDecoded {
                    key: task.key,
                    window: task.window,
                    frames,
                });
            } else {
                uncached.push(task);
            }
        }

        if !uncached.is_empty() {
            let decoder = SaleaeNativeDecoder::from_env_cached()
                .map_err(|error| GraphError::DecoderBackend(error.to_string()))?;
            let mut grouped: HashMap<(u64, u64), Vec<NativeBackgroundPending<'_>>> = HashMap::new();
            for task in uncached {
                grouped
                    .entry((
                        task.window.decode_start_sample,
                        task.window.decode_end_sample,
                    ))
                    .or_default()
                    .push(task);
            }
            let groups = grouped.into_values().collect::<Vec<_>>();
            let group_results = if groups.len() <= 1 {
                groups
                    .into_iter()
                    .map(|group| decode_native_background_group(&decoder, capture, group))
                    .collect::<Vec<_>>()
            } else {
                groups
                    .into_par_iter()
                    .map(|group| {
                        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                            decode_native_background_group(&decoder, capture, group)
                        }))
                        .unwrap_or_else(|_| {
                            Err(GraphError::DecoderBackend(
                                "Saleae background decode worker panicked".to_string(),
                            ))
                        })
                    })
                    .collect::<Vec<_>>()
            };
            for result in group_results {
                decoded.extend(result?);
            }
        }

        if self.analyzer_generation.load(Ordering::Acquire) != generation {
            return Ok(settings
                .iter()
                .map(|_| NativeAnalyzerDecodeProgress {
                    frame_count: 0,
                    processed_edges: 0,
                    total_edges: 0,
                    progress: 0.0,
                    complete: false,
                    cancelled: true,
                })
                .collect());
        }

        let window_entries = decoded
            .iter()
            .map(|result| {
                (
                    result.key.clone(),
                    NativeWindowCacheEntry {
                        decoded_sample_count: sample_count,
                        start_sample: result.window.decode_start_sample,
                        end_sample: result.window.decode_end_sample,
                        frames: result.frames.clone(),
                    },
                )
            })
            .collect::<Vec<_>>();
        for (key, entry) in window_entries {
            self.insert_native_window_cache_entries(&key, vec![entry]);
        }

        let mut completed = Vec::new();
        {
            let mut cache = self.native_background_cache.lock();
            for result in decoded {
                let Some(state) = cache.get_mut(&result.key) else {
                    continue;
                };
                if state.generation != generation
                    || state.decoded_sample_count != sample_count
                    || state.next_driver_edge != result.window.body_edge_begin
                {
                    continue;
                }
                let mut retained = result
                    .frames
                    .iter()
                    .filter(|frame| {
                        frame.start_sample >= result.window.retain_start_sample
                            && frame.start_sample < result.window.retain_end_sample
                    })
                    .cloned()
                    .collect::<Vec<_>>();
                normalize_native_decoded_frames(&mut retained);
                for frame in &mut retained {
                    frame.frame_id = frame.start_sample;
                }
                append_native_background_frames(&mut state.frames, retained);
                state.next_driver_edge = result.window.body_edge_end;
                if state.next_driver_edge >= state.total_driver_edges {
                    completed.push((result.key, Arc::new(std::mem::take(&mut state.frames))));
                }
            }
        }
        if !completed.is_empty() {
            let mut cache = self.analyzer_cache.lock();
            for (key, frames) in completed {
                cache.insert(key, analyzer_cache_entry(sample_count, frames));
            }
        }

        let result = self.native_background_progress(settings, sample_count, false)?;
        trace_graph_timing(
            "saleae_background_step",
            started,
            &format!(
                "analyzers={} completed={} progress_edges={}/{}",
                result.len(),
                result.iter().filter(|item| item.complete).count(),
                result
                    .iter()
                    .map(|item| item.processed_edges)
                    .sum::<usize>(),
                result.iter().map(|item| item.total_edges).sum::<usize>()
            ),
        );
        Ok(result)
    }

    fn try_decode_saleae_native_async_background_step(
        &self,
        capture: &SparseCaptureView<'_>,
        requested_settings: &[AnalyzerDecodeSettings],
        unique_settings: &[(String, &AnalyzerDecodeSettings)],
        complete_keys: &HashMap<String, usize>,
        sample_count: u64,
        generation: u64,
    ) -> Result<Option<Vec<NativeAnalyzerDecodeProgress>>> {
        struct PendingAsyncDecode<'a> {
            key: String,
            settings: &'a AnalyzerDecodeSettings,
            decode_id: String,
            started: bool,
        }

        let seeded_frames = unique_settings
            .iter()
            .map(|(key, _)| {
                (
                    key.clone(),
                    self.cached_native_analyzer_frames(key, sample_count),
                )
            })
            .collect::<HashMap<_, _>>();
        let mut pending = Vec::new();
        let mut completed_empty = Vec::new();
        let mut seeded_partial = Vec::new();
        {
            let mut background = self.native_background_cache.lock();
            for (key, settings) in unique_settings {
                if complete_keys.contains_key(key) {
                    continue;
                }
                let driver = native_driver_channel(capture, settings)?;
                let total_driver_edges = driver.transitions.len();
                let reset_state = background.get(key).is_none_or(|state| {
                    state.generation != generation
                        || state.decoded_sample_count != sample_count
                        || state.total_driver_edges != total_driver_edges
                });
                if reset_state {
                    let frames = seeded_frames.get(key).cloned().unwrap_or_default();
                    if !frames.is_empty() {
                        seeded_partial.push((key.clone(), Arc::new(frames.clone())));
                    }
                    background.insert(
                        key.clone(),
                        NativeBackgroundDecodeState {
                            generation,
                            decoded_sample_count: sample_count,
                            next_driver_edge: 0,
                            total_driver_edges,
                            frames,
                            async_decode_id: native_async_decode_id(
                                self.instance_id,
                                generation,
                                key,
                            ),
                            async_started: false,
                        },
                    );
                }
                let state = background
                    .get_mut(key)
                    .expect("Saleae background state is initialized");
                if total_driver_edges == 0 {
                    state.next_driver_edge = 0;
                    completed_empty.push(key.clone());
                    continue;
                }
                pending.push(PendingAsyncDecode {
                    key: key.clone(),
                    settings,
                    decode_id: state.async_decode_id.clone(),
                    started: state.async_started,
                });
            }
        }

        if !seeded_partial.is_empty() {
            let mut analyzer = self.analyzer_cache.lock();
            for (key, frames) in seeded_partial {
                analyzer.insert(key, partial_analyzer_cache_entry(sample_count, frames));
            }
        }

        if !completed_empty.is_empty() {
            let mut analyzer = self.analyzer_cache.lock();
            for key in completed_empty {
                analyzer.insert(
                    key,
                    analyzer_cache_entry(sample_count, Arc::new(Vec::new())),
                );
            }
        }
        if pending.is_empty() {
            return self
                .native_background_progress(requested_settings, sample_count, false)
                .map(Some);
        }

        pending.sort_by_key(|task| !task.started);
        let active_count = pending.iter().filter(|task| task.started).count();
        let mut start_budget = MAX_PARALLEL_NATIVE_BACKGROUND_STEPS.saturating_sub(active_count);
        pending.retain(|task| {
            if task.started {
                true
            } else if start_budget > 0 {
                start_budget -= 1;
                true
            } else {
                false
            }
        });
        let decoder = SaleaeNativeDecoder::from_env_cached()
            .map_err(|error| GraphError::DecoderBackend(error.to_string()))?;

        let run = |task: PendingAsyncDecode<'_>| -> Result<_> {
            let step = if task.started {
                decoder.poll_async_decode(&task.decode_id)
            } else {
                decoder.start_sparse_view_async_decode(capture, task.settings, &task.decode_id)
            }
            .map_err(|error| GraphError::DecoderBackend(error.to_string()))?;
            Ok((task.key, task.decode_id, step))
        };

        let first = run(pending.remove(0))?;
        if first.2.is_none() {
            return Ok(None);
        }
        let mut steps = vec![first];
        let remaining = pending.into_par_iter().map(run).collect::<Vec<_>>();
        for result in remaining {
            let step = result?;
            if step.2.is_none() {
                return Ok(None);
            }
            steps.push(step);
        }

        if self.analyzer_generation.load(Ordering::Acquire) != generation {
            cancel_saleae_async_decode_ids(steps.iter().filter_map(|(_, decode_id, step)| {
                matches!(step, Some(SaleaeAsyncDecodeStep::Pending { .. }))
                    .then_some(decode_id.as_str())
            }));
            return Ok(Some(
                unique_settings
                    .iter()
                    .map(|_| NativeAnalyzerDecodeProgress {
                        frame_count: 0,
                        processed_edges: 0,
                        total_edges: 0,
                        progress: 0.0,
                        complete: false,
                        cancelled: true,
                    })
                    .collect(),
            ));
        }

        let mut completed = Vec::new();
        let mut partial = Vec::new();
        let mut cancelled = false;
        {
            let mut background = self.native_background_cache.lock();
            for (key, _, step) in steps {
                let Some(step) = step else {
                    continue;
                };
                let Some(state) = background.get_mut(&key) else {
                    continue;
                };
                match step {
                    SaleaeAsyncDecodeStep::Pending {
                        progress_sample,
                        output,
                    } => {
                        state.async_started = true;
                        if let Some(output) = output {
                            let mut frames = output.into_decoded_frames();
                            normalize_native_decoded_frames(&mut frames);
                            append_native_background_frames(&mut state.frames, frames);
                            partial.push((key.clone(), Arc::new(state.frames.clone())));
                        }
                        if let Some((_, settings)) = unique_settings
                            .iter()
                            .find(|(candidate, _)| candidate == &key)
                        {
                            let driver = native_driver_channel(capture, settings)?;
                            state.next_driver_edge = state.next_driver_edge.max(
                                driver
                                    .transitions
                                    .partition_point(|sample| *sample <= progress_sample)
                                    .min(state.total_driver_edges),
                            );
                        }
                    }
                    SaleaeAsyncDecodeStep::Complete(output) => {
                        let frames = output.into_decoded_frames();
                        state.next_driver_edge = state.total_driver_edges;
                        state.async_started = false;
                        completed.push((key, Arc::new(frames)));
                    }
                    SaleaeAsyncDecodeStep::CompleteDelta {
                        output,
                        markers,
                        expected_frame_count,
                    } => {
                        let mut frames = output.into_decoded_frames();
                        normalize_native_decoded_frames(&mut frames);
                        append_native_background_frames(&mut state.frames, frames);
                        if state.frames.len() != expected_frame_count {
                            return Err(GraphError::DecoderBackend(format!(
                                "Saleae async decoder completed with {} accumulated frames, expected {expected_frame_count}",
                                state.frames.len()
                            )));
                        }
                        attach_native_completion_markers(&mut state.frames, markers);
                        state.next_driver_edge = state.total_driver_edges;
                        state.async_started = false;
                        completed.push((key, Arc::new(std::mem::take(&mut state.frames))));
                    }
                    SaleaeAsyncDecodeStep::Cancelled => {
                        state.async_started = false;
                        cancelled = true;
                    }
                }
            }
        }
        if !partial.is_empty() {
            let mut analyzer = self.analyzer_cache.lock();
            for (key, frames) in partial {
                analyzer.insert(key, partial_analyzer_cache_entry(sample_count, frames));
            }
        }
        if !completed.is_empty() {
            let mut analyzer = self.analyzer_cache.lock();
            for (key, frames) in completed {
                analyzer.insert(key, analyzer_cache_entry(sample_count, frames));
            }
        }

        self.native_background_progress(requested_settings, sample_count, cancelled)
            .map(Some)
    }

    fn native_background_progress(
        &self,
        settings: &[AnalyzerDecodeSettings],
        sample_count: u64,
        cancelled: bool,
    ) -> Result<Vec<NativeAnalyzerDecodeProgress>> {
        let keys = settings
            .iter()
            .map(|setting| {
                native_full_analyzer_cache_key(DecoderBackendKind::SaleaeNative, setting)
            })
            .collect::<Result<Vec<_>>>()?;
        let complete_frame_counts = {
            let analyzer = self.analyzer_cache.lock();
            keys.iter()
                .filter_map(|key| {
                    analyzer
                        .get(key)
                        .filter(|entry| {
                            entry.decoded_sample_count == sample_count && entry.complete
                        })
                        .map(|entry| (key.clone(), entry.frames.len()))
                })
                .collect::<HashMap<_, _>>()
        };
        let background = self.native_background_cache.lock();
        settings
            .iter()
            .zip(keys)
            .map(|(_, key)| {
                if let Some(frame_count) = complete_frame_counts.get(&key) {
                    let state = background.get(&key);
                    let total_edges = state.map(|state| state.total_driver_edges).unwrap_or(1);
                    return Ok(NativeAnalyzerDecodeProgress {
                        frame_count: *frame_count,
                        processed_edges: total_edges,
                        total_edges,
                        progress: 1.0,
                        complete: true,
                        cancelled,
                    });
                }
                let state = background.get(&key);
                let processed_edges = state.map(|state| state.next_driver_edge).unwrap_or(0);
                let total_edges = state.map(|state| state.total_driver_edges).unwrap_or(0);
                Ok(NativeAnalyzerDecodeProgress {
                    frame_count: state.map(|state| state.frames.len()).unwrap_or(0),
                    processed_edges,
                    total_edges,
                    progress: if total_edges == 0 {
                        0.0
                    } else {
                        processed_edges as f64 / total_edges as f64
                    },
                    complete: false,
                    cancelled,
                })
            })
            .collect()
    }

    pub fn decode_frame_count_with_backend(
        &self,
        settings: &AnalyzerDecodeSettings,
        backend: DecoderBackendKind,
    ) -> Result<usize> {
        self.decode_frames_with_backend(settings, backend)
            .map(|frames| frames.len())
    }

    pub fn decode_frame_slice_with_backend(
        &self,
        settings: &AnalyzerDecodeSettings,
        backend: DecoderBackendKind,
        start: usize,
        end: usize,
    ) -> Result<(usize, Vec<DecodedFrame>)> {
        let frames = self.decode_frames_with_backend(settings, backend)?;
        let total = frames.len();
        let start = start.min(total);
        let end = end.min(total).max(start);
        Ok((total, frames[start..end].to_vec()))
    }

    pub fn decode_frame_table_window(
        &self,
        requests: &[AnalyzerFrameTableRequest],
        start: usize,
        end: usize,
    ) -> Result<AnalyzerFrameTableWindow> {
        let decoded_sources = if requests.len() > 1
            && requests
                .iter()
                .all(|request| request.backend == DecoderBackendKind::SaleaeNative)
        {
            self.decode_saleae_frame_table_sources_batch(requests, None)?
        } else if requests.len() <= 1 {
            requests
                .iter()
                .map(|request| self.decode_frame_table_source(request))
                .collect::<Result<Vec<_>>>()?
        } else {
            requests
                .par_iter()
                .map(|request| self.decode_frame_table_source(request))
                .collect::<Result<Vec<_>>>()?
        };
        let sources = decoded_sources.into_iter().flatten().collect::<Vec<_>>();
        Ok(analyzer_frame_table_window_from_sources(
            &sources, start, end,
        ))
    }

    fn decode_frame_table_source(
        &self,
        request: &AnalyzerFrameTableRequest,
    ) -> Result<Option<AnalyzerFrameTableSource>> {
        let (frames, roles, cached_entry) =
            self.decode_frames_and_table_roles_with_backend(&request.settings, request.backend)?;
        Ok(analyzer_frame_table_source_from_frames(
            request,
            frames,
            roles,
            cached_entry.as_ref(),
            None,
        ))
    }

    fn decode_frame_table_search_source(
        &self,
        request: &AnalyzerFrameTableRequest,
        query: &str,
    ) -> Result<Option<AnalyzerFrameTableSource>> {
        let (frames, roles, cached_entry) =
            self.decode_frames_and_table_roles_with_backend(&request.settings, request.backend)?;
        Ok(analyzer_frame_table_source_from_frames(
            request,
            frames,
            roles,
            cached_entry.as_ref(),
            Some(query),
        ))
    }

    fn decode_saleae_frame_table_sources_batch(
        &self,
        requests: &[AnalyzerFrameTableRequest],
        query: Option<&str>,
    ) -> Result<Vec<Option<AnalyzerFrameTableSource>>> {
        let settings = requests
            .iter()
            .map(|request| request.settings.clone())
            .collect::<Vec<_>>();
        let decode_started = Instant::now();
        let decoded = self.decode_saleae_native_frames_batch(&settings)?;
        trace_graph_timing(
            "saleae_frame_table_batch_decode",
            decode_started,
            &format!(
                "analyzers={} frames={}",
                decoded.len(),
                decoded.iter().map(|frames| frames.len()).sum::<usize>()
            ),
        );
        requests
            .iter()
            .zip(decoded)
            .map(|(request, frames)| {
                let cached_entry = self.cached_analyzer_entry_for_frames(
                    &request.settings,
                    request.backend,
                    &frames,
                )?;
                let roles = cached_entry.as_ref().map_or_else(
                    || Arc::new(analyzer_frame_roles(&frames)),
                    |entry| entry.table_roles.clone(),
                );
                Ok(analyzer_frame_table_source_from_frames(
                    request,
                    frames,
                    roles,
                    cached_entry.as_ref(),
                    query,
                ))
            })
            .collect()
    }

    fn cached_analyzer_entry_for_frames(
        &self,
        settings: &AnalyzerDecodeSettings,
        backend: DecoderBackendKind,
        frames: &Arc<Vec<DecodedFrame>>,
    ) -> Result<Option<AnalyzerCacheEntry>> {
        let sample_count = self.sample_count();
        let cache_key = if matches!(
            backend,
            DecoderBackendKind::Auto | DecoderBackendKind::LegacyRust
        ) {
            serde_json::to_string(settings)?
        } else {
            native_full_analyzer_cache_key(backend, settings)?
        };
        Ok(self
            .analyzer_cache
            .lock()
            .get(&cache_key)
            .filter(|entry| entry.decoded_sample_count == sample_count)
            .filter(|entry| Arc::ptr_eq(&entry.frames, frames))
            .cloned())
    }

    fn decode_frames_and_table_roles_with_backend(
        &self,
        settings: &AnalyzerDecodeSettings,
        backend: DecoderBackendKind,
    ) -> Result<(
        Arc<Vec<DecodedFrame>>,
        Arc<Vec<String>>,
        Option<AnalyzerCacheEntry>,
    )> {
        let frames = self.decode_frames_with_backend(settings, backend)?;
        let cached_entry = self.cached_analyzer_entry_for_frames(settings, backend, &frames)?;
        let roles = cached_entry.as_ref().map_or_else(
            || Arc::new(analyzer_frame_roles(&frames)),
            |entry| entry.table_roles.clone(),
        );
        Ok((frames, roles, cached_entry))
    }

    pub fn decode_frame_table_search_window(
        &self,
        requests: &[AnalyzerFrameTableRequest],
        query: &str,
        start: usize,
        end: usize,
    ) -> Result<AnalyzerFrameTableWindow> {
        let decoded_sources = if requests.len() > 1
            && requests
                .iter()
                .all(|request| request.backend == DecoderBackendKind::SaleaeNative)
        {
            self.decode_saleae_frame_table_sources_batch(requests, Some(query))?
        } else if requests.len() <= 1 {
            requests
                .iter()
                .map(|request| self.decode_frame_table_search_source(request, query))
                .collect::<Result<Vec<_>>>()?
        } else {
            requests
                .par_iter()
                .map(|request| self.decode_frame_table_search_source(request, query))
                .collect::<Result<Vec<_>>>()?
        };
        let sources = decoded_sources.into_iter().flatten().collect::<Vec<_>>();
        Ok(analyzer_frame_table_search_window_from_sources(
            &sources, query, start, end,
        ))
    }

    pub fn decode_frames_with_backend_for_view(
        &self,
        settings: &AnalyzerDecodeSettings,
        backend: DecoderBackendKind,
        waveform: &WaveformRequest,
    ) -> Result<Arc<Vec<DecodedFrame>>> {
        // The dispatch decision itself: which representation the frames get
        // decoded from, and which backend runs them. A capture whose analyzer
        // shows nothing is usually this line disagreeing with what the user
        // expected, so the branch taken is recorded rather than inferred.
        tracing::debug!(
            target: "sigpilot::decoders",
            session_id = self.instance_id,
            backend = ?backend,
            protocol = match settings {
                AnalyzerDecodeSettings::Uart(_) => "UART",
                AnalyzerDecodeSettings::I2c(_) => "I2C",
                AnalyzerDecodeSettings::Spi(_) => "SPI",
                AnalyzerDecodeSettings::Native(native) => native.protocol_name.as_str(),
            },
            sparse_capture = self.sparse_capture().is_some(),
            packed_capture = self.capture().is_some(),
            window_start = waveform.start_sample,
            window_samples = waveform.sample_count,
            "dispatching a decode"
        );
        if matches!(
            backend,
            DecoderBackendKind::SaleaeNative | DecoderBackendKind::SigrokNative
        ) {
            if let Some(capture) = self.sparse_capture() {
                let capture = sparse_capture_view(capture.as_ref());
                return self.decode_sparse_frames_for_view(&capture, settings, backend, waveform);
            }
            if self.capture().is_some() {
                let graph = self.graph.read();
                let graph = graph.as_ref().ok_or(GraphError::EmptyGraph)?;
                let capture = graph.sparse_view();
                return self.decode_sparse_frames_for_view(&capture, settings, backend, waveform);
            }
        }
        self.decode_frames_with_backend(settings, backend)
    }

    /// Replaces the clamping policy the session applies to every viewport
    /// change. `total_samples` is taken from the session, never from the caller,
    /// so the limits and the data cannot disagree. The current viewport is
    /// re-clamped and returned, so a capture that grew or a mode that changed
    /// cannot leave a stale view in place.
    pub fn set_view_limits(&self, limits: ViewLimits) -> SessionView {
        *self.view_limits.lock() = limits;
        // Only re-clamp a viewport that was actually established. Materializing
        // one here would turn "never moved" into "explicitly set" and stop a live
        // session from following the tail.
        let existing = *self.view.lock();
        match existing {
            Some(view) => self.set_session_view(view.start_sample, view.samples),
            None => self.session_view(),
        }
    }

    fn normalize_view(&self, view: SessionView) -> SessionView {
        let limits = *self.view_limits.lock();
        let total = self.sample_count();
        // Widen around the requested centre when the caller asked for a finer span
        // than the limit allows. Clamping only the span would leave the anchor free
        // to keep dragging the view sideways while the span no longer changed, so
        // zooming further would pan instead of stopping.
        let minimum = minimum_view_samples(limits.sample_rate_hz);
        let view = if view.samples < minimum {
            SessionView::new(
                view.start_sample + view.samples / 2.0 - minimum / 2.0,
                minimum,
            )
        } else {
            view
        };
        if limits.live {
            normalize_live_capture_view(
                view.start_sample,
                view.samples,
                total,
                limits.sample_rate_hz,
                limits.maximum_samples,
            )
        } else {
            normalize_capture_view(
                view.start_sample,
                view.samples,
                total,
                limits.maximum_samples,
            )
        }
    }

    /// The viewport used until a caller establishes one. A live session follows a
    /// fixed-width window at the tail; fitting the whole capture instead would
    /// zoom out continuously as samples stream in, which is what made a live
    /// graph unreadable.
    fn default_view(&self) -> SessionView {
        let total = self.sample_count();
        let limits = *self.view_limits.lock();
        let samples = default_capture_view_samples(total, limits.sample_rate_hz);
        if limits.live {
            SessionView::new((total as f64 - samples).max(0.0), samples)
        } else {
            SessionView::new(0.0, samples)
        }
    }

    pub fn session_view(&self) -> SessionView {
        // Resolve any glide first, then settle or report it. The animation lock
        // is released before the view lock is taken so the two never nest.
        let settled = {
            let mut animation = self.view_animation.lock();
            match animation.as_ref() {
                None => None,
                Some(active) => match active.sample() {
                    Some(sampled) => Some(self.normalize_view(sampled)),
                    None => {
                        let destination = active.to;
                        *animation = None;
                        Some(self.normalize_view(destination))
                    }
                },
            }
        };
        if let Some(view) = settled {
            *self.view.lock() = Some(view);
            return view;
        }
        self.view.lock().unwrap_or_else(|| self.default_view())
    }

    /// Establishes a viewport outright, applying the session's clamping.
    pub fn set_session_view(&self, start_sample: f64, samples: f64) -> SessionView {
        *self.view_animation.lock() = None;
        let next = self.normalize_view(SessionView::new(start_sample, samples));
        *self.view.lock() = Some(next);
        next
    }

    /// Applies a gesture and stores the clamped result. This is the single entry
    /// point for every viewport change the user can make.
    ///
    /// An animated intent starts a glide from wherever the view is right now, so
    /// retargeting mid-flight does not snap back to the original start. Any other
    /// intent cancels a glide, which is what makes a wheel tick interrupt a
    /// toolbar zoom instead of fighting it.
    pub fn apply_view_intent(&self, intent: &ViewIntent) -> SessionView {
        if intent.is_passive() {
            return self.session_view();
        }

        // Every non-passive intent is a real user gesture, so this is where the
        // "the graph did not move" reports get answered: the requested numbers
        // are recorded *before* normalization, because the clamp is exactly what
        // makes a request and its effect differ.
        tracing::debug!(
            target: "sigpilot::graph",
            session_id = self.instance_id,
            intent = ?intent,
            view_before = ?self.session_view(),
            "applying a view intent"
        );

        // Hold a zoom-in at the finest span worth showing by clamping the *factor*,
        // not the resulting span.
        //
        // Clamping the span afterwards has to widen it around something, and the
        // only centre available is the anchor-derived one — so every request at the
        // limit would re-centre the view on the pointer. The span stops changing but
        // the start keeps moving, which reads as the graph sliding sideways each
        // time a key is held down. Clamping the factor leaves the anchor arithmetic
        // intact: at the limit the span simply stops shrinking, so the start stops
        // moving too.
        //
        // The zoom-out direction needs the same treatment against the ceiling, and
        // for the same reason. Without it the anchor arithmetic runs against a span
        // that `normalize_view` is about to reduce, so the overshoot that gets
        // clamped away is left behind as a start offset: at the data limit the span
        // stops changing while the start marches the other way, which is the graph
        // sliding sideways on every wheel notch past the end of the zoom range.
        let clamped;
        let intent = match *intent {
            ViewIntent::Zoom {
                factor,
                anchor_ratio,
                duration_ms,
            } if factor < 1.0 => {
                let current = self.session_view();
                let sample_rate_hz = self.view_limits.lock().sample_rate_hz;
                let floor = minimum_view_samples(sample_rate_hz) / current.samples.max(1.0);
                clamped = ViewIntent::Zoom {
                    factor: factor.max(floor),
                    anchor_ratio,
                    duration_ms,
                };
                &clamped
            }
            ViewIntent::Zoom {
                factor,
                anchor_ratio,
                duration_ms,
            } if factor > 1.0 => {
                let current = self.session_view();
                let ceiling = maximum_view_samples(self.sample_count(), &self.view_limits.lock());
                // `max(1.0)` keeps this a zoom-out when the current span is already
                // at or past the ceiling: the factor settles at 1.0, the anchor
                // arithmetic becomes an identity, and the view holds still while
                // `normalize_view` brings the span back to the limit.
                let cap = (ceiling / current.samples.max(1.0)).max(1.0);
                clamped = ViewIntent::Zoom {
                    factor: factor.min(cap),
                    anchor_ratio,
                    duration_ms,
                };
                &clamped
            }
            _ => intent,
        };

        // A gesture that carries a duration glides to the result it would have had
        // instantly. The target is computed here rather than by the caller so that
        // a zoom anchors, and a pan shifts, against the view as it is *right now* —
        // the caller never has to guess a position it may be behind on. The glide
        // therefore lands exactly where an instant gesture would have; the only
        // difference is that the user gets to see it move.
        let gesture_duration_ms = match *intent {
            ViewIntent::Zoom { duration_ms, .. } | ViewIntent::PanSamples { duration_ms, .. } => {
                duration_ms
            }
            _ => 0.0,
        };
        if gesture_duration_ms > 0.0 {
            let from = self.session_view();
            let to = self.normalize_view(intent.apply(from));
            let duration = Duration::from_secs_f64((gesture_duration_ms / 1_000.0).min(60.0));
            *self.view_animation.lock() = Some(ViewAnimation::new(from, to, duration));
            return from;
        }

        if let ViewIntent::AnimateTo {
            start_sample,
            samples,
            duration_ms,
        } = *intent
        {
            let from = self.session_view();
            let to = self.normalize_view(SessionView::new(start_sample, samples));
            let duration = Duration::from_secs_f64((duration_ms.max(0.0) / 1_000.0).min(60.0));
            if duration.is_zero() {
                *self.view.lock() = Some(to);
                *self.view_animation.lock() = None;
                return to;
            }
            *self.view_animation.lock() = Some(ViewAnimation::new(from, to, duration));
            return from;
        }
        *self.view_animation.lock() = None;
        let current = self.view.lock().unwrap_or_else(|| self.default_view());
        let next = self.normalize_view(intent.apply(current));
        *self.view.lock() = Some(next);
        next
    }

    pub fn render_frame(&self, request: &GraphFrameRequest) -> Result<GraphFrameResponse> {
        let total_started = Instant::now();
        // A request that carries a gesture hands the range to the backend; the
        // caller's `waveform` then only supplies resolution and channel
        // selection. Requests without one keep their explicit range so existing
        // callers are unaffected.
        let (data_view, waveform) = match &request.view {
            Some(intent) => {
                self.apply_view_intent(intent);
                // Read the view *after* applying, so an in-flight glide is
                // sampled at the moment this frame is built.
                let data_view = self.session_view();
                let (start_sample, sample_count) = data_view.sample_window(self.sample_count());
                (
                    data_view,
                    WaveformRequest {
                        start_sample,
                        sample_count,
                        pixels: request.waveform.pixels,
                        channels: request.waveform.channels.clone(),
                    },
                )
            }
            None => (
                SessionView::new(
                    request.waveform.start_sample as f64,
                    request.waveform.sample_count.max(1) as f64,
                ),
                request.waveform.clone(),
            ),
        };
        let tile_started = Instant::now();
        let tile = if request.include_tile {
            self.graph
                .read()
                .as_ref()
                .ok_or(GraphError::EmptyGraph)?
                .build_tile(&waveform)?
        } else {
            // Not an error, but the reason a frame can arrive with no waveform
            // in it — worth one line so it is not mistaken for a draw failure.
            tracing::debug!(
                target: "sigpilot::rendering",
                session_id = self.instance_id,
                frame_id = request.frame_id,
                start_sample = waveform.start_sample,
                samples = waveform.sample_count,
                "frame requested no waveform tile"
            );
            empty_waveform_tile(&waveform)
        };
        trace_graph_timing(
            "waveform_tile",
            tile_started,
            &format!(
                "channels={} skipped={}",
                tile.channels.len(),
                !request.include_tile
            ),
        );
        let analyzers_started = Instant::now();
        let analyzers = self.render_analyzers(
            &request.analyzers,
            request.analyzer_view.as_ref().unwrap_or(&waveform),
        )?;
        trace_graph_timing(
            "analyzer_render",
            analyzers_started,
            &format!("analyzers={}", analyzers.len()),
        );

        // Read the view again: if the user kept moving while this frame was
        // being built, `view` now leads `data_view` and the frontend stretches
        // the difference instead of waiting for another round trip.
        let view = if request.view.is_some() {
            self.session_view()
        } else {
            data_view
        };

        let response = GraphFrameResponse {
            frame_id: request.frame_id,
            revision: self.revision(),
            sample_count: self.sample_count(),
            view,
            data_view,
            tile,
            analyzers,
        };
        tracing::trace!(
            target: "sigpilot::graph",
            session_id = self.instance_id,
            frame_id = request.frame_id,
            revision = response.revision,
            sample_count = response.sample_count,
            start_sample = response.data_view.start_sample,
            samples = response.data_view.samples,
            tile_channels = response.tile.channels.len(),
            analyzers = response.analyzers.len(),
            elapsed_ms = total_started.elapsed().as_secs_f64() * 1_000.0,
            "graph frame produced"
        );
        trace_graph_timing(
            "graph_frame_total",
            total_started,
            &format!("frame_id={}", request.frame_id),
        );
        Ok(response)
    }

    fn render_analyzer(
        &self,
        request: &AnalyzerRenderRequest,
        waveform: &WaveformRequest,
    ) -> Result<AnalyzerRenderResult> {
        let decode_started = Instant::now();
        // A decode failure here aborts the whole frame, so the analyzer id and
        // the reason are logged before it propagates — otherwise the user sees
        // a blank analyzer row with nothing to explain it.
        let frames = self
            .decode_frames_with_backend_for_view(&request.settings, request.backend, waveform)
            .map_err(|error| {
                tracing::error!(
                    target: "sigpilot::decoders",
                    session_id = self.instance_id,
                    analyzer_id = request.analyzer_id.as_str(),
                    backend = ?request.backend,
                    window_start = waveform.start_sample,
                    window_samples = waveform.sample_count,
                    error = error.to_string(),
                    "analyzer render failed"
                );
                error
            })?;
        trace_graph_timing(
            "analyzer_frames",
            decode_started,
            &format!(
                "analyzer={} backend={:?} frames={}",
                request.analyzer_id,
                request.backend,
                frames.len()
            ),
        );
        let aggregate_started = Instant::now();
        let tracks = render_analyzer_tracks(&frames, &request.tracks, waveform)?;
        trace_graph_timing(
            "bubble_aggregation",
            aggregate_started,
            &format!("analyzer={} tracks={}", request.analyzer_id, tracks.len()),
        );
        Ok(AnalyzerRenderResult {
            analyzer_id: request.analyzer_id.clone(),
            tracks,
        })
    }

    fn render_analyzers(
        &self,
        requests: &[AnalyzerRenderRequest],
        waveform: &WaveformRequest,
    ) -> Result<Vec<AnalyzerRenderResult>> {
        if requests.len() <= 1 {
            return requests
                .iter()
                .map(|request| self.render_analyzer(request, waveform))
                .collect();
        }

        if requests
            .iter()
            .all(|request| request.backend == DecoderBackendKind::SaleaeNative)
        {
            if let Some(rendered) = self.render_saleae_native_analyzers(requests, waveform)? {
                return Ok(rendered);
            }
        }

        let worker_count = std::thread::available_parallelism()
            .map(usize::from)
            .unwrap_or(2)
            .min(MAX_PARALLEL_ANALYZER_RENDERS)
            .min(requests.len());
        // The parallelism actually used, because a frame that renders slowly
        // with no obvious cause is usually this silently collapsing to one.
        tracing::debug!(
            target: "sigpilot::rendering",
            session_id = self.instance_id,
            analyzers = requests.len(),
            workers = worker_count,
            chunk_size = requests.len().div_ceil(worker_count.max(1)),
            "dispatching analyzer renders across workers"
        );
        if worker_count <= 1 {
            return requests
                .iter()
                .map(|request| self.render_analyzer(request, waveform))
                .collect();
        }

        let chunk_size = requests.len().div_ceil(worker_count);
        let worker_outputs = requests
            .par_chunks(chunk_size)
            .enumerate()
            .map(|(chunk_index, chunk)| {
                let start_index = chunk_index * chunk_size;
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    chunk
                        .iter()
                        .enumerate()
                        .map(|(index, request)| {
                            self.render_analyzer(request, waveform)
                                .map(|result| (start_index + index, result))
                        })
                        .collect::<Result<Vec<_>>>()
                }))
                .unwrap_or_else(|_| {
                    // A panicking worker loses every analyzer in its chunk, so
                    // the chunk's analyzer ids are the only way to find out
                    // which one took the frame down.
                    tracing::error!(
                        target: "sigpilot::rendering",
                        session_id = self.instance_id,
                        chunk_index,
                        first_analyzer_index = start_index,
                        analyzers = ?chunk
                            .iter()
                            .map(|request| request.analyzer_id.as_str())
                            .collect::<Vec<_>>(),
                        "analyzer render worker panicked"
                    );
                    Err(GraphError::DecoderBackend(
                        "analyzer render worker panicked".to_string(),
                    ))
                })
            })
            .collect::<Vec<_>>();

        let mut indexed_results: Vec<(usize, AnalyzerRenderResult)> =
            Vec::with_capacity(requests.len());
        for output in worker_outputs {
            let mut results = output?;
            indexed_results.append(&mut results);
        }
        indexed_results.sort_by_key(|(index, _)| *index);
        Ok(indexed_results
            .into_iter()
            .map(|(_, result)| result)
            .collect())
    }

    fn render_saleae_native_analyzers(
        &self,
        requests: &[AnalyzerRenderRequest],
        waveform: &WaveformRequest,
    ) -> Result<Option<Vec<AnalyzerRenderResult>>> {
        if requests.len() <= 1 {
            return Ok(None);
        }
        if let Some(capture) = self.sparse_capture() {
            let capture = sparse_capture_view(capture.as_ref());
            return self
                .render_saleae_native_analyzers_for_capture(requests, waveform, &capture)
                .map(Some);
        }
        if self.capture().is_some() {
            let graph = self.graph.read();
            let graph = graph.as_ref().ok_or(GraphError::EmptyGraph)?;
            let capture = graph.sparse_view();
            return self
                .render_saleae_native_analyzers_for_capture(requests, waveform, &capture)
                .map(Some);
        }
        Ok(None)
    }

    fn render_saleae_native_analyzers_for_capture<'a>(
        &self,
        requests: &[AnalyzerRenderRequest],
        waveform: &WaveformRequest,
        capture: &SparseCaptureView<'a>,
    ) -> Result<Vec<AnalyzerRenderResult>> {
        let sample_count = self.sample_count();
        let mut rendered: Vec<Option<AnalyzerRenderResult>> = vec![None; requests.len()];
        let mut window_plans_by_key: HashMap<String, Vec<(u64, u64)>> = HashMap::new();
        let mut pending = Vec::new();

        for (request_index, request) in requests.iter().enumerate() {
            let full_key = native_full_analyzer_cache_key(request.backend, &request.settings)?;
            if let Some(entry) = self.analyzer_cache.lock().get(&full_key) {
                if entry.decoded_sample_count == sample_count {
                    let tracks = render_analyzer_tracks_timed(
                        &entry.frames,
                        &request.tracks,
                        waveform,
                        &request.analyzer_id,
                        "full-cache-hit",
                    )?;
                    rendered[request_index] = Some(AnalyzerRenderResult {
                        analyzer_id: request.analyzer_id.clone(),
                        tracks,
                    });
                    continue;
                }
            }

            let windows = if let Some(windows) = window_plans_by_key.get(&full_key) {
                windows.clone()
            } else {
                let windows = sparse_native_analysis_windows(capture, &request.settings, waveform)?;
                window_plans_by_key.insert(full_key.clone(), windows.clone());
                windows
            };
            if windows.is_empty() {
                let frames = Arc::new(Vec::new());
                let tracks = render_analyzer_tracks_timed(
                    &frames,
                    &request.tracks,
                    waveform,
                    &request.analyzer_id,
                    "no-windows",
                )?;
                rendered[request_index] = Some(AnalyzerRenderResult {
                    analyzer_id: request.analyzer_id.clone(),
                    tracks,
                });
                continue;
            }

            let mut frames = Vec::new();
            let window_entries = Vec::new();
            let mut missing_windows = Vec::new();
            for &(start, end) in &windows {
                if let Some(window_frames) =
                    self.cached_native_window_frames(&full_key, sample_count, start, end)
                {
                    frames.extend(window_frames.iter().cloned());
                } else {
                    missing_windows.push((start, end));
                }
            }
            let window_cache_key = serde_json::to_string(&(
                "sparse-native-window-v1",
                request.backend,
                &request.settings,
                &windows,
            ))?;

            if missing_windows.is_empty() {
                let mut frames = frames;
                normalize_native_decoded_frames(&mut frames);
                for frame in &mut frames {
                    frame.frame_id = frame.start_sample;
                }
                let uncapped_frame_count = frames.len();
                if frames.len() > MAX_DECODED_FRAMES {
                    let stride = frames.len().div_ceil(MAX_DECODED_FRAMES);
                    frames = frames.into_iter().step_by(stride).collect();
                    for frame in &mut frames {
                        frame.frame_id = frame.start_sample;
                    }
                }
                let frames = Arc::new(frames);
                let mut cache = self.analyzer_cache.lock();
                if cache.len().saturating_add(1) >= MAX_ANALYZER_WINDOW_CACHE_ENTRIES {
                    cache.clear();
                }
                cache.insert(
                    window_cache_key.clone(),
                    analyzer_cache_entry(sample_count, frames.clone()),
                );
                drop(cache);
                if uncapped_frame_count <= MAX_DECODED_FRAMES
                    && native_view_covers_capture(waveform, capture.metadata.sample_count)
                    && native_windows_cover_all_driver_edges(capture, &request.settings, &windows)?
                {
                    self.analyzer_cache.lock().insert(
                        full_key.clone(),
                        analyzer_cache_entry(sample_count, frames.clone()),
                    );
                }
                let tracks = render_analyzer_tracks_timed(
                    &frames,
                    &request.tracks,
                    waveform,
                    &request.analyzer_id,
                    "window-cache-hit",
                )?;
                rendered[request_index] = Some(AnalyzerRenderResult {
                    analyzer_id: request.analyzer_id.clone(),
                    tracks,
                });
            } else {
                pending.push(SaleaeBatchRenderState {
                    request_index,
                    request,
                    full_cache_key: full_key,
                    window_cache_key,
                    windows,
                    missing_windows,
                    frames,
                    window_entries,
                });
            }
        }

        if pending.is_empty() {
            return Ok(rendered
                .into_iter()
                .map(|item| item.expect("rendered analyzer is initialized"))
                .collect());
        }

        let decoder = SaleaeNativeDecoder::from_env_cached()
            .map_err(|error| GraphError::DecoderBackend(error.to_string()))?;

        let mut window_groups: HashMap<(u64, u64), Vec<usize>> = HashMap::new();
        for (pending_index, state) in pending.iter().enumerate() {
            for window in &state.missing_windows {
                window_groups
                    .entry(*window)
                    .or_default()
                    .push(pending_index);
            }
        }

        let window_group_entries = window_groups.into_iter().collect::<Vec<_>>();
        let window_group_count = window_group_entries.len();
        let worker_count = native_window_decode_worker_count(window_group_entries.len());
        let batch_window_decode_started = Instant::now();
        let mut used_window_batch = false;
        let group_outputs = if window_group_entries.len() > 1 {
            let window_batch_requests = window_group_entries
                .iter()
                .map(|((start, end), pending_indices)| {
                    (
                        *start,
                        *end,
                        pending_indices
                            .iter()
                            .map(|index| &pending[*index].request.settings)
                            .collect::<Vec<_>>(),
                    )
                })
                .collect::<Vec<_>>();
            match decoder
                .decode_sparse_view_window_batches(capture, &window_batch_requests)
                .map_err(|error| GraphError::DecoderBackend(error.to_string()))?
            {
                Some(decoded_windows) => {
                    used_window_batch = true;
                    window_group_entries
                        .iter()
                        .zip(decoded_windows)
                        .map(|(((start, end), pending_indices), outputs)| {
                            Ok(pending_indices
                                .iter()
                                .copied()
                                .zip(outputs)
                                .map(|(pending_index, output)| SaleaeBatchWindowDecodeResult {
                                    pending_index,
                                    start_sample: *start,
                                    end_sample: *end,
                                    frames: native_window_frames_from_output(output, *start),
                                })
                                .collect())
                        })
                        .collect::<Vec<_>>()
                }
                None => decode_saleae_batch_window_groups_individually(
                    &decoder,
                    capture,
                    &pending,
                    window_group_entries,
                    worker_count,
                ),
            }
        } else {
            decode_saleae_batch_window_groups_individually(
                &decoder,
                capture,
                &pending,
                window_group_entries,
                worker_count,
            )
        };

        let mut decoded_window_count = 0usize;
        let mut decoded_frame_count = 0usize;
        for group_output in group_outputs {
            for output in group_output? {
                decoded_window_count += 1;
                decoded_frame_count += output.frames.len();
                let state = &mut pending[output.pending_index];
                state.window_entries.push(NativeWindowCacheEntry {
                    decoded_sample_count: sample_count,
                    start_sample: output.start_sample,
                    end_sample: output.end_sample,
                    frames: output.frames,
                });
            }
        }
        trace_graph_timing(
            "saleae_batch_window_decode",
            batch_window_decode_started,
            &format!(
                "groups={} windows={} workers={} frames={} batched={}",
                window_group_count,
                decoded_window_count,
                worker_count,
                decoded_frame_count,
                used_window_batch
            ),
        );

        let finalize_started = Instant::now();
        let finalized_outputs = if pending.len() <= 1 {
            pending
                .into_iter()
                .map(|state| {
                    finalize_saleae_batch_render_state(state, waveform, capture, sample_count)
                })
                .collect::<Vec<_>>()
        } else {
            pending
                .into_par_iter()
                .map(|state| {
                    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        finalize_saleae_batch_render_state(state, waveform, capture, sample_count)
                    }))
                    .unwrap_or_else(|_| {
                        Err(GraphError::DecoderBackend(
                            "saleae batch finalize worker panicked".to_string(),
                        ))
                    })
                })
                .collect::<Vec<_>>()
        };
        trace_graph_timing(
            "saleae_batch_finalize",
            finalize_started,
            &format!("analyzers={}", finalized_outputs.len()),
        );

        for output in finalized_outputs {
            let finalized = output?;
            let mut cache = self.analyzer_cache.lock();
            if cache.len().saturating_add(1) >= MAX_ANALYZER_WINDOW_CACHE_ENTRIES {
                cache.clear();
            }
            cache.insert(finalized.window_cache_key, finalized.window_cache_entry);
            drop(cache);
            self.insert_native_window_cache_entries(
                &finalized.full_cache_key,
                finalized.window_entries,
            );
            if let Some((key, entry)) = finalized.full_cache_entry {
                self.analyzer_cache.lock().insert(key, entry);
            }
            rendered[finalized.request_index] = Some(finalized.render);
        }

        Ok(rendered
            .into_iter()
            .map(|item| item.expect("rendered analyzer is initialized"))
            .collect())
    }

    fn decode_sparse_frames_for_view(
        &self,
        capture: &SparseCaptureView<'_>,
        settings: &AnalyzerDecodeSettings,
        backend: DecoderBackendKind,
        waveform: &WaveformRequest,
    ) -> Result<Arc<Vec<DecodedFrame>>> {
        let sample_count = self.sample_count();
        let full_key = native_full_analyzer_cache_key(backend, settings)?;
        let native_window_analyzer_key = full_key.clone();
        if let Some(entry) = self.analyzer_cache.lock().get(&full_key) {
            if entry.decoded_sample_count == sample_count {
                trace_graph_timing(
                    "native_full_decode_cache_hit",
                    Instant::now(),
                    &format!("backend={backend:?} frames={}", entry.frames.len()),
                );
                return Ok(entry.frames.clone());
            }
        }

        let windows = sparse_native_analysis_windows(capture, settings, waveform)?;
        if windows.is_empty() {
            return Ok(Arc::new(Vec::new()));
        }

        let key = serde_json::to_string(&("sparse-native-window-v1", backend, settings, &windows))?;
        if let Some(entry) = self.analyzer_cache.lock().get(&key) {
            if entry.decoded_sample_count == sample_count {
                return Ok(entry.frames.clone());
            }
        }
        if let [(start, end)] = windows.as_slice() {
            if let Some(window_frames) = self.cached_native_window_frames(
                &native_window_analyzer_key,
                sample_count,
                *start,
                *end,
            ) {
                if window_frames.len() <= MAX_DECODED_FRAMES {
                    trace_graph_timing(
                        "native_single_window_cache_hit",
                        Instant::now(),
                        &format!("backend={backend:?} frames={}", window_frames.len()),
                    );
                    return Ok(window_frames);
                }
            }
        }

        let mut frames = Vec::new();
        let mut missing_windows = Vec::new();
        let mut window_cache_hits = 0usize;
        for &(start, end) in &windows {
            if let Some(window_frames) = self.cached_native_window_frames(
                &native_window_analyzer_key,
                sample_count,
                start,
                end,
            ) {
                frames.extend(window_frames.iter().cloned());
                window_cache_hits += 1;
            } else {
                missing_windows.push((start, end));
            }
        }

        let mut first_error = None;
        let mut decoded_window_entries = Vec::new();
        let window_decode_started = Instant::now();
        let worker_count = native_window_decode_worker_count(missing_windows.len());
        if missing_windows.is_empty() {
            trace_graph_timing(
                "native_window_cache_hit",
                window_decode_started,
                &format!(
                    "backend={backend:?} windows={} frames={}",
                    windows.len(),
                    frames.len()
                ),
            );
        } else if worker_count <= 1 {
            let decoder = native_decoder_for_backend(backend)?;
            for (start, end) in &missing_windows {
                let (decode_start, decode_end) =
                    native_decode_window_for_cache(capture, settings, *start, *end)?;
                match decoder.decode_sparse_view_window(capture, decode_start, decode_end, settings)
                {
                    Ok(output) => {
                        let window_frames = native_window_frames_from_output(output, decode_start);
                        frames.extend(window_frames.iter().cloned());
                        decoded_window_entries.push(NativeWindowCacheEntry {
                            decoded_sample_count: sample_count,
                            start_sample: decode_start,
                            end_sample: decode_end,
                            frames: window_frames,
                        });
                    }
                    Err(error) => {
                        first_error.get_or_insert_with(|| error.to_string());
                    }
                }
            }
        } else {
            let chunk_size = missing_windows.len().div_ceil(worker_count);
            let worker_outputs = missing_windows
                .par_chunks(chunk_size)
                .map(|chunk| {
                    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        let decoder = native_decoder_for_backend(backend)?;
                        let mut chunk_frames = Vec::new();
                        let mut chunk_window_entries = Vec::new();
                        let mut chunk_error = None;
                        for (start, end) in chunk {
                            let (decode_start, decode_end) =
                                native_decode_window_for_cache(capture, settings, *start, *end)?;
                            match decoder.decode_sparse_view_window(
                                capture,
                                decode_start,
                                decode_end,
                                settings,
                            ) {
                                Ok(output) => {
                                    let window_frames =
                                        native_window_frames_from_output(output, decode_start);
                                    chunk_frames.extend(window_frames.iter().cloned());
                                    chunk_window_entries.push(NativeWindowCacheEntry {
                                        decoded_sample_count: sample_count,
                                        start_sample: decode_start,
                                        end_sample: decode_end,
                                        frames: window_frames,
                                    });
                                }
                                Err(error) => {
                                    chunk_error.get_or_insert_with(|| error.to_string());
                                }
                            }
                        }
                        Ok::<_, GraphError>((chunk_frames, chunk_window_entries, chunk_error))
                    }))
                    .unwrap_or_else(|_| {
                        Err(GraphError::DecoderBackend(
                            "native window decode worker panicked".to_string(),
                        ))
                    })
                })
                .collect::<Vec<_>>();
            for output in worker_outputs {
                match output {
                    Ok((mut chunk_frames, mut chunk_window_entries, chunk_error)) => {
                        frames.append(&mut chunk_frames);
                        decoded_window_entries.append(&mut chunk_window_entries);
                        if let Some(error) = chunk_error {
                            first_error.get_or_insert(error);
                        }
                    }
                    Err(error) => {
                        first_error.get_or_insert_with(|| error.to_string());
                    }
                }
            }
        }
        trace_graph_timing(
            "native_window_decode",
            window_decode_started,
            &format!(
                "backend={backend:?} windows={} misses={} hits={} workers={} frames={}",
                windows.len(),
                missing_windows.len(),
                window_cache_hits,
                worker_count,
                frames.len()
            ),
        );
        if frames.is_empty() {
            if let Some(error) = first_error {
                return Err(GraphError::DecoderBackend(error));
            }
        }

        normalize_native_decoded_frames(&mut frames);
        for frame in &mut frames {
            frame.frame_id = frame.start_sample;
        }
        let uncapped_frame_count = frames.len();
        if frames.len() > MAX_DECODED_FRAMES {
            let stride = frames.len().div_ceil(MAX_DECODED_FRAMES);
            frames = frames.into_iter().step_by(stride).collect();
            for frame in &mut frames {
                frame.frame_id = frame.start_sample;
            }
        }

        let frames = Arc::new(frames);
        let mut cache = self.analyzer_cache.lock();
        if cache.len().saturating_add(2) >= MAX_ANALYZER_WINDOW_CACHE_ENTRIES {
            cache.clear();
        }
        cache.insert(key, analyzer_cache_entry(sample_count, frames.clone()));
        drop(cache);
        self.insert_native_window_cache_entries(
            &native_window_analyzer_key,
            decoded_window_entries,
        );
        let mut cache = self.analyzer_cache.lock();
        if uncapped_frame_count <= MAX_DECODED_FRAMES
            && native_view_covers_capture(waveform, capture.metadata.sample_count)
            && native_windows_cover_all_driver_edges(capture, settings, &windows)?
        {
            cache.insert(full_key, analyzer_cache_entry(sample_count, frames.clone()));
        }
        Ok(frames)
    }

    fn cached_native_window_frames(
        &self,
        analyzer_key: &str,
        sample_count: u64,
        start_sample: u64,
        end_sample: u64,
    ) -> Option<Arc<Vec<DecodedFrame>>> {
        let cache = self.native_window_cache.lock();
        let exact_key = NativeWindowCacheKey {
            analyzer_key: analyzer_key.to_string(),
            start_sample,
            end_sample,
        };
        if let Some(entry) = cache.get(&exact_key) {
            if entry.decoded_sample_count == sample_count {
                return Some(entry.frames.clone());
            }
        }
        cache
            .iter()
            .filter(|(key, entry)| {
                key.analyzer_key == analyzer_key
                    && key.start_sample == entry.start_sample
                    && key.end_sample == entry.end_sample
                    && entry.decoded_sample_count == sample_count
                    && entry.start_sample <= start_sample
                    && entry.end_sample >= end_sample
            })
            .min_by_key(|(_, entry)| entry.end_sample.saturating_sub(entry.start_sample))
            .map(|(_, entry)| entry.frames.clone())
    }

    fn cached_native_analyzer_frames(
        &self,
        analyzer_key: &str,
        sample_count: u64,
    ) -> Vec<DecodedFrame> {
        let cache = self.native_window_cache.lock();
        let mut frames = cache
            .iter()
            .filter(|(key, entry)| {
                key.analyzer_key == analyzer_key && entry.decoded_sample_count == sample_count
            })
            .flat_map(|(_, entry)| entry.frames.iter().cloned())
            .collect::<Vec<_>>();
        drop(cache);
        normalize_native_decoded_frames(&mut frames);
        for frame in &mut frames {
            frame.frame_id = frame.start_sample;
        }
        frames
    }

    fn insert_native_window_cache_entries(
        &self,
        analyzer_key: &str,
        entries: Vec<NativeWindowCacheEntry>,
    ) {
        if entries.is_empty() {
            return;
        }
        let mut cache = self.native_window_cache.lock();
        if cache.len().saturating_add(entries.len()) >= MAX_ANALYZER_WINDOW_CACHE_ENTRIES {
            cache.clear();
        }
        for entry in entries {
            cache.insert(
                NativeWindowCacheKey {
                    analyzer_key: analyzer_key.to_string(),
                    start_sample: entry.start_sample,
                    end_sample: entry.end_sample,
                },
                entry,
            );
        }
    }

    fn clear_analyzer_caches(&self) {
        self.analyzer_generation.fetch_add(1, Ordering::AcqRel);
        self.analyzer_cache.lock().clear();
        self.native_window_cache.lock().clear();
        let async_decode_ids = {
            let mut background = self.native_background_cache.lock();
            let ids = background
                .values()
                .filter(|state| state.async_started)
                .map(|state| state.async_decode_id.clone())
                .collect::<Vec<_>>();
            background.clear();
            ids
        };
        cancel_saleae_async_decode_ids(async_decode_ids.iter().map(String::as_str));
    }

    fn bump_revision(&self) {
        self.revision.fetch_add(1, Ordering::AcqRel);
    }
}

impl Drop for GraphSession {
    fn drop(&mut self) {
        let async_decode_ids = self
            .native_background_cache
            .get_mut()
            .values()
            .filter(|state| state.async_started)
            .map(|state| state.async_decode_id.clone())
            .collect::<Vec<_>>();
        tracing::info!(
            target: "sigpilot::graph",
            session_id = self.instance_id,
            sample_count = self.sample_count(),
            live_async_decodes = async_decode_ids.len(),
            "graph session released"
        );
        cancel_saleae_async_decode_ids(async_decode_ids.iter().map(String::as_str));
    }
}

fn cancel_saleae_async_decode_ids<'a>(decode_ids: impl IntoIterator<Item = &'a str>) {
    let decode_ids = decode_ids.into_iter().collect::<Vec<_>>();
    if decode_ids.is_empty() {
        return;
    }
    let Ok(decoder) = SaleaeNativeDecoder::from_env_cached() else {
        return;
    };
    decode_ids.into_par_iter().for_each(|decode_id| {
        let _ = decoder.cancel_async_decode(decode_id);
    });
}

fn native_driver_channel<'capture, 'data>(
    capture: &'capture SparseCaptureView<'data>,
    settings: &AnalyzerDecodeSettings,
) -> Result<&'capture SparseDigitalChannelView<'data>> {
    let driver_channel = match settings {
        AnalyzerDecodeSettings::Uart(settings) => settings.channel,
        AnalyzerDecodeSettings::I2c(settings) => settings.scl_channel,
        AnalyzerDecodeSettings::Spi(settings) => settings.clock_channel,
        AnalyzerDecodeSettings::Native(settings) => settings.primary_channel,
    };
    capture
        .channels
        .iter()
        .find(|channel| channel.channel == driver_channel)
        .ok_or_else(|| {
            GraphError::InvalidAnalyzer(format!(
                "native decoder clock/input channel D{driver_channel} is not present"
            ))
        })
}

fn native_background_window(
    capture: &SparseCaptureView<'_>,
    settings: &AnalyzerDecodeSettings,
    body_edge_begin: usize,
    body_edge_budget: usize,
) -> Result<NativeBackgroundWindow> {
    let driver = native_driver_channel(capture, settings)?;
    let total_edges = driver.transitions.len();
    if body_edge_begin >= total_edges || body_edge_budget == 0 {
        return Err(GraphError::InvalidAnalyzer(
            "native background decode edge range is empty".to_string(),
        ));
    }
    let mut body_edge_end = body_edge_begin
        .saturating_add(body_edge_budget)
        .min(total_edges);
    let context_begin = body_edge_begin.saturating_sub(NATIVE_BACKGROUND_CONTEXT_EDGES);
    let context_end = body_edge_end
        .saturating_add(NATIVE_BACKGROUND_CONTEXT_EDGES)
        .min(total_edges);
    let mut decode_start_sample = if context_begin == 0 {
        0
    } else {
        driver.transitions[context_begin].saturating_sub(1)
    };
    let mut decode_end_sample = if context_end >= total_edges {
        capture.metadata.sample_count
    } else {
        driver.transitions[context_end - 1]
            .saturating_add(2)
            .min(capture.metadata.sample_count)
    };
    (decode_start_sample, decode_end_sample) =
        align_spi_window_to_enable(capture, settings, decode_start_sample, decode_end_sample);

    let complete_decode_start = driver.transitions[0].saturating_sub(1);
    let complete_decode_end = driver.transitions[total_edges - 1]
        .saturating_add(2)
        .min(capture.metadata.sample_count);
    if decode_start_sample <= complete_decode_start && decode_end_sample >= complete_decode_end {
        body_edge_end = total_edges;
    }

    let retain_start_sample = if body_edge_begin == 0 {
        0
    } else {
        driver.transitions[body_edge_begin]
    };
    let retain_end_sample = if body_edge_end >= total_edges {
        capture.metadata.sample_count
    } else {
        driver.transitions[body_edge_end]
    };
    Ok(NativeBackgroundWindow {
        body_edge_begin,
        body_edge_end,
        retain_start_sample,
        retain_end_sample,
        decode_start_sample,
        decode_end_sample,
    })
}

fn decode_native_background_group(
    decoder: &SaleaeNativeDecoder,
    capture: &SparseCaptureView<'_>,
    group: Vec<NativeBackgroundPending<'_>>,
) -> Result<Vec<NativeBackgroundDecoded>> {
    let Some(first) = group.first() else {
        return Ok(Vec::new());
    };
    let start_sample = first.window.decode_start_sample;
    let end_sample = first.window.decode_end_sample;
    let setting_refs = group.iter().map(|task| task.settings).collect::<Vec<_>>();
    let outputs = decoder
        .decode_sparse_view_window_batch(capture, start_sample, end_sample, &setting_refs)
        .map_err(|error| GraphError::DecoderBackend(error.to_string()))?;
    let outputs = match outputs {
        Some(outputs) => outputs,
        None => setting_refs
            .iter()
            .map(|settings| {
                decoder
                    .decode_sparse_view_window(capture, start_sample, end_sample, settings)
                    .map_err(|error| GraphError::DecoderBackend(error.to_string()))
            })
            .collect::<Result<Vec<_>>>()?,
    };
    if outputs.len() != group.len() {
        return Err(GraphError::DecoderBackend(format!(
            "Saleae background decode returned {} outputs for {} analyzers",
            outputs.len(),
            group.len()
        )));
    }
    Ok(group
        .into_iter()
        .zip(outputs)
        .map(|(task, output)| NativeBackgroundDecoded {
            key: task.key,
            window: task.window,
            frames: native_window_frames_from_output(output, start_sample),
        })
        .collect())
}

fn append_native_background_frames(
    accumulated: &mut Vec<DecodedFrame>,
    mut incoming: Vec<DecodedFrame>,
) {
    if incoming.is_empty() {
        return;
    }
    let remains_ordered = match (accumulated.last(), incoming.first()) {
        (Some(left), Some(right)) => {
            left.start_sample < right.start_sample
                || (left.start_sample == right.start_sample && left.end_sample <= right.end_sample)
        }
        _ => true,
    };
    accumulated.append(&mut incoming);
    if remains_ordered {
        accumulated.dedup_by(|right, left| same_decoded_frame(left, right));
    } else {
        normalize_native_decoded_frames(accumulated);
    }
}

fn attach_native_completion_markers(
    frames: &mut [DecodedFrame],
    mut markers: Vec<DecodedProtocolMarker>,
) {
    for frame in frames.iter_mut() {
        frame.protocol_markers.clear();
    }
    if frames.is_empty() || markers.is_empty() {
        return;
    }
    markers.sort_by(|left, right| {
        left.sample
            .cmp(&right.sample)
            .then_with(|| left.channel.cmp(&right.channel))
            .then_with(|| left.kind.cmp(&right.kind))
    });
    markers.dedup();
    let mut frame_index = 0usize;
    for marker in markers {
        while frame_index + 1 < frames.len()
            && frames[frame_index + 1].start_sample <= marker.sample
        {
            frame_index += 1;
        }
        frames[frame_index].protocol_markers.push(marker);
    }
}

fn decode_saleae_batch_window_group(
    decoder: &SaleaeNativeDecoder,
    capture: &SparseCaptureView<'_>,
    pending: &[SaleaeBatchRenderState<'_>],
    start_sample: u64,
    end_sample: u64,
    pending_indices: Vec<usize>,
) -> Result<Vec<SaleaeBatchWindowDecodeResult>> {
    let settings_refs = pending_indices
        .iter()
        .map(|index| &pending[*index].request.settings)
        .collect::<Vec<_>>();
    let decoded = decoder
        .decode_sparse_view_window_batch(capture, start_sample, end_sample, &settings_refs)
        .map_err(|error| GraphError::DecoderBackend(error.to_string()))?;
    let outputs = match decoded {
        Some(outputs) => outputs,
        None => settings_refs
            .iter()
            .map(|setting| {
                decoder
                    .decode_sparse_view_window(capture, start_sample, end_sample, setting)
                    .map_err(|error| GraphError::DecoderBackend(error.to_string()))
            })
            .collect::<Result<Vec<_>>>()?,
    };

    Ok(pending_indices
        .into_iter()
        .zip(outputs)
        .map(|(pending_index, output)| SaleaeBatchWindowDecodeResult {
            pending_index,
            start_sample,
            end_sample,
            frames: native_window_frames_from_output(output, start_sample),
        })
        .collect())
}

fn decode_saleae_batch_window_groups_individually(
    decoder: &SaleaeNativeDecoder,
    capture: &SparseCaptureView<'_>,
    pending: &[SaleaeBatchRenderState<'_>],
    window_group_entries: Vec<((u64, u64), Vec<usize>)>,
    worker_count: usize,
) -> Vec<Result<Vec<SaleaeBatchWindowDecodeResult>>> {
    if worker_count <= 1 {
        return window_group_entries
            .into_iter()
            .map(|((start, end), pending_indices)| {
                decode_saleae_batch_window_group(
                    decoder,
                    capture,
                    pending,
                    start,
                    end,
                    pending_indices,
                )
            })
            .collect();
    }

    let chunk_size = window_group_entries.len().div_ceil(worker_count);
    window_group_entries
        .par_chunks(chunk_size)
        .map(|chunk| {
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                chunk
                    .iter()
                    .map(|((start, end), pending_indices)| {
                        decode_saleae_batch_window_group(
                            decoder,
                            capture,
                            pending,
                            *start,
                            *end,
                            pending_indices.clone(),
                        )
                    })
                    .collect::<Vec<_>>()
            }))
            .unwrap_or_else(|_| {
                vec![Err(GraphError::DecoderBackend(
                    "saleae batch window decode worker panicked".to_string(),
                ))]
            })
        })
        .flatten()
        .collect()
}

fn finalize_saleae_batch_render_state(
    state: SaleaeBatchRenderState<'_>,
    waveform: &WaveformRequest,
    capture: &SparseCaptureView<'_>,
    sample_count: u64,
) -> Result<SaleaeBatchFinalizedRender> {
    let window_entries = state.window_entries;
    let (frames, uncapped_frame_count) = if state.frames.is_empty()
        && window_entries.len() == 1
        && window_entries[0].frames.len() <= MAX_DECODED_FRAMES
    {
        (
            window_entries[0].frames.clone(),
            window_entries[0].frames.len(),
        )
    } else {
        let mut frames = state.frames;
        for entry in &window_entries {
            frames.extend(entry.frames.iter().cloned());
        }
        normalize_native_decoded_frames(&mut frames);
        for frame in &mut frames {
            frame.frame_id = frame.start_sample;
        }
        let uncapped_frame_count = frames.len();
        if frames.len() > MAX_DECODED_FRAMES {
            let stride = frames.len().div_ceil(MAX_DECODED_FRAMES);
            frames = frames.into_iter().step_by(stride).collect();
            for frame in &mut frames {
                frame.frame_id = frame.start_sample;
            }
        }
        (Arc::new(frames), uncapped_frame_count)
    };

    let window_cache_entry = analyzer_cache_entry(sample_count, frames.clone());
    let full_cache_entry = if uncapped_frame_count <= MAX_DECODED_FRAMES
        && native_view_covers_capture(waveform, capture.metadata.sample_count)
        && native_windows_cover_all_driver_edges(capture, &state.request.settings, &state.windows)?
    {
        Some((
            state.full_cache_key.clone(),
            analyzer_cache_entry(sample_count, frames.clone()),
        ))
    } else {
        None
    };
    let tracks = render_analyzer_tracks_timed(
        &frames,
        &state.request.tracks,
        waveform,
        &state.request.analyzer_id,
        "batch-finalize",
    )?;

    Ok(SaleaeBatchFinalizedRender {
        request_index: state.request_index,
        full_cache_key: state.full_cache_key,
        window_cache_key: state.window_cache_key,
        window_cache_entry,
        full_cache_entry,
        window_entries,
        render: AnalyzerRenderResult {
            analyzer_id: state.request.analyzer_id.clone(),
            tracks,
        },
    })
}

fn offset_decoded_frame_samples(frame: &mut DecodedFrame, offset: u64) {
    frame.start_sample = frame.start_sample.saturating_add(offset);
    frame.end_sample = frame.end_sample.saturating_add(offset);
    for marker in &mut frame.protocol_markers {
        marker.sample = marker.sample.saturating_add(offset);
    }
}

fn native_window_frames_from_output(
    output: sigpilot_core::DecoderOutput,
    offset: u64,
) -> Arc<Vec<DecodedFrame>> {
    let mut frames = output.into_decoded_frames();
    if offset > 0 {
        for frame in &mut frames {
            offset_decoded_frame_samples(frame, offset);
        }
    }
    normalize_native_decoded_frames(&mut frames);
    for frame in &mut frames {
        frame.frame_id = frame.start_sample;
    }
    Arc::new(frames)
}

fn native_full_analyzer_cache_key(
    backend: DecoderBackendKind,
    settings: &AnalyzerDecodeSettings,
) -> Result<String> {
    serde_json::to_string(&(backend, settings)).map_err(GraphError::from)
}

fn native_async_decode_id(instance_id: u64, generation: u64, analyzer_key: &str) -> String {
    let mut hash = 0xcbf29ce484222325u64;
    for byte in analyzer_key.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("graph-{instance_id}-generation-{generation}-analyzer-{hash:016x}")
}

fn native_view_covers_capture(waveform: &WaveformRequest, sample_count: u64) -> bool {
    waveform.start_sample == 0 && waveform.sample_count >= sample_count
}

fn native_windows_cover_all_driver_edges(
    capture: &SparseCaptureView<'_>,
    settings: &AnalyzerDecodeSettings,
    windows: &[(u64, u64)],
) -> Result<bool> {
    let driver_channel = match settings {
        AnalyzerDecodeSettings::Uart(settings) => settings.channel,
        AnalyzerDecodeSettings::I2c(settings) => settings.scl_channel,
        AnalyzerDecodeSettings::Spi(settings) => settings.clock_channel,
        AnalyzerDecodeSettings::Native(settings) => settings.primary_channel,
    };
    let driver = capture
        .channels
        .iter()
        .find(|channel| channel.channel == driver_channel)
        .ok_or_else(|| {
            GraphError::InvalidAnalyzer(format!(
                "native decoder clock/input channel D{driver_channel} is not present"
            ))
        })?;
    let (Some(first), Some(last)) = (driver.transitions.first(), driver.transitions.last()) else {
        return Ok(false);
    };
    Ok(windows.len() == 1
        && windows[0].0 <= first.saturating_sub(1)
        && windows[0].1 >= last.saturating_add(2).min(capture.metadata.sample_count))
}

fn native_window_decode_worker_count(window_count: usize) -> usize {
    let available = std::thread::available_parallelism()
        .map(usize::from)
        .unwrap_or(MAX_DEFAULT_PARALLEL_NATIVE_WINDOW_DECODES);
    let configured = std::env::var(NATIVE_WINDOW_DECODE_WORKERS_ENV).ok();
    native_window_decode_worker_count_value(window_count, configured.as_deref(), available)
}

fn native_window_decode_worker_count_value(
    window_count: usize,
    configured: Option<&str>,
    available: usize,
) -> usize {
    if window_count <= 1 {
        return 1;
    }
    let default = default_native_window_decode_worker_count(available);
    let requested = configured
        .and_then(|value| value.trim().parse::<usize>().ok())
        .filter(|count| *count > 0)
        .unwrap_or(default);
    requested.min(available.max(1)).min(window_count).max(1)
}

fn default_native_window_decode_worker_count(available: usize) -> usize {
    let available = available.max(1);
    match available {
        1 => 1,
        2 => 2,
        _ => available
            .saturating_sub(1)
            .min(MAX_DEFAULT_PARALLEL_NATIVE_WINDOW_DECODES)
            .max(2),
    }
}

fn native_decoder_for_backend(backend: DecoderBackendKind) -> Result<Box<dyn DecoderBackend>> {
    match backend {
        DecoderBackendKind::SaleaeNative => Ok(Box::new(
            SaleaeNativeDecoder::from_env_cached()
                .map_err(|error| GraphError::DecoderBackend(error.to_string()))?,
        )),
        DecoderBackendKind::SigrokNative => Ok(Box::new(
            SigrokNativeDecoder::from_env_cached()
                .map_err(|error| GraphError::DecoderBackend(error.to_string()))?,
        )),
        DecoderBackendKind::Auto | DecoderBackendKind::LegacyRust => unreachable!(),
    }
}

fn trimmed_metadata(metadata: &CaptureMetadata, start: u64, end: u64) -> Result<CaptureMetadata> {
    if start >= end || end > metadata.sample_count {
        return Err(GraphError::InvalidTrimRange);
    }
    let mut trimmed = metadata.clone();
    trimmed.sample_count = end - start;
    trimmed.trigger = trimmed.trigger.and_then(|mut trigger| {
        if trigger.sample_index < start || trigger.sample_index >= end {
            return None;
        }
        trigger.sample_index -= start;
        Some(trigger)
    });
    Ok(trimmed)
}

fn trim_packed_capture(
    capture: &mut Arc<CaptureData>,
    metadata: CaptureMetadata,
    start: u64,
    end: u64,
) -> Result<usize> {
    let unit_size = usize::from(capture.metadata.unitsize);
    let byte_start = usize::try_from(start)
        .ok()
        .and_then(|sample| sample.checked_mul(unit_size))
        .ok_or(GraphError::InvalidMetadata)?;
    let byte_end = usize::try_from(end)
        .ok()
        .and_then(|sample| sample.checked_mul(unit_size))
        .ok_or(GraphError::InvalidMetadata)?;
    if unit_size == 0 || byte_end > capture.samples.len() || byte_start > byte_end {
        return Err(GraphError::InvalidMetadata);
    }

    if let Some(capture) = Arc::get_mut(capture) {
        if byte_start > 0 {
            capture.samples.copy_within(byte_start..byte_end, 0);
        }
        capture.samples.truncate(byte_end - byte_start);
        capture.metadata = metadata;
    } else {
        *capture = Arc::new(CaptureData {
            metadata,
            samples: capture.samples[byte_start..byte_end].to_vec(),
        });
    }
    Ok(byte_end - byte_start)
}

fn trim_sparse_capture(
    capture: &mut Arc<SparseCaptureData>,
    metadata: CaptureMetadata,
    start: u64,
    end: u64,
) -> Result<usize> {
    let trim_channel = |channel: &mut SparseDigitalChannel| {
        let first_edge = channel.transitions.partition_point(|edge| *edge <= start);
        let end_edge = channel.transitions.partition_point(|edge| *edge < end);
        channel.initial_high ^= first_edge % 2 == 1;
        let retained_edges = end_edge.saturating_sub(first_edge);
        channel.transitions.copy_within(first_edge..end_edge, 0);
        channel.transitions.truncate(retained_edges);
        channel
            .transitions
            .iter_mut()
            .for_each(|edge| *edge -= start);
    };

    if let Some(capture) = Arc::get_mut(capture) {
        capture.channels.iter_mut().for_each(trim_channel);
        capture.metadata = metadata;
    } else {
        let mut trimmed = capture.as_ref().clone();
        trimmed.channels.iter_mut().for_each(trim_channel);
        trimmed.metadata = metadata;
        *capture = Arc::new(trimmed);
    }
    Ok(capture
        .channels
        .iter()
        .map(|channel| channel.transitions.len().saturating_mul(8))
        .sum())
}

fn sparse_native_analysis_windows(
    capture: &SparseCaptureView<'_>,
    settings: &AnalyzerDecodeSettings,
    waveform: &WaveformRequest,
) -> Result<Vec<(u64, u64)>> {
    if capture.metadata.sample_count == 0 || waveform.sample_count == 0 {
        return Ok(Vec::new());
    }
    let driver_channel = match settings {
        AnalyzerDecodeSettings::Uart(settings) => settings.channel,
        AnalyzerDecodeSettings::I2c(settings) => settings.scl_channel,
        AnalyzerDecodeSettings::Spi(settings) => settings.clock_channel,
        AnalyzerDecodeSettings::Native(settings) => settings.primary_channel,
    };
    let driver = capture
        .channels
        .iter()
        .find(|channel| channel.channel == driver_channel)
        .ok_or_else(|| {
            GraphError::InvalidAnalyzer(format!(
                "native decoder clock/input channel D{driver_channel} is not present"
            ))
        })?;
    if driver.transitions.is_empty() {
        return Ok(Vec::new());
    }

    let view_start = waveform
        .start_sample
        .min(capture.metadata.sample_count.saturating_sub(1));
    let view_end = waveform
        .start_sample
        .saturating_add(waveform.sample_count)
        .min(capture.metadata.sample_count)
        .max(view_start.saturating_add(1));
    let edge_begin = driver
        .transitions
        .partition_point(|sample| *sample < view_start);
    let edge_end = driver
        .transitions
        .partition_point(|sample| *sample < view_end);
    let visible_edges = edge_end - edge_begin;
    let mut edge_windows = Vec::new();
    if visible_edges == 0 {
        let center = edge_begin.min(driver.transitions.len() - 1);
        edge_windows.push((
            center.saturating_sub(NATIVE_CONTEXT_EDGES),
            center
                .saturating_add(NATIVE_CONTEXT_EDGES)
                .saturating_add(1)
                .min(driver.transitions.len()),
        ));
    } else if visible_edges <= NATIVE_VIEW_EDGE_BUDGET {
        edge_windows.push((
            edge_begin.saturating_sub(NATIVE_CONTEXT_EDGES),
            edge_end
                .saturating_add(NATIVE_CONTEXT_EDGES)
                .min(driver.transitions.len()),
        ));
    } else {
        let chunk_count = NATIVE_FIT_MAX_CHUNKS
            .min((waveform.pixels.max(1) as usize).div_ceil(96))
            .max(2);
        for chunk in 0..chunk_count {
            let center = edge_begin
                + visible_edges.saturating_sub(1) * chunk / chunk_count.saturating_sub(1);
            let body_start = center.saturating_sub(NATIVE_FIT_EDGES_PER_CHUNK / 2);
            let body_end = center
                .saturating_add(NATIVE_FIT_EDGES_PER_CHUNK / 2)
                .saturating_add(1);
            edge_windows.push((
                body_start.saturating_sub(NATIVE_CONTEXT_EDGES),
                body_end
                    .saturating_add(NATIVE_CONTEXT_EDGES)
                    .min(driver.transitions.len()),
            ));
        }
    }

    let mut windows = edge_windows
        .into_iter()
        .filter(|(begin, end)| begin < end)
        .map(|(begin, end)| {
            let start = driver.transitions[begin].saturating_sub(1);
            let finish = driver.transitions[end - 1]
                .saturating_add(2)
                .min(capture.metadata.sample_count);
            align_spi_window_to_enable(capture, settings, start, finish)
        })
        .filter(|(start, end)| start < end)
        .collect::<Vec<_>>();
    windows.sort_unstable();
    let mut merged: Vec<(u64, u64)> = Vec::with_capacity(windows.len());
    for (start, end) in windows {
        if let Some(previous) = merged.last_mut() {
            if start <= previous.1 {
                previous.1 = previous.1.max(end);
                continue;
            }
        }
        merged.push((start, end));
    }
    Ok(merged)
}

fn native_decode_window_for_cache(
    capture: &SparseCaptureView<'_>,
    settings: &AnalyzerDecodeSettings,
    start: u64,
    end: u64,
) -> Result<(u64, u64)> {
    if start >= end || capture.metadata.sample_count == 0 {
        return Ok((start, end));
    }
    let driver_channel = match settings {
        AnalyzerDecodeSettings::Uart(settings) => settings.channel,
        AnalyzerDecodeSettings::I2c(settings) => settings.scl_channel,
        AnalyzerDecodeSettings::Spi(settings) => settings.clock_channel,
        AnalyzerDecodeSettings::Native(settings) => settings.primary_channel,
    };
    let driver = capture
        .channels
        .iter()
        .find(|channel| channel.channel == driver_channel)
        .ok_or_else(|| {
            GraphError::InvalidAnalyzer(format!(
                "native decoder clock/input channel D{driver_channel} is not present"
            ))
        })?;
    if driver.transitions.is_empty() {
        return Ok((start, end.min(capture.metadata.sample_count)));
    }

    let edge_begin = driver.transitions.partition_point(|sample| *sample < start);
    let edge_end = driver.transitions.partition_point(|sample| *sample < end);
    let expanded_begin = edge_begin.saturating_sub(NATIVE_CACHE_REUSE_EDGES);
    let expanded_end = edge_end
        .saturating_add(NATIVE_CACHE_REUSE_EDGES)
        .min(driver.transitions.len());
    if expanded_begin >= expanded_end {
        return Ok((start, end.min(capture.metadata.sample_count)));
    }

    let expanded_start = start.min(driver.transitions[expanded_begin].saturating_sub(1));
    let expanded_end_sample = end
        .max(
            driver.transitions[expanded_end - 1]
                .saturating_add(2)
                .min(capture.metadata.sample_count),
        )
        .min(capture.metadata.sample_count);
    Ok(align_spi_window_to_enable(
        capture,
        settings,
        expanded_start,
        expanded_end_sample,
    ))
}

fn align_spi_window_to_enable(
    capture: &SparseCaptureView<'_>,
    settings: &AnalyzerDecodeSettings,
    mut start: u64,
    mut end: u64,
) -> (u64, u64) {
    let AnalyzerDecodeSettings::Spi(settings) = settings else {
        return (start, end);
    };
    let Some(enable_channel) = settings.enable_channel else {
        return (start, end);
    };
    let Some(enable) = capture
        .channels
        .iter()
        .find(|channel| channel.channel == enable_channel)
    else {
        return (start, end);
    };
    let is_active = |high: bool| high != settings.enable_active_low;
    if is_active(sparse_level_at(enable, start)) {
        let previous = enable
            .transitions
            .partition_point(|sample| *sample <= start);
        if previous > 0 {
            start = enable.transitions[previous - 1].saturating_sub(1);
        }
    }
    if end > 0 && is_active(sparse_level_at(enable, end - 1)) {
        let next = enable.transitions.partition_point(|sample| *sample < end);
        if let Some(sample) = enable.transitions.get(next) {
            end = sample.saturating_add(1).min(capture.metadata.sample_count);
        }
    }
    (start, end)
}

fn sparse_level_at(channel: &SparseDigitalChannelView<'_>, sample: u64) -> bool {
    channel.initial_high
        ^ (channel
            .transitions
            .partition_point(|transition| *transition <= sample)
            % 2
            == 1)
}

#[cfg(test)]
fn slice_sparse_capture(
    capture: &SparseCaptureData,
    start: u64,
    end: u64,
) -> Result<SparseCaptureData> {
    if start >= end || end > capture.metadata.sample_count {
        return Err(GraphError::InvalidWaveformRequest);
    }
    let channels = capture
        .channels
        .iter()
        .map(|channel| {
            let begin = channel
                .transitions
                .partition_point(|sample| *sample <= start);
            let finish = channel.transitions.partition_point(|sample| *sample < end);
            SparseDigitalChannel {
                channel: channel.channel,
                initial_high: channel.initial_high ^ (begin % 2 == 1),
                transitions: channel.transitions[begin..finish]
                    .iter()
                    .map(|sample| sample - start)
                    .collect(),
            }
        })
        .collect();
    let mut metadata = capture.metadata.clone();
    metadata.sample_count = end - start;
    metadata.trigger = None;
    Ok(SparseCaptureData { metadata, channels })
}

fn merge_incremental_frames(
    mut cached: Vec<DecodedFrame>,
    mut incremental: Vec<DecodedFrame>,
    resume_sample: u64,
) -> Vec<DecodedFrame> {
    let frame_id_offset = incremental
        .iter()
        .find_map(|candidate| {
            cached
                .iter()
                .rev()
                .find(|existing| same_decoded_frame(existing, candidate))
                .map(|existing| existing.frame_id.saturating_sub(candidate.frame_id))
        })
        .unwrap_or_else(|| {
            cached
                .last()
                .map(|frame| frame.frame_id.saturating_add(1))
                .unwrap_or(0)
        });
    for frame in &mut incremental {
        frame.frame_id = frame.frame_id.saturating_add(frame_id_offset);
    }
    let keep = cached.partition_point(|frame| frame.end_sample <= resume_sample);
    cached.truncate(keep);
    cached.reserve(incremental.len());
    cached.extend(incremental);
    let mut merged = cached;
    normalize_native_decoded_frames(&mut merged);
    if merged.len() > MAX_DECODED_FRAMES {
        let stride = merged.len().div_ceil(MAX_DECODED_FRAMES);
        let last = merged.last().cloned();
        merged = merged.into_iter().step_by(stride).collect();
        if let Some(last) = last {
            if merged.last().map(|frame| frame.start_sample) != Some(last.start_sample) {
                if merged.len() >= MAX_DECODED_FRAMES {
                    merged.pop();
                }
                merged.push(last);
            }
        }
    }
    merged
}

fn normalize_native_decoded_frames(frames: &mut Vec<DecodedFrame>) {
    if frames.len() <= 1 {
        return;
    }
    if !decoded_frames_are_ordered(frames) {
        frames.sort_by_key(|frame| (frame.start_sample, frame.end_sample));
    }
    frames.dedup_by(|right, left| same_decoded_frame(left, right));
}

fn decoded_frames_are_ordered(frames: &[DecodedFrame]) -> bool {
    frames.windows(2).all(|pair| {
        let left = &pair[0];
        let right = &pair[1];
        left.start_sample < right.start_sample
            || (left.start_sample == right.start_sample && left.end_sample <= right.end_sample)
    })
}

fn same_decoded_frame(left: &DecodedFrame, right: &DecodedFrame) -> bool {
    left.start_sample == right.start_sample
        && left.end_sample == right.end_sample
        && left.channel_values == right.channel_values
        && left.value == right.value
}

fn validate_metadata(metadata: &CaptureMetadata) -> Result<()> {
    if !(1..=MAX_CHANNELS).contains(&metadata.channel_count) {
        return Err(GraphError::InvalidMetadata);
    }
    let expected_unit_size = match metadata.channel_count {
        1..=8 => 1,
        9..=16 => 2,
        17..=32 => 4,
        _ => unreachable!(),
    };
    if metadata.unitsize != expected_unit_size || metadata.sample_rate_hz == 0 {
        return Err(GraphError::InvalidMetadata);
    }
    let enabled_channels = metadata_enabled_channels(metadata)?;
    if metadata.trigger.as_ref().is_some_and(|trigger| {
        trigger.channel >= metadata.channel_count || !enabled_channels.contains(&trigger.channel)
    }) {
        return Err(GraphError::InvalidMetadata);
    }
    Ok(())
}

fn metadata_enabled_channels(metadata: &CaptureMetadata) -> Result<Vec<u8>> {
    resolve_enabled_channels(metadata.channel_count, &metadata.enabled_channels)
        .map_err(|_| GraphError::InvalidMetadata)
}

fn channel_mask(channel_count: u8) -> u32 {
    if channel_count == 32 {
        u32::MAX
    } else {
        (1u32 << channel_count) - 1
    }
}

fn read_word(bytes: &[u8], unit_size: u8) -> Option<u32> {
    match unit_size {
        1 => bytes.first().copied().map(u32::from),
        2 => Some(u32::from(u16::from_le_bytes(bytes.try_into().ok()?))),
        4 => Some(u32::from_le_bytes(bytes.try_into().ok()?)),
        _ => None,
    }
}

fn requested_channels(request: &WaveformRequest, channel_count: u8) -> Vec<u8> {
    let source = if request.channels.is_empty() {
        (0..channel_count).collect()
    } else {
        request.channels.clone()
    };
    source
        .into_iter()
        .filter(|channel| *channel < channel_count)
        .collect()
}

fn summarize_indexed_bin(index: &DigitalChannelIndex, x: u32, start: u64, end: u64) -> WaveformBin {
    let first_edge = index.first_edge_after(start);
    let edge_end = index.edge_count_at_or_before(end.saturating_sub(1));
    let first = index.initial_high ^ (first_edge % 2 == 1);
    let last = index.initial_high ^ (edge_end % 2 == 1);
    let edge_count = edge_end.saturating_sub(first_edge);
    let first_edge_offset = (edge_count > 0).then(|| {
        index
            .edge(first_edge)
            .saturating_sub(start)
            .min(u64::from(u32::MAX)) as u32
    });
    let last_edge_offset = (edge_count > 0).then(|| {
        index
            .edge(edge_end - 1)
            .saturating_sub(start)
            .min(u64::from(u32::MAX)) as u32
    });

    WaveformBin {
        x,
        first,
        last,
        has_high: first || edge_count > 0,
        has_low: !first || edge_count > 0,
        edges: edge_count.min(u32::MAX as usize) as u32,
        first_edge_offset,
        last_edge_offset,
    }
}

fn pack_digital_bins(bins: &[WaveformBin]) -> Vec<u8> {
    let mut packed = Vec::with_capacity(bins.len() * PACKED_DIGITAL_BIN_BYTES);
    for bin in bins {
        let flags = u32::from(bin.first)
            | (u32::from(bin.last) << 1)
            | (u32::from(bin.has_high) << 2)
            | (u32::from(bin.has_low) << 3);
        packed.extend_from_slice(&flags.to_le_bytes());
        packed.extend_from_slice(&bin.edges.to_le_bytes());
        packed.extend_from_slice(&bin.first_edge_offset.unwrap_or(u32::MAX).to_le_bytes());
        packed.extend_from_slice(&bin.last_edge_offset.unwrap_or(u32::MAX).to_le_bytes());
    }
    packed
}

#[cfg(test)]
fn unpack_digital_bins(packed: &[u8]) -> Vec<WaveformBin> {
    packed
        .chunks_exact(PACKED_DIGITAL_BIN_BYTES)
        .enumerate()
        .map(|(x, chunk)| {
            let flags = u32::from_le_bytes(chunk[0..4].try_into().expect("flags"));
            let edges = u32::from_le_bytes(chunk[4..8].try_into().expect("edges"));
            let first = u32::from_le_bytes(chunk[8..12].try_into().expect("first edge"));
            let last = u32::from_le_bytes(chunk[12..16].try_into().expect("last edge"));
            WaveformBin {
                x: x as u32,
                first: flags & 1 != 0,
                last: flags & 2 != 0,
                has_high: flags & 4 != 0,
                has_low: flags & 8 != 0,
                edges,
                first_edge_offset: (first != u32::MAX).then_some(first),
                last_edge_offset: (last != u32::MAX).then_some(last),
            }
        })
        .collect()
}

fn exact_channel_data(
    index: &DigitalChannelIndex,
    start: u64,
    end: u64,
) -> (Vec<DigitalSegment>, Vec<u64>, Vec<u64>) {
    let first_edge = index.first_edge_after(start);
    let edge_end = index.first_edge_at_or_after(end);
    let mut segments = Vec::with_capacity(edge_end.saturating_sub(first_edge) + 1);
    let mut rising = Vec::new();
    let mut falling = Vec::new();
    let mut run_start = start;
    let mut high = index.level_at(start);

    for edge_index in first_edge..edge_end {
        let edge = index.edge(edge_index);
        segments.push(DigitalSegment {
            start_sample: run_start,
            end_sample: edge,
            high,
        });
        high = index.level_after_edge(edge_index);
        if high {
            rising.push(edge);
        } else {
            falling.push(edge);
        }
        run_start = edge;
    }
    segments.push(DigitalSegment {
        start_sample: run_start,
        end_sample: end,
        high,
    });
    (segments, rising, falling)
}

fn sampled_channel_edges(
    index: &DigitalChannelIndex,
    start: u64,
    end: u64,
) -> (Vec<u64>, Vec<u64>) {
    let begin = index.first_edge_after(start);
    let finish = index.first_edge_at_or_after(end);
    let count = finish.saturating_sub(begin);
    if count == 0 {
        return (Vec::new(), Vec::new());
    }
    let stride = count.div_ceil(MAX_COARSE_EDGE_MARKERS).max(1);
    let mut rising = Vec::with_capacity(count.min(MAX_COARSE_EDGE_MARKERS));
    let mut falling = Vec::with_capacity(count.min(MAX_COARSE_EDGE_MARKERS));
    let mut edge_index = begin;
    while edge_index < finish {
        let edge = index.edge(edge_index);
        if index.level_after_edge(edge_index) {
            rising.push(edge);
        } else {
            falling.push(edge);
        }
        edge_index = edge_index.saturating_add(stride);
    }
    (rising, falling)
}

#[derive(Debug, Clone)]
struct BubbleAccumulator {
    bubble: AnalyzerBubble,
    last_frame_end_sample: u64,
    last_frame_width_px: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct AnalyzerTrackFrameIndex {
    frame_index: usize,
    value_index: usize,
}

fn render_analyzer_track(
    frames: &[DecodedFrame],
    track: &AnalyzerTrackRequest,
    waveform: &WaveformRequest,
) -> AnalyzerTrackWindow {
    let start = waveform.start_sample;
    let end = start.saturating_add(waveform.sample_count);
    let begin = lower_bound_frame_end(frames, start);
    let finish = upper_bound_frame_start(frames, end, begin);
    let visible_count = finish.saturating_sub(begin);

    let bubbles = build_pixel_bubbles(
        frames,
        track,
        begin,
        finish,
        waveform.sample_count,
        waveform.pixels,
    );
    let frame_refs = (begin..finish)
        .filter_map(|index| frame_ref_for_track(&frames[index], track))
        .take(MAX_ANALYZER_MARKER_RESULTS)
        .collect::<Vec<_>>();
    let previous_frame_ref = (0..begin)
        .rev()
        .find_map(|index| frame_ref_for_track(&frames[index], track));
    let next_start = if visible_count > MAX_ANALYZER_MARKER_RESULTS {
        begin
            .saturating_add(MAX_ANALYZER_MARKER_RESULTS)
            .min(frames.len())
    } else {
        finish
    };
    let next_frame_ref =
        (next_start..frames.len()).find_map(|index| frame_ref_for_track(&frames[index], track));
    let protocol_markers = protocol_markers_for_track(frames, track, begin, finish);

    AnalyzerTrackWindow {
        channel: track.channel,
        role: track.role.clone(),
        bubbles,
        protocol_markers,
        frame_refs,
        previous_frame_ref,
        next_frame_ref,
        frames: Vec::new(),
        previous_frame: None,
        next_frame: None,
    }
}

fn render_indexed_analyzer_track(
    frames: &[DecodedFrame],
    frame_indices: &[AnalyzerTrackFrameIndex],
    protocol_markers: Vec<AnalyzerProtocolMarker>,
    track: &AnalyzerTrackRequest,
    waveform: &WaveformRequest,
) -> AnalyzerTrackWindow {
    let start = waveform.start_sample;
    let end = start.saturating_add(waveform.sample_count);
    let begin = lower_bound_track_frame_end(frames, frame_indices, start);
    let finish = upper_bound_track_frame_start(frames, frame_indices, end, begin);
    let visible_count = finish.saturating_sub(begin);

    let bubbles = build_pixel_bubbles_from_indices(
        frames,
        frame_indices,
        track,
        begin,
        finish,
        waveform.sample_count,
        waveform.pixels,
    );
    let frame_refs = frame_indices[begin..finish]
        .iter()
        .map(|index| frame_ref_for_indexed_track(frames, *index))
        .take(MAX_ANALYZER_MARKER_RESULTS)
        .collect::<Vec<_>>();
    let previous_frame_ref = begin
        .checked_sub(1)
        .and_then(|index| frame_indices.get(index))
        .map(|index| frame_ref_for_indexed_track(frames, *index));
    let next_start = if visible_count > MAX_ANALYZER_MARKER_RESULTS {
        begin
            .saturating_add(MAX_ANALYZER_MARKER_RESULTS)
            .min(frame_indices.len())
    } else {
        finish
    };
    let next_frame_ref = frame_indices
        .get(next_start)
        .map(|index| frame_ref_for_indexed_track(frames, *index));

    AnalyzerTrackWindow {
        channel: track.channel,
        role: track.role.clone(),
        bubbles,
        protocol_markers,
        frame_refs,
        previous_frame_ref,
        next_frame_ref,
        frames: Vec::new(),
        previous_frame: None,
        next_frame: None,
    }
}

/// Bubble aggregation with its own timing.
///
/// `render_analyzer` already times `bubble_aggregation`, but the multi-analyzer
/// Saleae path never goes through it — it aggregates at several separate points
/// here instead, so without this the aggregation cost of the path that real
/// captures actually take is invisible. The stage name is deliberately the same
/// as `render_analyzer`'s so both paths sum into one figure.
fn render_analyzer_tracks_timed(
    frames: &[DecodedFrame],
    tracks: &[AnalyzerTrackRequest],
    waveform: &WaveformRequest,
    analyzer_id: &str,
    source: &str,
) -> Result<Vec<AnalyzerTrackWindow>> {
    let started = Instant::now();
    let rendered = render_analyzer_tracks(frames, tracks, waveform)?;
    trace_graph_timing(
        "bubble_aggregation",
        started,
        &format!(
            "analyzer={} tracks={} frames={} source={}",
            analyzer_id,
            rendered.len(),
            frames.len(),
            source
        ),
    );
    Ok(rendered)
}

fn render_analyzer_tracks(
    frames: &[DecodedFrame],
    tracks: &[AnalyzerTrackRequest],
    waveform: &WaveformRequest,
) -> Result<Vec<AnalyzerTrackWindow>> {
    if tracks.len() <= 1 {
        return Ok(tracks
            .iter()
            .map(|track| render_analyzer_track(frames, track, waveform))
            .collect());
    }

    let start = waveform.start_sample;
    let end = start.saturating_add(waveform.sample_count);
    let frame_begin = lower_bound_frame_end(frames, start);
    let frame_finish = upper_bound_frame_start(frames, end, frame_begin);
    let track_analysis =
        analyzer_track_window_analysis_for_window(frames, tracks, frame_begin, frame_finish);
    let worker_count = std::thread::available_parallelism()
        .map(usize::from)
        .unwrap_or(2)
        .min(MAX_PARALLEL_ANALYZER_TRACK_RENDERS)
        .min(tracks.len());
    if worker_count <= 1 {
        return Ok(tracks
            .iter()
            .zip(track_analysis.frame_indices)
            .zip(track_analysis.protocol_markers)
            .map(|((track, frame_indices), protocol_markers)| {
                render_indexed_analyzer_track(
                    frames,
                    &frame_indices,
                    protocol_markers,
                    track,
                    waveform,
                )
            })
            .collect());
    }

    let indexed_inputs = tracks
        .iter()
        .enumerate()
        .zip(track_analysis.frame_indices)
        .zip(track_analysis.protocol_markers)
        .map(
            |(((track_index, track), frame_indices), protocol_markers)| {
                (track_index, track, frame_indices, protocol_markers)
            },
        )
        .collect::<Vec<_>>();
    let chunk_size = indexed_inputs.len().div_ceil(worker_count);
    let worker_outputs = indexed_inputs
        .into_par_iter()
        .chunks(chunk_size)
        .map(|chunk| {
            chunk
                .into_iter()
                .map(|(track_index, track, frame_indices, protocol_markers)| {
                    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        (
                            track_index,
                            render_indexed_analyzer_track(
                                frames,
                                &frame_indices,
                                protocol_markers,
                                track,
                                waveform,
                            ),
                        )
                    }))
                    .map_err(|_| {
                        GraphError::DecoderBackend("analyzer track worker panicked".to_string())
                    })
                })
                .collect::<Vec<_>>()
        })
        .flatten()
        .collect::<Vec<_>>();

    let mut indexed_results: Vec<(usize, AnalyzerTrackWindow)> = Vec::with_capacity(tracks.len());
    for output in worker_outputs {
        indexed_results.push(output?);
    }
    indexed_results.sort_by_key(|(index, _)| *index);
    Ok(indexed_results
        .into_iter()
        .map(|(_, result)| result)
        .collect())
}

fn analyzer_frame_table_source_from_frames(
    request: &AnalyzerFrameTableRequest,
    frames: Arc<Vec<DecodedFrame>>,
    roles: Arc<Vec<String>>,
    cached_entry: Option<&AnalyzerCacheEntry>,
    query: Option<&str>,
) -> Option<AnalyzerFrameTableSource> {
    if frames.is_empty() {
        return None;
    }
    let analyzer_name_search = analyzer_frame_table_analyzer_name_search(request);
    let search_matches = query
        .map(str::trim)
        .filter(|query| !query.is_empty())
        .and_then(|query| {
            let normalized_query = query.to_lowercase();
            cached_entry.map(|entry| {
                analyzer_search_matches_for_entry(
                    entry,
                    &request.display_radix,
                    &analyzer_name_search,
                    &normalized_query,
                )
            })
        });

    Some(AnalyzerFrameTableSource {
        analyzer_id: request.analyzer_id.clone(),
        analyzer_name_search,
        display_radix: request.display_radix.clone(),
        frames,
        roles,
        search_texts: None,
        search_matches,
    })
}

fn analyzer_frame_table_analyzer_name_search(request: &AnalyzerFrameTableRequest) -> String {
    let analyzer_name = if request.analyzer_name.trim().is_empty() {
        request.analyzer_id.clone()
    } else {
        request.analyzer_name.clone()
    };
    analyzer_name.to_lowercase()
}

fn analyzer_frame_table_window_from_sources(
    sources: &[AnalyzerFrameTableSource],
    start: usize,
    end: usize,
) -> AnalyzerFrameTableWindow {
    let row_count = sources
        .iter()
        .map(|source| source.frames.len())
        .sum::<usize>();
    let roles = analyzer_frame_table_roles(sources);
    let start = start.min(row_count);
    let end = end.min(row_count).max(start);
    if start >= end || sources.is_empty() {
        return AnalyzerFrameTableWindow {
            roles,
            row_count,
            rows: Vec::new(),
        };
    }

    if sources.len() == 1 {
        let source = &sources[0];
        return AnalyzerFrameTableWindow {
            roles,
            row_count,
            rows: source.frames[start..end]
                .iter()
                .enumerate()
                .map(|(offset, frame)| analyzer_frame_table_row(source, start + offset, frame))
                .collect(),
        };
    }

    let Some(start_sample) = analyzer_frame_start_sample_at_rank(sources, start) else {
        return AnalyzerFrameTableWindow {
            roles,
            row_count,
            rows: Vec::new(),
        };
    };
    let mut positions = vec![0usize; sources.len()];
    let mut rows_before_start_sample = 0usize;
    for (source_index, source) in sources.iter().enumerate() {
        let lower = lower_bound_frame_start(&source.frames, start_sample);
        positions[source_index] = lower;
        rows_before_start_sample = rows_before_start_sample.saturating_add(lower);
    }

    let mut tied_rows_to_skip = start.saturating_sub(rows_before_start_sample);
    for (source_index, source) in sources.iter().enumerate() {
        if tied_rows_to_skip == 0 {
            break;
        }
        let upper = upper_bound_frame_start(&source.frames, start_sample, positions[source_index]);
        let skip = tied_rows_to_skip.min(upper.saturating_sub(positions[source_index]));
        positions[source_index] += skip;
        tied_rows_to_skip -= skip;
    }

    let mut rows = Vec::with_capacity(end - start);
    while rows.len() < end - start {
        let Some(source_index) = next_analyzer_table_source_index(sources, &positions) else {
            break;
        };
        let frame_position = positions[source_index];
        let frame = &sources[source_index].frames[frame_position];
        rows.push(analyzer_frame_table_row(
            &sources[source_index],
            frame_position,
            frame,
        ));
        positions[source_index] += 1;
    }

    AnalyzerFrameTableWindow {
        roles,
        row_count,
        rows,
    }
}

fn analyzer_frame_table_search_window_from_sources(
    sources: &[AnalyzerFrameTableSource],
    query: &str,
    start: usize,
    end: usize,
) -> AnalyzerFrameTableWindow {
    let roles = analyzer_frame_table_roles(sources);
    let normalized_query = query.trim().to_lowercase();
    if normalized_query.is_empty() {
        return analyzer_frame_table_window_from_sources(sources, start, end);
    }

    let match_sources = sources
        .iter()
        .filter_map(|source| {
            let matches = analyzer_frame_table_search_matches(source, &normalized_query);
            (!matches.is_empty()).then_some(AnalyzerFrameTableMatchSource { source, matches })
        })
        .collect::<Vec<_>>();
    let row_count = match_sources
        .iter()
        .map(|source| source.matches.len())
        .sum::<usize>();
    let start = start.min(row_count);
    let end = end.min(row_count).max(start);
    if start >= end || match_sources.is_empty() {
        return AnalyzerFrameTableWindow {
            roles,
            row_count,
            rows: Vec::new(),
        };
    }

    if match_sources.len() == 1 {
        let source = &match_sources[0];
        return AnalyzerFrameTableWindow {
            roles,
            row_count,
            rows: source.matches[start..end]
                .iter()
                .map(|frame_position| {
                    analyzer_frame_table_row(
                        source.source,
                        *frame_position,
                        &source.source.frames[*frame_position],
                    )
                })
                .collect(),
        };
    }

    let Some(start_sample) = analyzer_match_frame_start_sample_at_rank(&match_sources, start)
    else {
        return AnalyzerFrameTableWindow {
            roles,
            row_count,
            rows: Vec::new(),
        };
    };
    let mut positions = vec![0usize; match_sources.len()];
    let mut rows_before_start_sample = 0usize;
    for (source_index, source) in match_sources.iter().enumerate() {
        let lower = lower_bound_match_frame_start(source, start_sample);
        positions[source_index] = lower;
        rows_before_start_sample = rows_before_start_sample.saturating_add(lower);
    }

    let mut tied_rows_to_skip = start.saturating_sub(rows_before_start_sample);
    for (source_index, source) in match_sources.iter().enumerate() {
        if tied_rows_to_skip == 0 {
            break;
        }
        let upper = upper_bound_match_frame_start(source, start_sample, positions[source_index]);
        let skip = tied_rows_to_skip.min(upper.saturating_sub(positions[source_index]));
        positions[source_index] += skip;
        tied_rows_to_skip -= skip;
    }

    let mut rows = Vec::with_capacity(end - start);
    while rows.len() < end - start {
        let Some(source_index) = next_analyzer_table_match_source_index(&match_sources, &positions)
        else {
            break;
        };
        let source = &match_sources[source_index];
        let match_position = positions[source_index];
        let frame_position = source.matches[match_position];
        rows.push(analyzer_frame_table_row(
            source.source,
            frame_position,
            &source.source.frames[frame_position],
        ));
        positions[source_index] += 1;
    }

    AnalyzerFrameTableWindow {
        roles,
        row_count,
        rows,
    }
}

struct AnalyzerFrameTableMatchSource<'a> {
    source: &'a AnalyzerFrameTableSource,
    matches: Arc<Vec<usize>>,
}

fn analyzer_frame_table_roles(sources: &[AnalyzerFrameTableSource]) -> Vec<String> {
    let mut roles = Vec::new();
    let mut seen = HashSet::new();
    for source in sources {
        for role in source.roles.iter() {
            if seen.insert(role.clone()) {
                roles.push(role.clone());
            }
        }
    }
    roles
}

fn analyzer_frame_roles(frames: &[DecodedFrame]) -> Vec<String> {
    let mut roles = Vec::new();
    let mut seen = HashSet::new();
    for frame in frames {
        for value in &frame.channel_values {
            if seen.insert(value.role.clone()) {
                roles.push(value.role.clone());
            }
        }
    }
    roles
}

fn analyzer_search_texts_for_entry(
    entry: &AnalyzerCacheEntry,
    display_radix: &str,
) -> Arc<Vec<String>> {
    let cache_key = normalize_analyzer_display_radix(display_radix).to_string();
    if let Some(cached) = entry.table_search_texts.lock().get(&cache_key).cloned() {
        return cached;
    }

    let built = Arc::new(analyzer_frame_search_texts(&entry.frames, display_radix));
    let mut cache = entry.table_search_texts.lock();
    if let Some(cached) = cache.get(&cache_key).cloned() {
        return cached;
    }
    cache.insert(cache_key, built.clone());
    built
}

fn analyzer_search_matches_for_entry(
    entry: &AnalyzerCacheEntry,
    display_radix: &str,
    analyzer_name_search: &str,
    normalized_query: &str,
) -> Arc<Vec<usize>> {
    let cache_key =
        analyzer_search_matches_cache_key(display_radix, analyzer_name_search, normalized_query);
    if let Some(cached) = entry.table_search_matches.lock().get(&cache_key).cloned() {
        return cached;
    }

    let built = if analyzer_name_search.contains(normalized_query) {
        Arc::new((0..entry.frames.len()).collect())
    } else {
        let search_texts = analyzer_search_texts_for_entry(entry, display_radix);
        Arc::new(analyzer_frame_search_matches(
            &entry.frames,
            &search_texts,
            analyzer_name_search,
            display_radix,
            normalized_query,
        ))
    };
    let mut cache = entry.table_search_matches.lock();
    if let Some(cached) = cache.get(&cache_key).cloned() {
        return cached;
    }
    cache.insert(cache_key, built.clone());
    built
}

fn analyzer_search_matches_cache_key(
    display_radix: &str,
    analyzer_name_search: &str,
    normalized_query: &str,
) -> String {
    format!(
        "{}\u{1f}{}\u{1f}{}",
        normalize_analyzer_display_radix(display_radix),
        analyzer_name_search,
        normalized_query
    )
}

fn analyzer_frame_search_texts(frames: &[DecodedFrame], display_radix: &str) -> Vec<String> {
    frames
        .iter()
        .map(|frame| analyzer_frame_search_text(frame, display_radix))
        .collect()
}

fn analyzer_frame_search_matches(
    frames: &[DecodedFrame],
    search_texts: &[String],
    analyzer_name_search: &str,
    display_radix: &str,
    normalized_query: &str,
) -> Vec<usize> {
    let mut matches = Vec::new();
    for (frame_position, frame) in frames.iter().enumerate() {
        if analyzer_frame_matches_search(
            analyzer_name_search,
            display_radix,
            search_texts.get(frame_position).map(String::as_str),
            frame_position,
            frame,
            normalized_query,
        ) {
            matches.push(frame_position);
        }
    }
    matches
}

fn analyzer_frame_search_text(frame: &DecodedFrame, display_radix: &str) -> String {
    let mut text = format!(
        "{} {}",
        frame.frame_type,
        format_analyzer_text_for_table(&frame.label, display_radix, Some(frame.value)),
    );
    for value in &frame.channel_values {
        text.push(' ');
        text.push_str(&value.role);
        text.push(' ');
        text.push_str(&format_analyzer_text_for_table(
            &value.label,
            display_radix,
            Some(value.value),
        ));
    }
    text.to_lowercase()
}

fn analyzer_frame_start_sample_at_rank(
    sources: &[AnalyzerFrameTableSource],
    rank: usize,
) -> Option<u64> {
    let mut low = u64::MAX;
    let mut high = 0u64;
    let mut has_frames = false;
    for source in sources {
        let (Some(first), Some(last)) = (source.frames.first(), source.frames.last()) else {
            continue;
        };
        low = low.min(first.start_sample);
        high = high.max(last.start_sample);
        has_frames = true;
    }
    if !has_frames {
        return None;
    }

    let mut left = low;
    let mut right = high;
    while left < right {
        let mid = left + (right - left) / 2;
        if analyzer_frame_count_at_or_before_sample(sources, mid) > rank {
            right = mid;
        } else {
            left = mid + 1;
        }
    }
    Some(left)
}

fn analyzer_frame_count_at_or_before_sample(
    sources: &[AnalyzerFrameTableSource],
    sample: u64,
) -> usize {
    sources.iter().fold(0usize, |count, source| {
        count.saturating_add(upper_bound_frame_start(&source.frames, sample, 0))
    })
}

fn analyzer_frame_table_search_matches(
    source: &AnalyzerFrameTableSource,
    normalized_query: &str,
) -> Arc<Vec<usize>> {
    if let Some(matches) = &source.search_matches {
        return matches.clone();
    }
    Arc::new(analyzer_frame_search_matches(
        &source.frames,
        source.search_texts.as_deref().map_or(&[], Vec::as_slice),
        &source.analyzer_name_search,
        &source.display_radix,
        normalized_query,
    ))
}

fn analyzer_match_frame_start_sample_at_rank(
    sources: &[AnalyzerFrameTableMatchSource<'_>],
    rank: usize,
) -> Option<u64> {
    let mut low = u64::MAX;
    let mut high = 0u64;
    let mut has_frames = false;
    for source in sources {
        let Some(first_position) = source.matches.first() else {
            continue;
        };
        let Some(last_position) = source.matches.last() else {
            continue;
        };
        low = low.min(source.source.frames[*first_position].start_sample);
        high = high.max(source.source.frames[*last_position].start_sample);
        has_frames = true;
    }
    if !has_frames {
        return None;
    }

    let mut left = low;
    let mut right = high;
    while left < right {
        let mid = left + (right - left) / 2;
        if analyzer_match_frame_count_at_or_before_sample(sources, mid) > rank {
            right = mid;
        } else {
            left = mid + 1;
        }
    }
    Some(left)
}

fn analyzer_match_frame_count_at_or_before_sample(
    sources: &[AnalyzerFrameTableMatchSource<'_>],
    sample: u64,
) -> usize {
    sources.iter().fold(0usize, |count, source| {
        count.saturating_add(upper_bound_match_frame_start(source, sample, 0))
    })
}

fn analyzer_frame_matches_search(
    analyzer_name_search: &str,
    display_radix: &str,
    search_text: Option<&str>,
    frame_position: usize,
    frame: &DecodedFrame,
    normalized_query: &str,
) -> bool {
    if analyzer_name_search.contains(normalized_query) {
        return true;
    }
    let frame_number = (frame_position + 1).to_string();
    if frame_number.contains(normalized_query) {
        return true;
    }
    let fallback_body;
    let body = if let Some(text) = search_text {
        text
    } else {
        fallback_body = analyzer_frame_search_text(frame, display_radix);
        fallback_body.as_str()
    };
    if body.contains(normalized_query) {
        return true;
    }
    if !normalized_query.contains(char::is_whitespace) {
        return false;
    }
    format!("{} {} {}", analyzer_name_search, frame_number, body).contains(normalized_query)
}

fn format_analyzer_text_for_table(
    text: &str,
    display_radix: &str,
    fallback_value: Option<u64>,
) -> String {
    let source = text;
    let mut replaced = false;
    let mut output = String::with_capacity(source.len());
    let mut index = 0usize;
    while index < source.len() {
        let remaining = &source[index..];
        if let Some((token_len, value, bits)) = parse_analyzer_numeric_token(remaining) {
            replaced = true;
            output.push_str(&format_analyzer_value_for_table(value, display_radix, bits));
            index += token_len;
            continue;
        }
        let Some(ch) = remaining.chars().next() else {
            break;
        };
        output.push(ch);
        index += ch.len_utf8();
    }
    if replaced {
        return output;
    }

    let trimmed = source.trim();
    if !trimmed.is_empty() && trimmed.bytes().all(|byte| byte.is_ascii_digit()) {
        if let Ok(value) = trimmed.parse::<u64>() {
            return source.replacen(
                trimmed,
                &format_analyzer_value_for_table(
                    value,
                    display_radix,
                    bits_for_analyzer_value(value),
                ),
                1,
            );
        }
    }

    if source.is_empty() {
        if let Some(value) = fallback_value {
            return format_analyzer_value_for_table(
                value,
                display_radix,
                bits_for_analyzer_value(value),
            );
        }
    }
    source.to_string()
}

fn parse_analyzer_numeric_token(source: &str) -> Option<(usize, u64, u32)> {
    let bytes = source.as_bytes();
    if bytes.len() >= 3 && bytes[0] == b'0' && bytes[1].eq_ignore_ascii_case(&b'x') {
        let digits_len = source[2..]
            .bytes()
            .take_while(|byte| byte.is_ascii_hexdigit())
            .count();
        if digits_len == 0 {
            return None;
        }
        let token_len = 2 + digits_len;
        let value = u64::from_str_radix(&source[2..token_len], 16).ok()?;
        return Some((token_len, value, (digits_len as u32 * 4).max(8)));
    }
    if bytes.len() >= 3 && bytes[0] == b'0' && bytes[1].eq_ignore_ascii_case(&b'b') {
        let digits_len = source[2..]
            .bytes()
            .take_while(|byte| *byte == b'0' || *byte == b'1')
            .count();
        if digits_len == 0 {
            return None;
        }
        let token_len = 2 + digits_len;
        let value = u64::from_str_radix(&source[2..token_len], 2).ok()?;
        return Some((token_len, value, (digits_len as u32).max(1)));
    }
    None
}

fn format_analyzer_value_for_table(value: u64, display_radix: &str, bits: u32) -> String {
    match normalize_analyzer_display_radix(display_radix) {
        "Decimal" => value.to_string(),
        "Binary" => format!("0b{:0width$b}", value, width = bits.max(1) as usize),
        "Ascii" => format_analyzer_ascii_value(value),
        _ => {
            let digits = bits.div_ceil(4).max(1) as usize;
            format!("0x{:0width$X}", value, width = digits)
        }
    }
}

fn normalize_analyzer_display_radix(display_radix: &str) -> &'static str {
    match display_radix {
        "Binary" => "Binary",
        "Decimal" => "Decimal",
        "Ascii" => "Ascii",
        _ => "Hexadecimal",
    }
}

fn bits_for_analyzer_value(value: u64) -> u32 {
    if value <= 0xff {
        return 8;
    }
    u64::BITS - value.leading_zeros()
}

fn format_analyzer_ascii_value(value: u64) -> String {
    let byte = (value & 0xff) as u8;
    let escaped = match byte {
        b'\t' => Some("\\t".to_string()),
        b'\n' => Some("\\n".to_string()),
        b'\r' => Some("\\r".to_string()),
        b'\'' => Some("\\'".to_string()),
        b'\\' => Some("\\\\".to_string()),
        0x20..=0x7e => Some((byte as char).to_string()),
        _ => None,
    };
    escaped.map_or_else(
        || format_analyzer_value_for_table(value, "Hexadecimal", bits_for_analyzer_value(value)),
        |value| format!("'{value}'"),
    )
}

fn next_analyzer_table_source_index(
    sources: &[AnalyzerFrameTableSource],
    positions: &[usize],
) -> Option<usize> {
    let mut best_source_index = None;
    let mut best_frame: Option<&DecodedFrame> = None;
    for (source_index, source) in sources.iter().enumerate() {
        let Some(frame) = source.frames.get(positions[source_index]) else {
            continue;
        };
        if best_frame.is_none_or(|candidate| {
            frame.start_sample < candidate.start_sample
                || (frame.start_sample == candidate.start_sample
                    && source_index < best_source_index.unwrap_or(usize::MAX))
        }) {
            best_source_index = Some(source_index);
            best_frame = Some(frame);
        }
    }
    best_source_index
}

fn next_analyzer_table_match_source_index(
    sources: &[AnalyzerFrameTableMatchSource<'_>],
    positions: &[usize],
) -> Option<usize> {
    let mut best_source_index = None;
    let mut best_frame: Option<&DecodedFrame> = None;
    for (source_index, source) in sources.iter().enumerate() {
        let Some(frame_position) = source.matches.get(positions[source_index]) else {
            continue;
        };
        let frame = &source.source.frames[*frame_position];
        if best_frame.is_none_or(|candidate| {
            frame.start_sample < candidate.start_sample
                || (frame.start_sample == candidate.start_sample
                    && source_index < best_source_index.unwrap_or(usize::MAX))
        }) {
            best_source_index = Some(source_index);
            best_frame = Some(frame);
        }
    }
    best_source_index
}

fn analyzer_frame_table_row(
    source: &AnalyzerFrameTableSource,
    frame_position: usize,
    frame: &DecodedFrame,
) -> AnalyzerFrameTableRow {
    AnalyzerFrameTableRow {
        analyzer_id: source.analyzer_id.clone(),
        frame: frame.clone(),
        frame_index: frame.frame_id,
        frame_number: frame_position + 1,
    }
}

fn protocol_markers_for_track(
    frames: &[DecodedFrame],
    track: &AnalyzerTrackRequest,
    begin: usize,
    end: usize,
) -> Vec<AnalyzerProtocolMarker> {
    let scan = scan_protocol_markers_for_track(frames, track, begin, end);
    if scan.marker_count > 0 && scan.ordered {
        return scan.collected.unwrap_or_else(|| {
            collect_ordered_limited_protocol_markers_for_track(
                frames,
                track,
                begin,
                end,
                scan.marker_count,
            )
        });
    }

    let mut markers = scan.collected.unwrap_or_else(|| {
        let mut markers = Vec::new();
        visit_protocol_markers_for_track(frames, track, begin, end, |marker| markers.push(marker));
        markers
    });
    if markers.is_empty() && track.role.eq_ignore_ascii_case("sda") {
        append_sda_fallback_markers(frames, begin, end, &mut markers);
    }
    normalize_analyzer_protocol_markers(&mut markers);
    limit_analyzer_protocol_markers(markers)
}

fn append_sda_fallback_markers(
    frames: &[DecodedFrame],
    begin: usize,
    end: usize,
    markers: &mut Vec<AnalyzerProtocolMarker>,
) {
    for frame in &frames[begin..end] {
        let kind = if frame.frame_type.eq_ignore_ascii_case("start") {
            AnalyzerProtocolMarkerKind::Start
        } else if frame.frame_type.eq_ignore_ascii_case("stop") {
            AnalyzerProtocolMarkerKind::Stop
        } else {
            continue;
        };
        markers.push(AnalyzerProtocolMarker {
            sample: frame.start_sample,
            kind,
        });
    }
}

struct ProtocolMarkerScan {
    marker_count: usize,
    ordered: bool,
    collected: Option<Vec<AnalyzerProtocolMarker>>,
}

fn scan_protocol_markers_for_track(
    frames: &[DecodedFrame],
    track: &AnalyzerTrackRequest,
    begin: usize,
    end: usize,
) -> ProtocolMarkerScan {
    let mut marker_count = 0usize;
    let mut ordered = true;
    let mut previous: Option<AnalyzerProtocolMarker> = None;
    let mut collected = Some(Vec::new());
    visit_protocol_markers_for_track(frames, track, begin, end, |marker| {
        if let Some(previous_marker) = previous {
            if marker.sample < previous_marker.sample {
                ordered = false;
            }
            if marker == previous_marker {
                return;
            }
        }
        previous = Some(marker);
        marker_count = marker_count.saturating_add(1);
        if let Some(markers) = collected.as_mut() {
            if markers.len() < MAX_ANALYZER_MARKER_RESULTS {
                markers.push(marker);
            } else {
                collected = None;
            }
        }
    });
    ProtocolMarkerScan {
        marker_count,
        ordered,
        collected,
    }
}

fn visit_protocol_markers_for_track(
    frames: &[DecodedFrame],
    track: &AnalyzerTrackRequest,
    begin: usize,
    end: usize,
    mut visit: impl FnMut(AnalyzerProtocolMarker),
) {
    for frame in &frames[begin..end] {
        for marker in &frame.protocol_markers {
            if marker.channel != Some(track.channel) {
                continue;
            }
            let Some(kind) = analyzer_protocol_marker_kind(marker.kind.as_str()) else {
                continue;
            };
            visit(AnalyzerProtocolMarker {
                sample: marker.sample,
                kind,
            });
        }
    }
}

fn analyzer_protocol_marker_kind(kind: &str) -> Option<AnalyzerProtocolMarkerKind> {
    Some(match kind {
        "dot" => AnalyzerProtocolMarkerKind::Dot,
        "error_dot" => AnalyzerProtocolMarkerKind::ErrorDot,
        "square" => AnalyzerProtocolMarkerKind::Square,
        "error_square" => AnalyzerProtocolMarkerKind::ErrorSquare,
        "up_arrow" => AnalyzerProtocolMarkerKind::UpArrow,
        "down_arrow" => AnalyzerProtocolMarkerKind::DownArrow,
        "x" => AnalyzerProtocolMarkerKind::X,
        "error_x" => AnalyzerProtocolMarkerKind::ErrorX,
        "start" => AnalyzerProtocolMarkerKind::Start,
        "stop" => AnalyzerProtocolMarkerKind::Stop,
        "one" => AnalyzerProtocolMarkerKind::One,
        "zero" => AnalyzerProtocolMarkerKind::Zero,
        _ => return None,
    })
}

fn collect_ordered_limited_protocol_markers_for_track(
    frames: &[DecodedFrame],
    track: &AnalyzerTrackRequest,
    begin: usize,
    end: usize,
    marker_count: usize,
) -> Vec<AnalyzerProtocolMarker> {
    let target_count = marker_count.min(MAX_ANALYZER_MARKER_RESULTS);
    if target_count == 0 {
        return Vec::new();
    }
    let mut markers = Vec::with_capacity(target_count);
    let last = marker_count - 1;
    let mut next_output_index = 0usize;
    let mut next_target_index = 0usize;
    let mut unique_index = 0usize;
    let mut previous: Option<AnalyzerProtocolMarker> = None;
    visit_protocol_markers_for_track(frames, track, begin, end, |marker| {
        if previous == Some(marker) {
            return;
        }
        previous = Some(marker);
        if unique_index == next_target_index {
            markers.push(marker);
            next_output_index += 1;
            next_target_index = if next_output_index >= target_count {
                usize::MAX
            } else if target_count == 1 {
                0
            } else {
                next_output_index.saturating_mul(last) / (target_count - 1)
            };
        }
        unique_index += 1;
    });
    markers
}

fn normalize_analyzer_protocol_markers(markers: &mut Vec<AnalyzerProtocolMarker>) {
    if markers.len() <= 1 {
        return;
    }
    if !analyzer_protocol_markers_are_ordered(markers) {
        markers.sort_by_key(|marker| marker.sample);
    }
    markers.dedup();
}

fn analyzer_protocol_markers_are_ordered(markers: &[AnalyzerProtocolMarker]) -> bool {
    markers
        .windows(2)
        .all(|pair| pair[0].sample <= pair[1].sample)
}

fn limit_analyzer_protocol_markers(
    markers: Vec<AnalyzerProtocolMarker>,
) -> Vec<AnalyzerProtocolMarker> {
    if markers.len() <= MAX_ANALYZER_MARKER_RESULTS {
        return markers;
    }
    let last = markers.len() - 1;
    (0..MAX_ANALYZER_MARKER_RESULTS)
        .map(|index| markers[index * last / (MAX_ANALYZER_MARKER_RESULTS - 1)])
        .collect()
}

struct AnalyzerTrackWindowAnalysis {
    frame_indices: Vec<Vec<AnalyzerTrackFrameIndex>>,
    protocol_markers: Vec<Vec<AnalyzerProtocolMarker>>,
}

fn analyzer_track_window_analysis_for_window(
    frames: &[DecodedFrame],
    tracks: &[AnalyzerTrackRequest],
    begin: usize,
    end: usize,
) -> AnalyzerTrackWindowAnalysis {
    let mut requests_by_channel = vec![Vec::new(); MAX_CHANNELS as usize];
    let mut has_channel_requests = false;
    for (track_index, track) in tracks.iter().enumerate() {
        if let Some(requests) = requests_by_channel.get_mut(track.channel as usize) {
            has_channel_requests = true;
            requests.push(track_index);
        }
    }

    let mut indices = vec![Vec::new(); tracks.len()];
    let mut markers_by_track = vec![Vec::new(); tracks.len()];
    if tracks.is_empty() || !has_channel_requests {
        return AnalyzerTrackWindowAnalysis {
            frame_indices: indices,
            protocol_markers: markers_by_track,
        };
    }

    let begin = begin.min(frames.len());
    let end = end.min(frames.len()).max(begin);
    for frame_index in begin..end {
        append_frame_to_track_indices(
            frames,
            tracks,
            &requests_by_channel,
            &mut indices,
            frame_index,
        );
        append_protocol_markers_to_track_windows(
            frames,
            &requests_by_channel,
            &mut markers_by_track,
            frame_index,
        );
    }
    let previous_frame_indices =
        nearest_track_frame_indices_before(frames, tracks, &requests_by_channel, begin);
    let next_frame_indices =
        nearest_track_frame_indices_after(frames, tracks, &requests_by_channel, end);
    for (track_index, indices_for_track) in indices.iter_mut().enumerate() {
        if let Some(previous) = previous_frame_indices[track_index] {
            indices_for_track.insert(0, previous);
        }
        if let Some(next) = next_frame_indices[track_index] {
            indices_for_track.push(next);
        }
    }
    for (track_index, markers) in markers_by_track.iter_mut().enumerate() {
        if markers.is_empty() && tracks[track_index].role.eq_ignore_ascii_case("sda") {
            append_sda_fallback_markers(frames, begin, end, markers);
        }
        normalize_analyzer_protocol_markers(markers);
        *markers = limit_analyzer_protocol_markers(std::mem::take(markers));
    }

    AnalyzerTrackWindowAnalysis {
        frame_indices: indices,
        protocol_markers: markers_by_track,
    }
}

fn nearest_track_frame_indices_before(
    frames: &[DecodedFrame],
    tracks: &[AnalyzerTrackRequest],
    requests_by_channel: &[Vec<usize>],
    before: usize,
) -> Vec<Option<AnalyzerTrackFrameIndex>> {
    let mut nearest = vec![None; tracks.len()];
    let mut remaining = tracks.len();
    for frame_index in (0..before.min(frames.len())).rev() {
        visit_matching_track_indexes_for_frame(
            frames,
            tracks,
            requests_by_channel,
            frame_index,
            |track_index, value_index| {
                if nearest[track_index].is_none() {
                    nearest[track_index] = Some(AnalyzerTrackFrameIndex {
                        frame_index,
                        value_index,
                    });
                    remaining = remaining.saturating_sub(1);
                }
            },
        );
        if remaining == 0 {
            break;
        }
    }
    nearest
}

fn nearest_track_frame_indices_after(
    frames: &[DecodedFrame],
    tracks: &[AnalyzerTrackRequest],
    requests_by_channel: &[Vec<usize>],
    after: usize,
) -> Vec<Option<AnalyzerTrackFrameIndex>> {
    let mut nearest = vec![None; tracks.len()];
    let mut remaining = tracks.len();
    for frame_index in after.min(frames.len())..frames.len() {
        visit_matching_track_indexes_for_frame(
            frames,
            tracks,
            requests_by_channel,
            frame_index,
            |track_index, value_index| {
                if nearest[track_index].is_none() {
                    nearest[track_index] = Some(AnalyzerTrackFrameIndex {
                        frame_index,
                        value_index,
                    });
                    remaining = remaining.saturating_sub(1);
                }
            },
        );
        if remaining == 0 {
            break;
        }
    }
    nearest
}

fn append_frame_to_track_indices(
    frames: &[DecodedFrame],
    tracks: &[AnalyzerTrackRequest],
    requests_by_channel: &[Vec<usize>],
    indices: &mut [Vec<AnalyzerTrackFrameIndex>],
    frame_index: usize,
) {
    visit_matching_track_indexes_for_frame(
        frames,
        tracks,
        requests_by_channel,
        frame_index,
        |track_index, value_index| {
            indices[track_index].push(AnalyzerTrackFrameIndex {
                frame_index,
                value_index,
            });
        },
    );
}

fn append_protocol_markers_to_track_windows(
    frames: &[DecodedFrame],
    requests_by_channel: &[Vec<usize>],
    markers_by_track: &mut [Vec<AnalyzerProtocolMarker>],
    frame_index: usize,
) {
    let frame = &frames[frame_index];
    if frame.protocol_markers.is_empty() {
        return;
    }
    for marker in &frame.protocol_markers {
        let Some(channel) = marker.channel else {
            continue;
        };
        let Some(track_indexes) = requests_by_channel.get(channel as usize) else {
            continue;
        };
        let Some(kind) = analyzer_protocol_marker_kind(marker.kind.as_str()) else {
            continue;
        };
        let marker = AnalyzerProtocolMarker {
            sample: marker.sample,
            kind,
        };
        for track_index in track_indexes {
            markers_by_track[*track_index].push(marker);
        }
    }
}

fn visit_matching_track_indexes_for_frame(
    frames: &[DecodedFrame],
    tracks: &[AnalyzerTrackRequest],
    requests_by_channel: &[Vec<usize>],
    frame_index: usize,
    mut visit: impl FnMut(usize, usize),
) {
    let frame = &frames[frame_index];
    let mut present_channel_mask = 0u64;
    let mut present_channel_value_indexes = [usize::MAX; 64];
    let mut overflow_present_channel_values: Option<Vec<(u8, usize)>> = None;
    let mut exact_track_mask = 0u128;
    let mut overflow_exact_track_indexes: Option<Vec<usize>> = None;
    for (value_index, value) in frame.channel_values.iter().enumerate() {
        let Some(requests) = requests_by_channel.get(value.channel as usize) else {
            continue;
        };
        if value.channel < 64 {
            let bit = 1u64 << value.channel;
            if present_channel_mask & bit == 0 {
                present_channel_mask |= bit;
                present_channel_value_indexes[usize::from(value.channel)] = value_index;
            }
        } else if !overflow_present_channel_values
            .as_ref()
            .is_some_and(|entries| entries.iter().any(|(channel, _)| *channel == value.channel))
        {
            overflow_present_channel_values
                .get_or_insert_with(Vec::new)
                .push((value.channel, value_index));
        }
        for track_index in requests {
            if tracks[*track_index].role != value.role
                || !mark_track_index(
                    &mut exact_track_mask,
                    &mut overflow_exact_track_indexes,
                    *track_index,
                )
            {
                continue;
            }
            visit(*track_index, value_index);
        }
    }

    while present_channel_mask != 0 {
        let channel = present_channel_mask.trailing_zeros() as u8;
        present_channel_mask &= present_channel_mask - 1;
        let value_index = present_channel_value_indexes[usize::from(channel)];
        let Some(requests) = requests_by_channel.get(channel as usize) else {
            continue;
        };
        for track_index in requests {
            if track_index_marked(
                exact_track_mask,
                overflow_exact_track_indexes.as_deref(),
                *track_index,
            ) {
                continue;
            }
            visit(*track_index, value_index);
        }
    }
    for (channel, value_index) in overflow_present_channel_values.into_iter().flatten() {
        let Some(requests) = requests_by_channel.get(channel as usize) else {
            continue;
        };
        for track_index in requests {
            if track_index_marked(
                exact_track_mask,
                overflow_exact_track_indexes.as_deref(),
                *track_index,
            ) {
                continue;
            }
            visit(*track_index, value_index);
        }
    }
}

fn mark_track_index(
    mask: &mut u128,
    overflow: &mut Option<Vec<usize>>,
    track_index: usize,
) -> bool {
    if track_index < u128::BITS as usize {
        let bit = 1u128 << track_index;
        if *mask & bit != 0 {
            return false;
        }
        *mask |= bit;
        return true;
    }
    let overflow = overflow.get_or_insert_with(Vec::new);
    if overflow.contains(&track_index) {
        return false;
    }
    overflow.push(track_index);
    true
}

fn track_index_marked(mask: u128, overflow: Option<&[usize]>, track_index: usize) -> bool {
    if track_index < u128::BITS as usize {
        return mask & (1u128 << track_index) != 0;
    }
    overflow.is_some_and(|overflow| overflow.contains(&track_index))
}

fn build_pixel_bubbles(
    frames: &[DecodedFrame],
    track: &AnalyzerTrackRequest,
    begin: usize,
    end: usize,
    viewport_samples: u64,
    width_px: u32,
) -> Vec<AnalyzerBubble> {
    let safe_samples = viewport_samples.max(1) as f64;
    let width = width_px.max(1) as f64;
    let mut accumulators: Vec<BubbleAccumulator> = Vec::new();
    for frame in &frames[begin..end] {
        let Some(frame) = display_frame_for_track(frame, track) else {
            continue;
        };
        let frame_width_px =
            frame.end_sample.saturating_sub(frame.start_sample) as f64 / safe_samples * width;
        let should_merge = accumulators.last().is_some_and(|previous| {
            let gap_px = frame
                .start_sample
                .saturating_sub(previous.last_frame_end_sample) as f64
                / safe_samples
                * width;
            frame_width_px <= MAX_PIXEL_WIDTH_FOR_MERGEABLE_FRAME
                && previous.last_frame_width_px <= MAX_PIXEL_WIDTH_FOR_MERGEABLE_FRAME
                && gap_px <= MAX_PIXELS_BETWEEN_MERGEABLE_FRAMES
        });

        if should_merge {
            let previous = accumulators.last_mut().expect("checked above");
            previous.bubble.bubble_type = AnalyzerBubbleType::MultiBubble;
            previous.bubble.end_sample = previous.bubble.end_sample.max(frame.end_sample);
            previous.bubble.frame_id_interval.end = previous
                .bubble
                .frame_id_interval
                .end
                .max(frame.frame_id.saturating_add(1));
            previous.bubble.result_count = previous.bubble.result_count.saturating_add(1);
            if previous.bubble.display_text.len() < MAX_MULTI_BUBBLE_STRINGS {
                previous.bubble.display_text.push(frame.label.to_string());
            }
            previous.last_frame_end_sample = frame.end_sample;
            previous.last_frame_width_px = frame_width_px;
        } else {
            accumulators.push(BubbleAccumulator {
                bubble: AnalyzerBubble {
                    bubble_type: AnalyzerBubbleType::SingleBubble,
                    frame_id_interval: FrameIdInterval {
                        begin: frame.frame_id,
                        end: frame.frame_id.saturating_add(1),
                    },
                    start_sample: frame.start_sample,
                    end_sample: frame.end_sample,
                    display_text: if frame.texts.is_empty() {
                        vec![frame.label.to_string()]
                    } else {
                        frame.texts.to_vec()
                    },
                    result_count: 1,
                },
                last_frame_end_sample: frame.end_sample,
                last_frame_width_px: frame_width_px,
            });
        }
    }
    enforce_maximum_bubbles(
        accumulators.into_iter().map(|item| item.bubble).collect(),
        width_px,
    )
}

fn build_pixel_bubbles_from_indices(
    frames: &[DecodedFrame],
    frame_indices: &[AnalyzerTrackFrameIndex],
    _track: &AnalyzerTrackRequest,
    begin: usize,
    end: usize,
    viewport_samples: u64,
    width_px: u32,
) -> Vec<AnalyzerBubble> {
    let safe_samples = viewport_samples.max(1) as f64;
    let width = width_px.max(1) as f64;
    let mut accumulators: Vec<BubbleAccumulator> = Vec::new();
    for frame_index in &frame_indices[begin..end] {
        let Some(frame) = display_frame_for_indexed_track(frames, *frame_index) else {
            continue;
        };
        let frame_width_px =
            frame.end_sample.saturating_sub(frame.start_sample) as f64 / safe_samples * width;
        let should_merge = accumulators.last().is_some_and(|previous| {
            let gap_px = frame
                .start_sample
                .saturating_sub(previous.last_frame_end_sample) as f64
                / safe_samples
                * width;
            frame_width_px <= MAX_PIXEL_WIDTH_FOR_MERGEABLE_FRAME
                && previous.last_frame_width_px <= MAX_PIXEL_WIDTH_FOR_MERGEABLE_FRAME
                && gap_px <= MAX_PIXELS_BETWEEN_MERGEABLE_FRAMES
        });

        if should_merge {
            let previous = accumulators.last_mut().expect("checked above");
            previous.bubble.bubble_type = AnalyzerBubbleType::MultiBubble;
            previous.bubble.end_sample = previous.bubble.end_sample.max(frame.end_sample);
            previous.bubble.frame_id_interval.end = previous
                .bubble
                .frame_id_interval
                .end
                .max(frame.frame_id.saturating_add(1));
            previous.bubble.result_count = previous.bubble.result_count.saturating_add(1);
            if previous.bubble.display_text.len() < MAX_MULTI_BUBBLE_STRINGS {
                previous.bubble.display_text.push(frame.label.to_string());
            }
            previous.last_frame_end_sample = frame.end_sample;
            previous.last_frame_width_px = frame_width_px;
        } else {
            accumulators.push(BubbleAccumulator {
                bubble: analyzer_bubble_for_display_frame(frame),
                last_frame_end_sample: frame.end_sample,
                last_frame_width_px: frame_width_px,
            });
        }
    }
    enforce_maximum_bubbles(
        accumulators.into_iter().map(|item| item.bubble).collect(),
        width_px,
    )
}

fn analyzer_bubble_for_display_frame(frame: DisplayFrame<'_>) -> AnalyzerBubble {
    AnalyzerBubble {
        bubble_type: AnalyzerBubbleType::SingleBubble,
        frame_id_interval: FrameIdInterval {
            begin: frame.frame_id,
            end: frame.frame_id.saturating_add(1),
        },
        start_sample: frame.start_sample,
        end_sample: frame.end_sample,
        display_text: if frame.texts.is_empty() {
            vec![frame.label.to_string()]
        } else {
            frame.texts.to_vec()
        },
        result_count: 1,
    }
}

fn enforce_maximum_bubbles(bubbles: Vec<AnalyzerBubble>, width_px: u32) -> Vec<AnalyzerBubble> {
    let maximum_results = (width_px as usize)
        .max(MAX_ANALYZER_MARKER_RESULTS)
        .min(MAX_ANALYZER_BUBBLE_RESULTS);
    if bubbles.len() <= maximum_results {
        return bubbles;
    }
    let bucket_size = bubbles.len().div_ceil(maximum_results);
    bubbles
        .chunks(bucket_size)
        .map(merge_bubbles)
        .collect::<Vec<_>>()
}

fn merge_bubbles(bubbles: &[AnalyzerBubble]) -> AnalyzerBubble {
    let first = bubbles.first().expect("bubble bucket is not empty");
    let last = bubbles.last().expect("bubble bucket is not empty");
    let display_text = bubbles
        .iter()
        .flat_map(|bubble| bubble.display_text.iter().cloned())
        .take(MAX_MULTI_BUBBLE_STRINGS)
        .collect();
    AnalyzerBubble {
        bubble_type: AnalyzerBubbleType::MultiBubble,
        frame_id_interval: FrameIdInterval {
            begin: first.frame_id_interval.begin,
            end: last.frame_id_interval.end,
        },
        start_sample: first.start_sample,
        end_sample: last.end_sample,
        display_text,
        result_count: bubbles.iter().map(|bubble| bubble.result_count).sum(),
    }
}

#[derive(Debug, Clone, Copy)]
struct DisplayFrame<'a> {
    frame_id: u64,
    start_sample: u64,
    end_sample: u64,
    label: &'a str,
    texts: &'a [String],
}

fn display_frame_for_track<'a>(
    frame: &'a DecodedFrame,
    track: &AnalyzerTrackRequest,
) -> Option<DisplayFrame<'a>> {
    let value = channel_value_for_track(frame, track)?;
    Some(DisplayFrame {
        frame_id: frame.frame_id,
        start_sample: frame.start_sample,
        end_sample: frame.end_sample,
        label: &value.label,
        texts: &value.texts,
    })
}

fn display_frame_for_indexed_track(
    frames: &[DecodedFrame],
    index: AnalyzerTrackFrameIndex,
) -> Option<DisplayFrame<'_>> {
    let frame = frames.get(index.frame_index)?;
    let value = frame.channel_values.get(index.value_index)?;
    Some(DisplayFrame {
        frame_id: frame.frame_id,
        start_sample: frame.start_sample,
        end_sample: frame.end_sample,
        label: &value.label,
        texts: &value.texts,
    })
}

fn frame_ref_for_track(
    frame: &DecodedFrame,
    track: &AnalyzerTrackRequest,
) -> Option<AnalyzerFrameRef> {
    channel_value_for_track(frame, track)?;
    Some(AnalyzerFrameRef {
        frame_id: frame.frame_id,
        start_sample: frame.start_sample,
        end_sample: frame.end_sample,
    })
}

fn frame_ref_for_indexed_track(
    frames: &[DecodedFrame],
    index: AnalyzerTrackFrameIndex,
) -> AnalyzerFrameRef {
    let frame = &frames[index.frame_index];
    AnalyzerFrameRef {
        frame_id: frame.frame_id,
        start_sample: frame.start_sample,
        end_sample: frame.end_sample,
    }
}

fn channel_value_for_track<'a>(
    frame: &'a DecodedFrame,
    track: &AnalyzerTrackRequest,
) -> Option<&'a DecodedChannelValue> {
    let mut fallback = None;
    for value in &frame.channel_values {
        if value.channel != track.channel {
            continue;
        }
        if value.role == track.role {
            return Some(value);
        }
        fallback.get_or_insert(value);
    }
    fallback
}

fn lower_bound_frame_end(frames: &[DecodedFrame], sample: u64) -> usize {
    frames.partition_point(|frame| frame.end_sample < sample)
}

fn lower_bound_frame_start(frames: &[DecodedFrame], sample: u64) -> usize {
    frames.partition_point(|frame| frame.start_sample < sample)
}

fn upper_bound_frame_start(frames: &[DecodedFrame], sample: u64, low: usize) -> usize {
    low + frames[low..].partition_point(|frame| frame.start_sample <= sample)
}

fn lower_bound_match_frame_start(source: &AnalyzerFrameTableMatchSource<'_>, sample: u64) -> usize {
    source.matches.partition_point(|frame_position| {
        source.source.frames[*frame_position].start_sample < sample
    })
}

fn upper_bound_match_frame_start(
    source: &AnalyzerFrameTableMatchSource<'_>,
    sample: u64,
    low: usize,
) -> usize {
    low + source.matches[low..].partition_point(|frame_position| {
        source.source.frames[*frame_position].start_sample <= sample
    })
}

fn lower_bound_track_frame_end(
    frames: &[DecodedFrame],
    frame_indices: &[AnalyzerTrackFrameIndex],
    sample: u64,
) -> usize {
    frame_indices.partition_point(|index| frames[index.frame_index].end_sample < sample)
}

fn upper_bound_track_frame_start(
    frames: &[DecodedFrame],
    frame_indices: &[AnalyzerTrackFrameIndex],
    sample: u64,
    low: usize,
) -> usize {
    low + frame_indices[low..]
        .partition_point(|index| frames[index.frame_index].start_sample <= sample)
}

fn append_spi_bit(value: u64, bit: bool, bit_index: u8, bits: u8, msb_first: bool) -> u64 {
    if msb_first {
        (value << 1) | u64::from(bit)
    } else {
        value | (u64::from(bit) << u32::from(bit_index.min(bits - 1)))
    }
}

fn label_for_value(value: u64, bits: u8) -> String {
    let digits = usize::from(bits.div_ceil(4));
    format!("0x{value:0digits$X}")
}

#[derive(Default)]
struct FrameCollector {
    frames: Vec<DecodedFrame>,
    last_frame: Option<DecodedFrame>,
    seen: u64,
    stride: u64,
}

impl FrameCollector {
    fn push(&mut self, mut frame: DecodedFrame) {
        if self.stride == 0 {
            self.stride = 1;
        }
        frame.frame_id = self.seen;
        self.seen = self.seen.saturating_add(1);
        self.last_frame = Some(frame.clone());
        if frame.frame_id % self.stride != 0 {
            return;
        }
        self.frames.push(frame);
        if self.frames.len() > MAX_DECODED_FRAMES {
            self.frames = self
                .frames
                .drain(..)
                .enumerate()
                .filter_map(|(index, frame)| (index % 2 == 0).then_some(frame))
                .collect();
            self.stride = self.stride.saturating_mul(2);
        }
    }

    fn finish(mut self) -> Vec<DecodedFrame> {
        if let Some(last) = self.last_frame {
            if self.frames.last().map(|frame| frame.frame_id) != Some(last.frame_id) {
                if self.frames.len() >= MAX_DECODED_FRAMES {
                    self.frames.pop();
                }
                self.frames.push(last);
            }
        }
        self.frames
    }
}

#[cfg(test)]
mod tests {
    use std::{
        sync::Arc,
        time::{Duration, Instant},
    };

    use chrono::Utc;
    use sigpilot_core::{
        capture::generate_sample_words_with_count, decode_analyzer, CaptureSettings,
        SparseCaptureData, SparseDigitalChannel,
    };

    use super::*;

    fn demo_capture(channel_count: u8, sample_count: u64) -> CaptureData {
        let mut settings = CaptureSettings::default();
        settings.channel_count = channel_count;
        let unit_size = if channel_count > 16 {
            4
        } else if channel_count > 8 {
            2
        } else {
            1
        };
        generate_sample_words_with_count(&settings, sample_count, unit_size).unwrap()
    }

    fn decoded_frame_for_graph_test(frame_id: u64, start_sample: u64) -> DecodedFrame {
        DecodedFrame {
            frame_id,
            start_sample,
            end_sample: start_sample + 10,
            frame_type: "data".to_string(),
            label: format!("frame-{frame_id}"),
            value: frame_id,
            channel_values: vec![DecodedChannelValue {
                channel: 0,
                role: "Data".to_string(),
                label: format!("frame-{frame_id}"),
                texts: vec![format!("frame-{frame_id}")],
                value: frame_id,
            }],
            protocol_markers: Vec::new(),
        }
    }

    fn analyzer_table_source_for_graph_test(
        analyzer_id: &str,
        analyzer_name: &str,
        display_radix: &str,
        frames: Vec<DecodedFrame>,
    ) -> AnalyzerFrameTableSource {
        let frames = Arc::new(frames);
        let roles = Arc::new(analyzer_frame_roles(&frames));
        AnalyzerFrameTableSource {
            analyzer_id: analyzer_id.to_string(),
            analyzer_name_search: analyzer_name.to_lowercase(),
            display_radix: display_radix.to_string(),
            search_texts: Some(Arc::new(analyzer_frame_search_texts(
                &frames,
                display_radix,
            ))),
            search_matches: None,
            frames,
            roles,
        }
    }

    #[test]
    fn capture_memory_usage_tracks_samples_and_edge_index() {
        let capture = demo_capture(8, 80_000);
        let session = GraphSession::default();
        session.begin_capture(capture.metadata.clone()).unwrap();
        session.append_samples(&capture.samples).unwrap();

        let usage =
            session.capture_memory_usage(512 * 1024 * 1024, Some(capture.samples.len() as u64));
        assert_eq!(usage.buffer_bytes, 512 * 1024 * 1024);
        assert_eq!(usage.sample_bytes, capture.samples.len() as u64);
        assert!(usage.index_bytes > 0);
        assert_eq!(usage.analyzer_bytes, 0);
        assert_eq!(
            usage.total_bytes,
            usage.sample_bytes + usage.index_bytes + usage.analyzer_bytes
        );

        session.finish_capture(capture.clone()).unwrap();
        let finalized = session.capture_memory_usage(512 * 1024 * 1024, None);
        assert_eq!(finalized.sample_bytes, capture.samples.capacity() as u64);
        assert!(finalized.sample_bytes >= capture.samples.len() as u64);
        assert_eq!(finalized.index_bytes, usage.index_bytes);
    }

    #[test]
    fn indexed_tile_matches_scanner() {
        let capture = demo_capture(8, 80_000);
        let graph = DigitalGraph::from_capture(&capture).unwrap();
        for request in [
            WaveformRequest {
                start_sample: 0,
                sample_count: 80_000,
                pixels: 800,
                channels: vec![],
            },
            WaveformRequest {
                start_sample: 12_345,
                sample_count: 2_048,
                pixels: 600,
                channels: vec![0, 1, 3, 7],
            },
        ] {
            let indexed = graph.build_tile(&request).unwrap();
            let scanned = sigpilot_waveform::build_tile(&capture, &request).unwrap();
            assert_eq!(indexed.start_sample, scanned.start_sample);
            assert_eq!(indexed.sample_count, scanned.sample_count);
            assert_eq!(indexed.pixels, scanned.pixels);
            assert_eq!(indexed.samples_per_pixel, scanned.samples_per_pixel);
            assert_eq!(indexed.channels.len(), scanned.channels.len());
            for (indexed_channel, scanned_channel) in indexed.channels.iter().zip(&scanned.channels)
            {
                assert_eq!(indexed_channel.channel, scanned_channel.channel);
                assert_eq!(indexed_channel.label, scanned_channel.label);
                assert_eq!(
                    unpack_digital_bins(indexed_channel.packed_bins.as_deref().unwrap()),
                    scanned_channel.bins
                );
                assert_eq!(indexed_channel.segments, scanned_channel.segments);
                assert_eq!(
                    indexed_channel.previous_transition,
                    scanned_channel.previous_transition
                );
                assert_eq!(
                    indexed_channel.next_transition,
                    scanned_channel.next_transition
                );
                if !scanned_channel.rising_edges.is_empty()
                    || !scanned_channel.falling_edges.is_empty()
                {
                    assert_eq!(indexed_channel.rising_edges, scanned_channel.rising_edges);
                    assert_eq!(indexed_channel.falling_edges, scanned_channel.falling_edges);
                }
            }
        }
    }

    #[test]
    fn packed_trim_reuses_the_existing_edge_index() {
        let original = demo_capture(8, 10_000);
        let unit_size = usize::from(original.metadata.unitsize);
        let expected_samples = original.samples[2_500 * unit_size..9_000 * unit_size].to_vec();
        let session = GraphSession::default();
        session.replace_capture(original).unwrap();

        let (metadata, bytes) = session.trim_capture(2_500, 9_000).unwrap();
        let capture = session.capture().unwrap();
        assert_eq!(metadata.sample_count, 6_500);
        assert_eq!(bytes, expected_samples.len());
        assert_eq!(capture.samples, expected_samples);

        let rebuilt = DigitalGraph::from_capture(&capture).unwrap();
        let indexed = session.graph.read();
        let indexed = indexed.as_ref().unwrap();
        assert_eq!(indexed.metadata, rebuilt.metadata);
        assert_eq!(indexed.sample_count, rebuilt.sample_count);
        for (trimmed, expected) in indexed.channels.iter().zip(&rebuilt.channels) {
            assert_eq!(trimmed.initial_high, expected.initial_high);
            assert_eq!(trimmed.edges, expected.edges);
        }
    }

    #[test]
    fn sparse_trim_updates_initial_levels_and_transition_offsets() {
        let mut metadata = demo_capture(2, 1_000).metadata;
        metadata.sample_count = 1_000;
        let sparse = SparseCaptureData {
            metadata,
            channels: vec![
                SparseDigitalChannel {
                    channel: 0,
                    initial_high: false,
                    transitions: vec![100, 300, 700, 900],
                },
                SparseDigitalChannel {
                    channel: 1,
                    initial_high: true,
                    transitions: vec![200, 400, 600, 800],
                },
            ],
        };
        let session = GraphSession::default();
        session.replace_sparse_capture(sparse).unwrap();

        let (metadata, bytes) = session.trim_capture(250, 800).unwrap();
        let capture = session.sparse_capture().unwrap();
        assert_eq!(metadata.sample_count, 550);
        assert_eq!(bytes, 4 * 8);
        assert!(capture.channels[0].initial_high);
        assert_eq!(capture.channels[0].transitions, vec![50, 450]);
        assert!(!capture.channels[1].initial_high);
        assert_eq!(capture.channels[1].transitions, vec![150, 350]);

        let rebuilt = DigitalGraph::from_sparse_capture(&capture).unwrap();
        let indexed = session.graph.read();
        let indexed = indexed.as_ref().unwrap();
        for (trimmed, expected) in indexed.channels.iter().zip(&rebuilt.channels) {
            assert_eq!(trimmed.initial_high, expected.initial_high);
            assert_eq!(trimmed.edges, expected.edges);
        }
    }

    #[test]
    fn nearest_transition_uses_the_index_without_a_viewport_tile() {
        let mut metadata = demo_capture(1, 1_000).metadata;
        metadata.sample_count = 1_000;
        let session = GraphSession::default();
        session
            .replace_sparse_capture(SparseCaptureData {
                metadata,
                channels: vec![SparseDigitalChannel {
                    channel: 0,
                    initial_high: false,
                    transitions: vec![100, 300, 700, 900],
                }],
            })
            .unwrap();

        assert_eq!(
            session.nearest_transition(0, 260).unwrap(),
            Some(NearestDigitalTransition {
                previous_sample: Some(100),
                sample: 300,
                next_sample: Some(700),
            }),
        );
        assert_eq!(
            session.nearest_transition(0, 995).unwrap(),
            Some(NearestDigitalTransition {
                previous_sample: Some(700),
                sample: 900,
                next_sample: None,
            }),
        );
    }

    #[test]
    fn point_measurement_uses_the_full_edge_index_outside_the_viewport() {
        let mut metadata = demo_capture(1, 1_000).metadata;
        metadata.sample_count = 1_000;
        let session = GraphSession::default();
        session
            .replace_sparse_capture(SparseCaptureData {
                metadata,
                channels: vec![SparseDigitalChannel {
                    channel: 0,
                    initial_high: false,
                    transitions: vec![100, 300, 700, 900],
                }],
            })
            .unwrap();

        assert_eq!(
            session.measure_point(0, 500).unwrap(),
            Some(DigitalPointMeasurement {
                channel: 0,
                cursor_sample: 500,
                high: false,
                width_start_sample: 300,
                width_end_sample: 700,
                period_end_sample: Some(900),
            }),
        );
        assert_eq!(session.measure_point(0, 50).unwrap(), None);
        assert_eq!(session.measure_point(0, 950).unwrap(), None);
    }

    #[test]
    fn incremental_append_matches_one_shot_and_supports_channel_31() {
        let words = [0u32, 1u32 << 31, (1u32 << 31) | 1, 0];
        let samples = words
            .into_iter()
            .flat_map(u32::to_le_bytes)
            .collect::<Vec<_>>();
        let metadata = CaptureMetadata {
            version: 1,
            source_device: "test-32".to_string(),
            sample_rate_hz: 25_000_000,
            channel_count: 32,
            enabled_channels: (0..32).collect(),
            unitsize: 4,
            sample_count: words.len() as u64,
            captured_at: Utc::now(),
            labels: (0..32).map(|channel| format!("D{channel}")).collect(),
            trigger: None,
        };
        let capture = CaptureData {
            metadata: metadata.clone(),
            samples: samples.clone(),
        };
        let one_shot = DigitalGraph::from_capture(&capture).unwrap();
        let mut streaming = DigitalGraph::new(metadata).unwrap();
        streaming.append_interleaved(&samples[..8]).unwrap();
        streaming.append_interleaved(&samples[8..]).unwrap();

        let request = WaveformRequest {
            start_sample: 0,
            sample_count: 4,
            pixels: 4,
            channels: vec![31],
        };
        assert_eq!(
            one_shot.build_tile(&request).unwrap(),
            streaming.build_tile(&request).unwrap()
        );
        let tile = streaming.build_tile(&request).unwrap();
        assert_eq!(tile.channels[0].rising_edges, vec![1]);
        assert_eq!(tile.channels[0].falling_edges, vec![3]);

        let navigation_tile = streaming
            .build_tile(&WaveformRequest {
                start_sample: 2,
                sample_count: 1,
                pixels: 1,
                channels: vec![31],
            })
            .unwrap();
        assert_eq!(navigation_tile.channels[0].previous_transition, Some(1));
        assert_eq!(navigation_tile.channels[0].next_transition, Some(3));
    }

    #[test]
    fn packed_cross_lane_append_matches_interleaved_index() {
        let enabled_channels = vec![0, 4, 31];
        let lane_words = [
            0x00ff_00ff_00ff_00ffu64,
            0xaaaa_aaaa_5555_5555u64,
            0x8000_0000_0000_0001u64,
            0xff00_ff00_ff00_ff00u64,
            0x5555_5555_aaaa_aaaau64,
            0x7fff_ffff_ffff_fffeu64,
        ];
        let packed = lane_words
            .into_iter()
            .flat_map(u64::to_le_bytes)
            .collect::<Vec<_>>();
        let interleaved = sigpilot_core::decode_cross_data_to_physical_channels(
            32,
            &enabled_channels,
            &packed,
            false,
        )
        .unwrap();
        let metadata = CaptureMetadata {
            version: 1,
            source_device: "packed-cross-test".to_string(),
            sample_rate_hz: 100_000_000,
            channel_count: 32,
            enabled_channels: enabled_channels.clone(),
            unitsize: 4,
            sample_count: 0,
            captured_at: Utc::now(),
            labels: (0..32).map(|channel| format!("D{channel}")).collect(),
            trigger: None,
        };
        let mut expected = DigitalGraph::new(metadata.clone()).unwrap();
        expected.append_interleaved(&interleaved).unwrap();
        let mut packed_graph = DigitalGraph::new(metadata).unwrap();
        packed_graph
            .append_cross_lanes(&enabled_channels, &packed[..24], false)
            .unwrap();
        packed_graph
            .append_cross_lanes(&enabled_channels, &packed[24..], false)
            .unwrap();

        assert_eq!(packed_graph.sample_count(), 128);
        for channel in [0, 4, 31] {
            let request = WaveformRequest {
                start_sample: 0,
                sample_count: 128,
                pixels: 128,
                channels: vec![channel],
            };
            assert_eq!(
                packed_graph.build_tile(&request).unwrap(),
                expected.build_tile(&request).unwrap()
            );
        }
    }

    #[test]
    fn sparse_graph_indexes_saleae_capture_beyond_u32_samples() {
        let sample_count = 49_940_179_616;
        let metadata = CaptureMetadata {
            version: 1,
            source_device: "Saleae demo.sal".to_string(),
            sample_rate_hz: 125_000_000,
            channel_count: 8,
            enabled_channels: vec![3],
            unitsize: 1,
            sample_count,
            captured_at: Utc::now(),
            labels: (0..8).map(|channel| format!("D{channel}")).collect(),
            trigger: None,
        };
        let capture = SparseCaptureData {
            metadata,
            channels: vec![SparseDigitalChannel {
                channel: 3,
                initial_high: false,
                transitions: vec![10, 4_294_967_300, 49_000_000_000],
            }],
        };
        let graph = DigitalGraph::from_sparse_capture(&capture).unwrap();
        let tile = graph
            .build_tile(&WaveformRequest {
                start_sample: 4_294_967_200,
                sample_count: 300,
                pixels: 300,
                channels: vec![3],
            })
            .unwrap();
        assert_eq!(tile.sample_count, 300);
        assert_eq!(tile.channels[0].falling_edges, vec![4_294_967_300]);
        assert_eq!(tile.channels[0].previous_transition, Some(10));
        assert_eq!(tile.channels[0].next_transition, Some(49_000_000_000));
    }

    #[test]
    fn incremental_finish_preserves_hardware_trigger_metadata() {
        let mut capture = demo_capture(4, 4_096);
        let session = GraphSession::default();
        let mut starting_metadata = capture.metadata.clone();
        starting_metadata.sample_count = 0;
        session.begin_capture(starting_metadata).unwrap();
        session.append_samples(&capture.samples).unwrap();

        let trigger = CaptureTriggerMetadata {
            sample_index: 2_048,
            channel: 1,
            kind: sigpilot_core::CaptureTriggerKind::Rising,
        };
        session.set_trigger(trigger.clone()).unwrap();
        assert_eq!(session.metadata().unwrap().trigger, Some(trigger.clone()));

        capture.metadata.trigger = Some(trigger.clone());
        session.finish_capture(capture).unwrap();
        assert_eq!(session.metadata().unwrap().trigger, Some(trigger));
    }

    #[test]
    fn edge_decoders_match_reference_decoders() {
        let capture = demo_capture(16, 250_000);
        let graph = DigitalGraph::from_capture(&capture).unwrap();
        for settings in [
            AnalyzerDecodeSettings::Uart(UartDecodeSettings::default()),
            AnalyzerDecodeSettings::I2c(I2cDecodeSettings::default()),
            AnalyzerDecodeSettings::Spi(SpiDecodeSettings::default()),
        ] {
            let indexed = graph.decode(&settings).unwrap();
            let scanned = decode_analyzer(&capture, &settings).unwrap();
            assert_eq!(indexed, scanned, "settings={settings:?}");
        }
    }

    #[test]
    fn analyzer_cache_extends_incrementally_during_capture() {
        let capture = demo_capture(16, 500_000);
        for settings in [
            AnalyzerDecodeSettings::Uart(UartDecodeSettings::default()),
            AnalyzerDecodeSettings::I2c(I2cDecodeSettings::default()),
            AnalyzerDecodeSettings::Spi(SpiDecodeSettings::default()),
        ] {
            let session = GraphSession::default();
            session.begin_capture(capture.metadata.clone()).unwrap();
            let split = capture.samples.len() / 2 / usize::from(capture.metadata.unitsize)
                * usize::from(capture.metadata.unitsize);
            session.append_samples(&capture.samples[..split]).unwrap();
            let first = session.decode_frames(&settings).unwrap();
            session.append_samples(&capture.samples[split..]).unwrap();
            let incremental = session.decode_frames(&settings).unwrap();
            let expected = DigitalGraph::from_capture(&capture)
                .unwrap()
                .decode(&settings)
                .unwrap();
            assert!(incremental.len() >= first.len(), "settings={settings:?}");
            assert_eq!(incremental.as_ref(), &expected, "settings={settings:?}");
        }
    }

    #[test]
    fn analyzer_decode_count_and_slice_avoid_full_vec_clones() {
        let capture = demo_capture(16, 250_000);
        let session = GraphSession::default();
        session.finish_capture(capture).unwrap();
        let settings = AnalyzerDecodeSettings::Spi(SpiDecodeSettings::default());
        let frames = session
            .decode_frames_with_backend(&settings, DecoderBackendKind::LegacyRust)
            .unwrap();
        assert!(frames.len() > 6);

        assert_eq!(
            session
                .decode_frame_count_with_backend(&settings, DecoderBackendKind::LegacyRust)
                .unwrap(),
            frames.len(),
        );

        let (frame_count, slice) = session
            .decode_frame_slice_with_backend(&settings, DecoderBackendKind::LegacyRust, 2, 6)
            .unwrap();
        assert_eq!(frame_count, frames.len());
        assert_eq!(slice, frames[2..6]);

        let (frame_count, empty_tail) = session
            .decode_frame_slice_with_backend(
                &settings,
                DecoderBackendKind::LegacyRust,
                frames.len() + 10,
                frames.len() + 20,
            )
            .unwrap();
        assert_eq!(frame_count, frames.len());
        assert!(empty_tail.is_empty());
    }

    #[test]
    fn analyzer_frame_table_search_cache_is_lazy_and_reused() {
        let capture = demo_capture(16, 250_000);
        let session = GraphSession::default();
        session.finish_capture(capture).unwrap();
        let settings = AnalyzerDecodeSettings::Spi(SpiDecodeSettings::default());
        let request = AnalyzerFrameTableRequest {
            analyzer_id: "spi".to_string(),
            analyzer_name: "SPI".to_string(),
            backend: DecoderBackendKind::LegacyRust,
            display_radix: "Hexadecimal".to_string(),
            settings: settings.clone(),
        };
        let cache_key = serde_json::to_string(&settings).unwrap();

        let window = session
            .decode_frame_table_window(std::slice::from_ref(&request), 0, 10)
            .unwrap();
        assert!(!window.rows.is_empty());
        {
            let cache = session.analyzer_cache.lock();
            let entry = cache.get(&cache_key).unwrap();
            assert!(entry.table_search_texts.lock().is_empty());
            assert!(entry.table_search_matches.lock().is_empty());
        }

        let search = session
            .decode_frame_table_search_window(std::slice::from_ref(&request), "0x", 0, 10)
            .unwrap();
        assert!(!search.rows.is_empty());
        let first_matches = {
            let cache = session.analyzer_cache.lock();
            let entry = cache.get(&cache_key).unwrap();
            assert!(!entry.table_search_texts.lock().is_empty());
            let matches_cache = entry.table_search_matches.lock();
            assert_eq!(matches_cache.len(), 1);
            matches_cache.values().next().unwrap().clone()
        };

        let scrolled = session
            .decode_frame_table_search_window(std::slice::from_ref(&request), "0x", 10, 20)
            .unwrap();
        assert!(!scrolled.rows.is_empty());
        let reused_matches = {
            let cache = session.analyzer_cache.lock();
            let entry = cache.get(&cache_key).unwrap();
            let matches_cache = entry.table_search_matches.lock();
            assert_eq!(matches_cache.len(), 1);
            matches_cache.values().next().unwrap().clone()
        };
        assert!(Arc::ptr_eq(&first_matches, &reused_matches));
    }

    #[test]
    fn uncached_table_search_does_not_materialize_all_search_texts() {
        let frames = Arc::new(
            (0..32)
                .map(|index| decoded_frame_for_graph_test(index, index * 10))
                .collect::<Vec<_>>(),
        );
        let request = AnalyzerFrameTableRequest {
            analyzer_id: "spi".to_string(),
            analyzer_name: "SPI".to_string(),
            backend: DecoderBackendKind::SaleaeNative,
            display_radix: "Hexadecimal".to_string(),
            settings: AnalyzerDecodeSettings::Spi(SpiDecodeSettings::default()),
        };
        let source = analyzer_frame_table_source_from_frames(
            &request,
            frames,
            Arc::new(vec!["Data".to_string()]),
            None,
            Some("frame-7"),
        )
        .unwrap();

        assert!(source.search_texts.is_none());
        assert!(source.search_matches.is_none());

        let window = analyzer_frame_table_search_window_from_sources(&[source], "frame-7", 0, 10);
        assert_eq!(window.row_count, 1);
        assert_eq!(window.rows[0].frame.label, "frame-7");
    }

    #[test]
    fn cached_table_search_by_analyzer_name_avoids_frame_text_cache() {
        let capture = demo_capture(16, 250_000);
        let session = GraphSession::default();
        session.finish_capture(capture).unwrap();
        let settings = AnalyzerDecodeSettings::Spi(SpiDecodeSettings::default());
        let request = AnalyzerFrameTableRequest {
            analyzer_id: "spi".to_string(),
            analyzer_name: "SPI Analyzer".to_string(),
            backend: DecoderBackendKind::LegacyRust,
            display_radix: "Hexadecimal".to_string(),
            settings: settings.clone(),
        };
        let cache_key = serde_json::to_string(&settings).unwrap();

        let window = session
            .decode_frame_table_search_window(std::slice::from_ref(&request), "spi", 0, 10)
            .unwrap();
        assert_eq!(
            window.row_count,
            session.decode_frames(&settings).unwrap().len()
        );
        {
            let cache = session.analyzer_cache.lock();
            let entry = cache.get(&cache_key).unwrap();
            assert!(entry.table_search_texts.lock().is_empty());
            assert_eq!(entry.table_search_matches.lock().len(), 1);
        }
    }

    #[test]
    fn saleae_frame_table_batches_cached_sources_without_sidecar() {
        let capture = demo_capture(16, 250_000);
        let session = GraphSession::default();
        session.finish_capture(capture).unwrap();
        let sample_count = session.sample_count();
        let spi_settings = AnalyzerDecodeSettings::Spi(SpiDecodeSettings::default());
        let i2c_settings = AnalyzerDecodeSettings::I2c(I2cDecodeSettings::default());
        let mut spi_frame = decoded_frame_for_graph_test(10, 10);
        spi_frame.label = "spi-first".to_string();
        spi_frame.channel_values[0].label = "spi-first".to_string();
        let mut i2c_frame = decoded_frame_for_graph_test(20, 20);
        i2c_frame.label = "i2c-second".to_string();
        i2c_frame.channel_values[0].label = "i2c-second".to_string();
        let spi_frames = Arc::new(vec![spi_frame]);
        let i2c_frames = Arc::new(vec![i2c_frame]);
        {
            let mut cache = session.analyzer_cache.lock();
            cache.insert(
                native_full_analyzer_cache_key(DecoderBackendKind::SaleaeNative, &spi_settings)
                    .unwrap(),
                analyzer_cache_entry(sample_count, spi_frames.clone()),
            );
            cache.insert(
                native_full_analyzer_cache_key(DecoderBackendKind::SaleaeNative, &i2c_settings)
                    .unwrap(),
                analyzer_cache_entry(sample_count, i2c_frames.clone()),
            );
        }
        let requests = vec![
            AnalyzerFrameTableRequest {
                analyzer_id: "spi".to_string(),
                analyzer_name: "SPI".to_string(),
                backend: DecoderBackendKind::SaleaeNative,
                display_radix: "Hexadecimal".to_string(),
                settings: spi_settings,
            },
            AnalyzerFrameTableRequest {
                analyzer_id: "i2c".to_string(),
                analyzer_name: "I2C".to_string(),
                backend: DecoderBackendKind::SaleaeNative,
                display_radix: "Hexadecimal".to_string(),
                settings: i2c_settings,
            },
        ];

        let window = session.decode_frame_table_window(&requests, 0, 2).unwrap();
        assert_eq!(window.row_count, 2);
        assert_eq!(
            window
                .rows
                .iter()
                .map(|row| (row.analyzer_id.as_str(), row.frame.label.as_str()))
                .collect::<Vec<_>>(),
            vec![("spi", "spi-first"), ("i2c", "i2c-second")]
        );

        let search = session
            .decode_frame_table_search_window(&requests, "second", 0, 2)
            .unwrap();
        assert_eq!(search.row_count, 1);
        assert_eq!(search.rows[0].analyzer_id, "i2c");
        assert_eq!(search.rows[0].frame.label, "i2c-second");
    }

    #[test]
    fn analyzer_frame_table_window_merges_sources_without_cloning_all_rows() {
        let sources = vec![
            analyzer_table_source_for_graph_test(
                "a",
                "SPI",
                "Hexadecimal",
                vec![
                    decoded_frame_for_graph_test(10, 0),
                    decoded_frame_for_graph_test(11, 10),
                    decoded_frame_for_graph_test(12, 20),
                    decoded_frame_for_graph_test(13, 30),
                ],
            ),
            analyzer_table_source_for_graph_test(
                "b",
                "I2C",
                "Hexadecimal",
                vec![
                    decoded_frame_for_graph_test(20, 5),
                    decoded_frame_for_graph_test(21, 10),
                    decoded_frame_for_graph_test(22, 25),
                ],
            ),
        ];

        let window = analyzer_frame_table_window_from_sources(&sources, 2, 6);

        assert_eq!(window.row_count, 7);
        assert_eq!(window.roles, vec!["Data".to_string()]);
        assert_eq!(
            window
                .rows
                .iter()
                .map(|row| (
                    row.analyzer_id.as_str(),
                    row.frame.start_sample,
                    row.frame_number
                ))
                .collect::<Vec<_>>(),
            vec![("a", 10, 2), ("b", 10, 2), ("a", 20, 3), ("b", 25, 3)]
        );
    }

    #[test]
    fn analyzer_frame_table_window_jumps_to_deep_merged_window() {
        let even_frames = (0..10_000)
            .map(|index| {
                let sample = (index * 2) as u64;
                decoded_frame_for_graph_test(sample, sample)
            })
            .collect();
        let odd_frames = (0..10_000)
            .map(|index| {
                let sample = (index * 2 + 1) as u64;
                decoded_frame_for_graph_test(sample, sample)
            })
            .collect();
        let sources = vec![
            analyzer_table_source_for_graph_test("even", "SPI", "Hexadecimal", even_frames),
            analyzer_table_source_for_graph_test("odd", "I2C", "Hexadecimal", odd_frames),
        ];

        let window = analyzer_frame_table_window_from_sources(&sources, 19_990, 20_000);

        assert_eq!(window.row_count, 20_000);
        assert_eq!(window.rows.len(), 10);
        assert_eq!(
            window
                .rows
                .iter()
                .map(|row| (row.analyzer_id.as_str(), row.frame.start_sample))
                .collect::<Vec<_>>(),
            vec![
                ("even", 19_990),
                ("odd", 19_991),
                ("even", 19_992),
                ("odd", 19_993),
                ("even", 19_994),
                ("odd", 19_995),
                ("even", 19_996),
                ("odd", 19_997),
                ("even", 19_998),
                ("odd", 19_999),
            ]
        );
    }

    #[test]
    fn analyzer_frame_table_search_window_matches_display_text_without_full_rows() {
        let mut address = decoded_frame_for_graph_test(0, 0);
        address.frame_type = "address".to_string();
        address.label = "0x2A Write ACK".to_string();
        address.value = 0x2a;
        address.channel_values = vec![DecodedChannelValue {
            channel: 1,
            role: "SDA".to_string(),
            label: "0x2A".to_string(),
            texts: vec!["0x2A".to_string()],
            value: 0x2a,
        }];
        let mut data = decoded_frame_for_graph_test(1, 20);
        data.label = "0x0E".to_string();
        data.value = 0x0e;
        data.channel_values = vec![DecodedChannelValue {
            channel: 1,
            role: "SDA".to_string(),
            label: "0x0E".to_string(),
            texts: vec!["0x0E".to_string()],
            value: 0x0e,
        }];
        let mut spi = decoded_frame_for_graph_test(2, 10);
        spi.channel_values = vec![DecodedChannelValue {
            channel: 3,
            role: "MOSI".to_string(),
            label: "14".to_string(),
            texts: vec!["14".to_string()],
            value: 14,
        }];
        let sources = vec![
            analyzer_table_source_for_graph_test(
                "i2c",
                "I2C Bus",
                "Hexadecimal",
                vec![address, data],
            ),
            analyzer_table_source_for_graph_test("spi", "SPI", "Decimal", vec![spi]),
        ];

        let first_match = analyzer_frame_table_search_window_from_sources(&sources, "0x0e", 0, 1);
        assert_eq!(first_match.row_count, 1);
        assert_eq!(
            first_match.roles,
            vec!["SDA".to_string(), "MOSI".to_string()]
        );
        assert_eq!(first_match.rows.len(), 1);
        assert_eq!(first_match.rows[0].analyzer_id, "i2c");
        assert_eq!(first_match.rows[0].frame_number, 2);

        let analyzer_name_match =
            analyzer_frame_table_search_window_from_sources(&sources, "i2c bus", 0, 10);
        assert_eq!(analyzer_name_match.row_count, 2);
        assert!(analyzer_name_match
            .rows
            .iter()
            .all(|row| row.analyzer_id == "i2c"));

        let decimal_match =
            analyzer_frame_table_search_window_from_sources(&sources, "mosi 14", 0, 10);
        assert_eq!(decimal_match.row_count, 1);
        assert_eq!(decimal_match.rows[0].analyzer_id, "spi");

        let cross_prefix_match =
            analyzer_frame_table_search_window_from_sources(&sources, "i2c bus 2 data 0x0e", 0, 10);
        assert_eq!(cross_prefix_match.row_count, 1);
        assert_eq!(cross_prefix_match.rows[0].analyzer_id, "i2c");
        assert_eq!(cross_prefix_match.rows[0].frame_number, 2);
    }

    #[test]
    fn fit_capture_bubbles_are_bounded_and_cover_the_capture() {
        let frames = (0..10_000u64)
            .map(|frame_id| DecodedFrame {
                frame_id,
                start_sample: frame_id * 100,
                end_sample: frame_id * 100 + 80,
                frame_type: "data".to_string(),
                label: format!("0x{:02X}", frame_id & 0xff),
                value: frame_id & 0xff,
                channel_values: vec![DecodedChannelValue {
                    channel: 0,
                    role: "Input".to_string(),
                    label: format!("0x{:02X}", frame_id & 0xff),
                    texts: vec![format!("0x{:02X}", frame_id & 0xff)],
                    value: frame_id & 0xff,
                }],
                protocol_markers: Vec::new(),
            })
            .collect::<Vec<_>>();
        let window = render_analyzer_track(
            &frames,
            &AnalyzerTrackRequest {
                channel: 0,
                role: "Input".to_string(),
            },
            &WaveformRequest {
                start_sample: 0,
                sample_count: 1_000_000,
                pixels: 1200,
                channels: vec![0],
            },
        );
        assert!(window.bubbles.len() <= MAX_ANALYZER_MARKER_RESULTS);
        assert_eq!(window.bubbles.first().unwrap().start_sample, 0);
        assert!(window.bubbles.last().unwrap().end_sample > 990_000);
    }

    #[test]
    fn dense_frame_counts_still_split_when_frames_are_wide_on_screen() {
        let frames = (0..1_201u64)
            .map(|frame_id| DecodedFrame {
                frame_id,
                start_sample: frame_id * 5,
                end_sample: frame_id * 5 + 100,
                frame_type: "data".to_string(),
                label: format!("0x{:02X}", frame_id & 0xff),
                value: frame_id & 0xff,
                channel_values: vec![
                    DecodedChannelValue {
                        channel: 0,
                        role: "A".to_string(),
                        label: format!("A 0x{:02X}", frame_id & 0xff),
                        texts: Vec::new(),
                        value: frame_id & 0xff,
                    },
                    DecodedChannelValue {
                        channel: 1,
                        role: "B".to_string(),
                        label: format!("B 0x{:02X}", frame_id & 0xff),
                        texts: Vec::new(),
                        value: frame_id & 0xff,
                    },
                ],
                protocol_markers: Vec::new(),
            })
            .collect::<Vec<_>>();
        let view = WaveformRequest {
            start_sample: 0,
            sample_count: 10_000,
            pixels: 2_000,
            channels: vec![0, 1],
        };

        let single_track = render_analyzer_track(
            &frames,
            &AnalyzerTrackRequest {
                channel: 0,
                role: "A".to_string(),
            },
            &view,
        );
        assert_eq!(single_track.bubbles.len(), frames.len());
        assert!(single_track
            .bubbles
            .iter()
            .all(|bubble| bubble.bubble_type == AnalyzerBubbleType::SingleBubble));

        let indexed_tracks = render_analyzer_tracks(
            &frames,
            &[
                AnalyzerTrackRequest {
                    channel: 0,
                    role: "A".to_string(),
                },
                AnalyzerTrackRequest {
                    channel: 1,
                    role: "B".to_string(),
                },
            ],
            &view,
        )
        .unwrap();
        assert!(indexed_tracks.iter().all(|track| {
            track.bubbles.len() == frames.len()
                && track
                    .bubbles
                    .iter()
                    .all(|bubble| bubble.bubble_type == AnalyzerBubbleType::SingleBubble)
        }));

        let overview = render_analyzer_track(
            &frames,
            &AnalyzerTrackRequest {
                channel: 0,
                role: "A".to_string(),
            },
            &WaveformRequest {
                pixels: 100,
                ..view
            },
        );
        assert_eq!(overview.bubbles.len(), 1);
        assert_eq!(
            overview.bubbles[0].bubble_type,
            AnalyzerBubbleType::MultiBubble
        );
        assert_eq!(overview.bubbles[0].result_count, frames.len() as u64);
    }

    #[test]
    fn native_decoded_frame_normalization_preserves_ordered_frames() {
        let mut frames = vec![
            decoded_frame_for_graph_test(0, 10),
            decoded_frame_for_graph_test(1, 20),
            decoded_frame_for_graph_test(1, 20),
            decoded_frame_for_graph_test(2, 40),
        ];
        normalize_native_decoded_frames(&mut frames);

        assert_eq!(
            frames
                .iter()
                .map(|frame| (frame.frame_id, frame.start_sample))
                .collect::<Vec<_>>(),
            vec![(0, 10), (1, 20), (2, 40)]
        );
    }

    #[test]
    fn native_decoded_frame_normalization_sorts_unordered_frames() {
        let mut frames = vec![
            decoded_frame_for_graph_test(2, 40),
            decoded_frame_for_graph_test(0, 10),
            decoded_frame_for_graph_test(1, 20),
            decoded_frame_for_graph_test(1, 20),
        ];
        normalize_native_decoded_frames(&mut frames);

        assert_eq!(
            frames
                .iter()
                .map(|frame| (frame.frame_id, frame.start_sample))
                .collect::<Vec<_>>(),
            vec![(0, 10), (1, 20), (2, 40)]
        );
    }

    #[test]
    fn native_background_windows_advance_without_gaps_and_keep_context() {
        let clock_edges = (1..=300_000u64).map(|edge| edge * 10).collect::<Vec<_>>();
        let capture = SparseCaptureData {
            metadata: CaptureMetadata {
                version: 1,
                source_device: "native-background-window-test".to_string(),
                sample_rate_hz: 100_000_000,
                channel_count: 4,
                enabled_channels: (0..4).collect(),
                unitsize: 1,
                sample_count: 3_000_010,
                captured_at: Utc::now(),
                labels: (0..4).map(|channel| format!("D{channel}")).collect(),
                trigger: None,
            },
            channels: vec![
                SparseDigitalChannel {
                    channel: 0,
                    initial_high: false,
                    transitions: Vec::new(),
                },
                SparseDigitalChannel {
                    channel: 1,
                    initial_high: false,
                    transitions: Vec::new(),
                },
                SparseDigitalChannel {
                    channel: 2,
                    initial_high: false,
                    transitions: clock_edges,
                },
                SparseDigitalChannel {
                    channel: 3,
                    initial_high: true,
                    transitions: Vec::new(),
                },
            ],
        };
        let settings = AnalyzerDecodeSettings::Spi(SpiDecodeSettings {
            mosi_channel: Some(0),
            miso_channel: Some(1),
            clock_channel: 2,
            enable_channel: None,
            ..SpiDecodeSettings::default()
        });
        let view = sparse_capture_view(&capture);
        let mut edge = 0usize;
        let mut previous_retain_end = 0u64;
        let mut windows = Vec::new();
        while edge < 300_000 {
            let window =
                native_background_window(&view, &settings, edge, NATIVE_BACKGROUND_BODY_EDGES)
                    .unwrap();
            assert_eq!(window.body_edge_begin, edge);
            assert_eq!(window.retain_start_sample, previous_retain_end);
            assert!(window.decode_start_sample <= window.retain_start_sample);
            assert!(window.decode_end_sample >= window.retain_end_sample);
            edge = window.body_edge_end;
            previous_retain_end = window.retain_end_sample;
            windows.push(window);
        }

        assert_eq!(edge, 300_000);
        assert_eq!(previous_retain_end, capture.metadata.sample_count);
        assert_eq!(windows.len(), 3);
        assert!(windows[0].decode_end_sample > windows[0].retain_end_sample);
        assert!(windows[1].decode_start_sample < windows[1].retain_start_sample);
    }

    #[test]
    fn native_background_frame_append_keeps_order_and_removes_boundary_duplicates() {
        let mut accumulated = vec![
            decoded_frame_for_graph_test(10, 10),
            decoded_frame_for_graph_test(20, 20),
        ];
        append_native_background_frames(
            &mut accumulated,
            vec![
                decoded_frame_for_graph_test(20, 20),
                decoded_frame_for_graph_test(30, 30),
            ],
        );

        assert_eq!(
            accumulated
                .iter()
                .map(|frame| frame.start_sample)
                .collect::<Vec<_>>(),
            vec![10, 20, 30]
        );
    }

    #[test]
    fn sparse_native_fit_windows_are_bounded_and_span_the_view() {
        let clock_edges = (1..=100_000u64).map(|edge| edge * 100).collect::<Vec<_>>();
        let capture = SparseCaptureData {
            metadata: CaptureMetadata {
                version: 1,
                source_device: "sparse-window-test".to_string(),
                sample_rate_hz: 100_000_000,
                channel_count: 4,
                enabled_channels: (0..4).collect(),
                unitsize: 1,
                sample_count: 10_000_100,
                captured_at: Utc::now(),
                labels: (0..4).map(|channel| format!("D{channel}")).collect(),
                trigger: None,
            },
            channels: vec![
                SparseDigitalChannel {
                    channel: 0,
                    initial_high: false,
                    transitions: Vec::new(),
                },
                SparseDigitalChannel {
                    channel: 1,
                    initial_high: false,
                    transitions: Vec::new(),
                },
                SparseDigitalChannel {
                    channel: 2,
                    initial_high: false,
                    transitions: clock_edges,
                },
                SparseDigitalChannel {
                    channel: 3,
                    initial_high: true,
                    transitions: Vec::new(),
                },
            ],
        };
        let settings = AnalyzerDecodeSettings::Spi(SpiDecodeSettings {
            mosi_channel: Some(0),
            miso_channel: Some(1),
            clock_channel: 2,
            enable_channel: None,
            ..SpiDecodeSettings::default()
        });
        let view = WaveformRequest {
            start_sample: 0,
            sample_count: capture.metadata.sample_count,
            pixels: 1_200,
            channels: Vec::new(),
        };

        let windows =
            sparse_native_analysis_windows(&sparse_capture_view(&capture), &settings, &view)
                .unwrap();
        assert_eq!(windows.len(), 13);
        assert!(windows.first().unwrap().0 < 1_000);
        assert!(windows.last().unwrap().1 > 9_999_000);
        let selected_clock_edges = windows
            .iter()
            .map(|&(start, end)| {
                slice_sparse_capture(&capture, start, end).unwrap().channels[2]
                    .transitions
                    .len()
            })
            .sum::<usize>();
        assert!(selected_clock_edges < 25_000);
    }

    #[test]
    fn native_decode_cache_window_expands_beyond_logical_view() {
        let clock_edges = (1..=1_000u64).map(|edge| edge * 100).collect::<Vec<_>>();
        let capture = SparseCaptureData {
            metadata: CaptureMetadata {
                version: 1,
                source_device: "native-cache-padding-test".to_string(),
                sample_rate_hz: 100_000_000,
                channel_count: 4,
                enabled_channels: (0..4).collect(),
                unitsize: 1,
                sample_count: 100_200,
                captured_at: Utc::now(),
                labels: (0..4).map(|channel| format!("D{channel}")).collect(),
                trigger: None,
            },
            channels: vec![
                SparseDigitalChannel {
                    channel: 0,
                    initial_high: false,
                    transitions: Vec::new(),
                },
                SparseDigitalChannel {
                    channel: 1,
                    initial_high: false,
                    transitions: Vec::new(),
                },
                SparseDigitalChannel {
                    channel: 2,
                    initial_high: false,
                    transitions: clock_edges,
                },
                SparseDigitalChannel {
                    channel: 3,
                    initial_high: true,
                    transitions: Vec::new(),
                },
            ],
        };
        let settings = AnalyzerDecodeSettings::Spi(SpiDecodeSettings {
            mosi_channel: Some(0),
            miso_channel: Some(1),
            clock_channel: 2,
            enable_channel: None,
            ..SpiDecodeSettings::default()
        });
        let view = WaveformRequest {
            start_sample: 50_000,
            sample_count: 1_000,
            pixels: 600,
            channels: Vec::new(),
        };
        let logical_window =
            sparse_native_analysis_windows(&sparse_capture_view(&capture), &settings, &view)
                .unwrap()
                .into_iter()
                .next()
                .unwrap();
        let decode_window = native_decode_window_for_cache(
            &sparse_capture_view(&capture),
            &settings,
            logical_window.0,
            logical_window.1,
        )
        .unwrap();

        assert!(decode_window.0 < logical_window.0);
        assert!(decode_window.1 > logical_window.1);
        assert!(decode_window.1 - decode_window.0 > logical_window.1 - logical_window.0);
    }

    #[test]
    fn native_view_decode_reuses_single_window_cache_without_sidecar() {
        let capture = SparseCaptureData {
            metadata: CaptureMetadata {
                version: 1,
                source_device: "single-window-cache-test".to_string(),
                sample_rate_hz: 10_000_000,
                channel_count: 4,
                enabled_channels: (0..4).collect(),
                unitsize: 1,
                sample_count: 20_000,
                captured_at: Utc::now(),
                labels: (0..4).map(|channel| format!("D{channel}")).collect(),
                trigger: None,
            },
            channels: vec![
                SparseDigitalChannel {
                    channel: 0,
                    initial_high: false,
                    transitions: Vec::new(),
                },
                SparseDigitalChannel {
                    channel: 1,
                    initial_high: false,
                    transitions: Vec::new(),
                },
                SparseDigitalChannel {
                    channel: 2,
                    initial_high: false,
                    transitions: vec![1_000, 1_100, 1_200, 1_300],
                },
                SparseDigitalChannel {
                    channel: 3,
                    initial_high: true,
                    transitions: Vec::new(),
                },
            ],
        };
        let settings = AnalyzerDecodeSettings::Spi(SpiDecodeSettings {
            mosi_channel: Some(0),
            miso_channel: Some(1),
            clock_channel: 2,
            enable_channel: None,
            ..SpiDecodeSettings::default()
        });
        let view = WaveformRequest {
            start_sample: 950,
            sample_count: 500,
            pixels: 600,
            channels: Vec::new(),
        };
        let windows =
            sparse_native_analysis_windows(&sparse_capture_view(&capture), &settings, &view)
                .unwrap();
        assert_eq!(windows.len(), 1);

        let session = GraphSession::default();
        let (window_start, window_end) = windows[0];
        let sample_count = capture.metadata.sample_count;
        session.replace_sparse_capture(capture).unwrap();
        let mut cached_frame = decoded_frame_for_graph_test(window_start + 8, window_start + 8);
        cached_frame.label = "cached-window-frame".to_string();
        cached_frame.channel_values[0].channel = 0;
        cached_frame.channel_values[0].role = "MOSI".to_string();
        let cached_frames = Arc::new(vec![cached_frame]);
        let cached_start = window_start.saturating_sub(16);
        let cached_end = window_end.saturating_add(16);
        let analyzer_key =
            native_full_analyzer_cache_key(DecoderBackendKind::SaleaeNative, &settings).unwrap();
        session.native_window_cache.lock().insert(
            NativeWindowCacheKey {
                analyzer_key,
                start_sample: cached_start,
                end_sample: cached_end,
            },
            NativeWindowCacheEntry {
                decoded_sample_count: sample_count,
                start_sample: cached_start,
                end_sample: cached_end,
                frames: cached_frames.clone(),
            },
        );

        let frames = session
            .decode_frames_with_backend_for_view(&settings, DecoderBackendKind::SaleaeNative, &view)
            .unwrap();

        assert_eq!(frames.len(), 1);
        assert!(Arc::ptr_eq(&frames, &cached_frames));
        assert_eq!(frames[0].label, "cached-window-frame");
        assert_eq!(frames[0].start_sample, window_start + 8);
        assert_eq!(frames[0].frame_id, window_start + 8);
    }

    #[test]
    fn native_background_seed_merges_visible_window_frames() {
        let session = GraphSession::default();
        let analyzer_key = "saleae-spi";
        let sample_count = 20_000;
        let early = decoded_frame_for_graph_test(11, 1_000);
        let late = decoded_frame_for_graph_test(12, 4_000);
        let mut cache = session.native_window_cache.lock();
        cache.insert(
            NativeWindowCacheKey {
                analyzer_key: analyzer_key.to_string(),
                start_sample: 3_500,
                end_sample: 4_500,
            },
            NativeWindowCacheEntry {
                decoded_sample_count: sample_count,
                start_sample: 3_500,
                end_sample: 4_500,
                frames: Arc::new(vec![late.clone()]),
            },
        );
        cache.insert(
            NativeWindowCacheKey {
                analyzer_key: analyzer_key.to_string(),
                start_sample: 500,
                end_sample: 4_500,
            },
            NativeWindowCacheEntry {
                decoded_sample_count: sample_count,
                start_sample: 500,
                end_sample: 4_500,
                frames: Arc::new(vec![early.clone(), late]),
            },
        );
        drop(cache);

        let frames = session.cached_native_analyzer_frames(analyzer_key, sample_count);

        assert_eq!(frames.len(), 2);
        assert_eq!(frames[0].start_sample, early.start_sample);
        assert_eq!(frames[1].start_sample, 4_000);
        assert_eq!(frames[0].frame_id, early.start_sample);
        assert_eq!(frames[1].frame_id, 4_000);
        assert!(session
            .cached_native_analyzer_frames(analyzer_key, sample_count + 1)
            .is_empty());
    }

    #[test]
    fn saleae_batch_finalize_reuses_single_decoded_window_arc() {
        let capture = SparseCaptureData {
            metadata: CaptureMetadata {
                version: 1,
                source_device: "single-window-finalize-test".to_string(),
                sample_rate_hz: 10_000_000,
                channel_count: 4,
                enabled_channels: (0..4).collect(),
                unitsize: 1,
                sample_count: 20_000,
                captured_at: Utc::now(),
                labels: (0..4).map(|channel| format!("D{channel}")).collect(),
                trigger: None,
            },
            channels: vec![
                SparseDigitalChannel {
                    channel: 0,
                    initial_high: false,
                    transitions: Vec::new(),
                },
                SparseDigitalChannel {
                    channel: 1,
                    initial_high: false,
                    transitions: Vec::new(),
                },
                SparseDigitalChannel {
                    channel: 2,
                    initial_high: false,
                    transitions: vec![1_000, 1_100, 1_200, 1_300],
                },
                SparseDigitalChannel {
                    channel: 3,
                    initial_high: true,
                    transitions: Vec::new(),
                },
            ],
        };
        let settings = AnalyzerDecodeSettings::Spi(SpiDecodeSettings {
            mosi_channel: Some(0),
            miso_channel: Some(1),
            clock_channel: 2,
            enable_channel: None,
            ..SpiDecodeSettings::default()
        });
        let request = AnalyzerRenderRequest {
            analyzer_id: "spi".to_string(),
            backend: DecoderBackendKind::SaleaeNative,
            settings: settings.clone(),
            tracks: Vec::new(),
        };
        let waveform = WaveformRequest {
            start_sample: 950,
            sample_count: 500,
            pixels: 600,
            channels: Vec::new(),
        };
        let decoded_frames = Arc::new(vec![decoded_frame_for_graph_test(1_000, 1_000)]);
        let state = SaleaeBatchRenderState {
            request_index: 0,
            request: &request,
            full_cache_key: native_full_analyzer_cache_key(
                DecoderBackendKind::SaleaeNative,
                &settings,
            )
            .unwrap(),
            window_cache_key: "window-cache-key".to_string(),
            windows: vec![(950, 1_450)],
            missing_windows: vec![(950, 1_450)],
            frames: Vec::new(),
            window_entries: vec![NativeWindowCacheEntry {
                decoded_sample_count: capture.metadata.sample_count,
                start_sample: 950,
                end_sample: 1_450,
                frames: decoded_frames.clone(),
            }],
        };

        let finalized = finalize_saleae_batch_render_state(
            state,
            &waveform,
            &sparse_capture_view(&capture),
            capture.metadata.sample_count,
        )
        .unwrap();

        assert!(Arc::ptr_eq(
            &finalized.window_cache_entry.frames,
            &decoded_frames
        ));
    }

    #[test]
    fn sparse_slice_preserves_level_and_offsets_transitions() {
        let capture = SparseCaptureData {
            metadata: CaptureMetadata {
                version: 1,
                source_device: "sparse-slice-test".to_string(),
                sample_rate_hz: 1_000_000,
                channel_count: 1,
                enabled_channels: vec![0],
                unitsize: 1,
                sample_count: 1_000,
                captured_at: Utc::now(),
                labels: vec!["D0".to_string()],
                trigger: None,
            },
            channels: vec![SparseDigitalChannel {
                channel: 0,
                initial_high: false,
                transitions: vec![100, 200, 300, 400],
            }],
        };

        let slice = slice_sparse_capture(&capture, 150, 350).unwrap();
        assert!(slice.channels[0].initial_high);
        assert_eq!(slice.channels[0].transitions, vec![50, 150]);
        assert_eq!(slice.metadata.sample_count, 200);
    }

    #[test]
    #[ignore = "requires SIGPILOT_SALEAE_SIDECAR and SIGPILOT_SALEAE_RUNTIME_ROOT"]
    fn saleae_spi_decodes_through_graph_session() {
        let capture = demo_capture(16, 250_000);
        let sample_count = capture.metadata.sample_count;
        let session = GraphSession::default();
        session.finish_capture(capture).unwrap();
        let settings = AnalyzerDecodeSettings::Spi(SpiDecodeSettings {
            mosi_channel: Some(3),
            miso_channel: Some(4),
            clock_channel: 5,
            enable_channel: Some(6),
            ..SpiDecodeSettings::default()
        });
        let frames = session
            .decode_frames_with_backend_for_view(
                &settings,
                DecoderBackendKind::SaleaeNative,
                &WaveformRequest {
                    start_sample: 0,
                    sample_count,
                    pixels: 1_200,
                    channels: Vec::new(),
                },
            )
            .unwrap();
        assert!(!frames.is_empty());
        let zoomed_frames = session
            .decode_frames_with_backend_for_view(
                &settings,
                DecoderBackendKind::SaleaeNative,
                &WaveformRequest {
                    start_sample: sample_count / 4,
                    sample_count: sample_count / 8,
                    pixels: 1_200,
                    channels: Vec::new(),
                },
            )
            .unwrap();
        assert!(std::sync::Arc::ptr_eq(&frames, &zoomed_frames));
        assert!(frames.iter().any(|frame| {
            frame
                .channel_values
                .iter()
                .any(|value| value.role == "MOSI")
        }));
        let track = render_analyzer_track(
            &frames,
            &AnalyzerTrackRequest {
                channel: 3,
                role: "MOSI".to_string(),
            },
            &WaveformRequest {
                start_sample: 0,
                sample_count,
                pixels: 1_200,
                channels: Vec::new(),
            },
        );
        assert!(!track.bubbles.is_empty());
    }

    #[test]
    #[ignore = "requires SIGPILOT_SALEAE_SIDECAR and SIGPILOT_SALEAE_RUNTIME_ROOT"]
    fn saleae_full_decode_batch_populates_shared_analyzer_cache() {
        let capture = demo_capture(16, 250_000);
        let session = GraphSession::default();
        session.finish_capture(capture).unwrap();
        let i2c = AnalyzerDecodeSettings::I2c(I2cDecodeSettings {
            sda_channel: 1,
            scl_channel: 2,
        });
        let spi = AnalyzerDecodeSettings::Spi(SpiDecodeSettings {
            mosi_channel: Some(3),
            miso_channel: Some(4),
            clock_channel: 5,
            enable_channel: Some(6),
            ..SpiDecodeSettings::default()
        });

        let frames = session
            .decode_saleae_native_frames_batch(&[i2c.clone(), spi.clone()])
            .unwrap();

        assert_eq!(frames.len(), 2);
        assert!(frames.iter().all(|frames| !frames.is_empty()));

        let cached_i2c = session
            .decode_frames_with_backend(&i2c, DecoderBackendKind::SaleaeNative)
            .unwrap();
        let cached_spi = session
            .decode_frames_with_backend(&spi, DecoderBackendKind::SaleaeNative)
            .unwrap();
        assert!(Arc::ptr_eq(&frames[0], &cached_i2c));
        assert!(Arc::ptr_eq(&frames[1], &cached_spi));
    }

    #[test]
    #[ignore = "requires SIGPILOT_SALEAE_SIDECAR and SIGPILOT_SALEAE_RUNTIME_ROOT"]
    fn saleae_async_background_decode_matches_one_shot_and_reports_monotonic_progress() {
        let capture = demo_capture(16, 2_500_000);
        let settings = vec![
            AnalyzerDecodeSettings::I2c(I2cDecodeSettings {
                sda_channel: 1,
                scl_channel: 2,
            }),
            AnalyzerDecodeSettings::Spi(SpiDecodeSettings {
                mosi_channel: Some(3),
                miso_channel: Some(4),
                clock_channel: 5,
                enable_channel: Some(6),
                ..SpiDecodeSettings::default()
            }),
        ];

        let expected_session = GraphSession::default();
        expected_session.finish_capture(capture.clone()).unwrap();
        let expected = expected_session
            .decode_saleae_native_frames_batch(&settings)
            .unwrap();

        let session = GraphSession::default();
        session.finish_capture(capture).unwrap();
        let deadline = Instant::now() + Duration::from_secs(30);
        let mut previous_processed_edges = vec![0usize; settings.len()];
        let mut saw_partial_frames = false;
        let completed = loop {
            let progress = session
                .decode_saleae_native_background_step_batch(&settings)
                .unwrap();
            assert_eq!(progress.len(), settings.len());
            for (index, item) in progress.iter().enumerate() {
                assert!(item.processed_edges >= previous_processed_edges[index]);
                assert!((0.0..=1.0).contains(&item.progress));
                saw_partial_frames |= !item.complete && item.frame_count > 0;
                previous_processed_edges[index] = item.processed_edges;
            }
            if progress.iter().all(|item| item.complete) {
                break progress;
            }
            assert!(Instant::now() < deadline, "async Saleae decode timed out");
            std::thread::sleep(Duration::from_millis(2));
        };

        assert!(completed
            .iter()
            .all(|item| item.progress == 1.0 && !item.cancelled));
        assert!(
            saw_partial_frames,
            "async Saleae decode should publish frames before completion"
        );
        let actual = session
            .decode_saleae_native_frames_batch(&settings)
            .unwrap();
        assert_eq!(actual.len(), expected.len());
        for (actual_frames, expected_frames) in actual.iter().zip(expected.iter()) {
            assert_eq!(actual_frames.as_ref(), expected_frames.as_ref());
        }
    }

    #[test]
    #[ignore = "requires SIGPILOT_SALEAE_SIDECAR and SIGPILOT_SALEAE_RUNTIME_ROOT"]
    fn saleae_i2c_and_spi_decode_in_parallel_through_shared_edge_index() {
        let capture = demo_capture(16, 2_500_000);
        let sample_count = capture.metadata.sample_count;
        let session = GraphSession::default();
        session.finish_capture(capture).unwrap();
        let response = session
            .render_frame(&GraphFrameRequest {
                frame_id: 1,
                waveform: WaveformRequest {
                    start_sample: 0,
                    sample_count,
                    pixels: 1_200,
                    channels: vec![1, 2, 3, 4, 5, 6],
                },
                include_tile: true,
                analyzer_view: None,
                view: None,
                analyzers: vec![
                    AnalyzerRenderRequest {
                        analyzer_id: "i2c".to_string(),
                        backend: DecoderBackendKind::SaleaeNative,
                        settings: AnalyzerDecodeSettings::I2c(I2cDecodeSettings {
                            sda_channel: 1,
                            scl_channel: 2,
                        }),
                        tracks: vec![AnalyzerTrackRequest {
                            channel: 1,
                            role: "SDA".to_string(),
                        }],
                    },
                    AnalyzerRenderRequest {
                        analyzer_id: "spi".to_string(),
                        backend: DecoderBackendKind::SaleaeNative,
                        settings: AnalyzerDecodeSettings::Spi(SpiDecodeSettings {
                            mosi_channel: Some(3),
                            miso_channel: Some(4),
                            clock_channel: 5,
                            enable_channel: Some(6),
                            ..SpiDecodeSettings::default()
                        }),
                        tracks: vec![AnalyzerTrackRequest {
                            channel: 3,
                            role: "MOSI".to_string(),
                        }],
                    },
                ],
            })
            .unwrap();
        assert_eq!(response.analyzers.len(), 2);
        assert!(response.analyzers.iter().all(|analyzer| analyzer
            .tracks
            .iter()
            .any(|track| !track.bubbles.is_empty())));
    }

    #[test]
    #[ignore = "requires a GraphServer manifest and both native analyzer sidecars"]
    fn imported_saleae_capture_restores_native_bubbles_and_table_frames() {
        let manifest = sigpilot_core::product_env("SIGPILOT_SALEAE_MANIFEST")
            .map(std::path::PathBuf::from)
            .expect("SIGPILOT_SALEAE_MANIFEST");
        let imported = sigpilot_file::open_saleae_transition_session(manifest).unwrap();
        let analyzer = imported
            .session
            .analyzers
            .iter()
            .find(|analyzer| analyzer.analyzer_type == "SPI")
            .unwrap();
        let settings = analyzer.decode_settings.clone().unwrap();
        let sample_count = imported.capture.metadata.sample_count;
        let clock_transitions = &imported
            .capture
            .channels
            .iter()
            .find(|channel| channel.channel == 3)
            .unwrap()
            .transitions;
        let first_data_sample = *clock_transitions.first().unwrap();
        let last_data_sample = *clock_transitions.last().unwrap();
        let data_span = last_data_sample - first_data_sample;
        let session = GraphSession::default();
        session.replace_sparse_capture(imported.capture).unwrap();
        let view = WaveformRequest {
            start_sample: 0,
            sample_count,
            pixels: 1_200,
            channels: Vec::new(),
        };

        for backend in [
            DecoderBackendKind::SaleaeNative,
            DecoderBackendKind::SigrokNative,
        ] {
            let table_frames = session
                .decode_frames_with_backend_for_view(&settings, backend, &view)
                .unwrap();
            assert!(!table_frames.is_empty(), "backend={backend:?} table");
            assert!(table_frames.iter().any(|frame| {
                frame
                    .channel_values
                    .iter()
                    .any(|value| value.role == "MOSI")
                    && frame
                        .channel_values
                        .iter()
                        .any(|value| value.role == "MISO")
            }));
            assert!(table_frames
                .iter()
                .all(
                    |frame| frame.channel_values.iter().all(|value| value.value <= 0xff
                        && value.label.len() == 4
                        && value.label.starts_with("0x"))
                ));
            if backend == DecoderBackendKind::SaleaeNative {
                assert!(table_frames
                    .iter()
                    .any(|frame| frame.label == "Error" && frame.channel_values.is_empty()));
            }
            let result = session
                .render_analyzer(
                    &AnalyzerRenderRequest {
                        analyzer_id: format!("{backend:?}"),
                        backend,
                        settings: settings.clone(),
                        tracks: vec![
                            AnalyzerTrackRequest {
                                channel: 5,
                                role: "MOSI".to_string(),
                            },
                            AnalyzerTrackRequest {
                                channel: 0,
                                role: "MISO".to_string(),
                            },
                        ],
                    },
                    &view,
                )
                .unwrap();
            let bubbles = result
                .tracks
                .iter()
                .flat_map(|track| &track.bubbles)
                .collect::<Vec<_>>();
            assert!(!bubbles.is_empty(), "backend={backend:?}");
            assert!(bubbles.iter().all(|bubble| bubble
                .display_text
                .iter()
                .all(|text| text.len() == 4 && text.starts_with("0x"))));
            assert!(
                bubbles
                    .iter()
                    .any(|bubble| bubble.start_sample < first_data_sample + data_span / 10),
                "backend={backend:?} has no bubbles near the first protocol data"
            );
            assert!(
                bubbles
                    .iter()
                    .any(|bubble| bubble.end_sample > last_data_sample - data_span / 10),
                "backend={backend:?} has no bubbles near the last protocol data"
            );
        }
    }

    #[test]
    fn indexed_viewport_requests_have_a_fixed_pixel_budget() {
        let capture = demo_capture(32, 2_000_000);
        let graph = DigitalGraph::from_capture(&capture).unwrap();
        let request = WaveformRequest {
            start_sample: 250_000,
            sample_count: 1_500_000,
            pixels: 1_800,
            channels: (0..32).collect(),
        };
        let started = Instant::now();
        for _ in 0..20 {
            let tile = graph.build_tile(&request).unwrap();
            assert_eq!(tile.channels.len(), 32);
            assert!(tile.channels.iter().all(|channel| channel.bins.is_empty()
                && channel
                    .packed_bins
                    .as_deref()
                    .is_some_and(|data| !data.is_empty())));
        }
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn dense_exact_view_switches_to_pixel_primitives() {
        let sample_count = 4_096u64;
        let metadata = CaptureMetadata {
            version: 1,
            source_device: "dense-render-test".to_string(),
            sample_rate_hz: 100_000_000,
            channel_count: 1,
            enabled_channels: vec![0],
            unitsize: 1,
            sample_count,
            captured_at: Utc::now(),
            labels: vec!["D0".to_string()],
            trigger: None,
        };
        let dense = CaptureData {
            metadata: metadata.clone(),
            samples: (0..sample_count)
                .map(|sample| u8::from(sample % 2 != 0))
                .collect(),
        };
        let sparse = CaptureData {
            metadata,
            samples: (0..sample_count)
                .map(|sample| u8::from(sample >= sample_count / 2))
                .collect(),
        };
        let request = WaveformRequest {
            start_sample: 0,
            sample_count,
            pixels: 1_024,
            channels: vec![0],
        };

        let dense_tile = DigitalGraph::from_capture(&dense)
            .unwrap()
            .build_tile(&request)
            .unwrap();
        assert!(dense_tile.channels[0].segments.is_empty());
        assert!(dense_tile.channels[0].packed_bins.is_some());

        let sparse_tile = DigitalGraph::from_capture(&sparse)
            .unwrap()
            .build_tile(&request)
            .unwrap();
        assert_eq!(sparse_tile.channels[0].segments.len(), 2);
    }

    #[test]
    fn i2c_start_and_stop_frames_render_as_sda_protocol_markers() {
        let frame = |frame_id, sample, frame_type: &str, channel_values| DecodedFrame {
            frame_id,
            start_sample: sample,
            end_sample: sample + 1,
            frame_type: frame_type.to_string(),
            label: frame_type.to_string(),
            value: 0,
            channel_values,
            protocol_markers: Vec::new(),
        };
        let frames = vec![
            frame(0, 100, "start", Vec::new()),
            frame(
                1,
                120,
                "address",
                vec![DecodedChannelValue {
                    channel: 2,
                    role: "SDA".to_string(),
                    label: "W[0x20]".to_string(),
                    texts: vec!["W[0x20]".to_string()],
                    value: 0x20,
                }],
            ),
            frame(2, 300, "stop", Vec::new()),
        ];
        let track = render_analyzer_track(
            &frames,
            &AnalyzerTrackRequest {
                channel: 2,
                role: "SDA".to_string(),
            },
            &WaveformRequest {
                start_sample: 0,
                sample_count: 400,
                pixels: 800,
                channels: vec![2],
            },
        );

        assert_eq!(
            track.protocol_markers,
            vec![
                AnalyzerProtocolMarker {
                    sample: 100,
                    kind: AnalyzerProtocolMarkerKind::Start,
                },
                AnalyzerProtocolMarker {
                    sample: 300,
                    kind: AnalyzerProtocolMarkerKind::Stop,
                },
            ]
        );
        assert_eq!(track.bubbles.len(), 1);
    }

    #[test]
    fn dense_protocol_markers_are_bounded_and_preserve_endpoints() {
        let frames = vec![DecodedFrame {
            frame_id: 0,
            start_sample: 0,
            end_sample: 2_000,
            frame_type: "marker".to_string(),
            label: "marker".to_string(),
            value: 0,
            channel_values: Vec::new(),
            protocol_markers: (1..=1_000)
                .map(|sample| sigpilot_core::DecodedProtocolMarker {
                    channel: Some(0),
                    sample,
                    kind: "dot".to_string(),
                })
                .collect(),
        }];
        let markers = protocol_markers_for_track(
            &frames,
            &AnalyzerTrackRequest {
                channel: 0,
                role: "Data".to_string(),
            },
            0,
            1,
        );
        assert_eq!(markers.len(), MAX_ANALYZER_MARKER_RESULTS);
        assert_eq!(markers.first().unwrap().sample, 1);
        assert_eq!(markers.last().unwrap().sample, 1_000);
    }

    #[test]
    fn unordered_protocol_markers_are_sorted_and_deduplicated_for_track_rendering() {
        let frames = vec![DecodedFrame {
            frame_id: 0,
            start_sample: 0,
            end_sample: 100,
            frame_type: "marker".to_string(),
            label: "marker".to_string(),
            value: 0,
            channel_values: Vec::new(),
            protocol_markers: vec![
                sigpilot_core::DecodedProtocolMarker {
                    channel: Some(0),
                    sample: 80,
                    kind: "stop".to_string(),
                },
                sigpilot_core::DecodedProtocolMarker {
                    channel: Some(0),
                    sample: 10,
                    kind: "start".to_string(),
                },
                sigpilot_core::DecodedProtocolMarker {
                    channel: Some(0),
                    sample: 10,
                    kind: "start".to_string(),
                },
                sigpilot_core::DecodedProtocolMarker {
                    channel: Some(0),
                    sample: 50,
                    kind: "dot".to_string(),
                },
            ],
        }];
        let markers = protocol_markers_for_track(
            &frames,
            &AnalyzerTrackRequest {
                channel: 0,
                role: "Data".to_string(),
            },
            0,
            1,
        );

        assert_eq!(
            markers
                .iter()
                .map(|marker| (marker.sample, marker.kind))
                .collect::<Vec<_>>(),
            vec![
                (10, AnalyzerProtocolMarkerKind::Start),
                (50, AnalyzerProtocolMarkerKind::Dot),
                (80, AnalyzerProtocolMarkerKind::Stop),
            ]
        );
    }

    #[test]
    fn native_analyzer_markers_render_on_their_reported_channel() {
        let frames = vec![DecodedFrame {
            frame_id: 0,
            start_sample: 100,
            end_sample: 200,
            frame_type: "data".to_string(),
            label: "0x12".to_string(),
            value: 0x12,
            channel_values: vec![DecodedChannelValue {
                channel: 1,
                role: "DATA".to_string(),
                label: "0x12".to_string(),
                texts: vec!["0x12".to_string()],
                value: 0x12,
            }],
            protocol_markers: vec![sigpilot_core::DecodedProtocolMarker {
                channel: Some(0),
                sample: 150,
                kind: "up_arrow".to_string(),
            }],
        }];
        let track = render_analyzer_track(
            &frames,
            &AnalyzerTrackRequest {
                channel: 0,
                role: "Clock".to_string(),
            },
            &WaveformRequest {
                start_sample: 0,
                sample_count: 400,
                pixels: 800,
                channels: vec![0],
            },
        );

        assert_eq!(
            track.protocol_markers,
            vec![AnalyzerProtocolMarker {
                sample: 150,
                kind: AnalyzerProtocolMarkerKind::UpArrow,
            }]
        );
        assert!(track.bubbles.is_empty());
    }

    #[test]
    fn rendered_track_windows_send_lightweight_frame_refs() {
        let frames = vec![DecodedFrame {
            frame_id: 0,
            start_sample: 100,
            end_sample: 200,
            frame_type: "data".to_string(),
            label: "0x12".to_string(),
            value: 0x12,
            channel_values: vec![DecodedChannelValue {
                channel: 1,
                role: "DATA".to_string(),
                label: "0x12".to_string(),
                texts: vec!["0x12".to_string()],
                value: 0x12,
            }],
            protocol_markers: vec![sigpilot_core::DecodedProtocolMarker {
                channel: Some(1),
                sample: 150,
                kind: "dot".to_string(),
            }],
        }];
        let track = render_analyzer_track(
            &frames,
            &AnalyzerTrackRequest {
                channel: 1,
                role: "DATA".to_string(),
            },
            &WaveformRequest {
                start_sample: 0,
                sample_count: 400,
                pixels: 800,
                channels: vec![1],
            },
        );

        assert_eq!(
            track.protocol_markers,
            vec![AnalyzerProtocolMarker {
                sample: 150,
                kind: AnalyzerProtocolMarkerKind::Dot,
            }]
        );
        assert_eq!(
            track.frame_refs,
            vec![AnalyzerFrameRef {
                frame_id: 0,
                start_sample: 100,
                end_sample: 200,
            }]
        );
        assert!(track.frames.is_empty());
        assert!(track.previous_frame.is_none());
        assert!(track.next_frame.is_none());
    }

    #[test]
    fn indexed_track_render_uses_cached_channel_value_matches() {
        let frames = vec![DecodedFrame {
            frame_id: 7,
            start_sample: 100,
            end_sample: 120,
            frame_type: "data".to_string(),
            label: "combined".to_string(),
            value: 0,
            channel_values: vec![
                DecodedChannelValue {
                    channel: 0,
                    role: "MOSI".to_string(),
                    label: "MOSI 0x12".to_string(),
                    texts: vec!["MOSI 0x12".to_string()],
                    value: 0x12,
                },
                DecodedChannelValue {
                    channel: 0,
                    role: "MISO".to_string(),
                    label: "MISO 0x34".to_string(),
                    texts: vec!["MISO 0x34".to_string()],
                    value: 0x34,
                },
            ],
            protocol_markers: Vec::new(),
        }];
        let tracks = vec![
            AnalyzerTrackRequest {
                channel: 0,
                role: "MISO".to_string(),
            },
            AnalyzerTrackRequest {
                channel: 0,
                role: "DATA".to_string(),
            },
        ];

        let windows = render_analyzer_tracks(
            &frames,
            &tracks,
            &WaveformRequest {
                start_sample: 0,
                sample_count: 500,
                pixels: 800,
                channels: vec![0],
            },
        )
        .unwrap();

        assert_eq!(windows.len(), 2);
        assert_eq!(windows[0].bubbles[0].display_text, vec!["MISO 0x34"]);
        assert_eq!(windows[1].bubbles[0].display_text, vec!["MOSI 0x12"]);
        assert_eq!(windows[0].frame_refs[0].frame_id, 7);
        assert_eq!(windows[1].frame_refs[0].frame_id, 7);
    }

    #[test]
    fn native_window_offset_moves_protocol_markers_with_frames() {
        let frame = DecodedFrame {
            frame_id: 4,
            start_sample: 10,
            end_sample: 20,
            frame_type: "data".to_string(),
            label: "0x12".to_string(),
            value: 0x12,
            channel_values: vec![DecodedChannelValue {
                channel: 1,
                role: "DATA".to_string(),
                label: "0x12".to_string(),
                texts: vec!["0x12".to_string()],
                value: 0x12,
            }],
            protocol_markers: vec![sigpilot_core::DecodedProtocolMarker {
                channel: Some(0),
                sample: 15,
                kind: "up_arrow".to_string(),
            }],
        };

        let mut shifted = frame;
        offset_decoded_frame_samples(&mut shifted, 1_000);

        assert_eq!(shifted.start_sample, 1_010);
        assert_eq!(shifted.end_sample, 1_020);
        assert_eq!(shifted.protocol_markers[0].sample, 1_015);
    }

    #[test]
    fn parallel_analyzer_render_preserves_request_order() {
        let capture = demo_capture(16, 500_000);
        let session = GraphSession::default();
        session.replace_capture(capture).unwrap();
        let view = WaveformRequest {
            start_sample: 0,
            sample_count: 500_000,
            pixels: 1_200,
            channels: vec![0, 1, 3, 4],
        };
        let requests = vec![
            AnalyzerRenderRequest {
                analyzer_id: "uart-first".to_string(),
                backend: DecoderBackendKind::LegacyRust,
                settings: AnalyzerDecodeSettings::Uart(UartDecodeSettings::default()),
                tracks: vec![AnalyzerTrackRequest {
                    channel: 0,
                    role: "RX".to_string(),
                }],
            },
            AnalyzerRenderRequest {
                analyzer_id: "i2c-second".to_string(),
                backend: DecoderBackendKind::LegacyRust,
                settings: AnalyzerDecodeSettings::I2c(I2cDecodeSettings::default()),
                tracks: vec![AnalyzerTrackRequest {
                    channel: 1,
                    role: "SDA".to_string(),
                }],
            },
            AnalyzerRenderRequest {
                analyzer_id: "spi-third".to_string(),
                backend: DecoderBackendKind::LegacyRust,
                settings: AnalyzerDecodeSettings::Spi(SpiDecodeSettings::default()),
                tracks: vec![AnalyzerTrackRequest {
                    channel: 3,
                    role: "MOSI".to_string(),
                }],
            },
        ];

        let rendered = session.render_analyzers(&requests, &view).unwrap();

        assert_eq!(
            rendered
                .iter()
                .map(|result| result.analyzer_id.as_str())
                .collect::<Vec<_>>(),
            vec!["uart-first", "i2c-second", "spi-third"]
        );
    }

    #[test]
    fn i2c_and_spi_render_on_their_assigned_role_tracks() {
        let capture = demo_capture(16, 500_000);
        let session = GraphSession::default();
        session.replace_capture(capture).unwrap();
        let view = WaveformRequest {
            start_sample: 0,
            sample_count: 500_000,
            pixels: 1_200,
            channels: vec![1, 3, 4],
        };
        for request in [
            AnalyzerRenderRequest {
                analyzer_id: "i2c".to_string(),
                backend: DecoderBackendKind::LegacyRust,
                settings: AnalyzerDecodeSettings::I2c(I2cDecodeSettings::default()),
                tracks: vec![AnalyzerTrackRequest {
                    channel: 1,
                    role: "SDA".to_string(),
                }],
            },
            AnalyzerRenderRequest {
                analyzer_id: "spi".to_string(),
                backend: DecoderBackendKind::LegacyRust,
                settings: AnalyzerDecodeSettings::Spi(SpiDecodeSettings::default()),
                tracks: vec![
                    AnalyzerTrackRequest {
                        channel: 3,
                        role: "MOSI".to_string(),
                    },
                    AnalyzerTrackRequest {
                        channel: 4,
                        role: "MISO".to_string(),
                    },
                ],
            },
        ] {
            let result = session.render_analyzer(&request, &view).unwrap();
            assert_eq!(result.tracks.len(), request.tracks.len());
            for (track, expected) in result.tracks.iter().zip(&request.tracks) {
                assert_eq!(track.channel, expected.channel);
                assert_eq!(track.role, expected.role);
                assert!(!track.bubbles.is_empty(), "track={expected:?}");
            }
        }
    }

    #[test]
    fn indexed_analyzer_track_render_preserves_sparse_previous_next_frames() {
        let frames = [
            (0, 0, 0, "A"),
            (1, 10, 1, "B"),
            (2, 20, 0, "A"),
            (3, 30, 1, "B"),
            (4, 40, 0, "A"),
        ]
        .into_iter()
        .map(|(frame_id, start_sample, channel, role)| DecodedFrame {
            frame_id,
            start_sample,
            end_sample: start_sample + 2,
            frame_type: "data".to_string(),
            label: format!("{role}{frame_id}"),
            value: frame_id,
            channel_values: vec![DecodedChannelValue {
                channel,
                role: role.to_string(),
                label: format!("{role}{frame_id}"),
                texts: vec![format!("{role}{frame_id}")],
                value: frame_id,
            }],
            protocol_markers: Vec::new(),
        })
        .collect::<Vec<_>>();
        let tracks = vec![
            AnalyzerTrackRequest {
                channel: 0,
                role: "A".to_string(),
            },
            AnalyzerTrackRequest {
                channel: 1,
                role: "B".to_string(),
            },
        ];

        let windows = render_analyzer_tracks(
            &frames,
            &tracks,
            &WaveformRequest {
                start_sample: 23,
                sample_count: 5,
                pixels: 800,
                channels: Vec::new(),
            },
        )
        .unwrap();

        assert_eq!(windows.len(), 2);
        assert!(windows[0].frames.is_empty());
        assert_eq!(
            windows[0]
                .previous_frame_ref
                .as_ref()
                .map(|frame| frame.frame_id),
            Some(2)
        );
        assert_eq!(
            windows[0]
                .next_frame_ref
                .as_ref()
                .map(|frame| frame.frame_id),
            Some(4)
        );
        assert!(windows[1].frames.is_empty());
        assert_eq!(
            windows[1]
                .previous_frame_ref
                .as_ref()
                .map(|frame| frame.frame_id),
            Some(1)
        );
        assert_eq!(
            windows[1]
                .next_frame_ref
                .as_ref()
                .map(|frame| frame.frame_id),
            Some(3)
        );
    }

    #[test]
    fn indexed_analyzer_track_render_reuses_protocol_marker_index_by_channel() {
        let frames = vec![
            DecodedFrame {
                frame_id: 0,
                start_sample: 10,
                end_sample: 20,
                frame_type: "start".to_string(),
                label: "start".to_string(),
                value: 0,
                channel_values: Vec::new(),
                protocol_markers: Vec::new(),
            },
            DecodedFrame {
                frame_id: 1,
                start_sample: 30,
                end_sample: 40,
                frame_type: "data".to_string(),
                label: "data".to_string(),
                value: 0,
                channel_values: vec![DecodedChannelValue {
                    channel: 0,
                    role: "SDA".to_string(),
                    label: "0x11".to_string(),
                    texts: vec!["0x11".to_string()],
                    value: 0x11,
                }],
                protocol_markers: vec![
                    sigpilot_core::DecodedProtocolMarker {
                        channel: Some(1),
                        sample: 32,
                        kind: "up_arrow".to_string(),
                    },
                    sigpilot_core::DecodedProtocolMarker {
                        channel: Some(2),
                        sample: 33,
                        kind: "dot".to_string(),
                    },
                ],
            },
            DecodedFrame {
                frame_id: 2,
                start_sample: 50,
                end_sample: 60,
                frame_type: "stop".to_string(),
                label: "stop".to_string(),
                value: 0,
                channel_values: Vec::new(),
                protocol_markers: Vec::new(),
            },
        ];
        let tracks = vec![
            AnalyzerTrackRequest {
                channel: 0,
                role: "SDA".to_string(),
            },
            AnalyzerTrackRequest {
                channel: 1,
                role: "SCK".to_string(),
            },
            AnalyzerTrackRequest {
                channel: 2,
                role: "SWDIO".to_string(),
            },
        ];

        let windows = render_analyzer_tracks(
            &frames,
            &tracks,
            &WaveformRequest {
                start_sample: 0,
                sample_count: 100,
                pixels: 800,
                channels: Vec::new(),
            },
        )
        .unwrap();

        assert_eq!(
            windows[0]
                .protocol_markers
                .iter()
                .map(|marker| (marker.sample, marker.kind))
                .collect::<Vec<_>>(),
            vec![
                (10, AnalyzerProtocolMarkerKind::Start),
                (50, AnalyzerProtocolMarkerKind::Stop),
            ]
        );
        assert_eq!(
            windows[1]
                .protocol_markers
                .iter()
                .map(|marker| (marker.sample, marker.kind))
                .collect::<Vec<_>>(),
            vec![(32, AnalyzerProtocolMarkerKind::UpArrow)]
        );
        assert_eq!(
            windows[2]
                .protocol_markers
                .iter()
                .map(|marker| (marker.sample, marker.kind))
                .collect::<Vec<_>>(),
            vec![(33, AnalyzerProtocolMarkerKind::Dot)]
        );
    }

    #[test]
    fn analyzer_rendering_does_not_change_the_waveform_tile() {
        let capture = demo_capture(16, 250_000);
        let session = GraphSession::default();
        session.replace_capture(capture).unwrap();
        let waveform = WaveformRequest {
            start_sample: 25_000,
            sample_count: 100_000,
            pixels: 1_200,
            channels: (0..6).collect(),
        };
        let baseline = session
            .render_frame(&GraphFrameRequest {
                frame_id: 1,
                waveform: waveform.clone(),
                include_tile: true,
                analyzer_view: None,
                analyzers: Vec::new(),
                view: None,
            })
            .unwrap();
        let with_analyzers = session
            .render_frame(&GraphFrameRequest {
                frame_id: 2,
                waveform: waveform.clone(),
                include_tile: true,
                analyzer_view: Some(waveform),
                view: None,
                analyzers: vec![
                    AnalyzerRenderRequest {
                        analyzer_id: "i2c".to_string(),
                        backend: DecoderBackendKind::LegacyRust,
                        settings: AnalyzerDecodeSettings::I2c(I2cDecodeSettings::default()),
                        tracks: vec![AnalyzerTrackRequest {
                            channel: 1,
                            role: "SDA".to_string(),
                        }],
                    },
                    AnalyzerRenderRequest {
                        analyzer_id: "spi".to_string(),
                        backend: DecoderBackendKind::LegacyRust,
                        settings: AnalyzerDecodeSettings::Spi(SpiDecodeSettings::default()),
                        tracks: vec![AnalyzerTrackRequest {
                            channel: 3,
                            role: "MOSI".to_string(),
                        }],
                    },
                ],
            })
            .unwrap();

        assert_eq!(baseline.tile, with_analyzers.tile);
        assert_eq!(with_analyzers.analyzers.len(), 2);
    }

    #[test]
    fn analyzer_only_render_can_skip_waveform_tile() {
        let capture = demo_capture(16, 250_000);
        let session = GraphSession::default();
        session.replace_capture(capture).unwrap();

        let response = session
            .render_frame(&GraphFrameRequest {
                frame_id: 3,
                waveform: WaveformRequest {
                    start_sample: 10_000,
                    sample_count: 100_000,
                    pixels: 0,
                    channels: vec![255],
                },
                include_tile: false,
                analyzer_view: Some(WaveformRequest {
                    start_sample: 10_000,
                    sample_count: 100_000,
                    pixels: 1_200,
                    channels: Vec::new(),
                }),
                view: None,
                analyzers: vec![AnalyzerRenderRequest {
                    analyzer_id: "i2c".to_string(),
                    backend: DecoderBackendKind::LegacyRust,
                    settings: AnalyzerDecodeSettings::I2c(I2cDecodeSettings::default()),
                    tracks: vec![AnalyzerTrackRequest {
                        channel: 1,
                        role: "SDA".to_string(),
                    }],
                }],
            })
            .unwrap();

        assert_eq!(response.tile.sample_count, 0);
        assert!(response.tile.channels.is_empty());
        assert_eq!(response.analyzers.len(), 1);
    }

    #[test]
    fn a_view_intent_drives_the_rendered_range() {
        let session = GraphSession::default();
        session.replace_capture(demo_capture(16, 250_000)).unwrap();

        // A request without an intent keeps its explicit range, so callers that
        // have not migrated are unaffected.
        let explicit = session
            .render_frame(&GraphFrameRequest {
                frame_id: 1,
                waveform: WaveformRequest {
                    start_sample: 10_000,
                    sample_count: 20_000,
                    pixels: 200,
                    channels: vec![0],
                },
                include_tile: true,
                analyzer_view: None,
                analyzers: Vec::new(),
                view: None,
            })
            .unwrap();
        assert_eq!(explicit.tile.start_sample, 10_000);
        assert_eq!(explicit.tile.sample_count, 20_000);

        // A request carrying a gesture renders the session viewport instead and
        // ignores the range the caller sent.
        let from_intent = session
            .render_frame(&GraphFrameRequest {
                frame_id: 2,
                waveform: WaveformRequest {
                    start_sample: 0,
                    sample_count: 0,
                    pixels: 200,
                    channels: vec![0],
                },
                include_tile: true,
                analyzer_view: None,
                analyzers: Vec::new(),
                view: Some(ViewIntent::Set {
                    start_sample: 5_000.0,
                    samples: 1_000.0,
                }),
            })
            .unwrap();
        assert_eq!(from_intent.view.start_sample, 5_000.0);
        assert_eq!(from_intent.view.samples, 1_000.0);
        assert_eq!(from_intent.tile.start_sample, 5_000);
        assert_eq!(from_intent.tile.sample_count, 1_000);

        // A zoom is anchored inside the viewport the session already holds, and
        // the authoritative result comes back on the frame itself.
        let zoomed = session
            .render_frame(&GraphFrameRequest {
                frame_id: 3,
                waveform: WaveformRequest {
                    start_sample: 0,
                    sample_count: 0,
                    pixels: 200,
                    channels: vec![0],
                },
                include_tile: true,
                analyzer_view: None,
                analyzers: Vec::new(),
                view: Some(ViewIntent::Zoom {
                    factor: 0.5,
                    anchor_ratio: 0.5,
                    duration_ms: 0.0,
                }),
            })
            .unwrap();
        assert_eq!(zoomed.view.samples, 500.0);
        assert_eq!(zoomed.view.start_sample, 5_250.0);
        assert_eq!(zoomed.tile.start_sample, 5_250);
        assert_eq!(zoomed.tile.sample_count, 500);
    }

    #[test]
    fn a_zoom_with_a_duration_glides_instead_of_jumping() {
        let session = GraphSession::default();
        session.replace_capture(demo_capture(16, 250_000)).unwrap();
        session.set_session_view(5_000.0, 1_000.0);

        let request = |frame_id: u64, duration_ms: f64| GraphFrameRequest {
            frame_id,
            waveform: WaveformRequest {
                start_sample: 0,
                sample_count: 0,
                pixels: 200,
                channels: vec![0],
            },
            include_tile: true,
            analyzer_view: None,
            analyzers: Vec::new(),
            view: Some(ViewIntent::Zoom {
                factor: 0.5,
                anchor_ratio: 0.5,
                duration_ms,
            }),
        };

        // A discrete step — one wheel notch, one keypress — asks for a glide. The
        // frame reports where the view is *now*, so a glide leaves it near where it
        // started rather than at the target: the point is that it did not jump.
        let gliding = session.render_frame(&request(1, 100.0)).unwrap();
        assert!(
            gliding.view.samples > 900.0 && gliding.view.samples <= 1_000.0,
            "a glide should still be near the view it started from, got {}",
            gliding.view.samples
        );

        // Retargeting mid-flight must not snap back to where the first glide began,
        // so a second request keeps the view near the live position rather than
        // jumping to either endpoint.
        let retargeted = session.render_frame(&request(2, 100.0)).unwrap();
        assert!(
            retargeted.view.samples > 900.0 && retargeted.view.samples <= 1_000.0,
            "a new glide continues from the live view, got {}",
            retargeted.view.samples
        );

        // Without a duration it lands immediately, which is what a touchpad stream
        // relies on. It anchors on the *live* view rather than the original start,
        // because a running glide keeps the stored view up to date — so the result
        // is near the anchored target rather than exactly on it.
        let immediate = session.render_frame(&request(3, 0.0)).unwrap();
        assert!(
            (immediate.view.samples - 500.0).abs() < 5.0,
            "an instant zoom should land on the anchored result, got {}",
            immediate.view.samples
        );
        assert!(
            (immediate.view.start_sample - 5_250.0).abs() < 5.0,
            "an instant zoom should hold the anchor, got {}",
            immediate.view.start_sample
        );
    }

    #[test]
    fn view_limits_are_applied_by_the_backend() {
        let session = GraphSession::default();
        session.replace_capture(demo_capture(16, 250_000)).unwrap();

        // Without a ceiling the DataLimited rule caps zoom-out at 2.5x the data.
        let wide = session.apply_view_intent(&ViewIntent::Set {
            start_sample: 0.0,
            samples: 100_000_000.0,
        });
        assert_eq!(wide.samples, 625_000.0);
        assert_eq!(wide.start_sample, 0.0);

        // A session ceiling widens it, and the current viewport is re-clamped
        // against the new limits so a capture that grew cannot leave a stale view.
        let view = session.set_view_limits(ViewLimits {
            live: false,
            maximum_samples: Some(500_000_000.0),
            sample_rate_hz: 1_000_000.0,
        });
        assert_eq!(view.samples, 625_000.0);

        // Below the new ceiling nothing changes...
        let under = session.apply_view_intent(&ViewIntent::Set {
            start_sample: 0.0,
            samples: 100_000_000.0,
        });
        assert_eq!(under.samples, 100_000_000.0);

        // ...and above it the ceiling wins.
        let clamped = session.apply_view_intent(&ViewIntent::Set {
            start_sample: 0.0,
            samples: 900_000_000.0,
        });
        assert_eq!(clamped.samples, 500_000_000.0);
        assert_eq!(clamped.start_sample, 0.0);
    }

    /// Scrolling past the widest allowed view must stop the view dead.
    ///
    /// A zoom that cannot change the span must not change the start either. The
    /// anchor arithmetic turns a span into a start, so when the span is reduced
    /// afterwards by the ceiling, whatever the overshoot implied is left behind as
    /// a start offset — and because the anchor is a ratio of the window, that
    /// offset is a translation on screen. At the data limit the waveform slid
    /// sideways one notch at a time, which is not something the user can undo by
    /// zooming back in.
    #[test]
    fn zooming_out_past_the_ceiling_does_not_translate_the_view() {
        let session = GraphSession::default();
        let total = 238_551_040u64;
        let sample_rate_hz = 25_000_000.0;
        session.replace_capture(demo_capture(8, total)).unwrap();

        // What `completedCaptureViewport` sends for a finished capture: the data
        // limit alone, with no live reserve.
        let ceiling = view_state::maximum_capture_view_samples(total);
        session.set_view_limits(ViewLimits {
            live: false,
            maximum_samples: Some(ceiling),
            sample_rate_hz,
        });
        let at_ceiling = session.apply_view_intent(&ViewIntent::Set {
            start_sample: 0.0,
            samples: ceiling,
        });
        assert_eq!(at_ceiling.samples, ceiling);
        let settled_start = at_ceiling.start_sample;

        // Ten more notches past the end of the range, at the anchor from the log.
        for notch in 0..10 {
            let after = session.apply_view_intent(&ViewIntent::Zoom {
                factor: 1.4142135623730951,
                anchor_ratio: 0.1342925659472422,
                duration_ms: 0.0,
            });
            assert_eq!(
                after.samples, ceiling,
                "notch {notch} changed the span past the ceiling"
            );
            assert!(
                (after.start_sample - settled_start).abs() < 1.0,
                "notch {notch} slid the view: start went from {settled_start} to {}",
                after.start_sample
            );
        }
    }

    /// The same property on a live session, whose ceiling is the live reserve.
    ///
    /// Worth its own case because the live ceiling comes from a different
    /// expression, and a clamp that agrees with one and not the other is exactly
    /// how the two directions of the bug get introduced one at a time.
    #[test]
    fn zooming_out_past_the_live_ceiling_does_not_translate_the_view() {
        let session = GraphSession::default();
        let sample_rate_hz = 25_000_000.0;
        session.replace_capture(demo_capture(8, 1_000_000)).unwrap();
        session.set_view_limits(ViewLimits {
            live: true,
            maximum_samples: None,
            sample_rate_hz,
        });

        let ceiling = view_state::maximum_live_capture_view_samples(1_000_000, sample_rate_hz);
        let at_ceiling = session.apply_view_intent(&ViewIntent::Set {
            start_sample: 0.0,
            samples: ceiling,
        });
        assert_eq!(at_ceiling.samples, ceiling);
        let settled_start = at_ceiling.start_sample;

        for notch in 0..10 {
            let after = session.apply_view_intent(&ViewIntent::Zoom {
                factor: 1.4142135623730951,
                anchor_ratio: 0.1342925659472422,
                duration_ms: 0.0,
            });
            assert_eq!(
                after.samples, ceiling,
                "notch {notch} changed the span past the live ceiling"
            );
            assert!(
                (after.start_sample - settled_start).abs() < 1.0,
                "notch {notch} slid the view: start went from {settled_start} to {}",
                after.start_sample
            );
        }
    }

    #[test]
    fn an_animated_intent_glides_and_reports_both_viewports() {
        let session = GraphSession::default();
        session.replace_capture(demo_capture(16, 250_000)).unwrap();
        session.apply_view_intent(&ViewIntent::Set {
            start_sample: 0.0,
            samples: 1_000.0,
        });

        let request = |view: Option<ViewIntent>| GraphFrameRequest {
            frame_id: 1,
            waveform: WaveformRequest {
                start_sample: 0,
                sample_count: 0,
                pixels: 200,
                channels: vec![0],
            },
            include_tile: true,
            analyzer_view: None,
            analyzers: Vec::new(),
            view,
        };

        // The frame that starts the glide is still near its origin. `view` may
        // already lead `data_view` by a hair because the glide advances while the
        // tile is being built — that gap is precisely what the frontend's
        // residual transform stretches.
        let started = session
            .render_frame(&request(Some(ViewIntent::AnimateTo {
                start_sample: 0.0,
                samples: 2_000.0,
                duration_ms: 200.0,
            })))
            .unwrap();
        assert!(started.data_view.samples < 1_500.0);
        assert!(started.view.samples >= started.data_view.samples);

        std::thread::sleep(std::time::Duration::from_millis(280));

        // Once the glide is over the session settles on the destination, and a
        // per-frame request keeps rendering wherever the session now is.
        let settled = session
            .render_frame(&request(Some(ViewIntent::KeepCurrent)))
            .unwrap();
        assert_eq!(settled.view.samples, 2_000.0);
        assert_eq!(settled.data_view, settled.view);
        assert_eq!(settled.tile.start_sample, 0);
        assert_eq!(settled.tile.sample_count, 2_000);
    }

    #[test]
    fn an_instant_intent_cancels_a_running_glide() {
        let session = GraphSession::default();
        session.replace_capture(demo_capture(16, 250_000)).unwrap();
        session.apply_view_intent(&ViewIntent::Set {
            start_sample: 0.0,
            samples: 1_000.0,
        });
        session.apply_view_intent(&ViewIntent::AnimateTo {
            start_sample: 100_000.0,
            samples: 1_000.0,
            duration_ms: 5_000.0,
        });

        // A wheel tick must interrupt a toolbar zoom rather than fight it.
        let cancelled = session.apply_view_intent(&ViewIntent::PanSamples {
            delta_samples: 250.0,
            duration_ms: 0.0,
        });
        assert_eq!(cancelled.start_sample, 250.0);
        assert_eq!(session.session_view(), cancelled);
    }

    #[test]
    fn the_data_viewport_reports_what_the_tile_was_built_for() {
        let session = GraphSession::default();
        session.replace_capture(demo_capture(16, 250_000)).unwrap();

        let response = session
            .render_frame(&GraphFrameRequest {
                frame_id: 1,
                waveform: WaveformRequest {
                    start_sample: 0,
                    sample_count: 0,
                    pixels: 200,
                    channels: vec![0],
                },
                include_tile: true,
                analyzer_view: None,
                analyzers: Vec::new(),
                view: Some(ViewIntent::Set {
                    start_sample: 4_000.75,
                    samples: 1_234.5,
                }),
            })
            .unwrap();

        // The residual transform the frontend applies is derived from these two,
        // so the tile has to actually cover the reported data viewport.
        assert_eq!(response.data_view.start_sample, 4_000.75);
        assert_eq!(response.data_view.samples, 1_234.5);
        assert_eq!(response.tile.start_sample, 4_000);
        // ceil(4000.75 + 1234.5) - floor(4000.75) = 5236 - 4000.
        assert_eq!(response.tile.sample_count, 1_236);
    }

    #[test]
    fn a_live_session_follows_a_fixed_window_at_the_tail() {
        let session = GraphSession::default();
        session.replace_capture(demo_capture(16, 4_000_000)).unwrap();
        session.set_view_limits(ViewLimits {
            live: true,
            maximum_samples: None,
            sample_rate_hz: 1_000_000.0,
        });

        // About a second of capture, anchored to the newest samples. Fitting the
        // whole capture instead would zoom out on every frame as data streams in.
        let view = session.session_view();
        assert_eq!(view.samples, 1_000_000.0);
        assert_eq!(view.start_sample, 3_000_000.0);
        assert_eq!(view.start_sample + view.samples, 4_000_000.0);

        // A manual gesture takes the session out of follow mode.
        let panned = session.apply_view_intent(&ViewIntent::Set {
            start_sample: 0.0,
            samples: 500_000.0,
        });
        assert_eq!(panned.start_sample, 0.0);
        assert_eq!(session.session_view().start_sample, 0.0);
    }

    #[test]
    fn zooming_in_stops_at_the_finest_useful_span() {
        let session = GraphSession::default();
        session.replace_capture(demo_capture(16, 4_000_000)).unwrap();
        session.set_view_limits(ViewLimits {
            live: false,
            maximum_samples: None,
            sample_rate_hz: 100_000_000.0,
        });

        // At 100 MHz the floor of 5 µs is 500 samples. Asking for a single sample
        // must widen back to the floor: below it the viewport resolves individual
        // samples rather than signal edges, which costs the renderer every frame
        // and tells the user nothing.
        let view = session.apply_view_intent(&ViewIntent::Set {
            start_sample: 1_000_000.0,
            samples: 1.0,
        });
        assert!(
            (view.samples - 500.0).abs() < 0.001,
            "expected the span to widen to the floor, got {}",
            view.samples
        );

        // The floor widens around the requested centre rather than pinning the
        // start, so the view does not slide sideways once the span stops changing.
        assert!(
            (view.start_sample - 999_750.5).abs() < 0.001,
            "expected the view to widen around its centre, got {}",
            view.start_sample
        );
    }

    #[test]
    fn zooming_in_at_the_limit_does_not_drift_sideways() {
        let session = GraphSession::default();
        session.replace_capture(demo_capture(16, 4_000_000)).unwrap();
        session.set_view_limits(ViewLimits {
            live: false,
            maximum_samples: None,
            sample_rate_hz: 100_000_000.0,
        });

        // Zoom in hard through an off-centre anchor until the span reaches the floor.
        let anchor = 0.75;
        for _ in 0..20 {
            session.apply_view_intent(&ViewIntent::Zoom {
                factor: 0.5,
                anchor_ratio: anchor,
                duration_ms: 0.0,
            });
        }
        let at_limit = session.session_view();
        assert!(
            (at_limit.samples - 500.0).abs() < 0.001,
            "the span should sit on the floor, got {}",
            at_limit.samples
        );

        // Pressing again must change nothing at all. Clamping the resulting span
        // instead of the factor would re-centre on the anchor here, so the start
        // would creep toward it — the sideways drift a held key produces.
        for _ in 0..10 {
            session.apply_view_intent(&ViewIntent::Zoom {
                factor: 0.5,
                anchor_ratio: anchor,
                duration_ms: 0.0,
            });
        }
        let after = session.session_view();
        assert!(
            (after.samples - at_limit.samples).abs() < 1e-9,
            "the span moved off the floor: {} -> {}",
            at_limit.samples,
            after.samples
        );
        assert!(
            (after.start_sample - at_limit.start_sample).abs() < 1e-9,
            "the view drifted sideways at the limit: {} -> {}",
            at_limit.start_sample,
            after.start_sample
        );
    }

    #[test]
    fn a_loaded_capture_opens_on_a_readable_window_not_the_whole_thing() {
        let session = GraphSession::default();
        session.replace_capture(demo_capture(16, 4_000_000)).unwrap();
        session.set_view_limits(ViewLimits {
            live: false,
            maximum_samples: None,
            sample_rate_hz: 1_000_000.0,
        });

        let view = session.session_view();
        assert_eq!(view.samples, 1_000_000.0);
        assert_eq!(view.start_sample, 0.0);

        // A capture shorter than the preferred window still fits exactly.
        let small = GraphSession::default();
        small.replace_capture(demo_capture(16, 40_000)).unwrap();
        small.set_view_limits(ViewLimits {
            live: false,
            maximum_samples: None,
            sample_rate_hz: 1_000_000.0,
        });
        assert_eq!(small.session_view().samples, 40_000.0);
    }

    #[test]
    fn setting_view_limits_does_not_pin_a_view_that_was_never_moved() {
        let session = GraphSession::default();
        session.replace_capture(demo_capture(16, 4_000_000)).unwrap();
        // Re-clamping must not turn "never moved" into "explicitly set", or a
        // live session would stop following the tail the first time the
        // workbench pushed its limits.
        session.set_view_limits(ViewLimits {
            live: true,
            maximum_samples: None,
            sample_rate_hz: 1_000_000.0,
        });
        session.set_view_limits(ViewLimits {
            live: true,
            maximum_samples: None,
            sample_rate_hz: 1_000_000.0,
        });
        assert_eq!(session.session_view().start_sample, 3_000_000.0);
    }

    #[test]
    fn graph_sessions_keep_capture_data_isolated() {
        let short = GraphSession::default();
        let long = GraphSession::default();
        short.replace_capture(demo_capture(8, 10_000)).unwrap();
        long.replace_capture(demo_capture(32, 50_000)).unwrap();
        assert_eq!(short.sample_count(), 10_000);
        assert_eq!(short.metadata().unwrap().channel_count, 8);
        assert_eq!(long.sample_count(), 50_000);
        assert_eq!(long.metadata().unwrap().channel_count, 32);

        let request = WaveformRequest {
            start_sample: 0,
            sample_count: 50_000,
            pixels: 500,
            channels: vec![31],
        };
        assert!(short
            .graph
            .read()
            .as_ref()
            .unwrap()
            .build_tile(&request)
            .unwrap()
            .channels
            .is_empty());
        assert_eq!(
            long.graph
                .read()
                .as_ref()
                .unwrap()
                .build_tile(&request)
                .unwrap()
                .channels[0]
                .channel,
            31
        );
    }

    #[test]
    fn native_window_decode_worker_count_is_bounded_and_configurable() {
        assert_eq!(native_window_decode_worker_count_value(1, None, 8), 1);
        assert_eq!(native_window_decode_worker_count_value(13, None, 8), 4);
        assert_eq!(native_window_decode_worker_count_value(13, None, 2), 2);
        assert_eq!(native_window_decode_worker_count_value(13, Some("1"), 8), 1);
        assert_eq!(native_window_decode_worker_count_value(13, Some("8"), 4), 4);
        assert_eq!(
            native_window_decode_worker_count_value(13, Some("garbage"), 8),
            4
        );
        assert_eq!(native_window_decode_worker_count_value(13, Some("0"), 8), 4);
    }

    #[test]
    fn async_completion_markers_replace_preview_markers_on_the_full_timeline() {
        let mut frames = vec![
            decoded_frame_for_graph_test(0, 100),
            decoded_frame_for_graph_test(1, 200),
            decoded_frame_for_graph_test(2, 300),
        ];
        frames[0].protocol_markers.push(DecodedProtocolMarker {
            channel: Some(0),
            sample: 105,
            kind: "preview".to_string(),
        });
        attach_native_completion_markers(
            &mut frames,
            vec![
                DecodedProtocolMarker {
                    channel: Some(1),
                    sample: 350,
                    kind: "stop".to_string(),
                },
                DecodedProtocolMarker {
                    channel: Some(0),
                    sample: 50,
                    kind: "start".to_string(),
                },
                DecodedProtocolMarker {
                    channel: Some(1),
                    sample: 250,
                    kind: "up_arrow".to_string(),
                },
            ],
        );

        assert_eq!(
            frames
                .iter()
                .map(|frame| {
                    frame
                        .protocol_markers
                        .iter()
                        .map(|marker| (marker.sample, marker.kind.as_str()))
                        .collect::<Vec<_>>()
                })
                .collect::<Vec<_>>(),
            vec![
                vec![(50, "start")],
                vec![(250, "up_arrow")],
                vec![(350, "stop")],
            ]
        );
    }
}
