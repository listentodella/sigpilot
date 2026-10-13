#!/usr/bin/env bash
set -euo pipefail

# Both runtime production and client smoke tests need the same Homebrew ABI.
brew install "$@" glib jq
if ! brew install python@3.13; then
  # Intel hosted images include python.org links in /usr/local/bin. Homebrew
  # installs the bottle successfully but exits nonzero when those links clash.
  # Verify the installed formula before repairing links on the ephemeral runner.
  python_root="$(brew --prefix python@3.13)"
  "$python_root/bin/python3.13" --version
  if [[ "${GITHUB_ACTIONS:-false}" != "true" ]]; then
    printf 'Python is installed but brew install failed; inspect its links before retrying.\n' >&2
    exit 1
  fi
  brew link --overwrite python@3.13
fi
python_root="$(brew --prefix python@3.13)"
"$python_root/bin/python3.13" --version
