# TaskSpec: meridian-roles v1.2

**Version**: v1.2 (Final Confirmed)
**Date**: 2026-03
**Input Documents**: meridian-roles PRD v1.2 · Meridian 平台升级 PRD v1.0
**Prerequisite**: Meridian platform upgrade (socket channel support) must be delivered first or in parallel

---

## 📁 File Directory Index

| Artifact | Full Absolute Path |
|----------|--------------------|
| **This document (TaskSpec)** | `/Users/yzliu/work/Meridian/Meridian-roles/docs/v1.0.0/DEV/TaskSpec/TaskSpec_meridian-roles_v1.2.md` |
| **Dispatch Plan** | `/Users/yzliu/work/Meridian/Meridian-roles/docs/v1.0.0/DEV/TaskSpec/dispatch_plan_meridian-roles.md` |
| **Dispatch Command** | `/Users/yzliu/work/Meridian/Meridian-roles/docs/v1.0.0/DEV/TaskSpec/agent_dispatch_command_meridian-roles.md` |
| **Dev history dir** | `/Users/yzliu/work/Meridian/Meridian-roles/docs/v1.0.0/DEV/dev_history/` |
| **Repo root (meridian-roles)** | `/Users/yzliu/work/Meridian/Meridian-roles/` |
| **GitHub remote (meridian-roles)** | `https://github.com/yzsnstotz/meridian-roles.git` |
| **Meridian repo root** | `/Users/yzliu/work/Meridian/` |
| **Meridian GitHub remote** | `https://github.com/yzsnstotz/Meridian.git` |
| **PRD: meridian-roles v1.2** | `/Users/yzliu/work/Meridian/Meridian-roles/docs/v1.0.0/PRD/PRD_meridian-roles_v1.2.docx` |
| **PRD: Meridian 平台升级 v1.0** | `/Users/yzliu/work/Meridian/docs/a2a_align/PRD/PRD_Meridian_Upgrade_v1.0.docx` |
| **Env file** | `/Users/yzliu/work/Meridian/Meridian-roles/.env.local` |
| **Git branch** | `meridian-roles-v1.2` |
| **Hub socket** | `/tmp/hub-socks/hub-core.sock` |
| **Roles socket** | `/tmp/meridian-roles.sock` |
| **State file** | `/var/lib/meridian-roles/state.json` |
| **GUI port** | `7701` |

> ⚠️ **Agent instruction**: Before ANY file operation, confirm all `[ASSUMPTION]` rows above and replace placeholders with real absolute paths. Do NOT use relative paths anywhere.
> All `src/...` paths in this document are relative to `/Users/yzliu/work/Meridian/Meridian-roles`.

---

## 冲突処理規則

> PRD document > This TaskSpec > Previous implementation. Any discrepancy must defer to meridian-roles PRD v1.2 and Meridian 平台升级 PRD v1.0. Requirements not defined in any PRD: developer must STOP and file an issue — do not proceed until PM provides a clear definition.

---

## PM Blocker Resolutions

| # | Issue | Resolution |
|---|-------|------------|
| 1 | reply_channel socket format uncertainty | **RESOLVED**: Meridian `SocketChannelAdapter` uses `sendIpcMessage()` → `socket.end(JSON.stringify(payload))`. A2AServer reads full data then `JSON.parse`. Zero ambiguity. |
| 2 | Meridian core change scope | **RESOLVED**: Meridian core = zero changes. Socket channel adapter is a platform capability (Meridian PRD v1.0). Only change in Meridian: ~15 lines in `index.html` (T09). |
| 3 | ReplyChannelSchema alignment | **RESOLVED**: Must include `channel:'socket'` + `socket_path` fields — copied from Meridian upgraded `types.ts`. Human review required at T01. |

---

## I. Project Overview

**Goal**: Build `meridian-roles` as a standalone role-layer service. Phase 1 delivers: BaseRole framework + Dispatcher role (explicit + inferred modes) + prompt hot-reload + independent GUI. Communicates with Meridian exclusively via A2A protocol over socket channel reply_channel — fully decoupled.

**Core Constraints**:
- TypeScript; native `net` module; `zod` schema validation
- Meridian core: zero changes
- All result delivery via reply_channel socket callback — no polling, no SSE
- Every env var loaded from confirmed `.env.local`; no hard-coded secrets

**Scope**:
- ✅ BaseRole framework, RoleRunner, Dispatcher (explicit + inferred), prompt hot-reload, GUI, A2A comms layer, Meridian index.html link
- ❌ Other role types (Reviewer, PM, Knowledge), multi-instance, direct role-to-role comms

---

## II. Dispatch Overview

### Model and reasoning-effort row contract

Dispatch rows now carry model-effort intent at plan runtime:

- `Model` accepts legacy codes and explicit `CODE::effort` values (for example `CODEX::high`).
- `Reasoning Effort` is a separate optional column with values `low|medium|high|xhigh`.
- If `Reasoning Effort` is absent, dispatcher resolution uses legend effort and fallback legacy defaults:
  - `CODEX` → `medium`
  - `CODEX-HIGH` → `high`
  - `CODEX-XHIGH` → `xhigh`
- Inline row effort (either `code::effort` or `Reasoning Effort`) wins over legend defaults and inline `dispatch-start` overrides.
- Worker-level overrides set with `dispatch-status` patching are persisted to lifecycle state and are honored on `resume_worker`/continue.

