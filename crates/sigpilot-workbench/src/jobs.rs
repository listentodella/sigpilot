//! Bounded domain jobs independent of MCP request/connection lifetimes.
use crate::{validate_id, CaptureRef, Result, WorkbenchError};
use parking_lot::{Condvar, Mutex};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sigpilot_analysis::frames::FrameSet;
use std::{
    collections::{BTreeMap, VecDeque},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

pub const JOB_RETENTION: Duration = Duration::from_secs(15 * 60);
const MAX_JOBS: usize = 16;
const MAX_PENDING: usize = 3; // one running and two queued globally
const MAX_RESULT_BYTES: usize = 4 * 1024 * 1024;
const MAX_RETAINED_BYTES: usize = 16 * 1024 * 1024;
const MAX_JOB_PARAMETER_BYTES: usize = 16 * 1024;

#[derive(Debug, Clone, Serialize)]
pub struct JobFailure {
    pub code: String,
    pub message: String,
}
impl JobFailure {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum JobState {
    Queued,
    Running,
    Completed,
    Failed,
    Cancelled,
}
impl JobState {
    fn terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Failed | Self::Cancelled)
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct JobSnapshot {
    pub job_id: String,
    pub capture: CaptureRef,
    pub kind: String,
    pub state: JobState,
    pub cancel_requested: bool,
    pub retention_seconds: String,
    pub result: Option<Value>,
    pub error: Option<JobFailure>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", content = "data", rename_all = "snake_case")]
pub enum JobOutput {
    Decode(FrameSet),
    Analysis(Value),
}
impl JobOutput {
    fn bytes(&self) -> std::result::Result<usize, JobFailure> {
        match self {
            Self::Decode(s) => serde_json::to_vec(s),
            Self::Analysis(v) => serde_json::to_vec(v),
        }
        .map(|b| b.len())
        .map_err(|e| JobFailure::new("INTERNAL_ERROR", e.to_string()))
    }
    pub(crate) fn summary(&self, id: &str) -> Value {
        match self {
            Self::Decode(s) => {
                json!({"result_set_id":id,"protocol":s.protocol,"backend":s.backend,"backend_protocol":s.backend_protocol,
            "frame_count":s.frames.len().to_string(),"processed_range":s.processed_range,"requested_range":s.requested_range,
            "field_schema":s.field_schema,"schema_scope":s.schema_scope,"configuration":s.configuration,"complete":true})
            }
            Self::Analysis(v) => v.clone(),
        }
    }
}

struct Entry {
    snapshot: JobSnapshot,
    owner: String,
    request_id: String,
    input: String,
    cancel: Arc<AtomicBool>,
    ended: Option<Instant>,
    output: Option<Arc<JobOutput>>,
    bytes: usize,
}
#[derive(Default)]
struct State {
    entries: BTreeMap<String, Entry>,
    queue: VecDeque<String>,
    running: Option<String>,
}

#[derive(Default)]
pub struct JobManager {
    state: Mutex<State>,
    wake: Condvar,
}

type JobTask =
    Box<dyn FnOnce(&AtomicBool) -> std::result::Result<JobOutput, JobFailure> + Send + 'static>;

impl JobManager {
    /// Reacquire a submitted job by its exact caller input before resolving a
    /// mutable analyzer instance. Editing that instance cannot change replay.
    pub(crate) fn replay(
        &self,
        owner: &str,
        capture: &CaptureRef,
        kind: &str,
        request_id: &str,
        input: &str,
    ) -> Result<Option<JobSnapshot>> {
        validate_id(owner)?;
        validate_id(request_id)?;
        let mut state = self.state.lock();
        purge(&mut state);
        if let Some(entry) = state.entries.values().find(|e| {
            e.owner == owner
                && e.snapshot.capture.session_id == capture.session_id
                && e.request_id == request_id
        }) {
            if entry.input != input
                || entry.snapshot.capture != *capture
                || entry.snapshot.kind != kind
            {
                return Err(WorkbenchError::RequestIdConflict);
            }
            return Ok(Some(entry.snapshot.clone()));
        }
        Ok(None)
    }
    pub fn submit(
        self: &Arc<Self>,
        owner: &str,
        capture: CaptureRef,
        kind: &str,
        request_id: &str,
        input: String,
        task: JobTask,
    ) -> Result<JobSnapshot> {
        validate_id(owner)?;
        validate_id(request_id)?;
        if input.len() > MAX_JOB_PARAMETER_BYTES {
            return Err(WorkbenchError::ResourceLimit("job parameters"));
        }
        let mut state = self.state.lock();
        purge(&mut state);
        if let Some(entry) = state.entries.values().find(|e| {
            e.owner == owner
                && e.snapshot.capture.session_id == capture.session_id
                && e.request_id == request_id
        }) {
            if entry.input != input
                || entry.snapshot.capture != capture
                || entry.snapshot.kind != kind
            {
                return Err(WorkbenchError::RequestIdConflict);
            }
            return Ok(entry.snapshot.clone());
        }
        if state
            .entries
            .values()
            .filter(|e| !e.snapshot.state.terminal())
            .count()
            >= MAX_PENDING
            || state.entries.values().any(|e| {
                !e.snapshot.state.terminal() && e.snapshot.capture.session_id == capture.session_id
            })
        {
            return Err(WorkbenchError::ResourceLimit(
                "one heavy job per session; one running and two queued globally",
            ));
        }
        while state.entries.len() >= MAX_JOBS {
            if !evict_oldest(&mut state, None) {
                return Err(WorkbenchError::ResourceLimit("retained jobs"));
            }
        }
        let id = format!("job-{}", uuid::Uuid::new_v4().simple());
        let cancel = Arc::new(AtomicBool::new(false));
        let snapshot = JobSnapshot {
            job_id: id.clone(),
            capture,
            kind: kind.into(),
            state: JobState::Queued,
            cancel_requested: false,
            retention_seconds: JOB_RETENTION.as_secs().to_string(),
            result: None,
            error: None,
        };
        state.entries.insert(
            id.clone(),
            Entry {
                snapshot: snapshot.clone(),
                owner: owner.into(),
                request_id: request_id.into(),
                input,
                cancel: cancel.clone(),
                ended: None,
                output: None,
                bytes: 0,
            },
        );
        state.queue.push_back(id.clone());
        drop(state);
        let manager = self.clone();
        let worker_id = id.clone();
        if let Err(e) = std::thread::Builder::new()
            .name("sigpilot-domain-job".into())
            .spawn(move || manager.work(worker_id, cancel, task))
        {
            let mut state = self.state.lock();
            state.queue.retain(|j| j != &id);
            let entry = state.entries.get_mut(&id).unwrap();
            entry.snapshot.state = JobState::Failed;
            entry.snapshot.error = Some(JobFailure::new("INTERNAL_ERROR", e.to_string()));
            entry.ended = Some(Instant::now());
            self.wake.notify_all();
            return Ok(entry.snapshot.clone());
        }
        Ok(snapshot)
    }

    fn work(&self, id: String, cancel: Arc<AtomicBool>, task: JobTask) {
        let mut state = self.state.lock();
        loop {
            if cancel.load(Ordering::Acquire) {
                state.queue.retain(|j| j != &id);
                if let Some(e) = state.entries.get_mut(&id) {
                    e.snapshot.state = JobState::Cancelled;
                    e.ended = Some(Instant::now());
                }
                self.wake.notify_all();
                return;
            }
            if state.running.is_none() && state.queue.front() == Some(&id) {
                state.queue.pop_front();
                state.running = Some(id.clone());
                state.entries.get_mut(&id).unwrap().snapshot.state = JobState::Running;
                break;
            }
            self.wake.wait(&mut state);
        }
        drop(state);
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| task(&cancel)))
            .unwrap_or_else(|_| {
                Err(JobFailure::new(
                    "INTERNAL_ERROR",
                    "domain job worker panicked",
                ))
            });
        let outcome = outcome.and_then(|output| {
            let bytes = output.bytes()?;
            if bytes > MAX_RESULT_BYTES {
                return Err(JobFailure::new(
                    "RESOURCE_LIMIT",
                    "job result exceeds 4 MiB",
                ));
            }
            Ok((output, bytes))
        });
        let mut state = self.state.lock();
        if let Ok((_, bytes)) = &outcome {
            while state.entries.values().map(|e| e.bytes).sum::<usize>() + bytes
                > MAX_RETAINED_BYTES
            {
                if !evict_oldest(&mut state, Some(&id)) {
                    break;
                }
            }
        }
        let entry = state.entries.get_mut(&id).unwrap();
        if cancel.load(Ordering::Acquire) {
            entry.snapshot.state = JobState::Cancelled;
        } else {
            match outcome {
                Ok((output, bytes)) => {
                    entry.snapshot.state = JobState::Completed;
                    entry.snapshot.result = Some(output.summary(&id));
                    entry.output = Some(Arc::new(output));
                    entry.bytes = bytes;
                }
                Err(error) => {
                    entry.snapshot.state = if error.code == "CANCELLED" {
                        JobState::Cancelled
                    } else {
                        JobState::Failed
                    };
                    entry.snapshot.error = Some(error);
                }
            }
        }
        entry.ended = Some(Instant::now());
        state.running = None;
        self.wake.notify_all();
    }

    pub fn get(&self, owner: &str, id: &str) -> Result<JobSnapshot> {
        let mut state = self.state.lock();
        purge(&mut state);
        let entry = state
            .entries
            .get(id)
            .filter(|e| e.owner == owner)
            .ok_or(WorkbenchError::JobNotFound)?;
        Ok(entry.snapshot.clone())
    }
    pub fn cancel(&self, owner: &str, id: &str) -> Result<JobSnapshot> {
        let mut state = self.state.lock();
        purge(&mut state);
        let entry = state
            .entries
            .get_mut(id)
            .filter(|e| e.owner == owner)
            .ok_or(WorkbenchError::JobNotFound)?;
        if !entry.snapshot.state.terminal() {
            entry.snapshot.cancel_requested = true;
            entry.cancel.store(true, Ordering::Release);
            self.wake.notify_all();
        }
        Ok(entry.snapshot.clone())
    }
    pub fn cancel_session(&self, session: &str) {
        let mut state = self.state.lock();
        for entry in state
            .entries
            .values_mut()
            .filter(|e| e.snapshot.capture.session_id == session && !e.snapshot.state.terminal())
        {
            entry.snapshot.cancel_requested = true;
            entry.cancel.store(true, Ordering::Release);
        }
        self.wake.notify_all();
    }
    pub fn output(&self, owner: &str, id: &str) -> Result<(CaptureRef, Arc<JobOutput>)> {
        let mut state = self.state.lock();
        purge(&mut state);
        let entry = state
            .entries
            .get(id)
            .filter(|e| e.owner == owner)
            .ok_or(WorkbenchError::JobNotFound)?;
        let output = entry
            .output
            .clone()
            .ok_or_else(|| WorkbenchError::InvalidRequest("job has no completed result".into()))?;
        Ok((entry.snapshot.capture.clone(), output))
    }
}

fn purge(state: &mut State) {
    state
        .entries
        .retain(|_, e| e.ended.is_none_or(|at| at.elapsed() < JOB_RETENTION));
}
fn evict_oldest(state: &mut State, except: Option<&str>) -> bool {
    let id = state
        .entries
        .iter()
        .filter(|(id, e)| e.ended.is_some() && Some(id.as_str()) != except)
        .min_by_key(|(_, e)| e.ended)
        .map(|(id, _)| id.clone());
    if let Some(id) = id {
        state.entries.remove(&id);
        true
    } else {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn capture(session: &str) -> CaptureRef {
        CaptureRef {
            session_id: session.into(),
            capture_id: format!("capture-{session}"),
            data_revision: 1.into(),
        }
    }
    fn wait(manager: &JobManager, id: &str, state: JobState) {
        let deadline = Instant::now() + Duration::from_secs(3);
        while manager.get("owner", id).unwrap().state != state {
            assert!(Instant::now() < deadline, "job did not reach {state:?}");
            std::thread::sleep(Duration::from_millis(2));
        }
    }
    #[test]
    fn parameter_budget_accepts_large_finite_rules_and_rejects_before_execution() {
        let manager = Arc::new(JobManager::default());
        let accepted = manager
            .submit(
                "owner",
                capture("budget"),
                "analysis",
                "accepted",
                "x".repeat(MAX_JOB_PARAMETER_BYTES),
                Box::new(|_| Ok(JobOutput::Analysis(json!({"complete":true})))),
            )
            .unwrap();
        wait(&manager, &accepted.job_id, JobState::Completed);
        assert!(matches!(
            manager.submit(
                "owner",
                capture("budget"),
                "analysis",
                "rejected",
                "x".repeat(MAX_JOB_PARAMETER_BYTES + 1),
                Box::new(|_| panic!("over-budget job executed"))
            ),
            Err(WorkbenchError::ResourceLimit("job parameters"))
        ));
    }
    #[test]
    fn queue_budget_replay_and_cancellation_are_scoped_to_the_requested_job() {
        let manager = Arc::new(JobManager::default());
        let first = manager
            .submit(
                "owner",
                capture("a"),
                "analysis",
                "a",
                "{}".into(),
                Box::new(|cancel| {
                    while !cancel.load(Ordering::Acquire) {
                        std::thread::sleep(Duration::from_millis(1));
                    }
                    Err(JobFailure::new("CANCELLED", "stopped"))
                }),
            )
            .unwrap();
        wait(&manager, &first.job_id, JobState::Running);
        let second = manager
            .submit(
                "owner",
                capture("b"),
                "analysis",
                "b",
                "{}".into(),
                Box::new(|_| Ok(JobOutput::Analysis(json!({"complete":true})))),
            )
            .unwrap();
        let replay = manager
            .submit(
                "owner",
                capture("b"),
                "analysis",
                "b",
                "{}".into(),
                Box::new(|_| panic!("replay must not execute")),
            )
            .unwrap();
        assert_eq!(replay.job_id, second.job_id);
        assert!(matches!(
            manager.submit(
                "owner",
                capture("b"),
                "analysis",
                "b",
                "changed".into(),
                Box::new(|_| unreachable!())
            ),
            Err(WorkbenchError::RequestIdConflict)
        ));
        assert!(matches!(
            manager.cancel("someone-else", &first.job_id),
            Err(WorkbenchError::JobNotFound)
        ));
        assert!(matches!(
            manager.submit(
                "owner",
                capture("a"),
                "analysis",
                "another",
                "{}".into(),
                Box::new(|_| unreachable!())
            ),
            Err(WorkbenchError::ResourceLimit(_))
        ));
        let third = manager
            .submit(
                "owner",
                capture("c"),
                "analysis",
                "c",
                "{}".into(),
                Box::new(|_| Ok(JobOutput::Analysis(json!({})))),
            )
            .unwrap();
        assert!(matches!(
            manager.submit(
                "owner",
                capture("d"),
                "analysis",
                "d",
                "{}".into(),
                Box::new(|_| unreachable!())
            ),
            Err(WorkbenchError::ResourceLimit(_))
        ));
        manager.cancel("owner", &second.job_id).unwrap();
        wait(&manager, &second.job_id, JobState::Cancelled);
        assert_eq!(
            manager.get("owner", &first.job_id).unwrap().state,
            JobState::Running
        );
        manager.cancel("owner", &first.job_id).unwrap();
        wait(&manager, &first.job_id, JobState::Cancelled);
        wait(&manager, &third.job_id, JobState::Completed);
        assert_eq!(
            manager.cancel("owner", &third.job_id).unwrap().state,
            JobState::Completed
        );
    }
    #[test]
    fn oversized_output_fails_and_retention_evicts_terminal_entries() {
        let manager = Arc::new(JobManager::default());
        let first = manager
            .submit(
                "owner",
                capture("a"),
                "analysis",
                "big",
                "{}".into(),
                Box::new(|_| {
                    Ok(JobOutput::Analysis(
                        json!({"data":"x".repeat(MAX_RESULT_BYTES)}),
                    ))
                }),
            )
            .unwrap();
        wait(&manager, &first.job_id, JobState::Failed);
        assert_eq!(
            manager
                .get("owner", &first.job_id)
                .unwrap()
                .error
                .unwrap()
                .code,
            "RESOURCE_LIMIT"
        );
        manager
            .state
            .lock()
            .entries
            .get_mut(&first.job_id)
            .unwrap()
            .ended = Some(Instant::now() - JOB_RETENTION);
        assert!(matches!(
            manager.get("owner", &first.job_id),
            Err(WorkbenchError::JobNotFound)
        ));
    }
}
