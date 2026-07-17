use std::{
    env, fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};

use chrono::Utc;
use rusb::{Context, DeviceHandle, UsbContext};

use crate::{
    capture::{
        build_capture_register_script, decode_cross_data, pxview_capture_transfer_size,
        sample_count_from_settings, unitsize_for_channel_count, CaptureProfile,
    },
    error::{CoreError, Result},
    models::{
        Bitstreams, CaptureData, CaptureMetadata, CaptureMode, CaptureProgress, CaptureSettings,
        DeviceInfo, DeviceKind, DiagnosticEvent, DiagnosticLevel,
    },
    protocol,
    transport::CaptureBackend,
};

#[derive(Debug, Default, Clone)]
pub struct RusbBackend;

type TraceSink<'a> = dyn FnMut(DiagnosticEvent) + 'a;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ControlStatus {
    sync_cur_sample: u64,
    trig_out_validset: u32,
    real_pos: u32,
}

fn trace(sink: &mut TraceSink<'_>, phase: impl Into<String>, message: impl Into<String>) {
    sink(DiagnosticEvent {
        phase: phase.into(),
        level: DiagnosticLevel::Info,
        message: message.into(),
    });
}

fn trace_warn(sink: &mut TraceSink<'_>, phase: impl Into<String>, message: impl Into<String>) {
    sink(DiagnosticEvent {
        phase: phase.into(),
        level: DiagnosticLevel::Warn,
        message: message.into(),
    });
}

fn trace_stream_budget(
    settings: &CaptureSettings,
    channel_count: u8,
    speed: rusb::Speed,
    sink: &mut TraceSink<'_>,
) {
    if !matches!(settings.mode, CaptureMode::Stream) {
        return;
    }

    let bytes_per_second = settings
        .sample_rate_hz
        .saturating_mul(u64::from(channel_count))
        / 8;
    let practical_limit = match speed {
        rusb::Speed::Super | rusb::Speed::SuperPlus => 320 * 1024 * 1024,
        rusb::Speed::High => 36 * 1024 * 1024,
        _ => 1 * 1024 * 1024,
    };
    trace(
        sink,
        "stream",
        format!(
            "estimated raw rate {:.1} MB/s",
            bytes_per_second as f64 / (1024.0 * 1024.0)
        ),
    );
    if bytes_per_second > practical_limit {
        trace_warn(
            sink,
            "stream",
            format!(
                "requested stream rate is above the practical {:?} USB budget; reduce rate or channels for sustained capture",
                speed
            ),
        );
    }
}

impl RusbBackend {
    pub fn load_bitstreams() -> Result<Option<Bitstreams>> {
        if let Some(bitstreams) = Self::load_bitstreams_from_env()? {
            return Ok(Some(bitstreams));
        }

        for dir in bitstream_search_dirs() {
            if let Some(bitstreams) = load_bitstreams_from_dir(&dir)? {
                return Ok(Some(bitstreams));
            }
        }

        Ok(None)
    }

    pub fn load_bitstreams_from_env() -> Result<Option<Bitstreams>> {
        let reset = env::var_os("PXLOGIC_FPGA_RESET").map(PathBuf::from);
        let main = env::var_os("PXLOGIC_FPGA_MAIN").map(PathBuf::from);
        match (reset, main) {
            (Some(reset), Some(main)) => Ok(Some(Bitstreams {
                reset: fs::read(reset)?,
                main: fs::read(main)?,
            })),
            _ => Ok(None),
        }
    }

    pub fn load_bitstreams_from_dir(dir: impl AsRef<Path>) -> Result<Option<Bitstreams>> {
        load_bitstreams_from_dir(dir.as_ref())
    }