```
[PHASE 0 — Serial]
N-01 (scaffold + core types)
  |
[PHASE 1 — Parallel, 3 workers]
N-02 (A2A comms layer)    N-03 (BaseRole + RoleRunner)    N-04 (state persistence)
  |                              |                                |
[PHASE 2 — Serial]
N-05 (Dispatcher state machine) ← depends_on: N-02, N-03, N-04
  |
[PHASE 3 — Parallel, 2 workers]
N-06 (inferred dispatch mode)    N-07 (prompt hot-reload API)
  |                                    |
[PHASE 4 — Parallel, 2 workers]
N-08 (Web GUI)    N-09 (Meridian index.html link)
  |                    |
[PHASE 5 — Serial]
N-10 (E2E integration tests + docs)
  |
[PHASE Ω — Terminal Verification]
DELTA-CHECK (spec alignment audit + corrective dispatch)
  |
PR-REVIEW (full diff review + merge recommendation)
```

| Metric | Value |
|--------|-------|
| Max parallel workers | 3 |
| Total tasks | 12 |
| Critical path | N-01 → N-02 → N-05 → N-06 → N-08 → N-10 → DELTA-CHECK → PR-REVIEW |
| Phase count | 5 implementation phases + Ω terminal verification |

---

## III. Worker Definitions

---

### N-01 — Project Scaffold + Core Type Definitions

- **Runtime**: Node.js (local)
- **Delta Type**: NEW
- **Phase**: 0
- **Priority**: P0
- **Depends on**: —

#### Sub-tasks

**N-01.1 — Initialize repo and toolchain**
- Init TypeScript project: `package.json`, `tsconfig.json`, `eslint`, `vitest`
- Scripts: `build`, `start`, `test`, `test:e2e`
- Dev dependency: `tsx` for local dev; `zod` for runtime schema validation
- **Key constraint**: Node.js 20+; same tsconfig strictness as Meridian
- **Acceptance**: `npm run build` exits 0 with zero errors
- **Ref**: PRD §2.1 directory structure

**N-01.2 — config.ts: all runtime constants**
- Must export exactly:
```typescript
export const HUB_SOCKET_PATH   = process.env.HUB_SOCKET_PATH   ?? '/tmp/hub-socks/hub-core.sock';
export const ROLES_SOCKET_PATH = process.env.ROLES_SOCKET_PATH ?? '/tmp/meridian-roles.sock';
export const GUI_PORT          = Number(process.env.GUI_PORT    ?? 7701);
export const STATE_FILE_PATH   = process.env.STATE_FILE_PATH   ?? '/var/lib/meridian-roles/state.json';
export const ROLES_SERVICE_ID  = 'service:meridian-roles';
```
- **Key constraint**: All values must be overridable via env vars — no hard-coded production paths
- **Acceptance**: Each constant readable from `dist/config.js`; env override verified
- **Ref**: PRD §1.1

**N-01.3 — types.ts: all shared types with zod schemas**
- `RoleType`: `z.enum(["dispatcher"])`
- `DispatchTask` schema — must include `result_trace_id?: string` field
- `DispatcherConfig` schema
- `HubMessage` / `HubResult` / `ReplyChannelSchema`: copied from Meridian upgraded types.ts
- **Key constraint**: `ReplyChannelSchema` must accept `{ channel: 'socket', chat_id: string, socket_path: string }` — this is the critical alignment point with Meridian's SocketChannelAdapter
- **Acceptance**: `ReplyChannelSchema.parse({ channel:'socket', chat_id:'service:meridian-roles', socket_path:'/tmp/meridian-roles.sock' })` passes without throwing
- **Ref**: PRD §2.2, §3.2

**N-01.4 — .env.example and directory scaffolding**
- `.env.example` with all var names documented
- Create `src/` subdirs: `a2a/`, `roles/definitions/`, `server/`, `web/public/`
- **Acceptance**: All dirs exist; `.env.example` contains all vars from config.ts
- **Ref**: PRD §2.1

#### AI Auto-Tests
```bash
cd /Users/yzliu/work/Meridian/Meridian-roles
npm install && npm run build
node -e "
const t = require('./dist/types');
t.ReplyChannelSchema.parse({
  channel: 'socket',
  chat_id: 'service:meridian-roles',
  socket_path: '/tmp/meridian-roles.sock'
});
const c = require('./dist/config');
console.assert(c.ROLES_SERVICE_ID === 'service:meridian-roles', 'ROLES_SERVICE_ID mismatch');
console.log('N-01 OK');
"
```

#### Human Acceptance Criteria
- [ ] `ReplyChannelSchema` fields match Meridian upgraded `types.ts` exactly (manual diff review)
- [ ] `npm run build` clean output, zero TS errors
- [ ] `.env.example` covers every var referenced in config.ts

> 📁 All deliverable paths are relative to `/Users/yzliu/work/Meridian/Meridian-roles` — see File Directory Index.

**Deliverables**: `src/types.ts`, `src/config.ts`, `package.json`, `tsconfig.json`, `.env.example`

---

### N-02 — A2A Communication Layer

- **Runtime**: Node.js (local)
- **Delta Type**: NEW
- **Phase**: 1
- **Priority**: P0
- **Depends on**: N-01

#### Sub-tasks

**N-02.1 — A2AClient: outbound task sender (roles → hub)**
- Connect to `HUB_SOCKET_PATH` via `net.createConnection`
- `send(msg: Partial<HubMessage>)`: write JSON + `socket.end()` — fire-and-forget
- Startup: send `register_service` Agent Card, wait for success response before resolving
- Reconnect: exponential backoff, max 30s interval
- Agent Card:
```json
{
  "name": "meridian-roles",
  "url": "/tmp/meridian-roles.sock",
  "skills": [{ "id": "role-coordination", "intents": [] }]
}
```
- **Key constraint**: `send()` must never throw to callers — catch internally, log, re-queue if needed
- **Acceptance**: `register_service` visible in Meridian logs after startup
- **Ref**: PRD §1.2, §3.2

