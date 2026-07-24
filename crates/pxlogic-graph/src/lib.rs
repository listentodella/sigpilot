use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use parking_lot::{Mutex, RwLock};
use pxlogic_core::{
    resolve_enabled_channels, AnalyzerDecodeSettings, CaptureData, CaptureMetadata,
    CaptureTriggerMetadata, DecodedChannelValue, DecodedFrame, DecoderBackend, DecoderBackendKind,
    I2cDecodeSettings, SaleaeNativeDecoder, SigrokNativeDecoder, SparseCaptureData,
    SparseDigitalChannel, SpiDecodeSettings, UartDecodeSettings,
};
use pxlogic_waveform::{ChannelTile, DigitalSegment, WaveformBin, WaveformRequest, WaveformTile};
use serde::{Deserialize, Serialize};
use thiserror::Error;

const MAX_CHANNELS: u8 = 32;
const MAX_DECODED_FRAMES: usize = 100_000;

// Logic 2.4.43 BaseAnalyzerManager render limits.
const MAX_ANALYZER_MARKER_RESULTS: usize = 300;
const MAX_MULTI_BUBBLE_STRINGS: usize = 400;
const MAX_PIXEL_WIDTH_FOR_MERGEABLE_FRAME: f64 = 15.0;
const MAX_PIXELS_BETWEEN_MERGEABLE_FRAMES: f64 = 30.0;
const DENSE_BUBBLE_THRESHOLD: usize = MAX_ANALYZER_MARKER_RESULTS * 4;
const MAX_COARSE_EDGE_MARKERS: usize = 400;
const PACKED_DIGITAL_BIN_BYTES: usize = 16;
const MAX_EXACT_SAMPLES_PER_PIXEL: u64 = 8;
const NATIVE_VIEW_EDGE_BUDGET: usize = 32_768;
const NATIVE_FIT_MAX_CHUNKS: usize = 16;
const NATIVE_FIT_EDGES_PER_CHUNK: usize = 1_024;
const NATIVE_CONTEXT_EDGES: usize = 256;
const MAX_ANALYZER_WINDOW_CACHE_ENTRIES: usize = 64;

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
pub struct GraphFrameRequest {
    pub frame_id: u64,
    pub waveform: WaveformRequest,
    #[serde(default)]
    pub analyzer_view: Option<WaveformRequest>,
    #[serde(default)]
    pub analyzers: Vec<AnalyzerRenderRequest>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GraphFrameResponse {
    pub frame_id: u64,
    pub revision: u64,
    pub sample_count: u64,
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
    pub frames: Vec<DecodedFrame>,
    pub previous_frame: Option<DecodedFrame>,
    pub next_frame: Option<DecodedFrame>,
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

    pub fn metadata(&self) -> &CaptureMetadata {
        &self.metadata
    }

    pub fn sample_count(&self) -> u64 {
        self.sample_count
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
        let channels = requested_channels
            .into_iter()
            .map(|channel| {
                self.build_channel_tile(
                    channel,
                    start,
                    end,
                    bin_count,
                    samples_per_bin,
                    include_exact,
                )
            })
            .collect();

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
                        label,
                        value: u64::from(value),
                    }],
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
                            label: bubble_label,
                            value: u64::from(byte),
                        }],
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
                        value: mosi_value,
                    });
                }
                if let Some(channel) = settings.miso_channel {
                    channel_values.push(DecodedChannelValue {
                        channel,
                        role: "MISO".to_string(),
                        label: label_for_value(miso_value, settings.bits_per_transfer),
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

/// Per-UI-session graph state. Analyzer frames are cached by settings and are
/// invalidated whenever new samples arrive.
#[derive(Debug, Default)]
pub struct GraphSession {
    graph: RwLock<Option<DigitalGraph>>,
    capture: RwLock<Option<Arc<CaptureData>>>,
    sparse_capture: RwLock<Option<Arc<SparseCaptureData>>>,
    analyzer_cache: Mutex<HashMap<String, AnalyzerCacheEntry>>,
    revision: AtomicU64,
}

#[derive(Debug, Clone)]
struct AnalyzerCacheEntry {
    decoded_sample_count: u64,
    frames: Arc<Vec<DecodedFrame>>,
}

impl GraphSession {
    pub fn begin_capture(&self, metadata: CaptureMetadata) -> Result<()> {
        *self.graph.write() = Some(DigitalGraph::new(metadata)?);
        *self.capture.write() = None;
        *self.sparse_capture.write() = None;
        self.analyzer_cache.lock().clear();
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
        self.analyzer_cache.lock().clear();
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
        if indexed_samples != capture.metadata.sample_count {
            return self.replace_capture(capture);
        }
        let finalized = self
            .graph
            .write()
            .as_mut()
            .ok_or(GraphError::EmptyGraph)
            .and_then(|graph| graph.finish_metadata(capture.metadata.clone()));
        if finalized.is_err() {
            return self.replace_capture(capture);
        }
        *self.capture.write() = Some(Arc::new(capture));
        *self.sparse_capture.write() = None;
        self.bump_revision();
        Ok(())
    }

    pub fn replace_sparse_capture(&self, capture: SparseCaptureData) -> Result<()> {
        let graph = DigitalGraph::from_sparse_capture(&capture)?;
        *self.graph.write() = Some(graph);
        *self.capture.write() = None;
        *self.sparse_capture.write() = Some(Arc::new(capture));
        self.analyzer_cache.lock().clear();
        self.bump_revision();
        Ok(())
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
            self.analyzer_cache.lock().insert(
                key,
                AnalyzerCacheEntry {
                    decoded_sample_count: sample_count,
                    frames,
                },
            );
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
        let entry = cache.entry(key).or_insert_with(|| AnalyzerCacheEntry {
            decoded_sample_count: sample_count,
            frames: frames.clone(),
        });
        if entry.decoded_sample_count < sample_count {
            *entry = AnalyzerCacheEntry {
                decoded_sample_count: sample_count,
                frames: frames.clone(),
            };
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
            return self.decode_frames(settings);
        }
        let packed_capture = self.capture();
        let sparse_capture = self.sparse_capture();
        if packed_capture.is_none() && sparse_capture.is_none() {
            // Native sidecars are batch decoders. Keep live bubbles available
            // from the indexed graph, then replace them after finish_capture().
            return self.decode_frames(settings);
        }

        let key = serde_json::to_string(&(backend, settings))?;
        let sample_count = self.sample_count();
        if let Some(entry) = self.analyzer_cache.lock().get(&key) {
            if entry.decoded_sample_count == sample_count {
                return Ok(entry.frames.clone());
            }
        }

        let output = match backend {
            DecoderBackendKind::SaleaeNative => {
                let decoder = SaleaeNativeDecoder::from_env()
                    .map_err(|error| GraphError::DecoderBackend(error.to_string()))?;
                if let Some(capture) = &packed_capture {
                    decoder.decode(capture.as_ref(), settings)
                } else if let Some(capture) = &sparse_capture {
                    decoder.decode_sparse(capture.as_ref(), settings)
                } else {
                    unreachable!();
                }
            }
            DecoderBackendKind::SigrokNative => {
                let decoder = SigrokNativeDecoder::from_env()
                    .map_err(|error| GraphError::DecoderBackend(error.to_string()))?;
                if let Some(capture) = &packed_capture {
                    decoder.decode(capture.as_ref(), settings)
                } else if let Some(capture) = &sparse_capture {
                    decoder.decode_sparse(capture.as_ref(), settings)
                } else {
                    unreachable!();
                }
            }
            DecoderBackendKind::Auto | DecoderBackendKind::LegacyRust => unreachable!(),
        }
        .map_err(|error| GraphError::DecoderBackend(error.to_string()))?;
        let frames = Arc::new(output.into_decoded_frames());
        self.analyzer_cache.lock().insert(
            key,
            AnalyzerCacheEntry {
                decoded_sample_count: sample_count,
                frames: frames.clone(),
            },
        );
        Ok(frames)
    }

    pub fn decode_frames_with_backend_for_view(
        &self,
        settings: &AnalyzerDecodeSettings,
        backend: DecoderBackendKind,
        waveform: &WaveformRequest,
    ) -> Result<Arc<Vec<DecodedFrame>>> {
        if matches!(
            backend,
            DecoderBackendKind::SaleaeNative | DecoderBackendKind::SigrokNative
        ) {
            if let Some(capture) = self.sparse_capture() {
                return self.decode_sparse_frames_for_view(
                    capture.as_ref(),
                    settings,
                    backend,
                    waveform,
                );
            }
        }
        self.decode_frames_with_backend(settings, backend)
    }

    pub fn render_frame(&self, request: &GraphFrameRequest) -> Result<GraphFrameResponse> {
        let tile = self
            .graph
            .read()
            .as_ref()
            .ok_or(GraphError::EmptyGraph)?
            .build_tile(&request.waveform)?;
        let analyzers = request
            .analyzers
            .iter()
            .map(|analyzer| {
                self.render_analyzer(
                    analyzer,
                    request.analyzer_view.as_ref().unwrap_or(&request.waveform),
                )
            })
            .collect::<Result<Vec<_>>>()?;

        Ok(GraphFrameResponse {
            frame_id: request.frame_id,
            revision: self.revision(),
            sample_count: self.sample_count(),
            tile,
            analyzers,
        })
    }

    fn render_analyzer(
        &self,
        request: &AnalyzerRenderRequest,
        waveform: &WaveformRequest,
    ) -> Result<AnalyzerRenderResult> {
        let frames =
            self.decode_frames_with_backend_for_view(&request.settings, request.backend, waveform)?;
        let tracks = request
            .tracks
            .iter()
            .map(|track| render_analyzer_track(&frames, track, waveform))
            .collect();
        Ok(AnalyzerRenderResult {
            analyzer_id: request.analyzer_id.clone(),
            tracks,
        })
    }

    fn decode_sparse_frames_for_view(
        &self,
        capture: &SparseCaptureData,
        settings: &AnalyzerDecodeSettings,
        backend: DecoderBackendKind,
        waveform: &WaveformRequest,
    ) -> Result<Arc<Vec<DecodedFrame>>> {
        let windows = sparse_native_analysis_windows(capture, settings, waveform)?;
        if windows.is_empty() {
            return Ok(Arc::new(Vec::new()));
        }

        let key = serde_json::to_string(&("sparse-native-window-v1", backend, settings, &windows))?;
        let sample_count = self.sample_count();
        if let Some(entry) = self.analyzer_cache.lock().get(&key) {
            if entry.decoded_sample_count == sample_count {
                return Ok(entry.frames.clone());
            }
        }

        let decoder: Box<dyn DecoderBackend> = match backend {
            DecoderBackendKind::SaleaeNative => Box::new(
                SaleaeNativeDecoder::from_env()
                    .map_err(|error| GraphError::DecoderBackend(error.to_string()))?,
            ),
            DecoderBackendKind::SigrokNative => Box::new(
                SigrokNativeDecoder::from_env()
                    .map_err(|error| GraphError::DecoderBackend(error.to_string()))?,
            ),
            DecoderBackendKind::Auto | DecoderBackendKind::LegacyRust => unreachable!(),
        };

        let mut frames = Vec::new();
        let mut first_error = None;
        for &(start, end) in &windows {
            let window_capture = slice_sparse_capture(capture, start, end)?;
            match decoder.decode_sparse(&window_capture, settings) {
                Ok(output) => {
                    frames.extend(output.into_decoded_frames().into_iter().map(|mut frame| {
                        frame.start_sample = frame.start_sample.saturating_add(start);
                        frame.end_sample = frame.end_sample.saturating_add(start);
                        frame
                    }));
                }
                Err(error) => {
                    first_error.get_or_insert_with(|| error.to_string());
                }
            }
        }
        if frames.is_empty() {
            if let Some(error) = first_error {
                return Err(GraphError::DecoderBackend(error));
            }
        }

        frames.sort_by_key(|frame| (frame.start_sample, frame.end_sample));
        frames.dedup_by(|right, left| {
            left.start_sample == right.start_sample
                && left.end_sample == right.end_sample
                && left.value == right.value
                && left.channel_values == right.channel_values
        });
        for frame in &mut frames {
            frame.frame_id = frame.start_sample;
        }
        if frames.len() > MAX_DECODED_FRAMES {
            let stride = frames.len().div_ceil(MAX_DECODED_FRAMES);
            frames = frames.into_iter().step_by(stride).collect();
            for frame in &mut frames {
                frame.frame_id = frame.start_sample;
            }
        }

        let frames = Arc::new(frames);
        let mut cache = self.analyzer_cache.lock();
        if cache.len() >= MAX_ANALYZER_WINDOW_CACHE_ENTRIES {
            cache.clear();
        }
        cache.insert(
            key,
            AnalyzerCacheEntry {
                decoded_sample_count: sample_count,
                frames: frames.clone(),
            },
        );
        Ok(frames)
    }

    fn bump_revision(&self) {
        self.revision.fetch_add(1, Ordering::AcqRel);
    }
}

fn sparse_native_analysis_windows(
    capture: &SparseCaptureData,
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

fn align_spi_window_to_enable(
    capture: &SparseCaptureData,
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

fn sparse_level_at(channel: &SparseDigitalChannel, sample: u64) -> bool {
    channel.initial_high
        ^ (channel
            .transitions
            .partition_point(|transition| *transition <= sample)
            % 2
            == 1)
}

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
    merged.sort_by_key(|frame| (frame.start_sample, frame.end_sample));
    merged.dedup_by(|right, left| {
        left.start_sample == right.start_sample
            && left.end_sample == right.end_sample
            && left.channel_values == right.channel_values
            && left.value == right.value
    });
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

fn pack_digital_bins(bins: &[WaveformBin]) -> String {
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
    BASE64.encode(packed)
}

#[cfg(test)]
fn unpack_digital_bins(packed: &str) -> Vec<WaveformBin> {
    let bytes = BASE64.decode(packed).expect("valid packed bins");
    bytes
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

    let bubbles = if visible_count > DENSE_BUBBLE_THRESHOLD {
        build_dense_bubbles(frames, track, begin, finish)
    } else {
        build_pixel_bubbles(
            frames,
            track,
            begin,
            finish,
            waveform.sample_count,
            waveform.pixels,
        )
    };
    let visible_frames = (begin..finish)
        .filter_map(|index| frame_for_track(&frames[index], track))
        .take(MAX_ANALYZER_MARKER_RESULTS)
        .collect::<Vec<_>>();
    let previous_frame = (0..begin)
        .rev()
        .find_map(|index| frame_for_track(&frames[index], track));
    let next_start = if visible_count > MAX_ANALYZER_MARKER_RESULTS {
        begin
            .saturating_add(MAX_ANALYZER_MARKER_RESULTS)
            .min(frames.len())
    } else {
        finish
    };
    let next_frame =
        (next_start..frames.len()).find_map(|index| frame_for_track(&frames[index], track));

    AnalyzerTrackWindow {
        channel: track.channel,
        role: track.role.clone(),
        bubbles,
        frames: visible_frames,
        previous_frame,
        next_frame,
    }
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
                    display_text: vec![frame.label.to_string()],
                    result_count: 1,
                },
                last_frame_end_sample: frame.end_sample,
                last_frame_width_px: frame_width_px,
            });
        }
    }
    enforce_maximum_bubbles(accumulators.into_iter().map(|item| item.bubble).collect())
}

