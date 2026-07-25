#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SIDECAR_DIR="$ROOT_DIR/native/sigrok-analyzer-sidecar"
BUILD_DIR="${PXLOGIC_SIGROK_BUILD_DIR:-$SIDECAR_DIR/target}"
FIXTURES="${1:-$ROOT_DIR/testdata/decoders/spi-conformance-v1.json}"
NATIVE_FIXTURES="${2:-$ROOT_DIR/testdata/decoders/sigrok-native-conformance-v1.json}"
CAN_FIXTURES="${3:-$ROOT_DIR/testdata/decoders/can-conformance-v1.json}"
LIN_FIXTURES="${4:-$ROOT_DIR/testdata/decoders/lin-conformance-v1.json}"

"$SIDECAR_DIR/build.sh" >/dev/null

SIDECAR="$BUILD_DIR/pxlogic-sigrok-sidecar"
DECODER_ROOT="$BUILD_DIR/decoders/c_decoders"

"$SIDECAR" --decoder-root "$DECODER_ROOT" --probe | jq -e '
  .available == true
  and (.protocols | index("UART") != null)
  and (.protocols | index("I2C") != null)
  and (.protocols | index("SPI") != null)
  and (.protocols | index("I2S") != null)
  and (.protocols | index("CAN") != null)
  and (.protocols | index("CAN-FD") != null)
  and (.protocols | index("LIN") != null)
' >/dev/null

failures=0
while IFS= read -r fixture; do
  fixture_id="$(jq -r '.id' <<<"$fixture")"
  request="$(jq -c '{
    format: "pxlogic.decoder.spi.v1",
    sample_rate_hz,
    sample_count,
    channel_count,
    initial_levels,
    edges,
    decoder
  }' <<<"$fixture")"
  output="$(printf '%s' "$request" | "$SIDECAR" --decoder-root "$DECODER_ROOT" --decode)"

  expected_mosi="$(jq -c '[.expected_words[].mosi]' <<<"$fixture")"
  expected_miso="$(jq -c '[.expected_words[].miso]' <<<"$fixture")"
  actual_mosi="$(jq -c '[.frames[].channel_values[] | select(.role == "MOSI") | .value]' <<<"$output")"
  actual_miso="$(jq -c '[.frames[].channel_values[] | select(.role == "MISO") | .value]' <<<"$output")"

  if [[ "$actual_mosi" == "$expected_mosi" && "$actual_miso" == "$expected_miso" ]]; then
    printf 'PASS %s\n' "$fixture_id"
  else
    printf 'FAIL %s expected MOSI=%s MISO=%s, got MOSI=%s MISO=%s\n' \
      "$fixture_id" "$expected_mosi" "$expected_miso" "$actual_mosi" "$actual_miso" >&2
    failures=$((failures + 1))
  fi
done < <(jq -c '.cases[]' "$FIXTURES")

while IFS= read -r fixture; do
  fixture_id="$(jq -r '.id' <<<"$fixture")"
  request="$(jq -c '{
    format: "pxlogic.decoder.v1",
    sample_rate_hz,
    sample_count,
    channel_count,
    initial_levels,
    edges,
    decoder
  }' <<<"$fixture")"
  output="$(printf '%s' "$request" | "$SIDECAR" --decoder-root "$DECODER_ROOT" --decode)"
  expected_rows="$(jq -c '.expected_rows' <<<"$fixture")"
  expected_values="$(jq -c '.expected_values' <<<"$fixture")"
  actual_rows="$(jq -c '[.frames[].row]' <<<"$output")"
  actual_values="$(jq -c '[.frames[].channel_values[0].value]' <<<"$output")"
  if [[ "$actual_rows" == "$expected_rows" && "$actual_values" == "$expected_values" ]]; then
    printf 'PASS %s\n' "$fixture_id"
  else
    printf 'FAIL %s expected rows=%s values=%s, got rows=%s values=%s\n' \
      "$fixture_id" "$expected_rows" "$expected_values" "$actual_rows" "$actual_values" >&2
    failures=$((failures + 1))
  fi

  large_request="$(jq -c '
    .sample_count = 50000000000
    | .edges |= map(.samples |= map(. + 49000000000))
    | {
        format: "pxlogic.decoder.v1",
        sample_rate_hz,
        sample_count,
        channel_count,
        initial_levels,
        edges,
        decoder
      }
  ' <<<"$fixture")"
  large_output="$(printf '%s' "$large_request" | "$SIDECAR" --decoder-root "$DECODER_ROOT" --decode)"
  large_start="$(jq -r '[.frames[].start_sample] | min' <<<"$large_output")"
  if (( large_start <= 4294967295 )); then
    printf 'FAIL %s-large-index expected a sample beyond uint32, got %s\n' "$fixture_id" "$large_start" >&2
    failures=$((failures + 1))
  else
    printf 'PASS %s-large-index (%s)\n' "$fixture_id" "$large_start"
  fi
done < <(jq -c '.cases[]' "$NATIVE_FIXTURES")

