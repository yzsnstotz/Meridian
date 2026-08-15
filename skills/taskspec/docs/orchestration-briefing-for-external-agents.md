# TaskSpec 与 Meridian 编排机制 —— 外部 Agent 简报

**适用范围**：你被请来对某个**具体 TaskSpec 实例**提建议（评审、挑毛病、提改进）。
**版本对应**：`/taskspec` v1.31.1 · meridian-roles（`/Users/yzliu/work/Meridian/Meridian-roles`）
**最后核验**：2026-08-07，结论均对照 meridian 源码实测/读码得出，文末附证据表。

---

## 0 · 为什么需要这份文档

TaskSpec 看起来是一堆 Markdown，实际上它**同时是一台编排机的输入**。

这造成一个反直觉的后果：**有些纯粹是「文档改进」的建议，会让整轮派发静默停摆** —— 不报错、不失败，只是 dispatcher 认为没有可派的行，然后安静地什么都不做。

读完这份文档，你应该能回答三个问题：

1. 这堆文件里，哪些是 meridian **机械解析**的，哪些只是给人看的？
2. 一个 worker 被 spawn 之后，究竟沿什么路径找到自己的任务？
3. 我这条建议会不会把编排搞坏？

**如果你只有时间读一节，读 §5（反面清单）。**

---

## 1 · 产物地图：谁拥有、谁读、meridian 是否解析

| 文件 | 谁写 | 谁读 | meridian 机械解析？ |
|---|---|---|---|
| `dispatch_plan.md` | 生成器写结构，**lifecycle 写状态** | dispatcher | ✅ **严格解析（承重）** |
| `dispatch_command.md` | 生成器 | **所有角色的入口** | ⚠️ 读内容（一条正则） |
| `dispatch/{worker,integrator,human,pm}.md` | 生成器 | 对应角色，各读各的 | ❌ |
| `context/<WORKER_ID>-context.md`（capsule） | 各波 Integrator（按波生成） | 该 worker | ❌ |
| `<WORKER_ID>.md`（任务卡） | 生成器 | 该 worker | ❌ |
| `index.md` · `pm_playbook.md` | PM / 生成器 | PM、人 | ❌ |
| `laws-curation.json` | 生成器（冻结一次） | 按波 capsule 生成器 | ❌ |
| `reports/<WORKER_ID>.md` | worker | lifecycle 查**新鲜度** | ✅ 目录存在性 + 命名约定 |

> ⭐ **关键洞察：meridian 只机械解析「两个半」东西** —— `dispatch_plan.md` 的主表（严格）、`dispatch_command.md` 的内容（一条正则）、`reports/` 的存在性与命名约定。
>
> **其余全部是「递一个路径过去 + 靠模型自己导航」。** 这既是好消息（新增文件不会打破解析），也是坏消息（导航链上任何一环被改得读不通，都不会有任何报错）。

---

## 2 · 一次 spawn 的完整链路

```
dispatcher 决定派 W-01
   │
   ├─ Hub 用 config 里的 command_file_path 起一个 agent
   │
   ├─ meridian 自己生成 wrapper prompt 并注入（与 taskspec 无关，无条件）：
   │     # Status
   │       Your row is pre-marked 🔄. The lifecycle store manages all plan
   │       status updates — you do not need to write to the dispatch plan yourself.
   │     # Reply Protocol
   │       结尾必须且只能有一个 <<<MERIDIAN-STATUS>>> 块
   │     # Dispatch Command
   │       Read and follow this file for your worker: <command_file_path>
   │       Do not request these contents inline — read them from disk.
   │
   ├─ worker 打开 dispatch_command.md
   ├─ 读顶部**角色路由表** → 跳 dispatch/worker.md
   ├─ 按约定找 W-01.md（任务卡）+ context/W-01-context.md（capsule）
   ├─ 干活 → 写 reports/W-01.md
   └─ 回复结尾发 <<<MERIDIAN-STATUS>>> outcome: complete
          │
          └─ lifecycle 用 expected_outputs 校验报告**是否本次会话内被写过**
             → 通过则记 complete；不通过则行留在 running，reconciler 重试
```

**三点必须记住：**

1. **wrapper 那三段是 meridian 无条件注入的**，跟 taskspec 生成时加没加 `--meridian` 无关 —— meridian 根本无从得知。
2. **meridian 不内联任何 taskspec 内容**，只递路径。所以 `dispatch_command.md` 必须是**可被 worker 读懂的路由器**。
3. **`outcome: complete` 不是自证的**，lifecycle 会去看报告文件是否真的新写过。

