use std::{
    sync::atomic::{AtomicBool, Ordering},
    thread,
    time::Duration,
};

use chrono::Utc;

use crate::{
    capture::{
        sample_count_from_duration, sample_count_from_settings, unitsize_for_channel_count,
        DemoAnalyzerSettings, DemoSampleGenerator,
    },
    device::{DeviceDescriptor, DeviceDriver, DriverIsolation},
    error::{CoreError, Result},
    models::{
        CaptureData, CaptureMetadata, CaptureMode, CaptureProgress, CaptureSettings, DeviceInfo,
        DeviceKind, HardwareCaptureCapabilities,
    },
    protocol::{PXLOGIC_WCH_PID, PXLOGIC_WCH_VID},
    transport::CaptureBackend,
};

#[derive(Debug, Default, Clone)]
pub struct FakeBackend;

impl FakeBackend {
    pub const DEVICE_ID: &'static str = "fake:sigpilot-demo";

    pub fn capture_streaming_with_analyzers(
        &self,
        settings: &CaptureSettings,
        analyzers: &[DemoAnalyzerSettings],
        cancel: &AtomicBool,
        progress: &mut dyn FnMut(CaptureProgress),
        started: &mut dyn FnMut(&CaptureMetadata),
        on_samples: &mut dyn FnMut(&[u8]),
    ) -> Result<CaptureData> {
        self.capture_streaming_generated(settings, analyzers, cancel, progress, started, on_samples)
    }

