#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashSet, VecDeque},
    fs,
    io::{BufRead, BufReader, Read},
    path::{Path, PathBuf},
    process::{Child, Command, ExitStatus, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{
    menu::MenuBuilder,
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, WindowEvent,
};
use tauri_plugin_dialog::DialogExt;

const SUPPORTED_LOGIC_VERSION: &str = "2.4.46";
const MAX_LOG_LINES: usize = 500;
const NODE_PROBE_MARKER: &str = "PXLOGIC_NODE_OK:";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ClientSettings {
    logic_app_path: String,
    port_mode: String,
    preferred_port: u16,
    screen_quadrant: u8,
}

impl Default for ClientSettings {
    fn default() -> Self {
        Self {
            logic_app_path: String::new(),
            port_mode: "auto".to_string(),
            preferred_port: 12472,
            screen_quadrant: 3,
        }
    }
}

impl ClientSettings {
    fn normalized(mut self) -> Self {
        self.logic_app_path = self.logic_app_path.trim().to_string();
        if self.port_mode != "fixed" {
            self.port_mode = "auto".to_string();
        }
        if self.screen_quadrant < 1 || self.screen_quadrant > 4 {
            self.screen_quadrant = 3;
        }
        self
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LogicInspection {
    path: String,
    version: Option<String>,
    supported: bool,
    error: Option<String>,
    node_version: Option<String>,
    electron_version: Option<String>,
    profile_id: Option<String>,
    graph_identity: Option<String>,
    graph_sha256: Option<String>,
    hook_status: Option<String>,
}

impl LogicInspection {
    fn failure(path: &Path, version: Option<String>, error: impl Into<String>) -> Self {
        Self {
            path: path.display().to_string(),
            version,
            supported: false,
            error: Some(error.into()),
            node_version: None,
            electron_version: None,
            profile_id: None,
            graph_identity: None,
            graph_sha256: None,
            hook_status: None,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CompatibilityManifest {
    schema_version: u32,
    profiles: Vec<CompatibilityProfile>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CompatibilityProfile {
    id: String,
    logic_version: String,
    platform: String,
    architecture: String,
    graph: CompatibilityGraph,
    hook: CompatibilityHook,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CompatibilityGraph {
    relative_path: String,
    identity_kind: String,
    identity: String,
    sha256: String,
}

#[derive(Clone, Debug, Deserialize)]
struct CompatibilityHook {
    status: String,
    validation: String,
}

struct GraphCompatibility {
    profile: CompatibilityProfile,
    identity: String,
    sha256: String,
}

#[derive(Clone, Debug, Deserialize)]
struct NodeVersions {
    node: String,
    electron: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BridgeState {
    phase: String,
    actual_port: Option<u16>,
    message: String,
}

impl Default for BridgeState {
    fn default() -> Self {
        Self {
            phase: "stopped".to_string(),
            actual_port: None,
            message: "待机".to_string(),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct InitialState {
    settings: ClientSettings,
    applications: Vec<LogicInspection>,
    bridge_state: BridgeState,
    logs: Vec<String>,
}

struct ManagedChild {
    token: u64,
    pid: u32,
    child: Child,
}

#[derive(Default)]
struct RuntimeState {
    child: Option<ManagedChild>,
    starting: bool,
}

struct AppState {
    runtime: Mutex<RuntimeState>,
    bridge_state: Mutex<BridgeState>,
    logs: Mutex<VecDeque<String>>,
    next_token: AtomicU64,
    quitting: AtomicBool,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            runtime: Mutex::new(RuntimeState::default()),
            bridge_state: Mutex::new(BridgeState::default()),
            logs: Mutex::new(VecDeque::new()),
            next_token: AtomicU64::new(1),
            quitting: AtomicBool::new(false),
        }
    }
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|directory| directory.join("settings.json"))
        .map_err(|error| format!("无法确定配置目录: {error}"))
}

fn legacy_settings_path() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        std::env::var_os("HOME").map(|home| {
            PathBuf::from(home)
                .join("Library/Application Support/pxlogic-logic2-bridge-client/settings.json")
        })
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

fn load_settings(app: &AppHandle) -> ClientSettings {
    let primary = settings_path(app).ok();
    let source = primary
        .as_ref()
        .filter(|path| path.is_file())
        .cloned()
        .or_else(|| legacy_settings_path().filter(|path| path.is_file()));
    source
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|contents| serde_json::from_str::<ClientSettings>(&contents).ok())
        .unwrap_or_default()
        .normalized()
}

fn store_settings(app: &AppHandle, settings: ClientSettings) -> Result<ClientSettings, String> {
    let settings = settings.normalized();
    let path = settings_path(app)?;
    let parent = path
        .parent()
        .ok_or_else(|| format!("配置路径无父目录: {}", path.display()))?;
    fs::create_dir_all(parent).map_err(|error| format!("无法创建配置目录: {error}"))?;
    let temporary = path.with_extension("json.tmp");
    let contents = serde_json::to_string_pretty(&settings)
        .map_err(|error| format!("无法序列化配置: {error}"))?;
    fs::write(&temporary, format!("{contents}\n"))
        .map_err(|error| format!("无法写入配置: {error}"))?;
    fs::rename(&temporary, &path).map_err(|error| format!("无法保存配置: {error}"))?;
    Ok(settings)
}

#[cfg(target_os = "macos")]
fn logic_executable(app_path: &Path) -> PathBuf {
    app_path.join("Contents/MacOS/Logic")
}

#[cfg(not(target_os = "macos"))]
fn logic_executable(app_path: &Path) -> PathBuf {
    app_path.to_path_buf()
}

#[cfg(target_os = "macos")]
fn read_logic_version(app_path: &Path) -> Result<String, String> {
    let plist_path = app_path.join("Contents/Info.plist");
    let plist = plist::Value::from_file(&plist_path)
        .map_err(|error| format!("无法读取 {}: {error}", plist_path.display()))?;
    plist
        .as_dictionary()
        .and_then(|dictionary| dictionary.get("CFBundleShortVersionString"))
        .and_then(plist::Value::as_string)
        .map(str::to_string)
        .ok_or_else(|| format!("{} 缺少 Logic 版本信息", plist_path.display()))
}

#[cfg(not(target_os = "macos"))]
fn read_logic_version(_app_path: &Path) -> Result<String, String> {
    Err("当前 GraphServer 注入宿主仅支持 macOS Apple Silicon".to_string())
}

fn compatibility_platform() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        platform => platform,
    }
}

fn compatibility_architecture() -> &'static str {
    match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        architecture => architecture,
    }
}

fn compatibility_manifest() -> Result<CompatibilityManifest, String> {
    let manifest: CompatibilityManifest =
        serde_json::from_str(include_str!("../../../compatibility/profiles.json"))
            .map_err(|error| format!("兼容 profile 清单无效: {error}"))?;
    if manifest.schema_version != 1 {
        return Err(format!(
            "不支持的兼容 profile 清单版本: {}",
            manifest.schema_version
        ));
    }
    Ok(manifest)
}

fn read_u16_le(data: &[u8], offset: usize) -> Option<u16> {
    Some(u16::from_le_bytes(
        data.get(offset..offset + 2)?.try_into().ok()?,
    ))
}

fn read_u32_le(data: &[u8], offset: usize) -> Option<u32> {
    Some(u32::from_le_bytes(
        data.get(offset..offset + 4)?.try_into().ok()?,
    ))
}

fn read_u64_le(data: &[u8], offset: usize) -> Option<u64> {
    Some(u64::from_le_bytes(
        data.get(offset..offset + 8)?.try_into().ok()?,
    ))
}

fn format_uuid(bytes: &[u8]) -> Option<String> {
    if bytes.len() != 16 {
        return None;
    }
    Some(format!(
        "{:02X}{:02X}{:02X}{:02X}-{:02X}{:02X}-{:02X}{:02X}-{:02X}{:02X}-{:02X}{:02X}{:02X}{:02X}{:02X}{:02X}",
        bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
        bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]
    ))
}

fn parse_macho_uuid(data: &[u8]) -> Option<String> {
    if read_u32_le(data, 0)? != 0xfeedfacf {
        return None;
    }
    let command_count = read_u32_le(data, 16)? as usize;
    let command_bytes = read_u32_le(data, 20)? as usize;
    let mut offset = 32usize;
    let end = offset.checked_add(command_bytes)?.min(data.len());
    for _ in 0..command_count {
        let command = read_u32_le(data, offset)?;
        let size = read_u32_le(data, offset + 4)? as usize;
        if size < 8 || offset.checked_add(size)? > end {
            return None;
        }
        if command == 0x1b && size >= 24 {
            return format_uuid(data.get(offset + 8..offset + 24)?);
        }
        offset += size;
    }
    None
}

fn align4(value: usize) -> Option<usize> {
    value.checked_add(3).map(|value| value & !3)
}

fn parse_elf_build_id(data: &[u8]) -> Option<String> {
    if data.get(0..6)? != [0x7f, b'E', b'L', b'F', 2, 1] {
        return None;
    }
    let program_offset = usize::try_from(read_u64_le(data, 32)?).ok()?;
    let entry_size = read_u16_le(data, 54)? as usize;
    let entry_count = read_u16_le(data, 56)? as usize;
    for index in 0..entry_count {
        let header = program_offset.checked_add(index.checked_mul(entry_size)?)?;
        if read_u32_le(data, header)? != 4 {
            continue;
        }
        let mut note = usize::try_from(read_u64_le(data, header + 8)?).ok()?;
        let note_size = usize::try_from(read_u64_le(data, header + 32)?).ok()?;
        let end = note.checked_add(note_size)?.min(data.len());
        while note.checked_add(12)? <= end {
            let name_size = read_u32_le(data, note)? as usize;
            let description_size = read_u32_le(data, note + 4)? as usize;
            let note_type = read_u32_le(data, note + 8)?;
            let name_offset = note + 12;
            let description_offset = name_offset.checked_add(align4(name_size)?)?;
            let next = description_offset.checked_add(align4(description_size)?)?;
            if next > end {
                break;
            }
            let name = data.get(name_offset..name_offset + name_size)?;
            if note_type == 3 && name.starts_with(b"GNU") {
                return Some(
                    data.get(description_offset..description_offset + description_size)?
                        .iter()
                        .map(|byte| format!("{byte:02x}"))
                        .collect(),
                );
            }
            note = next;
        }
    }
    None
}

fn graph_identity(data: &[u8], identity_kind: &str) -> Option<String> {
    match identity_kind {
        "macho-lc-uuid" => parse_macho_uuid(data),
        "elf-gnu-build-id" => parse_elf_build_id(data),
        _ => None,
    }
}

fn inspect_graph_compatibility(
    app_path: &Path,
    logic_version: &str,
) -> Result<GraphCompatibility, String> {
    let manifest = compatibility_manifest()?;
    let candidates: Vec<_> = manifest
        .profiles
        .into_iter()
        .filter(|profile| {
            profile.logic_version == logic_version
                && profile.platform == compatibility_platform()
                && profile.architecture == compatibility_architecture()
        })
        .collect();
    if candidates.is_empty() {
        return Err(format!(
            "Logic {logic_version} 没有 {} {} 兼容 profile",
            compatibility_platform(),
            compatibility_architecture()
        ));
    }

    let mut observed = None;
    for profile in candidates {
        let graph_path = app_path.join(&profile.graph.relative_path);
        let data = fs::read(&graph_path)
            .map_err(|error| format!("无法读取 GraphServer {}: {error}", graph_path.display()))?;
        let sha256 = format!("{:x}", Sha256::digest(&data));
        let identity = graph_identity(&data, &profile.graph.identity_kind)
            .unwrap_or_else(|| "unknown".to_string());
        if sha256.eq_ignore_ascii_case(&profile.graph.sha256)
            && identity.eq_ignore_ascii_case(&profile.graph.identity)
        {
            if profile.hook.status != "verified" {
                return Err(format!(
                    "GraphServer profile {} 尚未完成真机验证: {}",
                    profile.id, profile.hook.validation
                ));
            }
            return Ok(GraphCompatibility {
                profile,
                identity,
                sha256,
            });
        }
        observed = Some((identity, sha256));
    }
    let (identity, sha256) =
        observed.unwrap_or_else(|| ("unknown".to_string(), "unknown".to_string()));
    Err(format!(
        "GraphServer 构建不受支持: identity {identity}, sha256 {sha256}"
    ))
}

fn collect_child_output(child: &mut Child) -> (String, String) {
    let mut stdout = String::new();
    let mut stderr = String::new();
    if let Some(mut stream) = child.stdout.take() {
        let _ = stream.read_to_string(&mut stdout);
    }
    if let Some(mut stream) = child.stderr.take() {
        let _ = stream.read_to_string(&mut stderr);
    }
    (stdout, stderr)
}

fn probe_logic_node(executable: &Path, timeout: Duration) -> Result<NodeVersions, String> {
    let script = concat!(
        "const v={node:process.versions.node,electron:process.versions.electron};",
        "require('node:net');require('node:child_process');",
        "console.log('PXLOGIC_NODE_OK:'+JSON.stringify(v));"
    );
    let mut child = Command::new(executable)
        .args(["-e", script])
        .env("ELECTRON_RUN_AS_NODE", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("无法启动 Logic 内置 Node: {error}"))?;
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let (stdout, stderr) = collect_child_output(&mut child);
                if !status.success() {
                    return Err(format!(
                        "Logic 内置 Node 探测失败（{status}）: {}",
                        stderr.trim()
                    ));
                }
                let payload = stdout
                    .lines()
                    .find_map(|line| line.strip_prefix(NODE_PROBE_MARKER))
                    .ok_or_else(|| "Logic 未提供可用的 Electron RunAsNode 环境".to_string())?;
                let versions: NodeVersions = serde_json::from_str(payload)
                    .map_err(|error| format!("Logic Node 版本响应无效: {error}"))?;
                let node_major = versions
                    .node
                    .split('.')
                    .next()
                    .and_then(|value| value.parse::<u32>().ok())
                    .unwrap_or(0);
                if node_major < 18 || versions.electron.is_empty() {
                    return Err(format!(
                        "Logic 内置运行时过旧: Node {}, Electron {}",
                        versions.node, versions.electron
                    ));
                }
                return Ok(versions);
            }
            Ok(None) if started.elapsed() < timeout => thread::sleep(Duration::from_millis(20)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("Logic 内置 Node 探测超时，RunAsNode 可能已被禁用".to_string());
            }
            Err(error) => {
                let _ = child.kill();
                return Err(format!("Logic 内置 Node 探测失败: {error}"));
            }
        }
    }
}

