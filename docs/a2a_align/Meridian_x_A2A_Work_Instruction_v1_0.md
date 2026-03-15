**Meridian × A2A**

协议对齐研发工作说明书

<table>
<colgroup>
<col style="width: 100%" />
</colgroup>
<tbody>
<tr class="odd">
<td><p>版本 v1.0</p>
<p>2026年3月</p></td>
</tr>
</tbody>
</table>

**1. 背景与目标**

Meridian 目前是一个基于 Unix Socket + JSON IPC 的私有调度总线。随着
Agent 矩阵规模扩大，每接入一个新 Service
都需要定制集成代码，维护成本线性增长。

本次改造目标是将 Meridian 的 ServiceRegistry 和外部接入协议对齐 Google
A2A（Agent2Agent）标准，使得任何实现了 A2A Server 接口的 Service
都能零摩擦接入，Meridian 本身的核心能力（Telegram
控制、spawn/kill/monitor、人机接口）完全保留。

|                                                                                      |
|--------------------------------------------------------------------------------------|
| 💡 核心原则：A2A 是协议，Meridian 是实现了该协议的控制平面。改造是增量的，不是重写。 |

**2. 现有架构分析**

**2.1 当前 ServiceRegistry 机制**

现有代码（src/hub/service-registry.ts）已经有 intent → socket_path
的映射机制：

<table>
<colgroup>
<col style="width: 100%" />
</colgroup>
<tbody>
<tr class="odd">
<td><p>ServiceEndpoint {</p>
<p>service?: string // 服务标识符</p>
<p>socket_path: string // Unix Socket 路径</p>
<p>intents: string[] // 该服务处理的 intent 列表</p>
<p>metadata?: Record&lt;string&gt; // 可扩展元数据</p>
<p>}</p></td>
</tr>
</tbody>
</table>

当 HubRouter 收到一个非内置 intent 时，会查 ServiceRegistry → 找到对应
socket_path → 用 sendIpcRequest 转发完整 HubMessage → 等待 HubResult
返回。

这个机制已经是 A2A 思路的私有实现，改造量较小。

**2.2 当前通信协议**

|          |                         |                                 |
|----------|-------------------------|---------------------------------|
| **层次** | **现状**                | **A2A 目标**                    |
| 服务发现 | 静态配置（ENV 变量）    | Agent Card（JSON 描述文件）     |
| 通信协议 | Unix Socket + 私有 JSON | JSON-RPC 2.0 over HTTP/Socket   |
| 能力声明 | intents 字符串数组      | Agent Card skills 字段          |
| 消息格式 | HubMessage/HubResult    | A2A Task/TaskResult（外层包装） |
| 动态注册 | 不支持                  | Service 启动时自动注册          |

**2.3 内置 Intent 不受影响**

以下内置 intent 由 HubRouter 直接处理，与 A2A 改造无关，完全保留：

<table>
<colgroup>
<col style="width: 100%" />
</colgroup>
<tbody>
<tr class="odd">
<td><p>run | terminal_input | spawn | restart | reboot | kill</p>
<p>status | list | list_models | switch_model | detail</p>
<p>attach | detach | gui | monitor_update |
monitor_manual_update</p></td>
</tr>
</tbody>
</table>

A2A 层只处理非内置 intent，即转发给外部 Service 的请求。

**3. 改造范围与分工**

**3.1 改造范围**

|                             |                                  |            |
|-----------------------------|----------------------------------|------------|
| **模块**                    | **改造内容**                     | **优先级** |
| ServiceEndpoint 类型        | 增加 agent_card 字段             | P0         |
| ServiceRegistry             | 支持按 skill name 解析           | P0         |
| HubRouter.dispatchToService | 增加 A2A 消息包装层              | P0         |
| 动态注册 API                | 新增 /register-service HTTP 端点 | P1         |
| Agent Card 验证             | 启动时拉取并缓存 Agent Card      | P1         |
| OpenClaw 接入层             | 实现 A2A Client 调用 Meridian    | P1         |
| CORD A2A Server             | CORD 暴露 A2A Server 端点        | P2         |

