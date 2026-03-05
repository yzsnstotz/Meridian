#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_FILE="${ROOT_DIR}/deploy/logrotate/meridian"
TARGET_FILE="${LOGROTATE_TARGET:-/etc/logrotate.d/meridian}"
TARGET_DIR="$(dirname "${TARGET_FILE}")"

if [[ ! -f "${SOURCE_FILE}" ]]; then
  echo "Missing source logrotate file: ${SOURCE_FILE}" >&2
  exit 1
fi

if [[ ! -w "${TARGET_DIR}" ]]; then
  echo "No write permission for ${TARGET_DIR}. Re-run with sudo." >&2
  exit 1
fi

install -m 0644 "${SOURCE_FILE}" "${TARGET_FILE}"
echo "Installed: ${TARGET_FILE}"
