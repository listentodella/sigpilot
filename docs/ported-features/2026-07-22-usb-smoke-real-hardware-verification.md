# USB Smoke Real Hardware Verification

## Source References

- `pxview-fork/libsigrok/hardware/pxlogic/pxlogic.c`
  - `hw_scan()` and `logic_check_conf_profile()` identity flow.
  - `start_transfers()` stream/buffer register setup.
  - `firmware_config()` endpoint cleanup retry pattern.
- `src-tauri/src/bin/usb_smoke.rs`
  - Local smoke tool used for staged real-device validation.

## What Was Added

- Added `usb_smoke --list-only`.
  - Lists PXLogic candidates without requiring bitstreams or starting capture.
  - Prints USB identity fields now exposed through `DeviceInfo`.
- Added `usb_smoke --prepare-only`.
  - Runs PXView-style prepare/FPGA upload without starting capture.
- Added `usb_smoke --buffer-mb`.
  - Allows small stream-mode captures for low-risk validation.
- Added per-register capture startup tracing and one retry after clearing endpoints.
  - This mirrors the practical retry pattern already needed by FPGA upload.

## Real Device Observed

- Device id: `usb:16c0:05dc:3:9`
- VID/PID: `16c0:05dc`
- USB speed: `high`
- PXView profile: `PX-Logic U2 channel 32`
- `REG_LOGIC_MODE`: `0x00000000`
- Manufacturer: `PX`
- Product: `PX USB2.0 Logic 32`
- Serial: `569000274250304330303719`
- MCU firmware version: `0x56900027`
  - PXView source expects `0x56900028`.
  - Current Tauri path warns and continues with FPGA prepare only; it does not flash MCU firmware.

## Commands Run

```sh
cargo run -p pxlogic-desktop --bin usb_smoke -- --list-only
cargo run -p pxlogic-desktop --bin usb_smoke -- --prepare-only
cargo run -p pxlogic-desktop --bin usb_smoke -- --mode stream --rate 5000000 --channels 32 --buffer-mb 1 --out debug-captures/usb-smoke-u2-32ch-stream-5m-1mb.pxcap
cargo run -p pxlogic-desktop --bin usb_smoke -- --mode buffer --rate 25000000 --channels 32 --ms 5 --out debug-captures/usb-smoke-u2-32ch-buffer-25m-5ms.pxcap
cargo run -p pxlogic-desktop --bin usb_smoke -- --mode stream --rate 5000000 --channels 32 --buffer-mb 1 --compare-mappings --out debug-captures/usb-smoke-u2-32ch-stream-raw-cross-compare.pxcap
```

## Verification Result

- `--list-only` successfully enumerated the U2 32-channel device.
- `--prepare-only` completed after endpoint cleanup retry.
- 32-channel USB2 stream capture succeeded.
  - Effective PXView channel mode: `Use 32 Channels (Max5MHz)`.
  - Endpoint: `0x82`.
  - Captured `262144` samples, `1048576` bytes.
- 32-channel buffer capture succeeded.
  - Effective PXView channel mode: `Use 32 Channels (Max 250MHz)`.
  - DDR read endpoint: `0x83`.
  - Captured `125056` samples, `500224` bytes.
- Raw cross mapping comparison completed and saved a raw capture.

## Notes

- First register write at `addr=0x00000004` timed out during capture startup and succeeded after endpoint cleanup retry. Keeping this retry is necessary for this observed hardware/session.
- Main FPGA bitstream upload also intermittently timed out once and succeeded after the PXView-style cleanup retry.
- The first successful validation used an unconnected or mostly idle input state, so channel electrical mapping still needs a controlled pattern or loopback fixture before finalizing channel-order confidence.