fn build_dense_bubbles(
    frames: &[DecodedFrame],
    track: &AnalyzerTrackRequest,
    begin: usize,
    end: usize,
) -> Vec<AnalyzerBubble> {
    let count = end.saturating_sub(begin);
    if count == 0 {
        return Vec::new();
    }
    let bucket_size = count.div_ceil(MAX_ANALYZER_MARKER_RESULTS).max(1);
    let mut bubbles = Vec::with_capacity(count.div_ceil(bucket_size));
    let mut bucket_begin = begin;
    while bucket_begin < end {
        let bucket_end = (bucket_begin + bucket_size).min(end);
        let first = (bucket_begin..bucket_end)
            .find_map(|index| display_frame_for_track(&frames[index], track));
        let last = (bucket_begin..bucket_end)
            .rev()
            .find_map(|index| display_frame_for_track(&frames[index], track));
        if let (Some(first), Some(last)) = (first, last) {
            let display_text = (bucket_begin..bucket_end)
                .filter_map(|index| display_frame_for_track(&frames[index], track))
                .take(12)
                .map(|frame| frame.label.to_string())
                .collect::<Vec<_>>();
            let result_count = (bucket_begin..bucket_end)
                .filter(|index| display_frame_for_track(&frames[*index], track).is_some())
                .count() as u64;
            bubbles.push(AnalyzerBubble {
                bubble_type: if result_count == 1 {
                    AnalyzerBubbleType::SingleBubble
                } else {
                    AnalyzerBubbleType::MultiBubble
                },
                frame_id_interval: FrameIdInterval {
                    begin: first.frame_id,
                    end: last.frame_id.saturating_add(1),
                },
                start_sample: first.start_sample,
                end_sample: last.end_sample,
                display_text,
                result_count,
            });
        }
        bucket_begin = bucket_end;
    }
    bubbles
}

