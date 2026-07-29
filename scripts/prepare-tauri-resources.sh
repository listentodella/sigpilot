#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RESOURCE_DIR="$ROOT_DIR/resources/native"
SALEAE_GRAPH_RUNTIME_ARCHIVE="$ROOT_DIR/vendor/saleae-runtime-graph-2.4.43-macos-arm64.tar.gz"
HOST_OS="$(uname -s)"
HOST_ARCH="$(uname -m)"

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
  if [[ -e "$target" && "$source" -ef "$target" ]]; then
    return 0
  fi
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

sigrok_source_root() {
  local candidate
  for candidate in \
    "$ROOT_DIR/vendor/pxview-sigrokdecode" \
    "$ROOT_DIR/pxview-fork"
  do
    if [[ -d "$candidate/libsigrokdecode" && -d "$candidate/common" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

sigrok_executable_name() {
  case "$HOST_OS" in
    MINGW*|MSYS*|CYGWIN*) printf 'pxlogic-sigrok-sidecar.exe\n' ;;
    *) printf 'pxlogic-sigrok-sidecar\n' ;;
  esac
}

copy_shared_dependencies() {
  local binary="$1"
  local target_dir="$2"
  local line dep

  case "$HOST_OS" in
    MINGW*|MSYS*|CYGWIN*)
      command -v ldd >/dev/null 2>&1 || return 0
      while IFS= read -r line; do
        dep="$(printf '%s\n' "$line" | awk '{print $3}')"
        if [[ -f "$dep" && "$dep" == /*/bin/*.dll ]]; then
          copy_file "$dep" "$target_dir/$(basename "$dep")"
        fi
      done < <(ldd "$binary" 2>/dev/null || true)
      ;;
    Linux)
      [[ "${PXLOGIC_COPY_NATIVE_DEPS:-0}" == "1" ]] || return 0
      command -v ldd >/dev/null 2>&1 || return 0
      while IFS= read -r line; do
        dep="$(printf '%s\n' "$line" | awk '{print $3}')"
        if [[ ! -f "$dep" ]]; then
          continue
        fi
        case "$(basename "$dep")" in
          ld-linux*|libc.so.*|libm.so.*|libdl.so.*|libpthread.so.*|librt.so.*|libgcc_s.so.*)
            continue
            ;;
        esac
        copy_file "$dep" "$target_dir/$(basename "$dep")"
      done < <(ldd "$binary" 2>/dev/null || true)
      ;;
  esac
}

copy_python_runtime() {
  local target_dir="$1"
  local python_prefix python_version python_source python_target

  case "$HOST_OS" in
    Darwin) return 0 ;;
  esac
  command -v python3 >/dev/null 2>&1 || {
    printf 'python3 is required to bundle the Sigrok runtime.\n' >&2
    return 1
  }

  python_prefix="$(python3 -c 'import sys; print(sys.base_prefix)')"
  python_version="$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')"
  python_source="$python_prefix/lib/python$python_version"
  python_target="$target_dir/python-runtime/lib/python$python_version"
  if [[ ! -d "$python_source" ]]; then
    printf 'Python standard library was not found at %s.\n' "$python_source" >&2
    return 1
  fi

  copy_directory "$python_source" "$python_target"
  rm -rf "$python_target/site-packages" "$python_target"/config-*
  find "$python_target" -type d -name __pycache__ -prune -exec rm -rf {} +
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

if [[ "$HOST_OS" == "Darwin" && "$HOST_ARCH" == "arm64" ]]; then
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

if sigrok_root="$(sigrok_source_root)"; then
  if [[ "${PXLOGIC_REUSE_SIGROK_BUILD:-0}" == "1" ]]; then
    sigrok_build_dir="${PXLOGIC_SIGROK_BUILD_DIR:-$ROOT_DIR/native/sigrok-analyzer-sidecar/target}"
    sigrok_sidecar="$sigrok_build_dir/$(sigrok_executable_name)"
    if [[ ! -f "$sigrok_sidecar" ]]; then
      printf 'Reusable Sigrok sidecar was not found at %s.\n' "$sigrok_sidecar" >&2
      exit 1
    fi
  else
    sigrok_sidecar="$(run_build_script "$ROOT_DIR/native/sigrok-analyzer-sidecar/build.sh")"
    sigrok_build_dir="$(dirname "$sigrok_sidecar")"
  fi
  sigrok_target_name="$(sigrok_executable_name)"
  copy_executable "$sigrok_sidecar" \
    "$RESOURCE_DIR/sigrok-analyzer-sidecar/$sigrok_target_name"
  copy_shared_dependencies "$sigrok_sidecar" "$RESOURCE_DIR/sigrok-analyzer-sidecar"
  case "$HOST_OS" in
    MINGW*|MSYS*|CYGWIN*)
      for runtime_dll in "$sigrok_build_dir"/*.dll; do
        [[ -f "$runtime_dll" ]] || continue
        copy_file "$runtime_dll" \
          "$RESOURCE_DIR/sigrok-analyzer-sidecar/$(basename "$runtime_dll")"
      done
      ;;
  esac
  copy_python_runtime "$RESOURCE_DIR/sigrok-analyzer-sidecar"
  if [[ -d "$sigrok_build_dir/decoders/c_decoders" ]]; then
    mkdir -p "$RESOURCE_DIR/sigrok-analyzer-sidecar/decoders"
    cp -R "$sigrok_build_dir/decoders/c_decoders" \
      "$RESOURCE_DIR/sigrok-analyzer-sidecar/decoders/c_decoders"
    find "$RESOURCE_DIR/sigrok-analyzer-sidecar/decoders/c_decoders" \
      -type f \( -name '*.so' -o -name '*.dylib' -o -name '*.dll' \) \
      -exec chmod 755 {} +
  fi
  if [[ -d "$sigrok_root/libsigrokdecode/decoders" ]]; then
    mkdir -p "$RESOURCE_DIR/sigrok-analyzer-sidecar/decoders"
    cp -R "$sigrok_root/libsigrokdecode/decoders" \
      "$RESOURCE_DIR/sigrok-analyzer-sidecar/decoders/python_decoders"
  fi
else
  printf 'Skipping Sigrok sidecar: vendor/pxview-sigrokdecode or pxview-fork is not available in this checkout.\n' >&2
fi
