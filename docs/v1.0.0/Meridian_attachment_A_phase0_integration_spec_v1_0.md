# Calling Hub — 附件 A

## Phase 0 接入规格 v1.0：Telegram Bot + CLI Coding Agents

本文档为需求说明 v1.0 的技术附件，描述各系统的具体接入方式与通信协议。

## 属性

| 属性 | 内容 |
|---|---|
| 版本 | v1.0（与需求说明 v1.0 同步更新） |
| 覆盖范围 | Telegram Bot（Interface Layer）· Claude Code CLI · Codex CLI · Gemini CLI · Cursor CLI |
| 不包含 | Cursor GUI · Antigravity GUI（无程序化 API，不纳入 Phase 0） |
| 内部通信协议 | Unix Domain Socket（IPC）— Hub ↔ agentapi 实例 / Monitor 层 |

---

## Part 1  Telegram Bot（Interface Layer）

Telegram Bot 是 Phase 0 的唯一操作渠道，负责接收操作者指令并回传结果。

### 1.1 接入机制与库选型

| 属性 | 规格 |
|---|---|
| 开发库 | grammY v2.x（TypeScript，MIT，18k+ stars，生产可用） |
| 消息接收 | 开发阶段：Long Polling；生产：Webhook HTTPS（调用 setWebhook 注册公网 URL） |
| 与 Hub 的连接 | Interface Layer 与 Hub Core 之间通过 Unix Domain Socket（IPC）通信，不走 TCP |
| 鉴权 | Bot Token + 操作者 Telegram User ID 白名单（Phase 0 单 Owner） |

### 1.2 Bot 注册步骤

| 步骤 | 操作 | 说明 |
|---|---|---|
| 1 | 向 @BotFather 发送 `/newbot` | 获取 Bot Token（格式：数字:字符串） |
| 2 | 记录操作者 Telegram User ID | 向 @userinfobot 发任意消息获取，写入 `ALLOWED_USER_IDS` 配置 |
| 3 | 配置环境变量 | `TELEGRAM_BOT_TOKEN` 和 `ALLOWED_USER_IDS` 在 Hub 启动时读取 |
| 4 | （生产）注册 Webhook | 调用 Telegram API `setWebhook` 指向 Hub 的公网 HTTPS 入口 |

### 1.3 Slash 命令注册（@BotFather）

- `/spawn` - 拉起一个新的 Agent 实例（参数：type, mode）
- `/kill` - 关闭指定实例（参数：thread）
- `/status` - 查询实例状态（参数：thread）
- `/attach` - 将当前会话绑定到指定实例（参数：thread）
- `/list` - 列出所有活跃实例
- `/help` - 显示帮助信息

### 1.4 多模态消息处理

| 消息类型 | Telegram 类型 | Hub 处理 |
|---|---|---|
| 纯文本 | `text` | 直接作为 `payload.content`，透传给 Agent |
| 图片 | `photo` | 下载到临时存储，作为 `attachments[]` 引用 |
| 文件 / 文档 | `document` | 同上，保留文件名和 MIME 类型 |
| Slash 命令 | `/spawn` `/kill` 等 | 优先解析为结构化 intent |
| 回复消息 | `reply_to_message` | 用于绑定已有 `thread_id`（继续某个实例的会话） |

---

## Part 2  agentapi — Agent 控制层底座

核心底层：`github.com/coder/agentapi` · Go binary · MIT · v0.11.2 · 243 commits · 活跃维护

agentapi 解决了最关键的问题：四个 CLI Agent 的接口各不相同。agentapi 通过内置内存终端模拟器，将 HTTP 请求翻译为终端按键，再把各 Agent 的终端输出解析为统一的消息格式。Hub 只需对接一套接口，不需要分别适配每个 Agent。

