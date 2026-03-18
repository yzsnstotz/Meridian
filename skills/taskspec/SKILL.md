---
name: taskspec
description: >
  Transforms requirement documents or vague concepts into structured TaskSpec execution plans.
  Use this skill whenever the user mentions "task breakdown", "requirements analysis", "project
  planning", "task list", "work decomposition", "sprint planning", or "how to implement a
  feature/product/system". Also trigger when the user uploads a requirements doc, PRD, or feature
  description, or says things like "help me plan this out", "where do I start with this", "break
  down this requirement", or just "taskspec". Outputs include a complete task list (each with AI
  auto-tests + human acceptance criteria) and an Agent dispatch strategy (serial/parallel dependency
  analysis, worker count, session strategy). Even for vague or half-formed ideas, proactively
  suggest using this skill to systematize the plan.
---

# TaskSpec Skill

Transforms requirements (documents, PRDs, or rough concepts) into **three executable artifacts** covering the full execution lifecycle from plan to merge:

1. **TaskSpec** — fully-specified Worker definitions with sub-tasks, tests, and acceptance criteria
2. **Dispatch Plan** — master dispatch table with batch assignments, model assignments, and completion tracking
3. **Dispatch Command** — the verbatim command file agents receive at the start of every session

The full execution lifecycle is always: **plan → dispatch → execute → push → delta check (one pass) → corrective workers (if needed) → push → PR review → human merge**. Delta Check and PR Review are mandatory terminal phases included in every TaskSpec unless the user explicitly opts out.

---

## ⚠️ MANDATORY PRE-GENERATION GATE: Path Validation

**Before generating any artifact**, verify every file path referenced in the project. This is non-negotiable.

### Required information to collect upfront

Ask the user for ALL of the following if not already provided:

| Item | What to ask |
|------|-------------|
| **Repo root** | Absolute path to the project repository (e.g. `/Users/nobuaki/projects/clawso`) |
| **TaskSpec output path** | Where to save the TaskSpec file (e.g. `docs/dev/mvp/clawso_taskspec_v3.0.md`) |
| **Dispatch plan output path** | Where to save the dispatch plan (e.g. `docs/dev/mvp/dispatch_plan.md`) |
| **Dev history / completion report dir** | Where agents write their completion reports (e.g. `docs/dev/mvp/dev_history/v3_round/`) |
| **PRD / input document paths** | Absolute path for every source document referenced in sub-tasks |
| **Branch name** | Git branch agents should commit to (e.g. `mvp-0315`) |
| **Environment file location** | Path to `.env.local` or equivalent (e.g. `clawso/.env.local`) |
| **Environment variable names** | Exact variable names used in the repo (never assume `DATABASE_URL` exists) |

### Hard block rule

If ANY path is unclear, ambiguous, assumed, or relative without a known root:

> **STOP. Do not generate any artifact. Ask the user immediately.**

Example blocking question:
> "Before I generate the TaskSpec, I need to confirm some file paths. Please provide:
> 1. The absolute repo root path
> 2. The target directory for TaskSpec output
> 3. The absolute path to each PRD document referenced
> I cannot generate accurate agent commands with relative or assumed paths."

**Relative paths are forbidden in the generated artifacts.** All paths in Worker sub-tasks, test commands, and the dispatch command must be absolute or rooted from the confirmed repo root.

---

## Output Structure Overview

### Artifact 1: TaskSpec (`clawso_taskspec_vX.X.md`)

1. **Document header** — title, version note, date, input documents list
2. **Conflict resolution rule** — PRD authority declaration (verbatim block)
3. **PM Blocker Resolutions** — any pre-resolved decisions that affect implementation
4. **Dispatch Table** — compact view of all Workers, batches, and dependencies
5. **Worker Definitions** — full spec for each Worker
6. **Cross-Worker Integration Points** — producer/consumer contract table
7. **DELTA-CHECK** — mandatory terminal task: diff all completed work against TaskSpec acceptance criteria, produce a findings report, append corrective workers if needed (one pass only)
8. **PR-REVIEW** — mandatory terminal task: agent reviews the full PR diff against the original PRD and TaskSpec acceptance criteria, produces a per-file verdict table and merge/block recommendation

