# TaskSpec: meridian-roles v1.2

**Generated**: 2026-03
**Input Source**: meridian-roles PRD v1.2 + Meridian 平台升级 PRD v1.0
**前提条件**: Meridian 平台升级（socket channel 支持）必须先于或同步交付

**Assumptions**:
- [ASSUMPTION] Node.js 20+，与 Meridian 同机部署
- [ASSUMPTION] Meridian hub-core.sock: `/tmp/hub-socks/hub-core.sock`
- [ASSUMPTION] meridian-roles socket: `/tmp/meridian-roles.sock`
- [ASSUMPTION] HTTP GUI 端口: 7701
- [ASSUMPTION] 持久化文件: `/var/lib/meridian-roles/state.json`
- [CONFIRMED] reply_channel socket 机制：依赖 Meridian SocketChannelAdapter，已在 Meridian PRD v1.0 中定义，传输格式为 sendIpcMessage（JSON write to Unix socket），与 meridian-roles A2AServer 的解析方式完全对齐，无不确定点

---

## I. Project Overview

**Goal**: 构建 meridian-roles 独立服务，Phase 1 实现 BaseRole 框架 + Dispatcher 角色（显式+推导）+ Prompt 热更新 + 独立 GUI，通过 socket channel reply_channel 机制与 Meridian 完全解耦通信。

**Core Constraints**:
- TypeScript；原生 `net` 模块；`zod` schema 验证
- Meridian core 零改动（socket adapter 是平台能力，不是为 meridian-roles 定制）
- 所有结果接收通过 reply_channel socket 回调，无轮询，无 SSE

**Scope**:
- ✅ BaseRole 框架、RoleRunner、Dispatcher（显式+推导）、Prompt 热更新、GUI、A2A 通信层、Meridian index.html 外链
- ❌ 其他角色类型、多实例、角色间直接通信

---

## II. Dispatch Overview

```
[PHASE 0 — 串行]
T01 (类型定义 + 脚手架)
  |
[PHASE 1 — 并行，3 workers]
T02 (A2A 通信层)    T03 (BaseRole + RoleRunner)    T04 (状态持久化)
  |                        |                              |
[PHASE 2 — 串行]
T05 (Dispatcher 核心状态机) ← depends_on: T02, T03, T04
  |
[PHASE 3 — 并行，2 workers]
T06 (推导模式)    T07 (Prompt 热更新 API)
  |                    |
[PHASE 4 — 并行，2 workers]
T08 (Web GUI)    T09 (Meridian index.html 外链)
  |                    |
[PHASE 5 — 串行]
T10 (E2E 集成测试 + 文档)
```

| 指标 | 值 |
|------|-----|
| 最大并行 workers | 3 |
| 总任务数 | 10 |
| 关键路径 | T01→T02→T05→T06→T08→T10 |
| 预计阶段数 | 5 |

---

## III. Task List

---

### T01: 项目脚手架 + 核心类型定义

**Type**: `[SETUP]` | **Priority**: P0 | **Dependencies**: None
**Session**: 🆕 New | **Complexity**: M (2–4h)

#### Task Description

初始化项目，定义全局类型。

**config.ts 必须包含**:
```typescript
export const HUB_SOCKET_PATH   = process.env.HUB_SOCKET_PATH   ?? '/tmp/hub-socks/hub-core.sock';
export const ROLES_SOCKET_PATH = process.env.ROLES_SOCKET_PATH ?? '/tmp/meridian-roles.sock';
export const GUI_PORT          = Number(process.env.GUI_PORT ?? 7701);
export const STATE_FILE_PATH   = process.env.STATE_FILE_PATH ?? '/var/lib/meridian-roles/state.json';
export const ROLES_SERVICE_ID  = 'service:meridian-roles';
```

**types.ts 必须包含**:
- `RoleType`: `z.enum(["dispatcher"])`
- `DispatchTask` schema（含 result_trace_id 字段）
- `DispatcherConfig` schema
- `HubMessage` / `HubResult`：从 Meridian types.ts 复制，**ReplyChannelSchema 必须包含 channel:'socket' 和 socket_path 字段**（与 Meridian 平台升级后的 types.ts 对齐）

