//! Local connection configuration. No credentials are copied into agent config.
use crate::desktop::{
    private_directory, read_instance, write_private_atomic_with, DesktopMcpStatus,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    io,
    path::{Path, PathBuf},
};

pub const DEFAULT_HTTP_PORT: u16 = 10531;
fn default_port() -> u16 {
    DEFAULT_HTTP_PORT
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Preferences {
    pub enabled: bool,
    pub can_edit: bool,
    pub can_capture: bool,
    #[serde(default = "default_port")]
    pub port: u16,
}
impl Default for Preferences {
    fn default() -> Self {
        Self {
            enabled: false,
            can_edit: false,
            can_capture: false,
            port: DEFAULT_HTTP_PORT,
        }
    }
}
pub fn read_preferences(directory: &Path) -> io::Result<Preferences> {
    let preferences: Preferences =
        crate::storage::read(directory, "preferences.json", 1024)?.unwrap_or_default();
    validate_port(preferences.port)?;
    Ok(preferences)
}
pub fn save_preferences(directory: &Path, preferences: &Preferences) -> io::Result<()> {
    validate_port(preferences.port)?;
    crate::storage::write(directory, "preferences.json", preferences)
}
pub fn validate_port(port: u16) -> io::Result<()> {
    if port < 1024 {
        Err(io::Error::other("MCP port must be between 1024 and 65535"))
    } else {
        Ok(())
    }
}
/// Keep agent commands stable across AppImage remounts and application moves.
/// Copy only the bundled executable, retaining its embedded code signature.
pub fn install_bridge(directory: &Path, source: &Path) -> io::Result<PathBuf> {
    private_directory(directory)?;
    let destination_directory = directory.join("bridge");
    private_directory(&destination_directory)?;
    let source = std::fs::File::open(source)?;
    let metadata = source.metadata()?;
    const LIMIT: u64 = 512 * 1024 * 1024;
    if !metadata.is_file() || metadata.len() > LIMIT {
        return Err(io::ErrorKind::InvalidData.into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o111 == 0 {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
    }
    let destination = destination_directory.join(if cfg!(windows) {
        "sigpilot-mcp-bridge.exe"
    } else {
        "sigpilot-mcp-bridge"
    });
    use std::io::Read;
    write_private_atomic_with(&destination, true, |file| {
        if std::io::copy(&mut source.take(LIMIT + 1), file)? > LIMIT {
            return Err(io::ErrorKind::InvalidData.into());
        }
        Ok(())
    })?;
    Ok(destination)
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientConfiguration {
    pub id: String,
    pub format: String,
    pub content: String,
    pub location: String,
    pub docs_url: String,
    #[serde(default)]
    pub registration_command: Option<String>,
    #[serde(default)]
    pub install_uri: Option<String>,
}
#[derive(Clone, Serialize)]
pub struct SetupInfo {
    pub status: DesktopMcpStatus,
    pub bridge_path: Option<PathBuf>,
    pub bridge_available: bool,
    pub connection_file: PathBuf,
    pub supported: bool,
    pub auto_start_requested: bool,
    pub configurations: Vec<ClientConfiguration>,
    pub endpoint: String,
    pub port: u16,
}
pub fn setup_info(
    mut status: DesktopMcpStatus,
    directory: &Path,
    bridge: Option<PathBuf>,
) -> io::Result<SetupInfo> {
    let connection_file = directory.join("connection.json");
    let preferences = read_preferences(directory)?;
    // When off, display the saved permission choice for the next activation.
    // Actual access still requires status.enabled and a running server.
    if !status.enabled {
        status.can_edit_annotations = preferences.can_edit;
    }
    let endpoint = status
        .endpoint
        .clone()
        .unwrap_or_else(|| format!("http://127.0.0.1:{}/mcp", preferences.port));
    let configurations = http_configurations(&endpoint);
    Ok(SetupInfo {
        status,
        bridge_available: bridge.is_some(),
        bridge_path: bridge,
        connection_file,
        supported: cfg!(any(unix, windows)),
        auto_start_requested: preferences.enabled,
        configurations,
        endpoint,
        port: preferences.port,
    })
}

pub fn http_configurations(endpoint: &str) -> Vec<ClientConfiguration> {
    let server = json!({"url":endpoint});
    let content = serde_json::to_string_pretty(&json!({"mcpServers":{"sigpilot":server}})).unwrap();
    let cursor_uri = format!(
        "cursor://anysphere.cursor-deeplink/mcp/install?name=sigpilot&config={}",
        percent_encode(&BASE64.encode(serde_json::to_vec(&server).unwrap()))
    );
    vec![
        ClientConfiguration {
            id: "codex".into(),
            format: "toml".into(),
            content: format!(
                "[mcp_servers.sigpilot]\nurl = {}\n",
                serde_json::to_string(endpoint).unwrap()
            ),
            location: "~/.codex/config.toml".into(),
            docs_url: "https://developers.openai.com/codex/mcp".into(),
            registration_command: Some(format!("codex mcp add sigpilot --url {endpoint}")),
            install_uri: None,
        },
        ClientConfiguration {
            id: "claude_code".into(),
            format: "json".into(),
            content: serde_json::to_string_pretty(
                &json!({"mcpServers":{"sigpilot":{"type":"http","url":endpoint}}}),
            )
            .unwrap(),
            location: "".into(),
            docs_url: "https://code.claude.com/docs/en/mcp".into(),
            registration_command: Some(format!(
                "claude mcp add --transport http --scope user sigpilot {endpoint}"
            )),
            install_uri: None,
        },
        ClientConfiguration {
            id: "cursor".into(),
            format: "json".into(),
            content: content.clone(),
            location: "~/.cursor/mcp.json".into(),
            docs_url: "https://cursor.com/docs/context/mcp/install-links".into(),
            registration_command: None,
            install_uri: Some(cursor_uri),
        },
        ClientConfiguration {
            id: "generic".into(),
            format: "json".into(),
            content,
            location: "".into(),
            docs_url: "https://modelcontextprotocol.io/docs/develop/connect-remote-servers".into(),
            registration_command: None,
            install_uri: None,
        },
    ]
}
fn path_string(path: &Path) -> io::Result<&str> {
    path.to_str()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "connection path is not UTF-8"))
}
pub fn configurations(bridge: &Path, connection: &Path) -> io::Result<Vec<ClientConfiguration>> {
    let args = if default_connection_file(bridge).ok().as_deref() == Some(connection) {
        Vec::<String>::new()
    } else {
        vec!["--instance-file".into(), path_string(connection)?.into()]
    };
    let bridge = path_string(bridge)?;
    // JSON basic strings are valid TOML basic strings for filesystem paths.
    let bridge_literal = serde_json::to_string(bridge)?;
    let args_literal = serde_json::to_string(&args)?;
    let server = json!({"command":bridge,"args":args});
    let json = serde_json::to_string_pretty(&json!({"mcpServers":{"sigpilot":server}}))?;
    let invocation = std::iter::once(bridge)
        .chain(args.iter().map(String::as_str))
        .map(shell_quote)
        .collect::<Vec<_>>()
        .join(" ");
    let cursor_uri = format!(
        "cursor://anysphere.cursor-deeplink/mcp/install?name=sigpilot&config={}",
        percent_encode(&BASE64.encode(serde_json::to_vec(&server)?)),
    );
    Ok(vec![
        ClientConfiguration {
            id: "generic".into(),
            format: "json".into(),
            content: json.clone(),
            location: "".into(),
            docs_url: "https://modelcontextprotocol.io/docs/develop/connect-local-servers".into(),
            registration_command: None,
            install_uri: None,
        },
        ClientConfiguration {
            id: "codex".into(),
            format: "toml".into(),
            content: format!(
                "[mcp_servers.sigpilot]\ncommand = {bridge_literal}\nargs = {args_literal}\n"
            ),
            location: "~/.codex/config.toml".into(),
            docs_url: "https://developers.openai.com/codex/mcp".into(),
            registration_command: Some(format!("codex mcp add sigpilot -- {invocation}")),
            install_uri: None,
        },
        ClientConfiguration {
            id: "claude_code".into(),
            format: "json".into(),
            content: json.clone(),
            location: "".into(),
            docs_url: "https://code.claude.com/docs/en/mcp".into(),
            registration_command: Some(format!(
                "claude mcp add --transport stdio --scope user sigpilot -- {invocation}"
            )),
            install_uri: None,
        },
        ClientConfiguration {
            id: "cursor".into(),
            format: "json".into(),
            content: json.clone(),
            location: "~/.cursor/mcp.json".into(),
            docs_url: "https://cursor.com/docs/context/mcp/install-links".into(),
            registration_command: None,
            install_uri: Some(cursor_uri),
        },
        ClientConfiguration {
            id: "claude_desktop".into(),
            format: "json".into(),
            content: json,
            location: if cfg!(target_os = "macos") {
                "~/Library/Application Support/Claude/claude_desktop_config.json"
            } else if cfg!(target_os = "windows") {
                "%APPDATA%\\Claude\\claude_desktop_config.json"
            } else {
                ""
            }
            .into(),
            docs_url: "https://modelcontextprotocol.io/docs/develop/connect-local-servers".into(),
            registration_command: None,
            install_uri: None,
        },
    ])
}

/// The installed bridge discovers only its own adjacent connection descriptor.
/// Standalone/development binaries must explicitly select an instance.
pub fn default_connection_file(executable: &Path) -> io::Result<PathBuf> {
    let parent = executable
        .parent()
        .filter(|p| p.file_name() == Some(std::ffi::OsStr::new("bridge")))
        .ok_or_else(|| {
            io::Error::other(
                "This bridge is not installed by SigPilot; supply --instance-file PATH",
            )
        })?;
    Ok(parent
        .parent()
        .ok_or(io::ErrorKind::InvalidInput)?
        .join("connection.json"))
}

pub fn bridge_arguments(
    args: impl IntoIterator<Item = std::ffi::OsString>,
    executable: &Path,
) -> io::Result<(PathBuf, bool)> {
    let mut args = args.into_iter();
    let mut connection = None;
    let mut check = false;
    while let Some(arg) = args.next() {
        if arg == "--instance-file" && connection.is_none() {
            connection = Some(PathBuf::from(
                args.next()
                    .filter(|a| !a.is_empty())
                    .ok_or(io::ErrorKind::InvalidInput)?,
            ));
        } else if arg == "--check" && !check {
            check = true;
        } else {
            return Err(io::Error::other(
                "usage: sigpilot-mcp-bridge [--instance-file PATH] [--check]",
            ));
        }
    }
    Ok((
        match connection {
            Some(path) => path,
            None => default_connection_file(executable)?,
        },
        check,
    ))
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}
fn percent_encode(value: &str) -> String {
    use std::fmt::Write;
    let mut encoded = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.~".contains(&byte) {
            encoded.push(byte as char);
        } else {
            let _ = write!(encoded, "%{byte:02X}");
        }
    }
    encoded
}

