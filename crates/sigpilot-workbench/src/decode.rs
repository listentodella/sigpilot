//! Temporary, supervised decode jobs; no mutation of GUI analyzer settings.
use crate::{
    jobs::{JobFailure, JobOutput, JobSnapshot, JOB_RETENTION},
    process, CaptureRef, Result, WorkbenchError, WorkbenchService,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sigpilot_analysis::{
    frames::{query_frames_with_cancel, FrameQuery},
    ExactU64, SampleRange,
};
use sigpilot_core::{
    AnalyzerDecodeSettings, I2cDecodeSettings, SaleaeNativeDecoder, SparseCaptureData,
    SparseDigitalChannel, SpiDecodeSettings, UartDecodeSettings, UartParity, UartStopBits,
};
use std::{
    collections::VecDeque,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Instant,
};

const MAX_INPUT_EDGES: usize = 65_536;
const MAX_CURSORS: usize = 128;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "protocol", content = "settings", deny_unknown_fields)]
pub enum DecodeConfig {
    #[serde(rename = "UART")]
    Uart(UartConfig),
    #[serde(rename = "I2C")]
    I2c(I2cConfig),
    #[serde(rename = "SPI")]
    Spi(SpiConfig),
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UartConfig {
    pub channel: u8,
    pub baud_rate: ExactU64,
    #[serde(default)]
    pub inverted: bool,
    #[serde(default = "eight")]
    pub data_bits: u8,
    #[serde(default = "one")]
    pub stop_bits: String,
    #[serde(default)]
    pub parity: UartParity,
    #[serde(default)]
    pub msb_first: bool,
}
fn eight() -> u8 {
    8
}
fn one() -> String {
    "1".into()
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct I2cConfig {
    pub sda_channel: u8,
    pub scl_channel: u8,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SpiConfig {
    pub mosi_channel: Option<u8>,
    pub miso_channel: Option<u8>,
    pub clock_channel: u8,
    pub enable_channel: Option<u8>,
    #[serde(default = "yes")]
    pub enable_active_low: bool,
    #[serde(default)]
    pub clock_polarity: bool,
    #[serde(default)]
    pub clock_phase: bool,
    #[serde(default = "eight")]
    pub bits_per_transfer: u8,
    #[serde(default = "yes")]
    pub msb_first: bool,
}
fn yes() -> bool {
    true
}

impl DecodeConfig {
    pub fn protocol(&self) -> &'static str {
        match self {
            Self::Uart(_) => "UART",
            Self::I2c(_) => "I2C",
            Self::Spi(_) => "SPI",
        }
    }
    pub(crate) fn settings(&self) -> Result<AnalyzerDecodeSettings> {
        Ok(match self {
            Self::Uart(s) => {
                let baud_rate = u32::try_from(s.baud_rate.0)
                    .map_err(|_| WorkbenchError::InvalidRequest("baud_rate exceeds u32".into()))?;
                let stop_bits = match s.stop_bits.as_str() {
                    "1" => UartStopBits::One,
                    "1.5" => UartStopBits::OnePointFive,
                    "2" => UartStopBits::Two,
                    _ => {
                        return Err(WorkbenchError::InvalidRequest(
                            "stop_bits must be 1, 1.5 or 2".into(),
                        ))
                    }
                };
                if baud_rate == 0 || !(5..=9).contains(&s.data_bits) {
                    return Err(WorkbenchError::InvalidRequest(
                        "invalid UART baud/data bits".into(),
                    ));
                }
                AnalyzerDecodeSettings::Uart(UartDecodeSettings {
                    channel: s.channel,
                    baud_rate,
                    inverted: s.inverted,
                    data_bits: s.data_bits,
                    stop_bits,
                    parity: s.parity,
                    msb_first: s.msb_first,
                })
            }
            Self::I2c(s) => AnalyzerDecodeSettings::I2c(I2cDecodeSettings {
                sda_channel: s.sda_channel,
                scl_channel: s.scl_channel,
            }),
            Self::Spi(s) => {
                if (s.mosi_channel.is_none() && s.miso_channel.is_none())
                    || s.bits_per_transfer == 0
                    || s.bits_per_transfer > 64
                {
                    return Err(WorkbenchError::InvalidRequest(
                        "SPI requires data channel and 1..64 bits".into(),
                    ));
                }
                AnalyzerDecodeSettings::Spi(SpiDecodeSettings {
                    mosi_channel: s.mosi_channel,
                    miso_channel: s.miso_channel,
                    clock_channel: s.clock_channel,
                    enable_channel: s.enable_channel,
                    enable_active_low: s.enable_active_low,
                    clock_polarity: s.clock_polarity,
                    clock_phase: s.clock_phase,
                    bits_per_transfer: s.bits_per_transfer,
                    msb_first: s.msb_first,
                })
            }
        })
    }
    pub(crate) fn channels(&self) -> Result<Vec<u8>> {
        let mut channels = match self {
            Self::Uart(s) => vec![s.channel],
            Self::I2c(s) => vec![s.sda_channel, s.scl_channel],
            Self::Spi(s) => [
                Some(s.clock_channel),
                s.mosi_channel,
                s.miso_channel,
                s.enable_channel,
            ]
            .into_iter()
            .flatten()
            .collect(),
        };
        channels.sort_unstable();
        if channels.iter().any(|c| *c >= 32) || channels.windows(2).any(|c| c[0] == c[1]) {
            return Err(WorkbenchError::InvalidRequest(
                "decoder channels must be distinct and within 0..31".into(),
            ));
        }
        Ok(channels)
    }
}

pub(crate) struct FrameCursor {
    id: String,
    owner: String,
    result_id: String,
    query: String,
    offset: usize,
    created: Instant,
}
pub(crate) type FrameCursors = VecDeque<FrameCursor>;

impl WorkbenchService {
    pub(crate) fn frame_query_offset(
        &self,
        owner: &str,
        result_id: &str,
        query: &str,
        cursor: Option<&str>,
    ) -> Result<usize> {
        let Some(cursor) = cursor else {
            return Ok(0);
        };
        let mut cursors = self.frame_cursors.lock();
        cursors.retain(|c| c.created.elapsed() < JOB_RETENTION);
        cursors
            .iter()
            .find(|c| {
                c.id == cursor && c.owner == owner && c.result_id == result_id && c.query == query
            })
            .map(|c| c.offset)
            .ok_or_else(|| {
                WorkbenchError::InvalidRequest(
                    "cursor expired or belongs to another query/result/caller".into(),
                )
            })
    }

    pub(crate) fn frame_query_cursor(
        &self,
        owner: &str,
        result_id: &str,
        query: String,
        offset: Option<usize>,
    ) -> Option<String> {
        offset.map(|offset| {
            let id = format!("cursor-{}", uuid::Uuid::new_v4().simple());
            let mut cursors = self.frame_cursors.lock();
            cursors.retain(|c| c.created.elapsed() < JOB_RETENTION);
            while cursors.len() >= MAX_CURSORS {
                cursors.pop_front();
            }
            cursors.push_back(FrameCursor {
                id: id.clone(),
                owner: owner.into(),
                result_id: result_id.into(),
                query,
                offset,
                created: Instant::now(),
            });
            id
        })
    }

    /// Administrative setup only: MCP cannot supply executables, plugin paths or scripts.
    pub fn set_decode_backend(&self, backend: Option<SaleaeNativeDecoder>) {
        *self.decoder.write() = backend.map(Arc::new);
    }

    pub fn decode_capabilities(&self) -> Value {
        let configured = cfg!(unix)
            && self.decoder.read().as_ref().is_some_and(|b| {
                let (path, root) = b.isolated_job_paths();
                path.is_file() && root.is_dir()
            });
        json!({"backend":"saleae_native","configured":configured,"status":if configured {"configured_not_probed"} else {"unavailable"},
            "protocols":if configured {vec!["UART","I2C","SPI"]} else {vec![]},"temporary_config_only":false,"shared_instances":true,"fields":"native_observed",
            "max_input_edges":MAX_INPUT_EDGES.to_string(),"max_frames":"4096","process_timeout_seconds":"30","process_memory_bytes":process::PROCESS_MEMORY_BYTES.to_string(),
            "input_bytes":process::PROCESS_INPUT_BYTES.to_string(),"output_bytes":process::PROCESS_OUTPUT_BYTES.to_string(),"cancellable":true})
    }

    pub fn validate_capture(&self, capture: &CaptureRef) -> Result<()> {
        let session = self.existing_session(&capture.session_id)?;
        let _lease = self.lease(&session, capture)?;
        Ok(())
    }

    pub fn run_decode(
        self: &Arc<Self>,
        owner: &str,
        capture: CaptureRef,
        range: SampleRange,
        config: DecodeConfig,
        request_id: &str,
    ) -> Result<JobSnapshot> {
        let input =
            serde_json::to_string(&json!({"capture":capture,"range":range,"config":config}))?;
        self.run_decode_frozen(owner, capture, range, config, request_id, input, None)
    }

    pub fn run_analyzer_decode(
        self: &Arc<Self>,
        owner: &str,
        capture: CaptureRef,
        range: SampleRange,
        analyzer_id: &str,
        expected_config_revision: ExactU64,
        request_id: &str,
    ) -> Result<JobSnapshot> {
        self.validate_capture(&capture)?;
        let selection =
            json!({"analyzer_id":analyzer_id,"config_revision":expected_config_revision});
        let input =
            serde_json::to_string(&json!({"capture":capture,"range":range,"analyzer":selection}))?;
        if let Some(job) = self
            .jobs
            .replay(owner, &capture, "decode", request_id, &input)?
        {
            return Ok(job);
        }
        let config = self.analyzer_config(&capture, expected_config_revision, analyzer_id)?;
        self.run_decode_frozen(
            owner,
            capture,
            range,
            config,
            request_id,
            input,
            Some(selection),
        )
    }

    fn run_decode_frozen(
        self: &Arc<Self>,
        owner: &str,
        capture: CaptureRef,
        range: SampleRange,
        config: DecodeConfig,
        request_id: &str,
        input: String,
        selection: Option<Value>,
    ) -> Result<JobSnapshot> {
        let session = self.existing_session(&capture.session_id)?;
        let lease = self.lease(&session, &capture)?;
        range
            .validate(lease.snapshot().metadata.sample_count)
            .map_err(|e| WorkbenchError::InvalidRequest(e.to_string()))?;
        if range.end_sample.0 > i64::MAX as u64 {
            return Err(WorkbenchError::InvalidRequest(
                "Saleae decode supports sample coordinates through i64::MAX".into(),
            ));
        }
        let channels = config.channels()?;
        if channels
            .iter()
            .any(|c| !crate::valid_channel(lease.snapshot(), *c))
        {
            return Err(WorkbenchError::InvalidRequest(
                "decoder uses unavailable channel".into(),
            ));
        }
        let settings = config.settings()?;
        if let DecodeConfig::Uart(s) = &config {
            if s.baud_rate.0 > lease.snapshot().metadata.sample_rate_hz {
                return Err(WorkbenchError::InvalidRequest(
                    "baud rate exceeds capture sample rate".into(),
                ));
            }
        }
        drop(lease);
        let backend = self
            .decoder
            .read()
            .clone()
            .filter(|b| {
                let (path, root) = b.isolated_job_paths();
                cfg!(unix) && path.is_file() && root.is_dir()
            })
            .ok_or_else(|| {
                WorkbenchError::DecoderUnavailable(
                    "configured Unix Saleae sidecar/runtime required".into(),
                )
            })?;
        let service = Arc::downgrade(self);
        let job_capture = capture.clone();
        self.jobs.submit(
            owner,
            capture,
            "decode",
            request_id,
            input,
            Box::new(move |cancel| {
                let service = service
                    .upgrade()
                    .ok_or_else(|| JobFailure::new("SESSION_NOT_FOUND", "workbench exited"))?;
                let sparse = service
                    .decode_input(&job_capture, range, &channels, cancel)
                    .map_err(job_error)?;
                let input = backend
                    .isolated_job_request(&sparse, &settings)
                    .map_err(|e| JobFailure::new("DECODER_ERROR", e.to_string()))?;
                let (path, root) = backend.isolated_job_paths();
                let output = process::run(path, root, input, cancel)?;
                let output: sigpilot_core::DecoderOutput = serde_json::from_slice(&output)
                    .map_err(|e| {
                        JobFailure::new(
                            "DECODER_ERROR",
                            format!("invalid structured decoder output: {e}"),
                        )
                    })?;
                if output.frames.len() > sigpilot_analysis::frames::MAX_DECODE_FRAMES {
                    return Err(JobFailure::new(
                        "RESOURCE_LIMIT",
                        "decoder exceeds 4096 frame result budget",
                    ));
                }
                let mut set = sigpilot_analysis::frames::normalize_saleae(
                    output,
                    config.protocol(),
                    channels,
                    range,
                    SampleRange {
                        start_sample: 0.into(),
                        end_sample: range.end_sample,
                    },
                    sparse.metadata.sample_count,
                )
                .map_err(|e| JobFailure::new("DECODER_ERROR", e.to_string()))?;
                set.configuration = serde_json::to_value(&config)
                    .map_err(|e| JobFailure::new("INTERNAL_ERROR", e.to_string()))?;
                if let Some(selection) = selection {
                    set.configuration = json!({"config":set.configuration,"analyzer":selection});
                }
                service.validate_capture(&job_capture).map_err(job_error)?;
                Ok(JobOutput::Decode(set))
            }),
        )
    }

    fn decode_input(
        &self,
        capture: &CaptureRef,
        range: SampleRange,
        channels: &[u8],
        cancel: &AtomicBool,
    ) -> Result<SparseCaptureData> {
        let session = self.existing_session(&capture.session_id)?;
        let lease = self.lease(&session, capture)?;
        let mut metadata = lease.snapshot().metadata.clone();
        metadata.sample_count = range.end_sample.0;
        drop(lease);
        let mut result = Vec::new();
        let mut count = 0;
        for &channel in channels {
            let mut edges = Vec::new();
            let mut start = 0;
            let mut initial_high = false;
            loop {
                if cancel.load(Ordering::Acquire) {
                    return Err(WorkbenchError::InvalidRequest(
                        "decode input cancelled".into(),
                    ));
                }
                let page = self.edge_window(
                    capture,
                    channel,
                    SampleRange {
                        start_sample: start.into(),
                        end_sample: range.end_sample,
                    },
                )?;
                if start == 0 {
                    initial_high = page.window.high_before_start;
                }
                count += page.window.transitions.len();
                if count > MAX_INPUT_EDGES {
                    return Err(WorkbenchError::ResourceLimit(
                        "decoder prefix exceeds 65536 input edges",
                    ));
                }
                edges.extend(page.window.transitions);
                if page.window.complete {
                    break;
                }
                start = page.window.end_sample;
            }
            result.push(SparseDigitalChannel {
                channel,
                initial_high,
                transitions: edges,
            });
        }
        self.validate_capture(capture)?;
        Ok(SparseCaptureData {
            metadata,
            channels: result,
        })
    }

    pub fn query_decode_frames(
        &self,
        owner: &str,
        result_id: &str,
        query: FrameQuery,
        cursor: Option<&str>,
        limit: usize,
    ) -> Result<Value> {
        self.query_decode_frames_with_cancel(
            owner,
            result_id,
            query,
            cursor,
            limit,
            &AtomicBool::new(false),
        )
    }
    pub fn query_decode_frames_with_cancel(
        &self,
        owner: &str,
        result_id: &str,
        query: FrameQuery,
        cursor: Option<&str>,
        limit: usize,
        cancel: &AtomicBool,
    ) -> Result<Value> {
        crate::check_cancelled(cancel)?;
        let (capture, output) = self.result_output(owner, result_id)?;
        self.validate_capture(&capture)?;
        let JobOutput::Decode(set) = output.as_ref() else {
            return Err(WorkbenchError::InvalidRequest(
                "result set is not a decode".into(),
            ));
        };
        let serialized = format!("frames:{}", serde_json::to_string(&query)?);
        let offset = self.frame_query_offset(owner, result_id, &serialized, cursor)?;
        let page = query_frames_with_cancel(set, &query, offset, limit, cancel)
            .map_err(WorkbenchError::from)?;
        crate::check_cancelled(cancel)?;
        let evidence=self.record_result_evidence(&capture,result_id,page.items.iter().map(|frame|crate::evidence::EvidenceDraft {range:frame.range,
            channels:frame.configured_channels.clone(),provider_id:format!("sigpilot.decode.saleae.{}",set.protocol),provider_version:"1".into(),
            parameters:json!({"result_set_id":result_id,"query":query,"configuration":set.configuration}),observed:json!(frame)}).collect())?;
        let mut items = Vec::new();
        for (frame, record) in page.items.into_iter().zip(evidence) {
            let mut value = serde_json::to_value(&frame)?;
            value["frame_ref"] = json!({"result_set_id":result_id,"frame_id":frame.frame_id});
            items.push(value);
            items.last_mut().unwrap()["evidence_ref"] = json!(record.evidence_ref);
        }
        self.validate_capture(&capture)?;
        crate::check_cancelled(cancel)?;
        let cursor = self.frame_query_cursor(owner, result_id, serialized, page.next_offset);
        Ok(
            json!({"capture":capture,"result_set_id":result_id,"items":items,"inspected_frames":page.inspected_frames,
            "complete":page.complete,"truncated":!page.complete,"next_cursor":cursor,"processed_range":set.processed_range,
            "requested_range":set.requested_range,"missing_fields":"unknown_does_not_match","filter_scope":"same_frame"}),
        )
    }
}

fn job_error(error: WorkbenchError) -> JobFailure {
    let code = match &error {
        WorkbenchError::CaptureVersionConflict
        | WorkbenchError::Read(sigpilot_graph::read_api::ReadError::VersionConflict) => {
            "VERSION_CONFLICT"
        }
        WorkbenchError::ResourceLimit(_) => "RESOURCE_LIMIT",
        WorkbenchError::SessionNotFound => "SESSION_NOT_FOUND",
        _ => "INVALID_INPUT",
    };
    JobFailure::new(code, error.to_string())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::{jobs::JobState, process::tests::Script};
    fn await_job(service: &WorkbenchService, id: &str) -> JobSnapshot {
        let deadline = Instant::now() + std::time::Duration::from_secs(3);
        loop {
            let job = service.jobs.get("owner", id).unwrap();
            if matches!(
                job.state,
                JobState::Completed | JobState::Failed | JobState::Cancelled
            ) {
                return job;
            }
            assert!(Instant::now() < deadline);
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
    }
    #[test]
    fn supervised_decode_fields_cursor_and_capture_identity_form_one_result_snapshot() {
        let script=Script::new("cat >/dev/null\nprintf '%s' '{\"backend\":\"saleae_native\",\"protocol\":\"Async Serial\",\"diagnostics\":[],\"frames\":[{\"frame_id\":1,\"start_sample\":2,\"end_sample\":4,\"row\":\"data\",\"texts\":[\"0x80\"],\"fields\":[{\"name\":\"data\",\"value\":{\"Unsigned\":128}}],\"channel_values\":[],\"markers\":[]},{\"frame_id\":2,\"start_sample\":6,\"end_sample\":8,\"row\":\"data\",\"texts\":[\"0x90\"],\"fields\":[{\"name\":\"data\",\"value\":{\"Unsigned\":144}}],\"channel_values\":[],\"markers\":[]}]}'");
        let service = Arc::new(crate::tests::service());
        service.set_decode_backend(Some(SaleaeNativeDecoder::new(&script.0, script.root())));
        let capture = service.context("session-a").unwrap().capture;
        let config = DecodeConfig::Uart(UartConfig {
            channel: 0,
            baud_rate: 100000.into(),
            inverted: false,
            data_bits: 8,
            stop_bits: "1".into(),
            parity: UartParity::None,
            msb_first: false,
        });
        let job = service
            .run_decode(
                "owner",
                capture.clone(),
                SampleRange::new(0, 16, 16).unwrap(),
                config,
                "decode",
            )
            .unwrap();
        let done = await_job(&service, &job.job_id);
        assert_eq!(done.state, JobState::Completed, "{:?}", done.error);
        let first = service
            .query_decode_frames("owner", &job.job_id, FrameQuery::default(), None, 1)
            .unwrap();
        assert_eq!(first["items"][0]["range"]["end_sample"], "5");
        assert_eq!(first["items"][0]["fields"]["data"]["value"], "128");
        let cursor = first["next_cursor"].as_str().unwrap();
        let second = service
            .query_decode_frames("owner", &job.job_id, FrameQuery::default(), Some(cursor), 1)
            .unwrap();
        assert_eq!(second["items"][0]["frame_id"], "2");
        assert!(service
            .query_decode_frames(
                "owner",
                &job.job_id,
                FrameQuery {
                    text_contains: Some("changed".into()),
                    ..Default::default()
                },
                Some(cursor),
                1
            )
            .is_err());
        assert!(matches!(
            service.query_decode_frames("stranger", &job.job_id, FrameQuery::default(), None, 1),
            Err(WorkbenchError::JobNotFound)
        ));
        service.trim_capture("session-a", 0, 10).unwrap();
        assert!(matches!(
            service.query_decode_frames("owner", &job.job_id, FrameQuery::default(), None, 1),
            Err(WorkbenchError::CaptureVersionConflict)
        ));
    }
    #[test]
    fn editing_a_running_instance_freezes_the_result_and_original_request_replay() {
        let script=Script::new("cat >/dev/null\nsleep 0.15\nprintf '%s' '{\"backend\":\"saleae_native\",\"protocol\":\"Async Serial\",\"diagnostics\":[],\"frames\":[]}'");
        let service = Arc::new(crate::tests::service());
        service.set_decode_backend(Some(SaleaeNativeDecoder::new(&script.0, script.root())));
        let capture = service.context("session-a").unwrap().capture;
        let config: DecodeConfig = serde_json::from_value(
            json!({"protocol":"UART","settings":{"channel":0,"baud_rate":"100000"}}),
        )
        .unwrap();
        let create = crate::analyzers::ConfigureAnalyzerRequest {
            capture: capture.clone(),
            expected_config_revision: 0.into(),
            request_id: "create".into(),
            preview: false,
            operation: crate::analyzers::AnalyzerOperation::Create {
                id: Some("uart".into()),
                name: "UART".into(),
                config: config.clone(),
            },
        };
        service
            .configure_analyzer(
                crate::Caller {
                    id: "owner",
                    source: crate::AnnotationSource::Assistant,
                },
                &create,
            )
            .unwrap();
        let range = SampleRange::new(0, 16, 16).unwrap();
        let job = service
            .run_analyzer_decode(
                "owner",
                capture.clone(),
                range,
                "uart",
                1.into(),
                "decode-shared",
            )
            .unwrap();
        let deadline = Instant::now() + std::time::Duration::from_secs(2);
        while service.jobs.get("owner", &job.job_id).unwrap().state != JobState::Running {
            assert!(Instant::now() < deadline);
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
        let mut changed = config;
        if let DecodeConfig::Uart(s) = &mut changed {
            s.baud_rate = 9600.into();
        }
        service
            .configure_analyzer(
                crate::Caller {
                    id: "owner",
                    source: crate::AnnotationSource::Assistant,
                },
                &crate::analyzers::ConfigureAnalyzerRequest {
                    capture: capture.clone(),
                    expected_config_revision: 1.into(),
                    request_id: "edit-running".into(),
                    preview: false,
                    operation: crate::analyzers::AnalyzerOperation::Update {
                        id: "uart".into(),
                        name: "Changed".into(),
                        config: changed,
                    },
                },
            )
            .unwrap();
        let done = await_job(&service, &job.job_id);
        assert_eq!(done.state, JobState::Completed);
        let result = done.result.unwrap();
        assert_eq!(
            result["configuration"]["config"]["settings"]["baud_rate"],
            "100000"
        );
        assert_eq!(result["configuration"]["analyzer"]["config_revision"], "1");
        assert_eq!(
            service
                .run_analyzer_decode(
                    "owner",
                    capture.clone(),
                    range,
                    "uart",
                    1.into(),
                    "decode-shared"
                )
                .unwrap()
                .job_id,
            job.job_id
        );
        assert!(matches!(
            service.run_analyzer_decode(
                "owner",
                capture.clone(),
                range,
                "uart",
                1.into(),
                "new-stale"
            ),
            Err(WorkbenchError::ConfigVersionConflict(2))
        ));
        assert!(matches!(
            service.run_analyzer_decode(
                "stranger",
                capture,
                range,
                "uart",
                1.into(),
                "decode-shared"
            ),
            Err(WorkbenchError::ConfigVersionConflict(2))
        ));
    }
}
