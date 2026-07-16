use pxlogic_core::{capture::read_sample_word, CaptureData};
use serde::{Deserialize, Serialize};
use thiserror::Error;

pub type Result<T> = std::result::Result<T, WaveformError>;

#[derive(Debug, Error)]
pub enum WaveformError {
    #[error("invalid waveform request")]
    InvalidRequest,
    #[error("capture contains invalid sample data")]
    InvalidCapture,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WaveformRequest {
    pub start_sample: u64,
    pub sample_count: u64,
    pub pixels: u32,
    pub channels: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WaveformTile {
    pub start_sample: u64,
    pub sample_count: u64,
    pub pixels: u32,
    pub samples_per_pixel: f64,
    pub channels: Vec<ChannelTile>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ChannelTile {
    pub channel: u8,
    pub label: String,
    pub bins: Vec<WaveformBin>,
    pub segments: Vec<DigitalSegment>,
    pub rising_edges: Vec<u64>,
    pub falling_edges: Vec<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WaveformBin {
    pub x: u32,
    pub first: bool,
    pub last: bool,
    pub has_high: bool,
    pub has_low: bool,
    pub edges: u32,
    pub first_edge_offset: Option<u32>,
    pub last_edge_offset: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DigitalSegment {
    pub start_sample: u64,
    pub end_sample: u64,
    pub high: bool,
}

pub fn build_tile(capture: &CaptureData, request: &WaveformRequest) -> Result<WaveformTile> {
    if request.pixels == 0 || request.sample_count == 0 {
        return Err(WaveformError::InvalidRequest);
    }
    let metadata = &capture.metadata;
    let total_samples = metadata.sample_count;
    let start = request.start_sample.min(total_samples);
    let end = start
        .saturating_add(request.sample_count)
        .min(total_samples);
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

    let bins = request.pixels.min(visible_samples as u32).max(1);
    let samples_per_bin = (visible_samples as f64) / f64::from(bins);
    let requested_channels = if request.channels.is_empty() {
        (0..metadata.channel_count).collect::<Vec<_>>()
    } else {
        request.channels.clone()
    };

    let requested_channels = requested_channels
        .into_iter()
        .filter(|channel| *channel < metadata.channel_count)
        .collect::<Vec<_>>();
    let mut channel_bins = requested_channels
        .iter()
        .map(|_| Vec::with_capacity(bins as usize))
        .collect::<Vec<_>>();

    for x in 0..bins {
        let bin_start =
            start + ((f64::from(x) * samples_per_bin).floor() as u64).min(visible_samples);
        let bin_end = start
            + ((f64::from(x + 1) * samples_per_bin).ceil() as u64)
                .min(visible_samples)
                .max(1);
        summarize_bin(
            capture,
            &requested_channels,
            x,
            bin_start,
            bin_end,
            &mut channel_bins,
        )?;
    }

    let mut channels = Vec::new();
    for (index, channel) in requested_channels.iter().copied().enumerate() {
        let label = metadata
            .labels
            .get(channel as usize)
            .cloned()
            .unwrap_or_else(|| format!("D{channel}"));
        let exact = build_exact_digital_data(capture, channel, start, end, request.pixels)?;
        channels.push(ChannelTile {
            channel,
            label,
            bins: std::mem::take(&mut channel_bins[index]),
            segments: exact.segments,
            rising_edges: exact.rising_edges,
            falling_edges: exact.falling_edges,
        });
    }

    Ok(WaveformTile {
        start_sample: start,
        sample_count: visible_samples,
        pixels: bins,
        samples_per_pixel: samples_per_bin,
        channels,
    })
}

fn summarize_bin(
    capture: &CaptureData,
    channels: &[u8],
    x: u32,
    start: u64,
    end: u64,
    output: &mut [Vec<WaveformBin>],
) -> Result<()> {
    let metadata = &capture.metadata;
    if channels.is_empty() {
        return Ok(());
    }

    let mut channel_mask = 0u32;
    let mut channel_to_output = [None::<usize>; 32];
    for (index, channel) in channels.iter().copied().enumerate() {
        channel_mask |= 1u32 << channel;
        channel_to_output[channel as usize] = Some(index);
    }

    let first_word = read_sample_word(&capture.samples, metadata.unitsize, start)
        .ok_or(WaveformError::InvalidCapture)?;
    let mut previous = first_word & channel_mask;
    let first_mask = previous;
    let mut last_mask = previous;
    let mut high_mask = previous;
    let mut low_mask = !first_word & channel_mask;
    let mut edges = vec![0u32; channels.len()];
    let mut first_edge_offsets = vec![None::<u32>; channels.len()];
    let mut last_edge_offsets = vec![None::<u32>; channels.len()];

    for sample in start + 1..end {
        let word = read_sample_word(&capture.samples, metadata.unitsize, sample)
            .ok_or(WaveformError::InvalidCapture)?;
        let masked = word & channel_mask;
        high_mask |= masked;
        low_mask |= !word & channel_mask;

        let mut changed = previous ^ masked;
        while changed != 0 {
            let channel = changed.trailing_zeros() as usize;
            if let Some(index) = channel_to_output[channel] {
                edges[index] = edges[index].saturating_add(1);
                let offset = sample.saturating_sub(start).min(u64::from(u32::MAX)) as u32;
                if first_edge_offsets[index].is_none() {
                    first_edge_offsets[index] = Some(offset);
                }
                last_edge_offsets[index] = Some(offset);
            }
            changed &= changed - 1;
        }
        previous = masked;
        last_mask = masked;
    }

    for (index, channel) in channels.iter().copied().enumerate() {
        let mask = 1u32 << channel;
        output[index].push(WaveformBin {
            x,
            first: first_mask & mask != 0,
            last: last_mask & mask != 0,
            has_high: high_mask & mask != 0,
            has_low: low_mask & mask != 0,
            edges: edges[index],
            first_edge_offset: first_edge_offsets[index],
            last_edge_offset: last_edge_offsets[index],
        });
    }

    Ok(())
}

#[derive(Default)]
struct ExactDigitalData {
    segments: Vec<DigitalSegment>,
    rising_edges: Vec<u64>,
    falling_edges: Vec<u64>,
}

fn build_exact_digital_data(
    capture: &CaptureData,
    channel: u8,
    start: u64,
    end: u64,
    pixels: u32,
) -> Result<ExactDigitalData> {
    let visible_samples = end.saturating_sub(start);
    let exact_limit = u64::from(pixels).saturating_mul(96).max(4096);
    if visible_samples == 0 || visible_samples > exact_limit {
        return Ok(ExactDigitalData::default());
    }

    let metadata = &capture.metadata;
    let mask = 1u32 << channel;
    let first_word = read_sample_word(&capture.samples, metadata.unitsize, start)
        .ok_or(WaveformError::InvalidCapture)?;
    let mut previous = first_word & mask != 0;
    let mut run_start = start;
    let mut data = ExactDigitalData {
        segments: Vec::new(),
        rising_edges: Vec::new(),
        falling_edges: Vec::new(),
    };

    for sample in start + 1..end {
        let word = read_sample_word(&capture.samples, metadata.unitsize, sample)
            .ok_or(WaveformError::InvalidCapture)?;
        let current = word & mask != 0;
        if current == previous {
            continue;
        }

        data.segments.push(DigitalSegment {
            start_sample: run_start,
            end_sample: sample,
            high: previous,
        });
        if current {
            data.rising_edges.push(sample);
        } else {
            data.falling_edges.push(sample);
        }
        run_start = sample;
        previous = current;
    }

    data.segments.push(DigitalSegment {
        start_sample: run_start,
        end_sample: end,
        high: previous,
    });
    Ok(data)
}

#[cfg(test)]
mod tests {
    use pxlogic_core::{capture::generate_sample_words, CaptureSettings};

    use super::*;

    #[test]
    fn builds_visible_waveform_tile() {
        let capture = generate_sample_words(&CaptureSettings {
            sample_rate_hz: 10_000,
            duration_ms: 10,
            channel_count: 4,
            ..CaptureSettings::default()
        })
        .unwrap();
        let tile = build_tile(
            &capture,
            &WaveformRequest {
                start_sample: 0,
                sample_count: 64,
                pixels: 16,
                channels: vec![0, 1],
            },
        )
        .unwrap();
        assert_eq!(tile.channels.len(), 2);
        assert_eq!(tile.channels[0].bins.len(), 16);
        assert!(tile.samples_per_pixel >= 1.0);
    }

    #[test]
    fn clamps_request_to_capture_bounds() {
        let capture = generate_sample_words(&CaptureSettings {
            sample_rate_hz: 10_000,
            duration_ms: 10,
            channel_count: 4,
            ..CaptureSettings::default()
        })
        .unwrap();
        let tile = build_tile(
            &capture,
            &WaveformRequest {
                start_sample: capture.metadata.sample_count - 4,
                sample_count: 100,
                pixels: 20,
                channels: vec![],
            },
        )
        .unwrap();
        assert_eq!(tile.sample_count, 4);
        assert_eq!(tile.channels.len(), 4);
    }
}