**N-02.2 — A2AServer: inbound result receiver (hub → roles via socket callback)**
- **[CONFIRMED — zero ambiguity]** Meridian `SocketChannelAdapter` writes via `sendIpcMessage()`: `socket.end(JSON.stringify(payload))`. Full payload arrives before `end` event.
- Implementation:
```typescript
server = net.createServer(socket => {
  let raw = '';
  socket.setEncoding('utf8');
  socket.on('data', chunk => raw += chunk);
  socket.on('end', () => {
    const result = HubResultSchema.parse(JSON.parse(raw));
    this.onResult(result); // → RoleRunner.dispatch()
  });
});
server.listen(ROLES_SOCKET_PATH);
```
- `onResult` callback: passed in at construction time by RoleRunner
- **Key constraint**: Socket file must be unlinked on startup if stale; handle `EADDRINUSE`
- **Acceptance**: Receiving a mock `sendIpcMessage`-format write triggers `onResult` with correct parsed `HubResult`
- **Ref**: PRD §1.2

#### AI Auto-Tests
```bash
cd /Users/yzliu/work/Meridian/Meridian-roles
npm test -- --testPathPattern=a2a

# Integration smoke test: simulate Meridian sendIpcMessage format
node -e "
const net = require('net');
const path = '/tmp/test-roles-n02.sock';
const { A2AServer } = require('./dist/a2a/server');
const srv = new A2AServer(result => {
  console.assert(result.trace_id === 'test-1234', 'trace_id mismatch');
  console.log('N-02 socket receive OK');
  process.exit(0);
});
srv.listen(path).then(() => {
  const c = net.createConnection(path, () => {
    c.end(JSON.stringify({
      trace_id: 'test-1234', thread_id: 'claude_01',
      source: 'claude', status: 'success', content: 'done',
      attachments: [], timestamp: new Date().toISOString()
    }));
  });
});
"
```

#### Human Acceptance Criteria
- [ ] Real integration: Meridian (with socket channel support running) receives a HubMessage with `reply_channel.channel='socket'` and writes result back — meridian-roles log shows HubResult arrived with matching `trace_id`
- [ ] Reconnect: kill hub socket, restart — client reconnects automatically within 30s

> 📁 All deliverable paths relative to `/Users/yzliu/work/Meridian/Meridian-roles` — see File Directory Index.

**Deliverables**: `src/a2a/client.ts`, `src/a2a/server.ts`, `src/a2a/index.ts`, `src/a2a/__tests__/a2a.test.ts`

---

### N-03 — BaseRole Interface + RoleRunner Framework

- **Runtime**: Node.js (local)
- **Delta Type**: NEW
- **Phase**: 1
- **Priority**: P0
- **Depends on**: N-01

#### Sub-tasks

**N-03.1 — BaseRole interface and RoleContext**
- Implement exactly as PRD §2.2 specifies:
```typescript
interface BaseRole {
  readonly roleType: RoleType
  readonly threadId: string
  readonly config: unknown
  onActivate(ctx: RoleContext): Promise<void>
  onDeactivate(): Promise<void>
  onInboundResult(result: HubResult): Promise<void>
  onStatusChange(threadId: string, status: string): Promise<void>
}
interface RoleContext {
  sendToHub(msg: Partial<HubMessage>): Promise<void>
  listInstances(): AgentInstance[]
  log: Logger
}
```
- **Key constraint**: `onInboundResult` is the socket-callback hook — name must not change
- **Acceptance**: Interface compiles; a 5-line mock implementation satisfies it
- **Ref**: PRD §2.2

**N-03.2 — RoleRunner: lifecycle and dispatch**
- `activate(role: BaseRole)`: register role, call `onActivate(ctx)`
- `deactivate(threadId: string)`: call `onDeactivate()`, unregister
- `dispatch(result: HubResult)`: find role by `threadId` where `result.thread_id` matches → call `onInboundResult(result)`
- **Key constraint**: `dispatch()` with no matching threadId → silent ignore (log at debug level only)
- **Acceptance**: Unit test: register mock role, call dispatch with matching threadId → `onInboundResult` called; call with non-matching → no error
- **Ref**: PRD §2.2

**N-03.3 — RoleRegistry: role type registration**
- Map of `RoleType → constructor function`
- `register(type, factory)`, `create(type, threadId, config)`
- **Acceptance**: Registering 'dispatcher' type, then creating instance returns object satisfying BaseRole
- **Ref**: PRD §2.1

#### AI Auto-Tests
```bash
cd /Users/yzliu/work/Meridian/Meridian-roles
npm test -- --testPathPattern=role-runner
```

#### Human Acceptance Criteria
- [ ] A new mock role can be registered and activated in ≤5 lines of code
- [ ] `dispatch()` with unmatched `thread_id` produces no error and no side effects

> 📁 All deliverable paths relative to `/Users/yzliu/work/Meridian/Meridian-roles` — see File Directory Index.

**Deliverables**: `src/roles/base-role.ts`, `src/roles/role-runner.ts`, `src/roles/role-registry.ts`, `src/roles/__tests__/role-runner.test.ts`

---

### N-04 — State Persistence Layer

- **Runtime**: Node.js (local)
- **Delta Type**: NEW
- **Phase**: 1
- **Priority**: P0
- **Depends on**: N-01

