#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SOURCE_DIR="$ROOT_DIR/native/saleae-analyzer-sidecar"
CACHE_DIR="${PXLOGIC_NATIVE_CACHE_DIR:-$ROOT_DIR/target/native-cache}"
BUILD_DIR="${PXLOGIC_NATIVE_BUILD_DIR:-$ROOT_DIR/target/native/saleae-analyzer-sidecar}"
SDK_DIR="$CACHE_DIR/AnalyzerSDK"
JSON_DIR="$CACHE_DIR/json"
SDK_COMMIT="16a9ebff783614691781a8cd69d733abc8c8c722"
JSON_COMMIT="9cca280a4d0ccf0c08f47a99aa71d1b0e52f8d03"

if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  printf 'Saleae Logic 2.4.43 sidecar currently requires macOS arm64.\n' >&2
  exit 1
fi

mkdir -p "$CACHE_DIR" "$BUILD_DIR"

if [[ ! -d "$SDK_DIR/.git" ]]; then
  git clone https://github.com/saleae/AnalyzerSDK.git "$SDK_DIR"
fi
if ! git -C "$SDK_DIR" cat-file -e "$SDK_COMMIT^{commit}" 2>/dev/null; then
  git -C "$SDK_DIR" fetch --quiet origin "$SDK_COMMIT"
fi
git -C "$SDK_DIR" checkout --quiet --detach "$SDK_COMMIT"

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
  -g
  -DLOGIC2
  -I"$SDK_DIR/include"
  -I"$SDK_DIR/testlib"
  -I"$JSON_DIR/single_include"
  -I"$SOURCE_DIR/src"
)

"${CXX_COMMAND[@]}" "${COMMON_FLAGS[@]}" -fPIC -dynamiclib \
  -Wl,-install_name,@rpath/libAnalyzer.dylib \
  "$SDK_DIR/testlib/AnalyzerStubs.cpp" \
  "$SDK_DIR/testlib/HelperStubs.cpp" \
  "$SDK_DIR/testlib/MockChannelData.cpp" \
  "$SDK_DIR/testlib/MockSimulatedChannelDescriptor.cpp" \
  "$SDK_DIR/testlib/SettingsStubs.cpp" \
  "$SDK_DIR/testlib/StreamHelpers.cpp" \
  "$SOURCE_DIR/src/instance_compat.cpp" \
  "$SOURCE_DIR/src/result_capture.cpp" \
  "$SOURCE_DIR/src/sdk_compat.cpp" \
  -o "$BUILD_DIR/libAnalyzer.dylib"

"${CXX_COMMAND[@]}" "${COMMON_FLAGS[@]}" \
  "$SOURCE_DIR/src/main.cpp" \
  -L"$BUILD_DIR" -lAnalyzer \
  -Wl,-rpath,@loader_path \
  -o "$BUILD_DIR/pxlogic-saleae-analyzer-sidecar"

printf '%s\n' "$BUILD_DIR/pxlogic-saleae-analyzer-sidecar"
