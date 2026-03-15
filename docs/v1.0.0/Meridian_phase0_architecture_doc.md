# Calling Hub · Phase 0 架构说明（文档版）

> 由交互式 JSX 架构图转换而来。  
> 这是一份更适合 GitHub / GitBook / 需求文档阅读的文字版说明。

## 1. 总体定位

Calling Hub Phase 0 的目标，是让操作者通过 Telegram 向宿主机上的多个 CLI Coding Agent 下发任务，并接收结果回传。整个系统以 Calling Hub Core 作为唯一控制平面，所有渠道输入与 Agent 调度都必须经过 Hub。

这个 JSX 架构图表达的核心不是单纯的“页面布局”，而是一个清晰的系统分层：

1. 外部世界
2. Interface Layer
3. Calling Hub Core
4. Monitor（旁路独立监测）
5. agentapi 层
6. CLI Agent 层

## 2. 总体数据流

完整主流程如下：

1. 操作者通过 Telegram 客户端发送消息
2. Telegram Bot API 将消息交给 `grammY Bot`
3. Interface Layer 把消息标准化为 `InboundUIEvent`
4. Hub Core 将其进一步转换为 `HubMessage`
5. Hub Core 根据 `intent + target` 路由到对应的 agentapi 实例
6. agentapi 再把任务交给具体 CLI Agent（Claude / Codex / Gemini / Cursor）
7. CLI Agent 执行后，结果由 agentapi 返回给 Hub
8. Hub 封装 `HubResult` 并通过 Telegram 原路回传给操作者

此外，Monitor 作为旁路模块持续监控 agentapi 实例状态，并在必要时通过 IPC 通知 Hub。

## 3. 分层结构

## 3.1 外部世界

该层包含两类对象：

| 节点 | 含义 |
|---|---|
| 操作者 Telegram | 当前 Phase 0 的唯一实际入口，支持手机和桌面客户端 |
| 未来渠道 | Email / Nostr / WhatsApp 等后续扩展入口 |

这一层和系统内部的通信方式是 HTTPS，而不是 IPC。

## 3.2 Interface Layer

这一层的核心实现是：

- `grammY Bot（TypeScript）`
- 支持 `Long Polling / Webhook`
- 负责输出标准化的 `InboundUIEvent`

其职责边界很明确：  
**只负责渠道适配与消息收发，不负责业务判断。**

也就是说，它不是调度中心，也不是实例管理器，只是一个输入/输出适配层。

### 这一层的主要输入输出

| 方向 | 内容 |
|---|---|
| 输入 | Telegram Bot API 传来的用户消息 |
| 输出 | `InboundUIEvent` 标准化事件 |

## 3.3 Calling Hub Core

这是整个体系的核心，也是 JSX 图中最强调的一层。

它由四块核心能力构成：

| 模块 | 作用 |
|---|---|
| 标准化 | 把 `InboundUIEvent` 转换为 `HubMessage` |
| 路由 | 根据 `intent + target` 选择目标实例 |
| 可观测 | 用 `trace_id + Pino` 记录全链路日志 |
| 实例管理器 | 管理所有 agentapi 子进程的生命周期 |

### Calling Hub Core 的定位

它是：
- 唯一控制平面
- 所有指令必经之路
- 所有回传结果的统一出口

它不是：
- 渠道适配器
- 具体 Agent 执行器
- 监控模块本身

## 3.4 实例管理器（Instance Manager）

实例管理器属于 Hub Core 的一部分，但在图中被单独强调，说明它是一个关键子模块。

它负责的生命周期操作包括：

- `spawn`
- `kill`
- `attach`
- `detach`
- `status`
- `list`

它管理的对象不是 Telegram 会话，而是 **agentapi 子进程实例**。

### 它维护的核心信息通常包括：

| 字段 | 说明 |
|---|---|
| `thread_id` | 实例标识 |
| `pid` | 子进程 ID |
| `mode` | Bridge 或 Pane Bridge |
| `status` | 当前状态 |
| socket / 连接信息 | 与 agentapi 的 IPC 地址 |

## 3.5 Monitor 层

Monitor 是图中唯一明确标注为“独立模块 · 低耦合”的部分。  
这说明设计意图是：**它不参与主流程调度，但负责持续感知系统状态。**

它支持两类监测模式：

| 模式 | 说明 |
|---|---|
| Heartbeat 轮询 | 轮询 `GET /status` 检查状态 |
| SSE Hook 回调 | 订阅 `GET /events` 获取实时事件流 |

当 Monitor 发现任务完成、状态变化、异常、失联等情况时，会通过 IPC 通知 Hub。

因此它的关系是：

- 不直接控制 Agent
- 不直接面对操作者
- 只向 Hub 报告事件

## 3.6 agentapi 层

这层是 Hub 与实际 CLI Agent 之间的统一控制层。

JSX 中给出的关键信息是：

| 项目 | 内容 |
|---|---|
| 仓库 | `github.com/coder/agentapi` |
| 类型 | Go binary |
| 协议 | HTTP over Unix socket |
| 核心接口 | `POST /message` / `GET /status` / `GET /events` |
| 许可 | MIT |

### 它的主要价值

- 把不同 CLI Agent 统一封装成一致的可编程接口
- 让 Hub 不需要关心各家 CLI 的内部差异
- 支持两种运行模式：Bridge 与 Pane Bridge

## 3.7 CLI Agent 层

当前图中包含四类 CLI Agent：

