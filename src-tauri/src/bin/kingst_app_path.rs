//! Reproduce the client's capture path for the Kingst driver.
//!
//! The client captures, hands the metadata to the graph session and then hands
//! over the samples. `capture metadata is invalid` came out of that second step,
//! so this binary runs the same three calls without the UI.
//!
//! It deliberately asks for 8 channels, which is what the client's session
//! defaults to, as well as the device's full width.
//!
//! ```text
//! cargo run -p sigpilot-desktop --bin kingst_app_path
//! ```

use sigpilot_core::kingst_la2016;
use sigpilot_core::models::{
    CaptureMode, CaptureSettings, CaptureTriggerKind, ExternalTriggerMode,
};
use sigpilot_graph::GraphSession;

fn settings_for(device_id: &str, channel_count: u8) -> CaptureSettings {
    CaptureSettings {
        device_id: device_id.to_string(),
        sample_rate_hz: 1_000_000,
        channel_count,
        enabled_channels: Vec::new(),
        duration_ms: 10,
        buffer_size_mb: 1024,
        decode_cross: false,
        threshold_volts: 1.5,
        external_trigger_mode: ExternalTriggerMode::Close,
        mode: CaptureMode::Buffer,
        trigger_enabled: false,
        trigger_channel: 0,
        trigger_kind: CaptureTriggerKind::Rising,
        trigger_high_mask: 0,
        trigger_low_mask: 0,
        trigger_position_percent: 0,
        glitch_filter_enabled: false,
        clock_edge: false,
        trigger_out_enabled: false,
    }
}

fn main() {
    let driver = kingst_la2016::KingstLa2016Driver::new();
    let devices = match sigpilot_core::device::DeviceDriver::list_devices(&driver) {
        Ok(devices) => devices,
        Err(error) => {
            eprintln!("list_devices failed: {error}");
            std::process::exit(1);
        }
    };
    let Some(device) = devices.first() else {
        eprintln!("no Kingst device found");
        std::process::exit(1);
    };
    let id = device.id.clone();

    println!("=== client capture path ===");
    println!("device: {}", id);
    println!();

    // The client's session defaults to 8 channels, and clamps that to the
    // device's `max_channels`. Both cases have to work.
    //
    // Each iteration feeds the previous capture's `source_device` back in as the
    // device id, which is what the client does after every capture. That round
    // trip is what broke: a friendly name stored there made the session stop
    // resolving and every later capture failed with "no driver claims this
    // device".
    let mut device_id = id.clone();
    for channel_count in [8u8, 16] {
        println!("--- capture with channel_count = {channel_count}, device_id = {device_id} ---");
        let settings = settings_for(&device_id, channel_count);
        let mut diagnostics = |event: sigpilot_core::models::DiagnosticEvent| {
            println!("  [{:?}] {}", event.level, event.message);
        };
        let mut progress = |_update: sigpilot_core::models::CaptureProgress| {};

        let capture = match kingst_la2016::capture(
            &device_id,
            &settings,
            &std::sync::atomic::AtomicBool::new(false),
            &mut diagnostics,
            &mut progress,
        ) {
            Ok(capture) => capture,
            Err(error) => {
                println!("  capture failed: {error}");
                println!();
                return;
            }
        };

        println!(
            "  captured: channels={} unitsize={} samples={} bytes={}",
            capture.metadata.channel_count,
            capture.metadata.unitsize,
            capture.metadata.sample_count,
            capture.samples.len()
        );
        println!("  source_device = {}", capture.metadata.source_device);

        // Exactly what `start_capture` does with the result.
        let session = GraphSession::default();
        match session.begin_capture(capture.metadata.clone()) {
            Ok(()) => println!("  begin_capture: ok"),
            Err(error) => {
                println!("  begin_capture FAILED: {error}");
                println!();
                return;
            }
        }
        match session.finish_capture(capture.clone()) {
            Ok(()) => println!("  finish_capture: ok"),
            Err(error) => {
                println!("  finish_capture FAILED: {error}");
                println!();
                return;
            }
        }

        device_id = capture.metadata.source_device.clone();
        println!();
    }
}
