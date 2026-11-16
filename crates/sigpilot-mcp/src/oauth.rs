//! Local OAuth authorization-code flow. Consent is granted only by the desktop UI.
use axum::{
    body::{Body, Bytes},
    extract::State,
    http::{header, Request, StatusCode},
    middleware::{self, Next},
    response::{Html, IntoResponse, Response},
    routing::{get, post},
    Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    io,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};
use tower::ServiceExt;

const LIMIT: usize = 64;
const ACCESS_LIFETIME: u64 = 3600;
const REFRESH_LIFETIME: u64 = 30 * 24 * 3600;
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
fn secret() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}
fn hash(value: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(value.as_bytes()))
}
fn equal(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |v, (a, b)| v | (a ^ b)) == 0
}

#[derive(Clone, Serialize, Deserialize)]
struct Client {
    id: String,
    name: String,
    redirect_uris: Vec<String>,
}
#[derive(Clone, Serialize, Deserialize)]
struct Grant {
    id: String,
    client_id: String,
    access_hash: String,
    refresh_hash: String,
    access_expires: u64,
    refresh_expires: u64,
}
#[derive(Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Saved {
    #[serde(default)]
    resource: String,
    clients: Vec<Client>,
    grants: Vec<Grant>,
}
struct Pending {
    client: Client,
    redirect_uri: String,
    state: String,
    challenge: String,
    expires: u64,
    decision: Option<bool>,
    code: Option<String>,
}
struct Code {
    client_id: String,
    grant_id: String,
    redirect_uri: String,
    challenge: String,
    expires: u64,
}
struct Runtime {
    saved: Saved,
    pending: HashMap<String, Pending>,
    codes: HashMap<String, Code>,
}
#[derive(Clone)]
pub struct Authorization {
    directory: PathBuf,
    root: String,
    inner: Arc<Mutex<Runtime>>,
}

#[derive(Serialize)]
pub struct PendingAuthorization {
    pub request_id: String,
    pub client_name: String,
    pub redirect_uri: String,
}
#[derive(Serialize)]
pub struct AuthorizedClient {
    pub grant_id: String,
    pub client_name: String,
}
#[derive(Serialize)]
pub struct AuthorizationStatus {
    pub pending: Vec<PendingAuthorization>,
    pub clients: Vec<AuthorizedClient>,
}

impl Authorization {
    pub fn open(directory: PathBuf, root: String) -> io::Result<Self> {
        let mut saved: Saved =
            crate::storage::read(&directory, "http-authorization.json", 256 * 1024)?
                .unwrap_or_default();
        if saved.clients.len() > LIMIT || saved.grants.len() > LIMIT {
            return Err(io::ErrorKind::InvalidData.into());
        }
        let resource = format!("{root}/mcp");
        if saved.resource != resource {
            saved = Saved {
                resource,
                clients: vec![],
                grants: vec![],
            };
        }
        saved.grants.retain(|g| g.refresh_expires > now());
        Ok(Self {
            directory,
            root,
            inner: Arc::new(Mutex::new(Runtime {
                saved,
                pending: HashMap::new(),
                codes: HashMap::new(),
            })),
        })
    }
    fn save(&self, saved: &Saved) -> io::Result<()> {
        if serde_json::to_vec(saved)?.len() > 240 * 1024 {
            return Err(io::Error::other(
                "MCP authorization storage is full; revoke unused clients",
            ));
        }
        crate::storage::write(&self.directory, "http-authorization.json", saved)
    }
    pub fn status(&self) -> io::Result<AuthorizationStatus> {
        let mut data = self.inner.lock().map_err(|_| io::ErrorKind::Other)?;
        data.pending.retain(|_, p| p.expires > now());
        Ok(AuthorizationStatus {
            pending: data
                .pending
                .iter()
                .filter(|(_, p)| p.decision.is_none())
                .map(|(id, p)| PendingAuthorization {
                    request_id: id.clone(),
                    client_name: p.client.name.clone(),
                    redirect_uri: p.redirect_uri.clone(),
                })
                .collect(),
            clients: data
                .saved
                .grants
                .iter()
                .filter(|g| g.refresh_expires > now())
                .map(|g| AuthorizedClient {
                    grant_id: g.id.clone(),
                    client_name: data
                        .saved
                        .clients
                        .iter()
                        .find(|c| c.id == g.client_id)
                        .map(|c| c.name.clone())
                        .unwrap_or_else(|| "MCP client".into()),
                })
                .collect(),
        })
    }
    pub fn decide(&self, id: &str, allow: bool) -> io::Result<()> {
        let mut data = self.inner.lock().map_err(|_| io::ErrorKind::Other)?;
        if data.codes.len() >= 16 {
            return Err(io::Error::other("Too many pending authorization codes"));
        }
        let pending = data
            .pending
            .get_mut(id)
            .filter(|p| p.expires > now() && p.decision.is_none())
            .ok_or_else(|| io::Error::other("Authorization request expired"))?;
        pending.decision = Some(allow);
        if allow {
            let code = secret();
            pending.code = Some(code.clone());
            let record = Code {
                client_id: pending.client.id.clone(),
                grant_id: uuid::Uuid::new_v4().to_string(),
                redirect_uri: pending.redirect_uri.clone(),
                challenge: pending.challenge.clone(),
                expires: now() + 60,
            };
            data.codes.insert(hash(&code), record);
        }
        Ok(())
    }
    pub fn revoke(&self, id: &str) -> io::Result<()> {
        let mut data = self.inner.lock().map_err(|_| io::ErrorKind::Other)?;
        let mut next = Saved {
            resource: data.saved.resource.clone(),
            clients: data.saved.clients.clone(),
            grants: data
                .saved
                .grants
                .iter()
                .filter(|g| g.id != id)
                .cloned()
                .collect(),
        };
        next.grants.retain(|g| g.refresh_expires > now());
        self.save(&next)?;
        data.saved = next;
        Ok(())
    }
    pub fn access_identity(&self, token: &str) -> Option<String> {
        let digest = hash(token);
        let data = self.inner.lock().ok()?;
        data.saved
            .grants
            .iter()
            .find(|g| g.access_expires > now() && equal(&g.access_hash, &digest))
            .map(|g| g.id.clone())
    }
    fn challenge(&self) -> Response {
        (StatusCode::UNAUTHORIZED,[(header::WWW_AUTHENTICATE,format!("Bearer resource_metadata=\"{}/.well-known/oauth-protected-resource/mcp\", scope=\"sigpilot\"",self.root))],"MCP authorization required").into_response()
    }
}

