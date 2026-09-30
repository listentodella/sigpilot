#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SOURCE_DIR="$ROOT_DIR/native/saleae-analyzer-sidecar"
RUNTIME_SOURCE_DIR="$ROOT_DIR/vendor/saleae-standalone/runtime"
HOST_OS="$(uname -s)"
HOST_ARCH="$(uname -m)"
# nlohmann/json 3.11.3, vendored at the commit this build used to check out:
# 9cca280a4d0ccf0c08f47a99aa71d1b0e52f8d03. See vendor/nlohmann-json/README.md.
#
# This used to clone upstream into target/native-cache/json. That made a
# disposable directory the home of a network-fetched dependency: `cargo clean`
# wiped it, so the next build re-fetched 304 MB (287 MB of it git history) to
# obtain this one 900 KB header, and the build could not run offline.
JSON_INCLUDE_DIR="${SIGPILOT_NLOHMANN_JSON_INCLUDE:-$ROOT_DIR/vendor/nlohmann-json/single_include}"
if [[ ! -f "$JSON_INCLUDE_DIR/nlohmann/json.hpp" ]]; then
  printf 'nlohmann/json was not found at %s.\n' "$JSON_INCLUDE_DIR" >&2
  printf 'It is vendored at vendor/nlohmann-json/single_include; restore it, or point\n' >&2
  printf 'SIGPILOT_NLOHMANN_JSON_INCLUDE at another single_include directory.\n' >&2
  exit 1
fi

case "$HOST_OS" in
  Darwin)
    TARGET_ARCH="${SIGPILOT_MACOS_ARCH:-$HOST_ARCH}"
    case "$TARGET_ARCH" in
      arm64|x86_64) ;;
      *) printf 'Unsupported macOS architecture: %s\n' "$TARGET_ARCH" >&2; exit 1 ;;
    esac
    PLATFORM_ID="macos-$TARGET_ARCH"
    EXECUTABLE_NAME="sigpilot-saleae-analyzer-sidecar"
    ;;
  Linux)
    TARGET_ARCH="$HOST_ARCH"
    PLATFORM_ID="linux-$TARGET_ARCH"
    EXECUTABLE_NAME="sigpilot-saleae-analyzer-sidecar"
    ;;
  MINGW*|MSYS*|CYGWIN*)
    TARGET_ARCH="$HOST_ARCH"
    PLATFORM_ID="windows-$TARGET_ARCH"
    EXECUTABLE_NAME="sigpilot-saleae-analyzer-sidecar.exe"
    ;;
  *)
    printf 'Unsupported Saleae sidecar host: %s\n' "$HOST_OS" >&2
    exit 1
    ;;
esac

BUILD_DIR="${SIGPILOT_SALEAE_BUILD_DIR:-$ROOT_DIR/target/native/saleae-analyzer-sidecar-$PLATFORM_ID}"
RUNTIME_BUILD_DIR="${SIGPILOT_SALEAE_RUNTIME_BUILD_DIR:-$ROOT_DIR/target/native/saleae-standalone-runtime-$PLATFORM_ID}"

mkdir -p "$BUILD_DIR" "$RUNTIME_BUILD_DIR"

set -- -DCMAKE_BUILD_TYPE=Release
case "$HOST_OS" in
  Darwin)
    set -- "$@" -DCMAKE_OSX_ARCHITECTURES="$TARGET_ARCH"
    ;;
  MINGW*|MSYS*|CYGWIN*)
    set -- "$@" '-DCMAKE_CXX_FLAGS=-static-libgcc -static-libstdc++'
    ;;
esac
cmake -S "$RUNTIME_SOURCE_DIR" -B "$RUNTIME_BUILD_DIR" -G Ninja "$@" >&2
cmake --build "$RUNTIME_BUILD_DIR" >&2 || exit $?

if [[ -n "${CXX:-}" ]]; then
  CXX_COMMAND=("$CXX")
elif [[ "$HOST_OS" == "Darwin" ]]; then
  CXX_COMMAND=(xcrun clang++)
else
  CXX_COMMAND=(c++)
fi
SIGPILOT_SALEAE_SIDECAR_OPT_LEVEL="${SIGPILOT_SALEAE_SIDECAR_OPT_LEVEL:--O3}"
COMMON_FLAGS=(
  -std=c++17
  "$SIGPILOT_SALEAE_SIDECAR_OPT_LEVEL"
  -DNDEBUG
  -I"$RUNTIME_SOURCE_DIR/include"
  -I"$JSON_INCLUDE_DIR"
)
LINKER_FLAGS=(-L"$RUNTIME_BUILD_DIR/lib" -lsaleae_compat)
case "$HOST_OS" in
  Darwin)
    COMMON_FLAGS+=(-arch "$TARGET_ARCH")
    LINKER_FLAGS+=(-Wl,-rpath,@loader_path/runtime)
    ;;
  Linux)
    LINKER_FLAGS+=('-Wl,-rpath,$ORIGIN/runtime' -ldl)
    ;;
  MINGW*|MSYS*|CYGWIN*)
    COMMON_FLAGS+=(-static-libgcc -static-libstdc++)
    ;;
