use std::{path::PathBuf, sync::Arc};

use rmcp::{transport::stdio, ServiceExt};
use sigpilot_mcp::McpAdapter;
use sigpilot_workbench::WorkbenchService;

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut roots = Vec::new();
    let mut allow_edits = false;
    let mut port = None;
    let mut args = std::env::args().skip(1);
    while let Some(argument) = args.next() {
        match argument.as_str() {
            "--root" => roots.push(
                PathBuf::from(args.next().ok_or("--root requires a directory")?).canonicalize()?,
            ),
            "--allow-annotations" => allow_edits = true,
            "--http-port" => {
                port = Some(
                    args.next()
                        .ok_or("--http-port requires a port")?
                        .parse::<u16>()?,
                )
            }
            "--help" => {
                eprintln!("sigpilot-mcp [--root DIR] [--allow-annotations] [--http-port PORT]\nDefaults to stdio. HTTP requires SIGPILOT_MCP_TOKEN. This process owns independent offline sessions. Use sigpilot-mcp-bridge --instance-file PATH to access an enabled desktop instance.");
                return Ok(());
            }
            _ => return Err(format!("unknown argument: {argument}").into()),
        }
    }
    let adapter = McpAdapter::new(
        Arc::new(WorkbenchService::default()),
        roots,
        allow_edits,
        "local-mcp-client".into(),
    );
    if let Some(port) = port {
        let token =
            std::env::var("SIGPILOT_MCP_TOKEN").map_err(|_| "HTTP requires SIGPILOT_MCP_TOKEN")?;
        sigpilot_mcp::server::serve_http(adapter, port, token, async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    } else {
        adapter.serve(stdio()).await?.waiting().await?;
    }
    Ok(())
}