#### Sub-tasks

**N-04.1 — StateStore: atomic JSON read/write**
- Persist to `STATE_FILE_PATH` (default: `/var/lib/meridian-roles/state.json`)
- Atomic write: write to `.tmp` file → `fs.rename()` (POSIX atomic)
- Auto-create directory if not exists on first write
- Schema: `{ roles: RoleState[], promptStore: PromptStore }`
- `save(state)`, `load(): State | null`
- **Key constraint**: Never partial-write — crash during write must not corrupt existing state
- **Acceptance**: Write 1000 byte state, kill process mid-write, re-read → last complete state intact
- **Ref**: PRD §2.1

#### AI Auto-Tests
```bash
cd /Users/yzliu/work/Meridian/Meridian-roles
npm test -- --testPathPattern=state-store
# Verify atomic round-trip
node -e "
const { StateStore } = require('./dist/state-store');
const s = new StateStore('/tmp/test-state-n04.json');
const data = { roles: [{ threadId: 'x', roleType: 'dispatcher' }], promptStore: {} };
s.save(data).then(() => s.load()).then(loaded => {
  console.assert(loaded.roles[0].threadId === 'x', 'round-trip failed');
  console.log('N-04 OK');
});
"
```

#### Human Acceptance Criteria
- [ ] Start Dispatcher, run partial DAG, restart `meridian-roles` process → role resumes from correct task state

> 📁 State file path: `/var/lib/meridian-roles/state.json` (default) — see File Directory Index.

**Deliverables**: `src/state-store.ts`, `src/state-store.test.ts`

---

### N-05 — Dispatcher Core State Machine (T0 / T1 / T2)

- **Runtime**: Node.js (local)
- **Delta Type**: NEW
- **Phase**: 2
- **Priority**: P0
- **Depends on**: N-02, N-03, N-04

#### Sub-tasks

**N-05.1 — T0: DAG validation and task dispatch**
- `onActivate()`: parse `config.tasks` into DAG, validate no circular deps (DFS cycle detection)
- For each task with `depends_on: []`: construct and send HubMessage:
```typescript
const traceId = randomUUID();
await ctx.sendToHub({
  trace_id: traceId,
  intent: 'run',
  target: resolvedThreadId,   // see N-05.3 for resolution priority
  payload: {
    content: task.instruction_template ?? task.instruction,
    attachments: []
  },
  reply_channel: {
    channel: 'socket',
    chat_id: ROLES_SERVICE_ID,    // 'service:meridian-roles'
    socket_path: ROLES_SOCKET_PATH,
  },
  suppress_reply: false,          // must be explicit — ensures Meridian sends result back
});
task.result_trace_id = traceId;
task.status = 'running';
```
- Persist state after each dispatch
- **Key constraint**: `suppress_reply` must always be `false` — never omit
- **Acceptance**: After `onActivate`, all `depends_on:[]` tasks have status `running` and `result_trace_id` set
- **Ref**: PRD §3.2, §3.3-T0

**N-05.2 — T1: result ingestion and DAG advancement**
- `onInboundResult(result: HubResult)`:
```typescript
const task = this.tasks.find(t => t.result_trace_id === result.trace_id);
if (!task) return; // not for this Dispatcher — silent ignore
task.status = ['success', 'partial'].includes(result.status) ? 'done' : 'failed';
task.result_summary = result.content.slice(0, 500);
await this._advanceDAG();
```
- `_advanceDAG()`: find all tasks where all `depends_on` entries are `done` and status is `pending` → call T0 for each
- Failed task propagation: if task is `failed`, mark all downstream tasks (transitively) as `failed` without sending
- **Key constraint**: `trace_id` match is the only routing key — never route by content or thread_id
- **Acceptance**: Unit test with 3-task DAG (A→B, A→C): simulate A result → B and C both dispatched in same tick
- **Ref**: PRD §3.3-T1

**N-05.3 — T2: completion summary and report**
- When all tasks are `done` or `failed`: generate Markdown summary report
- Report format: task list with status, result_summary (first 200 chars), execution order
- Send via `ctx.sendToHub()` to original user `reply_channel` (stored in `config.user_reply_channel`)
- **Key constraint**: T2 fires exactly once; guard against double-fire if multiple tasks complete simultaneously
- **Acceptance**: After all tasks complete, summary appears in original user's chat
- **Ref**: PRD §3.3-T2

**N-05.4 — Target resolution priority**
- `target_thread_id` (exact) > `target_model_id` > `target_agent_type` > auto-select idle instance
- Use `ctx.listInstances()` for auto-selection
- **Acceptance**: If `target_thread_id` is set, always routes to that exact thread regardless of other fields

#### AI Auto-Tests
```bash
cd /Users/yzliu/work/Meridian/Meridian-roles
# Unit tests
npm test -- --testPathPattern=dispatcher
# E2E DAG test
npm run test:e2e -- --filter=dispatcher-dag

# Critical: verify reply_channel shape
node -e "
// Verify a dispatched HubMessage has correct reply_channel
const { DispatcherRole } = require('./dist/roles/definitions/dispatcher');
// ... mock ctx and assert reply_channel fields
console.log('N-05 shape check done');
"
```

#### Human Acceptance Criteria
- [ ] **Real integration**: Meridian log shows `reply_channel.channel='socket'` on received HubMessage; after agent completes, meridian-roles log shows matching `trace_id` in result
- [ ] 3-task explicit DAG executes in correct dependency order; T2 summary is complete and accurate
- [ ] Circular dependency in config → `onActivate` throws, role enters error state, does not crash process