    pub fn prepare_device_with_trace(
        &self,
        device_id: &str,
        bitstreams: Option<&Bitstreams>,
        sink: &mut TraceSink<'_>,
    ) -> Result<()> {
        let bitstreams = bitstreams.ok_or(CoreError::MissingBitstreams)?;
        trace(sink, "prepare", format!("opening {device_id}"));
        let mut handle = self.open_device(device_id)?;
        trace(sink, "prepare", "claiming USB interfaces 0 and 1");
        Self::claim_pxlogic_interfaces(&mut handle)?;
        trace(
            sink,
            "prepare",
            format!(
                "bitstreams loaded: reset={} bytes, main={} bytes",
                bitstreams.reset.len(),
                bitstreams.main.len()
            ),
        );
        trace(sink, "prepare", "clearing data OUT halt");
        handle.clear_halt(protocol::BULK_EP_DATA_OUT)?;
        trace(sink, "prepare", "uploading reset bitstream");
        Self::upload_bitstream(&mut handle, &bitstreams.reset, 4)?;
        trace(sink, "prepare", "clearing data OUT halt");
        handle.clear_halt(protocol::BULK_EP_DATA_OUT)?;
        trace(sink, "prepare", "uploading main bitstream");
        Self::upload_bitstream(&mut handle, &bitstreams.main, 4)?;
        trace(sink, "prepare", "FPGA upload complete, waiting 100 ms");
        std::thread::sleep(Duration::from_millis(100));
        Ok(())
    }

