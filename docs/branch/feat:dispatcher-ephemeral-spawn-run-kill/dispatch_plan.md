# Agent Dispatcher — Dispatch Plan

- **TaskSpec**: `/Users/yzliu/work/Meridian/Meridian-roles/docs/branch/feat:dispatcher-ephemeral-spawn-run-kill/taskspec_v1_1.md`
- **Branch**: `feat/fix/agent-dispatcher`
- **Date**: 2026-03-28

---

## PRD Reference Paths

| Shorthand | Full Path |
|-----------|-----------|
| PRD v2.1 | `/Users/yzliu/work/Meridian/Meridian-roles/docs/branch/feat:dispatcher-ephemeral-spawn-run-kill/meridian-roles-agent-dispatcher-PRD-v2.1.md` |
| PRD v2.2 | `/Users/yzliu/work/Meridian/Meridian-roles/docs/branch/feat:dispatcher-ephemeral-spawn-run-kill/meridian-roles-agent-dispatcher-PRD-v2.2.md` |
| Investigation Report v2.1 | `/Users/yzliu/work/Meridian/Meridian-roles/docs/branch/feat:dispatcher-ephemeral-spawn-run-kill/investigation_report_v2.1.md` |
| Investigation Report v2.2 | `/Users/yzliu/work/Meridian/Meridian-roles/docs/branch/feat:dispatcher-ephemeral-spawn-run-kill/investigation_report_v2.2.md` |
| TaskSpec v1.2 | `/Users/yzliu/work/Meridian/Meridian-roles/docs/branch/feat:dispatcher-ephemeral-spawn-run-kill/taskspec_v1_1.md` |

---

## Model Assignment Legend

| Model | Code | Assign When |
|-------|------|-------------|
| Codex | `CODEX` | Existing assignment unchanged; well-specified schema work, surgical edits, straightforward tool implementations, UI work with clear API contracts |
| Codex High | `CODEX-HIGH` | Standard tasks requiring stronger coordination than `CODEX` but not full integration-heavy reasoning |
| Codex XHigh | `CODEX-XHIGH` | Complex/integration tasks, IPC/async, architectural coordination, terminal review gates |

---

## Master Dispatch Table

| Status | Batch | Worker | Task | Model | Depends On | PRDs to Attach | Notes |
|--------|-------|--------|------|-------|------------|----------------|-------|
| ✅ | 0 | PRE-FLIGHT | Environment health check | CODEX-HIGH | — | — | Gates all workers |
| ✅ | 1 | R-01 | RoleRunner bypass for agent-dispatcher | CODEX | — | PRD v2.1, Investigation Report | 3 surgical edits + stub |
| ✅ | 1 | N-01 | Tool Gateway infrastructure | CODEX-XHIGH | — | PRD v2.1, Investigation Report | registry + loader + ipc-bridge |
| ✅ | 2 | N-02 | CLI entry point (meridian-tool) | CODEX | N-01 | PRD v2.1 | `npx tsx` invocation |
| ✅ | 2 | N-03 | spawn.ts tool | CODEX-XHIGH | N-01 | PRD v2.1, Investigation Report | Hub IPC + JSON regex |
| ✅ | 2 | N-04 | run.ts tool | CODEX-XHIGH | N-01 | PRD v2.1, Investigation Report | Hub IPC + no timeout |
| ✅ | 2 | N-05 | kill.ts + notify.ts + update-status.ts | CODEX | N-01 | PRD v2.1 | 3 simpler tools |
| ✅ | 3 | N-06 | Dispatcher launch wrapper (Tool Gateway CLI) | CODEX-XHIGH | N-02 | PRD v2.2, Investigation Report v2.2 | meridian-tool spawn + run CLI wrapper |
| ⬜ | 3 | N-07 | Prompt builder | CODEX-HIGH | N-05 | PRD v2.1, Investigation Report v2.1 | System prompt with `npx tsx` tool refs |
| ⬜ | 3 | N-08 | Session metadata + thread sidecar + restart recovery | CODEX-XHIGH | N-05 | PRD v2.2, Investigation Report v2.2 | Session metadata + sidecar + pause/resume + restart recovery |
| ⬜ | 4 | N-09 | agent-dispatcher.ts role definition | CODEX-XHIGH | R-01, N-06, N-07, N-08 | PRD v2.2, TaskSpec v1.2 | Wires all components; replaces R-01 stub |
| ⬜ | 5 | N-10 | HTTP API: start (spawn+run Dispatcher) + pause/resume + channels | CODEX-XHIGH | N-09 | PRD v2.2, TaskSpec v1.2 | Spawn+run Dispatcher via launcher; PM Flag #1 multi-channel |
| ⬜ | 6 | N-11 | GUI: Agent Dispatcher dashboard | CODEX | N-10 | PRD v2.2, TaskSpec v1.2 | Dashboard + detail + start form + channel dropdown |
| ⬜ | Ω | DELTA-CHECK | Delta Check & Corrective Dispatch | CODEX-XHIGH | R-01, N-01–N-11 | TaskSpec v1.2, PRD v2.2 | One pass only |
| ⬜ | Ω+1 | PR-REVIEW | PR Alignment Review | CODEX-XHIGH | DELTA-CHECK | TaskSpec v1.2, PRD v2.2 | Terminal gate; human merges |

---

## Batch Execution Details

### Batch 0 — PRE-FLIGHT

- **Workers**: PRE-FLIGHT
- **Priority**: P0 — gates all subsequent batches
- **Model**: CODEX-HIGH
- **Agent Notes**: Run typecheck, test suite, and dependency check. If any fails → `⛔ BLOCKED`, halt dispatch
- **Completion Gate**: PRE-FLIGHT `✅`

