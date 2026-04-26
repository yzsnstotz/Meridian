### W-DISCOVERY - GitHub Discovery

- **Runtime**: Local CLI
- **Delta Type**: NEW
- **Phase**: 0
- **Priority**: P0
- **Depends on**: PRE-FLIGHT
- **Model**: CODEX-HIGH

#### Required Context

Runs the `github-ai-automation-scan discover` subcommand to collect GitHub source leads from the fixed Phase 0 query partitions. The default daily mode is delta. Backfill is an operator-triggered variation using `--mode backfill --cap N`.

- **CLI command**: `github-ai-automation-scan discover`
- **Database**: `/Volumes/Elements/github-ai-automation-solutions/github-ai-automation-solutions.db`
- **Work dir**: `/tmp/github-opc-scan/${SCAN_RUN_ID}/`
- **Output dir**: `/Users/yzliu/work/Docs/Projects/routine-job/github-opc-solution-scan/output/${SCAN_RUN_ID}`
- **Query partitions**: `/Users/yzliu/work/Meridian/Meridian-roles/roles/github-opc-scan/query_partitions.yaml`
- **Cursor**: `/tmp/github-opc-scan/${SCAN_RUN_ID}/query_partition_cursor.json`
- **Rate limit**: handled inside the CLI tool at 60 percent caps with secondary-limit backoff
- **JSON summary**: top-level `status`, `subcommand`, `scan_run_id`, `result`; result includes discovery metrics such as `hits_added`, `partitions_visited`, and `terminal_outcome`

#### Sub-tasks

**W-DISCOVERY.1 - Determine SCAN_RUN_ID**
- Compute `SCAN_RUN_ID` as `daily-YYYY-MM-DD` using today's date in the scheduler timezone.
- Verify PRE-FLIGHT completed for the same run.
- **Acceptance**: Work dir and output dir exist.

**W-DISCOVERY.2 - Execute discover**
- Run the daily delta command:
  ```bash
  github-ai-automation-scan discover \
    --scan-run-id "${SCAN_RUN_ID}" \
    --db /Volumes/Elements/github-ai-automation-solutions/github-ai-automation-solutions.db \
    --work-dir "/tmp/github-opc-scan/${SCAN_RUN_ID}/" \
    --output-dir "/Users/yzliu/work/Docs/Projects/routine-job/github-opc-solution-scan/output/${SCAN_RUN_ID}" \
    --mode delta \
    --query-partition-cursor "/tmp/github-opc-scan/${SCAN_RUN_ID}/query_partition_cursor.json" \
    --query-partitions-config /Users/yzliu/work/Meridian/Meridian-roles/roles/github-opc-scan/query_partitions.yaml \
    --github-token env:GITHUB_TOKEN \
    --format json
  ```
- For manual backfill, replace `--mode delta` with `--mode backfill --cap N`; do not change the worker definition.
- **Acceptance**: Exit code 0 and `discovery_hits.json` exists in the work dir.

**W-DISCOVERY.3 - Validate JSON summary**
- Parse stdout as JSON.
- Require `status == "ok"`, `subcommand == "discover"`, matching `scan_run_id`, and result keys `hits_added`, `partitions_visited`, `terminal_outcome`.
- **Acceptance**: JSON summary and handoff manifest are valid.

#### AI Auto-Tests

```bash
set -euo pipefail
SCAN_RUN_ID="daily-$(TZ=Asia/Tokyo date +%Y-%m-%d)"
WORK_DIR="/tmp/github-opc-scan/${SCAN_RUN_ID}"
OUTPUT_DIR="/Users/yzliu/work/Docs/Projects/routine-job/github-opc-solution-scan/output/${SCAN_RUN_ID}"
DB="/Volumes/Elements/github-ai-automation-solutions/github-ai-automation-solutions.db"
PARTITIONS="/Users/yzliu/work/Meridian/Meridian-roles/roles/github-opc-scan/query_partitions.yaml"
mkdir -p "${WORK_DIR}" "${OUTPUT_DIR}"

github-ai-automation-scan discover \
  --scan-run-id "${SCAN_RUN_ID}" \
  --db "${DB}" \
  --work-dir "${WORK_DIR}/" \
  --output-dir "${OUTPUT_DIR}" \
  --mode delta \
  --query-partition-cursor "${WORK_DIR}/query_partition_cursor.json" \
  --query-partitions-config "${PARTITIONS}" \
  --github-token env:GITHUB_TOKEN \
  --format json > "${WORK_DIR}/discover.summary.json"

python3 - <<'PY' "${WORK_DIR}/discover.summary.json" "${WORK_DIR}/discovery_hits.json" "${SCAN_RUN_ID}"
import json, sys
payload = json.load(open(sys.argv[1], encoding="utf-8"))
assert payload["status"] == "ok"
assert payload["subcommand"] == "discover"
assert payload["scan_run_id"] == sys.argv[3]
for key in ("hits_added", "partitions_visited", "terminal_outcome"):
    assert key in payload["result"], key
manifest = json.load(open(sys.argv[2], encoding="utf-8"))
assert manifest["version"] == 1
assert isinstance(manifest["hits"], list)
print("OK: discovery summary and handoff manifest valid")
PY
```

#### Completion Protocol

After successful execution:
1. Report the JSON summary path, exit code, hit count, partition count, and manifest path.
2. Mark the runtime dispatch row complete according to the routine-job lifecycle store.
3. Stop session immediately.