pub async fn check_bridge(bridge: &Path, connection: &Path) -> io::Result<serde_json::Value> {
    let instance = read_instance(connection)?;
    let child = tokio::process::Command::new(bridge)
        .args([
            std::ffi::OsStr::new("--instance-file"),
            connection.as_os_str(),
            std::ffi::OsStr::new("--check"),
        ])
        .kill_on_drop(true)
        .output();
    let output = tokio::time::timeout(std::time::Duration::from_secs(20), child)
        .await
        .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "MCP connection check timed out"))??;
    if !output.status.success() {
        return Err(io::Error::other(
            String::from_utf8_lossy(&output.stderr)
                .chars()
                .take(2048)
                .collect::<String>(),
        ));
    }
    if output.stdout.len() > 4096 {
        return Err(io::ErrorKind::InvalidData.into());
    }
    let result: serde_json::Value = serde_json::from_slice(&output.stdout)?;
    if result["ok"] != true
        || result["instance_id"] != instance.instance_id
        || result["tool_count"]
            .as_u64()
            .is_none_or(|n| n == 0 || n > 64)
    {
        return Err(io::Error::other(
            "bridge connected to an unexpected SigPilot instance",
        ));
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn generated_configs_keep_real_paths_and_do_not_embed_credentials() {
        let paths = configurations(
            Path::new("/Apps/SigPilot \"test\"/sigpilot-mcp-bridge"),
            Path::new("/Users/test/连接/connection.json"),
        )
        .unwrap();
        assert_eq!(paths.len(), 5);
        for config in paths.iter().filter(|c| c.format == "json") {
            let v: serde_json::Value = serde_json::from_str(&config.content).unwrap();
            assert_eq!(
                v["mcpServers"]["sigpilot"]["args"][1],
                "/Users/test/连接/connection.json"
            );
            assert!(v["mcpServers"]["sigpilot"]["env"].is_null());
            assert!(v["mcpServers"]["sigpilot"]["headers"].is_null());
        }
        assert!(paths[1].content.starts_with("[mcp_servers.sigpilot]"));
        assert!(paths[1].content.contains("\\\"test\\\""));
    }

    #[test]
    fn installed_bridge_commands_are_quoted_and_discover_only_the_adjacent_instance() {
        let bridge = Path::new("/Users/test/应用 '$HOME'/mcp-instances/bridge/sigpilot-mcp-bridge");
        let connection = bridge
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .join("connection.json");
        let configs = configurations(bridge, &connection).unwrap();
        let codex = configs.iter().find(|c| c.id == "codex").unwrap();
        assert_eq!(codex.registration_command.as_deref(), Some("codex mcp add sigpilot -- '/Users/test/应用 '\"'\"'$HOME'\"'\"'/mcp-instances/bridge/sigpilot-mcp-bridge'"));
        let json: serde_json::Value = serde_json::from_str(&configs[0].content).unwrap();
        assert_eq!(json["mcpServers"]["sigpilot"]["args"], json!([]));
        assert_eq!(
            bridge_arguments(Vec::new(), bridge).unwrap(),
            (connection.clone(), false)
        );
        assert_eq!(
            bridge_arguments(["--check".into()], bridge).unwrap(),
            (connection.clone(), true)
        );
        assert_eq!(
            bridge_arguments(
                ["--instance-file".into(), "/chosen/connection.json".into()],
                Path::new("/standalone/bridge-tool")
            )
            .unwrap()
            .0,
            Path::new("/chosen/connection.json")
        );
        assert!(bridge_arguments(Vec::new(), Path::new("/standalone/bridge-tool")).is_err());
        assert!(bridge_arguments(["--unknown".into()], bridge).is_err());
        let cursor = configs.iter().find(|c| c.id == "cursor").unwrap();
        let url = reqwest::Url::parse(cursor.install_uri.as_deref().unwrap()).unwrap();
        let values = url
            .query_pairs()
            .collect::<std::collections::HashMap<_, _>>();
        assert_eq!(values.get("name").unwrap(), "sigpilot");
        let payload: serde_json::Value = serde_json::from_slice(
            &BASE64
                .decode(values.get("config").unwrap().as_bytes())
                .unwrap(),
        )
        .unwrap();
        assert_eq!(payload, json["mcpServers"]["sigpilot"]);
        assert!(payload["env"].is_null() && payload["headers"].is_null());
    }
}
