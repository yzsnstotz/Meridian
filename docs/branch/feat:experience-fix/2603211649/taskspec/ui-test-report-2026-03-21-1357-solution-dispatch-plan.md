# UI Test Report 2026-03-21 Solution Dispatch Plan

- **Repo Root**: `/Users/yzliu/work/Meridian`
- **Branch**: `feat/experience-fix`
- **TaskSpec**: `/Users/yzliu/work/Meridian/docs/branch/feat:experience-fix/2603211649/taskspec/ui-test-report-2026-03-21-1357-solution-taskspec.md`
- **Dispatch Command**: `/Users/yzliu/work/Meridian/docs/branch/feat:experience-fix/2603211649/taskspec/ui-test-report-2026-03-21-1357-solution-agent-dispatch-command.md`
- **Dev History Dir**: `/Users/yzliu/work/Meridian/docs/branch/feat:experience-fix/dev_history/`

## PRD Reference Paths

| Label | Absolute Path |
|---|---|
| Solution PRD | `/Users/yzliu/work/Meridian/docs/branch/feat:experience-fix/2603211649/taskspec/ui-test-report-2026-03-21-1357-solution-prd.md` |
| Test Report | `/Users/yzliu/work/Meridian/docs/branch/feat:experience-fix/2603211649/test_report/ui-test-report-2026-03-21-1357.md` |
| Config | `/Users/yzliu/work/Meridian/src/config.ts` |
| Package | `/Users/yzliu/work/Meridian/package.json` |
| TaskSpec | `/Users/yzliu/work/Meridian/docs/branch/feat:experience-fix/2603211649/taskspec/ui-test-report-2026-03-21-1357-solution-taskspec.md` |

## Model Assignment Legend

| Model | Code | Use |
|---|---|---|
| Claude Opus | `OPUS` | State-model architecture, hub canonical-event plumbing, delta-check, and terminal PR review |
| Codex | `CODEX` | Pre-flight validation, web server and terminal implementation, and regression-test expansion |
| Human PM | `PM` | Only for dynamically appended `PM-DECIDE-*` rows created by DELTA-CHECK |

## Master Dispatch Table

| Status | Batch | Worker | Task | Model | Depends On | PRDs to Attach | Notes |
|---|---:|---|---|---|---|---|---|
| ✅ | 0 | PF-00 | Validate paths, env contract, typecheck, and baseline tests | CODEX | — | Solution PRD, Test Report, Config, Package | Completed 2026-03-21 22:17 JST; baseline clean |
| ⬜ | 1 | R-01 | Add canonical conversation-event storage and migration/coalescing rules | OPUS | PF-00 | Solution PRD, Test Report, Config | Foundation for all downstream history and restore work |
| ⬜ | 2 | R-02 | Record canonical hub events and normalized progress or approval snapshots | OPUS | R-01 | Solution PRD, Test Report | Keep existing duplicate-final rendering guardrails intact |
| ⬜ | 3 | R-03 | Proxy canonical `/api/history` and authenticated progress endpoint | CODEX | R-02 | Solution PRD, Test Report, Config | Keep auth and invalid-thread semantics unchanged |
| ⬜ | 3 | R-04 | Restore terminal from canonical events and poll durable progress | CODEX | R-02 | Solution PRD, Test Report, TaskSpec | Coordinate route and payload names with `R-03` contract |
| ⬜ | 4 | R-05 | Expand router/server/terminal regression coverage | CODEX | R-03, R-04 | Solution PRD, Test Report, TaskSpec | Extend existing tests; do not replace the current duplicate/history cases |
| ⬜ | Ω | DELTA-CHECK | Validate delivered behavior against issues 1-3 and acceptance criteria | OPUS | R-05 | TaskSpec, Solution PRD, Test Report | Always produces report plus appended rows if drift remains |
| ⬜ | Ω+1 | PR-REVIEW | Review final diff against source report and TaskSpec before merge | OPUS | DELTA-CHECK | TaskSpec, Solution PRD, Test Report | Terminal merge gate after any appended corrective rows complete |

## Batch Execution Details

### Batch 0

- Workers: `PF-00`
- Priority: P0
- Agent notes: validate the execution contract before any edits; this is a hard gate.
- Completion gate: explicit confirmation that paths, `.env`, typecheck, and the targeted tests are either passing or reported as a blocking baseline defect.

### Batch 1

- Workers: `R-01`
- Priority: P0
- Agent notes: establish the canonical event store and compatibility path first; downstream workers must not invent their own event shape.
- Completion gate: persisted canonical event model and retention/coalescing rules are implemented and documented in code.

### Batch 2

- Workers: `R-02`
- Priority: P0
- Agent notes: route all canonical event recording and normalized progress through the hub’s single source of truth.
- Completion gate: the hub can supply ordered canonical history plus a stable thread-scoped progress or approval record.

### Batch 3

- Workers: `R-03`, `R-04`
- Priority: P0
- Agent notes: `R-03` and `R-04` may run in parallel against the TaskSpec contract, but they must stay aligned on route names, auth, and response shape.
- Completion gate: web APIs and terminal restore or polling behavior agree on the canonical history and progress contract.

### Batch 4

- Workers: `R-05`
- Priority: P0
- Agent notes: extend current tests instead of replacing them, and map each source issue to explicit coverage.
- Completion gate: targeted regression suite covers canonical ordering, durable liveness, and final-result replacement behavior.

### Terminal Batches

- `DELTA-CHECK`
- `PR-REVIEW`

## PM Flags Summary

| Flag | Resolution |
|---|---|
| Whether unresolved approval prompts should be persisted directly or recomputed later | Persist them as canonical replaceable events so refresh can restore the same unresolved state deterministically |
| Whether restore must mirror provider-native chronology exactly | Use Meridian-normalized ordered chronology rather than raw provider-native logs |
| How to prevent unbounded state growth from repeated progress ticks | Coalesce replaceable progress or approval events by stable key while keeping immutable user and final events |

## Completion Tracking

| Batch | Started | Ended | Report Path |
|---|---|---|---|
| 0 | `2026-03-21 22:15 JST` | `2026-03-21 22:17 JST` | `/Users/yzliu/work/Meridian/docs/branch/feat:experience-fix/dev_history/2026-03-21_pf-00.md` |
| 1 | — | — | `/Users/yzliu/work/Meridian/docs/branch/feat:experience-fix/dev_history/2026-03-21_r-01.md` |
| 2 | — | — | `/Users/yzliu/work/Meridian/docs/branch/feat:experience-fix/dev_history/2026-03-21_r-02.md` |
| 3 | — | — | `/Users/yzliu/work/Meridian/docs/branch/feat:experience-fix/dev_history/2026-03-21_r-03.md`, `/Users/yzliu/work/Meridian/docs/branch/feat:experience-fix/dev_history/2026-03-21_r-04.md` |
| 4 | — | — | `/Users/yzliu/work/Meridian/docs/branch/feat:experience-fix/dev_history/2026-03-21_r-05.md` |
| Ω | — | — | `/Users/yzliu/work/Meridian/docs/branch/feat:experience-fix/dev_history/2026-03-21_delta-check.md` |
| Ω+1 | — | — | `/Users/yzliu/work/Meridian/docs/branch/feat:experience-fix/dev_history/2026-03-21_pr-review.md` |
