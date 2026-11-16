//! Finite cross-frame queries. Transactions use verified I2C event rows;
//! filtering never infers ACK values from missing fields or display labels.
use crate::{
    frames::{FrameQuery, FrameSet, ProtocolFrame, MAX_DECODE_FRAMES, MAX_FRAME_PAGE_BYTES},
    AnalysisError, ExactU64, Result, SampleRange,
};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};

pub const MAX_SEQUENCE_COMPARISONS: usize = 1_000_000;
pub const MAX_PROTOCOL_QUERY_BYTES: usize = 16 * 1024;

fn invalid(message: &str) -> AnalysisError {
    AnalysisError::InvalidInput(message.into())
}
fn intersect(a: SampleRange, b: SampleRange) -> Option<SampleRange> {
    let start = a.start_sample.max(b.start_sample);
    let end = a.end_sample.min(b.end_sample);
    (start < end).then_some(SampleRange {
        start_sample: start,
        end_sample: end,
    })
}
fn overlaps(a: SampleRange, b: SampleRange) -> bool {
    a.start_sample < b.end_sample && a.end_sample > b.start_sample
}
fn envelope(set: &FrameSet, start: usize, end: usize) -> SampleRange {
    SampleRange {
        start_sample: set.frames[start].range.start_sample,
        end_sample: set.frames[start..end]
            .iter()
            .map(|f| f.range.end_sample)
            .max()
            .unwrap(),
    }
}
pub(crate) fn validate_set(set: &FrameSet) -> Result<()> {
    if set.frames.len() > MAX_DECODE_FRAMES
        || set.frames.windows(2).any(|p| {
            (p[0].range.start_sample, p[0].frame_id) > (p[1].range.start_sample, p[1].frame_id)
        })
    {
        return Err(invalid(
            "protocol query requires at most 4096 ordered frames",
        ));
    }
    Ok(())
}
fn validate_page<T: Serialize>(
    set: &FrameSet,
    query: &T,
    range: Option<SampleRange>,
    offset: usize,
    limit: usize,
) -> Result<Option<SampleRange>> {
    validate_set(set)?;
    if offset > set.frames.len()
        || limit == 0
        || limit > 100
        || serde_json::to_vec(query).map_or(true, |v| v.len() > MAX_PROTOCOL_QUERY_BYTES)
    {
        return Err(invalid(
            "protocol page requires limit 1..100 and query <=16 KiB",
        ));
    }
    if let Some(range) = range {
        range.validate(set.processed_range.end_sample.0)?;
    }
    Ok(range.map_or(Some(set.requested_range), |r| {
        intersect(r, set.requested_range)
    }))
}
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SequenceScope {
    #[default]
    Stream,
    I2cSegment,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FrameDelay {
    pub min_samples: ExactU64,
    pub max_samples: ExactU64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FrameSequenceStep {
    pub query: FrameQuery,
    pub within: Option<FrameDelay>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FrameSequenceQuery {
    pub schema_version: String,
    #[serde(default)]
    pub scope: SequenceScope,
    pub range: Option<SampleRange>,
    pub steps: Vec<FrameSequenceStep>,
}
#[derive(Debug, Clone, Serialize)]
pub struct SequenceMatch {
    pub range: SampleRange,
    pub frames: Vec<ProtocolFrame>,
}
#[derive(Debug, Clone, Serialize)]
pub struct FrameSequencePage {
    pub items: Vec<SequenceMatch>,
    pub candidate_counts: Vec<ExactU64>,
    pub comparisons: ExactU64,
    pub inspected_frames: ExactU64,
    pub total_matches: Option<ExactU64>,
    pub search_complete: bool,
    pub complete: bool,
    pub next_offset: Option<usize>,
    pub stop_reason: String,
}

pub fn query_frame_sequence(
    set: &FrameSet,
    query: &FrameSequenceQuery,
    offset: usize,
    limit: usize,
    cancel: &AtomicBool,
) -> Result<FrameSequencePage> {
    let range = validate_page(set, query, query.range, offset, limit)?;
    if query.schema_version != "1"
        || query.steps.is_empty()
        || query.steps.len() > 8
        || query.steps[0].within.is_some()
    {
        return Err(invalid(
            "sequence schema 1 requires 1..8 steps and no initial within",
        ));
    }
    for step in &query.steps {
        step.query.validate(set)?;
        if step
            .within
            .as_ref()
            .is_some_and(|w| w.min_samples > w.max_samples)
        {
            return Err(invalid("empty sequence delay window"));
        }
    }
    let groups = if query.scope == SequenceScope::I2cSegment {
        Some(i2c_groups(set)?)
    } else {
        None
    };
    let n = set.frames.len();
    let stages = query.steps.len();
    let mut candidates = Vec::new();
    for step in &query.steps {
        let mut indices = Vec::new();
        for (i, frame) in set.frames.iter().enumerate() {
            if cancel.load(Ordering::Acquire) {
                return Err(AnalysisError::Cancelled);
            }
            if range.is_some_and(|r| overlaps(frame.range, r)) && step.query.matches(frame) {
                indices.push(i);
            }
        }
        candidates.push(indices);
    }
    let mut page = FrameSequencePage {
        items: vec![],
        candidate_counts: candidates.iter().map(|c| (c.len() as u64).into()).collect(),
        comparisons: 0.into(),
        inspected_frames: (n as u64).into(),
        total_matches: None,
        search_complete: false,
        complete: false,
        next_offset: None,
        stop_reason: "comparison_budget".into(),
    };
    // Backward suffix viability preserves the earliest *completable* chain.
    // A greedy earliest intermediate frame could incorrectly hide a match.
    let mut viable = vec![vec![false; n]; stages];
    let mut next = vec![vec![None; n]; stages];
    for &i in &candidates[stages - 1] {
        viable[stages - 1][i] = true;
    }
    for stage in (0..stages - 1).rev() {
        for &i in &candidates[stage] {
            let start = set.frames[i].range.start_sample.0;
            let window = query.steps[stage + 1].within.as_ref();
            let first = candidates[stage + 1].partition_point(|&j| {
                j <= i
                    || window.is_some_and(|w| {
                        set.frames[j].range.start_sample.0 - start < w.min_samples.0
                    })
            });
            for &j in &candidates[stage + 1][first..] {
                if cancel.load(Ordering::Acquire) {
                    return Err(AnalysisError::Cancelled);
                }
                let delay = set.frames[j].range.start_sample.0 - start;
                if window.is_some_and(|w| delay > w.max_samples.0) {
                    break;
                }
                if page.comparisons.0 == MAX_SEQUENCE_COMPARISONS as u64 {
                    return Ok(page);
                }
                page.comparisons.0 += 1;
                if groups
                    .as_ref()
                    .is_some_and(|g| g.by_frame[i] != g.by_frame[j])
                {
                    continue;
                }
                if viable[stage + 1][j] {
                    viable[stage][i] = true;
                    next[stage][i] = Some(j);
                    break;
                }
            }
        }
    }
    page.search_complete = true;
    page.total_matches =
        Some((candidates[0].iter().filter(|&&i| viable[0][i]).count() as u64).into());
    let mut bytes = 0;
    for &i in candidates[0]
        .iter()
        .filter(|&&i| i >= offset && viable[0][i])
    {
        if cancel.load(Ordering::Acquire) {
            return Err(AnalysisError::Cancelled);
        }
        let mut frames = Vec::new();
        let mut current = i;
        for stage in 0..stages {
            frames.push(query.steps[stage].query.project(&set.frames[current]));
            if stage + 1 < stages {
                current = next[stage][current].unwrap();
            }
        }
        let matched = SequenceMatch {
            range: SampleRange {
                start_sample: frames[0].range.start_sample,
                end_sample: frames.iter().map(|f| f.range.end_sample).max().unwrap(),
            },
            frames,
        };
        let size = serde_json::to_vec(&matched)
            .map_err(|e| invalid(&e.to_string()))?
            .len();
        if size > MAX_FRAME_PAGE_BYTES {
            return Err(invalid(
                "individual sequence exceeds 128 KiB; use field projection",
            ));
        }
        if page.items.len() == limit || bytes + size > MAX_FRAME_PAGE_BYTES {
            page.next_offset = Some(i);
            page.stop_reason = "page_limit".into();
            return Ok(page);
        }
        bytes += size;
        page.items.push(matched);
    }
    page.complete = true;
    page.stop_reason = "end_of_result".into();
    Ok(page)
}

struct TransactionGroup {
    start: usize,
    end: usize,
    start_known: bool,
    end_known: bool,
    segments: Vec<usize>,
}
struct SegmentGroup {
    start: usize,
    end: usize,
    transaction: usize,
    start_known: bool,
    termination: &'static str,
}
struct I2cGroups {
    transactions: Vec<TransactionGroup>,
    segments: Vec<SegmentGroup>,
    by_frame: Vec<usize>,
}
fn i2c_groups(set: &FrameSet) -> Result<I2cGroups> {
    validate_set(set)?;
    if set.protocol != "I2C" {
        return Err(invalid(
            "I2C transaction/segment scope requires an I2C result",
        ));
    }
    let mut groups = I2cGroups {
        transactions: vec![],
        segments: vec![],
        by_frame: vec![0; set.frames.len()],
    };
    let mut active: Option<usize> = None;
    let mut segment: Option<usize> = None;
    for (i, frame) in set.frames.iter().enumerate() {
        let is_start = frame.row == "start";
        let is_stop = frame.row == "stop";
        if active.is_none() {
            let t = groups.transactions.len();
            groups.transactions.push(TransactionGroup {
                start: i,
                end: i + 1,
                start_known: is_start,
                end_known: false,
                segments: vec![],
            });
            active = Some(t);
        }
        if is_start || segment.is_none() {
            if let Some(s) = segment {
                groups.segments[s].termination = "repeated_start";
            }
            let t = active.unwrap();
            let s = groups.segments.len();
            groups.segments.push(SegmentGroup {
                start: i,
                end: i + 1,
                transaction: t,
                start_known: is_start,
                termination: "result_end",
            });
            groups.transactions[t].segments.push(s);
            segment = Some(s);
        }
        let s = segment.unwrap();
        let t = active.unwrap();
        groups.by_frame[i] = s;
        groups.segments[s].end = i + 1;
        groups.transactions[t].end = i + 1;
        if is_stop {
            groups.segments[s].termination = "stop";
            groups.transactions[t].end_known = true;
            active = None;
            segment = None;
        }
    }
    Ok(groups)
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TransactionQuery {
    pub range: Option<SampleRange>,
    #[serde(default)]
    pub conditions: Vec<FrameQuery>,
    #[serde(default)]
    pub require_complete: bool,
}
#[derive(Debug, Clone, Serialize)]
pub struct TransactionIdentity {
    pub transaction_id: ExactU64,
    pub range: SampleRange,
    pub complete: bool,
    pub start_known: bool,
    pub stop_known: bool,
    pub segment_count: ExactU64,
}
#[derive(Debug, Clone, Serialize)]
pub struct TransactionMatch {
    pub transaction: TransactionIdentity,
    pub segment_id: ExactU64,
    pub range: SampleRange,
    pub start_known: bool,
    pub termination: String,
    pub frame_count: ExactU64,
    pub condition_frames: Vec<ProtocolFrame>,
}
#[derive(Debug, Clone, Serialize)]
pub struct TransactionPage {
    pub items: Vec<TransactionMatch>,
    pub inspected_frames: ExactU64,
    pub complete: bool,
    pub next_offset: Option<usize>,
}
pub fn query_transactions(
    set: &FrameSet,
    query: &TransactionQuery,
    offset: usize,
    limit: usize,
    cancel: &AtomicBool,
) -> Result<TransactionPage> {
    let range = validate_page(set, query, query.range, offset, limit)?;
    if query.conditions.len() > 8 {
        return Err(invalid(
            "transaction query permits at most 8 same-segment conditions",
        ));
    }
    for condition in &query.conditions {
        condition.validate(set)?;
    }
    let groups = i2c_groups(set)?;
    let mut page = TransactionPage {
        items: vec![],
        inspected_frames: (set.frames.len() as u64).into(),
        complete: false,
        next_offset: None,
    };
    let mut bytes = 0;
    for segment in groups.segments.iter().filter(|s| s.start >= offset) {
        if cancel.load(Ordering::Acquire) {
            return Err(AnalysisError::Cancelled);
        }
        let transaction = &groups.transactions[segment.transaction];
        let observed = envelope(set, segment.start, segment.end);
        if !range.is_some_and(|r| overlaps(observed, r))
            || (query.require_complete && (!transaction.start_known || !transaction.end_known))
        {
            continue;
        }
        let mut witnesses = Vec::new();
        for condition in &query.conditions {
            let mut witness = None;
            for frame in &set.frames[segment.start..segment.end] {
                if cancel.load(Ordering::Acquire) {
                    return Err(AnalysisError::Cancelled);
                }
                if condition.matches(frame) {
                    witness = Some(frame);
                    break;
                }
            }
            if let Some(frame) = witness {
                witnesses.push(condition.project(frame));
            } else {
                break;
            }
        }
        if witnesses.len() != query.conditions.len() {
            continue;
        }
        let item = TransactionMatch {
            transaction: TransactionIdentity {
                transaction_id: set.frames[transaction.start].frame_id,
                range: envelope(set, transaction.start, transaction.end),
                complete: transaction.start_known && transaction.end_known,
                start_known: transaction.start_known,
                stop_known: transaction.end_known,
                segment_count: (transaction.segments.len() as u64).into(),
            },
            segment_id: set.frames[segment.start].frame_id,
            range: observed,
            start_known: segment.start_known,
            termination: segment.termination.into(),
            frame_count: ((segment.end - segment.start) as u64).into(),
            condition_frames: witnesses,
        };
        let size = serde_json::to_vec(&item)
            .map_err(|e| invalid(&e.to_string()))?
            .len();
        if size > MAX_FRAME_PAGE_BYTES {
            return Err(invalid(
                "individual transaction match exceeds 128 KiB; use field projection",
            ));
        }
        if page.items.len() == limit || bytes + size > MAX_FRAME_PAGE_BYTES {
            page.next_offset = Some(segment.start);
            return Ok(page);
        }
        bytes += size;
        page.items.push(item);
    }
    page.complete = true;
    Ok(page)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frames::{FieldFilter, FieldOperator, FieldSchema, FieldValue};
    use std::collections::BTreeMap;
    fn fixture(rows: &[(&str, u64, Option<u64>, Option<bool>)], shift: u64) -> FrameSet {
        let frames = rows
            .iter()
            .enumerate()
            .map(|(i, (row, sample, address, ack))| {
                let mut fields = BTreeMap::new();
                if let Some(a) = address {
                    fields.insert("address".into(), FieldValue::Unsigned((*a).into()));
                }
                if let Some(ack) = ack {
                    fields.insert("ack".into(), FieldValue::Boolean(*ack));
                }
                ProtocolFrame {
                    frame_id: (i as u64 + 1).into(),
                    range: SampleRange::new(shift + sample, shift + sample + 1, shift + 100)
                        .unwrap(),
                    row: row.to_string(),
                    texts: vec![],
                    fields,
                    configured_channels: vec![0, 1],
                    native_start_sample: (shift + sample).into(),
                    native_end_sample: (shift + sample + 1).into(),
                    native_endpoint_policy: "exclusive".into(),
                }
            })
            .collect::<Vec<_>>();
        let mut schema: BTreeMap<String, FieldSchema> = BTreeMap::new();
        for frame in &frames {
            for (name, value) in &frame.fields {
                let s = schema.entry(name.clone()).or_insert_with(|| FieldSchema {
                    name: name.clone(),
                    types: Default::default(),
                    rows: Default::default(),
                });
                s.types.insert(value.kind());
                s.rows.insert(frame.row.clone());
            }
        }
        FrameSet {
            backend: "fixture".into(),
            backend_protocol: "I2C".into(),
            protocol: "I2C".into(),
            processed_range: SampleRange::new(0, shift + 100, shift + 100).unwrap(),
            requested_range: SampleRange::new(shift, shift + 100, shift + 100).unwrap(),
            field_schema: schema.into_values().collect(),
            schema_scope: "fixture".into(),
            configuration: serde_json::json!({}),
            frames,
            diagnostics: vec![],
        }
    }
    fn row(row: &str) -> FrameQuery {
        FrameQuery {
            rows: vec![row.into()],
            ..Default::default()
        }
    }
    fn field(name: &str, value: FieldValue) -> FrameQuery {
        FrameQuery {
            fields: vec![FieldFilter {
                name: name.into(),
                op: FieldOperator::Eq,
                value: Some(value),
            }],
            ..Default::default()
        }
    }
    fn sequence(steps: Vec<FrameSequenceStep>) -> FrameSequenceQuery {
        FrameSequenceQuery {
            schema_version: "1".into(),
            scope: SequenceScope::Stream,
            range: None,
            steps,
        }
    }
    fn step(query: FrameQuery, min: u64, max: u64) -> FrameSequenceStep {
        FrameSequenceStep {
            query,
            within: Some(FrameDelay {
                min_samples: min.into(),
                max_samples: max.into(),
            }),
        }
    }
    #[test]
    fn suffix_viability_finds_later_intermediate_and_pages_without_reusing_frames() {
        let set = fixture(
            &[
                ("a", 2, None, None),
                ("b", 4, None, None),
                ("b", 8, None, None),
                ("c", 10, None, None),
                ("a", 20, None, None),
                ("b", 21, None, None),
                ("c", 23, None, None),
            ],
            0,
        );
        let query = sequence(vec![
            FrameSequenceStep {
                query: row("a"),
                within: None,
            },
            step(row("b"), 0, 10),
            step(row("c"), 2, 2),
        ]);
        let first = query_frame_sequence(&set, &query, 0, 1, &AtomicBool::new(false)).unwrap();
        assert!(first.search_complete);
        assert!(!first.complete);
        assert_eq!(first.total_matches.unwrap().0, 2);
        assert_eq!(
            first.items[0]
                .frames
                .iter()
                .map(|f| f.frame_id.0)
                .collect::<Vec<_>>(),
            vec![1, 3, 4]
        );
        let next = query_frame_sequence(
            &set,
            &query,
            first.next_offset.unwrap(),
            1,
            &AtomicBool::new(false),
        )
        .unwrap();
        assert!(next.complete);
        assert_eq!(next.items[0].frames[0].frame_id.0, 5);
        let duplicate = sequence(vec![
            FrameSequenceStep {
                query: row("c"),
                within: None,
            },
            step(row("c"), 0, 0),
        ]);
        assert!(
            query_frame_sequence(&set, &duplicate, 0, 100, &AtomicBool::new(false))
                .unwrap()
                .items
                .is_empty()
        );
    }
    #[test]
    fn repeated_start_segments_prevent_address_and_nack_from_different_targets() {
        let set = fixture(
            &[
                ("start", 1, None, None),
                ("address", 2, Some(80), Some(true)),
                ("data", 4, None, Some(true)),
                ("start", 6, None, None),
                ("address", 7, Some(81), Some(true)),
                ("data", 9, None, Some(false)),
                ("stop", 11, None, None),
            ],
            0,
        );
        let address = field("address", FieldValue::Unsigned(80.into()));
        let nack = field("ack", FieldValue::Boolean(false));
        let mut query = sequence(vec![
            FrameSequenceStep {
                query: address.clone(),
                within: None,
            },
            step(nack.clone(), 0, 20),
        ]);
        assert_eq!(
            query_frame_sequence(&set, &query, 0, 100, &AtomicBool::new(false))
                .unwrap()
                .items
                .len(),
            1
        );
        query.scope = SequenceScope::I2cSegment;
        assert!(
            query_frame_sequence(&set, &query, 0, 100, &AtomicBool::new(false))
                .unwrap()
                .items
                .is_empty()
        );
        let mut query = TransactionQuery {
            conditions: vec![address, nack.clone()],
            require_complete: true,
            range: None,
        };
        assert!(
            query_transactions(&set, &query, 0, 100, &AtomicBool::new(false))
                .unwrap()
                .items
                .is_empty()
        );
        query.conditions[0] = field("address", FieldValue::Unsigned(81.into()));
        let result = query_transactions(&set, &query, 0, 100, &AtomicBool::new(false)).unwrap();
        assert_eq!(result.items.len(), 1);
        assert_eq!(result.items[0].transaction.segment_count.0, 2);
        assert_eq!(result.items[0].segment_id.0, 4);
        assert_eq!(result.items[0].transaction.transaction_id.0, 1);
        assert!(result.items[0].transaction.complete);
    }
    #[test]
    fn incomplete_transactions_keep_prefix_context_and_distinguish_zero_matches() {
        let mut set = fixture(
            &[
                ("data", 1, None, Some(false)),
                ("stop", 2, None, None),
                ("start", 3, None, None),
                ("address", 4, Some(80), Some(true)),
                ("data", 8, None, Some(false)),
            ],
            0,
        );
        set.requested_range = SampleRange::new(7, 10, 100).unwrap();
        let query = TransactionQuery {
            conditions: vec![
                field("address", FieldValue::Unsigned(80.into())),
                field("ack", FieldValue::Boolean(false)),
            ],
            require_complete: false,
            range: None,
        };
        let result = query_transactions(&set, &query, 0, 100, &AtomicBool::new(false)).unwrap();
        assert_eq!(result.items.len(), 1);
        assert!(!result.items[0].transaction.complete);
        assert_eq!(result.items[0].termination, "result_end");
        assert_eq!(result.items[0].condition_frames[0].range.start_sample.0, 4);
        assert!(query_transactions(
            &set,
            &TransactionQuery {
                require_complete: true,
                ..query
            },
            0,
            100,
            &AtomicBool::new(false)
        )
        .unwrap()
        .items
        .is_empty());
        let all = query_transactions(
            &set,
            &TransactionQuery {
                range: None,
                conditions: vec![],
                require_complete: false,
            },
            0,
            100,
            &AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!(all.items.len(), 1);
    }
    #[test]
    fn huge_coordinates_delay_edges_missing_fields_and_cancellation_are_exact() {
        let shift = (1u64 << 53) + 101;
        let set = fixture(
            &[
                ("start", 1, None, None),
                ("address", 2, Some(80), None),
                ("data", 7, None, Some(false)),
                ("stop", 8, None, None),
            ],
            shift,
        );
        let query = sequence(vec![
            FrameSequenceStep {
                query: row("address"),
                within: None,
            },
            step(row("data"), 5, 5),
        ]);
        let result = query_frame_sequence(&set, &query, 0, 100, &AtomicBool::new(false)).unwrap();
        assert_eq!(result.items[0].range.start_sample.0, shift + 2);
        assert_eq!(result.items[0].range.end_sample.0, shift + 8);
        assert!(matches!(
            query_frame_sequence(&set, &query, 0, 100, &AtomicBool::new(true)),
            Err(AnalysisError::Cancelled)
        ));
        let query = TransactionQuery {
            conditions: vec![FrameQuery {
                rows: vec!["address".into()],
                fields: field("ack", FieldValue::Boolean(false)).fields,
                ..Default::default()
            }],
            require_complete: false,
            range: None,
        };
        assert!(
            query_transactions(&set, &query, 0, 100, &AtomicBool::new(false))
                .unwrap()
                .items
                .is_empty()
        );
    }
    #[test]
    fn comparison_budget_never_reports_incomplete_search_as_a_negative() {
        let mut rows: Vec<(&str, u64, Option<u64>, Option<bool>)> = Vec::new();
        for i in 0..3000 {
            rows.push((if i < 1500 { "a" } else { "b" }, i as u64, None, None));
        }
        let mut set = fixture(&[], 0);
        set.processed_range = SampleRange::new(0, 4000, 4000).unwrap();
        set.requested_range = set.processed_range;
        set.frames = rows
            .iter()
            .enumerate()
            .map(|(i, (row, sample, _, _))| ProtocolFrame {
                frame_id: (i as u64 + 1).into(),
                range: SampleRange::new(*sample, *sample + 1, 4000).unwrap(),
                row: row.to_string(),
                texts: vec![],
                fields: BTreeMap::new(),
                configured_channels: vec![0],
                native_start_sample: (*sample).into(),
                native_end_sample: (*sample + 1).into(),
                native_endpoint_policy: "exclusive".into(),
            })
            .collect();
        let query = sequence(vec![
            FrameSequenceStep {
                query: row("a"),
                within: None,
            },
            step(row("b"), 0, 4000),
            step(row("absent"), 0, 4000),
        ]);
        let result = query_frame_sequence(&set, &query, 0, 100, &AtomicBool::new(false)).unwrap();
        assert!(!result.search_complete);
        assert!(!result.complete);
        assert!(result.total_matches.is_none());
        assert_eq!(result.stop_reason, "comparison_budget");
        assert!(result.next_offset.is_none());
    }
}
