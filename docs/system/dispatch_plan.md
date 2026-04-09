# Meridian System Map — Dispatch Plan v1.0

**Date**: 2026-04-08
**Branch**: `feat-cli-external-integration`
**Round**: main

---

## PRD Reference Paths

| Shorthand | Full Path |
|-----------|-----------|
| TaskSpec | `/Users/yzliu/work/Meridian/docs/system/system_map_taskspec_v1.0.md` |
| FORMAT_SPEC | `/Users/yzliu/work/Meridian/docs/system/FORMAT_SPEC.md` (created by N-01) |

---

## Model Assignment Legend

| Model | Code | Assigned Tasks |
|-------|------|----------------|
| Codex (standard) | `CODEX` | N-05 (agents — 4 clear files), N-06 (monitor — 7 files), N-07 (web — endpoints), N-08 (bin — 2 files), N-09 (root — 4 files, schema work) |
| Codex (high) | `CODEX-HIGH` | N-01 (scaffold — defines interfaces for all downstream), N-03 (interface — slash commands, moderate complexity) |
| Codex (xhigh) | `CODEX-XHIGH` | N-02 (hub — 32 files, complex routing), N-04 (shared — 27 files, multiple sub-categories), N-10 (assembly — 8 upstream deps, cross-cutting), DELTA-CHECK (terminal gate), PR-REVIEW (terminal gate) |

---

## Master Dispatch Table

| Status | Batch | Worker | Task | Model | Depends On | PRDs to Attach | Notes |
|--------|-------|--------|------|-------|------------|----------------|-------|
| ✅ | 1 | N-01 | Scaffold output structure & FORMAT_SPEC | CODEX-HIGH | — | TaskSpec | Foundation — all workers depend on FORMAT_SPEC |
| ✅ | 2 | N-02 | Map `src/hub/` (32 files, ~11K LOC) | CODEX-XHIGH | N-01 | TaskSpec, FORMAT_SPEC | Largest module; core routing logic |
| ✅ | 2 | N-03 | Map `src/interface/` (11 files, ~3.5K LOC) | CODEX-HIGH | N-01 | TaskSpec, FORMAT_SPEC | Includes slash command registry |
| ✅ | 2 | N-04 | Map `src/shared/` (27 files, ~7.5K LOC) | CODEX-XHIGH | N-01 | TaskSpec, FORMAT_SPEC | Group by sub-category; stream parsers section |
| ✅ | 2 | N-05 | Map `src/agents/` (7 files, ~2.5K LOC) | CODEX | N-01 | TaskSpec, FORMAT_SPEC | 4 agent providers; straightforward |
| ✅ | 2 | N-06 | Map `src/monitor/` (7 files, ~1.5K LOC) | CODEX | N-01 | TaskSpec, FORMAT_SPEC | Small module |
| ✅ | 2 | N-07 | Map `src/web/` (9 files, ~2.5K LOC) | CODEX | N-01 | TaskSpec, FORMAT_SPEC | REST + WebSocket endpoints table |
| ✅ | 2 | N-08 | Map `src/bin/` (2 files, ~1.5K LOC) | CODEX | N-01 | TaskSpec, FORMAT_SPEC | CLI command registry |
| ✅ | 2 | N-09 | Map root `src/` files (4 files) | CODEX | N-01 | TaskSpec, FORMAT_SPEC | Zod schemas + config keys |
| ✅ | 3 | N-10 | Assemble SYSTEM_INDEX.md | CODEX-XHIGH | N-02,N-03,N-04,N-05,N-06,N-07,N-08,N-09 | TaskSpec, FORMAT_SPEC | Reads all module files; builds index + overview |
| ✅ | Ω | DELTA-CHECK | Delta Check & Corrective Dispatch | CODEX-XHIGH | N-01,N-02,N-03,N-04,N-05,N-06,N-07,N-08,N-09,N-10 | TaskSpec | One pass only; validated 2026-04-09 with no corrective workers appended |
| ⬜ | Ω | PR-REVIEW | PR Alignment Review | CODEX-XHIGH | DELTA-CHECK | TaskSpec | Terminal gate; human merges |

---

## Batch Execution Details

