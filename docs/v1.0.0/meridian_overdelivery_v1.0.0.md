# Meridian Phase 0（v1.0.0）超额实现清单

本文档基于 `v1.0.0/meridian_requirements_v1.0.0.docx` 与当前代码库的对照结果，梳理**超出 v1.0 需求文本明确要求/验收点**的实现内容，用于 v1.0.0 归档。

- **口径（本文使用）**：凡是代码、脚本、测试/验收材料中已实现，但在 v1.0 需求文档中**未被明确要求**（或未被列入 Chapter 13 交付验收标准）的能力/交付物，均计入“超额实现”。  
- **注意**：若某项“额外实现”与文档要求存在冲突/替代关系（例如实现方式不同），本文会标注为“**额外实现（且可能与文档表述不一致）**”，其“差距”已在差距清单文档中单独列出。

---

## 一、Telegram 交互与操控体验增强（超出文档要求）

### 1) Inline Keyboard 交互式选择器（Picker flows）

相较文档仅要求 Slash 命令解析/执行，当前实现加入了多套 Telegram Inline Keyboard 交互菜单，用于降低命令输入成本：

- **/spawn 向导**：当 `/spawn` 未带参数时，通过按钮选择 Provider（Claude/Codex/Gemini/Cursor）、Mode（bridge/pane_bridge）、以及工作目录。
- **/kill /attach /model 向导**：当缺少 thread 参数时，通过按钮列出 live threads 供选择。

主要位置：
- `src/interface/index.ts`（callback query 解析、键盘构建、picker 流程）

### 2) /spawn 工作目录目录选择器 + 受限根目录 + 目录创建

在文档未要求“选择/创建 spawn 目录”的前提下，当前实现支持：

- 以固定根目录（默认 `/Users/yzliu/work`）作为安全边界
- 逐级浏览子目录选择 spawn_dir
- 在允许范围内“创建新目录”后再选择
- picker session TTL 过期清理

主要位置：
- `src/interface/index.ts`（spawnDirectorySessions、normalizeSpawnDirectory、Create Folder 流程）

### 3) Slash 命令解析的兼容性增强

文档未要求的额外解析能力包括：

- 支持多种“斜杠”前缀（如全角斜杠）归一化
- 支持 `key=value` 的多种分隔符（如 `:`、`：`、`＝`）
- 支持 `thread`/`dir`/`interval` 等参数的多种别名（例如 interval 的多种 key）

主要位置：
- `src/interface/slash-handler.ts`

### 4) 多 Bot Token 运行时（Multi-bot runtimes）

文档 Phase 0 仅提“单一 Owner”，未要求多 Bot 实例并行。当前实现扩展为：

- 支持 `TELEGRAM_BOT_TOKENS` 额外配置多个 token
- 在消息回传通道中携带 `bot_id`，并在 sessionId 编码中纳入 botId（用于同 chatId 下多 bot 区分）
- `syncBotCommands()` 对所有 bot 运行时批量同步命令

主要位置：
- `src/interface/bot.ts`
- `src/interface/index.ts`
- `src/types.ts`（`ReplyChannelSchema` 增加 `bot_id`）

---

## 二、Hub / Router 的额外指令与能力（超出文档要求）

### 5) /model：对既有 thread 做 provider 切换（switch_model）

文档 v1.0 的 §6.3 Slash 命令集未包含模型/Provider 切换。当前实现加入：

- `Intent: switch_model`
- Telegram `/model` 命令与 picker 选择 UI
- 后端执行 `InstanceManager.switchModel(threadId, nextType)`

主要位置：
- `src/interface/slash-handler.ts`（/model 解析）
- `src/interface/index.ts`（model picker）
- `src/hub/router.ts`（`handleSwitchModel`）
- `src/hub/instance-manager.ts`（`switchModel`）

### 6) /update + /mupdate：面向运行中 thread 的“进度快照推送”体系

文档要求 Monitor（SSE/Heartbeat）与异常告警，但未明确要求“可配置的进度推送开关/频率”。当前实现扩展为：

- `Intent: monitor_update`：对某 thread 开启/关闭周期性进度推送，并支持自定义 interval
- `Intent: monitor_manual_update`：立即推送一次进度快照，不改变订阅状态
- Hub 定时 tick（`MONITOR_PROGRESS_TICK_MS`）扫描到期订阅并批量派发
- 当 monitor `status_changed` 且 thread 处于 running 时，强制将订阅 nextDispatchAtMs 置为 now（更快出进度）

主要位置：
- `src/interface/slash-handler.ts`（/update、/mupdate 解析）
- `src/hub/router.ts`（订阅表、`handleMonitorUpdate`、`collectDueMonitorUpdateDispatches` 等）
- `src/hub/server.ts`（定时 `flushMonitorProgressUpdates` 派发）

---

## 三、Monitor 健壮性与事件体系增强（超出文档要求）

