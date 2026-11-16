//! Exact, bounded reads over the same edge indexes used by the desktop.

use std::sync::atomic::Ordering;

use sigpilot_core::{CaptureMetadata, DigitalChannelWindow};

use crate::{GraphError, GraphSession};

/// At most 32 KiB of edge coordinates is copied per read, irrespective of the
/// duration or total edge count of the recording.
pub const MAX_DIGITAL_WINDOW_EDGES: usize = 4_096;

#[derive(Debug, Clone)]
pub struct GraphCaptureSnapshot {
    pub instance_id: u64,
    pub capture_generation: u64,
    pub data_revision: u64,
    pub finalized: bool,
    pub metadata: CaptureMetadata,
}

#[derive(Debug, Clone)]
pub struct DigitalWindowSnapshot {
    pub capture: GraphCaptureSnapshot,
    pub window: DigitalChannelWindow,
}

/// Keep a finalized capture's identity stable during a short document commit.
/// Do not invoke capture mutators or acquire another lease while holding this.
pub struct FrozenCaptureLease<'a> {
    snapshot: GraphCaptureSnapshot,
    _guard: parking_lot::MutexGuard<'a, ()>,
}

impl FrozenCaptureLease<'_> {
    pub fn snapshot(&self) -> &GraphCaptureSnapshot { &self.snapshot }
}

#[derive(Debug, thiserror::Error)]
pub enum ReadError {
    #[error("capture changed; reacquire its snapshot")]
    VersionConflict,
    #[error("capture is still being recorded")]
    CaptureNotFinalized,
    #[error("invalid channel, half-open range, or edge limit")]
    InvalidRequest,
    #[error(transparent)]
    Graph(#[from] GraphError),
}

impl GraphSession {
    pub fn capture_snapshot(&self) -> Result<GraphCaptureSnapshot, ReadError> {
        let _mutation = self.capture_mutation.lock();
        self.capture_snapshot_locked()
    }

    fn capture_snapshot_locked(&self) -> Result<GraphCaptureSnapshot, ReadError> {
        let graph = self.graph.read();
        let graph = graph.as_ref().ok_or(GraphError::EmptyGraph)?;
        Ok(GraphCaptureSnapshot {
            instance_id: self.instance_id,
            capture_generation: self.capture_generation.load(Ordering::Acquire),
            data_revision: self.revision(),
            finalized: self.capture.read().is_some() || self.sparse_capture.read().is_some(),
            metadata: graph.metadata().clone(),
        })
    }

    pub fn frozen_capture_lease(&self, generation: u64, revision: u64) -> Result<FrozenCaptureLease<'_>, ReadError> {
        let lease = self.capture_state_lease(generation, revision)?;
        if !lease.snapshot.finalized { return Err(ReadError::CaptureNotFinalized); }
        Ok(lease)
    }

    /// State inspection may also lease an active capture; analysis still uses
    /// frozen_capture_lease and requires finalized backing data.
    pub fn capture_state_lease(&self, generation: u64, revision: u64) -> Result<FrozenCaptureLease<'_>, ReadError> {
        let guard = self.capture_mutation.lock();
        let snapshot = self.capture_snapshot_locked()?;
        if snapshot.capture_generation != generation || snapshot.data_revision != revision {
            return Err(ReadError::VersionConflict);
        }
        Ok(FrozenCaptureLease { snapshot, _guard: guard })
    }

    /// Exact windows never downsample or silently clamp. When there are more
    /// edges than the limit, end_sample is the next unconsumed edge coordinate;
    /// using it as the next page's start joins the half-open pages exactly.
    pub fn digital_edge_window(
        &self,
        expected_generation: u64,
        expected_revision: u64,
        channel: u8,
        start: u64,
        end: u64,
        limit: usize,
    ) -> Result<DigitalWindowSnapshot, ReadError> {
        if limit == 0 || limit > MAX_DIGITAL_WINDOW_EDGES {
            return Err(ReadError::InvalidRequest);
        }
        let _mutation = self.capture_mutation.lock();
        let generation = self.capture_generation.load(Ordering::Acquire);
        let revision = self.revision();
        if generation != expected_generation || revision != expected_revision {
            return Err(ReadError::VersionConflict);
        }
        if self.capture.read().is_none() && self.sparse_capture.read().is_none() {
            return Err(ReadError::CaptureNotFinalized);
        }
        let graph = self.graph.read();
        let graph = graph.as_ref().ok_or(GraphError::EmptyGraph)?;
        if start >= end
            || end > graph.sample_count()
            || channel >= graph.metadata.channel_count
            || (!graph.metadata.enabled_channels.is_empty()
                && !graph.metadata.enabled_channels.contains(&channel))
        {
            return Err(ReadError::InvalidRequest);
        }
        let index = &graph.channels[usize::from(channel)];
        let begin = index.edges.partition_point(|edge| *edge < start);
        let requested_end = index.edges.partition_point(|edge| *edge < end);
        let page_end = requested_end.min(begin.saturating_add(limit));
        let complete = page_end == requested_end;
        let covered_end = if complete { end } else { index.edges[page_end] };
        let high_before_start = index.initial_high ^ (begin % 2 == 1);
        Ok(DigitalWindowSnapshot {
            capture: GraphCaptureSnapshot {
                instance_id: self.instance_id,
                capture_generation: generation,
                data_revision: revision,
                finalized: true,
                metadata: graph.metadata().clone(),
            },
            window: DigitalChannelWindow {
                channel,
                sample_rate_hz: graph.metadata.sample_rate_hz,
                capture_sample_count: graph.sample_count(),
                start_sample: start,
                end_sample: covered_end,
                requested_end_sample: end,
                high_before_start,
                previous_transition: begin.checked_sub(1).map(|i| index.edges[i]),
                next_transition: index.edges.get(page_end).copied(),
                transitions: index.edges[begin..page_end].to_vec(),
                complete,
            },
        })
    }
}

