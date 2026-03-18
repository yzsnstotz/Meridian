# Completion Report: R-11 — agents/claude.ts + agents/codex.ts CLI flags
- **Date**: 2026-03-15
- **Model**: CODEX
- **Status**: ✅ Complete

## Sub-tasks Completed
- R-11.1 — Add `--dangerously-skip-permissions` to `buildClaudeCliArgs()`: ✅
- R-11.2 — Add `--approval-policy=auto-approve` to `buildCodexSpawnArgs()`: ✅
- R-11.3 — Wire `autoApprove` through `instance-manager` `buildSpawnArgs()`: ✅

## Files Modified
- src/agents/claude.ts — added optional `autoApprove` handling in both Claude CLI arg builders
- src/agents/codex.ts — added optional `autoApprove` handling for Codex spawn args
- src/hub/instance-manager.ts — forwarded `autoApprove` through `buildSpawnArgs()` into provider-specific builders
- src/hub/instance-manager.test.ts — extended spawn-path coverage to assert the new Claude and Codex flags
- src/agents/claude.test.ts — added direct unit tests for Claude CLI builder behavior
- src/agents/codex.test.ts — added direct unit tests for Codex CLI builder behavior
- docs/a2a_align/DEV/TaskSpec/meridian_dispatch_plan_v1_0_upgrade.md — updated R-11 status tracking

## Tests Run
- npm run typecheck: ✅
- node --import tsx -e "const mod = await import('./src/agents/claude.ts'); const { buildClaudeCliArgs } = mod.default; ...": ✅
- node --import tsx -e "const mod = await import('./src/agents/codex.ts'); const { buildCodexSpawnArgs } = mod.default; ...": ✅
- node --test --import tsx src/agents/claude.test.ts src/agents/codex.test.ts src/hub/instance-manager.test.ts: ✅ (28 tests, 0 failures)

## Blockers / Notes
- The TaskSpec's sample `node -e "require('./src/...')"` checks do not work in this repo because the sources are TypeScript modules. I validated the same assertions with `tsx`-based imports instead.
- The worktree already contained unrelated untracked paths (`Meridian-roles/`, `docs/a2a_align/PRD/`, and TaskSpec inputs). They were left untouched and will not be included in the worker commit.