### Artifact 2: Dispatch Plan (`dispatch_plan.md`)

1. **PRD Reference Paths** — table mapping every shorthand label used in "PRDs to Attach" column to its absolute file path (e.g. `Pipeline PRD` → `/abs/path/to/CLAWSO_MCP_Worker_Deploy_Pipeline_PRD_MVP_v1_0.md`). This is the single source of truth for agents to locate PRD documents.
2. **Model Assignment Legend** — which model handles which task types
3. **Master Dispatch Table** — status + batch + worker + task + model + depends on + PRDs to attach + notes
4. **Batch Execution Details** — per-batch: workers, priority, model assignments, agent notes, completion gate
5. **PM Flags Summary** — table of all flags raised and their resolutions
6. **Completion Tracking** — table tracking batch start/end dates and report file paths
7. **Delta Check row** — appears after the final implementation batch; depends on all implementation workers being `✅`; model: OPUS
8. **PR Review row** — terminal row; depends on Delta Check `✅`; model: OPUS

### Artifact 3: Dispatch Command (`agent_dispatch_command.md`)

Single command file given verbatim to every agent session. Contains:
1. **Round context note** — main round or delta round; pointer to parent TaskSpec if delta
2. **Environment Configuration** — exact env vars, DB validation commands, no-Docker rules
3. **Agent Identity Declaration** — how the agent determines its model code
4. **Step 1–5** — read plan → dependency check → self-check → execute → completion (report + git commit + push)
5. **Status Legend** — ⬜ / 🔄 / ✅ / ⛔

---

## Workflow

### Step 0: Path Validation Gate

Run the pre-generation gate above. Do not proceed until all paths are confirmed.

### Step 0.5: Environment Health Check Gate

**Before any implementation worker runs**, the TaskSpec must include a PRE-FLIGHT worker in Batch 0 that validates the execution environment. This catches pre-existing drift, broken baselines, and environmental assumptions that would block downstream workers mid-execution.

The PRE-FLIGHT worker is **mandatory** whenever the TaskSpec touches any of the following:
- Database migrations (check `pendingLocal`, `remoteOnly`, schema drift)
- Build artifacts (check that the project compiles / builds cleanly on the branch)
- External service configuration (check that required secrets/env vars are accessible)
- Deployment targets (check that target environments are reachable)

If the PRE-FLIGHT check fails, the entire dispatch halts at Batch 0 with a `⛔ BLOCKED` status and a report describing what needs manual repair before workers can proceed. This prevents workers from encountering environment issues mid-execution where they lack the authority or context to fix them safely.

See the **Pre-flight Worker Template** section below for the required format.

### Step 1: Understand the Input

Input may be:
- **Full PRD / requirements document** → proceed directly to analysis
- **Feature description paragraph** → clarify key assumptions, then analyze
- **One-line concept** → make reasonable assumptions, expand, flag all as `[ASSUMPTION]`

### Step 2: Worker Decomposition

Worker ID prefix conventions:
- `R-` = Rework (modify existing code)
- `N-` = New (build from scratch)
- `D-` = Delete/strip (remove old code)

Delta type values:
- `REWORK` — existing code modified to meet new or revised spec
- `NEW` — built from scratch, no prior implementation
- `DELETE` — remove code, validate nothing breaks
- `KEEP` — no change required, listed for dependency tracking
- `DRIFT` — implementation deviated from spec without a conscious decision; no PRD change required, correct the execution (used in delta fix workers only)

Each Worker must specify:
- **Runtime** (Supabase / CF Workers / CF Pages / GitHub Actions / etc.)
- **Delta type** (REWORK / NEW / DELETE / KEEP / DRIFT)
- **Phase** (0 = blocking foundation, 1 = core features, 2 = admin/tooling/cleanup)
- **Priority** (P0 / P1 / P2)
- **Depends on** (other Worker IDs)
- **Sub-tasks** with: description, key constraints, acceptance criteria, reference doc section

Granularity rule: each Worker is completable in **one independent agent session**.