fn enforce_maximum_bubbles(bubbles: Vec<AnalyzerBubble>) -> Vec<AnalyzerBubble> {
    if bubbles.len() <= MAX_ANALYZER_MARKER_RESULTS {
        return bubbles;
    }
    let bucket_size = bubbles.len().div_ceil(MAX_ANALYZER_MARKER_RESULTS);
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
}

fn display_frame_for_track<'a>(
    frame: &'a DecodedFrame,
    track: &AnalyzerTrackRequest,
) -> Option<DisplayFrame<'a>> {
    let label = frame
        .channel_values
        .iter()
        .find(|value| value.channel == track.channel && value.role == track.role)?
        .label
        .as_str();
    Some(DisplayFrame {
        frame_id: frame.frame_id,
        start_sample: frame.start_sample,
        end_sample: frame.end_sample,
        label,
    })
}

fn frame_for_track(frame: &DecodedFrame, track: &AnalyzerTrackRequest) -> Option<DecodedFrame> {
    let value = frame
        .channel_values
        .iter()
        .find(|value| value.channel == track.channel && value.role == track.role)?;
    let mut result = frame.clone();
    result.label = value.label.clone();
    result.value = value.value;
    result.channel_values = vec![value.clone()];
    Some(result)
}

fn lower_bound_frame_end(frames: &[DecodedFrame], sample: u64) -> usize {
    frames.partition_point(|frame| frame.end_sample < sample)
}

