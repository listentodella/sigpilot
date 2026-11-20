//! Instabox-only onboarding + real Demo capture integration. Not a production endpoint.
use axum::{
    body::Bytes,
    extract::State,
    routing::{get, post},
    Router,
};
use rmcp::{
    model::{CallToolRequestParams, CallToolResponse},
    transport::{
        streamable_http_client::StreamableHttpClientTransportConfig, StreamableHttpClientTransport,
    },
    ServiceExt,
};
use serde_json::{json, Value};
use sigpilot_mcp::{
    desktop::DesktopMcpServer,
    onboarding::{self, Preferences},
};
use sigpilot_workbench::WorkbenchService;
use std::{
    path::PathBuf,
    sync::{atomic::AtomicBool, Arc},
};
struct Fixture {
    workbench: Arc<WorkbenchService>,
    server: tokio::sync::Mutex<Option<DesktopMcpServer>>,
    directory: PathBuf,
}
type Response = (
    axum::http::StatusCode,
    [(axum::http::header::HeaderName, &'static str); 1],
    String,
);
fn response(result: Result<Value, String>) -> Response {
    let (status, value) = match result {
        Ok(v) => (axum::http::StatusCode::OK, v),
        Err(e) => (axum::http::StatusCode::CONFLICT, json!({"error":e})),
    };
    (
        status,
        [(axum::http::header::CONTENT_TYPE, "application/json")],
        value.to_string(),
    )
}
async fn setup(State(f): State<Arc<Fixture>>) -> Response {
    let server = f.server.lock().await;
    let status = server
        .as_ref()
        .map(DesktopMcpServer::status)
        .unwrap_or_else(sigpilot_mcp::desktop::DesktopMcpStatus::disabled);
    response(
        onboarding::setup_info(status, &f.directory, None)
            .map_err(|e| e.to_string())
            .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string())),
    )
}
async fn configure(State(f): State<Arc<Fixture>>, body: Bytes) -> Response {
    let result = async {
        let v: Value = serde_json::from_slice(&body).map_err(|e| e.to_string())?;
        let mut server = f.server.lock().await;
        let enabled = v["enabled"].as_bool().ok_or("enabled required")?;
        let can_edit = v["canEditAnnotations"]
            .as_bool()
            .ok_or("permissions required")?;
        if let Some(old) = server.take() {
            old.stop().await;
        }
        if enabled {
            *server = Some(
                DesktopMcpServer::start_on_port(
                    f.workbench.clone(),
                    &f.directory,
                    can_edit,
                    onboarding::read_preferences(&f.directory)
                        .map_err(|e| e.to_string())?
                        .port,
                )
                .await
                .map_err(|e| e.to_string())?,
            );
        }
        onboarding::save_preferences(
            &f.directory,
            &Preferences {
                can_capture: false,
                enabled,
                can_edit,
                ..onboarding::read_preferences(&f.directory).map_err(|e| e.to_string())?
            },
        )
        .map_err(|e| e.to_string())?;
        Ok(json!(server
            .as_ref()
            .map(DesktopMcpServer::status)
            .unwrap_or_else(
                sigpilot_mcp::desktop::DesktopMcpStatus::disabled
            )))
    }
    .await;
    response(result)
}
async fn check(State(f): State<Arc<Fixture>>) -> Response {
    let server = f.server.lock().await;
    response(match server.as_ref() {
        Some(server) => server.check_http().await.map_err(|e| e.to_string()),
        None => Err("MCP disabled".into()),
    })
}
async fn authorization(State(f): State<Arc<Fixture>>) -> Response {
    let server = f.server.lock().await;
    response(match server.as_ref().and_then(|s| s.authorization()) {
        Some(auth) => auth
            .status()
            .map_err(|e| e.to_string())
            .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string())),
        None => Ok(json!({"pending":[],"clients":[]})),
    })
}
async fn decide(State(f): State<Arc<Fixture>>, body: Bytes) -> Response {
    let server = f.server.lock().await;
    response((|| {
        let v: Value = serde_json::from_slice(&body).map_err(|e| e.to_string())?;
        server
            .as_ref()
            .and_then(|s| s.authorization())
            .ok_or("MCP disabled")?
            .decide(
                v["requestId"].as_str().ok_or("request ID")?,
                v["allow"].as_bool().ok_or("allow")?,
            )
            .map_err(|e| e.to_string())?;
        Ok(json!({"ok":true}))
    })())
}
async fn revoke(State(f): State<Arc<Fixture>>, body: Bytes) -> Response {
    let server = f.server.lock().await;
    response((|| {
        let v: Value = serde_json::from_slice(&body).map_err(|e| e.to_string())?;
        server
            .as_ref()
            .and_then(|s| s.authorization())
            .ok_or("MCP disabled")?
            .revoke(v["grantId"].as_str().ok_or("grant ID")?)
            .map_err(|e| e.to_string())?;
        Ok(json!({"ok":true}))
    })())
}
async fn begin_authorization(State(f): State<Arc<Fixture>>) -> Response {
    let result=async {
        let server=f.server.lock().await;let endpoint=server.as_ref().ok_or("MCP disabled")?.status().endpoint.ok_or("endpoint")?;drop(server);
        let root=endpoint.trim_end_matches("/mcp");let http=reqwest::Client::builder().no_proxy().build().map_err(|e|e.to_string())?;
        let value:Value=serde_json::from_slice(&http.post(format!("{root}/oauth/register")).body(json!({"client_name":"Demo Test Agent","redirect_uris":["http://127.0.0.1:44111/callback"]}).to_string()).send().await.map_err(|e|e.to_string())?.bytes().await.map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
        let id=value["client_id"].as_str().ok_or("client ID")?;
        let url=reqwest::Url::parse_with_params(&format!("{root}/oauth/authorize"),[("client_id",id),("response_type","code"),("code_challenge_method","S256"),("code_challenge","aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),("state","demo-state-123"),("resource",endpoint.as_str()),("redirect_uri","http://127.0.0.1:44111/callback")]).map_err(|e|e.to_string())?;
        let response=http.get(url).send().await.map_err(|e|e.to_string())?;if !response.status().is_success(){return Err("Authorization request failed".into());}Ok(json!({"ok":true}))
    }.await;
    response(result)
}
async fn snapshot(State(f): State<Arc<Fixture>>, body: Bytes) -> Response {
    let v: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(e) => return response(Err(e.to_string())),
    };
    response(
        f.workbench
            .gui_snapshot(v["sessionId"].as_str().unwrap_or("demo"))
            .map_err(|e| e.to_string())
            .and_then(|s| serde_json::to_value(s).map_err(|e| e.to_string())),
    )
}
fn completed(value: CallToolResponse) -> Result<Value, String> {
    let CallToolResponse::Complete(value) = value else {
        return Err("unexpected response".into());
    };
    if value.is_error == Some(true) {
        return Err(format!("MCP tool failed: {:?}", value.structured_content));
    }
    value
        .structured_content
        .ok_or("missing structured result".into())
}
async fn mark(State(f): State<Arc<Fixture>>) -> Response {
    let result=async {
  let credentials=sigpilot_mcp::desktop::read_instance(&f.directory.join("connection.json")).map_err(|e|e.to_string())?;
  let config=StreamableHttpClientTransportConfig::with_uri(credentials.endpoint).auth_header(credentials.token);
  let http=reqwest::Client::builder().no_proxy().build().map_err(|e|e.to_string())?;
  let client=().serve(StreamableHttpClientTransport::with_client(http,config)).await.map_err(|e|e.to_string())?;
  let tool=|name:&str,args:Value|serde_json::from_value::<CallToolRequestParams>(json!({"name":name,"arguments":args})).unwrap();
  let result=async {
   let context=completed(client.peer().call_tool_once(tool("sigpilot_get_context",json!({"session_id":"demo"}))).await.map_err(|e|e.to_string())?)?;
   completed(client.peer().call_tool_once(tool("sigpilot_apply_annotations",json!({"capture":{"session_id":context["session_id"],"capture_id":context["capture_id"],"data_revision":context["data_revision"]},"expected_annotation_revision":context["annotation_revision"],"request_id":"demo-marker-5","operations":[{"op":"create","annotation":{"kind":"timing_point","sample":"5","title":"MCP test","color":"#ffc44d"}}]}))).await.map_err(|e|e.to_string())?)?;
   Ok(json!({"ok":true,"sample":"5","time_us":"5","sample_rate_hz":context["sample_rate_hz"]}))
  }.await;
  client.cancel().await.map_err(|e|e.to_string())?;result
 }.await;
    response(result)
}
async fn reopen(State(f): State<Arc<Fixture>>) -> Response {
    response((|| {
        let path = f.directory.parent().unwrap().join("demo-marker.pxl");
        f.workbench
            .save_project("demo", &path, Default::default())?;
        let project =
            sigpilot_file::open_pxl_bounded(&path, 1024 * 1024).map_err(|e| e.to_string())?;
        let source = match &project.capture {
            sigpilot_file::PxlogicProjectCapture::Packed(c) => c.metadata.source_device.clone(),
            sigpilot_file::PxlogicProjectCapture::Sparse(c) => c.metadata.source_device.clone(),
        };
        f.workbench
            .import_capture("reopened", project.capture)
            .map_err(|e| e.to_string())?;
        f.workbench
            .restore_annotations("reopened", &project.session)
            .map_err(|e| e.to_string())?;
        Ok(json!({"ok":true,"source_device":source,"file":path}))
    })())
}
#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    if !std::fs::read_to_string("/proc/version")
        .unwrap_or_default()
        .contains("instabox")
    {
        return Err("fixture restricted to Instabox".into());
    }
    let mut args = std::env::args().skip(1);
    let port = args.next().ok_or("port")?.parse::<u16>()?;
    let root = PathBuf::from(args.next().ok_or("private fixture directory")?);
    let service = Arc::new(WorkbenchService::default());
    let session = service.session("demo")?;
    let settings = sigpilot_core::CaptureSettings {
        sample_rate_hz: 1_000_000,
        channel_count: 4,
        enabled_channels: vec![0, 1, 2, 3],
        duration_ms: 10,
        mode: sigpilot_core::CaptureMode::Buffer,
        ..Default::default()
    };
    let mut streamed = 0;
    let capture = sigpilot_core::fake::FakeBackend.capture_streaming_with_analyzers(
        &settings,
        &[],
        &AtomicBool::new(false),
        &mut |_| {},
        &mut |m| session.graph.begin_capture(m.clone()).unwrap(),
        &mut |bytes| {
            streamed += bytes.len();
            session.graph.append_samples(bytes).unwrap();
        },
    )?;
    assert_eq!(
        capture.metadata.source_device,
        sigpilot_core::fake::FakeBackend::DEVICE_ID
    );
    assert_eq!(capture.metadata.sample_count, 10_048);
    assert_eq!(streamed, capture.samples.len());
    session.graph.finish_capture(capture)?;
    service.set_gui_attached("demo", true)?;
    let f = Arc::new(Fixture {
        workbench: service,
        server: tokio::sync::Mutex::new(None),
        directory: root.join("mcp-instances"),
    });
    let router = Router::new()
        .route("/setup", get(setup))
        .route("/configure", post(configure))
        .route("/check", post(check))
        .route("/authorization", post(authorization))
        .route("/decide", post(decide))
        .route("/revoke", post(revoke))
        .route("/begin-authorization", post(begin_authorization))
        .route("/snapshot", post(snapshot))
        .route("/mark", post(mark))
        .route("/reopen", post(reopen))
        .with_state(f.clone());
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).await?;
    axum::serve(listener, router).await?;
    Ok(())
}
