---
name: taskspec
description: >
  Transforms requirement documents or vague concepts into structured TaskSpec execution plans.
  Use this skill whenever the user mentions "task breakdown", "requirements analysis", "project
  planning", "task list", "work decomposition", "sprint planning", or "how to implement a
  feature/product/system". Also trigger when the user uploads a requirements doc, PRD, or feature
  description, or says things like "help me plan this out", "where do I start with this", "break
  down this requirement", or just "taskspec". Outputs include a complete task list (each with AI
  auto-tests + human acceptance criteria) and a dispatch strategy (serial/parallel dependency
  analysis, worker count, session strategy). Even for vague or half-formed ideas, proactively
  suggest using this skill to systematize the plan. Supports parameters: --append <path> (append
  workers to an existing TaskSpec instead of creating new), --assign-codex (assign all workers to
  Codex model tiers with Required Context blocks). Both can be combined.
version: 1.3.0
---

# TaskSpec Skill

Transforms requirements (documents, PRDs, or rough concepts) into **three executable artifacts** covering the full execution lifecycle from plan to merge:

1. **TaskSpec directory** — a directory under the external Docs tree, at the canonical layout `./Docs/<project>/branch/<taskspec-id>/` (resolved to an absolute path during generation), containing `index.md` (overview, dispatch table, integration points, runtime contracts) and one `<WORKER_ID>.md` file per worker (full definition, sub-tasks, tests, acceptance criteria). Workers read only their own file.
2. **Dispatch Plan** — master dispatch table with batch assignments, model assignments, PR tracking, and completion tracking
3. **Dispatch Command** — the verbatim command file worker sessions receive at the start of every session

The full execution lifecycle is always: **plan → dispatch → branch → execute → self-validate → PR → merge → base-branch resync** (per worker, gated by batch). Each worker creates its own branch, self-validates against its acceptance criteria, opens its own PR, and must not mark the row `✅` until that PR is actually merged into the configured base branch and the local checkout has returned to that base branch. There are no terminal DELTA-CHECK or PR-REVIEW phases — validation is the worker's responsibility.

**Session Isolation Invariant (one session = one task):** A session may execute exactly **one** dispatch row, then it is over. "Task" means **any single row** in the dispatch plan: `PRE-FLIGHT`, implementation workers, batch gates, and verification workers. This applies to every model, including `OPUS`. A short task, a blocked task, or a closely related follow-up task does **not** authorize reuse of the same session. If the next task needs prior context, carry it forward as a structured summary into a **new** session. Each session also creates its own git branch (`<taskspec-id>/<WORKER_ID>`).

**Anti-Collision Protocol (Claim-First):** When multiple worker sessions are dispatched against the same dispatch plan, race conditions are inevitable. The dispatch command enforces a **claim-before-analyze** rule: the moment a worker session identifies its eligible task, it must immediately mark the row `🔄` before performing ANY analysis, code reading, or planning. This prevents two workers from silently working on the same task and wasting cycles. See Step 3.5 in the Dispatch Command for the exact protocol.

---

## Parameters

The taskspec skill accepts optional parameters that modify generation behavior. Parameters are specified by the user when invoking the skill (e.g. `taskspec --append <path>`, `taskspec --assign-codex`, or both together).

### `--append <existing-taskspec-directory>`

**Purpose:** Instead of generating a fresh TaskSpec directory, append new workers to an existing TaskSpec.

**When to use:** When a new PRD, fix PRD, or additional requirements arrive for a project that already has an active TaskSpec. Instead of creating a separate TaskSpec (which fragments dispatch), the new workers are added to the existing one under the existing branch output directory.

**Behavior changes:**

1. **Path Validation Gate (Step 0):** Instead of asking for a new TaskSpec ID, ask for the **absolute path to the existing TaskSpec directory**. Read the existing `index.md` and `dispatch_plan.md` to understand current state (existing workers, batches, version, dependencies).

2. **Worker ID continuation:** New worker IDs continue from the highest existing ID per prefix. E.g. if the existing TaskSpec has `R-01` through `R-09`, new rework workers start at `R-10`. Read the existing dispatch table to determine the next available ID for each prefix (`R-`, `N-`, `D-`, `V-`).

3. **Batch assignment:** New workers are assigned to batches **after** the last existing batch, unless they have no dependencies on existing workers — in which case they may be inserted into an existing batch if logically appropriate. Never reorder or renumber existing batches.

4. **Artifact generation (Step 6):**
   - **`index.md`**: Append new workers to the existing Dispatch Table and Worker File Manifest. Add new Cross-Worker Integration Points and Runtime Contracts if the new workers integrate with existing ones. Bump the version.
   - **Worker files**: Create new `<WORKER_ID>.md` files in the existing directory. Never overwrite existing worker files.
   - **`dispatch_plan.md`**: Append new rows to the Master Dispatch Table. Add new Batch Execution Details sections. Update PRD Reference Paths if new PRDs are referenced. Bump version in header.
   - **`dispatch_command.md`**: Generally unchanged — the existing dispatch command already handles new rows. Update the Round Context Note if the version changes. Add new PRD paths to Environment Configuration if needed.

5. **Version bump:** Increment the minor version (e.g. `v2.4` → `v2.4.1`). Add a changelog entry documenting which workers were appended and why.

6. **Dependency wiring:** New workers may depend on existing workers (by referencing their IDs). Existing workers are never modified — if a new worker needs something from an existing worker's output, model it as a dependency, not as an edit to the existing worker.

**Hard rule:** Never delete, rename, modify, or reorder existing workers, batches, or dispatch rows. Append-only.

### `--assign-codex`

**Purpose:** All generated workers are assigned Codex model tiers instead of OPUS/SONNET, following the assign-codex skill rubric (`/Users/yzliu/work/skills/assign-codex`).

**When to use:** When the execution target is Codex worker sessions rather than Claude models. Eliminates the separate assign-codex step after TaskSpec generation.

**Behavior changes:**

1. **Model Assignment (Step 5):** Instead of assigning `OPUS`/`SONNET` to implementation workers, apply the **Model Tier Rubric** from the assign-codex skill:

   | Tier | Assign when |
   |------|-------------|
   | `CODEX-HIGH` | Well-specified schema work, surgical edits, config/template generation, straightforward tool implementations, UI work with clear API contracts, simple CRUD, standard coordination tasks, moderate integration, pre-flight/environment checks, prompt builders |
   | `CODEX-XHIGH` | IPC/async/socket coordination, multi-file architectural integration, session lifecycle/restart recovery, streaming, terminal review gates (DELTA-CHECK, PR-REVIEW, SUMMARY-GATE), workers with 4+ upstream dependencies with unlocked interfaces, complex async flows, subprocess orchestration |

   **Tiebreaker:** When a worker straddles two tiers, assign the higher tier.

2. **Required Context blocks:** For every worker, generate a `#### Required Context` block following the assign-codex skill's Required Context Authoring Rules (Rules 1–6). This block is inserted immediately after `#### Depends on` and before `#### Sub-tasks` in each worker file.

3. **Worker Identity Declaration:** The dispatch command uses the Codex-tier identity block:
   ```
   Before doing anything else, determine which model you are:
   - If you are Codex (high / gpt-5.4 high) → your worker code is CODEX-HIGH
   - If you are Codex (xhigh / gpt-5.4 xhigh) → your worker code is CODEX-XHIGH
   - If you cannot determine your tier → output `PAUSE — unable to determine worker code` and stop immediately.
   - Rows with Model = PM are human-resolved decision points. You are never PM. Skip these rows.
   - Rows with Model = HUMAN are verification tasks requiring a specific environment. You are never HUMAN. Skip these rows.
   ```

