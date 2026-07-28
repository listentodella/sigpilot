//! Decoder backend contracts shared by the Tauri host and external decoders.
//!
//! The protocol-specific Rust implementation is deliberately kept behind the
//! `LegacyRust` backend.  New protocol support belongs in a Saleae analyzer
//! host or a sigrok backend, so both ecosystems can expose their richer
//! annotations without forcing the UI to know which decoder produced them.

use std::{
    collections::BTreeSet,
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

use serde::{Deserialize, Serialize};

use crate::{
    capture::read_sample_word,
    decode::{AnalyzerDecodeSettings, DecodedChannelValue, UartParity},
    error::{CoreError, Result},
    models::{CaptureData, SparseCaptureData},
};

#[derive(Debug, Default, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DecoderBackendKind {
    /// Let the host choose the best available native backend.
    #[default]
    Auto,
    /// Saleae Analyzer SDK host plus native analyzer plugins.
    SaleaeNative,
    /// libsigrokdecode, preferring PXView's native C decoders.
    SigrokNative,
    /// Transitional implementation retained only while external backends are
    /// being integrated. No new protocol logic should be added here.
    LegacyRust,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DecoderBackendIsolation {
    InProcess,
    Sidecar,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DecoderBackendInfo {
    pub kind: DecoderBackendKind,
    pub display_name: String,
    pub available: bool,
    pub protocols: Vec<String>,
    pub supports_streaming: bool,
    pub isolation: DecoderBackendIsolation,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum DecoderFieldValue {
    Text(String),
    Unsigned(u64),
    Signed(i64),
    Boolean(bool),
    Bytes(Vec<u8>),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DecoderField {
    pub name: String,
    pub value: DecoderFieldValue,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DecoderAnnotationKind {
    Data,
    Marker,
    Warning,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DecoderAnnotation {
    pub row: String,
    pub channel: Option<u8>,
    pub start_sample: u64,
    pub end_sample: u64,
    pub kind: DecoderAnnotationKind,
    /// Ordered display candidates. The UI can choose the shortest readable
    /// candidate at the current zoom, matching both Saleae and sigrok output.
    pub texts: Vec<String>,
    pub fields: Vec<DecoderField>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DecoderMarker {
    pub row: String,
    pub channel: Option<u8>,
    pub sample: u64,
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DecoderOutputFrame {
    pub frame_id: u64,
    pub start_sample: u64,
    pub end_sample: u64,
    pub row: String,
    pub texts: Vec<String>,
    pub fields: Vec<DecoderField>,
    pub channel_values: Vec<DecodedChannelValue>,
    pub markers: Vec<DecoderMarker>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DecoderDiagnostic {
    pub level: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DecoderOutput {
    pub backend: DecoderBackendKind,
    pub protocol: String,
    pub frames: Vec<DecoderOutputFrame>,
    pub diagnostics: Vec<DecoderDiagnostic>,
}

const SALEAE_NATIVE_PROTOCOLS: &[&str] = &["UART", "I2C", "SPI", "I2S", "CAN", "LIN", "Parallel"];
const SIGROK_NATIVE_PROTOCOLS: &[&str] = &[
    "UART", "I2C", "SPI", "I2S", "CAN", "CAN-FD", "LIN", "Parallel",
];
const LEGACY_RUST_PROTOCOLS: &[&str] = &["UART", "I2C", "SPI"];

/// Stable host-side contract. External implementations may live in a native
/// sidecar; the input remains the same packed capture representation used by
/// PXLogic and the `.sr` exporter.
pub trait DecoderBackend: Send + Sync {
    fn info(&self) -> DecoderBackendInfo;

    fn decode(
        &self,
        capture: &CaptureData,
        settings: &AnalyzerDecodeSettings,
    ) -> Result<DecoderOutput>;

    /// Decode a transition-indexed capture without expanding it into one
    /// byte per sample. Native backends may override this for long Saleae
    /// captures; the legacy Rust adapter intentionally does not.
    fn decode_sparse(
        &self,
        _capture: &SparseCaptureData,
        _settings: &AnalyzerDecodeSettings,
    ) -> Result<DecoderOutput> {
        Err(CoreError::Decode(
            "decoder backend does not support sparse captures".to_string(),
        ))
    }
}

#[derive(Debug, Clone)]
pub struct SaleaeNativeDecoder {
    sidecar_path: PathBuf,
    runtime_root: PathBuf,
}

#[derive(Debug, Deserialize)]
struct SaleaeSidecarProbe {
    available: bool,
    protocols: Vec<String>,
    supports_streaming: bool,
    analyzer_name: String,
    runtime_sha256: String,
    plugin_sha256: String,
    abi_match: bool,
}

#[derive(Debug, Serialize)]
struct NativeEdgeSet {
    channel: u8,
    samples: Vec<u64>,
}

#[derive(Debug, Serialize)]
struct SpiSidecarSettings {
    protocol: &'static str,
    channels: SpiSidecarChannels,
    options: SpiSidecarOptions,
}

#[derive(Debug, Serialize)]
struct SpiSidecarChannels {
    mosi: Option<u8>,
    miso: Option<u8>,
    clk: u8,
    cs: Option<u8>,
}

#[derive(Debug, Serialize)]
struct SpiSidecarOptions {
    cpol: u8,
    cpha: u8,
    bit_order: &'static str,
    word_size: u8,
    cs_polarity: &'static str,
}

#[derive(Debug, Serialize)]
struct NativeSidecarRequest {
    format: &'static str,
    sample_rate_hz: u64,
    sample_count: u64,
    channel_count: u8,
    initial_levels: Vec<u8>,
    edges: Vec<NativeEdgeSet>,
    decoder: NativeSidecarSettings,
}

#[derive(Debug, Serialize)]
struct NativeSidecarSettings {
    protocol: String,
    channels: serde_json::Value,
    options: serde_json::Value,
}

#[derive(Debug, Serialize)]
struct UartSidecarChannels {
    rx: Option<u8>,
    tx: Option<u8>,
}

#[derive(Debug, Serialize)]
struct UartSidecarOptions {
    baudrate: u32,
    data_bits: u8,
    stop_bits: f64,
    parity: &'static str,
    bit_order: &'static str,
    format: &'static str,
    invert_rx: u8,
    invert_tx: u8,
}

#[derive(Debug, Serialize)]
struct I2cSidecarChannels {
    scl: u8,
    sda: u8,
}

#[derive(Debug, Serialize)]
struct I2cSidecarOptions {
    address_format: &'static str,
    packets_format: &'static str,
    show_data_point: u8,
}

impl SaleaeNativeDecoder {
    pub fn new(sidecar_path: impl Into<PathBuf>, runtime_root: impl Into<PathBuf>) -> Self {
        Self {
            sidecar_path: sidecar_path.into(),
            runtime_root: runtime_root.into(),
        }
    }

    pub fn from_env() -> Result<Self> {
        let sidecar_path = std::env::var_os("PXLOGIC_SALEAE_SIDECAR")
            .map(PathBuf::from)
            .or_else(discover_workspace_saleae_sidecar)
            .ok_or_else(|| {
                CoreError::Decode(
                    "PXLOGIC_SALEAE_SIDECAR is not configured and no bundled or workspace sidecar was found"
                        .to_string(),
                )
            })?;
        let runtime_root = std::env::var_os("PXLOGIC_SALEAE_RUNTIME_ROOT")
            .map(PathBuf::from)
            .or_else(discover_saleae_runtime_root)
            .ok_or_else(|| {
                CoreError::Decode(
                    "PXLOGIC_SALEAE_RUNTIME_ROOT is not configured and Logic 2.4.43 was not found"
                        .to_string(),
                )
            })?;
        Ok(Self::new(sidecar_path, runtime_root))
    }

    fn probe(&self) -> Result<SaleaeSidecarProbe> {
        let output = Command::new(&self.sidecar_path)
            .arg("--runtime-root")
            .arg(&self.runtime_root)
            .arg("--probe")
            .output()?;
        if !output.status.success() {
            return Err(sidecar_error("Saleae", "probe", &output.stderr));
        }
        serde_json::from_slice(&output.stdout).map_err(|error| {
            CoreError::Decode(format!("invalid Saleae sidecar probe response: {error}"))
        })
    }

    fn decode_request<T: Serialize>(&self, request: &T) -> Result<DecoderOutput> {
        let mut child = Command::new(&self.sidecar_path)
            .arg("--runtime-root")
            .arg(&self.runtime_root)
            .arg("--decode")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;
        let mut stdin = child.stdin.take().ok_or_else(|| {
            CoreError::Decode("Saleae sidecar stdin was not available".to_string())
        })?;
        serde_json::to_writer(&mut stdin, request).map_err(|error| {
            CoreError::Decode(format!(
                "failed to serialize Saleae decode request: {error}"
            ))
        })?;
        stdin.flush()?;
        drop(stdin);

        let output = child.wait_with_output()?;
        if !output.status.success() {
            return Err(sidecar_error("Saleae", "decode", &output.stderr));
        }
        serde_json::from_slice(&output.stdout).map_err(|error| {
            CoreError::Decode(format!("invalid Saleae sidecar decode response: {error}"))
        })
    }
}

impl DecoderBackend for SaleaeNativeDecoder {
    fn info(&self) -> DecoderBackendInfo {
        match self.probe() {
            Ok(probe) => DecoderBackendInfo {
                kind: DecoderBackendKind::SaleaeNative,
                display_name: format!("Saleae Native ({})", probe.analyzer_name),
                available: probe.available && probe.abi_match,
                protocols: probe.protocols,
                supports_streaming: probe.supports_streaming,
                isolation: DecoderBackendIsolation::Sidecar,
                detail: format!(
                    "Logic 2.4.43 ABI {}; runtime {}, plugin {}",
                    if probe.abi_match {
                        "matched"
                    } else {
                        "mismatched"
                    },
                    short_hash(&probe.runtime_sha256),
                    short_hash(&probe.plugin_sha256)
                ),
            },
            Err(error) => DecoderBackendInfo {
                kind: DecoderBackendKind::SaleaeNative,
                display_name: "Saleae Native analyzer sidecar".to_string(),
                available: false,
                protocols: protocol_names(SALEAE_NATIVE_PROTOCOLS),
                supports_streaming: false,
                isolation: DecoderBackendIsolation::Sidecar,
                detail: error.to_string(),
            },
        }
    }

    fn decode(
        &self,
        capture: &CaptureData,
        settings: &AnalyzerDecodeSettings,
    ) -> Result<DecoderOutput> {
        let probe = self.probe()?;
        if !probe.available || !probe.abi_match {
            return Err(CoreError::Decode(
                "Saleae Logic runtime does not match the pinned 2.4.43 ABI".to_string(),
            ));
        }
        ensure_protocol_available(&probe.protocols, settings, "Saleae Native")?;
        let request = build_native_sidecar_request(capture, settings)?;
        self.decode_request(&request)
    }

    fn decode_sparse(
        &self,
        capture: &SparseCaptureData,
        settings: &AnalyzerDecodeSettings,
    ) -> Result<DecoderOutput> {
        let probe = self.probe()?;
        if !probe.available || !probe.abi_match {
            return Err(CoreError::Decode(
                "Saleae Logic runtime does not match the pinned 2.4.43 ABI".to_string(),
            ));
        }
        ensure_protocol_available(&probe.protocols, settings, "Saleae Native")?;
        let request = build_sparse_native_sidecar_request(capture, settings)?;
        self.decode_request(&request)
    }
}

#[derive(Debug, Clone)]
pub struct SigrokNativeDecoder {
    sidecar_path: PathBuf,
    decoder_root: PathBuf,
    python_decoder_root: Option<PathBuf>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SigrokDecoderCatalog {
    pub decoders: Vec<SigrokDecoderCatalogItem>,
    pub c_decoder_count: usize,
    pub python_decoder_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SigrokDecoderCatalogItem {
    pub id: Option<String>,
    pub name: Option<String>,
    pub longname: Option<String>,
    pub desc: Option<String>,
    pub license: Option<String>,
    pub kind: Option<String>,
    pub runner_status: Option<String>,
    #[serde(default)]
    pub inputs: Vec<String>,
    #[serde(default)]
    pub outputs: Vec<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub channels: Vec<SigrokDecoderChannel>,
    #[serde(default)]
    pub optional_channels: Vec<SigrokDecoderChannel>,
    #[serde(default)]
    pub options: Vec<SigrokDecoderOption>,
    #[serde(default)]
    pub annotations: Vec<serde_json::Value>,
    #[serde(default)]
    pub annotation_rows: Vec<serde_json::Value>,
    #[serde(default)]
    pub binary: Vec<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SigrokDecoderChannel {
    pub id: Option<String>,
    pub name: Option<String>,
    pub desc: Option<String>,
    #[serde(default)]
    pub order: i32,
    #[serde(default)]
    pub r#type: i32,
    pub type_name: Option<String>,
    pub idn: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SigrokDecoderOption {
    pub id: Option<String>,
    pub idn: Option<String>,
    pub desc: Option<String>,
    pub value_type: Option<String>,
    #[serde(default)]
    pub default: serde_json::Value,
    #[serde(default)]
    pub values: Vec<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct SigrokSidecarProbe {
    available: bool,
    protocols: Vec<String>,
    supports_streaming: bool,
    decoder_name: String,
    decoder_id: String,
    api_version: u32,
    #[serde(default)]
    catalog_included: bool,
    #[serde(default)]
    decoder_catalog: Vec<SigrokDecoderCatalogItem>,
    #[serde(default)]
    c_decoder_count: usize,
    #[serde(default)]
    python_decoder_count: usize,
}

impl SigrokNativeDecoder {
    pub fn new(sidecar_path: impl Into<PathBuf>, decoder_root: impl Into<PathBuf>) -> Self {
        Self::new_with_python_decoder_root(sidecar_path, decoder_root, None::<PathBuf>)
    }

    pub fn new_with_python_decoder_root(
        sidecar_path: impl Into<PathBuf>,
        decoder_root: impl Into<PathBuf>,
        python_decoder_root: Option<impl Into<PathBuf>>,
    ) -> Self {
        Self {
            sidecar_path: sidecar_path.into(),
            decoder_root: decoder_root.into(),
            python_decoder_root: python_decoder_root.map(Into::into),
        }
    }

    pub fn from_env() -> Result<Self> {
        let sidecar_path = std::env::var_os("PXLOGIC_SIGROK_SIDECAR")
            .map(PathBuf::from)
            .or_else(|| discover_workspace_sigrok_path("pxlogic-sigrok-sidecar"))
            .ok_or_else(|| {
                CoreError::Decode(
                    "PXLOGIC_SIGROK_SIDECAR is not configured and no bundled or workspace sidecar was found"
                        .to_string(),
                )
            })?;
        let decoder_root = std::env::var_os("PXLOGIC_SIGROK_DECODER_ROOT")
            .map(PathBuf::from)
            .or_else(|| discover_workspace_sigrok_path("decoders/c_decoders"))
            .ok_or_else(|| {
                CoreError::Decode(
                    "PXLOGIC_SIGROK_DECODER_ROOT is not configured and no bundled or workspace decoder root was found"
                        .to_string(),
                )
            })?;
        let python_decoder_root = std::env::var_os("PXLOGIC_SIGROK_PYTHON_DECODER_ROOT")
            .map(PathBuf::from)
            .or_else(discover_workspace_sigrok_python_decoder_root);
        Ok(Self::new_with_python_decoder_root(
            sidecar_path,
            decoder_root,
            python_decoder_root,
        ))
    }

    fn probe(&self) -> Result<SigrokSidecarProbe> {
        self.probe_with_catalog(false)
    }

    pub fn decoder_catalog(&self) -> Result<SigrokDecoderCatalog> {
        let probe = self.probe_with_catalog(true)?;
        Ok(SigrokDecoderCatalog {
            decoders: probe.decoder_catalog,
            c_decoder_count: probe.c_decoder_count,
            python_decoder_count: probe.python_decoder_count,
        })
    }

    fn probe_with_catalog(&self, include_catalog: bool) -> Result<SigrokSidecarProbe> {
        let mut command = Command::new(&self.sidecar_path);
        command.arg("--decoder-root").arg(&self.decoder_root);
        if let Some(root) = &self.python_decoder_root {
            command.arg("--python-decoder-root").arg(root);
        }
        command.arg("--probe");
        if include_catalog {
            command.arg("--catalog");
        }
        let output = command.output()?;
        if !output.status.success() {
            return Err(sidecar_error("Sigrok", "probe", &output.stderr));
        }
        serde_json::from_slice(&output.stdout).map_err(|error| {
            CoreError::Decode(format!("invalid Sigrok sidecar probe response: {error}"))
        })
    }

    fn decode_request<T: Serialize>(&self, request: &T) -> Result<DecoderOutput> {
        let mut command = Command::new(&self.sidecar_path);
        command.arg("--decoder-root").arg(&self.decoder_root);
        if let Some(root) = &self.python_decoder_root {
            command.arg("--python-decoder-root").arg(root);
        }
        let mut child = command
            .arg("--decode")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;
        let mut stdin = child.stdin.take().ok_or_else(|| {
            CoreError::Decode("Sigrok sidecar stdin was not available".to_string())
        })?;
        serde_json::to_writer(&mut stdin, request).map_err(|error| {
            CoreError::Decode(format!(
                "failed to serialize Sigrok decode request: {error}"
            ))
        })?;
        stdin.flush()?;
        drop(stdin);

        let output = child.wait_with_output()?;
        if !output.status.success() {
            return Err(sidecar_error("Sigrok", "decode", &output.stderr));
        }
        serde_json::from_slice(&output.stdout).map_err(|error| {
            CoreError::Decode(format!("invalid Sigrok sidecar decode response: {error}"))
        })
    }
}

fn discover_workspace_sigrok_path(relative: &str) -> Option<PathBuf> {
    native_sidecar_search_paths("sigrok-analyzer-sidecar", relative)
        .into_iter()
        .find(|path| path.exists())
}

fn discover_workspace_sigrok_python_decoder_root() -> Option<PathBuf> {
    decoder_resource_search_paths("sigrok-analyzer-sidecar", "decoders/python_decoders")
        .into_iter()
        .chain(workspace_decoder_search_paths(
            "pxview-fork/libsigrokdecode/decoders",
        ))
        .find(|path| path.is_dir())
}

fn discover_workspace_saleae_sidecar() -> Option<PathBuf> {
    native_sidecar_search_paths(
        "saleae-analyzer-sidecar",
        "pxlogic-saleae-analyzer-sidecar",
    )
    .into_iter()
    .find(|path| path.is_file())
}

fn native_sidecar_search_paths(subdir: &str, relative: &str) -> Vec<PathBuf> {
    let mut paths = decoder_resource_search_paths(subdir, relative);
    paths.extend(workspace_native_search_paths(subdir, relative));
    dedup_paths(paths)
}

fn decoder_resource_search_paths(subdir: &str, relative: &str) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Ok(current) = std::env::current_dir() {
        push_bundled_native_candidate(&mut paths, &current, subdir, relative);
    }

    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    push_bundled_native_candidate(&mut paths, &manifest_dir, subdir, relative);
    if let Some(workspace_root) = manifest_dir.parent().and_then(Path::parent) {
        push_bundled_native_candidate(&mut paths, workspace_root, subdir, relative);
    }

    if let Ok(exe) = std::env::current_exe() {
        for ancestor in exe.ancestors().take(8) {
            push_bundled_native_candidate(&mut paths, ancestor, subdir, relative);
        }
    }
    dedup_paths(paths)
}

fn workspace_native_search_paths(subdir: &str, relative: &str) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Ok(current) = std::env::current_dir() {
        push_workspace_native_candidate(&mut paths, &current, subdir, relative);
    }

    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    push_workspace_native_candidate(&mut paths, &manifest_dir, subdir, relative);
    if let Some(workspace_root) = manifest_dir.parent().and_then(Path::parent) {
        push_workspace_native_candidate(&mut paths, workspace_root, subdir, relative);
    }

    if let Ok(exe) = std::env::current_exe() {
        for ancestor in exe.ancestors().take(8) {
            push_workspace_native_candidate(&mut paths, ancestor, subdir, relative);
        }
    }
    dedup_paths(paths)
}

fn workspace_decoder_search_paths(relative: &str) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Ok(current) = std::env::current_dir() {
        paths.push(current.join(relative));
        paths.push(current.join("..").join(relative));
    }

    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    paths.push(manifest_dir.join(relative));
    if let Some(workspace_root) = manifest_dir.parent().and_then(Path::parent) {
        paths.push(workspace_root.join(relative));
    }

    dedup_paths(paths)
}

fn push_bundled_native_candidate(
    paths: &mut Vec<PathBuf>,
    base: &Path,
    subdir: &str,
    relative: &str,
) {
    paths.push(
        base.join("resources")
            .join("native")
            .join(subdir)
            .join(relative),
    );
    paths.push(
        base.join("Resources")
            .join("resources")
            .join("native")
            .join(subdir)
            .join(relative),
    );
}

fn push_workspace_native_candidate(
    paths: &mut Vec<PathBuf>,
    base: &Path,
    subdir: &str,
    relative: &str,
) {
    paths.push(base.join("target").join("native").join(subdir).join(relative));
    paths.push(
        base.join("native")
            .join(subdir)
            .join("target")
            .join(relative),
    );
}

fn dedup_paths(paths: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut deduped = Vec::new();
    for path in paths {
        if !deduped.iter().any(|existing| existing == &path) {
            deduped.push(path);
        }
    }
    deduped
}

fn discover_saleae_runtime_root() -> Option<PathBuf> {
    saleae_runtime_search_dirs()
        .into_iter()
        .find(|path| is_saleae_analyzer_runtime(path))
}

fn saleae_runtime_search_dirs() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(current) = std::env::current_dir() {
        push_saleae_runtime_candidates(&mut candidates, &current);
    }

    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    push_saleae_runtime_candidates(&mut candidates, &manifest_dir);
    if let Some(workspace_root) = manifest_dir.parent().and_then(Path::parent) {
        push_saleae_runtime_candidates(&mut candidates, workspace_root);
    }

    if let Ok(exe) = std::env::current_exe() {
        for ancestor in exe.ancestors().take(8) {
            push_saleae_runtime_candidates(&mut candidates, ancestor);
        }
    }

    candidates.extend([
        PathBuf::from("/Applications/Saleae Logic.app/Contents/Resources/macos-arm64"),
        PathBuf::from("/Applications/Logic 2.app/Contents/Resources/macos-arm64"),
    ]);
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        candidates.extend([
            home.join("Applications/Saleae Logic.app/Contents/Resources/macos-arm64"),
            home.join("Applications/Logic 2.app/Contents/Resources/macos-arm64"),
            home.join("Downloads/Saleae Logic.app/Contents/Resources/macos-arm64"),
        ]);
    }
    dedup_paths(candidates)
}

fn push_saleae_runtime_candidates(candidates: &mut Vec<PathBuf>, base: &Path) {
    candidates.push(base.join("vendor").join("saleae-runtime-2.4.43"));
    candidates.push(base.join("target").join("native").join("saleae-runtime-2.4.43"));
    candidates.push(
        base.join("resources")
            .join("native")
            .join("saleae-runtime-2.4.43"),
    );
    candidates.push(
        base.join("Resources")
            .join("resources")
            .join("native")
            .join("saleae-runtime-2.4.43"),
    );
}

fn is_saleae_analyzer_runtime(path: &Path) -> bool {
    path.join("libAnalyzer.dylib").is_file()
        && path.join("Analyzers/libserial_analyzer.so").is_file()
        && path.join("Analyzers/libi2c_analyzer.so").is_file()
        && path.join("Analyzers/libspi_analyzer.so").is_file()
        && path.join("Analyzers/libi2s_analyzer.so").is_file()
        && path.join("Analyzers/libcan_analyzer.so").is_file()
        && path.join("Analyzers/liblin_analyzer.so").is_file()
        && path
            .join("Analyzers/libsimple_parallel_analyzer.so")
            .is_file()
}

impl DecoderBackend for SigrokNativeDecoder {
    fn info(&self) -> DecoderBackendInfo {
        match self.probe() {
            Ok(probe) => DecoderBackendInfo {
                kind: DecoderBackendKind::SigrokNative,
                display_name: format!("Sigrok Native ({})", probe.decoder_name),
                available: probe.available && probe.api_version == 4,
                protocols: probe.protocols,
                supports_streaming: probe.supports_streaming,
                isolation: DecoderBackendIsolation::Sidecar,
                detail: if probe.catalog_included {
                    format!(
                        "PXView verified sparse C runner {}, API v{}; catalog contains {} C and {} Python decoders",
                        probe.decoder_id,
                        probe.api_version,
                        probe.c_decoder_count,
                        probe.python_decoder_count
                    )
                } else {
                    format!(
                        "PXView verified sparse C runner {}, API v{}; full libsigrokdecode catalog is available through --catalog",
                        probe.decoder_id, probe.api_version
                    )
                },
            },
            Err(error) => DecoderBackendInfo {
                kind: DecoderBackendKind::SigrokNative,
                display_name: "Sigrok Native analyzer sidecar".to_string(),
                available: false,
                protocols: protocol_names(SIGROK_NATIVE_PROTOCOLS),
                supports_streaming: false,
                isolation: DecoderBackendIsolation::Sidecar,
                detail: error.to_string(),
            },
        }
    }

    fn decode(
        &self,
        capture: &CaptureData,
        settings: &AnalyzerDecodeSettings,
    ) -> Result<DecoderOutput> {
        let probe = self.probe()?;
        if !probe.available || probe.api_version != 4 {
            return Err(CoreError::Decode(
                "PXView native C decoder API v4 is not available".to_string(),
            ));
        }
        ensure_sigrok_protocol_available(&probe, settings)?;
        let request = build_native_sidecar_request(capture, settings)?;
        self.decode_request(&request)
    }

    fn decode_sparse(
        &self,
        capture: &SparseCaptureData,
        settings: &AnalyzerDecodeSettings,
    ) -> Result<DecoderOutput> {
        let probe = self.probe()?;
        if !probe.available || probe.api_version != 4 {
            return Err(CoreError::Decode(
                "PXView native C decoder API v4 is not available".to_string(),
            ));
        }
        ensure_sigrok_protocol_available(&probe, settings)?;
        let request = build_sparse_native_sidecar_request(capture, settings)?;
        self.decode_request(&request)
    }
}

fn native_protocol_name(settings: &AnalyzerDecodeSettings) -> &str {
    match settings {
        AnalyzerDecodeSettings::Uart(_) => "UART",
        AnalyzerDecodeSettings::I2c(_) => "I2C",
        AnalyzerDecodeSettings::Spi(_) => "SPI",
        AnalyzerDecodeSettings::Native(settings) => &settings.protocol_name,
    }
}

fn protocol_names(protocols: &[&str]) -> Vec<String> {
    protocols.iter().map(|protocol| (*protocol).to_string()).collect()
}

fn ensure_sigrok_protocol_available(
    probe: &SigrokSidecarProbe,
    settings: &AnalyzerDecodeSettings,
) -> Result<()> {
    ensure_protocol_available(&probe.protocols, settings, "PXView Sigrok C")
}

fn ensure_protocol_available(
    protocols: &[String],
    settings: &AnalyzerDecodeSettings,
    backend: &str,
) -> Result<()> {
    let protocol = native_protocol_name(settings);
    if protocols
        .iter()
        .any(|candidate| candidate.eq_ignore_ascii_case(protocol))
    {
        Ok(())
    } else {
        Err(CoreError::Decode(format!(
            "{backend} decoder for {protocol} is not available"
        )))
    }
}

fn configured_native_channels(
    settings: &AnalyzerDecodeSettings,
    channel_count: u8,
) -> Result<BTreeSet<u8>> {
    let channels = match settings {
        AnalyzerDecodeSettings::Uart(settings) => BTreeSet::from([settings.channel]),
        AnalyzerDecodeSettings::I2c(settings) => {
            BTreeSet::from([settings.sda_channel, settings.scl_channel])
        }
        AnalyzerDecodeSettings::Spi(settings) => configured_spi_channels(settings, channel_count)?,
        AnalyzerDecodeSettings::Native(settings) => {
            let channels: BTreeSet<u8> = settings.channels.values().flatten().copied().collect();
            if !channels.contains(&settings.primary_channel) {
                return Err(CoreError::Decode(format!(
                    "native {} primary channel is not configured",
                    settings.protocol_name
                )));
            }
            channels
        }
    };
    if channels.iter().any(|channel| *channel >= channel_count) {
        return Err(CoreError::Decode(format!(
            "native {} channel is outside the capture",
            native_protocol_name(settings)
        )));
    }
    Ok(channels)
}

fn packed_transition_sets(
    capture: &CaptureData,
    channels: &BTreeSet<u8>,
) -> Result<(Vec<u8>, Vec<NativeEdgeSet>)> {
    let first_word = capture_word(capture, 0)?;
    let initial_levels = (0..capture.metadata.channel_count)
        .map(|channel| u8::from(first_word & (1u32 << channel) != 0))
        .collect();
    let mut edges = channels
        .iter()
        .map(|channel| NativeEdgeSet {
            channel: *channel,
            samples: Vec::new(),
        })
        .collect::<Vec<_>>();
    let mut previous_word = first_word;
    for sample in 1..capture.metadata.sample_count {
        let word = capture_word(capture, sample)?;
        let changed = previous_word ^ word;
        if changed != 0 {
            for edge_set in &mut edges {
                if changed & (1u32 << edge_set.channel) != 0 {
                    edge_set.samples.push(sample);
                }
            }
        }
        previous_word = word;
    }
    Ok((initial_levels, edges))
}

fn sparse_transition_sets(
    capture: &SparseCaptureData,
    channels: &BTreeSet<u8>,
) -> Result<(Vec<u8>, Vec<NativeEdgeSet>)> {
    let mut initial_levels = vec![0u8; usize::from(capture.metadata.channel_count)];
    let mut available = BTreeSet::new();
    for sparse_channel in &capture.channels {
        if sparse_channel.channel >= capture.metadata.channel_count
            || !available.insert(sparse_channel.channel)
            || sparse_channel
                .transitions
                .windows(2)
                .any(|window| window[0] >= window[1])
            || sparse_channel
                .transitions
                .iter()
                .any(|sample| *sample == 0 || *sample >= capture.metadata.sample_count)
        {
            return Err(CoreError::Decode(
                "invalid sparse transition channel data".to_string(),
            ));
        }
        initial_levels[usize::from(sparse_channel.channel)] = u8::from(sparse_channel.initial_high);
    }
    let mut edges = Vec::with_capacity(channels.len());
    for channel in channels {
        if !available.contains(channel) {
            return Err(CoreError::Decode(format!(
                "native decoder channel D{channel} is not present in the sparse capture"
            )));
        }
        let sparse_channel = capture
            .channels
            .iter()
            .find(|candidate| candidate.channel == *channel)
            .expect("available sparse channel was just validated");
        edges.push(NativeEdgeSet {
            channel: *channel,
            samples: sparse_channel.transitions.clone(),
        });
    }
    Ok((initial_levels, edges))
}

fn native_sidecar_settings(settings: &AnalyzerDecodeSettings) -> NativeSidecarSettings {
    let (protocol, channels, options) = match settings {
        AnalyzerDecodeSettings::Uart(settings) => (
            "uart".to_string(),
            serde_json::to_value(UartSidecarChannels {
                rx: Some(settings.channel),
                tx: None,
            })
            .expect("UART sidecar channels serialize"),
            serde_json::to_value(UartSidecarOptions {
                baudrate: settings.baud_rate,
                data_bits: settings.data_bits,
                stop_bits: settings.stop_bits.as_f64(),
                parity: match settings.parity {
                    UartParity::None => "none",
                    UartParity::Even => "even",
                    UartParity::Odd => "odd",
                },
                bit_order: if settings.msb_first {
                    "msb-first"
                } else {
                    "lsb-first"
                },
                format: "hex",
                invert_rx: u8::from(settings.inverted),
                invert_tx: 0,
            })
            .expect("UART sidecar options serialize"),
        ),
        AnalyzerDecodeSettings::I2c(settings) => (
            "i2c".to_string(),
            serde_json::to_value(I2cSidecarChannels {
                scl: settings.scl_channel,
                sda: settings.sda_channel,
            })
            .expect("I2C sidecar channels serialize"),
            serde_json::to_value(I2cSidecarOptions {
                address_format: "shifted",
                packets_format: "hex",
                show_data_point: 0,
            })
            .expect("I2C sidecar options serialize"),
        ),
        AnalyzerDecodeSettings::Spi(settings) => {
            let spi = spi_sidecar_settings(settings);
            (
                "spi".to_string(),
                serde_json::to_value(spi.channels).expect("SPI sidecar channels serialize"),
                serde_json::to_value(spi.options).expect("SPI sidecar options serialize"),
            )
        }
        AnalyzerDecodeSettings::Native(settings) => (
            settings.decoder_id.clone(),
            serde_json::to_value(&settings.channels).expect("native sidecar channels serialize"),
            serde_json::to_value(&settings.options).expect("native sidecar options serialize"),
        ),
    };
    NativeSidecarSettings {
        protocol,
        channels,
        options,
    }
}

fn build_native_sidecar_request(
    capture: &CaptureData,
    settings: &AnalyzerDecodeSettings,
) -> Result<NativeSidecarRequest> {
    if capture.metadata.sample_count == 0 {
        return Err(CoreError::Decode(
            "native decoding requires at least one sample".to_string(),
        ));
    }
    let channels = configured_native_channels(settings, capture.metadata.channel_count)?;
    let (initial_levels, edges) = packed_transition_sets(capture, &channels)?;
    Ok(NativeSidecarRequest {
        format: "pxlogic.decoder.v1",
        sample_rate_hz: capture.metadata.sample_rate_hz,
        sample_count: capture.metadata.sample_count,
        channel_count: capture.metadata.channel_count,
        initial_levels,
        edges,
        decoder: native_sidecar_settings(settings),
    })
}

fn build_sparse_native_sidecar_request(
    capture: &SparseCaptureData,
    settings: &AnalyzerDecodeSettings,
) -> Result<NativeSidecarRequest> {
    if capture.metadata.sample_count == 0 {
        return Err(CoreError::Decode(
            "native decoding requires at least one sample".to_string(),
        ));
    }
    let channels = configured_native_channels(settings, capture.metadata.channel_count)?;
    let (initial_levels, edges) = sparse_transition_sets(capture, &channels)?;
    Ok(NativeSidecarRequest {
        format: "pxlogic.decoder.v1",
        sample_rate_hz: capture.metadata.sample_rate_hz,
        sample_count: capture.metadata.sample_count,
        channel_count: capture.metadata.channel_count,
        initial_levels,
        edges,
        decoder: native_sidecar_settings(settings),
    })
}

fn configured_spi_channels(
    settings: &crate::decode::SpiDecodeSettings,
    channel_count: u8,
) -> Result<BTreeSet<u8>> {
    let mut channels = BTreeSet::from([settings.clock_channel]);
    channels.extend(settings.mosi_channel);
    channels.extend(settings.miso_channel);
    channels.extend(settings.enable_channel);
    if channels.iter().any(|channel| *channel >= channel_count) {
        return Err(CoreError::Decode(
            "native SPI channel is outside the capture".to_string(),
        ));
    }
    Ok(channels)
}

fn spi_sidecar_settings(settings: &crate::decode::SpiDecodeSettings) -> SpiSidecarSettings {
    SpiSidecarSettings {
        protocol: "spi",
        channels: SpiSidecarChannels {
            mosi: settings.mosi_channel,
            miso: settings.miso_channel,
            clk: settings.clock_channel,
            cs: settings.enable_channel,
        },
        options: SpiSidecarOptions {
            cpol: u8::from(settings.clock_polarity),
            cpha: u8::from(settings.clock_phase),
            bit_order: if settings.msb_first {
                "msb_first"
            } else {
                "lsb_first"
            },
            word_size: settings.bits_per_transfer,
            cs_polarity: if settings.enable_active_low {
                "active_low"
            } else {
                "active_high"
            },
        },
    }
}

fn capture_word(capture: &CaptureData, sample: u64) -> Result<u32> {
    read_sample_word(&capture.samples, capture.metadata.unitsize, sample).ok_or_else(|| {
        CoreError::Decode(format!(
            "capture ended before declared sample {sample} of {}",
            capture.metadata.sample_count
        ))
    })
}

fn sidecar_error(backend: &str, operation: &str, stderr: &[u8]) -> CoreError {
    let message = String::from_utf8_lossy(stderr).trim().to_string();
    CoreError::Decode(format!(
        "{backend} sidecar {operation} failed{}",
        if message.is_empty() {
            String::new()
        } else {
            format!(": {message}")
        }
    ))
}

fn short_hash(hash: &str) -> &str {
    hash.get(..12).unwrap_or(hash)
}

impl DecoderOutput {
    pub fn into_decoded_frames(self) -> Vec<crate::decode::DecodedFrame> {
        self.frames
            .into_iter()
            .map(|frame| {
                let frame_type = frame.row.clone();
                let label = frame
                    .texts
                    .first()
                    .cloned()
                    .or_else(|| {
                        frame
                            .channel_values
                            .first()
                            .map(|value| value.label.clone())
                    })
                    .unwrap_or(frame.row);
                let value = frame
                    .channel_values
                    .first()
                    .map(|value| value.value)
                    .unwrap_or(0);
                crate::decode::DecodedFrame {
                    frame_id: frame.frame_id,
                    start_sample: frame.start_sample,
                    end_sample: frame.end_sample,
                    frame_type,
                    label,
                    value,
                    channel_values: frame.channel_values,
                }
            })
            .collect()
    }
}

/// Compatibility adapter for the current implementation. Keeping this
/// adapter explicit makes the eventual removal of the Rust decoder a backend
/// replacement instead of a UI rewrite.
#[derive(Debug, Default, Clone, Copy)]
pub struct LegacyRustDecoder;

impl DecoderBackend for LegacyRustDecoder {
    fn info(&self) -> DecoderBackendInfo {
        DecoderBackendInfo {
            kind: DecoderBackendKind::LegacyRust,
            display_name: "Legacy Rust decoder".to_string(),
            available: true,
            protocols: protocol_names(LEGACY_RUST_PROTOCOLS),
            supports_streaming: true,
            isolation: DecoderBackendIsolation::InProcess,
            detail: "Compatibility fallback only; prefer Saleae Native or Sigrok Native."
                .to_string(),
        }
    }

    fn decode(
        &self,
        capture: &CaptureData,
        settings: &AnalyzerDecodeSettings,
    ) -> Result<DecoderOutput> {
        let protocol = match settings {
            AnalyzerDecodeSettings::Uart(_) => "UART",
            AnalyzerDecodeSettings::I2c(_) => "I2C",
            AnalyzerDecodeSettings::Spi(_) => "SPI",
            AnalyzerDecodeSettings::Native(settings) => {
                return Err(CoreError::Decode(format!(
                    "{} is not implemented by the Legacy Rust decoder",
                    settings.protocol_name
                )))
            }
        };
        let frames = crate::decode::decode_analyzer(capture, settings)?
            .into_iter()
            .map(|frame| DecoderOutputFrame {
                frame_id: frame.frame_id,
                start_sample: frame.start_sample,
                end_sample: frame.end_sample,
                row: protocol.to_string(),
                texts: vec![frame.label],
                fields: Vec::new(),
                channel_values: frame.channel_values,
                markers: Vec::new(),
            })
            .collect();
        Ok(DecoderOutput {
            backend: DecoderBackendKind::LegacyRust,
            protocol: protocol.to_string(),
            frames,
            diagnostics: Vec::new(),
        })
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use chrono::Utc;

    use super::*;
    use crate::{
        decode::{
            I2cDecodeSettings, NativeDecodeSettings, NativeOptionValue, SpiDecodeSettings,
            UartDecodeSettings,
        },
        models::{CaptureMetadata, SparseDigitalChannel},
    };

    #[test]
    fn native_sidecar_candidates_include_macos_app_resource_layout() {
        let contents_dir = PathBuf::from("/Applications/PXLogic Studio.app/Contents");
        let mut paths = Vec::new();
        push_bundled_native_candidate(
            &mut paths,
            &contents_dir,
            "saleae-analyzer-sidecar",
            "pxlogic-saleae-analyzer-sidecar",
        );

        assert!(paths.contains(
            &contents_dir
                .join("Resources")
                .join("resources")
                .join("native")
                .join("saleae-analyzer-sidecar")
                .join("pxlogic-saleae-analyzer-sidecar")
        ));

        let mut runtime_paths = Vec::new();
        push_saleae_runtime_candidates(&mut runtime_paths, &contents_dir);
        assert!(runtime_paths.contains(
            &contents_dir
                .join("Resources")
                .join("resources")
                .join("native")
                .join("saleae-runtime-2.4.43")
        ));
    }

    fn transition_capture(
        source: &str,
        sample_rate_hz: u64,
        sample_count: u64,
        initial_levels: &[u8],
        edge_sets: &[(u8, Vec<u64>)],
    ) -> CaptureData {
        let mut word = initial_levels
            .iter()
            .enumerate()
            .fold(0u8, |word, (channel, level)| word | (*level << channel));
        let mut samples = Vec::with_capacity(sample_count as usize);
        for sample in 0..sample_count {
            for (channel, edges) in edge_sets {
                if edges.contains(&sample) {
                    word ^= 1u8 << channel;
                }
            }
            samples.push(word);
        }
        CaptureData {
            metadata: CaptureMetadata {
                version: 1,
                source_device: source.to_string(),
                sample_rate_hz,
                channel_count: initial_levels.len() as u8,
                enabled_channels: (0..initial_levels.len() as u8).collect(),
                unitsize: 1,
                sample_count,
                captured_at: Utc::now(),
                labels: (0..initial_levels.len())
                    .map(|channel| format!("D{channel}"))
                    .collect(),
                trigger: None,
            },
            samples,
        }
    }

    fn sparse_transition_capture(
        source: &str,
        sample_rate_hz: u64,
        sample_count: u64,
        offset: u64,
        initial_levels: &[u8],
        edge_sets: &[(u8, Vec<u64>)],
    ) -> SparseCaptureData {
        SparseCaptureData {
            metadata: CaptureMetadata {
                version: 1,
                source_device: source.to_string(),
                sample_rate_hz,
                channel_count: initial_levels.len() as u8,
                enabled_channels: (0..initial_levels.len() as u8).collect(),
                unitsize: 1,
                sample_count,
                captured_at: Utc::now(),
                labels: (0..initial_levels.len())
                    .map(|channel| format!("D{channel}"))
                    .collect(),
                trigger: None,
            },
            channels: edge_sets
                .iter()
                .map(|(channel, transitions)| SparseDigitalChannel {
                    channel: *channel,
                    initial_high: initial_levels[usize::from(*channel)] != 0,
                    transitions: transitions.iter().map(|sample| offset + sample).collect(),
                })
                .collect(),
        }
    }

    fn uart_capture_and_settings() -> (CaptureData, AnalyzerDecodeSettings) {
        (
            transition_capture(
                "sigrok-uart-test",
                1_000_000,
                120,
                &[1],
                &[(0, vec![10, 20, 30, 40, 50, 70, 80, 90])],
            ),
            AnalyzerDecodeSettings::Uart(UartDecodeSettings {
                channel: 0,
                baud_rate: 100_000,
                inverted: false,
                ..UartDecodeSettings::default()
            }),
        )
    }

    fn i2c_edge_sets() -> Vec<(u8, Vec<u64>)> {
        vec![
            (
                0,
                vec![
                    20, 40, 50, 70, 80, 100, 110, 130, 140, 160, 170, 190, 200, 220, 230, 250, 260,
                    280, 290, 310, 320, 340, 350, 370, 380, 400, 410, 430, 440, 460, 470, 490, 500,
                    520, 530, 550, 560, 570,
                ],
            ),
            (
                1,
                vec![
                    10, 30, 60, 90, 120, 300, 330, 360, 390, 450, 480, 510, 540, 580,
                ],
            ),
        ]
    }

    fn i2c_capture_and_settings() -> (CaptureData, AnalyzerDecodeSettings) {
        (
            transition_capture("sigrok-i2c-test", 1_000_000, 600, &[1, 1], &i2c_edge_sets()),
            AnalyzerDecodeSettings::I2c(I2cDecodeSettings {
                scl_channel: 0,
                sda_channel: 1,
            }),
        )
    }

    fn i2s_edge_sets() -> Vec<(u8, Vec<u64>)> {
        let mut edges = vec![(0, Vec::new()), (1, Vec::new()), (2, Vec::new())];
        let mut levels = [false; 3];
        let words = [0x1234u16, 0x5678, 0x9abc];
        let bits = words
            .into_iter()
            .flat_map(|word| (0..16).rev().map(move |bit| word & (1 << bit) != 0))
            .collect::<Vec<_>>();
        for sample in 1..400u64 {
            let bit = sample.checked_sub(48).map(|offset| (offset / 10) as usize);
            let next = [
                sample >= 10 && (sample - 10) % 10 < 5,
                (48..208).contains(&sample) || sample >= 368,
                bit.and_then(|index| bits.get(index))
                    .copied()
                    .unwrap_or(false),
            ];
            for channel in 0..3 {
                if next[channel] != levels[channel] {
                    edges[channel].1.push(sample);
                    levels[channel] = next[channel];
                }
            }
        }
        edges
    }

    fn i2s_settings() -> AnalyzerDecodeSettings {
        AnalyzerDecodeSettings::Native(NativeDecodeSettings {
            decoder_id: "i2s".to_string(),
            protocol_name: "I2S".to_string(),
            channels: BTreeMap::from([
                ("sck".to_string(), Some(0)),
                ("ws".to_string(), Some(1)),
                ("sd".to_string(), Some(2)),
            ]),
            options: BTreeMap::from([
                (
                    "bit_order".to_string(),
                    NativeOptionValue::Text("msb-first".to_string()),
                ),
                (
                    "clk_edge".to_string(),
                    NativeOptionValue::Text("rising-edge".to_string()),
                ),
                ("word_size".to_string(), NativeOptionValue::Integer(16)),
                (
                    "frame_transitions".to_string(),
                    NativeOptionValue::Text("once-each-word".to_string()),
                ),
                (
                    "bit_align".to_string(),
                    NativeOptionValue::Text("left-aligned".to_string()),
                ),
                (
                    "bit_shift".to_string(),
                    NativeOptionValue::Text("none".to_string()),
                ),
                ("signed".to_string(), NativeOptionValue::Boolean(false)),
                (
                    "ws_polarity".to_string(),
                    NativeOptionValue::Text("left-high".to_string()),
                ),
            ]),
            primary_channel: 0,
        })
    }

    fn i2s_capture() -> CaptureData {
        transition_capture(
            "native-i2s-test",
            1_000_000,
            400,
            &[0, 0, 0],
            &i2s_edge_sets(),
        )
    }

    fn assert_i2s_output(output: &DecoderOutput) {
        assert_eq!(
            output
                .frames
                .iter()
                .flat_map(|frame| frame.channel_values.iter())
                .map(|value| value.value)
                .take(2)
                .collect::<Vec<_>>(),
            vec![0x1234, 0x5678]
        );
        assert!(output.frames.iter().all(|frame| !frame.texts.is_empty()));
    }

    fn can_edge_sets() -> Vec<(u8, Vec<u64>)> {
        vec![(
            0,
            vec![
                100, 130, 140, 160, 170, 200, 220, 270, 290, 300, 310, 320, 330, 350, 360, 370,
                380, 390, 400, 410, 430, 440, 450, 460, 470, 490, 500, 520, 530, 540, 550, 560,
                590, 610, 620, 630,
            ],
        )]
    }

    fn can_settings(decoder_id: &str, protocol_name: &str) -> AnalyzerDecodeSettings {
        let mut options = BTreeMap::from([
            ("sample_point".to_string(), NativeOptionValue::Integer(70)),
            ("inverted".to_string(), NativeOptionValue::Boolean(false)),
        ]);
        if decoder_id == "can_fd" {
            options.insert(
                "nominal_bitrate".to_string(),
                NativeOptionValue::Integer(100_000),
            );
            options.insert(
                "fast_bitrate".to_string(),
                NativeOptionValue::Integer(200_000),
            );
        } else {
            options.insert("bitrate".to_string(), NativeOptionValue::Integer(100_000));
        }
        AnalyzerDecodeSettings::Native(NativeDecodeSettings {
            decoder_id: decoder_id.to_string(),
            protocol_name: protocol_name.to_string(),
            channels: BTreeMap::from([("can_rx".to_string(), Some(0))]),
            options,
            primary_channel: 0,
        })
    }

    fn can_capture() -> CaptureData {
        transition_capture("native-can-test", 1_000_000, 840, &[1], &can_edge_sets())
    }

    fn assert_can_output(output: &DecoderOutput) {
        let values_for = |role: &str| {
            output
                .frames
                .iter()
                .flat_map(|frame| frame.channel_values.iter())
                .filter(|value| value.role == role)
                .map(|value| value.value)
                .collect::<Vec<_>>()
        };
        assert_eq!(values_for("Identifier"), vec![0x123]);
        assert_eq!(values_for("DLC"), vec![2]);
        assert_eq!(values_for("Data"), vec![0xA5, 0x5A]);
        assert_eq!(values_for("CRC"), vec![0x495C]);
        assert_eq!(values_for("ACK"), vec![1]);
    }

    fn lin_edge_sets() -> Vec<(u8, Vec<u64>)> {
        vec![(
            0,
            vec![
                100, 240, 260, 270, 280, 290, 300, 310, 320, 330, 340, 350, 360, 380, 390, 410,
                420, 440, 460, 470, 480, 490, 500, 520, 530, 540, 560, 580, 590, 600, 620, 630,
                640, 650, 660, 670, 680, 690, 710, 720, 740, 750,
            ],
        )]
    }

    fn lin_settings() -> AnalyzerDecodeSettings {
        AnalyzerDecodeSettings::Native(NativeDecodeSettings {
            decoder_id: "lin".to_string(),
            protocol_name: "LIN".to_string(),
            channels: BTreeMap::from([("rx".to_string(), Some(0))]),
            options: BTreeMap::from([
                ("baudrate".to_string(), NativeOptionValue::Integer(100_000)),
                ("version".to_string(), NativeOptionValue::Integer(2)),
            ]),
            primary_channel: 0,
        })
    }

    fn lin_capture() -> CaptureData {
        transition_capture("native-lin-test", 1_000_000, 860, &[1], &lin_edge_sets())
    }

    fn assert_lin_output(output: &DecoderOutput) {
        assert_eq!(output.protocol, "LIN");
        assert_eq!(
            output
                .frames
                .iter()
                .flat_map(|frame| frame.channel_values.iter())
                .filter(|value| value.role == "LIN")
                .map(|value| value.value)
                .collect::<Vec<_>>(),
            vec![0, 0x55, 0x12, 0xA5, 0x5A, 0x6D]
        );
    }

    fn parallel_settings() -> AnalyzerDecodeSettings {
        AnalyzerDecodeSettings::Native(NativeDecodeSettings {
            decoder_id: "parallel".to_string(),
            protocol_name: "Parallel".to_string(),
            channels: BTreeMap::from([
                ("d0".to_string(), Some(0)),
                ("d1".to_string(), Some(1)),
                ("clk".to_string(), Some(2)),
            ]),
            options: BTreeMap::from([
                (
                    "clock_edge".to_string(),
                    NativeOptionValue::Text("rising".to_string()),
                ),
                ("clock_state".to_string(), NativeOptionValue::Integer(0)),
                ("word_size".to_string(), NativeOptionValue::Integer(0)),
                (
                    "endianness".to_string(),
                    NativeOptionValue::Text("little".to_string()),
                ),
            ]),
            primary_channel: 0,
        })
    }

    #[test]
    fn legacy_backend_is_explicitly_discoverable() {
        let info = LegacyRustDecoder.info();
        assert_eq!(info.kind, DecoderBackendKind::LegacyRust);
        assert!(info.detail.contains("prefer"));
    }

    #[test]
    fn native_backend_fallback_info_keeps_external_protocol_catalog_visible() {
        let saleae = SaleaeNativeDecoder::new(
            "/definitely/missing/pxlogic-saleae-analyzer-sidecar",
            "/definitely/missing/saleae-runtime",
        )
        .info();
        assert_eq!(saleae.kind, DecoderBackendKind::SaleaeNative);
        assert!(!saleae.available);
        assert!(saleae.protocols.contains(&"LIN".to_string()));
        assert!(saleae.protocols.contains(&"Parallel".to_string()));
        assert!(!saleae.protocols.contains(&"CAN-FD".to_string()));

        let sigrok = SigrokNativeDecoder::new(
            "/definitely/missing/pxlogic-sigrok-sidecar",
            "/definitely/missing/sigrok-decoders",
        )
        .info();
        assert_eq!(sigrok.kind, DecoderBackendKind::SigrokNative);
        assert!(!sigrok.available);
        assert!(sigrok.protocols.contains(&"CAN-FD".to_string()));
        assert!(sigrok.protocols.contains(&"LIN".to_string()));
        assert!(sigrok.protocols.contains(&"Parallel".to_string()));
    }

    #[test]
    fn legacy_adapter_preserves_current_frame_shape() {
        let metadata = CaptureMetadata {
            version: 1,
            source_device: "decoder-contract-test".to_string(),
            sample_rate_hz: 1_000_000,
            channel_count: 8,
            enabled_channels: (0..8).collect(),
            unitsize: 1,
            sample_count: 32,
            captured_at: Utc::now(),
            labels: (0..8).map(|channel| format!("D{channel}")).collect(),
            trigger: None,
        };
        let capture = CaptureData {
            metadata,
            samples: vec![0; 32],
        };
        let output = LegacyRustDecoder
            .decode(
                &capture,
                &AnalyzerDecodeSettings::Spi(SpiDecodeSettings::default()),
            )
            .unwrap();
        assert_eq!(output.backend, DecoderBackendKind::LegacyRust);
        assert_eq!(output.protocol, "SPI");
    }

    #[test]
    fn external_settings_never_fall_back_to_legacy_rust() {
        let error = LegacyRustDecoder
            .decode(&i2s_capture(), &i2s_settings())
            .unwrap_err();
        assert!(error.to_string().contains("not implemented"));
    }

    #[test]
    fn generic_native_request_preserves_i2s_contract() {
        let request = build_native_sidecar_request(&i2s_capture(), &i2s_settings()).unwrap();
        let decoder = serde_json::to_value(request.decoder).unwrap();
        assert_eq!(decoder["protocol"], "i2s");
        assert_eq!(decoder["channels"]["sck"], 0);
        assert_eq!(decoder["channels"]["ws"], 1);
        assert_eq!(decoder["channels"]["sd"], 2);
        assert_eq!(decoder["options"]["word_size"], 16);
    }

    #[test]
    fn generic_native_request_preserves_can_contract_without_rust_protocol_logic() {
        let request =
            build_native_sidecar_request(&can_capture(), &can_settings("can", "CAN")).unwrap();
        let decoder = serde_json::to_value(request.decoder).unwrap();
        assert_eq!(decoder["protocol"], "can");
        assert_eq!(decoder["channels"]["can_rx"], 0);
        assert_eq!(decoder["options"]["bitrate"], 100_000);
        assert_eq!(decoder["options"]["sample_point"], 70);
        assert_eq!(decoder["options"]["inverted"], false);
    }

    #[test]
    fn generic_native_request_preserves_lin_contract_without_rust_protocol_logic() {
        let request = build_native_sidecar_request(&lin_capture(), &lin_settings()).unwrap();
        let decoder = serde_json::to_value(request.decoder).unwrap();
        assert_eq!(decoder["protocol"], "lin");
        assert_eq!(decoder["channels"]["rx"], 0);
        assert_eq!(decoder["options"]["baudrate"], 100_000);
        assert_eq!(decoder["options"]["version"], 2);
    }

    #[test]
    fn generic_native_request_preserves_parallel_contract_without_rust_protocol_logic() {
        let capture = transition_capture(
            "native-parallel-test",
            1_000_000,
            200,
            &[0, 0, 0],
            &[
                (0, vec![30, 70, 110, 150]),
                (1, vec![50, 90, 130, 170]),
                (2, vec![20, 25, 60, 65, 100, 105, 140, 145]),
            ],
        );
        let request = build_native_sidecar_request(&capture, &parallel_settings()).unwrap();
        let decoder = serde_json::to_value(request.decoder).unwrap();
        assert_eq!(decoder["protocol"], "parallel");
        assert_eq!(decoder["channels"]["d0"], 0);
        assert_eq!(decoder["channels"]["d1"], 1);
        assert_eq!(decoder["channels"]["clk"], 2);
        assert_eq!(decoder["options"]["clock_edge"], "rising");
        assert_eq!(decoder["options"]["clock_state"], 0);
    }

    #[test]
    fn sidecar_request_extracts_only_configured_spi_edges() {
        let capture = CaptureData {
            metadata: CaptureMetadata {
                version: 1,
                source_device: "saleae-request-test".to_string(),
                sample_rate_hz: 1_000_000,
                channel_count: 4,
                enabled_channels: (0..4).collect(),
                unitsize: 1,
                sample_count: 6,
                captured_at: Utc::now(),
                labels: (0..4).map(|channel| format!("D{channel}")).collect(),
                trigger: None,
            },
            samples: vec![0b1000, 0b1001, 0b1011, 0b0011, 0b0111, 0b0110],
        };
        let settings = SpiDecodeSettings {
            mosi_channel: Some(0),
            miso_channel: Some(1),
            clock_channel: 2,
            enable_channel: Some(3),
            ..SpiDecodeSettings::default()
        };

        let request =
            build_native_sidecar_request(&capture, &AnalyzerDecodeSettings::Spi(settings)).unwrap();
        assert_eq!(request.initial_levels, vec![0, 0, 0, 1]);
        let edges = request
            .edges
            .into_iter()
            .map(|edge| (edge.channel, edge.samples))
            .collect::<std::collections::BTreeMap<_, _>>();
        assert_eq!(edges.get(&0), Some(&vec![1, 5]));
        assert_eq!(edges.get(&1), Some(&vec![2]));
        assert_eq!(edges.get(&2), Some(&vec![4]));
        assert_eq!(edges.get(&3), Some(&vec![3]));
    }

    #[test]
    fn native_requests_cover_uart_and_i2c_without_unrelated_channels() {
        let (uart_capture, uart_settings) = uart_capture_and_settings();
        let uart = build_native_sidecar_request(&uart_capture, &uart_settings).unwrap();
        assert_eq!(uart.edges.len(), 1);
        assert_eq!(uart.edges[0].channel, 0);
        assert_eq!(uart.decoder.protocol, "uart");

        let (i2c_capture, i2c_settings) = i2c_capture_and_settings();
        let i2c = build_native_sidecar_request(&i2c_capture, &i2c_settings).unwrap();
        assert_eq!(
            i2c.edges
                .iter()
                .map(|edge| edge.channel)
                .collect::<Vec<_>>(),
            vec![0, 1]
        );
        assert_eq!(i2c.decoder.protocol, "i2c");
    }

    fn sparse_mode_zero_capture_and_settings() -> (SparseCaptureData, AnalyzerDecodeSettings) {
        const OFFSET: u64 = 49_000_000_000;
        let (_, settings) = mode_zero_capture_and_settings();
        let edge_sets = [
            (0u8, true, vec![15, 25, 35, 55, 65, 75]),
            (1u8, false, vec![25, 65]),
            (
                2u8,
                false,
                vec![
                    10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85,
                ],
            ),
            (3u8, true, vec![5, 90]),
        ];
        let capture = SparseCaptureData {
            metadata: CaptureMetadata {
                version: 1,
                source_device: "sparse-native-sidecar-test".to_string(),
                sample_rate_hz: 1_000_000,
                channel_count: 4,
                enabled_channels: (0..4).collect(),
                unitsize: 1,
                sample_count: 50_000_000_000,
                captured_at: Utc::now(),
                labels: (0..4).map(|channel| format!("D{channel}")).collect(),
                trigger: None,
            },
            channels: edge_sets
                .into_iter()
                .map(
                    |(channel, initial_high, transitions)| SparseDigitalChannel {
                        channel,
                        initial_high,
                        transitions: transitions
                            .into_iter()
                            .map(|sample| OFFSET + sample)
                            .collect(),
                    },
                )
                .collect(),
        };
        (capture, settings)
    }

    #[test]
    fn sparse_sidecar_request_preserves_transition_indexes_beyond_u32() {
        let (capture, settings) = sparse_mode_zero_capture_and_settings();
        let request = build_sparse_native_sidecar_request(&capture, &settings).unwrap();
        assert_eq!(request.sample_count, 50_000_000_000);
        assert_eq!(request.initial_levels, vec![1, 0, 0, 1]);
        assert_eq!(request.edges[0].samples[0], 49_000_000_015);
        assert_eq!(request.edges[2].samples.last(), Some(&49_000_000_085));
    }

    fn mode_zero_capture_and_settings() -> (CaptureData, AnalyzerDecodeSettings) {
        let initial_levels = [1u8, 0, 0, 1];
        let edge_sets = [
            (0u8, vec![15, 25, 35, 55, 65, 75]),
            (1u8, vec![25, 65]),
            (
                2u8,
                vec![
                    10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85,
                ],
            ),
            (3u8, vec![5, 90]),
        ];
        let mut word = initial_levels
            .iter()
            .enumerate()
            .fold(0u8, |word, (channel, level)| word | (*level << channel));
        let mut samples = Vec::with_capacity(100);
        for sample in 0..100u64 {
            for (channel, edges) in &edge_sets {
                if edges.contains(&sample) {
                    word ^= 1u8 << channel;
                }
            }
            samples.push(word);
        }
        let capture = CaptureData {
            metadata: CaptureMetadata {
                version: 1,
                source_device: "native-sidecar-test".to_string(),
                sample_rate_hz: 1_000_000,
                channel_count: 4,
                enabled_channels: (0..4).collect(),
                unitsize: 1,
                sample_count: 100,
                captured_at: Utc::now(),
                labels: (0..4).map(|channel| format!("D{channel}")).collect(),
                trigger: None,
            },
            samples,
        };
        let settings = AnalyzerDecodeSettings::Spi(SpiDecodeSettings {
            mosi_channel: Some(0),
            miso_channel: Some(1),
            clock_channel: 2,
            enable_channel: Some(3),
            enable_active_low: true,
            clock_polarity: false,
            clock_phase: false,
            bits_per_transfer: 8,
            msb_first: true,
        });
        (capture, settings)
    }

    fn assert_mode_zero_output(output: &DecoderOutput) {
        let result = output
            .frames
            .iter()
            .find(|frame| frame.row == "result")
            .unwrap();
        assert!(result
            .channel_values
            .iter()
            .any(|value| value.role == "MOSI" && value.value == 0xA5));
        assert!(result
            .channel_values
            .iter()
            .any(|value| value.role == "MISO" && value.value == 0x3C));
    }

    #[test]
    #[ignore = "requires PXLOGIC_SALEAE_SIDECAR and PXLOGIC_SALEAE_RUNTIME_ROOT"]
    fn saleae_native_sidecar_decodes_mode_zero_fixture() {
        let (capture, settings) = mode_zero_capture_and_settings();

        let output = SaleaeNativeDecoder::from_env()
            .unwrap()
            .decode(&capture, &settings)
            .unwrap();
        let result = output
            .frames
            .iter()
            .find(|frame| frame.row == "result")
            .unwrap();
        assert!(result.texts.contains(&"0xA5".to_string()));
        assert!(result.texts.contains(&"0x3C".to_string()));
        assert_mode_zero_output(&output);
    }

    #[test]
    #[ignore = "requires PXLOGIC_SALEAE_SIDECAR and PXLOGIC_SALEAE_RUNTIME_ROOT"]
    fn saleae_native_sidecar_decodes_sparse_fixture_beyond_u32() {
        let (capture, settings) = sparse_mode_zero_capture_and_settings();
        let output = SaleaeNativeDecoder::from_env()
            .unwrap()
            .decode_sparse(&capture, &settings)
            .unwrap();
        assert_eq!(output.backend, DecoderBackendKind::SaleaeNative);
        assert!(output.frames[0].start_sample > u64::from(u32::MAX));
        assert_mode_zero_output(&output);
    }

    #[test]
    #[ignore = "requires PXLOGIC_SALEAE_SIDECAR and PXLOGIC_SALEAE_RUNTIME_ROOT"]
    fn saleae_native_sidecar_decodes_uart_and_i2c_fixtures() {
        let (uart_capture, uart_settings) = uart_capture_and_settings();
        let uart = SaleaeNativeDecoder::from_env()
            .unwrap()
            .decode(&uart_capture, &uart_settings)
            .unwrap();
        assert_eq!(uart.protocol, "Async Serial");
        assert_eq!(uart.frames.len(), 1);
        assert_eq!(uart.frames[0].channel_values[0].value, 0xA5);

        let (i2c_capture, i2c_settings) = i2c_capture_and_settings();
        let i2c = SaleaeNativeDecoder::from_env()
            .unwrap()
            .decode(&i2c_capture, &i2c_settings)
            .unwrap();
        assert_eq!(i2c.protocol, "I2C");
        assert_eq!(
            i2c.frames
                .iter()
                .flat_map(|frame| frame.channel_values.iter())
                .map(|value| value.value)
                .collect::<Vec<_>>(),
            vec![0x50, 0xA5]
        );
        assert_eq!(i2c.frames.first().unwrap().row, "start");
        assert_eq!(i2c.frames.last().unwrap().row, "stop");
    }

    #[test]
    #[ignore = "requires PXLOGIC_SALEAE_SIDECAR and PXLOGIC_SALEAE_RUNTIME_ROOT"]
    fn saleae_uart_sparse_fixture_preserves_u64_indexes() {
        const OFFSET: u64 = 49_000_000_000;
        let capture = sparse_transition_capture(
            "saleae-uart-sparse-test",
            1_000_000,
            50_000_000_000,
            OFFSET,
            &[1],
            &[(0, vec![10, 20, 30, 40, 50, 70, 80, 90])],
        );
        let output = SaleaeNativeDecoder::from_env()
            .unwrap()
            .decode_sparse(
                &capture,
                &AnalyzerDecodeSettings::Uart(UartDecodeSettings {
                    channel: 0,
                    baud_rate: 100_000,
                    ..UartDecodeSettings::default()
                }),
            )
            .unwrap();
        assert_eq!(output.frames[0].channel_values[0].value, 0xA5);
        assert!(output.frames[0].start_sample > u64::from(u32::MAX));
    }

    #[test]
    #[ignore = "requires PXLOGIC_SALEAE_SIDECAR and PXLOGIC_SALEAE_RUNTIME_ROOT"]
    fn saleae_native_sidecar_decodes_i2s_packed_and_sparse_fixtures() {
        let decoder = SaleaeNativeDecoder::from_env().unwrap();
        let packed = decoder.decode(&i2s_capture(), &i2s_settings()).unwrap();
        assert_eq!(packed.protocol, "I2S / PCM");
        assert_i2s_output(&packed);

        const OFFSET: u64 = 49_000_000_000;
        let sparse = sparse_transition_capture(
            "saleae-i2s-sparse-test",
            1_000_000,
            50_000_000_000,
            OFFSET,
            &[0, 0, 0],
            &i2s_edge_sets(),
        );
        let output = decoder.decode_sparse(&sparse, &i2s_settings()).unwrap();
        assert_i2s_output(&output);
        assert!(output.frames[0].start_sample > u64::from(u32::MAX));
    }

    #[test]
    #[ignore = "requires PXLOGIC_SALEAE_SIDECAR and PXLOGIC_SALEAE_RUNTIME_ROOT"]
    fn saleae_native_sidecar_decodes_can_packed_and_sparse_fixtures() {
        let decoder = SaleaeNativeDecoder::from_env().unwrap();
        let packed = decoder
            .decode(&can_capture(), &can_settings("can", "CAN"))
            .unwrap();
        assert_eq!(packed.protocol, "CAN");
        assert_can_output(&packed);

        const OFFSET: u64 = 49_000_000_000;
        let sparse = sparse_transition_capture(
            "saleae-can-sparse-test",
            1_000_000,
            50_000_000_000,
            OFFSET,
            &[1],
            &can_edge_sets(),
        );
        let output = decoder
            .decode_sparse(&sparse, &can_settings("can", "CAN"))
            .unwrap();
        assert_can_output(&output);
        assert!(output.frames[0].start_sample > u64::from(u32::MAX));
    }

    #[test]
    #[ignore = "requires PXLOGIC_SALEAE_SIDECAR and PXLOGIC_SALEAE_RUNTIME_ROOT"]
    fn saleae_native_sidecar_decodes_lin_packed_and_sparse_fixtures() {
        let decoder = SaleaeNativeDecoder::from_env().unwrap();
        let packed = decoder.decode(&lin_capture(), &lin_settings()).unwrap();
        assert_lin_output(&packed);

        const OFFSET: u64 = 49_000_000_000;
        let sparse = sparse_transition_capture(
            "saleae-lin-sparse-test",
            1_000_000,
            50_000_000_000,
            OFFSET,
            &[1],
            &lin_edge_sets(),
        );
        let output = decoder.decode_sparse(&sparse, &lin_settings()).unwrap();
        assert_lin_output(&output);
        assert!(output.frames[0].start_sample > u64::from(u32::MAX));
    }

    #[test]
    #[ignore = "requires PXLOGIC_SIGROK_SIDECAR and PXLOGIC_SIGROK_DECODER_ROOT"]
    fn sigrok_native_sidecar_decodes_mode_zero_fixture() {
        let (capture, settings) = mode_zero_capture_and_settings();
        let output = SigrokNativeDecoder::from_env()
            .unwrap()
            .decode(&capture, &settings)
            .unwrap();
        assert_eq!(output.backend, DecoderBackendKind::SigrokNative);
        assert_mode_zero_output(&output);
    }

    #[test]
    #[ignore = "requires PXLOGIC_SIGROK_SIDECAR, PXLOGIC_SIGROK_DECODER_ROOT, and PXLOGIC_SIGROK_PYTHON_DECODER_ROOT"]
    fn sigrok_native_sidecar_catalog_enumerates_pxview_c_and_python_decoders() {
        let probe = SigrokNativeDecoder::from_env()
            .unwrap()
            .probe_with_catalog(true)
            .unwrap();

        assert!(probe.available);
        assert!(probe.catalog_included);
        assert!(probe.c_decoder_count >= 200);
        assert!(probe.python_decoder_count >= 200);

        let has = |id: &str, kind: &str| {
            probe.decoder_catalog.iter().any(|item| {
                item.id.as_deref() == Some(id) && item.kind.as_deref() == Some(kind)
            })
        };
        assert!(has("qspi_c", "c"));
        assert!(has("modbus_c", "c"));
        assert!(has("usb_power_delivery", "python"));
        assert!(has("jtag", "python"));
        assert!(probe.decoder_catalog.iter().any(|item| {
            item.id.as_deref() == Some("spi_c")
                && item.runner_status.as_deref() == Some("verified_sparse_c")
        }));
    }

    #[test]
    #[ignore = "requires PXLOGIC_SIGROK_SIDECAR and PXLOGIC_SIGROK_DECODER_ROOT"]
    fn sigrok_native_sidecar_decodes_sparse_fixture_beyond_u32() {
        let (capture, settings) = sparse_mode_zero_capture_and_settings();
        let output = SigrokNativeDecoder::from_env()
            .unwrap()
            .decode_sparse(&capture, &settings)
            .unwrap();
        assert_eq!(output.backend, DecoderBackendKind::SigrokNative);
        assert!(output.frames[0].start_sample > u64::from(u32::MAX));
        assert_mode_zero_output(&output);
    }

    #[test]
    #[ignore = "requires PXLOGIC_SIGROK_SIDECAR and PXLOGIC_SIGROK_DECODER_ROOT"]
    fn sigrok_native_sidecar_decodes_uart_and_i2c_fixtures() {
        let (uart_capture, uart_settings) = uart_capture_and_settings();
        let uart = SigrokNativeDecoder::from_env()
            .unwrap()
            .decode(&uart_capture, &uart_settings)
            .unwrap();
        assert_eq!(uart.protocol, "UART");
        assert_eq!(uart.frames.len(), 1);
        assert_eq!(uart.frames[0].channel_values[0].value, 0xA5);

        let (i2c_capture, i2c_settings) = i2c_capture_and_settings();
        let i2c = SigrokNativeDecoder::from_env()
            .unwrap()
            .decode(&i2c_capture, &i2c_settings)
            .unwrap();
        assert_eq!(i2c.protocol, "I2C");
        assert_eq!(
            i2c.frames
                .iter()
                .map(|frame| frame.channel_values[0].value)
                .collect::<Vec<_>>(),
            vec![0x50, 0xA5]
        );
    }

    #[test]
    #[ignore = "requires PXLOGIC_SIGROK_SIDECAR and PXLOGIC_SIGROK_DECODER_ROOT"]
    fn sigrok_uart_and_i2c_sparse_fixtures_preserve_u64_indexes() {
        const OFFSET: u64 = 49_000_000_000;
        let uart_capture = sparse_transition_capture(
            "sigrok-uart-sparse-test",
            1_000_000,
            50_000_000_000,
            OFFSET,
            &[1],
            &[(0, vec![10, 20, 30, 40, 50, 70, 80, 90])],
        );
        let uart = SigrokNativeDecoder::from_env()
            .unwrap()
            .decode_sparse(
                &uart_capture,
                &AnalyzerDecodeSettings::Uart(UartDecodeSettings {
                    channel: 0,
                    baud_rate: 100_000,
                    inverted: false,
                    ..UartDecodeSettings::default()
                }),
            )
            .unwrap();
        assert_eq!(uart.frames[0].channel_values[0].value, 0xA5);
        assert!(uart.frames[0].start_sample > u64::from(u32::MAX));

        let i2c_capture = sparse_transition_capture(
            "sigrok-i2c-sparse-test",
            1_000_000,
            50_000_000_000,
            OFFSET,
            &[1, 1],
            &i2c_edge_sets(),
        );
        let i2c = SigrokNativeDecoder::from_env()
            .unwrap()
            .decode_sparse(
                &i2c_capture,
                &AnalyzerDecodeSettings::I2c(I2cDecodeSettings {
                    scl_channel: 0,
                    sda_channel: 1,
                }),
            )
            .unwrap();
        assert_eq!(i2c.frames[0].channel_values[0].value, 0x50);
        assert!(i2c.frames[0].start_sample > u64::from(u32::MAX));
    }

    #[test]
    #[ignore = "requires PXLOGIC_SIGROK_SIDECAR and PXLOGIC_SIGROK_DECODER_ROOT"]
    fn sigrok_native_sidecar_decodes_i2s_packed_and_sparse_fixtures() {
        let decoder = SigrokNativeDecoder::from_env().unwrap();
        let packed = decoder.decode(&i2s_capture(), &i2s_settings()).unwrap();
        assert_eq!(packed.protocol, "I2S");
        assert_i2s_output(&packed);

        const OFFSET: u64 = 49_000_000_000;
        let sparse = sparse_transition_capture(
            "sigrok-i2s-sparse-test",
            1_000_000,
            50_000_000_000,
            OFFSET,
            &[0, 0, 0],
            &i2s_edge_sets(),
        );
        let output = decoder.decode_sparse(&sparse, &i2s_settings()).unwrap();
        assert_i2s_output(&output);
        assert!(output.frames[0].start_sample > u64::from(u32::MAX));
    }

    #[test]
    #[ignore = "requires PXLOGIC_SIGROK_SIDECAR and PXLOGIC_SIGROK_DECODER_ROOT"]
    fn sigrok_native_sidecar_decodes_can_and_can_fd_packed_and_sparse_fixtures() {
        let decoder = SigrokNativeDecoder::from_env().unwrap();
        for (decoder_id, protocol_name) in [("can", "CAN"), ("can_fd", "CAN-FD")] {
            let settings = can_settings(decoder_id, protocol_name);
            let packed = decoder.decode(&can_capture(), &settings).unwrap();
            assert_eq!(packed.protocol, protocol_name);
            assert_can_output(&packed);

            const OFFSET: u64 = 49_000_000_000;
            let sparse = sparse_transition_capture(
                "sigrok-can-sparse-test",
                1_000_000,
                50_000_000_000,
                OFFSET,
                &[1],
                &can_edge_sets(),
            );
            let output = decoder.decode_sparse(&sparse, &settings).unwrap();
            assert_can_output(&output);
            assert!(output.frames[0].start_sample > u64::from(u32::MAX));
        }
    }

    #[test]
    #[ignore = "requires PXLOGIC_SIGROK_SIDECAR and PXLOGIC_SIGROK_DECODER_ROOT"]
    fn sigrok_native_sidecar_decodes_lin_packed_and_sparse_fixtures() {
        let decoder = SigrokNativeDecoder::from_env().unwrap();
        let packed = decoder.decode(&lin_capture(), &lin_settings()).unwrap();
        assert_lin_output(&packed);

        const OFFSET: u64 = 49_000_000_000;
        let sparse = sparse_transition_capture(
            "sigrok-lin-sparse-test",
            1_000_000,
            50_000_000_000,
            OFFSET,
            &[1],
            &lin_edge_sets(),
        );
        let output = decoder.decode_sparse(&sparse, &lin_settings()).unwrap();
        assert_lin_output(&output);
        assert!(output.frames[0].start_sample > u64::from(u32::MAX));
    }
}
