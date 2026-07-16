use std::{
    env,
    error::Error,
    fs,
    path::PathBuf,
    sync::atomic::{AtomicBool, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use pxlogic_core::{
    capture::{decode_cross_data_with_map, read_sample_word},
    CaptureBackend, CaptureMode, CaptureProgress, CaptureSettings, DeviceInfo, DiagnosticEvent,
    DiagnosticLevel, RusbBackend,
};

#[derive(Debug)]
struct Options {
    device_id: Option<String>,
    sample_rate_hz: u64,
    duration_ms: u64,
    channel_count: u8,
    decode_cross: bool,
    compare_mappings: bool,
    threshold_volts: f64,
    mode: CaptureMode,
    output: Option<PathBuf>,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            device_id: None,
            sample_rate_hz: 25_000_000,
            duration_ms: 10,
            channel_count: 16,
            decode_cross: true,
            compare_mappings: false,
            threshold_volts: 2.0,
            mode: CaptureMode::Buffer,
            output: None,
        }
    }
}

fn main() -> Result<(), Box<dyn Error>> {
    let options = parse_options()?;
    let backend = RusbBackend::default();
    let devices = backend.list_devices()?;
    if devices.is_empty() {
        return Err("no PXLogic USB devices found".into());
    }

    println!("devices:");
    for device in &devices {
        println!("  {}", describe_device(device));
    }

    let device_id = match options.device_id {
        Some(device_id) => device_id,
        None => devices[0].id.clone(),
    };
    println!("selected: {device_id}");

    let bitstreams = RusbBackend::load_bitstreams()?
        .ok_or("missing FPGA bitstreams; expected resources/bitstreams/*.bin")?;
    let mut trace = |event: DiagnosticEvent| {
        let level = match event.level {
            DiagnosticLevel::Info => "info",
            DiagnosticLevel::Warn => "warn",
            DiagnosticLevel::Error => "error",
        };
        println!("[{}:{level}] {}", event.phase, event.message);
    };

    backend.prepare_device_with_trace(&device_id, Some(&bitstreams), &mut trace)?;

    let cancel = AtomicBool::new(false);
    let mut progress = |event: CaptureProgress| {
        println!(
            "[progress] bytes={}/{} samples={}",
            event.bytes_read, event.bytes_expected, event.samples_read
        );
    };
    let settings = CaptureSettings {
        device_id,
        sample_rate_hz: options.sample_rate_hz,
        channel_count: options.channel_count,
        duration_ms: options.duration_ms,
        decode_cross: options.decode_cross && !options.compare_mappings,
        threshold_volts: options.threshold_volts,
        mode: options.mode,
    };
    let capture = backend.capture_with_trace(&settings, &cancel, &mut progress, &mut trace)?;
    cancel.store(true, Ordering::Release);

    println!(
        "capture: {} Hz, {} channels, {} samples, unitsize={}, {} bytes",
        capture.metadata.sample_rate_hz,
        capture.metadata.channel_count,
        capture.metadata.sample_count,
        capture.metadata.unitsize,
        capture.samples.len()
    );
    if options.compare_mappings {
        compare_cross_mappings(&capture)?;
    } else {
        print_sample_summary(&capture);
    }

    let output = options.output.unwrap_or_else(default_output_path);
    if let Some(parent) = output.parent() {
        fs::create_dir_all(parent)?;
    }
    pxlogic_file::save_pxcap(&output, &capture)?;
    println!("saved: {}", output.display());

    Ok(())
}

fn parse_options() -> Result<Options, Box<dyn Error>> {
    let mut options = Options::default();
    let mut args = env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--device" => options.device_id = Some(next_arg(&mut args, "--device")?),
            "--rate" => options.sample_rate_hz = next_arg(&mut args, "--rate")?.parse()?,
            "--ms" => options.duration_ms = next_arg(&mut args, "--ms")?.parse()?,
            "--channels" => options.channel_count = next_arg(&mut args, "--channels")?.parse()?,
            "--vth" => options.threshold_volts = next_arg(&mut args, "--vth")?.parse()?,
            "--mode" => options.mode = parse_mode(&next_arg(&mut args, "--mode")?)?,
            "--out" => options.output = Some(PathBuf::from(next_arg(&mut args, "--out")?)),
            "--raw-cross" => options.decode_cross = false,
            "--decode-cross" => options.decode_cross = true,
            "--compare-mappings" => options.compare_mappings = true,
            "--help" | "-h" => {
                print_help();
                std::process::exit(0);
            }
            other => return Err(format!("unknown argument: {other}").into()),
        }
    }
    Ok(options)
}

