#!/usr/bin/env bash

# Rebuild Meridian and restart runtime services.
# Usage: ./user_scripts/rebuild_restart.sh

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

log() {
  printf '[rebuild_restart] %s\n' "$1"
}

sync_origin_main() {
  if [[ "${MERIDIAN_REBUILD_SKIP_GIT_SYNC:-}" == "1" ]]; then
    log "Skipping origin/main sync (MERIDIAN_REBUILD_SKIP_GIT_SYNC=1)"
    return 0
  fi

  if ! command -v git >/dev/null 2>&1; then
    echo "git is required to sync origin/main before rebuild" >&2
    exit 1
  fi

  (
    cd "${ROOT_DIR}"
    git rev-parse --is-inside-work-tree >/dev/null
  )

  local dirty
  dirty="$(cd "${ROOT_DIR}" && git status --porcelain --untracked-files=no)"
  if [[ -n "${dirty}" ]]; then
    echo "Refusing to rebuild Meridian from a tracked-dirty checkout; source must be origin/main." >&2
    printf '%s\n' "${dirty}" >&2
    exit 1
  fi

  local before target after
  before="$(cd "${ROOT_DIR}" && git rev-parse HEAD)"

  log "Fetching origin/main"
  (
    cd "${ROOT_DIR}"
    git fetch origin main --prune
    target="$(git rev-parse FETCH_HEAD)"
    git merge --ff-only FETCH_HEAD
    after="$(git rev-parse HEAD)"

    if [[ "${after}" != "${target}" ]]; then
      echo "Refusing to rebuild Meridian: HEAD ${after} does not match origin/main ${target}" >&2
      exit 1
    fi
  )

  after="$(cd "${ROOT_DIR}" && git rev-parse HEAD)"
  dirty="$(cd "${ROOT_DIR}" && git status --porcelain --untracked-files=no)"
  if [[ -n "${dirty}" ]]; then
    echo "Refusing to rebuild Meridian from a tracked-dirty checkout after origin/main sync." >&2
    printf '%s\n' "${dirty}" >&2
    exit 1
  fi

  if [[ "${before}" != "${after}" && "${MERIDIAN_REBUILD_ORIGIN_MAIN_SYNCED:-}" != "1" ]]; then
    log "Checkout updated to origin/main; re-executing rebuild script from the new source"
    export MERIDIAN_REBUILD_ORIGIN_MAIN_SYNCED=1
    exec "${ROOT_DIR}/user_scripts/rebuild_restart.sh" "$@"
  fi

  log "Source commit: $(cd "${ROOT_DIR}" && git rev-parse --short HEAD)"
}

sync_origin_main "$@"

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required" >&2
  exit 1
fi

log "Building project"
(
  cd "${ROOT_DIR}"
  npm run build
)

# Always tear down stragglers before relaunching. Without this, restart inherits
# any agentapi/codex processes from the previous generation, including ones the
# previous service crashed and left orphaned. terminate.sh now delegates the
# agentapi sweep to kill_all_agentapi.sh.
log "Terminating previous-generation services and stragglers"
"${ROOT_DIR}/user_scripts/terminate.sh" || true

log "Restarting services"
"${ROOT_DIR}/user_scripts/restart.sh"

if [[ -n "${MERIDIAN_REBUILD_SKIP_ROLES:-}" ]]; then
  log "Skipping meridian-roles restart (MERIDIAN_REBUILD_SKIP_ROLES set)"
else
  log "Restarting meridian-roles"
  # MERIDIAN_HUB_ALREADY_RESTARTED tells meridian-roles/user_scripts/rebuild_restart.sh
  # not to recursively re-invoke this Meridian restart from ensure_meridian_hub_socket
  # (the cascade documented as the hang suspect in
  # maintenance-hub-restart-pm2-and-socket-race.md's open follow-up).
  MERIDIAN_HUB_ALREADY_RESTARTED=1 "${ROOT_DIR}/user_scripts/restart_meridian_roles.sh"
fi

log "Done"
