use std::{
    net::{IpAddr, Ipv4Addr, SocketAddr},
    sync::Arc,
};

use axum::{
    extract::{Request, State},
    http::StatusCode,
    middleware::{self, Next},
    response::Response,
    Router,
};
use rmcp::transport::streamable_http_server::{
    session::local::LocalSessionManager, StreamableHttpServerConfig, StreamableHttpService,
};

use crate::McpAdapter;

#[derive(Clone)]
struct Access {
    token: Arc<str>,
    requests: Arc<tokio::sync::Semaphore>,
}

async fn authenticate(
    State(access): State<Access>,
    request: Request,
    next: Next,
) -> Result<Response, StatusCode> {
    let supplied = request
        .headers()
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or_default();
    // Constant-time equality for equal-length secrets; length itself is public.
    if supplied.len() != access.token.len()
        || supplied
            .bytes()
            .zip(access.token.bytes())
            .fold(0u8, |acc, (a, b)| acc | (a ^ b))
            != 0
    {
        return Err(StatusCode::UNAUTHORIZED);
    }
    let _permit = access
        .requests
        .try_acquire()
        .map_err(|_| StatusCode::TOO_MANY_REQUESTS)?;
    Ok(next.run(request).await)
}

pub fn http_router(adapter: McpAdapter, token: String) -> std::io::Result<Router> {
    if token.len() < 32 || token.len() > 256 || !token.bytes().all(|b| b.is_ascii_graphic()) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "MCP token must contain 32..256 printable ASCII characters",
        ));
    }
    let access = Access {
        token: token.into(),
        requests: Arc::new(tokio::sync::Semaphore::new(4)),
    };
    Ok(mcp_router(adapter).layer(middleware::from_fn_with_state(access, authenticate)))
}

pub(crate) fn mcp_router(adapter: McpAdapter) -> Router {
    let config = StreamableHttpServerConfig::default()
        .with_legacy_session_mode(false)
        .with_json_response(true)
        .enforce_origin_validation()
        .with_max_request_body_bytes(256 * 1024);
    let service = StreamableHttpService::new(
        move || Ok(adapter.clone()),
        Arc::new(LocalSessionManager::default()),
        config,
    );
    Router::new().nest_service("/mcp", service)
}

pub async fn serve_http(
    adapter: McpAdapter,
    port: u16,
    token: String,
    shutdown: impl std::future::Future<Output = ()> + Send + 'static,
) -> std::io::Result<()> {
    let router = http_router(adapter, token)?;
    let listener =
        tokio::net::TcpListener::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port))
            .await?;
    axum::serve(listener, router)
        .with_graceful_shutdown(shutdown)
        .await
}
