# System Overview Integration & External Docs Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add system overview integration, move all artifacts to external Docs directory, add codebase pointers to workers, and mandate system overview updates.

**Architecture:** Sequential edits to `/Users/yzliu/work/skills/taskspec/SKILL.md`. Three features woven into existing sections: (1) system overview pre-gen gate + confirmation step, (2) external Docs paths replacing in-repo paths, (3) codebase pointers + mandatory update sub-task.

**Tech Stack:** Markdown skill file at `/Users/yzliu/work/skills/taskspec/SKILL.md`

**Design doc:** `/Users/yzliu/work/skills/taskspec/docs/plans/2026-04-13-system-overview-and-external-docs-design.md`

---

### Task 1: Replace Path Validation Table with External Docs Paths

**Files:**
- Modify: `/Users/yzliu/work/skills/taskspec/SKILL.md:48-81`

**Step 1: Read lines 48-81 to see current path validation**

**Step 2: Replace the path validation table (lines 56-66)**

Replace the entire table with:

```markdown
| Item | What to ask |
|------|-------------|
| **Repo root** | Absolute path to the project repository (e.g. `/Users/yzliu/work/projects/clawso`) |
| **Docs root** | Absolute path to the project's Docs directory (e.g. `/Users/yzliu/work/Docs/clawso`). All taskspec artifacts, reports, and system overview live here — outside the repo. |
| **System overview path** | Path to the system indexed overview directory (default: `<Docs root>/system`). Must contain `SYSTEM_INDEX.md`. |
| **TaskSpec ID** | Identifier for this round (e.g. `v2.4`, `openclaw-fix`). Used as directory name under `<Docs root>/taskspec/` and as branch prefix (`<taskspec-id>/<WORKER_ID>`). |
| **PRD / input document paths** | Absolute path for every source document referenced in sub-tasks |
| **PR base branch** | Branch workers PR into (usually `main`) |
| **Environment file location** | Path to `.env.local` or equivalent (e.g. `<repo-root>/.env.local`) |
| **Environment variable names** | Exact variable names used in the repo (never assume `DATABASE_URL` exists) |
```

**Step 3: Add derived paths note after the table**

Insert after the table, before "Hard block rule":

```markdown
### Derived paths (do not ask — computed from above)

| Artifact | Derived Path |
|----------|-------------|
| TaskSpec directory | `<Docs root>/taskspec/<taskspec-id>/` |
| Dispatch plan | `<Docs root>/taskspec/<taskspec-id>/dispatch_plan.md` |
| Dispatch command | `<Docs root>/taskspec/<taskspec-id>/dispatch_command.md` |
| Worker files | `<Docs root>/taskspec/<taskspec-id>/<WORKER_ID>.md` |
| Completion reports | `<Docs root>/taskspec/<taskspec-id>/reports/<WORKER_ID>.md` |
| System overview | `<Docs root>/system/` |
```

**Step 4: Commit**

```bash
git add SKILL.md
git commit -m "feat(taskspec): replace path validation with external Docs paths"
```

---

### Task 2: Add Step 0.1 — System Overview Confirmation

**Files:**
- Modify: `/Users/yzliu/work/skills/taskspec/SKILL.md` — insert after Step 0 (Path Validation Gate), before Step 0.5

**Step 1: Read the area around Step 0 and Step 0.5 to find insertion point**

**Step 2: Insert new section after "Step 0: Path Validation Gate" and before "Step 0.5: Environment Health Check Gate"**

```markdown
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
```

**Step 3: Commit**

```bash
git add SKILL.md
git commit -m "feat(taskspec): add Step 0.1 system overview confirmation"
```

---

### Task 3: Add Codebase Pointers to Worker Definition Template

**Files:**
- Modify: `/Users/yzliu/work/skills/taskspec/SKILL.md` — the Worker Definition Template section

**Step 1: Read the Worker Definition Template section**

**Step 2: Add `#### Codebase Pointers` section to the template**

Insert after the `#### Human Acceptance Criteria` section and before the closing ```` in the worker template:

```markdown
#### Codebase Pointers (from system overview)

*Auto-extracted from system overview modules during TaskSpec generation. Omit this section if the system overview does not exist or has no relevant file:line references for this worker.*

- **Entry point**: `[file:line — primary file the worker will modify]`
- **Key files**: `[comma-separated list of files relevant to this worker's scope]`
- **Contracts**: `[API routes, events, or IPC commands this worker must honor — with module doc reference]`
- **Module doc**: `[absolute path to the system overview module doc covering this worker's scope]`
```

**Step 3: Add a generation note in Step 2 (Worker Decomposition)**

After the granularity rule in Step 2, add:

```markdown
**Codebase Pointers (token efficiency):** When a system overview exists, for each worker:
1. Identify which system overview modules cover the worker's scope (by runtime, file paths, or PRD sections)
2. Read those module docs and extract: entry points (file:line), key files, contracts
3. Embed as a `Codebase Pointers` section in the worker definition
4. Only include when the system overview has specific file:line references relevant to the worker. Omit for new-from-scratch workers or when the overview lacks coverage for the worker's scope.
```

**Step 4: Commit**

```bash
git add SKILL.md
git commit -m "feat(taskspec): add Codebase Pointers to worker definition template"
```

---

### Task 4: Add Mandatory System Overview Update Sub-Task

**Files:**
- Modify: `/Users/yzliu/work/skills/taskspec/SKILL.md` — Worker Definition Template + Dispatch Command

**Step 1: Read the Worker Definition Template section**

**Step 2: Add mandatory final sub-task to the template**

After the last `[WORKER_ID].2` sub-task example and before `#### AI Auto-Tests`, add:

```markdown
**[WORKER_ID].N — Update System Overview** *(mandatory if any documented path, contract, or entry point changed)*
- Check which system overview module docs (at `<system-overview-path>/modules/`) cover files this worker modified
- For each affected module doc:
  - Update file:line references if lines shifted
  - Update route/contract inventory if endpoints changed
  - Add new entries with `[ADDED <date>]` tag
  - Mark removed entries with `[REMOVED <date>]` tag (per FORMAT_SPEC.md)
- If no documented paths were affected, skip this sub-task with a note: "No system overview updates needed"
- **Acceptance**: All modified file:line references in the system overview are accurate post-change
- **Key constraint**: Follow FORMAT_SPEC.md tagging rules (`[ADDED ISO]`, `[UPDATED ISO]`, `[REMOVED ISO]`)
```

**Step 3: Add system overview update instruction to Dispatch Command Step 4 (Execute)**

Find the Step 4 (Execute) section in the dispatch command and add a bullet:

```markdown
- Before committing: if your changes affect any file, route, contract, or entry point documented in the system overview modules, update those module docs following FORMAT_SPEC.md tagging rules. System overview path: `<system-overview-path>`
```

**Step 4: Commit**

```bash
git add SKILL.md
git commit -m "feat(taskspec): add mandatory system overview update sub-task"
```

---

### Task 5: Update All Path References for External Docs

**Files:**
- Modify: `/Users/yzliu/work/skills/taskspec/SKILL.md` — multiple sections

**Step 1: Update Upstream Contract section (~lines 31-46)**

The fix PRD path `docs/dev/branch/<branch_name>/<version>/fix_prd_<version>.md` is in-repo. This may still be valid if PRDs are in the repo. Check and update if PRDs also moved to Docs. If unclear, leave as-is with a note that PRD paths are confirmed during path validation.

**Step 2: Update Dispatch Command — Round Context (lines ~553-566)**

Replace the round context template to reference external Docs:

```markdown
## Round Context

TaskSpec ID: [e.g. v2.4]
Docs Root: [e.g. /Users/yzliu/work/Docs/clawso]
Repo Root: [e.g. /Users/yzliu/work/projects/clawso]
System Overview: [e.g. /Users/yzliu/work/Docs/clawso/system]
PR Base Branch: [e.g. main]

TaskSpec Directory: <Docs Root>/taskspec/<TaskSpec ID>/
Worker files: <TaskSpec Directory>/<WORKER_ID>.md
Dispatch plan: <TaskSpec Directory>/dispatch_plan.md
Reports: <TaskSpec Directory>/reports/<WORKER_ID>.md

Workers create branches as: <TaskSpec ID>/<WORKER_ID>
Workers PR into: <PR Base Branch>
Source code changes go to: <Repo Root> (on the worker's branch)
Reports and dispatch plan updates go to: <Docs Root> (not in the repo)
```

**Step 3: Update Dispatch Command — Completion step (Step 5)**

Update report path from `docs/dev/branch/<version>/dev_history/<WORKER_ID>_report.md` to `<Docs root>/taskspec/<taskspec-id>/reports/<WORKER_ID>.md`.

Clarify that:
- Source code commits go to the repo branch
- Report writes go to the external Docs directory (not committed to the repo)
- Dispatch plan updates go to the external Docs directory

**Step 4: Update Dev History Path Conventions section**

Rewrite to reflect external Docs structure:

```markdown
## Dev History Path Conventions

All artifacts live in the external Docs directory, NOT in the project repository. The repo contains only source code.

**Docs base path:** `<Docs root>/taskspec/<taskspec-id>/`

| Artifact | Path |
|----------|------|
| TaskSpec index | `taskspec/<taskspec-id>/index.md` |
| Worker definitions | `taskspec/<taskspec-id>/<WORKER_ID>.md` |
| Dispatch plan | `taskspec/<taskspec-id>/dispatch_plan.md` |
| Dispatch command | `taskspec/<taskspec-id>/dispatch_command.md` |
| Completion reports | `taskspec/<taskspec-id>/reports/<WORKER_ID>.md` |

Example using Docs root `/Users/yzliu/work/Docs/clawso`, TaskSpec ID `v2.4`:
- TaskSpec index: `/Users/yzliu/work/Docs/clawso/taskspec/v2.4/index.md`
- Worker file: `/Users/yzliu/work/Docs/clawso/taskspec/v2.4/R-01.md`
- Dispatch plan: `/Users/yzliu/work/Docs/clawso/taskspec/v2.4/dispatch_plan.md`
- Report: `/Users/yzliu/work/Docs/clawso/taskspec/v2.4/reports/R-01.md`
- System overview: `/Users/yzliu/work/Docs/clawso/system/SYSTEM_INDEX.md`
```

**Step 5: Update TaskSpec Index Template**

Update the index template to use external Docs paths. The file manifest should show absolute Docs paths.

**Step 6: Update Session Isolation Invariant (line ~25)**

Change `<version>/<WORKER_ID>` to `<taskspec-id>/<WORKER_ID>` to match new naming.

**Step 7: Update all remaining references to old in-repo paths**

Grep for `docs/dev/`, `dev_history/`, and any other in-repo path references. Replace with the external Docs equivalents or confirm they're already updated.

**Step 8: Commit**

```bash
git add SKILL.md
git commit -m "feat(taskspec): move all artifact paths to external Docs directory"
```

---

### Task 6: Update Dispatch Command Environment Config for External Docs

**Files:**
- Modify: `/Users/yzliu/work/skills/taskspec/SKILL.md` — Dispatch Command section

**Step 1: Read the Environment Configuration block in dispatch command**

**Step 2: Remove the `docs/ gitignore note with git add -f docs/` instruction**

This is no longer needed since docs are external to the repo.

**Step 3: Add note about external Docs access**

```markdown
- Docs directory is external to the repo. Workers read/write to it directly (no git operations on the Docs directory).
- Source code changes are committed to the repo branch. Reports and dispatch plan updates are written to the Docs directory without git.
```

**Step 4: Commit**

```bash
git add SKILL.md
git commit -m "feat(taskspec): update dispatch command for external Docs"
```

---

### Task 7: Final Cleanup and Consistency Pass

**Files:**
- Modify: `/Users/yzliu/work/skills/taskspec/SKILL.md`

**Step 1: Grep for stale path patterns**

Search for these and fix any remaining:
- `docs/dev/` — should not appear (old in-repo path)
- `dev_history/` — should be replaced with `reports/`
- `<version>/` — should be `<taskspec-id>/` where referring to branch prefix
- `git add -f docs/` — should be removed
- `TaskSpec output directory` — should reference Docs root
- Any absolute path example that still points to in-repo locations

**Step 2: Verify internal consistency**

- Path Validation table matches Dispatch Command round context
- Derived paths table matches Dev History conventions
- Worker template Codebase Pointers section exists
- Worker template has mandatory Update System Overview sub-task
- Step 0.1 exists between Step 0 and Step 0.5
- Dispatch Command Step 4 has system overview update instruction

**Step 3: Commit**

```bash
git add SKILL.md
git commit -m "feat(taskspec): final cleanup of path references and consistency"
```
