# Meridian

## Hub 核心能力需求补充

**v2.0-S1  ·  Calling Hub 定位专项**

| 属性 | 内容 |
| --- | --- |
| 版本 | v2.0-S1（基于 v2.0 需求文档，专项补充 Hub 控制平面能力） |
| 文档性质 | 对 meridian_requirements_v2_0.docx 的补充，不重复已有内容 |
| 核心问题 | Meridian 作为「唯一控制平面」，目前缺少 Hub 定位应有的基础能力 |
| 状态 | 草稿 |

# 0  前言：为什么需要这份补充文档

meridian_requirements_v2_0.docx 聚焦于 v1.0 遗留问题修复和 Web GUI 界面层新增。本文档从另一个维度出发：

Meridian 在 ai_arch_v3 体系中的定位是「CallHub — 唯一控制平面」，但当前代码所实现的更接近「Telegram → agentapi 的智能代理」。随着 Coordinator Service、Memory Layer 陆续接入，Hub 自身的结构性能力缺口会成为瓶颈。

本文档专门整理这些缺口，并在每项需求中明确：代码现状、缺什么、怎么补、优先级。

# 1  监测层与异步回调：已实现，无需重建

**结论**：Monitor → Hub 的异步回调机制在 v1.0 已完整实现。
外部 Service（Coordinator 等）接入时，复用同一套 IPC 协议即可，无需新增端点。

## 1.1  现有实现梳理

当前代码中，Monitor Layer 与 Hub 之间的通信已经是完整的「异步事件上报 → Hub 主动推送结果」模式：

```text
Monitor（独立进程）
  └── SSE/Heartbeat 监听 agentapi 实例
  └── 检测到 task_completed / agent_error / heartbeat_missed
  └── MonitorIpcReporter.report(event)  ← 通过 Unix Socket 上报
        └── sendIpcMessage(HUB_SOCKET_PATH, payload)  [带重试]

HubServer.handleRawPayload(raw)
  └── MonitorEventSchema.safeParse(parsed)  ← 区分 MonitorEvent vs HubMessage
  └── handleMonitorEvent(event)
        ├── task_completed → deliverMonitorCompletionResult()  → ResultSender → Telegram
        ├── status_changed → router.setInstanceStatus() + forceMonitorUpdateDispatchNow()
        └── agent_error / heartbeat_missed → sendMonitorAlert() → Telegram
```

这套机制的本质就是「Service 完成任务后异步通知 Hub，Hub 再路由结果到 Interface Layer」——即 ai_arch_v3 §3.2.1 定义的 service_callback 模式。

## 1.2  Coordinator 接入时如何复用

Coordinator 作为 Service Layer 接入时，不需要新增端点，直接复用 MonitorEvent 协议：

| 场景 | Coordinator 发送的 MonitorEvent | Hub 行为 |
| --- | --- | --- |
| 任务完成 | event_type: task_completed，thread_id: task_id | deliverMonitorCompletionResult() → 回传结果到 Telegram/Web GUI |
| 角色切换进度 | event_type: status_changed，agent_status: running | 更新注册表状态，触发进度推送 |
| 任务出错暂停 | event_type: agent_error，error: 错误描述 | 推送告警到 Telegram，含 Reboot/Kill 按钮 |
| 等待用户输入 | event_type: status_changed，agent_status: waiting | 更新状态，通知用户 |

唯一需要扩展的是 MonitorEvent 的 details 字段（已是 Record<string, unknown>），可以携带 Coordinator 特有的上下文信息（当前 role、attempt 数、task_type 等）而不破坏协议兼容性。

## 1.3  需要补充的：Coordinator 作为 Service 的注册与发现

Monitor 是 Hub 的内置子系统，Coordinator 是外部 Service。两者的差异在于：Monitor 的 socket 路径是固定的（HUB_SOCKET_PATH），而 Coordinator 的端点需要动态注册。这引出下一章的 Service Registry 需求。

# 2  Service Registry（服务发现注册表）

**优先级**：P1 — Coordinator 接入的前提条件。没有 Registry，每次新增 Service 都需要修改 Hub 代码。

## 2.1  当前问题

Hub 的路由逻辑当前是硬编码的 switch-case：

```text
// router.ts — routeByIntent()
switch (message.intent) {
  case "run":    return await this.handleRun(message);
  case "spawn":  return await this.handleSpawn(message);
  case "kill":   return await this.handleKill(message);
  // ... 每增加一个 Service 都要改这里
}
```

这意味着：agentapi、Coordinator、Memory Layer 的 intent 路由全部耦合在 Hub Router 内部。新接入一个 Service 必须修改 Hub 代码，违反「Hub 不感知具体 Service 实现」的设计原则。

