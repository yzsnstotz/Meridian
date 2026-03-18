# Meridian Upgrade TaskSpec — A2A Channel Adapter + Auto-Approval

- **Version**: v1.0
- **Date**: 2026-03-15
- **Revision Note**: 2026-03-19 terminal pass update — appended mandatory `DELTA-CHECK` and `PR-REVIEW` tasks
- **Input Document**: /Users/yzliu/work/Meridian/docs/a2a_align/PRD/PRD_Meridian_Upgrade_v1.0.docx
- **Based on**: Full code review of Meridian-main repo
- **Scope**: Phase 1 only — Channel Adapter abstraction + Socket channel + Coupling cleanup + Auto-Approval
- **Phase 2 (out of scope)**: meridian-telegram / meridian-web independent process split

---

## Conflict Resolution Rules

> PRD document > This TaskSpec > Existing implementation.
> Any discrepancy with the PRD must defer to PRD_Meridian_Upgrade_v1.0.docx.
> Requirements not defined in the PRD: developer must pause and file an issue; do not proceed until PM provides a clear definition.

---

## PM Blocker Resolutions

| # | Issue | Resolution |
|---|-------|-----------|
| PM-01 | `monitor/index.ts` `suppress_reply: true` is set but channel is still hardcoded `telegram` — which adapter handles suppressed replies? | Change to `channel: 'socket'` with `socket_path: config.HUB_SOCKET_PATH`. No external adapter needed; socket adapter handles IPC internally. The `suppress_reply` flag is sufficient to prevent user-facing delivery. |
| PM-02 | `flushPushAccumulator` in `server.ts` detects `action_required` — which terminal input key does auto-approve send? | PRD §4.2 Method B specifies `'all'` (sends BTab). Keep as-is: `instanceManager.sendTerminalInput(threadId, 'all')`. |
| PM-03 | `state-store.ts` schema `PersistedHubStateSchema` doesn't include `auto_approve` — will it persist across restarts? | `auto_approve` field is added to `AgentInstanceSchema` in `types.ts`. Since `state-store.ts` serializes `AgentInstance[]` directly, it will persist automatically without schema changes. No separate migration needed. |
| PM-04 | `handlePushFromWeb` in `router.ts` — does web-channel push path need adapter refactoring in Phase 1? | Phase 1 only: move web push logic into `WebChannelAdapter.send()`. The `handlePushFromWeb` method stays but is called from within the adapter. The `isWebChannel` branch in router.ts push handler is eliminated. |
| PM-05 | `interface/auth.ts` logs `channel: 'telegram'` as a literal string in log fields (not `ReplyChannel`) — is this in scope? | Yes, treat as cosmetic cleanup. Change the log field to `channel: 'telegram'` string literal → `'telegram' as const` (already correct type). No structural change needed. |

---

## Dispatch Table (Summary)

| Batch | Worker | Name | Model | Depends On |
|-------|--------|------|-------|-----------|
| 1 | R-01 | types.ts — Schema Extensions | CODEX | — |
| 2 | N-01 | channel-adapter.ts — Interface + SocketAdapter | CODEX | R-01 |
| 2 | R-02 | result-sender.ts — Multi-Adapter Router | OPUS | R-01, N-01 |
| 2 | R-03 | registry.ts — setAutoApprove() | CODEX | R-01 |
| 3 | R-04 | server.ts — Hardcode Cleanup + Auto-Approve Intercept | OPUS | R-02, R-03 |
| 3 | R-05 | router.ts — handleDetail + isWebChannel Refactor | OPUS | R-02 |
| 3 | R-06 | instance-manager.ts — spawn autoApprove + CLI flags | CODEX | R-01, R-03 |
| 3 | R-07 | monitor/index.ts — channel fix | CODEX | R-01 |
| 4 | N-02 | interface/adapters/ — TelegramAdapter + WebAdapter | OPUS | R-02, R-04, R-05 |
| 4 | R-08 | interface/index.ts — decouple send logic | OPUS | N-02 |
| 4 | R-09 | interface/slash-handler.ts — /autoapprove command | CODEX | R-03 |
| 4 | R-10 | web/server.ts — spawn API + index.html | CODEX | R-06 |
| 5 | R-11 | agents/claude.ts + agents/codex.ts — CLI flags | CODEX | R-06 |
| 6 | D-01 | Dead code sweep + test updates | OPUS | ALL above |
| Ω | DELTA-CHECK | Delta Check & Corrective Dispatch | OPUS | All implementation Workers |
| Ω | PR-REVIEW | PR Alignment Review | OPUS | DELTA-CHECK |

---

## Worker Definitions

---

### R-01 — types.ts Schema Extensions

- **Runtime**: Node.js / TypeScript (shared types)
- **Delta Type**: REWORK
- **Phase**: 0
- **Priority**: P0
- **Depends on**: —

#### Sub-tasks

**R-01.1 — Extend ChannelSchema to include 'socket'**
- In `src/types.ts`, change `ChannelSchema = z.enum(['telegram', 'web'])` to `z.enum(['telegram', 'web', 'socket'])`.
- Update `Channel` type inference accordingly.
- **Key constraint**: No other logic changes in this file during this sub-task. Schema only.
- **Acceptance**: `ChannelSchema.parse('socket')` does not throw.
- **Ref**: PRD §2.1

**R-01.2 — Extend ReplyChannelSchema with socket_path**
- Add `socket_path: z.string().min(1).optional()` to `ReplyChannelSchema`.
- Add comment: `// required when channel === 'socket'`
- Runtime validation (channel=socket implies socket_path) is enforced in SocketAdapter, NOT in the schema (to keep the schema non-cross-field validated).
- **Key constraint**: Do NOT add `.refine()` cross-field validation to the schema — this breaks existing callers that construct partial objects.
- **Acceptance**: `ReplyChannelSchema.parse({ channel: 'socket', chat_id: 'test', socket_path: '/tmp/test.sock' })` succeeds.
- **Ref**: PRD §2.1

