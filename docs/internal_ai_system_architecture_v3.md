**内部 AI 系统架构**

V3 · 一人 AI 公司运营系统 · 含 CallHub + OpenClaw Session 集成规范

*2026-02 · 可直接进入开发*

**设计目标：**单人通过系统杠杆，驱动等效 100 ～ 1000
人规模的商业闭环。V3 在 V2 基础上补充了 CallHub 完整交互协议定义（Input
/ Output 结构体、会话协议、路由决策），以及 rdloop + OpenClaw Session
管理的端到端开发规范，可直接据此进入实现阶段。

**0 核心设计原则**

- ① 入口全部标准化：所有渠道事件统一转为 HubMessage，Hub
  不感知渠道细节。

- ② 权限集中外置：Hub 本身不维护权限逻辑，而是通过 Credential Layer
  取回权限后再决策路由和调用。

- ③ 全链路可追溯：trace_id 贯穿所有层次，事件可回放、可审计。

- ④ Agent 保持通用：OpenClaw 只处理「意图 +
  参数」，不感知渠道、权限、存储细节。

- ⑤ 记忆隔离：MemoryHub 按 namespace = actor_id
  强制隔离，不同身份不共享记忆分区。

- ⑥ LLM 分层调度：按任务阶段和风险/价值选择模型，压低 token 成本。

- ⑦ Session 可配置：rdloop 通过 TaskSpec.session_strategy
  按任务类型选择会话持久化策略，由 OpenClaw 统一承载。

**1 系统全景（分层架构）**

> ┌─────────────────────────────────────────────────────────────────┐
>
> │ 外部世界 / Internal Owner │
>
> │ Telegram · Slack · Nostr · Web · API Client · Partner │
>
> └──────────────────────┬──────────────────────────────────────────┘
>
> ↓ InboundUIEvent
>
> ┌─────────────────────────────────────────────────────────────────┐
>
> │ \[1\] Interface Layer （渠道适配，只收发，不做业务） │
>
> └──────────────────────┬──────────────────────────────────────────┘
>
> ↓ InboundUIEvent → HubMessage
>
> ┌─────────────────────────────────────────────────────────────────┐
>
> │ \[2\] CallHub （唯一控制平面） │
>
> │ │
>
> │ Standardize → Route → \[查 Credential Layer\] → Dispatch │
>
> │ Observability（trace / audit / retry / idempotency） │
>
> └────┬─────────────────────────────┬────────────────┬─────────────┘
>
> ↓ ↓ ↓
>
> ┌──────────────┐ ┌──────────────┐ ┌───────────────────┐
>
> │ \[3\] Agent │ │ \[4\] Service │ │ \[6\] Credential & │
>
> │ Layer │◄──►│ Layer │ │ Policy Layer │
>
> │ (OpenClaw) │ │ │ │ │
>
> │ · Planner │ │ rdloop │ │ Principal │
>
> │ · LLM Orch │ │ · git/patch │ │ Credential │
>
> │ · Tool Run │ │ · scripts │ │ Policy / Grant │
>
> │ · Mem Client │ │ · risk/data │ │ Permission Map │
>
> └──────┬───────┘ └──────┬───────┘ └───────────────────┘
>
> └──────────┬───────┘
>
> ↓ via MemoryHub
>
> ┌─────────────────────────────────────────────────────────────────┐
>
> │ \[5\] Memory Layer （MemoryHub + 分区存储 + GitOps） │
>
> │ namespace=actor_id 强制隔离 · 检索策略 · 权限过滤 │
>
> └─────────────────────────────────────────────────────────────────┘

**2 Interface Layer（渠道适配层）**

职责：只负责与外部渠道通信，不做任何业务判断。输出统一的
InboundUIEvent，交给 CallHub 处理。

| **渠道**            | **协议形式**             | **输出**       |
|---------------------|--------------------------|----------------|
| Telegram Bot        | Bot API / Webhook        | InboundUIEvent |
| Slack Bot           | Events API / Socket Mode | InboundUIEvent |
| Nostr Relay         | WebSocket / NIP-01       | InboundUIEvent |
| Web / App           | REST / WebSocket         | InboundUIEvent |
| External API Client | REST / Webhook           | InboundUIEvent |

**关键约束：**Slash 命令定义与路由规则不放在 OpenClaw，放在 Interface /
Hub 侧的 Command Registry。actor_id 在 Interface Layer 从 token /
bot_user / API Key 提取，随 InboundUIEvent 传递给 Hub。

