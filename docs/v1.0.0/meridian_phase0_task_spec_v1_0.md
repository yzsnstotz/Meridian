# Meridian · Phase 0

## Task Spec — Codex 开发任务切割

**v1.0 · 共 11 个 Task · 预估总工时 29–42 h**

## 属性

| 属性 | 内容 |
|---|---|
| 关联文档 | 需求说明 v1.0 · 附件 A v1.0 · 日志规格 v1.0 |
| 开发 Agent | Codex CLI（@openai/codex），以 task 为粒度分配上下文 |
| 总 Task 数 | 11 个（T-01 ~ T-11） |
| 关键路径 | T-01 → T-02 → T-04/T-05 → T-10 |
| 最大并行度 | Wave 3（T-03/T-04/T-05/T-06 同时开始）· Wave 4（T-07/T-08/T-09 同时开始） |
| 预估总工时 | 串行：约 32–44 h · 充分并行后：约 15–20 h（关键路径长度） |

## 1. 面向 Codex 的任务切割原则

以下原则指导了本文档的 Task 粒度设计：

| 原则 | 具体做法 |
|---|---|
| 上下文隔离 | 每个 Task 仅关注自己的 `src/` 子目录，输入输出接口通过 `types.ts` 预先对齐（T-01 完成） |
| 单一文件范围 | 每个 Task 的 deliverables 明确列出文件路径，Codex 不需要扫描整个仓库 |
| 安装步骤前置 | 每个 Task 的“安装”栏列出所需的 npm/系统包，Codex 在编码前先执行安装命令 |
| 接口契约优先 | T-02 的 `AgentAPIClient` 接口（方法签名）必须在 T-02 完成时锁定，后续 Task 直接依赖类型 |
| 避免跨 Task 重构 | `types.ts` 和 `logger.ts` 在 T-01 完成后即为稳定接口，不在后续 Task 中修改 |
| 测试随 Task 交付 | 每个 Task 附带基础测试或验证脚本，不积累到 T-10 统一测试 |

## 2. 并行度总览

下表展示各 Task 的并行窗口（█ = 主要开发期，░ = 可并行准备期）：

| Task | Wave 1 | Wave 2 | Wave 3 | Wave 4 | Wave 5 | Wave 6 | 并行说明 |
|---|---|---|---|---|---|---|---|
| T-01 | █ |  |  |  |  |  | 必须最先完成 |
| T-02 |  | █ |  |  |  |  | T-01 完成后立即开始 |
| T-03 |  |  | █ |  |  |  | T-01 完成后可开始（与 T-04/T-05 并行） |
| T-04 |  |  | █ |  |  |  | T-01+T-02 完成后可开始 |
| T-05 |  |  | █ |  |  |  | T-01+T-02 完成后可开始 |
| T-06 |  |  | █ |  |  |  | T-01+T-02 完成后可开始（完全独立） |
| T-07 |  |  |  | █ |  |  | T-02+T-05 完成后（与 T-08/T-09 并行） |
| T-08 |  |  |  | █ |  |  | T-02+T-05 完成后（与 T-07/T-09 并行） |
| T-09 |  |  |  | █ |  |  | T-02+T-05 完成后（与 T-07/T-08 并行） |
| T-10 |  |  |  |  | █ |  | 所有核心 Task 完成后 |
| T-11 |  |  | ░ | ░ |  | █ | T-01 后可并行编写 |

**Wave 说明：** Wave 1 = T-01 基础建设（必须串行）· Wave 2 = T-02 agentapi 封装 · Wave 3 = T-03/04/05/06 最大并行（4个 Codex 实例）· Wave 4 = T-07/08/09 Agent 集成（3个 Codex 实例）· Wave 5 = T-10 集成验收 · Wave 6 = T-11 部署配置

**关键路径（串行下限）：** T-01（2–3h）→ T-02（3–4h）→ T-05（3–4h）→ T-07（2–3h）→ T-10（3–4h）≈ 13–18h

## 3. Task 详细规格

### T-01 · 项目骨架 & 环境初始化

