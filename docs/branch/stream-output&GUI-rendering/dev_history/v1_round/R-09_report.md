# R-09 — WebSocket A2A Push Format Completion Report

- **Date**: 2026-03-29
- **Model**: CODEX-HIGH
- **Status**: COMPLETE

## Sub-tasks Completed
- [x] R-09.1 — Added `a2a_message` handling to the WebSocket bridge alongside existing `pane_output` forwarding
- [x] R-09.2 — Wired `OutputBus.websocketOutput` through hub socket subscribers so A2A deltas reach connected GUI clients
- [x] R-09.3 — Added WebSocket coverage for A2A message forwarding and updated hub monitor test doubles for the non-closing `not_available` subscription path

## Files Changed
- `src/hub/server.ts` — tracked hub socket subscribers per thread, routed `OutputBus` websocket fan-out to them, and kept `subscribe_pane_output` connections open after `not_available`
- `src/web/server.ts` — accepted and forwarded `a2a_message` frames over the browser WebSocket bridge
- `src/web/server.test.ts` — added A2A WebSocket bridge coverage
- `src/hub/server.monitor.test.ts` — updated the fake socket used by the pane subscription test to support the new write path
- `docs/branch/stream-output&GUI-rendering/dispatch_plan.md` — updated R-09 dispatch status

## Test Results
- Typecheck: PASS
- Unit tests: PASS (322 tests)

## Blockers / Notes
- Batch 6 is not complete yet: `R-10` remains `⬜`, so this worker does not push the branch.
