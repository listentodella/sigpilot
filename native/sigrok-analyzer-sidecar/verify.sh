#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SIDECAR_DIR="$ROOT_DIR/native/sigrok-analyzer-sidecar"
BUILD_DIR="${PXLOGIC_SIGROK_BUILD_DIR:-$SIDECAR_DIR/target}"
FIXTURES="${1:-$ROOT_DIR/testdata/decoders/spi-conformance-v1.json}"
NATIVE_FIXTURES="${2:-$ROOT_DIR/testdata/decoders/sigrok-native-conformance-v1.json}"
CAN_FIXTURES="${3:-$ROOT_DIR/testdata/decoders/can-conformance-v1.json}"
LIN_FIXTURES="${4:-$ROOT_DIR/testdata/decoders/lin-conformance-v1.json}"
PARALLEL_FIXTURES="${5:-$ROOT_DIR/testdata/decoders/parallel-conformance-v1.json}"

"$SIDECAR_DIR/build.sh" >/dev/null

if [[ -f "$BUILD_DIR/pxlogic-sigrok-sidecar.exe" ]]; then
  SIDECAR="$BUILD_DIR/pxlogic-sigrok-sidecar.exe"
else
  SIDECAR="$BUILD_DIR/pxlogic-sigrok-sidecar"
fi
DECODER_ROOT="$BUILD_DIR/decoders/c_decoders"
if [[ -d "$ROOT_DIR/vendor/pxview-sigrokdecode/libsigrokdecode/decoders" ]]; then
  PYTHON_DECODER_ROOT="$ROOT_DIR/vendor/pxview-sigrokdecode/libsigrokdecode/decoders"
else
  PYTHON_DECODER_ROOT="$ROOT_DIR/pxview-fork/libsigrokdecode/decoders"
fi

run_sidecar() {
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*)
      python_home="$(python3 -c 'import sys; print(sys.base_prefix)')"
      python_home="$(cygpath -w "$python_home")"
      PYTHONHOME="$python_home" "$SIDECAR" "$@"
      ;;
    *)
      "$SIDECAR" "$@"
      ;;
  esac
}

run_probe() {
  local output status
  set +e
  output="$(run_sidecar "$@")"
  status=$?
  set -e
  if (( status != 0 )) || [[ -z "$output" ]]; then
    printf 'Sigrok sidecar probe failed with status %d and %d output bytes.\n' \
      "$status" "${#output}" >&2
    if command -v ldd >/dev/null 2>&1; then
      ldd "$SIDECAR" >&2 || true
    fi
    return 1
  fi
  printf '%s\n' "$output"
}

run_probe --decoder-root "$DECODER_ROOT" --probe | jq -e '
  .available == true
  and (.protocols | index("UART") != null)
  and (.protocols | index("I2C") != null)
  and (.protocols | index("SPI") != null)
  and (.protocols | index("I2S") != null)
  and (.protocols | index("CAN") != null)
  and (.protocols | index("CAN-FD") != null)
  and (.protocols | index("LIN") != null)
  and (.protocols | index("Parallel") != null)
' >/dev/null

run_probe \
  --decoder-root "$DECODER_ROOT" \
  --python-decoder-root "$PYTHON_DECODER_ROOT" \
  --probe \
  --catalog | jq -e '
    .available == true
    and .catalog_included == true
    and .c_decoder_count >= 200
    and .python_decoder_count >= 200
    and (.decoder_catalog | map(select(.id == "qspi_c" and .kind == "c")) | length == 1)
    and (.decoder_catalog | map(select(.id == "modbus_c" and .kind == "c")) | length == 1)
    and (.decoder_catalog | map(select(.id == "usb_power_delivery" and .kind == "python")) | length == 1)
    and (.decoder_catalog | map(select(.id == "jtag" and .kind == "python")) | length == 1)
    and (.decoder_catalog | map(select(.id == "spi_c" and .runner_status == "verified_sparse_c")) | length == 1)
    and (.decoder_catalog | map(select(.runner_status == "generic_sparse_c")) | length >= 90)
    and (.decoder_catalog | map(select(.runner_status == "generic_sparse_python")) | length >= 110)
    and (.decoder_catalog | map(select(.id == "guess_bitrate_c" and .runner_status == "generic_sparse_c")) | length == 1)
    and (.decoder_catalog | map(select(.id == "pwm" and .runner_status == "generic_sparse_python")) | length == 1)
    and (.decoder_catalog | map(select(.id == "modbus_c" and .runner_status == "catalog_only")) | length == 1)
    and (.decoder_catalog | map(select(.id == "modbus" and .runner_status == "catalog_only")) | length == 1)
  ' >/dev/null

