### W-CLASSIFY - Structured OPC Classification

- **Runtime**: Local CLI
- **Delta Type**: NEW
- **Phase**: 0
- **Priority**: P0
- **Depends on**: W-PREFILTER
- **Model**: CODEX-HIGH

#### Required Context

Runs the `github-ai-automation-scan classify` subcommand to score accepted candidates across the Phase 0 12-dimension formula and 4-layer judgment contract. Grey-zone reclassification is handled inside the tool.

- **CLI command**: `github-ai-automation-scan classify`
- **Database**: `/Volumes/Elements/github-ai-automation-solutions/github-ai-automation-solutions.db`
- **Input**: `/tmp/github-opc-scan/${SCAN_RUN_ID}/prefiltered_candidates.json`
- **Output**: `/Users/yzliu/work/Docs/Projects/routine-job/github-opc-solution-scan/output/${SCAN_RUN_ID}/classification_summary.json`
- **Work dir**: `/tmp/github-opc-scan/${SCAN_RUN_ID}/`
- **Output dir**: `/Users/yzliu/work/Docs/Projects/routine-job/github-opc-solution-scan/output/${SCAN_RUN_ID}`
- **Rate limit**: Codex calls and audit logging are handled inside the CLI tool
- **JSON summary**: top-level `status`, `subcommand`, `scan_run_id`, `result`; result includes classification counts and reclassification rate

#### Interface Lane Taxonomy

Classification must use the three-lane interface model from PRD Appendix B.A15:

- `automation_readiness` is the CLI lane: command entry points, command schemas, manifests, structured stdout/stderr, and batch-safe execution.
- `agent_local_api_readiness` is the local-API lane: localhost REST, JSON-RPC, gRPC, FastAPI, Flask, Express, OpenAPI/Swagger, or MCP server surfaces intended for programmatic agent callers. MCP is a sub-signal of this lane, not the whole category.
- `user_readiness` is the GUI lane: browser or desktop interfaces intended for non-technical operators.

The classifier's `automation_readiness_score` measures the strength of the agent-callable surface, whether it is CLI-shaped or local-API-shaped. Do not penalize local-API tools for lacking a CLI when they expose documented endpoints, service entry points, OpenAPI/Swagger specs, JSON-RPC/gRPC APIs, or MCP manifests. Runtime output must populate `interface_lane` as one of `cli`, `local_api`, `gui`, or `mixed` according to the strongest observed surface.

#### Sub-tasks

**W-CLASSIFY.1 - Determine SCAN_RUN_ID**
- Use the scheduler-provided `SCAN_RUN_ID`. For manual dry runs only, default to `daily-YYYY-MM-DD` using the scheduler timezone.
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
- **Acceptance**: JSON summary is valid and classification output is present.

**W-CLASSIFY.4 - Validate interface lane persistence**
- Inspect classified rows for this scan via `candidate_lifecycle.last_scan_run_id` and require populated `interface_lane` values to be in `cli`, `local_api`, `gui`, or `mixed`.
- If local-API signals were present in fetched artifacts, verify they were eligible for `interface_lane="local_api"` or `interface_lane="mixed"` rather than being forced into the CLI lane.
- **Acceptance**: No classified candidate has an invalid `interface_lane`; local-API evidence is preserved in classification output.

#### AI Auto-Tests

```bash
set -euo pipefail
SCAN_RUN_ID="${SCAN_RUN_ID:-daily-$(TZ=Asia/Tokyo date +%Y-%m-%d)}"
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

python3 - <<'PY' "${DB}" "${SCAN_RUN_ID}"
import sqlite3, sys

db_path, scan_run_id = sys.argv[1:3]
allowed = {"cli", "local_api", "gui", "mixed"}
conn = sqlite3.connect(db_path)
rows = conn.execute(
    """
    SELECT cc.interface_lane, COUNT(*)
    FROM candidate_current cc
    JOIN candidate_lifecycle cl ON cl.candidate_id = cc.candidate_id
    WHERE cl.last_scan_run_id = ?
      AND cc.interface_lane IS NOT NULL
    GROUP BY cc.interface_lane
    """,
    (scan_run_id,),
).fetchall()
invalid = sorted(lane for lane, _ in rows if lane not in allowed)
assert not invalid, f"invalid interface_lane values: {invalid}"
print("OK: interface_lane values valid", dict(rows))
PY
```

#### Completion Protocol

After successful execution:
1. Report the JSON summary path, exit code, classified count, grey-zone reclassify calls, interface lane counts, and output summary path.
2. Mark the runtime dispatch row complete according to the routine-job lifecycle store.
3. Stop session immediately.
