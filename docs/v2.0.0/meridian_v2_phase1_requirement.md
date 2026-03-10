**Meridian**

系统需求说明文档

**v2.0 · Phase 1**

|          |                                               |
|----------|-----------------------------------------------|
| 版本     | v2.0（基于 v1.0 实现差距分析与 Phase 1 扩展） |
| 基础版本 | meridian_requirements_v1.0.0.docx             |
| 状态     | 草稿                                          |
| 关联文档 | 架构示意图 · 日志规范 · 附件 A                |
| 范围     | v1.0 遗留修复 + Web GUI 界面层（Phase 1）     |

**Part A v1.0 实现差距核实与修复计划**

本章节基于 requirements-gap-analysis v1.0
对当前代码库（Meridian-main）的逐项核实结果，确认哪些差距属实、哪些需要补充说明，并标注各项进入
v2.0 的修复优先级。

**A.1 差距核实结果总览**

经逐项核对源代码，gap analysis 文档整体准确，以下为补充核实说明：

|        |                |                                        |                                                                                                                            |                    |
|--------|----------------|----------------------------------------|----------------------------------------------------------------------------------------------------------------------------|--------------------|
| **\#** | **类别**       | **差距项**                             | **核实结论**                                                                                                               | **v2 优先级**      |
| 1      | 通信           | Hub↔agentapi 使用 TCP 而非 Unix Socket | ✅ 确认。formatAgentEndpoint() 返回 http://127.0.0.1:\${port}，agentapi-client 已支持 unix endpoint 但未被调用             | P1 应修复          |
| 2      | 数据模型       | socket_path 为 URL 非 /tmp/\*.sock     | ✅ 同上，属同一问题的数据层体现                                                                                            | P1 随 \#1 一并修复 |
| 3      | Slash/生命周期 | 无 /detach 命令                        | ✅ 确认。InstanceManager.detach() 已实现，未在 slash-handler.ts 中暴露，Intent 枚举也无 detach                             | P2                 |
| 4      | Slash/生命周期 | /restart 语义与文档不符                | ✅ 确认。/restart 调用 rebuild-restart.sh（服务级重启），而 InstanceManager.restart() 是实例级重启，两者未对齐             | P2                 |
| 5      | Interface      | 仅 Long Polling，无 Webhook 生产切换   | ✅ 确认。bot.ts 仅 bot.start()，无 Webhook 路由/配置                                                                       | P1 生产必备        |
| 6      | 回传策略       | 长文本未以文件发送                     | ✅ 确认。sendLongTextInChunks() 拆成多条 sendMessage，未生成 .txt/.md 文件                                                 | P2                 |
| 7      | 回传策略       | Agent 输出文件未纳入 HubResult         | ✅ 确认。buildResult() 系列方法硬编码 attachments:\[\]，通道基础设施存在但结果构建未填充                                   | P2                 |
| 8      | 可观测性       | 按 thread_id 查会话历史无实现          | ✅ 确认。verify_logs.sh 仅支持按 trace_id，无 thread_id 维度查询脚本或 API                                                 | P2                 |
| 9      | 可观测性       | 操作审计日志未独立成体系               | ✅ 确认。操作日志混入通用 Pino 日志，无独立审计模块/文件/API                                                               | P3                 |
| 10     | 补充项         | /detach 意图缺失于 IntentSchema        | ⬆️ Gap analysis 未单独列出：IntentSchema（types.ts）无 detach，导致 HubMessage 无法携带 detach 意图，需同步更新 Zod schema | P1 同 \#3          |
| 11     | 补充项         | 文档 §6.3 命令列表与实现不同步         | ⬆️ 文档仅列 6 条 Slash 命令，实现有 /restart /update /model /mupdate；文档需同步更新，不影响功能                           | 文档维护           |
| 12     | 补充项         | Webhook 切换缺少 WEBHOOK_URL 配置项    | ⬆️ config.ts 无 WEBHOOK_URL / WEBHOOK_PORT 等环境变量定义，仅添加 Webhook 路由不够，需同时补全配置层                       | P1 同 \#5          |

