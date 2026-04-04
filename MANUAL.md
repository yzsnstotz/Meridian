# Meridian 集成手册（供其他服务调用）

本文面向**非 Telegram 客户端**的“其他服务/系统”，描述如何以程序方式调用 Meridian 的各项能力（启动/控制线程、运行任务、获取进度、Web GUI、文件读写、模型切换、扩展自定义 intents 等）。

## 能力入口一览（按推荐顺序）

- **Web API（HTTP）**：当你已经启用 Web GUI 时，这是最简单的集成方式（带 Bearer token 鉴权）。
- **Hub IPC（Unix socket / TCP socket path）**：直接向 Hub 的 `HUB_SOCKET_PATH` 发送 `HubMessage` JSON（需要你自行生成 `trace_id` 等字段）。
- **自定义 Intent 扩展（服务注册）**：外部服务向 Hub 注册 `socket_path` + `intents`，Hub 会把这些 intents 的请求转发给你的服务。
- **Telegram**：面向人类交互的入口（slash commands）。如果你的“其他服务”本身就是 Telegram bot/bridge，可参考 `README.md` 的 webhook/long-polling 方式。

---

## 1) Web API（HTTP）调用（推荐）

### 前置条件

- 设置并启动 Web GUI：
  - `WEB_GUI_ENABLED=true`
  - `WEB_GUI_HOST=<对外可访问的 host 或域名>`（用于 Hub 生成 GUI 链接）
  - `WEB_GUI_TOKEN=<随机 token>`（必须）
  - `WEB_GUI_PORT=3000`（默认）
  - 可选：`WEB_GUI_HTTPS=true` + `TLS_CERT_PATH` + `TLS_KEY_PATH`

### 鉴权与会话

- **鉴权 token**：二选一
  - Header：`Authorization: Bearer <WEB_GUI_TOKEN>`
  - Query：`?token=<WEB_GUI_TOKEN>`
- **会话 session_id**：用于 Web 侧的“active thread”等行为的归属（建议外部服务显式设置）
  - Header：`X-Session-Id: <your-stable-session-id>`
  - 或 Query：`?session_id=<...>`
  - 不提供时，服务器会用 cookie 生成一个随机 session（对服务端集成不友好）。

### API 列表

以下路径均以 `http(s)://<host>:<port>` 为前缀（例如 `http://127.0.0.1:3000`）。

- **列出实例**
  - `GET /api/instances`
  - 返回：`AgentInstance[]`（数组）

- **运行（向线程发送任务/消息）**
  - `POST /api/run`
  - Body：
    - `content`：string（必填）
    - `thread_id`：string（可选；不填表示当前 session 的 `active`）
    - `attachments`：`[{ path, filename?, mime_type? }]`（可选）
  - 返回：`HubResult`

- **线程动作**
  - `POST /api/kill`，Body：`{ thread_id?: string }`
  - `POST /api/reboot`，Body：`{ thread_id?: string }`
  - `POST /api/detach`，Body：`{ thread_id?: string }`
  - 返回：`HubResult`

- **Spawn（创建新线程/实例）**
  - `POST /api/spawn`
  - Body：
    - `type`: `"claude" | "codex" | "gemini" | "cursor"`（默认 `"codex"`）
    - `mode`: `"bridge" | "pane_bridge"`（默认 `"pane_bridge"`）
    - `auto_approve`: boolean（默认 `false`）
    - `repo`: string（可选；`AGENT_WORKDIR` 下的相对目录名，Web 侧用于 picker）
    - `spawn_dir`: string（可选；绝对路径，但**必须在** `AGENT_WORKDIR` 之下；`repo` 与 `spawn_dir` 二选一）
  - 返回：`HubResult`（成功时会包含新 `thread_id`，并可能带 GUI 快捷按钮信息）

- **进度快照**
  - `GET /api/progress/<thread_id>`
  - 返回：`ThreadProgressSnapshot`（或 404/502）

- **终端输入（审批/选择等）**
  - `POST /api/terminal_input`
  - Body：`{ thread_id?: string, content: string }`
  - 返回：`HubResult`

- **Push 开关（线程完成/输出主动推送到当前 session）**
  - `POST /api/push`
  - Body：`{ thread_id?: string, enabled?: boolean }`
  - 返回：`HubResult`

- **模型列表 / 切换模型**
  - `GET /api/models?thread_id=<thread_id>`
  - `POST /api/models`，Body：`{ thread_id: string, model_id: string }`

