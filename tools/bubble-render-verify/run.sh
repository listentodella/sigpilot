#!/usr/bin/env bash
# Measures the cost of rebuilding the analyzer bubble list.
#
# Removing the canvas preview path (option 3) left the bubble elements as the
# only rendering path, so every pan/zoom re-aggregation now goes through React.
# The question this answers is whether that rebuild fits in a frame budget, or
# whether the element set has to be decoupled from track changes.
#
# Guards that keep the numbers honest:
#   - a clock-resolution probe, so a 0.00 ms reading is never mistaken for "fast"
#   - a busy-loop probe, so a frozen clock is detected rather than believed
#   - a MutationObserver count, so a commit that produced no DOM is visible
#
# The page does all of its work synchronously inside a deferred module, so it
# finishes before the load event and --dump-dom captures it. No virtual clock is
# used: it interacts badly with the component's self-rescheduling rAF loops.
#
# Usage: tools/bubble-render-verify/run.sh
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project="$(cd "$here/../.." && pwd)"
port="${PX_BUBBLE_VERIFY_PORT:-8801}"

chrome="${CHROME_BIN:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
if [[ ! -x "$chrome" ]]; then
  echo "Chrome not found. Set CHROME_BIN to a Chromium-based browser." >&2
  exit 1
fi

echo "==> bundling the overlay"
(cd "$project" && ./node_modules/.bin/vite build --config "$here/vite.config.ts" >/dev/null)

echo "==> serving $here on 127.0.0.1:$port"
python3 -m http.server "$port" --bind 127.0.0.1 --directory "$here" >/dev/null 2>&1 &
server=$!
trap 'kill $server 2>/dev/null || true' EXIT

for _ in $(seq 1 60); do
  if curl -fsS -o /dev/null "http://127.0.0.1:$port/check.html" 2>/dev/null; then break; fi
  sleep 0.1
done

echo "==> measuring in headless Chrome"
"$chrome" \
  --headless=new \
  --disable-gpu \
  --no-sandbox \
  --dump-dom \
  "http://127.0.0.1:$port/check.html" 2>/dev/null |
  sed -n '/<pre id="out"/,/<\/pre>/p' |
  sed -e 's/&gt;/>/g' -e 's/&lt;/</g' -e 's/&amp;/\&/g' -e 's/<[^>]*>//g'
