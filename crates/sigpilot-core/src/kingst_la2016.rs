//! Kingst LA series logic analyzer driver (USB).
//!
//! Covers the LA2016 (16 channel, 200 MHz) and its siblings which share the
//! same USB identity and protocol: LA1016, LA1010, LA5016, LA5032. The model is
//! not known from the USB descriptor — several models share `77a1:01a2` — so it
//! is read out of the EEPROM after the MCU firmware is running.
//!
//! # Why this device needs more than a descriptor read
//!
//! The board is a Cypress FX2LP (volatile program memory) plus an Altera FPGA.
//! Neither is programmed at power-on:
//!
//! 1. The device enumerates as `77a1:01a2` with a vendor-specific interface
//!    whose alternate setting 0 has **no endpoints**, and `bcdDevice` reads
//!    0.0.0. That is the unprogrammed FX2 state. Note that in this state
//!    `iManufacturer`, `iProduct` and `iSerialNumber` are all 0 — the device
//!    has no string descriptors at all, so enumeration must **not** filter on
//!    them or the very state that needs programming becomes invisible.
//! 2. The host uploads the MCU firmware over EP0 using the standard Cypress
//!    `ezusb` protocol. The device then re-enumerates with its endpoints live.
//! 3. The host reads the EEPROM magic byte to learn which model this is.
//! 4. The host uploads the matching FPGA bitstream to EP2 and enables the FPGA.
//!
//! Only after step 4 can the device capture. Steps 2-4 are what
//! [`DeviceDriver::prepare`] does here, which is exactly the "put the device
//! into a capturable state, idempotently, possibly before every capture"
//! contract that trait documents.
//!
//! # Firmware files are not bundled
//!
//! The FX2 firmware and the FPGA bitstream are vendor blobs extracted from
//! KingstVIS; they cannot be redistributed. This driver therefore *loads* them
//! from a directory the user supplies, the same way sigrok does:
//!
//! - `SIGPILOT_KINGST_FIRMWARE_DIR`, or
//! - `~/.local/share/sigrok-firmware`, `/usr/local/share/sigrok-firmware`,
//!   `/opt/homebrew/share/sigrok-firmware`.
//!
//! Expected file names, straight from the vendor bundle:
//!
//! - `kingst-la-01a2.fw` — MCU firmware, named after the USB PID
//! - `kingst-la2016-fpga.bitstream`, `kingst-la2016a1-fpga.bitstream`, … —
//!   one per board revision, selected by the EEPROM magic
//!
//! # Status
//!
//! Enumeration, identification, firmware upload and FPGA bring-up are
//! implemented. `TODO(capture-path)` applies as it does to every other driver:
//! capture is not yet part of [`DeviceDriver`], so this driver does not
//! implement the sample path (EP6 bulk IN, the vendor's packet format).
//!
//! Protocol reference: libsigrok's `kingst-la2016` driver (GPL-3.0-or-later).
//! This is an independent reimplementation against the same wire protocol.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use rusb::UsbContext;

use crate::{
    bulk_in_pool::{self, BulkInPool},
    capture::{pxview_capture_transfer_size, resolve_enabled_channels},
    device::{DeviceDescriptor, DeviceDriver, DriverIsolation},
    error::{CoreError, Result},
    models::{
        CaptureData, CaptureMetadata, CaptureProgress, CaptureSettings, DeviceInfo, DeviceKind,
        DiagnosticEvent, DiagnosticLevel, HardwareCaptureCapabilities, HardwareChannelModeInfo,
    },
};

/// Progress line for [`DeviceDriver::prepare`].
fn info(message: String) -> DiagnosticEvent {
    DiagnosticEvent {
        phase: "kingst-prepare".to_string(),
        level: DiagnosticLevel::Info,
        message,
    }
}

pub const KINGST_VID: u16 = 0x77a1;
pub const KINGST_PID: u16 = 0x01a2;

/// The device-id scheme this driver owns.
///
/// The PXLogic driver owns the bare `usb` scheme because it was the first USB
/// driver. [`crate::device`] requires schemes to be disjoint, and documents
/// that a second USB driver must be vendor-scoped, so this driver takes
/// `usb-kingst`.
pub const ID_SCHEME: &str = "usb-kingst";

const USB_CONFIGURATION: u8 = 1;
/// The single vendor-specific interface. Claiming it is what makes the bulk
/// endpoints usable; the FX2 firmware selects the alternate setting with
/// endpoints itself, so we never set one.
const USB_INTERFACE: u8 = 0;

/// FPGA bitstream bulk endpoint (host → device).
const EP_FPGA_BITSTREAM: u8 = 0x02;
/// The device expects the bitstream padded up to a multiple of this.
const EP2_PADDING: usize = 4096;
/// MCU firmware upload chunk size.
const FW_CHUNK: usize = 4096;

/// USB vendor control requests handled by the FX2 MCU.
const CMD_FPGA_ENABLE: u8 = 0x10;
const CMD_FPGA_SPI: u8 = 0x20;
const CMD_BULK_RESET: u8 = 0x38;
const CMD_FPGA_INIT: u8 = 0x50;
/// Start the bulk download from EP6.
const CMD_BULK_START: u8 = 0x30;
const CMD_EEPROM: u8 = 0xa2;
/// Cypress `ezusb` firmware upload request.
const CMD_FX2_FIRMWARE: u8 = 0xa0;
/// FX2 CPU control/status register. Writing 1 holds the 8051 in reset.
const FX2_CPUCS: u16 = 0xe600;

/// FPGA registers, reached through [`CMD_FPGA_SPI`] with the address in `wValue`.
const REG_RUN: u16 = 0x00;
const REG_PWM_EN: u16 = 0x02;

const EEPROM_MAGIC_OFFSET: u16 = 0x08;
const EEPROM_DATE_OFFSET: u16 = 0x20;

const DEFAULT_TIMEOUT: Duration = Duration::from_millis(200);
/// The FPGA takes a while to come back after a bitstream upload.
const FPGA_SETTLE: Duration = Duration::from_millis(30);
const FPGA_ENABLE_SETTLE: Duration = Duration::from_millis(40);
/// How long to wait for the FX2 to re-enumerate after a firmware upload.
const RENUM_TIMEOUT: Duration = Duration::from_secs(3);
/// The device must disappear first, or we may mistake the old incarnation for
/// the newly programmed one.
const RENUM_GONE_DELAY: Duration = Duration::from_millis(1800);
const RENUM_POLL: Duration = Duration::from_millis(200);

/// Threshold range the hardware supports.
const THRESHOLD_VOLTS: &[f64] = &[1.2, 1.5, 1.8, 2.5, 3.3];
/// Hardware sample depth, in samples, for the models we know.
const MEMORY_SAMPLES: u64 = 128 * 1024 * 1024 * 8 / 16;

/// One supported board revision.
pub struct KingstModel {
    /// EEPROM magic byte.
    magic: u8,
    /// Secondary magic byte; `0` means "don't care".
    magic2: u8,
    /// Marketing name, shown in the UI.
    name: &'static str,
    /// FPGA bitstream file stem; the file is `kingst-<stem>-fpga.bitstream`.
    fpga_stem: &'static str,
    /// Maximum samplerate in Hz.
    samplerate: u64,
    /// Channel count.
    channels: u8,
    /// SDRAM capacity in Gbit.
    memory_bits: u8,
}

/// Ported from libsigrok's `models[]`. Several entries can match one device;
/// the first whose `magic2` matches (or is zero) wins.
const MODELS: &[KingstModel] = &[
    KingstModel { magic: 0x02, magic2: 0x01, name: "LA2016", fpga_stem: "la2016a1", samplerate: 200_000_000, channels: 16, memory_bits: 1 },
    KingstModel { magic: 0x02, magic2: 0x00, name: "LA2016", fpga_stem: "la2016", samplerate: 200_000_000, channels: 16, memory_bits: 1 },
    KingstModel { magic: 0x03, magic2: 0x01, name: "LA1016", fpga_stem: "la1016a1", samplerate: 100_000_000, channels: 16, memory_bits: 1 },
    KingstModel { magic: 0x03, magic2: 0x00, name: "LA1016", fpga_stem: "la1016", samplerate: 100_000_000, channels: 16, memory_bits: 1 },
    KingstModel { magic: 0x04, magic2: 0x00, name: "LA1010", fpga_stem: "la1010a0", samplerate: 100_000_000, channels: 16, memory_bits: 0 },
    KingstModel { magic: 0x05, magic2: 0x00, name: "LA5016", fpga_stem: "la5016a1", samplerate: 500_000_000, channels: 16, memory_bits: 2 },
    KingstModel { magic: 0x06, magic2: 0x00, name: "LA5032", fpga_stem: "la5032a0", samplerate: 500_000_000, channels: 32, memory_bits: 4 },
    KingstModel { magic: 0x07, magic2: 0x00, name: "LA1010", fpga_stem: "la1010a1", samplerate: 100_000_000, channels: 16, memory_bits: 0 },
    KingstModel { magic: 0x08, magic2: 0x00, name: "LA2016", fpga_stem: "la2016a1", samplerate: 200_000_000, channels: 16, memory_bits: 1 },
    KingstModel { magic: 0x09, magic2: 0x00, name: "LA1016", fpga_stem: "la1016a1", samplerate: 100_000_000, channels: 16, memory_bits: 1 },
    KingstModel { magic: 0x0a, magic2: 0x00, name: "LA1010", fpga_stem: "la1010a2", samplerate: 100_000_000, channels: 16, memory_bits: 0 },
    KingstModel { magic: 0x0b, magic2: 0x10, name: "LA2016", fpga_stem: "la2016a2", samplerate: 200_000_000, channels: 16, memory_bits: 1 },
    KingstModel { magic: 0x0c, magic2: 0x10, name: "LA5016", fpga_stem: "la5016a2", samplerate: 500_000_000, channels: 16, memory_bits: 2 },
    KingstModel { magic: 0x0c, magic2: 0x00, name: "LA5016", fpga_stem: "la5016a2", samplerate: 500_000_000, channels: 16, memory_bits: 2 },
    KingstModel { magic: 0x41, magic2: 0x00, name: "LA5016", fpga_stem: "la5016a1", samplerate: 500_000_000, channels: 16, memory_bits: 2 },
];

impl KingstModel {
    fn bitstream_file(&self) -> String {
        format!("kingst-{}-fpga.bitstream", self.fpga_stem)
    }
}

/// What an EEPROM read told us about the attached board.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KingstIdentity {
    pub magic: u8,
    pub magic2: u8,
    /// Manufacturing date as `YYYY-MM`, when the EEPROM checksum passes.
    pub manufactured: Option<String>,
    /// Index into [`MODELS`].
    model_index: usize,
}

impl KingstIdentity {
    pub fn model(&self) -> &KingstModel {
        &MODELS[self.model_index]
    }
}

// ---------------------------------------------------------------------------
// Firmware discovery
// ---------------------------------------------------------------------------

/// Where the vendor firmware files live.
///
/// Search order:
/// 1. `SIGPILOT_KINGST_FIRMWARE_DIR` — lets a user point at their own extraction.
/// 2. `resources/firmware/kingst/` next to the running binary, the crate, the
///    workspace root, or inside a macOS app bundle — the same layout search the
///    PXLogic firmware uses, so a packaged build finds it without configuration.
/// 3. The system `sigrok-firmware` directories, for users who already extracted
///    the files for sigrok.
pub fn firmware_dir() -> Option<PathBuf> {
    if let Some(dir) = crate::product_env_string("SIGPILOT_KINGST_FIRMWARE_DIR") {
        let path = PathBuf::from(dir);
        if path.is_dir() {
            return Some(path);
        }
    }

    if let Some(dir) = bundled_firmware_dirs().into_iter().find(|path| path.is_dir()) {
        return Some(dir);
    }

    let mut system = Vec::new();
    if let Some(home) = std::env::var_os("HOME") {
        system.push(PathBuf::from(home).join(".local/share/sigrok-firmware"));
    }
    system.push(PathBuf::from("/usr/local/share/sigrok-firmware"));
    system.push(PathBuf::from("/opt/homebrew/share/sigrok-firmware"));
    system.push(PathBuf::from("/usr/share/sigrok-firmware"));
    system.into_iter().find(|path| path.is_dir())
}

