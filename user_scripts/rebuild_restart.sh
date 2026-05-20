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
HUB_SOCKET_PATH="${HUB_SOCKET_PATH:-/tmp/hub-core.sock}"
ENSURE_MERIDIAN_HUB="${ENSURE_MERIDIAN_HUB:-true}"

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

# meridian-roles authenticates to the hub as a built-in caller; the bootstrap
# secret used to derive caller_key lives in the Meridian repo's .env. Source it
# from _meridian_hub (symlink to the Meridian checkout) when not already in env
# so launches via this script work standalone.
if [[ -z "${MERIDIAN_INTERNAL_BOOTSTRAP_KEY:-}" ]]; then
  for hub_env in "$ROOT_DIR/_meridian_hub/.env" "$ROOT_DIR/_meridian_hub/.env.local"; do
    if [[ -f "$hub_env" ]]; then
      set -a
      # shellcheck source=/dev/null
      source "$hub_env"
      set +a
    fi
  done
fi

export GUI_PORT
export GUI_LISTEN_HOST
export ROLES_SOCKET_PATH
export HUB_SOCKET_PATH
if [[ -n "${MERIDIAN_INTERNAL_BOOTSTRAP_KEY:-}" ]]; then
  export MERIDIAN_INTERNAL_BOOTSTRAP_KEY
fi

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
# user_scripts/restart.sh::runtime_pids_for_service. See terminate.sh's copy
# of this helper for the full rationale (the previous pgrep regex matched the
# tmux server but not the actual npm/node processes spawned inside it, so the
# pre-rebuild kill step was a no-op and the new `npm start` hit EADDRINUSE on
# port 7701).
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

hub_socket_reachable() {
  if [[ ! -S "${HUB_SOCKET_PATH}" ]]; then
    return 1
  fi

  node -e '
const net = require("node:net");
const socketPath = process.argv[1];
const socket = net.createConnection(socketPath);
const timer = setTimeout(() => {
  socket.destroy();
  process.exit(1);
}, 1000);
socket.once("connect", () => {
  clearTimeout(timer);
  socket.end();
  process.exit(0);
});
socket.once("error", () => {
  clearTimeout(timer);
  process.exit(1);
});
' "${HUB_SOCKET_PATH}" >/dev/null 2>&1
}

