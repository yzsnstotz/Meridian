# Dispatch Plan — Streaming Output & GUI Rendering v1.0

- **TaskSpec**: `/Users/yzliu/work/Meridian/docs/branch/stream-output&GUI-rendering/taskspec_v1.0.md`
- **Branch**: `feat/experience-fix`
- **Date**: 2026-03-26

---

## PRD Reference Paths

| Shorthand | Full Path |
|-----------|-----------|
| Main PRD | `/Users/yzliu/work/Meridian/docs/branch/stream-output&GUI-rendering/meridian_streaming_output_gui_rendering_prd_v1.0.md` |
| Investigation Report | `/Users/yzliu/work/Meridian/docs/branch/stream-output&GUI-rendering/investigation_report_v1.0.md` |
| TaskSpec | `/Users/yzliu/work/Meridian/docs/branch/stream-output&GUI-rendering/taskspec_v1.0.md` |

---

## Model Assignment Legend

| Model | Code | Assign When |
|-------|------|-------------|
| Codex (standard) | `CODEX` | Well-specified schema work, surgical edits, config/template generation, straightforward tool implementations, UI work with clear API contracts, simple CRUD |
| Codex (high) | `CODEX-HIGH` | Standard coordination tasks, moderate integration, tasks requiring stronger reasoning than CODEX but not full cross-module wiring. Pre-flight/environment checks. Prompt builders. |
| Codex (xhigh) | `CODEX-XHIGH` | IPC/async/socket coordination, multi-file architectural integration, streaming, terminal review gates (DELTA-CHECK, PR-REVIEW), any worker depending on 4+ upstream workers with unlocked interfaces |

---

## Master Dispatch Table

| Status | Batch | Worker | Task | Model | Depends On | PRDs to Attach | Notes |
|--------|-------|--------|------|-------|------------|----------------|-------|
| ✅ | 0 | PRE-FLIGHT | Environment Health Check | CODEX | — | — | Gates all batches; typecheck + test baseline |
| ✅ | 1 | N-01 | Stream Types & NDJSON Infrastructure | CODEX | — | Main PRD, Investigation Report | Foundation types; all parsers depend on this |
| ✅ | 1 | N-02 | DiffEngine | CODEX | — | Main PRD | PRD §4.2 exact implementation |
| ✅ | 1 | N-03 | A2A Adapter | CODEX | — | Main PRD | PRD §4.4 mapping tables |
| ✅ | 2 | N-04 | Claude Stream Parser | CODEX | N-01 | Investigation Report | Use fixture `claude-sample.ndjson`; CLI schema NOT API schema |
| ✅ | 2 | N-05 | Gemini Stream Parser | CODEX | N-01 | Investigation Report | Use fixture `gemini-sample.ndjson`; flat string, not array |
| ✅ | 2 | N-06 | Codex Stream Parser | CODEX | N-01 | Investigation Report | Parser and tests complete; prior Claude spawn-arg gate cleared after R-01 test updates |
| ✅ | 2 | R-01 | Claude Spawn Args | CODEX | N-01 | Main PRD, Investigation Report | Add `--output-format stream-json --verbose --include-partial-messages` |
| ✅ | 2 | R-02 | Gemini Spawn Args | CODEX | N-01 | Main PRD, Investigation Report | Add `--output-format stream-json` |
| ⬜ | 3 | R-03 | Stream Spawn Architecture (All Agents) | CODEX-XHIGH | N-04, N-05, N-06 | Main PRD, Investigation Report | Generic spawnStreamAgent + per-agent stream arg builders; bypasses agentapi |
| ✅ | 3 | R-04 | Router Summary Injection Skip | CODEX-HIGH | N-01 | Main PRD, Investigation Report | Gate appendSummaryProtocolPrompt on !supportsStream |
| ⬜ | 4 | N-07 | OutputBus | CODEX-XHIGH | N-02, N-03 | Main PRD, Investigation Report | Central convergence; dual fan-out per PM Resolution #2 |
| ⬜ | 4 | R-05 | State Store replace_key Narrowing | CODEX | — | Main PRD, Investigation Report | Keep for approval, remove for progress |
| ⬜ | 5 | R-06 | Hub Server flushMonitorProgressUpdates Refactor | CODEX-HIGH | N-07 | Main PRD, Investigation Report | Ticker stays; push through OutputBus |
| ⬜ | 5 | R-07 | Pane Broadcaster → OutputBus Integration | CODEX-HIGH | N-07 | Main PRD, Investigation Report | Push accumulator through OutputBus; pane bridge untouched |
| ⬜ | 5 | R-08 | Stream Consumption in Router (handleRun) | CODEX-XHIGH | N-07, R-03, R-04 | Main PRD, Investigation Report | Direct stdout parsing; bypasses agentapi; fallback to bridge polling |
| ⬜ | 6 | R-09 | WebSocket A2A Push Format | CODEX-HIGH | N-07 | Main PRD, Investigation Report | Add a2a_message type alongside pane_output |
| ⬜ | 6 | R-10 | GUI Consumption Layer | CODEX | R-09 | Main PRD, Investigation Report | A2A-driven append rendering; rAF throttling |
| ⬜ | Ω | DELTA-CHECK | Delta Check & Corrective Dispatch | CODEX-XHIGH | All implementation Workers | TaskSpec, Main PRD, Investigation Report | One pass only. Findings → append corrective workers. |
| ⬜ | Ω+1 | PR-REVIEW | PR Alignment Review | CODEX-XHIGH | DELTA-CHECK | TaskSpec, Main PRD, Investigation Report | Terminal gate; human merges |

