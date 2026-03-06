#!/usr/bin/env bash

# Restart Meridian runtime:
# - stop PM2 apps (if used)
# - terminate Hub/Interface/Monitor and optionally agentapi processes
# - remove stale sockets
# - start Hub + Interface + Monitor again
# Usage:
#   ./user_scripts/restart.sh
#   ./user_scripts/restart.sh --keep-agents

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ROOT_DIR}/.env"
KEEP_AGENTS=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --keep-agents)
      KEEP_AGENTS=1
      shift
      ;;
    *)
      echo "Unknown argument: $1" >&2
      echo "Usage: ./user_scripts/restart.sh [--keep-agents]" >&2
      exit 1
      ;;
  esac
done

if [[ -f "${ENV_FILE}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  set +a
fi

LOG_DIR="${LOG_DIR:-/var/log/hub}"
HUB_SOCKET_PATH="${HUB_SOCKET_PATH:-/tmp/hub-core.sock}"
RUNTIME_LOG_DIR="${MERIDIAN_RUNTIME_LOG_DIR:-${ROOT_DIR}/logs}"
MERIDIAN_STATE_PATH="${MERIDIAN_STATE_PATH:-/tmp/meridian-state.json}"

log() {
  printf '[restart] %s\n' "$1"
}

kill_pids() {
  local pids="$1"
  if [[ -z "${pids}" ]]; then
    return 0
  fi

  local pid
  for pid in ${pids}; do
    kill "${pid}" >/dev/null 2>&1 || true
  done

  sleep 1

  for pid in ${pids}; do
    if kill -0 "${pid}" >/dev/null 2>&1; then
      kill -9 "${pid}" >/dev/null 2>&1 || true
    fi
  done
}

kill_by_pattern() {
  local pattern="$1"
  local label="$2"
  local pids
  pids="$(pgrep -f "${pattern}" || true)"
  if [[ -n "${pids}" ]]; then
    log "Stopping ${label}: ${pids//$'\n'/ }"
    kill_pids "${pids}"
  else
    log "No running ${label} found"
  fi
}

stop_pm2_apps() {
  if ! command -v pm2 >/dev/null 2>&1; then
    return 0
  fi

  if [[ "${KEEP_AGENTS}" -eq 1 ]]; then
    log "Skipping PM2 delete because keep-agents mode is enabled"
    return 0
  fi

  log "Stopping PM2 apps (if present)"
  pm2 delete calling-hub calling-interface calling-monitor >/dev/null 2>&1 || true
  pm2 delete ecosystem.config.js >/dev/null 2>&1 || true
}

cleanup_tmux_agent_sessions() {
  if ! command -v tmux >/dev/null 2>&1; then
    return 0
  fi

  local sessions
  sessions="$(tmux list-sessions -F '#{session_name}' 2>/dev/null | rg '^agent_(claude|codex|gemini|cursor)_[0-9]{2}$' || true)"
  if [[ -z "${sessions}" ]]; then
    return 0
  fi

  local session
  while IFS= read -r session; do
    [[ -z "${session}" ]] && continue
    log "Killing tmux session ${session}"
    tmux kill-session -t "${session}" >/dev/null 2>&1 || true
  done <<<"${sessions}"
}

start_with_pm2() {
  if ! command -v pm2 >/dev/null 2>&1; then
    return 1
  fi
  if ! pm2 ping >/dev/null 2>&1; then
    return 1
  fi
  if [[ ! -f "${ROOT_DIR}/ecosystem.config.js" ]]; then
    return 1
  fi
  if [[ ! -f "${ROOT_DIR}/dist/hub/index.js" || ! -f "${ROOT_DIR}/dist/interface/index.js" || ! -f "${ROOT_DIR}/dist/monitor/index.js" ]]; then
    return 1
  fi

  if [[ "${KEEP_AGENTS}" -eq 1 ]]; then
    log "Reloading Meridian with PM2 (keep-agents mode)"
    (
      cd "${ROOT_DIR}"
      pm2 reload ecosystem.config.js --only calling-hub,calling-interface,calling-monitor --update-env >/dev/null 2>&1 ||
        pm2 restart calling-hub calling-interface calling-monitor --update-env >/dev/null 2>&1 ||
        pm2 start ecosystem.config.js --only calling-hub,calling-interface,calling-monitor --update-env >/dev/null 2>&1
    )
    return 0
  fi

  log "Starting Meridian with PM2"
  (
    cd "${ROOT_DIR}"
    pm2 start ecosystem.config.js --only calling-hub,calling-interface,calling-monitor --update-env >/dev/null 2>&1
  )
  return 0
}

start_with_npm() {
  if ! command -v npm >/dev/null 2>&1; then
    echo "npm is required to restart Meridian" >&2
    exit 1
  fi

  mkdir -p "${RUNTIME_LOG_DIR}"
  log "Starting Meridian with npm scripts (logs in ${RUNTIME_LOG_DIR})"

  (
    cd "${ROOT_DIR}"
    nohup npm run start:hub >"${RUNTIME_LOG_DIR}/hub.log" 2>&1 &
    nohup npm run start:interface >"${RUNTIME_LOG_DIR}/interface.log" 2>&1 &
    nohup npm run start:monitor >"${RUNTIME_LOG_DIR}/monitor.log" 2>&1 &
  )
}

start_with_node_dist() {
  if ! command -v node >/dev/null 2>&1; then
    return 1
  fi
  if [[ ! -f "${ROOT_DIR}/dist/hub/index.js" || ! -f "${ROOT_DIR}/dist/interface/index.js" || ! -f "${ROOT_DIR}/dist/monitor/index.js" ]]; then
    return 1
  fi

  mkdir -p "${RUNTIME_LOG_DIR}"
  log "Starting Meridian with node dist entrypoints (logs in ${RUNTIME_LOG_DIR})"

  (
    cd "${ROOT_DIR}"
    nohup node dist/hub/index.js >"${RUNTIME_LOG_DIR}/hub.log" 2>&1 &
    nohup node dist/interface/index.js >"${RUNTIME_LOG_DIR}/interface.log" 2>&1 &
    nohup node dist/monitor/index.js >"${RUNTIME_LOG_DIR}/monitor.log" 2>&1 &
  )
  return 0
}

log "Stopping existing Meridian processes"
stop_pm2_apps

kill_by_pattern "${ROOT_DIR}/src/hub/index.ts|${ROOT_DIR}/dist/hub/index.js|npm run start:hub" "hub"
kill_by_pattern "${ROOT_DIR}/src/interface/index.ts|${ROOT_DIR}/dist/interface/index.js|npm run start:interface" "interface"
kill_by_pattern "${ROOT_DIR}/src/monitor/index.ts|${ROOT_DIR}/dist/monitor/index.js|npm run start:monitor" "monitor"

if [[ "${KEEP_AGENTS}" -eq 1 ]]; then
  log "Preserving existing agentapi processes, tmux agent sessions, and persisted hub state"
else
  kill_by_pattern "agentapi( |$).*server|${ROOT_DIR}/bin/agentapi" "agentapi"
  cleanup_tmux_agent_sessions
fi

log "Cleaning stale sockets"
rm -f "${HUB_SOCKET_PATH}" >/dev/null 2>&1 || true
if [[ "${KEEP_AGENTS}" -eq 1 ]]; then
  log "Skipping agent socket cleanup because keep-agents mode is enabled"
else
  rm -f /tmp/agentapi-*.sock >/dev/null 2>&1 || true
  rm -f "${MERIDIAN_STATE_PATH}" >/dev/null 2>&1 || true
fi

if start_with_pm2; then
  log "Restart complete (PM2 mode)"
  pm2 status calling-hub calling-interface calling-monitor || true
elif start_with_node_dist; then
  log "Restart complete (node dist mode)"
else
  start_with_npm
  log "Restart complete (npm mode)"
fi

log "Expected logs: ${LOG_DIR}/hub.log, ${LOG_DIR}/interface.log, ${LOG_DIR}/monitor.log (or ${RUNTIME_LOG_DIR} in npm mode)"