### Batch 1 — Scaffold (1 worker)
- **Workers**: N-01 (CODEX-HIGH)
- **Priority**: P0
- **Completion gate**: `FORMAT_SPEC.md` + `SYSTEM_INDEX.md` header + `modules/` dir exist
- **Agent notes**: This is foundation. Do not proceed to Batch 2 until N-01 is `✅`.

### Batch 2 — Module Mapping (8 workers, parallel)
- **Workers**: N-02 (CODEX-XHIGH), N-03 (CODEX-HIGH), N-04 (CODEX-XHIGH), N-05 (CODEX), N-06 (CODEX), N-07 (CODEX), N-08 (CODEX), N-09 (CODEX)
- **Priority**: P0 (N-02, N-03, N-04), P1 (N-05..N-09)
- **Completion gate**: All 8 `modules/*.md` files exist and follow FORMAT_SPEC.md
- **Agent notes**: All 8 workers are fully independent and can run in parallel. Each reads FORMAT_SPEC.md once, then scans its assigned `src/` directory. No worker touches another worker's module file.

### Batch 3 — Assembly (1 worker)
- **Workers**: N-10 (CODEX-XHIGH)
- **Priority**: P0
- **Completion gate**: `SYSTEM_INDEX.md` fully populated with overview, module table, dependency graph, usage instructions
- **Agent notes**: Must read ALL 8 module files. Produces the single entry-point file that agents will read first.

### Batch Ω — Terminal (2 workers, sequential)
- **Workers**: DELTA-CHECK (CODEX-XHIGH) → PR-REVIEW (CODEX-XHIGH)
- **Priority**: P0
- **Completion gate**: Both reports written; final verdict explicit

---

## PM Flags Summary

| # | Flag | Resolution | Affects |
|---|------|------------|---------|
| 1 | Test file documentation depth | List existence only, not individual test functions | N-02..N-09 |
| 2 | Non-TypeScript files (HTML/CSS/JS) in web | Document key functions/pages, skip CSS details | N-07 |
| 3 | Soft-delete granularity for removed files | File-level soft-delete only, not per-function | All module workers on re-run |

---

## Completion Tracking

| Batch | Started | Completed | Report Files |
|-------|---------|-----------|--------------|
| 1 | — | — | `dev_history/v1_round/N-01_report.md` |
| 2 | — | — | `dev_history/v1_round/N-02_report.md` through `N-09_report.md` |
| 3 | — | — | `dev_history/v1_round/N-10_report.md` |
| Ω | — | — | `dev_history/v1_round/delta_check_report.md`, `dev_history/v1_round/pr_review_report.md` |

---

## Delta Check Findings

**Checked By**: `DELTA-CHECK`
**Checked At**: `2026-04-09T11:40:49+09:00`
**Outcome**: `✅ Aligned`
**Corrective Dispatch**: None. This one-pass review did not add any corrective worker rows.

| Worker | Verdict | Notes |
|--------|---------|-------|
| N-01 | ✅ Aligned | `FORMAT_SPEC.md`, `SYSTEM_INDEX.md`, and the module scaffold exist and still satisfy the Batch 1 contract. |
| N-02 | ✅ Aligned | `hub.md` documents all 47 live exported symbols from `src/hub/`, includes file coverage notes for `index.ts`, and retains required test inventory. |
| N-03 | ✅ Aligned | `interface.md` covers all 28 live exports and includes the required slash-command registry plus test-file section. |
| N-04 | ✅ Aligned | `shared.md` covers all 64 live exports, includes the required stream parser registry, and remains aligned despite a hidden local probe file that exports nothing. |
| N-05 | ✅ Aligned | `agents.md` covers all 19 live exports, documents all four providers, and preserves per-provider env-var notes. |
| N-06 | ✅ Aligned | `monitor.md` covers all 13 live exports and the required monitor-focused test inventory. |
| N-07 | ✅ Aligned | `web.md` still matches the live `src/web/` surface, including endpoint inventory, frontend pages, and shared browser helpers; current local `terminal.html` edits are CSS-only. |
| N-08 | ✅ Aligned | `bin.md` covers both CLI source files, all 8 live exports, and the required command registry. |
| N-09 | ✅ Aligned | `root.md` covers all 84 live exports and includes both required inventories for Zod schemas and config keys. |
| N-10 | ✅ Aligned | `SYSTEM_INDEX.md` contains all 8 module rows, matches module summaries and last-scanned metadata, and its dependency graph matches the module dependency bullets. |
