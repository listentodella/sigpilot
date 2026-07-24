#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ZIP_PATH="${1:-/Volumes/tp7100s/Downloads/Logic-2.4.43-macos-arm64.zip}"
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
  -d "$EXTRACT_DIR"

EXTRACTED_ROOT="$EXTRACT_DIR/Saleae Logic.app/Contents/Resources/macos-arm64"
ditto --norsrc "$EXTRACTED_ROOT/libAnalyzer.dylib" "$RUNTIME_DIR/libAnalyzer.dylib"
ditto --norsrc "$EXTRACTED_ROOT/Analyzers/libserial_analyzer.so" "$RUNTIME_DIR/Analyzers/libserial_analyzer.so"
ditto --norsrc "$EXTRACTED_ROOT/Analyzers/libi2c_analyzer.so" "$RUNTIME_DIR/Analyzers/libi2c_analyzer.so"
ditto --norsrc "$EXTRACTED_ROOT/Analyzers/libspi_analyzer.so" "$RUNTIME_DIR/Analyzers/libspi_analyzer.so"
ditto --norsrc "$EXTRACTED_ROOT/Analyzers/libi2s_analyzer.so" "$RUNTIME_DIR/Analyzers/libi2s_analyzer.so"
ditto --norsrc "$EXTRACTED_ROOT/Analyzers/libcan_analyzer.so" "$RUNTIME_DIR/Analyzers/libcan_analyzer.so"
xattr -d com.apple.quarantine "$RUNTIME_DIR/libAnalyzer.dylib" 2>/dev/null || true
xattr -d com.apple.quarantine "$RUNTIME_DIR/Analyzers/libserial_analyzer.so" 2>/dev/null || true
xattr -d com.apple.quarantine "$RUNTIME_DIR/Analyzers/libi2c_analyzer.so" 2>/dev/null || true
xattr -d com.apple.quarantine "$RUNTIME_DIR/Analyzers/libspi_analyzer.so" 2>/dev/null || true
xattr -d com.apple.quarantine "$RUNTIME_DIR/Analyzers/libi2s_analyzer.so" 2>/dev/null || true
xattr -d com.apple.quarantine "$RUNTIME_DIR/Analyzers/libcan_analyzer.so" 2>/dev/null || true

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

PXLOGIC_SALEAE_SIDECAR="$SIDECAR" \
PXLOGIC_SALEAE_RUNTIME_ROOT="$RUNTIME_DIR" \
  cargo test -p pxlogic-core decoder_backend::tests::saleae_ -- --include-ignored