**Phase:** 基础建设 — 串行  
**并行性：** 必须串行，是关键路径节点  
**预估工时：** 2–3 h  
**依赖：** 无（起点）

#### 目标与背景

建立 TypeScript / Node.js 22 项目结构，安装所有 npm 依赖，配置 `tsconfig` / `eslint` / `.env` 模板，创建 `src/` 目录骨架，使后续所有 Task 能在同一代码库内独立开发。

**为什么这样划分：** 所有其他 Task 都依赖统一的项目根目录、tsconfig 路径别名和 `package.json`。必须最先完成，且无法并行。

#### 需要安装的开源包

| 包 / 工具 | 作用 |
|---|---|
| `typescript@5.x` | 编译器 |
| `ts-node` / `tsx` | 开发时直接运行 TS |
| `@types/node` | Node.js 类型定义 |
| `pino` + `pino-pretty` | 日志库（`pino-pretty` 仅 devDeps） |
| `zod` | Schema 验证 |
| `dotenv` | 读取 `.env` 配置 |
| `eslint` + `prettier` | 代码质量（devDeps） |

#### 交付物（Deliverables）

- `package.json`（含所有 npm 依赖）
- `tsconfig.json`（路径别名：`@hub/`, `@interface/`, `@monitor/`）
- `.env.example`（含所有必填环境变量注释）
- `src/` 目录骨架：`interface/` `hub/` `monitor/` `shared/`
- `src/logger.ts`（Pino 共享 logger 工厂，参考日志规格 v1.0）
- `src/types.ts`（`InboundUIEvent` / `HubMessage` / `HubResult` / `AgentInstance` 类型定义）
- `src/config.ts`（读取 `.env`，Zod 验证必填项）

#### Codex 编码注意事项

- 指定 Node.js 版本：22 LTS（`package.json` `engines` 字段）
- `tsconfig` 开启 `strict: true`，避免后续 Task 类型债务
- `logger.ts` 必须在此 Task 完成，所有后续 Task 直接 import 使用
- `types.ts` 中的接口定义要与需求说明 v1.0 第 6.1 / 10 节字段完全对应

### T-02 · agentapi 二进制安装 & 封装层

**Phase:** 基础建设 — 串行  
**并行性：** 必须串行，是关键路径节点  
**预估工时：** 3–4 h  
**依赖：** T-01（需要 `tsconfig` 和 `types.ts`）

#### 目标与背景

下载 agentapi Go binary（v0.11.2），编写 TypeScript 封装层，通过 HTTP over Unix Domain Socket 调用 agentapi 的三个核心接口（`POST /message` · `GET /status` · `GET /events` SSE），并包含连接重试和错误处理。

**为什么这样划分：** agentapi 是 Hub 控制所有 CLI Agent 的唯一底座。Instance Manager（T-04）、Monitor（T-05）、各 Agent 集成（T-06~T-09）都依赖这一封装层。必须在 T-01 完成后立即实现，是关键路径上的第二步。

#### 需要安装的开源包

| 包 / 工具 | 作用 |
|---|---|
| `agentapi v0.11.2 binary` | 从 GitHub Releases 下载，存放到 `bin/agentapi` |
| `eventsource`（npm） | Node.js SSE 客户端，用于订阅 `GET /events` 流 |

#### 交付物（Deliverables）

- `bin/agentapi`（可执行文件，`chmod +x`，加入 `.gitignore`）
- `scripts/install-agentapi.sh`（自动下载正确平台版本的脚本）
- `src/shared/agentapi-client.ts`（封装类 `AgentAPIClient`）
  - `connect(socketPath)`: 建立 Unix socket HTTP 连接
  - `sendMessage(content, attachments?)`: `POST /message`
  - `getStatus()`: `GET /status` → `AgentStatus`
  - `subscribeEvents(handler)`: `GET /events` SSE 流订阅
  - `disconnect()`: 清理连接
- `src/shared/agentapi-client.test.ts`（基础 mock 测试）

#### Codex 编码注意事项

