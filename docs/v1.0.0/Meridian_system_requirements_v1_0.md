# Calling Hub

系统需求说明文档 v1.0

远程离岸工作调度系统 · ai_arch_v2 体系 Calling Hub 雏形

关联文档：附件 A（接入规格）· 架构示意图

## 0. 文档说明

| 属性 | 内容 |
|---|---|
| 版本 | v1.0（根据架构讨论与 IPC 修正更新，替代初版草稿） |
| 关联文档 | 附件 A — Phase 0 接入规格（Telegram Bot + CLI Coding Agents） |
| 关联文档 | 架构示意图（交互式 React 组件） |
| 范围 | Phase 0：Telegram Bot 渠道 + CLI Coding Agents（Claude Code / Codex / Gemini / Cursor CLI） |
| 不包含 | Cursor GUI、Antigravity GUI（无程序化 API，不纳入当前阶段） |
| 架构基础 | ai_arch_v2.docx — CallHub 雏形，对应 Interface Layer + CallHub 最小可用形态 |

## 1. 背景与定位

Calling Hub 是一个远程离岸工作调度系统，服务于以下核心场景：

让人类操作者无论身处何地，都能通过 Telegram 向指定的 AI Coding Agent 下发指令，并接收工作结果。操作者不需要守在任何特定界面前。

这是 ai_arch_v2 整体架构中「唯一控制平面」（CallHub）的 Phase 0 实现。当前阶段的边界是：一个人类操作者，通过 Telegram Bot，指挥运行在宿主机上的多个 CLI Coding Agent 实例，完成远程编码任务的派发与结果回收。

### 与 ai_arch_v2 的对应关系

| 层级 | 说明 |
|---|---|
| Interface Layer | Telegram Bot 渠道适配（grammY） |
| CallHub | Calling Hub Core + 实例管理器 |
| Agent Layer（预留） | 通过 agentapi 包装 CLI，协议边界已定义，内部不展开 |
| Memory / Credential Layer | Phase 0 不实现，预留接口 |

## 2. 核心设计原则

| 原则 | 含义 |
|---|---|
| 低耦合 · 开放协议 | 输入端（Telegram Bot）与输出端（各 CLI Agent）均通过固定协议接入，Hub 不感知渠道细节，也不感知 Agent 内部实现，任何一端可独立替换或扩展。 |
| IPC 内部连接 | Hub 与各服务模块之间（agentapi 实例、Monitor 层）采用 Unix Domain Socket（IPC）通信，不走 TCP 网络栈，保持持久稳定连接，性能优于 TCP localhost 20–40%。 |
| 单一控制平面 | 所有指令必须经过 Hub，不允许渠道直连 Agent。Hub 是唯一调度节点。 |
| 双模式 Agent 控制 | 每个 Agent 实例支持 Bridge 模式（纯后台 pty，完全程序化）和 Pane Bridge 模式（pty attach 到 tmux pane，操作者可旁观或介入），spawn 时选择模式，协议层不变。 |
| 全链路可追溯 | 每条指令从进入到结果回传，全程携带 trace_id，可查询、可审计。 |
| 监测层独立 | Monitor 模块不参与主流程，通过 IPC 向 Hub 上报状态变化事件，低耦合、可独立扩展。 |
| 实例生命周期可控 | 操作者通过 Slash 命令拉起、关闭、切换 Agent 实例，系统提供统一的实例管理能力。 |

## 3. 系统边界（Phase 0 范围）

### 3.1 在范围内

- Telegram Bot 渠道接入（grammY 库，Long Polling / Webhook）
- 指令标准化：InboundUIEvent → HubMessage
- CLI Coding Agent 控制：Claude Code CLI · Codex CLI · Gemini CLI · Cursor CLI
- 两种 Agent 控制模式：Bridge（无界面后台 pty）· Pane Bridge（tmux pane 可视）
- agentapi 作为 Agent 控制层底座（github.com/coder/agentapi，MIT 许可）
- IPC 内部通信：Hub ↔ agentapi 实例（Unix Domain Socket）
- Slash 命令解析：/spawn /kill /status /attach /list /help
- 多模态输入：文本 + 图片 + 文件随指令传递
- 实例生命周期管理：spawn / kill / attach / detach / status / list / restart
- 独立监测层：Heartbeat 轮询 + SSE Hook 回调两种模式
- 结果回传：HubResult 原路回传至 Telegram 操作者
- 全链路可观测：结构化日志 + trace_id 查询

### 3.2 Phase 0 明确不包含

