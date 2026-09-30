//! Exercise the Kingst LA series driver against real hardware.
//!
//! ```text
//! cargo run -p sigpilot-core --bin kingst_smoke
//! ```
//!
//! Set `SIGPILOT_KINGST_FIRMWARE_DIR` to the directory holding the vendor
//! firmware extracted from KingstVIS (`kingst-la-01a2.fw`,
//! `kingst-la2016-fpga.bitstream`, …).

use std::time::Instant;

use sigpilot_core::device::{DeviceDriver, DeviceRegistry};
use sigpilot_core::kingst_la2016::{firmware_dir, KingstLa2016Driver};
use sigpilot_core::models::{CaptureMode, CaptureSettings, CaptureTriggerKind, ExternalTriggerMode};

fn main() {
    let driver = KingstLa2016Driver::new();

    println!("=== Kingst LA series smoke test ===");
    println!(
        "firmware dir: {}",
        firmware_dir()
            .map(|path| path.display().to_string())
            .unwrap_or_else(|| "(not found — set SIGPILOT_KINGST_FIRMWARE_DIR)".to_string())
    );
    println!();

    // 1. Enumeration.
    let started = Instant::now();
    let devices = match driver.list_devices() {
        Ok(devices) => devices,
        Err(error) => {
            eprintln!("list_devices failed: {error}");
            std::process::exit(1);
        }
    };
    println!(
        "--- enumeration ({:.0?}) --- {} device(s)",
        started.elapsed(),
        devices.len()
    );
    for device in &devices {
        println!("  id          {}", device.id);
        println!("  label       {}", device.label);
        println!("  vid:pid     {:04x}:{:04x}", device.vid, device.pid);
        println!("  bus:addr    {:?}:{:?}", device.bus, device.address);
        println!("  usb speed   {:?}", device.usb_speed);
        println!("  ready       {}", device.ready);
        if let Some(error) = &device.probe_error {
            println!("  probe error {error}");
        }
    }

    let Some(device) = devices.first() else {
        println!("\nNo Kingst device found.");
        return;
    };
    let id = device.id.clone();
    println!();

    // 2. Capabilities (needs the MCU firmware running).
    match driver.capabilities(&id) {
        Ok(capabilities) => {
            println!("--- capabilities ---");
            println!("  model        {:?}", capabilities.profile_model);
            println!("  vendor       {:?}", capabilities.profile_vendor);
            println!("  channels     {}", capabilities.max_channels);
            println!(
                "  max rate     {} MHz",
                capabilities.default_sample_rate_hz / 1_000_000
            );
            println!("  rates        {:?}", capabilities.sample_rates);
            println!("  thresholds   {:?}", capabilities.threshold_volts);
            for mode in &capabilities.channel_modes {
                println!(
                    "  mode {:<18} {}ch  {} MHz  depth {}  stream={}",
                    mode.id,
                    mode.channels,
                    mode.max_sample_rate_hz / 1_000_000,
                    mode.default_sample_limit,
                    mode.stream
                );
            }
        }
        Err(error) => {
            println!("--- capabilities --- unavailable before prepare: {error}");
        }
    }
    println!();

    // 3. prepare() — MCU firmware, EEPROM identify, FPGA bitstream, enable.
    println!("--- prepare ---");
    let started = Instant::now();
    let mut events = Vec::new();
    let mut sink = |event: sigpilot_core::models::DiagnosticEvent| {
        println!("  [{:?}] {}", event.level, event.message);
        events.push(event);
    };
    match driver.prepare(&id, &mut sink) {
        Ok(()) => println!("  prepare OK in {:.1?}", started.elapsed()),
        Err(error) => {
            eprintln!("  prepare FAILED: {error}");
            std::process::exit(1);
        }
    }
    drop(sink);
    println!("  {} diagnostic event(s)", events.len());
    println!();

    // 4. Re-enumerate: the device id changes when the FX2 re-enumerates.
    let after = driver.list_devices().unwrap_or_default();
    println!("--- after prepare --- {} device(s)", after.len());
    for device in &after {
        println!("  {}  {}", device.id, device.label);
    }
    println!();

    // 5. Idempotency: a second prepare must be cheap and must not re-flash.
    println!("--- prepare again (should be fast) ---");
    let started = Instant::now();
    let mut sink = |event: sigpilot_core::models::DiagnosticEvent| {
        println!("  [{:?}] {}", event.level, event.message);
    };
    match driver.prepare(&id, &mut sink) {
        Ok(()) => println!("  second prepare OK in {:.1?}", started.elapsed()),
        Err(error) => println!("  second prepare failed: {error}"),
    }
    println!();

    // 6. Registry integration: the driver must route its own scheme and not
    //    collide with the PXLogic driver's `usb` scheme.
    println!("--- registry integration ---");
    let registry = DeviceRegistry::with_builtin_drivers();
    println!("  registered drivers: {}", registry.drivers().len());
    for descriptor in registry.drivers().iter().map(|driver| driver.descriptor()) {
        println!(
            "    {:<14} schemes={:?} isolation={:?}",
            descriptor.driver_id, descriptor.id_schemes, descriptor.isolation
        );
    }
    println!(
        "  registry sees {} device(s) total",
        registry.list_devices().len()
    );
    println!();

    // 7. Capture, converted into SigPilot's packed sample format.
    //
    //    Run it twice with different input thresholds. Nothing is wired to the
    //    probe inputs on a bench setup, so the absolute values prove little —
    //    but if the two thresholds disagree, the analog front-end, the
    //    threshold DAC and the sample memory are all demonstrably live.
    println!("--- capture ---");
    let mut per_threshold = Vec::new();
    for threshold in [3.3f64, 1.2] {
        let settings = CaptureSettings {
            device_id: id.clone(),
            sample_rate_hz: 1_000_000,
            channel_count: 16,
            enabled_channels: Vec::new(),
            duration_ms: 20,
            buffer_size_mb: 1024,
            decode_cross: false,
            threshold_volts: threshold,
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
        };

        let started = Instant::now();
        // The raw download size reveals how well the hardware's run-length
        // compression did, which is a useful signal about whether the FPGA
        // actually sampled: constant input compresses hard.
        let mut raw_bytes = 0u64;
        let mut diagnostics = |event: sigpilot_core::models::DiagnosticEvent| {
            println!("    [prepare {:?}] {}", event.level, event.message);
        };
        let mut progress = |update: sigpilot_core::models::CaptureProgress| {
            raw_bytes = update.sample_memory_bytes;
        };
        let capture = match sigpilot_core::kingst_la2016::capture(
            &id,
            &settings,
            &std::sync::atomic::AtomicBool::new(false),
            &mut diagnostics,
            &mut progress,
        ) {
            Ok(capture) => capture,
            Err(error) => {
                eprintln!("  capture at {threshold} V FAILED: {error}");
                std::process::exit(1);
            }
        };
        drop(progress);

        let unit = capture.metadata.unitsize as usize;
        let mut words = std::collections::BTreeMap::new();
        let mut transitions = 0u64;
        let mut previous: Option<u32> = None;
        for word in capture.samples.chunks_exact(unit) {
            let value = word
                .iter()
                .enumerate()
                .fold(0u32, |acc, (index, byte)| acc | (u32::from(*byte) << (8 * index)));
            *words.entry(value).or_insert(0u64) += 1;
            if let Some(previous) = previous {
                if previous != value {
                    transitions += 1;
                }
            }
            previous = Some(value);
        }

        let requested = settings.sample_rate_hz * settings.duration_ms / 1000;
        println!(
            "  threshold {threshold} V: {} samples in {:.1?}, {} distinct, {} transitions",
            capture.metadata.sample_count,
            started.elapsed(),
            words.len(),
            transitions
        );
        println!(
            "    requested {requested}  payload {} bytes  consistent {}",
            capture.samples.len(),
            capture.samples.len() == capture.metadata.sample_count as usize * unit
        );
        println!("    source {:?}  rate {} Hz", capture.metadata.source_device, capture.metadata.sample_rate_hz);
        let average_repeat = if raw_bytes > 0 {
            // Each 16-byte transfer carries 5 packets; each packet is a value
            // plus a repeat count.
            let packets = raw_bytes / 16 * 5;
            if packets > 0 {
                capture.metadata.sample_count as f64 / packets as f64
            } else {
                0.0
            }
        } else {
            0.0
        };
        println!(
            "    raw download {raw_bytes} bytes (~{average_repeat:.1} samples/packet; 255 means fully compressed)"
        );
        let mut ranked: Vec<_> = words.iter().collect();
        ranked.sort_by(|a, b| b.1.cmp(a.1));
        for (value, count) in ranked.iter().take(4) {
            println!("      {value:#06x} x {count}");
        }
        per_threshold.push((threshold, words.len(), transitions));
    }

    println!();
    if per_threshold.len() == 2 {
        let (low_v, low_distinct, low_transitions) = per_threshold[1];
        let (high_v, high_distinct, high_transitions) = per_threshold[0];
        let differs = low_distinct != high_distinct || low_transitions != high_transitions;
        println!(
            "  threshold sensitivity: {high_v}V -> {high_distinct} distinct / {high_transitions} transitions, \
             {low_v}V -> {low_distinct} distinct / {low_transitions} transitions"
        );
        println!(
            "  verdict: {}",
            if differs {
                "the two thresholds disagree, so the analog front-end and sample memory are live"
            } else {
                "both thresholds read the same — the inputs are probably undriven; \
                 this does not by itself prove or disprove the sample path"
            }
        );
    }
}