fn inspect_logic_path(app_path: &Path) -> LogicInspection {
    let version = match read_logic_version(app_path) {
        Ok(version) => version,
        Err(error) => return LogicInspection::failure(app_path, None, error),
    };
    if version != SUPPORTED_LOGIC_VERSION {
        return LogicInspection::failure(
            app_path,
            Some(version),
            format!("当前 bridge 支持 Logic {SUPPORTED_LOGIC_VERSION}"),
        );
    }
    let graph = match inspect_graph_compatibility(app_path, &version) {
        Ok(graph) => graph,
        Err(error) => return LogicInspection::failure(app_path, Some(version), error),
    };
    let executable = logic_executable(app_path);
    if !executable.is_file() {
        return LogicInspection::failure(
            app_path,
            Some(version),
            format!("Logic 可执行文件不存在: {}", executable.display()),
        );
    }
    match probe_logic_node(&executable, Duration::from_secs(4)) {
        Ok(versions) => LogicInspection {
            path: app_path.display().to_string(),
            version: Some(version),
            supported: true,
            error: None,
            node_version: Some(versions.node),
            electron_version: Some(versions.electron),
            profile_id: Some(graph.profile.id),
            graph_identity: Some(graph.identity),
            graph_sha256: Some(graph.sha256),
            hook_status: Some(graph.profile.hook.status),
        },
        Err(error) => LogicInspection::failure(app_path, Some(version), error),
    }
}

