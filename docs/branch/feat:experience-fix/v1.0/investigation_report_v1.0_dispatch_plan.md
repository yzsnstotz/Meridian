# Experience Fix Investigation Dispatch Plan v1.0

- **Repo Root**: `/Users/yzliu/work/Meridian`
- **Branch**: `feat/experience-fix`
- **TaskSpec**: `/Users/yzliu/work/Meridian/docs/branch/feat:experience-fix/v1.0/investigation_report_v1.0_taskspec.md`
- **Dispatch Command**: `/Users/yzliu/work/Meridian/docs/branch/feat:experience-fix/v1.0/investigation_report_v1.0_agent_dispatch_command.md`
- **Dev History Dir**: `/Users/yzliu/work/Meridian/docs/branch/feat:experience-fix/v1.0/dev_history/`

## PRD Reference Paths

| Shorthand | Full Path |
|-----------|-----------|
| Investigation Report | `/Users/yzliu/work/Meridian/docs/branch/feat:experience-fix/v1.0/investigation_report_v1.0.md` |
| Solution PRD | `/Users/yzliu/work/Meridian/docs/branch/feat:experience-fix/2603211649/taskspec/ui-test-report-2026-03-21-1357-solution-prd.md` |
| Source Test Report | `/Users/yzliu/work/Meridian/docs/branch/feat:experience-fix/2603211649/taskspec/ui-test-report-2026-03-21-1357.md` |
| Previous TaskSpec | `/Users/yzliu/work/Meridian/docs/branch/feat:experience-fix/meridian_experience_fix_taskspec.md` |
| TaskSpec | `/Users/yzliu/work/Meridian/docs/branch/feat:experience-fix/v1.0/investigation_report_v1.0_taskspec.md` |
| Config | `/Users/yzliu/work/Meridian/src/config.ts` |
| Package | `/Users/yzliu/work/Meridian/package.json` |

## Model Assignment Legend

| Model | Code | Assign When |
|-------|------|-------------|
| Claude Opus | `OPUS` | Multi-file architectural refactors, canonical contract design, terminal behavior integration, delta-check, PR review |
| Codex | `CODEX` | Pre-flight, targeted test rework, runtime verification hardening, documentation-aligned follow-through |
| Human (PM) | `PM` | Only for dynamically appended `PM-DECIDE-N` rows created by DELTA-CHECK |

## Master Dispatch Table

| Status | Batch | Worker | Task | Model | Depends On | PRDs to Attach | Notes |
|--------|------:|--------|------|-------|------------|----------------|-------|
| ✅ | 0 | PRE-FLIGHT | Validate paths, env contract, typecheck, and targeted baseline tests | CODEX | — | Investigation Report, Solution PRD, Config, Package | Passed on retry: env contract aligned and all required baseline checks completed on `feat/experience-fix` |
| ✅ | 1 | R-01 | Canonical immutable conversation-event timeline and compatibility path | CODEX | PRE-FLIGHT | Investigation Report, Solution PRD, TaskSpec | Durable approval prompts now survive resolution and legacy migration |
| ✅ | 2 | R-02 | Structured hub/web history and progress contract | CODEX | R-01 | Investigation Report, Solution PRD, Config | `/api/history` stays canonical and `/api/progress/:threadId` now returns structured phase/wait-state snapshots |
| ✅ | 3 | R-03 | Terminal authoritative restore, reconnect discipline, and durable liveness | CODEX | R-02 | Investigation Report, Solution PRD, TaskSpec | Restored pending threads now keep pane replay out of chat and resolve completion from server-owned history/progress |
| ✅ | 4 | R-04 | Behavioral regression coverage for reconnect, restore, and quiet-period liveness | CODEX | R-02, R-03 | Investigation Report, Solution PRD, TaskSpec | Runtime-oriented terminal tests now cover restore, reconnect replay suppression, keyed liveness, and final-resolution behavior |
| ✅ | 4 | R-05 | Runtime accessibility verification hardening for F-04/F-05/F-06 | CODEX | R-03 | Investigation Report, Solution PRD, TaskSpec | Served `terminal.html` verified F-04/F-05/F-06 on a live local web instance; no markup drift found, runtime and regression evidence captured |
| ✅ | Ω | DELTA-CHECK | Delta Check & Corrective Dispatch | CODEX | R-04, R-05 | TaskSpec, Investigation Report, Solution PRD | Delta report recorded one auto-correctable F-03 drift: `monitor_manual_update` blocks behind active runs |
| ⬜ | Ω+1 | R-06 | Restore non-blocking manual progress updates and queue-level liveness coverage | CODEX | DELTA-CHECK | TaskSpec, Investigation Report, Solution PRD | AUTO from DELTA-CHECK: restore `monitor_manual_update` immediate handling and reinstate the deleted queue regression test |
| 🟧 | Ω | PR-REVIEW | PR Alignment Review | CODEX | DELTA-CHECK, all Ω+1 workers, all PM-DECIDE rows | TaskSpec, Investigation Report, Solution PRD | Terminal gate; human merges |

