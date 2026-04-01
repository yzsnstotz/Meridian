# PR-REVIEW — PR Alignment Review

- **Date**: 2026-04-01
- **Model**: CODEX-XHIGH
- **Status**: COMPLETE

## Validation Rerun
- `npx tsc --noEmit -p tsconfig.json` — PASS
- `node --test --import tsx 'src/**/*.test.ts'` — PASS (322 tests)

## Per-File Verdicts

| File | Worker | Verdict | Notes |
| --- | --- | --- | --- |
| `.env.example` | — | ➕ Unplanned Addition | Env example changed even though the dispatch command explicitly prohibited env-file edits for this task. |
| `docs/branch/feat:experience-fix/v1.0/dev_history/PRE-FLIGHT_report.md` | — | ➕ Unplanned Addition | Legacy artifact set outside the `stream-output&GUI-rendering` spec path; unrelated to this PRD/TaskSpec. |
| `docs/branch/feat:experience-fix/v1.0/dev_history/R-01_report.md` | — | ➕ Unplanned Addition | Legacy artifact set outside the `stream-output&GUI-rendering` spec path; unrelated to this PRD/TaskSpec. |
| `docs/branch/feat:experience-fix/v1.0/dev_history/R-02_report.md` | — | ➕ Unplanned Addition | Legacy artifact set outside the `stream-output&GUI-rendering` spec path; unrelated to this PRD/TaskSpec. |
| `docs/branch/feat:experience-fix/v1.0/dev_history/R-03_report.md` | — | ➕ Unplanned Addition | Legacy artifact set outside the `stream-output&GUI-rendering` spec path; unrelated to this PRD/TaskSpec. |
| `docs/branch/feat:experience-fix/v1.0/dev_history/R-04_report.md` | — | ➕ Unplanned Addition | Legacy artifact set outside the `stream-output&GUI-rendering` spec path; unrelated to this PRD/TaskSpec. |
| `docs/branch/feat:experience-fix/v1.0/dev_history/R-05_report.md` | — | ➕ Unplanned Addition | Legacy artifact set outside the `stream-output&GUI-rendering` spec path; unrelated to this PRD/TaskSpec. |
| `docs/branch/feat:experience-fix/v1.0/dev_history/delta/R-06_report.md` | — | ➕ Unplanned Addition | Legacy artifact set outside the `stream-output&GUI-rendering` spec path; unrelated to this PRD/TaskSpec. |
| `docs/branch/feat:experience-fix/v1.0/dev_history/delta_check_report.md` | — | ➕ Unplanned Addition | Legacy artifact set outside the `stream-output&GUI-rendering` spec path; unrelated to this PRD/TaskSpec. |
| `docs/branch/feat:experience-fix/v1.0/dev_history/pr_review_report.md` | — | ➕ Unplanned Addition | Legacy artifact set outside the `stream-output&GUI-rendering` spec path; unrelated to this PRD/TaskSpec. |
| `docs/branch/feat:experience-fix/v1.0/investigation_report_v1.0_agent_dispatch_command.md` | — | ➕ Unplanned Addition | Legacy artifact set outside the `stream-output&GUI-rendering` spec path; unrelated to this PRD/TaskSpec. |
| `docs/branch/feat:experience-fix/v1.0/investigation_report_v1.0_dispatch_plan.md` | — | ➕ Unplanned Addition | Legacy artifact set outside the `stream-output&GUI-rendering` spec path; unrelated to this PRD/TaskSpec. |
| `docs/branch/stream-output&GUI-rendering/dev_history/v1_round/N-01_report.md` | N-01 | ✅ Aligned | Expected worker/delta completion report for the current dispatch set. |
| `docs/branch/stream-output&GUI-rendering/dev_history/v1_round/N-02_report.md` | N-02 | ✅ Aligned | Expected worker/delta completion report for the current dispatch set. |
| `docs/branch/stream-output&GUI-rendering/dev_history/v1_round/N-03_report.md` | N-03 | ✅ Aligned | Expected worker/delta completion report for the current dispatch set. |
| `docs/branch/stream-output&GUI-rendering/dev_history/v1_round/N-04_report.md` | N-04 | ✅ Aligned | Expected worker/delta completion report for the current dispatch set. |
| `docs/branch/stream-output&GUI-rendering/dev_history/v1_round/N-05_report.md` | N-05 | ✅ Aligned | Expected worker/delta completion report for the current dispatch set. |
| `docs/branch/stream-output&GUI-rendering/dev_history/v1_round/N-06_report.md` | N-06 | ✅ Aligned | Expected worker/delta completion report for the current dispatch set. |
| `docs/branch/stream-output&GUI-rendering/dev_history/v1_round/N-07_report.md` | N-07 | ✅ Aligned | Expected worker/delta completion report for the current dispatch set. |
| `docs/branch/stream-output&GUI-rendering/dev_history/v1_round/PRE-FLIGHT_report.md` | PRE-FLIGHT | ✅ Aligned | Expected worker/delta completion report for the current dispatch set. |
| `docs/branch/stream-output&GUI-rendering/dev_history/v1_round/R-01_report.md` | R-01 | ✅ Aligned | Expected worker/delta completion report for the current dispatch set. |
| `docs/branch/stream-output&GUI-rendering/dev_history/v1_round/R-02_report.md` | R-02 | ✅ Aligned | Expected worker/delta completion report for the current dispatch set. |
| `docs/branch/stream-output&GUI-rendering/dev_history/v1_round/R-03_report.md` | R-03 | ✅ Aligned | Expected worker/delta completion report for the current dispatch set. |
| `docs/branch/stream-output&GUI-rendering/dev_history/v1_round/R-04_report.md` | R-04 | ✅ Aligned | Expected worker/delta completion report for the current dispatch set. |
| `docs/branch/stream-output&GUI-rendering/dev_history/v1_round/R-05_report.md` | R-05 | ✅ Aligned | Expected worker/delta completion report for the current dispatch set. |
| `docs/branch/stream-output&GUI-rendering/dev_history/v1_round/R-06_report.md` | R-06 | ✅ Aligned | Expected worker/delta completion report for the current dispatch set. |
| `docs/branch/stream-output&GUI-rendering/dev_history/v1_round/R-08_report.md` | R-08 | ✅ Aligned | Expected worker/delta completion report for the current dispatch set. |
| `docs/branch/stream-output&GUI-rendering/dev_history/v1_round/R-09_report.md` | R-09 | ✅ Aligned | Expected worker/delta completion report for the current dispatch set. |
| `docs/branch/stream-output&GUI-rendering/dev_history/v1_round/R-10_report.md` | R-10 | ✅ Aligned | Expected worker/delta completion report for the current dispatch set. |
| `docs/branch/stream-output&GUI-rendering/dev_history/v1_round/delta_check_report.md` | DELTA-CHECK | ✅ Aligned | Expected worker/delta completion report for the current dispatch set. |
| `docs/branch/stream-output&GUI-rendering/dev_history/v1_round/pr_review_report.md` | PR-REVIEW | ✅ Aligned | Required terminal review artifact for this worker. |
| `docs/branch/stream-output&GUI-rendering/dispatch_plan.md` | All workers | ✅ Aligned | Authoritative dispatch tracker for this spec; status updates match the completed worker set. |
| `src/agents/claude.test.ts` | R-01, R-03 | ✅ Aligned | Covers updated bridge args and direct-stream Claude args. |
| `src/agents/claude.ts` | R-01, R-03 | ✅ Aligned | Bridge args include Claude stream flags; direct-stream builder added separately. |
| `src/agents/codex.test.ts` | R-03 | ✅ Aligned | Covers new Codex direct-stream builders. |
| `src/agents/codex.ts` | R-03 | ✅ Aligned | Adds Codex `exec`/`resume` JSON-stream arg builders without disturbing fallback bridge args. |
| `src/agents/gemini.test.ts` | R-02, R-03 | ✅ Aligned | Covers updated Gemini bridge args and direct-stream args. |
| `src/agents/gemini.ts` | R-02, R-03 | ✅ Aligned | Bridge args gain `--output-format stream-json`; direct-stream Gemini args added. |
| `src/hub/instance-manager.test.ts` | R-03 | ✅ Aligned | Covers direct stream spawning and updated stream-capable registration. |
| `src/hub/instance-manager.ts` | R-03 | ✅ Aligned | Adds direct `spawnStreamAgent()` and stream capability registration for Claude/Gemini/Codex. |
| `src/hub/output-bus.test.ts` | N-07 | ✅ Aligned | Covers dual fan-out, snapshot diffing, finalize behavior, and record-hook dispatch. |
| `src/hub/output-bus.ts` | N-07, R-06 | ✅ Aligned | Implements shared diff/A2A fan-out bus and exposes setter hooks used by server integration. |
| `src/hub/registry.test.ts` | R-03 | ✅ Aligned | Covers stream metadata updates without mutating identity fields. |
| `src/hub/registry.ts` | R-03 | ✅ Aligned | Adds registry helpers for `supportsStream` and Codex session tracking. |
| `src/hub/router.test.ts` | R-04, R-05, R-08 | ✅ Aligned | Covers summary skip, append-only progress semantics, direct-stream success, Codex resume, and fallback to bridge. |
| `src/hub/router.ts` | R-04, R-05, R-06, R-08 | ✅ Aligned | Summary injection gating, append-only progress, raw progress snapshots, and direct stream execution all match the spec. |
| `src/hub/server.monitor.test.ts` | R-06, R-09 | ✅ Aligned | Covers monitor-progress OutputBus delivery and WebSocket subscriber bridging updates. |
| `src/hub/server.priority-queue.test.ts` | R-07 | ✅ Aligned | Covers push-accumulator delivery after OutputBus integration. |
| `src/hub/server.ts` | R-06, R-07, R-09 | ✅ Aligned | Routes monitor snapshots and pane-push accumulation through OutputBus and forwards A2A websocket frames. |
| `src/hub/state-store.test.ts` | R-05 | ✅ Aligned | Covers narrowed replace-key behavior and legacy approval preservation. |
| `src/hub/state-store.ts` | R-05 | ✅ Aligned | Narrows `replace_key` to approval events only. |
| `src/shared/a2a-adapter.test.ts` | N-03 | ✅ Aligned | Covers A2A task-state and parts mapping. |
| `src/shared/a2a-adapter.ts` | N-03 | ✅ Aligned | Implements the PRD A2A type and mapping contract. |
| `src/shared/agent-output.test.ts` | R-07 | ⚠️ Scope Drift | Drops the test that guarded suppression of Codex working-placeholder noise, matching the unplanned behavior change above. |
| `src/shared/agent-output.ts` | R-07 | ⚠️ Scope Drift | Removes transient filtering for Codex-style working placeholders even though R-07 said chunk classification must be preserved. |
| `src/shared/diff-engine.test.ts` | N-02 | ✅ Aligned | Covers continuous, reset, clear, empty, and multi-trace cases. |
| `src/shared/diff-engine.ts` | N-02 | ✅ Aligned | Matches the PRD continuous/reset diff contract. |
| `src/shared/stream-adapter.test.ts` | N-01, R-08 | ✅ Aligned | Covers the stream contract and `streamFromSpawn()` success/error behavior. |
| `src/shared/stream-adapter.ts` | N-01, R-08 | ✅ Aligned | Defines canonical stream contracts and adds `streamFromSpawn()` for direct stdout parsing. |
| `src/shared/stream-parsers/__fixtures__/claude-sample.ndjson` | N-04 | ✅ Aligned | Fixture backing Claude parser verification. |
| `src/shared/stream-parsers/__fixtures__/codex-sample.jsonl` | N-06 | ✅ Aligned | Fixture backing Codex parser verification. |
| `src/shared/stream-parsers/__fixtures__/gemini-sample.ndjson` | N-05 | ✅ Aligned | Fixture backing Gemini parser verification. |
| `src/shared/stream-parsers/claude.test.ts` | N-04 | ✅ Aligned | Fixture-backed Claude parser coverage. |
| `src/shared/stream-parsers/claude.ts` | N-04 | ✅ Aligned | Maps Claude CLI NDJSON events using `message.content[*].text`. |
| `src/shared/stream-parsers/codex.test.ts` | N-06 | ✅ Aligned | Fixture-backed Codex parser coverage including tool-call/result events. |
| `src/shared/stream-parsers/codex.ts` | N-06 | ✅ Aligned | Maps Codex JSONL lifecycle events and extracts thread/session ids. |
| `src/shared/stream-parsers/gemini.test.ts` | N-05 | ✅ Aligned | Fixture-backed Gemini parser coverage. |
| `src/shared/stream-parsers/gemini.ts` | N-05 | ✅ Aligned | Maps Gemini CLI NDJSON events using flat-string `content`. |
| `src/shared/stream-parsers/ndjson.test.ts` | N-01 | ✅ Aligned | Covers chunk boundaries, malformed lines, empty lines, and trailing buffers. |
| `src/shared/stream-parsers/ndjson.ts` | N-01 | ✅ Aligned | Implements shared NDJSON splitting with malformed-line skipping. |
| `src/types.test.ts` | N-01, R-06, R-09 | ⚠️ Mixed Scope | Adds stream/progress schema coverage, but also removes the `reply` intent expectation to match the extra schema cleanup. |
| `src/types.ts` | N-01, R-06, R-09 | ⚠️ Mixed Scope | Needed stream/progress schema additions are present, but the built-in `reply` intent is also removed outside the TaskSpec. |
| `src/web/public-layout.test.ts` | R-10 | ⚠️ Mixed Scope | Useful restore/A2A regression coverage is added, but the file also brings in unrelated accessibility/layout assertions not called out in the worker scope. |
| `src/web/public/terminal.html` | R-10 | ✅ Aligned | Adds `a2a_message` consumption, append-only working renders, final/failure handling, and rAF throttling while preserving pane fallback. |
| `src/web/server.test.ts` | R-09, R-10 | ⚠️ Mixed Scope | Covers A2A websocket and structured progress behavior, but also adds unrelated accessibility markup assertions. |
| `src/web/server.ts` | R-09 | ✅ Aligned | Accepts and forwards `a2a_message` websocket frames and returns structured progress snapshots. |

## Scope Drift Summary
The planned streaming, OutputBus, WebSocket A2A, and GUI append-rendering work is largely implemented as specified, and the branch currently passes both typecheck and the full 322-test suite. This PR is still not safe to merge as-is because `main..HEAD` contains unrelated branch baggage (`.env.example` edits and a separate legacy `docs/branch/feat:experience-fix/v1.0/*` artifact set) plus source/test drift outside the TaskSpec (`src/shared/agent-output.ts`, `src/types.ts`, and extra accessibility-only test additions).

MERGE BLOCKED — remove or split the unrelated env/docs changes and resolve the out-of-scope source/test drift before merge.
