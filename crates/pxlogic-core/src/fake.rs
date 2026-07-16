use std::{
    sync::atomic::{AtomicBool, Ordering},
    thread,
    time::Duration,
};

use crate::{
    capture::{generate_sample_words, sample_count_from_duration, unitsize_for_channel_count},
    error::{CoreError, Result},
    models::{CaptureData, CaptureProgress, CaptureSettings, DeviceInfo, DeviceKind},
    protocol::{PXLOGIC_WCH_PID, PXLOGIC_WCH_VID},
    transport::CaptureBackend,
};

#[derive(Debug, Default, Clone)]
pub struct FakeBackend;

impl FakeBackend {
    pub const DEVICE_ID: &'static str = "fake:pxlogic-demo";
}

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

        let unitsize = u64::from(unitsize_for_channel_count(settings.channel_count)?);
        let sample_count = sample_count_from_duration(
            settings.sample_rate_hz,
            settings.duration_ms,
            settings.decode_cross,
        )?;
        let bytes_expected = sample_count * unitsize;
        let checkpoints = 8u64;
        for step in 0..=checkpoints {
            if cancel.load(Ordering::Acquire) {
                return Err(CoreError::Cancelled);
            }
            let samples_read = sample_count * step / checkpoints;
            progress(CaptureProgress {
                bytes_read: samples_read * unitsize,
                bytes_expected,
                samples_read,
            });
            thread::sleep(Duration::from_millis(12));
        }

        generate_sample_words(settings)
    }
}