| 属性 | 详情 |
|---|---|
| 仓库 | `github.com/coder/agentapi` |
| 语言 | Go（独立 binary，与 Hub 语言无关） |
| 连接方式 | Hub 通过 HTTP over Unix Domain Socket（IPC）调用，socket 路径：`/tmp/agentapi-{thread_id}.sock` |
| 核心接口 | `POST /message`（发指令）· `GET /status`（查状态）· `GET /events`（SSE 实时事件流） |
| Bridge 模式 | `agentapi server` 在后台 pty 运行，无可视界面，完全程序化控制 |
| Pane Bridge 模式 | pty attach 到宿主机 tmux session 的指定 pane，Hub 写入同时操作者可实时查看 |
| 成熟度 | ★★★★☆ v0.x，生产可用（Claude Code / Codex / Gemini 稳定；Cursor CLI headless 边缘情况仍在完善） |

### 两种模式的切换

```bash
# Bridge 模式：纯后台，操作者不可见终端
agentapi server --type=claude -- claude --allowedTools 'Bash Edit Replace'

# Pane Bridge 模式：attach 到 tmux pane，操作者可实时查看
tmux new-session -d -s agent_claude_01
agentapi server --type=claude --tmux-session=agent_claude_01 -- claude --allowedTools 'Bash Edit Replace'

# Hub 调用（两种模式接口完全相同）
curl --unix-socket /tmp/agentapi-claude_01.sock \
  -X POST http://localhost/message \
  -d '{"content": "重构 src/index.ts"}'
```

---

## Part 3  各 CLI Agent 接入规格

### A · Claude Code CLI · Anthropic

✅ 接入成熟度：高 · `agentapi` 原生支持 · 官方 Agent SDK 可选

| 维度 | 详情 |
|---|---|
| 控制方式 | `agentapi` 包装（推荐）；或 `@anthropic-ai/claude-code` Agent SDK（原生 Node.js，可绕过 `agentapi`） |
| IPC 连接 | Unix socket：`/tmp/agentapi-{thread_id}.sock` |
| 认证 | `ANTHROPIC_API_KEY` 环境变量（宿主机预先设置） |
| 特性 | `--allowedTools` 参数可限制 Agent 执行范围（安全隔离） |
| 成熟度 | ★★★★★ 稳定，推荐作为 Phase 0 首个验证目标 |

#### 接入操作示例

```bash
# Bridge 模式（无界面后台）
agentapi server --type=claude -- claude --allowedTools 'Bash Edit Replace'

# Pane Bridge 模式（tmux 可视）
tmux new-session -d -s agent_claude_01
agentapi server --type=claude --tmux-session=agent_claude_01 -- claude

# 发送指令
curl --unix-socket /tmp/agentapi-claude_01.sock -X POST http://localhost/message -d '{"content": "重构 src/index.ts"}'

# 查询状态
curl --unix-socket /tmp/agentapi-claude_01.sock http://localhost/status

# 关闭实例
kill $(cat /tmp/agentapi-claude_01.pid)
```

#### 结果获取方式

SSE 事件流实时推送（`GET /events`）；任务完成后可拉取完整对话（`GET /messages`）。Monitor 层订阅 SSE 流，`task_completed` 事件触发时通过 IPC 通知 Hub 回传结果。

- Claude Agent SDK 支持在 Node.js 代码中直接 `import` 调用，可完全绕过 `agentapi`，但统一走 `agentapi` 接口可保持 Hub 侧逻辑一致。
- 支持多实例并行：每个 `agentapi server` 进程绑定独立 socket，互不干扰。
- Phase 0 建议首先对这个 Agent 做端到端联调验证，其他 Agent 接口格式相同。

### B · Codex CLI · OpenAI（`@openai/codex`）

✅ 接入成熟度：高 · 官方 TypeScript SDK 已 GA

| 维度 | 详情 |
|---|---|
| 控制方式 | `agentapi` 包装（推荐，接口与其他 Agent 统一）；或 `@openai/codex-sdk`（官方 TypeScript SDK，`startThread()` + `run()` 多轮调用） |
| IPC 连接 | Unix socket：`/tmp/agentapi-{thread_id}.sock` |
| 认证 | ChatGPT 账号（Plus 计划内含）或 `OPENAI_API_KEY` |
| SDK 特性 | `startThread()` 创建会话，`run()` 执行任务，原生支持多轮上下文持久化 |
| 成熟度 | ★★★★★ SDK 稳定，已 GA |

#### 接入操作示例