- Cursor GUI 和 Antigravity GUI（无程序化 API，不纳入 Phase 0）
- Email / Nostr / WhatsApp 渠道（Phase 1 扩展）
- Credential Layer / 多用户权限隔离（Phase 1 接入）
- Memory Layer（Phase 2 接入）
- LLM 分层调度（Phase 3 接入）
- 多操作者支持（Phase 0 仅支持单一 Owner 身份）

## 4. 通信协议架构

系统内部与外部使用不同通信协议，分层清晰：

| 通信段 | 协议 | 方向 | 说明 |
|---|---|---|---|
| 操作者 ↔ Telegram | HTTPS | 双向 | 经 Telegram 服务器，标准 Bot API |
| Telegram ↔ Hub Interface Layer | HTTPS (Webhook) / Long Polling | 入站 | 开发用 Long Polling，生产切 Webhook |
| Interface Layer → Hub Core | Unix Domain Socket（IPC） | 单向 | 同宿主机进程间通信，HubMessage JSON |
| Hub Core ↔ agentapi 实例 | HTTP over Unix Socket（IPC） | 双向 | POST /message · GET /status · GET /events (SSE) |
| Hub Core ↔ Monitor 层 | Unix Domain Socket（IPC） | 双向 | Monitor 上报事件，Hub 回传指令 |
| Hub Core → Telegram 回传 | HTTPS | 出站 | HubResult → Telegram Bot API → 操作者 |

### 为什么内部用 IPC（Unix Socket）而非 TCP

- 连接持久稳定：Unix socket 是持久文件描述符，不像 TCP 有握手开销
- 性能更优：无需经过系统网络栈，延迟比 TCP localhost 低 20–40%
- 不占用端口：不与宿主机其他服务产生端口冲突
- 与 ai_arch_v2 约定一致：系统间服务层通过 IPC 方式接入

## 5. 渠道接入层（Interface Layer）

Phase 0 只有一个渠道：Telegram Bot。接入层职责仅限收发，不做业务判断。

### 5.1 Telegram Bot 接入

| 属性 | 选型 / 规格 |
|---|---|
| 开发库 | grammY v2.x（TypeScript，MIT，生产可用） |
| 消息接收方式 | 开发阶段：Long Polling；生产：Webhook HTTPS |
| 鉴权 | Bot Token 白名单 + 操作者 User ID 过滤（单 Owner） |
| Slash 命令注册 | 通过 @BotFather 注册，客户端显示补全提示 |

### 5.2 标准事件格式（InboundUIEvent）

```text
channel         // 来源渠道（telegram）
raw_message_id  // Telegram 原始消息 ID
sender_id       // 操作者 Telegram User ID
content         // 消息正文
attachments[]   // 图片 / 文件 / 附件列表
timestamp       // 消息时间
reply_to        // 回复目标消息 ID（用于指定 thread_id）
```

### 5.3 多模态支持

| 消息类型 | Telegram 类型 | Hub 处理 |
|---|---|---|
| 纯文本 | text | 直接作为 payload.content |
| 图片 | photo | 下载到临时存储，payload.attachments[] |
| 文件 / 文档 | document | 同上，保留文件名和 MIME 类型 |
| Slash 命令 | /spawn 等 | 优先解析为结构化 intent |
| 回复消息 | reply_to_message | 用于绑定已有 thread_id |

## 6. Calling Hub Core

Hub 是系统的唯一调度中枢，接收 InboundUIEvent，完成标准化、路由、分发，并将结果回传。

### 6.1 标准指令格式（HubMessage）

```text
trace_id        // 全链路唯一追踪 ID（系统生成）
thread_id       // Agent 实例标识（spawn 时分配）
actor_id        // 操作者身份（Phase 0 固定为 owner）
intent          // 意图：run / spawn / kill / status / attach / list
target          // 目标 Agent 标识（如 claude_01 / codex_02）
payload         // 指令内容 + 附件引用
mode            // bridge | pane_bridge（spawn 时指定）
reply_channel   // 回传渠道与地址
```

### 6.2 Hub 处理流程

1. InboundUIEvent 进入 Interface Layer，转为标准格式
2. 通过 Unix socket 发往 Hub Core
3. Hub 解析 intent，查询实例管理器获取 target 的 agentapi socket 路径
4. 通过对应 Unix socket 调用 agentapi：POST /message
5. Monitor 层持续监听该实例的 SSE 事件流（GET /events）
6. 任务完成或状态变化时，Monitor 通过 IPC 通知 Hub
7. Hub 将 HubResult 回传至 Interface Layer，再推送到 Telegram
8. 全程写入 Pino 结构化日志，携带 trace_id

### 6.3 Slash 命令集

