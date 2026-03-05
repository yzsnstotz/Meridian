#!/usr/bin/env bash

# Verify one trace_id across hub/interface/monitor logs.
# Usage: ./user_scripts/verify_logs.sh <trace_id>

set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <trace_id>" >&2
  exit 1
fi

TRACE_ID="$1"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="${LOG_DIR:-/var/log/hub}"
TMP_MATCHES="$(mktemp /tmp/meridian-trace.XXXXXX)"

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
  rg --no-heading --line-number --fixed-strings "${TRACE_ID}" "${file}" \
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
  echo "No entries found for trace_id=${TRACE_ID}"
  exit 0
fi

python3 - "${TMP_MATCHES}" <<'PY'
import json
import os
import re
import sys
from datetime import datetime

path = sys.argv[1]
iso_pattern = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z")
line_pattern = re.compile(r"^(.*?):(\d+):(.*)$")

def parse_iso(ts):
    if not ts:
        return None
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None

rows = []
with open(path, "r", encoding="utf-8", errors="replace") as fh:
    for idx, raw in enumerate(fh):
        raw = raw.rstrip("\n")
        m = line_pattern.match(raw)
        if not m:
            continue
        file_path, line_no, content = m.group(1), m.group(2), m.group(3)
        module = os.path.basename(file_path).replace(".log", "")
        timestamp = None

        stripped = content.lstrip()
        if stripped.startswith("{") and stripped.endswith("}"):
            try:
                payload = json.loads(stripped)
                for key in ("timestamp", "time", "ts"):
                    value = payload.get(key)
                    if isinstance(value, str):
                        timestamp = value
                        break
            except json.JSONDecodeError:
                pass

        if timestamp is None:
            match = iso_pattern.search(content)
            if match:
                timestamp = match.group(0)

        epoch = parse_iso(timestamp)
        rows.append(
            {
                "idx": idx,
                "epoch": epoch,
                "timestamp": timestamp or "-",
                "module": module,
                "file_path": file_path,
                "line_no": line_no,
                "content": content,
            }
        )

rows.sort(key=lambda r: (r["epoch"] is None, r["epoch"] or 0, r["idx"]))

print(f"# Trace timeline: {len(rows)} event(s)")
for r in rows:
    print(f'[{r["timestamp"]}] [{r["module"]}] {r["file_path"]}:{r["line_no"]}')
    print(r["content"])
PY
