#!/usr/bin/env bash
# Mounts the real WaveformAnnotationsOverlay in headless Chrome and asserts the
# rendered DOM, icon pixels and interactions.
#
# Why a browser: the overlay is DOM plus per-symbol canvases, so the things that
# actually break (unstyled elements, icons never painted, titles that overflow,
# a drag that never commits) are invisible to `node --test`.
#
# The page does all of its work synchronously inside a deferred module, so it
# finishes before the load event and --dump-dom captures the finished result.
#
# Usage: tools/annotation-overlay-verify/run.sh
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project="$(cd "$here/../.." && pwd)"
port="${PX_ANNOTATION_VERIFY_PORT:-8802}"

chrome="${CHROME_BIN:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
if [[ ! -x "$chrome" ]]; then
  echo "Chrome not found. Set CHROME_BIN to a Chromium-based browser." >&2
  exit 1
fi

echo "==> bundling the overlay"
(cd "$project" && ./node_modules/.bin/vite build --config "$here/vite.config.ts" >/dev/null)

page="tools/annotation-overlay-verify/check.html"
# The project root is served, not this directory: the harness page links the real
# src/styles.css so computed-style assertions describe the shipping stylesheet.
echo "==> serving $project on 127.0.0.1:$port"
python3 -m http.server "$port" --bind 127.0.0.1 --directory "$project" >/dev/null 2>&1 &
server=$!
trap 'kill $server 2>/dev/null || true' EXIT

for _ in $(seq 1 60); do
  if curl -fsS -o /dev/null "http://127.0.0.1:$port/$page" 2>/dev/null; then break; fi
  sleep 0.1
done

echo "==> asserting in headless Chrome"
# The budget lets the page's await-driven setup (passive effects, ResizeObserver)
# finish before the DOM is dumped. No rAF loop runs here, so virtual time is safe.
"$chrome" \
  --headless=new \
  --disable-gpu \
  --no-sandbox \
  --virtual-time-budget=3000 \
  --dump-dom \
  "http://127.0.0.1:$port/$page" 2>/dev/null |
  sed -n '/<pre id="out"/,/<\/pre>/p' |
  sed -e 's/&gt;/>/g' -e 's/&lt;/</g' -e 's/&amp;/\&/g' -e 's/<[^>]*>//g'

echo "==> screenshot for visual review"
"$chrome" \
  --headless=new \
  --disable-gpu \
  --no-sandbox \
  --virtual-time-budget=3000 \
  --window-size=1000,420 \
  --screenshot="$here/annotations.png" \
  "http://127.0.0.1:$port/$page" >/dev/null 2>&1 || true
if [[ -f "$here/annotations.png" ]]; then
  echo "saved $here/annotations.png ($(wc -c < "$here/annotations.png" | tr -d ' ') bytes)"
fi
