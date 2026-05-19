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

kill_by_pattern() {
  local pattern="$1"
  local label="$2"
  local pids
  if ! command -v pgrep >/dev/null 2>&1; then
    return 0
  fi
  pids="$(pgrep -f "${pattern}" 2>/dev/null || true)"
  if [[ -n "${pids}" ]]; then
    echo "Stopping ${label} by pattern: ${pids//$'\n'/ }"
    kill ${pids} 2>/dev/null || true
    sleep 1
    kill -9 ${pids} 2>/dev/null || true
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

# Only match processes that include this repo path to avoid killing unrelated services.
kill_by_pattern "${ROOT_DIR}/src/index.ts|${ROOT_DIR}/dist/index.js|${ROOT_DIR}.*tsx src/index.ts|${ROOT_DIR}.*npm (run )?start" "meridian-roles"
kill_repo_port_listeners

echo "Cleaning stale socket: ${ROLES_SOCKET_PATH}"
rm -f "${ROLES_SOCKET_PATH}" 2>/dev/null || true

echo "STATUS: DONE"