esac

"${CXX_COMMAND[@]}" "${COMMON_FLAGS[@]}" \
  "$SOURCE_DIR/src/standalone_main.cpp" \
  "${LINKER_FLAGS[@]}" \
  -o "$BUILD_DIR/$EXECUTABLE_NAME"

rm -rf "$BUILD_DIR/runtime"
mkdir -p "$BUILD_DIR/runtime"
case "$HOST_OS" in
  Darwin)
    cp "$RUNTIME_BUILD_DIR/lib/"libsaleae_compat.dylib "$BUILD_DIR/runtime/"
    cp "$RUNTIME_BUILD_DIR/lib/"lib*_analyzer.so "$BUILD_DIR/runtime/"
    ;;
  Linux)
    cp "$RUNTIME_BUILD_DIR/lib/"libsaleae_compat.so "$BUILD_DIR/runtime/"
    cp "$RUNTIME_BUILD_DIR/lib/"lib*_analyzer.so "$BUILD_DIR/runtime/"
    ;;
  MINGW*|MSYS*|CYGWIN*)
    compat_dll="$(find "$RUNTIME_BUILD_DIR/lib" -maxdepth 1 -type f \
      \( -iname 'saleae_compat.dll' -o -iname 'libsaleae_compat.dll' \) -print -quit)"
    [[ -n "$compat_dll" ]] || { printf 'Saleae compatibility DLL was not built.\n' >&2; exit 1; }
    cp "$compat_dll" "$BUILD_DIR/"
    cp "$compat_dll" "$BUILD_DIR/runtime/"
    while IFS= read -r plugin; do
      cp "$plugin" "$BUILD_DIR/runtime/"
    done < <(find "$RUNTIME_BUILD_DIR/lib" -maxdepth 1 -type f -iname '*_analyzer.dll' -print)

    declare -a dependency_queue=("$BUILD_DIR/$EXECUTABLE_NAME" "$BUILD_DIR/runtime/$(basename "$compat_dll")")
    while IFS= read -r plugin; do dependency_queue+=("$plugin"); done \
      < <(find "$BUILD_DIR/runtime" -maxdepth 1 -type f -iname '*_analyzer.dll' -print)
    declare -A seen_dependencies=()
    queue_index=0
    while (( queue_index < ${#dependency_queue[@]} )); do
      binary="${dependency_queue[$queue_index]}"
      queue_index=$((queue_index + 1))
      while IFS= read -r dependency; do
        [[ -f "$dependency" && "$dependency" == /*/bin/*.dll ]] || continue
        key="$(cygpath -aw "$dependency" | tr '[:upper:]' '[:lower:]')"
        [[ -z "${seen_dependencies[$key]:-}" ]] || continue
        seen_dependencies[$key]=1
        name="$(basename "$dependency")"
        [[ "$dependency" -ef "$BUILD_DIR/$name" ]] \
          || cp -f "$dependency" "$BUILD_DIR/$name"
        [[ "$dependency" -ef "$BUILD_DIR/runtime/$name" ]] \
          || cp -f "$dependency" "$BUILD_DIR/runtime/$name"
        dependency_queue+=("$dependency")
      done < <(ldd "$binary" 2>/dev/null | awk '$2 == "=>" && $3 ~ /^\// { print $3 }')
    done
    ;;
esac

CANONICAL_BUILD_DIR="$ROOT_DIR/target/native/saleae-analyzer-sidecar"
if [[ "$BUILD_DIR" != "$CANONICAL_BUILD_DIR" ]]; then
  rm -rf "$CANONICAL_BUILD_DIR"
  mkdir -p "$CANONICAL_BUILD_DIR"
  cp "$BUILD_DIR/$EXECUTABLE_NAME" "$CANONICAL_BUILD_DIR/"
  if [[ -d "$BUILD_DIR/runtime" ]]; then
    cp -R "$BUILD_DIR/runtime" "$CANONICAL_BUILD_DIR/"
  fi
  case "$HOST_OS" in
    MINGW*|MSYS*|CYGWIN*)
      while IFS= read -r dependency; do
        cp "$dependency" "$CANONICAL_BUILD_DIR/"
      done < <(find "$BUILD_DIR" -maxdepth 1 -type f -iname '*.dll' -print)
      ;;
  esac
fi

printf '%s\n' "$BUILD_DIR/$EXECUTABLE_NAME"