#[cfg(test)]
mod tests {
    use sigpilot_core::{CaptureData, SparseCaptureData, SparseDigitalChannel};

    use super::*;

    fn metadata(count: u64) -> CaptureMetadata {
        CaptureMetadata {
            version: 1,
            source_device: "fixture".into(),
            sample_rate_hz: 1_000_000_000,
            channel_count: 1,
            enabled_channels: vec![0],
            unitsize: 1,
            sample_count: count,
            captured_at: chrono::Utc::now(),
            labels: vec!["D0".into()],
            trigger: None,
        }
    }

    #[test]
    fn reads_dense_and_sparse_from_the_same_exact_index() {
        let packed = GraphSession::default();
        let sparse = GraphSession::default();
        let meta = metadata(10);
        packed.replace_capture(CaptureData { metadata: meta.clone(), samples: vec![0, 0, 1, 1, 0, 0, 1, 1, 1, 0] }).unwrap();
        sparse.replace_sparse_capture(SparseCaptureData { metadata: meta, channels: vec![SparseDigitalChannel { channel: 0, initial_high: false, transitions: vec![2, 4, 6, 9] }] }).unwrap();
        let read = |session: &GraphSession| {
            let snapshot = session.capture_snapshot().unwrap();
            session.digital_edge_window(snapshot.capture_generation, snapshot.data_revision, 0, 3, 9, 10).unwrap().window
        };
        assert_eq!(read(&packed), read(&sparse));
        let window = read(&packed);
        assert!(window.high_before_start);
        assert_eq!(window.transitions, vec![4, 6]);
        assert_eq!(window.previous_transition, Some(2));
        assert_eq!(window.next_transition, Some(9));
    }

    #[test]
    fn pages_huge_sparse_coordinates_without_floating_point_or_gaps() {
        let base = (1u64 << 53) + 1;
        let session = GraphSession::default();
        session.replace_sparse_capture(SparseCaptureData {
            metadata: metadata(base + 10),
            channels: vec![SparseDigitalChannel { channel: 0, initial_high: false, transitions: vec![base, base + 2, base + 7] }],
        }).unwrap();
        let snapshot = session.capture_snapshot().unwrap();
        let first = session.digital_edge_window(snapshot.capture_generation, snapshot.data_revision, 0, base, base + 10, 1).unwrap();
        assert_eq!(first.window.transitions, vec![base]);
        assert_eq!(first.window.end_sample, base + 2);
        assert!(!first.window.complete);
        let next = session.digital_edge_window(snapshot.capture_generation, snapshot.data_revision, 0, first.window.end_sample, base + 10, 4).unwrap();
        assert_eq!(next.window.transitions, vec![base + 2, base + 7]);
        assert!(next.window.complete);
        assert!(next.window.high_before_start);
    }

    #[test]
    fn rejects_stale_snapshots_active_capture_and_oversized_reads() {
        let session = GraphSession::default();
        session.begin_capture(metadata(10)).unwrap();
        let active = session.capture_snapshot().unwrap();
        assert!(!active.finalized);
        assert!(matches!(session.digital_edge_window(active.capture_generation, active.data_revision, 0, 0, 10, 1), Err(ReadError::CaptureNotFinalized)));
        session.replace_capture(CaptureData { metadata: metadata(10), samples: vec![0; 10] }).unwrap();
        assert!(matches!(session.digital_edge_window(active.capture_generation, active.data_revision, 0, 0, 10, 1), Err(ReadError::VersionConflict)));
        let ready = session.capture_snapshot().unwrap();
        assert!(matches!(session.digital_edge_window(ready.capture_generation, ready.data_revision, 0, 0, 11, 1), Err(ReadError::InvalidRequest)));
        assert!(matches!(session.digital_edge_window(ready.capture_generation, ready.data_revision, 0, 0, 10, MAX_DIGITAL_WINDOW_EDGES + 1), Err(ReadError::InvalidRequest)));
        session.trim_capture(0, 5).unwrap();
        assert!(matches!(session.digital_edge_window(ready.capture_generation, ready.data_revision, 0, 0, 5, 1), Err(ReadError::VersionConflict)));
    }
}
