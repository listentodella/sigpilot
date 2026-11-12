#!/usr/bin/env bash
# Samples a running SigPilot process for a few seconds and prints the hottest
# frames. Safe by design: `sample` attaches for the requested duration only, so
# the app never has to be left running until it locks up the machine.
#
# Usage:
#   tools/cpu-sample/run.sh              # 3 seconds, finds the app automatically
#   tools/cpu-sample/run.sh 5            # 5 seconds
#   tools/cpu-sample/run.sh 5 <pid>      # a specific process
set -euo pipefail

seconds="${1:-3}"
pid="${2:-}"

if [[ -z "$pid" ]]; then
  # Debug and bundled builds have different paths; try both.
  pid="$(pgrep -f 'SigPilot.app/Contents/MacOS' | head -1 || true)"
  if [[ -z "$pid" ]]; then
    pid="$(pgrep -f 'target/debug/sigpilot|target/release/sigpilot' | head -1 || true)"
  fi
fi

if [[ -z "$pid" ]]; then
  echo "No SigPilot process found. Start the app, then run this again." >&2
  exit 1
fi

echo "==> sampling pid $pid for ${seconds}s"
out="$(mktemp -t sigpilot-sample)"
sample "$pid" "$seconds" -file "$out" >/dev/null 2>&1 || true

# `sample` prints one indented call tree per thread. A line looks like:
#     1782 ???  (in bash)  load address ...  [0x...]
# or   312 WebKit::RunLoop::run()  (in WebKit) + 1  [0x...]
# Leaf cost is what matters: a frame's own sample count excludes its children in
# this format, so summing by frame name highlights genuine hotspots.
extract_frames() {
  awk '
    /^ *[0-9]+ +[^ ]/ {
      count = $1
      line = $0
      sub(/^ *[0-9]+ +/, "", line)
      # Prefer the module, because symbol names are often ?? for a release build.
      module = line
      if (match(line, /\(in [^)]+\)/)) {
        module = substr(line, RSTART + 4, RLENGTH - 5)
      }
      if (module == "" || module ~ /load address/) module = "(unknown)"
      name = line
      sub(/ +\(in .*/, "", name)
      sub(/ +load address.*/, "", name)
      if (name == "??" || name == "") name = module
      printf "%s\t%s\t%d\n", module, name, count
    }
  ' "$out"
}

if [[ ! -s "$out" ]]; then
  echo "sample produced no output (needs permission? try again)" >&2
  exit 1
fi

echo
echo "==> hottest modules"
extract_frames | awk -F'\t' '{ total[$1] += $3 } END { for (m in total) printf "%8d  %s\n", total[m], m }' |
  sort -rn | head -15

echo
echo "==> hottest frames"
extract_frames | awk -F'\t' '{ total[$2] += $3 } END { for (f in total) printf "%8d  %s\n", total[f], f }' |
  sort -rn | head -25

echo
echo "==> busiest threads"
awk '/^ *[0-9]+ Thread/ { count = $1; $1 = ""; print count "\t" $0 }' "$out" |
  sort -rn | head -8

echo
echo "raw sample: $out"
