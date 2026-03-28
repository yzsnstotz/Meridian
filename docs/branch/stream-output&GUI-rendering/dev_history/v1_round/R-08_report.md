# R-08 — Stream Consumption in Router (handleRun) Completion Report

- **Date**: 2026-03-28
- **Model**: CODEX-XHIGH
- **Status**: COMPLETE

## Sub-tasks Completed
- [x] R-08.1 — Added `streamFromSpawn()` to parse direct child stdout through NDJSON/JSONL stream parsers and emit recoverable transport errors as final deltas
- [x] R-08.2 — Added direct stream execution path in `handleRun()` with agent-specific stream args/parsers, OutputBus fan-out, Codex session capture/resume, and 3-attempt fallback to bridge polling
- [x] R-08.3 — Kept the local `AgentClient` bridge interface unchanged because the stream path bypasses `AgentAPIClient`
- [x] R-08.4 — Added router and stream helper coverage for direct stream success, Codex resume, and fallback after repeated stream failures

## Files Changed
- `src/shared/stream-adapter.ts` — added `streamFromSpawn()` over split NDJSON output with recoverable stream error emission
- `src/shared/stream-adapter.test.ts` — added unit coverage for stdout parsing and iterator failure handling
- `src/hub/router.ts` — added direct stream branch in `handleRun()`, OutputBus integration, stream retry/fallback flow, agent-specific arg/parser selection, Codex session persistence, and child-process lifecycle helpers
- `src/hub/router.test.ts` — added stream-path and fallback-path coverage, including Codex resume behavior and OutputBus push assertions
- `docs/branch/stream-output&GUI-rendering/dispatch_plan.md` — marked `R-08` complete

## Test Results
- Typecheck: PASS
- Unit tests: PASS (319 tests via `node --test --import tsx 'src/**/*.test.ts'`)

## Blockers / Notes
- Full dispatch command and typecheck both pass in the current checkout.
- Batch 5 is not fully complete yet; `R-06` and `R-07` remain unfinished, so this worker should not push the branch.