### 7) SSE 断线重连计数与“重连耗尽”事件

文档仅描述 SSE Hook + Heartbeat 兜底。当前实现额外引入：

- SSE 重连次数上报与阈值控制
- `sse_reconnect_failed` 事件类型（fatal 级别）用于明确区分“重连耗尽”的状态

主要位置：
- `src/monitor/monitor.ts`（reconnect attempts、fallback to heartbeat）
- `src/monitor/events.ts`（新增 `sse_reconnect_failed`）

---

## 四、运维/部署与宿主机准备（超出需求文档的“功能要求”层面）

> 注：文档 §12 技术选型提到 PM2/Docker Compose，但通常不要求完整可运维脚本与 logrotate 交付；此处按“交付物超额”归类。

### 8) 一键重启/重建脚本（非 Telegram /restart，而是本地运维脚本）

- `user_scripts/restart.sh`：停止 PM2 / 杀进程 / 清理 socket / 多模式启动（PM2、node dist、npm）  
- `user_scripts/rebuild_restart.sh`：build + restart
- `rebuild-restart.sh`：顶层入口

### 9) 宿主机目录准备 + logrotate 安装

- `scripts/setup-host.sh`：创建 log/socket 目录，初始化 log 文件并修正 owner
- `deploy/logrotate/meridian` + `scripts/install-logrotate.sh`：安装 logrotate 配置

### 10) Docker / PM2 交付

- `Dockerfile`、`docker-compose.yml`（含 `monitor` profile）
- `ecosystem.config.js`（PM2 守护配置）

---

## 五、测试、验收与可操作性资产（超出文档要求）

### 11) 单元测试覆盖

文档未要求单元测试，但当前代码包含多处 `.test.ts`，覆盖 router/normalizer/IPC/agentapi-client 等关键模块（并在 `dist/` 也可见对应构建产物）。

示例位置（不穷举）：
- `src/hub/*.test.ts`
- `src/interface/*.test.ts`
- `src/shared/*.test.ts`

### 12) 手工验收清单与日志验证脚本

- `user_scripts/e2e_checklist.md`：把 Chapter 13 验收项落到 Telegram 操作步骤
- `user_scripts/verify_logs.sh`：按 trace_id 聚合 hub/interface/monitor 三类日志，生成时间线输出

---

## 六、实现方式上的“额外增强”（且可能与文档表述不一致）

### 13) 长文本回传：实现了“分片消息发送”机制

文档 §10 期望长文本以文件发送（.txt/.md）。当前实现额外提供了：

- Telegram 文本超长时的自动分片 `sendMessage` 回传
- 含重试与退避策略

主要位置：
- `src/hub/result-sender.ts`（`splitTextForTelegram` / `sendLongTextInChunks` / retry/backoff）

> 该项属于“超额实现的回传机制”，但与文档“以文件发送”的要求存在实现差异；差距已在差距清单中另行记录。

---

## 汇总表（超额实现项一览）

| 序号 | 类别 | 超额实现项 | 主要位置 |
|---:|---|---|---|
| 1 | Telegram 交互 | Inline Keyboard 选择器（spawn/kill/attach/model） | `src/interface/index.ts` |
| 2 | Telegram 交互 | /spawn 目录选择器 + 受限根目录 + 目录创建 | `src/interface/index.ts` |
| 3 | Telegram 兼容 | Slash 前缀/参数解析增强 | `src/interface/slash-handler.ts` |
| 4 | Telegram 运行时 | 多 Bot Token（TELEGRAM_BOT_TOKENS）+ bot_id 区分 | `src/interface/bot.ts`, `src/types.ts` |
| 5 | Hub 能力 | /model（switch_model） | `src/hub/router.ts`, `src/hub/instance-manager.ts` |
| 6 | Hub 能力 | /update + /mupdate：进度推送订阅体系 | `src/hub/router.ts`, `src/hub/server.ts` |
| 7 | Monitor 健壮性 | SSE 重连耗尽事件 `sse_reconnect_failed` | `src/monitor/monitor.ts`, `src/monitor/events.ts` |
| 8 | 运维交付 | restart / rebuild_restart 脚本链路 | `user_scripts/*`, `rebuild-restart.sh` |
| 9 | 运维交付 | setup-host + logrotate 安装 | `scripts/*`, `deploy/logrotate/*` |
| 10 | 部署交付 | Docker/Compose + PM2 配置 | `Dockerfile`, `docker-compose.yml`, `ecosystem.config.js` |
| 11 | 质量工程 | 单元测试覆盖 | `src/**/*.test.ts` |
| 12 | 验收工具 | e2e 清单与 trace_id 日志聚合脚本 | `user_scripts/e2e_checklist.md`, `user_scripts/verify_logs.sh` |
| 13 | 回传增强 | 长文本分片回传（实现增强，但与文档表述不同） | `src/hub/result-sender.ts` |