**A.2 修复优先级说明**

|            |                                                        |                                                                             |
|------------|--------------------------------------------------------|-----------------------------------------------------------------------------|
| **优先级** | **定义**                                               | **对应差距项**                                                              |
| P1         | 生产可用性与协议合规的前提条件；必须在 v2.0 发布前完成 | \#1/#2（Unix Socket）、#5/#12（Webhook）、#3/#10（detach schema）           |
| P2         | 功能完整性；已有基础设施，补全即可；建议 v2.0 一并交付 | \#4（restart 语义）、#6（长文本文件）、#7（附件输出）、#8（thread_id 查询） |
| P3         | 可观测性增强；独立成体系有价值，但不阻塞核心功能       | \#9（审计日志独立模块）                                                     |
| 文档       | 文档与实现对齐，不涉及代码改动                         | \#11（Slash 命令列表同步）                                                  |

**A.3 各 P1/P2 项修复规格**

**A.3.1 Unix Socket IPC（#1 \#2）**

**目标：**Hub ↔ agentapi 通信从 TCP 切换为 Unix Domain Socket，与文档
§4、§13 一致。

- 修改 InstanceManager.spawnInternal()：将 formatAgentEndpoint(port)
  替换为 formatAgentSocketPath(threadId)，生成路径
  /tmp/agentapi-{threadId}.sock

- agentapi spawn 参数从 --port={port} 改为
  --socket={socketPath}（agentapi CLI 已支持）

- 注册表中 socket_path 字段存入 Unix socket 文件路径，如
  /tmp/agentapi-claude_01.sock

- AgentAPIClient.connect() 已支持 unix:// 或裸路径的
  parseEndpoint()，无需改动

- killInternal() 中清理 socket
  文件的逻辑已存在（socket_path.startsWith("/") 判断），与新路径格式兼容

- 废弃 allocateAvailablePort() 及 portAllocator
  注入点（保留接口用于测试注入，默认实现改为 socket path 生成）

**A.3.2 Webhook 生产切换（#5 \#12）**

**目标：**Interface Layer 支持 Long Polling（开发）和 Webhook
HTTPS（生产）双模式，启动时由环境变量决定。

- config.ts 增加 WEBHOOK_URL（可选）、WEBHOOK_PORT（默认
  443）、WEBHOOK_SECRET_TOKEN（可选）

- interface/index.ts：若 WEBHOOK_URL 存在，使用 bot.start({ webhook: ...
  })；否则 Long Polling

- 添加 /webhook 路由（Node.js https.Server 或 express/fastify
  轻量中间件），处理 Telegram 推送

- README 补充 Webhook 部署说明

**A.3.3 /detach 命令与 Intent 枚举（#3 \#10）**

**目标：**将 detach 能力从 InstanceManager 内部接口升级为用户可用的
Slash 命令。

- types.ts：IntentSchema 增加 "detach" 枚举项

- slash-handler.ts：添加 /detach \[thread=\<thread_id\>\] 命令解析，返回
  intent: "detach"

- HELP_MESSAGE 更新，加入 /detach 说明

- router.ts：routeByIntent() 增加 case "detach" → handleDetach()，调用
  instanceManager.detach()

- /status 命令响应中显示当前会话绑定状态（方便用户决定是否 detach）

**A.3.4 /restart 语义对齐（#4）**

**目标：**区分「实例级重启」与「服务级重建」两种操作，分别通过不同命令暴露。

- **保留 /restart：**维持现有语义——触发 rebuild-restart.sh 进行 Meridian
  服务级重建重启，重命名描述为「重建并重启 Meridian 服务」

- **新增 /reboot thread=\<thread_id\>：**调用
  InstanceManager.restart(threadId)，实现文档 §8.3 描述的「kill +
  spawn，保持 thread_id」语义

