# Completion Report: D-01 — Dead Code Sweep + Test Updates
- **Date**: 2026-03-15
- **Model**: OPUS
- **Status**: ✅ Complete

## Sub-tasks Completed
- D-01.1 — Remove TelegramChannelAdapterBridge scaffolding: ✅
- D-01.2 — Update unit tests for new interface contracts: ✅
- D-01.3 — Full typecheck and lint pass: ✅
- D-01.4 — Run integration tests: ✅

## Files Modified
- src/hub/result-sender.ts — Removed `TelegramChannelAdapterBridge` re-export alias (scaffolding from R-02.2)
- src/hub/result-sender.test.ts — Replaced all `TelegramChannelAdapterBridge` references with `TelegramChannelAdapter`
- src/hub/registry.test.ts — Added tests for `setAutoApprove()` method (update + unknown thread)
- src/hub/socket-adapter.test.ts — NEW: Added tests for `SocketChannelAdapter` (canHandle routing, missing socket_path error)
- src/interface/adapters/telegram-adapter.ts — Removed unused `HubResultSchema` import
- src/hub/instance-manager.ts — Removed unused `CAPTURE_DEDUP_TAIL_SIZE` constant
- src/hub/instance-manager.test.ts — Fixed unused parameter lint errors in spawnFn callback
- src/hub/pane-log.ts — Replaced unused `catch (err)` with bare `catch`
- src/hub/router.test.ts — Removed unused `callCount` variable in stale-snapshot test
- src/interface/index.test.ts — Fixed unused parameter lint error in warn() mock
- src/shared/model-catalog.ts — Removed unused `OpenAiModelRecord`, `AnthropicModelRecord`, `GeminiModelRecord` interfaces
- src/web/public-layout.test.ts — Fixed stale assertion: "Allow for all commands" → "Allow for this session" to match current terminal.html
- tests/integration/helpers/hub-server.ts — Added eslint-disable for interface-required unused params
- tests/integration/int-03-detach-attach.test.ts — Removed unused `path` import
- docs/a2a_align/DEV/TaskSpec/meridian_dispatch_plan_v1_0_upgrade.md — Marked D-01 as ✅

## Tests Run
- npm run typecheck: ✅
- npm run lint: ✅ (0 errors, 0 warnings)
- npm test: ✅ (214 tests, 0 failures)
- npm run test:integration: ✅ (4 tests, 0 failures)

## Blockers / Notes
- The `TelegramChannelAdapterBridge` was already replaced by N-02 with a re-export alias in result-sender.ts. D-01.1 simply removed this alias and updated test imports.
- 13 pre-existing lint errors (all `@typescript-eslint/no-unused-vars`) were fixed across 8 files. None were introduced by the v1.0 upgrade work — they accumulated across previous batches.
- The `public-layout.test.ts` failure was a stale assertion checking for "Allow for all commands" text that no longer exists in terminal.html (approval options were changed to "Allow once" / "Allow for this session" / "No, suggest changes").
