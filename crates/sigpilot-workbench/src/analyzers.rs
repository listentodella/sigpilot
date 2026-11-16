//! Shared semantic analyzer configuration. GUI adapters may preserve existing
//! native/HLA metadata; MCP edits only typed, nonexecutable protocol settings.
use crate::{
    decode::DecodeConfig, Caller, CaptureRef, Document, Result, WorkbenchError, WorkbenchEvent,
    WorkbenchService,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sigpilot_analysis::ExactU64;
use sigpilot_file::SaleaeAnalyzerMetadata;
use std::{collections::BTreeSet, time::Instant};

const MAX_ANALYZERS: usize = 64;
const MAX_INSTANCE_BYTES: usize = 16 * 1024;
const MAX_DOCUMENT_BYTES: usize = 192 * 1024;
const MAX_REPLAY_BYTES: usize = 256 * 1024;
const PAGE_BYTES: usize = 112 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct AnalyzerInstance {
    pub schema_version: String,
    pub id: String,
    pub source: crate::AnnotationSource,
    pub author_id: String,
    pub metadata: SaleaeAnalyzerMetadata,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
pub enum AnalyzerOperation {
    Create {
        #[serde(default)]
        id: Option<String>,
        name: String,
        config: DecodeConfig,
    },
    Update {
        id: String,
        name: String,
        config: DecodeConfig,
    },
    Delete {
        id: String,
    },
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConfigureAnalyzerRequest {
    pub capture: CaptureRef,
    pub expected_config_revision: ExactU64,
    pub request_id: String,
    #[serde(default)]
    pub preview: bool,
    pub operation: AnalyzerOperation,
}
/// Local GUI's full semantic list, including ordering and legacy metadata.
/// Only the Tauri adapter may expose this operation; it is not an MCP tool.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReplaceAnalyzersRequest {
    pub capture: CaptureRef,
    pub expected_config_revision: ExactU64,
    pub request_id: String,
    pub analyzers: Vec<SaleaeAnalyzerMetadata>,
}
pub(crate) struct Replay {
    owner: String,
    id: String,
    input: String,
    output: Value,
    bytes: usize,
    created: Instant,
}
fn invalid(message: &str) -> WorkbenchError {
    WorkbenchError::InvalidRequest(message.into())
}
fn metadata_id(metadata: &SaleaeAnalyzerMetadata) -> Option<&str> {
    metadata
        .saleae_metadata
        .get("uiAnalyzerId")
        .and_then(Value::as_str)
}
fn bind_id(metadata: &mut SaleaeAnalyzerMetadata, id: &str) -> Result<()> {
    if metadata.saleae_metadata.is_null() {
        metadata.saleae_metadata = json!({});
    }
    let object = metadata
        .saleae_metadata
        .as_object_mut()
        .ok_or_else(|| invalid("analyzer metadata must be an object or null"))?;
    object.insert("uiAnalyzerId".into(), json!(id));
    Ok(())
}
fn validate(instance: &AnalyzerInstance) -> Result<()> {
    crate::validate_id(&instance.id)?;
    crate::validate_id(&instance.author_id)?;
    let metadata = &instance.metadata;
    if instance.schema_version != "1"
        || metadata_id(metadata) != Some(instance.id.as_str())
        || metadata.name.trim().is_empty()
        || metadata.name.len() > 640
        || metadata.analyzer_type.is_empty()
        || metadata.analyzer_type.len() > 128
        || metadata.color.len() > 64
        || metadata.display_radix.len() > 64
        || serde_json::to_vec(instance)?.len() > MAX_INSTANCE_BYTES
    {
        return Err(invalid(
            "invalid analyzer identity, metadata or 16 KiB budget",
        ));
    }
    Ok(())
}
fn validate_list(instances: &[AnalyzerInstance]) -> Result<()> {
    if instances.len() > MAX_ANALYZERS || serde_json::to_vec(instances)?.len() > MAX_DOCUMENT_BYTES
    {
        return Err(WorkbenchError::ResourceLimit(
            "analyzer document exceeds 64 instances / 192 KiB",
        ));
    }
    let mut ids = BTreeSet::new();
    for instance in instances {
        validate(instance)?;
        if !ids.insert(&instance.id) {
            return Err(invalid("duplicate analyzer ID"));
        }
    }
    Ok(())
}
pub(crate) fn restore(
    metadata: &sigpilot_file::SaleaeSessionMetadata,
) -> Result<Vec<AnalyzerInstance>> {
    let instances = if metadata.workbench_analyzers.is_empty() {
        metadata
            .analyzers
            .iter()
            .enumerate()
            .map(|(index, metadata)| {
                let mut metadata = metadata.clone();
                let id = metadata_id(&metadata)
                    .map(str::to_owned)
                    .unwrap_or_else(|| format!("imported-analyzer-{index}"));
                bind_id(&mut metadata, &id)?;
                Ok(AnalyzerInstance {
                    schema_version: "1".into(),
                    id,
                    source: crate::AnnotationSource::User,
                    author_id: "project-import".into(),
                    metadata,
                })
            })
            .collect::<Result<Vec<_>>>()?
    } else {
        metadata
            .workbench_analyzers
            .iter()
            .map(|v| serde_json::from_value(v.clone()).map_err(Into::into))
            .collect::<Result<Vec<_>>>()?
    };
    validate_list(&instances)?;
    Ok(instances)
}
pub(crate) fn populate(
    metadata: &mut sigpilot_file::SaleaeSessionMetadata,
    instances: &[AnalyzerInstance],
) -> Result<()> {
    validate_list(instances)?;
    metadata.analyzers = instances.iter().map(|a| a.metadata.clone()).collect();
    metadata.workbench_analyzers = instances
        .iter()
        .map(serde_json::to_value)
        .collect::<std::result::Result<_, _>>()?;
    Ok(())
}
/// A capture may be saved before the GUI's initial preset migration arrives.
/// Preserve those incoming GUI settings only until the shared list becomes
/// authoritative, including an intentionally empty list after deletion.
pub(crate) fn project_instances(
    document: &Document,
    metadata: &sigpilot_file::SaleaeSessionMetadata,
) -> Result<Vec<AnalyzerInstance>> {
    if document.analyzers_initialized {
        Ok(document.analyzers.clone())
    } else {
        let legacy = sigpilot_file::SaleaeSessionMetadata {
            analyzers: metadata.analyzers.clone(),
            ..Default::default()
        };
        restore(&legacy)
    }
}
fn prune_replay(document: &mut Document) {
    while document
        .analyzer_replay
        .front()
        .is_some_and(|r| r.created.elapsed().as_secs() >= 900)
    {
        document.analyzer_replay.pop_front();
    }
}
fn replay(document: &mut Document, owner: &str, id: &str, input: &str) -> Result<Option<Value>> {
    prune_replay(document);
    if let Some(record) = document
        .analyzer_replay
        .iter()
        .find(|r| r.owner == owner && r.id == id)
    {
        if record.input != input {
            return Err(WorkbenchError::RequestIdConflict);
        }
        return Ok(Some(record.output.clone()));
    }
    Ok(None)
}
fn retain(document: &mut Document, owner: &str, id: &str, input: String, output: Value) {
    let bytes = input.len() + output.to_string().len();
    if bytes > MAX_REPLAY_BYTES {
        return;
    }
    prune_replay(document);
    while document.analyzer_replay.len() >= 128
        || document
            .analyzer_replay
            .iter()
            .map(|r| r.bytes)
            .sum::<usize>()
            + bytes
            > MAX_REPLAY_BYTES
    {
        document.analyzer_replay.pop_front();
    }
    document.analyzer_replay.push_back(Replay {
        owner: owner.into(),
        id: id.into(),
        input,
        output,
        bytes,
        created: Instant::now(),
    });
}
pub fn typed_config(metadata: &SaleaeAnalyzerMetadata) -> Option<DecodeConfig> {
    match metadata.decode_settings.as_ref()? {
        sigpilot_core::AnalyzerDecodeSettings::Uart(s) => {
            Some(DecodeConfig::Uart(crate::decode::UartConfig {
                channel: s.channel,
                baud_rate: (s.baud_rate as u64).into(),
                inverted: s.inverted,
                data_bits: s.data_bits,
                stop_bits: match s.stop_bits {
                    sigpilot_core::UartStopBits::One => "1",
                    sigpilot_core::UartStopBits::OnePointFive => "1.5",
                    sigpilot_core::UartStopBits::Two => "2",
                }
                .into(),
                parity: s.parity,
                msb_first: s.msb_first,
            }))
        }
        sigpilot_core::AnalyzerDecodeSettings::I2c(s) => {
            Some(DecodeConfig::I2c(crate::decode::I2cConfig {
                sda_channel: s.sda_channel,
                scl_channel: s.scl_channel,
            }))
        }
        sigpilot_core::AnalyzerDecodeSettings::Spi(s) => {
            Some(DecodeConfig::Spi(crate::decode::SpiConfig {
                mosi_channel: s.mosi_channel,
                miso_channel: s.miso_channel,
                clock_channel: s.clock_channel,
                enable_channel: s.enable_channel,
                enable_active_low: s.enable_active_low,
                clock_polarity: s.clock_polarity,
                clock_phase: s.clock_phase,
                bits_per_transfer: s.bits_per_transfer,
                msb_first: s.msb_first,
            }))
        }
        _ => None,
    }
}
fn view(instance: &AnalyzerInstance) -> Value {
    let config = typed_config(&instance.metadata);
    let runnable = config.is_some()
        && instance.metadata.decoder_backend == sigpilot_core::DecoderBackendKind::SaleaeNative;
    json!({"id":instance.id,"name":instance.metadata.name,"type":instance.metadata.analyzer_type,"source":instance.source,"author_id":instance.author_id,
        "decoder_backend":instance.metadata.decoder_backend,"config":config,"mcp_edit_supported":config.is_some(),"mcp_run_supported":runnable,
        "run_status":if runnable {"configured_not_probed"}else{"backend_or_settings_unsupported"}})
}

impl WorkbenchService {
    pub fn analyzer_capabilities(&self) -> Value {
        json!({"schema_version":"1","model":"shared_instances","mcp_edit_protocols":["UART","I2C","SPI"],"mcp_run_backend":"saleae_native","max_instances":64,"max_document_bytes":"196608",
            "config_revision":"independent_of_annotations_and_capture_data","persistence":"pxl_project_save","file_write":false,"replay_retention_seconds":"900"})
    }
    pub fn get_analyzers(
        &self,
        capture: &CaptureRef,
        expected: ExactU64,
        after: Option<&str>,
        limit: usize,
    ) -> Result<Value> {
        if limit == 0 || limit > 64 {
            return Err(invalid("analyzer page limit must be 1..64"));
        }
        let session = self.existing_session(&capture.session_id)?;
        let lease = self.lease(&session, capture)?;
        let mut document = session.document.lock();
        crate::synchronize(&mut document, lease.snapshot().capture_generation);
        if document.config_revision != expected.0 {
            return Err(WorkbenchError::ConfigVersionConflict(
                document.config_revision,
            ));
        }
        let start = match after {
            None => 0,
            Some(id) => {
                document
                    .analyzers
                    .iter()
                    .position(|a| a.id == id)
                    .ok_or_else(|| invalid("unknown analyzer cursor ID"))?
                    + 1
            }
        };
        let mut items = Vec::new();
        let mut bytes = 0;
        for instance in &document.analyzers[start..] {
            let item = view(instance);
            let size = serde_json::to_vec(&item)?.len();
            if items.len() == limit || bytes + size > PAGE_BYTES {
                break;
            }
            bytes += size;
            items.push(item);
        }
        let complete = start + items.len() == document.analyzers.len();
        Ok(
            json!({"capture":capture,"config_revision":document.config_revision.to_string(),"items":items,"complete":complete,
            "next_after_id":if complete {None}else{items.last().and_then(|v|v["id"].as_str())}}),
        )
    }
    pub fn configure_analyzer(
        &self,
        caller: Caller<'_>,
        request: &ConfigureAnalyzerRequest,
    ) -> Result<Value> {
        crate::validate_id(caller.id)?;
        crate::validate_id(&request.request_id)?;
        let input = serde_json::to_string(request)?;
        if input.len() > 16 * 1024 {
            return Err(WorkbenchError::ResourceLimit(
                "analyzer edit exceeds 16 KiB",
            ));
        }
        let session = self.existing_session(&request.capture.session_id)?;
        let _operation = session.operation.lock();
        let lease = self.lease(&session, &request.capture)?;
        let mut document = session.document.lock();
        crate::synchronize(&mut document, lease.snapshot().capture_generation);
        if !request.preview {
            if let Some(output) = replay(&mut document, caller.id, &request.request_id, &input)? {
                return Ok(output);
            }
        }
        if document.config_revision != request.expected_config_revision.0 {
            return Err(WorkbenchError::ConfigVersionConflict(
                document.config_revision,
            ));
        }
        let mut next = document.analyzers.clone();
        match &request.operation {
            AnalyzerOperation::Delete { id } => {
                let index = next
                    .iter()
                    .position(|a| a.id == *id)
                    .ok_or(WorkbenchError::AnalyzerNotFound)?;
                next.remove(index);
            }
            AnalyzerOperation::Create { id, name, config } => {
                validate_config(config, lease.snapshot())?;
                let id = id.clone().unwrap_or_else(|| {
                    if request.preview {
                        "preview-analyzer".into()
                    } else {
                        format!("analyzer-{}", uuid::Uuid::new_v4().simple())
                    }
                });
                let metadata = SaleaeAnalyzerMetadata {
                    analyzer_type: match config {
                        DecodeConfig::Uart(_) => "Async Serial",
                        DecodeConfig::I2c(_) => "I2C",
                        DecodeConfig::Spi(_) => "SPI",
                    }
                    .into(),
                    name: name.clone(),
                    color: "#4b97d2".into(),
                    display_radix: "Hexadecimal".into(),
                    show_in_data_table: true,
                    stream_to_terminal: false,
                    decoder_backend: sigpilot_core::DecoderBackendKind::SaleaeNative,
                    decode_settings: Some(config.settings()?),
                    saleae_metadata: json!({"uiAnalyzerId":id}),
                };
                next.push(AnalyzerInstance {
                    schema_version: "1".into(),
                    id,
                    source: caller.source,
                    author_id: caller.id.into(),
                    metadata,
                });
            }
            AnalyzerOperation::Update { id, name, config } => {
                validate_config(config, lease.snapshot())?;
                let instance = next
                    .iter_mut()
                    .find(|a| a.id == *id)
                    .ok_or(WorkbenchError::AnalyzerNotFound)?;
                if typed_config(&instance.metadata).is_none() {
                    return Err(invalid(
                        "MCP cannot replace native/HLA or unconfigured settings",
                    ));
                }
                if instance
                    .metadata
                    .decode_settings
                    .as_ref()
                    .map(std::mem::discriminant)
                    != Some(std::mem::discriminant(&config.settings()?))
                {
                    return Err(invalid("protocol replacement requires a new instance"));
                }
                instance.metadata.name = name.clone();
                instance.metadata.decode_settings = Some(config.settings()?);
            }
        }
        validate_list(&next)?;
        let revision = if request.preview || next == document.analyzers {
            document.config_revision
        } else {
            document
                .config_revision
                .checked_add(1)
                .ok_or_else(|| invalid("configuration revision overflow"))?
        };
        let output = json!({"capture":request.capture,"config_revision":revision.to_string(),"request_id":request.request_id,"preview":request.preview,"items":next.iter().map(view).collect::<Vec<_>>()});
        if !request.preview {
            document.analyzers = next;
            document.config_revision = revision;
            document.analyzers_initialized = true;
            retain(
                &mut document,
                caller.id,
                &request.request_id,
                input,
                output.clone(),
            );
        }
        drop(document);
        drop(lease);
        drop(_operation);
        if !request.preview && revision != request.expected_config_revision.0 {
            self.publish(WorkbenchEvent::AnalyzersChanged {
                capture: request.capture.clone(),
                config_revision: revision.into(),
            });
        }
        Ok(output)
    }
    pub fn replace_analyzers(
        &self,
        caller: Caller<'_>,
        request: &ReplaceAnalyzersRequest,
    ) -> Result<Value> {
        crate::validate_id(caller.id)?;
        crate::validate_id(&request.request_id)?;
        let input = serde_json::to_string(request)?;
        if input.len() > MAX_DOCUMENT_BYTES {
            return Err(WorkbenchError::ResourceLimit(
                "GUI analyzer edit exceeds 192 KiB",
            ));
        }
        let session = self.existing_session(&request.capture.session_id)?;
        let _operation = session.operation.lock();
        let lease = self.lease(&session, &request.capture)?;
        let mut document = session.document.lock();
        crate::synchronize(&mut document, lease.snapshot().capture_generation);
        if let Some(output) = replay(&mut document, caller.id, &request.request_id, &input)? {
            return Ok(output);
        }
        if document.config_revision != request.expected_config_revision.0 {
            return Err(WorkbenchError::ConfigVersionConflict(
                document.config_revision,
            ));
        }
        let next = request
            .analyzers
            .iter()
            .map(|metadata| {
                let id = metadata_id(metadata)
                    .ok_or_else(|| invalid("GUI analyzer requires stable uiAnalyzerId"))?
                    .to_string();
                let previous = document.analyzers.iter().find(|a| a.id == id);
                Ok(AnalyzerInstance {
                    schema_version: "1".into(),
                    id,
                    source: previous.map_or(caller.source, |a| a.source),
                    author_id: previous.map_or_else(|| caller.id.into(), |a| a.author_id.clone()),
                    metadata: metadata.clone(),
                })
            })
            .collect::<Result<Vec<_>>>()?;
        validate_list(&next)?;
        let changed = next != document.analyzers || !document.analyzers_initialized;
        if changed {
            document.config_revision = document
                .config_revision
                .checked_add(1)
                .ok_or_else(|| invalid("configuration revision overflow"))?;
            document.analyzers = next;
        }
        document.analyzers_initialized = true;
        let revision = document.config_revision;
        let output = json!({"capture":request.capture,"config_revision":revision.to_string(),"request_id":request.request_id});
        retain(
            &mut document,
            caller.id,
            &request.request_id,
            input,
            output.clone(),
        );
        drop(document);
        drop(lease);
        drop(_operation);
        if changed {
            self.publish(WorkbenchEvent::AnalyzersChanged {
                capture: request.capture.clone(),
                config_revision: revision.into(),
            });
        }
        Ok(output)
    }
    pub fn analyzer_config(
        &self,
        capture: &CaptureRef,
        expected: ExactU64,
        id: &str,
    ) -> Result<DecodeConfig> {
        let session = self.existing_session(&capture.session_id)?;
        let lease = self.lease(&session, capture)?;
        let mut document = session.document.lock();
        crate::synchronize(&mut document, lease.snapshot().capture_generation);
        if document.config_revision != expected.0 {
            return Err(WorkbenchError::ConfigVersionConflict(
                document.config_revision,
            ));
        }
        let instance = document
            .analyzers
            .iter()
            .find(|a| a.id == id)
            .ok_or(WorkbenchError::AnalyzerNotFound)?;
        if instance.metadata.decoder_backend != sigpilot_core::DecoderBackendKind::SaleaeNative {
            return Err(invalid(
                "instance backend is not supported by MCP supervised decoding",
            ));
        }
        typed_config(&instance.metadata).ok_or_else(|| {
            invalid("instance settings are not supported by MCP supervised decoding")
        })
    }
}
fn validate_config(
    config: &DecodeConfig,
    snapshot: &sigpilot_graph::GraphCaptureSnapshot,
) -> Result<()> {
    config.settings()?;
    if config
        .channels()?
        .iter()
        .any(|c| !crate::valid_channel(snapshot, *c))
    {
        return Err(invalid("analyzer uses unavailable captured channel"));
    }
    if let DecodeConfig::Uart(s) = config {
        if s.baud_rate.0 > snapshot.metadata.sample_rate_hz {
            return Err(invalid("UART baud exceeds capture sampling rate"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn caller() -> Caller<'static> {
        Caller {
            id: "owner",
            source: crate::AnnotationSource::Assistant,
        }
    }
    fn config() -> DecodeConfig {
        serde_json::from_value(
            json!({"protocol":"UART","settings":{"channel":0,"baud_rate":"100000"}}),
        )
        .unwrap()
    }
    fn create(capture: CaptureRef) -> ConfigureAnalyzerRequest {
        ConfigureAnalyzerRequest {
            capture,
            expected_config_revision: 0.into(),
            request_id: "create".into(),
            preview: false,
            operation: AnalyzerOperation::Create {
                id: Some("uart".into()),
                name: "UART bus".into(),
                config: config(),
            },
        }
    }
    #[test]
    fn configuration_is_shared_cas_preview_and_replay_preserve_provenance() {
        let service = crate::tests::service();
        let capture = service.context("session-a").unwrap().capture;
        let events = service.subscribe().unwrap();
        let mut request = create(capture.clone());
        request.preview = true;
        assert_eq!(
            service.configure_analyzer(caller(), &request).unwrap()["config_revision"],
            "0"
        );
        assert!(service
            .gui_snapshot("session-a")
            .unwrap()
            .analyzers
            .is_empty());
        assert!(events.try_recv().is_err());
        request.preview = false;
        let result = service.configure_analyzer(caller(), &request).unwrap();
        assert_eq!(result["config_revision"], "1");
        assert_eq!(
            service.configure_analyzer(caller(), &request).unwrap(),
            result
        );
        let snapshot = service.gui_snapshot("session-a").unwrap();
        assert_eq!(snapshot.context.annotation_revision.0, 0);
        assert_eq!(snapshot.context.config_revision.0, 1);
        assert_eq!(
            snapshot.analyzers[0].source,
            crate::AnnotationSource::Assistant
        );
        let mut metadata = snapshot.analyzers[0].metadata.clone();
        metadata.name = "GUI renamed".into();
        let edit = ReplaceAnalyzersRequest {
            capture: capture.clone(),
            expected_config_revision: 1.into(),
            request_id: "gui".into(),
            analyzers: vec![metadata],
        };
        service
            .replace_analyzers(
                Caller {
                    id: "desktop-user",
                    source: crate::AnnotationSource::User,
                },
                &edit,
            )
            .unwrap();
        let updated = service.gui_snapshot("session-a").unwrap();
        assert_eq!(updated.analyzers[0].author_id, "owner");
        assert_eq!(updated.context.config_revision.0, 2);
        let mut stale = edit.clone();
        stale.request_id = "stale".into();
        assert!(matches!(
            service.replace_analyzers(caller(), &stale),
            Err(WorkbenchError::ConfigVersionConflict(2))
        ));
        assert!(matches!(
            service.get_analyzers(&capture, 1.into(), None, 1),
            Err(WorkbenchError::ConfigVersionConflict(2))
        ));
        assert_eq!(
            service.get_analyzers(&capture, 2.into(), None, 1).unwrap()["items"][0]["name"],
            "GUI renamed"
        );
        let mut different = request.clone();
        different.operation = AnalyzerOperation::Delete { id: "uart".into() };
        assert!(matches!(
            service.configure_analyzer(caller(), &different),
            Err(WorkbenchError::RequestIdConflict)
        ));
    }
    #[test]
    fn save_reopen_and_trim_preserve_ids_settings_and_legacy_native_metadata() {
        let service = crate::tests::service();
        let capture = service.context("session-a").unwrap().capture;
        service
            .configure_analyzer(caller(), &create(capture.clone()))
            .unwrap();
        let path =
            std::env::temp_dir().join(format!("sigpilot-analyzer-{}.pxl", uuid::Uuid::new_v4()));
        let stale_metadata = sigpilot_file::SaleaeSessionMetadata {
            analyzers: vec![],
            ..Default::default()
        };
        service
            .save_project("session-a", &path, stale_metadata)
            .unwrap();
        let saved = sigpilot_file::open_pxl_bounded(&path, 1024 * 1024).unwrap();
        assert_eq!(saved.session.analyzers.len(), 1);
        let restored = WorkbenchService::default();
        let new = restored.import_capture("reopened", saved.capture).unwrap();
        restored
            .restore_annotations("reopened", &saved.session)
            .unwrap();
        assert_eq!(
            restored.gui_snapshot("reopened").unwrap().analyzers[0].id,
            "uart"
        );
        assert_eq!(
            restored.gui_snapshot("reopened").unwrap().analyzers[0].source,
            crate::AnnotationSource::Assistant
        );
        assert_ne!(new.capture, capture);
        restored.trim_capture("reopened", 1, 10).unwrap();
        assert_eq!(
            restored.gui_snapshot("reopened").unwrap().analyzers[0].id,
            "uart"
        );
        let mut legacy = saved.session.clone();
        legacy.workbench_analyzers.clear();
        legacy.analyzers[0].decode_settings = None;
        legacy.analyzers[0].saleae_metadata =
            json!({"uiAnalyzerId":"native","future":{"option":"kept"}});
        let old = restore(&legacy).unwrap();
        assert_eq!(old[0].metadata.saleae_metadata["future"]["option"], "kept");
        assert!(typed_config(&old[0].metadata).is_none());
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn invalid_edits_and_oversized_or_duplicate_imports_are_atomic() {
        let service = crate::tests::service();
        let capture = service.context("session-a").unwrap().capture;
        let mut request = create(capture.clone());
        if let AnalyzerOperation::Create {
            config: DecodeConfig::Uart(s),
            ..
        } = &mut request.operation
        {
            s.channel = 31;
        }
        assert!(service.configure_analyzer(caller(), &request).is_err());
        assert!(service
            .gui_snapshot("session-a")
            .unwrap()
            .analyzers
            .is_empty());
        let source = create(capture.clone());
        service.configure_analyzer(caller(), &source).unwrap();
        let metadata = service
            .project_metadata(&capture, Default::default())
            .unwrap();
        let mut duplicate = metadata.clone();
        duplicate
            .workbench_analyzers
            .push(duplicate.workbench_analyzers[0].clone());
        assert!(restore(&duplicate).is_err());
        let mut oversized = metadata.clone();
        oversized.workbench_analyzers[0]["metadata"]["saleae_metadata"]["extra"] =
            json!("x".repeat(16 * 1024));
        assert!(restore(&oversized).is_err());
        let mut update = create(capture);
        update.expected_config_revision = 1.into();
        update.request_id = "update".into();
        update.operation = AnalyzerOperation::Update {
            id: "uart".into(),
            name: "protocol swap".into(),
            config: DecodeConfig::I2c(crate::decode::I2cConfig {
                sda_channel: 0,
                scl_channel: 1,
            }),
        };
        assert!(service.configure_analyzer(caller(), &update).is_err());
        assert_eq!(service.context("session-a").unwrap().config_revision.0, 1);
    }
    #[test]
    fn typed_gui_backend_settings_can_be_edited_without_changing_the_backend() {
        let service = crate::tests::service();
        let capture = service.context("session-a").unwrap().capture;
        service
            .configure_analyzer(caller(), &create(capture.clone()))
            .unwrap();
        let mut metadata = service.gui_snapshot("session-a").unwrap().analyzers[0]
            .metadata
            .clone();
        metadata.decoder_backend = sigpilot_core::DecoderBackendKind::SigrokNative;
        service
            .replace_analyzers(
                caller(),
                &ReplaceAnalyzersRequest {
                    capture: capture.clone(),
                    expected_config_revision: 1.into(),
                    request_id: "gui-backend".into(),
                    analyzers: vec![metadata],
                },
            )
            .unwrap();
        let mut changed = config();
        if let DecodeConfig::Uart(s) = &mut changed {
            s.baud_rate = 9600.into();
        }
        service
            .configure_analyzer(
                caller(),
                &ConfigureAnalyzerRequest {
                    capture: capture.clone(),
                    expected_config_revision: 2.into(),
                    request_id: "edit-sigrok".into(),
                    preview: false,
                    operation: AnalyzerOperation::Update {
                        id: "uart".into(),
                        name: "Updated UART".into(),
                        config: changed,
                    },
                },
            )
            .unwrap();
        let page = service.get_analyzers(&capture, 3.into(), None, 1).unwrap();
        assert_eq!(page["items"][0]["decoder_backend"], "sigrok_native");
        assert_eq!(page["items"][0]["mcp_edit_supported"], true);
        assert_eq!(page["items"][0]["mcp_run_supported"], false);
        assert!(service.analyzer_config(&capture, 3.into(), "uart").is_err());
    }
    #[test]
    fn save_before_preset_migration_preserves_presets_but_authoritative_deletion_wins() {
        let service = crate::tests::service();
        let capture = service.context("session-a").unwrap().capture;
        let populated = crate::tests::service();
        populated
            .configure_analyzer(
                caller(),
                &create(populated.context("session-a").unwrap().capture),
            )
            .unwrap();
        let incoming = populated
            .project_metadata(
                &populated.context("session-a").unwrap().capture,
                Default::default(),
            )
            .unwrap();
        let path =
            std::env::temp_dir().join(format!("sigpilot-preset-{}.pxl", uuid::Uuid::new_v4()));
        let projected = service
            .project_metadata(&capture, incoming.clone())
            .unwrap();
        assert_eq!(projected.analyzers.len(), 1);
        service
            .save_project("session-a", &path, incoming.clone())
            .unwrap();
        let saved = sigpilot_file::open_pxl_bounded(&path, 1024 * 1024).unwrap();
        assert_eq!(saved.session.analyzers.len(), 1);
        assert_eq!(saved.session.workbench_analyzers[0]["id"], "uart");
        assert!(!service.context("session-a").unwrap().analyzers_initialized);
        service
            .replace_analyzers(
                caller(),
                &ReplaceAnalyzersRequest {
                    capture: capture.clone(),
                    expected_config_revision: 0.into(),
                    request_id: "empty-authoritative".into(),
                    analyzers: vec![],
                },
            )
            .unwrap();
        assert!(service
            .project_metadata(&capture, incoming.clone())
            .unwrap()
            .analyzers
            .is_empty());
        service.save_project("session-a", &path, incoming).unwrap();
        assert!(sigpilot_file::open_pxl_bounded(&path, 1024 * 1024)
            .unwrap()
            .session
            .analyzers
            .is_empty());
        std::fs::remove_file(path).unwrap();
    }
}