- slash-handler.ts 增加 /reboot 命令，types.ts IntentSchema 增加
  "reboot" 枚举

- router.ts 增加 handleReboot() → instanceManager.restart()

**A.3.5 长文本以文件发送（#6）**

**目标：**内容超过 4096 字符时，以 .txt 文件发送，而非分段 sendMessage。

- result-sender.ts：sendResult() 中将 sendLongTextInChunks() 替换为
  sendContentAsFile()

- sendContentAsFile()：将 textBody
  写入临时文件（/tmp/meridian-{traceId}.txt），调用
  sendDocumentWithRetry() 发送，发送后删除临时文件

- 阈值保持与 Telegram 限制一致：TELEGRAM_TEXT_LIMIT = 4096

**A.3.6 Agent 输出文件纳入 HubResult（#7）**

**目标：**Agent 生成的代码文件、diff、报告等可被识别并作为 Telegram
文件消息发送。

- 定义输出文件约定：agentapi task result 中 files\[\] 或 agentapi
  工作目录中明确输出的文件列表

- router.ts：buildResult()、buildCompletionResultForThread()、buildProgressResultForThread()
  改为接受 attachments 参数

- handleRun() 在收到 agentapi 回复后，解析 files 字段（若存在）填充
  HubResult.attachments

- result-sender.ts 已实现 sendDocument()，无需改动

**A.3.7 按 thread_id 查会话历史（#8）**

**目标：**提供脚本（或轻量 CLI）支持按 thread_id
查询该线程下所有指令与结果的历史记录。

- user_scripts/query_thread.sh \<thread_id\>：从 Pino 结构化日志中
  grep + jq 过滤 thread_id 字段，输出时间线摘要

- 输出格式：timestamp \| trace_id \| intent \| status \| content_preview

- 可选：hub/server.ts 提供 GET /query?thread_id=xxx 的轻量 HTTP
  API（仅内部访问）

**Part B v2.0 新功能需求：Web GUI 界面层**

在保持 Telegram 作为主控渠道不变的前提下，v2.0 引入 Web GUI 作为第二个
Interface 客户端，实现「手机浏览器可访问操作」并与 Telegram
会话深度集成。

**B.1 需求背景与目标**

|               |                                                                                                     |
|---------------|-----------------------------------------------------------------------------------------------------|
| **目标维度**  | **说明**                                                                                            |
| 可访问性      | 操作者可在任意位置通过手机浏览器（Safari / Chrome）打开 Web GUI，无需 SSH 或专用 App                |
| 实时可视      | Web GUI 提供 Agent 实例的终端输出实时流（pane_bridge 模式下的 tmux 内容），取代纯文本 Telegram 回传 |
| Telegram 集成 | Telegram 消息中可直接附带「打开 GUI」链接或按钮，点击即跳转到当前 attach 实例的可视界面             |
| 双渠道统一    | Web GUI 与 Telegram 共用同一套 Hub Core 和实例管理器，不新建独立调度路径                            |
| 安全          | Web GUI 通过 Token 鉴权，仅允许授权操作者访问，不暴露匿名接口                                       |

**B.2 架构概述**

Web GUI 作为新的 Interface 客户端，与现有 Telegram Interface
并列，两者均通过 Unix Socket IPC 连接 Hub Core：

|              |                                                                                           |
|--------------|-------------------------------------------------------------------------------------------|
| **架构定位** | *操作者浏览器 ↔ HTTPS ↔ Web Interface Layer ↔ Unix Socket IPC ↔ Hub Core ↔ agentapi 实例* |

**Web Interface Layer** 包含三个子模块：

- **HTTP 服务器：**提供静态前端资源 + REST API + WebSocket 服务，监听
  WEB_GUI_PORT（默认 3000）

- **认证中间件：**验证 Bearer Token（WEB_GUI_TOKEN），拦截未授权请求

