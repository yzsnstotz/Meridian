# R-01 Report

- Worker: `R-01`
- Model: `CODEX-XHIGH`
- Branch: `feat-dispatcher-hub-run-integration-fixes`
- Status: `✅ Complete`

## Scope

- Reworked Meridian Hub `intent:run` completion handling so delayed dispatcher-style same-trace replies can win over the old early placeholder fallback.
- Replaced ambiguous success-placeholder outcomes with structured non-final run results for approval / still-running / timeout cases.
- Added regression coverage for delayed same-trace summaries, structured pending results, and stale pre-run snapshot protection.

## Files Changed

- `/Users/yzliu/work/Meridian/src/hub/router.ts`
- `/Users/yzliu/work/Meridian/src/hub/router.test.ts`
- `/Users/yzliu/work/Meridian/src/types.ts`
- `/Users/yzliu/work/Meridian/src/types.test.ts`
- `/Users/yzliu/work/Meridian/docs/branch/feat-dispatcher-hub-run-integration-fixes/dispatch_plan.md`

## Implementation Notes

- Added optional Hub result metadata `run_state` with values `completed`, `still_running`, and `timeout`.
- `handleRun()` now returns:
  - `status: "success"` with `run_state: "completed"` for final replies
  - `status: "partial"` with `run_state: "still_running"` or `run_state: "timeout"` for non-final runs
- The pending-result path now produces structured progress snapshots and no longer surfaces the literal fallback text `"Agent is processing..."`.
- `waitForAgentReply()` now keeps polling when the thread still appears active, instead of bailing out early just because the latest visible snapshot is unchanged from before the run.

## Commands Run

1. `node --test --import tsx /Users/yzliu/work/Meridian/src/hub/router.test.ts`
   Result: `FAIL`
   Note: one pre-existing assertion still expected the old `success` contract for the `getMessages()`-throw path.
2. `node --test --import tsx /Users/yzliu/work/Meridian/src/hub/router.test.ts`
   Result: `PASS`
3. `node --test --import tsx /Users/yzliu/work/Meridian/src/hub/router.test.ts`
   Result: `PASS`
4. `node --test --import tsx /Users/yzliu/work/Meridian/src/hub/instance-manager.test.ts`
   Result: `PASS`
5. `node --test --import tsx /Users/yzliu/work/Meridian/src/hub/result-sender.test.ts`
   Result: `PASS`
6. `node --test --import tsx /Users/yzliu/work/Meridian/src/types.test.ts`
   Result: `PASS`

## Behavioral Assertions

- Delayed same-trace final replies now return completed content instead of collapsing to the old placeholder fallback.
- Stale pre-run snapshots remain excluded from the current run result path.
- Approval / non-final run states now return structured `partial` results with `run_state` and `progress` metadata.
- Timeout / no-final-reply paths now return structured non-final results instead of `success` with `"Agent is processing..."`.
- Existing Gemini transient-frame coverage still passes in `router.test.ts`.

## Required Round Notes

- `--command` payload-content semantics verified directly by this worker: `No`
  - This worker did not touch or re-verify `/Users/yzliu/work/meridian/Meridian-roles/src/tool-gateway/tools/run.ts`; it relied on the completed `PF-00` baseline for that contract.
- GUI/detail attach evidence required by this worker: `No`
  - `R-01` was completed through Meridian Hub unit coverage only; no GUI/detail attach flow was executed in this worker.
