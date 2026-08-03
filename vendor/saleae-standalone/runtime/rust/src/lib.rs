use std::ffi::{CStr, CString};
use std::os::raw::{c_char, c_int};
use std::path::{Path, PathBuf};
use std::ptr::NonNull;
use std::slice;

#[cfg(feature = "capture")]
pub mod sal;

#[cfg(feature = "capture")]
use serde::Serialize;

#[repr(C)]
struct RawSession {
    _private: [u8; 0],
}

#[repr(C)]
#[derive(Default)]
struct RawFrame {
    frame_type: *const c_char,
    start_sample: u64,
    end_sample: u64,
    field_count: usize,
}

#[repr(C)]
#[derive(Default)]
struct RawField {
    key: *const c_char,
    kind: c_int,
    string_value: *const c_char,
    bytes_value: *const u8,
    bytes_length: usize,
    integer_value: i64,
    double_value: f64,
    boolean_value: c_int,
}

#[repr(C)]
#[derive(Default)]
struct RawLegacyFrame {
    start_sample: i64,
    end_sample: i64,
    data1: u64,
    data2: u64,
    frame_type: u8,
    flags: u8,
}

#[repr(C)]
#[derive(Default)]
struct RawSimulationChannel {
    channel_index: u32,
    initial_high: c_int,
    sample_count: u64,
    transition_samples: *const u64,
    transition_count: usize,
}

unsafe extern "C" {
    fn sr_session_create(plugin_path: *const c_char) -> *mut RawSession;
    fn sr_session_destroy(session: *mut RawSession);
    fn sr_session_analyzer_name(session: *const RawSession) -> *const c_char;
    fn sr_session_last_error(session: *const RawSession) -> *const c_char;
    fn sr_session_set_sample_rate(session: *mut RawSession, sample_rate_hz: u64) -> c_int;
    fn sr_session_set_number_setting(
        session: *mut RawSession,
        setting_title: *const c_char,
        value: f64,
    ) -> c_int;
    fn sr_session_set_integer_setting(
        session: *mut RawSession,
        setting_title: *const c_char,
        value: c_int,
    ) -> c_int;
    fn sr_session_set_bool_setting(
        session: *mut RawSession,
        setting_title: *const c_char,
        value: c_int,
    ) -> c_int;
    fn sr_session_channel_setting_count(session: *mut RawSession) -> usize;
    fn sr_session_channel_setting_title(session: *mut RawSession, index: usize) -> *const c_char;
    fn sr_session_add_channel(
        session: *mut RawSession,
        setting_title: *const c_char,
        channel_index: u32,
        initial_high: c_int,
        transition_samples: *const u64,
        transition_count: usize,
    ) -> c_int;
    fn sr_session_commit_settings(session: *mut RawSession) -> c_int;
    fn sr_session_run(session: *mut RawSession) -> c_int;
    fn sr_session_generate_simulation(
        session: *mut RawSession,
        sample_count: u64,
        sample_rate_hz: u32,
    ) -> c_int;
    fn sr_session_simulation_channel_count(session: *const RawSession) -> usize;
    fn sr_session_simulation_channel(
        session: *const RawSession,
        index: usize,
        output: *mut RawSimulationChannel,
    ) -> c_int;
    fn sr_session_frame_count(session: *const RawSession) -> usize;
    fn sr_session_frame(session: *const RawSession, index: usize, output: *mut RawFrame) -> c_int;
    fn sr_session_frame_field(
        session: *const RawSession,
        frame_index: usize,
        field_index: usize,
        output: *mut RawField,
    ) -> c_int;
    fn sr_session_legacy_frame_count(session: *const RawSession) -> usize;
    fn sr_session_legacy_frame(
        session: *const RawSession,
        index: usize,
        output: *mut RawLegacyFrame,
    ) -> c_int;
}

#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(feature = "capture", derive(Serialize))]
pub enum FieldValue {
    String(String),
    Double(f64),
    Integer(i64),
    Boolean(bool),
    Byte(u8),
    Bytes(Vec<u8>),
}

#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(feature = "capture", derive(Serialize))]
pub struct Field {
    pub key: String,
    pub value: FieldValue,
}

#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(feature = "capture", derive(Serialize))]
pub struct Frame {
    pub frame_type: String,
    pub start_sample: u64,
    pub end_sample: u64,
    pub fields: Vec<Field>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "capture", derive(Serialize))]
pub struct LegacyFrame {
    pub start_sample: i64,
    pub end_sample: i64,
    pub data1: u64,
    pub data2: u64,
    pub frame_type: u8,
    pub flags: u8,
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "capture", derive(Serialize))]
pub struct SimulationChannel {
    pub channel_index: u32,
    pub initial_high: bool,
    pub sample_count: u64,
    pub transitions: Vec<u64>,
}