---

## 3 · `--meridian` 的核心：状态所有权

整个 flag 只围绕一件事：**谁有权写 `dispatch_plan.md` 的状态**。

| | 不加 `--meridian` | 加 `--meridian` |
|---|---|---|
| 状态由谁写 | **worker 自己**改计划文件 | **lifecycle store** 独占，worker 一个字不许改 |
| 怎么表达状态 | 编辑 `⬜ → 🔄 → ✅` | 结尾的 `<<<MERIDIAN-STATUS>>>` 块，**叙述文字一律被忽略** |
| 防撞 | claim-first：先抢占标 `🔄`，**计划文件即锁** | lifecycle thread-id reservation，行在 spawn 时已预标 |
| 谁判定通过 | worker 自测完自标 `✅` | worker **永不**标 `✅`；validator 角色单独跑一轮 |
| PM 升级 | worker 自己往 §4 追加 `⏳ PENDING` | worker 只发 `outcome: needs_pm`，§4 归 pm-resolver |
| 报告 | 直接写 | 已存在则追加 `## Attempt N`（跨重试保留 worker/validator/PM 历史） |

**它是「去矛盾」，不是「加能力」。** 不加 flag 却走 meridian，worker 会同时收到两套打架的命令（wrapper 说"你别写计划文件"，taskspec 说"先去标 🔄"），实测后果是：worker 去写 lifecycle 正在管的文件、validator 还没跑就自我提升成 completed、发自由文本 `⏸ PAUSE` 而 lifecycle 直接忽略导致行挂死。

---

## 4 · 三个机械契约（违反即**静默**停摆）

### 4.1 Master Dispatch Table 表头 —— 最容易踩

严格解析器（`role-handlers.ts::indexDispatchPlanColumns`）要求归一化后命中**六列**：

```
status · batch · worker · task · model · depends_on
```

（后三个有别名：`task|function_group|headline|action`、`model|agent|model_tier`、`depends_on|depends|dependencies`）

归一化规则是 `lowercase → 非 [a-z0-9] 全替换成 _ → 去首尾 _`。

> ⚠️ **中文表头会被归一化成空串。** 任何一列缺失 ⇒ `return null` ⇒ **整表跳过** ⇒ dispatcher 拿到 0 行 ⇒ 报"无可派工作"然后安静停下。

标准表头（不要改）：

```
| Status | Worker | Batch | Tier | Model | Depends On | Branch | Task |
```

额外列（`Tier`/`Branch`）无害，解析器忽略。**但六列必须在，且必须是英文。**

### 4.2 Status 必须是 `⬜`

`continue-dispatcher` 只把 `⬜` 当可派发的 pending。写 `TODO` / `PENDING` / `[ ]` / 空白 / 散文 ⇒ `pending: 0`、`failed: <行数>`，PRE-FLIGHT 永远起不来。

### 4.3 `Depends On` 空值必须是 ASCII `-`

`none` / `N/A` / `null` / 空白 / 散文都会被当成**未解析的依赖 token**，那一行永远不满足依赖。

> 补充一个实测细节：展示路径的 `parseDependsOn` 只过滤 em dash `—`，**不过滤 `-`**，所以你在 `dispatch-status` 输出里会看到 `depends_on: ["-"]`。这**不是 bug** —— 真正做资格判定的 `splitDependencyClauses` 两处都过滤了 `-`。看到 `["-"]` 不要"顺手修好它"。

### 4.4 单元格内禁止任何字面 `|`

解析器用朴素 `String.split("|")`，不懂转义、不懂反引号、不懂代码跨度。一旦某数据行的 cell 数与表头不等，**行枚举循环 `break`，该行以下全部静默丢弃**。

替代写法：` / `、`, `、` or `、括号列表，或直接改写掉联合类型。

### 4.5 `reports/` 目录必须存在

lifecycle 用 `expected_outputs` 校验 `outcome: complete` 时报告是否真被写过。该路径经四级回退推导：

```
计划行 → dispatch_command.md 的 "Write report to: `...`" 正则 → reports/ 约定 → dev_history/<worker>_report.md
```

v1.31.1 把 Completion Protocol 移进 `dispatch/worker.md` 后，**正则那一级不再命中**，链路落到「`reports/` 约定」——而那一级**只在目录已存在时**才返回 `reports/<WORKER_ID>.md`。

