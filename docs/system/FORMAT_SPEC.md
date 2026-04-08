# FORMAT_SPEC

**Owner**: `N-01`
**Effective**: `2026-04-08T12:29:23+09:00`
**Applies To**: `docs/system/SYSTEM_INDEX.md`, `docs/system/modules/*.md`

## Purpose

This file is the schema contract for the Meridian system map. Batch 2 workers must use it for every module detail file, and Batch 3 must use it when assembling `SYSTEM_INDEX.md`.

## Global Conventions

- Write Markdown only. Do not add frontmatter.
- Preserve existing documentation on re-runs. Edit surgically; do not rewrite a populated file from scratch.
- Use ISO 8601 timestamps with timezone, for example `2026-04-08T14:30:00+09:00`.
- Use repo-relative file references with a line number, for example `src/hub/router.ts:42`.
- Document only behavior visible in the live codebase. Do not infer exports or signatures that are not present in source.
- `**Dependencies**` must list internal Meridian dependencies only. Normalize them as backticked module paths such as `shared/ipc`, `hub/router`, `types`, or `config`. If an export has no internal dependency, write `None`.
- Test coverage is file-level only. List `.test.*` files; do not enumerate individual test cases.
- For `src/web/` non-TypeScript assets, document key HTML/JS entrypoints or pages when relevant. Do not document CSS selector-by-selector.
- First-run ordering should be by source file path, then by line number. On re-runs, preserve existing order and append newly discovered entries to the end of the relevant group.

## Status Tags

- `[ADDED <ISO>]`: first documentation pass for a new row or entry.
- `[UPDATED <ISO>]`: an existing row or entry changed because its signature, behavior, summary, or dependencies changed.
- `[REMOVED <ISO>]`: the source artifact no longer exists. Preserve the historical record; do not delete it.

## `SYSTEM_INDEX.md` Schema

`SYSTEM_INDEX.md` is the level-0 routing file. It must contain these sections in this order:

1. `# Meridian System Index`
2. A short purpose block stating that this file is the entry point for repo navigation
3. `## Overview`
4. `## Module Table`
5. `## Dependency Graph`
6. `## How to Use This Index`

The module table columns must be exactly:

```markdown
| Module | Path | Summary | Status | Last Scanned |
|--------|------|---------|--------|--------------|
```

Row rules:

- `Module`: logical module name matching the module file name, for example `hub`.
- `Path`: source root, for example `src/hub/`.
- `Summary`: one sentence copied from the module file metadata.
- `Status`: one of `[ADDED ...]`, `[UPDATED ...]`, or `[REMOVED ...]`.
- `Last Scanned`: timestamp copied from the module file metadata.
- N-01 may leave placeholder text under the table header. N-10 must preserve the section layout and replace placeholder text with real rows.

`## Dependency Graph` should be a simplified adjacency list, for example:

```markdown
- `interface` -> `hub`, `shared`, `types`
- `hub` -> `shared`, `types`, `config`
```

`## How to Use This Index` must explain:

1. Read this file first.
2. Identify the relevant module or modules.
3. Read only those `docs/system/modules/<name>.md` files.
4. Use the file:line references in module files to jump into implementation.

## Module Detail File Schema

Each module detail file must live at `docs/system/modules/<module>.md`.

Header metadata must appear in this order:

```markdown
# <module-name>
**Source**: `src/<path>/`
**Summary**: <one-sentence module summary>
**Last Scanned**: <ISO timestamp>
**Exports Documented**: <integer>
```

Section order:

1. Optional worker-specific registry or inventory sections required by the TaskSpec
2. `## Exports`
3. `## Test Files`
4. Optional `## Removed Source Files` when a whole source file disappeared on a re-run

Allowed worker-specific section names when the TaskSpec requires them:

- `## Slash Command Registry`
- `## Stream Parser Registry`
- `## Endpoint Inventory`
- `## CLI Command Registry`
- `## Zod Schema Inventory`
- `## Config Key Inventory`
- `## Agent Provider Matrix`

### Export Entry Template

Ungrouped modules should place export entries directly under `## Exports`. Grouped modules may insert bold subgroup labels such as `**IPC & Communication**`, but export headings must remain at the same level.

Use this template for every exported function, class, type, interface, enum, or constant:

```markdown
### `<signature-or-symbol>`
- **File**: `src/<relative-path>:<line>`
- **Purpose**: <one-line explanation>
- **Implementation**: <1-3 sentences on key logic or shape>
- **Dependencies**: <comma-separated internal dependencies or `None`>
- **Status**: `[ADDED <ISO>]`
```

Heading rules:

- Functions: use the callable signature, for example `` `createRouter(options): Router` ``.
- Classes: use the exported class name, for example `` `HubServer` ``.
- Types, interfaces, and enums: use the exported symbol name.
- Constants: use the exported symbol name.
- If the TaskSpec requires extra structured metadata for a module, add extra bullet lines after `**Status**` rather than replacing the five required bullets. Example additions include `**Env Vars**`, `**Schema Fields**`, or `**Routes**`.

Worker-specific registry sections are summaries only. They do not replace the full export entries in `## Exports`.

### `## Test Files`

- List repo-relative test file paths as bullets.
- If none are present, write `- None discovered during scan.`

### `## Removed Source Files`

Use this section only when an entire documented source file is gone on a re-run.

Format:

```markdown
- ~~`src/path/to/file.ts`~~ — `[REMOVED <ISO>]` — previously documented source file no longer exists.
```

The PM resolution applies here: use file-level soft-delete for removed files rather than adding per-export tombstones for every symbol from that file.

If an individual export disappears from a file that still exists, keep the historical entry, strike through the export heading, and set `**Status**` to `[REMOVED <ISO>]`.

## Iteration Protocol

First run:

- Create missing files from scratch.
- Tag every new module row and export entry with `[ADDED <ISO>]`.

Re-runs:

1. Read the existing documentation file before editing.
2. Compare it against the live codebase.
3. Add newly discovered exports or module rows with `[ADDED <ISO>]`.
4. Update changed exports or module rows in place with `[UPDATED <ISO>]`.
5. Preserve removed exports as struck-through historical entries with `[REMOVED <ISO>]`.
6. Record removed source files in `## Removed Source Files`.
7. Leave unchanged content untouched, including its previous timestamp.
8. Update `**Last Scanned**` only when the documentation file itself changes.

## Minimal Examples

Example index table row:

```markdown
| hub | `src/hub/` | Core routing, state, and transport orchestration for worker traffic. | `[ADDED 2026-04-08T14:30:00+09:00]` | `2026-04-08T14:30:00+09:00` |
```

Example export entry:

```markdown
### `createRouter(services): Router`
- **File**: `src/hub/router.ts:18`
- **Purpose**: Builds the request router used by the hub server.
- **Implementation**: Validates incoming route targets, binds service dependencies, and returns a router instance used by the HTTP and IPC layers.
- **Dependencies**: `hub/service-registry`, `shared/ipc`, `types`
- **Status**: `[ADDED 2026-04-08T14:30:00+09:00]`
```
