# R-05 — State Store replace_key Narrowing Completion Report

- **Date**: 2026-03-28
- **Model**: CODEX
- **Status**: COMPLETE

## Sub-tasks Completed
- [x] R-05.1 — Narrowed `replace_key` semantics so only approval entries receive a replace key
- [x] R-05.2 — Updated router progress recording so progress entries append while approval entries still overwrite
- [x] R-05.3 — Updated router and state-store tests to cover append-only progress and replaceable approvals

## Files Changed
- `src/hub/state-store.ts` — `buildReplaceKey()` now returns a key only for `"approval"`
- `src/hub/router.ts` — router-side `buildReplaceKey()` now returns `null` for `"progress"`
- `src/hub/router.test.ts` — progress history now asserts append-only behavior; added approval replaceability coverage
- `src/hub/state-store.test.ts` — added legacy approval migration coverage for narrowed replace-key behavior

## Test Results
- Typecheck: PASS
- Unit tests: PASS (275 tests via `node --test --import tsx 'src/**/*.test.ts'`)

## Blockers / Notes
Full validation now passes on `feat/experience-fix`. Progress entries append, approval entries remain replaceable, and final replies still collapse prior progress entries for the same trace.
