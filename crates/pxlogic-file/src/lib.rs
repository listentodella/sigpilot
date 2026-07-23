use std::{
    fs::File,
    io::{Read, Seek, SeekFrom, Write},
    path::Path,
};

use chrono::Utc;
use pxlogic_core::{
    capture::read_sample_word, resolve_enabled_channels, CaptureData, CaptureMetadata,
    SparseCaptureData, SparseDigitalChannel,
};
use serde::Deserialize;
use thiserror::Error;
use zip::{write::SimpleFileOptions, CompressionMethod, ZipArchive, ZipWriter};

pub type Result<T> = std::result::Result<T, FileError>;

#[derive(Debug, Error)]
pub enum FileError {
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("zip error: {0}")]
    Zip(#[from] zip::result::ZipError),
    #[error("capture has invalid sample metadata")]
    InvalidCapture,
    #[error("invalid Saleae capture: {0}")]
    InvalidSaleae(String),
}

#[derive(Debug, Deserialize)]
struct SaleaeTransitionManifest {
    format: String,
    source: String,
    sample_rate_hz: u64,
    channel_count: u8,
    duration_seconds: f64,
    sample_count: u64,
    channels: Vec<SaleaeTransitionChannel>,
}

#[derive(Debug, Deserialize)]
struct SaleaeTransitionChannel {
    channel: u8,
    file: String,
}

pub fn open_saleae_transition_manifest(path: impl AsRef<Path>) -> Result<SparseCaptureData> {
    let path = path.as_ref();
    let manifest: SaleaeTransitionManifest = serde_json::from_reader(File::open(path)?)?;
    if manifest.format != "pxlogic.saleae-transition.v1"
        || !(1..=32).contains(&manifest.channel_count)
        || manifest.sample_rate_hz == 0
        || manifest.sample_count == 0
        || !manifest.duration_seconds.is_finite()
        || manifest.duration_seconds <= 0.0
    {
        return Err(FileError::InvalidSaleae(
            "transition manifest metadata is invalid".to_string(),
        ));
    }
    let directory = path.parent().unwrap_or_else(|| Path::new("."));
    let mut channels = manifest
        .channels
        .iter()
        .map(|channel| {
            if channel.channel >= manifest.channel_count {
                return Err(FileError::InvalidSaleae(format!(
                    "D{} is outside the declared channel count",
                    channel.channel
                )));
            }
            read_saleae_digital_binary(
                directory.join(&channel.file),
                channel.channel,
                manifest.sample_rate_hz,
                manifest.sample_count,
                manifest.duration_seconds,
            )
        })
        .collect::<Result<Vec<_>>>()?;
    channels.sort_by_key(|channel| channel.channel);
    if channels.is_empty()
        || channels
            .windows(2)
            .any(|pair| pair[0].channel == pair[1].channel)
    {
        return Err(FileError::InvalidSaleae(
            "transition manifest has no channels or duplicate channels".to_string(),
        ));
    }

    let enabled_channels = channels.iter().map(|channel| channel.channel).collect();
    let unitsize = match manifest.channel_count {
        1..=8 => 1,
        9..=16 => 2,
        17..=32 => 4,
        _ => unreachable!(),
    };
    let metadata = CaptureMetadata {
        version: 1,
        source_device: format!("Saleae {}", manifest.source),
        sample_rate_hz: manifest.sample_rate_hz,
        channel_count: manifest.channel_count,
        enabled_channels,
        unitsize,
        sample_count: manifest.sample_count,
        captured_at: Utc::now(),
        labels: (0..manifest.channel_count)
            .map(|channel| format!("D{channel}"))
            .collect(),
        trigger: None,
    };
    Ok(SparseCaptureData { metadata, channels })
}