    fn capture_streaming_generated(
        &self,
        settings: &CaptureSettings,
        analyzers: &[DemoAnalyzerSettings],
        cancel: &AtomicBool,
        progress: &mut dyn FnMut(CaptureProgress),
        started: &mut dyn FnMut(&CaptureMetadata),
        on_samples: &mut dyn FnMut(&[u8]),
    ) -> Result<CaptureData> {
        if settings.device_id != Self::DEVICE_ID {
            tracing::warn!(
                target: "sigpilot::capture",
                requested_device_id = settings.device_id.as_str(),
                expected_device_id = Self::DEVICE_ID,
                "demo source asked to capture a device it does not own"
            );
            return Err(CoreError::UnsupportedDevice);
        }

        let unitsize_u8 = unitsize_for_channel_count(settings.channel_count)?;
        let unitsize = u64::from(unitsize_u8);
        let sample_count = if matches!(settings.mode, CaptureMode::Stream) {
            sample_count_from_settings(settings, unitsize_u8)?
        } else {
            sample_count_from_duration(
                settings.sample_rate_hz,
                settings.duration_ms,
                settings.decode_cross,
            )?
        };
        let bytes_expected = sample_count * unitsize;
        let started_at = std::time::Instant::now();
        tracing::info!(
            target: "sigpilot::capture",
            device_id = settings.device_id.as_str(),
            mode = format!("{:?}", settings.mode),
            sample_rate_hz = settings.sample_rate_hz,
            duration_ms = settings.duration_ms,
            channels = settings.channel_count,
            sample_count,
            unitsize = unitsize_u8,
            bytes_expected,
            "demo capture requested"
        );
        let captured_at = Utc::now();
        let mut samples_read = 0u64;
        let mut samples = Vec::with_capacity(
            usize::try_from(bytes_expected)
                .unwrap_or(INITIAL_CAPTURE_RESERVE_BYTES)
                .min(INITIAL_CAPTURE_RESERVE_BYTES),
        );
        let enabled_channels = crate::capture::resolve_enabled_channels(
            settings.channel_count,
            &settings.enabled_channels,
        )?;
        let mut generator = DemoSampleGenerator::with_analyzers(settings, unitsize_u8, analyzers)?;
        let metadata = CaptureMetadata {
            version: 1,
            source_device: settings.device_id.clone(),
            sample_rate_hz: settings.sample_rate_hz,
            channel_count: settings.channel_count,
            enabled_channels,
            unitsize: unitsize_u8,
            sample_count: 0,
            captured_at,
            labels: (0..settings.channel_count)
                .map(|channel| format!("D{channel}"))
                .collect(),
            trigger: None,
        };
        tracing::info!(
            target: "sigpilot::capture",
            device_id = metadata.source_device.as_str(),
            channels = metadata.channel_count,
            enabled_channels = metadata.enabled_channels.len(),
            sample_rate_hz = metadata.sample_rate_hz,
            "demo capture started"
        );
        started(&metadata);

        loop {
            if cancel.load(Ordering::Acquire) {
                let partial_samples = samples_read.max(1).min(sample_count);
                if samples_read == 0 {
                    let chunk = generator.generate(1);
                    on_samples(&chunk);
                    samples.extend_from_slice(&chunk);
                }
                progress(CaptureProgress {
                    bytes_read: partial_samples * unitsize,
                    bytes_expected,
                    samples_read: partial_samples,
                    sample_memory_bytes: samples.len() as u64,
                });
                tracing::info!(
                    target: "sigpilot::capture",
                    device_id = settings.device_id.as_str(),
                    samples = partial_samples,
                    requested_samples = sample_count,
                    bytes = samples.len(),
                    elapsed_ms = started_at.elapsed().as_secs_f64() * 1_000.0,
                    "demo capture cancelled"
                );
                return Ok(CaptureData {
                    metadata: CaptureMetadata {
                        sample_count: partial_samples,
                        ..metadata
                    },
                    samples,
                });
            }
            let next_samples = if matches!(settings.mode, CaptureMode::Stream) {
                let elapsed_samples =
                    (started_at.elapsed().as_secs_f64() * settings.sample_rate_hz as f64) as u64;
                elapsed_samples.max(1).min(sample_count)
            } else {
                let elapsed = started_at.elapsed().as_millis() as u64;
                let duration = settings.duration_ms.max(1);
                sample_count
                    .saturating_mul(elapsed.min(duration))
                    .checked_div(duration)
                    .unwrap_or(sample_count)
                    .max(1)
                    .min(sample_count)
            };
            let mut remaining = next_samples.saturating_sub(samples_read);
            let mut cancellation_observed = false;
            while remaining > 0 {
                if cancel.load(Ordering::Acquire) {
                    cancellation_observed = true;
                    break;
                }
                let chunk_samples = remaining.min(DEMO_GENERATION_CHUNK_SAMPLES);
                let chunk = generator.generate(chunk_samples);
                on_samples(&chunk);
                samples.extend_from_slice(&chunk);
                samples_read += chunk_samples;
                remaining -= chunk_samples;
            }
            progress(CaptureProgress {
                bytes_read: samples_read * unitsize,
                bytes_expected,
                samples_read,
                sample_memory_bytes: samples.len() as u64,
            });
            if cancellation_observed {
                continue;
            }
            if samples_read >= sample_count {
                break;
            }
            thread::sleep(Duration::from_millis(50));
        }

        tracing::info!(
            target: "sigpilot::capture",
            device_id = settings.device_id.as_str(),
            samples = sample_count,
            bytes = samples.len(),
            expected_bytes = bytes_expected,
            elapsed_ms = started_at.elapsed().as_secs_f64() * 1_000.0,
            "demo capture completed"
        );
        Ok(CaptureData {
            metadata: CaptureMetadata {
                sample_count,
                ..metadata
            },
            samples,
        })
    }
}

const INITIAL_CAPTURE_RESERVE_BYTES: usize = 8 * 1024 * 1024;
const DEMO_GENERATION_CHUNK_SAMPLES: u64 = 262_144;

impl CaptureBackend for FakeBackend {
    fn list_devices(&self) -> Result<Vec<DeviceInfo>> {
        Ok(vec![DeviceInfo {
            id: Self::DEVICE_ID.to_string(),
            kind: DeviceKind::Fake,
            vid: PXLOGIC_WCH_VID,
            pid: PXLOGIC_WCH_PID,
            bus: None,
            address: None,
            label: "SigPilot Demo Source".to_string(),
            ready: true,
            manufacturer: Some("SigPilot".to_string()),
            product: Some("Demo Device".to_string()),
            serial_number: None,
            usb_speed: None,
            logic_mode: None,
            profile_model: Some("SigPilot Demo Source".to_string()),
            probe_error: None,
        }])
    }

    fn prepare_device(
        &self,
        device_id: &str,
        _bitstreams: Option<&crate::models::Bitstreams>,
    ) -> Result<()> {
        if device_id == Self::DEVICE_ID {
            Ok(())
        } else {
            Err(CoreError::UnsupportedDevice)
        }
    }

