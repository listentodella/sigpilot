#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RESOURCE_DIR="$ROOT_DIR/resources/native"

mkdir -p "$RESOURCE_DIR"
rm -rf \
  "$RESOURCE_DIR/saleae-analyzer-sidecar" \
  "$RESOURCE_DIR/saleae-graph-sidecar" \
  "$RESOURCE_DIR/sigrok-analyzer-sidecar"

copy_file() {
  local source="$1"
  local target="$2"
  mkdir -p "$(dirname "$target")"
  cp "$source" "$target"
  chmod u+rw "$target"
}

copy_executable() {
  copy_file "$1" "$2"
  chmod 755 "$2"
}

run_build_script() {
  local script="$1"
  local output
  output="$("$script")"
  if [[ -n "$output" ]]; then
    printf '%s\n' "$output" >&2
  fi
  printf '%s\n' "$output" | tail -n 1
}

if [[ "$(uname -s)" == "Darwin" && "$(uname -m)" == "arm64" ]]; then
  saleae_analyzer="$(run_build_script "$ROOT_DIR/native/saleae-analyzer-sidecar/build.sh")"
  saleae_analyzer_dir="$(dirname "$saleae_analyzer")"
  copy_executable "$saleae_analyzer" \
    "$RESOURCE_DIR/saleae-analyzer-sidecar/pxlogic-saleae-analyzer-sidecar"
  copy_file "$saleae_analyzer_dir/libAnalyzer.dylib" \
    "$RESOURCE_DIR/saleae-analyzer-sidecar/libAnalyzer.dylib"

  saleae_graph="$(run_build_script "$ROOT_DIR/native/saleae-graph-sidecar/build.sh")"
  copy_executable "$saleae_graph" \
    "$RESOURCE_DIR/saleae-graph-sidecar/pxlogic-saleae-graph-sidecar"
else
  printf 'Skipping Saleae native sidecars: macOS arm64 is required.\n' >&2
fi

if [[ -d "$ROOT_DIR/pxview-fork/libsigrokdecode" ]]; then
  sigrok_sidecar="$(run_build_script "$ROOT_DIR/native/sigrok-analyzer-sidecar/build.sh")"
  sigrok_build_dir="$(dirname "$sigrok_sidecar")"
  copy_executable "$sigrok_sidecar" \
    "$RESOURCE_DIR/sigrok-analyzer-sidecar/pxlogic-sigrok-sidecar"
  if [[ -d "$sigrok_build_dir/decoders/c_decoders" ]]; then
    mkdir -p "$RESOURCE_DIR/sigrok-analyzer-sidecar/decoders"
    cp -R "$sigrok_build_dir/decoders/c_decoders" \
      "$RESOURCE_DIR/sigrok-analyzer-sidecar/decoders/c_decoders"
    find "$RESOURCE_DIR/sigrok-analyzer-sidecar/decoders/c_decoders" -type f -name '*.so' -exec chmod 755 {} +
  fi
  if [[ -d "$ROOT_DIR/pxview-fork/libsigrokdecode/decoders" ]]; then
    mkdir -p "$RESOURCE_DIR/sigrok-analyzer-sidecar/decoders"
    cp -R "$ROOT_DIR/pxview-fork/libsigrokdecode/decoders" \
      "$RESOURCE_DIR/sigrok-analyzer-sidecar/decoders/python_decoders"
  fi
else
  printf 'Skipping Sigrok sidecar: pxview-fork is not available in this checkout.\n' >&2
fi