fn read_saleae_digital_binary(
    path: impl AsRef<Path>,
    channel: u8,
    sample_rate_hz: u64,
    sample_count: u64,
    manifest_duration: f64,
) -> Result<SparseDigitalChannel> {
    let path = path.as_ref();
    let mut file = File::open(path)?;
    let mut header = [0u8; 44];
    file.read_exact(&mut header)?;
    if &header[..8] != b"<SALEAE>"
        || u32::from_le_bytes(header[8..12].try_into().expect("header width")) != 0
        || u32::from_le_bytes(header[12..16].try_into().expect("header width")) != 0
    {
        return Err(FileError::InvalidSaleae(format!(
            "{} is not an initial-version digital binary",
            path.display()
        )));
    }
    let initial_high = u32::from_le_bytes(header[16..20].try_into().expect("header width")) != 0;
    let duration_seconds = f64::from_le_bytes(header[28..36].try_into().expect("header width"));
    let transition_count = u64::from_le_bytes(header[36..44].try_into().expect("header width"));
    if !duration_seconds.is_finite()
        || duration_seconds <= 0.0
        || (duration_seconds - manifest_duration).abs() > (1.0 / sample_rate_hz as f64).max(1e-9)
    {
        return Err(FileError::InvalidSaleae(format!(
            "{} duration does not match the manifest",
            path.display()
        )));
    }
    let transition_bytes = transition_count
        .checked_mul(8)
        .ok_or_else(|| FileError::InvalidSaleae("transition byte count overflowed".to_string()))?;
    let expected_size = 44u64
        .checked_add(transition_bytes)
        .ok_or_else(|| FileError::InvalidSaleae("digital binary size overflowed".to_string()))?;
    if file.seek(SeekFrom::End(0))? != expected_size {
        return Err(FileError::InvalidSaleae(format!(
            "{} has an invalid transition payload length",
            path.display()
        )));
    }
    file.seek(SeekFrom::Start(44))?;
    let capacity = usize::try_from(transition_count).map_err(|_| {
        FileError::InvalidSaleae("transition count exceeds this platform".to_string())
    })?;
    let mut transitions = Vec::with_capacity(capacity);
    let mut time_bytes = [0u8; 8];
    for _ in 0..transition_count {
        file.read_exact(&mut time_bytes)?;
        let time = f64::from_le_bytes(time_bytes);
        if !time.is_finite() || time < 0.0 || time > duration_seconds {
            return Err(FileError::InvalidSaleae(format!(
                "{} contains an invalid transition time",
                path.display()
            )));
        }
        let sample = (time * sample_rate_hz as f64).round() as u64;
        if sample >= sample_count
            || transitions
                .last()
                .is_some_and(|previous| *previous >= sample)
        {
            return Err(FileError::InvalidSaleae(format!(
                "{} transitions are not strictly increasing sample indexes",
                path.display()
            )));
        }
        transitions.push(sample);
    }
    Ok(SparseDigitalChannel {
        channel,
        initial_high,
        transitions,
    })
}

pub fn save_pxcap(path: impl AsRef<Path>, capture: &CaptureData) -> Result<()> {
    let file = File::create(path)?;
    let mut zip = ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);

    zip.start_file("metadata.json", options)?;
    zip.write_all(&serde_json::to_vec_pretty(&capture.metadata)?)?;
    zip.start_file("samples.bin", options)?;
    zip.write_all(&capture.samples)?;
    zip.finish()?;
    Ok(())
}

pub fn open_pxcap(path: impl AsRef<Path>) -> Result<CaptureData> {
    let file = File::open(path)?;
    let mut zip = ZipArchive::new(file)?;

    let mut metadata_json = String::new();
    zip.by_name("metadata.json")?
        .read_to_string(&mut metadata_json)?;
    let mut metadata: CaptureMetadata = serde_json::from_str(&metadata_json)?;
    metadata.enabled_channels =
        resolve_enabled_channels(metadata.channel_count, &metadata.enabled_channels)
            .map_err(|_| FileError::InvalidCapture)?;

    let mut samples = Vec::new();
    zip.by_name("samples.bin")?.read_to_end(&mut samples)?;

    Ok(CaptureData { metadata, samples })
}

pub fn export_sr(path: impl AsRef<Path>, capture: &CaptureData) -> Result<()> {
    let enabled_channels = export_channels(&capture.metadata)?;
    let file = File::create(path)?;
    let mut zip = ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);

    zip.start_file("version", options)?;
    zip.write_all(b"2")?;
    zip.start_file("metadata", options)?;
    zip.write_all(
        render_sr_metadata_for_channels(&capture.metadata, &enabled_channels).as_bytes(),
    )?;
    zip.start_file("logic-1", options)?;
    zip.write_all(&capture.samples)?;
    zip.finish()?;
    Ok(())
}

pub fn render_sr_metadata(metadata: &CaptureMetadata) -> String {
    let enabled_channels =
        resolve_enabled_channels(metadata.channel_count, &metadata.enabled_channels)
            .unwrap_or_else(|_| (0..metadata.channel_count).collect());
    render_sr_metadata_for_channels(metadata, &enabled_channels)
}

