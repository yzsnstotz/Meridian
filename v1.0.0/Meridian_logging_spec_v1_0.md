**Calling Hub**

**日志记录规格说明**

*Logging Specification · v1.0 · Phase 0*

远程离岸工作调度系统 · ai_arch_v2 体系

| **属性** | **内容**                                                   |
|----------|------------------------------------------------------------|
| 版本     | v1.0（与需求说明 v1.0 同步）                               |
| 关联文档 | 需求说明 v1.0 · 附件 A（接入规格）· 架构示意图             |
| 覆盖范围 | Interface Layer · Hub Core · Monitor Layer · agentapi 实例 |
| 日志库   | Pino（Node.js 结构化日志，JSON 输出）                      |
| 核心机制 | trace_id 全链路注入 · 分层日志文件 · 开发/生产环境差异配置 |

**0 文档目的**

需求说明 v1.0 第 11 节（可观测性）和技术选型中已明确以 Pino
作为日志库、以 trace_id 为全链路追踪字段，但未对以下内容作出规格约定：

- 各层日志的字段结构与必填项

- 日志文件的落盘路径、命名与轮转策略

- 开发环境与生产环境的输出格式差异

- 如何通过 trace_id / thread_id 进行交叉查询与问题排查

- Monitor 层告警事件与日志的联动关系

本文档补全上述内容，形成独立的日志规格，供开发阶段实现和运维阶段排查使用。

**1 日志架构概览**

**1.1 分层原则**

Calling Hub
采用「分层写入、集中关联」的日志策略：每个模块写入独立日志文件，所有日志条目共享
trace_id 和 thread_id 两个关联字段，排查时可跨文件联合查询。

| **层级** | **模块**                         | **日志文件**             | **主要内容**                                  |
|----------|----------------------------------|--------------------------|-----------------------------------------------|
| L1       | Interface Layer （Telegram Bot） | interface.log            | 消息收发、鉴权、InboundUIEvent 转换           |
| L2       | Hub Core                         | hub.log                  | HubMessage 路由、分发、HubResult 回传         |
| L3       | Instance Manager                 | instance.log             | 实例 spawn / kill / attach / restart 操作审计 |
| L4       | Monitor Layer                    | monitor.log              | SSE 事件流、心跳轮询、状态变化上报            |
| L5       | agentapi（外部进程）             | agentapi-{thread_id}.log | agentapi 子进程的 stdout/stderr（重定向捕获） |

**1.2 trace_id 与 thread_id 的区别**

| **字段**   | **生成时机**                      | **生命周期**           | **用途**                                 |
|------------|-----------------------------------|------------------------|------------------------------------------|
| trace_id   | 每条 HubMessage 生成时（UUID v4） | 单次指令的完整链路     | 查询一条指令从入站到结果回传的完整路径   |
| thread_id  | spawn 时由 Instance Manager 分配  | Agent 实例整个存活期   | 查询某个 Agent 实例的所有历史交互        |
| session_id | Telegram 会话维度（可选扩展）     | 操作者的 Telegram 聊天 | Phase 1 多用户场景预留，Phase 0 可不实现 |

**2 标准日志字段定义**

**2.1 所有层级必填字段**

每条日志条目（JSON object）必须包含以下基础字段：

| **字段名** | **类型**        | **说明**                                              | **示例值**                                    |
|------------|-----------------|-------------------------------------------------------|-----------------------------------------------|
| timestamp  | ISO 8601 string | 事件发生时间（UTC）                                   | 2025-01-15T08:23:01.412Z                      |
| level      | string          | 日志级别：trace / debug / info / warn / error / fatal | info                                          |
| module     | string          | 来源模块标识                                          | hub_core / interface / monitor / instance_mgr |
| trace_id   | string (UUID)   | 全链路追踪 ID，无法关联时填 null                      | a3f1c2d9-...                                  |
| thread_id  | string          | Agent 实例标识，无实例上下文时填 null                 | claude_01                                     |
| msg        | string          | 人类可读的事件描述                                    | HubMessage dispatched to agentapi             |

**2.2 各层扩展字段**

**Interface Layer（interface.log）**

| **扩展字段**   | **类型** | **说明**                                                  |
|----------------|----------|-----------------------------------------------------------|
| channel        | string   | 消息来源渠道，Phase 0 固定为 telegram                     |
| sender_id      | number   | Telegram User ID                                          |
| raw_message_id | number   | Telegram 原始消息 ID，用于回溯                            |
| intent         | string   | 解析出的意图：run / spawn / kill / status / attach / list |
| auth_result    | string   | 鉴权结果：allowed / denied（denied 时不生成 trace_id）    |