| Agent | 说明 |
|---|---|
| Claude Code CLI | Anthropic 体系 |
| Codex CLI | OpenAI 体系 |
| Gemini CLI | Google 体系 |
| Cursor CLI | Cursor 体系 |

架构上，它们都不直接与 Hub 通信，而是统一挂在各自的 agentapi 实例之后。

也就是说，这张图强调的是：

**Hub 调度的直接对象是 agentapi，而不是 CLI Agent 本身。**

## 4. 两种 Agent 控制模式

图中特别把 agentapi 的工作模式拆成了两块：

## 4.1 Bridge 模式

特点：
- 后台 pty 运行
- 无界面
- 操作者看不到终端
- 适合自动化、无人值守场景

## 4.2 Pane Bridge 模式

特点：
- pty attach 到 tmux pane
- Hub 仍可写入指令
- 操作者可以实时旁观，甚至介入
- 协议层不变，只是可视化和控制体验不同

### 这两种模式的关键意义

它们说明这个系统不是单纯的“黑盒代理调用”，而是兼顾：

- 完全自动化
- 半自动 / 可监督执行

## 5. 通信协议设计

这张 JSX 图很强调“内部通信”和“外部通信”的区别。

## 5.1 外部通信

| 路径 | 协议 |
|---|---|
| 操作者 ↔ Telegram Bot API | HTTPS |
| Telegram Bot API ↔ Hub | Webhook HTTPS 或 Long Polling |
| Hub → Telegram 回传 | HTTPS |

这是面向互联网的标准通信路径。

## 5.2 内部通信

| 路径 | 协议 |
|---|---|
| Hub ↔ agentapi | Unix Domain Socket |
| Hub ↔ Monitor | Unix Domain Socket |
| Hub ↔ Instance Manager | 同进程内部调用 |

图中还明确强调了内部采用 IPC 的理由：

- 比 localhost TCP 更快
- 不占用端口
- 不经过网络栈
- 更适合单机内多进程协作

## 6. 核心设计判断

从这张图可以提炼出几个关键架构判断。

### 6.1 Hub 是唯一控制平面
所有命令都必须进入 Hub，再由 Hub 决定调度路径。  
这避免了渠道层、监控层、Agent 层互相绕过，保持系统边界清晰。

### 6.2 Interface Layer 故意做薄
Telegram Bot 只做接入，不做业务逻辑。  
这为未来替换渠道、增加渠道留下了空间。

### 6.3 agentapi 是统一控制抽象
不直接针对 Claude / Codex / Gemini / Cursor 分别写一套控制逻辑，而是通过 agentapi 形成统一协议面。

### 6.4 Monitor 是旁路，不侵入主流程
它不负责调度，只负责感知和报告。  
这让主流程更清晰，也让监测能力更容易替换和扩展。

### 6.5 Bridge / Pane Bridge 是体验层分叉，不是协议层分叉
这点非常重要。  
图中表达的是：协议仍然统一，只是在实例生成时选择不同运行形态。

## 7. Pane Log 与多端历史一致性

### 7.1 单源与职责

| 需求 | 机制 |
|------|------|
| 及时回复 | HubResult → reply_channel（Telegram/Web 等）、GUI chat bubble；仅 trace_id block 级 |
| 展示全文 | `pane-{threadId}.log` 为**唯一持久源**：capture（tmux 快照 delta）+ run 注入（HubResult.content） |
| 多端历史 | 按轮次的结构化历史：`conversation_history`（state-store）+ 统一 **History API** |

Meridian 保持 A2A calling hub；HubResult 为协议层「任务结果」；run 注入到 pane log 时做去重，避免与 capture 已写入内容重复。

### 7.2 多端历史以 Meridian 为准

所有端（Telegram、Web、未来 IM）通过同一 **History API** 拉取按轮次的历史：

- **数据来源**：Hub Router 的 `conversation_history`（内存）持久化到 state-store 的 `conversation_history`。
- **写入时机**：run 完成路径由 Router 调用 `recordAgentConversationEntry`；push 回调由 `recordAgentPushConversation` 写入。
- **API**：Web 的 `/api/history?thread_id=`、`/api/history_threads` 等通过 Hub 的 `intent: "history"` 从同一 router/state 读取，**无其他历史来源**。

验收：在 A 端（如 Telegram）发起 run 并收到回复后，B 端（如 Web）调用 History API，应能看到同一 thread 下同一轮 user/agent 记录。

## 8. 适合如何落地成文档

如果你后续要把这一套放到 GitHub / GitBook / 设计文档里，推荐这样组织：

1. 先放一张 Mermaid 图，快速建立整体结构
2. 再放这份文档版说明，解释每一层做什么
3. 最后在附录中列：
   - 节点定义
   - 协议定义
   - Slash 命令
   - 实例状态模型
   - Monitor 事件模型

## 9. 转换保留与损失

### 保留了什么
- 原图的分层关系
- 节点职责
- 主流程与旁路监控关系
- 双模式 Agent 控制结构
- IPC / HTTPS 的通信分层

### 丢失了什么
- 原 JSX 的交互体验
- 点击节点弹出详情面板
- 颜色语义和 hover 高亮
- 更细的 UI 呈现细节

## 10. 一句话总结

这份 JSX 架构图本质上表达的是一个 **以 Calling Hub 为唯一控制平面的、Telegram 驱动的、多 Agent CLI 调度系统**；其内部通过 Unix Socket + agentapi 完成统一控制，并通过独立 Monitor 保持低耦合的可观测性。