```bash
# Bridge 模式（无界面后台）
agentapi server --type=codex -- codex

# Pane Bridge 模式（tmux 可视）
tmux new-session -d -s agent_codex_01
agentapi server --type=codex --tmux-session=agent_codex_01 -- codex

# 发送指令
curl --unix-socket /tmp/agentapi-codex_01.sock -X POST http://localhost/message -d '{"content": "修复 CI 失败"}'

# 查询状态
curl --unix-socket /tmp/agentapi-codex_01.sock http://localhost/status

# 关闭实例
kill $(cat /tmp/agentapi-codex_01.pid)
```

#### 结果获取方式

SSE 事件流；或通过 Codex SDK 的 `run()` 同步等待返回。`agentapi` 模式下与 Claude Code 完全相同，Monitor 订阅 SSE 流。

- Codex SDK 的 thread 模型：一次 `startThread()` + 多次 `run()` 可保持多轮上下文，适合需要持续对话的 coding 任务。
- `agentapi` 方式指定 `--type=codex` 确保消息格式正确解析。
- Codex 支持 `exec` 非交互模式，适合一次性指令场景。

### C · Gemini CLI · Google

✅ 接入成熟度：高 · `agentapi` 原生支持 `--type=gemini`

| 维度 | 详情 |
|---|---|
| 控制方式 | `agentapi` 包装（`--type=gemini`） |
| IPC 连接 | Unix socket：`/tmp/agentapi-{thread_id}.sock` |
| 认证 | 需宿主机预先完成 `gcloud auth` 或 `gemini auth`（OAuth 流程，一次性操作） |
| 优势 | 1M token 上下文窗口，适合超大型代码库分析任务 |
| 成熟度 | ★★★★☆ `agentapi` 支持稳定；认证需宿主机预配置 |

#### 接入操作示例

```bash
# Bridge 模式（无界面后台）
agentapi server --type=gemini -- gemini

# Pane Bridge 模式（tmux 可视）
tmux new-session -d -s agent_gemini_01
agentapi server --type=gemini --tmux-session=agent_gemini_01 -- gemini

# 发送指令
curl --unix-socket /tmp/agentapi-gemini_01.sock -X POST http://localhost/message -d '{"content": "分析整个 src 目录的依赖关系"}'

# 查询状态
curl --unix-socket /tmp/agentapi-gemini_01.sock http://localhost/status

# 关闭实例
kill $(cat /tmp/agentapi-gemini_01.pid)
```

#### 结果获取方式

SSE 事件流实时推送，与 Claude Code 完全相同。

> ⚠️ 注意：Gemini CLI 需要在宿主机预先完成 Google 账号认证（`gcloud auth login` 或 `gemini auth`），否则 spawn 时会卡在认证流程。部署前需确认此步骤。

- 1M token 上下文是 Gemini 的核心优势，适合分配大型代码库分析或文档处理任务。
- 如遇 `gcloud` 认证复杂，可考虑通过 `GEMINI_API_KEY` 环境变量直接认证。

### D · Cursor CLI · Cursor（headless 模式）

⚠️ 接入成熟度：中 · headless 仍有已知边缘情况

| 维度 | 详情 |
|---|---|
| 控制方式 | `agentapi` 包装（推荐）；或 `cursor-agent --print`（直接调用，有稳定性风险） |
| IPC 连接 | Unix socket：`/tmp/agentapi-{thread_id}.sock` |
| 认证 | `CURSOR_API_KEY`（从 `cursor.com/dashboard` 获取） |
| 已知问题 | `--print` 模式偶发无限挂起；MCP 工具在部分场景需要特殊配置 |
| 成熟度 | ★★★☆☆ 中，建议先以 `agentapi` 包装方式验证，直连作为备选 |

#### 接入操作示例

```bash
# Bridge 模式（无界面后台）
export CURSOR_API_KEY=your_key
agentapi server --type=cursor -- cursor-agent

# Pane Bridge 模式（tmux 可视）
tmux new-session -d -s agent_cursor_01
export CURSOR_API_KEY=your_key
agentapi server --type=cursor --tmux-session=agent_cursor_01 -- cursor-agent

# 发送指令
curl --unix-socket /tmp/agentapi-cursor_01.sock -X POST http://localhost/message -d '{"content": "重构 auth 模块"}'

# 查询状态
curl --unix-socket /tmp/agentapi-cursor_01.sock http://localhost/status

# 关闭实例
kill $(cat /tmp/agentapi-cursor_01.pid)
```

