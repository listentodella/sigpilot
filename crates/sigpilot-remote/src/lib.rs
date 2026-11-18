//! Remote browser adapter. Shared captures remain owned by the host workbench.
mod auth;
pub mod events;
mod operations;

use axum::{
    body::Body,
    extract::{DefaultBodyLimit, Request, State},
    http::{header, HeaderValue, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Extension, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sigpilot_core::{
    AnalyzerDecodeSettings, CaptureSettings, DeviceInfo, HardwareCaptureCapabilities,
};
use sigpilot_workbench::WorkbenchService;
use std::{
    future::Future,
    io,
    net::{IpAddr, Ipv4Addr},
    path::PathBuf,
    pin::Pin,
    sync::{Arc, Mutex},
};
use tokio::sync::{oneshot, Semaphore};

pub type CaptureFuture = Pin<Box<dyn Future<Output = Result<Value, String>> + Send>>;
pub trait CaptureController: Send + Sync {
    fn devices(&self) -> Result<Vec<DeviceInfo>, String>;
    fn capabilities(&self, id: &str) -> Result<HardwareCaptureCapabilities, String>;
    fn start(
        &self,
        session_id: String,
        settings: CaptureSettings,
        analyzers: Vec<AnalyzerDecodeSettings>,
    ) -> CaptureFuture;
    fn cancel(&self, session_id: &str) -> Result<(), String>;
}
pub struct Asset {
    pub bytes: Vec<u8>,
    pub mime: String,
}
pub type Assets = Arc<dyn Fn(&str) -> Option<Asset> + Send + Sync>;

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Settings {
    pub port: u16,
    pub listen_on_lan: bool,
    pub public_url: String,
    pub can_edit: bool,
    pub can_capture: bool,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            port: 10532,
            listen_on_lan: false,
            public_url: "http://127.0.0.1:10532".into(),
            can_edit: false,
            can_capture: false,
        }
    }
}
impl Settings {
    fn origin(&self) -> io::Result<String> {
        let url = reqwest::Url::parse(&self.public_url).map_err(io::Error::other)?;
        if self.port < 1024
            || url.host_str().is_none()
            || !matches!(url.scheme(), "http" | "https")
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || url.path() != "/"
        {
            return Err(io::Error::other(
                "Use a root HTTP/HTTPS URL and a port between 1024 and 65535",
            ));
        }
        if url.scheme() == "http" {
            let host = url.host_str().unwrap().trim_matches(['[', ']']);
            let private = host == "localhost"
                || host.parse::<IpAddr>().is_ok_and(|ip| match ip {
                    IpAddr::V4(ip) => {
                        ip.is_loopback()
                            || ip.is_private()
                            || ip.is_link_local()
                            || ((u32::from(ip) & 0xffc00000) == 0x64400000)
                    }
                    IpAddr::V6(ip) => {
                        ip.is_loopback() || ip.is_unique_local() || ip.is_unicast_link_local()
                    }
                });
            if !private {
                return Err(io::Error::other("Public remote addresses require HTTPS"));
            }
        }
        Ok(url.origin().ascii_serialization())
    }
}

#[derive(Clone, Serialize)]
pub struct Status {
    pub enabled: bool,
    pub settings: Settings,
    pub access_code: Option<String>,
    pub clients: Vec<auth::Client>,
}
impl Default for Status {
    fn default() -> Self {
        Self {
            enabled: false,
            settings: Settings::default(),
            access_code: None,
            clients: vec![],
        }
    }
}

#[derive(Clone, Serialize)]
pub struct CaptureJob {
    pub id: String,
    pub session_id: String,
    pub state: String,
    pub error: Option<String>,
    pub summary: Option<Value>,
    #[serde(skip)]
    owner: String,
    #[serde(skip)]
    cancel_requested: bool,
}
pub(crate) struct Service {
    pub workbench: Arc<WorkbenchService>,
    pub controller: Arc<dyn CaptureController>,
    pub events: Arc<events::Events>,
    pub settings: Settings,
    pub origin: String,
    pub host: String,
    pub cookie: String,
    pub authorization: Mutex<auth::Authorization>,
    pub jobs: Mutex<Vec<CaptureJob>>,
    pub owners: Mutex<std::collections::HashMap<String, String>>,
    pub permits: Arc<Semaphore>,
    pub polls: Arc<Semaphore>,
    pub directory: PathBuf,
    pub assets: Assets,
}

