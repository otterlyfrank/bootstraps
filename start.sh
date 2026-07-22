#!/usr/bin/env bash
# Bootstraps — local job hunt cockpit
set -euo pipefail
cd "$(dirname "$0")"
PORT="${PORT:-8790}"
echo ""
echo "  Bootstraps — hunt · learn · climb"
echo "  Open: http://127.0.0.1:${PORT}"
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
exec python3 -m http.server "$PORT" --bind 127.0.0.1