- **IPC 代理：**将浏览器请求转换为 HubMessage 通过 Unix Socket 发送，将
  HubResult 转换为 HTTP/WebSocket 响应

**B.3 功能规格**

**B.3.1 实例概览面板**

打开 Web GUI 首页，展示当前所有活跃 Agent 实例的概览：

- 实例列表：thread_id、agent_type、mode、status、created_at

- 每行可点击进入该实例的详情/终端视图

- 「spawn 新实例」按钮（对应 /spawn 命令，支持选择 type 和 mode）

- 自动轮询刷新（每 5 秒）或 WebSocket 推送实时状态

**B.3.2 实例终端视图**

点击某个 pane_bridge 模式实例后进入终端视图：

- 通过 WebSocket 订阅 Hub 的 SSE 转发流，实时展示该实例的输出内容

- 终端渲染使用 xterm.js（MIT 许可），支持 ANSI 转义序列和颜色

- 支持滚动历史（最多 10000 行）

- 输入框：可向当前实例发送文本指令（对应 run intent）

- 操作按钮：Kill（/kill）、Reboot（/reboot）、Detach（/detach）

**B.3.3 bridge 模式实例视图**

bridge 模式实例（无终端输出）进入简化视图：

- 显示实例元数据（status、agent_type、working_dir、pid）

- 显示最近一条 HubResult 内容（从 Hub 轮询或 WebSocket 推送）

- 输入框：发送指令

- 操作按钮：Kill、Reboot

**B.3.4 Telegram Deep Link 集成**

**核心功能：**Telegram
消息中可附带可点击链接，点击即在手机浏览器中打开当前 attach 实例的 Web
GUI。

实现方案：

- **Web GUI
  访问地址：**https://{WEB_GUI_HOST}:{WEB_GUI_PORT}/?thread={thread_id}&token={WEB_GUI_TOKEN}

- **Telegram 消息增强：**在 spawn 成功、attach 成功、task_completed
  等事件的回传消息中，附加 Inline Keyboard 按钮「🖥 打开
  GUI」，按钮链接指向上述 URL

- **Token 传递方式：**WEB_GUI_TOKEN 嵌入 URL query
  parameter，浏览器打开后通过该 token 完成鉴权，无需额外登录步骤

- **手机浏览器优化：**前端页面采用响应式设计，针对移动端屏幕优化布局（垂直滚动、大字体、触摸友好的按钮尺寸）

**B.3.5 鉴权规格**

|            |                                                                                                                |
|------------|----------------------------------------------------------------------------------------------------------------|
| **属性**   | **规格**                                                                                                       |
| 鉴权方式   | Bearer Token（单一静态 token，由 WEB_GUI_TOKEN 环境变量配置）                                                  |
| Token 传递 | HTTP Header（Authorization: Bearer \<token\>）或 URL query param ?token=\<token\>（仅用于 Telegram deep link） |
| 会话维持   | 浏览器 sessionStorage 存储 token，刷新后自动重用                                                               |
| 失败响应   | HTTP 401，前端展示「请提供访问令牌」提示                                                                       |
| HTTPS      | 生产环境必须 HTTPS（配合 Nginx 反代或 Let's Encrypt）；开发可 HTTP                                             |
| 多用户     | Phase 1 仅支持单 token（单 Owner），多用户权限隔离推至 Phase 2                                                 |

**B.4 Telegram 界面增强**

为支持 Web GUI Deep Link 集成，Telegram Interface Layer 需以下增强：

**B.4.1 Inline Keyboard 按钮**

|                     |                   |                                                  |
|---------------------|-------------------|--------------------------------------------------|
| **触发场景**        | **附加按钮**      | **按钮行为**                                     |
| spawn 成功回传      | 🖥 打开 GUI        | 打开该 thread_id 的 Web GUI 终端视图             |
| attach 成功回传     | 🖥 打开 GUI        | 打开当前 attach 的实例的 Web GUI                 |
| task_completed 事件 | 🖥 查看结果        | 打开该 thread_id 的 Web GUI 结果视图             |
| agent_error 告警    | 🔄 Reboot ❌ Kill | 直接触发 /reboot 或 /kill 操作（callback query） |

