# MERIDIAN v2.0

## AI Coding Agent TaskSpec

*Codex / 多 Worker 并行研发规格说明书*

版本：v1.0 \| 日期：2026-03

# 0 文档说明与阅读指引

本文档面向 Codex AI Coding Agent（以下简称 "Agent"）及人工验收人员，完整描述 Meridian v2.0 的研发任务拆解、并发执行策略、自动化测试要求与人工验收手册。

本 TaskSpec 对应代码仓库：Meridian-main（当前 v1.0 代码基），目标升级为 v2.0。

文档结构

| **章节** | **内容**                         | **面向读者** |
|----------|----------------------------------|--------------|
| §1       | 任务总览 & 工程背景              | Agent + 人工 |
| §2       | 任务 JSON 定义（全量 Task List） | Agent        |
| §3       | Worker 分配 & 执行工作流         | Agent        |
| §4       | 自动化测试规格（Agent 编写）     | Agent        |
| §5       | 人工验收手册（非技术语言）       | 人工验收     |

> **⚠️ 重要约束（Agent 必读）**
>
> • 每个 Task 的 context_files 列出了该 Task 需要阅读的源文件，Agent 必须先读取再修改。
>
> • 带有 depends_on 字段的 Task 必须在依赖 Task 的 tests_pass=true 后才能开始。
>
> • 所有新增代码必须有对应单元测试（\*.test.ts），测试覆盖率目标 ≥ 80%。
>
> • 修改 types.ts / config.ts 时，必须同步更新 .env.example 和相关 README。

# 1 工程背景与升级目标

## 1.1 Meridian 在整体架构中的定位

Meridian 是 ai_arch_v3 体系中的「CallHub — 唯一控制平面」。所有外部渠道（Telegram、Web）发起的请求，都通过 Interface Layer 转化为 HubMessage，再由 Hub 路由到对应的 Agent 或 Service。

当前 v1.0 实现更接近「Telegram → agentapi 智能代理」，缺少 Hub 作为控制平面应有的可扩展性结构。v2.0 的核心目标是：

- 修复 v1.0 的 12 项已确认差距（Part A）

- 新增 Web GUI 界面层，实现手机浏览器可操控（Part B）

- 补充 Hub 控制平面的结构性能力（Supplement S1）

## 1.2 v2.0 交付范围速览

| **模块代码** | **模块名称**                         | **来源**     | **优先级** |
|--------------|--------------------------------------|--------------|------------|
| C-01         | Unix Socket IPC（替代 TCP）          | Part A P1    | P1         |
| C-02         | Webhook 生产模式支持                 | Part A P1    | P1         |
| C-03         | /detach & /reboot 命令               | Part A P1/P2 | P1         |
| C-04         | Router 新增处理器 + attachments      | Part A P2    | P2         |
| C-05         | 长文本文件发送 + 附件输出            | Part A P2    | P2         |
| C-06         | thread_id 查询脚本                   | Part A P2    | P2         |
| C-07         | Web Interface Server                 | Part B       | P1         |
| C-08         | Web GUI 前端                         | Part B       | P1         |
| C-09         | WebSocket 终端桥（IPC 推送）         | Part B + S1  | P1         |
| C-10         | Telegram Deep Link / Inline Keyboard | Part B       | P2         |
| C-11         | Callback Query + /gui 命令           | Part B       | P2         |
| C-12         | 配置层（所有新增环境变量）           | Part A+B     | P1         |
| S-02         | Service Registry（intent 路由解耦）  | S1           | P1         |
| S-03         | actor_id 多来源会话隔离              | S1           | P1         |
| S-04         | Pane Log IPC 推送（Hub 内部推送）    | S1           | P1         |
| S-05         | Idempotency 幂等去重                 | S1           | P2         |
| S-06         | Priority Queue 优先级调度            | S1           | P2         |
| S-07         | span_id 嵌套追踪字段                 | S1           | P2         |

# 2 任务 JSON 定义（Task List）

以下每个 Task 对象代表分配给 Agent 的一个最小可执行工作单元。格式说明：

- task_id：唯一标识，格式 T-XX

- worker：分配到哪个并行 Worker（见 §3）

- depends_on：必须先完成的 task_id 列表，为空则可立即开始

- context_files：Agent 执行此 Task 必须先阅读的文件路径列表

- deliverables：Agent 必须输出的文件或代码变更清单

- acceptance_criteria：可被自动测试或人工核查的验收条件

## T-01 配置层扩展

> {
>
> "task_id": "T-01",
>
> "worker": "W1",
>
> "priority": "P1",
>
> "title": "扩展 config.ts，增加 v2.0 所有新增环境变量",
>
> "depends_on": \[\],
>
> "context_files": \[
>
> "src/config.ts",
>
> ".env.example"
>
> \],
>
> "deliverables": \[
>
> "src/config.ts（新增 WEBHOOK_URL / WEBHOOK_PORT / WEBHOOK_SECRET_TOKEN /",
>
> "WEB_GUI_ENABLED / WEB_GUI_PORT / WEB_GUI_HOST / WEB_GUI_TOKEN /",
>
> "WEB_GUI_HTTPS / TLS_CERT_PATH / TLS_KEY_PATH 共 10 项）",
>
> ".env.example（同步更新，含注释说明）"
>
> \],
>
> "acceptance_criteria": \[
>
> "所有新增字段有 Zod schema 类型定义",
>
> "可选字段有明确的 default 值",
>
> "ts 编译无 error"
>
> \]
>
> }

## T-02 Unix Socket IPC 替代 TCP

> {
>
> "task_id": "T-02",
>
> "worker": "W1",
>
> "priority": "P1",
>
> "title": "Hub↔agentapi 通信从 TCP 切换为 Unix Domain Socket",
>
> "depends_on": \["T-01"\],
>
> "context_files": \[
>
> "src/hub/instance-manager.ts",
>
> "src/shared/agentapi-client.ts",
>
> "src/hub/registry.ts",
>
> "src/types.ts"
>
> \],
>
> "changes": \[
>
> "spawnInternal()：formatAgentEndpoint(port) → formatAgentSocketPath(threadId)",
>
> "agentapi spawn 参数：--port={port} → --socket={socketPath}",
>
> "socket_path 注册表字段存入 /tmp/agentapi-{threadId}.sock",
>
> "killInternal()：清理 socket 文件逻辑已兼容，确认无需修改",
>
> "废弃 allocateAvailablePort()，默认实现改为 socket path 生成"
>
> \],
>
> "deliverables": \[
>
> "src/hub/instance-manager.ts",
>
> "src/hub/instance-manager.test.ts（更新测试）"
>
> \],
>
> "acceptance_criteria": \[
>
> "spawn 后 /tmp/agentapi-{threadId}.sock 文件存在",
>
> "netstat 无新 TCP 端口占用",
>
> "kill 后 socket 文件被清理"
>
> \]
>
> }