**Hub Core（hub.log）**

| **扩展字段**    | **类型** | **说明**                                            |
|-----------------|----------|-----------------------------------------------------|
| actor_id        | string   | 操作者身份，Phase 0 固定为 owner                    |
| target          | string   | 目标 Agent 标识，如 claude_01                       |
| agent_type      | string   | Agent 类型：claude / codex / gemini / cursor        |
| dispatch_status | string   | 分发状态：ok / failed / timeout                     |
| result_status   | string   | 结果状态：success / error / partial / timeout       |
| latency_ms      | number   | 从 HubMessage 生成到 HubResult 回传的总耗时（毫秒） |

**Instance Manager（instance.log）**

| **扩展字段** | **类型** | **说明**                                                    |
|--------------|----------|-------------------------------------------------------------|
| operation    | string   | 操作类型：spawn / kill / attach / detach / restart / status |
| mode         | string   | 实例模式：bridge / pane_bridge                              |
| pid          | number   | agentapi 子进程 PID                                         |
| socket_path  | string   | Unix socket 路径，如 /tmp/agentapi-claude_01.sock           |
| tmux_pane    | string   | pane_bridge 模式下的 tmux pane 标识（bridge 模式为 null）   |
| prev_status  | string   | 操作前的实例状态                                            |
| next_status  | string   | 操作后的实例状态                                            |

**Monitor Layer（monitor.log）**

| **扩展字段**        | **类型** | **说明**                                                                   |
|---------------------|----------|----------------------------------------------------------------------------|
| monitor_mode        | string   | 监测模式：sse_hook / heartbeat                                             |
| event_type          | string   | 事件类型：task_completed / status_changed / heartbeat_missed / agent_error |
| agent_status        | string   | Agent 当前状态：idle / running / waiting / stopped / error                 |
| missed_heartbeats   | number   | 连续丢失心跳次数（heartbeat 模式）                                         |
| sse_reconnect_count | number   | SSE 流重连次数（sse_hook 模式）                                            |

**3 Pino 配置与实现**

**3.1 共享 Logger 工厂**

所有模块应从同一工厂函数获取 logger 实例，避免配置分散：

> // src/logger.ts
>
> import pino from "pino";
>
> const BASE_CONFIG = {
>
> level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === "production"
> ? "info" : "debug"),
>
> timestamp: pino.stdTimeFunctions.isoTime,
>
> base: { service: "calling-hub" },
>
> };
>
> // 生产环境：JSON 输出到文件；开发环境：pino-pretty 美化终端输出
>
> const transport = process.env.NODE_ENV === "production"
>
> ? pino.transport({
>
> targets: \[
>
> { target: "pino/file", options: { destination: "/var/log/hub/hub.log"
> }, level: "info" },
>
> { target: "pino/file", options: { destination:
> "/var/log/hub/hub-error.log" }, level: "error" },
>
> \],
>
> })
>
> : pino.transport({ target: "pino-pretty", options: { colorize: true }
> });
>
> export const rootLogger = pino(BASE_CONFIG, transport);
>
> // 模块 Logger 工厂：注入 module 字段，可绑定 trace_id / thread_id
>
> export function createLogger(module: string, bindings: Record\<string,
> unknown\> = {}) {
>
> return rootLogger.child({ module, ...bindings });
>
> }

**3.2 trace_id 注入示例（Hub Core）**

> // 每条 HubMessage 处理时，创建绑定 trace_id 的子 logger
>
> const log = createLogger("hub_core").child({
>
> trace_id: hubMessage.trace_id,
>
> thread_id: hubMessage.thread_id,
>
> actor_id: hubMessage.actor_id,
>
> });
>
> log.info({ intent: hubMessage.intent, target: hubMessage.target },
> "HubMessage dispatched to agentapi");
>
> // → { "timestamp":"...", "level":"info", "module":"hub_core",
>
> // "trace_id":"a3f1c2d9-...", "thread_id":"claude_01",
>
> // "intent":"run", "target":"claude_01",
>
> // "msg":"HubMessage dispatched to agentapi" }

**3.3 各模块 Logger 初始化示例**