fn json_response(value: Value) -> Response {
    (
        [
            (header::CONTENT_TYPE, "application/json"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        value.to_string(),
    )
        .into_response()
}
fn error(code: &str) -> Response {
    (
        StatusCode::BAD_REQUEST,
        [
            (header::CONTENT_TYPE, "application/json"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        json!({"error":code}).to_string(),
    )
        .into_response()
}
fn fields(bytes: &[u8]) -> Result<HashMap<String, String>, Response> {
    if bytes.len() > 16 * 1024 {
        return Err(error("invalid_request"));
    }
    let text = std::str::from_utf8(bytes).map_err(|_| error("invalid_request"))?;
    let mut map = HashMap::new();
    for (key, value) in reqwest::Url::parse(&format!("http://localhost/?{text}"))
        .map_err(|_| error("invalid_request"))?
        .query_pairs()
    {
        if map.insert(key.into_owned(), value.into_owned()).is_some() {
            return Err(error("invalid_request"));
        }
    }
    Ok(map)
}
fn redirect_valid(uri: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(uri) else {
        return false;
    };
    url.scheme() == "http"
        && matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"))
        && url.port().is_some()
        && url.username().is_empty()
        && url.password().is_none()
        && url.fragment().is_none()
        && uri.len() <= 2048
}
fn redirect_matches(registered: &str, actual: &str) -> bool {
    let (Ok(mut a), Ok(mut b)) = (reqwest::Url::parse(registered), reqwest::Url::parse(actual))
    else {
        return false;
    };
    // Native client loopback callback ports are selected at runtime (RFC 8252).
    let _ = a.set_port(None);
    let _ = b.set_port(None);
    a == b && redirect_valid(actual)
}

async fn resource_metadata(State(auth): State<Authorization>) -> Response {
    json_response(
        json!({"resource":format!("{}/mcp",auth.root),"authorization_servers":[auth.root],"scopes_supported":["sigpilot"],"bearer_methods_supported":["header"],"resource_name":"SigPilot"}),
    )
}
async fn server_metadata(State(auth): State<Authorization>) -> Response {
    json_response(
        json!({"issuer":auth.root,"authorization_endpoint":format!("{}/oauth/authorize",auth.root),"token_endpoint":format!("{}/oauth/token",auth.root),"registration_endpoint":format!("{}/oauth/register",auth.root),"revocation_endpoint":format!("{}/oauth/revoke",auth.root),"response_types_supported":["code"],"grant_types_supported":["authorization_code","refresh_token"],"token_endpoint_auth_methods_supported":["none"],"code_challenge_methods_supported":["S256"],"scopes_supported":["sigpilot"]}),
    )
}
async fn register(State(auth): State<Authorization>, body: Bytes) -> Response {
    if body.len() > 16 * 1024 {
        return error("invalid_client_metadata");
    }
    let Ok(v) = serde_json::from_slice::<Value>(&body) else {
        return error("invalid_client_metadata");
    };
    let Some(uris) = v["redirect_uris"].as_array() else {
        return error("invalid_redirect_uri");
    };
    if uris.is_empty()
        || uris.len() > 8
        || v.get("token_endpoint_auth_method")
            .is_some_and(|v| v != "none")
    {
        return error("invalid_client_metadata");
    }
    let uris: Vec<String> = uris
        .iter()
        .filter_map(|v| {
            v.as_str()
                .filter(|s| {
                    let Ok(mut url) = reqwest::Url::parse(s) else {
                        return false;
                    };
                    if url.port().is_none() {
                        let _ = url.set_port(Some(3000));
                    }
                    redirect_valid(url.as_str())
                })
                .map(String::from)
        })
        .collect();
    if uris.len() != v["redirect_uris"].as_array().unwrap().len() {
        return error("invalid_redirect_uri");
    }
    let name = v["client_name"]
        .as_str()
        .unwrap_or("MCP client")
        .chars()
        .filter(|c| !c.is_control())
        .take(128)
        .collect::<String>();
    let Ok(mut data) = auth.inner.lock() else {
        return error("server_error");
    };
    // Reuse identical public registrations; repeated CLI login does not exhaust storage.
    let id = if let Some(client) = data
        .saved
        .clients
        .iter()
        .find(|c| c.name == name && c.redirect_uris == uris)
    {
        client.id.clone()
    } else {
        if data.saved.clients.len() >= LIMIT {
            return error("registration_limit");
        }
        let id = uuid::Uuid::new_v4().to_string();
        let mut next = Saved {
            resource: data.saved.resource.clone(),
            clients: data.saved.clients.clone(),
            grants: data.saved.grants.clone(),
        };
        next.clients.push(Client {
            id: id.clone(),
            name: name.clone(),
            redirect_uris: uris.clone(),
        });
        if auth.save(&next).is_err() {
            return error("server_error");
        }
        data.saved = next;
        id
    };
    let mut response = json_response(
        json!({"client_id":id,"client_id_issued_at":now(),"client_name":name,"redirect_uris":uris,"grant_types":["authorization_code","refresh_token"],"response_types":["code"],"token_endpoint_auth_method":"none"}),
    );
    *response.status_mut() = StatusCode::CREATED;
    response
}

async fn authorize(State(auth): State<Authorization>, uri: axum::http::Uri) -> Response {
    let q = match fields(uri.query().unwrap_or("").as_bytes()) {
        Ok(q) => q,
        Err(r) => return r,
    };
    if q.get("response_type").map(String::as_str) != Some("code")
        || q.get("code_challenge_method").map(String::as_str) != Some("S256")
        || q.get("resource").map(String::as_str) != Some(format!("{}/mcp", auth.root).as_str())
        || q.get("scope").is_some_and(|s| {
            s.split_whitespace()
                .any(|s| s != "sigpilot" && s != "offline_access")
        })
    {
        return error("invalid_request");
    }
    let Some(challenge) = q.get("code_challenge").filter(|s| {
        s.len() == 43
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b))
    }) else {
        return error("invalid_request");
    };
    let Some(state) = q.get("state").filter(|s| s.len() >= 8 && s.len() <= 1024) else {
        return error("invalid_request");
    };
    let Some(redirect) = q.get("redirect_uri").filter(|s| redirect_valid(s)) else {
        return error("invalid_redirect_uri");
    };
    let Ok(mut data) = auth.inner.lock() else {
        return error("server_error");
    };
    data.pending.retain(|_, p| p.expires > now());
    data.codes.retain(|_, c| c.expires > now());
    let Some(client) = data
        .saved
        .clients
        .iter()
        .find(|c| {
            Some(&c.id) == q.get("client_id")
                && c.redirect_uris
                    .iter()
                    .any(|r| redirect_matches(r, redirect))
        })
        .cloned()
    else {
        return error("invalid_client");
    };
    if data.pending.len() >= 16 {
        return error("authorization_limit");
    }
    let id = secret();
    data.pending.insert(
        id.clone(),
        Pending {
            client,
            redirect_uri: redirect.clone(),
            state: state.clone(),
            challenge: challenge.clone(),
            expires: now() + 300,
            decision: None,
            code: None,
        },
    );
    // This browser page has no approval action. Only the Tauri UI can grant access.
    let html = format!(
        r#"<!doctype html><html><meta charset="utf-8"><title>SigPilot MCP</title><style>body{{font:16px system-ui;background:#14161a;color:#eee;max-width:520px;margin:15vh auto;padding:24px}}p{{line-height:1.6;color:#bbb}}</style><h1>SigPilot MCP</h1><p>请在 SigPilot 的 AI / MCP 面板中确认授权。<br>Approve this connection in SigPilot’s AI / MCP panel.</p><p id="status">Waiting for approval…</p><script>const timer=setInterval(async()=>{{try{{const r=await fetch('/oauth/status/{id}');const v=await r.json();if(v.redirect){{clearInterval(timer);location.replace(v.redirect)}}else if(v.error){{clearInterval(timer);document.getElementById('status').textContent=v.error}}}}catch{{}}}},1000);</script></html>"#
    );
    ([(header::CACHE_CONTROL,"no-store"),(header::CONTENT_SECURITY_POLICY,"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'"),(header::REFERRER_POLICY,"no-referrer")],Html(html)).into_response()
}
async fn authorization_poll(
    State(auth): State<Authorization>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> Response {
    let Ok(data) = auth.inner.lock() else {
        return error("server_error");
    };
    let Some(pending) = data.pending.get(&id).filter(|p| p.expires > now()) else {
        return json_response(json!({"error":"Authorization expired"}));
    };
    let Some(allowed) = pending.decision else {
        return json_response(json!({"pending":true}));
    };
    let Ok(mut redirect) = reqwest::Url::parse(&pending.redirect_uri) else {
        return error("invalid_redirect_uri");
    };
    redirect
        .query_pairs_mut()
        .append_pair("state", &pending.state)
        .append_pair("iss", &auth.root);
    if allowed {
        redirect
            .query_pairs_mut()
            .append_pair("code", pending.code.as_deref().unwrap_or(""));
    } else {
        redirect
            .query_pairs_mut()
            .append_pair("error", "access_denied");
    }
    json_response(json!({"redirect":redirect.to_string()}))
}

async fn token(State(auth): State<Authorization>, body: Bytes) -> Response {
    let q = match fields(&body) {
        Ok(q) => q,
        Err(r) => return r,
    };
    if q.get("resource").map(String::as_str) != Some(format!("{}/mcp", auth.root).as_str()) {
        return error("invalid_target");
    }
    let Some(client) = q.get("client_id") else {
        return error("invalid_client");
    };
    let Ok(mut data) = auth.inner.lock() else {
        return error("server_error");
    };
    let mut next = Saved {
        resource: data.saved.resource.clone(),
        clients: data.saved.clients.clone(),
        grants: data.saved.grants.clone(),
    };
    next.grants.retain(|g| g.refresh_expires > now());
    let id = match q.get("grant_type").map(String::as_str) {
        Some("authorization_code") => {
            let Some(code) = q.get("code") else {
                return error("invalid_grant");
            };
            let Some(record) = data.codes.get(&hash(code)) else {
                return error("invalid_grant");
            };
            let Some(verifier) = q.get("code_verifier").filter(|v| {
                (43..=128).contains(&v.len())
                    && v.bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"-._~".contains(&b))
            }) else {
                return error("invalid_grant");
            };
            if record.expires <= now()
                || record.client_id != *client
                || Some(&record.redirect_uri) != q.get("redirect_uri")
                || !equal(&record.challenge, &hash(verifier))
            {
                return error("invalid_grant");
            }
            if next.grants.len() >= LIMIT {
                return error("authorization_limit");
            }
            record.grant_id.clone()
        }
        Some("refresh_token") => {
            let Some(refresh) = q.get("refresh_token") else {
                return error("invalid_grant");
            };
            let digest = hash(refresh);
            let Some(grant) = next
                .grants
                .iter()
                .find(|g| g.client_id == *client && equal(&g.refresh_hash, &digest))
            else {
                return error("invalid_grant");
            };
            let id = grant.id.clone();
            next.grants.retain(|g| g.id != id);
            id
        }
        _ => return error("unsupported_grant_type"),
    };
    let access = secret();
    let refresh = secret();
    next.grants.push(Grant {
        id,
        client_id: client.clone(),
        access_hash: hash(&access),
        refresh_hash: hash(&refresh),
        access_expires: now() + ACCESS_LIFETIME,
        refresh_expires: now() + REFRESH_LIFETIME,
    });
    if auth.save(&next).is_err() {
        return error("server_error");
    }
    data.saved = next;
    if let Some(code) = q.get("code") {
        data.codes.remove(&hash(code));
    }
    json_response(
        json!({"access_token":access,"token_type":"Bearer","expires_in":ACCESS_LIFETIME,"refresh_token":refresh,"scope":"sigpilot"}),
    )
}
async fn revoke(State(auth): State<Authorization>, body: Bytes) -> Response {
    let q = match fields(&body) {
        Ok(q) => q,
        Err(r) => return r,
    };
    let Some(token) = q.get("token") else {
        return error("invalid_request");
    };
    let digest = hash(token);
    let id = auth.inner.lock().ok().and_then(|data| {
        data.saved
            .grants
            .iter()
            .find(|g| {
                Some(&g.client_id) == q.get("client_id")
                    && (equal(&g.access_hash, &digest) || equal(&g.refresh_hash, &digest))
            })
            .map(|g| g.id.clone())
    });
    if let Some(id) = id {
        if auth.revoke(&id).is_err() {
            return error("server_error");
        }
    }
    StatusCode::OK.into_response()
}

#[derive(Clone)]
struct Dispatch {
    auth: Authorization,
    internal_token: Arc<str>,
    adapter: crate::McpAdapter,
    routers: Arc<Mutex<HashMap<String, Router>>>,
    budget: Arc<tokio::sync::Semaphore>,
}
async fn dispatch(State(state): State<Dispatch>, request: Request<Body>) -> Response {
    let Ok(_permit) = state.budget.try_acquire() else {
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    };
    let bearer = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or("");
    let identity = if equal(bearer, &state.internal_token) {
        "desktop-internal".to_string()
    } else {
        let Some(id) = state.auth.access_identity(bearer) else {
            return state.auth.challenge();
        };
        id
    };
    let router = {
        let Ok(mut routers) = state.routers.lock() else {
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        };
        if routers.len() >= LIMIT {
            routers.retain(|id, _| {
                id == "desktop-internal"
                    || state
                        .auth
                        .inner
                        .lock()
                        .ok()
                        .is_some_and(|a| a.saved.grants.iter().any(|g| g.id == *id))
            });
        }
        routers
            .entry(identity.clone())
            .or_insert_with(|| {
                let mut adapter = state.adapter.clone();
                adapter.caller_id = format!("http-client-{identity}").into();
                crate::server::mcp_router(adapter)
            })
            .clone()
    };
    router
        .oneshot(request)
        .await
        .unwrap_or_else(|never| match never {})
}
async fn local_request(State(root): State<String>, request: Request<Body>, next: Next) -> Response {
    let expected = root.strip_prefix("http://").unwrap_or("");
    if request
        .headers()
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        != Some(expected)
        || request
            .headers()
            .get(header::ORIGIN)
            .is_some_and(|origin| origin.to_str().ok() != Some(root.as_str()))
    {
        return StatusCode::FORBIDDEN.into_response();
    }
    next.run(request).await
}
pub fn router(adapter: crate::McpAdapter, auth: Authorization, internal_token: String) -> Router {
    let root = auth.root.clone();
    let dispatch = Dispatch {
        auth: auth.clone(),
        internal_token: internal_token.into(),
        adapter,
        routers: Arc::new(Mutex::new(HashMap::new())),
        budget: Arc::new(tokio::sync::Semaphore::new(4)),
    };
    Router::new()
        .route(
            "/mcp",
            axum::routing::any(dispatch_handler).with_state(dispatch),
        )
        .merge(
            Router::new()
                .route(
                    "/.well-known/oauth-protected-resource/mcp",
                    get(resource_metadata),
                )
                .route(
                    "/.well-known/oauth-protected-resource",
                    get(resource_metadata),
                )
                .route(
                    "/.well-known/oauth-authorization-server",
                    get(server_metadata),
                )
                .route("/oauth/register", post(register))
                .route("/oauth/authorize", get(authorize))
                .route("/oauth/status/{id}", get(authorization_poll))
                .route("/oauth/token", post(token))
                .route("/oauth/revoke", post(revoke))
                .with_state(auth),
        )
        .layer(axum::extract::DefaultBodyLimit::max(256 * 1024))
        .layer(middleware::from_fn_with_state(root, local_request))
}
async fn dispatch_handler(State(state): State<Dispatch>, request: Request<Body>) -> Response {
    dispatch(State(state), request).await
}
