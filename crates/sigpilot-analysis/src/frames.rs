//! Backend-field preservation and bounded, typed queries over a fixed decode.
use crate::{AnalysisError, ExactU64, Result, SampleRange};
use serde::{Deserialize, Serialize};
use sigpilot_core::{DecoderBackendKind, DecoderFieldValue, DecoderOutput};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::atomic::{AtomicBool, Ordering},
};

pub const MAX_DECODE_FRAMES: usize = 4096;
pub const MAX_FRAME_PAGE_BYTES: usize = 128 * 1024;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum FieldType {
    Text,
    Unsigned,
    Signed,
    Boolean,
    Bytes,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "type",
    content = "value",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum FieldValue {
    Text(String),
    Unsigned(ExactU64),
    Signed(String),
    Boolean(bool),
    Bytes(Vec<u8>),
}

impl FieldValue {
    pub fn kind(&self) -> FieldType {
        match self {
            Self::Text(_) => FieldType::Text,
            Self::Unsigned(_) => FieldType::Unsigned,
            Self::Signed(_) => FieldType::Signed,
            Self::Boolean(_) => FieldType::Boolean,
            Self::Bytes(_) => FieldType::Bytes,
        }
    }
    pub fn validate(&self) -> Result<()> {
        match self {
            Self::Signed(s)
                if s.parse::<i64>().is_err()
                    || s.parse::<i64>().is_ok_and(|n| n.to_string() != *s) =>
            {
                Err(AnalysisError::InvalidInput(
                    "signed field requires a canonical decimal i64 string".into(),
                ))
            }
            Self::Text(s) if s.len() > 4096 => Err(AnalysisError::InvalidInput(
                "field text exceeds 4096 bytes".into(),
            )),
            Self::Bytes(b) if b.len() > 4096 => Err(AnalysisError::InvalidInput(
                "field bytes exceed 4096 bytes".into(),
            )),
            _ => Ok(()),
        }
    }
}

impl From<DecoderFieldValue> for FieldValue {
    fn from(value: DecoderFieldValue) -> Self {
        match value {
            DecoderFieldValue::Text(v) => Self::Text(v),
            DecoderFieldValue::Unsigned(v) => Self::Unsigned(v.into()),
            DecoderFieldValue::Signed(v) => Self::Signed(v.to_string()),
            DecoderFieldValue::Boolean(v) => Self::Boolean(v),
            DecoderFieldValue::Bytes(v) => Self::Bytes(v),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FieldSchema {
    pub name: String,
    pub types: BTreeSet<FieldType>,
    pub rows: BTreeSet<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProtocolFrame {
    pub frame_id: ExactU64,
    pub range: SampleRange,
    pub row: String,
    pub texts: Vec<String>,
    pub fields: BTreeMap<String, FieldValue>,
    /// These are configured decoder inputs, not a claim that each row uses all channels.
    pub configured_channels: Vec<u8>,
    pub native_start_sample: ExactU64,
    pub native_end_sample: ExactU64,
    pub native_endpoint_policy: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FrameSet {
    pub backend: String,
    pub backend_protocol: String,
    pub protocol: String,
    pub processed_range: SampleRange,
    pub requested_range: SampleRange,
    pub field_schema: Vec<FieldSchema>,
    pub schema_scope: String,
    pub configuration: serde_json::Value,
    pub frames: Vec<ProtocolFrame>,
    pub diagnostics: Vec<sigpilot_core::DecoderDiagnostic>,
}

/// Verified against the bundled analyzer sources, rather than applying a
/// blanket +1 to all Saleae FrameV2 endpoints. Unknown rows fail explicitly.
pub fn normalize_saleae(
    output: DecoderOutput,
    protocol: &str,
    channels: Vec<u8>,
    requested: SampleRange,
    processed: SampleRange,
    sample_count: u64,
) -> Result<FrameSet> {
    if output.backend != DecoderBackendKind::SaleaeNative || output.frames.len() > MAX_DECODE_FRAMES
    {
        return Err(AnalysisError::InvalidInput(
            "unexpected backend or decode frame budget exceeded".into(),
        ));
    }
    let mut schema: BTreeMap<String, FieldSchema> = BTreeMap::new();
    let mut frames = Vec::new();
    let mut ids = BTreeSet::new();
    for native in output.frames {
        if !ids.insert(native.frame_id) {
            return Err(AnalysisError::InvalidInput(
                "duplicate native frame ID".into(),
            ));
        }
        let inclusive = match (protocol, native.row.as_str()) {
            ("UART", "data") | ("I2C", "address" | "data") => true,
            ("I2C", "start" | "stop") | ("SPI", "result" | "enable" | "disable" | "error") => false,
            _ => {
                return Err(AnalysisError::InvalidInput(format!(
                    "endpoint policy unverified for {protocol}/{}",
                    native.row
                )))
            }
        };
        let end = if inclusive {
            native
                .end_sample
                .checked_add(1)
                .ok_or(AnalysisError::Overflow)?
        } else {
            native.end_sample
        };
        let range = SampleRange::new(native.start_sample, end, sample_count)?;
        if range.end_sample > processed.end_sample {
            return Err(AnalysisError::InvalidInput(
                "decoder frame exceeds processed range".into(),
            ));
        }
        if native.row.len() > 128
            || native.texts.len() > 32
            || native.texts.iter().any(|s| s.len() > 4096)
            || native.fields.len() > 64
        {
            return Err(AnalysisError::InvalidInput(
                "decoder row/text/field budget exceeded".into(),
            ));
        }
        let mut fields = BTreeMap::new();
        for field in native.fields {
            if field.name.is_empty() || field.name.len() > 128 {
                return Err(AnalysisError::InvalidInput(
                    "invalid native field name".into(),
                ));
            }
            let value = FieldValue::from(field.value);
            value.validate()?;
            let entry = schema
                .entry(field.name.clone())
                .or_insert_with(|| FieldSchema {
                    name: field.name.clone(),
                    types: BTreeSet::new(),
                    rows: BTreeSet::new(),
                });
            entry.types.insert(value.kind());
            entry.rows.insert(native.row.clone());
            if fields.insert(field.name, value).is_some() {
                return Err(AnalysisError::InvalidInput(
                    "duplicate native field name".into(),
                ));
            }
        }
        frames.push(ProtocolFrame {
            frame_id: native.frame_id.into(),
            range,
            row: native.row,
            texts: native.texts,
            fields,
            configured_channels: channels.clone(),
            native_start_sample: native.start_sample.into(),
            native_end_sample: native.end_sample.into(),
            native_endpoint_policy: if inclusive { "inclusive" } else { "exclusive" }.into(),
        });
    }
    if schema.len() > 128 {
        return Err(AnalysisError::InvalidInput(
            "field schema exceeds 128 fields".into(),
        ));
    }
    frames.sort_by_key(|f| (f.range.start_sample, f.frame_id));
    Ok(FrameSet {
        backend: "saleae_native".into(),
        backend_protocol: output.protocol,
        protocol: protocol.into(),
        processed_range: processed,
        requested_range: requested,
        field_schema: schema.into_values().collect(),
        schema_scope: "observed_fields_in_this_result_set".into(),
        configuration: serde_json::Value::Null,
        frames,
        diagnostics: output.diagnostics,
    })
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FieldOperator {
    Eq,
    Ne,
    Lt,
    Lte,
    Gt,
    Gte,
    Exists,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FieldFilter {
    pub name: String,
    pub op: FieldOperator,
    pub value: Option<FieldValue>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FrameQuery {
    pub range: Option<SampleRange>,
    #[serde(default)]
    pub rows: Vec<String>,
    #[serde(default)]
    pub fields: Vec<FieldFilter>,
    pub text_contains: Option<String>,
    #[serde(default)]
    pub projection: Vec<String>,
}

impl FrameQuery {
    pub fn validate(&self, set: &FrameSet) -> Result<()> {
        if self.rows.len() > 32
            || self.rows.iter().any(|s| s.len() > 128)
            || self.fields.len() > 8
            || self.projection.len() > 64
            || self
                .text_contains
                .as_ref()
                .is_some_and(|s| s.is_empty() || s.len() > 256)
        {
            return Err(AnalysisError::InvalidInput(
                "frame filter exceeds query budget".into(),
            ));
        }
        if let Some(range) = self.range {
            range.validate(set.processed_range.end_sample.0)?;
        }
        let find = |name: &str| {
            set.field_schema
                .iter()
                .find(|s| s.name == name)
                .ok_or_else(|| {
                    AnalysisError::InvalidInput(format!(
                        "field is not declared by this result set: {name}"
                    ))
                })
        };
        for name in &self.projection {
            find(name)?;
        }
        for filter in &self.fields {
            let schema = find(&filter.name)?;
            match (filter.op, &filter.value) {
                (FieldOperator::Exists, None) => {}
                (FieldOperator::Exists, Some(_)) | (_, None) => {
                    return Err(AnalysisError::InvalidInput(
                        "exists has no value; comparison requires typed value".into(),
                    ))
                }
                (_, Some(value)) => {
                    value.validate()?;
                    if !schema.types.contains(&value.kind()) {
                        return Err(AnalysisError::InvalidInput(
                            "filter type differs from declared field type".into(),
                        ));
                    }
                    if !matches!(filter.op, FieldOperator::Eq | FieldOperator::Ne)
                        && !matches!(value, FieldValue::Unsigned(_) | FieldValue::Signed(_))
                    {
                        return Err(AnalysisError::InvalidInput(
                            "ordered comparison requires an integer field".into(),
                        ));
                    }
                }
            }
        }
        Ok(())
    }

    pub(crate) fn matches(&self, frame: &ProtocolFrame) -> bool {
        if self.range.is_some_and(|r| {
            frame.range.start_sample >= r.end_sample || frame.range.end_sample <= r.start_sample
        }) || (!self.rows.is_empty() && !self.rows.contains(&frame.row))
            || self
                .text_contains
                .as_ref()
                .is_some_and(|s| !frame.texts.iter().any(|text| text.contains(s)))
        {
            return false;
        }
        self.fields.iter().all(|f| {
            let Some(actual) = frame.fields.get(&f.name) else {
                return false;
            };
            if f.op == FieldOperator::Exists {
                return true;
            }
            let Some(expected) = &f.value else {
                return false;
            };
            if actual.kind() != expected.kind() {
                return false;
            }
            let cmp = match (actual, expected) {
                (FieldValue::Unsigned(a), FieldValue::Unsigned(b)) => Some(a.cmp(b)),
                (FieldValue::Signed(a), FieldValue::Signed(b)) => {
                    Some(a.parse::<i64>().ok().cmp(&b.parse::<i64>().ok()))
                }
                _ => None,
            };
            match f.op {
                FieldOperator::Eq => actual == expected,
                FieldOperator::Ne => actual != expected,
                FieldOperator::Lt => cmp.is_some_and(|c| c.is_lt()),
                FieldOperator::Lte => cmp.is_some_and(|c| !c.is_gt()),
                FieldOperator::Gt => cmp.is_some_and(|c| c.is_gt()),
                FieldOperator::Gte => cmp.is_some_and(|c| !c.is_lt()),
                FieldOperator::Exists => true,
            }
        })
    }

    pub(crate) fn project(&self, frame: &ProtocolFrame) -> ProtocolFrame {
        let mut projected = frame.clone();
        if !self.projection.is_empty() {
            projected
                .fields
                .retain(|name, _| self.projection.contains(name));
        }
        projected
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct FramePage {
    pub items: Vec<ProtocolFrame>,
    pub inspected_frames: ExactU64,
    pub complete: bool,
    pub next_offset: Option<usize>,
}

pub fn query_frames(
    set: &FrameSet,
    query: &FrameQuery,
    offset: usize,
    limit: usize,
) -> Result<FramePage> {
    query_frames_with_cancel(set, query, offset, limit, &AtomicBool::new(false))
}

pub fn query_frames_with_cancel(
    set: &FrameSet,
    query: &FrameQuery,
    offset: usize,
    limit: usize,
    cancel: &AtomicBool,
) -> Result<FramePage> {
    if cancel.load(Ordering::Acquire) {
        return Err(AnalysisError::Cancelled);
    }
    query.validate(set)?;
    if limit == 0 || limit > 1000 || offset > set.frames.len() {
        return Err(AnalysisError::InvalidInput("invalid frame page".into()));
    }
    let mut items = Vec::new();
    let mut bytes = 0;
    let mut position = offset;
    while position < set.frames.len() {
        if cancel.load(Ordering::Acquire) {
            return Err(AnalysisError::Cancelled);
        }
        let frame = &set.frames[position];
        if query.matches(frame)
            && frame.range.start_sample < set.requested_range.end_sample
            && frame.range.end_sample > set.requested_range.start_sample
        {
            let mut projected = frame.clone();
            if !query.projection.is_empty() {
                projected
                    .fields
                    .retain(|name, _| query.projection.contains(name));
            }
            let size = serde_json::to_vec(&projected)
                .map_err(|e| AnalysisError::InvalidInput(e.to_string()))?
                .len();
            if size > MAX_FRAME_PAGE_BYTES {
                return Err(AnalysisError::InvalidInput(
                    "individual frame exceeds response budget".into(),
                ));
            }
            if items.len() == limit || bytes + size > MAX_FRAME_PAGE_BYTES {
                break;
            }
            bytes += size;
            items.push(projected);
        }
        position += 1;
    }
    Ok(FramePage {
        items,
        inspected_frames: ((position - offset) as u64).into(),
        complete: position == set.frames.len(),
        next_offset: (position < set.frames.len()).then_some(position),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use sigpilot_core::{DecoderField, DecoderOutputFrame};
    fn set() -> FrameSet {
        let frames = vec![
            (1, "start", 2, 3, vec![]),
            (
                2,
                "address",
                4,
                9,
                vec![DecoderField {
                    name: "address".into(),
                    value: DecoderFieldValue::Unsigned(80),
                }],
            ),
            (
                3,
                "data",
                10,
                15,
                vec![DecoderField {
                    name: "ack".into(),
                    value: DecoderFieldValue::Boolean(false),
                }],
            ),
        ];
        normalize_saleae(
            DecoderOutput {
                backend: DecoderBackendKind::SaleaeNative,
                protocol: "I2C".into(),
                diagnostics: vec![],
                frames: frames
                    .into_iter()
                    .map(|(id, row, start, end, fields)| DecoderOutputFrame {
                        frame_id: id,
                        start_sample: start,
                        end_sample: end,
                        row: row.into(),
                        texts: vec!["display can change".into()],
                        fields,
                        channel_values: vec![],
                        markers: vec![],
                    })
                    .collect(),
            },
            "I2C",
            vec![0, 1],
            SampleRange::new(0, 20, 20).unwrap(),
            SampleRange::new(0, 20, 20).unwrap(),
            20,
        )
        .unwrap()
    }
    #[test]
    fn normalizes_verified_event_and_data_endpoints_and_keeps_missing_unknown() {
        let set = set();
        assert_eq!(
            set.frames
                .iter()
                .map(|f| f.range.end_sample.0)
                .collect::<Vec<_>>(),
            vec![3, 10, 16]
        );
        let query = FrameQuery {
            fields: vec![FieldFilter {
                name: "ack".into(),
                op: FieldOperator::Eq,
                value: Some(FieldValue::Boolean(false)),
            }],
            ..Default::default()
        };
        let page = query_frames(&set, &query, 0, 100).unwrap();
        assert_eq!(page.items.len(), 1);
        assert_eq!(page.items[0].frame_id.0, 3);
        let query = FrameQuery {
            fields: vec![FieldFilter {
                name: "ack".into(),
                op: FieldOperator::Ne,
                value: Some(FieldValue::Boolean(true)),
            }],
            ..Default::default()
        };
        assert_eq!(query_frames(&set, &query, 0, 100).unwrap().items.len(), 1);
    }
    #[test]
    fn rejects_unknown_field_wrong_type_and_false_transaction_conjunction() {
        let set = set();
        let mut query = FrameQuery {
            fields: vec![FieldFilter {
                name: "address".into(),
                op: FieldOperator::Eq,
                value: Some(FieldValue::Boolean(false)),
            }],
            ..Default::default()
        };
        assert!(query_frames(&set, &query, 0, 100).is_err());
        query.fields[0].name = "invented".into();
        assert!(query_frames(&set, &query, 0, 100).is_err());
        query.fields = vec![
            FieldFilter {
                name: "address".into(),
                op: FieldOperator::Eq,
                value: Some(FieldValue::Unsigned(80.into())),
            },
            FieldFilter {
                name: "ack".into(),
                op: FieldOperator::Eq,
                value: Some(FieldValue::Boolean(false)),
            },
        ];
        assert!(query_frames(&set, &query, 0, 100).unwrap().items.is_empty());
    }
    #[test]
    fn pagination_continues_at_unconsumed_match() {
        let set = set();
        let query = FrameQuery::default();
        let first = query_frames(&set, &query, 0, 1).unwrap();
        assert_eq!(first.items[0].frame_id.0, 1);
        assert_eq!(first.next_offset, Some(1));
        let second = query_frames(&set, &query, first.next_offset.unwrap(), 1).unwrap();
        assert_eq!(second.items[0].frame_id.0, 2);
    }
    #[test]
    fn cancelled_page_does_not_consume_frames_or_change_the_retained_result() {
        let set = set();
        let query = FrameQuery::default();
        let flag = AtomicBool::new(true);
        assert!(matches!(
            query_frames_with_cancel(&set, &query, 0, 1, &flag),
            Err(AnalysisError::Cancelled)
        ));
        flag.store(false, Ordering::Release);
        let page = query_frames_with_cancel(&set, &query, 0, 1, &flag).unwrap();
        assert_eq!(page.items[0].frame_id.0, 1);
        assert_eq!(page.next_offset, Some(1));
    }
}
