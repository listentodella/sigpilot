pub mod capture;
pub mod decode;
pub mod error;
pub mod fake;
pub mod models;
pub mod protocol;
pub mod transport;

#[cfg(feature = "rusb-transport")]
pub mod rusb_backend;

pub use capture::{
    build_capture_register_script, capture_channel_mask, decode_cross_data,
    decode_cross_data_with_map, generate_sample_words, generate_sample_words_with_count,
    gpio_timing_for_samplerate, pxview_capture_transfer_size, sample_count_from_duration,
    sample_count_from_settings, supported_samplerates, unitsize_for_channel_count, CaptureProfile,
    RegisterWrite,
};
pub use decode::{decode_uart, DecodedFrame, UartDecodeSettings};
pub use error::{CoreError, Result};
pub use fake::FakeBackend;
pub use models::{
    Bitstreams, CaptureData, CaptureMetadata, CaptureMode, CaptureProgress, CaptureSettings,
    DeviceInfo, DeviceKind, DiagnosticEvent, DiagnosticLevel, ExportFormat, WaveformSource,
};
pub use transport::{CaptureBackend, CaptureCancel};

#[cfg(feature = "rusb-transport")]
pub use rusb_backend::RusbBackend;
