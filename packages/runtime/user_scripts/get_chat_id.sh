#!/usr/bin/env bash

# One-time helper to fetch Telegram chat_id for this bot conversation.
# It waits for the first *new* incoming message after script start and prints CHAT_ID.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ROOT_DIR}/.env"

if [[ -f "${ENV_FILE}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  set +a
fi

TELEGRAM_BOT_TOKEN="${1:-${TELEGRAM_BOT_TOKEN:-}}"
if [[ -z "${TELEGRAM_BOT_TOKEN}" ]]; then
  echo "TELEGRAM_BOT_TOKEN is not set. Pass it as arg, export it, or put it in .env." >&2
  echo "Usage: $0 <telegram_bot_token_optional>" >&2
  exit 1
fi

if [[ "${TELEGRAM_BOT_TOKEN}" == *"replace_with_real"* ]]; then
  echo "TELEGRAM_BOT_TOKEN looks like a placeholder value. Use the real BotFather token." >&2
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required" >&2
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is required" >&2
  exit 1
fi

API_BASE="https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}"

get_updates() {
  local offset="$1"
  local timeout="$2"
  local url="${API_BASE}/getUpdates?timeout=${timeout}&allowed_updates=%5B%22message%22%5D"
  if [[ "${offset}" != "-" ]]; then
    url="${url}&offset=${offset}"
  fi
  curl --silent --show-error --fail "${url}"
}

echo "Checking current update offset..."
baseline_json="$(get_updates "-" "0")"
last_update_id="$(
  printf '%s' "${baseline_json}" | python3 -c '
import json
import sys
payload = json.load(sys.stdin)
updates = payload.get("result", [])
print(max((u.get("update_id", -1) for u in updates), default=-1))
'
)"

offset=$((last_update_id + 1))
echo "Now send one message to your bot in Telegram, then wait..."

next_json="$(get_updates "${offset}" "120")"

parsed="$(
  printf '%s' "${next_json}" | python3 -c '
import json
import sys
payload = json.load(sys.stdin)
updates = payload.get("result", [])
for item in updates:
    msg = item.get("message") or item.get("edited_message")
    if not msg:
        continue
    chat = msg.get("chat") or {}
    chat_id = chat.get("id")
    if chat_id is None:
        continue
    sender_id = (msg.get("from") or {}).get("id", "")
    username = (msg.get("from") or {}).get("username", "")
    print(f"{chat_id}\t{sender_id}\t{username}")
    break
'
)"

if [[ -z "${parsed}" ]]; then
  echo "No new message detected within 120 seconds. Run again and send a fresh message." >&2
  exit 1
fi

chat_id="$(printf '%s' "${parsed}" | cut -f1)"
sender_id="$(printf '%s' "${parsed}" | cut -f2)"
username="$(printf '%s' "${parsed}" | cut -f3)"

echo "CHAT_ID=${chat_id}"
echo "SENDER_ID=${sender_id}"
if [[ -n "${username}" ]]; then
  echo "SENDER_USERNAME=@${username}"
fi