- 下载地址：`https://github.com/coder/agentapi/releases/tag/v0.11.2`，选对应平台（linux/darwin, amd64/arm64）
- Unix socket HTTP 调用：使用 Node.js 原生 `http` 模块，`socketPath` 选项，不引入额外库
- SSE 订阅需处理断线重连（指数退避，最多 5 次），重连次数写入 `monitor.log`
- 所有方法抛出的错误需包含 `thread_id` 和 `socketPath` 上下文，方便日志关联

### T-03 · Interface Layer — Telegram Bot（grammY）

**Phase:** 接入层 ⚡ 部分并行  
**并行性：** 可部分并行（见依赖说明）  
**预估工时：** 3–4 h  
**依赖：** T-01（`types.ts` / `logger` / `config`），T-02 完成后可联调但不阻塞编码

#### 目标与背景

使用 grammY v2.x 实现 Telegram Bot 接入层，包含消息鉴权、多模态消息处理（文本/图片/文件）、Slash 命令解析，将所有入站消息标准化为 `InboundUIEvent`，并通过 Unix Domain Socket 发往 Hub Core。

**为什么这样划分：** Interface Layer 是系统的唯一入口。grammY 的安装和 Bot 注册步骤需要独立操作（@BotFather），与其他 Task 无代码依赖，可在 T-01 完成后立即开始编码。

#### 需要安装的开源包

| 包 / 工具 | 作用 |
|---|---|
| `grammy@^2.0`（npm） | Telegram Bot 框架，Interface Layer 核心 |
| `@grammyjs/types`（npm） | Telegram API 类型定义（grammY 的 peer dep） |

#### 交付物（Deliverables）

- `src/interface/bot.ts`（grammY Bot 实例，Long Polling 模式）
- `src/interface/auth.ts`（User ID 白名单鉴权中间件）
- `src/interface/parser.ts`（消息 → `InboundUIEvent` 转换，含多模态处理）
- `src/interface/slash-handler.ts`（`/spawn` `/kill` `/status` `/attach` `/list` `/help` 解析）
- `src/interface/ipc-sender.ts`（Unix socket 发送 `HubMessage` 到 Hub Core）
- `src/interface/index.ts`（入口，启动 Bot）
- Bot 注册步骤说明（README 片段：@BotFather 注册 + Slash 命令配置）

#### Codex 编码注意事项

- `grammY` 安装：`npm install grammy`
- Long Polling 启动：`bot.start()`，生产切 Webhook 只需改配置，不改业务代码
- 图片/文件下载：使用 `bot.api.getFile()` + https 下载到 `/tmp/hub-attachments/`，路径写入 `attachments[]`
- Unix socket 发送：复用 T-01 骨架中的 `shared/ipc.ts`，不重复实现
- 鉴权失败写 `interface.log`（level: `warn`，含 `sender_id`），不生成 `trace_id`，不转发

### T-04 · Hub Core — 标准化 / 路由 / 分发 / 回传

**Phase:** 核心层 ⚡ 部分并行  
**并行性：** 可部分并行（见依赖说明）  
**预估工时：** 4–5 h  
**依赖：** T-01（types / logger），T-02（`AgentAPIClient`），T-03 完成后可联调

#### 目标与背景

实现 Hub Core 的主流程：监听来自 Interface Layer 的 Unix socket，解析 `HubMessage`，通过 Zod 验证，路由到目标 agentapi 实例（调用 `AgentAPIClient`），接收 `HubResult` 后通过 Telegram API 回传操作者。同步开发实例注册表（Instance Manager 的注册表部分）。

**为什么这样划分：** Hub Core 是系统的核心调度路径，是所有指令的必经之地。T-05（Monitor）和 T-06~T-09（Agent 集成）都需要 Hub Core 的 Unix socket 服务已启动才能联调。

#### 需要安装的开源包

| 包 / 工具 | 作用 |
|---|---|
| （无新 npm 包） | 复用 T-01 已装的 `pino` / `zod` / `dotenv` |

#### 交付物（Deliverables）

