use serde::{Deserialize, Serialize};
use sigpilot_analysis::{ExactU64, SampleRange};
use sigpilot_file::WaveformAnnotationShape;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AnnotationKind {
    TimingPoint,
    TimingPair,
    ChannelAnnotation,
    RangeAnnotation,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AnnotationSource {
    User,
    Assistant,
    AnalysisProvider,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AnnotationInput {
    pub kind: AnnotationKind,
    pub sample: ExactU64,
    #[serde(default)]
    pub end_sample: Option<ExactU64>,
    #[serde(default)]
    pub channel: Option<u8>,
    pub title: String,
    #[serde(default)]
    pub note: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub evidence_refs: Vec<String>,
    #[serde(default)]
    pub shape: Option<WaveformAnnotationShape>,
    pub color: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkbenchAnnotation {
    pub id: String,
    pub source: AnnotationSource,
    pub author_id: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub evidence: Vec<crate::evidence::EvidenceRecord>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub archived_evidence: Vec<crate::evidence::EvidenceRecord>,
    #[serde(flatten)]
    pub value: AnnotationInput,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
pub enum AnnotationOperation {
    Create {
        #[serde(default)]
        id: Option<String>,
        annotation: AnnotationInput,
    },
    Update {
        id: String,
        annotation: AnnotationInput,
    },
    Delete {
        id: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct CaptureRef {
    pub session_id: String,
    pub capture_id: String,
    pub data_revision: ExactU64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ApplyAnnotationsRequest {
    pub capture: CaptureRef,
    pub expected_annotation_revision: ExactU64,
    pub request_id: String,
    #[serde(default)]
    pub preview: bool,
    pub operations: Vec<AnnotationOperation>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApplyAnnotationsResult {
    pub capture: CaptureRef,
    pub annotation_revision: ExactU64,
    pub request_id: String,
    pub actor_id: String,
    pub batch_id: Option<String>,
    pub preview: bool,
    pub upserts: Vec<WorkbenchAnnotation>,
    pub deleted_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnnotationPage {
    pub capture: CaptureRef,
    pub annotation_revision: ExactU64,
    pub annotations: Vec<WorkbenchAnnotation>,
    pub next_after_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CaptureContext {
    #[serde(flatten)]
    pub capture: CaptureRef,
    pub finalized: bool,
    pub sample_rate_hz: ExactU64,
    pub sample_count: ExactU64,
    pub channel_count: u8,
    pub enabled_channels: Vec<u8>,
    pub annotation_revision: ExactU64,
    pub annotation_count: ExactU64,
    pub report_revision: ExactU64,
    pub report_count: ExactU64,
    pub config_revision: ExactU64,
    pub analyzer_count: ExactU64,
    pub analyzers_initialized: bool,
    pub result_revision: ExactU64,
    pub retained_result_count: ExactU64,
    pub derivation: Option<serde_json::Value>,
    pub gui_attached: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkbenchSnapshot {
    pub context: CaptureContext,
    pub annotations: Vec<WorkbenchAnnotation>,
    pub undo_batch_id: Option<String>,
    pub analyzers: Vec<crate::analyzers::AnalyzerInstance>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum WorkbenchEvent {
    ResultsChanged {
        capture: CaptureRef,
        result_revision: ExactU64,
    },
    AnalyzersChanged {
        capture: CaptureRef,
        config_revision: ExactU64,
    },
    AnnotationsChanged {
        result: ApplyAnnotationsResult,
    },
    ReportsChanged {
        capture: CaptureRef,
        report_revision: ExactU64,
        report_count: ExactU64,
    },
    FocusRequested {
        capture: CaptureRef,
        range: SampleRange,
        channels: Vec<u8>,
        view: sigpilot_graph::SessionView,
    },
    ChannelLayoutRequested {
        capture: CaptureRef,
        command: crate::layout::ChannelLayoutCommand,
    },
    SessionReleased {
        session_id: String,
    },
}

/// Identity and source come from the authenticated adapter, never tool input.
pub struct Caller<'a> {
    pub id: &'a str,
    pub source: AnnotationSource,
}
