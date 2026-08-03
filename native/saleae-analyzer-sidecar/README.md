# Saleae Native analyzer sidecar

This macOS arm64/x86_64 sidecar hosts the vendored Saleae standalone analyzers in an isolated process. It does not require Logic 2 to be installed on the target machine.

## Build and verify

```bash
native/saleae-analyzer-sidecar/build.sh
```

The build compiles the compatibility runtime and analyzer plugins from `vendor/saleae-standalone`, then links the JSON sidecar against that runtime.

Set these variables to use the Rust `SaleaeNativeDecoder` adapter:

```bash
arch="$(uname -m)"
export PXLOGIC_SALEAE_SIDECAR="$PWD/target/native/saleae-analyzer-sidecar-$arch/pxlogic-saleae-analyzer-sidecar"
export PXLOGIC_SALEAE_RUNTIME_ROOT="$PWD/target/native/saleae-analyzer-sidecar-$arch/runtime"
```

Rust transports captures and normalizes sidecar output; protocol state machines remain in the vendored Saleae analyzer plugins.
