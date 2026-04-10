# Completion Report: R-02 — Stale dispatcher demotion and service-owned `spawn_dir` hardening

## Summary
- Demoted stale dispatcher lifecycle state immediately when detail/continue attach paths return definitive missing-thread evidence, so dead dispatcher threads no longer remain visible as running.
- Added a shared missing-thread detector reused by reconciliation and handler paths.
- Hardened service-owned dispatcher/worker launchers to require a repo root derived from dispatch artifacts instead of falling back to ambient `process.cwd()`.
- Added regression tests for detail-path demotion, continue-path demotion, dispatcher thread view hiding, and strict launch root resolution.

## Files Changed
- /Users/yzliu/work/Meridian/Meridian-roles/src/server/role-handlers.ts
- /Users/yzliu/work/Meridian/Meridian-roles/src/server/__tests__/role-config-handlers.test.ts
- /Users/yzliu/work/Meridian/Meridian-roles/src/roles/agent-dispatcher/missing-thread.ts
- /Users/yzliu/work/Meridian/Meridian-roles/src/roles/agent-dispatcher/reconciler.ts
- /Users/yzliu/work/Meridian/Meridian-roles/src/roles/agent-dispatcher/dispatch-paths.ts
- /Users/yzliu/work/Meridian/Meridian-roles/src/roles/agent-dispatcher/worker-launcher.ts
- /Users/yzliu/work/Meridian/Meridian-roles/src/roles/agent-dispatcher/launcher.ts
- /Users/yzliu/work/Meridian/Meridian-roles/src/roles/agent-dispatcher/__tests__/worker-launcher.test.ts
- /Users/yzliu/work/Meridian/Meridian-roles/src/roles/agent-dispatcher/__tests__/session-manager.test.ts

## Validation
- `cd /Users/yzliu/work/Meridian/Meridian-roles && export $(grep -v '^#' .env.example | xargs) && export STATE_FILE_PATH=/tmp/meridian-roles-r02/state.json && npx vitest run src/server/__tests__/role-config-handlers.test.ts src/roles/agent-dispatcher/__tests__/session-manager.test.ts src/roles/agent-dispatcher/__tests__/worker-launcher.test.ts`
- `PASS`
- `cd /Users/yzliu/work/Meridian/Meridian-roles && export $(grep -v '^#' .env.example | xargs) && export STATE_FILE_PATH=/tmp/meridian-roles-r02/state.json && npm run build`
- `PASS`

## Deviations from TaskSpec
- `None`

## Follow-ups
- Audit results for `/Users/yzliu/work/Meridian/Meridian-roles/src/index.ts`: no code change required because the watchdog already consumes `launchDispatchWorker()` and now inherits the strict repo-root enforcement via the shared launch helper.
