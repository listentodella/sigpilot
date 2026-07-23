# PXView Prepare Firmware Diagnostics and FPGA Retry

## Source References

- `pxview-fork/libsigrok/hardware/pxlogic/pxlogic.h`
  - `FIRMWARE_VERSION`
  - `FIRMWARE_BL_VERSION`
- `pxview-fork/libsigrok/hardware/pxlogic/pxlogic.c`
  - `hw_usb_open()` reads `8192 + 13 * 4` before FPGA setup.
  - `firmware_config()` retries FPGA upload after clearing endpoints.

## What Was Ported

- Added firmware register constants to `crates/pxlogic-core/src/protocol.rs`.
  - `REG_FIRMWARE_VERSION`
  - `REG_DEVICE_RESET`
  - `EXPECTED_FIRMWARE_VERSION`
  - `BOOTLOADER_FIRMWARE_VERSION`
- Updated `RusbBackend::prepare_device_with_trace()`.
  - Reads the MCU firmware version register and emits diagnostics.
  - Warns when the bootloader or an unexpected firmware version is detected.
  - Keeps CPU firmware flashing disabled because this project currently ships only the FPGA bitstreams.
- Added PXView-style endpoint cleanup and FPGA upload retry.
  - Clears `0x01`, `0x81`, `0x02`, `0x82`, `0x03`, `0x83`, `0x04`, `0x84`.
  - If reset or main FPGA bitstream upload fails once, clears endpoints, waits 20 ms, and retries from the beginning.

## Intent

This moves the Tauri backend closer to PXView's hardware bring-up behavior without silently adding MCU flashing. It should make repeated prepare/capture attempts more tolerant of stale endpoint state while preserving clear diagnostics when the attached device firmware is not the expected PXView version.

## Verification

- `cargo fmt --check`
- `cargo test -p pxlogic-core`
- Pending full app build after documentation update.