fn next_arg(args: &mut impl Iterator<Item = String>, flag: &str) -> Result<String, Box<dyn Error>> {
    args.next()
        .ok_or_else(|| format!("{flag} requires a value").into())
}

fn parse_mode(value: &str) -> Result<CaptureMode, Box<dyn Error>> {
    match value.to_ascii_lowercase().as_str() {
        "buffer" => Ok(CaptureMode::Buffer),
        "stream" => Ok(CaptureMode::Stream),
        other => Err(format!("unknown capture mode: {other}; expected buffer or stream").into()),
    }
}

fn print_help() {
    println!(
        "usb_smoke [--device id] [--rate hz] [--ms duration] [--channels n] [--vth volts] [--mode buffer|stream] [--raw-cross] [--compare-mappings] [--out path]"
    );
}

fn describe_device(device: &DeviceInfo) -> String {
    format!(
        "{} vid={:04x} pid={:04x} bus={:?} addr={:?}",
        device.id, device.vid, device.pid, device.bus, device.address
    )
}

fn default_output_path() -> PathBuf {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    PathBuf::from(format!(
        "/Volumes/tp7100s/work/pxlogic/debug-captures/usb-smoke-{timestamp}.pxcap"
    ))
}

fn print_sample_summary(capture: &pxlogic_core::CaptureData) {
    print_decoded_summary(
        &capture.samples,
        capture.metadata.unitsize,
        capture.metadata.channel_count,
        capture.metadata.sample_count,
    );
}

fn print_decoded_summary(samples: &[u8], unitsize: u8, channel_count: u8, sample_count: u64) {
    let inspect_samples = sample_count.min(100_000);
    let mut previous = None;
    let mut highs = vec![0u64; channel_count as usize];
    let mut transitions = vec![0u64; channel_count as usize];
    let mut first_edges = vec![Vec::<u64>::new(); channel_count as usize];

    for sample_index in 0..inspect_samples {
        let Some(word) = read_sample_word(samples, unitsize, sample_index) else {
            break;
        };
        for channel in 0..channel_count {
            if (word & (1u32 << channel)) != 0 {
                highs[channel as usize] += 1;
            }
        }
        if let Some(prev) = previous {
            let changed = prev ^ word;
            for channel in 0..channel_count {
                if (changed & (1u32 << channel)) != 0 {
                    transitions[channel as usize] += 1;
                    let edges = &mut first_edges[channel as usize];
                    if edges.len() < 8 {
                        edges.push(sample_index);
                    }
                }
            }
        }
        previous = Some(word);
    }

    println!("summary over first {inspect_samples} samples:");
    for channel in 0..channel_count {
        let high = highs[channel as usize];
        let edges = transitions[channel as usize];
        if high != 0 || edges != 0 {
            let ratio = if inspect_samples == 0 {
                0.0
            } else {
                high as f64 * 100.0 / inspect_samples as f64
            };
            println!(
                "  D{channel}: high={ratio:6.2}% ({high}), transitions={edges}, first_edges={:?}",
                first_edges[channel as usize]
            );
        }
    }
}

#[derive(Debug)]
struct MappingCandidate {
    name: String,
    map: Vec<u8>,
    reverse_bits: bool,
}

fn compare_cross_mappings(capture: &pxlogic_core::CaptureData) -> Result<(), Box<dyn Error>> {
    let channel_count = capture.metadata.channel_count;
    let channels = usize::from(channel_count);
    if !matches!(channel_count, 16 | 32) {
        return Err(format!(
            "cross mapping comparison only supports 16/32 channels, got {channel_count}"
        )
        .into());
    }

    let stripe_bytes = channels * 8;
    let aligned_len = capture.samples.len() / stripe_bytes * stripe_bytes;
    if aligned_len == 0 {
        return Err("not enough raw cross data for one complete stripe".into());
    }
    let raw = &capture.samples[..aligned_len];
    let decoded_sample_count = (aligned_len / stripe_bytes * 64) as u64;

    println!(
        "raw cross analysis: {} bytes, {} complete stripes, {} decoded samples",
        aligned_len,
        aligned_len / stripe_bytes,
        decoded_sample_count
    );
    print_raw_lane_activity(raw, channel_count);

    for candidate in mapping_candidates(channel_count) {
        println!();
        println!("mapping: {}", candidate.name);
        print_mapping_preview(&candidate.map);
        let decoded = decode_cross_data_with_map(
            channel_count,
            raw,
            Some(&candidate.map),
            candidate.reverse_bits,
        )?;
        print_decoded_summary(
            &decoded,
            capture.metadata.unitsize,
            channel_count,
            decoded_sample_count,
        );
    }

    Ok(())
}