#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(feature = "capture", derive(Serialize))]
pub struct SimulationRun {
    pub analyzer: String,
    pub sample_rate_hz: u32,
    pub requested_sample_count: u64,
    pub channels: Vec<SimulationChannel>,
    pub frames: Vec<Frame>,
    pub legacy_frames: Vec<LegacyFrame>,
}

/// One sparse digital input connected to an analyzer channel setting.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InputChannel {
    pub setting_title: String,
    pub channel_index: u32,
    pub initial_high: bool,
    pub transitions: Vec<u64>,
}

/// A non-channel analyzer setting applied before decoding starts.
#[derive(Debug, Clone, PartialEq)]
pub enum SettingValue {
    Number(f64),
    Integer(i32),
    Boolean(bool),
}

#[derive(Debug, Clone, PartialEq)]
pub struct AnalyzerSettingValue {
    pub title: String,
    pub value: SettingValue,
}

/// Frames returned by a standalone analyzer invocation.
#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(feature = "capture", derive(Serialize))]
pub struct DecodeRun {
    pub analyzer: String,
    pub frames: Vec<Frame>,
    pub legacy_frames: Vec<LegacyFrame>,
}

pub struct Session {
    raw: NonNull<RawSession>,
}

impl Session {
    pub fn load(plugin: &Path) -> Result<Self, String> {
        let path =
            CString::new(plugin.to_string_lossy().as_bytes()).map_err(|error| error.to_string())?;
        let raw = NonNull::new(unsafe { sr_session_create(path.as_ptr()) })
            .ok_or_else(|| "runtime could not allocate a session".to_owned())?;
        let session = Self { raw };
        if session.analyzer_name().is_empty() {
            return Err(session.last_error());
        }
        Ok(session)
    }

    pub fn analyzer_name(&self) -> String {
        unsafe { copy_c_string(sr_session_analyzer_name(self.raw.as_ptr())) }
    }

    pub fn set_sample_rate(&mut self, sample_rate_hz: u64) -> Result<(), String> {
        self.check(unsafe { sr_session_set_sample_rate(self.raw.as_ptr(), sample_rate_hz) })
    }

    pub fn set_number_setting(&mut self, title: &str, value: f64) -> Result<(), String> {
        let title = CString::new(title).map_err(|error| error.to_string())?;
        self.check(unsafe {
            sr_session_set_number_setting(self.raw.as_ptr(), title.as_ptr(), value)
        })
    }

    pub fn set_integer_setting(&mut self, title: &str, value: i32) -> Result<(), String> {
        let title = CString::new(title).map_err(|error| error.to_string())?;
        self.check(unsafe {
            sr_session_set_integer_setting(self.raw.as_ptr(), title.as_ptr(), value)
        })
    }

    pub fn set_bool_setting(&mut self, title: &str, value: bool) -> Result<(), String> {
        let title = CString::new(title).map_err(|error| error.to_string())?;
        self.check(unsafe {
            sr_session_set_bool_setting(self.raw.as_ptr(), title.as_ptr(), value as c_int)
        })
    }

    pub fn channel_setting_titles(&mut self) -> Result<Vec<String>, String> {
        let count = unsafe { sr_session_channel_setting_count(self.raw.as_ptr()) };
        let mut titles = Vec::with_capacity(count);
        for index in 0..count {
            let title = unsafe {
                copy_c_string(sr_session_channel_setting_title(self.raw.as_ptr(), index))
            };
            if title.is_empty() {
                return Err(format!("runtime rejected channel setting index {index}"));
            }
            titles.push(title);
        }
        Ok(titles)
    }

    pub fn add_channel(
        &mut self,
        title: &str,
        channel_index: u32,
        initial_high: bool,
        transitions: &[u64],
    ) -> Result<(), String> {
        let title = CString::new(title).map_err(|error| error.to_string())?;
        self.check(unsafe {
            sr_session_add_channel(
                self.raw.as_ptr(),
                title.as_ptr(),
                channel_index,
                initial_high as c_int,
                transitions.as_ptr(),
                transitions.len(),
            )
        })
    }

    pub fn commit_settings(&mut self) -> Result<(), String> {
        self.check(unsafe { sr_session_commit_settings(self.raw.as_ptr()) })
    }

    pub fn run(&mut self) -> Result<(), String> {
        self.check(unsafe { sr_session_run(self.raw.as_ptr()) })
    }

    pub fn generate_simulation(
        &mut self,
        sample_count: u64,
        sample_rate_hz: u32,
    ) -> Result<Vec<SimulationChannel>, String> {
        self.check(unsafe {
            sr_session_generate_simulation(self.raw.as_ptr(), sample_count, sample_rate_hz)
        })?;
        let count = unsafe { sr_session_simulation_channel_count(self.raw.as_ptr()) };
        let mut channels = Vec::with_capacity(count);
        for index in 0..count {
            let mut raw = RawSimulationChannel::default();
            if unsafe { sr_session_simulation_channel(self.raw.as_ptr(), index, &mut raw) } != 0 {
                return Err(format!("runtime rejected simulation channel index {index}"));
            }
            let transitions = if raw.transition_count == 0 {
                Vec::new()
            } else {
                unsafe {
                    slice::from_raw_parts(raw.transition_samples, raw.transition_count).to_vec()
                }
            };
            channels.push(normalize_simulation_channel(SimulationChannel {
                channel_index: raw.channel_index,
                initial_high: raw.initial_high != 0,
                sample_count: raw.sample_count,
                transitions,
            }));
        }
        Ok(channels)
    }

