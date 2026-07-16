use std::{
    fs::File,
    io::{Read, Write},
    path::Path,
};

use pxlogic_core::{capture::read_sample_word, CaptureData, CaptureMetadata};
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
    let metadata: CaptureMetadata = serde_json::from_str(&metadata_json)?;

    let mut samples = Vec::new();
    zip.by_name("samples.bin")?.read_to_end(&mut samples)?;

    Ok(CaptureData { metadata, samples })
}

pub fn export_sr(path: impl AsRef<Path>, capture: &CaptureData) -> Result<()> {
    let file = File::create(path)?;
    let mut zip = ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);

    zip.start_file("version", options)?;
    zip.write_all(b"2")?;
    zip.start_file("metadata", options)?;
    zip.write_all(render_sr_metadata(&capture.metadata).as_bytes())?;
    zip.start_file("logic-1", options)?;
    zip.write_all(&capture.samples)?;
    zip.finish()?;
    Ok(())
}

pub fn render_sr_metadata(metadata: &CaptureMetadata) -> String {
    let mut output = String::new();
    output.push_str("[global]\n");
    output.push_str("sigrok version=0.5.2\n\n");
    output.push_str("[device 1]\n");
    output.push_str("capturefile=logic-1\n");
    output.push_str(&format!("total probes={}\n", metadata.channel_count));
    output.push_str(&format!("samplerate={}\n", metadata.sample_rate_hz));
    output.push_str(&format!("unitsize={}\n", metadata.unitsize));
    for index in 0..metadata.channel_count {
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

    writeln!(file, "$date")?;
    writeln!(file, "  {}", metadata.captured_at)?;
    writeln!(file, "$end")?;
    writeln!(file, "$version PXLogic Studio 0.1 $end")?;
    writeln!(file, "$timescale 1 ns $end")?;
    writeln!(file, "$scope module logic $end")?;
    for channel in 0..metadata.channel_count {
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
            dump_vcd_word(&mut file, metadata.channel_count, word, 0)?;
        } else {
            let changed = previous ^ word;
            if changed != 0 {
                let timestamp_ns =
                    sample.saturating_mul(1_000_000_000) / metadata.sample_rate_hz.max(1);
                writeln!(file, "#{timestamp_ns}")?;
                dump_vcd_word(&mut file, metadata.channel_count, word, changed)?;
            }
        }
        previous = word;
    }
    Ok(())
}

fn dump_vcd_word(file: &mut File, channel_count: u8, word: u32, changed_mask: u32) -> Result<()> {
    for channel in 0..channel_count {
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

    use pxlogic_core::{capture::generate_sample_words, CaptureSettings};

    use super::*;

    #[test]
    fn pxcap_round_trips_capture() {
        let capture = generate_sample_words(&CaptureSettings {
            sample_rate_hz: 10_000,
            duration_ms: 10,
            channel_count: 16,
            ..CaptureSettings::default()
        })
        .unwrap();
        let path = temp_file("roundtrip.pxcap");
        save_pxcap(&path, &capture).unwrap();
        let opened = open_pxcap(&path).unwrap();
        assert_eq!(opened.metadata.sample_count, capture.metadata.sample_count);
        assert_eq!(opened.samples, capture.samples);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn sr_metadata_contains_sigrok_fields() {
        let capture = generate_sample_words(&CaptureSettings::default()).unwrap();
        let rendered = render_sr_metadata(&capture.metadata);
        assert!(rendered.contains("capturefile=logic-1"));
        assert!(rendered.contains("probe1=D0"));
        assert!(rendered.contains("unitsize=2"));
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

    fn temp_file(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("pxlogic-file-{}-{name}", std::process::id()))
    }
}
