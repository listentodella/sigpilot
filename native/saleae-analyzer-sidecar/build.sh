#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SOURCE_DIR="$ROOT_DIR/native/saleae-analyzer-sidecar"
RUNTIME_SOURCE_DIR="$ROOT_DIR/vendor/saleae-standalone/runtime"
HOST_OS="$(uname -s)"
HOST_ARCH="$(uname -m)"
TARGET_ARCH="${PXLOGIC_MACOS_ARCH:-$HOST_ARCH}"
CACHE_DIR="${PXLOGIC_NATIVE_CACHE_DIR:-$ROOT_DIR/target/native-cache}"
BUILD_DIR="${PXLOGIC_NATIVE_BUILD_DIR:-$ROOT_DIR/target/native/saleae-analyzer-sidecar-$TARGET_ARCH}"
RUNTIME_BUILD_DIR="${PXLOGIC_SALEAE_RUNTIME_BUILD_DIR:-$ROOT_DIR/target/native/saleae-standalone-runtime-$TARGET_ARCH}"
JSON_DIR="$CACHE_DIR/json"
JSON_COMMIT="9cca280a4d0ccf0c08f47a99aa71d1b0e52f8d03"

if [[ "$HOST_OS" != "Darwin" ]]; then
  printf 'Saleae standalone sidecar currently requires macOS.\n' >&2
  exit 1
fi
case "$TARGET_ARCH" in
  arm64|x86_64) ;;
  *)
    printf 'Unsupported macOS architecture: %s\n' "$TARGET_ARCH" >&2
    exit 1
    ;;
esac

mkdir -p "$CACHE_DIR" "$BUILD_DIR" "$RUNTIME_BUILD_DIR"

cmake -S "$RUNTIME_SOURCE_DIR" -B "$RUNTIME_BUILD_DIR" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release -DCMAKE_OSX_ARCHITECTURES="$TARGET_ARCH"
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
  -arch "$TARGET_ARCH"
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
