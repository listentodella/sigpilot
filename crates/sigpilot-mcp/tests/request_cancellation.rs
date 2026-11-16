//! Actual MCP notifications must reach synchronous host code and release its
//! permit. Fixtures wait with a deadline; they never consume an unbounded CPU.
use rmcp::{
    model::{CallToolRequestParams, CallToolResponse},
    transport::TokioChildProcess,
    ServiceExt,
};
use serde_json::{json, Value};
use sigpilot_analysis::{
    hardware_trigger::{HardwareTriggerCompiler, HardwareTriggerTarget, TriggerCompilation},
    providers::{
        AnalysisProvider, ProviderContext, ProviderDescriptor, ProviderPage, RangeMeasureProvider,
    },
    trigger::TriggerRule,
    AnalysisError,
};
use sigpilot_workbench::WorkbenchService;
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

#[derive(Default)]
struct Probe {
    entered: AtomicBool,
    stopped: AtomicBool,
}
impl Probe {
    fn wait(&self, cancel: &AtomicBool) -> sigpilot_analysis::Result<()> {
        self.stopped.store(false, Ordering::Release);
        self.entered.store(true, Ordering::Release);
        let deadline = Instant::now() + Duration::from_secs(3);
        while !cancel.load(Ordering::Acquire) {
            if Instant::now() > deadline {
                return Err(AnalysisError::InvalidInput(
                    "cancellation never reached worker".into(),
                ));
            }
            std::thread::sleep(Duration::from_millis(2));
        }
        self.stopped.store(true, Ordering::Release);
        Err(AnalysisError::Cancelled)
    }
    async fn entered(&self) {
        tokio::time::timeout(Duration::from_secs(2), async {
            while !self.entered.load(Ordering::Acquire) {
                tokio::time::sleep(Duration::from_millis(2)).await;
            }
        })
        .await
        .expect("fixture never entered worker");
    }
    async fn stopped(&self) {
        tokio::time::timeout(Duration::from_secs(1), async {
            while !self.stopped.load(Ordering::Acquire) {
                tokio::time::sleep(Duration::from_millis(2)).await;
            }
        })
        .await
        .expect("cancel did not stop synchronous execution");
    }
}
struct WaitingProvider(Arc<Probe>);
impl AnalysisProvider for WaitingProvider {
    fn descriptor(&self) -> ProviderDescriptor {
        let mut descriptor = RangeMeasureProvider.descriptor();
        descriptor.provider_id = "fixture.waiting".into();
        descriptor
    }
    fn validate_parameters(&self, parameters: &Value) -> sigpilot_analysis::Result<()> {
        RangeMeasureProvider.validate_parameters(parameters)
    }
    fn run(
        &self,
        context: ProviderContext<'_>,
        _: Value,
    ) -> sigpilot_analysis::Result<ProviderPage> {
        self.0.wait(context.cancelled)?;
        unreachable!()
    }
}
struct WaitingCompiler(Arc<Probe>);
impl HardwareTriggerCompiler for WaitingCompiler {
    fn descriptor(&self) -> Value {
        json!({"profile_id":"fixture.waiting","version":"1","driver_id":"fixture"})
    }
    fn compile(
        &self,
        _: &HardwareTriggerTarget,
        _: &TriggerRule,
        cancel: &AtomicBool,
    ) -> sigpilot_analysis::Result<TriggerCompilation> {
        self.0.wait(cancel)?;
        unreachable!()
    }
}
fn fixture() -> (Arc<WorkbenchService>, Arc<Probe>, Arc<Probe>, Value) {
    let workbench = Arc::new(WorkbenchService::default());
    let metadata = serde_json::from_value(json!({"version":1,"source_device":"fixture","sample_rate_hz":1000000,"channel_count":1,
        "enabled_channels":[0],"unitsize":1,"sample_count":20,"captured_at":"2026-11-13T00:00:00Z","labels":["D0"]})).unwrap();
    let context = workbench
        .import_capture(
            "cancel",
            sigpilot_file::PxlogicProjectCapture::Sparse(sigpilot_core::SparseCaptureData {
                metadata,
                channels: vec![sigpilot_core::SparseDigitalChannel {
                    channel: 0,
                    initial_high: false,
                    transitions: vec![2, 3, 5, 7],
                }],
            }),
        )
        .unwrap();
    let provider = Arc::new(Probe::default());
    let compiler = Arc::new(Probe::default());
    workbench
        .register_analysis_provider(Arc::new(WaitingProvider(provider.clone())))
        .unwrap();
    workbench
        .register_hardware_trigger_compiler(Arc::new(WaitingCompiler(compiler.clone())))
        .unwrap();
    (workbench, provider, compiler, json!(context.capture))
}
fn analyze(capture: &Value, provider: &str) -> Value {
    json!({"capture":capture,"provider_id":provider,"channel":0,"original_range":{"start_sample":"0","end_sample":"20"},"start_sample":"0","parameters":{}})
}
fn compile() -> Value {
    json!({"target":{"profile_id":"fixture.waiting","mode":"buffer","channel_count":1,"enabled_channels":[0],"sample_rate_hz":"1000000"},
        "rule":{"schema_version":"1","steps":[{"event":{"type":"level","channel":0,"high":true}}]}})
}

