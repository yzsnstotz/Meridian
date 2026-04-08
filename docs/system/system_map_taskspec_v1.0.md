# Meridian System Map — TaskSpec v1.0

**Version**: 1.1
**Date**: 2026-04-08
**Input Documents**: Live codebase at `/Users/yzliu/work/Meridian`
**Purpose**: Generate an AI-agent-optimized routing/sharding documentation system for the Meridian repo — a hierarchical index that lets coding agents understand the system with minimal token usage (read index → route to detail) instead of scanning all files.

---

## Conflict Resolution Rules

> Live codebase > This TaskSpec > Previous documentation output. Any discrepancy between the generated docs and the actual code must defer to the live codebase. If a function exists in code but not in prior docs, it is a **discovery**. If a function exists in prior docs but not in code, it is a **logical deletion** (mark as removed, do not erase).

---

## Key Design Principles

### Routing / Sharding Architecture
The output documentation is a **two-level routing system**:
- **Level 0 — `SYSTEM_INDEX.md`**: Single entry point. Lists every module with a one-line summary and a link to its detail file. An agent reads ONLY this file first to understand the full system and decide which module(s) to drill into.
- **Level 1 — `modules/<module>.md`**: One file per source module. Lists every exported function/class/type with signature, purpose, key implementation notes, and cross-references.

### Iteration-Friendly (Append/Soft-Delete, Never Rewrite)
- **New discoveries**: Appended with `[ADDED <ISO-datetime>]` tag
- **Removed functions**: NOT deleted from docs. Marked with `[REMOVED <ISO-datetime>]` and struck through. This preserves the track record.
- **Modified functions**: Updated in-place with `[UPDATED <ISO-datetime>]` tag
- **First run**: Everything is tagged `[ADDED <ISO-datetime>]`
- **Re-runs**: Agent diffs current code against existing docs, applies only changes

### Timestamp Convention
All actions use ISO 8601 with timezone: `2026-04-08T14:30:00+08:00`

---

## Dispatch Table

| Batch | Worker | Task | Model | Depends On |
|-------|--------|------|-------|------------|
| 1 | N-01 | Scaffold output structure & define format spec | CODEX-HIGH | — |
| 2 | N-02 | Map `src/hub/` module | CODEX-XHIGH | N-01 |
| 2 | N-03 | Map `src/interface/` module | CODEX-HIGH | N-01 |
| 2 | N-04 | Map `src/shared/` module | CODEX-XHIGH | N-01 |
| 2 | N-05 | Map `src/agents/` module | CODEX | N-01 |
| 2 | N-06 | Map `src/monitor/` module | CODEX | N-01 |
| 2 | N-07 | Map `src/web/` module | CODEX | N-01 |
| 2 | N-08 | Map `src/bin/` module | CODEX | N-01 |
| 2 | N-09 | Map root-level source files (`types.ts`, `config.ts`, `logger.ts`, `log-retention.ts`) | CODEX | N-01 |
| 3 | N-10 | Assemble SYSTEM_INDEX.md from all module files | CODEX-XHIGH | N-02..N-09 |
| Ω | DELTA-CHECK | Delta Check & Corrective Dispatch | CODEX-XHIGH | N-01..N-10 |
| Ω | PR-REVIEW | PR Alignment Review | CODEX-XHIGH | DELTA-CHECK |

---

## Worker Definitions

---

### N-01 — Scaffold Output Structure & Define Format Spec

- **Runtime**: Local (bash + write)
- **Delta Type**: NEW
- **Phase**: 0
- **Priority**: P0
- **Depends on**: —

#### Required Context
- Read: `/Users/yzliu/work/Meridian/docs/system/system_map_taskspec_v1.0.md` — Key Design Principles section (for format schema and iteration rules to encode into FORMAT_SPEC.md)
- Write: `/Users/yzliu/work/Meridian/docs/system/FORMAT_SPEC.md`, `/Users/yzliu/work/Meridian/docs/system/SYSTEM_INDEX.md`
- Downstream consumers: N-02, N-03, N-04, N-05, N-06, N-07, N-08, N-09 (all read FORMAT_SPEC.md), N-10 (reads SYSTEM_INDEX.md)
- **Interface lock**: FORMAT_SPEC.md defines the schema contract for all downstream workers. Changes after Batch 1 require re-dispatch.