    pub fn capture_with_trace(
        &self,
        settings: &CaptureSettings,
        cancel: &AtomicBool,
        progress: &mut dyn FnMut(CaptureProgress),
        sink: &mut TraceSink<'_>,
    ) -> Result<CaptureData> {
        trace(sink, "capture", format!("opening {}", settings.device_id));
        let mut handle = self.open_device(&settings.device_id)?;
        let speed = handle.device().speed();
        let superspeed = matches!(speed, rusb::Speed::Super | rusb::Speed::SuperPlus);
        trace(sink, "capture", format!("USB link speed: {speed:?}"));
        trace(sink, "capture", "claiming USB interfaces 0 and 1");
        Self::claim_pxlogic_interfaces(&mut handle)?;

        let channel_count = Self::resolve_capture_channel_count(
            &mut handle,
            &settings.device_id,
            settings.channel_count,
            sink,
        );
        let unitsize = unitsize_for_channel_count(channel_count)?;
        let sample_count = sample_count_from_settings(settings, unitsize)?;
        let target_bytes = sample_count * u64::from(unitsize);
        let transfer_size =
            pxview_capture_transfer_size(settings.sample_rate_hz, channel_count, superspeed)?;
        trace(
            sink,
            "capture",
            format!(
                "settings: {} Hz, {} channels, {} samples, {} bytes, transfer={} bytes, mode={:?}, decode_cross={}, threshold={:.2} V",
                settings.sample_rate_hz,
                channel_count,
                sample_count,
                target_bytes,
                transfer_size,
                settings.mode,
                settings.decode_cross,
                settings.threshold_volts
            ),
        );
        trace_stream_budget(settings, channel_count, speed, sink);
        let script = build_capture_register_script(
            transfer_size as u32,
            target_bytes,
            channel_count,
            settings.sample_rate_hz,
            CaptureProfile {
                stream_mode: matches!(settings.mode, CaptureMode::Stream),
                vth_volts: settings.threshold_volts,
                ..CaptureProfile::default()
            },
        )?;

        trace(sink, "registers", "reset block pointer");
        Self::write_register(&mut handle, protocol::REG_BLOCK_START, 0)?;
        trace(sink, "capture", "clearing data endpoints");
        let _ = handle.clear_halt(protocol::BULK_EP_DATA_IN);
        let _ = handle.clear_halt(0x04);
        let _ = handle.clear_halt(0x84);
        trace(
            sink,
            "registers",
            format!("writing {} capture registers", script.len()),
        );
        for write in script {
            Self::write_register(&mut handle, write.addr, write.value)?;
        }
        Self::trace_control_status(&mut handle, sink, "after start");

        let target_len = target_bytes as usize;
        let mut raw = Vec::with_capacity(target_len.saturating_add(transfer_size));
        let mut buffer = vec![0u8; transfer_size];
        let mut timeout_count = 0u32;
        trace(sink, "bulk", "starting data IN reads");
        while raw.len() < target_len {
            if cancel.load(Ordering::Acquire) {
                let _ = Self::write_register(
                    &mut handle,
                    protocol::REG_STREAM_START,
                    protocol::STREAM_STOP_FLAGS,
                );
                return Err(CoreError::Cancelled);
            }
            match handle.read_bulk(
                protocol::BULK_EP_DATA_IN,
                &mut buffer,
                Duration::from_millis(protocol::DEFAULT_BULK_TIMEOUT_MS),
            ) {
                Ok(read) => {
                    if read == 0 {
                        timeout_count = timeout_count.saturating_add(1);
                        trace_warn(sink, "bulk", "read returned 0 bytes");
                    } else {
                        raw.extend_from_slice(&buffer[..read]);
                        timeout_count = 0;
                        trace(
                            sink,
                            "bulk",
                            format!(
                                "read {read} bytes, total {}/{}",
                                raw.len().min(target_len),
                                target_bytes
                            ),
                        );
                        progress(CaptureProgress {
                            bytes_read: raw.len().min(target_len) as u64,
                            bytes_expected: target_bytes,
                            samples_read: raw.len().min(target_len) as u64 / u64::from(unitsize),
                        });
                    }
                }
                Err(rusb::Error::Timeout) => {
                    timeout_count = timeout_count.saturating_add(1);
                    trace_warn(
                        sink,
                        "bulk",
                        format!("timeout {timeout_count}/5 while waiting for endpoint 0x82"),
                    );
                    Self::trace_control_status(
                        &mut handle,
                        sink,
                        format!("timeout {timeout_count}"),
                    );
                    if timeout_count >= 5 {
                        let _ = Self::write_register(
                            &mut handle,
                            protocol::REG_STREAM_START,
                            protocol::STREAM_STOP_FLAGS,
                        );
                        return Err(CoreError::Usb(
                            "bulk endpoint 0x82 timed out without enough data".to_string(),
                        ));
                    }
                }
                Err(error) => {
                    let _ = Self::write_register(
                        &mut handle,
                        protocol::REG_STREAM_START,
                        protocol::STREAM_STOP_FLAGS,
                    );
                    return Err(CoreError::from(error));
                }
            }
        }
        if raw.len() > target_len {
            trace(
                sink,
                "bulk",
                format!(
                    "trimming {} excess DMA bytes from final block",
                    raw.len() - target_len
                ),
            );
            raw.truncate(target_len);
        }

        trace(sink, "capture", "stopping capture registers");
        let _ = Self::write_register(
            &mut handle,
            protocol::REG_STREAM_START,
            protocol::STREAM_STOP_FLAGS,
        );
        let samples = if settings.decode_cross && matches!(channel_count, 16 | 32) {
            trace(sink, "decode", format!("decoding {} raw bytes", raw.len()));
            decode_cross_data(channel_count, &raw)?
        } else {
            raw
        };
        trace(
            sink,
            "capture",
            format!("capture complete: {} bytes", samples.len()),
        );

        Ok(CaptureData {
            metadata: CaptureMetadata {
                version: 1,
                source_device: settings.device_id.clone(),
                sample_rate_hz: settings.sample_rate_hz,
                channel_count,
                unitsize,
                sample_count,
                captured_at: Utc::now(),
                labels: (0..channel_count)
                    .map(|index| format!("D{index}"))
                    .collect(),
            },
            samples,
        })
    }

    fn context() -> Result<Context> {
        Context::new().map_err(CoreError::from)
    }