- **文件浏览/读写（基于线程 working_dir）**
  - `GET /api/files?thread_id=<thread_id>&depth=<1..12>`
  - `GET /api/file?thread_id=<thread_id>&path=<relative_path>`
  - `POST /api/file`，Body：`{ thread_id: string, path: string, content: string }`

- **历史**
  - `GET /api/history?thread_id=<thread_id>`
  - `GET /api/history_threads`（等价于全局 history）

- **日志（Web GUI 运行目录的日志查看/清空）**
  - `GET /api/logs`
  - `GET /api/log_file?path=<relative_log_path>`
  - `POST /api/log_file/clear`，Body：`{ path: "<relative>.log" }`

- **pane capture interval（调节 pane_bridge 捕获频率）**
  - `GET /api/capture_interval`
  - `POST /api/capture_interval`，Body：`{ interval_ms: 2000..30000 }`

### WebSocket：订阅线程 pane 输出（用于类终端流式展示）

- 路径：`GET /ws/terminal?thread_id=<thread_id>&replay_lines=<n>`
- 这是标准 WebSocket 升级；鉴权同上（Bearer 或 `?token=`）。
- 服务端会把 Hub 的 `pane_output`（以及部分 A2A websocket 消息）桥接到 WebSocket 文本帧。

---

## 2) Hub IPC（Unix socket）直接调用

当你无法/不想暴露 HTTP 服务时，可以直接对 Hub 的 `HUB_SOCKET_PATH` 发消息。

### 关键环境变量

- `HUB_SOCKET_PATH`：默认 `/tmp/hub-core.sock`

### 消息格式：HubMessage / HubResult

核心类型定义见 `src/types.ts`（Zod schema）。

#### HubMessage（请求）

- **传输**：向 `HUB_SOCKET_PATH` 建立连接，写入一段 JSON 字符串并关闭连接。
  - Hub 也支持以 `\n` 分帧的多帧模式，但对常规请求你无需使用。
- **必须字段（最小可用集合）**：
  - `trace_id`: UUID（由调用方生成）
  - `thread_id`: string（例如具体线程 id；也可用 `"global"` / `"pending"` / `"active"` 作为选择器）
  - `actor_id`: string（建议用你的服务名，如 `"svc:billing"` / `"socket:myservice"`）
  - `intent`: string（内置 intents 见下）
  - `target`: string（通常是线程 id 或 `"active"` / `"all"`）
  - `payload`: `{ content, attachments, reply_to?, spawn_dir?, auto_approve?, monitor_updates_enabled?, ... }`
  - `mode`: `"bridge" | "pane_bridge"`（多数控制类 intent 用 `"bridge"` 即可）
  - `reply_channel`: 见下

#### reply_channel（HubResult 回传通道）

Meridian 支持三类回传通道：

- `telegram`：给 Telegram bot 用
- `web`：给 Web GUI 用
- **`socket`（给其他服务用）**：你要用的通道

当你希望 Hub 将结果**回推到你的服务**，请设置：

- `reply_channel.channel = "socket"`
- `reply_channel.chat_id = "<anything>"`（用于标识会话；建议 `<service>:<instance>`）
- `reply_channel.socket_path = "<你的 unix socket 路径>"`（Hub 会向这个 socket 发 `HubResult` JSON）

如果你只想“请求-响应”（同步拿到返回），可采用“IPC request”方式：发起方等待 socket 返回体并解析为 `HubResult`（与 Web 服务内部的做法一致）。

> 备注：Hub 的“请求-响应”超时时间在调用侧实现中默认是 120s（见 `src/shared/ipc.ts`），长任务建议用 `monitor_manual_update` 拉取进度或用 WebSocket/push。

### 内置 intents（常用）

内置 intents 列表见 `src/types.ts` 的 `BUILT_IN_INTENTS`，其中常用的有：

- **`spawn`**：创建线程
- **`run`**：向线程发送任务/消息
- **`terminal_input`**：向线程发送终端输入（审批/选择）
- **`status`**：查询线程状态
- **`list`**：列出所有活跃实例
- **`list_reply_channels`**：列出 Hub 当前已知的 `ReplyChannel[]`（JSON 字符串）
- **`kill`** / **`reboot`** / **`restart`** / **`detach`** / **`attach`**
- **`gui`**：获取 Web GUI 链接信息（通常会在返回里带 inline keyboard/url）
- **`list_models`** / **`switch_model`**
- **`monitor_update`** / **`monitor_manual_update`**
- **`push`**：控制主动推送
- **`history`** / **`detail`**
- **`register_service`** / **`unregister_service`**：自定义 intents 扩展注册
- **`reply`**：向指定 `reply_channel` 发送最终回执文本（`payload.content`）