**3.2 不改动的部分**

- Telegram 接口层（interface/）— 完全保留

- Monitor 模块（monitor/）— 完全保留

- Web GUI（web/）— 完全保留

- 内置 intent 处理逻辑（HubRouter 中的 handle\* 方法）— 完全保留

- IPC 底层通信（shared/ipc.ts）— 保留，A2A 在其上做包装

- 现有 CORD 的内部运作机制 — 完全保留，仅对外增加 A2A Server 端点

**4. P0 任务详细说明**

**4.1 扩展 ServiceEndpoint 类型**

在 src/types.ts 的 ServiceEndpointSchema 中增加 agent_card 字段：

<table>
<colgroup>
<col style="width: 100%" />
</colgroup>
<tbody>
<tr class="odd">
<td><p>// src/types.ts</p>
<p>export const AgentCardSkillSchema = z.object({</p>
<p>id: z.string().min(1),</p>
<p>name: z.string().min(1),</p>
<p>description: z.string().optional(),</p>
<p>intents: z.array(z.string().min(1)).default([]),</p>
<p>tags: z.array(z.string()).default([]),</p>
<p>});</p>
<p>export const AgentCardSchema = z.object({</p>
<p>name: z.string().min(1),</p>
<p>description: z.string().optional(),</p>
<p>version: z.string().optional(),</p>
<p>skills: z.array(AgentCardSkillSchema).default([]),</p>
<p>url: z.string().optional(),</p>
<p>});</p>
<p>export const ServiceEndpointSchema = z.object({</p>
<p>service: z.string().min(1).optional(),</p>
<p>socket_path: z.string().min(1),</p>
<p>intents: z.array(z.string().min(1)).default([]), // 保留兼容</p>
<p>agent_card: AgentCardSchema.optional(), // 新增</p>
<p>metadata: z.record(z.string(), z.unknown()).optional()</p>
<p>});</p></td>
</tr>
</tbody>
</table>

向后兼容：agent_card 为 optional，未提供 agent_card 的 Service 继续用
intents 数组路由，行为不变。

**4.2 ServiceRegistry 支持 Agent Card 解析**

在 src/hub/service-registry.ts 中，register() 方法在注册时同时索引
agent_card.skills\[\].intents：

<table>
<colgroup>
<col style="width: 100%" />
</colgroup>
<tbody>
<tr class="odd">
<td><p>register(rawEndpoint: ServiceEndpoint): ServiceEndpoint {</p>
<p>const endpoint = ServiceEndpointSchema.parse(rawEndpoint);</p>
<p>const serviceId = endpoint.service ?? endpoint.socket_path;</p>
<p>this.unregister(serviceId);</p>
<p>this.endpointsByService.set(serviceId, endpoint);</p>
<p>// 原有 intents 索引（保留）</p>
<p>for (const intent of endpoint.intents) {</p>
<p>this.serviceByIntent.set(intent, serviceId);</p>
<p>}</p>
<p>// 新增：从 agent_card.skills 中提取 intents</p>
<p>for (const skill of endpoint.agent_card?.skills ?? []) {</p>
<p>for (const intent of skill.intents) {</p>
<p>this.serviceByIntent.set(intent, serviceId);</p>
<p>}</p>
<p>}</p>
<p>return endpoint;</p>
<p>}</p></td>
</tr>
</tbody>
</table>

**4.3 dispatchToService 增加 A2A 包装**

在 src/hub/router.ts 中，dispatchToService 在转发前将 HubMessage 包装成
A2A Task 格式，收到响应后解包：

