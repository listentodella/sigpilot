# SigPilot Sigrok Analyzer Sidecar

This GPL-2.0-or-later executable hosts PXView's `libsigrokdecode` fork outside
the Tauri process. The build uses the vendored
`vendor/pxview-sigrokdecode` source subset by default, with a local
`pxview-fork` checkout only as a development fallback. It builds the full
native C decoder pack from `libsigrokdecode/c_decoders`. The sparse runner is
currently verified for `uart_c`, `i2c_c`, `spi_c`, `i2s_c`, `can_c`,
`can_fd_c`, `lin_c`, and `parallel_c`; LIN uses the decoder's native
`uart_c -> lin_c` stack.

Build and verify:

```sh
native/sigrok-analyzer-sidecar/verify.sh
```

Runtime environment for the Rust adapter:

```sh
export SIGPILOT_SIGROK_SIDECAR="$PWD/native/sigrok-analyzer-sidecar/target/sigpilot-sigrok-sidecar"
export SIGPILOT_SIGROK_DECODER_ROOT="$PWD/native/sigrok-analyzer-sidecar/target/decoders/c_decoders"
export SIGPILOT_SIGROK_PYTHON_DECODER_ROOT="$PWD/vendor/pxview-sigrokdecode/libsigrokdecode/decoders"
```

The executable accepts `--probe` and `--decode`. `--probe` is fast and reports
only the verified sparse C runner protocols. `--probe --catalog` additionally
loads PXView's Python decoder directory and emits a `decoder_catalog` with
decoder ids, C/Python kind, required/optional channels, options, annotations,
annotation rows, and binary outputs. Direct digital-input C and Python decoders
use the generic sparse runner. Decoders that require protocol-stack input or
analog samples remain `catalog_only` until their upstream stack is configured.

Tauri packaging copies the Python standard library beside the sidecar on
Windows and Linux. The Rust adapter sets `PYTHONHOME` for the child process, so
the packaged C decoder runner does not depend on Python being installed on the
target machine.

Decode requests use the `pxlogic.decoder.v1` transition-stream contract
(`pxlogic.decoder.spi.v1` remains accepted for Saleae/SPI fixture compatibility),
and responses use the backend-neutral Rust `DecoderOutput` JSON shape.

All eight verified C decoders and the generic direct-input C/Python decoders run
against a transition-indexed `srd_decoder_runtime`.
Decode cost and memory therefore scale with relevant edges rather than total
capture duration; `verify.sh` covers UART, I2C, SPI, I2S, CAN, CAN-FD, LIN,
Simple Parallel, transactions near sample 49 billion, and catalog enumeration
of 200+ C decoders plus 200+ Python decoders. The CAN-FD smoke fixture currently
checks classic CAN compatibility through `can_fd_c`; a trusted BRS/FD-frame
fixture is still required before claiming complete CAN-FD conformance.
