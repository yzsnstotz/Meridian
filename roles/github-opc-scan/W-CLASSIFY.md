### W-CLASSIFY - Structured OPC Classification

- **Runtime**: Local CLI
- **Delta Type**: NEW
- **Phase**: 0
- **Priority**: P0
- **Depends on**: W-PREFILTER
- **Model**: CODEX-HIGH

#### Required Context

Runs the `github-ai-automation-scan classify` subcommand to score accepted candidates across the Phase 0 12-dimension formula and 4-layer judgment contract. Grey-zone reclassification is handled inside the tool.

R-01 classification uses the PRD §5.4 / Appendix B §B.A15 three-lane interface taxonomy:

- `automation_readiness` / `interface_lane="cli"` for agent-callable command-line tools with runnable entrypoints, structured output, command schemas, or OpenClaw-style manifests.
- `agent_local_api_readiness` / `interface_lane="local_api"` for local service-shaped tools exposing REST, JSON-RPC, gRPC, OpenAPI/Swagger, FastAPI/Flask/Express servers, or MCP manifests. MCP is a sub-class of this lane.
- `user_readiness` / `interface_lane="gui"` for non-technical graphical applications.
- `interface_lane="mixed"` when the repo has meaningful evidence for more than one lane.

The broadened `automation_readiness_score` rubric scores the strength of the agent-callable surface without preferring CLI over local API. Either surface counts when the integration ergonomics are strong, and the classify tool must set `interface_lane` from the observed surface evidence.

- **CLI command**: `github-ai-automation-scan classify`
- **Database**: `/Volumes/Elements/github-ai-automation-solutions/github-ai-automation-solutions.db`
- **Input**: `/tmp/github-opc-scan/${SCAN_RUN_ID}/prefiltered_candidates.json`
- **Output**: `/Users/yzliu/work/Docs/Projects/routine-job/github-opc-solution-scan/output/${SCAN_RUN_ID}/classification_summary.json`
- **Work dir**: `/tmp/github-opc-scan/${SCAN_RUN_ID}/`
- **Output dir**: `/Users/yzliu/work/Docs/Projects/routine-job/github-opc-solution-scan/output/${SCAN_RUN_ID}`
- **Rate limit**: Codex calls and audit logging are handled inside the CLI tool
- **JSON summary**: top-level `status`, `subcommand`, `scan_run_id`, `result`; result includes classification counts and reclassification rate
- **Persistence contract**: `candidate_current.interface_lane` is populated as `cli`, `local_api`, `gui`, or `mixed`.

#### Sub-tasks

**W-CLASSIFY.1 - Determine SCAN_RUN_ID**
- Compute `SCAN_RUN_ID` as `daily-YYYY-MM-DD` using today's date in the scheduler timezone.
- Verify `prefiltered_candidates.json` exists from W-PREFILTER.
- **Acceptance**: Input manifest exists.

**W-CLASSIFY.2 - Execute classify**
- Run:
  ```bash
  github-ai-automation-scan classify \
    --scan-run-id "${SCAN_RUN_ID}" \
    --db /Volumes/Elements/github-ai-automation-solutions/github-ai-automation-solutions.db \
    --work-dir "/tmp/github-opc-scan/${SCAN_RUN_ID}/" \
    --output-dir "/Users/yzliu/work/Docs/Projects/routine-job/github-opc-solution-scan/output/${SCAN_RUN_ID}" \
    --format json
  ```
- **Acceptance**: Exit code 0 and `classification_summary.json` exists.

**W-CLASSIFY.3 - Validate JSON summary**
- Parse stdout as JSON.
- Require `status == "ok"`, `subcommand == "classify"`, matching `scan_run_id`, and result keys `candidates_classified`, `reclassify_calls`, `reclassification_rate`.
- Verify classified rows written by this run have `candidate_current.interface_lane` either populated with one of `cli`, `local_api`, `gui`, `mixed` or left NULL only for rows that predate the R-01 schema and were not classified in this run.
- **Acceptance**: JSON summary is valid, classification output is present, and R-01 classified rows carry the lane field.

#### AI Auto-Tests

```bash
set -euo pipefail
SCAN_RUN_ID="daily-$(TZ=Asia/Tokyo date +%Y-%m-%d)"
WORK_DIR="/tmp/github-opc-scan/${SCAN_RUN_ID}"
OUTPUT_DIR="/Users/yzliu/work/Docs/Projects/routine-job/github-opc-solution-scan/output/${SCAN_RUN_ID}"
DB="/Volumes/Elements/github-ai-automation-solutions/github-ai-automation-solutions.db"
test -f "${WORK_DIR}/prefiltered_candidates.json"

github-ai-automation-scan classify \
  --scan-run-id "${SCAN_RUN_ID}" \
  --db "${DB}" \
  --work-dir "${WORK_DIR}/" \
  --output-dir "${OUTPUT_DIR}" \
  --format json > "${WORK_DIR}/classify.summary.json"

python3 - <<'PY' "${WORK_DIR}/classify.summary.json" "${OUTPUT_DIR}/classification_summary.json" "${SCAN_RUN_ID}"
import json, sys
payload = json.load(open(sys.argv[1], encoding="utf-8"))
assert payload["status"] == "ok"
assert payload["subcommand"] == "classify"
assert payload["scan_run_id"] == sys.argv[3]
for key in ("candidates_classified", "reclassify_calls", "reclassification_rate"):
    assert key in payload["result"], key
summary = json.load(open(sys.argv[2], encoding="utf-8"))
assert summary["scan_run_id"] == sys.argv[3]
print("OK: classify summary valid")
PY

missing_interface_lane=$(sqlite3 "${DB}" "
SELECT COUNT(*) AS missing_interface_lane
FROM candidate_current
WHERE last_classified_at IS NOT NULL
  AND interface_lane IS NULL;
")
test "${missing_interface_lane}" = "0"
echo "OK: classified rows include interface_lane"
```

#### Completion Protocol

After successful execution:
1. Report the JSON summary path, exit code, classified count, grey-zone reclassify calls, and output summary path.
2. Mark the runtime dispatch row complete according to the routine-job lifecycle store.
3. Stop session immediately.