<table>
<colgroup>
<col style="width: 100%" />
</colgroup>
<tbody>
<tr class="odd">
<td><p>private async dispatchToService(</p>
<p>endpoint: ServiceEndpoint,</p>
<p>message: HubMessage</p>
<p>): Promise&lt;HubResult&gt; {</p>
<p>const a2aTask = {</p>
<p>jsonrpc: '2.0',</p>
<p>method: 'tasks/send',</p>
<p>id: message.trace_id,</p>
<p>params: {</p>
<p>id: message.trace_id,</p>
<p>message: {</p>
<p>role: 'user',</p>
<p>parts: [{ type: 'text', text: JSON.stringify(message) }]</p>
<p>}</p>
<p>}</p>
<p>};</p>
<p>const raw = await sendIpcRequest&lt;object, A2AResponse&gt;(</p>
<p>endpoint.socket_path, a2aTask</p>
<p>);</p>
<p>return this.unwrapA2AResponse(raw, message);</p>
<p>}</p></td>
</tr>
</tbody>
</table>

**5. P1 任务详细说明**

**5.1 动态服务注册 API**

在 HubServer 上增加一个 register_service intent（或 HTTP 端点），允许
Service 在启动时主动注册自己，不再需要在 ENV 中静态配置：

<table>
<colgroup>
<col style="width: 100%" />
</colgroup>
<tbody>
<tr class="odd">
<td><p>// Service 启动时发送注册请求</p>
<p>{</p>
<p>'intent': 'register_service',</p>
<p>'payload': {</p>
<p>'content': JSON.stringify({</p>
<p>service: 'cord-project-a',</p>
<p>socket_path: '/tmp/cord-a.sock',</p>
<p>agent_card: { ... }</p>
<p>})</p>
<p>}</p>
<p>}</p></td>
</tr>
</tbody>
</table>

对应地增加 unregister_service intent，Service 退出时主动注销，Meridian
的 ServiceRegistry 实时更新。

**5.2 OpenClaw → Meridian 接入**

OpenClaw 通过 Meridian 的 Unix Socket 发送标准 HubMessage，Meridian
的角色不变（仍是调度中枢）。OpenClaw 需要实现一个轻量 Meridian Client：

<table>
<colgroup>
<col style="width: 100%" />
</colgroup>
<tbody>
<tr class="odd">
<td><p>// OpenClaw 侧的 Meridian Client（伪代码）</p>
<p>async function callMeridian(intent, target, content) {</p>
<p>const message = {</p>
<p>trace_id: randomUUID(),</p>
<p>thread_id: target,</p>
<p>actor_id: 'openclaw',</p>
<p>intent: intent,</p>
<p>target: target,</p>
<p>priority: 5,</p>
<p>mode: 'bridge',</p>
<p>reply_channel: { channel: 'web', chat_id: 'openclaw:1' },</p>
<p>payload: { content, attachments: [] }</p>
<p>};</p>
<p>return await sendIpcRequest(MERIDIAN_SOCKET, message);</p>
<p>}</p></td>
</tr>
</tbody>
</table>

**6. 验收标准**

|        |                                                      |              |
|--------|------------------------------------------------------|--------------|
| **\#** | **验收条件**                                         | **对应任务** |
| 1      | 带 agent_card 的 Service 注册成功，intent 路由正常   | 4.1 + 4.2    |
| 2      | 未带 agent_card 的旧格式 Service 注册和路由不受影响  | 4.1          |
| 3      | A2A 包装后 dispatchToService 能正确收发消息          | 4.3          |
| 4      | Service 动态注册/注销后，ServiceRegistry 实时更新    | 5.1          |
| 5      | OpenClaw 通过 Meridian Client 成功触发一个 CORD 任务 | 5.2          |
| 6      | 所有现有测试套件通过（无回归）                       | 全部         |

**7. 里程碑**

|          |                                                         |              |
|----------|---------------------------------------------------------|--------------|
| **阶段** | **内容**                                                | **预期工时** |
| M1       | P0：类型扩展 + ServiceRegistry + dispatchToService 包装 | 1-2 天       |
| M2       | P1：动态注册 API + 现有测试全绿                         | 1 天         |
| M3       | P1：OpenClaw Client + 端到端联调                        | 1-2 天       |
| M4       | P2：CORD 暴露 A2A Server 端点                           | 1-2 天       |
