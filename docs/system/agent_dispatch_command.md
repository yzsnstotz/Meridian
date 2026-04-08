# Meridian System Map — Agent Dispatch Command v1.0

---

## Round Context

Round: main
Branch: `feat-cli-external-integration`
Repo Root: `/Users/yzliu/work/Meridian`
TaskSpec: `/Users/yzliu/work/Meridian/docs/system/system_map_taskspec_v1.0.md`
Dispatch Plan: `/Users/yzliu/work/Meridian/docs/system/dispatch_plan.md`

This is a documentation-generation task. No source code is modified. Output goes exclusively to `docs/system/`.

---

## Environment Configuration

- **Repo root**: `/Users/yzliu/work/Meridian`
- **Output directory**: `/Users/yzliu/work/Meridian/docs/system/`
- **Module files**: `/Users/yzliu/work/Meridian/docs/system/modules/`
- **Dev history**: `/Users/yzliu/work/Meridian/docs/system/dev_history/v1_round/`
- **No build required** — this task only reads source files and writes Markdown
- **No env vars required** — no runtime secrets or database access needed
- **gitignore note**: If `docs/` is gitignored, use `git add -f docs/system/` to force-add

---

## Agent Identity Declaration

Before doing anything else, determine which model you are:
- If you are Codex (standard) → your worker code is **CODEX**
- If you are Codex (high) → your worker code is **CODEX-HIGH**
- If you are Codex (xhigh) → your worker code is **CODEX-XHIGH**
- If you cannot determine your tier → output `PAUSE — unable to determine worker code` and stop immediately.
- Rows with Model = PM are human-resolved decision points. You are never PM. Skip these rows.
- Rows with Model = HUMAN are verification tasks requiring a specific environment. You are never HUMAN. Skip these rows.

---

## Step 1 — Read the Dispatch Plan

Read the dispatch plan at:
```
/Users/yzliu/work/Meridian/docs/system/dispatch_plan.md
```

Find the **first row** in the Master Dispatch Table where:
1. Status is `⬜`
2. Model column matches your worker code (OPUS or CODEX)
3. All workers in `Depends On` column are `✅`

That is your assigned task.

---

## Step 2 — Dependency Check

If any worker listed in your task's `Depends On` column is NOT `✅`:
```
⛔ BLOCKED — [Worker ID] dependency is not complete.
Waiting for: [list incomplete dependencies]
```
Do NOT proceed. Report the block and stop.

---

## Step 3 — Self-Check

If the next available `⬜` task belongs to the **other** model (e.g., you are CODEX but the task is OPUS):
```
⏸ PAUSE — Next task [Worker ID] is assigned to [other model].
No work available for [your model] at this time.
```

---

## Step 4 — Execute

### Before writing any code/docs:
1. Mark your row in the dispatch plan as `🔄`
2. Read the TaskSpec worker definition for your assigned Worker ID
3. Read `FORMAT_SPEC.md` at `/Users/yzliu/work/Meridian/docs/system/FORMAT_SPEC.md` (created by N-01; Batch 2+ workers MUST read this)

### Iteration Protocol (CRITICAL — read before writing any module file):

**First run** (module file does not exist):
- Create the file from scratch
- Tag every entry with `[ADDED <ISO-8601-datetime>]`

**Re-run** (module file already exists):
1. Read the existing module file
2. Scan the source directory for current exports
3. **New exports** (in code but not in docs) → append with `[ADDED <datetime>]`
4. **Changed exports** (signature or logic changed) → update in-place with `[UPDATED <datetime>]`
5. **Removed exports** (in docs but not in code) → do NOT delete the entry. Mark with `[REMOVED <datetime>]` and apply ~~strikethrough~~
6. **Unchanged exports** → leave as-is, do not update timestamp

### Execution rules:
- Follow FORMAT_SPEC.md schema exactly
- Read source files to extract exports — do not guess or hallucinate function signatures
- Include file:line references for every export
- Document cross-module dependencies for every export
- Stay within your Worker's scope — do not modify other workers' module files
- If you encounter a blocker (e.g., file unreadable, ambiguous export), document it in your completion report. Do NOT silently skip.

---

## Step 5 — Completion

### 5a. Update dispatch plan
Mark your row in the dispatch plan as `✅`

### 5b. Write completion report
Write to:
```
/Users/yzliu/work/Meridian/docs/system/dev_history/v1_round/[WORKER_ID]_report.md
```

Report format:
```markdown
# [WORKER_ID] Completion Report

**Worker**: [Worker ID] — [Worker Name]
**Model**: [OPUS/CODEX]
**Started**: <ISO-datetime>
**Completed**: <ISO-datetime>
**Status**: ✅ Complete

## Files Created/Modified
- [list of files with action: created/updated]

## Summary
[2-3 sentences on what was documented]

## Metrics
- Exports documented: [count]
- Files scanned: [count]
- New entries: [count]
- Updated entries: [count]
- Soft-deleted entries: [count]

## Blockers Encountered
[None / list any issues]
```

### 5c. Git commit
```bash
git add -f docs/system/
git commit -m "[WORKER_ID] — [Worker Name]

System map documentation: [brief description]
Files: [list key output files]"
```

### 5d. Push
Push only when your **entire batch** is `✅`:
```
✅ Batch [N] complete. All workers in batch have finished.
Pushing to feat-cli-external-integration.
```
```bash
git push origin feat-cli-external-integration
```

---

## Step 6 — Delta Check (OPUS only, after all Batches 1-3 complete)

Runs when: ALL implementation workers (N-01 through N-10) are `✅`

6a. Load all Worker acceptance criteria from the TaskSpec
6b. For each Worker, verify outputs exist and follow FORMAT_SPEC.md:
  - Check file existence
  - Check schema compliance (correct headers, sections, timestamp tags)
  - Check completeness (all source files covered)
  - Run `git diff feat-cli-external-integration` to verify all expected files present
6c. Write Delta Check Report to:
```
/Users/yzliu/work/Meridian/docs/system/dev_history/v1_round/delta_check_report.md
```
6d. If issues found:
  - ≤5 corrective workers → append to dispatch plan, execute, write reports to `dev_history/v1_round_delta/`
  - >5 workers → surface to PM
  - **ONE PASS ONLY**
6e. Mark DELTA-CHECK as `✅` when all aligned

---

## Step 7 — PR Review (OPUS only, after DELTA-CHECK is ✅)

7a. Open full diff: `git diff main..feat-cli-external-integration -- docs/system/`
7b. Load: TaskSpec, Delta Check Report
7c. Review every file in `docs/system/`:
  - FORMAT_SPEC.md compliance
  - All modules indexed in SYSTEM_INDEX.md
  - No files outside `docs/system/` modified
  - Timestamps present on all entries
  - Iteration protocol followed correctly
7d. Write PR Review Report to:
```
/Users/yzliu/work/Meridian/docs/system/dev_history/v1_round/pr_review_report.md
```
7e. End with `MERGE APPROVED` or `MERGE BLOCKED — [reason]`
7f. Mark PR-REVIEW as `✅`
7g. Human performs the actual merge

---

## Status Legend

| Symbol | Meaning |
|--------|---------|
| ⬜ | Not started |
| 🔄 | In progress |
| ✅ | Complete |
| ⛔ | Blocked |
| ⏸ | Paused (waiting for other model) |
