#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ZIP_PATH="${1:-${SIGPILOT_SALEAE_LOGIC_ZIP:-}}"
if [[ -z "$ZIP_PATH" && -n "${HOME:-}" && -f "$HOME/Downloads/Logic-2.4.43-macos-arm64.zip" ]]; then
  ZIP_PATH="$HOME/Downloads/Logic-2.4.43-macos-arm64.zip"
fi
if [[ -z "$ZIP_PATH" ]]; then
  printf 'Usage: %s /path/to/Logic-2.4.43-macos-arm64.zip\n' "$0" >&2
  printf 'Or set SIGPILOT_SALEAE_LOGIC_ZIP to the local Logic 2.4.43 zip.\n' >&2
  exit 1
fi
EXTRACT_DIR="$ROOT_DIR/target/native/saleae-runtime-extracted"
RUNTIME_DIR="$ROOT_DIR/target/native/saleae-runtime-2.4.43"
SIDECAR="$($ROOT_DIR/native/saleae-analyzer-sidecar/build.sh)"

mkdir -p "$EXTRACT_DIR" "$RUNTIME_DIR/Analyzers"
unzip -q -o "$ZIP_PATH" \
  'Saleae Logic.app/Contents/Resources/macos-arm64/libAnalyzer.dylib' \
  'Saleae Logic.app/Contents/Resources/macos-arm64/Analyzers/libserial_analyzer.so' \
  'Saleae Logic.app/Contents/Resources/macos-arm64/Analyzers/libi2c_analyzer.so' \
  'Saleae Logic.app/Contents/Resources/macos-arm64/Analyzers/libspi_analyzer.so' \
  'Saleae Logic.app/Contents/Resources/macos-arm64/Analyzers/libi2s_analyzer.so' \
  'Saleae Logic.app/Contents/Resources/macos-arm64/Analyzers/libcan_analyzer.so' \
  'Saleae Logic.app/Contents/Resources/macos-arm64/Analyzers/liblin_analyzer.so' \
  'Saleae Logic.app/Contents/Resources/macos-arm64/Analyzers/libsimple_parallel_analyzer.so' \
  -d "$EXTRACT_DIR"

EXTRACTED_ROOT="$EXTRACT_DIR/Saleae Logic.app/Contents/Resources/macos-arm64"
ditto --norsrc "$EXTRACTED_ROOT/libAnalyzer.dylib" "$RUNTIME_DIR/libAnalyzer.dylib"
ditto --norsrc "$EXTRACTED_ROOT/Analyzers/libserial_analyzer.so" "$RUNTIME_DIR/Analyzers/libserial_analyzer.so"
ditto --norsrc "$EXTRACTED_ROOT/Analyzers/libi2c_analyzer.so" "$RUNTIME_DIR/Analyzers/libi2c_analyzer.so"
ditto --norsrc "$EXTRACTED_ROOT/Analyzers/libspi_analyzer.so" "$RUNTIME_DIR/Analyzers/libspi_analyzer.so"
ditto --norsrc "$EXTRACTED_ROOT/Analyzers/libi2s_analyzer.so" "$RUNTIME_DIR/Analyzers/libi2s_analyzer.so"
ditto --norsrc "$EXTRACTED_ROOT/Analyzers/libcan_analyzer.so" "$RUNTIME_DIR/Analyzers/libcan_analyzer.so"
ditto --norsrc "$EXTRACTED_ROOT/Analyzers/liblin_analyzer.so" "$RUNTIME_DIR/Analyzers/liblin_analyzer.so"
ditto --norsrc "$EXTRACTED_ROOT/Analyzers/libsimple_parallel_analyzer.so" "$RUNTIME_DIR/Analyzers/libsimple_parallel_analyzer.so"
xattr -d com.apple.quarantine "$RUNTIME_DIR/libAnalyzer.dylib" 2>/dev/null || true
xattr -d com.apple.quarantine "$RUNTIME_DIR/Analyzers/libserial_analyzer.so" 2>/dev/null || true
xattr -d com.apple.quarantine "$RUNTIME_DIR/Analyzers/libi2c_analyzer.so" 2>/dev/null || true
xattr -d com.apple.quarantine "$RUNTIME_DIR/Analyzers/libspi_analyzer.so" 2>/dev/null || true
xattr -d com.apple.quarantine "$RUNTIME_DIR/Analyzers/libi2s_analyzer.so" 2>/dev/null || true
xattr -d com.apple.quarantine "$RUNTIME_DIR/Analyzers/libcan_analyzer.so" 2>/dev/null || true
xattr -d com.apple.quarantine "$RUNTIME_DIR/Analyzers/liblin_analyzer.so" 2>/dev/null || true
xattr -d com.apple.quarantine "$RUNTIME_DIR/Analyzers/libsimple_parallel_analyzer.so" 2>/dev/null || true

"$SIDECAR" --runtime-root "$RUNTIME_DIR" --probe
"$SIDECAR" \
  --runtime-root "$RUNTIME_DIR" \
  --run-fixtures "$ROOT_DIR/testdata/decoders/spi-conformance-v1.json" \
  | jq '{all_matched, cases: [.cases[] | {id, matched, actual_mosi, actual_miso}]}'

jq '.cases[0]' "$ROOT_DIR/testdata/decoders/can-conformance-v1.json" \
  | "$SIDECAR" --runtime-root "$RUNTIME_DIR" --decode \
  | jq -e '
      .protocol == "CAN"
      and ([.frames[].channel_values[] | select(.role == "Identifier") | .value] == [291])
      and ([.frames[].channel_values[] | select(.role == "DLC") | .value] == [2])
      and ([.frames[].channel_values[] | select(.role == "Data") | .value] == [165, 90])
      and ([.frames[].channel_values[] | select(.role == "CRC") | .value] == [18780])
      and ([.frames[].channel_values[] | select(.role == "ACK") | .value] == [1])
    '

jq '.cases[0]' "$ROOT_DIR/testdata/decoders/lin-conformance-v1.json" \
  | "$SIDECAR" --runtime-root "$RUNTIME_DIR" --decode \
  | jq -e '
      .protocol == "LIN"
      and ([.frames[].channel_values[] | select(.role == "LIN") | .value] == [0, 85, 18, 165, 90, 109])
    '

jq '.cases[0]' "$ROOT_DIR/testdata/decoders/parallel-conformance-v1.json" \
  | "$SIDECAR" --runtime-root "$RUNTIME_DIR" --decode \
  | jq -e '
      .protocol == "Simple Parallel"
      and ([.frames[].channel_values[] | select(.role == "Data") | .value] == [0, 3, 0, 3])
    '

SIGPILOT_SALEAE_SIDECAR="$SIDECAR" \
SIGPILOT_SALEAE_RUNTIME_ROOT="$RUNTIME_DIR" \
  cargo test -p sigpilot-core decoder_backend::tests::saleae_ -- --include-ignored
