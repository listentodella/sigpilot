# PXLogic Sigrok Analyzer Sidecar

This GPL-2.0-or-later executable hosts PXView's `libsigrokdecode` fork outside
the Tauri process. The build references the existing `pxview-fork` source tree
directly and loads its native C `uart_c`, `i2c_c`, `spi_c`, `i2s_c`, `can_c`,
`can_fd_c`, and `lin_c` decoders. LIN uses the decoder's native `uart_c ->
lin_c` stack.

Build and verify:

```sh
native/sigrok-analyzer-sidecar/verify.sh
```

Runtime environment for the Rust adapter:

```sh
export PXLOGIC_SIGROK_SIDECAR="$PWD/native/sigrok-analyzer-sidecar/target/pxlogic-sigrok-sidecar"
export PXLOGIC_SIGROK_DECODER_ROOT="$PWD/native/sigrok-analyzer-sidecar/target/decoders/c_decoders"
```

The executable accepts `--probe` and `--decode`. Decode requests use the
`pxlogic.decoder.v1` transition-stream contract (`pxlogic.decoder.spi.v1`
remains accepted for Saleae/SPI fixture compatibility), and responses use the
backend-neutral Rust `DecoderOutput` JSON shape.

All seven C decoders run against a transition-indexed `srd_decoder_runtime`.
Decode cost and memory therefore scale with relevant edges rather than total
capture duration; `verify.sh` covers UART, I2C, SPI, I2S, CAN, CAN-FD, LIN, and
transactions near sample 49 billion. The CAN-FD smoke fixture currently checks
classic CAN compatibility through `can_fd_c`; a trusted BRS/FD-frame fixture is
still required before claiming complete CAN-FD conformance.