#### Definition of Done
- [ ] `npm run build` 零错误
- [ ] `ReplyChannelSchema` 支持 `channel:'socket'` + `socket_path` 字段
- [ ] `ROLES_SOCKET_PATH` 和 `ROLES_SERVICE_ID` 导出

#### AI Auto-Tests
```bash
npm install && npm run build
node -e "
const t = require('./dist/types');
// 验证 socket channel reply_channel 可正确 parse
t.ReplyChannelSchema.parse({channel:'socket',chat_id:'service:meridian-roles',socket_path:'/tmp/test.sock'});
console.log('T01 OK');
"
```
**Coverage**: ~90%

#### Human Acceptance Tests
- [ ] ReplyChannelSchema 与 Meridian 平台升级后的 types.ts 字段完全一致（人工比对）

#### Deliverables
`src/types.ts`, `src/config.ts`, `package.json`, `tsconfig.json`, `.env.example`

---

### T02: A2A 通信层

**Type**: `[CORE]` | **Priority**: P0 | **Dependencies**: depends_on: [T01]
**Session**: 🆕 New + T01 summary | **Complexity**: M (2–4h)

#### Task Description

**[CONFIRMED — 无不确定点]** Meridian 的 SocketChannelAdapter 使用 `sendIpcMessage()`（`shared/ipc.ts` 中的工具函数），其实现为：连接 socket → `socket.end(JSON.stringify(payload))`。因此 meridian-roles 的 A2AServer 只需监听 socket，读取完整 data 后 `JSON.parse` 即得到 HubResult。格式完全确定。

**A2AClient（roles → hub，发任务）**:
- 连接 hub-core.sock，`send(msg)`：fire-and-forget（write JSON + end）
- 启动时发 `register_service`（同步等待 success 响应）
- 指数退避重连（最大 30s）

**A2AServer（hub → roles，接收 socket channel 回调）**:
```typescript
// Meridian sendIpcMessage 的格式：socket.end(JSON.stringify(payload))
// A2AServer 对应接收逻辑：
server = net.createServer(socket => {
  let raw = '';
  socket.setEncoding('utf8');
  socket.on('data', chunk => raw += chunk);
  socket.on('end', () => {
    const result = HubResultSchema.parse(JSON.parse(raw));
    this.onResult(result);  // → RoleRunner.dispatch()
  });
});
server.listen(ROLES_SOCKET_PATH);
```

**register_service Agent Card**（注册目的：让 Meridian ServiceRegistry 知道此 service 存在）:
```json
{
  "name": "meridian-roles",
  "url": "/tmp/meridian-roles.sock",
  "skills": [{"id": "role-coordination", "intents": []}]
}
```

#### Definition of Done
- [ ] A2AClient.send() fire-and-forget，无异常
- [ ] register_service 流程：Meridian 日志可见注册成功
- [ ] A2AServer 收到 Meridian SocketChannelAdapter 写入的 HubResult，onResult 回调正确触发
- [ ] 连接断开自动重连

#### AI Auto-Tests
```bash
npm test -- --testPathPattern=a2a

# 模拟 Meridian sendIpcMessage 格式写入验证
node -e "
const net = require('net');
const {A2AServer} = require('./dist/a2a/server');
const srv = new A2AServer(result => console.log('received:', result.trace_id));
srv.listen('/tmp/test-roles.sock').then(() => {
  // 模拟 Meridian SocketChannelAdapter 写入
  const c = net.createConnection('/tmp/test-roles.sock', () => {
    c.end(JSON.stringify({
      trace_id:'test-uuid-1234-5678-9012-345678901234',
      thread_id:'claude_01', source:'claude',
      status:'success', content:'done', attachments:[],
      timestamp: new Date().toISOString()
    }));
  });
});
"
```
**Coverage**: ~85%

#### Human Acceptance Tests
- [ ] **真实联调**：Meridian（含 socket channel 支持）运行中，发一条 reply_channel 为 socket channel 的 HubMessage，meridian-roles 日志可见 HubResult 到达，trace_id 一致

#### Deliverables
`src/a2a/client.ts`, `src/a2a/server.ts`, `src/a2a/index.ts`, `src/a2a/__tests__/`