Status legend: `⬜` Not started · `🔄` In progress · `✅` Complete · `⛔` Blocked · `⏳` Awaiting PM decision

---

## Batch Execution Details

### Batch 0 — Environment Health Check

- **Workers**: PRE-FLIGHT
- **Priority**: P0 — gates entire dispatch
- **Model**: CODEX
- **Agent Notes**: Run typecheck (`npx tsc --noEmit`) and test suite (`node --test --import tsx src/**/*.test.ts`). If either fails, report `⛔ BLOCKED` with error details.
- **Completion Gate**: Both typecheck and tests pass. All Batch 1+ workers are implicitly blocked until PRE-FLIGHT is `✅`.

### Batch 1 — Foundation Types

- **Workers**: N-01, N-02, N-03 (all parallel)
- **Priority**: P0 (N-01), P1 (N-02, N-03)
- **Model**: CODEX (all)
- **Agent Notes**:
  - N-01 is the highest priority — all Batch 2 workers depend on it
  - N-02 and N-03 are independent of each other and of N-01
  - All three create new files with no existing code dependencies
- **Completion Gate**: All three workers `✅`. Typecheck passes.

### Batch 2 — Stream Parsers + Simple Spawn Args

- **Workers**: N-04, N-05, N-06, R-01, R-02 (all parallel)
- **Priority**: P0 (all)
- **Model**: CODEX (all)
- **Agent Notes**:
  - Parsers use verified fixture files in `src/shared/stream-parsers/__fixtures__/`
  - **CRITICAL**: Claude schema is `assistant.message.content[].text` (NOT `content_block_delta.text`). See Investigation P1-02.
  - **CRITICAL**: Gemini schema uses flat `content` string (NOT array). See Investigation P1-03.
  - R-01 and R-02 are simple flag additions to existing spawn arg functions
- **Completion Gate**: All five workers `✅`. All parser tests pass. Typecheck passes.

### Batch 3 — Stream Spawn Architecture + Router Changes

- **Workers**: R-03, R-04 (parallel)
- **Priority**: P0 (both)
- **Model Assignments**: R-03 → CODEX-XHIGH, R-04 → CODEX-HIGH
- **Agent Notes**:
  - R-03 is the largest worker in this batch: creates generic `spawnStreamAgent()` in instance-manager.ts + per-agent stream arg builders in claude.ts, gemini.ts, codex.ts. This is the core transport change — all stream-capable agents bypass `agentapi` and are spawned directly.
  - R-04 is a targeted router change but requires understanding the control flow around `handleRun()`
  - R-03 depends on all three parsers (N-04, N-05, N-06) for the event parsing contracts
  - R-04 depends on N-01 for `supportsStream` type
  - **CRITICAL**: `agentapi` is a third-party binary (v0.11.2) we cannot modify. Stream path must bypass it entirely.
- **Completion Gate**: Both workers `✅`. Stream arg builders tested for all three agents. `spawnStreamAgent()` tested. Router summary skip tested. Typecheck passes.

### Batch 4 — OutputBus + State Store

- **Workers**: N-07, R-05 (parallel)
- **Priority**: P0 (N-07), P1 (R-05)
- **Model Assignments**: N-07 → CODEX-XHIGH, R-05 → CODEX
- **Agent Notes**:
  - N-07 is the central integration piece — must consume DiffEngine (N-02) and A2AAdapter (N-03)
  - N-07 implements dual fan-out per PM Blocker Resolution #2
  - R-05 is independent — only touches state-store.ts and router.ts replace_key logic
  - **PM Flag**: R-05 changes test expectations at router.test.ts:2122 — verify carefully
- **Completion Gate**: Both workers `✅`. OutputBus unit tests pass. replace_key tests updated and passing. Typecheck passes.

### Batch 5 — Server Integration

