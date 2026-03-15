#!/usr/bin/env bash

# Double-click on macOS to start Meridian (Hub, Interface, Monitor).
# Logs go to <repo>/logs/. Close this window to leave processes running;
# use user_scripts/restart.sh to stop and restart.
#
# Paths relative to this script; repo root = ../../..

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../../.." && pwd)"
LOG_DIR="${ROOT_DIR}/logs"
ENV_FILE="${ROOT_DIR}/.env"

if [[ -f "${ENV_FILE}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  set +a
fi

cd "${ROOT_DIR}"
mkdir -p "${LOG_DIR}"

if ! command -v npm >/dev/null 2>&1; then
  echo "npm not found. Install Node.js from https://nodejs.org" >&2
  read -r -p "Press Enter to close."
  exit 1
fi

echo "Starting Meridian (Hub, Interface, Monitor)..."
nohup npm run start:hub        >"${LOG_DIR}/hub.log" 2>&1 &
nohup npm run start:interface >"${LOG_DIR}/interface.log" 2>&1 &
nohup npm run start:monitor   >"${LOG_DIR}/monitor.log" 2>&1 &

echo "Meridian started. Logs: ${LOG_DIR}/hub.log, interface.log, monitor.log"
echo "To stop/restart: run ./user_scripts/restart.sh in terminal."
echo ""
read -r -p "Press Enter to close this window (processes keep running)."