## T-03 types.ts Schema 扩展

> {
>
> "task_id": "T-03",
>
> "worker": "W2",
>
> "priority": "P1",
>
> "title": "扩展 types.ts：IntentSchema + HubMessage + MonitorEvent",
>
> "depends_on": \[\],
>
> "context_files": \[
>
> "src/types.ts"
>
> \],
>
> "changes": \[
>
> "IntentSchema 增加 detach, reboot 枚举项",
>
> "HubMessageSchema 增加 idempotency_key（可选）、priority（可选，0-9 默认 5）",
>
> "HubMessageSchema 增加 span_id、parent_span_id（可选 uuid）",
>
> "HubMessage.chat_id 格式变更为 {channel}:{id} 复合 key（actor_id 隔离）",
>
> "MonitorEventSchema 增加 span_id、parent_span_id（可选）",
>
> "新增 PaneSubscribeRequest、PaneOutputChunk、PaneUnsubscribeRequest 类型",
>
> "新增 ServiceEndpoint interface"
>
> \],
>
> "deliverables": \["src/types.ts"\],
>
> "acceptance_criteria": \[
>
> "ts 编译无 error",
>
> "Zod parse 对所有新字段有正确类型推断",
>
> "现有测试不因 schema 扩展而 break（新字段均为 optional）"
>
> \]
>
> }

## T-04 Service Registry（Hub 路由解耦）

> {
>
> "task_id": "T-04",
>
> "worker": "W2",
>
> "priority": "P1",
>
> "title": "实现 ServiceRegistry，Router 从硬编码 switch-case 改为查表路由",
>
> "depends_on": \["T-03"\],
>
> "context_files": \[
>
> "src/hub/router.ts",
>
> "src/hub/server.ts",
>
> "src/types.ts",
>
> "src/config.ts"
>
> \],
>
> "changes": \[
>
> "新建 src/hub/service-registry.ts：ServiceRegistry class",
>
> "register() / unregister() / resolve(intent) / list()",
>
> "router.ts routeByIntent()：内置 intent 优先，其次查 Registry，最后 fallback",
>
> "hub/server.ts 启动时读取 COORDINATOR_SOCKET_PATH/COORDINATOR_INTENTS 静态配置",
>
> "Phase 1：静态配置注册；动态注册预留接口不实现"
>
> \],
>
> "deliverables": \[
>
> "src/hub/service-registry.ts",
>
> "src/hub/service-registry.test.ts",
>
> "src/hub/router.ts（修改）"
>
> \],
>
> "acceptance_criteria": \[
>
> "resolve() 对已注册 intent 返回 endpoint",
>
> "resolve() 对未注册 intent 返回 null",
>
> "内置 intent（spawn/kill/attach/detach 等）不经过 Registry"
>
> \]
>
> }

## T-05 actor_id 多来源会话隔离

> {
>
> "task_id": "T-05",
>
> "worker": "W2",
>
> "priority": "P1",
>
> "title": "session key 改为 {channel}:{chat_id} 复合格式，actor_id 真实注入",
>
> "depends_on": \["T-03"\],
>
> "context_files": \[
>
> "src/hub/router.ts",
>
> "src/interface/bot.ts",
>
> "src/interface/ipc-sender.ts",
>
> "src/types.ts"
>
> \],
>
> "changes": \[
>
> "Telegram Interface：chat_id = telegram: + update.message.chat.id",
>
> "hub/router.ts：sessionThreadBySession key 直接使用 chat_id 字段（无需改 Router）",
>
> "bot.ts：actor_id 从 Telegram User ID 真实注入（tg:{userId}）",
>
> "Web Interface（T-10 实现时）：chat_id = web:{sessionId}"
>
> \],
>
> "deliverables": \[
>
> "src/interface/bot.ts",
>
> "src/interface/ipc-sender.ts"
>
> \],
>
> "acceptance_criteria": \[
>
> "Telegram 和 Web GUI 同时 attach 不同实例，互不干扰",
>
> "日志中 actor_id 字段为真实来源值（非固定 owner）"
>
> \]
>
> }

## T-06 Slash 命令扩展（/detach / /reboot / /gui）

> {
>
> "task_id": "T-06",
>
> "worker": "W1",
>
> "priority": "P1",
>
> "title": "新增 /detach、/reboot、/gui 命令；/restart 语义澄清",
>
> "depends_on": \["T-03"\],
>
> "context_files": \[
>
> "src/interface/slash-handler.ts",
>
> "src/hub/router.ts",
>
> "src/types.ts"
>
> \],
>
> "changes": \[
>
> "slash-handler.ts：/detach \[thread=\<id\>\]，intent: detach",
>
> "slash-handler.ts：/reboot thread=\<id\>，intent: reboot",
>
> "slash-handler.ts：/gui \[thread=\<id\>\]，intent: gui",
>
> "/restart 描述更新为「重建并重启 Meridian 服务」",
>
> "HELP_MESSAGE 更新，加入三条新命令说明",
>
> "router.ts：handleDetach() → instanceManager.detach()",
>
> "router.ts：handleReboot() → instanceManager.restart()",
>
> "router.ts：handleGui() → 返回 Web GUI 链接（需 WEB_GUI_HOST 配置）"
>
> \],
>
> "deliverables": \[
>
> "src/interface/slash-handler.ts",
>
> "src/interface/slash-handler.test.ts",
>
> "src/hub/router.ts"
>
> \],
>
> "acceptance_criteria": \[
>
> "/detach 解除绑定，再发消息返回无 attach 实例错误",
>
> "/reboot 保持 thread_id，pid 更新",
>
> "/gui 回复包含可点击链接"
>
> \]
>
> }