---

## 3) 扩展：让你的服务接管自定义 intents

Meridian Hub 支持把**非内置** intent 转发到外部服务（Unix socket），实现 A2A/协调器式扩展。

### 3.1 静态注册（环境变量）

在 Meridian 启动时静态注册一个外部服务端点：

- `COORDINATOR_SOCKET_PATH=/tmp/coordinator.sock`
- `COORDINATOR_INTENTS=delegate,plan,review`（示例）

当 Hub 收到这些 intent，会转发到该 socket。

### 3.2 动态注册（运行时）

向 Hub 发送 `register_service` intent，payload.content 需要是 JSON 字符串，至少包含：

- `service`: string（可选；默认 `"service"`，建议显式写）
- `socket_path`: string（必填；你的服务监听的 unix socket）
- `agent_card.skills[].intents[]`: string[]（可选；Hub 会从这里提取 intents）

取消注册用 `unregister_service`，payload.content 为：`{ "service": "<serviceId>" }`

### 3.3 你的服务需要实现什么

你的服务需要监听一个 unix socket（`socket_path`），并实现：

- **输入**：读取一段 JSON（Hub 会发送 `HubMessage`）
- **输出**：返回一段 JSON（必须是 `HubResult`，Hub 会解析并继续回传给原始调用方）

---

## 4) 典型调用流程（建议）

### 4.1 “无状态服务”模式（HTTP）

- `POST /api/spawn` 创建线程
- `POST /api/run` 下发任务（保存返回的 `thread_id` / `trace_id`）
- 轮询 `GET /api/progress/<thread_id>` 获取进度
- 如遇审批：`POST /api/terminal_input` 发送 `"all"` / `"allow"` / 数字等输入
- 任务完成后：读取 `HubResult.content`，必要时 `GET /api/history`

### 4.2 “强集成服务”模式（socket push）

- 你的服务监听 `unix socket`，作为 `reply_channel.channel="socket"` 的接收端
- 通过 Hub IPC 发送请求，并在自己的 socket 收到 `HubResult`
- 用 `monitor_update`/`push` 订阅主动推送（适合把 Meridian 作为执行器/代理层）

---

## 5) 常见错误与排查

- **401 Unauthorized（Web）**
  - 确认 `Authorization: Bearer <WEB_GUI_TOKEN>` 或 `?token=` 正确。
- **“Hub is not reachable”**
  - Hub 未启动或 `HUB_SOCKET_PATH` 不一致；默认是 `/tmp/hub-core.sock`。
- **“No active agent session — spawn or attach one first.”**
  - 你对 `thread_id="active"` 发送了 `run`，但该 session 没有 active thread；先 `spawn` 或显式指定 `thread_id`。
- **超时**
  - 长任务用 `monitor_manual_update` 拉进度或使用 WebSocket `/ws/terminal` 观看输出。

---

## 7) Spawn / Provider 就绪依赖（readiness）

`spawn` 的 API/intent 只是“声明性入口”，是否能成功拉起实例取决于对应 provider 的运行时是否就绪（本机二进制、登录态、API key 等）。在集成层面建议把失败视为“环境未就绪”，并在错误中提示运维修复。

### 一键自检（推荐）

仓库自带脚本会做**不泄露密钥**的就绪性检查（只输出 set/unset、present/missing、logged-in/not-logged-in）：

```bash
./scripts/readiness_check.sh
```

常见依赖项（按 `src/config.ts`）：

- **Claude**：通常需要 `ANTHROPIC_API_KEY`
- **Codex/OpenAI**：可能需要 `OPENAI_API_KEY`
  - 在部分环境中 Codex 会优先使用本地 `codex app-server` 的登录态进行模型枚举/会话（若不可用才回退到 `OPENAI_API_KEY`）
- **Gemini**：通常需要 `GEMINI_API_KEY`
- **Cursor**：通常需要 `CURSOR_API_KEY`

并且 Hub 在 spawn/run 路径会依赖本项目的 `bin/agentapi`（以及其支持的 `--socket/--port` 等 flag）；如果该二进制缺失或不兼容，会导致 spawn 失败。

---

## 6) 参考实现位置（代码导航）

- **Hub IPC**：`src/shared/ipc.ts`
- **Hub socket server**：`src/hub/server.ts`
- **Hub intents 路由**：`src/hub/router.ts`
- **Web API / WebSocket**：`src/web/server.ts`
- **类型定义（HubMessage/HubResult/Intent）**：`src/types.ts`