4. **Model Assignment Legend:** The dispatch plan uses the two-tier Codex legend (CODEX-HIGH, CODEX-XHIGH) instead of the OPUS/SONNET legend. The `CODEX` (gpt-5.4 medium) tier is never used — it is unsupported.

5. **Validation:** After generation, verify:
   - No `| OPUS |` or `| SONNET |` remains in any generated artifact
   - No `| CODEX |` (bare, without -HIGH or -XHIGH suffix) remains — gpt-5.4 medium is unsupported
   - Every worker has a `#### Required Context` block
   - The Worker Identity Declaration lists both Codex tiers (CODEX-HIGH, CODEX-XHIGH)
   - The tier rubric was applied (not arbitrary assignments)

### Using both: `--append <path> --assign-codex`

When both parameters are active:

1. Read the existing TaskSpec to understand current state
2. Generate new workers with Codex model tier assignments and Required Context blocks
3. Append new workers/rows/batches to existing artifacts
4. Update the Worker Identity Declaration to the Codex-tier version (if not already updated)
5. Update the Model Assignment Legend to replace OPUS/SONNET with Codex tiers (if not already present)
6. **Existing workers are NOT reassigned** — only new workers get Codex tiers. To reassign existing workers, use the standalone assign-codex skill separately.

---

## Upstream contract

This skill's primary input is a **fix PRD** produced by the **fix** skill (`/Users/yzliu/work/skills/fix`). The fix PRD is located in the **external Docs directory**:

```
<Docs root>/branch/<branch_name>/fix_prd_<version>.md
```

> **Note:** The Docs root is the project's external Docs directory (e.g., `/Users/yzliu/work/Docs/Projects/clawso`), NOT a path inside the project repo. The actual PRD location is confirmed during the Path Validation Gate (Step 0). Always use the absolute path confirmed during path validation.

The fix PRD provides:

- **§0 Traceability & Disposition** — every test finding ID with a disposition (almost all `Fix — this round`).
- **§P Process Fixes** — actionable workflow/gate changes that this TaskSpec must enforce (e.g. new PRE-FLIGHT checks, runtime validation gates, acceptance criteria requirements).
- **§3 Issue Breakdown** — per-issue root cause and recommended solution.
- **§9 Validation Plan** — issue-to-validation mapping that workers must satisfy.

**§P is binding:** Every §P item from the fix PRD must be reflected as a gate, acceptance criterion, or PRE-FLIGHT sub-task in the generated TaskSpec. Do not silently drop process fixes.

## ⚠️ MANDATORY PRE-GENERATION GATE: Path Validation

**Before generating any artifact**, verify every file path referenced in the project. This is non-negotiable.

**Output location rule:** Generated TaskSpec artifacts must live in the external Docs workspace under `./Docs/<project>/branch/<taskspec-id>/` (using the confirmed absolute path for that project). Writing them under the project repository, including `<repo-root>/Docs/...`, is invalid.

### Required information to collect upfront

Ask the user for ALL of the following if not already provided:

| Item | What to ask |
|------|-------------|
| **Repo root** | Absolute path to the project repository (e.g. `/Users/yzliu/work/projects/clawso`) |
| **Docs root** | Absolute path to the project's Docs directory (e.g. `/Users/yzliu/work/Docs/clawso`). All generated TaskSpec artifacts must live under `<Docs root>/branch/<taskspec-id>/` — outside the repo. Never generate them directly inside the project repository. |
| **System overview path** | Path to the system indexed overview directory (default: `<Docs root>/system`). Must contain `SYSTEM_INDEX.md`. |
| **TaskSpec ID** | Identifier for this round (e.g. `v2.4`, `openclaw-fix`). Used as directory name under `<Docs root>/branch/` and as branch prefix (`<taskspec-id>/<WORKER_ID>`). |
| **PRD / input document paths** | Absolute path for every source document referenced in sub-tasks |
| **PR base branch** | Existing branch workers PR into (usually `main`). It must already exist locally or on `origin`. For multi-repo rounds, collect one existing base branch per repo instead of inventing a shared name. |
| **Environment file location** | Path to `.env.local` or equivalent (e.g. `<repo-root>/.env.local`) |
| **Environment variable names** | Exact variable names used in the repo (never assume `DATABASE_URL` exists) |

### Derived paths (do not ask — computed from above)

| Artifact | Derived Path |
|----------|-------------|
| TaskSpec directory | `<Docs root>/branch/<taskspec-id>/` |
| Dispatch plan | `<Docs root>/branch/<taskspec-id>/dispatch_plan.md` |
| Dispatch command | `<Docs root>/branch/<taskspec-id>/dispatch_command.md` |
| Worker files | `<Docs root>/branch/<taskspec-id>/<WORKER_ID>.md` |
| Completion reports | `<Docs root>/branch/<taskspec-id>/reports/<WORKER_ID>.md` |
| System overview | `<Docs root>/system/` |

### Base Branch Existence Gate

Before generating any artifact, verify every configured base branch already exists.

- Single-repo round: verify the one configured `PR base branch`
- Multi-repo round: verify the base branch for each repo in scope
- A base branch may exist locally, on `origin`, or both
- A worker may create a local tracking branch from an existing `origin/<base-branch>` if needed
- A worker must **never** create a brand-new base branch as part of dispatch

If a proposed base branch does not exist locally or on `origin`, stop and ask the user. Do not generate a TaskSpec that names it as a base branch.

Recommended verification commands:

```bash
git -C <repo-root> rev-parse --verify <base-branch>
git -C <repo-root> rev-parse --verify origin/<base-branch>
```

At least one of those checks must succeed for every configured base branch.

### Hard block rule

If ANY path is unclear, ambiguous, assumed, or relative without a known root:

> **STOP. Do not generate any artifact. Ask the user immediately.**

If ANY configured base branch does not already exist locally or on `origin`:

> **STOP. Do not generate any artifact. Ask the user whether to create the branch manually or switch the TaskSpec to an existing base branch.**

Example blocking question:
> "Before I generate the TaskSpec, I need to confirm some file paths. Please provide:
> 1. The absolute repo root path
> 2. The target directory for TaskSpec output
> 3. The absolute path to each PRD document referenced
> 4. The existing base branch name for each repo involved
> I cannot generate accurate dispatch commands with relative or assumed paths."

**Relative paths are forbidden in the generated artifacts.** Use the confirmed absolute Docs path for TaskSpec outputs and the confirmed absolute repo root for source-code paths.

---

## Output Structure Overview

### Artifact 1: TaskSpec directory (`branch/<taskspec-id>/`)

A directory of markdown files. Workers read only their own file; the index provides the full picture for PM and human reviewers.

- **`index.md`** — document header, conflict resolution rule, PM blocker resolutions, compact dispatch table, cross-worker integration points, runtime contracts, worker file manifest
- **`<WORKER_ID>.md`** — one file per worker containing full worker definition, sub-tasks, tests, and acceptance criteria

Contents covered by the index:
1. **Document header** — title, version note, date, input documents list
2. **Conflict resolution rule** — PRD authority declaration (verbatim block)
3. **PM Blocker Resolutions** — any pre-resolved decisions that affect implementation
4. **Dispatch Table** — compact view of all Workers, batches, and dependencies
5. **Cross-Worker Integration Points** — producer/consumer contract table
6. **Runtime Contracts** — shared interfaces and validation rules workers must honor