---

### T03: BaseRole 接口 + RoleRunner 框架

**Type**: `[CORE]` | **Priority**: P0 | **Dependencies**: depends_on: [T01]
**Session**: 🆕 New + T01 summary | **Complexity**: M (2–4h)

#### Task Description

与 v1.1 一致，接口名称确认为 `onInboundResult`（socket 回调语义），`sendToHub` 返回 `Promise<void>`。

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

**RoleRunner**: `activate` / `deactivate` / `dispatch(result)`（A2AServer onResult 回调后调用）

#### Definition of Done
- [ ] 接口编译零错误
- [ ] RoleRunner.dispatch() 正确路由到 onInboundResult()
- [ ] 不匹配的 trace_id → 静默忽略

#### AI Auto-Tests
```bash
npm test -- --testPathPattern=role-runner
```
**Coverage**: ~95%

#### Human Acceptance Tests
- [ ] 5 行以内注册新 mock 角色类型可成功 activate 和 dispatch

#### Deliverables
`src/roles/base-role.ts`, `src/roles/role-runner.ts`, `src/roles/role-registry.ts`, `src/roles/__tests__/role-runner.test.ts`

---

### T04: 状态持久化层

**Type**: `[CORE]` | **Priority**: P0 | **Dependencies**: depends_on: [T01]
**Session**: 🆕 New + T01 summary | **Complexity**: S (<2h)

#### Task Description

原子读写 state.json，持久化 roles 列表和 prompt_store。与 v1.1 完全一致。

#### Definition of Done
- [ ] save/load 往返一致
- [ ] 原子写入（tmp + rename）
- [ ] 文件/目录不存在时自动处理

#### AI Auto-Tests
```bash
npm test -- --testPathPattern=state-store
```
**Coverage**: ~95%

#### Human Acceptance Tests
- [ ] Dispatcher 运行中重启 meridian-roles，角色状态完整恢复

#### Deliverables
`src/state-store.ts`, `src/state-store.test.ts`

---

### T05: Dispatcher 核心状态机（T0/T1/T2）

**Type**: `[CORE]` | **Priority**: P0 | **Dependencies**: depends_on: [T02, T03, T04]
**Session**: 🆕 New + T01–T04 summary | **Complexity**: L (4–8h)

#### Task Description

实现完整 DispatcherRole，socket channel reply_channel 机制已完全确认。

**T0 发任务（关键实现）**:
```typescript
const traceId = randomUUID();
await ctx.sendToHub({
  trace_id: traceId,
  intent: 'run',
  target: resolvedThreadId,
  payload: { content: task.instruction_template ?? task.instruction, attachments: [] },
  reply_channel: {
    channel: 'socket',
    chat_id: ROLES_SERVICE_ID,       // 'service:meridian-roles'
    socket_path: ROLES_SOCKET_PATH,  // '/tmp/meridian-roles.sock'
  },
  suppress_reply: false,
});
task.result_trace_id = traceId;
task.status = 'running';
await stateStore.updateRole(this.threadId, this.config);
```

**T1 onInboundResult**:
```typescript
async onInboundResult(result: HubResult) {
  const task = this.tasks.find(t => t.result_trace_id === result.trace_id);
  if (!task) return; // 不属于本 Dispatcher，静默忽略
  task.status = ['success','partial'].includes(result.status) ? 'done' : 'failed';
  task.result_summary = result.content.slice(0, 500);
  await this._advanceDAG();
}
```

**_advanceDAG**: 找出所有 depends_on 已全部 done 的 pending task → 递归触发 T0
**T2**: 所有 task done/failed → 生成 Markdown 汇总 → ctx.sendToHub 发回原始用户 reply_channel

**目标解析优先级**: target_thread_id > target_model_id > target_agent_type > 自动选 idle 实例
**失败传播**: task failed → 其下游（depends_on 含此 task）自动置为 failed

#### Definition of Done
- [ ] T0：reply_channel.channel === 'socket'，socket_path 正确
- [ ] T0：task.result_trace_id 记录
- [ ] T1：trace_id 匹配正确，不匹配静默忽略
- [ ] T2：汇总报告发回原始 reply_channel
- [ ] 循环依赖检测
- [ ] 全程持久化

