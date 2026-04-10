# Completion Report: R-03 — Service-owned autonomous launch migration

## Summary
- Moved next-worker continuation selection into a shared service helper so agent-dispatcher continue flows choose the next eligible row in service code instead of prompt-local `spawn` / `run`.
- Added a `continue-dispatcher` Meridian tool command that lets the dispatcher prompt ask Meridian-roles service to launch the next worker without owning transport/bootstrap logic itself.
- Reduced the dispatcher prompt to bounded control work and rewired the runtime prompt context to include the dispatcher role id for service-owned continuation calls.
- Added regression coverage proving continue now selects the first eligible pending worker through the service path and updated prompt/runtime tests for the new control contract.

## Files Changed
- /Users/yzliu/work/Meridian/Meridian-roles/src/roles/agent-dispatcher/prompt-builder.ts
- /Users/yzliu/work/Meridian/Meridian-roles/src/roles/agent-dispatcher/service-continuation.ts
- /Users/yzliu/work/Meridian/Meridian-roles/src/roles/agent-dispatcher/__tests__/prompt-builder.test.ts
- /Users/yzliu/work/Meridian/Meridian-roles/src/roles/definitions/agent-dispatcher.ts
- /Users/yzliu/work/Meridian/Meridian-roles/src/roles/definitions/__tests__/agent-dispatcher.test.ts
- /Users/yzliu/work/Meridian/Meridian-roles/src/server/role-handlers.ts
- /Users/yzliu/work/Meridian/Meridian-roles/src/server/__tests__/role-config-handlers.test.ts
- /Users/yzliu/work/Meridian/Meridian-roles/src/tool-gateway/tools/continue-dispatcher.ts

## Validation
- `cd /Users/yzliu/work/Meridian/Meridian-roles && export $(grep -v '^#' .env.example | xargs) && export STATE_FILE_PATH=/tmp/meridian-roles-r03/state.json && npx vitest run src/roles/definitions/__tests__/agent-dispatcher.test.ts src/roles/agent-dispatcher/__tests__/prompt-builder.test.ts src/server/__tests__/role-config-handlers.test.ts` — PASS
- `cd /Users/yzliu/work/Meridian/Meridian-roles && export $(grep -v '^#' .env.example | xargs) && export STATE_FILE_PATH=/tmp/meridian-roles-r03/state.json && npm run build` — PASS

## Deviations from TaskSpec
- None

## Follow-ups
- None
