# Meridian Upgrade v1.0 — Dispatch Plan

- **Version**: v1.0
- **Date**: 2026-03-15
- **Branch**: feat/upgrade-v1.0
- **Repo root**: /Users/yzliu/work/Meridian
- **TaskSpec**: /Users/yzliu/work/Meridian/docs/a2a_align/DEV/TaskSpec/meridian_taskspec_v1_0_upgrade.md
- **Dev history dir**: /Users/yzliu/work/Meridian/docs/a2a_align/DEV/

---

## Model Assignment Legend

| Code | Model | Assign When |
|------|-------|-------------|
| OPUS | Claude Opus | Multi-file coordination, complex rework, logic migration, adapter architecture |
| CODEX | Codex | Well-scoped type changes, simple method additions, flag wiring, UI changes |

---

## Master Dispatch Table

| Status | Batch | Worker | Task | Model | Depends On | PRDs to Attach | Notes |
|--------|-------|--------|------|-------|-----------|----------------|-------|
| ✅ | 1 | R-01 | types.ts Schema Extensions | CODEX | — | PRD_Meridian_Upgrade_v1.0.docx | Pure schema; no logic. 4 sub-tasks. |
| ✅ | 2 | N-01 | channel-adapter.ts Interface + SocketAdapter | CODEX | R-01 | PRD §2.2, §2.4 | Two new files; ~50 lines total |
| ✅ | 2 | R-02 | result-sender.ts Multi-Adapter Router | OPUS | R-01, N-01 | PRD §2.3 | Most complex rework. Scaffolding bridge first, real adapters later (N-02). |
| ✅ | 2 | R-03 | registry.ts setAutoApprove() | CODEX | R-01 | PRD §4.3 | Single method addition; ~15 lines |
| ✅ | 3 | R-04 | server.ts Hardcode Cleanup + Auto-Approve Intercept | OPUS | R-02, R-03 | PRD §3.1, §4.2 Method B, §4.5 | ⚠️ PM-FLAG-01: subscriber data structure may need extension to carry full ReplyChannel |
| ✅ | 3 | R-05 | router.ts handleDetail + isWebChannel Refactor | OPUS | R-02 | PRD §3.1 router rows | Delete 2 guards; web push restructure |
| ✅ | 3 | R-06 | instance-manager.ts spawn autoApprove | CODEX | R-01, R-03 | PRD §4.3, §4.5 | Thread autoApprove through spawn chain |
| ✅ | 3 | R-07 | monitor/index.ts channel fix | CODEX | R-01 | PRD §3.1 monitor row | Single-line channel value change |
| ⬜ | 4 | N-02 | interface/adapters/ TelegramAdapter + WebAdapter | OPUS | R-02, R-04, R-05 | PRD §2.2, §3.2 | Code MOVE not rewrite. Create adapters/ dir. |
| ⬜ | 4 | R-08 | interface/index.ts decouple send logic | OPUS | N-02 | PRD §3.1 interface rows | Extract buildTelegramReplyChannel helper; remove ResultSender import |
| ⬜ | 4 | R-09 | interface/slash-handler.ts /autoapprove | CODEX | R-03 | PRD §4.4 | New slash command; update HELP_MESSAGE |
| ⬜ | 4 | R-10 | web/server.ts spawn API + index.html | CODEX | R-06 | PRD §4.5, §5 web rows | Schema extension + UI toggle |
| ⬜ | 5 | R-11 | agents/claude.ts + agents/codex.ts CLI flags | CODEX | R-06 | PRD §4.2 Method A | Add autoApprove param to both builders |
| ⬜ | 6 | D-01 | Dead code sweep + test updates | OPUS | ALL | Full PRD | Final sweep; all tests must pass |

Status: `⬜` Not started · `🔄` In progress · `✅` Complete · `⛔` Blocked

---

## Batch Execution Details

### Batch 1 — Foundation Types

**Workers**: R-01  
**Priority**: P0  
**Model**: CODEX  
**Parallelism**: Single worker  

**Agent Notes**:
- Touch ONLY `src/types.ts`. Do not modify any other file.
- The `socket_path` field in `ReplyChannelSchema` must be optional and have NO cross-field `.refine()` validation.
- The `auto_approve` field must use `.default(false)` so existing persisted state loads cleanly.

**Completion Gate**: `npm run typecheck` clean; `npm test` passes; grep verifies `ChannelSchema` includes `'socket'`.

---

### Batch 2 — New Interface + Scaffolding

**Workers**: N-01, R-02, R-03  
**Priority**: P0  
**Model**: CODEX (N-01, R-03), OPUS (R-02)  
**Parallelism**: N-01 and R-03 can run in parallel; R-02 depends on N-01  

**Agent Notes (N-01)**:
- Two new files: `src/hub/channel-adapter.ts` (interface only, ~20 lines) and `src/hub/socket-adapter.ts` (implementation, ~30 lines).
- Reuse `sendIpcMessage` from `../shared/ipc`. Do NOT reinvent socket write logic.

**Agent Notes (R-02)**:
- The "bridge" pattern: in this batch, keep all Telegram logic in `result-sender.ts` but wrap it in a `TelegramChannelAdapterBridge` class implementing `ChannelAdapter`. This scaffolding will be replaced in Batch 4 (N-02).
- The outer `sendResult()` shell must change to the adapter-routing pattern.
- Zero behavior change for Telegram. All existing tests must pass after this batch.

**Agent Notes (R-03)**:
- Single method addition to `InstanceRegistry`. Follow immutable-copy pattern of `setStatus()`.

**Completion Gate**: Batch 1 is `✅`; `npm test` passes; `ResultSender` accepts adapters array.

---

### Batch 3 — Core Cleanup (Parallel)