### Batch 1 — Foundation (parallel)

- **Workers**: R-01, N-01
- **Priority**: P0
- **Models**: R-01=CODEX, N-01=CODEX-XHIGH
- **Agent Notes**:
  - R-01: 3 surgical edits to `types.ts`, `role-runner.ts`, `role-handlers.ts` + stub `agent-dispatcher.ts`. Must not break existing dispatcher tests
  - N-01: Creates entire `src/tool-gateway/` directory. IPC bridge is the most complex piece — temp socket + SIGINT cleanup
- **Completion Gate**: Both R-01 and N-01 `✅`; `npx tsc --noEmit` passes

### Batch 2 — Tools + CLI (parallel)

- **Workers**: N-02, N-03, N-04, N-05
- **Priority**: P0
- **Models**: N-02=CODEX, N-03=CODEX-XHIGH, N-04=CODEX-XHIGH, N-05=CODEX
- **Agent Notes**:
  - All 4 workers depend on N-01's `ToolDefinition` interface and `ipc-bridge.ts`
  - N-03 (spawn): regex JSON extraction from Hub content
  - N-04 (run): no timeout, SIGINT handling
  - N-05: three simpler tools — kill (always ok), notify (fire-and-forget), update-status (markdown parsing)
  - N-02: CLI entry point wires everything together
- **Completion Gate**: All 4 `✅`; all tool unit tests pass; `npx tsx src/bin/meridian-tool.ts --help` lists 5 tools

### Batch 3 — Dispatcher Internals (parallel)

- **Workers**: N-06, N-07, N-08
- **Priority**: P0
- **Models**: N-06=CODEX-XHIGH, N-07=CODEX-HIGH, N-08=CODEX-XHIGH
- **Agent Notes**:
  - N-06 (launch wrapper): `meridian-tool spawn + run` CLI wrapper — no direct `child_process.spawn` of agents
  - N-07 (prompt-builder): **critical**: all tool examples must use `npx tsx src/bin/meridian-tool.ts`, NOT `npx meridian-tool`
  - N-08 (session metadata): session metadata + thread sidecar + pause/resume + restart recovery — NO `startDispatch()` orchestration loop
- **Completion Gate**: All 3 `✅`; unit tests pass

### Batch 4 — Role Definition

- **Workers**: N-09
- **Priority**: P0
- **Model**: CODEX-XHIGH
- **Agent Notes**: Wires launcher + prompt-builder + session-manager into `AgentDispatcherRole`. Replaces R-01 stub. Must implement all `BaseRole` lifecycle methods. `onStatusChange` needed for pause/resume (Batch 5)
- **Completion Gate**: N-09 `✅`; `registry.create("agent-dispatcher", ...)` returns working instance; existing dispatcher tests still pass

### Batch 5 — API Layer

- **Workers**: N-10
- **Priority**: P1
- **Model**: CODEX-XHIGH
- **Agent Notes**: Dispatcher spawn+run via launcher, record `dispatcher_thread_id` to sidecar + pause/resume wiring + channels. PM Flag #1: `user_reply_channels` is multi-channel array. Channel registry reads from Hub
- **Completion Gate**: N-10 `✅`; all 3 endpoints respond correctly

### Batch 6 — GUI

- **Workers**: N-11
- **Priority**: P1
- **Model**: CODEX
- **Agent Notes**: Dashboard, detail view, start form with channel multi-select dropdown, pause/resume buttons. Follow existing `src/web/` patterns
- **Completion Gate**: N-11 `✅`; manual GUI verification

### Batch Ω — Delta Check

- **Workers**: DELTA-CHECK
- **Model**: CODEX-XHIGH
- **Agent Notes**: One pass. Diff `main..HEAD` against all acceptance criteria. Append corrective workers if ≤5 findings
- **Completion Gate**: DELTA-CHECK `✅`; all workers `✅ Aligned`

### Batch Ω+1 — PR Review

- **Workers**: PR-REVIEW
- **Model**: CODEX-XHIGH
- **Agent Notes**: Terminal gate. Per-file verdict. Human merges
- **Completion Gate**: PR-REVIEW `✅`; `MERGE APPROVED` or `MERGE BLOCKED`

---

## PM Flags Summary

| # | Flag | Batch | Resolution |
|---|------|-------|------------|
| 1 | `user_reply_channels` multi-channel (PRD says singular) | 5 | Extend to array. Accept both singular and array form in API payload |
| 2 | Channel registry source | 5 | Read from Hub registry. Fallback empty if Hub unreachable |
| 3 | R-01 stub → N-09 replacement | 1→4 | Stub in Batch 1 must compile. N-09 replaces in Batch 4. TypeScript must pass at every batch boundary |

---

## Completion Tracking

| Batch | Start Date | End Date | Reports |
|-------|------------|----------|---------|
| 0 | | | `dev_history/v1_round/PRE-FLIGHT_report.md` |
| 1 | | | `dev_history/v1_round/R-01_report.md`, `dev_history/v1_round/N-01_report.md` |
| 2 | | | `dev_history/v1_round/N-02_report.md`, `N-03_report.md`, `N-04_report.md`, `N-05_report.md` |
| 3 | | | `dev_history/v1_round/N-06_report.md`, `N-07_report.md`, `N-08_report.md` |
| 4 | | | `dev_history/v1_round/N-09_report.md` |
| 5 | | | `dev_history/v1_round/N-10_report.md` |
| 6 | | | `dev_history/v1_round/N-11_report.md` |
| Ω | | | `dev_history/v1_round/delta_check_report.md` |
| Ω+1 | | | `dev_history/v1_round/pr_review_report.md` |
