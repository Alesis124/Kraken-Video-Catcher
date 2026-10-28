#!/usr/bin/env bash
# Kraken Video Catcher - native host installer for Linux.
#
# Usage:
#   ./install.sh [EXTENSION_ID]
#
# What it does:
#   1. Checks for python3, tkinter and ffmpeg.
#   2. Creates a virtual environment (.venv) and installs requests + pycryptodome.
#   3. Writes the native messaging manifest for every supported browser found.
set -euo pipefail

HOST_NAME="com.krakencatcher.host"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST_SH="$DIR/host.sh"
CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"

echo "============================================"
echo " Kraken Native Host installer (Linux)"
echo "============================================"
echo

# --- 1. Prerequisites -------------------------------------------------------
if ! command -v python3 >/dev/null 2>&1; then
    echo "[!] python3 was not found. Install it with your package manager and run this script again."
    exit 1
fi

if ! python3 -c "import tkinter" >/dev/null 2>&1; then
    echo "[!] tkinter is not available for python3 (it provides the progress window)."
    echo "    Debian/Ubuntu: sudo apt install python3-tk"
    echo "    Fedora:        sudo dnf install python3-tkinter"
    echo "    Arch:          sudo pacman -S tk"
    exit 1
fi

if ! python3 -c "import venv, ensurepip" >/dev/null 2>&1; then
    echo "[!] The python3 venv module is missing."
    echo "    Debian/Ubuntu: sudo apt install python3-venv"
    exit 1
fi

if ! command -v ffmpeg >/dev/null 2>&1; then
    echo "[!] Warning: ffmpeg was not found in PATH."
    echo "    The host will save videos as .ts without remuxing to MP4."
    echo "    Debian/Ubuntu: sudo apt install ffmpeg"
    echo
fi

# --- 2. Python environment --------------------------------------------------
echo "[1/3] Creating virtual environment and installing dependencies..."
# --system-site-packages keeps the distribution's tkinter visible inside the venv.
python3 -m venv --system-site-packages "$DIR/.venv"
"$DIR/.venv/bin/python" -m pip install --quiet --upgrade pip
"$DIR/.venv/bin/python" -m pip install --quiet --upgrade requests pycryptodome
chmod +x "$HOST_SH" "$DIR/host.py"

# --- 3. Extension ID --------------------------------------------------------
echo
echo "[2/3] The extension ID is required."
echo "      Open chrome://extensions, enable Developer mode, and copy the ID"
echo "      shown under \"Kraken Video Catcher\"."
echo

EXT_ID="${1:-}"
if [ -z "$EXT_ID" ]; then
    read -r -p "Extension ID: " EXT_ID
fi
EXT_ID="$(echo "$EXT_ID" | tr -d '[:space:]')"

if ! [[ "$EXT_ID" =~ ^[a-p]{32}$ ]]; then
    echo "[!] \"$EXT_ID\" does not look like a valid extension ID (32 letters, a-p)."
    exit 1
fi

# --- 4. Native messaging manifests -----------------------------------------
echo
echo "[3/3] Registering the native messaging host..."

# browser label | config directory (relative to CONFIG_HOME)
BROWSERS=(
    "Google Chrome|google-chrome"
    "Chrome Beta|google-chrome-beta"
    "Chromium|chromium"
    "Brave|BraveSoftware/Brave-Browser"
    "Microsoft Edge|microsoft-edge"
    "Vivaldi|vivaldi"
)

write_manifest() {
    local target_dir="$1"
    mkdir -p "$target_dir"
    HOST_SH="$HOST_SH" EXT_ID="$EXT_ID" HOST_NAME="$HOST_NAME" \
    python3 - "$target_dir/$HOST_NAME.json" <<'PY'
import json, os, sys
manifest = {
    "name": os.environ["HOST_NAME"],
    "description": "Kraken Video Catcher - Native Host",
    "path": os.environ["HOST_SH"],
    "type": "stdio",
    "allowed_origins": ["chrome-extension://%s/" % os.environ["EXT_ID"]],
}
with open(sys.argv[1], "w", encoding="utf-8") as f:
    json.dump(manifest, f, indent=2)
    f.write("\n")
PY
}

installed=0
for entry in "${BROWSERS[@]}"; do
    label="${entry%%|*}"
    subdir="${entry##*|}"
    if [ -d "$CONFIG_HOME/$subdir" ]; then
        write_manifest "$CONFIG_HOME/$subdir/NativeMessagingHosts"
        echo "  - $label: $CONFIG_HOME/$subdir/NativeMessagingHosts/$HOST_NAME.json"
        installed=$((installed + 1))
    fi
done

if [ "$installed" -eq 0 ]; then
    write_manifest "$CONFIG_HOME/google-chrome/NativeMessagingHosts"
    echo "  - No browser profile directory found; registered for Google Chrome by default:"
    echo "    $CONFIG_HOME/google-chrome/NativeMessagingHosts/$HOST_NAME.json"
fi

echo
echo "============================================"
echo " Installation completed."
echo "============================================"
echo " Host launcher: $HOST_SH"
echo
echo " Reload the extension in chrome://extensions and try a download."
echo " If you move this folder, run ./install.sh again."
echo " Note: Snap and Flatpak browsers use sandboxed config paths and are not supported."
