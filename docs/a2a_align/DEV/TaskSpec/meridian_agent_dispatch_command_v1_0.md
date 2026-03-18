# Meridian Upgrade v1.0 — Agent Dispatch Command

> This file is given verbatim to every agent session. Read it in full before doing anything.

---

## Round Context

Round: main  
Branch: `feat/upgrade-v1.0`

Main implementation Workers `R-01` through `D-01` are already complete in this round.
The remaining open terminal Workers are `DELTA-CHECK` and `PR-REVIEW`.
If `DELTA-CHECK` appends corrective Workers, those Workers must make the minimum change that satisfies the PRD and must not trigger a second Delta Check pass.

---

## Pre-flight Gate

`PRE-FLIGHT` applied to the completed implementation round and should not be reopened as part of the terminal review pass.
If a corrective Worker is appended and the environment appears to have regressed, stop and report the blocker instead of silently re-baselining the branch.

---

## Environment Configuration

```bash
# 1. Confirm repo root and env file
export MERIDIAN_ROOT=/Users/yzliu/work/Meridian
export MERIDIAN_ENV=/Users/yzliu/work/Meridian/.env
cd $MERIDIAN_ROOT

# 2. Verify Node environment
node --version    # must be ^22.0.0
npm run typecheck # must exit 0 before you start

# 3. Confirm env var names used by this repo
# TELEGRAM_BOT_TOKEN
# TELEGRAM_BOT_TOKENS
# HUB_SOCKET_PATH
# OPENAI_API_KEY
# ANTHROPIC_API_KEY
#
# 4. No Docker commands — this project uses no local Docker
# PROHIBITED: docker, docker-compose, supabase start/reset/status, supabase db reset
# APPROVED validation/test commands:
#   npm test
#   npm run test:integration
#   npm run typecheck
#   npm run lint

# 5. docs/ may be gitignored — force-add TaskSpec outputs
git add -f docs/a2a_align/DEV/
```

---

## Agent Identity Declaration

Before doing anything else, determine which model you are:
- If you are Claude Opus → your worker code is **OPUS**
- If you are Codex → your worker code is **CODEX**

---

## Step 1 — Read the Dispatch Plan

Open the dispatch plan at:
```
/Users/yzliu/work/Meridian/docs/a2a_align/DEV/TaskSpec/meridian_dispatch_plan_v1_0_upgrade.md
```

Find the **first row** in the Master Dispatch Table where ALL of the following are true:
1. Status is `⬜` (Not started)
2. The **Model** column matches your worker code (OPUS or CODEX)
3. ALL workers listed in **Depends On** are `✅` (Complete)

That is your assigned Worker for this session.

If your assigned Worker is `DELTA-CHECK` or `PR-REVIEW`, follow the terminal review instructions in Step 6 or Step 7 below after completing the standard status-update steps.

---

## Step 2 — Dependency Check

Before proceeding, confirm all dependencies are `✅`.

If any dependency is `🔄` or `⬜`:
> ⛔ BLOCKED — Worker [your-id] depends on [dependency-id] which is not yet complete. Stopping.

Do not proceed. Do not attempt to implement the dependency yourself.

---

## Step 3 — Self-Check

If the next available worker belongs to the **other model**:
> ⏸ PAUSE — Next available worker [id] is assigned to [OTHER_MODEL]. My worker code is [YOUR_CODE]. Nothing to do this session.

---

## Step 4 — Execute

1. **Mark your worker `🔄`** in the dispatch plan before writing any code.

2. **Authority**: PRD_Meridian_Upgrade_v1.0.docx > This TaskSpec > Existing implementation.
   - If the PRD and TaskSpec conflict, PRD wins.
   - If a requirement is ambiguous: STOP, document the blocker in your completion report, do NOT guess.

3. **Read your Worker Definition** in:
   ```
   /Users/yzliu/work/Meridian/docs/a2a_align/DEV/TaskSpec/meridian_taskspec_v1_0_upgrade.md
   ```
   Implement all sub-tasks in order. Run `npm run typecheck` after each sub-task.
   If your Worker is `DELTA-CHECK` or `PR-REVIEW`, do not perform product-code implementation here; jump to the review flow in Step 6 or Step 7.

4. **Scope discipline**: Do NOT touch files outside your Worker's defined scope.
   - Exception: if a file outside scope requires a 1-line import update to compile, add it and note it in your report.
   - If you find a bug outside your scope: note it in your report, do NOT fix it.

5. **Run AI Auto-Tests** after completing all sub-tasks. All commands must pass.

6. **PM Flags**: Check the PM Flags Summary in the dispatch plan for your worker. Apply the stated resolution — do not re-derive your own resolution.

7. **Terminal-worker rule**:
   - `DELTA-CHECK` and `PR-REVIEW` are review/report workers, not implementation workers.
   - Do not modify product code during `PR-REVIEW`.
   - During `DELTA-CHECK`, only append corrective Workers if the gap is small, concrete, and does not require a new PM decision.

---

## Step 5 — Completion

### 5a — Update dispatch plan
Mark your worker `✅` in the Master Dispatch Table only when its completion gate is fully satisfied.
For `DELTA-CHECK` and `PR-REVIEW`, the terminal conditions in Step 6 or Step 7 override this generic rule.