pub struct RemoteServer {
    service: Arc<Service>,
    access_code: String,
    shutdown: Option<oneshot::Sender<()>>,
    task: tokio::task::JoinHandle<()>,
}
impl RemoteServer {
    pub async fn start(
        workbench: Arc<WorkbenchService>,
        controller: Arc<dyn CaptureController>,
        events: Arc<events::Events>,
        settings: Settings,
        directory: PathBuf,
        assets: Assets,
    ) -> io::Result<Self> {
        let origin = settings.origin()?;
        if assets("/web.html").is_none() {
            return Err(io::Error::other(
                "Remote frontend assets are missing; build the frontend first",
            ));
        }
        std::fs::create_dir_all(&directory)?;
        let listener = tokio::net::TcpListener::bind((
            if settings.listen_on_lan {
                Ipv4Addr::UNSPECIFIED
            } else {
                Ipv4Addr::LOCALHOST
            },
            settings.port,
        ))
        .await?;
        let code = auth::secret();
        let service = Arc::new(Service {
            workbench,
            controller,
            events,
            settings,
            host: origin.split_once("://").unwrap().1.into(),
            origin,
            cookie: format!("sigpilot_remote_{}", uuid::Uuid::new_v4().simple()),
            authorization: Mutex::new(auth::Authorization::new(&code)),
            jobs: Mutex::new(vec![]),
            owners: Mutex::default(),
            permits: Arc::new(Semaphore::new(2)),
            polls: Arc::new(Semaphore::new(16)),
            directory,
            assets,
        });
        let app = router(service.clone());
        let (tx, rx) = oneshot::channel();
        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, app)
                .with_graceful_shutdown(async {
                    let _ = rx.await;
                })
                .await;
        });
        Ok(Self {
            service,
            access_code: code,
            shutdown: Some(tx),
            task,
        })
    }
    pub fn status(&self) -> Status {
        Status {
            enabled: !self.task.is_finished(),
            settings: self.service.settings.clone(),
            access_code: Some(self.access_code.clone()),
            clients: self.service.authorization.lock().unwrap().clients(),
        }
    }
    pub fn revoke(&self, id: &str) {
        self.service.authorization.lock().unwrap().revoke(id);
        self.service
            .events
            .publish(json!({"kind":"authorization_changed"}));
    }
    pub async fn stop(mut self) {
        self.service.authorization.lock().unwrap().clear();
        self.service
            .events
            .publish(json!({"kind":"authorization_changed"}));
        self.shutdown.take();
        self.task.abort();
        let _ = (&mut self.task).await;
    }
}
impl Drop for RemoteServer {
    fn drop(&mut self) {
        self.service.authorization.lock().unwrap().clear();
        self.shutdown.take();
        self.task.abort();
    }
}

