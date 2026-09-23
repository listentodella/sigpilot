#!/usr/bin/env bash
# Verifies that publishing a live viewport re-renders only the components that
# subscribe to it, and never the workbench component that owns everything else.
#
# This is the whole claim behind src/lib/viewportStore.ts, and it cannot be
# checked with `node --test`: useSyncExternalStore's subscription path needs a
# real DOM, and SSR only exercises the fallback branch. So the real store, the
# real hook and a probe component are bundled and driven in a browser.
#
# Usage: tools/viewport-store-verify/run.sh
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project="$(cd "$here/../.." && pwd)"
port="${PXGL_VERIFY_PORT:-8798}"

chrome="${CHROME_BIN:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
if [[ ! -x "$chrome" ]]; then
  echo "Chrome not found. Set CHROME_BIN to a Chromium-based browser." >&2
  exit 1
fi

echo "==> bundling the probe"
(cd "$project" && ./node_modules/.bin/vite build --config "$here/vite.config.ts" >/dev/null)

echo "==> serving $here on 127.0.0.1:$port"
python3 -m http.server "$port" --bind 127.0.0.1 --directory "$here" >/dev/null 2>&1 &
server=$!
trap 'kill $server 2>/dev/null || true' EXIT

for _ in $(seq 1 60); do
  if curl -fsS -o /dev/null "http://127.0.0.1:$port/check.html" 2>/dev/null; then break; fi
  sleep 0.1
done

echo "==> running in headless Chrome"
"$chrome" \
  --headless=new \
  --disable-gpu \
  --no-sandbox \
  --dump-dom \
  --virtual-time-budget=8000 \
  "http://127.0.0.1:$port/check.html" 2>/dev/null |
  sed -n '/<pre id="out"/,/<\/pre>/p' |
  sed -e 's/&gt;/>/g' -e 's/&lt;/</g' -e 's/&amp;/\&/g' -e 's/<[^>]*>//g'
