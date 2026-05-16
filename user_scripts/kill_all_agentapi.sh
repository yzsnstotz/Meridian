#!/usr/bin/env bash
# Comprehensive kill of every agentapi-managed thread on the host:
#   - all `agentapi server` processes (any --type, any port)
#   - their codex/claude CLI subprocesses
#   - orphan codex/claude CLI processes whose agentapi parent already died
#   - leftover /tmp/agentapi-*.sock and /tmp/agentapi-*.lock files
#
# Idempotent. Safe to invoke when nothing is running — exits 0 with a
# zero-count summary line.
#
# Invoked by user_scripts/terminate.sh (operator "Terminate" button on the
# maintenance hub at http://127.0.0.1:8765/) and by user_scripts/rebuild_restart.sh
# (operator "Restart" button) so every restart starts from a clean process tree.
#
# Usage:
#   ./user_scripts/kill_all_agentapi.sh                  # default
#   ./user_scripts/kill_all_agentapi.sh --sigterm-wait 5 # longer grace period
#   ./user_scripts/kill_all_agentapi.sh --dry-run        # list, do not kill

set -uo pipefail

SIGTERM_WAIT=2
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --sigterm-wait)
      shift
      SIGTERM_WAIT="${1:-2}"
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h|--help)
      sed -n '2,16p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

log() {
  printf '[kill_all_agentapi] %s\n' "$*"
}

# Resolve a comma-free list of PIDs matching a pattern. Uses `ps + grep` rather
# than `pgrep` so we get the full argv for verification and avoid pgrep's
# implicit "match against process name only on some platforms" surprise.
pids_matching() {
  local pattern="$1"
  ps -A -o pid,command \
    | grep -E "$pattern" \
    | grep -v grep \
    | awk '{print $1}' \
    | sort -u
}

# All agentapi server processes (any --type, any port, any socket path).
agentapi_pids=$(pids_matching 'agentapi[[:space:]]+server|/bin/agentapi[[:space:]]+server')

# Children of those processes (the codex/claude CLI subprocesses).
codex_child_pids=""
if [[ -n "${agentapi_pids}" ]]; then
  for parent_pid in ${agentapi_pids}; do
    children=$(pgrep -P "${parent_pid}" 2>/dev/null || true)
    if [[ -n "${children}" ]]; then
      codex_child_pids="${codex_child_pids} ${children}"
    fi
  done
fi
codex_child_pids=$(echo "${codex_child_pids}" | tr ' ' '\n' | sort -u | tr '\n' ' ' | sed 's/^ *//;s/ *$//')

# Orphan codex/claude CLI processes (PPID == 1) that aren't already in our
# child set. These are the leftover agentapi children whose agentapi parent
# already exited but the CLI subprocess survives (the failure mode documented
# at src/roles/agent-dispatcher/active-tool-process.ts:39).
orphan_pids=""
while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  pid=$(echo "$line" | awk '{print $1}')
  ppid=$(echo "$line" | awk '{print $2}')
  [[ "${ppid}" != "1" ]] && continue
  case " ${codex_child_pids} ${agentapi_pids} " in
    *" ${pid} "*) continue ;;
  esac
  orphan_pids="${orphan_pids} ${pid}"
done < <(ps -A -o pid,ppid,command | grep -E '(codex|claude)[[:space:]].*--model' | grep -v grep)
orphan_pids=$(echo "${orphan_pids}" | tr ' ' '\n' | sort -u | tr '\n' ' ' | sed 's/^ *//;s/ *$//')

all_targets="${agentapi_pids} ${codex_child_pids} ${orphan_pids}"
all_targets=$(echo "${all_targets}" | tr ' ' '\n' | sort -nu | tr '\n' ' ' | sed 's/^ *//;s/ *$//')

agentapi_count=$(echo "${agentapi_pids}" | wc -w | tr -d ' ')
codex_count=$(echo "${codex_child_pids}" | wc -w | tr -d ' ')
orphan_count=$(echo "${orphan_pids}" | wc -w | tr -d ' ')

if [[ -z "${all_targets}" ]]; then
  # Even with no live processes, sweep stale sockets — they block re-bind.
  sockets_removed=0
  shopt -s nullglob
  for sock in /tmp/agentapi-*.sock /tmp/agentapi-*.lock; do
    if [[ "${DRY_RUN}" -eq 1 ]]; then
      log "DRY-RUN would remove ${sock}"
    else
      rm -f "${sock}" && sockets_removed=$((sockets_removed + 1))
    fi
  done
  shopt -u nullglob
  printf '[kill_all_agentapi] summary: killed agentapi=0 codex=0 orphan=0 sockets_removed=%d\n' "${sockets_removed}"
  exit 0
fi

if [[ "${DRY_RUN}" -eq 1 ]]; then
  log "DRY-RUN agentapi=${agentapi_count} codex=${codex_count} orphan=${orphan_count}"
  log "DRY-RUN would SIGTERM PIDs: ${all_targets}"
  printf '[kill_all_agentapi] summary: killed agentapi=%d codex=%d orphan=%d sockets_removed=0 (DRY-RUN)\n' \
    "${agentapi_count}" "${codex_count}" "${orphan_count}"
  exit 0
fi

# Phase 1: SIGTERM.
log "SIGTERM agentapi=${agentapi_count} codex=${codex_count} orphan=${orphan_count} pids=${all_targets}"
for pid in ${all_targets}; do
  kill -TERM "${pid}" >/dev/null 2>&1 || true
done

sleep "${SIGTERM_WAIT}"

# Phase 2: SIGKILL stragglers.
stragglers=""
for pid in ${all_targets}; do
  if kill -0 "${pid}" >/dev/null 2>&1; then
    stragglers="${stragglers} ${pid}"
  fi
done
stragglers=$(echo "${stragglers}" | tr ' ' '\n' | sort -nu | tr '\n' ' ' | sed 's/^ *//;s/ *$//')
if [[ -n "${stragglers}" ]]; then
  log "SIGKILL stragglers: ${stragglers}"
  for pid in ${stragglers}; do
    kill -KILL "${pid}" >/dev/null 2>&1 || true
  done
fi

# Phase 3: clean up sockets and lockfiles.
sockets_removed=0
shopt -s nullglob
for sock in /tmp/agentapi-*.sock /tmp/agentapi-*.lock; do
  rm -f "${sock}" && sockets_removed=$((sockets_removed + 1))
done
shopt -u nullglob

printf '[kill_all_agentapi] summary: killed agentapi=%d codex=%d orphan=%d sockets_removed=%d\n' \
  "${agentapi_count}" "${codex_count}" "${orphan_count}" "${sockets_removed}"
