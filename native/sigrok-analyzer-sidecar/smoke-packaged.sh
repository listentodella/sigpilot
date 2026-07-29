#!/usr/bin/env bash
set -euo pipefail

if (( $# != 3 )); then
  printf 'usage: %s SIDECAR C_DECODER_ROOT PYTHON_DECODER_ROOT\n' "$0" >&2
  exit 2
fi

sidecar="$1"
c_decoder_root="$2"
python_decoder_root="$3"

"$sidecar" \
  --decoder-root "$c_decoder_root" \
  --python-decoder-root "$python_decoder_root" \
  --probe --catalog | jq -e '
    .available
    and .c_decoder_count >= 200
    and .python_decoder_count >= 200
    and ([.decoder_catalog[] | select(.runner_status == "generic_sparse_c")] | length >= 90)
  ' >/dev/null

printf '%s' '{
  "format":"pxlogic.decoder.v1",
  "sample_rate_hz":1000000,
  "sample_count":100,
  "channel_count":1,
  "initial_levels":[0],
  "edges":[{"channel":0,"samples":[10,20,30,40]}],
  "decoder":{"protocol":"guess_bitrate_c","channels":{"data":0},"options":{}}
}' | "$sidecar" --decoder-root "$c_decoder_root" --decode | jq -e '
  .backend == "sigrok_native"
  and ([.frames[] | select(.row == "Bitrate") | .texts[0]] == ["100000"])
  ' >/dev/null

printf 'Packaged sigrok catalog and generic sparse decode passed.\n'