#[cfg(target_os = "macos")]
fn installed_logic_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    let names = ["Saleae Logic.app", "Logic 2.app", "Logic.app"];
    let mut roots = vec![PathBuf::from("/Applications")];
    if let Some(home) = std::env::var_os("HOME") {
        roots.push(PathBuf::from(home).join("Applications"));
    }
    for root in roots {
        for name in names {
            candidates.push(root.join(name));
        }
    }
    if let Ok(output) = Command::new("mdfind")
        .arg("kMDItemCFBundleIdentifier == \"com.saleae.saleae\"")
        .output()
    {
        if output.status.success() {
            candidates.extend(
                String::from_utf8_lossy(&output.stdout)
                    .lines()
                    .filter(|line| !line.is_empty())
                    .map(PathBuf::from),
            );
        }
    }
    candidates
}

#[cfg(not(target_os = "macos"))]
fn installed_logic_candidates() -> Vec<PathBuf> {
    Vec::new()
}

fn scan_logic_paths(saved_path: Option<&str>) -> Vec<LogicInspection> {
    let mut candidates = installed_logic_candidates();
    if let Some(path) = saved_path.filter(|path| !path.trim().is_empty()) {
        candidates.insert(0, PathBuf::from(path.trim()));
    }
    let mut seen = HashSet::new();
    let mut applications = Vec::new();
    for candidate in candidates {
        let key = candidate.to_string_lossy().into_owned();
        if !seen.insert(key) || !candidate.exists() {
            continue;
        }
        applications.push(inspect_logic_path(&candidate));
    }
    applications.sort_by_key(|inspection| !inspection.supported);
    applications
}