| 命令 | 格式示例 | 说明 |
|---|---|---|
| /spawn | /spawn type=claude mode=bridge | 拉起新 Agent 实例，返回 thread_id；mode 可选 bridge 或 pane_bridge |
| /spawn | /spawn type=codex mode=pane_bridge | Pane Bridge 模式：pty attach 到 tmux pane，操作者可在终端旁观 |
| /kill | /kill thread=claude_01 | 关闭并销毁指定实例 |
| /attach | /attach thread=claude_01 | 将当前会话绑定到已有实例 |
| /status | /status thread=claude_01 | 查询实例当前状态（idle / running / waiting / error） |
| /list | /list | 列出所有活跃实例及其状态 |
| /help | /help | 显示命令帮助 |
| 自由文本 | 重构 src/index.ts | 在当前绑定实例上执行，作为 payload 透传 |

## 7. Agent 控制模式详解

Phase 0 支持两种 Agent 控制模式，通过 agentapi（github.com/coder/agentapi）统一实现，协议层对 Hub 完全透明。

| 模式 | 机制 | 适用场景 | 操作者可见性 | spawn 参数 |
|---|---|---|---|---|
| Bridge 模式 | agentapi server 在后台 pty 运行，Agent 无可视界面 | 完全无人值守的自动化任务 | 不可见终端输出，仅通过 Telegram 收结果 | mode=bridge |
| Pane Bridge 模式 | pty attach 到 tmux session 的指定 pane，同时 Hub 写入指令 | 操作者需要实时监控或随时介入的任务 | 可在 SSH 终端的 tmux pane 中实时查看 Agent 执行 | mode=pane_bridge |

关键设计：两种模式共用同一套 agentapi 接口（POST /message · GET /status · GET /events）。Hub 侧无需区分模式，路由逻辑完全一致。切换模式只需在 /spawn 时指定 mode 参数，实例管理器负责选择是否 attach tmux pane。

## 8. 实例管理（Instance Manager）

实例管理器是 Hub Core 的内置子模块，维护所有 agentapi 子进程的生命周期，并通过 Unix socket 路由表将 thread_id 映射到对应的 agentapi socket 路径。

### 8.1 实例状态模型

| 状态 | 含义 |
|---|---|
| idle | 实例已注册，未接收任务 |
| running | 实例正在执行任务 |
| waiting | 实例已完成，等待下一条指令 |
| stopped | 实例已关闭，不可接收新指令 |
| error | 实例报错，需人工干预 |

### 8.2 实例注册表结构

```ts
AgentInstance {
  thread_id   // 唯一标识，如 claude_01
  agent_type  // claude | codex | gemini | cursor
  mode        // bridge | pane_bridge
  socket_path // Unix socket 路径，如 /tmp/agentapi-claude_01.sock
  pid         // agentapi 进程 PID
  tmux_pane   // pane_bridge 模式下的 tmux pane 标识
  status      // 当前状态
  created_at  // 创建时间
}
```

### 8.3 生命周期操作

| 操作 | 说明 |
|---|---|
| spawn | fork agentapi 子进程，绑定 Unix socket，注册到注册表，返回 thread_id |
| kill | 向 agentapi 进程发 SIGTERM，清理 socket 文件，从注册表移除 |
| attach | 将当前 Telegram 会话的默认 thread_id 切换到指定实例 |
| detach | 解除绑定，不关闭实例 |
| restart | kill + spawn，保持 thread_id 不变 |
| status | 读取注册表 + 调用 GET /status 获取实时状态 |

## 9. 独立监测层（Monitor Layer）

Monitor 是独立模块，不参与主流程指令分发，专门感知 Agent 实例的运行状态，并通过 Unix socket（IPC）将事件上报给 Hub。

| 监测模式 | 适用场景 | 机制 |
|---|---|---|
| SSE Hook 模式（优先） | agentapi 实例正常运行时 | 持久订阅 GET /events SSE 流，Agent 有输出或状态变化时实时推送 |
| Heartbeat 轮询模式（兜底） | SSE 流断开或 Agent 无响应时 | 按配置频率轮询 GET /status，检测到异常时通知 Hub |

### 9.1 Monitor 上报的事件类型

| 事件 | 说明 | Hub 的响应 |
|---|---|---|
| task_completed | Agent 完成任务，有结果可取回 | 拉取结果，封装 HubResult，回传 Telegram |
| status_changed | 实例状态变化（如 running → waiting） | 更新注册表，必要时通知操作者 |
| heartbeat_missed | 连续 N 次未收到心跳 | 标记实例 error，推送告警到 Telegram |
| agent_error | Agent 报错退出 | 标记实例 error，推送告警，提示操作者 /status 或 /restart |

Monitor 的每个 agentapi 实例对应一个独立的监测 goroutine / async task，互不干扰。spawn 时自动注册，kill 时自动注销。

## 10. 输出协议（HubResult）

