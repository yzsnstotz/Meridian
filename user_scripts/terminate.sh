#!/usr/bin/env bash
# Terminate meridian-roles from this repo without rebuilding or restarting.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd -P)"
LOG_DIR="$ROOT_DIR/logs"
PID_FILE="$LOG_DIR/meridian-roles.pid"
TMUX_SESSION_FILE="$LOG_DIR/meridian-roles.tmux-session"
GUI_PORT="${GUI_PORT:-7701}"
ROLES_SOCKET_PATH="${ROLES_SOCKET_PATH:-/tmp/meridian-roles.sock}"

mkdir -p "$LOG_DIR"
cd "$ROOT_DIR"

echo "meridian-roles terminate: ROOT_DIR=$ROOT_DIR" >&2

kill_tmux_session() {
  local session_name="$1"
  if [[ -z "$session_name" ]] || ! command -v tmux >/dev/null 2>&1; then
    return 0
  fi
  if tmux has-session -t "$session_name" 2>/dev/null; then
    echo "Stopping tmux session: ${session_name}"
    tmux kill-session -t "$session_name" >/dev/null 2>&1 || true
  fi
}

canonical_cwd() {
  local directory="$1"
  (cd "$directory" 2>/dev/null && pwd -P) || true
}

process_cwd() {
  local pid="$1"
  if ! command -v lsof >/dev/null 2>&1; then
    return 0
  fi
  # timeout 5 guards against lsof blocking on a stuck mount.
  timeout 5 lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1
}

repo_owned_pids() {
  local pid cwd canonical canonical_lower root_lower
  root_lower="$(printf '%s' "$ROOT_DIR" | tr '[:upper:]' '[:lower:]')"
  for pid in "$@"; do
    [[ -n "$pid" ]] || continue
    cwd="$(process_cwd "$pid")"
    canonical="$(canonical_cwd "$cwd")"
    canonical_lower="$(printf '%s' "$canonical" | tr '[:upper:]' '[:lower:]')"
    if [[ -n "$canonical" && "$canonical_lower" == "$root_lower" ]]; then
      printf '%s\n' "$pid"
    fi
  done
}

# Lists PIDs whose argv references this repo's runtime — directly via an
# absolute entrypoint path ("${ROOT_DIR}/dist/index.js"), or via a relative
# argv whose cwd resolves to "${ROOT_DIR}". Mirrors Meridian's
# user_scripts/restart.sh::runtime_pids_for_service so the Maintenance Hub
# "Terminate" button at http://127.0.0.1:8765/ reliably catches the listener
# process. The previous pgrep regex ("${ROOT_DIR}.*npm start") only matched
# the tmux server's command line (which embeds the inline shell snippet) and
# did NOT match `npm start` or `node dist/index.js` — npm's invocation has no
# absolute repo path in argv. So whenever the PID file pointed at a stale pid,
# the safety net was a no-op and the listener stayed alive after "Terminate".
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

    if [[ "${matched}" -eq 0 ]] &&
       [[ "${command}" == *"npm run ${npm_script}"* || "${command}" == *"npm ${npm_script}"* ]]; then
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
  pids="$(runtime_pids_for_service "${npm_script}" "$@" || true)"
  if [[ -n "${pids}" ]]; then
    # kill_pids already prints "Stopping ${label}: ${pids}" — don't double-log.
    kill_pids "${label}" ${pids}
  fi
}

find_repo_port_listener_pids() {
  local pids
  if ! command -v lsof >/dev/null 2>&1; then
    return 0
  fi
  pids="$(lsof -tiTCP:"${GUI_PORT}" -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -n "$pids" ]]; then
    repo_owned_pids ${pids}
  fi
}

kill_pids() {
  local label="$1"
  shift
  local pids=("$@")
  if [[ "${#pids[@]}" -eq 0 ]]; then
    return 0
  fi
  echo "Stopping ${label}: ${pids[*]}"
  kill "${pids[@]}" 2>/dev/null || true
  sleep 1
  kill -9 "${pids[@]}" 2>/dev/null || true
}

kill_repo_port_listeners() {
  local pids
  pids="$(find_repo_port_listener_pids)"
  if [[ -n "$pids" ]]; then
    kill_pids "repo-owned meridian-roles listener(s) on port ${GUI_PORT}" ${pids}
  fi
}

terminate_pid_file_process() {
  if [[ ! -f "$PID_FILE" ]]; then
    return 0
  fi

  local old_pid child_pids
  old_pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [[ -n "${old_pid}" ]] && kill -0 "${old_pid}" 2>/dev/null; then
    echo "Stopping existing meridian-roles process (pid=${old_pid})..."
    kill "${old_pid}" 2>/dev/null || true
    if command -v pgrep >/dev/null 2>&1; then
      child_pids="$(pgrep -P "${old_pid}" 2>/dev/null || true)"
      if [[ -n "${child_pids}" ]]; then
        echo "Stopping child processes: ${child_pids}"
        kill ${child_pids} 2>/dev/null || true
      fi
    fi
    sleep 1
    if kill -0 "${old_pid}" 2>/dev/null; then
      echo "Process still alive, sending SIGKILL (pid=${old_pid})..."
      kill -9 "${old_pid}" 2>/dev/null || true
    fi
  fi
  rm -f "$PID_FILE"
}

terminate_tmux_session() {
  if [[ ! -f "$TMUX_SESSION_FILE" ]]; then
    return 0
  fi

  local old_session
  old_session="$(cat "$TMUX_SESSION_FILE" 2>/dev/null || true)"
  kill_tmux_session "$old_session"
  rm -f "$TMUX_SESSION_FILE"
}

terminate_pid_file_process
terminate_tmux_session

# Identify processes by cwd, not by argv-substring. `npm start` and the
# `node dist/index.js` it spawns both run with cwd=${ROOT_DIR} but neither has
# an absolute ROOT_DIR in argv — a pgrep regex would silently miss them.
kill_runtime_service "meridian-roles" "start" "src/index.ts" "dist/index.js"
kill_repo_port_listeners

echo "Cleaning stale socket: ${ROLES_SOCKET_PATH}"
rm -f "${ROLES_SOCKET_PATH}" 2>/dev/null || true

echo "STATUS: DONE"
