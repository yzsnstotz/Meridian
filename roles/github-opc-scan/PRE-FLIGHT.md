### PRE-FLIGHT - Phase 0 Runtime Preflight

- **Runtime**: Local CLI
- **Delta Type**: NEW
- **Phase**: 0
- **Priority**: P0
- **Depends on**: none
- **Model**: CODEX-HIGH

#### Required Context

Runs the `github-ai-automation-scan preflight` subcommand before any daily scan work. This gates the Phase 0 runtime pipeline only: GitHub token, SQLite DB, output/work directories, Codex CLI, external mount, and runtime tool availability.

- **CLI command**: `github-ai-automation-scan preflight`
- **Database**: `/Volumes/Elements/github-ai-automation-solutions/github-ai-automation-solutions.db`
- **Work dir**: `/tmp/github-opc-scan/${SCAN_RUN_ID}/`
- **Output dir**: `/Users/yzliu/work/Docs/Projects/routine-job/github-opc-solution-scan/output/${SCAN_RUN_ID}`
- **Rate limit**: handled inside the CLI tool at Phase 0 caps
- **JSON summary**: top-level `status`, `subcommand`, `scan_run_id`, `result`; `result.overall` must not be `fail`

#### Sub-tasks

**PRE-FLIGHT.1 - Determine SCAN_RUN_ID**
- Compute `SCAN_RUN_ID` as `daily-YYYY-MM-DD` using today's date in the scheduler timezone.
- Create the work and output directories if they are missing.
- **Acceptance**: `SCAN_RUN_ID`, work dir, and output dir are set.

**PRE-FLIGHT.2 - Execute preflight**
- Run:
  ```bash
  github-ai-automation-scan preflight \
    --scan-run-id "${SCAN_RUN_ID}" \
    --db /Volumes/Elements/github-ai-automation-solutions/github-ai-automation-solutions.db \
    --work-dir "/tmp/github-opc-scan/${SCAN_RUN_ID}/" \
    --output-dir "/Users/yzliu/work/Docs/Projects/routine-job/github-opc-solution-scan/output/${SCAN_RUN_ID}" \
    --github-token env:GITHUB_TOKEN \
    --format json
  ```
- **Acceptance**: Exit code 0.

**PRE-FLIGHT.3 - Validate JSON summary**
- Parse stdout as JSON.
- Require `status` in `["ok", "warn"]`, `subcommand == "preflight"`, matching `scan_run_id`, and `result.overall != "fail"`.
- **Acceptance**: JSON summary is valid and no failed preflight check is present.

#### AI Auto-Tests

```bash
set -euo pipefail
SCAN_RUN_ID="daily-$(TZ=Asia/Tokyo date +%Y-%m-%d)"
WORK_DIR="/tmp/github-opc-scan/${SCAN_RUN_ID}"
OUTPUT_DIR="/Users/yzliu/work/Docs/Projects/routine-job/github-opc-solution-scan/output/${SCAN_RUN_ID}"
DB="/Volumes/Elements/github-ai-automation-solutions/github-ai-automation-solutions.db"
mkdir -p "${WORK_DIR}" "${OUTPUT_DIR}"

github-ai-automation-scan preflight \
  --scan-run-id "${SCAN_RUN_ID}" \
  --db "${DB}" \
  --work-dir "${WORK_DIR}/" \
  --output-dir "${OUTPUT_DIR}" \
  --github-token env:GITHUB_TOKEN \
  --format json > "${WORK_DIR}/preflight.summary.json"

python3 - <<'PY' "${WORK_DIR}/preflight.summary.json" "${SCAN_RUN_ID}"
import json, sys
payload = json.load(open(sys.argv[1], encoding="utf-8"))
assert payload["subcommand"] == "preflight"
assert payload["scan_run_id"] == sys.argv[2]
assert payload["status"] in {"ok", "warn"}
assert payload["result"]["overall"] != "fail"
print("OK: preflight summary valid")
PY
```

#### Completion Protocol

After successful execution:
1. Report the JSON summary path, exit code, and failed/warned checks if any.
2. Mark the runtime dispatch row complete according to the routine-job lifecycle store.
3. Stop session immediately.
