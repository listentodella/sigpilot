#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SOURCE_DIR="$ROOT_DIR/native/saleae-graph-sidecar"
BUILD_DIR="${PXLOGIC_NATIVE_BUILD_DIR:-$ROOT_DIR/target/native/saleae-graph-sidecar}"
CACHE_DIR="${PXLOGIC_NATIVE_CACHE_DIR:-$ROOT_DIR/target/native-cache}"
JSON_DIR="$CACHE_DIR/json"
JSON_COMMIT="9cca280a4d0ccf0c08f47a99aa71d1b0e52f8d03"

if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  printf 'Saleae GraphServer sidecar currently requires macOS arm64.\n' >&2
  exit 1
fi

mkdir -p "$BUILD_DIR"
mkdir -p "$CACHE_DIR"
if [[ ! -d "$JSON_DIR/.git" ]]; then
  git clone https://github.com/nlohmann/json.git "$JSON_DIR"
fi
if ! git -C "$JSON_DIR" cat-file -e "$JSON_COMMIT^{commit}" 2>/dev/null; then
  git -C "$JSON_DIR" fetch --quiet origin "$JSON_COMMIT"
fi
git -C "$JSON_DIR" checkout --quiet --detach "$JSON_COMMIT"

xcrun clang++ -std=c++17 -O2 -g \
  -I"$JSON_DIR/single_include" \
  "$SOURCE_DIR/src/main.cpp" \
  -o "$BUILD_DIR/pxlogic-saleae-graph-sidecar"
printf '%s\n' "$BUILD_DIR/pxlogic-saleae-graph-sidecar"
