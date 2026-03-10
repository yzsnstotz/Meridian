# 需求文档 v1.0 与当前实现的差距清单

已根据 `meridian_requirements_v1.0.0.docx` 与当前代码的对照，整理出**未实现或未完整实现**的清单（仅做对照，不涉及任何代码修改）。

**确认说明**（与初次比对的差异与核实结果）：

- **§4 restart 语义**：已确认。文档中的「restart」指对单实例 kill+spawn 且保持 thread_id；当前 Slash `/restart` 为重建并重启 Meridian 服务（`rebuild-restart.sh`）。`InstanceManager.restart(threadId)` 已实现文档语义，但未通过 Slash 暴露。
- **§7 Agent 输出文件**：已确认。`HubResult.attachments` 与 `ResultSender.sendDocument` 通道存在，但 `router.ts` 中 `buildResult`、`buildCompletionResultForThread`、`buildProgressResultForThread` 均写死 `attachments: []`，未从 agentapi/任务结果收集输出文件。
- **§8 按 trace_id/thread_id 查询**：已核实。**按 trace_id** 有脚本 `user_scripts/verify_logs.sh <trace_id>`，可跨 hub/interface/monitor 日志合并输出，但无 API；**按 thread_id 查会话历史** 无脚本、无 API。

---

## 一、通信与架构

### 1. Hub Core ↔ agentapi 未使用 Unix Socket（与文档不符）

- **文档**（§4、§13）：Hub Core 与 agentapi 之间为 **HTTP over Unix Domain Socket（IPC）**，连接通过 `/tmp/*.sock`，不走 TCP。
- **实现**：`instance-manager.ts` 中 `formatAgentEndpoint(port)` 返回 `http://127.0.0.1:${port}`，通过 TCP 分配端口连接 agentapi，未使用 Unix socket。
- **结论**：**Hub ↔ agentapi 段未按文档实现 IPC（Unix Socket）**；agentapi-client 已支持 unix endpoint，但 instance-manager 未使用。

### 2. 实例注册表 socket_path 形态与文档不一致

- **文档**（§8.2）：`socket_path` 示例为 Unix 路径，如 `/tmp/agentapi-claude_01.sock`。
- **实现**：注册的是 `http://127.0.0.1:${port}` 形式的 URL。
- **结论**：与文档约定的「Unix socket 路径」不一致，属上一条的同一问题。

---

## 二、Slash 命令与生命周期

### 3. `/detach` 未暴露

- **文档**（§6.3、§8.3）：支持 **detach**——解除当前会话与实例的绑定，不关闭实例。
- **实现**：`InstanceManager.detach(session)` 存在，但未在 slash 命令中暴露；`slash-handler.ts` 无 `/detach`，`Intent` 无 `detach`，router 也未处理 detach。
- **结论**：**detach 能力未对用户开放（无 /detach 命令）**。

### 4. 文档中的「restart」与实现中的 `/restart` 语义不同

- **文档**（§8.3）：**restart** = 对某实例做 kill + spawn，保持 `thread_id` 不变（即重启单个 Agent 实例）。
- **实现**：`InstanceManager.restart(threadId)` 已实现该语义，但 **Slash 命令 `/restart`** 被用于「重建并重启 Meridian 服务」（调用 `rebuild-restart.sh`），不是重启某个 agent 实例。
- **结论**：**按 thread 的 restart 未通过 Slash 命令暴露**；文档中的「restart」与当前 `/restart` 含义不一致。

---

## 三、Telegram 与 Interface 层

### 5. Webhook 未实现（仅 Long Polling）

- **文档**（§5.1、§13）：开发用 Long Polling，**生产切 Webhook HTTPS**；交付含「Webhook 切换」。
- **实现**：仅使用 `bot.start()`（Long Polling），无 Webhook 路由、配置或启动路径。
- **结论**：**Webhook 模式未实现，无法按文档在生产切换**。

---

## 四、回传策略（HubResult）

### 6. 长文本未按文档「以文件发送」

- **文档**（§10）：内容超过 4096 字符时，**自动以 .txt / .md 文件发送**。
- **实现**：`result-sender.ts` 中 `sendLongTextInChunks()` 将长文本**拆成多条 sendMessage 发送**，未生成或发送 .txt/.md 文件。
- **结论**：**长文本回传策略与文档不一致**（文档要求“文件发送”，实现为“分条消息”）。

