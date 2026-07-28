#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RESOURCE_DIR="$ROOT_DIR/resources/native"
SALEAE_GRAPH_RUNTIME_ARCHIVE="$ROOT_DIR/vendor/saleae-runtime-graph-2.4.43-macos-arm64.tar.gz"

mkdir -p "$RESOURCE_DIR"
rm -rf \
  "$RESOURCE_DIR/saleae-analyzer-sidecar" \
  "$RESOURCE_DIR/saleae-graph-sidecar" \
  "$RESOURCE_DIR/saleae-runtime-2.4.43" \
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

copy_directory() {
  local source="$1"
  local target="$2"
  mkdir -p "$target"
  if command -v ditto >/dev/null 2>&1; then
    ditto --norsrc "$source" "$target"
  else
    cp -R "$source/." "$target/"
  fi
}

is_saleae_analyzer_runtime() {
  local source="$1"
  [[ -f "$source/libAnalyzer.dylib" \
    && -f "$source/Analyzers/libserial_analyzer.so" \
    && -f "$source/Analyzers/libi2c_analyzer.so" \
    && -f "$source/Analyzers/libspi_analyzer.so" \
    && -f "$source/Analyzers/libi2s_analyzer.so" \
    && -f "$source/Analyzers/libcan_analyzer.so" \
    && -f "$source/Analyzers/liblin_analyzer.so" \
    && -f "$source/Analyzers/libsimple_parallel_analyzer.so" ]]
}

is_saleae_graph_runtime() {
  local source="$1"
  [[ -f "$source/libgraph_server_shared.dylib" \
    && -f "$source/pythonlibs/lib/python314.zip" \
    && -d "$source/pythonlibs/lib/python3.14/site-packages/saleae" \
    && -d "$source/pythonlibs/lib/python3.14/site-packages/numpy" ]]
}

saleae_runtime_source() {
  local candidate
  for candidate in \
    "${PXLOGIC_SALEAE_RUNTIME_ROOT:-}" \
    "$ROOT_DIR/vendor/saleae-runtime-2.4.43" \
    "$ROOT_DIR/target/native/saleae-runtime-2.4.43"
  do
    if [[ -n "$candidate" ]] && is_saleae_analyzer_runtime "$candidate"; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

copy_saleae_graph_runtime() {
  local target="$1"
  local source

  for source in \
    "${PXLOGIC_SALEAE_RUNTIME_ROOT:-}" \
    "$ROOT_DIR/target/native/saleae-runtime-full-2.4.43" \
    "$ROOT_DIR/target/native/saleae-runtime-graph-2.4.43"
  do
    if [[ -n "$source" ]] && is_saleae_graph_runtime "$source"; then
      copy_file "$source/libgraph_server_shared.dylib" \
        "$target/libgraph_server_shared.dylib"
      copy_directory "$source/pythonlibs" "$target/pythonlibs"
      return 0
    fi
  done

  if [[ -f "$SALEAE_GRAPH_RUNTIME_ARCHIVE" ]]; then
    tar -xzf "$SALEAE_GRAPH_RUNTIME_ARCHIVE" -C "$target"
    return 0
  fi

  return 1
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

  if saleae_runtime="$(saleae_runtime_source)"; then
    copy_directory "$saleae_runtime" "$RESOURCE_DIR/saleae-runtime-2.4.43"
    if ! copy_saleae_graph_runtime "$RESOURCE_DIR/saleae-runtime-2.4.43"; then
      printf 'Skipping Saleae graph runtime: no GraphServer runtime source was found.\n' >&2
    fi
    find "$RESOURCE_DIR/saleae-runtime-2.4.43" \
      -type f \( -name '*.dylib' -o -name '*.so' \) -exec chmod 755 {} +
  else
    printf 'Skipping Saleae analyzer runtime: no Logic 2.4.43 runtime source was found.\n' >&2
  fi
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
