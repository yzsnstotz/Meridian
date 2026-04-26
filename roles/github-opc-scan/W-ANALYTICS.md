### W-ANALYTICS - Dashboard Data And Metrics

- **Runtime**: Local CLI
- **Delta Type**: NEW
- **Phase**: 0
- **Priority**: P0
- **Depends on**: W-PERSIST
- **Model**: CODEX-HIGH

#### Required Context

Runs the `github-ai-automation-scan analytics` subcommand to generate dashboard data, leaderboards, rejected-by-severity views, and Phase 0 metrics including `false_positive_rate_top50`.

- **CLI command**: `github-ai-automation-scan analytics`
- **Database**: `/Volumes/Elements/github-ai-automation-solutions/github-ai-automation-solutions.db`
- **Work dir**: `/tmp/github-opc-scan/${SCAN_RUN_ID}/`
- **Output dir**: `/Users/yzliu/work/Docs/Projects/routine-job/github-opc-solution-scan/output/${SCAN_RUN_ID}`
- **Rate limit**: not applicable; uses local DB/artifacts
- **JSON summary**: top-level `status`, `subcommand`, `scan_run_id`, `result`; result includes `leaderboards_written` and `false_positive_rate_top50`

#### Sub-tasks

**W-ANALYTICS.1 - Determine SCAN_RUN_ID**
- Compute `SCAN_RUN_ID` as `daily-YYYY-MM-DD` using today's date in the scheduler timezone.
- Verify W-PERSIST completed for the same run.
- **Acceptance**: Persist summary exists for the run.

**W-ANALYTICS.2 - Execute analytics**
- Run:
  ```bash
  github-ai-automation-scan analytics \
    --scan-run-id "${SCAN_RUN_ID}" \
    --db /Volumes/Elements/github-ai-automation-solutions/github-ai-automation-solutions.db \
    --work-dir "/tmp/github-opc-scan/${SCAN_RUN_ID}/" \
    --output-dir "/Users/yzliu/work/Docs/Projects/routine-job/github-opc-solution-scan/output/${SCAN_RUN_ID}" \
    --format json
  ```
- **Acceptance**: Exit code 0 and metrics/leaderboard files are written under the output directory.

**W-ANALYTICS.3 - Validate JSON summary**
- Parse stdout as JSON.
- Require `status == "ok"`, `subcommand == "analytics"`, matching `scan_run_id`, and result keys `leaderboards_written`, `false_positive_rate_top50`.
- **Acceptance**: JSON summary is valid and metrics file contains `false_positive_rate_top50`.

#### AI Auto-Tests

```bash
set -euo pipefail
SCAN_RUN_ID="daily-$(TZ=Asia/Tokyo date +%Y-%m-%d)"
WORK_DIR="/tmp/github-opc-scan/${SCAN_RUN_ID}"
OUTPUT_DIR="/Users/yzliu/work/Docs/Projects/routine-job/github-opc-solution-scan/output/${SCAN_RUN_ID}"
DB="/Volumes/Elements/github-ai-automation-solutions/github-ai-automation-solutions.db"

github-ai-automation-scan analytics \
  --scan-run-id "${SCAN_RUN_ID}" \
  --db "${DB}" \
  --work-dir "${WORK_DIR}/" \
  --output-dir "${OUTPUT_DIR}" \
  --format json > "${WORK_DIR}/analytics.summary.json"

python3 - <<'PY' "${WORK_DIR}/analytics.summary.json" "${OUTPUT_DIR}" "${SCAN_RUN_ID}"
import json, pathlib, sys
payload = json.load(open(sys.argv[1], encoding="utf-8"))
assert payload["status"] == "ok"
assert payload["subcommand"] == "analytics"
assert payload["scan_run_id"] == sys.argv[3]
for key in ("leaderboards_written", "false_positive_rate_top50"):
    assert key in payload["result"], key
metrics_path = pathlib.Path(sys.argv[2]) / sys.argv[3] / "metrics.json"
metrics = json.load(open(metrics_path, encoding="utf-8"))
assert "false_positive_rate_top50" in metrics
print("OK: analytics summary and metrics valid")
PY
```

#### Completion Protocol

After successful execution:
1. Report the JSON summary path, exit code, metrics path, false-positive rate, and leaderboard count.
2. Mark the runtime dispatch row complete according to the routine-job lifecycle store.
3. Stop session immediately.