fn upper_bound_frame_start(frames: &[DecodedFrame], sample: u64, low: usize) -> usize {
    low + frames[low..].partition_point(|frame| frame.start_sample <= sample)
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
    use std::time::{Duration, Instant};

    use chrono::Utc;
    use pxlogic_core::{
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
            let scanned = pxlogic_waveform::build_tile(&capture, &request).unwrap();
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
            kind: pxlogic_core::CaptureTriggerKind::Rising,
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
                    value: frame_id & 0xff,
                }],
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

        let windows = sparse_native_analysis_windows(&capture, &settings, &view).unwrap();
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
    #[ignore = "requires a GraphServer manifest and both native analyzer sidecars"]
    fn imported_saleae_capture_restores_native_bubbles_and_table_frames() {
        let manifest = std::env::var_os("PXLOGIC_SALEAE_MANIFEST")
            .map(std::path::PathBuf::from)
            .expect("PXLOGIC_SALEAE_MANIFEST");
        let imported = pxlogic_file::open_saleae_transition_session(manifest).unwrap();
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
                analyzer_view: None,
                analyzers: Vec::new(),
            })
            .unwrap();
        let with_analyzers = session
            .render_frame(&GraphFrameRequest {
                frame_id: 2,
                waveform: waveform.clone(),
                analyzer_view: Some(waveform),
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
}
