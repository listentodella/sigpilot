#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SIDECAR_DIR="$ROOT_DIR/native/sigrok-analyzer-sidecar"
BUILD_DIR="${PXLOGIC_SIGROK_BUILD_DIR:-$SIDECAR_DIR/target}"

if [[ -n "${PXLOGIC_SIGROK_SOURCE_ROOT:-}" ]]; then
  PXVIEW_ROOT="$PXLOGIC_SIGROK_SOURCE_ROOT"
elif [[ -d "$ROOT_DIR/vendor/pxview-sigrokdecode/libsigrokdecode" ]]; then
  PXVIEW_ROOT="$ROOT_DIR/vendor/pxview-sigrokdecode"
else
  PXVIEW_ROOT="$ROOT_DIR/pxview-fork"
fi

if command -v cmake >/dev/null 2>&1; then
  CMAKE_BIN="$(command -v cmake)"
elif [[ -x /opt/homebrew/bin/cmake ]]; then
  CMAKE_BIN=/opt/homebrew/bin/cmake
else
  echo "cmake is required to build the Sigrok sidecar" >&2
  exit 1
fi

if [[ "$(uname -s)" == "Darwin" ]]; then
  export PATH="/opt/homebrew/bin:$PATH"
fi
cmake_platform_args=()
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    python_executable="$(command -v python3)"
    python_root="$(cd "$(dirname "$python_executable")/.." && pwd)"
    cmake_platform_args+=(
      "-DPython3_ROOT_DIR=$(cygpath -m "$python_root")"
      "-DPython3_EXECUTABLE=$(cygpath -m "$python_executable")"
      "-DPython3_FIND_REGISTRY=NEVER"
    )
    ;;
esac
if [[ -d "$BUILD_DIR/decoders/c_decoders" ]]; then
  find "$BUILD_DIR/decoders/c_decoders" -maxdepth 1 -type f \
    -name 'lib*_c.*' -delete
fi
"$CMAKE_BIN" -S "$SIDECAR_DIR" -B "$BUILD_DIR" \
  -DCMAKE_BUILD_TYPE=Release \
  -DPXVIEW_ROOT="$PXVIEW_ROOT" \
  "${cmake_platform_args[@]}"
"$CMAKE_BIN" --build "$BUILD_DIR" --config Release --parallel

if [[ -f "$BUILD_DIR/pxlogic-sigrok-sidecar.exe" ]]; then
  echo "$BUILD_DIR/pxlogic-sigrok-sidecar.exe"
else
  echo "$BUILD_DIR/pxlogic-sigrok-sidecar"
fi
