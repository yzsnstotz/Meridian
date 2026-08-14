# Per-Worker Files & Branch-Per-Worker Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Rewrite the taskspec SKILL.md to generate per-worker files instead of a monolithic TaskSpec, and enforce branch-per-worker with PR workflow.

**Architecture:** Single file edit (SKILL.md) with surgical section-by-section modifications. No new files needed beyond the skill definition. The skill is a prompt template — changes are textual, not code.

**Tech Stack:** Markdown skill file at `/Users/yzliu/work/skills/taskspec/SKILL.md`

**Design doc:** `/Users/yzliu/work/skills/taskspec/docs/plans/2026-04-13-per-worker-files-and-branches-design.md`

---

### Task 1: Update Skill Header & Core Artifacts Description

**Files:**
- Modify: `/Users/yzliu/work/skills/taskspec/SKILL.md:15-28`

**Step 1: Edit the three-artifact description**

Change the opening paragraph (lines 17-23) to reflect:
- TaskSpec is now a **directory** of files (index.md + per-worker .md files), not a single file
- DELTA-CHECK and PR-REVIEW are eliminated
- Each worker self-validates and creates its own PR
- Branch-per-worker with batch gate enforcement

Update the lifecycle sentence (line 23) from:
```
plan → dispatch → execute → push → delta check → PM decisions + corrective workers → push → PR review → human merge
```
To:
```
plan → dispatch → branch → execute → self-validate → PR → human merge (per worker, gated by batch)
```

**Step 2: Update Session Isolation Invariant (line 25)**

Keep the one-session-one-row rule. Add: each session also creates its own branch.

**Step 3: Keep Anti-Collision Protocol (line 27) as-is**

Still needed — multiple worker sessions can race for the same row.

**Step 4: Commit**

```bash
git add SKILL.md
git commit -m "feat(taskspec): update header for per-worker files and branch-per-worker"
```

---

### Task 2: Simplify Upstream Contract & Path Validation

**Files:**
- Modify: `/Users/yzliu/work/skills/taskspec/SKILL.md:31-81`

**Step 1: Update Path Validation table (lines 56-65)**

Change `TaskSpec output path` to `TaskSpec output directory` — it's now a directory, not a single file.
Remove `Branch name` row (single branch) and replace with `Version prefix` — used for branch naming (`<version>/<WORKER_ID>`).
Add row for `PR base branch` (usually `main`).

**Step 2: Commit**

```bash
git add SKILL.md
git commit -m "feat(taskspec): update path validation for directory output and branch naming"
```

---

### Task 3: Rewrite Output Structure Overview

**Files:**
- Modify: `/Users/yzliu/work/skills/taskspec/SKILL.md:84-118`

**Step 1: Rewrite Artifact 1 description (lines 86-96)**

Replace monolithic TaskSpec structure with:
```
### Artifact 1: TaskSpec Directory (`taskspec/`)

A directory containing:
1. **`index.md`** — document header, conflict resolution rule, PM blocker resolutions,
   compact dispatch table, cross-worker integration points, runtime contracts, worker file manifest
2. **`<WORKER_ID>.md`** — one file per worker (e.g. `R-01.md`, `N-02.md`, `PRE-FLIGHT.md`,
   `BATCH-N-GATE.md`) containing the full worker definition, sub-tasks, tests, and acceptance criteria

Workers read only their own file. The index provides the full picture for PM/human review and
cross-worker context when needed.
```

Remove items 7 (DELTA-CHECK) and 8 (PR-REVIEW) from the list.

**Step 2: Update Artifact 2 (Dispatch Plan) description (lines 97-108)**

