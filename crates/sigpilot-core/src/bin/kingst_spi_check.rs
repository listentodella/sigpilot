//! Verify the Kingst capture path against a real signal.
//!
//! Sweeps the input threshold, because a threshold set at the signal's own
//! high level reads as constant — then reports per-channel activity and runs
//! SigPilot's own SPI decoder over the result. A capture that decodes to
//! sensible bytes proves the whole chain end to end: analog front-end,
//! threshold DAC, FPGA sampling, sample memory, the bulk download and the
//! run-length expansion.
//!
//! ```text
//! cargo run -p sigpilot-core --bin kingst_spi_check
//! ```
//!
//! Override with `SIGPILOT_SPI_RATE_HZ` and `SIGPILOT_SPI_MS`.

use std::time::Instant;

use sigpilot_core::decode::{decode_spi, SpiDecodeSettings};
use sigpilot_core::kingst_la2016;
use sigpilot_core::models::{
    CaptureData, CaptureMode, CaptureSettings, CaptureTriggerKind, ExternalTriggerMode,
};

const CHANNELS: u8 = 16;
/// Thresholds to probe, lowest first. The hardware accepts 0.4 V to 4.0 V.
const THRESHOLDS: [f64; 6] = [0.8, 1.2, 1.5, 1.8, 2.5, 3.3];

fn env_u64(name: &str, default: u64) -> u64 {
    std::env::var(name)
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(default)
}

