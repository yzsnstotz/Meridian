# R-06 Report

- Worker: `R-06`
- Model: `CODEX`
- Date: `2026-03-25`
- Status: `✅ COMPLETE`

## Scope

- Restore non-blocking `monitor_manual_update` handling while a run is already in flight
- Reinstate queue-level regression coverage so F-03 liveness can fail below the web client layer
- Re-verify that the web progress path still works with the corrected hub queue behavior

## Files Changed

- `/Users/yzliu/work/Meridian/src/hub/server.ts`
  - Restored `monitor_manual_update` to the immediate-intent bypass set so manual progress probes do not wait behind active `run` work
- `/Users/yzliu/work/Meridian/src/hub/server.priority-queue.test.ts`
  - Reinstated queue-level coverage proving `monitor_manual_update` resolves immediately while a `run` remains blocked
- `/Users/yzliu/work/Meridian/docs/branch/feat:experience-fix/v1.0/investigation_report_v1.0_dispatch_plan.md`
  - Claimed `R-06` with `🔄` and marked it `✅` after verification
- `/Users/yzliu/work/Meridian/docs/branch/feat:experience-fix/v1.0/dev_history/delta/R-06_report.md`
  - Recorded corrective-worker evidence for the delta round

## Files Not Changed

- `/Users/yzliu/work/Meridian/src/web/server.ts`
  - Left unchanged because `/api/progress/:threadId` already proxies `monitor_manual_update`; the drift was in the hub queue bypass, not the web endpoint contract
- `/Users/yzliu/work/Meridian/src/web/server.test.ts`
  - Left unchanged because it already covers the authenticated `/api/progress/:threadId` intent/shape contract, which remained green after the hub fix

## Commands Run

```text
npx tsc --noEmit
node --test --import tsx /Users/yzliu/work/Meridian/src/hub/server.priority-queue.test.ts
node --test --import tsx /Users/yzliu/work/Meridian/src/web/server.test.ts
node --test --import tsx /Users/yzliu/work/Meridian/src/hub/server.monitor.test.ts
node --import tsx --input-type=module -e 'import { randomUUID } from "node:crypto"; const mod = await import("./src/hub/server.ts"); const HubServer = mod.default.HubServer; let releaseRun = () => {}; const runBlocked = new Promise((resolve) => { releaseRun = resolve; }); const fakeRouter = { async initialize() {}, async route(message) { if (message.intent === "run") { await runBlocked; } return { trace_id: message.trace_id, thread_id: message.thread_id, source: "codex", status: "success", content: message.intent, attachments: [], timestamp: new Date().toISOString() }; }, setInstanceStatus() {}, getAttachedSessionsForThread() { return []; }, getMonitorUpdateSubscribersForThread() { return []; }, resolveSourceForThread() { return "codex"; }, collectDueMonitorUpdateDispatches() { return []; }, isThreadRunning() { return false; }, forceMonitorUpdateDispatchNow() {}, resolveInstanceForThread() { return null; }, registerServiceEndpoint() {} }; const server = new HubServer({ router: fakeRouter, resultSender: { async sendResult() {} }, staticServiceEndpoints: [] }); const accessor = server; const runPromise = accessor["enqueueMessage"](JSON.stringify({ trace_id: randomUUID(), thread_id: "codex_01", actor_id: "tg:123", intent: "run", target: "codex_01", payload: { content: "hello", attachments: [] }, mode: "bridge", reply_channel: { channel: "telegram", chat_id: "telegram:999" }, suppress_reply: true })); await new Promise((resolve) => setTimeout(resolve, 0)); const startedAt = Date.now(); const outcome = await Promise.race([accessor["enqueueMessage"](JSON.stringify({ trace_id: randomUUID(), thread_id: "codex_01", actor_id: "tg:123", intent: "monitor_manual_update", target: "codex_01", payload: { content: "", attachments: [] }, mode: "bridge", reply_channel: { channel: "telegram", chat_id: "telegram:999" }, suppress_reply: true })).then((result) => ({ outcome: result?.content ?? null, elapsedMs: Date.now() - startedAt })), new Promise((resolve) => setTimeout(() => resolve({ outcome: "monitor_manual_update was blocked by run", elapsedMs: Date.now() - startedAt }), 250))]); releaseRun(); await runPromise; console.log(JSON.stringify(outcome));'
```

## Command Results

- `npx tsc --noEmit`: `PASS`
- `node --test --import tsx /Users/yzliu/work/Meridian/src/hub/server.priority-queue.test.ts`: `PASS`
  - Summary: `6 passed, 0 failed, 0 cancelled`
  - New evidence: `monitor_manual_update bypasses the global queue while a run is still in flight`
- `node --test --import tsx /Users/yzliu/work/Meridian/src/web/server.test.ts`: `PASS`
  - Summary: `16 passed, 0 failed, 0 cancelled`
  - Coverage retained: `/api/progress/:threadId` still issues `monitor_manual_update` and returns structured snapshots
- `node --test --import tsx /Users/yzliu/work/Meridian/src/hub/server.monitor.test.ts`: `PASS`
  - Summary: `10 passed, 0 failed, 0 cancelled`
- `node --import tsx --input-type=module -e ...`: `PASS`
  - Probe evidence: `{"outcome":"monitor_manual_update","elapsedMs":1}`
  - Interpretation: the active-run manual progress probe no longer blocks behind `run`, so the web progress endpoint can receive a fresh snapshot immediately during long-running work

## Blockers and Caveats

- No functional blocker for `R-06`
- The current v1.0 TaskSpec does not include a dedicated `R-06` section; the corrective scope was therefore taken from the appended dispatch row plus the DELTA-CHECK findings for `R-02` and `R-04`
