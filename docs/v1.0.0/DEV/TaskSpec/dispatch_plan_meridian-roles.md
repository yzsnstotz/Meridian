# Dispatch Plan: meridian-roles v1.2

**Version**: v1.2
**Date**: 2026-03
**Status**: Phase 0 complete — Phase 1 ready for dispatch

---

## 📁 File Directory Index

| Artifact | Full Absolute Path |
|----------|----------------------|
| **TaskSpec** | `/Users/yzliu/work/Meridian/Meridian-roles/docs/v1.0.0/DEV/TaskSpec/TaskSpec_meridian-roles_v1.2.md` |
| **This document (Dispatch Plan)** | `/Users/yzliu/work/Meridian/Meridian-roles/docs/v1.0.0/DEV/TaskSpec/dispatch_plan_meridian-roles.md` |
| **Dispatch Command** | `/Users/yzliu/work/Meridian/Meridian-roles/docs/v1.0.0/DEV/TaskSpec/agent_dispatch_command_meridian-roles.md` |
| **Dev history dir** | `/Users/yzliu/work/Meridian/Meridian-roles/docs/v1.0.0/DEV/dev_history/` |
| **Repo root (meridian-roles)** | `/Users/yzliu/work/Meridian/Meridian-roles/` |
| **GitHub remote** | `https://github.com/yzsnstotz/meridian-roles.git` |
| **Meridian repo root** | `/Users/yzliu/work/Meridian/` |
| **Meridian GitHub remote** | `https://github.com/yzsnstotz/Meridian.git` |
| **PRD: meridian-roles v1.2** | `/Users/yzliu/work/Meridian/Meridian-roles/docs/v1.0.0/PRD/PRD_meridian-roles_v1.2.docx` |
| **PRD: Meridian 平台升级 v1.0** | `/Users/yzliu/work/Meridian/docs/a2a_align/PRD/PRD_Meridian_Upgrade_v1.0.docx` |
| **Env file** | `/Users/yzliu/work/Meridian/Meridian-roles/.env.local` |
| **Git branch** | `meridian-roles-v1.2` |

> ⚠️ `meridian-roles` is an **independent repository** (`yzsnstotz/meridian-roles.git`), separate from Meridian (`yzsnstotz/Meridian.git`). Agents must use the correct repo for all git operations. Only N-09 operates in the Meridian repo.

---

## Model Assignment Legend

| Code | Model | Assign When |
|------|-------|-------------|
| `OPUS` | Claude Opus | Complex multi-file coordination, architectural decisions, nuanced business logic, integration-heavy tasks |
| `CODEX` | Codex | Well-specified interface implementations, config files, straightforward CRUD, UI with clear API contracts |

---

## Master Dispatch Table

| Status | Phase | Worker | Task Name | Model | Depends On | PRDs to Attach | Notes |
|--------|-------|--------|-----------|-------|------------|----------------|-------|
| ✅ | 0 | N-01 | Scaffold + core types | OPUS | — | meridian-roles PRD v1.2, Meridian 平台升级 PRD v1.0 | ReplyChannelSchema must align with Meridian; human review required |
| ✅ | 1 | N-02 | A2A comms layer | CODEX | N-01 | meridian-roles PRD §1.2, §3.2 | sendIpcMessage format confirmed; socket lifecycle careful |
| ✅ | 1 | N-03 | BaseRole + RoleRunner | CODEX | N-01 | meridian-roles PRD §2.2 | Interface frozen; implement as specified |
| ✅ | 1 | N-04 | State persistence | CODEX | N-01 | meridian-roles PRD §2.1 | Atomic write pattern required |
| ✅ | 2 | N-05 | Dispatcher state machine | CODEX | N-02, N-03, N-04 | meridian-roles PRD §3 (full) | Critical path; `suppress_reply: false` must be explicit; PM code review on reply_channel shape |
| ✅ | 3 | N-06 | Inferred dispatch mode | CODEX | N-05 | meridian-roles PRD §3.1 | JSON fence stripping required; error state must not crash |
| ⬜ | 3 | N-07 | Prompt hot-reload API | CODEX | N-05 | meridian-roles PRD §4 | Write-through to StateStore on every change |
| ⬜ | 4 | N-08 | Web GUI | CODEX | N-05, N-07 | meridian-roles PRD §5 | Dark theme; vanilla JS; trace_id truncated to 8 chars |
| ⬜ | 4 | N-09 | Meridian index.html link | CODEX | N-02 | meridian-roles PRD §5, Meridian PRD | Targets MERIDIAN_ROOT, not REPO_ROOT — brief agent separately |
| ⬜ | 5 | N-10 | E2E tests + docs | OPUS | N-06, N-07, N-08, N-09 | All PRDs | Scenario B quality = manual review; `--mock` for CI |

**Status Legend**: `⬜` Not started · `🔄` In progress · `✅` Complete · `⛔` Blocked

---

## Batch Execution Details

### Phase 0 — Foundation (Serial)

