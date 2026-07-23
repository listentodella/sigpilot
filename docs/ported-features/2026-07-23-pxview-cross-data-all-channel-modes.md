# PXView Cross Data For All Channel Modes

## Source Reference

- `pxview-fork/libsigrok/hardware/pxlogic/pxlogic.c`
  - `receive_transfer()` marks every PXLogic logic packet as `LA_CROSS_DATA`, independent of the active channel count.
- `pxview-fork/PXView/pv/data/logicsnapshot.cpp`
  - `LogicSnapshot::append_cross_payload()` consumes one 64-bit word per enabled channel for every stripe.
  - The stripe width is `_channel_num * 8` bytes and is not limited to 16 or 32 channels.

## Ported Behavior

- `decode_cross_data()` now supports every valid PXLogic channel count from 1 through 32.
- The real USB backend now incrementally decodes cross-lane data for 1/2/4/8-channel high-speed modes as well as 16/32-channel modes.
- Fragmented USB reads retain only the incomplete stripe tail for every PXView channel width.
- Hardware byte accounting now follows PXView's `limit_samples * ch_num / 8` formula.
  - USB/register budgets use packed cross bytes.
  - Graph and capture memory budgets use decoded sample-word bytes.

## Why It Matters

Before this change, a capture such as USB2 Stream 25 MHz / 8 channels was accepted by the profile resolver but its `LA_CROSS_DATA` bytes were treated as ordinary interleaved sample words. The capture could complete while channel and time ordering were wrong. All PXView channel modes now use the same source-defined cross-stripe conversion.

The old byte accounting also happened to be correct only at 8/16/32 channels. At 4 channels it requested twice the intended raw data, and at 1 channel it requested eight times the intended raw data. Separating packed USB bytes from decoded graph bytes preserves the requested sample count in every channel mode.

## Verification

- `cargo test -p pxlogic-core`
- `cargo check -p pxlogic-desktop --bins`
- `pnpm build`
- Real hardware smoke:
  - Device: `PX-Logic U2 channel 32` (`16c0:05dc`, USB High Speed, logic mode `0`).
  - Stream 25 MHz / 8 channels: 1048576 raw bytes -> 1048576 decoded bytes.
  - Stream 50 MHz / 4 channels: 524288 raw bytes -> 1048576 decoded bytes.
  - Stream 100 MHz / 2 channels: 262144 raw bytes -> 1048576 decoded bytes.
  - Stream 200 MHz / 1 channel: 131072 raw bytes -> 1048576 decoded bytes.
  - Every capture produced 1048576 samples with a zero-byte stripe tail.
  - Artifacts: `debug-captures/usb-smoke-u2-{8,4,2,1}ch-stream-*-cross.pxcap`.
