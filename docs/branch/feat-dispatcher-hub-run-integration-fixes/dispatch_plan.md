# Meridian Dispatcher Integration Dispatch Plan

- **Primary Repo Root**: `/Users/yzliu/work/Meridian`
- **Primary Branch**: `feat-dispatcher-hub-run-integration-fixes`
- **TaskSpec**: `/Users/yzliu/work/Meridian/docs/branch/feat-dispatcher-hub-run-integration-fixes/meridian_dispatcher_integration_taskspec_v1.0.md`
- **Dispatch Command**: `/Users/yzliu/work/Meridian/docs/branch/feat-dispatcher-hub-run-integration-fixes/agent_dispatch_command.md`
- **Dev History Dir**: `/Users/yzliu/work/Meridian/docs/branch/feat-dispatcher-hub-run-integration-fixes/dev_history/`
- **Related Repo Root**: `/Users/yzliu/work/meridian/Meridian-roles`
- **Related Meridian-roles Reference Docs Branch**: `/Users/yzliu/work/meridian/Meridian-roles/docs/branch/feat:dispatcher-ephemeral-spawn-run-kill/`

## PRD Reference Paths

| Label | Absolute Path |
|---|---|
| Issue Brief | `/Users/yzliu/work/Meridian/docs/branch/feat-dispatcher-hub-run-integration-fixes/integration_issue_brief.md` |
| Meridian Experience Plan | `/Users/yzliu/work/Meridian/docs/branch/feat:experience-fix/dispatch_plan.md` |
| Meridian R-05 Note | `/Users/yzliu/work/Meridian/docs/branch/feat:experience-fix/dev_history/2026-03-19_R-05.md` |
| Meridian Delta Rerun | `/Users/yzliu/work/Meridian/docs/branch/feat:experience-fix/dev_history/2026-03-19_delta-check-rerun.md` |
| Meridian Hub Router | `/Users/yzliu/work/Meridian/src/hub/router.ts` |
| Meridian Config | `/Users/yzliu/work/Meridian/src/config.ts` |
| Meridian Types | `/Users/yzliu/work/Meridian/src/types.ts` |
| Roles PRD v2.2 | `/Users/yzliu/work/meridian/Meridian-roles/docs/branch/feat:dispatcher-ephemeral-spawn-run-kill/meridian-roles-agent-dispatcher-PRD-v2.2.md` |
| Roles Investigation v2.2 | `/Users/yzliu/work/meridian/Meridian-roles/docs/branch/feat:dispatcher-ephemeral-spawn-run-kill/investigation_report_v2.2.md` |
| Roles TaskSpec v1.1 | `/Users/yzliu/work/meridian/Meridian-roles/docs/branch/feat:dispatcher-ephemeral-spawn-run-kill/taskspec_v1_1.md` |
| Roles Dispatch Plan | `/Users/yzliu/work/meridian/Meridian-roles/docs/branch/feat:dispatcher-ephemeral-spawn-run-kill/dispatch_plan.md` |
| Roles Run Tool | `/Users/yzliu/work/meridian/Meridian-roles/src/tool-gateway/tools/run.ts` |
| Roles Prompt Builder | `/Users/yzliu/work/meridian/Meridian-roles/src/roles/agent-dispatcher/prompt-builder.ts` |
| Roles Session Manager | `/Users/yzliu/work/meridian/Meridian-roles/src/roles/agent-dispatcher/session-manager.ts` |
| Roles Role Handlers | `/Users/yzliu/work/meridian/Meridian-roles/src/server/role-handlers.ts` |
| GUI Demo Plan | `/Users/yzliu/work/meridian/Meridian-roles/test/gui-demo/dispatch_plan.md` |
| GUI Demo Command | `/Users/yzliu/work/meridian/Meridian-roles/test/gui-demo/agent_dispatch_command.md` |

## Model Assignment Legend

| Model | Code | Use |
|---|---|---|
| Codex High | `CODEX-HIGH` | Prompt contract work, focused tests, fixture/demo refresh with moderate coordination |
| Codex XHigh | `CODEX-XHIGH` | Hub async/final-reply work, tool-sidecar wiring, integration gates, delta-check, PR review |
| Human Verify | `HUMAN` | Live Meridian + Meridian-roles verification with real providers |

## Master Dispatch Table