ensure_meridian_hub_socket() {
  if [[ "${ENSURE_MERIDIAN_HUB}" == "false" ]]; then
    return 0
  fi

  if hub_socket_reachable; then
    return 0
  fi

  # When the outer chain (Meridian/user_scripts/rebuild_restart.sh) already
  # restarted Meridian, a missing hub socket here is a real failure — not a
  # recoverable condition. Recursively invoking ./user_scripts/restart.sh
  # --keep-agents from this point is the named hang suspect in
  # maintenance-hub-restart-pm2-and-socket-race.md's open follow-up: pm2 reload
  # races against the running hub, /tmp/hub-core.sock cleanup gets skipped under
  # keep-agents mode, and the loop never converges. Fail fast instead so the
  # operator sees the real cause.
  if [[ -n "${MERIDIAN_HUB_ALREADY_RESTARTED:-}" ]]; then
    echo "Meridian Hub socket missing at ${HUB_SOCKET_PATH} after outer chain already restarted Meridian; refusing recursive restart (set MERIDIAN_HUB_ALREADY_RESTARTED= to override)." >&2
    return 1
  fi

  local restart_script="$ROOT_DIR/_meridian_hub/user_scripts/restart.sh"
  if [[ ! -x "$restart_script" ]]; then
    echo "Meridian Hub socket is missing or unreachable at ${HUB_SOCKET_PATH}, and restart script was not found: ${restart_script}" >&2
    return 1
  fi

  echo "Meridian Hub socket missing or unreachable at ${HUB_SOCKET_PATH}; restarting Meridian runtime with --keep-agents..."
  # timeout 180 caps the recursive restart so a stuck pm2 reload cannot hang
  # the parent maintenance-hub action beyond its budget. Picked to comfortably
  # cover Meridian/restart.sh's own 30s wait_for_hub_socket plus pm2 reload.
  (
    cd "$ROOT_DIR/_meridian_hub"
    HUB_SOCKET_PATH="$HUB_SOCKET_PATH" timeout 180 ./user_scripts/restart.sh --keep-agents
  )

  for _ in $(seq 1 30); do
    if hub_socket_reachable; then
      return 0
    fi
    sleep 1
  done

  echo "Meridian Hub socket still unreachable after runtime restart: ${HUB_SOCKET_PATH}" >&2
  return 1
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

# Identify processes by cwd, not by argv-substring. `npm start` and the
# `node dist/index.js` it spawns both run with cwd=${ROOT_DIR} but neither has
# an absolute ROOT_DIR in argv — a pgrep regex would silently miss them and
# the next `npm start` below would hit EADDRINUSE on port 7701.
kill_runtime_service "meridian-roles" "start" "src/index.ts" "dist/index.js"
kill_repo_port_listeners

echo "Cleaning stale socket: ${ROLES_SOCKET_PATH}"
rm -f "${ROLES_SOCKET_PATH}" 2>/dev/null || true

# Install / refresh node_modules. The Maintenance Hub "Rebuild & restart"
# button at http://127.0.0.1:8765/ is the entry point operators use after a
# fresh git pull, so the script has to make sure node_modules matches
# package-lock.json — not just that node_modules exists. On 2026-05-20 PR #263
# (chatter manifest schema) added `import Ajv2020 from "ajv/dist/2020"` and
# bumped package-lock.json to ajv@8.20.0, but the operator's node_modules
# still had the pre-merge ajv@6.14.0 hoisted from eslint. The "exists"-only
# guard skipped `npm ci`, `tsc -p tsconfig.json` failed at
# `error TS2307: Cannot find module 'ajv/dist/2020'`, and rebuild_restart
# bailed out before re-launching the service.
#
# npm writes node_modules/.package-lock.json on every install (npm 7+);
# comparing its mtime to package-lock.json detects a stale tree without
# paying for `npm ls --depth=0` on every restart.
if [[ ! -d "$ROOT_DIR/node_modules" ]]; then
  echo "node_modules missing; installing dependencies via npm ci..."
  npm ci
elif [[ -f "$ROOT_DIR/package-lock.json" ]] && \
     { [[ ! -f "$ROOT_DIR/node_modules/.package-lock.json" ]] || \
       [[ "$ROOT_DIR/package-lock.json" -nt "$ROOT_DIR/node_modules/.package-lock.json" ]]; }; then
  echo "package-lock.json is newer than node_modules/.package-lock.json; syncing via npm ci..."
  npm ci
fi

ensure_meridian_hub_socket

echo "Building meridian-roles..."
npm run build

START_CMD=(npm start)
TMUX_SESSION_NAME="meridian_roles_service_$(id -u)"
new_pid=""
launch_mode="nohup"
health_session_name=""

echo "meridian-roles rebuild_restart: listen_host=${GUI_LISTEN_HOST} gui_port=${GUI_PORT} socket=${ROLES_SOCKET_PATH} hub_socket=${HUB_SOCKET_PATH}" >&2
echo "meridian-roles rebuild_restart: start_command=${START_CMD[*]}" >&2

echo "Starting meridian-roles in background..."
if command -v tmux >/dev/null 2>&1; then
  bootstrap_export=""
  if [[ -n "${MERIDIAN_INTERNAL_BOOTSTRAP_KEY:-}" ]]; then
    bootstrap_export=" MERIDIAN_INTERNAL_BOOTSTRAP_KEY=$(shell_escape "$MERIDIAN_INTERNAL_BOOTSTRAP_KEY")"
  fi
  tmux_command="cd $(shell_escape "$ROOT_DIR") && export GUI_PORT=$(shell_escape "$GUI_PORT") GUI_LISTEN_HOST=$(shell_escape "$GUI_LISTEN_HOST") ROLES_SOCKET_PATH=$(shell_escape "$ROLES_SOCKET_PATH") HUB_SOCKET_PATH=$(shell_escape "$HUB_SOCKET_PATH")${bootstrap_export} && exec npm start >> $(shell_escape "$RUN_LOG") 2>&1"
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

echo "Waiting for meridian-roles to become healthy (http://127.0.0.1:${GUI_PORT}/, socket: ${ROLES_SOCKET_PATH}, hub socket: ${HUB_SOCKET_PATH})..."
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
    if [[ -S "${ROLES_SOCKET_PATH}" ]] && hub_socket_reachable; then
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
