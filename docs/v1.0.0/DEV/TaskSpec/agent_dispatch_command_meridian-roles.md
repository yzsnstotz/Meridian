# Agent Dispatch Command: meridian-roles v1.2

**Version**: v1.2
**Date**: 2026-03
**Instruction**: This file is given verbatim to every agent session. Read it completely before taking any action.

---

## 📁 File Directory Index

| Artifact | Full Absolute Path |
|----------|--------------------|
| **TaskSpec** | `/Users/yzliu/work/Meridian/Meridian-roles/docs/v1.0.0/DEV/TaskSpec/TaskSpec_meridian-roles_v1.2.md` |
| **Dispatch Plan** | `/Users/yzliu/work/Meridian/Meridian-roles/docs/v1.0.0/DEV/TaskSpec/dispatch_plan_meridian-roles.md` |
| **This document** | `/Users/yzliu/work/Meridian/Meridian-roles/docs/v1.0.0/DEV/TaskSpec/agent_dispatch_command_meridian-roles.md` |
| **Dev history dir** | `/Users/yzliu/work/Meridian/Meridian-roles/docs/v1.0.0/DEV/dev_history/` |
| **Repo root (meridian-roles)** | `/Users/yzliu/work/Meridian/Meridian-roles/` |
| **GitHub remote (meridian-roles)** | `https://github.com/yzsnstotz/meridian-roles.git` |
| **Meridian repo root** | `/Users/yzliu/work/Meridian/` |
| **Meridian GitHub remote** | `https://github.com/yzsnstotz/Meridian.git` |
| **PRD: meridian-roles v1.2** | `/Users/yzliu/work/Meridian/Meridian-roles/docs/v1.0.0/PRD/PRD_meridian-roles_v1.2.docx` |
| **PRD: Meridian 平台升级 v1.0** | `/Users/yzliu/work/Meridian/docs/a2a_align/PRD/PRD_Meridian_Upgrade_v1.0.docx` |
| **Env file** | `/Users/yzliu/work/Meridian/Meridian-roles/.env.local` |
| **Git branch** | `meridian-roles-v1.2` |
| **Hub socket** | `/tmp/hub-socks/hub-core.sock` |
| **Roles socket** | `/tmp/meridian-roles.sock` |
| **State file** | `/var/lib/meridian-roles/state.json` |

> ⚠️ STOP: Before executing Step 1, verify every `[ASSUMPTION]` above is correct. Replace all placeholders with confirmed absolute paths. Do NOT proceed with assumed paths.

---

## Environment Configuration

```bash
# Load env vars — run this first in every session
export $(grep -v '^#' /Users/yzliu/work/Meridian/Meridian-roles/.env.local | xargs)

# Verify env loaded
echo "HUB_SOCKET_PATH=${HUB_SOCKET_PATH}"
echo "ROLES_SOCKET_PATH=${ROLES_SOCKET_PATH}"
echo "GUI_PORT=${GUI_PORT}"
echo "STATE_FILE_PATH=${STATE_FILE_PATH}"
```

**Environment variable names used in this project**:

| Var Name | Default | Description |
|----------|---------|-------------|
| `HUB_SOCKET_PATH` | `/tmp/hub-socks/hub-core.sock` | Meridian hub Unix socket |
| `ROLES_SOCKET_PATH` | `/tmp/meridian-roles.sock` | This service's reply socket |
| `GUI_PORT` | `7701` | HTTP GUI port |
| `STATE_FILE_PATH` | `/var/lib/meridian-roles/state.json` | Persistent state file |

**Hard prohibitions for this project** (no Supabase / Docker local DB in scope):
- ❌ Do NOT run `supabase db reset`, `supabase start`, `supabase status`
- ❌ Do NOT run `docker compose up` or any Docker command
- ✅ Use `npm run build` and `npm test` for validation

**Docs directory note**:
- If `docs/` is in `.gitignore`, use `git add -f /Users/yzliu/work/Meridian/Meridian-roles/docs/dev/` to force-add completion reports