/// Mirrors `push_relative_firmware_dirs` in `rusb_backend`, one level deeper
/// because the Kingst files sit in their own `kingst/` subdirectory.
fn bundled_firmware_dirs() -> Vec<PathBuf> {
    let mut bases = Vec::new();
    if let Ok(cwd) = std::env::current_dir() {
        bases.push(cwd);
    }
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    if let Some(workspace_root) = manifest_dir.parent().and_then(Path::parent) {
        bases.push(workspace_root.to_path_buf());
    }
    bases.push(manifest_dir);
    if let Ok(exe) = std::env::current_exe() {
        bases.extend(exe.ancestors().take(8).map(Path::to_path_buf));
    }

    let mut dirs = Vec::new();
    for base in bases {
        dirs.push(base.join("resources/firmware/kingst"));
        dirs.push(base.join("src-tauri/resources/firmware/kingst"));
        // Packaged macOS app: <App>.app/Contents/MacOS/<exe> → Contents/Resources/…
        dirs.push(base.join("Resources/resources/firmware/kingst"));
    }
    dirs.dedup();
    dirs
}

fn read_firmware(dir: &Path, name: &str) -> Result<Vec<u8>> {
    let path = dir.join(name);
    std::fs::read(&path).map_err(|error| {
        CoreError::Usb(format!(
            "Kingst firmware '{}' is missing or unreadable: {error}. Extract it from KingstVIS \
             (sigrok-futil's sigrok-fwextract-kingst-la2016) and point \
             SIGPILOT_KINGST_FIRMWARE_DIR at the directory.",
            path.display()
        ))
    })
}

// ---------------------------------------------------------------------------
// Low-level USB
// ---------------------------------------------------------------------------

fn ctrl_in(handle: &rusb::DeviceHandle<rusb::Context>, request: u8, value: u16, buf: &mut [u8]) -> Result<()> {
    let written = handle.read_control(
        rusb::request_type(rusb::Direction::In, rusb::RequestType::Vendor, rusb::Recipient::Device),
        request,
        value,
        0,
        buf,
        DEFAULT_TIMEOUT,
    )?;
    if written != buf.len() {
        return Err(CoreError::Usb(format!(
            "Kingst control IN request {request:#04x} value {value:#06x} returned {written} of {} bytes",
            buf.len()
        )));
    }
    Ok(())
}

fn ctrl_out(handle: &rusb::DeviceHandle<rusb::Context>, request: u8, value: u16, data: &[u8]) -> Result<()> {
    ctrl_out_indexed(handle, request, value, 0, data)
}

/// Control OUT with an explicit `wIndex`.
///
/// Almost every vendor request passes zero here. The trigger configuration is
/// the one exception: the reference sends `16`, and sending zero instead leaves
/// the device sampling nothing at all.
fn ctrl_out_indexed(
    handle: &rusb::DeviceHandle<rusb::Context>,
    request: u8,
    value: u16,
    index: u16,
    data: &[u8],
) -> Result<()> {
    let written = handle.write_control(
        rusb::request_type(rusb::Direction::Out, rusb::RequestType::Vendor, rusb::Recipient::Device),
        request,
        value,
        index,
        data,
        DEFAULT_TIMEOUT,
    )?;
    if written != data.len() {
        return Err(CoreError::Usb(format!(
            "Kingst control OUT request {request:#04x} value {value:#06x} index {index:#06x} \
             wrote {written} of {} bytes",
            data.len()
        )));
    }
    Ok(())
}

fn device_id_for(vid: u16, pid: u16, bus: u8, address: u8) -> String {
    format!("{ID_SCHEME}:{vid:04x}:{pid:04x}:{bus}:{address}")
}

fn is_kingst(vid: u16, pid: u16) -> bool {
    vid == KINGST_VID && pid == KINGST_PID
}

/// Whether the FX2 is already running its firmware.
///
/// The unprogrammed FX2 exposes alternate setting 0 of the vendor interface
/// with no endpoints at all; once the firmware is up, the endpoints appear.
/// The reference driver instead probes the device by talking to it, which is
/// the more direct test — see [`read_identity`], which is what we actually use.
fn has_endpoints(device: &rusb::Device<rusb::Context>) -> bool {
    let Ok(config) = device.active_config_descriptor() else {
        return false;
    };
    config.interfaces().any(|interface| {
        interface
            .descriptors()
            .any(|alt| alt.setting_number() == 0 && alt.num_endpoints() > 0)
    })
}

// ---------------------------------------------------------------------------
// Firmware upload
// ---------------------------------------------------------------------------

/// Upload the FX2 MCU firmware using the Cypress `ezusb` protocol.
///
/// Sequence, matching libsigrok's `ezusb_upload_firmware`:
/// 1. select configuration 1,
/// 2. write 1 to CPUCS to hold the 8051 in reset,
/// 3. write the firmware image in 4 KiB chunks, with the offset in `wValue`,
/// 4. write 0 to CPUCS to release the 8051.
///
/// After step 4 the device re-enumerates, so the caller must re-open it.
fn upload_mcu_firmware(handle: &rusb::DeviceHandle<rusb::Context>, firmware: &[u8]) -> Result<()> {
    if firmware.len() > 1 << 16 {
        // `wValue` carries the offset and is only 16 bit wide.
        return Err(CoreError::Usb(
            "Kingst MCU firmware exceeds the 64 KiB addressable by the ezusb protocol".into(),
        ));
    }

    // macOS needs no kernel driver detach: libusb's Darwin backend reports a
    // kernel driver as active but always fails to detach it.
    let _ = handle.set_active_configuration(USB_CONFIGURATION);

    ctrl_out(handle, CMD_FX2_FIRMWARE, FX2_CPUCS, &[1])?;

    for (index, chunk) in firmware.chunks(FW_CHUNK).enumerate() {
        let offset = (index * FW_CHUNK) as u16;
        ctrl_out(handle, CMD_FX2_FIRMWARE, offset, chunk)?;
    }

    ctrl_out(handle, CMD_FX2_FIRMWARE, FX2_CPUCS, &[0])?;
    Ok(())
}

/// Wait for the device to come back after a firmware upload.
fn wait_for_reenumeration() -> Result<rusb::Device<rusb::Context>> {
    let deadline = Instant::now() + RENUM_TIMEOUT;
    let gone_deadline = Instant::now() + RENUM_GONE_DELAY;
    let mut seen_gone = false;

    while Instant::now() < deadline {
        std::thread::sleep(RENUM_POLL);
        let context = rusb::Context::new()?;
        let found = context.devices()?.iter().find(|device| {
            device
                .device_descriptor()
                .map(|desc| is_kingst(desc.vendor_id(), desc.product_id()) && has_endpoints(device))
                .unwrap_or(false)
        });

        match found {
            Some(device) => {
                // Before the gone-delay has elapsed we may still be looking at
                // the pre-firmware incarnation, so only accept a device that
                // actually has endpoints.
                if has_endpoints(&device) {
                    return Ok(device);
                }
            }
            None => seen_gone = true,
        }

        if !seen_gone && Instant::now() > gone_deadline {
            // The device never disappeared, but it may have re-enumerated in
            // place. Keep polling until the deadline.
            continue;
        }
    }

    Err(CoreError::Usb(
        "Kingst device did not re-enumerate after the MCU firmware upload".into(),
    ))
}

// ---------------------------------------------------------------------------
// Identification
// ---------------------------------------------------------------------------

/// Extract `(magic, magic2)` from the eight EEPROM identification bytes.
///
/// The values are stored twice, each with a one's-complement neighbour. The
/// first copy that passes the complement check wins; a copy that only has its
/// two-byte check intact still yields a magic, with `magic2` unknown (`0`).
fn parse_identity_bytes(buf: &[u8; 8]) -> Option<(u8, u8)> {
    if buf[0] ^ buf[1] == 0xff && buf[2] ^ buf[3] == 0xff {
        Some((buf[0], buf[2]))
    } else if buf[4] ^ buf[5] == 0xff && buf[6] ^ buf[7] == 0xff {
        Some((buf[4], buf[6]))
    } else if buf[0] ^ buf[1] == 0xff {
        Some((buf[0], 0))
    } else if buf[4] ^ buf[5] == 0xff {
        Some((buf[4], 0))
    } else {
        None
    }
}

/// Index into [`MODELS`] for an identified magic pair.
///
/// A model whose `magic2` is `0` accepts any secondary value, which is how the
/// reference table expresses "this magic alone is unambiguous".
fn lookup_model(magic: u8, magic2: u8) -> Option<usize> {
    MODELS
        .iter()
        .position(|model| model.magic == magic && (model.magic2 == 0 || model.magic2 == magic2))
}

/// Read and validate the EEPROM identification bytes.
pub fn read_identity(handle: &rusb::DeviceHandle<rusb::Context>) -> Result<KingstIdentity> {
    let mut buf = [0u8; 8];
    ctrl_in(handle, CMD_EEPROM, EEPROM_MAGIC_OFFSET, &mut buf)?;

    let (magic, magic2) = parse_identity_bytes(&buf).ok_or_else(|| {
        CoreError::Usb(format!(
            "Kingst EEPROM identification bytes are inconsistent: {buf:02x?}"
        ))
    })?;

    let model_index = lookup_model(magic, magic2).ok_or_else(|| {
        CoreError::Usb(format!(
            "Kingst device reports unknown model magic {magic:#04x}/{magic2:#04x}; \
             known magics: {}",
            MODELS
                .iter()
                .map(|model| format!("{:#04x}", model.magic))
                .collect::<Vec<_>>()
                .join(", ")
        ))
    })?;

    // The manufacturing date is a nicety, not a requirement.
    let mut date = [0u8; 4];
    let manufactured = match ctrl_in(handle, CMD_EEPROM, EEPROM_DATE_OFFSET, &mut date) {
        Ok(()) if date[1] ^ date[3] == 0xff && date[0] ^ date[2] == 0xff => {
            Some(format!("20{:02x}-{:02x}", date[0], date[1]))
        }
        _ => None,
    };

    Ok(KingstIdentity {
        magic,
        magic2,
        manufactured,
        model_index,
    })
}

// ---------------------------------------------------------------------------
// FPGA bring-up
// ---------------------------------------------------------------------------

fn read_fpga_register(handle: &rusb::DeviceHandle<rusb::Context>, register: u16, buf: &mut [u8]) -> Result<()> {
    ctrl_in(handle, CMD_FPGA_SPI, register, buf)
}

/// Whether the FPGA already runs a bitstream.
///
/// The hardware cannot be asked for a version, so this is a plausibility check
/// on two registers, biased to "no" when in doubt: another upload costs ~600 ms,
/// which is cheaper than misreading a register as a working bitstream.
fn fpga_is_ready(handle: &rusb::DeviceHandle<rusb::Context>) -> bool {
    let mut init = [0u8; 1];
    if ctrl_in(handle, CMD_FPGA_INIT, 0, &mut init).is_err() || init[0] != 0 {
        return false;
    }

    let mut run = [0u8; 2];
    if read_fpga_register(handle, REG_RUN, &mut run).is_err() {
        return false;
    }
    let run_state = u16::from_le_bytes(run);
    if run_state != 0 && (run_state & 0x3) != 0x1 {
        return false;
    }
    if run_state != 0 && (run_state & !0xf) != 0x85e0 {
        return false;
    }

    let mut pwm = [0u8; 1];
    if read_fpga_register(handle, REG_PWM_EN, &mut pwm).is_err() {
        return false;
    }
    pwm[0] & 0x3 == 0
}

