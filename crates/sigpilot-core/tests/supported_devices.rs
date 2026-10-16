//! Keeps `docs/supported-devices.md` in step with the device table in the source.
//!
//! The table of supported models is generated from `PXLOGIC_DEVICE_PROFILES` rather
//! than maintained by hand, so the source stays the single place a model is
//! declared. Committing the generated file is what makes the answer to "which
//! models does this build support" readable in the repository and reviewable in a
//! diff, without anyone having to read Rust.
//!
//! The check fails when the file is stale, so adding a model without regenerating
//! is caught here instead of shipping a document that quietly lies.

use std::fmt::Write as _;
use std::path::PathBuf;

use sigpilot_core::pxview_profile::{
    pxlogic_capture_capabilities_from_profile, pxlogic_channel_mode, PxUsbSpeed,
    PXLOGIC_DEVICE_PROFILES,
};

fn documentation_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../docs/supported-devices.md")
}

fn usb_speed_label(speed: PxUsbSpeed) -> &'static str {
    match speed {
        PxUsbSpeed::High => "USB 2.0 High",
        PxUsbSpeed::Super => "USB 3.0 Super",
    }
}

fn render() -> String {
    let mut out = String::new();

    out.push_str("# Supported device models\n\n");
    out.push_str(
        "> **Generated file — do not edit by hand.**\n\
         >\n\
         > Source of truth: `PXLOGIC_DEVICE_PROFILES` in\n\
         > `crates/sigpilot-core/src/pxview_profile.rs`.\n\
         >\n\
         > Regenerate with:\n\
         >\n\
         > ```sh\n\
         > PXLOGIC_UPDATE_SUPPORTED_DEVICES=1 cargo test -p sigpilot-core supported_devices\n\
         > ```\n\
         >\n\
         > A test fails when this file is out of date, so a model added to the table\n\
         > cannot be merged without appearing here.\n\n",
    );

    out.push_str("## Models\n\n");
    out.push_str("| Vendor | Model | VID | PID | USB | Digital channels | Analog channels | Depth (samples) | Modes |\n");
    out.push_str("| --- | --- | --- | --- | --- | --- | --- | --- | --- |\n");

    for profile in PXLOGIC_DEVICE_PROFILES {
        let capabilities = pxlogic_capture_capabilities_from_profile(profile.model, profile);
        let _ = writeln!(
            out,
            "| {} | {} | `{:04X}` | `{:04X}` | {} | {} | {} | {} | {} |",
            profile.vendor,
            profile.model,
            profile.vid,
            profile.pid,
            usb_speed_label(profile.usb_speed),
            capabilities.max_channels,
            capabilities.max_analog_channels,
            profile.hardware_depth_bits,
            profile.supported_modes.len(),
        );
    }

    out.push_str(
        "\nDepth is the hardware sample memory, so the longest capture at a given\n\
         rate is `depth / sample_rate`. A device reporting `0` analog channels has\n\
         none; the demo device is the one that does.\n\n",
    );

    out.push_str("## Capture modes per model\n\n");

    for profile in PXLOGIC_DEVICE_PROFILES {
        let _ = writeln!(out, "### {} — {}\n", profile.vendor, profile.model);
        out.push_str("| Mode | Kind | Channels | Default rate | Max rate | Notes |\n");
        out.push_str("| --- | --- | --- | --- | --- | --- |\n");

        for mode_id in profile.supported_modes {
            let Some(mode) = pxlogic_channel_mode(*mode_id) else {
                continue;
            };
            let kind = if mode.stream { "Stream" } else { "Buffer" };
            let default_marker = if mode.id == profile.default_mode {
                " (default)"
            } else {
                ""
            };
            let _ = writeln!(
                out,
                "| `{}` | {} | {} | {} Hz | {} Hz | {}{} |",
                mode.id.pxview_name(),
                kind,
                mode.channels,
                mode.default_samplerate_hz,
                mode.max_samplerate_hz,
                mode.description,
                default_marker,
            );
        }
        out.push('\n');
    }

    // Keep the final newline without an extra blank line at EOF.
    out.pop();
    out
}

#[test]
fn supported_devices_documentation_is_current() {
    let rendered = render();
    let path = documentation_path();

    if std::env::var_os("PXLOGIC_UPDATE_SUPPORTED_DEVICES").is_some() {
        std::fs::write(&path, &rendered).expect("write docs/supported-devices.md");
        eprintln!("wrote {}", path.display());
        return;
    }

    let committed = std::fs::read_to_string(&path).unwrap_or_else(|error| {
        panic!(
            "could not read {}: {error}\n\
             Regenerate it with:\n  \
             PXLOGIC_UPDATE_SUPPORTED_DEVICES=1 cargo test -p sigpilot-core supported_devices",
            path.display()
        )
    });

    if committed != rendered {
        panic!(
            "{} is out of date with PXLOGIC_DEVICE_PROFILES.\n\
             Regenerate it with:\n  \
             PXLOGIC_UPDATE_SUPPORTED_DEVICES=1 cargo test -p sigpilot-core supported_devices",
            path.display()
        );
    }
}