failures=0
python_output="$(printf '%s' '{
  "format":"pxlogic.decoder.v1",
  "sample_rate_hz":1000000,
  "sample_count":100,
  "channel_count":1,
  "initial_levels":[0],
  "edges":[{"channel":0,"samples":[10,20,30,40,50,60]}],
  "decoder":{"protocol":"python:pwm","channels":{"data":0},"options":{"polarity":"active-high"}}
}' | run_sidecar --decoder-root "$DECODER_ROOT" --python-decoder-root "$PYTHON_DECODER_ROOT" --decode)"
if jq -e '
  .backend == "sigrok_native"
  and .protocol == "Pulse-width modulation"
  and ([.frames[] | select(.row == "Duty cycle") | .texts[0]] == ["50.000000%", "50.000000%"])
  and ([.frames[] | select(.row == "Period") | .texts[0]] == ["20.0 μs", "20.0 μs"])
' >/dev/null <<<"$python_output"; then
  printf 'PASS generic-sparse-python-pwm\n'
else
  printf 'FAIL generic sparse Python PWM decoder did not produce the expected annotations\n' >&2
  failures=$((failures + 1))
fi

generic_output="$(printf '%s' '{
  "format":"pxlogic.decoder.v1",
  "sample_rate_hz":1000000,
  "sample_count":100,
  "channel_count":1,
  "initial_levels":[0],
  "edges":[{"channel":0,"samples":[10,20,30,40]}],
  "decoder":{"protocol":"guess_bitrate_c","channels":{"data":0},"options":{}}
}' | run_sidecar --decoder-root "$DECODER_ROOT" --decode)"
if jq -e '
  .backend == "sigrok_native"
  and .protocol == "Guess bitrate/baudrate (C)"
  and ([.frames[] | select(.row == "Bitrate") | .texts[0]] == ["100000"])
' >/dev/null <<<"$generic_output"; then
  printf 'PASS generic-sparse-c-guess-bitrate\n'
else
  printf 'FAIL generic sparse C decoder did not produce the expected annotation\n' >&2
  failures=$((failures + 1))
fi

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
  output="$(printf '%s' "$request" | run_sidecar --decoder-root "$DECODER_ROOT" --decode)"

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
  output="$(printf '%s' "$request" | run_sidecar --decoder-root "$DECODER_ROOT" --decode)"
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
  large_output="$(printf '%s' "$large_request" | run_sidecar --decoder-root "$DECODER_ROOT" --decode)"
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
    output="$(printf '%s' "$request" | run_sidecar --decoder-root "$DECODER_ROOT" --decode)"
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
    large_output="$(printf '%s' "$large_request" | run_sidecar --decoder-root "$DECODER_ROOT" --decode)"
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
  output="$(printf '%s' "$request" | run_sidecar --decoder-root "$DECODER_ROOT" --decode)"
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
  large_output="$(printf '%s' "$large_request" | run_sidecar --decoder-root "$DECODER_ROOT" --decode)"
  large_start="$(jq -r '[.frames[].start_sample] | min' <<<"$large_output")"
  if (( large_start <= 4294967295 )); then
    printf 'FAIL %s-lin-large-index expected a sample beyond uint32, got %s\n' \
      "$fixture_id" "$large_start" >&2
    failures=$((failures + 1))
  else
    printf 'PASS %s-lin-large-index (%s)\n' "$fixture_id" "$large_start"
  fi
done < <(jq -c '.cases[]' "$LIN_FIXTURES")

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
  output="$(printf '%s' "$request" | run_sidecar --decoder-root "$DECODER_ROOT" --decode)"
  expected_rows="$(jq -c '.expected_rows' <<<"$fixture")"
  expected_values="$(jq -c '.expected_values' <<<"$fixture")"
  expected_role="$(jq -r '.expected_role' <<<"$fixture")"
  actual_rows="$(jq -c '[.frames[].row]' <<<"$output")"
  actual_values="$(jq -c --arg role "$expected_role" '[.frames[].channel_values[] | select(.role == $role) | .value]' <<<"$output")"
  if [[ "$actual_rows" == "$expected_rows" && "$actual_values" == "$expected_values" ]]; then
    printf 'PASS %s-parallel\n' "$fixture_id"
  else
    printf 'FAIL %s-parallel expected rows=%s values=%s, got rows=%s values=%s\n' \
      "$fixture_id" "$expected_rows" "$expected_values" "$actual_rows" "$actual_values" >&2
    failures=$((failures + 1))
  fi

  large_request="$(jq -c '
    .sample_count = 50000000000
    | .edges |= map(.samples |= map(. + 49000000000))
  ' <<<"$request")"
  large_output="$(printf '%s' "$large_request" | run_sidecar --decoder-root "$DECODER_ROOT" --decode)"
  large_start="$(jq -r '[.frames[].start_sample] | min' <<<"$large_output")"
  if (( large_start <= 4294967295 )); then
    printf 'FAIL %s-parallel-large-index expected a sample beyond uint32, got %s\n' \
      "$fixture_id" "$large_start" >&2
    failures=$((failures + 1))
  else
    printf 'PASS %s-parallel-large-index (%s)\n' "$fixture_id" "$large_start"
  fi
done < <(jq -c '.cases[]' "$PARALLEL_FIXTURES")

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
large_output="$(printf '%s' "$large_fixture" | run_sidecar --decoder-root "$DECODER_ROOT" --decode)"
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
