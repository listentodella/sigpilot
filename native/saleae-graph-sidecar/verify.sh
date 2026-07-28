#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUNTIME_ROOT="${PXLOGIC_SALEAE_RUNTIME_ROOT:-}"
if [[ -z "$RUNTIME_ROOT" ]]; then
  for candidate in \
    "$ROOT_DIR/resources/native/saleae-runtime-2.4.43" \
    "$ROOT_DIR/vendor/saleae-runtime-2.4.43" \
    "$ROOT_DIR/target/native/saleae-runtime-2.4.43" \
    "$ROOT_DIR/target/native/saleae-runtime-full-2.4.43" \
    "$ROOT_DIR/target/native/saleae-runtime-graph-2.4.43" \
    "/Applications/Saleae Logic.app/Contents/Resources/macos-arm64" \
    "/Applications/Logic 2.app/Contents/Resources/macos-arm64" \
    "${HOME:-}/Applications/Saleae Logic.app/Contents/Resources/macos-arm64" \
    "${HOME:-}/Applications/Logic 2.app/Contents/Resources/macos-arm64" \
    "${HOME:-}/Downloads/Saleae Logic.app/Contents/Resources/macos-arm64" \
    "${HOME:-}/Downloads/Logic 2.app/Contents/Resources/macos-arm64"; do
    if [[ -f "$candidate/libgraph_server_shared.dylib" ]]; then
      RUNTIME_ROOT="$candidate"
      break
    fi
  done
fi
if [[ -z "$RUNTIME_ROOT" ]]; then
  printf 'Saleae GraphServer runtime not found; run scripts/prepare-tauri-resources.sh or set PXLOGIC_SALEAE_RUNTIME_ROOT.\n' >&2
  exit 1
fi
SIDECAR="$($ROOT_DIR/native/saleae-graph-sidecar/build.sh)"

"$SIDECAR" --runtime-root "$RUNTIME_ROOT" --probe
printf '%s' '{"type":"request","contents":{"id":1,"type":"Saleae::Graph::GraphInitRequestData","newSessionId":1,"meta":{"sessionId":1,"destination":"GraphServer"}}}' \
  | "$SIDECAR" --runtime-root "$RUNTIME_ROOT" --relay \
  | grep -q 'Saleae::Graph::GraphInitResponseData'

printf 'Saleae GraphServer relay verified.\n'
