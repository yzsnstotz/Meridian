**MERIDIAN × A2A**

协议对齐 · 研发 Task Spec

*含测试方案 & Dispatch 策略*

版本 v1.0 · 2026年3月

**0. 文档概述与目标**

本 Task Spec 基于《Meridian Service Onboarding Protocol
v1.0》与《Meridian × A2A 协议对齐研发工作说明书
v1.0》两份文档编制，面向承接本次改造任务的研发工程师。文档包含：

- 各子任务的详细交付物定义

- 完整测试方案（单元 / 集成 / 端到端）

- Dispatch 策略（worker 数量、串并行、session 策略）

|             |                                                                                                                                             |
|-------------|---------------------------------------------------------------------------------------------------------------------------------------------|
| **💡 原则** | *A2A 是协议，Meridian 是实现了该协议的控制平面。改造是增量的，不是重写。所有内置 intent、Telegram 接口、Monitor 模块、Web GUI 均不受影响。* |

**1. Task 拆解总览**

按优先级分为
P0（核心路径，必须首先完成）、P1（动态能力，紧随其后）、P2（扩展接入）三层。

| **Task ID** | **优先级** | **模块**               | **交付物**                                        | **预期工时** |
|-------------|------------|------------------------|---------------------------------------------------|--------------|
| T-01        | P0         | src/types.ts           | AgentCardSchema + 扩展 ServiceEndpointSchema      | 0.5d         |
| T-02        | P0         | service-registry.ts    | register() 支持 agent_card.skills 索引            | 0.5d         |
| T-03        | P0         | router.ts              | dispatchToService A2A 包装层 + unwrapA2AResponse  | 1d           |
| T-04        | P1         | router.ts / hub-server | register_service / unregister_service intent 处理 | 1d           |
| T-05        | P1         | openclaw/              | Meridian Client 轻量实现                          | 1d           |
| T-06        | P2         | cord/                  | CORD 暴露 A2A Server 端点                         | 1.5d         |

**2. P0 任务详细说明**

**T-01 扩展 ServiceEndpoint 类型**

**交付物**

在 src/types.ts 中新增 AgentCardSkillSchema、AgentCardSchema，并在
ServiceEndpointSchema 中增加可选字段 agent_card。

|                                                         |
|---------------------------------------------------------|
| // src/types.ts — 新增类型定义                          |
| export const AgentCardSkillSchema = z.object({          |
| id: z.string().min(1),                                  |
| name: z.string().min(1),                                |
| description: z.string().optional(),                     |
| intents: z.array(z.string().min(1)).default(\[\]),      |
| tags: z.array(z.string()).default(\[\]),                |
| });                                                     |
|                                                         |
| export const AgentCardSchema = z.object({               |
| name: z.string().min(1),                                |
| description: z.string().optional(),                     |
| version: z.string().optional(),                         |
| url: z.string().optional(),                             |
| skills: z.array(AgentCardSkillSchema).default(\[\]),    |
| });                                                     |
|                                                         |
| // ServiceEndpointSchema 新增字段（向后兼容，optional） |
| agent_card: AgentCardSchema.optional(),                 |

|               |                                                                                                                |
|---------------|----------------------------------------------------------------------------------------------------------------|
| **⚠️ 兼容性** | *agent_card 字段必须为 optional。未提供 agent_card 的旧格式 Service 继续通过原有 intents 数组路由，行为不变。* |

**验收标准**

- 新类型能被 zod parse 正确校验有效/无效输入

- ServiceEndpointSchema 带/不带 agent_card 均可解析成功

- 导出类型供 registry 和 router 消费

**T-02 ServiceRegistry 支持 Agent Card 解析**

**交付物**

在 src/hub/service-registry.ts 的 register() 方法中，在保留原有 intents
索引的基础上，额外从 agent_card.skills\[\].intents 中提取并写入
serviceByIntent map。

|                                                            |
|------------------------------------------------------------|
| // service-registry.ts — register() 新增段落               |
| // 原有 intents 索引（保留，不删除）                       |
| for (const intent of endpoint.intents) {                   |
| this.serviceByIntent.set(intent, serviceId);               |
| }                                                          |
|                                                            |
| // 新增：从 agent_card.skills 提取 intents                 |
| for (const skill of endpoint.agent_card?.skills ?? \[\]) { |
| for (const intent of skill.intents) {                      |
| this.serviceByIntent.set(intent, serviceId);               |
| }                                                          |
| }                                                          |