### 5b — Write completion report
Save to one of the following:
```
/Users/yzliu/work/Meridian/docs/a2a_align/DEV/[batch_number]_[worker-id].md
```

Special terminal report paths:
```
/Users/yzliu/work/Meridian/docs/a2a_align/DEV/delta_check_report_v1_0_upgrade.md
/Users/yzliu/work/Meridian/docs/a2a_align/DEV/pr_review_report_v1_0_upgrade.md
```

If `DELTA-CHECK` appends corrective Workers, save those corrective Worker reports to:
```
/Users/yzliu/work/Meridian/docs/a2a_align/DEV/delta_reports/[WORKER_ID]_report.md
```

Report format:
```markdown
# Completion Report: [Worker ID] — [Worker Name]
- **Date**: [ISO date]
- **Model**: [OPUS/CODEX]
- **Status**: ✅ Complete

## Sub-tasks Completed
- [Worker-ID].1 — [name]: ✅
- [Worker-ID].2 — [name]: ✅
...

## Files Modified
- src/[path/to/file.ts] — [description of change]
...

## Tests Run
- npm run typecheck: ✅
- npm test: ✅ ([N] tests, 0 failures)

## Blockers / Notes
[Any issues encountered, PM decisions made, files touched outside scope]
```

### 5c — Git commit
```bash
git add -A
git commit -m "feat([worker-id]): [short description]

- [sub-task summary 1]
- [sub-task summary 2]
PRD: Meridian_Upgrade_v1.0 §[section]"
```

If your worker only updates review artifacts (`DELTA-CHECK` or `PR-REVIEW`), use `docs([worker-id])` instead of `feat([worker-id])`.

Branch: `feat/upgrade-v1.0`

### 5d — Push when batch is complete
Push ONLY when ALL workers in your current batch are `✅`:
```bash
git push origin feat/upgrade-v1.0
echo "✅ Batch [N] complete — all workers pushed."
```

---

## Step 6 — DELTA-CHECK

Run this step only when your assigned Worker is `DELTA-CHECK`.

1. Open the TaskSpec and load the acceptance criteria for every implementation Worker from `R-01` through `D-01`.
2. Review the implementation diff with:
   ```bash
   cd /Users/yzliu/work/Meridian
   git diff origin/main...HEAD
   ```
3. Write `/Users/yzliu/work/Meridian/docs/a2a_align/DEV/delta_check_report_v1_0_upgrade.md` with table columns:
   - `Worker | Status | Findings | Action Required`
   - Status values: `✅ Aligned`, `⚠️ Drift`, `❌ Missing`
4. If every Worker is aligned:
   - Mark `DELTA-CHECK` as `✅`
   - Commit and push the report update
5. If findings remain and the corrective scope is `<=5` Workers with no new PM decision:
   - Append corrective Worker rows to the bottom of the dispatch plan
   - Use the next available Worker IDs
   - Set the corrective Worker `Depends On` field to the specific completed implementation Worker(s) it corrects
   - Write corrective Worker reports to `/Users/yzliu/work/Meridian/docs/a2a_align/DEV/delta_reports/`
   - Keep `DELTA-CHECK` at `🔄` until those corrective Workers are `✅`, then update the Delta Check report and mark `DELTA-CHECK` as `✅`
6. If the corrective scope is larger than 5 Workers or requires a new PM decision:
   - Leave `DELTA-CHECK` at `⛔`
   - Report the blocker and stop
7. This is one pass only. Do not schedule or run a second Delta Check after corrective Workers complete.

---

## Step 7 — PR-REVIEW

Run this step only when your assigned Worker is `PR-REVIEW`.

1. Confirm `DELTA-CHECK` is already `✅`.
2. Load all review inputs:
   - `git diff origin/main...HEAD`
   - `/Users/yzliu/work/Meridian/docs/a2a_align/PRD/PRD_Meridian_Upgrade_v1.0.docx`
   - `/Users/yzliu/work/Meridian/docs/a2a_align/DEV/TaskSpec/meridian_taskspec_v1_0_upgrade.md`
   - `/Users/yzliu/work/Meridian/docs/a2a_align/DEV/delta_check_report_v1_0_upgrade.md`
   - Any corrective Worker reports under `/Users/yzliu/work/Meridian/docs/a2a_align/DEV/delta_reports/`
3. Write `/Users/yzliu/work/Meridian/docs/a2a_align/DEV/pr_review_report_v1_0_upgrade.md` with:
   - A per-file verdict table: `File | Worker | Verdict | Notes`
   - Verdict values: `✅ Aligned`, `⚠️ Scope Drift`, `❌ Missing`, `➕ Unplanned Addition`
   - A 1–3 sentence scope summary
   - A final line: `MERGE APPROVED` or `MERGE BLOCKED — [specific reason]`
4. Mark `PR-REVIEW` as `✅` when the report is complete.
5. If the final verdict is `MERGE BLOCKED`, do not merge; surface findings to PM.
6. If the final verdict is `MERGE APPROVED`, a human performs the actual merge.

---

## Status Legend

| Symbol | Meaning |
|--------|---------|
| ⬜ | Not started |
| 🔄 | In progress |
| ✅ | Complete |
| ⛔ | Blocked |
| ⏸ | Paused (wrong model) |
