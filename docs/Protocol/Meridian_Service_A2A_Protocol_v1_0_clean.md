# Meridian Service

接入协议说明书

> 版本 v1.0 · 基于 A2A 协议
> 2026年3月

# 1. 概述

本文档定义了任何 Service Agent 接入 Meridian
控制平面的标准协议。遵循本协议的 Service 无需定制代码，可直接被 Meridian
调度，并通过 OpenClaw 响应跨项目任务请求。

本协议基于 Google A2A（Agent2Agent）标准，通信格式为 JSON-RPC
2.0，传输层为 Unix Socket。

> 📌 一句话总结：实现本协议 = 声明你能做什么（Agent Card）+ 接收任务（tasks/send）+ 返回结果（TaskResult）。

# 2. Service 必须实现的接口

## 2.1 Agent Card（能力声明）

每个 Service 必须在启动时向 Meridian 提交一份 Agent
Card，描述自己的服务标识和能力。格式如下：

```json
{
"name": "cord-project-alpha",
"description": "负责 Alpha 项目的自动化研发闭环",
"version": "5.1",
"url": "/tmp/cord-alpha.sock",
"skills": [
{
"id": "coding",
"name": "代码开发任务",
"description":
"接收需求描述，完成代码编写、测试、审查的完整闭环",
"intents": ["coding", "refactor", "bugfix", "test"],
"tags": ["development", "cord"]
},
{
"id": "review",
"name": "代码审查",
"description": "对已有代码进行质量评审",
"intents": ["review"],
"tags": ["development"]
}
]
}
```

intents 字段中的每个字符串是 Meridian 路由的 key。当 OpenClaw 发来一个
intent="coding" 的消息时，Meridian 会将其路由到声明了该 intent 的
Service。

## 2.2 注册请求

Service 启动后，通过 Meridian 的主
socket（/tmp/hub-socks/hub-core.sock）发送注册消息：

```json
{
"trace_id": "<uuid>",
"thread_id": "register",
"actor_id": "cord-project-alpha",
"intent": "register_service",
"target": "global",
"priority": 5,
"mode": "bridge",
"reply_channel": {
"channel": "web",
"chat_id": "service:cord-project-alpha"
},
"payload": {
"content":
"{service注册的JSON字符串，包含socket_path和agent_card}",
"attachments": []
}
}
```

Meridian 返回 HubResult，status="success" 表示注册成功。

## 2.3 接收任务（tasks/send）

Service 的 Unix Socket 必须能处理以下格式的 JSON-RPC 请求，这是 Meridian
转发任务的标准格式：

```json
{
"jsonrpc": "2.0",
"method": "tasks/send",
"id": "<trace_id>",
"params": {
"id": "<trace_id>",
"message": {
"role": "user",
"parts": [
{
"type": "text",
"text": "<原始HubMessage的JSON字符串>"
}
]
}
}
}
```

Service 解析 params.message.parts[0].text 即可得到完整的
HubMessage，包含任务的所有上下文。

## 2.4 返回结果（TaskResult）

Service 处理完任务后，必须在同一个 socket 连接上返回以下格式的响应：

```javascript
{
"trace_id": "<与请求相同的trace_id>",
"thread_id": "<service的thread标识>",
"source": "<agent类型，如 claude/codex>",
"status": "success", // success | error | partial | timeout
"content": "<任务执行结果的文本描述>",
"attachments": [],
"timestamp": "<ISO8601时间戳>"
}
```

> ⚠️ 注意：响应必须是完整的 HubResult 格式，Meridian 会做 schema 验证。status 字段只接受 success / error / partial / timeout 四个值。

# 3. 完整生命周期

## 3.1 Service 生命周期

|          |          |                                                                       |
|----------|----------|-----------------------------------------------------------------------|
| **步骤** | **阶段** | **操作**                                                              |
| 1        | 启动     | Service 进程启动，创建自己的 Unix Socket，开始监听                    |
| 2        | 注册     | 向 Meridian hub-core.sock 发送 register_service 请求，附上 Agent Card |
| 3        | 确认     | 收到 Meridian 返回的 success HubResult，注册完成                      |
| 4        | 就绪     | 开始在自己的 socket 上监听 tasks/send 请求                            |
| 5        | 执行     | 收到任务 → 执行 → 返回 HubResult（同步）                              |
| 6        | 退出     | 进程退出前向 Meridian 发送 unregister_service 请求                    |

