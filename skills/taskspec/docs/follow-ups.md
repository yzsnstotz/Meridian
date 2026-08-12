# TaskSpec Skill — Follow-ups

Open changes the skill should absorb, raised by real rounds. Each entry names the round that
found it, the evidence, and what "done" means inside `SKILL.md`. Close an entry by implementing
it and recording the version that shipped it — do not delete the entry.

| # | Title | Raised by | Status |
|---|---|---|---|
| FU-001 | Role protocol needs a single canonical owner | `unification-layer-decoupling-2026-08-06` · 2026-08-07 | ✅ SHIPPED — v1.35.0 |
| FU-002 | External-state rows must derive their scope and ground their assertions | `unification-layer-decoupling-2026-08-06` · 2026-08-09 | ✅ SHIPPED — v1.35.0 |

---

## FU-001 — 角色协议只能有一个 canonical owner，其他文档只引用

**Status**: ✅ SHIPPED — v1.35.0 (2026-08-09) · **Raised by**: `unification-layer-decoupling-2026-08-06`, PRE-FLIGHT (2026-08-07)
**Applies to**: `SKILL.md` Step 6.6 (role-scoped dispatch + Context Gates) and the
`dispatch_command.md` / `dispatch/<role>.md` templates.

### What happened

The round's `PRE-FLIGHT` worker hit two role documents giving **opposite** instructions for the
same action, and had to pick one on its own judgement:

| Document | Instruction |
|---|---|
| `dispatch_command.md` §2 | ⛔ **不要**往 `pm_playbook.md` §4 追加行；需要 PM 时用 `outcome: needs_pm` |
| `dispatch/worker.md` §阻塞 | 「并向 `pm_playbook.md` §4 追加一行」 |

Both are worker-facing. `dispatch/worker.md` is the one every worker actually loads, so the
contradiction resolved the **wrong** way by default — the forbidding document is the one workers
were told not to read. `PRE-FLIGHT` only got it right by reading a file outside its brief and
then reporting the conflict; 53 other rows would each have re-litigated it independently.

Compounding it: ~30 task cards say「上报 `pm_playbook §4`」 as shorthand for "escalate to PM".
Read literally against `worker.md`, that instructed 54 concurrent workers to append to one
shared PM-owned file that is in **no** worker's `Files Owned`.

### Second instance, same class — the dispatch route

The same round then hit it again on a different protocol. `index.md` declared
「Dispatch: **不走 meridian**。owner 用 claude-code 手动发送编排指令。」 while
`dispatch/worker.md` and `dispatch_command.md` §2 both told workers 「编排器在 spawn 时已把你的行
**预标 `🔄`**」 and 「状态由 **lifecycle** 拥有」. Under the manual route no lifecycle exists, so
every worker was told its row was reserved by something that isn't there — and the status column
had no owner at all.

The round's owner wants **both routes live and switchable at any time**. The fix that satisfies
that is not picking a side: it is writing the protocol **route-agnostically** — name the dispatcher
as 「派发方」, state once that the worker's obligations are identical under either, and put the
route-specific duties in a PM-side manual (`dispatch/manual-dispatch.md`), never in worker text.

⇒ The skill's generated worker templates must never hardcode a dispatcher. A round that can only
be dispatched one way is a round that silently breaks the day the operator switches.

### The generalization

Step 6.6 split one entry document into four role documents. The split duplicated protocol text
into each role file instead of leaving **one owner and N references**. Nothing in the skill
asserts that the copies still agree, so they drift silently — and the drift is invisible until a
worker is standing in front of two contradictory imperatives with no authority to resolve either.

This is structural, not a typo. Any future role-context split reproduces it.

### What the skill must do

1. **Declare an owner per protocol.** Each protocol (blocking/escalation · status ownership ·
   delivery · report format · claim) gets exactly one canonical section in one document. Every
   other document **references** it — no restated imperative, not even an "equivalent" paraphrase.
   Recommended owners: `dispatch_command.md` owns lifecycle/status (meridian parses it);
   `dispatch/<role>.md` owns that role's execution loop; `pm_playbook.md` is written **only** by
   the PM role.
2. **Emit a `Role-Protocol Consistency` gate** in the generated round: assert zero contradictory
   imperatives for the same action across `dispatch_command.md`, `dispatch/*.md`, and the cards.
3. **Make worker-facing text route-agnostic.** Templates say 「派发方」, never 「meridian 编排器」
   or 「lifecycle」. Route-specific duties live in a PM-side manual. The `Role-Protocol
   Consistency` gate asserts no worker-facing file claims which dispatcher is in use.
