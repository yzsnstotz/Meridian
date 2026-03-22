# Dispatch Plan: meridian-roles full_test_report solution

**Version**: v1.0
**Date**: 2026-03-22
**Status**: Ready for dispatch

---

## File Directory Index

| Artifact | Full Absolute Path |
|----------|--------------------|
| **TaskSpec** | `/Users/yzliu/work/Meridian/Meridian-roles/docs/branch/feat:fix/2603211508/taskspec/full_test_report-solution-taskspec.md` |
| **This document (Dispatch Plan)** | `/Users/yzliu/work/Meridian/Meridian-roles/docs/branch/feat:fix/2603211508/taskspec/full_test_report-solution-dispatch_plan.md` |
| **Dispatch Command** | `/Users/yzliu/work/Meridian/Meridian-roles/docs/branch/feat:fix/2603211508/taskspec/full_test_report-solution-agent_dispatch_command.md` |
| **Dev history dir** | `/Users/yzliu/work/Meridian/Meridian-roles/docs/branch/feat:fix/2603211508/taskspec/dev_history/` |
| **Delta corrective dir** | `/Users/yzliu/work/Meridian/Meridian-roles/docs/branch/feat:fix/2603211508/taskspec/dev_history/delta/` |
| **Repo root** | `/Users/yzliu/work/Meridian/Meridian-roles` |
| **Current local branch** | `meridian-roles-v1.2` |
| **Target implementation branch** | `feat/fix/2603211508` |
| **Env bootstrap file** | `/Users/yzliu/work/Meridian/Meridian-roles/.env.example` |

---

## PRD Reference Paths

| Label | Absolute Path |
|-------|---------------|
| `Solution PRD` | `/Users/yzliu/work/Meridian/Meridian-roles/docs/branch/feat:fix/2603211508/taskspec/full_test_report-solution-prd.md` |
| `Test Report` | `/Users/yzliu/work/Meridian/Meridian-roles/docs/branch/feat:fix/2603211508/taskspec/full_test_report.md` |
| `Product PRD` | `/Users/yzliu/work/Meridian/Meridian-roles/docs/v1.0.0/PRD/PRD_meridian-roles_v1.2.md` |
| `Integration Notes` | `/Users/yzliu/work/Meridian/Meridian-roles/docs/branch/feat:fix/2603211508/meridian_integration_test_notes.md` |
| `TaskSpec` | `/Users/yzliu/work/Meridian/Meridian-roles/docs/branch/feat:fix/2603211508/taskspec/full_test_report-solution-taskspec.md` |

---

## Model Assignment Legend

| Code | Model | Assign When |
|------|-------|-------------|
| `OPUS` | Claude Opus | Multi-file coordination, schema/contract design, runtime refactors, cross-boundary integration |
| `CODEX` | Codex | Focused API work, GUI implementation, tests, docs, straightforward persistence changes |
| `PM` | Human PM | Decision rows only; never dispatched to an agent |
| `HUMAN` | Human / specialized agent | V- (Verify) workers requiring specific environments; standard coding agents must skip |

---

## Master Dispatch Table

| Status | Batch | Worker | Task | Model | Depends On | PRDs to Attach | Notes |
|--------|-------|--------|------|-------|------------|----------------|-------|
| ✅ | 0 | PRE-FLIGHT | Environment health check | CODEX | — | Solution PRD, Test Report, Product PRD | Use `/tmp/...` `STATE_FILE_PATH` override. Confirm branch target. Create `dev_history/` dirs. |
| 🟧 | 1 | R-01 | Config API + safe persistence (F-01) | CODEX | PRE-FLIGHT | Solution PRD, Product PRD | GET/PATCH config; 409 on running tasks; normalize runtime fields on save. |
| ✅ | 1 | R-03 | State-path diagnostics (F-04) | CODEX | PRE-FLIGHT | Solution PRD, Test Report | Keep default path; improve errors only. |
| ⬜ | 2 | R-02 | Config UI + role error states (F-01, F-02) | CODEX | R-01 | Solution PRD, Product PRD | Add `/role/:thread_id/config`; fix error title/subtitle; §P: error-path acceptance. |
| 🟧 | 2 | R-04 | Reply contract + instance discovery (F-06, F-07) | CODEX | PRE-FLIGHT | Solution PRD, Test Report, Product PRD | Replace summary `run` envelope; wire Hub-backed instance lookup. |
| ⬜ | 3 | R-05 | Full regression + docs (F-03, §P) | CODEX | R-01, R-02, R-03, R-04 | Solution PRD, Test Report, Product PRD, Integration Notes | Route-coverage gate (§P); clear lint; update docs; full matrix. |
| ⬜ | 3 | V-01 | Integration Hub Verification (F-06, F-07) | HUMAN | R-04 | Solution PRD, Test Report | Cannot be completed by coding agents. Requires Meridian Hub running. |
| 🟧 | Ω | DELTA-CHECK | Delta check & corrective dispatch | CODEX | PRE-FLIGHT, R-01, R-02, R-03, R-04, R-05, V-01 | Solution PRD, Test Report, Product PRD, TaskSpec | V-01 must be checked; one pass only; always marks self ✅. |
| 🟧 | Ω | PR-REVIEW | PR alignment review | CODEX | DELTA-CHECK, all Ω+1 corrective workers, all PM-DECIDE-N rows, V-01 | Solution PRD, Test Report, Product PRD, TaskSpec | V-01 gate: MERGE BLOCKED if V-01 ≠ ✅. Human merge only. |