**验收标准**

- 注册含 agent_card 的 Service 后，其 skills 中所有 intent
  均可被路由命中

- 旧格式 Service 注册后路由行为与改造前一致（无回归）

- 同一 intent 被两处声明时，后注册者覆盖（与原有逻辑保持一致）

**T-03 dispatchToService 增加 A2A 包装层**

**交付物**

在 src/hub/router.ts 的 dispatchToService 方法中，转发前将 HubMessage
包装成 A2A tasks/send 格式；收到响应后调用 unwrapA2AResponse 解包，恢复
HubResult。

|                                                            |
|------------------------------------------------------------|
| // router.ts — A2A 包装                                    |
| const a2aTask = {                                          |
| jsonrpc: '2.0',                                            |
| method: 'tasks/send',                                      |
| id: message.trace_id,                                      |
| params: {                                                  |
| id: message.trace_id,                                      |
| message: {                                                 |
| role: 'user',                                              |
| parts: \[{ type: 'text', text: JSON.stringify(message) }\] |
| }                                                          |
| }                                                          |
| };                                                         |
|                                                            |
| const raw = await sendIpcRequest\<object, A2AResponse\>(   |
| endpoint.socket_path, a2aTask                              |
| );                                                         |
| return this.unwrapA2AResponse(raw, message);               |

**unwrapA2AResponse 逻辑要求**

- 若 raw 已是 HubResult 格式（含 trace_id + status），直接返回

- 若 raw 是标准 A2A TaskResult，提取 result.output 映射到
  HubResult.content

- 若解包失败，返回 status=error 的 HubResult，不抛出

**3. P1 任务详细说明**

**T-04 动态服务注册 API**

**交付物**

在 HubRouter 中新增对 register_service 和 unregister_service intent
的处理分支，使 Service 可在运行时自主注册/注销，无需依赖 ENV 静态配置。

|                                                               |
|---------------------------------------------------------------|
| // HubRouter — 处理 register_service                          |
| case 'register_service': {                                    |
| const payload = JSON.parse(message.payload.content);          |
| const endpoint = ServiceEndpointSchema.parse({                |
| service: payload.service,                                     |
| socket_path: payload.socket_path,                             |
| agent_card: payload.agent_card,                               |
| });                                                           |
| this.serviceRegistry.register(endpoint);                      |
| return hubResult(message, 'success', 'Service registered');   |
| }                                                             |
|                                                               |
| case 'unregister_service': {                                  |
| const { service } = JSON.parse(message.payload.content);      |
| this.serviceRegistry.unregister(service);                     |
| return hubResult(message, 'success', 'Service unregistered'); |
| }                                                             |

**注册消息格式（Service 侧发送）**

|                                                                           |
|---------------------------------------------------------------------------|
| {                                                                         |
| trace_id: '\<uuid\>',                                                     |
| thread_id: 'register',                                                    |
| actor_id: 'cord-project-alpha',                                           |
| intent: 'register_service',                                               |
| target: 'global',                                                         |
| priority: 5,                                                              |
| mode: 'bridge',                                                           |
| reply_channel: { channel: 'web', chat_id: 'service:cord-project-alpha' }, |
| payload: {                                                                |
| content: JSON.stringify({ service, socket_path, agent_card }),            |
| attachments: \[\]                                                         |
| }                                                                         |
| }                                                                         |

**验收标准**

- Service 动态注册后，新 intent 路由立即生效

- Service 注销后，对应 intent 路由被清除，后续请求返回 error

- 并发注册场景下 serviceByIntent map 不出现竞态

**T-05 OpenClaw Meridian Client**

**交付物**

在 OpenClaw 侧实现一个轻量 callMeridian 函数，通过 Meridian 的 Unix
Socket 发送标准 HubMessage，并接收 HubResult。

|                                                           |
|-----------------------------------------------------------|
| // openclaw/meridian-client.ts                            |
| export async function callMeridian(                       |
| intent: string,                                           |
| target: string,                                           |
| content: string                                           |
| ): Promise\<HubResult\> {                                 |
| const message: HubMessage = {                             |
| trace_id: randomUUID(),                                   |
| thread_id: target,                                        |
| actor_id: 'openclaw',                                     |
| intent,                                                   |
| target,                                                   |
| priority: 5,                                              |
| mode: 'bridge',                                           |
| reply_channel: { channel: 'web', chat_id: 'openclaw:1' }, |
| payload: { content, attachments: \[\] }                   |
| };                                                        |
| return sendIpcRequest(MERIDIAN_SOCKET, message);          |
| }                                                         |