> 📁 All deliverable paths relative to `/Users/yzliu/work/Meridian/Meridian-roles` — see File Directory Index.

**Deliverables**: `src/roles/definitions/dispatcher.ts`, `src/roles/definitions/index.ts`, `src/roles/definitions/__tests__/dispatcher.test.ts`

---

### N-06 — Dispatcher Inferred Mode

- **Runtime**: Node.js (local)
- **Delta Type**: NEW
- **Phase**: 3
- **Priority**: P1
- **Depends on**: N-05

#### Sub-tasks

**N-06.1 — Inference request dispatch**
- Triggered when `config.tasks` is empty and `config.taskspec` is provided
- Send inference HubMessage (same format as normal task dispatch, same `reply_channel`)
- Record trace as `this.inferTraceId` separately from task `result_trace_id`
- Prompt must instruct agent to return JSON array of `DispatchTask[]` only — no prose
- **Key constraint**: `inferTraceId` check must happen first in `onInboundResult` before task matching
- **Acceptance**: With empty tasks and non-empty taskspec, `onActivate` sends exactly one HubMessage with inference prompt
- **Ref**: PRD §3.1

**N-06.2 — Inference result parsing and DAG entry**
- On inbound result matching `inferTraceId`:
  - Strip ` ```json ... ``` ` wrapper if present (regex: `/```json\s*([\s\S]*?)```/`)
  - `JSON.parse()` the content → validate as `DispatchTask[]` via zod
  - On success: populate `config.tasks`, clear `inferTraceId`, call `_advanceDAG()`
  - On failure: set Dispatcher status to `error`, log full raw content for debugging — do not crash
- **Acceptance**: Mock inference response with JSON-wrapped array → tasks populated, T0 begins
- **Ref**: PRD §3.1

#### AI Auto-Tests
```bash
cd /Users/yzliu/work/Meridian/Meridian-roles
npm test -- --testPathPattern=dispatcher-infer
```

#### Human Acceptance Criteria
- [ ] Given a real 5-task TaskSpec, the inferred Dispatch Plan has reasonable dependency ordering (human judgment)
- [ ] Malformed inference response (invalid JSON) → Dispatcher enters `error` state, process continues running

> 📁 All deliverable paths relative to `/Users/yzliu/work/Meridian/Meridian-roles` — see File Directory Index.

**Deliverables**: `src/roles/definitions/dispatcher.ts` (updated)

---

### N-07 — Prompt Hot-Reload API

- **Runtime**: Node.js (local)
- **Delta Type**: NEW
- **Phase**: 3
- **Priority**: P1
- **Depends on**: N-05

#### Sub-tasks

**N-07.1 — PromptStore: in-memory + persisted prompt management**
- `PromptStore` class: holds `system_prompt` and per-task `instruction_template` map
- Changes write through to StateStore immediately
- `getEffectiveInstruction(task)`: returns `instruction_template ?? task.instruction`
- **Acceptance**: Set template, call getEffectiveInstruction → returns template; delete template → returns base instruction

**N-07.2 — HTTP handlers for prompt CRUD**

| Method | Path | Body | Response |
|--------|------|------|----------|
| GET | `/api/role/:thread_id/prompts` | — | `{ system_prompt, tasks: [{task_id, instruction, instruction_template}] }` |
| PATCH | `/api/role/:thread_id/prompt` | `{ system_prompt }` | `{ ok: true }` |
| PATCH | `/api/role/:thread_id/task/:task_id/template` | `{ instruction_template }` | `{ ok: true }` |
| DELETE | `/api/role/:thread_id/task/:task_id/template` | — | `{ ok: true }` |

- Missing thread_id → 404; invalid body → 400
- **Key constraint**: Changes take effect for the *next* task dispatch — currently `running` tasks are unaffected
- **Acceptance**: PATCH then GET returns updated content; disk state reflects change

#### AI Auto-Tests
```bash
cd /Users/yzliu/work/Meridian/Meridian-roles
npm test -- --testPathPattern=prompt-store
# Live endpoint test
npm start &
sleep 2
curl -s -X PATCH http://localhost:7701/api/role/test_thread/prompt \
  -H 'Content-Type: application/json' \
  -d '{"system_prompt":"test prompt"}' | jq .ok
curl -s http://localhost:7701/api/role/test_thread/prompts | jq .system_prompt
kill %1
```

#### Human Acceptance Criteria
- [ ] Dispatcher running with a `pending` task: PATCH the template → that task dispatches with new content

> 📁 All deliverable paths relative to `/Users/yzliu/work/Meridian/Meridian-roles` — see File Directory Index.

**Deliverables**: `src/roles/prompt-store.ts`, `src/server/prompt-handlers.ts`

---

### N-08 — Web GUI Service

- **Runtime**: Node.js (local, HTTP :7701)
- **Delta Type**: NEW
- **Phase**: 4
- **Priority**: P1
- **Depends on**: N-05, N-07

#### Sub-tasks

