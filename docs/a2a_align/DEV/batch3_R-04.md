# Completion Report: R-04 — server.ts Hardcode Cleanup + Auto-Approve Intercept
- **Date**: 2026-03-15
- **Model**: OPUS
- **Status**: ✅ Complete

## Sub-tasks Completed
- R-04.1 — Fix 4 hardcoded telegram channel constructions in server.ts: ✅
- R-04.2 — Add auto-approve intercept in flushPushAccumulator(): ✅ (completed in prior session)
- R-04.3 — Add set_auto_approve intent handler in server.ts: ✅ (completed in prior session, lives in router.ts)

## Files Modified
- src/hub/router.ts — Extended `MonitorUpdateSubscription`, `MonitorUpdateDispatch`, `PushSubscription`, `PushDeliveryTarget` interfaces with `replyChannel: ReplyChannel` field; threaded `replyChannel` through `upsertMonitorUpdateSubscription()`, `upsertPushSubscription()`, `collectDueMonitorUpdateDispatches()`, `getPushDeliveryTargets()`; added public `resolveReplyChannelForSession()` method using `attachmentMetaBySession` metadata; updated state rehydration to build default ReplyChannel for persisted push subscriptions
- src/hub/server.ts — Removed `buildReplyChannelFromSession()` method (hardcoded `channel: "telegram"`); updated `deliverMonitorAlert()`, `deliverMonitorCompletionResult()` to use `router.resolveReplyChannelForSession()`; updated `flushMonitorProgressUpdates()` and `flushPushAccumulator()` to use carried `target.replyChannel` / `subscriber.replyChannel` directly; updated `getPushSubscriptionsForThreadSafe()` return type to include `replyChannel`
- src/hub/server.monitor.test.ts — Added `resolveReplyChannelForSession()` to FakeRouter to match new router interface (scope exception: 1 test file update to fix compilation)

## Tests Run
- npm run typecheck: ✅
- npm test: ✅ (197 tests, 0 new failures; 1 pre-existing failure in `public-layout.test.ts` unrelated to R-04)

## Blockers / Notes
- PM-FLAG-01 resolved: Extended subscriber/dispatch types with `replyChannel: ReplyChannel` field. Session metadata from `attachmentMetaBySession` (which already stored `channel`) is used to reconstruct the correct ReplyChannel. Fallback for sessions without metadata defaults to `channel: "telegram"` (backward-compatible).
- Touched `router.ts` (outside strict R-04 scope) because PM-FLAG-01 required extending subscriber types which are defined there. This is a cross-cutting concern explicitly called out in the dispatch plan.
- Touched `server.monitor.test.ts` (test file) to add `resolveReplyChannelForSession()` to FakeRouter stub.
- Pre-existing test failure: `terminal approval actions use dedicated terminal_input API` in `public-layout.test.ts` — `terminal.html` is missing "Allow for all commands" text. Confirmed failing before R-04 changes.
