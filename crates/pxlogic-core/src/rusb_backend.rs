use std::{
    env, fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        OnceLock,
    },
    time::{Duration, Instant},
};

use chrono::Utc;
use rusb::{Context, DeviceDescriptor, DeviceHandle, UsbContext};

use crate::{
    capture::{
        align_cross_sample_count, build_capture_register_script_for_channels,
        build_pxview_pwm0_register_script, capture_profile_from_settings,
        decode_cross_data_to_physical_channels, pxview_capture_transfer_size,
        pxview_cross_raw_byte_count, pxview_trigger_position, resolve_enabled_channels,
        sample_count_from_settings, unitsize_for_channel_count,
    },
    error::{CoreError, Result},
    models::{
        Bitstreams, CaptureData, CaptureMetadata, CaptureMode, CaptureProgress, CaptureSettings,
        CaptureTriggerMetadata, DeviceInfo, DeviceKind, DiagnosticEvent, DiagnosticLevel,
        PwmConfiguration, PwmSettings,
    },
    protocol,
    pxview_profile::{
        resolve_pxlogic_capture_plan, resolve_pxlogic_device_profile, PxUsbSpeed,
        PxlogicDeviceProfile, PXLOGIC_32_CHANNEL_HARDWARE_DEPTH_BITS,
    },
    transport::CaptureBackend,
};

const TRIGGER_STATUS_POLL_INTERVAL: Duration = Duration::from_millis(50);
const USB_ACCESS_RETRY_DELAYS: [Duration; 4] = [
    Duration::from_millis(50),
    Duration::from_millis(150),
    Duration::from_millis(300),
    Duration::from_millis(500),
];

static USB_CONTEXT: OnceLock<std::result::Result<Context, String>> = OnceLock::new();

#[derive(Debug, Default, Clone)]
pub struct RusbBackend;

type TraceSink<'a> = dyn FnMut(DiagnosticEvent) + 'a;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ControlStatus {
    sync_cur_sample: u64,
    trig_out_validset: u32,
    real_pos: u32,
}

fn trigger_metadata_from_status(
    settings: &CaptureSettings,
    status: ControlStatus,
) -> Option<CaptureTriggerMetadata> {
    (settings.trigger_enabled && status.trig_out_validset != 0).then_some(CaptureTriggerMetadata {
        sample_index: u64::from(status.real_pos),
        channel: settings.trigger_channel,
        kind: settings.trigger_kind,
    })
}

fn publish_trigger_status(
    settings: &CaptureSettings,
    status: ControlStatus,
    trigger: &mut Option<CaptureTriggerMetadata>,
    on_trigger: &mut dyn FnMut(&CaptureTriggerMetadata),
    sink: &mut TraceSink<'_>,
) {
    if trigger.is_some() {
        return;
    }
    let Some(metadata) = trigger_metadata_from_status(settings, status) else {
        return;
    };
    trace(
        sink,
        "trigger",
        format!(
            "hardware trigger hit on D{} ({:?}) at sample {}; status=0x{:08x}, sync_cur_sample={}",
            metadata.channel,
            metadata.kind,
            metadata.sample_index,
            status.trig_out_validset,
            status.sync_cur_sample
        ),
    );
    on_trigger(&metadata);
    *trigger = Some(metadata);
}