**N-08.1 — HTTP server: core API**

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/roles` | List all active roles |
| GET | `/api/role/:thread_id` | Role detail (tasks, trace_id first 8 chars) |
| POST | `/api/role` | Create/activate role |
| DELETE | `/api/role/:thread_id` | Deactivate role |

- All errors: `{ "error": "..." }` JSON format with appropriate HTTP status
- **Acceptance**: All 4 endpoints return valid JSON; error cases return correct status codes

**N-08.2 — Web GUI: three pages**

| Page | Route | Features |
|------|-------|---------|
| Dashboard | `/` | All active roles; thread_id, type, status; link to detail |
| Task Detail | `/role/:thread_id` | DAG task list; status badges; trace_id (first 8 chars); 3s auto-poll |
| Prompt Editor | `/role/:thread_id/prompts` | Edit system_prompt + per-task templates; save = hot-reload |

- Dark theme, consistent with Meridian GUI visual style
- Vanilla JS + CSS (no framework dependency); single-file per page
- **Key constraint**: `trace_id` display always truncated to first 8 chars for log cross-reference
- **Acceptance**: All three pages load without console errors; task detail auto-refreshes

#### AI Auto-Tests
```bash
cd /Users/yzliu/work/Meridian/Meridian-roles
npm start &
sleep 2
curl -s http://localhost:7701/api/roles | jq type
curl -s http://localhost:7701/ | grep -q "meridian-roles" && echo "Dashboard OK"
curl -s http://localhost:7701/api/role/nonexistent | jq .error
kill %1
```

#### Human Acceptance Criteria
- [ ] Visual style matches Meridian GUI (dark theme, font, layout)
- [ ] Full flow: Dashboard → Create Dispatcher → enter TaskSpec → submit → task list visible with statuses
- [ ] trace_id first 8 chars visible and matches Meridian log entries

> 📁 All deliverable paths relative to `/Users/yzliu/work/Meridian/Meridian-roles` — see File Directory Index.

**Deliverables**: `src/server/http-server.ts`, `src/server/role-handlers.ts`, `src/web/public/index.html`, `src/web/public/role.html`, `src/web/public/prompts.html`, `src/web/public/app.js`, `src/web/public/style.css`

---

### N-09 — Meridian index.html External Link

- **Runtime**: Browser (Meridian GUI)
- **Delta Type**: REWORK (~15 lines)
- **Phase**: 4
- **Priority**: P1
- **Depends on**: N-02

#### Sub-tasks

**N-09.1 — Add role link to Meridian thread card**
- Target file: `/Users/yzliu/work/Meridian/src/web/public/index.html`
- In the thread detail card render loop, add async fetch:
```javascript
fetch(`http://localhost:7701/api/role/${inst.thread_id}`)
  .then(res => {
    if (res.ok) card.querySelector('.role-link').style.display = 'flex';
  })
  .catch(() => {}); // silent fail — meridian-roles may not be running
```
- Add hidden `.role-link` element to card template: `<a class="role-link" href="http://localhost:7701/role/${inst.thread_id}" style="display:none">角色配置 →</a>`
- **Key constraint**: `catch` must be empty — fetch failure must never throw or log to console
- **Acceptance**: Thread with active role shows link; thread without role shows nothing; meridian-roles stopped → no JS errors

**N-09.2 — Regression: Meridian existing tests must pass**
- Run full Meridian test suite after the 15-line change
- **Acceptance**: Zero regressions

#### AI Auto-Tests
```bash
cd /Users/yzliu/work/Meridian
npm test
```

#### Human Acceptance Criteria
- [ ] Thread card with active Dispatcher shows "角色配置 →" link; clicking opens correct GUI page
- [ ] Stop meridian-roles → Meridian GUI renders normally, no console errors

> 📁 This task modifies the **Meridian repo** at `/Users/yzliu/work/Meridian` — NOT the meridian-roles repo. See File Directory Index.

**Deliverables**: `/Users/yzliu/work/Meridian/src/web/public/index.html` (15-line addition)

---

### N-10 — E2E Integration Tests + Documentation

- **Runtime**: Node.js (local)
- **Delta Type**: NEW
- **Phase**: 5
- **Priority**: P1
- **Depends on**: N-06, N-07, N-08, N-09

#### Sub-tasks

**N-10.1 — E2E test suite: 5 scenarios**

| Scenario | Description | Auto/Manual |
|----------|-------------|-------------|
| A | Explicit 3-task DAG (A→B, A→C): parallel trigger after A; T2 summary complete | Auto |
| B | Inferred mode: TaskSpec only → plan generated → executed | Auto (quality: manual) |
| C | Prompt hot-reload: modify pending task template mid-run → next dispatch uses new content | Auto |
| D | Restart recovery: kill process mid-DAG → restart → resumes from correct task | Auto |
| E | Socket channel routing: verify SocketChannelAdapter writes to roles.sock; A2AServer receives; trace_id matches both ends | Auto |

- Prerequisite: Meridian with socket channel support must be running
- `--mock` flag: Scenarios A/C/D/E run with mock Meridian (no real agent); Scenario B always needs real agent
- **Acceptance**: `npm run test:e2e` → all 5 scenarios in output; A/C/D/E pass automatically; B pass with human quality check

**N-10.2 — README.md**
- Sections: project overview, install & start, Meridian integration config, socket channel mechanism (with ASCII sequence diagram), Dispatcher usage (curl examples), new role development guide (5-step guide)
- **Acceptance**: A developer unfamiliar with the codebase can complete integration following README alone

**N-10.3 — docs/socket-channel-flow.md**
- Detailed sequence diagram of the full reply_channel socket flow (roles → hub → SocketChannelAdapter → roles.sock → A2AServer → RoleRunner → Dispatcher)
- **Acceptance**: All intermediate steps labeled with code references (file + function name)

**N-10.4 — docs/adding-new-role.md**
- Step-by-step: extend BaseRole, register in RoleRegistry, add to RoleType enum, wire up GUI route
- Include minimal working example (mock role: EchoRole)

#### AI Auto-Tests
```bash
cd /Users/yzliu/work/Meridian/Meridian-roles
npm run test:e2e
# Expected output:
# ✅ Scenario A: Explicit DAG dispatch — PASS
# ✅ Scenario B: Inferred dispatch — PASS (quality: manual review)
# ✅ Scenario C: Hot prompt update — PASS
# ✅ Scenario D: Restart recovery — PASS
# ✅ Scenario E: Socket channel routing — PASS
```

#### Human Acceptance Criteria
- [ ] Scenario A: GUI shows real-time task state transitions visually
- [ ] Scenario E: Both Meridian and meridian-roles logs show identical `trace_id`
- [ ] Follow README from zero → successful integration without additional questions

> 📁 All deliverable paths relative to `/Users/yzliu/work/Meridian/Meridian-roles` — see File Directory Index.

**Deliverables**: `tests/e2e/scenario-a.ts`, `tests/e2e/scenario-b.ts`, `tests/e2e/scenario-c.ts`, `tests/e2e/scenario-d.ts`, `tests/e2e/scenario-e.ts`, `README.md`, `docs/socket-channel-flow.md`, `docs/adding-new-role.md`

---

## IV. Cross-Worker Integration Points

| Producer | Consumer | Contract |
|----------|----------|----------|
| N-01 `types.ts` / `config.ts` | N-02, N-03, N-04, N-05 | `HubMessage`, `HubResult`, `ReplyChannelSchema`, socket path constants |
| N-02 `A2AClient.send()` | N-05 T0 via `ctx.sendToHub()` | `Partial<HubMessage>` in → fire-and-forget; throws on connection failure |
| N-02 `A2AServer.onResult()` | N-03 `RoleRunner.dispatch()` | `HubResult` (parsed from raw socket JSON) → routed by threadId |
| N-03 `RoleRunner` | N-05 `DispatcherRole` | `onInboundResult(HubResult)` — called only on threadId match |
| N-04 `StateStore` | N-05, N-06, N-07 | `save(state)` / `load()` → atomic JSON; schema: `{ roles, promptStore }` |
| N-05 `DispatcherRole` | N-06 `infer extension` | `config.tasks`, `config.taskspec`, `inferTraceId` field on DispatcherRole instance |
| N-05 role API shape | N-07 `PromptStore` handlers | `GET/PATCH/DELETE /api/role/:thread_id/...` HTTP contract |
| N-07 `PromptStore` | N-08 GUI prompt editor page | Same HTTP endpoints; response: `{ system_prompt, tasks[].instruction_template }` |
| N-02 `register_service` | N-09 Meridian `index.html` | `GET http://localhost:7701/api/role/:thread_id` → 200 (role exists) or 404 |
| N-05–N-08 (all) | N-10 E2E tests | Full running stack; `--mock` flag for CI |

