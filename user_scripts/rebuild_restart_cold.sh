#!/usr/bin/env bash
# Rebuild meridian-roles and reset its persisted state before relaunching.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd -P)"

exec "${ROOT_DIR}/user_scripts/rebuild_restart.sh" --reset-state
