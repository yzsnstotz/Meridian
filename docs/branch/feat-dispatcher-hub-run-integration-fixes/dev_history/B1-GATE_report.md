# B1-GATE Report

- Worker: `B1-GATE`
- Model: `CODEX-XHIGH`
- Branch: `feat-dispatcher-hub-run-integration-fixes`
- Status: `✅ Complete`
- Date: `2026-04-02`

## Scope

- Verified the Meridian Hub delayed-final and structured non-final `intent:run` contract against the current router implementation and targeted tests.
- Verified the Meridian-roles `run --command <path>` contract expands command-file contents before the Hub payload is sent.
- Verified the dispatcher prompt, tool surface, worker-sidecar lifecycle, and attach-aware role detail flow are aligned well enough to unblock Batch 3.

## Files Reviewed

- `/Users/yzliu/work/Meridian/docs/branch/feat-dispatcher-hub-run-integration-fixes/integration_issue_brief.md`
- `/Users/yzliu/work/Meridian/docs/branch/feat-dispatcher-hub-run-integration-fixes/dev_history/R-01_report.md`
- `/Users/yzliu/work/Meridian/docs/branch/feat-dispatcher-hub-run-integration-fixes/dev_history/R-02_report.md`
- `/Users/yzliu/work/Meridian/docs/branch/feat-dispatcher-hub-run-integration-fixes/dev_history/R-03_report.md`
- `/Users/yzliu/work/Meridian/src/hub/router.ts`
- `/Users/yzliu/work/Meridian/src/hub/router.test.ts`
- `/Users/yzliu/work/meridian/Meridian-roles/src/tool-gateway/tools/run.ts`
- `/Users/yzliu/work/meridian/Meridian-roles/src/tool-gateway/tools/__tests__/run.test.ts`
- `/Users/yzliu/work/meridian/Meridian-roles/src/tool-gateway/tools/__tests__/update-status.test.ts`
- `/Users/yzliu/work/meridian/Meridian-roles/src/server/role-handlers.ts`
- `/Users/yzliu/work/meridian/Meridian-roles/src/server/__tests__/role-config-handlers.test.ts`
- `/Users/yzliu/work/meridian/Meridian-roles/src/roles/agent-dispatcher/prompt-builder.ts`
- `/Users/yzliu/work/meridian/Meridian-roles/src/roles/agent-dispatcher/__tests__/prompt-builder.test.ts`

## Verification Summary

- Hub/result contract: `src/hub/router.ts` now keeps polling for delayed same-trace summaries in `waitForAgentReply()`, returns `status: "success"` with `run_state: "completed"` for final replies, and returns `status: "partial"` with `run_state: "still_running"` or `run_state: "timeout"` via `buildPendingRunResult(...)` when the final reply is still unavailable.
- Dispatcher/tool `--command` contract: `src/tool-gateway/tools/run.ts` reads `command` with `readFile(...)` and sends the file contents as `payload.content` in the Hub `intent: "run"` message. `src/tool-gateway/tools/__tests__/run.test.ts` passed and asserts the Hub payload contains a string read from disk rather than relying on the path literal.
- Attach observability contract: `src/server/role-handlers.ts` calls `attachToThread(dispatcherThreadId)` before `getThreadDetail(dispatcherThreadId)`. The default attach path sends Hub `intent: "attach"` with reply channel `{ "channel": "web", "chat_id": "service:meridian-roles" }` to the live `dispatcher_thread_id`. `src/server/__tests__/role-config-handlers.test.ts` passed and verifies attach occurs before returning non-empty dispatcher detail/session-log content.
- Prompt/tool alignment: `src/roles/agent-dispatcher/prompt-builder.ts` documents the current CLI surface (`spawn`, `run`, `kill`, `notify`, `update-status`), explicit `update-status --thread-id` sidecar tracking, and the structured `data.run_state` handling for `still_running` / `timeout`. `src/tool-gateway/tools/run.ts`, `src/tool-gateway/tools/__tests__/update-status.test.ts`, and `src/server/__tests__/role-config-handlers.test.ts` match that contract.

## Commands Run

1. `cd /Users/yzliu/work/Meridian && node --test --import tsx /Users/yzliu/work/Meridian/src/hub/router.test.ts`
   - Result: `PASS`
2. `cd /Users/yzliu/work/meridian/Meridian-roles && npx vitest run /Users/yzliu/work/meridian/Meridian-roles/src/roles/agent-dispatcher/__tests__/prompt-builder.test.ts /Users/yzliu/work/meridian/Meridian-roles/src/tool-gateway/tools/__tests__/run.test.ts /Users/yzliu/work/meridian/Meridian-roles/src/tool-gateway/tools/__tests__/update-status.test.ts /Users/yzliu/work/meridian/Meridian-roles/src/server/__tests__/role-config-handlers.test.ts`
   - Result: `FAIL`
   - Note: Vitest reported `No test files found` when given absolute-path filters under this repo's configured include pattern.
3. `cd /Users/yzliu/work/meridian/Meridian-roles && npx vitest run src/roles/agent-dispatcher/__tests__/prompt-builder.test.ts src/tool-gateway/tools/__tests__/run.test.ts src/tool-gateway/tools/__tests__/update-status.test.ts src/server/__tests__/role-config-handlers.test.ts`
   - Result: `PASS`

## Gate Decision

- `B1-GATE` is `✅`.
- Batch 3 may proceed.

## Required Round Notes

- `--command` payload-content semantics verified directly by test or instrumentation: `Yes`
  - Source: `src/tool-gateway/tools/__tests__/run.test.ts`
- GUI/detail evidence required an attach step: `Yes`
  - Attach path used: `src/server/role-handlers.ts` issues Hub `intent: "attach"` with reply channel `{ "channel": "web", "chat_id": "service:meridian-roles" }` for the live `dispatcher_thread_id` before fetching detail/history.

## Files Changed

- `/Users/yzliu/work/Meridian/docs/branch/feat-dispatcher-hub-run-integration-fixes/dev_history/B1-GATE_report.md`
- `/Users/yzliu/work/Meridian/docs/branch/feat-dispatcher-hub-run-integration-fixes/dispatch_plan.md`
