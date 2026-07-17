use chrono::Utc;

use crate::{
    error::{CoreError, Result},
    models::{CaptureData, CaptureMetadata, CaptureMode, CaptureSettings},
    protocol,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GpioTiming {
    pub mode: u32,
    pub div: u32,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CaptureProfile {
    pub stream_mode: bool,
    pub filter: u8,
    pub clock_edge: u8,
    pub ext_trigger_mode: u32,
    pub trigger_out_enable: u32,
    pub trigger_zero: u32,
    pub trigger_one: u32,
    pub trigger_rise: u32,
    pub trigger_fall: u32,
    pub trigger_pos: u32,
    pub vth_volts: f64,
}

impl Default for CaptureProfile {
    fn default() -> Self {
        Self {
            stream_mode: false,
            filter: 0,
            clock_edge: 0,
            ext_trigger_mode: 0,
            trigger_out_enable: 0,
            trigger_zero: 0,
            trigger_one: 0,
            trigger_rise: 0,
            trigger_fall: 0,
            trigger_pos: 64,
            vth_volts: 2.0,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RegisterWrite {
    pub addr: u32,
    pub value: u32,
}

pub fn supported_samplerates() -> &'static [u64] {
    &[
        2_000,
        5_000,
        10_000,
        20_000,
        40_000,
        50_000,
        100_000,
        200_000,
        400_000,
        500_000,
        1_000_000,
        2_000_000,
        4_000_000,
        5_000_000,
        10_000_000,
        20_000_000,
        25_000_000,
        50_000_000,
        100_000_000,
        125_000_000,
        200_000_000,
        250_000_000,
        400_000_000,
        500_000_000,
        800_000_000,
        1_000_000_000,
    ]
}

pub fn gpio_timing_for_samplerate(sample_rate_hz: u64) -> Result<GpioTiming> {
    let timing = match sample_rate_hz {
        1_000_000_000 => GpioTiming { mode: 0, div: 0 },
        500_000_000 => GpioTiming { mode: 1, div: 0 },
        250_000_000 => GpioTiming { mode: 2, div: 0 },
        125_000_000 => GpioTiming { mode: 3, div: 0 },
        800_000_000 => GpioTiming { mode: 4, div: 0 },
        400_000_000 => GpioTiming { mode: 5, div: 0 },
        200_000_000 => GpioTiming { mode: 6, div: 0 },
        100_000_000 => GpioTiming { mode: 7, div: 0 },
        50_000_000 => GpioTiming { mode: 7, div: 1 },
        25_000_000 => GpioTiming { mode: 7, div: 3 },
        20_000_000 => GpioTiming { mode: 7, div: 4 },
        10_000_000 => GpioTiming { mode: 7, div: 9 },
        5_000_000 => GpioTiming { mode: 7, div: 19 },
        4_000_000 => GpioTiming { mode: 7, div: 24 },
        2_000_000 => GpioTiming { mode: 7, div: 49 },
        1_000_000 => GpioTiming { mode: 7, div: 99 },
        500_000 => GpioTiming { mode: 7, div: 199 },
        400_000 => GpioTiming { mode: 7, div: 249 },
        200_000 => GpioTiming { mode: 7, div: 499 },
        100_000 => GpioTiming { mode: 7, div: 999 },
        50_000 => GpioTiming {
            mode: 7,
            div: 1_999,
        },
        40_000 => GpioTiming {
            mode: 7,
            div: 2_499,
        },
        20_000 => GpioTiming {
            mode: 7,
            div: 4_999,
        },
        10_000 => GpioTiming {
            mode: 7,
            div: 9_999,
        },
        5_000 => GpioTiming {
            mode: 7,
            div: 19_999,
        },
        2_000 => GpioTiming {
            mode: 7,
            div: 49_999,
        },
        other => return Err(CoreError::InvalidSamplerate(other)),
    };
    Ok(timing)
}

pub fn unitsize_for_channel_count(channel_count: u8) -> Result<u8> {
    match channel_count {
        1..=8 => Ok(1),
        9..=16 => Ok(2),
        17..=32 => Ok(4),
        _ => Err(CoreError::InvalidChannelCount(channel_count)),
    }
}

pub fn capture_channel_mask(channel_count: u8) -> Result<u32> {
    match channel_count {
        1..=31 => Ok((1u32 << channel_count) - 1),
        32 => Ok(u32::MAX),
        _ => Err(CoreError::InvalidChannelCount(channel_count)),
    }
}

pub fn sample_count_from_duration(
    sample_rate_hz: u64,
    duration_ms: u64,
    decode_cross: bool,
) -> Result<u64> {
    if duration_ms == 0 {
        return Err(CoreError::InvalidCaptureDuration);
    }
    let mut samples = (u128::from(sample_rate_hz) * u128::from(duration_ms)).div_ceil(1000);
    if samples == 0 {
        samples = 1;
    }
    if decode_cross {
        samples = samples.div_ceil(64) * 64;
    }
    Ok(samples
        .try_into()
        .map_err(|_| CoreError::InvalidCaptureDuration)?)
}

pub fn sample_count_from_settings(settings: &CaptureSettings, unitsize: u8) -> Result<u64> {
    match settings.mode {
        CaptureMode::Buffer => sample_count_from_duration(
            settings.sample_rate_hz,
            settings.duration_ms,
            settings.decode_cross,
        ),
        CaptureMode::Stream => {
            let buffer_bytes = settings
                .buffer_size_mb
                .max(1)
                .checked_mul(1024 * 1024)
                .ok_or(CoreError::InvalidCaptureDuration)?;
            let samples = buffer_bytes / u64::from(unitsize);
            Ok(samples.max(1))
        }
    }
}

pub fn pxview_capture_transfer_size(
    sample_rate_hz: u64,
    channel_count: u8,
    superspeed: bool,
) -> Result<usize> {
    const ALIGNMENT: u64 = 4096;
    const USB2_BITS_PER_SECOND: u64 = 480_000_000;
    const USB3_TRANSFER_CAP: u64 = 4 * 1024 * 1024;

    if !(1..=32).contains(&channel_count) {
        return Err(CoreError::InvalidChannelCount(channel_count));
    }

    let channels = u64::from(channel_count);
    let per_channel_10ms_bytes = (sample_rate_hz / 100 / 8).max(1);
    let per_channel_aligned = align_up(per_channel_10ms_bytes, ALIGNMENT)?;
    let usb_buffer_cap = if superspeed {
        USB3_TRANSFER_CAP
    } else {
        align_up(USB2_BITS_PER_SECOND / 100 / 8, ALIGNMENT)?
    };

    let candidate = per_channel_aligned
        .checked_mul(channels)
        .ok_or_else(|| CoreError::Decode("transfer size overflow".to_string()))?;
    let transfer_size = if candidate > usb_buffer_cap {
        let per_channel_blocks = (usb_buffer_cap / channels / ALIGNMENT).max(1);
        per_channel_blocks
            .checked_mul(ALIGNMENT)
            .and_then(|size| size.checked_mul(channels))
            .ok_or_else(|| CoreError::Decode("transfer size overflow".to_string()))?
    } else {
        candidate
    };

    if transfer_size > u64::from(u32::MAX) {
        return Err(CoreError::Decode(
            "transfer size does not fit hardware register".to_string(),
        ));
    }

    usize::try_from(transfer_size)
        .map_err(|_| CoreError::Decode("transfer size does not fit usize".to_string()))
}

fn align_up(value: u64, alignment: u64) -> Result<u64> {
    if alignment == 0 {
        return Err(CoreError::Decode("alignment must be non-zero".to_string()));
    }
    value
        .div_ceil(alignment)
        .checked_mul(alignment)
        .ok_or_else(|| CoreError::Decode("aligned value overflow".to_string()))
}

pub fn build_capture_register_script(
    transfer_size: u32,
    target_bytes: u64,
    channel_count: u8,
    sample_rate_hz: u64,
    profile: CaptureProfile,
) -> Result<Vec<RegisterWrite>> {
    if transfer_size == 0 {
        return Err(CoreError::Decode(
            "transfer size must be non-zero".to_string(),
        ));
    }

    let channel_mask = capture_channel_mask(channel_count)?;
    let target_total = target_bytes
        .checked_add(u64::from(transfer_size))
        .ok_or_else(|| CoreError::Decode("target byte count overflow".to_string()))?;
    let target_low = target_total as u32;
    let target_high = (target_total >> 32) as u32;
    let stream_mask = if profile.stream_mode {
        protocol::STREAM_MODE_BIT
    } else {
        0
    };
    let stream_enable_flags = protocol::STREAM_ENABLE_FLAGS_BASE | stream_mask;
    let stream_enable_pulse_flags = stream_enable_flags | protocol::STREAM_ENABLE_PULSE_FLAG;
    let stream_run_flags =
        stream_mask | (u32::from(profile.filter) << protocol::STREAM_FILTER_SHIFT);
    let gpio_timing = gpio_timing_for_samplerate(sample_rate_hz)?;
    let gpio_mode =
        gpio_timing.mode | (u32::from(profile.clock_edge) << protocol::STREAM_FILTER_SHIFT);
    let pwm_max = 120_000_000u32 / 10_000u32;
    let threshold_vth = ((profile.vth_volts * 0.5 / 3.334) * f64::from(pwm_max)) as u32;

    Ok(vec![
        RegisterWrite {
            addr: protocol::REG_THRESHOLD_PWM_MAX,
            value: pwm_max,
        },
        RegisterWrite {
            addr: protocol::REG_THRESHOLD_VALUE,
            value: threshold_vth,
        },
        RegisterWrite {
            addr: protocol::REG_STREAM_CHANNEL_ENABLE,
            value: 0,
        },
        RegisterWrite {
            addr: protocol::REG_STREAM_CONTROL,
            value: stream_enable_flags,
        },
        RegisterWrite {
            addr: protocol::REG_STREAM_CONTROL,
            value: stream_enable_pulse_flags,
        },
        RegisterWrite {
            addr: protocol::REG_STREAM_CONTROL,
            value: stream_enable_flags,
        },
        RegisterWrite {
            addr: protocol::REG_STREAM_START,
            value: protocol::STREAM_STOP_FLAGS,
        },
        RegisterWrite {
            addr: protocol::REG_STREAM_TRANSFER_SIZE,
            value: transfer_size,
        },
        RegisterWrite {
            addr: protocol::REG_STREAM_DMA_SIZE,
            value: transfer_size,
        },
        RegisterWrite {
            addr: protocol::REG_CAPTURE_BYTES_LOW,
            value: target_low,
        },
        RegisterWrite {
            addr: protocol::REG_CAPTURE_BYTES_HIGH,
            value: target_high,
        },
        RegisterWrite {
            addr: protocol::REG_EXT_TRIGGER_MODE,
            value: profile.ext_trigger_mode,
        },
        RegisterWrite {
            addr: protocol::REG_TRIGGER_OUT_ENABLE,
            value: profile.trigger_out_enable,
        },
        RegisterWrite {
            addr: protocol::REG_GPIO_MODE,
            value: gpio_mode,
        },
        RegisterWrite {
            addr: protocol::REG_GPIO_DIV,
            value: gpio_timing.div,
        },
        RegisterWrite {
            addr: protocol::REG_CAPTURE_CHANNEL_COUNT,
            value: u32::from(channel_count),
        },
        RegisterWrite {
            addr: protocol::REG_CAPTURE_TRIGGER_POS,
            value: profile.trigger_pos,
        },
        RegisterWrite {
            addr: protocol::REG_BLOCK_START,
            value: 0,
        },
        RegisterWrite {
            addr: protocol::REG_STREAM_CHANNEL_ENABLE,
            value: channel_mask,
        },
        RegisterWrite {
            addr: protocol::REG_STREAM_CONTROL,
            value: stream_run_flags,
        },
        RegisterWrite {
            addr: protocol::REG_TRIGGER_ZERO,
            value: profile.trigger_zero,
        },
        RegisterWrite {
            addr: protocol::REG_TRIGGER_ONE,
            value: profile.trigger_one,
        },
        RegisterWrite {
            addr: protocol::REG_TRIGGER_RISE,
            value: profile.trigger_rise,
        },
        RegisterWrite {
            addr: protocol::REG_TRIGGER_FALL,
            value: profile.trigger_fall,
        },
        RegisterWrite {
            addr: protocol::REG_STREAM_START,
            value: protocol::STREAM_START_FLAGS,
        },
    ])
}

pub fn decode_cross_data(channel_count: u8, input: &[u8]) -> Result<Vec<u8>> {
    decode_cross_data_with_map(channel_count, input, None, false)
}

pub fn decode_cross_data_with_map(
    channel_count: u8,
    input: &[u8],
    channel_map: Option<&[u8]>,
    reverse_bits_in_word: bool,
) -> Result<Vec<u8>> {
    let unitsize = usize::from(unitsize_for_channel_count(channel_count)?);
    let channels = usize::from(channel_count);
    if !matches!(channel_count, 16 | 32) {
        return Err(CoreError::InvalidChannelCount(channel_count));
    }
    if let Some(map) = channel_map {
        validate_cross_channel_map(channel_count, map)?;
    }

    let stripe_bytes = channels * 8;
    if input.len() % stripe_bytes != 0 {
        return Err(CoreError::Decode(
            "cross-lane input is not stripe-aligned".to_string(),
        ));
    }

    let mut output = Vec::with_capacity(input.len());
    let mut offset = 0;
    while offset < input.len() {
        let stripe = &input[offset..offset + stripe_bytes];
        let mut words = vec![0u64; channels];
        for (channel, word) in words.iter_mut().enumerate() {
            let start = channel * 8;
            *word = u64::from_le_bytes(stripe[start..start + 8].try_into().expect("fixed slice"));
        }

        for bit_index in 0..64 {
            let mut sample_word = 0u32;
            let source_bit = if reverse_bits_in_word {
                63 - bit_index
            } else {
                bit_index
            };
            for logical_channel in 0..channels {
                let physical_channel = channel_map
                    .and_then(|map| map.get(logical_channel))
                    .map(|value| usize::from(*value))
                    .unwrap_or(logical_channel);
                let word = words[physical_channel];
                let bit_value = ((word >> source_bit) & 1) as u32;
                sample_word |= bit_value << logical_channel;
            }
            write_sample_word(&mut output, sample_word, unitsize);
        }
        offset += stripe_bytes;
    }

    Ok(output)
}

fn validate_cross_channel_map(channel_count: u8, map: &[u8]) -> Result<()> {
    let channels = usize::from(channel_count);
    if map.len() != channels {
        return Err(CoreError::Decode(format!(
            "cross-lane channel map length {} does not match channel count {channels}",
            map.len()
        )));
    }

    let mut seen = vec![false; channels];
    for &physical in map {
        let physical = usize::from(physical);
        if physical >= channels {
            return Err(CoreError::Decode(format!(
                "cross-lane channel map contains out-of-range lane {physical}"
            )));
        }
        if seen[physical] {
            return Err(CoreError::Decode(format!(
                "cross-lane channel map contains duplicate lane {physical}"
            )));
        }
        seen[physical] = true;
    }
    Ok(())
}

pub fn generate_sample_words(settings: &CaptureSettings) -> Result<CaptureData> {
    gpio_timing_for_samplerate(settings.sample_rate_hz)?;
    let unitsize = unitsize_for_channel_count(settings.channel_count)?;
    let sample_count = sample_count_from_duration(
        settings.sample_rate_hz,
        settings.duration_ms,
        settings.decode_cross,
    )?;
    generate_sample_words_with_count(settings, sample_count, unitsize)
}

pub fn generate_sample_words_with_count(
    settings: &CaptureSettings,
    sample_count: u64,
    unitsize: u8,
) -> Result<CaptureData> {
    let mut samples = Vec::with_capacity(sample_count as usize * usize::from(unitsize));
    let mut demo_channels: Vec<_> = (0..settings.channel_count)
        .map(SaleaeDemoPulseChannel::new)
        .collect();
    for sample_index in 0..sample_count {
        let mut word = 0u32;
        for channel in 0..settings.channel_count {
            let high = if channel == 0 {
                demo_uart_level(sample_index, settings.sample_rate_hz)
                    .unwrap_or_else(|| demo_channels[usize::from(channel)].level_at(sample_index))
            } else {
                demo_channels[usize::from(channel)].level_at(sample_index)
            };
            if high {
                word |= 1u32 << channel;
            }
        }
        write_sample_word(&mut samples, word, usize::from(unitsize));
    }

    Ok(CaptureData {
        metadata: CaptureMetadata {
            version: 1,
            source_device: settings.device_id.clone(),
            sample_rate_hz: settings.sample_rate_hz,
            channel_count: settings.channel_count,
            unitsize,
            sample_count,
            captured_at: Utc::now(),
            labels: (0..settings.channel_count)
                .map(|index| format!("D{index}"))
                .collect(),
        },
        samples,
    })
}

// Logic Pro 16 demo captures use independent runs of 1..32768 samples per channel.
// Keep the generator deterministic so screenshots, measurements, and tests are repeatable.
struct SaleaeDemoPulseChannel {
    high: bool,
    next_edge: u64,
    random: u32,
}

impl SaleaeDemoPulseChannel {
    fn new(channel: u8) -> Self {
        let mut result = Self {
            high: false,
            next_edge: 0,
            random: 0x6D2B_79F5 ^ u32::from(channel).wrapping_mul(0x9E37_79B9),
        };
        result.next_edge = result.next_run_samples();
        result
    }

    fn level_at(&mut self, sample_index: u64) -> bool {
        if sample_index >= self.next_edge {
            self.high = !self.high;
            self.next_edge = self.next_edge.saturating_add(self.next_run_samples());
        }
        self.high
    }

    fn next_run_samples(&mut self) -> u64 {
        self.random = self
            .random
            .wrapping_mul(1_664_525)
            .wrapping_add(1_013_904_223);
        1 + u64::from((self.random >> 17) & 0x7FFF)
    }
}

fn demo_uart_level(sample_index: u64, sample_rate_hz: u64) -> Option<bool> {
    const BAUD: u64 = 115_200;
    const MESSAGE: &[u8] = b"PXLogic demo\n";
    const LEAD_IDLE_BITS: u64 = 4;
    const TRAIL_IDLE_BITS: u64 = 8;

    let bit_period = sample_rate_hz / BAUD;
    if bit_period < 8 {
        return None;
    }

    let bit_index = sample_index / bit_period;
    let cycle_bits = LEAD_IDLE_BITS + MESSAGE.len() as u64 * 10 + TRAIL_IDLE_BITS;
    let cycle_bit = bit_index % cycle_bits;
    if cycle_bit < LEAD_IDLE_BITS {
        return Some(true);
    }
    let message_bit = cycle_bit - LEAD_IDLE_BITS;
    if message_bit >= MESSAGE.len() as u64 * 10 {
        return Some(true);
    }

    let frame_index = message_bit / 10;
    let frame_bit = message_bit % 10;
    let byte = MESSAGE.get(frame_index as usize)?;
    match frame_bit {
        0 => Some(false),
        1..=8 => Some((byte >> (frame_bit - 1)) & 1 != 0),
        9 => Some(true),
        _ => Some(true),
    }
}

pub fn read_sample_word(samples: &[u8], unitsize: u8, sample_index: u64) -> Option<u32> {
    let stride = usize::from(unitsize);
    let offset = usize::try_from(sample_index).ok()?.checked_mul(stride)?;
    let bytes = samples.get(offset..offset + stride)?;
    let value = match unitsize {
        1 => u32::from(bytes[0]),
        2 => u32::from(u16::from_le_bytes(bytes.try_into().ok()?)),
        4 => u32::from_le_bytes(bytes.try_into().ok()?),
        _ => return None,
    };
    Some(value)
}

fn write_sample_word(output: &mut Vec<u8>, value: u32, unitsize: usize) {
    match unitsize {
        1 => output.push(value as u8),
        2 => output.extend_from_slice(&(value as u16).to_le_bytes()),
        4 => output.extend_from_slice(&value.to_le_bytes()),
        _ => unreachable!("unitsize is validated by caller"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_samplerates_to_gpio_timing() {
        assert_eq!(
            gpio_timing_for_samplerate(250_000_000).unwrap(),
            GpioTiming { mode: 2, div: 0 }
        );
        assert_eq!(
            gpio_timing_for_samplerate(10_000_000).unwrap(),
            GpioTiming { mode: 7, div: 9 }
        );
        assert!(gpio_timing_for_samplerate(24_000_000).is_err());
    }

    #[test]
    fn builds_pxlogic_capture_script() {
        let script =
            build_capture_register_script(4096, 65_536, 16, 250_000_000, CaptureProfile::default())
                .unwrap();
        assert_eq!(script.len(), 25);
        assert_eq!(
            script[0],
            RegisterWrite {
                addr: protocol::REG_THRESHOLD_PWM_MAX,
                value: 12_000
            }
        );
        assert_eq!(
            script[9],
            RegisterWrite {
                addr: protocol::REG_CAPTURE_BYTES_LOW,
                value: 69_632
            }
        );
        assert_eq!(
            script[18],
            RegisterWrite {
                addr: protocol::REG_STREAM_CHANNEL_ENABLE,
                value: 0x0000_FFFF
            }
        );
    }

    #[test]
    fn computes_pxview_transfer_size() {
        assert_eq!(
            pxview_capture_transfer_size(25_000_000, 32, true).unwrap(),
            1_048_576
        );
        assert_eq!(
            pxview_capture_transfer_size(25_000_000, 32, false).unwrap(),
            524_288
        );
        assert_eq!(
            pxview_capture_transfer_size(25_000_000, 16, true).unwrap(),
            524_288
        );
        assert!(pxview_capture_transfer_size(25_000_000, 0, true).is_err());
    }

    #[test]
    fn decodes_cross_lane_16_channel_stripe() {
        let mut input = vec![0u8; 16 * 8];
        let ch0 = 0b1010u64;
        let ch1 = 0b0101u64;
        input[0..8].copy_from_slice(&ch0.to_le_bytes());
        input[8..16].copy_from_slice(&ch1.to_le_bytes());

        let decoded = decode_cross_data(16, &input).unwrap();
        assert_eq!(decoded.len(), 64 * 2);
        assert_eq!(read_sample_word(&decoded, 2, 0).unwrap() & 0b11, 0b10);
        assert_eq!(read_sample_word(&decoded, 2, 1).unwrap() & 0b11, 0b01);
        assert_eq!(read_sample_word(&decoded, 2, 2).unwrap() & 0b11, 0b10);
        assert_eq!(read_sample_word(&decoded, 2, 3).unwrap() & 0b11, 0b01);
    }

    #[test]
    fn decodes_cross_lane_with_explicit_channel_map() {
        let mut input = vec![0u8; 16 * 8];
        input[0..8].copy_from_slice(&0b0001u64.to_le_bytes());
        input[8..16].copy_from_slice(&0b0010u64.to_le_bytes());
        let mut map: Vec<u8> = (0..16).collect();
        map[0] = 1;
        map[1] = 0;

        let decoded = decode_cross_data_with_map(16, &input, Some(&map), false).unwrap();
        assert_eq!(read_sample_word(&decoded, 2, 0).unwrap() & 0b11, 0b10);
        assert_eq!(read_sample_word(&decoded, 2, 1).unwrap() & 0b11, 0b01);
    }

    #[test]
    fn decodes_cross_lane_with_reversed_time_bits() {
        let mut input = vec![0u8; 16 * 8];
        input[0..8].copy_from_slice(&(1u64 << 63).to_le_bytes());
        let map: Vec<u8> = (0..16).collect();

        let decoded = decode_cross_data_with_map(16, &input, Some(&map), true).unwrap();
        assert_eq!(read_sample_word(&decoded, 2, 0).unwrap() & 0b1, 0b1);
        assert_eq!(read_sample_word(&decoded, 2, 63).unwrap() & 0b1, 0b0);
    }

    #[test]
    fn fake_capture_has_expected_size() {
        let settings = CaptureSettings {
            sample_rate_hz: 10_000,
            duration_ms: 10,
            channel_count: 16,
            ..CaptureSettings::default()
        };
        let capture = generate_sample_words(&settings).unwrap();
        assert_eq!(capture.metadata.sample_count, 128);
        assert_eq!(capture.samples.len(), 128 * 2);
    }

    #[test]
    fn demo_channels_have_varied_pulse_widths() {
        let capture = generate_sample_words(&CaptureSettings {
            sample_rate_hz: 25_000_000,
            duration_ms: 10,
            channel_count: 4,
            ..CaptureSettings::default()
        })
        .unwrap();

        let mut previous = false;
        let mut last_edge = None;
        let mut run_lengths = Vec::new();
        for sample in 0..capture.metadata.sample_count {
            let high = read_sample_word(&capture.samples, capture.metadata.unitsize, sample)
                .map(|word| word & (1 << 1) != 0)
                .unwrap();
            if high != previous {
                if let Some(last) = last_edge {
                    run_lengths.push(sample - last);
                }
                last_edge = Some(sample);
                previous = high;
            }
        }

        assert!(run_lengths.len() >= 5);
        assert!(run_lengths.windows(2).any(|pair| pair[0] != pair[1]));
        assert!(run_lengths
            .iter()
            .all(|length| (1..=32_768).contains(length)));
    }
}