## T-07 Webhook 生产模式支持

> {
>
> "task_id": "T-07",
>
> "worker": "W1",
>
> "priority": "P1",
>
> "title": "Interface Layer 支持 Long Polling / Webhook 双模式",
>
> "depends_on": \["T-01"\],
>
> "context_files": \[
>
> "src/interface/index.ts",
>
> "src/interface/bot.ts",
>
> "src/config.ts"
>
> \],
>
> "changes": \[
>
> "interface/index.ts：WEBHOOK_URL 存在时 bot.start({ webhook: {...} })",
>
> "无 WEBHOOK_URL 时保持 Long Polling（bot.start()）",
>
> "添加 /webhook 路由处理 Telegram 推送",
>
> "README 补充 Webhook 部署说明"
>
> \],
>
> "deliverables": \[
>
> "src/interface/index.ts",
>
> "README.md（Webhook 部分）"
>
> \],
>
> "acceptance_criteria": \[
>
> "WEBHOOK_URL=https://... 启动后 Telegram 可发消息收到回复",
>
> "不设 WEBHOOK_URL 时 Long Polling 正常工作（兼容性不破坏）"
>
> \]
>
> }

## T-08 Result Sender 增强（长文本文件化 + 附件输出）

> {
>
> "task_id": "T-08",
>
> "worker": "W1",
>
> "priority": "P2",
>
> "title": "长文本以 .txt 文件发送；Agent 输出文件纳入 HubResult.attachments",
>
> "depends_on": \["T-03"\],
>
> "context_files": \[
>
> "src/hub/result-sender.ts",
>
> "src/hub/router.ts"
>
> \],
>
> "changes": \[
>
> "result-sender.ts：sendLongTextInChunks() → sendContentAsFile()",
>
> "sendContentAsFile()：写入 /tmp/meridian-{traceId}.txt，sendDocumentWithRetry()，删除临时文件",
>
> "TELEGRAM_TEXT_LIMIT = 4096",
>
> "router.ts：buildResult() 系列接受 attachments 参数",
>
> "handleRun()：解析 agentapi result.files 字段，填充 HubResult.attachments"
>
> \],
>
> "deliverables": \[
>
> "src/hub/result-sender.ts",
>
> "src/hub/result-sender.test.ts",
>
> "src/hub/router.ts"
>
> \],
>
> "acceptance_criteria": \[
>
> "超 4096 字符内容收到 .txt 文件消息",
>
> "Agent 生成代码文件后 Telegram 收到对应文件消息"
>
> \]
>
> }

## T-09 thread_id 查询脚本

> {
>
> "task_id": "T-09",
>
> "worker": "W2",
>
> "priority": "P2",
>
> "title": "user_scripts/query_thread.sh：按 thread_id 查询会话历史",
>
> "depends_on": \[\],
>
> "context_files": \[
>
> "user_scripts/verify_logs.sh"
>
> \],
>
> "changes": \[
>
> "新建 user_scripts/query_thread.sh \<thread_id\>",
>
> "从 Pino 结构化日志 grep + jq 过滤 thread_id 字段",
>
> "输出格式：timestamp \| trace_id \| intent \| status \| content_preview"
>
> \],
>
> "deliverables": \["user_scripts/query_thread.sh"\],
>
> "acceptance_criteria": \[
>
> "执行脚本输出包含该 thread 下所有指令的时间线",
>
> "输出字段完整（timestamp/trace_id/intent/status/preview）"
>
> \]
>
> }

## T-10 Web Interface Server（HTTP + WebSocket + 鉴权）

> {
>
> "task_id": "T-10",
>
> "worker": "W3",
>
> "priority": "P1",
>
> "title": "新建 Web Interface Server：HTTP/WS 服务器 + Bearer Token 鉴权 + IPC 代理",
>
> "depends_on": \["T-01", "T-03", "T-04", "T-05"\],
>
> "context_files": \[
>
> "src/interface/index.ts",
>
> "src/interface/ipc-sender.ts",
>
> "src/hub/server.ts",
>
> "src/config.ts",
>
> "src/types.ts"
>
> \],
>
> "changes": \[
>
> "新建 src/web/server.ts：Express/Node.js HTTP 服务器",
>
> "监听 WEB_GUI_PORT（默认 3000）",
>
> "认证中间件：验证 Bearer Token 或 ?token= query param",
>
> "REST API：GET /api/instances → 调用 Hub IPC，返回实例列表",
>
> "REST API：POST /api/run（发送指令）、POST /api/kill、POST /api/reboot、POST /api/detach",
>
> "WebSocket 端点：ws://host/ws/terminal?thread_id=xxx",
>
> "静态文件 serve：src/web/public/",
>
> "WEB_GUI_ENABLED=false 时不启动（config 门控）"
>
> \],
>
> "deliverables": \[
>
> "src/web/server.ts",
>
> "src/web/server.test.ts"
>
> \],
>
> "acceptance_criteria": \[
>
> "无 Token 请求返回 HTTP 401",
>
> "有效 Token 可访问 /api/instances 并返回实例列表 JSON",
>
> "WebSocket 连接建立后可收到 pane_output 推送"
>
> \]
>
> }

## T-11 Pane Log IPC 推送（Hub 内部实现）

> {
>
> "task_id": "T-11",
>
> "worker": "W2",
>
> "priority": "P1",
>
> "title": "Hub 实现 subscribe_pane_output IPC 协议，向 Web Interface 推送 pane log",
>
> "depends_on": \["T-03", "T-02"\],
>
> "context_files": \[
>
> "src/hub/server.ts",
>
> "src/hub/instance-manager.ts",
>
> "src/types.ts"
>
> \],
>
> "changes": \[
>
> "hub/server.ts：handleRawPayload 识别 subscribe_pane_output 消息",
>
> "新建 src/hub/pane-broadcaster.ts：维护订阅表，fs.watch pane log 文件",
>
> "新增内容通过订阅时的 socket 连接推送 PaneOutputChunk",
>
> "unsubscribe_pane_output 或连接断开时自动清理订阅",
>
> "bridge 模式实例：返回 { type: not_available }，Web Interface 切换轮询"
>
> \],
>
> "deliverables": \[
>
> "src/hub/pane-broadcaster.ts",
>
> "src/hub/pane-broadcaster.test.ts",
>
> "src/hub/server.ts（修改）"
>
> \],
>
> "acceptance_criteria": \[
>
> "pane_bridge 实例：订阅后新增日志内容立即推送到订阅方",
>
> "bridge 模式实例：返回 not_available 而非报错",
>
> "连接断开后 Hub 自动清理订阅，无内存泄漏"
>
> \]
>
> }