Replace the table structure to reflect new columns:
- Remove: `PRDs to Attach` column description
- Add: `TaskSpec File` column (path to worker's file)
- Add: `PR` column (PR URL and merge status)
- Remove: items 7-10 (Delta Check row, PM-DECIDE rows, Corrective worker rows, PR Review row)

**Step 3: Update Artifact 3 (Dispatch Command) description (lines 110-118)**

Rewrite to reflect new steps:
```
1. Round context note
2. Environment Configuration
3. Worker Identity Declaration
4. Step 1-7: read plan → claim → branch → read worker file → execute → validate → PR + complete
5. Status Legend
```

Remove references to delta check and PR review steps.

**Step 4: Commit**

```bash
git add SKILL.md
git commit -m "feat(taskspec): rewrite output structure for split files and branch workflow"
```

---

### Task 4: Update Workflow Steps 0-2.6

**Files:**
- Modify: `/Users/yzliu/work/skills/taskspec/SKILL.md:121-237`

**Step 1: Update Step 0.5 (Environment Health Check) — lines 127-139**

Keep PRE-FLIGHT concept but note it now lives in its own file (`taskspec/PRE-FLIGHT.md`) and gets its own branch.

**Step 2: Minimize V- workers (Step 2.5, lines 176-244)**

Rewrite the V- worker section to emphasize automation-first:
- Default: coding workers verify everything via behavioral assertions
- V- workers (HUMAN model) only when verification requires a physical environment the worker cannot access (Tauri desktop, real device, production admin)
- Remove the "cannot auto-pass" language — instead: "prefer worker verification via behavioral assertions; use HUMAN only as last resort"
- Keep the V- worker template but mark it as "use sparingly"

**Step 3: Keep Step 2.6 (Decompose Human Acceptance) as-is**

Still relevant — decomposition helps workers self-validate.

**Step 4: Commit**

```bash
git add SKILL.md
git commit -m "feat(taskspec): update workflow steps for automation-first verification"
```

---

### Task 5: Update Batch Assignment & Model Assignment

**Files:**
- Modify: `/Users/yzliu/work/skills/taskspec/SKILL.md:293-361`

**Step 1: Update Step 4 (Batch Assignment, lines 293-305)**

Add note: each batch is a gate — all batch N PRs must be merged to main before batch N+1 workers start.

**Step 2: Keep Step 4.5 (Batch Integration Gate, lines 307-348)**

Still useful. Update to note it runs on its own branch too.

**Step 3: Simplify Step 5 (Model Assignment, lines 350-357)**

Remove PM and HUMAN model rows descriptions related to DELTA-CHECK/PM-DECIDE. Keep OPUS/CODEX assignments. Simplify HUMAN to: "only for V- workers when coding worker cannot verify."

**Step 4: Update Step 6 (Generate Artifacts, line 359-361)**

Change to: "Generate in order: TaskSpec index.md → individual worker files → Dispatch Plan → Dispatch Command."

**Step 5: Commit**

```bash
git add SKILL.md
git commit -m "feat(taskspec): update batch/model assignment for branch-per-worker"
```

---

### Task 6: Update Worker Definition Template

**Files:**
- Modify: `/Users/yzliu/work/skills/taskspec/SKILL.md:365-398`

**Step 1: Update template**

Add a note that each worker definition lives in its own file (`taskspec/<WORKER_ID>.md`). The template itself is unchanged — it just lives alone in a file now instead of being one section of a monolithic doc.

Add to template header:
```
**Branch**: `<version>/<WORKER_ID>`
```

**Step 2: Commit**

```bash
git add SKILL.md
git commit -m "feat(taskspec): add branch field to worker definition template"
```

---

### Task 7: Update Pre-flight Template

**Files:**
- Modify: `/Users/yzliu/work/skills/taskspec/SKILL.md:402-460`

**Step 1: Update template**

Note PRE-FLIGHT lives in `taskspec/PRE-FLIGHT.md` and gets branch `<version>/PRE-FLIGHT`.

**Step 2: Commit**

```bash
git add SKILL.md
git commit -m "feat(taskspec): update pre-flight template for file split"
```

---

### Task 8: Update Dispatch Plan Template

**Files:**
- Modify: `/Users/yzliu/work/skills/taskspec/SKILL.md:502-541`

**Step 1: Rewrite PRD Reference Paths (lines 502-515)**

Keep as-is — still needed for workers to find PRD documents.

**Step 2: Rewrite Master Table Template (lines 519-541)**

Replace the table format:
```
| Status | Batch | Worker | Task | Model | Depends On | TaskSpec File | PRDs | PR | Notes |
|--------|-------|--------|------|-------|------------|---------------|------|-----|-------|
| ⬜ | 0 | PRE-FLIGHT | Env Health Check | OPUS | — | taskspec/PRE-FLIGHT.md | — | — | |
| ⬜ | 1 | R-01 | [Task name] | CODEX | — | taskspec/R-01.md | Main PRD | — | |
```

Remove the "Dynamic rows added by DELTA-CHECK" section entirely.
Remove DELTA-CHECK and PR-REVIEW terminal rows.

Status values: remove `⏳` (no PM-DECIDE rows). Keep: `⬜ ⛔ 🔄 ✅`

**Step 3: Commit**

```bash
git add SKILL.md
git commit -m "feat(taskspec): rewrite dispatch plan template with TaskSpec File and PR columns"
```

---

### Task 9: Rewrite Dispatch Command

**Files:**
- Modify: `/Users/yzliu/work/skills/taskspec/SKILL.md:545-696`

This is the largest edit. Rewrite the entire dispatch command section.

**Step 1: Keep Section 0 (Round Context) — update**

Add `Version Prefix` field. Change `Branch` to note branch-per-worker pattern.

**Step 2: Keep Section 0.5 (Pre-flight Gate) as-is**

**Step 3: Keep Section 1 (Environment Config) as-is**

**Step 4: Simplify Section 2 (Worker Identity)**

Remove PM and HUMAN skip instructions (no PM-DECIDE rows). Keep OPUS/CODEX identification.

**Step 5: Rewrite Section 3 (Step 1 — Read Dispatch Plan)**

Add new eligibility condition: all `Depends On` workers' PRs must be merged to main.

**Step 6: Keep Section 4 (Step 2 — Dependency Check) — update for PR merge check**

**Step 7: Keep Section 5 (Step 3 — Self-Check) as-is**

**Step 8: Rewrite Section 5.5 (Step 3.5 — Claim + Branch)**

Split into:
- Step 3.5a: Claim stamp (mark 🔄) — existing
- Step 3.5b: Create branch — `git fetch origin main && git checkout -b <version>/<WORKER_ID> origin/main`

**Step 9: Update Section 6 (Step 4 — Execute)**

Change to read `taskspec/<WORKER_ID>.md` instead of "the TaskSpec". Reference `taskspec/index.md` for cross-worker context.

**Step 10: Rewrite Section 7 (Step 5 — Completion)**

New completion flow:
```
5a: Run all AI Auto-Tests from worker file
5b: Run all Behavioral Assertions from worker file
5c: If any fail → fix or mark ⛔ BLOCKED, STOP
5d: Update dispatch plan status → ✅
5e: Git commit with message: [WORKER_ID] <task summary>
5f: Git push branch to origin
5g: Create PR: gh pr create --base main --title "[WORKER_ID] — <name>" --body "<template>"
5h: Record PR URL in dispatch plan PR column
5i: Write completion report to dev_history/<WORKER_ID>_report.md
5j: STOP session
```

**Step 11: Delete Section 8 (Step 6 — Delta Check) entirely**

**Step 12: Delete Section 9 (Step 7 — PR Review) entirely**

**Step 13: Commit**

```bash
git add SKILL.md
git commit -m "feat(taskspec): rewrite dispatch command for branch-per-worker with PR workflow"
```

---

### Task 10: Remove DELTA-CHECK, PR-REVIEW, PM-DECIDE, and Opt-Out Sections

**Files:**
- Modify: `/Users/yzliu/work/skills/taskspec/SKILL.md:699-893`

**Step 1: Remove Conflict Resolution Rule section (lines 699-703)**

Keep this — still needed. Move on.

**Step 2: Simplify PM Blocker Resolutions (lines 707-724)**

Keep for delta rounds but remove references to DELTA-CHECK appending PM-DECIDE rows.

**Step 3: Delete PM-DECIDE Protocol section (lines 728-761) entirely**

No longer needed — workers block inline.

**Step 4: Delete Opt-Out Rule section (lines 764-766)**

Nothing to opt out of.

**Step 5: Delete Terminal Task Templates (lines 770-893)**

Remove both DELTA-CHECK and PR-REVIEW worker templates entirely.

**Step 6: Commit**

```bash
git add SKILL.md
git commit -m "feat(taskspec): remove DELTA-CHECK, PR-REVIEW, PM-DECIDE, opt-out sections"
```

---

### Task 11: Add TaskSpec Index Template

**Files:**
- Modify: `/Users/yzliu/work/skills/taskspec/SKILL.md` — insert new section after Worker Definition Template

**Step 1: Add new section "TaskSpec Index Template"**

```markdown
## TaskSpec Index Template (`taskspec/index.md`)

The index file is the master overview. It is NOT read by workers during execution (they read their own file).
It exists for PM/human review and for cross-worker context when a worker needs integration details.

Template:

    # TaskSpec — [Project Name] [Version]

    **Date**: [date]
    **Input documents**: [list with absolute paths]
    **Version prefix**: [e.g. v2.4]
    **PR base branch**: main

    ## Conflict Resolution Rule
    > PRD document > This TaskSpec > Previous implementation...

    ## PM Blocker Resolutions (if delta round)
    | # | Question | Resolution |
    ...

    ## Dispatch Table (Overview)
    | Batch | Worker | Task | Model | Depends On | File |
    ...

    ## Worker File Manifest
    | Worker | File Path |
    |--------|-----------|
    | PRE-FLIGHT | taskspec/PRE-FLIGHT.md |
    | R-01 | taskspec/R-01.md |
    ...

    ## Cross-Worker Integration Points
    | Producer | Consumer | Contract |
    ...

    ## Runtime Contracts
    [full contracts for async/event/IPC integrations]
```

**Step 2: Commit**

```bash
git add SKILL.md
git commit -m "feat(taskspec): add TaskSpec index template"
```

---

### Task 12: Add PR Body Template & Branch Naming Convention

**Files:**
- Modify: `/Users/yzliu/work/skills/taskspec/SKILL.md` — insert new section after dispatch command

**Step 1: Add "Branch Naming Convention" section**

```markdown
## Branch Naming Convention

Every worker gets its own branch:

    <version-prefix>/<WORKER_ID>

Examples: `v2.4/R-01`, `v2.4/N-02`, `v2.4/PRE-FLIGHT`, `v2.4/BATCH-2-GATE`

Workers in batch N+1 create their branch from main AFTER all batch N PRs are merged.
```

**Step 2: Add "PR Template" section**

```markdown
## PR Template

Workers create PRs with this body:

    ## [WORKER_ID] — <Task Name>

    **TaskSpec**: `taskspec/<WORKER_ID>.md`
    **Batch**: N
    **Depends on**: [Worker IDs]

    ### Changes
    - [Generated from sub-task list]

    ### Validation
    - [x] AI Auto-Tests passed
    - [x] Behavioral Assertions passed

    Generated by TaskSpec dispatch
```

**Step 3: Commit**

```bash
git add SKILL.md
git commit -m "feat(taskspec): add branch naming convention and PR template"
```

---

### Task 13: Update Dev History Path Conventions

**Files:**
- Modify: `/Users/yzliu/work/skills/taskspec/SKILL.md:952-970`

**Step 1: Simplify dev history paths**

Remove `delta/` subdirectory references (no delta rounds in this model).
Remove delta check report and PR review report paths.
Keep completion report path: `dev_history/<WORKER_ID>_report.md`

**Step 2: Commit**

```bash
git add SKILL.md
git commit -m "feat(taskspec): simplify dev history paths"
```

---

### Task 14: Final Review & Cleanup

**Files:**
- Modify: `/Users/yzliu/work/skills/taskspec/SKILL.md`

**Step 1: Search for stale references**

Grep for: `DELTA-CHECK`, `PR-REVIEW`, `PM-DECIDE`, `delta_check_report`, `pr_review_report`, `Ω+1`, `push-on-batch`, `single branch`, and fix any remaining references.

**Step 2: Verify internal consistency**

- All section cross-references point to sections that exist
- All template references match actual template names
- Worker definition template has `Branch` field
- Dispatch plan template has `TaskSpec File` and `PR` columns
- Dispatch command steps are numbered 1-7 consistently

**Step 3: Commit**

```bash
git add SKILL.md
git commit -m "feat(taskspec): final cleanup of stale references"
```