/// Upload the FPGA bitstream over EP2.
///
/// The device is told the size first, then the image arrives in 4 KiB bulk
/// transfers, zero padded to a 4 KiB boundary.
fn upload_fpga_bitstream(handle: &rusb::DeviceHandle<rusb::Context>, bitstream: &[u8]) -> Result<()> {
    let size = bitstream.len() as u32;
    ctrl_out(handle, CMD_FPGA_INIT, 0, &size.to_le_bytes())?;

    let padded = size as usize;
    let zero_pad_to = padded.div_ceil(EP2_PADDING) * EP2_PADDING;

    let mut block = vec![0u8; EP2_PADDING];
    let mut position = 0usize;
    while position < zero_pad_to {
        let take = (zero_pad_to - position).min(EP2_PADDING);
        block[..take].fill(0);
        if position < bitstream.len() {
            let end = (position + take).min(bitstream.len());
            let copy = end - position;
            block[..copy].copy_from_slice(&bitstream[position..end]);
        }

        let written = handle.write_bulk(EP_FPGA_BITSTREAM, &block[..take], DEFAULT_TIMEOUT)?;
        if written != take {
            return Err(CoreError::Usb(format!(
                "short write for the Kingst FPGA bitstream at offset {position}: {written} of {take} bytes"
            )));
        }
        position += take;
    }

    Ok(())
}