### Step 3: Test Spec Design

Each Worker requires two testing layers.

**AI Auto-Tests** — specific executable commands the agent runs and must pass before marking done:
```bash
# All commands use absolute paths or confirmed env vars
export $(grep -v '^#' /absolute/path/.env.local | xargs)
npm run db:remote:apply -- supabase/migrations/<file>.sql
npm run db:remote:status
```

**Human Acceptance Criteria** — 2–5 bullet points of observable behavior a human reviewer confirms.

### Step 4: Batch Assignment

| Batch | Contents | Rationale |
|-------|----------|-----------|
| 0 | PRE-FLIGHT environment health check | Gates all workers; catches drift before execution |
| 1 | DB schema Workers (no code deps) | Foundation; everything else reads these tables |
| 2 | Services that read DB (verify, MCP, BFF core) | Parallel after Batch 1 |
| 3 | Platform backend modules | Depend on Batch 2 service contracts |
| 4 | Admin backend | Depends on DB + BFF contracts |
| 5 | Frontend SPAs + CI/CD | Depend on backend APIs |
| 6 | Dead code removal / final sweep | Depends on all above |

Adjust batch count and grouping to fit the actual project. These are defaults, not requirements.

### Step 5: Model Assignment

| Model | Code | Assign When |
|-------|------|-------------|
| Claude Opus | `OPUS` | Complex refactoring, multi-file coordination, nuanced business logic, architectural decisions |
| Codex (or other) | `CODEX` | Well-specified schema work, config changes, template generation, straightforward deletions, UI work with clear API contracts |

### Step 6: Generate All Three Artifacts

Generate in order: TaskSpec → Dispatch Plan → Dispatch Command.

---

## TaskSpec: Worker Definition Template

````markdown
### [WORKER_ID] — [Worker Name]

- **Runtime**: [Supabase PostgreSQL / CF Workers / CF Pages / GitHub Actions]
- **Delta Type**: [REWORK / NEW / DELETE / KEEP / DRIFT]
- **Phase**: [0 / 1 / 2]
- **Priority**: [P0 / P1 / P2]
- **Depends on**: [Worker IDs or —]

#### Sub-tasks

**[WORKER_ID].1 — [Sub-task name]**
- [Detailed implementation description]
- **Key constraint**: [Any hard rule or business logic constraint]
- **Acceptance**: [Verifiable completion condition]
- **Ref**: [PRD document § section]

**[WORKER_ID].2 — [Sub-task name]**
...

#### AI Auto-Tests
```bash
# All commands use absolute paths or confirmed env vars
export $(grep -v '^#' /absolute/path/.env.local | xargs)
[specific test commands]
```

#### Human Acceptance Criteria
- [Observable condition 1]
- [Observable condition 2]
- [Observable condition 3]
````

---

## Pre-flight Worker Template (mandatory Batch 0)

Every TaskSpec that touches database, build, or deployment systems must include a PRE-FLIGHT worker as the first entry in Batch 0. This worker runs before all other workers and gates the entire dispatch on environment health.

````markdown
### PRE-FLIGHT — Environment Health Check

- **Runtime**: Local (bash)
- **Delta Type**: REVIEW
- **Phase**: 0
- **Priority**: P0
- **Depends on**: —

#### Sub-tasks

**PRE-FLIGHT.1 — Database migration baseline** *(include if any Worker touches DB migrations)*
- Run the project's migration status command (e.g. `npm run db:remote:status`)
- Verify: `pendingLocal` is empty (no unapplied local migrations from prior work)
- Verify: `remoteOnly` is empty (no migrations applied remotely but missing locally)
- If either is non-empty: report the specific versions and **STOP with `⛔ BLOCKED`**
- Do NOT attempt to fix drift — report it for manual repair
- **Acceptance**: Migration status shows `pendingLocal: []` and `remoteOnly: []`

**PRE-FLIGHT.2 — Build baseline** *(include if any Worker touches compiled code)*
- Run the project's build/typecheck command (e.g. `npx tsc --noEmit`)
- Verify: build succeeds with zero errors on the current branch
- If build fails: report errors and **STOP with `⛔ BLOCKED`**
- **Acceptance**: Project builds cleanly before any worker modifies code