**R-01.3 — Add auto_approve field to AgentInstanceSchema**
- Add `auto_approve: z.boolean().default(false)` to `AgentInstanceSchema`.
- **Key constraint**: Must have `.default(false)` so existing persisted state without the field loads cleanly.
- **Acceptance**: `AgentInstanceSchema.parse({ ...existingInstance })` with no `auto_approve` field produces `{ auto_approve: false, ...rest }`.
- **Ref**: PRD §4.3

**R-01.4 — Add set_auto_approve to BUILT_IN_INTENTS**
- Add `'set_auto_approve'` to the `BUILT_IN_INTENTS` array in `types.ts`.
- **Acceptance**: `BuiltInIntentSchema.parse('set_auto_approve')` does not throw.
- **Ref**: PRD §4.5

#### AI Auto-Tests
```bash
cd /Users/yzliu/work/Meridian
npm run typecheck
node -e "
const { ChannelSchema, ReplyChannelSchema, AgentInstanceSchema, BuiltInIntentSchema } = require('./src/types');
ChannelSchema.parse('socket');
ReplyChannelSchema.parse({ channel: 'socket', chat_id: 'x', socket_path: '/tmp/t.sock' });
const inst = AgentInstanceSchema.parse({ thread_id: 'x', agent_type: 'claude', mode: 'bridge', socket_path: '/tmp/x.sock', pid: 1, status: 'idle', created_at: new Date().toISOString(), tmux_pane: null });
console.assert(inst.auto_approve === false);
BuiltInIntentSchema.parse('set_auto_approve');
console.log('R-01 all assertions passed');
"
npm test -- --grep "types"
```

#### Human Acceptance Criteria
- `src/types.ts` `ChannelSchema` contains exactly `'telegram' | 'web' | 'socket'`.
- `ReplyChannel` type has an optional `socket_path?: string` field.
- `AgentInstance` type has `auto_approve: boolean` (defaults false).
- No TypeScript compiler errors across the full project (`npm run typecheck` clean).

---

### N-01 — channel-adapter.ts Interface + SocketAdapter

- **Runtime**: Node.js / TypeScript
- **Delta Type**: NEW
- **Phase**: 1
- **Priority**: P0
- **Depends on**: R-01

#### Sub-tasks

**N-01.1 — Create src/hub/channel-adapter.ts with ChannelAdapter interface**
- Create new file `src/hub/channel-adapter.ts`.
- Define and export `ChannelAdapter` interface:
  ```typescript
  export interface ChannelAdapter {
    readonly channel: Channel
    canHandle(replyChannel: ReplyChannel): boolean
    send(result: HubResult, replyChannel: ReplyChannel): Promise<void>
  }
  ```
- Import `Channel`, `ReplyChannel`, `HubResult` from `../types`.
- **Acceptance**: File compiles with zero errors. Interface is importable from other files.
- **Ref**: PRD §2.2

**N-01.2 — Create src/hub/socket-adapter.ts with SocketChannelAdapter**
- Create `src/hub/socket-adapter.ts`.
- Implement `SocketChannelAdapter implements ChannelAdapter`:
  - `readonly channel = 'socket' as const`
  - `canHandle(rc)`: returns `rc.channel === 'socket'`
  - `send(result, rc)`: throws if `!rc.socket_path`; otherwise calls `sendIpcMessage(rc.socket_path, result)` from `../shared/ipc`.
- Reuse existing `sendIpcMessage` — do NOT inline raw socket code.
- **Key constraint**: ~30 lines max. No Telegram or web logic.
- **Acceptance**: `SocketChannelAdapter.send()` with a valid socket_path calls `sendIpcMessage`; throws with `'socket_path required for socket channel'` if socket_path missing.
- **Ref**: PRD §2.4

#### AI Auto-Tests
```bash
cd /Users/yzliu/work/Meridian
npm run typecheck
node -e "
const { SocketChannelAdapter } = require('./src/hub/socket-adapter');
const adapter = new SocketChannelAdapter();
console.assert(adapter.channel === 'socket');
console.assert(adapter.canHandle({ channel: 'socket', chat_id: 'x', socket_path: '/tmp/x.sock' }) === true);
console.assert(adapter.canHandle({ channel: 'telegram', chat_id: 'x' }) === false);
console.log('N-01 assertions passed');
"
```

#### Human Acceptance Criteria
- `src/hub/channel-adapter.ts` and `src/hub/socket-adapter.ts` exist.
- `SocketChannelAdapter` correctly routes only `channel: 'socket'` messages.
- `sendIpcMessage` is reused (not duplicated).
- TypeScript clean with no `any` or suppression comments.

---

### R-02 — result-sender.ts Multi-Adapter Router

- **Runtime**: Node.js / TypeScript
- **Delta Type**: REWORK
- **Phase**: 1
- **Priority**: P0
- **Depends on**: R-01, N-01

#### Sub-tasks

**R-02.1 — Refactor ResultSender class to accept adapters array**
- Change `ResultSender` constructor to accept `adapters: ChannelAdapter[]`.
- Store as `private readonly adapters: ChannelAdapter[]`.
- Rewrite `sendResult(result, replyChannel)` to:
  1. Parse both args with their schemas.
  2. `find` the first adapter where `canHandle(replyChannel)` is true.
  3. If none found, throw `new Error(\`No adapter registered for channel: ${replyChannel.channel}\`)`.
  4. Call `adapter.send(result, replyChannel)`.
