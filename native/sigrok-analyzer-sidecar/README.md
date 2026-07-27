# PXLogic Sigrok Analyzer Sidecar

This GPL-2.0-or-later executable hosts PXView's `libsigrokdecode` fork outside
the Tauri process. The build references the existing `pxview-fork` source tree
directly and builds the full native C decoder pack from
`pxview-fork/libsigrokdecode/c_decoders`. The sparse runner is currently
verified for `uart_c`, `i2c_c`, `spi_c`, `i2s_c`, `can_c`, `can_fd_c`, `lin_c`,
and `parallel_c`; LIN uses the decoder's native `uart_c -> lin_c` stack.

Build and verify:

```sh
native/sigrok-analyzer-sidecar/verify.sh
```

Runtime environment for the Rust adapter:

```sh
export PXLOGIC_SIGROK_SIDECAR="$PWD/native/sigrok-analyzer-sidecar/target/pxlogic-sigrok-sidecar"
export PXLOGIC_SIGROK_DECODER_ROOT="$PWD/native/sigrok-analyzer-sidecar/target/decoders/c_decoders"
export PXLOGIC_SIGROK_PYTHON_DECODER_ROOT="$PWD/pxview-fork/libsigrokdecode/decoders"
```

The executable accepts `--probe` and `--decode`. `--probe` is fast and reports
only the verified sparse C runner protocols. `--probe --catalog` additionally
loads PXView's Python decoder directory and emits a `decoder_catalog` with
decoder ids, C/Python kind, required/optional channels, options, annotations,
annotation rows, and binary outputs. Catalog entries outside the verified sparse
C runner are marked `catalog_only` until the generic packed/Python execution
path is wired and tested.

Decode requests use the `pxlogic.decoder.v1` transition-stream contract
(`pxlogic.decoder.spi.v1` remains accepted for Saleae/SPI fixture compatibility),
and responses use the backend-neutral Rust `DecoderOutput` JSON shape.

All eight C decoders run against a transition-indexed `srd_decoder_runtime`.
Decode cost and memory therefore scale with relevant edges rather than total
capture duration; `verify.sh` covers UART, I2C, SPI, I2S, CAN, CAN-FD, LIN,
Simple Parallel, transactions near sample 49 billion, and catalog enumeration
of 200+ C decoders plus 200+ Python decoders. The CAN-FD smoke fixture currently
checks classic CAN compatibility through `can_fd_c`; a trusted BRS/FD-frame
fixture is still required before claiming complete CAN-FD conformance.
