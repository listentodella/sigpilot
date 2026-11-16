//! Explicit original-to-derived digital filtering. One pass over original
//! complete pulses; no cascading decisions, deleted samples, or source writes.
use crate::{CaptureRef, Result, WorkbenchError, WorkbenchService};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sigpilot_analysis::{ExactU64, SampleRange};
use sigpilot_core::{SparseCaptureData, SparseDigitalChannel};
use std::{
    collections::BTreeSet,
    sync::atomic::{AtomicBool, Ordering},
};
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DerivedRequest {
    pub capture: CaptureRef,
    pub target_session_id: String,
    pub channels: Vec<u8>,
    pub max_width_exclusive: ExactU64,
    pub high: Option<bool>,
    pub request_id: String,
    #[serde(default)]
    pub preview: bool,
}
impl WorkbenchService {
    pub fn derived_capabilities(&self) -> Value {
        json!({"schema_version":"1","algorithm":"replace_complete_original_pulses","maximum_edges":"65536","maximum_filtered_channels":8,
        "mapping":"identity_sample_axis","cascade":false,"source_mutation":false,"persistence":"pxl_project_save"})
    }
    pub fn create_derived_capture(
        &self,
        owner: &str,
        request: &DerivedRequest,
        cancel: &AtomicBool,
    ) -> Result<Value> {
        crate::validate_id(owner)?;
        crate::validate_id(&request.request_id)?;
        crate::validate_id(&request.target_session_id)?;
        if request.channels.is_empty()
            || request.channels.len() > 8
            || request.channels.iter().collect::<BTreeSet<_>>().len() != request.channels.len()
            || request.max_width_exclusive.0 <= 1
            || request.target_session_id == request.capture.session_id
        {
            return Err(WorkbenchError::InvalidRequest("derived filter requires 1..8 distinct captured channels, exclusive width >1 and a separate target session".into()));
        }
        let input = serde_json::to_string(request)?;
        // Serialize creation/replay across source sessions. No capture lock is
        // held while scanning; each edge page validates the frozen reference.
        let _creation = self.derived_creation.lock();
        let source = self.context(&request.capture.session_id)?;
        self.validate_capture(&request.capture)?;
        let enabled = if source.enabled_channels.is_empty() {
            (0..source.channel_count).collect::<Vec<_>>()
        } else {
            source.enabled_channels.clone()
        };
        if request.channels.iter().any(|c| !enabled.contains(c)) {
            return Err(WorkbenchError::InvalidRequest(
                "derived filter uses an uncaptured channel".into(),
            ));
        }
        if let Ok(target) = self.existing_session(&request.target_session_id) {
            let context = self.context(&request.target_session_id)?;
            let lease = self.lease(&target, &context.capture)?;
            let mut d = target.document.lock();
            crate::synchronize(&mut d, lease.snapshot().capture_generation);
            if !request.preview
                && d.derived_replay
                    .as_ref()
                    .is_some_and(|p| p.0 == owner && p.1 == request.request_id && p.2 == input)
            {
                return Ok(json!({"context":context,"complete":true,"replayed":true}));
            }
            return Err(WorkbenchError::RequestIdConflict);
        }
        let mut total = 0usize;
        let mut channels = Vec::new();
        let mut modifications = Vec::new();
        for channel in enabled {
            let mut transitions = Vec::new();
            let mut start = 0u64;
            let mut initial = None;
            loop {
                if cancel.load(Ordering::Acquire) {
                    return Err(WorkbenchError::Cancelled);
                }
                let page = self.edge_window(
                    &request.capture,
                    channel,
                    SampleRange::new(start, source.sample_count.0, source.sample_count.0)?,
                )?;
                initial.get_or_insert(page.window.high_before_start);
                total += page.window.transitions.len();
                if total > 65536 {
                    return Err(WorkbenchError::ResourceLimit(
                        "derived capture input exceeds 65536 original edges",
                    ));
                }
                transitions.extend(page.window.transitions);
                if page.window.complete {
                    break;
                }
                start = page.window.end_sample;
            }
            let initial_high = initial.unwrap_or(false);
            let (filtered, count) = if request.channels.contains(&channel) {
                filter(
                    &transitions,
                    initial_high,
                    request.high,
                    request.max_width_exclusive.0,
                    cancel,
                )?
            } else {
                (transitions, 0)
            };
            modifications.push(json!({"channel":channel,"replaced_pulses":count.to_string()}));
            channels.push(SparseDigitalChannel {
                channel,
                initial_high,
                transitions: filtered,
            });
        }
        self.validate_capture(&request.capture)?;
        let provenance = json!({"schema_version":"1","algorithm":"replace_complete_original_pulses","algorithm_version":"1","source_capture":request.capture,
            "source_sample_count":source.sample_count,"sample_rate_hz":source.sample_rate_hz,"mapping":"identity_sample_axis","mapping_offset_sample":"0",
            "channels":request.channels,"max_width_exclusive":request.max_width_exclusive,"high":request.high,"modifications":modifications,
            "cascade":false,"interpretation":"derived_digital_hypothesis_not_electrical_repair","owner":owner,"request_id":request.request_id,"source_derivation":source.derivation});
        if serde_json::to_vec(&provenance)?.len() > 16 * 1024 {
            return Err(WorkbenchError::ResourceLimit(
                "derivation lineage exceeds 16 KiB",
            ));
        }
        if request.preview {
            return Ok(
                json!({"capture":request.capture,"preview":true,"derivation":provenance,"complete":true}),
            );
        }
        if cancel.load(Ordering::Acquire) {
            return Err(WorkbenchError::Cancelled);
        }
        let session = self.existing_session(&request.capture.session_id)?;
        let lease = self.lease(&session, &request.capture)?;
        let mut metadata = lease.snapshot().metadata.clone();
        metadata.source_device = format!("derived:{}", metadata.source_device)
            .chars()
            .take(128)
            .collect();
        // Build privately, then publish the capture and provenance together.
        // Readers cannot observe a target without its derivation or replay state.
        let bytes = channels
            .iter()
            .map(|c| c.transitions.len() as u64 * 16)
            .sum();
        let target = std::sync::Arc::new(crate::WorkbenchSession {
            import_bytes: bytes,
            ..Default::default()
        });
        target
            .graph
            .replace_sparse_capture(SparseCaptureData { metadata, channels })
            .map_err(crate::ReadError::Graph)?;
        let snapshot = target.graph.capture_snapshot()?;
        let provenance = restore(Some(&provenance), &snapshot)?.expect("derived provenance");
        {
            let mut d = target.document.lock();
            d.generation = snapshot.capture_generation;
            d.derivation = Some(provenance);
            d.derived_replay = Some((owner.into(), request.request_id.clone(), input));
        }
        {
            let mut sessions = self.sessions.write();
            if sessions.contains_key(&request.target_session_id) {
                return Err(WorkbenchError::RequestIdConflict);
            }
            if sessions.len() >= crate::MAX_SESSIONS
                || sessions.values().map(|s| s.import_bytes).sum::<u64>() + bytes
                    > 256 * 1024 * 1024
            {
                return Err(WorkbenchError::ResourceLimit("total imported captures"));
            }
            sessions.insert(request.target_session_id.clone(), target);
        }
        drop(lease);
        Ok(
            json!({"context":self.context(&request.target_session_id)?,"complete":true,"replayed":false}),
        )
    }
}
/// Preserve future schema versions as bounded provenance, without interpreting
/// their coordinates. Schema 1 maps each current sample to source sample+offset.
pub(crate) fn restore(
    value: Option<&Value>,
    snapshot: &sigpilot_graph::GraphCaptureSnapshot,
) -> Result<Option<Value>> {
    let Some(value) = value else { return Ok(None) };
    if !value.is_object() || serde_json::to_vec(value)?.len() > 16 * 1024 {
        return Err(WorkbenchError::InvalidRequest(
            "invalid or oversized derivation provenance".into(),
        ));
    }
    if value["schema_version"] != "1" {
        return Ok(Some(value.clone()));
    }
    let exact = |key: &str| -> Result<u64> {
        Ok(serde_json::from_value::<ExactU64>(value[key].clone())?.0)
    };
    let source: CaptureRef = serde_json::from_value(value["source_capture"].clone())?;
    crate::validate_id(&source.session_id)?;
    crate::validate_id(&source.capture_id)?;
    for key in ["owner", "request_id"] {
        crate::validate_id(value[key].as_str().ok_or_else(|| {
            WorkbenchError::InvalidRequest("invalid derivation identity".into())
        })?)?;
    }
    let count = exact("source_sample_count")?;
    let offset = exact("mapping_offset_sample")?;
    let channels: Vec<u8> = serde_json::from_value(value["channels"].clone())?;
    if count == 0
        || offset
            .checked_add(snapshot.metadata.sample_count)
            .is_none_or(|n| n > count)
        || exact("sample_rate_hz")? != snapshot.metadata.sample_rate_hz
        || exact("max_width_exclusive")? <= 1
        || value["algorithm"] != "replace_complete_original_pulses"
        || value["algorithm_version"] != "1"
        || value["mapping"] != "identity_sample_axis"
        || value["cascade"] != false
        || value["interpretation"] != "derived_digital_hypothesis_not_electrical_repair"
        || !(value["high"].is_null() || value["high"].is_boolean())
        || channels.is_empty()
        || channels.len() > 8
        || channels.iter().collect::<BTreeSet<_>>().len() != channels.len()
        || channels.iter().any(|c| !crate::valid_channel(snapshot, *c))
    {
        return Err(WorkbenchError::InvalidRequest(
            "derivation source mapping or algorithm mismatch".into(),
        ));
    }
    let changes = value["modifications"]
        .as_array()
        .ok_or_else(|| WorkbenchError::InvalidRequest("invalid derivation modifications".into()))?;
    let mut seen = BTreeSet::new();
    let mut pulses = 0u64;
    for change in changes {
        let channel = change["channel"]
            .as_u64()
            .filter(|c| *c < 32)
            .ok_or_else(|| WorkbenchError::InvalidRequest("invalid derivation channel".into()))?
            as u8;
        let replaced = serde_json::from_value::<ExactU64>(change["replaced_pulses"].clone())?.0;
        if !crate::valid_channel(snapshot, channel)
            || !seen.insert(channel)
            || (!channels.contains(&channel) && replaced != 0)
        {
            return Err(WorkbenchError::InvalidRequest(
                "invalid derivation modification".into(),
            ));
        }
        pulses = pulses
            .checked_add(replaced)
            .ok_or(WorkbenchError::ResourceLimit("derivation pulse count"))?;
    }
    if seen.len() > 32 || channels.iter().any(|c| !seen.contains(c)) || pulses > 32768 {
        return Err(WorkbenchError::InvalidRequest(
            "derivation modification count mismatch".into(),
        ));
    }
    Ok(Some(value.clone()))
}
pub(crate) fn cropped(value: Option<&Value>, start: u64) -> Result<Option<Value>> {
    let Some(value) = value else { return Ok(None) };
    let mut value = value.clone();
    if value["schema_version"] == "1" {
        let offset = serde_json::from_value::<ExactU64>(value["mapping_offset_sample"].clone())?.0;
        value["mapping_offset_sample"] = json!(offset
            .checked_add(start)
            .ok_or(WorkbenchError::ResourceLimit("derived crop offset"))?
            .to_string());
    } else if value["schema_version"] != "opaque_archive_v1" {
        value = json!({"schema_version":"opaque_archive_v1","reason":"capture_trimmed","original":value});
    }
    if serde_json::to_vec(&value)?.len() > 16 * 1024 {
        return Err(WorkbenchError::ResourceLimit(
            "cropped derivation provenance",
        ));
    }
    Ok(Some(value))
}
/// Select disjoint complete original pulses. When consecutive candidates
/// share an edge, the earlier candidate wins; decisions never use filtered
/// edges, preventing repeated passes from silently widening the threshold.
fn filter(
    edges: &[u64],
    initial: bool,
    polarity: Option<bool>,
    max: u64,
    cancel: &AtomicBool,
) -> Result<(Vec<u64>, u64)> {
    let mut result = Vec::with_capacity(edges.len());
    let mut index = 0usize;
    let mut removed = 0u64;
    while index < edges.len() {
        if index % 128 == 0 && cancel.load(Ordering::Acquire) {
            return Err(WorkbenchError::Cancelled);
        }
        let high = initial ^ (index % 2 == 0);
        if index + 1 < edges.len()
            && edges[index + 1] - edges[index] < max
            && polarity.is_none_or(|p| p == high)
        {
            removed += 1;
            index += 2;
        } else {
            result.push(edges[index]);
            index += 1;
        }
    }
    Ok((result, removed))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn one_pass_disjoint_pulses_preserve_time_initial_level_and_open_boundaries() {
        let c = AtomicBool::new(false);
        let shift = (1u64 << 53) + 19;
        let edges = [2, 3, 4, 5, 10, 11, 15].map(|s| s + shift);
        let (out, count) = filter(&edges, false, Some(true), 2, &c).unwrap();
        assert_eq!(count, 3);
        assert_eq!(out, vec![shift + 15]);
        let (out, count) = filter(&edges, false, None, 2, &c).unwrap();
        assert_eq!(count, 3);
        assert_eq!(out, vec![shift + 15]);
        assert!(matches!(
            filter(&edges, false, None, 2, &AtomicBool::new(true)),
            Err(WorkbenchError::Cancelled)
        ));
    }
    #[test]
    fn future_derivation_is_preserved_and_archived_once_on_crop() {
        let value = json!({"schema_version":"9","future_mapping":"unknown"});
        let service = crate::tests::service();
        let snapshot = service
            .existing_session("session-a")
            .unwrap()
            .graph
            .capture_snapshot()
            .unwrap();
        assert_eq!(
            restore(Some(&value), &snapshot).unwrap(),
            Some(value.clone())
        );
        let archived = cropped(Some(&value), 1).unwrap().unwrap();
        assert_eq!(archived["original"], value);
        assert_eq!(cropped(Some(&archived), 2).unwrap(), Some(archived));
    }
    #[test]
    fn creation_preview_replay_and_save_keep_source_and_mapping_independent() {
        let service = crate::tests::service();
        let source = service.existing_session("session-a").unwrap();
        let metadata = source.graph.capture_snapshot().unwrap().metadata;
        source
            .graph
            .replace_sparse_capture(SparseCaptureData {
                metadata,
                channels: vec![SparseDigitalChannel {
                    channel: 0,
                    initial_high: false,
                    transitions: vec![2, 3, 5, 7, 10, 11, 15],
                }],
            })
            .unwrap();
        let capture = service.context("session-a").unwrap().capture;
        let mut r = DerivedRequest {
            capture: capture.clone(),
            target_session_id: "filtered".into(),
            channels: vec![0],
            max_width_exclusive: 2.into(),
            high: Some(true),
            request_id: "derive".into(),
            preview: true,
        };
        service
            .create_derived_capture("owner", &r, &AtomicBool::new(false))
            .unwrap();
        assert!(service.context("filtered").is_err());
        r.preview = false;
        let result = service
            .create_derived_capture("owner", &r, &AtomicBool::new(false))
            .unwrap();
        assert_eq!(result["context"]["sample_count"], "16");
        assert_eq!(
            service
                .create_derived_capture("owner", &r, &AtomicBool::new(false))
                .unwrap()["replayed"],
            true
        );
        assert_eq!(
            service
                .existing_session("filtered")
                .unwrap()
                .graph
                .sparse_capture()
                .unwrap()
                .channels[0]
                .transitions,
            vec![5, 7, 15]
        );
        assert_eq!(
            source.graph.sparse_capture().unwrap().channels[0].transitions,
            vec![2, 3, 5, 7, 10, 11, 15]
        );
        assert_eq!(service.context("session-a").unwrap().capture, capture);
        let path =
            std::env::temp_dir().join(format!("sigpilot-derived-{}.pxl", uuid::Uuid::new_v4()));
        service
            .save_project("filtered", &path, Default::default())
            .unwrap();
        let saved = sigpilot_file::open_pxl_bounded(&path, 1024 * 1024).unwrap();
        assert_eq!(
            saved.session.workbench_derivation.as_ref().unwrap()["mapping"],
            "identity_sample_axis"
        );
        let reopened = WorkbenchService::default();
        reopened
            .import_capture("reopened", saved.capture.clone())
            .unwrap();
        reopened
            .restore_annotations("reopened", &saved.session)
            .unwrap();
        let mut forged = saved.session.clone();
        forged.workbench_derivation.as_mut().unwrap()["mapping_offset_sample"] = json!("1");
        let invalid = WorkbenchService::default();
        invalid.import_capture("invalid", saved.capture).unwrap();
        assert!(invalid.restore_annotations("invalid", &forged).is_err());
        assert!(invalid.context("invalid").unwrap().derivation.is_none());
        assert!(matches!(
            service.create_derived_capture("other", &r, &AtomicBool::new(false)),
            Err(WorkbenchError::RequestIdConflict)
        ));
        let mut conflict = r.clone();
        conflict.max_width_exclusive = 3.into();
        assert!(matches!(
            service.create_derived_capture("owner", &conflict, &AtomicBool::new(false)),
            Err(WorkbenchError::RequestIdConflict)
        ));
        service.trim_capture("filtered", 1, 10).unwrap();
        assert_eq!(
            service.context("filtered").unwrap().derivation.unwrap()["mapping_offset_sample"],
            "1"
        );
        std::fs::remove_file(path).unwrap();
        assert!(matches!(
            service.create_derived_capture("owner", &r, &AtomicBool::new(false)),
            Err(WorkbenchError::RequestIdConflict)
        ));
    }
}
