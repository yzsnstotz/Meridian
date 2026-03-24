# R-01 Report

- Worker: `R-01`
- Model: `CODEX`
- Date: `2026-03-25`
- Status: `✅ COMPLETE`

## Scope

- Preserve approval prompts as durable canonical history events through terminal-input resolution and final reply completion
- Keep the same durability rule when loading legacy version-1 saved state into the version-2 canonical history model
- Add targeted regression coverage for the live router flow and the compatibility path

## Files Changed

- `/Users/yzliu/work/Meridian/src/hub/router.ts`
  - Stopped pruning approval events when terminal input arrives
  - Limited final-reply supersession to transient `progress` events so approval prompts remain in canonical history
- `/Users/yzliu/work/Meridian/src/hub/state-store.ts`
  - Updated legacy migration so final replies no longer delete migrated approval prompts
- `/Users/yzliu/work/Meridian/src/hub/router.test.ts`
  - Reworked the approval-resolution regression to assert `approval -> terminal_input -> final_reply`
- `/Users/yzliu/work/Meridian/src/hub/state-store.test.ts`
  - Added a legacy-state migration regression that preserves approval prompts alongside terminal input and final reply
- `/Users/yzliu/work/Meridian/docs/branch/feat:experience-fix/v1.0/investigation_report_v1.0_dispatch_plan.md`
  - Marked `R-01` complete
- `/Users/yzliu/work/Meridian/docs/branch/feat:experience-fix/v1.0/dev_history/R-01_report.md`
  - Recorded completion evidence

## Commands Run

```text
npx tsc --noEmit
node --test --import tsx /Users/yzliu/work/Meridian/src/hub/router.test.ts
node --test --import tsx /Users/yzliu/work/Meridian/src/hub/state-store.test.ts
```

## Command Results

- `npx tsc --noEmit`: `PASS`
- `node --test --import tsx /Users/yzliu/work/Meridian/src/hub/router.test.ts`: `PASS`
  - Summary: `44 passed, 0 failed, 0 cancelled`
- `node --test --import tsx /Users/yzliu/work/Meridian/src/hub/state-store.test.ts`: `PASS`
  - Summary: `1 passed, 0 failed, 0 cancelled`

## Blockers and Caveats

- No functional blockers
- The worktree already contained local changes in `.env.example`, plus in-progress edits in `src/hub/router.ts` and `src/hub/router.test.ts`; this worker was applied on top of those edits without reverting them
- No git commit was created in this session because the current worktree was already mixed with other local changes