    pub fn frames(&self) -> Result<Vec<Frame>, String> {
        let count = unsafe { sr_session_frame_count(self.raw.as_ptr()) };
        let mut frames = Vec::with_capacity(count);
        for frame_index in 0..count {
            let mut raw_frame = RawFrame::default();
            if unsafe { sr_session_frame(self.raw.as_ptr(), frame_index, &mut raw_frame) } != 0 {
                return Err("runtime rejected a frame index".to_owned());
            }

            let mut fields = Vec::with_capacity(raw_frame.field_count);
            for field_index in 0..raw_frame.field_count {
                let mut raw_field = RawField::default();
                if unsafe {
                    sr_session_frame_field(
                        self.raw.as_ptr(),
                        frame_index,
                        field_index,
                        &mut raw_field,
                    )
                } != 0
                {
                    return Err("runtime rejected a frame field index".to_owned());
                }
                fields.push(Field {
                    key: unsafe { copy_c_string(raw_field.key) },
                    value: unsafe { copy_field_value(&raw_field)? },
                });
            }

            frames.push(Frame {
                frame_type: unsafe { copy_c_string(raw_frame.frame_type) },
                start_sample: raw_frame.start_sample,
                end_sample: raw_frame.end_sample,
                fields,
            });
        }
        Ok(frames)
    }

    pub fn legacy_frames(&self) -> Result<Vec<LegacyFrame>, String> {
        let count = unsafe { sr_session_legacy_frame_count(self.raw.as_ptr()) };
        let mut frames = Vec::with_capacity(count);
        for index in 0..count {
            let mut raw = RawLegacyFrame::default();
            if unsafe { sr_session_legacy_frame(self.raw.as_ptr(), index, &mut raw) } != 0 {
                return Err("runtime rejected a legacy frame index".to_owned());
            }
            frames.push(LegacyFrame {
                start_sample: raw.start_sample,
                end_sample: raw.end_sample,
                data1: raw.data1,
                data2: raw.data2,
                frame_type: raw.frame_type,
                flags: raw.flags,
            });
        }
        Ok(frames)
    }

    fn check(&self, status: c_int) -> Result<(), String> {
        if status == 0 {
            Ok(())
        } else {
            Err(self.last_error())
        }
    }

    fn last_error(&self) -> String {
        unsafe { copy_c_string(sr_session_last_error(self.raw.as_ptr())) }
    }
}

fn normalize_simulation_channel(mut channel: SimulationChannel) -> SimulationChannel {
    let mut normalized = Vec::with_capacity(channel.transitions.len());
    for sample in channel.transitions {
        if sample == 0 {
            channel.initial_high = !channel.initial_high;
        } else if normalized.last() == Some(&sample) {
            normalized.pop();
        } else {
            normalized.push(sample);
        }
    }
    channel.transitions = normalized;
    channel
}

impl Drop for Session {
    fn drop(&mut self) {
        unsafe { sr_session_destroy(self.raw.as_ptr()) }
    }
}

unsafe fn copy_c_string(value: *const c_char) -> String {
    if value.is_null() {
        String::new()
    } else {
        CStr::from_ptr(value).to_string_lossy().into_owned()
    }
}

unsafe fn copy_field_value(field: &RawField) -> Result<FieldValue, String> {
    match field.kind {
        1 => Ok(FieldValue::String(copy_c_string(field.string_value))),
        2 => Ok(FieldValue::Double(field.double_value)),
        3 => Ok(FieldValue::Integer(field.integer_value)),
        4 => Ok(FieldValue::Boolean(field.boolean_value != 0)),
        5 => Ok(FieldValue::Byte(field.integer_value as u8)),
        6 => {
            let bytes = if field.bytes_length == 0 {
                Vec::new()
            } else {
                slice::from_raw_parts(field.bytes_value, field.bytes_length).to_vec()
            };
            Ok(FieldValue::Bytes(bytes))
        }
        kind => Err(format!("unknown field kind {kind}")),
    }
}

#[cfg(test)]
#[derive(Clone)]
struct Line {
    high: bool,
    transitions: Vec<u64>,
}

#[cfg(test)]
impl Line {
    fn new(high: bool) -> Self {
        Self {
            high,
            transitions: Vec::new(),
        }
    }