- `src/hub/server.ts`（Unix socket 服务，监听来自 Interface 的连接）
- `src/hub/normalizer.ts`（`InboundUIEvent` → `HubMessage`，含 `trace_id` 生成）
- `src/hub/router.ts`（解析 `intent`，查注册表，调用 `AgentAPIClient`）
- `src/hub/result-sender.ts`（`HubResult` → Telegram API 回传，长文本自动转文件）
- `src/hub/registry.ts`（内存 `Map<thread_id, AgentInstance>`，含状态读写方法）
- `src/hub/index.ts`（Hub Core 入口，启动 Unix socket 服务）
- Zod schema：`HubMessageSchema` / `HubResultSchema`（在 `src/types.ts` 补充）

#### Codex 编码注意事项

- `trace_id` 生成：使用 Node.js `crypto.randomUUID()`，无需引入额外库
- Unix socket 监听：`net.createServer() + listen('/tmp/hub-core.sock')`
- Telegram 回传：使用 `grammY bot.api`（复用 T-03 的 bot 实例），或直接调用 Telegram Bot API 的 HTTPS 接口
- 长文本（>4096 字符）：`InputFile` 方式发送 `.txt` 文件，grammY 原生支持
- 所有路由日志必须带 `trace_id` + `thread_id`，写入 `hub.log`

### T-05 · Instance Manager — 实例生命周期管理

**Phase:** 核心层 ⚡ 部分并行  
**并行性：** 可部分并行（见依赖说明）  
**预估工时：** 3–4 h  
**依赖：** T-01，T-02（`AgentAPIClient`），T-04（`registry.ts` 已存在）

#### 目标与背景

实现实例管理器的生命周期操作：spawn（fork agentapi 子进程，Bridge 或 Pane Bridge 模式）、kill、attach、detach、restart、status、list。Pane Bridge 模式需调用 tmux 命令创建 named session。

**为什么这样划分：** Instance Manager 是 Hub Core 的内置子模块，但其逻辑（进程 fork、tmux 操作、socket 注册）足够独立，值得单独成 Task。T-03/T-04 联调前需要能 spawn 至少一个实例。

#### 需要安装的开源包

| 包 / 工具 | 作用 |
|---|---|
| （无新 npm 包） | 使用 Node.js 内置 `child_process.spawn()` |
| `tmux`（宿主机） | Pane Bridge 模式：`sudo apt install tmux` 或 `brew install tmux` |

#### 交付物（Deliverables）

- `src/hub/instance-manager.ts`（`InstanceManager` 类）
  - `spawn(type, mode)`: fork agentapi 进程，注册到 registry，返回 `thread_id`
  - `kill(thread_id)`: `SIGTERM`，清理 socket 文件，从 registry 移除
  - `attach(thread_id, session)`: 更新当前会话的默认 `thread_id`
  - `restart(thread_id)`: kill + spawn，保持 `thread_id`
  - `status(thread_id)`: 读 registry + 调用 `AgentAPIClient.getStatus()`
  - `list()`: 返回所有 `AgentInstance[]`
- `scripts/spawn-agent.sh`（手动调试用，独立 spawn 单个 agentapi 实例）

#### Codex 编码注意事项

- agentapi 进程 fork：`child_process.spawn('bin/agentapi', args, { detached: false })`
- Bridge 模式 args：`['server', '--type=<agent>', '--', '<cli_cmd>']`
- Pane Bridge 模式：先 `execSync('tmux new-session -d -s <session>')` 再 agentapi 加 `--tmux-session` 参数
- socket 路径约定：`/tmp/agentapi-{thread_id}.sock`（与 `AgentAPIClient` 约定一致）
- 生命周期事件全部写入 `instance.log`，含 `pid` / `socket_path` / `prev_status` / `next_status`

### T-06 · Monitor Layer — SSE Hook + Heartbeat

**Phase:** 监测层 ✓ 可并行  
**并行性：** 可与其他 Task 并行  
**预估工时：** 3–4 h  
**依赖：** T-01，T-02（`AgentAPIClient.subscribeEvents`）；可与 T-03/T-04/T-05 并行开发