**3 CallHub（唯一控制平面）· 完整交互协议**

CallHub 是整个系统唯一的流量控制点。所有事件都经过 Hub，Hub
不自持权限逻辑，而是主动向 Credential Layer
查询后再执行路由与分发。本节给出可直接开发的完整协议定义。

**3.1 Input：InboundUIEvent（渠道 → Hub）**

Interface Layer 适配各渠道后，向 Hub 投递标准化的
InboundUIEvent。字段定义如下：

> InboundUIEvent {
>
> event_id string // 全局唯一，由 Interface Layer 生成（UUID v4）
>
> received_at int64 // Unix timestamp ms，Interface Layer
> 收到原始消息时刻
>
> channel string // 来源渠道标识：telegram \| slack \| nostr \| web \|
> api
>
> channel_meta object // 渠道专属元数据（见 3.1.1）
>
> actor_id string // 发起方身份标识（从 token/bot_user 提取）
>
> raw_text string? // 原始文本（如有）
>
> attachments Attachment\[\] // 附件列表（文件/图片/URL），可为空
>
> reply_to string? // 如是回复，指向被回复的 event_id
>
> thread_id string? // 会话/线程 ID（渠道提供，如无则 null）
>
> }
>
> Attachment {
>
> type string // file \| image \| url \| audio
>
> url string // 资源地址
>
> mime_type string?
>
> size_bytes int64?
>
> }

**3.1.1 channel_meta 按渠道**

> // channel = "telegram"
>
> channel_meta {
>
> chat_id int64
>
> message_id int64
>
> chat_type string // private \| group \| supergroup \| channel
>
> username string?
>
> }
>
> // channel = "slack"
>
> channel_meta {
>
> team_id string
>
> channel_id string
>
> user_id string
>
> ts string // Slack message timestamp
>
> thread_ts string?
>
> }
>
> // channel = "api"
>
> channel_meta {
>
> api_key_id string
>
> client_ip string
>
> request_id string
>
> }

**3.2 内部结构：HubMessage（Hub 标准化后的消息体）**

Hub 将 InboundUIEvent 标准化为
HubMessage，携带全链路所需的所有字段，向下游分发。

> HubMessage {
>
> // ── 追踪 ──────────────────────────────────
>
> trace_id string // 全链路唯一 ID（UUID v4，Hub 生成）
>
> span_id string // 当前 span ID（可嵌套）
>
> parent_span_id string? // 父 span ID（用于 Agent 发起的子调用）
>
> event_id string // 原始 InboundUIEvent.event_id
>
> created_at int64 // Hub 生成此 message 的 Unix timestamp ms
>
> // ── 身份与权限 ──────────────────────────────
>
> actor_id string // 发起方身份（user / agent / service）
>
> permission_set PermissionSet? // Credential Layer 返回，Dispatch
> 前注入
>
> // ── 会话 ────────────────────────────────────
>
> thread_id string // 会话/线程 ID（渠道提供 or Hub 生成）
>
> session_id string? // OpenClaw Session ID（如路由至 Agent）
>
> // ── 意图与载荷 ──────────────────────────────
>
> intent string // 意图/命令名（如 "run_task", "/report"）
>
> payload object // 意图参数（结构由 intent 决定，见 3.2.1）
>
> // ── 回传 ────────────────────────────────────
>
> reply_channel ReplyChannel // 结果回传目标（见 3.2.2）
>
> // ── 元数据 ──────────────────────────────────
>
> source_channel string // 原始渠道（透传自 InboundUIEvent）
>
> channel_meta object // 透传自 InboundUIEvent.channel_meta
>
> priority int // 优先级 0-9（0 最高），默认 5
>
> idempotency_key string? // 幂等键（由调用方提供，Hub 去重）
>
> }

**3.2.1 payload 按 intent 的典型结构**

> // intent = "run_task"（rdloop 任务执行）
>
> payload {
>
> task_spec TaskSpec // 见 §5.4
>
> }
>
> // intent = "query"（普通问答）
>
> payload {
>
> text string
>
> context_hint string?
>
> }
>
> // intent = "service_callback"（Service 回调 Hub）
>
> payload {
>
> service_name string
>
> job_id string
>
> status string // success \| failure \| partial
>
> result object
>
> error string?
>
> }

