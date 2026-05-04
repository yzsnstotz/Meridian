#!/usr/bin/env bash
# Rebuild and restart meridian-roles from this repo (no hard-coded paths).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd -P)"
LOG_DIR="$ROOT_DIR/logs"
PID_FILE="$LOG_DIR/meridian-roles.pid"
TMUX_SESSION_FILE="$LOG_DIR/meridian-roles.tmux-session"
RUN_LOG="$LOG_DIR/meridian-roles.out.log"
GUI_PORT="${GUI_PORT:-7701}"
GUI_LISTEN_HOST="${GUI_LISTEN_HOST:-0.0.0.0}"
ROLES_SOCKET_PATH="${ROLES_SOCKET_PATH:-/tmp/meridian-roles.sock}"

mkdir -p "$LOG_DIR"

cd "$ROOT_DIR"

echo "meridian-roles rebuild_restart: ROOT_DIR=$ROOT_DIR" >&2
echo "meridian-roles rebuild_restart: CWD=$(pwd) USER=$(id -un) UID=$(id -u) GID=$(id -g)" >&2
echo "meridian-roles rebuild_restart: node=$(command -v node 2>/dev/null || echo MISSING) npm=$(command -v npm 2>/dev/null || echo MISSING)" >&2
echo "meridian-roles rebuild_restart: node_version=$(node -v 2>/dev/null || echo MISSING) npm_version=$(npm -v 2>/dev/null || echo MISSING)" >&2

for env_file in "$ROOT_DIR/.env" "$ROOT_DIR/.env.local"; do
  if [[ -f "$env_file" ]]; then
    set -a
    # shellcheck source=/dev/null
    source "$env_file"
    set +a
  fi
done

export GUI_PORT
export GUI_LISTEN_HOST
export ROLES_SOCKET_PATH

shell_escape() {
  printf '%q' "$1"
}

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