## T-12 Web GUI 前端

> {
>
> "task_id": "T-12",
>
> "worker": "W3",
>
> "priority": "P1",
>
> "title": "实现 Web GUI 前端：实例概览面板 + 终端视图 + bridge 视图 + 移动端布局",
>
> "depends_on": \["T-10", "T-11"\],
>
> "tech_stack": {
>
> "framework": "Vanilla JS 或 Preact（无构建工具依赖）",
>
> "terminal": "xterm.js v5.x（MIT）CDN 引入",
>
> "style": "Tailwind CSS CDN",
>
> "websocket": "浏览器原生 WebSocket API"
>
> },
>
> "pages": \[
>
> "index.html：实例概览面板，列表含 thread_id/type/mode/status/created_at",
>
> " 每行可点击，spawn 按钮，5 秒自动刷新",
>
> "terminal.html：pane_bridge 实例终端视图",
>
> " xterm.js 渲染，WebSocket 订阅，历史回放（最多 10000 行）",
>
> " 输入框（run 指令），Kill/Reboot/Detach 按钮",
>
> "bridge.html：bridge 模式实例简化视图",
>
> " 元数据展示，最新结果，输入框，Kill/Reboot 按钮",
>
> " 响应式布局，移动端（Safari/Chrome）优先"
>
> \],
>
> "auth": "sessionStorage 存储 token，?token= query param 初始化",
>
> "deliverables": \[
>
> "src/web/public/index.html",
>
> "src/web/public/terminal.html",
>
> "src/web/public/bridge.html",
>
> "src/web/public/app.js（共享逻辑）"
>
> \],
>
> "acceptance_criteria": \[
>
> "手机浏览器打开首页，实例列表正常渲染",
>
> "终端视图实时显示 Agent 输出",
>
> "无 token 时显示「请提供访问令牌」而非空白"
>
> \]
>
> }

## T-13 Telegram Inline Keyboard + Callback Query

> {
>
> "task_id": "T-13",
>
> "worker": "W1",
>
> "priority": "P2",
>
> "title": "spawn/attach/task_completed 回传增加 GUI 按钮；agent_error 增加 Reboot/Kill 按钮",
>
> "depends_on": \["T-06", "T-10"\],
>
> "context_files": \[
>
> "src/interface/bot.ts",
>
> "src/hub/result-sender.ts",
>
> "src/config.ts"
>
> \],
>
> "changes": \[
>
> "result-sender.ts：spawn 成功/attach 成功/task_completed 回传增加 Inline Keyboard",
>
> " 按钮：🖥 打开 GUI，链接 https://{WEB_GUI_HOST}:{WEB_GUI_PORT}/?thread={id}&token={token}",
>
> "agent_error 告警消息：🔄 Reboot ❌ Kill 按钮（callback_data 格式）",
>
> "bot.ts：注册 callbackQuery 处理器，转为 HubMessage 通过 IPC 发送"
>
> \],
>
> "deliverables": \[
>
> "src/interface/bot.ts",
>
> "src/hub/result-sender.ts"
>
> \],
>
> "acceptance_criteria": \[
>
> "spawn 成功消息含「打开 GUI」按钮",
>
> "点击 Reboot 按钮执行重启并回传确认消息",
>
> "点击 GUI 链接在手机浏览器打开对应实例页面"
>
> \]
>
> }

## T-14 Idempotency 幂等去重

> {
>
> "task_id": "T-14",
>
> "worker": "W2",
>
> "priority": "P2",
>
> "title": "Hub 实现 idempotency_key 去重，Telegram Interface 透传 message_id 作为 key",
>
> "depends_on": \["T-03", "T-05"\],
>
> "context_files": \[
>
> "src/hub/server.ts",
>
> "src/interface/ipc-sender.ts"
>
> \],
>
> "changes": \[
>
> "hub/server.ts：handleRawPayload 前置检查 idempotency_key",
>
> "TTL 5 分钟内存去重表（Map + 定时清理）",
>
> "命中时返回上次结果，写日志 Duplicate message suppressed",
>
> "Telegram Interface：raw_message_id 透传为 idempotency_key"
>
> \],
>
> "deliverables": \[
>
> "src/hub/server.ts",
>
> "src/interface/ipc-sender.ts"
>
> \],
>
> "acceptance_criteria": \[
>
> "同一 idempotency_key 发两次，Hub 只执行一次",
>
> "5 分钟后相同 key 再发，正常执行（TTL 到期）"
>
> \]
>
> }

## T-15 Priority Queue 优先级调度

> {
>
> "task_id": "T-15",
>
> "worker": "W2",
>
> "priority": "P2",
>
> "title": "HubMessage 增加 priority 字段，Hub Server 按优先级处理队列",
>
> "depends_on": \["T-03"\],
>
> "context_files": \[
>
> "src/hub/server.ts",
>
> "src/interface/slash-handler.ts"
>
> \],
>
> "changes": \[
>
> "hub/server.ts：消息队列改为优先级队列（priority 0 最高，默认 5）",
>
> "slash-handler.ts：/kill /reboot 注入 priority=0",
>
> "监控事件注入 priority=7"
>
> \],
>
> "deliverables": \[
>
> "src/hub/server.ts",
>
> "src/interface/slash-handler.ts"
>
> \],
>
> "acceptance_criteria": \[
>
> "队列繁忙时 /kill 消息仍优先处理",
>
> "低优先级消息（监控）不阻塞高优先级指令"
>
> \]
>
> }

## T-16 span_id 嵌套追踪

