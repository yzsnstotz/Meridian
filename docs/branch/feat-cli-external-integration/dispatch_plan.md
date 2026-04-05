# Dispatch Plan: Meridian + Meridian-Roles External CLI Integration

- **Version**: v1.0
- **Date**: 2026-04-05
- **Branch**: `feat-cli-external-integration`
- **TaskSpec**: `/Users/yzliu/work/Meridian/docs/branch/feat-cli-external-integration/taskspec.md`

---

## PRD Reference Paths

| Shorthand | Full Path |
|-----------|-----------|
| CLI Integration PRD | `/Users/yzliu/work/Meridian/docs/branch/feat-cli-external-integration/prd.md` |
| TaskSpec | `/Users/yzliu/work/Meridian/docs/branch/feat-cli-external-integration/taskspec.md` |

---

## Model Assignment Legend

| Model | Code | Provider | Model ID | Assign When |
|-------|------|----------|----------|-------------|
| Codex | `CODEX` | `codex` | `gpt-5.4 medium` | Well-specified schema work, surgical edits, config/template generation, straightforward tool implementations, simple CRUD |
| Codex High | `CODEX-HIGH` | `codex` | `gpt-5.4 high` | Standard coordination tasks, moderate integration, pre-flight/environment checks, prompt builders, 2-3 touchpoints |
| Codex XHigh | `CODEX-XHIGH` | `codex` | `gpt-5.4 xhigh` | IPC/async/socket coordination, multi-file architectural integration, session lifecycle, terminal review gates (DELTA-CHECK, PR-REVIEW), 4+ dependencies |

---

## Master Dispatch Table

| Status | Batch | Worker | Task | Model | Depends On | PRDs to Attach | Notes |
|--------|-------|--------|------|-------|------------|----------------|-------|
| ✅ | 0 | PRE-FLIGHT | Environment Health Check | CODEX-HIGH | — | — | Build baseline for both repos; gates all workers |
| ✅ | 1 | N-01 | Meridian CLI Entry Point & Scaffold | CODEX-XHIGH | — | CLI Integration PRD | Architect CLI structure + command routing |
| ✅ | 1 | R-01 | Meridian Auto-Approve Default Change | CODEX | — | CLI Integration PRD | 3 files, straightforward default swap |
| ✅ | 1 | R-03 | Meridian-roles Bin Registration | CODEX | — | CLI Integration PRD | package.json + shebang only |
| ⬜ | 2 | N-02 | Meridian CLI Commands Implementation | CODEX-XHIGH | N-01 | CLI Integration PRD | All 7 commands; largest single worker |
| 🔄 | 2 | N-04 | Meridian-roles Resume Worker Tool | CODEX-XHIGH | R-03 | CLI Integration PRD | New tool + API endpoint + LifecycleStore integration |
| ⬜ | 2 | N-05 | Meridian-roles Dispatch-Status, List-Roles, Health | CODEX-HIGH | R-03 | CLI Integration PRD | 3 new tools, read-only operations |
| ⬜ | 3 | R-02 | Meridian Provider/Model Spawn Enhancement | CODEX-HIGH | N-02 | CLI Integration PRD | Spawn API extension + modelId verification |
| ⬜ | 3 | N-06 | Meridian-roles Dispatch-Start Tool | CODEX-XHIGH | R-03, N-05 | CLI Integration PRD | model-map parsing + dispatch session start |
| ⬜ | 3 | R-04 | Meridian-roles GUI Resume Buttons & Stale Viz | CODEX-XHIGH | N-04 | CLI Integration PRD | GUI changes + stale badge rendering |
| ⬜ | 4 | R-05 | Meridian-roles Dispatch Provider/Model Pass-Through | CODEX-XHIGH | R-02, N-06 | CLI Integration PRD | Model Legend parsing + spawn integration |
| ⬜ | 4 | N-03 | Meridian CLI Docs & Install Skill | CODEX | N-02, R-01, R-02 | CLI Integration PRD | 2 doc files; depends on CLI being finalized |
| ⬜ | 4 | N-07 | Meridian-roles CLI Docs & Install Skill | CODEX | N-04, N-05, N-06, R-04 | CLI Integration PRD | 2 doc files; depends on all roles tools |
| ⬜ | 5 | R-06 | taskspec Skill Update | CODEX | R-02, R-05 | CLI Integration PRD | Model Legend + Dispatch Command template update |
| ⬜ | Ω | DELTA-CHECK | Delta Check & Corrective Dispatch | CODEX-XHIGH | N-01, R-01, R-03, N-02, N-04, N-05, R-02, N-06, R-04, R-05, N-03, N-07, R-06 | TaskSpec, CLI Integration PRD | One pass only |
| ⬜ | Ω+1 | PR-REVIEW | PR Alignment Review | CODEX-XHIGH | DELTA-CHECK | TaskSpec, CLI Integration PRD | Terminal gate; human merges |

