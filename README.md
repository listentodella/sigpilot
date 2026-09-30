# SigPilot

A Saleae Logic 2 inspired, hardware-agnostic desktop workbench for logic analyzers.

SigPilot is an independent, non-commercial project. It is **not affiliated with,
endorsed by, or derived from Saleae LLC**, and it is unrelated to the SignalPilot
data platform or to Seica's PILOT test systems.

> **Renamed from PXLogic Studio.** The product was renamed to reflect that the
> workbench is not tied to a single hardware vendor.
>
> - Product-level environment variables moved from `PXLOGIC_*` to `SIGPILOT_*`.
>   The legacy names still work but log a deprecation warning.
> - Frontend persistence keys moved from `pxlogic.*` to `sigpilot.*`; existing
>   values are migrated on first access.
> - **Unchanged**: capture/project formats (`.pxcap`, `.pxl`), the sidecar wire
>   protocol identifiers (`pxlogic.decoder.*`, `pxlogic.project.v1`), and the
>   `pxlogic` hardware driver namespace (device profiles, USB IDs, firmware).
>
> See `docs/rename-plan.md` for the full mapping.

## Layout

- `crates/sigpilot-core`: capture core, protocol constants, fake backend, optional `rusb` backend.
- `crates/sigpilot-file`: `.pxcap`, `.sr`, VCD, and sparse `.sal` file adapters.
- `crates/sigpilot-waveform`: viewport tile generation for waveform rendering.
- `crates/sigpilot-graph`: the native graph kernel (edge indexes, packed viewport tiles, analyzer caches).
- `native`: isolated Saleae Graph/Analyzer and PXView libsigrokdecode sidecars.
- `src-tauri`: Tauri command/event adapter only.
- `src`: React workbench UI.

The `pxlogic` name is retained for the PXLogic hardware driver: device profiles,
USB IDs, FPGA bitstreams and MCU firmware all still refer to `pxlogic`.

The UI shell is intentionally thin so it can be replaced by GPUI or another renderer later without rewriting capture, file, or waveform logic.

## Decoder Direction

Protocol decoding is migrating to two external ecosystems:

- `Saleae Native`: a version-pinned Analyzer SDK sidecar that can load locally installed Logic analyzer plugins.
- `Sigrok Native`: a GPL sidecar that hosts PXView's native C UART, I2C, SPI, I2S, CAN, CAN-FD, LIN, and Simple Parallel decoders; the broader C/Python decoder catalog remains follow-up work.

The current Rust UART/I2C/SPI implementation is exposed only as `LegacyRustDecoder` during the migration. It remains available to keep existing captures and UI tests working, but receives no new protocol features and will be removed after Saleae Native and Sigrok Native provide sufficient coverage.

The Saleae Native SPI proof of concept is available on macOS arm64:

```bash
native/saleae-analyzer-sidecar/verify.sh /path/to/Logic-2.4.43-macos-arm64.zip
```

It uses a pinned Analyzer SDK test host and the locally supplied Logic 2.4.43 SPI plugin. Saleae binaries are extracted only into ignored `target/` storage and are never copied into the repository.

Both native backends consume transition-indexed captures. Saleae Native currently covers UART, I2C, SPI, I2S, CAN, LIN, and Simple Parallel; Sigrok Native covers UART, I2C, SPI, I2S, CAN, CAN-FD, LIN, and Simple Parallel. Saleae `.sal` files are imported and exported through the original GraphServer and remain sparse even when the capture spans tens of billions of samples.

## Commands

```bash
pnpm install
cargo test --workspace
node --test tests/*.test.ts
pnpm build
pnpm tauri dev
```

Cargo output stays in the workspace-local `target/` directory.

## Real Hardware

The demo source works without hardware. For real PXLogic USB prepare/capture, bitstreams are loaded automatically from:

- `resources/bitstreams/hspi_ddr_RST.bin`
- `resources/bitstreams/hspi_ddr.bin`

You can override the defaults with either a directory:

```bash
export SIGPILOT_BITSTREAM_DIR=/path/to/bitstreams
pnpm tauri dev
```

or explicit files:

```bash
export SIGPILOT_FPGA_RESET=/path/to/hspi_ddr_RST.bin
export SIGPILOT_FPGA_MAIN=/path/to/hspi_ddr.bin
pnpm tauri dev
```

The bundled bitstreams include their original MIT-style license in `resources/bitstreams/LICENSE.txt`.
The main MIT/Apache workspace does not copy GPL source from PXView/pxlobster. Sigrok integration remains an explicitly separated GPL sidecar with its own source and license notices.
