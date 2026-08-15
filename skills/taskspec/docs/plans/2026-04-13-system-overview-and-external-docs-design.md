# TaskSpec Skill: System Overview Integration, External Docs, and Codebase Pointers

**Date**: 2026-04-13
**Status**: Approved

## Problem

1. Workers waste tokens scanning the entire repo when the system overview already documents exact file:line entry points.
2. TaskSpec artifacts clutter the project repo — they belong in an external Docs location.
3. When workers change documented paths/contracts, the system overview goes stale.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| System overview location | External: `/Users/yzliu/work/Docs/<Project>/system` | Docs live separately from source code |
| All artifacts location | External: `/Users/yzliu/work/Docs/<Project>/taskspec/<id>/` | Repo stays clean with only source code |
| Location hints | Auto-extract from system overview modules | Workers jump to exact files, saving tokens |
| System overview updates | Mandatory final sub-task per worker | Workers keep docs current before committing |
| Pre-generation confirmation | Operator confirms system overview before proceeding | Shared understanding of architecture |

## Feature 1: System Overview Integration

### Pre-Generation Gate Addition

New row in Path Validation table:

| Item | What to ask |
|------|-------------|
| **System overview path** | Absolute path to the system indexed overview directory (e.g. `/Users/yzliu/work/Docs/clawso/system`) |

### Step 0.1: System Overview Confirmation

After path validation, before worker decomposition:

1. Read `SYSTEM_INDEX.md` from system overview directory
2. Present summary to user: module list, key dependencies, last-updated dates
3. User confirms overview is current and accurate
4. If stale or missing: flag and ask user whether to proceed or update first

### Auto-Extract Codebase Pointers

During worker decomposition (Step 2), for each worker:

1. Identify relevant system overview modules based on worker's runtime/files/PRD
2. Read module docs, extract: entry points (file:line), key files, contracts
3. Embed as `#### Codebase Pointers` section in worker definition:

```markdown
#### Codebase Pointers (from system overview)
- **Entry point**: `apps/client/src/pages/OpenClawPage.tsx:42`
- **Key files**: `apps/client/src/hooks/useOpenClaw.ts`, `apps/client/src-tauri/src/openclaw/mod.rs`
- **Contracts**: POST `/api/tools/submit-mcp` (see platform-bff-services Route Inventory)
- **Module doc**: `/Users/yzliu/work/Docs/clawso/system/modules/client-runtime-openclaw.md`
```

**Token efficiency rule:** Only include when system overview has specific file:line references. Omit for new-from-scratch workers.

## Feature 2: External Docs Artifact Structure

### Directory Layout

```
/Users/yzliu/work/Docs/<Project>/
  system/                        # System indexed overview
    SYSTEM_INDEX.md
    FORMAT_SPEC.md
    modules/*.md
  taskspec/                      # All taskspec rounds
    <taskspec-id>/               # e.g. v2.4, openclaw-fix
      index.md                   # Master overview
      PRE-FLIGHT.md              # Worker definitions
      R-01.md
      N-02.md
      dispatch_plan.md
      dispatch_command.md
      reports/                   # Completion reports (1:1 with branches)
        PRE-FLIGHT.md
        R-01.md                  # Report for branch <taskspec-id>/R-01
        N-02.md
```

### Branch Naming (unchanged from prior design)

```
<taskspec-id>/<WORKER_ID>
```

Examples: `v2.4/R-01`, `openclaw-fix/N-02`, `v2.4/PRE-FLIGHT`

### Path Validation Updates

Replace old items with:

| Item | What to ask |
|------|-------------|
| **Repo root** | Absolute path to the project repository |
| **Docs root** | Absolute path to Docs directory (e.g. `/Users/yzliu/work/Docs/clawso`) |
| **System overview path** | `<Docs root>/system` (confirm exists) |
| **TaskSpec ID** | Identifier for this round (e.g. `v2.4`) — used for directory and branch prefix |
| **PR base branch** | Branch workers PR into (usually `main`) |
| **Environment file location** | Path to `.env.local` |
| **Environment variable names** | Exact var names |

Derived (not asked):
- TaskSpec dir: `<Docs root>/taskspec/<taskspec-id>/`
- Dispatch plan: `<Docs root>/taskspec/<taskspec-id>/dispatch_plan.md`
- Reports: `<Docs root>/taskspec/<taskspec-id>/reports/<WORKER_ID>.md`

### Dispatch Command Changes

Workers:
1. Read taskspec from external Docs path
2. Write reports to external Docs path
3. Update dispatch plan at external Docs path
4. Commit source code changes to repo branch only
5. Reports are NOT in the repo — Docs only

## Feature 3: Mandatory System Overview Update

### Worker Definition Template Addition

Every worker gets a mandatory final sub-task:

```markdown
**[WORKER_ID].N -- Update System Overview** *(mandatory if any documented path, contract, or entry point changed)*
- Check which system overview module docs cover files this worker modified
- For each affected module doc:
  - Update file:line references if lines shifted
  - Update route/contract inventory if endpoints changed
  - Add new entries with `[ADDED <date>]` tag
  - Mark removed entries with `[REMOVED <date>]` tag (per FORMAT_SPEC.md)
- If no documented paths were affected, skip this sub-task
- **Acceptance**: All modified file:line references in system overview are accurate post-change
- **Key constraint**: Follow FORMAT_SPEC.md tagging rules
```

### Dispatch Command Addition

Add to Step 4 (Execute):
```
Before committing: if your changes affect any file, route, contract, or entry point documented
in the system overview modules, update those module docs. Follow FORMAT_SPEC.md tagging rules.
System overview path: <system-overview-path>
```

## Sections Modified in SKILL.md

- Path Validation table: replace all path items with new Docs-based items
- Add Step 0.1: System Overview Confirmation (new section after Step 0)
- Worker Definition Template: add Codebase Pointers section and Update System Overview sub-task
- Dispatch Command: update all paths to external Docs, add system overview update instruction
- Dev History Path Conventions: rewrite for external Docs structure
- TaskSpec Index Template: update paths
- Dispatch Plan Template: update report paths
- PR Template: no change (PRs are in the repo, not Docs)
