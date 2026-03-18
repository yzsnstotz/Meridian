# Completion Report: R-06 — instance-manager.ts spawn autoApprove + CLI flags wiring
- **Date**: 2026-03-15
- **Model**: CODEX
- **Status**: ✅ Complete

## Sub-tasks Completed
- R-06.1 — Add autoApprove parameter to spawn() and spawnWithRetry(): ✅
- R-06.2 — Pass autoApprove through hub spawn handler: ✅

## Files Modified
- src/hub/instance-manager.ts — added `autoApprove` threading through spawn lifecycle and preserved it across restart/model switch respawns
- src/types.ts — extended `HubPayloadSchema` with optional `auto_approve`
- src/hub/router.ts — forwarded `payload.auto_approve` through the actual spawn handler used by the current codebase
- src/hub/instance-manager.test.ts — added registry persistence coverage for auto-approve on spawn
- src/types.test.ts — added schema coverage for `payload.auto_approve`
- src/hub/router.test.ts — added spawn-path coverage for forwarding `auto_approve`
- docs/a2a_align/DEV/TaskSpec/meridian_dispatch_plan_v1_0_upgrade.md — updated worker status

## Tests Run
- npm run typecheck: ✅
- node --test --import tsx src/types.test.ts: ✅ (9 tests, 0 failures)
- node --test --test-name-pattern='spawn stores auto_approve in the registry when requested' --import tsx src/hub/instance-manager.test.ts: ✅ (1 test, 0 failures)
- node --test --test-name-pattern='HubRouter forwards auto_approve on spawn' --import tsx src/hub/router.test.ts: ✅ (1 test, 0 failures)
- node --test --test-name-pattern='HubMessageSchema parses optional auto_approve payload field' --import tsx src/types.test.ts: ✅ (1 test, 0 failures)

## Blockers / Notes
- The TaskSpec names `server.ts` as the spawn intent handler location, but in the current implementation spawn routing lives in `src/hub/router.ts`; the payload threading was applied there as the minimal correct implementation point.
- The local Node runtime is `v24.13.1`, while `package.json` declares `^22.0.0`; existing project checks still passed under the current runtime.
