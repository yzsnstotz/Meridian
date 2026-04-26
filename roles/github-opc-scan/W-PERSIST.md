### W-PERSIST - Snapshot And Lifecycle Finalization

- **Runtime**: Local CLI
- **Delta Type**: NEW
- **Phase**: 0
- **Priority**: P0
- **Depends on**: W-CLASSIFY
- **Model**: CODEX-HIGH

#### Required Context

Runs the `github-ai-automation-scan persist` subcommand to finalize current state, snapshots, scan summary, and lifecycle rows for the current Phase 0 run.

- **CLI command**: `github-ai-automation-scan persist`
- **Database**: `/Volumes/Elements/github-ai-automation-solutions/github-ai-automation-solutions.db`
- **Work dir**: `/tmp/github-opc-scan/${SCAN_RUN_ID}/`
- **Output dir**: `/Users/yzliu/work/Docs/Projects/routine-job/github-opc-solution-scan/output/${SCAN_RUN_ID}`
- **Rate limit**: not applicable; uses local DB/artifacts
- **JSON summary**: top-level `status`, `subcommand`, `scan_run_id`, `result`; `status == "warn"` is acceptable when `result.integrity_warnings` is non-empty and exit code is 0

#### Sub-tasks

**W-PERSIST.1 - Determine SCAN_RUN_ID**
- Compute `SCAN_RUN_ID` as `daily-YYYY-MM-DD` using today's date in the scheduler timezone.
- Verify W-CLASSIFY completed for the same run.
- **Acceptance**: Classification data exists for the current run.

**W-PERSIST.2 - Execute persist**
- Run:
  ```bash
  github-ai-automation-scan persist \
    --scan-run-id "${SCAN_RUN_ID}" \
    --db /Volumes/Elements/github-ai-automation-solutions/github-ai-automation-solutions.db \
    --work-dir "/tmp/github-opc-scan/${SCAN_RUN_ID}/" \
    --output-dir "/Users/yzliu/work/Docs/Projects/routine-job/github-opc-solution-scan/output/${SCAN_RUN_ID}" \
    --format json
  ```
- **Acceptance**: Exit code 0 and `persist_summary.json` exists.

**W-PERSIST.3 - Validate JSON summary**
- Parse stdout as JSON.
- Require `status` in `["ok", "warn"]`, `subcommand == "persist"`, matching `scan_run_id`, `result.scan_run_status == "completed"`, and result keys `snapshots_written`, `integrity_status`, `summary`.
- **Acceptance**: JSON summary is valid and scan run is finalized.

#### AI Auto-Tests

```bash
set -euo pipefail
SCAN_RUN_ID="daily-$(TZ=Asia/Tokyo date +%Y-%m-%d)"
WORK_DIR="/tmp/github-opc-scan/${SCAN_RUN_ID}"
OUTPUT_DIR="/Users/yzliu/work/Docs/Projects/routine-job/github-opc-solution-scan/output/${SCAN_RUN_ID}"
DB="/Volumes/Elements/github-ai-automation-solutions/github-ai-automation-solutions.db"

github-ai-automation-scan persist \
  --scan-run-id "${SCAN_RUN_ID}" \
  --db "${DB}" \
  --work-dir "${WORK_DIR}/" \
  --output-dir "${OUTPUT_DIR}" \
  --format json > "${WORK_DIR}/persist.summary.json"

python3 - <<'PY' "${WORK_DIR}/persist.summary.json" "${OUTPUT_DIR}/persist_summary.json" "${SCAN_RUN_ID}"
import json, sys
payload = json.load(open(sys.argv[1], encoding="utf-8"))
assert payload["status"] in {"ok", "warn"}
assert payload["subcommand"] == "persist"
assert payload["scan_run_id"] == sys.argv[3]
assert payload["result"]["scan_run_status"] == "completed"
for key in ("snapshots_written", "integrity_status", "summary"):
    assert key in payload["result"], key
summary = json.load(open(sys.argv[2], encoding="utf-8"))
assert summary["scan_run_status"] == "completed"
print("OK: persist summary valid")
PY
```

#### Completion Protocol

After successful execution:
1. Report the JSON summary path, exit code, snapshot counts, integrity status, and warnings if any.
2. Mark the runtime dispatch row complete according to the routine-job lifecycle store.
3. Stop session immediately.
