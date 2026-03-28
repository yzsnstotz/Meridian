# R-03 — Stream Spawn Architecture (All Agents) Completion Report

- **Date**: 2026-03-28
- **Model**: CODEX
- **Status**: COMPLETE

## Sub-tasks Completed
- [x] R-03.1 — Added `spawnStreamAgent()` to `InstanceManager` for direct short-lived CLI spawns with piped stdin/stdout.
- [x] R-03.2 — Added `buildClaudeStreamArgs()` for `--print --output-format stream-json --verbose --include-partial-messages`.
- [x] R-03.3 — Added `buildGeminiStreamArgs()` for direct `stream-json` execution.
- [x] R-03.4 — Added `buildCodexExecArgs()` and `buildCodexResumeArgs()` for direct JSON streaming.
- [x] R-03.5 — Added `supportsStream` and `codexSessionId` fields plus registry updaters needed for stream-path session/state tracking.
- [x] R-03.6 — Added and updated unit tests for the new stream arg builders, registry metadata, and direct spawn path.

## Files Changed
- `src/agents/claude.ts` — added Claude direct-stream arg builder.
- `src/agents/claude.test.ts` — added Claude stream-args coverage.
- `src/agents/gemini.ts` — added Gemini direct-stream arg builder.
- `src/agents/gemini.test.ts` — added Gemini stream-args coverage.
- `src/agents/codex.ts` — added Codex exec/resume arg builders for stream mode.
- `src/agents/codex.test.ts` — added Codex stream-args coverage.
- `src/hub/instance-manager.ts` — added `spawnStreamAgent()` and default stream capability on spawned instances.
- `src/hub/instance-manager.test.ts` — added direct-spawn coverage and stream-capability assertion.
- `src/hub/registry.ts` — added stream metadata update helpers.
- `src/hub/registry.test.ts` — added registry coverage for `supportsStream` and `codexSessionId`.
- `src/types.ts` — added optional `supportsStream` and `codexSessionId` on `AgentInstance`.

## Test Results
- Typecheck: PASS
- Unit tests: PASS (275 tests)

## Blockers / Notes
The branch was missing the `AgentInstance` stream fields from N-01.2 even though `router.ts` already referenced `supportsStream`. I folded those missing optional fields into this worker so `R-03` could compile and land cleanly without touching the unrelated in-progress `R-05` router/state changes.