**3.2.2 ReplyChannel**

> ReplyChannel {
>
> channel string // telegram \| slack \| nostr \| web \| api \| internal
>
> target_id string // chat_id / channel_id / session_id 等
>
> thread_id string? // 回复至特定 thread
>
> format string // text \| markdown \| json \| silent
>
> }

**3.3 Hub 处理流程（权限外置）**

> InboundUIEvent
>
> → \[STEP 1\] 标准化
>
> 生成 trace_id / span_id
>
> 解析 intent（从 raw_text 或 channel_meta 提取命令）
>
> 幂等检查（idempotency_key 去重）
>
> → HubMessage（permission_set = null）
>
> → \[STEP 2\] 查询 Credential Layer
>
> 携 actor_id → GET /credential/permission?actor_id=xxx
>
> ← PermissionSet
>
> 注入 HubMessage.permission_set
>
> → \[STEP 3\] AuthZ Gate
>
> DENY → 写 AuditLog（DENIED），返回错误 HubAction
>
> ALLOW → 继续
>
> → \[STEP 4\] 路由决策（见 3.4）
>
> 匹配 intent → 目标类型（Agent / Service / Memory）
>
> 确定 session_id（如路由至 Agent）
>
> → \[STEP 5\] Dispatch
>
> 向目标投递 HubMessage
>
> 写 ObservabilityEvent（DISPATCHED）
>
> → \[STEP 6\] 等待 HubAction / 异步回调
>
> 收到 HubAction → 路由至 ReplyChannel
>
> 写 ObservabilityEvent（COMPLETED / FAILED）

**3.4 路由决策规则**

| **路由方向**                | **触发条件**                         | **示例 intent**               |
|-----------------------------|--------------------------------------|-------------------------------|
| User → Agent (OpenClaw)     | intent 匹配 Agent 技能表             | run_task / query / generate   |
| Agent → Service (rdloop 等) | Agent Tool Runner 发起调用           | git_patch / run_test / report |
| Service → Hub (回调)        | Service 任务完成，POST /hub/callback | service_callback              |
| Hub → User (主动推送)       | Service 触发通知事件                 | notify / alert                |

**3.5 Output：HubAction（Hub → 渠道 / 调用方）**

所有对外输出均封装为 HubAction，由 Hub 路由至对应渠道。Agent / Service
不直接接触渠道协议。

> HubAction {
>
> // ── 追踪 ──────────────────────────────────
>
> trace_id string // 与入口 HubMessage 相同
>
> span_id string // 当前 span
>
> action_id string // 本次 Action 唯一 ID
>
> created_at int64 // Unix timestamp ms
>
> // ── 目标 ────────────────────────────────────
>
> reply_channel ReplyChannel // 目标渠道（透传或覆盖）
>
> // ── 内容 ────────────────────────────────────
>
> action_type string // reply \| push_notification \| store \| delegate
>
> content ActionContent
>
> // ── 状态 ────────────────────────────────────
>
> status string // success \| partial \| error \| pending
>
> error ActionError?
>
> }
>
> ActionContent {
>
> text string? // 文本回复
>
> markdown string? // Markdown 格式（渠道支持时优先）
>
> attachments Attachment\[\] // 附件
>
> metadata object? // 调用方专用结构化数据（如 tool_calls 结果）
>
> }
>
> ActionError {
>
> code string // AUTH_DENIED \| NOT_FOUND \| QUOTA_EXCEEDED \| INTERNAL
>
> message string // 面向用户的错误描述
>
> detail string? // 内部 debug 信息（不对外暴露）
>
> }

**3.6 ObservabilityEvent（全链路追踪写入格式）**

> ObservabilityEvent {
>
> trace_id string
>
> span_id string
>
> event_type string // RECEIVED \| STANDARDIZED \| AUTH_CHECKED \|
>
> // DISPATCHED \| COMPLETED \| FAILED \| RETRIED
>
> actor_id string
>
> intent string
>
> target string // 路由目标标识
>
> latency_ms int64 // 本 span 耗时
>
> status string // ok \| error
>
> error_code string?
>
> timestamp int64 // Unix ms
>
> }

**3.7 Hub 固定职责（不可下放）**

- Standardization（标准化）— 生成 trace_id，解析 intent，幂等去重

- Routing（路由）— 按 intent + PermissionSet 决策目标

- AuthZ Gate（门禁）— 结果来自 Credential Layer，Hub 不自维护权限

