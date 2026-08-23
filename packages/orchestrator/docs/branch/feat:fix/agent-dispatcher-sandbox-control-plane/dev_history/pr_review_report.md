# PR Review Report: Agent Dispatcher sandbox/control-plane fix

## Inputs Reviewed

- TaskSpec: `/Users/yzliu/work/Meridian/Meridian-roles/docs/branch/feat:fix/agent-dispatcher-sandbox-control-plane/agent-dispatcher-sandbox-control-plane-taskspec.md`
- Dispatch Plan: `/Users/yzliu/work/Meridian/Meridian-roles/docs/branch/feat:fix/agent-dispatcher-sandbox-control-plane/agent-dispatcher-sandbox-control-plane-dispatch_plan.md`
- Issue Doc: `/Users/yzliu/work/Meridian/Meridian-roles/docs/issue-pool/agent-dispatcher-sandbox-and-control-plane.md`
- Dispatcher PRD v2.2: `/Users/yzliu/work/Meridian/Meridian-roles/docs/branch/feat:dispatcher-ephemeral-spawn-run-kill/meridian-roles-agent-dispatcher-PRD-v2.2.md`
- Delta report: `/Users/yzliu/work/Meridian/Meridian-roles/docs/branch/feat:fix/agent-dispatcher-sandbox-control-plane/dev_history/delta_check_report.md`
- Corrective report: `/Users/yzliu/work/Meridian/Meridian-roles/docs/branch/feat:fix/agent-dispatcher-sandbox-control-plane/dev_history/delta/Ω+1-R-04A_report.md`
- HUMAN reports:
  - `/Users/yzliu/work/Meridian/Meridian-roles/docs/branch/feat:fix/agent-dispatcher-sandbox-control-plane/dev_history/R-05_report.md`
  - `/Users/yzliu/work/Meridian/Meridian-roles/docs/branch/feat:fix/agent-dispatcher-sandbox-control-plane/dev_history/V-01_report.md`
- Full branch diff: `0be7c585676c40646d292d9eddeb49343d5fd359..cad4bafaeab2`

## Findings

### 1. BLOCKER — Detached `run` handoff failures can orphan spawned Hub threads while the branch rolls plan/lifecycle state back

- `/Users/yzliu/work/Meridian/Meridian-roles/src/roles/agent-dispatcher/worker-launcher.ts:90` returns `threadId` when `meridian-tool run` fails to start after `spawn` already succeeded, but it does not kill that newly created Hub thread.
- `/Users/yzliu/work/Meridian/Meridian-roles/src/roles/agent-dispatcher/continue-worker.ts:35` snapshots `dispatch_plan.md` and `dispatch_threads.json`, then restores both files on any launch failure at `/Users/yzliu/work/Meridian/Meridian-roles/src/roles/agent-dispatcher/continue-worker.ts:67`. The returned failure drops the spawned `threadId`, so the service cannot clean up the orphaned worker thread it just created.
- The same failure mode exists on dispatcher startup: `/Users/yzliu/work/Meridian/Meridian-roles/src/roles/agent-dispatcher/launcher.ts:118` returns the spawned dispatcher thread id on detached `run` failure, and `/Users/yzliu/work/Meridian/Meridian-roles/src/roles/definitions/agent-dispatcher.ts:109` only performs cleanup if `executeDispatcherHubLaunch()` returns a thread id. When `launchDispatcher()` reports `ok: false`, `onActivate()` never learns that spawned thread id and therefore never kills the orphan.
- Consequence: a local bootstrap failure in the detached `run` handoff can leave a live Hub thread that is no longer represented in `dispatch_threads.json` or the plan, which risks duplicate launches, leaked dispatcher sessions, and reconcile/continue drift that is explicitly in scope for this round.
- Required fix: on detached `run` launch failure, kill the spawned Hub thread before rollback, or propagate the spawned `threadId` through the failure path so the caller can kill it deterministically. Add regression coverage for both dispatcher startup and worker continuation cleanup.

## Per-File Verdicts