fn settings_for(device_id: &str, rate: u64, duration_ms: u64, threshold: f64) -> CaptureSettings {
    CaptureSettings {
        device_id: device_id.to_string(),
        sample_rate_hz: rate,
        channel_count: CHANNELS,
        enabled_channels: Vec::new(),
        duration_ms,
        buffer_size_mb: 1024,
        decode_cross: false,
        threshold_volts: threshold,
        external_trigger_mode: ExternalTriggerMode::Close,
        // `SIGPILOT_SPI_STREAM=1` exercises the streaming path instead of the
        // capture-to-memory one.
        mode: if std::env::var_os("SIGPILOT_SPI_STREAM").is_some() {
            CaptureMode::Stream
        } else {
            CaptureMode::Buffer
        },
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

fn run_capture(id: &str, settings: &CaptureSettings) -> Option<CaptureData> {
    let mut diagnostics = |event: sigpilot_core::models::DiagnosticEvent| {
        if std::env::var_os("SIGPILOT_SPI_VERBOSE").is_some() {
            println!("    [{:?}] {}", event.level, event.message);
        }
    };
    let mut progress = |_update: sigpilot_core::models::CaptureProgress| {};
    let cancel = std::sync::atomic::AtomicBool::new(false);
    match kingst_la2016::capture(id, settings, &cancel, &mut diagnostics, &mut progress) {
        Ok(capture) => Some(capture),
        Err(error) => {
            eprintln!("  capture failed: {error}");
            None
        }
    }
}

fn main() {
    let rate = env_u64("SIGPILOT_SPI_RATE_HZ", 200_000_000);
    let duration_ms = env_u64("SIGPILOT_SPI_MS", 20);

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

    println!("=== Kingst signal verification ===");
    println!("device:  {}  ({})", id, device.label);
    println!("capture: {} MHz x {} ms", rate / 1_000_000, duration_ms);
    println!();

    // Phase 0: is anything reaching the FPGA at all?
    //
    // `REG_PIN_STATE` reports the live input levels. Polling it separates a
    // wiring problem from a capture problem before any of the capture
    // machinery is involved: if the register never changes while the signal is
    // running, the signal is not getting to the device.
    println!("--- live pin state (3 s of polling) ---");
    let mut seen = std::collections::BTreeSet::new();
    let mut ever_changed = 0u16;
    let mut previous: Option<u16> = None;
    let deadline = Instant::now() + std::time::Duration::from_secs(3);
    while Instant::now() < deadline {
        match kingst_la2016::read_live_pin_state(&id) {
            Ok(state) => {
                seen.insert(state);
                if let Some(previous) = previous {
                    ever_changed |= previous ^ state;
                }
                previous = Some(state);
            }
            Err(error) => {
                eprintln!("  live pin read failed: {error}");
                break;
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    println!(
        "  {} distinct readings, {} of them non-zero",
        seen.len(),
        seen.iter().filter(|value| **value != 0).count()
    );
    println!(
        "  bits that ever changed: {:#06x} ({})",
        ever_changed,
        if ever_changed == 0 {
            "none".to_string()
        } else {
            (0..16)
                .filter(|channel| ever_changed & (1 << channel) != 0)
                .map(|channel| format!("ch{channel}"))
                .collect::<Vec<_>>()
                .join(" ")
        }
    );
    let sample: Vec<String> = seen
        .iter()
        .take(8)
        .map(|value| format!("{value:#06x}"))
        .collect();
    println!("  readings: {}", sample.join(" "));
    println!();

    // Phase 0b: does the threshold write reach the comparator?
    //
    // If `REG_PIN_STATE` reflects the input comparator, the live reading must
    // change with the threshold. A reading that never moves means the DAC value
    // is not being applied, which would explain a sampler that sees a constant
    // level no matter what threshold is requested.
    println!("--- live pin state vs threshold ---");
    for threshold in THRESHOLDS {
        if let Err(error) = kingst_la2016::set_input_threshold(&id, threshold) {
            eprintln!("  set {threshold} V failed: {error}");
            continue;
        }
        let mut readings = std::collections::BTreeSet::new();
        for _ in 0..40 {
            if let Ok(state) = kingst_la2016::read_live_pin_state(&id) {
                readings.insert(state);
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        println!(
            "  threshold {threshold:>4} V -> {} distinct: {}",
            readings.len(),
            readings
                .iter()
                .map(|value| format!("{value:#06x}"))
                .collect::<Vec<_>>()
                .join(" ")
        );
    }
    println!();

    // Phase 1: find a threshold that actually produces edges. A threshold at or
    // above the signal's high level reads as a constant, so this is the first
    // thing to rule out.
    println!("--- threshold sweep (1 ms probe each) ---");
    let mut chosen: Option<(f64, u64)> = None;
    // A streaming probe costs real time on the wire, so probing six thresholds
    // makes the run drag; one is enough to exercise the path.
    let streaming = std::env::var_os("SIGPILOT_SPI_STREAM").is_some();
    let thresholds: &[f64] = if streaming { &[1.5] } else { &THRESHOLDS };
    for threshold in thresholds.iter().copied() {
        let probe = settings_for(&id, rate, 1, threshold);
        let Some(capture) = run_capture(&id, &probe) else {
            continue;
        };
        let edges = total_edges(&capture);
        println!(
            "  threshold {threshold:>4} V -> {edges:>8} edges over ch0..15  ({} samples)",
            capture.metadata.sample_count
        );
        if chosen.is_none_or(|(_, best)| edges > best) {
            chosen = Some((threshold, edges));
        }
    }
    let Some((threshold, edges)) = chosen else {
        eprintln!("no threshold produced a capture");
        std::process::exit(1);
    };
    println!();
    if edges == 0 {
        println!("No threshold produced a single edge in a 1 ms probe.");
        println!(
            "The probes are short, so a bursty source can be missed; the full capture below \
             is the real test."
        );
        println!();
    } else {
        println!("using threshold {threshold} V (the most edges)");
        println!();
    }

    // Phase 2: full capture at the winning threshold. Always runs, even when the
    // short probes saw nothing, because the source may be bursty.
    let threshold = if edges == 0 { 1.5 } else { threshold };
    let settings = settings_for(&id, rate, duration_ms, threshold);
    let started = Instant::now();
    let Some(capture) = run_capture(&id, &settings) else {
        std::process::exit(1);
    };
    println!(
        "captured {} samples in {:.1?} ({} bytes, unitsize {})",
        capture.metadata.sample_count,
        started.elapsed(),
        capture.samples.len(),
        capture.metadata.unitsize
    );
    println!();

    report_channels(&capture);
    dump_registers(&id);
    decode(&capture);
}

/// The FPGA register space is the only view of the device's state, since the
/// hardware cannot be read back for its configuration.
fn dump_registers(id: &str) {
    println!("--- FPGA registers ---");
    match kingst_la2016::dump_fpga_registers(id) {
        Ok(registers) => {
            for (index, row) in registers.chunks(16).enumerate() {
                let base = index * 16;
                let bytes: Vec<String> =
                    row.iter().map(|byte| format!("{byte:02x}")).collect();
                println!("  {base:#04x}  {}", bytes.join(" "));
            }
        }
        Err(error) => println!("  register dump failed: {error}"),
    }
    println!();
}

/// Read sample word `index` out of the packed payload.
fn word(capture: &CaptureData, index: usize) -> u32 {
    let unit = capture.metadata.unitsize as usize;
    let base = index * unit;
    capture.samples[base..base + unit]
        .iter()
        .enumerate()
        .fold(0u32, |acc, (byte, value)| acc | (u32::from(*value) << (8 * byte)))
}

fn total_edges(capture: &CaptureData) -> u64 {
    let total = capture.metadata.sample_count as usize;
    if total < 2 {
        return 0;
    }
    let mut edges = 0u64;
    let mut previous = word(capture, 0);
    for index in 1..total {
        let current = word(capture, index);
        edges += u64::from((current ^ previous).count_ones());
        previous = current;
    }
    edges
}

/// Per-channel activity, so a mis-wiring is obvious before decoding.
fn report_channels(capture: &CaptureData) {
    let total = capture.metadata.sample_count as usize;
    let mut transitions = [0u64; 16];
    let mut high = [0u64; 16];
    let mut first_change = [usize::MAX; 16];

    let mut previous = word(capture, 0);
    for channel in 0..16 {
        if previous & (1 << channel) != 0 {
            high[channel] += 1;
        }
    }
    for index in 1..total {
        let current = word(capture, index);
        let changed = current ^ previous;
        if changed != 0 {
            for channel in 0..16 {
                if changed & (1 << channel) != 0 {
                    transitions[channel] += 1;
                    if first_change[channel] == usize::MAX {
                        first_change[channel] = index;
                    }
                }
            }
        }
        for channel in 0..16 {
            if current & (1 << channel) != 0 {
                high[channel] += 1;
            }
        }
        previous = current;
    }

    println!("--- per-channel activity ---");
    println!("  ch  transitions   high%   first change");
    for channel in 0..16 {
        let duty = if total > 0 {
            high[channel] as f64 * 100.0 / total as f64
        } else {
            0.0
        };
        let first = if first_change[channel] == usize::MAX {
            "-".to_string()
        } else {
            first_change[channel].to_string()
        };
        println!(
            "  {channel:>2}  {:>11}  {duty:>5.1}%   {first}",
            transitions[channel]
        );
    }
    println!();
}

/// Try every plausible 4-wire SPI assignment among ch0..3.
///
/// Auto-detecting the clock from edge counts is not reliable: a gated or
/// narrow-pulse clock can have fewer edges than a busy data line, and an idle
/// chip select sits at a constant level. So every channel gets a turn as the
/// clock, and the run that yields the most non-zero payload wins.
fn decode(capture: &CaptureData) {
    println!("--- SPI decode ---");
    let mut edges: Vec<(u8, u64)> = (0..4)
        .map(|channel| (channel, count_transitions(capture, channel)))
        .collect();
    edges.sort_by(|a, b| b.1.cmp(&a.1));
    println!(
        "  ch0..3 edges: {}",
        edges
            .iter()
            .map(|(channel, count)| format!("ch{channel}={count}"))
            .collect::<Vec<_>>()
            .join("  ")
    );
    println!();

    let mut best: Option<(usize, String, Vec<String>)> = None;
    for clock in 0..4u8 {
        let others: Vec<u8> = (0..4u8).filter(|channel| *channel != clock).collect();
        for (index, enable) in others.iter().enumerate() {
            let data_lines: Vec<u8> = others
                .iter()
                .enumerate()
                .filter(|(other, _)| *other != index)
                .map(|(_, channel)| *channel)
                .collect();
            for (mosi, miso) in [(data_lines[0], data_lines[1]), (data_lines[1], data_lines[0])] {
                for (polarity, phase) in [(false, false), (false, true), (true, false), (true, true)]
                {
                    let settings = SpiDecodeSettings {
                        mosi_channel: Some(mosi),
                        miso_channel: Some(miso),
                        clock_channel: clock,
                        enable_channel: Some(*enable),
                        enable_active_low: true,
                        clock_polarity: polarity,
                        clock_phase: phase,
                        bits_per_transfer: 8,
                        msb_first: true,
                    };
                    let Ok(frames) = decode_spi(capture, &settings) else {
                        continue;
                    };
                    if frames.is_empty() {
                        continue;
                    }
                    let preview: Vec<String> = frames
                        .iter()
                        .take(16)
                        .map(|frame| format!("{:02x}", frame.value))
                        .collect();
                    // Prefer a run that produces non-zero payload; a decoder
                    // will happily emit zero bytes from a constant data line.
                    let non_zero = frames.iter().filter(|frame| frame.value != 0).count();
                    let summary = format!(
                        "clk=ch{clock} mosi=ch{mosi} miso=ch{miso} cs=ch{enable} \
                         cpol={} cpha={} -> {} frames, {} non-zero",
                        u8::from(polarity),
                        u8::from(phase),
                        frames.len(),
                        non_zero
                    );
                    if best.as_ref().is_none_or(|(score, _, _)| non_zero > *score) {
                        best = Some((non_zero, summary, preview));
                    }
                }
            }
        }
    }

    println!();
    match best {
        Some((non_zero, summary, preview)) => {
            println!("  best: {summary}");
            println!("        first bytes: {}", preview.join(" "));
            if non_zero > 0 {
                println!(
                    "  verdict: SPI decoded with real payload, so the whole capture chain is \
                     verified end to end"
                );
            } else {
                println!(
                    "  verdict: frames decode but every byte is zero. The clock and chip select \
                     look real; check which line carries the data, or whether the source is \
                     actually transmitting."
                );
            }
        }
        None => {
            println!("  verdict: no SPI frames decoded from any assignment.");
        }
    }
}

fn count_transitions(capture: &CaptureData, channel: u8) -> u64 {
    let total = capture.metadata.sample_count as usize;
    if total < 2 {
        return 0;
    }
    let mask = 1u32 << channel;
    let mut count = 0u64;
    let mut previous = word(capture, 0) & mask;
    for index in 1..total {
        let current = word(capture, index) & mask;
        if current != previous {
            count += 1;
        }
        previous = current;
    }
    count
}
