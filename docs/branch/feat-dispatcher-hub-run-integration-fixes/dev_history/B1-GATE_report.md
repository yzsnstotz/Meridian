# B1-GATE Report

- Worker: `B1-GATE`
- Model: `CODEX-XHIGH`
- Branch: `feat-dispatcher-hub-run-integration-fixes`
- Status: `✅ Complete`
- Date: `2026-04-02`

## Scope

- Verified the Meridian Hub delayed-final and structured non-final `intent:run` contract against the current router implementation and targeted tests.
- Verified the Meridian-roles `run --command <path>` contract embeds command-file contents in the Hub payload rather than sending a path-only wrapper.
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
- Dispatcher/tool `--command` contract: `src/tool-gateway/tools/run.ts` reads `command` with `readFile(...)` and embeds the file contents in the Hub `intent: "run"` payload alongside worker metadata and runtime overrides. `src/tool-gateway/tools/__tests__/run.test.ts` passed and asserts the Hub payload contains command text such as `# Role Definition` and does not contain the command-file path literal.
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

## 2026-04-27 Reverification

- Found and fixed a contract drift: the current Meridian-roles run tool was sending a wrapper that instructed the agent to read the command file path. That allowed the P0 gate tests to pass without proving command-file body delivery.
- Updated `src/tool-gateway/tools/run.ts` so the worker preamble embeds the command file contents directly in the Hub run payload and moves runtime overrides after the embedded command.
- Updated `src/tool-gateway/tools/__tests__/run.test.ts` so the regression test fails if the Hub-facing payload omits `# Agent Dispatch Command` / `# Role Definition` or includes the command-file path literal.

### Fresh Verification

1. `cd /Users/yzliu/work/Meridian && node --test --import tsx /Users/yzliu/work/Meridian/src/hub/router.test.ts`
   - Result: `PASS` — 60 tests.
2. `cd /Users/yzliu/work/Meridian && node --test --import tsx /Users/yzliu/work/Meridian/src/hub/instance-manager.test.ts`
   - Result: `PASS` — 39 tests.
3. `cd /Users/yzliu/work/Meridian && node --test --import tsx /Users/yzliu/work/Meridian/src/hub/result-sender.test.ts`
   - Result: `PASS` — 13 tests.
4. `cd /Users/yzliu/work/Meridian/Meridian-roles && npx tsc --noEmit`
   - Result: `PASS`.
5. `cd /Users/yzliu/work/Meridian/Meridian-roles && npx vitest run /Users/yzliu/work/Meridian/Meridian-roles/src/roles/agent-dispatcher/__tests__/launcher.test.ts /Users/yzliu/work/Meridian/Meridian-roles/src/tool-gateway/tools/__tests__/spawn.test.ts /Users/yzliu/work/Meridian/Meridian-roles/src/tool-gateway/tools/__tests__/run.test.ts /Users/yzliu/work/Meridian/Meridian-roles/src/tool-gateway/tools/__tests__/update-status.test.ts /Users/yzliu/work/Meridian/Meridian-roles/src/server/__tests__/role-config-handlers.test.ts /Users/yzliu/work/Meridian/Meridian-roles/src/roles/definitions/__tests__/agent-dispatcher.test.ts /Users/yzliu/work/Meridian/Meridian-roles/src/roles/agent-dispatcher/__tests__/session-manager.test.ts`
   - Result: `PASS` — 7 files, 138 tests.
6. `cd /Users/yzliu/work/Meridian/Meridian-roles && npm test`
   - Result: `PASS` — 44 files, 398 tests.
7. `cd /Users/yzliu/work/Meridian/Meridian-roles && npm run lint`
   - Result: `PASS`.
8. `cd /Users/yzliu/work/Meridian/Meridian-roles && npm run test:e2e`
   - Result: `PASS` — 7 files, 13 tests.

## Required Round Notes

- `--command` payload-content semantics verified directly by test or instrumentation: `Yes`
  - Source: `src/tool-gateway/tools/__tests__/run.test.ts`
- GUI/detail evidence required an attach step: `Yes`
  - Attach path used: `src/server/role-handlers.ts` issues Hub `intent: "attach"` with reply channel `{ "channel": "web", "chat_id": "service:meridian-roles" }` for the live `dispatcher_thread_id` before fetching detail/history.

## Files Changed

- `/Users/yzliu/work/Meridian/docs/branch/feat-dispatcher-hub-run-integration-fixes/dev_history/B1-GATE_report.md`
- `/Users/yzliu/work/Meridian/docs/branch/feat-dispatcher-hub-run-integration-fixes/dispatch_plan.md`
- `/Users/yzliu/work/Meridian/Meridian-roles/src/tool-gateway/tools/run.ts`
- `/Users/yzliu/work/Meridian/Meridian-roles/src/tool-gateway/tools/__tests__/run.test.ts`