**PRE-FLIGHT.3 — Required secrets/env validation** *(include if Workers need runtime secrets)*
- Verify that all required environment variables / secrets referenced by Workers are accessible
- Check by name only (e.g. `test -n "$CF_API_TOKEN"`), never log values
- If any are missing: list them and **STOP with `⛔ BLOCKED`**
- **Acceptance**: All required env vars / secrets are non-empty

#### AI Auto-Tests
```bash
# DB baseline (adjust command to project)
npm run db:remote:status | jq '.pendingLocal | length == 0 and (.remoteOnly | length == 0)' | grep true || echo "⛔ DB DRIFT DETECTED"

# Build baseline (adjust command to project)
cd <worker-dir> && npx tsc --noEmit 2>&1 | tail -5

# Env validation (list required vars)
for var in CF_ACCOUNT_ID CF_API_TOKEN; do
  test -n "$(printenv $var)" || echo "⛔ MISSING: $var"
done
```

#### Human Acceptance Criteria
- Migration history is fully synchronized (no pending, no remote-only)
- Project builds cleanly on the branch
- All required secrets are available
- If any check fails, dispatch is halted with a clear blocker report
````

**Dispatch plan integration**: PRE-FLIGHT appears as the first row in Batch 0, before all implementation workers. All Batch 1+ workers have an implicit dependency on PRE-FLIGHT (it must be `✅` before any other worker starts). You do not need to list PRE-FLIGHT in every worker's `Depends On` — it is a batch-level gate.

**Omit sub-tasks that don't apply**: If the TaskSpec has no DB migrations, omit PRE-FLIGHT.1. If no compiled code, omit PRE-FLIGHT.2. If no external secrets, omit PRE-FLIGHT.3. But if at least one sub-task applies, the PRE-FLIGHT worker must be included.

---

## Environment Integrity Standards

### Migration Idempotency (mandatory for all DB Workers)

All database migration files generated or referenced by a TaskSpec **must** be fully idempotent — safe to re-run without error. This is non-negotiable because:
- Pre-existing drift (schema applied outside the migration tool) is common in projects with manual DB access
- The `--allow-out-of-order` repair flow requires re-executing the SQL safely
- Agents cannot make safe judgment calls about partial schema state mid-execution

**Required patterns**:
| SQL Statement | Required Guard |
|---|---|
| `CREATE TABLE` | `IF NOT EXISTS` |
| `CREATE INDEX` | `IF NOT EXISTS` |
| `CREATE UNIQUE INDEX` | `IF NOT EXISTS` |
| `ALTER TABLE ADD COLUMN` | `IF NOT EXISTS` |
| `CREATE EXTENSION` | `IF NOT EXISTS` |
| `CREATE SCHEMA` | `IF NOT EXISTS` |
| `CREATE TYPE` | Use `DO $$ ... IF NOT EXISTS ... $$` block |
| `DROP TABLE / INDEX / COLUMN` | `IF EXISTS` |

When generating Worker sub-tasks for DB migrations, include this constraint:
> **Key constraint**: All DDL statements must use idempotency guards (`IF NOT EXISTS` / `IF EXISTS`). Migration must be re-runnable without error.

### Worker-Scoped Acceptance Criteria (mandatory)

Every Worker's acceptance criteria must validate **only the outputs that Worker produces**, never the global environment state. This prevents workers from being blocked by pre-existing issues outside their scope.

**Bad** (global scope — can fail due to unrelated drift):
> "db:remote:status shows no pending migrations"