fn print_mapping_preview(map: &[u8]) {
    let preview: Vec<String> = map
        .iter()
        .take(16)
        .enumerate()
        .map(|(logical, physical)| format!("D{logical}<-raw{physical}"))
        .collect();
    println!("  {}", preview.join(", "));
}

fn print_raw_lane_activity(raw: &[u8], channel_count: u8) {
    let channels = usize::from(channel_count);
    let stripe_bytes = channels * 8;
    let stripes = raw.len() / stripe_bytes;
    let mut highs = vec![0u64; channels];
    let mut transitions = vec![0u64; channels];
    let mut previous = vec![None::<u64>; channels];

    for stripe in 0..stripes {
        let stripe_offset = stripe * stripe_bytes;
        for channel in 0..channels {
            let offset = stripe_offset + channel * 8;
            let word = u64::from_le_bytes(raw[offset..offset + 8].try_into().expect("fixed lane"));
            highs[channel] += u64::from(word.count_ones());
            if let Some(prev) = previous[channel] {
                transitions[channel] += u64::from((prev ^ word).count_ones());
            }
            previous[channel] = Some(word);
        }
    }

    let mut lanes: Vec<_> = (0..channels)
        .map(|channel| (channel, highs[channel], transitions[channel]))
        .collect();
    lanes.sort_by_key(|&(_channel, high, edges)| std::cmp::Reverse((edges, high)));

    println!("most active raw lanes:");
    for (channel, high, edges) in lanes.into_iter().take(12) {
        if high == 0 && edges == 0 {
            continue;
        }
        let samples = (stripes * 64) as f64;
        let ratio = if samples == 0.0 {
            0.0
        } else {
            high as f64 * 100.0 / samples
        };
        println!("  raw{channel}: high={ratio:6.2}% ({high}), transitions={edges}");
    }
}

fn mapping_candidates(channel_count: u8) -> Vec<MappingCandidate> {
    let channels = channel_count;
    let mut candidates = Vec::new();
    push_candidate(
        &mut candidates,
        "identity",
        channels,
        |logical, _| logical,
        false,
    );
    push_candidate(
        &mut candidates,
        "identity + reverse time bits inside each 64-sample lane word",
        channels,
        |logical, _| logical,
        true,
    );
    push_candidate(
        &mut candidates,
        "reverse all channels",
        channels,
        |logical, channels| channels - 1 - logical,
        false,
    );
    push_candidate(
        &mut candidates,
        "reverse channels inside each 8-channel group",
        channels,
        |logical, _| (logical / 8) * 8 + (7 - (logical % 8)),
        false,
    );
    push_candidate(
        &mut candidates,
        "reverse 8-channel group order",
        channels,
        |logical, channels| {
            let groups = channels / 8;
            let group = logical / 8;
            let lane = logical % 8;
            (groups - 1 - group) * 8 + lane
        },
        false,
    );
    if channels == 32 {
        push_candidate(
            &mut candidates,
            "swap 16-channel halves",
            channels,
            |logical, _| (logical + 16) % 32,
            false,
        );
        push_candidate(
            &mut candidates,
            "even lanes first, odd lanes second",
            channels,
            |logical, _| {
                if logical < 16 {
                    logical * 2
                } else {
                    (logical - 16) * 2 + 1
                }
            },
            false,
        );
        push_candidate(
            &mut candidates,
            "odd lanes first, even lanes second",
            channels,
            |logical, _| {
                if logical < 16 {
                    logical * 2 + 1
                } else {
                    (logical - 16) * 2
                }
            },
            false,
        );
    }
    candidates
}

fn push_candidate(
    candidates: &mut Vec<MappingCandidate>,
    name: &str,
    channel_count: u8,
    map_fn: impl Fn(u8, u8) -> u8,
    reverse_bits: bool,
) {
    let map = (0..channel_count)
        .map(|logical| map_fn(logical, channel_count))
        .collect();
    candidates.push(MappingCandidate {
        name: name.to_string(),
        map,
        reverse_bits,
    });
}
