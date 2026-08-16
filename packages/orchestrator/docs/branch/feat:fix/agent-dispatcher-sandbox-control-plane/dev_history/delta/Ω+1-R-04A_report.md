# Completion Report: Ω+1-R-04A — Align watchdog recovery with shared continue/reset semantics

## Summary
- Added a shared service continuation helper so watchdog recovery and `POST /continue` both use the same retry/reset-plus-launch contract.
- Routed watchdog direct-continue and role-handler continue through that helper, including dispatch file rollback on launch/bootstrap failure.
- Added regression coverage for resumable `⚠️ ABANDONED` and `❌` rows in the shared continuation path; existing role-handler coverage still exercises stale `🔄` retry flow.

## Files Changed
- /Users/yzliu/work/Meridian/Meridian-roles/src/roles/agent-dispatcher/continue-worker.ts
- /Users/yzliu/work/Meridian/Meridian-roles/src/index.ts
- /Users/yzliu/work/Meridian/Meridian-roles/src/server/role-handlers.ts
- /Users/yzliu/work/Meridian/Meridian-roles/src/roles/agent-dispatcher/__tests__/watchdog.test.ts
- /Users/yzliu/work/Meridian/Meridian-roles/docs/branch/feat:fix/agent-dispatcher-sandbox-control-plane/agent-dispatcher-sandbox-control-plane-dispatch_plan.md

## Validation
- `cd /Users/yzliu/work/Meridian/Meridian-roles && export $(grep -v '^#' /Users/yzliu/work/Meridian/Meridian-roles/.env.example | xargs) && export STATE_FILE_PATH=/tmp/meridian-roles-r04/state.json && npx vitest run src/roles/agent-dispatcher/__tests__/watchdog.test.ts src/roles/agent-dispatcher/__tests__/reconciler.test.ts src/server/__tests__/role-config-handlers.test.ts src/roles/definitions/__tests__/agent-dispatcher.test.ts` — PASS
- `cd /Users/yzliu/work/Meridian/Meridian-roles && export $(grep -v '^#' /Users/yzliu/work/Meridian/Meridian-roles/.env.example | xargs) && export STATE_FILE_PATH=/tmp/meridian-roles-r04/state.json && npm run build` — PASS

## Deviations from TaskSpec
- None

## Follow-ups
- None
