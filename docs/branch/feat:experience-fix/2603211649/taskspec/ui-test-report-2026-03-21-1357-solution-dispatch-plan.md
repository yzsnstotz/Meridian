# UI Test Report 2026-03-21 Solution Dispatch Plan v2.0

- **Repo Root**: `/Users/yzliu/work/Meridian`
- **Branch**: `feat/experience-fix`
- **TaskSpec**: `/Users/yzliu/work/Meridian/docs/branch/feat:experience-fix/2603211649/taskspec/ui-test-report-2026-03-21-1357-solution-taskspec.md`
- **Dispatch Command**: `/Users/yzliu/work/Meridian/docs/branch/feat:experience-fix/2603211649/taskspec/ui-test-report-2026-03-21-1357-solution-agent-dispatch-command.md`
- **Dev History Dir**: `/Users/yzliu/work/Meridian/docs/branch/feat:experience-fix/2603211649/dev_history/`

## PRD Reference Paths

| Shorthand | Full Path |
|-----------|-----------|
| Solution PRD | `/Users/yzliu/work/Meridian/docs/branch/feat:experience-fix/2603211649/taskspec/ui-test-report-2026-03-21-1357-solution-prd.md` |
| Test Report | `/Users/yzliu/work/Meridian/docs/branch/feat:experience-fix/2603211649/taskspec/ui-test-report-2026-03-21-1357.md` |
| TaskSpec | `/Users/yzliu/work/Meridian/docs/branch/feat:experience-fix/2603211649/taskspec/ui-test-report-2026-03-21-1357-solution-taskspec.md` |
| Config | `/Users/yzliu/work/Meridian/src/config.ts` |
| Package | `/Users/yzliu/work/Meridian/package.json` |

## Model Assignment Legend

| Model | Code | Assign When |
|-------|------|-------------|
| Claude Opus | `OPUS` | Complex refactoring, multi-file coordination, nuanced business logic, architectural decisions (R-01, R-02, R-04, DELTA-CHECK, PR-REVIEW) |
| Codex | `CODEX` | Well-specified endpoint work, config changes, template generation, straightforward additions (PRE-FLIGHT, R-03, R-05, R-06) |
| Human (PM) | `PM` | Only for dynamically appended `PM-DECIDE-N` rows created by DELTA-CHECK. Agents skip PM rows. |

## Master Dispatch Table

| Status | Batch | Worker | Task | Model | Depends On | PRDs to Attach | Notes |
|--------|------:|--------|------|-------|------------|----------------|-------|
| ✅ | 0 | PRE-FLIGHT | Validate paths, env contract, typecheck, baseline tests | CODEX | — | Solution PRD, Test Report, Config, Package | Hard gate; all workers depend on this |
| ✅ | 1 | R-01 | Canonical conversation-event store + migration + coalescing rules | CODEX | PRE-FLIGHT | Solution PRD, Test Report | Foundation schema for all downstream work |
| ✅ | 2 | R-02 | Hub canonical event recording + web-readable progress exposure | CODEX | R-01 | Solution PRD, Test Report | Keep existing duplicate-final guards intact |
| ✅ | 3 | R-03 | Canonical `/api/history` + authenticated `/api/progress/:threadId` | CODEX | R-02 | Solution PRD, Test Report, Config | Coordinate route names with R-04 |
| ✅ | 3 | R-04 | Terminal: canonical restore + durable progress + reconnect dedup | CODEX | R-02 | Solution PRD, Test Report, TaskSpec | Covers F-01, F-02, F-03 client-side |
| ✅ | 3 | R-05 | ARIA accessibility fixes (sidebar, tabs, icon-only buttons) | CODEX | PRE-FLIGHT | Solution PRD, Test Report | Covers F-04, F-05, F-06; parallel with R-03/R-04 |
| ✅ | 4 | R-06 | Regression coverage for all six findings (F-01–F-06) | CODEX | R-03, R-04, R-05 | Solution PRD, Test Report, TaskSpec | Extend existing tests; do not replace |
| ✅ | Ω | DELTA-CHECK | Delta Check & Corrective Dispatch | CODEX | R-06 | TaskSpec, Solution PRD, Test Report | Always completes; appends corrective rows if drift |
| ✅ | Ω | PR-REVIEW | PR Alignment Review | CODEX | DELTA-CHECK, all Ω+1 workers, all PM-DECIDE rows | TaskSpec, Solution PRD, Test Report | Terminal gate; human merges |

