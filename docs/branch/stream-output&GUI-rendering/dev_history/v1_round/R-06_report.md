# R-06 — Hub Server flushMonitorProgressUpdates Refactor Completion Report

- **Date**: 2026-03-28
- **Model**: CODEX-HIGH
- **Status**: COMPLETE

## Sub-tasks Completed
- [x] R-06.1 — Refactored `flushMonitorProgressUpdates()` to build progress snapshots and push them through `OutputBus` while preserving the ticker and cooldown guard
- [x] R-06.2 — Exposed raw progress snapshot access from the router and reused the shared `OutputBus` instance from the server/router path
- [x] R-06.3 — Updated monitor progress tests to verify OutputBus-driven delivery, diff suppression, and conversation recording

## Files Changed
- `src/hub/output-bus.ts` — added sink/record hook setters so the server can attach monitor-progress callbacks to the shared bus after construction
- `src/hub/router.ts` — exposed `buildProgressSnapshotForThread()` and `getOutputBus()` so monitor progress can push raw snapshots through OutputBus
- `src/hub/server.ts` — rewired monitor progress flushing to use `OutputBus.pushSnapshot()`, reconstruct result delivery from bus deltas, and preserve progress recording via the bus hook
- `src/hub/server.monitor.test.ts` — updated fake router coverage to exercise OutputBus monitor-progress diffing and recording behavior
- `docs/branch/stream-output&GUI-rendering/dispatch_plan.md` — marked `R-06` complete

## Test Results
- Typecheck: PASS
- Unit tests: PASS (319 tests via `node --test --import tsx 'src/**/*.test.ts'`)

## Blockers / Notes
- An intermediate full-suite rerun hit the unrelated flaky test `src/hub/instance-manager.test.ts` (`spawn pane_bridge waits for Gemini footer chrome to settle before returning`). The file passed in isolation, and the final full-suite rerun passed cleanly.
- Batch 5 is still incomplete because `R-07` remains unfinished. This worker should commit, but should not push.