## 2.2  设计方案

在 Hub 内部维护一张 ServiceRegistry，将 intent → service_endpoint 的映射外置：

```text
interface ServiceEndpoint {
  name: string;
  socket_path: string;          // Unix socket 路径
  supported_intents: string[];  // 该 Service 处理的 intent 列表
  health_check_interval_ms?: number;
  registered_at: string;
}

class ServiceRegistry {
  register(endpoint: ServiceEndpoint): void
  unregister(name: string): void
  resolve(intent: string): ServiceEndpoint | null
  list(): ServiceEndpoint[]
}
```

HubRouter 的 routeByIntent() 改为查表：

```text
private async routeByIntent(message: HubMessage): Promise<HubResult> {
  // 1. 内置 intent 优先（spawn/kill/status/attach 等生命周期操作）
  const builtIn = this.handleBuiltIn(message);
  if (builtIn) return builtIn;

  // 2. 查 ServiceRegistry
  const endpoint = this.registry.resolve(message.intent);
  if (endpoint) return await this.dispatchToService(message, endpoint);

  // 3. fallback
  return this.buildResult(message, "error", ..., "Unsupported intent");
}
```

## 2.3  Service 注册方式

两种注册方式并存，不强制选一：

| 方式 | 适用场景 | 实现 |
| --- | --- | --- |
| 静态配置（环境变量） | 固定 Service，如 Coordinator | COORDINATOR_SOCKET_PATH=/tmp/coordinator.sock，COORDINATOR_INTENTS=run_task,query_task_status；Hub 启动时读取 |
| 动态注册（IPC 消息） | 临时 Service 或未来扩展 | Service 向 Hub 发送 intent: register_service 的特殊 HubMessage；Hub 更新 Registry |

Phase 1 只需实现静态配置方式，动态注册留作扩展点。

# 3  Idempotency（幂等去重）

**优先级**：P2 — 网络稳定时不影响功能；但 Telegram 重发、Web GUI WebSocket 断线重连场景下有实际风险。

## 3.1  当前问题

ai_arch_v3 在 HubMessage 中定义了 idempotency_key 字段，但 Meridian 的 types.ts 和 HubMessageSchema 均未实现。当前场景下可能发生重复执行的情况：

- Telegram Long Polling 在网络波动时可能重复投递同一条消息

- Web GUI WebSocket 断线重连后前端可能重新发送未确认的指令

- Coordinator 任务完成后的 service_callback 在重试时可能被 Hub 重复处理

## 3.2  设计方案

在 HubMessage schema 中增加 idempotency_key（可选字段），Hub 维护一个 TTL 为 5 分钟的内存去重表：

```text
// types.ts — HubMessageSchema 新增
idempotency_key: z.string().min(1).optional()

// hub/server.ts — handleRawPayload() 前置检查
if (message.idempotency_key) {
  if (this.idempotencyCache.has(message.idempotency_key)) {
    this.log.info({ idempotency_key }, "Duplicate message suppressed");
    return this.idempotencyCache.get(message.idempotency_key);  // 返回上次结果
  }
  // 处理完成后写入缓存
  this.idempotencyCache.set(message.idempotency_key, result, { ttl: 300_000 });
}
```

Interface Layer 侧：Telegram Interface 用 raw_message_id 作为 idempotency_key（已在 InboundUIEvent 中有此字段，只需透传）；Web GUI 用客户端生成的 UUID。

# 4  Priority Queue（优先级调度）

**优先级**：P2 — 单用户场景下不紧迫；多 Service 并发时有实际价值，尤其是「紧急中止」与「后台进度推送」并存时。

## 4.1  当前问题

所有 HubMessage 当前平等处理，先到先得。在以下场景下存在问题：

- 操作者发出 /kill 紧急中止指令，但此时 Hub 正在处理一批 Monitor 进度推送消息，/kill 被迫排队等待

- Coordinator 任务运行中，大量 status_changed 事件持续涌入，占用 Hub 处理带宽

## 4.2  设计方案

HubMessage 增加 priority 字段（0-9，0 最高，默认 5），Hub Server 使用简单的分级处理策略：

| Priority | 适用消息类型 | 示例 |
| --- | --- | --- |
| 0-1（紧急） | 生命周期操作 | kill、reboot；来自操作者的直接指令 |
| 2-4（高） | 交互类操作 | run、spawn、attach、detach；用户发起的任务 |
| 5（默认） | 查询与状态 | status、list；普通查询 |
| 6-8（低） | 监控与进度 | monitor_update、service_callback 进度通知 |
| 9（最低） | 后台维护 | 日志同步、Registry 心跳 |