---

## Agent Identity Declaration

**Before doing anything else, determine which model you are:**

```
- If you are Claude Opus  → your worker code is: OPUS
- If you are Codex        → your worker code is: CODEX
- If you are another model → STOP. Notify the PM before proceeding.
```

Write your worker code down. You will need it in Step 1.

---

## Step 1 — Read the Dispatch Plan

Open the Dispatch Plan at:
```
/Users/yzliu/work/Meridian/Meridian-roles/docs/v1.0.0/DEV/TaskSpec/dispatch_plan_meridian-roles.md
```

In the **Master Dispatch Table**, find the first row where ALL of the following are true:
1. **Status** = `⬜` (not started)
2. **Model** column matches your worker code from the identity declaration above
3. **All workers listed in "Depends On"** have status `✅`

That row is your assigned task. Note the **Worker ID** (e.g. `N-05`).

If no row matches → output:
```
⏸ PAUSE: No eligible task found for [YOUR_CODE] at this time.
Waiting for dependencies: [list which Depends On workers are not yet ✅]
Notify PM to check dispatch plan status.
```

---

## Step 2 — Dependency Check

For each Worker ID listed in your task's **Depends On** column:
- Confirm its status in the Dispatch Plan is `✅`
- If ANY dependency is NOT `✅`, output:

```
⛔ BLOCKED: [WORKER_ID] cannot start.
Blocking dependency: [dependency Worker ID] is currently [its status].
Do not proceed. Notify PM.
```

Do not attempt to work around blocked dependencies.

---

## Step 3 — Self-Check

Before writing any code:

1. Read the full Worker definition for your task in the TaskSpec at:
   ```
   /Users/yzliu/work/Meridian/Meridian-roles/docs/v1.0.0/DEV/TaskSpec/TaskSpec_meridian-roles_v1.2.md
   ```

2. Confirm you understand:
   - All sub-tasks and their acceptance criteria
   - All Key Constraints (these are hard rules — do not interpret around them)
   - The AI Auto-Tests you must pass before marking done
   - The Deliverable file list (you may only touch files in this list)

3. Check the **Batch Execution Details** and **PM Flags** in the Dispatch Plan for any agent notes specific to your task.

4. If your task is **N-09**: confirm you are working in `/Users/yzliu/work/Meridian`, not `/Users/yzliu/work/Meridian/Meridian-roles`.

5. If anything is unclear or contradictory:
   - PRD > TaskSpec > this command
   - If the PRD is also unclear: output `⏸ PAUSE: Ambiguity in [section]. Notifying PM.` — do NOT make an assumption and proceed.

---

## Step 4 — Execute

### 4a. Mark in-progress
Update your task row in the Dispatch Plan:
```
Status: ⬜ → 🔄
```

### 4b. Implement sub-tasks in order
Work through each sub-task in your Worker definition sequentially. After each sub-task:
- Run the relevant portion of the AI Auto-Tests
- Fix any failures before moving to the next sub-task
- Do NOT accumulate failures and fix at the end

### 4c. Scope discipline — HARD RULE
- Only modify files listed in your Worker's **Deliverables** section
- If you discover a bug in another Worker's files, document it in your completion report — do NOT fix it silently
- If fixing the bug is required to unblock your task, output `⏸ PAUSE: Blocker in [file]. Scope violation risk. Notifying PM.`

### 4d. Run full AI Auto-Tests
After all sub-tasks are complete, run the complete AI Auto-Tests block from your Worker definition. All must pass before proceeding to Step 5.

```bash
# Example for N-01:
cd /Users/yzliu/work/Meridian/Meridian-roles
npm install && npm run build
node -e "const t = require('./dist/types'); t.ReplyChannelSchema.parse({channel:'socket',chat_id:'service:meridian-roles',socket_path:'/tmp/meridian-roles.sock'}); console.log('OK');"
```

If any test fails: fix the issue. Do not mark `✅` with failing tests.

---

## Step 5 — Completion