#[derive(Debug, Default)]
struct UsbIdentityProbe {
    manufacturer: Option<String>,
    product: Option<String>,
    serial_number: Option<String>,
    logic_mode: Option<u32>,
    profile: Option<&'static PxlogicDeviceProfile>,
    ready: bool,
    error: Option<String>,
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
        Self::trace_firmware_version(&mut handle, sink);
        trace(
            sink,
            "prepare",
            format!(
                "bitstreams loaded: reset={} bytes, main={} bytes",
                bitstreams.reset.len(),
                bitstreams.main.len()
            ),
        );
        trace(sink, "prepare", "clearing PXLogic USB endpoints");
        Self::clear_pxlogic_endpoints(&mut handle, sink);
        trace(sink, "prepare", "uploading reset bitstream");
        Self::upload_bitstream_with_trace(&mut handle, &bitstreams.reset, 4, "reset", sink)?;
        trace(sink, "prepare", "clearing PXLogic USB endpoints");
        Self::clear_pxlogic_endpoints(&mut handle, sink);
        trace(sink, "prepare", "uploading main bitstream");
        Self::upload_bitstream_with_trace(&mut handle, &bitstreams.main, 4, "main", sink)?;
        trace(sink, "prepare", "FPGA upload complete, waiting 100 ms");
        std::thread::sleep(Duration::from_millis(100));
        Ok(())
    }

    pub fn configure_pwm0_with_trace(
        &self,
        device_id: &str,
        settings: &PwmSettings,
        sink: &mut TraceSink<'_>,
    ) -> Result<PwmConfiguration> {
        let (configuration, script) = build_pxview_pwm0_register_script(settings)?;
        trace(sink, "pwm0", format!("opening {device_id}"));
        let mut handle = self.open_device(device_id)?;
        trace(sink, "pwm0", "claiming USB interfaces 0 and 1");
        Self::claim_pxlogic_interfaces(&mut handle)?;
        for write in script {
            Self::write_register_with_trace(&mut handle, write.addr, write.value, sink)?;
        }
        let _ = handle.release_interface(0);
        let _ = handle.release_interface(1);
        trace(
            sink,
            "pwm0",
            format!(
                "configured: enabled={}, requested={:.3} Hz at {:.3}%, effective={:.3} Hz at {:.3}%",
                configuration.enabled,
                configuration.requested_frequency_hz,
                configuration.requested_duty_percent,
                configuration.effective_frequency_hz,
                configuration.effective_duty_percent
            ),
        );
        Ok(configuration)
    }

    pub fn capture_with_trace(
        &self,
        settings: &CaptureSettings,
        cancel: &AtomicBool,
        progress: &mut dyn FnMut(CaptureProgress),
        sink: &mut TraceSink<'_>,
    ) -> Result<CaptureData> {
        self.capture_with_trace_streaming(
            settings,
            cancel,
            progress,
            sink,
            &mut |_| {},
            &mut |_| {},
            &mut |_| {},
        )
    }

    pub fn capture_with_trace_streaming(
        &self,
        settings: &CaptureSettings,
        cancel: &AtomicBool,
        progress: &mut dyn FnMut(CaptureProgress),
        sink: &mut TraceSink<'_>,
        started: &mut dyn FnMut(&CaptureMetadata),
        on_samples: &mut dyn FnMut(&[u8]),
        on_trigger: &mut dyn FnMut(&CaptureTriggerMetadata),
    ) -> Result<CaptureData> {
        trace(sink, "capture", format!("opening {}", settings.device_id));
        let mut handle = self.open_device(&settings.device_id)?;
        let speed = handle.device().speed();
        let superspeed = matches!(speed, rusb::Speed::Super | rusb::Speed::SuperPlus);
        let desc = handle.device().device_descriptor()?;
        trace(sink, "capture", format!("USB link speed: {speed:?}"));
        trace(sink, "capture", "claiming USB interfaces 0 and 1");
        Self::claim_pxlogic_interfaces(&mut handle)?;

        let mut effective_settings = settings.clone();
        let mut hardware_depth_bits = PXLOGIC_32_CHANNEL_HARDWARE_DEPTH_BITS;
        if let Some(profile) = Self::resolve_profile_for_capture(
            &mut handle,
            desc.vendor_id(),
            desc.product_id(),
            speed,
            sink,
        ) {
            hardware_depth_bits = profile.hardware_depth_bits;
            let plan = resolve_pxlogic_capture_plan(
                profile,
                settings.mode,
                settings.channel_count,
                settings.sample_rate_hz,
            )?;
            trace(
                sink,
                "profile",
                format!(
                    "selected {} / {} for {:?}: {}",
                    plan.profile.model,
                    plan.profile.vendor,
                    settings.mode,
                    plan.channel_mode.description
                ),
            );
            if plan.channel_count != settings.channel_count {
                trace_warn(
                    sink,
                    "profile",
                    format!(
                        "capping requested channels {} -> {} for {}",
                        settings.channel_count, plan.channel_count, plan.profile.model
                    ),
                );
            }
            if plan.sample_rate_hz != settings.sample_rate_hz {
                trace_warn(
                    sink,
                    "profile",
                    format!(
                        "capping requested samplerate {} Hz -> {} Hz for {}",
                        settings.sample_rate_hz, plan.sample_rate_hz, plan.channel_mode.description
                    ),
                );
            }
            effective_settings.channel_count = plan.channel_count;
            effective_settings.sample_rate_hz = plan.sample_rate_hz;
        } else {
            effective_settings.channel_count = Self::resolve_capture_channel_count(
                &mut handle,
                &settings.device_id,
                settings.channel_count,
                sink,
            );
        }

        let channel_count = effective_settings.channel_count;
        let enabled_channels =
            resolve_enabled_channels(channel_count, &effective_settings.enabled_channels)?;
        effective_settings.enabled_channels = enabled_channels.clone();
        let enabled_channel_count = u8::try_from(enabled_channels.len())
            .map_err(|_| CoreError::InvalidChannelCount(channel_count))?;
        let unitsize = unitsize_for_channel_count(channel_count)?;
        let requested_sample_count = sample_count_from_settings(&effective_settings, unitsize)?;
        let sample_count = align_cross_sample_count(requested_sample_count)?;
        let target_raw_bytes = pxview_cross_raw_byte_count(sample_count, enabled_channel_count)?;
        let target_decoded_bytes = sample_count
            .checked_mul(u64::from(unitsize))
            .ok_or(CoreError::InvalidCaptureDuration)?;
        let captured_at = Utc::now();
        let stream_metadata = CaptureMetadata {
            version: 1,
            source_device: settings.device_id.clone(),
            sample_rate_hz: effective_settings.sample_rate_hz,
            channel_count,
            enabled_channels: enabled_channels.clone(),
            unitsize,
            sample_count: 0,
            captured_at,
            labels: (0..channel_count)
                .map(|index| format!("D{index}"))
                .collect(),
            trigger: None,
        };
        started(&stream_metadata);
        let transfer_size = pxview_capture_transfer_size(
            effective_settings.sample_rate_hz,
            enabled_channel_count,
            superspeed,
        )?;
        trace(
            sink,
            "capture",
            format!(
                "settings: {} Hz, physical_span={} channels, enabled={:?} ({} lanes), {} samples, {} raw bytes, {} decoded bytes, transfer={} bytes, mode={:?}, decode_cross={}, threshold={:.2} V, trigger={}, trigger_channel=D{}, trigger_kind={:?}, glitch_filter={}",
                effective_settings.sample_rate_hz,
                channel_count,
                enabled_channels,
                enabled_channel_count,
                sample_count,
                target_raw_bytes,
                target_decoded_bytes,
                transfer_size,
                effective_settings.mode,
                effective_settings.decode_cross,
                effective_settings.threshold_volts,
                effective_settings.trigger_enabled,
                effective_settings.trigger_channel,
                effective_settings.trigger_kind,
                effective_settings.glitch_filter_enabled
            ),
        );
        trace_stream_budget(&effective_settings, enabled_channel_count, speed, sink);
        let mut capture_profile =
            capture_profile_from_settings(&effective_settings, channel_count)?;
        capture_profile.trigger_pos = pxview_trigger_position(
            &effective_settings,
            sample_count,
            enabled_channel_count,
            hardware_depth_bits,
        )?;
        trace(
            sink,
            "trigger",
            format!(
                "requested position={}%, programmed pre-trigger samples={}",
                effective_settings.trigger_position_percent, capture_profile.trigger_pos
            ),
        );
        let script = build_capture_register_script_for_channels(
            transfer_size as u32,
            target_raw_bytes,
            channel_count,
            &enabled_channels,
            effective_settings.sample_rate_hz,
            capture_profile,
        )?;

        trace(sink, "registers", "reset block pointer");
        Self::write_register(&mut handle, protocol::REG_BLOCK_START, 0)?;
        trace(sink, "capture", "clearing data endpoints");
        let _ = handle.clear_halt(protocol::BULK_EP_REG_OUT);
        let _ = handle.clear_halt(protocol::BULK_EP_REG_IN);
        let _ = handle.clear_halt(protocol::BULK_EP_DATA_OUT);
        let _ = handle.clear_halt(protocol::BULK_EP_DATA_IN);
        let _ = handle.clear_halt(protocol::BULK_EP_BUFFER_DATA_IN);
        let _ = handle.clear_halt(0x02);
        let _ = handle.clear_halt(0x04);
        let _ = handle.clear_halt(0x84);
        trace(
            sink,
            "registers",
            format!("writing {} capture registers", script.len()),
        );
        for write in script {
            Self::write_register_with_trace(&mut handle, write.addr, write.value, sink)?;
        }
        let mut hardware_trigger = None;
        if let Some(status) = Self::trace_control_status(&mut handle, sink, "after start", true) {
            publish_trigger_status(
                &effective_settings,
                status,
                &mut hardware_trigger,
                on_trigger,
                sink,
            );
        }
        let data_endpoint = if matches!(effective_settings.mode, CaptureMode::Buffer) {
            let settle =
                buffer_capture_settle_duration(sample_count, effective_settings.sample_rate_hz);
            trace(
                sink,
                "buffer",
                format!("waiting {} ms before DDR read request", settle.as_millis()),
            );
            std::thread::sleep(settle);
            if hardware_trigger.is_none() {
                if let Some(status) =
                    Self::trace_control_status(&mut handle, sink, "after buffer settle", true)
                {
                    publish_trigger_status(
                        &effective_settings,
                        status,
                        &mut hardware_trigger,
                        on_trigger,
                        sink,
                    );
                }
            }
            let request_bytes = target_raw_bytes
                .checked_add(transfer_size as u64)
                .ok_or_else(|| CoreError::Decode("buffer read byte count overflow".to_string()))?;
            trace(
                sink,
                "buffer",
                format!(
                    "requesting DDR read: base=0x{:x}, bytes={request_bytes}, endpoint=0x{:02x}",
                    protocol::DATA_READ_BASE_ADDR,
                    protocol::BULK_EP_BUFFER_DATA_IN
                ),
            );
            Self::request_ddr_read(
                &mut handle,
                protocol::DATA_READ_BASE_ADDR,
                request_bytes,
                protocol::DATA_MODE_FPGA_DDR,
            )?;
            protocol::BULK_EP_BUFFER_DATA_IN
        } else {
            protocol::BULK_EP_DATA_IN
        };

        let target_raw_len =
            usize::try_from(target_raw_bytes).map_err(|_| CoreError::InvalidCaptureDuration)?;
        let target_decoded_len =
            usize::try_from(target_decoded_bytes).map_err(|_| CoreError::InvalidCaptureDuration)?;
        let initial_capacity = target_decoded_len
            .min(8 * 1024 * 1024)
            .saturating_add(transfer_size);
        // PXView tags every PXLogic logic payload as LA_CROSS_DATA. Each stripe contains
        // one 64-sample word per enabled channel, including the 1/2/4/8-channel modes.
        let decode_cross = effective_settings.decode_cross;
        let mut raw = Vec::with_capacity(if decode_cross { 0 } else { initial_capacity });
        let mut decoded_samples = Vec::with_capacity(initial_capacity.min(target_decoded_len));
        let mut published_raw_len = 0usize;
        let mut pending_cross = Vec::with_capacity(if decode_cross {
            usize::from(enabled_channel_count) * 8 + transfer_size
        } else {
            0
        });
        let mut bytes_read = 0usize;
        let mut buffer = vec![0u8; transfer_size];
        let read_poll_timeout = capture_read_poll_timeout();
        let stall_timeout =
            capture_stall_timeout(&effective_settings, enabled_channel_count, transfer_size);
        let mut idle_poll_count = 0u32;
        let mut last_data_at = Instant::now();
        let mut last_trigger_status_poll = Instant::now();
        let mut cancelled = false;
        trace(
            sink,
            "bulk",
            format!(
                "starting data IN reads on endpoint 0x{data_endpoint:02x}; cancel poll={} ms, stall timeout={}",
                read_poll_timeout.as_millis(),
                stall_timeout
                    .map(|timeout| format!("{:.1} s", timeout.as_secs_f64()))
                    .unwrap_or_else(|| "disabled while waiting for trigger".to_string())
            ),
        );
        while bytes_read < target_raw_len {
            if cancel.load(Ordering::Acquire) {
                cancelled = true;
                break;
            }
            match handle.read_bulk(data_endpoint, &mut buffer, read_poll_timeout) {
                Ok(read) => {
                    if read == 0 {
                        idle_poll_count = idle_poll_count.saturating_add(1);
                    } else {
                        let accepted = read.min(target_raw_len.saturating_sub(bytes_read));
                        bytes_read = bytes_read.saturating_add(accepted);
                        if decode_cross {
                            publish_cross_stream_samples(
                                &buffer[..accepted],
                                channel_count,
                                &enabled_channels,
                                &mut pending_cross,
                                &mut decoded_samples,
                                on_samples,
                            )?;
                        } else {
                            raw.extend_from_slice(&buffer[..accepted]);
                            publish_aligned_stream_samples(
                                &raw,
                                unitsize,
                                &mut published_raw_len,
                                on_samples,
                            )?;
                        }
                        idle_poll_count = 0;
                        last_data_at = Instant::now();
                        trace(
                            sink,
                            "bulk",
                            format!(
                                "read {read} bytes, total {}/{}",
                                bytes_read.min(target_raw_len),
                                target_raw_bytes
                            ),
                        );
                        let samples_read = (bytes_read.min(target_raw_len) as u64)
                            .saturating_mul(8)
                            / u64::from(enabled_channel_count);
                        progress(CaptureProgress {
                            bytes_read: bytes_read.min(target_raw_len) as u64,
                            bytes_expected: target_raw_bytes,
                            samples_read: samples_read.min(sample_count),
                            sample_memory_bytes: if decode_cross {
                                decoded_samples.capacity() as u64
                            } else {
                                raw.capacity() as u64
                            },
                        });
                    }
                }
                Err(rusb::Error::Timeout) => {
                    idle_poll_count = idle_poll_count.saturating_add(1);
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
            if idle_poll_count == 0
                && hardware_trigger.is_none()
                && effective_settings.trigger_enabled
                && last_trigger_status_poll.elapsed() >= TRIGGER_STATUS_POLL_INTERVAL
            {
                last_trigger_status_poll = Instant::now();
                if let Some(status) =
                    Self::trace_control_status(&mut handle, sink, "while streaming", false)
                {
                    publish_trigger_status(
                        &effective_settings,
                        status,
                        &mut hardware_trigger,
                        on_trigger,
                        sink,
                    );
                }
            }
            if idle_poll_count > 0 {
                if cancel.load(Ordering::Acquire) {
                    cancelled = true;
                    break;
                }
                let idle = last_data_at.elapsed();
                if stall_timeout.is_some_and(|timeout| idle >= timeout) {
                    let _ = Self::write_register(
                        &mut handle,
                        protocol::REG_STREAM_START,
                        protocol::STREAM_STOP_FLAGS,
                    );
                    return Err(CoreError::Usb(format!(
                        "bulk endpoint 0x{data_endpoint:02x} produced no data for {:.1} s",
                        idle.as_secs_f64()
                    )));
                }
                if idle_poll_count == 1 || idle_poll_count % 20 == 0 {
                    trace(
                        sink,
                        "bulk",
                        format!(
                            "waiting for endpoint 0x{data_endpoint:02x}: {:.1} s without data",
                            idle.as_secs_f64()
                        ),
                    );
                }
                let should_log_status = idle_poll_count == 1 || idle_poll_count % 20 == 0;
                if hardware_trigger.is_none() && effective_settings.trigger_enabled {
                    last_trigger_status_poll = Instant::now();
                    if let Some(status) = Self::trace_control_status(
                        &mut handle,
                        sink,
                        format!("waiting {:.1} s", idle.as_secs_f64()),
                        should_log_status,
                    ) {
                        publish_trigger_status(
                            &effective_settings,
                            status,
                            &mut hardware_trigger,
                            on_trigger,
                            sink,
                        );
                    }
                } else if idle_poll_count % 20 == 0 {
                    Self::trace_control_status(
                        &mut handle,
                        sink,
                        format!("waiting {:.1} s", idle.as_secs_f64()),
                        true,
                    );
                }
            }
        }
        if hardware_trigger.is_none() && effective_settings.trigger_enabled {
            if let Some(status) = Self::trace_control_status(&mut handle, sink, "before stop", true)
            {
                publish_trigger_status(
                    &effective_settings,
                    status,
                    &mut hardware_trigger,
                    on_trigger,
                    sink,
                );
            }
        }

        trace(sink, "capture", "stopping capture registers");
        let _ = Self::write_register(
            &mut handle,
            protocol::REG_STREAM_START,
            protocol::STREAM_STOP_FLAGS,
        );
        if cancelled && bytes_read == 0 {
            return Err(CoreError::Cancelled);
        }
        let samples = if decode_cross {
            trace(
                sink,
                "decode",
                format!(
                    "decoded {} raw bytes incrementally ({} byte tail discarded)",
                    bytes_read,
                    pending_cross.len()
                ),
            );
            decoded_samples
        } else {
            raw.truncate(raw.len() / usize::from(unitsize) * usize::from(unitsize));
            raw
        };
        trace(
            sink,
            "capture",
            format!("capture complete: {} bytes", samples.len()),
        );

        let captured_sample_count = if decode_cross {
            samples.len() as u64 / u64::from(unitsize)
        } else {
            (bytes_read as u64)
                .saturating_mul(8)
                .checked_div(u64::from(enabled_channel_count))
                .unwrap_or(0)
                .min(sample_count)
        };

        Ok(CaptureData {
            metadata: CaptureMetadata {
                version: 1,
                source_device: settings.device_id.clone(),
                sample_rate_hz: effective_settings.sample_rate_hz,
                channel_count,
                enabled_channels,
                unitsize,
                sample_count: captured_sample_count,
                captured_at,
                labels: (0..channel_count)
                    .map(|index| format!("D{index}"))
                    .collect(),
                trigger: hardware_trigger,
            },
            samples,
        })
    }

    fn context() -> Result<Context> {
        match USB_CONTEXT.get_or_init(|| Context::new().map_err(|error| error.to_string())) {
            Ok(context) => Ok(context.clone()),
            Err(error) => Err(CoreError::Usb(format!(
                "failed to initialize the shared libusb context: {error}"
            ))),
        }
    }

    fn open_with_retry(device: &rusb::Device<Context>) -> Result<DeviceHandle<Context>> {
        for delay in USB_ACCESS_RETRY_DELAYS {
            match device.open() {
                Ok(handle) => return Ok(handle),
                Err(error) if is_transient_usb_access_error(error) => {
                    std::thread::sleep(delay);
                }
                Err(error) => {
                    return Err(CoreError::Usb(format!(
                        "failed to open the PXLogic WinUSB device: {error}"
                    )));
                }
            }
        }

        device.open().map_err(|error| {
            CoreError::Usb(format!(
                "failed to open the PXLogic WinUSB device after retrying: {error}"
            ))
        })
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
                return Self::open_with_retry(&device);
            }
        }

        if fallback_supported {
            for device in context.devices()?.iter() {
                let desc = device.device_descriptor()?;
                if protocol::is_supported_pxlogic_id(desc.vendor_id(), desc.product_id()) {
                    return Self::open_with_retry(&device);
                }
            }
        }

        Err(CoreError::UnsupportedDevice)
    }

    fn claim_pxlogic_interfaces(handle: &mut DeviceHandle<Context>) -> Result<()> {
        for delay in USB_ACCESS_RETRY_DELAYS {
            match claim_pxlogic_interfaces_once(handle) {
                Ok(()) => return Ok(()),
                Err((_, error)) if is_transient_usb_access_error(error) => {
                    std::thread::sleep(delay);
                }
                Err((interface, error)) => {
                    return Err(CoreError::Usb(format!(
                        "failed to claim PXLogic USB interface {interface}: {error}"
                    )));
                }
            }
        }

        claim_pxlogic_interfaces_once(handle).map_err(|(interface, error)| {
            CoreError::Usb(format!(
                "failed to claim PXLogic USB interface {interface} after retrying: {error}"
            ))
        })
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
        log_success: bool,
    ) -> Option<ControlStatus> {
        let label = label.into();
        match Self::read_control_status(handle, Duration::from_millis(100)) {
            Ok(status) => {
                if log_success || status.trig_out_validset != 0 {
                    trace(
                        sink,
                        "status",
                        format!(
                            "{label}: sync_cur_sample={}, trig_out_validset=0x{:08x}, real_pos={}",
                            status.sync_cur_sample, status.trig_out_validset, status.real_pos
                        ),
                    );
                }
                Some(status)
            }
            Err(error) => {
                if log_success {
                    trace_warn(
                        sink,
                        "status",
                        format!("{label}: failed to read control status: {error}"),
                    );
                }
                None
            }
        }
    }

    fn trace_firmware_version(handle: &mut DeviceHandle<Context>, sink: &mut TraceSink<'_>) {
        match Self::read_register(handle, protocol::REG_FIRMWARE_VERSION) {
            Ok(version) if version == protocol::EXPECTED_FIRMWARE_VERSION => trace(
                sink,
                "firmware",
                format!("MCU firmware version 0x{version:08x} matches PXView"),
            ),
            Ok(version) if version == protocol::BOOTLOADER_FIRMWARE_VERSION => trace_warn(
                sink,
                "firmware",
                format!(
                    "MCU bootloader version 0x{version:08x} detected; CPU firmware flashing is not enabled in this Tauri path"
                ),
            ),
            Ok(version) => trace_warn(
                sink,
                "firmware",
                format!(
                    "MCU firmware version 0x{version:08x} differs from PXView expected 0x{:08x}; continuing with FPGA prepare only",
                    protocol::EXPECTED_FIRMWARE_VERSION
                ),
            ),
            Err(error) => trace_warn(
                sink,
                "firmware",
                format!("failed to read MCU firmware version: {error}"),
            ),
        }
    }

    fn clear_pxlogic_endpoints(handle: &mut DeviceHandle<Context>, sink: &mut TraceSink<'_>) {
        for endpoint in [
            protocol::BULK_EP_REG_OUT,
            protocol::BULK_EP_REG_IN,
            0x02,
            protocol::BULK_EP_DATA_IN,
            protocol::BULK_EP_DATA_OUT,
            protocol::BULK_EP_BUFFER_DATA_IN,
            0x04,
            0x84,
        ] {
            if let Err(error) = handle.clear_halt(endpoint) {
                trace_warn(
                    sink,
                    "prepare",
                    format!("clear_halt 0x{endpoint:02x} failed: {error}"),
                );
            }
        }
    }

    fn write_register_with_trace(
        handle: &mut DeviceHandle<Context>,
        addr: u32,
        value: u32,
        sink: &mut TraceSink<'_>,
    ) -> Result<()> {
        trace(
            sink,
            "registers",
            format!("write addr=0x{addr:08x} value=0x{value:08x}"),
        );
        match Self::write_register(handle, addr, value) {
            Ok(()) => Ok(()),
            Err(first_error) => {
                trace_warn(
                    sink,
                    "registers",
                    format!(
                        "write addr=0x{addr:08x} failed once: {first_error}; clearing endpoints and retrying"
                    ),
                );
                Self::clear_pxlogic_endpoints(handle, sink);
                std::thread::sleep(Duration::from_millis(20));
                Self::write_register(handle, addr, value)
            }
        }
    }

    fn resolve_profile_for_capture(
        handle: &mut DeviceHandle<Context>,
        vid: u16,
        pid: u16,
        speed: rusb::Speed,
        sink: &mut TraceSink<'_>,
    ) -> Option<&'static PxlogicDeviceProfile> {
        let Some(px_speed) = px_usb_speed_from_rusb(speed) else {
            trace_warn(
                sink,
                "profile",
                format!("unsupported USB speed for PXView profile matching: {speed:?}"),
            );
            return None;
        };
        let logic_mode = match Self::read_register(handle, protocol::REG_LOGIC_MODE) {
            Ok(logic_mode) => {
                trace(
                    sink,
                    "profile",
                    format!("REG_LOGIC_MODE=0x{logic_mode:08x}"),
                );
                Some(logic_mode)
            }
            Err(error) => {
                trace_warn(
                    sink,
                    "profile",
                    format!("failed to read REG_LOGIC_MODE, using VID/PID/speed fallback: {error}"),
                );
                None
            }
        };
        let profile = resolve_pxlogic_device_profile(vid, pid, px_speed, logic_mode);
        if let Some(profile) = profile {
            trace(
                sink,
                "profile",
                format!(
                    "matched PXView profile: {} {} ({vid:04x}:{pid:04x}, {:?}, logic_mode={})",
                    profile.vendor, profile.model, profile.usb_speed, profile.logic_mode
                ),
            );
        }
        profile
    }

    fn probe_usb_identity(
        device: &rusb::Device<Context>,
        desc: &DeviceDescriptor,
    ) -> UsbIdentityProbe {
        let px_speed = px_usb_speed_from_rusb(device.speed());
        let fallback_profile = px_speed.and_then(|speed| {
            resolve_pxlogic_device_profile(desc.vendor_id(), desc.product_id(), speed, None)
        });
        let mut probe = UsbIdentityProbe {
            profile: fallback_profile,
            ready: true,
            ..UsbIdentityProbe::default()
        };

        let mut handle = match Self::open_with_retry(device) {
            Ok(handle) => handle,
            Err(error) => {
                probe.ready = false;
                probe.error = Some(format!(
                    "failed to open device for PX identity probe: {error}"
                ));
                return probe;
            }
        };

        probe.manufacturer = handle.read_manufacturer_string_ascii(desc).ok();
        probe.product = handle.read_product_string_ascii(desc).ok();
        probe.serial_number = handle.read_serial_number_string_ascii(desc).ok();

        if let Some(manufacturer) = probe.manufacturer.as_deref() {
            if !manufacturer.starts_with("PX") {
                probe.ready = false;
                probe.error = Some(format!(
                    "manufacturer string \"{manufacturer}\" does not match PXView PX* identity"
                ));
                return probe;
            }
        }

        match Self::claim_pxlogic_interfaces(&mut handle) {
            Ok(()) => {
                probe.logic_mode = Self::read_register(&mut handle, protocol::REG_LOGIC_MODE).ok();
                let _ = handle.release_interface(0);
                let _ = handle.release_interface(1);
                if let Some(speed) = px_speed {
                    probe.profile = resolve_pxlogic_device_profile(
                        desc.vendor_id(),
                        desc.product_id(),
                        speed,
                        probe.logic_mode,
                    )
                    .or(fallback_profile);
                }
                if probe.logic_mode.is_none() {
                    probe.error = Some("failed to read PXLogic REG_LOGIC_MODE".to_string());
                }
            }
            Err(error) => {
                probe.ready = false;
                probe.error = Some(format!("failed to claim PXLogic interfaces: {error}"));
            }
        }

        probe
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

    fn request_ddr_read(
        handle: &mut DeviceHandle<Context>,
        base_addr: u32,
        length: u64,
        mode: u32,
    ) -> Result<()> {
        const PAGE_SIZE: u64 = 4096;
        let aligned_length = length
            .div_ceil(PAGE_SIZE)
            .checked_mul(PAGE_SIZE)
            .ok_or_else(|| CoreError::Decode("DDR read length overflow".to_string()))?;
        let end_addr = u64::from(base_addr)
            .checked_add(aligned_length)
            .ok_or_else(|| CoreError::Decode("DDR read end address overflow".to_string()))?;
        let end_addr = u32::try_from(end_addr)
            .map_err(|_| CoreError::Decode("DDR read end address is too large".to_string()))?;

        Self::write_register(handle, protocol::REG_READ_DATA_START, base_addr)?;
        Self::write_register(handle, protocol::REG_READ_DATA_END, end_addr)?;
        Self::write_register(handle, protocol::REG_READ_DATA_MODE, mode)?;
        let _ = handle.clear_halt(protocol::BULK_EP_BUFFER_DATA_IN);
        Ok(())
    }

    fn upload_bitstream_with_trace(
        handle: &mut DeviceHandle<Context>,
        data: &[u8],
        mode: u32,
        label: &str,
        sink: &mut TraceSink<'_>,
    ) -> Result<()> {
        match Self::upload_bitstream(handle, data, mode) {
            Ok(()) => Ok(()),
            Err(first_error) => {
                trace_warn(
                    sink,
                    "prepare",
                    format!(
                        "{label} bitstream upload failed once: {first_error}; clearing endpoints and retrying"
                    ),
                );
                Self::clear_pxlogic_endpoints(handle, sink);
                std::thread::sleep(Duration::from_millis(20));
                Self::upload_bitstream(handle, data, mode)
            }
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

fn publish_aligned_stream_samples(
    raw: &[u8],
    unitsize: u8,
    published_raw_len: &mut usize,
    on_samples: &mut dyn FnMut(&[u8]),
) -> Result<()> {
    let unit_size = usize::from(unitsize);
    let aligned_end = raw.len() / unit_size * unit_size;
    if aligned_end > *published_raw_len {
        on_samples(&raw[*published_raw_len..aligned_end]);
        *published_raw_len = aligned_end;
    }
    Ok(())
}

fn publish_cross_stream_samples(
    input: &[u8],
    output_channel_count: u8,
    enabled_channels: &[u8],
    pending: &mut Vec<u8>,
    decoded_samples: &mut Vec<u8>,
    on_samples: &mut dyn FnMut(&[u8]),
) -> Result<()> {
    let stripe_bytes = enabled_channels.len() * 8;
    pending.extend_from_slice(input);
    let aligned_end = pending.len() / stripe_bytes * stripe_bytes;
    if aligned_end == 0 {
        return Ok(());
    }

    let decoded = decode_cross_data_to_physical_channels(
        output_channel_count,
        enabled_channels,
        &pending[..aligned_end],
        false,
    )?;
    on_samples(&decoded);
    decoded_samples.extend_from_slice(&decoded);
    pending.drain(..aligned_end);
    Ok(())
}

fn buffer_capture_settle_duration(sample_count: u64, sample_rate_hz: u64) -> Duration {
    let sample_us = if sample_rate_hz == 0 {
        0
    } else {
        sample_count.saturating_mul(1_000_000) / sample_rate_hz
    };
    Duration::from_micros((10_000 + sample_us).min(5_000_000))
}

fn capture_read_poll_timeout() -> Duration {
    Duration::from_millis(250)
}

fn capture_stall_timeout(
    settings: &CaptureSettings,
    channel_count: u8,
    transfer_size: usize,
) -> Option<Duration> {
    if settings.trigger_enabled {
        return None;
    }
    if matches!(settings.mode, CaptureMode::Buffer) {
        return Some(Duration::from_secs(10));
    }

    let raw_bits_per_second = settings
        .sample_rate_hz
        .saturating_mul(u64::from(channel_count))
        .max(1);
    let transfer_bits = (transfer_size as u64).saturating_mul(8);
    let expected_fill_ms = transfer_bits
        .saturating_mul(1_000)
        .div_ceil(raw_bits_per_second);
    let timeout_ms = expected_fill_ms
        .saturating_mul(2)
        .saturating_add(5_000)
        .clamp(5_000, 60_000);
    Some(Duration::from_millis(timeout_ms))
}

fn px_usb_speed_from_rusb(speed: rusb::Speed) -> Option<PxUsbSpeed> {
    match speed {
        rusb::Speed::High => Some(PxUsbSpeed::High),
        rusb::Speed::Super | rusb::Speed::SuperPlus => Some(PxUsbSpeed::Super),
        _ => None,
    }
}

fn usb_speed_label(speed: rusb::Speed) -> &'static str {
    match speed {
        rusb::Speed::Unknown => "unknown",
        rusb::Speed::Low => "low",
        rusb::Speed::Full => "full",
        rusb::Speed::High => "high",
        rusb::Speed::Super => "super",
        rusb::Speed::SuperPlus => "super-plus",
        _ => "unknown",
    }
}

fn is_transient_usb_access_error(error: rusb::Error) -> bool {
    matches!(error, rusb::Error::Access | rusb::Error::Busy)
}

fn claim_pxlogic_interfaces_once(
    handle: &mut DeviceHandle<Context>,
) -> std::result::Result<(), (u8, rusb::Error)> {
    handle.claim_interface(0).map_err(|error| (0, error))?;
    if let Err(error) = handle.claim_interface(1) {
        let _ = handle.release_interface(0);
        return Err((1, error));
    }
    Ok(())
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
            let speed = device.speed();
            let identity = Self::probe_usb_identity(&device, &desc);
            let label = if let Some(profile) = identity.profile {
                format!(
                    "{} {} {vid:04x}:{pid:04x} bus {bus} addr {address}",
                    profile.vendor, profile.model
                )
            } else {
                format!("PXLogic USB {vid:04x}:{pid:04x} bus {bus} addr {address}")
            };
            let profile_model = identity.profile.map(|profile| profile.model.to_string());
            devices.push(DeviceInfo {
                id: usb_device_id(vid, pid, bus, address),
                kind: DeviceKind::Usb,
                vid,
                pid,
                bus: Some(bus),
                address: Some(address),
                label,
                ready: identity.ready,
                manufacturer: identity.manufacturer,
                product: identity.product,
                serial_number: identity.serial_number,
                usb_speed: Some(usb_speed_label(speed).to_string()),
                logic_mode: identity.logic_mode,
                profile_model,
                probe_error: identity.error,
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

    fn capture_streaming(
        &self,
        settings: &CaptureSettings,
        cancel: &AtomicBool,
        progress: &mut dyn FnMut(CaptureProgress),
        started: &mut dyn FnMut(&CaptureMetadata),
        samples: &mut dyn FnMut(&[u8]),
    ) -> Result<CaptureData> {
        let mut sink = |_event: DiagnosticEvent| {};
        self.capture_with_trace_streaming(
            settings,
            cancel,
            progress,
            &mut sink,
            started,
            samples,
            &mut |_| {},
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
    dirs.push(base.join("Resources").join("resources").join("bitstreams"));
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
    fn retries_only_transient_windows_usb_access_errors() {
        assert!(is_transient_usb_access_error(rusb::Error::Access));
        assert!(is_transient_usb_access_error(rusb::Error::Busy));
        assert!(!is_transient_usb_access_error(rusb::Error::NoDevice));
        assert!(!is_transient_usb_access_error(rusb::Error::Timeout));
    }

    #[test]
    fn maps_pxview_control_status_to_trigger_metadata() {
        let status = ControlStatus {
            sync_cur_sample: 12_000,
            trig_out_validset: 1,
            real_pos: 8_192,
        };
        let disabled = CaptureSettings::default();
        assert_eq!(trigger_metadata_from_status(&disabled, status), None);

        let enabled = CaptureSettings {
            trigger_enabled: true,
            trigger_channel: 7,
            trigger_kind: crate::CaptureTriggerKind::Falling,
            ..CaptureSettings::default()
        };
        assert_eq!(
            trigger_metadata_from_status(&enabled, status),
            Some(CaptureTriggerMetadata {
                sample_index: 8_192,
                channel: 7,
                kind: crate::CaptureTriggerKind::Falling,
            })
        );
    }

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

    #[test]
    fn bitstream_search_dirs_include_macos_app_resource_layout() {
        let contents_dir = PathBuf::from("/Applications/PXLogic Studio.app/Contents");
        let mut dirs = Vec::new();
        push_relative_resource_dirs(&mut dirs, &contents_dir);

        assert!(dirs.contains(
            &contents_dir
                .join("Resources")
                .join("resources")
                .join("bitstreams")
        ));
    }

    #[test]
    fn fragmented_cross_stream_keeps_only_the_incomplete_stripe() {
        for channel_count in [1u8, 2, 4, 8, 16, 32] {
            let enabled_channels = (0..channel_count).collect::<Vec<_>>();
            let stripe_bytes = usize::from(channel_count) * 8;
            let raw = (0..stripe_bytes * 3)
                .map(|index| (index.wrapping_mul(17) & 0xff) as u8)
                .collect::<Vec<_>>();
            let expected = decode_cross_data_to_physical_channels(
                channel_count,
                &enabled_channels,
                &raw,
                false,
            )
            .unwrap();
            let mut pending = Vec::new();
            let mut decoded = Vec::new();
            let mut published = Vec::new();
            let mut sink = |chunk: &[u8]| published.extend_from_slice(chunk);

            for chunk in raw.chunks(73) {
                publish_cross_stream_samples(
                    chunk,
                    channel_count,
                    &enabled_channels,
                    &mut pending,
                    &mut decoded,
                    &mut sink,
                )
                .unwrap();
                assert!(pending.len() < stripe_bytes);
            }

            assert!(pending.is_empty());
            assert_eq!(decoded, expected);
            assert_eq!(published, expected);
        }
    }

    #[test]
    fn low_rate_stream_waits_for_a_full_pxview_transfer() {
        let settings = CaptureSettings {
            sample_rate_hz: 2_000,
            channel_count: 32,
            mode: CaptureMode::Stream,
            ..CaptureSettings::default()
        };
        let transfer_size = pxview_capture_transfer_size(2_000, 32, false).unwrap();
        assert_eq!(transfer_size, 128 * 1024);
        let timeout = capture_stall_timeout(&settings, 32, transfer_size).unwrap();
        assert!(timeout >= Duration::from_secs(37));
        assert!(timeout <= Duration::from_secs(38));
    }

    #[test]
    fn triggered_capture_has_no_idle_stall_deadline() {
        let settings = CaptureSettings {
            trigger_enabled: true,
            ..CaptureSettings::default()
        };
        assert_eq!(capture_stall_timeout(&settings, 16, 256 * 1024), None);
    }
}
