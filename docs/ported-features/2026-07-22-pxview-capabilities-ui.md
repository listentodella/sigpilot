# PXView Hardware Capabilities UI

## Source Reference

- `pxview-fork/libsigrok/hardware/pxlogic/pxlogic.c`
  - `channel_modes[]`: ported stream/buffer flag, channel capacity, default sample rate, sample limit, min/max samplerate, and UI description strings such as `Use 32 Channels (Max5MHz)`.
  - channel-mode list generation filters modes by `devc->stream` and `profile->dev_caps.channels`.
- `pxview-fork/libsigrok/hardware/pxlogic/pxlogic.h`
  - `supported_PX[]`: profile-specific capability bitsets for USB2/USB3 32ch and 16ch variants.

## Ported Behavior

- Added serializable hardware capability models:
  - `HardwareCaptureCapabilities`
  - `HardwareChannelModeInfo`
- Added `pxlogic_capture_capabilities_from_profile()` so the Rust core exposes the PXView channel-mode matrix directly to Tauri and UI code.
- Added `device_capabilities(device_id)` Tauri command.
  - Demo/fake device returns a 32-channel generic preview capability.
  - USB devices resolve VID/PID, USB speed, and `REG_LOGIC_MODE` through the already-ported PXView profile matcher.
- Device Settings now renders channel buttons by the selected profile maximum channel count.
- Device Settings and Recording Settings now filter sample-rate options by the current capture mode and active channel count.
- UI settings are clamped before capture and when capabilities arrive, preventing a requested rate such as USB2 32ch Stream 25MHz from lingering in controls after the PXView profile only permits 5MHz.
- Device Information now shows the currently selected PXView channel mode description for direct traceability.

## Files

- `crates/pxlogic-core/src/models.rs`
- `crates/pxlogic-core/src/pxview_profile.rs`
- `crates/pxlogic-core/src/lib.rs`
- `src-tauri/src/main.rs`
- `src/lib/api.ts`
- `src/App.tsx`
- `src/styles.css`

## Verification

- `cargo fmt --check`
- `cargo test -p pxlogic-core`
- `pnpm build`

## Notes

- The UI mirrors the backend `resolve_pxlogic_capture_plan()` selection rule: choose a mode that can carry the requested channel count and sample rate, otherwise fall back to the fastest capable mode.
- The final hardware capture path still relies on the backend as the authority, so stale or failed capability reads cannot bypass PXView profile limits.
