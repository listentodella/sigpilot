#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SOURCE_DIR="$ROOT_DIR/native/saleae-analyzer-sidecar"
RUNTIME_SOURCE_DIR="$ROOT_DIR/vendor/saleae-standalone/runtime"
CACHE_DIR="${PXLOGIC_NATIVE_CACHE_DIR:-$ROOT_DIR/target/native-cache}"
BUILD_DIR="${PXLOGIC_NATIVE_BUILD_DIR:-$ROOT_DIR/target/native/saleae-analyzer-sidecar}"
RUNTIME_BUILD_DIR="${PXLOGIC_SALEAE_RUNTIME_BUILD_DIR:-$ROOT_DIR/target/native/saleae-standalone-runtime}"
JSON_DIR="$CACHE_DIR/json"
JSON_COMMIT="9cca280a4d0ccf0c08f47a99aa71d1b0e52f8d03"

if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  printf 'Saleae Logic 2.4.43 sidecar currently requires macOS arm64.\n' >&2
  exit 1
fi

mkdir -p "$CACHE_DIR" "$BUILD_DIR" "$RUNTIME_BUILD_DIR"

cmake -S "$RUNTIME_SOURCE_DIR" -B "$RUNTIME_BUILD_DIR" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release -DCMAKE_OSX_ARCHITECTURES=arm64
cmake --build "$RUNTIME_BUILD_DIR"

if [[ ! -d "$JSON_DIR/.git" ]]; then
  git clone https://github.com/nlohmann/json.git "$JSON_DIR"
fi
if ! git -C "$JSON_DIR" cat-file -e "$JSON_COMMIT^{commit}" 2>/dev/null; then
  git -C "$JSON_DIR" fetch --quiet origin "$JSON_COMMIT"
fi
git -C "$JSON_DIR" checkout --quiet --detach "$JSON_COMMIT"

if [[ -n "${CXX:-}" ]]; then
  CXX_COMMAND=("$CXX")
else
  CXX_COMMAND=(xcrun clang++)
fi
COMMON_FLAGS=(
  -std=c++17
  -O2
  -I"$RUNTIME_SOURCE_DIR/include"
  -I"$JSON_DIR/single_include"
)

"${CXX_COMMAND[@]}" "${COMMON_FLAGS[@]}" \
  "$SOURCE_DIR/src/standalone_main.cpp" \
  -L"$RUNTIME_BUILD_DIR/lib" -lsaleae_compat \
  -Wl,-rpath,@loader_path/runtime \
  -o "$BUILD_DIR/pxlogic-saleae-analyzer-sidecar"

rm -rf "$BUILD_DIR/runtime"
mkdir -p "$BUILD_DIR/runtime"
cp "$RUNTIME_BUILD_DIR/lib/"libsaleae_compat.dylib "$BUILD_DIR/runtime/"
cp "$RUNTIME_BUILD_DIR/lib/"lib*_analyzer.so "$BUILD_DIR/runtime/"

printf '%s\n' "$BUILD_DIR/pxlogic-saleae-analyzer-sidecar"
