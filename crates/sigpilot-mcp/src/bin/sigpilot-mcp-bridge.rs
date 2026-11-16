use rmcp::{
    transport::{
        stdio, streamable_http_client::StreamableHttpClientTransportConfig,
        StreamableHttpClientTransport,
    },
    ServiceExt,
};
use sigpilot_mcp::{bridge::DesktopBridge, desktop::read_instance, onboarding::bridge_arguments};
use std::{sync::Arc, time::Duration};

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let (path, check) = bridge_arguments(std::env::args_os().skip(1), &std::env::current_exe()?)?;
    let instance = read_instance(&path).map_err(|e| {
        format!("Cannot connect to SigPilot. Enable MCP in SigPilot and retry: {e}")
    })?;
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(15))
        .build()?;
    let mut config = StreamableHttpClientTransportConfig::with_uri(instance.endpoint.clone())
        .auth_header(instance.token)
        .max_concurrent_requests(1);
    config.allow_stateless = true;
    config.reinit_on_expired_session = false;
    config.channel_buffer_capacity = 4;
    config.max_sse_event_size = 256 * 1024;
    let upstream = tokio::time::timeout(
        Duration::from_secs(15),
        ().serve(StreamableHttpClientTransport::with_client(client, config)),
    )
    .await??;
    let tools = tokio::time::timeout(Duration::from_secs(15), upstream.peer().list_tools(None))
        .await??
        .tools;
    if check {
        let result = serde_json::json!({"ok":true,"instance_id":instance.instance_id,"tool_count":tools.len(),"transport":"stdio"});
        upstream.cancel().await?;
        println!("{result}");
        return Ok(());
    }
    let bridge = DesktopBridge {
        upstream: upstream.peer().clone(),
        tools: Arc::new(tools),
        budget: Arc::new(tokio::sync::Semaphore::new(1)),
    };
    let service = bridge.serve(stdio()).await?;
    service.waiting().await?;
    upstream.cancel().await?;
    Ok(())
}