while IFS= read -r fixture; do
  fixture_id="$(jq -r '.id' <<<"$fixture")"
  for protocol in can can_fd; do
    request="$(jq -c --arg protocol "$protocol" '
      .decoder.protocol = $protocol
      | if $protocol == "can_fd" then
          .decoder.options = {
            nominal_bitrate: .decoder.options.bitrate,
            fast_bitrate: (.decoder.options.bitrate * 2),
            sample_point: .decoder.options.sample_point
          }
        else . end
    ' <<<"$fixture")"
    output="$(printf '%s' "$request" | "$SIDECAR" --decoder-root "$DECODER_ROOT" --decode)"
    if jq -e --argjson expected "$(jq -c '.expected_roles' <<<"$fixture")" '
      ([.frames[].channel_values[] | select(.role == "Identifier") | .value] == $expected.Identifier)
      and ([.frames[].channel_values[] | select(.role == "DLC") | .value] == $expected.DLC)
      and ([.frames[].channel_values[] | select(.role == "Data") | .value] == $expected.Data)
      and ([.frames[].channel_values[] | select(.role == "CRC") | .value] == $expected.CRC)
      and ([.frames[].channel_values[] | select(.role == "ACK") | .value] == $expected.ACK)
    ' >/dev/null <<<"$output"; then
      printf 'PASS %s-%s\n' "$fixture_id" "$protocol"
    else
      printf 'FAIL %s-%s native CAN fields did not match\n' "$fixture_id" "$protocol" >&2
      failures=$((failures + 1))
    fi

    large_request="$(jq -c '
      .sample_count = 50000000000
      | .edges |= map(.samples |= map(. + 49000000000))
    ' <<<"$request")"
    large_output="$(printf '%s' "$large_request" | "$SIDECAR" --decoder-root "$DECODER_ROOT" --decode)"
    large_start="$(jq -r '[.frames[].start_sample] | min' <<<"$large_output")"
    if (( large_start <= 4294967295 )); then
      printf 'FAIL %s-%s-large-index expected a sample beyond uint32, got %s\n' \
        "$fixture_id" "$protocol" "$large_start" >&2
      failures=$((failures + 1))
    else
      printf 'PASS %s-%s-large-index (%s)\n' "$fixture_id" "$protocol" "$large_start"
    fi
  done
done < <(jq -c '.cases[]' "$CAN_FIXTURES")

while IFS= read -r fixture; do
  fixture_id="$(jq -r '.id' <<<"$fixture")"
  request="$(jq -c '{
    format: "pxlogic.decoder.v1",
    sample_rate_hz,
    sample_count,
    channel_count,
    initial_levels,
    edges,
    decoder
  }' <<<"$fixture")"
  output="$(printf '%s' "$request" | "$SIDECAR" --decoder-root "$DECODER_ROOT" --decode)"
  if jq -e --argjson expected "$(jq -c '.expected_roles' <<<"$fixture")" '
    .protocol == "LIN"
    and ([.frames[].channel_values[] | select(.role == "LIN") | .value] == $expected.LIN)
  ' >/dev/null <<<"$output"; then
    printf 'PASS %s-lin\n' "$fixture_id"
  else
    printf 'FAIL %s-lin native LIN fields did not match\n' "$fixture_id" >&2
    failures=$((failures + 1))
  fi

  large_request="$(jq -c '
    .sample_count = 50000000000
    | .edges |= map(.samples |= map(. + 49000000000))
  ' <<<"$request")"
  large_output="$(printf '%s' "$large_request" | "$SIDECAR" --decoder-root "$DECODER_ROOT" --decode)"
  large_start="$(jq -r '[.frames[].start_sample] | min' <<<"$large_output")"
  if (( large_start <= 4294967295 )); then
    printf 'FAIL %s-lin-large-index expected a sample beyond uint32, got %s\n' \
      "$fixture_id" "$large_start" >&2
    failures=$((failures + 1))
  else
    printf 'PASS %s-lin-large-index (%s)\n' "$fixture_id" "$large_start"
  fi
done < <(jq -c '.cases[]' "$LIN_FIXTURES")

# The sparse contract must remain sparse. This case moves a normal SPI
# transaction near sample 49 billion; a packed implementation would either
# allocate tens of gigabytes or spend time walking every sample.
large_fixture="$(jq -c '
  .cases[0]
  | .sample_count = 50000000000
  | .edges |= map(.samples |= map(. + 49000000000))
  | {
      format: "pxlogic.decoder.spi.v1",
      sample_rate_hz,
      sample_count,
      channel_count,
      initial_levels,
      edges,
      decoder
    }
' "$FIXTURES")"
large_output="$(printf '%s' "$large_fixture" | "$SIDECAR" --decoder-root "$DECODER_ROOT" --decode)"
large_start="$(jq -r '[.frames[].start_sample] | min' <<<"$large_output")"
if (( large_start <= 4294967295 )); then
  printf 'FAIL sparse-large-index expected a sample beyond uint32, got %s\n' "$large_start" >&2
  failures=$((failures + 1))
else
  printf 'PASS sparse-large-index (%s)\n' "$large_start"
fi

if (( failures > 0 )); then
  exit 1
fi