    fn set(&mut self, sample: u64, high: bool) {
        if self.high != high {
            assert!(self
                .transitions
                .last()
                .is_none_or(|previous| *previous < sample));
            self.transitions.push(sample);
            self.high = high;
        }
    }
}

#[cfg(test)]
struct I2cFixture {
    pub sample_rate_hz: u64,
    pub sda_transitions: Vec<u64>,
    pub scl_transitions: Vec<u64>,
}

#[cfg(test)]
struct I2cBuilder {
    scale: u64,
    sample: u64,
    sda: Line,
    scl: Line,
}

#[cfg(test)]
impl I2cBuilder {
    fn new(scale: u64) -> Self {
        assert!(scale > 0);
        Self {
            scale,
            sample: 10 * scale,
            sda: Line::new(true),
            scl: Line::new(true),
        }
    }

    fn start(&mut self) {
        self.sda.set(self.sample, false);
        self.sample += 10 * self.scale;
        self.scl.set(self.sample, false);
    }

    fn byte(&mut self, byte: u8, ack: bool) {
        for bit in (0..8).rev() {
            self.sample += 5 * self.scale;
            self.sda.set(self.sample, byte & (1 << bit) != 0);
            self.sample += 5 * self.scale;
            self.scl.set(self.sample, true);
            self.sample += 10 * self.scale;
            self.scl.set(self.sample, false);
        }

        self.sample += 5 * self.scale;
        self.sda.set(self.sample, !ack);
        self.sample += 5 * self.scale;
        self.scl.set(self.sample, true);
        self.sample += 10 * self.scale;
        self.scl.set(self.sample, false);
    }

    fn repeated_start(&mut self) {
        self.sample += 5 * self.scale;
        self.sda.set(self.sample, true);
        self.sample += 5 * self.scale;
        self.scl.set(self.sample, true);
        self.sample += 5 * self.scale;
        self.sda.set(self.sample, false);
        self.sample += 5 * self.scale;
        self.scl.set(self.sample, false);
    }

    fn byte_with_missing_ack_then_stop(&mut self, byte: u8) {
        assert_eq!(byte & 1, 0, "fixture needs SDA low before its STOP");
        for bit in (0..8).rev() {
            self.sample += 5 * self.scale;
            self.sda.set(self.sample, byte & (1 << bit) != 0);
            self.sample += 5 * self.scale;
            self.scl.set(self.sample, true);
            self.sample += 10 * self.scale;
            self.scl.set(self.sample, false);
        }

        self.sample += 10 * self.scale;
        self.scl.set(self.sample, true);
        self.sample += 5 * self.scale;
        self.sda.set(self.sample, true);
        self.sample += 5 * self.scale;
        self.scl.set(self.sample, false);
    }

    fn stop(&mut self) {
        self.sample += 5 * self.scale;
        self.sda.set(self.sample, false);
        self.sample += 5 * self.scale;
        self.scl.set(self.sample, true);
        self.sample += 5 * self.scale;
        self.sda.set(self.sample, true);
    }

    fn finish(self) -> I2cFixture {
        I2cFixture {
            sample_rate_hz: 10_000_000 * self.scale,
            sda_transitions: self.sda.transitions,
            scl_transitions: self.scl.transitions,
        }
    }
}

#[cfg(test)]
fn i2c_write_fixture(scale: u64) -> I2cFixture {
    let mut builder = I2cBuilder::new(scale);
    builder.start();
    builder.byte(0xa0, true);
    builder.byte(0x3c, true);
    builder.stop();
    builder.finish()
}

#[cfg(test)]
fn i2c_address_nak_fixture(scale: u64) -> I2cFixture {
    let mut builder = I2cBuilder::new(scale);
    builder.start();
    builder.byte(0xa0, false);
    builder.stop();
    builder.finish()
}

#[cfg(test)]
fn i2c_repeated_start_read_fixture(scale: u64) -> I2cFixture {
    let mut builder = I2cBuilder::new(scale);
    builder.start();
    builder.byte(0xa0, true);
    builder.byte(0x3c, true);
    builder.repeated_start();
    builder.byte(0xa1, true);
    builder.byte(0x5a, false);
    builder.stop();
    builder.finish()
}

#[cfg(test)]
fn i2c_missing_ack_fixture(scale: u64) -> I2cFixture {
    let mut builder = I2cBuilder::new(scale);
    builder.start();
    builder.byte_with_missing_ack_then_stop(0xa0);
    builder.finish()
}

#[cfg(test)]
fn default_i2c_plugin() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("build")
        .join("lib")
        .join("libi2c_analyzer.so")
}