Status legend: `⬜` Not started · `🟧` Reassigned · `🔄` In progress · `✅` Complete · `⛔` Blocked · `⏳` Awaiting PM decision (PM-DECIDE rows only)

## Batch Execution Details

### Batch 0

- Workers: `PRE-FLIGHT`
- Priority: P0
- Model: CODEX
- Agent notes: Validate the execution contract before any edits; this is a hard gate. If baseline is failing, stop with `⛔ BLOCKED`.
- Completion gate: Paths, `.env`, typecheck, and targeted tests are passing or reported as blocking baseline defect.

### Batch 1

- Workers: `R-01`
- Priority: P0
- Model: CODEX
- Agent notes: Establish the canonical event store schema first. Downstream workers must not invent their own event shape — they consume the types exported by R-01.
- Completion gate: Persisted canonical event model and retention/coalescing rules are implemented and pass type-check.

### Batch 2

- Workers: `R-02`
- Priority: P0
- Model: CODEX
- Agent notes: Route all canonical event recording and normalized progress through the hub's single source of truth. Do not create a second progress formatter.
- Completion gate: Hub can supply ordered canonical history plus a stable thread-scoped progress record.

### Batch 3

- Workers: `R-03`, `R-04`, `R-05`
- Priority: P0 (R-03, R-04), P1 (R-05)
- Models: CODEX (R-03, R-04, R-05)
- Agent notes: R-03 and R-04 must align on route names, auth, and response shape. R-05 runs in parallel with no dependency on R-03/R-04.
- Completion gate: Web APIs, terminal restore/polling, and ARIA attributes all aligned on the canonical contract.

### Batch 4

- Workers: `R-06`
- Priority: P0
- Model: CODEX
- Agent notes: Extend current tests instead of replacing them. Map each of the six source findings to at least one explicit test.
- Completion gate: Targeted regression suite covers canonical ordering, durable liveness, reconnection dedup, final-result replacement, and ARIA attributes.

### Terminal Batches

- `DELTA-CHECK` (Ω): Model CODEX. Always completes with report + dispatch row updates.
- `PR-REVIEW` (Ω): Model CODEX. Runs after DELTA-CHECK + all corrective/PM-DECIDE rows are `✅`.

## PM Flags Summary

| Flag | Resolution |
|------|------------|
| Whether unresolved approval prompts should be persisted directly or recomputed | Persist as canonical replaceable events (PM Resolution #1 in TaskSpec) |
| Whether restore must mirror provider-native chronology exactly | Use Meridian-normalized ordered chronology (PM Resolution #2 in TaskSpec) |
| How to prevent unbounded state growth from repeated progress ticks | Coalesce replaceable events by stable key per trace (PM Resolution #3 in TaskSpec) |

## Completion Tracking

| Batch | Started | Ended | Report Path |
|-------|---------|-------|-------------|
| 0 | — | — | `/Users/yzliu/work/Meridian/docs/branch/feat:experience-fix/2603211649/dev_history/PRE-FLIGHT_report.md` |
| 1 | — | — | `/Users/yzliu/work/Meridian/docs/branch/feat:experience-fix/2603211649/dev_history/R-01_report.md` |
| 2 | — | — | `/Users/yzliu/work/Meridian/docs/branch/feat:experience-fix/2603211649/dev_history/R-02_report.md` |
| 3 | — | — | `/Users/yzliu/work/Meridian/docs/branch/feat:experience-fix/2603211649/dev_history/R-03_report.md`, `/Users/yzliu/work/Meridian/docs/branch/feat:experience-fix/2603211649/dev_history/R-04_report.md`, `/Users/yzliu/work/Meridian/docs/branch/feat:experience-fix/2603211649/dev_history/R-05_report.md` |
| 4 | — | — | `/Users/yzliu/work/Meridian/docs/branch/feat:experience-fix/2603211649/dev_history/R-06_report.md` |
| Ω | — | — | `/Users/yzliu/work/Meridian/docs/branch/feat:experience-fix/2603211649/dev_history/delta_check_report.md` |
| Ω (PR) | — | — | `/Users/yzliu/work/Meridian/docs/branch/feat:experience-fix/2603211649/dev_history/pr_review_report.md` |
| Ω+1 (corrective) | — | — | `/Users/yzliu/work/Meridian/docs/branch/feat:experience-fix/2603211649/dev_history/delta/[WORKER_ID]_report.md` |
