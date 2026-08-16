# Completion Report: R-04 — Watchdog and recovery control-plane unification

## Summary
- Replaced the watchdog's sole-eligible-only recovery behavior with the shared service continuation selector so stalled recovery now chooses the next recoverable non-human worker through the same control-plane contract used elsewhere.
- Added watchdog stall metadata for the selected continuation worker and kept dispatcher relaunch/reactivation as bounded fallback when service-owned continuation cannot safely advance.
- Extended watchdog coverage for stale running rows, appended corrective rows, and multi-worker eligibility ordering.

## Files Changed
- /Users/yzliu/work/Meridian/Meridian-roles/src/index.ts
- /Users/yzliu/work/Meridian/Meridian-roles/src/roles/agent-dispatcher/service-continuation.ts
- /Users/yzliu/work/Meridian/Meridian-roles/src/roles/agent-dispatcher/watchdog.ts
- /Users/yzliu/work/Meridian/Meridian-roles/src/roles/agent-dispatcher/__tests__/watchdog.test.ts
- /Users/yzliu/work/Meridian/Meridian-roles/docs/branch/feat:fix/agent-dispatcher-sandbox-control-plane/agent-dispatcher-sandbox-control-plane-dispatch_plan.md

## Validation
- `cd /Users/yzliu/work/Meridian/Meridian-roles && export $(grep -v '^#' /Users/yzliu/work/Meridian/Meridian-roles/.env.example | xargs) && export STATE_FILE_PATH=/tmp/meridian-roles-r04/state.json && npx vitest run src/roles/agent-dispatcher/__tests__/watchdog.test.ts src/roles/agent-dispatcher/__tests__/reconciler.test.ts src/server/__tests__/role-config-handlers.test.ts src/roles/definitions/__tests__/agent-dispatcher.test.ts` — PASS
- `cd /Users/yzliu/work/Meridian/Meridian-roles && export $(grep -v '^#' /Users/yzliu/work/Meridian/Meridian-roles/.env.example | xargs) && export STATE_FILE_PATH=/tmp/meridian-roles-r04/state.json && npm run build` — PASS

## Deviations from TaskSpec
- None

## Follow-ups
- Optional: once `R-05` and `R-06` land, confirm the same recovery path in a live stalled-dispatch scenario during `V-01`.
