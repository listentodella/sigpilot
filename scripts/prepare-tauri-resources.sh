#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RESOURCE_DIR="$ROOT_DIR/resources/native"
HOST_OS="$(uname -s)"
HOST_ARCH="$(uname -m)"

export PYTHONDONTWRITEBYTECODE=1
if [[ "${SIGPILOT_FORCE_NATIVE_BUILD:-0}" != "1" ]] && \
    node "$ROOT_DIR/scripts/native-runtime.mjs" verify >/dev/null 2>&1; then
  printf 'Native resources unchanged; skipping build and copy.\n'
  exit 0
fi
if [[ "${SIGPILOT_PREBUILT_NATIVE:-0}" == "1" ]]; then
  printf 'Prebuilt native resources failed validation; native compilation is disabled.\n' >&2
  exit 1
fi

mkdir -p "$RESOURCE_DIR"
rm -rf \
  "$RESOURCE_DIR/saleae-analyzer-sidecar" \
  "$RESOURCE_DIR/saleae-graph-sidecar" \
  "$RESOURCE_DIR/saleae-runtime-2.4.43" \
  "$RESOURCE_DIR/sigrok-analyzer-sidecar" \
  "$RESOURCE_DIR/python-runtime" \
  "$RESOURCE_DIR/hla-analyzer-sidecar"
rm -f "$RESOURCE_DIR/native-runtime-manifest.json"

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
    MINGW*|MSYS*|CYGWIN*) printf 'sigpilot-sigrok-sidecar.exe\n' ;;
    *) printf 'sigpilot-sigrok-sidecar\n' ;;
  esac
}

saleae_executable_name() {
  case "$HOST_OS" in
    MINGW*|MSYS*|CYGWIN*) printf 'sigpilot-saleae-analyzer-sidecar.exe\n' ;;
    *) printf 'sigpilot-saleae-analyzer-sidecar\n' ;;
  esac
}

# Select one interpreter for packaging and require CMake to link that installation.
PYTHON_BIN="${SIGPILOT_PYTHON_EXECUTABLE:-$(command -v python3 || true)}"
if [[ -z "$PYTHON_BIN" ]]; then
  printf 'CPython is required to bundle the shared native runtime.\n' >&2
  exit 1
fi
export SIGPILOT_SIGROK_PYTHON_ROOT="${SIGPILOT_SIGROK_PYTHON_ROOT:-$("$PYTHON_BIN" -c 'import sys; print(sys.base_prefix)')}"

run_build_script() {
  local script="$1"
  local output
  if ! output="$("$script")"; then
    [[ -z "$output" ]] || printf '%s\n' "$output" >&2
    return 1
  fi
  if [[ -n "$output" ]]; then
    printf '%s\n' "$output" >&2
  fi
  printf '%s\n' "$output" | tail -n 1
}

saleae_analyzer="$(run_build_script "$ROOT_DIR/native/saleae-analyzer-sidecar/build.sh")"
saleae_analyzer_dir="$(dirname "$saleae_analyzer")"
saleae_target_name="$(saleae_executable_name)"
copy_executable "$saleae_analyzer" \
  "$RESOURCE_DIR/saleae-analyzer-sidecar/$saleae_target_name"
copy_directory "$saleae_analyzer_dir/runtime" \
  "$RESOURCE_DIR/saleae-analyzer-sidecar/runtime"
case "$HOST_OS" in
  MINGW*|MSYS*|CYGWIN*)
    for runtime_dll in "$saleae_analyzer_dir"/*.dll; do
      [[ -f "$runtime_dll" ]] || continue
      copy_file "$runtime_dll" \
        "$RESOURCE_DIR/saleae-analyzer-sidecar/$(basename "$runtime_dll")"
    done
    ;;
  *)
    find "$RESOURCE_DIR/saleae-analyzer-sidecar/runtime" \
      -type f \( -name '*.dylib' -o -name '*.so' \) -exec chmod 755 {} +
    ;;
esac

if sigrok_root="$(sigrok_source_root)"; then
  if [[ "${SIGPILOT_REUSE_SIGROK_BUILD:-0}" == "1" ]]; then
    sigrok_build_dir="${SIGPILOT_SIGROK_BUILD_DIR:-$ROOT_DIR/native/sigrok-analyzer-sidecar/target}"
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
  # Validate before copying/relocating; stale CMake selections must never ship.
  "$PYTHON_BIN" "$ROOT_DIR/scripts/package-python-runtime.py" "$RESOURCE_DIR" "$sigrok_build_dir" --check
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
    find "$RESOURCE_DIR/sigrok-analyzer-sidecar/decoders/python_decoders" \
      -type d -name __pycache__ -prune -exec rm -rf {} +
    find "$RESOURCE_DIR/sigrok-analyzer-sidecar/decoders/python_decoders" \
      -type f -name '*.pyc' -delete
  fi
else
  printf 'Skipping Sigrok sidecar: vendor/pxview-sigrokdecode or pxview-fork is not available in this checkout.\n' >&2
fi

if [[ ! -f "$ROOT_DIR/native/hla-analyzer-sidecar/main.py" ]]; then
  printf 'HLA host source native/hla-analyzer-sidecar/main.py is required.\n' >&2
  exit 1
fi
mkdir -p "$RESOURCE_DIR/hla-analyzer-sidecar"
copy_file "$ROOT_DIR/native/hla-analyzer-sidecar/main.py" "$RESOURCE_DIR/hla-analyzer-sidecar/main.py"
copy_directory "$ROOT_DIR/native/hla-analyzer-sidecar/saleae" "$RESOURCE_DIR/hla-analyzer-sidecar/saleae"
find "$RESOURCE_DIR/hla-analyzer-sidecar" -type d -name __pycache__ -prune -exec rm -rf {} +
find "$RESOURCE_DIR/hla-analyzer-sidecar" -type f \( -name '*.pyc' -o -name '*.pyo' \) -delete
"$PYTHON_BIN" "$ROOT_DIR/scripts/package-python-runtime.py" "$RESOURCE_DIR" "${sigrok_build_dir:?Sigrok build is required for a matching shared Python runtime}"

node "$ROOT_DIR/scripts/native-runtime.mjs" seal