#### Sub-tasks

**N-01.1 — Create directory structure**
- Create `/Users/yzliu/work/Meridian/docs/system/modules/` directory
- Create placeholder `SYSTEM_INDEX.md` with header and format explanation
- **Key constraint**: If `SYSTEM_INDEX.md` already exists from a prior run, do NOT overwrite. Read it and preserve all existing entries. Only this first-run creates from scratch.
- **Acceptance**: Directory `docs/system/modules/` exists; `SYSTEM_INDEX.md` exists with header

**N-01.2 — Write FORMAT_SPEC.md**
- Create `/Users/yzliu/work/Meridian/docs/system/FORMAT_SPEC.md` defining the exact schema for both index and module files
- Index entry format:
  ```
  | Module | Path | Summary | Status | Last Scanned |
  ```
- Module detail file format:
  ```markdown
  # <module-name>
  **Source**: `src/<path>/`
  **Last Scanned**: <ISO-datetime>

  ## Exports

  ### `functionName(params): ReturnType`
  - **File**: `<filename>.ts:<line>`
  - **Purpose**: <one-line>
  - **Implementation**: <2-3 sentences on key logic>
  - **Dependencies**: <imports from other modules>
  - **Status**: [ADDED|UPDATED|REMOVED <ISO-datetime>]
  ```
- Include rules for iteration: how to handle additions, updates, and soft-deletes
- **Key constraint**: FORMAT_SPEC.md is the single source of truth for all downstream workers. They MUST follow it exactly.
- **Acceptance**: `FORMAT_SPEC.md` exists and contains both index and module schemas plus iteration rules

#### AI Auto-Tests
```bash
test -d /Users/yzliu/work/Meridian/docs/system/modules/ && echo "PASS: modules dir exists" || echo "FAIL"
test -f /Users/yzliu/work/Meridian/docs/system/SYSTEM_INDEX.md && echo "PASS: index exists" || echo "FAIL"
test -f /Users/yzliu/work/Meridian/docs/system/FORMAT_SPEC.md && echo "PASS: format spec exists" || echo "FAIL"
```

#### Human Acceptance Criteria
- `docs/system/modules/` directory created
- `SYSTEM_INDEX.md` has a clear header explaining the routing system
- `FORMAT_SPEC.md` defines iteration rules (add/update/soft-delete with timestamps)

---

### N-02 — Map `src/hub/` Module

- **Runtime**: Local (read + write)
- **Delta Type**: NEW
- **Phase**: 1
- **Priority**: P0
- **Depends on**: N-01

#### Required Context
- Read outputs from N-01: `/Users/yzliu/work/Meridian/docs/system/FORMAT_SPEC.md`
- Read all `.ts` files in: `/Users/yzliu/work/Meridian/src/hub/` (32 files, ~11K LOC — largest module)
- If re-run: read existing `/Users/yzliu/work/Meridian/docs/system/modules/hub.md` for diff-based iteration

#### Sub-tasks

**N-02.1 — Scan all files in `src/hub/`**
- Read every `.ts` file in `/Users/yzliu/work/Meridian/src/hub/` (excluding `.test.ts` files from the main listing, but note their existence)
- For each file: identify all exported functions, classes, types, and constants
- Record: name, signature, file:line, purpose (from JSDoc or inferred), key implementation details
- **Key constraint**: Follow FORMAT_SPEC.md exactly. Every entry tagged `[ADDED <ISO-datetime>]` on first run. If `docs/system/modules/hub.md` already exists, diff against it — only add new, update changed, soft-delete missing.
- **Acceptance**: `docs/system/modules/hub.md` exists with all exports from `src/hub/` documented

**N-02.2 — Document cross-module dependencies**
- For each export in hub, note which other `src/` modules it imports from
- Format as `**Dependencies**: shared/ipc, types, config` etc.
- **Acceptance**: Every function entry has a Dependencies line

**N-02.3 — Note test coverage**
- List which `.test.ts` files exist for this module as a section at the bottom
- **Acceptance**: Test file listing present at bottom of `hub.md`

