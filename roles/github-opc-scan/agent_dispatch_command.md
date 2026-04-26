# Runtime Agent Dispatch Command: github-opc-scan

Use this command file for daily runtime workers launched by the `github-opc-scan` scheduler. Each invocation may execute exactly one eligible runtime row from `roles/github-opc-scan/dispatch_plan.md`.

## Scope

- Runtime phase: Phase 0 only.
- Repo: `/Users/yzliu/work/Meridian/Meridian-roles`.
- Tool: `github-ai-automation-scan`.
- No branch creation, git commit, push, pull request, or merge is performed for daily runtime rows.
- Do not edit the runtime worker definitions while executing a scheduled row.

## Worker Identity

Runtime workers always run as `CODEX-HIGH`.

## Execution Steps

1. Read `roles/github-opc-scan/dispatch_plan.md`.
2. Pick the first `⬜` row whose dependencies are `✅`.
3. Read the matching worker file from `roles/github-opc-scan/<WORKER_ID>.md`.
4. Compute `SCAN_RUN_ID` as `daily-YYYY-MM-DD` in `Asia/Tokyo` unless the scheduler supplied an explicit value.
5. Execute the worker file exactly, including its AI Auto-Tests.
6. Write the row report under the scheduler-provided run report directory.
7. Return the completion result to the scheduler lifecycle store and stop.

## Runtime Environment

```bash
export SCAN_RUN_ID="${SCAN_RUN_ID:-daily-$(TZ=Asia/Tokyo date +%Y-%m-%d)}"
export GITHUB_TOKEN="${GITHUB_TOKEN:?GITHUB_TOKEN is required}"
export GITHUB_OPC_DB="/Volumes/Elements/github-ai-automation-solutions/github-ai-automation-solutions.db"
export GITHUB_OPC_WORK_DIR="/tmp/github-opc-scan/${SCAN_RUN_ID}"
export GITHUB_OPC_OUTPUT_DIR="/Users/yzliu/work/Docs/Projects/routine-job/github-opc-solution-scan/output/${SCAN_RUN_ID}"
```

The dashboard service is intentionally outside this runtime dispatch plan.
