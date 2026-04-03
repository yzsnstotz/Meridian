# Dispatch Plan — Dispatcher Supervisor v1.1

- **Date**: 2026-04-03
- **TaskSpec**: `/Users/yzliu/work/Meridian/docs/branch/feat-dispatcher-supervisor-design/v1.0/taskspec_v1.0.md`
- **Branch (Meridian)**: `feat-dispatcher-supervisor-design`
- **Branch (Meridian-roles)**: `feat/fix/agent-dispatcher`

## PRD Reference Paths

| Shorthand | Full Path |
|-----------|-----------|
| Evaluation Doc | `/Users/yzliu/work/Meridian/docs/branch/feat-dispatcher-supervisor-design/v1.0/dispatcher_supervisor_evaluation_and_plan.md` |
| Integration Brief | `/Users/yzliu/work/Meridian/docs/branch/feat-dispatcher-hub-run-integration-fixes/integration_issue_brief.md` |
| Integration TaskSpec v1.0 | `/Users/yzliu/work/Meridian/docs/branch/feat-dispatcher-hub-run-integration-fixes/meridian_dispatcher_integration_taskspec_v1.0.md` |
| TaskSpec v1.1 | `/Users/yzliu/work/Meridian/docs/branch/feat-dispatcher-supervisor-design/v1.0/taskspec_v1.0.md` |

## Model Assignment Legend

| Model | Code | Assign When |
|-------|------|-------------|
| Codex | `CODEX` | Well-specified schema work, surgical edits, config/template generation, straightforward tool implementations, UI work with clear API contracts, simple CRUD |
| Codex High | `CODEX-HIGH` | Standard coordination tasks, moderate integration, stronger reasoning than CODEX, pre-flight or environment checks, prompt builders |
| Codex XHigh | `CODEX-XHIGH` | IPC/async/socket coordination, multi-file architectural integration, restart recovery, streaming, terminal review gates, or workers with 4+ upstream dependencies |
| Human (Verify) | `HUMAN` | V- workers requiring live system access |
| Human (PM) | `PM` | PM-DECIDE rows only — never pre-assigned |

## Master Dispatch Table

| Status | Batch | Worker | Task | Model | Depends On | PRDs to Attach | Notes |
|--------|-------|--------|------|-------|------------|----------------|-------|
| ✅ | 0 | PF-00 | Cross-Repo Pre-flight Baseline | CODEX-HIGH | — | TaskSpec v1.1 | Gates all workers |
| ✅ | 1 | N-01 | LifecycleStore (replaces ThreadTracker) | CODEX-XHIGH | PF-00 | Evaluation Doc, TaskSpec v1.1 | Core foundation; all other workers depend on this |
| ✅ | 2 | R-01 | Wire SessionManager to LifecycleStore | CODEX-XHIGH | N-01 | TaskSpec v1.1 | |
| ✅ | 2 | R-02 | Durable Run Registration | CODEX-XHIGH | N-01 | TaskSpec v1.1 | |
| ✅ | 3 | N-02 | Reconciler Function | CODEX-XHIGH | N-01, R-01 | Evaluation Doc, TaskSpec v1.1 | |
| ✅ | 4 | R-03 | Startup Rehydration | CODEX-XHIGH | N-02, R-01 | Evaluation Doc, TaskSpec v1.1 | |
| ✅ | 4 | R-04 | Reconcile API Endpoint & Post-HubResult Trigger | CODEX | N-02 | TaskSpec v1.1 | |
| ✅ | 5 | R-05 | Plan as Derived View | CODEX-HIGH | N-01 | Evaluation Doc, TaskSpec v1.1 | |
| 🔄 | 5 | R-06 | Observability Hardening | CODEX | — | Integration Brief, TaskSpec v1.1 | Parallel with R-05; no shared dependencies |
| ⬜ | 5.5 | BATCH-5-GATE | Batch 5 Integration Verification | CODEX-HIGH | R-05, R-06 | TaskSpec v1.1 | Must pass before V-01 |
| ⬜ | 6 | V-01 | Live System Verification | HUMAN | R-03, R-04, R-05, R-06 | Evaluation Doc, TaskSpec v1.1 | Cannot be completed by coding agents |
| ⬜ | Ω | DELTA-CHECK | Delta Check & Corrective Dispatch | CODEX-XHIGH | N-01, R-01, R-02, N-02, R-03, R-04, R-05, R-06, BATCH-5-GATE | TaskSpec v1.1, Evaluation Doc | Always completes after report. Appends PM-DECIDE + corrective rows as needed. |
| ⬜ | Ω+1 | PR-REVIEW | PR Alignment Review | CODEX-XHIGH | DELTA-CHECK, V-01 | TaskSpec v1.1, Evaluation Doc, delta_check_report | Terminal gate; human merges |

## Batch Execution Details

### Batch 0 — Pre-flight
- **Workers**: PF-00
- **Priority**: P0
- **Model**: CODEX-HIGH
- **Agent notes**: Validate both repos build cleanly. Verify all file paths. Document env var catalog.
- **Completion gate**: PF-00 is `✅`. If `⛔ BLOCKED`, halt entire dispatch.

