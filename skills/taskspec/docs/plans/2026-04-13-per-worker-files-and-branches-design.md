# TaskSpec Skill: Per-Worker Files & Branch-Per-Worker Design

**Date**: 2026-04-13
**Status**: Approved

## Problem

1. **Monolithic TaskSpec files** (1500+ lines) force workers to read definitions for all workers when they only need their own.
2. **Single shared branch** makes it hard to isolate, review, and fix individual worker contributions.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| File split strategy | Master index + per-worker files | Workers load only their file; PM sees full picture in index |
| Branch strategy | Each worker branches from main | Clean linear history, no merge conflicts within batches |
| Merge policy | Worker auto-creates PR, human merges | Consistent with automation-first, human oversight on merge |
| Batch dependency | Gate: all prior batch PRs must be merged before next batch starts | Workers always branch from a main that has all prior work |
| DELTA-CHECK | Eliminated | Each worker self-validates; PR is the review unit |
| PR-REVIEW | Eliminated | Individual PRs replace aggregate review |
| V- workers | Minimized | Push verification to coding workers; HUMAN only when truly impossible |

## Feature 1: Per-Worker File Split

### Output Structure

```
docs/dev/branch/<branch>/<version>/
  taskspec/
    index.md              # Overview, dispatch table, integration points, runtime contracts
    PRE-FLIGHT.md         # Pre-flight worker (if needed)
    R-01.md               # Individual worker definitions
    R-02.md
    N-01.md
    BATCH-N-GATE.md       # Batch integration gates (if cross-worker deps)
  dispatch_plan.md
  agent_dispatch_command.md
```

### Index File Contents

- Document header (title, version, date, input docs)
- Conflict resolution rule (verbatim)
- PM Blocker Resolutions (delta rounds only)
- Compact dispatch table (all workers overview)
- Cross-worker integration points table
- Runtime contracts (all async/event/IPC contracts)
- Worker file manifest (list of all worker files with absolute paths)

### Worker File Contents

- Worker definition header (runtime, delta type, phase, priority, depends on)
- Sub-tasks with descriptions, constraints, acceptance criteria, refs
- AI Auto-Tests (Layer 1)
- Behavioral Assertions (Layer 2)
- Human Acceptance Criteria (Layer 3)

### Dispatch Plan Changes

- `PRDs to Attach` column replaced/augmented with `TaskSpec File` column pointing to `taskspec/<WORKER_ID>.md`
- PR column added to track PR URL and merge status

### Dispatch Command Changes

- Step 4 (Execute) reads `taskspec/<WORKER_ID>.md` instead of the full TaskSpec
- Only reads `taskspec/index.md` when cross-worker context is needed

## Feature 2: Branch-Per-Worker Workflow

### Branch Naming

```
<version>/<worker-id>
```

Examples: `v2.4/R-01`, `v2.4/N-02`, `v2.4/PRE-FLIGHT`

### Worker Session Lifecycle

```
Step 1: Read dispatch plan -> find eligible row (status=pending, model match, deps done+merged)
Step 2: Claim stamp -> mark row in-progress
Step 3: Create branch -> git checkout -b <version>/<WORKER_ID> origin/main
Step 4: Read worker file -> taskspec/<WORKER_ID>.md
Step 5: Execute -> implement sub-tasks
Step 6: Validate -> run auto-tests + behavioral assertions
Step 7: Complete ->
  7a: Commit with structured message
  7b: Push branch
  7c: Create PR (gh pr create --base main)
  7d: Update dispatch plan (status=done, PR URL in PR column)
  7e: Write completion report
  7f: STOP session
```

### Batch Gate Enforcement

Before batch N+1 workers can start:
1. All batch N workers must be done in dispatch plan
2. All batch N PRs must be merged to main
3. Dispatch command checks both conditions

### Dispatch Plan Table Format

```markdown
| Status | Batch | Worker | Task | Model | Depends On | TaskSpec File | PR | Notes |
```

### PR Body Template

```markdown
## [WORKER_ID] - <Task Name>

**TaskSpec**: `taskspec/<WORKER_ID>.md`
**Batch**: N
**Depends on**: [Worker IDs]

### Changes
- [From sub-task list]

### Validation
- [ ] AI Auto-Tests passed
- [ ] Behavioral Assertions passed
```

### PM-DECIDE Adaptation

Without DELTA-CHECK to append PM-DECIDE rows:
- PM flags resolved pre-generation (existing behavior)
- Runtime blockers: worker marks itself blocked with question in Notes
- PM resolves, worker retries in new session

## Sections Removed from SKILL.md

- DELTA-CHECK worker template and all references
- PR-REVIEW worker template and all references
- PM-DECIDE protocol (simplified to inline blocking)
- Step 6 (Delta Check) in dispatch command
- Step 7 (PR Review) in dispatch command
- Push-on-batch-complete logic
- Opt-Out Rule section (nothing to opt out of)

## Sections Modified in SKILL.md

- Output Structure Overview: 3 artifacts remain but TaskSpec is now a directory
- Dispatch Plan template: add TaskSpec File and PR columns
- Dispatch Command: rewrite Steps 1-7 for branch-per-worker flow
- Dev History Path Conventions: simplified (no delta/ subdirectory needed)
- Worker Definition Template: unchanged (just lives in its own file now)
- Batch Integration Gate: unchanged (still useful for cross-worker validation)
- Session Strategy: unchanged (one session = one row)