### Artifact 2: Dispatch Plan (`dispatch_plan.md`)

1. **PRD Reference Paths** — table mapping every shorthand label used in "PRDs to Attach" column to its absolute file path (e.g. `Pipeline PRD` → `/abs/path/to/CLAWSO_MCP_Worker_Deploy_Pipeline_PRD_MVP_v1_0.md`). This is the single source of truth for workers to locate PRD documents.
2. **Model Assignment Legend** — which model handles which task types
3. **Master Dispatch Table** — status + batch + worker + task + model + depends on + TaskSpec file + PRDs to attach + PR (URL + merge status) + notes
4. **Batch Execution Details** — per-batch: workers, priority, model assignments, worker notes, completion gate
5. **PM Flags Summary** — table of all flags raised and their resolutions
6. **Completion Tracking** — table tracking batch start/end dates and report file paths

### Artifact 3: Dispatch Command (`agent_dispatch_command.md`)

Single command file given verbatim to every worker session. Each command invocation may claim **exactly one** eligible row. After that row is completed, blocked, or paused, the worker session stops and waits for a new explicit dispatch command in a **new** session. The session cannot be reused for a second row, even if the next row is eligible for the same model. Contains:
1. **Round context note** — pointer to parent TaskSpec directory
2. **Environment Configuration** — exact env vars, DB validation commands, no-Docker rules
3. **Worker Identity Declaration** — how the worker determines its model code
4. **Step 1–5** — read plan → dependency check → self-check → **claim stamp + branch creation** → read worker file → execute → self-validate → commit/push → open PR → merge PR → resync local base branch → mark `✅` → report → stop
5. **Status Legend** — ⬜ / 🔄 / ✅ / ⛔

---

## Workflow

### Step 0: Path Validation Gate

Run the pre-generation gate above. Do not proceed until all paths are confirmed.

### Step 0.1: System Overview Confirmation

**Before decomposing work into workers**, the skill must confirm the project's system indexed overview with the user.

1. Read `SYSTEM_INDEX.md` from the system overview path
2. Present a summary to the user:
   - Module list (from the module index table)
   - Key inter-module dependencies (from the dependency graph)
   - Last-updated dates (from `[UPDATED]` / `[ADDED]` tags in modules)
3. **User confirms** the overview is current and accurate
4. If the system overview is stale, incomplete, or missing:
   - Flag the issue to the user
   - Ask: proceed without it (workers will grep the repo — higher token cost) or update the system overview first?

**Why this exists:** The system overview gives the skill and the operator a shared understanding of the project architecture. Without it, worker decomposition relies on the operator's memory and the skill's guesses. With it, the skill can auto-extract codebase pointers (file:line references) for each worker, dramatically reducing token waste during execution.

**If the system overview does not exist:** The skill should note this and proceed without codebase pointers. The `Codebase Pointers` section is omitted from worker definitions. Workers fall back to searching the repo.

### Step 0.5: Environment Health Check Gate

**Before any implementation worker runs**, the TaskSpec must include a PRE-FLIGHT worker in Batch 0 that validates the execution environment. This catches pre-existing drift, broken baselines, and environmental assumptions that would block downstream workers mid-execution.

The PRE-FLIGHT worker is **mandatory** whenever the TaskSpec touches any of the following:
- Database migrations (check `pendingLocal`, `remoteOnly`, schema drift)
- Build artifacts (check that the project compiles / builds cleanly on the branch)
- External service configuration (check that required secrets/env vars are accessible)
- Deployment targets (check that target environments are reachable)

If the PRE-FLIGHT check fails, the entire dispatch halts at Batch 0 with a `⛔ BLOCKED` status and a report describing what needs manual repair before workers can proceed. This prevents workers from encountering environment issues mid-execution where they lack the authority or context to fix them safely.

PRE-FLIGHT lives in its own file (`branch/<taskspec-id>/PRE-FLIGHT.md`) and gets its own branch (`<taskspec-id>/PRE-FLIGHT`), following the per-worker file + branch model described in the output structure above.

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
- `V-` = Verify (validate a fix in a physical environment coding workers cannot access — see **Verification Workers** below; use sparingly)

Delta type values:
- `REWORK` — existing code modified to meet new or revised spec
- `NEW` — built from scratch, no prior implementation
- `DELETE` — remove code, validate nothing breaks
- `KEEP` — no change required, listed for dependency tracking
- `DRIFT` — implementation deviated from spec without a conscious decision; no PRD change required, correct the execution
- `VERIFY` — no code change; validate that an implementation worker's fix actually resolves the issue in an environment the coding worker cannot access

Each Worker must specify:
- **Runtime** (Supabase / CF Workers / CF Pages / GitHub Actions / etc.)
- **Delta type** (REWORK / NEW / DELETE / KEEP / DRIFT)
- **Phase** (0 = blocking foundation, 1 = core features, 2 = admin/tooling/cleanup)
- **Priority** (P0 / P1 / P2)
- **Depends on** (other Worker IDs)
- **Sub-tasks** with: description, key constraints, acceptance criteria, reference doc section

Granularity rule: each Worker is completable in **one independent worker session**. More broadly, no worker session may execute more than **one dispatch row of any kind**.

Dispatch session invariant: **one command/session claims exactly one dispatch row total**. After the worker session claims that row, it may only finish it, mark it blocked, or pause because no eligible row exists. It must **not** loop back to the dispatch table to pick up another `⬜` row in the same invocation, even if that row is assigned to the same model or sits in the same batch. Additional work requires a **new explicit dispatch command in a new session**.

**Codebase Pointers (mandatory when system overview exists):** When a system overview exists (confirmed in Step 0.1), the skill **must** perform the following for **every** worker during decomposition — this is not optional:

1. Identify which system overview modules cover the worker's scope (by matching runtime, file paths in Source Scope, or PRD sections to module docs)
2. **Read** those module docs (not just SYSTEM_INDEX.md) and extract: entry points (file:line), key files, function inventories, contracts
3. Embed as a `#### Codebase Pointers` section in the worker definition file
4. If a module doc's Source Scope includes any file the worker will modify, the worker **must** have a Codebase Pointers section — omission is a generation error
5. For new-from-scratch workers where no existing module doc covers the scope, note `Codebase Pointers: N/A — no existing module coverage` in the worker file (do not silently omit)

**Hard rule:** If SYSTEM_INDEX.md lists a module whose Source Scope overlaps with a worker's target files, and the skill does not extract pointers from that module doc into the worker, the generated TaskSpec is invalid. The skill must grep SYSTEM_INDEX.md and each candidate module doc's Source Scope for every file path referenced in the worker's sub-tasks.

### Step 2.5: Verification Workers (use sparingly)

**Default: coding workers verify everything.** Implementation workers (R-/N-/D-) include behavioral assertions (Layer 2) that catch wiring, lifecycle, and correctness bugs without a running app. This is the primary verification mechanism.

**V- workers exist only as a last resort** — when verification truly requires a physical environment the coding worker cannot access: Tauri desktop, real device, production admin console, infrastructure requiring human credentials.

**Why this exists:** Some verification steps physically cannot be performed by a coding worker — they require launching a desktop app, touching a real device, or accessing a production admin console. V- workers make these explicit so they are not silently skipped.

**Two-phase structure (mandatory for all V- workers):**

Every V- worker has two phases that run as separate dispatch rows:

- **Phase A — Automated Service Validation (Model: OPUS or SONNET per rubric):** Code-level behavioral assertions, CLI checks, compilation verification, and wiring confirmation that prove the service logic works. This is a full worker session with sub-tasks, AI auto-tests, and behavioral assertions — identical in rigor to R-/N- workers. Phase A proves the service is correctly wired before any human touches it. Assign OPUS when Phase A requires cross-layer code reading (e.g. tracing Rust→TS→React); assign SONNET when assertions are scoped to a single layer.
- **Phase B — Human GUI Check (Model: HUMAN):** Only visual/interaction verification that genuinely requires a human eye. The service is already proven working by Phase A; the human confirms GUI appearance and interaction behavior only.

**Why two phases:** Delivering untested code to a human verifier wastes their time on bugs that code reading could catch. Phase A eliminates wiring, lifecycle, and correctness bugs first. The human in Phase B only checks what a machine cannot: visual appearance, interaction feel, and physical environment behavior.

**Generation rules:**

1. **Prefer worker verification via behavioral assertions.** Before creating a V- worker, ask: can the coding worker verify this by reading code (Layer 2 behavioral assertion)? If yes, add the assertion to the implementation worker instead.
2. **Group by Verify-Env:** Create one V- worker per distinct physical environment (or per logical group if many items share the same environment).
3. **Depend on implementation workers:** Each V- worker depends on the R-/N- workers that implement the fixes it needs to verify.
4. **Two dispatch rows per V- worker:** In the dispatch table, each V- worker gets two rows: `V-XX-A` (Model: `OPUS` or `SONNET` per Step 5 rubric) and `V-XX-B` (Model: `HUMAN`). Phase B depends on Phase A. Both share one worker file (`V-XX.md`) with Phase A and Phase B sections.
5. **Place in final implementation batch or Ω-1:** V- workers run after all code changes are complete.
6. **Phase A sub-tasks are mandatory:** Each Phase A must include a compilation baseline check plus one sub-task per fix being verified, using code-reading behavioral assertions (grep, read, trace). Phase A also includes AI Auto-Tests (bash commands) that can be run non-interactively.
7. **Phase B is slim:** The human checklist contains only GUI/visual items. Every row that can be verified by code reading must be in Phase A instead.
8. **V- workers must be explicitly completed** — Phase A by OPUS with passing assertions, Phase B by a human with evidence (screenshots, recordings, logs).

### Step 2.6: Decompose Human Acceptance Criteria into Worker-Verifiable Proxies (mandatory)

Every human acceptance criterion that describes runtime behavior must be decomposed into two parts:

1. **Worker-verifiable proxy** — a behavioral assertion the coding worker CAN verify by reading code. For implementation workers, this goes into Layer 2 Behavioral Assertions. **For V- workers, this becomes a Phase A sub-task** — the OPUS session verifies it before the human ever touches the app.
2. **Human-only verification** — the residual that truly requires a running app, visual inspection, or specialized environment (stays in V- worker Phase B checklist)

**Why this exists:** Without this decomposition, the entire quality burden falls on human V- workers at the end of the pipeline. Workers may otherwise treat "tests passed" as enough to declare success, and 100% of runtime correctness is deferred to a single human gate. This decomposition shifts behavioral verification left — workers catch wiring/ordering/lifecycle bugs early, humans verify visual/UX/integration behavior.

**Routing rule for V- workers:** The "worker-verifiable proxy" column maps directly to Phase A sub-tasks. Each proxy becomes a named sub-task (e.g., `V-01.A3 — R-04 (Loading): Verify deferred IPC`) with concrete code-reading checks and an acceptance criterion. The "human-only residual" column maps to Phase B checklist rows.

**Example decomposition:**

| Human criterion | Worker-verifiable proxy → **V- Phase A sub-task** | Human-only residual → **V- Phase B row** |
|---|---|---|
| "Progress bar shows with phase text" | V-01.A2: Verify `bootstrapProgress` state is set by listener callback; listener is `await`ed before command; progress bar element renders when state is non-null | Visual: progress bar animates smoothly, phase text is readable |
| "Auto-advances to Step 2" | V-01.A3: Verify `onAutoAdvance` callback is called after bootstrap promise resolves; `detectWizardStep` is re-invoked on state change | Runtime: step transition happens within 1s of completion |
| "No developer jargon on main view" | V-01.A4: Verify strings "PID", "probe", "config path" do not appear in any step component JSX (only in AdvancedPanel) | Visual: confirm no technical terms visible to user |
| "Uninstall resets to Step 1" | V-01.A5: Verify uninstall success handler calls state reset function; reset sets step to "install" | Runtime: page visually returns to install state |

