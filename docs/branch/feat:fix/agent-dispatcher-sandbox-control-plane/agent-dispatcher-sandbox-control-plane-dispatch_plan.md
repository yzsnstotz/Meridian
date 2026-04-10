# Dispatch Plan: Agent Dispatcher sandbox/control-plane fix

**Version**: v1.0
**Date**: 2026-04-10
**Status**: Ready for dispatch

---

## File Directory Index

| Artifact | Full Absolute Path |
|----------|--------------------|
| **TaskSpec** | `/Users/yzliu/work/Meridian/Meridian-roles/docs/branch/feat:fix/agent-dispatcher-sandbox-control-plane/agent-dispatcher-sandbox-control-plane-taskspec.md` |
| **This document (Dispatch Plan)** | `/Users/yzliu/work/Meridian/Meridian-roles/docs/branch/feat:fix/agent-dispatcher-sandbox-control-plane/agent-dispatcher-sandbox-control-plane-dispatch_plan.md` |
| **Dispatch Command** | `/Users/yzliu/work/Meridian/Meridian-roles/docs/branch/feat:fix/agent-dispatcher-sandbox-control-plane/agent-dispatcher-sandbox-control-plane-agent_dispatch_command.md` |
| **Dev history dir** | `/Users/yzliu/work/Meridian/Meridian-roles/docs/branch/feat:fix/agent-dispatcher-sandbox-control-plane/dev_history/` |
| **Delta corrective dir** | `/Users/yzliu/work/Meridian/Meridian-roles/docs/branch/feat:fix/agent-dispatcher-sandbox-control-plane/dev_history/delta/` |
| **Delta report path** | `/Users/yzliu/work/Meridian/Meridian-roles/docs/branch/feat:fix/agent-dispatcher-sandbox-control-plane/dev_history/delta_check_report.md` |
| **PR review report path** | `/Users/yzliu/work/Meridian/Meridian-roles/docs/branch/feat:fix/agent-dispatcher-sandbox-control-plane/dev_history/pr_review_report.md` |
| **Meridian-roles repo root** | `/Users/yzliu/work/Meridian/Meridian-roles` |
| **Meridian companion repo root** | `/Users/yzliu/work/Meridian` |
| **Target Meridian-roles branch** | `feat/fix/agent-dispatcher-sandbox-control-plane` |
| **Recommended Meridian companion branch** | `feat/fix/agent-dispatcher-sandbox-control-plane-hub` |
| **Env bootstrap files** | `/Users/yzliu/work/Meridian/Meridian-roles/.env.local` and `/Users/yzliu/work/Meridian/Meridian-roles/.env.example` |

---

## PRD Reference Paths

| Label | Absolute Path |
|-------|---------------|
| `Issue Doc` | `/Users/yzliu/work/Meridian/Meridian-roles/docs/issue-pool/agent-dispatcher-sandbox-and-control-plane.md` |
| `Dispatcher PRD v2.2` | `/Users/yzliu/work/Meridian/Meridian-roles/docs/branch/feat:dispatcher-ephemeral-spawn-run-kill/meridian-roles-agent-dispatcher-PRD-v2.2.md` |
| `Previous TaskSpec v1.1` | `/Users/yzliu/work/Meridian/Meridian-roles/docs/branch/feat:dispatcher-ephemeral-spawn-run-kill/taskspec_v1_1.md` |
| `TaskSpec` | `/Users/yzliu/work/Meridian/Meridian-roles/docs/branch/feat:fix/agent-dispatcher-sandbox-control-plane/agent-dispatcher-sandbox-control-plane-taskspec.md` |

---

## Model Assignment Legend

| Code | Model | Assign When |
|------|-------|-------------|
| `CODEX` | Codex | All coding and terminal review workers in `Meridian-roles` |
| `HUMAN` | Human / specialized workspace owner | External repo patch or live integration verification |
| `PM` | Human PM | Decision rows only; never dispatched to a coding agent |

---

## Master Dispatch Table

