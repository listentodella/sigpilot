# PXView Hardware Profile and Buffer Mode Alignment

## Source References

- `pxview-fork/libsigrok/hardware/pxlogic/pxlogic.h`
  - `supported_PX[]` device profile table.
  - `PX_CHANNEL_ID` channel mode identifiers.
- `pxview-fork/libsigrok/hardware/pxlogic/pxlogic.c`
  - `channel_modes[]` samplerate/channel limits.
  - `start_transfers()` register setup and buffer/stream endpoint split.
- `pxview-fork/libsigrok/hardware/pxlogic/usb_ctrl.c`
  - `usb_rd_data_req()` DDR read request registers.

## What Was Ported

- Added `crates/pxlogic-core/src/pxview_profile.rs`.
  - Mirrors PXView's PXLogic USB2/USB3 profile matrix.
  - Preserves the original channel mode IDs and descriptions.
  - Resolves a capture plan from requested mode, channel count, samplerate, USB speed, and `REG_LOGIC_MODE`.
- Updated `RusbBackend` capture startup.
  - Reads USB speed and `REG_LOGIC_MODE`.
  - Selects the matching PXView profile before register setup.
  - Caps requested channel count and samplerate to the selected PXView channel mode, matching PXView's `adjust_samplerate()` behavior.
  - Emits diagnostics when a user request is capped.
- Updated Buffer Mode readout.
  - Stream mode continues to read endpoint `0x82`.
  - Buffer mode now waits for the capture window, writes the DDR read request registers, clears `0x83`, and reads endpoint `0x83`.

## Current Limits

- The frontend still exposes simple `channel_count` and `sample_rate_hz` controls rather than PXView's full channel-mode selector. The backend now protects real hardware from unsupported combinations.
- Device listing uses VID/PID/speed profile labels. Exact new-PID 16-channel variants are confirmed during capture after reading `REG_LOGIC_MODE`.
- CPU firmware update paths from PXView (`SCI_LOGIC.bin`, `SCI_LOGIC_BL.bin`) are documented but not enabled in this app path; current preparation still uploads the two FPGA bitstreams.

## Verification

- `cargo test -p pxlogic-core`
- Pending full app build after documentation update.