    fn capture(
        &self,
        settings: &CaptureSettings,
        cancel: &AtomicBool,
        progress: &mut dyn FnMut(CaptureProgress),
    ) -> Result<CaptureData> {
        self.capture_streaming(settings, cancel, progress, &mut |_| {}, &mut |_| {})
    }

    fn capture_streaming(
        &self,
        settings: &CaptureSettings,
        cancel: &AtomicBool,
        progress: &mut dyn FnMut(CaptureProgress),
        started: &mut dyn FnMut(&CaptureMetadata),
        on_samples: &mut dyn FnMut(&[u8]),
    ) -> Result<CaptureData> {
        self.capture_streaming_generated(settings, &[], cancel, progress, started, on_samples)
    }
}

/// [`DeviceDriver`] adapter for the built-in demo source.
///
/// This exists so the workbench has a driver that works with no hardware
/// attached, and so the registry has a second implementation exercising the same
/// contract as the real PXLogic driver.
#[derive(Debug, Clone)]
pub struct FakeDriver {
    descriptor: DeviceDescriptor,
}

impl FakeDriver {
    /// Stable driver identifier.
    pub const DRIVER_ID: &'static str = "fake";
    /// Device-id scheme owned by this driver (`fake:<...>`).
    pub const ID_SCHEME: &'static str = "fake";

    pub fn new() -> Self {
        Self {
            descriptor: DeviceDescriptor {
                driver_id: Self::DRIVER_ID.to_string(),
                display_name: "Demo source".to_string(),
                protocol_version: DeviceDescriptor::PROTOCOL_VERSION,
                vendor: None,
                isolation: DriverIsolation::InProcess,
                id_schemes: vec![Self::ID_SCHEME.to_string()],
            },
        }
    }
}

impl Default for FakeDriver {
    fn default() -> Self {
        Self::new()
    }
}

impl DeviceDriver for FakeDriver {
    fn descriptor(&self) -> &DeviceDescriptor {
        &self.descriptor
    }

    fn list_devices(&self) -> Result<Vec<DeviceInfo>> {
        FakeBackend::default().list_devices()
    }

    fn capabilities(&self, device_id: &str) -> Result<HardwareCaptureCapabilities> {
        if device_id != FakeBackend::DEVICE_ID {
            return Err(CoreError::UnsupportedDevice);
        }
        let mut capabilities = crate::pxview_profile::generic_logic_capture_capabilities(
            device_id,
            "SigPilot Preview Device",
        );
        // Synthetic analog signals are rendered by the Demo frontend only.
        capabilities.max_analog_channels = 16;
        capabilities.analog_sample_rates = vec![
            1_000_000, 2_500_000, 5_000_000, 6_250_000, 10_000_000, 12_500_000, 25_000_000,
        ];
        Ok(capabilities)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn demo_explicitly_advertises_synthetic_analog_channels() {
        let caps = FakeDriver::new().capabilities(FakeBackend::DEVICE_ID).unwrap();
        assert_eq!(caps.max_channels, 32);
        assert_eq!(caps.max_analog_channels, 16);
        assert_eq!(caps.analog_sample_rates.len(), 7);
        assert!(caps.analog_sample_rates.contains(&6_250_000));
    }

    #[test]
    fn demo_capture_checks_cancellation_between_small_generation_chunks() {
        let backend = FakeBackend;
        let settings = CaptureSettings {
            sample_rate_hz: 100_000_000,
            buffer_size_mb: 16,
            ..CaptureSettings::default()
        };
        let cancel = AtomicBool::new(false);
        let mut chunk_sizes = Vec::new();

        let capture = backend
            .capture_streaming_with_analyzers(
                &settings,
                &[],
                &cancel,
                &mut |_| {},
                &mut |_| thread::sleep(Duration::from_millis(40)),
                &mut |chunk| {
                    chunk_sizes.push(chunk.len());
                    cancel.store(true, Ordering::Release);
                },
            )
            .expect("demo capture should return the partial capture after cancellation");

        assert_eq!(chunk_sizes.len(), 1);
        assert!(chunk_sizes[0] <= DEMO_GENERATION_CHUNK_SAMPLES as usize);
        assert_eq!(capture.samples.len(), chunk_sizes[0]);
        assert_eq!(capture.metadata.sample_count as usize, chunk_sizes[0]);
    }
}
