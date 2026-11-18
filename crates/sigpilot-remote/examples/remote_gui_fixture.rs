//! Instabox verification fixture. No production debug endpoint or stored secrets.
#[path = "../tests/support/mod.rs"]
mod support;
use sigpilot_remote::{RemoteServer, Settings};
use std::{path::PathBuf, sync::atomic::AtomicBool};
#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    if !std::env::consts::OS.eq("linux") {
        return Err("Use Instabox".into());
    }
    let mut args = std::env::args().skip(1);
    let port = args.next().ok_or("port")?.parse::<u16>()?;
    let directory = PathBuf::from(args.next().ok_or("private directory")?);
    let address: std::net::Ipv4Addr = args.next().unwrap_or_else(|| "127.0.0.1".into()).parse()?;
    if !address.is_loopback() && !address.is_private() {
        return Err("Use a private IPv4 address for the LAN fixture".into());
    }
    let demo = support::Demo::new();
    let settings = support::Demo::settings();
    demo.record(
        "demo",
        &settings,
        &[support::Demo::uart()],
        &AtomicBool::new(false),
    )?;
    demo.workbench.set_gui_attached("demo", true)?;
    demo.workbench
        .session("demo")?
        .graph
        .set_session_view(500.0, 1000.0);
    let server = RemoteServer::start(
        demo.workbench.clone(),
        demo.clone(),
        demo.events.clone(),
        Settings {
            port,
            public_url: format!("http://{address}:{port}"),
            listen_on_lan: !address.is_loopback(),
            can_edit: true,
            can_capture: true,
            ..Default::default()
        },
        directory.clone(),
        support::assets(PathBuf::from("dist")),
    )
    .await?;
    // The runner reads this private file; the browser API never exposes the code.
    std::fs::create_dir_all(&directory)?;
    std::fs::write(
        directory.join("setup.json"),
        serde_json::to_vec(&server.status())?,
    )?;
    loop {
        if directory.join("revoke-all").exists() {
            for client in server.status().clients {
                server.revoke(&client.id);
            }
            std::fs::remove_file(directory.join("revoke-all"))?;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
}