pub fn default_plugin(analyzer_type: &str) -> Result<PathBuf, String> {
    let file = match analyzer_type.to_ascii_lowercase().as_str() {
        "async serial" => "libserial_analyzer.so",
        "atmel swi" => "libatmel_swi_analyzer.so",
        "biss" => "libbiss_analyzer.so",
        "can" => "libcan_analyzer.so",
        "dmx-512" => "libdmx_512_analyzer.so",
        "hd44780" => "libhd44780_analyzer.so",
        "hdlc" => "libhdlc_analyzer.so",
        "hdmi cec" => "libhdmi_cec_analyzer.so",
        "i2c" => "libi2c_analyzer.so",
        "i2s / pcm" => "libi2s_analyzer.so",
        "jtag" => "libjtag_analyzer.so",
        "lin" => "liblin_analyzer.so",
        "manchester" => "libmanchester_analyzer.so",
        "mdio" => "libmdio_analyzer.so",
        "midi" => "libmidi_analyzer.so",
        "modbus" => "libmodbus_analyzer.so",
        "1-wire" => "libone_wire_analyzer.so",
        "ps/2 keyboard/mouse" => "libps2_keyboard_analyzer.so",
        "simple parallel" => "libsimple_parallel_analyzer.so",
        "smbus" => "libsmbus_analyzer.so",
        "spi" => "libspi_analyzer.so",
        "swd" => "libswd_analyzer.so",
        "uni/o" => "libunio_analyzer.so",
        "usb ls and fs" => "libusb_analyzer.so",
        _ => return Err(format!("unsupported analyzer type: {analyzer_type}")),
    };
    if let Some(directory) = std::env::var_os("SALEAE_ANALYZER_PLUGIN_DIR") {
        return Ok(PathBuf::from(directory).join(file));
    }
    Ok(PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("build")
        .join("lib")
        .join(file))
}

pub fn simulate_and_decode(
    plugin: &Path,
    sample_rate_hz: u32,
    sample_count: u64,
) -> Result<SimulationRun, String> {
    if sample_rate_hz == 0 || sample_count == 0 {
        return Err("sample rate and sample count must be greater than zero".to_owned());
    }

    let mut generator = Session::load(plugin)?;
    generator.set_sample_rate(u64::from(sample_rate_hz))?;
    let channel_titles = generator.channel_setting_titles()?;
    if channel_titles.is_empty() {
        return Err("analyzer exposes no channel settings".to_owned());
    }
    for (index, title) in channel_titles.iter().enumerate() {
        generator.add_channel(title, index as u32, false, &[])?;
    }
    generator.commit_settings()?;
    let channels = generator.generate_simulation(sample_count, sample_rate_hz)?;
    if channels.is_empty() {
        return Err("analyzer generated no simulation channels".to_owned());
    }

    let analyzer = generator.analyzer_name();
    let mut decoder = Session::load(plugin)?;
    decoder.set_sample_rate(u64::from(sample_rate_hz))?;
    for (index, title) in channel_titles.iter().enumerate() {
        if let Some(channel) = channels
            .iter()
            .find(|channel| channel.channel_index == index as u32)
        {
            decoder.add_channel(
                title,
                channel.channel_index,
                channel.initial_high,
                &channel.transitions,
            )?;
        } else {
            decoder.add_channel(title, index as u32, false, &[])?;
        }
    }
    decoder.commit_settings()?;
    decoder.run()?;

    let frames = decoder.frames()?;
    let legacy_frames = decoder.legacy_frames()?;
    if frames.is_empty() && legacy_frames.is_empty() {
        return Err("generated waveform decoded to zero frames".to_owned());
    }

    Ok(SimulationRun {
        analyzer,
        sample_rate_hz,
        requested_sample_count: sample_count,
        channels,
        frames,
        legacy_frames,
    })
}

/// Decode sparse digital transitions without depending on a capture file format.
///
/// Transition samples must be strictly increasing for each channel. The input
/// slices are copied into the compatibility runtime before this function returns.
pub fn decode_transitions(
    plugin: &Path,
    sample_rate_hz: u64,
    channels: &[InputChannel],
    settings: &[AnalyzerSettingValue],
) -> Result<DecodeRun, String> {
    if sample_rate_hz == 0 {
        return Err("sample rate must be greater than zero".to_owned());
    }
    if channels.is_empty() {
        return Err("at least one analyzer channel is required".to_owned());
    }
    for channel in channels {
        if channel.setting_title.is_empty() {
            return Err("channel setting title must not be empty".to_owned());
        }
        if channel
            .transitions
            .windows(2)
            .any(|pair| pair[0] >= pair[1])
        {
            return Err(format!(
                "{} transitions must be strictly increasing",
                channel.setting_title
            ));
        }
    }

    let mut session = Session::load(plugin)?;
    session.set_sample_rate(sample_rate_hz)?;
    for setting in settings {
        match setting.value {
            SettingValue::Number(value) => session.set_number_setting(&setting.title, value)?,
            SettingValue::Integer(value) => session.set_integer_setting(&setting.title, value)?,
            SettingValue::Boolean(value) => session.set_bool_setting(&setting.title, value)?,
        }
    }
    for channel in channels {
        session.add_channel(
            &channel.setting_title,
            channel.channel_index,
            channel.initial_high,
            &channel.transitions,
        )?;
    }
    session.commit_settings()?;
    session.run()?;

    Ok(DecodeRun {
        analyzer: session.analyzer_name(),
        frames: session.frames()?,
        legacy_frames: session.legacy_frames()?,
    })
}

