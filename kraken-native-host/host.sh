#!/usr/bin/env bash
# Launcher for the Kraken native host (Linux / macOS-style shells).
# Uses the virtual environment created by install.sh when present.
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -x "$DIR/.venv/bin/python" ]; then
    exec "$DIR/.venv/bin/python" "$DIR/host.py" "$@"
else
    exec python3 "$DIR/host.py" "$@"
fi