fn render_sr_metadata_for_channels(metadata: &CaptureMetadata, enabled_channels: &[u8]) -> String {
    let mut output = String::new();
    output.push_str("[global]\n");
    output.push_str("sigrok version=0.5.2\n\n");
    output.push_str("[device 1]\n");
    output.push_str("capturefile=logic-1\n");
    output.push_str(&format!("total probes={}\n", metadata.channel_count));
    output.push_str(&format!("samplerate={}\n", metadata.sample_rate_hz));
    output.push_str(&format!("unitsize={}\n", metadata.unitsize));
    // PXView's srzip.c keeps the physical probe count, but only emits probe
    // entries for enabled channels. Probe numbers remain physical indices.
    for &index in enabled_channels {
        let label = metadata
            .labels
            .get(index as usize)
            .cloned()
            .unwrap_or_else(|| format!("D{index}"));
        output.push_str(&format!("probe{}={}\n", index + 1, label));
    }
    output
}

pub fn export_vcd(path: impl AsRef<Path>, capture: &CaptureData) -> Result<()> {
    let mut file = File::create(path)?;
    let metadata = &capture.metadata;
    if metadata.unitsize == 0 {
        return Err(FileError::InvalidCapture);
    }
    let enabled_channels = export_channels(metadata)?;

    writeln!(file, "$date")?;
    writeln!(file, "  {}", metadata.captured_at)?;
    writeln!(file, "$end")?;
    writeln!(file, "$version PXLogic Studio 0.1 $end")?;
    writeln!(file, "$timescale 1 ns $end")?;
    writeln!(file, "$scope module logic $end")?;
    for &channel in &enabled_channels {
        let id = vcd_identifier(channel);
        let label = metadata
            .labels
            .get(channel as usize)
            .cloned()
            .unwrap_or_else(|| format!("D{channel}"));
        writeln!(file, "$var wire 1 {id} {label} $end")?;
    }
    writeln!(file, "$upscope $end")?;
    writeln!(file, "$enddefinitions $end")?;
    writeln!(file, "#0")?;

    let mut previous = u32::MAX;
    for sample in 0..metadata.sample_count {
        let word = read_sample_word(&capture.samples, metadata.unitsize, sample)
            .ok_or(FileError::InvalidCapture)?;
        if sample == 0 {
            dump_vcd_word(&mut file, &enabled_channels, word, 0)?;
        } else {
            let changed = previous ^ word;
            if changed != 0 {
                let timestamp_ns =
                    sample.saturating_mul(1_000_000_000) / metadata.sample_rate_hz.max(1);
                writeln!(file, "#{timestamp_ns}")?;
                dump_vcd_word(&mut file, &enabled_channels, word, changed)?;
            }
        }
        previous = word;
    }
    Ok(())
}

fn export_channels(metadata: &CaptureMetadata) -> Result<Vec<u8>> {
    resolve_enabled_channels(metadata.channel_count, &metadata.enabled_channels)
        .map_err(|_| FileError::InvalidCapture)
}

fn dump_vcd_word(
    file: &mut File,
    enabled_channels: &[u8],
    word: u32,
    changed_mask: u32,
) -> Result<()> {
    for &channel in enabled_channels {
        let bit = 1u32 << channel;
        if changed_mask != 0 && changed_mask & bit == 0 {
            continue;
        }
        let value = if word & bit == 0 { '0' } else { '1' };
        writeln!(file, "{value}{}", vcd_identifier(channel))?;
    }
    Ok(())
}

fn vcd_identifier(channel: u8) -> String {
    let mut n = channel as usize;
    let mut chars = Vec::new();
    loop {
        chars.push((33 + (n % 94)) as u8 as char);
        n /= 94;
        if n == 0 {
            break;
        }
    }
    chars.into_iter().collect()
}

#[cfg(test)]
mod tests {
    use std::{fs, path::PathBuf};

    use pxlogic_core::{
        capture::generate_sample_words, CaptureSettings, CaptureTriggerKind, CaptureTriggerMetadata,
    };

    use super::*;