#### 目标与背景

实现独立 Monitor 模块：对每个活跃 agentapi 实例维护一个监测任务（async task），优先 SSE Hook 模式订阅事件流，SSE 失联时自动降级为 Heartbeat 轮询模式。通过 Unix socket IPC 将事件上报给 Hub Core。

**为什么这样划分：** Monitor 是设计上明确独立的模块，与主流程无耦合，只通过 IPC 上报。可以完全并行于 T-03/T-04/T-05 开发，只需 T-01 和 T-02 的 `AgentAPIClient` 即可。

#### 需要安装的开源包

| 包 / 工具 | 作用 |
|---|---|
| （无新 npm 包） | 复用 `AgentAPIClient.subscribeEvents`（T-02） |

#### 交付物（Deliverables）

- `src/monitor/monitor.ts`（`MonitorManager` 类）
  - `register(instance)`: 启动该实例的监测 task
  - `unregister(thread_id)`: 停止并清理
  - 内部：SSE 订阅 → 失败 → 降级 Heartbeat 轮询
- `src/monitor/ipc-reporter.ts`（通过 Unix socket 向 Hub 上报 `MonitorEvent`）
- `src/monitor/events.ts`（`MonitorEvent` 类型：`task_completed` / `status_changed` / `heartbeat_missed` / `agent_error`）
- `src/monitor/index.ts`（Monitor 服务入口）

#### Codex 编码注意事项

- 每个实例对应一个独立 async 循环（不用线程，Node.js 事件循环已够用）
- SSE 失联判定：重连失败 3 次（指数退避后）→ 切换 Heartbeat
- Heartbeat 间隔：从 `.env` 读取 `HEARTBEAT_INTERVAL_MS`（默认 `10000`）
- `heartbeat_missed` 阈值：连续 3 次 → 上报 `error` 事件（阈值从 `.env` 读取）
- 所有事件写入 `monitor.log`，上报失败时写 `error` 级别日志并重试

### T-07 · Claude Code CLI 集成验证

**Phase:** Agent 集成 ✓ 可并行  
**并行性：** 可与其他 Task 并行  
**预估工时：** 2–3 h  
**依赖：** T-02（agentapi binary），T-05（spawn 能力）；可与 T-08/T-09 并行

#### 目标与背景

配置 `ANTHROPIC_API_KEY`，验证 Claude Code CLI 通过 agentapi 完成完整 Bridge 模式和 Pane Bridge 模式的端到端流程：spawn → 发指令 → 收结果。作为 Phase 0 的首个联调目标。

**为什么这样划分：** 文档明确“Phase 0 建议首先对 Claude Code 做端到端联调验证”（★★★★★ 最高成熟度）。三个 Agent 集成 Task 彼此无依赖，完全并行。

#### 需要安装的开源包

| 包 / 工具 | 作用 |
|---|---|
| `claude`（npm 全局） | Claude Code CLI：`npm install -g @anthropic-ai/claude-code` |

#### 交付物（Deliverables）

- `src/agents/claude.ts`（Claude agent 配置：`type='claude'`，`allowedTools` 参数）
- `ANTHROPIC_API_KEY` 写入 `.env`（不提交，`.env.example` 含占位符）
- 集成测试脚本 `scripts/test-claude.sh`（Bridge + Pane Bridge 各一次端到端调用）
- 验收记录：Bridge 模式收到结果 ✓，Pane Bridge 模式 tmux pane 有输出 ✓

#### Codex 编码注意事项

- 安装：`npm install -g @anthropic-ai/claude-code`（需要 Node.js 18+）
- 验证 CLI 可用：`claude --version`
- Bridge 模式 spawn 参数：`['server', '--type=claude', '--', 'claude', '--allowedTools', 'Bash Edit Replace']`
- Pane Bridge 需宿主机已装 tmux，先 `tmux new-session` 再 `agentapi --tmux-session`
- 测试指令建议用无副作用的任务：`'list files in current directory'`

### T-08 · Codex CLI 集成验证