| Status | Batch | Worker | Task | Model | Depends On | PRDs to Attach | Notes |
|---|---:|---|---|---|---|---|---|
| ✅ | 0 | PF-00 | Validate paths, env contract, baseline repro coverage, and `--command` payload semantics | CODEX-XHIGH | — | Issue Brief, Meridian Config, Roles PRD v2.2, Roles Run Tool | Baseline must explicitly capture current Meridian-roles unit drift and whether command-file contents reach Hub |
| ✅ | 1 | R-01 | Fix Meridian Hub dispatcher-style final reply and structured in-progress contract | CODEX-XHIGH | PF-00 | Issue Brief, Meridian R-05 Note, Meridian Delta Rerun, Meridian Hub Router, Meridian Types | Focus on `handleRun`, `waitForAgentReply`, fallback policy, and `still_running` / timeout shape |
| ✅ | 1 | R-02 | Wire Meridian-roles worker sidecar lifecycle and attach visibility into production flow | CODEX-XHIGH | PF-00 | Issue Brief, Roles Investigation v2.2, Roles Session Manager, Roles Role Handlers | `dispatch_threads.json` must track active worker ids and GUI/web sessions must be able to attach to the dispatcher thread |
| ⬜ | 2 | R-03 | Rework Meridian-roles dispatcher prompt contract | CODEX-HIGH | R-02 | Issue Brief, Roles PRD v2.2, Roles Prompt Builder, GUI Demo Plan | Add deterministic routing/defaults, terminal exit path, and non-final run handling |
| ⬜ | 2.5 | B1-GATE | Cross-repo contract verification before e2e work | CODEX-XHIGH | R-01, R-02, R-03 | TaskSpec, Issue Brief, Meridian Hub Router, Roles Prompt Builder, Roles Run Tool | No e2e/demo work before this gate is `✅`; payload-content, attachability, and result-state contract must all be proven |
| ⬜ | 3 | R-04 | Add true agent-dispatcher e2e coverage and refresh stale demo/tests | CODEX-HIGH | B1-GATE | Issue Brief, Roles Role Handlers, GUI Demo Plan, GUI Demo Command | Must use `AgentDispatcherRole`, not legacy `DispatcherRole` |
| ⬜ | 4 | V-01 | Live Meridian + Meridian-roles + provider verification | HUMAN | R-04 | TaskSpec, Issue Brief | Human-only; required before merge approval |
| ⬜ | Ω | DELTA-CHECK | Validate full delivery against TaskSpec and source docs | CODEX-XHIGH | R-01, R-02, R-03, R-04, V-01 | TaskSpec, all PRDs | One pass only; append corrective workers only if required |
| ⬜ | Ω+1 | PR-REVIEW | Review final diff against brief, PRDs, and acceptance criteria | CODEX-XHIGH | DELTA-CHECK | TaskSpec, all PRDs | Terminal merge/block gate |

## Batch Execution Details

### Batch 0

- Workers: `PF-00`
- Gate: both repos' paths/env contracts are explicit, the baseline test/repro state is recorded, and the `--command` payload-content baseline is documented

### Batch 1

- Workers: `R-01`, `R-02`
- Gate: Meridian Hub result delivery and structured non-final state, plus Meridian-roles worker-sidecar wiring and attach visibility, are all implemented with targeted regression coverage
- Agent Notes:
  - `R-01` owns Meridian files only
  - `R-02` owns Meridian-roles sidecar/tool/detail files only

### Batch 2

- Workers: `R-03`
- Gate: dispatcher prompt documentation is aligned with the implemented tool surface, terminal behavior, and non-final run handling

### Batch 2.5

- Workers: `B1-GATE`
- Gate: cross-repo run contract, command-file payload delivery, attach visibility, and prompt/tool contract are aligned before e2e/demo work starts

### Batch 3

- Workers: `R-04`
- Gate: there is real end-to-end coverage for `/api/agent-dispatcher/start`, the stale unit expectations are fixed, and the GUI demo is truthful about command handoff and attach-assisted observability

### Batch 4

- Workers: `V-01`
- Gate: live Codex and Gemini verification evidence exists

### Terminal Batches

- `DELTA-CHECK`
- `PR-REVIEW`

## PM Flags Summary

| Flag | Resolution |
|---|---|
| Branch and docs folder must use the same exact name | Use the git-safe string `feat-dispatcher-hub-run-integration-fixes` for both |
| Meridian-roles user reference uses a docs-branch label not matching the local git branch | Record both the docs reference `feat:dispatcher-ephemeral-spawn-run-kill` and the current local implementation branch `feat/fix/agent-dispatcher` |
| Meridian-roles has no checked-in `.env` | Use `.env.example` as variable catalog and inline env overrides where runtime tests need them |
| Meridian is the architecture blocker, but Meridian-roles still has required follow-up work | Put Meridian Hub fix first, then wire Meridian-roles sidecar/prompt/e2e against the verified Hub contract |
| `meridian-tool run --command <path>` semantics were previously unstable in live testing | Make command-file-content delivery to Hub a baseline assertion and a hard Batch 2.5 gate |
| Dispatcher `/detail` from GUI can fail even while the dispatcher is live because the reply-channel session is not attached to the dispatcher thread | Require a supported attach flow before certifying detail/history or demo validation |
| Long-lived providers may legitimately stay non-final past the initial wait window | Require a structured `still_running` or timeout result and matching dispatcher handling rules instead of success text fallback |

## Completion Tracking

| Batch | Started | Ended | Report Path |
|---|---|---|---|
| 0 | | | `/Users/yzliu/work/Meridian/docs/branch/feat-dispatcher-hub-run-integration-fixes/dev_history/PF-00_report.md` |
| 1 | | | `/Users/yzliu/work/Meridian/docs/branch/feat-dispatcher-hub-run-integration-fixes/dev_history/R-01_report.md`, `/Users/yzliu/work/Meridian/docs/branch/feat-dispatcher-hub-run-integration-fixes/dev_history/R-02_report.md` |
| 2 | | | `/Users/yzliu/work/Meridian/docs/branch/feat-dispatcher-hub-run-integration-fixes/dev_history/R-03_report.md` |
| 2.5 | | | `/Users/yzliu/work/Meridian/docs/branch/feat-dispatcher-hub-run-integration-fixes/dev_history/B1-GATE_report.md` |
| 3 | | | `/Users/yzliu/work/Meridian/docs/branch/feat-dispatcher-hub-run-integration-fixes/dev_history/R-04_report.md` |
| 4 | | | `/Users/yzliu/work/Meridian/docs/branch/feat-dispatcher-hub-run-integration-fixes/dev_history/V-01_report.md` |
| Ω | | | `/Users/yzliu/work/Meridian/docs/branch/feat-dispatcher-hub-run-integration-fixes/dev_history/delta_check_report.md` |
| Ω+1 | | | `/Users/yzliu/work/Meridian/docs/branch/feat-dispatcher-hub-run-integration-fixes/dev_history/pr_review_report.md` |
