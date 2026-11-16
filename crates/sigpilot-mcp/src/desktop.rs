//! Explicit desktop instance discovery. Credentials never leave a private file.
use crate::McpAdapter;
use serde::{Deserialize, Serialize};
use sigpilot_workbench::WorkbenchService;
use std::{
    io,
    path::{Path, PathBuf},
    sync::Arc,
};
use tokio::sync::oneshot;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InstanceCredentials {
    pub schema_version: String,
    pub instance_id: String,
    pub endpoint: String,
    pub token: String,
    pub pid: u32,
}

#[derive(Clone, Serialize)]
pub struct DesktopMcpStatus {
    pub enabled: bool,
    pub can_edit_annotations: bool,
    pub instance_id: Option<String>,
    pub endpoint: Option<String>,
    pub instance_file: Option<PathBuf>,
}

impl DesktopMcpStatus {
    pub fn disabled() -> Self {
        Self {
            enabled: false,
            can_edit_annotations: false,
            instance_id: None,
            endpoint: None,
            instance_file: None,
        }
    }
}

pub struct DesktopMcpServer {
    status: DesktopMcpStatus,
    shutdown: Option<oneshot::Sender<()>>,
    task: tokio::task::JoinHandle<()>,
    _connection_lock: std::fs::File,
    authorization: Option<crate::oauth::Authorization>,
    internal_token: String,
}

impl DesktopMcpServer {
    pub async fn start(
        workbench: Arc<WorkbenchService>,
        directory: &Path,
        can_edit: bool,
    ) -> io::Result<Self> {
        Self::start_on_port(workbench, directory, can_edit, 0).await
    }

    /// Fixed-port HTTP is the desktop default. Port zero is only used by isolated fixtures.
    pub async fn start_on_port(
        workbench: Arc<WorkbenchService>,
        directory: &Path,
        can_edit: bool,
        port: u16,
    ) -> io::Result<Self> {
        crate::storage::directory(directory)?;
        let connection_lock = crate::storage::lock(directory)?;
        let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).await.map_err(|error| {
            if error.kind()==io::ErrorKind::AddrInUse {io::Error::new(io::ErrorKind::AddrInUse,format!("MCP port {port} is already in use. Disable MCP in the other SigPilot window, or choose another port."))} else {error}
        })?;
        let instance_id = uuid::Uuid::new_v4().to_string();
        let endpoint = format!("http://127.0.0.1:{}/mcp", listener.local_addr()?.port());
        let credentials = InstanceCredentials {
            schema_version: "1".into(),
            instance_id: instance_id.clone(),
            endpoint: endpoint.clone(),
            token: format!(
                "{}{}",
                uuid::Uuid::new_v4().simple(),
                uuid::Uuid::new_v4().simple()
            ),
            pid: std::process::id(),
        };
        let file = directory.join("connection.json");
        let adapter = McpAdapter::new(
            workbench,
            vec![],
            can_edit,
            format!("desktop-mcp-{instance_id}"),
        );
        let authorization = if port == 0 {
            None
        } else {
            Some(crate::oauth::Authorization::open(
                directory.to_path_buf(),
                endpoint.trim_end_matches("/mcp").to_string(),
            )?)
        };
        let router = match &authorization {
            Some(auth) => crate::oauth::router(adapter, auth.clone(), credentials.token.clone()),
            None => crate::server::http_router(adapter, credentials.token.clone())?,
        };
        // The compatibility stdio bridge uses Unix private files. HTTP has no such dependency.
        #[cfg(unix)]
        write_private_atomic(&file, &serde_json::to_vec(&credentials)?)?;
        let (tx, rx) = oneshot::channel();
        let status = DesktopMcpStatus {
            enabled: true,
            can_edit_annotations: can_edit,
            instance_id: Some(instance_id),
            endpoint: Some(endpoint),
            instance_file: if cfg!(unix) { Some(file.clone()) } else { None },
        };
        let internal_token = credentials.token;
        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, router)
                .with_graceful_shutdown(async {
                    let _ = rx.await;
                })
                .await;
        });
        Ok(Self {
            status,
            shutdown: Some(tx),
            task,
            _connection_lock: connection_lock,
            authorization,
            internal_token,
        })
    }

    pub fn status(&self) -> DesktopMcpStatus {
        if self.task.is_finished() {
            DesktopMcpStatus::disabled()
        } else {
            self.status.clone()
        }
    }
    pub fn authorization(&self) -> Option<&crate::oauth::Authorization> {
        self.authorization.as_ref()
    }

    pub async fn check_http(&self) -> io::Result<serde_json::Value> {
        check_http(
            self.status
                .endpoint
                .as_deref()
                .ok_or(io::ErrorKind::NotFound)?,
            &self.internal_token,
            self.status.instance_id.as_deref().unwrap_or(""),
        )
        .await
    }

    /// Wait until the old discovery cleanup has finished before releasing the
    /// stable connection lock; a replacement server cannot lose its descriptor.
    pub async fn stop(mut self) {
        self.shutdown.take();
        self.task.abort();
        let _ = (&mut self.task).await;
    }
}