目录不存在 ⇒ 落到 `dev_history/<WORKER_ID>_report.md`，而 worker 写的是 `reports/<WORKER_ID>.md` ⇒ lifecycle 查不到新报告 ⇒ **拒绝 `complete`，行卡在 `running` 反复重试**。

---

## 5 · ⛔ 反面清单：这些建议会破坏编排

每条给出：**建议长什么样** → **为什么看着合理** → **实际后果**。

| # | 你可能想提的建议 | 看着为什么合理 | 实际后果 |
|---|---|---|---|
| 1 | 「表头改成中文，和文档其余部分统一」 | 一致性 | ⛔ 归一化成空串 → **整表不可见** → dispatcher 拿到 0 行 |
| 2 | 「`Depends On` 的 `-` 太含糊，写 `none` 更清楚」 | 可读性 | ⛔ `none` 成未解析依赖 → **PRE-FLIGHT 永不 eligible** |
| 3 | 「Status 用 `TODO` 比 `⬜` 更通用」 | 跨工具兼容 | ⛔ `pending: 0` → 整轮起不来 |
| 4 | 「Task 单元格里写清楚类型联合 `A \| B \| C`」 | 信息完整 | ⛔ cell 数错位 → **该行以下全部静默丢弃** |
| 5 | 「`dispatch_command.md` 已经退役了，标成 NOT FOR WORKERS 吧」 | 反映新架构 | ⛔ 它仍是**唯一入口**（手动派发和 meridian 都落在它上面）→ worker 第一眼看到"这不是给你的" |
| 6 | 「让 worker 完成后把行标成 ✅，闭环更清晰」 | 闭环 | ⛔ `--meridian` 下 lifecycle 独占状态 → 脏计划 / lifecycle 漂移 / 绕过 validator |
| 7 | 「worker 应该读 `dispatch_plan.md` 了解全局」 | 上下文充分 | ⛔ 回退 Context Scoping；Gate 2/5 会红；重新引入"同一规则多处措辞"的解释余地 |
| 8 | 「把 capsule 里的法搬回任务卡，少一个文件」 | 减少文件 | ⛔ 违反 Context Gate 3（同一规则不得跨 role/card/capsule 重复）；且制造卡片-capsule 漂移面 |
| 9 | 「capsule 一次性全生成，别按波来」 | 省事 | ⛔ capsule 携带依赖行的**实际 SHA**，未来波次的 SHA 尚不存在 → 只能填占位符 → 违反"绝不填占位符" |
| 10 | 「`reports/` 空目录没用，删掉」 | 清理 | ⛔ 见 §4.5 → `complete` 被拒，行反复重试 |
| 11 | 「GUI/UX 验收该由人来做，设成 HUMAN 行」 | 人工把关 | ⛔ `HUMAN` 只留给外部权限门（凭据、生产控制台、法务决策）。GUI/UX 必须是**有真实 model ID 的 agent E2E 行**，否则整轮停在人工等待 |
| 12 | 「PR 里加 `[run-action]` 把 CI 跑起来更保险」 | 更严格 | ⛔ 违反 `Action Run Policy: action-run-opt-in`；把本不该阻断的检查变成阻断项 |
| 13 | 「这条 worker 也顺便验一下那个前台指标」 | 提高覆盖 | ⛔ 同一 `(fixture, threshold, action)` 三元组只能有**一个** worker 持有可变验收；重复即生成期硬错误，且实测会导致 worker 死锁数小时 |
| 14 | 「让 worker 自己去 grep laws/ 和 learnings/」 | 更自主 | ⛔ 策展是生成期做的、且已冻结（`laws-curation.json`）。自行 grep 会造成同一轮内不同波次绑定规则集漂移 |

---

## 6 · 安全的建议长什么样

同样的关切，换个落点就不破坏编排：

| 你的关切 | ❌ 破坏编排的提法 | ✅ 安全的提法 |
|---|---|---|
| 表格可读性差 | 改表头文案 / 加列 | 在**主表之外**另起一张表（列数不同即可），或写进 `index.md` |
| 某行信息不足 | 让 worker 去读 `dispatch_plan.md` | 把信息加进**该行的 capsule** 或任务卡 |
| 依赖关系没表达清楚 | 在 `Depends On` 写散文 | 枚举确切 worker ID，或用 `ALL-PRIOR` |
| 某个验收没人做 | 给现有 worker 追加验收 | 指出该验收**应归哪一行**，建议改归属而非追加 |
| 状态流转不清晰 | 让 worker 写状态 | 指出 marker 的 `outcome` 取值是否用错 |
| 法/learnings 覆盖不够 | 让 worker 自己搜 | 建议在**生成期**扩大策展，并指出应加哪几条 |