#### 结果获取方式

SSE 事件流（`agentapi` 模式）；直接调用时 stdout 输出（`--print` 模式，不推荐用于 Phase 0）。

> ⚠️ 注意：Cursor CLI headless 模式目前有已知的稳定性问题：`--print` 模式可能无限挂起，MCP 工具配置可能失效。Phase 0 建议放在 Claude Code / Codex / Gemini 验证通过后再接入 Cursor CLI，作为第四个目标。

- Cursor Background Agent API 是 Cursor 官方的程序化后台 Agent 能力，但需要额外付费，Phase 0 先用 `agentapi` 包装 CLI 模式。
- 如果 Cursor CLI 稳定性问题持续，可考虑用 Aider 或 OpenCode 作为替代（`agentapi` 同样支持）。

---

## Part 4  开发语言与技术栈建议

推荐：**TypeScript / Node.js 22 LTS**

| 维度 | 评估 |
|---|---|
| 与 Agent SDK 契合度 | Codex SDK（`@openai/codex-sdk`）和 Claude Agent SDK（`@anthropic-ai/claude-code`）均原生支持 TypeScript，无需绕路 |
| 异步 I/O 能力 | Node.js 事件循环天然适合大量并发 I/O：多个 `agentapi` Unix socket 连接 + SSE 流 + Telegram polling 同时处理 |
| IPC 支持 | Node.js 原生 `net` 模块直接支持 Unix Domain Socket，无需额外库：`net.createConnection('/tmp/agentapi-x.sock')` |
| 类型安全 | TypeScript 对 `HubMessage` / `HubResult` 等核心数据结构的强类型约束，减少运行时错误 |
| 生态完整性 | grammY（Telegram）· Pino（日志）· Zod（数据验证）· BullMQ（可选队列）均有高质量 TypeScript 支持 |
| 运维简单 | Node.js 22 Docker 镜像成熟；`agentapi` Go binary 与 TypeScript Hub 共同部署无冲突 |

### 推荐完整技术栈

```text
# 运行时
Node.js 22 LTS
TypeScript 5.x

# Telegram Interface Layer
grammY v2.x  (https://grammy.dev)

# Agent 控制层（Unix socket IPC 包装 agentapi）
coder/agentapi  v0.11.2  (Go binary)

# IPC 通信（Hub 内部）
Node.js 原生 net 模块  (Unix Domain Socket)

# 日志
Pino  (结构化日志，trace_id 字段注入)

# 数据验证
Zod  (HubMessage / HubResult schema)

# 进程管理
PM2 或 Docker Compose

# Pane Bridge 支持
tmux  (宿主机预装，pane_bridge 模式所需)
```

### 宿主机部署示意

```text
┌──────────────────────────────────────────────────────────────┐
│  宿主机 / Docker Host                                        │
│                                                              │
│  ┌────────────────────────┐   Unix sockets                  │
│  │  Calling Hub           │   /tmp/agentapi-*.sock           │
│  │  (TypeScript / Node)   ├──────────────────────────────►  │
│  │                        │                                  │
│  │  Interface Layer       │   ┌─────────────────────────┐   │
│  │  Hub Core              │   │  agentapi instances      │   │
│  │  Instance Manager      │◄──┤  claude_01.sock          │   │
│  │  Monitor Layer         │   │  codex_01.sock           │   │
│  │                        │   │  gemini_01.sock          │   │
│  └──────────┬─────────────┘   │  cursor_01.sock          │   │
│             │                 └───────────┬─────────────┘   │
│             │ HTTPS                       │ spawn pty        │
│  Telegram Bot API              ┌──────────▼──────────┐      │
│             │                  │  CLI Agents          │      │
│             ▼                  │  claude / codex      │      │
│  操作者 Telegram 客户端          │  gemini / cursor     │      │
│                                └─────────────────────┘      │
│         [Pane Bridge: tmux sessions 可视]                    │
└──────────────────────────────────────────────────────────────┘
```

---

**Calling Hub · 附件 A · Phase 0 接入规格 v1.0**
