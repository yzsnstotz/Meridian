#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENTAPI_BIN="${ROOT_DIR}/bin/agentapi"

if [[ ! -x "${AGENTAPI_BIN}" ]]; then
  echo "agentapi binary not found or not executable: ${AGENTAPI_BIN}" >&2
  exit 1
fi

TYPE="${1:-codex}"
MODE="${2:-bridge}"
THREAD_ID="${3:-${TYPE}_$(date +%s)}"

case "${TYPE}" in
  claude) CLI_CMD="claude" ;;
  codex) CLI_CMD="codex" ;;
  gemini) CLI_CMD="gemini" ;;
  cursor) CLI_CMD="cursor-agent" ;;
  *)
    echo "Unsupported agent type: ${TYPE} (expected: claude|codex|gemini|cursor)" >&2
    exit 1
    ;;
esac

case "${MODE}" in
  bridge|pane_bridge) ;;
  *)
    echo "Unsupported mode: ${MODE} (expected: bridge|pane_bridge)" >&2
    exit 1
    ;;
esac

SOCKET_PATH="/tmp/agentapi-${THREAD_ID}.sock"
PID_PATH="/tmp/agentapi-${THREAD_ID}.pid"
LOG_DIR="${LOG_DIR:-/tmp}"
LOG_PATH="${LOG_DIR}/agentapi-${THREAD_ID}.log"

mkdir -p "${LOG_DIR}"
rm -f "${SOCKET_PATH}"

ARGS=("server" "--type=${TYPE}")
if [[ "${MODE}" == "pane_bridge" ]]; then
  SESSION_NAME="agent_${THREAD_ID}"
  tmux new-session -d -s "${SESSION_NAME}" || true
  ARGS+=("--tmux-session=${SESSION_NAME}")
else
  SESSION_NAME=""
fi
ARGS+=("--" "${CLI_CMD}")

echo "Spawning agent instance"
echo "  type       : ${TYPE}"
echo "  mode       : ${MODE}"
echo "  thread_id  : ${THREAD_ID}"
echo "  socket     : ${SOCKET_PATH}"
echo "  log        : ${LOG_PATH}"

AGENTAPI_SOCKET_PATH="${SOCKET_PATH}" "${AGENTAPI_BIN}" "${ARGS[@]}" >>"${LOG_PATH}" 2>&1 &
PID=$!
echo "${PID}" > "${PID_PATH}"

echo "Spawned PID=${PID}"
echo "PID file: ${PID_PATH}"
if [[ -n "${SESSION_NAME}" ]]; then
  echo "tmux session: ${SESSION_NAME}"
fi
