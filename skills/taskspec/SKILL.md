---
name: taskspec
description: Use when turning requirements, PRDs, feature ideas, task breakdown requests, sprint planning, or implementation questions into structured TaskSpec execution plans; supports append, Codex assignment, and Meridian-compatible artifact generation.
version: 1.39.0
upgrade_from: v1.39.0 adds 6.7.14 — generation emits `review_checklist.md`, a plan-derived post-round audit run by someone who executed no row in it, because every existing check is per-row and the expensive failures (unmerged rollup rows, gate rosters drifted from the DAG, a card whose own search patterns hit nothing, a materialiser blanking an owner-signed constraint, a one-character marker typo stranding 26 rows) are all invisible from inside a row and trivial from outside (Gate 16); prior v1.38.0 closes the failure family that stalled three rows in one live wave — 6.7.13 Acceptance Reachability (an acceptance item whose satisfying surface is outside the row's `Files Owned` is unsatisfiable; mounting points count as surface; after a purge wave, re-grep every downstream card's pointers against the post-purge tree; a new function with no non-test caller is not a deliverable) with Gate 15 — and records the parser-side fix for 6.7.11 (Meridian-roles now accepts `<<<END>>{2,}` and an unterminated trailing block, falling back to the last schema-valid block; Gate 13 stays armed). Prior v1.36.0 adds the general engineering philosophy the skill never carried — 6.7.9 Scope Discipline (every line of code and every line of spec attributable to an acceptance item; Gate 11) and 6.7.10 Crucial-Choice Disclosure (≥2 material routes ⇒ options + reasons + recommendation to the operator, never a silent pick; generation stage strongly preferred; reuses the existing LAW CONFLICT → pm_playbook §4 channel; Gate 12) — plus three findings measured on live rounds: 6.7.8 restores the runtime-read-budget record lost when v1.37.0 was reverted, now with both the negative result (a worker.md prohibition measured +7%, because it sits downstream of the system prompt) and the positive one (spawn-time roster control, −43% prologue and skills+laws 39.2%→3.5%); 6.7.11 the completion marker is machine-parsed and one missing character stalled 26 rows for 3h26m (Gate 13); 6.7.12 capsules must be validator-sufficient because only 39% of validators open the capsule and 21% the card (Gate 14); prior v1.35.0 closes FU-001 + FU-002 — single-canonical-owner rule for role protocols with route-agnostic worker text (Gates 6 Role-Protocol Consistency, 7 Files-Owned), and external-state rows now convert their own risk classification into two generation-time obligations (Scope-Derivation from the dependency graph, Assertion-Grounding against a measured pre-value) plus Gates 8 Reverse-Evidence Independence, 9 Gate-Metric Provenance, 10 Pinned-Artifact Consistency and a PRE-FLIGHT.X external-target reality probe; prior v1.33.0 restores the orchestrator boundary — capsule materialization split (wave 0 by the skill, later waves by the Integrator), Meridian Compatibility Compile Check (entry must stay worker-readable; lifecycle ownership not re-implemented), No-Forward-Evidence gate check, gate bodies derived from the DAG, total preload budget, domain-scoped invariants; prior v1.32.0 Canonical Task Graph (plan.json) with an orchestrator-fidelity consistency gate; capsules emitted at generation time (retires the per-wave step and laws-curation.json); Final Compile Gate emitting READY_FOR_DISPATCH; completion-protocol drift + undefined-upstream-contract + concurrent-shared-writer rejects; architecture modes armed by round shape; Step 6.6 un-fenced from the worker template; prior v1.31.1 curated laws move to the Context Capsule (card keeps a one-line pointer) — resolves the v1.31.0 Gate-3 self-contradiction; persisted laws-curation.json freezes the sweep across waves; dispatch_command.md reaffirmed as the worker-readable entry router; prior v1.31.0 role-scoped dispatch + task Context Capsules + five Context Gates (Step 6.6); prior v1.30.0 capability-aware Claude Opus 4.7/4.8 and Codex GPT-5.6 Sol/Terra/Luna routing, v1.29.0 action-run opt-in policy, v1.26.0 test-gate lint, v1.25.0 idempotent branch checkout, v1.24.0 orphan-WIP preservation
---

# TaskSpec Skill

Transforms requirements (documents, PRDs, or rough concepts) into **four executable artifacts** covering the full execution lifecycle from plan to merge:

1. **TaskSpec directory** — a directory under the external Docs tree, at the canonical layout `./Docs/<project>/branch/<taskspec-id>/taskspec/` (resolved to an absolute path during generation; this is the `taskspec/` sub-folder of the **round directory** `branch/<taskspec-id>/` — see the v1.19.0 four-folder layout note below), containing `index.md` (overview, dispatch table, integration points, runtime contracts) and one `<WORKER_ID>.md` file per worker (full definition, sub-tasks, tests, acceptance criteria). Workers read only their own file.
2. **Dispatch Plan** — master dispatch table with batch assignments, model assignments, PR tracking, and completion tracking
3. **Dispatch Command** — the verbatim command file worker sessions receive at the start of every session
4. **PM Playbook** (`pm_playbook.md`) — the human/PM input lane. Scaffolded by the skill, then maintained by PM/operators throughout the round. Carries: (§1) Blocker Resolutions Library, (§2) Failure Recovery Patterns, (§3) Applied Principles & Laws, (§4) Open Questions. Both **dispatcher and workers MUST consult it** before declaring a blocker or applying a failure workaround, and must apply any in-scope principles during execution. The skill creates the file with empty tables and instructions; PM appends entries as runtime issues emerge.

5. **Role-scoped dispatch + Task Context Capsules** (v1.31.0) — `dispatch/{worker,integrator,human,pm}.md` (each role reads only its own file) plus `context/<WORKER_ID>-context.md` (the minimal closure for one task: objective, dependency SHAs, only the decisions that apply, 5–8 task-level laws, files owned, prohibitions, required deletions, acceptance). A normal Worker's total preload is budgeted at **≤ 300 lines** and enforced by the Context Gates — 1–7 on every round, 8–10 armed when the round has an externally-stateful row (v1.35.0). See **Step 6.6**.

> 📌 **Open follow-ups raised by real rounds** live in `docs/follow-ups.md`. Read it before changing Step 6.6 (role-scoped dispatch / Context Gates). **FU-001** (role protocol single canonical owner) and **FU-002** (external-state rows must derive scope and ground assertions) shipped in **v1.35.0** — see Step 5.3a and Step 6.6.1/6.6.6.

> 📎 **Briefing anyone outside this skill** (a reviewer, an advising agent, a new operator) on how the artifacts and the meridian dispatcher actually interlock: hand them `docs/orchestration-briefing-for-external-agents.md`. It is self-contained, states which files meridian mechanically parses vs. merely routes, and carries a ⛔ list of plausible-sounding suggestions that silently wedge a round. Every claim in it is sourced to meridian code (file:line) and marked read-verified vs. run-verified.

The full execution lifecycle is always: **plan → dispatch → branch → execute → self-validate → PR → merge → base-branch resync → final INTEGRATE → POST-FLIGHT teardown** for GIT-mode code rounds. In standard per-worker-merge mode, each worker creates its own branch, self-validates against its acceptance criteria, opens its own PR, and must not mark the row `✅` until that PR is actually merged into the configured base branch and the local checkout has returned to that base branch. In rollup/stack mode, worker PRs may remain review artifacts only when their commits are explicitly incorporated into a final integration branch; then `INTEGRATE` is the single merge authority and must close/comment superseded worker PRs after the rollup merge. The terminal `INTEGRATE` row reconciles any rollup/stack/validation PR state before `POST-FLIGHT` removes worktrees. There are no terminal DELTA-CHECK or PR-REVIEW phases — validation is the worker's responsibility.

**🧠 Capability-aware model routing (v1.30.0 — Claude Opus 4.7/4.8 + Codex GPT-5.6 Sol/Terra/Luna):** Model assignment is now a two-axis decision: choose the lowest-capability **family** that safely covers the row, then choose the lowest **effort** that can close it with adequate proof. New Claude TaskSpecs may route stable, proven-pattern complex work to `claude-opus-4-7` and novel/high-consequence work to `claude-opus-4-8`. New Codex TaskSpecs route bounded mechanical work to `gpt-5.6-luna`, everyday implementation to `gpt-5.6-terra`, and ambiguous/high-risk cross-system work to `gpt-5.6-sol`. The generator keeps the existing T0–T3 schema for Meridian compatibility but may select more than one family/effort profile inside a tier. File count alone never upgrades a model; ambiguity, coupling, reversibility, blast radius, and proof burden do. `max` requires an exceptional-risk rationale. `ultra` additionally requires explicit permission for row-internal delegation and must never be inferred merely because a row is terminal or important. See Step 5.

**⚠️ "Tests pass" ≠ "Task complete" (v1.4.0 hardening — fix-oauth-settings incident):** In the fix-oauth-settings round, 5 workers completed all code changes and passed AI Auto-Tests + Behavioral Assertions but never created branches, committed, pushed, or opened PRs. The changes sat as uncommitted dirty files on main. Root cause: worker files listed `**Branch**: ...` as inert metadata but contained no explicit git delivery instructions. Workers treated "tests passed" as done. **Fix:** Every generated worker file now includes a mandatory `#### Completion Protocol` section with the full git delivery steps. The dispatch command Step 4 now explicitly bridges to Step 5. See the Worker Definition Template for the required section.

**⚠️ Shared worktree carries prior worker's branch (v1.25.0 hardening — skills-ux-2026-06-04 BATCH-2-GATE incident):** Under the v1.15.0 shared-worktree topology (default for `--meridian` without `--parallel`), every worker enters the same `<repo-root>/.worktrees/<taskspec-id>` directory in sequence. The previous worker's last act was `push + exit`, leaving the worktree on its own branch. The next worker's emitted dispatch_command must therefore **switch to its own branch idempotently** — handling all three cases: branch doesn't exist (fresh round), branch was pre-created by PRE-FLIGHT, or branch already exists because this is a retry. The previous template emitted only `git checkout -b <branch> origin/<base>`, which fails on existing branch. Strict workers (Codex literally following the spec) emitted `outcome: failed, error: wrong-branch` at the verification step and stalled the round; lenient workers improvised their own checkout and passed — non-deterministic outcome from the same template. **Fix (v1.25.0):** Step 3.5b's branch-creation block is now an `if/else` that checks for the branch ref existing on origin or locally before deciding `checkout` vs `checkout -b`. The Branch Isolation Verification (`git branch --show-current` MUST equal `<taskspec-id>/<WORKER_ID>`) runs AFTER the checkout, so by the time it asserts, the checkout step has already done its job — a failure here means something structurally broken (corrupt worktree, ref collision), not a missed step. See §3.5b for the verbatim emitted block.

**⚠️ "Branch created" ≠ "Branch used" (v1.5.0 hardening — ads-v1 incident):** In the ads-v1 round, 12 workers across 2 repos created `ads-v1/<WORKER_ID>` branches but then wrote all code into the shared working tree without switching to their branch. Result: every branch pointed at the same commit as `main` (empty shells), all changes from N-02 through N-10 were intermingled as uncommitted dirty files, and nothing was pushed to remote. Root cause: Step 3.5b said "create branch" but workers created the branch as a pointer without checking it out, or checked it out then switched away. No verification existed that the worker was actually *on* its branch during execution or that the branch had diverged from base before marking done. **Fixes (v1.5.0):**
1. Step 3.5b now requires a **Branch Isolation Verification** (`git branch --show-current` must equal `<taskspec-id>/<WORKER_ID>`) immediately after checkout
2. Step 4 begins with a **Working Branch Gate** — worker must re-verify it is on its own branch before writing any code
3. Step 5d adds a **Pre-Commit Branch Assertion** — `git branch --show-current` must match, and `git diff --cached --stat` must be non-empty, before the commit command runs
4. Completion Protocol now includes a **Git Delivery Self-Test** block with 4 verification commands the worker must run and whose output must appear in the completion report
5. Multi-repo rounds require the dispatch command to specify which repo each worker targets, and Step 3.5b includes a `cd <repo-root>` before branch creation

**⚠️ "PRD inventory" ≠ "v3 delivery target" (v1.10.0 hardening — clawso-client-v3 incident):** In the clawso-client-v3 round, V-01-A reported PASS across all 60+ workers and 17 PRD §1.4 success criteria — but a post-V-01-A integration unity sweep found two structural gaps: (a) Tauri capability allowlist shipped 33 entries while PRD §A.2 enumerated 87 v1 baseline `#[tauri::command]` entries, with PRD §A.3's mandated `docs/v3/ipc-capability-allowlist.md` table never written; (b) `@clawso/api-contracts` consumed by 15+ BFF route files but ~zero `apps/client/src/` files (producer/consumer schema asymmetry). Workers delivered exactly what their briefs asked. The TaskSpec decomposed by *new feature domain* on the assumption each domain worker would naturally pull in v1 items belonging to its bucket — items v3's architecture obsoleted, renamed, or relocated across a process boundary silently dropped. The audit script masked the gap by printing `(PRD Appendix A target: 87)` informationally while only enforcing source ↔ allowlist self-consistency. One worker brief contained the escape-hatch sentence *"if PRD says 87 and actual count is 80, surface for PM review"* — workers resolved that ambiguity in their own favor and shipped undercounted. **Fixes (v1.10.0):**
1. New **Step 2.4: Spec-Coverage Audit Pattern** — when a PRD enumerates a baseline inventory or numerical target (e.g. v1 baseline counts, "X items at <location>"), the TaskSpec must include a port-classification audit worker BEFORE any implementation worker; that worker classifies every baseline item as `port|ported|obsolete-by-architecture|renamed` with file:line evidence and produces an authoritative spec doc that downstream workers consume.
2. Step 3 verification-theater anti-pattern extended with **Audit Self-Consistency Trap** (audit must enforce spec doc parity, not bidirectional referential integrity alone) and **Escape-Hatch Brief Language** (worker briefs must not contain "if mismatch is significant, surface for PM review" or equivalent — either a hard gate or a §4 PM Playbook question, never a soft narrator).
3. Cross-package contract pairs (Zod schemas, IDL, OpenAPI) entered into the **Cross-Worker Integration Points** table must include an explicit consumer count assertion in the producer worker's acceptance criteria — "schema X is imported by ≥1 client file AND ≥1 server file" — so producer/consumer asymmetry is a generation-time check, not a post-V-01-A discovery.
4. Originating diagnostic playbook: `/Users/yzliu/work/Docs/Projects/clawso/learnings/taskspec-integration-unity-vs-validation-theater.md` (5-min post-V-01-A unity sweep that surfaced these gaps). The decomposition remediation patterns identified by that incident are now codified directly in this skill (Step 2.4 + the verification-theater anti-patterns in Step 3) — they apply to every project, not just clawso, so they live here rather than in a per-project learnings doc.

**⚡ Per-Worker Learnings Curation (v1.11.0 — token & reuse optimization):** Prior rounds had every dispatched worker independently invoke `/reference-learnings` (`ls` + `rg` + `Read` over the project's `/Users/yzliu/work/Docs/Projects/<project>/learnings/` directory) before starting work. With N workers per round, that is N redundant searches over the same directory and N independent judgment calls about which learning matches the worker's scope — wasting tokens and producing inconsistent reuse rates (workers with seemingly generic scope often skipped the search under the "no obvious match" rationalization). **Fix:** the TaskSpec skill now performs the learnings sweep **once at generation time** and writes a *per-worker curated subset* (1–5 file pointers + one-line scope-overlap rationale each) into a mandatory `#### Referenced Learnings` section of every worker file. Workers read only their assigned subset; they do NOT re-grep the directory. The skill — holding the full PRD + decomposition + codebase-pointer context — picks better matches than a worker who has only its own brief. See **Step 2.7: Per-Worker Learnings Curation** and the new Worker Template section.

**📛 Meridian-Roles Plan-Parser Pipe-Escape Trap (v1.14.0 — silent row truncation):** Meridian-roles' dispatch-plan parser (`src/server/role-handlers.ts::parseDispatchPlanRows` and `src/roles/agent-dispatcher/plan-editor.ts::parseTableRow`) splits every table line **naively on `|`** — it does NOT understand markdown pipe-escapes (`\|`), backtick-wrapped cells (`` `A|B` ``), code spans, or any inline syntax. The moment any data row's resulting cell count differs from the header's cell count, the row-enumeration loop `break`s and every row below is silently dropped. The dispatcher then sees only the rows above the bad row, calls `continue-dispatcher`, and reports "plan complete" or "still blocked" once those rows finish — never touching the dropped rows. **Real incident (clawso `in-client-debug-system` round, 2026-05-12):** the generated `dispatch_plan.md` had `Discriminated AdapterError { Transport \| Protocol \| Tool }` in row R-01's Task cell. Naive split turned 11 cells into 13; the parser broke at R-01 and the dispatcher's effective plan was `PRE-FLIGHT + N-01` — the remaining 11 rows (R-01 through V-01-B) were invisible. User noticed only because they expected fanout after N-01 and saw nothing queued. **Fix (v1.14.0):** generator MUST treat *every* literal `|` inside any data cell of the Master Dispatch Table — escaped or not, inside backticks or not — as a generation error. No `\|`, no `` `A|B` ``, no `A | B | C` union syntax in any cell. Acceptable substitutes: ` / ` (slash with spaces), `, ` (comma), ` or `, ` + ` (plus), parenthesized list `(A, B, C)`, or rewrite to avoid the inline union (`AdapterError variants (Transport, Protocol, Tool)`). Validation rule added to post-generation checks (see below). The same rule applies to any other table in `dispatch_plan.md` that meridian-roles consumes (the Master Dispatch Table is the only one parsed, but consistency reduces follow-on bugs). Worker files (`<WORKER_ID>.md`), `index.md`, and `pm_playbook.md` are NOT parsed by meridian-roles and may use `\|` freely, **but** the same hygiene is advised because shared templates get copied between files.

**📛 Meridian-Roles Strict Dispatch-Plan Header Trap (v1.20.1 — empty UI rows / dispatcher restart):** `/taskspec` v1.20.0 emitted a compact Master Dispatch Table header shaped like `Status | Worker ID | Phase | ... | Summary`. Meridian-roles has two independent parsers: the loose `dispatch-status.ts` path can count rows from `Status` / `Batch` / `Worker`, but the strict `role-handlers.ts::parseDispatchPlanRows` + `indexDispatchPlanColumns` path used by `continue-dispatcher` and `/api/role/<id>` also requires canonical column names such as `Task` plus worker/batch aliases it recognizes. `Worker ID` is NOT a strict alias for `Worker`, `Phase` is NOT a strict alias for `Batch`, and `Summary` is NOT a strict alias for `Task`. The result is `dispatch-status` showing workers while the UI renders `dispatch_plan.rows=[]`, `continue-dispatcher` finds no eligible workers, the controller restarts itself as `continued: dispatcher`, and meridian classifies the round as `abnormal_orchestration_state` before pausing through PM resolution. **Fix (v1.20.1):** every `--meridian` dispatch plan MUST emit this exact Master Dispatch Table header order unless a future meridian-roles parser contract explicitly changes it: `Status | Worker | Batch | Tier | Model | Depends On | Branch | Task`. Do NOT emit `Worker ID`, `Phase`, `Function group`, `Headline`, `Action`, or `Summary` as replacements for these columns. If extra metadata is needed, put it in worker files, Batch Execution Details, or Notes outside the strict Master Dispatch Table.

**📛 Meridian-Roles Pending Status Trap (v1.21.1 — TODO rows never launch):** Meridian-roles `continue-dispatcher` treats only `⬜` (and the lifecycle store's pending alias) as launchable pending work. A generated Master Dispatch Table whose Status cells say `TODO` parses in loose status views but yields `pending: 0`, `failed: <row-count>`, and `continue-dispatcher` returns `still_blocked` without launching PRE-FLIGHT. **Fix (v1.21.1):** every generated Meridian dispatch row MUST start with Status `⬜`. Never emit `TODO`, `PENDING`, `[ ]`, blank, or prose in the Status column. Post-generation validation MUST reject any non-terminal fresh row whose Status is not exactly `⬜`.

**🤝 Meridian-Roles Composition (v1.13.0 — `--meridian` flag, contradiction removal):** When a TaskSpec is dispatched through the meridian-roles agent runtime (the dispatcher / lifecycle store / validator / pm-resolver stack at `/Users/yzliu/work/Meridian/Meridian-roles`, optionally wrapped by the `scheduler` role for recurring cycles), the worker prompt is the **concatenation** of meridian-roles' slim launch preamble and the TaskSpec's `dispatch_command.md` + `<WORKER_ID>.md`. Default /taskspec output and meridian-roles' worker preamble disagree on several load-bearing rules — running them together has surfaced real incidents (workers writing `🔄`/`✅` to a plan the lifecycle was already managing, workers self-promoting to completed without the validator role having run, workers emitting free-text `⏸ PAUSE` instead of the required `<<<MERIDIAN-STATUS>>>` block which lifecycle then ignores). **Fix:** the new `--meridian` flag generates a TaskSpec where (1) workers never write to `dispatch_plan.md` (lifecycle owns it; row pre-marked 🔄), (2) every worker file ends with the mandatory MeridianStatusMarker reply-protocol block (`role: worker`, `outcome: complete | failed | blocked | hit_limit | needs_pm`, `report_path` required for `complete`), (3) validation is delegated to meridian's validator role (workers run their own AI Auto-Tests for diligence but do NOT self-promote to ✅), (4) PM resolution is delegated to meridian's pm-resolver role (workers signal `outcome: needs_pm`; they may still consult §1/§2/§3 of `pm_playbook.md` but do NOT append §4 rows themselves), (5) reports append a dated `## Attempt N` section when the file already exists (worker / validator / pm history must survive across retries), and (6) the Anti-Collision claim-first protocol is replaced by meridian-roles' lifecycle thread-id reservation. See **Parameters → `--meridian`** below for the full override list and the meridian-roles invariants the flag honors. The flag composes with `--append` and `--assign-codex`.

**💾 Per-TaskSpec Worktree Granularity (v1.15.0 — disk + parallelism re-architecture; partially superseded by v1.21.0, see below):** The v1.14 scheme created one git worktree per **worker** (`<repo-root>/.worktrees/<WORKER_ID>`) whenever a row was marked parallel-dispatchable. With N workers per round, that scattered N partial checkouts on disk — full source tree per worker, plus a `node_modules` symlink farm — and the parallelism the scheme protected was rarely actually exercised. The intended usage was the inverse: **multiple dispatchers running different TaskSpecs in parallel**, each TaskSpec internally serial. **Fix (v1.15.0):** the worktree is now keyed by `<taskspec-id>`, not `<WORKER_ID>`. One TaskSpec ⇒ one worktree at `<repo-root>/.worktrees/<taskspec-id>` (one per target repo for multi-repo TaskSpecs). PRE-FLIGHT.W creates it once and sets up the `node_modules` symlinks; every implementation worker `cd`s into it, runs `git status --short` to assert the prior worker left a clean tree, and then does its `checkout -b` inside. POST-FLIGHT (the mandatory final row) audits final integration state and removes the worktree after merge work has already completed. The WIP-loss bug that motivated per-worker isolation (parallel agents stepping on each other via `git switch` on a shared tree) is now blocked by **two layers**: the Anti-Collision claim-stamp (§3.5a) keeps at most one row `🔄` inside a TaskSpec, and the §3.5c clean-tree assertion surfaces any leftover WIP loudly before the next worker writes. Multi-dispatcher parallelism remains safe because each TaskSpec owns a distinct worktree path. Under `--meridian` this scheme is a drop-in: meridian-roles is already serial-per-tick (`resolveFirstEligibleContinueWorker` returns `eligibleWorkers[0]`, `continue-worker.ts:114` short-circuits already-`running` workers, the worker prompt-builder mandates serial execution) and the only generator-time change is that each worker file's `**Repo**:` field points at `<repo-root>/.worktrees/<taskspec-id>` (POST-FLIGHT excepted — it points at the primary checkout). Existing in-flight TaskSpecs that already use the per-worker path may finish under the v1.14 rule; v1.15.0 applies to TaskSpecs generated after this version bump. See §3.5c, the INTEGRATE Worker Template, the POST-FLIGHT Worker Template, and the cited learning doc's 2026-05-13 addendum.

> **⚠️ v1.21.0 correction:** the phrase "meridian-roles is already serial-per-tick" above is only true under **serial dispatch** (`parallel_dispatch.enabled=false` or `max_concurrency=1`). Under parallel dispatch (any `--codex-para` invocation or explicit `max_concurrency>1`), `role-handlers.ts:970-1059` launches multiple dependency-eligible workers concurrently in the same TaskSpec. The shared-worktree scheme described here is **unsafe** in that case — generate the TaskSpec with `--parallel` to emit per-worker worktrees instead. See the v1.21.0 callout above and the `--parallel` parameter section for the per-worker variant.

**⚖️ Per-Worker Laws Curation (v1.16.0 — rule-source split between laws and learnings):** Until v1.15.0 the only repo-canon source workers consulted was `learnings/` — concrete incident records captured by `/ship-changes`. The `/write-laws` skill since then distils those learnings into a **separate, binding** `laws/` directory: short, abstract principles indexed by aspect (`layering`, `contracts`, `verification`, `state`, `lifecycle`, `safety`, `process`). Laws are the single source of truth for "what must I do"; learnings remain the evidence base for "how did we previously fix X". **Fix:** the TaskSpec skill now performs **two** sweeps at generation time — Step 2.7 (Learnings, existing) and **Step 2.8 (Laws, new)** — and emits a per-worker curated set of laws (1–N matched law slugs + the binding rule + scope-overlap rationale). **Placement superseded by v1.31.1:** the curated law set now lives in the worker's Context Capsule (`context/<WORKER_ID>-context.md` § Applicable Laws), not on the worker card — the card carries a one-line pointer. See Step 2.8.5. Workers read the curated subsets directly via the `/read-laws` and `/reference-learnings` contracts; they do NOT re-grep either directory. For rule-following workers (applying an existing pattern, contract-conforming additions, code-cleanup against a known rule), laws are typically the primary constraint surface and the learnings section frequently emits `N/A — no relevant prior learnings.`; for debugging-heavy workers both populate. The Completion Protocol report contract is extended with a mandatory `## Applied Laws` section parallel to `## Referenced Learnings Applied`. Laws bind. Learnings inform.

**🔁 Final Integration Gate (v1.17.0 — prevents POST-FLIGHT merge blockers):** Bug-fix round `bug-fix-2026-05-r2` reached POST-FLIGHT while the rollup PR was still open, base had drifted, CI had to re-run, and cleanup was unsafe. POST-FLIGHT correctly blocked, but it was doing release-engineering work that should have been an explicit row. **Fix:** every GIT-mode TaskSpec now emits a final `INTEGRATE` worker immediately before `POST-FLIGHT` whenever the round has code PRs, validation PRs, rollup/stack PRs, or 2+ non-teardown rows. `INTEGRATE` owns final base refresh, PR/check reconciliation, merge, superseded-PR closure, branch cleanup, and merge-sha recording. `POST-FLIGHT` becomes a pure audit/teardown row: it may verify merge state and remove worktrees, but it must not perform first-time PR merges or CI waiting. Single-row doc-only/no-code GIT TaskSpecs may omit `INTEGRATE` only when the generator writes a justification in `index.md` and `dispatch_plan.md` Notes.

**🗂️ Four-Folder Round Layout + Mandatory Chinese Test Guide (v1.19.0 — pipeline canonicalization):** Previously, every artifact owned by `/brainstorming`, `/investigate`, `/taskspec`, and the human test pass lived flat at `branch/<taskspec-id>/`, leading to mixed-ownership clutter and no first-class location for the human deploy-test guide that PM hands to test users at the end of every round. **Fix:** the round directory `branch/<taskspec-id>/` is now a **shared root** with four canonical sub-folders, one per pipeline stage:

```
<Docs root>/branch/<taskspec-id>/
├── prd/          # /brainstorming output (PRD / design doc). Hand-written PRDs may also live here.
├── investigate/  # /investigate output (investigation_report.md, optional discriminator suffix)
├── taskspec/     # /taskspec output — ALL dispatch artifacts live here, NOT at the round root
│   ├── index.md
│   ├── dispatch_plan.md
│   ├── dispatch_command.md  (or agent_dispatch_command.md)
│   ├── pm_playbook.md
│   ├── PRE-FLIGHT.md, INTEGRATE.md, POST-FLIGHT.md, <WORKER_ID>.md ...
│   └── reports/<WORKER_ID>.md
└── test/         # HUMAN-check territory: PM-written test guide + post-test report(s)
    └── <date>-<project>-<branch-feature>-test-guide.md   (Chinese by default; mandatory)
```

The reference example is `/Users/yzliu/work/Docs/Projects/mumu/branch/category-workbench-2026-05-26/`. The `/taskspec` skill MUST:

1. Emit every TaskSpec artifact under `branch/<taskspec-id>/taskspec/` — never at `branch/<taskspec-id>/` directly. The new derived-paths table (Path Validation Gate) reflects this.
2. Always materialize the `test/` sub-folder and write a mandatory Chinese **test guide doc** at `branch/<taskspec-id>/test/<date>-<project>-<branch-feature>-test-guide.md` even for doc-only or NO-GIT rounds (the guide may say "本轮无需 UI 测试" for those, but the folder + file MUST exist for layout consistency). Filename pattern: `<YYYY-MM-DD>-<project>-<branch-feature>-test-guide.md`. Default language: Chinese (中文); switch only on explicit user request. See **Step 6.5: Test Guide Generation** and the **Test Guide Template** below.
3. Co-exist gracefully with sibling sub-folders: never delete, rename, or write into `prd/` (owned by `/brainstorming` and humans) or `investigate/` (owned by `/investigate`). The `test/` folder is jointly written by `/taskspec` (initial guide) and humans (post-test reports + edits).
4. When `--append` is used and the existing TaskSpec still has the old flat layout (`branch/<id>/dispatch_plan.md` at the round root), do NOT silently migrate — the existing layout wins. Append into whichever layout the existing TaskSpec uses; only fresh generation uses the new layout. Document the legacy layout in the appended TaskSpec's index.md if needed.

Dispatcher and worker prompts under v1.19.0 reference `<taskspec-id>/taskspec/...` paths throughout. The `<taskspec-id>` branch-prefix for git branches (`<taskspec-id>/<WORKER_ID>`) is unchanged — only the on-disk artifact paths moved one level deeper. The dispatch runner (`scripts/dispatch.py`) and Meridian-roles dispatcher accept either a TaskSpec directory or a `dispatch_plan.md` path; both forms continue to work because they resolve siblings relative to the plan file's actual parent directory.

**🎨 Frontend Visual Canon Gate (v1.20.0 — prevents UI intent drift):** Frontend rounds must not be decomposed from vibes such as "clean", "simplify", "like ChatGPT", or "make it beautiful" alone. The `writer-workstation-remediation-2026-05-26` round showed how TaskSpec decomposition can preserve layout mechanics while losing the binding visual intent: worker briefs carried panels, move/resize controls, and E2E checks, but not the original visual reference / sample-page constraints strongly enough to prevent oversized text, weak hierarchy, awkward spacing, and composition drift. **Fix:** before any frontend / UI / UX / page / component / dashboard / editor / workstation / layout / visual-design TaskSpec is generated, the skill MUST establish a **Visual Canon** from one or more PRD-provided references: screenshot/mockup/image path, sample HTML/CSS page, design-system example, Figma/exported design artifact, or a precise written visual spec with density, typography, spacing, layout, color, interaction, and negative rules. If the PRD does not provide this canon, stop and ask the PRD owner to provide it or amend the PRD before TaskSpec generation. Do not infer a visual canon from generic adjectives, and do not silently turn visual intent into structural worker tasks.

**🎚️ Effort must be forwardable, not merely valid (v1.34.0 — same round, found by `/dispatch` preflight):** The model catalog advertises `max` and `ultra`; the orchestrator does not forward them. `Meridian-roles/src/roles/agent-dispatcher/model-routing.ts:18` defines `KNOWN_REASONING_EFFORTS = new Set(["low","medium","high","xhigh"])`, and `normalizeReasoningEffort` returns `undefined` for anything outside it. That `undefined` flows to `worker-launcher.ts:124`, which only sets `params.applied_reasoning_effort` when the value is truthy — so the parameter is **omitted from the spawn request entirely** and the CLI applies its own default. For `gpt-5.6-sol` that default is `low` (`~/.codex/models_cache.json → default_reasoning_level`).

**Writing `::max` therefore lowers the row to `low` instead of raising it, silently, with no error at any layer.** It is strictly worse than writing nothing. The rows most likely to be assigned `max` — irreversible migrations, one-way gates, sole merge authority — are exactly the rows least able to absorb a silent downgrade to the cheapest tier.

**Rule:** before assigning any effort, check it against the *runtime's* forwardable set, not the *catalog's* advertised set. ⛔ Do not hardcode that set here — it is a property of the orchestrator you are dispatching through, and it changes. Read it from the compiled artifact the service actually loads:

```bash
grep -o 'KNOWN_REASONING_EFFORTS = new Set(\[[^]]*\])' \
  /Users/yzliu/work/Meridian/Meridian-roles/dist/roles/agent-dispatcher/model-routing.js
```

**Status as of 2026-08-08:** the set was widened to `low | medium | high | xhigh | max | ultra` (with unit tests), and `gpt-5.6-sol` gained a per-model default effort of `medium` for rows that omit `::effort`. So `max` is assignable again under the §5.2 gate; `ultra` remains gated on the delegation opt-in for its own reasons, not on forwardability.

**When an effort is NOT in the runtime's set**, emit the highest tier that is, and record both the intended level and the external ceiling in the row's `**Model Routing Rationale**`. Do not silently present the fallback as the analysis result — a future reader must be able to tell the ceiling was imposed, not chosen.

⚠️ **Building the orchestrator is not the same as loading it.** Node caches modules at require time, so a rebuilt `dist` is inert until the service restarts. A TaskSpec written against a widened set, dispatched through a service still running the old build, hits the exact silent-downgrade this section exists to prevent. `/dispatch`'s preflight `C7` reads the set from `dist` **and** compares the build time against the running service's start time, blocking when the patch is on disk but not loaded.

**Validation:** every `::<effort>` in the Master Dispatch Table's Model column must be in the forwardable set. `/dispatch`'s preflight enforces this as check `C7` at launch time, but a TaskSpec that reaches dispatch with `::max` has already failed generation-time validation.

**The general shape:** an effort tier the *provider* supports is not automatically a tier the *orchestrator between you and the provider* transmits. Same class as the wire-format bug below — the skill specified meaning (`max` = deepest reasoning) where the pipeline demanded a value from a fixed enum, and the pipeline's failure mode on an unknown value was to drop it rather than reject it. When a downstream component's handling of an out-of-range value is "omit silently", every out-of-range value the generator can emit becomes a silent downgrade.

**🔌 Header-Field Wire Format — `Repo:` must own its line (v1.34.0 — clawso `unification-layer-decoupling-2026-08-06`, 2026-08-08):** Every rule in this skill about `**Repo**:` specifies the *value* (`<repo-root>/.worktrees/<taskspec-id>-<WORKER_ID>`, etc.) and none of them specified the *line position*. The canonical Worker Definition Template did not carry a `**Repo**:` bullet at all — the field appeared only in the multi-repo prose at Step "Multi-Repo Round Context" and in the `--parallel` validation list. A generator following the template literally emits cards with **no** `Repo` field; a generator that improvises one commonly packs it onto the Branch bullet for compactness:

```markdown
- **Branch**: `uld-mvp-2026-08-06/W0-02` · **Repo**: `/abs/.worktrees/uld-mvp-2026-08-06-W0-02`
```

That form is **invisible to the orchestrator**. Meridian's parser is line-anchored:

```
roles/agent-dispatcher/continue-worker.ts:391
  const REPO_FIELD_PATTERN = /^[-*]\s*\*{0,2}Repo\*{0,2}\s*:\s*(.+?)\s*$/m;
```

`^` + `[-*]` requires `Repo` to follow the bullet marker directly. On the merged line the bullet is followed by `Branch`, so `extractRepoFieldFromWorkerFile` returns `null`, `resolveWorkerSpawnDir` (`continue-worker.ts:365`) falls through to `resolveConfiguredDispatchRepoRoot(config)`, and **every** worker spawns in the primary checkout. Under serial dispatch that silently defeats the worktree topology; under `--parallel` with `max_concurrency=N` it puts N concurrent agents into the same tree running `git checkout` — precisely the `index.lock` / `node_modules` / `target/` race the per-worker topology exists to prevent. Nothing fails loudly: spawn succeeds, the worker finds a valid git repo, and the damage only shows up as cross-worker contamination. Measured instance: all 74 cards of a `--parallel --meridian` round parsed to `null`; the round would have run six Codex agents in one checkout.

**Wire-format rules (all mandatory, all HARD generation errors):**

1. **`**Repo**:` occupies its own bullet**, starting at column 0 as `- **Repo**: …`. Never merged onto `**Branch**`, `**Phase**`, or any other field's line. The same applies to `**Depends on**:` (`consistency-gate` and Meridian both regex it per-line) and `**Expected Outputs**:`.
2. **The value carries the absolute path inside backticks.** `extractRepoFieldFromWorkerFile` prefers `` `…` ``-wrapped values matching `isAbsoluteOrHomePath` and only then falls back to `ABSOLUTE_PATH_PATTERN`. Backticks are the reliable form; a bare or parenthesized path is a fallback you should not rely on. Multi-repo rows write `` - **Repo**: `<abs path>` (<repo-name>) `` — path first, in backticks, label after.
3. **Trailing annotations are allowed after the backticked path** (`（主 checkout）`, `(integration worktree)`) because the pattern captures to end-of-line and the backtick scan picks the path out. Do not put the annotation *before* the path.
4. **Every non-HUMAN row needs the field.** HUMAN rows never spawn, so they may omit it. `PRE-FLIGHT` and `POST-FLIGHT` point at `<repo-root>` (primary checkout); everything else follows the round's worktree topology.

**Validation (post-generation, run against the emitted files — not against the intent):** parse every card with meridian's exact regex, not with a lenient reimplementation. A check that greps for the substring `Repo` passes the broken form and is worse than no check:

```bash
node -e '
const fs=require("fs"), RE=/^[-*]\s*\*{0,2}Repo\*{0,2}\s*:\s*(.+?)\s*$/m;
const plan=JSON.parse(fs.readFileSync(process.argv[1]+"/plan.json","utf8"));
let bad=[], dirs={};
for (const t of plan.tasks) {
  if (t.role==="human") continue;
  const m=fs.readFileSync(process.argv[1]+"/"+t.card,"utf8").match(RE);
  if(!m){ bad.push(t.task_id+": Repo 不在行首（多半与 Branch 并排）"); continue; }
  const abs=[...m[1].matchAll(/`([^`]+)`/g)].map(x=>x[1].trim())
              .find(x=>x.startsWith("/")||x.startsWith("~"));
  if(!abs){ bad.push(t.task_id+": Repo 值里没有反引号包裹的绝对路径"); continue; }
  (dirs[abs] ||= []).push(t.task_id);
}
for (const [d,ws] of Object.entries(dirs))
  if (ws.length>1 && !d.endsWith("-integration")) bad.push(`共用 spawn 目录 ${d}: ${ws}`);
console.log(bad.length?bad.join("\n"):"OK: spawn dirs resolvable");
process.exit(bad.length?1:0)' "$TASKSPEC_DIR"
```

Two rows may share a spawn dir only when they can never be concurrently eligible — the integration worktree (waves are serialized by their gates) and the primary checkout (`PRE-FLIGHT` / `POST-FLIGHT`). Any other sharing is a race under `--parallel`.

**General principle this instance belongs to:** whenever the skill emits a field that an *external parser* consumes, the skill must state the parser's wire format and validate against **that parser's own expression**, not against the field's meaning. Value-level rules ("point it at the per-worker worktree") do not survive a formatting choice the author considers cosmetic. The same exposure exists for the Master Dispatch Table header (already covered by v1.20.1), the `Depends On` sentinel (v1.18.0), and the `Write report to:` declaration (v1.32.0) — `Repo:` was the one field left specified by meaning only.

**⚙️ Parallel-Aware Worktree Granularity (v1.21.0 — corrects v1.15.0's "lifecycle serializes" claim):** v1.15.0 retired per-worker worktrees on the rationale that "meridian-roles is already serial-per-tick" and the shared TaskSpec worktree was therefore safe. **That rationale is only correct under `parallel_dispatch.enabled=false` (`max_concurrency=1`).** Reading meridian-roles source for v1.21.0:

- `server/role-handlers.ts:970-1059` (the `continue-dispatcher` handler) computes `availableSlots = max_concurrency - activeWorkers.length` and then `for (const workerId of candidates)` **concurrently launches multiple dependency-eligible workers in the same TaskSpec**.
- `roles/agent-dispatcher/service-continuation.ts:40-80` — `resolveEligibleServiceContinueWorkers({ limit })` is called with `limit=availableSlots` in parallel mode. The serial wrapper at line 37 (`resolveFirstEligibleContinueWorker`) is just `{ limit: 1 }`; v1.15.0's note cited only that wrapper, not the parallel handler.
- `roles/agent-dispatcher/thread-id-reservation.ts:17-22` — `ACTIVE_THREAD_RESERVATION_STATUSES` is **per-worker**, not per-TaskSpec. Different workers reserve different thread-ids and coexist as `running` simultaneously. The "single-active-worker-per-TaskSpec invariant" repeated in v1.15.0 rules 10a and §3.5c does NOT exist in code.
- `roles/agent-dispatcher/continue-worker.ts:262-269` — `resolveLaunchSpawnDir` reads each worker's `**Repo**:` field independently and uses it as that worker process's `cwd`. With shared worktree, N concurrent worker subprocesses race on `git checkout`, `.git/index.lock`, `node_modules`, `target/`, TypeScript `tsbuildinfo`, etc.
- `roles/agent-dispatcher/prompt-builder.ts:121` — the worker prompt itself states: "When `parallel_dispatch_config_json.enabled` is true, the service may start multiple dependency-eligible workers in one continue tick."

**Fix (v1.21.0):** The generator now treats the worktree topology decision as an explicit input to `/taskspec`, not a default.

- **Default (no `--parallel`):** v1.15.0 shared-worktree topology — one `<repo-root>/.worktrees/<taskspec-id>` per TaskSpec, every worker's `**Repo**:` points there. Safe only when the downstream dispatch runs serial (`parallel_dispatch.enabled=false`). This is correct for the vast majority of `--meridian` dispatches that DON'T use the `codex-para` template or its equivalents.
- **`--parallel` flag (new):** per-worker worktree topology — PRE-FLIGHT.W creates `<repo-root>/.worktrees/<taskspec-id>-<WORKER_ID>` for every implementation worker (R-*, N-*, D-*) plus a shared `<taskspec-id>-integration` worktree for BATCH-N-GATE / INTEGRATE / V-* rows that need to see the merged tree. Each worker file's `**Repo**:` points at its own per-worker path. Required when downstream dispatch uses `parallel_dispatch.enabled=true` with `max_concurrency > 1` (any `--codex-para` invocation, or explicit `--parallel-dispatch-enabled --parallel-dispatch-max-concurrency N` on the dispatch runner).

The `/dispatch` skill is the **enforcement** point: it parses every worker's `**Repo**:` field before launch, compares against the configured `parallel_dispatch.max_concurrency`, and **refuses to launch** if a parallel dispatcher is paired with a shared-worktree TaskSpec (or vice versa where the user clearly didn't intend per-worker disk cost). The two skills compose: `/taskspec` produces the topology; `/dispatch` validates it.

**Errata for v1.15.0's text:** wherever this document says "meridian-roles is already serial-per-tick", "lifecycle thread-id reservation enforces single-active-worker-per-TaskSpec invariant", or "the §3.5c clean-tree assertion guarantees single-active-worker", read those as **conditional on serial dispatch only**. They are not properties of meridian-roles; they are properties of the operator launching the dispatcher with `max_concurrency=1`. See §3.5c, the `--parallel` parameter section, the PRE-FLIGHT Worker Template, the INTEGRATE Worker Template, and the POST-FLIGHT Worker Template — each has been amended with a `--parallel` mode variant.

**🪤 Embodied-Acceptance Trap (v1.23.0 — `agent-dispatcher-f0953280` R-04 dead-lock):** In the `skills-ux-h1` round, R-04 (F-01 attach probe + parallelization + progress UI) was decomposed as a code-class worker but its `Sub-tasks` and `Acceptance Criteria` smuggled in a *real foreground 12-file × 2-agent attach measurement against a running `npm run tauri:dev` desktop*. Its own `#### Applicable Laws` section simultaneously cited `verification/test-green-is-necessary-not-sufficient.md` with the binding sentence "acceptance is the V-01 desktop run with measured latency < 1500ms" — and V-01's `Sub-task 7` already owned the same fixture / same `<1500ms` budget / same screenshots. The worker file was internally contradictory: code-class worker carrying a physical-action acceptance that the spec itself reassigned to V-01. Validator cycle 1 correctly rejected (`fix_requested 0.5`); the watchdog escalated; the PM-resolver agent tried to drive the foreground UI itself, hit a macOS lock screen, left an uncommitted `local_skills.rs` change, and escalated to a human. R-04 sat blocked for hours until a human appended a PM Clarification delegating the measurement to V-01 and force-completed. **Root cause:** the TaskSpec generator emitted a worker whose acceptance criteria required capabilities the worker class lacks (attended UI), with no generation-time lint catching the mismatch and no Applied-Laws ↔ Acceptance consistency check catching the spec's own self-contradiction. **Fixes (v1.23.0):**
1. **Worker-Class & Attended-UI Frontmatter (mandatory)** — every emitted worker file declares two new header fields: `**Worker Class**: [code | e2e-desktop | data | review | integration | preflight | postflight]` and `**Requires Attended UI**: [true | false]`. Default for R-* / N-* / D-* is `code` + `false`; for V-* with a real-binary acceptance, `e2e-desktop` + `true`. See **Step 5.5 Worker-Class & Attended-UI Validation** and the updated **Worker Definition Template**.
2. **Embodied-Action Keyword Lint (new Step 5.5.a)** — generator scans every worker's `#### Sub-tasks` and `#### Acceptance Criteria` for the keyword set `foreground / screenshot / stopwatch / tauri:dev / npm run client:dev / "real desktop" / "manual measurement" / "press confirm" / "wall-clock" / cliclick / osascript / screencapture`. Any hit on a `code` / `data` / `integration` / `preflight` / `postflight` / `review` class worker is a HARD generation error — the criterion must be moved to an `e2e-desktop` worker (typically V-*), and the source worker references it as `delegated to <V-XX> per <law-or-PRD-ref>`.
3. **Duplicate-Measurement Triple Detector (new Step 5.5.b)** — generator extracts `(fixture, threshold, action)` triples from each worker's Sub-tasks / Acceptance (e.g. `(12-file × 2-agent attach, <1500ms, foreground stopwatch)`). Cross-compares all workers; the same triple may appear in **at most one** worker as a mutable acceptance. Every other reference must be `delegated_to: <owner-worker-id>` style. Duplicate without a delegate marker is a HARD generation error.
4. **Applied-Laws ↔ Acceptance Consistency Lint (new Step 5.5.c)** — generator parses each worker's curated law Statements (on the capsule as of v1.31.1) / "Why it binds" lines for the phrases `acceptance is the <other-worker> ...`, `<other-worker> owns the acceptance`, `delegated to <other-worker>`, `acceptance contract is <other-worker>`. When matched, that worker's own Sub-tasks / Acceptance Criteria MUST NOT also restate that acceptance verbatim. Violation is a HARD generation error.
5. **PRE-FLIGHT.UI Foreground Availability Probe (mandatory when any worker is `requires_attended_ui: true`)** — PRE-FLIGHT gains a new sub-task `PRE-FLIGHT.UI` that runs `screencapture -xo` and `osascript ... frontmost` to confirm the controlling console is attended (not locked / not headless). On failure with any `requires_attended_ui: true` worker in the plan, PRE-FLIGHT exits `⛔ BLOCKED` with a clear "no attended UI available — unlock console before dispatching V-* workers" message; meridian-roles' lifecycle then pauses without spawning any downstream worker. See the updated **PRE-FLIGHT Worker Template**.
6. **Companion server-side gates (out of /taskspec scope, tracked in Meridian-roles)** — the dispatcher's validator-orchestrator should emit structured `delegatable[]` items so `fix_requested` referencing another worker can route as a 1-click PM-confirm instead of human escalation; the dispatcher's PM-resolver should be authorized to auto-append a PM-approved clarification + force-complete when the worker file's Applied Laws explicitly name the delegate target. These belong in `/Users/yzliu/work/Meridian/Meridian-roles/src/roles/agent-dispatcher/{validator-orchestrator.ts,pm-resolver.ts}`, not here, but `/taskspec` v1.23.0 emits enough structural signal (frontmatter + delegation markers) for those gates to consume.

**🚦 Test-Gate Command-Shape Lint (v1.26.0 — `agent-dispatcher-4db3d871` r10 PRE-FLIGHT wedge, 2026-06-05):** In the 2026-06-05 bug-fix r10, PRE-FLIGHT routed to PM specifically because the TaskSpec emitted a combined `cargo test <filter1> <filter2>` command — invalid: `cargo test` accepts at most ONE positional filter before `--`; subsequent positionals are silently treated as additional crate selectors and either fail or run the wrong target set. The worker's strict literal execution then exited with a parser-shaped error, the watchdog escalated, and a PM resolver burned a full agent slot reformulating the command into the correct form. This is a TaskSpec authoring bug at skill level — workers are doing what their brief says — and the same trap appears for npm/pnpm `test`/`run` invocations that concatenate filters where the runner needs `--`. **Fixes (v1.26.0):**
1. **Cargo gate lint (Step 5.5.e, mandatory)** — for every `#### AI Auto-Tests` / `#### Behavioral Assertions` / PRE-FLIGHT / V-* / batch-gate command that begins with `cargo test`, `cargo nextest run`, or `cargo bench`, the generator MUST emit AT MOST one positional filter before `--`. If more than one is required, the command MUST be rewritten as `cargo test -- <filter1> <filter2> [...]` (one positional before `--`, additional filters AFTER `--`). Two or more positional tokens before `--` is a HARD generation error. Hyphenated test names that already use `cargo test --test <name>` are exempt (`--test` is a flag, not a positional). The same rule applies to `cargo test -p <crate>` — `-p` consumes its argument, so only one *additional* positional filter is permitted before `--`.
2. **NPM / PNPM gate lint (Step 5.5.e)** — `npm test <a> <b>`, `pnpm test <a> <b>`, `npm run test <a> <b>`, `pnpm run test <a> <b>` MUST be rewritten as `<runner> test -- <a> <b>` (the `--` is required so the args reach the test runner, not the package script). Same for `npm exec` / `pnpm exec` test invocations. Two or more bare positional tokens after `test` without an intervening `--` is a HARD generation error.
3. **Generated check on emit, not just at design time** — the lint runs against the actual command strings written into worker files, dispatch_command.md, and any PRE-FLIGHT gate, AFTER any per-worker substitutions. Substring-matching the rewrite is intentional so a worker template that interpolates filter names from PRD metadata is checked end-to-end. Surface offending file + line + command in the generation error so the operator can decide whether to relax the lint (e.g. by switching to `cargo nextest run --partition`) or accept the auto-rewrite.
4. **Acceptable rewrites the generator may apply silently** — single-positional + post-`--` form is the canonical shape; either move all but the first filter behind `--`, or replace with `cargo test -- <regex-union>` when the filters are naming individual tests in one crate. When ambiguity exists (workspace selectors vs test-name filters), the generator MUST stop with a structured error rather than guess.
5. **Why it lives here, not in meridian-roles** — the wedge cost was a PM-resolver agent and an entire round-watcher tick. The cheapest fix is at TaskSpec emit time, before any worker is ever spawned. Meridian-roles can also defensively reject malformed Cargo invocations from `meridian-tool run` (tracked separately under P-1/P-2 watchdog reaper work), but the canonical author surface is the skill, and the skill is what writes those command strings in the first place.

**🛡️ Strict BATCH-N-GATE + Merge Mode default (v1.27.0 — `agent-dispatcher-666ecd32` BATCH-2-GATE verification theater + base-branch poisoning, 2026-06-07):** In the 2026-06-05 `provider-binding-multi-cap-2026-06-05` round (`agent-dispatcher-666ecd32`), BATCH-2-GATE was marked `✅` while merging two commits that broke shipped clients: `5f2c8a85 chore(dispatch): migrate shipping provider bindings` (the manifest schema cutover that left `feat/client-rebuild--v3` broken for ~30 hours between N-02's Rust contract rename and BATCH-2's manifest migration — admission panic on every dev build during that window) and `f12e2772 chore(dispatch): preserve BATCH-2 resolver WIP` (whose own commit message admits dirty-worktree residue). Downstream casualty: openclaw lost chat panel + install/uninstall in v3.0.34. Two structural bugs in `/taskspec`:

**Bug 1 — BATCH-N-GATE template is verification theater.** Step 4.5's template emits a gate worker that runs `cargo check` + a grep-based "wiring verification" and nothing else. It cannot catch (a) commits whose own message announces "preserve WIP / residue / drift", (b) silent failure channels (e.g. `lib.rs::run()` never initializes `tracing_subscriber`, so every `tracing::error!` is dropped), (c) regressions in real-binary install / admission / uninstall behavior. The gate's name says "Runtime integration verification" but the template never runs the runtime. **Fix (v1.27.0):** Step 4.5's template gains three mandatory sub-tasks BEFORE the Report row — **Dirty-commit refusal** (grep `git log --format=%B origin/<base>..HEAD` for `preserve WIP|residue|drift|^wip|^fixup|^stabilize|dirty worktree`; ANY match is HARD-FAIL unless carved out by a dated `pm_playbook.md` §1 entry naming the commit SHA), **Real-binary integration probe** (when batch touches admission / IPC / contract loading / installer / lifecycle, the gate MUST launch the binary and probe the user-visible side effect — e.g. `invoke('tool_contract_load', {toolId})` for EVERY shipping tool, OR real install + uninstall round-trip with receipt status assertion — captured verbatim in `reports/BATCH-N-GATE.md` `## §4 Real-Binary Evidence`), **Observability gate** (every `tracing::error!` / `console.error` / `debugRecorder.error` site introduced or moved by the batch MUST have a verified delivery path; a swallowed channel is HARD-FAIL). The previous 2-step compile+grep gate becomes the floor, not the ceiling.

**Bug 2 — Per-worker-merge is the silent default for contract-bump rounds.** The skill describes two merge modes — per-worker-merge vs rollup/stack — at line 17 + Step 4.6's "Rollup/stack mode rule," but provides NO decision rule. The Worker Template's Completion Protocol §3 unconditionally emits `gh pr create --base <PR-base-branch>` and §4 emits `gh pr merge` — every worker merges to base by default, regardless of whether the round's contract changes can survive a half-merged base. When two or more workers split a single semantic contract rename (Rust struct rename in N-02 + manifest migration in 5f2c8a85), per-worker-merge guarantees base is broken between those merges. **Fix (v1.27.0):** new Step 4.6.5 (Merge Mode Selection) — the generator MUST evaluate rollup triggers and emit `Merge Mode: rollup | per-worker-merge` into `index.md` AND `dispatch_plan.md` headers BEFORE any worker file is generated. Triggers that force rollup: (a) cross-worker semantic rename across (Rust type / TS type / JSON manifest / contract package); (b) schema bump consumed by 2+ runtimes; (c) multi-row migration with invalid intermediate state; (d) PRD §P process fix mandates integration branch; (e) ≥5 implementation workers with no per-worker shippable unit. Worker Completion Protocol becomes Mode-aware: under rollup, the worker's PR base is `<taskspec-id>/integration` and the worker does NOT run `gh pr merge` — only INTEGRATE merges integration → base. **Default when uncertain: rollup.** Per-worker-merge is the special case (small, decoupled, naturally-shippable rounds), not the default. See Step 4.6.5 for the decision matrix, the per-mode Completion Protocol variants, and the post-generation validation rules.

**📐 Gate Law Inheritance + Universal Codegen Output Guard (v1.28.0 — `agent-dispatcher-666ecd32` BATCH-2-GATE missed `shipped-tool-resources-are-external-artifacts`, 2026-06-07):** Same incident as v1.27.0, distinct root cause. After v1.27.0 hardened the BATCH-N-GATE template's compile-only contract with dirty-commit / real-binary / observability sub-gates, a closer audit asked: even if 5f2c8a85's commit message *had* tripped the dirty-commit grep, why did the gate worker have no law in its `#### Applicable Laws` block telling it that directly editing `resources/tools/openclaw/{tool,ui}.json` is forbidden? Answer: the curated `#### Applicable Laws` block on `BATCH-2-GATE.md` contained ONE law (`process/no-silent-bypass-of-validation-gates`). The decisive `layering/shipped-tool-resources-are-external-artifacts` was curated for R-20, R-21, R-22, N-03, N-14, N-17, BATCH-5-GATE, POST-FLIGHT — every worker whose declared scope mentioned `resources/tools/*` or `tool-importer/` — but NOT for BATCH-2-GATE, whose declared scope is "audit framework-runtime commits." The per-scope curation algorithm at Step 2.8.4 is correct for the WORKER'S OWN work, but a gate's work is to **audit upstream workers' obedience to THEIR laws**; the gate needs the UNION of every gated worker's curated laws, not a fresh per-scope match.

Two structural patches:

**Patch 1 — Step 2.8.10 Gate Worker Law Inheritance (mandatory).** `BATCH-N-GATE` workers inherit the UNION of laws curated for every worker in batch N; `INTEGRATE` inherits from every implementation worker plus every BATCH-N-GATE; `POST-FLIGHT` inherits from `INTEGRATE`. Plus artifact-path inheritance: if any gated worker touches `resources/tools/` / `tool-importer/` / `packages/api-contracts/` / `supabase/migrations/` / any codegen-output path, the gate inherits every law applying to that path even when the gate's own plan doesn't enumerate the touch. Each inherited law's "Why it binds this worker" rewrites to explicit audit framing: `Why it binds this gate: <upstream> was required to obey; this gate refuses the batch if any commit violates`. Validation: a gate worker's curated law count MUST be ≥ the max count across the workers it gates — fewer is a HARD generation error. (Placement is the gate's capsule as of v1.31.1.)

**Patch 2 — Step 2.8.11 Universal Codegen Output Guard (mandatory, project-agnostic).** The clawso-specific `shipped-tool-resources-are-external-artifacts` is one instance of a universal class: every codegen relationship (`tool-importer/` → `resources/tools/`, `.json schemas` → `.ts` types, IDL → bindings, source → built worker bundle) has a source-of-truth + emitted output, and fixes route through the source + regenerate, never through hand-edit to the output. The generator scans the project's laws directory for laws with frontmatter `codegen-pair:` (defined by `/write-laws` v1.x), extracts `source-path` / `output-path` / `regenerate-command` / `carve-out-conditions`, and at TaskSpec generation time refuses any worker plan whose sub-task would edit a codegen-output path without ALSO naming the source-path + regenerate-command. The worker's plan is rewritten to the canonical `(edit source → run regenerate → verify diff matches intent)` shape. Heuristic globs (`dist/`, `*.generated.*`, `tool-importer/listings/`, `resources/tools/`) trigger a warning even when no formal `codegen-pair:` law exists yet, prompting `/write-laws` to codify the pair. The bug-2 pattern — 5f2c8a85 hand-edited shipping manifests in a single commit with no importer-side change paired — becomes structurally impossible to emit.

Pairs with `/write-laws`'s Codegen Pair Law Template (write-side: how to codify a codegen relationship as a binding law with declared frontmatter) and `/read-laws`'s Codegen Output Guard (read-side: agent pre-edit check at law-application time). The three skills together close the loop.

**🧭 Action-Run Opt-In / Required-Checks Reconciliation (v1.29.0 — `bug-fix-2026-06-r27` PR #973 false blocker, 2026-06-13):** The r27 INTEGRATE row incorrectly treated Clawso's `Detect [run-action] opt-in` result as a required GitHub Actions failure and blocked a normal merge. That was wrong: Clawso PRs intentionally bypass GitHub Actions unless the operator explicitly opts in through `/ship-changes --git-action` and the literal `[run-action]` marker. **Fix (v1.29.0):** every GIT-mode TaskSpec must emit an `Action Run Policy` and INTEGRATE must follow it. Default policy is project-specific, not globally "wait for Actions": `action-run-opt-in` means do not add `[run-action]`, do not call `workflow_dispatch`, do not rerun skipped jobs, and do not block on opt-in detector jobs or downstream skipped Actions. INTEGRATE waits only for checks that are actually required by branch protection / mergeability / the TaskSpec's explicit policy. If `--git-action`, `[run-action]`, or a PRD process fix explicitly opts into Actions, then GitHub Actions failures are real blockers. See Step 4.6.1 and the INTEGRATE template.

**🧱 Baseline Cleanup Gate (v1.22.0 — prevents feature PRE-FLIGHT from rediscovering known repo debt):** A UX remediation round (`agent-dispatcher-f0953280`, 2026-05-31) emitted a strict repo-wide PRE-FLIGHT containing full workspace tests and boundary lint checks. PRE-FLIGHT correctly failed on broad pre-existing baseline debt unrelated to the UX scope, and meridian-roles correctly blocked every downstream worker because the TaskSpec had made global green status a hard dependency. The failure was not a dispatcher bug; it was a TaskSpec granularity error. **Fix:** before generating a feature TaskSpec with strict global PRE-FLIGHT gates, the skill must establish baseline readiness at generation time. If the intended gates include full-repo tests, full-repo lint, full workspace build, or other repo-wide health checks and the current base is red or unknown, STOP generating the feature TaskSpec and instead generate or recommend a dedicated `baseline-cleanup` TaskSpec whose sole goal is making those global gates green. Feature TaskSpecs may keep strict PRE-FLIGHT only after the baseline is known green. Scoped/audit-only preflight modes are allowed only when explicitly requested and documented in `index.md` with the skipped global gates and rationale; they are not the default.

**🛟 POST-FLIGHT Orphan-WIP Preservation Default (v1.24.0 — stops `needs_pm` escalation on recurring round-end pattern):** The same round (`agent-dispatcher-f0953280`'s POST-FLIGHT, 2026-06-01, skills-ux-h1 umbrella PR #706) returned `needs_pm` because the long-lived primary checkout held three uncommitted/untracked test files that blocked `git pull --ff-only` to `feat/client-rebuild--v3`. Those files were an alternate, more comprehensive test draft (skills.status coverage, richer fixtures) that diverged from what shipped in #706 — produced by a worker that ran in or leaked into the primary checkout. This is the **second** occurrence of the pattern (the first was the PRE-FLIGHT incident captured in `process/preflight-validate-integration-tree-not-dirty-primary.md`). The prior PRE-FLIGHT learning encoded the prohibition ("don't stash, reset, or force-update"); it did not name a positive disposition, so POST-FLIGHT had to escalate with a 3-option PM menu (preserve / discard / proceed-dirty). PM chose preserve. **Fix (v1.24.0):** the POST-FLIGHT Worker Template now generates an explicit `POST-FLIGHT.0 — Primary Checkout Orphan-WIP Triage` sub-task that runs **before** `POST-FLIGHT.1` (verify integration) and **before** any worktree teardown. POST-FLIGHT.0 classifies orphan files into round-relevant WIP vs. tooling cruft (`.claude/`, IDE caches, `.DS_Store`), preserves the round-relevant set to a `wip/<taskspec-id>-orphan-<YYYY-MM-DD>` branch (committed with a divergence-naming message + pushed), leaves the tooling cruft untouched, then fast-forwards primary to `origin/<PR-base-branch>`. POST-FLIGHT.0 only escalates to PM when (a) a file cannot be classified as round-relevant vs. cruft from path + filename + diff signal alone (e.g. a modified file under a path the round didn't touch — could be unrelated session work), or (b) the §POST-FLIGHT.2.5 squash-merge equivalence proof (`git diff --stat origin/<PR-base-branch> <taskspec-id>/integration` empty) fails. This collapses the recurring "PM menu for the same disposition" into a one-step playbook. The full diagnostic recipe (mtime correlation, untracked-file-vs-merge-target diff, squash-merge equivalence proof) is encoded in the generated POST-FLIGHT.md so future operators don't re-derive it. See the **POST-FLIGHT Worker Template** below and `process/post-flight-preserve-orphan-wip-with-named-branch.md`.

**⛔ Meridian dependency sentinel hardening (v1.18.0 — `none` blocked PRE-FLIGHT):** In the `writer-workstation-remediation-2026-05-26` round, the generated `dispatch_plan.md` used `Depends On: none` for `PRE-FLIGHT`. Meridian-roles treats only blank, `-`, and `—` as no-dependency placeholders; the word `none` is parsed as an unresolved dependency token. Result: `PRE-FLIGHT` was not eligible, repeated continue attempts tripped the launch breaker, and the dispatcher paused before any product worker started. **Fix:** new TaskSpecs MUST emit ASCII `-` as the canonical no-dependency value in the Master Dispatch Table's `Depends On` column. Never emit `none`, `None`, `N/A`, `NA`, `null`, `no deps`, prose, or an empty cell there. Post-generation validation MUST parse the Master Dispatch Table, reject fake no-dependency words, and assert every non-`-` dependency token resolves to an emitted Worker ID or the exact special token `ALL-PRIOR`.

**🔄 Post-Work Learnings Capture (v1.12.0 — keep the pool fresh):** The v1.11.0 optimization moved the *read-side* of the learnings pool to generation time (curate once, distribute per worker). The *write-side* — capturing what each worker actually discovered — was still implicit. Workers would finish, mark ✅, stop, and any non-obvious finding from their session was lost. **Fix:** every worker's `#### Completion Protocol` now includes a mandatory **Capture Reusable Learnings** step, executed AFTER PR merge and BEFORE writing the report, that follows the `/ship-changes` skill §10 contract: ask whether this row produced a reusable insight (root cause, contract, gotcha, verified diagnostic, environment quirk), and if yes, write it to `/Users/yzliu/work/Docs/Projects/<project>/learnings/<topic-slug>.md` (or append a dated entry to the matching existing slug). Workers cite the captured file path in their report's `## Learnings Discovered` section. Routine syntax, one-off trivia, secrets, and already-documented facts are NOT captured. This closes the loop with v1.11.0: the next round's TaskSpec generator will sweep the now-richer pool and curate from it.

**Session Isolation Invariant (one session = one task):** A session may execute exactly **one** dispatch row, then it is over. "Task" means **any single row** in the dispatch plan: `PRE-FLIGHT`, implementation workers, batch gates, and verification workers. This applies to every model and effort, including `claude-opus-4-8::max` and `gpt-5.6-sol::ultra`. `ultra` may delegate bounded work inside its one owned row only; it does not authorize claiming another row. A short task, a blocked task, or a closely related follow-up task does **not** authorize reuse of the same session. If the next task needs prior context, carry it forward as a structured summary into a **new** session. Each session also creates its own git branch (`<taskspec-id>/<WORKER_ID>`).

**Anti-Collision Protocol (Claim-First):** When multiple worker sessions are dispatched against the same dispatch plan, race conditions are inevitable. The dispatch command enforces a **claim-before-analyze** rule: the moment a worker session identifies its eligible task, it must immediately mark the row `🔄` before performing ANY analysis, code reading, or planning. This prevents two workers from silently working on the same task and wasting cycles. See Step 3.5 in the Dispatch Command for the exact protocol.

---

## Parameters

The taskspec skill accepts optional parameters that modify generation behavior. Parameters are specified by the user when invoking the skill (e.g. `taskspec --append <path>`, `taskspec --assign-codex`, or both together).

### `--append <existing-taskspec-directory>`

**Purpose:** Instead of generating a fresh TaskSpec directory, append new workers to an existing TaskSpec.

**When to use:** When a new PRD, fix PRD, or additional requirements arrive for a project that already has an active TaskSpec. Instead of creating a separate TaskSpec (which fragments dispatch), the new workers are added to the existing one under the existing branch output directory.

**Behavior changes:**

1. **Path Validation Gate (Step 0):** Instead of asking for a new TaskSpec ID, ask for the **absolute path to the existing TaskSpec directory**. Read the existing `index.md` and `dispatch_plan.md` to understand current state (existing workers, batches, version, dependencies).

2. **Worker ID continuation:** New worker IDs continue from the highest existing ID per prefix. E.g. if the existing TaskSpec has `R-01` through `R-09`, new rework workers start at `R-10`. Read the existing dispatch table to determine the next available ID for each prefix (`R-`, `N-`, `D-`, `V-`).

3. **Batch assignment:** New workers are assigned to batches **after** the last existing batch, unless they have no dependencies on existing workers — in which case they may be inserted into an existing batch if logically appropriate. Never reorder or renumber existing batches.

4. **Artifact generation (Step 6):**
   - **`index.md`**: Append new workers to the existing Dispatch Table and Worker File Manifest. Add new Cross-Worker Integration Points and Runtime Contracts if the new workers integrate with existing ones. Bump the version.
   - **Worker files**: Create new `<WORKER_ID>.md` files in the existing directory. Never overwrite existing worker files. Each new UI-facing worker MUST include its own `#### Visual Canon` section (reusing the existing round canon or requiring the PRD to provide one if missing). Each new worker MUST get its curated laws written into its Context Capsule, emitted in the same append pass (re-run the Step 2.8 sweep ONCE for the appended batch; the card carries only the capsule pointer) and its own `#### Referenced Learnings` section (curated against the current learnings directory — re-run the Step 2.7 sweep ONCE for the appended batch). Existing workers' curated lists are NEVER edited even if new laws or learnings have been written since the original generation.
   - **`dispatch_plan.md`**: Append new rows to the Master Dispatch Table. Add new Batch Execution Details sections. Update PRD Reference Paths if new PRDs are referenced. Bump version in header.
   - **`dispatch_command.md`**: Generally unchanged — the existing dispatch command already handles new rows. Update the Round Context Note if the version changes. Add new PRD paths to Environment Configuration if needed.
   - **`pm_playbook.md`**: NEVER overwrite. Leave §1, §2, §3, §4 untouched. Append a single dated entry to the Changelog section noting which workers were added in this `--append` invocation. If new workers introduce a new compliance/principle that PM dictated for this batch, mention it in the Changelog so PM can decide whether to add it to §3 themselves.

5. **Version bump:** Increment the minor version (e.g. `v2.4` → `v2.4.1`). Add a changelog entry documenting which workers were appended and why.

6. **Dependency wiring:** New workers may depend on existing workers (by referencing their IDs). Existing workers are never modified — if a new worker needs something from an existing worker's output, model it as a dependency, not as an edit to the existing worker.

**Hard rule:** Never delete, rename, modify, or reorder existing workers, batches, or dispatch rows. Append-only.

### `--assign-codex`

**Purpose:** All generated workers are assigned Codex canonical model IDs (with `::effort` suffix) instead of Claude IDs.

**When to use:** When the execution target is Codex worker sessions rather than Claude models. Eliminates the separate assign-codex step after TaskSpec generation.

**Behavior changes:**

1. **Model Assignment (Step 5):** Apply the full GPT-5.6 capability-aware matrix. For TaskSpec generation, this section is authoritative; do not inherit the obsolete two-tier `gpt-5.5::high/xhigh` restriction from older standalone `assign-codex` copies.

   | Tier | Default profile | Allowed escalation inside the tier | Assign when |
   |------|-----------------|------------------------------------|-------------|
   | T0 | `gpt-5.6-luna::low` | `gpt-5.6-luna::medium` | Mechanical checks, doc-only changes, deterministic single-file edits, narrow cleanup |
   | T1 | `gpt-5.6-terra::medium` | `gpt-5.6-terra::high` | Everyday implementation, well-specified schema/UI/CRUD work, 2–3 coupled touchpoints |
   | T2 | `gpt-5.6-terra::xhigh` | `gpt-5.6-sol::high` | Nuanced business logic, cross-layer contracts, multiple plausible implementations, interfaces consumed by 3+ workers |
   | T3 | `gpt-5.6-sol::xhigh` | `gpt-5.6-sol::max` (forwardable since 2026-08-08 — verify against the runtime's set first, see the Effort-Forwardability callout); `gpt-5.6-sol::ultra` only by explicit delegation opt-in | Async/IPC/lifecycle/streaming, high-risk architecture, weak-observability diagnosis, terminal integration with genuinely coupled proof obligations |

   **Family rule:** Luna = bounded/fast, Terra = everyday/balanced, Sol = frontier/high-risk. Pick family and effort separately; do not treat a tier as one fixed model.

   **Escalation rule:** File count, terminal-row status, or one previous failure is not enough to select Sol, `max`, or `ultra`. Record the concrete ambiguity, blast radius, irreversibility, or proof burden that justifies each exceptional assignment.

   **Ultra rule:** `gpt-5.6-sol::ultra` is valid only when the TaskSpec explicitly states `Internal Delegation: allowed`, the row remains the sole owner of one dispatch row, and bounded delegates cannot claim other rows. Otherwise cap at `max`.

   **Pinned legacy compatibility:** Existing appended rows keep their pinned `gpt-5.4`, `gpt-5.5`, or `gpt-5.3-codex-spark` IDs. New rows use GPT-5.6 unless the user explicitly requests a legacy model or the local model catalog proves GPT-5.6 unavailable.

2. **Required Context blocks:** For every worker, generate a `#### Required Context` block following the assign-codex skill's Required Context Authoring Rules (Rules 1–6). This block is inserted immediately after `#### Depends on` and before `#### Sub-tasks` in each worker file.

3. **Worker Identity Declaration:** The dispatch command uses the Codex-tier identity block:
   ```
   Before doing anything else, determine which model you are. Your worker code is the exact `<modelId>::<effort>` string in the dispatch plan's Model column for the row you are claiming.
   - Luna example: `gpt-5.6-luna::low`
   - Terra example: `gpt-5.6-terra::medium`
   - Sol example: `gpt-5.6-sol::xhigh`
   - `max` and `ultra` are literal effort values when the dispatch row explicitly uses them.
   - If you cannot determine your modelId and effort → output `PAUSE — unable to determine worker code` and stop immediately.
   - Rows with Model = PM are human-resolved decision points. You are never PM. Skip these rows.
   - Rows with Model = HUMAN are manual authority gates for operator-owned credentials, production consoles, or external decisions. You are never HUMAN. Skip these rows. Do not generate HUMAN rows for GUI, UX, browser, staging, or product-acceptance checks; those must be model-assigned agent E2E rows.
   ```

4. **Model Assignment Legend:** The dispatch plan lists all three GPT-5.6 families and explains both axes: family capability (Luna / Terra / Sol) and effort depth (`low` through `max`, plus guarded `ultra`).

5. **Validation:** After generation, verify:
   - No `OPUS`, `SONNET`, `CODEX`, `CODEX-HIGH`, `CODEX-XHIGH`, or `GEMINI` literal remains in any generated artifact
   - No bare `gpt-*` (without `::effort`) appears as a Model column value
   - Every new Codex row uses `gpt-5.6-luna`, `gpt-5.6-terra`, or `gpt-5.6-sol` unless a documented legacy/catalog exception applies
   - Every worker has a `#### Required Context` block
   - The Worker Identity Declaration lists Luna, Terra, and Sol examples
   - Every `sol`, `max`, or `ultra` assignment has a non-generic routing rationale
   - Every `ultra` row declares `Internal Delegation: allowed`; otherwise generation fails
   - The per-worker rubric was applied; blanket family/effort assignment is rejected unless every row is demonstrably homogeneous

### Using both: `--append <path> --assign-codex`

When both parameters are active:

1. Read the existing TaskSpec to understand current state
2. Generate new workers with Codex model tier assignments and Required Context blocks
3. Append new workers/rows/batches to existing artifacts
4. Update the Worker Identity Declaration to the Codex-tier version (if not already updated)
5. Update the Model Assignment Legend to replace Claude canonical IDs with the GPT-5.6 Luna / Terra / Sol matrix (if not already present)
6. **Existing workers are NOT reassigned** — only new workers get capability-aware Codex routes. To reassign existing workers, use the standalone assign-codex skill separately.

### `--meridian`

**Purpose:** Generate TaskSpec artifacts that compose cleanly with the **meridian-roles dispatcher runtime** (`/Users/yzliu/work/Meridian/Meridian-roles`). The meridian-roles agent dispatcher prepends a slim launch preamble to every worker's prompt; that preamble carries authoritative rules — most importantly, "the lifecycle store manages all plan status updates — you do not need to write to the dispatch plan yourself" and "your final reply MUST end with exactly one `<<<MERIDIAN-STATUS>>>` block, plain text, NOT inside a code fence." Default /taskspec output contradicts both: it tells workers to claim-stamp `🔄`, then mark `✅` after merge, and emits free-text `⏸ PAUSE` rather than a structured marker. Running the two together produces real failure modes — workers writing rows the lifecycle was already managing (causing dirty plan / lifecycle drift), workers self-promoting to `✅` before meridian's separate validator role has run, lifecycle ignoring narrative outcome and falling back to legacy heuristics. `--meridian` removes those contradictions.

**When to use:** When the dispatched TaskSpec will be executed by **meridian-roles agent-dispatcher** (worker / validator / pm-resolver loops driven by `meridian-status-marker.ts`, `lifecycle-store.ts`, `validator-orchestrator.ts`, `pm-resolver.ts`). When the worker is launched directly by a human in a fresh Claude/Codex session without a meridian dispatcher in the loop, do NOT use this flag — workers will then have no lifecycle store taking responsibility for plan updates.

**Behavior changes — what the generated artifacts must look like:**

1. **Plan-status writes are removed everywhere.** Workers MUST NOT modify `dispatch_plan.md`. The lifecycle store at `src/roles/agent-dispatcher/lifecycle-store.ts` owns every status transition (`⬜ → 🔄 → ✅ / ⛔`).
   - **Drop Step 3.5a (Claim Stamp)** from the dispatch_command. Replace with: *"Your row is pre-marked 🔄ﾠ by the meridian-roles lifecycle store. Do NOT modify the dispatch plan; the lifecycle owns all status updates. Anti-collision is handled by lifecycle thread-id reservation, not by claim-first plan writes."*
   - **Drop Step 5g (record PR URL into Plan), Step 5i (leave `🔄`), Step 5k (mark `✅`)**. Replace with: *"Status flows entirely through the MeridianStatusMarker block in your reply. Do not edit the dispatch plan even after PR merge. The lifecycle reconciles `expected_outputs` and the marker to compute the row's final state."*
   - **Drop the worker file's Completion Protocol step that writes `🔄 → ✅`** (currently §7 in the worker template). Renumber subsequent steps.
   - **Drop the "Anti-Collision Protocol (Claim-First)" intro paragraph.** Replace with a one-line note: *"Anti-collision: meridian-roles' lifecycle store reserves a single thread per row via thread-id reservation; workers never claim-stamp."*

2. **Reply Protocol is mandatory.** Every worker file ends with a `#### Reply Protocol` section, and the dispatch_command's Step 5 ends by reminding the worker to emit it. Verbatim shape (substitute `<WORKER_ID>` per worker):

   ```
   #### Reply Protocol *(mandatory under --meridian — emitted by every reply)*

   Your final reply MUST end with exactly one status block, plain text, NOT inside a code fence:

   <<<MERIDIAN-STATUS>>>
   worker_id: <WORKER_ID>
   role: worker
   outcome: complete | failed | blocked | hit_limit | needs_pm
   report_path: <absolute path to your report; required for `complete`>
   notes: <one short line>
   <<<END>>>

   This block is the ONLY authoritative status signal. Narrative progress text is ignored by the lifecycle store. Pick exactly one `outcome`:
   - `complete` — work finished and a fresh report was written. Lifecycle requires the file at `report_path` to have been modified during this session when `expected_outputs` is non-empty. Claiming `complete` without a fresh report leaves the row `running`; the reconciler will retry.
   - `failed` — work attempted but failed. Add an `error: <one line>` field.
   - `blocked` — cannot proceed without external action; describe in `notes`.
   - `hit_limit` — token / context / time limit hit before finishing. Lifecycle treats this as `failed`.
   - `needs_pm` — outcome is ambiguous; ask the project manager. Lifecycle treats this as `blocked` and routes to the pm-resolver role.

   Emit exactly one block. If you must reference the format earlier in your reply (e.g. for documentation), wrap that example in a fenced code block (` ``` `); only the unfenced block at the end of your reply is parsed.
   ```

   Placement in the worker file: **after** `#### Completion Protocol`, **before** the closing fence. The `<WORKER_ID>` substitution is performed at generation time per worker.

3. **Self-validation does not promote to `✅`.** Workers still run `#### AI Auto-Tests` and `#### Behavioral Assertions` for their own diligence (and so a failing test produces an `outcome: failed` marker rather than a false `complete`), but they **never write `✅` themselves**. Meridian-roles' validator role (`validator-prompt-builder.ts`) runs in its own session, scores the deliverable, and emits a validator marker (`pass` / `fix_requested` / `fail`) which the lifecycle store consumes. Drop the worker template's "Pre-Commit Branch Assertion → mark ✅" wording; keep the verification commands.

4. **PM resolution is delegated to the pm-resolver role.** Workers do NOT append `⏳ PENDING` rows to `pm_playbook.md` §4. They MAY still consult §1 (Blocker Resolutions Library), §2 (Failure Recovery Patterns), and §3 (Applied Principles & Laws) — those are read-only for workers and provide blocker resolutions before declaring `outcome: blocked`. When no §1 / §2 resolution applies, workers emit `outcome: needs_pm`; meridian's pm-resolver session (`pm-resolver.ts:buildPmResolverPrompt`) is launched by the dispatcher, consults the playbook with full authority (it MAY edit dispatch plan / docs / pm_playbook §4), and resolves via meridian-tool commands (`update-status`, `resume-worker`, `continue-dispatcher`, `notify`).
   - Update the Dispatch Command **§0.6 PM Playbook Consultation Protocol** so its `WHEN TO CONSULT` block keeps points 1 (read §3 at claim time) and 3 (read §2 before retry), but rewrites point 2 to: *"Before declaring `outcome: blocked`: READ §1. If a Trigger Keyword matches, apply the Resolution verbatim and continue. If no match exists, emit `outcome: needs_pm` so the pm-resolver role can take authority over §4. Do NOT append §4 rows yourself; the pm-resolver may file them on your behalf."*
   - Update the **DEPENDENCY GATE** wording: workers still skip a row whose `Depends On` worker has an unresolved §4 question, but the gate uses `outcome: blocked` (with reason "awaiting Playbook §4.<N>") instead of `⏸ PAUSE — awaiting Playbook §4.<N>`.

5. **Reports append on existing files.** When a worker's report path already exists (because the row has been retried, validated, or PM-resolved), the worker MUST append a new dated section rather than overwrite:

   ```
   ## Attempt N — <ISO date> — role: worker
   <... attempt body ...>
   ```

   This preserves the meridian-roles invariant (worker-preamble-routed-file-contract, 2026-05-03) that *"if a report file already exists, append a new attempt section instead of replacing the existing file. Preserve prior worker, validator, and PM history in that task report."* Worker template Completion Protocol step 9 (Write report) must be regenerated with this language.

6. **Expected outputs are declared explicitly.** Add an `**Expected Outputs**: [absolute report path], [optional additional artifact paths]` line to every worker file's header (after `**Branch**`). This is the hook the lifecycle store uses to verify report freshness when honoring `outcome: complete`. Without it, the marker's `complete` claim falls through to the reconciler's "claim without evidence" branch.

7. **NO-GIT delivery mode is supported.** The Round Context block in `dispatch_command.md` gains a `Delivery Mode: GIT | NO-GIT` field. Under `NO-GIT`:
   - Drop the entire git-delivery cluster: Step 3.5b (branch creation), Step 4.0 (Working Branch Gate), Step 5d (Pre-Commit Branch Assertion), Step 5e/5f/5h/5j (push/PR/merge/resync), and the worker template's Completion Protocol §0 / §1 / §2 / §3 / §4 / §5 / §6 (Git Delivery Self-Test).
   - Reports are still written to `<Docs root>/branch/<taskspec-id>/taskspec/reports/<WORKER_ID>.md`.
   - The Reply Protocol's `outcome: complete` requires a fresh report file (not a merged PR). Step 5 collapses to: run tests → write report (append if exists) → emit marker → stop.
   - Default Mode under `--meridian` is **GIT** unless the user explicitly says otherwise during the Path Validation Gate. The skill MUST ask `Delivery Mode (GIT or NO-GIT)?` at Step 0 alongside the other path questions.

8. **Lifecycle-managed status symbols are read-only for verification workers.** Verification / V-* workers and any worker with diff-review responsibility are told (verbatim, in the worker file's `#### Sub-tasks` notes section): *"Do not fail an otherwise valid deliverable solely because the dispatch plan row still shows a lifecycle-managed transient symbol such as `🔍`, `🔁`, or `🔄`. The dispatch plan is service metadata under meridian-roles; the source of truth for status is `dispatch_threads.json` (the lifecycle sidecar)."* This mirrors the validator-prompt-builder's NO-GIT and Lifecycle Metadata Rules.

9. **No dispatcher-controller worker row is emitted.** Default /taskspec generation does not create a dispatcher row, so this is usually a no-op. But if the user requests one explicitly, refuse under `--meridian`: meridian-roles spawns its own dispatcher (`agent-dispatcher`) externally; a worker-row dispatcher would conflict with `isDispatcherWorker(workerId)` semantics in `tool-gateway/tools/run.ts`.

10. **Stop-immediately rule survives.** Step 5m / Completion Protocol §10 still says "Stop session immediately." Under `--meridian`, the marker block is the very last thing in the reply, then the session ends.

10a. **TaskSpec worktree composes with `--meridian` (v1.15.0 / corrected v1.21.0).** Under **serial dispatch** (default; `parallel_dispatch.enabled=false` or `max_concurrency=1`), the v1.15.0 shared TaskSpec worktree is correct: meridian-roles' `continue-dispatcher` resolves at most one eligible worker per tick (`service-continuation.ts:37`, the `resolveFirstEligibleContinueWorker` wrapper that calls `resolveEligibleServiceContinueWorkers(..., { limit: 1 })`); `continue-worker.ts:114-120` short-circuits already-`running` workers; the §3.5c clean-tree assertion catches any leftover WIP before the next serial worker writes. Every worker's `**Repo**:` field is set to `<repo-root>/.worktrees/<taskspec-id>`; POST-FLIGHT's is the **exception** at `<repo-root>` so it can remove the worktree. Under **parallel dispatch** (`parallel_dispatch.enabled=true && max_concurrency>1`), the shared-worktree scheme is **unsafe** — `role-handlers.ts:970-1059` launches multiple workers concurrently, each spawning in the same cwd if all `**Repo**:` fields point at the same path, producing `git checkout` / `index.lock` / `node_modules` / `target/` races. Generate the TaskSpec with `--parallel` whenever the downstream dispatch will run parallel (most commonly any `/dispatch ... --codex-para` invocation); the per-worker `**Repo**:` paths produced by `--parallel` give each concurrent worker its own cwd. `/dispatch` is the enforcement point and refuses to launch a parallel dispatcher against a shared-worktree TaskSpec.

**Scheduler awareness (when meridian-roles' scheduler role drives the round, not just the dispatcher):**

The scheduler at `src/roles/scheduler/` (`scheduler-engine.ts`, `cycle-manager.ts`) wraps the dispatcher with a recurring-cycle layer. When the user says the TaskSpec will run under the scheduler, `--meridian` adds the following on top of the dispatcher rules above. (When the round is dispatcher-only, ignore this subsection.)

11. **Plan resets every cycle.** `cycle-manager.startCycle` calls `resetDispatchPlan(planPath)` at the top of every run, rewriting every non-`⬜` status cell to `⬜`, AND wipes `dispatch_threads.json` to an empty `{ workers: {} }`. Persistent worker writes to `dispatch_plan.md` would be erased on the next cycle anyway, so `--meridian`'s "no-plan-writes" rule is doubly correct under the scheduler. The dispatch plan must be a Markdown table with a `| Status |` header column followed by a separator row — `resetDispatchPlan` keys on that shape. /taskspec already generates this format; no change needed.

12. **`SCAN_RUN_ID` is injected, not computed.** Under the scheduler, every worker preamble carries a `# Scheduler Cycle Context` block:
    ```
    SCHEDULER_RUN_ID: <uuid>
    SCAN_RUN_ID: daily-2026-05-06
    Use this exact `SCAN_RUN_ID`; do not recompute it from the local date.
    ```
    Worker files under `--meridian` MUST contain a verbatim sentence (in the `#### Sub-tasks` notes block of any sub-task that touches a per-cycle artifact path or invokes a tool with `--scan-run-id`): *"If a `SCAN_RUN_ID` appears in the runtime preamble, use that value verbatim. Do not derive a scan run ID from `date`, `Date.now()`, or the local timezone — timezone drift between the scheduler host and the worker will produce a different ID and orphan your output. The scheduler's `scheduler_state.current_scan_run_id` is the source of truth."* This codifies `learnings/scheduler-tool-process-scan-id.md`.

13. **Report path follows the scheduler override.** When `expected_outputs` contains a path of the shape `<...>/runs/<run-id>/<worker-id>.md` (or `<worker-id>_report.md`) — basename matched lowercase — `findSchedulerRunReportOutput` (in `tool-gateway/tools/run.ts`) injects a `# Report Path Override` block that supersedes any report path in the dispatch_command. **For scheduler rounds the worker file's `**Expected Outputs**:` line MUST include exactly one path of that shape**, e.g. `<report_base_dir>/runs/<run-id>/<worker-id>.md` resolved relative to `config.report_base_dir` from the scheduler config. Without it, the override never fires and reports land in the wrong place. The Reply Protocol's `report_path` field then carries the runtime-resolved override path, not a static path baked at generation time.

14. **Two row types: `agent` vs `tool-process`.** Scheduler plans mix LLM-driven rows (a Claude/Codex session emits a marker) with **runtime tool-process rows** (a CLI child process such as `github-ai-automation-scan classify --scan-run-id <SCAN_RUN_ID> --progress <path>`). The two have different contracts:

    - **`Runtime: agent`** — Standard LLM worker. Reply Protocol applies. Marker block is the authoritative status signal.
    - **`Runtime: tool-process`** — Plan-row task column contains the EXACT subcommand the scheduler will spawn (e.g. `github-ai-automation-scan classify`). `isWorkerToolProcessRunning` (`src/roles/agent-dispatcher/active-tool-process.ts`) matches live `ps` output against this string + the scheduler's fallback `--scan-run-id`. The row has NO Reply Protocol block — child processes don't emit markers; the scheduler's output-recovery path (`scheduler-engine.ts:recoverCurrentRunOutputs` + `classifyRecoveredOutputStatus`) reads the report file content to derive terminal status. Each tool-process worker file must declare:
      - `**Runtime**: tool-process`
      - `**Tool Command**: <exact subcommand string the scheduler will exec, including all flags whose absence would block process matching>`
      - `**Progress File**: <absolute path to the PID-backed `*.progress.json` the tool writes>` (consumed by `dispatch-status.ts` for stale-PID detection per `learnings/scheduler-dead-progress-pid.md`)
      - `**Expected Outputs**: <absolute report path>` — **mandatory**; output recovery is the only terminal-status path for tool-process rows.

    Generation-time prompt: when `--meridian` is active and the user says the round is scheduler-driven, the skill MUST ask, per worker, *"Runtime: agent or tool-process?"* and, for tool-process, gather the Tool Command and Progress File before generating the worker file.

15. **No DISPATCHER plan row.** Already covered by rule 9 above, but specifically for the scheduler: `cycle-manager.detectCycleCompletion` and `archiver.ts` ignore the synthetic `DISPATCHER` lifecycle row when scoring terminal outcome (`learnings/scheduler-synthetic-dispatcher-outcome.md`). Adding a real `DISPATCHER` plan row would shadow the synthetic bookkeeping entry and corrupt outcome scoring. Under `--meridian` the skill MUST refuse if the user requests a worker whose ID is `DISPATCHER` (case-insensitive); suggest a different ID such as `CTRL` or `ORCHESTRATE`.

16. **HUMAN / PM rows.** The scheduler treats `Model: HUMAN` and `Model: PM` rows as manual-intervention rows that pause the cycle without failing it (`HUMAN_MODELS = new Set(["HUMAN", "PM"])`). These rows are reserved for genuine operator authority: missing credentials, production-console actions, legal/product decisions, or PM ambiguity resolution. Under `--meridian`, do **not** generate HUMAN rows for GUI, UX, browser, staging, or product-acceptance checks. Those checks must be assigned to an agent row with concrete browser E2E steps and a real model ID. Human/PM review after TaskSpec completion is out-of-band and is not a dispatch-table task.

17. **Cycle-aware reports.** Because the plan resets on every cycle, the same worker may run on N cycles and produce N reports. Combined with rule 13 (per-run report path), this means each cycle's report lands in `runs/<run-id>/<worker-id>.md` — a fresh file. Report-append (rule 5 above) applies WITHIN a cycle (worker → validator → pm-resolver attempts), not ACROSS cycles. The Completion Protocol step 9 (Write report) wording under `--meridian + scheduler` should clarify: *"Report path is `runs/<SCHEDULER_RUN_ID>/<WORKER_ID>.md` resolved from the runtime override. Append a `## Attempt N` section if the file already exists in this cycle's run directory; do NOT look for or migrate prior cycles' reports."*

**Generation-time prompt for scheduler awareness:** when `--meridian` is active, the skill MUST ask: *"Is this TaskSpec dispatched directly via meridian-roles' agent-dispatcher (one-shot), or is it driven by the scheduler role on a recurring cycle?"* If scheduler:
  - Ask for `report_base_dir` (used to build `runs/<run-id>/<worker-id>.md` paths).
  - Ask whether the round uses `scan_run_id_strategy: "daily-date"` (and if so, the `scan_run_id_prefix`, default `daily`).
  - For each worker, ask `Runtime: agent | tool-process` (default `agent`).
  - Tool-process workers additionally ask for the Tool Command string and Progress File path.

**Plan-parser constraints (v1.14.0 — applies to every `--meridian` round):**

Meridian-roles parses `dispatch_plan.md`'s Master Dispatch Table with a **naive `String.split("|")`** (no escape, no backtick awareness, no code-span awareness). Anything that produces a literal `|` inside a cell silently truncates the entire plan from that row onward. The generator MUST enforce the following invariants when writing `dispatch_plan.md`:

1. **No literal `|` inside any data cell** of the Master Dispatch Table — escaped (`\|`), backtick-wrapped (`` `A|B` ``), or otherwise. The header line is exempt because the generator controls its cell count.
2. **Acceptable substitutes** for union/alternation expressions in cells:
   - ` / ` (slash with surrounding spaces) — preferred for type-union narration: `AdapterError (Transport / Protocol / Tool)`
   - `, ` (comma) — for plain alternatives
   - ` or ` — for two-way alternation
   - Parenthesized list — `(A, B, C)`
   - Rewrite to avoid the inline union altogether — `AdapterError variants Transport, Protocol, Tool`
3. **Cell count parity across rows**: every data row MUST have exactly the same number of `|` separators as the header row. The generator computes the header's expected cell count once and validates every emitted row.
4. **Separator row hygiene**: the `|--------|...` separator immediately after the header MUST have the same cell count as the header. No omitting dashes; no extra columns; no trailing pipe omission.
5. **End-of-table contract**: stop emitting Master-Dispatch-Table-shaped rows the moment Master Dispatch Table ends. The parser walks until cell count mismatches; subsequent tables (PM Flags Summary, Completion Tracking, etc.) MUST have a different cell count or be separated by a non-table line so they don't accidentally extend the Master Dispatch Table (this is already enforced naturally because those tables have 3–4 columns vs the Master Dispatch Table's 11).
6. **Long task descriptions go to the worker file, not the Task cell**: the Task column is a one-line summary. Detailed adapter mapping tables, code snippets, multi-pipe diagrams belong in `<WORKER_ID>.md` sub-tasks. The Task cell stays narrative-prose without delimiters.
7. **Depends On cell grammar is strict.** For generated `dispatch_plan.md` rows, the no-dependency value is the ASCII hyphen `-` only. Do not emit blank cells, `none`, `None`, `N/A`, `NA`, `null`, `no deps`, or prose in the `Depends On` column. Non-empty dependencies must be either exact worker IDs emitted in the same Master Dispatch Table, comma-separated / ` + `-separated lists of exact worker IDs, or the exact special token `ALL-PRIOR`. Although meridian-roles currently accepts `—` and blank as empty, TaskSpec output MUST use `-` to avoid Unicode drift and fake dependency tokens.

**Generated-artifact validation (after `--meridian`):**

After generation, verify:
- **No literal `|` inside any data cell of `dispatch_plan.md`'s Master Dispatch Table.** Concretely: run `python3 -c "..."` (or equivalent) that parses the table the way meridian-roles does (`split('|')`) and asserts every data row's cell count equals the header's. The check MUST also grep for `\|` and `` `A|B` `` patterns inside cells and flag them. Reference incident: 2026-05-12, clawso `in-client-debug-system`, R-01 row with `Transport \| Protocol \| Tool` truncated 11 rows. If validation fails, fix the row(s) and re-validate before reporting generation as complete.
- **Every fresh Meridian row starts as `⬜`, never `TODO`.** Parse the Master Dispatch Table, locate the `Status` column, and reject any generated pending row whose value is not exactly `⬜`. `TODO` is not a pending alias for `continue-dispatcher` and blocks PRE-FLIGHT launch.
- **Every `Depends On` cell is Meridian-resolvable.** The validator MUST parse the Master Dispatch Table, locate `Worker` and `Depends On`, assert `PRE-FLIGHT` has `Depends On` exactly `-`, reject fake empty tokens (`none`, `n/a`, `na`, `null`, `no deps`, blank, `—`), and assert every non-`-` dependency token is either an emitted Worker ID or `ALL-PRIOR`. If a dependency group is needed, enumerate the worker IDs explicitly or use `ALL-PRIOR`; do not emit prose groups in the Master Dispatch Table.
  Suggested check:
  ```bash
  python3 - "$TASKSPEC_DIR/dispatch_plan.md" <<'PY'
  import re, sys
  from pathlib import Path

  path = Path(sys.argv[1])
  lines = path.read_text().splitlines()
  header_index = next(i for i, line in enumerate(lines) if line.startswith("| Status |") and "Depends On" in line)
  header = [cell.strip() for cell in lines[header_index].strip("|").split("|")]
  worker_i = header.index("Worker")
  depends_i = header.index("Depends On")
  rows = []
  for line in lines[header_index + 2:]:
      if not line.startswith("|"):
          break
      cells = [cell.strip() for cell in line.strip("|").split("|")]
      if len(cells) != len(header):
          break
      rows.append(cells)
  workers = {row[worker_i] for row in rows}
  bad_empty = {"", "none", "n/a", "na", "null", "no deps", "—"}
  for row in rows:
      worker = row[worker_i]
      dep = row[depends_i].strip()
      if worker == "PRE-FLIGHT" and dep != "-":
          raise SystemExit(f"PRE-FLIGHT Depends On must be '-' not {dep!r}")
      if dep.lower() in bad_empty:
          raise SystemExit(f"{worker} has invalid Depends On sentinel {dep!r}; use '-'")
      if dep == "-":
          continue
      for token in [part.strip() for part in re.split(r",|\s+\+\s+", dep) if part.strip()]:
          if token != "ALL-PRIOR" and token not in workers:
              raise SystemExit(f"{worker} has unresolved dependency token {token!r}")
  PY
  ```
- No occurrence of `Mark ✅`, `Update dispatch plan`, `Change row status`, or `claim stamp` in any generated `dispatch_command.md` or worker file body (the Status Legend table may still be referenced but must not instruct writes).
- No occurrence of `append a new \`⏳ PENDING\` row to §4` or `append a `⏳ PENDING` row to §4` in worker files; §4 is pm-resolver territory.
- Every worker file contains exactly one `#### Reply Protocol` block with the `<<<MERIDIAN-STATUS>>>` template and the worker's actual `<WORKER_ID>`.
- Every worker file declares `**Expected Outputs**: ...` in its header.
- ⭐ **`taskspec/reports/` exists** (may be empty). Meridian's `expected_outputs` convention fallback requires the directory to be present; without it `outcome: complete` is rejected against the wrong path. See Step 6 pre-step C.
- The dispatch_command's Round Context contains `Delivery Mode: GIT` or `Delivery Mode: NO-GIT` (one explicit value, not both).
- The dispatch_command's Round Context, `index.md`, and `dispatch_plan.md` all contain the same `Action Run Policy` value. For GIT-mode rounds, the value MUST be one of `action-run-opt-in`, `required-checks`, `no-actions`, or `unknown`.
- Under `Action Run Policy: action-run-opt-in`, no generated PR body, worker file, dispatch command, INTEGRATE task, or PM resolver instruction may add `[run-action]`, call `workflow_dispatch`, rerun GitHub Actions, or treat opt-in detector jobs as blockers unless the user/PRD explicitly opted into Actions.
- Under `Delivery Mode: NO-GIT`, no Step containing `git push`, `gh pr create`, `gh pr merge`, or `git checkout <PR-base-branch>` remains.
- Under `Delivery Mode: GIT`, every generated TaskSpec with code/validation PRs, a rollup/stack PR, or 2+ non-teardown rows contains an `INTEGRATE` row immediately before `POST-FLIGHT`; `POST-FLIGHT` depends on `INTEGRATE` (directly or through `ALL-PRIOR`). Omission is valid only for single-row doc-only/no-code rounds and must be justified in `index.md` and the dispatch-plan Notes cell.
- `POST-FLIGHT.md` does not contain first-time merge instructions such as `gh pr merge`, `gh pr checks --watch`, or "wait for CI" except as historical/report verification text. Those actions belong to `INTEGRATE.md`, and INTEGRATE must apply the round's `Action Run Policy` before waiting on any GitHub check.
- `POST-FLIGHT.md` contains a `POST-FLIGHT.0 — Primary checkout orphan-WIP triage` sub-task (v1.24.0) **before** `POST-FLIGHT.1`. The generator MUST substitute the `<round-relevant-glob-...>` placeholder with the concrete product/test path globs the round touches (derived from worker `Expected Outputs` / branch scope), so triage classification is mechanical at runtime. The substituted list must NOT include cruft paths (`.claude/`, `node_modules/`, `.DS_Store`, `.idea/`, `.vscode/`, `*.swp`). `POST-FLIGHT.md` also contains a `POST-FLIGHT.2.5` squash-merge equivalence proof gated immediately before branch cleanup, referencing the round's `<taskspec-id>/integration` ref (shared mode) or the umbrella PR head ref (`--parallel` mode).
- If `index.md` or `dispatch_plan.md` declares rollup/stack mode, worker files do not simultaneously require their own PR to merge into base. They must instead name the integration branch/PR that represents their commits, and `INTEGRATE.md` must own the final merge and superseded-PR closure.
- The Anti-Collision Protocol (Claim-First) paragraph in `dispatch_command.md` is replaced by the lifecycle thread-id reservation note.
- (Scheduler rounds only) Every worker file declares `**Runtime**: agent` or `**Runtime**: tool-process`. Every `tool-process` worker also declares `**Tool Command**:`, `**Progress File**:`, and `**Expected Outputs**:` with a path of the shape `<...>/runs/<run-id>/<worker-id>.md`.
- (Scheduler rounds only) No worker has ID `DISPATCHER` (case-insensitive); the scheduler reserves that name for synthetic controller bookkeeping.
- (Scheduler rounds only) Every worker file (or its referenced sub-task notes) carries the verbatim "use SCAN_RUN_ID from the runtime preamble; do not recompute" sentence whenever the worker touches a per-cycle artifact path or invokes a tool with `--scan-run-id`.

**Briefing an external reviewer / advising agent:** `docs/orchestration-briefing-for-external-agents.md` distils this whole section plus the parser contracts into one self-contained handout, with a ⛔ list of orchestration-breaking suggestions. Prefer handing that over excerpting this section.

**Why this exists (load-bearing references):** see `/Users/yzliu/work/Docs/Projects/meridian-roles/learnings/worker-preamble-routed-file-contract.md` (2026-05-03), `meridian-status-marker-protocol.md` (2026-05-03 / 2026-05-04), `scheduler-tool-process-scan-id.md` (2026-05-02), `scheduler-synthetic-dispatcher-outcome.md` (2026-05-02), and `scheduler-dead-progress-pid.md` (2026-05-02). These five learnings document the exact contract `--meridian` honors across both the dispatcher and the scheduler. If meridian-roles ever extends the marker enum or changes the lifecycle's plan-write authority, those files are the canonical update site, and `--meridian`'s rules above must follow.

### Using `--meridian` with other flags

`--meridian` is orthogonal to `--append` and `--assign-codex` and composes with each independently. Combination rules:

- **`--meridian --append <path>`**: Read existing TaskSpec; new workers honor every `--meridian` rule above. **Existing workers are NOT rewritten** even if they predate `--meridian` and still tell their workers to write `✅` — to retrofit existing workers, use a separate manual edit pass (or the assign-codex skill's pattern of "rewrite all workers" if it adopts a similar `--meridian-retrofit` mode in the future). However, the dispatch_command.md IS rewritten when `--meridian` is active and the existing dispatch_command lacks the Reply Protocol block / still has the Claim Stamp paragraph — the dispatch_command is shared by every worker (including pre-existing ones), and meridian-roles will refuse to launch them otherwise. In that case, surface a `⚠️ Dispatch command rewritten to honor --meridian; existing workers may still emit `✅` writes` warning so PM can audit.
- **`--meridian --assign-codex`**: Both apply. Capability-aware Codex model assignment + Required Context blocks AND the meridian reply protocol / no plan writes. The Worker Identity Declaration lists the GPT-5.6 Luna / Terra / Sol families and the exact effort carried by each row. The Reply Protocol block is added on top.
- **`--meridian --append --assign-codex`**: All three apply per the rules above. Existing workers untouched; new workers Codex-tiered with marker block; dispatch_command updated to meridian semantics with the warning shown.

### `--parallel`

**Purpose:** Emit a TaskSpec whose worktree topology is **per-worker** instead of the v1.15.0 shared default. Required when the downstream dispatch will run with `parallel_dispatch.enabled=true` and `max_concurrency > 1` — for example any `/dispatch ... --codex-para` invocation, or explicit `--parallel-dispatch-enabled --parallel-dispatch-max-concurrency N` on the dispatch runner.

**When to use:**
- The user explicitly says "parallel", "concurrent", "codex-para", or "fan out workers".
- The dispatch profile chosen for this round is `codex-para` (or any saved template that enables parallel dispatch).
- The user wants throughput within a single round, not just across multiple TaskSpecs.

**When NOT to use** (i.e. omit `--parallel`):
- The default. Most rounds run serial — meridian-roles default is `max_concurrency=1`, the dispatcher launches one worker per continue tick, and a shared TaskSpec worktree is correct.
- The user is fine with the natural latency of one worker at a time and doesn't want to pay the per-worker disk cost (~N × source tree clones).

**Behavior changes when `--parallel` is active:**

1. **PRE-FLIGHT.W creates N+1 worktrees** instead of one:
   - One **per-worker worktree** per implementation worker (`R-*`, `N-*`, `D-*`) at `<repo-root>/.worktrees/<taskspec-id>-<WORKER_ID>`, branched from the integration branch.
   - One **shared integration worktree** at `<repo-root>/.worktrees/<taskspec-id>-integration`, used by BATCH-N-GATE, V-* (verification), and INTEGRATE rows that need to see the merged tree.
   - All worktrees get the `node_modules` symlink farm (`apps/*/node_modules`, `packages/*/node_modules`, root `node_modules`) per the v1.14-era pattern documented in `process/parallel-dispatch-needs-per-worker-worktree-and-node-modules-symlink.md`.

2. **Each worker file's `**Repo**:` field** points at its own per-worker path:
   - R-01: `**Repo**: <repo-root>/.worktrees/<taskspec-id>-R-01`
   - R-02: `**Repo**: <repo-root>/.worktrees/<taskspec-id>-R-02`
   - BATCH-1-GATE: `**Repo**: <repo-root>/.worktrees/<taskspec-id>-integration`
   - V-01: `**Repo**: <repo-root>/.worktrees/<taskspec-id>-integration`
   - INTEGRATE: `**Repo**: <repo-root>/.worktrees/<taskspec-id>-integration`
   - POST-FLIGHT: `**Repo**: <repo-root>` (primary checkout, as in v1.15.0 — POST-FLIGHT tears down every other worktree)

3. **§3.5c step adjusts:** the worker no longer enters a shared worktree and asserts `git status --short` is empty — that gate was the v1.15.0 serial-mode guard. Under `--parallel`, the worker enters its own per-worker worktree (which is dedicated to it by construction and CANNOT have WIP from another worker). The clean-tree assertion is REPLACED by: "If `git status --short` is non-empty in your own worktree, you re-entered your own session after a crash; recover or escalate."

4. **§3.5b branch creation simplifies:** the per-worker worktree is already on a dedicated branch when PRE-FLIGHT.W creates it (`git worktree add ... -b <taskspec-id>/<WORKER_ID>`). The worker only verifies `git branch --show-current` matches its expected branch; no `checkout -b` needed.

5. **BATCH-N-GATE / INTEGRATE merge semantics:** these rows operate in the **integration worktree**. They `git fetch origin <PR-base-branch>`, then `git merge <taskspec-id>/<WORKER_ID>` for every Phase-N worker, resolve conflicts, push, and (INTEGRATE) open the umbrella PR. The per-worker worktrees stay in place during integration; POST-FLIGHT removes them.

6. **POST-FLIGHT.W variant:** sub-task §POST-FLIGHT.2 enumerates every worktree and removes them sequentially:
   ```bash
   for wt_path in $(git -C <repo-root> worktree list --porcelain | awk '/^worktree.*\.worktrees\/<taskspec-id>(-.*)?/{print $2}'); do
     git -C <repo-root> worktree remove "$wt_path"
   done
   ```
   The clean-tree assertion runs for every worktree before removal; if any has uncommitted state, POST-FLIGHT stops with `⛔ BLOCKED` and does not force.

7. **Per-worker worktree teardown ordering invariant:** `INTEGRATE` must report `complete` AND the umbrella PR must be merged AND `gh pr view <pr> --json state` must report `MERGED` before POST-FLIGHT may remove any of the per-worker worktrees. If a per-worker branch's commits are not yet contained in `origin/<PR-base-branch>` (verify with `git merge-base --is-ancestor <taskspec-id>/<WORKER_ID> origin/<PR-base-branch>`), POST-FLIGHT stops — the per-worker worktree is the only record of unmerged work and removing it would lose state.

8. **Multi-repo composability:** for multi-repo TaskSpecs (Repo Map present), apply the per-worker worktree scheme **per repo per worker** — `R-01` on the BFF repo gets `<bff-repo>/.worktrees/<taskspec-id>-R-01`; `R-01` on the client repo gets `<client-repo>/.worktrees/<taskspec-id>-R-01`. Disk cost scales as (repos × workers); be intentional.

**Dispatch-time enforcement (handled by `/dispatch`, not `/taskspec`):** `/dispatch` parses every worker file's `**Repo**:` field at launch time and compares against the configured `parallel_dispatch.max_concurrency`:
- max_concurrency=1 → any topology accepted (shared is cheaper; per-worker is wasteful but safe).
- max_concurrency>1 AND all worker `**Repo**:` paths identical → REFUSE TO LAUNCH with the diagnostic "shared-worktree TaskSpec dispatched with parallel mode — re-generate with `--parallel` or drop the parallel flags."
- max_concurrency>1 AND `**Repo**:` paths are per-worker distinct → accept and launch.

**Validation (post-generation):** when `--parallel` is active, the generator MUST verify:
- Every implementation worker (`R-*`, `N-*`, `D-*`) has `**Repo**: <repo-root>/.worktrees/<taskspec-id>-<WORKER_ID>` matching that worker's ID exactly, **on its own bullet line** and with the path in backticks — verified by running meridian's own `REPO_FIELD_PATTERN` against the emitted card, not by substring-matching `Repo` (see the Header-Field Wire Format callout).
- No two rows that can be concurrently dependency-eligible resolve to the same spawn dir. The integration worktree and the primary checkout are the only legitimate shared dirs.
- BATCH-N-GATE, V-*, and INTEGRATE workers have `**Repo**: <repo-root>/.worktrees/<taskspec-id>-integration`.
- POST-FLIGHT has `**Repo**: <repo-root>` (primary checkout).
- PRE-FLIGHT.W sub-tasks include the N+1 `git worktree add` commands plus the node_modules symlink loop per worktree.
- POST-FLIGHT.2 enumerates worktrees rather than hardcoding a single path.
- The `**Branch**:` field of each implementation worker is still `<taskspec-id>/<WORKER_ID>` (unchanged from v1.15.0).

### Using `--parallel` with other flags

`--parallel` is orthogonal to `--append`, `--assign-codex`, and `--meridian` and composes with each:

- **`--parallel --meridian`**: typical pairing. Per-worker worktrees plus the meridian reply protocol. Most rounds that use `codex-para` for dispatch should be generated with this combination.
- **`--parallel --assign-codex`**: per-worker worktrees plus Codex tier assignment. Same as above without the meridian-specific reply contract (use this only if NOT going through meridian-roles, which is rare).
- **`--parallel --append <path>`**: appends new workers using per-worker worktree topology. **Existing workers' `**Repo**:` fields are NOT rewritten**; if the existing TaskSpec is shared-worktree, the appended workers form a mixed-topology TaskSpec — the generator MUST surface this as a `⚠️ Mixed worktree topology` warning, because `/dispatch`'s sanity check will refuse parallel launch on mixed topology. Resolution: either regenerate the full TaskSpec with `--parallel`, or downgrade dispatch to serial.

---

## Upstream contract

This skill's primary input is a **fix PRD** produced by the **fix** skill (`/Users/yzliu/work/skills/fix`). The fix PRD is located in the **external Docs directory**:

```
<Docs root>/branch/<branch_name>/prd/<YYYY-MM-DD>-<feature>-fix-prd.md   # canonical (under round directory's prd/ sub-folder)
# or, legacy / hand-written / non-pipeline PRDs:
<Docs root>/branch/<branch_name>/fix_prd_<version>.md
```

> **Note:** The Docs root is the project's external Docs directory (e.g., `/Users/yzliu/work/Docs/Projects/clawso`), NOT a path inside the project repo. The actual PRD location is confirmed during the Path Validation Gate (Step 0). Always use the absolute path confirmed during path validation.

The fix PRD provides:

- **§0 Traceability & Disposition** — every test finding ID with a disposition (almost all `Fix — this round`).
- **§P Process Fixes** — actionable workflow/gate changes that this TaskSpec must enforce (e.g. new PRE-FLIGHT checks, runtime validation gates, acceptance criteria requirements).
- **§3 Issue Breakdown** — per-issue root cause and recommended solution.
- **§9 Validation Plan** — issue-to-validation mapping that workers must satisfy.

**§P is binding:** Every §P item from the fix PRD must be reflected as a gate, acceptance criterion, or PRE-FLIGHT sub-task in the generated TaskSpec. Do not silently drop process fixes.

## ⚠️ MANDATORY PRE-GENERATION GATE: Path Validation

**Before generating any artifact**, verify every file path referenced in the project. This is non-negotiable.

**Output location rule (v1.19.0 four-folder layout):** Generated TaskSpec artifacts must live in the external Docs workspace under `./Docs/<project>/branch/<taskspec-id>/taskspec/` — that is, the `taskspec/` sub-folder of the round directory `branch/<taskspec-id>/`. Writing them under the project repository (including `<repo-root>/Docs/...`) is invalid; writing them at the round-directory root (e.g. `branch/<taskspec-id>/dispatch_plan.md` directly, without the `taskspec/` segment) is the **old flat layout** and is also invalid for fresh generation under v1.19.0.

The round directory `branch/<taskspec-id>/` contains four canonical sub-folders — `prd/`, `investigate/`, `taskspec/`, `test/` — each owned by a different stage of the pipeline. Materialize the `taskspec/` and `test/` sub-folders during generation; respect (do not touch) existing `prd/` and `investigate/` sub-folders.

### Required information to collect upfront

Ask the user for ALL of the following if not already provided:

| Item | What to ask |
|------|-------------|
| **Repo root** | Absolute path to the project repository (e.g. `/Users/yzliu/work/projects/clawso`) |
| **Docs root** | Absolute path to the project's Docs directory (e.g. `/Users/yzliu/work/Docs/clawso`). All generated TaskSpec artifacts must live under `<Docs root>/branch/<taskspec-id>/taskspec/` — outside the repo, and inside the `taskspec/` sub-folder of the round directory. Never generate them directly inside the project repository and never at the round-directory root. |
| **System overview path** | Path to the system indexed overview directory (default: `<Docs root>/system`). Must contain `SYSTEM_INDEX.md`. |
| **TaskSpec ID** | Identifier for this round (e.g. `v2.4`, `category-workbench-2026-05-26`). Used as the round-directory name under `<Docs root>/branch/` and as branch prefix (`<taskspec-id>/<WORKER_ID>`). |
| **Project name** | Short slug used in the test guide filename (e.g. `mumu`, `clawso`). Defaults to the trailing path component of `<Docs root>` if not specified. |
| **Branch feature label** | Short slug used in the test guide filename (e.g. `merge-deploy`, `category-workbench`). Defaults to a slugified TaskSpec ID minus any trailing date. |
| **Test guide language** | Default `zh` (Chinese). Override to `en` only on explicit user request. |
| **PRD / input document paths** | Absolute path for every source document referenced in sub-tasks. PRDs under the round's `prd/` sub-folder are preferred when present, but any absolute path is accepted. |
| **Frontend Visual Canon paths** | Required when the round touches frontend / UI / UX / page / component / dashboard / editor / workstation / layout / visual design. Ask for absolute paths to screenshots, mockups, reference images, sample HTML/CSS pages, design-system examples, Figma exports, or a PRD section containing an explicit visual spec. If missing, stop and ask the PRD owner to provide or amend the PRD before TaskSpec generation. |
| **PR base branch** | Existing branch workers PR into (usually `main`). It must already exist locally or on `origin`. For multi-repo rounds, collect one existing base branch per repo instead of inventing a shared name. |
| **Environment file location** | Path to `.env.local` or equivalent (e.g. `<repo-root>/.env.local`) |
| **Environment variable names** | Exact variable names used in the repo (never assume `DATABASE_URL` exists) |

### Derived paths (do not ask — computed from above)

| Artifact | Derived Path |
|----------|-------------|
| Round directory (shared root, contains 4 sub-folders) | `<Docs root>/branch/<taskspec-id>/` |
| PRD sub-folder (owned by `/brainstorming`; read-only for this skill) | `<Docs root>/branch/<taskspec-id>/prd/` |
| Investigation sub-folder (owned by `/investigate`; read-only for this skill) | `<Docs root>/branch/<taskspec-id>/investigate/` |
| **TaskSpec directory** (this skill's artifacts live here) | `<Docs root>/branch/<taskspec-id>/taskspec/` |
| Dispatch plan | `<Docs root>/branch/<taskspec-id>/taskspec/dispatch_plan.md` |
| Dispatch command | `<Docs root>/branch/<taskspec-id>/taskspec/dispatch_command.md` |
| Worker files | `<Docs root>/branch/<taskspec-id>/taskspec/<WORKER_ID>.md` |
| Index | `<Docs root>/branch/<taskspec-id>/taskspec/index.md` |
| PM Playbook | `<Docs root>/branch/<taskspec-id>/taskspec/pm_playbook.md` |
| Completion reports | `<Docs root>/branch/<taskspec-id>/taskspec/reports/<WORKER_ID>.md` |
| **Test sub-folder** (this skill seeds the test guide; humans add reports) | `<Docs root>/branch/<taskspec-id>/test/` |
| **Test guide** (mandatory, Chinese by default) | `<Docs root>/branch/<taskspec-id>/test/<YYYY-MM-DD>-<project>-<branch-feature>-test-guide.md` |
| System overview | `<Docs root>/system/` |

### Base Branch Existence Gate

Before generating any artifact, verify every configured base branch already exists.

- Single-repo round: verify the one configured `PR base branch`
- Multi-repo round: verify the base branch for each repo in scope
- A base branch may exist locally, on `origin`, or both
- A worker may create a local tracking branch from an existing `origin/<base-branch>` if needed
- A worker must **never** create a brand-new base branch as part of dispatch

If a proposed base branch does not exist locally or on `origin`, stop and ask the user. Do not generate a TaskSpec that names it as a base branch.

Recommended verification commands:

```bash
git -C <repo-root> rev-parse --verify <base-branch>
git -C <repo-root> rev-parse --verify origin/<base-branch>
```

At least one of those checks must succeed for every configured base branch.

### Hard block rule

If ANY path is unclear, ambiguous, assumed, or relative without a known root:

> **STOP. Do not generate any artifact. Ask the user immediately.**

If ANY configured base branch does not already exist locally or on `origin`:

> **STOP. Do not generate any artifact. Ask the user whether to create the branch manually or switch the TaskSpec to an existing base branch.**

If the round touches frontend / UI / UX / page / component / dashboard / editor / workstation / layout / visual design and no Visual Canon is provided by the PRD or as an explicit absolute-path input:

> **STOP. Do not generate any artifact. Ask the PRD owner to add reference screenshots/mockups/sample HTML/design-system examples or an explicit visual spec to the PRD.**

Example blocking question:
> "Before I generate the TaskSpec, I need to confirm some file paths. Please provide:
> 1. The absolute repo root path
> 2. The target directory for TaskSpec output
> 3. The absolute path to each PRD document referenced
> 4. For frontend/UI work: absolute Visual Canon path(s) or the PRD section containing the visual spec
> 5. The existing base branch name for each repo involved
> I cannot generate accurate dispatch commands with relative or assumed paths."

**Relative paths are forbidden in the generated artifacts.** Use the confirmed absolute Docs path for TaskSpec outputs and the confirmed absolute repo root for source-code paths.

---

## Output Structure Overview

> **Layout note (v1.19.0):** The TaskSpec skill writes everything under `branch/<taskspec-id>/taskspec/` — the `taskspec/` sub-folder of the round directory. The round directory also hosts `prd/`, `investigate/`, and `test/` siblings owned by other stages of the pipeline. All artifact paths below are relative to `<Docs root>/`.

### Artifact 1: TaskSpec directory (`branch/<taskspec-id>/taskspec/`)

A directory of markdown files. Workers read only their own file; the index provides the full picture for PM and human reviewers.

- **`index.md`** — document header, conflict resolution rule, PM blocker resolutions, compact dispatch table, cross-worker integration points, runtime contracts, worker file manifest
- **`<WORKER_ID>.md`** — one file per worker containing full worker definition, sub-tasks, tests, acceptance criteria, a binding `#### Visual Canon` section for UI-facing workers (see Step 0.2 / Step 2.3), a one-line `#### Applicable Laws` pointer to the worker's Context Capsule (the binding law set itself lives in `context/<WORKER_ID>-context.md` — see Step 2.8.5), **and a pre-curated `#### Referenced Learnings` subset** (resolved once at generation from `/Users/yzliu/work/Docs/Projects/<project>/learnings/` — see Step 2.7)

Contents covered by the index:
1. **Document header** — title, version note, date, input documents list
2. **Conflict resolution rule** — PRD authority declaration (verbatim block)
3. **PM Blocker Resolutions** — any pre-resolved decisions that affect implementation
4. **Dispatch Table** — compact view of all Workers, batches, and dependencies
5. **Cross-Worker Integration Points** — producer/consumer contract table
6. **Runtime Contracts** — shared interfaces and validation rules workers must honor

### Artifact 2: Dispatch Plan (`dispatch_plan.md`)

1. **PRD Reference Paths** — table mapping every shorthand label used in "PRDs to Attach" column to its absolute file path (e.g. `Pipeline PRD` → `/abs/path/to/CLAWSO_MCP_Worker_Deploy_Pipeline_PRD_MVP_v1_0.md`). This is the single source of truth for workers to locate PRD documents.
2. **Model Assignment Legend** — which model handles which task types
3. **Master Dispatch Table** — status + batch + worker + task + model + depends on + TaskSpec file + PRDs to attach + PR (URL + merge status) + notes
4. **Batch Execution Details** — per-batch: workers, priority, model assignments, worker notes, completion gate
5. **PM Flags Summary** — table of all flags raised and their resolutions
6. **Completion Tracking** — table tracking batch start/end dates and report file paths

### Artifact 3: Dispatch Command (`agent_dispatch_command.md`)

**The single entry point every worker session receives** — for manual dispatch (you hand the worker this file) and for meridian alike (`command_file_path`; the Hub wrapper emits `Read and follow this file for your worker: <path>`). As of v1.31.0 its **body is a router, not the instruction set**: a role table pointing each role at `dispatch/<role>.md`, followed by the PM-side complete reference. A worker handed this file reads the role table, then loads only its own role file + its card + its capsule (Step 6.6.4).

⛔ **It must stay worker-readable.** Do NOT degrade it into a "NOT FOR WORKERS" stub — that breaks manual dispatch and leaves meridian's wrapper pointing at a file that refuses its own reader. PM-only material goes *below* the role table, not in place of it.

⭐ **Keep one report-path declaration in this file** (v1.32.0), verbatim shape:

```
Write report to: `reports/<WORKER_ID>.md`
```

Some orchestrators derive a row's `expected_outputs` by regexing **this file** for that phrase; when it is absent they fall back to a directory convention that only resolves if `taskspec/reports/` already exists. Keeping the one-line declaration makes the derivation direct instead of conditional. It is a path fact, not a duplicated rule, so it does not trip Context Gate 3 — the full Completion Protocol still lives only in `dispatch/worker.md`.

Each command invocation may claim **exactly one** eligible row. After that row is completed, blocked, or paused, the worker session stops and waits for a new explicit dispatch command in a **new** session. The session cannot be reused for a second row, even if the next row is eligible for the same model. Contains:
1. **Round context note** — pointer to parent TaskSpec directory
2. **Environment Configuration** — exact env vars, DB validation commands, no-Docker rules
3. **Worker Identity Declaration** — how the worker determines its model code
4. **PM Playbook Bootstrap** — read `pm_playbook.md` §3 (Applied Principles) and pre-load any rule whose Scope includes the about-to-be-claimed worker
5. **Step 1–5** — read plan → dependency check → self-check → **claim stamp + branch creation** → read worker file → execute → self-validate → commit/push → open PR → merge PR → resync local base branch → mark `✅` → report → stop
6. **Status Legend** — ⬜ / 🔄 / ✅ / ⛔

### Artifact 4: PM Playbook (`pm_playbook.md`)

The human/PM-controlled input lane that lives alongside the dispatch artifacts. Generated as a scaffold (empty tables + instructions) by the skill; then **edited only by PM/human operators** during the round. Workers must NOT mutate this file — they READ from it and may file new entries as Open Questions (§4) when they encounter unresolved blockers.

Sections:
1. **§1 Blocker Resolutions Library** — keyword-indexed table mapping blocker symptoms to PM-approved resolutions (e.g. "RLS denied on `clients.insert` → use service-role key from `$SUPABASE_SERVICE_KEY`, do NOT downgrade the policy"). Workers consult this BEFORE marking any row `⛔ BLOCKED`.
2. **§2 Failure Recovery Patterns** — recipes for known failure classes detected during execution (e.g. "duplicate-key on migration replay → run `npm run db:remote:apply --force-version <N>`; escalate after 2 retries"). Workers consult this when AI Auto-Tests / Behavioral Assertions fail before retrying or escalating.
3. **§3 Applied Principles & Laws** — cross-cutting rules that override defaults for this round, scoped to worker IDs or file globs (e.g. "All Supabase writes must go through RPC, never direct table writes; scope: R-*, N-*"). Dispatcher pre-loads in-scope rules at claim time; workers must apply them throughout execution.
4. **§4 Open Questions (PM TODO)** — pending decisions added by workers when they hit blockers without §1 coverage. Each entry has `⏳ PENDING` status until PM fills in the resolution. Dependent workers cannot proceed.

**Read/write contract:**

| Role | §1 | §2 | §3 | §4 |
|------|----|----|----|----|
| PM / human | RW (authoritative) | RW (authoritative) | RW (authoritative) | RW (resolves entries) |
| Dispatcher | R (consults at claim) | R | R (pre-loads in-scope rules) | R (blocks if dependent question is `⏳ PENDING`) |
| Worker | R (consults before declaring blocker) | R (consults before retry/escalation) | R (applies in-scope rules) | **Append-only**: may add a new `⏳ PENDING` row when it files a blocker question; never edits existing rows |

**Why this exists:** Prior rounds had blockers and recurring failures resolved verbally over chat or via per-worker Notes. That knowledge was lost between sessions and re-discovered repeatedly. The PM Playbook centralizes runtime guidance, gives PM a single editable surface, and forces both dispatcher and worker sessions to look there before re-asking the same question or applying an unsanctioned workaround.

---

## Workflow

### Step 0: Path Validation Gate

Run the pre-generation gate above. Do not proceed until all paths are confirmed.

### Step 0.1: System Overview Confirmation

**Before decomposing work into workers**, the skill must confirm the project's system indexed overview with the user.

1. Read `SYSTEM_INDEX.md` from the system overview path
2. Present a summary to the user:
   - Module list (from the module index table)
   - Key inter-module dependencies (from the dependency graph)
   - Last-updated dates (from `[UPDATED]` / `[ADDED]` tags in modules)
3. **User confirms** the overview is current and accurate
4. If the system overview is stale, incomplete, or missing:
   - Flag the issue to the user
   - Ask: proceed without it (workers will grep the repo — higher token cost) or update the system overview first?

**Why this exists:** The system overview gives the skill and the operator a shared understanding of the project architecture. Without it, worker decomposition relies on the operator's memory and the skill's guesses. With it, the skill can auto-extract codebase pointers (file:line references) for each worker, dramatically reducing token waste during execution.

**If the system overview does not exist:** The skill should note this and proceed without codebase pointers. The `Codebase Pointers` section is omitted from worker definitions. Workers fall back to searching the repo.

### Step 0.2: Frontend Visual Canon Gate (mandatory for UI-facing work)

Run this gate before worker decomposition whenever the input mentions or implies frontend / UI / UX / page / component / dashboard / editor / workstation / layout / visual design, including phrases such as "simplify the interface", "make it like ChatGPT", "match this screenshot", "sample page", "landing page", "tool surface", "panel layout", or "polish".

**Required Visual Canon sources** (at least one must be present, and absolute paths must be recorded):

1. Screenshot / mockup / reference image supplied by the PRD or user.
2. Sample HTML/CSS page(s) that demonstrate the intended layout, density, typography, spacing, color, or interaction.
3. Design-system example page, Figma/exported design artifact, or existing app route that is the binding reference.
4. A precise written visual spec in the PRD that includes density, typography scale, spacing rhythm, layout hierarchy, color/material treatment, interaction states, and negative rules.

**Hard stop:** If the work is UI-facing and none of the above exists, do not generate a TaskSpec. Ask the PRD owner to add a Visual Canon section to the PRD or place the visual/sample HTML artifacts under `branch/<taskspec-id>/prd/` and rerun `/taskspec`. Do not fabricate the canon from adjectives such as "beautiful", "clean", "modern", "simple", "ChatGPT-like", or "professional".

**Canon extraction output:** Before Step 2, write an in-memory summary that every frontend worker and UI V-worker will receive:

- `Visual Canon Sources`: absolute paths or PRD sections.
- `Target visual hierarchy`: what should be visually dominant, secondary, and hidden/quiet.
- `Layout/density rules`: column count, alignment, whitespace, min/max widths, scroll behavior, responsive rules.
- `Typography rules`: approximate scale and hierarchy; explicitly call out text that must not be oversized.
- `Component/chrome rules`: borders, cards, panels, tabs, controls, icon usage, and state styling.
- `Interaction rules`: resize/drag/save/restore behavior, hover/focus states, and animation limits when relevant.
- `Negative Visual Rules`: what the implementation must not render, especially artifacts already rejected by the user.

**Binding rule:** The Visual Canon is part of the PRD authority chain. If a worker cannot satisfy a functional task without violating it, the worker must stop and file a PM Playbook §4 question. The worker must not silently "improve" the design away from the canon.

### Step 0.5: Environment Health Check Gate

**Before any implementation worker runs**, the TaskSpec must include a PRE-FLIGHT worker in Batch 0 that validates the execution environment. This catches pre-existing drift, broken baselines, and environmental assumptions that would block downstream workers mid-execution.

**Generation-time baseline readiness check (mandatory before writing PRE-FLIGHT):**

1. Classify every planned PRE-FLIGHT command as `scoped` or `global`.
   - `scoped`: validates only resources this TaskSpec will touch, such as one migration status check, required env vars, a package-specific typecheck, or a targeted build for changed packages.
   - `global`: validates broad repo health, such as full workspace tests, full workspace lint, boundary lint across unrelated packages, full monorepo build, or contract parity checks outside the worker scope.
2. If any `global` gate is planned, prove the current base is already green before generating the feature TaskSpec. Acceptable proof is either:
   - a fresh run of the exact planned global commands during generation, or
   - a recent baseline report in the round docs that lists the exact commands, commit/base branch, timestamp, and passing results.
3. If the global baseline is red or unknown, STOP. Do not emit a feature TaskSpec with strict global PRE-FLIGHT. Generate or recommend a dedicated `baseline-cleanup` TaskSpec first, then resume the feature TaskSpec after the baseline is green.
4. If the user explicitly chooses a scoped or audit-only feature round despite a red global baseline, document that choice in `index.md` under `## Baseline Readiness`, list the omitted global gates, and ensure PRE-FLIGHT blocks only on scoped checks. Do not encode "known failures are OK" inside a strict PRE-FLIGHT worker.

The PRE-FLIGHT worker is **mandatory** whenever the TaskSpec touches any of the following:
- Database migrations (check `pendingLocal`, `remoteOnly`, schema drift)
- Build artifacts (check that the project compiles / builds cleanly on the branch)
- External service configuration (check that required secrets/env vars are accessible)
- Deployment targets (check that target environments are reachable)

If a blocking PRE-FLIGHT check fails, the entire dispatch halts at Batch 0 with a `⛔ BLOCKED` status and a report describing what needs manual repair before workers can proceed. Audit-only checks may record failures without halting, but only when Step 0.5 explicitly selected audit-only mode and `index.md` documents the omitted strict gate. This prevents workers from encountering environment issues mid-execution where they lack the authority or context to fix them safely.

PRE-FLIGHT lives in its own file (`branch/<taskspec-id>/taskspec/PRE-FLIGHT.md`) and gets its own branch (`<taskspec-id>/PRE-FLIGHT`), following the per-worker file + branch model described in the output structure above.

See the **Pre-flight Worker Template** section below for the required format.

### Step 0.5b: Baseline Cleanup TaskSpec Pattern

Use this pattern when Step 0.5 finds that a feature TaskSpec would need strict global gates but the base branch is red or unproven.

**Trigger:** any planned strict PRE-FLIGHT includes global gates and generation-time proof is failing, stale, or absent.

**TaskSpec shape:**
- Name the round with a clear `baseline-cleanup` slug, e.g. `<project>-baseline-cleanup-<YYYY-MM-DD>`.
- Scope it only to making the declared global gates pass on the base branch. Do not mix feature work into this round.
- Put the failing commands and their current failure summaries in `index.md` under `## Baseline Readiness`.
- Decompose workers by root-cause cluster, not by failing command line. Example clusters: stale fixtures, TypeScript loader/config drift, worker health timeouts, contract parity drift, lint boundary violations.
- Add a final `INTEGRATE` or validation row that reruns the complete global gate set and records exact passing output paths.

**Exit condition:** the cleanup TaskSpec is complete only when the exact global commands that the later feature PRE-FLIGHT needs are green on the intended base branch. The follow-on feature TaskSpec must cite that cleanup report in `## Baseline Readiness`.

### Step 0.6: Cross-Spec Coordination Preflight (mandatory)

> **Why this exists (2026-05-14 audit retrospective):** A skills-discovery TaskSpec generated migration `069` without seeing that a sibling ranked-search TaskSpec on the same base branch had already claimed `069` via a v1.1 append. The collision is invisible to per-spec generation but guaranteed at PR rebase. Same class of bug for api-contracts edits and any shared file. The fix is a pre-generation scan of sibling TaskSpecs targeting the same base branch.

Before assigning migration numbers, declaring file edits, or naming new exports in shared packages, the skill MUST scan sibling TaskSpec directories that target the same base branch (`feat/...`, `main`, `develop`, etc.) and reconcile claimed resources.

**Scope of the scan** (auto-derived from `Repo root` + `Docs root` collected in Step 0):

```bash
docs_project_root="$(dirname "$(dirname "<taskspec-output-dir>")")"   # e.g. /Users/yzliu/work/Docs/Projects/clawso/clawso-client-app-v3
# Find every sibling taskspec directory under the same project
find "$docs_project_root" -mindepth 2 -maxdepth 3 -type d -name taskspec -not -path "*<this-taskspec-id>*"
```

For each sibling `taskspec/` found, check three resource classes:

| Class | What to scan for | Mitigation if claimed |
|-------|------------------|-----------------------|
| **Migration numbers** | `grep -rhE '(supabase/migrations/\|migration\s+)[0-9]{3}_' <sibling>/*.md` | Pick the next free number AFTER the highest sibling claim, even if local repo's `supabase/migrations/` doesn't yet show it (sibling PR may not have merged). Document the cession in the worker file's title note. |
| **Shared package edits** | grep sibling worker files for the file paths this TaskSpec plans to edit (e.g. `packages/api-contracts/src/skills.ts`, `src/bff/skills.mjs`) | Generate a `W-NN.0` pre-edit grep sub-task that surfaces sibling-introduced symbols before authoring overlapping exports. |
| **PR base branch + integration branch** | grep sibling `index.md` / `dispatch_plan.md` for `Integration branch` / `PR base branch` | If a sibling's integration branch sits on the same base, note the rebase dependency in this TaskSpec's POST-FLIGHT (or PM Playbook §1). |

**Output of this step**: a `## Cross-Spec Coordination` section in `index.md` (under the dispatch table) listing each sibling TaskSpec scanned, what was claimed, and how this spec coexists. If zero siblings found, state `## Cross-Spec Coordination: none — no sibling TaskSpecs on this base branch.`

**Hard rule:** if a migration number, an api-contracts export name, or any other unique resource is double-claimed and the skill cannot pick a deterministic mitigation (e.g. both specs need the *same* exact symbol name), the generation MUST halt and ask HUMAN — do not pick one silently.

### Step 0.7: Credentials & Authority Inventory Gate (mandatory)

> **Why this exists:** Workers stalling mid-flight because they hit a 401, a missing env var, or an unknown KV namespace ID is the #1 cause of `outcome: needs_pm` escalations. The skill must surface the full credential/authority surface BEFORE finalizing the TaskSpec — the agent fetches what it can, validates each one, and bakes the result into the worker context. Anything that cannot be fetched or validated gets escalated to HUMAN before the TaskSpec ships, not after PRE-FLIGHT.W blocks on it.

**When to run:** always. The gate is short-circuit if the TaskSpec touches none of: DB writes, Cloudflare bindings, OAuth providers, GitHub tokens, deploy keys, signing keys, container registries, external SaaS APIs.

**Step 0.7.1 — Build the authority inventory**

Walk every planned worker and collect what authority/credential it will need. Common classes:

| Class | Examples | Where it lives |
|-------|----------|----------------|
| Service-role keys | `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` | `.env.local` in repo root |
| OAuth client secrets | `GITHUB_*`, `GOOGLE_*` | Wrangler / Pages env, or 1Password |
| Cloudflare API tokens | `CLOUDFLARE_API_TOKEN` (with scopes: Pages, Workers KV, R2, Analytics Read) | `~/.cloudflare/...` or env |
| Wrangler bindings | KV namespace IDs, R2 bucket names, AE binding name + dataset | `wrangler kv namespace list`, `wrangler r2 bucket list`, dashboard |
| Cron-call internal tokens | `SKILLS_INGEST_TOKEN`, `BEHAVIOR_AGGREGATOR_TOKEN` | Pages env (set by previous worker or human) |
| Signing keys | Tauri updater key, code-signing cert | `~/.tauri/`, Apple Developer keychain |
| Repo write access | Bot account credentials | Per-repo Settings → Collaborators |

**Step 0.7.2 — Fetch + validate (the SKILL itself runs these, not workers)**

For every entry in the inventory, the skill (or its sub-agents) runs the cheapest validating probe and records the result in a **Credentials Validation Table** (saved to `<taskspec-dir>/credentials_inventory.md`):

| Class | Validating probe (run by the skill) |
|-------|--------------------------------------|
| Supabase service-role key | `curl -s -H "apikey: $KEY" -H "Authorization: Bearer $KEY" "$URL/rest/v1/" -o /dev/null -w "%{http_code}"` → 200 |
| Cloudflare API token | `curl -s -H "Authorization: Bearer $TOKEN" https://api.cloudflare.com/client/v4/user/tokens/verify` → `success:true` AND list of scopes |
| `wrangler kv namespace list` | parses JSON; matches expected bindings; captures IDs |
| `wrangler r2 bucket list` | enumerates buckets; matches expected names |
| GitHub PAT / `gh auth status` | `gh auth status --hostname github.com` → `Logged in` AND required scopes |
| OAuth client secret | introspection endpoint if available, else mark "format-only check passed" |

Each validation result is one of:

- **`✅ valid`** — probe returned the expected shape; capture the captured values (KV IDs, bucket names) into the inventory file.
- **`⚠️ stale-or-scoped`** — credential exists but missing a required scope (e.g. CF token without `Account Analytics Read`). Skill auto-adds a corresponding §1 Blocker Resolution to pm_playbook AND a worker context note pointing at the missing scope.
- **`❌ missing`** — credential isn't accessible to the skill. Skill MUST ask HUMAN (see Step 0.7.4).

**Step 0.7.3 — Bake into worker context**

For every worker whose inventory row depends on a credential:

1. Append the **literal validated values** (not env var names alone — also the captured KV/R2 IDs, dataset names, scope list, etc.) into the worker's `#### Codebase Pointers` or a new `#### Required Authority Context` section.
2. Reference the credential by env-var name in code blocks, but also list the captured runtime values in the human-readable context so a worker that lost env can re-derive.
3. Never inline secret values themselves — store only the IDs/names/scopes. Secrets stay in env. The skill MUST refuse to write a secret string to any worker file.

**Step 0.7.4 — Missing/unfetchable → HUMAN gate**

If ANY inventory row resolves to `❌ missing`, the skill MUST NOT finalize the TaskSpec. Instead:

1. Write `<taskspec-dir>/credentials_inventory.md` with the partial table.
2. Print to the operator:
   ```
   ⛔ TaskSpec finalization blocked — credentials/authority gate failed.
   Missing/unfetchable:
     - <CLASS>: <env-var-or-resource> — probe error: <details>
     - ...
   Resolve these (set env, rotate token, create resource) and re-run /taskspec.
   ```
3. Exit without writing `index.md`, `dispatch_plan.md`, `dispatch_command.md`, or worker files. The skill is allowed to leave PRE-FLIGHT.md if already written, but the round is NOT dispatch-ready.

This is the same hard-block contract as the Path Validation Gate (§ "MANDATORY PRE-GENERATION GATE: Path Validation" above). HUMAN intervention is required before a partial-credential TaskSpec ever reaches a worker.

### Step 0.7a: Credential Source-of-Truth + Internal/External Lane Split (mandatory)

> **Why this exists:** §0.7 only catches credentials whose env-var names you already enumerated. The clawso `bff-marketplace-publisher-2026-06-01` round (BATCH-2-GATE `⛔ BLOCKED`, dispatcher `agent-dispatcher-21439517`, 2026-06-01) shipped a TaskSpec that introduced a *new* auth surface — `marketplace_publishers.api_token_hash` — via N-02's migration, then required `BOOTSTRAP_PUBLISHER_TOKEN` Bearer auth in BATCH-2-GATE.3's live E2E. PRE-FLIGHT never probed the new var; `credentials_inventory.md` never listed it; `pm_playbook.md` §1 had no rule. The worker hit a 401, escalated `needs_pm`, PM-resolver `escalate_human` → ⛔ BLOCKED for hours until an operator hand-seeded the credential. §0.7a closes that gap by making `cre/` the canonical source-of-truth and forcing every new auth surface into one of two pre-authorized lanes.

#### A. `cre/` is the single canonical credentials source

Every clawso (and any project that follows this convention) repo has a gitignored credentials directory at `/Users/yzliu/work/Docs/Projects/<project>/cre/`. The TaskSpec generator MUST:

1. **Read `cre/` first.** Before running the §0.7 transitive scan, enumerate every file in `<project>/cre/` and every `KEY = VALUE` row inside `clawso-deploy-preview.txt` / `clawso-deploy-preview.md` / `clawso-deploy-prd.txt` (or whatever the project's per-env deploy docs are named). Build an in-memory canon of `{env_name: credential_present_in_env}` keyed by `(env, var_name)`.
2. **Resolve § 0.7 references against the canon.** Every `$VAR` / `Authorization: Bearer …` / `apikey:` / Wrangler-binding reference scanned out of worker and gate `.md` files must hit the canon. Misses are NOT silently dropped — they become §0.7a candidates (see §B below).
3. **Refuse to inline secret values into TaskSpec artifacts.** §0.7 already forbids this; §0.7a strengthens it to: TaskSpec artifacts may reference the *path* to a `cre/` file or the *env var name*, never the secret string. The deploy docs in `cre/` are the only place plaintext lives.

#### B. Two lanes for every credential the round consumes

Classify each credential the round needs into exactly one lane. The TaskSpec generator MUST do this classification before §0.7's "exit if missing" gate fires, so the right blocker (worker SEED row vs HUMAN row) is emitted.

| Lane | Definition | Naming heuristic | Round-time behavior |
|------|------------|------------------|---------------------|
| **internal-service-token** | Random secret used only for service-to-service auth INSIDE this project's blast radius. The hash (or the secret itself) lives in a DB column / Worker secret / Pages env this round controls. No external issuer. | `*_PUBLISHER_TOKEN`, `*_INTERNAL_TOKEN`, `*_CRON_TOKEN`, `*_AGGREGATOR_TOKEN`, `*_INTAKE_TOKEN`, `*_BOOTSTRAP_KEY`, `INTERNAL_TOKEN`, `ADMIN_TOKEN` | Auto-seedable — emit a `SEED-<name>` row (see §C) immediately after the worker that introduces the storage surface, before any consumer. |
| **external-issued** | Credential minted by an external authority the round cannot script: Apple AuthKey, Google OAuth `client_secret`, Cloudflare API token, Supabase access token, npm OTP / recovery codes, payment provider keys, Resend API key, third-party webhooks. | `APPLE_*`, `GOOGLE_*`, `*_API_KEY`, `*_CLIENT_SECRET`, `CLOUDFLARE_API_TOKEN`, `SUPABASE_ACCESS_TOKEN`, `RESEND_API_KEY`, `ALIYUN_*`, `PAYMENT_*` | NOT auto-seedable. If missing from `cre/`, emit a `⏸ HUMAN` row at the top of Batch 0 (above PRE-FLIGHT) with the exact console URL, scope list, and the deploy-doc anchor the operator must paste the resulting value into. The round does NOT dispatch until that row is resolved. |

Add the classified list to `credentials_inventory.md` under explicit headings:

```markdown
## Internal-service-token credentials (auto-seedable)

| Var | Env(s) | Storage surface | Seed row | cre/ path |
|-----|--------|-----------------|----------|-----------|
| BOOTSTRAP_PUBLISHER_TOKEN | preview, prod | marketplace_publishers.api_token_hash WHERE org_slug='thu-maic' | SEED-bootstrap-publisher-token | cre/bootstrap-publisher-token-{preview,prod}.txt |

## External-issued credentials (operator-only)

| Var | Env(s) | Issuer | Operator action | cre/ path |
|-----|--------|--------|-----------------|-----------|
| APPLE_API_KEY | shared | Apple Developer | Paste from App Store Connect → Users and Access → Keys | cre/ApiKey_*.p8 |
```

#### C. The `SEED-<name>` row template

For every `internal-service-token` lane entry, emit a dedicated `SEED-<name>` row in the Master Dispatch Table. Topology: positioned **after** the row that introduces the storage surface (typically the migration worker that adds the `*_hash` column or the Worker that creates the KV/Pages env binding) and **before** any consumer row. It runs at model tier T1 with the standard worker reply protocol; outcome is `complete` once the credential exists in both `cre/` and the storage surface.

Template body (copy into `branch/<taskspec-id>/taskspec/SEED-<name>.md`):

```markdown
# SEED-<name> — Internal-service-token Seeding

- **Runtime**: agent (Local — bash + REST/Supabase write)
- **Delta Type**: SEED
- **Phase**: <one-after-the-introducing-worker>
- **Priority**: P0
- **Depends on**: <introducing-worker-id>
- **Branch**: <taskspec-id>/SEED-<name>
- **Repo**: <integration-worktree-path>
- **Model Routing Rationale**: T1 everyday secret-seeding workflow with explicit mutation checks; use the configured T1 provider profile
- **Internal Delegation**: forbidden
- **Authorized lane**: internal-service-token (pm_playbook.md §1.<n>)

#### Acceptance Criteria (idempotent)

For EACH target env in scope (`preview` and `prod` unless the round is scoped to one):
1. If `cre/<token-file>-<env>.txt` exists AND `sha256(cat …) == <storage-surface>.<hash-column>` for that env → SKIP.
2. Else:
   - `openssl rand -hex 32` → plaintext
   - Compute `sha256` of plaintext
   - `printf '%s\n' "$plaintext" > <project>/cre/<token-file>-<env>.txt && chmod 600 …`
   - Write hash into the storage surface (Supabase PATCH / `wrangler secret put` / KV put — env-specific)
   - Append a labeled block to `<project>/cre/clawso-deploy-<env>.txt` (and `.md` if it exists) with: owner row, plaintext path, hash, apply command, `<VAR> = <value>` line
3. Re-probe the storage surface and verify the hash matches.

#### Reply Protocol

Emit `<<<MERIDIAN-STATUS>>>` with `outcome: complete` ONLY if every env in scope was either skipped (already correct) or successfully seeded AND verified. On any env failure: `outcome: failed` with `error:` naming the env and the failing step.

#### Why this is a SEED row, not part of the introducing migration

Splitting keeps the schema-change worker pure DDL (idempotent, reversible) and isolates credential mutation to a dedicated row that pm_playbook.md authorizes by name. This satisfies `lifecycle/state-mutating-recovery-must-gate-on-non-mutating-probe.md`: the schema worker probes non-mutatingly, the SEED row mutates with explicit prior authorization.
```

#### D. PM playbook entries — pre-authorize the lanes

`pm_playbook.md §1` (Blocker Resolutions Library) gets two standing entries the generator emits unconditionally:

```markdown
### §1.<n>: internal-service-token lane — auto-seed authorization

Workers labeled `SEED-<name>` are pre-authorized to:
- Generate `openssl rand -hex 32` plaintext tokens
- Write plaintext to `<project>/cre/<file>-{env}.txt` (mode 0600)
- Write the corresponding hash into the named storage surface (DB column, Worker secret, Pages env)
- Append the labeled block to `cre/clawso-deploy-<env>.{txt,md}`

This is the only context in which a worker may create credential state without operator confirmation. Outside SEED rows, the `state-mutating-recovery-must-gate-on-non-mutating-probe.md` law applies in full.

### §1.<n+1>: external-issued lane — HUMAN required

Credentials matching the external-issued heuristic in `credentials_inventory.md` MUST be operator-provisioned. Workers that detect a missing external-issued credential emit `outcome: needs_pm`; the PM resolver MUST escalate to human and MUST NOT generate a substitute.
```

#### E. PRE-FLIGHT extension — probe every credential the round consumes

PRE-FLIGHT's existing credentials sub-task probes only its own enumerated list. §0.7a extends it: PRE-FLIGHT MUST iterate the union of credentials from `credentials_inventory.md` (both lanes, all envs in scope) and run the cheapest validating probe for each. A missing internal-service-token does NOT block PRE-FLIGHT (the corresponding SEED row will handle it); a missing external-issued credential DOES block PRE-FLIGHT with `⛔ BLOCKED` so the round halts at Batch 0 instead of the first consumer.

#### F. Generator-time validation rule

Post-generation validation MUST assert:

1. Every `$VAR` / `Bearer` / `apikey:` reference in any worker or gate `.md` resolves to either (a) a `cre/` deploy-doc entry, (b) a planned `SEED-<name>` row, or (c) a planned `⏸ HUMAN` row.
2. Every internal-service-token entry in `credentials_inventory.md` has a matching `SEED-<name>` row whose `Depends on` is the introducing worker.
3. Every external-issued entry in `credentials_inventory.md` is either present in `cre/` for every env in scope, or has a `⏸ HUMAN` row in Batch 0 above PRE-FLIGHT.
4. `pm_playbook.md` contains the two §1 standing entries from §D above.

Fail generation with the same hard-block contract as §0.7 if any of these checks fail. Do not silently downgrade an internal-service-token to "operator-provided" — that is exactly the failure mode this section exists to prevent.

### Step 1: Understand the Input

Input may be:
- **Full PRD / requirements document** → proceed directly to analysis
- **Feature description paragraph** → clarify key assumptions, then analyze
- **One-line concept** → make reasonable assumptions, expand, flag all as `[ASSUMPTION]`

### Step 2: Worker Decomposition

Worker ID prefix conventions:
- `R-` = Rework (modify existing code)
- `N-` = New (build from scratch)
- `D-` = Delete/strip (remove old code)
- `V-` = Verify (validate a fix in a physical environment coding workers cannot access — see **Verification Workers** below; use sparingly)

Delta type values:
- `REWORK` — existing code modified to meet new or revised spec
- `NEW` — built from scratch, no prior implementation
- `DELETE` — remove code, validate nothing breaks
- `KEEP` — no change required, listed for dependency tracking
- `DRIFT` — implementation deviated from spec without a conscious decision; no PRD change required, correct the execution
- `VERIFY` — no code change; validate that an implementation worker's fix actually resolves the issue in an environment the coding worker cannot access

Each Worker must specify:
- **Runtime** (Supabase / CF Workers / CF Pages / GitHub Actions / etc.)
- **Delta type** (REWORK / NEW / DELETE / KEEP / DRIFT)
- **Phase** (0 = blocking foundation, 1 = core features, 2 = admin/tooling/cleanup)
- **Priority** (P0 / P1 / P2)
- **Depends on** (other Worker IDs)
- **Sub-tasks** with: description, key constraints, acceptance criteria, reference doc section

Granularity rule: each Worker is completable in **one independent worker session**. More broadly, no worker session may execute more than **one dispatch row of any kind**.

Dispatch session invariant: **one command/session claims exactly one dispatch row total**. After the worker session claims that row, it may only finish it, mark it blocked, or pause because no eligible row exists. It must **not** loop back to the dispatch table to pick up another `⬜` row in the same invocation, even if that row is assigned to the same model or sits in the same batch. Additional work requires a **new explicit dispatch command in a new session**.

**Codebase Pointers (mandatory when system overview exists):** When a system overview exists (confirmed in Step 0.1), the skill **must** perform the following for **every** worker during decomposition — this is not optional:

1. Identify which system overview modules cover the worker's scope (by matching runtime, file paths in Source Scope, or PRD sections to module docs)
2. **Read** those module docs (not just SYSTEM_INDEX.md) and extract: entry points (file:line), key files, function inventories, contracts
3. Embed as a `#### Codebase Pointers` section in the worker definition file
4. If a module doc's Source Scope includes any file the worker will modify, the worker **must** have a Codebase Pointers section — omission is a generation error
5. For new-from-scratch workers where no existing module doc covers the scope, note `Codebase Pointers: N/A — no existing module coverage` in the worker file (do not silently omit)

**Hard rule:** If SYSTEM_INDEX.md lists a module whose Source Scope overlaps with a worker's target files, and the skill does not extract pointers from that module doc into the worker, the generated TaskSpec is invalid. The skill must grep SYSTEM_INDEX.md and each candidate module doc's Source Scope for every file path referenced in the worker's sub-tasks.

**Substrate-consumer scan (mandatory before finalizing decomposition):** For every contract helper, predicate function, capability flag, or route attribute named in the PRD (e.g. `isPublicRoute`, `public: true` flag, `hasCapability`, `@requiresAuth`), `rg` the repo for callers in the enforcement substrate. Zero callers ⇒ `XS-N` substrate finding ⇒ add a W-0 foundation worker (Batch 0) that wires the consumer, with every dependent per-bump worker declaring it in `Depends On`. Full pattern and enforcement-scope hints live in **Step 3 → Anti-pattern — dead substrate helper**. Skip-conditions: if the helper is purely internal (no enforcement role) or its consumer already exists in the codebase, record the file:line evidence in `index.md`'s `## Substrate Consumers Verified` block instead of adding a foundation worker.

### Step 2.3: Frontend Visual Canon Decomposition (mandatory for UI-facing work)

When Step 0.2 triggers, frontend/UI work must be decomposed around both function and visual intent. Do not split "logic workers" from a late "make it pretty" cleanup unless the PRD explicitly requests a design-system-only pass. Every worker that changes rendered UI must carry the Visual Canon in its own file because workers read only their assigned file during execution.

**Frontend worker emission rules:**

1. Every UI implementation worker and every UI V-worker MUST contain a `#### Visual Canon` section immediately after `#### Codebase Pointers` and before the `#### Applicable Laws` capsule pointer.
2. The `#### Visual Canon` section MUST list absolute reference paths, sample HTML paths if present, target hierarchy/density rules, responsive rules, and Negative Visual Rules. Do not point only to "see PRD" without restating the load-bearing details.
3. If a sample HTML/CSS page is provided, worker acceptance criteria MUST include parity checks against it: route/screen structure, major regions, spacing/density, typography hierarchy, and interaction states. Exact pixel parity is required only when the PRD says so; otherwise require qualitative parity with screenshots attached.
4. If a screenshot/reference image is provided, UI V-workers MUST capture fresh screenshots at the target route(s) and include a comparison narrative against the reference. Geometry/no-overlap checks alone are insufficient.
5. Add a dedicated `UX-GATE` or `DESIGN-GATE` V-worker after UI implementation whenever the round changes an app surface, layout system, dashboard, editor/workstation, panel framework, or core interaction model. This gate is agent-run, not HUMAN, and must launch the app, exercise the relevant screen(s), capture screenshots, inspect console errors, and compare against the Visual Canon.
6. The dispatch plan Notes column for UI workers must mention `Visual Canon: <short label>` so reviewers can quickly see which rows are design-bound.

**Negative visual rule examples** (customize from the PRD/reference; do not paste blindly):

- Do not ship oversized headings or button text inside dense app/workstation panels.
- Do not use marketing-page hero composition for operational tools.
- Do not nest cards inside cards unless the existing design system already does so.
- Do not leave UI controls floating outside the main workspace frame unless the Visual Canon shows that pattern.
- Do not accept "no overlap" as sufficient when spacing, hierarchy, density, or visual isolation fails the reference.

**Generation validation:** If a TaskSpec contains any frontend/UI worker but no `#### Visual Canon` section in that worker, or no UI V-worker/`UX-GATE`/`DESIGN-GATE` for a changed user-facing surface, the generation is invalid. Stop and repair the TaskSpec before dispatch.

### Step 2.4: Spec-Coverage Audit Pattern (mandatory when PRD enumerates a baseline inventory or numerical target)

**Trigger conditions** — if any of these are true, this section applies:

- PRD says "v1 has X items at `<location>`; v3 implements equivalent under new model Y" (or any "port from previous version" framing).
- PRD includes a numerical target backed by an enumerated inventory (e.g. "87 entries", "all 53 endpoints", "every `#[tauri::command]` in `<path>`").
- PRD has an Acceptance Criterion that says "CI fails on additions/renames not reflected in `<doc>`" and the doc does not yet exist.
- The new architecture has process boundaries that obsolete some baseline items (externalization, protocol isolation, splitting into separate packages).

**Why this section exists (clawso-client-v3 incident):** when a TaskSpec decomposes by *new feature domain* on the assumption that each domain worker will naturally pull in whichever baseline items belong to its bucket, items that don't fall cleanly into any new domain (because the new architecture obsoletes them, renames them, or relocates them across a process boundary) get silently dropped. Per-PR review never sees the gap because each worker's diff matches its brief. Compile/typecheck/test gates pass because the missing items aren't required by anything that builds. V-01-A passes because no integration test covers "did we port everything from v1." The gap surfaces only post-V-01-A in an integration unity sweep — by which point the round looks done and the rework is expensive.

**Mandatory workers when triggered:**

1. **Port-classification audit worker** (always first in the trigger batch, T3 — cross-layer, defines downstream interface):
   - Inventory the baseline (with file:line evidence).
   - Inventory current state of the new system (with file:line evidence).
   - For each baseline item, classify as one of:
     - `port` — must exist in new system, not yet implemented.
     - `ported` — already in new system (cite new file:line; renames OK).
     - `obsolete-by-architecture` — intentionally absent in new system; rationale must cite a concrete architectural boundary (worker ID, PRD section, process boundary like "moved to embedded subprocess per N-50"). "Not needed" is NOT a valid rationale.
     - `renamed` — same functionality, new name (cite both names + new location).
   - Output an authoritative spec doc at the path the PRD names (or `docs/<round>/spec-coverage-allowlist.md` if PRD doesn't specify) with one row per baseline + new-system item, partitioned by Status.
   - Output an operator-facing delta report grouping `port` items by capability bucket / target file so the implementation worker can dispatch sub-implementations without ambiguity.

2. **Strict-mode audit worker** (T1 — well-specified single script rework):
   - Tightens the existing audit script (or creates a new one) to read the spec doc and assert: every spec row with `Status ∈ {ported, renamed}` has a matching new-system artifact; every new-system artifact has a matching spec row; every `Status: port` row fails CI by default with a `--allow-pending` flag escape for the implementation worker's in-progress branch.
   - Drops any printed "(PRD target: N)" message the script does not enforce — the message is a future-reviewer hazard.

3. **Implementation worker** (T3 — multi-file, scope data-driven from #1):
   - Reads the classification audit's outputs. Implements every `Status: port` row in the new system. Updates each row's Status to `ported` with new file:line as it goes. Uses `--allow-pending` while in progress; final commit passes strict mode without the flag.

4. **Producer/consumer parity audit** (T1, only when the spec is a contract package consumed by 2+ runtimes — Zod schemas, IDL, OpenAPI):
   - Asserts that every named export in the contract package has ≥1 import on each consumer side (high-risk routes are strict, others warn-only with a config-driven ratchet list). Prevents the GAP-A pattern where one consumer side hand-rolls types instead of consuming the contract.

5. **Batch integration gate** (T1) — runs both new strict audits, all test suites, plus negative tests proving each new audit actually fails when its invariant is violated. Negative tests clean up after themselves before the gate's commit.

**Hard rule:** workers #1 and #2 must complete and merge BEFORE worker #3 is dispatched. Worker #3's scope is *defined by* worker #1's output — it cannot be sized correctly otherwise. If the classification audit reveals more `port` items than one implementation worker can cover (heuristic: > ~25 items), PM splits #3 into per-bucket sub-workers via `--append` before dispatching.

**Skill validation rule:** if a generated TaskSpec is for a round whose PRD matches any trigger condition above and the dispatch table does not include workers #1, #2, #3, and (where applicable) #4 + #5, the generation is invalid. The skill must surface "Spec-Coverage Audit Pattern triggered by PRD §<N>; required workers missing" and pause for PM confirmation before generating.

### Step 2.4.5: Unification-Discipline Gates (mandatory when PRD touches tools / protocols / capabilities / UI manifests)

**Trigger conditions** — apply when ANY of these match:

- PRD or worker scope mentions: tool contract, `tool.json`, `ui.json`, protocol adapter, capability namespace, admission gate, UI panel kind, embedded / marketplace / user tool tier, `resources/tools/<toolId>/`, `BundledToolPage`, `ProtocolAdapterRegistry`, `ProtocolEntry`.
- A new variant is being added to: protocol enum, panel-kind enum, capability namespace, tier matrix, or any closed enum used by the unification layer.
- The PRD frames itself as "unification layer", "tool contract bump", "schema version increment", "discovery vehicle", or "feature gap exposed by `<tool>`".

If any trigger matches, ALL four sub-gates below are mandatory before TaskSpec emit. Skipping any of them is a generation error.

---

#### 2.4.5.A — Tool-named identifier refusal (load-bearing)

Scan every worker file the TaskSpec is about to emit for **tool-baked names in generic code surfaces**. The four violation classes (from `learnings/process/unification-invariant-audit-playbook.md`):

1. **Closed TS union literals** for tool concepts: `type X = "<tool1>" | "<tool2>"` — widen to `string` or runtime-derived slug set.
2. **Struct / type / enum-variant names** containing a tool slug in generic code: `OpenClawDispatch`, `HermesGateway`, `ProtocolEntry::OpenclawGateway`, `enum X { OpenclawFoo, ... }`.
3. **File / module names** in framework dirs (`protocol_adapter/`, `admission/`, `commands/`, `install_tools.rs`, `local_db.rs`, `tool_contract/`) containing a tool slug: `protocol_adapter/openclaw_gateway.rs`.
4. **IPC return-type field names** baked to a tool: `InstalledToolRegistrationResult.openclaw_status`.

Pattern check the skill MUST run before emitting any worker file:

```bash
# Scan proposed worker bodies (and any quoted Rust/TS code snippets they contain)
# for the four violation classes against the project's tool-slug set.
TOOL_SLUGS=$(ls /Users/yzliu/work/projects/<repo>/apps/client/src-tauri/resources/tools/ 2>/dev/null)
for slug in $TOOL_SLUGS; do
  rg -n "(enum|struct|type|fn|mod)\s+[A-Z][A-Za-z0-9]*${slug^}" <proposed-worker-body>  # CamelCase variant
  rg -n "::${slug^}" <proposed-worker-body>                                              # Variant ref
  rg -n "\"${slug}\"\s*\|\s*\"" <proposed-worker-body>                                   # Closed union
  rg -n "${slug}_[a-z]+\.rs" <proposed-worker-body>                                      # File name
done
```

For every hit, the skill MUST either:

- **Rewrite the worker brief to use a shape name** — replace `openclaw-gateway` with the protocol shape (`ws-typed-envelope`, `ws-agent-gateway`, `json-rpc-ws`), `OpenClawDispatch` with a generic (`ToolMethodDispatch`, `MultiProtocolMethodRouter`), `openclaw_gateway.rs` with `<shape>.rs`. The shape name encodes the wire/structural property, not the originating tool.
- **OR mark the hit as a per-tool-data hit** (acceptable category: schema file contents, i18n keys under `client.<toolId>.*`, manifest fields) and add an explicit comment in the worker brief justifying the category.

The default verdict on any unexplained hit is **reject and rename**.

---

#### 2.4.5.B — Class-3 Hypothetical-Tool Reverse-Validation (when a generic contract is introduced)

Per `learnings/process/pre-taskspec-genericity-reverse-validation.md`: when this TaskSpec introduces a NEW variant in any closed enum that future tools will consume (new protocol kind, new panel kind, new capability namespace, new tier, new admission rule), the dispatch table MUST include a **reverse-validation worker** before the rows that consume the new variant.

Mandatory shape of the reverse-validation worker:

- ID convention: `W-VAL-GENERIC-<short-token>` or `<batch>-RV`.
- Phase: earliest batch that contains the contract-introducing worker. Becomes a dependency of every consuming worker in later batches.
- Sub-tasks (verbatim template — adapt the variation axes to the contract):
  1. Hand-author 2–3 **hypothetical tools** spanning the contract's variation axes (transport × tier × capability × identity, or panel-kind × source × tier, etc.). One MUST be a near-clone of the round's discovery vehicle; one MUST be deliberately distant (different transport / tier).
  2. Walk each hypothetical through every gate the new variant touches: admission, capability derivation, sandbox policy, identity registration, IPC gating, UI static analysis, tier denylist, schema admission. Produce an accept / reject matrix.
  3. Surfaced gaps are P0: file as `⏳ PENDING` in `pm_playbook.md` §4 with severity tag; if any P0 gap appears, the contract-introducing worker rows MUST NOT proceed until the spec is amended.
- Acceptance: written matrix at `<TaskSpec Directory>/reports/<worker-id>-hypothetical-tools.md` with explicit accept/reject per (hypothetical, gate) pair, AND a signed conclusion: `verdict: pass | pass-with-amendments | block-and-amend-PRD`.

Skill behaviour: if a TaskSpec introduces a new closed-enum variant AND no reverse-validation worker is in the dispatch table, refuse to emit and surface "Class-3 reverse-validation worker missing for <variant-name>".

---

#### 2.4.5.C — Test-slug hardcoding refusal + `shipping_tool_ids()` enforcement

When a worker emits Rust tests under `apps/*/src-tauri/`, the AI Auto-Tests / Behavioral Assertions / unit-test stubs the skill writes MUST follow the iteration-over-discovery rule from `learnings/process/unification-invariant-audit-playbook.md` 2026-05-16 addendum.

The skill MUST refuse to emit any test stub that:

- Names a test function `<verb>_<slug1>_and_<slug2>_<rest>` (PR #567 anti-pattern: `shipping_openclaw_and_hermes_manifests_load_through_same_generic_path`).
- Calls `read_tool_manifest(_, "<slug>")` / `state.admit_tool("<slug>", …)` with a literal slug **outside an explicitly-marked synthetic fixture** (synthetic fixtures pass slugs as stable identifiers to in-memory builders; real-manifest-by-slug is forbidden).
- Hardcodes a `for slug in ["openclaw", "hermes"] { … }` array — must be `for tool_id in shipping_tool_ids() { … }`.

Helper location contract (the skill MUST cite this in any test-emitting worker's Codebase Pointers):

```
apps/client/src-tauri/src/test_support/shipping_tools.rs   (cfg-gated; pub-re-exported from src/lib.rs)
  → fn shipping_tool_ids() -> Vec<String>   (directory iteration of resources/tools/*/tool.json)
```

Integration tests under `apps/client/src-tauri/tests/*.rs` reach it via `clawso_tauri::shipping_tool_ids` (requires `feature = "test-support"` on the test target).

If the helper does NOT yet exist in the target repo, the TaskSpec MUST add a foundation worker (call it `W-TEST-HELPER` or batch into PRE-FLIGHT) that:

1. Moves `shipping_tool_ids()` from `install_tools.rs::tests` to `src/test_support/shipping_tools.rs`.
2. Adds `pub use` re-export in `src/lib.rs` under `#[cfg(any(test, feature = "test-support"))]`.
3. Extends the existing `no_per_tool_branches_in_install_tools_module_source` lint into a pair:
   - `no_per_tool_branches_in_product_source` (scans `src/**/*.rs` excluding `#[cfg(test)]` blocks).
   - `no_hardcoded_tool_slugs_in_test_source` (scans `src/**/*.rs` `#[cfg(test)]` blocks + `tests/*.rs` for forbidden patterns above; allows synthetic-fixture exceptions marked with `// unification-allow: synthetic-fixture`).

---

#### 2.4.5.D — Discovery-round POST-FLIGHT reverse-feed gate

Per `learnings/process/manifest-first-then-reverse-feed-into-importer.md`: when the round is a **unification-layer discovery round** (the PRD declares one or more tools as discovery vehicles whose `resources/tools/<vehicle>/{tool,ui}.json` will be hand-edited as the design surface), POST-FLIGHT MUST include a **reverse-feed gate** sub-task with these checks:

1. **Nominate a consolidation doc at TaskSpec generation time.** The discovery round MUST nominate a single PRD-side document where ALL importer-related findings (A applied, B backlog, C schema-bump candidates) are recorded. Default convention: the round's "historical PRD" or "discovery anchor PRD" already cited in Mandatory Reading Order (e.g. for OpenClaw rounds: `clawso-client-app-v3/clawso-tool-contract-v3/prd/openclaw-verify-floor-and-path-shadow.md`). The skill MUST emit the consolidation doc path verbatim into POST-FLIGHT's sub-task body so the worker doesn't have to guess.

2. Diff the hand-stabilised `resources/tools/<vehicle>/tool.json` + `ui.json` + `schemas/*` against `/clawso-tool-importer`'s current output for the same upstream tool.

3. Classify each diff hunk into A / B / C buckets:
   - **A — Trivial importer change** — apply now (edit `02b/02c/02d/03` sub-skills as needed), regenerate, confirm equality, ship in this round's POST-FLIGHT PR. Append a one-line acknowledgement to the consolidation doc's `§Importer reverse-feed log` section.
   - **B — Structural importer change** (needs new sub-skill stage / partner-contract amendment / handling for a new panel kind or protocol shape) — **record as a structured backlog entry** (`B-N`) in the consolidation doc's `§Importer reverse-feed backlog` section using the verbatim template in the learning. **DO NOT** open a separate `taskspec/<importer-followon>/` directory; **DO NOT** scatter findings across multiple proposal markdowns. The single-doc rule is load-bearing.
   - **C — Schema-bump candidate** (importer cannot express manifest under current schema rev) — record as `C-N` in the same consolidation doc's `§Pending schema-version bumps` sub-section. Surface PM flag.

4. **Acceptance**: POST-FLIGHT report's `## Reverse-Feed Gate` section contains: (a) diff snapshot or path, (b) per-hunk classification table with counts per bucket, (c) for each A: importer-skill commit/PR ref + log entry ref, (d) for each B / C: the consolidation-doc entry IDs (`B-1`, `B-2`, `C-1`, …) that were appended, (e) final verdict `closed — all importer findings recorded in <consolidation-doc-path>`.

5. **Skill emission rules**:
   - If the skill detects a discovery-round trigger (PRD prose contains "discovery vehicle" / "design surface" / "unification layer feature gap" / direct hand-edit of `resources/tools/<vehicle>/`) AND POST-FLIGHT lacks the reverse-feed gate, refuse to emit.
   - The skill MUST embed the verbatim per-finding entry template (from the learning) into POST-FLIGHT's sub-task body so workers paste structured entries, not freeform prose.
   - The skill MUST cite `learnings/process/manifest-first-then-reverse-feed-into-importer.md` rule 4a (consolidation rule) in POST-FLIGHT's Referenced Learnings.

---

#### 2.4.5.E — Auto-curation of unification learnings (Step 2.7 supplement)

When ANY trigger in 2.4.5 matches, the Per-Worker Learnings Curation sweep (Step 2.7) MUST inject the following learnings into the curated `#### Referenced Learnings` subset of every worker touching `protocol_adapter/`, `admission/`, `install_tools.rs`, `commands/tools.rs`, `tool_contract/`, `resources/tools/`, or any TS file under `apps/client/src/components/tools/` / `apps/client/src/tools/renderer/`:

- `learnings/client/embedded-tool-unification-layer.md` — base architecture.
- `learnings/process/unification-invariant-audit-playbook.md` — per-tool branch violation catalogue + test-slug rule.
- `learnings/process/tool-fixes-must-route-through-framework-or-importer-not-tool-resources.md` — meta-rule for fix routing.
- `learnings/process/manifest-first-then-reverse-feed-into-importer.md` — discovery-phase carve-out (only when 2.4.5.D triggered).
- `learnings/process/pre-taskspec-genericity-reverse-validation.md` — only when 2.4.5.B triggered.

These are MANDATORY curations — the keyword-match heuristic in Step 2.7.4 is bypassed for these entries. Workers cannot proceed without reading them.

---

### Step 2.5: Verification Workers (agent-run)

**Default: coding workers verify everything.** Implementation workers (R-/N-/D-) include behavioral assertions (Layer 2) that catch wiring, lifecycle, and correctness bugs without a running app. This is the primary verification mechanism.

**V- workers are agent-executed validation rows.** Create them when the implementation batch needs independent runtime, browser, integration, infrastructure, or cross-worker verification after code changes land. GUI, UX, staging, and product-acceptance checks are never `HUMAN` rows by default; they must be converted into concrete agent-run E2E steps with observable assertions.

**Why this exists:** Runtime behavior can fail even when static checks pass, but the TaskSpec should not defer quality to a later manual check. Agents must execute the reachable surface themselves: launch the app, drive the browser or desktop harness, inspect visible state, capture logs/screenshots where useful, and report pass/fail evidence.

**Allowed verification row shapes:**

- **Single agent V-row:** Use one `V-XX` row when static checks and E2E execution fit in one worker.
- **Split agent V-rows:** Use `V-XX-A` for automated service validation and `V-XX-B` for agent browser/runtime E2E when the scope is large enough to justify sequencing. Both rows use real model IDs selected by the Step 5 rubric. `V-XX-B` depends on `V-XX-A`.
- **Manual authority gate:** Use `Model: HUMAN` only for non-automatable external authority such as credentials the agent cannot access, production-console actions that require the user's account, or explicit PM decisions. Do not use it for GUI/UX/browser/staging/product checks. If human product review will happen after the round, mention it outside the dispatch plan.

**Generation rules:**

1. **Prefer worker verification via behavioral assertions.** Before creating a V- worker, ask: can the coding worker verify this by reading code (Layer 2 behavioral assertion)? If yes, add the assertion to the implementation worker instead.
2. **Group by verification surface:** Create one V- worker per distinct runnable surface (browser app, Tauri desktop, API/service, infrastructure environment) or per logical group if many items share the same surface.
3. **Depend on implementation workers:** Each V- worker depends on the R-/N-/D- workers that implement the behavior it verifies.
4. **No HUMAN rows for UI:** The dispatch table must not contain any manual UI verification row. Browser/desktop checks become model-assigned agent E2E rows with concrete commands, interactions, and expected observations.
5. **Place in final implementation batch or OMEGA-1:** V- workers run after all code changes for the verified surface are complete.
6. **Agent E2E sub-tasks are mandatory for UI/runtime surfaces:** Each UI/runtime V-worker must include setup, launch/navigation, interaction steps, visible assertions, log/console checks, and evidence capture paths. Use Playwright, the repo's existing E2E harness, IDE browser automation, Tauri automation, or a documented CLI/browser fallback.
7. **Visual Canon comparison is mandatory for UI surfaces:** Each UI V-worker must reference the `#### Visual Canon`, capture screenshots for the changed screen(s), and write a short comparison against the reference/sample HTML. Passing because "elements are present" or "nothing overlaps" is not enough when the canon defines density, hierarchy, spacing, or resemblance.
8. **Static validation remains mandatory when relevant:** Include compilation, typecheck, unit/integration commands, and code-reading assertions before E2E steps when they reduce ambiguity.
9. **V-workers must be explicitly completed by agents** with command output, browser/runtime observations, screenshots, and pass/fail evidence. Any failure triggers a follow-up worker appended via `--append`.

### Step 2.6: Decompose Acceptance Criteria into Worker-Verifiable Proxies (mandatory)

Every acceptance criterion that describes runtime behavior must be decomposed into agent-verifiable parts:

1. **Worker-verifiable proxy** - a behavioral assertion the coding worker can verify by reading code. For implementation workers, this goes into Layer 2 Behavioral Assertions. For V-workers, this becomes a static/service validation sub-task.
2. **Agent E2E assertion** - the runtime/browser/desktop interaction an agent will execute to observe the behavior directly.

**Why this exists:** Without this decomposition, workers may treat "tests passed" as enough and defer runtime correctness to a later manual check. This rule shifts behavioral verification left and keeps final validation inside the agent dispatch.

**Routing rule for V-workers:** The "worker-verifiable proxy" column maps to static/service validation sub-tasks. The "agent E2E assertion" column maps to browser/runtime E2E sub-tasks. If a surface is inaccessible to agents, record the blocker and required access in the PM Playbook or a manual authority gate; do not convert ordinary UI acceptance into a HUMAN task.

**Example decomposition:**

| Acceptance criterion | Worker-verifiable proxy -> V static/service sub-task | Agent E2E assertion -> V browser/runtime sub-task |
|---|---|---|
| "Progress bar shows with phase text" | V-01.A2: Verify `bootstrapProgress` state is set by listener callback; listener is awaited before command; progress bar element renders when state is non-null | Launch app, trigger bootstrap, assert progress bar is visible and phase text updates |
| "Auto-advances to Step 2" | V-01.A3: Verify `onAutoAdvance` callback is called after bootstrap promise resolves; `detectWizardStep` is re-invoked on state change | Complete install path and assert Step 2 appears within the expected timeout |
| "No developer jargon on main view" | V-01.A4: Verify strings "PID", "probe", "config path" do not appear in any step component JSX except AdvancedPanel | Navigate the main view and assert those strings are absent from visible text |
| "Uninstall resets to Step 1" | V-01.A5: Verify uninstall success handler calls state reset function; reset sets step to "install" | Run uninstall flow and assert the page returns to the install step |

**Rule:** If a criterion seems purely visual, still translate it into observable agent checks: screenshot comparison, DOM text/role assertions, computed style checks, layout bounding boxes, console error absence, or explicit screenshots attached to the report. Only external authority that the agent cannot exercise becomes a HUMAN/PM gate.

**V-worker template (agent-run, use when independent validation is needed):**

````markdown
### V-01 — Browser Runtime E2E Verification

- **Runtime**: Local CLI + browser automation
- **Delta Type**: VERIFY
- **Phase**: [same as final implementation batch or OMEGA-1]
- **Priority**: P0
- **Depends on**: [R-XX, R-YY - the workers that implement the behavior]
- **Branch**: `<taskspec-id>/V-01`
- **Model Routing Rationale**: [tier + family/effort justified by runtime ambiguity, coupling, and proof burden]
- **Internal Delegation**: forbidden

This worker validates the finished surface with agent-run static checks and E2E execution.

#### Sub-tasks

**V-01.1 - Compilation and service baseline**
- `cargo check` / `npx tsc --noEmit` / project equivalent - zero errors
- **Acceptance**: Clean compilation with all dependent workers' changes merged

**V-01.2 - [Fix ID] ([Fix Name]): Static behavior assertion**
- Read `[file]` - confirm [specific code-level property]
- Grep: [pattern] exists / does not exist in [file]
- [Additional code-reading checks specific to this fix]
- **Acceptance**: [Concrete acceptance criterion provable by code reading]

**V-01.3 - Launch runnable surface**
- Start the dev server, desktop app, or service using the repo's documented command
- Record the URL/process/log path used for E2E
- **Acceptance**: Surface is reachable and startup logs contain no blocking errors

**V-01.4 - Browser/runtime E2E: [scenario name]**
- Navigate to [route/screen]
- Perform [interaction sequence]
- Assert [visible text/role/state/layout/API/log observation]
- Capture screenshot/log reference when useful
- **Acceptance**: Agent-observed behavior matches the acceptance criterion

**V-01.N - Cross-worker integration check** *(include when V-worker covers multiple implementation workers)*
- Verify cross-worker wiring points from Runtime Contracts
- Exercise the integrated path end-to-end
- **Acceptance**: All integration points are verified by observable E2E behavior

#### AI Auto-Tests
```bash
# Static checks
cd <repo-root> && npx tsc --noEmit
cd <rust-dir> && cargo check

# E2E checks - use the repo's existing harness when present
cd <repo-root> && npx playwright test <target-spec>

# Fallback structural checks
rg -n "[pattern]" <file>
```

#### E2E Evidence
- Commands run:
- URL/screen exercised:
- Assertions observed:
- Screenshots/logs:
- Visual Canon comparison (UI surfaces only): reference path(s), screenshot path(s), match/drift notes for hierarchy/density/spacing/typography/negative rules

#### Completion criteria
- All static checks pass
- All E2E scenarios pass or failures are recorded with reproduction steps
- Report includes the exact commands, environment, and evidence paths
- Any failure triggers a follow-up worker appended via `--append`
````

**Dispatch table integration (agent rows only for verification):**

| Status | Batch | Worker | Task | Model | Depends On | Notes |
|--------|-------|--------|------|-------|------------|-------|
| ⬜ | OMEGA-1 | V-01 | Browser Runtime E2E Verification | claude-opus-4-8::high | R-09 | Cross-layer runtime verification with novel failure discrimination |
| ⬜ | OMEGA-1 | V-02-A | Infrastructure: Automated Service Validation | claude-sonnet-4-6::medium | R-02 | Single-layer config verification |
| ⬜ | OMEGA-1 | V-02-B | Infrastructure: Agent E2E Smoke | claude-sonnet-4-6::medium | V-02-A | Agent-run smoke over reachable environment |

### Step 2.7: Per-Worker Learnings Curation (mandatory when project has a learnings directory)

The `/reference-learnings` skill defines the read-side contract for prior project learnings (captured by `/ship-changes` into `/Users/yzliu/work/Docs/Projects/<project>/learnings/`). Without curation, every dispatched worker would redo the same `ls` + `rg` triage independently — N redundant searches over the same directory, plus N independent judgment calls about which learning matches the worker's scope. Workers with seemingly generic scope frequently skip the search entirely under the "no obvious match" rationalization.

**The TaskSpec skill performs the learnings sweep ONCE at generation time and writes a per-worker curated subset into each worker file.** Workers read only their assigned subset; they MUST NOT re-grep the directory.

> **Relation to Step 2.8 (Laws):** Learnings are the *evidence base* — incident records that show *what happened and how it was fixed*. Laws (Step 2.8) are the *binding rules* distilled from learnings by `/write-laws`. When the worker's task is rule-following and the curated laws cover the constraint surface, the learnings curation here is typically thin or `N/A` (see Step 2.8.7 for the split). Reach for learnings when the worker needs the diagnostic detail behind a rule, the prior incident pattern, or context for a debugging-heavy task — not when the worker just needs to obey a rule.

#### 2.7.1 Resolve the learnings directory (once per generation)

```bash
# Use the project's external Docs slug, not the repo basename — they sometimes differ.
# Default: project_slug derived from the confirmed Docs root.
project_slug="$(basename "<Docs root>")"
learnings_dir="/Users/yzliu/work/Docs/Projects/${project_slug}/learnings"
ls "$learnings_dir" 2>/dev/null || ls /Users/yzliu/work/Docs/Projects/
```

Resolution rules:
1. If `<Docs root>` already points under `/Users/yzliu/work/Docs/Projects/<project>/`, use `<Docs root>/learnings`.
2. Otherwise compute `project_slug` and check `/Users/yzliu/work/Docs/Projects/<project_slug>/learnings`.
3. If neither exists, list `/Users/yzliu/work/Docs/Projects/` and pick the obvious match. If no obvious match, ask the user — do not silently skip; many projects have learnings under a slightly different slug.
4. If after a good-faith resolution attempt no learnings directory exists for this project, every worker's `#### Referenced Learnings` section becomes the verbatim line `Referenced Learnings: N/A — no learnings/ directory for this project.`. The section must still be present in every worker file.

#### 2.7.2 Load the learnings inventory (once)

**Check for `index.md` first (fast path):**

```bash
[ -f "${learnings_dir}/index.md" ] && cat "${learnings_dir}/index.md"
```

If `index.md` exists, use its `## Entries` section as the inventory — each entry already provides the relative path, one-sentence topic summary, and tags. Build the in-memory map directly from these entries without reading every file individually. The `## Layout` field tells you whether paths are flat or under subdirectory prefixes.

**If no `index.md` exists (fallback):**

```bash
# Capture filenames + first-line title for every learning .md in one pass.
for f in "$learnings_dir"/*.md; do
  echo "=== $(basename "$f") ==="
  head -5 "$f"
done
```

Read every learning file once. Build an in-memory map keyed by file path, with: filename slug, title/first-line, key topics (extracted from filename + first paragraph), runtime/scope tags.

This is the **single load** in either case — every worker's curation pulls from this in-memory map; do NOT re-read the directory per worker.

#### 2.7.3 Build per-worker keyword sets

For each worker, derive its curation keyword set from:

- **Runtime** (`tauri`, `supabase`, `cloudflare`, `actions`, `vite`, `bun`, `npm`, …)
- **File paths and module names** in the worker's sub-tasks (e.g. `apps/client/src-tauri`, `bff`, `mcp-host`)
- **Contract package names** (e.g. `@clawso/api-contracts`, `pino`, `zod`)
- **Error strings or symbols** mentioned in the PRD §3 / §9 sections that this worker fixes
- **Verb of the task** (`deploy`, `migrate`, `release`, `auth`, `vault`, `binding`, `updater`, `build`, `bundle`, `rotate`)
- **PM Playbook §3 in-scope rule keywords** (cross-reference rules whose Scope matches this worker)

#### 2.7.4 Match against the in-memory inventory

For each worker, score each learning against the keyword set (case-insensitive substring match against filename, title, and first paragraph). Pick the top **1–5 matches** per worker. Many workers will have zero matches; that is expected and valid — emit the `N/A — no relevant prior learnings.` line in that case.

**Match-quality bar:** every retained match must have a concrete, single-sentence "why this applies" tied to the worker's scope. If you cannot write that sentence, the match is too weak — drop it. Examples:

- ✅ "Covers Tauri updater keypair rotation invariant; this worker rotates the signing key."
- ✅ "Documents online Supabase preflight contract; this worker runs `db:remote:status`."
- ❌ "General clawso project notes." (no scope overlap — drop)
- ❌ "Mentions `bff`." (filename-only match without behavioral relevance — drop)

#### 2.7.5 Emit `#### Referenced Learnings` per worker

Each worker file gets a `#### Referenced Learnings` section (placement: after the one-line `#### Applicable Laws` capsule pointer, before `#### Completion Protocol`). Format:

```
- `<absolute path to learning .md>` — <one-line scope-overlap rationale>
- `<absolute path to learning .md>` — <one-line scope-overlap rationale>
```

A bare path with no rationale is a generation error — workers cannot verify match quality without it. Use absolute paths; workers must not have to compute paths from a slug.

#### 2.7.6 Worker-side contract (enforced via worker template + dispatch command)

- Workers MUST read every entry in their curated `#### Referenced Learnings` list before starting sub-tasks.
- Workers MUST NOT independently re-grep `/Users/yzliu/work/Docs/Projects/<project>/learnings/` — the curated list is authoritative for the row. The TaskSpec generator already performed the sweep.
- Workers MUST cite by filename slug in their completion report under `## Referenced Learnings Applied` when a learning shaped a decision (`/reference-learnings` Step 6 contract).
- If a curated learning conflicts with current code (the "stale memory" failure mode from `/reference-learnings` Step 5), the worker prefers what they observe and flags the stale learning in the completion report so PM can update or retire it.
- If a worker discovers mid-task that another learning should apply (one not in its curated list), they MAY read it and note the discovery in their report under `## Learnings Discovered` — but they MUST NOT silently re-curate the whole directory; the discovery is information for PM, not a license to broaden scope.

#### 2.7.7 `--append` mode

When appending workers to an existing TaskSpec, re-run the learnings sweep ONCE for the appended batch and curate per-new-worker. **Existing workers' curated lists are NEVER edited**, even if new learnings have been captured since the original TaskSpec was generated. The skill records in the changelog which learnings were available at the appended-batch generation time.

#### 2.7.8 Validation (post-generation)

- Every worker file contains exactly one `#### Referenced Learnings` section.
- Every entry in those sections is either an absolute path under `/Users/yzliu/work/Docs/Projects/<project>/learnings/` followed by ` — ` and a non-empty rationale, OR the literal `Referenced Learnings: N/A — no learnings/ directory for this project.` line, OR `Referenced Learnings: N/A — no relevant prior learnings.`.
- No worker's curated list exceeds 5 entries (curation discipline; if a worker genuinely needs more, split it or re-bucket).
- The dispatch command's Step 4 references reading the curated list (see Dispatch Command §6 below) and forbids independent re-grepping.

**Why this exists (token-efficiency + reuse-rate optimization):**

- **Token efficiency:** N workers × `ls` + `rg` + multiple `Read`s over the same directory becomes 1× sweep at generation, plus N × small targeted reads at execution. For a 30-worker round with a 40-file learnings directory, that is roughly an order-of-magnitude reduction in learning-related tokens.
- **Reuse rate:** Workers told *which* learnings apply to *their* scope read them. Workers told to "search the learnings dir" frequently skip when their scope feels generic.
- **Match quality:** The skill, holding the full PRD + decomposition + codebase pointer context, picks better matches than a worker that has only its own brief.
- **Auditable lineage:** The curated list is committed alongside the worker file. Reviewers see exactly which prior-art guided the worker.

### Step 2.8: Per-Worker Laws Curation (mandatory when project has a laws directory)

The `/read-laws` skill defines the read-side contract for repo-canon **binding principles** at `/Users/yzliu/work/Docs/Projects/<project>/laws/` (populated by `/write-laws`). Laws are the single source of truth for *"what must I do"* in this repo; learnings (Step 2.7) remain the evidence base for *"how did we previously fix X"*. For rule-following workers, laws are smaller, more specific, and more token-efficient than scanning learnings — they were distilled by `/write-laws` precisely so workers do not have to re-derive the principle from raw incidents.

**The TaskSpec skill performs the laws sweep ONCE at generation time and writes each worker's curated subset directly into that worker's Context Capsule (`context/<WORKER_ID>-context.md` § Applicable Laws), which is emitted in the same generation pass (Step 2.8.5a).** The worker card carries only a one-line pointer. Workers read only their assigned subset; they MUST NOT re-grep the laws directory. See Step 2.8.5 for the placement rule and why it moved off the card in v1.31.1.

#### 2.8.1 Resolve the laws directory (once per generation)

```bash
project_slug="$(basename "<Docs root>")"
laws_dir="/Users/yzliu/work/Docs/Projects/${project_slug}/laws"
ls "$laws_dir" 2>/dev/null || ls /Users/yzliu/work/Docs/Projects/
```

Resolution rules (mirror Step 2.7.1):
1. If `<Docs root>` already points under `/Users/yzliu/work/Docs/Projects/<project>/`, use `<Docs root>/laws`.
2. Otherwise compute `project_slug` and check `/Users/yzliu/work/Docs/Projects/<project_slug>/laws`.
3. If neither exists, list `/Users/yzliu/work/Docs/Projects/` and pick the obvious match. If no obvious match, ask the user.
4. If after a good-faith resolution attempt no laws directory exists for this project, every capsule's `## Applicable Laws` section becomes the verbatim line `Applicable Laws: N/A — no laws/ directory for this project.`. The section must still be present in every capsule, and each card still carries its one-line pointer.

#### 2.8.2 Load the laws inventory (once)

`/write-laws` mandates an `index.md` for every laws directory, so the inventory is always index-driven (no fallback needed):

```bash
cat "${laws_dir}/index.md"
```

The `## Entries` section gives, per law, a relative path, a one-sentence rule restatement, and a comma-separated tag list. Build the in-memory map directly from these entries. Read the `## Layout` field to determine whether paths are flat or under aspect subdirectories (`layering/`, `contracts/`, `verification/`, `state/`, `lifecycle/`, `safety/`, `process/`).

If the `laws/` directory exists but `index.md` is missing, that is a `/write-laws` contract violation — surface as a generation warning and fall back to `find "$laws_dir" -name "*.md" ! -name "index.md"`. Read every law file's frontmatter (`name`, `aspect`, `status`, `version`) plus its `## Statement` block to populate the inventory.

This is the **single load** — every worker's curation pulls from this in-memory map; do NOT re-read the directory per worker.

#### 2.8.3 Build per-worker law-keyword sets

For each worker, derive its law-matching keyword set from:

- **Aspect axis** (`layering`, `contracts`, `verification`, `state`, `lifecycle`, `safety`, `process`) — which aspects does the worker's scope touch? A worker that adds a new IPC command touches `contracts` + `verification` + `safety`. A worker that adds a CI gate touches `process` + `verification`.
- **File paths and module names** in the worker's sub-tasks (e.g. `protocol_adapter/`, `tool_contract/`, `resources/tools/`, `bff`, `mcp-host`).
- **Verb of the task** (`add`, `migrate`, `release`, `bind`, `activate`, `gate`, `validate`, `bump-contract`).
- **Tag overlaps** with the `## Entries` tag list (e.g. `framework`, `anti-branch`, `unification`, `real-binary`, `idempotency`, `merge`, `preflight`, `substrate-scan`).
- **Codebase Pointers** the worker received in Step 2.7 — if a pointer touches a module covered by a law's `Scope`, that law applies.

#### 2.8.4 Match against the inventory

For each worker, score each law against the keyword set. **Read the law file before retaining a match** — confirm the `## Scope` section actually covers this worker's surface (laws frequently carve out exceptions; a hit on aspect or tags is not enough on its own). Retain the matches whose `## Scope` covers the worker's scope.

Most workers will retain 2–5 matches (laws are broad by design; aspect alignment usually yields several). A worker may retain zero matches when its scope falls entirely inside a carve-out clause of every otherwise-aspect-matching law — that is valid; emit the `N/A — no in-scope laws.` line.

**Match-quality bar:** every retained law must have a one-sentence "why this binds the worker" tied to a specific sub-task or file. If the rationale is generic ("touches contracts"), look harder — laws are specific enough that the rationale should name the binding obligation (e.g. *"forbids closed unions over tool slugs; this worker adds a new protocol kind"*).

#### 2.8.5 Emit `## Applicable Laws` into the Task Context Capsule (v1.31.1 — moved off the worker card)

Curated laws are emitted into **`context/<WORKER_ID>-context.md`**, under its `## Applicable Laws` section (see Step 6.6.2). They are NOT emitted into the worker card. The card carries execution detail only.

> **Why the move (v1.31.1).** v1.31.0 introduced Context Gate 3 — *"no rule appears in more than one of {role context, task card, capsule}"* — while Step 2.8.5 still mandated `#### Applicable Laws` on the card AND Step 6.6.2 mandated `## Applicable Laws` in the capsule. Both were marked mandatory, so following the skill literally produced a **100%-duplicated law set across card and capsule**: a guaranteed Gate 3 failure, and precisely the drift surface (edit one, forget the other) that Gate 3 exists to prevent. Gate 3's own split is authoritative and settles the ownership question: **role context = global rules · capsule = task-level decisions · card = execution detail.** Laws are task-level decisions, so they live in the capsule.

Format inside the capsule's `## Applicable Laws` section:

```
- `<absolute path to law .md>` — **Statement:** <verbatim Statement> — **Why it binds this worker:** <one-line scope-overlap rationale tied to a sub-task or file>
- `<absolute path to law .md>` — **Statement:** <verbatim Statement> — **Why it binds this worker:** <one-line scope-overlap rationale tied to a sub-task or file>
```

Including the verbatim `## Statement` (one sentence) in the capsule is mandatory — it lets workers honor the rule without an extra file read, and lets reviewers verify match quality from the capsule alone. The path is provided for the rest of the law (Why / Scope / Implications), which the worker reads when the rule shapes a decision.

A bare path with no Statement is a generation error.

**The worker card carries a one-line pointer, not a restatement:**

```
#### Applicable Laws

→ `context/<WORKER_ID>-context.md` § Applicable Laws (curated, binding). Do NOT re-grep the laws directory.
```

A pointer is not a rule restatement, so Gate 3 is satisfied. The pointer exists so a card read in isolation — manual dispatch, review, audit — still leads to the binding set instead of dead-ending.

#### 2.8.5a Capsule materialization — bootstrap at generation, later waves by the Integrator (v1.33.0)

v1.31.1 persisted a curation map; v1.32.0 emitted **every** capsule up front. Both were wrong in one direction each. The correct split:

| Wave | Who emits the capsule | When | Why |
|---|---|---|---|
| **Wave 0** | the **skill**, at generation time | up front | Breaks the bootstrap deadlock (Worker needs a capsule → capsule needs a generator → the generator would itself need a capsule). The generator is the skill, never a dispatched row. |
| **Wave N ≥ 1** | that wave's **Integrator** (`BATCH-(N-1)-GATE`), as an explicit sub-task | immediately before dispatching wave N | Its content depends on state that does not exist at generation time. |

**What genuinely cannot be frozen at generation time:**

- **Dependency SHAs** — the rows have not landed.
- **Decision status** — a decision can move `PENDING → APPROVED` *during* the round (the row that verifies owner decisions typically runs in wave 0), so a capsule frozen before it runs carries a stale status. This is the decisive one: it is why "inject the approved decisions into the capsule" is only achievable per-wave.
- **Upstream artifact content** — a later row may consume a report an earlier row produces.

**What the skill still owns for every wave, emitted up front:** the capsule **schema**, the per-task **template** (objective · files owned · forbidden · required deletions · acceptance commands), the curated **laws** set (laws are version-stable; they do not depend on round progress), the **learnings** selection, the context budget, and the historical-contamination rules. The Integrator materializes — it does not re-decide.

⛔ **The Integrator MUST NOT re-run the laws/learnings sweep.** Re-sweeping months later can curate differently and silently drift the binding rule set inside one round. It fills in SHAs, refreshes decision status against the registry, and confirms named upstream artifacts exist.

⛔ **A capsule for a wave that has not been reached MUST NOT be materialized with invented values.** Emit the template with the unresolved fields explicitly named as pending-materialization, or reject the request — never fabricate a SHA or a decision status.

#### 2.8.6 Worker-side contract

- Workers MUST read every entry in their capsule's `## Applicable Laws` list before starting sub-tasks. The Statement is binding; the full law file is read when the rule shapes a concrete decision.
- Workers MUST NOT independently re-grep `/Users/yzliu/work/Docs/Projects/<project>/laws/` — the curated capsule list is authoritative for the row.
- Workers MUST cite by law slug in their completion report under `## Applied Laws` when a law shaped a decision (`/read-laws` Step 5 contract).
- If a request in the worker's brief cannot be satisfied without violating an in-scope law, the worker MUST stop and escalate as a structured `LAW CONFLICT` block (`/read-laws` Step 6) — laws supersede the worker's brief on rule questions. Filing a `⏳ PENDING` row in `pm_playbook.md` §4 is the standard escalation path.
- Workers do NOT amend laws. Law changes are owned by `/write-laws` with explicit user-confirmed conflict resolution.

#### 2.8.7 Laws-vs-learnings split (token-efficiency directive)

The two sweeps serve different purposes:

| Worker type | Laws (Step 2.8) | Learnings (Step 2.7) |
|---|---|---|
| Rule-following (apply an existing pattern, contract-conforming addition, code-cleanup against a known rule) | **Primary** — typically 2–5 entries | Frequently `N/A — no relevant prior learnings.` (no novel diagnostic context needed) |
| Debugging-heavy (root-cause hunt, recovery, migration, novel integration) | Populated — bind the *approach* | Populated — give the *evidence* and prior diagnostic sequences |
| Contract / schema / migration | Both populated — laws bind the contract shape; learnings give the prior incident pattern | Both populated |
| Verification / acceptance gate | Laws bind the evidence type (real-binary, user-visible state); learnings give past theater traps | Both populated |

The generator MUST resist the reflex to populate `#### Referenced Learnings` for every worker just because the project has a learnings directory. If the curated laws fully cover the constraint surface and no specific prior incident applies to the worker's scope, the learnings section's verbatim `N/A — no relevant prior learnings.` line is the correct emission. This is what makes `/read-laws` more token-efficient than `/reference-learnings` for rule-following workers.

#### 2.8.8 `--append` mode

When appending workers to an existing TaskSpec, re-run the laws sweep ONCE for the appended batch and curate per-new-worker. **Existing workers' curated laws lists are NEVER edited**, even if `/write-laws` has run between the original generation and the append. Record in the changelog which laws version was available at the appended-batch generation time (the `# Laws Index` comment header in `index.md` carries the date).

#### 2.8.9 Validation (post-generation)

- Every capsule contains exactly one `## Applicable Laws` section.
- Every entry is either ``- `<absolute path>` — **Statement:** <text> — **Why it binds this worker:** <text>`` with non-empty Statement and rationale, OR the literal `Applicable Laws: N/A — no laws/ directory for this project.` line, OR `Applicable Laws: N/A — no in-scope laws.`.
- ⭐ **Gate 3 parity check (v1.31.1):** no worker card contains a law path, a verbatim law Statement, or a `**Why it binds this worker:**` line. The card's `#### Applicable Laws` section contains the one-line capsule pointer and nothing else. A card that restates any law is a HARD generation error.
- Every worker ID emitted in `dispatch_plan.md` has a capsule at `context/<WORKER_ID>-context.md` carrying an `## Applicable Laws` section.
- The dispatch command's Step 4 references reading both the curated laws and learnings lists (see Dispatch Command §6 below) and forbids independent re-grepping of either directory.
- The Completion Protocol report contract requires `## Applied Laws` parallel to `## Referenced Learnings Applied`.

**Why this exists:**

- **Specificity:** Laws are pre-distilled binding rules. Workers told *"closed unions over tool slugs are violations"* obey faster and more uniformly than workers told *"read these five incidents and infer the rule."*
- **Token efficiency:** For a 30-worker round, 1 laws-index read + targeted small reads beats per-worker grep. Combined with rule-following workers emitting `N/A` on learnings, the round's rule-context tokens drop substantially.
- **Audit lineage:** Laws have version identity. Workers cite by slug; reviewers can trace the binding obligation to a specific law version.
- **Conflict surface:** A law conflict (worker brief vs binding rule) is a hard stop with a structured escalation; a learnings conflict was an ad-hoc judgement call. Laws make the canon enforceable.

#### 2.8.10 Gate Worker Law Inheritance (mandatory, v1.28.0 — `agent-dispatcher-666ecd32` BATCH-2-GATE incident)

**Why this exists:** The standard per-worker curation in Steps 2.8.3–2.8.4 scores each worker's keyword set against law tags + scope clauses. Gate workers (`BATCH-N-GATE`, `INTEGRATE`, `POST-FLIGHT`) declare scope as "audit upstream commits"; they rarely touch product files themselves. By the per-scope rule they receive only a handful of process-class laws — even though their actual responsibility is to **enforce every binding rule the audited workers had to obey**. The 2026-06-05 `agent-dispatcher-666ecd32` round (`provider-binding-multi-cap-2026-06-05`) burned this gap: BATCH-2-GATE shipped commit `5f2c8a85 chore(dispatch): migrate shipping provider bindings` which directly hand-edited `apps/client/src-tauri/resources/tools/openclaw/{tool,ui}.json`. That action is forbidden by `layering/shipped-tool-resources-are-external-artifacts` (Statement: *"Every file under the shipped-tool resource tree is the structured output of an importer template, never hand-maintained source; fixes route through framework, importer template, or upstream, never through ad-hoc edits to a single tool's resources."*). The law was declared round-wide in `index.md` + `pm_playbook.md` §3, AND curated for R-20 / R-21 / R-22 / N-03 / N-14 / N-17 / BATCH-5-GATE / POST-FLIGHT — but **NOT for BATCH-2-GATE** because the gate's declared scope didn't enumerate `resources/tools/`. The gate worker had no signal it was violating canon.

**Fix — gate workers MUST receive a UNION-superset curation, not a scope-intersection subset:**

For every gate worker (`BATCH-N-GATE`, `INTEGRATE`, `POST-FLIGHT`), the generator computes the gate capsule's `## Applicable Laws` set as the UNION of:

1. **Self-scope matches** — the existing Step 2.8.4 rule applied to the gate worker's own scope (typically: `verification`, `process`, `safety/no-silent-bypass` class laws).
2. **Gated-worker inheritance** — every law curated for every worker the gate gates:
   - `BATCH-N-GATE` inherits from every worker in batch N (union the gated workers' curated law sets from the same in-memory sweep; the union is written into the gate's own capsule).
   - `INTEGRATE` inherits from every implementation worker in the round (R-*, N-*, D-*) plus every BATCH-N-GATE.
   - `POST-FLIGHT` inherits from `INTEGRATE` (which by transitivity covers the whole round).
3. **Artifact-path inheritance** — every law whose `## Scope` covers any artifact path the gate's merge/sync/cleanup action may modify, even when the gate's planned sub-tasks don't enumerate that touch. Concretely: if any gated worker's plan touches `resources/tools/`, `tool-importer/`, `packages/api-contracts/`, `supabase/migrations/`, OR any artifact-codegen output path (see Step 2.8.11), the gate inherits every law applying to that path.

For each inherited law, the "Why it binds this worker" line is rewritten with explicit audit framing: `Why it binds this gate: <upstream-worker> was required to obey this law; this gate refuses the batch if any upstream commit violates it.`

**Validation (post-generation):**

- Every `BATCH-N-GATE` capsule's `## Applicable Laws` count MUST be ≥ the maximum count across the workers it gates. A gate with FEWER curated laws than any worker it gates is a HARD generation error — the curation missed the inheritance step.
- Every `INTEGRATE` capsule's `## Applicable Laws` count MUST be ≥ the maximum across every implementation worker.
- Specifically: if ANY gated worker has `layering/shipped-tool-resources-are-external-artifacts` curated, the gate MUST inherit it (or — if the gate's run-time substrate makes the inheritance vacuous — emit `Inheritance carve-out: <law-slug> not inherited because <verbatim justification>` in the gate capsule, audited by PM).

**`--append` mode:** when appending workers to an existing TaskSpec, the appended workers' laws DO NOT retroactively flow into existing gate workers (existing curated lists are never edited per the v1.0 append rule). The skill MUST surface a warning: `⚠️ Appended workers introduced laws not inherited by existing gate <gate-id>; if the round depends on the gate enforcing those laws, file a follow-on TaskSpec or accept the gap explicitly`.

#### 2.8.11 Codegen Output Guard (mandatory, v1.28.0 — universal codegen-source-of-truth rule)

**Why this exists:** A law class that recurs across every project is **"codegen output is read-only; fix the source then regenerate"** — clawso has `tool-importer/` → `resources/tools/`, every TypeScript codegen pair has source schemas → emitted types, every protobuf-style contract has IDL → bindings, every Cloudflare Workers bundle has `wrangler dev` source → built worker. When a TaskSpec worker plans to fix something by editing a codegen output directly, that is a structural violation of this law class — but the curated `## Applicable Laws` will name the law only if the worker happens to touch a path the law's `## Scope` enumerates.

**Generator-time codegen-pair probe (mandatory before emitting any worker file):**

For each project, the generator MUST scan the project's laws directory for laws whose tags or filename contain any of: `codegen`, `external-artifact`, `source-of-truth`, `read-only`, `regenerate`, `importer-output`, `shipped-resources`, OR an explicit YAML frontmatter field `codegen-pair:` (introduced by `/write-laws` v1.x — see that skill's Codegen Pair Law Template). For every codegen-pair law found, extract:

- `source-path` — the source-of-truth file or directory the codegen reads
- `output-path` — the file or directory glob the codegen writes
- `regenerate-command` — the verbatim shell command to re-run the codegen (full or scoped to one output)
- `carve-out-conditions` — when, if ever, a hand-edit to the output is permitted (e.g. discovery-phase carve-out per `shipped-tool-resources-are-external-artifacts`)

**For every worker the generator plans to emit:**

1. Walk the worker's `#### Sub-tasks` planned file touches (extracted from sub-task descriptions, AI Auto-Tests file paths, Codebase Pointers).
2. For each touched file, check it against every codegen-pair law's `output-path` glob.
3. On match — the worker's plan would directly edit a codegen output:
   - **HARD generation error** unless the worker's plan ALSO names the `source-path` AND the `regenerate-command` AND cites the carve-out condition (if any).
   - The generator MUST rewrite the worker's plan to follow the **fix-source-then-regenerate** pattern:
     - Sub-task A: edit the source-path file(s) with the actual change.
     - Sub-task B: run `regenerate-command` (full or scoped to the affected output).
     - Sub-task C: verify the output diff matches the intent (and, when the law mandates a reverse-feed gate, surface that as a downstream R-* worker or gate sub-task).
   - The worker's capsule `## Applicable Laws` MUST include the matched codegen-pair law with rationale `Why it binds this worker: this worker's plan touches a codegen output; the law forbids direct edit and mandates the regenerate path.`

4. When no matching codegen-pair law exists for a planned output edit but the path matches a heuristic (e.g. `dist/`, `build/`, `target/debug/`, `*.generated.{ts,rs,js}`, `tool-importer/listings/*/manifest/`, `resources/tools/*/`, `packages/api-contracts/dist/`), the generator SHOULD surface a warning `⚠️ Worker <W-ID> plans to edit <path> which looks like codegen output; no codegen-pair law on file. Either confirm with PM that the path is hand-maintained, or run /write-laws to codify the pair.` and pause for confirmation before emitting the worker.

**Hard rule:** A worker plan that names a codegen-output path in a sub-task without ALSO naming the source-path + regenerate-command is a HARD generation error. The skill does not generate "edit-the-output" TaskSpecs.

**Validation (post-generation):**

- Grep every emitted worker file for hardcoded paths matching the project's known codegen-output globs. Any match must be paired with a same-worker reference to the source-path and the regenerate-command.
- Specifically for clawso projects: any worker touching `apps/client/src-tauri/resources/tools/*` or `apps/client/src-tauri/resources/tools/*/{tool.json,ui.json}` MUST also touch `tool-importer/listings/<tool>/` AND name the importer regenerate command (`node tool-importer/cli.js regenerate <tool>` or equivalent). The bug-2 incident pattern (5f2c8a85 hand-edited shipping manifests with no importer side change in the same commit) becomes a HARD generation error.

This step is the universal generalization of `shipped-tool-resources-are-external-artifacts` to every codegen relationship in any project. It pairs with `/write-laws`'s Codegen Pair Law Template and `/read-laws`'s Codegen Output Guard (see those skills for the write-side and read-side halves).

### Step 2.9: Canonical Task Graph — one internal DAG, every artifact derived (mandatory; v1.32.0)

**Why this exists (measured, not theoretical).** A round whose dependency facts are hand-maintained in several files drifts within days: `index.md` gets updated, `dispatch_plan.md` keeps the previous wave topology, some cards keep an old `Depends On`, and a batch gate keeps a stale worker list. Each file looks internally reasonable, so review never catches it. Worse — a real round shipped a `dispatch_plan.md` whose Master Dispatch Table **omitted the `Status` column entirely**, which makes all 62 rows invisible to the dispatcher (see Step 2.9.3). The rule that forbids that already existed (v1.20.1); what did not exist was **anything that actually checked**.

#### 2.9.1 Build the graph first

Before emitting any artifact, build ONE in-memory Canonical Task Graph, then persist it to **`taskspec/plan.json`**:

```json
{
  "taskspec_id": "<id>",
  "version": "<v>",
  "branch_prefix": "<prefix>",
  "context_budget_lines": {"worker": 150, "gate": 250, "human": 200, "preflight": 250, "postflight": 200},
  "tasks": [
    {
      "task_id": "W-01", "role": "worker", "wave": 1, "depends_on": ["PRE-FLIGHT"],
      "card": "W-01.md", "capsule": "context/W-01-context.md",
      "tier": "T1", "model": "gpt-5.6-terra::medium", "branch": "<prefix>/W-01",
      "files_owned": ["..."], "output_artifacts": ["reports/W-01.md"],
      "applicable_decisions": ["D-M2"], "human_gate_required": false
    }
  ]
}
```

`role` ∈ `worker | gate | human | preflight | postflight`. Persist it as a file (not merely in-memory): `--append`, later consistency gates, and any regeneration all need to read the same graph, and an in-memory-only graph cannot be audited.

#### 2.9.2 Everything derives from it

```
plan.json  →  index.md · dispatch_plan.md · card `Depends on` · capsule `Upstream Inputs`
           →  gate membership · wave membership · worktree count · expected report count
```

⛔ **Forbidden:** hand-maintaining dependencies per file · card and plan carrying different DAGs · gates carrying hand-written worker lists · a final gate hard-coding a task or candidate count.

#### 2.9.3 The consistency gate MUST parse like the orchestrator does

Emit a `PRE-FLIGHT` sub-task that asserts plan.json ≡ every derived artifact, **and that parses the emitted Master Dispatch Table exactly the way meridian does**. Restating the header contract in prose is what already failed; the gate must execute it.

```python
import json, re, pathlib
plan = json.load(open("plan.json")); bad = []

# (a) card Depends on == plan.json
for task in plan["tasks"]:
    card = pathlib.Path(task["card"])
    if not card.exists(): bad.append(f"MISSING CARD {task['task_id']}"); continue
    m = re.search(r'(?m)^- \*\*Depends on\*\*: (.*)$', card.read_text())
    got = [x.strip() for x in (m.group(1) if m else "").replace("—", "").split(",") if x.strip()]
    if got != task["depends_on"]:
        bad.append(f"DEP DRIFT {task['task_id']}: card={got} plan={task['depends_on']}")

# (b) gates aggregate their wave's WORKER rows only.
#     preflight/postflight/human/sibling-gates are NOT members: PRE-FLIGHT precedes every
#     worker transitively, and POST-FLIGHT runs AFTER the terminal gate — counting it would
#     demand the gate depend on POST-FLIGHT, which inverts the edge and can never go green.
for task in plan["tasks"]:
    if task["role"] == "gate":
        members = [x["task_id"] for x in plan["tasks"]
                   if x["wave"] == task["wave"] and x["role"] == "worker"]
        missing = [m for m in members if m not in task["depends_on"]]
        if missing: bad.append(f"GATE MEMBERSHIP {task['task_id']} missing {missing}")

# (c) ⭐ parse the Master Dispatch Table the way the orchestrator's strict indexer does
norm = lambda c: re.sub(r'^_+|_+$', '', re.sub(r'[^a-z0-9]+', '_', c.strip().lower()))
lines = pathlib.Path("dispatch_plan.md").read_text().split("\n")
ALIAS = {"task": {"task","function_group","headline","action"},
         "model": {"model","agent","model_tier"},
         "depends_on": {"depends_on","depends","dependencies"}}
master = None
for i, line in enumerate(lines):
    if not line.strip().startswith("|"): continue
    if i + 1 >= len(lines) or not re.match(r'^\|[\s:|-]+\|?$', lines[i+1].strip()): continue
    cells = [norm(c) for c in line.strip().strip("|").split("|")]
    if {"status","batch","worker"} <= set(cells) and all(a & set(cells) for a in ALIAS.values()):
        master = (i, cells); break
if master is None:
    bad.append("MASTER TABLE UNPARSEABLE — strict indexer needs status/batch/worker "
               "+ task/model/depends_on aliases; a missing or non-ASCII header column "
               "makes EVERY row invisible to the dispatcher")
else:
    hdr_i, cells = master
    rows = [l for l in lines[hdr_i+2:] if l.strip().startswith("|")]
    if len(rows) != len(plan["tasks"]):
        bad.append(f"ROW COUNT {len(rows)} != plan.json {len(plan['tasks'])}")
    for r in rows:
        if len(r.strip().strip("|").split("|")) != len(cells):
            bad.append(f"CELL PARITY broken at: {r[:60]} — rows below are silently dropped")
        if not r.strip().startswith("| ⬜"):
            bad.append(f"NON-PENDING STATUS (must be exactly ⬜): {r[:60]}")

print("\n".join(bad) if bad else f"OK: plan == artifacts; master table parseable; {len(plan['tasks'])} rows")
raise SystemExit(1 if bad else 0)
```

- **Acceptance**: exit 0. Any drift ⇒ `⛔ BLOCKED`, the round does not dispatch.
- ⛔ **Never "fix" a red result by relaxing the check.** Fix `plan.json`, then re-derive the artifacts.

#### 2.9.4 Architecture modes — armed by the round's shape, never by default

Some architectural guarantees are only correct for a *kind* of round. Arming them unconditionally misfires: "old and new owner coexist" is a violation during a replacement round and a legitimate intermediate state during a gradual migration. The generator arms a mode only when the PRD/decisions actually declare that shape, records which modes are armed in `index.md`, and applies that mode's reject rules in Step 6.7.

| Mode | Armed when | Ordering it enforces | Rejects (within the mode) |
|---|---|---|---|
| **Delete-First** | the round declares it replaces a subsystem rather than extending it | `Inventory → Purge → Zero-Gate → New Kernel → New Runtime/Contract → New Import` | old+new owner coexisting · fallback to the old path on new-path failure · long-lived compatibility shim · migration adapter treated as stable · dual-write · "build new now, delete old later" · a Purge row that also creates · new implementation started before the zero-gate is green · zero-caller parallel module retained "for later" |
| **Clean-Room Import** | the round re-imports / re-onboards from an authoritative upstream | `Upstream → Clean staging → Probe → Contract candidate → Conformance → Promotion` | the importer reading old manifest / listing / patch / receipt / generated resource / runtime state |
| **Contract-First** | the round builds a platform that admits third-party things | `Contract → Runtime → Import/Adapter → Concrete integrations` | per-tool special-casing that lands in the runtime rather than at compile/import time or an explicit escape hatch |
| **Capability-Honored** | the round persists state that some execution capability must honor | persistent state, the runtime capability, and a real consumer ship **together** | creating durable state now and deferring the capability that makes it mean anything |

**Unconditional (not a mode — always on):** *probe neutrality.* A row that investigates something MUST NOT be handed the expected answer. Emit the question (*"probe which surfaces it needs"*), never the conclusion (*"it should use iframe"*), and enumerate the full legal outcome set so a negative result is a valid finding rather than a gate failure. A probe whose card pre-fills its own answer is a HARD generation error.

### Step 3: Test Spec Design

Each Worker requires three testing layers.

**Layer 1: AI Auto-Tests (Compilation + Structural)** — verifies the code compiles and expected artifacts exist:
```bash
# All commands use absolute paths or confirmed env vars
export $(grep -v '^#' /absolute/path/.env.local | xargs)
cd apps/client/src-tauri && cargo check 2>&1 | tail -10
cd /repo/root && npx tsc --noEmit 2>&1 | tail -10
```

**Layer 2: AI Behavioral Assertions (mandatory)** — verifies runtime correctness WITHOUT executing the app. These catch the bugs that compile-only tests miss. Each assertion is a concrete check the worker performs by reading the code:

```markdown
#### Behavioral Assertions
# Event listener lifecycle
- Verify: listener registration is `await`ed before the command that triggers events is called
- Verify: listener cleanup (unlisten) is called in useEffect return / component unmount
- Verify: no fire-and-forget pattern on async listener setup

# Prop drilling completeness
- Verify: every value computed at parent level and needed by a child is passed as a prop
- Verify: no orphan computations (computed but never consumed by any child or render path)

# Async/sync correctness
- Verify: no synchronous blocking calls (std::process::Command) inside async Tauri commands
- Verify: all IPC commands have timeout or cancellation mechanisms on the frontend
- Verify: error paths propagate to UI (no silent swallowing of rejections)

# State update reachability
- Verify: every user-facing state (loading, error, success) is reachable via a code path
- Verify: state transitions are ordered correctly (can't go from "idle" to "success" without passing through "loading")

# Cross-worker contract
- Verify: event names emitted by Rust match event names listened for in TypeScript (exact string match)
- Verify: Rust struct field names (snake_case) map to TypeScript field names (camelCase via serde)
- Verify: optional fields in Rust (`Option<T>`) are handled as potentially undefined in TypeScript
```

**Anti-pattern — verification theater:** If an AI auto-test could pass on an empty file that happens to contain the right function name as a string, the test is invalid. Every auto-test must verify a behavioral property, not just string existence. `grep -n "functionName" file.ts` alone is NOT an acceptable auto-test — it must be paired with a behavioral assertion about how that function is called, what it returns, or how its output is consumed.

**Anti-pattern — visual theater:** For frontend/UI work, tests that only assert "page loads", "button exists", "no overlap", or "screenshot captured" do not verify design intent. A visual acceptance gate must compare the rendered screen to the Visual Canon: layout hierarchy, density, typography scale, spacing rhythm, visual isolation between panels/regions, control placement, and stated negative rules. If a worker cannot attach or cite the screenshot evidence path and explain whether it matches the canon, the visual test is invalid.

**Anti-pattern — audit-self-consistency trap:** If an audit script enforces only bidirectional referential integrity between two artifacts it itself emits or scans (e.g. "every command in source has an allowlist entry AND vice versa"), the script can pass with both artifacts undercounted relative to the spec. The audit must enforce parity against an *authoritative spec document* (PRD-mandated table, contract package exports, etc.), not against itself. Any printed message of the form "(PRD target: N)" / "(spec count: N)" that the script does not actually enforce is a verification-theater hazard — drop the message or convert it into an assertion. Pattern check: read each audit script the TaskSpec generates or modifies; if a number from the PRD appears as a log line but never as an `if (count !== N) exit(1)` assertion, that's the trap.

**Anti-pattern — escape-hatch brief language:** Worker briefs MUST NOT contain soft-narrator escape hatches like "if mismatch is significant, surface for PM review", "validate count and structure", or "PM blocker if significant" without a concrete threshold. Workers will resolve "significant" in their own favor and ship undercounted. Acceptable patterns: (a) a hard exit-nonzero gate ("Acceptance: count equals N; failure mode: STOP with `⛔ BLOCKED`"), or (b) a hard-required PM Playbook §4 question ("if count diverges by > <threshold>, append `⏳ PENDING` row to §4 and STOP"). Pattern check: grep generated worker files for `(significant|surface for PM|or close|approximately)` adjacent to a numerical claim; flag as a generation error and rewrite into one of the two acceptable patterns.

**Anti-pattern — one-sided contract import:** When two workers split a contract (one defines, one or more consume), the producer worker's acceptance criteria MUST include "schema/IDL imported by ≥1 file in each downstream consumer surface listed in Cross-Worker Integration Points." A schema imported only by the BFF and never by the client (or vice versa) is structural drift waiting to happen. Pattern check: every row in the Cross-Worker Integration Points table that names a contract package as Producer must have a matching consumer-count assertion in the producer worker's behavioral assertions or in a parity-audit worker's scope.

**Anti-pattern — tool-named identifier in framework code:** Per `learnings/process/unification-invariant-audit-playbook.md`, framework code under `protocol_adapter/`, `admission/`, `install_tools.rs`, `commands/tools.rs`, `tool_contract/`, `local_db.rs` (and equivalent generic-host modules) MUST NOT contain types, structs, enum variants, file/module names, or closed-union literals baked to a specific tool slug. Hits like `ProtocolEntry::OpenclawGateway`, `struct OpenClawDispatch`, `protocol_adapter/openclaw_gateway.rs`, `type X = "openclaw" \| "hermes"` are violations even if the body is fully generic — the name itself encodes a tool-specific assumption into the type system. Pattern check (mandatory at generation): see Step 2.4.5.A. Fix by renaming to the structural shape (`ws-typed-envelope`, `ToolMethodDispatch`, `ws_typed_envelope.rs`, `string`); per-tool data (manifest contents, schema files, i18n keys under `client.<toolId>.*`) is acceptable and explicitly carved out.

**Anti-pattern — test hardcodes tool slugs against shipping resources:** Per the 2026-05-16 addendum to `learnings/process/unification-invariant-audit-playbook.md` (surfaced by PR #567): tests that call `read_tool_manifest(&dir, "<slug>")` against the actual `resources/tools/<slug>/` are violations even though synthetic in-memory fixtures using slugs as stable identifiers are permitted. The right pattern iterates `shipping_tool_ids()` (helper at `src/test_support/shipping_tools.rs`); a new tool added under `resources/tools/` is then exercised by construction. The skill MUST refuse to emit test stubs matching the forbidden patterns in Step 2.4.5.C and MUST cite the helper location in the worker's Codebase Pointers.

**Anti-pattern — dead substrate helper (declared without consumers):** When a PRD names a contract helper, predicate, capability flag, or route attribute that other code is *expected to consume* in order to make the contract behave (e.g. `isPublicRoute(pathname)`, `public: true` route flag, `hasCapability("foo")`, `isBareRoute`, `@requiresAuth` decorator), the declaration site alone is not the contract — the **enforcement consumer** is. A PRD that introduces such a helper but ships only the declaration produces a *dead substrate*: every test passes against the declared shape, but runtime enforcement (auth gate, capability check, route protection) never reads the flag, so the declared behavior is never realized. **Real incident (clawso BATCH-5-GATE, 2026-05-15):** `routes.tsx` declared `/discover/skills` `public: true` and exposed `isPublicRoute()`; `AuthGate.tsx` was the enforcement substrate but consulted only `isBareRoute` (literal `/login` + `/auth/callback`); zero callers of `isPublicRoute` existed in the shell wrapper, so every anonymous `/discover/*` load redirected to login despite the public flag. The gate caught it post-deploy; investigation should have caught it pre-generation.

**Pattern check (mandatory at generation time):** For every contract helper, predicate function, capability flag, or route attribute named in the PRD or in any worker's `#### Codebase Pointers`, the skill MUST run:

```bash
# Definition site (must exist exactly once or in the PRD-stated location)
rg -n "^export (function|const) <helper-name>|<flag-name>\s*[:?]" <repo-root>/<scope>

# Enforcement consumer (the load-bearing check)
rg -n "<helper-name>\s*\(" <repo-root>/<enforcement-scope>     # for functions
rg -n "isPublicRoute|isBareRoute|hasCapability|<flag-name>" <repo-root>/<enforcement-scope>  # for flags read at runtime
```

If the definition exists but the enforcement-scope grep returns zero callers (or only the definition site itself), this is an **`XS-N` cross-bump substrate finding**. The generated TaskSpec MUST include a **W-0 foundation worker** in Batch 0 (or the earliest applicable batch) whose sole job is to wire the helper into its enforcement substrate, and every dependent per-bump worker MUST depend on that foundation worker. Generation MUST NOT proceed silently when a substrate helper is declared without a consumer — surface the finding and either add the foundation worker automatically or halt for HUMAN confirmation when the correct consumer site is ambiguous.

**Enforcement scope hints** (project-agnostic — adapt per repo):

| Helper class | Where the enforcement consumer should live |
|--------------|---------------------------------------------|
| Route `public`/`auth`/`role` flag | Shell auth wrapper (`AuthGate`, `RouteGuard`, route loader, middleware) |
| Capability flag (`hasCapability`, `requires`) | IPC gate, command dispatcher, admission validator |
| Server-side authz predicate | Route handler, RPC interceptor, BFF middleware |
| Feature-flag predicate | Render path, action dispatcher, scheduler eligibility check |
| Telemetry opt-out predicate (`isDNT`, `isGPC`) | Every emission site (analytics, error, metric) |

**Output:** every TaskSpec generated against a PRD that introduces a contract helper MUST contain either (a) a foundation worker (call it `W-0-substrate-<helper>` or similar) that wires the consumer and has acceptance criteria asserting the rg-callers count is ≥1 in the enforcement scope, or (b) an explicit `## Substrate Consumers Verified` block in `index.md` listing each PRD-introduced helper with its existing-consumer file:line evidence. Missing both is a generation error.

**Layer 3: Observable Acceptance Criteria** — 2-5 bullet points of runtime behavior the assigned workers or V-workers must verify. For each criterion, include a parenthetical noting which behavioral assertions or agent E2E checks serve as a proxy. Do not turn these bullets into HUMAN rows; post-round product review is out-of-band:
```markdown
- Progress bar shows with phase text, no raw terminal (proxied by: listener lifecycle + state reachability assertions)
- Auto-advances to Step 2 after install (proxied by: onAutoAdvance call path assertion)
```

### Step 4: Batch Assignment

| Batch | Contents | Rationale |
|-------|----------|-----------|
| 0 | PRE-FLIGHT environment health check | Gates all workers; catches drift before execution |
| 1 | DB schema Workers (no code deps) | Foundation; everything else reads these tables |
| 2 | Services that read DB (verify, MCP, BFF core) | Parallel after Batch 1 |
| 3 | Platform backend modules | Depend on Batch 2 service contracts |
| 4 | Admin backend | Depends on DB + BFF contracts |
| 5 | Frontend SPAs + CI/CD | Depend on backend APIs |
| 6 | Dead code removal / final sweep | Depends on all above |

Adjust batch count and grouping to fit the actual project. These are defaults, not requirements.

**Batch gate rule:** All batch N workers' PRs must be merged to main before batch N+1 workers can start. Workers in batch N+1 always branch from a main that contains all prior batch work.

### Step 4.4: Intra-Spec Consistency Validators (mandatory before finalizing the dispatch plan)

> **Why this exists (2026-05-14 audit retrospective):** A single TaskSpec generated W-05 with cron `15 4 * * *` *to dodge a 04:00 collision* and then independently generated E-03 with cron `0 4 * * *` — the very slot W-05 was warned away from. Same class of bug: W-09 depended on E-02 but both landed in the same Batch 5, so the meridian dispatcher had no signal to order them. These are self-consistency failures invisible to per-worker generation. Run the validators below before declaring the dispatch plan final.

**Validator A — Cron schedule collision check** *(runs when ≥2 workers define cron expressions)*

1. Extract every `crons = [...]` literal or `cron \`<expr>\`` reference from all worker files in this spec.
2. Append any cron entry the worker docs explicitly cite as a "must avoid" (e.g. `expert-escrow-timeout` 04:00) — these come from the codebase scan during Step 0.1 / Step 2.
3. Build a `{minute:hour}` collision matrix. Any two crons sharing the same `(minute, hour)` triggers a finding.
4. For each finding: emit a CONFLICT either resolve by shifting one cron 5/15/30 min and updating the relevant worker file, OR (if both crons are intentional and independent) inject a comment in each worker file noting the collision was reviewed and the workers have no shared downstream rate-limited resource.

**Validator B — Batch vs Depends-On graph check**

1. Build `worker_id → batch_number` map from the dispatch table.
2. Build `worker_id → [Depends On worker_ids]` map using the same delimiter semantics as Meridian: comma-separated clauses and ` + ` clauses. Treat only the exact ASCII hyphen `-` as a generated no-dependency sentinel.
3. Reject invalid empty/prose dependency cells before graph checks:
   - `PRE-FLIGHT` MUST have `Depends On` exactly `-`.
   - No generated Master Dispatch Table row may use blank, `none`, `None`, `N/A`, `NA`, `null`, `no deps`, `—`, or prose such as `all batch 1 workers` as a no-dependency or group placeholder.
   - Every non-`-` token MUST be either an exact Worker ID emitted in this plan or the exact special token `ALL-PRIOR`.
   - If a group dependency is needed, enumerate the worker IDs explicitly (`R-01, R-02`) or use `ALL-PRIOR`; do not rely on Meridian's broader prose group resolver in generated TaskSpecs.
4. For every edge `A → B` (B depends on A), assert `batch(A) < batch(B)`. Same-batch edges are illegal UNLESS the dispatcher contract guarantees serial ordering by `Depends On` within a batch — record which contract this spec relies on (meridian-roles' serial-per-tick is NOT enough; it serializes but does not topologically sort).
5. Findings: invalid dependency sentinel, unresolved dependency token, or same-batch dependency edge. Fix invalid sentinels to `-`, fix unresolved tokens to exact Worker IDs / `ALL-PRIOR`, and fix same-batch edges by promoting the dependency producer to an earlier batch or by adding an explicit batch gate.

**Validator C — Producer/Consumer contract presence check**

1. Walk the `## Cross-Worker Integration Points` table. For each row, extract the producer worker and the consumer worker(s).
2. For each pair, read the consumer worker's `#### Sub-tasks` and grep for an explicit reference to the producer's contract (export name, file path, schema name).
3. Findings: integration rows whose consumer worker doesn't reference the producer at all. Fix by adding a sub-task in the consumer that names the import / fetch / schema.

**Validator D — Runtime-target API compatibility check** *(runs when worker code calls platform-restricted APIs)*

For each worker, scan generated code blocks for the patterns below and confirm the worker's declared **Runtime** can execute them. Mismatch is a CONFLICT — pick a different mechanism and re-author the sub-task.

| API pattern | Runtimes that DO NOT support it |
|-------------|--------------------------------|
| `fs.promises.*`, `fs.writeFile`, `require('fs')` | Cloudflare Pages Functions, Cloudflare Workers, Tauri WebView renderer |
| `child_process.spawn`, `child_process.exec` | All CF runtimes; browser; renderer |
| `process.env` at module scope | CF Workers (use `env.X` from request handler); Tauri renderer |
| `node:net`, raw TCP sockets | CF Workers (use Sockets API or `fetch`) |
| Native `crypto` (Node) | CF Workers (use `crypto.subtle`); Tauri renderer (use `crypto.subtle`) |
| `eval`, `new Function` | CF Workers (blocked by isolate); strict CSP renderers |
| Tauri `invoke('cmd_name')` | Web (non-Tauri) build |
| `window.prompt` / `window.confirm` | Tauri 2 WKWebView (silently returns null/false — see clawso learning `tauri-webview-window-prompt-confirm-silent-failure`) |

**Validator E — Frontend Visual Canon coverage check** *(runs when any row touches rendered UI)*

1. Scan worker titles, runtimes, sub-tasks, and file paths for UI triggers: `frontend`, `UI`, `UX`, `page`, `component`, `layout`, `dashboard`, `editor`, `workstation`, `panel`, `toolbar`, `CSS`, `style`, `route`, `view`, `renderer`, `tsx`, `jsx`, `css`, `scss`, `tailwind`, `playwright`, `screenshot`.
2. For every triggered UI worker, verify it contains exactly one `#### Visual Canon` section with at least one absolute path or explicit PRD section reference and a non-empty `Negative Visual Rules` list.
3. Verify the dispatch plan includes a downstream `UX-GATE`, `DESIGN-GATE`, or UI V-worker that depends on the implementation rows and requires screenshot evidence plus comparison to the Visual Canon.
4. Verify the UI workers' acceptance criteria include visual/density/hierarchy checks, not only functional DOM presence.
5. Findings: missing canon, missing sample HTML/reference path, no screenshot comparison gate, or acceptance criteria that reduce visual intent to "no overlap". Fix by enriching worker briefs or stop and request PRD Visual Canon material.

**Skill validation rule:** if any validator finds a CONFLICT and the auto-fix is non-deterministic (multiple equally-good cron slots; multiple equally-good batch promotions), halt generation and ask HUMAN. Do not silently pick one. Document the chosen fix in the dispatch_plan's Notes column when the auto-fix is taken.

### Step 4.5: Batch Integration Gate (mandatory when batch has cross-worker dependencies)

After each batch gate (all workers in the batch `✅`), before proceeding to the next batch, the dispatch command must include a **Batch Integration Verification** step. This is a lightweight check that catches wiring issues between workers in the completed batch before downstream workers build on a broken foundation.

**When to include:** Include a batch integration gate when the batch contains 2+ workers that edit the same file, or when the next batch's workers depend on outputs from multiple workers in this batch.

**What it checks (worker-executable, no runtime needed):**
1. **Compilation still passes** after all batch workers' changes are merged
2. **Cross-worker behavioral assertions** from the Runtime Contracts section are satisfied (e.g., event listener ordering, data shape alignment)
3. **No orphan code** — values computed by one worker and expected by another are actually wired (not computed-but-never-passed or imported-but-never-called)

**Batch Integration Gate Template:**

````markdown
### BATCH-N-GATE — Batch N Integration Verification

- **Runtime**: Local (bash + code reading)
- **Delta Type**: REVIEW
- **Phase**: N (runs after all Batch N workers complete)
- **Priority**: P0
- **Depends on**: [all Batch N workers]
- **Model**: claude-sonnet-4-6::medium
- **Model Routing Rationale**: T1 cross-worker verification using known contracts; escalate only when real-binary or cross-runtime ambiguity materially raises proof burden
- **Internal Delegation**: forbidden

#### Sub-tasks

**BATCH-N-GATE.1 — Compilation check**
- Run build/typecheck after all batch workers' changes
- **Acceptance**: Zero compilation errors

**BATCH-N-GATE.2 — Cross-worker wiring verification**
- For each Runtime Contract involving workers in this batch:
  - Verify producer event names match consumer listener names (exact string)
  - Verify async ordering invariants (listener before command, cleanup on unmount)
  - Verify computed values flow to consumers (no orphan computations)
- **Acceptance**: All Runtime Contract behavioral assertions pass

**BATCH-N-GATE.3 — Dirty-commit refusal (mandatory, v1.27.0)**
- Grep every commit message merged into this batch:
  ```bash
  cd <repo-root>/.worktrees/<taskspec-id>
  git fetch origin <PR-base-branch>
  git log --format='%H %s' origin/<PR-base-branch>..HEAD \
    | grep -iE "preserve.*(wip|residue|drift)|^[a-f0-9]+ (chore|fix)?:?\s*(wip|todo|fixme|fixup|stabilize)\b|dirty.*worktree|preserve.*pre-N"
  ```
- ANY matching commit is HARD-FAIL: `⛔ BLOCKED — WIP/residue/drift commit in batch <commit-sha>: <subject>`. A commit whose own message announces "preserve WIP / residue / drift / dirty worktree" is a signed admission the work is unfinished; the gate may NOT certify it as runtime-integration-verified.
- Carve-out (the only escape): a `pm_playbook.md` §1 entry with the commit SHA + dated PM approval + rationale. The gate then emits `BATCH-N-GATE.3 — Dirty commits carved out by Playbook §1.<N>` and proceeds. Silent acceptance is forbidden.
- **Acceptance**: zero unjustified dirty-commit messages.

**BATCH-N-GATE.4 — Real-binary integration probe (mandatory when batch touches admission / IPC / contract loading / installer / lifecycle code paths)**
- The gate MUST NOT certify "runtime integration" purely from `cargo check` + grep. It MUST launch the binary or service and probe the user-visible side effect the round was designed to deliver. Per `verification/test-green-is-necessary-not-sufficient`.
- The gate worker decides scope from the file set the batch touched (record the decision in the report). Mandatory probe classes:
  - **Admission / contract changes** (`admission/`, `tool_contract/`, `commands/tools.rs::load_contract`, `resources/tools/*/tool.json`): launch the binary (`npm run tauri -- dev` / `cargo run`); from webview console or test harness invoke `await invoke('tool_contract_load', {toolId})` for EVERY entry in `resources/tools/` (not a sample — every one). Assert no `E_TOOL_JSON_MISSING` / `E_TOOL_JSON_SCHEMA` / panic.
  - **IPC / RPC changes**: spawn a representative client per affected route; assert structured response shape AND no swallowed errors in stderr.
  - **Installer / lifecycle changes**: clean local state for ≥1 shipping tool; run install → assert `BOOTSTRAP_PHASE:activate-done` reached AND receipt status `succeeded`; run uninstall → assert UI state flips (no stale "已安装" / "Installed" badge).
- Capture full probe output verbatim in `reports/BATCH-N-GATE.md` under `## §4 Real-Binary Evidence`. Quoting `cargo check` output here is NOT acceptable — that is BATCH-N-GATE.1's job.
- If the batch genuinely touches none of these surfaces (rare; e.g. a pure-docs or pure-types batch), the gate MUST emit `BATCH-N-GATE.4 — Real-binary probe N/A: <file:line evidence that no touched file is in scope>`. Silent omission is HARD-FAIL.
- **Acceptance**: at least one captured probe per applicable scope, with the probe enumerating every representative tool/route (no sampling shortcut).

**BATCH-N-GATE.5 — Observability gate (mandatory when batch touches framework error-emission paths)**
- Audit every `tracing::error!`, `tracing::warn!`, `console.error`, `debugRecorder.error` site introduced or moved by this batch. For each, prove the channel delivers:
  - Rust framework code: a `tracing_subscriber::fmt()` (or layered subscriber) MUST be initialized in the binary's `main` / `run()` entry. Declaring `tracing-subscriber` in `Cargo.toml` without an init call is a swallowed channel — HARD-FAIL.
  - TS framework code: `console.error` / `debugRecorder.error` MUST be reachable from the test harness or wired to the unified observability stream. A bare `catch {}` or `catch(e) { setState(null); }` that drops the error path WITHOUT routing through `debugRecorder.error` is a swallowed channel — HARD-FAIL.
- For each verified site, record `<file>:<line> — <channel> — <evidence: subscriber init line, console.error capture, debugRecorder mock>` in `reports/BATCH-N-GATE.md` under `## §5 Observability Audit`.
- **Acceptance**: every error-emission site introduced by the batch has a verified delivery path. Per `verification/every-failure-channel-must-surface-as-err`.

**BATCH-N-GATE.6 — Report**
- If any of BATCH-N-GATE.1–BATCH-N-GATE.5 fails: report findings and **STOP with `⛔ BLOCKED`** — do not proceed to Batch N+1.
- If all pass: mark gate `✅` (under `--meridian` the lifecycle store owns this transition; worker emits `outcome: complete`) and proceed.
````

BATCH-N-GATE runs on its own branch (`<taskspec-id>/BATCH-N-GATE`) and creates its own PR, following the per-worker file + branch model.

**Why this exists:** The openclaw-fix incident had 9 workers across 3 batches, all self-certifying `✅`. No integration check ran until V-01 at the very end. By then, accumulated wiring issues between workers made every feature non-functional despite clean compilation. Batch integration gates catch these issues incrementally, when they're cheap to fix.

### Step 4.6: Final Integration and Merge Gate (mandatory for GIT-mode rounds)

After all implementation, batch-gate, and validation rows have completed, but before
POST-FLIGHT runs, GIT-mode TaskSpecs must include an `INTEGRATE` row unless the
round is explicitly single-row doc-only/no-code. This row converts "the work is
valid" into "the base branch actually contains the work and cleanup is safe."

**When required:** Emit `INTEGRATE` when any of these are true:
- Delivery Mode is `GIT` and the TaskSpec has 2+ non-teardown rows.
- Any row opens a PR that may remain open while checks, approvals, or conflicts resolve.
- The round uses a rollup, stack, validation branch, or superseded worker PRs.
- POST-FLIGHT would otherwise need to merge, wait on CI, close PRs, or delete remote branches.

**Omission rule:** For a single-row doc-only/no-code GIT TaskSpec, the generator may omit
`INTEGRATE` only if it writes `INTEGRATE omitted — single-row doc-only/no-code` in
`index.md` and in the dispatch-plan Notes cell. If there is any source-code PR, omit nothing.

**What `INTEGRATE` owns:**
1. Fetch the configured PR base branch from origin and compare it with any local base branch.
2. Refresh the integration/rollup branch against `origin/<PR-base-branch>`; fix base-drift failures surfaced by the refresh.
3. Run the final full verification gates named by the TaskSpec.
4. Apply the round's `Action Run Policy`, push the refreshed integration branch, and wait only for checks that policy classifies as required.
5. Merge the rollup or final PR into the configured base branch.
6. Confirm `gh pr view <pr> --json state,mergedAt,mergeCommit` reports `MERGED` and record the merge SHA.
7. Close/comment superseded worker PRs and delete obsolete remote TaskSpec branches.
8. Write `reports/INTEGRATE.md` with the final base branch SHA, merged PR URL(s), check results, closed superseded PRs, and remaining residual risk.

**What `INTEGRATE` must not do:** It must not remove the TaskSpec worktree. Worktree
teardown remains POST-FLIGHT's responsibility after `INTEGRATE` has proven all
merge work is complete.

**Generation rule:** `POST-FLIGHT` depends on `INTEGRATE` directly or via
`ALL-PRIOR`. `INTEGRATE` runs in the TaskSpec worktree; POST-FLIGHT runs in the
primary checkout.

**Rollup/stack mode rule:** If the TaskSpec chooses a rollup/integration branch
instead of per-worker merge, every worker file whose PR will be superseded must
say so explicitly in its Completion Protocol: the worker must push its branch,
open/update its review PR when useful, ensure its commit is included in the
integration branch, and report `represented-by: <integration branch or PR>`.
Only `INTEGRATE` merges to the base branch and closes superseded PRs. Do not mix
"worker PR must merge itself" language with rollup mode in the same worker file.

### Step 4.6.1: Action Run Policy (mandatory for GIT-mode rounds; v1.29.0)

Before rendering `INTEGRATE.md`, worker Completion Protocols, or PR templates, the generator MUST classify the repository's action/check policy and emit it in `index.md`, `dispatch_plan.md`, and `dispatch_command.md` Round Context.

Allowed values:

| Policy | Meaning | INTEGRATE behavior |
|---|---|---|
| `action-run-opt-in` | GitHub Actions are intentionally default-off unless an explicit marker or flag opts in. Clawso's `[run-action]` contract is the canonical example. | Do not add opt-in markers. Do not call `workflow_dispatch`, rerun jobs, or require billing/spending-limit repair for skipped opt-in-gated jobs. Treat opt-in detector jobs and downstream skipped Actions as neutral unless the TaskSpec/user explicitly opted in. |
| `required-checks` | Branch protection or project release policy requires named checks before merge. | Wait only for those required checks. A failed required check is a blocker; skipped optional jobs are not. |
| `no-actions` | The repo does not use GitHub Actions/checks for this delivery path. | Merge authority comes from local verification, branch protection mergeability, and any target-side checks named by the TaskSpec. Do not invent a CI wait. |
| `unknown` | The generator cannot determine the policy from project docs, branch protection, PRD, or ship skill. | Emit a PM question or force INTEGRATE to classify live check state before merge. Do not default to "must wait for all GitHub Actions." |

Classification inputs, in order:

1. Project ship skill / learnings / laws that define the release path. For Clawso, `/ship-changes` says not to include `[run-action]` unless `--git-action` was explicitly passed.
2. PRD §P process fixes or user instruction that explicitly opts into or out of GitHub Actions.
3. Branch protection / mergeability signals from GitHub (`gh pr view --json mergeStateStatus,statusCheckRollup` and, when accessible, branch protection required check names).
4. Current PR body/commit messages. A literal `[run-action]` or equivalent opt-in marker means the worker chose the Actions lane and Actions failures become real blockers.

Generated artifact requirements:

- `index.md` header includes `**Action Run Policy**: <value>` and `**Action Run Policy Rationale**: <source/path or one-line evidence>`.
- `dispatch_plan.md` header includes `**Action Run Policy**: <value>`.
- `dispatch_command.md` Round Context includes `Action Run Policy: <value>`.
- PR bodies and commit messages MUST NOT include `[run-action]` or any project-specific Actions opt-in marker unless the user/PRD explicitly requested the Actions lane (for Clawso, `/ship-changes --git-action`).
- INTEGRATE's report must classify every non-success check it sees as `required-blocker`, `optional-failed`, `skipped-by-policy`, or `neutral`, with evidence.

Hard rule: skipped or failed "detect opt-in" jobs are NOT merge blockers under `action-run-opt-in` when the operator did not request the Actions lane. The correct behavior is to record that Actions were intentionally skipped and merge using the TaskSpec's local/runtime verification plus any truly required target-side checks.

### Step 4.6.5: Merge Mode Selection (mandatory before Step 5; v1.27.0)

The skill MUST decide between **per-worker-merge** and **rollup/stack** mode at generation time, BEFORE any worker file's Completion Protocol is rendered. The decision lives in `index.md` and `dispatch_plan.md` headers; worker Completion Protocols, dispatch_command Step 5f/5h, and INTEGRATE.md all derive from it. The previous behavior — per-worker-merge as a silent default — is the direct cause of the 2026-06-05 `agent-dispatcher-666ecd32` base-branch poisoning incident (Rust contract rename in N-02 merged to `feat/client-rebuild--v3`; manifest migration delayed to BATCH-2's `5f2c8a85`; ~30-hour window where every dev build on the base branch panicked at admission with `E_TOOL_JSON_SCHEMA: Tool manifest invalid`).

**Trigger — rollup/stack is MANDATORY when ANY match:**

1. **Cross-worker semantic rename** — two or more workers split a single rename or contract cutover across (a) a TS/Rust type and (b) a JSON / manifest schema; OR (a) a server contract and (b) a client adapter that consumes it. Per-worker-merge guarantees base is broken between A and B. (Canonical case: N-02 `ToolLlmBinding` → `ToolProviderBindings` Rust rename + BATCH-2 `5f2c8a85` manifest migration.)
2. **Schema bump consumed by 2+ runtimes** — a contract package (`packages/api-contracts/`, IDL, OpenAPI) bump consumed by 2+ runtime/service workers. Mid-merge state breaks every consumer that hasn't yet shipped its half of the cutover.
3. **Multi-row migration with invalid intermediate state** — a DB or `app_config` migration whose row-by-row intermediate state would violate runtime invariants (e.g. N-03 rewrites all `tool-llm-binding-*` keys but the new resolver fallback chain doesn't ship until N-06).
4. **PRD §P Process Fix mandates integration branch** — explicit "all work behind a flag / single integration branch / atomic cutover" requirement.
5. **≥5 implementation workers AND no per-worker shippable unit** — when no individual worker's PR represents a user-visible shippable increment, rollup avoids polluting base with partial work.

**Trigger — per-worker-merge is appropriate ONLY when ALL hold:**

- None of the rollup triggers above match.
- Workers are independent (no cross-worker contract rename or schema bump).
- Each worker's PR represents a self-contained shippable increment that base can absorb safely.
- A failed/abandoned worker can be revert-merged from base without disturbing other workers.

**Default when uncertain: rollup.** Per-worker-merge is the special case (small, decoupled, naturally-shippable rounds), not the default.

**Emit the decision (mandatory artifacts):**

1. **`index.md` header**, immediately after `**Date**:`:
   ```markdown
   **Merge Mode**: rollup | per-worker-merge
   **Integration branch** (rollup only): `<taskspec-id>/integration`
   **Merge Mode Rationale**: <1–2 sentence justification citing the trigger>
   ```

2. **`dispatch_plan.md` header**, immediately after `**Delivery Mode**:`:
   ```markdown
   **Merge Mode**: rollup | per-worker-merge
   ```

3. **PRE-FLIGHT.W (rollup only)** — add a sub-task that creates and pushes the integration branch BEFORE any implementation worker dispatches:
   ```bash
   cd <repo-root>
   git fetch origin <PR-base-branch>
   if ! git rev-parse --verify origin/<taskspec-id>/integration >/dev/null 2>&1; then
     git branch <taskspec-id>/integration origin/<PR-base-branch>
     git push -u origin <taskspec-id>/integration
   fi
   ```

4. **Worker Completion Protocol** — the generator emits ONLY the variant matching the chosen Mode:
   - **per-worker-merge**: existing §3 = `gh pr create --base <PR-base-branch>`; §4 = `gh pr merge --merge`; §5 = resync to `<PR-base-branch>`.
   - **rollup**: §3 = `gh pr create --base <taskspec-id>/integration --title "[<WORKER_ID>] review-only — represented-by <taskspec-id>/integration"`; §4 is REPLACED with a roll-up-into-integration block (worker checks out integration, merges its own branch with `--no-ff -m "[<taskspec-id>] roll up [<WORKER_ID>]"`, pushes integration); §5 resyncs to `<taskspec-id>/integration` NOT `<PR-base-branch>`. The review-only PR stays OPEN; INTEGRATE closes it after the base merge.

5. **dispatch_command.md Step 5f / 5h** — the generator references the Round Context `Merge Mode` field. Under rollup, 5f's `--base` argument is `<taskspec-id>/integration`; 5h is replaced with "do not merge to base — INTEGRATE owns this; verify your commit is on origin/<taskspec-id>/integration before reporting `outcome: complete`."

6. **INTEGRATE.md** (Mode-aware):
   - **per-worker-merge**: INTEGRATE verifies every worker PR is `MERGED`, does final base refresh + cleanup, closes any straggling review PRs.
   - **rollup**: INTEGRATE owns the actual base merge — opens the umbrella PR from `<taskspec-id>/integration` → `<PR-base-branch>`, applies the Action Run Policy, waits only on policy-required checks, merges (squash or merge-commit per PRD §P preference), comments + closes every superseded worker review PR with `superseded by #<umbrella>`, deletes obsolete worker branches.

**Hard rule:** A TaskSpec MUST NOT mix the two modes. Workers either ALL merge to base, or ALL merge to integration. The `Merge Mode` header field is the single source of truth.

**Validation (post-generation):**

When `Merge Mode: rollup`, the generator MUST assert:
- Every worker's Completion Protocol §3 targets `<taskspec-id>/integration`, never `<PR-base-branch>`.
- No worker file contains `gh pr merge` in its Completion Protocol (only INTEGRATE does).
- PRE-FLIGHT.W creates and pushes the integration branch.
- INTEGRATE.md performs the first-time merge of integration → base.
- dispatch_command.md Step 5f/5h emits the rollup variant.

When `Merge Mode: per-worker-merge`, the generator MUST assert:
- Every worker's Completion Protocol §3 targets `<PR-base-branch>`.
- Every worker's Completion Protocol §4 contains `gh pr merge`.
- INTEGRATE.md is reduced to verification + cleanup (no first-time merge).
- No worker file references `<taskspec-id>/integration` as a merge target.

**`--append` mode:** the existing TaskSpec's `Merge Mode` is binding for appended workers. The skill MUST read the existing `index.md` / `dispatch_plan.md` header and emit `⛔ BLOCKED — appended worker Completion Protocol disagrees with existing Merge Mode` if the appended generation would emit conflicting Mode language. Mixing modes within one TaskSpec is forbidden even on append. If the existing TaskSpec has no `Merge Mode` field (pre-v1.27.0 TaskSpec), assume `per-worker-merge` for back-compat but surface a warning so PM can decide whether to convert the round to rollup before appending more work.

### Step 5: Model Assignment (per-worker evaluation mandatory)

**Output contract — canonical IDs only, no legacy aliases.**

Every dispatch-plan Model column value MUST be a canonical `<modelId>` or `<modelId>::<effort>` string that the Meridian runtime can resolve verbatim. Legacy aliases (`OPUS`, `SONNET`, `CODEX`, `CODEX-HIGH`, `CODEX-XHIGH`, `GEMINI`) are deprecated for new TaskSpecs.

**Why explicit IDs:** Aliases are mutable. A TaskSpec must specify the exact model chosen at planning time so reruns produce the same route regardless of terminal defaults. The Meridian dispatcher reads the dispatch-plan row as the source of truth.

**Effort syntax:** `<modelId>::<effort>`. Claude supports `low | medium | high | xhigh | max`. Codex GPT-5.6 Sol/Terra support `low | medium | high | xhigh | max | ultra`; Luna supports through `max`. Omit `::<effort>` only when the provider does not consume reasoning effort (Gemini below).

#### 5.1 Difficulty tiers

| Tier | Description |
|------|-------------|
| **T0** | Bounded/mechanical: deterministic environment checks, doc-only edits, narrow cleanup, single-file changes with obvious verification |
| **T1** | Everyday delivery: well-specified rework, standard CRUD/schema/UI work, 2–3 coupled touchpoints, known implementation pattern |
| **T2** | High judgment: cross-layer contract work, nuanced business logic, multiple plausible approaches, interfaces consumed by 3+ workers, meaningful migration/recovery risk |
| **T3** | Frontier/high-consequence: ambiguous architecture, async/IPC/socket/lifecycle/streaming, weak-observability diagnosis, security/data-integrity boundaries, terminal integration with genuinely coupled proof obligations |

Tiers describe task difficulty; they do **not** permanently bind one model. The model family and effort are selected separately inside the tier.

**IPC is not an automatic T3 marker:** a synchronous, well-specified Rust/TS IPC shape change with locked interfaces may be T2. Escalate to T3 when IPC combines with async ordering, lifecycle/restart behavior, streaming, weak observability, security/data-integrity consequence, or unresolved architecture.

#### 5.2 Canonical model selection per provider

Pick the provider first (Claude / Codex / Gemini), then select:

1. **Family/capability** — the lowest family that can safely handle the ambiguity, coupling, and consequence.
2. **Effort/depth** — the lowest reasoning effort likely to close the row with adequate evidence.

**Claude family** (provider: `claude` — `--effort` flag wired through `Meridian/src/agents/claude.ts`)

| Tier | Default profile | Alternatives and selection rule |
|------|-----------------|---------------------------------|
| T0 | `claude-haiku-4-5-20251001::low` | Use `::medium` when the task is mechanical but failure classification needs care |
| T1 | `claude-sonnet-4-6::medium` | Raise to `::high` for debugging or stronger verification; do not jump to Opus for file count alone |
| T2 | `claude-opus-4-7::high` | Use `claude-opus-4-7::xhigh` for large, proven-pattern execution; use `claude-opus-4-8::high` when architectural novelty or unresolved ambiguity matters more than conservatism |
| T3 | `claude-opus-4-8::xhigh` | Raise to `::max` only for exceptional consequence/proof burden that cannot be reduced by splitting the row |

**Opus 4.7 vs 4.8 rule:** choose `claude-opus-4-7` for mature, well-understood patterns where the main challenge is careful execution or migration stability. Choose `claude-opus-4-8` for novel architecture, unresolved cross-layer trade-offs, difficult root-cause discrimination, security/data-integrity decisions, or final authority where a false pass is materially costly. “Newer exists” is not by itself a reason to use 4.8.

**Codex / GPT family** (provider: `codex` — effort is the primary tuning axis)

| Tier | Default profile | Alternatives and selection rule |
|------|-----------------|---------------------------------|
| T0 | `gpt-5.6-luna::low` | Use `gpt-5.6-luna::medium` for bounded edits with reference/compatibility checks |
| T1 | `gpt-5.6-terra::medium` | Use `gpt-5.6-terra::high` for ordinary debugging, moderate integration, or heavier proof |
| T2 | `gpt-5.6-terra::xhigh` | Use `gpt-5.6-sol::high` when ambiguity, cross-runtime contracts, or blast radius exceed Terra's everyday lane |
| T3 | `gpt-5.6-sol::xhigh` | Use `gpt-5.6-sol::max` for exceptional risk (verify forwardability first — Effort-Forwardability callout); `gpt-5.6-sol::ultra` only under the delegation gate below |

**Codex family rule:**

- **Luna** — fast and affordable; bounded mechanical work with deterministic proof.
- **Terra** — balanced everyday agentic coding; the default for normal implementation, debugging, testing, and review.
- **Sol** — frontier agentic coding; reserve for ambiguity, cross-system coupling, high consequence, or architecture-heavy work.

**`max` gate:** assign `max` only when all are true: (1) the row has unusually high ambiguity or consequence, (2) extra search/reasoning can materially reduce the risk, and (3) the row cannot be safely narrowed or split. Importance, lateness, large file count, or one failed attempt are insufficient.

**`ultra` delegation gate:** `ultra` enables automatic task delegation and is never a normal T3 synonym. It is valid only when:

1. The user or TaskSpec explicitly allows row-internal delegation.
2. The worker file declares `**Internal Delegation**: allowed`.
3. The owner still owns exactly one dispatch row; delegates may do bounded research/review/tests but may not claim other rows or mutate the dispatch plan.
4. The `## Model Routing Rationale` names why delegation is necessary and why `max` is insufficient.

If any condition is missing, cap at `max`. `gpt-5.6-terra::ultra` is allowed only by explicit user selection for a cost/latency-constrained delegated row; the generator never chooses it automatically.

**Legacy compatibility:** Existing TaskSpecs may retain pinned `gpt-5.4`, `gpt-5.5`, or `gpt-5.3-codex-spark` rows. Fresh TaskSpecs use GPT-5.6. Appended rows use GPT-5.6 unless the existing round declares a model-freeze policy or the user requests legacy parity. Never rewrite existing rows during `--append`.

**Gemini family** (provider: `gemini`)

| Tier | Canonical model column value |
|------|------------------------------|
| T0   | `gemini-2.5-flash` |
| T1+  | `gemini-2.5-pro` |

**Do NOT append `::effort` to Gemini model IDs.** The Gemini CLI exposes no thinking/reasoning flag; an effort suffix would parse cleanly upstream but be silently dropped before the Gemini API call. If a Gemini worker needs more reasoning headroom, escalate to a higher-tier model (Pro) instead.

**Manual authority gates** (rare): emit `HUMAN` only for non-automatable operator authority such as credentials, production-console actions, or explicit external decisions. This is not a model - it is a sentinel that pauses the row on operator sign-off. Do not emit `HUMAN` for GUI, UX, browser, staging, or product-acceptance checks; those are agent E2E rows with real model IDs.

#### 5.3 Per-Worker Model Evaluation Gate (mandatory)

Evaluate **every worker individually**. For each row, record these routing signals:

| Signal | Low | Medium | High |
|--------|-----|--------|------|
| Ambiguity | One obvious path | Several local choices | Competing architectures/root causes |
| Coupling | One surface | 2–3 connected surfaces | Cross-runtime, async, lifecycle, or many unlocked contracts |
| Blast radius | Easy local rollback | Shared package/service | Security, data integrity, release authority, irreversible migration |
| Reversibility | Cheap revert | Coordinated rollback | Destructive/external state or difficult recovery |
| Proof burden | Deterministic command | Tests + code-reading | Real runtime, weak observability, cross-worker synthesis |
| Latency/cost pressure | Strong | Balanced | Secondary to correctness |

Then route in this order:

1. **Set T0–T3** from the combined signals. Do not use file count as a proxy; a 20-file mechanical rename can be T0/T1, while a five-line authorization change can be T3.
2. **Select family** using §5.2. Choose the lowest family that safely covers the row.
3. **Select effort** independently. Start at the tier default and raise only for a named proof/ambiguity reason.
4. **Check decomposition first.** If `max`/`ultra` seems necessary because the row is broad rather than inherently atomic, split the row instead.
5. **Record rationale.** Every worker file gets `**Model Routing Rationale**: <signals + reason>`. `dispatch_plan.md` gets a non-strict `## Model Routing Rationale` table with `Worker / Tier / Model / Routing signals` after the strict Master Dispatch Table.
6. **Arm the external-state obligations.** If `Reversibility = High` (destructive / external state) or `Blast radius = High` (data integrity, irreversible migration), the row is **externally-stateful** and Step 5.3a applies. Record `**External State**: true` on the worker card.

#### 5.3a External-State Obligations (mandatory when armed by 5.3 step 6; v1.35.0 — FU-002)

> **Why this exists (clawso `unification-layer-decoupling-2026-08-06`, W1-03, 2026-08-09).** The round's only irreversible row completed its backup and then issued **zero** DELETEs, because two defects that were fully present in the card at generation time only surfaced at runtime. Both were discoverable before dispatch for essentially nothing — one static `grep` over migrations, and three read-only `count` requests.
>
> The root of it is a structural gap in this skill: **§5.3 already classifies rows as "Destructive/external state or difficult recovery" — and spends that classification entirely on model routing.** A row judged irreversible got a more expensive model and nothing else. But a model, however expensive, cannot derive a table it was never told exists. Classification must buy *verification*, not just *horsepower*.
>
> Symmetrically: the existing `PRE-FLIGHT` probes worktrees, UI availability, placeholder lint and canon identity — **all local, all code-side**. The one row in the round that mutated irreversible external state was the one target nobody probed.

An externally-stateful row carries two obligations **in addition to** its normal card content. Both are checked at generation time; failing either is a **HARD generation error**.

##### Obligation 1 — Scope-Derivation: the scope is derived, never enumerated

If the row's scope is "a set of entities inside a system that has a derivable dependency graph" — DB foreign-key graph, module import graph, package dependents, resource-reference graph — then:

- A hand-written entity list may only serve as the **seed set** (e.g. "these 14 legacy slugs").
- The **operative scope** must be produced by a derivation command that the card states verbatim.
- The generator emits and runs a closure assertion: `derive(seed) − enumerated_ledger = ∅`. Non-empty ⇒ HARD generation error naming the missing entities.

For a database, all three delete-behaviour classes must be named explicitly, because each fails differently:

| FK behaviour | Failure if omitted from the ledger |
|---|---|
| `ON DELETE RESTRICT` | Parent delete is **rejected** — the row physically cannot execute |
| `ON DELETE CASCADE` | Silently removes rows that may be on the **retention** list |
| `ON DELETE SET NULL` | Silently **mutates** surviving data |

Deletion order is the topological order of that graph — children first. ⛔ `TRUNCATE ... CASCADE` is never an acceptable substitute: it walks the same edges the retention list depends on.

```bash
# Static, no live connection needed — run this at generation time.
grep -rnE "REFERENCES (public\.)?(<parent-1>|<parent-2>)" <migrations-dir>/*.sql
# Every table this returns is either IN the ledger, or carries an explicit
# "not deleted and does not block" justification recorded on the card.
```

⚠️ **Adjacency is not awareness.** The W1-03 card already said 「外键需支撑索引，删前确认」 — it had anticipated that foreign keys affect delete *performance*, and still missed that foreign keys **define delete scope**. A card mentioning the mechanism does not satisfy this obligation; only a derivation command does.

##### Obligation 2 — Assertion-Grounding: every external-state assertion carries a measured pre-value

Every acceptance assertion about **pre-existing external state** must be accompanied, on the card, by:

1. the exact read-only command that measures it, and
2. the value that command returned **at generation time**.

Then:

- Measured non-zero ⇒ the assertion may say "non-empty and unchanged".
- Measured zero, or the entity does not exist ⇒ the assertion **must** be rewritten to a **count-invariant** form ("unchanged at 0", "no row of this family deleted"), with the reason recorded.

⛔ An assertion whose pre-value cannot be measured at generation time does not go on the card. An unprobed retention assertion is worse than no assertion: it reads as verified.
⛔ Never resolve a failing pre-value by **creating** state so the assertion becomes true.

> W1-03's card demanded post-delete re-verification that "the user Vault table is non-empty" and "the 7 delisted catalog records are non-empty". Measured: DBC has **no vault table at all** (the Vault is client-side, in `credential_broker.rs`'s Keyring), and live `market_listings` held `0` rows for those slugs. Both assertions were false **before** any deletion — copied from a product-level decision document that was never checked against the target.

##### Emission

An externally-stateful row's card gains one section, placed directly before `#### AI Auto-Tests`:

```markdown
#### External State Contract

- **Target**: <system> = <exact ref printed by a command, not a name>
- **Seed set**: <hand-written starting entities>
- **Derivation**: `<command>` → <N> entities  (closure assertion: derived − ledger = ∅ ✅)
- **Order**: <topological order, children first>
- **Measured pre-values** (taken <UTC>, read-only):
  | Assertion target | Command | Value at generation | Assertion form |
  |---|---|---|---|
```

**Typical routes:**

| Task shape | Claude | Codex |
|------------|--------|-------|
| Doc-only correction or deterministic env probe | Haiku `low` | Luna `low` |
| Single-file rename with compatibility checks | Haiku `medium` | Luna `medium` |
| Standard 2–3 file implementation | Sonnet `medium` | Terra `medium` |
| Reproducible multi-surface bug | Sonnet `high` or Opus 4.7 `high` | Terra `high/xhigh` |
| Mature large migration following a proven pattern | Opus 4.7 `high/xhigh` | Terra `xhigh` |
| Novel cross-layer contract or architecture | Opus 4.8 `high/xhigh` | Sol `high/xhigh` |
| High-consequence terminal integration with genuinely coupled evidence | Opus 4.8 `xhigh/max` | Sol `xhigh/max` |

Terminal names (`INTEGRATE`, `BATCH-N-GATE`, `V-*`) do not automatically imply Opus 4.8, Sol, `max`, or `ultra`; route from their actual obligations.

**Escalation after execution evidence:** a retry may move one step in effort or family only when the report identifies newly discovered coupling, competing hypotheses, inadequate verification, or capability failure. Do not escalate merely because a worker failed once.

**Availability gate:** Before finalizing model assignments, verify the canonical ID against the connected runtime catalog. For Codex, prefer the live/local Codex model catalog (for example `~/.codex/models_cache.json` when present); for Claude, use the connected Claude/Meridian catalog or an explicit operator-provided list. Pin the returned canonical ID. If the chosen model is unavailable, stop or document a same-provider fallback in `index.md`; never silently substitute another family/provider.

#### 5.4 Validation (post-generation)

- Every Model column value matches one of:
  - `^claude-[a-z0-9-]+(::low|::medium|::high|::xhigh|::max)?$` (Claude — effort optional)
  - `^(gpt-[0-9.]+(-[a-z-]+)?)::(low|medium|high|xhigh|max|ultra)$` (Codex — effort REQUIRED)
  - `^gemini-[a-z0-9.-]+$` (Gemini — NO effort suffix; runtime drops it)
  - `^HUMAN$` (manual authority gate sentinel only; never for GUI/browser E2E)
- No row contains `OPUS`, `SONNET`, `CODEX`, `CODEX-HIGH`, `CODEX-XHIGH`, or `GEMINI` literals.
- No Gemini row contains `::` — flag as a generation error (effort is silently dropped by the runtime adapter).
- No bare Codex `gpt-*` ID (without `::effort`) — Codex always carries an explicit effort.
- Every worker file contains exactly one `**Model Routing Rationale**:` line and one `**Internal Delegation**: allowed | forbidden` line.
- Every fresh Codex row uses `gpt-5.6-luna`, `gpt-5.6-terra`, or `gpt-5.6-sol` unless an explicit legacy/catalog exception is documented.
- Every `sol`, Opus 4.8, `max`, or `ultra` row has a concrete rationale tied to ambiguity, coupling, blast radius, reversibility, or proof burden.
- Every `ultra` row declares `Internal Delegation: allowed`; every other row defaults to `forbidden`.
- If all implementation workers have the same family **and** effort, `index.md` must contain `Homogeneous model assignment justified:` with a worker-by-worker reason; otherwise fail generation and re-evaluate.
- PRE-FLIGHT defaults to T0. BATCH-N-GATE defaults to T0/T1 and escalates only when its real-binary/cross-runtime obligations justify it.
- V-worker rows pick T1 / T2 / T3 by validation complexity. Browser, desktop, staging, and product-acceptance verification rows are model-assigned agent E2E rows. `HUMAN` is reserved for external authority gates only.

> **Note:** PM decisions are resolved pre-generation or via inline `⛔ BLOCKED` status when a worker hits an ambiguity. There is no separate PM model assignment.

#### 5.5 Worker-Class & Attended-UI Validation (v1.23.0 — embodied-acceptance trap)

This step runs after every worker file is decomposed but BEFORE any artifact is written to disk. Each sub-step is a **HARD generation error** on failure — the generator must stop, surface the offending worker IDs and excerpts, and ask the operator to revise the decomposition (or accept an automated rewrite that moves the offending sub-task to the proper class).

**5.5.a — Embodied-action keyword lint**

For every worker, scan the assembled `#### Sub-tasks` and `#### Acceptance Criteria` text for the keyword set:

```
foreground
screenshot
stopwatch
tauri:dev
npm run client:dev
"real desktop"
"manual measurement"
"press confirm"
"wall-clock"
cliclick
osascript
screencapture
```

Decision matrix by declared **Worker Class**:

| Class | Hit handling |
|---|---|
| `e2e-desktop` | Allowed. Worker MUST also declare `Requires Attended UI: true`. |
| `code` / `data` / `integration` / `preflight` / `postflight` / `review` | **HARD error.** The offending sub-task / acceptance line must be moved to an existing or new `e2e-desktop` worker. The source worker references the moved item as `delegated to <V-XX> per <law-or-PRD-ref>`. |

Rationale: embodied actions (clicking a real Confirm button, capturing a real screenshot, running a wall-clock stopwatch on real UI) cannot be performed by a headless code-class worker. Encoding such an acceptance criterion on a code worker is the structural mistake R-04 illustrated in v1.23.0; this lint catches it at generation time, before dispatch.

**5.5.b — Duplicate `(fixture, threshold, action)` triple detector**

From each worker's Sub-tasks / Acceptance Criteria, extract canonical `(fixture, threshold, action)` triples for any measurement-shaped statement. Examples:

| Source text | Extracted triple |
|---|---|
| "12-file × 2-agent attach, < 1500ms, in `npm run tauri:dev`" | `(12-file × 2-agent attach, <1500ms, foreground stopwatch)` |
| "1 000 messages persisted within 200ms p95" | `(1000-message persist, <200ms p95, throughput probe)` |

The extraction heuristic combines: a numeric fixture descriptor (count × count, "N rows", "X requests"), a comparator-with-threshold (`<`, `<=`, `>`, `≥`, "within", "under"), and an action verb (foreground / measurement / probe / stopwatch / E2E / smoke).

Cross-compare across the full worker set. The same triple may appear as a **mutable acceptance** in **at most one** worker. Every other reference to the same triple must be one of:

- `delegated to <owner-worker-id> per <ref>` — owner is the worker that holds the mutable acceptance.
- `mirrors <owner-worker-id>` — the worker only quotes the threshold as context, does not measure it.

A duplicate triple appearing as a mutable acceptance in two workers is a HARD error. The generator suggests the natural owner (typically a V-* worker if one exists with the same fixture; otherwise the worker with the lowest Phase number).

**5.5.c — Applied-Laws ↔ Acceptance consistency lint**

For every worker, parse its capsule's `## Applicable Laws` section (both the verbatim Statement text and the "Why it binds this worker" lines) for the phrasing set:

```
acceptance is the <other-worker> ...
acceptance is owned by <other-worker> ...
<other-worker> owns the acceptance ...
delegated to <other-worker> ...
acceptance contract is <other-worker> ...
real-binary acceptance is <other-worker> ...
```

When a match is found and `<other-worker>` resolves to an emitted worker ID, the matched worker's own `#### Sub-tasks` and `#### Acceptance Criteria` MUST NOT restate that same acceptance as a mutable requirement on itself. Concretely: if the Applied Laws section says "acceptance is the V-01 desktop run with measured latency < 1500ms" and the worker's Sub-task 6 still demands "Document the measured baseline (exact commands, hardware notes, total elapsed ms)", that is a HARD error.

The fix is one of:

- Remove the Sub-task / Acceptance restatement entirely.
- Mark it explicitly as `[delegated to <other-worker> per Applied Laws §<line-or-statement-ref>]`.
- If the worker actually owns the acceptance, remove the contradicting Applied Laws Statement.

Rationale: R-04's Applied Laws section already correctly cited V-01 as the acceptance owner. The validator and PM-resolver had no way to act on that signal because the same worker's Sub-tasks and Acceptance still demanded the measurement; the spec contradicted itself. This lint forces the generator to resolve the contradiction at write time.

**5.5.d — `requires_attended_ui` planwide invariant**

After all per-worker lints pass, the generator records the set `attended_ui_workers = { worker_id | Requires Attended UI == true }` in a generation-time map. When this set is non-empty:

- `index.md` MUST list it under a new `## Attended-UI Workers` section.
- `pm_playbook.md` §3 (Applied Principles & Laws) MUST include a row stating: "PRE-FLIGHT.UI foreground probe is a hard gate for this round; do NOT bypass."
- The PRE-FLIGHT Worker Template MUST include sub-task `PRE-FLIGHT.UI` (see PRE-FLIGHT Worker Template below). If the generator omits PRE-FLIGHT.UI while `attended_ui_workers` is non-empty, that is a HARD error.

When `attended_ui_workers` is empty (the common case for backend / data / contract rounds), PRE-FLIGHT.UI is omitted and no follow-on assertion is required.

**5.5.d2 — `external_state` planwide invariant (v1.35.0 — FU-002)**

The exact mirror of 5.5.d, for the other class of row that cannot be fixed by re-running it. The generator records `external_state_workers = { worker_id | External State == true }` (set by §5.3 step 6). When this set is non-empty:

- `index.md` MUST list it under a new `## External-State Workers` section, naming each row's target and its authorization artifact.
- `pm_playbook.md` §3 MUST include a row stating: "PRE-FLIGHT.X external target probe is a hard gate for this round; do NOT bypass. A stale deletion/mutation ledger is a PM correction, never a worker-side scope decision."
- Every row in the set MUST carry an `#### External State Contract` section that satisfies both Step 5.3a obligations. A missing or unmeasured contract is a HARD generation error.
- The PRE-FLIGHT Worker Template MUST include sub-task `PRE-FLIGHT.X`. Omitting it while `external_state_workers` is non-empty is a HARD error.
- Context Gates 8–10 are armed for this round.

When `external_state_workers` is empty, PRE-FLIGHT.X is omitted, Gates 8–10 stay disarmed, and no follow-on assertion is required — the whole mechanism costs a purely local round nothing.

⚠️ **Do not let a worker resolve a scope shortfall itself.** When a row discovers that its authorized ledger cannot be executed atomically (an unlisted blocking dependency, a scope lock that conflicts with reality), the correct worker action is `outcome: needs_pm` with **zero partial mutation** — and the correct PM action is to amend the ledger, not to widen the row's authority. Encode this in `pm_playbook §1` for every round with an externally-stateful row.

**5.5.e — Test-gate command-shape lint (v1.26.0 — `agent-dispatcher-4db3d871` r10 PRE-FLIGHT wedge)**

`cargo test`, `cargo nextest run`, and `cargo bench` accept at most ONE positional filter before `--`. Workers strictly executing a generated command like `cargo test foo bar` exit with a parser-shaped error and route to PM — wasting an entire PM-resolver slot on a TaskSpec authoring bug. The same trap exists for `npm test` / `pnpm test` invocations that concatenate filters where the runner needs `--`. This lint runs against the actual command strings written into worker files / dispatch_command.md / PRE-FLIGHT gates AFTER any per-worker substitutions; it is a HARD generation error.

**Cargo rules:**

- `cargo test` / `cargo nextest run` / `cargo bench` — at most ONE positional token before `--`. Additional filters MUST be moved AFTER `--`.
  - ✅ `cargo test integration_smoke`
  - ✅ `cargo test integration_smoke -- --nocapture`
  - ✅ `cargo test -- foo bar baz` (no positional before `--`; runner-side filters)
  - ✅ `cargo test integration_smoke -- bar baz` (one before, additional after)
  - ❌ `cargo test foo bar` → HARD error; rewrite to `cargo test -- foo bar` OR `cargo test foo -- bar`
- `-p <crate>` consumes its argument and does NOT count as a positional filter. Allowed:
  - ✅ `cargo test -p clawso-bff integration_smoke -- --nocapture`
- `--test <name>` is a flag, not a positional. Allowed:
  - ✅ `cargo test --test integration -- foo bar`
- Two `--` separators or zero positional + zero post-`--` filters are inert and should be flagged as a soft warning (probably an authoring slip), not a HARD error.

**NPM / PNPM rules:**

- `npm test`, `pnpm test`, `npm run test`, `pnpm run test`, `npm exec test`, `pnpm exec test` — `--` is required before any args bound for the test runner (Jest, Vitest, etc.) when the script is wrapping a package script:
  - ✅ `pnpm test`
  - ✅ `pnpm test -- foo bar`
  - ✅ `pnpm vitest run foo bar` (direct runner, no package-script wrapper, no `--` required)
  - ❌ `pnpm test foo bar` → HARD error; rewrite to `pnpm test -- foo bar`
- Same rule applies to `yarn test <a> <b>` even though yarn historically forwarded args; treat all package-script wrappers identically.

**When the lint fires, the generator MUST:**

1. Report the offending file path (worker file, dispatch_command.md, etc.) + line + the raw command string.
2. Propose the canonical rewrite (move all but the first positional behind `--`, or move all positionals behind `--` when there are zero pre-`--` filters).
3. Either apply the rewrite automatically when unambiguous OR stop with a structured error asking the operator to confirm (when the filters could be either workspace selectors or test-name filters).

**Out-of-skill follow-up:** Meridian-roles' `meridian-tool run` could defensively reject malformed Cargo invocations (tracked under the broader P-1/P-2 watchdog reaper work in `/Users/yzliu/work/Meridian/Meridian-roles/src/roles/agent-dispatcher/`), but the canonical author surface is this skill. Catching the bug at TaskSpec emit time is strictly cheaper than catching it at worker run time.

### Step 6: Generate Artifacts

Generate in order: **(pre-step A) Per-Worker Laws Curation sweep** (Step 2.8 — done once, in-memory map preserved) → **(pre-step B) Per-Worker Learnings Curation sweep** (Step 2.7 — done once, in-memory map preserved) → **(pre-step C) Round directory + sub-folder scaffold**: under `<Docs root>/branch/<taskspec-id>/`, ensure the `taskspec/`, `taskspec/reports/`, and `test/` sub-folders exist (create empty if absent); leave any pre-existing `prd/` and `investigate/` sub-folders untouched.

> ⚠️ **`taskspec/reports/` MUST exist before the first worker spawns (v1.31.1 — verified against meridian source).** Meridian derives `expected_outputs` through a four-level fallback chain (`tool-gateway/tools/run.ts::deriveExpectedOutputs`): plan row → `Write report to: \`...\`` regex on `dispatch_command.md` → **`reports/` convention** → terminal `dev_history/<worker>_report.md`. v1.32.0 keeps a one-line `Write report to: \`reports/<WORKER_ID>.md\`` declaration in `dispatch_command.md` (see Artifact 3) so the regex level fires directly. The directory requirement below remains the backstop for rounds that omit it — if the regex level is absent the chain lands on the `reports/` convention, and `deriveExpectedOutputFromConvention` returns `reports/<WORKER_ID>.md` **only when the directory already exists** (*"reports/ dir exists but empty — use short name"*). If it is missing, meridian falls through to `dev_history/<WORKER_ID>_report.md` while the worker writes to `reports/<WORKER_ID>.md`; lifecycle then sees no fresh report, **rejects `outcome: complete`, and the row stays `running` while the reconciler retries.** Creating the empty directory at generation time is the whole fix. → **`taskspec/plan.json` (Canonical Task Graph — Step 2.9; build it BEFORE any artifact so everything derives from it)** → TaskSpec `index.md` → individual worker files (`<WORKER_ID>.md`, each UI-facing worker with `#### Visual Canon`, each worker with the one-line `#### Applicable Laws` capsule pointer followed by its curated `#### Referenced Learnings` section) → **all Context Capsules `context/<WORKER_ID>-context.md` (Step 2.8.5a — same pass, not per-wave)** → Dispatch Plan → Dispatch Command → **PM Playbook scaffold** (with §3 seeded from the laws curation map) → **Step 6.5 Test Guide** (see below — mandatory; Chinese by default).

**Sweep ordering rule (mandatory):** both sweeps MUST run before any worker file is written. Laws sweep runs first because PM Playbook §3 (Applied Principles & Laws) is seeded from the per-worker laws curation map. Worker file generation reads from the two in-memory curation maps; it does NOT re-read either directory per worker. If a sweep was skipped because the corresponding directory does not exist, every worker file's section emits the verbatim N/A line for that source (still required, never omitted).

**Frontend artifact rule:** when Step 0.2 triggers, the Visual Canon extraction summary MUST exist before worker files are written. Every UI implementation worker and UI V-worker receives its own `#### Visual Canon` section; the test guide receives a "视觉参考" / "Visual Reference" note telling human testers which screenshots or sample pages the shipped UI should resemble.

**PM Playbook generation rule (mandatory):**

- Always create `pm_playbook.md` from the **PM Playbook Template** (see template section below). It is never optional, even when there are no known blockers or principles at generation time — the file exists to be filled in during the round.
- Pre-populate §3 (Applied Principles & Laws) with any cross-cutting rules already evident from the input PRDs (e.g. "compliance: all PII writes audit-logged"). Mark each entry with `Added by: TaskSpec generation, Date: <today>`.
- Pre-populate §4 (Open Questions) with any unresolved PM Blocker resolutions copied from the input fix PRD or `index.md`'s PM Blocker Resolutions section that are still `⏳ PENDING`. Cross-reference by question text so PM does not double-track.
- Leave §1 and §2 with empty tables plus the inline instructions block — these grow during execution. **Exception (v1.35.0):** when `external_state_workers` is non-empty, seed §1 with two rows so the round does not have to rediscover them mid-flight:
  - *Trigger* `ON DELETE RESTRICT` / unlisted dependency / cannot deliver atomically → *Resolution*: the worker stopping is **correct**; the ledger is the defect. PM amends the authorizing artifact (append-only if it belongs to a completed row), re-derives the closure, and updates the pinned `sha256` in the consuming capsule. A worker never widens its own scope, and never partially mutates.
  - *Trigger* a retention/"must remain non-empty" assertion that is already false before the mutation → *Resolution*: the assertion named state the target does not have. Re-measure, rewrite to count-invariant form, record the reason. Never restore the "non-empty" wording to pass, and never create state to satisfy it.
- **`--append` mode:** Never overwrite an existing `pm_playbook.md`. If one exists, leave it untouched and only append a single changelog comment at the bottom noting that new workers were added in version `<X.Y>`.

---

### Step 6.5: Test Guide Generation (mandatory — Chinese by default)

After all dispatch artifacts are written, the skill MUST emit a human-oriented **deploy-test guide** into the round directory's `test/` sub-folder. This guide is what PM hands to a HUMAN tester (typically a non-engineer end-user) after the round ships, and it is also the canonical location for the human test-pass report that closes the round.

**Output path (mandatory, derived):**

```
<Docs root>/branch/<taskspec-id>/test/<YYYY-MM-DD>-<project>-<branch-feature>-test-guide.md
```

- `<YYYY-MM-DD>` — today's date in ISO format.
- `<project>` — short slug (e.g. `mumu`, `clawso`). Default: trailing path component of `<Docs root>`.
- `<branch-feature>` — short slug derived from the TaskSpec ID with any trailing date stripped (e.g. TaskSpec ID `category-workbench-2026-05-26` → `category-workbench`). May also be the deploy-vehicle label such as `merge-deploy` when the round is purely a deploy/integration pass.

**Language:** Chinese (Simplified, `zh`) by default — match the reference example at `/Users/yzliu/work/Docs/Projects/mumu/branch/category-workbench-2026-05-26/test/2026-05-26-mumu-merge-deploy-test-guide.md`. Switch to English only on explicit user request (`--test-guide-lang en` or equivalent free-form ask in Step 0).

**Mandatory for every round:**

- GIT-mode UI rounds → full numbered test cases derived from worker acceptance criteria + PRD success criteria.
- GIT-mode backend / contract rounds → test cases that drive any user-visible side effect (admin pages, API responses, exports). If truly headless, generate a guide with a minimal **冒烟检查** (smoke check) section pointing at observability surfaces.
- NO-GIT / doc-only rounds → still emit the file, but the body MAY be a single section `## 本轮无需 UI 测试` followed by a one-paragraph explanation of why (e.g. "本轮仅更新内部文档，无线上验证项"). The file's existence is itself the contract.

**Generation inputs** (read in this order, in-memory only — do NOT modify):

1. PRD(s) from `<Docs root>/branch/<taskspec-id>/prd/*.md` (or the absolute paths declared in Step 0). Extract user-facing flows + acceptance criteria.
2. Worker `<WORKER_ID>.md` files just generated — collect every `#### Acceptance Criteria` block whose conditions are observable in a deployed UI/console, not just in unit tests.
3. The PRD's §1.4 (or equivalent "success criteria") section, if present.
4. PM Playbook §3 — any cross-cutting principle that affects the test surface (e.g. "all 4 categories must remain isolated") becomes a test case.
5. For UI-facing rounds: the Step 0.2 Visual Canon sources and extracted negative rules. Include the reference path(s) in the guide so human testers know what visual target they are judging against.

**Required sections (in order; section headers are H2, in the target language):**

| # | Section (Chinese label) | Section (English label) | Content |
|---|-------------------------|-------------------------|---------|
| Header | (no heading) | (no heading) | Title `# <project> <round-title> 线上测试指南` / `# <project> <round-title> Production Test Guide`, then a metadata block: 更新时间 (timestamp), 测试地址 (URL), 测试账号 (account), 测试密码 (password). Use placeholder values when unknown — PM fills them in. |
| 1 | 当前状态 | Current Status | One paragraph stating what is deployed, plus a bullet list of preconditions ("登录可用 / 4 个分类已开通 / 任务进度面板已恢复"). Empty checkboxes are acceptable. |
| 2 | 测试前准备 | Pre-test Setup | Browser/incognito guidance, files / fixtures the tester should prepare, what to record when an issue is found (screenshot, steps, classification, time). |
| 3+ | 编号测试项 | Numbered Test Items | One H2 per test item; sub-sections **操作步骤** (numbered list) and **通过标准** (bulleted list). One H2 per testable acceptance-criterion bundle from workers/PRD. Aim for 8–15 items for a normal feature round; doc-only rounds may have 0–1. |
| N-1 | 测试记录表 | Test Record Table | Markdown table: 测试项 / 结果 (PASS/FAIL) / 证据 / 问题描述. One row per H2 item from §3+. |
| N | 问题反馈格式 | Issue Feedback Format | Bulleted template a tester pastes when filing a bug: 测试项, 分类, 项目/页面名, 操作步骤, 实际结果, 期望结果, 截图或录屏, 发生时间. |

**Test-item authoring rules:**

- Phrase **操作步骤** as imperative actions a non-engineer can execute (open URL → click button → fill field → save). Do NOT mention internal terms like "worker", "PR", "dispatch", "lifecycle".
- Phrase **通过标准** as observable outcomes (页面不空白 / 名称不重复 / 列表能看到 / 保存后刷新仍在). Avoid implementation jargon ("the state object retains its identity") — use end-user language.
- Cover **regression-prone surfaces** even if not in this round's PRD when prior rounds have left a known flaky surface (cross-check `<Docs root>/branch/<prev-taskspec-id>/test/*-test-report*.md` if any). Mark such items with `(回归项 / regression check)` in the H2.
- For UI-facing rounds, include at least one visual comparison item that tells the tester to compare the deployed screen against the Visual Canon screenshot/sample HTML: hierarchy, density, spacing, panel isolation, typography scale, and rejected negative patterns. Require a screenshot/recording if the tester marks it FAIL.
- If a test item requires elevated access (ADS admin console, infra panels), put it at the end and prefix the H2 with `(仅限管理员)` / `(admin only)`, plus a sentence telling regular testers to skip.
- Never include credentials, tokens, or secrets in the file. Use placeholders the PM substitutes locally before sharing.

**Layout / sibling-file invariants:**

- This skill writes ONLY the test guide file. It does NOT write `<...>-test-report-*.md`, `findings.md`, or anything else inside `test/`. Those are HUMAN-owned outputs created after the test pass.
- Never overwrite an existing test guide file with the same filename in the same round. If the same filename already exists (e.g. re-run on the same day), append a numeric suffix: `...-test-guide-2.md`, `-3.md`, etc. Surface the new filename to the user in the final summary.
- The skill MUST NOT modify any file under `prd/` or `investigate/` at this step.

**`--append` mode:** When appending workers to an existing TaskSpec, the skill regenerates the test guide as a NEW file with today's date (or `-2`, `-3` suffix if the same date already has one). The original test guide is preserved as a historical record. The new test guide covers the appended workers' acceptance criteria and the regression-prone surfaces from the round so the tester has one document per dispatch pass.

**Post-generation report (mandatory):** when the skill finishes Step 6.5, surface the absolute test-guide path in its end-of-run summary so the user can immediately review and customize it.

See the **Test Guide Template** section below for the exact Chinese skeleton.

---

## Test Guide Template (Chinese, default)

````markdown
# <project> <round-title> 线上测试指南

更新时间：<YYYY-MM-DD HH:MM> <TZ>
测试地址：<https://example.com/path>
测试账号：`<account>`
测试密码：`<password>`

## 当前状态

本轮功能已经发布到线上测试环境。请只使用上面的测试地址进行测试。

测试前已确认：

- [precondition 1，例如：账号可以登录]
- [precondition 2，例如：当前分类/页面可见]
- [precondition N]

视觉参考（如本轮包含 UI 改动）：

- 参考截图 / 样例页面：<absolute visual canon path or URL>
- 本轮必须避免的问题：<negative visual rule summary>

## 测试前准备

建议使用无痕窗口或新浏览器窗口，避免旧缓存影响测试。

请准备 [文件/账号/数据] 以便覆盖以下测试场景：

- [resource 1]
- [resource 2]
- [一个不支持的输入用例，用来测试拒绝路径]

记录问题时请保留：

- 页面截图。
- 出问题前做了哪些操作。
- 涉及的页面 / 分类 / 项目名称。
- 大概发生时间。

## 1. <第一个测试项标题>

[1–2 句背景，例如告诉测试者在哪个页面、哪个分类下测试]

操作步骤：

1. <step 1>
2. <step 2>
3. <step 3>

通过标准：

- <observable outcome 1>
- <observable outcome 2>
- <observable outcome N>

## 2. <第二个测试项标题>

...

## N. <最后一个测试项>（可选：(仅限管理员) / (回归项)）

操作步骤：
1. ...

通过标准：
- ...

## 测试记录表

| 测试项 | 结果 | 证据 | 问题描述 |
|---|---|---|---|
| <第 1 项> | PASS / FAIL | 截图 | |
| <第 2 项> | PASS / FAIL | 截图 | |
| ... | | | |

## 问题反馈格式

发现问题时，请按下面格式记录：

- 测试项：
- 分类 / 页面：
- 项目名称：
- 操作步骤：
- 实际结果：
- 期望结果：
- 截图或录屏：
- 发生时间：
````

For NO-GIT / doc-only rounds, replace §3+ and the 测试记录表 with:

```markdown
## 本轮无需 UI 测试

本轮仅 [说明：例如更新内部文档 / 只调整调度配置 / 无前台改动]，未发布线上可视改动。
若需要确认本轮交付物，请直接查看：

- TaskSpec：<absolute taskspec/index.md path>
- 变更说明：<PR or commit links>
```

For English-language guides (only on explicit user request), translate the section headers and rows in place; the structure is identical.

---

### Step 6.6: Dispatch Context Scoping — role-scoped + task-scoped + on-demand (mandatory; v1.31.0)

**Origin (clawso `unification-layer-decoupling-2026-08-06` round):** a normal implementation Worker was loading **900+ lines of global material** before reading a single line of source — the full dispatch command, the full dispatch plan, all global laws, the complete decision registry, historical rationale, and the Integrator/HUMAN/PM procedures it would never execute. The problem is not length. It is that **the same rule appeared in six places with slightly different wording**, which creates interpretation space: which one wins? does it apply here? is it advice or a hard constraint? The Worker starts *choosing* instead of *executing*. Historical rationale ("the old manifest failed because…") becomes an implementation anchor even when the text says "do not reuse it".

> **Minimal context is not fewer constraints. It is constraints compiled earlier and more precisely.**

The generator emits three layers instead of one monolith:

```
Role Context  +  Task Context Capsule  +  On-demand References
```

#### 6.6.1 Role Context — split the dispatch command by role

Emit `taskspec/dispatch/` with **one file per role**; each role reads only its own file:

| File | Audience | Budget |
|---|---|---|
| `dispatch/worker.md` | normal implementation Worker | **80–120 lines** |
| `dispatch/integrator.md` | per-wave Integrator | 100–150 lines |
| `dispatch/human.md` | HUMAN sign-off rows | 50–100 lines |
| `dispatch/pm.md` | PM / generator / reviewer | unbounded |

Keep `dispatch_command.md` as the **entry router**: a role table at the very top pointing each role at its own file, then the PM-side complete reference below it. It remains the one file handed to a worker session (manual dispatch) and the one path meridian's `command_file_path` resolves to. It must never become worker-hostile — see Artifact 3.

**`dispatch/worker.md` contains exactly five global hard rules — and they are defined ONLY there:**

1. Complete only the claimed task; do not widen scope.
2. Do not write integration directly.
3. Do not start new implementation before the legacy-zero / baseline gate passes (rounds that have one).
4. No legacy, fallback, dual-write, compatibility bridge, or runtime tool-name special-casing.
5. On a contract/kernel gap: block and report; never decide product semantics yourself.

**`dispatch/worker.md` MUST NOT contain:** the full task list, the dependency graph, Integrator merge procedure, HUMAN sign-off procedure, release/promotion procedure, historical version rationale, other rows' decisions, **or any instruction to write a PM/orchestration file** (see the owner table below).

##### One canonical owner per protocol (v1.35.0 — FU-001)

> **Why (same round, PRE-FLIGHT 2026-08-07).** The v1.31.0 split turned one entry document into four role documents by **duplicating** protocol text into each, instead of leaving one owner and N references. Nothing asserted the copies still agreed, so they drifted — and the drift stayed invisible until a Worker was standing in front of two contradictory imperatives with no authority to resolve either. `dispatch_command.md` §2 said ⛔ *do not append to `pm_playbook §4`*; `dispatch/worker.md` said *append a line to `pm_playbook §4`*. Both are worker-facing, and the one every Worker actually loads was the permissive one — so the contradiction resolved the **wrong** way by default. ~30 cards then used 「上报 `pm_playbook §4`」 as shorthand for "escalate", which read literally instructed 54 concurrent Workers to append to one PM-owned file in **no** Worker's `Files Owned`.

Each protocol gets exactly **one** canonical section in **one** document. Every other document **references** it — no restated imperative, not even an equivalent paraphrase.

| Protocol | Canonical owner | Everyone else |
|---|---|---|
| Lifecycle / status ownership | `dispatch_command.md` (the orchestrator parses it) | reference only |
| A role's execution loop | that role's `dispatch/<role>.md` | reference only |
| Blocking / escalation | `dispatch/worker.md` — via `outcome: needs_pm` + the row's own report `## Blocker` | cards say "escalate to PM", never a file path |
| Delivery / claim / report format | `dispatch/worker.md` | reference only |
| PM playbook content | written **only** by the PM role | never a Worker write target |

⛔ **Shared orchestration files are never a Worker write target**: `pm_playbook.md` · `dispatch_plan.md` · `plan.json` · `index.md` · any other row's card or report.

##### Worker-facing text is route-agnostic (v1.35.0 — FU-001)

The same round hit the identical class on a second protocol: `index.md` declared 「Dispatch: **不走 meridian**，owner 手动派发」 while `dispatch/worker.md` and `dispatch_command.md` both told Workers 「编排器在 spawn 时已把你的行**预标 `🔄`**」 and 「状态由 **lifecycle** 拥有」. Under the manual route no lifecycle exists — so every Worker was told its row was reserved by something that wasn't there, and the Status column had no owner at all.

⇒ **Generated worker-facing text must never name a specific dispatcher.** Say 「派发方」 / "the dispatching party". State once that the Worker's obligations are identical under either route. Route-specific duties live in a PM-side manual (`dispatch/manual-dispatch.md`), never in worker text. A round that can only be dispatched one way silently breaks the day the operator switches.

#### 6.6.2 Task Context Capsule — the minimal closure for one task

Emit `taskspec/context/<WORKER_ID>-context.md`, **40–80 lines**:

```
## Objective            one sentence
## Upstream Inputs      <dependency row> = <actual sha>
## Required Decisions    only this task's, each with decision_id / text / source / source_sha / status
## Applicable Laws       5–8 task-level laws (NOT the five global ones)
## Files Owned
## Explicitly Forbidden
## Required Deletions
## Acceptance Commands
## Known Blockers
```

⚠️ **Materialization is split by wave (Step 2.8.5a).** Wave 0's capsules are emitted by the skill at generation time; wave N ≥ 1 capsules are materialized by that wave's Integrator as an explicit sub-task, immediately before the wave dispatches.

Template fields that only the Integrator can fill:

```
## Upstream Inputs      <dependency row> = <actual sha, filled at materialization>
## Required Decisions    only this task's, each with decision_id / text / source / source_sha / status
```

⛔ Never fabricate a SHA or a decision status to make a template look complete. An unmaterialized capsule names its pending fields explicitly; a Worker that receives one MUST block rather than proceed on placeholders.

**Decision trimming.** Each task card declares `Required Decisions: D-xx, D-yy`; the generator extracts exactly those into the capsule. Workers no longer read the full registry — that forces them to judge which decisions apply and exposes them to unrelated, pending, and future-phase content.
Only `APPROVED` and `BLOCKING_PENDING` may reach a Worker. **`SUGGESTED` / `DISCUSSION` are never shipped as an implementation basis.** Two decisions in conflict ⇒ the Worker stops and returns it to PM; it does not pick the "more reasonable" one.

**Law trimming.** Global rules live in the role file (five, once). Task-level laws live in the capsule (5–8, only those that actually apply) — the capsule is their **only** home; the worker card carries a pointer, never a copy (Step 2.8.5). A runtime-supply task does not load marketplace delisting policy, coding-workspace visual rules, OAuth UI rules, or release policy.

**Generator inputs.** The capsule generator reads: the task card · the Step 2.8 laws-curation map (in-memory, same generation pass) · the decision registry · `pm_playbook §3` · the Canonical Task Graph (Step 2.9).

**Philosophy documents are generator input, not Worker input.** The generator's job is to compile philosophy into task-level prohibitions and acceptance commands. A Worker should not have to re-derive the whole architecture each session.

#### 6.6.3 On-demand references

These are **not** preloaded: full PM playbook · full decision registry · full PRD · historical audits · other Workers' cards · full dispatch plan · failure-case libraries · old-architecture write-ups. A Worker reads them only when its card names a specific section, or when it is actually blocked.

#### 6.6.4 Claim output — the Worker does not scan the plan

Provide a claim step that returns exactly:

```
Task / Branch / Card / Context / Role / Depends-On@sha / Files-Owned
```

The Worker loads only what that output points at.

#### 6.6.5 Historical material must be de-historicised before it reaches a Worker

Old-round experience is valuable, but ship the **distilled constraint**, not the story:

| Raw material | Distilled |
|---|---|
| "the old provider patch caused a bidirectional state loop" | **"Runtime must not maintain a second provider state source."** |

- Superseded TaskSpec versions are **removed from the dispatch package** (archive them somewhere the Worker cannot reach). Pre-flight asserts the directory **does not exist** — excluding it from a grep is not enough.
- If a prior implementation holds genuinely reusable know-how, add one Wave-0 row that distils it into neutral design constraints (no old paths, no old field names, no tool names, no counts), and let downstream rows read **only that**.

#### 6.6.6 Context Gates (run before dispatch)

Gates **1–7** and **11–16** run on every round. Gates **8–10** are armed only when the round contains at least one externally-stateful row (Step 5.3a) or at least one gate whose metric is sourced from a worker report.

| # | Gate | Assertion |
|---|---|---|
| 1 | **Context Size** | role ≤ 120 · card ≤ 150 · capsule ≤ 80 · **total Worker preload ≤ 300 lines**. ⚠️ These are budgets, not prose-compression targets — **over budget means the task is too big or the context is too wide, not that the wording is too long.** Resolve by (a) splitting the task, (b) moving a section to an on-demand reference the card names explicitly, or (c) removing content Gate 2 cannot attribute to this task. Compressing already-clear prose to hit a number produces motion, not clarity. Genuinely irreducible overflow requires explicit PM approval, recorded in `index.md` |
| 2 | **Context Relevance** | every Worker-facing passage maps to: this task / its dependencies / its files / its acceptance / its prohibitions. Unattributable content moves out |
| 3 | **Duplicate Law** | no rule appears in more than one of {role context, task card, capsule}. Split: role = global rules · capsule = task-level decisions **(this is where curated laws live — Step 2.8.5)** · card = execution detail **(laws appear only as a one-line capsule pointer)** |
| 4 | **Historical Reference** | Worker-facing files contain no superseded-spec paths, old artifact paths, old tool-resource paths, old importer paths, old counts, old row IDs, or compatibility narratives — **unless the row's own subject is the legacy inventory/purge** |
| 5 | **Role Leakage** | `dispatch/worker.md` contains no integration-merge, human-signoff, or release-promotion procedure, and no other Worker's task detail |
| 6 | **Role-Protocol Consistency** *(v1.35.0)* | zero contradictory imperatives for the same action across `dispatch_command.md`, `dispatch/*.md`, and the cards — each protocol has exactly one canonical owner (6.6.1) and everyone else references it. **And** no worker-facing file names which dispatcher is in use (`meridian`, `lifecycle`, a specific orchestrator) — worker text is route-agnostic |
| 7 | **Files-Owned** *(v1.35.0)* | every path a worker-facing instruction tells someone to **write** falls inside that row's capsule `## Files Owned`. Shared orchestration files (`pm_playbook.md` · `dispatch_plan.md` · `plan.json` · `index.md`, other rows' cards/reports) are never a Worker write target |
| 8 | **Reverse-Evidence Independence** *(v1.35.0, armed)* | where a gate metric has a paired "reverse evidence" command, the two use **different derivation paths** — not the same enumeration written two ways. High textual similarity between a forward and its reverse command is a flag, not a pass |
| 9 | **Gate-Metric Provenance** *(v1.35.0, armed)* | a gate whose metric command is sourced from some worker's report either (a) carries a second, independently-derived path, or (b) states on its face 「本门依赖 `<W>` 的产出，不构成客观证明」. **Two or more gates single-sourcing the same worker artifact must be flagged** |
| 10 | **Pinned-Artifact Consistency** *(v1.35.0, armed)* | every `sha256` a capsule pins to an upstream artifact equals that file's measured hash at dispatch time |
| 11 | **Scope Attribution** *(v1.36.0)* | every sub-task maps to ≥1 acceptance item and every acceptance item is reachable from ≥1 sub-task. An orphan on either side means the card is padded or under-specified — see 6.7.9 |
| 12 | **Route Disclosure** *(v1.36.0)* | no row silently resolves a choice that is hard to reverse, crosses a module/contract boundary, or touches an owner-signed decision. Either the card records the operator's pick and its rationale, or generation halted for it — see 6.7.10 |
| 13 | **Completion-Marker Literal** *(v1.36.0)* | the Completion Protocol reproduces the status-block opener, every required field (`worker_id:` · `role:` · `report_path:`), and the terminator **verbatim**. A paraphrased or incomplete template is a HARD error, not a typo — see 6.7.11 |
| 14 | **Capsule Validator-Sufficiency** *(v1.36.0)* | every acceptance item is checkable from the capsule alone. An item stated only in the card's prose is unenforced, because most validators never open the card — see 6.7.12 |
| 15 | **Acceptance Reachability** *(v1.38.0)* | every acceptance item names the surface that satisfies it, and that surface is either (a) inside this row's `Files Owned` — **including any mounting point the row must append itself to**, (b) attributed by row ID to an upstream/`✅` row that already delivers it, or (c) in the deferral registry with a re-entry condition. None of the three ⇒ the row is unsatisfiable, reject it. **In rounds with a purge/migration wave, re-grep every downstream card's Codebase Pointers against the post-purge tree** — a card may forbid touching, or require driving, code that no longer exists — see 6.7.13 |
| 16 | **Global Review Checklist** *(v1.39.0)* | `review_checklist.md` exists, is derived from `plan.json` (row IDs · waves · dependency edges · expected outputs), and every item carries an inline command, a red condition stated as a value, and a fix owner — see 6.7.14 |

**Each gate needs a negative fixture proving it can fail.** A gate that has never gone red is not a gate.

##### Gate 8/9 — why an inversion that reuses the same list proves nothing

W1-03's round designed `R11` as the independent reverse check on the `Z11` legacy-record counter. Both commands enumerated **the same hand-written table list**, so `R11` verified only that the same mistake had been transcribed twice. Three gates (`LEGACY-ZERO-GATE`, `FINAL-LEGACY-ZERO-GATE`, `DBB-01`) then single-sourced that one ledger, which meant "legacy = 0" could go green with legacy rows still alive — and the production row would have hit the identical wall later.

Reverse evidence must change the **derivation path**, not the phrasing: if the forward metric counts an enumerated ledger, the reverse derives the expected entity set from the schema/graph and diffs it against the ledger.

##### Gate 10 — amending a pinned artifact is a three-part operation

A capsule pins upstream artifacts by `sha256`. **Appending** to such an artifact — even a pure, non-rewriting tail append — invalidates the pin, and the Worker blocks on its own hard check before doing any work. Amending a pinned artifact is therefore always three edits, never one:

1. append the amendment to the artifact (never rewrite a completed row's report — fix forward),
2. update the consuming card's `Entry point` to name the amendment section, and
3. update the capsule's pinned `sha256`.

Gate 10 exists because step 3 is the one that gets forgotten.

#### 6.6.7 Emitted layout

```
taskspec/
  dispatch/{worker,integrator,human,pm}.md
  dispatch/manual-dispatch.md                                          ← PM-side, route-specific duties only (v1.35.0)
  context/<WORKER_ID>-context.md · wave-<n>-integrator-context.md
  <WORKER_ID>.md
  dispatch_command.md                                                  ← entry router (all roles land here first)
  index.md · dispatch_plan.md · pm_playbook.md · plan.json              ← PM/Integrator side
  review_checklist.md                                                  ← post-round audit, run by a non-executor (v1.39.0)
../archive/                                                            ← superseded specs, outside the dispatch package
```

`dispatch/manual-dispatch.md` is emitted only when the round may be dispatched without an orchestrator. It is **PM-facing**: it holds everything route-specific (who marks `🔄`, who owns the Status column, how a row is handed out by hand) so that no worker-facing file has to name a dispatcher. Workers never read it — Gate 6 asserts they don't need to.

**The target is not that every Worker understands the whole system. It is that each Worker completes one clearly-bounded task without irrelevant history, without inducement from an old implementation, and without freedom to reinterpret product decisions.**

---

---

### Step 6.7: Final Compile Gate — `READY_FOR_DISPATCH` (mandatory; v1.32.0)

The skill's checks are otherwise scattered across Step 2.7.8, 2.8.9, 2.9.3, 4.4, 5.5, 6.6.6 and the `--meridian` validation list. Scattered checks get partially run. Before emitting a TaskSpec, run them as ONE gate and emit a single verdict.

| Class | Assertions |
|---|---|
| **Structural** | every task in `plan.json` has a card and a capsule · no empty card · Step 2.9.3 exits 0 (plan ≡ artifacts, master table parseable, cell parity, all `⬜`) · role ↔ completion-protocol match |
| **Architecture** | mode-conditional rules of Step 2.9.4 (when armed) · no duplicate state owner · no downstream row depending on a schema/API no upstream row defines · no two concurrently-eligible rows owning the same file |
| **Context** | every capsule exists and is ≤ its budget · decisions trimmed (`APPROVED`/`BLOCKING_PENDING` only) · learnings trimmed · Gate 3 (no rule duplicated across role/card/capsule) · Gate 4 (no historical contamination outside legacy-facing rows) · **Gate 6** (one canonical owner per protocol; no worker-facing file names a dispatcher) · **Gate 7** (no worker-facing write target outside its `Files Owned`) · **Gate 10** when armed (capsule `sha256` pins match measured hashes) |
| **External state** *(v1.35.0; armed when any row is externally-stateful — Step 5.3a)* | every armed row carries an `#### External State Contract` · its Scope-Derivation closure assertion `derive(seed) − ledger = ∅` passes · every external-state acceptance assertion carries a generation-time measured pre-value and the command that produced it · zero assertions in "non-empty" form whose measured pre-value is `0` or whose entity does not exist · **Gate 8** (reverse evidence uses a different derivation path) · **Gate 9** (no gate metric single-sources a worker artifact without an independent path or an explicit provenance disclaimer) |
| **Dispatch compatibility** | every file the orchestrator expects exists · `dispatch_plan.md` parses · `dispatch_command.md` is worker-readable and routes by role · role files complete · **the orchestration protocol itself is unchanged** |

Only when all four classes pass, emit:

```
READY_FOR_DISPATCH
```

⛔ **`READY_FOR_DISPATCH` is a generation-time verdict, not a dispatch artifact.** Never write it into `dispatch_plan.md`'s Status column or any row cell — the Status column accepts only `⬜ / 🔄 / ✅ / ⛔`.

#### 6.7.1 Completion-protocol consistency (v1.32.0)

Assert, for every row: the completion protocol its card references **exists**; a `worker` row references the worker protocol, a `gate` row the integrator protocol, a `human` row the human protocol; and no card references a superseded protocol location (e.g. a `dispatch_command.md Step <N>` that no longer exists after the v1.31.0 role split). Protocol drift is a HARD generation error — a worker following a step number that moved will either stall or invent its own delivery path.

#### 6.7.2 Two additional auto-reject rules (v1.32.0)

- **Undefined upstream contract** — a row whose sub-tasks consume a schema, type, IDL, endpoint or IPC command that **no earlier row defines and that does not already exist in the repo**. Reject and either add the defining row or move the consumer later. (This is the generation-time form of the "contract-bump consumer ships before producer" failure.)
- **Concurrent shared-state writers** — two rows that can be dependency-eligible at the same time and declare an overlapping `files_owned`, or write the same table/key/config. Under serial dispatch this is latent; under `--parallel` it is an immediate race. Reject and either serialize them with an explicit `depends_on` edge or split the ownership.

#### 6.7.3 Meridian Compatibility Compile Check — `MERIDIAN_COMPATIBLE` (mandatory under `--meridian`; v1.33.0)

**Why this exists.** Successive context/consistency optimizations drifted past the skill's own boundary and began redefining the orchestrator's entry point, its state machine, and its capsule lifecycle. The skill's job is to **compile better input for the existing orchestrator**, never to replace parts of it. This check is the boundary guard.

| Class | Assertion |
|---|---|
| **Entry** | `dispatch_command.md` exists, is **worker-readable**, and routes by role. ⛔ No "NOT FOR WORKERS" banner, no worker-hostile framing — it is the one file every role receives. Target **50–100 lines**: entry · role detection · role routing · required read paths · report path · completion · blocker · forbidden ops. Historical prose, full plan, full registry, full philosophy all belong elsewhere. |
| **Roles** | `dispatch/{worker,integrator,human,pm}.md` all exist |
| **State ownership** | ⛔ No worker-facing file instructs a Worker to claim a row, edit the plan's Status column, append PM state, or run its own scheduler. The lifecycle store owns reservation and status; the validator and PM-resolver own progression. Grep for claim commands, `Mark ✅`, `改成 🔄`, "update dispatch plan" and reject any hit in a worker-facing file. |
| **Reports** | every row's report path matches the orchestrator's derivation contract, and `reports/` exists |
| **Capsules** | wave 0 materialized; later waves have templates whose pending fields are explicitly named — no fabricated SHA or decision status |

All pass ⇒ `MERIDIAN_COMPATIBLE = true`. Otherwise the TaskSpec is not dispatchable.

> **The boundary, stated once:** the skill compiles input; the orchestrator keeps its execution and lifecycle contracts. Any generated instruction that re-implements reservation, status transition, or scheduling is out of bounds regardless of how much cleaner it looks.

#### 6.7.4 No-Forward-Evidence check (v1.33.0)

A gate may **name** a future row (as a downstream consumer, a sequencing constraint, or a "this ships later" note). A gate may **not demand evidence** that a future row already produced something.

```
Gate evidence references  ⊆  current wave ∪ completed upstream waves
```

⛔ **Do not implement this as "gate mentions a future task id".** That fires on every legitimate sequencing note and buries the real defect. Detect the **evidence demand**: a future row's ID appearing in an acceptance/assertion **row** together with a completion claim — `已实现` / `全绿` / `✅` / `exists` / `passes` / `implemented` / `green` — while excluding downstream-handoff and sequencing phrasings (`交 X` / `→ X` / `归 X` / `由 X` / `X 之后` / `入口是 X` / `本行不放行`).

⚠️ **Scope the match to the whole table row, not to a single cell.** A cell-scoped test looks more precise and is wrong: the real defect routinely spans adjacent cells — `| 13 uninstall | \`C-05\` ✅ | **both levels implemented** |` puts the ID in one cell and the claim in the next. A negative fixture caught exactly this after a cell-scoped implementation silently passed it — which is why every gate needs a fixture proving it can go red.

Real instance this was drawn from: a gate whose wave contained **only the contract-schema row** carried acceptance items *"both uninstall levels implemented"*, *"update same-origin assertion has positive and negative tests"*, *"region resolution in exactly one place"* — all owned by rows one wave later, with the summary table literally marking those future rows `✅`. That gate can never pass. Emitting it is a HARD generation error.

#### 6.7.5 Gate body generated from the DAG (v1.33.0)

A gate's worker list, worker count, expected report count, rollup count, dependency set and one-line summary are **derived from the Canonical Task Graph**, never hand-maintained. Hand-written counts drift from the graph and the drift is invisible to review. Post-generation, assert each gate's stated worker count equals its wave's worker count in `plan.json`.

#### 6.7.6 Total worker preload budget (v1.33.0)

Per-file budgets miss what actually reaches the Worker. Assert the **sum**:

```
dispatch_command.md (routed portion) + dispatch/worker.md + <WORKER_ID>.md + capsule  ≤ 250–350 lines
```

Per-file limits stay as guardrails; the total is the binding one. Over budget resolves by splitting the task or moving a section to a named on-demand reference — **not** by compressing already-clear prose.

#### 6.7.7 Domain-scoped invariants, never repo-wide (v1.33.0)

An invariant that belongs to one domain must be asserted **against that domain**, not the whole tree. Repo-wide assertions of a domain rule fail on legitimate uses elsewhere and train operators to weaken the gate.

Instance this was drawn from: the round forbids introducing a session dimension **into the provider-binding domain**. A gate asserted the identifier was absent *from the entire kernel* — which would trip on chat sessions, workspaces, CLI resume, invocation ownership and terminal outcomes, all legitimate. The gate must scope its search to the binding domain's own surfaces and assert there.

Generation rule: every invariant assertion declares its **scope** (paths / modules / domain surfaces). An assertion whose scope is "the whole repo" for a domain-specific rule is a HARD generation error unless the rule genuinely is repo-wide.

#### 6.7.8 Runtime read budget — the layer that works, and the one that does not (v1.36.0)

A Worker's preload is a rounding error next to what it pulls in at runtime. Measured over one round: preload ≈ 5,930 tokens; runtime tool output ≈ 16.96M tokens across 132 sessions, of which **skills 19.7% + laws/learnings 19.5% = 39.2%** was material nobody asked for. Do not spend generation effort compressing the preload while that stays open.

**⛔ Negative result — do not re-attempt this shape.** A prior round added a hard rule to `dispatch/worker.md`: *"do not open laws/learnings originals · do not read any SKILL.md into context · a single command must not fill the tool-output cap."* Measured against controls in the same wave, the `SKILL.md` share of pull-in **rose** 10.7% → 26.4% and laws 16.1% → 18.0%. The early "−23% context" was an artifact of the constrained row having done 12 repo reads against the control's 75; once workload matched, the advantage inverted to **+7%**.

The rule failed for a structural reason, not a wording one: the runtime's own base instructions advertise the skill roster (17,921 chars, 40 mentions of "skill", 56 skills offered per session). **A worker-facing prohibition sits downstream of the system prompt and loses to it.** The constrained row executed `sed -n '1,240p' .../using-superpowers/SKILL.md` at record 13, before any task work.

**✅ What worked instead (2026-08-10, measured).** Control the roster at **spawn**, not the reading behaviour after spawn — three config overrides on the orchestrator's agent invocation (`skills.include_instructions=false`, `features.memories=false`, `features.multi_agent=false`). Same prompt, A/B: **17,554 → 10,007 input tokens (−43%)**. Across 28 sessions after rollout: fixed prologue **15,706 → 6,506** ~tok (−59%); skills + laws share of tool output **39.2% → 3.5%** (−91%).

**The generalisation, which is the part that transfers:** a prohibition that competes with a system-prompt-level affordance loses. Either remove the affordance where it is issued, or hand the Worker the substitute it actually needs. Writing a stronger ⛔ is motion, not a fix. **This belongs to the orchestrator's spawn configuration, not to `/taskspec`** — record it here only so the next generation does not re-derive the failure.

#### 6.7.9 Scope discipline — every line earns its place (v1.36.0)

**For the Worker:** every line of code a row adds or changes must be attributable to that row's stated Objective or Acceptance. Not "in the same file", not "while I was there", not "it seemed related" — attributable.

**For the generator (this skill, applied to itself):** every line of spec written must serve the orchestration's ultimate goal. A worker card carrying sub-tasks that no acceptance item consumes is the same defect one layer up, and it is more expensive because it propagates to every row that inherits from it.

Following 6.7.8, enforce this **structurally**, not by exhortation:

1. **Generation-time gate.** Every sub-task in a card maps to at least one acceptance item, and every acceptance item is reachable from at least one sub-task. An orphan on either side is a HARD generation error — it means the card is either under-specified or padded.
2. **Report contract.** The Completion Protocol report must map each changed path to the acceptance item that required it. Anything changed without such a mapping is declared under `## Out-of-Scope Changes` with a one-line justification. A silent unattributable change is a review failure, not a style note.
3. **`Files Owned` bounds writes; this bounds *content*.** Gate 7 already stops a row writing outside its files. Nothing previously stopped it writing unrelated lines *inside* them.

#### 6.7.10 Crucial choices are surfaced, never silently taken (v1.36.0)

When two or more materially different routes exist, the operator picks — with reasons and a recommendation in front of them. This applies at **both** stages, and the earlier stage is strongly preferred.

**Prefer generation stage.** A route question resolved during generation costs one operator round trip. The same question discovered at worker time costs a blocked row, a PM resolver spawn, and a re-dispatch — one round measured **44 PM resolvers over 49 dispatched rows**.

| Stage | Obligation |
|---|---|
| **Generation** | If the PRD admits ≥2 materially different decompositions, architectures, or ownership splits for a row, do **not** pick silently. Emit an options block — each option with its reason, cost, and reversibility — plus an explicit recommendation, and halt for the operator. Record the chosen option and its rationale in `index.md` |
| **Worker** | If implementation admits ≥2 materially different routes and the choice is crucial, the Worker does **not** pick silently. It reports `blocked` with the options, reasons, and its recommendation |

**"Crucial" is a test, not a feeling.** A choice is crucial when it is **hard to reverse**, **crosses a module or contract boundary**, or **touches an owner-signed decision**. Choices failing all three are made, stated in one line in the report, and not escalated — escalating trivia trains the operator to stop reading escalations.

⚠️ **Use the existing escalation channel — do not invent one.** The Worker path is the `LAW CONFLICT` block (`/read-laws` Step 6) filed as a `⏳ PENDING` row in `pm_playbook.md` §4. This is 6.7.8's lesson applied: a newly-invented channel is one more instruction competing with everything upstream, and it will not be walked. The channel that already works is the one that gets used.

#### 6.7.11 The completion marker is machine-parsed — the Worker verifies it before declaring done (v1.36.0)

The orchestrator's lifecycle parses the Worker's status block by exact string match. A block that misses the contract by one character does not fail loudly — **the row stays `running` forever**.

Real instance: a row emitted a complete, correct status block terminated `<<<END>>` instead of `<<<END>>>`. One missing character. The lifecycle never recognised the block, the row sat `running` for **3 hours 26 minutes** after the work was finished, and **26 downstream rows** — two entire implementation waves plus every gate behind them — never dispatched. The Worker had in fact completed and correctly reported `outcome: needs_pm`; nobody could see it.

> **Parser-side fix landed 2026-08-10 (Meridian-roles).** The generation rules below did not stop recurrence, and cannot: this is a runtime typo, not a template defect. Measured again on `agent-dispatcher-abd83457` — **10 of 42 replies in one round** ended `<<<END>>`, in Chinese and English alike. Most survived on the reconciler's non-marker heuristics; the three that did not cost 30 min (`C-07` frozen `running`), 5 wasted validator cycles (`C-09`'s `needs_pm` swallowed — the validator kept failing a row that had already, correctly, raised its hand), and 5 h 14 min of dead air (`C-08`). `meridian-status-marker.ts` now accepts `<<<END>>{2,}` and a trailing block with no terminator at all, and falls back to the last *schema-valid* block instead of blindly taking the last one. **Gate 13 stays armed** — the parser tolerance is a safety net, not a licence to emit a sloppy template — but a round no longer dies on one character.

Generation rules:

1. The Completion Protocol reproduces the marker's opening line, every required field, and the terminator **verbatim** — never paraphrased, never "as described above".
2. The Worker's last act before declaring done is to re-read its own emitted block and confirm each literal against the contract. A self-check that costs one turn is cheaper than a stalled wave.
3. A round that carries a status-block template missing any of `worker_id:` / `role:` / `report_path:` / the exact terminator is a HARD generation error — an incomplete template is a mechanism for manufacturing orphan rows, not a typo.

#### 6.7.12 The capsule must be sufficient for the validator, not only the Worker (v1.36.0)

Capsules are written for the Worker. Measured across 67 validator sessions in one round, that is not who reads them: **only 39% ever opened the capsule and only 21% ever opened the worker card.** The rest returned a verdict from the plan-table row plus a diff.

Assume the capsule's `## Acceptance Commands`, `## Files Owned`, `## Explicitly Forbidden` and `## Required Deletions` are **the entire basis on which the row will be judged**. If a row's acceptance is only comprehensible after reading its card, the capsule is under-specified — a validator will not go find the card.

Corollary for gates: an acceptance item stated only in prose in the card, with no command in the capsule, is effectively unenforced.

#### 6.7.13 Acceptance must be reachable from the row's own `Files Owned` (v1.38.0)

Gate 7 asks *"does every named write target sit inside `Files Owned`?"*. That misses the failure that actually stalls rounds, because the killing instructions **name no path at all**. They say 「挂在既有 G-CI 门体系里」, 「BFF/catalog 侧拒绝安装请求」, 「`session_exec` 驱动 ACP runtime」. Each is a legitimate acceptance item. None can be satisfied from the files the row owns — and no generation-time check noticed.

Measured on one round (`agent-dispatcher-abd83457`, wave 8), three rows died this way, each burning a PM resolver and up to five validator cycles before a human read the reports:

| Row | Acceptance item | Where it actually lands | Owned? |
|---|---|---|---|
| `C-09` | 「门挂进既有 G-CI 体系」 | `scripts/gate-architecture.mjs` — a **fixed** gate list with no `scripts/gates/**` discovery hook | ❌ owned only the new script |
| `C-02` | 「`session_exec` 驱动 runtime 的停止 / 激活」 | production `impl SessionRuntimeControl` + the real dispatch seam `agent_workspace/surface_action.rs` | ❌ (and the runtime itself had been deleted in an earlier purge — see below) |
| `C-08` | 五条下架语义 | BFF `src/bff/marketplace.mjs` + client pages + Tauri install admission | ❌ owned `workers/` |

Every one of those Workers stopped and reported `needs_pm` rather than inventing a parallel path. **That is the correct behaviour, and it is expensive** — the cost belongs at generation, not at runtime.

**Gate 15 — Acceptance Reachability.** For each acceptance item / behavioral assertion, name the surface that satisfies it. Then exactly one of these must hold:

1. the surface is inside this row's `Files Owned`; or
2. the item is explicitly attributed to another row that **already delivers it**, named by row ID, and that row is an upstream dependency or already `✅`; or
3. the item is registered in the round's deferral registry with a re-entry condition.

An item matching none of the three is **unsatisfiable** — reject the row and either widen `Files Owned`, move the item, or drop it. Mounting points count: if a row must register itself somewhere (a gate list, a module tree, a router, a command table), the registration file is part of its surface even when the row only *appends* one line.

**Corollary — verify the tree still contains what the card forbids touching.** `C-02`'s card said 「`AcpTurnGate` 只读，不动」 and 「驱动 ACP runtime」. Both referred to code a *previous wave of the same round* had deleted: `protocol_adapter/acp.rs` was a 147-byte identity stub and `AcpTurnGate` had zero hits tree-wide. A card written against a pre-purge tree sends a Worker to satisfy an acceptance item that no longer has a subject. **In any round containing a purge/migration wave, every downstream card's Codebase Pointers must be re-grepped against the post-purge tree before dispatch, not against the tree the PRD was written on.**

**Corollary — a new function with no production caller is not a deliverable.** Two rows in the same round shipped helpers (`services_invoke_with_session_exec`, `project_cli_chat_anchor_view`, `invoke_cli_chat`) that only tests called; both validators caught it, and both cost a cycle. The Worker's own completion self-check should include: for each new function / module / prop, `rg` proves a **non-test** caller, and that hit goes in the report.

#### 6.7.14 Emit a Global Review Checklist for post-round audit (v1.39.0)

Every check this skill ships is **per-row**: gates judge one wave, validators judge one row, the Final Compile Gate judges one artifact set at generation time. **Nothing audits the finished round as a whole**, and that is where the expensive failures live.

Real instances, each from a round where every per-row check was green:

| What passed | What was actually true |
|---|---|
| `BATCH-4-GATE` green | its rollup order listed 4 rows against a 7-row DAG dependency — **3 rows silently unmerged** |
| `BATCH-3-GATE` green | its roster listed 5 rows for a 3-row wave, pre-checking rows belonging to the next one |
| `K-10` card green | all four of the card's own search patterns returned **zero hits** on the tree — the inventory it was written against did not exist |
| every capsule materialised | the materialiser wrote `## Explicitly Forbidden` as `None declared.`, discarding an owner-signed ADR constraint |
| a row reported complete | its status marker missed the terminator by one character; the row held `running` for 3h26m and **26 downstream rows never dispatched** |

None of these is visible from inside a single row. All are trivially visible from outside the round.

**Generation therefore emits `review_checklist.md` into the dispatch package**, to be executed **after** the round reports done, by a human or an agent that **did not execute any part of it**. Independence is the point, not ceremony: whoever ran the round shares its blind spots, and a round cannot certify itself.

Rules for the emitted checklist:

1. **Derived from `plan.json`, never a generic template.** Row IDs, wave membership, dependency edges, expected outputs and owned files are this round's own. A boilerplate checklist restates the methodology instead of auditing the round, and gets skipped on sight.
2. **Every item carries its command and its red condition**, stated as a value. An item the reviewer must first translate into a command is an item that gets eyeballed.
3. **Every item names who owns the fix** — Integrator, PM, the generator, or the orchestrator. A finding with no owner becomes a note.
4. **Independence is asserted, not assumed.** The checklist opens with a line naming the reviewer and stating they executed no row in this round.

Minimum content, all machine-checkable:

| Check | Assertion |
|---|---|
| **DAG closure** | zero dangling dependencies (a `depends_on` naming a row not in the plan) · zero orphan cards · zero rows without a card |
| **Rollup completeness** | for every `✅` row with a branch, `git merge-base --is-ancestor <row-head> <integration>` exits 0. This is the `BATCH-4-GATE` failure, and it is one command per row |
| **Gate roster ≡ DAG** | each gate's listed rows equal its wave's rows in `plan.json` — hand-maintained rosters drift and the drift is invisible to review (6.7.5) |
| **Artifact reality** | every `Expected Outputs` path exists, is non-empty, and carries a conforming status marker (6.7.11) |
| **Capsule fidelity** | no capsule's `## Explicitly Forbidden` reads `None declared.` unless its card genuinely declares none — a materialiser that substitutes a default is indistinguishable from a card that had no constraint |
| **Claim re-derivation** | for each gate asserting a count reached zero, re-derive it by a path the round did not use — Gate 8's rule, applied once more at the end |
| **Teardown** | zero surviving round worktrees and branches, each removed only under the clean-tree-and-no-unique-commits guard |

Emit it as `⬜` rows in the same table shape the gates use, command inline. **Gate 16 asserts the file exists and is plan-derived; nothing in the round asserts it was run** — that is deliberate, and it is the reviewer's job to close.

---

## TaskSpec: Worker Definition Template

Each worker definition lives in its own file (`branch/<taskspec-id>/taskspec/<WORKER_ID>.md`).

````markdown
### [WORKER_ID] — [Worker Name]

- **Runtime**: [Supabase PostgreSQL / CF Workers / CF Pages / GitHub Actions]
- **Delta Type**: [REWORK / NEW / DELETE / KEEP / DRIFT]
- **Phase**: [0 / 1 / 2]
- **Priority**: [P0 / P1 / P2]
- **Depends on**: [Worker IDs or -]
- **Branch**: `<taskspec-id>/<WORKER_ID>`
- **Repo**: `<absolute spawn dir>` *(mandatory — v1.34.0; **its own bullet, never merged onto the Branch line**; see the wire-format rule below)*
- **Expected Outputs**: `<absolute report path>`[, `<additional artifact paths>`] *(mandatory under `--meridian`)*
- **Model Routing Rationale**: [T0–T3 + exact family/effort rationale using ambiguity, coupling, blast radius, reversibility, and proof burden]
- **Internal Delegation**: [forbidden | allowed] *(default `forbidden`; `allowed` requires explicit TaskSpec/user authorization and is mandatory for any `::ultra` row)*
- **Worker Class**: [code | e2e-desktop | data | review | integration | preflight | postflight] *(mandatory — v1.23.0; see Step 5.5)*
- **Requires Attended UI**: [true | false] *(mandatory — v1.23.0; default `false`; set `true` only for e2e-desktop / V-* rows with screenshot or stopwatch acceptance)*
- **External State**: [true | false] *(mandatory — v1.35.0; default `false`; set `true` when §5.3 scores `Reversibility = High` or `Blast radius = High` — the row mutates destructive/irreversible external state. `true` arms Step 5.3a's two obligations, the `#### External State Contract` section, `PRE-FLIGHT.X`, and Context Gates 8–10)*

> **v1.23.0 worker-class rule:** `code` / `data` / `integration` / `preflight` / `postflight` / `review` workers MUST NOT include `foreground / screenshot / stopwatch / tauri:dev / npm run client:dev / "real desktop" / "manual measurement" / "press confirm" / "wall-clock" / cliclick / osascript / screencapture` in their Sub-tasks or Acceptance Criteria. Any such requirement is moved to a sibling `e2e-desktop` worker (typically V-*) and referenced as `delegated to <V-XX> per <law-or-PRD-ref>`. Step 5.5.a lints this; violations are HARD generation errors.

#### Sub-tasks

**[WORKER_ID].1 — [Sub-task name]**
- [Detailed implementation description]
- **Key constraint**: [Any hard rule or business logic constraint]
- **Acceptance**: [Verifiable completion condition]
- **Ref**: [PRD document § section]

**[WORKER_ID].2 — [Sub-task name]**
...

**[WORKER_ID].N — Update System Overview** *(mandatory — every worker must include this sub-task)*
- Check which system overview module docs (at `<system-overview-path>/modules/`) cover files this worker modified
- For each affected module doc:
  - Update file:line references if lines shifted
  - Update route/contract inventory if endpoints changed
  - Update function signatures or type definitions if they changed
  - Add new entries with `[ADDED <date>]` tag
  - Mark removed entries with `[REMOVED <date>]` tag (per FORMAT_SPEC.md)
- If no documented paths were affected, explicitly state: "No system overview updates needed — verified `<module-doc-name>` Source Scope does not cover modified files" (the worker must still check, not assume)
- **Acceptance**: All modified file:line references in the system overview are accurate post-change; worker has explicitly confirmed which module docs were checked
- **Key constraint**: Follow FORMAT_SPEC.md tagging rules (`[ADDED ISO]`, `[UPDATED ISO]`, `[REMOVED ISO]`)

> **Generation-time rule for the skill:** When generating worker files, the skill must always include this sub-task as the final sub-task for every R-/N-/D- worker. It is never optional. If the worker's Codebase Pointers section references a module doc, pre-populate the module doc path in this sub-task so the worker knows exactly which file to check. If no Codebase Pointers exist (no system overview), still include the sub-task with the note: "System overview not available — skip this sub-task."

#### External State Contract *(mandatory when `**External State**: true`; omit entirely otherwise — v1.35.0, Step 5.3a)*

- **Target**: `<system>` = `<exact ref printed by a command at generation time, not a name or alias>` — explicitly **not** `<the production / sibling target>`
- **Seed set**: [the hand-written starting entities — this is an input, never the operative scope]
- **Derivation**: `<command that derives the closure from the dependency graph>` → N entities. Closure assertion `derive(seed) − ledger = ∅` ✅
- **Order**: [topological order of the graph, children first]
- **Measured pre-values** *(read-only, taken `<UTC>` at generation time)*:

  | Assertion target | Command | Value at generation | Assertion form |
  |---|---|---|---|
  | [entity] | `<read-only command>` | [measured] | non-empty and unchanged / **count-invariant** (+ reason) |

⛔ No assertion whose pre-value could not be measured. ⛔ No "non-empty" form on a target measured `0` or absent. ⛔ Never create state to make an assertion pass.

#### AI Auto-Tests
```bash
# All commands use absolute paths or confirmed env vars
export $(grep -v '^#' /absolute/path/.env.local | xargs)
[specific test commands]
```

#### Acceptance Criteria
- [Observable condition 1]
- [Observable condition 2]
- [Observable condition 3]

#### Codebase Pointers (from system overview — mandatory when module coverage exists)

*Auto-extracted from system overview modules during TaskSpec generation. The skill must read each candidate module doc's Source Scope and include pointers for every worker whose target files overlap. If no system overview exists, replace this section with: `Codebase Pointers: N/A — no system overview available`.*

- **Module doc**: `[absolute path to the system overview module doc covering this worker's scope]`
- **Entry point**: `[file:line — primary file the worker will modify]`
- **Key files**: `[comma-separated list of files relevant to this worker's scope]`
- **Contracts**: `[API routes, events, or IPC commands this worker must honor — with module doc reference]`
- **Functions touched**: `[function names from the module doc's function inventory that this worker modifies]`
- **Module doc**: `[absolute path to the system overview module doc covering this worker's scope]`

#### Visual Canon *(mandatory for UI-facing workers; omit only when this worker touches no rendered UI)*

The TaskSpec generator already ran the Frontend Visual Canon Gate for this round. Treat the following as binding PRD context, not optional inspiration. If a functional requirement conflicts with the Visual Canon, STOP and file a PM Playbook §4 question instead of silently drifting.

- **Visual Canon Sources**: `[absolute path(s) to screenshot/mockup/reference image/sample HTML/design-system example, or PRD section anchor]`
- **Target hierarchy**: `[what should be dominant, secondary, quiet, hidden]`
- **Layout/density rules**: `[spacing, alignment, width constraints, responsive behavior, scroll behavior]`
- **Typography rules**: `[relative scale, headings/body/control text; note any oversized text to avoid]`
- **Component/chrome rules**: `[panels, cards, tabs, borders, buttons, icons, state styling]`
- **Interaction rules**: `[drag/resize/save/restore/hover/focus/motion expectations, if relevant]`
- **Negative Visual Rules**: `[explicit rejected patterns this worker must not render]`
- **Screenshot evidence required**: `[routes/viewports/states this worker or downstream UX-GATE must capture]`

#### Applicable Laws *(pointer only — the binding set lives in your Context Capsule; v1.31.1)*

→ `context/[WORKER_ID]-context.md` § Applicable Laws (curated, binding). Do NOT re-grep the laws directory.

> **Worker contract:** Laws bind. Read the capsule's `## Applicable Laws` before starting any sub-task. If a sub-task in your brief cannot be satisfied without violating an in-scope law, STOP and surface a `LAW CONFLICT` block (per `/read-laws` Step 6) — file a `⏳ PENDING` row in `pm_playbook.md` §4 with the conflict, then halt the row. Do NOT silently comply with the brief and violate the law; do NOT amend the law yourself (only `/write-laws` may, with explicit user-confirmed conflict resolution).
>
> ⛔ **This section is a pointer, never a restatement.** Copying law paths, Statements, or "Why it binds" lines onto the card duplicates the capsule and fails Context Gate 3.

#### Referenced Learnings *(mandatory — pre-curated by TaskSpec skill; do NOT re-grep the learnings directory)*

The TaskSpec generator already swept `/Users/yzliu/work/Docs/Projects/<project>/learnings/` and curated the entries below specifically for this worker's scope. **Read every entry before starting any sub-task.** Cite by filename slug in your completion report's `## Referenced Learnings Applied` section when a learning shapes a decision. If a curated learning conflicts with current code, prefer what you observe and flag the stale entry in your report.

- `[absolute path to learning .md]` — [one-line scope-overlap rationale]
- `[absolute path to learning .md]` — [one-line scope-overlap rationale]

> **Worker contract:** Do NOT independently `ls` or `rg` the learnings directory. The list above is authoritative for this row. If during execution you discover another learning that should apply, note it under `## Learnings Discovered` in your completion report — that is information for PM, not a license to broaden scope. If no curated entries exist for this worker, this section reads exactly `Referenced Learnings: N/A — no relevant prior learnings.` (the section is still required, never omitted). Rule-following workers whose capsule `## Applicable Laws` already covers the constraint surface will frequently emit this N/A line — that is the intended laws-vs-learnings split (see Step 2.8.7).

#### Completion Protocol *(mandatory — every worker file must include this section)*

**After all sub-tasks pass their AI Auto-Tests and Behavioral Assertions, you MUST complete the git delivery lifecycle. Your task is NOT done until your work is durably in the integration branch (rollup mode) or merged into base (per-worker-merge mode).**

> **Mode discriminator (v1.27.0):** The skill picks `Merge Mode` (per-worker-merge vs rollup) in Step 4.6.5 and writes it into `index.md` / `dispatch_plan.md` / Round Context. The generator MUST emit ONLY the variant matching the chosen Mode. Emitting both variants, mixing language from both, or omitting the chosen variant is a HARD generation error. Workers receive exactly one path; they do NOT make the choice themselves.

---

**Variant A — `Merge Mode: per-worker-merge`** *(emit when the round is small, decoupled, naturally-shippable per row — see Step 4.6.5 triggers)*:

0. **Pre-commit verification** (run these checks before step 1 — if ANY fails, STOP):
   ```bash
   git branch --show-current           # MUST output: <taskspec-id>/<WORKER_ID>
   git diff --stat HEAD                # MUST be non-empty (you have changes to commit)
   ```
1. **Commit**: `git add <changed files> && git commit -m "[WORKER_ID] <task summary>"`
2. **Push**: `git push -u origin <taskspec-id>/<WORKER_ID>`
3. **Create PR (target = base branch)**: `gh pr create --base <PR-base-branch> --title "[WORKER_ID] — <task name>" --body "<PR body from dispatch command Step 5f>"`
4. **Merge PR to base**: `gh pr merge --merge --delete-branch=false <PR-number-or-URL>`
5. **Resync local to base**: `git fetch origin <PR-base-branch> && git checkout <PR-base-branch> && git pull --ff-only origin <PR-base-branch>`

---

**Variant B — `Merge Mode: rollup`** *(emit when ANY trigger in Step 4.6.5 matches — default for contract-bump rounds, schema bumps consumed by 2+ runtimes, multi-row migrations with invalid intermediate state, ≥5 workers without per-worker shippable units, or any PRD §P process fix mandating an integration branch)*:

0. **Pre-commit verification** (run these checks before step 1 — if ANY fails, STOP):
   ```bash
   git branch --show-current           # MUST output: <taskspec-id>/<WORKER_ID>
   git diff --stat HEAD                # MUST be non-empty
   # Your branch MUST be based on origin/<taskspec-id>/integration, not on <PR-base-branch>
   git fetch origin <taskspec-id>/integration
   git merge-base --is-ancestor origin/<taskspec-id>/integration HEAD \
     || { echo "⛔ BLOCKED — your branch is not based on origin/<taskspec-id>/integration; PRE-FLIGHT.W should have created it"; exit 1; }
   ```
1. **Commit**: `git add <changed files> && git commit -m "[WORKER_ID] <task summary>"`
2. **Push**: `git push -u origin <taskspec-id>/<WORKER_ID>`
3. **Create review-only PR (target = integration branch, NEVER base)**: `gh pr create --base <taskspec-id>/integration --title "[<WORKER_ID>] review-only — represented-by <taskspec-id>/integration" --body "<PR body from dispatch command Step 5f>"`
4. **Roll up into integration** (do NOT run `gh pr merge` — INTEGRATE owns the base merge):
   ```bash
   git fetch origin <taskspec-id>/integration
   git checkout <taskspec-id>/integration
   git pull --ff-only origin <taskspec-id>/integration
   git merge --no-ff <taskspec-id>/<WORKER_ID> -m "[<taskspec-id>] roll up [<WORKER_ID>]"
   git push origin <taskspec-id>/integration
   ```
   The review-only PR stays OPEN as a review artifact; INTEGRATE will close it after the umbrella merge with `superseded by #<umbrella>`.
5. **Resync local to integration** (NOT base): `git fetch origin <taskspec-id>/integration && git checkout <taskspec-id>/integration && git pull --ff-only origin <taskspec-id>/integration`
6. **Git Delivery Self-Test** (run ALL 4 commands — their output MUST appear in your report):
   ```bash
   # 1. Branch was pushed to remote
   git branch -r | grep <taskspec-id>/<WORKER_ID>
   # 2. PR was created and merged
   gh pr view <PR-number-or-URL> --json state -q '.state'  # MUST output: MERGED
   # 3. Base branch contains your commit
   git log --oneline <PR-base-branch> | grep "\[<WORKER_ID>\]" | head -1
   # 4. Working tree is clean on base branch
   git status --short  # MUST be empty
   ```
   If ANY self-test fails, your task is NOT complete — investigate and fix before proceeding.
7. **Update dispatch plan**: Change row status from `🔄` to `✅` only after ALL self-tests pass
8. **Capture Reusable Learnings (mandatory — `/ship-changes` §10 contract):** Before writing the report, ask yourself: *Did this row produce a finding future agents should reuse?* — a non-obvious root cause, a verified diagnostic sequence, an environment contract or gotcha, a recurring failure mode, an architectural constraint discovered mid-work, or a stale learning from your curated `#### Referenced Learnings` list that you needed to correct. If yes:
   ```bash
   project_name="$(basename "$(git rev-parse --show-toplevel)")"
   learnings_dir="/Users/yzliu/work/Docs/Projects/${project_name}/learnings"
   ls "$learnings_dir" 2>/dev/null || ls /Users/yzliu/work/Docs/Projects/   # resolve obvious slug if mismatch
   ```
   **Check for `index.md` first (fast path):** `cat "${learnings_dir}/index.md" 2>/dev/null` — if it exists, match topic keywords against `## Entries` summaries and tags to find an existing slug. Note the `## Layout` field to determine placement (flat = root, multi-tier = matching subdir).
   **Fallback (no index.md):** `rg --files "$learnings_dir"` then `rg -i "<topic>|<tool>|<error>|<module>" "$learnings_dir"` to check for an existing slug.
   - If a matching slug exists: **append a dated entry** (do not overwrite or reorganize). If content fully covers the insight already, skip (do not duplicate).
   - If none exists: **create** `${learnings_dir}/<topic-slug>.md` (or `${learnings_dir}/<subdir>/<topic-slug>.md` for multi-tier) with: Date · Context/symptom · Root cause or key insight · Files/commands/PRs/docs involved · Reuse guidance (what future agents should do, avoid, or verify).
   - **After writing or appending:** if `index.md` exists, append/update one entry line in `## Entries`: `` - `<relative-path>` — <one-sentence summary> — tags: <tag1>, <tag2> ``
   - **Do NOT capture:** routine syntax, one-off implementation trivia, already-documented facts, secrets/credentials, or content already covered by an existing curated learning that did not change.
   - **STALE corrections:** if a `#### Referenced Learnings` entry conflicted with current code, append a dated correction to that same file (do not delete the original — the diff is the audit trail). Update the `index.md` entry summary if the correction changes the reuse guidance materially.
   - Learnings live in the **external Docs directory**; they are NOT committed to the repo. No `git add` for these files.
   - If unsure whether a finding is worth capturing, err on the side of capturing — the next round's TaskSpec curation pass filters noise. If genuinely unsure where it belongs or whether it overlaps an existing slug, file a `⏳ PENDING` row in `pm_playbook.md` §4 with the candidate text.
9. **Write report**: Save to `reports/<WORKER_ID>.md` — **must include the Git Delivery Self-Test output, a `## PM Playbook References` section** listing every `pm_playbook.md` entry applied (`§1.<N>`, `§2.<N>`, `§3.<N>`) and every `§4` row you opened, **a `## Applied Laws` section** listing each capsule `## Applicable Laws` entry that shaped a decision (law slug + 1-line how it bound the decision; if you surfaced a `LAW CONFLICT`, list the slug here too with prefix `CONFLICT:` and reference the `§4` row that captured it), **a `## Referenced Learnings Applied` section** listing each curated `#### Referenced Learnings` entry that shaped a decision (filename slug + 1-line how it shaped the decision; prefix `STALE:` if it conflicted with current code), **AND a `## Learnings Captured` section** listing each learning file you wrote or appended in step 8 (absolute path + 1-line summary; or the literal `None — no reusable finding this row.`). For UI-facing workers with `#### Visual Canon`, also include `## Visual Canon Evidence` with reference path(s), screenshot path(s) when captured by this row, and a short match/drift assessment against hierarchy, density, spacing, typography, and Negative Visual Rules. Empty Applied Laws / Referenced Learnings / PM lists are acceptable; a missing section is not. Optional `## Learnings Discovered` section for relevant learnings NOT in the curated list AND not captured this row (PM input for next round). Optional `## Law Candidates Discovered` section for recurring principles you noticed that are not yet codified as laws — for `/write-laws` to consider next round.
10. **Stop session immediately.**

⚠️ **Passing tests ≠ task complete.** If you stop after tests pass without committing, pushing, and merging, the task is NOT done — it is abandoned work on the local filesystem that will be lost.

⚠️ **Branch created ≠ branch used.** If your branch points at the same commit as the base branch, you never committed your work to it. Check `git log --oneline origin/<PR-base-branch>..<taskspec-id>/<WORKER_ID>` — it MUST show at least one commit.

⚠️ **Consult PM Playbook before declaring blockers.** If a sub-task fails, an assertion fails, or you need a workaround: open `<Docs root>/branch/<taskspec-id>/taskspec/pm_playbook.md` and grep §1 (Blocker Resolutions) and §2 (Failure Recovery) for your symptom. Apply the sanctioned resolution if one exists. Only file `⛔ BLOCKED` and append a `⏳ PENDING` row to §4 (Open Questions) when nothing matches. The Playbook is PM-owned and append-only for workers (§4 only).

> **Generation-time rule for the skill:** This section must appear in every worker file (R-/N-/D-/V-), after Codebase Pointers and before the closing fence. It is never optional. The skill must substitute `<taskspec-id>`, `<PR-base-branch>`, and the PR body template with confirmed values from the Round Context. Omitting this section from a worker file is a generation error — it was the direct cause of the fix-oauth-settings incident where 5 workers completed code changes but never created branches or PRs.
````

---

## PM Playbook Template (`branch/<taskspec-id>/taskspec/pm_playbook.md`)

This file is generated as a scaffold and then maintained by PM/operators throughout the round. Workers read it at fixed checkpoints (see Dispatch Command §0.6 PM Playbook Consultation Protocol). Workers never edit §1, §2, or §3; they may only **append** new `⏳ PENDING` rows to §4.

````markdown
# PM Playbook — [TaskSpec ID]

**Owner**: PM / human operators
**Worker access**: read §1–§3; append-only on §4 (new `⏳ PENDING` rows)
**Last updated**: [ISO date]

> Both dispatcher and workers MUST consult this file at the checkpoints defined
> in `dispatch_command.md` §0.6 (PM Playbook Consultation Protocol). Failing
> to consult before declaring a blocker, applying a workaround, or executing
> sub-tasks is a process violation. Every worker report must include a
> `## PM Playbook References` section listing entries applied this row.

---

## §1 Blocker Resolutions Library

Indexed by blocker keyword. Workers grep the **Trigger Keywords** column when a
sub-task fails or a precondition is missing, and apply the **Resolution** verbatim
before considering `⛔ BLOCKED`.

| #   | Trigger keywords (grep target) | Context / when this applies | Resolution (verbatim steps) | Added by | Date |
|-----|--------------------------------|-----------------------------|------------------------------|----------|------|
| 1.1 | (e.g. `RLS denied`, `42501`)   | Inserts to `clients` table  | Use `$SUPABASE_SERVICE_KEY` for the write; do NOT relax the RLS policy | PM | YYYY-MM-DD |
| 1.2 |                                |                             |                              |          |      |

*(append new rows here — never reorder or renumber)*

---

## §2 Failure Recovery Patterns

Recipes for known failure classes detected during execution. Workers consult
this when AI Auto-Tests / Behavioral Assertions fail, BEFORE retrying or
escalating.

| #   | Failure class | Detection signal (regex / log line) | Recovery steps | Escalate when | Added by | Date |
|-----|---------------|--------------------------------------|----------------|----------------|----------|------|
| 2.1 | Migration replay collision | `duplicate key value violates unique constraint` on `schema_migrations` | Run `npm run db:remote:apply --force-version <N>` once | Failure persists after 2 retries | PM | YYYY-MM-DD |
| 2.2 |               |                                      |                |                |          |      |

---

## §3 Applied Principles & Laws

Cross-cutting rules that override defaults for this round. **§3 is seeded at
TaskSpec generation time from the repo's binding laws** (`/Users/yzliu/work/Docs/Projects/<project>/laws/`,
populated by `/write-laws` — the canonical source). PM may add round-specific
rules below the seeded entries. Dispatcher pre-loads in-scope rules at claim
time (Step 3.5a.5); workers apply them throughout the session and cite by
`Playbook §3.<N>` in their report. Workers also receive the per-worker
curated `## Applicable Laws` section in their Context Capsule (Step 2.8.5) — that
list is the worker-scoped projection of §3; §3 remains the round-wide canon.

| #   | Principle / Law (one sentence) | Scope (worker IDs / file globs) | Rationale | Added by | Date |
|-----|--------------------------------|---------------------------------|-----------|----------|------|
| 3.1 | All Supabase writes via RPC; no direct table writes | `R-*`, `N-*`, `apps/*/src/db/**` | Auditing requirement (compliance) | PM | YYYY-MM-DD |
| 3.2 |                                |                                 |           |          |      |

**Scope syntax:**
- Worker IDs: comma-separated (`R-04, N-02`) or wildcard (`R-*`, `*`)
- File globs: standard glob syntax (`apps/*/src/**/*.ts`)
- A row applies to a worker if EITHER its worker ID matches the Scope worker pattern OR any file the worker will touch matches the Scope file pattern.

---

## §4 Open Questions (PM TODO)

Pending decisions filed by workers when a blocker has no §1 resolution. Workers
APPEND new rows with status `⏳ PENDING`; PM EDITS the Resolution column to
move them to `✅ RESOLVED`. Dependent workers cannot proceed while a question
they raised (or one their `Depends On` raised) is `⏳ PENDING`.

| #   | Question | Asked by (worker) | Date | Status | Resolution |
|-----|----------|-------------------|------|--------|------------|
| 4.1 |          |                   |      | ⏳ PENDING |        |

**Append template (workers copy this exactly):**

```
| 4.<N+1> | <one-sentence question> | <WORKER_ID> | <YYYY-MM-DD> | ⏳ PENDING |  |
```

When PM resolves a question, they replace the empty Resolution cell with the
decision and change status to `✅ RESOLVED — <one-line summary>`. Workers
re-read §4 the next time they claim a row to pick up resolved answers.

---

## Changelog

- [YYYY-MM-DD] Scaffold created by `taskspec` skill (version <X.Y>)
````

**Generation rules for the skill:**

1. The file is **always** created, even when there are no known blockers/principles at generation time. Empty tables + the instruction blocks above are valid.
2. Pre-populate §3 with cross-cutting rules already evident from input PRDs (compliance, security, naming conventions explicitly called out). Mark `Added by: TaskSpec generation` so PM knows what is auto-suggested vs PM-authored.
3. Pre-populate §4 with any unresolved questions copied from the fix PRD's §0 Traceability or the index.md PM Blocker Resolutions section that are still `⏳ PENDING`. Cross-reference by question text to avoid double-tracking.
4. §1 and §2 start empty (with the example row commented out or marked `(example only)`).
5. **`--append` mode:** if `pm_playbook.md` already exists in the target directory, NEVER overwrite it. Append a single dated entry to the Changelog section noting which workers were added.
6. **Memory-first §4 consultation (mandatory before parking any question as `⏳ PENDING`)**:
   - For every candidate §4 question, the skill MUST first consult: (a) the project's learnings index at `<docs-project-root>/learnings/index.md`, (b) the user's auto-memory at `~/.claude/projects/<repo-slug>/memory/MEMORY.md`, (c) the system overview module docs, (d) the git user identity (`git config user.name` / `user.email`) when the question is about repo ownership or commit attribution.
   - If a high-confidence answer is found, pre-resolve the §4 row at generation time with status `✅ RESOLVED <YYYY-MM-DD> — <source>` and cite the source file path (e.g. `learnings/reference/clawso-app-pages-autobuild-config-lookup-broken.md`). Do NOT park it as PENDING when memory already answers it.
   - Only park `⏳ PENDING` when no source returns a confident answer or when the question is a genuine product/design choice (cost/preference tradeoff with no historical precedent).
   - **Why this exists (2026-05-14 audit):** A skills TaskSpec parked 3 §4 questions; 2 of them (verified-skills owner, wrangler.jsonc consolidation) already had definitive answers in project memory + learnings. Workers blocked needlessly. The skill must close the loop between generation and accumulated project knowledge.

---

## Pre-flight Worker Template (mandatory Batch 0)

Every TaskSpec that touches database, build, or deployment systems must include a PRE-FLIGHT worker as the first entry in Batch 0. This worker runs before all other workers and gates the entire dispatch on environment health.

PRE-FLIGHT lives in `branch/<taskspec-id>/taskspec/PRE-FLIGHT.md` and gets branch `<taskspec-id>/PRE-FLIGHT`.

PRE-FLIGHT strictness is decided at generation time by Step 0.5:
- **Strict global mode**: allowed only when the global baseline is already proven green, or when this TaskSpec itself is the dedicated `baseline-cleanup` round.
- **Scoped mode**: validates only this round's touched packages/resources and required authority surface.
- **Audit-only mode**: records global failures without blocking feature workers; use only when the user explicitly chooses this tradeoff and `index.md` documents the skipped gates and rationale.

Do not generate a strict feature PRE-FLIGHT that is expected to fail on known repo-wide debt. That debt belongs in a `baseline-cleanup` TaskSpec.

Under `--meridian`, PRE-FLIGHT's `**Repo**:` field MUST point at the primary checkout (`<repo-root>`), not the `.worktrees/<taskspec-id>` path it is responsible for creating. Meridian spawns the worker with `**Repo**:` as `cwd`; pointing PRE-FLIGHT at the not-yet-created worktree makes spawn fail before PRE-FLIGHT can run. POST-FLIGHT also points at the primary checkout because it removes worktrees. Other implementation workers use the generated worktree topology.

````markdown
### PRE-FLIGHT — Environment Health Check

- **Runtime**: Local (bash)
- **Delta Type**: REVIEW
- **Phase**: 0
- **Priority**: P0
- **Depends on**: -
- **Branch**: `<taskspec-id>/PRE-FLIGHT`
- **Repo**: `<repo-root>` *(primary checkout; PRE-FLIGHT creates `.worktrees/<taskspec-id>` and cannot spawn inside it before creation)*
- **Model Routing Rationale**: T0 bounded environment checks with deterministic proof; escalate only if this preflight spans multiple runtimes
- **Internal Delegation**: forbidden

#### Sub-tasks

**PRE-FLIGHT.1 — Database migration baseline** *(include if any Worker touches DB migrations)*
- Run the project's migration status command (e.g. `npm run db:remote:status`)
- Verify: `pendingLocal` is empty (no unapplied local migrations from prior work)
- Verify: `remoteOnly` is empty (no migrations applied remotely but missing locally)
- If either is non-empty: report the specific versions and **STOP with `⛔ BLOCKED`**
- Do NOT attempt to fix drift — report it for manual repair
- **Acceptance**: Migration status shows `pendingLocal: []` and `remoteOnly: []`

**PRE-FLIGHT.2 — Build baseline** *(include if any Worker touches compiled code)*
- Run the build/typecheck command selected by Step 0.5.
  - In strict global mode, run the exact full-repo command whose baseline was proven green during generation.
  - In scoped mode, run the package/module-specific command that covers this TaskSpec's touched surface.
  - In audit-only mode, run the global command only for reporting and clearly mark nonzero output as non-blocking in the report.
- Verify: the selected blocking build command succeeds with zero errors on the current branch
- If build fails: report errors and **STOP with `⛔ BLOCKED`**
- **Acceptance**: The selected blocking build/typecheck baseline is clean before any worker modifies code

**PRE-FLIGHT.3 — Required secrets/env validation** *(include if Workers need runtime secrets)*
- Verify that all required environment variables / secrets referenced by Workers are accessible
- Check by name only (e.g. `test -n "$CF_API_TOKEN"`), never log values
- If any are missing: list them and **STOP with `⛔ BLOCKED`**
- **Acceptance**: All required env vars / secrets are non-empty

**PRE-FLIGHT.W — TaskSpec worktree setup** *(mandatory — v1.15.0)*
- Create the per-TaskSpec git worktree at `<repo-root>/.worktrees/<taskspec-id>` and the `node_modules` symlinks. Verbatim block lives in §3.5c (TaskSpec worktree (always)). For multi-repo TaskSpecs, repeat the block once per `Repo Root` in the Repo Map.
- Ensure `.worktrees/` is present in each target repo's `.gitignore`.
- **Acceptance**: `git -C <repo-root> worktree list` shows a row at `<repo-root>/.worktrees/<taskspec-id>` for every target repo; `<repo-root>/.worktrees/<taskspec-id>/node_modules` resolves; `git status` inside the new worktree is clean.

**PRE-FLIGHT.X — External target reality probe** *(mandatory ONLY when this TaskSpec contains at least one externally-stateful row — `**External State**: true`, Step 5.3a; omit otherwise — v1.35.0)*

- Every other PRE-FLIGHT sub-task probes something **local** (worktree, build, env var names, console). This one probes the **external target the round will irreversibly mutate** — the only surface where a wrong assumption cannot be fixed by re-running a worker.
- **Read-only. This sub-task never writes to the target.**
- For each externally-stateful row, run its card's `#### External State Contract` commands and assert three things:
  1. **Identity** — print the target's *actual* resolved ref and compare it against the row's authorization artifact. Never accept a name/alias; print what the runtime resolves. Explicitly assert it is **not** the production/sibling target.
  2. **Scope closure** — re-run the Scope-Derivation command and assert `derive(seed) − ledger = ∅`. A migration merged between generation and dispatch is exactly the drift this catches.
  3. **Assertion grounding** — re-measure every pre-value recorded on the card. Any value that has changed class (non-zero → zero, entity now absent) invalidates that row's acceptance form and must block.
- On any failure: `⛔ BLOCKED` naming the row, the failing assertion, and the measured-vs-expected values. Do **not** attempt repair — PRE-FLIGHT has no authorization to mutate the target.
- **Acceptance**: for every externally-stateful row — resolved target ref printed and matching, closure difference empty, and every recorded pre-value re-measured in the same class.
- **Rationale (v1.35.0):** in `unification-layer-decoupling-2026-08-06`, the round's only irreversible row was the only target never probed. Its ledger had gone stale against a migration merged after the inventory was taken, and two of its retention assertions were false before any deletion. Both were catchable here, read-only, in seconds.

**PRE-FLIGHT.UI — Foreground UI availability probe** *(mandatory ONLY when this TaskSpec contains at least one worker with `Requires Attended UI: true`; omit otherwise — v1.23.0)*
- Confirm the controlling macOS console is attended (not on the lock screen, not headless / SSH-only).
- Run:
  ```bash
  TMP=$(mktemp -t r04-fg-XXXXXX.png)
  screencapture -xo "$TMP" 2>/dev/null
  # A locked/black console returns a uniform-color image; compare against any-nonblack pixel.
  IS_BLACK=$(python3 -c "
  from PIL import Image
  im = Image.open('$TMP').convert('RGB')
  px = im.getdata()
  total = im.width * im.height
  black = sum(1 for r,g,b in px if r < 12 and g < 12 and b < 12)
  print('YES' if black / total > 0.98 else 'NO')")
  FRONTMOST=$(osascript -e 'tell application "System Events" to get name of first application process whose frontmost is true' 2>&1)
  rm -f "$TMP"
  if [ "$IS_BLACK" = "YES" ] || echo "$FRONTMOST" | grep -q -- "-1719"; then
    echo "⛔ BLOCKED: no attended UI — screencapture returned all-black or no frontmost process. Attended-UI workers in this plan: <generator-substituted list>. Unlock the console (or attach a display) and re-run PRE-FLIGHT."
    exit 1
  fi
  ```
- If the probe fails, PRE-FLIGHT exits `⛔ BLOCKED` and the dispatcher MUST NOT spawn any worker with `Requires Attended UI: true`. Under `--meridian`, lifecycle pauses; the operator unlocks the console and resumes.
- **Acceptance**: `screencapture -xo` produces a non-uniform image AND `osascript ... frontmost` returns a real process name (not `-1719` / no controllable application).
- **Rationale (v1.23.0):** The R-04 incident (`agent-dispatcher-f0953280`, 2026-05-31) showed what happens without this gate — dispatcher launched a V-* / foreground-requiring worker into a locked console; the worker hit a black frame mid-measurement, left dirty uncommitted state, watchdog escalated, PM-resolver agent could not unlock the screen either, and the round froze for hours. Probing once at PRE-FLIGHT, before any attended-UI worker spawns, blocks the entire cascade cleanly.

#### AI Auto-Tests
```bash
# DB baseline (adjust command to project)
npm run db:remote:status | jq '.pendingLocal | length == 0 and (.remoteOnly | length == 0)' | grep true || echo "⛔ DB DRIFT DETECTED"

# Build baseline (adjust command to project)
cd <worker-dir> && npx tsc --noEmit 2>&1 | tail -5

# Env validation (list required vars)
for var in CF_ACCOUNT_ID CF_API_TOKEN; do
  test -n "$(printenv $var)" || echo "⛔ MISSING: $var"
done
```

#### Acceptance Criteria
- Migration history is fully synchronized (no pending, no remote-only)
- Selected blocking build/typecheck baseline is clean on the branch
- All required secrets are available
- If any check fails, dispatch is halted with a clear blocker report
````

**Dispatch plan integration**: PRE-FLIGHT appears as the first row in Batch 0, before all implementation workers. All Batch 1+ workers have an implicit dependency on PRE-FLIGHT (it must be `✅` before any other worker starts). You do not need to list PRE-FLIGHT in every worker's `Depends On` — it is a batch-level gate. PRE-FLIGHT.W is mandatory under v1.15.0 (TaskSpec worktree setup); the per-TaskSpec worktree is the execution surface every later worker shares.

**Omit sub-tasks that don't apply**: If the TaskSpec has no DB migrations, omit PRE-FLIGHT.1. If no compiled code, omit PRE-FLIGHT.2. If no external secrets, omit PRE-FLIGHT.3. PRE-FLIGHT.W cannot be omitted — every TaskSpec needs a worktree. PRE-FLIGHT.UI is omitted ONLY when no worker in the plan has `Requires Attended UI: true`; otherwise it is mandatory (v1.23.0). PRE-FLIGHT.X is omitted ONLY when no row is externally-stateful (`**External State**: true`); otherwise it is mandatory (v1.35.0), and omitting it while such a row exists is a HARD generation error — the same rule PRE-FLIGHT.UI carries. If at least one of W / X / UI / 1 / 2 / 3 applies, the PRE-FLIGHT worker must be included.

### PRE-FLIGHT.W under `--parallel` (v1.21.0 — per-worker worktree topology)

When `--parallel` is active, PRE-FLIGHT.W replaces the single `git worktree add` with N+1 calls — one per implementation worker plus one shared integration worktree. The block below replaces the v1.15.0 PRE-FLIGHT.W body verbatim.

```bash
# PRE-FLIGHT.W (--parallel mode) — per-worker + integration worktree setup
cd <repo-root>
grep -qxF '.worktrees/' .gitignore || echo '.worktrees/' >> .gitignore

# Integration branch (created off origin/<PR-base-branch> if not present)
git fetch origin <PR-base-branch>
git rev-parse --verify <taskspec-id>/integration 2>/dev/null \
  || git branch <taskspec-id>/integration origin/<PR-base-branch>

# Integration worktree — used by BATCH-N-GATE, V-*, INTEGRATE rows
INTEG_WT=<repo-root>/.worktrees/<taskspec-id>-integration
git worktree list --porcelain | grep -q "$INTEG_WT" \
  || git worktree add "$INTEG_WT" <taskspec-id>/integration

# Per-worker worktrees — one per implementation worker (R-*, N-*, D-*)
# The generator MUST emit one block per worker, with the worker ID and branch name substituted
for WORKER_ID in R-01 R-02 N-03 R-04 ; do                                           # generator-substituted list
  WT=<repo-root>/.worktrees/<taskspec-id>-${WORKER_ID}
  BR=<taskspec-id>/${WORKER_ID}
  git rev-parse --verify "$BR" 2>/dev/null \
    || git branch "$BR" <taskspec-id>/integration
  git worktree list --porcelain | grep -q "$WT" \
    || git worktree add "$WT" "$BR"
done

# node_modules symlinks — required so each worktree's typecheck/lint/test work without re-installing
for WT in $(git worktree list --porcelain | awk '/^worktree.*\.worktrees\/<taskspec-id>(-.*)?$/{print $2}'); do
  cd "$WT"
  [ -e node_modules ] || ln -s <repo-root>/node_modules ./node_modules
  for dir in apps/client apps/web apps/cli packages/i18n packages/api-contracts packages/design-system; do  # generator-substituted list per repo
    if [ -d "<repo-root>/$dir/node_modules" ] && [ ! -e "$dir/node_modules" ]; then
      ln -sfn "<repo-root>/$dir/node_modules" "$dir/node_modules"
    fi
  done
done
cd <repo-root>
```

**Acceptance** (`--parallel` mode): `git worktree list` lists `<repo-root>/.worktrees/<taskspec-id>-integration` plus one `<repo-root>/.worktrees/<taskspec-id>-<WORKER_ID>` per implementation worker; each worktree's `git status --short` is empty; each worktree has a resolvable `node_modules` symlink.

For multi-repo TaskSpecs, repeat this entire block once per `Repo Root` in the Repo Map. Worktree paths are namespaced by repo, so cross-repo conflicts are impossible by construction.

---

## INTEGRATE Worker Template (v1.17.0 — mandatory for GIT-mode code rounds)

Every GIT-mode TaskSpec with code/validation PRs, rollup/stack PRs, or 2+ non-teardown rows must include an `INTEGRATE` worker immediately before `POST-FLIGHT`. It is the final merge/reconciliation row. Its job is to make the configured base branch contain the accepted work and to close stale PR/branch state before teardown begins.

INTEGRATE lives in `branch/<taskspec-id>/taskspec/INTEGRATE.md`, runs inside `<repo-root>/.worktrees/<taskspec-id>`, and gets branch `<taskspec-id>/INTEGRATE` or uses the designated rollup/integration branch when the TaskSpec explicitly names one.

````markdown
### INTEGRATE — Final PR reconciliation and base-branch merge

- **Runtime**: Local (bash + GitHub CLI + project-required check APIs)
- **Delta Type**: REVIEW
- **Phase**: Ω (after validation, before teardown)
- **Priority**: P0
- **Depends on**: all implementation, batch-gate, and V-* rows
- **Branch**: `<taskspec-id>/INTEGRATE` or the TaskSpec's named rollup branch
- **Model Routing Rationale**: [route from actual merge/check complexity; terminal status alone does not justify frontier/max/ultra]
- **Internal Delegation**: forbidden

#### Sub-tasks

**INTEGRATE.1 — Refresh against the real base**
- `git fetch origin <PR-base-branch>`
- Verify `origin/<PR-base-branch>` is the branch workers are targeting; do not use a stale local base branch for acceptance.
- Merge or rebase the integration/rollup branch onto `origin/<PR-base-branch>`.
- If the refresh surfaces conflicts or new test failures, fix them here and document the base-drift cause.
- **Acceptance**: integration head contains all accepted worker commits and is based on the latest `origin/<PR-base-branch>`.

**INTEGRATE.2 — Final verification**
- Run the TaskSpec's full final verification gates after the refresh.
- Include any real-binary, deployment, browser, or service smoke checks required by the validation plan.
- **Acceptance**: every required gate passes, or a failure is classified with a concrete fix/blocked reason before any merge attempt.

**INTEGRATE.3 — Action Run Policy classification**
- Read the round's `Action Run Policy` from `index.md` / `dispatch_plan.md`.
- Inspect live PR state:
  ```bash
  gh pr view <pr> --json mergeStateStatus,statusCheckRollup,headRefOid,state
  ```
- Classify every non-success check as one of:
  - `required-blocker` — branch protection or the TaskSpec explicitly requires this check.
  - `optional-failed` — visible failure but not required for this delivery path.
  - `skipped-by-policy` — intentionally skipped by an opt-in gate such as Clawso's `[run-action]` default-off policy.
  - `neutral` — not applicable to this merge.
- Under `action-run-opt-in`, do NOT add `[run-action]`, do NOT call `workflow_dispatch`, do NOT rerun skipped jobs, and do NOT block on opt-in detector jobs unless the TaskSpec/user explicitly opted into Actions.
- **Acceptance**: the report records the policy, the checked PR head SHA, and the classification for every non-success check.

**INTEGRATE.4 — Push, wait for policy-required checks, and merge**
- Push the refreshed integration/rollup branch.
- Use `gh pr checks <pr> --watch` or equivalent only for checks classified as `required-blocker` or `required-checks` by the Action Run Policy.
- Merge after policy-required checks are green or absent, skipped-by-policy checks are recorded, and the PR head SHA matches the verified head.
- Confirm with `gh pr view <pr> --json state,mergedAt,mergeCommit,headRefOid`.
- **Acceptance**: final PR is `MERGED`, with merge SHA recorded.

**INTEGRATE.5 — Superseded PR and branch cleanup**
- For worker PRs fully represented by the final merged PR, comment `superseded by <final-pr>` and close them when they are still open.
- Delete obsolete remote branches under `<taskspec-id>/...` after confirming their commits are ancestors of `origin/<PR-base-branch>` or otherwise represented in the final merge.
- **Acceptance**: no open TaskSpec PRs remain except intentionally documented external follow-ups, and no obsolete TaskSpec remote branches remain.

**INTEGRATE.6 — Report**
- Write `reports/INTEGRATE.md` with:
  - final merged PR URL(s)
  - verified head SHA(s)
  - merge SHA(s)
  - final `origin/<PR-base-branch>` SHA
  - Action Run Policy value and check classification table
  - closed superseded PRs
  - deleted remote branches
  - residual risks or explicit `None`

#### Acceptance Criteria
- Latest `origin/<PR-base-branch>` contains the final merged work.
- Policy-required checks passed on the merged head, or skipped checks were explicitly classified as skipped-by-policy / neutral.
- Superseded PRs/branches are closed or explicitly justified as retained.
- POST-FLIGHT can safely limit itself to audit and worktree teardown.
````

**Dispatch plan integration**: INTEGRATE appears directly before POST-FLIGHT. POST-FLIGHT depends on INTEGRATE directly or through `ALL-PRIOR`.

### INTEGRATE under `--parallel` (v1.21.0)

Under `--parallel`, INTEGRATE operates in `<repo-root>/.worktrees/<taskspec-id>-integration` (the shared integration worktree created by PRE-FLIGHT.W). Its `**Repo**:` field must be set accordingly. Sub-task INTEGRATE.1 reads:

```bash
cd <repo-root>/.worktrees/<taskspec-id>-integration
git fetch origin <PR-base-branch>
git rebase origin/<PR-base-branch>       # or merge, per round preference

# Merge every implementation worker's branch (one merge per worker)
for WORKER_ID in R-01 R-02 N-03 R-04 ; do                                           # generator-substituted list
  git merge --no-ff -m "[<taskspec-id>] integrate ${WORKER_ID}" <taskspec-id>/${WORKER_ID}
done
```

Conflict resolution rules are unchanged from the shared-worktree mode (preserve every worker's intent; escalate if irreconcilable). The per-worker worktrees stay intact during INTEGRATE — they are only torn down by POST-FLIGHT after the umbrella PR merges. INTEGRATE's report must list each per-worker branch merged + its merge SHA so POST-FLIGHT.W teardown can verify `git merge-base --is-ancestor` for each before removing the worktree.

---

## POST-FLIGHT Worker Template (v1.15.0 — mandatory; v1.24.0 — orphan-WIP triage)

Every TaskSpec must include a final `POST-FLIGHT` worker. It is the *last* row in the dispatch plan, gated by every other row being `✅`, and its sole job is to triage any orphan WIP left in the primary checkout, audit final integration state, and remove the TaskSpec worktree(s) that PRE-FLIGHT.W created.

For GIT-mode TaskSpecs that have code/validation PRs, `POST-FLIGHT` is preceded by `INTEGRATE`. `POST-FLIGHT` must not perform first-time PR merges, CI waiting, base-branch refreshes, superseded-PR closure, or remote branch cleanup. Those actions belong to `INTEGRATE`. If POST-FLIGHT sees an open PR, a pending required check, a missing merge SHA, or a TaskSpec remote branch that should have been cleaned by `INTEGRATE`, it stops and reports `INTEGRATE incomplete` instead of fixing it inline.

POST-FLIGHT lives in `branch/<taskspec-id>/taskspec/POST-FLIGHT.md` and gets branch `<taskspec-id>/POST-FLIGHT` (created in the long-lived primary checkout, NOT in the TaskSpec worktree being torn down).

````markdown
### POST-FLIGHT — TaskSpec worktree teardown

- **Runtime**: Local (bash)
- **Delta Type**: TEARDOWN
- **Phase**: ∞ (final)
- **Priority**: P0
- **Depends on**: every other row in the dispatch plan must be `✅`
- **Branch**: `<taskspec-id>/POST-FLIGHT` (created in the primary checkout, not the TaskSpec worktree)
- **Model Routing Rationale**: T0/T1 mechanical teardown plus safety classification; do not escalate solely because this is the last row
- **Internal Delegation**: forbidden

#### Sub-tasks

**POST-FLIGHT.0 — Primary checkout orphan-WIP triage (v1.24.0; runs first, before any integration check)**

Workers occasionally leak edits into the long-lived primary checkout instead of staying inside `.worktrees/<taskspec-id>/`. When they do, the umbrella PR can merge cleanly while the primary still holds an alternate draft — `git pull --ff-only` will then refuse with "Your local changes ... would be overwritten by merge". POST-FLIGHT.0 is the catch-all: it triages any orphan files, preserves real WIP to a named branch by default, and only escalates to PM when triage is genuinely ambiguous. **Do not stash, reset, or force-update primary.**

```bash
cd <repo-root>
git -C <repo-root> fetch origin <PR-base-branch>

# 1. Detect orphan WIP
ORPHAN=$(git -C <repo-root> status --porcelain)
if [ -z "$ORPHAN" ]; then
  echo "POST-FLIGHT.0: primary checkout clean; skipping triage."
else
  echo "POST-FLIGHT.0: orphan WIP detected:"
  printf '%s\n' "$ORPHAN"

  # 2. Triage: round-relevant WIP vs tooling cruft.
  # Cruft patterns are LEAVE-ALONE: never commit, never delete.
  #   .claude/   node_modules/   .DS_Store   .idea/   .vscode/   *.swp
  # Round-relevant patterns (generator-substituted from the round's product/test paths):
  #   <round-relevant-glob-1>, <round-relevant-glob-2>, ...
  #
  # For each modified-tracked file under a round-relevant path:
  #   git -C <repo-root> diff origin/<PR-base-branch> -- <path>     # see how local diverged from merged
  # For each untracked file at a path origin/<PR-base-branch> adds:
  #   git -C <repo-root> show origin/<PR-base-branch>:<path> | diff - <path>
  # mtime correlation (which worker run produced this?):
  #   stat -f "%Sm  %N" -t "%Y-%m-%d %H:%M:%S" <path>

  # 3. If any orphan file CANNOT be classified as round-relevant vs cruft from path +
  #    filename + diff signal alone (e.g. modified file under a path this round didn't
  #    touch — could be unrelated session work), STOP with `outcome: needs_pm`. Include
  #    the unclassifiable set in the report and ask PM which disposition to apply.
  #    Otherwise continue with the preserve-branch default.

  # 4. Preserve round-relevant WIP to a named branch (DEFAULT DISPOSITION)
  WIP_BRANCH="wip/<taskspec-id>-orphan-$(date +%Y-%m-%d)"
  git -C <repo-root> checkout -b "$WIP_BRANCH"
  # Stage ONLY the round-relevant set — never `git add -A` / `git add .`
  git -C <repo-root> add <round-relevant-files>
  git -C <repo-root> commit -m "wip: preserve alternate <taskspec-id> draft from primary checkout

<one paragraph naming what the divergent draft does that the merged version doesn't —
this is the only signal a reviewer has when deciding whether to PR forward later>.

Not intended for merge as-is."
  git -C <repo-root> push -u origin "$WIP_BRANCH"
  git -C <repo-root> checkout <PR-base-branch>
fi

# 5. Fast-forward primary (now safe whether triage ran or not)
git -C <repo-root> pull --ff-only origin <PR-base-branch>
git -C <repo-root> log -1 --format='%h %s'   # should be the umbrella PR's merge commit
```

- The tooling-cruft list is **leave-alone**. Never commit it to the preservation branch (noise) and never delete it from primary (tooling directories are outside TaskSpec ownership). If a tooling dir is persistently dirty, file a separate one-line `.gitignore` follow-up; it is not POST-FLIGHT's job to do inline.
- The commit message MUST name the divergence in plain prose (what the alternate draft includes that the merged version omits). Without that, a future operator cannot decide whether to land the draft, fold its ideas into a follow-up, or close the branch.
- If the round has no INTEGRATE / no umbrella PR (rare single-row doc-only TaskSpec), POST-FLIGHT.0 still runs but skips the fast-forward step — there is no integration commit to pull.

**POST-FLIGHT.1 — Verify final integration already happened**
- Read `reports/INTEGRATE.md` when present. It MUST name the final merged PR(s), merge SHA(s), final `origin/<PR-base-branch>` SHA, and superseded PR/branch cleanup results.
- `gh pr list --search "<taskspec-id>/ in:title" --state open` MUST return empty.
- For every PR named by `reports/INTEGRATE.md`, `gh pr view <pr> --json state,mergedAt,mergeCommit` MUST report `MERGED` with a merge commit.
- The dispatch plan / lifecycle sidecar MUST show every non-POST-FLIGHT row completed.
- If any PR is open, required check is pending/failed, merge SHA is absent, or `INTEGRATE` did not write a conclusive report: **STOP with `⛔ BLOCKED — INTEGRATE incomplete`**. Do not merge, wait on CI, close PRs, or delete remote branches from POST-FLIGHT.

**POST-FLIGHT.2 — Remove TaskSpec worktree(s)**
- For each `Repo Root` in the Repo Map (single-repo TaskSpecs have one entry):
  ```bash
  # Verify nothing useful is still in the worktree before removing
  cd <repo-root>/.worktrees/<taskspec-id>
  git status --short                       # MUST be empty
  git log --oneline @{upstream}..HEAD 2>/dev/null   # MUST be empty (nothing unpushed)
  cd <repo-root>
  git worktree remove <repo-root>/.worktrees/<taskspec-id>
  ```
- If `git status --short` is non-empty: report contents in the report, **STOP with `⛔ BLOCKED`** — manual review required, do NOT force-remove.
- If `git worktree remove` fails (lock, in use): consult `pm_playbook.md` §1; if no resolution, mark `⛔ BLOCKED` and stop.

**POST-FLIGHT.2.5 — Squash-merge equivalence proof (gates branch cleanup)**
- Before deleting any `<taskspec-id>/*` branch local or remote, prove the integration tip is content-equivalent to the merged trunk (squash-merge breaks ancestor-chain checks, so content-equivalence is the real gate):
  ```bash
  git -C <repo-root> diff --stat origin/<PR-base-branch> <taskspec-id>/integration
  ```
  Empty output → integration content == merged trunk; per-worker branches that rolled into integration are content-equivalent even though `git merge-base --is-ancestor` returns false. Safe to delete.
  Non-empty output → the umbrella PR's squash merge did NOT capture everything. **STOP with `⛔ BLOCKED — squash-merge missed content`**, name the missing files in the report, and escalate. Do not delete any worker branch.
- If the round was generated without an integration branch (`--parallel` mode skips the shared integration topology), substitute the umbrella PR's head ref for `<taskspec-id>/integration` and repeat the check.

**POST-FLIGHT.3 — Confirm removal**
- `git -C <repo-root> worktree list` MUST NOT include `.worktrees/<taskspec-id>` (or any `.worktrees/<taskspec-id>-*` variant under `--parallel`).
- **Acceptance**: zero TaskSpec worktrees remain under any target repo's `.worktrees/`.

#### Acceptance Criteria
- Every implementation row is complete, `INTEGRATE` has already merged the final PR(s), and every TaskSpec PR is closed before this row runs.
- Orphan WIP in the primary checkout (if any) was triaged via POST-FLIGHT.0: round-relevant files preserved to `wip/<taskspec-id>-orphan-<YYYY-MM-DD>` and pushed, tooling cruft left untouched, primary fast-forwarded to `origin/<PR-base-branch>`. No `git stash`, `git reset`, or destructive overwrite was used.
- Squash-merge equivalence proof passed at POST-FLIGHT.2.5 before any worker branch was deleted.
- The `.worktrees/<taskspec-id>` directory is gone from every target repo (shared mode), OR every `.worktrees/<taskspec-id>-*` directory is gone (`--parallel` mode).
- No working-tree contents were lost (POST-FLIGHT.0 preservation + POST-FLIGHT.2 status-check gate are the safeguards).
````

**Dispatch plan integration**: POST-FLIGHT appears as the **last** row in the dispatch plan, in a `Phase ∞` (or the highest-numbered batch). In GIT-mode rounds with code/validation PRs, the row immediately above it is `INTEGRATE`; POST-FLIGHT's `Depends On` cell lists `INTEGRATE` directly or uses the literal token `ALL-PRIOR` which the dispatcher interprets as "every row above this one must be `✅`."

POST-FLIGHT is exempt from PRE-FLIGHT.W's "all workers run inside the TaskSpec worktree" rule because the worktree it operates on is the *subject* being removed. The POST-FLIGHT worker session opens in the primary checkout (`<repo-root>` itself, not any `.worktrees/<taskspec-id>*` path).

### POST-FLIGHT.0 and POST-FLIGHT.2.5 under `--parallel` (v1.24.0)

POST-FLIGHT.0 (orphan-WIP triage) and POST-FLIGHT.2.5 (squash-merge equivalence proof) are unchanged under `--parallel`. The orphan-WIP check runs against the primary checkout regardless of worktree topology — workers leaking into primary is a topology-independent failure mode. POST-FLIGHT.2.5 substitutes the umbrella PR's head ref for `<taskspec-id>/integration` when running under `--parallel` (no shared integration branch exists in that mode), but the empty-diff gate remains the same.

### POST-FLIGHT.2 under `--parallel` (v1.21.0)

Under `--parallel`, POST-FLIGHT.2 must enumerate every TaskSpec-namespaced worktree (`<taskspec-id>` and `<taskspec-id>-*`) and tear them down in order: per-worker worktrees first, integration worktree last. Replace the single-worktree block with:

```bash
# POST-FLIGHT.2 (--parallel mode) — enumerate and remove every TaskSpec worktree
cd <repo-root>

# Pre-flight: verify INTEGRATE merged every per-worker branch into origin/<PR-base-branch>
git fetch origin <PR-base-branch>
for WORKER_ID in R-01 R-02 N-03 R-04 ; do                                           # generator-substituted list
  BR=<taskspec-id>/${WORKER_ID}
  if git rev-parse --verify "$BR" >/dev/null 2>&1; then
    git merge-base --is-ancestor "$BR" "origin/<PR-base-branch>" \
      || { echo "⛔ BLOCKED — ${BR} not in origin/<PR-base-branch>; INTEGRATE incomplete"; exit 1; }
  fi
done

# Enumerate every worktree under .worktrees/<taskspec-id>* (matches both shared and per-worker layouts)
WORKTREES=$(git worktree list --porcelain | awk -v id="<taskspec-id>" '
  /^worktree/ {
    path=$2
    if (path ~ ("\\.worktrees/" id "(-[A-Za-z0-9_-]+)?$")) print path
  }
')

# Per-worker worktrees first (typically <taskspec-id>-<WORKER_ID>), then -integration last
# Sort: -integration goes last; everything else in lexical order
SORTED_WORKTREES=$(echo "$WORKTREES" | awk '/-integration$/{i=$0; next} {print} END{if(i) print i}')

for WT in $SORTED_WORKTREES; do
  cd "$WT"
  if [ -n "$(git status --short)" ]; then
    echo "⛔ BLOCKED — dirty working tree in $WT:"
    git status --short
    exit 1
  fi
  UPSTREAM_REF=$(git rev-parse --abbrev-ref @{upstream} 2>/dev/null || echo "")
  if [ -n "$UPSTREAM_REF" ]; then
    UNPUSHED=$(git log --oneline @{upstream}..HEAD 2>/dev/null)
    if [ -n "$UNPUSHED" ]; then
      echo "⛔ BLOCKED — unpushed commits in $WT:"
      echo "$UNPUSHED"
      exit 1
    fi
  fi
  cd <repo-root>
  git worktree remove "$WT"
done
```

**Acceptance (`--parallel` mode):** `git worktree list` MUST NOT contain any `.worktrees/<taskspec-id>` or `.worktrees/<taskspec-id>-*` entry; every per-worker branch's tip is an ancestor of `origin/<PR-base-branch>`; no uncommitted or unpushed state was force-discarded.

For multi-repo TaskSpecs, repeat the block per `Repo Root` in the Repo Map.

---

## Environment Integrity Standards

### Migration Idempotency (mandatory for all DB Workers)

All database migration files generated or referenced by a TaskSpec **must** be fully idempotent — safe to re-run without error. This is non-negotiable because:
- Pre-existing drift (schema applied outside the migration tool) is common in projects with manual DB access
- The `--allow-out-of-order` repair flow requires re-executing the SQL safely
- Agents cannot make safe judgment calls about partial schema state mid-execution

**Required patterns**:
| SQL Statement | Required Guard |
|---|---|
| `CREATE TABLE` | `IF NOT EXISTS` |
| `CREATE INDEX` | `IF NOT EXISTS` |
| `CREATE UNIQUE INDEX` | `IF NOT EXISTS` |
| `ALTER TABLE ADD COLUMN` | `IF NOT EXISTS` |
| `CREATE EXTENSION` | `IF NOT EXISTS` |
| `CREATE SCHEMA` | `IF NOT EXISTS` |
| `CREATE TYPE` | Use `DO $$ ... IF NOT EXISTS ... $$` block |
| `DROP TABLE / INDEX / COLUMN` | `IF EXISTS` |

When generating Worker sub-tasks for DB migrations, include this constraint:
> **Key constraint**: All DDL statements must use idempotency guards (`IF NOT EXISTS` / `IF EXISTS`). Migration must be re-runnable without error.

### Worker-Scoped Acceptance Criteria (mandatory)

Every Worker's acceptance criteria must validate **only the outputs that Worker produces**, never the global environment state. This prevents workers from being blocked by pre-existing issues outside their scope.

**Bad** (global scope — can fail due to unrelated drift):
> "db:remote:status shows no pending migrations"

**Good** (worker-scoped — validates only this worker's output):
> "db:remote:status shows version 029 in remoteVersions; no new pendingLocal entries were introduced by this worker"

**Rule**: If a Worker's acceptance needs a clean global baseline, that baseline is validated by PRE-FLIGHT, not by the Worker itself. Workers validate their own deliverables; PRE-FLIGHT validates the environment.

**Global baseline rule (v1.22.0):** PRE-FLIGHT may validate a clean global baseline for feature work only after Step 0.5 proves that the baseline is already green. If the baseline is red or unknown, the TaskSpec must either:
- become a dedicated `baseline-cleanup` TaskSpec whose workers fix the global gates, or
- explicitly choose scoped/audit-only mode and document the omitted global gates in `index.md`.

Feature worker acceptance criteria must not say or imply "full repo tests/lint must pass" unless the TaskSpec has a proven strict global baseline. Use scoped commands for the worker's changed surface instead.

---

## Dispatch Plan: PRD Reference Paths (required)

The dispatch plan header must include the delivery and merge policy fields before the PRD reference tables:

````markdown
**Delivery Mode**: GIT | NO-GIT
**Merge Mode**: rollup | per-worker-merge
**Action Run Policy**: action-run-opt-in | required-checks | no-actions | unknown
````

The dispatch plan **must** include a PRD Reference Paths table immediately after the header. Every shorthand label used in the Master Dispatch Table's `PRDs to Attach` column must have a corresponding entry here with its absolute path.

````markdown
### PRD Reference Paths

| Shorthand | Full Path |
|-----------|-----------|
| Pipeline PRD | `/absolute/path/to/pipeline_prd.md` |
| Admin PRD | `/absolute/path/to/admin_prd.md` |
````

**Rule**: If a shorthand appears in `PRDs to Attach` but is missing from this table, the dispatch plan is invalid. Agents must be able to resolve every label to an absolute path without guessing.

For UI-facing rounds, the dispatch plan must also include a Visual Canon Reference Paths table immediately after PRD Reference Paths:

````markdown
### Visual Canon Reference Paths

| Shorthand | Type | Full Path or PRD Section | Bound Workers |
|-----------|------|--------------------------|---------------|
| ChatGPT sample | screenshot | `/absolute/path/to/reference.png` | R-01, R-02, UX-GATE |
| Simplified layout sample | sample-html | `/absolute/path/to/sample-page.html` | R-01, UX-GATE |
````

**Rule**: If a UI worker's Notes cell says `Visual Canon: <label>`, that label MUST appear in this table. If the table would be empty, the TaskSpec is invalid and must return to Step 0.2.

---

## Dispatch Plan: Master Table Template

Under `--meridian`, the Master Dispatch Table is a strict parser contract with meridian-roles. Use the exact 8-column header below, in this order. Do not substitute `Worker ID` for `Worker`, `Phase` for `Batch`, or `Summary` / `Headline` / `Action` for `Task`.

````markdown
| Status | Worker | Batch | Tier | Model | Depends On | Branch | Task |
|---|---|---|---|---|---|---|---|
| ⬜ | PRE-FLIGHT | 0 | T0 | gpt-5.6-luna::low | - | <taskspec-id>/PRE-FLIGHT | Env health check plus worktree setup |
| ⬜ | R-01 | 1 | T1 | gpt-5.6-terra::medium | PRE-FLIGHT | <taskspec-id>/R-01 | [Task name] |
| ⬜ | N-02 | 1 | T3 | gpt-5.6-sol::xhigh | PRE-FLIGHT | <taskspec-id>/N-02 | [Task name] |
| ⬜ | INTEGRATE | Ω | T2 | gpt-5.6-sol::high | ALL-PRIOR | <taskspec-id>/integration | Final PR reconciliation and base merge |
| ⬜ | POST-FLIGHT | ∞ | T0 | gpt-5.6-luna::medium | INTEGRATE | <PR-base-branch> | Integration audit and worktree teardown |
````

Immediately after the strict table, emit the auditable routing record. This is a separate four-column table so it cannot be mistaken for additional Master Dispatch rows:

````markdown
## Model Routing Rationale

| Worker | Tier | Model | Routing signals |
|---|---|---|---|
| PRE-FLIGHT | T0 | `gpt-5.6-luna::low` | Low ambiguity, low blast radius, deterministic proof |
| R-01 | T1 | `gpt-5.6-terra::medium` | Everyday implementation, bounded coupling |
| N-02 | T3 | `gpt-5.6-sol::xhigh` | Async cross-runtime contract, high coupling and proof burden |
| INTEGRATE | T2 | `gpt-5.6-sol::high` | Cross-worker synthesis with reversible merge authority |
| POST-FLIGHT | T0 | `gpt-5.6-luna::medium` | Mechanical teardown with careful safety classification |
````

**Metadata placement:** The strict table intentionally omits `Repo`, `TaskSpec File`, `PRDs`, `PR`, and `Notes`. Put those details in the PRD Reference Paths table, Batch Execution Details, worker files, reports, or non-Master-Dispatch tables with a different column count. Do not add columns to the strict Master Dispatch Table for `--meridian` rounds.

**Repo metadata:** For multi-repo rounds, bind workers to repos in the Repo Map and each worker file's `**Repo**:` header. Do not add a `Repo` column to the strict Master Dispatch Table.

Status values: `⬜` Not started · `🔄` In progress / PR open but not yet merged · `✅` Complete (merged to base branch, local checkout returned to base) · `⛔` Blocked

---

## Dispatch Command: Required Sections

The dispatch command must include all of the following in exact order:

### 0. Round Context Note

At the very top of the dispatch command, include a brief context block:

```
## Round Context

TaskSpec ID: [e.g. v2.4]
Docs Root: [e.g. /Users/yzliu/work/Docs/clawso]
Repo Root: [e.g. /Users/yzliu/work/projects/clawso]
System Overview: [e.g. /Users/yzliu/work/Docs/clawso/system]
PR Base Branch: [e.g. main]
Delivery Mode: GIT | NO-GIT
Merge Mode: rollup | per-worker-merge
Action Run Policy: action-run-opt-in | required-checks | no-actions | unknown

Round Directory: <Docs Root>/branch/<TaskSpec ID>/          # shared root of the 4-sub-folder pipeline layout
  ├── prd/          # /brainstorming output (PRD); read-only for workers
  ├── investigate/  # /investigate output; read-only for workers
  ├── taskspec/     # ← THIS round's dispatch artifacts (see below)
  └── test/         # human deploy-test guide + test reports

TaskSpec Directory: <Docs Root>/branch/<TaskSpec ID>/taskspec/   # all worker/plan/command files live here
Worker files: <TaskSpec Directory>/<WORKER_ID>.md
Dispatch plan: <TaskSpec Directory>/dispatch_plan.md
PM Playbook: <TaskSpec Directory>/pm_playbook.md   # READ before declaring blockers; APPLY in-scope §3 rules
Reports: <TaskSpec Directory>/reports/<WORKER_ID>.md

Test Guide (human-owned, do NOT edit unless explicitly tasked):
  <Docs Root>/branch/<TaskSpec ID>/test/<YYYY-MM-DD>-<project>-<branch-feature>-test-guide.md

Workers create branches as: <TaskSpec ID>/<WORKER_ID>
Workers PR into: <PR Base Branch>
Source code changes go to: <Repo Root> (on the worker's branch)
Reports and dispatch plan updates go to: <TaskSpec Directory> (not in the repo)
PM Playbook is PM-owned: workers READ §1–§3 and may only APPEND new ⏳ PENDING rows to §4. Never edit existing rows.
```

**Multi-Repo Round Context (mandatory when TaskSpec spans 2+ repos):**

When a TaskSpec targets multiple repositories (e.g. a backend repo + a new service repo), the Round Context must include a **Repo Map** that explicitly binds each worker to its target repo:

```
## Repo Map

| Worker Prefix | Repo | Repo Root | PR Base Branch |
|---------------|------|-----------|----------------|
| R-* | Meridian | /abs/path/to/meridian | main |
| N-* | ADS | /abs/path/to/ADS | main |
```

**Multi-repo dispatch rules:**
1. Each implementation worker file must include a **dedicated bullet** `` - **Repo**: `<repo-root>/.worktrees/<taskspec-id>` (<repo-name>) `` in its header — path first and in backticks, repo label after; never merged onto the `**Branch**` bullet (see the Header-Field Wire Format callout) — the path is the **TaskSpec worktree** for that repo, not the long-lived primary checkout. PRE-FLIGHT.W creates one such worktree per target repo. (Under `--meridian`, this is also the `Repo:` field that `resolveWorkerSpawnDir` in `continue-worker.ts` uses to pick the worker's spawn dir.) **Exceptions:** PRE-FLIGHT and POST-FLIGHT both point at the **primary checkout** (`<repo-root>`). PRE-FLIGHT cannot spawn inside the worktree it has not created yet; POST-FLIGHT removes the TaskSpec worktree.
2. Step 3.5b must `cd <repo-root>/.worktrees/<taskspec-id>` before creating the branch — workers MUST NOT create branches in the long-lived primary checkout (that would race with other dispatchers running other TaskSpecs against the same repo).
3. Step 4.0 Working Branch Gate must verify both `pwd` (resolves to the TaskSpec worktree for the correct repo) AND `git branch --show-current` (on correct branch).
4. Workers in different repos are inherently isolated — they cannot pollute each other's working trees. Workers in different TaskSpecs are likewise isolated because each TaskSpec owns its own `.worktrees/<taskspec-id>` directory per repo.
5. Workers in the **same TaskSpec** sharing one TaskSpec worktree are the supported scheme **only under serial dispatch** (`parallel_dispatch.enabled=false` or `max_concurrency=1`). In that mode the Anti-Collision claim-stamp (Step 3.5a, non-`--meridian` only) plus the §3.5c clean-tree assertion together prevent the historical ads-v1 failure mode (intermingled uncommitted changes). **For parallel dispatch** (`max_concurrency>1`), the shared worktree is unsafe — generate the TaskSpec with `--parallel` so PRE-FLIGHT.W creates per-worker worktrees and every worker has its own dedicated cwd. `/dispatch` enforces the topology match at launch and refuses to start a parallel dispatcher on a shared-worktree TaskSpec.

### 0.5. Pre-flight Gate Reminder

Include a prominent note in the dispatch command:

```
## Pre-flight Gate
Before ANY implementation worker starts, PRE-FLIGHT must be ✅.
If PRE-FLIGHT is ⛔ BLOCKED, do NOT proceed with any other worker.
Report the blocker and wait for manual resolution.
```

### 0.6. PM Playbook Consultation Protocol (mandatory)

Include this block verbatim in the dispatch command. Both dispatcher logic (the Step 3.5 claim) and worker execution (Step 4 / Step 5) must honor it.

```
## PM Playbook Consultation

The file `<TaskSpec Directory>/pm_playbook.md` is the human/PM input lane.
Both dispatcher and worker MUST consult it at the moments below. Failing to
consult it before declaring a blocker, applying a workaround, or executing
sub-tasks is a process violation.

WHEN TO CONSULT:
1. At claim time (right after Step 3.5a): READ §3 (Applied Principles & Laws).
   - For every row in §3 whose Scope matches your worker ID or any file you
     will touch, copy the rule text into your worker scratchpad and apply it
     for the entire session. Cite by `Playbook §3.<N>` in your report.
2. Before declaring `⛔ BLOCKED` (in Step 4 or Step 5): READ §1 (Blocker
   Resolutions Library).
   - Grep the Trigger Keywords column for the symptom you are about to file.
     If a match exists, apply the Resolution column verbatim BEFORE marking
     the row blocked. Cite by `Playbook §1.<N>` in your report.
   - If no match exists, you MAY mark the row `⛔ BLOCKED`, AND you MUST
     append a new `⏳ PENDING` row to §4 (Open Questions) describing the
     blocker. Use the §4 template at the bottom of `pm_playbook.md`. Never
     edit existing §1/§2/§3 rows; you are append-only on §4.
3. Before retrying a failed AI Auto-Test or Behavioral Assertion (in Step 5):
   READ §2 (Failure Recovery Patterns).
   - If the failure signal matches a §2 row, apply the Recovery Steps and
     respect the Escalate When threshold (e.g. "after 2 retries"). Cite by
     `Playbook §2.<N>`.

REPORT REQUIREMENT:
Your completion report MUST include a `## PM Playbook References` section
listing every Playbook entry you applied (`§1.<N>`, `§2.<N>`, `§3.<N>`) and
every `§4` row you opened. Empty list is acceptable; missing section is not.

DEPENDENCY GATE:
Before claiming a row, check §4 for any `⏳ PENDING` question whose Asked-By
worker is one of your `Depends On`. If found, leave the row `⬜` and PAUSE
with `⏸ PAUSE — awaiting Playbook §4.<N>`. Do NOT claim.
```

### 1. Environment Configuration block

Must include:
- Absolute path to `.env.local` (or confirmed env file)
- Exact env var names (never assume names — use confirmed names)
- Explicit prohibition of `supabase db reset` / `supabase start` / `supabase status` if local Docker is not in use
- Approved DB validation commands (e.g. `npm run db:remote:apply`, `npm run db:remote:status`)
- Note that TaskSpec artifacts, reports, and dispatch plans live in the external Docs directory (not in the repo) — no `git add` needed for those files
- **Harness clarification** (mandatory whenever startup, bootstrap, or recovery behavior matters): describe it directly in the dispatch command using confirmed project-local commands and paths. The TaskSpec must remain self-contained.

**TaskSpec Harness Boundary Rule:**

The dispatch command is the harness. If a project needs startup validation, bootstrap commands, repair steps, or retry boundaries, write them explicitly inside the TaskSpec artifacts themselves using confirmed project-local paths and commands.

If a startup or recovery path is mechanical and project-local, include the exact detection rule, repair command, and retry boundary directly in the dispatch command.

If recovery depends on missing project facts, hidden context, or external access outside the TaskSpec scope, PRE-FLIGHT must mark the work blocked and stop. Do not rely on any separate convention file, bootstrap layer, or out-of-band framework to fill the gap.

**Why this exists:** TaskSpec must be the only execution harness. A dispatched worker should be able to proceed from the TaskSpec artifacts alone, without injected context or undocumented startup behavior.

### 2. Worker Identity Declaration

```
Before doing anything else, determine which model you are:
Your worker code is the exact `<modelId>` or `<modelId>::<effort>` string in the dispatch plan's Model column for the row you are claiming. Examples:
- If you are Claude Opus 4.8 with effort `xhigh` → your worker code is `claude-opus-4-8::xhigh`
- If you are Claude Opus 4.7 with effort `high` → your worker code is `claude-opus-4-7::high`
- If you are Claude Sonnet 4.6 → your worker code is `claude-sonnet-4-6` (or `claude-sonnet-4-6::medium` if the row specifies effort)
- If you are Claude Haiku 4.5 with effort `low` → your worker code is `claude-haiku-4-5-20251001::low`
- If you are Codex Luna with effort `low` → your worker code is `gpt-5.6-luna::low`
- If you are Codex Terra with effort `medium` → your worker code is `gpt-5.6-terra::medium`
- If you are Codex Sol with effort `xhigh` → your worker code is `gpt-5.6-sol::xhigh`
- If the row specifies `max` or `ultra`, that literal suffix is part of your worker code; `ultra` does not authorize claiming another dispatch row
- If you are Gemini Pro → your worker code is `gemini-2.5-pro` (no effort suffix; runtime drops it)
- If you cannot determine your modelId and effort → output `PAUSE — unable to determine worker code` and stop.
- Rows with Model = HUMAN are manual authority gates for operator-owned credentials, production consoles, or external decisions. You are never HUMAN. Skip these rows. GUI, UX, browser, staging, and product-acceptance checks must be model-assigned agent E2E rows, not HUMAN rows.
```

### 3. Step 1 — Read the Dispatch Plan

Point to confirmed absolute path of dispatch plan. Worker finds the first row where:
1. Status is `⬜`
2. Model column matches its code
3. All `Depends On` workers are `✅`
4. All `Depends On` workers' PRs are merged to the base branch (PR column shows merge status)

If no such row exists, output `⏸ PAUSE — no eligible row for [MODEL]` and stop. Do **not** keep scanning for extra work or infer permission to bundle multiple rows into one session.

This selection happens **once per command invocation** and therefore **once per session**. Claim only that single row. Do **not** return to Step 1 after completion. If a follow-up row becomes eligible, it belongs to a **new** dispatch command and a **new** session.

### 4. Step 2 — Dependency Check

Block with `⛔ BLOCKED` message if any dependency is not `✅` or if any dependency's PR is not yet merged to the base branch.

**PM Playbook §4 dependency gate:** also scan `pm_playbook.md` §4 (Open Questions). If any `⏳ PENDING` row was filed by one of your `Depends On` workers, leave the row `⬜` and PAUSE with `⏸ PAUSE — awaiting Playbook §4.<N>`. Do not claim until PM resolves the question.

### 5. Step 3 — Self-Check

Pause with `⏸ PAUSE` if the next task belongs to the other model.

### 5.5. Step 3.5 — Claim Stamp & Branch Creation

> **This is the single most time-critical step in the entire dispatch flow.**

Immediately after passing Self-Check — before reading ANY source code, before analyzing the task, before opening any project files — the worker session must:

**3.5a: Claim stamp (anti-collision lock)**
1. Open the dispatch plan file
2. Change the claimed row's status from `⬜` to `🔄`
3. The claim lock covers **that one row only**

**3.5a.5: PM Playbook §3 pre-load (mandatory)**
1. Read `pm_playbook.md` §3 (Applied Principles & Laws)
2. For every row whose Scope matches your worker ID (e.g. `R-*`, `R-04`) or any file path you will touch, copy the rule into your scratchpad and apply it for the entire session
3. Record the matched §3 row numbers — they MUST appear in your completion report's `## PM Playbook References` section

**3.5b: Create or switch to worker branch (idempotent) and verify isolation**

The shared TaskSpec worktree (per §3.5c) is left on the *previous worker's branch* by design — workers complete by pushing their branch and exiting the shared worktree without switching back. Your first job inside the worktree is to make sure you are on YOUR branch, whether that means creating it fresh or checking out an existing one (PRE-FLIGHT pre-creates branch stubs in some round shapes; retries re-enter an already-created branch).

1. For multi-repo rounds: `cd <repo-root>` (the repo specified for this worker in the dispatch table).
2. **Idempotent branch checkout:**
   ```bash
   git fetch origin <PR-base-branch>
   git status --short            # MUST be empty — the prior worker left no WIP

   # Switch to your branch. Works whether the branch was just created by
   # PRE-FLIGHT, already exists from a prior worker attempt, or doesn't
   # exist yet — never assume the worktree is on the base branch.
   if git rev-parse --verify <taskspec-id>/<WORKER_ID> >/dev/null 2>&1; then
     git checkout <taskspec-id>/<WORKER_ID>
   else
     git checkout -b <taskspec-id>/<WORKER_ID> origin/<PR-base-branch>
   fi
   ```

   If `git status --short` shows any modified/untracked files at this point, **STOP immediately** — the prior worker left WIP in the shared worktree. Report this as `⛔ BLOCKED — dirty working tree from prior worker` and stop. Do NOT `git stash` or `git restore`; that destroys evidence.

3. **Branch Isolation Verification (mandatory, after the checkout):**
   ```bash
   # This MUST output exactly: <taskspec-id>/<WORKER_ID>
   git branch --show-current
   ```
   If it does not match, **STOP with `outcome: failed`, `error: wrong-branch`**. By this point the checkout step above should have ensured a match, so a failure here means something deeper went wrong (corrupt worktree, branch name collision with an unrelated ref); do not paper over it.

**Rule:** `<PR-base-branch>` must already exist locally or on `origin` before dispatch begins. Workers may create a local tracking branch from an existing remote base branch, but they must never invent or create a brand-new base branch.

**Why the idempotent form** (v1.25.0 hardening, skills-ux-2026-06-04 BATCH-2-GATE incident): the previous template emitted just `git checkout -b <branch> origin/<base>`. When PRE-FLIGHT pre-creates the worker branch (or a retried worker re-enters), `checkout -b` fails on existing branch. The shared worktree at that moment is on the prior worker's branch. Strict workers (Codex following the spec literally) emit `outcome: failed, error: wrong-branch` at the verification step and the round stalls; lenient workers improvise their own checkout and pass — non-deterministic behavior across the same round. The idempotent if/else above closes the gap deterministically.

**3.5c: TaskSpec worktree (always — per-TaskSpec, not per-worker) — v1.15.0**

Every TaskSpec gets **one shared git worktree** for all of its workers. The worktree path is keyed by `<taskspec-id>`, not by `<WORKER_ID>`. This is the disk-and-coordination scheme that supports the actual usage pattern: **multiple dispatchers running different TaskSpecs in parallel**, with workers **inside one TaskSpec running serially** in the shared worktree.

**Path rule (non-negotiable):**
- Worktree path is **always** `<repo-root>/.worktrees/<taskspec-id>`.
- `<repo-root>` is the `Repo Root` value present in the dispatch_command's Round Context block (or, for multi-repo TaskSpecs, the per-worker `**Repo**:` field — one TaskSpec worktree per target repo).
- NEVER use per-worker paths like `<repo-root>/.worktrees/<WORKER_ID>` — that was the v1.14 scheme and is now retired. (Existing in-flight TaskSpecs that already use the per-worker path may finish under the old rule; the new rule applies to TaskSpecs generated from v1.15.0 onward.)
- NEVER emit sibling-dir paths like `<repo-name>-wt-<taskspec-id>` under the projects parent.

**Who creates the worktree:** the `PRE-FLIGHT` row owns it. The generator MUST emit, in PRE-FLIGHT's `#### Sub-tasks`:

```bash
# PRE-FLIGHT.W — TaskSpec worktree setup (once per TaskSpec, once per target repo)
cd <repo-root>
grep -qxF '.worktrees/' .gitignore || echo '.worktrees/' >> .gitignore
git worktree list --porcelain | grep -q "<repo-root>/.worktrees/<taskspec-id>" \
  || git worktree add <repo-root>/.worktrees/<taskspec-id> origin/<PR-base-branch>
cd <repo-root>/.worktrees/<taskspec-id>
[ -e node_modules ] || ln -s <repo-root>/node_modules ./node_modules
for dir in apps/client apps/web apps/cli packages/i18n packages/api-contracts packages/design-system; do
  if [ -d "<repo-root>/$dir/node_modules" ] && [ ! -e "$dir/node_modules" ]; then
    ln -sfn "<repo-root>/$dir/node_modules" "$dir/node_modules"
  fi
done
```

For multi-repo TaskSpecs, PRE-FLIGHT repeats this block once per `Repo Root` in the **Repo Map**.

**What every subsequent worker does** (replaces the old per-worker `git worktree add`):

```bash
# At the very top of Step 3.5b, before the existing `git fetch` / `git checkout -b`:
cd <repo-root>/.worktrees/<taskspec-id>      # the shared TaskSpec worktree
git status --short                            # MUST be empty — serial-worker invariant
# (The clean-tree assertion in Step 3.5b.4 above remains in force.)
```

The existing Step 3.5b lines (`git fetch origin <PR-base-branch>`, `git checkout -b <taskspec-id>/<WORKER_ID> origin/<PR-base-branch>`, Branch Isolation Verification) then run inside this shared worktree.

**Serial-worker invariant (the new WIP-loss defense):**
- At any moment, at most **one** worker session within a single TaskSpec is active in `<repo-root>/.worktrees/<taskspec-id>`.
- The Anti-Collision claim-stamp (Step 3.5a) already enforces this at the dispatch_plan level: only one row inside one TaskSpec may sit at `🔄`. Workers inside the same TaskSpec are NEVER dispatched concurrently. Cross-TaskSpec parallelism is safe because each TaskSpec owns a distinct worktree path.
- The `git status --short` MUST-be-empty check above is the runtime guard: if a prior worker in this TaskSpec left WIP behind (failed to commit, crashed mid-edit), the next worker reports `⛔ BLOCKED — dirty TaskSpec worktree from prior worker <prev-id>` and stops, surfacing the contamination loudly instead of inheriting it.
- Under `--meridian` **without `--parallel`** (serial dispatch): meridian-roles' `continue-dispatcher` resolves at most one eligible worker per tick via `service-continuation.ts:37` (`resolveFirstEligibleContinueWorker`, which wraps `resolveEligibleServiceContinueWorkers(..., { limit: 1 })`); `continue-worker.ts:114` short-circuits already-`running` workers. Each worker's `**Repo**:` points at the shared TaskSpec worktree `<repo-root>/.worktrees/<taskspec-id>` (see Multi-Repo Round Context). The §3.5c clean-tree assertion is the runtime guard against WIP carryover between serial workers.
- Under `--meridian --parallel` (parallel dispatch — required whenever `/dispatch` will use `codex-para` or any `max_concurrency>1` config): meridian-roles' `role-handlers.ts:970-1059` launches multiple dependency-eligible workers concurrently. Each worker's `**Repo**:` points at its own per-worker worktree `<repo-root>/.worktrees/<taskspec-id>-<WORKER_ID>`, and BATCH/INTEGRATE/V-* rows use `<repo-root>/.worktrees/<taskspec-id>-integration`. PRE-FLIGHT.W creates N+1 worktrees up front; POST-FLIGHT.2 enumerates and removes them all. The §3.5c clean-tree assertion in this mode applies to the worker's OWN dedicated worktree (recovering from a crashed prior session), not to inter-worker WIP.

**Final integration and cleanup:** the per-worker `git worktree remove` is **gone**. GIT-mode code rounds have two terminal rows: `INTEGRATE` performs final base-branch refresh, Action Run Policy classification, policy-required check waiting, PR merge, superseded PR closure, and obsolete branch cleanup; `POST-FLIGHT` then audits that integration state and removes the TaskSpec worktree. POST-FLIGHT is the last row and must not do first-time merge work.

Cite `learnings/process/parallel-dispatch-needs-per-worker-worktree-and-node-modules-symlink.md` (or the project-local equivalent — see its 2026-05-13 addendum on the granularity shift) as the authority for the path convention and the WIP-loss diagnostic. Do NOT copy that doc's `clawso/.worktrees/...` example verbatim into a TaskSpec targeting a different repo — substitute the active `<repo-root>` and `<taskspec-id>`.

**Only then** proceed to Step 4 (Execute).

**Why claim is mandatory and first:**
- Multiple worker sessions may be dispatched simultaneously against the same dispatch plan
- If a worker session reads the plan, finds an eligible row, then spends time analyzing the codebase before marking `🔄`, another worker session can pick the same row during that analysis window
- Analysis, file reading, and planning happen **AFTER** the claim and branch creation, never before

### 6. Step 4 — Read Worker File & Execute

**4.0: Working Branch Gate (mandatory before ANY code changes):**
Before reading source code or making any changes, verify you are on your worker branch:
```bash
# MUST output exactly: <taskspec-id>/<WORKER_ID>
CURRENT_BRANCH=$(git branch --show-current)
if [ "$CURRENT_BRANCH" != "<taskspec-id>/<WORKER_ID>" ]; then
  echo "⛔ WRONG BRANCH: on $CURRENT_BRANCH, expected <taskspec-id>/<WORKER_ID>"
  exit 1
fi
```
If this check fails, **STOP with `⛔ BLOCKED`**. Do NOT proceed to write code on the wrong branch.

- Read `branch/<taskspec-id>/taskspec/<WORKER_ID>.md` for the full worker definition (sub-tasks, tests, acceptance criteria)
- If your worker file contains `#### Visual Canon`, read it before touching UI code and treat it as binding PRD context. Keep the Negative Visual Rules visible while implementing. If the functional task conflicts with the Visual Canon, file a PM Playbook §4 question and stop instead of drifting.
- **Read every entry in your Context Capsule's `## Applicable Laws` section before starting any sub-task.** Laws bind. The card carries only a pointer; the binding set is in `context/<WORKER_ID>-context.md`. If a law conflicts with your brief, use the LAW CONFLICT escalation described in the worker file.
- **Read every entry in your `#### Referenced Learnings` section before starting any sub-task.** The TaskSpec generator already curated these from `/Users/yzliu/work/Docs/Projects/<project>/learnings/` for your scope; you MUST NOT independently `ls` or `rg` that directory — the curated list is authoritative for this row. If a curated learning conflicts with current code, prefer what you observe and flag the stale entry in your completion report. If the section reads `Referenced Learnings: N/A — …`, skip this step.
- If cross-worker context is needed, read `branch/<taskspec-id>/taskspec/index.md` for runtime contracts and integration points
- PRD is the authority over TaskSpec
- Run AI Auto-Tests after each sub-task
- Run Behavioral Assertions (Layer 2) to verify correctness
- Scope discipline: no touching files outside the Worker's scope
- Before committing: if your changes affect any file, route, contract, or entry point documented in the system overview modules, update those module docs following FORMAT_SPEC.md tagging rules. System overview path: `<system-overview-path>`
- Blockers → **first** grep `pm_playbook.md` §1 (Blocker Resolutions Library) for the symptom keywords. If a row matches, apply the Resolution column verbatim and continue (cite `Playbook §1.<N>` in your report). Only if no §1 match exists may you mark `⛔ BLOCKED` in the dispatch plan with question in Notes — and you MUST also append a new `⏳ PENDING` row to `pm_playbook.md` §4 (Open Questions) describing the blocker, then STOP session.
- **After all sub-tasks, AI Auto-Tests, and Behavioral Assertions pass → proceed to Step 5.** Passing tests is NOT the end of the task. The worker file's Completion Protocol section and Step 5 below define the actual completion criteria: commit, push, PR, merge, resync, report.

### 7. Step 5 — Completion, PR, Merge, Base Resync

5a: Run all AI Auto-Tests from the worker file one final time
5b: Run all Behavioral Assertions from the worker file
5c: If any fail → consult `pm_playbook.md` §2 (Failure Recovery Patterns) by failure signal. If a row matches, apply Recovery Steps and respect the Escalate-When threshold (cite `Playbook §2.<N>` in the report). If still failing after the §2 threshold (or no §2 match) → consult §1 for a sanctioned workaround; if none → mark `⛔ BLOCKED`, document in Notes, append a new `⏳ PENDING` row to §4, STOP
5d: **Pre-Commit Branch Assertion (mandatory):**
    ```bash
    # All 3 checks must pass before committing
    # 1. Verify on correct branch
    git branch --show-current  # MUST be <taskspec-id>/<WORKER_ID>
    # 2. Verify there are staged or unstaged changes to commit
    git diff --stat HEAD       # MUST be non-empty — if empty, your work was lost or never saved
    # 3. Verify branch has not been contaminated by other workers
    git log --oneline origin/<PR-base-branch>..HEAD  # Should show only YOUR commits (or none if first commit)
    ```
    If check 1 fails: you are on the wrong branch — **STOP with `⛔ BLOCKED`**.
    If check 2 fails: your changes are not in the working tree — **STOP with `⛔ BLOCKED — no changes found`**.
    Then commit: `git add <changed files> && git commit -m "[WORKER_ID] <task summary>"`
5e: Push branch to origin: `git push -u origin <taskspec-id>/<WORKER_ID>`
5f: Create PR:
    ```
    gh pr create --base <PR-base-branch> --title "[WORKER_ID] — <task name>" --body "$(cat <<'EOF'
    ## [WORKER_ID] — <Task Name>

    **TaskSpec**: `branch/<taskspec-id>/taskspec/<WORKER_ID>.md`
    **Batch**: N
    **Depends on**: [Worker IDs]

    ### Changes
    - [Generated from sub-task list]

    ### Validation
    - [x] AI Auto-Tests passed
    - [x] Behavioral Assertions passed

    Generated by TaskSpec dispatch
    EOF
    )"
    ```
    Do not include `[run-action]` or any project-specific Actions opt-in marker in the PR title/body unless the Round Context `Action Run Policy` explicitly opts into the Actions lane or the user requested it.
5g: Record the PR URL in the dispatch plan's PR column and leave the row `🔄` until merge is complete
5h: Merge the PR into the base branch. Prefer an explicit non-interactive merge command such as:
    `gh pr merge --merge --delete-branch=false <PR-number-or-URL>`
5i: If the PR does not merge immediately because approvals, conflicts, or policy-required checks are still pending, do **not** mark `✅`. Leave the row `🔄`, update Notes with the merge blocker, write the report, and stop. Under `Action Run Policy: action-run-opt-in`, skipped GitHub Actions or a failed opt-in detector such as `Detect [run-action] opt-in` are not merge blockers unless this row explicitly opted into Actions.
5j: After the PR is merged, resync the local repo to the base branch:
    1. `git fetch origin <PR-base-branch>`
    2. `git checkout <PR-base-branch>`
    3. `git pull --ff-only origin <PR-base-branch>`
5k: Only after the merged commit is present on the local base-branch checkout, update the dispatch plan status to `✅`
5kk: **Capture Reusable Learnings (mandatory — `/ship-changes` §10 contract):** Ask: did this row produce a non-obvious finding future agents should reuse — a root cause, verified diagnostic, environment contract, recurring failure, architectural constraint, or a STALE correction to a curated `#### Referenced Learnings` entry? If yes:
    - Resolve `learnings_dir="/Users/yzliu/work/Docs/Projects/$(basename "$(git rev-parse --show-toplevel)")/learnings"`. If the path does not exist, list `/Users/yzliu/work/Docs/Projects/` and pick the obvious project slug; if none obvious, file a `⏳ PENDING` row in `pm_playbook.md` §4 instead of guessing.
    - **Check `index.md` first:** `cat "${learnings_dir}/index.md" 2>/dev/null` — if it exists, match topic keywords against `## Entries` summaries/tags to find an existing slug; note `## Layout` for placement. Fallback if no index: `rg --files "$learnings_dir"` then `rg -i "<topic>|<tool>|<error>|<module>" "$learnings_dir"`.
    - If existing slug found and content fully covers the insight: **skip** (do not duplicate). If distinct angle: **append a dated entry**.
    - If no match: create `${learnings_dir}/<topic-slug>.md` (or `<subdir>/<topic-slug>.md` for multi-tier) with: Date · Context/symptom · Root cause / key insight · Files/commands/PRs/docs · Reuse guidance.
    - **After writing or appending:** if `index.md` exists, append/update one entry: `` - `<relative-path>` — <one-sentence summary> — tags: <tag1>, <tag2> ``
    - Do NOT capture: routine syntax, one-off trivia, secrets/credentials, or anything already covered by an unchanged curated learning.
    - Learnings live in the external Docs directory — not committed to the repo.
5l: Write completion report to `<Docs root>/branch/<taskspec-id>/taskspec/reports/<WORKER_ID>.md`
    **Mandatory sections in the report:**
    1. `## PM Playbook References` — list every Playbook entry applied during this row (`§1.<N>`, `§2.<N>`, `§3.<N>`) and every `§4` row opened. If none, write the section with the line `None applied this row.`
    2. `## Referenced Learnings Applied` — for each entry from your `#### Referenced Learnings` curated list that shaped a decision, list `<filename slug> — <one-line how it shaped the decision>`. If none applied, write `None applied this row.` If a curated learning was found stale (conflicted with current code), prefix it with `STALE:` and describe the divergence so PM can update or retire it.
    3. `## Learnings Captured` — list each learning file you created or appended in step 5kk, as `<absolute path> — <one-line summary of the finding>`. If none captured, write the literal line `None — no reusable finding this row.` Missing the section is a process violation.
    4. `## Learnings Discovered` *(optional — include only if you found a relevant learning that was NOT in your curated list AND not captured this row)* — list `<filename slug> — <why it should have been curated for this worker>`. PM will decide whether to expand the curation rules in the next round.
    Missing §1, §2, or §3 is a process violation; §4 is informational and may be omitted when empty.
    **Note:** Source code commits go to the repo branch. Report writes and dispatch plan updates go to the external Docs directory — they are NOT committed to the repo.
5m: **Stop immediately and end the session.** Do not re-open Step 1, do not claim another row. A new row requires a new explicit dispatch command in a **new** session.

---

## Branch Naming Convention

Every worker gets its own branch:

```
<taskspec-id>/<WORKER_ID>
```

Examples: `v2.4/R-01`, `v2.4/N-02`, `v2.4/PRE-FLIGHT`, `v2.4/BATCH-2-GATE`

Workers in batch N+1 create their branch from the PR base branch (usually `main`) AFTER all batch N PRs are merged.

---

## PR Template

Workers create PRs using `gh pr create` with this body template:

````markdown
## [WORKER_ID] — <Task Name>

**TaskSpec**: `branch/<taskspec-id>/taskspec/<WORKER_ID>.md`
**Batch**: N
**Depends on**: [Worker IDs]

### Changes
- [Generated from sub-task list]

### Validation
- [x] AI Auto-Tests passed
- [x] Behavioral Assertions passed

Generated by TaskSpec dispatch
````

**Action-run marker rule:** Do not add `[run-action]` or any project-specific Actions opt-in marker to the PR title/body unless the TaskSpec's `Action Run Policy` and the user explicitly selected the Actions lane.

---

## Conflict Resolution Rule (mandatory verbatim block in TaskSpec)

Include this exact block under `## 冲突処理規則` (or `## Conflict Resolution Rules`) near the top of the TaskSpec:

> PRD document > This TaskSpec > Previous implementation. Any discrepancy with the PRD must defer to the MVP PRD set. Requirements not defined in the PRD: developer must pause and file an issue; do not proceed until PM provides a clear definition.

---

## TaskSpec Index Template (`branch/<taskspec-id>/taskspec/index.md`)

The index file is the master overview for PM/human review and cross-worker context. Workers do NOT read this during execution — they read only their own `branch/<taskspec-id>/taskspec/<WORKER_ID>.md` file. The index is consulted only when a worker needs cross-worker integration details.

````markdown
# TaskSpec — [Project Name] [Version]

**Date**: [date]
**Input documents**: [list with absolute paths]
**TaskSpec ID**: [e.g. v2.4]
**PR base branch**: main
**Delivery Mode**: GIT | NO-GIT
**Merge Mode**: rollup | per-worker-merge
**Action Run Policy**: action-run-opt-in | required-checks | no-actions | unknown
**Action Run Policy Rationale**: [e.g. Clawso `/ship-changes` requires `--git-action` plus `[run-action]` before Actions are expected]

## Conflict Resolution Rule

> PRD document > This TaskSpec > Previous implementation. Any discrepancy with the PRD must defer to the MVP PRD set. Requirements not defined in the PRD: developer must pause and file an issue; do not proceed until PM provides a clear definition.

## Visual Canon (UI-facing rounds only)

Omit this section only when the round touches no rendered UI.

- **Sources**: <absolute screenshot/mockup/sample HTML/design-system/PRD-section paths>
- **Target hierarchy/density**: <summary>
- **Typography/spacing/chrome rules**: <summary>
- **Negative Visual Rules**: <summary>
- **Required screenshot evidence**: <routes/viewports/states>

## Dispatch Table (Overview)

| Batch | Worker | Task | Model | Depends On | File |
|-------|--------|------|-------|------------|------|
| 0 | PRE-FLIGHT | Env Health Check | claude-haiku-4-5-20251001::low | - | branch/<taskspec-id>/taskspec/PRE-FLIGHT.md |
| 1 | R-01 | [Task] | claude-sonnet-4-6::medium | - | branch/<taskspec-id>/taskspec/R-01.md |

## Model Routing Rationale

| Worker | Tier | Model | Routing signals |
|--------|------|-------|-----------------|
| PRE-FLIGHT | T0 | `claude-haiku-4-5-20251001::low` | Low ambiguity, deterministic proof, low blast radius |
| R-01 | T1 | `claude-sonnet-4-6::medium` | Well-specified everyday implementation with bounded coupling |

## Worker File Manifest

| Worker | File Path (relative to Docs root) | Branch |
|--------|-----------|--------|
| PRE-FLIGHT | branch/<taskspec-id>/taskspec/PRE-FLIGHT.md | <taskspec-id>/PRE-FLIGHT |
| R-01 | branch/<taskspec-id>/taskspec/R-01.md | <taskspec-id>/R-01 |

## Cross-Worker Integration Points

| Producer | Consumer | Contract |
|----------|----------|----------|
| [Worker ID] ([service/endpoint]) | [Worker ID] ([service]) | [Request → Response] |

## Runtime Contracts

[Full runtime contracts for async/event/IPC integrations — see Runtime Contracts template below]
````

---

## PM Blocker Resolutions

When decisions were deferred from a previous round or resolved during pre-generation review, include a `## PM Blocker Resolutions` section immediately after the Conflict Resolution Rule. This section captures those decisions so workers have explicit guidance.

Format:

```markdown
## PM Blocker Resolutions

| # | Question | Resolution |
|---|----------|------------|
| 1 | [Deferred question from previous round] | [Explicit PM decision — do not leave blank] |
| 2 | [Edge case resolved during pre-generation] | [Explicit PM decision] |
```

**Rule**: Every worker that depends on a PM decision must reference its blocker resolution number in its sub-task descriptions (e.g. "Per PM Blocker Resolution #1: implement now, stub is not acceptable").

If a blocker resolution is not yet decided, mark it `⏳ PENDING` and do NOT dispatch the dependent worker until it is resolved.

Always include a table at the end of the TaskSpec:

````markdown
## Cross-Worker Integration Points

| Producer | Consumer | Contract |
|----------|----------|----------|
| [Worker ID] ([service/endpoint]) | [Worker ID] ([service]) | [Request schema → Response schema] |
````

Immediately after the integration points table, include a **Runtime Contract** section for every cross-worker integration point that involves async operations, events, or IPC:

````markdown
## Runtime Contracts (mandatory for async/event/IPC integration points)

### [Producer Worker] → [Consumer Worker]: [Integration name]

**Producer emits:**
- Event/command: `[exact event name or IPC command]`
- Payload: `{ field1: type, field2: type }` (Rust snake_case → TS camelCase via serde)
- Timing: [when this fires relative to the overall flow — e.g., "immediately on function entry", "after async operation completes"]

**Consumer expects:**
- Listener registered: [when — e.g., "in useEffect on mount", "awaited before command invocation"]
- Listener teardown: [when — e.g., "useEffect cleanup", "after promise resolves"]
- Data consumed as: [how the payload is used — e.g., "setState update", "prop passed to child"]

**Failure mode:**
- If producer fires before consumer registers: [what happens — e.g., "event lost, progress bar stuck at 0%"]
- If producer errors: [what the consumer sees — e.g., "promise rejection caught in .catch, error state shown"]
- If consumer unmounts mid-flow: [what happens — e.g., "unlisten called, Rust command continues but events are dropped"]

**Ordering invariant:**
```
[Step 1]: Consumer registers listener (MUST await)
[Step 2]: Consumer invokes producer command
[Step 3]: Producer emits events (safe — listener is registered)
[Step 4]: Consumer processes events
[Step 5]: Consumer cleans up listener
```
````

**Why Runtime Contracts exist:** The openclaw-fix incident demonstrated that Cross-Worker Integration Points verified only by type compilation (struct fields match) can still fail at runtime due to timing, ordering, and lifecycle issues. Runtime Contracts force the TaskSpec to specify the behavioral contract — not just the data shape — so that both producer and consumer workers implement the same flow.

---

## PM Flags

When generating, identify and surface:
- Execution order conflicts within a batch (e.g. FK cascade risks)
- Business logic edge cases that could be misimplemented (flag with explicit resolution)
- Intentionally vague requirements that need a mock/stub for MVP

Format in both the Dispatch Plan (PM Flags Summary table) and the relevant batch's worker notes block.

---

## Dev History Path Conventions

All artifacts live in the **external Docs directory**, NOT in the project repository. The canonical layout under v1.19.0 is the **four-sub-folder round directory** at `./Docs/<project>/branch/<taskspec-id>/` (resolved to an absolute path such as `/Users/yzliu/work/Docs/clawso/branch/v2.4/`), with `/taskspec/` as the sub-folder owning all generated dispatch artifacts. The repo contains only source code.

**Round directory:** `<Docs root>/branch/<taskspec-id>/`
**Docs base path (this skill's artifacts):** `<Docs root>/branch/<taskspec-id>/taskspec/`

| Artifact | Path |
|----------|------|
| Round directory (4 sub-folders) | `<Docs root>/branch/<taskspec-id>/` |
| PRD sub-folder (not written by this skill) | `<Docs root>/branch/<taskspec-id>/prd/` |
| Investigation sub-folder (not written by this skill) | `<Docs root>/branch/<taskspec-id>/investigate/` |
| TaskSpec index | `<Docs root>/branch/<taskspec-id>/taskspec/index.md` |
| Worker definitions | `<Docs root>/branch/<taskspec-id>/taskspec/<WORKER_ID>.md` |
| Dispatch plan | `<Docs root>/branch/<taskspec-id>/taskspec/dispatch_plan.md` |
| Dispatch command | `<Docs root>/branch/<taskspec-id>/taskspec/dispatch_command.md` |
| PM Playbook | `<Docs root>/branch/<taskspec-id>/taskspec/pm_playbook.md` |
| Completion reports | `<Docs root>/branch/<taskspec-id>/taskspec/reports/<WORKER_ID>.md` |
| Test guide (mandatory, Chinese default) | `<Docs root>/branch/<taskspec-id>/test/<YYYY-MM-DD>-<project>-<branch-feature>-test-guide.md` |
| System overview | `<Docs root>/system/` |

Example using Docs root `/Users/yzliu/work/Docs/mumu`, TaskSpec ID `category-workbench-2026-05-26`:
- Round directory → `/Users/yzliu/work/Docs/mumu/branch/category-workbench-2026-05-26/`
- TaskSpec index → `/Users/yzliu/work/Docs/mumu/branch/category-workbench-2026-05-26/taskspec/index.md`
- Worker file → `/Users/yzliu/work/Docs/mumu/branch/category-workbench-2026-05-26/taskspec/R-01.md`
- Dispatch plan → `/Users/yzliu/work/Docs/mumu/branch/category-workbench-2026-05-26/taskspec/dispatch_plan.md`
- Report → `/Users/yzliu/work/Docs/mumu/branch/category-workbench-2026-05-26/taskspec/reports/R-01.md`
- Test guide → `/Users/yzliu/work/Docs/mumu/branch/category-workbench-2026-05-26/test/2026-05-26-mumu-category-workbench-test-guide.md`
- System overview → `/Users/yzliu/work/Docs/mumu/system/SYSTEM_INDEX.md`

---

## Quick Reference: Session Strategy

Every new dispatch row starts in a **new session**. Reusing context never permits reusing the same session.

```
Does the next task need context from the previous task?
├── Yes → Inject structured summary into a new session
│         └── If context is long (>50 turns) → new session + summary regardless
└── No  → New session
```

**Accuracy-first**: When in doubt, new session.

---

## Formatting Standards

- Worker IDs: `R-01`, `N-02`, `D-01`, `V-01` (prefix + two-digit number)
- Sub-task IDs: `R-01.1`, `R-01.2`
- All file paths: absolute or repo-root-relative with confirmed root
- Dependency notation: `depends_on: [R-01, D-01]` or a `Depends On` column value. In generated dispatch-plan Master Dispatch Tables, use `-` for no dependency, exact Worker IDs for explicit dependencies, and `ALL-PRIOR` only for terminal all-prior gates.
- Priority: P0 (blocking), P1 (core), P2 (optional/cleanup)
- Delta type in Worker header: always one of `REWORK / NEW / DELETE / KEEP / DRIFT / VERIFY`
