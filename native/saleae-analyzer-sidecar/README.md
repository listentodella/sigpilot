# Saleae Native analyzer sidecar

This macOS arm64 sidecar hosts Saleae's original Logic 2.4.43 Async Serial, I2C, SPI, and I2S / PCM analyzers in an isolated process.

It does not copy Saleae binaries into the repository. `verify.sh` extracts the required files from a local Logic installer into ignored `target/` storage, verifies their SHA-256 hashes, and runs packed/sparse native decoder fixtures.

## Build and verify

```bash
native/saleae-analyzer-sidecar/build.sh
native/saleae-analyzer-sidecar/verify.sh /path/to/Logic-2.4.43-macos-arm64.zip
```

The build pins Saleae Analyzer SDK commit `16a9ebff783614691781a8cd69d733abc8c8c722`, which predates the Logic 2.4.43 plugin build by four days. The SDK test harness is compiled as an ABI-compatible `libAnalyzer.dylib` shim; the original `libspi_analyzer.so` remains unmodified.

Set these variables to use the Rust `SaleaeNativeDecoder` adapter:

```bash
export PXLOGIC_SALEAE_SIDECAR="$PWD/target/native/saleae-analyzer-sidecar/pxlogic-saleae-analyzer-sidecar"
export PXLOGIC_SALEAE_RUNTIME_ROOT="$PWD/target/native/saleae-runtime-2.4.43"
```

Async Serial, I2C, SPI, and I2S / PCM use the same transition-indexed request for packed PXLogic captures and sparse `.sal` captures. Rust only transports captures and normalizes sidecar output; protocol state machines remain in the original Saleae plugins. `Auto` remains on the compatibility backend until native backends cover the remaining protocol set and streaming contract.
