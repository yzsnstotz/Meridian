#!/usr/bin/env bash

set -euo pipefail

LOG_DIR="${LOG_DIR:-/var/log/hub}"
SOCKET_PATH="${HUB_SOCKET_PATH:-/tmp/hub-socks/hub-core.sock}"
SOCKET_DIR="$(dirname "${SOCKET_PATH}")"
RUNTIME_USER="${RUNTIME_USER:-${SUDO_USER:-$(id -un)}}"
RUNTIME_GROUP="${RUNTIME_GROUP:-$(id -gn "${RUNTIME_USER}" 2>/dev/null || id -gn)}"

if [[ "${LOG_DIR}" == /var/log/* ]] && [[ "$(id -u)" -ne 0 ]]; then
  echo "LOG_DIR=${LOG_DIR} needs root permission. Re-run with sudo." >&2
  exit 1
fi

install -d -m 0775 "${LOG_DIR}"
install -d -m 0775 "${SOCKET_DIR}"

for log_file in hub.log hub-error.log interface.log interface-error.log monitor.log monitor-error.log instance.log; do
  touch "${LOG_DIR}/${log_file}"
done

if [[ "$(id -u)" -eq 0 ]]; then
  chown "${RUNTIME_USER}:${RUNTIME_GROUP}" "${LOG_DIR}" "${SOCKET_DIR}"
  chown "${RUNTIME_USER}:${RUNTIME_GROUP}" "${LOG_DIR}"/*.log
fi

echo "Host runtime directories are ready."
echo "LOG_DIR=${LOG_DIR}"
echo "SOCKET_DIR=${SOCKET_DIR}"
echo "RUNTIME_USER=${RUNTIME_USER}"
