#!/usr/bin/env bash

# Verify monitor crash alert: spawn → kill -9 → check for Telegram alert.
# Usage: ./user_scripts/verify_monitor_alert.sh [ALERT_TIMEOUT_SEC]
#
# Prerequisites:
#   - Hub + monitor services running (./user_scripts/restart.sh)
#   - Telegram bot configured and reachable
#
# The script spawns a codex instance via the hub, attaches the current
# Telegram chat, kills the process with SIGKILL, then checks monitor.log
# for the expected alert event within the timeout window.

set -euo pipefail

ALERT_TIMEOUT_SEC="${1:-30}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HUB_SOCKET="${HUB_SOCKET_PATH:-/tmp/hub-core.sock}"
LOG_DIR="${LOG_DIR:-/var/log/hub}"
MONITOR_LOG=""

for candidate in "${LOG_DIR}/monitor.log" "/var/log/hub/monitor.log" "${ROOT_DIR}/logs/monitor.log"; do
  if [[ -f "${candidate}" ]]; then
    MONITOR_LOG="${candidate}"
    break
  fi
done

if [[ -z "${MONITOR_LOG}" ]]; then
  echo "[error] No monitor.log found. Checked ${LOG_DIR}, /var/log/hub, ${ROOT_DIR}/logs." >&2
  exit 1
fi

echo "[info] Using monitor log: ${MONITOR_LOG}"
echo "[info] Alert timeout: ${ALERT_TIMEOUT_SEC}s"

# Record the line count before spawn so we only search new entries.
LOG_OFFSET=$(wc -l < "${MONITOR_LOG}" | tr -d ' ')

# Step 1: Spawn a codex instance.
echo ""
echo "=== Step 1: Spawning codex instance ==="
SPAWN_RESULT=$(echo '{"trace_id":"'$(uuidgen | tr '[:upper:]' '[:lower:]')'","thread_id":"global","actor_id":"verify_script","intent":"spawn","target":"codex","payload":{"content":"type=codex mode=bridge","attachments":[],"reply_to":null},"mode":"bridge","suppress_reply":true,"reply_channel":{"channel":"telegram","chat_id":"verify"}}' \
  | socat - UNIX-CONNECT:"${HUB_SOCKET}")

echo "[spawn] Hub response: ${SPAWN_RESULT}"

THREAD_ID=$(echo "${SPAWN_RESULT}" | python3 -c "import sys,json; print(json.load(sys.stdin).get('thread_id',''))" 2>/dev/null || echo "")

if [[ -z "${THREAD_ID}" || "${THREAD_ID}" == "global" ]]; then
  echo "[error] Failed to extract thread_id from spawn result." >&2
  exit 1
fi
echo "[success] Spawned thread_id=${THREAD_ID}"

# Step 2: Retrieve PID from instance status.
sleep 1
STATUS_RESULT=$(echo '{"trace_id":"'$(uuidgen | tr '[:upper:]' '[:lower:]')'","thread_id":"'"${THREAD_ID}"'","actor_id":"verify_script","intent":"status","target":"codex","payload":{"content":"","attachments":[],"reply_to":null},"mode":"bridge","suppress_reply":true,"reply_channel":{"channel":"telegram","chat_id":"verify"}}' \
  | socat - UNIX-CONNECT:"${HUB_SOCKET}")

