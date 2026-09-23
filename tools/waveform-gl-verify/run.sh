#!/usr/bin/env bash
# Verifies the WebGL2 waveform renderer end to end.
#
# The renderer lives in a worker, so a unit test cannot reach it. This harness
# bundles the real worker module, loads it in a browser page with a shimmed
# `self`, renders a synthetic square wave, and reads the resulting pixels back.
# It is the only check that covers the GLSL, the per-bin instancing and the GPU
# viewport transform together.
#
# Usage: tools/waveform-gl-verify/run.sh
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project="$(cd "$here/../.." && pwd)"
port="${PXGL_VERIFY_PORT:-8799}"

chrome="${CHROME_BIN:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
if [[ ! -x "$chrome" ]]; then
  echo "Chrome not found. Set CHROME_BIN to a Chromium-based browser." >&2
  exit 1
fi

echo "==> bundling the worker"
(cd "$project" && ./node_modules/.bin/vite build --config "$here/vite.config.ts" >/dev/null)

echo "==> serving $here on 127.0.0.1:$port"
python3 -m http.server "$port" --bind 127.0.0.1 --directory "$here" >/dev/null 2>&1 &
server=$!
trap 'kill $server 2>/dev/null || true' EXIT

for _ in $(seq 1 60); do
  if curl -fsS -o /dev/null "http://127.0.0.1:$port/check.html" 2>/dev/null; then break; fi
  sleep 0.1
done

echo "==> rendering in headless Chrome"
"$chrome" \
  --headless=new \
  --disable-gpu \
  --enable-unsafe-swiftshader \
  --no-sandbox \
  --dump-dom \
  --virtual-time-budget=8000 \
  "http://127.0.0.1:$port/check.html" 2>/dev/null |
  sed -n '/<pre id="out"/,/<\/pre>/p' |
  sed -e 's/&gt;/>/g' -e 's/&lt;/</g' -e 's/&amp;/\&/g' -e 's/<[^>]*>//g'
