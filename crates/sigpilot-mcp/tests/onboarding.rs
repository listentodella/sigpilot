//! Stable discovery and the executable configuration users actually copy.
#![cfg(unix)]
use sigpilot_mcp::{
    desktop::{read_instance, DesktopMcpServer},
    onboarding::{self, Preferences},
};
use sigpilot_workbench::WorkbenchService;
use std::{path::Path, sync::Arc};

#[tokio::test(flavor = "current_thread")]
async fn stable_configuration_survives_restart_and_self_check_uses_delivered_bridge() {
    let root = std::env::temp_dir().join(format!("sigpilot-onboarding-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&root).unwrap();
    let directory = root.join("private");
    let workbench = Arc::new(WorkbenchService::default());
    assert!(!onboarding::read_preferences(&directory).unwrap().enabled);
    let first = DesktopMcpServer::start(workbench.clone(), &directory, true)
        .await
        .unwrap();
    let file = first.status().instance_file.unwrap();
    assert_eq!(file, directory.join("connection.json"));
    let old = read_instance(&file).unwrap();
    let conflict = DesktopMcpServer::start(workbench.clone(), &directory, true).await;
    assert_eq!(
        conflict.err().unwrap().kind(),
        std::io::ErrorKind::AddrInUse
    );
    assert_eq!(read_instance(&file).unwrap().instance_id, old.instance_id);
    let installed = onboarding::install_bridge(
        &directory,
        Path::new(env!("CARGO_BIN_EXE_sigpilot-mcp-bridge")),
    )
    .unwrap();
    let bridge = installed.as_path();
    assert_eq!(bridge, directory.join("bridge/sigpilot-mcp-bridge"));
    let config = onboarding::configurations(bridge, &file).unwrap();
    let writable_count = onboarding::check_bridge(bridge, &file).await.unwrap()["tool_count"]
        .as_u64()
        .unwrap();
    assert!(writable_count >= 25);
    onboarding::save_preferences(
        &directory,
        &Preferences {
            enabled: true,
            can_edit: true,
            ..Preferences::default()
        },
    )
    .unwrap();
    first.stop().await;
    let off = onboarding::setup_info(
        sigpilot_mcp::desktop::DesktopMcpStatus::disabled(),
        &directory,
        Some(installed.clone()),
    )
    .unwrap();
    assert!(!off.status.enabled);
    assert!(off.status.can_edit_annotations);
    assert!(!file.exists());
    assert!(onboarding::check_bridge(bridge, &file).await.is_err());
    let second = DesktopMcpServer::start(workbench.clone(), &directory, false)
        .await
        .unwrap();
    let new = read_instance(&file).unwrap();
    assert_ne!(new.instance_id, old.instance_id);
    assert_ne!(new.token, old.token);
    assert_eq!(
        config[0].content,
        onboarding::configurations(bridge, &file).unwrap()[0].content
    );
    let check = onboarding::check_bridge(bridge, &file).await.unwrap();
    assert!(check["tool_count"].as_u64().unwrap() < writable_count);
    assert!(onboarding::read_preferences(&directory).unwrap().enabled);
    second.stop().await;
    // Abrupt Drop must also release discovery and the lock without later cleanup races.
    drop(
        DesktopMcpServer::start(workbench.clone(), &directory, false)
            .await
            .unwrap(),
    );
    let final_server = DesktopMcpServer::start(workbench, &directory, true)
        .await
        .unwrap();
    tokio::task::yield_now().await;
    assert!(file.exists());
    final_server.stop().await;
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn preferences_reject_symlinks_public_files_and_oversize_data() {
    use std::os::unix::fs::{symlink, PermissionsExt};
    let root = std::env::temp_dir().join(format!("sigpilot-prefs-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&root).unwrap();
    let directory = root.join("private");
    onboarding::save_preferences(&directory, &Preferences::default()).unwrap();
    let file = directory.join("preferences.json");
    std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o644)).unwrap();
    assert!(onboarding::read_preferences(&directory).is_err());
    std::fs::remove_file(&file).unwrap();
    std::fs::write(root.join("public"), b"{}").unwrap();
    symlink(root.join("public"), &file).unwrap();
    assert!(onboarding::read_preferences(&directory).is_err());
    assert!(onboarding::save_preferences(&directory, &Preferences::default()).is_err());
    std::fs::remove_file(&file).unwrap();
    onboarding::save_preferences(&directory, &Preferences::default()).unwrap();
    std::fs::write(&file, vec![b' '; 1025]).unwrap();
    assert!(onboarding::read_preferences(&directory).is_err());
    std::fs::remove_dir_all(root).unwrap();
}
