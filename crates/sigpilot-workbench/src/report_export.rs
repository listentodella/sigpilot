//! Read-only portable report rendering. Clients can save the returned UTF-8
//! chunks in their own authorized workspace; the server does not write a path.
use crate::{CaptureRef, Result, WorkbenchError, WorkbenchService};
use serde_json::{json, Value};
use std::sync::atomic::AtomicBool;

fn quote(text: &str) -> String {
    let mut result = String::new();
    for c in text
        .chars()
        .filter(|c| !c.is_control() || *c == '\n' || *c == '\t')
    {
        match c {
            '<' => result.push_str("&lt;"),
            '>' => result.push_str("&gt;"),
            '&' => result.push_str("&amp;"),
            '\\' | '`' | '*' | '_' | '{' | '}' | '[' | ']' | '(' | ')' | '#' | '+' | '-' | '!'
            | '|' => {
                result.push('\\');
                result.push(c);
            }
            _ => result.push(c),
        }
    }
    result
}
fn fence(value: &Value) -> Result<String> {
    let content = serde_json::to_string_pretty(value)?;
    let longest = content.split(|c| c != '`').map(str::len).max().unwrap_or(0);
    let marker = "`".repeat(longest.max(2) + 1);
    Ok(format!("{marker}json\n{content}\n{marker}\n"))
}
impl WorkbenchService {
    pub fn export_report(
        &self,
        capture: &CaptureRef,
        revision: u64,
        id: &str,
        format: &str,
        offset: u64,
        max_bytes: usize,
        cancel: &AtomicBool,
    ) -> Result<Value> {
        crate::check_cancelled(cancel)?;
        if !(128..=32768).contains(&max_bytes) || !matches!(format, "json" | "markdown") {
            return Err(WorkbenchError::InvalidRequest(
                "export requires json/markdown and max_bytes 128..32768".into(),
            ));
        }
        let stored = self.report_for_export(capture, revision, id)?;
        let report = &stored.report;
        let rendered = if format == "json" {
            serde_json::to_string_pretty(report)?
        } else {
            let mut text = format!("# {}\n\n", quote(&report.title).replace('\n', " "));
            if !report.note.is_empty() {
                for line in quote(&report.note).lines() {
                    text.push_str(&format!("> {line}\n"));
                }
                text.push('\n');
            }
            text.push_str("Observations use original digital sample coordinates. Saved or archived observations retain their verification status. Assistant commentary does not establish a hardware cause.\n\n");
            let mut metadata = serde_json::to_value(report)?;
            metadata.as_object_mut().unwrap().remove("findings");
            text.push_str(&fence(&metadata)?);
            for (i, finding) in report.findings.iter().enumerate() {
                crate::check_cancelled(cancel)?;
                text.push_str(&format!("\n## Observation {}\n\n", i + 1));
                text.push_str(&fence(&serde_json::to_value(finding)?)?);
            }
            text
        };
        crate::check_cancelled(cancel)?;
        if rendered.len() > 2 * 1024 * 1024 {
            return Err(WorkbenchError::ResourceLimit(
                "rendered report exceeds 2 MiB",
            ));
        }
        let start = usize::try_from(offset)
            .map_err(|_| WorkbenchError::InvalidRequest("export offset out of range".into()))?;
        if start > rendered.len() || !rendered.is_char_boundary(start) {
            return Err(WorkbenchError::InvalidRequest(
                "export offset must be an in-range UTF-8 boundary".into(),
            ));
        }
        let mut end = start.saturating_add(max_bytes).min(rendered.len());
        while !rendered.is_char_boundary(end) {
            end -= 1;
        }
        self.validate_capture(capture)?;
        Ok(
            json!({"capture":capture,"report_id":id,"report_revision":revision.to_string(),"format":format,
            "mime_type":if format=="json"{"application/json"}else{"text/markdown"},"encoding":"utf-8","export_schema_version":"1",
            "offset":offset.to_string(),"content":&rendered[start..end],"total_bytes":rendered.len().to_string(),
            "complete":end==rendered.len(),"next_offset":if end==rendered.len(){None}else{Some(end.to_string())},"file_write":false}),
        )
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        evidence::EvidenceDraft,
        reports::{ApplyReportRequest, ReportOperation},
        AnnotationSource, Caller,
    };
    #[test]
    fn utf8_chunks_preserve_exact_report_and_markdown_quotes_untrusted_text() {
        let service = crate::tests::service();
        let capture = service.context("session-a").unwrap().capture;
        let evidence = service
            .record_evidence(
                &capture,
                vec![EvidenceDraft {
                    range: sigpilot_analysis::SampleRange::new(2, 4, 16).unwrap(),
                    channels: vec![0],
                    provider_id: "fixture".into(),
                    provider_version: "1".into(),
                    parameters: json!({}),
                    observed: json!({"label":"异常 🚩 ``` </script>","sample":"9007199254740993"}),
                }],
            )
            .unwrap();
        let created = service
            .apply_report(
                Caller {
                    id: "owner",
                    source: AnnotationSource::Assistant,
                },
                &ApplyReportRequest {
                    capture: capture.clone(),
                    expected_report_revision: 0.into(),
                    request_id: "export".into(),
                    preview: false,
                    operation: ReportOperation::Create {
                        title: "检查 <script> [link](file:///etc/passwd)".into(),
                        note: "line\n## injected\n```".into(),
                        evidence_refs: vec![evidence[0].evidence_ref.clone()],
                    },
                },
            )
            .unwrap();
        let id = created["upsert"]["report_id"].as_str().unwrap();
        let cancel = AtomicBool::new(false);
        for format in ["json", "markdown"] {
            let mut result = String::new();
            let mut offset = 0;
            loop {
                let page = service
                    .export_report(&capture, 1, id, format, offset, 128, &cancel)
                    .unwrap();
                let chunk = page["content"].as_str().unwrap();
                assert!(chunk.len() <= 128);
                result.push_str(chunk);
                if page["complete"] == true {
                    assert_eq!(result.len().to_string(), page["total_bytes"]);
                    break;
                }
                let next = page["next_offset"]
                    .as_str()
                    .unwrap()
                    .parse::<u64>()
                    .unwrap();
                assert!(next > offset);
                offset = next;
            }
            if format == "json" {
                let json: Value = serde_json::from_str(&result).unwrap();
                assert_eq!(
                    json["findings"][0]["observed"]["sample"],
                    "9007199254740993"
                );
                assert_eq!(
                    json["findings"][0]["observed"]["label"],
                    "异常 🚩 ``` </script>"
                );
                let pos = result.find('异').unwrap();
                assert!(service
                    .export_report(&capture, 1, id, format, (pos + 1) as u64, 128, &cancel)
                    .is_err());
            } else {
                assert!(result.starts_with("# 检查 &lt;script&gt; \\[link\\]"));
                assert!(result.contains("````json"));
                assert!(result.contains("> \\#\\# injected"));
            }
        }
        assert!(matches!(
            service.export_report(&capture, 0, id, "json", 0, 128, &cancel),
            Err(WorkbenchError::ReportVersionConflict(1))
        ));
        assert!(matches!(
            service.export_report(&capture, 1, id, "json", 0, 128, &AtomicBool::new(true)),
            Err(WorkbenchError::Cancelled)
        ));
        assert_eq!(service.context("session-a").unwrap().report_revision.0, 1);
    }
}
