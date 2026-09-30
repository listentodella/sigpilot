#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SIDECAR_DIR="$ROOT_DIR/native/sigrok-analyzer-sidecar"
BUILD_DIR="${SIGPILOT_SIGROK_BUILD_DIR:-$SIDECAR_DIR/target}"

if [[ -n "${SIGPILOT_SIGROK_SOURCE_ROOT:-}" ]]; then
  PXVIEW_ROOT="$SIGPILOT_SIGROK_SOURCE_ROOT"
elif [[ -d "$ROOT_DIR/vendor/pxview-sigrokdecode/libsigrokdecode" ]]; then
  PXVIEW_ROOT="$ROOT_DIR/vendor/pxview-sigrokdecode"
else
  PXVIEW_ROOT="$ROOT_DIR/pxview-fork"
fi

if command -v cmake >/dev/null 2>&1; then
  CMAKE_BIN="$(command -v cmake)"
elif [[ -x /opt/homebrew/bin/cmake ]]; then
  CMAKE_BIN=/opt/homebrew/bin/cmake
else
  echo "cmake is required to build the Sigrok sidecar" >&2
  exit 1
fi

if [[ "$(uname -s)" == "Darwin" ]]; then
  export PATH="/opt/homebrew/bin:$PATH"
fi
# Positional parameters remain safe to expand when empty under macOS Bash 3.2
# with `set -u`; an empty array does not.
set --
python_fingerprint=""
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    python_executable="$(command -v python3)"
    python_root="$(cd "$(dirname "$python_executable")/.." && pwd)"
    python_fingerprint="$(cygpath -am "$python_executable")|$(cygpath -am "$python_root")"
    fingerprint_file="$BUILD_DIR/.sigpilot-python-toolchain"
    cached_fingerprint="$(cat "$fingerprint_file" 2>/dev/null || true)"
    if [[ -z "$cached_fingerprint" && -f "$BUILD_DIR/CMakeCache.txt" ]]; then
      cached_python="$(sed -n 's/^Python3_EXECUTABLE:[^=]*=//p' "$BUILD_DIR/CMakeCache.txt" | head -n 1)"
      cached_root="$(sed -n 's/^Python3_ROOT_DIR:[^=]*=//p' "$BUILD_DIR/CMakeCache.txt" | head -n 1)"
      if [[ -n "$cached_python" && -n "$cached_root" ]]; then
        cached_fingerprint="$cached_python|$cached_root"
      fi
    fi
    # Invalidate only when the persistent runner changed Python installations.
    if [[ -f "$BUILD_DIR/CMakeCache.txt" && "$cached_fingerprint" != "$python_fingerprint" ]]; then
      rm -f "$BUILD_DIR/CMakeCache.txt"
      rm -rf "$BUILD_DIR/CMakeFiles"
    fi
    set -- "$@" \
      "-DPython3_ROOT_DIR=$(cygpath -m "$python_root")" \
      "-DPython3_EXECUTABLE=$(cygpath -m "$python_executable")" \
      "-DPython3_FIND_REGISTRY=NEVER"
    ;;
esac
if [[ -d "$BUILD_DIR/decoders/c_decoders" ]]; then
  find "$BUILD_DIR/decoders/c_decoders" -maxdepth 1 -type f \
    -name 'lib*_c.*' -delete
fi
"$CMAKE_BIN" -S "$SIDECAR_DIR" -B "$BUILD_DIR" \
  -DCMAKE_BUILD_TYPE=Release \
  -DPXVIEW_ROOT="$PXVIEW_ROOT" \
  "$@"
if [[ -n "$python_fingerprint" ]]; then
  printf '%s\n' "$python_fingerprint" > "$BUILD_DIR/.sigpilot-python-toolchain"
fi
"$CMAKE_BIN" --build "$BUILD_DIR" --config Release --parallel

case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    python_dynload="$(python3 -c 'import sysconfig; print(sysconfig.get_config_var("DESTSHARED") or "")')"
    python_dynload="$(cygpath -u "$python_dynload")"
    python_bin="$(dirname "$(command -v python3)")"
    while IFS= read -r dependency; do
      [[ -f "$dependency" && "$dependency" == /*/bin/*.dll ]] || continue
      cp -f "$dependency" "$BUILD_DIR/$(basename "$dependency")"
    done < <(
      {
        ldd "$BUILD_DIR/sigpilot-sigrok-sidecar.exe" 2>/dev/null || true
        if [[ -d "$python_dynload" ]]; then
          while IFS= read -r -d '' extension; do
            ldd "$extension" 2>/dev/null || true
          done < <(find "$python_dynload" -type f \( -name '*.pyd' -o -name '*.dll' \) -print0)
        fi
      } | awk '$2 == "=>" { print $3 }' | sort -u
    )

    # MSYS2 ldd does not reliably report dependencies for Python .pyd files.
    # Walk their PE import tables and recursively collect matching UCRT DLLs.
    declare -a pe_queue=("$BUILD_DIR/sigpilot-sigrok-sidecar.exe")
    if [[ -d "$python_dynload" ]]; then
      while IFS= read -r -d '' extension; do
        pe_queue+=("$extension")
      done < <(find "$python_dynload" -type f \( -name '*.pyd' -o -name '*.dll' \) -print0)
    fi
    declare -A seen_pe_files=()
    queue_index=0
    while (( queue_index < ${#pe_queue[@]} )); do
      pe_file="${pe_queue[$queue_index]}"
      queue_index=$((queue_index + 1))
      pe_key="$(cygpath -aw "$pe_file" | tr '[:upper:]' '[:lower:]')"
      [[ -z "${seen_pe_files[$pe_key]:-}" ]] || continue
      seen_pe_files[$pe_key]=1
      while IFS= read -r dll_name; do
        [[ -n "$dll_name" ]] || continue
        dll_source="$(find "$python_bin" -maxdepth 1 -type f -iname "$dll_name" -print -quit)"
        [[ -n "$dll_source" ]] || continue
        dll_target="$BUILD_DIR/$(basename "$dll_source")"
        cp -f "$dll_source" "$dll_target"
        pe_queue+=("$dll_target")
      done < <(objdump -p "$pe_file" 2>/dev/null | awk '/DLL Name:/ { print $3 }')
    done
    ;;
esac

if [[ -f "$BUILD_DIR/sigpilot-sigrok-sidecar.exe" ]]; then
  echo "$BUILD_DIR/sigpilot-sigrok-sidecar.exe"
else
  echo "$BUILD_DIR/sigpilot-sigrok-sidecar"
fi