> // Interface Layer
>
> const ifLog = createLogger("interface");
>
> ifLog.info({ sender_id, raw_message_id, intent, auth_result: "allowed"
> }, "InboundUIEvent received");
>
> // Instance Manager
>
> const imLog = createLogger("instance_mgr");
>
> imLog.info({ operation:"spawn", mode, pid, socket_path, thread_id,
> next_status:"idle" }, "Agent instance spawned");
>
> // Monitor Layer
>
> const monLog = createLogger("monitor");
>
> monLog.warn({ event_type:"heartbeat_missed", thread_id,
> missed_heartbeats: 3 }, "Heartbeat threshold exceeded");

**4 日志文件策略**

**4.1 落盘路径与文件分配**

| **文件名**                            | **模块**             | **内容**                              | **级别过滤** |
|---------------------------------------|----------------------|---------------------------------------|--------------|
| /var/log/hub/interface.log            | Interface Layer      | Telegram 消息收发、鉴权、事件转换     | info+        |
| /var/log/hub/hub.log                  | Hub Core             | HubMessage 路由、分发、HubResult 回传 | info+        |
| /var/log/hub/hub-error.log            | Hub Core（错误副本） | 仅 error / fatal 级别，用于快速告警   | error+       |
| /var/log/hub/instance.log             | Instance Manager     | 实例生命周期操作审计，保留完整记录    | debug+       |
| /var/log/hub/monitor.log              | Monitor Layer        | SSE 事件、心跳、状态变化              | info+        |
| /var/log/hub/agentapi-{thread_id}.log | agentapi 子进程      | 重定向 agentapi stdout/stderr         | 全量（原始） |

**4.2 日志轮转（logrotate 配置示例）**

生产环境建议使用系统级 logrotate 处理轮转，避免 Pino
进程内轮转带来的复杂性：

> /var/log/hub/\*.log {
>
> daily \# 每日轮转
>
> rotate 30 \# 保留 30 天
>
> compress \# gzip 压缩旧日志
>
> delaycompress \# 最近一次不压缩（方便实时查看）
>
> missingok \# 文件不存在时不报错
>
> notifempty \# 空文件不轮转
>
> postrotate
>
> pm2 reload calling-hub --silent \# 轮转后通知进程重新打开文件句柄
>
> endscript
>
> }

**5 开发与生产环境差异**

| **维度**          | **开发环境（NODE_ENV=development）** | **生产环境（NODE_ENV=production）**     |
|-------------------|--------------------------------------|-----------------------------------------|
| 输出目标          | 终端（pino-pretty 美化格式）         | 文件（/var/log/hub/\*.log，JSON Lines） |
| 默认日志级别      | debug（含详细调试信息）              | info（过滤高频 debug 条目）             |
| 格式              | 彩色 · 人类可读 · 含换行             | JSON Lines · 无换行 · 机器可解析        |
| agentapi 进程输出 | 直接打印到终端，便于观察             | 重定向到 agentapi-{thread_id}.log       |
| pino-pretty 安装  | npm install --save-dev pino-pretty   | 不需要，仅安装 pino                     |
| 日志轮转          | 不需要                               | logrotate 或 Docker log driver          |
| trace_id 可见性   | 直接在终端每行可见                   | 需通过 jq / grep 查询                   |

**开发环境快速启动：** 需安装 pino-pretty，启动命令示例：

> NODE_ENV=development LOG_LEVEL=debug npx ts-node src/index.ts

**生产环境日志实时查看：** 使用 tail + jq 格式化：

> tail -f /var/log/hub/hub.log \| jq .

**6 排查手册：常用查询命令**

**6.1 按 trace_id 查全链路**

一条指令从 Telegram 入站到结果回传，涉及 interface.log → hub.log →
monitor.log 三个文件。通过 trace_id 跨文件联合查询：

> \# 查询单条指令的完整链路（所有日志文件）
>
> grep -h 'a3f1c2d9' /var/log/hub/\*.log \| jq -s
> 'sort_by(.timestamp)\[\]'
>
> \# 只看 Hub Core 的处理记录
>
> jq 'select(.trace_id == "a3f1c2d9-...")' /var/log/hub/hub.log

**6.2 按 thread_id 查实例历史**