**Workers**: R-04, R-05, R-06, R-07  
**Priority**: P0/P1  
**Model**: OPUS (R-04, R-05), CODEX (R-06, R-07)  
**Parallelism**: R-04 and R-05 can run in parallel; R-06 and R-07 can run in parallel  

**⚠️ PM-FLAG-01 (R-04)**: The 4 hardcoded `{ channel: 'telegram', chatId, botId }` constructions in `server.ts` all derive from a `replyTarget` or `subscriber` object. These objects likely only carry `chatId` and `botId` today. The agent implementing R-04 must:
1. Audit the `replyTarget` / subscriber type.
2. Extend it to carry the original `ReplyChannel` object.
3. Ensure all Telegram subscribers still produce `channel: 'telegram'` `ReplyChannel` (no behavior change).

**Agent Notes (R-05)**:
- Deleting `handleDetail` guard is a 5-line deletion — confirm the correct lines before deleting.
- `isWebChannel` refactor: the `handlePushFromWeb()` call can stay but must not use a raw string comparison. Route via `adapter.canHandle()` instead.

**Agent Notes (R-07)**:
- Single-line change. Extremely small scope. Verify `config.HUB_SOCKET_PATH` is accessible from `monitor/index.ts`.

**Completion Gate**: Batch 2 is `✅`; grep for hardcoded `channel: 'telegram'` in `server.ts` returns 0 construction objects; `npm test` passes.

---

### Batch 4 — Adapter Migration + UI (Parallel)

**Workers**: N-02, R-08, R-09, R-10  
**Priority**: P1  
**Model**: OPUS (N-02, R-08), CODEX (R-09, R-10)  
**Parallelism**: N-02 and R-09/R-10 can start in parallel (N-02 doesn't block R-09/R-10); R-08 depends on N-02  

**Agent Notes (N-02)**:
- This is a code MOVE. Do not rewrite Telegram logic — copy it into `TelegramChannelAdapter`, delete from `result-sender.ts`.
- Use `src/interface/adapters/` as the target directory (create it).
- After migration: `result-sender.ts` should contain only the `ResultSender` routing shell and no Telegram imports.

**Agent Notes (R-08)**:
- The goal is `interface/index.ts` has NO import of `ResultSender`.
- Extract a `buildTelegramReplyChannel(chatId, botId, messageId, chatName, botName)` helper to DRY up the repeated `{ channel: 'telegram', ... }` constructions. These are CORRECT (it's the Telegram bot entrypoint) — just deduplicated.

**Completion Gate**: Batch 3 is `✅`; `result-sender.ts` has no Telegram business logic; `npm test` passes; `/autoapprove on` slash command parses correctly.

---

### Batch 5 — Agent CLI Flags

**Workers**: R-11  
**Priority**: P1  
**Model**: CODEX  
**Parallelism**: Single worker  

**Agent Notes**:
- `buildClaudeCliArgs` signature changes: add optional `autoApprove?: boolean` as third parameter.
- `buildCodexSpawnArgs` signature changes: add optional `autoApprove?: boolean` as fifth parameter.
- Thread `autoApprove` from `instance-manager.ts` `buildSpawnArgs()` through to both builders.

**Completion Gate**: Batch 4 is `✅`; unit tests for both agent builders pass with auto-approve flag verification.

---

### Batch 6 — Final Sweep

**Workers**: D-01  
**Priority**: P2  
**Model**: OPUS  
**Parallelism**: Single worker; runs after ALL above batches  

**Agent Notes**:
- Remove `TelegramChannelAdapterBridge` scaffolding from `result-sender.ts`.
- Add tests for: `SocketChannelAdapter`, `setAutoApprove()`, `/autoapprove` slash command.
- Run full suite: `npm run typecheck && npm run lint && npm test && npm run test:integration`.
- Verify all 8 PRD §7 acceptance criteria are met.

**Completion Gate**: All 8 acceptance criteria pass; zero TypeScript/lint errors; all tests green.

---

## PM Flags Summary

| Flag | Location | Issue | Resolution |
|------|----------|-------|-----------|
| PM-FLAG-01 | R-04, server.ts | Subscriber objects may only carry chatId/botId, not full ReplyChannel | Extend subscriber type to carry original ReplyChannel; Telegram subscribers produce telegram ReplyChannel |
| PM-FLAG-02 | R-02, R-07 | monitor buildListRequestMessage suppress_reply=true — which channel? | Use channel:'socket' with HUB_SOCKET_PATH; suppress_reply=true prevents delivery anyway |
| PM-FLAG-03 | R-05, router.ts | isWebChannel refactor requires N-02 WebAdapter to be complete | R-05 can stub the web adapter call; N-02 completes the real implementation in Batch 4 |

---

## Completion Tracking

| Batch | Workers | Start Date | End Date | Report Path |
|-------|---------|-----------|---------|------------|
| 1 | R-01 | | | /Users/yzliu/work/Meridian/docs/a2a_align/DEV/batch1_R-01.md |
| 2 | N-01, R-02, R-03 | | | /Users/yzliu/work/Meridian/docs/a2a_align/DEV/batch2_*.md |
| 3 | R-04, R-05, R-06, R-07 | | | /Users/yzliu/work/Meridian/docs/a2a_align/DEV/batch3_*.md |
| 4 | N-02, R-08, R-09, R-10 | | | /Users/yzliu/work/Meridian/docs/a2a_align/DEV/batch4_*.md |
| 5 | R-11 | | | /Users/yzliu/work/Meridian/docs/a2a_align/DEV/batch5_R-11.md |
| 6 | D-01 | | | /Users/yzliu/work/Meridian/docs/a2a_align/DEV/batch6_D-01.md |