pub(crate) fn response(value: Value) -> Response {
    (
        [(header::CONTENT_TYPE, "application/json")],
        value.to_string(),
    )
        .into_response()
}
pub(crate) fn failure(status: StatusCode, error: impl ToString) -> Response {
    (
        status,
        [(header::CONTENT_TYPE, "application/json")],
        json!({"error":error.to_string()}).to_string(),
    )
        .into_response()
}
pub(crate) fn result(value: Result<Value, String>) -> Response {
    match value {
        Ok(v) => response(v),
        Err(e) => failure(StatusCode::CONFLICT, e),
    }
}
fn token<'a>(s: &Service, r: &'a Request) -> Option<&'a str> {
    r.headers()
        .get(header::COOKIE)?
        .to_str()
        .ok()?
        .split(';')
        .find_map(|part| {
            let (k, v) = part.trim().split_once('=')?;
            (k == s.cookie).then_some(v)
        })
}
async fn trusted(State(s): State<Arc<Service>>, r: Request, next: Next) -> Response {
    if r.headers().get(header::HOST).and_then(|h| h.to_str().ok()) != Some(s.host.as_str())
        || r.headers()
            .get(header::ORIGIN)
            .is_some_and(|h| h.to_str().ok() != Some(s.origin.as_str()))
        || (r.method() != axum::http::Method::GET
            && (r
                .headers()
                .get(header::ORIGIN)
                .and_then(|h| h.to_str().ok())
                != Some(s.origin.as_str())
                || r.headers()
                    .get("x-sigpilot-remote")
                    .and_then(|h| h.to_str().ok())
                    != Some("1")))
    {
        return failure(StatusCode::FORBIDDEN, "Untrusted remote origin or host");
    }
    let mut response = next.run(r).await;
    for (name,value) in [("cache-control","no-store"),("x-content-type-options","nosniff"),("referrer-policy","no-referrer"),("content-security-policy","default-src 'self'; script-src 'self'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")] { response.headers_mut().insert(name,HeaderValue::from_static(value)); }
    response
}
async fn authorized(State(s): State<Arc<Service>>, mut r: Request, next: Next) -> Response {
    let client = token(&s, &r).and_then(|t| s.authorization.lock().unwrap().client(t));
    let Some(client) = client else {
        return failure(
            StatusCode::UNAUTHORIZED,
            "Connect with the access code shown on the host",
        );
    };
    r.extensions_mut().insert(client);
    next.run(r).await
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Login {
    code: String,
    name: String,
}
async fn login(State(s): State<Arc<Service>>, body: axum::body::Bytes) -> Response {
    let Ok(v) = serde_json::from_slice::<Login>(&body) else {
        return failure(StatusCode::BAD_REQUEST, "Invalid login");
    };
    if v.code.len() > 128 || v.name.is_empty() || v.name.len() > 240 {
        return failure(
            StatusCode::BAD_REQUEST,
            "Invalid access code or browser name",
        );
    }
    match s.authorization.lock().unwrap().login(&v.code, &v.name) {
        Ok((token, client)) => {
            let cookie = format!(
                "{}={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800{}",
                s.cookie,
                if s.origin.starts_with("https:") {
                    "; Secure"
                } else {
                    ""
                }
            );
            let mut r = response(
                json!({"client":client,"can_edit":s.settings.can_edit,"can_capture":s.settings.can_capture}),
            );
            r.headers_mut()
                .insert(header::SET_COOKIE, HeaderValue::from_str(&cookie).unwrap());
            r
        }
        Err(e) => failure(
            if e.starts_with("Too many") {
                StatusCode::TOO_MANY_REQUESTS
            } else {
                StatusCode::UNAUTHORIZED
            },
            e,
        ),
    }
}
async fn connection(
    State(s): State<Arc<Service>>,
    Extension(client): Extension<auth::Client>,
) -> Response {
    response(
        json!({"client":client,"can_edit":s.settings.can_edit,"can_capture":s.settings.can_capture}),
    )
}
async fn logout(
    State(s): State<Arc<Service>>,
    Extension(client): Extension<auth::Client>,
) -> Response {
    s.authorization.lock().unwrap().revoke(&client.id);
    response(json!({"ok":true}))
}
async fn asset(State(s): State<Arc<Service>>, r: Request) -> Response {
    let path = if r.uri().path() == "/" {
        "/web.html"
    } else {
        r.uri().path()
    };
    if path.contains("..")
        || path.contains('%')
        || path.contains('\\')
        || !(path == "/web.html" || path.starts_with("/assets/"))
    {
        return StatusCode::NOT_FOUND.into_response();
    }
    let Some(asset) = (s.assets)(path) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Ok(mime) = HeaderValue::from_str(&asset.mime) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let mut r = Response::new(Body::from(asset.bytes));
    r.headers_mut().insert(header::CONTENT_TYPE, mime);
    r
}
fn router(s: Arc<Service>) -> Router {
    let api = operations::router()
        .route("/connection", get(connection))
        .route("/logout", post(logout))
        .layer(middleware::from_fn_with_state(s.clone(), authorized));
    Router::new()
        .route("/api/v1/login", post(login))
        .nest("/api/v1", api)
        .fallback(asset)
        .layer(DefaultBodyLimit::max(256 * 1024))
        .layer(middleware::from_fn_with_state(s.clone(), trusted))
        .with_state(s)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn configured_origins_are_explicit_and_private_http_only() {
        for url in [
            "http://127.0.0.1:10532",
            "http://192.168.1.20:10532",
            "http://100.80.1.2:10532",
            "http://[fd00::1]:10532",
            "https://logic.example.test",
        ] {
            assert!(
                Settings {
                    public_url: url.into(),
                    ..Default::default()
                }
                .origin()
                .is_ok(),
                "{url}"
            );
        }
        for url in [
            "http://example.test",
            "http://8.8.8.8:10532",
            "https://user:pass@example.test",
            "https://example.test/prefix",
            "https://example.test?token=x",
        ] {
            assert!(
                Settings {
                    public_url: url.into(),
                    ..Default::default()
                }
                .origin()
                .is_err(),
                "{url}"
            );
        }
    }
}
