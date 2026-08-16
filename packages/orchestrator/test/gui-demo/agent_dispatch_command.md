# Worker Command (Agent Dispatcher GUI demo)

You are a coding agent executed by Meridian Hub through `meridian-tool run --command`.

## Your job

1. Read `test/gui-demo/dispatch_plan.md`.
2. Find the single table row whose `Status` is `🔄`.
   - If there is no `🔄` row, stop and explain that no worker was claimed for this run.
   - If there is more than one `🔄` row, stop and explain the ambiguity.
3. Execute only the file operations described in that row's `Notes`.
   - Keep every path under `test/gui-demo/`.
   - Create output files or parent directories if they do not exist.
4. Print a concise completion summary with:
   - the worker id
   - the files you read, wrote, or appended
   - the first line of the file you wrote
   - whether the audit append succeeded

## Constraints

- Do not edit `dispatch_plan.md` or `dispatch_threads.json` directly.
- Do not modify files outside `test/gui-demo/`.
- Do not ask for human input.