---

## V. DELTA-CHECK

### DELTA-CHECK — Spec Alignment Audit + Corrective Dispatch

- **Runtime**: Local (git diff + document review)
- **Delta Type**: DRIFT / REWORK triage
- **Phase**: Ω
- **Priority**: P0
- **Depends on**: N-01, N-02, N-03, N-04, N-05, N-06, N-07, N-08, N-09, N-10

#### Sub-tasks

**DELTA-CHECK.1 — Diff implemented output against Worker acceptance criteria**
- Load the original TaskSpec, both PRDs, and all Worker completion reports before reviewing the branch diff
- Compare actual deliverables against every Worker acceptance criterion using the full feature-branch diff against the approved base branch
- Produce `/Users/yzliu/work/Meridian/Meridian-roles/docs/v1.0.0/DEV/dev_history/delta_check_report.md`
- Required table columns: `Worker | Status | Findings | Action Required`
- Allowed status values: `✅ Aligned` / `⚠️ Drift` / `❌ Missing`
- **Key constraint**: Every implementation Worker from N-01 through N-10 must appear exactly once in the report
- **Acceptance**: Delta report exists and covers all implementation Workers with evidence-backed findings
- **Ref**: Terminal lifecycle rule for this TaskSpec

**DELTA-CHECK.2 — Append minimum-scope corrective workers if gaps are found**
- If any `⚠️ Drift` or `❌ Missing` finding is present, evaluate the size of the correction before dispatching more work
- If the fix scope is `<=5` corrective workers and requires no new PM decision, append new rows directly to the current dispatch plan with `Phase: Ω+1`, `Depends On: DELTA-CHECK`, and `Delta Type: DRIFT` or `REWORK`
- Corrective worker completion reports must be written under `/Users/yzliu/work/Meridian/Meridian-roles/docs/v1.0.0/DEV/dev_history/v1.2_delta/`
- If more than 5 corrective workers are needed, or if any new PRD-level decision is required, stop and generate a new delta TaskSpec artifact set for PM review instead of continuing inside this plan
- **Key constraint**: This is one pass only. No second Delta Check runs after corrective workers finish; PR Review is the terminal safety net
- **Acceptance**: Corrective workers are appended only when the minimum viable correction is clear; otherwise the task is escalated to a new delta TaskSpec round
- **Ref**: Terminal lifecycle rule for this TaskSpec

#### AI Auto-Tests
```bash
cd /Users/yzliu/work/Meridian/Meridian-roles
git diff <base-branch>..HEAD --stat
test -f /Users/yzliu/work/Meridian/Meridian-roles/docs/v1.0.0/DEV/dev_history/delta_check_report.md
rg -n "N-01|N-02|N-03|N-04|N-05|N-06|N-07|N-08|N-09|N-10" /Users/yzliu/work/Meridian/Meridian-roles/docs/v1.0.0/DEV/dev_history/delta_check_report.md
rg -n "✅ Aligned|⚠️ Drift|❌ Missing" /Users/yzliu/work/Meridian/Meridian-roles/docs/v1.0.0/DEV/dev_history/delta_check_report.md
```