**Workers**: 1 (N-01)
**Priority**: P0 — nothing else can start until this is ✅
**Model**: OPUS

**Agent Notes**:
- This is the single most critical task: `ReplyChannelSchema` must exactly match Meridian's upgraded `types.ts`
- After build succeeds, PM must manually diff `ReplyChannelSchema` against Meridian's `types.ts` before Phase 1 starts
- All Phase 1 agents will receive N-01 summary in their session context

**Completion Gate**:
- [x] `npm run build` exits 0, zero TS errors
- [x] `ReplyChannelSchema.parse({ channel:'socket', ... })` passes
- [ ] PM human review: schema diff vs Meridian complete

---

### Phase 1 — Core Infrastructure (Parallel × 3)

**Workers**: N-02 (OPUS), N-03 (CODEX), N-04 (CODEX)
**Priority**: P0
**Parallel**: All three can run simultaneously after Phase 0 gate passes

**Agent Notes for N-02 (OPUS)**:
- Most technically complex of the three: socket lifecycle, reconnect logic, sendIpcMessage format
- Read PRD §1.2 carefully — the `sendIpcMessage` format is CONFIRMED, implement exactly as specified
- Include comprehensive unit tests for socket error scenarios

**Agent Notes for N-03 (CODEX)**:
- Interface is frozen in PRD §2.2 and TaskSpec N-03 — implement exactly, do not invent new methods
- RoleRunner.dispatch() silent-ignore for unmatched threadId is a hard requirement

**Agent Notes for N-04 (CODEX)**:
- Atomic write (tmp → rename) is non-negotiable — corrupted state is worse than lost state
- Auto-create directory on first write

**Completion Gate**:
- [ ] N-02: A2AClient/Server unit tests pass; mock integration test passes
- [ ] N-03: RoleRunner unit tests pass; mock role activate/dispatch verified
- [ ] N-04: StateStore round-trip test passes; atomic write verified

---

### Phase 2 — Dispatcher Core (Serial)

**Workers**: 1 (N-05, OPUS)
**Priority**: P0 — critical path; most complex task in project

**Agent Notes**:
- Read TaskSpec N-05 in full before writing any code
- **PM checkpoint**: After implementation, PM must code-review the `reply_channel` construction in T0 dispatch — must confirm `channel:'socket'`, `socket_path: ROLES_SOCKET_PATH`, `suppress_reply: false`
- DAG cycle detection must be implemented (DFS) — do not skip
- T2 must have double-fire guard (semaphore or status flag)
- Carry N-01–N-04 summary in session context

**Completion Gate**:
- [ ] `dispatcher.test.ts` all passing
- [ ] E2E DAG test passing (mock mode)
- [ ] PM code review: reply_channel shape confirmed correct
- [ ] Real integration test: Meridian log shows `reply_channel.channel='socket'`

---

### Phase 3 — Extensions (Parallel × 2)

**Workers**: N-06 (OPUS), N-07 (CODEX)
**Priority**: P1
**Parallel**: Both can run after Phase 2 gate

**Agent Notes for N-06 (OPUS)**:
- Infer path uses the same HubMessage format as normal dispatch — no special protocol
- `inferTraceId` check must precede task `result_trace_id` check in `onInboundResult`
- JSON fence stripping regex: `/```json\s*([\s\S]*?)```/` — test edge cases

**Agent Notes for N-07 (CODEX)**:
- Write-through to StateStore on every PATCH — no in-memory-only state
- HTTP 400 for invalid body schema, 404 for missing threadId — no exceptions

**Completion Gate**:
- [ ] N-06: Infer unit tests pass; mock infer response parsed correctly; error state on bad JSON verified
- [ ] N-07: All 4 HTTP endpoints returning correct responses; disk sync verified

---

### Phase 4 — GUI + Integration (Parallel × 2)

**Workers**: N-08 (CODEX), N-09 (CODEX)
**Priority**: P1
**Parallel**: Both can run after Phase 3 gate

**Agent Notes for N-08 (CODEX)**:
- Three pages: Dashboard, Task Detail (3s poll), Prompt Editor
- trace_id display: always `trace_id.slice(0, 8)` — never full UUID
- Error format: `{ "error": "..." }` — no HTML error pages
- Match Meridian visual style: dark background, monospace thread IDs, minimal UI

**Agent Notes for N-09 (CODEX)**:
- ⚠️ This task works in `/Users/yzliu/work/Meridian`, not `/Users/yzliu/work/Meridian/Meridian-roles` — confirm path at session start
- ⚠️ Commits go to `yzsnstotz/Meridian.git`, NOT `yzsnstotz/meridian-roles.git`
- The `catch(() => {})` must be completely empty — no console.log, no re-throw
- After change: run full Meridian test suite and confirm zero regressions

**Completion Gate**:
- [ ] N-08: All 3 GUI pages load; API returns valid JSON; auto-poll working
- [ ] N-09: Meridian full test suite passes; link shows/hides correctly; no JS errors when roles stopped

---

### Phase 5 — E2E + Docs (Serial)