Status legend: `⬜` Not started · `🟧` Reassigned · `🔄` In progress · `✅` Complete · `⛔` Blocked · `⏳` Awaiting PM decision

## Batch Execution Details

### Batch 0

- Workers: `PRE-FLIGHT`
- Priority: P0
- Model: CODEX
- Agent notes: Validate execution inputs before any edits. If typecheck or baseline tests are already failing, stop the round with `⛔ BLOCKED`.
- Completion gate: Paths, `.env`, typecheck, and targeted tests are confirmed or explicitly reported as blockers.

### Batch 1

- Workers: `R-01`
- Priority: P0
- Model: CODEX
- Agent notes: Establish the canonical event model first. Downstream workers must not invent their own event identities or replace semantics.
- Completion gate: Persisted state supports canonical ordered events and a safe compatibility path.

### Batch 2

- Workers: `R-02`
- Priority: P0
- Model: CODEX
- Agent notes: History and liveness contracts must come from one hub-owned source of truth. Preserve auth and invalid-thread behavior.
- Completion gate: `/api/history` and `/api/progress/:threadId` align on structured, testable payloads.

### Batch 3

- Workers: `R-03`
- Priority: P0
- Model: CODEX
- Agent notes: The terminal must stop treating pane replay as a second chat source. Refresh, reconnect, and quiet periods must converge on one transcript.
- Completion gate: Mid-run restore, reconnect, and final completion resolve to a single authoritative chat state.

### Batch 4

- Workers: `R-04`, `R-05`
- Priority: P0 (`R-04`), P1 (`R-05`)
- Models: CODEX
- Agent notes: `R-04` closes behavioral coverage gaps. `R-05` closes accessibility verification gaps and must verify the served DOM, not just source strings.
- Completion gate: Behavioral tests cover F-01/F-02/F-03 and runtime evidence exists for F-04/F-05/F-06.

### Terminal Batches

- `DELTA-CHECK` (Ω): Model CODEX. Always completes with a report and any required corrective/PM rows.
- `PR-REVIEW` (Ω): Model CODEX. Runs after DELTA-CHECK and all corrective/PM rows are `✅`.

## PM Flags Summary

| Flag | Resolution |
|------|------------|
| Accessibility findings in the older solution PRD no longer match current source state | Use the investigation report as current-state authority; treat F-04/F-05/F-06 as verify-first unless the served DOM proves otherwise |
| Chat rendering during reconnect could still be split between server history and pane replay | Server-owned history and structured progress are authoritative for chat-visible state |
| Existing regression tests are too static to prove the UX fix | Behavioral/runtime coverage is mandatory; static checks remain smoke coverage only |

## Completion Tracking

| Batch | Started | Ended | Report Path |
|-------|---------|-------|-------------|
| 0 | — | — | `/Users/yzliu/work/Meridian/docs/branch/feat:experience-fix/v1.0/dev_history/PRE-FLIGHT_report.md` |
| 1 | — | — | `/Users/yzliu/work/Meridian/docs/branch/feat:experience-fix/v1.0/dev_history/R-01_report.md` |
| 2 | — | — | `/Users/yzliu/work/Meridian/docs/branch/feat:experience-fix/v1.0/dev_history/R-02_report.md` |
| 3 | — | — | `/Users/yzliu/work/Meridian/docs/branch/feat:experience-fix/v1.0/dev_history/R-03_report.md` |
| 4 | — | — | `/Users/yzliu/work/Meridian/docs/branch/feat:experience-fix/v1.0/dev_history/R-04_report.md`, `/Users/yzliu/work/Meridian/docs/branch/feat:experience-fix/v1.0/dev_history/R-05_report.md` |
| Ω | — | — | `/Users/yzliu/work/Meridian/docs/branch/feat:experience-fix/v1.0/dev_history/delta_check_report.md` |
| Ω (PR) | — | — | `/Users/yzliu/work/Meridian/docs/branch/feat:experience-fix/v1.0/dev_history/pr_review_report.md` |
| Ω+1 (corrective) | — | — | `/Users/yzliu/work/Meridian/docs/branch/feat:experience-fix/v1.0/dev_history/delta/[WORKER_ID]_report.md` |