- Registry（技能/服务发现）— Agent 技能表、Service 端点表统一注册

- Observability（事件日志 / 审计 / 重试 / 幂等）— 写 ObservabilityEvent

**4 Agent Layer（OpenClaw · 通用 Agent Runtime）**

OpenClaw 是纯粹的 Agent
运行时，不感知渠道协议、权限细节和存储结构。所有外部交互均通过 Hub。

**4.1 OpenClaw API 端点规范**

OpenClaw 以 HTTP 服务形式运行，默认端口 8000。Hub 通过以下端点与其交互。

**4.1.1 POST /v1/rdloop/turn（执行一轮 Agent 对话）**

Request Body：

> {
>
> "session_id": "task_fix_memory_leak_001", // 任务级唯一标识
>
> "role": "coder", // coder \| judge
>
> "turn": 2, // 当前轮次（1-based）
>
> "instruction": "修复 utils.js 中的内存泄漏", // 本轮主指令
>
> "context": {
>
> "prev_verdict": { ... }, // 上一轮 Judge 裁决（可选）
>
> "test_log": "...last 200 lines...", // 上一轮测试日志末尾
>
> "diff_stat": "utils.js \| 3 +++", // git diff --stat
>
> "full_history": \[ ... \] // 可选，全轮历史摘要
>
> },
>
> "session_mode": "persistent", // persistent \| per_attempt \| none
>
> "model": "claude-sonnet-4-5",
>
> "max_tokens": 4096,
>
> "tools": \["edit_file", "bash", "read_file"\]
>
> }

Response Body：

> {
>
> "response": "I'll fix the bug by modifying line 42...",
>
> "tool_calls": \[
>
> {
>
> "type": "edit_file",
>
> "path": "utils.js",
>
> "old_str": "if (x \>= 10)",
>
> "new_str": "if (x \> 10)"
>
> }
>
> \],
>
> "tokens": {
>
> "prompt": 5000,
>
> "completion": 1000,
>
> "total": 6000
>
> },
>
> "cost_usd": 0.05,
>
> "model_used": "claude-sonnet-4-5",
>
> "session_id": "task_fix_memory_leak_001"
>
> }

**4.1.2 GET /v1/session/{session_id}（查询 Session 状态）**

> // Response
>
> {
>
> "session_id": "task_fix_memory_leak_001",
>
> "session_mode": "persistent",
>
> "turn_count": 3,
>
> "token_total": 18000,
>
> "created_at": 1740182122000,
>
> "last_active": 1740183000000,
>
> "messages": \[ ... \] // 完整 messages 数组
>
> }

**4.1.3 DELETE /v1/session/{session_id}（销毁 Session）**

> // Response
>
> {
>
> "session_id": "task_fix_memory_leak_001",
>
> "deleted": true
>
> }

**4.2 OpenClaw Input（从 Hub 接收的 HubMessage 子集）**

OpenClaw 接收 Hub Dispatch 过来的 HubMessage，提取以下字段用于 Agent
执行：

| **字段**          | **类型**      | **说明**                          |
|-------------------|---------------|-----------------------------------|
| trace_id          | string        | 全链路追踪，记录在每个 span       |
| session_id        | string?       | Hub 确定后注入，openClaw 直接使用 |
| intent            | string        | 任务类型，对应 Planner 入口       |
| payload.task_spec | TaskSpec      | 完整任务描述，见 §5.4             |
| permission_set    | PermissionSet | 可调用的工具/服务范围             |
| reply_channel     | ReplyChannel  | 执行完成后回传目标                |

**4.3 OpenClaw Output（HubAction 格式）**

OpenClaw 完成后向 Hub 提交 HubAction，Hub 负责路由至渠道。不允许
OpenClaw 直接访问渠道 API。

> HubAction {
>
> trace_id: \<透传\>
>
> action_type: "reply",
>
> reply_channel: \<透传自 HubMessage\>
>
> content: {
>
> text: "任务执行完成，已修复 utils.js 第 42 行...",
>
> metadata: {
>
> tool_calls: \[ ... \],
>
> tokens: { prompt: 5000, completion: 1000 },
>
> cost_usd: 0.05,
>
> session_id: "task_fix_memory_leak_001"
>
> }
>
> },
>
> status: "success"
>
> }

**4.4 四个固定内部模块**