- **Workers**: R-06, R-07, R-08 (parallel)
- **Priority**: P1 (R-06, R-07), P0 (R-08)
- **Model Assignments**: R-06 → CODEX-HIGH, R-07 → CODEX-HIGH, R-08 → CODEX-XHIGH
- **Agent Notes**:
  - All three depend on N-07 (OutputBus) — verify OutputBus is `✅` before starting
  - R-08 also depends on R-04 (summary skip is prerequisite for stream path)
  - R-06: keep ticker running, keep cooldown guard
  - R-07: push accumulator through OutputBus, do NOT touch web pane bridge
  - R-08: most complex — adds stream branch to handleRun() using direct stdout from `spawnStreamAgent()` (R-03), NOT agentapi SSE. Fallback to bridge polling on stream failure.
  - R-08 now depends on R-03 (stream spawn) in addition to N-07 and R-04
- **Completion Gate**: All three workers `✅`. Server tests pass. agentapi-client tests pass. Router tests pass. Typecheck passes.

### Batch 6 — Frontend

- **Workers**: R-09, R-10 (sequential — R-10 depends on R-09)
- **Priority**: P1 (both)
- **Model Assignments**: R-09 → CODEX-HIGH, R-10 → CODEX
- **Agent Notes**:
  - R-09 adds WebSocket protocol support; R-10 consumes it in GUI
  - R-10 depends on R-09 being complete — do NOT parallelize
  - GUI changes require manual browser testing — no automated GUI tests
  - **PM Flag**: `requestAnimationFrame` throttling important for performance under high-frequency deltas
- **Completion Gate**: Both workers `✅`. WebSocket server test passes. Typecheck passes. Manual GUI verification pending.

### Batch Ω — Delta Check

- **Workers**: DELTA-CHECK
- **Priority**: P0
- **Model**: CODEX-XHIGH
- **Agent Notes**: One pass only. Diff all completed work against TaskSpec acceptance criteria. Produce findings report. If ≤5 corrective workers needed, append to this dispatch plan. If >5, escalate to PM.
- **Completion Gate**: Delta Check Report at `dev_history/v1_round/delta_check_report.md` with all Workers `✅ Aligned`.

### Batch Ω+1 — PR Review

- **Workers**: PR-REVIEW
- **Priority**: P0
- **Model**: CODEX-XHIGH
- **Agent Notes**: Terminal gate. Review full `git diff main..HEAD` against PRD and TaskSpec. Produce per-file verdict table. Human merges.
- **Completion Gate**: PR Review Report at `dev_history/v1_round/pr_review_report.md` with explicit `MERGE APPROVED` or `MERGE BLOCKED` verdict.

---

## PM Flags Summary

| # | Flag | Resolution |
|---|------|------------|
| 1 | PRD §3.3 claims Claude/Gemini share parsing path — incorrect | Each gets separate parser; shared NDJSON line-splitting only. See Investigation P1-02, P1-03. |
| 2 | PRD §3.3 references `content_block_delta.text` for Claude — API schema, not CLI | Correct mapping: `assistant.message.content[*].text`. Agents must use Investigation schema. |
| 3 | PRD §3.3 says Codex needs runtime subcommand detection | Always use `codex exec --json` / `codex exec resume`. No detection needed. |
| 4 | R-05 changes test expectations at router.test.ts:2122 | Tests must be updated: replace_key is now null for progress, non-null for approval only. |
| 5 | ~~R-08 depends on agentapi binary modification~~ | **RESOLVED**: agentapi is a third-party binary (v0.11.2) we cannot modify. Stream path bypasses it entirely via direct `child_process.spawn()`. No external dependency. |
| 6 | P2-05 architectural question: OutputBus fan-out | Resolved: dual output (PM Blocker Resolution #2). Adapter path + WebSocket path. |
| 7 | GUI changes (R-10) need manual browser testing | No automated GUI tests available. Human verification required. |

---

## Completion Tracking

| Batch | Start Date | End Date | Report Files |
|-------|------------|----------|--------------|
| 0 | — | — | `dev_history/v1_round/PRE-FLIGHT_report.md` |
| 1 | — | — | `dev_history/v1_round/N-01_report.md`, `N-02_report.md`, `N-03_report.md` |
| 2 | — | — | `dev_history/v1_round/N-04_report.md`, `N-05_report.md`, `N-06_report.md`, `R-01_report.md`, `R-02_report.md` |
| 3 | — | — | `dev_history/v1_round/R-03_report.md`, `R-04_report.md` |
| 4 | — | — | `dev_history/v1_round/N-07_report.md`, `R-05_report.md` |
| 5 | — | — | `dev_history/v1_round/R-06_report.md`, `R-07_report.md`, `R-08_report.md` |
| 6 | — | — | `dev_history/v1_round/R-09_report.md`, `R-10_report.md` |
| Ω | — | — | `dev_history/v1_round/delta_check_report.md` |
| Ω+1 | — | — | `dev_history/v1_round/pr_review_report.md` |

All report paths relative to `/Users/yzliu/work/Meridian/docs/branch/stream-output&GUI-rendering/`.