    fn open_device(&self, device_id: &str) -> Result<DeviceHandle<Context>> {
        let context = Self::context()?;
        let mut fallback_supported = false;
        for device in context.devices()?.iter() {
            let desc = device.device_descriptor()?;
            if !protocol::is_supported_pxlogic_id(desc.vendor_id(), desc.product_id()) {
                continue;
            }
            fallback_supported = true;
            let candidate_id = usb_device_id(
                desc.vendor_id(),
                desc.product_id(),
                device.bus_number(),
                device.address(),
            );
            if candidate_id == device_id {
                return device.open().map_err(CoreError::from);
            }
        }

        if fallback_supported {
            for device in context.devices()?.iter() {
                let desc = device.device_descriptor()?;
                if protocol::is_supported_pxlogic_id(desc.vendor_id(), desc.product_id()) {
                    return device.open().map_err(CoreError::from);
                }
            }
        }

        Err(CoreError::UnsupportedDevice)
    }

    fn claim_pxlogic_interfaces(handle: &mut DeviceHandle<Context>) -> Result<()> {
        handle.claim_interface(0)?;
        handle.claim_interface(1)?;
        Ok(())
    }

    fn write_register(handle: &mut DeviceHandle<Context>, addr: u32, value: u32) -> Result<()> {
        let packet = protocol::encode_register_write(addr, value);
        bulk_write_exact(
            handle,
            protocol::BULK_EP_REG_OUT,
            &packet,
            protocol::DEFAULT_REGISTER_TIMEOUT_MS,
        )?;
        let mut ack = [0u8; 16];
        bulk_read_exact(
            handle,
            protocol::BULK_EP_REG_IN,
            &mut ack,
            protocol::DEFAULT_REGISTER_TIMEOUT_MS,
        )?;
        protocol::validate_register_ack(&ack)
    }

    fn read_register(handle: &mut DeviceHandle<Context>, addr: u32) -> Result<u32> {
        let packet = protocol::encode_register_read(addr);
        bulk_write_exact(
            handle,
            protocol::BULK_EP_REG_OUT,
            &packet,
            protocol::DEFAULT_REGISTER_TIMEOUT_MS,
        )?;
        let mut response = [0u8; 16];
        bulk_read_exact(
            handle,
            protocol::BULK_EP_REG_IN,
            &mut response,
            protocol::DEFAULT_REGISTER_TIMEOUT_MS,
        )?;
        Ok(protocol::decode_register_value(&response))
    }

    fn read_control_status(
        handle: &mut DeviceHandle<Context>,
        timeout: Duration,
    ) -> Result<ControlStatus> {
        let mut response = [0u8; 16];
        let read = handle.read_control(
            rusb::request_type(
                rusb::Direction::In,
                rusb::RequestType::Vendor,
                rusb::Recipient::Device,
            ),
            protocol::CMD_CTL_READ,
            0,
            0,
            &mut response,
            timeout,
        )?;
        if read != response.len() {
            return Err(CoreError::Usb(format!(
                "control status length mismatch: {read}/{}",
                response.len()
            )));
        }

        Ok(ControlStatus {
            sync_cur_sample: u64::from_le_bytes(
                response[0..8].try_into().expect("fixed control field"),
            ),
            trig_out_validset: u32::from_le_bytes(
                response[8..12].try_into().expect("fixed control field"),
            ),
            real_pos: u32::from_le_bytes(response[12..16].try_into().expect("fixed control field")),
        })
    }

    fn trace_control_status(
        handle: &mut DeviceHandle<Context>,
        sink: &mut TraceSink<'_>,
        label: impl Into<String>,
    ) {
        let label = label.into();
        match Self::read_control_status(handle, Duration::from_millis(100)) {
            Ok(status) => trace(
                sink,
                "status",
                format!(
                    "{label}: sync_cur_sample={}, trig_out_validset=0x{:08x}, real_pos={}",
                    status.sync_cur_sample, status.trig_out_validset, status.real_pos
                ),
            ),
            Err(error) => trace_warn(
                sink,
                "status",
                format!("{label}: failed to read control status: {error}"),
            ),
        }
    }

