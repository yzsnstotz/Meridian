#!/usr/bin/env bash

# Rebuild Meridian and restart runtime services.
# Usage: ./user_scripts/rebuild_restart.sh

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

log() {
  printf '[rebuild_restart] %s\n' "$1"
}

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required" >&2
  exit 1
fi

log "Building project"
(
  cd "${ROOT_DIR}"
  npm run build
)

log "Restarting services"
"${ROOT_DIR}/user_scripts/restart.sh"

log "Done"
