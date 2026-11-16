//! Instabox-only browser fixture for the real GUI adapter and shared service.
//! These test endpoints are not part of either production MCP executable.
use axum::{
    body::Bytes,
    extract::State,
    http::{header, StatusCode},
    routing::{get, post},
    Router,
};
use serde_json::{json, Value};
use sigpilot_mcp::McpAdapter;
use sigpilot_workbench::{
    analyzers::{ConfigureAnalyzerRequest, ReplaceAnalyzersRequest},
    AnnotationSource, Caller, WorkbenchService,
};
use std::{
    net::{Ipv4Addr, SocketAddr},
    sync::Arc,
};
type Response = (StatusCode, [(header::HeaderName, &'static str); 1], String);
fn response(result: Result<Value, String>) -> Response {
    match result {
        Ok(v) => (
            StatusCode::OK,
            [(header::CONTENT_TYPE, "application/json")],
            v.to_string(),
        ),
        Err(e) => (
            StatusCode::CONFLICT,
            [(header::CONTENT_TYPE, "application/json")],
            json!({"error":e}).to_string(),
        ),
    }
}
async fn snapshot(State(service): State<Arc<WorkbenchService>>) -> Response {
    response(
        service
            .gui_snapshot("gui-fixture")
            .map_err(|e| e.to_string())
            .and_then(|s| serde_json::to_value(s).map_err(|e| e.to_string())),
    )
}
async fn replace(State(service): State<Arc<WorkbenchService>>, body: Bytes) -> Response {
    response(
        serde_json::from_slice::<ReplaceAnalyzersRequest>(&body)
            .map_err(|e| e.to_string())
            .and_then(|r| {
                service
                    .replace_analyzers(
                        Caller {
                            id: "desktop-user",
                            source: AnnotationSource::User,
                        },
                        &r,
                    )
                    .map_err(|e| e.to_string())
            }),
    )
}
#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    if !std::fs::read_to_string("/proc/version")
        .unwrap_or_default()
        .contains("instabox")
    {
        return Err("GUI fixture is restricted to Instabox".into());
    }
    let port = std::env::args()
        .nth(1)
        .ok_or("port required")?
        .parse::<u16>()?;
    let service = Arc::new(WorkbenchService::default());
    let metadata = serde_json::from_value(
        json!({"version":1,"source_device":"gui-fixture","sample_rate_hz":1000000,"channel_count":2,"enabled_channels":[0,1],"unitsize":1,
        "sample_count":40,"captured_at":"2026-11-13T00:00:00Z","labels":["D0","D1"]}),
    )?;
    let capture = service
        .import_capture(
            "gui-fixture",
            sigpilot_file::PxlogicProjectCapture::Sparse(sigpilot_core::SparseCaptureData {
                metadata,
                channels: vec![
                    sigpilot_core::SparseDigitalChannel {
                        channel: 0,
                        initial_high: false,
                        transitions: vec![10, 20],
                    },
                    sigpilot_core::SparseDigitalChannel {
                        channel: 1,
                        initial_high: false,
                        transitions: vec![7, 12],
                    },
                ],
            }),
        )?
        .capture;
    service.configure_analyzer(Caller{id:"assistant",source:AnnotationSource::Assistant},&ConfigureAnalyzerRequest {capture,expected_config_revision:0.into(),request_id:"initial".into(),preview:false,
        operation:serde_json::from_value(json!({"op":"create","id":"uart","name":"UART fixture","config":{"protocol":"UART","settings":{"channel":0,"baud_rate":"100000"}}}))?})?;
    let local = Router::new()
        .route("/snapshot", get(snapshot))
        .route("/replace", post(replace))
        .with_state(service.clone());
    let adapter = McpAdapter::new(service, vec![], true, "assistant".into());
    let router = local.merge(sigpilot_mcp::server::http_router(
        adapter,
        "sigpilot-gui-fixture-token-0123456789".into(),
    )?);
    let listener =
        tokio::net::TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, port))).await?;
    axum::serve(listener, router)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}