#### AI Auto-Tests
```bash
test -f /Users/yzliu/work/Meridian/docs/system/modules/hub.md && echo "PASS" || echo "FAIL"
grep -c "ADDED" /Users/yzliu/work/Meridian/docs/system/modules/hub.md | xargs -I{} echo "Entries found: {}"
grep -q "server.ts" /Users/yzliu/work/Meridian/docs/system/modules/hub.md && echo "PASS: server.ts covered" || echo "FAIL"
grep -q "router.ts" /Users/yzliu/work/Meridian/docs/system/modules/hub.md && echo "PASS: router.ts covered" || echo "FAIL"
```

#### Human Acceptance Criteria
- `hub.md` documents all major exports from `src/hub/`
- Each entry has signature, purpose, implementation notes, dependencies
- All entries timestamped per FORMAT_SPEC.md
- Iteration-safe: re-running the worker on unchanged code produces no diff

---

### N-03 — Map `src/interface/` Module

- **Runtime**: Local (read + write)
- **Delta Type**: NEW
- **Phase**: 1
- **Priority**: P0
- **Depends on**: N-01

#### Required Context
- Read outputs from N-01: `/Users/yzliu/work/Meridian/docs/system/FORMAT_SPEC.md`
- Read all `.ts` files in: `/Users/yzliu/work/Meridian/src/interface/` (including `adapters/` subdirectory)
- If re-run: read existing `/Users/yzliu/work/Meridian/docs/system/modules/interface.md` for diff-based iteration

#### Sub-tasks

**N-03.1 — Scan all files in `src/interface/`**
- Read every `.ts` file in `/Users/yzliu/work/Meridian/src/interface/` (excluding test files)
- Including `adapters/` subdirectory
- Document all exports: functions, classes, types, slash command handlers
- **Key constraint**: Follow FORMAT_SPEC.md. Tag all entries `[ADDED <ISO-datetime>]`. If `modules/interface.md` exists, diff and apply incremental changes only.
- **Acceptance**: `docs/system/modules/interface.md` exists with all exports documented

**N-03.2 — Document slash command registry**
- Special section listing all slash commands (`/spawn`, `/kill`, `/status`, etc.) with their handler functions and descriptions
- **Acceptance**: Slash command table present in `interface.md`

**N-03.3 — Cross-module dependencies and test coverage**
- Dependencies for each export; test file listing at bottom
- **Acceptance**: Dependencies and test section present

#### AI Auto-Tests
```bash
test -f /Users/yzliu/work/Meridian/docs/system/modules/interface.md && echo "PASS" || echo "FAIL"
grep -q "slash" /Users/yzliu/work/Meridian/docs/system/modules/interface.md && echo "PASS: slash commands covered" || echo "FAIL"
```

#### Human Acceptance Criteria
- `interface.md` covers all exports from `src/interface/`
- Slash command registry section is comprehensive
- All entries timestamped, iteration-safe

---

### N-04 — Map `src/shared/` Module

- **Runtime**: Local (read + write)
- **Delta Type**: NEW
- **Phase**: 1
- **Priority**: P0
- **Depends on**: N-01

#### Required Context
- Read outputs from N-01: `/Users/yzliu/work/Meridian/docs/system/FORMAT_SPEC.md`
- Read all `.ts` files in: `/Users/yzliu/work/Meridian/src/shared/` (including `stream-parsers/` subdirectory, 27 files, ~7.5K LOC)
- If re-run: read existing `/Users/yzliu/work/Meridian/docs/system/modules/shared.md` for diff-based iteration

#### Sub-tasks

**N-04.1 — Scan all files in `src/shared/`**
- Read every `.ts` file in `/Users/yzliu/work/Meridian/src/shared/` including `stream-parsers/` subdirectory
- Document all exports per FORMAT_SPEC.md
- **Key constraint**: This is the largest shared module (~27 files). Group exports by sub-category: IPC & Communication, Streaming & Parsing, Business Logic, Utilities
- **Acceptance**: `docs/system/modules/shared.md` exists with grouped exports

**N-04.2 — Document stream parser registry**
- Special section for `stream-parsers/`: each parser (claude, codex, gemini, ndjson) with input/output format and key parsing logic
- **Acceptance**: Stream parser section present with all 4 parsers documented

**N-04.3 — Cross-module dependencies and test coverage**
- **Acceptance**: Dependencies and test section present

