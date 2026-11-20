//! GUI-reported channel geometry and bounded, acknowledged layout requests.
//!
//! A request receipt is deliberately not an assertion that a desktop rendered it.
//! The current pending command is included in reads/reports so missed events can
//! be recovered by the desktop's normal workbench resynchronization.
use crate::{
    synchronize, valid_channel, validate_id, Caller, CaptureRef, GraphCaptureSnapshot, Result,
    WorkbenchError, WorkbenchEvent, WorkbenchService,
};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;

const MAX_HISTORY: usize = 16;
const MAX_GUI_PIXELS: f64 = 10_000_000.0;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ChannelRowHeight {
    pub channel: u8,
    pub height_px: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "mode", rename_all = "snake_case", deny_unknown_fields)]
pub enum ChannelLayoutAction {
    Fit,
    Manual { rows: Vec<ChannelRowHeight> },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SetChannelLayoutRequest {
    pub capture: CaptureRef,
    pub request_id: String,
    pub action: ChannelLayoutAction,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ChannelLayoutRow {
    pub channel: u8,
    /// Digital waveform body height, excluding decoder strips.
    pub height_px: f64,
    pub top_inset_px: f64,
    pub visible: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ChannelLayout {
    pub automatic: bool,
    pub viewport_height_px: f64,
    pub content_height_px: f64,
    pub scroll_top_px: f64,
    /// Includes all captured digital channels, including hidden channels.
    pub rows: Vec<ChannelLayoutRow>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelLayoutCommand {
    pub command_id: String,
    pub request_id: String,
    pub action: ChannelLayoutAction,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ChannelLayoutCommandState {
    Pending,
    Applied,
    Superseded,
}

#[derive(Debug, Clone, Serialize)]
pub struct ChannelLayoutReceipt {
    pub capture: CaptureRef,
    pub request_id: String,
    pub command_id: String,
    pub state: ChannelLayoutCommandState,
    /// Latest GUI report. Only state=applied confirms this command was applied.
    pub layout: Option<ChannelLayout>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ChannelLayoutStatus {
    pub capture: CaptureRef,
    /// Latest geometry reported by the desktop, not a new synchronous measure.
    pub layout: Option<ChannelLayout>,
    pub pending: Option<ChannelLayoutCommand>,
    pub last_applied_command_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReportChannelLayoutRequest {
    pub capture: CaptureRef,
    pub layout: ChannelLayout,
    #[serde(default)]
    pub applied_command_id: Option<String>,
}

struct RequestRecord {
    owner: String,
    command: ChannelLayoutCommand,
    state: ChannelLayoutCommandState,
}

#[derive(Default)]
pub(crate) struct LayoutState {
    layout: Option<ChannelLayout>,
    history: VecDeque<RequestRecord>,
    last_applied_command_id: Option<String>,
}

impl LayoutState {
    fn status(&self, capture: &CaptureRef) -> ChannelLayoutStatus {
        ChannelLayoutStatus {
            capture: capture.clone(),
            layout: self.layout.clone(),
            pending: self
                .history
                .iter()
                .find(|record| record.state == ChannelLayoutCommandState::Pending)
                .map(|record| record.command.clone()),
            last_applied_command_id: self.last_applied_command_id.clone(),
        }
    }

    fn receipt(&self, capture: &CaptureRef, record: &RequestRecord) -> ChannelLayoutReceipt {
        ChannelLayoutReceipt {
            capture: capture.clone(),
            request_id: record.command.request_id.clone(),
            command_id: record.command.command_id.clone(),
            state: record.state,
            layout: self.layout.clone(),
        }
    }
}

impl WorkbenchService {
    pub fn get_channel_layout(&self, capture: &CaptureRef) -> Result<ChannelLayoutStatus> {
        let session = self.existing_session(&capture.session_id)?;
        let lease = self.lease(&session, capture)?;
        let mut document = session.document.lock();
        synchronize(&mut document, lease.snapshot().capture_generation);
        if !document.gui_attached {
            return Err(WorkbenchError::GuiUnavailable);
        }
        Ok(document.channel_layout.status(capture))
    }

    pub fn set_channel_layout(
        &self,
        caller: Caller<'_>,
        request: &SetChannelLayoutRequest,
    ) -> Result<ChannelLayoutReceipt> {
        validate_id(&request.request_id)?;
        let session = self.existing_session(&request.capture.session_id)?;
        let lease = self.lease(&session, &request.capture)?;
        let snapshot = lease.snapshot();
        validate_action(&request.action, snapshot)?;
        let mut document = session.document.lock();
        synchronize(&mut document, snapshot.capture_generation);
        if !document.gui_attached {
            return Err(WorkbenchError::GuiUnavailable);
        }
        let state = &mut document.channel_layout;
        if let Some(record) = state.history.iter().find(|record| {
            record.owner == caller.id && record.command.request_id == request.request_id
        }) {
            if record.command.action != request.action {
                return Err(WorkbenchError::RequestIdConflict);
            }
            return Ok(state.receipt(&request.capture, record));
        }
        for record in &mut state.history {
            if record.state == ChannelLayoutCommandState::Pending {
                record.state = ChannelLayoutCommandState::Superseded;
            }
        }
        let command = ChannelLayoutCommand {
            command_id: format!("layout-{}", uuid::Uuid::new_v4().simple()),
            request_id: request.request_id.clone(),
            action: request.action.clone(),
        };
        state.history.push_back(RequestRecord {
            owner: caller.id.into(),
            command: command.clone(),
            state: ChannelLayoutCommandState::Pending,
        });
        while state.history.len() > MAX_HISTORY {
            state.history.pop_front();
        }
        let receipt = state.receipt(&request.capture, state.history.back().unwrap());
        drop(document);
        self.publish(WorkbenchEvent::ChannelLayoutRequested {
            capture: request.capture.clone(),
            command,
        });
        Ok(receipt)
    }

    /// Trusted GUI IPC only. MCP clients cannot acknowledge their own request.
    pub fn report_channel_layout(
        &self,
        request: &ReportChannelLayoutRequest,
    ) -> Result<ChannelLayoutStatus> {
        let session = self.existing_session(&request.capture.session_id)?;
        let lease = self.lease(&session, &request.capture)?;
        validate_layout(&request.layout, lease.snapshot())?;
        let mut document = session.document.lock();
        synchronize(&mut document, lease.snapshot().capture_generation);
        if !document.gui_attached {
            return Err(WorkbenchError::GuiUnavailable);
        }
        let state = &mut document.channel_layout;
        if let Some(command_id) = &request.applied_command_id {
            // A late GUI acknowledgement must not rewind a newer pending or
            // applied command, including when the old command was once applied.
            if !state
                .history
                .back()
                .is_some_and(|record| &record.command.command_id == command_id)
            {
                return Err(WorkbenchError::RequestIdConflict);
            }
            let record = state
                .history
                .iter_mut()
                .find(|record| &record.command.command_id == command_id)
                .ok_or(WorkbenchError::RequestIdConflict)?;
            if record.state == ChannelLayoutCommandState::Superseded {
                return Err(WorkbenchError::RequestIdConflict);
            }
            if !action_matches_layout(&record.command.action, &request.layout) {
                return Err(WorkbenchError::InvalidRequest(
                    "GUI layout does not match the acknowledged command".into(),
                ));
            }
            record.state = ChannelLayoutCommandState::Applied;
            state.last_applied_command_id = Some(command_id.clone());
        }
        state.layout = Some(request.layout.clone());
        Ok(state.status(&request.capture))
    }
}

fn validate_action(action: &ChannelLayoutAction, snapshot: &GraphCaptureSnapshot) -> Result<()> {
    if let ChannelLayoutAction::Manual { rows } = action {
        if rows.is_empty() || rows.len() > 32 {
            return Err(WorkbenchError::InvalidRequest(
                "manual layout needs 1..32 channel heights".into(),
            ));
        }
        for (index, row) in rows.iter().enumerate() {
            if !(28..=1000).contains(&row.height_px)
                || !valid_channel(snapshot, row.channel)
                || rows[..index].iter().any(|old| old.channel == row.channel)
            {
                return Err(WorkbenchError::InvalidRequest(
                    "use distinct captured channels with integer heights of 28..1000 CSS pixels"
                        .into(),
                ));
            }
        }
    }
    Ok(())
}

fn validate_layout(layout: &ChannelLayout, snapshot: &GraphCaptureSnapshot) -> Result<()> {
    let dimension = |value: f64| value.is_finite() && (0.0..=MAX_GUI_PIXELS).contains(&value);
    let channels = (0..snapshot.metadata.channel_count)
        .filter(|channel| valid_channel(snapshot, *channel))
        .count();
    if layout.viewport_height_px <= 0.0
        || !dimension(layout.viewport_height_px)
        || !dimension(layout.content_height_px)
        || !dimension(layout.scroll_top_px)
        || layout.rows.len() != channels
        || layout.rows.len() > 32
        || layout.content_height_px + 1.0 < layout.viewport_height_px
        || layout.scroll_top_px
            > (layout.content_height_px - layout.viewport_height_px).max(0.0) + 1.0
    {
        return Err(WorkbenchError::InvalidRequest(
            "invalid GUI layout geometry".into(),
        ));
    }
    for (index, row) in layout.rows.iter().enumerate() {
        if !valid_channel(snapshot, row.channel)
            || layout.rows[..index]
                .iter()
                .any(|old| old.channel == row.channel)
            || row.height_px < 28.0
            || !dimension(row.height_px)
            || !dimension(row.top_inset_px)
        {
            return Err(WorkbenchError::InvalidRequest(
                "invalid GUI channel rows".into(),
            ));
        }
    }
    Ok(())
}

fn action_matches_layout(action: &ChannelLayoutAction, layout: &ChannelLayout) -> bool {
    match action {
        ChannelLayoutAction::Fit => layout.automatic && layout.scroll_top_px.abs() <= 1.0,
        ChannelLayoutAction::Manual { rows } => {
            !layout.automatic
                && rows.iter().all(|requested| {
                    layout.rows.iter().any(|row| {
                        row.channel == requested.channel
                            && (row.height_px - f64::from(requested.height_px)).abs() <= 0.5
                    })
                })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::AnnotationSource;

    fn caller() -> Caller<'static> {
        Caller {
            id: "layout-assistant",
            source: AnnotationSource::Assistant,
        }
    }

    fn geometry(height: f64, automatic: bool) -> ChannelLayout {
        ChannelLayout {
            automatic,
            viewport_height_px: 400.0,
            content_height_px: 400.0,
            scroll_top_px: 0.0,
            rows: vec![ChannelLayoutRow {
                channel: 0,
                height_px: height,
                top_inset_px: 24.0,
                visible: true,
            }],
        }
    }

    fn request(
        service: &WorkbenchService,
        id: &str,
        action: ChannelLayoutAction,
    ) -> SetChannelLayoutRequest {
        SetChannelLayoutRequest {
            capture: service.context("session-a").unwrap().capture,
            request_id: id.into(),
            action,
        }
    }

    #[test]
    fn requests_need_actual_gui_ack_and_recover_through_status_without_events() {
        let service = crate::tests::service();
        service.set_gui_attached("session-a", true).unwrap();
        let before = service.context("session-a").unwrap();
        let input = request(
            &service,
            "height-1",
            ChannelLayoutAction::Manual {
                rows: vec![ChannelRowHeight {
                    channel: 0,
                    height_px: 48,
                }],
            },
        );
        let result = service.set_channel_layout(caller(), &input).unwrap();
        assert_eq!(result.state, ChannelLayoutCommandState::Pending);
        assert!(result.layout.is_none());
        // There is intentionally no event subscriber: the GUI can recover the
        // exact same command from the read/report path after reconnecting.
        let pending = service
            .get_channel_layout(&input.capture)
            .unwrap()
            .pending
            .unwrap();
        assert_eq!(pending.command_id, result.command_id);
        let mut report = ReportChannelLayoutRequest {
            capture: input.capture.clone(),
            layout: geometry(100.0, false),
            applied_command_id: None,
        };
        assert!(service
            .report_channel_layout(&report)
            .unwrap()
            .pending
            .is_some());
        report.applied_command_id = Some(result.command_id.clone());
        assert!(service.report_channel_layout(&report).is_err());
        report.layout = geometry(48.0, false);
        let applied = service.report_channel_layout(&report).unwrap();
        assert!(applied.pending.is_none());
        assert_eq!(
            applied.last_applied_command_id,
            Some(result.command_id.clone())
        );
        assert_eq!(applied.layout.unwrap().rows[0].height_px, 48.0);
        let replay = service.set_channel_layout(caller(), &input).unwrap();
        assert_eq!(replay.command_id, result.command_id);
        assert_eq!(replay.state, ChannelLayoutCommandState::Applied);
        let after = service.context("session-a").unwrap();
        assert_eq!(before.capture, after.capture);
        assert_eq!(before.annotation_revision, after.annotation_revision);
        assert_eq!(before.config_revision, after.config_revision);
    }

    #[test]
    fn superseded_commands_cannot_ack_or_replay_over_latest_layout() {
        let service = crate::tests::service();
        service.set_gui_attached("session-a", true).unwrap();
        let first = request(&service, "first", ChannelLayoutAction::Fit);
        let a = service.set_channel_layout(caller(), &first).unwrap();
        let mut conflicting = first.clone();
        conflicting.action = ChannelLayoutAction::Manual {
            rows: vec![ChannelRowHeight {
                channel: 0,
                height_px: 50,
            }],
        };
        assert!(matches!(
            service.set_channel_layout(caller(), &conflicting),
            Err(WorkbenchError::RequestIdConflict)
        ));
        let second = request(&service, "second", ChannelLayoutAction::Fit);
        let b = service.set_channel_layout(caller(), &second).unwrap();
        assert_ne!(a.command_id, b.command_id);
        assert_eq!(
            service.set_channel_layout(caller(), &first).unwrap().state,
            ChannelLayoutCommandState::Superseded
        );
        assert!(matches!(
            service.report_channel_layout(&ReportChannelLayoutRequest {
                capture: first.capture.clone(),
                layout: geometry(372.0, true),
                applied_command_id: Some(a.command_id),
            }),
            Err(WorkbenchError::RequestIdConflict)
        ));
        assert_eq!(
            service
                .get_channel_layout(&first.capture)
                .unwrap()
                .pending
                .unwrap()
                .command_id,
            b.command_id
        );
        let report = ReportChannelLayoutRequest {
            capture: first.capture,
            layout: geometry(372.0, true),
            applied_command_id: Some(b.command_id),
        };
        assert!(service
            .report_channel_layout(&report)
            .unwrap()
            .pending
            .is_none());
        let newest = service
            .set_channel_layout(
                caller(),
                &request(&service, "third", ChannelLayoutAction::Fit),
            )
            .unwrap();
        assert!(matches!(
            service.report_channel_layout(&report),
            Err(WorkbenchError::RequestIdConflict)
        ));
        assert_eq!(
            service
                .get_channel_layout(&report.capture)
                .unwrap()
                .pending
                .unwrap()
                .command_id,
            newest.command_id
        );
    }

    #[test]
    fn rejects_unattached_stale_uncaptured_duplicate_and_unbounded_requests() {
        let service = crate::tests::service();
        let fit = request(&service, "fit", ChannelLayoutAction::Fit);
        assert!(matches!(
            service.set_channel_layout(caller(), &fit),
            Err(WorkbenchError::GuiUnavailable)
        ));
        assert!(matches!(
            service.get_channel_layout(&fit.capture),
            Err(WorkbenchError::GuiUnavailable)
        ));
        service.set_gui_attached("session-a", true).unwrap();
        for rows in [
            vec![],
            vec![ChannelRowHeight {
                channel: 0,
                height_px: 27,
            }],
            vec![ChannelRowHeight {
                channel: 0,
                height_px: 1001,
            }],
            vec![ChannelRowHeight {
                channel: 1,
                height_px: 50,
            }],
            vec![
                ChannelRowHeight {
                    channel: 0,
                    height_px: 50
                };
                2
            ],
        ] {
            assert!(service
                .set_channel_layout(
                    caller(),
                    &request(&service, "bad", ChannelLayoutAction::Manual { rows })
                )
                .is_err());
        }
        let mut stale = fit.clone();
        stale.capture.data_revision = 999.into();
        assert!(matches!(
            service.set_channel_layout(caller(), &stale),
            Err(WorkbenchError::CaptureVersionConflict)
        ));
        assert!(service
            .report_channel_layout(&ReportChannelLayoutRequest {
                capture: fit.capture.clone(),
                layout: geometry(f64::NAN, false),
                applied_command_id: None,
            })
            .is_err());
        let mut missing = geometry(50.0, false);
        missing.rows.clear();
        assert!(service
            .report_channel_layout(&ReportChannelLayoutRequest {
                capture: fit.capture,
                layout: missing,
                applied_command_id: None,
            })
            .is_err());
    }
}