**Rule:** If a human criterion has zero worker-verifiable proxy (it's purely visual/tactile), note it as `(no proxy — human-only)` in the V- worker Phase B checklist. But most criteria have at least a partial proxy. The goal is to maximize what Phase A proves so that Phase B catches only what it uniquely can.

**V- worker template (two-phase, use sparingly):**

Both phases live in a single worker file (`V-XX.md`). The dispatch table has two rows per V- worker.

````markdown
### V-01 — Tauri Desktop Verification

- **Runtime**: Local CLI + Tauri desktop
- **Delta Type**: VERIFY
- **Phase**: [same as final implementation batch or Ω-1]
- **Priority**: P0
- **Depends on**: [R-XX, R-YY — the workers that implement the fixes]
- **Branch**: `<taskspec-id>/V-01`

This worker has two phases: an **automated service validation** (OPUS) that proves every fix is correctly wired at the code level, followed by a **human GUI check** that only verifies visual/interaction behavior.

---

## Phase A — Automated Service Validation (Model: OPUS or SONNET per Step 5 rubric)

Prove each fix works at the code and CLI level before any human touches the GUI.

#### Sub-tasks

**V-01.A1 — Compilation baseline**
- `cargo check` / `npx tsc --noEmit` — zero errors
- **Acceptance**: Clean compilation with all dependent workers' changes merged

**V-01.A2 — [Fix ID] ([Fix Name]): Verify [specific behavior]**
- Read `[file]` — confirm [specific code-level property]
- Grep: [pattern] exists / does not exist in [file]
- [Additional code-reading checks specific to this fix]
- **Acceptance**: [Concrete acceptance criterion provable by code reading]

**V-01.A3 — [Fix ID] ([Fix Name]): Verify [specific behavior]**
- [Same pattern as A2, one sub-task per fix being verified]

**V-01.AN — Cross-worker integration check** *(include when V- worker covers multiple implementation workers)*
- Verify cross-worker wiring points from Runtime Contracts
- **Acceptance**: All integration points verified

#### AI Auto-Tests
```bash
# Compilation
cd <rust-dir> && cargo check 2>&1 | tail -10
cd <repo-root> && npx tsc --noEmit 2>&1 | tail -10

# Per-fix grep/structural checks
grep -n "[pattern]" [file] | head -5
# [additional non-interactive bash checks]
```

---

## Phase B — Human GUI Check (Model: HUMAN)

**Prerequisite**: Phase A must be ✅. All service logic proven correct by automated validation. Human only checks visual/interaction behavior that cannot be verified by code reading.

#### GUI Verification Checklist

| Fix ID | What to verify (GUI-only) | Expected visual result | Actual result | Pass/Fail |
|--------|--------------------------|----------------------|---------------|-----------|
| e | Enter invalid Git URL in Packager | Error shown; cancel button works | *(filled by verifier)* | |
| f | Check dock/taskbar icon | Clawso branding, not default Tauri icon | *(filled by verifier)* | |

#### Completion criteria
- Phase A: All automated checks pass (OPUS marks Phase A ✅)
- Phase B: Every GUI row has Actual result + Pass/Fail filled by human
- Any Fail triggers a follow-up worker (appended via `--append`)
````

**Dispatch table integration (two rows per V- worker):**

| Status | Batch | Worker | Task | Model | Depends On | Notes |
|--------|-------|--------|------|-------|------------|-------|
| ⬜ | Ω-1 | V-01-A | Tauri Desktop: Automated Service Validation | OPUS | R-09 | Cross-layer (Rust+TS+React) verification |
| ⬜ | Ω-1 | V-01-B | Tauri Desktop: GUI Check | HUMAN | V-01-A | Visual-only; service already proven by V-01-A |
| ⬜ | Ω-1 | V-02-A | Infrastructure: Automated Service Validation | SONNET | R-02 | Single-layer config verification |
| ⬜ | Ω-1 | V-02-B | Infrastructure: GUI Check | HUMAN | V-02-A | Visual-only |

### Step 3: Test Spec Design

Each Worker requires three testing layers.

**Layer 1: AI Auto-Tests (Compilation + Structural)** — verifies the code compiles and expected artifacts exist:
```bash
# All commands use absolute paths or confirmed env vars
export $(grep -v '^#' /absolute/path/.env.local | xargs)
cd apps/client/src-tauri && cargo check 2>&1 | tail -10
cd /repo/root && npx tsc --noEmit 2>&1 | tail -10
```

**Layer 2: AI Behavioral Assertions (mandatory)** — verifies runtime correctness WITHOUT executing the app. These catch the bugs that compile-only tests miss. Each assertion is a concrete check the worker performs by reading the code:

```markdown
#### Behavioral Assertions
# Event listener lifecycle
- Verify: listener registration is `await`ed before the command that triggers events is called
- Verify: listener cleanup (unlisten) is called in useEffect return / component unmount
- Verify: no fire-and-forget pattern on async listener setup

# Prop drilling completeness
- Verify: every value computed at parent level and needed by a child is passed as a prop
- Verify: no orphan computations (computed but never consumed by any child or render path)

# Async/sync correctness
- Verify: no synchronous blocking calls (std::process::Command) inside async Tauri commands
- Verify: all IPC commands have timeout or cancellation mechanisms on the frontend
- Verify: error paths propagate to UI (no silent swallowing of rejections)

# State update reachability
- Verify: every user-facing state (loading, error, success) is reachable via a code path
- Verify: state transitions are ordered correctly (can't go from "idle" to "success" without passing through "loading")

# Cross-worker contract
- Verify: event names emitted by Rust match event names listened for in TypeScript (exact string match)
- Verify: Rust struct field names (snake_case) map to TypeScript field names (camelCase via serde)
- Verify: optional fields in Rust (`Option<T>`) are handled as potentially undefined in TypeScript
```

**Anti-pattern — verification theater:** If an AI auto-test could pass on an empty file that happens to contain the right function name as a string, the test is invalid. Every auto-test must verify a behavioral property, not just string existence. `grep -n "functionName" file.ts` alone is NOT an acceptable auto-test — it must be paired with a behavioral assertion about how that function is called, what it returns, or how its output is consumed.

**Layer 3: Human Acceptance Criteria** — 2–5 bullet points of observable behavior a human reviewer confirms. For each criterion, include a parenthetical noting which behavioral assertions serve as a proxy:
```markdown
- Progress bar shows with phase text, no raw terminal (proxied by: listener lifecycle + state reachability assertions)
- Auto-advances to Step 2 after install (proxied by: onAutoAdvance call path assertion)
```

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

**Batch gate rule:** All batch N workers' PRs must be merged to main before batch N+1 workers can start. Workers in batch N+1 always branch from a main that contains all prior batch work.

### Step 4.5: Batch Integration Gate (mandatory when batch has cross-worker dependencies)

After each batch gate (all workers in the batch `✅`), before proceeding to the next batch, the dispatch command must include a **Batch Integration Verification** step. This is a lightweight check that catches wiring issues between workers in the completed batch before downstream workers build on a broken foundation.

**When to include:** Include a batch integration gate when the batch contains 2+ workers that edit the same file, or when the next batch's workers depend on outputs from multiple workers in this batch.

**What it checks (worker-executable, no runtime needed):**
1. **Compilation still passes** after all batch workers' changes are merged
2. **Cross-worker behavioral assertions** from the Runtime Contracts section are satisfied (e.g., event listener ordering, data shape alignment)
3. **No orphan code** — values computed by one worker and expected by another are actually wired (not computed-but-never-passed or imported-but-never-called)

**Batch Integration Gate Template:**

````markdown
### BATCH-N-GATE — Batch N Integration Verification

- **Runtime**: Local (bash + code reading)
- **Delta Type**: REVIEW
- **Phase**: N (runs after all Batch N workers complete)
- **Priority**: P0
- **Depends on**: [all Batch N workers]
- **Model**: SONNET

#### Sub-tasks

**BATCH-N-GATE.1 — Compilation check**
- Run build/typecheck after all batch workers' changes
- **Acceptance**: Zero compilation errors

**BATCH-N-GATE.2 — Cross-worker wiring verification**
- For each Runtime Contract involving workers in this batch:
  - Verify producer event names match consumer listener names (exact string)
  - Verify async ordering invariants (listener before command, cleanup on unmount)
  - Verify computed values flow to consumers (no orphan computations)
- **Acceptance**: All Runtime Contract behavioral assertions pass

**BATCH-N-GATE.3 — Report**
- If any check fails: report findings and **STOP with `⛔ BLOCKED`** — do not proceed to Batch N+1
- If all pass: mark gate `✅` and proceed
````

BATCH-N-GATE runs on its own branch (`<taskspec-id>/BATCH-N-GATE`) and creates its own PR, following the per-worker file + branch model.

**Why this exists:** The openclaw-fix incident had 9 workers across 3 batches, all self-certifying `✅`. No integration check ran until V-01 (human verification) at the very end. By then, accumulated wiring issues between workers made every feature non-functional despite clean compilation. Batch integration gates catch these issues incrementally, when they're cheap to fix.

### Step 5: Model Assignment (per-worker evaluation mandatory)

| Model | Code | Assign When |
|-------|------|-------------|
| Claude Opus 4.6 | `OPUS` | Complex multi-file refactoring, cross-layer coordination (Rust + TS + React in one worker), nuanced business logic requiring architectural judgment, workers that define interfaces consumed by 3+ downstream workers |
| Claude Sonnet 4.6 | `SONNET` | Well-specified rework with clear acceptance criteria, moderate integration (2-3 file touchpoints), config/template generation, UI work with clear API contracts, straightforward tool implementations, pre-flight/environment checks, batch integration gates, simple CRUD, dead code removal |
| Human (Verify) | `HUMAN` | Assigned to V- worker Phase B rows only. Phase A rows use `OPUS` or `SONNET` based on complexity. Use V- workers sparingly — only when verification truly requires a physical environment (Tauri desktop, real device, production admin) that coding workers cannot access. |

**Per-Worker Model Evaluation Gate (mandatory):**

The skill must evaluate EVERY worker individually against this rubric during generation. Blanket-assigning `OPUS` to all workers is a generation error. For each worker, apply this decision flow:

```
Does this worker require cross-layer coordination (e.g. Rust + TS + React)?
├── Yes → OPUS
└── No → Does it define interfaces consumed by 3+ downstream workers?
    ├── Yes → OPUS
    └── No → Does it involve architectural decisions or nuanced business logic?
        ├── Yes → OPUS
        └── No → SONNET
```

**Tiebreaker:** When a worker straddles OPUS and SONNET, assign OPUS. Under-provisioning causes subtle failures; over-provisioning costs more but completes correctly.

**Validation:** After generating the dispatch plan, verify:
- Not every implementation worker is assigned `OPUS` — if they are, re-evaluate each one against the rubric and document why OPUS is justified for workers that could be SONNET
- PRE-FLIGHT and BATCH-N-GATE workers default to `SONNET` unless they involve multi-runtime coordination
- V- worker Phase A rows use `OPUS` or `SONNET` based on the complexity of the code-reading assertions

> **Note:** PM decisions are resolved pre-generation or via inline `⛔ BLOCKED` status when a worker hits an ambiguity. There is no separate PM model assignment.

### Step 6: Generate Artifacts

Generate in order: TaskSpec `index.md` → individual worker files (`<WORKER_ID>.md`) → Dispatch Plan → Dispatch Command.

---

## TaskSpec: Worker Definition Template

Each worker definition lives in its own file (`branch/<taskspec-id>/<WORKER_ID>.md`).

````markdown
### [WORKER_ID] — [Worker Name]

- **Runtime**: [Supabase PostgreSQL / CF Workers / CF Pages / GitHub Actions]
- **Delta Type**: [REWORK / NEW / DELETE / KEEP / DRIFT]
- **Phase**: [0 / 1 / 2]
- **Priority**: [P0 / P1 / P2]
- **Depends on**: [Worker IDs or —]
- **Branch**: `<taskspec-id>/<WORKER_ID>`

#### Sub-tasks

**[WORKER_ID].1 — [Sub-task name]**
- [Detailed implementation description]
- **Key constraint**: [Any hard rule or business logic constraint]
- **Acceptance**: [Verifiable completion condition]
- **Ref**: [PRD document § section]

**[WORKER_ID].2 — [Sub-task name]**
...

**[WORKER_ID].N — Update System Overview** *(mandatory — every worker must include this sub-task)*
- Check which system overview module docs (at `<system-overview-path>/modules/`) cover files this worker modified
- For each affected module doc:
  - Update file:line references if lines shifted
  - Update route/contract inventory if endpoints changed
  - Update function signatures or type definitions if they changed
  - Add new entries with `[ADDED <date>]` tag
  - Mark removed entries with `[REMOVED <date>]` tag (per FORMAT_SPEC.md)
- If no documented paths were affected, explicitly state: "No system overview updates needed — verified `<module-doc-name>` Source Scope does not cover modified files" (the worker must still check, not assume)
- **Acceptance**: All modified file:line references in the system overview are accurate post-change; worker has explicitly confirmed which module docs were checked
- **Key constraint**: Follow FORMAT_SPEC.md tagging rules (`[ADDED ISO]`, `[UPDATED ISO]`, `[REMOVED ISO]`)

> **Generation-time rule for the skill:** When generating worker files, the skill must always include this sub-task as the final sub-task for every R-/N-/D- worker. It is never optional. If the worker's Codebase Pointers section references a module doc, pre-populate the module doc path in this sub-task so the worker knows exactly which file to check. If no Codebase Pointers exist (no system overview), still include the sub-task with the note: "System overview not available — skip this sub-task."

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

#### Codebase Pointers (from system overview — mandatory when module coverage exists)

*Auto-extracted from system overview modules during TaskSpec generation. The skill must read each candidate module doc's Source Scope and include pointers for every worker whose target files overlap. If no system overview exists, replace this section with: `Codebase Pointers: N/A — no system overview available`.*

- **Module doc**: `[absolute path to the system overview module doc covering this worker's scope]`
- **Entry point**: `[file:line — primary file the worker will modify]`
- **Key files**: `[comma-separated list of files relevant to this worker's scope]`
- **Contracts**: `[API routes, events, or IPC commands this worker must honor — with module doc reference]`
- **Functions touched**: `[function names from the module doc's function inventory that this worker modifies]`
- **Module doc**: `[absolute path to the system overview module doc covering this worker's scope]`
````

---

## Pre-flight Worker Template (mandatory Batch 0)

Every TaskSpec that touches database, build, or deployment systems must include a PRE-FLIGHT worker as the first entry in Batch 0. This worker runs before all other workers and gates the entire dispatch on environment health.

PRE-FLIGHT lives in `branch/<taskspec-id>/PRE-FLIGHT.md` and gets branch `<taskspec-id>/PRE-FLIGHT`.

````markdown
### PRE-FLIGHT — Environment Health Check

- **Runtime**: Local (bash)
- **Delta Type**: REVIEW
- **Phase**: 0
- **Priority**: P0
- **Depends on**: —
- **Branch**: `<taskspec-id>/PRE-FLIGHT`

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
| Status | Batch | Worker | Task | Model | Depends On | TaskSpec File | PRDs | PR | Notes |
|--------|-------|--------|------|-------|------------|---------------|------|-----|-------|
| ⬜ | 0 | PRE-FLIGHT | Env Health Check | SONNET | — | branch/<taskspec-id>/PRE-FLIGHT.md | — | — | |
| ⬜ | 1 | R-01 | [Task name] | SONNET | — | branch/<taskspec-id>/R-01.md | Main PRD | — | |
| ⬜ | 1 | N-02 | [Task name] | OPUS | — | branch/<taskspec-id>/N-02.md | Main PRD, Admin PRD | — | Multi-file architectural work |
````

Status values: `⬜` Not started · `🔄` In progress / PR open but not yet merged · `✅` Complete (merged to base branch, local checkout returned to base) · `⛔` Blocked

---

## Dispatch Command: Required Sections

The dispatch command must include all of the following in exact order:

### 0. Round Context Note

At the very top of the dispatch command, include a brief context block:

```
## Round Context

TaskSpec ID: [e.g. v2.4]
Docs Root: [e.g. /Users/yzliu/work/Docs/clawso]
Repo Root: [e.g. /Users/yzliu/work/projects/clawso]
System Overview: [e.g. /Users/yzliu/work/Docs/clawso/system]
PR Base Branch: [e.g. main]

TaskSpec Directory: <Docs Root>/branch/<TaskSpec ID>/
Worker files: <TaskSpec Directory>/<WORKER_ID>.md
Dispatch plan: <TaskSpec Directory>/dispatch_plan.md
Reports: <TaskSpec Directory>/reports/<WORKER_ID>.md

Workers create branches as: <TaskSpec ID>/<WORKER_ID>
Workers PR into: <PR Base Branch>
Source code changes go to: <Repo Root> (on the worker's branch)
Reports and dispatch plan updates go to: <TaskSpec Directory> (not in the repo)
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
- Note that TaskSpec artifacts, reports, and dispatch plans live in the external Docs directory (not in the repo) — no `git add` needed for those files
- **Harness clarification** (mandatory whenever startup, bootstrap, or recovery behavior matters): describe it directly in the dispatch command using confirmed project-local commands and paths. The TaskSpec must remain self-contained.

**TaskSpec Harness Boundary Rule:**

The dispatch command is the harness. If a project needs startup validation, bootstrap commands, repair steps, or retry boundaries, write them explicitly inside the TaskSpec artifacts themselves using confirmed project-local paths and commands.

If a startup or recovery path is mechanical and project-local, include the exact detection rule, repair command, and retry boundary directly in the dispatch command.

If recovery depends on missing project facts, hidden context, or external access outside the TaskSpec scope, PRE-FLIGHT must mark the work blocked and stop. Do not rely on any separate convention file, bootstrap layer, or out-of-band framework to fill the gap.

**Why this exists:** TaskSpec must be the only execution harness. A dispatched worker should be able to proceed from the TaskSpec artifacts alone, without injected context or undocumented startup behavior.

### 2. Worker Identity Declaration

```
Before doing anything else, determine which model you are:
- If you are Claude Opus 4.6 → your worker code is OPUS
- If you are Claude Sonnet 4.6 → your worker code is SONNET
- If you are Codex → your worker code is CODEX (only when --assign-codex was used)
- Rows with Model = HUMAN are verification tasks requiring a physical environment. You are never HUMAN. Skip these rows.
```

### 3. Step 1 — Read the Dispatch Plan

Point to confirmed absolute path of dispatch plan. Worker finds the first row where:
1. Status is `⬜`
2. Model column matches its code
3. All `Depends On` workers are `✅`
4. All `Depends On` workers' PRs are merged to the base branch (PR column shows merge status)

If no such row exists, output `⏸ PAUSE — no eligible row for [MODEL]` and stop. Do **not** keep scanning for extra work or infer permission to bundle multiple rows into one session.

This selection happens **once per command invocation** and therefore **once per session**. Claim only that single row. Do **not** return to Step 1 after completion. If a follow-up row becomes eligible, it belongs to a **new** dispatch command and a **new** session.

### 4. Step 2 — Dependency Check

Block with `⛔ BLOCKED` message if any dependency is not `✅` or if any dependency's PR is not yet merged to the base branch.

### 5. Step 3 — Self-Check

Pause with `⏸ PAUSE` if the next task belongs to the other model.

### 5.5. Step 3.5 — Claim Stamp & Branch Creation

> **This is the single most time-critical step in the entire dispatch flow.**

Immediately after passing Self-Check — before reading ANY source code, before analyzing the task, before opening any project files — the worker session must:

**3.5a: Claim stamp (anti-collision lock)**
1. Open the dispatch plan file
2. Change the claimed row's status from `⬜` to `🔄`
3. The claim lock covers **that one row only**

**3.5b: Create worker branch**
1. `git fetch origin <PR-base-branch>`
2. `git checkout -b <taskspec-id>/<WORKER_ID> origin/<PR-base-branch>`
3. Verify the branch is clean and based on latest base branch

**Rule:** `<PR-base-branch>` must already exist locally or on `origin` before dispatch begins. Workers may create a local tracking branch from an existing remote base branch, but they must never invent or create a brand-new base branch.

**Only then** proceed to Step 4 (Execute).

**Why claim is mandatory and first:**
- Multiple worker sessions may be dispatched simultaneously against the same dispatch plan
- If a worker session reads the plan, finds an eligible row, then spends time analyzing the codebase before marking `🔄`, another worker session can pick the same row during that analysis window
- Analysis, file reading, and planning happen **AFTER** the claim and branch creation, never before

### 6. Step 4 — Read Worker File & Execute

- Read `branch/<taskspec-id>/<WORKER_ID>.md` for the full worker definition (sub-tasks, tests, acceptance criteria)
- If cross-worker context is needed, read `branch/<taskspec-id>/index.md` for runtime contracts and integration points
- PRD is the authority over TaskSpec
- Run AI Auto-Tests after each sub-task
- Run Behavioral Assertions (Layer 2) to verify correctness
- Scope discipline: no touching files outside the Worker's scope
- Before committing: if your changes affect any file, route, contract, or entry point documented in the system overview modules, update those module docs following FORMAT_SPEC.md tagging rules. System overview path: `<system-overview-path>`
- Blockers → mark `⛔ BLOCKED` in dispatch plan with question in Notes, STOP session

### 7. Step 5 — Completion, PR, Merge, Base Resync

5a: Run all AI Auto-Tests from the worker file one final time
5b: Run all Behavioral Assertions from the worker file
5c: If any fail → attempt to fix. If still failing → mark `⛔ BLOCKED`, document in Notes, STOP
5d: Git commit with structured message: `[WORKER_ID] <task summary>`
5e: Push branch to origin: `git push -u origin <taskspec-id>/<WORKER_ID>`
5f: Create PR:
    ```
    gh pr create --base <PR-base-branch> --title "[WORKER_ID] — <task name>" --body "$(cat <<'EOF'
    ## [WORKER_ID] — <Task Name>

    **TaskSpec**: `branch/<taskspec-id>/<WORKER_ID>.md`
    **Batch**: N
    **Depends on**: [Worker IDs]

    ### Changes
    - [Generated from sub-task list]

    ### Validation
    - [x] AI Auto-Tests passed
    - [x] Behavioral Assertions passed

    Generated by TaskSpec dispatch
    EOF
    )"
    ```
5g: Record the PR URL in the dispatch plan's PR column and leave the row `🔄` until merge is complete
5h: Merge the PR into the base branch. Prefer an explicit non-interactive merge command such as:
    `gh pr merge --merge --delete-branch=false <PR-number-or-URL>`
5i: If the PR does not merge immediately because checks, approvals, or conflicts are still pending, do **not** mark `✅`. Leave the row `🔄`, update Notes with the merge blocker, write the report, and stop.
5j: After the PR is merged, resync the local repo to the base branch:
    1. `git fetch origin <PR-base-branch>`
    2. `git checkout <PR-base-branch>`
    3. `git pull --ff-only origin <PR-base-branch>`
5k: Only after the merged commit is present on the local base-branch checkout, update the dispatch plan status to `✅`
5l: Write completion report to `<Docs root>/branch/<taskspec-id>/reports/<WORKER_ID>.md`
    **Note:** Source code commits go to the repo branch. Report writes and dispatch plan updates go to the external Docs directory — they are NOT committed to the repo.
5m: **Stop immediately and end the session.** Do not re-open Step 1, do not claim another row. A new row requires a new explicit dispatch command in a **new** session.

---

## Branch Naming Convention

Every worker gets its own branch:

```
<taskspec-id>/<WORKER_ID>
```

Examples: `v2.4/R-01`, `v2.4/N-02`, `v2.4/PRE-FLIGHT`, `v2.4/BATCH-2-GATE`

Workers in batch N+1 create their branch from the PR base branch (usually `main`) AFTER all batch N PRs are merged.

---

## PR Template

Workers create PRs using `gh pr create` with this body template:

````markdown
## [WORKER_ID] — <Task Name>

**TaskSpec**: `branch/<taskspec-id>/<WORKER_ID>.md`
**Batch**: N
**Depends on**: [Worker IDs]

### Changes
- [Generated from sub-task list]

### Validation
- [x] AI Auto-Tests passed
- [x] Behavioral Assertions passed

Generated by TaskSpec dispatch
````

---

## Conflict Resolution Rule (mandatory verbatim block in TaskSpec)

Include this exact block under `## 冲突処理規則` (or `## Conflict Resolution Rules`) near the top of the TaskSpec:

> PRD document > This TaskSpec > Previous implementation. Any discrepancy with the PRD must defer to the MVP PRD set. Requirements not defined in the PRD: developer must pause and file an issue; do not proceed until PM provides a clear definition.

---

## TaskSpec Index Template (`branch/<taskspec-id>/index.md`)

The index file is the master overview for PM/human review and cross-worker context. Workers do NOT read this during execution — they read only their own `branch/<taskspec-id>/<WORKER_ID>.md` file. The index is consulted only when a worker needs cross-worker integration details.

````markdown
# TaskSpec — [Project Name] [Version]

**Date**: [date]
**Input documents**: [list with absolute paths]
**TaskSpec ID**: [e.g. v2.4]
**PR base branch**: main

## Conflict Resolution Rule

> PRD document > This TaskSpec > Previous implementation. Any discrepancy with the PRD must defer to the MVP PRD set. Requirements not defined in the PRD: developer must pause and file an issue; do not proceed until PM provides a clear definition.

## Dispatch Table (Overview)

| Batch | Worker | Task | Model | Depends On | File |
|-------|--------|------|-------|------------|------|
| 0 | PRE-FLIGHT | Env Health Check | SONNET | — | branch/<taskspec-id>/PRE-FLIGHT.md |
| 1 | R-01 | [Task] | SONNET | — | branch/<taskspec-id>/R-01.md |