**Callback Query 处理：**bot.ts 注册 callbackQuery
处理器，接收按钮点击事件，转换为对应的 HubMessage 并通过 IPC
发送，结果回传至 Telegram。

**B.4.2 /gui 命令**

新增 /gui \[thread=\<thread_id\>\] 命令，直接回复当前 attach 实例的 Web
GUI 链接（适用于忘记链接的场景）。

**B.5 终端输出流规格（WebSocket Bridge）**

pane_bridge 模式下，tmux pane 的内容需通过 WebSocket 实时推送到浏览器：

|             |                                                                                                   |
|-------------|---------------------------------------------------------------------------------------------------|
| **层次**    | **实现方式**                                                                                      |
| 数据源      | tmux pipe-pane 已将 pane 输出写入 /var/log/hub/pane-{threadId}.log（现有实现）                    |
| Hub 侧推送  | Web Interface Server 用 fs.watch() 或 tail -f 监听对应 pane log 文件，新增内容通过 WebSocket 推送 |
| 协议        | WebSocket，消息格式：{ type: "output", thread_id, chunk: "..." }                                  |
| 历史回放    | 连接建立时发送最近 N 行历史（从 pane log 文件读取）                                               |
| 断线重连    | 前端自动重连（指数退避，最多 10 次）                                                              |
| bridge 模式 | 无 pane log；改为订阅 Hub 的 task_completed / monitor 事件推送                                    |

**B.6 前端技术选型**

|           |                                          |                                                      |
|-----------|------------------------------------------|------------------------------------------------------|
| **模块**  | **选型**                                 | **说明**                                             |
| 框架      | Vanilla JS + Web Components 或 Preact    | 轻量，无构建工具依赖，适合单文件 bundle 内联于 HTML  |
| 终端渲染  | xterm.js v5.x（MIT）                     | 成熟的浏览器终端渲染库，支持 ANSI 颜色、滚动、resize |
| 样式      | Tailwind CSS CDN（或 MVP.css）           | CDN 引入，零构建配置，移动端友好                     |
| WebSocket | 浏览器原生 WebSocket API                 | 无需第三方库                                         |
| 打包      | esbuild 单次构建 或 纯 HTML/JS（无构建） | 生产构建可选；开发阶段支持纯静态文件服务             |

**部署方式：**Web Interface Server 直接 serve
静态文件（src/web/public/）；不需要独立前端构建 CI。

**B.7 配置项（新增环境变量）**

|                      |          |            |                                                                              |
|----------------------|----------|------------|------------------------------------------------------------------------------|
| **变量名**           | **类型** | **默认值** | **说明**                                                                     |
| WEB_GUI_ENABLED      | boolean  | false      | 是否启动 Web GUI 服务器                                                      |
| WEB_GUI_PORT         | number   | 3000       | Web GUI HTTP 服务监听端口                                                    |
| WEB_GUI_HOST         | string   | （必填）   | Web GUI 对外访问的主机名或 IP，用于生成 Telegram Deep Link URL               |
| WEB_GUI_TOKEN        | string   | （必填）   | 访问鉴权 Token，建议随机生成 32 位 hex 字符串                                |
| WEB_GUI_HTTPS        | boolean  | false      | 是否启用 HTTPS（需配合 TLS_CERT_PATH / TLS_KEY_PATH）                        |
| TLS_CERT_PATH        | string   | （可选）   | TLS 证书文件路径，WEB_GUI_HTTPS=true 时必填                                  |
| TLS_KEY_PATH         | string   | （可选）   | TLS 私钥文件路径，WEB_GUI_HTTPS=true 时必填                                  |
| WEBHOOK_URL          | string   | （可选）   | Telegram Webhook HTTPS 地址；若设置则切换为 Webhook 模式（从 P1 修复项合并） |
| WEBHOOK_PORT         | number   | 443        | Webhook 接收服务监听端口                                                     |
| WEBHOOK_SECRET_TOKEN | string   | （可选）   | Telegram Webhook 安全校验令牌                                                |