**验收标准**

- callMeridian('coding', 'cord-project-alpha', '...') 能成功触发 CORD
  任务

- 超时（\>60s）场景下 client 侧抛出可处理的 error，不挂起

**4. P2 任务详细说明**

**T-06 CORD 暴露 A2A Server 端点**

**交付物**

在 CORD 的进程启动脚本中创建 Unix Socket 服务端，监听 tasks/send
请求，并在处理完成后返回标准 HubResult。CORD
内部运作机制不变，仅对外增加此接入层。

|                                                                |
|----------------------------------------------------------------|
| // cord/a2a-server.ts — 伪代码                                 |
| const server = net.createServer((socket) =\> {                 |
| socket.on('data', async (data) =\> {                           |
| const req = JSON.parse(data.toString());                       |
| if (req.method !== 'tasks/send') return;                       |
|                                                                |
| const hubMsg = JSON.parse(req.params.message.parts\[0\].text); |
| const result = await cord.executeTask({                        |
| content: hubMsg.payload.content,                               |
| intent: hubMsg.intent,                                         |
| trace_id: hubMsg.trace_id,                                     |
| });                                                            |
|                                                                |
| socket.end(JSON.stringify({                                    |
| trace_id: hubMsg.trace_id,                                     |
| thread_id: result.thread_id,                                   |
| source: 'claude',                                              |
| status: 'success',                                             |
| content: result.summary,                                       |
| attachments: \[\],                                             |
| timestamp: new Date().toISOString(),                           |
| }));                                                           |
| });                                                            |
| });                                                            |
| server.listen('/tmp/cord-alpha.sock');                         |

|                 |                                                                                                              |
|-----------------|--------------------------------------------------------------------------------------------------------------|
| **⚠️ 禁止行为** | *Service 不得直接向用户发 Telegram 消息。所有输出必须通过 HubResult 返回给 Meridian，由 Meridian 统一转发。* |

**5. 测试方案**

**5.1 测试分层总览**

| **层次**   | **范围**                                    | **工具**               | **运行时机** |
|------------|---------------------------------------------|------------------------|--------------|
| 单元测试   | 类型 schema、registry 索引逻辑、unwrap 函数 | Jest / vitest          | 每次 commit  |
| 集成测试   | HubRouter dispatch + A2A 包装完整链路       | Jest + mock socket     | PR 合并前    |
| 端到端测试 | OpenClaw → Meridian → CORD 全链路           | 真实进程 + 本地 socket | 里程碑验收   |
| 回归测试   | 所有现有测试套件                            | CI 全量运行            | 每次 push    |

**5.2 单元测试用例**

**T-01 类型校验**

- 有效 AgentCardSchema 能被 parse 成功

- 缺少 name 字段时 parse 抛出 ZodError

- skills 为空数组时合法

- ServiceEndpointSchema 无 agent_card 时仍可 parse（向后兼容）

**T-02 ServiceRegistry 索引**

- 注册含 agent_card 的 endpoint，getByIntent('coding') 命中该 service

- 注册旧格式 endpoint（无 agent_card），getByIntent('legacy') 命中该
  service

- 两种格式混合注册后路由均正确

- 注销后 getByIntent 返回 undefined

**T-03 unwrapA2AResponse**

- 输入已是 HubResult 格式 → 直接返回原对象

- 输入是 A2A TaskResult 格式 → 正确映射为 HubResult

- 输入格式非法 → 返回 status=error 的 HubResult，不抛出

**5.3 集成测试用例**

**HubRouter + A2A 包装链路**

|                                                                   |
|-------------------------------------------------------------------|
| // 测试场景：intent 路由到外部 Service，包装/解包正确             |
| it('dispatches A2A task and returns HubResult', async () =\> {    |
| // 1. 注册一个 mock A2A Server（监听临时 socket）                 |
| const mockServer = createMockA2AServer('/tmp/test-svc.sock');     |
| registry.register({                                               |
| service: 'test-svc',                                              |
| socket_path: '/tmp/test-svc.sock',                                |
| agent_card: { name: 'test-svc', skills: \[{ id: 's1', name: 'S1', |
| intents: \['test_intent'\] }\] }                                  |
| });                                                               |
|                                                                   |
| // 2. 发送 HubMessage，intent=test_intent                         |
| const result = await router.dispatch(makeHubMsg('test_intent'));  |
|                                                                   |
| // 3. 验证 mock server 收到了合法的 tasks/send 请求               |
| expect(mockServer.lastRequest.method).toBe('tasks/send');         |
|                                                                   |
| // 4. 验证返回的 HubResult status=success，trace_id 一致          |
| expect(result.status).toBe('success');                            |
| expect(result.trace_id).toBe(mockMsg.trace_id);                   |
| });                                                               |

