### W-REPO-FETCH - Repository Metadata And Artifact Fetch

- **Runtime**: Local CLI
- **Delta Type**: NEW
- **Phase**: 0
- **Priority**: P0
- **Depends on**: W-DISCOVERY
- **Model**: CODEX-HIGH

#### Required Context

Runs the `github-ai-automation-scan repo-fetch` subcommand to fetch repository metadata, README/docs, manifests, file summaries, releases, and preview asset records for leads from `discovery_hits.json`.

- **CLI command**: `github-ai-automation-scan repo-fetch`
- **Database**: `/Volumes/Elements/github-ai-automation-solutions/github-ai-automation-solutions.db`
- **Input**: `/tmp/github-opc-scan/${SCAN_RUN_ID}/discovery_hits.json`
- **Work dir**: `/tmp/github-opc-scan/${SCAN_RUN_ID}/`
- **Output dir**: `/Users/yzliu/work/Docs/Projects/routine-job/github-opc-solution-scan/output/${SCAN_RUN_ID}`
- **Rate limit**: handled inside the CLI tool at 60 percent caps with secondary-limit backoff
- **JSON summary**: top-level `status`, `subcommand`, `scan_run_id`, `result`; result includes fetch and preview asset counts

#### Sub-tasks

**W-REPO-FETCH.1 - Determine SCAN_RUN_ID**
- Use the scheduler-provided `SCAN_RUN_ID`. For manual dry runs only, default to `daily-YYYY-MM-DD` using the scheduler timezone.
- Verify `discovery_hits.json` exists from W-DISCOVERY.
- **Acceptance**: Input manifest exists.

**W-REPO-FETCH.2 - Execute repo-fetch**
- Run:
  ```bash
  github-ai-automation-scan repo-fetch \
    --scan-run-id "${SCAN_RUN_ID}" \
    --db /Volumes/Elements/github-ai-automation-solutions/github-ai-automation-solutions.db \
    --work-dir "/tmp/github-opc-scan/${SCAN_RUN_ID}/" \
    --output-dir "/Users/yzliu/work/Docs/Projects/routine-job/github-opc-solution-scan/output/${SCAN_RUN_ID}" \
    --github-token env:GITHUB_TOKEN \
    --format json
  ```
- **Acceptance**: Exit code 0.

**W-REPO-FETCH.3 - Validate JSON summary**
- Parse stdout as JSON.
- Require `status == "ok"`, `subcommand == "repo-fetch"`, matching `scan_run_id`, and result keys `repos_fetched`, `repos_skipped`, `preview_assets_cached`, `preview_assets_skipped`.
- **Acceptance**: JSON summary is valid and counts are reported.

#### AI Auto-Tests

```bash
set -euo pipefail
SCAN_RUN_ID="${SCAN_RUN_ID:-daily-$(TZ=Asia/Tokyo date +%Y-%m-%d)}"
WORK_DIR="/tmp/github-opc-scan/${SCAN_RUN_ID}"
OUTPUT_DIR="/Users/yzliu/work/Docs/Projects/routine-job/github-opc-solution-scan/output/${SCAN_RUN_ID}"
DB="/Volumes/Elements/github-ai-automation-solutions/github-ai-automation-solutions.db"
test -f "${WORK_DIR}/discovery_hits.json"

github-ai-automation-scan repo-fetch \
  --scan-run-id "${SCAN_RUN_ID}" \
  --db "${DB}" \
  --work-dir "${WORK_DIR}/" \
  --output-dir "${OUTPUT_DIR}" \
  --github-token env:GITHUB_TOKEN \
  --format json > "${WORK_DIR}/repo-fetch.summary.json"

python3 - <<'PY' "${WORK_DIR}/repo-fetch.summary.json" "${SCAN_RUN_ID}"
import json, sys
payload = json.load(open(sys.argv[1], encoding="utf-8"))
assert payload["status"] == "ok"
assert payload["subcommand"] == "repo-fetch"
assert payload["scan_run_id"] == sys.argv[2]
for key in ("repos_fetched", "repos_skipped", "preview_assets_cached", "preview_assets_skipped"):
    assert key in payload["result"], key
print("OK: repo-fetch summary valid")
PY
```

#### Completion Protocol

After successful execution:
1. Report the JSON summary path, exit code, repos fetched/skipped, and preview asset counts.
2. Mark the runtime dispatch row complete according to the routine-job lifecycle store.
3. Stop session immediately.