/// Complete the FPGA bring-up after a bitstream upload.
fn enable_fpga(handle: &rusb::DeviceHandle<rusb::Context>) -> Result<()> {
    let mut response = [0u8; 1];
    ctrl_in(handle, CMD_FPGA_INIT, 0, &mut response)?;
    if response[0] != 0 {
        return Err(CoreError::Usb(format!(
            "unexpected Kingst FPGA upload response {:#04x}, expected 0",
            response[0]
        )));
    }
    std::thread::sleep(FPGA_SETTLE);

    ctrl_out(handle, CMD_FPGA_ENABLE, 0x01, &[])?;
    std::thread::sleep(FPGA_ENABLE_SETTLE);
    Ok(())
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

/// Acquisition mode register: capture into the device's SDRAM.
const CAPTMODE_TO_RAM: u8 = 0x00;
/// Acquisition mode register: stream to the host without using SDRAM.
const CAPTMODE_STREAM: u8 = 0x01;
/// Run-mode value that starts a capture.
const RUNMODE_RUN: u8 = 0x03;
/// Run-mode value that halts a capture.
const RUNMODE_HALT: u8 = 0x00;
/// `REG_RUN` bit set while the device is idle.
const RUNSTATE_IDLE_BIT: u16 = 1 << 0;

const REG_CAPT_MODE: u16 = 0x03;
/// Live input levels.
const REG_PIN_STATE: u16 = 0x04;
const REG_BULK: u16 = 0x08;
const REG_SAMPLING: u16 = 0x10;
const REG_TRIGGER: u16 = 0x20;
const REG_THRESHOLD: u16 = 0x68;

/// Bulk IN endpoint carrying captured samples.
const EP_CAPTURE_DATA: u8 = 0x86;

/// Largest sample count the hardware accepts.
const MAX_SAMPLES: u64 = 10_000_000_000;
/// Threshold used when the caller does not pick one.
const DEFAULT_THRESHOLD_VOLTS: f64 = 3.3;
/// Bulk read size. The reference uses 512 KiB with an 8-deep transfer pool;
/// a single synchronous reader is enough here.
const BULK_CHUNK: usize = 512 * 1024;
/// Read size for streaming.
///
/// A bulk IN transfer that reaches its timeout is cancelled, and the
/// synchronous API drops whatever the transfer had already received. The buffer
/// therefore has to fill comfortably inside the read timeout — at 512 KiB the
/// device never filled it, so every read timed out and threw its bytes away.
///
/// Bigger is not better, which is the trap here: 256 KiB makes the device stop
/// delivering after the first transfer, and 64 KiB reached only 55% of the
/// rate against 32 KiB's 80-83%. The FX2 does not cope with large transfers.
/// Sustained throughput stays below the device's maximum either way, which is
/// what the reference driver's pool of concurrent transfers is for.
/// Fallback read size when the rate cannot be turned into one, which only
/// happens for a degenerate configuration.
const STREAM_CHUNK_MIN: usize = 32 * 1024;
/// Timeout for one streaming read. Sized against `STREAM_CHUNK`: the buffer has
/// to fill well inside it, which at the measured ~15 MB/s is 17 ms.
/// Transfers kept in flight on the sample endpoint.
///
/// This is the number that decides whether the capture survives a busy host. The
/// device tolerates about two milliseconds of stall before its stream dies and
/// cannot be restarted; eight transfers of ten milliseconds each give it roughly
/// eighty milliseconds of queue to write into instead.
const POOL_DEPTH: usize = bulk_in_pool::DEFAULT_POOL_DEPTH;

/// How long one service call may wait for data before returning, so the caller
/// can notice a cancellation promptly.
const SERVICE_SLICE: Duration = Duration::from_millis(100);
/// How long to wait for the device to finish sampling before giving up.
const CAPTURE_TIMEOUT: Duration = Duration::from_secs(30);
const CAPTURE_POLL: Duration = Duration::from_millis(20);
/// Timeout for one bulk read. Long enough for a full 512 KiB chunk.
const BULK_TIMEOUT: Duration = Duration::from_millis(500);
/// How long a stream may produce nothing before it is treated as stalled.
/// Empty transfers are normal; a gap this long is not.
const STREAM_STALL_TIMEOUT: Duration = Duration::from_secs(10);
/// Streaming bandwidth the USB link can actually sustain, in Mbps. Above this
/// the device throttles and drops samples. Matches the reference's warning
/// threshold.
const STREAM_MBPS_MAX: u64 = 200;

/// Byte-level layout of one transfer in device memory.
///
/// 16-channel models pack 5 packets of `u16 pins + u8 repeat` plus one
/// sequence byte into 16 bytes; 32-channel models pack 6 packets of
/// `u32 pins + u8 repeat` plus two sequence bytes into 32 bytes. The
/// sequence bytes are not checked — the reference ignores them too, calling
/// the numbering "weak".
struct TransferLayout {
    transfer_size: usize,
    sequence_size: usize,
    unit_size: usize,
    packets_per_chunk: usize,
}

impl TransferLayout {
    fn for_model(model: &KingstModel) -> Self {
        let (transfer_size, sequence_size, unit_size) = if model.channels > 16 {
            (32usize, 2usize, 4usize)
        } else {
            (16usize, 1usize, 2usize)
        };
        let packets_per_chunk = (transfer_size - sequence_size) / (unit_size + 1);
        Self {
            transfer_size,
            sequence_size,
            unit_size,
            packets_per_chunk,
        }
    }
}

/// What `REG_SAMPLING` reports back after a capture.
///
/// The register is write-only in the configuration direction and read-only in
/// the status direction, with completely different meanings — a vendor quirk
/// the reference documents.
struct CaptureInfo {
    /// Number of compressed packets written, i.e. `packets_per_chunk` per
    /// transfer times the number of transfers.
    n_rep_packets: u32,
    /// Write cursor in device memory.
    write_pos: u32,
}

/// Program the input threshold DAC.
///
/// Two PWM channels feed a bias DAC; the duty values are the vendor's own
/// piecewise-linear fit, transcribed from the reference implementation.
fn set_threshold_voltage(handle: &rusb::DeviceHandle<rusb::Context>, voltage: f64) -> Result<()> {
    let voltage = voltage.clamp(-4.0, 4.0);

    let (duty_r79, mut duty_r56) = if voltage >= 2.9 {
        (0x0000u16, (302.0 * voltage - 363.0) as i64)
    } else if voltage > -0.4 {
        (0x00f2u16, (302.0 * voltage + 121.0) as i64)
    } else {
        (0x02d7u16, (302.0 * voltage + 1090.0) as i64)
    };
    duty_r56 = duty_r56.clamp(10, 1100);
    let duty_r56 = duty_r56 as u16;

    let mut buf = [0u8; 4];
    buf[..2].copy_from_slice(&duty_r56.to_le_bytes());
    buf[2..].copy_from_slice(&duty_r79.to_le_bytes());
    ctrl_out(handle, CMD_FPGA_SPI, REG_THRESHOLD, &buf)
}

/// Write the 16-byte acquisition configuration to `REG_SAMPLING`.
fn configure_sampling(
    handle: &rusb::DeviceHandle<rusb::Context>,
    model: &KingstModel,
    sample_rate_hz: u64,
    sample_count: u64,
) -> Result<u64> {
    if sample_rate_hz == 0 || sample_rate_hz > model.samplerate {
        return Err(CoreError::InvalidSamplerate(sample_rate_hz));
    }

    let baseclock = model.samplerate;
    let divider = (baseclock / sample_rate_hz) as u16;
    if divider == 0 {
        return Err(CoreError::InvalidSamplerate(sample_rate_hz));
    }
    // The hardware divides the base clock, so the achieved rate is quantised.
    let effective_rate = baseclock / u64::from(divider);
    if effective_rate > model.samplerate {
        return Err(CoreError::InvalidSamplerate(sample_rate_hz));
    }

    let limit_samples = match sample_count {
        0 => MAX_SAMPLES,
        count => count.min(MAX_SAMPLES),
    };

    // No trigger is configured, so there is no pre-trigger budget. The
    // reference still writes a non-zero memory limit because the hardware
    // shifts it right by 8 before storing it.
    let pre_trigger_samples = 0u64;
    let pre_trigger_memory = 0x100u64;

    let mut buf = Vec::with_capacity(16);
    buf.extend_from_slice(&limit_samples.to_le_bytes()[..5]); // u40le
    buf.extend_from_slice(&pre_trigger_samples.to_le_bytes()[..5]); // u40le
    buf.extend_from_slice(&(pre_trigger_memory >> 8).to_le_bytes()[..3]); // u24le
    buf.extend_from_slice(&divider.to_le_bytes()); // u16le
    buf.push(0); // unknown, always zero
    ctrl_out(handle, CMD_FPGA_SPI, REG_SAMPLING, &buf)?;

    Ok(effective_rate)
}

/// Mask of the channels a capture will record.
///
/// This ends up in the first word of the trigger configuration, which is what
/// actually tells the device which channels to sample. Getting it wrong is not
/// a subtle failure: a zero mask makes the device capture nothing, and every
/// sample reads back as zero at every threshold.
fn enabled_channel_mask(enabled: &[u8]) -> u32 {
    enabled
        .iter()
        .fold(0u32, |mask, channel| mask | (1u32 << channel))
}

/// Write the trigger configuration, which also carries the enabled channels.
///
/// Four `u32le` values. The first is **not** a trigger field: it is the mask of
/// enabled logic channels, and the device captures nothing at all when it is
/// zero. The reference treats a zero mask as an argument error. The remaining
/// three describe the trigger condition; all zero means "no trigger", which is
/// what this driver asks for.
///
/// The reference passes a literal `16` as the request index here and zero
/// everywhere else.
fn configure_trigger(
    handle: &rusb::DeviceHandle<rusb::Context>,
    enabled_mask: u32,
) -> Result<()> {
    if enabled_mask == 0 {
        return Err(CoreError::InvalidChannelCount(0));
    }
    let mut buf = [0u8; 16];
    buf[..4].copy_from_slice(&enabled_mask.to_le_bytes());
    ctrl_out_indexed(handle, CMD_FPGA_SPI, REG_TRIGGER, 16, &buf)
}

fn set_run_mode(handle: &rusb::DeviceHandle<rusb::Context>, mode: u8) -> Result<()> {
    ctrl_out(handle, CMD_FPGA_SPI, REG_RUN, &[mode])
}

fn run_state(handle: &rusb::DeviceHandle<rusb::Context>) -> Result<u16> {
    let mut buf = [0u8; 2];
    ctrl_in(handle, CMD_FPGA_SPI, REG_RUN, &mut buf)?;
    Ok(u16::from_le_bytes(buf))
}

fn wait_until_idle(handle: &rusb::DeviceHandle<rusb::Context>) -> Result<()> {
    let deadline = Instant::now() + CAPTURE_TIMEOUT;
    // Give the device a moment to leave idle before polling for its return,
    // otherwise an immediate poll can observe the pre-start idle state.
    std::thread::sleep(CAPTURE_POLL);
    loop {
        let state = run_state(handle)?;
        if state & RUNSTATE_IDLE_BIT != 0 {
            return Ok(());
        }
        if Instant::now() > deadline {
            return Err(CoreError::Usb(format!(
                "Kingst capture did not finish within {CAPTURE_TIMEOUT:?} (run state {state:#06x})"
            )));
        }
        std::thread::sleep(CAPTURE_POLL);
    }
}

fn read_capture_info(handle: &rusb::DeviceHandle<rusb::Context>) -> Result<CaptureInfo> {
    let mut buf = [0u8; 12];
    ctrl_in(handle, CMD_FPGA_SPI, REG_SAMPLING, &mut buf)?;
    Ok(CaptureInfo {
        n_rep_packets: u32::from_le_bytes(buf[0..4].try_into().unwrap()),
        // Bytes 4..8 hold the trigger packet index. No trigger is configured,
        // so there is nothing to report yet.
        write_pos: u32::from_le_bytes(buf[8..12].try_into().unwrap()),
    })
}

/// Expand a raw download chunk into packed sample words.
///
/// Each packet is a pin-value word plus a repeat count: the value held for
/// that many consecutive samples. Expanding it here is what turns the device's
/// run-length stream into the packed layout the rest of SigPilot consumes, so
/// downstream code cannot tell a Kingst capture from a PXLogic one.
fn expand_chunk(
    chunk: &[u8],
    layout: &TransferLayout,
    samples: &mut Vec<u8>,
) -> Result<u64> {
    if chunk.len() % layout.transfer_size != 0 {
        return Err(CoreError::Decode(format!(
            "Kingst chunk of {} bytes is not a multiple of the {}-byte transfer size",
            chunk.len(),
            layout.transfer_size
        )));
    }

    let mut emitted = 0u64;
    for transfer in chunk.chunks_exact(layout.transfer_size) {
        let mut cursor = 0usize;
        for _ in 0..layout.packets_per_chunk {
            let value = &transfer[cursor..cursor + layout.unit_size];
            cursor += layout.unit_size;
            let repetitions = transfer[cursor] as usize;
            cursor += 1;
            for _ in 0..repetitions {
                samples.extend_from_slice(value);
            }
            emitted += repetitions as u64;
        }
        // Trailing sequence bytes are deliberately not validated.
        let _ = layout.sequence_size;
    }
    Ok(emitted)
}

/// Whether a device id belongs to this driver.
///
/// The command layer needs this to route a capture without re-deriving the
/// scheme itself.
pub fn owns(device_id: &str) -> bool {
    device_id
        .split_once(':')
        .is_some_and(|(scheme, _)| scheme == ID_SCHEME)
}

/// Program the input threshold without starting a capture.
///
/// Diagnostic entry point. Comparing [`read_live_pin_state`] across thresholds
/// tells you whether the threshold write reaches the comparator at all: if the
/// live reading never changes, the DAC is not being applied.
pub fn set_input_threshold(device_id: &str, volts: f64) -> Result<()> {
    let driver = KingstLa2016Driver::new();
    // A previous `prepare` may have made the device re-enumerate, so the
    // caller's id can be stale; resolve it rather than trusting it.
    let handle = driver.open_device(&driver.resolve_device_id(device_id)?)?;
    ctrl_out(&handle, CMD_FPGA_SPI, REG_PWM_EN, &[0u8])?;
    set_threshold_voltage(&handle, volts)
}

/// Dump the whole FPGA register space, for diagnostics.
///
/// The hardware cannot be asked for its configuration, so the register space is
/// the only view of the FPGA's state. The reference has the same helper behind
/// its spew log level.
pub fn dump_fpga_registers(device_id: &str) -> Result<Vec<u8>> {
    let driver = KingstLa2016Driver::new();
    // A previous `prepare` may have made the device re-enumerate, so the
    // caller's id can be stale; resolve it rather than trusting it.
    let handle = driver.open_device(&driver.resolve_device_id(device_id)?)?;
    let mut registers = [0u8; 0x80];
    ctrl_in(&handle, CMD_FPGA_SPI, 0, &mut registers)?;
    Ok(registers.to_vec())
}

/// Read the FPGA's live pin state.
///
/// The device cannot be read back for its configuration, but this register does
/// report the current input levels. That makes it the fastest way to tell a
/// wiring problem from a capture problem: if this register never changes while
/// a signal is applied, the signal is not reaching the FPGA, and nothing about
/// the capture path is at fault.
pub fn read_live_pin_state(device_id: &str) -> Result<u16> {
    let driver = KingstLa2016Driver::new();
    // A previous `prepare` may have made the device re-enumerate, so the
    // caller's id can be stale; resolve it rather than trusting it.
    let handle = driver.open_device(&driver.resolve_device_id(device_id)?)?;
    let mut buf = [0u8; 2];
    ctrl_in(&handle, CMD_FPGA_SPI, REG_PIN_STATE, &mut buf)?;
    Ok(u16::from_le_bytes(buf))
}

/// Capture samples and return them in SigPilot's packed format.
///
/// The device samples into its own SDRAM and is downloaded afterwards, so this
/// blocks until the capture completes. Readiness is ensured first: [`bring_up`]
/// is idempotent and returns quickly once the FPGA bitstream is running, so a
/// caller that forgot to `prepare` still works.
///
/// `progress` is called after every bulk chunk.
/// Acquire into the device's SDRAM, then download the window it wrote.
///
/// The device stops on its own once the requested sample count is reached, so
/// this blocks until the run state reports idle.
fn capture_to_memory(
    handle: &rusb::DeviceHandle<rusb::Context>,
    layout: &TransferLayout,
    on_samples: &mut dyn FnMut(&[u8]),
    progress: &mut dyn FnMut(CaptureProgress),
    diagnostics: &mut dyn FnMut(DiagnosticEvent),
) -> Result<(Vec<u8>, u64)> {
    set_run_mode(handle, RUNMODE_RUN)?;
    wait_until_idle(handle)?;

    let info = read_capture_info(handle)?;
    let transfers = info.n_rep_packets as usize / layout.packets_per_chunk;
    let bytes_to_read = transfers * layout.transfer_size;
    if bytes_to_read == 0 {
        return Err(CoreError::Decode(
            "Kingst capture produced no samples; check the input threshold and the sample rate"
                .to_string(),
        ));
    }
    let read_pos = info.write_pos.wrapping_sub(bytes_to_read as u32);
    diagnostics(DiagnosticEvent {
        phase: "kingst-capture".to_string(),
        level: DiagnosticLevel::Info,
        message: format!(
            "capture info: {} packets, write_pos {:#010x}, reading {:#010x}..{:#010x} ({} bytes)",
            info.n_rep_packets,
            info.write_pos,
            read_pos,
            read_pos.wrapping_add(bytes_to_read as u32),
            bytes_to_read
        ),
    });

    // Point the device's bulk engine at the window it just wrote.
    let mut bulk = [0u8; 8];
    bulk[..4].copy_from_slice(&read_pos.to_le_bytes());
    bulk[4..].copy_from_slice(&(bytes_to_read as u32).to_le_bytes());
    ctrl_out(handle, CMD_FPGA_SPI, REG_BULK, &bulk)?;
    ctrl_out(handle, CMD_BULK_START, 0x00, &[])?;

    let mut samples = Vec::with_capacity(bytes_to_read * 4 / layout.transfer_size);
    let mut remaining = bytes_to_read;
    let mut buffer = vec![0u8; BULK_CHUNK.min(bytes_to_read)];
    let mut samples_read = 0u64;
    // Keep a copy of the leading raw bytes. Interpreting the packet format is
    // exactly the step that can hide a bug, so the raw payload has to be
    // inspectable before expansion.
    let mut raw_preview: Vec<u8> = Vec::new();

    while remaining > 0 {
        let want = remaining.min(buffer.len());
        let got = handle
            .read_bulk(EP_CAPTURE_DATA, &mut buffer[..want], BULK_TIMEOUT)
            .map_err(|error| {
                CoreError::Usb(format!(
                    "Kingst bulk read failed after {samples_read} samples: {error}"
                ))
            })?;
        if got == 0 {
            return Err(CoreError::Usb(
                "Kingst bulk read returned no data before the capture was complete".to_string(),
            ));
        }
        if raw_preview.len() < 64 {
            let take = (64 - raw_preview.len()).min(got);
            raw_preview.extend_from_slice(&buffer[..take]);
        }
        samples_read += expand_chunk(&buffer[..got], layout, &mut samples)?;
        remaining -= got;
        progress(CaptureProgress {
            bytes_read: (bytes_to_read - remaining) as u64,
            bytes_expected: bytes_to_read as u64,
            samples_read,
            sample_memory_bytes: bytes_to_read as u64,
        });
    }

    diagnostics(DiagnosticEvent {
        phase: "kingst-capture".to_string(),
        level: DiagnosticLevel::Info,
        message: format!(
            "raw payload head ({} bytes): {}",
            raw_preview.len(),
            raw_preview
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<Vec<_>>()
                .join(" ")
        ),
    });

    // Capture-to-memory is atomic from the device's point of view, so the
    // samples only exist once the download is done. Hand them over in one go;
    // there is nothing incremental to report.
    on_samples(&samples);

    Ok((samples, samples_read))
}

/// Stream samples straight to the host, bypassing the device's SDRAM.
///
/// Runs until `cancel` is set. A stream is deliberately open-ended, matching
/// how the real-hardware backends behave: the caller stops it, and the app does
/// so when its capture buffer fills. `duration_ms` does not bound a stream —
/// only the demo backend treats it as a limit, and honouring it here would cut
/// every capture off after the client's default of a few milliseconds.
///
/// The run mode is set as late as possible, immediately before the first read:
/// the reference notes that a pause between starting the run mode and receiving
/// data stalls the stream, because the FX2 FIFO overflows in the meantime.
/// Block size that streaming accumulates samples in.
///
/// Blocks rather than one `Vec`, because a `Vec` grows by doubling and every
/// doubling copies everything captured so far. Tens of megabytes in, that copy
/// runs for milliseconds, and for those milliseconds no USB read is in flight:
/// the FX2 FIFO overflows and the device stops sending. Captures were observed
/// ending just past 2, 8, 13, 16, 32, 62 and 64 MB — the doubling points of
/// exactly such a `Vec`, which is what pointed at this.
const SAMPLE_BLOCK: usize = 4 * 1024 * 1024;

/// Stream samples, accumulated in fixed-size blocks.
///
/// Appending never moves bytes already in a block, so the hot path stops
/// allocating once the blocks are warm. The blocks are flattened once at the
/// end, after the device has been halted and a long copy can no longer starve
/// the reader.
struct SampleBlocks {
    blocks: Vec<Vec<u8>>,
    open: Vec<u8>,
}

impl SampleBlocks {
    fn new(block_bytes: usize) -> Self {
        let mut open = Vec::new();
        open.reserve_exact(block_bytes);
        Self {
            blocks: Vec::new(),
            open,
        }
    }

    /// Appends `bytes` and returns exactly what was appended, as one slice.
    ///
    /// The slice is contiguous because a block is closed only *before* an append
    /// that would not fit, never in the middle of one.
    fn extend(&mut self, bytes: &[u8]) -> &[u8] {
        if !self.open.is_empty() && self.open.len() + bytes.len() > SAMPLE_BLOCK {
            let full = std::mem::replace(&mut self.open, Vec::new());
            self.blocks.push(full);
            self.open.reserve_exact(SAMPLE_BLOCK);
        }
        let before = self.open.len();
        self.open.extend_from_slice(bytes);
        &self.open[before..]
    }

    fn into_vec(self) -> Vec<u8> {
        if self.blocks.is_empty() {
            return self.open;
        }
        let total = self.blocks.iter().map(Vec::len).sum::<usize>() + self.open.len();
        let mut flat = Vec::with_capacity(total);
        for block in &self.blocks {
            flat.extend_from_slice(block);
        }
        flat.extend_from_slice(&self.open);
        flat
    }
}

fn capture_streaming(
    handle: &rusb::DeviceHandle<rusb::Context>,
    model: &KingstModel,
    enabled_channels: &[u8],
    settings: &CaptureSettings,
    cancel: &AtomicBool,
    on_samples: &mut dyn FnMut(&[u8]),
    progress: &mut dyn FnMut(CaptureProgress),
    diagnostics: &mut dyn FnMut(DiagnosticEvent),
) -> Result<(Vec<u8>, u64)> {
    let stream = StreamLayout::for_model(model, enabled_channels);
    let unit_size = stream.entity_size as u64;

    // USB 2.0 high speed carries roughly 40 MB/s, and the reference warns above
    // 200 Mbps. Exceeding the budget does not fail: the device throttles and
    // samples are lost, so the capture just looks slow and short. Say so rather
    // than letting the user conclude the driver is broken.
    let megabits = settings.sample_rate_hz.saturating_mul(stream.channel_masks.len() as u64)
        / 1_000_000;
    if megabits > STREAM_MBPS_MAX {
        // Through the diagnostic sink rather than `tracing`, because this has to
        // reach the UI and the command-line tools, not just the log file.
        diagnostics(DiagnosticEvent {
            phase: "kingst-capture".to_string(),
            level: DiagnosticLevel::Warn,
            message: format!(
                "streaming {} MHz across {} channels needs about {} Mbps, more than USB 2.0 can \
                 carry; the device will throttle and drop samples. Lower the sample rate, enable \
                 fewer channels, or use capture-to-memory mode.",
                settings.sample_rate_hz / 1_000_000,
                stream.channel_masks.len(),
                megabits
            ),
        });
    }

    // Size each read the way the PXLogic backend does — about ten milliseconds
    // of data per enabled channel, rounded up to a page, capped by what USB 2.0
    // carries in the same ten milliseconds. A fixed size cannot be right for
    // every rate: 32 KiB fills in 1.6 ms at 20 MHz across 8 channels and in
    // 131 ms at 2 MHz. Too small and the per-read overhead eats the slack that
    // keeps the device's FIFO from overflowing; too large and the read outlives
    // the poll interval. Only the enabled channels are transmitted in stream
    // mode, so those are what the size is computed from.
    let stream_chunk = pxview_capture_transfer_size(
        settings.sample_rate_hz,
        stream.channel_masks.len() as u8,
        false,
    )
    .unwrap_or(STREAM_CHUNK_MIN)
    .max(STREAM_CHUNK_MIN);

    diagnostics(DiagnosticEvent {
        phase: "kingst-capture".to_string(),
        level: DiagnosticLevel::Info,
        message: format!(
            "streaming {} channels, {} bytes per block of {} samples, {} KiB per read, until cancelled",
            stream.channel_masks.len(),
            stream.block_bytes(),
            StreamLayout::SAMPLES_PER_BLOCK,
            stream_chunk / 1024,
        ),
    });

    set_run_mode(handle, RUNMODE_RUN)?;
    ctrl_out(handle, CMD_BULK_START, 0x00, &[])?;

    let mut parser = StreamParser::default();
    let mut blocks = SampleBlocks::new(SAMPLE_BLOCK);
    let mut expanded: Vec<u8> = Vec::new();
    let mut samples_read = 0u64;
    let mut raw_preview: Vec<u8> = Vec::new();
    let mut last_data = Instant::now();
    let mut worst_gap = Duration::ZERO;
    // A per-second rate line, because "it stopped early" needs a timeline to be
    // diagnosable: this shows whether the device produced steadily and then
    // stopped, or trickled from the start.
    let mut rate_window = Instant::now();
    let mut rate_mark = 0u64;
    // Experiment, not a feature: hold the reader still for a chosen number of
    // milliseconds, once, after data has started arriving. Whatever the device
    // does next is a direct measurement of how much host jitter its buffering
    // absorbs — the slack that decides whether a stray scheduling delay ends the
    // capture. Set by the check tool; absent in normal operation.
    let stall_probe_ms: u64 = std::env::var("SIGPILOT_KINGST_STALL_PROBE_MS")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(0);
    let mut stall_probe: Option<u64> = (stall_probe_ms > 0).then_some(stall_probe_ms);
    let mut stall_at: Option<u64> = None;

    // The pool is what keeps this capture alive. A single transfer in flight is
    // not enough for a device that tolerates two milliseconds of host stall;
    // eight give it a queue to write into while the host is busy elsewhere.
    let mut pool = BulkInPool::start(handle, EP_CAPTURE_DATA, stream_chunk, POOL_DEPTH)?;

    let mut stalled = false;
    let mut failure: Option<CoreError> = None;
    loop {
        if cancel.load(Ordering::Acquire) {
            break;
        }
        // Empty transfers are legal while a stream is running, but a long gap
        // means the device stopped producing rather than merely being idle.
        if last_data.elapsed() > STREAM_STALL_TIMEOUT {
            stalled = true;
            diagnostics(DiagnosticEvent {
                phase: "kingst-capture".to_string(),
                level: DiagnosticLevel::Warn,
                message: format!(
                    "no stream data for {STREAM_STALL_TIMEOUT:?}; stopping after {samples_read} samples"
                ),
            });
            break;
        }

        if let Some(ms) = stall_probe.take() {
            stall_at = Some(samples_read);
            std::thread::sleep(Duration::from_millis(ms));
        }

        let serviced_at = Instant::now();
        let serviced = pool.service(SERVICE_SLICE, &mut |chunk: &[u8]| {
            if raw_preview.len() < 64 {
                let take = (64 - raw_preview.len()).min(chunk.len());
                raw_preview.extend_from_slice(&chunk[..take]);
            }
            // Publish only what this chunk added, so the graph grows live
            // instead of the whole capture landing at the end.
            expanded.clear();
            samples_read += expand_stream_chunk(chunk, &stream, &mut parser, &mut expanded)?;
            on_samples(blocks.extend(&expanded));
            if rate_window.elapsed() >= Duration::from_secs(1) {
                let elapsed = rate_window.elapsed();
                diagnostics(DiagnosticEvent {
                    phase: "kingst-capture".to_string(),
                    level: DiagnosticLevel::Info,
                    message: format!(
                        "stream rate: {:.2} Ms/s over {:.2} s ({} samples so far, worst read gap {:.1} ms)",
                        (samples_read - rate_mark) as f64 / elapsed.as_secs_f64() / 1e6,
                        elapsed.as_secs_f64(),
                        samples_read,
                        worst_gap.as_secs_f64() * 1000.0
                    ),
                });
                rate_mark = samples_read;
                rate_window = Instant::now();
            }
            progress(CaptureProgress {
                bytes_read: samples_read * unit_size,
                // A stream has no planned length; the caller decides when to
                // stop, so report what has arrived as the expectation too.
                bytes_expected: samples_read * unit_size,
                samples_read,
                // Bytes, not samples: the caller accounts capture memory in
                // bytes, and reporting samples here makes the buffer limit
                // take `unit_size` times too long to trip.
                sample_memory_bytes: samples_read * unit_size,
            });
            Ok(())
        });

        match serviced {
            Ok(delivered) => {
                if delivered.bytes > 0 {
                    last_data = Instant::now();
                    let gap = serviced_at.elapsed();
                    if gap > worst_gap {
                        worst_gap = gap;
                    }
                }
            }
            Err(error) => {
                failure = Some(error);
                break;
            }
        }
        if pool.device_gone() {
            failure = Some(CoreError::Usb(
                "the Kingst device disappeared during a stream".to_string(),
            ));
            break;
        }
    }

    // Cancel before halting: the device must not be told to stop while the host
    // still has reads queued against it.
    pool.stop();
    if let Some(error) = failure {
        return Err(error);
    }

    // Always halt, including on the cancel path, or the device keeps streaming
    // into a FIFO nobody is draining.
    set_run_mode(handle, RUNMODE_HALT)?;

    // Both the log file and the diagnostic sink: the sink reaches the UI, which
    // is no help when reading a log after the fact, and this is the one line
    // that explains a capture that ended earlier than the caller expected.
    let reason = if stalled {
        "the device went quiet"
    } else {
        "cancelled by the caller"
    };
    tracing::info!(
        samples = samples_read,
        bytes = samples_read * unit_size,
        reason,
        "Kingst stream finished"
    );

    diagnostics(DiagnosticEvent {
        phase: "kingst-capture".to_string(),
        level: DiagnosticLevel::Info,
        message: format!(
            "stream stopped after {samples_read} samples ({}); raw head ({} bytes): {}",
            if stalled {
                "the device went quiet"
            } else {
                "cancelled by the caller"
            },
            raw_preview.len(),
            raw_preview
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<Vec<_>>()
                .join(" ")
        ),
    });

    // The worst gap in the read loop is the number that explains a capture which
    // ended earlier than the caller expected: a gap long enough for the device's
    // FIFO to overflow is what stops the stream, and it is otherwise invisible.
    diagnostics(DiagnosticEvent {
        phase: "kingst-capture".to_string(),
        level: DiagnosticLevel::Info,
        message: format!(
            "stream read statistics: {samples_read} samples, worst read gap {:.1} ms",
            worst_gap.as_secs_f64() * 1000.0
        ),
    });
    if let Some(at) = stall_at {
        diagnostics(DiagnosticEvent {
            phase: "kingst-capture".to_string(),
            level: DiagnosticLevel::Info,
            message: format!(
                "stall probe: held the reader for {} ms at {at} samples; {} samples arrived afterwards",
                stall_probe_ms,
                samples_read.saturating_sub(at)
            ),
        });
    }

    Ok((blocks.into_vec(), samples_read))
}

/// Build the capture metadata.
///
/// Used twice: once with a zero count to announce the capture before any data
/// exists, and once with the achieved count for the result.
fn capture_metadata(
    device_id: &str,
    effective_rate: u64,
    channel_count: u8,
    enabled_channels: &[u8],
    unitsize: u8,
    sample_count: u64,
) -> CaptureMetadata {
    CaptureMetadata {
        version: 1,
        // The app treats `source_device` as the device *id*, not a label: after a
        // capture it feeds this value back in as the session's device and passes
        // it to the next command. Every other driver stores the device id here,
        // so a friendly name makes the session stop resolving and every later
        // capture fails.
        source_device: device_id.to_string(),
        sample_rate_hz: effective_rate,
        channel_count,
        enabled_channels: enabled_channels.to_vec(),
        unitsize,
        sample_count,
        captured_at: chrono::Utc::now(),
        labels: (0..channel_count)
            .map(|channel| format!("D{channel}"))
            .collect(),
        trigger: None,
    }
}

/// Capture samples and return them in SigPilot's packed format.
///
/// Two acquisition modes, matching [`CaptureMode`]:
///
/// * [`CaptureMode::Buffer`] samples into the device's SDRAM and downloads
///   afterwards, so the call blocks for the whole duration.
/// * [`CaptureMode::Stream`] streams to the host without touching SDRAM. It runs
///   until the sample limit implied by `duration_ms`, or until `cancel` is set;
///   a `duration_ms` of zero means "until cancelled".
///
/// Readiness is ensured first: [`KingstLa2016Driver::bring_up`] is idempotent and
/// returns quickly once the FPGA bitstream is running, so a caller that forgot
/// to `prepare` still works.
pub fn capture(
    device_id: &str,
    settings: &CaptureSettings,
    cancel: &AtomicBool,
    started: &mut dyn FnMut(&CaptureMetadata),
    on_samples: &mut dyn FnMut(&[u8]),
    diagnostics: &mut dyn FnMut(DiagnosticEvent),
    progress: &mut dyn FnMut(CaptureProgress),
) -> Result<CaptureData> {
    let driver = KingstLa2016Driver::new();
    driver.bring_up(device_id, diagnostics)?;

    // `bring_up` may have just made the device re-enumerate, so resolve again
    // rather than trusting the caller's id. Reporting the resolved id back in
    // the metadata is what lets the caller adopt it and heal a stale session.
    let device_id = driver.resolve_device_id(device_id)?;
    let handle = driver.open_device(&device_id)?;
    let identity = read_identity(&handle)?;
    let model = identity.model();
    let layout = TransferLayout::for_model(model);

    if settings.channel_count > model.channels {
        return Err(CoreError::InvalidChannelCount(settings.channel_count));
    }

    let sample_count = sample_count_from_duration(settings.sample_rate_hz, settings.duration_ms);

    // The LA series always samples its full channel width into fixed-size words;
    // there is no narrower capture mode. So the metadata must report the
    // *device's* width, not whatever the caller asked for: the graph derives the
    // expected word size from `channel_count` and rejects the pair as
    // inconsistent if they disagree. A caller asking for fewer channels gets
    // them through `enabled_channels`, not by narrowing the capture.
    let channel_count = model.channels;
    let enabled_channels =
        resolve_enabled_channels(channel_count, &settings.enabled_channels)?;
    let enabled_mask = enabled_channel_mask(&enabled_channels);

    // Configuration order follows the reference: threshold, capture mode,
    // trigger (which carries the enabled-channel mask), then the sampling
    // configuration last.
    let threshold = if settings.threshold_volts > 0.0 {
        settings.threshold_volts
    } else {
        DEFAULT_THRESHOLD_VOLTS
    };
    // The input threshold is generated by the same two PWM generators the user
    // PWM feature drives, so make sure that feature is off before relying on the
    // threshold DAC. The reference asserts the same invariant.
    let capture_mode = match settings.mode {
        crate::models::CaptureMode::Buffer => CAPTMODE_TO_RAM,
        crate::models::CaptureMode::Stream => CAPTMODE_STREAM,
    };
    ctrl_out(&handle, CMD_FPGA_SPI, REG_PWM_EN, &[0u8])?;
    set_threshold_voltage(&handle, threshold)?;
    ctrl_out(&handle, CMD_FPGA_SPI, REG_CAPT_MODE, &[capture_mode])?;
    configure_trigger(&handle, enabled_mask)?;
    let effective_rate =
        configure_sampling(&handle, model, settings.sample_rate_hz, sample_count)?;
    ctrl_out(&handle, CMD_BULK_RESET, 0x00, &[])?;

    // Announce the capture before any data exists, exactly as the other
    // backends do. The graph session has to be open before samples can be
    // appended, and appending as they arrive is what makes the waveform grow
    // live instead of appearing all at once when the capture ends.
    started(&capture_metadata(
        &device_id,
        effective_rate,
        channel_count,
        &enabled_channels,
        layout.unit_size as u8,
        0,
    ));

    let (mut samples, mut samples_read) = match settings.mode {
        crate::models::CaptureMode::Buffer => {
            capture_to_memory(&handle, &layout, on_samples, progress, diagnostics)?
        }
        crate::models::CaptureMode::Stream => capture_streaming(
            &handle,
            model,
            &enabled_channels,
            settings,
            cancel,
            on_samples,
            progress,
            diagnostics,
        )?,
    };

    // Capture-to-memory stops on a packet boundary, so the last packet's repeat
    // count can push the total past the requested limit. Trim to what was asked
    // for — but only there: a stream is bounded by `cancel`, not by
    // `duration_ms`, and trimming it to the duration would throw away everything
    // the device sent after the first few milliseconds.
    if matches!(settings.mode, crate::models::CaptureMode::Buffer) && sample_count > 0 {
        let wanted = sample_count as usize * layout.unit_size;
        if samples.len() > wanted {
            samples.truncate(wanted);
            samples_read = sample_count;
        }
    }

    Ok(CaptureData {
        // The achieved count can fall short of the request when the device runs
        // out of sample memory.
        metadata: capture_metadata(
            &device_id,
            effective_rate,
            channel_count,
            &enabled_channels,
            layout.unit_size as u8,
            samples_read,
        ),
        samples,
    })
}

/// Streaming memory layout, which is nothing like the run-length layout used
/// for capture-to-memory.
///
/// Each entity is a pin-value word carrying **16 consecutive samples of a single
/// channel**, least significant bit first. Channels are visited in the order the
/// caller enabled them, and disabled channels occupy no space at all. Once every
/// enabled channel has contributed one entity, a block of 16 samples is complete:
/// sample `n` is assembled from bit `n` of each channel's entity.
struct StreamLayout {
    /// One mask per enabled channel, in streaming order.
    channel_masks: Vec<u32>,
    /// Bytes per entity: 2 for 16-channel models, 4 for 32-channel models.
    entity_size: usize,
}

impl StreamLayout {
    const SAMPLES_PER_BLOCK: usize = 16;

    fn for_model(model: &KingstModel, enabled: &[u8]) -> Self {
        Self {
            channel_masks: enabled.iter().map(|channel| 1u32 << channel).collect(),
            entity_size: if model.channels > 16 { 4 } else { 2 },
        }
    }

    /// Bytes one full round over the enabled channels occupies.
    fn block_bytes(&self) -> usize {
        self.channel_masks.len() * self.entity_size
    }
}

/// Carries the partial block across reads.
///
/// A USB read has no reason to land on a block boundary, so the channel cursor
/// and the samples assembled so far have to survive between chunks. The
/// reference keeps exactly the same state in its stream context.
#[derive(Default)]
struct StreamParser {
    channel_index: usize,
    sample_data: [u32; StreamLayout::SAMPLES_PER_BLOCK],
}

/// Expand a streaming chunk into packed sample words.
fn expand_stream_chunk(
    chunk: &[u8],
    layout: &StreamLayout,
    parser: &mut StreamParser,
    samples: &mut Vec<u8>,
) -> Result<u64> {
    if layout.channel_masks.is_empty() {
        return Err(CoreError::InvalidChannelCount(0));
    }
    if chunk.len() % layout.entity_size != 0 {
        return Err(CoreError::Decode(format!(
            "Kingst stream chunk of {} bytes is not a multiple of the {}-byte entity size",
            chunk.len(),
            layout.entity_size
        )));
    }

    let mut emitted = 0u64;
    for entity in chunk.chunks_exact(layout.entity_size) {
        let value = entity
            .iter()
            .enumerate()
            .fold(0u32, |acc, (byte, raw)| acc | (u32::from(*raw) << (8 * byte)));

        let mask = layout.channel_masks[parser.channel_index];
        for bit in 0..StreamLayout::SAMPLES_PER_BLOCK {
            if value & (1 << bit) != 0 {
                parser.sample_data[bit] |= mask;
            }
        }

        parser.channel_index += 1;
        if parser.channel_index != layout.channel_masks.len() {
            continue;
        }

        for bit in 0..StreamLayout::SAMPLES_PER_BLOCK {
            let sample = parser.sample_data[bit];
            samples.extend_from_slice(&sample.to_le_bytes()[..layout.entity_size]);
        }
        emitted += StreamLayout::SAMPLES_PER_BLOCK as u64;
        parser.sample_data = [0; StreamLayout::SAMPLES_PER_BLOCK];
        parser.channel_index = 0;
    }

    Ok(emitted)
}

/// Samples for a duration, matching how the rest of the app derives limits.
fn sample_count_from_duration(sample_rate_hz: u64, duration_ms: u64) -> u64 {
    if duration_ms == 0 {
        return 0;
    }
    sample_rate_hz.saturating_mul(duration_ms) / 1_000
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

/// [`DeviceDriver`] for the Kingst LA series.
pub struct KingstLa2016Driver {
    descriptor: DeviceDescriptor,
}

impl KingstLa2016Driver {
    pub const DRIVER_ID: &'static str = "kingst-la2016";

    pub fn new() -> Self {
        Self {
            descriptor: DeviceDescriptor {
                driver_id: Self::DRIVER_ID.to_string(),
                display_name: "Kingst LA series".to_string(),
                protocol_version: DeviceDescriptor::PROTOCOL_VERSION,
                vendor: Some("Qingdao Kingst".to_string()),
                isolation: DriverIsolation::InProcess,
                id_schemes: vec![ID_SCHEME.to_string()],
            },
        }
    }

    fn context() -> Result<rusb::Context> {
        rusb::Context::new().map_err(|error| CoreError::Usb(format!("libusb init failed: {error}")))
    }

    /// Open the device behind a `usb-kingst:...` id, with interface 0 claimed.
    ///
    /// Claiming is not optional: the FPGA bitstream and the sample data both
    /// travel over bulk endpoints, and an unclaimed interface rejects them with
    /// `LIBUSB_ERROR_NOT_FOUND` even though control transfers still work.
    fn open_device(&self, device_id: &str) -> Result<rusb::DeviceHandle<rusb::Context>> {
        let context = Self::context()?;
        for device in context.devices()?.iter() {
            let desc = device.device_descriptor()?;
            if !is_kingst(desc.vendor_id(), desc.product_id()) {
                continue;
            }
            let candidate = device_id_for(
                desc.vendor_id(),
                desc.product_id(),
                device.bus_number(),
                device.address(),
            );
            if candidate != device_id {
                continue;
            }

            let handle = device
                .open()
                .map_err(|error| CoreError::Usb(format!("cannot open Kingst device: {error}")))?;
            return match handle.claim_interface(USB_INTERFACE) {
                Ok(()) => Ok(handle),
                Err(rusb::Error::Busy) => Err(CoreError::Usb(
                    "cannot claim the Kingst interface: another program or driver is using it"
                        .to_string(),
                )),
                Err(rusb::Error::NoDevice) => {
                    Err(CoreError::Usb("the Kingst device has been disconnected".to_string()))
                }
                Err(error) => Err(CoreError::Usb(format!(
                    "cannot claim the Kingst interface: {error}"
                ))),
            };
        }
        Err(CoreError::UnsupportedDevice)
    }

    /// Id of the Kingst device that is running its firmware.
    ///
    /// A device id embeds bus and address, and the FX2 re-enumerates after a
    /// firmware upload, so the id captured before the upload can go stale. This
    /// re-derives it. It assumes a single Kingst device is attached — with two,
    /// the re-enumeration cannot be attributed without port paths, which libusb
    /// only exposes through `libusb_get_port_numbers`.
    /// Resolve which device to actually talk to.
    ///
    /// A device id embeds the USB bus and address, and both change whenever the
    /// device re-enumerates: once when the FX2 firmware is uploaded, and again
    /// when it is unplugged and replugged. A caller holding an id from an
    /// earlier enumeration therefore has a stale one, and refusing to work with
    /// it would leave the session stuck until the caller re-listed devices.
    ///
    /// A programmed device is preferred, since it is the one already running.
    /// Failing that, any Kingst device will do: `bring_up` exists precisely to
    /// program an unprogrammed one.
    fn resolve_device_id(&self, device_id: &str) -> Result<String> {
        if self.open_device(device_id).is_ok() {
            return Ok(device_id.to_string());
        }
        if let Ok(prepared) = self.prepared_device_id() {
            return Ok(prepared);
        }
        self.list_devices()?
            .into_iter()
            .next()
            .map(|device| device.id)
            .ok_or(CoreError::UnsupportedDevice)
    }

    fn prepared_device_id(&self) -> Result<String> {
        let context = Self::context()?;
        for device in context.devices()?.iter() {
            let desc = device.device_descriptor()?;
            if is_kingst(desc.vendor_id(), desc.product_id()) && has_endpoints(&device) {
                return Ok(device_id_for(
                    desc.vendor_id(),
                    desc.product_id(),
                    device.bus_number(),
                    device.address(),
                ));
            }
        }
        Err(CoreError::Usb(
            "no programmed Kingst device found; it may not have re-enumerated".to_string(),
        ))
    }

    /// Bring the device from "unprogrammed" to "capturable".
    ///
    /// Idempotent: the FPGA is only re-flashed when the plausibility check
    /// says the current bitstream is not running.
    fn bring_up(&self, device_id: &str, sink: &mut dyn FnMut(DiagnosticEvent)) -> Result<()> {
        let firmware_dir = firmware_dir().ok_or_else(|| {
            CoreError::Usb(
                "no Kingst firmware directory found; set SIGPILOT_KINGST_FIRMWARE_DIR".into(),
            )
        })?;

        // The caller's id embeds bus and address, and a previous `prepare` may
        // have made the FX2 re-enumerate, so the id it holds can be stale.
        let mut device_id = self.resolve_device_id(device_id)?;

        // Step 1: get the MCU firmware running. A device that answers the
        // EEPROM request is already running it.
        let mcu_running = self
            .open_device(&device_id)
            .map(|handle| read_identity(&handle).is_ok())
            .unwrap_or(false);

        if !mcu_running {
            sink(info("Uploading Kingst MCU firmware".to_string()));
            let firmware = read_firmware(&firmware_dir, &format!("kingst-la-{KINGST_PID:04x}.fw"))?;

            let handle = self.open_device(&device_id)?;
            upload_mcu_firmware(&handle, &firmware)?;
            drop(handle);

            // The FX2 re-enumerates and very likely comes back at a different
            // address, so re-derive the id rather than reusing the old one.
            let _ = wait_for_reenumeration()?;
            device_id = self.prepared_device_id()?;
        }

        // Step 2: identify the model from the EEPROM.
        let handle = self.open_device(&device_id)?;
        let identity = read_identity(&handle)?;
        let model = identity.model();
        sink(info(format!(
            "Kingst {} (magic {:#04x}/{:#04x}{})",
            model.name,
            identity.magic,
            identity.magic2,
            identity
                .manufactured
                .as_deref()
                .map(|date| format!(", made {date}"))
                .unwrap_or_default()
        )));

        // Step 3: FPGA bitstream, if it is not already running.
        //
        // Board revisions differ in how the input channels are routed to the
        // FPGA, and the bitstream has to match. The EEPROM magic is supposed to
        // select it, but the model table does not cover every magic pair seen in
        // the field, so both the file and the "is it already loaded" decision
        // can be overridden for testing.
        let file = match crate::product_env_string("SIGPILOT_KINGST_FPGA_STEM") {
            Some(stem) => format!("kingst-{stem}-fpga.bitstream"),
            None => model.bitstream_file(),
        };
        let force = crate::product_env("SIGPILOT_KINGST_FORCE_FPGA").is_some();
        if force || !fpga_is_ready(&handle) {
            sink(info(format!("Uploading Kingst FPGA bitstream {file}")));
            let bitstream = read_firmware(&firmware_dir, &file)?;
            upload_fpga_bitstream(&handle, &bitstream)?;
        }

        enable_fpga(&handle)?;

        // Clear any stale samples left in the EP6 FIFO.
        ctrl_out(&handle, CMD_BULK_RESET, 0x00, &[])?;

        Ok(())
    }
}

impl Default for KingstLa2016Driver {
    fn default() -> Self {
        Self::new()
    }
}

impl DeviceDriver for KingstLa2016Driver {
    fn descriptor(&self) -> &DeviceDescriptor {
        &self.descriptor
    }

    fn list_devices(&self) -> Result<Vec<DeviceInfo>> {
        let context = Self::context()?;
        let mut devices = Vec::new();

        for device in context.devices()?.iter() {
            let desc = match device.device_descriptor() {
                Ok(desc) => desc,
                Err(_) => continue,
            };
            if !is_kingst(desc.vendor_id(), desc.product_id()) {
                continue;
            }
            // Deliberately no `iProduct` check here: the unprogrammed FX2 has no
            // string descriptors, and that is precisely the state we need to
            // enumerate in order to upload firmware to it.

            let bus = device.bus_number();
            let address = device.address();
            let programmed = has_endpoints(&device);

            // Only the programmed device can answer the EEPROM request, and
            // only then do we know which model it is.
            let (label, model, probe_error) = if programmed {
                match device.open() {
                    Ok(handle) => match read_identity(&handle) {
                        Ok(identity) => (
                            format!("Kingst {}", identity.model().name),
                            Some(identity.model().name.to_string()),
                            None,
                        ),
                        Err(_) => (
                            "Kingst logic analyzer".to_string(),
                            None,
                            Some("EEPROM identification failed".to_string()),
                        ),
                    },
                    Err(error) => (
                        "Kingst logic analyzer".to_string(),
                        None,
                        Some(format!("cannot open device: {error}")),
                    ),
                }
            } else {
                (
                    "Kingst logic analyzer (firmware not loaded)".to_string(),
                    None,
                    None,
                )
            };

            devices.push(DeviceInfo {
                id: device_id_for(desc.vendor_id(), desc.product_id(), bus, address),
                kind: DeviceKind::Usb,
                vid: desc.vendor_id(),
                pid: desc.product_id(),
                bus: Some(bus),
                address: Some(address),
                label,
                // Unprogrammed devices still enumerate, and `prepare` will
                // program them, so they are usable — not merely "found".
                ready: true,
                manufacturer: Some("Qingdao Kingst".to_string()),
                product: model,
                serial_number: None,
                usb_speed: Some(format!("{:?}", device.speed()).to_lowercase()),
                logic_mode: None,
                profile_model: None,
                probe_error,
            });
        }

        Ok(devices)
    }

    fn capabilities(&self, device_id: &str) -> Result<HardwareCaptureCapabilities> {
        // Same staleness caveat as `prepare`: the id may predate a
        // re-enumeration caused by a firmware upload.
        let handle = match self.open_device(device_id) {
            Ok(handle) => handle,
            Err(_) => self.open_device(&self.prepared_device_id()?)?,
        };
        let identity = read_identity(&handle)?;
        let model = identity.model();

        let mut rates = Vec::new();
        let mut rate = model.samplerate;
        while rate >= 1_000_000 {
            rates.push(rate);
            rate /= 10;
        }

        let depth_samples = (model.memory_bits as u64)
            .saturating_mul(1024 * 1024 * 1024)
            .checked_div(model.channels as u64)
            .filter(|depth| *depth > 0)
            .unwrap_or(MEMORY_SAMPLES);

        Ok(HardwareCaptureCapabilities {
            device_id: device_id.to_string(),
            profile_vendor: Some("Qingdao Kingst".to_string()),
            profile_model: Some(model.name.to_string()),
            usb_speed: Some("high".to_string()),
            logic_mode: None,
            max_channels: model.channels,
            default_channel_count: model.channels,
            default_sample_rate_hz: rates.first().copied().unwrap_or(model.samplerate),
            sample_rates: rates.clone(),
            threshold_volts: THRESHOLD_VOLTS.to_vec(),
            channel_modes: vec![
                HardwareChannelModeInfo {
                    id: format!("KINGST_BUFFER{}", model.channels),
                    // Capture-to-memory: the device fills its own SDRAM and the
                    // host downloads it afterwards. Deep at high rates, and
                    // bounded by that SDRAM.
                    stream: false,
                    channels: model.channels,
                    default_sample_rate_hz: model.samplerate,
                    default_sample_limit: depth_samples,
                    min_sample_rate_hz: rates.last().copied().unwrap_or(model.samplerate),
                    max_sample_rate_hz: model.samplerate,
                    sample_rates: rates.clone(),
                    description: format!(
                        "Use {} Channels (Max {}MHz, into device memory)",
                        model.channels,
                        model.samplerate / 1_000_000
                    ),
                },
                HardwareChannelModeInfo {
                    id: format!("KINGST_STREAM{}", model.channels),
                    // Streaming: samples go straight to the host, so the depth is
                    // the client's memory budget rather than the device's, and the
                    // bound is USB 2.0 rather than the SDRAM. `capture_streaming`
                    // warns when the requested rate needs more than the link
                    // carries.
                    //
                    // This entry used to be missing, and that was not cosmetic: the
                    // client chooses a channel mode by matching this flag against
                    // the capture mode it is about to run, and the UI's "Looping"
                    // mode is `CaptureMode::Stream`. With no streaming entry the
                    // match came back empty, so the channel-count and sample-rate
                    // options fell back to generic defaults instead of the
                    // device's own.
                    stream: true,
                    channels: model.channels,
                    default_sample_rate_hz: model.samplerate,
                    default_sample_limit: 0,
                    min_sample_rate_hz: rates.last().copied().unwrap_or(model.samplerate),
                    max_sample_rate_hz: model.samplerate,
                    sample_rates: rates,
                    description: format!(
                        "Use {} Channels (Max {}MHz, streamed)",
                        model.channels,
                        model.samplerate / 1_000_000
                    ),
                },
            ],
        })
    }

    fn prepare(&self, device_id: &str, sink: &mut dyn FnMut(DiagnosticEvent)) -> Result<()> {
        self.bring_up(device_id, sink)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The layout the reference driver documents, taken from a real unit:
    /// `magic, ~magic, magic2, ~magic2, magic, ~magic, magic2, ~magic2`.
    fn identity_bytes(magic: u8, magic2: u8) -> [u8; 8] {
        [magic, !magic, magic2, !magic2, magic, !magic, magic2, !magic2]
    }

    #[test]
    fn reads_the_primary_identity_copy() {
        assert_eq!(parse_identity_bytes(&identity_bytes(0x08, 0x10)), Some((0x08, 0x10)));
    }

    #[test]
    fn falls_back_to_the_backup_identity_copy() {
        let mut buf = identity_bytes(0x02, 0x01);
        // Corrupt the primary copy's complement pair.
        buf[1] = 0x00;
        assert_eq!(parse_identity_bytes(&buf), Some((0x02, 0x01)));
    }

    #[test]
    fn accepts_a_two_byte_only_check_with_unknown_secondary_magic() {
        let mut buf = identity_bytes(0x02, 0x01);
        // Only the first pair is intact; the secondary magic is unreadable.
        buf[2] = 0x00;
        buf[3] = 0x00;
        buf[4] = 0x00;
        buf[5] = 0x00;
        buf[6] = 0x00;
        buf[7] = 0x00;
        assert_eq!(parse_identity_bytes(&buf), Some((0x02, 0)));
    }

    #[test]
    fn rejects_inconsistent_identity_bytes() {
        assert_eq!(parse_identity_bytes(&[0x11; 8]), None);
    }

    #[test]
    fn resolves_the_la2016_magics_observed_on_hardware() {
        // This unit reports 0x08/0x10; the table's 0x08 entry accepts any
        // secondary magic, so it resolves to the a1 bitstream.
        let index = lookup_model(0x08, 0x10).expect("0x08 must resolve");
        assert_eq!(MODELS[index].name, "LA2016");
        assert_eq!(MODELS[index].bitstream_file(), "kingst-la2016a1-fpga.bitstream");
        assert_eq!(MODELS[index].samplerate, 200_000_000);
        assert_eq!(MODELS[index].channels, 16);
    }

    #[test]
    fn prefers_the_entry_that_names_the_secondary_magic() {
        // 0x02/0x01 has its own entry and must not fall through to 0x02/0x00.
        let index = lookup_model(0x02, 0x01).expect("0x02/0x01 must resolve");
        assert_eq!(MODELS[index].fpga_stem, "la2016a1");
    }

    #[test]
    fn distinguishes_models_that_share_a_magic() {
        let la1016 = lookup_model(0x03, 0x00).expect("0x03 must resolve");
        assert_eq!(MODELS[la1016].name, "LA1016");
        assert_eq!(MODELS[la1016].samplerate, 100_000_000);
        let la5032 = lookup_model(0x06, 0x00).expect("0x06 must resolve");
        assert_eq!(MODELS[la5032].channels, 32);
    }

    #[test]
    fn rejects_an_unknown_magic() {
        assert_eq!(lookup_model(0x7f, 0x00), None);
    }

    #[test]
    fn expands_stream_entities_into_packed_samples() {
        let model = &MODELS[lookup_model(0x08, 0x00).unwrap()];
        let layout = StreamLayout::for_model(model, &[0, 1, 2, 3]);
        assert_eq!(layout.entity_size, 2);
        assert_eq!(layout.block_bytes(), 8);

        // One entity per enabled channel. Bit n of a channel's entity is that
        // channel's level at sample n.
        let entities: [(u16, &str); 4] = [
            (0b0000_0000_0000_0001, "ch0 high only at sample 0"),
            (0b0000_0000_0000_0010, "ch1 high only at sample 1"),
            (0b0000_0000_0000_0000, "ch2 never high"),
            (0b1000_0000_0000_0000, "ch3 high only at sample 15"),
        ];
        let mut chunk = Vec::new();
        for (value, _) in entities {
            chunk.extend_from_slice(&value.to_le_bytes());
        }

        let mut parser = StreamParser::default();
        let mut samples = Vec::new();
        let emitted = expand_stream_chunk(&chunk, &layout, &mut parser, &mut samples).unwrap();
        assert_eq!(emitted, StreamLayout::SAMPLES_PER_BLOCK as u64);
        assert_eq!(samples.len(), 16 * 2);

        let word = |index: usize| u16::from_le_bytes([samples[index * 2], samples[index * 2 + 1]]);
        assert_eq!(word(0), 1 << 0);
        assert_eq!(word(1), 1 << 1);
        assert_eq!(word(2), 0);
        assert_eq!(word(14), 0);
        assert_eq!(word(15), 1 << 3);
    }

    #[test]
    fn carries_a_partial_stream_block_across_chunks() {
        let model = &MODELS[lookup_model(0x08, 0x00).unwrap()];
        let layout = StreamLayout::for_model(model, &[0, 1]);
        assert_eq!(layout.block_bytes(), 4);

        let mut parser = StreamParser::default();
        let mut samples = Vec::new();

        // Two entities arrive first, completing exactly one block.
        let mut first = Vec::new();
        first.extend_from_slice(&0b1u16.to_le_bytes()); // ch0, sample 0 high
        first.extend_from_slice(&0b0u16.to_le_bytes()); // ch1, nothing
        assert_eq!(
            expand_stream_chunk(&first, &layout, &mut parser, &mut samples).unwrap(),
            16
        );

        // Then a single entity, which must not emit anything on its own: the
        // parser has to hold it until the second channel's entity arrives.
        let mut second = Vec::new();
        second.extend_from_slice(&0b10u16.to_le_bytes()); // ch0, sample 1 high
        assert_eq!(
            expand_stream_chunk(&second, &layout, &mut parser, &mut samples).unwrap(),
            0
        );
        assert_eq!(samples.len(), 16 * 2);

        // Completing the block emits the second batch.
        let mut third = Vec::new();
        third.extend_from_slice(&0b0u16.to_le_bytes()); // ch1
        assert_eq!(
            expand_stream_chunk(&third, &layout, &mut parser, &mut samples).unwrap(),
            16
        );
        assert_eq!(samples.len(), 32 * 2);

        let word = |index: usize| u16::from_le_bytes([samples[index * 2], samples[index * 2 + 1]]);
        // First block: the ch0 entity had bit 0 set.
        assert_eq!(word(0), 1 << 0);
        assert_eq!(word(1), 0);
        // Second block: the held entity had bit 1 set, so sample 0 is clear and
        // sample 1 carries the channel. The two samples straddling the chunk
        // boundary are what prove the partial block survived.
        assert_eq!(word(16), 0);
        assert_eq!(word(17), 1 << 0);
    }

    #[test]
    fn rejects_a_stream_chunk_that_is_not_entity_aligned() {
        let model = &MODELS[lookup_model(0x08, 0x00).unwrap()];
        let layout = StreamLayout::for_model(model, &[0, 1]);
        let mut parser = StreamParser::default();
        let mut samples = Vec::new();
        assert!(expand_stream_chunk(&[0u8; 3], &layout, &mut parser, &mut samples).is_err());
    }

    #[test]
    fn block_accumulation_returns_the_appended_bytes_and_the_whole_capture() {
        // The published slice has to be exactly what this call appended, because
        // the caller forwards it to the graph as new samples; and the flattened
        // result has to equal the concatenation, because that is the capture.
        let mut blocks = SampleBlocks::new(8);
        let mut expected: Vec<u8> = Vec::new();

        // Deliberately not block-aligned: the interesting case is an append that
        // straddles a block boundary, which must still come back contiguous.
        for chunk in [&[1u8, 2, 3, 4, 5][..], &[6, 7, 8][..], &[9, 10, 11, 12, 13, 14][..]] {
            let added = blocks.extend(chunk);
            assert_eq!(added, chunk);
            expected.extend_from_slice(chunk);
        }

        assert_eq!(blocks.into_vec(), expected);
    }

    #[test]
    fn every_model_reports_a_word_size_the_graph_accepts() {
        // The graph derives the expected word size from `channel_count` and
        // rejects the pair when they disagree, so a capture has to report the
        // *device's* width. Regression: reporting the caller's requested count
        // (the client's session defaults to 8) while keeping the 2-byte word
        // produced "capture metadata is invalid" and an empty view.
        for model in MODELS {
            let layout = TransferLayout::for_model(model);
            let expected = match model.channels {
                1..=8 => 1,
                9..=16 => 2,
                17..=32 => 4,
                other => panic!("unexpected channel count {other}"),
            };
            assert_eq!(
                layout.unit_size, expected,
                "{} reports {} channels but {} byte words",
                model.name, model.channels, layout.unit_size
            );
        }
    }

    #[test]
    fn builds_the_enabled_channel_mask_the_device_needs() {
        // Regression: the first word of the trigger configuration is the enabled
        // channel mask, not a trigger field. Sending zero there made the device
        // capture nothing at all — every sample read back as zero, at every
        // threshold, which looks exactly like a wiring fault.
        assert_eq!(enabled_channel_mask(&(0..16).collect::<Vec<u8>>()), 0xffff);
        assert_eq!(enabled_channel_mask(&[0, 1, 2, 3]), 0x000f);
        assert_eq!(enabled_channel_mask(&[15]), 0x8000);
        assert_eq!(enabled_channel_mask(&[]), 0);
    }

    #[test]
    fn device_ids_carry_bus_and_address() {
        assert_eq!(device_id_for(0x77a1, 0x01a2, 3, 9), "usb-kingst:77a1:01a2:3:9");
    }

    #[test]
    fn routes_only_its_own_device_ids() {
        assert!(owns("usb-kingst:77a1:01a2:3:9"));
        // The PXLogic driver owns the bare `usb` scheme.
        assert!(!owns("usb:1a86:5237:1:4"));
        assert!(!owns("fake:sigpilot-demo"));
        assert!(!owns("usb-kingst"));
        assert!(!owns(""));
    }

    #[test]
    fn transfer_layout_matches_the_documented_memory_map() {
        let sixteen = TransferLayout::for_model(&MODELS[lookup_model(0x08, 0x00).unwrap()]);
        assert_eq!(sixteen.transfer_size, 16);
        assert_eq!(sixteen.unit_size, 2);
        assert_eq!(sixteen.sequence_size, 1);
        assert_eq!(sixteen.packets_per_chunk, 5);

        let thirty_two = TransferLayout::for_model(&MODELS[lookup_model(0x06, 0x00).unwrap()]);
        assert_eq!(thirty_two.transfer_size, 32);
        assert_eq!(thirty_two.unit_size, 4);
        assert_eq!(thirty_two.sequence_size, 2);
        assert_eq!(thirty_two.packets_per_chunk, 6);
    }

    #[test]
    fn expands_run_length_packets_into_packed_samples() {
        let layout = TransferLayout::for_model(&MODELS[lookup_model(0x08, 0x00).unwrap()]);
        // One transfer: three packets of value 0x1234 held for 2, 1 and 3
        // samples, plus two zero-repeat packets, then the sequence byte.
        let mut chunk = Vec::new();
        for (value, repetitions) in [(0x1234u16, 2u8), (0x1234, 1), (0x00ff, 3), (0, 0), (0, 0)] {
            chunk.extend_from_slice(&value.to_le_bytes());
            chunk.push(repetitions);
        }
        chunk.push(0x5a); // sequence number, ignored
        assert_eq!(chunk.len(), layout.transfer_size);

        let mut samples = Vec::new();
        let emitted = expand_chunk(&chunk, &layout, &mut samples).unwrap();
        assert_eq!(emitted, 6);
        assert_eq!(samples.len(), 6 * layout.unit_size);
        assert_eq!(&samples[0..2], &[0x34, 0x12]);
        assert_eq!(&samples[4..6], &[0x34, 0x12]);
        assert_eq!(&samples[6..8], &[0xff, 0x00]);
    }

    #[test]
    fn rejects_a_chunk_that_is_not_transfer_aligned() {
        let layout = TransferLayout::for_model(&MODELS[lookup_model(0x08, 0x00).unwrap()]);
        let mut samples = Vec::new();
        assert!(expand_chunk(&[0u8; 15], &layout, &mut samples).is_err());
    }

    #[test]
    fn the_driver_owns_its_own_scheme() {
        let driver = KingstLa2016Driver::new();
        let descriptor = driver.descriptor();
        assert_eq!(descriptor.id_schemes, vec![ID_SCHEME.to_string()]);
        // The PXLogic driver owns the bare `usb` scheme; a collision here would
        // make `DeviceRegistry::new` reject the built-in set.
        assert!(!descriptor.id_schemes.iter().any(|scheme| scheme == "usb"));
        assert!(driver.owns_device("usb-kingst:77a1:01a2:3:9"));
        assert!(!driver.owns_device("usb:1a86:5237:1:4"));
    }
}
