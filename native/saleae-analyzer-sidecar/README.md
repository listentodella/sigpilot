# Saleae Native analyzer sidecar

This macOS arm64 proof of concept hosts Saleae's original Logic 2.4.43 SPI analyzer in an isolated process.

It does not copy Saleae binaries into the repository. `verify.sh` extracts the required files from a local Logic installer into ignored `target/` storage, verifies their SHA-256 hashes, and runs the shared SPI fixtures.

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

The current PoC supports SPI batch decoding only. Explicit Saleae Native analyzers use this sidecar for packed PXLogic captures and sparse `.sal` captures; `Auto` remains on the legacy compatibility backend until native backends cover the current protocol set and streaming contract.
