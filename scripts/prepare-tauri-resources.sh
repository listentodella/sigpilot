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
  "$RESOURCE_DIR/sigrok-analyzer-sidecar"
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
      [[ "${SIGPILOT_COPY_NATIVE_DEPS:-0}" == "1" ]] || return 0
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
    find "$RESOURCE_DIR/sigrok-analyzer-sidecar/decoders/python_decoders" \
      -type d -name __pycache__ -prune -exec rm -rf {} +
    find "$RESOURCE_DIR/sigrok-analyzer-sidecar/decoders/python_decoders" \
      -type f -name '*.pyc' -delete
  fi
else
  printf 'Skipping Sigrok sidecar: vendor/pxview-sigrokdecode or pxview-fork is not available in this checkout.\n' >&2
fi

node "$ROOT_DIR/scripts/native-runtime.mjs" seal
