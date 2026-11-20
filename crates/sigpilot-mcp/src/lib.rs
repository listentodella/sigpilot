//! MCP adapter. Signal and document semantics belong to workbench/analysis.

pub mod bridge;
mod cancellation;
pub mod capture;
pub mod desktop;
pub mod oauth;
pub mod onboarding;
pub mod prompts;
pub mod resources;
pub mod server;
mod storage;

use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

use rmcp::{
    model::{
        CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, Implementation,
        ListToolsResult, PaginatedRequestParams, ServerCapabilities, ServerConfig, Tool,
        ToolAnnotations,
    },
    service::{RequestContext, RoleServer},
    ErrorData, ServerHandler,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sigpilot_analysis::{EdgeDirection, ExactU64, SampleRange};
use sigpilot_workbench::{
    AnnotationSource, ApplyAnnotationsRequest, Caller, CaptureRef, WorkbenchError, WorkbenchService,
};

#[derive(Clone)]
pub struct McpAdapter {
    pub workbench: Arc<WorkbenchService>,
    pub file_roots: Arc<Vec<PathBuf>>,
    pub can_edit_annotations: bool,
    pub can_capture: bool,
    pub capture_service: Option<Arc<capture::CaptureService>>,
    pub caller_id: Arc<str>,
    pub(crate) budget: Arc<tokio::sync::Semaphore>,
}

impl McpAdapter {
    pub fn new(
        workbench: Arc<WorkbenchService>,
        file_roots: Vec<PathBuf>,
        can_edit_annotations: bool,
        caller_id: String,
    ) -> Self {
        Self {
            workbench,
            file_roots: Arc::new(file_roots),
            can_edit_annotations,
            can_capture: false,
            capture_service: None,
            caller_id: caller_id.into(),
            budget: Arc::new(tokio::sync::Semaphore::new(1)),
        }
    }

    pub fn tool_catalog(&self) -> Vec<Tool> {
        let exact = json!({"type":"string","pattern":"^(0|[1-9][0-9]{0,19})$","description":"Exact unsigned integer, encoded as a decimal string."});
        let capture = json!({"type":"object","additionalProperties":false,"required":["session_id","capture_id","data_revision"],"properties":{"session_id":{"type":"string","maxLength":128},"capture_id":{"type":"string","maxLength":256},"data_revision":exact}});
        let range = json!({"type":"object","additionalProperties":false,"required":["start_sample","end_sample"],"properties":{"start_sample":exact,"end_sample":exact},"description":"Half-open sample range [start, end)."});
        let limit = json!({"type":"integer","minimum":1,"maximum":1000,"default":100});
        let field_value = json!({"oneOf":[
            {"type":"object","additionalProperties":false,"required":["type","value"],"properties":{"type":{"const":"unsigned"},"value":exact}},
            {"type":"object","additionalProperties":false,"required":["type","value"],"properties":{"type":{"const":"signed"},"value":{"type":"string","pattern":"^(0|-?[1-9][0-9]{0,18})$"}}},
            {"type":"object","additionalProperties":false,"required":["type","value"],"properties":{"type":{"const":"boolean"},"value":{"type":"boolean"}}},
            {"type":"object","additionalProperties":false,"required":["type","value"],"properties":{"type":{"const":"text"},"value":{"type":"string","maxLength":4096}}},
            {"type":"object","additionalProperties":false,"required":["type","value"],"properties":{"type":{"const":"bytes"},"value":{"type":"array","maxItems":4096,"items":{"type":"integer","minimum":0,"maximum":255}}}}
        ]});
        let frame_query = json!({"type":"object","additionalProperties":false,"properties":{
            "range":range,"rows":{"type":"array","maxItems":32,"items":{"type":"string","maxLength":128}},
            "fields":{"type":"array","maxItems":8,"items":{"type":"object","additionalProperties":false,"required":["name","op"],"properties":{
                "name":{"type":"string","maxLength":128},"op":{"type":"string","enum":["eq","ne","lt","lte","gt","gte","exists"]},"value":field_value}}},
            "text_contains":{"type":"string","minLength":1,"maxLength":256},"projection":{"type":"array","maxItems":64,"items":{"type":"string","maxLength":128}}
        }});
        let channel = json!({"type":"integer","minimum":0,"maximum":31});
        let protocol_limit = json!({"type":"integer","minimum":1,"maximum":100,"default":100});
        let frame_sequence_query = json!({"type":"object","additionalProperties":false,"required":["schema_version","steps"],"properties":{
            "schema_version":{"const":"1"},"scope":{"type":"string","enum":["stream","i2c_segment"],"default":"stream"},"range":range,
            "steps":{"type":"array","minItems":1,"maxItems":8,"items":{"type":"object","additionalProperties":false,"required":["query"],"properties":{
                "query":frame_query,"within":{"type":["object","null"],"additionalProperties":false,"required":["min_samples","max_samples"],"properties":{"min_samples":exact,"max_samples":exact}}}}}}});
        let transaction_query = json!({"type":"object","additionalProperties":false,"properties":{"range":range,
            "conditions":{"type":"array","maxItems":8,"items":frame_query},"require_complete":{"type":"boolean","default":false}}});
        let correlation_query = json!({"type":"object","additionalProperties":false,"required":["events","original_range","before_samples","after_samples","min_width_samples","max_width_exclusive"],"properties":{
            "events":frame_query,"original_range":range,"before_samples":exact,"after_samples":exact,"high":{"type":["boolean","null"]},"min_width_samples":exact,"max_width_exclusive":exact}});
        let optional_channel = json!({"type":["integer","null"],"minimum":0,"maximum":31});
        let config = json!({"oneOf":[
            {"type":"object","additionalProperties":false,"required":["protocol","settings"],"properties":{"protocol":{"const":"UART"},"settings":{
                "type":"object","additionalProperties":false,"required":["channel","baud_rate"],"properties":{"channel":channel,"baud_rate":exact,
                "inverted":{"type":"boolean","default":false},"data_bits":{"type":"integer","minimum":5,"maximum":9,"default":8},
                "stop_bits":{"type":"string","enum":["1","1.5","2"],"default":"1"},"parity":{"type":"string","enum":["none","even","odd"],"default":"none"},"msb_first":{"type":"boolean","default":false}}}}},
            {"type":"object","additionalProperties":false,"required":["protocol","settings"],"properties":{"protocol":{"const":"I2C"},"settings":{
                "type":"object","additionalProperties":false,"required":["sda_channel","scl_channel"],"properties":{"sda_channel":channel,"scl_channel":channel}}}},
            {"type":"object","additionalProperties":false,"required":["protocol","settings"],"properties":{"protocol":{"const":"SPI"},"settings":{
                "type":"object","additionalProperties":false,"required":["clock_channel"],"properties":{"mosi_channel":optional_channel,"miso_channel":optional_channel,
                "clock_channel":channel,"enable_channel":optional_channel,"enable_active_low":{"type":"boolean","default":true},"clock_polarity":{"type":"boolean","default":false},
                "clock_phase":{"type":"boolean","default":false},"bits_per_transfer":{"type":"integer","minimum":1,"maximum":64,"default":8},"msb_first":{"type":"boolean","default":true}}}}}
        ]});
        let annotation = json!({"type":"object","additionalProperties":false,"required":["kind","sample","title","color"],"properties":{
            "kind":{"type":"string","enum":["channel_annotation","timing_point","timing_pair","range_annotation"],"description":"timing_point has no channel/end; timing_pair has two recorded points (end >= sample); channel_annotation requires channel; range_annotation requires channel and a nonempty half-open range."},
            "sample":exact,"end_sample":{"anyOf":[exact,{"type":"null"}]},"channel":{"type":["integer","null"],"minimum":0,"maximum":31},
            "title":{"type":"string","minLength":1,"maxLength":640},"note":{"type":"string","maxLength":4096},
            "tags":{"type":"array","maxItems":16,"items":{"type":"string","maxLength":64}},
            "evidence_refs":{"type":"array","maxItems":16,"items":{"type":"string","maxLength":128},"description":"Use only returned evidence refs from this capture. The annotation anchor and channel must lie inside its evidence."},
            "shape":{"type":["string","null"],"enum":["flag","diamond","warning","cross","dot","square",null]},
            "color":{"type":"string","pattern":"^#[0-9a-fA-F]{6}$"}}});
        let trigger_event = json!({"oneOf":[
            {"type":"object","additionalProperties":false,"required":["type","channel","high"],"properties":{"type":{"const":"level"},"channel":channel,"high":{"type":"boolean"}}},
            {"type":"object","additionalProperties":false,"required":["type","channel","direction"],"properties":{"type":{"const":"edge"},"channel":channel,"direction":{"type":"string","enum":["rising","falling"]}}},
            {"type":"object","additionalProperties":false,"required":["type","channel","high","min_width_samples","max_width_exclusive","anchor"],"properties":{
                "type":{"const":"pulse_width"},"channel":channel,"high":{"type":"boolean"},"min_width_samples":exact,"max_width_exclusive":exact,"anchor":{"type":"string","enum":["pulse_start","pulse_end"]}}}
        ]});
        let trigger_rule = json!({"type":"object","additionalProperties":false,"required":["schema_version","steps"],"properties":{
            "schema_version":{"const":"1"},"holdoff_samples":exact,"steps":{"type":"array","minItems":1,"maxItems":8,"items":{
                "type":"object","additionalProperties":false,"required":["event"],"properties":{"event":trigger_event,
                "guards":{"type":"array","maxItems":16,"items":{"type":"object","additionalProperties":false,"required":["channel","high","phase"],"properties":{
                    "channel":channel,"high":{"type":"boolean"},"phase":{"type":"string","enum":["before","after"]}}},
                "within":{"type":["object","null"],"additionalProperties":false,"required":["min_samples","max_samples"],"properties":{"min_samples":exact,"max_samples":exact}}
        }}}}}});
        let trigger_target = json!({"type":"object","additionalProperties":false,"required":["profile_id","mode","channel_count","sample_rate_hz"],"properties":{
            "profile_id":{"type":"string","maxLength":128},"mode":{"type":"string","enum":["buffer","stream"]},
            "channel_count":{"type":"integer","minimum":1,"maximum":32},"enabled_channels":{"type":"array","maxItems":32,"uniqueItems":true,"items":channel},"sample_rate_hz":exact}});
        let operations = json!({"type":"array","minItems":1,"maxItems":200,"items":{"oneOf":[
            {"type":"object","additionalProperties":false,"required":["op","annotation"],"properties":{"op":{"const":"create"},"id":{"type":"string","maxLength":128},"annotation":annotation}},
            {"type":"object","additionalProperties":false,"required":["op","id","annotation"],"properties":{"op":{"const":"update"},"id":{"type":"string","maxLength":256},"annotation":annotation}},
            {"type":"object","additionalProperties":false,"required":["op","id"],"properties":{"op":{"const":"delete"},"id":{"type":"string","maxLength":256}}}
        ]}});
        let mut tools = vec![
            tool("sigpilot_list_capabilities", "Discover registered analysis providers, protocol queries, decoder configuration state and offline driver trigger profiles with budgets. Native decoders and device profiles are not probed during discovery. Does not enumerate or prepare USB devices.", json!({}), &[], true, true),
            tool("sigpilot_get_context", "Read bounded session context, finalized capture identity, sampling rate, and annotation revision. Never prepares hardware.", json!({"session_id":{"type":"string","maxLength":128}}), &[], true, true),
            tool("sigpilot_query_edges", "Read exact original digital transitions from a finalized capture. At most 4096 edges are inspected and 1000 returned per page. Resume at next_start_sample with the same capture reference and range end.", json!({"capture":capture,"channel":{"type":"integer","minimum":0,"maximum":31},"range":range,"direction":{"type":"string","enum":["rising","falling"]},"limit":limit}), &["capture","channel","range"], true, true),
            tool("sigpilot_measure", "Measure an exact point pulse/period or a bounded range page. Durations and duty ratios are exact rational objects, never floating-point estimates. Capture boundary runs have observed widths but no fabricated complete pulse. Range occupancy and pulse statistics describe the returned coverage; resume with the same original_range and next_start_sample.", json!({"capture":capture,"channel":{"type":"integer","minimum":0,"maximum":31},"mode":{"type":"string","enum":["point","range"]},"sample":exact,"original_range":range,"start_sample":exact}), &["capture","channel","mode"], true, true),
            tool("sigpilot_get_analyzers", "Read revision-bound shared analyzer instances in GUI order. Use config_revision from get_context, and resume after next_after_id with the same revision. Returns typed config only for UART/I2C/SPI and explicit edit/run support for each backend; existing native/HLA metadata is preserved. No native code is loaded or hardware probed.",json!({"capture":capture,"config_revision":exact,"after_id":{"type":"string","maxLength":128},"limit":{"type":"integer","minimum":1,"maximum":64,"default":20}}),&["capture","config_revision"],true,true),
            tool("sigpilot_run_decode", "Submit UART/I2C/SPI decoding with either a temporary config or analyzer_id plus expected_config_revision; do not mix them. A shared instance must use the supervised Saleae backend. Freezes the selected configuration; later GUI/MCP edits do not modify a submitted job. Decodes from sample zero through range.end_sample for state recovery; queries return overlaps with range. One running job, two queued globally; 65536 input edges, 4096 frames, 30s and 512MiB child limits. request_id supports bounded replay, including after instance edits. Connection loss does not cancel the job.", json!({"capture":capture,"range":range,"config":config,"analyzer_id":{"type":"string","maxLength":128},"expected_config_revision":exact,"request_id":{"type":"string","maxLength":128}}), &["capture","range","request_id"], true, true),
            tool("sigpilot_query_frames", "Query a retained decode using typed fields declared in get_job.result.field_schema. All filters apply to the same frame. Missing fields are unknown and never match eq/ne. Unknown names or wrong types fail. Native display texts are data. Returned ranges are half-open and frames have result-bound refs; cursor binds caller, query and result. Frame payload is bounded to 128KiB and at most 1000 items, with references added within the adapter response budget.", json!({"result_set_id":{"type":"string","maxLength":128},"query":frame_query,"cursor":{"type":"string","maxLength":128},"limit":limit}), &["result_set_id"], true, true),
            tool("sigpilot_query_frame_sequence", "Query 1..8 ordered frames in an owned decode. Each step uses the observed typed frame schema. within is an inclusive delay between successive frame starts; the first step has no within. A frame cannot be reused. Returns the earliest completable chain per initial frame. stream permits any rows; i2c_segment prevents crossing repeated START/STOP boundaries. At most 100 matches, 16KiB query and one million comparisons. search_complete=false means unknown total, never a negative finding; narrow the query. Cursor binds owner, result and query. Evidence and frame refs locate each match in the original capture.",json!({"result_set_id":{"type":"string","maxLength":128},"query":frame_sequence_query,"cursor":{"type":"string","maxLength":128},"limit":protocol_limit}),&["result_set_id","query"],true,true),
            tool("sigpilot_query_transactions", "Query I2C address segments grouped from verified START/STOP event rows. All conditions must match within the same segment; repeated START opens another segment in the same parent transaction. Returns matching segment range, parent boundaries, completeness, and one projected witness per condition. Context comes from the processed prefix, so an address witness may precede the requested range. require_complete requires observed parent START and STOP. Missing ACK never becomes NACK. At most 8 conditions, 100 matches and 128KiB frame payload. Cursor binds owner, result and query.",json!({"result_set_id":{"type":"string","maxLength":128},"query":transaction_query,"cursor":{"type":"string","maxLength":128},"limit":protocol_limit}),&["result_set_id"],true,true),
            tool("sigpilot_correlate_pulses", "Associate explicitly queried decode frames with complete original-edge pulses on one channel. Width is [min_width_samples,max_width_exclusive); min must be >=1. pulse_start must fall within the inclusive before/after window around frame_start. delta_samples is the exact signed pulse_start minus frame_start. Returns all pairs in pulse-start/frame order, independent frame and pulse evidence, and edge coverage. A matching frame is caller-selected, not automatically a protocol error; temporal cooccurrence does not establish a hardware cause. At most 4096 edges and 1000 pulse candidates per scan page, 100 pairs and 128KiB pair payload per response. Consume next_cursor using identical inputs, then resume at next_start_sample with the same original_range; incomplete coverage cannot rule out anomalies.",json!({"result_set_id":{"type":"string","maxLength":128},"channel":channel,"query":correlation_query,"start_sample":exact,"cursor":{"type":"string","maxLength":128},"limit":protocol_limit}),&["result_set_id","channel","query","start_sample"],true,true),
            tool("sigpilot_get_job", "Poll an owned domain job. queued/running/completed/failed/cancelled are distinct; cancel_requested does not mean cancellation has finished. Completed decode summaries contain observed field schema and result_set_id. Results are retained up to 15 minutes, 16 jobs and 16MiB, with earlier eviction under pressure. No standard MCP Tasks extension is required.", json!({"job_id":{"type":"string","maxLength":128}}), &["job_id"], true, true),
            tool("sigpilot_get_evidence", "Resolve 1..8 server-issued evidence refs for an explicit capture, with optional bounded original-edge context. Results preserve provider parameters, exact observations and verification provenance. Attached annotation evidence survives registry eviction and .pxl save/reopen; reopened evidence is marked saved, not recomputed. Unknown/stale refs fail. context_samples is a radius; at most 128 edges are returned across all contexts.", json!({"capture":capture,"refs":{"type":"array","minItems":1,"maxItems":8,"items":{"type":"string","maxLength":128}},"context_samples":exact}), &["capture","refs"], true, true),
            tool("sigpilot_cancel_job", "Request cancellation of this caller's job only. A running decoder terminates its own process group. Repeated cancellation and terminal jobs are idempotent; poll get_job for terminal state.", json!({"job_id":{"type":"string","maxLength":128}}), &["job_id"], false, true),
            tool("sigpilot_validate_trigger", "Validate finite offline edge/pulse/level sequences with before/after level guards. Level events mean qualified sample intervals, including a constant level at range start; they do not require an invented edge. Distinguishes invalid model, proven conflict and satisfiable-in-model. First step has no within; subsequent windows are inclusive sample delays from the preceding event anchor. Maximum 8 steps, 16 guards per step. Use compile_trigger with an explicit offline driver profile for hardware expression support; neither tool configures hardware.", json!({"capture":capture,"rule":trigger_rule}), &["capture","rule"], true, true),
            tool("sigpilot_compile_trigger", "Compile the same finite trigger rule for an explicit profile from list_capabilities.hardware_triggers. Read-only offline operation; never probes, configures or arms hardware. PXLogic supports one edge or level encoding, exact clock-table rates and mode/channel limits. Unsupported widths, temporal stages, holdoff or rate/channel clamping produce no artifact. Entailed guards may be removed with an explicit normalization. Unknown FPGA sampling phase for additional channel guards returns unverified with candidate_encoding, never a ready artifact. A supported driver encoding still has hardware_verified=false. Known current Kingst/demo paths report unsupported. Input <=16KiB, compiler output <=64KiB.",json!({"target":trigger_target,"rule":trigger_rule}),&["target","rule"],true,true),
            tool("sigpilot_simulate_trigger", "Submit an offline trigger replay job against a fixed range. Returns stage candidates, guard/suffix/window diagnostics, exact event anchors and separate confirmation samples via get_job. Backward temporal interval search finds the earliest completable chain per initial event or qualified level interval, including interior level anchors, with positive holdoff from confirmation time. Bounded to 65536 input edges, 4096 candidates per step, 65536 viable intervals and one million budgeted comparisons; partial coverage is incomplete. Pulse witness ranges include the recorded closing point and retain a separate half-open pulse_range. No hardware is armed.", json!({"capture":capture,"range":range,"rule":trigger_rule,"limit":limit,"request_id":{"type":"string","maxLength":128}}), &["capture","range","rule","request_id"], true, true),
            tool("sigpilot_list_annotations", "Read a revision-bound page of semantic annotations. after_id and annotation revision belong to the same document snapshot.", json!({"capture":capture,"annotation_revision":exact,"after_id":{"type":"string","maxLength":256},"limit":limit}), &["capture","annotation_revision"], true, true),
            tool("sigpilot_get_reports", "Read independent immutable bundles of selected evidence. List mode requires report_revision and optionally after_id. Finding-page mode requires report_id, optionally start_index, and forbids report_revision/after_id. Pages contain provider parameters, exact observations and verification provenance, at most 112KiB. Reports persist when the GUI saves .pxl; reopened evidence is saved, not recomputed. Cropped reports are archived in original coordinates and cannot supply current-capture evidence. This bundle covers selected findings only; it is not a full scan or decode cache.",json!({"capture":capture,"report_revision":exact,"after_id":{"type":"string","maxLength":128},"report_id":{"type":"string","maxLength":128},"start_index":exact,"limit":{"type":"integer","minimum":1,"maximum":64,"default":20}}),&["capture"],true,true),
            tool("sigpilot_export_report", "Render one immutable selected-evidence report as JSON or Markdown UTF-8 chunks. Requires the current report revision. Concatenate content in order, resuming with next_offset and the same capture/report/revision/format. max_bytes limits each chunk; offsets must be UTF-8 boundaries. Exact sample strings, provider parameters and saved/archived verification are retained. Markdown quotes commentary and fences observations. No server file path is accepted or written; the client may save the returned content in its authorized workspace. Rendered report <=2MiB.",json!({"capture":capture,"report_revision":exact,"report_id":{"type":"string","maxLength":128},"format":{"type":"string","enum":["json","markdown"]},"offset":exact,"max_bytes":{"type":"integer","minimum":128,"maximum":32768,"default":16384}}),&["capture","report_revision","report_id","format"],true,true),
            tool("sigpilot_focus_view", "Focus the attached desktop session on an exact range. Returns the actual normalized viewport. Rejects coordinates that the GUI cannot represent exactly.", json!({"capture":capture,"range":range,"channels":{"type":"array","maxItems":32,"items":{"type":"integer","minimum":0,"maximum":31}}}), &["capture","range"], false, true),
            tool("sigpilot_run_analysis", "Run a registered provider over bounded original-edge pages. Obtain parameter schema from list_capabilities.providers. Built-ins include pulse_width, range_measure and multichannel_timing (setup/hold or edge delay); channel selects the primary anchor channel, and typed parameters declare related captured channels. All inputs use the same capture revision. Resume using next_start_sample and the same original_range. Timing complete describes anchor coverage, while assessments_complete preserves undecided boundary cases. Legacy flat pulse fields require parameters to be omitted. No automatic markings or source filtering are applied.", json!({"capture":capture,"provider_id":{"type":"string","maxLength":128},"channel":{"type":"integer","minimum":0,"maximum":31},"original_range":range,"start_sample":exact,"parameters":{"type":"object","description":"Must match the registered provider parameter_schema."},"high":{"type":["boolean","null"]},"min_width_samples":exact,"max_width_exclusive":{"anyOf":[exact,{"type":"null"}]},"limit":limit}), &["capture","provider_id","channel","original_range","start_sample"], true, true),
        ];
        if !self.file_roots.is_empty() {
            tools.push(tool("sigpilot_open_capture", "Import a .pxcap or .pxl from a configured root into a new explicit session. Rejects oversized decompression/index allocation before constructing the graph. Existing sessions are never overwritten.", json!({"session_id":{"type":"string","maxLength":128},"path":{"type":"string","maxLength":4096}}), &["session_id","path"], false, false));
        }
        tools.push(tool("sigpilot_get_results", "Read explicitly retained complete job snapshots. List requires current result_revision; summary uses result_set_id; chunk mode also uses offset/max_bytes and returns typed output as UTF-8 JSON chunks. Reopened projects rebind result IDs and mark saved-not-recomputed verification without restarting jobs. Retained decode IDs support existing frame/sequence/transaction queries; cropped archived results cannot query the new capture. Runtime jobs remain private until explicitly retained.",json!({"capture":capture,"result_revision":exact,"after_id":{"type":"string","maxLength":128},"result_set_id":{"type":"string","maxLength":128},"offset":exact,"max_bytes":{"type":"integer","minimum":128,"maximum":32768},"limit":{"type":"integer","minimum":1,"maximum":16,"default":16}}),&["capture"],true,true));
        if self.can_edit_annotations {
            tools.push(tool("sigpilot_create_derived_capture", "Create a separate immutable digital hypothesis by replacing disjoint complete original pulses narrower than max_width_exclusive. Select 1..8 captured channels and optional high polarity. One pass, no cascading, <=65536 original edges across all captured channels. Preserves sample count, initial levels, open-boundary runs and sample axis; source is unchanged. Returns new context with bounded provenance and identity mapping. preview has no write; same caller/request/inputs replay while target is unchanged. Existing targets reject conflicts. Reopened provenance grants no replay. Run the existing decoder separately on original and derived captures with identical temporary config, then query each result; do not reuse original evidence on derived data. Filtering is not an electrical repair or hardware diagnosis. No file is written.",json!({"capture":capture,"target_session_id":{"type":"string","maxLength":128},"channels":{"type":"array","minItems":1,"maxItems":8,"uniqueItems":true,"items":channel},"max_width_exclusive":exact,"high":{"type":["boolean","null"]},"request_id":{"type":"string","maxLength":128},"preview":{"type":"boolean","default":false}}),&["capture","target_session_id","channels","max_width_exclusive","request_id"],false,true));
            tools.push(tool("sigpilot_apply_results", "Retain a complete owned job output in the shared project or delete a retained snapshot. Independent expected_result_revision, preview and bounded caller/request replay. At most 16 snapshots, 4MiB each and 8MiB per project. GUI .pxl save persists full typed output; reopening shares saved observations without resuming jobs. Retaining deliberately shares the result with other authorized project clients. No source change or server file write.",json!({"capture":capture,"expected_result_revision":exact,"request_id":{"type":"string","maxLength":128},"preview":{"type":"boolean","default":false},"operation":{"oneOf":[
                {"type":"object","additionalProperties":false,"required":["op","job_id"],"properties":{"op":{"const":"retain"},"job_id":{"type":"string","maxLength":128}}},
                {"type":"object","additionalProperties":false,"required":["op","result_set_id"],"properties":{"op":{"const":"delete"},"result_set_id":{"type":"string","maxLength":128}}}
            ]}}),&["capture","expected_result_revision","request_id","operation"],false,true));
            tools.push(tool("sigpilot_configure_analyzer", "Create/update/delete one shared analyzer using typed UART/I2C/SPI configuration. Uses capture identity and independent expected_config_revision with bounded caller/request replay. preview does not mutate. Update preserves ID, backend, protocol and provenance; typed settings on existing Sigrok instances are editable, but supervised MCP running currently requires Saleae. Arbitrary native/HLA settings and backend replacement are rejected. Edits require captured channels and baud <= sampling rate. New instances use Saleae. Does not run a decoder or start capture. Saved by GUI .pxl save. Maximum 64 instances/192KiB document, 16KiB edit.",json!({"capture":capture,"expected_config_revision":exact,"request_id":{"type":"string","maxLength":128},"preview":{"type":"boolean","default":false},"operation":{"oneOf":[
                {"type":"object","additionalProperties":false,"required":["op","name","config"],"properties":{"op":{"const":"create"},"id":{"type":"string","maxLength":128},"name":{"type":"string","minLength":1,"maxLength":640},"config":config}},
                {"type":"object","additionalProperties":false,"required":["op","id","name","config"],"properties":{"op":{"const":"update"},"id":{"type":"string","maxLength":128},"name":{"type":"string","minLength":1,"maxLength":640},"config":config}},
                {"type":"object","additionalProperties":false,"required":["op","id"],"properties":{"op":{"const":"delete"},"id":{"type":"string","maxLength":128}}}
            ]}}),&["capture","expected_config_revision","request_id","operation"],false,true));
            tools.push(tool("sigpilot_apply_reports", "Create an immutable report from 1..64 distinct server-issued evidence refs, or delete one report. Uses explicit capture, report revision and owner-scoped request replay; does not change annotations. Title/note are assistant commentary; observation content comes only from validated server evidence. preview validates without writing and returns no stable report ID. At most 32 bundles / 4MiB per capture, 512KiB per report, 96KiB per finding; input <=16KiB. Writes the shared memory document. Actual file persistence occurs through the GUI's .pxl save command.",json!({"capture":capture,"expected_report_revision":exact,"request_id":{"type":"string","maxLength":128},"preview":{"type":"boolean","default":false},"operation":{"oneOf":[
                {"type":"object","additionalProperties":false,"required":["op","title","evidence_refs"],"properties":{"op":{"const":"create"},"title":{"type":"string","minLength":1,"maxLength":640},"note":{"type":"string","maxLength":4096},"evidence_refs":{"type":"array","minItems":1,"maxItems":64,"uniqueItems":true,"items":{"type":"string","maxLength":128}}}},
                {"type":"object","additionalProperties":false,"required":["op","report_id"],"properties":{"op":{"const":"delete"},"report_id":{"type":"string","maxLength":128}}}
            ]}}),&["capture","expected_report_revision","request_id","operation"],false,true));
            tools.push(tool("sigpilot_undo_annotations", "Undo one owned atomic annotation batch with explicit capture and current annotation revision. Only the batch's unchanged resulting revision can be undone; subsequent edits require re-reading state. Restores original provenance and evidence snapshots. preview validates without writing; request_id is replay-safe. History is in-memory for up to 15 minutes, 128 batches and 2MiB.",json!({"capture":capture,"expected_annotation_revision":exact,"batch_id":{"type":"string","maxLength":128},"request_id":{"type":"string","maxLength":128},"preview":{"type":"boolean","default":false}}),&["capture","expected_annotation_revision","batch_id","request_id"],false,true));
            tools.push(tool("sigpilot_apply_annotations", "Atomically create, update, or delete at most 200 annotations. Explicit capture and annotation revisions prevent overwrites. A request ID is replay-safe within the bounded in-memory retention window. preview validates without writing.", json!({"capture":capture,"expected_annotation_revision":exact,"request_id":{"type":"string","maxLength":128},"preview":{"type":"boolean","default":false},"operations":operations}), &["capture","expected_annotation_revision","request_id","operations"], false, true));
        }
        if self.capture_service.is_some() {
            tools.extend(capture::tool_catalog(self.can_capture));
        }
        tools
    }

    fn execute(&self, name: &str, arguments: Value) -> Result<Value, ToolFailure> {
        self.execute_with_cancel(name, arguments, &AtomicBool::new(false))
    }

    fn execute_with_cancel(
        &self,
        name: &str,
        arguments: Value,
        cancel: &AtomicBool,
    ) -> Result<Value, ToolFailure> {
        // Cancelling before dispatch prevents all work. After dispatch only
        // cooperative reads use the flag; writes and job submissions finish.
        if cancel.load(Ordering::Acquire) {
            return Err(WorkbenchError::Cancelled.into());
        }
        if let Some(service) = &self.capture_service {
            if name.starts_with("sigpilot_") && capture::is_capture_tool(name) {
                return capture::execute(
                    service,
                    &self.caller_id,
                    self.can_capture,
                    name,
                    arguments,
                )
                .map_err(|e| ToolFailure::new(e.code, e.message));
            }
        }
        match name {
            "sigpilot_list_capabilities" => {
                let _: EmptyRequest = parse(arguments)?;
                Ok(
                    json!({"schema_version":"1","providers":self.workbench.analysis_capabilities(),"decoder":self.workbench.decode_capabilities(),"analyzers":self.workbench.analyzer_capabilities(),"protocol_queries":self.workbench.protocol_query_capabilities(),"hardware_triggers":self.workbench.hardware_trigger_capabilities(),"reports":self.workbench.report_capabilities(),"results":self.workbench.result_capabilities(),"derived_captures":self.workbench.derived_capabilities(),"real_capture_control":self.can_capture && self.capture_service.is_some(),"capture_control":self.capture_service.as_ref().map(|s|s.capabilities()),"gui_focus_requires_attachment":true}),
                )
            }
            "sigpilot_run_decode" => {
                let request: DecodeRequest = parse(arguments)?;
                let job = match (
                    request.config,
                    request.analyzer_id,
                    request.expected_config_revision,
                ) {
                    (Some(config), None, None) => self.workbench.run_decode(
                        &self.caller_id,
                        request.capture,
                        request.range,
                        config,
                        &request.request_id,
                    )?,
                    (None, Some(id), Some(revision)) => self.workbench.run_analyzer_decode(
                        &self.caller_id,
                        request.capture,
                        request.range,
                        &id,
                        revision,
                        &request.request_id,
                    )?,
                    _ => {
                        return Err(ToolFailure::new(
                            "INVALID_INPUT",
                            "choose config or analyzer_id with expected_config_revision",
                        ))
                    }
                };
                Ok(serde_json::to_value(job)?)
            }
            "sigpilot_get_analyzers" => {
                let request: AnalyzersRequest = parse(arguments)?;
                self.workbench
                    .get_analyzers(
                        &request.capture,
                        request.config_revision,
                        request.after_id.as_deref(),
                        request.limit,
                    )
                    .map_err(Into::into)
            }
            "sigpilot_configure_analyzer" if self.can_edit_annotations => {
                let request: sigpilot_workbench::analyzers::ConfigureAnalyzerRequest =
                    parse(arguments)?;
                self.workbench
                    .configure_analyzer(
                        Caller {
                            id: &self.caller_id,
                            source: AnnotationSource::Assistant,
                        },
                        &request,
                    )
                    .map_err(Into::into)
            }
            "sigpilot_query_frames" => {
                let request: FramesRequest = parse(arguments)?;
                self.workbench
                    .query_decode_frames_with_cancel(
                        &self.caller_id,
                        &request.result_set_id,
                        request.query,
                        request.cursor.as_deref(),
                        request.limit,
                        cancel,
                    )
                    .map_err(Into::into)
            }
            "sigpilot_get_job" => {
                let request: JobRequest = parse(arguments)?;
                let snapshot = self.workbench.jobs.get(&self.caller_id, &request.job_id)?;
                let capture_current = self.workbench.validate_capture(&snapshot.capture).is_ok();
                let mut value = serde_json::to_value(snapshot)?;
                value["capture_current"] = json!(capture_current);
                Ok(value)
            }
            "sigpilot_query_frame_sequence" => {
                let request: SequenceRequest = parse(arguments)?;
                self.workbench
                    .query_decode_sequence_with_cancel(
                        &self.caller_id,
                        &request.result_set_id,
                        request.query,
                        request.cursor.as_deref(),
                        request.limit,
                        cancel,
                    )
                    .map_err(Into::into)
            }
            "sigpilot_query_transactions" => {
                let request: TransactionsRequest = parse(arguments)?;
                self.workbench
                    .query_decode_transactions_with_cancel(
                        &self.caller_id,
                        &request.result_set_id,
                        request.query,
                        request.cursor.as_deref(),
                        request.limit,
                        cancel,
                    )
                    .map_err(Into::into)
            }
            "sigpilot_correlate_pulses" => {
                let request: CorrelationRequest = parse(arguments)?;
                self.workbench
                    .correlate_decode_pulses_with_cancel(
                        &self.caller_id,
                        &request.result_set_id,
                        request.channel,
                        request.query,
                        request.start_sample.0,
                        request.cursor.as_deref(),
                        request.limit,
                        cancel,
                    )
                    .map_err(Into::into)
            }
            "sigpilot_cancel_job" => {
                let request: JobRequest = parse(arguments)?;
                Ok(serde_json::to_value(
                    self.workbench
                        .jobs
                        .cancel(&self.caller_id, &request.job_id)?,
                )?)
            }
            "sigpilot_validate_trigger" => {
                let request: ValidateTriggerRequest = parse(arguments)?;
                self.workbench
                    .validate_trigger(&request.capture, &request.rule)
                    .map_err(Into::into)
            }
            "sigpilot_simulate_trigger" => {
                let request: SimulateTriggerRequest = parse(arguments)?;
                Ok(serde_json::to_value(self.workbench.simulate_trigger(
                    &self.caller_id,
                    request.capture,
                    request.range,
                    request.rule,
                    request.limit,
                    &request.request_id,
                )?)?)
            }
            "sigpilot_compile_trigger" => {
                let request: CompileTriggerRequest = parse(arguments)?;
                self.workbench
                    .compile_trigger_with_cancel(&request.target, &request.rule, cancel)
                    .map_err(Into::into)
            }
            "sigpilot_run_analysis" => {
                let request: PulseRequest = parse(arguments)?;
                let parameters = if let Some(parameters) = request.parameters {
                    if request.high.is_some()
                        || request.min_width_samples.is_some()
                        || request.max_width_exclusive.is_some()
                        || request.limit.is_some()
                    {
                        return Err(ToolFailure::new(
                            "INVALID_INPUT",
                            "parameters cannot be mixed with legacy flat pulse fields",
                        ));
                    }
                    parameters
                } else if request.provider_id == "sigpilot.pulse_width" {
                    json!({"high":request.high,"min_width_samples":request.min_width_samples.ok_or_else(||ToolFailure::new("INVALID_INPUT","pulse minimum required"))?,
                        "max_width_exclusive":request.max_width_exclusive,"limit":request.limit.unwrap_or(100)})
                } else {
                    return Err(ToolFailure::new(
                        "INVALID_INPUT",
                        "registered provider requires parameters object",
                    ));
                };
                self.workbench
                    .run_analysis_page_with_cancel(
                        &request.capture,
                        &request.provider_id,
                        request.channel,
                        request.original_range,
                        request.start_sample.0,
                        parameters,
                        cancel,
                    )
                    .map_err(Into::into)
            }
            "sigpilot_open_capture" if !self.file_roots.is_empty() => {
                let request: OpenRequest = parse(arguments)?;
                if request.path.len() > 4096 {
                    return Err(ToolFailure::new("INVALID_INPUT", "path is too long"));
                }
                let path = PathBuf::from(&request.path)
                    .canonicalize()
                    .map_err(|e| ToolFailure::new("FILE_ERROR", e.to_string()))?;
                if !self.file_roots.iter().any(|root| path.starts_with(root)) {
                    return Err(ToolFailure::new(
                        "ACCESS_DENIED",
                        "file is outside the configured capture roots",
                    ));
                }
                let (capture, metadata) = match path.extension().and_then(|e| e.to_str()) {
                    Some("pxcap") => (
                        sigpilot_file::PxlogicProjectCapture::Packed(
                            sigpilot_file::open_pxcap_bounded(&path, 16 * 1024 * 1024)
                                .map_err(file_error)?,
                        ),
                        None,
                    ),
                    Some("pxl") => {
                        let project = sigpilot_file::open_pxl_bounded(&path, 16 * 1024 * 1024)
                            .map_err(file_error)?;
                        (project.capture, Some(project.session))
                    }
                    _ => return Err(ToolFailure::new("INVALID_INPUT", "expected .pxcap or .pxl")),
                };
                self.workbench
                    .import_capture(&request.session_id, capture)?;
                if let Some(metadata) = metadata {
                    if let Err(error) = self
                        .workbench
                        .restore_annotations(&request.session_id, &metadata)
                    {
                        self.workbench.release_session(&request.session_id);
                        return Err(error.into());
                    }
                }
                Ok(serde_json::to_value(
                    self.workbench.context(&request.session_id)?,
                )?)
            }
            "sigpilot_get_context" => {
                let request: ContextRequest = parse(arguments)?;
                if let Some(id) = request.session_id {
                    return Ok(serde_json::to_value(self.workbench.context(&id)?)?);
                }
                let mut sessions = Vec::new();
                for id in self.workbench.session_ids() {
                    match self.workbench.context(&id) {
                        Ok(context) => sessions.push(serde_json::to_value(context)?),
                        Err(WorkbenchError::Read(sigpilot_graph::read_api::ReadError::Graph(
                            _,
                        ))) => sessions.push(json!({"session_id":id,"state":"empty"})),
                        Err(error) => return Err(error.into()),
                    }
                }
                Ok(json!({"schema_version":"1","sessions":sessions}))
            }
            "sigpilot_query_edges" => {
                let request: EdgeRequest = parse(arguments)?;
                let window =
                    self.workbench
                        .edge_window(&request.capture, request.channel, request.range)?;
                let page = sigpilot_analysis::query_edges(
                    &window.window,
                    request.direction,
                    request.limit,
                )
                .map_err(|e| ToolFailure::new("INVALID_INPUT", e.to_string()))?;
                let drafts = page
                    .items
                    .iter()
                    .map(|edge| sigpilot_workbench::evidence::EvidenceDraft {
                        range: SampleRange {
                            start_sample: edge.sample,
                            end_sample: (edge.sample.0 + 1).into(),
                        },
                        channels: vec![edge.channel],
                        provider_id: "sigpilot.query_edges".into(),
                        provider_version: "1".into(),
                        parameters: json!({"range":request.range,"direction":request.direction}),
                        observed: json!(edge),
                    })
                    .collect();
                let evidence = self.workbench.record_evidence(&request.capture, drafts)?;
                let mut page = serde_json::to_value(page)?;
                for (item, record) in page["items"]
                    .as_array_mut()
                    .unwrap()
                    .iter_mut()
                    .zip(evidence)
                {
                    item["evidence_ref"] = json!(record.evidence_ref);
                }
                Ok(json!({"capture":request.capture,"page":page}))
            }
            "sigpilot_get_evidence" => {
                let request: EvidenceRequest = parse(arguments)?;
                self.workbench
                    .get_evidence(
                        &request.capture,
                        &request.refs,
                        request.context_samples.unwrap_or(0.into()),
                    )
                    .map_err(Into::into)
            }
            "sigpilot_measure" => {
                let request: MeasureRequest = parse(arguments)?;
                let measurement = match request.mode.as_str() {
                    "point"
                        if request.original_range.is_none() && request.start_sample.is_none() =>
                    {
                        let sample = request.sample.ok_or_else(|| {
                            ToolFailure::new("INVALID_INPUT", "point mode requires sample")
                        })?;
                        let window = self.workbench.point_window(
                            &request.capture,
                            request.channel,
                            sample.0,
                        )?;
                        serde_json::to_value(
                            sigpilot_analysis::measure::measure_point(&window.window)
                                .map_err(|e| ToolFailure::new("INVALID_INPUT", e.to_string()))?,
                        )?
                    }
                    "range" if request.sample.is_none() => {
                        let original = request.original_range.ok_or_else(|| {
                            ToolFailure::new("INVALID_INPUT", "range mode requires original_range")
                        })?;
                        let start = request.start_sample.unwrap_or(original.start_sample);
                        if start < original.start_sample {
                            return Err(ToolFailure::new(
                                "INVALID_INPUT",
                                "continuation precedes original_range",
                            ));
                        }
                        let window = self.workbench.edge_window(
                            &request.capture,
                            request.channel,
                            SampleRange {
                                start_sample: start,
                                end_sample: original.end_sample,
                            },
                        )?;
                        serde_json::to_value(
                            sigpilot_analysis::measure::measure_range(&window.window, original)
                                .map_err(|e| ToolFailure::new("INVALID_INPUT", e.to_string()))?,
                        )?
                    }
                    _ => {
                        return Err(ToolFailure::new(
                            "INVALID_INPUT",
                            "invalid measurement mode or incompatible arguments",
                        ))
                    }
                };
                let range = serde_json::from_value(
                    measurement[if request.mode == "point" {
                        "observed_range"
                    } else {
                        "coverage"
                    }]
                    .clone(),
                )?;
                let evidence=self.workbench.record_evidence(&request.capture,vec![sigpilot_workbench::evidence::EvidenceDraft {range,channels:vec![request.channel],
                    provider_id:"sigpilot.measure".into(),provider_version:"1".into(),parameters:json!({"mode":request.mode,"sample":request.sample,"original_range":request.original_range,"start_sample":request.start_sample}),observed:measurement.clone()}])?;
                Ok(
                    json!({"capture":request.capture,"mode":request.mode,"measurement":measurement,"evidence_ref":evidence[0].evidence_ref}),
                )
            }
            "sigpilot_list_annotations" => {
                let request: ListAnnotationsRequest = parse(arguments)?;
                Ok(serde_json::to_value(self.workbench.list_annotations(
                    &request.capture,
                    request.annotation_revision.0,
                    request.after_id.as_deref(),
                    request.limit,
                )?)?)
            }
            "sigpilot_get_reports" => {
                let request: GetReportsRequest = parse(arguments)?;
                if let Some(id) = request.report_id {
                    if request.report_revision.is_some() || request.after_id.is_some() {
                        return Err(ToolFailure::new(
                            "INVALID_INPUT",
                            "finding-page mode forbids list revision/cursor",
                        ));
                    }
                    let start = usize::try_from(request.start_index.unwrap_or(0.into()).0)
                        .map_err(|_| {
                            ToolFailure::new("INVALID_INPUT", "report page index overflow")
                        })?;
                    self.workbench
                        .read_report(&request.capture, &id, start, request.limit)
                        .map_err(Into::into)
                } else {
                    if request.start_index.is_some() {
                        return Err(ToolFailure::new(
                            "INVALID_INPUT",
                            "list mode forbids start_index",
                        ));
                    }
                    let revision = request.report_revision.ok_or_else(|| {
                        ToolFailure::new("INVALID_INPUT", "list mode requires report_revision")
                    })?;
                    self.workbench
                        .list_reports(
                            &request.capture,
                            revision.0,
                            request.after_id.as_deref(),
                            request.limit,
                        )
                        .map_err(Into::into)
                }
            }
            "sigpilot_create_derived_capture" if self.can_edit_annotations => {
                let request: sigpilot_workbench::derived::DerivedRequest = parse(arguments)?;
                // A submitted write finishes independently of request cancellation.
                let write_cancel = AtomicBool::new(false);
                self.workbench
                    .create_derived_capture(
                        &self.caller_id,
                        &request,
                        if request.preview {
                            cancel
                        } else {
                            &write_cancel
                        },
                    )
                    .map_err(Into::into)
            }
            "sigpilot_apply_results" if self.can_edit_annotations => {
                let request: sigpilot_workbench::results::ApplyResultRequest = parse(arguments)?;
                self.workbench
                    .apply_result(
                        Caller {
                            id: &self.caller_id,
                            source: AnnotationSource::Assistant,
                        },
                        &request,
                    )
                    .map_err(Into::into)
            }
            "sigpilot_get_results" => {
                let request: GetResultsRequest = parse(arguments)?;
                if let Some(id) = request.result_set_id {
                    if request.result_revision.is_some() || request.after_id.is_some() {
                        return Err(ToolFailure::new(
                            "INVALID_INPUT",
                            "result read forbids list revision/cursor",
                        ));
                    }
                    if let Some(offset) = request.offset {
                        self.workbench
                            .read_result_chunk(
                                &request.capture,
                                &id,
                                offset.0,
                                request.max_bytes.unwrap_or(16384),
                                cancel,
                            )
                            .map_err(Into::into)
                    } else if request.max_bytes.is_some() {
                        Err(ToolFailure::new(
                            "INVALID_INPUT",
                            "chunk max_bytes requires offset",
                        ))
                    } else {
                        self.workbench
                            .retained_result(&request.capture, &id)
                            .map_err(Into::into)
                    }
                } else {
                    if request.offset.is_some() || request.max_bytes.is_some() {
                        return Err(ToolFailure::new(
                            "INVALID_INPUT",
                            "list mode forbids chunk options",
                        ));
                    }
                    self.workbench
                        .list_results(
                            &request.capture,
                            request
                                .result_revision
                                .ok_or_else(|| {
                                    ToolFailure::new(
                                        "INVALID_INPUT",
                                        "list requires result_revision",
                                    )
                                })?
                                .0,
                            request.after_id.as_deref(),
                            request.limit,
                        )
                        .map_err(Into::into)
                }
            }
            "sigpilot_export_report" => {
                let request: ExportReportRequest = parse(arguments)?;
                self.workbench
                    .export_report(
                        &request.capture,
                        request.report_revision.0,
                        &request.report_id,
                        &request.format,
                        request.offset.0,
                        request.max_bytes,
                        cancel,
                    )
                    .map_err(Into::into)
            }
            "sigpilot_apply_reports" if self.can_edit_annotations => {
                let request: sigpilot_workbench::reports::ApplyReportRequest = parse(arguments)?;
                self.workbench
                    .apply_report(
                        Caller {
                            id: &self.caller_id,
                            source: AnnotationSource::Assistant,
                        },
                        &request,
                    )
                    .map_err(Into::into)
            }
            "sigpilot_apply_annotations" if self.can_edit_annotations => {
                let request: ApplyAnnotationsRequest = parse(arguments)?;
                Ok(serde_json::to_value(self.workbench.apply_annotations(
                    Caller {
                        id: &self.caller_id,
                        source: AnnotationSource::Assistant,
                    },
                    &request,
                )?)?)
            }
            "sigpilot_undo_annotations" if self.can_edit_annotations => {
                let request: sigpilot_workbench::undo::UndoAnnotationsRequest = parse(arguments)?;
                Ok(serde_json::to_value(self.workbench.undo_annotations(
                    Caller {
                        id: &self.caller_id,
                        source: AnnotationSource::Assistant,
                    },
                    &request,
                )?)?)
            }
            "sigpilot_focus_view" => {
                let request: FocusRequest = parse(arguments)?;
                let view =
                    self.workbench
                        .focus_view(&request.capture, request.range, request.channels)?;
                Ok(json!({"capture":request.capture,"view":view}))
            }
            _ => Err(ToolFailure::new(
                "TOOL_NOT_FOUND",
                "unknown or unauthorized tool",
            )),
        }
    }
}

impl ServerHandler for McpAdapter {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().enable_resources().enable_prompts().build())
            .with_server_info(Implementation::new("sigpilot-mcp", env!("CARGO_PKG_VERSION")))
            .with_instructions("Use explicit business session and capture references. Exact integers are decimal strings. Query ranges are half-open. Tool results report coverage; a page is not a full scan. Device acquisition is available only when listed in tools and explicitly allowed by the desktop. Use list_devices and get_device_capabilities before start_capture; start returns a job, poll get_capture_status, and stop/release only your own jobs. Never retry a submitted capture with a new request_id merely because a response was lost.")
    }

    fn get_tool(&self, name: &str) -> Option<Tool> {
        self.tool_catalog()
            .into_iter()
            .find(|tool| tool.name == name)
    }
    async fn list_prompts(
        &self,
        request: Option<PaginatedRequestParams>,
        _: RequestContext<RoleServer>,
    ) -> Result<rmcp::model::ListPromptsResult, ErrorData> {
        if request.as_ref().is_some_and(|r| r.cursor.is_some()) {
            return Err(ErrorData::invalid_params(
                "prompt catalog has no continuation",
                None,
            ));
        }
        Ok(rmcp::model::ListPromptsResult {
            prompts: self.prompt_catalog(),
            ..Default::default()
        })
    }
    async fn get_prompt(
        &self,
        request: rmcp::model::GetPromptRequestParams,
        _: RequestContext<RoleServer>,
    ) -> Result<rmcp::model::GetPromptResponse, ErrorData> {
        self.prompt_result(request).map(Into::into)
    }

    async fn list_resources(
        &self,
        request: Option<PaginatedRequestParams>,
        _: RequestContext<RoleServer>,
    ) -> Result<rmcp::model::ListResourcesResult, ErrorData> {
        if request.as_ref().is_some_and(|r| r.cursor.is_some()) {
            return Err(ErrorData::invalid_params(
                "resource catalog has no continuation cursor",
                None,
            ));
        }
        Ok(rmcp::model::ListResourcesResult {
            resources: self.resource_catalog(),
            ..Default::default()
        })
    }
    async fn list_resource_templates(
        &self,
        request: Option<PaginatedRequestParams>,
        _: RequestContext<RoleServer>,
    ) -> Result<rmcp::model::ListResourceTemplatesResult, ErrorData> {
        if request.as_ref().is_some_and(|r| r.cursor.is_some()) {
            return Err(ErrorData::invalid_params(
                "resource templates have no continuation cursor",
                None,
            ));
        }
        Ok(rmcp::model::ListResourceTemplatesResult {
            resource_templates: self.resource_templates(),
            ..Default::default()
        })
    }
    async fn read_resource(
        &self,
        request: rmcp::model::ReadResourceRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<rmcp::model::ReadResourceResponse, ErrorData> {
        let permit = self
            .budget
            .clone()
            .try_acquire_owned()
            .map_err(|_| ErrorData::internal_error("resource service busy", None))?;
        let adapter = self.clone();
        let uri = request.uri;
        let lookup = uri.clone();
        let value = cancellation::run_blocking(context, move |cancel| {
            let _permit = permit;
            if cancel.load(Ordering::Acquire) {
                return Err(WorkbenchError::Cancelled.into());
            }
            adapter.resolve_resource(&lookup)
        })
        .await
        .map_err(|_| ErrorData::internal_error("resource worker failed", None))?
        .map_err(|e| {
            ErrorData::resource_not_found(
                e.message,
                Some(json!({"code":e.code,"details":e.details})),
            )
        })?;
        let result =
            rmcp::model::ReadResourceResult::new(vec![rmcp::model::ResourceContents::text(
                value.to_string(),
                uri,
            )
            .with_mime_type("application/json")])
            .with_ttl_ms(0)
            .with_cache_scope(rmcp::model::CacheScope::Private);
        if serde_json::to_vec(&result).map_or(true, |b| b.len() > 256 * 1024) {
            return Err(ErrorData::internal_error(
                "resource response exceeds 256 KiB",
                Some(json!({"code":"RESOURCE_LIMIT"})),
            ));
        }
        Ok(result.into())
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        Ok(ListToolsResult {
            tools: self.tool_catalog(),
            ..Default::default()
        })
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        if self.get_tool(&request.name).is_none() {
            return Err(ErrorData::invalid_params(
                "unknown or unauthorized tool",
                None,
            ));
        }
        let arguments = Value::Object(request.arguments.unwrap_or_default());
        if serde_json::to_vec(&arguments).map_or(true, |bytes| bytes.len() > 240 * 1024) {
            return Ok(failure_result(ToolFailure::new(
                "RESOURCE_LIMIT",
                "tool input exceeds 240 KiB",
            ))
            .into());
        }
        // No unbounded blocking-pool queue: one short operation per adapter
        // group, with immediate backpressure when a caller is already running.
        let permit = match self.budget.clone().try_acquire_owned() {
            Ok(permit) => permit,
            Err(_) => {
                return Ok(failure_result(ToolFailure::new(
                    "BUSY",
                    "another operation is running; retry after it completes",
                ))
                .into())
            }
        };
        let adapter = self.clone();
        let result = cancellation::run_blocking(context, move |cancel| {
            let _permit = permit;
            adapter.execute_with_cancel(&request.name, arguments, cancel)
        })
        .await;
        let result = match result {
            Ok(Ok(value))
                if serde_json::to_vec(&value).map_or(false, |bytes| bytes.len() <= 256 * 1024) =>
            {
                let links = resources::links(&value);
                let mut result = CallToolResult::structured(value);
                result.content = vec![ContentBlock::text("SigPilot operation completed; inspect structuredContent for precise values and coverage.")];
                result.content.extend(links);
                if serde_json::to_vec(&result).map_or(true, |b| b.len() > 256 * 1024) {
                    failure_result(ToolFailure::new(
                        "RESOURCE_LIMIT",
                        "encoded tool response exceeds 256 KiB",
                    ))
                } else {
                    result
                }
            }
            Ok(Ok(_)) => failure_result(ToolFailure::new(
                "RESOURCE_LIMIT",
                "tool result exceeds 256 KiB",
            )),
            Ok(Err(error)) => failure_result(error),
            Err(_) => failure_result(ToolFailure::new(
                "INTERNAL_ERROR",
                "operation worker failed",
            )),
        };
        Ok(result.into())
    }
}