    fn resolve_capture_channel_count(
        handle: &mut DeviceHandle<Context>,
        device_id: &str,
        requested: u8,
        sink: &mut TraceSink<'_>,
    ) -> u8 {
        let max_channels = if device_id.contains(":1a86:5237:") {
            Some(32)
        } else if device_id.contains(":16c0:05dc:") {
            match Self::read_register(handle, protocol::REG_LOGIC_MODE) {
                Ok(logic_mode) => {
                    let channels = if logic_mode == 0 { 32 } else { 16 };
                    trace(
                        sink,
                        "probe",
                        format!(
                            "legacy REG_LOGIC_MODE=0x{logic_mode:08x}, max_channels={channels}"
                        ),
                    );
                    Some(channels)
                }
                Err(error) => {
                    trace_warn(
                        sink,
                        "probe",
                        format!("failed to read REG_LOGIC_MODE, using requested channels: {error}"),
                    );
                    None
                }
            }
        } else {
            None
        };

        match max_channels {
            Some(max_channels) if requested > max_channels => {
                trace_warn(
                    sink,
                    "probe",
                    format!("capping requested channels {requested} -> device max {max_channels}"),
                );
                max_channels
            }
            Some(max_channels) => {
                trace(
                    sink,
                    "probe",
                    format!(
                        "using requested channels {requested} within device max {max_channels}"
                    ),
                );
                requested
            }
            None => requested,
        }
    }

    fn upload_bitstream(handle: &mut DeviceHandle<Context>, data: &[u8], mode: u32) -> Result<()> {
        const PAGE_SIZE: usize = 4096;
        let aligned_len = data.len().div_ceil(PAGE_SIZE) * PAGE_SIZE;
        let end_addr = u32::try_from(aligned_len)
            .map_err(|_| CoreError::Decode("bitstream is too large".to_string()))?;

        Self::write_register(handle, protocol::REG_WRITE_DATA_START, 0)?;
        Self::write_register(handle, protocol::REG_WRITE_DATA_END, end_addr)?;
        Self::write_register(handle, protocol::REG_WRITE_DATA_MODE, mode)?;

        for chunk in data.chunks(64 * 1024) {
            bulk_write_exact(
                handle,
                protocol::BULK_EP_DATA_OUT,
                chunk,
                protocol::DEFAULT_BULK_TIMEOUT_MS,
            )?;
        }

        let padding = [0u8; PAGE_SIZE];
        let mut remaining = aligned_len - data.len();
        while remaining > 0 {
            let size = remaining.min(PAGE_SIZE);
            bulk_write_exact(
                handle,
                protocol::BULK_EP_DATA_OUT,
                &padding[..size],
                protocol::DEFAULT_BULK_TIMEOUT_MS,
            )?;
            remaining -= size;
        }
        Ok(())
    }
}

impl CaptureBackend for RusbBackend {
    fn list_devices(&self) -> Result<Vec<DeviceInfo>> {
        let context = Self::context()?;
        let mut devices = Vec::new();
        for device in context.devices()?.iter() {
            let desc = device.device_descriptor()?;
            let vid = desc.vendor_id();
            let pid = desc.product_id();
            if !protocol::is_supported_pxlogic_id(vid, pid) {
                continue;
            }
            let bus = device.bus_number();
            let address = device.address();
            devices.push(DeviceInfo {
                id: usb_device_id(vid, pid, bus, address),
                kind: DeviceKind::Usb,
                vid,
                pid,
                bus: Some(bus),
                address: Some(address),
                label: format!("PXLogic USB {vid:04x}:{pid:04x} bus {bus} addr {address}"),
                ready: true,
            });
        }
        Ok(devices)
    }

    fn prepare_device(&self, device_id: &str, bitstreams: Option<&Bitstreams>) -> Result<()> {
        let mut sink = |_event: DiagnosticEvent| {};
        self.prepare_device_with_trace(device_id, bitstreams, &mut sink)
    }