**Good** (worker-scoped — validates only this worker's output):
> "db:remote:status shows version 029 in remoteVersions; no new pendingLocal entries were introduced by this worker"

**Rule**: If a Worker's acceptance needs a clean global baseline, that baseline is validated by PRE-FLIGHT, not by the Worker itself. Workers validate their own deliverables; PRE-FLIGHT validates the environment.

---

## Dispatch Plan: PRD Reference Paths (required)

The dispatch plan **must** include a PRD Reference Paths table immediately after the header. Every shorthand label used in the Master Dispatch Table's `PRDs to Attach` column must have a corresponding entry here with its absolute path.

````markdown
### PRD Reference Paths

| Shorthand | Full Path |
|-----------|-----------|
| Pipeline PRD | `/absolute/path/to/pipeline_prd.md` |
| Admin PRD | `/absolute/path/to/admin_prd.md` |
````

**Rule**: If a shorthand appears in `PRDs to Attach` but is missing from this table, the dispatch plan is invalid. Agents must be able to resolve every label to an absolute path without guessing.

---

## Dispatch Plan: Master Table Template

````markdown
| Status | Batch | Worker | Task | Model | Depends On | PRDs to Attach | Notes |
|--------|-------|--------|------|-------|------------|----------------|-------|
| ⬜ | 1 | R-01 | [Task name] | CODEX | — | Main PRD | [Any PM flags] |
| ⬜ | 1 | N-02 | [Task name] | CODEX | — | Main PRD, Admin PRD | |
...
| ⬜ | Ω | DELTA-CHECK | Delta Check & Corrective Dispatch | OPUS | [all implementation Workers] | TaskSpec, all PRDs | One pass only. Findings → append corrective workers to this plan. |
| ⬜ | Ω | PR-REVIEW | PR Alignment Review | OPUS | DELTA-CHECK | TaskSpec, all PRDs | Terminal gate; human merges |
````

Status values: `⬜` Not started · `🔄` In progress · `✅` Complete · `⛔` Blocked

**Note**: All shorthand labels in `PRDs to Attach` (e.g. "Main PRD", "Admin PRD") must map to entries in the PRD Reference Paths table above.

---

## Dispatch Command: Required Sections

The dispatch command must include all of the following in exact order:

### 0. Round Context Note

At the very top of the dispatch command, include a brief context block:

```
## Round Context

Round: [main / delta fix]
Parent TaskSpec: [absolute path to parent TaskSpec, if delta round; omit if main round]
Branch: [branch name]

[If delta round]: This is a delta fix round. The [vX.X] main round is fully complete.
Reference the parent TaskSpec at [absolute path] for context on what was already implemented.
Corrective workers in this round make the minimum change that satisfies the PRD.
Do not refactor unrelated code.
```

### 0.5. Pre-flight Gate Reminder

Include a prominent note in the dispatch command:

```
## Pre-flight Gate
Before ANY implementation worker starts, PRE-FLIGHT must be ✅.
If PRE-FLIGHT is ⛔ BLOCKED, do NOT proceed with any other worker.
Report the blocker and wait for manual resolution.
```

### 1. Environment Configuration block

Must include:
- Absolute path to `.env.local` (or confirmed env file)
- Exact env var names (never assume names — use confirmed names)
- Explicit prohibition of `supabase db reset` / `supabase start` / `supabase status` if local Docker is not in use
- Approved DB validation commands (e.g. `npm run db:remote:apply`, `npm run db:remote:status`)
- `docs/` gitignore note with `git add -f docs/` instruction if applicable

### 2. Agent Identity Declaration

```
Before doing anything else, determine which model you are:
- If you are Claude Opus → your worker code is OPUS
- If you are Codex → your worker code is CODEX
```

### 3. Step 1 — Read the Dispatch Plan

Point to confirmed absolute path of dispatch plan. Agent finds the first row where:
1. Status is `⬜`
2. Model column matches its code
3. All `Depends On` workers are `✅`

### 4. Step 2 — Dependency Check

Block with `⛔ BLOCKED` message if any dependency is not `✅`.

### 5. Step 3 — Self-Check

Pause with `⏸ PAUSE` if the next task belongs to the other model.

### 6. Step 4 — Execute

- Mark `🔄` before writing code
- PRD is the authority over TaskSpec
- Run tests after each sub-task
- Scope discipline: no touching files outside the Worker's scope
- Blockers → document in report, do NOT silently fix

### 7. Step 5 — Completion

5a: Update dispatch plan status to `✅`
5b: Write completion report to confirmed absolute path
5c: Git commit to confirmed branch with structured message
5d: Push only when entire batch is `✅`; output batch completion message

**Completion report path convention**:
- Main round workers → `dev_history/<round>/[WORKER_ID]_report.md`
- Delta fix workers → `dev_history/<round>_delta/[WORKER_ID]_report.md`

### 8. Step 6 — Delta Check (mandatory, one pass only, runs after all implementation batches complete)

This step is always included unless the user explicitly opted out at TaskSpec generation time.

6a: Load the original TaskSpec and all Worker acceptance criteria
6b: For each Worker, diff actual output (files changed, endpoints implemented, DB schema applied) against acceptance criteria — use `git diff <base-branch>..HEAD`
6c: Produce a **Delta Check Report** at `dev_history/<round>/delta_check_report.md`:
  - Format: table with columns `Worker | Status | Findings | Action Required`
  - Status values: `✅ Aligned` / `⚠️ Drift` / `❌ Missing`
  - For every `⚠️` or `❌`: describe the specific gap and the corrective action required
6d: **If any `⚠️` or `❌` found** — apply the corrective dispatch protocol:
  - Evaluate scale: if ≤5 corrective workers with no new PRD-level decisions → **append** corrective workers directly to the current dispatch plan (no new artifact set). If >5 workers or new PM decisions required → generate a new delta TaskSpec artifact set and surface to PM.
  - For in-plan corrections: add workers as new rows (next available Worker IDs, e.g. R-13, R-14) at the bottom of the Master Dispatch Table, with `Batch: Ω+1`, `Depends On: DELTA-CHECK`, Delta Type: `DRIFT` or `REWORK` as appropriate
  - Dispatch corrective workers to appropriate agents, re-execute, push to the same branch
  - Write corrective worker completion reports to `dev_history/<round>_delta/`
  - **This is ONE pass only.** Corrective workers are scoped to the minimum change that satisfies the PRD. A second delta check does NOT run after corrective workers complete — PR Review is the safety net for any residual issues.
6e: When all Workers are `✅ Aligned` (or corrective workers are complete): mark DELTA-CHECK row in dispatch plan as `✅`, push final state

### 9. Step 7 — PR Review (mandatory, runs after Delta Check is ✅)

This step is always included unless the user explicitly opted out at TaskSpec generation time.

7a: Open the full PR diff (`git diff <base-branch>..HEAD`)
7b: Load: (1) original PRD documents, (2) TaskSpec acceptance criteria for all Workers, (3) Delta Check report (including any corrective worker reports from `<round>_delta/`)
7c: Review the diff against the above — the agent must check:
  - Are all TaskSpec acceptance criteria present and implemented correctly?
  - Are there any new fields, endpoints, behaviors, or files not in scope?
  - Are API contract field names consistent with the PRD spec?
  - Are any Workers listed `✅` in dispatch plan but absent or incomplete in the diff?
  - Are state transitions, DB schema, and service contracts matching the spec exactly?
  - Did any corrective worker introduce unplanned changes beyond its stated scope?
7d: Produce a **PR Review Report** at `dev_history/<round>/pr_review_report.md`:
  - Format: per-file verdict table with columns `File | Worker | Verdict | Notes`
  - Verdict values: `✅ Aligned` / `⚠️ Scope Drift` / `❌ Missing` / `➕ Unplanned Addition`
  - Scope drift summary: 1–3 sentence net assessment of whether the PR is safe to merge
  - Final line: `MERGE APPROVED` or `MERGE BLOCKED — [reason]`
7e: Mark PR-REVIEW row in dispatch plan as `✅`
7f: If `MERGE BLOCKED`: do not merge; surface findings to PM for decision
7g: If `MERGE APPROVED`: human performs the actual merge (agent never auto-merges)

---

## Conflict Resolution Rule (mandatory verbatim block in TaskSpec)

Include this exact block under `## 冲突処理規則` (or `## Conflict Resolution Rules`) near the top of the TaskSpec:

> PRD document > This TaskSpec > Previous implementation. Any discrepancy with the PRD must defer to the MVP PRD set. Requirements not defined in the PRD: developer must pause and file an issue; do not proceed until PM provides a clear definition.

---

## PM Blocker Resolutions (delta rounds only)

When generating a delta fix TaskSpec, include a `## PM Blocker Resolutions` section immediately after the Conflict Resolution Rule. This section captures decisions that were deferred during the main round and must be explicitly resolved before corrective workers can proceed.

Format:

```markdown
## PM Blocker Resolutions

| # | Question | Resolution |
|---|----------|------------|
| 1 | [Deferred question from main round] | [Explicit PM decision — do not leave blank] |
| 2 | [Edge case surfaced by delta analysis] | [Explicit PM decision] |
```

**Rule**: Every corrective worker that depends on a PM decision must reference its blocker resolution number in its sub-task descriptions (e.g. "Per PM Blocker Resolution #1: implement now, stub is not acceptable").

If a blocker resolution is not yet decided, mark it `⏳ PENDING` and do NOT dispatch the dependent corrective worker until it is resolved.

---

## Opt-Out Rule

Delta Check and PR Review are included in **every** TaskSpec by default. To exclude them, the user must explicitly say so at generation time (e.g. "skip delta check and PR review" or "no PR review this time"). Never omit them silently.

---

## Terminal Task Templates

These two tasks are appended at the end of every TaskSpec, after all implementation Workers.

### DELTA-CHECK — Delta Check & Corrective Dispatch

- **Runtime**: Local (git + bash)
- **Delta Type**: REVIEW
- **Phase**: Terminal
- **Priority**: P0
- **Depends on**: All implementation Workers `✅`

#### Sub-tasks

**DELTA-CHECK.1 — Load acceptance criteria**
- Pull all Worker acceptance criteria from the TaskSpec
- **Acceptance**: Criteria list is complete; no Worker is missing

**DELTA-CHECK.2 — Diff actual output against criteria**
- Run `git diff <base-branch>..HEAD` and map changed files to Workers
- For each Worker: verify every acceptance criterion is satisfied
- **Acceptance**: Every Worker has a verdict (`✅ Aligned` / `⚠️ Drift` / `❌ Missing`)

**DELTA-CHECK.3 — Produce Delta Check Report**
- Write report to `dev_history/<round>/delta_check_report.md`
- Format: `Worker | Status | Findings | Action Required`
- **Acceptance**: Report file exists at confirmed path; every `⚠️` or `❌` has a concrete action item

**DELTA-CHECK.4 — Corrective dispatch (if findings exist)**
- Evaluate scale of findings:
  - ≤5 corrective workers, no new PRD decisions → append workers to current dispatch plan; write corrective reports to `dev_history/<round>_delta/`
  - >5 workers or new PM decisions needed → surface to PM; generate new delta artifact set
- Corrective workers use Delta Type `DRIFT` (execution gap) or `REWORK` (spec mismatch)
- **This is ONE pass. No second delta check runs after corrective workers complete.**
- **Acceptance**: All corrective workers dispatched and complete; Delta Check Report updated to `✅ Aligned` for all Workers

#### AI Auto-Tests
```bash
# Verify report file written
ls -la /absolute/path/dev_history/<round>/delta_check_report.md

# Verify no ❌ or ⚠️ remain
grep -E "⚠️|❌" /absolute/path/dev_history/<round>/delta_check_report.md && echo "ISSUES FOUND" || echo "ALL CLEAR"
```

#### Human Acceptance Criteria
- Delta Check Report exists and every Worker has a verdict
- No `⚠️` or `❌` remain (corrective workers complete if any were needed)
- Corrective worker reports exist at `dev_history/<round>_delta/` if corrective pass occurred
- All corrective commits are pushed to the branch

---

### PR-REVIEW — PR Alignment Review

- **Runtime**: Local (git + bash)
- **Delta Type**: REVIEW
- **Phase**: Terminal
- **Priority**: P0
- **Depends on**: DELTA-CHECK `✅`

#### Sub-tasks

**PR-REVIEW.1 — Collect review inputs**
- Load: PR diff (full `git diff <base>..HEAD`), all PRD documents, TaskSpec acceptance criteria, Delta Check report, all corrective worker reports from `dev_history/<round>_delta/` (if delta pass occurred)
- **Acceptance**: All inputs loaded; no document missing

**PR-REVIEW.2 — Per-file verdict pass**
- Map every changed file to its owning Worker (including corrective workers)
- For each file: check alignment against PRD spec and TaskSpec acceptance criteria
- Flag any unplanned additions (`➕`) or missing implementations (`❌`)
- Flag any corrective worker that exceeded its stated scope (`⚠️ Scope Drift`)
- **Acceptance**: Every changed file has a verdict

**PR-REVIEW.3 — Scope drift summary**
- Write 1–3 sentence net assessment of whether the PR is safe to merge
- End with: `MERGE APPROVED` or `MERGE BLOCKED — [specific reason]`
- **Acceptance**: Summary is present; final verdict line is explicit

**PR-REVIEW.4 — Write PR Review Report**
- Write report to `dev_history/<round>/pr_review_report.md`
- Format: `File | Worker | Verdict | Notes` table + scope drift summary + final verdict
- **Acceptance**: Report file exists at confirmed path; final verdict line is `MERGE APPROVED` or `MERGE BLOCKED`

#### AI Auto-Tests
```bash
# Verify report file written
ls -la /absolute/path/dev_history/<round>/pr_review_report.md

# Verify final verdict line present
grep -E "MERGE APPROVED|MERGE BLOCKED" /absolute/path/dev_history/<round>/pr_review_report.md
```

#### Human Acceptance Criteria
- PR Review Report exists with per-file verdict table
- Scope drift summary is present and clear
- Final verdict is explicit: `MERGE APPROVED` or `MERGE BLOCKED`
- Human reviews the report before performing the actual merge (agent never auto-merges)

Always include a table at the end of the TaskSpec:

````markdown
## Cross-Worker Integration Points

| Producer | Consumer | Contract |
|----------|----------|----------|
| [Worker ID] ([service/endpoint]) | [Worker ID] ([service]) | [Request schema → Response schema] |
````

---

## PM Flags

When generating, identify and surface:
- Execution order conflicts within a batch (e.g. FK cascade risks)
- Business logic edge cases that could be misimplemented (flag with explicit resolution)
- Intentionally vague requirements that need a mock/stub for MVP

Format in both the Dispatch Plan (PM Flags Summary table) and the relevant batch's agent notes block.

---

## Dev History Path Conventions

| Round type | Completion reports | Delta Check report | PR Review report | Corrective worker reports |
|---|---|---|---|---|
| Main round | `dev_history/<round>/[WORKER_ID]_report.md` | `dev_history/<round>/delta_check_report.md` | `dev_history/<round>/pr_review_report.md` | `dev_history/<round>_delta/[WORKER_ID]_report.md` |
| Standalone delta round (>5 workers) | `dev_history/<round>_delta/[WORKER_ID]_report.md` | `dev_history/<round>_delta/delta_check_report.md` | `dev_history/<round>_delta/pr_review_report.md` | N/A — delta round has its own PR Review |

Example using `v3_round` as the round name:
- Main workers → `dev_history/v3_round/R-01_report.md`
- In-plan corrective workers → `dev_history/v3_round_delta/R-13_report.md`
- Standalone delta round → `dev_history/v3.1_delta/R-13_report.md`

---

## Quick Reference: Session Strategy

```
Does this task need context from the previous task?
├── Yes → Inject structured summary into new session
│         └── If context is long (>50 turns) → new session + summary regardless
└── No  → New session (cleaner, avoids contamination)
```

**Accuracy-first**: When in doubt, new session.

---

## Formatting Standards

- Worker IDs: `R-01`, `N-02`, `D-01` (prefix + two-digit number)
- Sub-task IDs: `R-01.1`, `R-01.2`
- All file paths: absolute or repo-root-relative with confirmed root
- Dependency notation: `depends_on: [R-01, D-01]` or column value in dispatch table
- Priority: P0 (blocking), P1 (core), P2 (optional/cleanup)
- Delta type in Worker header: always one of `REWORK / NEW / DELETE / KEEP / DRIFT`