| **模块**            | **职责**                                                     |
|---------------------|--------------------------------------------------------------|
| Planner             | 拆解任务，制定执行步骤；入口依据 intent 路由至对应 Plan      |
| LLM Orchestrator    | 多级模型调度，按阶段选择 L0–L3；管理 token budget            |
| Tool / Skill Runner | 通过 Hub Registry 调用注册的外部能力（rdloop / git 等）      |
| Memory Client       | 只通过 MemoryHub 读写，不直连底层存储；namespace 由 Hub 注入 |

**5 rdloop Service Layer · Session 管理与研发闭环集成**

rdloop 是面向研发闭环的 Service Layer，通过 Coder/Judge
双角色迭代驱动任务自动完成。V3 新增可配置 Session 策略，由 OpenClaw
统一承载 Session 管理。

**5.1 核心问题与设计目标**

**核心问题：**

- Coder 在 Attempt N 修改了文件 A，但在 Attempt N+1
  中不记得，导致重复劳动或回退

- Judge 每轮独立评判，无法感知"之前尝试过什么、为什么失败"

- 不同任务类型（Coding、剧本、需求、文案）对 Session 的需求存在本质差异

**设计目标：**

- 为 rdloop 引入可配置的 Session 策略，按任务类型灵活选择

- 以 OpenClaw 作为 Agent Layer，统一承载 Session 管理与 AI 调用

- rdloop 专注流程控制（状态机、证据链、worktree），不直接调用 Model API

- 两者职责清晰分离，符合整体架构分层规范

**5.2 分层调用链路**

> rdloop (Service Layer)
>
> └─ 流程控制：状态机 / 证据链 / worktree / 测试执行
>
> └─ 调用 OpenClaw API (POST /v1/rdloop/turn)
>
> └─ OpenClaw (Agent Layer)
>
> └─ Session 管理 / LLM 调用 / Tool Runner
>
> └─ 通过 Hub → git / bash / 其他 Service
>
> // rdloop 不直接调用 Model API
>
> // 所有 AI 交互均通过 OpenClaw 完成

多任务并发：每个任务对应独立 OpenClaw
实例（通过不同端口或命名空间实现隔离），并发执行互不干扰。

**5.3 三种 Session 策略**

| **策略**    | **行为**                                                                                                             | **适用任务**             | **优缺点**                       |
|-------------|----------------------------------------------------------------------------------------------------------------------|--------------------------|----------------------------------|
| persistent  | 整个任务共享同一 session_id，所有 turn 消息累积，Coder/Judge 均可感知完整历史                                        | Coding（必需）、长篇剧本 | 上下文完整；超 100k token 需截断 |
| per_attempt | 每个 Attempt 新建独立 session；上一轮关键信息（verdict/test_log/diff_stat）通过 context 字段传入，构建伪历史注入当轮 | 需求撰写（各章节独立）   | 无超限风险；历史传递有损         |
| none        | 每次调用无 session；仅依赖 instruction 中夹带的文本上下文                                                            | 文案润色、简单格式转换   | 最省 token；无历史感知           |

**5.3.1 Session 策略决策优先级**

当多个字段同时存在时，优先级从高到低：

1.  1\. coder_session_strategy /
    judge_session_strategy（最高，细粒度覆盖）

2.  2\. session_strategy（全局策略）

3.  3\. task_type 对应的预设模板（最低，兜底默认值）

**5.4 TaskSpec 规范（V3 更新版）**

rdloop 通过 TaskSpec 描述一个任务，包含任务类型、Session
策略、执行配置。

> TaskSpec {
>
> // ── 基础 ─────────────────────────────────────
>
> "task_id": string, // 全局唯一，格式：{type}\_{slug}\_{seq}
>
> "task_type": string, // coding \| screenplay \| requirements \|
> copywriting \| custom
>
> "goal": string, // 任务描述（自然语言）
>
> "acceptance": string?, // 验收标准
>
> "test_cmd": string?, // 测试命令（coding 任务必填）
>
> // ── Session 策略（V3 新增）─────────────────────
>
> "session_strategy": string?, // persistent \| per_attempt \| none
>
> // 不填则由 task_type 预设模板决定
>
> "coder_session_strategy": string?, // 细粒度覆盖 Coder 的策略
>
> "judge_session_strategy": string?, // 细粒度覆盖 Judge 的策略
>
> // ── 执行器配置 ──────────────────────────────────
>
> "coder": string, // openclaw \| cursor_cli \| mock
>
> "judge": string, // openclaw \| codex_cli \| mock
>
> "openclaw_endpoint": string, // 默认 http://localhost:8000
>
> "coder_model": string, // 默认 claude-sonnet-4-5
>
> "judge_model": string, // 默认 claude-sonnet-4-5
>
> // ── 测试 ────────────────────────────────────────
>
> "test_required": boolean, // 默认 true（coding），其余默认 false
>
> }

