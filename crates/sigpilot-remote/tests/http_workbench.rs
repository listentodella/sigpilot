mod support;
use serde_json::{json, Value};
use sigpilot_remote::{Asset, RemoteServer, Settings};
use std::{
    sync::{atomic::AtomicBool, Arc},
    time::Duration,
};

struct Fixture {
    demo: Arc<support::Demo>,
    server: RemoteServer,
    http: reqwest::Client,
    url: String,
    directory: std::path::PathBuf,
}
impl Fixture {
    async fn new(edit: bool, capture: bool) -> Self {
        let demo = support::Demo::new();
        demo.record(
            "demo",
            &support::Demo::settings(),
            &[support::Demo::uart()],
            &AtomicBool::new(false),
        )
        .unwrap();
        demo.workbench.set_gui_attached("demo", true).unwrap();
        demo.workbench
            .session("demo")
            .unwrap()
            .graph
            .set_session_view(500.0, 1000.0);
        let socket = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = socket.local_addr().unwrap().port();
        drop(socket);
        let url = format!("http://127.0.0.1:{port}");
        let directory = std::env::temp_dir().join(format!(
            "sigpilot-remote-test-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let server = RemoteServer::start(
            demo.workbench.clone(),
            demo.clone(),
            demo.events.clone(),
            Settings {
                port,
                public_url: url.clone(),
                can_edit: edit,
                can_capture: capture,
                ..Default::default()
            },
            directory.clone(),
            Arc::new(|path| {
                (path == "/web.html").then(|| Asset {
                    bytes: b"<!doctype html>".to_vec(),
                    mime: "text/html".into(),
                })
            }),
        )
        .await
        .unwrap();
        Self {
            demo,
            server,
            http: reqwest::Client::builder().no_proxy().build().unwrap(),
            url,
            directory,
        }
    }
    async fn call(&self, path: &str, cookie: &str, body: Option<Value>) -> (u16, Vec<u8>) {
        let builder = if let Some(body) = body {
            self.http
                .post(format!("{}{path}", self.url))
                .header("origin", &self.url)
                .header("x-sigpilot-remote", "1")
                .body(body.to_string())
        } else {
            self.http.get(format!("{}{path}", self.url))
        };
        let response = builder.header("cookie", cookie).send().await.unwrap();
        (
            response.status().as_u16(),
            response.bytes().await.unwrap().to_vec(),
        )
    }
    async fn login(&self, name: &str) -> String {
        let response = self
            .http
            .post(format!("{}/api/v1/login", self.url))
            .header("origin", &self.url)
            .header("x-sigpilot-remote", "1")
            .body(json!({"code":self.server.status().access_code,"name":name}).to_string())
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        response.headers()["set-cookie"]
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap()
            .into()
    }
    async fn snapshot(&self, cookie: &str) -> Value {
        let (code, bytes) = self
            .call("/api/v1/sessions/demo/snapshot", cookie, None)
            .await;
        assert_eq!(code, 200);
        serde_json::from_slice(&bytes).unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}
fn capture(snapshot: &Value) -> Value {
    json!({"session_id":snapshot["context"]["session_id"],"capture_id":snapshot["context"]["capture_id"],"data_revision":snapshot["context"]["data_revision"]})
}
fn annotation(snapshot: &Value, id: &str) -> Value {
    json!({"capture":capture(snapshot),"expected_annotation_revision":snapshot["context"]["annotation_revision"],"request_id":id,"operations":[{"op":"create","id":"at-five","annotation":{"kind":"timing_point","sample":"5","title":"remote test","color":"#e6b35a"}}]})
}

#[tokio::test]
async fn shared_markers_independent_views_and_file_roundtrip() {
    let f = Fixture::new(true, true).await;
    let a = f.login("Alice").await;
    let b = f.login("Bob").await;
    assert_ne!(a, b);
    let snapshot = f.snapshot(&a).await;
    assert_eq!(snapshot["context"]["sample_rate_hz"], "1000000");
    assert_eq!(snapshot["context"]["sample_count"], "10048");
    let view = f
        .demo
        .workbench
        .session("demo")
        .unwrap()
        .graph
        .session_view();
    for start in [0, 4000] {
        let (code,bytes)=f.call("/api/v1/sessions/demo/frame",&a,Some(json!({"capture":capture(&snapshot),"request":{"frame_id":1,"waveform":{"start_sample":start,"sample_count":1000,"pixels":100,"channels":[0,1]},"analyzers":[]}}))).await;
        assert_eq!(code, 200);
        assert_eq!(&bytes[..5], b"PXGF1");
        let header_size = u32::from_le_bytes(bytes[5..9].try_into().unwrap()) as usize;
        let header: Value = serde_json::from_slice(&bytes[13..13 + header_size]).unwrap();
        assert_eq!(header["tile"]["start_sample"], start);
        assert!(!bytes.is_empty());
    }
    assert_eq!(
        f.demo
            .workbench
            .session("demo")
            .unwrap()
            .graph
            .session_view(),
        view
    );
    let body = annotation(&snapshot, "mark-5");
    let (code, bytes) = f
        .call("/api/v1/sessions/demo/annotations", &a, Some(body.clone()))
        .await;
    assert_eq!(code, 200, "{}", String::from_utf8_lossy(&bytes));
    let result: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(result["upserts"][0]["sample"], "5");
    assert_eq!(
        f.call("/api/v1/sessions/demo/annotations", &a, Some(body))
            .await
            .1,
        bytes
    ); // idempotent retry
    let shared = f.snapshot(&b).await;
    assert_eq!(shared["annotations"][0]["sample"], "5");
    assert_ne!(result["actor_id"], "gui");
    let (code, bytes) = f
        .call(
            "/api/v1/sessions/demo/annotations",
            &b,
            Some(annotation(&snapshot, "stale")),
        )
        .await;
    assert_eq!(code, 409, "{}", String::from_utf8_lossy(&bytes));
    let undo = json!({"capture":capture(&shared),"expected_annotation_revision":shared["context"]["annotation_revision"],"batch_id":result["batch_id"],"request_id":"undo-other"});
    assert_eq!(
        f.call("/api/v1/sessions/demo/undo", &b, Some(undo.clone()))
            .await
            .0,
        409
    );
    let (status, file) = f.call("/api/v1/sessions/demo/download", &b, None).await;
    assert_eq!(status, 200);
    let response = f
        .http
        .post(format!("{}/api/v1/sessions/import", f.url))
        .header("origin", &f.url)
        .header("x-sigpilot-remote", "1")
        .header("cookie", &b)
        .body(file)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let imported: Value = serde_json::from_slice(&response.bytes().await.unwrap()).unwrap();
    let (status, bytes) = f
        .call(
            &format!(
                "/api/v1/sessions/{}/snapshot",
                imported["session_id"].as_str().unwrap()
            ),
            &b,
            None,
        )
        .await;
    assert_eq!(status, 200);
    assert_eq!(
        serde_json::from_slice::<Value>(&bytes).unwrap()["annotations"][0]["sample"],
        "5"
    );
    let mut own_undo = undo;
    own_undo["request_id"] = json!("undo-own");
    assert_eq!(
        f.call("/api/v1/sessions/demo/undo", &a, Some(own_undo))
            .await
            .0,
        200
    );
    let (status,rows)=f.call("/api/v1/sessions/demo/decode",&b,Some(json!({"capture":capture(&shared),"settings":support::Demo::uart(),"query":"","start":0,"end":50}))).await;
    assert_eq!(status, 200, "{}", String::from_utf8_lossy(&rows));
    assert!(
        serde_json::from_slice::<Value>(&rows).unwrap()["row_count"]
            .as_u64()
            .unwrap()
            > 0
    );
    assert_eq!(
        f.call(
            "/api/v1/sessions/demo/measurement",
            &b,
            Some(json!({"capture":capture(&shared),"request":{"channel":0,"sample":"5"}}))
        )
        .await
        .0,
        200
    );
    let imported_id = imported["session_id"].as_str().unwrap();
    let imported_snapshot: Value = serde_json::from_slice(
        &f.call(
            &format!("/api/v1/sessions/{imported_id}/snapshot"),
            &b,
            None,
        )
        .await
        .1,
    )
    .unwrap();
    let close = json!({"capture":capture(&imported_snapshot)});
    assert_eq!(
        f.call(
            &format!("/api/v1/sessions/{imported_id}/release"),
            &a,
            Some(close.clone())
        )
        .await
        .0,
        403
    );
    assert_eq!(
        f.call(
            &format!("/api/v1/sessions/{imported_id}/release"),
            &b,
            Some(close)
        )
        .await
        .0,
        200
    );
    assert!(f.demo.workbench.existing_session(imported_id).is_err());
}

#[tokio::test]
async fn authorization_permissions_origin_and_resource_budgets() {
    let f = Fixture::new(false, false).await;
    assert_eq!(f.call("/api/v1/sessions", "", None).await.0, 401);
    let a = f.login("reader").await;
    let snapshot = f.snapshot(&a).await;
    assert_eq!(
        f.call(
            "/api/v1/sessions/demo/annotations",
            &a,
            Some(annotation(&snapshot, "read-only"))
        )
        .await
        .0,
        403
    );
    assert_eq!(
        f.call("/api/v1/sessions/import", &a, Some(json!({})))
            .await
            .0,
        403
    );
    assert_eq!(
        f.call(
            "/api/v1/captures",
            &a,
            Some(json!({"settings":support::Demo::settings()}))
        )
        .await
        .0,
        403
    );
    let response = f
        .http
        .post(format!("{}/api/v1/events", f.url))
        .header("cookie", &a)
        .body("{}")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 403);
    for (header, value) in [("origin", "http://evil.invalid"), ("host", "evil.invalid")] {
        let response = f
            .http
            .get(format!("{}/api/v1/sessions", f.url))
            .header("cookie", &a)
            .header(header, value)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 403);
    }
    for pixels in [0, 4097] {
        assert_eq!(f.call("/api/v1/sessions/demo/frame",&a,Some(json!({"capture":capture(&snapshot),"request":{"frame_id":1,"waveform":{"start_sample":0,"sample_count":1000,"pixels":pixels,"channels":[0]},"analyzers":[]}}))).await.0,400);
    }
    assert_eq!(f.call("/api/v1/sessions/demo/frame",&a,Some(json!({"capture":capture(&snapshot),"request":{"frame_id":1,"waveform":{"start_sample":0,"sample_count":1000,"pixels":100,"channels":[0]},"view":{"kind":"set","start_sample":400,"samples":100},"analyzers":[]}}))).await.0,400);
    assert_eq!(f.call("/api/v1/sessions/demo/decode",&a,Some(json!({"capture":capture(&snapshot),"settings":support::Demo::uart(),"query":"","start":0,"end":101}))).await.0,400);
    assert_eq!(
        f.http
            .post(format!("{}/api/v1/login", f.url))
            .header("origin", &f.url)
            .header("x-sigpilot-remote", "1")
            .body(vec![b'a'; 256 * 1024 + 1])
            .send()
            .await
            .unwrap()
            .status(),
        413
    );
    let (_, bytes) = f.call("/api/v1/connection", &a, None).await;
    let connection: Value = serde_json::from_slice(&bytes).unwrap();
    assert!(connection.get("access_code").is_none());
    f.server
        .revoke(connection["client"]["id"].as_str().unwrap());
    assert_eq!(f.call("/api/v1/sessions", &a, None).await.0, 401);
}