struct Wire {
    io: BufReader<tokio::net::TcpStream>,
    metadata: Value,
}
impl Wire {
    async fn send(&mut self, method: &str, id: Option<u64>, mut params: Value) {
        if !self.metadata.is_null() {
            params["_meta"] = self.metadata.clone();
        }
        let mut message = json!({"jsonrpc":"2.0","method":method,"params":params});
        if let Some(id) = id {
            message["id"] = json!(id);
        }
        self.io
            .get_mut()
            .write_all(format!("{message}\n").as_bytes())
            .await
            .unwrap();
    }
    async fn response(&mut self, id: u64) -> Value {
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let mut line = String::new();
                assert!(self.io.read_line(&mut line).await.unwrap() > 0);
                let value: Value = serde_json::from_str(&line).unwrap();
                if value["id"] == id {
                    return value;
                }
            }
        })
        .await
        .expect("wire response missing")
    }
    async fn call(&mut self, id: u64, name: &str, arguments: Value) -> Value {
        self.send(
            "tools/call",
            Some(id),
            json!({"name":name,"arguments":arguments}),
        )
        .await;
        self.response(id).await
    }
}

#[tokio::test(flavor = "current_thread")]
async fn both_protocol_generations_cancel_running_reads_and_keep_submitted_jobs() {
    for version in ["2025-11-25", "2026-07-28"] {
        let (workbench, provider, compiler, capture) = fixture();
        let adapter =
            sigpilot_mcp::McpAdapter::new(workbench.clone(), vec![], false, "owner".into());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            adapter
                .serve(listener.accept().await.unwrap().0)
                .await
                .unwrap()
                .waiting()
                .await
                .unwrap();
        });
        let mut wire = Wire {
            io: BufReader::new(tokio::net::TcpStream::connect(address).await.unwrap()),
            metadata: Value::Null,
        };
        if version == "2025-11-25" {
            wire.send("initialize", Some(1), json!({"protocolVersion":version,"capabilities":{},"clientInfo":{"name":"cancel-test","version":"1"}})).await;
            assert!(wire.response(1).await.get("error").is_none());
            wire.send("notifications/initialized", None, json!({}))
                .await;
        } else {
            wire.metadata = json!({"io.modelcontextprotocol/protocolVersion":version,"io.modelcontextprotocol/clientInfo":{"name":"cancel-test","version":"1"},"io.modelcontextprotocol/clientCapabilities":{}});
            wire.send("server/discover", Some(1), json!({})).await;
            assert!(wire.response(1).await.get("error").is_none());
        }
        let job = workbench
            .jobs
            .submit(
                "owner",
                serde_json::from_value(capture.clone()).unwrap(),
                "fixture",
                "independent",
                "{}".into(),
                Box::new(|_| {
                    std::thread::sleep(Duration::from_millis(80));
                    Ok(sigpilot_workbench::jobs::JobOutput::Analysis(
                        json!({"complete":true}),
                    ))
                }),
            )
            .unwrap();
        for (id, name, arguments, probe) in [
            (
                2,
                "sigpilot_run_analysis",
                analyze(&capture, "fixture.waiting"),
                provider,
            ),
            (6, "sigpilot_compile_trigger", compile(), compiler),
        ] {
            wire.send(
                "tools/call",
                Some(id),
                json!({"name":name,"arguments":arguments}),
            )
            .await;
            probe.entered().await;
            let busy = wire
                .call(
                    id + 1,
                    "sigpilot_get_context",
                    json!({"session_id":"cancel"}),
                )
                .await;
            assert_eq!(busy["result"]["structuredContent"]["error"]["code"], "BUSY");
            // Wrong ID must not cancel the active request.
            wire.send(
                "notifications/cancelled",
                None,
                json!({"requestId":999,"reason":"unrelated"}),
            )
            .await;
            let busy = wire
                .call(
                    id + 2,
                    "sigpilot_get_context",
                    json!({"session_id":"cancel"}),
                )
                .await;
            assert_eq!(busy["result"]["structuredContent"]["error"]["code"], "BUSY");
            wire.send(
                "notifications/cancelled",
                None,
                json!({"requestId":id,"reason":"fixture complete"}),
            )
            .await;
            probe.stopped().await;
            // The SDK suppresses the cancelled request's response. A following
            // request proves the service and its shared worker permit recovered.
            let healthy = tokio::time::timeout(Duration::from_secs(1), async {
                loop {
                    let response = wire
                        .call(
                            id + 3,
                            "sigpilot_run_analysis",
                            analyze(&capture, "sigpilot.range_measure"),
                        )
                        .await;
                    if response["result"]["structuredContent"]["error"]["code"] != "BUSY" {
                        break response;
                    }
                    tokio::time::sleep(Duration::from_millis(2)).await;
                }
            })
            .await
            .unwrap();
            assert_eq!(
                healthy["result"]["structuredContent"]["page"]["high_samples"],
                "3"
            );
        }
        tokio::time::timeout(Duration::from_secs(1), async {
            while workbench.jobs.get("owner", &job.job_id).unwrap().state
                != sigpilot_workbench::jobs::JobState::Completed
            {
                tokio::time::sleep(Duration::from_millis(2)).await;
            }
        })
        .await
        .expect("independent domain job failed to complete");
        assert!(
            !workbench
                .jobs
                .get("owner", &job.job_id)
                .unwrap()
                .cancel_requested
        );
        assert_eq!(workbench.context("cancel").unwrap().annotation_count.0, 0);
        drop(wire);
        tokio::time::timeout(Duration::from_secs(2), server)
            .await
            .unwrap()
            .unwrap();
    }
}

