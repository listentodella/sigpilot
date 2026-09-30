# Saleae Native analyzer sidecar

This macOS, Linux, and Windows sidecar hosts the vendored Saleae standalone analyzers in an isolated process. It does not require Logic 2 or Python to be installed on the target machine.

## Build and verify

```bash
native/saleae-analyzer-sidecar/build.sh
```

The build compiles the compatibility runtime and analyzer plugins from `vendor/saleae-standalone`, then links the JSON sidecar against that runtime.

Set these variables to use the Rust `SaleaeNativeDecoder` adapter:

```bash
sidecar="$(native/saleae-analyzer-sidecar/build.sh)"
export SIGPILOT_SALEAE_SIDECAR="$sidecar"
export SIGPILOT_SALEAE_RUNTIME_ROOT="$(dirname "$sidecar")/runtime"
```

Rust transports captures and normalizes sidecar output; protocol state machines remain in the vendored Saleae analyzer plugins.