    #[test]
    fn pxcap_round_trips_capture() {
        let mut capture = generate_sample_words(&CaptureSettings {
            sample_rate_hz: 10_000,
            duration_ms: 10,
            channel_count: 16,
            ..CaptureSettings::default()
        })
        .unwrap();
        capture.metadata.trigger = Some(CaptureTriggerMetadata {
            sample_index: 50,
            channel: 0,
            kind: CaptureTriggerKind::Rising,
        });
        let path = temp_file("roundtrip.pxcap");
        save_pxcap(&path, &capture).unwrap();
        let opened = open_pxcap(&path).unwrap();
        assert_eq!(opened.metadata.sample_count, capture.metadata.sample_count);
        assert_eq!(
            opened.metadata.enabled_channels,
            capture.metadata.enabled_channels
        );
        assert_eq!(opened.metadata.trigger, capture.metadata.trigger);
        assert_eq!(opened.samples, capture.samples);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn old_metadata_without_trigger_remains_readable() {
        let metadata: CaptureMetadata = serde_json::from_str(
            r#"{
                "version": 1,
                "source_device": "legacy",
                "sample_rate_hz": 1000000,
                "channel_count": 1,
                "unitsize": 1,
                "sample_count": 4,
                "captured_at": "2026-07-23T00:00:00Z",
                "labels": ["D0"]
            }"#,
        )
        .unwrap();
        assert_eq!(metadata.trigger, None);
        assert!(metadata.enabled_channels.is_empty());
    }

    #[test]
    fn open_pxcap_restores_legacy_contiguous_enabled_channels() {
        let capture = generate_sample_words(&CaptureSettings {
            sample_rate_hz: 10_000,
            duration_ms: 10,
            channel_count: 4,
            ..CaptureSettings::default()
        })
        .unwrap();
        let path = temp_file("legacy-enabled-channels.pxcap");
        save_pxcap(&path, &capture).unwrap();

        let file = File::open(&path).unwrap();
        let mut archive = ZipArchive::new(file).unwrap();
        let mut metadata_json = String::new();
        archive
            .by_name("metadata.json")
            .unwrap()
            .read_to_string(&mut metadata_json)
            .unwrap();
        drop(archive);
        let mut metadata: serde_json::Value = serde_json::from_str(&metadata_json).unwrap();
        metadata.as_object_mut().unwrap().remove("enabled_channels");

        let legacy_path = temp_file("legacy-enabled-channels-rewritten.pxcap");
        let legacy_file = File::create(&legacy_path).unwrap();
        let mut zip = ZipWriter::new(legacy_file);
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
        zip.start_file("metadata.json", options).unwrap();
        zip.write_all(&serde_json::to_vec_pretty(&metadata).unwrap())
            .unwrap();
        zip.start_file("samples.bin", options).unwrap();
        zip.write_all(&capture.samples).unwrap();
        zip.finish().unwrap();

        let opened = open_pxcap(&legacy_path).unwrap();
        assert_eq!(opened.metadata.enabled_channels, vec![0, 1, 2, 3]);
        let _ = fs::remove_file(path);
        let _ = fs::remove_file(legacy_path);
    }

    #[test]
    fn sr_metadata_contains_sigrok_fields() {
        let capture = generate_sample_words(&CaptureSettings {
            channel_count: 16,
            ..CaptureSettings::default()
        })
        .unwrap();
        let rendered = render_sr_metadata(&capture.metadata);
        assert!(rendered.contains("capturefile=logic-1"));
        assert!(rendered.contains("probe1=D0"));
        assert!(rendered.contains("unitsize=2"));
    }

