#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUNTIME_ROOT="${PXLOGIC_SALEAE_RUNTIME_ROOT:-/Volumes/tp7100s/Downloads/Saleae Logic.app/Contents/Resources/macos-arm64}"
SIDECAR="$($ROOT_DIR/native/saleae-graph-sidecar/build.sh)"

"$SIDECAR" --runtime-root "$RUNTIME_ROOT" --probe
printf '%s' '{"type":"request","contents":{"id":1,"type":"Saleae::Graph::GraphInitRequestData","newSessionId":1,"meta":{"sessionId":1,"destination":"GraphServer"}}}' \
  | "$SIDECAR" --runtime-root "$RUNTIME_ROOT" --relay \
  | grep -q 'Saleae::Graph::GraphInitResponseData'

printf 'Saleae GraphServer relay verified.\n'
