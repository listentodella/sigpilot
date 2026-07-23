# PXView Device Enumeration and Identity Probe

## Source References

- `pxview-fork/libsigrok/hardware/pxlogic/pxlogic.c`
  - `hw_scan()` filters PXLogic VID/PID and USB high/super speed devices.
  - `logic_check_conf_profile()` opens the device, claims interfaces 0/1, checks the manufacturer string starts with `PX`, and reads `REG_LOGIC_MODE`.
- `pxview-fork/libsigrok/hardware/pxlogic/pxlogic.h`
  - `supported_PX[]` maps VID/PID/speed/logic mode to PXLogic profile names.

## What Was Ported

- Extended `DeviceInfo` with USB identity fields:
  - `manufacturer`
  - `product`
  - `serial_number`
  - `usb_speed`
  - `logic_mode`
  - `profile_model`
  - `probe_error`
- Updated `RusbBackend::list_devices()`.
  - Keeps PXView's VID/PID and USB speed filtering.
  - Opens each candidate device and reads USB string descriptors when possible.
  - If the manufacturer string is readable and does not start with `PX`, marks the device as found but not ready.
  - Claims interfaces 0/1 and reads `REG_LOGIC_MODE` to select a more exact PXView profile label.
  - Keeps the fallback VID/PID/speed profile if identity probing is blocked by permissions or a busy device.
- Updated the Device Settings information panel to show the probe result.

## Intent

This makes the Tauri app's startup/device list more useful for real hardware debugging. A connected device can now be distinguished by USB speed, PXView profile, manufacturer/product strings, and logic mode before capture is attempted.

## Verification

- `cargo test -p pxlogic-core`
- `pnpm build`
- Pending full regression run after documentation update.
