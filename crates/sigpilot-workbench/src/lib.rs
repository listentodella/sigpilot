//! Shared semantic state and bounded operations for GUI and MCP callers.

pub mod analysis;
pub mod analyzers;
pub mod correlation;
pub mod decode;
pub mod derived;
pub mod evidence;
pub mod hardware_trigger;
pub mod jobs;
pub mod models;
mod process;
pub mod protocol;
mod report_export;
pub mod reports;
pub mod results;
pub mod trigger;
pub mod undo;

use std::{
    collections::{BTreeMap, HashMap, VecDeque},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc::{self, Receiver, SyncSender, TrySendError},
        Arc,
    },
    time::{SystemTime, UNIX_EPOCH},
};

use parking_lot::{Mutex, RwLock};
use sigpilot_analysis::{ExactU64, SampleRange};
use sigpilot_graph::{
    read_api::{FrozenCaptureLease, ReadError},
    GraphCaptureSnapshot, GraphSession,
};

pub use models::*;

const MAX_SESSIONS: usize = 32;
const MAX_ANNOTATIONS: usize = 4_096;
const MAX_DOCUMENT_BYTES: usize = 2 * 1024 * 1024;
const MAX_MUTATION_BYTES: usize = 240 * 1024;
const MAX_BATCH: usize = 200;
const MAX_REPLAY_BYTES: usize = 1024 * 1024;
const MAX_SAFE_UI_SAMPLE: u64 = (1 << 53) - 1;