#[tokio::test(flavor = "current_thread")]
async fn real_stdio_bridge_propagates_cancel_to_the_desktop_provider() {
    let (workbench, provider, _, capture) = fixture();
    let directory = std::env::temp_dir().join(format!("sigpilot-cancel-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&directory).unwrap();
    let server = sigpilot_mcp::desktop::DesktopMcpServer::start(
        workbench,
        &directory.join("instances"),
        false,
    )
    .await
    .unwrap();
    let mut command = tokio::process::Command::new(env!("CARGO_BIN_EXE_sigpilot-mcp-bridge"));
    command
        .arg("--instance-file")
        .arg(server.status().instance_file.unwrap());
    let client = ().serve(TokioChildProcess::new(command).unwrap()).await.unwrap();
    let peer = client.peer().clone();
    let request: CallToolRequestParams = serde_json::from_value(
        json!({"name":"sigpilot_run_analysis","arguments":analyze(&capture,"fixture.waiting")}),
    )
    .unwrap();
    let pending = tokio::spawn(async move { peer.call_tool_once(request).await });
    provider.entered().await;
    pending.abort();
    assert!(pending.await.unwrap_err().is_cancelled());
    provider.stopped().await;
    // Wait for HTTP/stdio response teardown too, with bounded retries.
    tokio::time::timeout(Duration::from_secs(2),async {
        loop {
            let request=serde_json::from_value(json!({"name":"sigpilot_run_analysis","arguments":analyze(&capture,"sigpilot.range_measure")})).unwrap();
            if let Ok(CallToolResponse::Complete(response))=client.peer().call_tool_once(request).await {
                if !response.is_error.unwrap_or(false) {
                    assert_eq!(response.structured_content.unwrap()["page"]["high_samples"],"3");
                    break;
                }
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }).await.expect("bridge remained busy after cancellation");
    client.cancel().await.unwrap();
    drop(server);
    std::fs::remove_dir_all(directory).unwrap();
}