    #[test]
    fn sparse_sr_export_uses_physical_probe_numbers_without_inventing_channels() {
        let capture = sparse_capture();
        let path = temp_file("sparse.sr");
        export_sr(&path, &capture).unwrap();

        let file = File::open(&path).unwrap();
        let mut archive = ZipArchive::new(file).unwrap();
        let mut metadata = String::new();
        archive
            .by_name("metadata")
            .unwrap()
            .read_to_string(&mut metadata)
            .unwrap();
        assert!(metadata.contains("total probes=5"));
        assert!(metadata.contains("probe1=D0"));
        assert!(metadata.contains("probe5=D4"));
        assert!(!metadata.lines().any(|line| line.starts_with("probe2=")));

        let mut samples = Vec::new();
        archive
            .by_name("logic-1")
            .unwrap()
            .read_to_end(&mut samples)
            .unwrap();
        assert_eq!(samples, capture.samples);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn exports_vcd_file() {
        let capture = generate_sample_words(&CaptureSettings {
            sample_rate_hz: 10_000,
            duration_ms: 10,
            channel_count: 4,
            ..CaptureSettings::default()
        })
        .unwrap();
        let path = temp_file("capture.vcd");
        export_vcd(&path, &capture).unwrap();
        let text = fs::read_to_string(&path).unwrap();
        assert!(text.contains("$timescale 1 ns $end"));
        assert!(text.contains("$var wire 1 ! D0 $end"));
        let _ = fs::remove_file(path);
    }

    #[test]
    fn sparse_vcd_export_declares_and_updates_only_enabled_physical_channels() {
        let capture = sparse_capture();
        let path = temp_file("sparse.vcd");
        export_vcd(&path, &capture).unwrap();
        let text = fs::read_to_string(&path).unwrap();

        assert!(text.contains("$var wire 1 ! D0 $end"));
        assert!(text.contains("$var wire 1 % D4 $end"));
        assert!(!text.contains("$var wire 1 \" D1 $end"));
        assert!(text.contains("#0\n0!\n1%"));
        assert!(text.contains("#100\n1!\n0%"));
        assert!(text.contains("#200\n1%"));
        let _ = fs::remove_file(path);
    }

    fn sparse_capture() -> CaptureData {
        let mut capture = generate_sample_words(&CaptureSettings {
            sample_rate_hz: 10_000_000,
            duration_ms: 1,
            channel_count: 5,
            enabled_channels: vec![0, 4],
            ..CaptureSettings::default()
        })
        .unwrap();
        capture.metadata.sample_count = 3;
        capture.samples = vec![0x10, 0x01, 0x11];
        capture
    }

    #[test]
    fn opens_saleae_transition_manifest_without_expanding_samples() {
        let directory =
            std::env::temp_dir().join(format!("pxlogic-saleae-manifest-{}", std::process::id()));
        fs::create_dir_all(&directory).unwrap();
        let binary_path = directory.join("digital_3.bin");
        let mut binary = Vec::new();
        binary.extend_from_slice(b"<SALEAE>");
        binary.extend_from_slice(&0u32.to_le_bytes());
        binary.extend_from_slice(&0u32.to_le_bytes());
        binary.extend_from_slice(&1u32.to_le_bytes());
        binary.extend_from_slice(&0.0f64.to_le_bytes());
        binary.extend_from_slice(&0.001f64.to_le_bytes());
        binary.extend_from_slice(&2u64.to_le_bytes());
        binary.extend_from_slice(&0.0001f64.to_le_bytes());
        binary.extend_from_slice(&0.0004f64.to_le_bytes());
        fs::write(&binary_path, binary).unwrap();
        let manifest_path = directory.join("manifest.json");
        fs::write(
            &manifest_path,
            serde_json::to_vec(&serde_json::json!({
                "format": "pxlogic.saleae-transition.v1",
                "source": "fixture.sal",
                "sample_rate_hz": 1_000_000,
                "channel_count": 8,
                "duration_seconds": 0.001,
                "sample_count": 1_000,
                "channels": [{ "channel": 3, "file": "digital_3.bin" }]
            }))
            .unwrap(),
        )
        .unwrap();

        let capture = open_saleae_transition_manifest(&manifest_path).unwrap();
        assert_eq!(capture.metadata.sample_count, 1_000);
        assert_eq!(capture.metadata.enabled_channels, vec![3]);
        assert!(capture.channels[0].initial_high);
        assert_eq!(capture.channels[0].transitions, vec![100, 400]);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    #[ignore = "requires PXLOGIC_SALEAE_MANIFEST from the native GraphServer sidecar"]
    fn opens_native_saleae_graphserver_export() {
        let manifest = std::env::var_os("PXLOGIC_SALEAE_MANIFEST")
            .map(PathBuf::from)
            .expect("PXLOGIC_SALEAE_MANIFEST");
        let capture = open_saleae_transition_manifest(manifest).unwrap();
        assert!(capture.metadata.sample_count > u64::from(u32::MAX));
        assert!(!capture.channels.is_empty());
        assert!(capture
            .channels
            .iter()
            .all(|channel| channel.transitions.windows(2).all(|pair| pair[0] < pair[1])));
    }

    fn temp_file(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("pxlogic-file-{}-{name}", std::process::id()))
    }
}