### Batch 1 — Foundation
- **Workers**: N-01
- **Priority**: P0
- **Model**: CODEX-XHIGH
- **Agent notes**: This is the core data structure. Get the v1→v2 migration right — all downstream workers depend on it. Atomic writes are mandatory.
- **Completion gate**: N-01 is `✅` with all unit tests passing.

### Batch 2 — Wiring (parallel)
- **Workers**: R-01, R-02
- **Priority**: P0
- **Model**: CODEX-XHIGH (both)
- **Agent notes**: R-01 and R-02 are independent — they modify different files and both consume N-01's LifecycleStore. Can run in parallel.
- **Completion gate**: Both R-01 and R-02 are `✅`.

### Batch 3 — Reconciler
- **Workers**: N-02
- **Priority**: P0
- **Model**: CODEX-XHIGH
- **Agent notes**: Depends on R-01 because the reconciler uses `markAbandoned` semantics that session-manager also uses — need to ensure consistent behavior. Pure function, heavily tested.
- **Completion gate**: N-02 is `✅` with all reconciler tests passing.

### Batch 4 — Integration (parallel)
- **Workers**: R-03, R-04
- **Priority**: P0 (R-03), P1 (R-04)
- **Model**: CODEX-XHIGH (R-03), CODEX (R-04)
- **Agent notes**: R-03 depends on both N-02 and R-01. R-04 depends only on N-02. Can run in parallel if different agents.
- **Completion gate**: Both R-03 and R-04 are `✅`.

### Batch 5 — Polish (parallel)
- **Workers**: R-05, R-06
- **Priority**: P1 (both)
- **Model**: CODEX-HIGH (R-05), CODEX (R-06)
- **Agent notes**: R-05 modifies prompt-builder (Meridian-roles). R-06 modifies files in both repos. No file overlap — can run in parallel.
- **Completion gate**: Both R-05 and R-06 are `✅`.

### Batch 5.5 — Integration Gate
- **Workers**: BATCH-5-GATE
- **Priority**: P0
- **Model**: CODEX-HIGH
- **Agent notes**: Compile both repos. Run full Meridian-roles test suite. Verify no orphan ThreadTracker references. Verify reconciler is wired at all three trigger points.
- **Completion gate**: BATCH-5-GATE is `✅`. If `⛔ BLOCKED`, do not proceed to V-01.

### Batch 6 — Human Verification
- **Workers**: V-01
- **Priority**: P0
- **Model**: HUMAN
- **Agent notes**: Requires live Meridian + Meridian-roles with real providers. Follow verification checklist in TaskSpec.
- **Completion gate**: V-01 is `✅` with all checklist items filled.

### Batch Ω — Terminal
- **Workers**: DELTA-CHECK
- **Priority**: P0
- **Model**: CODEX-XHIGH
- **Agent notes**: One pass. Always marks itself `✅` after producing report. Appends corrective/PM-DECIDE rows as needed.
- **Completion gate**: DELTA-CHECK is `✅`.

### Batch Ω+1 — Terminal
- **Workers**: PR-REVIEW (+ any corrective workers appended by DELTA-CHECK)
- **Priority**: P0
- **Model**: CODEX-XHIGH
- **Agent notes**: Blocks on V-01 `✅`. If V-01 is `⬜`, verdict must be `MERGE BLOCKED`.
- **Completion gate**: PR-REVIEW is `✅` with `MERGE APPROVED` or `MERGE BLOCKED`.

## PM Flags Summary

| # | Flag | Resolution |
|---|------|------------|
| 1 | Cross-repo work: workers touch files in two different repos | Per PM Blocker Resolution #1: Meridian-roles changes go to `feat/fix/agent-dispatcher` branch. Meridian Hub changes (R-06.4 only) go to `feat-dispatcher-supervisor-design` branch. Workers must commit to the correct repo/branch. |
| 2 | R-02 needs `workerId` and `expectedOutputs` in run tool context — may not be available today | Worker R-02 must investigate the current run tool payload and determine how to extract or inject these values. If not possible without upstream changes, flag as `⛔ BLOCKED`. |
| 3 | LifecycleStore's `toPlanMarkdown()` needs knowledge of the plan template format | N-01 must read the current `dispatch_plan.md` format from the test fixtures to understand the markdown table structure. R-05 wires it — do not attempt plan generation in N-01 tests beyond a basic format check. |

## Completion Tracking

| Batch | Started | Completed | Report Files |
|-------|---------|-----------|--------------|
| 0 | | | `dev_history/PF-00_report.md` |
| 1 | | | `dev_history/N-01_report.md` |
| 2 | | | `dev_history/R-01_report.md`, `dev_history/R-02_report.md` |
| 3 | | | `dev_history/N-02_report.md` |
| 4 | | | `dev_history/R-03_report.md`, `dev_history/R-04_report.md` |
| 5 | | | `dev_history/R-05_report.md`, `dev_history/R-06_report.md` |
| 5.5 | | | `dev_history/BATCH-5-GATE_report.md` |
| 6 | | | `dev_history/V-01_report.md` |
| Ω | | | `dev_history/delta_check_report.md` |
| Ω+1 | | | `dev_history/pr_review_report.md` |