| File | Verdict | Notes |
|------|---------|-------|
| `/Users/yzliu/work/Meridian/Meridian-roles/README.md` | PASS | Operator docs match the service-owned continuation model. |
| `/Users/yzliu/work/Meridian/Meridian-roles/docs/branch/feat:fix/agent-dispatcher-sandbox-control-plane/agent-dispatcher-sandbox-control-plane-dispatch_plan.md` | PASS | Dispatch state and corrective row tracking are internally consistent. |
| `/Users/yzliu/work/Meridian/Meridian-roles/docs/branch/feat:fix/agent-dispatcher-sandbox-control-plane/dev_history/PRE-FLIGHT_report.md` | EVIDENCE | Baseline validation recorded. |
| `/Users/yzliu/work/Meridian/Meridian-roles/docs/branch/feat:fix/agent-dispatcher-sandbox-control-plane/dev_history/R-01_report.md` | EVIDENCE | Transport-diagnostics work recorded. |
| `/Users/yzliu/work/Meridian/Meridian-roles/docs/branch/feat:fix/agent-dispatcher-sandbox-control-plane/dev_history/R-02_report.md` | EVIDENCE | Missing-thread demotion and `spawn_dir` hardening recorded. |
| `/Users/yzliu/work/Meridian/Meridian-roles/docs/branch/feat:fix/agent-dispatcher-sandbox-control-plane/dev_history/R-03_report.md` | EVIDENCE | Service-owned continuation migration recorded. |
| `/Users/yzliu/work/Meridian/Meridian-roles/docs/branch/feat:fix/agent-dispatcher-sandbox-control-plane/dev_history/R-04_report.md` | EVIDENCE | Watchdog/service continuation unification recorded. |
| `/Users/yzliu/work/Meridian/Meridian-roles/docs/branch/feat:fix/agent-dispatcher-sandbox-control-plane/dev_history/R-05_report.md` | EVIDENCE | HUMAN Meridian companion evidence present. |
| `/Users/yzliu/work/Meridian/Meridian-roles/docs/branch/feat:fix/agent-dispatcher-sandbox-control-plane/dev_history/R-06_report.md` | EVIDENCE | Full validation/doc sweep recorded. |
| `/Users/yzliu/work/Meridian/Meridian-roles/docs/branch/feat:fix/agent-dispatcher-sandbox-control-plane/dev_history/delta/Ω+1-R-04A_report.md` | EVIDENCE | Corrective watchdog alignment evidence present. |
| `/Users/yzliu/work/Meridian/Meridian-roles/docs/branch/feat:fix/agent-dispatcher-sandbox-control-plane/dev_history/delta_check_report.md` | EVIDENCE | Delta finding was addressed; no objection to the delta process itself. |
| `/Users/yzliu/work/Meridian/Meridian-roles/package.json` | PASS | `test:e2e` scope adjustment is coherent with the validated suite. |
| `/Users/yzliu/work/Meridian/Meridian-roles/src/index.ts` | PASS | Watchdog recovery now routes through the shared continuation helper instead of direct launch. |
| `/Users/yzliu/work/Meridian/Meridian-roles/src/roles/agent-dispatcher/__tests__/prompt-builder.test.ts` | PASS | Prompt contract changes are covered. |
| `/Users/yzliu/work/Meridian/Meridian-roles/src/roles/agent-dispatcher/__tests__/reconciler.test.ts` | PASS | Reconciler coverage still aligns with current lifecycle semantics. |
| `/Users/yzliu/work/Meridian/Meridian-roles/src/roles/agent-dispatcher/__tests__/session-manager.test.ts` | PASS | Session-manager coverage matches the new strict repo-root behavior. |
| `/Users/yzliu/work/Meridian/Meridian-roles/src/roles/agent-dispatcher/__tests__/watchdog.test.ts` | PASS | Shared continuation, rollback, and stalled-worker selection are covered. |
| `/Users/yzliu/work/Meridian/Meridian-roles/src/roles/agent-dispatcher/__tests__/worker-launcher.test.ts` | GAP | Tests accept `run launch failed` with a returned thread id, but do not require orphan-thread cleanup. |
| `/Users/yzliu/work/Meridian/Meridian-roles/src/roles/agent-dispatcher/continue-worker.ts` | BLOCK | Restores plan/lifecycle snapshots after launch failure without cleaning or surfacing a spawned thread id. |
| `/Users/yzliu/work/Meridian/Meridian-roles/src/roles/agent-dispatcher/dispatch-paths.ts` | PASS | Repo-root derivation is consistent with TaskSpec requirements. |
| `/Users/yzliu/work/Meridian/Meridian-roles/src/roles/agent-dispatcher/launcher.ts` | BLOCK | Dispatcher startup has the same spawn-success / detached-run-failure orphan-thread risk. |
| `/Users/yzliu/work/Meridian/Meridian-roles/src/roles/agent-dispatcher/missing-thread.ts` | PASS | Missing-thread classification is appropriately factored. |
| `/Users/yzliu/work/Meridian/Meridian-roles/src/roles/agent-dispatcher/prompt-builder.ts` | PASS | Prompt now makes service-owned continuation authoritative. |
| `/Users/yzliu/work/Meridian/Meridian-roles/src/roles/agent-dispatcher/reconciler.ts` | PASS | Reconciler changes remain bounded and consistent with the new helper split. |
| `/Users/yzliu/work/Meridian/Meridian-roles/src/roles/agent-dispatcher/service-continuation.ts` | PASS | Next-worker selection rules align with the TaskSpec. |
| `/Users/yzliu/work/Meridian/Meridian-roles/src/roles/agent-dispatcher/session-manager.ts` | PASS | Cleanup to sidecar writes is compatible with the reviewed flow. |
| `/Users/yzliu/work/Meridian/Meridian-roles/src/roles/agent-dispatcher/watchdog.ts` | PASS | Stalled-dispatch selection now delegates to shared continuation semantics. |
| `/Users/yzliu/work/Meridian/Meridian-roles/src/roles/agent-dispatcher/worker-launcher.ts` | BLOCK | Returns spawned worker `threadId` on `run` handoff failure but never kills that orphan. |
| `/Users/yzliu/work/Meridian/Meridian-roles/src/roles/definitions/__tests__/agent-dispatcher.test.ts` | PASS | Runtime prompt context and role lifecycle expectations are covered. |
| `/Users/yzliu/work/Meridian/Meridian-roles/src/roles/definitions/agent-dispatcher.ts` | BLOCK | `onActivate()` only cleans up if the launch helper returns success; failed dispatcher handoff leaks the spawned thread. |
| `/Users/yzliu/work/Meridian/Meridian-roles/src/roles/definitions/dispatcher.ts` | PASS | Legacy dispatcher definition changes are doc/test-surface only. |
| `/Users/yzliu/work/Meridian/Meridian-roles/src/server/__tests__/role-config-handlers.test.ts` | PASS | Continue-path rollback and demotion are covered, but not orphan cleanup after detached `run` failure. |
| `/Users/yzliu/work/Meridian/Meridian-roles/src/server/role-handlers.ts` | PASS | Continue API wiring is otherwise consistent with the shared helper contract. |
| `/Users/yzliu/work/Meridian/Meridian-roles/src/tool-gateway/__tests__/file-relay.test.ts` | PASS | Empty-body and timeout diagnostics are covered. |
| `/Users/yzliu/work/Meridian/Meridian-roles/src/tool-gateway/__tests__/ipc-bridge.test.ts` | PASS | Accepted-vs-replied diagnostics are covered. |
| `/Users/yzliu/work/Meridian/Meridian-roles/src/tool-gateway/file-relay.ts` | PASS | Reply-path diagnostics now preserve traceable failure semantics. |
| `/Users/yzliu/work/Meridian/Meridian-roles/src/tool-gateway/ipc-bridge.ts` | PASS | Transport fallback ordering is preserved with improved diagnostics. |
| `/Users/yzliu/work/Meridian/Meridian-roles/src/tool-gateway/loader.ts` | PASS | Tool registration changes are minimal and coherent. |
| `/Users/yzliu/work/Meridian/Meridian-roles/src/tool-gateway/tools/continue-dispatcher.ts` | PASS | Tool API cleanly delegates next-worker selection to the service. |
| `/Users/yzliu/work/Meridian/Meridian-roles/src/tool-gateway/tools/kill.ts` | PASS | Timeout-string normalization remains compatible. |
| `/Users/yzliu/work/Meridian/Meridian-roles/src/tool-gateway/tools/run.ts` | PASS | Run-tool changes are minor and consistent with dispatch reporting. |
| `/Users/yzliu/work/Meridian/Meridian-roles/src/tool-gateway/tools/spawn.ts` | PASS | Transport error normalization still matches the updated gateway semantics. |
| `/Users/yzliu/work/Meridian/Meridian-roles/tests/e2e/scenario-a.ts` | PASS | E2E socket isolation/test scoping update is coherent. |
| `/Users/yzliu/work/Meridian/Meridian-roles/tests/e2e/scenario-b.ts` | PASS | E2E socket isolation/test scoping update is coherent. |
| `/Users/yzliu/work/Meridian/Meridian-roles/tests/e2e/scenario-c.ts` | PASS | E2E socket isolation/test scoping update is coherent. |
| `/Users/yzliu/work/Meridian/Meridian-roles/tests/e2e/scenario-d.ts` | PASS | E2E socket isolation/test scoping update is coherent. |
| `/Users/yzliu/work/Meridian/Meridian-roles/tests/e2e/scenario-e.ts` | PASS | E2E socket isolation/test scoping update is coherent. |
| `/Users/yzliu/work/Meridian/Meridian-roles/tests/e2e/scenario-fileflow.ts` | PASS | E2E socket isolation/test scoping update is coherent. |

## Validation

- `cd /Users/yzliu/work/Meridian/Meridian-roles && export $(grep -v '^#' /Users/yzliu/work/Meridian/Meridian-roles/.env.example | xargs) && export STATE_FILE_PATH=/tmp/meridian-roles-pr-review/state.json && npx vitest run src/roles/agent-dispatcher/__tests__/watchdog.test.ts src/roles/agent-dispatcher/__tests__/worker-launcher.test.ts src/server/__tests__/role-config-handlers.test.ts && npm run build` — PASS

## Final Verdict

MERGE BLOCKED — detached `run` handoff failures can leak spawned dispatcher/worker Hub threads while the branch rolls plan and lifecycle state back to a pre-launch snapshot.