> {
>
> "task_id": "T-16",
>
> "worker": "W2",
>
> "priority": "P2",
>
> "title": "HubMessage 和 MonitorEvent 增加 span_id / parent_span_id，日志自动写入",
>
> "depends_on": \["T-03"\],
>
> "context_files": \[
>
> "src/hub/server.ts",
>
> "src/hub/router.ts",
>
> "src/types.ts"
>
> \],
>
> "changes": \[
>
> "接收用户消息时生成 span_id = randomUUID()",
>
> "向 Service dispatch 时，span_id 作为子调用的 parent_span_id",
>
> "所有 Pino 日志 child logger 自动包含 span_id + parent_span_id"
>
> \],
>
> "deliverables": \[
>
> "src/hub/server.ts",
>
> "src/hub/router.ts"
>
> \],
>
> "acceptance_criteria": \[
>
> "日志中每条消息含 span_id",
>
> "多层调用日志可通过 parent_span_id 还原调用树"
>
> \]
>
> }

## T-17 集成测试套件

> {
>
> "task_id": "T-17",
>
> "worker": "W4",
>
> "priority": "P1",
>
> "title": "编写端到端集成测试：覆盖 v2.0 所有 P1 验收场景",
>
> "depends_on": \["T-02","T-03","T-04","T-05","T-06","T-07","T-10","T-11","T-12"\],
>
> "test_cases": \[
>
> "V-01：Unix Socket IPC — spawn 后 socket 文件存在，kill 后清理",
>
> "V-02：Webhook 模式 — 设置 WEBHOOK_URL 后消息可收发",
>
> "V-03：/detach — attach 后 detach，再发消息返回无 attach 实例错误",
>
> "V-04：/reboot — thread_id 保持不变，pid 更新",
>
> "V-08：Web GUI 鉴权 — 无 token 返回 401，有 token 返回实例列表",
>
> "V-09：Web GUI 终端 — WebSocket 可收到 pane_output 推送",
>
> "S-02：ServiceRegistry — resolve 已注册 intent 返回 endpoint"
>
> \],
>
> "deliverables": \[
>
> "tests/integration/\*.test.ts",
>
> "tests/integration/README.md（运行说明）"
>
> \],
>
> "acceptance_criteria": \[
>
> "所有集成测试 CI 通过（npm run test:integration）",
>
> "测试覆盖率报告 ≥ 80%"
>
> \]
>
> }

# 3 Worker 分配与执行工作流

v2.0 升级涉及多个独立模块，可通过 4 个 Worker 并行执行，显著缩短交付周期。以下为推荐的并发策略。

## 3.1 Worker 职责分配

| **Worker**    | **职责范围**                                                                                          | **负责 Task**                                  | **预计工时** |
|---------------|-------------------------------------------------------------------------------------------------------|------------------------------------------------|--------------|
| W1 基础设施层 | config 扩展、Unix Socket、Webhook、Slash 命令、Result Sender、Telegram Deep Link                      | T-01, T-02, T-06, T-07, T-08, T-13             | ~8h          |
| W2 Hub 核心层 | types schema、Service Registry、actor_id 隔离、Pane Broadcaster、Idempotency、Priority Queue、span_id | T-03, T-04, T-05, T-09, T-11, T-14, T-15, T-16 | ~10h         |
| W3 Web 界面层 | Web Interface Server、Web GUI 前端（HTML/JS/CSS）                                                     | T-10, T-12                                     | ~10h         |
| W4 测试层     | 集成测试套件，在 W1/W2/W3 P1 Task 完成后启动                                                          | T-17                                           | ~4h          |

## 3.2 串行 vs 并行规则

> **并行规则：**
>
> • W1、W2、W3 可同时启动，互不阻塞（T-01/T-03 是各自 Worker 内部的前置 Task）
>
> • W4 必须等待所有 P1 Task 完成（T-02/T-03/T-04/T-05/T-06/T-07/T-10/T-11/T-12）后启动

## 3.3 执行工作流图

> 阶段 0（立即并行启动）
>
> W1: T-01（config 扩展）→ 解锁 T-02、T-07
>
> W2: T-03（types schema）→ 解锁 T-04、T-05、T-06(W1)、T-08(W1)、T-11、T-14、T-15、T-16
>
> W3: 等待 T-03 完成（~2h）
>
> 阶段 1（T-01 & T-03 完成后）
>
> W1: T-02（Unix Socket）‖ T-07（Webhook）→ 并行
>
> W1: T-06（Slash 命令，依赖 T-03）
>
> W2: T-04（Service Registry）‖ T-05（actor_id 隔离）→ 并行
>
> W2: T-11（Pane Broadcaster，依赖 T-02+T-03）
>
> W3: T-10（Web Interface Server，依赖 T-01+T-03+T-04+T-05）
>
> 阶段 2（T-10 & T-11 完成后）
>
> W3: T-12（Web GUI 前端）
>
> W1: T-08（Result Sender，依赖 T-03）
>
> W1: T-13（Telegram Deep Link，依赖 T-06+T-10）
>
> W2: T-09（query_thread.sh，无依赖，可随时）
>
> W2: T-14（Idempotency，依赖 T-03+T-05）
>
> W2: T-15（Priority Queue，依赖 T-03）
>
> W2: T-16（span_id，依赖 T-03）
>
> 阶段 3（所有 P1 Task 完成）
>
> W4: T-17（集成测试套件）

# 4 自动化测试规格

每个 Task 完成时，Agent 必须同步交付对应的自动化测试文件。以下为全量测试规格，供 Agent 编写测试用例时参考。

## 4.1 单元测试（各 Task 独立）

| **测试文件**             | **覆盖 Task** | **核心测试点**                                                                                           |
|--------------------------|---------------|----------------------------------------------------------------------------------------------------------|
| instance-manager.test.ts | T-02          | spawn 后 socket 文件存在；kill 后 socket 文件删除；socket path 格式符合 /tmp/agentapi-{id}.sock          |
| service-registry.test.ts | T-04          | register/unregister/resolve/list 基本 CRUD；resolve 未注册 intent 返回 null；内置 intent 不进入 Registry |
| slash-handler.test.ts    | T-06          | /detach 解析正确 intent；/reboot 解析 thread_id；/gui 返回链接格式                                       |
| result-sender.test.ts    | T-08          | ≤4096 字符：sendMessage；\>4096 字符：sendDocument；attachments 非空时发送文件                           |
| pane-broadcaster.test.ts | T-11          | 订阅后新增日志触发推送；bridge 模式返回 not_available；连接断开自动清理                                  |
| server.test.ts（Web）    | T-10          | 无 token 返回 401；有效 token 返回 200；WebSocket 握手成功                                               |
| idempotency.test.ts      | T-14          | 相同 key 两次请求只执行一次；TTL 后重复 key 正常执行                                                     |