fn bridge_root(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(resource_dir) = app.path().resource_dir() {
        let packaged = resource_dir.join("tools/logic2-bridge");
        if packaged.join("index.cjs").is_file() {
            return Ok(packaged);
        }
    }
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let development = manifest
        .parent()
        .and_then(Path::parent)
        .map(Path::to_path_buf)
        .ok_or_else(|| "无法确定 bridge 开发目录".to_string())?;
    if development.join("index.cjs").is_file() {
        Ok(development)
    } else {
        Err(format!("Bridge 入口不存在: {}", development.display()))
    }
}

fn validate_bridge_payload(app: &AppHandle) -> Result<PathBuf, String> {
    let root = bridge_root(app)?;
    let required = [
        root.join("index.cjs"),
        root.join("lib/capture-controller.cjs"),
        root.join("lib/compatibility.cjs"),
        root.join("lib/logic-format.cjs"),
        root.join("lib/websocket-proxy.cjs"),
        root.join("compatibility/profiles.json"),
        root.join("build/graph-host"),
    ];
    for path in required {
        if !path.is_file() {
            return Err(format!("Bridge 资源不存在: {}", path.display()));
        }
    }
    Ok(root)
}

fn update_bridge_state(app: &AppHandle, next: BridgeState) {
    if let Ok(mut current) = app.state::<AppState>().bridge_state.lock() {
        *current = next.clone();
    }
    let _ = app.emit("bridge-state", next);
}