- **Key constraint**: All existing Telegram-specific private methods (bot token resolution, message composition, etc.) stay in `result-sender.ts` for now — they will migrate to `TelegramAdapter` in Worker N-02. In this worker, we ONLY change the outer routing shell.
- **Acceptance**: `new ResultSender([telegramAdapter]).sendResult(result, telegramReplyChannel)` calls through to the telegram adapter.
- **Ref**: PRD §2.3

**R-02.2 — Preserve existing Telegram send capability via internal adapter**
- Temporarily create an inline `TelegramChannelAdapterBridge` inside `result-sender.ts` that wraps all existing Telegram logic and implements `ChannelAdapter`.
- Wire this into the `ResultSender` constructor call site in `hub/index.ts` (wherever `ResultSender` is instantiated).
- This is a scaffolding step — it will be removed when N-02 creates the real `TelegramAdapter`.
- **Key constraint**: Zero behavior change for Telegram channel. All existing tests must pass.
- **Acceptance**: All existing tests pass after this change.
- **Ref**: PRD §2.3, §7 acceptance item 3

**R-02.3 — Wire SocketChannelAdapter into ResultSender at hub startup**
- In `src/hub/index.ts` (hub entry point), add `SocketChannelAdapter` to the adapters array passed to `ResultSender`.
- **Acceptance**: `ResultSender` receives `[socketAdapter, telegramBridgeAdapter]` (or similar ordering with socket first).
- **Ref**: PRD §2.4

#### AI Auto-Tests
```bash
cd /Users/yzliu/work/Meridian
npm run typecheck
npm test
```

#### Human Acceptance Criteria
- `ResultSender` constructor signature is `constructor(adapters: ChannelAdapter[])`.
- The hardcoded `channel !== 'telegram' → throw` check is completely removed from `result-sender.ts`.
- All unit tests pass with zero regressions.
- `hub/index.ts` wires both socket and telegram adapters.

---

### R-03 — registry.ts setAutoApprove()

- **Runtime**: Node.js / TypeScript
- **Delta Type**: REWORK
- **Phase**: 1
- **Priority**: P1
- **Depends on**: R-01

#### Sub-tasks

**R-03.1 — Add setAutoApprove() method to InstanceRegistry**
- Add method:
  ```typescript
  setAutoApprove(threadId: string, value: boolean): AgentInstance | undefined {
    const existing = this.instances.get(threadId);
    if (!existing) return undefined;
    const updated = { ...existing, auto_approve: value };
    this.instances.set(threadId, updated);
    return { ...updated };
  }
  ```
- **Key constraint**: Follow the same immutable-copy pattern as existing `setStatus()`. No direct mutation.
- **Acceptance**: `registry.setAutoApprove('tid', true)` returns the updated instance with `auto_approve: true`; `registry.get('tid')?.auto_approve === true`.
- **Ref**: PRD §4.3

#### AI Auto-Tests
```bash
cd /Users/yzliu/work/Meridian
npm run typecheck
npm test -- --grep "registry"
```

#### Human Acceptance Criteria
- `InstanceRegistry` has `setAutoApprove(threadId, value)` method.
- Method follows the immutable-copy pattern (no direct `.auto_approve = value` mutation).
- Existing registry tests still pass.

---

### R-04 — server.ts Hardcode Cleanup + Auto-Approve Intercept

- **Runtime**: Node.js / TypeScript
- **Delta Type**: REWORK
- **Phase**: 1
- **Priority**: P0
- **Depends on**: R-02, R-03

#### Sub-tasks

