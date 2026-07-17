use std::{
    sync::atomic::{AtomicBool, Ordering},
    thread,
    time::Duration,
};

use crate::{
    capture::{
        generate_sample_words_with_count, sample_count_from_duration, sample_count_from_settings,
        unitsize_for_channel_count,
    },
    error::{CoreError, Result},
    models::{CaptureData, CaptureMode, CaptureProgress, CaptureSettings, DeviceInfo, DeviceKind},
    protocol::{PXLOGIC_WCH_PID, PXLOGIC_WCH_VID},
    transport::CaptureBackend,
};

#[derive(Debug, Default, Clone)]
pub struct FakeBackend;

impl FakeBackend {
    pub const DEVICE_ID: &'static str = "fake:pxlogic-demo";
}

const MAX_FAKE_STREAM_BYTES: u64 = 64 * 1024 * 1024;

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
        if settings.device_id != Self::DEVICE_ID {
            return Err(CoreError::UnsupportedDevice);
        }

        let unitsize_u8 = unitsize_for_channel_count(settings.channel_count)?;
        let unitsize = u64::from(unitsize_u8);
        let configured_sample_count = sample_count_from_settings(settings, unitsize_u8)?;
        let sample_count = if matches!(settings.mode, CaptureMode::Stream) {
            configured_sample_count.min(MAX_FAKE_STREAM_BYTES / unitsize)
        } else {
            sample_count_from_duration(
                settings.sample_rate_hz,
                settings.duration_ms,
                settings.decode_cross,
            )?
        };
        let bytes_expected = sample_count * unitsize;
        let started = std::time::Instant::now();
        let mut samples_read = 0u64;

        loop {
            if cancel.load(Ordering::Acquire) {
                let partial_samples = samples_read.max(1).min(sample_count);
                progress(CaptureProgress {
                    bytes_read: partial_samples * unitsize,
                    bytes_expected,
                    samples_read: partial_samples,
                });
                return generate_sample_words_with_count(settings, partial_samples, unitsize_u8);
            }
            samples_read = if matches!(settings.mode, CaptureMode::Stream) {
                let elapsed_samples =
                    (started.elapsed().as_secs_f64() * settings.sample_rate_hz as f64) as u64;
                elapsed_samples.max(1).min(sample_count)
            } else {
                let elapsed = started.elapsed().as_millis() as u64;
                let duration = settings.duration_ms.max(1);
                sample_count
                    .saturating_mul(elapsed.min(duration))
                    .checked_div(duration)
                    .unwrap_or(sample_count)
                    .max(1)
                    .min(sample_count)
            };
            progress(CaptureProgress {
                bytes_read: samples_read * unitsize,
                bytes_expected,
                samples_read,
            });
            if samples_read >= sample_count {
                break;
            }
            thread::sleep(Duration::from_millis(50));
        }

        generate_sample_words_with_count(settings, sample_count, unitsize_u8)
    }
}