#### Human Acceptance Criteria
- [ ] Every implementation Worker is represented in the Delta Check report with a concrete alignment verdict
- [ ] Every `⚠️ Drift` or `❌ Missing` finding identifies the specific acceptance gap and the minimum corrective action required
- [ ] Any corrective workers added to the dispatch plan are explicitly scoped to the drift they fix and point to `/Users/yzliu/work/Meridian/Meridian-roles/docs/v1.0.0/DEV/dev_history/v1.2_delta/`
- [ ] No second Delta Check is scheduled after corrective workers complete

---

## VI. PR-REVIEW

### PR-REVIEW — Full Diff Review + Merge Recommendation

- **Runtime**: Local (git diff + PRD/TaskSpec review)
- **Delta Type**: REVIEW
- **Phase**: Ω
- **Priority**: P0
- **Depends on**: DELTA-CHECK

#### Sub-tasks

**PR-REVIEW.1 — Review the full PR diff against PRD + TaskSpec**
- Open the full feature diff against the approved base branch after DELTA-CHECK is `✅`
- Load: both PRDs, this TaskSpec, the Delta Check report, and any corrective worker reports under `/Users/yzliu/work/Meridian/Meridian-roles/docs/v1.0.0/DEV/dev_history/v1.2_delta/`
- Verify that all TaskSpec acceptance criteria are implemented, no marked-complete Worker is absent from the diff, and no unplanned behavior or files were introduced
- **Key constraint**: Review must cover both `meridian-roles` and the Meridian-side N-09 change so the terminal verdict reflects the real cross-repo surface area
- **Acceptance**: Review notes map every changed file in scope to a Worker and a verdict
- **Ref**: meridian-roles PRD v1.2; Meridian 平台升级 PRD v1.0

**PR-REVIEW.2 — Produce merge/block recommendation**
- Write `/Users/yzliu/work/Meridian/Meridian-roles/docs/v1.0.0/DEV/dev_history/pr_review_report.md`
- Required table columns: `File | Worker | Verdict | Notes`
- Allowed verdict values: `✅ Aligned` / `⚠️ Scope Drift` / `❌ Missing` / `➕ Unplanned Addition`
- Add a 1-3 sentence scope drift summary and end the report with exactly one final line: `MERGE APPROVED` or `MERGE BLOCKED — [reason]`
- **Key constraint**: Agents never merge. If blocked, findings go back to PM; if approved, human performs the actual merge
- **Acceptance**: PR review report exists, includes a per-file verdict table, and ends with an explicit merge recommendation
- **Ref**: Terminal lifecycle rule for this TaskSpec

#### AI Auto-Tests
```bash
cd /Users/yzliu/work/Meridian/Meridian-roles
git diff <base-branch>..HEAD --name-only
test -f /Users/yzliu/work/Meridian/Meridian-roles/docs/v1.0.0/DEV/dev_history/pr_review_report.md
rg -n "✅ Aligned|⚠️ Scope Drift|❌ Missing|➕ Unplanned Addition" /Users/yzliu/work/Meridian/Meridian-roles/docs/v1.0.0/DEV/dev_history/pr_review_report.md
rg -n "MERGE APPROVED|MERGE BLOCKED" /Users/yzliu/work/Meridian/Meridian-roles/docs/v1.0.0/DEV/dev_history/pr_review_report.md
```

#### Human Acceptance Criteria
- [ ] Every changed file in the final PR scope is assigned to a Worker and receives an explicit verdict
- [ ] The report clearly identifies any remaining scope drift, missing implementation, or unplanned additions
- [ ] The final line is either `MERGE APPROVED` or `MERGE BLOCKED — [reason]`
- [ ] Merge remains a human-only action

---

## VII. Risks & PM Flags

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| Meridian platform upgrade delayed (socket adapter not ready) | High | Low | N-01–N-04 can proceed in parallel; N-05 waits only for real integration testing |
| LLM inference output format unstable | Medium | Medium | JSON fence stripping + zod validation; prompt includes strict format examples |
| E2E depends on real claude agent | Medium | Medium | `--mock` flag for Scenario A/C/D/E in CI; Scenario B always manual |
| `[ASSUMPTION]` paths not confirmed before dispatch | Medium | Medium | All `[ASSUMPTION]` entries in File Directory Index must be confirmed by PM before agent sessions start |
| Delta Check finds broad drift late in the round | High | Low | Allow in-plan corrective workers only for minimum-scope fixes; escalate to a new delta TaskSpec if >5 workers or new PM decisions are required |
| PR review misses cross-repo scope because N-09 lives in Meridian | High | Low | PR-REVIEW must explicitly inspect both meridian-roles diff and the Meridian-side N-09 change before issuing merge guidance |

**PM Flags for Dispatch Plan**:

| Flag | Location | Resolution |
|------|----------|------------|
| N-02 and N-03 are parallel but both depend on N-01 completing build cleanly | Phase 1 | Enforce Phase 0 gate: N-01 must be `✅` before any Phase 1 agent starts |
| N-09 modifies Meridian repo — different root path | Phase 4 | Agent for N-09 must be briefed on `/Users/yzliu/work/Meridian` separately; not `/Users/yzliu/work/Meridian/Meridian-roles` |
| Scenario B in N-10 requires idle claude agent — not guaranteed in CI | Phase 5 | Always run E2E with `--mock` in CI; Scenario B = manual-only gate |
