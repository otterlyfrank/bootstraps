#!/usr/bin/env bash
# Bootstraps — local job hunt cockpit (static UI + job-link fetch)
set -euo pipefail
cd "$(dirname "$0")"
PORT="${PORT:-8792}"
if [[ "${SKIP_GIT_PULL:-0}" != "1" ]]; then
  SUITE_PULL="$(cd "$(dirname "$0")/../otterly-suite" 2>/dev/null && pwd)/git-pull.sh"
  if [[ -f "$SUITE_PULL" ]]; then
    # shellcheck disable=SC1090
    source "$SUITE_PULL"
    otterly_git_pull "."
  fi
fi
echo ""
echo "  Bootstraps — hunt · learn · climb"
echo "  Open: http://127.0.0.1:${PORT}"
echo "  Job fetch API: POST /api/job-fetch"
echo "  Stop: Ctrl+C"
echo ""
if ! command -v python3 >/dev/null 2>&1; then
  echo "Python 3 required: https://www.python.org/downloads/" >&2
  exit 1
fi
if command -v open >/dev/null 2>&1; then
  (sleep 0.5 && open "http://127.0.0.1:${PORT}/") &
elif command -v xdg-open >/dev/null 2>&1; then
  (sleep 0.5 && xdg-open "http://127.0.0.1:${PORT}/") &
fi
exec python3 scripts/bootstraps_server.py --host 127.0.0.1 --port "$PORT"