#### AI Auto-Tests
```bash
test -f /Users/yzliu/work/Meridian/docs/system/modules/shared.md && echo "PASS" || echo "FAIL"
grep -q "stream-parsers" /Users/yzliu/work/Meridian/docs/system/modules/shared.md && echo "PASS: stream parsers covered" || echo "FAIL"
grep -q "ipc" /Users/yzliu/work/Meridian/docs/system/modules/shared.md && echo "PASS: IPC covered" || echo "FAIL"
```

#### Human Acceptance Criteria
- `shared.md` covers all ~27 files with grouped organization
- Stream parser section is detailed
- All entries timestamped, iteration-safe

---

### N-05 — Map `src/agents/` Module

- **Runtime**: Local (read + write)
- **Delta Type**: NEW
- **Phase**: 1
- **Priority**: P1
- **Depends on**: N-01

#### Sub-tasks

**N-05.1 — Scan all files in `src/agents/`**
- Read `claude.ts`, `codex.ts`, `gemini.ts`, `cursor.ts` and any other `.ts` files
- Document each agent provider: exported class/functions, spawn mechanism, message protocol, configuration
- **Key constraint**: Follow FORMAT_SPEC.md. Each agent entry should note which environment variables it requires.
- **Acceptance**: `docs/system/modules/agents.md` exists with all agent providers documented

**N-05.2 — Cross-module dependencies and test coverage**
- **Acceptance**: Dependencies and test section present

#### AI Auto-Tests
```bash
test -f /Users/yzliu/work/Meridian/docs/system/modules/agents.md && echo "PASS" || echo "FAIL"
for agent in claude codex gemini cursor; do
  grep -q "$agent" /Users/yzliu/work/Meridian/docs/system/modules/agents.md && echo "PASS: $agent covered" || echo "FAIL: $agent missing"
done
```

#### Human Acceptance Criteria
- `agents.md` documents all 4 agent providers
- Each provider includes env var requirements
- All entries timestamped

---

### N-06 — Map `src/monitor/` Module

- **Runtime**: Local (read + write)
- **Delta Type**: NEW
- **Phase**: 1
- **Priority**: P1
- **Depends on**: N-01

#### Sub-tasks

**N-06.1 — Scan all files in `src/monitor/`**
- Read all `.ts` files, document exports per FORMAT_SPEC.md
- **Acceptance**: `docs/system/modules/monitor.md` exists with all exports documented

**N-06.2 — Cross-module dependencies and test coverage**
- **Acceptance**: Dependencies and test section present

#### AI Auto-Tests
```bash
test -f /Users/yzliu/work/Meridian/docs/system/modules/monitor.md && echo "PASS" || echo "FAIL"
```

#### Human Acceptance Criteria
- `monitor.md` covers all exports from `src/monitor/`
- All entries timestamped

---

### N-07 — Map `src/web/` Module

- **Runtime**: Local (read + write)
- **Delta Type**: NEW
- **Phase**: 1
- **Priority**: P1
- **Depends on**: N-01

#### Sub-tasks

**N-07.1 — Scan all files in `src/web/`**
- Read `server.ts` and all files under `public/` (JS, HTML, CSS)
- Document: server endpoints (REST + WebSocket), frontend pages, key client-side functions
- **Key constraint**: For HTML/JS/CSS files, document the key functions and page purposes rather than line-by-line
- **Acceptance**: `docs/system/modules/web.md` exists with server and frontend documented

**N-07.2 — Document API endpoints**
- Special section listing all HTTP routes and WebSocket events
- **Acceptance**: Endpoint table present

**N-07.3 — Cross-module dependencies and test coverage**
- **Acceptance**: Dependencies and test section present

#### AI Auto-Tests
```bash
test -f /Users/yzliu/work/Meridian/docs/system/modules/web.md && echo "PASS" || echo "FAIL"
grep -q "endpoint" /Users/yzliu/work/Meridian/docs/system/modules/web.md && echo "PASS: endpoints covered" || echo "FAIL"
```

#### Human Acceptance Criteria
- `web.md` covers server endpoints and frontend pages
- API endpoint table is comprehensive
- All entries timestamped

---

### N-08 — Map `src/bin/` Module

- **Runtime**: Local (read + write)
- **Delta Type**: NEW
- **Phase**: 1
- **Priority**: P1
- **Depends on**: N-01