**5.4.1 任务类型预设模板**

| **task_type** | **session_strategy (全局)**              | **coder** | **judge** | **备注**                   |
|---------------|------------------------------------------|-----------|-----------|----------------------------|
| coding        | persistent                               | openclaw  | openclaw  | Coder/Judge 均保留完整历史 |
| screenplay    | persistent (coder) / per_attempt (judge) | openclaw  | openclaw  | Judge 每轮独立评价         |
| requirements  | per_attempt                              | openclaw  | openclaw  | 各章节独立，避免混淆       |
| copywriting   | none                                     | openclaw  | openclaw  | 省 token，通常 1-2 轮完成  |

**5.5 Attempt 上下文传递规范**

per_attempt 模式下，rdloop 在调用 POST /v1/rdloop/turn 时，通过 context
字段传递跨轮信息。各字段规范如下：

| **字段**     | **类型**    | **来源**         | **说明**                              |
|--------------|-------------|------------------|---------------------------------------|
| prev_verdict | object?     | Judge 上一轮输出 | 包含 pass/fail、critique 文本         |
| test_log     | string?     | 测试执行结果     | 截取末尾 200 行，避免超限             |
| diff_stat    | string?     | git diff --stat  | 本次改动摘要                          |
| full_history | object\[\]? | rdloop 维护      | 可选，各轮摘要，persistent 模式不需要 |

**5.6 Session 持久化（OpenClaw 内部实现规范）**

- persistent 模式：在内存中维护 messages 数组，同步写入磁盘

- 磁盘路径：~/.openclaw/sessions/\<session_id\>.json

- 文件格式：{ "session_id", "session_mode", "turn_count", "messages":
  \[...\], "created_at", "last_active" }

- 重启后可从文件恢复 Session，无需重新拉取历史

**5.7 截断策略（超 100k token 时触发）**

**触发条件：**messages 累计 token 超过 100k 时，OpenClaw
触发截断，防止超出模型上下文窗口。

**实现方案（Phase 1）：**保留最近 N 条 messages（确保不超 80k
token），在 messages 头部插入一条 system message 摘要历史要点。Phase 2
可接入 MemoryHub 做结构化存档。

**5.8 兼容模式（coder = cursor_cli）**

当 coder = cursor_cli 时，无法使用 OpenClaw Session，rdloop
自动降级为「context 夹带」策略（等同于 per_attempt 模式）：在
instruction 头部拼接上一轮 verdict 的摘要。此为过渡兜底方案，不推荐用于
coding 任务。

**5.9 rdloop 调用 OpenClaw 的完整流程**

> func call_coder(task: TaskSpec, attempt: int, ctx: AttemptContext):
>
> // 1. 确定 session_id
>
> strategy = resolve_strategy(task, role="coder")
>
> if strategy == "persistent":
>
> session_id = task.task_id
>
> elif strategy == "per_attempt":
>
> session_id = task.task_id + "\_att" + attempt
>
> else: // none
>
> session_id = task.task_id + "\_" + timestamp()
>
> // 2. 构建 request
>
> req = {
>
> session_id: session_id,
>
> role: "coder",
>
> turn: attempt,
>
> instruction: task.goal,
>
> context: ctx, // prev_verdict, test_log, diff_stat
>
> session_mode: strategy,
>
> model: task.coder_model,
>
> max_tokens: 4096,
>
> tools: \["edit_file", "bash", "read_file"\]
>
> }
>
> // 3. 调用 OpenClaw
>
> resp = POST task.openclaw_endpoint + "/v1/rdloop/turn", req
>
> // 4. 在 worktree 中执行 tool_calls
>
> for tc in resp.tool_calls:
>
> execute_in_worktree(tc)
>
> // 5. 记录 metrics
>
> log_metrics(attempt_dir, resp.tokens, resp.cost_usd, resp.tool_calls)
>
> return resp

**5.10 使用示例（TaskSpec JSON）**

