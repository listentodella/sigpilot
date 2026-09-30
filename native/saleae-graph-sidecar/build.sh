#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SOURCE_DIR="$ROOT_DIR/native/saleae-graph-sidecar"
BUILD_DIR="${SIGPILOT_NATIVE_BUILD_DIR:-$ROOT_DIR/target/native/saleae-graph-sidecar}"
# nlohmann/json 3.11.3, vendored at the commit this build used to check out:
# 9cca280a4d0ccf0c08f47a99aa71d1b0e52f8d03. See vendor/nlohmann-json/README.md.
# Previously cloned upstream into target/native-cache/json, which `cargo clean`
# wiped — so every clean build re-fetched 304 MB for one 900 KB header.
JSON_INCLUDE_DIR="${SIGPILOT_NLOHMANN_JSON_INCLUDE:-$ROOT_DIR/vendor/nlohmann-json/single_include}"
if [[ ! -f "$JSON_INCLUDE_DIR/nlohmann/json.hpp" ]]; then
  printf 'nlohmann/json was not found at %s.\n' "$JSON_INCLUDE_DIR" >&2
  printf 'It is vendored at vendor/nlohmann-json/single_include; restore it, or point\n' >&2
  printf 'SIGPILOT_NLOHMANN_JSON_INCLUDE at another single_include directory.\n' >&2
  exit 1
fi

if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  printf 'Saleae GraphServer sidecar currently requires macOS arm64.\n' >&2
  exit 1
fi

mkdir -p "$BUILD_DIR"

xcrun clang++ -std=c++17 -O2 -g \
  -I"$JSON_INCLUDE_DIR" \
  "$SOURCE_DIR/src/main.cpp" \
  -o "$BUILD_DIR/sigpilot-saleae-graph-sidecar"
printf '%s\n' "$BUILD_DIR/sigpilot-saleae-graph-sidecar"
