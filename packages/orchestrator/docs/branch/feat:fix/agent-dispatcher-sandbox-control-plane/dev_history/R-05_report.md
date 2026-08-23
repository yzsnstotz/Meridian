# Completion Report: R-05 — Meridian companion `trace_id` observability patch

## Summary

- Extended Meridian Hub so inbound Hub `trace_id` is passed from `handleSpawn` and stream-agent launch into `InstanceManager`, stored on each new `AgentInstance` as optional `spawn_trace_id`, and emitted on spawn lifecycle, readiness, pane-bridge probe, process exit/error, kill, and registry register/unregister logs.
- Router now forwards `message.trace_id` into `instanceManager.spawn` and `spawnStreamAgent`.

## Files Changed (Meridian companion repo)

- `/Users/yzliu/work/Meridian/src/types.ts` — `AgentInstanceSchema.spawn_trace_id` (nullable optional).
- `/Users/yzliu/work/Meridian/src/hub/instance-manager.ts` — `spawn` / `spawnInternal` / readiness / pane / child-process / kill logging; `spawnStreamAgent` optional trace.
- `/Users/yzliu/work/Meridian/src/hub/registry.ts` — register/unregister hub logs use instance `spawn_trace_id`.
- `/Users/yzliu/work/Meridian/src/hub/router.ts` — `handleSpawn` and `runStreamAttempt` pass `message.trace_id`.
- `/Users/yzliu/work/Meridian/src/hub/instance-manager.test.ts` — spawn stores `spawn_trace_id` when provided.
- `/Users/yzliu/work/Meridian/src/hub/registry.test.ts` — round-trip `spawn_trace_id` on register/unregister.

## Validation

Commands (cwd: `/Users/yzliu/work/Meridian`):

- `npm run typecheck` — exit **0**
- `node --test --import tsx src/hub/instance-manager.test.ts src/hub/registry.test.ts src/hub/router.test.ts src/hub/server.idempotency.test.ts` — exit **0**

## Companion branch and commit

- **Branch**: `feat/fix/agent-dispatcher-sandbox-control-plane-hub`
- **Commit**: `79112bc00ef0c608ace548b5395f4c39ee42e663`

## Deviations from TaskSpec

- None.

## Follow-ups

- Push `feat/fix/agent-dispatcher-sandbox-control-plane-hub` to `origin` when ready (not executed from this environment).