**Workers**: 1 (N-10, OPUS)
**Priority**: P1
**Prerequisite**: Meridian with socket channel support must be deployed and running

**Agent Notes**:
- Scenarios A, C, D, E: fully automated; must pass in CI with `--mock` flag
- Scenario B: automated execution but quality of inferred plan = manual review by PM
- README sequence diagram can be ASCII art — clarity > aesthetics
- `docs/adding-new-role.md` must include a complete working EchoRole example

**Completion Gate**:
- [ ] `npm run test:e2e` outputs pass for all 5 scenarios
- [ ] README: another developer can integrate from scratch following it alone
- [ ] socket-channel-flow.md: sequence diagram reviewed and approved by PM

---

## PM Flags Summary

| # | Flag | Phase | Impact | Resolution |
|---|------|-------|--------|------------|
| 1 | N-01 `ReplyChannelSchema` must exactly match Meridian's upgraded types.ts | 0 | High — wrong schema = silent failure in production | PM manually diffs schema after N-01 ✅ before Phase 1 starts |
| 2 | N-05 `suppress_reply: false` — if accidentally omitted or set true, results never return | 2 | Critical | PM code review of reply_channel construction block in dispatcher.ts |
| 3 | N-09 uses `/Users/yzliu/work/Meridian`, not `/Users/yzliu/work/Meridian/Meridian-roles` | 4 | Medium — agent writes to wrong repo if path is wrong | Brief N-09 agent explicitly with `/Users/yzliu/work/Meridian` absolute path in session prompt |
| 4 | E2E Scenario B requires a running idle claude agent | 5 | Medium — CI will fail if agent unavailable | Use `--mock` for CI; Scenario B = manual-only gate |
| 5 | `meridian-roles` is an independent repo — git operations must target `yzsnstotz/meridian-roles.git` | All | High — wrong repo pushes break both projects | Agents must verify `git remote -v` outputs `yzsnstotz/meridian-roles.git` at session start (except N-09) |

---

## Completion Tracking

| Phase | Worker | Start Date | End Date | Completion Report |
|-------|--------|------------|----------|-------------------|
| 0 | N-01 | 2026-03-16 | 2026-03-16 | `/Users/yzliu/work/Meridian/Meridian-roles/docs/v1.0.0/DEV/dev_history/N-01_completion.md` |
| 1 | N-02 | 2026-03-19 | 2026-03-19 | `/Users/yzliu/work/Meridian/Meridian-roles/docs/v1.0.0/DEV/dev_history/N-02_completion.md` |
| 1 | N-03 | 2026-03-19 | 2026-03-19 | `/Users/yzliu/work/Meridian/Meridian-roles/docs/v1.0.0/DEV/dev_history/N-03_completion.md` |
| 1 | N-04 | 2026-03-19 | 2026-03-19 | `/Users/yzliu/work/Meridian/Meridian-roles/docs/v1.0.0/DEV/dev_history/N-04_completion.md` |
| 2 | N-05 | 2026-03-19 | 2026-03-19 | `/Users/yzliu/work/Meridian/Meridian-roles/docs/v1.0.0/DEV/dev_history/N-05_completion.md` |
| 3 | N-06 | 2026-03-19 | 2026-03-19 | `/Users/yzliu/work/Meridian/Meridian-roles/docs/v1.0.0/DEV/dev_history/N-06_completion.md` |
| 3 | N-07 | — | — | `/Users/yzliu/work/Meridian/Meridian-roles/docs/v1.0.0/DEV/dev_history/N-07_completion.md` |
| 4 | N-08 | — | — | `/Users/yzliu/work/Meridian/Meridian-roles/docs/v1.0.0/DEV/dev_history/N-08_completion.md` |
| 4 | N-09 | — | — | `/Users/yzliu/work/Meridian/Meridian-roles/docs/v1.0.0/DEV/dev_history/N-09_completion.md` |
| 5 | N-10 | — | — | `/Users/yzliu/work/Meridian/Meridian-roles/docs/v1.0.0/DEV/dev_history/N-10_completion.md` |

> 📁 All completion report paths are relative to `/Users/yzliu/work/Meridian/Meridian-roles` — see File Directory Index.

---

## Session Context Injection Map

When starting a new agent session, inject the following context summaries:

| Worker | Inject |
|--------|--------|
| N-02 | N-01 build summary + exported type names |
| N-03 | N-01 build summary + exported type names |
| N-04 | N-01 build summary + `STATE_FILE_PATH` value |
| N-05 | N-01+N-02+N-03+N-04 summaries + confirmed socket paths |
| N-06 | N-05 implementation summary + `inferTraceId` field location |
| N-07 | N-04 state schema + N-05 role API shape |
| N-08 | N-07 HTTP endpoint contracts + N-05 role detail response shape |
| N-09 | N-02 `register_service` endpoint contract + `/Users/yzliu/work/Meridian` absolute path + ⚠️ git remote = `yzsnstotz/Meridian.git` |
| N-10 | Full project summary + confirmed socket paths + Meridian integration status |