#[cfg(feature = "capture")]
pub fn decode_sal_capture(
    capture: &sal::SalCapture,
    analyzer: &sal::AnalyzerConfig,
    plugin: &Path,
) -> Result<(Vec<Frame>, Vec<LegacyFrame>), String> {
    let mut session = Session::load(plugin)?;
    session.set_sample_rate(capture.sample_rate_hz)?;
    for setting in &analyzer.settings {
        match setting.kind() {
            Some("Channel") => {
                let Some(index) = setting.channel() else {
                    continue;
                };
                let channel = capture.channel(index).ok_or_else(|| {
                    format!(
                        "{} uses D{index}, which is not present in the capture",
                        setting.title
                    )
                })?;
                session.add_channel(
                    &setting.title,
                    index,
                    channel.initial_high,
                    &channel.transitions,
                )?;
            }
            Some("NumberList") => {
                let value = setting
                    .number()
                    .ok_or_else(|| format!("{} has no numeric value", setting.title))?;
                session.set_number_setting(&setting.title, value)?;
            }
            Some("Integer") => {
                let value = setting
                    .number()
                    .ok_or_else(|| format!("{} has no integer value", setting.title))?;
                session.set_integer_setting(&setting.title, value as i32)?;
            }
            Some("Bool") => {
                let value = setting
                    .setting
                    .get("value")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false);
                session.set_bool_setting(&setting.title, value)?;
            }
            Some(kind) => {
                return Err(format!(
                    "setting type {kind} is not implemented for {}",
                    setting.title
                ));
            }
            None => return Err(format!("{} has no setting type", setting.title)),
        }
    }
    session.commit_settings()?;
    session.run()?;
    Ok((session.frames()?, session.legacy_frames()?))
}

#[cfg(test)]
fn run_i2c_fixture(fixture: &I2cFixture) -> Result<(Vec<Frame>, Vec<LegacyFrame>), String> {
    let mut session = Session::load(&default_i2c_plugin())?;
    session.set_sample_rate(fixture.sample_rate_hz)?;
    session.add_channel("SDA", 0, true, &fixture.sda_transitions)?;
    session.add_channel("SCL", 1, true, &fixture.scl_transitions)?;
    session.commit_settings()?;
    session.run()?;
    Ok((session.frames()?, session.legacy_frames()?))
}

