use serde::{Deserialize, Serialize};

use crate::{
    capture::read_sample_word,
    error::{CoreError, Result},
    models::CaptureData,
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct UartDecodeSettings {
    pub channel: u8,
    pub baud_rate: u32,
    pub inverted: bool,
}

impl Default for UartDecodeSettings {
    fn default() -> Self {
        Self {
            channel: 0,
            baud_rate: 115_200,
            inverted: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DecodedFrame {
    pub frame_id: u64,
    pub start_sample: u64,
    pub end_sample: u64,
    pub label: String,
    pub value: u8,
}

pub fn decode_uart(
    capture: &CaptureData,
    settings: &UartDecodeSettings,
) -> Result<Vec<DecodedFrame>> {
    if settings.channel >= capture.metadata.channel_count {
        return Err(CoreError::InvalidChannelCount(settings.channel));
    }
    if settings.baud_rate == 0 {
        return Err(CoreError::Decode(
            "UART baud rate must be non-zero".to_string(),
        ));
    }

    let bit_period = capture.metadata.sample_rate_hz as f64 / f64::from(settings.baud_rate);
    if bit_period < 2.0 {
        return Err(CoreError::Decode(
            "sample rate is too low for the selected UART baud rate".to_string(),
        ));
    }

    let mut frames = Vec::new();
    let mut sample = 1u64;
    while sample + ((10.0 * bit_period).ceil() as u64) < capture.metadata.sample_count {
        let previous = logical_bit(capture, settings, sample - 1)?;
        let current = logical_bit(capture, settings, sample)?;
        if previous
            && !current
            && !logical_bit_at_offset(capture, settings, sample, bit_period * 0.5)?
        {
            let mut value = 0u8;
            let mut valid = true;
            for bit_index in 0..8 {
                let bit_sample =
                    sample + ((bit_period * (1.5 + f64::from(bit_index))).round() as u64);
                if bit_sample >= capture.metadata.sample_count {
                    valid = false;
                    break;
                }
                if logical_bit(capture, settings, bit_sample)? {
                    value |= 1u8 << bit_index;
                }
            }

            let stop_sample = sample + ((bit_period * 9.5).round() as u64);
            if valid
                && stop_sample < capture.metadata.sample_count
                && logical_bit(capture, settings, stop_sample)?
            {
                let end_sample = sample + ((bit_period * 10.0).ceil() as u64);
                frames.push(DecodedFrame {
                    frame_id: frames.len() as u64,
                    start_sample: sample,
                    end_sample,
                    label: label_for_byte(value),
                    value,
                });
                sample += ((bit_period * 9.0).floor() as u64).max(1);
                if frames.len() >= 4096 {
                    break;
                }
                continue;
            }
        }
        sample += 1;
    }

    Ok(frames)
}

fn logical_bit_at_offset(
    capture: &CaptureData,
    settings: &UartDecodeSettings,
    start: u64,
    offset: f64,
) -> Result<bool> {
    logical_bit(capture, settings, start + offset.round() as u64)
}

fn logical_bit(capture: &CaptureData, settings: &UartDecodeSettings, sample: u64) -> Result<bool> {
    let word = read_sample_word(&capture.samples, capture.metadata.unitsize, sample)
        .ok_or_else(|| CoreError::Decode("sample index is outside capture data".to_string()))?;
    let raw = word & (1u32 << settings.channel) != 0;
    Ok(raw ^ settings.inverted)
}

fn label_for_byte(value: u8) -> String {
    format!("0x{value:02X}")
}

#[cfg(test)]
mod tests {
    use crate::{capture::generate_sample_words, CaptureSettings};

    use super::*;

    #[test]
    fn decodes_demo_uart_from_channel_zero() {
        let capture = generate_sample_words(&CaptureSettings {
            sample_rate_hz: 25_000_000,
            duration_ms: 10,
            channel_count: 16,
            ..CaptureSettings::default()
        })
        .unwrap();
        let frames = decode_uart(&capture, &UartDecodeSettings::default()).unwrap();
        let text: String = frames.iter().map(|frame| frame.value as char).collect();
        assert!(text.starts_with("PXLogic"));
    }
}