Phase 1 实现：在 HubMessage schema 中增加可选的 priority 字段，Interface Layer 对 /kill、/reboot 等命令注入 priority=0。Hub Server 处理队列按 priority 排序（Node.js 单线程，实现为简单的优先级队列）。

# 5  span_id / parent_span_id（嵌套追踪）

**优先级**：P2 — 代码改动极小，但对调试多角色 Coordinator 任务的价值很高。建议与 Service Registry 同期实现。

## 5.1  当前问题

当前只有 trace_id，是扁平的单层追踪。一条 trace_id 对应「一次用户请求 → 一个 Agent 调用」。

当 Coordinator 运行一个 multi_agent 任务时，实际调用链是：

```text
用户发送「/run 实现登录功能」
  trace_id: abc-123
  └── Hub 路由到 Coordinator                    (span: hub-dispatch)
       └── Coordinator 调用 PM Agent            (span: coordinator-pm)
       └── Coordinator 调用 Designer Agent      (span: coordinator-designer)
       └── Coordinator 调用 Executor Agent      (span: coordinator-executor)
       └── Coordinator 调用 Reviewer Agent      (span: coordinator-reviewer)
  └── Coordinator service_callback 回 Hub       (span: coordinator-callback)
  └── Hub 回传结果到 Telegram                   (span: hub-reply)
```

没有 span_id，以上所有操作在日志里只能靠 trace_id 聚合，无法区分是哪个角色调用出了问题，也无法看到各 span 的耗时分布。

## 5.2  设计方案

在 HubMessage 和 MonitorEvent 中增加 span_id 和 parent_span_id 两个可选字段：

```text
// types.ts — HubMessageSchema / MonitorEventSchema 新增
span_id:        z.string().uuid().optional(),  // 本次 span 的唯一 ID
parent_span_id: z.string().uuid().optional(),  // 父 span ID（Hub 生成并注入）

// Hub 处理逻辑：
// 1. 接收用户消息时，生成 span_id = randomUUID()
// 2. 向 Coordinator dispatch 时，将 span_id 作为子调用的 parent_span_id 注入
// 3. Coordinator 的每次 service_callback 携带对应的 parent_span_id
// 4. 所有日志写入 span_id + parent_span_id，形成可还原的调用树
```

Pino 日志自动包含这两个字段后，现有的 verify_logs.sh 和未来的 query_thread.sh 可以直接按 span 维度过滤，无需其他改动。

# 6  actor_id 多来源会话隔离

**优先级**：P1 — Web GUI 接入时即刻需要。不实现则 Web GUI 和 Telegram 的 session 绑定会相互干扰。

## 6.1  当前问题

当前 actor_id 字段在代码里实际被固定为 owner，sessionThreadBySession 的 key 是 chat_id（Telegram 的 chat_id）。

当 Web GUI 作为第二个 Interface 接入后：

- Telegram 的 chat_id 与 Web GUI 的 session_id 可能发生命名冲突（都是字符串 key）

- Web GUI 发起的 attach 会覆盖 Telegram 的 attach 绑定，反之亦然

- 无法判断一条结果应该回传到 Telegram 还是 Web GUI

## 6.2  设计方案

session key 改为 {channel}:{chat_id} 的复合格式：

```text
// 现在：
sessionThreadBySession.key = "123456789"  // Telegram chat_id

// 改为：
sessionThreadBySession.key = "telegram:123456789"
sessionThreadBySession.key = "web:session-uuid-xxx"

// Interface Layer 在生成 InboundUIEvent 时注入 channel 前缀：
// Telegram Interface：chat_id = "telegram:" + update.message.chat.id
// Web Interface：    chat_id = "web:" + req.sessionId
```

这个改动对 Hub Router 和 InstanceManager 完全透明（它们只操作 string key），只需要在两个 Interface Layer 的发送端和接收端各加一行前缀处理。

## 6.3  actor_id 的完整启用

同步将 actor_id 从「固定 owner」改为由 Interface Layer 真实注入：

| Interface | actor_id 来源 | 示例值 |
| --- | --- | --- |
| Telegram | Telegram User ID（已在 InboundUIEvent.sender_id 中） | tg:123456789 |
| Web GUI | Web session token 的持有者标识 | web:session-uuid-xxx |
| Coordinator（service_callback） | 固定标识 | service:coordinator |
| Monitor（MonitorEvent） | 固定标识 | service:monitor |

Phase 1 不需要权限系统——actor_id 的值只用于日志追踪和 session 隔离，不做 AuthZ 决策。多用户权限隔离保留至 Phase 2（ai_arch_v3 Credential Layer）。

