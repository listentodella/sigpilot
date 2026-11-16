//! Addressable, bounded views. Resource URIs never resolve filesystem paths.
use crate::{McpAdapter, ToolFailure};
use rmcp::model::{ContentBlock, Resource, ResourceTemplate};
use serde_json::{json, Value};
use sigpilot_workbench::CaptureRef;

fn base(c: &CaptureRef) -> String {
    format!(
        "sigpilot://sessions/{}/captures/{}/{}/",
        c.session_id, c.capture_id, c.data_revision.0
    )
}
fn link(uri: String, name: &str) -> ContentBlock {
    ContentBlock::ResourceLink(Resource::new(uri, name).with_mime_type("application/json"))
}
pub(crate) fn links(value: &Value) -> Vec<ContentBlock> {
    let mut result = Vec::new();
    if let Some(job) = value["job_id"].as_str() {
        result.push(link(format!("sigpilot://jobs/{job}"), "job"));
    }
    let capture=serde_json::from_value::<CaptureRef>(value["capture"].clone()).ok().or_else(||serde_json::from_value(json!({
        "session_id":value["session_id"],"capture_id":value["capture_id"],"data_revision":value["data_revision"]
    })).ok());
    if let Some(capture) = capture {
        let root = base(&capture);
        result.push(link(format!("{root}summary"), "capture-summary"));
        if let Some(id) = value["upsert"]["report_id"]
            .as_str()
            .or_else(|| value["report"]["report_id"].as_str())
        {
            result.push(link(
                format!("{root}reports/{id}/pages/0"),
                "report-findings",
            ));
        }
        let mut refs = Vec::new();
        if let Some(id) = value["evidence_ref"].as_str() {
            refs.push(id);
        }
        if let Some(ids) = value["evidence_refs"].as_array() {
            refs.extend(ids.iter().filter_map(Value::as_str));
        }
        if let Some(items) = value["items"].as_array() {
            for item in items.iter().take(8) {
                if let Some(id) = item["evidence_ref"].as_str() {
                    refs.push(id);
                }
                if let Some(ids) = item["evidence_refs"].as_array() {
                    refs.extend(ids.iter().take(8).filter_map(Value::as_str));
                }
            }
        }
        for id in refs.into_iter().take(8) {
            result.push(link(format!("{root}evidence/{id}"), "evidence"));
        }
    }
    result
}
impl McpAdapter {
    pub fn resource_catalog(&self) -> Vec<Resource> {
        self.workbench
            .analysis_capabilities()
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|d| {
                Some(
                    Resource::new(
                        format!(
                            "sigpilot://schemas/analysis/{}/{}",
                            d["provider_id"].as_str()?,
                            d["version"].as_str()?
                        ),
                        d["provider_id"].as_str()?,
                    )
                    .with_description(
                        "Registered provider descriptor and schemas; no code is installed.",
                    )
                    .with_mime_type("application/json"),
                )
            })
            .collect()
    }
    pub fn resource_templates(&self) -> Vec<ResourceTemplate> {
        [
            ("sigpilot://sessions/{session_id}/captures/{capture_id}/{data_revision}/summary","capture-summary"),
            ("sigpilot://sessions/{session_id}/captures/{capture_id}/{data_revision}/evidence/{evidence_ref}","evidence"),
            ("sigpilot://schemas/analysis/{provider_id}/{version}","analysis-schema"),
            ("sigpilot://jobs/{job_id}","owned-job-summary"),
            ("sigpilot://sessions/{session_id}/captures/{capture_id}/{data_revision}/reports/{report_id}/pages/{start_index}","report-findings"),
            ("sigpilot://sessions/{session_id}/captures/{capture_id}/{data_revision}/results/{result_set_id}","retained-result-summary"),
        ].into_iter().map(|(uri,name)|ResourceTemplate::new(uri,name).with_mime_type("application/json")).collect()
    }
    pub(crate) fn resolve_resource(&self, uri: &str) -> Result<Value, ToolFailure> {
        if uri.len() > 1024 {
            return Err(ToolFailure::new(
                "INVALID_INPUT",
                "resource URI exceeds 1024 bytes",
            ));
        }
        let path = uri
            .strip_prefix("sigpilot://")
            .ok_or_else(|| ToolFailure::new("RESOURCE_NOT_FOUND", "unsupported resource scheme"))?;
        // IDs use a safe literal alphabet. Reject encoding, queries, traversal
        // and aliases instead of reinterpreting an address as current data.
        if !path
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"/._-:".contains(&b))
            || path
                .split('/')
                .any(|s| s.is_empty() || s == "." || s == "..")
        {
            return Err(ToolFailure::new("INVALID_INPUT", "invalid resource URI"));
        }
        let parts: Vec<_> = path.split('/').collect();
        let value = match parts.as_slice() {
            ["schemas", "analysis", provider, version] => self
                .workbench
                .analysis_capabilities()
                .as_array()
                .into_iter()
                .flatten()
                .find(|d| {
                    d["provider_id"].as_str() == Some(*provider)
                        && d["version"].as_str() == Some(*version)
                })
                .cloned()
                .ok_or_else(|| {
                    ToolFailure::new("RESOURCE_NOT_FOUND", "provider version not registered")
                })?,
            ["jobs", job] => self.execute("sigpilot_get_job", json!({"job_id":job}))?,
            ["sessions", session, "captures", capture, revision, tail @ ..] => {
                let c: CaptureRef = serde_json::from_value(
                    json!({"session_id":session,"capture_id":capture,"data_revision":revision}),
                )?;
                self.workbench.validate_capture(&c)?;
                match tail {
                    ["results", id] => self.workbench.retained_result(&c, id)?,
                    ["summary"] => {
                        let context = self.workbench.context(session)?;
                        if context.capture != c {
                            return Err(
                                sigpilot_workbench::WorkbenchError::CaptureVersionConflict.into()
                            );
                        }
                        serde_json::to_value(context)?
                    }
                    ["evidence", id] => {
                        self.workbench
                            .get_evidence(&c, &[id.to_string()], 0.into())?
                    }
                    ["reports", id, "pages", index] => {
                        let start: sigpilot_analysis::ExactU64 =
                            serde_json::from_value(json!(index))?;
                        let start = usize::try_from(start.0).map_err(|_| {
                            ToolFailure::new("INVALID_INPUT", "report index overflow")
                        })?;
                        self.workbench.read_report(&c, id, start, 20)?
                    }
                    _ => {
                        return Err(ToolFailure::new(
                            "RESOURCE_NOT_FOUND",
                            "unknown capture resource",
                        ))
                    }
                }
            }
            _ => return Err(ToolFailure::new("RESOURCE_NOT_FOUND", "unknown resource")),
        };
        if serde_json::to_vec(&value)?.len() > 224 * 1024 {
            return Err(ToolFailure::new(
                "RESOURCE_LIMIT",
                "resource exceeds 224 KiB; use bounded tools",
            ));
        }
        Ok(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn schema_resources_do_not_accept_paths_encoding_or_unknown_versions() {
        let adapter = McpAdapter::new(Default::default(), vec![], false, "test".into());
        assert_eq!(adapter.resource_catalog().len(), 3);
        assert_eq!(links(&json!({"session_id":"s","capture_id":"c","data_revision":"1","annotation_count":"0"})).len(),1);
        assert_eq!(
            adapter
                .resolve_resource("sigpilot://schemas/analysis/sigpilot.pulse_width/1")
                .unwrap()["version"],
            "1"
        );
        for uri in [
            "file:///etc/hosts",
            "sigpilot://schemas/analysis/../1",
            "sigpilot://schemas/analysis/%2e%2e/1",
            "sigpilot://schemas/analysis/sigpilot.pulse_width/2",
        ] {
            assert!(adapter.resolve_resource(uri).is_err());
        }
    }
}
