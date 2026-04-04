#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ -n "${MERIDIAN_ROLES_ROOT:-}" ]]; then
  ROLES_ROOT="${MERIDIAN_ROLES_ROOT}"
elif [[ -x "${ROOT_DIR}/Meridian-roles/user_scripts/rebuild_restart.sh" ]]; then
  ROLES_ROOT="${ROOT_DIR}/Meridian-roles"
else
  ROLES_ROOT="${ROOT_DIR}/../meridian-roles"
fi

ROLES_SCRIPT="${ROLES_ROOT}/user_scripts/rebuild_restart.sh"

if [[ ! -x "${ROLES_SCRIPT}" ]]; then
  echo "meridian-roles restart script not found or not executable: ${ROLES_SCRIPT}" >&2
  echo "Set MERIDIAN_ROLES_ROOT if the repo lives elsewhere." >&2
  exit 1
fi

exec "${ROLES_SCRIPT}"