### 5a. Update Dispatch Plan status
```
Status: 🔄 → ✅
```

### 5b. Write completion report

Save to: `/Users/yzliu/work/Meridian/Meridian-roles/docs/v1.0.0/DEV/dev_history/[WORKER_ID]_completion.md`

Required sections:
```markdown
# Completion Report: [WORKER_ID] — [Worker Name]

**Date**: [YYYY-MM-DD]
**Model**: [OPUS / CODEX]
**Duration**: [estimated hours]

## Deliverables Produced
- [file path 1]
- [file path 2]

## AI Auto-Test Results
[paste test output]

## Deviations from TaskSpec
[list any — if none, write "None"]

## Blockers / Issues for PM
[list any — if none, write "None"]

## Context Summary for Next Session
[2–5 sentences: what was built, key decisions made, what the next dependent task needs to know]
```

Use `git add -f` if `docs/` is gitignored:
```bash
git add -f /Users/yzliu/work/Meridian/Meridian-roles/docs/v1.0.0/DEV/dev_history/[WORKER_ID]_completion.md
```

### 5c. Git commit

```bash
cd /Users/yzliu/work/Meridian/Meridian-roles   # or /Users/yzliu/work/Meridian if you are N-09
git add [your deliverable files]
git add -f /Users/yzliu/work/Meridian/Meridian-roles/docs/v1.0.0/DEV/TaskSpec/dispatch_plan_meridian-roles.md  # always commit updated plan
git commit -m "[WORKER_ID] meridian-roles v1.2: [brief description]

- [sub-task 1 summary]
- [sub-task 2 summary]
- AI auto-tests: PASS
- Dispatch plan updated: [WORKER_ID] ✅"
```

### 5d. Push — batch gate

**Only push when the entire Phase batch is `✅`.**

Check: are all other Workers in the same Phase also `✅` in the Dispatch Plan?

- **Yes — all Phase Workers are ✅**:
  ```bash
  git push origin meridian-roles-v1.2
  ```
  Then output:
  ```
  ✅ PHASE [N] COMPLETE: All workers done.
  Workers completed: [list Worker IDs]
  Next phase: [Phase N+1] — Workers: [list Worker IDs]
  PM: please confirm Phase [N+1] gate before starting next agents.
  ```

- **No — other Workers in this Phase are still in progress**:
  ```
  ✅ [WORKER_ID] COMPLETE. Waiting for Phase [N] batch.
  Remaining in phase: [list Worker IDs not yet ✅]
  Do not push. Notify PM that [WORKER_ID] is ready.
  ```

---

## Status Legend

| Symbol | Meaning |
|--------|---------|
| `⬜` | Not started |
| `🔄` | In progress |
| `✅` | Complete — all tests passed, completion report written, committed |
| `⛔` | Blocked — dependency not met, do not start |
| `⏸` | Paused — PM input required before continuing |

---

## Quick Reference: Worker → Phase → Model

| Worker | Phase | Model | Key Constraint |
|--------|-------|-------|----------------|
| N-01 | 0 | OPUS | ReplyChannelSchema must match Meridian types.ts exactly |
| N-02 | 1 | OPUS | sendIpcMessage format confirmed; socket lifecycle + reconnect |
| N-03 | 1 | CODEX | Interface is frozen — implement exactly as specified |
| N-04 | 1 | CODEX | Atomic write (tmp→rename) required |
| N-05 | 2 | OPUS | suppress_reply: false must be explicit; PM code review required |
| N-06 | 3 | OPUS | inferTraceId check before task match; JSON fence stripping |
| N-07 | 3 | CODEX | Write-through to StateStore on every change |
| N-08 | 4 | CODEX | trace_id display = first 8 chars only; dark theme |
| N-09 | 4 | CODEX | ⚠️ Works in /Users/yzliu/work/Meridian (git: yzsnstotz/Meridian.git), not /Users/yzliu/work/Meridian/Meridian-roles |
| N-10 | 5 | OPUS | Scenario B quality = manual PM review; --mock for CI |