---

## Batch Execution Details

### Batch 0 — Pre-Flight

- **Workers**: PRE-FLIGHT
- **Priority**: P0 (gates all subsequent batches)
- **Model**: CODEX-HIGH
- **Agent Notes**: Verify both repos build cleanly on `feat-cli-external-integration` branch. Check `.env` and Node.js version. If any check fails → `⛔ BLOCKED`, halt dispatch.
- **Completion Gate**: PRE-FLIGHT `✅`

### Batch 1 — Foundation

- **Workers**: N-01, R-01, R-03
- **Priority**: P0
- **Models**: N-01=CODEX-XHIGH, R-01=CODEX, R-03=CODEX
- **Agent Notes**:
  - N-01 is the largest — CLI scaffold with command routing, service connection utility, package.json bin field. Needs CODEX-XHIGH for architecture decisions.
  - R-01 is a straightforward 3-file default swap (types.ts, server.ts, index.html). CODEX-suitable.
  - R-03 is a single-file package.json edit + shebang check. CODEX-suitable.
  - All three are independent — run in parallel.
- **Completion Gate**: All 3 workers `✅`

### Batch 2 — Core CLI Commands & Tools

- **Workers**: N-02, N-04, N-05
- **Priority**: N-02=P0, N-04=P0, N-05=P1
- **Models**: N-02=CODEX-XHIGH, N-04=CODEX-XHIGH, N-05=CODEX-HIGH
- **Agent Notes**:
  - N-02 is the heaviest worker — 7 CLI commands wiring into hub via socket/HTTP. Each command must handle the service-unreachable case (exit 3).
  - N-04 creates resume-worker with 3 actions (retry/skip/force-complete) + API endpoint. Must integrate with LifecycleStore and kill tool.
  - N-05 creates 3 read-only tools. Simpler than N-04 but still needs understanding of dispatch_threads.json schema.
  - N-02 depends on N-01 (CLI scaffold). N-04 and N-05 depend on R-03 (bin registration).
- **Completion Gate**: All 3 workers `✅`

### Batch 3 — Provider/Model & GUI

- **Workers**: R-02, N-06, R-04
- **Priority**: R-02=P0, N-06=P1, R-04=P1
- **Models**: R-02=CODEX-HIGH, N-06=CODEX-XHIGH, R-04=CODEX-XHIGH
- **Agent Notes**:
  - R-02 extends Meridian spawn API with `provider` field and verifies modelId flow. Must be backward compatible.
  - N-06 creates dispatch-start tool with model-map parsing (two formats). Depends on N-05 for dispatch-status integration.
  - R-04 adds GUI buttons and stale visualization. Pure frontend + API integration. Depends on N-04's resume endpoint.
  - **PM Flag PF-1**: model-map accepts both comma-separated and JSON file formats.
- **Completion Gate**: All 3 workers `✅`

### Batch 4 — Integration & Documentation