#### Sub-tasks

**N-08.1 — Scan all files in `src/bin/`**
- Read `meridian-cli.ts`, `hub-connection.ts`
- Document CLI commands, flags, and connection utilities
- **Acceptance**: `docs/system/modules/bin.md` exists with CLI commands documented

**N-08.2 — Document CLI command registry**
- Special section listing all CLI subcommands (spawn, kill, status, send, logs, health, autoapprove) with options
- **Acceptance**: CLI command table present

#### AI Auto-Tests
```bash
test -f /Users/yzliu/work/Meridian/docs/system/modules/bin.md && echo "PASS" || echo "FAIL"
grep -q "spawn" /Users/yzliu/work/Meridian/docs/system/modules/bin.md && echo "PASS: spawn command covered" || echo "FAIL"
```

#### Human Acceptance Criteria
- `bin.md` covers all CLI commands and their options
- All entries timestamped

---

### N-09 — Map Root-Level Source Files

- **Runtime**: Local (read + write)
- **Delta Type**: NEW
- **Phase**: 1
- **Priority**: P1
- **Depends on**: N-01

#### Sub-tasks

**N-09.1 — Scan root `src/` files**
- Read: `src/types.ts`, `src/config.ts`, `src/logger.ts`, `src/log-retention.ts`
- Document all exported types, schemas (Zod), config keys, and utility functions
- **Key constraint**: `types.ts` contains Zod schemas — document each schema name, fields, and purpose. Do NOT just list "exports Zod schemas."
- **Acceptance**: `docs/system/modules/root.md` exists with all root-level exports documented

**N-09.2 — Document Zod schema registry**
- Special section listing every Zod schema in `types.ts` with field summary
- **Acceptance**: Zod schema table present with field-level detail

**N-09.3 — Document config keys**
- Special section listing every config key from `config.ts` with env var mapping and defaults
- **Acceptance**: Config key table present

#### AI Auto-Tests
```bash
test -f /Users/yzliu/work/Meridian/docs/system/modules/root.md && echo "PASS" || echo "FAIL"
grep -q "types.ts" /Users/yzliu/work/Meridian/docs/system/modules/root.md && echo "PASS: types covered" || echo "FAIL"
grep -q "config.ts" /Users/yzliu/work/Meridian/docs/system/modules/root.md && echo "PASS: config covered" || echo "FAIL"
```

#### Human Acceptance Criteria
- `root.md` covers all 4 root-level files
- Zod schemas documented at field level
- Config keys mapped to env vars
- All entries timestamped

---

### N-10 — Assemble SYSTEM_INDEX.md

- **Runtime**: Local (read + write)
- **Delta Type**: NEW
- **Phase**: 2
- **Priority**: P0
- **Depends on**: N-02, N-03, N-04, N-05, N-06, N-07, N-08, N-09

#### Required Context
- Read outputs from N-01: `/Users/yzliu/work/Meridian/docs/system/FORMAT_SPEC.md`
- Read outputs from N-02..N-09: all files in `/Users/yzliu/work/Meridian/docs/system/modules/` (8 module files)
- Read existing: `/Users/yzliu/work/Meridian/docs/system/SYSTEM_INDEX.md` (for diff-based iteration on re-run)
- Read the TaskSpec: `/Users/yzliu/work/Meridian/docs/system/system_map_taskspec_v1.0.md` — Key Design Principles section (for architecture overview guidance)

#### Sub-tasks

**N-10.1 — Read all module files and build index**
- Read every file in `/Users/yzliu/work/Meridian/docs/system/modules/`
- For each module file: extract module name, source path, one-line summary, number of exports, last scanned timestamp
- **Key constraint**: If `SYSTEM_INDEX.md` already has entries, diff against module files. Add new modules, update changed summaries, soft-delete modules whose source directories no longer exist. Do NOT rewrite from scratch.
- **Acceptance**: `SYSTEM_INDEX.md` contains a row for every module file

**N-10.2 — Add system overview section**
- At the top of `SYSTEM_INDEX.md`, write a 10-15 line overview of Meridian's architecture: what it is, the main data flow (Telegram/Web → Interface → Hub → Agents), and how the modules relate
- Include an ASCII diagram of the message flow
- **Acceptance**: Overview section with architecture summary and flow diagram present