#[derive(Debug, thiserror::Error)]
pub enum WorkbenchError {
    #[error("invalid request: {0}")]
    InvalidRequest(String),
    #[error("request was cancelled")]
    Cancelled,
    #[error("analyzer instance not found")]
    AnalyzerNotFound,
    #[error("retained result does not exist")]
    ResultNotFound,
    #[error("retained result revision changed; latest revision is {0}")]
    ResultVersionConflict(u64),
    #[error("analyzer configuration revision changed; latest revision is {0}")]
    ConfigVersionConflict(u64),
    #[error("session does not exist")]
    SessionNotFound,
    #[error("job or retained result does not exist for this caller")]
    JobNotFound,
    #[error("decoder is not configured or supported: {0}")]
    DecoderUnavailable(String),
    #[error("evidence reference is unknown, expired or belongs to another capture")]
    EvidenceNotFound,
    #[error("undo batch is unavailable, expired or belongs to another caller")]
    UndoNotFound,
    #[error("analysis provider is not registered")]
    ProviderNotFound,
    #[error("hardware trigger profile not found")]
    TriggerProfileNotFound,
    #[error("report does not exist for this capture")]
    ReportNotFound,
    #[error("report revision changed; latest revision is {0}")]
    ReportVersionConflict(u64),
    #[error("capture changed; reacquire its reference")]
    CaptureVersionConflict,
    #[error("annotation revision changed; latest revision is {0}")]
    AnnotationVersionConflict(u64),
    #[error("request ID was already used for different input")]
    RequestIdConflict,
    #[error("annotation does not exist: {0}")]
    AnnotationNotFound(String),
    #[error("resource limit reached: {0}")]
    ResourceLimit(&'static str),
    #[error("GUI cannot represent this coordinate exactly")]
    UiPrecisionLimit,
    #[error("session is not attached to a GUI")]
    GuiUnavailable,
    #[error(transparent)]
    Read(#[from] ReadError),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

pub type Result<T> = std::result::Result<T, WorkbenchError>;

impl From<sigpilot_analysis::AnalysisError> for WorkbenchError {
    fn from(error: sigpilot_analysis::AnalysisError) -> Self {
        match error {
            sigpilot_analysis::AnalysisError::Cancelled => Self::Cancelled,
            other => Self::InvalidRequest(other.to_string()),
        }
    }
}

/// Request-local cancellation for synchronous reads. Domain jobs own separate
/// flags; a disconnected request must never cancel an already submitted job.
fn check_cancelled(cancel: &std::sync::atomic::AtomicBool) -> Result<()> {
    if cancel.load(Ordering::Acquire) {
        Err(WorkbenchError::Cancelled)
    } else {
        Ok(())
    }
}

struct Replay {
    owner: String,
    request_id: String,
    input: String,
    result: ApplyAnnotationsResult,
    bytes: usize,
}

struct StoredAnnotation {
    annotation: WorkbenchAnnotation,
    encoded_bytes: usize,
}

impl StoredAnnotation {
    fn new(annotation: WorkbenchAnnotation) -> Result<Arc<Self>> {
        let encoded_bytes = serde_json::to_vec(&annotation)?.len();
        Ok(Arc::new(Self {
            annotation,
            encoded_bytes,
        }))
    }
}

#[derive(Default)]
struct Document {
    generation: u64,
    revision: u64,
    gui_attached: bool,
    annotations: BTreeMap<String, Arc<StoredAnnotation>>,
    replay: VecDeque<Replay>,
    replay_bytes: usize,
    undo: VecDeque<undo::UndoRecord>,
    report_revision: u64,
    reports: BTreeMap<String, Arc<reports::StoredReport>>,
    opaque_reports: Vec<serde_json::Value>,
    report_replay: VecDeque<reports::Replay>,
    config_revision: u64,
    analyzers_initialized: bool,
    analyzers: Vec<analyzers::AnalyzerInstance>,
    analyzer_replay: VecDeque<analyzers::Replay>,
    result_revision: u64,
    results: BTreeMap<String, Arc<results::StoredResult>>,
    opaque_results: Vec<serde_json::Value>,
    result_replay: VecDeque<results::Replay>,
    derivation: Option<serde_json::Value>,
    derived_replay: Option<(String, String, String)>,
}

pub struct WorkbenchSession {
    pub graph: Arc<GraphSession>,
    document: Mutex<Document>,
    import_bytes: u64,
    operation: Mutex<()>,
}

impl Default for WorkbenchSession {
    fn default() -> Self {
        Self {
            graph: Arc::new(GraphSession::default()),
            document: Mutex::new(Document::default()),
            import_bytes: 0,
            operation: Mutex::new(()),
        }
    }
}

pub struct WorkbenchService {
    sessions: RwLock<HashMap<String, Arc<WorkbenchSession>>>,
    subscribers: Mutex<Vec<SyncSender<Arc<WorkbenchEvent>>>>,
    runtime_id: String,
    next_annotation: AtomicU64,
    pub jobs: Arc<jobs::JobManager>,
    decoder: RwLock<Option<Arc<sigpilot_core::SaleaeNativeDecoder>>>,
    frame_cursors: Mutex<decode::FrameCursors>,
    evidence: evidence::EvidenceRegistry,
    providers: RwLock<sigpilot_analysis::providers::ProviderRegistry>,
    hardware_triggers: RwLock<sigpilot_analysis::hardware_trigger::HardwareTriggerRegistry>,
    derived_creation: Mutex<()>,
}

impl Default for WorkbenchService {
    fn default() -> Self {
        let time = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        Self {
            sessions: RwLock::new(HashMap::new()),
            subscribers: Mutex::new(Vec::new()),
            runtime_id: format!("{:x}-{time:x}", std::process::id()),
            next_annotation: AtomicU64::new(1),
            jobs: Arc::new(jobs::JobManager::default()),
            decoder: RwLock::new(
                sigpilot_core::SaleaeNativeDecoder::from_env_cached()
                    .ok()
                    .map(Arc::new),
            ),
            frame_cursors: Mutex::new(VecDeque::new()),
            evidence: Default::default(),
            providers: RwLock::new(Default::default()),
            hardware_triggers: RwLock::new(Default::default()),
            derived_creation: Mutex::new(()),
        }
    }
}

impl WorkbenchService {
    pub fn session(&self, id: &str) -> Result<Arc<WorkbenchSession>> {
        validate_id(id)?;
        if let Some(session) = self.sessions.read().get(id) {
            return Ok(session.clone());
        }
        let mut sessions = self.sessions.write();
        if let Some(session) = sessions.get(id) {
            return Ok(session.clone());
        }
        if sessions.len() >= MAX_SESSIONS {
            return Err(WorkbenchError::ResourceLimit("session count"));
        }
        let session = Arc::new(WorkbenchSession::default());
        sessions.insert(id.into(), session.clone());
        Ok(session)
    }

    pub fn existing_session(&self, id: &str) -> Result<Arc<WorkbenchSession>> {
        self.sessions
            .read()
            .get(id)
            .cloned()
            .ok_or(WorkbenchError::SessionNotFound)
    }

    pub fn release_session(&self, id: &str) {
        self.jobs.cancel_session(id);
        if self.sessions.write().remove(id).is_some() {
            self.publish(WorkbenchEvent::SessionReleased {
                session_id: id.into(),
            });
        }
    }

    /// MCP imports always create a separate session. Account for worst-case
    /// dense edge expansion before constructing the index, and never overwrite
    /// a GUI session chosen by a caller.
    pub fn import_capture(
        &self,
        id: &str,
        capture: sigpilot_file::PxlogicProjectCapture,
    ) -> Result<CaptureContext> {
        validate_id(id)?;
        let bytes = match &capture {
            sigpilot_file::PxlogicProjectCapture::Packed(capture) => {
                let channels = if capture.metadata.enabled_channels.is_empty() {
                    capture.metadata.channel_count as u64
                } else {
                    capture.metadata.enabled_channels.len() as u64
                };
                // DigitalGraph currently indexes every physical channel, so
                // use channel_count even when only some channels were enabled.
                capture
                    .metadata
                    .sample_count
                    .checked_mul(channels.max(capture.metadata.channel_count as u64))
                    .and_then(|n| n.checked_mul(8))
                    .and_then(|n| n.checked_add(capture.samples.len() as u64))
                    .ok_or(WorkbenchError::ResourceLimit("capture index estimate"))?
            }
            sigpilot_file::PxlogicProjectCapture::Sparse(capture) => capture
                .channels
                .iter()
                .map(|c| c.transitions.len() as u64 * 16)
                .sum(),
        };
        if bytes > 64 * 1024 * 1024 {
            return Err(WorkbenchError::ResourceLimit(
                "capture/index exceeds 64 MiB import budget",
            ));
        }
        {
            let mut sessions = self.sessions.write();
            if sessions.contains_key(id) {
                return Err(WorkbenchError::InvalidRequest(
                    "import session already exists".into(),
                ));
            }
            if sessions.len() >= MAX_SESSIONS
                || sessions.values().map(|s| s.import_bytes).sum::<u64>() + bytes
                    > 256 * 1024 * 1024
            {
                return Err(WorkbenchError::ResourceLimit("total imported captures"));
            }
            let session = Arc::new(WorkbenchSession {
                import_bytes: bytes,
                ..Default::default()
            });
            // Reserve the identity/budget while reading the index. No global
            // map lock is held during raw-sample processing.
            sessions.insert(id.into(), session);
        }
        let session = self.existing_session(id)?;
        let result = match capture {
            sigpilot_file::PxlogicProjectCapture::Packed(capture) => {
                session.graph.replace_capture(capture)
            }
            sigpilot_file::PxlogicProjectCapture::Sparse(capture) => {
                session.graph.replace_sparse_capture(capture)
            }
        };
        if let Err(error) = result {
            self.release_session(id);
            return Err(WorkbenchError::Read(ReadError::Graph(error)));
        }
        self.context(id)
    }

    pub fn session_ids(&self) -> Vec<String> {
        let mut ids = self.sessions.read().keys().cloned().collect::<Vec<_>>();
        ids.sort();
        ids
    }

    pub fn set_gui_attached(&self, id: &str, attached: bool) -> Result<()> {
        self.existing_session(id)?.document.lock().gui_attached = attached;
        Ok(())
    }

    /// Import project metadata only into a fresh capture document. Legacy
    /// channel annotations are upgraded without inventing assistant provenance.
    pub fn restore_annotations(
        &self,
        id: &str,
        metadata: &sigpilot_file::SaleaeSessionMetadata,
    ) -> Result<()> {
        let session = self.existing_session(id)?;
        let context = self.context(id)?;
        let lease = self.lease(&session, &context.capture)?;
        let mut document = session.document.lock();
        synchronize(&mut document, lease.snapshot().capture_generation);
        if document.revision != 0
            || !document.annotations.is_empty()
            || document.report_revision != 0
            || !document.reports.is_empty()
            || !document.opaque_reports.is_empty()
            || document.config_revision != 0
            || !document.analyzers.is_empty()
            || document.result_revision != 0
            || !document.results.is_empty()
            || !document.opaque_results.is_empty()
            || document.derivation.is_some()
        {
            return Err(WorkbenchError::AnnotationVersionConflict(document.revision));
        }
        let items = if metadata.workbench_annotations.is_empty() {
            metadata
                .user_annotations
                .iter()
                .map(|a| WorkbenchAnnotation {
                    id: a.id.clone(),
                    source: AnnotationSource::User,
                    author_id: "project-import".into(),
                    evidence: vec![],
                    archived_evidence: vec![],
                    value: AnnotationInput {
                        kind: AnnotationKind::ChannelAnnotation,
                        sample: a.sample.into(),
                        end_sample: None,
                        channel: Some(a.channel),
                        title: a.title.clone(),
                        note: a.note.clone(),
                        tags: vec![],
                        evidence_refs: vec![],
                        shape: Some(a.shape),
                        color: a.color.clone(),
                    },
                })
                .collect::<Vec<_>>()
        } else {
            metadata
                .workbench_annotations
                .iter()
                .map(|value| serde_json::from_value(value.clone()))
                .collect::<std::result::Result<Vec<WorkbenchAnnotation>, _>>()?
        };
        if items.len() > MAX_ANNOTATIONS {
            return Err(WorkbenchError::ResourceLimit("project annotations"));
        }
        let mut annotations = BTreeMap::new();
        for mut item in items {
            validate_id(&item.id)?;
            validate_id(&item.author_id)?;
            validate_annotation(&item.value, lease.snapshot(), document.gui_attached)?;
            self.restore_evidence(&mut item, &context.capture, lease.snapshot())?;
            if annotations
                .insert(item.id.clone(), StoredAnnotation::new(item)?)
                .is_some()
            {
                return Err(WorkbenchError::InvalidRequest(
                    "duplicate project annotation ID".into(),
                ));
            }
        }
        if document_bytes(&annotations) > MAX_DOCUMENT_BYTES {
            return Err(WorkbenchError::ResourceLimit("project annotation bytes"));
        }
        let (restored_reports, opaque_reports) = reports::restore(
            &metadata.workbench_reports,
            &context.capture,
            lease.snapshot(),
        )?;
        let restored_analyzers = analyzers::restore(metadata)?;
        let (restored_results, opaque_results) = results::restore(
            &metadata.workbench_results,
            &context.capture,
            lease.snapshot(),
        )?;
        let derivation =
            derived::restore(metadata.workbench_derivation.as_ref(), lease.snapshot())?;
        document.derivation = derivation;
        document.annotations = annotations;
        document.reports = restored_reports;
        document.opaque_reports = opaque_reports;
        document.analyzers = restored_analyzers;
        document.analyzers_initialized = true;
        document.results = restored_results;
        document.opaque_results = opaque_results;
        Ok(())
    }

    /// A bounded complete document snapshot for the local GUI and file writer.
    pub fn annotation_snapshot(&self, reference: &CaptureRef) -> Result<Vec<WorkbenchAnnotation>> {
        let session = self.existing_session(&reference.session_id)?;
        let lease = self.lease(&session, reference)?;
        let mut document = session.document.lock();
        synchronize(&mut document, lease.snapshot().capture_generation);
        Ok(document
            .annotations
            .values()
            .map(|a| a.annotation.clone())
            .collect())
    }

    pub fn gui_snapshot(&self, id: &str) -> Result<WorkbenchSnapshot> {
        let session = self.existing_session(id)?;
        let snapshot = session.graph.capture_snapshot()?;
        let lease = session
            .graph
            .capture_state_lease(snapshot.capture_generation, snapshot.data_revision)?;
        let snapshot = lease.snapshot();
        let mut document = session.document.lock();
        synchronize(&mut document, snapshot.capture_generation);
        Ok(WorkbenchSnapshot {
            undo_batch_id: undo::available(&document, "desktop-user"),
            context: CaptureContext {
                capture: self.reference(id, snapshot),
                finalized: snapshot.finalized,
                sample_rate_hz: snapshot.metadata.sample_rate_hz.into(),
                sample_count: snapshot.metadata.sample_count.into(),
                channel_count: snapshot.metadata.channel_count,
                enabled_channels: snapshot.metadata.enabled_channels.clone(),
                annotation_revision: document.revision.into(),
                annotation_count: (document.annotations.len() as u64).into(),
                report_revision: document.report_revision.into(),
                report_count: (document.reports.len() as u64).into(),
                config_revision: document.config_revision.into(),
                analyzer_count: (document.analyzers.len() as u64).into(),
                analyzers_initialized: document.analyzers_initialized,
                result_revision: document.result_revision.into(),
                retained_result_count: (document.results.len() as u64).into(),
                derivation: document.derivation.clone(),
                gui_attached: document.gui_attached,
            },
            annotations: document
                .annotations
                .values()
                .map(|a| a.annotation.clone())
                .collect(),
            analyzers: document.analyzers.clone(),
        })
    }

    pub fn trim_capture(
        &self,
        id: &str,
        start: u64,
        end: u64,
    ) -> Result<(sigpilot_core::CaptureMetadata, usize)> {
        let session = self.existing_session(id)?;
        let _operation = session.operation.lock();
        let snapshot = self.gui_snapshot(id)?;
        let (archived_reports, archived_results) = {
            let lease = self.lease(&session, &snapshot.context.capture)?;
            let document = session.document.lock();
            let values = (
                reports::project_values(&document, true)?,
                results::project_values(&document, true)?,
            );
            drop(lease);
            values
        };
        let mut retained = snapshot
            .annotations
            .into_iter()
            .filter(|a| {
                a.value.sample.0 >= start
                    && a.value.sample.0 < end
                    && a.value.end_sample.is_none_or(|e| e.0 <= end)
            })
            .collect::<Vec<_>>();
        for annotation in &mut retained {
            annotation.value.sample.0 -= start;
            if let Some(end) = &mut annotation.value.end_sample {
                end.0 -= start;
            }
            annotation.value.evidence_refs.clear();
            for mut evidence in annotation.evidence.drain(..) {
                evidence.verification = evidence::EvidenceVerification::ArchivedOriginalCapture;
                annotation.archived_evidence.push(evidence);
            }
            if annotation.archived_evidence.len() > 16 {
                annotation
                    .archived_evidence
                    .drain(..annotation.archived_evidence.len() - 16);
            }
        }
        let mut metadata = sigpilot_file::SaleaeSessionMetadata {
            workbench_reports: archived_reports,
            workbench_results: archived_results,
            workbench_derivation: derived::cropped(snapshot.context.derivation.as_ref(), start)?,
            workbench_annotations: retained
                .into_iter()
                .map(serde_json::to_value)
                .collect::<std::result::Result<_, _>>()?,
            ..Default::default()
        };
        analyzers::populate(&mut metadata, &snapshot.analyzers)?;
        if metadata
            .workbench_annotations
            .iter()
            .map(|v| serde_json::to_vec(v).map(|bytes| bytes.len()))
            .collect::<std::result::Result<Vec<_>, _>>()?
            .iter()
            .sum::<usize>()
            > MAX_DOCUMENT_BYTES
        {
            return Err(WorkbenchError::ResourceLimit(
                "cropped annotation/evidence document",
            ));
        }
        let result = session
            .graph
            .trim_capture(start, end)
            .map_err(ReadError::Graph)?;
        self.jobs.cancel_session(id);
        self.restore_annotations(id, &metadata)?;
        Ok(result)
    }

    pub fn project_metadata(
        &self,
        reference: &CaptureRef,
        mut metadata: sigpilot_file::SaleaeSessionMetadata,
    ) -> Result<sigpilot_file::SaleaeSessionMetadata> {
        let session = self.existing_session(&reference.session_id)?;
        let lease = self.lease(&session, reference)?;
        let mut document = session.document.lock();
        synchronize(&mut document, lease.snapshot().capture_generation);
        let annotations = document
            .annotations
            .values()
            .map(|a| a.annotation.clone())
            .collect();
        metadata.workbench_reports = reports::project_values(&document, false)?;
        metadata.workbench_results = results::project_values(&document, false)?;
        metadata.workbench_derivation = document.derivation.clone();
        let analyzers = analyzers::project_instances(&document, &metadata)?;
        analyzers::populate(&mut metadata, &analyzers)?;
        populate_project_metadata(&mut metadata, annotations)?;
        Ok(metadata)
    }

    /// Capture bytes and annotations must belong to the same snapshot even
    /// when a crop or a new capture races with the GUI's save command.
    pub fn save_project(
        &self,
        id: &str,
        path: &std::path::Path,
        mut metadata: sigpilot_file::SaleaeSessionMetadata,
    ) -> std::result::Result<(), String> {
        let session = self.existing_session(id).map_err(|e| e.to_string())?;
        let snapshot = session
            .graph
            .capture_snapshot()
            .map_err(|e| e.to_string())?;
        let lease = session
            .graph
            .frozen_capture_lease(snapshot.capture_generation, snapshot.data_revision)
            .map_err(|e| e.to_string())?;
        let (annotations, reports, analyzers, results, derivation) = {
            let mut document = session.document.lock();
            synchronize(&mut document, lease.snapshot().capture_generation);
            let annotations = document
                .annotations
                .values()
                .map(|a| a.annotation.clone())
                .collect();
            (
                annotations,
                reports::project_values(&document, false).map_err(|e| e.to_string())?,
                analyzers::project_instances(&document, &metadata).map_err(|e| e.to_string())?,
                results::project_values(&document, false).map_err(|e| e.to_string())?,
                document.derivation.clone(),
            )
        };
        let packed = session.graph.capture();
        let sparse = session.graph.sparse_capture();
        populate_project_metadata(&mut metadata, annotations).map_err(|e| e.to_string())?;
        metadata.workbench_reports = reports;
        metadata.workbench_results = results;
        metadata.workbench_derivation = derivation;
        analyzers::populate(&mut metadata, &analyzers).map_err(|e| e.to_string())?;
        drop(lease);
        if let Some(capture) = packed {
            return sigpilot_file::save_pxl_packed(path, &capture, &metadata)
                .map_err(|e| e.to_string());
        }
        if let Some(capture) = sparse {
            return sigpilot_file::save_pxl_sparse(path, &capture, &metadata)
                .map_err(|e| e.to_string());
        }
        Err("no capture is loaded".into())
    }

    pub fn edge_window(
        &self,
        reference: &CaptureRef,
        channel: u8,
        range: SampleRange,
    ) -> Result<sigpilot_graph::DigitalWindowSnapshot> {
        let session = self.existing_session(&reference.session_id)?;
        let snapshot = session.graph.capture_snapshot()?;
        if self.reference(&reference.session_id, &snapshot) != *reference {
            return Err(WorkbenchError::CaptureVersionConflict);
        }
        Ok(session.graph.digital_edge_window(
            snapshot.capture_generation,
            snapshot.data_revision,
            channel,
            range.start_sample.0,
            range.end_sample.0,
            sigpilot_graph::MAX_DIGITAL_WINDOW_EDGES,
        )?)
    }

    pub fn point_window(
        &self,
        reference: &CaptureRef,
        channel: u8,
        sample: u64,
    ) -> Result<sigpilot_graph::DigitalWindowSnapshot> {
        let session = self.existing_session(&reference.session_id)?;
        let snapshot = session.graph.capture_snapshot()?;
        if self.reference(&reference.session_id, &snapshot) != *reference {
            return Err(WorkbenchError::CaptureVersionConflict);
        }
        Ok(session.graph.digital_edge_window(
            snapshot.capture_generation,
            snapshot.data_revision,
            channel,
            sample,
            snapshot.metadata.sample_count,
            3,
        )?)
    }

    pub fn context(&self, id: &str) -> Result<CaptureContext> {
        let session = self.existing_session(id)?;
        let snapshot = session.graph.capture_snapshot()?;
        let lease = session
            .graph
            .capture_state_lease(snapshot.capture_generation, snapshot.data_revision)?;
        let snapshot = lease.snapshot();
        let mut document = session.document.lock();
        synchronize(&mut document, snapshot.capture_generation);
        Ok(CaptureContext {
            capture: self.reference(id, &snapshot),
            finalized: snapshot.finalized,
            sample_rate_hz: snapshot.metadata.sample_rate_hz.into(),
            sample_count: snapshot.metadata.sample_count.into(),
            channel_count: snapshot.metadata.channel_count,
            enabled_channels: snapshot.metadata.enabled_channels.clone(),
            annotation_revision: document.revision.into(),
            annotation_count: (document.annotations.len() as u64).into(),
            report_revision: document.report_revision.into(),
            report_count: (document.reports.len() as u64).into(),
            config_revision: document.config_revision.into(),
            analyzer_count: (document.analyzers.len() as u64).into(),
            analyzers_initialized: document.analyzers_initialized,
            result_revision: document.result_revision.into(),
            retained_result_count: (document.results.len() as u64).into(),
            derivation: document.derivation.clone(),
            gui_attached: document.gui_attached,
        })
    }

    pub fn apply_annotations(
        &self,
        caller: Caller<'_>,
        request: &ApplyAnnotationsRequest,
    ) -> Result<ApplyAnnotationsResult> {
        validate_id(caller.id)?;
        validate_id(&request.request_id)?;
        if request.operations.is_empty() || request.operations.len() > MAX_BATCH {
            return Err(WorkbenchError::InvalidRequest(
                "batch must contain 1..200 operations".into(),
            ));
        }
        let input = serde_json::to_string(request)?;
        if input.len() > MAX_MUTATION_BYTES {
            return Err(WorkbenchError::ResourceLimit("mutation payload"));
        }
        let session = self.existing_session(&request.capture.session_id)?;
        let _operation = session.operation.lock();
        let lease = self.lease(&session, &request.capture)?;
        let snapshot = lease.snapshot();
        let mut document = session.document.lock();
        synchronize(&mut document, snapshot.capture_generation);
        if !request.preview {
            if let Some(replay) = document
                .replay
                .iter()
                .find(|r| r.owner == caller.id && r.request_id == request.request_id)
            {
                if replay.input != input {
                    return Err(WorkbenchError::RequestIdConflict);
                }
                return Ok(replay.result.clone());
            }
        }
        if document.revision != request.expected_annotation_revision.0 {
            return Err(WorkbenchError::AnnotationVersionConflict(document.revision));
        }
        // Clone only the map and Arc pointers, not every annotation's text.
        let mut next = document.annotations.clone();
        let mut upserts = BTreeMap::new();
        let mut deleted = BTreeMap::new();
        for (position, operation) in request.operations.iter().enumerate() {
            match operation {
                AnnotationOperation::Create {
                    id: requested_id,
                    annotation,
                } => {
                    validate_annotation(annotation, snapshot, document.gui_attached)?;
                    let evidence =
                        self.annotation_evidence(&request.capture, annotation, &document)?;
                    let id = if let Some(id) = requested_id {
                        validate_id(id)?;
                        if next.contains_key(id) {
                            return Err(WorkbenchError::InvalidRequest(
                                "annotation ID already exists".into(),
                            ));
                        }
                        id.clone()
                    } else if request.preview {
                        format!("preview-{position}")
                    } else {
                        format!(
                            "annotation-{}-{}",
                            self.runtime_id,
                            self.next_annotation.fetch_add(1, Ordering::Relaxed)
                        )
                    };
                    let item = StoredAnnotation::new(WorkbenchAnnotation {
                        id: id.clone(),
                        source: caller.source,
                        author_id: caller.id.into(),
                        value: annotation.clone(),
                        evidence,
                        archived_evidence: vec![],
                    })?;
                    next.insert(id.clone(), item.clone());
                    upserts.insert(id, item);
                }
                AnnotationOperation::Update { id, annotation } => {
                    validate_annotation(annotation, snapshot, document.gui_attached)?;
                    let evidence =
                        self.annotation_evidence(&request.capture, annotation, &document)?;
                    let old = next
                        .get(id)
                        .ok_or_else(|| WorkbenchError::AnnotationNotFound(id.clone()))?;
                    let mut archived_evidence = old.annotation.archived_evidence.clone();
                    for mut record in old
                        .annotation
                        .evidence
                        .iter()
                        .filter(|e| !annotation.evidence_refs.contains(&e.evidence_ref))
                        .cloned()
                    {
                        record.verification =
                            evidence::EvidenceVerification::ArchivedOriginalCapture;
                        archived_evidence.push(record);
                    }
                    if archived_evidence.len() > 16 {
                        archived_evidence.drain(..archived_evidence.len() - 16);
                    }
                    // Editing an existing annotation preserves its provenance.
                    let item = StoredAnnotation::new(WorkbenchAnnotation {
                        id: id.clone(),
                        source: old.annotation.source,
                        author_id: old.annotation.author_id.clone(),
                        value: annotation.clone(),
                        evidence,
                        archived_evidence,
                    })?;
                    next.insert(id.clone(), item.clone());
                    upserts.insert(id.clone(), item);
                    deleted.remove(id);
                }
                AnnotationOperation::Delete { id } => {
                    if next.remove(id).is_none() {
                        return Err(WorkbenchError::AnnotationNotFound(id.clone()));
                    }
                    upserts.remove(id);
                    deleted.insert(id.clone(), ());
                }
            }
            // Evidence snapshots can exceed the small incoming mutation. Bound
            // the staged document after each operation, before the next copy.
            if document_bytes(&next) > MAX_DOCUMENT_BYTES {
                return Err(WorkbenchError::ResourceLimit(
                    "annotation document including evidence",
                ));
            }
        }
        if next.len() > MAX_ANNOTATIONS || document_bytes(&next) > MAX_DOCUMENT_BYTES {
            return Err(WorkbenchError::ResourceLimit("annotation document"));
        }
        let revision = if request.preview {
            document.revision
        } else {
            document
                .revision
                .checked_add(1)
                .ok_or(WorkbenchError::ResourceLimit("revision counter"))?
        };
        let result = ApplyAnnotationsResult {
            capture: request.capture.clone(),
            annotation_revision: revision.into(),
            request_id: request.request_id.clone(),
            actor_id: caller.id.into(),
            preview: request.preview,
            batch_id: (!request.preview)
                .then(|| format!("batch-{}", uuid::Uuid::new_v4().simple())),
            upserts: upserts
                .into_values()
                .map(|item| item.annotation.clone())
                .collect(),
            deleted_ids: deleted.into_keys().collect(),
        };
        let result_bytes = serde_json::to_vec(&result)?.len();
        if result_bytes > 256 * 1024 {
            return Err(WorkbenchError::ResourceLimit("mutation response"));
        }
        if request.preview {
            return Ok(result);
        }
        let undo_record = undo::record(&mut document, caller.id, &result)?;
        undo::retain(&mut document, undo_record);
        document.annotations = next;
        document.revision = revision;
        let bytes = input.len() + result_bytes;
        while document.replay_bytes + bytes > MAX_REPLAY_BYTES {
            if let Some(old) = document.replay.pop_front() {
                document.replay_bytes -= old.bytes;
            } else {
                break;
            }
        }
        document.replay_bytes += bytes;
        document.replay.push_back(Replay {
            owner: caller.id.into(),
            request_id: request.request_id.clone(),
            input,
            result: result.clone(),
            bytes,
        });
        // Publish while the commit lock is held so revisions remain ordered.
        self.publish(WorkbenchEvent::AnnotationsChanged {
            result: result.clone(),
        });
        Ok(result)
    }

    pub fn list_annotations(
        &self,
        reference: &CaptureRef,
        expected_revision: u64,
        after_id: Option<&str>,
        limit: usize,
    ) -> Result<AnnotationPage> {
        if limit == 0 || limit > 1_000 {
            return Err(WorkbenchError::InvalidRequest(
                "page limit must be 1..1000".into(),
            ));
        }
        let session = self.existing_session(&reference.session_id)?;
        let lease = self.lease(&session, reference)?;
        let mut document = session.document.lock();
        synchronize(&mut document, lease.snapshot().capture_generation);
        if document.revision != expected_revision {
            return Err(WorkbenchError::AnnotationVersionConflict(document.revision));
        }
        let mut annotations = Vec::new();
        let mut bytes = 0;
        let mut more = false;
        for (id, item) in &document.annotations {
            if after_id.is_some_and(|after| id.as_str() <= after) {
                continue;
            }
            let size = item.encoded_bytes;
            if annotations.len() == limit || bytes + size > 240 * 1024 {
                more = true;
                break;
            }
            bytes += size;
            annotations.push(item.annotation.clone());
        }
        let next_after_id = if more {
            annotations.last().map(|a| a.id.clone())
        } else {
            None
        };
        Ok(AnnotationPage {
            capture: reference.clone(),
            annotation_revision: document.revision.into(),
            annotations,
            next_after_id,
        })
    }

    pub fn focus_view(
        &self,
        reference: &CaptureRef,
        range: SampleRange,
        channels: Vec<u8>,
    ) -> Result<sigpilot_graph::SessionView> {
        let session = self.existing_session(&reference.session_id)?;
        let lease = self.lease(&session, reference)?;
        let snapshot = lease.snapshot();
        range
            .validate(snapshot.metadata.sample_count)
            .map_err(|e| WorkbenchError::InvalidRequest(e.to_string()))?;
        if range.end_sample.0 > MAX_SAFE_UI_SAMPLE {
            return Err(WorkbenchError::UiPrecisionLimit);
        }
        if !session.document.lock().gui_attached {
            return Err(WorkbenchError::GuiUnavailable);
        }
        if channels.len() > 32 || channels.iter().any(|c| !valid_channel(snapshot, *c)) {
            return Err(WorkbenchError::InvalidRequest(
                "invalid focus channels".into(),
            ));
        }
        let view = session.graph.set_session_view(
            range.start_sample.0 as f64,
            (range.end_sample.0 - range.start_sample.0) as f64,
        );
        self.publish(WorkbenchEvent::FocusRequested {
            capture: reference.clone(),
            range,
            channels,
            view: view.clone(),
        });
        Ok(view)
    }

    pub fn subscribe(&self) -> Result<Receiver<Arc<WorkbenchEvent>>> {
        let mut subscribers = self.subscribers.lock();
        if subscribers.len() >= 16 {
            return Err(WorkbenchError::ResourceLimit("event subscribers"));
        }
        let (tx, rx) = mpsc::sync_channel(16);
        subscribers.push(tx);
        Ok(rx)
    }

    fn publish(&self, event: WorkbenchEvent) {
        let event = Arc::new(event);
        self.subscribers
            .lock()
            .retain(|sender| match sender.try_send(event.clone()) {
                Ok(()) => true,
                // Disconnect slow subscribers; a reconnect must obtain a snapshot.
                Err(TrySendError::Full(_)) | Err(TrySendError::Disconnected(_)) => false,
            });
    }

    fn reference(&self, id: &str, snapshot: &GraphCaptureSnapshot) -> CaptureRef {
        CaptureRef {
            session_id: id.into(),
            capture_id: format!(
                "capture-{}-{}-{}",
                self.runtime_id, snapshot.instance_id, snapshot.capture_generation
            ),
            data_revision: ExactU64(snapshot.data_revision),
        }
    }

    fn lease<'a>(
        &self,
        session: &'a WorkbenchSession,
        reference: &CaptureRef,
    ) -> Result<FrozenCaptureLease<'a>> {
        let snapshot = session.graph.capture_snapshot()?;
        if self.reference(&reference.session_id, &snapshot) != *reference {
            return Err(WorkbenchError::CaptureVersionConflict);
        }
        Ok(session
            .graph
            .frozen_capture_lease(snapshot.capture_generation, snapshot.data_revision)?)
    }
}

fn populate_project_metadata(
    metadata: &mut sigpilot_file::SaleaeSessionMetadata,
    annotations: Vec<WorkbenchAnnotation>,
) -> Result<()> {
    metadata.user_annotations = annotations
        .iter()
        .filter_map(|a| {
            if a.value.kind != AnnotationKind::ChannelAnnotation {
                return None;
            }
            Some(sigpilot_file::WaveformAnnotation {
                id: a.id.clone(),
                sample: a.value.sample.0,
                channel: a.value.channel?,
                shape: a
                    .value
                    .shape
                    .unwrap_or(sigpilot_file::WaveformAnnotationShape::Flag),
                color: a.value.color.clone(),
                title: a.value.title.clone(),
                note: a.value.note.clone(),
            })
        })
        .collect();
    metadata.workbench_annotations = annotations
        .into_iter()
        .map(serde_json::to_value)
        .collect::<std::result::Result<_, _>>()?;
    Ok(())
}

fn synchronize(document: &mut Document, generation: u64) {
    if document.generation != generation {
        document.generation = generation;
        document.revision = 0;
        document.annotations.clear();
        document.replay.clear();
        document.replay_bytes = 0;
        document.undo.clear();
        document.report_revision = 0;
        document.reports.clear();
        document.opaque_reports.clear();
        document.report_replay.clear();
        document.config_revision = 0;
        document.analyzers_initialized = false;
        document.analyzers.clear();
        document.analyzer_replay.clear();
        document.result_revision = 0;
        document.results.clear();
        document.opaque_results.clear();
        document.result_replay.clear();
        document.derivation = None;
        document.derived_replay = None;
    }
}

fn document_bytes(annotations: &BTreeMap<String, Arc<StoredAnnotation>>) -> usize {
    annotations.values().map(|item| item.encoded_bytes).sum()
}

fn validate_id(id: &str) -> Result<()> {
    if id.is_empty()
        || id.len() > 128
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.:".contains(&b))
    {
        return Err(WorkbenchError::InvalidRequest(
            "ID must contain 1..128 ASCII letters, digits, or -_.:".into(),
        ));
    }
    Ok(())
}

fn valid_channel(snapshot: &GraphCaptureSnapshot, channel: u8) -> bool {
    channel < snapshot.metadata.channel_count
        && (snapshot.metadata.enabled_channels.is_empty()
            || snapshot.metadata.enabled_channels.contains(&channel))
}

fn validate_annotation(
    annotation: &AnnotationInput,
    snapshot: &GraphCaptureSnapshot,
    gui: bool,
) -> Result<()> {
    if annotation.title.trim().is_empty()
        || annotation.title.len() > 640
        || annotation.note.len() > 4_096
        || annotation.tags.len() > 16
        || annotation.tags.iter().any(|t| t.is_empty() || t.len() > 64)
        || annotation.evidence_refs.len() > 16
        || annotation
            .evidence_refs
            .iter()
            .any(|r| r.is_empty() || r.len() > 256)
        || annotation.sample.0 >= snapshot.metadata.sample_count
        || annotation.color.len() != 7
        || !annotation.color.starts_with('#')
        || !annotation.color.as_bytes()[1..]
            .iter()
            .all(|b| b.is_ascii_hexdigit())
    {
        return Err(WorkbenchError::InvalidRequest(
            "invalid annotation text, style, tags, or point".into(),
        ));
    }
    let range_kind = matches!(
        annotation.kind,
        AnnotationKind::TimingPair | AnnotationKind::RangeAnnotation
    );
    let channel_kind = matches!(
        annotation.kind,
        AnnotationKind::ChannelAnnotation | AnnotationKind::RangeAnnotation
    );
    if range_kind != annotation.end_sample.is_some()
        || channel_kind != annotation.channel.is_some()
        || annotation
            .channel
            .is_some_and(|c| !valid_channel(snapshot, c))
        || annotation
            .end_sample
            .is_some_and(|end| match annotation.kind {
                // A timing pair contains two recorded points, including zero delta.
                AnnotationKind::TimingPair => {
                    end.0 < annotation.sample.0 || end.0 >= snapshot.metadata.sample_count
                }
                _ => end.0 <= annotation.sample.0 || end.0 > snapshot.metadata.sample_count,
            })
    {
        return Err(WorkbenchError::InvalidRequest(
            "annotation kind does not match its channel or range".into(),
        ));
    }
    if gui
        && (annotation.sample.0 > MAX_SAFE_UI_SAMPLE
            || annotation
                .end_sample
                .is_some_and(|end| end.0 > MAX_SAFE_UI_SAMPLE))
    {
        return Err(WorkbenchError::UiPrecisionLimit);
    }
    Ok(())
}

#[cfg(test)]
mod tests;
