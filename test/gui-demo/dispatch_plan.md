# Agent Dispatcher GUI Demo Plan
#
# Start this fixture through:
#   POST /api/agent-dispatcher/start
# with:
#   dispatch_plan_path=test/gui-demo/dispatch_plan.md
#   command_file_path=test/gui-demo/agent_dispatch_command.md
#
# Treat the demo as passing only when all of the following are true:
# - dispatch_threads.json records dispatcher_thread_id and then clears worker entries at terminal status
# - step1.txt, final.txt, and audit.txt exist with non-empty content
# - /api/role/<dispatcher_id> returns a non-empty session_log after the attach-aware detail fetch
#
# If you inspect detail/history from the GUI or role-detail API, use the supported attach-first flow.
# The role-detail path is expected to attach to dispatcher_thread_id before reading latest detail.
#
| Status | Batch | Worker | Task | Model | Depends On | Notes |
|--------|-------|--------|------|-------|------------|-------|
| ⬜ | 1 | A-01 | Create `step1.txt` from `input.txt` | CODEX-HIGH | — | Read `test/gui-demo/input.txt`, write `test/gui-demo/step1.txt` with prefix `step1: `, append an audit line to `test/gui-demo/audit.txt`, and report the first line written. |
| ⬜ | 2 | B-01 | Create `final.txt` from `step1.txt` | GEMINI | A-01 ✅ | Read `test/gui-demo/step1.txt`, write `test/gui-demo/final.txt` with prefix `final: `, append an audit line to `test/gui-demo/audit.txt`, and leave dispatch_threads.json with no active worker entries once the row is terminal. |