- **Workers**: R-05, N-03, N-07
- **Priority**: R-05=P0, N-03=P1, N-07=P1
- **Models**: R-05=CODEX-XHIGH, N-03=CODEX, N-07=CODEX
- **Agent Notes**:
  - R-05 is the critical cross-repo integration — dispatcher must parse new Model Legend and pass provider/model to Meridian spawn. CODEX-XHIGH required.
  - N-03 and N-07 are documentation workers. Must wait for all CLI commands to be finalized before writing docs.
  - N-03 depends on N-02 (Meridian CLI), R-01 (auto-approve behavior), R-02 (provider/model).
  - N-07 depends on N-04, N-05, N-06 (all new tools) and R-04 (GUI features to document).
- **Completion Gate**: All 3 workers `✅`

### Batch 5 — External Skill Update

- **Workers**: R-06
- **Priority**: P1
- **Model**: CODEX
- **Agent Notes**:
  - Updates taskspec skill at `/Users/yzliu/work/skills/taskspec/SKILL.md` — external to this repo.
  - Depends on R-02 and R-05 to know the final provider/model API contract.
  - Template changes only — no code logic.
  - **⚠️ Note**: This file is outside the Meridian repo. Agent must `cd /Users/yzliu/work/skills/taskspec/` and commit separately or use `git add -f` if tracked in Meridian repo.
- **Completion Gate**: R-06 `✅`

### Batch Ω — Delta Check

- **Workers**: DELTA-CHECK
- **Model**: CODEX-XHIGH
- **Agent Notes**: Run `git diff main..HEAD`, verify all acceptance criteria. One pass only. Append corrective workers if ≤5 findings.
- **Completion Gate**: DELTA-CHECK `✅` (all workers aligned or corrective workers complete)

### Batch Ω+1 — PR Review

- **Workers**: PR-REVIEW
- **Model**: CODEX-XHIGH
- **Agent Notes**: Full PR diff review against PRD and TaskSpec. Human merges.
- **Completion Gate**: PR-REVIEW `✅` with `MERGE APPROVED` or `MERGE BLOCKED`

---

## PM Flags Summary

| # | Flag | Scope | Resolution |
|---|------|-------|------------|
| PF-1 | `--model-map` format: comma-separated vs JSON | N-06 | Accept both: `--model-map "K=p:m,..."` and `--model-map-file <json>` |
| PF-2 | Stale threshold: fixed 30min or per-type | N-05, R-04 | Fixed 30min default; `--stale-threshold` CLI override |
| PF-3 | Install method: `npm link` vs `npm install -g` | N-03, N-07 | Default `npm link`; document both |
| PF-4 | Gemini/Cursor auto-approve support | R-02 | Pass flag to all providers; provider adapter decides if honored |

---

## Completion Tracking

| Batch | Started | Completed | Report Files |
|-------|---------|-----------|--------------|
| 0 | — | — | `dev_history/v1_round/PRE-FLIGHT_report.md` |
| 1 | — | — | `dev_history/v1_round/N-01_report.md`, `R-01_report.md`, `R-03_report.md` |
| 2 | — | — | `dev_history/v1_round/N-02_report.md`, `N-04_report.md`, `N-05_report.md` |
| 3 | — | — | `dev_history/v1_round/R-02_report.md`, `N-06_report.md`, `R-04_report.md` |
| 4 | — | — | `dev_history/v1_round/R-05_report.md`, `N-03_report.md`, `N-07_report.md` |
| 5 | — | — | `dev_history/v1_round/R-06_report.md` |
| Ω | — | — | `dev_history/v1_round/delta_check_report.md` |
| Ω+1 | — | — | `dev_history/v1_round/pr_review_report.md` |

All reports written to: `/Users/yzliu/work/Meridian/docs/branch/feat-cli-external-integration/dev_history/v1_round/`
Corrective worker reports (if needed): `/Users/yzliu/work/Meridian/docs/branch/feat-cli-external-integration/dev_history/v1_round_delta/`











