## Worker File Manifest

| Worker | File Path (relative to Docs root) | Branch |
|--------|-----------|--------|
| PRE-FLIGHT | branch/<taskspec-id>/PRE-FLIGHT.md | <taskspec-id>/PRE-FLIGHT |
| R-01 | branch/<taskspec-id>/R-01.md | <taskspec-id>/R-01 |

## Cross-Worker Integration Points

| Producer | Consumer | Contract |
|----------|----------|----------|
| [Worker ID] ([service/endpoint]) | [Worker ID] ([service]) | [Request → Response] |

## Runtime Contracts

[Full runtime contracts for async/event/IPC integrations — see Runtime Contracts template below]
````

---

## PM Blocker Resolutions

When decisions were deferred from a previous round or resolved during pre-generation review, include a `## PM Blocker Resolutions` section immediately after the Conflict Resolution Rule. This section captures those decisions so workers have explicit guidance.

Format:

```markdown
## PM Blocker Resolutions

| # | Question | Resolution |
|---|----------|------------|
| 1 | [Deferred question from previous round] | [Explicit PM decision — do not leave blank] |
| 2 | [Edge case resolved during pre-generation] | [Explicit PM decision] |
```

**Rule**: Every worker that depends on a PM decision must reference its blocker resolution number in its sub-task descriptions (e.g. "Per PM Blocker Resolution #1: implement now, stub is not acceptable").