service_launcher_is_alive() {
  local pid="${1:-}"
  local session_name="${2:-}"

  if [[ -n "$session_name" ]] && command -v tmux >/dev/null 2>&1; then
    tmux has-session -t "$session_name" 2>/dev/null
    return $?
  fi

  if [[ -n "$pid" ]]; then
    kill -0 "$pid" 2>/dev/null
    return $?
  fi

  return 1
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
  lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1
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

if [[ -f "$PID_FILE" ]]; then
  old_pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [[ -n "${old_pid}" ]] && kill -0 "${old_pid}" 2>/dev/null; then
    echo "Stopping existing meridian-roles process (pid=${old_pid})..."
    kill "${old_pid}" || true
    # Best-effort: stop any immediate children (npm -> node/tsx) to avoid orphans.
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
      kill -9 "${old_pid}" || true
    fi
  fi
  rm -f "$PID_FILE"
fi

if [[ -f "$TMUX_SESSION_FILE" ]]; then
  old_session="$(cat "$TMUX_SESSION_FILE" 2>/dev/null || true)"
  kill_tmux_session "$old_session"
  rm -f "$TMUX_SESSION_FILE"
fi

# Only match processes that include this repo path to avoid killing unrelated services
# (e.g., Meridian itself may run via "pnpm start" which contains "npm start" as a substring).
kill_by_pattern "${ROOT_DIR}/src/index.ts|${ROOT_DIR}/dist/index.js|${ROOT_DIR}.*tsx src/index.ts|${ROOT_DIR}.*npm (run )?start" "meridian-roles"
kill_repo_port_listeners

echo "Cleaning stale socket: ${ROLES_SOCKET_PATH}"
rm -f "${ROLES_SOCKET_PATH}" 2>/dev/null || true

if [[ ! -d "$ROOT_DIR/node_modules" ]]; then
  echo "node_modules missing; installing dependencies via npm ci..."
  npm ci
fi

echo "Building meridian-roles..."
npm run build

START_CMD=(npm start)
TMUX_SESSION_NAME="meridian_roles_service_$(id -u)"
new_pid=""
launch_mode="nohup"
health_session_name=""

echo "meridian-roles rebuild_restart: listen_host=${GUI_LISTEN_HOST} gui_port=${GUI_PORT} socket=${ROLES_SOCKET_PATH}" >&2
echo "meridian-roles rebuild_restart: start_command=${START_CMD[*]}" >&2

echo "Starting meridian-roles in background..."
if command -v tmux >/dev/null 2>&1; then
  tmux_command="cd $(shell_escape "$ROOT_DIR") && export GUI_PORT=$(shell_escape "$GUI_PORT") GUI_LISTEN_HOST=$(shell_escape "$GUI_LISTEN_HOST") ROLES_SOCKET_PATH=$(shell_escape "$ROLES_SOCKET_PATH") && exec npm start >> $(shell_escape "$RUN_LOG") 2>&1"
  kill_tmux_session "$TMUX_SESSION_NAME"
  tmux new-session -d -s "$TMUX_SESSION_NAME" "$tmux_command"
  printf '%s\n' "$TMUX_SESSION_NAME" > "$TMUX_SESSION_FILE"
  new_pid="$(tmux display-message -p -t "$TMUX_SESSION_NAME" '#{pane_pid}' 2>/dev/null || true)"
  launch_mode="tmux"
  health_session_name="$TMUX_SESSION_NAME"
else
  nohup "${START_CMD[@]}" < /dev/null >> "$RUN_LOG" 2>&1 &
  new_pid=$!
fi

if [[ -n "$new_pid" ]]; then
  echo "$new_pid" > "$PID_FILE"
else
  rm -f "$PID_FILE"
fi

echo "Waiting for meridian-roles to become healthy (http://127.0.0.1:${GUI_PORT}/, socket: ${ROLES_SOCKET_PATH})..."
echo "meridian-roles rebuild_restart: launch_mode=${launch_mode}${new_pid:+ pid=${new_pid}}${health_session_name:+ session=${health_session_name}}" >&2

healthy="false"
healthy_streak=0
# Cold start (tsx + Hub probes + reconciliation) can exceed 30s; killing the service on a tight
# timeout makes Telegram /restart look like "7701 never came up".
HEALTH_MAX_ATTEMPTS="${HEALTH_MAX_ATTEMPTS:-90}"
HEALTH_STREAK_REQUIRED="${HEALTH_STREAK_REQUIRED:-3}"
for _ in $(seq 1 "${HEALTH_MAX_ATTEMPTS}"); do
  launcher_alive="true"
  if ! service_launcher_is_alive "$new_pid" "$health_session_name"; then
    launcher_alive="false"
  fi

  if command -v curl >/dev/null 2>&1 && curl -fsS --max-time 1 "http://127.0.0.1:${GUI_PORT}/" >/dev/null 2>&1; then
    if [[ -S "${ROLES_SOCKET_PATH}" ]]; then
      healthy_streak=$((healthy_streak + 1))
      if [[ "$healthy_streak" -ge "${HEALTH_STREAK_REQUIRED}" ]]; then
        healthy="true"
        break
      fi
    else
      healthy_streak=0
    fi
  else
    healthy_streak=0
  fi

  if [[ "$launcher_alive" == "false" ]] && [[ -z "$(find_repo_port_listener_pids)" ]]; then
    break
  fi

  sleep 1
done

if [[ "${healthy}" == "true" ]]; then
  actual_pid="$(find_repo_port_listener_pids | head -n 1)"
  if [[ -n "${actual_pid}" ]]; then
    new_pid="$actual_pid"
    printf '%s\n' "$new_pid" > "$PID_FILE"
  fi
  echo "meridian-roles restarted successfully."
  echo "PID: $new_pid"
  echo "Log: $RUN_LOG"
  exit 0
fi

echo "Failed to start meridian-roles (health check did not pass). Check log: $RUN_LOG" >&2
if [[ "${launch_mode}" == "tmux" ]]; then
  kill_tmux_session "$TMUX_SESSION_NAME"
  rm -f "$TMUX_SESSION_FILE"
fi
kill_repo_port_listeners
if [[ -f "$RUN_LOG" ]]; then
  echo "--- last 200 lines of $RUN_LOG ---" >&2
  tail -n 200 "$RUN_LOG" >&2 || true
  echo "--- end log ---" >&2
fi
exit 1