#[tokio::test]
async fn captures_outlive_requests_and_only_owner_can_cancel() {
    let f = Fixture::new(true, true).await;
    let a = f.login("operator").await;
    let b = f.login("observer").await;
    let oversized = sigpilot_core::CaptureSettings {
        sample_rate_hz: 500_000_000,
        duration_ms: 1000,
        ..support::Demo::settings()
    };
    assert_eq!(
        f.call("/api/v1/captures", &a, Some(json!({"settings":oversized})))
            .await
            .0,
        400
    );
    let response = f
        .http
        .post(format!("{}/api/v1/captures", f.url))
        .header("origin", &f.url)
        .header("x-sigpilot-remote", "1")
        .header("cookie", &a)
        .body(
            json!({"settings":support::Demo::settings(),"analyzers":[support::Demo::uart()]})
                .to_string(),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 202);
    let job: Value = serde_json::from_slice(&response.bytes().await.unwrap()).unwrap();
    assert_eq!(
        f.call(
            &format!("/api/v1/captures/{}/cancel", job["id"].as_str().unwrap()),
            &b,
            Some(json!({}))
        )
        .await
        .0,
        404
    );
    let connection: Value =
        serde_json::from_slice(&f.call("/api/v1/connection", &a, None).await.1).unwrap();
    f.server
        .revoke(connection["client"]["id"].as_str().unwrap());
    tokio::time::sleep(Duration::from_millis(300)).await;
    let listing: Value =
        serde_json::from_slice(&f.call("/api/v1/sessions", &b, None).await.1).unwrap();
    assert_eq!(listing["captures"][0]["state"], "completed");
    assert_eq!(listing["captures"][0]["owned"], false);
    assert!(
        f.demo
            .workbench
            .context(job["session_id"].as_str().unwrap())
            .unwrap()
            .finalized
    );
    let a = f.login("operator-again").await;
    let (status, bytes) = f
        .call(
            "/api/v1/captures",
            &a,
            Some(json!({"settings":support::Demo::settings()})),
        )
        .await;
    assert_eq!(status, 202);
    let job: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(
        f.call(
            &format!("/api/v1/captures/{}/cancel", job["id"].as_str().unwrap()),
            &a,
            Some(json!({}))
        )
        .await
        .0,
        200
    );
    tokio::time::sleep(Duration::from_millis(250)).await;
    let listing: Value =
        serde_json::from_slice(&f.call("/api/v1/sessions", &a, None).await.1).unwrap();
    assert_eq!(listing["captures"][1]["state"], "cancelled");
}

#[tokio::test]
async fn event_ring_recovers_from_a_slow_browser() {
    let events = sigpilot_remote::events::Events::default();
    for i in 0..80 {
        events.publish(json!({"i":i}));
    }
    let page = events.read(0).await;
    assert_eq!(page["resync"], true);
    assert_eq!(page["sequence"], "80");
    let page = events.read(79).await;
    assert_eq!(page["events"][0]["i"], 79);
}