fn append_log(app: &AppHandle, source: &str, line: &str) {
    if line.is_empty() {
        return;
    }
    let entry = format!("[{source}] {line}");
    if let Ok(mut logs) = app.state::<AppState>().logs.lock() {
        logs.push_back(entry.clone());
        while logs.len() > MAX_LOG_LINES {
            logs.pop_front();
        }
    }
    let _ = app.emit("bridge-log", &entry);
    if let Some(port) = parse_ready_port(line) {
        update_bridge_state(
            app,
            BridgeState {
                phase: "running".to_string(),
                actual_port: Some(port),
                message: "已连接".to_string(),
            },
        );
    }
}

fn parse_ready_port(line: &str) -> Option<u16> {
    let prefix = "Graph WebSocket ready: ws://127.0.0.1:";
    let value = line.split_once(prefix)?.1.split('/').next()?;
    value.parse().ok()
}

fn read_process_lines(app: AppHandle, source: &'static str, stream: impl Read + Send + 'static) {
    thread::spawn(move || {
        for line in BufReader::new(stream).lines() {
            match line {
                Ok(line) => append_log(&app, source, &line),
                Err(error) => {
                    append_log(&app, "error", &format!("读取 {source} 日志失败: {error}"));
                    break;
                }
            }
        }
    });
}

fn monitor_bridge(app: AppHandle, token: u64) {
    thread::spawn(move || loop {
        let result = {
            let state = app.state::<AppState>();
            let mut runtime = match state.runtime.lock() {
                Ok(runtime) => runtime,
                Err(_) => return,
            };
            let Some(managed) = runtime.child.as_mut() else {
                return;
            };
            if managed.token != token {
                return;
            }
            match managed.child.try_wait() {
                Ok(Some(status)) => {
                    runtime.child.take();
                    Some(Ok(status))
                }
                Ok(None) => None,
                Err(error) => {
                    runtime.child.take();
                    Some(Err(error.to_string()))
                }
            }
        };
        match result {
            Some(result) => {
                let quitting = app.state::<AppState>().quitting.load(Ordering::Acquire);
                match result {
                    Ok(status) if status.success() || quitting => {
                        update_bridge_state(&app, BridgeState::default())
                    }
                    Ok(status) => update_bridge_state(
                        &app,
                        BridgeState {
                            phase: "error".to_string(),
                            actual_port: None,
                            message: format!("Bridge 已退出（{}）", describe_status(status)),
                        },
                    ),
                    Err(error) => update_bridge_state(
                        &app,
                        BridgeState {
                            phase: "error".to_string(),
                            actual_port: None,
                            message: format!("Bridge 状态读取失败: {error}"),
                        },
                    ),
                }
                return;
            }
            None => thread::sleep(Duration::from_millis(150)),
        }
    });
}