#### AI Auto-Tests

**Happy Path**:
- 3 任务 DAG（T1→T2, T1→T3）：onActivate 只发 T1；模拟 T1 HubResult 到达 onInboundResult → T2/T3 同时发出
- HubMessage.reply_channel.channel === 'socket' ✓，socket_path === ROLES_SOCKET_PATH ✓

**Boundary**:
- trace_id 不匹配 → 忽略，无副作用
- 所有 depends_on:[] → onActivate 同时发出所有

**Error**:
- ctx.sendToHub 抛异常 → task 置 failed，不影响其他
- failed task 下游 → 自动 failed，不发送

```bash
npm test -- --testPathPattern=dispatcher
npm run test:e2e -- --filter=dispatcher-dag
```
**Coverage**: ~85%

#### Human Acceptance Tests
- [ ] **真实联调**：Meridian 日志可见 reply_channel.channel='socket'；任务完成后 meridian-roles 日志可见结果，trace_id 两端一致
- [ ] Dispatcher 正确按 DAG 顺序执行，T2 汇总完整

#### Deliverables
`src/roles/definitions/dispatcher.ts`, `src/roles/definitions/index.ts`, `src/roles/definitions/__tests__/dispatcher.test.ts`

---

### T06: Dispatcher 推导模式

**Type**: `[CORE]` | **Priority**: P1 | **Dependencies**: depends_on: [T05]
**Session**: 🔗 Inherit T05 | **Complexity**: M (2–4h)

#### Task Description

扩展 DispatcherRole：`config.tasks` 为空时，向 claude agent 发推导请求（同样走 socket channel reply_channel），解析返回的 JSON 数组填充 `config.tasks`，然后进入正常 T0 流程。

推导请求的 HubMessage 与普通任务 HubMessage 格式完全相同，reply_channel 相同，trace_id 单独记录为 `this.inferTraceId`，在 onInboundResult 中优先判断是否为推导响应。

**解析容错**：剥离 ```json ... ``` 包装后再 JSON.parse。

#### Definition of Done
- [ ] 仅提供 taskspec 时自动发推导请求（reply_channel 正确设置）
- [ ] 推导结果解析为 DispatchTask[]，进入 T0
- [ ] 解析失败 → Dispatcher 状态置为 error，不崩溃

#### AI Auto-Tests
```bash
npm test -- --testPathPattern=dispatcher-infer
```
**Coverage**: ~80%

#### Human Acceptance Tests
- [ ] 提供真实 5 任务 TaskSpec，推导出的 Plan 依赖关系合理（人工判断）

#### Deliverables
`src/roles/definitions/dispatcher.ts` 更新

---

### T07: Prompt 热更新 API

**Type**: `[CORE]` | **Priority**: P1 | **Dependencies**: depends_on: [T05]
**Session**: 🆕 New + T04+T05 summary | **Complexity**: S (<2h)

#### Task Description

PromptStore + HTTP handler，支持 system_prompt 和 task instruction_template 热更新。

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/role/:thread_id/prompts` | 获取全部 |
| PATCH | `/api/role/:thread_id/prompt` | 更新 system_prompt |
| PATCH | `/api/role/:thread_id/task/:task_id/template` | 更新 task template |
| DELETE | `/api/role/:thread_id/task/:task_id/template` | 删除 template |

#### Definition of Done
- [ ] PATCH 后 GET 返回新内容，磁盘同步
- [ ] 非法 body → 400，不存在 → 404

#### AI Auto-Tests
```bash
npm test -- --testPathPattern=prompt-store
curl -X PATCH http://localhost:7701/api/role/claude_01/prompt \
  -H 'Content-Type: application/json' -d '{"system_prompt":"updated"}' | jq .
