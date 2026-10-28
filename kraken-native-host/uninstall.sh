#!/usr/bin/env bash
# Removes the native messaging manifests created by install.sh.
set -euo pipefail

HOST_NAME="com.krakencatcher.host"
CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

for sub in google-chrome google-chrome-beta chromium BraveSoftware/Brave-Browser microsoft-edge vivaldi; do
    f="$CONFIG_HOME/$sub/NativeMessagingHosts/$HOST_NAME.json"
    if [ -f "$f" ]; then
        rm -f "$f"
        echo "Removed $f"
    fi
done

if [ -d "$DIR/.venv" ]; then
    rm -rf "$DIR/.venv"
    echo "Removed $DIR/.venv"
fi

echo "Uninstall completed."