## 3.2 任务流转示意

```text
OpenClaw Meridian Service
| | |
|--- HubMessage ---------->| |
| intent: 'coding' | |
| |-- ServiceRegistry查询 --> |
| | |
| |-- tasks/send (A2A) ----->|
| | |--- 执行任务 ---|
| | | |
| |<---- HubResult ----------|<--------------|
|<---- HubResult ----------| |
| | |
```

# 4. 错误处理规范

## 4.1 Service 必须处理的错误场景

|                       |                                            |                |
|-----------------------|--------------------------------------------|----------------|
| **场景**              | **期望行为**                               | **返回status** |
| 任务执行失败          | 在 content 中说明失败原因                  | error          |
| 任务执行超时（\>60s） | 返回当前进度，说明超时                     | timeout        |
| 任务进行中（长任务）  | 先返回 partial，后续发 monitor 事件        | partial        |
| 收到无法识别的 intent | 返回 error，说明不支持该 intent            | error          |
| 内部崩溃              | 捕获异常，返回 error，不让 socket 连接挂起 | error          |

## 4.2 禁止行为

- 不允许不返回响应（让 Meridian 等到超时）
- 不允许返回非标准格式（必须是合法的 HubResult JSON）
- 不允许 Service 直接向用户发 Telegram 消息（必须通过 HubResult 返回给
  Meridian，由 Meridian 转发）
- 不允许修改 trace_id（响应的 trace_id 必须与请求相同）

# 5. CORD 接入示例

以下是 CORD 作为 Service 接入 Meridian 的参考实现结构：

```javascript
// CORD A2A Server 伪代码
const server = net.createServer((socket) => {
socket.on('data', async (data) => {
const request = JSON.parse(data.toString());
if (request.method === 'tasks/send') {
const hubMessage = JSON.parse(
request.params.message.parts[0].text
);
// 执行 CORD 任务
const result = await cord.executeTask({
content: hubMessage.payload.content,
intent: hubMessage.intent,
trace_id: hubMessage.trace_id
});
// 返回标准 HubResult
socket.end(JSON.stringify({
trace_id: hubMessage.trace_id,
thread_id: result.thread_id,
source: 'claude',
status: 'success',
content: result.summary,
attachments: [],
timestamp: new Date().toISOString()
}));
}
});
});
server.listen("/tmp/cord-alpha.sock");
```

# 6. Agent Card 字段参考

|                        |          |                                                     |
|------------------------|----------|-----------------------------------------------------|
| **字段**               | **必填** | **说明**                                            |
| name                   | ✅ 必填  | Service 的唯一标识名称，建议使用 kebab-case         |
| description            | 推荐     | Service 功能的简短描述，供 OpenClaw 理解能力范围    |
| version                | 可选     | Service 版本号，用于调试和审计                      |
| url                    | ✅ 必填  | Service 的 Unix Socket 路径                         |
| skills                 | ✅ 必填  | 能力列表，至少一个 skill                            |
| skills[].id          | ✅ 必填  | skill 的唯一标识符                                  |
| skills[].name        | ✅ 必填  | skill 的展示名称                                    |
| skills[].intents     | ✅ 必填  | 该 skill 处理的 intent 列表，是 Meridian 路由的依据 |
| skills[].description | 推荐     | 详细描述该 skill 的适用场景和限制                   |
| skills[].tags        | 可选     | 自由标签，用于后续语义搜索发现                      |

# 7. 快速接入检查清单

> ✅ 完成以下所有检查项，你的 Service 即可接入 Meridian。

- 准备 Agent Card JSON，包含 name、url、至少一个 skill 和对应 intents
- 在 Service 启动脚本中加入向 Meridian 发送 register_service 的逻辑
- 在 Service 的 Unix Socket 服务端实现 tasks/send 方法
- 确保响应格式严格符合 HubResult schema
- 错误情况下也必须返回 HubResult（status=error），不能静默失败
- 在 Service 退出逻辑中加入 unregister_service 调用
- 在 Meridian 开发环境中发送测试消息，验证路由和响应正常