**动态注册/注销**

- 发送 register_service → ServiceRegistry 实时更新 → 后续 dispatch 命中

- 发送 unregister_service → 路由被清除 → 后续 dispatch 返回 error

**5.4 端到端测试（验收用例）**

| **\#** | **验收条件**                                    | **期望结果**                           |
|--------|-------------------------------------------------|----------------------------------------|
| E2E-1  | 带 agent_card 的 Service 注册，intent 路由      | status=success，intent 正确命中        |
| E2E-2  | 旧格式 Service 注册（无 agent_card）            | 路由行为与改造前一致                   |
| E2E-3  | A2A 包装后 dispatchToService 收发               | trace_id 不变，content 正确解包        |
| E2E-4  | Service 动态注册/注销，ServiceRegistry 实时更新 | 注册后即可路由；注销后路由消失         |
| E2E-5  | OpenClaw 触发一个 CORD 任务，全链路             | CORD 执行完毕，HubResult 回流 OpenClaw |
| E2E-6  | 所有现有测试套件通过（无回归）                  | CI 全绿，0 failure                     |

**5.5 错误场景专项测试**

| **场景**              | **触发方式**                               | **期望 status**      |
|-----------------------|--------------------------------------------|----------------------|
| Service 执行失败      | mock server 返回 error HubResult           | error                |
| Service 60s 无响应    | mock server 挂起，等待超时                 | timeout              |
| 长任务先返回 partial  | mock server 先返回 partial，再返回 success | partial → success    |
| Service 崩溃断开      | mock server 强制关闭 socket                | error（不挂起）      |
| 收到未知 intent       | 发送 intent=unknown_xyz                    | error，说明不支持    |
| HubResult schema 非法 | mock server 返回空对象 {}                  | error（unwrap 保护） |

**6. Dispatch 策略**

**6.1 Worker 数量**

各任务的建议分配如下：

| **Task**                | **Worker 数** | **理由**                                             |
|-------------------------|---------------|------------------------------------------------------|
| T-01（类型扩展）        | 1             | 单文件改动，无并发必要                               |
| T-02（Registry）        | 1             | 依赖 T-01 类型完成后接手，串行最安全                 |
| T-03（Router 包装）     | 1             | 核心链路，需深度理解上下文，单 worker 专注           |
| T-04（动态注册 API）    | 1             | 可与 T-03 并行（不同文件），建议同一 worker 顺序完成 |
| T-05（OpenClaw Client） | 1             | 独立模块，可与 T-04 并行（不同 repo）                |
| T-06（CORD A2A Server） | 1             | 独立进程，并行开发，最后联调                         |

|             |                                                                                                                                  |
|-------------|----------------------------------------------------------------------------------------------------------------------------------|
| **📌 建议** | *P0 三个任务（T-01 → T-02 → T-03）串行，单 worker 完成后统一验收；P1 的 T-04 和 T-05 可并行给两个 worker；P2 的 T-06 独立并行。* |

**6.2 串行 vs 并行**

| **阶段**    | **任务**               | **执行方式**  | **依赖关系**                                 |
|-------------|------------------------|---------------|----------------------------------------------|
| M1 (P0)     | T-01 → T-02 → T-03     | 串行          | T-02 依赖 T-01 类型；T-03 依赖 T-02 registry |
| M2 (P1前半) | T-04                   | 紧接 M1，串行 | 依赖 M1 全绿                                 |
| M2 (P1后半) | T-05                   | 与 T-04 并行  | 仅依赖 Meridian socket 接口稳定              |
| M3 (P2)     | T-06                   | 独立并行      | 依赖 M1 稳定，不阻塞 M2                      |
| M3 联调     | T-05 × T-06 × Meridian | 串行端到端    | 等 T-05、T-06 均完成                         |

**6.3 Session 策略**

不同任务对 agent session 的继承/隔离需求不同：