**Status Legend**: `⬜` not started · `🔄` in progress · `✅` complete · `⛔` blocked · `⏳` PM decision pending

---

## Batch Execution Details

### Batch 0 — PRE-FLIGHT

**Workers**: PRE-FLIGHT
**Priority**: P0
**Parallelism**: serial

**Agent Notes**:
- Do not modify source files.
- Confirm target branch `feat/fix/2603211508` before any worker claims a task.
- `npm run lint` expected to fail (8 errors); record, don't block.
- Create `dev_history/` and `dev_history/delta/` directories.

**Completion Gate**:
- `npm run build` passes.
- `npm test` passes.
- `npm run test:e2e` passes.
- Node 20+ confirmed.
- Paths, env-var names, and dev_history dirs confirmed.

---

### Batch 1 — Backend Persistence Foundation

**Workers**: R-01, R-03
**Priority**: P0/P1 mixed
**Parallelism**: 2

**Agent Notes for R-01**:
- Editor schema must be separate from persisted dispatcher schema.
- Server owns editability and runtime-field normalization.
- Config writes must not mutate active running DAG. `409` when tasks running.

**Agent Notes for R-03**:
- Diagnostics-only. Do not change default path constant.
- Preserve atomic rename semantics.

**Completion Gate**:
- R-01 config endpoint tests pass.
- R-03 state-store tests pass.
- No scope overlap between workers.

---

### Batch 2 — UI Surface and Runtime Integration

**Workers**: R-02, R-04
**Priority**: P1 / P0
**Parallelism**: 2

**Agent Notes for R-02**:
- Match existing static asset pattern; no framework/router.
- Error-state rendering must replace title placeholder, not just subtitle (§P enforcement).
- Config UI honors server-side edit locks.

**Agent Notes for R-04**:
- Highest-risk worker in the round.
- Preserve explicit `target_thread_id` dispatch exactly.
- If instance lookup becomes async, propagate explicitly — no hidden globals.
- If Hub cannot honor `reply` or `list`, raise PM flag immediately.

**Completion Gate**:
- R-02 config route/UI regression passes.
- R-04 runtime/a2a regression passes.
- No ambiguous completion-summary envelope remains.

---

### Batch 3 — Regression Sweep, Docs, and Integration Verification

**Workers**: R-05, V-01
**Priority**: P1 / P0
**Parallelism**: 2 (R-05 by coding agent; V-01 by human)

**Agent Notes for R-05**:
- Close the loop on regressions and operator guidance.
- Fix residual lint failures in code/tests; do not disable rules.
- PRD route-coverage validation is mandatory (§P enforcement).
- Full validation matrix before DELTA-CHECK.

**Agent Notes for V-01**:
- Assigned to HUMAN. Coding agents must skip this row.
- Requires Meridian Hub running (test or production).
- Use `scripts/meridian-roles-dag-integration.ts` or equivalent.
- Fill the verification checklist in TaskSpec V-01 definition.
- Attach Hub logs as evidence.

**Completion Gate**:
- R-05: `npm run lint`, `npm test`, `npm run test:e2e` all pass; README updated.
- V-01: All verification checklist rows filled with Actual result and Pass/Fail.

---

### Batch Ω — Terminal Verification

**Workers**: DELTA-CHECK, PR-REVIEW
**Priority**: P0
**Parallelism**: serial