**N-10.3 — Add cross-module dependency graph**
- A section showing which modules depend on which (simplified adjacency list)
- **Acceptance**: Dependency graph section present

**N-10.4 — Add usage instructions for AI agents**
- Section titled "How to Use This Index" explaining:
  1. Read this file first to understand the system
  2. Identify which module(s) are relevant to your task
  3. Read only those `modules/<name>.md` files
  4. Each module file has function-level detail with file:line references
- **Acceptance**: Usage instructions section present

#### AI Auto-Tests
```bash
test -f /Users/yzliu/work/Meridian/docs/system/SYSTEM_INDEX.md && echo "PASS" || echo "FAIL"
# Verify all modules are indexed
for mod in hub interface shared agents monitor web bin root; do
  grep -q "$mod" /Users/yzliu/work/Meridian/docs/system/SYSTEM_INDEX.md && echo "PASS: $mod indexed" || echo "FAIL: $mod missing"
done
# Verify overview section
grep -q "How to Use" /Users/yzliu/work/Meridian/docs/system/SYSTEM_INDEX.md && echo "PASS: usage instructions" || echo "FAIL"
```

#### Human Acceptance Criteria
- `SYSTEM_INDEX.md` has overview, module table, dependency graph, and usage instructions
- Every module from Batch 2 is represented in the index
- An AI agent reading only `SYSTEM_INDEX.md` can understand the full system at a high level
- All entries timestamped, iteration-safe

---

### DELTA-CHECK — Delta Check & Corrective Dispatch

- **Runtime**: Local (git + bash)
- **Delta Type**: REVIEW
- **Phase**: Terminal
- **Priority**: P0
- **Depends on**: N-01, N-02, N-03, N-04, N-05, N-06, N-07, N-08, N-09, N-10

#### Required Context
- Read the entire TaskSpec: `/Users/yzliu/work/Meridian/docs/system/system_map_taskspec_v1.0.md`
- Read all Worker acceptance criteria in the TaskSpec
- Read the full git diff for the branch: `git diff main..feat-cli-external-integration -- docs/system/`
- Read FORMAT_SPEC.md: `/Users/yzliu/work/Meridian/docs/system/FORMAT_SPEC.md`
- Read all module files: `/Users/yzliu/work/Meridian/docs/system/modules/*.md`
- Read SYSTEM_INDEX.md: `/Users/yzliu/work/Meridian/docs/system/SYSTEM_INDEX.md`
- No auto-merge permitted — output a recommendation only

#### Sub-tasks

**DELTA-CHECK.1 — Load acceptance criteria**
- Pull all Worker acceptance criteria from this TaskSpec
- **Acceptance**: Criteria list is complete; no Worker is missing

**DELTA-CHECK.2 — Diff actual output against criteria**
- Run `git diff feat-cli-external-integration` and map changed files to Workers
- Verify `docs/system/FORMAT_SPEC.md` exists and is valid
- Verify `docs/system/SYSTEM_INDEX.md` has all 8 module entries
- Verify each `docs/system/modules/*.md` file follows FORMAT_SPEC.md schema
- Verify all entries have timestamps
- Verify iteration rules are demonstrable (entries tagged correctly)
- **Acceptance**: Every Worker has a verdict (`✅ Aligned` / `⚠️ Drift` / `❌ Missing`)

**DELTA-CHECK.3 — Produce Delta Check Report**
- Write report to `/Users/yzliu/work/Meridian/docs/system/dev_history/v1_round/delta_check_report.md`
- Format: `Worker | Status | Findings | Action Required`
- **Acceptance**: Report file exists; every `⚠️` or `❌` has a concrete action item

**DELTA-CHECK.4 — Corrective dispatch (if findings exist)**
- ≤5 corrective workers → append to dispatch plan
- >5 or new decisions needed → surface to PM
- **This is ONE pass.**
- **Acceptance**: All corrective workers complete; report updated to `✅ Aligned`

#### AI Auto-Tests
```bash
ls -la /Users/yzliu/work/Meridian/docs/system/dev_history/v1_round/delta_check_report.md
grep -E "⚠️|❌" /Users/yzliu/work/Meridian/docs/system/dev_history/v1_round/delta_check_report.md && echo "ISSUES FOUND" || echo "ALL CLEAR"
```