| **任务**    | **Session 策略**           | **说明**                                                      |
|-------------|----------------------------|---------------------------------------------------------------|
| T-01        | 新 Session                 | 类型文件改动独立，无需上下文继承                              |
| T-02        | 继承 T-01 Session          | 需要看到 T-01 已提交的类型定义，继承 context 避免重复加载文件 |
| T-03        | 继承 T-02 Session          | 需要理解 registry 改动，继承保证对上下文的一致理解            |
| T-04        | 新 Session（fork from M1） | 基于 M1 合并后的代码库创建新 session，避免携带 WIP 上下文     |
| T-05        | 新 Session                 | 独立 repo / 模块，全新 session 减少干扰                       |
| T-06        | 新 Session                 | CORD 代码库独立，新 session 隔离                              |
| 联调（E2E） | 新 Session，注入完整上下文 | 从合并后 main 分支出发，注入各模块架构说明作为 context        |

|             |                                                                                                                              |
|-------------|------------------------------------------------------------------------------------------------------------------------------|
| **⚠️ 注意** | *M1 完成并合并主干后，P1/P2 任务均应从最新 main 分支 checkout 新 session，不继承 WIP 分支上下文，避免引入未验收的中间状态。* |

**6.4 并行执行示意图**

|                                                                           |
|---------------------------------------------------------------------------|
| 时间线 ─────────────────────────────────────────────────────────────────▶ |
|                                                                           |
| Worker-A \[T-01: 类型\] → \[T-02: Registry\] → \[T-03: Router\]           |
| │                                                                         |
| ▼ M1 合并                                                                 |
| Worker-A \[T-04: 动态注册 API\]                                           |
| Worker-B \[T-05: OpenClaw Client\]                                        |
| Worker-C \[T-06: CORD A2A Server ─────────────────\]                      |
| │                                                                         |
| ▼ M3 联调                                                                 |
| All \[端到端联调: E2E-5 全链路验证\]                                      |

**7. 里程碑与验收**

| **里程碑** | **内容**                         | **工时** | **验收方式**                      |
|------------|----------------------------------|----------|-----------------------------------|
| M1         | T-01 + T-02 + T-03，P0 全部完成  | 1-2d     | E2E-1/2/3 + 全量单元/集成测试通过 |
| M2         | T-04 动态注册 API + 现有测试全绿 | 1d       | E2E-4 + CI 全绿                   |
| M3-a       | T-05 OpenClaw Client             | 1d       | 可调用 Meridian 发起请求          |
| M3-b       | T-06 CORD A2A Server             | 1.5d     | CORD 能响应 tasks/send            |
| M3-联调    | 端到端全链路联调                 | 0.5d     | E2E-5 全链路通过                  |
| Final      | 所有验收条件达成，无回归         | —        | E2E-6 CI 全绿                     |

**8. 约束与风险**

**硬性约束**

- 不允许修改 trace_id（响应的 trace_id 必须与请求相同）

- 不允许 Service 直接发 Telegram 消息，必须通过 HubResult 回流

- 不允许不返回响应（Meridian 等到超时视为违约）

- status 字段只接受 success / error / partial / timeout

**风险提示**

- 并发注册竞态：serviceByIntent 是 Map，JS
  单线程安全；若引入多线程需加锁

- unwrap 兼容性：现有 Service 若直接返回 HubResult 而非 A2A 格式，unwrap
  需做格式探测

- CORD socket 路径冲突：多 CORD 实例需各自独立 socket 路径，避免覆盖

**9. 快速验收检查清单**

|                                                       |     |
|-------------------------------------------------------|-----|
| **✅ 完成以下所有检查项，本次改造即可视为验收通过。** |     |

1.  AgentCardSchema + ServiceEndpointSchema 扩展完成，zod 校验通过

2.  ServiceRegistry 注册含 agent_card 的 endpoint，intent 路由正确

3.  旧格式 Service 路由不受影响（向后兼容）

4.  dispatchToService 发送 tasks/send 格式，Service 侧收到合法 A2A 请求

5.  Service 返回 HubResult，unwrap 后 trace_id 与请求一致

6.  动态 register_service / unregister_service 实时生效

7.  OpenClaw callMeridian 成功触发 CORD 任务，HubResult 回流

8.  CORD A2A Server 启动后自动注册，退出时自动注销

9.  所有错误场景均返回合法 HubResult（不静默失败）

10. CI 全量测试套件无回归，E2E-1 至 E2E-6 全绿