**Phase:** Agent 集成 ✓ 可并行  
**并行性：** 可与其他 Task 并行  
**预估工时：** 2–3 h  
**依赖：** T-02，T-05；可与 T-07/T-09 并行

#### 目标与背景

配置 OpenAI 认证，验证 Codex CLI 通过 agentapi 完成 Bridge 和 Pane Bridge 模式端到端流程。

**为什么这样划分：** ★★★★★ 最高成熟度，SDK 已 GA。与 T-07/T-09 完全并行，不共享任何状态。

#### 需要安装的开源包

| 包 / 工具 | 作用 |
|---|---|
| `codex`（npm 全局） | Codex CLI：`npm install -g @openai/codex` |

#### 交付物（Deliverables）

- `src/agents/codex.ts`（Codex agent 配置：`type='codex'`）
- `OPENAI_API_KEY` 写入 `.env`
- `scripts/test-codex.sh`（Bridge + Pane Bridge 端到端测试）
- 验收记录：两种模式各收到结果 ✓

#### Codex 编码注意事项

- 安装：`npm install -g @openai/codex`
- 验证：`codex --version`
- agentapi spawn 参数：`['server', '--type=codex', '--', 'codex']`
- Codex 支持 exec 非交互模式，适合一次性指令；测试建议同 T-07

### T-09 · Gemini CLI 集成验证

**Phase:** Agent 集成 ✓ 可并行  
**并行性：** 可与其他 Task 并行  
**预估工时：** 2–3 h  
**依赖：** T-02，T-05；可与 T-07/T-08 并行

#### 目标与背景

完成宿主机 Google 账号认证（`gcloud auth` 或 `gemini auth`），验证 Gemini CLI 通过 agentapi 完成 Bridge 和 Pane Bridge 端到端流程。

**为什么这样划分：** ★★★★☆，agentapi 支持稳定。认证步骤是一次性操作，不阻塞 T-07/T-08。

#### 需要安装的开源包

| 包 / 工具 | 作用 |
|---|---|
| `gemini CLI`（Google 官方） | 按 Google 文档安装：`npm install -g @google/gemini-cli` 或 `brew` |
| `gcloud CLI`（可选） | 认证备选方案，宿主机一次性操作 |

#### 交付物（Deliverables）

- `src/agents/gemini.ts`（Gemini agent 配置：`type='gemini'`）
- 宿主机完成 `gcloud auth login` 或 `gemini auth`（文档记录步骤）
- `scripts/test-gemini.sh`（Bridge + Pane Bridge 端到端测试）
- 验收记录：两种模式各收到结果 ✓

#### Codex 编码注意事项

- 认证必须在宿主机完成，不能在 Task 内自动化（OAuth 浏览器流程）
- 验证：`gemini --version`
- agentapi spawn 参数：`['server', '--type=gemini', '--', 'gemini']`
- 如 `gcloud` 认证复杂，可改用 `GEMINI_API_KEY` 环境变量

### T-10 · 全链路集成测试 & Slash 命令验收

**Phase:** 验收 — 串行  
**并行性：** 必须串行，是关键路径节点  
**预估工时：** 3–4 h  
**依赖：** T-03 + T-04 + T-05 + T-06 + T-07（至少）全部完成

#### 目标与背景

在真实 Telegram 对话中验证所有 Slash 命令端到端流程，覆盖：`/spawn`（`bridge` + `pane_bridge`）→ 发指令 → 收结果 → `/status` → `/list` → `/kill` → Monitor 告警触发。验收需求说明 v1.0 第 13 节所有验收标准。

**为什么这样划分：** 集成测试必须在所有核心模块完成后串行进行，是 Phase 0 的最终验收门控。

#### 需要安装的开源包

| 包 / 工具 | 作用 |
|---|---|
| （无新安装） | 纯验收测试 |

#### 交付物（Deliverables）

- 端到端测试脚本 `scripts/e2e-test.sh`（自动化 Slash 命令序列）
- 验收报告（Markdown）：逐条对应需求说明 v1.0 第 13 节验收标准
- 全链路 `trace_id` 查询演示：`grep trace_id` 跨文件检索截图/记录
- 已知问题列表（若有）及建议处理方式