## 4.2 集成测试（T-17，所有 P1 完成后）

| **测试 ID** | **场景**               | **断言条件**                                                       |
|-------------|------------------------|--------------------------------------------------------------------|
| INT-01      | Unix Socket 全流程     | spawn → socket 文件 → 发指令 → 收结果 → kill → socket 清理         |
| INT-02      | Webhook 双模式         | WEBHOOK_URL 设置时 Webhook 模式启动；不设置时 Long Polling 启动    |
| INT-03      | detach/attach 生命周期 | attach → detach → 发消息报错 → re-attach → 正常                    |
| INT-04      | reboot 保持 thread_id  | spawn → reboot → thread_id 相同，pid 不同，新指令可执行            |
| INT-05      | Web GUI 鉴权流程       | 无 token 401；?token= 方式 200；Header 方式 200                    |
| INT-06      | WebSocket 终端推送     | 订阅 pane_bridge 实例 → 写入 pane log → WebSocket 客户端收到 chunk |
| INT-07      | actor_id 隔离          | Telegram 和 Web 分别 attach 不同实例 → 两个 session 互不干扰       |
| INT-08      | Idempotency            | 相同 message_id 发两次 → Hub 日志只有一次 handleRun                |
| INT-09      | Priority Queue         | 队列繁忙（10 条低优先级）→ /kill 仍优先处理                        |
| INT-10      | ServiceRegistry 路由   | 注册 external_service → 发对应 intent → 路由到外部 socket          |

## 4.3 测试运行命令

> \# 单元测试
>
> npm run test
>
> \# 集成测试
>
> npm run test:integration
>
> \# 覆盖率报告
>
> npm run test:coverage
>
> \# 类型检查
>
> npm run typecheck
>
> \# 全量 CI
>
> npm run ci

# 5 人工验收手册

> **📋 阅读说明（非技术人员）**
>
> 本章节使用日常语言描述每一项验收测试。每项测试说明了：
>
> • 【是什么】这个功能的作用
>
> • 【怎么测】具体操作步骤
>
> • 【预期结果】测试通过的判断标准
>
> • 【预先配置】测试前需要准备的事项
>
> • 【为什么重要】这个功能的意义

## V-01 内部通信方式升级（Unix Socket）

| **项目**   | **内容**                                                                                                                                                                                                                                   |
|------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| 是什么     | 系统内部两个模块之间的通信方式从「网络端口」改为「本地文件通道」，类似从对讲机换成内部对讲系统，更快更安全。                                                                                                                               |
| 预先配置   | 1\. 确保系统已启动 Meridian 服务 2. 确保能访问终端命令行                                                                                                                                                                                   |
| 测试步骤   | 1\. 在 Telegram 发送 /spawn type=claude mode=bridge 2. 等待收到"实例创建成功"回复 3. 在终端输入：ls /tmp/agentapi-\*.sock 4. 在终端输入：netstat -an \| grep LISTEN（检查新 TCP 端口） 5. 发送 /kill thread=claude_01，再次检查 /tmp/ 目录 |
| 预期结果   | • 步骤 3：/tmp/ 下出现对应 .sock 文件（如 /tmp/agentapi-claude_01.sock） • 步骤 4：无新增 TCP 端口（3001/3002 等不出现） • 步骤 5：.sock 文件消失（已清理）                                                                                |
| 为什么重要 | 确保系统内部通信符合设计规范，避免占用网络端口，为后续多服务接入打好基础。                                                                                                                                                                 |

## V-02 Telegram 消息接收方式（Webhook 生产模式）

| **项目**                      | **内容**                                                                                                                                                        |
|-------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------|
| 是什么                        | 系统接收 Telegram 消息有两种方式：「轮询」（系统主动去问有没有新消息）和「Webhook」（Telegram 有新消息直接推送过来）。生产环境应使用 Webhook 方式，更高效稳定。 |
| 预先配置                      | 1\. 准备一个对外可访问的 HTTPS 域名（如 https://meridian.example.com） 2. 在 .env 中设置 WEBHOOK_URL=https://meridian.example.com/webhook 3. 重启 Meridian 服务 |
| 测试步骤（Webhook 模式）      | 1\. 在 Telegram 向 Bot 发送任意消息（如 /status） 2. 检查是否收到回复 3. 查看日志，确认有 "webhook mode" 字样                                                   |
| 测试步骤（Long Polling 模式） | 1\. 移除 WEBHOOK_URL 配置，重启服务 2. 再次在 Telegram 发消息，确认仍能收到回复                                                                                 |
| 预期结果                      | • Webhook 模式：消息收发正常，日志显示 webhook mode • Long Polling 模式：消息收发正常，无报错（两种模式均可用）                                                 |
| 为什么重要                    | 生产环境中 Webhook 延迟低、资源消耗少；开发环境保持轮询方便本地调试。两种模式都必须工作。                                                                       |

## V-03 实例解绑命令（/detach）

| **项目**   | **内容**                                                                                                                                                                                                                      |
|------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| 是什么     | "/detach" 命令让当前 Telegram 对话与某个 AI 实例"解绑"——实例继续运行，但不再接收来自这个对话的消息。就像把电话挂断，但对方机器还在运行。                                                                                      |
| 预先配置   | 无特殊配置，Meridian 正常运行即可                                                                                                                                                                                             |
| 测试步骤   | 1\. 发送 /spawn type=claude mode=bridge，等待创建成功 2. 发送 /attach thread=claude_01，绑定实例 3. 发送 /detach，解绑 4. 直接发一条普通消息（如"你好"） 5. 再次发送 /attach thread=claude_01，重新绑定 6. 再次发一条普通消息 |
| 预期结果   | • 步骤 3 后：收到"已解绑"确认消息 • 步骤 4：收到"当前没有绑定实例"错误提示，消息未被转发给 AI • 步骤 6：消息正常发给 AI，AI 正常回复                                                                                          |
| 为什么重要 | 操作者可以随时切换关注的实例，避免消息误发。是多实例管理的基础能力。                                                                                                                                                          |