# 7  Pane Log IPC 推送（Web GUI 终端桥的层间解耦）

**优先级**：P1 — v2.0 Web GUI 终端视图的架构前提。必须在 Web Interface Server 实现前确定。

## 7.1  问题描述

v2.0 需求文档中，Web GUI 的 pane_bridge 终端视图计划通过 fs.watch() 直接监听 /var/log/hub/pane-{threadId}.log 文件。

这个设计引入了一处跨层的隐式依赖：

```text
Web Interface Layer
  └── fs.watch("/var/log/hub/pane-{threadId}.log")  ← 直接依赖 Hub 内部文件路径约定
        ↑
        Hub Core / InstanceManager
          └── enableTmuxPaneLogging()  → 写入 /var/log/hub/pane-{threadId}.log
```

隐患：Hub 的日志目录配置（LOG_DIR 环境变量）、文件名格式、写入方式发生任何变化，Web Interface 就会静默失效，且没有任何编译期或运行时错误提示。

## 7.2  设计方案

在 Hub IPC 协议中增加 subscribe_pane_output 消息类型，由 Hub 负责将 pane log 内容推送给 Web Interface，消除直接文件依赖：

```text
// 新增 IPC 消息类型（单向推送，Web Interface → Hub 发起订阅）

// 1. 订阅请求（Web Interface → Hub）
interface PaneSubscribeRequest {
  type: "subscribe_pane_output";
  thread_id: string;
  subscriber_id: string;  // Web Interface 的 socket 标识，用于回推
}

// 2. Hub 持有订阅表，监听 pane log 文件（fs.watch 封装在 Hub 内部）
// Hub 是 LOG_DIR 的唯一感知者

// 3. 推送（Hub → Web Interface，通过订阅时建立的 socket 连接）
interface PaneOutputChunk {
  type: "pane_output";
  thread_id: string;
  chunk: string;          // 新增的 log 内容片段
  timestamp: string;
}

// 4. 取消订阅（Web Interface → Hub，或 Hub 在连接断开时自动清理）
interface PaneUnsubscribeRequest {
  type: "unsubscribe_pane_output";
  thread_id: string;
  subscriber_id: string;
}
```

## 7.3  层间协议边界

| 层次 | 职责 | 不应知道的事 |
| --- | --- | --- |
| Hub Core / InstanceManager | 管理 pane log 文件路径、监听文件变化、维护订阅表、推送 chunk | Web Interface 如何渲染、WebSocket 协议细节 |
| Web Interface Server | 接收 Hub 推送的 pane_output chunk、通过 WebSocket 转发给浏览器 | pane log 文件在哪里、LOG_DIR 是什么 |
| 浏览器前端（xterm.js） | 接收 WebSocket 消息、渲染终端输出 | IPC 协议、文件系统 |

这个方案同时解决了另一个问题：bridge 模式实例没有 pane log，Hub 可以在 subscribe_pane_output 的响应中明确返回 not_available，Web Interface 切换到「轮询 HubResult」模式，无需在 Web Interface 层做 if/else 判断。

# 8  需求汇总与优先级

| 编号 | 需求项 | 优先级 | 依赖关系 | 核心收益 |
| --- | --- | --- | --- | --- |
| S-01 | Monitor 异步回调复用规范 | P0（已有） | 无 | Coordinator 接入时明确协议复用路径，无需新建机制 |
| S-02 | Service Registry | P1 | 无 | Hub 可扩展性：新 Service 无需改 Hub 代码 |
| S-03 | actor_id 多来源隔离 | P1 | Web GUI 接入 | Web GUI 与 Telegram session 互不干扰 |
| S-04 | Pane Log IPC 推送 | P1 | Web GUI 终端视图 | 消除 Web Interface 对 Hub 内部文件路径的隐式依赖 |
| S-05 | Idempotency 幂等去重 | P2 | S-03 | 防止网络抖动导致重复执行 |
| S-06 | Priority Queue 优先级调度 | P2 | S-02 | 紧急指令（kill/reboot）不被进度消息阻塞 |
| S-07 | span_id 嵌套追踪 | P2 | S-02 | 多角色 Coordinator 任务的完整调用树可观测 |

**实施建议**：P1 三项（S-02、S-03、S-04）应在 Web GUI 开发开始前完成，否则 Web Interface Server 的设计会基于错误的层间假设。
P2 三项（S-05、S-06、S-07）可以在 Web GUI 稳定后、Coordinator 正式接入前完成。
S-01 是描述性需求，不需要新代码，只需要在 Coordinator Service 的接入文档中引用本章规范。

--- Meridian · Hub 核心能力需求补充 v2.0-S1 · 草稿 ---