**示例 A：Coding 任务**

> {
>
> "task_id": "fix_memory_leak_001",
>
> "task_type": "coding",
>
> "goal": "修复 utils.js 中的内存泄漏，使 npm test 全部通过",
>
> "test_cmd": "npm test",
>
> "coder": "openclaw",
>
> "judge": "openclaw",
>
> "openclaw_endpoint": "http://localhost:8000"
>
> // session_strategy 不填，自动继承 coding 预设：persistent
>
> }

**示例 B：剧本撰写任务**

> {
>
> "task_id": "screenplay_scifi_001",
>
> "task_type": "screenplay",
>
> "goal": "写一个 15 分钟的科幻短剧，主题：AI 觉醒",
>
> "acceptance": "剧情连贯，角色鲜明，有冲突有反转",
>
> "coder": "openclaw",
>
> "judge": "openclaw",
>
> "coder_session_strategy": "persistent", // 保留世界观设定
>
> "judge_session_strategy": "per_attempt" // 每轮独立评价
>
> }

**示例 C：文案润色任务（覆盖预设）**

> {
>
> "task_id": "polish_product_copy_001",
>
> "task_type": "copywriting",
>
> "goal": "润色产品介绍文案，简洁有力，无语病",
>
> "session_strategy": "per_attempt", // 覆盖 copywriting 默认的 none
>
> "coder": "openclaw",
>
> "judge": "openclaw"
>
> }

**6 Credential & Policy Layer（身份 · 密钥 · 授权）**

**6.1 核心对象**

| **对象**       | **说明**                                                    |
|----------------|-------------------------------------------------------------|
| Principal      | 任何发起动作的实体：user / agent / service / partner        |
| Credential     | 身份凭证（API Key / Token / 证书）                          |
| Policy / Grant | 权限规则，定义 Principal 可调用的服务、agent、memory 范围   |
| PermissionSet  | Principal → 权限集合的运行时快照，Hub 查询后注入 HubMessage |

**6.2 PermissionSet 结构**

> PermissionSet {
>
> actor_id string
>
> principal_type string // owner \| internal_agent \| external_client \|
> partner \| public
>
> allowed_intents string\[\] // 允许的 intent 列表（"\*" 表示全部）
>
> allowed_services string\[\] // 允许调用的 Service
>
> allowed_tools string\[\] // 允许使用的 Tool
>
> memory_namespaces string\[\] // 可读写的 memory namespace
>
> rate_limit RateLimit? // 调用频率限制
>
> expires_at int64? // Unix ms，null 表示永不过期
>
> }

**6.3 权限流**

> Interface Layer 识别 actor_id（从 token / bot_user / API Key）
>
> → Hub 携 actor_id 查询 Credential Layer
>
> GET /credential/permission?actor_id=xxx
>
> ← Credential Layer 返回 PermissionSet
>
> → Hub 执行 AuthZ Gate
>
> DENY → 拒绝请求，写 AuditLog
>
> ALLOW → PermissionSet 注入 HubMessage，Dispatch
>
> → Agent / Service 收到的 HubMessage 已内含权限范围
>
> → MemoryHub 从 HubMessage 提取 namespace 做隔离注入

关键约束：Agent 不持有高权限 Service Key；所有密钥只存在于 Credential
Layer，运行时通过授权调用获取，不在 Agent 层流动。

**7 Memory Layer（MemoryHub + 分区存储 + GitOps）**

**7.1 MemoryHub 接口**

> // 所有记忆读写必须经过 MemoryHub，任何层次不得直连底层存储
>
> MemoryReadRequest { namespace: actor_id, query: string, strategy:
> string }
>
> MemoryWriteRequest { namespace: actor_id, content: object, trace_id:
> string }
>
> // Hub 在 Dispatch 时强制注入 namespace = actor_id
>
> // Agent 无法指定 namespace，只能收到自己身份范围内的记忆

**7.2 记忆分区**

| **分区**            | **内容**                | **存储策略**         | **命名空间归属**   |
|---------------------|-------------------------|----------------------|--------------------|
| Conversation Memory | Thread 短期对话上下文   | TTL 自动过期         | per actor_id       |
| Operational Memory  | 执行事实 / 证据 / 账本  | Append-only 日志     | per actor_id       |
| Long-term Knowledge | 规范 / 模板 / 规则      | GitOps（可 diff/PR） | Owner 全局 or 共享 |
| Shared Memory       | Team / Project 共享共识 | GitOps（可 PR 审阅） | 按 project_id 隔离 |

