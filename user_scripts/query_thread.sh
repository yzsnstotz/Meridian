#!/usr/bin/env bash

# Query all hub/interface/monitor log entries for a given thread_id.
# Usage: ./user_scripts/query_thread.sh <thread_id>
#
# Output format: timestamp | trace_id | intent | status | content_preview

set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <thread_id>" >&2
  exit 1
fi

THREAD_ID="$1"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="${LOG_DIR:-/var/log/hub}"
TMP_MATCHES="$(mktemp /tmp/meridian-thread.XXXXXX)"

cleanup() {
  rm -f "${TMP_MATCHES}"
}
trap cleanup EXIT

resolve_log_file() {
  local filename="$1"
  local candidates=(
    "${LOG_DIR}/${filename}"
    "/var/log/hub/${filename}"
    "${ROOT_DIR}/logs/${filename}"
  )

  local path
  for path in "${candidates[@]}"; do
    if [[ -f "${path}" ]]; then
      printf '%s\n' "${path}"
      return 0
    fi
  done
  return 1
}

append_matches() {
  local file="$1"
  rg --no-heading --line-number --fixed-strings "\"thread_id\":\"${THREAD_ID}\"" "${file}" \
    | sed "s|^|${file}:|" >>"${TMP_MATCHES}" || true
  # Also match Pino key-value style (thread_id=value)
  rg --no-heading --line-number --fixed-strings "thread_id=${THREAD_ID}" "${file}" \
    | sed "s|^|${file}:|" >>"${TMP_MATCHES}" || true
}

hub_log="$(resolve_log_file "hub.log" || true)"
interface_log="$(resolve_log_file "interface.log" || true)"
monitor_log="$(resolve_log_file "monitor.log" || true)"

if [[ -z "${hub_log}" && -z "${interface_log}" && -z "${monitor_log}" ]]; then
  echo "No log files found. Checked LOG_DIR=${LOG_DIR}, /var/log/hub, and ${ROOT_DIR}/logs." >&2
  exit 1
fi

[[ -n "${hub_log}" ]] && append_matches "${hub_log}"
[[ -n "${interface_log}" ]] && append_matches "${interface_log}"
[[ -n "${monitor_log}" ]] && append_matches "${monitor_log}"

if [[ ! -s "${TMP_MATCHES}" ]]; then
  echo "No entries found for thread_id=${THREAD_ID}"
  exit 0
fi

python3 - "${TMP_MATCHES}" "${THREAD_ID}" <<'PY'
import json
import os
import re
import sys
from datetime import datetime

path = sys.argv[1]
thread_id = sys.argv[2]
line_pattern = re.compile(r"^(.*?):(\d+):(.*)$")

def parse_iso(ts):
    if not ts:
        return None
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None

def truncate(text, max_len=80):
    if not text:
        return "-"
    text = text.replace("\n", " ").strip()
    if len(text) <= max_len:
        return text
    return text[:max_len - 3] + "..."

rows = []
seen = set()
with open(path, "r", encoding="utf-8", errors="replace") as fh:
    for raw in fh:
        raw = raw.rstrip("\n")
        m = line_pattern.match(raw)
        if not m:
            continue
        file_path, line_no, content = m.group(1), m.group(2), m.group(3)

        dedup_key = (file_path, line_no)
        if dedup_key in seen:
            continue
        seen.add(dedup_key)

        stripped = content.lstrip()
        timestamp = "-"
        trace_id = "-"
        intent = "-"
        status = "-"
        preview = "-"

        if stripped.startswith("{") and stripped.endswith("}"):
            try:
                payload = json.loads(stripped)
                # Only include entries matching the requested thread_id
                if payload.get("thread_id") != thread_id:
                    continue

                for key in ("timestamp", "time", "ts"):
                    value = payload.get(key)
                    if isinstance(value, str):
                        timestamp = value
                        break
                    if isinstance(value, (int, float)) and value > 1e12:
                        timestamp = datetime.fromtimestamp(value / 1000).isoformat() + "Z"
                        break
                    if isinstance(value, (int, float)):
                        timestamp = datetime.fromtimestamp(value).isoformat() + "Z"
                        break

                trace_id = payload.get("trace_id") or "-"
                intent = payload.get("intent") or payload.get("event_type") or "-"
                status = (
                    payload.get("status")
                    or payload.get("result_status")
                    or payload.get("dispatch_status")
                    or payload.get("agent_status")
                    or "-"
                )
                preview = truncate(
                    payload.get("msg")
                    or payload.get("message")
                    or payload.get("content")
                    or ""
                )
            except json.JSONDecodeError:
                continue
        else:
            continue

        epoch = parse_iso(timestamp) if timestamp != "-" else None
        rows.append({
            "epoch": epoch,
            "timestamp": timestamp,
            "trace_id": trace_id,
            "intent": intent,
            "status": status,
            "preview": preview,
        })

rows.sort(key=lambda r: (r["epoch"] is None, r["epoch"] or 0))

if not rows:
    print(f"No structured entries found for thread_id={thread_id}")
    sys.exit(0)

print(f"# Thread timeline: {thread_id} ({len(rows)} event(s))")
print(f"{'timestamp':<28} | {'trace_id':<36} | {'intent':<20} | {'status':<10} | preview")
print("-" * 130)
for r in rows:
    ts = r["timestamp"][:27] if len(r["timestamp"]) > 27 else r["timestamp"]
    tid = r["trace_id"][:36] if len(r["trace_id"]) > 36 else r["trace_id"]
    print(f"{ts:<28} | {tid:<36} | {r['intent']:<20} | {r['status']:<10} | {r['preview']}")
PY