**B.8 新增 Slash 命令汇总（v2.0 完整命令集）**

|          |                                     |                                                   |                    |
|----------|-------------------------------------|---------------------------------------------------|--------------------|
| **命令** | **格式示例**                        | **说明**                                          | **新增/变更**      |
| /spawn   | /spawn type=claude mode=bridge      | 拉起新 Agent 实例                                 | 已有               |
| /kill    | /kill thread=claude_01              | 关闭并销毁指定实例                                | 已有               |
| /status  | /status thread=claude_01            | 查询实例当前状态                                  | 已有               |
| /attach  | /attach thread=claude_01            | 将当前会话绑定到已有实例                          | 已有               |
| /detach  | /detach \[thread=claude_01\]        | 解除当前会话与实例的绑定，不关闭实例              | v2.0 新增（P1）    |
| /list    | /list                               | 列出所有活跃实例及其状态                          | 已有               |
| /restart | /restart                            | 重建并重启 Meridian 服务（服务级）                | 已有（语义澄清）   |
| /reboot  | /reboot thread=claude_01            | 重启指定 Agent 实例（kill+spawn，保持 thread_id） | v2.0 新增（P2）    |
| /model   | /model thread=claude_01 type=codex  | 切换指定实例的 Agent 类型                         | 已有               |
| /update  | /update \[on\|off\] \[interval=30\] | 切换/配置监控进度推送                             | 已有               |
| /mupdate | /mupdate \[thread=claude_01\]       | 手动触发一次进度更新                              | 已有               |
| /gui     | /gui \[thread=claude_01\]           | 回复当前 attach 实例的 Web GUI 链接               | v2.0 新增          |
| /help    | /help                               | 显示命令帮助                                      | 已有（需更新内容） |

**B.9 Non-Goals（v2.0 明确不包含）**

- 多用户权限隔离（推至 Phase 2）

- Web GUI 的 Agent 代码编辑器功能（仅查看/控制，不编辑代码）

- Cursor GUI 和 Antigravity GUI 集成（待其 API 公开）

- Email / Nostr 等其他渠道接入（Phase 1 后续）

- Memory Layer 与 Credential Layer（Phase 2）

- Mobile App（PWA 或 Native）——手机浏览器访问满足 Phase 1 需求

**Part C v2.0 交付范围与验收标准**

**C.1 交付范围汇总**

|          |                      |                                                                                         |              |
|----------|----------------------|-----------------------------------------------------------------------------------------|--------------|
| **编号** | **模块**             | **交付内容**                                                                            | **来源**     |
| C-01     | Hub ↔ agentapi 通信  | Unix Socket IPC 替代 TCP，socket_path 从 URL 改为 /tmp/\*.sock 路径                     | Part A P1    |
| C-02     | Interface / Telegram | Webhook 模式支持，WEBHOOK_URL 等配置项，Long Polling 保持兼容                           | Part A P1    |
| C-03     | Slash / Intent       | /detach 命令，IntentSchema 增加 detach；/reboot 命令，IntentSchema 增加 reboot          | Part A P1/P2 |
| C-04     | Router               | handleDetach()、handleReboot() 路由处理，buildResult() 支持 attachments 填充            | Part A P2    |
| C-05     | ResultSender         | 长文本改为 .txt 文件发送，Agent 输出文件通过 attachments 发送                           | Part A P2    |
| C-06     | 可观测性             | query_thread.sh 脚本，支持按 thread_id 查询会话历史                                     | Part A P2    |
| C-07     | Web Interface Server | HTTP/WebSocket 服务器，鉴权中间件，IPC 代理，静态文件 serve                             | Part B       |
| C-08     | Web GUI 前端         | 实例概览面板、终端视图（xterm.js）、bridge 实例视图、响应式移动端布局                   | Part B       |
| C-09     | WebSocket 终端桥     | pane log 文件监听 → WebSocket 推送，历史回放，bridge 模式事件推送                       | Part B       |
| C-10     | Telegram Deep Link   | spawn/attach/task_completed 回传消息附加 Inline Keyboard「打开 GUI」按钮                | Part B       |
| C-11     | Callback Query 处理  | agent_error 告警按钮（Reboot / Kill），/gui 命令                                        | Part B       |
| C-12     | 配置层               | 所有新增环境变量（WEB_GUI\_\*、WEBHOOK\_\*、TLS\_\*）纳入 config.ts 并更新 .env.example | Part A+B     |