#[cfg(test)]
fn decode_i2c_fixture(scale: u64) -> Result<Vec<Frame>, String> {
    Ok(run_i2c_fixture(&i2c_write_fixture(scale))?.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    #[test]
    fn transition_api_rejects_non_increasing_edges() {
        let channel = InputChannel {
            setting_title: "SDA".to_owned(),
            channel_index: 0,
            initial_high: true,
            transitions: vec![10, 10],
        };
        let error = decode_transitions(
            Path::new("plugin-is-not-loaded-before-input-validation"),
            10_000_000,
            &[channel],
            &[],
        )
        .unwrap_err();
        assert_eq!(error, "SDA transitions must be strictly increasing");
    }

    fn field<'a>(frame: &'a Frame, key: &str) -> &'a FieldValue {
        &frame
            .fields
            .iter()
            .find(|field| field.key == key)
            .unwrap()
            .value
    }

    fn packed_samples(fixture: &I2cFixture) -> Vec<u8> {
        let final_sample = fixture
            .sda_transitions
            .last()
            .into_iter()
            .chain(fixture.scl_transitions.last())
            .copied()
            .max()
            .unwrap()
            + 20;
        let mut sda_high = true;
        let mut scl_high = true;
        let mut sda_edges = fixture.sda_transitions.iter().peekable();
        let mut scl_edges = fixture.scl_transitions.iter().peekable();
        let mut samples = Vec::with_capacity(final_sample as usize + 1);

        for sample in 0..=final_sample {
            if sda_edges.peek().is_some_and(|edge| **edge == sample) {
                sda_high = !sda_high;
                sda_edges.next();
            }
            if scl_edges.peek().is_some_and(|edge| **edge == sample) {
                scl_high = !scl_high;
                scl_edges.next();
            }
            samples.push(u8::from(sda_high) | (u8::from(scl_high) << 1));
        }
        samples
    }

    #[test]
    fn decodes_independent_i2c_write_vector() {
        let frames = decode_i2c_fixture(1).unwrap();
        assert_eq!(
            frames
                .iter()
                .map(|frame| frame.frame_type.as_str())
                .collect::<Vec<_>>(),
            ["start", "address", "data", "stop"]
        );
        assert_eq!(field(&frames[1], "address"), &FieldValue::Byte(0x50));
        assert_eq!(field(&frames[1], "read"), &FieldValue::Boolean(false));
        assert_eq!(field(&frames[1], "ack"), &FieldValue::Boolean(true));
        assert_eq!(field(&frames[2], "data"), &FieldValue::Byte(0x3c));
        assert_eq!(field(&frames[2], "ack"), &FieldValue::Boolean(true));
        assert_eq!(
            frames
                .iter()
                .map(|frame| (frame.start_sample, frame.end_sample))
                .collect::<Vec<_>>(),
            [(10, 11), (30, 200), (210, 380), (395, 396)]
        );
    }

    #[test]
    fn decoded_values_are_invariant_under_timing_scale() {
        let normal = decode_i2c_fixture(1).unwrap();
        let scaled = decode_i2c_fixture(2).unwrap();
        let semantic = |frames: &[Frame]| {
            frames
                .iter()
                .map(|frame| (frame.frame_type.clone(), frame.fields.clone()))
                .collect::<Vec<_>>()
        };
        assert_eq!(semantic(&normal), semantic(&scaled));
        for (normal, scaled) in normal.iter().zip(&scaled) {
            assert_eq!(scaled.start_sample, normal.start_sample * 2);
            if matches!(normal.frame_type.as_str(), "start" | "stop") {
                assert_eq!(scaled.end_sample, scaled.start_sample + 1);
            } else {
                assert_eq!(scaled.end_sample, normal.end_sample * 2);
            }
        }
    }

    #[test]
    fn decodes_nak_without_turning_it_into_ack() {
        let (frames, _) = run_i2c_fixture(&i2c_address_nak_fixture(1)).unwrap();
        assert_eq!(
            frames
                .iter()
                .map(|frame| frame.frame_type.as_str())
                .collect::<Vec<_>>(),
            ["start", "address", "stop"]
        );
        assert_eq!(field(&frames[1], "address"), &FieldValue::Byte(0x50));
        assert_eq!(field(&frames[1], "ack"), &FieldValue::Boolean(false));
    }

    #[test]
    fn decodes_repeated_start_and_read_direction() {
        let (frames, _) = run_i2c_fixture(&i2c_repeated_start_read_fixture(1)).unwrap();
        assert_eq!(
            frames
                .iter()
                .map(|frame| frame.frame_type.as_str())
                .collect::<Vec<_>>(),
            ["start", "address", "data", "start", "address", "data", "stop"]
        );
        assert_eq!(field(&frames[4], "address"), &FieldValue::Byte(0x50));
        assert_eq!(field(&frames[4], "read"), &FieldValue::Boolean(true));
        assert_eq!(field(&frames[5], "data"), &FieldValue::Byte(0x5a));
        assert_eq!(field(&frames[5], "ack"), &FieldValue::Boolean(false));
    }

    #[test]
    fn reports_a_stop_during_the_ack_slot_as_missing_ack() {
        let (frames, legacy) = run_i2c_fixture(&i2c_missing_ack_fixture(1)).unwrap();
        // The analyzer submits STOP while detecting the fault, before it submits the malformed byte.
        assert_eq!(
            frames
                .iter()
                .map(|frame| frame.frame_type.as_str())
                .collect::<Vec<_>>(),
            ["start", "stop", "data"]
        );
        assert_eq!(
            field(&frames[2], "error"),
            &FieldValue::String("missing ack/nak".to_owned())
        );
        assert_eq!(field(&frames[2], "data"), &FieldValue::Byte(0xa0));
        assert_eq!(legacy.len(), 1);
        assert_eq!(legacy[0].data1, 0xa0);
    }

    #[test]
    fn frame_v2_matches_the_analyzers_legacy_bytes() {
        let (frames, legacy) = run_i2c_fixture(&i2c_write_fixture(1)).unwrap();
        assert_eq!(legacy.len(), 2);
        assert_eq!(legacy[0].data1, 0xa0);
        assert_eq!(legacy[1].data1, 0x3c);
        assert_eq!(legacy[0].start_sample as u64, frames[1].start_sample);
        assert_eq!(legacy[0].end_sample as u64, frames[1].end_sample);
        assert_eq!(
            field(&frames[1], "address"),
            &FieldValue::Byte((legacy[0].data1 >> 1) as u8)
        );
        assert_eq!(
            field(&frames[2], "data"),
            &FieldValue::Byte(legacy[1].data1 as u8)
        );
    }

    #[test]
    #[ignore = "requires sigrok-cli as an independent decoder oracle"]
    fn independent_sigrok_decoder_agrees_with_saleae_output() {
        let fixture = i2c_write_fixture(1);
        let path = std::env::temp_dir().join(format!(
            "saleae-runtime-i2c-vector-{}.bin",
            std::process::id()
        ));
        std::fs::write(&path, packed_samples(&fixture)).unwrap();
        let input_format = format!("binary:numchannels=2:samplerate={}", fixture.sample_rate_hz);
        let output = Command::new("sigrok-cli")
            .args([
                "--input-file",
                path.to_str().unwrap(),
                "--input-format",
                &input_format,
                "--protocol-decoders",
                "i2c:scl=1:sda=0",
                "--protocol-decoder-samplenum",
            ])
            .output()
            .unwrap();
        std::fs::remove_file(path).unwrap();

        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let decoded = String::from_utf8(output.stdout).unwrap();
        assert!(decoded.contains("Address write: 50"), "{decoded}");
        assert!(decoded.contains("Data write: 3C"), "{decoded}");
        assert_eq!(decoded.matches("ACK").count(), 2, "{decoded}");
    }
}