### 7. Agent 输出文件（代码/报告）未回传为附件

- **文档**（§10）：Agent 生成的**代码文件**应**直接作为 Telegram 文件消息发送**，保留文件名。
- **实现**：`HubResult` 有 `attachments`，`ResultSender` 会 `sendDocument`，但 router 的 `buildResult()`、`buildCompletionResultForThread()`、`buildProgressResultForThread()` 等均写死 `attachments: []`，未从 agentapi/任务结果中收集输出文件并填入 `HubResult.attachments`。
- **结论**：**“代码文件/输出文件作为 Telegram 文件发送”未完整实现**（通道存在，但结果未带附件）。

---

## 五、可观测性与查询

### 8. 按 trace_id / thread_id 的「简单查询」未完整提供

- **文档**（§11）：**提供简单查询**：按 trace_id 查全链路、按 thread_id 查会话历史。
- **实现**：
  - **按 trace_id**：有脚本 `user_scripts/verify_logs.sh <trace_id>`，可跨 hub/interface/monitor 日志按 trace_id 合并输出，但**无 API**。
  - **按 thread_id**：**无**按 thread_id 查会话历史的脚本或 API。
- **结论**：按 trace_id 有脚本无 API；按 thread_id 的查询**未实现**。

---

## 六、其他差异（实现超出或与文档表述不完全一致）

### 9. 文档未列出的 Slash 命令

- **实现**中多了：`/restart`（服务重启）、`/update`（monitor 进度开关）、`/model`（switch_model）。文档 §6.3 只列了六条：/spawn、/kill、/status、/attach、/list、/help。
- **说明**：属功能扩展，不视为“未实现”，但文档若作为验收依据，需要同步更新。

### 10. 操作审计日志的“写入”未单独成体系

- **文档**（§11）：实例生命周期事件（spawn / kill / restart / attach）写入**操作审计日志**。
- **实现**：这些事件在现有 logger（如 instance_mgr、hub）中有 info 日志，但**没有**单独的“操作审计日志”模块或文件（例如独立 audit 日志或审计 API）。
- **结论**：**“操作审计日志”未按文档作为独立交付**，仅有通用结构化日志中的记录。

---

## 七、已较好符合文档的部分（简要）

- Interface → Hub Core：Unix Socket IPC（`ipc-sender` + `HUB_SOCKET_PATH`）。
- Monitor → Hub：IPC 上报事件（`MonitorIpcReporter` + 同一 socket）。
- InboundUIEvent / HubMessage / HubResult 结构、Zod 校验与文档一致。
- Slash：/spawn（含 type、mode）、/kill、/status、/attach、/list、/help 均存在且可用。
- 多模态：photo/document 下载到临时目录并放入 `attachments`，reply_to 用于 thread 绑定。
- 实例状态模型：idle / running / waiting / stopped / error 与文档一致。
- Monitor：SSE Hook + Heartbeat 兜底、事件类型 task_completed / status_changed / heartbeat_missed / agent_error（及 sse_reconnect_failed）均有。
- Pino 结构化日志、trace_id 注入、Monitor 告警推送到 Telegram 已实现。
- 鉴权：Bot Token + ALLOWED_USER_IDS（单 Owner）与文档一致。

---

## 汇总表

| 序号 | 类别           | 未实现/未完整实现项                             | 文档章节   |
|------|----------------|--------------------------------------------------|------------|
| 1    | 通信           | Hub ↔ agentapi 使用 TCP 而非 Unix Socket       | §4, §13   |
| 2    | 数据模型       | socket_path 为 URL 而非 /tmp/*.sock 路径        | §8.2      |
| 3    | Slash/生命周期 | 无 `/detach`，detach 未对用户开放              | §6.3, §8.3 |
| 4    | Slash/生命周期 | 按实例的 restart 无 Slash；/restart 语义不同    | §8.3      |
| 5    | Interface      | 仅 Long Polling，无 Webhook 生产切换            | §5.1, §13 |
| 6    | 回传策略       | 长文本未以 .txt/.md 文件发送                   | §10       |
| 7    | 回传策略       | Agent 输出文件未纳入 HubResult 并作为文件发送   | §10       |
| 8    | 可观测性       | 按 trace_id 仅有脚本无 API；按 thread_id 无查询 | §11       |
| 9    | 可观测性       | 操作审计日志未单独成体系                       | §11       |

以上清单仅用于对照需求文档做差距分析，未对代码做任何修改。
