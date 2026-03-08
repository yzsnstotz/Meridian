# Run fallback 诊断日志 · 自测结果

**日期**：2026-03-08  
**范围**：`src/hub/router.ts` 新增的 waitForAgentReply / fallback 相关 WARN 日志及单测

---

## 1. 运行方式

- **单测**：`npm run test -- src/hub/router.test.ts`
- **覆盖**：三种「waitForAgentReply 返回 null」原因中的两种（见下）

---

## 2. 验证结果

| 场景 | 触发方式 | 预期日志 | 结果 |
|------|----------|----------|------|
| client 无 getMessages | 单测「HubRouter routes run intent through AgentAPIClient」：client 未实现 getMessages | `reason: "client_has_no_getMessages"` + 「Run using fallback content」 | ✅ 通过，WARN 含 trace_id / thread_id |
| getMessages() 抛错 | 单测「HubRouter run logs getMessages_threw and uses fallback when getMessages() throws」：getMessages 内 throw | `reason: "getMessages_threw"`、`err` 含错误信息 + 「Run using fallback content」 | ✅ 通过，result.content 为 fallback JSON |
| 40 次轮询无稳定回复 | 需 getMessages 一直返回空或全 transient / 无新回复，约 20s | `reason: "no_stable_reply_within_max_attempts"` + max_attempts / delay_ms | ⏸ 未在单测中覆盖（耗时长），可在真实 agent 或集成环境复现后查 hub.log |

---

## 3. 发现的问题（本次运行）

- **无**：未发现实现错误或回归。
- 单测中曾用非法 trace_id（非 UUID）导致 Zod 校验失败，已改为合法 UUID，测试通过。

---

## 4. 建议

- 线上/集成环境出现「Telegram 收到 JSON fallback」时，用该条消息的 **trace_id** 查 hub.log：  
  `grep <trace_id> /var/log/hub/hub.log`（或 `jq 'select(.trace_id == "<trace_id>")' /var/log/hub/hub.log`），根据 **reason** 区分：
  - `client_has_no_getMessages` → 当前 client 未实现 getMessages
  - `getMessages_threw` → 看 **err**，对应 GET /messages 失败原因
  - `no_stable_reply_within_max_attempts` → 20s 内未拿到新且非 transient 的 agent 回复

## 5. hub.log 可查前提（2026-03-08 补充）

- **dotenv 已静默**：`src/config.ts` 中 `dotenv.config({ override: true, quiet: true })`，避免 dotenv 的 tips 占满 hub.log，保证文件中以 Pino 的 JSON 行为主，便于 `grep trace_id`。
- **需先构建再重启**：若用 PM2 跑 `dist/hub/index.js`，需先执行 `npm run build` 再重启，否则运行的是旧 dist，无新增诊断日志。
- **历史 trace 查不到**：若某次重启前发生的 run 已走 fallback，其日志可能已被重启时的 hub.log 覆盖；用**新发生的** trace_id 在重启后的 hub.log 中查即可。

---

*--- Run fallback 诊断日志 · 自测结果 ---*