4. **Emit a `Files-Owned` gate**: every path a worker-facing instruction tells someone to *write*
   must fall inside that row's capsule `## Files Owned`. Shared orchestration files
   (`pm_playbook.md` · `dispatch_plan.md` · `plan.json` · `index.md`, other rows' cards/reports)
   are never a worker write target.
5. **Ship each gate with a negative fixture.** A gate that has never gone red is not a gate.

Gates 6 and 7 were hand-added to that round (see `W0-08.5` in its taskspec), and its role
documents were rewritten route-agnostically. Absorbing them into the skill means every future round gets
them for free instead of discovering the same class of contradiction at PRE-FLIGHT.

### Done when

- `SKILL.md` Step 6.6 states the single-canonical-owner rule and the owner table.
- The generated Context Gate set includes `Role-Protocol Consistency` and `Files-Owned`, each with
  a negative fixture.
- The `dispatch/worker.md` and `dispatch/integrator.md` templates escalate via `outcome: needs_pm`
  + the row's own report `## Blocker`, and contain **no** instruction to write a PM/orchestration
  file.
- No generated worker-facing file names a specific dispatcher; a round is dispatchable both ways
  without editing role documents.
- Version bumped and this entry marked `✅ SHIPPED — v<N>`.

---

## FU-002 — 改外部状态的行：范围必须**推导**，断言必须**探过**

**Status**: ✅ SHIPPED — v1.35.0 (2026-08-09) · **Raised by**: `unification-layer-decoupling-2026-08-06`, W1-03 (2026-08-09)
**Applies to**: `SKILL.md` 的 risk/routing 表（Blast radius · Reversibility 轴）、Step 6.6 的
Context Gate 集、以及 `PRE-FLIGHT` 模板。

### What happened

`W1-03`「DBC Legacy Purge（DELETE-only）」是全轮唯一不可回滚的一行。它备份完成并独立读回后，
**一条 DELETE 都没发**就 `needs_pm`。两个原因，都在派发前就已存在于卡片里：

**甲 · 删除范围是人工枚举的表清单，不是外键闭包。**
`W0-05` 的删除账本（`13-A/B/C` + `Z11`/`R11` 计数命令）逐张手写表名，盘点时点早于
`supabase/migrations/2026072701_foundation_v2_contracts.sql`。该迁移新增 4 张
`ON DELETE RESTRICT` 子表，全部漏掉。其中 `marketplace_service_operation_bindings` 有 5 条
legacy 行，物理阻断已授权父表的 DELETE —— 不删它删不动，删它违反「一项不多一项不少」。

讽刺的是卡片**已经写了**「外键需支撑索引，删前确认」：它想到了外键影响删除**性能**，
没想到外键决定删除**范围**。差一步。

**乙 · 保留断言抄自决议文档，从没对真实目标探过一次数。**
卡片要求删前/删后复验「用户 Vault 表非空」「7 个 delisted catalog 记录非空」。实测：
DBC 上**根本没有 Vault 表**（Vault 在客户端 `credential_broker.rs` 的 Keyring），
7 个 slug 在 live `market_listings` 里是 `0`。两条断言在**删除开始前就是假的**。

**丙 · 放大器 —— 反向证据和正向证据是同一份枚举。**
`R11`（反向证据）设计意图是交叉验证 `Z11`，但两者枚举了**同一份表清单**。
于是它验的是「同一个错误抄了两遍」。`LEGACY-ZERO-GATE` / `FINAL-LEGACY-ZERO-GATE` /
`DBB-01` 三者又单源引用同一份账本 ⇒ 归零门可以在 legacy 行还活着时**假绿**，
且 `DBB-01` 会在**生产库**上原样再撞一次。

### 发现成本（这是关键）

两个缺陷都能在**派发前**发现，而且极便宜：

| 缺陷 | 成本 |
|---|---|
| 外键漏项 | **纯静态**，`grep -rn "REFERENCES public.<父表>" supabase/migrations/`。不连库、不跑 worker |
| 断言不成立 | **一次只读 count**，三条 curl |

所以这不是「只能在运行时暴露」的问题，是生成期漏做了一次检查。

### The generalization

`SKILL.md` 的 risk 表**已经**有这两个轴：

```
| Blast radius  | ... | Security, data integrity, release authority, irreversible migration |
| Reversibility | ... | Destructive/external state or difficult recovery                    |
```

**它把这个分类整个花在了 model routing 上，没有转成任何验证义务。**
一行被判定为「不可逆 / 改外部状态」，结果只是拿到一个更贵的模型 —— 而模型再贵也推不出
一张它从没被告知存在的表。

对称地看，现有 `PRE-FLIGHT` 探的是 worktree · UI 探针 · 占位符 lint · canon 身份 ——
**全是本地的、代码侧的**。整轮唯一一个改外部不可逆状态的行，反而是唯一没被探过的目标。

### What the skill must do

**armed conditionally** —— 只在 risk 表把某行判为「Destructive/external state」时触发，
普通行零成本，不给每一轮加负担。

1. **Scope-Derivation 义务。** 若一行的范围是「某系统里的一组实体」，且该系统有**可推导的
   依赖图**（DB 外键图 · 模块 import 图 · package dependents），则范围必须由图**推导**，
   卡片里给出推导命令，而不是手写实体清单。手写清单只能作为**起点集合**。
   生成期发一条 diff 断言：`derive(起点集合) − 账本枚举 = ∅`；非空即 HARD generation error。
   对 DB：`ON DELETE RESTRICT` / `SET NULL` / `CASCADE` 三类子表都必须被点名 ——
   `RESTRICT` 卡死、`CASCADE` 误删保留项、`SET NULL` 静默改数据。删除顺序 = 拓扑序。

2. **Assertion-Grounding 义务。** 每一条关于**外部既存状态**的验收断言，必须带一个
   **生成期实测的删前值**和取值命令。取不到值（表不存在 / count = 0）时，断言必须从
   「非空」改写成「计数不变」，并记录理由。
   ⛔ 生成期写不出实测值的断言不得进卡片 —— 没测过的保留断言和没有断言等价，更糟，
   因为它给人一种「验过了」的错觉。

3. **Reverse-Evidence Independence 检查。** 若一个门指标有配套的「反向证据」命令，
   两者的**推导路径必须不同**（本例：正向从账本枚举计数，反向应从 migrations 推导应有表集合），
   不是换一种写法数同一份清单。命令文本高度相似即 flag。

4. **Gate-Metric Provenance 检查。** 若 `Gate.metric` 的取值命令来自某个 worker 的报告，
   该 gate 只能证明**那个 worker 自洽**。要么给一条独立推导路径，要么在门里显式标注
   「本门依赖 `<W>` 的产出，不构成客观证明」。三个门单源引用同一份账本必须被 flag。

5. **Pinned-Artifact Amendment 一致性。** capsule 会把上游产物的 sha256 pin 住。
   修正账本（哪怕是纯尾部 append）都会让旧 pin 失配，worker 开工即 blocked。
   修账本是**三件套**：append 账本 → 改卡片 Entry point → 改 capsule sha256。
   技能应把这三步写成一个具名操作，并在 Context Gate 里查 pin 与文件实测 sha 一致。

6. **每个 gate 配一条负向 fixture。** 没红过的门不是门（沿用 FU-001 第 5 条）。

### Done when

- risk 表的「Destructive/external state」判定除了 model routing，还 arm 上面 1–2 两条义务。
- 生成期对被 arm 的行执行 Scope-Derivation diff 与 Assertion-Grounding 实测，任一失败 = HARD error。
- Context Gate 集含 `Reverse-Evidence Independence`、`Gate-Metric Provenance`、
  `Pinned-Artifact Consistency`，各带负向 fixture。
- `PRE-FLIGHT` 模板在存在外部状态行时，增加一条**对该外部目标的只读现实探针**
  （目标 ref 打印 + 范围计数 + 保留项计数），与本地探针并列。
- 版本号 bump，本条标记 `✅ SHIPPED — v<N>`。

### 现场证据

- 账本修正：`Projects/clawso/branch/unification-layer-decoupling-2026-08-06/taskspec/reports/W0-05-legacy-inventory.md` › `## Amendment A1`
- 复发防护：同轮 `taskspec/pm_playbook.md` §1.25 / §1.26
- 完整根因：`Projects/clawso/learnings/process/delete-scope-must-be-fk-closed-and-retention-assertions-probed.md`
- 解决记录：同轮 `handoff/RESOLVED-20260809-w1-03-dbc-ledger-gap.md`

---

## Shipped in v1.35.0 — where each item landed

| Item | Landed at |
|---|---|
| FU-001 · single canonical owner per protocol + owner table | `SKILL.md` § 6.6.1 「One canonical owner per protocol」 |
| FU-001 · route-agnostic worker text; `dispatch/manual-dispatch.md` | § 6.6.1 「Worker-facing text is route-agnostic」 · § 6.6.7 emitted layout |
| FU-001 · `Role-Protocol Consistency` gate | Context Gate **6** (§ 6.6.6) + Final Compile Gate `Context` class |
| FU-001 · `Files-Owned` gate | Context Gate **7** (§ 6.6.6) + `dispatch/worker.md` MUST-NOT list |
| FU-002 · risk classification arms obligations | § 5.3 routing step **6** → `**External State**: true` |
| FU-002 · Scope-Derivation + Assertion-Grounding | § **5.3a** External-State Obligations (both HARD generation errors) |
| FU-002 · planwide invariant + seeded playbook rows | § **5.5.d2** (mirrors 5.5.d) + Step 6.4 `pm_playbook §1` seeding |
| FU-002 · card section | Worker Definition Template › `#### External State Contract` |
| FU-002 · external target probe | PRE-FLIGHT Worker Template › `PRE-FLIGHT.X` |
| FU-002 · gates 8/9/10 | Context Gates **8** Reverse-Evidence Independence · **9** Gate-Metric Provenance · **10** Pinned-Artifact Consistency + Final Compile Gate `External state` class |

**Cost shape.** Gates 1–7 run on every round. Gates 8–10, `PRE-FLIGHT.X`, § 5.3a and the
`#### External State Contract` section are **armed only** when a row scores `Reversibility = High`
or `Blast radius = High`. A purely local round pays nothing for either follow-up.

**Still owed (both entries):** each new gate needs a negative fixture proving it can go red.
Gates that have never failed are not yet gates — carry this into the next round that arms them.
