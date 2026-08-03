use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::Command;

const MANIFEST_FORMAT: &str = "pxlogic.saleae-transition.v1";
const DIGITAL_HEADER_SIZE: u64 = 44;

#[derive(Debug, Clone, Default)]
pub struct ReaderOptions {
    pub sidecar: Option<PathBuf>,
    pub runtime_root: Option<PathBuf>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SalCapture {
    pub source: String,
    pub sample_rate_hz: u64,
    pub sample_count: u64,
    pub channel_count: u8,
    pub duration_seconds: f64,
    pub channels: Vec<DigitalChannel>,
    pub session: SessionMetadata,
}

impl SalCapture {
    pub fn channel(&self, index: u32) -> Option<&DigitalChannel> {
        self.channels
            .iter()
            .find(|channel| u32::from(channel.index) == index)
    }

    pub fn compatible_analyzers(&self) -> Vec<&AnalyzerConfig> {
        self.session
            .analyzers
            .iter()
            .filter(|analyzer| analyzer.is_supported() && analyzer.is_compatible(self))
            .collect()
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct DigitalChannel {
    pub index: u8,
    pub initial_high: bool,
    pub transitions: Vec<u64>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct SessionMetadata {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub labels: Vec<String>,
    #[serde(default)]
    pub analyzers: Vec<AnalyzerConfig>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct AnalyzerConfig {
    #[serde(rename = "type")]
    pub analyzer_type: String,
    pub name: String,
    #[serde(default)]
    pub settings: Vec<AnalyzerSetting>,
}

impl AnalyzerConfig {
    pub fn is_supported(&self) -> bool {
        super::default_plugin(&self.analyzer_type).is_ok()
    }

    pub fn is_compatible(&self, capture: &SalCapture) -> bool {
        self.settings.iter().all(|setting| {
            if setting.kind() != Some("Channel") {
                return true;
            }
            setting
                .channel()
                .is_none_or(|channel| capture.channel(channel).is_some())
        })
    }

    pub fn setting(&self, title: &str) -> Option<&AnalyzerSetting> {
        self.settings
            .iter()
            .find(|setting| setting.title.eq_ignore_ascii_case(title))
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct AnalyzerSetting {
    pub title: String,
    pub setting: Value,
}

impl AnalyzerSetting {
    pub fn kind(&self) -> Option<&str> {
        self.setting.get("type")?.as_str()
    }

    pub fn channel(&self) -> Option<u32> {
        u32::try_from(self.setting.get("value")?.as_u64()?).ok()
    }

    pub fn number(&self) -> Option<f64> {
        self.setting.get("value")?.as_f64()
    }
}

#[derive(Debug, Deserialize)]
struct TransitionManifest {
    format: String,
    source: String,
    sample_rate_hz: u64,
    channel_count: u8,
    duration_seconds: f64,
    sample_count: u64,
    channels: Vec<ManifestChannel>,
    #[serde(default)]
    session: SessionMetadata,
}

#[derive(Debug, Deserialize)]
struct ManifestChannel {
    channel: u8,
    file: String,
}

pub fn open(path: impl AsRef<Path>, options: &ReaderOptions) -> Result<SalCapture, String> {
    let path = path.as_ref();
    if !path.is_file() {
        return Err(format!("capture does not exist: {}", path.display()));
    }

    let sidecar = options
        .sidecar
        .clone()
        .or_else(locate_sidecar)
        .ok_or_else(|| {
            "Saleae Graph sidecar was not found; pass --sidecar or SALEAE_GRAPH_SIDECAR".to_owned()
        })?;
    let runtime_root = options
        .runtime_root
        .clone()
        .or_else(locate_runtime_root)
        .ok_or_else(|| {
            "Logic runtime was not found; pass --runtime-root or SALEAE_LOGIC_RUNTIME_ROOT"
                .to_owned()
        })?;
    validate_sidecar(&sidecar)?;
    validate_runtime_root(&runtime_root)?;

    let output_dir = tempfile::Builder::new()
        .prefix("saleae-runtime-sal-")
        .tempdir()
        .map_err(|error| format!("could not create conversion directory: {error}"))?;
    let conversion = Command::new(&sidecar)
        .arg("--runtime-root")
        .arg(&runtime_root)
        .arg("--convert-sal")
        .arg(path)
        .arg(output_dir.path())
        .output()
        .map_err(|error| format!("failed to start {}: {error}", sidecar.display()))?;
    if !conversion.status.success() {
        let detail = String::from_utf8_lossy(&conversion.stderr)
            .trim()
            .to_owned();
        return Err(if detail.is_empty() {
            format!("Saleae Graph conversion failed with {}", conversion.status)
        } else {
            format!("Saleae Graph conversion failed: {detail}")
        });
    }

    open_transition_manifest(output_dir.path().join("manifest.json"))
}

pub fn open_transition_manifest(path: impl AsRef<Path>) -> Result<SalCapture, String> {
    let path = path.as_ref();
    let file =
        File::open(path).map_err(|error| format!("could not open {}: {error}", path.display()))?;
    let manifest: TransitionManifest = serde_json::from_reader(file)
        .map_err(|error| format!("invalid {}: {error}", path.display()))?;
    if manifest.format != MANIFEST_FORMAT
        || manifest.sample_rate_hz == 0
        || manifest.sample_rate_hz > u64::from(u32::MAX)
        || manifest.sample_count == 0
        || manifest.channel_count == 0
        || !manifest.duration_seconds.is_finite()
        || manifest.duration_seconds <= 0.0
    {
        return Err("transition manifest metadata is invalid".to_owned());
    }

    let directory = path
        .parent()
        .ok_or_else(|| "transition manifest has no parent directory".to_owned())?;
    let mut seen = HashSet::new();
    let mut channels = Vec::with_capacity(manifest.channels.len());
    for channel in manifest.channels {
        if channel.channel >= manifest.channel_count
            || !seen.insert(channel.channel)
            || !is_safe_relative_file(&channel.file)
        {
            return Err("transition manifest contains an invalid channel".to_owned());
        }
        channels.push(read_digital_binary(
            directory.join(channel.file),
            channel.channel,
            manifest.sample_rate_hz,
            manifest.sample_count,
            manifest.duration_seconds,
        )?);
    }
    if channels.is_empty() {
        return Err("transition manifest contains no digital channels".to_owned());
    }
    channels.sort_by_key(|channel| channel.index);

    Ok(SalCapture {
        source: manifest.source,
        sample_rate_hz: manifest.sample_rate_hz,
        sample_count: manifest.sample_count,
        channel_count: manifest.channel_count,
        duration_seconds: manifest.duration_seconds,
        channels,
        session: manifest.session,
    })
}

fn read_digital_binary(
    path: impl AsRef<Path>,
    index: u8,
    sample_rate_hz: u64,
    sample_count: u64,
    manifest_duration: f64,
) -> Result<DigitalChannel, String> {
    let path = path.as_ref();
    let mut file =
        File::open(path).map_err(|error| format!("could not open {}: {error}", path.display()))?;
    let mut header = [0u8; DIGITAL_HEADER_SIZE as usize];
    file.read_exact(&mut header)
        .map_err(|error| format!("could not read {} header: {error}", path.display()))?;
    if &header[..8] != b"<SALEAE>"
        || read_u32(&header[8..12]) != 0
        || read_u32(&header[12..16]) != 0
    {
        return Err(format!(
            "{} is not an initial-version Saleae digital binary",
            path.display()
        ));
    }

    let initial_high = read_u32(&header[16..20]) != 0;
    let duration_seconds = read_f64(&header[28..36]);
    let transition_count = read_u64(&header[36..44]);
    let tolerance = (1.0 / sample_rate_hz as f64).max(1e-9);
    if !duration_seconds.is_finite()
        || duration_seconds <= 0.0
        || (duration_seconds - manifest_duration).abs() > tolerance
    {
        return Err(format!(
            "{} duration does not match the manifest",
            path.display()
        ));
    }

    let expected_size = DIGITAL_HEADER_SIZE
        .checked_add(
            transition_count
                .checked_mul(8)
                .ok_or_else(|| "transition byte count overflowed".to_owned())?,
        )
        .ok_or_else(|| "digital binary size overflowed".to_owned())?;
    let actual_size = file
        .seek(SeekFrom::End(0))
        .map_err(|error| format!("could not inspect {}: {error}", path.display()))?;
    if actual_size != expected_size {
        return Err(format!("{} has an invalid payload length", path.display()));
    }
    file.seek(SeekFrom::Start(DIGITAL_HEADER_SIZE))
        .map_err(|error| format!("could not seek {}: {error}", path.display()))?;

    let capacity = usize::try_from(transition_count)
        .map_err(|_| "transition count exceeds this platform".to_owned())?;
    let mut transitions = Vec::with_capacity(capacity);
    let mut time_bytes = [0u8; 8];
    for _ in 0..transition_count {
        file.read_exact(&mut time_bytes)
            .map_err(|error| format!("could not read {} transitions: {error}", path.display()))?;
        let time = f64::from_le_bytes(time_bytes);
        if !time.is_finite() || time < 0.0 || time > duration_seconds {
            return Err(format!(
                "{} contains an invalid transition time",
                path.display()
            ));
        }
        let sample = (time * sample_rate_hz as f64).round() as u64;
        if sample == 0
            || sample >= sample_count
            || transitions
                .last()
                .is_some_and(|previous| *previous >= sample)
        {
            return Err(format!(
                "{} transitions are not strictly increasing sample indexes",
                path.display()
            ));
        }
        transitions.push(sample);
    }

    Ok(DigitalChannel {
        index,
        initial_high,
        transitions,
    })
}

fn read_u32(bytes: &[u8]) -> u32 {
    u32::from_le_bytes(bytes.try_into().expect("u32 width"))
}

fn read_u64(bytes: &[u8]) -> u64 {
    u64::from_le_bytes(bytes.try_into().expect("u64 width"))
}

fn read_f64(bytes: &[u8]) -> f64 {
    f64::from_le_bytes(bytes.try_into().expect("f64 width"))
}

fn is_safe_relative_file(path: &str) -> bool {
    let path = Path::new(path);
    !path.as_os_str().is_empty()
        && !path.is_absolute()
        && path
            .components()
            .all(|component| matches!(component, std::path::Component::Normal(_)))
}

fn validate_sidecar(path: &Path) -> Result<(), String> {
    if path.is_file() {
        Ok(())
    } else {
        Err(format!(
            "Saleae Graph sidecar does not exist: {}",
            path.display()
        ))
    }
}

fn validate_runtime_root(path: &Path) -> Result<(), String> {
    if path.join("libAnalyzer.dylib").is_file()
        && path.join("libgraph_server_shared.dylib").is_file()
        && path.join("pythonlibs").is_dir()
    {
        Ok(())
    } else {
        Err(format!("Logic runtime is incomplete: {}", path.display()))
    }
}

fn locate_sidecar() -> Option<PathBuf> {
    for variable in ["SALEAE_GRAPH_SIDECAR", "PXLOGIC_SALEAE_GRAPH_SIDECAR"] {
        if let Some(path) = std::env::var_os(variable).map(PathBuf::from) {
            if path.is_file() {
                return Some(path);
            }
        }
    }

    let mut candidates =
        relative_candidates("target/native/saleae-graph-sidecar/pxlogic-saleae-graph-sidecar");
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        candidates.push(
            home.join(
                "work/pxlogic/target/native/saleae-graph-sidecar/pxlogic-saleae-graph-sidecar",
            ),
        );
    }
    candidates.into_iter().find(|path| path.is_file())
}

fn locate_runtime_root() -> Option<PathBuf> {
    for variable in ["SALEAE_LOGIC_RUNTIME_ROOT", "PXLOGIC_SALEAE_RUNTIME_ROOT"] {
        if let Some(path) = std::env::var_os(variable).map(PathBuf::from) {
            if validate_runtime_root(&path).is_ok() {
                return Some(path);
            }
        }
    }

    let suffix = "Logic.app/Contents/Resources/macos-arm64";
    let mut candidates = relative_candidates(suffix);
    candidates.push(PathBuf::from(format!("/Applications/{suffix}")));
    candidates.push(PathBuf::from(
        "/Applications/Saleae Logic.app/Contents/Resources/macos-arm64",
    ));
    candidates
        .into_iter()
        .find(|path| validate_runtime_root(path).is_ok())
}

fn relative_candidates(suffix: &str) -> Vec<PathBuf> {
    let mut bases = Vec::new();
    if let Ok(current) = std::env::current_dir() {
        bases.extend(current.ancestors().map(Path::to_path_buf));
    }
    if let Ok(executable) = std::env::current_exe() {
        bases.extend(executable.ancestors().map(Path::to_path_buf));
    }
    bases.into_iter().map(|base| base.join(suffix)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn parses_public_digital_binary() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("digital.bin");
        let mut file = File::create(&path).unwrap();
        file.write_all(b"<SALEAE>").unwrap();
        file.write_all(&0u32.to_le_bytes()).unwrap();
        file.write_all(&0u32.to_le_bytes()).unwrap();
        file.write_all(&1u32.to_le_bytes()).unwrap();
        file.write_all(&0.0f64.to_le_bytes()).unwrap();
        file.write_all(&1.0f64.to_le_bytes()).unwrap();
        file.write_all(&2u64.to_le_bytes()).unwrap();
        file.write_all(&0.25f64.to_le_bytes()).unwrap();
        file.write_all(&0.75f64.to_le_bytes()).unwrap();
        drop(file);

        let channel = read_digital_binary(path, 3, 100, 101, 1.0).unwrap();
        assert_eq!(channel.index, 3);
        assert!(channel.initial_high);
        assert_eq!(channel.transitions, [25, 75]);
    }

    #[test]
    #[ignore = "requires Logic.app and the Saleae Graph sidecar"]
    fn opens_supplied_i2c_sal_capture() {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../assets/demo-i2c.sal");
        let capture = open(path, &ReaderOptions::default()).unwrap();
        assert_eq!(capture.sample_rate_hz, 250_000_000);
        assert_eq!(capture.channels.len(), 2);
        assert_eq!(capture.compatible_analyzers().len(), 1);
        assert_eq!(capture.compatible_analyzers()[0].analyzer_type, "I2C");
    }
}