| Status | Batch | Worker | Task | Model | Depends On | PRDs to Attach | Notes |
|--------|-------|--------|------|-------|------------|----------------|-------|
| ✅ | 0 | PRE-FLIGHT | Workspace, branch, and baseline validation | CODEX | — | Issue Doc, Dispatcher PRD v2.2, TaskSpec | Validate both repo roots, branch, Node/tooling, `dev_history/`, and Meridian-roles baseline. |
| ✅ | 1 | R-01 | Transport diagnostics and launch-ack visibility | CODEX | PRE-FLIGHT | Issue Doc, TaskSpec | Touches `ipc-bridge` and `file-relay`; keep fallback order unchanged. |
| ✅ | 1 | R-02 | Stale dispatcher demotion + service-owned `spawn_dir` hardening | CODEX | PRE-FLIGHT | Issue Doc, TaskSpec, Previous TaskSpec v1.1 | Touches role detail/continue paths and launch helpers. |
| ✅ | 1 | R-05 | Meridian companion `trace_id` observability patch | HUMAN | PRE-FLIGHT | Issue Doc, TaskSpec | External repo worker against `/Users/yzliu/work/Meridian`; coding agents must skip. |
| ✅ | 2 | R-03 | Service-owned autonomous launch migration | CODEX | R-01, R-02 | Issue Doc, Dispatcher PRD v2.2, TaskSpec | Main architectural change: remove prompt-local worker launch from primary path. |
| ✅ | 3 | R-04 | Watchdog / recovery control-plane unification | CODEX | R-02, R-03 | Issue Doc, TaskSpec | Replace sole-worker shortcut as primary recovery path; rehydration becomes bounded fallback. |
| ⬜ | 4 | R-06 | Regression sweep + operator docs | CODEX | R-01, R-02, R-03, R-04 | Issue Doc, TaskSpec | Full Meridian-roles validation and docs update. |
| ⬜ | 4 | V-01 | Live Meridian integration verification | HUMAN | R-01, R-02, R-03, R-04, R-05, R-06 | Issue Doc, TaskSpec | Real Hub / sandbox verification; coding agents must skip. |
| ⬜ | Ω | DELTA-CHECK | Delta check and corrective dispatch | CODEX | PRE-FLIGHT, R-01, R-02, R-03, R-04, R-05, R-06, V-01 | Issue Doc, TaskSpec | Must not auto-pass `R-05` or `V-01`. |
| ⬜ | Ω | PR-REVIEW | PR alignment review | CODEX | DELTA-CHECK, all Ω+1 corrective workers, all PM-DECIDE-N rows, R-05, V-01 | Issue Doc, Dispatcher PRD v2.2, TaskSpec | Final verdict blocks while external repo or live verification remains incomplete. |

**Status Legend**: `⬜` not started · `🔄` in progress · `✅` complete · `⛔` blocked · `⏳` PM decision pending

---

## Batch Execution Details

### Batch 0 — PRE-FLIGHT

**Workers**: PRE-FLIGHT  
**Priority**: P0  
**Parallelism**: serial

**Agent Notes**:
- Do not edit source files.
- Confirm the current branch is `feat/fix/agent-dispatcher-sandbox-control-plane`.
- Create `dev_history/` and `dev_history/delta/` if missing.

**Completion Gate**:
- Meridian-roles build + unit baseline pass.
- Companion Meridian repo is accessible.
- Absolute paths and branch roots are confirmed.

---

### Batch 1 — Diagnostics, lifecycle hardening, and companion observability

**Workers**: R-01, R-02, R-05  
**Priority**: P0 / P0 / P1  
**Parallelism**: 2 coding-agent lanes + 1 HUMAN lane

**Agent Notes for R-01**:
- Do not change fallback ordering.
- Preserve trace continuity in all new diagnostics.

**Agent Notes for R-02**:
- Missing-thread evidence should demote lifecycle state immediately, but generic transport failure should not be over-classified as missing-thread.
- No dispatcher-managed launch may rely on ambient `cwd`.

**Agent Notes for R-05**:
- HUMAN-owned external repo worker.
- Must record the Meridian companion branch and commit hash in the completion report.

**Completion Gate**:
- R-01 tests pass.
- R-02 tests pass.
- R-05 companion patch exists or is explicitly blocked with evidence.

---

### Batch 2 — Main autonomous launch migration

**Workers**: R-03  
**Priority**: P0  
**Parallelism**: serial

**Agent Notes**:
- This worker owns the main ownership shift from prompt to service.
- Do not leave a parallel “old prompt path” active as a hidden fallback.

**Completion Gate**:
- Prompt no longer describes prompt-local worker launch as the primary path.
- Tests prove autonomous service-owned launch.

---

### Batch 3 — Recovery and watchdog unification

**Workers**: R-04  
**Priority**: P0  
**Parallelism**: serial

**Agent Notes**:
- Replace the sole-eligible shortcut as the main recovery mechanism.
- Preserve dispatcher rehydration only as bounded fallback.

**Completion Gate**:
- Recovery behavior is deterministic for one-worker and multi-worker pending states.
- Watchdog/reconcile tests pass.

---

### Batch 4 — Regression and live verification

**Workers**: R-06, V-01  
**Priority**: P1 / P0  
**Parallelism**: 1 coding-agent lane + 1 HUMAN lane

**Agent Notes for R-06**:
- Run the full Meridian-roles validation suite.
- Update operator docs only after the architecture is settled.

**Agent Notes for V-01**:
- HUMAN-owned verification.
- Must exercise the exact failure family from the issue doc, not a generic smoke test.

