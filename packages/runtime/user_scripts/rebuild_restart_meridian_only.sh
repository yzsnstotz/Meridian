#!/usr/bin/env bash

# Rebuild and restart ONLY the Meridian runtime (calling-hub/interface/monitor/web).
# Does not touch meridian-roles — use ./user_scripts/rebuild_restart.sh for the full chain,
# or Meridian-roles/user_scripts/rebuild_restart.sh for the roles service alone.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

export MERIDIAN_REBUILD_SKIP_ROLES=1
export MERIDIAN_TERMINATE_SKIP_ROLES=1

exec "${ROOT_DIR}/user_scripts/rebuild_restart.sh" "$@"
