# Experience Fix Investigation Agent Dispatch Command v1.0

## Round Context

- **Round**: Main implementation round
- **Branch**: `feat/experience-fix`
- **Repo Root**: `/Users/yzliu/work/Meridian`
- **TaskSpec**: `/Users/yzliu/work/Meridian/docs/branch/feat:experience-fix/v1.0/investigation_report_v1.0_taskspec.md`
- **Dispatch Plan**: `/Users/yzliu/work/Meridian/docs/branch/feat:experience-fix/v1.0/investigation_report_v1.0_dispatch_plan.md`
- **Dev History Dir**: `/Users/yzliu/work/Meridian/docs/branch/feat:experience-fix/v1.0/dev_history/`
- **Source PRDs**:
  - `/Users/yzliu/work/Meridian/docs/branch/feat:experience-fix/v1.0/investigation_report_v1.0.md`
  - `/Users/yzliu/work/Meridian/docs/branch/feat:experience-fix/2603211649/taskspec/ui-test-report-2026-03-21-1357-solution-prd.md`
  - `/Users/yzliu/work/Meridian/docs/branch/feat:experience-fix/2603211649/taskspec/ui-test-report-2026-03-21-1357.md`

## Pre-flight Gate

Before ANY implementation worker starts, PRE-FLIGHT must be `✅`.
If PRE-FLIGHT is `⛔ BLOCKED`, do NOT proceed with any other worker.
Report the blocker and wait for manual resolution.

## Environment Configuration

```bash
cd /Users/yzliu/work/Meridian
export $(grep -v '^#' /Users/yzliu/work/Meridian/.env | xargs)
```

- Use the exact variable names defined in `/Users/yzliu/work/Meridian/src/config.ts`.
- Validate these names before running worker-specific commands: `HUB_SOCKET_PATH`, `MERIDIAN_STATE_PATH`, `WEB_GUI_ENABLED`, `WEB_GUI_PORT`, `WEB_GUI_HOST`, `WEB_GUI_TOKEN`, `MONITOR_SYNC_INTERVAL_MS`, `MONITOR_PROGRESS_TICK_MS`, `MONITOR_UPDATE_DEFAULT_INTERVAL_SEC`, `MONITOR_UPDATE_MIN_INTERVAL_SEC`, `MONITOR_UPDATE_MAX_INTERVAL_SEC`, `PANE_CAPTURE_INTERVAL_MS`, `PANE_BROADCAST_THROTTLE_MS`.
- This round has no database worker. Do not run `supabase db reset`, `supabase start`, or `supabase status`.
- No Docker-required workflow is authorized for this round.
- Do not rename routes, payload fields, event kinds, or env vars without updating tests and the TaskSpec contract.
- `docs/` may be gitignored. Use `git add -f docs/` when committing doc artifacts or completion reports.

## Agent Identity Declaration

Before doing anything else, determine which model you are:

- If you are Claude Opus → your worker code is `OPUS`
- If you are Codex → your worker code is `CODEX`
- Rows with Model = `PM` are human-resolved decision points. You are never PM. Skip these rows.
- Rows with Model = `HUMAN` are verification tasks requiring a specific environment. You are never HUMAN. Skip these rows.

Worker assignments:

| Model | Workers |
|-------|---------|
| `OPUS` | (No current assignments) |
| `CODEX` | PRE-FLIGHT, R-01, R-02, R-03, R-04, R-05, DELTA-CHECK, PR-REVIEW |
| `PM` | Only dynamically appended `PM-DECIDE-*` rows |

## Step 1 — Read the Dispatch Plan

Read these documents:
1. `/Users/yzliu/work/Meridian/docs/branch/feat:experience-fix/v1.0/investigation_report_v1.0_taskspec.md`
2. `/Users/yzliu/work/Meridian/docs/branch/feat:experience-fix/v1.0/investigation_report_v1.0_dispatch_plan.md`
3. The source PRD paths listed above

Find the first row in the Master Dispatch Table where:
1. Status is `⬜`
2. Model column matches your code
3. All `Depends On` workers are `✅`
4. Skip `PM-DECIDE-N` rows

If no eligible row exists, output `⏸ PAUSE — no eligible row for [MODEL]` and stop.

This selection happens once per command invocation. Claim exactly one row and do not return to Step 1 after completion.

## Step 2 — Dependency Check

For the selected worker, verify every dependency in the `Depends On` column is `✅` in the dispatch plan.

If any dependency is not `✅`:
- Output `⛔ BLOCKED — [WORKER_ID] depends on [DEPENDENCY] which is [CURRENT_STATUS]`
- Do NOT proceed

## Step 3 — Self-Check

Before editing any files:
1. List the files you expect to own from the TaskSpec worker definition.
2. Confirm the worker contract and acceptance criteria you are implementing.
3. Verify the worker's batch and priority match your model assignment.
4. If the next task belongs to another model, output `⏸ PAUSE — [WORKER_ID] is assigned to [OTHER_MODEL]` and stop.

## Step 3.5 — Claim Stamp (Anti-Collision Lock)

Immediately after passing Self-Check, and before reading any project source files beyond the dispatch plan and TaskSpec:

1. Open `/Users/yzliu/work/Meridian/docs/branch/feat:experience-fix/v1.0/investigation_report_v1.0_dispatch_plan.md`
2. Change the claimed row status from `⬜` to `🔄`
3. Save the file
4. Only then proceed to Step 4

This claim lock covers that one row only. It is not permission to claim more rows later in the same session.

## Step 4 — Execute

1. Read the full worker definition from the TaskSpec, including sub-tasks, constraints, AI Auto-Tests, and acceptance criteria.
2. Read every PRD listed in the worker row's `PRDs to Attach` column by resolving shorthand via the PRD Reference Paths table.
3. PRD is the authority over TaskSpec. If they conflict, follow the PRD and document the conflict in the worker report.
4. Execute each sub-task in order.
5. Run the worker-specific AI Auto-Tests after each substantial sub-task.
6. Scope discipline: do not touch files outside the worker's scope unless the TaskSpec explicitly requires a narrow integration adjustment.
7. Blockers: document them in the completion report. Do not silently fix unrelated issues.
8. For `R-05`, runtime or browser evidence is mandatory. Source-string inspection alone does not satisfy the worker acceptance criteria.

## Step 5 — Completion

**5a.** Update the claimed row status from `🔄` to `✅` in the dispatch plan.

**5b.** Write a completion report to:
- Main round: `/Users/yzliu/work/Meridian/docs/branch/feat:experience-fix/v1.0/dev_history/[WORKER_ID]_report.md`
- Delta fix round: `/Users/yzliu/work/Meridian/docs/branch/feat:experience-fix/v1.0/dev_history/delta/[WORKER_ID]_report.md`

Report must include:
- Exactly which files changed and why
- Exact commands run and whether they passed
- Any blockers, runtime caveats, or PM escalations
- For verification-oriented work, the runtime evidence collected

**5c.** Git commit to `feat/experience-fix` with structured message:
```text
[WORKER_ID] — [short description]

- Sub-task 1: [what was done]
- Sub-task 2: [what was done]
- Tests: [pass/fail summary]
```

**5d.** Push only when the entire current batch is `✅`. Output:
```text
✅ Batch [N] complete. All workers in this batch are ✅.
Pushing to feat/experience-fix.
```

**5e.** Stop immediately after Step 5a through 5d. Do not re-open Step 1 or claim another row in the same session.

## Step 6 — Delta Check

This step runs only after all implementation batches are `✅`.

**6a.** Load the TaskSpec and the original input documents.

**6b.** Diff actual output against worker acceptance criteria using `git diff main..HEAD`.

**6c.** Produce `/Users/yzliu/work/Meridian/docs/branch/feat:experience-fix/v1.0/dev_history/delta_check_report.md` with columns:
`Worker | Status | Findings | Action Required`

Status values:
- `✅ Aligned`
- `⚠️ Drift`
- `❌ Missing`

**6d.** If any `⚠️` or `❌` is found:
- AUTO finding: append a corrective worker row at `Batch: Ω+1`, `Depends On: DELTA-CHECK`
- PM finding: append a `PM-DECIDE-N` row plus a corrective worker row depending on `DELTA-CHECK, PM-DECIDE-N`
- If corrective workers exceed 5, generate a standalone delta TaskSpec set instead

**6e.** For F-04, F-05, and F-06, do not mark `✅ Aligned` from source inspection alone. Require runtime or browser evidence in worker reports.

**6f.** Mark DELTA-CHECK `✅` immediately after writing the report and appending all needed rows. DELTA-CHECK never waits for PM decisions or corrective workers.

## Step 7 — PR Review

This step runs only after DELTA-CHECK is `✅` and all corrective or PM rows are resolved.

**7a.** Open the full PR diff with `git diff main..HEAD`.

**7b.** Load:
- Original input documents
- TaskSpec acceptance criteria
- Delta Check report
- Any corrective worker reports from `/Users/yzliu/work/Meridian/docs/branch/feat:experience-fix/v1.0/dev_history/delta/`

**7c.** Produce `/Users/yzliu/work/Meridian/docs/branch/feat:experience-fix/v1.0/dev_history/pr_review_report.md` with columns:
`File | Worker | Verdict | Notes`

Verdict values:
- `✅ Aligned`
- `⚠️ Scope Drift`
- `❌ Missing`
- `➕ Unplanned Addition`

**7d.** Include a short scope-drift summary and a final line:
- `MERGE APPROVED`
- `MERGE BLOCKED — [reason]`

**7e.** Mark PR-REVIEW `✅` in the dispatch plan.

**7f.** If merge is blocked, stop and surface findings to PM. If merge is approved, a human performs the actual merge.

## Worker Verification Commands

```bash
cd /Users/yzliu/work/Meridian
npx tsc --noEmit
node --test --import tsx /Users/yzliu/work/Meridian/src/web/public-layout.test.ts
node --test --import tsx /Users/yzliu/work/Meridian/src/web/server.test.ts
node --test --import tsx /Users/yzliu/work/Meridian/src/hub/router.test.ts
node --test --import tsx /Users/yzliu/work/Meridian/src/hub/server.monitor.test.ts
```

## Status Legend

- `⬜` Not started
- `🟧` Reassigned
- `🔄` In progress
- `✅` Complete
- `⛔` Blocked
- `⏳` Awaiting PM decision