**R-04.1 — Fix 4 hardcoded telegram channel constructions in server.ts**
- **Location references** (line numbers are approximate — verify in current file):
  - `deliverMonitorAlert()` (~L494): `{ channel: 'telegram', chat_id: replyTarget.chatId, bot_id: replyTarget.botId }` → use `replyTarget.replyChannel` (or reconstruct from the subscriber's stored `reply_channel` field).
  - `deliverMonitorCompletionResult()` (~L560): same pattern → use subscriber's original `reply_channel`.
  - `flushPushAccumulator()` progress push (~L719): same → use subscriber's `reply_channel`.
  - push/subscribe result loop (~L949): same → use subscriber's `reply_channel`.
- **Strategy**: Each of these sites already has a `replyTarget` or `subscriber` object. Thread subscribers must carry their original `reply_channel` object (not just `chatId`/`botId`). Audit `parseReplyTarget()` and the subscriber data structures — if they currently only store `chatId`/`botId`, extend them to store the full `ReplyChannel` so it can be passed through to `resultSender.sendResult()`.
- **Key constraint**: Telegram subscribers must still produce Telegram `ReplyChannel` objects — this change must be behavior-neutral for all existing Telegram sessions.
- **Acceptance**: A grep for `channel: 'telegram'` in `server.ts` returns 0 hardcoded channel construction objects (string literals in log messages are fine).
- **Ref**: PRD §3.1 (server.ts rows)

**R-04.2 — Add auto-approve intercept in flushPushAccumulator()**
- After the `classification.kind === 'action_required'` detection (already present at ~L907), add:
  ```typescript
  const instance = this.registry.get(threadId);
  if (instance?.auto_approve) {
    await this.instanceManager.sendTerminalInput(threadId, 'all');
    return; // skip push to subscribers
  }
  ```
- Placement: insert BEFORE the duplicate-content check and BEFORE subscriber push loop.
- **Key constraint**: Only fire when `classification.kind === 'action_required'`. Normal output must not be intercepted.
- **Acceptance**: When `auto_approve=true` and agent emits an approval prompt, `sendTerminalInput` is called and no Telegram/web push occurs.
- **Ref**: PRD §4.2 Method B

**R-04.3 — Add set_auto_approve intent handler in server.ts**
- In the hub message dispatch switch (wherever intents are routed), add a case for `'set_auto_approve'`:
  - Parse `value: boolean` from `message.payload.content` (e.g. `JSON.parse(content)` or string `'true'/'false'`).
  - Call `this.registry.setAutoApprove(message.thread_id, value)`.
  - Return appropriate `HubResult`.
- **Acceptance**: Sending a hub message with `intent: 'set_auto_approve'` and `payload.content: 'true'` flips the instance's `auto_approve` to `true`.
- **Ref**: PRD §4.5

#### AI Auto-Tests
```bash
cd /Users/yzliu/work/Meridian
npm run typecheck
npm test
# Verify no hardcoded channel construction remains
grep -n "channel: ['\"]telegram['\"]" src/hub/server.ts | grep -v "log\." | grep -v "//"
# Expected: empty output (all hardcodes removed)
```

#### Human Acceptance Criteria
- Zero hardcoded `{ channel: 'telegram', ... }` object literals in `server.ts` (log field strings allowed).
- Auto-approve: send a message to an agent with `auto_approve=true`, verify approval prompt is auto-sent and no Telegram notification fires.
- `set_auto_approve` intent updates the registry and returns success result.
- All unit and integration tests pass.

---

### R-05 — router.ts handleDetail + isWebChannel Refactor

- **Runtime**: Node.js / TypeScript
- **Delta Type**: REWORK
- **Phase**: 1
- **Priority**: P1
- **Depends on**: R-02

#### Sub-tasks

**R-05.1 — Remove handleDetail() Telegram channel restriction**
- In `handleDetail()` (~L703): delete the guard:
  ```typescript
  if (message.reply_channel.channel !== 'telegram') {
    return this.buildResult(message, 'error', ..., 'detail is only available for Telegram reply channels.');
  }
  ```
- Detail should now be available for all channels.
- **Key constraint**: All other detail logic remains unchanged.
- **Acceptance**: A `handleDetail()` call with `reply_channel.channel = 'socket'` does not return an error result.
- **Ref**: PRD §3.1 (router.ts L704 row)

**R-05.2 — Eliminate isWebChannel branch in push handler**
- In `handlePush()` (~L1335), the `const isWebChannel = ...` branch routes web channel to `handlePushFromWeb()`.
- Refactor: move the web-specific push subscription logic into `WebChannelAdapter` (created in N-02). 
- In Phase 1: the `isWebChannel` branch can remain as a call to `handlePushFromWeb()` but the branch must be refactored to use the channel adapter pattern rather than a direct string comparison.
- If N-02 is not yet complete, this sub-task should only remove the `isWebChannel` string comparison and replace it with `adapter.canHandle(message.reply_channel)` lookup — with the web adapter providing the `handlePushFromWeb` logic.
- **Key constraint**: Web push functionality must not regress. Existing web push tests must pass.
- **Acceptance**: Grep for `isWebChannel` in `router.ts` returns 0 results.
- **Ref**: PRD §3.1 (router.ts L1335 row)

#### AI Auto-Tests
```bash
cd /Users/yzliu/work/Meridian
npm run typecheck
npm test
grep -n "isWebChannel\|only available for Telegram" src/hub/router.ts
# Expected: empty output
```

#### Human Acceptance Criteria
- `handleDetail()` no longer rejects non-Telegram channels.
- `isWebChannel` string comparison is gone from `router.ts`.
- All existing router unit tests pass.

---

### R-06 — instance-manager.ts spawn autoApprove + CLI flags wiring

- **Runtime**: Node.js / TypeScript
- **Delta Type**: REWORK
- **Phase**: 1
- **Priority**: P1
- **Depends on**: R-01, R-03

#### Sub-tasks

**R-06.1 — Add autoApprove parameter to spawn() and spawnWithRetry()**
- Add `autoApprove?: boolean` parameter to `spawn()`, `spawnWithRetry()`, and `spawnInternal()`.
- In `spawnInternal()`, after registering the instance, if `autoApprove === true`, call `this.registry.setAutoApprove(threadId, true)`.
- **Acceptance**: `spawn('claude', 'pane_bridge', undefined, undefined, true)` results in `registry.get(threadId)?.auto_approve === true`.
- **Ref**: PRD §4.3, §4.5

**R-06.2 — Pass autoApprove through hub server spawn handler**
- In `server.ts` spawn intent handler, extract `auto_approve` from `message.payload` (add to `HubPayloadSchema` in `types.ts` as `auto_approve?: boolean`).
- Pass `autoApprove` to `instanceManager.spawn(...)`.
- **Acceptance**: `POST /api/spawn { auto_approve: true }` → agent instance has `auto_approve: true`.
- **Ref**: PRD §4.5

#### AI Auto-Tests
```bash
cd /Users/yzliu/work/Meridian
npm run typecheck
npm test -- --grep "instance"
```

#### Human Acceptance Criteria
- `spawn()` accepts `autoApprove` parameter.
- Auto-approve flag persists in registry after spawn.
- Hub payload schema accepts `auto_approve` field.

---

### R-07 — monitor/index.ts channel fix

- **Runtime**: Node.js / TypeScript
- **Delta Type**: REWORK
- **Phase**: 1
- **Priority**: P1
- **Depends on**: R-01

#### Sub-tasks

**R-07.1 — Fix buildListRequestMessage() hardcoded telegram channel**
- In `monitor/index.ts`, `buildListRequestMessage()` at L39:
  - Change `reply_channel: { channel: 'telegram', chat_id: 'monitor' }` 
  - To: `reply_channel: { channel: 'socket', chat_id: 'monitor', socket_path: config.HUB_SOCKET_PATH }`
- Rationale: This is an internal IPC call with `suppress_reply: true`. It should use the socket channel, not the Telegram channel.
- **Key constraint**: `suppress_reply: true` must remain. This message is not delivered to any user.
- **Acceptance**: `buildListRequestMessage()` returns `reply_channel.channel === 'socket'`.
- **Ref**: PRD §3.1 (monitor/index.ts L39 row)

#### AI Auto-Tests
```bash
cd /Users/yzliu/work/Meridian
npm run typecheck
grep -n "channel: ['\"]telegram['\"]" src/monitor/index.ts
# Expected: empty output
```

#### Human Acceptance Criteria
- `monitor/index.ts` has no hardcoded `channel: 'telegram'`.
- Monitor service starts and syncs instances without errors.

---

### N-02 — interface/adapters/ TelegramAdapter + WebAdapter

- **Runtime**: Node.js / TypeScript
- **Delta Type**: NEW (+ code migration)
- **Phase**: 1
- **Priority**: P1
- **Depends on**: R-02, R-04, R-05

#### Sub-tasks

**N-02.1 — Create src/interface/adapters/ directory and telegram-adapter.ts**
- Create `src/interface/adapters/telegram-adapter.ts`.
- Migrate all Telegram send logic from `result-sender.ts` (the `TelegramChannelAdapterBridge` created in R-02.2, plus any methods it calls) into `TelegramChannelAdapter implements ChannelAdapter`.
- The class must implement `canHandle(rc)` returning `rc.channel === 'telegram'` and `send(result, rc)` containing the full Telegram message composition and dispatch logic.
- **Key constraint**: This is a code MOVE, not a rewrite. Preserve all existing Telegram logic character-for-character. The goal is structural relocation only.
- **Acceptance**: All Telegram-related tests pass after migration. `ResultSender` delegates to `TelegramChannelAdapter` with zero behavior change.
- **Ref**: PRD §2.2, §3.2

**N-02.2 — Create src/interface/adapters/web-adapter.ts**
- Create `src/interface/adapters/web-adapter.ts`.
- Migrate web channel push logic (currently in `router.ts` `handlePushFromWeb()` and any web-specific send logic from `server.ts`) into `WebChannelAdapter implements ChannelAdapter`.
- **Key constraint**: Web SSE delivery must not regress. Existing web tests must pass.
- **Acceptance**: `WebChannelAdapter.canHandle({ channel: 'web', ... })` returns true. Web push tests pass.
- **Ref**: PRD §2.2, §3.2

**N-02.3 — Update ResultSender wiring to use real adapters**
- Remove the `TelegramChannelAdapterBridge` scaffolding from `result-sender.ts` (added in R-02.2).
- Wire `TelegramChannelAdapter` and `WebChannelAdapter` into `ResultSender` via `hub/index.ts`.
- Order: `[socketAdapter, telegramAdapter, webAdapter]`.
- **Acceptance**: `ResultSender` file no longer contains Telegram-specific business logic.
- **Ref**: PRD §2.3

#### AI Auto-Tests
```bash
cd /Users/yzliu/work/Meridian
npm run typecheck
npm test
ls src/interface/adapters/
# Expected: telegram-adapter.ts  web-adapter.ts
grep -n "TelegramChannelAdapterBridge\|resolveBotToken\|composeSummaryTelegram" src/hub/result-sender.ts
# Expected: empty output (all moved out)
```

#### Human Acceptance Criteria
- `src/interface/adapters/telegram-adapter.ts` and `web-adapter.ts` exist.
- `result-sender.ts` contains only the routing shell (no Telegram or web business logic).
- All Telegram and web integration tests pass with zero regressions.

---

### R-08 — interface/index.ts decouple send logic

- **Runtime**: Node.js / TypeScript
- **Delta Type**: REWORK
- **Phase**: 1
- **Priority**: P1
- **Depends on**: N-02

#### Sub-tasks

**R-08.1 — Decouple interface/index.ts from send responsibility**
- `interface/index.ts` currently calls `resultSender.sendResult(...)` at multiple points and hardcodes `reply_channel: { channel: 'telegram', ... }` in `buildRunHubMessage()` and `buildActionHubMessage()`.
- These hardcodes are CORRECT (this IS the Telegram bot entry, so messages are correctly Telegram-channeled) but should be extracted into a named constant or builder function for clarity.
- Create a helper `buildTelegramReplyChannel(params)` inside `interface/index.ts` and replace all inline `{ channel: 'telegram', ... }` constructions with calls to this helper.
- **Key constraint**: No behavior change. This is a refactor-for-clarity.
- **Ref**: PRD §3.1 (interface/index.ts rows) — note PRD says "保留 but 提取 into TelegramInterface class"

**R-08.2 — Remove send logic from interface/index.ts (moved to TelegramAdapter)**
- Any direct calls to `resultSender.sendResult()` in `interface/index.ts` should delegate to `TelegramChannelAdapter`.
- `interface/index.ts` should only handle Telegram Bot inbound event reception; outbound sending is handled by the adapter.
- **Acceptance**: `interface/index.ts` has no direct import of `ResultSender`.
- **Ref**: PRD §3.1, §3.2

#### AI Auto-Tests
```bash
cd /Users/yzliu/work/Meridian
npm run typecheck
npm test
grep -n "import.*ResultSender\|resultSender.sendResult" src/interface/index.ts
# Expected: empty output
```

#### Human Acceptance Criteria
- `interface/index.ts` only handles inbound Telegram events.
- Outbound send responsibility fully delegated to `TelegramChannelAdapter`.
- Full test suite passes.

---

### R-09 — interface/slash-handler.ts /autoapprove command

- **Runtime**: Node.js / TypeScript
- **Delta Type**: REWORK
- **Phase**: 1
- **Priority**: P1
- **Depends on**: R-03

#### Sub-tasks

**R-09.1 — Add /autoapprove to ParsedSlashCommand and parseSlashCommand()**
- Add `autoApproveValue: boolean | null` and `autoApproveQuery: boolean` to `ParsedSlashCommand` interface.
- In the command parser switch, add case for `/autoapprove`:
  - `on` → `intent: 'set_auto_approve'`, `autoApproveValue: true`
  - `off` → `intent: 'set_auto_approve'`, `autoApproveValue: false`
  - `status` → `intent: 'status'`, `autoApproveQuery: true`
  - Default thread: active thread (same resolution as `/push`).
- Add `/autoapprove on|off|status [thread=<id>]` to `HELP_MESSAGE`.
- **Ref**: PRD §4.4

**R-09.2 — Wire autoapprove into message construction in interface/index.ts**
- Where `ParsedSlashCommand` is converted to `HubMessage` (in `interface/index.ts`), handle `set_auto_approve` intent:
  - Set `payload.content` to `'true'` or `'false'` based on `autoApproveValue`.
  - Route to hub with `intent: 'set_auto_approve'`.
- **Acceptance**: `/autoapprove on` → hub receives `intent: 'set_auto_approve'` with `content: 'true'`.
- **Ref**: PRD §4.4

#### AI Auto-Tests
```bash
cd /Users/yzliu/work/Meridian
npm run typecheck
npm test -- --grep "slash"
node -e "
const { parseSlashCommand } = require('./src/interface/slash-handler');
const result = parseSlashCommand('/autoapprove on', 'bridge');
console.assert(result.intent === 'set_auto_approve');
console.log('R-09 slash test passed');
"
```

#### Human Acceptance Criteria
- `/autoapprove on` parses to `intent: 'set_auto_approve'`.
- `/autoapprove off` parses to `intent: 'set_auto_approve'` with false value.
- `/autoapprove status` parses to a status query intent.
- `/help` response includes autoapprove command documentation.
- All slash-handler unit tests pass.

---

### R-10 — web/server.ts spawn API + index.html

- **Runtime**: Node.js / TypeScript + HTML/JS
- **Delta Type**: REWORK
- **Phase**: 1
- **Priority**: P1
- **Depends on**: R-06

#### Sub-tasks

**R-10.1 — Extend spawnRequestBodySchema with auto_approve**
- In `src/web/server.ts`, update `spawnRequestBodySchema`:
  ```typescript
  const spawnRequestBodySchema = z.object({
    type: z.enum(['claude', 'codex', 'gemini', 'cursor']).default('codex'),
    mode: z.enum(['bridge', 'pane_bridge']).default('pane_bridge'),
    auto_approve: z.boolean().default(false)   // NEW
  });
  ```
- In `handleSpawnRequest()`, pass `body.auto_approve` through the hub message payload.
- **Ref**: PRD §4.5

**R-10.2 — Add auto_approve toggle to index.html spawn UI**
- In `src/web/public/index.html`, add a checkbox or toggle labeled "Auto-approve agent prompts" to the spawn form/section.
- Default: unchecked (false).
- Wire to `auto_approve` field in the spawn POST body.
- **Acceptance**: Spawn form includes auto_approve toggle; toggling it and spawning passes the value to the hub.
- **Ref**: PRD §5 (index.html row)

#### AI Auto-Tests
```bash
cd /Users/yzliu/work/Meridian
npm run typecheck
npm test -- --grep "web"
grep -n "auto_approve" src/web/server.ts src/web/public/index.html
# Expected: at least 2 matches each
```

#### Human Acceptance Criteria
- `POST /api/spawn` with `{ "auto_approve": true }` is accepted without validation error.
- Web UI spawn form includes the auto-approve toggle.
- Existing web server tests pass.

---

### R-11 — agents/claude.ts + agents/codex.ts CLI flags

- **Runtime**: Node.js / TypeScript
- **Delta Type**: REWORK
- **Phase**: 1
- **Priority**: P1
- **Depends on**: R-06

#### Sub-tasks

**R-11.1 — Add --dangerously-skip-permissions to buildClaudeCliArgs()**
- Modify `buildClaudeCliArgs()` in `src/agents/claude.ts` to accept `autoApprove?: boolean` parameter.
- If `autoApprove === true`, append `'--dangerously-skip-permissions'` to the args array.
- Update `buildClaudeSpawnArgs()` to thread `autoApprove` through.
- **Ref**: PRD §4.2 Method A

**R-11.2 — Add --approval-policy=auto-approve to buildCodexSpawnArgs()**
- Modify `buildCodexSpawnArgs()` in `src/agents/codex.ts` to accept `autoApprove?: boolean`.
- If `autoApprove === true`, append `'--approval-policy=auto-approve'` to the codex args.
- **Ref**: PRD §4.2 Method A

**R-11.3 — Wire autoApprove through instance-manager buildSpawnArgs()**
- In `instance-manager.ts`, `buildSpawnArgs()` must accept and forward `autoApprove` to the respective agent builder functions.
- **Acceptance**: When `autoApprove=true`, spawning claude adds `--dangerously-skip-permissions`; codex adds `--approval-policy=auto-approve`.
- **Ref**: PRD §4.2, §5 (agents rows)

#### AI Auto-Tests
```bash
cd /Users/yzliu/work/Meridian
npm run typecheck
node -e "
const { buildClaudeCliArgs } = require('./src/agents/claude');
const args = buildClaudeCliArgs(undefined, undefined, true);
console.assert(args.includes('--dangerously-skip-permissions'), 'Claude auto-approve flag missing');
const argsNoApprove = buildClaudeCliArgs();
console.assert(!argsNoApprove.includes('--dangerously-skip-permissions'), 'Flag should not appear by default');
console.log('R-11 claude test passed');
"
node -e "
const { buildCodexSpawnArgs } = require('./src/agents/codex');
const args = buildCodexSpawnArgs('bridge', null, '--endpoint=/tmp/x.sock', undefined, true);
console.assert(args.join(' ').includes('--approval-policy=auto-approve'), 'Codex auto-approve flag missing');
console.log('R-11 codex test passed');
"
```

#### Human Acceptance Criteria
- `buildClaudeCliArgs(undefined, undefined, true)` includes `--dangerously-skip-permissions`.
- `buildCodexSpawnArgs(..., true)` includes `--approval-policy=auto-approve`.
- Neither flag appears when `autoApprove` is false or undefined.
- All agent unit tests pass.

---

### D-01 — Dead Code Sweep + Test Updates

- **Runtime**: Node.js / TypeScript
- **Delta Type**: DELETE + REWORK
- **Phase**: 2
- **Priority**: P2
- **Depends on**: R-01, N-01, R-02, R-03, R-04, R-05, R-06, R-07, N-02, R-08, R-09, R-10, R-11

#### Sub-tasks

**D-01.1 — Remove TelegramChannelAdapterBridge scaffolding**
- Delete the temporary `TelegramChannelAdapterBridge` class from `result-sender.ts` (added as scaffolding in R-02.2, replaced by N-02).
- **Acceptance**: `result-sender.ts` contains no inline adapter implementations.

**D-01.2 — Update unit tests for new interface contracts**
- Update any tests that directly construct `ResultSender` with old signature (no adapters array).
- Add tests for: `SocketChannelAdapter`, `/autoapprove` slash command, `setAutoApprove()` registry method.
- **Acceptance**: `npm test` passes with 0 failures.

**D-01.3 — Full typecheck and lint pass**
- Run `npm run typecheck` and `npm run lint` — zero errors, zero warnings.
- Run `npm run format` — no diffs.
- **Acceptance**: All three commands exit 0.

**D-01.4 — Run integration tests**
- Run `npm run test:integration` — all integration tests pass.
- **Acceptance**: All int-0x tests pass.

#### AI Auto-Tests
```bash
cd /Users/yzliu/work/Meridian
npm run typecheck && npm run lint && npm test && npm run test:integration
```

#### Human Acceptance Criteria
- All 8 acceptance criteria from PRD §7 are met (see list below).
- Zero TypeScript errors, zero lint warnings.
- All unit and integration tests pass.
- No dead Telegram-hardcoded code remains in core hub files.

---

### DELTA-CHECK — Delta Check & Corrective Dispatch

- **Runtime**: Local (git + bash)
- **Delta Type**: REVIEW
- **Phase**: Terminal
- **Priority**: P0
- **Depends on**: All implementation Workers `✅`

#### Sub-tasks

**DELTA-CHECK.1 — Load acceptance criteria**
- Pull the acceptance criteria and AI Auto-Tests for `R-01` through `D-01` from this TaskSpec.
- Build a single verification checklist before reviewing the diff so no completed Worker is skipped.
- **Acceptance**: Every implementation Worker has a recorded checklist entry.

**DELTA-CHECK.2 — Diff actual output against criteria**
- Review the full implementation diff against the base branch using `git diff origin/main...HEAD`.
- Map changed files and runtime behavior back to the owning Worker definitions.
- For each Worker, record one verdict only: `✅ Aligned`, `⚠️ Drift`, or `❌ Missing`.
- **Acceptance**: Every implementation Worker has a verdict tied to concrete evidence in the diff or test output.

**DELTA-CHECK.3 — Produce Delta Check Report**
- Write the report to `/Users/yzliu/work/Meridian/docs/a2a_align/DEV/delta_check_report_v1_0_upgrade.md`.
- Required table columns: `Worker | Status | Findings | Action Required`.
- Every `⚠️` or `❌` finding must name the exact acceptance gap and the minimum corrective action.
- **Acceptance**: Report file exists at the confirmed path and no finding is left without an action.

**DELTA-CHECK.4 — Corrective dispatch (if findings exist)**
- If all Workers are `✅ Aligned`, mark the `DELTA-CHECK` row complete and stop.
- If findings remain and the fix scope is `<=5` workers with no new PM decisions, append corrective Workers directly to the current dispatch plan, assign `Delta Type: DRIFT` or `REWORK`, and write their reports to `/Users/yzliu/work/Meridian/docs/a2a_align/DEV/delta_reports/[WORKER_ID]_report.md`.
- If findings exceed `5` Workers or require a new PM decision, stop and escalate to PM for a standalone delta TaskSpec round.
- **Key constraint**: This is one pass only. Do not schedule a second Delta Check after corrective Workers finish.
- **Acceptance**: Either the report is fully `✅ Aligned`, or a bounded corrective dispatch has been appended and completed.

#### AI Auto-Tests
```bash
cd /Users/yzliu/work/Meridian
git diff --stat origin/main...HEAD
test -f /Users/yzliu/work/Meridian/docs/a2a_align/DEV/delta_check_report_v1_0_upgrade.md
grep -E "⚠️|❌" /Users/yzliu/work/Meridian/docs/a2a_align/DEV/delta_check_report_v1_0_upgrade.md && echo "ISSUES FOUND" || echo "ALL CLEAR"
```

#### Human Acceptance Criteria
- Delta Check Report exists and covers every implementation Worker from `R-01` through `D-01`.
- No unresolved `⚠️` or `❌` findings remain without an explicit next action.
- Any corrective Worker reports are saved under `/Users/yzliu/work/Meridian/docs/a2a_align/DEV/delta_reports/`.
- The `DELTA-CHECK` dispatch row is not marked `✅` until review findings are closed or escalated.

---

### PR-REVIEW — PR Alignment Review

- **Runtime**: Local (git + bash)
- **Delta Type**: REVIEW
- **Phase**: Terminal
- **Priority**: P0
- **Depends on**: DELTA-CHECK `✅`

#### Sub-tasks

**PR-REVIEW.1 — Collect review inputs**
- Load the full PR diff with `git diff origin/main...HEAD`.
- Load the main PRD, this TaskSpec, the Delta Check report, and any corrective Worker reports under `/Users/yzliu/work/Meridian/docs/a2a_align/DEV/delta_reports/`.
- **Acceptance**: No required review input is missing.

**PR-REVIEW.2 — Per-file verdict pass**
- Map every changed file to its owning Worker, including any corrective Worker appended during Delta Check.
- For each changed file, assign one verdict: `✅ Aligned`, `⚠️ Scope Drift`, `❌ Missing`, or `➕ Unplanned Addition`.
- **Acceptance**: Every changed file in the PR diff has a recorded verdict and notes.

**PR-REVIEW.3 — Scope drift summary**
- Write a 1–3 sentence summary of whether the branch remains safe to merge against the original PRD and TaskSpec.
- End with exactly one final verdict line: `MERGE APPROVED` or `MERGE BLOCKED — [specific reason]`.
- **Acceptance**: Summary exists and the merge recommendation is explicit.

**PR-REVIEW.4 — Write PR Review Report**
- Write the report to `/Users/yzliu/work/Meridian/docs/a2a_align/DEV/pr_review_report_v1_0_upgrade.md`.
- Required table columns: `File | Worker | Verdict | Notes`.
- **Acceptance**: Report file exists at the confirmed path and ends with the required merge verdict line.

#### AI Auto-Tests
```bash
cd /Users/yzliu/work/Meridian
git diff --name-only origin/main...HEAD
test -f /Users/yzliu/work/Meridian/docs/a2a_align/DEV/pr_review_report_v1_0_upgrade.md
grep -E "MERGE APPROVED|MERGE BLOCKED" /Users/yzliu/work/Meridian/docs/a2a_align/DEV/pr_review_report_v1_0_upgrade.md
```

#### Human Acceptance Criteria
- PR Review Report exists with a per-file verdict table.
- Scope drift summary is present and grounded in the PRD + TaskSpec.
- Final verdict is explicit: `MERGE APPROVED` or `MERGE BLOCKED`.
- Human performs the actual merge after reviewing the report; the agent never auto-merges.

---

## PRD §7 Acceptance Criteria Mapping

| # | PRD Criterion | Covered By |
|---|--------------|-----------|
| 1 | ChannelSchema includes 'socket', ReplyChannel has socket_path | R-01 |
| 2 | channel:'socket' reply_channel routes via Unix socket correctly | N-01, R-02 |
| 3 | channel:'telegram' behavior fully preserved (regression) | R-02, N-02, D-01 |
| 4 | handleDetail() responds to channel:'socket' without error | R-05 |
| 5 | server.ts monitor/push uses correct channel, no hardcoded telegram | R-04 |
| 6 | spawn with auto_approve=true → agent auto-passes all approval prompts | R-06, R-11 |
| 7 | /autoapprove on/off takes effect immediately; persists after restart | R-09, R-03, R-04 |
| 8 | All existing tests pass (no Telegram regression) | D-01 |

---

## Cross-Worker Integration Points

| Producer | Consumer | Contract |
|----------|----------|----------|
| R-01 (ChannelSchema) | All Workers | `Channel = 'telegram' \| 'web' \| 'socket'`; `ReplyChannel` has optional `socket_path` |
| N-01 (ChannelAdapter interface) | R-02, N-02 | `{ channel, canHandle(rc), send(result, rc) }` |
| N-01 (SocketChannelAdapter) | R-02, R-07 | `canHandle` returns true only for `channel=socket`; calls `sendIpcMessage(socket_path, result)` |
| R-02 (ResultSender router) | R-04, N-02, R-08 | `new ResultSender(adapters[]).sendResult(result, replyChannel)` — adapter lookup by `canHandle` |
| R-03 (setAutoApprove) | R-04, R-06, R-09 | `registry.setAutoApprove(threadId, bool): AgentInstance \| undefined` |
| R-06 (spawn autoApprove) | R-04 (server intent) | `HubPayload.auto_approve?: boolean` → passed to `instanceManager.spawn()` |
| N-02 (TelegramAdapter) | R-08 (interface/index.ts) | Adapter receives `HubResult + ReplyChannel{channel:'telegram'}` → full Telegram dispatch |
| N-02 (WebAdapter) | R-05 (router push) | Adapter receives push payload → SSE delivery |
| R-09 (/autoapprove parser) | R-08 (message builder) | `ParsedSlashCommand { intent:'set_auto_approve', autoApproveValue: boolean }` → hub message |
| DELTA-CHECK (findings report) | Corrective Workers, PR-REVIEW | `delta_check_report_v1_0_upgrade.md` records Worker verdicts and minimum corrective action |
| PR-REVIEW (merge gate) | Human reviewer | `pr_review_report_v1_0_upgrade.md` records per-file verdicts and final merge recommendation |
