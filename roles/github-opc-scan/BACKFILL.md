# github-opc-scan Backfill Runbook

Use this runbook for operator-triggered backfills outside the daily 07:30 JST cron cycle. The routine workers remain unchanged; only the discovery mode and cap change.

## Preconditions

- `GITHUB_TOKEN` is available in the shell environment.
- `/Volumes/Elements/github-ai-automation-solutions/` is mounted and writable.
- `github-ai-automation-scan preflight` passes for the target `SCAN_RUN_ID`.
- The scheduler is not currently running the same `SCAN_RUN_ID`.

## Start A 500-Repo Backfill

```bash
set -euo pipefail
SCAN_RUN_ID="backfill-$(TZ=Asia/Tokyo date +%Y-%m-%d)"
DB="/Volumes/Elements/github-ai-automation-solutions/github-ai-automation-solutions.db"
WORK_DIR="/tmp/github-opc-scan/${SCAN_RUN_ID}"
OUTPUT_DIR="/Users/yzliu/work/Docs/Projects/routine-job/github-opc-solution-scan/output/${SCAN_RUN_ID}"
PARTITIONS="/Users/yzliu/work/Meridian/Meridian-roles/roles/github-opc-scan/query_partitions.yaml"
mkdir -p "${WORK_DIR}" "${OUTPUT_DIR}"

github-ai-automation-scan preflight \
  --scan-run-id "${SCAN_RUN_ID}" \
  --db "${DB}" \
  --work-dir "${WORK_DIR}/" \
  --output-dir "${OUTPUT_DIR}" \
  --github-token env:GITHUB_TOKEN \
  --format json

github-ai-automation-scan discover \
  --scan-run-id "${SCAN_RUN_ID}" \
  --db "${DB}" \
  --work-dir "${WORK_DIR}/" \
  --output-dir "${OUTPUT_DIR}" \
  --mode backfill \
  --cap 500 \
  --query-partition-cursor "${WORK_DIR}/query_partition_cursor.json" \
  --query-partitions-config "${PARTITIONS}" \
  --github-token env:GITHUB_TOKEN \
  --format json
```

After discovery succeeds, run the remaining Phase 0 commands in order using the same `SCAN_RUN_ID`, `DB`, `WORK_DIR`, and `OUTPUT_DIR`: `repo-fetch`, `prefilter`, `classify`, `persist`, and `analytics`.

## Expand To 2000

Re-run the same `discover --mode backfill` command with `--cap 2000`. Keep the same `SCAN_RUN_ID`, work directory, and cursor path. The cursor and database state persist progress, so the second invocation continues the partition traversal rather than starting from scratch.

## Force Re-Eval Of Rejected Candidates

To re-evaluate rejected candidates, run the prefilter stage again for the same `SCAN_RUN_ID` after the relevant repository rows or artifacts have been refreshed:

```bash
github-ai-automation-scan prefilter \
  --scan-run-id "${SCAN_RUN_ID}" \
  --db "${DB}" \
  --work-dir "${WORK_DIR}/" \
  --output-dir "${OUTPUT_DIR}" \
  --format json
```

Then run `classify`, `persist`, and `analytics` again. This passes candidates through prefilter again and refreshes downstream classification and dashboard outputs for the backfill run.