fn describe_status(status: ExitStatus) -> String {
    status
        .code()
        .map(|code| format!("代码 {code}"))
        .unwrap_or_else(|| status.to_string())
}

#[cfg(unix)]
fn configure_child_process(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    command.process_group(0);
}

#[cfg(not(unix))]
fn configure_child_process(_command: &mut Command) {}

#[cfg(unix)]
fn terminate_process(pid: u32, force: bool) -> Result<(), String> {
    let signal = if force { libc::SIGKILL } else { libc::SIGTERM };
    let result = unsafe { libc::kill(-(pid as i32), signal) };
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error().to_string())
    }
}

#[cfg(not(unix))]
fn terminate_process(_pid: u32, _force: bool) -> Result<(), String> {
    Err("当前平台尚未实现 bridge 进程组终止".to_string())
}

fn request_stop(app: &AppHandle) -> Result<BridgeState, String> {
    let child = {
        let state = app.state::<AppState>();
        let runtime = state
            .runtime
            .lock()
            .map_err(|_| "Bridge 进程状态已损坏".to_string())?;
        runtime
            .child
            .as_ref()
            .map(|managed| (managed.token, managed.pid))
    };
    let Some((token, pid)) = child else {
        return Ok(app
            .state::<AppState>()
            .bridge_state
            .lock()
            .map_err(|_| "Bridge 状态已损坏".to_string())?
            .clone());
    };
    let next = BridgeState {
        phase: "stopping".to_string(),
        actual_port: None,
        message: "正在停止".to_string(),
    };
    update_bridge_state(app, next.clone());
    terminate_process(pid, false)
        .map_err(|error| format!("无法停止 Bridge 进程 {pid}: {error}"))?;

    let app_for_timeout = app.clone();
    thread::spawn(move || {
        thread::sleep(Duration::from_secs(3));
        let still_running = app_for_timeout
            .state::<AppState>()
            .runtime
            .lock()
            .ok()
            .and_then(|runtime| {
                runtime
                    .child
                    .as_ref()
                    .filter(|managed| managed.token == token)
                    .map(|managed| managed.pid)
            });
        if let Some(pid) = still_running {
            let _ = terminate_process(pid, true);
        }
    });
    Ok(next)
}

fn show_main_window(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn hide_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
}

#[tauri::command]
async fn client_initial_state(app: AppHandle) -> Result<InitialState, String> {
    let worker_app = app.clone();
    let (mut settings, applications) = tauri::async_runtime::spawn_blocking(move || {
        let settings = load_settings(&worker_app);
        let applications = scan_logic_paths(Some(&settings.logic_app_path));
        (settings, applications)
    })
    .await
    .map_err(|error| format!("Logic 扫描任务失败: {error}"))?;
    if settings.logic_app_path.is_empty() {
        if let Some(preferred) = applications
            .iter()
            .find(|application| application.supported)
            .or_else(|| applications.first())
        {
            settings.logic_app_path = preferred.path.clone();
            settings = store_settings(&app, settings)?;
        }
    }
    let state = app.state::<AppState>();
    let bridge_state = state
        .bridge_state
        .lock()
        .map_err(|_| "Bridge 状态已损坏".to_string())?
        .clone();
    let logs = state
        .logs
        .lock()
        .map_err(|_| "Bridge 日志状态已损坏".to_string())?
        .iter()
        .cloned()
        .collect();
    Ok(InitialState {
        settings,
        applications,
        bridge_state,
        logs,
    })
}

#[tauri::command]
fn client_save_settings(
    app: AppHandle,
    settings: ClientSettings,
) -> Result<ClientSettings, String> {
    store_settings(&app, settings)
}

#[tauri::command]
async fn logic_scan(saved_path: String) -> Result<Vec<LogicInspection>, String> {
    tauri::async_runtime::spawn_blocking(move || scan_logic_paths(Some(&saved_path)))
        .await
        .map_err(|error| format!("Logic 扫描任务失败: {error}"))
}

