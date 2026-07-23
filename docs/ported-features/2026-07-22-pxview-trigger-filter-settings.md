# PXView Trigger And Filter Settings

## Source Reference

- `pxview-fork/libsigrok/hardware/pxlogic/pxlogic.c`
  - `filter_list[]`: `SR_FILTER_NONE` and `SR_FILTER_1T`.
  - `config_set()`:
    - `SR_CONF_FILTER` stores `devc->filter`.
    - `SR_CONF_CLOCK_EDGE` stores `devc->clock_edge`.
    - `SR_CONF_TRIGGER_OUT` stores `devc->trig_out_en`.
  - `set_trigger()` maps per-channel trigger symbols into the four PXLogic trigger masks:
    - `R` -> `trig_rise`
    - `F` -> `trig_fall`
    - `1` -> `trig_one`
    - `0` -> `trig_zero`
    - `C` -> both rise and fall
  - `start_transfers()` writes filter, clock edge, trigger out, channel count, trigger position, and the four trigger masks into the same registers now used by PXLogic core.

## Ported Behavior

- Extended `CaptureSettings` with hardware-facing fields:
  - `trigger_enabled`
  - `trigger_channel`
  - `trigger_kind`
  - `glitch_filter_enabled`
  - `clock_edge`
  - `trigger_out_enabled`
- Added `CaptureTriggerKind` with PXView simple-trigger variants:
  - `Rising`
  - `Falling`
  - `High`
  - `Low`
- Added `capture_profile_from_settings()` to convert Tauri/UI settings into the existing `CaptureProfile` register script model.
- `RusbBackend` now uses `capture_profile_from_settings()` before writing capture registers.
- The Tauri UI capture path now forwards:
  - Trigger mode as `trigger_enabled=true`.
  - Trigger channel from Device/Recording Settings.
  - Trigger edge/type as PXView trigger mask kind.
  - Glitch filter as PXView `SR_FILTER_1T`.
  - Manual Trigger Sampling rate as the next trigger capture sample rate.
- `usb_smoke` gained verification flags:
  - `--trigger-channel n`
  - `--trigger rising|falling|high|low`
  - `--glitch-filter`

## Files

- `crates/pxlogic-core/src/models.rs`
- `crates/pxlogic-core/src/capture.rs`
- `crates/pxlogic-core/src/rusb_backend.rs`
- `crates/pxlogic-core/src/lib.rs`
- `src-tauri/src/bin/usb_smoke.rs`
- `src/App.tsx`
- `src/lib/api.ts`

## Verification

- `cargo test -p pxlogic-core`
- `pnpm build`
- `cargo check -p pxlogic-desktop --bins`
- Real hardware smoke:
  - `cargo run -p pxlogic-desktop --bin usb_smoke -- --list-only`
  - `cargo run -p pxlogic-desktop --bin usb_smoke -- --mode stream --rate 5000000 --channels 32 --buffer-mb 1 --glitch-filter --out debug-captures/usb-smoke-u2-32ch-stream-5m-1mb-glitch-filter.pxcap`

## Hardware Evidence

- Device remained detected as `PX-Logic U2 channel 32`.
- Stream 5MHz / 32ch / 1MiB capture completed and saved successfully.
- Trace showed `glitch_filter=true`.
- Register trace wrote final run control `REG_STREAM_CONTROL=0x0000000a`, matching PXView stream bit plus `SR_FILTER_1T` filter bit.

## Known Gap

- UI labels `High Pulse` and `Low Pulse` currently map to PXView simple high/low trigger masks. PXView's PXLogic simple trigger path does not expose a separate pulse-width comparator in the copied register sequence, so `triggerPulseWidthUs` remains UI state until the corresponding original implementation is identified and ported.