**Completion Gate**:
- R-06: `build`, `test`, `test:e2e`, and `lint` all pass.
- V-01: every checklist row has evidence plus pass/fail.

---

### Batch Ω — Terminal review

**Workers**: DELTA-CHECK, PR-REVIEW  
**Priority**: P0  
**Parallelism**: serial

**Agent Notes for DELTA-CHECK**:
- Report path: `/Users/yzliu/work/Meridian/Meridian-roles/docs/branch/feat:fix/agent-dispatcher-sandbox-control-plane/dev_history/delta_check_report.md`
- Treat `R-05` and `V-01` as hard gates, not advisory notes.

**Agent Notes for PR-REVIEW**:
- Final verdict must block while `R-05` or `V-01` is incomplete.
- Report path: `/Users/yzliu/work/Meridian/Meridian-roles/docs/branch/feat:fix/agent-dispatcher-sandbox-control-plane/dev_history/pr_review_report.md`

**Completion Gate**:
- Delta report exists with per-worker verdicts.
- Corrective rows are complete or explicitly PM-blocked.
- PR review produces `MERGE APPROVED` or `MERGE BLOCKED — [reason]`.

---

## PM Flags Summary

| # | Flag | Stage | Impact | Resolution |
|---|------|-------|--------|------------|
| 1 | Meridian companion repo change is required for full same-trace observability | Pre-generation | Medium | Modeled as `R-05` HUMAN-owned external worker. |
| 2 | Prompt-local worker launch is still embedded in existing dispatcher behavior | Pre-generation | High | `R-03` migrates the main loop to service-owned launch. |
| 3 | Watchdog direct-continue handles only one eligible worker today | Pre-generation | High | `R-04` replaces it as the primary recovery path. |
| 4 | Codex CLI flag A/B cannot be reproduced on the current local CLI | Pre-generation | Low | Explicitly out of scope for this round. |
| 5 | Sandbox-mode payload field may still be desirable later | Pre-generation | Low | Logged as follow-on only if the migrated service path still reproduces failure. |

---

## Completion Tracking

| Worker | Report Path | Status |
|--------|-------------|--------|
| PRE-FLIGHT | `/Users/yzliu/work/Meridian/Meridian-roles/docs/branch/feat:fix/agent-dispatcher-sandbox-control-plane/dev_history/PRE-FLIGHT_report.md` | ✅ |
| R-01 | `/Users/yzliu/work/Meridian/Meridian-roles/docs/branch/feat:fix/agent-dispatcher-sandbox-control-plane/dev_history/R-01_report.md` | ✅ |
| R-02 | `/Users/yzliu/work/Meridian/Meridian-roles/docs/branch/feat:fix/agent-dispatcher-sandbox-control-plane/dev_history/R-02_report.md` | ✅ |
| R-03 | `/Users/yzliu/work/Meridian/Meridian-roles/docs/branch/feat:fix/agent-dispatcher-sandbox-control-plane/dev_history/R-03_report.md` | ✅ |
| R-04 | `/Users/yzliu/work/Meridian/Meridian-roles/docs/branch/feat:fix/agent-dispatcher-sandbox-control-plane/dev_history/R-04_report.md` | ✅ |
| R-05 | `/Users/yzliu/work/Meridian/Meridian-roles/docs/branch/feat:fix/agent-dispatcher-sandbox-control-plane/dev_history/R-05_report.md` | ✅ |
| R-06 | `/Users/yzliu/work/Meridian/Meridian-roles/docs/branch/feat:fix/agent-dispatcher-sandbox-control-plane/dev_history/R-06_report.md` | ⬜ |
| V-01 | `/Users/yzliu/work/Meridian/Meridian-roles/docs/branch/feat:fix/agent-dispatcher-sandbox-control-plane/dev_history/V-01_report.md` | ⬜ |
| DELTA-CHECK | `/Users/yzliu/work/Meridian/Meridian-roles/docs/branch/feat:fix/agent-dispatcher-sandbox-control-plane/dev_history/delta_check_report.md` | ⬜ |
| PR-REVIEW | `/Users/yzliu/work/Meridian/Meridian-roles/docs/branch/feat:fix/agent-dispatcher-sandbox-control-plane/dev_history/pr_review_report.md` | ⬜ |

---

## Dynamic Rows Policy

- `PM-DECIDE-N` rows may be appended only by DELTA-CHECK.
- `Ω+1` corrective rows depend on DELTA-CHECK and any required PM decisions.
- Coding agents must skip rows with `Model: HUMAN` or `Model: PM`.
- `R-05` and `V-01` are hard gates and must never be auto-passed.
- DELTA-CHECK marks itself `✅` only after it writes the report and appends any required rows.