#[tauri::command]
async fn logic_inspect(app_path: String) -> Result<LogicInspection, String> {
    tauri::async_runtime::spawn_blocking(move || inspect_logic_path(Path::new(app_path.trim())))
        .await
        .map_err(|error| format!("Logic 检查任务失败: {error}"))
}

#[tauri::command]
async fn logic_browse(app: AppHandle) -> Result<Option<LogicInspection>, String> {
    let selected = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title("选择 Saleae Logic 2")
            .blocking_pick_folder()
    })
    .await
    .map_err(|error| format!("路径选择任务失败: {error}"))?;
    let Some(path) = selected else {
        return Ok(None);
    };
    let path = path
        .into_path()
        .map_err(|error| format!("选择的路径无效: {error}"))?;
    Ok(Some(inspect_logic_path(&path)))
}

#[tauri::command]
async fn bridge_start(app: AppHandle, settings: ClientSettings) -> Result<BridgeState, String> {
    {
        let state = app.state::<AppState>();
        let mut runtime = state
            .runtime
            .lock()
            .map_err(|_| "Bridge 进程状态已损坏".to_string())?;
        if runtime.starting || runtime.child.is_some() {
            return Err("Bridge 已在运行".to_string());
        }
        runtime.starting = true;
    }
    update_bridge_state(
        &app,
        BridgeState {
            phase: "starting".to_string(),
            actual_port: None,
            message: "正在启动".to_string(),
        },
    );

    let result = start_bridge_inner(&app, settings);
    if result.is_err() {
        if let Ok(mut runtime) = app.state::<AppState>().runtime.lock() {
            runtime.starting = false;
        }
        let message = result.as_ref().err().cloned().unwrap_or_default();
        update_bridge_state(
            &app,
            BridgeState {
                phase: "error".to_string(),
                actual_port: None,
                message,
            },
        );
    }
    result
}