PID=$(echo "${STATUS_RESULT}" | python3 -c "
import sys, json, re
data = json.load(sys.stdin)
content = data.get('content', '')
# Try parsing as JSON first
try:
    parsed = json.loads(content)
    inst = parsed.get('instance', parsed)
    print(inst.get('pid', ''))
except:
    # Fallback: extract pid from text
    m = re.search(r'pid[=: ]+(\d+)', content)
    print(m.group(1) if m else '')
" 2>/dev/null || echo "")

if [[ -z "${PID}" ]]; then
  echo "[error] Failed to extract PID from status. Response: ${STATUS_RESULT}" >&2
  # Try list instead
  LIST_RESULT=$(echo '{"trace_id":"'$(uuidgen | tr '[:upper:]' '[:lower:]')'","thread_id":"global","actor_id":"verify_script","intent":"list","target":"all","payload":{"content":"","attachments":[],"reply_to":null},"mode":"bridge","suppress_reply":true,"reply_channel":{"channel":"telegram","chat_id":"verify"}}' \
    | socat - UNIX-CONNECT:"${HUB_SOCKET}")

  PID=$(echo "${LIST_RESULT}" | python3 -c "
import sys, json
data = json.load(sys.stdin)
content = data.get('content', '')
try:
    instances = json.loads(content)
    for inst in instances:
        if inst.get('thread_id') == '${THREAD_ID}':
            print(inst.get('pid', ''))
            break
except:
    pass
" 2>/dev/null || echo "")

  if [[ -z "${PID}" ]]; then
    echo "[error] Could not determine PID for ${THREAD_ID}." >&2
    exit 1
  fi
fi

echo "[info] Instance PID: ${PID}"

# Step 3: Kill the process with SIGKILL (simulate crash).
echo ""
echo "=== Step 2: Killing process ${PID} with SIGKILL ==="
kill -9 "${PID}" 2>/dev/null || true
sleep 0.5

# Verify the process is dead.
if kill -0 "${PID}" 2>/dev/null; then
  echo "[error] PID ${PID} is still running after SIGKILL." >&2
  exit 1
fi
echo "[success] PID ${PID} confirmed dead."

# Step 4: Wait for alert in monitor.log.
echo ""
echo "=== Step 3: Waiting up to ${ALERT_TIMEOUT_SEC}s for monitor alert ==="
DEADLINE=$((SECONDS + ALERT_TIMEOUT_SEC))
ALERT_FOUND=false

while [[ ${SECONDS} -lt ${DEADLINE} ]]; do
  # Check new lines in monitor.log since spawn
  NEW_LINES=$(tail -n +"$((LOG_OFFSET + 1))" "${MONITOR_LOG}" 2>/dev/null || true)

  if echo "${NEW_LINES}" | grep -q "\"thread_id\":\"${THREAD_ID}\"" && \
     echo "${NEW_LINES}" | grep -q '"event_type":"agent_error"'; then
    ALERT_FOUND=true
    break
  fi

  sleep 1
done

echo ""
if ${ALERT_FOUND}; then
  echo "=== RESULT: PASS ==="
  echo "[success] Monitor alert detected for thread=${THREAD_ID} within ${SECONDS}s."
  echo ""
  echo "--- Alert log entries ---"
  tail -n +"$((LOG_OFFSET + 1))" "${MONITOR_LOG}" \
    | grep "\"thread_id\":\"${THREAD_ID}\"" \
    | grep '"event_type":"agent_error"' \
    | head -3
else
  echo "=== RESULT: FAIL ==="
  echo "[error] No monitor alert detected for thread=${THREAD_ID} within ${ALERT_TIMEOUT_SEC}s." >&2
  echo ""
  echo "--- Recent monitor.log entries ---"
  tail -n +"$((LOG_OFFSET + 1))" "${MONITOR_LOG}" | tail -20
  exit 1
fi

# Step 5: Cleanup - kill the zombie instance.
echo ""
echo "=== Cleanup ==="
echo '{"trace_id":"'$(uuidgen | tr '[:upper:]' '[:lower:]')'","thread_id":"'"${THREAD_ID}"'","actor_id":"verify_script","intent":"kill","target":"codex","payload":{"content":"","attachments":[],"reply_to":null},"mode":"bridge","suppress_reply":true,"reply_channel":{"channel":"telegram","chat_id":"verify"}}' \
  | socat - UNIX-CONNECT:"${HUB_SOCKET}" >/dev/null 2>&1 || true
echo "[done] Cleanup complete."