---

## 7 · 提建议前的自检清单

对每一条建议问自己：

- [ ] 它会改到 `dispatch_plan.md` 的 **Master Dispatch Table** 吗？（表头 / Status / Depends On / 单元格内容）→ 若是，逐条对照 §4
- [ ] 它会让 **worker 读到更多文件**吗？→ 若是，检查 Context Gate 1（总预加载 ≤300 行）与 Gate 2（相关性）
- [ ] 它会让**同一条规则出现在第二个地方**吗？→ 若是，Gate 3 会红
- [ ] 它会改变**谁写状态**吗？→ 若是，几乎一定是错的
- [ ] 它会新增/删除**目录**吗？→ 检查 `reports/`、`context/`、`dispatch/`
- [ ] 它把某个验收**从一行挪到另一行**了吗？→ 检查三元组唯一性与 delegation 标记
- [ ] 它假设了「worker 会自己去找/自己判断」吗？→ 编排的整个设计前提是**不让 worker 自行判断**

**兜底原则**：如果一条建议的收益是「更好读 / 更一致 / 更完整」，而代价触及 §4 的任何一条机械契约 —— **放弃它，或换到 §6 的安全落点**。编排停摆的排查成本远高于文档不够漂亮。

---

## 8 · 证据表（本文结论的来源）

| 结论 | 来源 | 方式 |
|---|---|---|
| 严格解析器要六列，缺一 `return null` | `src/server/role-handlers.ts::indexDispatchPlanColumns` | 读码 |
| 归一化 = lowercase + `[^a-z0-9]+`→`_` | 同上 `normalizeTableHeader` | 读码 |
| 宽松解析器可正确解析标准表头 | `src/tool-gateway/tools/dispatch-status.ts::parseDispatchPlanRows` | **真实 import 实跑**（2 行、字段全对） |
| cell 数不等即 `break` 丢弃后续行 | `dispatch-status.ts` 行枚举循环 | 读码 |
| `-` 在资格判定路径被正确过滤 | `src/roles/agent-dispatcher/service-continuation.ts::splitDependencyClauses:611,618` | 读码 |
| `parseDependsOn` 只滤 `—` 不滤 `-`（展示路径，无害） | `dispatch-status.ts::parseDependsOn:1084` | **实跑观察到 `["-"]`** |
| wrapper 无条件注入 Status/Reply Protocol/Dispatch Command | `src/tool-gateway/tools/run.ts`（唯一分支是 dispatcher-vs-worker） | 读码 |
| Hub 只递路径不内联内容 | `run.ts:476` `Read and follow this file for your worker: ${commandPath}` | 读码 |
| `expected_outputs` 四级回退链 | `run.ts::deriveExpectedOutputs` | 读码 |
| `reports/` 空目录时返回 `reports/<id>.md`；不存在则落 `dev_history/` | `run.ts::deriveExpectedOutputFromConvention`（原注释：*"reports/ dir exists but empty — use short name"*） | 读码 |
| meridian **不读** 任务卡 / `dispatch/` / `context/` | 对 `run.ts`、`role-handlers.ts`、`dispatch-status.ts` 全量检索读路径 | 读码 |

---

## 附:术语速查

| 术语 | 含义 |
|---|---|
| **行 / row** | dispatch plan 里的一条，等于一个 worker 会话。**一次会话只做一行** |
| **capsule** | `context/<WORKER_ID>-context.md`，单个任务的最小闭包（目标/依赖 SHA/适用决议/适用法/拥有文件/禁止项/验收命令） |
| **role context** | `dispatch/<role>.md`，角色级规则；五条全局硬规则**只在这里定义一次** |
| **marker** | `<<<MERIDIAN-STATUS>>>` 块，worker 状态的**唯一**权威信号 |
| **lifecycle store** | meridian 侧的状态所有者，`dispatch_threads.json` 是其 sidecar |
| **Context Gate** | 派发前跑的五道生成期门：Size / Relevance / Duplicate Law / Historical Reference / Role Leakage |
| **`ALL-PRIOR`** | `Depends On` 的特殊 token，表示"以上所有行" |
