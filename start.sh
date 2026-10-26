#!/usr/bin/env bash
# ==============================================================================
# TuneVault PRO - Fast Launcher for Linux / GCP / Cloud VMs
# ==============================================================================

set -e

PORT="${PORT:-8000}"
HOST="${HOST:-0.0.0.0}"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$APP_DIR"

# Activate virtual environment if present
if [ -d "venv" ]; then
    source venv/bin/activate
fi

# Ensure Deno is in PATH if installed in user directory
if [ -d "$HOME/.deno/bin" ]; then
    export PATH="$HOME/.deno/bin:$PATH"
fi

echo "=================================================="
echo " Starting TuneVault PRO on http://${HOST}:${PORT}"
echo "=================================================="

exec uvicorn app:app --host "$HOST" --port "$PORT" --workers 2
