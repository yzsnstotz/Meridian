#!/usr/bin/env bash
# Terminate Meridian and the companion meridian-roles runtime without rebuilding or relaunching.
# Usage:
#   ./user_scripts/terminate.sh
#   ./user_scripts/terminate.sh --reset-state

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ROOT_DIR}/.env"
RESET_STATE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --reset-state)
      RESET_STATE=1
      shift
      ;;
    *)
      echo "Unknown argument: $1" >&2
      echo "Usage: ./user_scripts/terminate.sh [--reset-state]" >&2
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
DEFAULT_MERIDIAN_STATE_PATH="${ROOT_DIR}/.meridian/state/hub-state.json"
LEGACY_MERIDIAN_STATE_PATH="/tmp/meridian-state.json"
MERIDIAN_STATE_PATH="${MERIDIAN_STATE_PATH:-${DEFAULT_MERIDIAN_STATE_PATH}}"
if [[ "${MERIDIAN_STATE_PATH}" == "${LEGACY_MERIDIAN_STATE_PATH}" ]]; then
  MERIDIAN_STATE_PATH="${DEFAULT_MERIDIAN_STATE_PATH}"
elif [[ "${MERIDIAN_STATE_PATH}" != /* ]]; then
  MERIDIAN_STATE_PATH="${ROOT_DIR}/${MERIDIAN_STATE_PATH}"
fi
export MERIDIAN_STATE_PATH

log() {
  printf 'STATUS: %s\n' "$*"
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
    log "kill ${label}: ${pids//$'\n'/ }"
    kill_pids "${pids}"
  else
    log "no running ${label} found"
  fi
}

process_cwd() {
  local pid="$1"
  lsof -a -d cwd -Fn -p "${pid}" 2>/dev/null | sed -n 's/^n//p' | head -n 1
}

runtime_pids_for_service() {
  local npm_script="$1"
  shift

  local pid command cwd entrypoint matched
  while read -r pid command; do
    [[ -z "${pid}" || -z "${command}" ]] && continue

    matched=0
    for entrypoint in "$@"; do
      if [[ "${command}" == *"${ROOT_DIR}/${entrypoint}"* ]]; then
        matched=1
        break
      fi

      if [[ "${command}" == *" ${entrypoint}"* || "${command}" == "${entrypoint}"* ]]; then
        cwd="$(process_cwd "${pid}")"
        if [[ "${cwd}" == "${ROOT_DIR}" ]]; then
          matched=1
          break
        fi
      fi
    done

    if [[ "${matched}" -eq 0 && "${command}" == *"npm run ${npm_script}"* ]]; then
      cwd="$(process_cwd "${pid}")"
      if [[ "${cwd}" == "${ROOT_DIR}" ]]; then
        matched=1
      fi
    fi

    if [[ "${matched}" -eq 1 ]]; then
      printf '%s\n' "${pid}"
    fi
  done < <(ps -axo pid=,command=) | sort -u
}

kill_runtime_service() {
  local label="$1"
  local npm_script="$2"
  shift 2

  local pids
  pids="$(runtime_pids_for_service "${npm_script}" "$@")"
  if [[ -n "${pids}" ]]; then
    log "kill ${label}: ${pids//$'\n'/ }"
    kill_pids "${pids}"
  else
    log "no running ${label} found"
  fi
}

stop_pm2_apps() {
  if ! command -v pm2 >/dev/null 2>&1; then
    return 0
  fi

  log "delete Meridian PM2 apps if present"
  pm2 delete calling-hub calling-interface calling-monitor calling-web >/dev/null 2>&1 || true
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
    log "kill tmux session ${session}"
    tmux kill-session -t "${session}" >/dev/null 2>&1 || true
  done <<<"${sessions}"
}

resolve_meridian_roles_root() {
  if [[ -n "${MERIDIAN_ROLES_ROOT:-}" ]]; then
    printf '%s\n' "${MERIDIAN_ROLES_ROOT}"
  elif [[ -x "${ROOT_DIR}/Meridian-roles/user_scripts/terminate.sh" ]]; then
    printf '%s\n' "${ROOT_DIR}/Meridian-roles"
  elif [[ -x "${ROOT_DIR}/../meridian-roles/user_scripts/terminate.sh" ]]; then
    printf '%s\n' "${ROOT_DIR}/../meridian-roles"
  fi
}

stop_meridian_roles() {
  local roles_root
  roles_root="$(resolve_meridian_roles_root || true)"
  if [[ -z "${roles_root}" ]]; then
    log "no meridian-roles terminate script found"
    return 0
  fi

  log "terminate meridian-roles via ${roles_root}/user_scripts/terminate.sh"
  "${roles_root}/user_scripts/terminate.sh" || true
}

log "terminate Meridian root=${ROOT_DIR}"
stop_meridian_roles
stop_pm2_apps
kill_runtime_service "hub" "start:hub" "src/hub/index.ts" "dist/hub/index.js"
kill_runtime_service "interface" "start:interface" "src/interface/index.ts" "dist/interface/index.js"
kill_runtime_service "monitor" "start:monitor" "src/monitor/index.ts" "dist/monitor/index.js"
kill_runtime_service "web-gui" "start:web" "src/web/server.ts" "dist/web/server.js"
# Comprehensive agentapi/codex sweep: kills the agentapi parent + its codex CLI
# children + any orphan codex processes whose agentapi parent already exited
# (the failure mode that left ~209 stranded codex_NN threads during the
# 67f6a3fc runaway). Replaces the narrower kill_by_pattern call that used to
# live here.
if [[ -x "${ROOT_DIR}/user_scripts/kill_all_agentapi.sh" ]]; then
  log "sweep agentapi processes (parent + codex children + orphans)"
  "${ROOT_DIR}/user_scripts/kill_all_agentapi.sh" || true
else
  log "kill_all_agentapi.sh missing — falling back to narrow agentapi pkill"
  kill_by_pattern "agentapi( |$).*server|${ROOT_DIR}/bin/agentapi" "agentapi"
fi
cleanup_tmux_agent_sessions

log "remove sockets"
rm -f "${HUB_SOCKET_PATH}" >/dev/null 2>&1 || true
# /tmp/agentapi-*.sock is also swept by kill_all_agentapi.sh; keep this line
# as belt-and-suspenders for the fallback path above.
rm -f /tmp/agentapi-*.sock >/dev/null 2>&1 || true
if [[ "${RESET_STATE}" -eq 1 ]]; then
  log "reset persisted hub state: ${MERIDIAN_STATE_PATH}"
  rm -f "${MERIDIAN_STATE_PATH}" "${LEGACY_MERIDIAN_STATE_PATH}" >/dev/null 2>&1 || true
else
  log "preserve persisted hub state: ${MERIDIAN_STATE_PATH}"
fi
mkdir -p "${RUNTIME_LOG_DIR}" "${LOG_DIR}" >/dev/null 2>&1 || true

log "DONE"
