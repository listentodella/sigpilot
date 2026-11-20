//! Lossless, bounded-memory protocol triggering on the acquisition sample stream.
//!
//! This deliberately does not consume display decoder frames: those may be
//! decimated. State survives arbitrary USB chunk boundaries. Matching is O(n)
//! in samples and sequence matching is amortized O(n) in decoded words.
use serde::{Deserialize, Serialize};

use crate::{
    AnalyzerDecodeSettings, CaptureMetadata, CaptureMode, CaptureSettings, ExternalTriggerMode,
    I2cDecodeSettings, SpiDecodeSettings, UartDecodeSettings, UartParity, UartStopBits,
};

const MAX_SEQUENCE: usize = 64;
const MAX_WINDOW_MS: u64 = 60_000;
const MAX_WAIT_MS: u64 = 3_600_000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProtocolTriggerConfig {
    pub analyzer_id: String,
    pub decoder: AnalyzerDecodeSettings,
    pub condition: ProtocolTriggerCondition,
    pub pre_trigger_ms: u64,
    pub post_trigger_ms: u64,
    pub max_wait_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ProtocolTriggerCondition {
    UartSequence {
        bytes: Vec<u8>,
    },
    I2c {
        address: Option<u8>,
        event: I2cTriggerEvent,
        data: Option<u8>,
    },
    SpiSequence {
        values: Vec<u64>,
        line: SpiTriggerLine,
    },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum I2cTriggerEvent {
    Address,
    Data,
    Nack,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SpiTriggerLine {
    Mosi,
    Miso,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProtocolTriggerStatus {
    Waiting,
    Matched,
    TimedOut,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProtocolTriggerOutcome {
    pub status: ProtocolTriggerStatus,
    /// Start of the final matching byte/word, not the host callback timestamp.
    pub trigger_sample: Option<u64>,
    /// Exclusive end of the complete matching byte/word.
    pub match_end_sample: Option<u64>,
    pub retain_start_sample: Option<u64>,
    /// Exclusive end. A stopped capture can contain fewer samples than this.
    pub retain_end_sample: Option<u64>,
    pub samples_seen: u64,
    pub channel: u8,
}

fn samples_for_ms(rate: u64, ms: u64) -> Result<u64, String> {
    u64::try_from((u128::from(rate) * u128::from(ms)).div_ceil(1000))
        .map_err(|_| "Protocol trigger time exceeds the sample coordinate range".into())
}

fn validate_config(
    config: &ProtocolTriggerConfig,
    rate: u64,
    channels: u8,
    enabled: &[u8],
) -> Result<u8, String> {
    if config.analyzer_id.is_empty() || config.analyzer_id.len() > 256 {
        return Err("Protocol trigger requires an analyzer ID (1–256 bytes)".into());
    }
    if rate == 0 || channels == 0 || channels > 32 {
        return Err("Protocol trigger requires a valid digital sample format".into());
    }
    if config.pre_trigger_ms > MAX_WINDOW_MS || config.post_trigger_ms > MAX_WINDOW_MS {
        return Err("Protocol trigger pre/post windows must each be at most 60000 ms".into());
    }
    if config.max_wait_ms == 0 || config.max_wait_ms > MAX_WAIT_MS {
        return Err("Protocol trigger wait must be between 1 and 3600000 ms".into());
    }
    // Check sums as well as individual conversions before acquisition starts.
    samples_for_ms(rate, config.max_wait_ms + config.post_trigger_ms)?;
    let check_channels = |used: &[u8]| -> Result<(), String> {
        for (index, channel) in used.iter().enumerate() {
            if *channel >= channels || (!enabled.is_empty() && !enabled.contains(channel)) {
                return Err(format!("Protocol trigger channel {channel} is not enabled"));
            }
            if used[..index].contains(channel) {
                return Err("Protocol trigger channel roles must use different channels".into());
            }
        }
        Ok(())
    };
    match (&config.decoder, &config.condition) {
        (AnalyzerDecodeSettings::Uart(s), ProtocolTriggerCondition::UartSequence { bytes }) => {
            check_channels(&[s.channel])?;
            if s.baud_rate == 0 || rate / u64::from(s.baud_rate) < 8 {
                return Err("UART protocol trigger requires at least 8 samples per bit".into());
            }
            if !(5..=8).contains(&s.data_bits) {
                return Err("UART protocol trigger supports 5–8 data bits".into());
            }
            // A maliciously large negotiated rate must not truncate the
            // per-frame timing calculations below, even at one baud.
            let parity_bits = u128::from(s.parity != UartParity::None);
            let stop_half_bits = match s.stop_bits {
                UartStopBits::One => 2,
                UartStopBits::OnePointFive => 3,
                UartStopBits::Two => 4,
            };
            let frame_half_bits = 2 * (1 + u128::from(s.data_bits) + parity_bits) + stop_half_bits;
            if (u128::from(rate) * frame_half_bits).div_ceil(u128::from(s.baud_rate) * 2)
                > u128::from(u64::MAX)
            {
                return Err(
                    "UART protocol trigger frame exceeds the sample coordinate range".into(),
                );
            }
            if bytes.is_empty() || bytes.len() > MAX_SEQUENCE {
                return Err("UART trigger sequence must contain 1–64 bytes".into());
            }
            if bytes.iter().any(|b| u16::from(*b) >= (1u16 << s.data_bits)) {
                return Err("UART trigger byte exceeds the configured data width".into());
            }
            Ok(s.channel)
        }
        (
            AnalyzerDecodeSettings::I2c(s),
            ProtocolTriggerCondition::I2c {
                address,
                event,
                data,
            },
        ) => {
            check_channels(&[s.sda_channel, s.scl_channel])?;
            if address.is_some_and(|a| a > 0x7f) {
                return Err("I²C protocol trigger supports 7-bit addresses".into());
            }
            if *event == I2cTriggerEvent::Address && data.is_some() {
                return Err("An I²C address trigger cannot also specify a data byte".into());
            }
            Ok(s.sda_channel)
        }
        (
            AnalyzerDecodeSettings::Spi(s),
            ProtocolTriggerCondition::SpiSequence { values, line },
        ) => {
            let data = match line {
                SpiTriggerLine::Mosi => s.mosi_channel,
                SpiTriggerLine::Miso => s.miso_channel,
            }
            .ok_or_else(|| "The selected SPI data channel is not configured".to_string())?;
            let mut used = vec![data, s.clock_channel];
            if let Some(enable) = s.enable_channel {
                used.push(enable);
            }
            // Validate the unselected data role too: a malformed analyzer must
            // not silently acquire a different signal than its UI describes.
            let other = match line {
                SpiTriggerLine::Mosi => s.miso_channel,
                SpiTriggerLine::Miso => s.mosi_channel,
            };
            if let Some(other) = other {
                used.push(other);
            }
            check_channels(&used)?;
            if !(1..=64).contains(&s.bits_per_transfer) {
                return Err("SPI protocol trigger supports 1–64 bits per word".into());
            }
            if values.is_empty() || values.len() > MAX_SEQUENCE {
                return Err("SPI trigger sequence must contain 1–64 words".into());
            }
            if s.bits_per_transfer < 64
                && values.iter().any(|v| *v >= (1u64 << s.bits_per_transfer))
            {
                return Err("SPI trigger word exceeds the configured word width".into());
            }
            Ok(data)
        }
        _ => Err(
            "Protocol trigger requires matching UART, I²C or SPI analyzer settings and conditions"
                .into(),
        ),
    }
}

/// Validate before touching hardware; `new` also validates effective metadata
/// because a driver may negotiate a lower sample rate.
pub fn validate_request(
    config: &ProtocolTriggerConfig,
    settings: &CaptureSettings,
) -> Result<(), String> {
    if settings.mode != CaptureMode::Stream {
        return Err("Protocol trigger requires Stream capture mode".into());
    }
    let emits_interleaved = settings.device_id == crate::FakeBackend::DEVICE_ID;
    #[cfg(feature = "rusb-transport")]
    let emits_interleaved = emits_interleaved || crate::kingst_la2016::owns(&settings.device_id);
    if !emits_interleaved && !settings.decode_cross {
        return Err(
            "Protocol trigger requires decoded samples; enable PXLogic cross-lane decoding".into(),
        );
    }
    if settings.trigger_enabled
        || settings.external_trigger_mode != ExternalTriggerMode::Close
        || settings.trigger_out_enabled
    {
        return Err(
            "Protocol trigger cannot be combined with hardware/external trigger or trigger output"
                .into(),
        );
    }
    validate_config(
        config,
        settings.sample_rate_hz,
        settings.channel_count,
        &settings.enabled_channels,
    )?;
    Ok(())
}

pub struct ProtocolTriggerEngine {
    runtime: Runtime,
    outcome: ProtocolTriggerOutcome,
    unitsize: usize,
    partial: [u8; 4],
    partial_len: usize,
    wait_samples: u64,
    pre_samples: u64,
    post_samples: u64,
}

impl ProtocolTriggerEngine {
    pub fn new(config: ProtocolTriggerConfig, metadata: &CaptureMetadata) -> Result<Self, String> {
        let channel = validate_config(
            &config,
            metadata.sample_rate_hz,
            metadata.channel_count,
            &metadata.enabled_channels,
        )?;
        if ![1, 2, 4].contains(&metadata.unitsize) || metadata.channel_count > metadata.unitsize * 8
        {
            return Err(
                "Protocol trigger requires interleaved 1-, 2- or 4-byte digital samples".into(),
            );
        }
        let runtime = match (&config.decoder, &config.condition) {
            (AnalyzerDecodeSettings::Uart(s), ProtocolTriggerCondition::UartSequence { bytes }) => {
                Runtime::Uart(
                    Uart::new(s.clone(), metadata.sample_rate_hz),
                    Sequence::new(bytes.iter().map(|b| u64::from(*b)).collect()),
                )
            }
            (
                AnalyzerDecodeSettings::I2c(s),
                ProtocolTriggerCondition::I2c {
                    address,
                    event,
                    data,
                },
            ) => Runtime::I2c(I2c::new(s.clone()), *address, *event, *data),
            (
                AnalyzerDecodeSettings::Spi(s),
                ProtocolTriggerCondition::SpiSequence { values, line },
            ) => Runtime::Spi(
                Spi::new(s.clone(), channel),
                Sequence::new(values.clone()),
                *line,
            ),
            _ => unreachable!("validated above"),
        };
        Ok(Self {
            runtime,
            outcome: ProtocolTriggerOutcome {
                status: ProtocolTriggerStatus::Waiting,
                trigger_sample: None,
                match_end_sample: None,
                retain_start_sample: None,
                retain_end_sample: None,
                samples_seen: 0,
                channel,
            },
            unitsize: usize::from(metadata.unitsize),
            partial: [0; 4],
            partial_len: 0,
            wait_samples: samples_for_ms(metadata.sample_rate_hz, config.max_wait_ms)?,
            pre_samples: samples_for_ms(metadata.sample_rate_hz, config.pre_trigger_ms)?,
            post_samples: samples_for_ms(metadata.sample_rate_hz, config.post_trigger_ms)?,
        })
    }

    pub fn feed(&mut self, mut chunk: &[u8]) -> Result<(), String> {
        if self.partial_len > 0 {
            let copy = (self.unitsize - self.partial_len).min(chunk.len());
            self.partial[self.partial_len..self.partial_len + copy].copy_from_slice(&chunk[..copy]);
            self.partial_len += copy;
            chunk = &chunk[copy..];
            if self.partial_len == self.unitsize {
                self.consume(u32::from_le_bytes(self.partial))?;
                self.partial = [0; 4];
                self.partial_len = 0;
            }
        }
        let mut chunks = chunk.chunks_exact(self.unitsize);
        while let Some(bytes) = chunks.next() {
            if self.outcome.status != ProtocolTriggerStatus::Waiting {
                self.outcome.samples_seen = self
                    .outcome
                    .samples_seen
                    .checked_add(1 + chunks.len() as u64)
                    .ok_or("Protocol trigger sample counter overflow")?;
                // ChunksExact::remainder is the original incomplete tail,
                // independent of iterator position. Skip complete samples O(1).
                break;
            }
            let word = match self.unitsize {
                1 => u32::from(bytes[0]),
                2 => u32::from(u16::from_le_bytes([bytes[0], bytes[1]])),
                4 => u32::from_le_bytes(bytes.try_into().expect("four bytes")),
                _ => unreachable!(),
            };
            self.consume(word)?;
        }
        let tail = chunks.remainder();
        if !tail.is_empty() {
            self.partial[..tail.len()].copy_from_slice(tail);
            self.partial_len = tail.len();
        }
        Ok(())
    }

    fn consume(&mut self, word: u32) -> Result<(), String> {
        let index = self.outcome.samples_seen;
        self.outcome.samples_seen = index
            .checked_add(1)
            .ok_or("Protocol trigger sample counter overflow")?;
        if self.outcome.status != ProtocolTriggerStatus::Waiting {
            return Ok(());
        }
        if let Some(event) = self.runtime.tick(word, index) {
            // Acceptance requires the complete protocol event to fit inside the
            // wait budget, including the UART stop interval.
            if event.end <= self.wait_samples {
                self.outcome.status = ProtocolTriggerStatus::Matched;
                self.outcome.trigger_sample = Some(event.start);
                self.outcome.match_end_sample = Some(event.end);
                self.outcome.retain_start_sample =
                    Some(event.start.saturating_sub(self.pre_samples));
                self.outcome.retain_end_sample = Some(
                    event
                        .start
                        .checked_add(self.post_samples)
                        .ok_or("Protocol trigger window overflow")?
                        .max(event.end),
                );
            }
        }
        if self.outcome.status == ProtocolTriggerStatus::Waiting
            && self.outcome.samples_seen >= self.wait_samples
        {
            self.outcome.status = ProtocolTriggerStatus::TimedOut;
        }
        Ok(())
    }

    pub fn outcome(&self) -> ProtocolTriggerOutcome {
        self.outcome.clone()
    }
    pub fn should_stop(&self) -> bool {
        self.outcome.status == ProtocolTriggerStatus::TimedOut
            || self
                .outcome
                .retain_end_sample
                .is_some_and(|end| self.outcome.samples_seen >= end)
    }
}

struct Sequence {
    values: Vec<u64>,
    prefix: Vec<usize>,
    matched: usize,
}
impl Sequence {
    fn new(values: Vec<u64>) -> Self {
        let mut prefix = vec![0; values.len()];
        for i in 1..values.len() {
            let mut k = prefix[i - 1];
            while k > 0 && values[k] != values[i] {
                k = prefix[k - 1];
            }
            if values[k] == values[i] {
                k += 1;
            }
            prefix[i] = k;
        }
        Self {
            values,
            prefix,
            matched: 0,
        }
    }
    fn push(&mut self, value: u64) -> bool {
        while self.matched > 0 && self.values[self.matched] != value {
            self.matched = self.prefix[self.matched - 1];
        }
        if self.values[self.matched] == value {
            self.matched += 1;
        }
        if self.matched == self.values.len() {
            self.matched = self.prefix[self.matched - 1];
            true
        } else {
            false
        }
    }
    fn reset(&mut self) {
        self.matched = 0;
    }
}
#[derive(Clone, Copy)]
struct Match {
    start: u64,
    end: u64,
}
struct Word {
    value: u64,
    interval: Match,
    valid: bool,
}
enum Runtime {
    Uart(Uart, Sequence),
    I2c(I2c, Option<u8>, I2cTriggerEvent, Option<u8>),
    Spi(Spi, Sequence, SpiTriggerLine),
}
impl Runtime {
    fn tick(&mut self, word: u32, index: u64) -> Option<Match> {
        match self {
            Self::Uart(decoder, sequence) => {
                let event = decoder.tick(word, index)?;
                if !event.valid {
                    sequence.reset();
                    return None;
                }
                sequence.push(event.value).then_some(event.interval)
            }
            Self::I2c(decoder, address, event, data) => {
                let byte = decoder.tick(word, index)?;
                if address.is_some_and(|a| a != byte.address) {
                    return None;
                }
                let matches = match event {
                    I2cTriggerEvent::Address => byte.is_address,
                    I2cTriggerEvent::Data => !byte.is_address,
                    I2cTriggerEvent::Nack => byte.nack,
                };
                (matches && data.is_none_or(|d| !byte.is_address && d == byte.value))
                    .then_some(byte.interval)
            }
            Self::Spi(decoder, sequence, _line) => {
                let (reset, event) = decoder.tick(word, index);
                if reset {
                    sequence.reset();
                }
                event.filter(|e| sequence.push(e.value)).map(|e| e.interval)
            }
        }
    }
}
fn level(word: u32, channel: u8) -> bool {
    word & (1u32 << channel) != 0
}

#[derive(Clone, Copy)]
enum UartPoint {
    Start,
    Data(u8),
    Parity,
    Stop,
    Finish,
}
struct UartFrame {
    start: u64,
    cursor: usize,
    value: u64,
    valid: bool,
    checking_stop: bool,
}
struct Uart {
    settings: UartDecodeSettings,
    points: Vec<(u64, UartPoint)>,
    frame_samples: u64,
    frame: Option<UartFrame>,
    previous: Option<bool>,
    busy_until: u64,
}
impl Uart {
    fn new(settings: UartDecodeSettings, rate: u64) -> Self {
        // Quarter-bit units make half/one-and-a-half stop intervals exact. All
        // offsets are computed from the start edge, avoiding cumulative drift.
        let offset = |quarters: u64| {
            ((u128::from(rate) * u128::from(quarters)) / (u128::from(settings.baud_rate) * 4))
                as u64
        };
        let mut points = vec![(offset(2), UartPoint::Start)];
        for bit in 0..settings.data_bits {
            points.push((offset(6 + u64::from(bit) * 4), UartPoint::Data(bit)));
        }
        let mut stop_start = 4 + u64::from(settings.data_bits) * 4;
        if settings.parity != UartParity::None {
            points.push((offset(stop_start + 2), UartPoint::Parity));
            stop_start += 4;
        }
        points.push((offset(stop_start + 2), UartPoint::Stop));
        let stop_quarters = match settings.stop_bits {
            UartStopBits::One => 4,
            UartStopBits::OnePointFive => 6,
            UartStopBits::Two => 8,
        };
        if stop_quarters > 4 {
            points.push((offset(stop_start + stop_quarters - 1), UartPoint::Stop));
        }
        // A start edge is observed up to one sample after the physical edge.
        // At fractional samples/bit, valid successive frames consequently span
        // either floor or ceil samples. Require the entire minimum observable
        // frame; ceil here would mistake the next valid start for a stop error.
        let frame_samples = ((u128::from(rate) * u128::from(stop_start + stop_quarters))
            / (u128::from(settings.baud_rate) * 4)) as u64;
        // Do not publish a match while its minimum stop interval is incomplete.
        points.push((frame_samples - 1, UartPoint::Finish));
        Self {
            settings,
            points,
            frame_samples,
            frame: None,
            previous: None,
            busy_until: 0,
        }
    }
    fn tick(&mut self, word: u32, index: u64) -> Option<Word> {
        let current = level(word, self.settings.channel) != self.settings.inverted;
        let falling = self.previous == Some(true) && !current;
        self.previous = Some(current);
        if let Some(frame) = self.frame.as_mut() {
            if frame.checking_stop {
                frame.valid &= current;
            }
            let (offset, point) = self.points[frame.cursor];
            if index - frame.start >= offset {
                match point {
                    UartPoint::Start => {
                        if current {
                            self.frame = None;
                            return Some(Word {
                                value: 0,
                                interval: Match {
                                    start: index,
                                    end: index + 1,
                                },
                                valid: false,
                            });
                        }
                    }
                    UartPoint::Data(bit) => {
                        let shift = if self.settings.msb_first {
                            self.settings.data_bits - 1 - bit
                        } else {
                            bit
                        };
                        if current {
                            frame.value |= 1 << shift;
                        }
                    }
                    UartPoint::Parity => {
                        let odd = frame.value.count_ones() % 2 != 0;
                        let expected = match self.settings.parity {
                            UartParity::Even => odd,
                            UartParity::Odd => !odd,
                            UartParity::None => false,
                        };
                        frame.valid &= current == expected;
                    }
                    UartPoint::Stop => {
                        frame.valid &= current;
                        frame.checking_stop = true;
                    }
                    UartPoint::Finish => {}
                }
                frame.cursor += 1;
                if frame.cursor == self.points.len() {
                    let completed = self.frame.take().expect("active frame");
                    self.busy_until = completed.start.saturating_add(self.frame_samples);
                    return Some(Word {
                        value: completed.value,
                        valid: completed.valid,
                        interval: Match {
                            start: completed.start,
                            end: self.busy_until,
                        },
                    });
                }
            }
        } else if falling && index >= self.busy_until {
            self.frame = Some(UartFrame {
                start: index,
                cursor: 0,
                value: 0,
                valid: true,
                checking_stop: false,
            });
        }
        None
    }
}

struct I2cByte {
    address: u8,
    value: u8,
    is_address: bool,
    nack: bool,
    interval: Match,
}
struct I2c {
    settings: I2cDecodeSettings,
    previous: Option<(bool, bool)>,
    active: bool,
    bits: u8,
    value: u8,
    start: u64,
    address: Option<u8>,
    first: bool,
}
impl I2c {
    fn new(settings: I2cDecodeSettings) -> Self {
        Self {
            settings,
            previous: None,
            active: false,
            bits: 0,
            value: 0,
            start: 0,
            address: None,
            first: true,
        }
    }
    fn tick(&mut self, word: u32, index: u64) -> Option<I2cByte> {
        let sda = level(word, self.settings.sda_channel);
        let scl = level(word, self.settings.scl_channel);
        let previous = self.previous.replace((sda, scl))?;
        if scl && previous.1 && sda != previous.0 {
            self.active = !sda;
            self.bits = 0;
            self.value = 0;
            self.address = None;
            self.first = true;
            return None;
        }
        if !self.active || !scl || previous.1 {
            return None;
        }
        if self.bits < 8 {
            if self.bits == 0 {
                self.start = index;
            }
            self.value = (self.value << 1) | u8::from(sda);
            self.bits += 1;
            return None;
        }
        let is_address = self.first;
        self.first = false;
        if is_address {
            // Ten-bit addressing needs a separate transaction model. Never
            // reinterpret its prefix as a seven-bit address.
            if self.value & 0xf8 == 0xf0 {
                self.active = false;
                return None;
            }
            self.address = Some(self.value >> 1);
        }
        let event = I2cByte {
            address: self.address?,
            value: self.value,
            is_address,
            nack: sda,
            interval: Match {
                start: self.start,
                end: index + 1,
            },
        };
        self.bits = 0;
        self.value = 0;
        Some(event)
    }
}

struct Spi {
    settings: SpiDecodeSettings,
    data_channel: u8,
    previous_clock: Option<bool>,
    previous_active: Option<bool>,
    synchronized: bool,
    bits: u8,
    value: u64,
    start: u64,
}
impl Spi {
    fn new(settings: SpiDecodeSettings, data_channel: u8) -> Self {
        let synchronized = settings.enable_channel.is_none();
        Self {
            settings,
            data_channel,
            previous_clock: None,
            previous_active: None,
            synchronized,
            bits: 0,
            value: 0,
            start: 0,
        }
    }
    fn tick(&mut self, word: u32, index: u64) -> (bool, Option<Word>) {
        let clock = level(word, self.settings.clock_channel);
        let active = self
            .settings
            .enable_channel
            .is_none_or(|channel| level(word, channel) != self.settings.enable_active_low);
        let previous_clock = self.previous_clock.replace(clock);
        let previous_active = self.previous_active.replace(active);
        let reset = !active || previous_active == Some(false);
        if !active {
            self.synchronized = true;
            self.bits = 0;
            self.value = 0;
            return (true, None);
        }
        if reset {
            self.bits = 0;
            self.value = 0;
        }
        if !self.synchronized
            || previous_clock.is_none_or(|previous| previous == clock)
            || clock != (self.settings.clock_polarity == self.settings.clock_phase)
        {
            return (reset, None);
        }
        if self.bits == 0 {
            self.start = index;
        }
        let shift = if self.settings.msb_first {
            self.settings.bits_per_transfer - 1 - self.bits
        } else {
            self.bits
        };
        if level(word, self.data_channel) {
            self.value |= 1u64 << shift;
        }
        self.bits += 1;
        if self.bits != self.settings.bits_per_transfer {
            return (reset, None);
        }
        let event = Word {
            value: self.value,
            valid: true,
            interval: Match {
                start: self.start,
                end: index + 1,
            },
        };
        self.bits = 0;
        self.value = 0;
        (reset, Some(event))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;

    fn metadata() -> CaptureMetadata {
        CaptureMetadata {
            version: 1,
            source_device: "test".into(),
            sample_rate_hz: 1_000_000,
            channel_count: 8,
            enabled_channels: (0..8).collect(),
            unitsize: 1,
            sample_count: 0,
            captured_at: Utc::now(),
            labels: vec![],
            trigger: None,
        }
    }
    fn config(
        decoder: AnalyzerDecodeSettings,
        condition: ProtocolTriggerCondition,
    ) -> ProtocolTriggerConfig {
        ProtocolTriggerConfig {
            analyzer_id: "a".into(),
            decoder,
            condition,
            pre_trigger_ms: 1,
            post_trigger_ms: 1,
            max_wait_ms: 100,
        }
    }
    fn uart_config(bytes: &[u8]) -> ProtocolTriggerConfig {
        config(
            AnalyzerDecodeSettings::Uart(UartDecodeSettings {
                baud_rate: 10_000,
                ..Default::default()
            }),
            ProtocolTriggerCondition::UartSequence {
                bytes: bytes.to_vec(),
            },
        )
    }
    fn uart_signal(
        settings: &UartDecodeSettings,
        words: &[(u8, bool, bool)],
    ) -> (Vec<u8>, Vec<(u64, u64)>) {
        let mut signal = vec![u8::from(!settings.inverted); 300];
        let mut intervals = vec![];
        for &(value, parity_ok, stop_ok) in words {
            let start = signal.len() as u64;
            let mut bit = |level: bool, count: usize| {
                signal.extend(std::iter::repeat_n(
                    u8::from(level != settings.inverted),
                    count,
                ))
            };
            bit(false, 100);
            for i in 0..settings.data_bits {
                let shift = if settings.msb_first {
                    settings.data_bits - 1 - i
                } else {
                    i
                };
                bit(value & (1 << shift) != 0, 100);
            }
            if settings.parity != UartParity::None {
                let odd = value.count_ones() % 2 != 0;
                let parity = if settings.parity == UartParity::Even {
                    odd
                } else {
                    !odd
                };
                bit(parity == parity_ok, 100);
            }
            bit(stop_ok, (settings.stop_bits.as_f64() * 100.0) as usize);
            intervals.push((start, signal.len() as u64));
        }
        signal.extend(std::iter::repeat_n(u8::from(!settings.inverted), 2000));
        (signal, intervals)
    }
    fn feed_chunks(engine: &mut ProtocolTriggerEngine, samples: &[u8], size: usize) {
        for chunk in samples.chunks(size) {
            engine.feed(chunk).unwrap();
        }
    }
    #[test]
    fn uart_matches_overlapping_sequence_across_every_sample_boundary() {
        let cfg = uart_config(&[0xaa, 0xaa, 0x55]);
        let AnalyzerDecodeSettings::Uart(settings) = &cfg.decoder else {
            unreachable!()
        };
        let (signal, frames) = uart_signal(
            settings,
            &[
                (0xaa, true, true),
                (0xaa, true, true),
                (0xaa, true, true),
                (0x55, true, true),
            ],
        );
        let mut engine = ProtocolTriggerEngine::new(cfg, &metadata()).unwrap();
        feed_chunks(&mut engine, &signal, 1);
        let out = engine.outcome();
        assert_eq!(out.status, ProtocolTriggerStatus::Matched);
        assert_eq!(out.trigger_sample, Some(frames[3].0));
        assert_eq!(out.match_end_sample, Some(frames[3].1));
        assert_eq!(out.retain_start_sample, Some(frames[3].0 - 1000));
        assert_eq!(out.retain_end_sample, Some(frames[3].1));
        assert!(engine.should_stop());
    }
    #[test]
    fn uart_checks_parity_stop_width_inversion_and_order() {
        for parity in [UartParity::Even, UartParity::Odd] {
            for stop_bits in [
                UartStopBits::One,
                UartStopBits::OnePointFive,
                UartStopBits::Two,
            ] {
                let settings = UartDecodeSettings {
                    baud_rate: 10_000,
                    data_bits: 7,
                    parity,
                    stop_bits,
                    inverted: true,
                    msb_first: true,
                    ..Default::default()
                };
                let cfg = config(
                    AnalyzerDecodeSettings::Uart(settings.clone()),
                    ProtocolTriggerCondition::UartSequence { bytes: vec![0x35] },
                );
                // A framing error can erase the following start edge. Supply
                // a real idle gap before the recovery frame; no UART receiver
                // can promise word alignment on arbitrary malformed traffic.
                let (mut signal, _) =
                    uart_signal(&settings, &[(0x35, false, true), (0x35, true, false)]);
                let (recovery, frames) = uart_signal(&settings, &[(0x35, true, true)]);
                let target = signal.len() as u64 + frames[0].0;
                signal.extend(recovery);
                let mut engine = ProtocolTriggerEngine::new(cfg, &metadata()).unwrap();
                feed_chunks(&mut engine, &signal, 37);
                assert_eq!(engine.outcome().trigger_sample, Some(target));
            }
        }
    }
    #[test]
    fn uart_zero_post_window_still_retains_full_frame_and_reports_incomplete_tail() {
        let mut cfg = uart_config(&[0x55]);
        cfg.post_trigger_ms = 0;
        let AnalyzerDecodeSettings::Uart(settings) = &cfg.decoder else {
            unreachable!()
        };
        let (signal, frames) = uart_signal(settings, &[(0x55, true, true)]);
        let mut engine = ProtocolTriggerEngine::new(cfg, &metadata()).unwrap();
        engine.feed(&signal[..frames[0].1 as usize - 1]).unwrap();
        assert_eq!(engine.outcome().status, ProtocolTriggerStatus::Waiting);
        assert!(!engine.should_stop());
        engine
            .feed(&signal[frames[0].1 as usize - 1..frames[0].1 as usize])
            .unwrap();
        assert!(engine.should_stop());
        assert_eq!(engine.outcome().retain_end_sample, Some(frames[0].1));
    }
    #[test]
    fn real_demo_uart_fractional_baud_and_inverted_non8n1_trigger() {
        use crate::{capture::DemoSampleGenerator, DecoderBackendKind, DemoAnalyzerSettings};
        for (rate, baud, bits, parity, stops, inverted, msb) in [
            (
                1_000_000,
                115_200,
                8,
                UartParity::None,
                UartStopBits::One,
                false,
                false,
            ),
            (
                1_000_000,
                115_200,
                7,
                UartParity::Even,
                UartStopBits::Two,
                true,
                true,
            ),
            (
                1_000_000,
                115_200,
                7,
                UartParity::Odd,
                UartStopBits::OnePointFive,
                true,
                false,
            ),
        ] {
            let uart = UartDecodeSettings {
                channel: 0,
                baud_rate: baud,
                data_bits: bits,
                parity,
                stop_bits: stops,
                inverted,
                msb_first: msb,
            };
            let decoder = AnalyzerDecodeSettings::Uart(uart);
            let settings = CaptureSettings {
                sample_rate_hz: rate,
                channel_count: 1,
                enabled_channels: vec![0],
                ..Default::default()
            };
            let mut generator = DemoSampleGenerator::with_analyzers(
                &settings,
                1,
                &[DemoAnalyzerSettings {
                    backend: DecoderBackendKind::LegacyRust,
                    settings: decoder.clone(),
                }],
            )
            .unwrap();
            let mut meta = metadata();
            meta.sample_rate_hz = rate;
            meta.channel_count = 1;
            meta.enabled_channels = vec![0];
            let cfg = config(
                decoder,
                ProtocolTriggerCondition::UartSequence {
                    bytes: b"SigPilot demo\n".to_vec(),
                },
            );
            let mut engine = ProtocolTriggerEngine::new(cfg, &meta).unwrap();
            for _ in 0..100 {
                engine.feed(&generator.generate(113)).unwrap();
            }
            assert_eq!(engine.outcome().status,ProtocolTriggerStatus::Matched,
                "rate={rate} baud={baud} bits={bits} parity={parity:?} stops={stops:?} inverted={inverted} msb={msb}");
        }
    }
    #[test]
    fn uart_late_stop_glitch_cannot_trigger_before_it_arrives() {
        let cfg = uart_config(&[0x55]);
        let AnalyzerDecodeSettings::Uart(settings) = &cfg.decoder else {
            unreachable!()
        };
        let (mut signal, frames) = uart_signal(settings, &[(0x55, true, true)]);
        let end = frames[0].1 as usize;
        // The original center-only stop check would already have published a
        // match here. A low in the captured stop tail invalidates this byte.
        signal[end - 3] = 0;
        let mut engine = ProtocolTriggerEngine::new(cfg, &metadata()).unwrap();
        engine.feed(&signal[..end - 3]).unwrap();
        assert_eq!(engine.outcome().status, ProtocolTriggerStatus::Waiting);
        engine.feed(&signal[end - 3..]).unwrap();
        assert_eq!(engine.outcome().status, ProtocolTriggerStatus::Waiting);
    }
    #[test]
    fn uart_complete_frame_at_wait_deadline_matches_and_pre_window_clamps() {
        let mut cfg = uart_config(&[0x55]);
        cfg.max_wait_ms = 2;
        cfg.post_trigger_ms = 0;
        let AnalyzerDecodeSettings::Uart(settings) = &cfg.decoder else {
            unreachable!()
        };
        let (mut signal, _) = uart_signal(settings, &[(0x55, true, true)]);
        // Shift the 300..1300 frame to 1000..2000, precisely the deadline.
        signal.splice(0..0, std::iter::repeat_n(1, 700));
        let mut engine = ProtocolTriggerEngine::new(cfg.clone(), &metadata()).unwrap();
        engine.feed(&signal[..2000]).unwrap();
        assert_eq!(engine.outcome().status, ProtocolTriggerStatus::Matched);
        assert_eq!(engine.outcome().match_end_sample, Some(2000));
        assert_eq!(engine.outcome().retain_start_sample, Some(0));
        signal.insert(0, 1);
        let mut engine = ProtocolTriggerEngine::new(cfg, &metadata()).unwrap();
        engine.feed(&signal).unwrap();
        assert_eq!(engine.outcome().status, ProtocolTriggerStatus::TimedOut);
    }
    fn i2c_level(signal: &mut Vec<u8>, sda: bool, scl: bool) {
        signal.extend([u8::from(sda) | (u8::from(scl) << 1); 4]);
    }
    fn i2c_start(signal: &mut Vec<u8>) {
        i2c_level(signal, true, false);
        i2c_level(signal, true, true);
        i2c_level(signal, false, true);
        i2c_level(signal, false, false);
    }
    fn i2c_byte(signal: &mut Vec<u8>, byte: u8, nack: bool) -> (u64, u64) {
        let start = signal.len() as u64 + 4;
        for shift in (0..8).rev() {
            let data = byte & (1 << shift) != 0;
            i2c_level(signal, data, false);
            i2c_level(signal, data, true);
            i2c_level(signal, data, false);
        }
        i2c_level(signal, nack, false);
        let end = signal.len() as u64 + 1;
        i2c_level(signal, nack, true);
        i2c_level(signal, nack, false);
        (start, end)
    }
    fn i2c_config(
        address: Option<u8>,
        event: I2cTriggerEvent,
        data: Option<u8>,
    ) -> ProtocolTriggerConfig {
        config(
            AnalyzerDecodeSettings::I2c(I2cDecodeSettings {
                sda_channel: 0,
                scl_channel: 1,
            }),
            ProtocolTriggerCondition::I2c {
                address,
                event,
                data,
            },
        )
    }
    #[test]
    fn i2c_repeated_start_tracks_address_and_nack_without_accepting_ack() {
        let mut signal = vec![3; 8];
        i2c_start(&mut signal);
        i2c_byte(&mut signal, 0xa0, false);
        i2c_byte(&mut signal, 0x35, true);
        i2c_start(&mut signal);
        i2c_byte(&mut signal, 0xa2, false);
        i2c_byte(&mut signal, 0x35, false);
        let target = i2c_byte(&mut signal, 0x35, true);
        let mut engine = ProtocolTriggerEngine::new(
            i2c_config(Some(0x51), I2cTriggerEvent::Nack, Some(0x35)),
            &metadata(),
        )
        .unwrap();
        feed_chunks(&mut engine, &signal, 3);
        assert_eq!(engine.outcome().trigger_sample, Some(target.0));
        assert_eq!(engine.outcome().match_end_sample, Some(target.1));
    }
    #[test]
    fn i2c_address_nack_and_data_conditions_are_distinct() {
        let mut signal = vec![3; 8];
        i2c_start(&mut signal);
        let address = i2c_byte(&mut signal, 0xa1, true);
        let data = i2c_byte(&mut signal, 0x7e, false);
        for (event, filter, target) in [
            (I2cTriggerEvent::Address, None, address),
            (I2cTriggerEvent::Nack, None, address),
            (I2cTriggerEvent::Data, Some(0x7e), data),
        ] {
            let mut engine =
                ProtocolTriggerEngine::new(i2c_config(Some(0x50), event, filter), &metadata())
                    .unwrap();
            feed_chunks(&mut engine, &signal, 5);
            assert_eq!(engine.outcome().trigger_sample, Some(target.0));
        }
    }
    #[test]
    fn i2c_does_not_match_ten_bit_prefix_or_capture_started_mid_transaction() {
        for with_start in [false, true] {
            let mut signal = vec![3; 8];
            if with_start {
                i2c_start(&mut signal);
            }
            i2c_byte(&mut signal, 0xf0, true);
            i2c_byte(&mut signal, 0x35, true);
            let mut engine = ProtocolTriggerEngine::new(
                i2c_config(None, I2cTriggerEvent::Nack, None),
                &metadata(),
            )
            .unwrap();
            feed_chunks(&mut engine, &signal, 1);
            assert_eq!(engine.outcome().status, ProtocolTriggerStatus::Waiting);
        }
    }
    fn spi_level(signal: &mut Vec<u8>, clock: bool, data: bool, enabled: bool, active_low: bool) {
        signal.extend(
            [u8::from(data) | (u8::from(clock) << 1) | (u8::from(enabled != active_low) << 2); 4],
        );
    }
    fn spi_transaction(
        signal: &mut Vec<u8>,
        s: &SpiDecodeSettings,
        words: &[u64],
    ) -> Vec<(u64, u64)> {
        spi_level(signal, s.clock_polarity, false, false, s.enable_active_low);
        spi_level(signal, s.clock_polarity, false, true, s.enable_active_low);
        let mut intervals = vec![];
        for value in words {
            let mut start = 0;
            let mut end = 0;
            for bit in 0..s.bits_per_transfer {
                let shift = if s.msb_first {
                    s.bits_per_transfer - 1 - bit
                } else {
                    bit
                };
                let data = value & (1 << shift) != 0;
                spi_level(signal, s.clock_polarity, data, true, s.enable_active_low);
                if !s.clock_phase {
                    if bit == 0 {
                        start = signal.len() as u64;
                    }
                    end = signal.len() as u64 + 1;
                }
                spi_level(signal, !s.clock_polarity, data, true, s.enable_active_low);
                if s.clock_phase {
                    if bit == 0 {
                        start = signal.len() as u64;
                    }
                    end = signal.len() as u64 + 1;
                }
                spi_level(signal, s.clock_polarity, data, true, s.enable_active_low);
            }
            intervals.push((start, end));
        }
        spi_level(signal, s.clock_polarity, false, false, s.enable_active_low);
        intervals
    }
    #[test]
    fn spi_all_modes_orders_cs_polarities_and_word_widths() {
        for polarity in [false, true] {
            for phase in [false, true] {
                for msb in [false, true] {
                    for bits in [8, 16, 64] {
                        let settings = SpiDecodeSettings {
                            mosi_channel: Some(0),
                            miso_channel: None,
                            clock_channel: 1,
                            enable_channel: Some(2),
                            enable_active_low: !polarity,
                            clock_polarity: polarity,
                            clock_phase: phase,
                            bits_per_transfer: bits,
                            msb_first: msb,
                        };
                        let value = if bits == 64 { u64::MAX - 7 } else { 0xb5 };
                        let cfg = config(
                            AnalyzerDecodeSettings::Spi(settings.clone()),
                            ProtocolTriggerCondition::SpiSequence {
                                values: vec![0x35, value],
                                line: SpiTriggerLine::Mosi,
                            },
                        );
                        let mut signal = vec![];
                        let frames = spi_transaction(&mut signal, &settings, &[0x35, value]);
                        let mut engine = ProtocolTriggerEngine::new(cfg, &metadata()).unwrap();
                        feed_chunks(&mut engine, &signal, 7);
                        assert_eq!(engine.outcome().trigger_sample, Some(frames[1].0));
                        assert_eq!(engine.outcome().match_end_sample, Some(frames[1].1));
                    }
                }
            }
        }
    }
    #[test]
    fn spi_sequence_resets_at_chip_select_and_initial_active_capture_is_ignored() {
        let settings = SpiDecodeSettings {
            mosi_channel: Some(0),
            miso_channel: None,
            clock_channel: 1,
            enable_channel: Some(2),
            ..Default::default()
        };
        let cfg = config(
            AnalyzerDecodeSettings::Spi(settings.clone()),
            ProtocolTriggerCondition::SpiSequence {
                values: vec![0x35, 0x55],
                line: SpiTriggerLine::Mosi,
            },
        );
        let mut signal = vec![];
        spi_transaction(&mut signal, &settings, &[0x35]);
        spi_transaction(&mut signal, &settings, &[0x55]);
        let frames = spi_transaction(&mut signal, &settings, &[0x35, 0x55]);
        let mut engine = ProtocolTriggerEngine::new(cfg, &metadata()).unwrap();
        feed_chunks(&mut engine, &signal, 11);
        assert_eq!(engine.outcome().trigger_sample, Some(frames[1].0));
        let cfg = config(
            AnalyzerDecodeSettings::Spi(settings.clone()),
            ProtocolTriggerCondition::SpiSequence {
                values: vec![0x35],
                line: SpiTriggerLine::Mosi,
            },
        );
        let mut signal = vec![];
        spi_transaction(&mut signal, &settings, &[0x35]);
        let mut engine = ProtocolTriggerEngine::new(cfg, &metadata()).unwrap();
        engine.feed(&signal[4..]).unwrap();
        assert_eq!(engine.outcome().status, ProtocolTriggerStatus::Waiting);
    }
    #[test]
    fn partial_multibyte_samples_and_post_match_count_are_exact() {
        let cfg = uart_config(&[0x55]);
        let AnalyzerDecodeSettings::Uart(settings) = &cfg.decoder else {
            unreachable!()
        };
        let (signal, frames) = uart_signal(settings, &[(0x55, true, true)]);
        let packed: Vec<u8> = signal.iter().flat_map(|v| [*v, 0, 0, 0]).collect();
        let mut meta = metadata();
        meta.unitsize = 4;
        meta.channel_count = 32;
        let mut engine = ProtocolTriggerEngine::new(cfg, &meta).unwrap();
        feed_chunks(&mut engine, &packed, 3);
        assert_eq!(engine.outcome().trigger_sample, Some(frames[0].0));
        assert_eq!(engine.outcome().samples_seen, signal.len() as u64);
    }
    #[test]
    fn timeout_does_not_match_a_later_frame_and_counts_the_whole_chunk() {
        let mut cfg = uart_config(&[0x55]);
        cfg.max_wait_ms = 1;
        let AnalyzerDecodeSettings::Uart(settings) = &cfg.decoder else {
            unreachable!()
        };
        let (signal, _) = uart_signal(settings, &[(0x55, true, true)]);
        let mut engine = ProtocolTriggerEngine::new(cfg, &metadata()).unwrap();
        engine.feed(&signal).unwrap();
        assert_eq!(engine.outcome().status, ProtocolTriggerStatus::TimedOut);
        assert_eq!(engine.outcome().trigger_sample, None);
        assert_eq!(engine.outcome().samples_seen, signal.len() as u64);
        assert!(engine.should_stop());
    }
    #[test]
    fn rejects_invalid_format_conditions_and_unsupported_capture_modes() {
        let cfg = uart_config(&[0x55]);
        let mut settings = CaptureSettings::default();
        assert!(validate_request(&cfg, &settings).is_ok());
        settings.device_id = "usb-pxlogic:test".into();
        settings.decode_cross = false;
        assert!(validate_request(&cfg, &settings).is_err());
        settings.device_id = crate::FakeBackend::DEVICE_ID.into();
        assert!(validate_request(&cfg, &settings).is_ok());
        #[cfg(feature = "rusb-transport")]
        {
            settings.device_id = "usb-kingst:test".into();
            assert!(validate_request(&cfg, &settings).is_ok());
        }
        settings.decode_cross = true;
        settings.mode = CaptureMode::Buffer;
        assert!(validate_request(&cfg, &settings).is_err());
        settings.mode = CaptureMode::Stream;
        settings.trigger_enabled = true;
        assert!(validate_request(&cfg, &settings).is_err());
        let mut meta = metadata();
        meta.sample_rate_hz = 50_000;
        assert!(ProtocolTriggerEngine::new(cfg.clone(), &meta).is_err());
        meta = metadata();
        meta.sample_rate_hz = u64::MAX;
        let mut huge_rate = cfg.clone();
        huge_rate.max_wait_ms = 1;
        huge_rate.pre_trigger_ms = 0;
        huge_rate.post_trigger_ms = 0;
        if let AnalyzerDecodeSettings::Uart(s) = &mut huge_rate.decoder {
            s.baud_rate = 1;
        }
        assert!(ProtocolTriggerEngine::new(huge_rate, &meta).is_err());
        meta = metadata();
        meta.enabled_channels = vec![1];
        assert!(ProtocolTriggerEngine::new(cfg.clone(), &meta).is_err());
        let mut invalid = cfg.clone();
        invalid.condition = ProtocolTriggerCondition::UartSequence { bytes: vec![] };
        assert!(ProtocolTriggerEngine::new(invalid, &metadata()).is_err());
        let mut invalid = cfg;
        invalid.max_wait_ms = 0;
        assert!(ProtocolTriggerEngine::new(invalid, &metadata()).is_err());
        assert!(ProtocolTriggerEngine::new(
            i2c_config(Some(128), I2cTriggerEvent::Nack, None),
            &metadata()
        )
        .is_err());
        assert!(ProtocolTriggerEngine::new(
            i2c_config(None, I2cTriggerEvent::Address, Some(1)),
            &metadata()
        )
        .is_err());
    }
}