    fn capture(
        &self,
        settings: &CaptureSettings,
        cancel: &AtomicBool,
        progress: &mut dyn FnMut(CaptureProgress),
    ) -> Result<CaptureData> {
        let mut sink = |_event: DiagnosticEvent| {};
        self.capture_with_trace(settings, cancel, progress, &mut sink)
    }

    fn stop_capture(&self, device_id: &str) -> Result<()> {
        let mut handle = self.open_device(device_id)?;
        Self::claim_pxlogic_interfaces(&mut handle)?;
        Self::write_register(
            &mut handle,
            protocol::REG_STREAM_START,
            protocol::STREAM_STOP_FLAGS,
        )
    }
}

fn usb_device_id(vid: u16, pid: u16, bus: u8, address: u8) -> String {
    format!("usb:{vid:04x}:{pid:04x}:{bus}:{address}")
}

fn load_bitstreams_from_dir(dir: &Path) -> Result<Option<Bitstreams>> {
    let reset = dir.join("hspi_ddr_RST.bin");
    let main = dir.join("hspi_ddr.bin");
    if !reset.is_file() || !main.is_file() {
        return Ok(None);
    }

    Ok(Some(Bitstreams {
        reset: fs::read(reset)?,
        main: fs::read(main)?,
    }))
}

fn bitstream_search_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();

    if let Some(dir) = env::var_os("PXLOGIC_BITSTREAM_DIR") {
        dirs.push(PathBuf::from(dir));
    }

    if let Ok(cwd) = env::current_dir() {
        push_relative_resource_dirs(&mut dirs, &cwd);
    }

    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    push_relative_resource_dirs(&mut dirs, &manifest_dir);
    if let Some(workspace_root) = manifest_dir.parent().and_then(Path::parent) {
        push_relative_resource_dirs(&mut dirs, workspace_root);
    }

    if let Ok(exe) = env::current_exe() {
        for ancestor in exe.ancestors().take(8) {
            push_relative_resource_dirs(&mut dirs, ancestor);
        }
    }

    dedup_paths(dirs)
}

fn push_relative_resource_dirs(dirs: &mut Vec<PathBuf>, base: &Path) {
    dirs.push(base.join("resources").join("bitstreams"));
    dirs.push(base.join("src-tauri").join("resources").join("bitstreams"));
}

fn dedup_paths(paths: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut deduped = Vec::new();
    for path in paths {
        if !deduped.iter().any(|existing| existing == &path) {
            deduped.push(path);
        }
    }
    deduped
}

fn bulk_write_exact(
    handle: &mut DeviceHandle<Context>,
    endpoint: u8,
    mut data: &[u8],
    timeout_ms: u64,
) -> Result<()> {
    while !data.is_empty() {
        let written = handle.write_bulk(endpoint, data, Duration::from_millis(timeout_ms))?;
        data = &data[written..];
    }
    Ok(())
}

fn bulk_read_exact(
    handle: &mut DeviceHandle<Context>,
    endpoint: u8,
    data: &mut [u8],
    timeout_ms: u64,
) -> Result<()> {
    let mut offset = 0;
    while offset < data.len() {
        let read = handle.read_bulk(
            endpoint,
            &mut data[offset..],
            Duration::from_millis(timeout_ms),
        )?;
        offset += read;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;

    #[test]
    fn loads_bitstreams_from_directory() {
        let dir = env::temp_dir().join(format!("pxlogic-bitstreams-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("hspi_ddr_RST.bin"), [1, 2, 3]).unwrap();
        fs::write(dir.join("hspi_ddr.bin"), [4, 5, 6]).unwrap();

        let bitstreams = RusbBackend::load_bitstreams_from_dir(&dir)
            .unwrap()
            .expect("bitstreams");
        assert_eq!(bitstreams.reset, vec![1, 2, 3]);
        assert_eq!(bitstreams.main, vec![4, 5, 6]);

        let _ = fs::remove_dir_all(dir);
    }
}
