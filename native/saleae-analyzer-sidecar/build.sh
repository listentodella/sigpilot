#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SOURCE_DIR="$ROOT_DIR/native/saleae-analyzer-sidecar"
RUNTIME_SOURCE_DIR="$ROOT_DIR/vendor/saleae-standalone/runtime"
HOST_OS="$(uname -s)"
HOST_ARCH="$(uname -m)"
CACHE_DIR="${PXLOGIC_NATIVE_CACHE_DIR:-$ROOT_DIR/target/native-cache}"
JSON_DIR="$CACHE_DIR/json"
JSON_COMMIT="9cca280a4d0ccf0c08f47a99aa71d1b0e52f8d03"

case "$HOST_OS" in
  Darwin)
    TARGET_ARCH="${PXLOGIC_MACOS_ARCH:-$HOST_ARCH}"
    case "$TARGET_ARCH" in
      arm64|x86_64) ;;
      *) printf 'Unsupported macOS architecture: %s\n' "$TARGET_ARCH" >&2; exit 1 ;;
    esac
    PLATFORM_ID="macos-$TARGET_ARCH"
    EXECUTABLE_NAME="pxlogic-saleae-analyzer-sidecar"
    ;;
  Linux)
    TARGET_ARCH="$HOST_ARCH"
    PLATFORM_ID="linux-$TARGET_ARCH"
    EXECUTABLE_NAME="pxlogic-saleae-analyzer-sidecar"
    ;;
  MINGW*|MSYS*|CYGWIN*)
    TARGET_ARCH="$HOST_ARCH"
    PLATFORM_ID="windows-$TARGET_ARCH"
    EXECUTABLE_NAME="pxlogic-saleae-analyzer-sidecar.exe"
    ;;
  *)
    printf 'Unsupported Saleae sidecar host: %s\n' "$HOST_OS" >&2
    exit 1
    ;;
esac

BUILD_DIR="${PXLOGIC_SALEAE_BUILD_DIR:-$ROOT_DIR/target/native/saleae-analyzer-sidecar-$PLATFORM_ID}"
RUNTIME_BUILD_DIR="${PXLOGIC_SALEAE_RUNTIME_BUILD_DIR:-$ROOT_DIR/target/native/saleae-standalone-runtime-$PLATFORM_ID}"

mkdir -p "$CACHE_DIR" "$BUILD_DIR" "$RUNTIME_BUILD_DIR"

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

if [[ ! -d "$JSON_DIR/.git" ]]; then
  git clone https://github.com/nlohmann/json.git "$JSON_DIR"
fi
if ! git -C "$JSON_DIR" cat-file -e "$JSON_COMMIT^{commit}" 2>/dev/null; then
  git -C "$JSON_DIR" fetch --quiet origin "$JSON_COMMIT"
fi
git -C "$JSON_DIR" checkout --quiet --detach "$JSON_COMMIT"

if [[ -n "${CXX:-}" ]]; then
  CXX_COMMAND=("$CXX")
elif [[ "$HOST_OS" == "Darwin" ]]; then
  CXX_COMMAND=(xcrun clang++)
else
  CXX_COMMAND=(c++)
fi
COMMON_FLAGS=(
  -std=c++17
  -O2
  -I"$RUNTIME_SOURCE_DIR/include"
  -I"$JSON_DIR/single_include"
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

printf '%s\n' "$BUILD_DIR/$EXECUTABLE_NAME"
