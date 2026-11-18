use crate::{auth::Client, failure, response, result, CaptureJob, Service};
use axum::{
    body::Bytes,
    extract::{DefaultBodyLimit, Path, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Extension, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sigpilot_core::{AnalyzerDecodeSettings, CaptureSettings, DecoderBackendKind};
use sigpilot_graph::{AnalyzerFrameTableRequest, GraphFrameRequest};
use sigpilot_workbench::{
    models::{ApplyAnnotationsRequest, CaptureRef},
    AnnotationSource, Caller,
};
use std::{io::Read, sync::Arc};

fn parse<T: serde::de::DeserializeOwned>(b: &Bytes) -> Result<T, String> {
    serde_json::from_slice(b).map_err(|e| e.to_string())
}
async fn blocking<F>(s: Arc<Service>, f: F) -> Response
where
    F: FnOnce() -> Result<Value, String> + Send + 'static,
{
    let Ok(permit) = s.permits.clone().try_acquire_owned() else {
        return failure(StatusCode::TOO_MANY_REQUESTS, "Host is busy; retry shortly");
    };
    result(
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            f()
        })
        .await
        .map_err(|e| e.to_string())
        .and_then(|r| r),
    )
}
fn graph(s: &Service, id: &str) -> Result<Arc<sigpilot_graph::GraphSession>, String> {
    s.workbench
        .existing_session(id)
        .map(|session| session.graph.clone())
        .map_err(|e| e.to_string())
}
fn capture(s: &Service, id: &str, expected: &CaptureRef) -> Result<(), String> {
    let current = s.workbench.context(id).map_err(|e| e.to_string())?;
    if expected.session_id != id
        || expected.capture_id != current.capture.capture_id
        || (current.finalized && expected.data_revision != current.capture.data_revision)
    {
        return Err("Capture changed; refresh the host snapshot".into());
    }
    Ok(())
}
async fn sessions(State(s): State<Arc<Service>>, Extension(client): Extension<Client>) -> Response {
    let owners = s.owners.lock().unwrap().clone();
    let values=s.workbench.session_ids().into_iter().filter_map(|id|{let g=graph(&s,&id).ok()?;let c=g.capture_snapshot().ok()?;Some(json!({"id":id,"metadata":c.metadata,"finalized":c.finalized,"owned":owners.get(&id)==Some(&client.id)}))}).collect::<Vec<_>>();
    let jobs = s
        .jobs
        .lock()
        .unwrap()
        .iter()
        .map(|j| {
            let mut v = serde_json::to_value(j).unwrap();
            v["owned"] = json!(j.owner == client.id);
            v
        })
        .collect::<Vec<_>>();
    response(json!({"sessions":values,"captures":jobs}))
}
async fn snapshot(State(s): State<Arc<Service>>, Path(id): Path<String>) -> Response {
    result(
        s.workbench
            .gui_snapshot(&id)
            .map_err(|e| e.to_string())
            .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string())),
    )
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Frame {
    capture: CaptureRef,
    request: GraphFrameRequest,
}
async fn frame(State(s): State<Arc<Service>>, Path(id): Path<String>, body: Bytes) -> Response {
    let input = match parse::<Frame>(&body) {
        Ok(v) => v,
        Err(e) => return failure(StatusCode::BAD_REQUEST, e),
    };
    let mut request = input.request;
    if request.waveform.pixels == 0
        || request.waveform.pixels > 4096
        || request.waveform.channels.len() > 32
        || request.view.is_some()
        || !request.analyzers.is_empty()
    {
        return failure(
            StatusCode::BAD_REQUEST,
            "Use an explicit waveform window, up to 4096 pixels / 32 channels",
        );
    }
    request.analyzers.clear();
    request.view = None;
    let Ok(permit) = s.permits.clone().try_acquire_owned() else {
        return failure(StatusCode::TOO_MANY_REQUESTS, "Host is busy; retry shortly");
    };
    let value = tokio::task::spawn_blocking(move || -> Result<Vec<u8>, String> {
        let _permit = permit;
        capture(&s, &id, &input.capture)?;
        let g = graph(&s, &id)?;
        let frame = g.render_frame(&request).map_err(|e| e.to_string())?;
        capture(&s, &id, &input.capture)?;
        sigpilot_graph::transport::encode_graph_frame(frame).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())
    .and_then(|r| r);
    match value {
        Ok(bytes) => ([(header::CONTENT_TYPE, "application/octet-stream")], bytes).into_response(),
        Err(e) => failure(StatusCode::CONFLICT, e),
    }
}
async fn annotations(
    State(s): State<Arc<Service>>,
    Extension(client): Extension<Client>,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    if !s.settings.can_edit {
        return failure(
            StatusCode::FORBIDDEN,
            "The host has not allowed annotation edits",
        );
    }
    let request = match parse::<ApplyAnnotationsRequest>(&body) {
        Ok(v) => v,
        Err(e) => return failure(StatusCode::BAD_REQUEST, e),
    };
    if request.capture.session_id != id {
        return failure(
            StatusCode::BAD_REQUEST,
            "Capture identity does not match the route",
        );
    }
    result(
        s.workbench
            .apply_annotations(
                Caller {
                    id: &client.id,
                    source: AnnotationSource::User,
                },
                &request,
            )
            .map_err(|e| e.to_string())
            .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string())),
    )
}
async fn undo(
    State(s): State<Arc<Service>>,
    Extension(client): Extension<Client>,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    if !s.settings.can_edit {
        return failure(
            StatusCode::FORBIDDEN,
            "The host has not allowed annotation edits",
        );
    }
    let request = match parse::<sigpilot_workbench::undo::UndoAnnotationsRequest>(&body) {
        Ok(v) => v,
        Err(e) => return failure(StatusCode::BAD_REQUEST, e),
    };
    if request.capture.session_id != id {
        return failure(
            StatusCode::BAD_REQUEST,
            "Capture identity does not match the route",
        );
    }
    result(
        s.workbench
            .undo_annotations(
                Caller {
                    id: &client.id,
                    source: AnnotationSource::User,
                },
                &request,
            )
            .map_err(|e| e.to_string())
            .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string())),
    )
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Decode {
    capture: CaptureRef,
    settings: AnalyzerDecodeSettings,
    query: String,
    start: usize,
    end: usize,
}
fn safe_settings(settings: &AnalyzerDecodeSettings) -> bool {
    matches!(
        settings,
        AnalyzerDecodeSettings::Uart(_)
            | AnalyzerDecodeSettings::I2c(_)
            | AnalyzerDecodeSettings::Spi(_)
    )
}
async fn decode(State(s): State<Arc<Service>>, Path(id): Path<String>, body: Bytes) -> Response {
    let request = match parse::<Decode>(&body) {
        Ok(v) => v,
        Err(e) => return failure(StatusCode::BAD_REQUEST, e),
    };
    if !safe_settings(&request.settings)
        || request.query.len() > 512
        || request.start > request.end
        || request.end - request.start > 100
    {
        return failure(
            StatusCode::BAD_REQUEST,
            "Use UART/I2C/SPI and a decode page of at most 100 rows",
        );
    }
    let work = s.clone();
    blocking(s, move || {
        capture(&work, &id, &request.capture)?;
        let g = graph(&work, &id)?;
        let settings = vec![AnalyzerFrameTableRequest {
            analyzer_id: "remote-query".into(),
            analyzer_name: "Remote query".into(),
            backend: DecoderBackendKind::Auto,
            display_radix: "hex".into(),
            settings: request.settings,
        }];
        let rows = g
            .decode_frame_table_search_window(&settings, &request.query, request.start, request.end)
            .map_err(|e| e.to_string())?;
        capture(&work, &id, &request.capture)?;
        serde_json::to_value(rows).map_err(|e| e.to_string())
    })
    .await
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Point {
    channel: u8,
    sample: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Measurement {
    capture: CaptureRef,
    request: Point,
}
async fn measurement(
    State(s): State<Arc<Service>>,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    let request = match parse::<Measurement>(&body) {
        Ok(v) => v,
        Err(e) => return failure(StatusCode::BAD_REQUEST, e),
    };
    let sample = match request.request.sample.parse::<u64>() {
        Ok(v) => v,
        Err(_) => return failure(StatusCode::BAD_REQUEST, "Invalid exact sample"),
    };
    let work = s.clone();
    blocking(s, move || {
        capture(&work, &id, &request.capture)?;
        let value = graph(&work, &id)?
            .measure_point(request.request.channel, sample)
            .map_err(|e| e.to_string())?;
        capture(&work, &id, &request.capture)?;
        serde_json::to_value(value).map_err(|e| e.to_string())
    })
    .await
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Poll {
    after: String,
}
async fn events(
    State(s): State<Arc<Service>>,
    Extension(client): Extension<Client>,
    body: Bytes,
) -> Response {
    let Ok(request) = parse::<Poll>(&body) else {
        return failure(StatusCode::BAD_REQUEST, "Invalid event cursor");
    };
    let Ok(after) = request.after.parse::<u64>() else {
        return failure(StatusCode::BAD_REQUEST, "Invalid event cursor");
    };
    let Ok(_permit) = s.polls.clone().try_acquire_owned() else {
        return failure(
            StatusCode::TOO_MANY_REQUESTS,
            "Event connection limit reached",
        );
    };
    let events = s.events.read(after).await;
    if !s.authorization.lock().unwrap().contains(&client.id) {
        return failure(
            StatusCode::UNAUTHORIZED,
            "Browser authorization was revoked",
        );
    }
    response(events)
}
async fn devices(State(s): State<Arc<Service>>) -> Response {
    let work = s.clone();
    blocking(s, move || {
        work.controller
            .devices()
            .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
    })
    .await
}
async fn capabilities(State(s): State<Arc<Service>>, Path(id): Path<String>) -> Response {
    let work = s.clone();
    blocking(s, move || {
        work.controller
            .capabilities(&id)
            .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
    })
    .await
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StartCapture {
    settings: CaptureSettings,
    #[serde(default)]
    analyzers: Vec<AnalyzerDecodeSettings>,
}
async fn start_capture(
    State(s): State<Arc<Service>>,
    Extension(client): Extension<Client>,
    body: Bytes,
) -> Response {
    if !s.settings.can_capture {
        return failure(
            StatusCode::FORBIDDEN,
            "The host has not allowed remote capture",
        );
    }
    let request = match parse::<StartCapture>(&body) {
        Ok(v) => v,
        Err(e) => return failure(StatusCode::BAD_REQUEST, e),
    };
    if !(1..=60_000).contains(&request.settings.duration_ms)
        || !(1..=64).contains(&request.settings.buffer_size_mb)
        || request.settings.channel_count == 0
        || request.settings.channel_count > 32
        || request.settings.trigger_enabled
        || request.settings.external_trigger_mode != sigpilot_core::ExternalTriggerMode::Close
        || request.settings.trigger_out_enabled
        || request.analyzers.len() > 8
        || request.analyzers.iter().any(|a| !safe_settings(a))
    {
        return failure(StatusCode::BAD_REQUEST,"Remote captures support 1–60000 ms, up to 64 MiB / 32 channels, and no waiting trigger");
    }
    // Buffer mode sizes the actual acquisition from rate × duration. The buffer
    // field alone only bounds stream mode. Use the same alignment as the driver.
    let settings = &request.settings;
    let fits = sigpilot_core::unitsize_for_channel_count(settings.channel_count)
        .and_then(|width| {
            sigpilot_core::sample_count_from_settings(settings, width)
                .map(|samples| samples.checked_mul(u64::from(width)))
        })
        .is_ok_and(|bytes| bytes.is_some_and(|n| n <= settings.buffer_size_mb * 1024 * 1024));
    if settings.sample_rate_hz == 0
        || !fits
        || settings.enabled_channels.len() > usize::from(settings.channel_count)
        || settings
            .enabled_channels
            .iter()
            .any(|ch| *ch >= settings.channel_count)
    {
        return failure(
            StatusCode::BAD_REQUEST,
            "Check the channels, sample rate, duration and buffer size",
        );
    }
    if s.workbench.session_ids().len() >= 32 {
        return failure(
            StatusCode::TOO_MANY_REQUESTS,
            "Close captures on the host before recording more",
        );
    }
    let job = CaptureJob {
        id: uuid::Uuid::new_v4().simple().to_string(),
        session_id: format!("remote-{}", uuid::Uuid::new_v4().simple()),
        state: "running".into(),
        error: None,
        summary: None,
        owner: client.id,
        cancel_requested: false,
    };
    {
        let mut jobs = s.jobs.lock().unwrap();
        if jobs.iter().any(|j| j.state == "running") {
            return failure(StatusCode::CONFLICT, "A remote capture is already running");
        }
        while jobs.len() >= 8 {
            jobs.remove(0);
        }
        jobs.push(job.clone());
    }
    let value = serde_json::to_value(&job).unwrap();
    s.owners
        .lock()
        .unwrap()
        .insert(job.session_id.clone(), job.owner.clone());
    tokio::spawn(async move {
        let future =
            s.controller
                .start(job.session_id.clone(), request.settings, request.analyzers);
        tokio::pin!(future);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
        let result = loop {
            tokio::select! {
                value=&mut future=>break value,
                _=tokio::time::sleep(std::time::Duration::from_millis(20))=>{
                    if std::time::Instant::now()>=deadline {
                        if let Some(j)=s.jobs.lock().unwrap().iter_mut().find(|j|j.id==job.id) {j.cancel_requested=true;j.error=Some("Remote acquisition reached its 60-second limit".into());}
                    }
                    let requested=s.jobs.lock().unwrap().iter().any(|j|j.id==job.id&&j.cancel_requested);
                    if requested {let _=s.controller.cancel(&job.session_id);}
                }
            }
        };
        let mut jobs = s.jobs.lock().unwrap();
        if let Some(j) = jobs.iter_mut().find(|j| j.id == job.id) {
            match result {
                Ok(v) => {
                    j.state = if j.cancel_requested {
                        "cancelled"
                    } else {
                        "completed"
                    }
                    .into();
                    j.summary = Some(v);
                }
                Err(e) => {
                    j.state = if j.cancel_requested {
                        "cancelled"
                    } else {
                        "failed"
                    }
                    .into();
                    j.error = Some(e);
                }
            }
        }
        drop(jobs);
        if s.workbench.context(&job.session_id).is_err() {
            s.workbench.release_session(&job.session_id);
            s.owners.lock().unwrap().remove(&job.session_id);
        }
        s.events
            .publish(json!({"kind":"capture_finished","session_id":job.session_id}));
    });
    (
        StatusCode::ACCEPTED,
        [(header::CONTENT_TYPE, "application/json")],
        value.to_string(),
    )
        .into_response()
}
async fn cancel_capture(
    State(s): State<Arc<Service>>,
    Extension(client): Extension<Client>,
    Path(id): Path<String>,
) -> Response {
    let job = {
        let mut jobs = s.jobs.lock().unwrap();
        jobs.iter_mut()
            .find(|j| j.id == id && j.owner == client.id && j.state == "running")
            .map(|j| {
                j.cancel_requested = true;
                j.clone()
            })
    };
    let Some(job) = job else {
        return failure(
            StatusCode::NOT_FOUND,
            "Active capture does not belong to this browser",
        );
    };
    // The job may still be entering the capture controller. Its independent
    // task retries cancellation after activation, without touching desktop jobs.
    let _ = s.controller.cancel(&job.session_id);
    response(json!({"ok":true}))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Release {
    capture: CaptureRef,
}
async fn release(
    State(s): State<Arc<Service>>,
    Extension(client): Extension<Client>,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    if !(s.settings.can_edit || s.settings.can_capture) {
        return failure(
            StatusCode::FORBIDDEN,
            "The host has not allowed closing remote captures",
        );
    }
    if s.owners.lock().unwrap().get(&id) != Some(&client.id) {
        return failure(
            StatusCode::FORBIDDEN,
            "Only close captures created by this browser connection",
        );
    }
    let request = match parse::<Release>(&body) {
        Ok(v) => v,
        Err(e) => return failure(StatusCode::BAD_REQUEST, e),
    };
    if s.jobs
        .lock()
        .unwrap()
        .iter()
        .any(|j| j.session_id == id && j.state == "running")
    {
        return failure(
            StatusCode::CONFLICT,
            "Stop the acquisition before closing it",
        );
    }
    if let Err(e) = capture(&s, &id, &request.capture) {
        return failure(StatusCode::CONFLICT, e);
    }
    if !s.workbench.context(&id).is_ok_and(|c| c.finalized) {
        return failure(StatusCode::CONFLICT, "The capture is still being recorded");
    }
    s.workbench.release_session(&id);
    s.owners.lock().unwrap().remove(&id);
    s.jobs.lock().unwrap().retain(|j| j.session_id != id);
    s.events
        .publish(json!({"kind":"capture_closed","session_id":id}));
    response(json!({"ok":true}))
}

struct Temporary(std::path::PathBuf);
impl Temporary {
    fn new(s: &Service) -> Self {
        Self(
            s.directory
                .join(format!("{}.pxl", uuid::Uuid::new_v4().simple())),
        )
    }
}
impl Drop for Temporary {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}
async fn download(State(s): State<Arc<Service>>, Path(id): Path<String>) -> Response {
    let Ok(permit) = s.permits.clone().try_acquire_owned() else {
        return failure(StatusCode::TOO_MANY_REQUESTS, "Host is busy; retry shortly");
    };
    let value = tokio::task::spawn_blocking(move || -> Result<Vec<u8>, String> {
        let _permit = permit;
        let path = Temporary::new(&s);
        s.workbench.save_project(&id, &path.0, Default::default())?;
        let mut bytes = Vec::new();
        std::fs::File::open(&path.0)
            .map_err(|e| e.to_string())?
            .take(128 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        if bytes.len() > 128 * 1024 * 1024 {
            return Err("Capture exceeds the 128 MiB download limit".into());
        }
        Ok(bytes)
    })
    .await
    .map_err(|e| e.to_string())
    .and_then(|v| v);
    match value {
        Ok(v) => (
            [
                (header::CONTENT_TYPE, "application/octet-stream"),
                (
                    header::CONTENT_DISPOSITION,
                    "attachment; filename=\"sigpilot-capture.pxl\"",
                ),
            ],
            v,
        )
            .into_response(),
        Err(e) => failure(StatusCode::CONFLICT, e),
    }
}
async fn upload(
    State(s): State<Arc<Service>>,
    Extension(client): Extension<Client>,
    body: Bytes,
) -> Response {
    if !s.settings.can_edit {
        return failure(StatusCode::FORBIDDEN, "The host has not allowed imports");
    }
    if s.workbench.session_ids().len() >= 32 {
        return failure(
            StatusCode::TOO_MANY_REQUESTS,
            "Close captures on the host before importing more",
        );
    }
    let work = s.clone();
    blocking(s, move || {
        let path = Temporary::new(&work);
        std::fs::write(&path.0, &body).map_err(|e| e.to_string())?;
        let project = sigpilot_file::open_pxl_bounded(&path.0, 32 * 1024 * 1024)
            .map_err(|e| e.to_string())?;
        let id = format!("remote-{}", uuid::Uuid::new_v4().simple());
        work.workbench
            .import_capture(&id, project.capture)
            .map_err(|e| e.to_string())?;
        if let Err(e) = work.workbench.restore_annotations(&id, &project.session) {
            work.workbench.release_session(&id);
            return Err(e.to_string());
        }
        work.owners.lock().unwrap().insert(id.clone(), client.id);
        work.events
            .publish(json!({"kind":"capture_imported","session_id":id}));
        Ok(json!({"session_id":id}))
    })
    .await
}
pub(crate) fn router() -> Router<Arc<Service>> {
    Router::new()
        .route("/sessions", get(sessions))
        .route(
            "/sessions/import",
            post(upload).layer(DefaultBodyLimit::max(32 * 1024 * 1024)),
        )
        .route("/sessions/{id}/snapshot", get(snapshot))
        .route("/sessions/{id}/frame", post(frame))
        .route("/sessions/{id}/annotations", post(annotations))
        .route("/sessions/{id}/undo", post(undo))
        .route("/sessions/{id}/decode", post(decode))
        .route("/sessions/{id}/measurement", post(measurement))
        .route("/sessions/{id}/download", get(download))
        .route("/events", post(events))
        .route("/sessions/{id}/release", post(release))
        .route("/devices", get(devices))
        .route("/devices/{id}/capabilities", get(capabilities))
        .route("/captures", post(start_capture))
        .route("/captures/{id}/cancel", post(cancel_capture))
}