```
**Coverage**: ~90%

#### Human Acceptance Tests
- [ ] Dispatcher 运行中修改 pending task template，该 task 分发时使用新 instruction

#### Deliverables
`src/roles/prompt-store.ts`, `src/server/prompt-handlers.ts`

---

### T08: Web GUI 服务

**Type**: `[UI]` | **Priority**: P1 | **Dependencies**: depends_on: [T05, T07]
**Session**: 🆕 New + API 接口文档 | **Complexity**: L (4–8h)

#### Task Description

HTTP 服务（原生 Node.js，:7701）+ Web GUI，风格与 Meridian 一致（深色主题）。

**API**:

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/roles` | 列出所有活跃角色 |
| GET | `/api/role/:thread_id` | 角色详情（含 tasks，含 trace_id 前 8 位） |
| POST | `/api/role` | 创建角色 |
| DELETE | `/api/role/:thread_id` | 停用角色 |

**GUI 页面**: Dashboard / 任务详情（3s 轮询）/ Prompt 编辑器

#### Definition of Done
- [ ] 三个页面正常访问，功能完整
- [ ] 任务详情显示 trace_id 前 8 位，便于与 Meridian 日志对照
- [ ] API 错误统一格式 `{"error":"..."}`

#### AI Auto-Tests
```bash
npm start & sleep 2
curl http://localhost:7701/api/roles | jq .
curl http://localhost:7701 | grep -q "meridian-roles" && echo "GUI OK"
kill %1
```
**Coverage**: ~70%

#### Human Acceptance Tests
- [ ] 视觉风格与 Meridian 一致
- [ ] 完整创建流程：Dashboard → 创建 Dispatcher → 填写 TaskSpec → 提交 → 任务详情可见 tasks

#### Deliverables
`src/server/http-server.ts`, `src/server/role-handlers.ts`, `src/web/public/`（index/role/prompts HTML + app.js + style.css）

---

### T09: Meridian index.html 外链

**Type**: `[INTEGRATION]` | **Priority**: P1 | **Dependencies**: depends_on: [T02]
**Session**: 🆕 New + A2A context | **Complexity**: S (<2h)

#### Task Description

**范围确认**：本任务只改 Meridian 的 index.html，约 15 行。Meridian 的 socket channel 支持（SocketChannelAdapter 等）已归入 Meridian 平台升级 PRD，不在本任务范围内。

thread 详情卡片 "More info" 区域增加外链逻辑：
```javascript
fetch(`http://localhost:7701/api/role/${inst.thread_id}`)
  .then(res => { if (res.ok) card.querySelector('.role-link').style.display = 'flex'; })
  .catch(() => {}); // 静默，不影响卡片
```

#### Definition of Done
- [ ] 有角色的 thread → 显示外链
- [ ] 无角色的 thread → 无变化
- [ ] meridian-roles 未运行 → fetch 失败静默，Meridian GUI 正常
- [ ] Meridian 现有测试全部通过

#### AI Auto-Tests
```bash
# Meridian repo
npm test
```
**Coverage**: ~80%

#### Human Acceptance Tests
- [ ] 联调：有角色的 thread 卡片显示外链，点击跳转正确
- [ ] 容错：停止 meridian-roles，Meridian GUI 无报错

#### Deliverables
`Meridian/src/web/public/index.html`（约 15 行新增）

---

### T10: E2E 集成测试 + 文档

**Type**: `[TEST]` | **Priority**: P1 | **Dependencies**: depends_on: [T06, T07, T08, T09]
**Session**: 🆕 New + 完整项目 summary | **Complexity**: M (2–4h)

#### Task Description

**前提**：Meridian 平台升级（含 socket channel）已部署。

**场景 A** — 显式模式 3 任务 DAG（T1→T2, T1→T3）：验证并行触发、汇总报告
**场景 B** — 推导模式：仅 TaskSpec → 自动推导 + 执行
**场景 C** — Prompt 热更新：运行中修改 pending task template，验证生效
**场景 D** — 重启恢复：Dispatcher 运行中重启，状态恢复后继续推进
**场景 E** — Socket channel 链路验证：
  1. 发一条 reply_channel 为 socket channel 的 HubMessage
  2. 验证 Meridian SocketChannelAdapter 日志：正确写入 meridian-roles.sock
  3. 验证 meridian-roles A2AServer 收到，trace_id 两端一致

**README.md** 包含：项目定位、安装启动、接入配置、socket channel 机制说明（含时序图）、Dispatcher 使用示例（curl）、新角色开发指南（5 步骤）。

#### Definition of Done
- [ ] 场景 A/C/D/E 全自动通过
- [ ] 场景 B 通过（推导质量人工判断）
- [ ] README 完整，socket channel 时序图清晰

#### AI Auto-Tests
```bash
npm run test:e2e
# 预期：
# ✅ Scenario A: Explicit DAG dispatch — PASS
# ✅ Scenario B: Inferred dispatch — PASS
# ✅ Scenario C: Hot prompt update — PASS
# ✅ Scenario D: Restart recovery — PASS
# ✅ Scenario E: Socket channel routing — PASS
```
**Coverage**: A/C/D/E 全自动；B 推导质量人工判断

#### Human Acceptance Tests
- [ ] 场景 A：GUI 中实时观察任务图状态流转，视觉清晰
- [ ] 场景 E：Meridian 和 meridian-roles 日志中均可见相同 trace_id
- [ ] 按 README 从零启动，无需额外咨询即可成功联调

#### Deliverables
`tests/e2e/`（5 个脚本）, `README.md`, `docs/adding-new-role.md`, `docs/socket-channel-flow.md`

---

## IV. Dispatch Plan

### Phase Breakdown

| Phase | Tasks | Workers | Gate |
|-------|-------|---------|------|
| 0 | T01 | 1 | build 零错误，socket channel 类型确认 |
| 1 | T02/T03/T04 | 3 | 各自单元测试通过 |
| 2 | T05 | 1 | dispatcher.test.ts 通过；reply_channel socket 设置 code review |
| 3 | T06/T07 | 2 | 各自测试通过 |
| 4 | T08/T09 | 2 | GUI 可访问；Meridian 测试套件通过 |
| 5 | T10 | 1 | 全部 E2E 场景通过 |

### Session Inheritance Map

```
T01 [new] ──summary──→ T02 [new]
         ├──summary──→ T03 [new]
         └──summary──→ T04 [new]