**C.2 验收标准**

|          |                    |                                                                                                                              |
|----------|--------------------|------------------------------------------------------------------------------------------------------------------------------|
| **编号** | **验收场景**       | **通过条件**                                                                                                                 |
| V-01     | Unix Socket IPC    | spawn 一个 claude bridge 实例，netstat/lsof 中无新 TCP 连接出现，/tmp/agentapi-claude_01.sock 文件存在，/status 命令返回正常 |
| V-02     | Webhook 模式       | 设置 WEBHOOK_URL 启动，Telegram 发消息可正常收到回复；切回 Long Polling 模式同样可用                                         |
| V-03     | /detach            | spawn → attach → /detach，再发消息返回「无 attach 实例」错误；再次 /attach 后恢复正常                                        |
| V-04     | /reboot            | /reboot thread=claude_01，thread_id 保持不变，pid 更新，实例可接受新指令                                                     |
| V-05     | 长文本以文件发送   | Agent 返回超 4096 字符内容时，Telegram 收到 .txt 文件消息而非多条文字消息                                                    |
| V-06     | 输出文件附件       | Agent 生成代码文件后，Telegram 收到对应文件消息（文件名保留）                                                                |
| V-07     | thread_id 查询     | 执行 query_thread.sh claude_01，输出包含该线程下所有指令的时间线                                                             |
| V-08     | Web GUI 访问       | 手机浏览器打开 https://{host}:{port}/?token=xxx，显示实例列表，无报错                                                        |
| V-09     | Web GUI 终端视图   | 点击 pane_bridge 实例，终端实时显示 Agent 输出；在输入框发送指令后 Agent 收到并执行                                          |
| V-10     | Telegram Deep Link | spawn 成功回传消息中出现「🖥 打开 GUI」按钮；点击后在手机浏览器打开对应实例的 GUI 页面                                        |
| V-11     | 告警按钮           | Monitor 检测到 agent_error 时，Telegram 告警消息中含「Reboot」和「Kill」按钮，点击后执行对应操作                             |
| V-12     | /gui 命令          | /gui 或 /gui thread=claude_01 回复包含可点击的 Web GUI 链接                                                                  |

**C.3 Phase 2 预留接口**

以下设计决策在 v2.0 中预留扩展点，不需实现但需注意不引入冲突：

- **多用户 Token：**WEB_GUI_TOKEN 设计为单值，Phase 2 扩展为 token →
  user_id 映射表，鉴权中间件接口保持不变

- **多渠道 Interface：**Web Interface 与 Telegram Interface 共用 IPC
  协议（HubMessage），Email/Nostr 接口可复用同一接入模式

- **Memory Layer hook：**HubMessage 结构中 payload 已有 reply_to
  字段，Memory Layer 可通过该字段绑定上下文，无需改动核心协议

- **审计日志模块（P3）：**操作类事件（spawn/kill/attach/detach/reboot）的日志字段已包含完整上下文；Phase
  2 可抽取独立 audit 写入器，不需改动现有日志调用

*--- Meridian · 系统需求说明 v2.0 · 草稿 ---*