fn tool(
    name: &'static str,
    description: &'static str,
    properties: Value,
    required: &[&str],
    readonly: bool,
    idempotent: bool,
) -> Tool {
    let schema = json!({"type":"object","additionalProperties":false,"properties":properties,"required":required});
    Tool::new(name, description, schema.as_object().unwrap().clone())
        .with_raw_output_schema(Arc::new(
            json!({"type":"object"}).as_object().unwrap().clone(),
        ))
        .with_annotations(
            ToolAnnotations::new()
                .read_only(readonly)
                .idempotent(idempotent)
                .destructive(matches!(
                    name,
                    "sigpilot_release_capture"
                        | "sigpilot_apply_annotations"
                        | "sigpilot_apply_reports"
                        | "sigpilot_configure_analyzer"
                        | "sigpilot_apply_results"
                ))
                .open_world(false),
        )
}

#[derive(Debug)]
struct ToolFailure {
    code: &'static str,
    message: String,
    details: BTreeMap<String, Value>,
}
impl ToolFailure {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            details: BTreeMap::new(),
        }
    }
}
impl From<serde_json::Error> for ToolFailure {
    fn from(error: serde_json::Error) -> Self {
        Self::new("INVALID_INPUT", error.to_string())
    }
}
impl From<WorkbenchError> for ToolFailure {
    fn from(error: WorkbenchError) -> Self {
        let code = match &error {
            WorkbenchError::Cancelled => "CANCELLED",
            WorkbenchError::ResultNotFound => "RESULT_NOT_FOUND",
            WorkbenchError::ResultVersionConflict(_) => "VERSION_CONFLICT",
            WorkbenchError::AnalyzerNotFound => "ANALYZER_NOT_FOUND",
            WorkbenchError::ConfigVersionConflict(_) => "VERSION_CONFLICT",
            WorkbenchError::SessionNotFound => "SESSION_NOT_FOUND",
            WorkbenchError::JobNotFound => "JOB_NOT_FOUND",
            WorkbenchError::EvidenceNotFound => "EVIDENCE_NOT_FOUND",
            WorkbenchError::UndoNotFound => "UNDO_NOT_FOUND",
            WorkbenchError::ProviderNotFound => "PROVIDER_NOT_FOUND",
            WorkbenchError::TriggerProfileNotFound => "TRIGGER_PROFILE_NOT_FOUND",
            WorkbenchError::ReportNotFound => "REPORT_NOT_FOUND",
            WorkbenchError::DecoderUnavailable(_) => "DECODER_UNAVAILABLE",
            WorkbenchError::CaptureVersionConflict
            | WorkbenchError::Read(sigpilot_graph::read_api::ReadError::VersionConflict) => {
                "VERSION_CONFLICT"
            }
            WorkbenchError::AnnotationVersionConflict(_) => "VERSION_CONFLICT",
            WorkbenchError::ReportVersionConflict(_) => "VERSION_CONFLICT",
            WorkbenchError::RequestIdConflict => "REQUEST_ID_CONFLICT",
            WorkbenchError::ResourceLimit(_) => "RESOURCE_LIMIT",
            WorkbenchError::UiPrecisionLimit => "UI_PRECISION_LIMIT",
            WorkbenchError::GuiUnavailable => "GUI_UNAVAILABLE",
            WorkbenchError::Read(sigpilot_graph::read_api::ReadError::CaptureNotFinalized) => {
                "CAPTURE_NOT_FINALIZED"
            }
            _ => "INVALID_INPUT",
        };
        let mut result = Self::new(code, error.to_string());
        if let WorkbenchError::ResultVersionConflict(revision) = error {
            result
                .details
                .insert("result_revision".into(), json!(revision.to_string()));
        } else if let WorkbenchError::AnnotationVersionConflict(revision) = error {
            result
                .details
                .insert("annotation_revision".into(), json!(revision.to_string()));
        } else if let WorkbenchError::ReportVersionConflict(revision) = error {
            result
                .details
                .insert("report_revision".into(), json!(revision.to_string()));
        } else if let WorkbenchError::ConfigVersionConflict(revision) = error {
            result
                .details
                .insert("config_revision".into(), json!(revision.to_string()));
        }
        result
    }
}
fn failure_result(error: ToolFailure) -> CallToolResult {
    CallToolResult::structured_error(
        json!({"error":{"code":error.code,"message":error.message,"details":error.details}}),
    )
}
fn parse<T: serde::de::DeserializeOwned>(value: Value) -> Result<T, ToolFailure> {
    Ok(serde_json::from_value(value)?)
}
fn file_error(error: sigpilot_file::FileError) -> ToolFailure {
    let code = if matches!(error, sigpilot_file::FileError::ImportBudgetExceeded) {
        "RESOURCE_LIMIT"
    } else {
        "FILE_ERROR"
    };
    ToolFailure::new(code, error.to_string())
}
fn default_limit() -> usize {
    100
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ContextRequest {
    session_id: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct OpenRequest {
    session_id: String,
    path: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EmptyRequest {}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PulseRequest {
    capture: CaptureRef,
    provider_id: String,
    channel: u8,
    original_range: SampleRange,
    start_sample: ExactU64,
    parameters: Option<Value>,
    high: Option<bool>,
    min_width_samples: Option<ExactU64>,
    max_width_exclusive: Option<ExactU64>,
    limit: Option<usize>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EdgeRequest {
    capture: CaptureRef,
    channel: u8,
    range: SampleRange,
    direction: Option<EdgeDirection>,
    #[serde(default = "default_limit")]
    limit: usize,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ListAnnotationsRequest {
    capture: CaptureRef,
    annotation_revision: ExactU64,
    after_id: Option<String>,
    #[serde(default = "default_limit")]
    limit: usize,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FocusRequest {
    capture: CaptureRef,
    range: SampleRange,
    #[serde(default)]
    channels: Vec<u8>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct MeasureRequest {
    capture: CaptureRef,
    channel: u8,
    mode: String,
    sample: Option<ExactU64>,
    original_range: Option<SampleRange>,
    start_sample: Option<ExactU64>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DecodeRequest {
    capture: CaptureRef,
    range: SampleRange,
    config: Option<sigpilot_workbench::decode::DecodeConfig>,
    analyzer_id: Option<String>,
    expected_config_revision: Option<ExactU64>,
    request_id: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AnalyzersRequest {
    capture: CaptureRef,
    config_revision: ExactU64,
    after_id: Option<String>,
    #[serde(default = "analyzer_limit")]
    limit: usize,
}
fn analyzer_limit() -> usize {
    20
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FramesRequest {
    result_set_id: String,
    #[serde(default)]
    query: sigpilot_analysis::frames::FrameQuery,
    cursor: Option<String>,
    #[serde(default = "default_limit")]
    limit: usize,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct JobRequest {
    job_id: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SequenceRequest {
    result_set_id: String,
    query: sigpilot_analysis::protocol::FrameSequenceQuery,
    cursor: Option<String>,
    #[serde(default = "default_limit")]
    limit: usize,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TransactionsRequest {
    result_set_id: String,
    #[serde(default)]
    query: sigpilot_analysis::protocol::TransactionQuery,
    cursor: Option<String>,
    #[serde(default = "default_limit")]
    limit: usize,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CorrelationRequest {
    result_set_id: String,
    channel: u8,
    query: sigpilot_analysis::correlation::CorrelationQuery,
    start_sample: ExactU64,
    cursor: Option<String>,
    #[serde(default = "default_limit")]
    limit: usize,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ValidateTriggerRequest {
    capture: CaptureRef,
    rule: sigpilot_analysis::trigger::TriggerRule,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CompileTriggerRequest {
    target: sigpilot_analysis::hardware_trigger::HardwareTriggerTarget,
    rule: sigpilot_analysis::trigger::TriggerRule,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct GetReportsRequest {
    capture: CaptureRef,
    #[serde(default)]
    report_revision: Option<ExactU64>,
    #[serde(default)]
    after_id: Option<String>,
    #[serde(default)]
    report_id: Option<String>,
    #[serde(default)]
    start_index: Option<ExactU64>,
    #[serde(default = "report_page_limit")]
    limit: usize,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ExportReportRequest {
    capture: CaptureRef,
    report_revision: ExactU64,
    report_id: String,
    format: String,
    #[serde(default)]
    offset: ExactU64,
    #[serde(default = "report_export_chunk")]
    max_bytes: usize,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct GetResultsRequest {
    capture: CaptureRef,
    result_revision: Option<ExactU64>,
    after_id: Option<String>,
    result_set_id: Option<String>,
    offset: Option<ExactU64>,
    max_bytes: Option<usize>,
    #[serde(default = "result_list_limit")]
    limit: usize,
}
fn result_list_limit() -> usize {
    16
}
fn report_export_chunk() -> usize {
    16384
}
fn report_page_limit() -> usize {
    20
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SimulateTriggerRequest {
    capture: CaptureRef,
    range: SampleRange,
    rule: sigpilot_analysis::trigger::TriggerRule,
    request_id: String,
    #[serde(default = "default_limit")]
    limit: usize,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EvidenceRequest {
    capture: CaptureRef,
    refs: Vec<String>,
    context_samples: Option<ExactU64>,
}
