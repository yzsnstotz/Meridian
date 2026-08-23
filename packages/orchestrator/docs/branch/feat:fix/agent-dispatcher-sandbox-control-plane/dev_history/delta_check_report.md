# Delta Check Report: Agent Dispatcher sandbox/control-plane fix

## Inputs Reviewed

- TaskSpec: `/Users/yzliu/work/Meridian/Meridian-roles/docs/branch/feat:fix/agent-dispatcher-sandbox-control-plane/agent-dispatcher-sandbox-control-plane-taskspec.md`
- Dispatch Plan: `/Users/yzliu/work/Meridian/Meridian-roles/docs/branch/feat:fix/agent-dispatcher-sandbox-control-plane/agent-dispatcher-sandbox-control-plane-dispatch_plan.md`
- Issue Doc: `/Users/yzliu/work/Meridian/Meridian-roles/docs/issue-pool/agent-dispatcher-sandbox-and-control-plane.md`
- Dispatcher PRD v2.2: `/Users/yzliu/work/Meridian/Meridian-roles/docs/branch/feat:dispatcher-ephemeral-spawn-run-kill/meridian-roles-agent-dispatcher-PRD-v2.2.md`
- Completion reports:
  - `/Users/yzliu/work/Meridian/Meridian-roles/docs/branch/feat:fix/agent-dispatcher-sandbox-control-plane/dev_history/PRE-FLIGHT_report.md`
  - `/Users/yzliu/work/Meridian/Meridian-roles/docs/branch/feat:fix/agent-dispatcher-sandbox-control-plane/dev_history/R-01_report.md`
  - `/Users/yzliu/work/Meridian/Meridian-roles/docs/branch/feat:fix/agent-dispatcher-sandbox-control-plane/dev_history/R-02_report.md`
  - `/Users/yzliu/work/Meridian/Meridian-roles/docs/branch/feat:fix/agent-dispatcher-sandbox-control-plane/dev_history/R-03_report.md`
  - `/Users/yzliu/work/Meridian/Meridian-roles/docs/branch/feat:fix/agent-dispatcher-sandbox-control-plane/dev_history/R-04_report.md`
  - `/Users/yzliu/work/Meridian/Meridian-roles/docs/branch/feat:fix/agent-dispatcher-sandbox-control-plane/dev_history/R-05_report.md`
  - `/Users/yzliu/work/Meridian/Meridian-roles/docs/branch/feat:fix/agent-dispatcher-sandbox-control-plane/dev_history/R-06_report.md`
  - `/Users/yzliu/work/Meridian/Meridian-roles/docs/branch/feat:fix/agent-dispatcher-sandbox-control-plane/dev_history/V-01_report.md`
- Full branch diff reviewed from `0be7c58..HEAD`, plus targeted code inspection in:
  - `/Users/yzliu/work/Meridian/Meridian-roles/src/index.ts`
  - `/Users/yzliu/work/Meridian/Meridian-roles/src/server/role-handlers.ts`
  - `/Users/yzliu/work/Meridian/Meridian-roles/src/roles/agent-dispatcher/service-continuation.ts`
  - `/Users/yzliu/work/Meridian/Meridian-roles/src/roles/agent-dispatcher/watchdog.ts`
  - `/Users/yzliu/work/Meridian/Meridian-roles/src/roles/agent-dispatcher/worker-launcher.ts`
  - `/Users/yzliu/work/Meridian/Meridian-roles/src/tool-gateway/ipc-bridge.ts`
  - `/Users/yzliu/work/Meridian/Meridian-roles/src/tool-gateway/file-relay.ts`

## Worker Verdicts

| Worker | Verdict | Notes |
|--------|---------|-------|
| PRE-FLIGHT | PASS | Baseline branch, workspace, repo access, and initial validation were completed and documented. |
| R-01 | PASS | Transport diagnostics now preserve `trace_id`, transport, and reply-path context for accepted-without-reply failures. |
| R-02 | PASS | Missing-thread demotion and service-owned `spawn_dir` enforcement landed with targeted tests. |
| R-03 | PASS | Dispatcher prompt no longer owns primary worker launch transport; service continuation path exists and is test-covered. |
| R-04 | CORRECTIVE REQUIRED | Watchdog still bypasses the shared reset/retry step for resumable rows in one recovery path; see finding below. |
| R-05 | PASS (HUMAN) | Companion report includes branch, commit, changed files, and passing Meridian validation. |
| R-06 | PASS | Full `build` / `test` / `test:e2e` / `lint` sweep and operator docs update were recorded. |
| V-01 | PASS WITH CAVEAT (HUMAN) | Hard gate is present with evidence and verdicts for every checklist row. The I-02 / I-03 / I-05 verification is explicitly partial, but it does not by itself prove code drift inside Meridian-roles. |

## Issue Family Verdicts

| Issue Family | Verdict | Basis |
|--------------|---------|-------|
| I-01 / I-10 launch acknowledgment semantics | PASS | `ipc-bridge` and `file-relay` now distinguish request delivery from reply-path failure and preserve `trace_id`. |
| I-04 stale dispatcher demotion | PASS | Detail/continue paths demote stale dispatcher lifecycle state on missing-thread evidence, with tests and live verification evidence. |
| I-06 service-owned `spawn_dir` enforcement | PASS | Launch helpers resolve repo root from dispatch artifacts instead of ambient `cwd`. |
| I-07 end-to-end `trace_id` observability | PASS (HUMAN) | Companion Meridian report and V-01 evidence cover the missing spawn/register/ready observability hop. |
| I-02 / I-03 / I-05 control-plane unification | CORRECTIVE REQUIRED | Main dispatcher flow and explicit service continue are aligned, but watchdog recovery still uses a narrower launch path that skips shared reset/retry semantics for resumable rows. |

## Finding Requiring Ω+1 Corrective Work

- **Finding**: watchdog recovery does not fully share the same continuation contract as the service `continue` handler.
  - Evidence in `/Users/yzliu/work/Meridian/Meridian-roles/src/index.ts:593`: `tryContinueDispatchWorker()` reads the selected worker row and immediately calls `launchDispatchWorker(...)`.
  - Evidence in `/Users/yzliu/work/Meridian/Meridian-roles/src/server/role-handlers.ts:620`: `continueDispatcherForRole()` first runs `executeResumeWorkerAction({ action: "retry" })` for resumable `⚠️ ABANDONED`, `❌`, and stale `🔄` rows before launching.
  - Consequence: when watchdog selects a resumable worker, it can relaunch without first normalizing plan/lifecycle state through the shared retry/reset path. That violates the `R-04` acceptance target that watchdog, continue, and rehydration share the same bounded continuation contract.
  - Required fix shape: route watchdog recovery through the shared continue/reset semantics or extract a common helper used by both code paths, then add regression coverage for `⚠️ ABANDONED` and `❌` selections.

## Corrective Dispatch Appended

| Worker | Status | Depends On | Scope |
|--------|--------|------------|-------|
| Ω+1-R-04A | ⬜ | DELTA-CHECK | Align watchdog recovery with shared continue/reset semantics and add regression tests for resumable rows. |

## Hard Gates

- `R-05`: satisfied by HUMAN completion report; not auto-passed by DELTA-CHECK.
- `V-01`: satisfied by HUMAN completion report with explicit evidence and caveat; not auto-passed by DELTA-CHECK.

## Final Delta Verdict

- Delta review is **not clean**.
- Corrective worker `Ω+1-R-04A` is required before `PR-REVIEW`.
