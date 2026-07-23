#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SIDECAR_DIR="$ROOT_DIR/native/sigrok-analyzer-sidecar"
BUILD_DIR="${PXLOGIC_SIGROK_BUILD_DIR:-$SIDECAR_DIR/target}"

if command -v cmake >/dev/null 2>&1; then
  CMAKE_BIN="$(command -v cmake)"
elif [[ -x /opt/homebrew/bin/cmake ]]; then
  CMAKE_BIN=/opt/homebrew/bin/cmake
else
  echo "cmake is required to build the Sigrok sidecar" >&2
  exit 1
fi

export PATH="/opt/homebrew/bin:$PATH"
"$CMAKE_BIN" -S "$SIDECAR_DIR" -B "$BUILD_DIR" -DCMAKE_BUILD_TYPE=Release
"$CMAKE_BIN" --build "$BUILD_DIR" --config Release --parallel

echo "$BUILD_DIR/pxlogic-sigrok-sidecar"

