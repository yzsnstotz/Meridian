# N-07 — OutputBus Completion Report

- **Date**: 2026-03-28
- **Model**: CODEX-XHIGH
- **Status**: COMPLETE

## Sub-tasks Completed
- [x] N-07 context review — read dispatch plan, TaskSpec N-07, PRD §4.3, and Investigation P2-02 / P2-05 / DD-3 / DD-5
- [x] Restored the missing checkout artifacts required by N-07 from N-01 / N-02 / N-03: `stream-adapter.ts`, `stream-parsers/ndjson.ts`, `diff-engine.ts`, `a2a-adapter.ts`
- [x] Implemented `src/hub/output-bus.ts` with snapshot diffing, delta fan-out, finalize handling, and a conversation-recording hook
- [x] Added targeted unit coverage for the shared contracts and OutputBus
- [x] Updated dispatch tracking from `⛔` to `✅`

## Files Changed
- `src/shared/stream-adapter.ts` — added canonical `OutputDelta` / `StreamAdapter` contracts
- `src/shared/stream-adapter.test.ts` — added type-contract smoke coverage
- `src/shared/stream-parsers/ndjson.ts` — added shared NDJSON splitter for downstream stream parsing
- `src/shared/stream-parsers/ndjson.test.ts` — added NDJSON buffering / malformed-line coverage
- `src/shared/diff-engine.ts` — added snapshot-to-delta engine per PRD §4.2
- `src/shared/diff-engine.test.ts` — added continuous / reset / clear coverage
- `src/shared/a2a-adapter.ts` — added A2A types plus `OutputDelta` / `HubResultStatus` mapping
- `src/shared/a2a-adapter.test.ts` — added A2A mapping coverage
- `src/hub/output-bus.ts` — added dual fan-out OutputBus with record hook
- `src/hub/output-bus.test.ts` — added OutputBus dispatch / finalize coverage
- `docs/branch/stream-output&GUI-rendering/dispatch_plan.md` — updated N-07 status to `✅`
- `docs/branch/stream-output&GUI-rendering/dev_history/v1_round/N-07_report.md` — replaced blocker note with completion report

## Test Results
- Typecheck: PASS — `npm run typecheck`
- Unit tests: PASS — `node --test --import tsx src/shared/stream-adapter.test.ts src/shared/stream-parsers/ndjson.test.ts src/shared/diff-engine.test.ts src/shared/a2a-adapter.test.ts src/hub/output-bus.test.ts`

## Notes
- The original blocker was accurate for this checkout at the time it was filed: the required shared modules were absent even though the dispatch table already showed their workers as complete.
- The fix was to restore the missing N-01 / N-02 / N-03 contracts directly in this branch and implement N-07 against them.
- `OutputBus` remains transport-focused. Conversation persistence is preserved through an explicit `recordOutput` hook so downstream server integration workers can thread existing `recordAgentPushConversationSafe()` behavior through the new convergence point without mixing transport and server business logic.