#### Codex 编码注意事项

- 按需求说明第 13 节逐条验收，不要跳过
- Monitor 告警测试：手动 kill agentapi 进程，确认 Telegram 收到告警消息
- 长文本回传测试：发送超 4096 字符的任务，确认自动转文件发送
- `trace_id` 查询：取一个真实 `trace_id`，`grep` 跨 `hub.log` / `interface.log` / `monitor.log` 验证全链路

### T-11 · 进程守护 & 部署配置（PM2 / Docker Compose）

**Phase:** 部署 ✓ 可并行  
**并行性：** 可与其他 Task 并行  
**预估工时：** 2–3 h  
**依赖：** T-01（项目骨架）；可与 T-03~T-09 并行编写，T-10 后最终验证

#### 目标与背景

配置 PM2（或 Docker Compose）的进程守护方案：Hub Core、Interface Layer、Monitor 作为三个独立进程（或 service）启动，agentapi 子进程由 Instance Manager 动态管理。包含日志目录初始化和 logrotate 配置。

**为什么这样划分：** 部署配置与业务代码无强依赖，可并行准备。PM2 ecosystem 文件需要在所有 Task 完成后最终校验一次。

#### 需要安装的开源包

| 包 / 工具 | 作用 |
|---|---|
| `pm2`（npm 全局） | 进程守护：`npm install -g pm2`（二选一） |
| `docker + docker-compose` | 容器化方案（二选一，宿主机安装） |

#### 交付物（Deliverables）

- `ecosystem.config.js`（PM2 配置，含 `hub` / `interface` / `monitor` 三个 app）
- `docker-compose.yml`（可选：Hub 主服务 + 环境变量注入）
- `scripts/setup-host.sh`（创建 `/var/log/hub/`，`/tmp/hub-socks/` 等必要目录）
- `/etc/logrotate.d/meridian`（日志轮转配置，参考日志规格 v1.0 第 4.2 节）
- `README.md` 部署章节（启动 / 停止 / 查看日志命令）

#### Codex 编码注意事项

- PM2：`pm2 start ecosystem.config.js`；`pm2 logs` 查看实时日志
- agentapi 进程不由 PM2 管理（动态 spawn），只需确保 `bin/agentapi` 路径正确
- logrotate 配置参考日志规格文档第 4.2 节，`postrotate` 用 `pm2 reload`
- Docker 方案需将 Unix socket 目录挂载为 volume：`-v /tmp/hub-socks:/tmp/hub-socks`

## 4. 快速参考：开源软件安装汇总

以下是整个 Phase 0 涉及的所有开源软件安装命令，按顺序整理：

### npm 包（Hub 项目依赖）

```bash
# T-01：项目初始化
npm install pino zod dotenv grammy @grammyjs/types eventsource
npm install -D typescript ts-node @types/node pino-pretty eslint prettier

# T-07：Claude Code CLI
npm install -g @anthropic-ai/claude-code

# T-08：Codex CLI（你自己的开发 Agent）
npm install -g @openai/codex

# T-09：Gemini CLI
npm install -g @google/gemini-cli

# T-11：PM2 进程管理
npm install -g pm2
```

### 系统级工具（宿主机）

```bash
# T-02：agentapi binary（由 install-agentapi.sh 自动下载）
# 手动方式（linux/amd64 示例）：
curl -L https://github.com/coder/agentapi/releases/download/v0.11.2/agentapi_linux_amd64.tar.gz | tar xz
mv agentapi bin/agentapi && chmod +x bin/agentapi

# T-05：tmux（Pane Bridge 模式）
sudo apt install tmux          # Ubuntu/Debian
brew install tmux              # macOS

# T-09：Google Cloud SDK（Gemini 认证，如需）
# 参考：https://cloud.google.com/sdk/docs/install
gcloud auth login
```

---

**Meridian · Task Spec v1.0 · Phase 0 · 共 11 Task**  
**Codex 开发任务切割 · ai_arch_v2 体系**