**8 LLM 分层调度（LLM Orchestrator）**

**8.1 模型层级**

| **级别**    | **定位**                              | **典型用途**                       |
|-------------|---------------------------------------|------------------------------------|
| L0 Dumb     | 分类 / 解析 / 提取 / 改写（极低成本） | 入口意图解析、参数校验、模板填充   |
| L1 Mid      | 轻量推理 / 一般规划                   | 执行步骤的小任务、总结归档         |
| L2 Smart    | 复杂规划 / 高风险决策                 | 任务拆解、关键输出、发布前最终决策 |
| L3 Verified | 自检 / 多样本 / 一致性投票            | 高风险操作、需要一致性保证的阶段   |

**8.2 同一任务的分段调度策略**

| **阶段**                                 | **推荐级别**     |
|------------------------------------------|------------------|
| 入口解析 / 参数校验                      | L0 / L1          |
| 任务拆解与计划                           | L2               |
| 执行中小步骤（填表 / 生成命令 / 模板化） | L0 / L1          |
| 合并 / 发布 / 高风险操作前最终决策       | L2 / L3          |
| 总结归档进 Long-term / Shared Memory     | L1（+ 规则约束） |

成本控制：把大部分 token 消耗的执行型文本工作压到
L0/L1，把少量关键决策留给 L2/L3。在 LLM Orchestrator 中按 trace_id 做
cost attribution，识别高成本任务并持续优化调度策略。

**9 完整数据流（端到端）**

> ① 外部触发
>
> 用户 / 客户 / 合作方 → 渠道（Telegram / Slack / API）
>
> ② Interface Layer
>
> 渠道事件 → InboundUIEvent（含 actor_id, channel_meta）
>
> ③ CallHub：标准化
>
> InboundUIEvent → HubMessage（生成 trace_id / span_id / intent）
>
> 幂等检查（idempotency_key）
>
> ④ CallHub：权限查询
>
> Hub 携 actor_id → Credential Layer
>
> Credential Layer → PermissionSet
>
> 注入 HubMessage.permission_set
>
> ⑤ CallHub：门禁与路由
>
> DENY → 拒绝 + AuditLog，返回错误 HubAction
>
> ALLOW → HubMessage 附加 PermissionSet，Dispatch 至目标
>
> ⑥ Agent / Service 执行
>
> OpenClaw POST /v1/rdloop/turn 接收 HubMessage 子集
>
> Planner 拆解 → LLM Orchestrator 选模型 → Tool Runner 调服务
>
> rdloop 在 worktree 执行 tool_calls → 运行测试
>
> 所有对外调用仍经 Hub（可审计）
>
> ⑦ Memory 读写
>
> Agent Memory Client → MemoryHub
>
> MemoryHub 注入 namespace=actor_id → 分区存储
>
> ⑧ 回传
>
> OpenClaw → HubAction → Hub → Interface Layer → 渠道 → 用户
>
> ⑨ 全程
>
> trace_id 贯穿，写入 ObservabilityEvent（日志 / 审计 / 重试 / 幂等）

**10 实现阶段规划**

架构分层完整，建议按以下顺序逐步建设，确保每一步都能跑通真实业务闭环：

| **阶段**         | **目标**                      | **重点建设**                                                                                                     |
|------------------|-------------------------------|------------------------------------------------------------------------------------------------------------------|
| Phase 1 （当前） | 第一个收入闭环 + Session 基础 | Interface → Hub（基础路由）→ OpenClaw（/v1/rdloop/turn）→ rdloop coding persistent session → Conversation Memory |
| Phase 2          | 权限与隔离                    | Credential Layer + MemoryHub namespace 隔离 + 外部客户接入 + PermissionSet 全流程                                |
| Phase 3          | 记忆沉淀 + Session 截断       | Operational Memory + Long-term GitOps + Memory decay 策略 + 100k token 截断方案                                  |
| Phase 4          | 成本优化                      | LLM 分层完善 + cost attribution + L0/L1 覆盖率提升 + Session token budget 管控                                   |
| Phase 5          | 全链路可观测                  | 完整 trace / audit / replay + ObservabilityEvent 完整写入 + 异步任务默认化                                       |

*— 定稿存档，按此方向逐步迭代 —*
