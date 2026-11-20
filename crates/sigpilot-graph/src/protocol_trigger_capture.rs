//! Acquisition lifecycle around the lossless protocol trigger engine.
//!
//! Drivers still own the bounded sample history. This controller does not run
//! threads or retain sample chunks; it only detects a match, requests stopping,
//! and trims the completed capture to exact sample coordinates.
use std::{
    sync::Arc,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use sigpilot_core::{
    protocol_trigger::{ProtocolTriggerConfig, ProtocolTriggerEngine, ProtocolTriggerStatus},
    AnalyzerDecodeSettings, CaptureData, CaptureMetadata, CaptureTriggerMetadata,
};

use crate::GraphSession;

const POST_TRIGGER_GRACE: Duration = Duration::from_secs(5);
const DELIVERY_GRACE: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProtocolTriggerReportStatus {
    Matched,
    TimedOut,
    StoppedWithoutMatch,
    BufferLimit,
    Incomplete,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProtocolTriggerReport {
    pub status: ProtocolTriggerReportStatus,
    /// Position relative to the retained capture, also used as waveform T0.
    pub trigger_sample: Option<u64>,
    /// Original sample coordinate of the first sample in the retained capture.
    pub retained_start_sample: u64,
    pub pre_trigger_complete: bool,
    pub post_trigger_complete: bool,
}

pub struct ProtocolTriggerCapture {
    config: ProtocolTriggerConfig,
    engine: Option<ProtocolTriggerEngine>,
    started: Option<Instant>,
    started_metadata: Option<CaptureMetadata>,
    matched_at: Option<Instant>,
    sample_rate_hz: u64,
    wall_timed_out: bool,
    post_stalled: bool,
    finalized: bool,
}

impl ProtocolTriggerCapture {
    pub fn new(config: ProtocolTriggerConfig) -> Self {
        Self {
            config,
            engine: None,
            started: None,
            started_metadata: None,
            matched_at: None,
            sample_rate_hz: 0,
            wall_timed_out: false,
            post_stalled: false,
            finalized: false,
        }
    }

    /// Called with the effective device format before the first sample chunk.
    pub fn start(&mut self, metadata: &CaptureMetadata) -> Result<(), String> {
        if self.started.is_some() {
            return Err("Protocol trigger capture has already started".into());
        }
        let engine = ProtocolTriggerEngine::new(self.config.clone(), metadata)?;
        self.sample_rate_hz = metadata.sample_rate_hz;
        self.engine = Some(engine);
        self.started_metadata = Some(metadata.clone());
        self.started = Some(Instant::now());
        Ok(())
    }

    /// Returns a trigger exactly once, when the complete matching event arrives.
    pub fn feed(&mut self, samples: &[u8]) -> Result<Option<CaptureTriggerMetadata>, String> {
        if self.finalized {
            return Err("Protocol trigger capture has already finished".into());
        }
        let engine = self
            .engine
            .as_mut()
            .ok_or("Protocol trigger capture has not started")?;
        // Once wall time expires, a late USB completion cannot turn a timeout
        // into a match. The driver may still retain that final chunk safely.
        if self.wall_timed_out || self.post_stalled {
            return Ok(None);
        }
        engine.feed(samples)?;
        let outcome = engine.outcome();
        if outcome.status == ProtocolTriggerStatus::Matched && self.matched_at.is_none() {
            self.matched_at = Some(Instant::now());
            return Ok(Some(CaptureTriggerMetadata {
                sample_index: outcome.trigger_sample.expect("matched trigger sample"),
                channel: outcome.channel,
                kind: None,
                protocol: Some(self.protocol_name().into()),
            }));
        }
        Ok(None)
    }

    pub fn should_stop(&self) -> bool {
        !self.finalized
            && (self.wall_timed_out
                || self.post_stalled
                || self
                    .engine
                    .as_ref()
                    .is_some_and(|engine| engine.should_stop()))
    }

    /// Polled by the acquisition owner. It has no effect after `finish`.
    pub fn tick(&mut self) -> bool {
        self.tick_at(Instant::now())
    }

    fn tick_at(&mut self, now: Instant) -> bool {
        if self.finalized {
            return false;
        }
        if self.should_stop() {
            return true;
        }
        if let Some(matched_at) = self.matched_at {
            let deadline = Duration::from_millis(self.config.post_trigger_ms)
                .saturating_add(POST_TRIGGER_GRACE);
            if now.saturating_duration_since(matched_at) >= deadline {
                self.post_stalled = true;
            }
        } else if let Some(started) = self.started {
            if now.saturating_duration_since(started)
                >= Duration::from_millis(self.config.max_wait_ms).saturating_add(DELIVERY_GRACE)
            {
                self.wall_timed_out = true;
            }
        }
        self.should_stop()
    }

    /// Some drivers report cancellation rather than an empty result when no
    /// USB data arrived. Only a known watchdog timeout may turn that into a
    /// completed, explicitly timed-out capture; other errors stay errors.
    pub fn empty_capture_if_timed_out(&self) -> Option<CaptureData> {
        if self.finalized
            || !self.wall_timed_out
            || self.engine.as_ref()?.outcome().samples_seen != 0
        {
            return None;
        }
        let mut metadata = self.started_metadata.clone()?;
        metadata.sample_count = 0;
        metadata.trigger = None;
        Some(CaptureData {
            metadata,
            samples: Vec::new(),
        })
    }

    /// Finalize metadata first, then trim so graph indexes and the saved capture
    /// agree. No-match outcomes retain the acquired data for manual inspection.
    pub fn finish(
        &mut self,
        graph: &GraphSession,
        mut capture: CaptureData,
        buffer_limit: bool,
    ) -> Result<(CaptureMetadata, usize, ProtocolTriggerReport), String> {
        if self.finalized {
            return Err("Protocol trigger capture has already finished".into());
        }
        self.finalized = true;
        let outcome = self
            .engine
            .as_ref()
            .ok_or("Protocol trigger capture has not started")?
            .outcome();
        let total = capture.metadata.sample_count;
        let mut report = ProtocolTriggerReport {
            status: if self.wall_timed_out || outcome.status == ProtocolTriggerStatus::TimedOut {
                ProtocolTriggerReportStatus::TimedOut
            } else if buffer_limit {
                ProtocolTriggerReportStatus::BufferLimit
            } else {
                ProtocolTriggerReportStatus::StoppedWithoutMatch
            },
            trigger_sample: None,
            retained_start_sample: 0,
            pre_trigger_complete: false,
            post_trigger_complete: false,
        };
        let keep = if let Some(trigger_sample) = outcome.trigger_sample {
            let start = outcome.retain_start_sample.expect("matched retain start");
            let desired_end = outcome.retain_end_sample.expect("matched retain end");
            let match_end = outcome.match_end_sample.expect("matched event end");
            if trigger_sample >= total || match_end > total {
                return Err(
                    "Acquired data does not contain the complete protocol trigger event".into(),
                );
            }
            let pre_samples = (u128::from(self.sample_rate_hz)
                * u128::from(self.config.pre_trigger_ms))
            .div_ceil(1000);
            report.trigger_sample = Some(trigger_sample - start);
            report.retained_start_sample = start;
            report.pre_trigger_complete = u128::from(trigger_sample) >= pre_samples;
            report.post_trigger_complete = total >= desired_end;
            report.status = if report.post_trigger_complete {
                ProtocolTriggerReportStatus::Matched
            } else {
                ProtocolTriggerReportStatus::Incomplete
            };
            capture.metadata.trigger = Some(CaptureTriggerMetadata {
                sample_index: trigger_sample,
                channel: outcome.channel,
                kind: None,
                protocol: Some(self.protocol_name().into()),
            });
            Some((start, desired_end.min(total)))
        } else {
            capture.metadata.trigger = None;
            None
        };
        let mut metadata = capture.metadata.clone();
        let mut bytes = capture.samples.len();
        graph
            .finish_capture(capture)
            .map_err(|error| error.to_string())?;
        if let Some((start, end)) = keep {
            if start != 0 || end != total {
                (metadata, bytes) = graph
                    .trim_capture(start, end)
                    .map_err(|error| error.to_string())?;
            }
        }
        compact_completed_capture(graph);
        Ok((metadata, bytes, report))
    }

    fn protocol_name(&self) -> &'static str {
        match &self.config.decoder {
            AnalyzerDecodeSettings::Uart(_) => "UART",
            AnalyzerDecodeSettings::I2c(_) => "I2C",
            AnalyzerDecodeSettings::Spi(_) => "SPI",
            _ => unreachable!("validated protocol trigger settings"),
        }
    }
}

/// A driver may reserve megabytes before producing its first sample, and
/// trimming a Vec only changes its length. Release that unused allocation when
/// software acquisition finishes so a small triggered window stays small.
/// This deliberately leaves the interactive/manual trim path unchanged.
fn compact_completed_capture(session: &GraphSession) {
    let _mutation = session.capture_mutation.lock();
    // Match trim_capture's mutation -> graph -> capture lock ordering.
    let mut graph = session.graph.write();
    let mut capture = session.capture.write();
    if let Some(capture) = capture.as_mut() {
        Arc::make_mut(capture).samples.shrink_to_fit();
    }
    if let Some(graph) = graph.as_mut() {
        for channel in &mut graph.channels {
            channel.edges.shrink_to_fit();
        }
    }
}

#[cfg(test)]
mod tests {
    use std::{
        cell::RefCell,
        sync::atomic::{AtomicBool, AtomicU64, Ordering},
    };

    use sigpilot_core::{
        protocol_trigger::{I2cTriggerEvent, ProtocolTriggerCondition, SpiTriggerLine},
        CaptureMode, CaptureSettings, DecoderBackendKind, DemoAnalyzerSettings, FakeBackend,
        I2cDecodeSettings, SpiDecodeSettings, UartDecodeSettings,
    };

    use super::*;

    fn config(bytes: &[u8]) -> ProtocolTriggerConfig {
        ProtocolTriggerConfig {
            analyzer_id: "demo-uart".into(),
            decoder: AnalyzerDecodeSettings::Uart(UartDecodeSettings {
                channel: 0,
                baud_rate: 10_000,
                ..Default::default()
            }),
            condition: ProtocolTriggerCondition::UartSequence {
                bytes: bytes.to_vec(),
            },
            pre_trigger_ms: 2,
            post_trigger_ms: 3,
            max_wait_ms: 100,
        }
    }

    /// Exercise the real driver callbacks and graph finalization, including
    /// host chunks that extend beyond the requested retained window.
    fn demo(
        config: ProtocolTriggerConfig,
        stop_after_samples: Option<u64>,
        buffer_limit: bool,
    ) -> (
        GraphSession,
        CaptureMetadata,
        usize,
        ProtocolTriggerReport,
        usize,
    ) {
        demo_at_rate(config, 100_000, stop_after_samples, buffer_limit)
    }

    fn demo_at_rate(
        config: ProtocolTriggerConfig,
        sample_rate_hz: u64,
        stop_after_samples: Option<u64>,
        buffer_limit: bool,
    ) -> (
        GraphSession,
        CaptureMetadata,
        usize,
        ProtocolTriggerReport,
        usize,
    ) {
        let graph = GraphSession::default();
        let controller = RefCell::new(ProtocolTriggerCapture::new(config.clone()));
        let cancel = AtomicBool::new(false);
        let triggers = RefCell::new(0);
        let settings = CaptureSettings {
            device_id: FakeBackend::DEVICE_ID.into(),
            sample_rate_hz,
            channel_count: 8,
            enabled_channels: (0..8).collect(),
            mode: CaptureMode::Stream,
            buffer_size_mb: 1,
            trigger_enabled: false,
            ..Default::default()
        };
        let capture = FakeBackend
            .capture_streaming_with_analyzers(
                &settings,
                &[DemoAnalyzerSettings {
                    backend: DecoderBackendKind::LegacyRust,
                    settings: config.decoder,
                }],
                &cancel,
                &mut |_| {},
                &mut |metadata| {
                    graph.begin_capture(metadata.clone()).unwrap();
                    controller.borrow_mut().start(metadata).unwrap();
                },
                &mut |samples| {
                    graph.append_samples(samples).unwrap();
                    let mut controller = controller.borrow_mut();
                    if let Some(trigger) = controller.feed(samples).unwrap() {
                        *triggers.borrow_mut() += 1;
                        graph.set_trigger(trigger).unwrap();
                    }
                    if controller.should_stop()
                        || stop_after_samples.is_some_and(|limit| graph.sample_count() >= limit)
                    {
                        cancel.store(true, Ordering::Release);
                    }
                },
            )
            .unwrap();
        assert!(capture.samples.len() <= 1024 * 1024);
        let (metadata, bytes, report) = controller
            .borrow_mut()
            .finish(&graph, capture, buffer_limit)
            .unwrap();
        assert!(
            !controller.borrow_mut().tick(),
            "finished watchdog must be inert"
        );
        let triggers = *triggers.borrow();
        (graph, metadata, bytes, report, triggers)
    }

    #[test]
    fn demo_uart_trigger_trims_exactly_and_roundtrips_time_zero() {
        let (graph, metadata, bytes, report, notifications) = demo(config(b"demo"), None, false);
        // The last byte of "demo" begins at bit 124 in the actual Demo UART
        // signal: 4 leading idle bits plus 12 complete ten-bit UART frames.
        let absolute_trigger = 1_240;
        assert_eq!(report.status, ProtocolTriggerReportStatus::Matched);
        assert_eq!(report.trigger_sample, Some(200));
        assert_eq!(report.retained_start_sample, absolute_trigger - 200);
        assert!(report.pre_trigger_complete && report.post_trigger_complete);
        assert_eq!(metadata.sample_count, 500);
        assert_eq!(bytes, 500);
        assert_eq!(notifications, 1);
        let trigger = metadata.trigger.as_ref().unwrap();
        assert_eq!(trigger.sample_index, 200);
        assert_eq!(trigger.protocol.as_deref(), Some("UART"));
        assert_eq!(trigger.kind, None);
        assert_eq!(graph.metadata(), Some(metadata.clone()));
        let usage = graph.capture_memory_usage(1024 * 1024, None);
        assert!(
            usage.total_bytes <= 64 * 1024,
            "500 retained samples kept the driver's 1 MiB reserve: {usage:?}"
        );
        let capture = graph.capture().unwrap();
        assert_eq!(capture.metadata, metadata);
        static NEXT_FILE: AtomicU64 = AtomicU64::new(1);
        let path = std::env::temp_dir().join(format!(
            "sigpilot-protocol-trigger-{}-{}.pxl",
            std::process::id(),
            NEXT_FILE.fetch_add(1, Ordering::Relaxed)
        ));
        sigpilot_file::save_pxl_packed(&path, &capture, &Default::default()).unwrap();
        let project = sigpilot_file::open_pxl(&path).unwrap();
        std::fs::remove_file(path).unwrap();
        match project.capture {
            sigpilot_file::PxlogicProjectCapture::Packed(reopened) => {
                assert_eq!(reopened.metadata, capture.metadata);
                assert_eq!(reopened.samples, capture.samples);
            }
            _ => panic!("packed capture changed representation"),
        }
    }

    #[test]
    fn demo_i2c_nack_matches_address_and_data_on_the_real_sample_stream() {
        let mut config = config(&[]);
        config.decoder = AnalyzerDecodeSettings::I2c(I2cDecodeSettings {
            sda_channel: 1,
            scl_channel: 2,
        });
        config.condition = ProtocolTriggerCondition::I2c {
            address: Some(0x20),
            event: I2cTriggerEvent::Nack,
            data: Some(0x90),
        };
        let (graph, metadata, _, report, notifications) =
            demo_at_rate(config, 1_000_000, None, false);
        assert_eq!(report.status, ProtocolTriggerReportStatus::Matched);
        assert_eq!(notifications, 1);
        let trigger = metadata.trigger.unwrap();
        assert_eq!(trigger.protocol.as_deref(), Some("I2C"));
        assert_eq!(trigger.channel, 1);
        // Third byte starts on rising SCL at phase 40; half period is 5 samples.
        assert_eq!(trigger.sample_index + report.retained_start_sample, 200);
        assert!(report.post_trigger_complete);
        assert_eq!(
            graph.capture().unwrap().samples.len() as u64,
            metadata.sample_count
        );
    }

    #[test]
    fn demo_spi_mosi_matches_modes_zero_and_three_on_the_real_sample_stream() {
        for (clock_polarity, clock_phase) in [(false, false), (true, true)] {
            let mut config = config(&[]);
            config.decoder = AnalyzerDecodeSettings::Spi(SpiDecodeSettings {
                mosi_channel: Some(3),
                miso_channel: Some(4),
                clock_channel: 5,
                enable_channel: Some(6),
                clock_polarity,
                clock_phase,
                ..Default::default()
            });
            config.condition = ProtocolTriggerCondition::SpiSequence {
                values: vec![0x4c],
                line: SpiTriggerLine::Mosi,
            };
            let (_, metadata, _, report, notifications) =
                demo_at_rate(config, 1_000_000, None, false);
            assert_eq!(
                report.status,
                ProtocolTriggerReportStatus::Matched,
                "CPOL={clock_polarity}, CPHA={clock_phase}"
            );
            assert_eq!(notifications, 1);
            let trigger = metadata.trigger.unwrap();
            assert_eq!(trigger.protocol.as_deref(), Some("SPI"));
            assert_eq!(trigger.channel, 3);
            assert!(report.post_trigger_complete);
            assert!(
                trigger.sample_index < 40,
                "must match the first generated SPI word"
            );
        }
    }

    #[test]
    fn demo_no_match_reports_sample_timeout_without_false_trigger() {
        let mut config = config(&[0xff]);
        config.max_wait_ms = 10;
        let (_, metadata, _, report, notifications) = demo(config, None, false);
        assert_eq!(report.status, ProtocolTriggerReportStatus::TimedOut);
        assert_eq!(report.trigger_sample, None);
        assert_eq!(metadata.trigger, None);
        assert_eq!(notifications, 0);
    }

    #[test]
    fn early_user_stop_is_not_a_timeout() {
        let (_, metadata, _, report, notifications) = demo(config(b"demo"), Some(1), false);
        assert_eq!(
            report.status,
            ProtocolTriggerReportStatus::StoppedWithoutMatch
        );
        assert!(metadata.sample_count > 0 && metadata.sample_count < 1_240);
        assert_eq!(metadata.trigger, None);
        assert_eq!(notifications, 0);
    }

    #[test]
    fn buffer_exhaustion_without_match_is_reported_separately() {
        let (_, metadata, _, report, _) = demo(config(&[0xff]), Some(1), true);
        assert_eq!(report.status, ProtocolTriggerReportStatus::BufferLimit);
        assert_eq!(metadata.trigger, None);
    }

    #[test]
    fn user_stop_after_match_preserves_marker_and_reports_short_post_window() {
        let mut config = config(b"demo");
        config.post_trigger_ms = 1000;
        let (_, metadata, _, report, notifications) = demo(config, Some(2_000), false);
        assert_eq!(report.status, ProtocolTriggerReportStatus::Incomplete);
        assert!(report.pre_trigger_complete);
        assert!(!report.post_trigger_complete);
        assert_eq!(metadata.trigger.unwrap().sample_index, 200);
        assert_eq!(notifications, 1);
    }

    #[test]
    fn early_match_reports_missing_pretrigger_history() {
        let mut config = config(b"demo");
        config.pre_trigger_ms = 60;
        let (_, metadata, _, report, _) = demo(config, None, false);
        assert_eq!(report.status, ProtocolTriggerReportStatus::Matched);
        assert!(!report.pre_trigger_complete);
        assert!(report.post_trigger_complete);
        assert_eq!(report.retained_start_sample, 0);
        assert_eq!(metadata.trigger.unwrap().sample_index, 1_240);
    }

    #[test]
    fn watchdog_times_out_when_no_usb_samples_arrive() {
        let mut controller = ProtocolTriggerCapture::new(config(b"demo"));
        let metadata = CaptureMetadata {
            version: 1,
            source_device: FakeBackend::DEVICE_ID.into(),
            sample_rate_hz: 100_000,
            channel_count: 1,
            enabled_channels: vec![0],
            unitsize: 1,
            sample_count: 0,
            captured_at: chrono::Utc::now(),
            labels: vec!["D0".into()],
            trigger: None,
        };
        controller.start(&metadata).unwrap();
        assert!(controller.empty_capture_if_timed_out().is_none());
        assert!(!controller.tick_at(controller.started.unwrap() + Duration::from_millis(5_099)));
        assert!(controller.tick_at(controller.started.unwrap() + Duration::from_millis(5_100)));
        assert!(controller.wall_timed_out);
        assert_eq!(controller.feed(&[0xff]).unwrap(), None);
        let graph = GraphSession::default();
        graph.begin_capture(metadata.clone()).unwrap();
        let empty = controller.empty_capture_if_timed_out().unwrap();
        assert_eq!(empty.metadata, metadata);
        let (_, _, report) = controller.finish(&graph, empty, false).unwrap();
        assert_eq!(report.status, ProtocolTriggerReportStatus::TimedOut);
        assert!(!controller.tick_at(Instant::now() + Duration::from_secs(3600)));
        assert!(controller.empty_capture_if_timed_out().is_none());
    }

    #[test]
    fn watchdog_stops_a_stalled_post_window_without_calling_it_no_match() {
        let mut source_config = config(b"demo");
        source_config.pre_trigger_ms = 60;
        let (source, _, _, _, _) = demo(source_config, None, false);
        let source = source.capture().unwrap();
        let mut config = config(b"o");
        config.post_trigger_ms = 1000;
        config.max_wait_ms = 20;
        let mut controller = ProtocolTriggerCapture::new(config);
        let mut metadata = source.metadata.clone();
        metadata.trigger = None;
        metadata.sample_count = 0;
        controller.start(&metadata).unwrap();
        let graph = GraphSession::default();
        graph.begin_capture(metadata).unwrap();
        graph.append_samples(&source.samples).unwrap();
        // A valid event within 20 ms of sample time can arrive in a host USB
        // callback after 50 ms. The wall watchdog must allow its delivery.
        assert!(!controller.tick_at(controller.started.unwrap() + Duration::from_millis(50)));
        assert!(controller.feed(&source.samples).unwrap().is_some());
        let matched_at = controller.matched_at.unwrap();
        assert!(!controller.tick_at(matched_at + Duration::from_millis(5_999)));
        assert!(controller.tick_at(matched_at + Duration::from_secs(6)));
        let (_, _, report) = controller
            .finish(&graph, source.as_ref().clone(), false)
            .unwrap();
        assert_eq!(report.status, ProtocolTriggerReportStatus::Incomplete);
        assert!(report.trigger_sample.is_some());
        assert!(!report.post_trigger_complete);
    }
}