## V-04 实例重启命令（/reboot）

| **项目**   | **内容**                                                                                                                                                    |
|------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------|
| 是什么     | "/reboot" 命令重启指定 AI 实例，相当于「关了再开」，但实例的编号（thread_id）保持不变。这与 "/restart" 不同——/restart 是重启整个 Meridian 系统服务。        |
| 预先配置   | 无特殊配置，有一个正在运行的实例即可                                                                                                                        |
| 测试步骤   | 1\. 发送 /status thread=claude_01，记录当前 PID 2. 发送 /reboot thread=claude_01 3. 等待 5 秒，再次发送 /status thread=claude_01 4. 对比两次 /status 的结果 |
| 预期结果   | • 步骤 2 后：收到"实例正在重启"提示 • 步骤 3 后：thread_id 仍为 claude_01（不变），但 PID 已更新（变了） • 实例可正常接受新指令                             |
| 为什么重要 | 实例卡住或出错时，可以快速重启而不影响任务编号，方便后续追踪和恢复。                                                                                        |

## V-05 长内容自动转文件发送

| **项目**   | **内容**                                                                                                                                                   |
|------------|------------------------------------------------------------------------------------------------------------------------------------------------------------|
| 是什么     | 当 AI 的回复内容超过 4096 个字符时，系统自动将内容保存为 .txt 文件发送，而不是发多条拆分的文字消息。效果像邮件附件，更整洁易读。                           |
| 预先配置   | 有一个正在运行的 AI 实例，并已绑定（/attach）                                                                                                              |
| 测试步骤   | 1\. 发送指令让 AI 生成长内容（如："请写一篇 5000 字的技术文章"或 "列举 200 个 JavaScript 函数示例"） 2. 等待 AI 完成回复 3. 观察 Telegram 中收到的消息类型 |
| 预期结果   | • 收到一个 .txt 文件附件（而非多条文字消息） • 文件可正常下载和打开 • 文件内容完整（无截断）                                                               |
| 为什么重要 | 避免 Telegram 刷屏，长内容以文件形式发送便于保存和阅读，提升用户体验。                                                                                     |

## V-06 AI 生成文件的发送

| **项目**   | **内容**                                                                                                                   |
|------------|----------------------------------------------------------------------------------------------------------------------------|
| 是什么     | 当 AI 生成了代码文件、差异补丁（diff）、报告文档等产出物时，这些文件会自动通过 Telegram 发送给操作者，而不仅仅是文字描述。 |
| 预先配置   | 有一个正在运行的 claude 或 codex 实例，并已绑定                                                                            |
| 测试步骤   | 1\. 发送指令让 AI 生成代码文件（如："创建一个 hello.py 文件"） 2. 等待 AI 完成 3. 观察 Telegram 消息                       |
| 预期结果   | • 收到一个文件消息（hello.py） • 文件名与 AI 生成的文件名一致 • 文件内容正确                                               |
| 为什么重要 | 直接接收 AI 的输出文件，无需 SSH 到服务器取文件，大幅提升工作效率。                                                        |

## V-07 会话历史查询（按实例 ID）

| **项目**   | **内容**                                                                                                                      |
|------------|-------------------------------------------------------------------------------------------------------------------------------|
| 是什么     | 提供一个命令行脚本，可以按"实例编号"查看该实例处理过的所有指令历史，类似查看聊天记录。                                        |
| 预先配置   | 1\. 确保有历史日志文件（需先进行过一些操作） 2. 在终端可执行 bash 脚本的环境中                                                |
| 测试步骤   | 1\. 先正常使用系统，发几条指令给 claude_01 实例 2. 在终端执行：bash user_scripts/query_thread.sh claude_01 3. 观察输出内容    |
| 预期结果   | • 输出按时间顺序排列的操作历史 • 每条记录包含：时间戳 \| 追踪ID \| 操作类型 \| 状态 \| 内容摘要 • 仅显示 claude_01 相关的记录 |
| 为什么重要 | 方便回溯某个实例做过什么，便于问题排查和工作追踪。                                                                            |

## V-08 Web GUI 基础访问与鉴权

| **项目**         | **内容**                                                                                                                                                         |
|------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| 是什么           | 通过网页浏览器（包括手机浏览器）访问系统管理界面，需要凭访问令牌（Token）才能进入，就像用密码开门。                                                              |
| 预先配置         | 1\. 在 .env 中设置：WEB_GUI_ENABLED=true、WEB_GUI_PORT=3000、WEB_GUI_HOST=你的服务器IP或域名、WEB_GUI_TOKEN=你设置的随机字符串（建议32位） 2. 重启 Meridian 服务 |
| 测试步骤（手机） | 1\. 用手机浏览器打开：http://你的服务器IP:3000（不带 token） 2. 观察页面 3. 再打开：http://你的服务器IP:3000?token=你设置的Token 4. 观察页面                     |
| 预期结果         | • 步骤 2：显示"请提供访问令牌"或 401 错误提示，不显示任何实例信息 • 步骤 4：正常显示实例概览页面（即使当前无实例，也显示空列表而非错误）                         |
| 为什么重要       | 确保系统不会暴露给未授权访问者，是生产安全的基本保障。                                                                                                           |

## V-09 Web GUI 终端实时视图

| **项目**   | **内容**                                                                                                                                                                           |
|------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| 是什么     | 在网页上实时看到 AI 实例的工作输出，就像远程查看一个正在运行的终端屏幕，而且支持从网页直接输入指令。                                                                               |
| 预先配置   | 1\. Web GUI 已启动（见 V-08 配置） 2. 至少有一个 pane_bridge 模式的实例正在运行 3. 该实例已 attach（方便看到有输出）                                                               |
| 测试步骤   | 1\. 打开 Web GUI 首页（带 token） 2. 点击一个 pane_bridge 模式的实例 3. 观察终端区域 4. 在 Telegram 向该实例发一条指令 5. 在网页终端区域观察 6. 在网页的输入框中输入一条指令并发送 |
| 预期结果   | • 步骤 3：终端区域显示历史输出内容 • 步骤 5：网页终端实时显示 AI 的输出（无需刷新页面） • 步骤 6：AI 收到并执行了这条指令，终端显示响应内容                                        |
| 为什么重要 | 摆脱 Telegram 只能看文字的限制，可以直观地观察 AI 的工作过程，特别适合调试和监控长任务。                                                                                           |

