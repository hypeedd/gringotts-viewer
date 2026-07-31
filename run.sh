#!/usr/bin/env bash
# Launch the Gringotts Vault Viewer. Read-only; binds to localhost only.
set -euo pipefail
cd "$(dirname "$0")"

export VAULT_PATH="${VAULT_PATH:-/home/jbarbosa/gringotts-vault}"
export HOST="${HOST:-127.0.0.1}"
export PORT="${PORT:-8765}"

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is required but not found." >&2
  exit 1
fi

exec python3 server.py