```text
trace_id      // 与原始 HubMessage 对应
thread_id     // 来源实例标识
source        // 来源 Agent 类型（claude / codex / gemini / cursor）
status        // success | error | partial | timeout
content       // 结果正文（文本 / Markdown / 代码）
attachments[] // 输出文件（代码文件 / diff / 报告等）
timestamp     // 结果生成时间
```

### 回传策略

| 策略 | 说明 |
|---|---|
| 默认原路回传 | 结果发回操作者发起指令的同一 Telegram 聊天 |
| 长文本处理 | 内容超过 4096 字符时，自动以 .txt / .md 文件发送 |
| 代码文件输出 | Agent 生成的代码文件直接作为 Telegram 文件消息发送，保留文件名 |
| 告警消息 | Monitor 触发的异常事件主动发送消息给操作者，无需操作者轮询 |

## 11. 可观测性（Observability）

- 每条 HubMessage 和 HubResult 写入结构化日志（Pino），携带 trace_id、timestamp、source、target、status
- 实例生命周期事件（spawn / kill / restart / attach）写入操作审计日志
- Monitor 层的所有状态变化事件写入监测日志
- 提供简单查询：按 trace_id 查全链路、按 thread_id 查会话历史
- 异常（超时 / 错误）自动触发 Telegram 告警

## 12. 技术选型

| 模块 | 选型 | 说明 |
|---|---|---|
| 开发语言 | TypeScript / Node.js 22 LTS | 原生支持 Codex SDK / Claude Agent SDK，异步 I/O 适合大量 IPC + SSE 场景 |
| Telegram Bot 库 | grammY v2.x | 现代异步 TypeScript，生产可用，文档完善，MIT 许可 |
| Agent 控制层 | coder/agentapi（Go binary） | 统一 HTTP API 控制四个 CLI Agent，v0.11.2，243 commits，MIT 许可，活跃维护 |
| 内部通信 | Unix Domain Socket（IPC） | Hub ↔ agentapi / Monitor，不走 TCP，持久稳定，性能优 |
| 日志 | Pino | Node.js 最快结构化日志库，trace_id 字段注入 |
| 数据验证 | Zod | HubMessage / HubResult schema 强验证 |
| 进程管理 | PM2 / Docker Compose | 宿主机级别的进程守护与重启 |
| Pane Bridge 支持 | tmux | 宿主机预装 tmux，pane_bridge 模式下 agentapi pty attach 到 named session |

## 13. Phase 0 交付范围与验收标准

| 模块 | 交付内容 | 验收标准 |
|---|---|---|
| Interface Layer | Telegram Bot（grammY）Long Polling + Webhook 切换 | 操作者发消息 → 系统收到 → 转换为 HubMessage |
| Hub Core | 标准化 + 路由 + 分发 + 回传 | 指令正确送达 agentapi 实例，结果回传 Telegram |
| agentapi 集成 | 四个 CLI Agent 的 agentapi server 配置 | 可分别对 Claude Code / Codex / Gemini / Cursor CLI 实例发指令并收回结果 |
| Bridge 模式 | 后台 pty 无界面运行 | Agent 在后台执行，结果通过 Telegram 返回，操作者无需在终端前 |
| Pane Bridge 模式 | pty attach 到 tmux pane | 操作者在 tmux 里可实时看到 Agent 终端输出，同时 Telegram 也能收结果 |
| IPC 通信 | Unix socket 连接 Hub ↔ agentapi / Monitor | 内部通信不走 TCP，所有连接通过 /tmp/*.sock 文件 |
| Slash 命令 | /spawn /kill /status /attach /list /help | 六个命令全部可用，/spawn 支持 type 和 mode 参数 |
| 实例管理 | spawn / kill / attach / status 基础操作 | 可通过 Telegram 命令拉起多个不同 Agent 实例并分别管理 |
| Monitor（最小版） | SSE Hook + Heartbeat 兜底 | Agent 宕机或超时时，操作者收到 Telegram 告警 |
| 可观测性 | Pino 结构化日志 + trace_id | 可通过 trace_id 查询一条指令的完整链路 |

## 14. 后续阶段方向

| 阶段 | 重点 |
|---|---|
| Phase 1 | Email / Nostr 渠道接入；Cursor GUI / Antigravity GUI（待 API 公开）；Credential Layer 接入；多渠道回传 |
| Phase 2 | Memory Layer 接入；多用户权限隔离；外部合作方接入；MemoryHub namespace 隔离 |
| Phase 3 | LLM 分层调度集成；完整 ai_arch_v2 Agent Layer 对接；全链路 replay 与审计 |

---

**Calling Hub · 系统需求说明 v1.0 · 定稿**