#### Human Acceptance Criteria
- Delta Check Report exists and every Worker has a verdict
- No `⚠️` or `❌` remain after any corrective pass
- All commits pushed to branch

---

### PR-REVIEW — PR Alignment Review

- **Runtime**: Local (git + bash)
- **Delta Type**: REVIEW
- **Phase**: Terminal
- **Priority**: P0
- **Depends on**: DELTA-CHECK `✅`

#### Required Context
- Read the entire TaskSpec: `/Users/yzliu/work/Meridian/docs/system/system_map_taskspec_v1.0.md`
- Read all Worker acceptance criteria in the TaskSpec
- Read the full git diff for the branch: `git diff main..feat-cli-external-integration -- docs/system/`
- Read Delta Check Report: `/Users/yzliu/work/Meridian/docs/system/dev_history/v1_round/delta_check_report.md`
- Read any corrective worker reports in: `/Users/yzliu/work/Meridian/docs/system/dev_history/v1_round_delta/`
- No auto-merge permitted — output a recommendation only

#### Sub-tasks

**PR-REVIEW.1 — Collect review inputs**
- Load: PR diff, this TaskSpec, Delta Check report
- **Acceptance**: All inputs loaded

**PR-REVIEW.2 — Per-file verdict pass**
- Map every changed file in `docs/system/` to its owning Worker
- Check: follows FORMAT_SPEC.md, timestamps present, no stale data
- **Acceptance**: Every changed file has a verdict

**PR-REVIEW.3 — Scope drift summary**
- Assess: are there files outside `docs/system/` that were changed? Are there undocumented modules?
- End with `MERGE APPROVED` or `MERGE BLOCKED — [reason]`
- **Acceptance**: Summary present with explicit verdict

**PR-REVIEW.4 — Write PR Review Report**
- Write to `/Users/yzliu/work/Meridian/docs/system/dev_history/v1_round/pr_review_report.md`
- **Acceptance**: Report exists with final verdict line

#### AI Auto-Tests
```bash
ls -la /Users/yzliu/work/Meridian/docs/system/dev_history/v1_round/pr_review_report.md
grep -E "MERGE APPROVED|MERGE BLOCKED" /Users/yzliu/work/Meridian/docs/system/dev_history/v1_round/pr_review_report.md
```

#### Human Acceptance Criteria
- PR Review Report exists with per-file verdict table
- Final verdict is explicit
- Human reviews before merge

---

## Cross-Worker Integration Points

| Producer | Consumer | Contract |
|----------|----------|----------|
| N-01 (FORMAT_SPEC.md) | N-02..N-09 (all module mappers) | Module mappers read FORMAT_SPEC.md and follow its schema exactly |
| N-02..N-09 (module .md files) | N-10 (SYSTEM_INDEX.md assembler) | N-10 reads all `modules/*.md` files and extracts: module name, source path, summary, export count, last scanned timestamp |
| N-10 (SYSTEM_INDEX.md) | DELTA-CHECK | Delta check validates index completeness against module files |
| All Workers (docs/system/**) | PR-REVIEW | PR review validates all output files against FORMAT_SPEC.md and this TaskSpec |

---

## PM Flags

| # | Flag | Resolution |
|---|------|------------|
| 1 | **Test files**: Should `.test.ts` exports be documented in detail or just listed? | Resolution: List test files at bottom of each module doc. Do NOT document individual test functions — just note file existence and what it tests. |
| 2 | **HTML/CSS/JS files in web/public**: These are not TypeScript — should they follow the same format? | Resolution: Document key functions and page purposes. For JS files, list exported/global functions. For HTML, list page purpose and key DOM IDs. For CSS, skip — just note existence. |
| 3 | **Soft-delete granularity**: If an entire file is removed, soft-delete every function or just the file entry? | Resolution: Soft-delete the file entry in the module doc. Individual functions within a deleted file do not need individual soft-delete markers. |

---

## Changelog

| Version | Date | Change |
|---------|------|--------|
| 1.0 | 2026-04-08 | Initial TaskSpec — all workers assigned OPUS/CODEX |
| 1.1 | 2026-04-08 | Codex reassignment: all OPUS workers reassigned to CODEX-HIGH/CODEX-XHIGH tiers. Added Required Context blocks to all reassigned workers. |