**Agent Notes for DELTA-CHECK**:
- Report path: `/Users/yzliu/work/Meridian/Meridian-roles/docs/branch/feat:fix/2603211508/taskspec/dev_history/delta_check_report.md`
- Corrective worker reports: `dev_history/delta/[WORKER_ID]_report.md`
- Check V-01 status: if `⬜`, mark as `❌ Missing — awaiting human verification`. Do NOT auto-pass.
- One pass only. Append `Ω+1` rows for corrective work.

**Agent Notes for PR-REVIEW**:
- Start only after DELTA-CHECK `✅` AND all `Ω+1` rows complete AND all PM-DECIDE rows `✅`.
- **V-01 gate**: If V-01 is `⬜` or `⛔`, verdict is `MERGE BLOCKED — V-01 not verified`.
- Report path: `/Users/yzliu/work/Meridian/Meridian-roles/docs/branch/feat:fix/2603211508/taskspec/dev_history/pr_review_report.md`
- Final verdict: exactly `MERGE APPROVED` or `MERGE BLOCKED — [reason]`.

**Completion Gate**:
- Delta report exists; every worker has verdict.
- Corrective rows complete or explicitly PM-blocked.
- PR review report exists with per-file verdicts and merge recommendation.
- V-01 explicitly addressed in both reports.

---

## PM Flags Summary

| # | Flag | Stage | Impact | Resolution |
|---|------|-------|--------|------------|
| 1 | Target branch inferred from docs path | Pre-generation | Low | Resolved: use `feat/fix/2603211508`, create from `meridian-roles-v1.2` if absent. |
| 2 | Config editor field scope underspecified | Pre-generation | Medium | Resolved: expose `tasks` + `taskspec` only; prompts separate. |
| 3 | Edit semantics during active execution unspecified | Pre-generation | High | Resolved: `409` while any task `running`. |
| 4 | Summary delivery and instance discovery need Hub contract | Pre-generation | High | Resolved: `reply` + `list` intents; escalate if Hub cannot honor. |
| 5 | Integration verification requires Hub running | Pre-generation | Medium | Resolved: V-01 worker (Model: HUMAN) handles integration-hub verification. |

---

## Completion Tracking

| Worker | Report Path | Status |
|--------|-------------|--------|
| PRE-FLIGHT | `/Users/yzliu/work/Meridian/Meridian-roles/docs/branch/feat:fix/2603211508/taskspec/dev_history/PRE-FLIGHT_report.md` | ✅ |
| R-01 | `/Users/yzliu/work/Meridian/Meridian-roles/docs/branch/feat:fix/2603211508/taskspec/dev_history/R-01_report.md` | ⬜ |
| R-02 | `/Users/yzliu/work/Meridian/Meridian-roles/docs/branch/feat:fix/2603211508/taskspec/dev_history/R-02_report.md` | ⬜ |
| R-03 | `/Users/yzliu/work/Meridian/Meridian-roles/docs/branch/feat:fix/2603211508/taskspec/dev_history/R-03_report.md` | ✅ |
| R-04 | `/Users/yzliu/work/Meridian/Meridian-roles/docs/branch/feat:fix/2603211508/taskspec/dev_history/R-04_report.md` | ⬜ |
| R-05 | `/Users/yzliu/work/Meridian/Meridian-roles/docs/branch/feat:fix/2603211508/taskspec/dev_history/R-05_report.md` | ⬜ |
| V-01 | `/Users/yzliu/work/Meridian/Meridian-roles/docs/branch/feat:fix/2603211508/taskspec/dev_history/V-01_report.md` | ⬜ |
| DELTA-CHECK | `/Users/yzliu/work/Meridian/Meridian-roles/docs/branch/feat:fix/2603211508/taskspec/dev_history/delta_check_report.md` | ⬜ |
| PR-REVIEW | `/Users/yzliu/work/Meridian/Meridian-roles/docs/branch/feat:fix/2603211508/taskspec/dev_history/pr_review_report.md` | ⬜ |

---

## Dynamic Rows Policy

- `PM-DECIDE-N` rows appended only by DELTA-CHECK.
- Corrective workers appended at `Ω+1`, depend on DELTA-CHECK and any needed `PM-DECIDE-N`.
- Agents must skip rows with `Model: PM` or `Model: HUMAN`.
- DELTA-CHECK marks itself `✅` immediately after report and row append.
- V-01 cannot be auto-passed by coding agents; must be completed by human with evidence.
