# PXLogic Sigrok Analyzer Sidecar

This GPL-2.0-or-later executable hosts PXView's `libsigrokdecode` fork outside
the Tauri process. The build references the existing `pxview-fork` source tree
directly and currently loads its native C `spi_c` decoder.

Build and verify:

```sh
native/sigrok-analyzer-sidecar/verify.sh
```

Runtime environment for the Rust adapter:

```sh
export PXLOGIC_SIGROK_SIDECAR="$PWD/native/sigrok-analyzer-sidecar/target/pxlogic-sigrok-sidecar"
export PXLOGIC_SIGROK_DECODER_ROOT="$PWD/native/sigrok-analyzer-sidecar/target/decoders/c_decoders"
```

The executable accepts `--probe` and `--decode`. Decode requests use the same
`pxlogic.decoder.spi.v1` edge-stream contract as the Saleae Native adapter and
responses use the backend-neutral Rust `DecoderOutput` JSON shape.

The SPI C decoder runs against a transition-indexed `srd_decoder_runtime`.
Decode cost and memory therefore scale with relevant edges rather than total
capture duration; `verify.sh` includes a transaction near sample 49 billion.