T02+T03+T04 ──────────→ T05 [new]
T05 ──inherit──────────→ T06
T05 ──summary──────────→ T07 [new]
T05+T07 ───────────────→ T08 [new]
T02 ──summary──────────→ T09 [new]
All ────────────────────→ T10 [new]
```

### Worker Assignment

- **Worker A**: T01 → T02 → T05 → T06 → T08 → T10
- **Worker B**: T03 → T07 → T09
- **Worker C**: T04（Phase 1 后复用）

---

## V. Human Acceptance Checklist

- [ ] **T02 socket 格式**：A2AServer 接收格式与 Meridian sendIpcMessage 完全对齐（已确认）
- [ ] **T05 reply_channel**：每条 HubMessage reply_channel.channel==='socket'，Meridian 日志可见
- [ ] **T05 DAG**：3 任务显式模式按依赖顺序执行，汇总完整
- [ ] **T06 推导**：仅凭 TaskSpec 自动执行，Plan 合理
- [ ] **T07 热更新**：运行中修改立即生效
- [ ] **T08 GUI**：三页面功能完整，视觉与 Meridian 一致
- [ ] **T09 外链**：有角色 thread 显示外链，无角色无变化
- [ ] **T10 场景 E**：两端日志 trace_id 一致，socket channel 链路完整

---

## VI. Risks & Notes

| 风险 | 影响 | 概率 | 缓解 |
|------|------|------|------|
| Meridian 平台升级延迟（socket adapter 未就绪） | 高 | 低 | T01 完成后即可开始 T02-T04 并行；T05 等待 Meridian socket adapter 就绪后联调 |
| LLM 推导输出格式不稳定 | 中 | 中 | JSON 容错解析；prompt 中加强格式示例 |
| E2E 依赖真实 claude agent | 中 | 中 | 支持 `--mock` flag，CI 用 mock 模式 |

### Technical Debt
- 任务失败无自动重试（Phase 2）
- GUI 无认证（生产需网络隔离）
- listInstances() 依赖轮询（Phase 2 改 SSE 订阅）

### External Dependencies
- Meridian 平台升级 PRD v1.0 中的 socket channel 支持（必须先交付）
- 推导模式需至少一个 idle claude agent

---

*TaskSpec v1.2 — 最终确认版。所有技术不确定点已消除。可直接进入执行阶段。*
