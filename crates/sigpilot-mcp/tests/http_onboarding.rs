//! Direct HTTP / OAuth registration, user consent, persistence and revocation.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rmcp::{
    model::{CallToolRequestParams, CallToolResponse},
    transport::{
        streamable_http_client::StreamableHttpClientTransportConfig, StreamableHttpClientTransport,
    },
    ServiceExt,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sigpilot_mcp::{
    desktop::DesktopMcpServer,
    onboarding::{self, Preferences},
};
use sigpilot_workbench::WorkbenchService;
use std::{sync::Arc, time::Duration};

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}
fn http() -> reqwest::Client {
    reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(8))
        .build()
        .unwrap()
}
async fn body(response: reqwest::Response) -> Value {
    let status = response.status();
    let bytes = response.bytes().await.unwrap();
    assert!(
        status.is_success(),
        "status {status}: {}",
        String::from_utf8_lossy(&bytes)
    );
    serde_json::from_slice(&bytes).unwrap()
}
async fn register(http: &reqwest::Client, root: &str) -> String {
    body(http.post(format!("{root}/oauth/register")).header("Content-Type","application/json").body(json!({"client_name":"Test Agent","redirect_uris":["http://127.0.0.1:43111/callback"],"token_endpoint_auth_method":"none"}).to_string()).send().await.unwrap()).await["client_id"].as_str().unwrap().into()
}
async fn consent(
    http: &reqwest::Client,
    root: &str,
    server: &DesktopMcpServer,
    client: &str,
    allow: bool,
) -> Value {
    let verifier = "a".repeat(64);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let url = reqwest::Url::parse_with_params(
        &format!("{root}/oauth/authorize"),
        [
            ("response_type", "code"),
            ("client_id", client),
            ("redirect_uri", "http://127.0.0.1:43112/callback"),
            ("state", "test-state-123"),
            ("resource", &format!("{root}/mcp")),
            ("code_challenge_method", "S256"),
            ("code_challenge", &challenge),
        ],
    )
    .unwrap();
    assert_eq!(http.get(url).send().await.unwrap().status(), 200);
    let auth = server.authorization().unwrap();
    let pending = auth.status().unwrap().pending;
    assert_eq!(pending.len(), 1);
    auth.decide(&pending[0].request_id, allow).unwrap();
    let result = body(
        http.get(format!("{root}/oauth/status/{}", pending[0].request_id))
            .send()
            .await
            .unwrap(),
    )
    .await;
    let redirect = reqwest::Url::parse(result["redirect"].as_str().unwrap()).unwrap();
    let fields = redirect
        .query_pairs()
        .collect::<std::collections::HashMap<_, _>>();
    assert_eq!(fields["state"], "test-state-123");
    assert_eq!(fields["iss"], root);
    if !allow {
        assert_eq!(fields["error"], "access_denied");
        return json!(null);
    }
    let form = |verifier: &str| {
        reqwest::Url::parse_with_params(
            "http://localhost/",
            [
                ("grant_type", "authorization_code"),
                ("client_id", client),
                ("resource", &format!("{root}/mcp")),
                ("redirect_uri", "http://127.0.0.1:43112/callback"),
                ("code", fields["code"].as_ref()),
                ("code_verifier", verifier),
            ],
        )
        .unwrap()
        .query()
        .unwrap()
        .to_string()
    };
    assert_eq!(
        http.post(format!("{root}/oauth/token"))
            .header("Content-Type", "application/x-www-form-urlencoded")
            .body(form(&"b".repeat(64)))
            .send()
            .await
            .unwrap()
            .status(),
        400
    );
    let tokens = body(
        http.post(format!("{root}/oauth/token"))
            .header("Content-Type", "application/x-www-form-urlencoded")
            .body(form(&verifier))
            .send()
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(
        http.post(format!("{root}/oauth/token"))
            .header("Content-Type", "application/x-www-form-urlencoded")
            .body(form(&verifier))
            .send()
            .await
            .unwrap()
            .status(),
        400
    );
    tokens
}

#[tokio::test(flavor = "current_thread")]
async fn fixed_http_oauth_marker_restart_refresh_and_revoke() {
    let directory = std::env::temp_dir().join(format!("sigpilot-http-{}", uuid::Uuid::new_v4()));
    let port = free_port();
    let root = format!("http://127.0.0.1:{port}");
    let endpoint = format!("{root}/mcp");
    let prefs = Preferences {
        can_capture: false,
        enabled: true,
        can_edit: true,
        port,
    };
    onboarding::save_preferences(&directory, &prefs).unwrap();
    let workbench = Arc::new(WorkbenchService::default());
    let metadata=serde_json::from_value(json!({"version":1,"source_device":"http-fixture","sample_rate_hz":1000000,"channel_count":1,"enabled_channels":[0],"unitsize":1,"sample_count":20,"captured_at":"2026-11-16T00:00:00Z","labels":["D0"]})).unwrap();
    workbench
        .import_capture(
            "http",
            sigpilot_file::PxlogicProjectCapture::Sparse(sigpilot_core::SparseCaptureData {
                metadata,
                channels: vec![sigpilot_core::SparseDigitalChannel {
                    channel: 0,
                    initial_high: false,
                    transitions: vec![2, 5, 7],
                }],
            }),
        )
        .unwrap();
    let server = DesktopMcpServer::start_on_port(workbench.clone(), &directory, true, port)
        .await
        .unwrap();
    let http = http();
    let rejected = http.post(&endpoint).body("{}").send().await.unwrap();
    assert_eq!(rejected.status(), 401);
    assert!(rejected.headers()["WWW-Authenticate"]
        .to_str()
        .unwrap()
        .contains("resource_metadata="));
    assert_eq!(
        http.get(format!("{root}/.well-known/oauth-authorization-server"))
            .header("Origin", "https://evil.example")
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    assert_eq!(
        http.get(format!("{root}/.well-known/oauth-authorization-server"))
            .header("Host", "evil.example")
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    let metadata = body(
        http.get(format!("{root}/.well-known/oauth-protected-resource/mcp"))
            .send()
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(metadata["resource"], endpoint);
    assert_eq!(
        http.post(format!("{root}/oauth/register"))
            .body(json!({"redirect_uris":["https://evil.example/callback"]}).to_string())
            .send()
            .await
            .unwrap()
            .status(),
        400
    );
    let client_id = register(&http, &root).await;
    consent(&http, &root, &server, &client_id, false).await;
    assert!(server
        .authorization()
        .unwrap()
        .status()
        .unwrap()
        .clients
        .is_empty());
    let tokens = consent(&http, &root, &server, &client_id, true).await;
    let config = StreamableHttpClientTransportConfig::with_uri(endpoint.clone())
        .auth_header(tokens["access_token"].as_str().unwrap().to_string());
    let client = ()
        .serve(StreamableHttpClientTransport::with_client(
            http.clone(),
            config,
        ))
        .await
        .unwrap();
    let tool = |name: &str, args: Value| {
        serde_json::from_value::<CallToolRequestParams>(json!({"name":name,"arguments":args}))
            .unwrap()
    };
    assert!(client
        .peer()
        .list_tools(None)
        .await
        .unwrap()
        .tools
        .iter()
        .any(|t| t.name == "sigpilot_apply_annotations"));
    let context = workbench.context("http").unwrap();
    let response=client.peer().call_tool_once(tool("sigpilot_apply_annotations",json!({"capture":context.capture,"expected_annotation_revision":"0","request_id":"http-marker","operations":[{"op":"create","annotation":{"kind":"timing_point","sample":"5","title":"HTTP marker","color":"#ffc44d"}}]}))).await.unwrap();
    let CallToolResponse::Complete(response) = response else {
        panic!("unexpected response")
    };
    assert!(!response.is_error.unwrap_or(false));
    assert_eq!(
        workbench.gui_snapshot("http").unwrap().annotations[0]
            .value
            .sample
            .0,
        5
    );
    client.cancel().await.unwrap();
    server.stop().await;
    let server = DesktopMcpServer::start_on_port(workbench.clone(), &directory, false, port)
        .await
        .unwrap();
    assert_eq!(server.status().endpoint.as_deref(), Some(endpoint.as_str()));
    assert_eq!(
        server
            .authorization()
            .unwrap()
            .status()
            .unwrap()
            .clients
            .len(),
        1
    );
    assert!(server
        .authorization()
        .unwrap()
        .access_identity(tokens["access_token"].as_str().unwrap())
        .is_some());
    let other = sigpilot_mcp::oauth::Authorization::open(
        directory.clone(),
        format!("http://127.0.0.1:{}", free_port()),
    )
    .unwrap();
    assert!(other
        .access_identity(tokens["access_token"].as_str().unwrap())
        .is_none());
    let refresh_form = reqwest::Url::parse_with_params(
        "http://localhost/",
        [
            ("grant_type", "refresh_token"),
            ("client_id", client_id.as_str()),
            ("resource", endpoint.as_str()),
            ("refresh_token", tokens["refresh_token"].as_str().unwrap()),
        ],
    )
    .unwrap()
    .query()
    .unwrap()
    .to_string();
    let refreshed = body(
        http.post(format!("{root}/oauth/token"))
            .body(refresh_form.clone())
            .send()
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(
        http.post(format!("{root}/oauth/token"))
            .body(refresh_form)
            .send()
            .await
            .unwrap()
            .status(),
        400
    );
    assert!(server
        .authorization()
        .unwrap()
        .access_identity(tokens["access_token"].as_str().unwrap())
        .is_none());
    let config = StreamableHttpClientTransportConfig::with_uri(endpoint.clone())
        .auth_header(refreshed["access_token"].as_str().unwrap().to_string());
    let client = ()
        .serve(StreamableHttpClientTransport::with_client(
            http.clone(),
            config,
        ))
        .await
        .unwrap();
    assert!(!client
        .peer()
        .list_tools(None)
        .await
        .unwrap()
        .tools
        .iter()
        .any(|t| t.name == "sigpilot_apply_annotations"));
    client.cancel().await.unwrap();
    let second_id = register(&http, &root).await;
    let second_tokens = consent(&http, &root, &server, &second_id, true).await;
    assert_ne!(
        server
            .authorization()
            .unwrap()
            .access_identity(refreshed["access_token"].as_str().unwrap()),
        server
            .authorization()
            .unwrap()
            .access_identity(second_tokens["access_token"].as_str().unwrap())
    );
    let auth = server.authorization().unwrap();
    auth.revoke(
        &auth
            .access_identity(refreshed["access_token"].as_str().unwrap())
            .unwrap(),
    )
    .unwrap();
    assert_eq!(
        http.post(&endpoint)
            .bearer_auth(refreshed["access_token"].as_str().unwrap())
            .body("{}")
            .send()
            .await
            .unwrap()
            .status(),
        401
    );
    server.stop().await;
    let blocker = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).unwrap();
    let conflict = DesktopMcpServer::start_on_port(workbench, &directory, false, port)
        .await
        .err()
        .unwrap();
    assert_eq!(conflict.kind(), std::io::ErrorKind::AddrInUse);
    assert!(conflict.to_string().contains(&port.to_string()));
    drop(blocker);
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn http_registration_is_identical_across_platforms_and_has_no_paths_or_secrets() {
    let configs = onboarding::http_configurations("http://127.0.0.1:10531/mcp");
    assert_eq!(
        configs[0].registration_command.as_deref(),
        Some("codex mcp add sigpilot --url http://127.0.0.1:10531/mcp")
    );
    assert_eq!(
        configs[1].registration_command.as_deref(),
        Some("claude mcp add --transport http --scope user sigpilot http://127.0.0.1:10531/mcp")
    );
    for config in &configs {
        assert!(!config.content.contains("command"));
        assert!(!config.content.contains("token"));
    }
    let uri = reqwest::Url::parse(configs[2].install_uri.as_deref().unwrap()).unwrap();
    let encoded = uri
        .query_pairs()
        .find(|(k, _)| k == "config")
        .unwrap()
        .1
        .into_owned();
    let payload: Value = serde_json::from_slice(
        &base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .unwrap(),
    )
    .unwrap();
    assert_eq!(payload, json!({"url":"http://127.0.0.1:10531/mcp"}));
    assert_eq!(
        serde_json::from_str::<Preferences>("{\"enabled\":true,\"can_edit\":false}")
            .unwrap()
            .port,
        10531
    );
    assert!(onboarding::validate_port(0).is_err());
}
