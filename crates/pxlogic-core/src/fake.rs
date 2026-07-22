use std::{
    sync::atomic::{AtomicBool, Ordering},
    thread,
    time::Duration,
};

use chrono::Utc;

use crate::{
    capture::{
        sample_count_from_duration, sample_count_from_settings, unitsize_for_channel_count,
        DemoSampleGenerator,
    },
    error::{CoreError, Result},
    models::{
        CaptureData, CaptureMetadata, CaptureMode, CaptureProgress, CaptureSettings, DeviceInfo,
        DeviceKind,
    },
    protocol::{PXLOGIC_WCH_PID, PXLOGIC_WCH_VID},
    transport::CaptureBackend,
};

#[derive(Debug, Default, Clone)]
pub struct FakeBackend;

impl FakeBackend {
    pub const DEVICE_ID: &'static str = "fake:pxlogic-demo";
}

const INITIAL_CAPTURE_RESERVE_BYTES: usize = 8 * 1024 * 1024;

impl CaptureBackend for FakeBackend {
    fn list_devices(&self) -> Result<Vec<DeviceInfo>> {
        Ok(vec![DeviceInfo {
            id: Self::DEVICE_ID.to_string(),
            kind: DeviceKind::Fake,
            vid: PXLOGIC_WCH_VID,
            pid: PXLOGIC_WCH_PID,
            bus: None,
            address: None,
            label: "PXLogic Demo Source".to_string(),
            ready: true,
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
        if settings.device_id != Self::DEVICE_ID {
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
        let captured_at = Utc::now();
        let mut samples_read = 0u64;
        let mut samples = Vec::with_capacity(
            usize::try_from(bytes_expected)
                .unwrap_or(INITIAL_CAPTURE_RESERVE_BYTES)
                .min(INITIAL_CAPTURE_RESERVE_BYTES),
        );
        let mut generator = DemoSampleGenerator::new(settings, unitsize_u8);
        let metadata = CaptureMetadata {
            version: 1,
            source_device: settings.device_id.clone(),
            sample_rate_hz: settings.sample_rate_hz,
            channel_count: settings.channel_count,
            unitsize: unitsize_u8,
            sample_count: 0,
            captured_at,
            labels: (0..settings.channel_count)
                .map(|channel| format!("D{channel}"))
                .collect(),
        };
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
                });
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
            while remaining > 0 {
                let chunk_samples = remaining.min(1_048_576);
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
            });
            if samples_read >= sample_count {
                break;
            }
            thread::sleep(Duration::from_millis(33));
        }

        Ok(CaptureData {
            metadata: CaptureMetadata {
                sample_count,
                ..metadata
            },
            samples,
        })
    }
}
