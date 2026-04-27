### W-PREFILTER - Deterministic Candidate Prefilter

- **Runtime**: Local CLI
- **Delta Type**: NEW
- **Phase**: 0
- **Priority**: P0
- **Depends on**: W-REPO-FETCH
- **Model**: CODEX-HIGH

#### Required Context

Runs the `github-ai-automation-scan prefilter` subcommand to reject or down-rank obvious non-OPC candidates before expensive classification. It writes `prefiltered_candidates.json` as the bounded handoff to W-CLASSIFY. Runtime workers MUST pass the operator-authored prefilter config so local-API and MCP-shaped repositories are evaluated with the R-01 carve-outs instead of the legacy CLI-only defaults.

- **CLI command**: `github-ai-automation-scan prefilter`
- **Database**: `/Volumes/Elements/github-ai-automation-solutions/github-ai-automation-solutions.db`
- **Output**: `/tmp/github-opc-scan/${SCAN_RUN_ID}/prefiltered_candidates.json`
- **Work dir**: `/tmp/github-opc-scan/${SCAN_RUN_ID}/`
- **Output dir**: `/Users/yzliu/work/Docs/Projects/routine-job/github-opc-solution-scan/output/${SCAN_RUN_ID}`
- **Prefilter config**: `/Users/yzliu/work/Docs/Projects/routine-job/github-opc-solution-scan/config/prefilter.json`
- **Rate limit**: not applicable; uses local DB/artifacts
- **JSON summary**: top-level `status`, `subcommand`, `scan_run_id`, `result`; result includes `repos_evaluated`, `accepted`, `rejected`, `by_reason`

#### Sub-tasks

**W-PREFILTER.1 - Determine SCAN_RUN_ID**
- Compute `SCAN_RUN_ID` as `daily-YYYY-MM-DD` using today's date in the scheduler timezone.
- Verify W-REPO-FETCH completed for the same run.
- **Acceptance**: Repository rows exist for the current run.

**W-PREFILTER.2 - Execute prefilter**
- Verify the operator-authored config file exists at `/Users/yzliu/work/Docs/Projects/routine-job/github-opc-solution-scan/config/prefilter.json` before invoking the tool.
- Run:
  ```bash
  github-ai-automation-scan prefilter \
    --scan-run-id "${SCAN_RUN_ID}" \
    --db /Volumes/Elements/github-ai-automation-solutions/github-ai-automation-solutions.db \
    --work-dir "/tmp/github-opc-scan/${SCAN_RUN_ID}/" \
    --output-dir "/Users/yzliu/work/Docs/Projects/routine-job/github-opc-solution-scan/output/${SCAN_RUN_ID}" \
    --prefilter-config /Users/yzliu/work/Docs/Projects/routine-job/github-opc-solution-scan/config/prefilter.json \
    --format json
  ```
- **Acceptance**: Exit code 0 and `prefiltered_candidates.json` exists. The summary must show the config path loaded without an `invalid_prefilter_config` error.

**W-PREFILTER.3 - Validate JSON summary**
- Parse stdout as JSON.
- Require `status == "ok"`, `subcommand == "prefilter"`, matching `scan_run_id`, and result keys `repos_evaluated`, `accepted`, `rejected`, `by_reason`.
- **Acceptance**: JSON summary and handoff manifest are valid.

#### AI Auto-Tests

```bash
set -euo pipefail
SCAN_RUN_ID="daily-$(TZ=Asia/Tokyo date +%Y-%m-%d)"
WORK_DIR="/tmp/github-opc-scan/${SCAN_RUN_ID}"
OUTPUT_DIR="/Users/yzliu/work/Docs/Projects/routine-job/github-opc-solution-scan/output/${SCAN_RUN_ID}"
DB="/Volumes/Elements/github-ai-automation-solutions/github-ai-automation-solutions.db"
PREFILTER_CONFIG="/Users/yzliu/work/Docs/Projects/routine-job/github-opc-solution-scan/config/prefilter.json"
test -f "${PREFILTER_CONFIG}"

github-ai-automation-scan prefilter \
  --scan-run-id "${SCAN_RUN_ID}" \
  --db "${DB}" \
  --work-dir "${WORK_DIR}/" \
  --output-dir "${OUTPUT_DIR}" \
  --prefilter-config "${PREFILTER_CONFIG}" \
  --format json > "${WORK_DIR}/prefilter.summary.json"

python3 - <<'PY' "${WORK_DIR}/prefilter.summary.json" "${WORK_DIR}/prefiltered_candidates.json" "${SCAN_RUN_ID}"
import json, sys
payload = json.load(open(sys.argv[1], encoding="utf-8"))
assert payload["status"] == "ok"
assert payload["subcommand"] == "prefilter"
assert payload["scan_run_id"] == sys.argv[3]
for key in ("repos_evaluated", "accepted", "rejected", "by_reason"):
    assert key in payload["result"], key
manifest = json.load(open(sys.argv[2], encoding="utf-8"))
assert isinstance(manifest, list)
print("OK: prefilter summary and handoff manifest valid")
PY
```

#### Completion Protocol

After successful execution:
1. Report the JSON summary path, exit code, accepted/rejected counts, and top rejection reasons.
2. Mark the runtime dispatch row complete according to the routine-job lifecycle store.
3. Stop session immediately.
