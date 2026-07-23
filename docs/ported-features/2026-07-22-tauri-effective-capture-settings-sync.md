# Tauri Effective Capture Settings Sync

## Background

The PXLogic USB backend now resolves the effective capture plan from PXView's profile/channel-mode matrix. For example, a USB2 32-channel stream request is capped to the PXView `STREAM_LOGIC5x32` mode. The backend reports the effective samplerate and channel count in `CaptureMetadata`.

## What Was Changed

- Added `syncSessionWithEffectiveCaptureMetadata()` in `src/App.tsx`.
  - Updates session `settings.sample_rate_hz` from capture metadata.
  - Updates session `settings.channel_count` from capture metadata.
  - Updates `settings.device_id` and `selectedDevice` from metadata.
  - Rebuilds enabled digital channels if the backend capped channel count.
  - Keeps the trigger channel inside the effective channel range.
- Routed both live capture updates and capture completion through that sync helper.

## Why It Matters

When real hardware is attached, the UI should show what the hardware actually captured, not only what the user originally requested. This is especially important for PXLogic USB2 stream modes:

- 32 channels: max 5 MHz
- 16 channels: max 10 MHz
- 8 channels: max 25 MHz

The graph and measurement code already uses capture metadata; this change makes the visible recording controls match it as well.

## Verification

- `pnpm build`
- Pending direct Tauri UI Start-button hardware run.
