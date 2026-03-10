# Calling Hub · Logging Spec Addendum: Run Fallback Diagnostics

**文档类型**：日志规格附加说明  
**关联文档**：Calling Hub 日志记录规格说明 v1.0（calling_hub_logging_spec_v1_0.md）  
**覆盖范围**：Hub Core（hub.log）中与 run 意图、agent 回复获取、fallback 内容相关的诊断日志

---

## 1 目的

当 run 意图因「未拿到稳定 agent 回复」而使用 fallback 内容（如 POST /message 的 JSON 响应体）时，仅凭原有规格中的 `dispatch_status`、`result_status`、`latency_ms` 无法判断**为何**未拿到回复。本附加说明约定在上述场景下必须输出的诊断日志，便于按 `trace_id` / `thread_id` 排查。

---

## 2 新增日志条目（Hub Core · hub.log）

以下条目均写入 **hub.log**，级别为 **warn**，便于与正常 info 区分且不落入 hub-error.log（仅 error+ 时再考虑是否单独落 error）。

### 2.1 使用 fallback 内容时的决策日志

当 `waitForAgentReply` 返回 null，且即将使用 `resolveFallbackRunContent(client, response)` 的结果作为本次 run 的 `result.content` 时，必须打一条日志。

| **字段名**       | **类型** | **说明** |
|------------------|----------|----------|
| timestamp        | ISO 8601 | 同主规格 2.1 |
| level            | string   | `warn` |
| module           | string   | `hub`（与现有 hub logger 一致） |
| trace_id         | string   | 当前 HubMessage 的 trace_id |
| thread_id        | string   | 当前 Agent 实例 thread_id |
| msg              | string   | 固定文案见下表 |

**msg 固定文案**：

- `Run using fallback content: waitForAgentReply returned null; response body or getLatestAgentMessageSnapshot used as result content`

**用途**：通过 `grep trace_id hub.log` 可立即看到「本条 run 走了 fallback」，再结合下面的原因日志判断根因。

---

### 2.2 waitForAgentReply 返回 null 的原因日志

在 `waitForAgentReply` 内，一旦确定返回 null，必须先打一条 **原因** 日志再 return。原因由字段 **reason** 区分，并可选携带 **err** / **max_attempts** / **delay_ms**。

**必填字段**（与主规格一致）：timestamp, level, module, trace_id, thread_id, msg。

**扩展字段**：

| **字段名**   | **类型** | **说明** |
|--------------|----------|----------|
| reason       | string   | 见下表取值，用于聚合与告警 |
| err          | string   | 仅当 reason 为 `getMessages_threw` 时存在，为错误信息摘要 |
| max_attempts | number   | 仅当 reason 为 `no_stable_reply_within_max_attempts` 时存在 |
| delay_ms     | number   | 同上，轮询间隔毫秒数 |

**reason 取值与 msg 约定**：

| **reason**                         | **含义** | **msg 约定** |
|------------------------------------|----------|--------------|
| `client_has_no_getMessages`       | client 未实现 getMessages | `waitForAgentReply returning null: client does not implement getMessages` |
| `getMessages_threw`               | 某次轮询中 getMessages() 抛错 | `waitForAgentReply returning null: getMessages() threw` |
| `no_stable_reply_within_max_attempts` | 轮询至最大次数仍未得到稳定回复（snapshots 空、或全为 transient、或 isNewAgentReply 始终 false） | `waitForAgentReply returning null: no stable agent reply within max attempts (GET /messages empty, all transient, or isNewAgentReply never true)` |

**示例（getMessages 抛错）**：

```json
{
  "timestamp": "2025-01-15T08:23:05.100Z",
  "level": "warn",
  "module": "hub",
  "trace_id": "dbdc1060-a7b9-4999-ac9a-5ad4d1d4c99d",
  "thread_id": "gemini_01",
  "reason": "getMessages_threw",
  "err": "HTTP 404 returned for GET /messages",
  "msg": "waitForAgentReply returning null: getMessages() threw"
}
```

**示例（超时无稳定回复）**：

```json
{
  "timestamp": "2025-01-15T08:23:25.100Z",
  "level": "warn",
  "module": "hub",
  "trace_id": "dbdc1060-a7b9-4999-ac9a-5ad4d1d4c99d",
  "thread_id": "gemini_01",
  "reason": "no_stable_reply_within_max_attempts",
  "max_attempts": 40,
  "delay_ms": 500,
  "msg": "waitForAgentReply returning null: no stable agent reply within max attempts (GET /messages empty, all transient, or isNewAgentReply never true)"
}
```

---

## 3 排查流程

1. 用户在 Telegram 看到「[success] thread=... trace=...」+ JSON 响应体等 fallback 内容。
2. 从结果文案中取出 `trace_id`（或 thread_id）。
3. `grep <trace_id> /var/log/hub/hub.log`（或 `jq 'select(.trace_id == "<trace_id>")' /var/log/hub/hub.log`）。
4. 若存在 **msg** 含 “Run using fallback content”，则确认本条 run 使用了 fallback。
5. 同 trace_id 下查找 **reason**：
   - `client_has_no_getMessages` → 当前 client 未实现 getMessages，需检查 agent 类型与启动方式。
   - `getMessages_threw` → 查看 **err**：404/500/超时或 `response.messages must be an array` 等，对应 agent 的 GET /messages 实现或网络问题。
   - `no_stable_reply_within_max_attempts` → GET /messages 未在限定次数内返回新且非 transient 的 agent 消息，或 agent 未实现/未更新 GET /messages。

---

## 4 与主规格的关系

- 本附加说明**不修改**主规格中的必填字段、文件路径、轮转策略、Pino 配置。
- 仅**新增** Hub Core 在 run 意图下、与 waitForAgentReply 及 fallback 相关的 **warn** 条目及 **reason** 等扩展字段约定。
- 主规格中「按 trace_id 查全链路」的流程不变，本附加日志同样参与 `grep trace_id hub.log` / jq 查询。

---

*--- Calling Hub · 日志规格附加说明 · Run Fallback Diagnostics ---*
