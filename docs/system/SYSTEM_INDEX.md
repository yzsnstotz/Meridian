# Meridian System Index

**Status**: Assembled by `N-10` on `2026-04-08T15:27:00+09:00`
**Purpose**: This is the level-0 routing document for Meridian. Read this file first, then drill into `docs/system/modules/<module>.md` for function-level detail.
**Format Contract**: Follow [FORMAT_SPEC.md](./FORMAT_SPEC.md). This index summarizes the completed module docs and routes agents to the smallest relevant subset of the codebase.
**Coverage**: `8` modules indexed from `docs/system/modules/*.md`, representing `277` documented exports.
**Indexed Modules**: `hub`, `interface`, `shared`, `agents`, `monitor`, `web`, `bin`, `root`

## Overview

Meridian is a multi-surface agent orchestration system centered on the `hub` module.
The primary ingress surfaces are `interface` for Telegram/webhook traffic, `web` for the authenticated browser UI, and `bin` for the JSON-first CLI.
Those surfaces converge on `hub`, which owns thread lifecycle, IPC routing, persisted history, pane streaming, and reply delivery across channels.
`agents` contains provider-specific process builders for Claude, Codex, Gemini, and Cursor, which `hub` uses to launch and manage worker sessions.
`monitor` tracks live thread progress over SSE and heartbeat fallbacks so long-running sessions can be observed without polling every provider directly.
`shared` is the reusable utility layer for IPC, stream parsing, approvals, model catalog lookup, and UI/Telegram helpers that multiple subsystems import.
`root` is the shared contract and infrastructure layer: schemas, runtime config, logging, and log-retention primitives used across the repo.
The current documentation set covers `277` exports in total, with the deepest reusable surfaces in `root` (`84`), `shared` (`64`), and `hub` (`47`).
Read this file as the level-0 routing view, then open only the module detail files that match the task surface area.

```text
Telegram / Webhooks      Browser UI            CLI
        |                    |                 |
        v                    v                 v
   `interface`            `web`              `bin`
         \                  |                  /
          \                 |                 /
           +----------------v----------------+
                            `hub`
                      /       |        \
                     v        v         v
                 `agents` `monitor`  replies/events

Support layers used across the flow:
`shared` -> transport, parsers, approvals, model catalog
`root` -> config, schemas, logging, retention
```

## Module Table

These eight module docs cover the current routing surfaces, orchestration core, shared utilities, and repo-wide contracts. The largest documentation surfaces are `root`, `shared`, and `hub`.

| Module | Path | Summary | Status | Last Scanned |
|--------|------|---------|--------|--------------|
| [hub](./modules/hub.md) | `src/hub/` | Core hub orchestration for IPC routing, agent lifecycle, persisted conversation state, pane streaming, and multi-channel result delivery; `index.ts` boots `HubServer` and log retention. | `[ADDED 2026-04-08T15:27:00+09:00]` | `2026-04-08T14:10:55+09:00` |
| [interface](./modules/interface.md) | `src/interface/` | Telegram ingress, slash-command parsing, interactive picker flows, webhook/long-poll startup, and channel adapters that bridge interface events to hub messages and outbound replies. | `[ADDED 2026-04-08T15:27:00+09:00]` | `2026-04-08T14:23:07+09:00` |
| [shared](./modules/shared.md) | `src/shared/` | Shared transport adapters, stream parsers, approval and output normalization, provider model discovery, and Telegram/UI helpers reused by the hub, interface, and agent lifecycle layers. | `[ADDED 2026-04-08T15:27:00+09:00]` | `2026-04-08T14:28:58+09:00` |
| [agents](./modules/agents.md) | `src/agents/` | Provider-specific CLI configs and argument builders for spawning or streaming Claude, Codex, Gemini, and Cursor agents through the hub bridge. | `[ADDED 2026-04-08T15:27:00+09:00]` | `2026-04-08T14:37:36+09:00` |
| [monitor](./modules/monitor.md) | `src/monitor/` | Monitor event schemas, logger/reporter helpers, and the background service that tracks agent threads over SSE with heartbeat fallback. | `[ADDED 2026-04-08T15:27:00+09:00]` | `2026-04-08T14:44:32+09:00` |
| [web](./modules/web.md) | `src/web/` | Authenticated HTTP and WebSocket endpoints plus static hub, terminal, and bridge pages for spawning agents, browsing logs and files, editing working trees, and streaming pane output. | `[ADDED 2026-04-08T15:27:00+09:00]` | `2026-04-08T14:50:33+09:00` |
| [bin](./modules/bin.md) | `src/bin/` | JSON-first CLI command dispatch for spawning and controlling Meridian agent threads, plus transport helpers that probe hub HTTP first and fall back to the Unix socket. | `[ADDED 2026-04-08T15:27:00+09:00]` | `2026-04-08T14:58:32+09:00` |
| [root](./modules/root.md) | `src/` | Root-level runtime contracts, environment configuration, logging factories, and log retention helpers shared across Meridian subsystems. | `[ADDED 2026-04-08T15:27:00+09:00]` | `2026-04-08T15:06:30+09:00` |

## Dependency Graph

This adjacency list is derived from the `**Dependencies**` bullets in the module detail files and collapses root-level imports such as `types`, `config`, `logger`, and `log-retention` into the `root` module.

- `agents` -> `root`
- `bin` -> `root`, `shared`
- `hub` -> `agents`, `interface`, `monitor`, `root`, `shared`
- `interface` -> `hub`, `root`, `shared`
- `monitor` -> `root`, `shared`
- `root` -> None
- `shared` -> `root`
- `web` -> `interface`, `root`

## How to Use This Index

1. Read this file first to understand the repository at module level.
2. Identify which module or modules match the task surface area.
3. Read only the relevant `docs/system/modules/<name>.md` files.
4. Use the file:line references inside module files to jump into implementation quickly.
5. When a task spans multiple surfaces, start with the ingress module (`interface`, `web`, or `bin`), then follow the dependency graph toward `hub`, `shared`, and `root`.
