# DELTA-CHECK Report

- Worker: `DELTA-CHECK`
- Model: `CODEX`
- Date: `2026-03-25`
- Status: `✅ COMPLETE`
- Scope: Validate F-01 through F-06 plus `DISC-01` against `main..HEAD`, then append any required corrective dispatch rows

## Files Changed

- `/Users/yzliu/work/Meridian/docs/branch/feat:experience-fix/v1.0/dev_history/delta_check_report.md`
  - Recorded the DELTA-CHECK findings and verification evidence
- `/Users/yzliu/work/Meridian/docs/branch/feat:experience-fix/v1.0/investigation_report_v1.0_dispatch_plan.md`
  - Marked `DELTA-CHECK` complete and appended corrective worker `R-06`

## Delta Table

| Worker | Status | Findings | Action Required |
|--------|--------|----------|-----------------|
| PRE-FLIGHT | `✅ Aligned` | Referenced artifacts, env contract, and baseline verification were recorded, and the current HEAD still passes the required typecheck and targeted suites. | None |
| R-01 | `✅ Aligned` | Canonical history keeps approval prompts durable and the compatibility path preserves `approval -> terminal_input -> final_reply` ordering for migrated state. | None |
| R-02 | `⚠️ Drift` | Structured `/api/progress/:threadId` snapshots are implemented, but [`src/hub/server.ts`](/Users/yzliu/work/Meridian/src/hub/server.ts) removed `monitor_manual_update` from `IMMEDIATE_INTENTS`. A DELTA-CHECK queue probe timed out after 254 ms with `monitor_manual_update was blocked by run`, so F-03 durable liveness is not actually available while a run is active. | Corrective worker `R-06`: restore non-blocking `monitor_manual_update` handling during active runs and verify the web progress endpoint stays responsive. |
| R-03 | `✅ Aligned` | [`src/web/public/terminal.html`](/Users/yzliu/work/Meridian/src/web/public/terminal.html) keeps server history authoritative, suppresses replay while keyed progress is active, and resolves pending progress to one final bubble. | None |
| R-04 | `⚠️ Drift` | Behavioral coverage improved in [`src/web/public-layout.test.ts`](/Users/yzliu/work/Meridian/src/web/public-layout.test.ts), but [`src/hub/server.priority-queue.test.ts`](/Users/yzliu/work/Meridian/src/hub/server.priority-queue.test.ts) deleted the queue-level `monitor_manual_update` bypass regression. `DISC-01` remains partially uncovered because the liveness path can regress below the client layer without failing the current suite. | `R-06` must reinstate queue-level regression coverage for active-run manual progress updates. |
| R-05 | `✅ Aligned` | [`R-05_report.md`](/Users/yzliu/work/Meridian/docs/branch/feat:experience-fix/v1.0/dev_history/R-05_report.md) contains served-DOM/runtime evidence for F-04, F-05, and F-06, and the HTTP-served `terminal.html` verifies the required labels and tab semantics. | None |

## Commands Run

```text
git diff --stat main..HEAD
git diff --name-only main..HEAD
git diff --unified=40 main..HEAD -- src/hub/state-store.ts src/hub/router.ts src/web/server.ts src/web/public/terminal.html src/web/public-layout.test.ts src/web/server.test.ts src/hub/router.test.ts src/hub/state-store.test.ts src/types.ts src/types.test.ts
git diff --unified=40 main..HEAD -- .env.example src/hub/server.priority-queue.test.ts src/hub/server.ts src/shared/agent-output.ts src/shared/agent-output.test.ts
npx tsc --noEmit
node --test --import tsx /Users/yzliu/work/Meridian/src/web/public-layout.test.ts
node --test --import tsx /Users/yzliu/work/Meridian/src/web/server.test.ts
node --test --import tsx /Users/yzliu/work/Meridian/src/hub/router.test.ts
node --test --import tsx /Users/yzliu/work/Meridian/src/hub/server.monitor.test.ts
node --import tsx --input-type=module -e '<HubServer queue probe for monitor_manual_update during an in-flight run>'
```

## Command Results

- `git diff` review: `COMPLETE`
- `npx tsc --noEmit`: `PASS`
- `node --test --import tsx /Users/yzliu/work/Meridian/src/web/public-layout.test.ts`: `PASS`
  - Summary: `23 passed, 0 failed, 0 cancelled`
- `node --test --import tsx /Users/yzliu/work/Meridian/src/web/server.test.ts`: `PASS`
  - Summary: runtime checks for served `terminal.html` remained green during DELTA-CHECK
- `node --test --import tsx /Users/yzliu/work/Meridian/src/hub/router.test.ts`: `PASS`
  - Summary: `45 passed, 0 failed, 0 cancelled`
- `node --test --import tsx /Users/yzliu/work/Meridian/src/hub/server.monitor.test.ts`: `PASS`
  - Summary: `10 passed, 0 failed, 0 cancelled`
- `node --import tsx --input-type=module -e '<HubServer queue probe for monitor_manual_update during an in-flight run>'`: `FAIL`
  - Evidence: `{"outcome":"monitor_manual_update was blocked by run","elapsedMs":254}`
  - Interpretation: F-03 is still incomplete at the hub queue boundary even though the structured progress payload itself is implemented

## Blockers and Caveats

- `PR-REVIEW` is blocked on corrective worker `R-06`
- No PM decision row was required; the drift is an auto-correctable implementation/test issue
- No push was performed because `Ω+1` is now open and not all post-delta work is `✅`
