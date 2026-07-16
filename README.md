# PXLogic Studio

Saleae-style desktop frontend for PXLogic logic analyzers.

## Layout

- `crates/pxlogic-core`: capture core, protocol constants, fake backend, optional `rusb` backend.
- `crates/pxlogic-file`: `.pxcap`, `.sr`, and VCD read/write helpers.
- `crates/pxlogic-waveform`: viewport tile generation for waveform rendering.
- `src-tauri`: Tauri command/event adapter only.
- `src`: React workbench UI.

The UI shell is intentionally thin so it can be replaced by GPUI or another renderer later without rewriting capture, file, or waveform logic.

## Commands

```bash
pnpm install --store-dir /Volumes/tp7100s/.pnpm-store
cargo test --workspace
pnpm build
pnpm tauri dev
```

Cargo output is configured in `.cargo/config.toml` to use `/Volumes/tp7100s/work/pxlogic/target`.

## Real Hardware

The demo source works without hardware. For real PXLogic USB prepare/capture, bitstreams are loaded automatically from:

- `resources/bitstreams/hspi_ddr_RST.bin`
- `resources/bitstreams/hspi_ddr.bin`

You can override the defaults with either a directory:

```bash
export PXLOGIC_BITSTREAM_DIR=/path/to/bitstreams
pnpm tauri dev
```

or explicit files:

```bash
export PXLOGIC_FPGA_RESET=/path/to/hspi_ddr_RST.bin
export PXLOGIC_FPGA_MAIN=/path/to/hspi_ddr.bin
pnpm tauri dev
```

The bundled bitstreams include their original MIT-style license in `resources/bitstreams/LICENSE.txt`.
The project does not copy GPL source from PXView/pxlobster; those projects remain protocol references only.