> \# 查询 claude_01 实例的所有交互记录
>
> grep -h 'claude_01' /var/log/hub/\*.log \| jq -s
> 'sort_by(.timestamp)\[\]'
>
> \# 查看 claude_01 实例的生命周期操作
>
> jq 'select(.thread_id == "claude_01" and .module == "instance_mgr")'
> /var/log/hub/instance.log

**6.3 错误与告警快速定位**

> \# 查看所有 error 级别日志
>
> jq 'select(.level == "error")' /var/log/hub/hub-error.log
>
> \# 查看 Monitor 层触发的告警事件
>
> jq 'select(.event_type == "heartbeat_missed" or .event_type ==
> "agent_error")' /var/log/hub/monitor.log
>
> \# 查看最近 30 分钟内的所有 warn+ 事件
>
> jq 'select(.level == "warn" or .level == "error" or .level ==
> "fatal")' /var/log/hub/hub.log \\
>
> \| jq 'select(.timestamp \> "'\$(date -u -d '30 minutes ago'
> +%Y-%m-%dT%H:%M:%SZ)'")'

**6.4 agentapi 子进程排查**

> \# 查看特定实例的 agentapi 原始输出
>
> tail -200 /var/log/hub/agentapi-claude_01.log
>
> \# 实时跟踪某个实例的 agentapi 输出
>
> tail -f /var/log/hub/agentapi-claude_01.log

**6.5 性能分析：链路耗时**

> \# 计算各条指令的端到端耗时（latency_ms 字段）
>
> jq 'select(.latency_ms != null) \| {trace_id, thread_id, latency_ms}'
> /var/log/hub/hub.log \\
>
> \| jq -s 'sort_by(.latency_ms) \| reverse \| .\[0:10\]' \# 最慢 10 条

**7 Monitor 层事件与日志联动**

Monitor 层的每个告警事件在写入 monitor.log 的同时，也会通过 IPC 通知 Hub
Core，Hub Core 会触发 Telegram 告警消息。两者的关联通过 trace_id 保持：

| **Monitor 事件**                 | **monitor.log 级别** | **hub.log 动作**                         | **Telegram 告警**                            |
|----------------------------------|----------------------|------------------------------------------|----------------------------------------------|
| task_completed                   | info                 | 拉取结果，封装 HubResult，写 info 日志   | 无（正常结果回传）                           |
| status_changed                   | info                 | 更新注册表，写 info 日志                 | 无（静默更新）                               |
| heartbeat_missed（\< 阈值）      | warn                 | 累计记录，暂不干预                       | 无                                           |
| heartbeat_missed（≥ 阈值）       | error                | 标记实例 error，写 error 日志            | 发送 Telegram 告警                           |
| agent_error                      | error                | 标记实例 error，写 error 日志            | 发送 Telegram 告警，提示 /status 或 /restart |
| sse_reconnect_failed（连续失败） | fatal                | 切换为 heartbeat 兜底模式，写 fatal 日志 | 发送 Telegram 告警                           |

日志中的 Telegram 告警消息也会携带 trace_id，操作者收到告警后可直接用该
ID 查询详细日志，形成完整的「告警 → 查询 → 定位」闭环。

**8 Phase 0 交付检查项**

| **检查项**           | **验收标准**                                                                     | **状态** |
|----------------------|----------------------------------------------------------------------------------|----------|
| Pino logger 工厂     | src/logger.ts 可被所有模块 import，支持 child() 绑定字段                         | 待实现   |
| trace_id 全链路注入  | 一条完整指令的 trace_id 在 interface.log / hub.log / monitor.log 中均可检索到    | 待验证   |
| 实例生命周期审计     | 每次 spawn / kill / restart 均在 instance.log 中留有记录，含 pid 和 socket_path  | 待验证   |
| agentapi 日志重定向  | 每个 agentapi 子进程的 stdout/stderr 被捕获并写入对应的 agentapi-{thread_id}.log | 待实现   |
| 开发环境 pino-pretty | NODE_ENV=development 启动后终端输出彩色格式，含 trace_id 字段                    | 待实现   |
| error 日志副本       | hub-error.log 仅包含 error+ 级别，Pino transport 配置正确                        | 待实现   |
| Monitor 告警联动     | heartbeat_missed 达阈值时，monitor.log 写 error，同时触发 Telegram 告警消息      | 待验证   |
| trace_id 查询可用    | grep trace_id + jq 能跨文件还原单条指令的完整链路                                | 待验证   |

*--- Calling Hub · 日志记录规格说明 v1.0 · Phase 0 ---*
