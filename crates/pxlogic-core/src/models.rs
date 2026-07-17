use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum DeviceKind {
    Fake,
    Usb,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DeviceInfo {
    pub id: String,
    pub kind: DeviceKind,
    pub vid: u16,
    pub pid: u16,
    pub bus: Option<u8>,
    pub address: Option<u8>,
    pub label: String,
    pub ready: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CaptureSettings {
    pub device_id: String,
    pub sample_rate_hz: u64,
    pub channel_count: u8,
    pub duration_ms: u64,
    pub buffer_size_mb: u64,
    pub decode_cross: bool,
    pub threshold_volts: f64,
    pub mode: CaptureMode,
}

impl Default for CaptureSettings {
    fn default() -> Self {
        Self {
            device_id: "fake:pxlogic-demo".to_string(),
            sample_rate_hz: 25_000_000,
            channel_count: 16,
            duration_ms: 10,
            buffer_size_mb: 16,
            decode_cross: true,
            threshold_volts: 2.0,
            mode: CaptureMode::Stream,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum CaptureMode {
    Buffer,
    Stream,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CaptureMetadata {
    pub version: u32,
    pub source_device: String,
    pub sample_rate_hz: u64,
    pub channel_count: u8,
    pub unitsize: u8,
    pub sample_count: u64,
    pub captured_at: DateTime<Utc>,
    pub labels: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CaptureProgress {
    pub bytes_read: u64,
    pub bytes_expected: u64,
    pub samples_read: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DiagnosticEvent {
    pub phase: String,
    pub level: DiagnosticLevel,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum DiagnosticLevel {
    Info,
    Warn,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CaptureData {
    pub metadata: CaptureMetadata,
    pub samples: Vec<u8>,
}

#[derive(Debug, Clone)]
pub struct Bitstreams {
    pub reset: Vec<u8>,
    pub main: Vec<u8>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum ExportFormat {
    Pxcap,
    Sr,
    Vcd,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum WaveformSource {
    CurrentCapture,
}