fn start_bridge_inner(app: &AppHandle, settings: ClientSettings) -> Result<BridgeState, String> {
    let settings = store_settings(app, settings)?;
    let app_path = PathBuf::from(&settings.logic_app_path);
    let inspection = inspect_logic_path(&app_path);
    if !inspection.supported {
        return Err(inspection
            .error
            .unwrap_or_else(|| "Logic 2 安装无效".to_string()));
    }
    let bridge_root = validate_bridge_payload(app)?;
    let entry = bridge_root.join("index.cjs");
    let executable = logic_executable(&app_path);
    let port = if settings.port_mode == "fixed" {
        settings.preferred_port.to_string()
    } else {
        "auto".to_string()
    };
    let mut command = Command::new(&executable);
    command
        .arg(&entry)
        .args(["--app", &settings.logic_app_path])
        .args(["--port", &port])
        .args(["--screen-quadrant", &settings.screen_quadrant.to_string()])
        .current_dir(&bridge_root)
        .env("ELECTRON_RUN_AS_NODE", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    configure_child_process(&mut command);
    let mut child = command
        .spawn()
        .map_err(|error| format!("无法通过 Logic 内置 Node 启动 Bridge: {error}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Bridge stdout 不可用".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Bridge stderr 不可用".to_string())?;
    let pid = child.id();
    let token = app
        .state::<AppState>()
        .next_token
        .fetch_add(1, Ordering::AcqRel);
    {
        let state = app.state::<AppState>();
        let mut runtime = state
            .runtime
            .lock()
            .map_err(|_| "Bridge 进程状态已损坏".to_string())?;
        runtime.starting = false;
        runtime.child = Some(ManagedChild { token, pid, child });
    }
    if let Ok(mut logs) = app.state::<AppState>().logs.lock() {
        logs.clear();
    }
    append_log(
        app,
        "client",
        &format!(
            "使用 Logic {} 内置 Node 启动 Bridge",
            inspection.version.unwrap_or_default()
        ),
    );
    read_process_lines(app.clone(), "bridge", stdout);
    read_process_lines(app.clone(), "runtime", stderr);
    monitor_bridge(app.clone(), token);
    Ok(app
        .state::<AppState>()
        .bridge_state
        .lock()
        .map_err(|_| "Bridge 状态已损坏".to_string())?
        .clone())
}

#[tauri::command]
fn bridge_stop(app: AppHandle) -> Result<BridgeState, String> {
    request_stop(&app)
}

fn bridge_log_directory() -> Result<PathBuf, String> {
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var_os("HOME").ok_or_else(|| "无法确定用户目录".to_string())?;
        Ok(PathBuf::from(home).join("Library/Application Support/PXLogic/logic2-bridge"))
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("当前平台尚未实现日志目录定位".to_string())
    }
}

#[tauri::command]
fn logs_open() -> Result<(), String> {
    let directory = bridge_log_directory()?;
    fs::create_dir_all(&directory).map_err(|error| format!("无法创建日志目录: {error}"))?;
    #[cfg(target_os = "macos")]
    let mut command = Command::new("open");
    #[cfg(target_os = "windows")]
    let mut command = Command::new("explorer");
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = Command::new("xdg-open");
    command
        .arg(&directory)
        .spawn()
        .map_err(|error| format!("无法打开日志目录: {error}"))?;
    Ok(())
}

fn setup_tray(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let menu = MenuBuilder::new(app)
        .text("show", "显示 PXLogic Bridge")
        .separator()
        .text("stop", "停止 Bridge")
        .separator()
        .text("quit", "退出")
        .build()?;
    let mut builder = TrayIconBuilder::with_id("main-tray")
        .menu(&menu)
        .tooltip("PXLogic Bridge")
        .show_menu_on_left_click(false)
        .icon_as_template(true)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show_main_window(app),
            "stop" => {
                let _ = request_stop(app);
            }
            "quit" => {
                app.state::<AppState>()
                    .quitting
                    .store(true, Ordering::Release);
                let _ = request_stop(app);
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                show_main_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }
    builder.build(app)?;
    Ok(())
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            client_initial_state,
            client_save_settings,
            logic_scan,
            logic_inspect,
            logic_browse,
            bridge_start,
            bridge_stop,
            logs_open,
        ])
        .setup(setup_tray)
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if !window
                    .app_handle()
                    .state::<AppState>()
                    .quitting
                    .load(Ordering::Acquire)
                {
                    api.prevent_close();
                    hide_main_window(window.app_handle());
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("failed to build PXLogic Bridge");

    app.run(|app, event| match event {
        tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => {
            app.state::<AppState>()
                .quitting
                .store(true, Ordering::Release);
            let _ = request_stop(app);
        }
        _ => {}
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_client_settings() {
        let settings = ClientSettings {
            logic_app_path: "  /Applications/Saleae Logic.app  ".to_string(),
            port_mode: "unexpected".to_string(),
            preferred_port: 43210,
            screen_quadrant: 9,
        }
        .normalized();
        assert_eq!(settings.logic_app_path, "/Applications/Saleae Logic.app");
        assert_eq!(settings.port_mode, "auto");
        assert_eq!(settings.preferred_port, 43210);
        assert_eq!(settings.screen_quadrant, 3);
    }

    #[test]
    fn parses_graph_websocket_ready_line() {
        assert_eq!(
            parse_ready_port("[logic2-bridge] Graph WebSocket ready: ws://127.0.0.1:54102/saleae"),
            Some(54102)
        );
        assert_eq!(parse_ready_port("other output"), None);
    }

    #[test]
    fn parses_macho_graph_uuid() {
        let mut data = vec![0u8; 64];
        data[0..4].copy_from_slice(&0xfeedfacfu32.to_le_bytes());
        data[16..20].copy_from_slice(&1u32.to_le_bytes());
        data[20..24].copy_from_slice(&24u32.to_le_bytes());
        data[32..36].copy_from_slice(&0x1bu32.to_le_bytes());
        data[36..40].copy_from_slice(&24u32.to_le_bytes());
        data[40..56].copy_from_slice(&[
            0x0d, 0xf1, 0x76, 0x31, 0x8e, 0x04, 0x35, 0x01, 0xa7, 0xb5, 0x49, 0xa6, 0x2e, 0x23,
            0x3f, 0xb0,
        ]);
        assert_eq!(
            parse_macho_uuid(&data).as_deref(),
            Some("0DF17631-8E04-3501-A7B5-49A62E233FB0")
        );
    }

    #[test]
    fn loads_versioned_compatibility_profiles() {
        let manifest = compatibility_manifest().unwrap();
        assert_eq!(manifest.schema_version, 1);
        assert!(manifest
            .profiles
            .iter()
            .any(|profile| profile.id == "logic-2.4.46-macos-arm64-0df17631"));
    }
}
