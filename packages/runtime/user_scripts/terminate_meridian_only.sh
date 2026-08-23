#!/usr/bin/env bash

# Terminate ONLY the Meridian runtime. Does not touch meridian-roles —
# use ./user_scripts/terminate.sh for the full pair, or
# Meridian-roles/user_scripts/terminate.sh for the roles service alone.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

export MERIDIAN_TERMINATE_SKIP_ROLES=1

exec "${ROOT_DIR}/user_scripts/terminate.sh" "$@"