#[cfg(all(test, feature = "validation"))]
mod official_csv_golden_tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Debug, Deserialize)]
    struct GoldenRow {
        name: String,
        #[serde(rename = "type")]
        frame_type: String,
        start_time: f64,
        duration: f64,
        #[serde(default)]
        ack: String,
        #[serde(default)]
        address: String,
        #[serde(default)]
        read: String,
        #[serde(default)]
        data: String,
        #[serde(default)]
        mosi: String,
        #[serde(default)]
        miso: String,
    }

    fn field<'a>(frame: &'a Frame, key: &str) -> Option<&'a FieldValue> {
        frame
            .fields
            .iter()
            .find(|field| field.key == key)
            .map(|field| &field.value)
    }

    fn hex_byte(value: &str) -> u8 {
        u8::from_str_radix(value.trim_start_matches("0x"), 16).unwrap()
    }

    fn expected_boolean(value: &str) -> Option<FieldValue> {
        (!value.is_empty()).then(|| FieldValue::Boolean(value.parse().unwrap()))
    }

    fn expected_byte(value: &str) -> Option<FieldValue> {
        (!value.is_empty()).then(|| FieldValue::Byte(hex_byte(value)))
    }

    fn expected_bytes(value: &str) -> Option<FieldValue> {
        (!value.is_empty()).then(|| FieldValue::Bytes(vec![hex_byte(value)]))
    }

    fn assert_matches_csv(sal_file: &str, csv_file: &str, analyzer_type: &str) {
        let assets = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../assets");
        let capture = sal::open(assets.join(sal_file), &sal::ReaderOptions::default()).unwrap();
        let analyzer = capture
            .session
            .analyzers
            .iter()
            .find(|analyzer| analyzer.analyzer_type.eq_ignore_ascii_case(analyzer_type))
            .unwrap();
        let plugin = default_plugin(analyzer_type).unwrap();
        let frames = decode_sal_capture(&capture, analyzer, &plugin).unwrap().0;
        let mut csv = csv::Reader::from_path(assets.join(csv_file)).unwrap();
        let rows = csv
            .deserialize::<GoldenRow>()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();

        assert_eq!(frames.len(), rows.len());
        for (index, (frame, row)) in frames.iter().zip(&rows).enumerate() {
            assert_eq!(row.name, analyzer_type, "row {} name", index + 2);
            assert_eq!(frame.frame_type, row.frame_type, "row {} type", index + 2);
            assert_eq!(
                frame.start_sample,
                (row.start_time * capture.sample_rate_hz as f64).round() as u64,
                "row {} start",
                index + 2
            );
            assert_eq!(
                frame.end_sample - frame.start_sample,
                (row.duration * capture.sample_rate_hz as f64).round() as u64,
                "row {} duration",
                index + 2
            );

            assert_eq!(
                field(frame, "ack").cloned(),
                expected_boolean(&row.ack),
                "row {} ack",
                index + 2
            );
            assert_eq!(
                field(frame, "address").cloned(),
                expected_byte(&row.address),
                "row {} address",
                index + 2
            );
            assert_eq!(
                field(frame, "read").cloned(),
                expected_boolean(&row.read),
                "row {} read",
                index + 2
            );
            assert_eq!(
                field(frame, "data").cloned(),
                expected_byte(&row.data),
                "row {} data",
                index + 2
            );
            assert_eq!(
                field(frame, "mosi").cloned(),
                expected_bytes(&row.mosi),
                "row {} mosi",
                index + 2
            );
            assert_eq!(
                field(frame, "miso").cloned(),
                expected_bytes(&row.miso),
                "row {} miso",
                index + 2
            );
        }
    }

    #[test]
    #[ignore = "requires Logic.app, Graph sidecar, and supplied golden assets"]
    fn i2c_matches_every_official_csv_row() {
        assert_matches_csv("demo-i2c.sal", "demo-i2c.csv", "I2C");
    }

    #[test]
    #[ignore = "requires Logic.app, Graph sidecar, and supplied golden assets"]
    fn spi_matches_every_official_csv_row() {
        assert_matches_csv("demo-spi.sal", "demo-spi.csv", "SPI");
    }
}
