//! Wire-level integration using the exact service embedded by Tauri.
use rmcp::{
    model::{CallToolRequestParams, CallToolResponse},
    transport::{
        streamable_http_client::StreamableHttpClientTransportConfig, StreamableHttpClientTransport,
        TokioChildProcess,
    },
    ServiceExt,
};
use serde_json::{json, Value};
use sigpilot_workbench::{WorkbenchEvent, WorkbenchService};
use std::{sync::Arc, time::Duration};

fn tool(name: &str, arguments: Value) -> CallToolRequestParams {
    serde_json::from_value(json!({"name":name,"arguments":arguments})).unwrap()
}

#[tokio::test(flavor = "current_thread")]
async fn bridge_changes_the_same_desktop_document_and_focuses_the_same_graph() {
    let workbench = Arc::new(WorkbenchService::default());
    // Use a tiny sparse capture with the normal importer; no device runtime.
    let directory =
        std::env::temp_dir().join(format!("sigpilot-desktop-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&directory).unwrap();
    let metadata = serde_json::from_value(json!({"version":1,"source_device":"fixture","sample_rate_hz":1000000,"channel_count":1,
        "enabled_channels":[0],"unitsize":1,"sample_count":20,"captured_at":"2026-11-12T00:00:00Z","labels":["D0"]})).unwrap();
    let capture = sigpilot_file::PxlogicProjectCapture::Sparse(sigpilot_core::SparseCaptureData {
        metadata,
        channels: vec![sigpilot_core::SparseDigitalChannel {
            channel: 0,
            initial_high: false,
            transitions: vec![2, 3, 5, 7, 10, 13],
        }],
    });
    workbench.import_capture("desktop", capture).unwrap();
    workbench.set_gui_attached("desktop", true).unwrap();
    let events = workbench.subscribe().unwrap();
    let server = sigpilot_mcp::desktop::DesktopMcpServer::start(
        workbench.clone(),
        &directory.join("instances"),
        true,
    )
    .await
    .unwrap();
    let status = server.status();
    let instance_file = status.instance_file.unwrap();
    let mut command = tokio::process::Command::new(env!("CARGO_BIN_EXE_sigpilot-mcp-bridge"));
    command.arg("--instance-file").arg(&instance_file);
    let client = ().serve(TokioChildProcess::new(command).unwrap()).await.unwrap();
    let catalog = client.peer().list_tools(None).await.unwrap();
    assert_eq!(
        client
            .peer()
            .list_prompts(None)
            .await
            .unwrap()
            .prompts
            .len(),
        3
    );
    let prompt=client.peer().get_prompt_once(serde_json::from_value(json!({"name":"sigpilot_scan_and_mark_pulses","arguments":{"session_id":"desktop","channel":"0","max_width_samples":"3"}})).unwrap()).await.unwrap();
    let rmcp::model::GetPromptResponse::Complete(prompt) = prompt else {
        panic!("unexpected prompt response")
    };
    assert!(serde_json::to_string(&prompt)
        .unwrap()
        .contains("sigpilot_get_context"));
    for name in [
        "sigpilot_query_frame_sequence",
        "sigpilot_query_transactions",
        "sigpilot_correlate_pulses",
        "sigpilot_compile_trigger",
        "sigpilot_get_reports",
        "sigpilot_apply_reports",
        "sigpilot_configure_analyzer",
        "sigpilot_get_analyzers",
        "sigpilot_export_report",
        "sigpilot_get_results",
        "sigpilot_apply_results",
    ] {
        assert!(catalog.tools.iter().any(|tool| tool.name == name));
    }
    assert!(catalog
        .tools
        .iter()
        .any(|tool| tool.name == "sigpilot_apply_annotations"));
    assert!(!catalog
        .tools
        .iter()
        .any(|tool| tool.name == "sigpilot_open_capture"));
    let context = workbench.context("desktop").unwrap();
    let response=client.peer().call_tool_once(tool("sigpilot_configure_analyzer",json!({"capture":context.capture,"expected_config_revision":"0","request_id":"shared-uart",
        "operation":{"op":"create","id":"shared-uart","name":"UART desktop","config":{"protocol":"UART","settings":{"channel":0,"baud_rate":"100000"}}}}))).await.unwrap();
    let CallToolResponse::Complete(response) = response else {
        panic!("unexpected response")
    };
    assert!(!response.is_error.unwrap_or(false));
    let shared = workbench.gui_snapshot("desktop").unwrap();
    assert_eq!(shared.context.config_revision.0, 1);
    assert_eq!(shared.analyzers[0].id, "shared-uart");
    assert!(matches!(
        events.try_recv().unwrap().as_ref(),
        WorkbenchEvent::AnalyzersChanged { .. }
    ));
    let mut metadata = shared.analyzers[0].metadata.clone();
    metadata.name = "GUI renamed".into();
    workbench
        .replace_analyzers(
            sigpilot_workbench::Caller {
                id: "desktop-user",
                source: sigpilot_workbench::AnnotationSource::User,
            },
            &sigpilot_workbench::analyzers::ReplaceAnalyzersRequest {
                capture: context.capture.clone(),
                expected_config_revision: 1.into(),
                request_id: "gui-rename".into(),
                analyzers: vec![metadata],
            },
        )
        .unwrap();
    assert!(matches!(
        events.try_recv().unwrap().as_ref(),
        WorkbenchEvent::AnalyzersChanged { .. }
    ));
    let response = client
        .peer()
        .call_tool_once(tool(
            "sigpilot_get_analyzers",
            json!({"capture":context.capture,"config_revision":"2"}),
        ))
        .await
        .unwrap();
    let CallToolResponse::Complete(response) = response else {
        panic!("unexpected response")
    };
    assert_eq!(
        response.structured_content.unwrap()["items"][0]["name"],
        "GUI renamed"
    );
    let response = client
        .peer()
        .call_tool_once(tool("sigpilot_list_capabilities", json!({})))
        .await
        .unwrap();
    let CallToolResponse::Complete(response) = response else {
        panic!("unexpected input request")
    };
    let capabilities = response.structured_content.unwrap();
    let profile = capabilities["hardware_triggers"]["profiles"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["driver_id"] == "pxlogic")
        .unwrap()["profile_id"]
        .clone();
    let response=client.peer().call_tool_once(tool("sigpilot_compile_trigger",json!({"target":{"profile_id":profile,"mode":"buffer","channel_count":8,"enabled_channels":[0],"sample_rate_hz":"1000000"},"rule":{"schema_version":"1","steps":[{"event":{"type":"level","channel":0,"high":true}}]}}))).await.unwrap();
    let CallToolResponse::Complete(response) = response else {
        panic!("unexpected input request")
    };
    assert!(!response.is_error.unwrap_or(false));
    let compiled = response.structured_content.unwrap();
    assert_eq!(compiled["compilation"]["status"], "supported");
    assert_eq!(compiled["compilation"]["applied"], false);
    assert_eq!(
        workbench.context("desktop").unwrap().capture,
        context.capture
    );
    assert_eq!(
        workbench.context("desktop").unwrap().annotation_revision,
        context.annotation_revision
    );
    assert!(matches!(
        events.try_recv(),
        Err(std::sync::mpsc::TryRecvError::Empty)
    ));
    let response = client
        .peer()
        .call_tool_once(tool(
            "sigpilot_measure",
            json!({"capture":context.capture,"channel":0,"mode":"point","sample":"5"}),
        ))
        .await
        .unwrap();
    let CallToolResponse::Complete(response) = response else {
        panic!("unexpected input request")
    };
    let evidence = response.structured_content.unwrap()["evidence_ref"].clone();
    let response=client.peer().call_tool_once(tool("sigpilot_apply_reports",json!({"capture":context.capture,"expected_report_revision":"0","request_id":"bridge-report","operation":{"op":"create","title":"Pulse measurement","evidence_refs":[evidence]}}))).await.unwrap();
    let CallToolResponse::Complete(response) = response else {
        panic!("unexpected input request")
    };
    assert!(!response.is_error.unwrap_or(false));
    let created = response.structured_content.unwrap();
    let report_id = created["upsert"]["report_id"].as_str().unwrap();
    assert_eq!(workbench.context("desktop").unwrap().report_count.0, 1);
    assert_eq!(
        workbench
            .read_report(&context.capture, report_id, 0, 1)
            .unwrap()["findings"][0]["observed"]["pulse_width_samples"],
        "2"
    );
    assert!(matches!(
        events.try_recv().unwrap().as_ref(),
        WorkbenchEvent::ReportsChanged { .. }
    ));
    let project_path = directory.join("saved-report.pxl");
    workbench
        .save_project("desktop", &project_path, Default::default())
        .unwrap();
    let project = sigpilot_file::open_pxl_bounded(&project_path, 1024 * 1024).unwrap();
    let reopened = WorkbenchService::default();
    let reopened_context = reopened.import_capture("saved", project.capture).unwrap();
    reopened
        .restore_annotations("saved", &project.session)
        .unwrap();
    assert_eq!(
        reopened
            .read_report(&reopened_context.capture, report_id, 0, 1)
            .unwrap()["report"]["verification"],
        "imported_saved_not_recomputed"
    );
    let response=client.peer().call_tool_once(tool("sigpilot_query_frame_sequence",json!({"result_set_id":"missing-result","query":{"schema_version":"1","steps":[{"query":{}}]}}))).await.unwrap();
    let CallToolResponse::Complete(response) = response else {
        panic!("unexpected input request")
    };
    assert!(response.is_error.unwrap_or(false));
    assert_eq!(
        response.structured_content.unwrap()["error"]["code"],
        "JOB_NOT_FOUND"
    );
    let response = client.peer().call_tool_once(tool("sigpilot_apply_annotations", json!({
        "capture":context.capture,"expected_annotation_revision":"0","request_id":"bridge-mark",
        "operations":[{"op":"create","annotation":{"kind":"channel_annotation","channel":0,"sample":"5","title":"pulse","color":"#ffc44d"}}]
    }))).await.unwrap();
    let CallToolResponse::Complete(response) = response else {
        panic!("unexpected input request");
    };
    assert!(!response.is_error.unwrap_or(false), "{:?}", response);
    let snapshot = workbench.gui_snapshot("desktop").unwrap();
    assert_eq!(snapshot.context.annotation_revision.0, 1);
    assert_eq!(snapshot.annotations[0].value.sample.0, 5);
    assert!(matches!(
        events.try_recv().unwrap().as_ref(),
        WorkbenchEvent::AnnotationsChanged { .. }
    ));
    assert_eq!(
        client
            .peer()
            .list_resources(None)
            .await
            .unwrap()
            .resources
            .len(),
        3
    );
    assert_eq!(
        client
            .peer()
            .list_resource_templates(None)
            .await
            .unwrap()
            .resource_templates
            .len(),
        6
    );
    let summary_uri = format!(
        "sigpilot://sessions/desktop/captures/{}/{}/summary",
        context.capture.capture_id, context.capture.data_revision.0
    );
    let resource = client
        .peer()
        .read_resource(serde_json::from_value(json!({"uri":summary_uri})).unwrap())
        .await
        .unwrap();
    assert_eq!(resource.contents.len(), 1);
    assert!(client
        .peer()
        .read_resource(serde_json::from_value(json!({"uri":"file:///etc/hosts"})).unwrap())
        .await
        .is_err());
    let response=client.peer().call_tool_once(tool("sigpilot_apply_annotations",json!({"capture":context.capture,"expected_annotation_revision":"1","request_id":"bridge-kinds","operations":[
        {"op":"create","id":"time","annotation":{"kind":"timing_point","sample":"2","title":"T0","color":"#123456"}},
        {"op":"create","id":"pair","annotation":{"kind":"timing_pair","sample":"3","end_sample":"3","title":"P0","color":"#123456"}},
        {"op":"create","id":"range","annotation":{"kind":"range_annotation","channel":0,"sample":"3","end_sample":"20","title":"window","color":"#123456"}}
    ]}))).await.unwrap();
    let CallToolResponse::Complete(response) = response else {
        panic!("unexpected input request")
    };
    assert!(!response.is_error.unwrap_or(false));
    assert_eq!(
        workbench.gui_snapshot("desktop").unwrap().annotations.len(),
        4
    );
    assert!(matches!(
        events.try_recv().unwrap().as_ref(),
        WorkbenchEvent::AnnotationsChanged { .. }
    ));
    let batch = response.structured_content.unwrap()["batch_id"].clone();
    let response=client.peer().call_tool_once(tool("sigpilot_undo_annotations",json!({"capture":context.capture,"expected_annotation_revision":"2","request_id":"undo-kinds","batch_id":batch}))).await.unwrap();
    let CallToolResponse::Complete(response) = response else {
        panic!("unexpected input request")
    };
    assert!(!response.is_error.unwrap_or(false));
    assert_eq!(
        workbench.gui_snapshot("desktop").unwrap().annotations.len(),
        1
    );
    assert!(matches!(
        events.try_recv().unwrap().as_ref(),
        WorkbenchEvent::AnnotationsChanged { .. }
    ));
    client.peer().call_tool_once(tool("sigpilot_focus_view", json!({"capture":context.capture,"range":{"start_sample":"2","end_sample":"8"},"channels":[0]}))).await.unwrap();
    assert!(matches!(
        events.try_recv().unwrap().as_ref(),
        WorkbenchEvent::FocusRequested { .. }
    ));
    client.cancel().await.unwrap();

    // Read-only authorization is reflected in discovery, including over HTTP.
    drop(server);
    assert!(!instance_file.exists());
    let readonly = sigpilot_mcp::desktop::DesktopMcpServer::start(
        workbench,
        &directory.join("instances"),
        false,
    )
    .await
    .unwrap();
    let credentials =
        sigpilot_mcp::desktop::read_instance(&readonly.status().instance_file.unwrap()).unwrap();
    let config = StreamableHttpClientTransportConfig::with_uri(credentials.endpoint)
        .auth_header(credentials.token);
    let client = ()
        .serve(StreamableHttpClientTransport::with_client(
            reqwest::Client::builder()
                .no_proxy()
                .timeout(Duration::from_secs(5))
                .build()
                .unwrap(),
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
        .any(|tool| tool.name == "sigpilot_apply_annotations"));
    assert!(!client
        .peer()
        .list_tools(None)
        .await
        .unwrap()
        .tools
        .iter()
        .any(|tool| tool.name == "sigpilot_undo_annotations"));
    assert!(!client
        .peer()
        .list_tools(None)
        .await
        .unwrap()
        .tools
        .iter()
        .any(|tool| tool.name == "sigpilot_apply_reports"));
    assert!(!client
        .peer()
        .list_tools(None)
        .await
        .unwrap()
        .tools
        .iter()
        .any(|tool| tool.name == "sigpilot_configure_analyzer"));
    assert!(client
        .peer()
        .list_tools(None)
        .await
        .unwrap()
        .tools
        .iter()
        .any(|tool| tool.name == "sigpilot_get_reports"));
    client.cancel().await.unwrap();
    drop(readonly);
    std::fs::remove_dir_all(directory).unwrap();
}