If a blocker resolution is not yet decided, mark it `⏳ PENDING` and do NOT dispatch the dependent worker until it is resolved.

Always include a table at the end of the TaskSpec:

````markdown
## Cross-Worker Integration Points

| Producer | Consumer | Contract |
|----------|----------|----------|
| [Worker ID] ([service/endpoint]) | [Worker ID] ([service]) | [Request schema → Response schema] |
````

Immediately after the integration points table, include a **Runtime Contract** section for every cross-worker integration point that involves async operations, events, or IPC:

````markdown
## Runtime Contracts (mandatory for async/event/IPC integration points)

### [Producer Worker] → [Consumer Worker]: [Integration name]

**Producer emits:**
- Event/command: `[exact event name or IPC command]`
- Payload: `{ field1: type, field2: type }` (Rust snake_case → TS camelCase via serde)
- Timing: [when this fires relative to the overall flow — e.g., "immediately on function entry", "after async operation completes"]

**Consumer expects:**
- Listener registered: [when — e.g., "in useEffect on mount", "awaited before command invocation"]
- Listener teardown: [when — e.g., "useEffect cleanup", "after promise resolves"]
- Data consumed as: [how the payload is used — e.g., "setState update", "prop passed to child"]

**Failure mode:**
- If producer fires before consumer registers: [what happens — e.g., "event lost, progress bar stuck at 0%"]
- If producer errors: [what the consumer sees — e.g., "promise rejection caught in .catch, error state shown"]
- If consumer unmounts mid-flow: [what happens — e.g., "unlisten called, Rust command continues but events are dropped"]

**Ordering invariant:**
```
[Step 1]: Consumer registers listener (MUST await)
[Step 2]: Consumer invokes producer command
[Step 3]: Producer emits events (safe — listener is registered)
[Step 4]: Consumer processes events
[Step 5]: Consumer cleans up listener
```
````

**Why Runtime Contracts exist:** The openclaw-fix incident demonstrated that Cross-Worker Integration Points verified only by type compilation (struct fields match) can still fail at runtime due to timing, ordering, and lifecycle issues. Runtime Contracts force the TaskSpec to specify the behavioral contract — not just the data shape — so that both producer and consumer workers implement the same flow.

---

## PM Flags

When generating, identify and surface:
- Execution order conflicts within a batch (e.g. FK cascade risks)
- Business logic edge cases that could be misimplemented (flag with explicit resolution)
- Intentionally vague requirements that need a mock/stub for MVP

Format in both the Dispatch Plan (PM Flags Summary table) and the relevant batch's worker notes block.

---

## Dev History Path Conventions

All artifacts live in the **external Docs directory**, NOT in the project repository. The canonical layout is `./Docs/<project>/branch/<taskspec-id>/` resolved to an absolute path such as `/Users/yzliu/work/Docs/clawso/branch/v2.4/`. The repo contains only source code.

**Docs base path:** `<Docs root>/branch/<taskspec-id>/`

| Artifact | Path |
|----------|------|
| TaskSpec index | `<Docs root>/branch/<taskspec-id>/index.md` |
| Worker definitions | `<Docs root>/branch/<taskspec-id>/<WORKER_ID>.md` |
| Dispatch plan | `<Docs root>/branch/<taskspec-id>/dispatch_plan.md` |
| Dispatch command | `<Docs root>/branch/<taskspec-id>/dispatch_command.md` |
| Completion reports | `<Docs root>/branch/<taskspec-id>/reports/<WORKER_ID>.md` |
| System overview | `<Docs root>/system/` |

Example using Docs root `/Users/yzliu/work/Docs/clawso`, TaskSpec ID `v2.4`:
- TaskSpec index → `/Users/yzliu/work/Docs/clawso/branch/v2.4/index.md`
- Worker file → `/Users/yzliu/work/Docs/clawso/branch/v2.4/R-01.md`
- Dispatch plan → `/Users/yzliu/work/Docs/clawso/branch/v2.4/dispatch_plan.md`
- Report → `/Users/yzliu/work/Docs/clawso/branch/v2.4/reports/R-01.md`
- System overview → `/Users/yzliu/work/Docs/clawso/system/SYSTEM_INDEX.md`

---

## Quick Reference: Session Strategy

Every new dispatch row starts in a **new session**. Reusing context never permits reusing the same session.

```
Does the next task need context from the previous task?
├── Yes → Inject structured summary into a new session
│         └── If context is long (>50 turns) → new session + summary regardless
└── No  → New session
```

**Accuracy-first**: When in doubt, new session.

---

## Formatting Standards

- Worker IDs: `R-01`, `N-02`, `D-01`, `V-01` (prefix + two-digit number)
- Sub-task IDs: `R-01.1`, `R-01.2`
- All file paths: absolute or repo-root-relative with confirmed root
- Dependency notation: `depends_on: [R-01, D-01]` or column value in dispatch table
- Priority: P0 (blocking), P1 (core), P2 (optional/cleanup)
- Delta type in Worker header: always one of `REWORK / NEW / DELETE / KEEP / DRIFT / VERIFY`
