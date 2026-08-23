# Completion Report: Ω+2-R-03A — Clean up orphaned Hub threads on detached run handoff failure

## Summary
- Updated service-owned worker continuation to kill a newly spawned Hub thread before restoring `dispatch_plan.md` and `dispatch_threads.json` when detached `meridian-tool run` bootstrap fails after a successful `spawn`.
- Updated agent-dispatcher startup to kill a newly spawned dispatcher Hub thread before surfacing a detached `run` handoff failure.
- Added regression coverage for both the worker-continue API path and agent-dispatcher activation cleanup path.

## Files Changed
- /Users/yzliu/work/Meridian/Meridian-roles/src/roles/agent-dispatcher/continue-worker.ts
- /Users/yzliu/work/Meridian/Meridian-roles/src/roles/definitions/agent-dispatcher.ts
- /Users/yzliu/work/Meridian/Meridian-roles/src/server/__tests__/role-config-handlers.test.ts
- /Users/yzliu/work/Meridian/Meridian-roles/src/roles/definitions/__tests__/agent-dispatcher.test.ts

## Validation
- `cd /Users/yzliu/work/Meridian/Meridian-roles && export $(grep -v '^#' .env.example | xargs) && export STATE_FILE_PATH=/tmp/meridian-roles-r03a/state.json && npx vitest run src/server/__tests__/role-config-handlers.test.ts src/roles/definitions/__tests__/agent-dispatcher.test.ts src/roles/agent-dispatcher/__tests__/launcher.test.ts src/roles/agent-dispatcher/__tests__/worker-launcher.test.ts` — PASS
- `cd /Users/yzliu/work/Meridian/Meridian-roles && export $(grep -v '^#' .env.example | xargs) && export STATE_FILE_PATH=/tmp/meridian-roles-r03a/state.json && npm run build` — PASS

## Deviations from TaskSpec
- None

## Follow-ups
- None