## V-10 Telegram 消息中的 GUI 快捷按钮（Deep Link）

| **项目**   | **内容**                                                                                                                                  |
|------------|-------------------------------------------------------------------------------------------------------------------------------------------|
| 是什么     | 在 Telegram 的操作回复消息中，自动附带一个「打开 GUI」的可点击按钮，点击后直接在手机浏览器打开对应实例的 Web 管理界面，无需手动复制链接。 |
| 预先配置   | 1\. Web GUI 已启动并配置（见 V-08） 2. .env 中正确设置 WEB_GUI_HOST                                                                       |
| 测试步骤   | 1\. 在 Telegram 发送 /spawn type=claude mode=pane_bridge 2. 观察收到的回复消息 3. 点击消息中的「🖥 打开 GUI」按钮                          |
| 预期结果   | • 步骤 2：回复消息底部有「🖥 打开 GUI」内联按钮 • 步骤 3：手机浏览器自动打开并直接显示该实例的终端视图（无需手动输入 URL 或 token）        |
| 为什么重要 | 从 Telegram 消息一键跳转到可视化界面，显著提升操作效率，特别适合移动场景。                                                                |

## V-11 告警消息快捷操作按钮

| **项目**   | **内容**                                                                                                                      |
|------------|-------------------------------------------------------------------------------------------------------------------------------|
| 是什么     | 当 AI 实例出现错误时，Telegram 告警消息中直接附带「Reboot」和「Kill」按钮，点击即可立即执行对应操作，无需再手动输入命令。     |
| 预先配置   | 无特殊配置，有正在运行的实例即可                                                                                              |
| 测试步骤   | 1\. 手动触发一个实例错误（或等待监控检测到 agent_error） 2. 观察收到的 Telegram 告警消息 3. 点击「🔄 Reboot」按钮 4. 观察结果 |
| 预期结果   | • 步骤 2：告警消息包含错误描述，底部有「🔄 Reboot」和「❌ Kill」两个按钮 • 步骤 4：收到重启确认消息，实例状态恢复正常         |
| 为什么重要 | 出错时的响应速度直接影响系统稳定性，一键操作比输入命令快得多，在移动端尤其重要。                                              |

## V-12 /gui 命令快速获取链接

| **项目**   | **内容**                                                                                                          |
|------------|-------------------------------------------------------------------------------------------------------------------|
| 是什么     | "/ gui" 命令让系统立刻回复当前绑定实例的 Web GUI 访问链接，方便在忘记链接时随时获取。                             |
| 预先配置   | 1\. Web GUI 已启动（见 V-08） 2. 已有绑定实例（/attach）                                                          |
| 测试步骤   | 1\. 发送 /gui 2. 观察回复 3. 发送 /gui thread=claude_01 4. 点击链接                                               |
| 预期结果   | • 步骤 2：收到包含可点击 Web GUI 链接的消息 • 步骤 4：手机浏览器打开对应实例页面，token 已包含在 URL 中无需再输入 |
| 为什么重要 | 提供随时可得的链接访问方式，作为 Inline Keyboard 按钮的补充手段。                                                 |

附录 A Task 依赖关系速查表

| **Task ID** | **标题**             | **依赖**            | **Worker** | **优先级** |
|-------------|----------------------|---------------------|------------|------------|
| T-01        | 配置层扩展           | 无                  | W1         | P1         |
| T-02        | Unix Socket IPC      | T-01                | W1         | P1         |
| T-03        | types.ts Schema 扩展 | 无                  | W2         | P1         |
| T-04        | Service Registry     | T-03                | W2         | P1         |
| T-05        | actor_id 会话隔离    | T-03                | W2         | P1         |
| T-06        | Slash 命令扩展       | T-03                | W1         | P1         |
| T-07        | Webhook 生产模式     | T-01                | W1         | P1         |
| T-08        | Result Sender 增强   | T-03                | W1         | P2         |
| T-09        | thread_id 查询脚本   | 无                  | W2         | P2         |
| T-10        | Web Interface Server | T-01,T-03,T-04,T-05 | W3         | P1         |
| T-11        | Pane Log IPC 推送    | T-02,T-03           | W2         | P1         |
| T-12        | Web GUI 前端         | T-10,T-11           | W3         | P1         |
| T-13        | Telegram Deep Link   | T-06,T-10           | W1         | P2         |
| T-14        | Idempotency 幂等去重 | T-03,T-05           | W2         | P2         |
| T-15        | Priority Queue       | T-03                | W2         | P2         |
| T-16        | span_id 嵌套追踪     | T-03                | W2         | P2         |
| T-17        | 集成测试套件         | T-02~T-12（全部P1） | W4         | P1（收尾） |

附录 B 新增环境变量速查

| **变量名**           | **默认值** | **必填**     | **说明**                                            |
|----------------------|------------|--------------|-----------------------------------------------------|
| WEBHOOK_URL          | —          | 否           | Telegram Webhook 地址；设置后切换 Webhook 模式      |
| WEBHOOK_PORT         | 443        | 否           | Webhook 服务监听端口                                |
| WEBHOOK_SECRET_TOKEN | —          | 否           | Telegram Webhook 安全校验令牌                       |
| WEB_GUI_ENABLED      | false      | 否           | 是否启动 Web GUI 服务器                             |
| WEB_GUI_PORT         | 3000       | 否           | Web GUI HTTP 服务监听端口                           |
| WEB_GUI_HOST         | —          | 是（启用时） | Web GUI 对外访问域名/IP，用于生成 Deep Link URL     |
| WEB_GUI_TOKEN        | —          | 是（启用时） | 访问鉴权 Token，建议 32 位随机 hex                  |
| WEB_GUI_HTTPS        | false      | 否           | 是否启用 HTTPS（需配合 TLS_CERT_PATH/TLS_KEY_PATH） |
| TLS_CERT_PATH        | —          | 否           | TLS 证书文件路径（HTTPS=true 时必填）               |
| TLS_KEY_PATH         | —          | 否           | TLS 私钥文件路径（HTTPS=true 时必填）               |