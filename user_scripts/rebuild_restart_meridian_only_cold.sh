#!/usr/bin/env bash

# Rebuild and cold-restart ONLY the Meridian runtime. This resets persisted Hub
# state and agent sockets/processes, while still leaving meridian-roles to its
# own maintenance card.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

export MERIDIAN_REBUILD_SKIP_ROLES=1
export MERIDIAN_TERMINATE_SKIP_ROLES=1

exec "${ROOT_DIR}/user_scripts/rebuild_restart.sh" --reset-state