pub async fn check_http(
    endpoint: &str,
    token: &str,
    instance_id: &str,
) -> io::Result<serde_json::Value> {
    use rmcp::{
        transport::{
            streamable_http_client::StreamableHttpClientTransportConfig,
            StreamableHttpClientTransport,
        },
        ServiceExt,
    };
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(io::Error::other)?;
    let mut config = StreamableHttpClientTransportConfig::with_uri(endpoint.to_owned())
        .auth_header(token.to_owned());
    config.allow_stateless = true;
    let service = tokio::time::timeout(
        std::time::Duration::from_secs(15),
        ().serve(StreamableHttpClientTransport::with_client(client, config)),
    )
    .await
    .map_err(io::Error::other)?
    .map_err(io::Error::other)?;
    let result = service
        .peer()
        .list_tools(None)
        .await
        .map_err(io::Error::other);
    service.cancel().await.map_err(io::Error::other)?;
    let count = result?.tools.len();
    Ok(
        serde_json::json!({"ok":true,"instance_id":instance_id,"tool_count":count,"transport":"http"}),
    )
}

impl Drop for DesktopMcpServer {
    fn drop(&mut self) {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
        // Cleanup is synchronous while the connection lock is still held. The
        // server task never removes this path after a replacement has started.
        if let Some(file) = &self.status.instance_file {
            let _ = std::fs::remove_file(file);
        }
        self.task.abort();
    }
}

#[cfg(unix)]
pub(crate) fn private_directory(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::{DirBuilderExt, MetadataExt};
    match std::fs::DirBuilder::new().mode(0o700).create(path) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
        Err(e) => return Err(e),
    }
    let metadata = std::fs::symlink_metadata(path)?;
    if !metadata.is_dir()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o077 != 0
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "MCP instance directory must be owned by this user with mode 0700",
        ));
    }
    Ok(())
}

#[cfg(unix)]
fn write_private(
    path: &Path,
    write: impl FnOnce(&mut std::fs::File) -> io::Result<()>,
) -> io::Result<()> {
    use std::os::unix::fs::OpenOptionsExt;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)?;
    write(&mut file)?;
    file.sync_all()
}

#[cfg(not(unix))]
pub(crate) fn private_directory(_: &Path) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "desktop MCP requires a private Unix runtime directory in this release",
    ))
}

#[cfg(unix)]
pub(crate) fn connection_lock(directory: &Path) -> io::Result<std::fs::File> {
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(directory.join("connection.lock"))?;
    let metadata = file.metadata()?;
    if !metadata.is_file()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o077 != 0
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "MCP connection lock must be private",
        ));
    }
    if unsafe {
        libc::flock(
            std::os::fd::AsRawFd::as_raw_fd(&file),
            libc::LOCK_EX | libc::LOCK_NB,
        )
    } != 0
    {
        return Err(io::Error::new(
            io::ErrorKind::AddrInUse,
            "MCP is enabled in another SigPilot window; disable it there first",
        ));
    }
    Ok(file)
}
#[cfg(not(unix))]
fn connection_lock(_: &Path) -> io::Result<std::fs::File> {
    Err(io::ErrorKind::Unsupported.into())
}

pub(crate) fn write_private_atomic(path: &Path, data: &[u8]) -> io::Result<()> {
    use std::io::Write;
    write_private_atomic_with(path, false, |file| file.write_all(data))
}
pub(crate) fn write_private_atomic_with(
    path: &Path,
    executable: bool,
    write: impl FnOnce(&mut std::fs::File) -> io::Result<()>,
) -> io::Result<()> {
    if let Ok(metadata) = std::fs::symlink_metadata(path) {
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if metadata.uid() != unsafe { libc::geteuid() } || metadata.mode() & 0o077 != 0 {
                return Err(io::ErrorKind::PermissionDenied.into());
            }
        }
    }
    let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4().simple()));
    let result = write_private(&temporary, write).and_then(|_| {
        #[cfg(unix)]
        if executable {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&temporary, std::fs::Permissions::from_mode(0o700))?;
        }
        #[cfg(not(unix))]
        let _ = executable;
        std::fs::rename(&temporary, path)
    });
    if result.is_err() {
        let _ = std::fs::remove_file(temporary);
    }
    result
}
#[cfg(not(unix))]
fn write_private(_: &Path, _: impl FnOnce(&mut std::fs::File) -> io::Result<()>) -> io::Result<()> {
    Err(io::ErrorKind::Unsupported.into())
}

pub fn read_instance(path: &Path) -> io::Result<InstanceCredentials> {
    use std::io::Read;
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let file = options.open(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let metadata = file.metadata()?;
        if !metadata.is_file()
            || metadata.uid() != unsafe { libc::geteuid() }
            || metadata.mode() & 0o077 != 0
        {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "instance file must be owned by this user with mode 0600",
            ));
        }
    }
    let mut data = Vec::new();
    file.take(4097).read_to_end(&mut data)?;
    if data.len() > 4096 {
        return Err(io::ErrorKind::InvalidData.into());
    }
    let instance: InstanceCredentials = serde_json::from_slice(&data)?;
    let port = instance
        .endpoint
        .strip_prefix("http://127.0.0.1:")
        .and_then(|s| s.strip_suffix("/mcp"))
        .and_then(|p| p.parse::<u16>().ok())
        .filter(|p| *p != 0);
    if instance.schema_version != "1"
        || port.is_none()
        || instance.token.len() != 64
        || !instance.token.bytes().all(|b| b.is_ascii_hexdigit())
        || uuid::Uuid::parse_str(&instance.instance_id).is_err()
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid desktop instance descriptor",
        ));
    }
    Ok(instance)
}
