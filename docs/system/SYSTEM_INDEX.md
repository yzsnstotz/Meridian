# Meridian System Index

**Status**: Updated by `R-07` on `2026-05-05` after the caller-registry round added the caller identity subsystem, new `/api/callers*` routes, and built-in caller bootstrap across all process surfaces. `[UPDATED 2026-05-05]`
**Purpose**: This is the level-0 routing document for Meridian. Read this file first, then drill into `docs/system/modules/<module>.md` for function-level detail.
**Format Contract**: Follow [FORMAT_SPEC.md](./FORMAT_SPEC.md). This index summarizes the completed module docs and routes agents to the smallest relevant subset of the codebase.
**Coverage**: `8` modules indexed from `docs/system/modules/*.md`, representing `314` documented exports.
**Indexed Modules**: `hub`, `interface`, `shared`, `agents`, `monitor`, `web`, `bin`, `root`

## Overview

Meridian is a multi-surface agent orchestration system centered on the `hub` module.
The primary ingress surfaces are `interface` for Telegram/webhook traffic, `web` for the authenticated browser UI, and `bin` for the JSON-first CLI.
Those surfaces converge on `hub`, which owns thread lifecycle, IPC routing, persisted history, pane streaming, and reply delivery across channels.
`interface` is the chat-first bridge: it turns slash commands, picker interactions, and Telegram callbacks into the normalized hub messages that drive execution.
`agents` contains provider-specific process builders for Claude, Codex, Gemini, and Cursor, which `hub` uses to launch and manage worker sessions.
`monitor` tracks live thread progress over SSE and heartbeat fallbacks so long-running sessions can be observed without polling every provider directly.
`shared` is the reusable utility layer for IPC, stream parsing, approvals, model catalog lookup, caller-wire helpers, and UI/Telegram helpers that multiple subsystems import. New in the caller-registry round: `src/shared/caller-bootstrap.ts` (built-in key derivation, `BUILTIN_CALLERS`) and `src/shared/caller-wire.ts` (IPC wire envelope, HTTP header constants, `wrapHubMessage`/`unwrapWireFrame`). `[UPDATED 2026-05-05]`
`root` is the shared contract and infrastructure layer: schemas, runtime config, logging, and log-retention primitives used across the repo. New in the caller-registry round: `CallerIdentitySchema` in `src/types.ts`, `MERIDIAN_INTERNAL_BOOTSTRAP_KEY` and `MERIDIAN_CALLER_KEYS` env vars in `src/config.ts`. `[UPDATED 2026-05-05]`
All inbound IPC frames and HTTP API calls are now authenticated through the caller registry embedded in `hub` (`src/hub/caller-registry.ts`). Each surface process (`meridian-web`, `meridian-cli`, `meridian-telegram`, `meridian-monitor`) derives a built-in caller key at boot from `MERIDIAN_INTERNAL_BOOTSTRAP_KEY`; external callers use keys minted through the admin API (`/api/callers*`, `meridian caller mint`). `[ADDED 2026-05-05]`
This split keeps ingress surfaces thin while concentrating orchestration, persistence, and provider control inside `hub`.
The current documentation set covers `314` exports in total, with the deepest reusable surfaces in `root` (`86`), `shared` (`77`), and `hub` (`62`).
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
| [hub](./modules/hub.md) | `src/hub/` | Core hub orchestration for IPC routing, agent lifecycle, persisted conversation state, pane streaming, and multi-channel result delivery; `index.ts` boots `HubServer` and log retention. Caller registry (`src/hub/caller-registry.ts`) and auth middleware added in this round. | `[UPDATED 2026-05-05]` | `2026-05-05T00:00:00+09:00` |
| [interface](./modules/interface.md) | `src/interface/` | Telegram ingress, slash-command parsing, interactive picker flows, webhook/long-poll startup, and channel adapters that bridge interface events to hub messages and outbound replies. IPC sender now wraps every outbound frame in the caller-wire envelope. | `[UPDATED 2026-05-05]` | `2026-05-05T00:00:00+09:00` |
| [shared](./modules/shared.md) | `src/shared/` | Shared transport adapters, stream parsers, approval and output normalization, provider model discovery, caller-wire IPC helpers, and Telegram/UI helpers reused by the hub, interface, and agent lifecycle layers. New: `caller-bootstrap.ts`, `caller-wire.ts`. | `[UPDATED 2026-05-05]` | `2026-05-05T00:00:00+09:00` |
| [agents](./modules/agents.md) | `src/agents/` | Provider-specific CLI configs and argument builders for spawning or streaming Claude, Codex, Gemini, and Cursor agents through the hub bridge. | `[ADDED 2026-04-08T15:27:00+09:00]` | `2026-04-16T12:00:00+09:00` |
| [monitor](./modules/monitor.md) | `src/monitor/` | Monitor event schemas, logger/reporter helpers, and the background service that tracks agent threads over SSE with heartbeat fallback. Boot path now derives the `meridian-monitor` caller key and authenticates IPC. | `[UPDATED 2026-05-05]` | `2026-05-05T00:00:00+09:00` |
| [web](./modules/web.md) | `src/web/` | Authenticated HTTP and WebSocket endpoints plus static hub, terminal, and bridge pages for spawning agents, browsing logs and files, editing working trees, and streaming pane output. New `/api/callers*` admin routes, caller admin panel, and chat bubble caller attribution added. | `[UPDATED 2026-05-05]` | `2026-05-05T00:00:00+09:00` |
| [bin](./modules/bin.md) | `src/bin/` | JSON-first CLI command dispatch for spawning and controlling Meridian agent threads through Meridian's authenticated HTTP API boundary, plus CLI-side API helpers for reachability and request shaping. New `meridian caller` subcommand and caller-aware `list`/`history` added. | `[UPDATED 2026-05-05]` | `2026-05-05` |
| [root](./modules/root.md) | `src/` | Root-level runtime contracts, environment configuration, logging factories, and log retention helpers shared across Meridian subsystems. New `CallerIdentitySchema`, `BUILT_IN_INTENTS` extended, `MERIDIAN_INTERNAL_BOOTSTRAP_KEY` env var added. | `[UPDATED 2026-05-05]` | `2026-05-05T00:00:00+09:00` |

## Dependency Graph

This adjacency list is derived from the `**Dependencies**` bullets in the module detail files and collapses root-level imports such as `types`, `config`, `logger`, and `log-retention` into the `root` module.

- `agents` -> `root`
- `bin` -> `root`, `shared`
- `hub` -> `agents`, `interface`, `monitor`, `root`, `shared`
- `interface` -> `hub`, `root`, `shared`
- `monitor` -> `root`, `shared`
- `root` -> None
- `shared` -> `root`
- `web` -> `interface`, `root`, `shared` `[UPDATED 2026-05-05]`

## How to Use This Index

1. Read this file first to understand the repository at module level.
2. Identify which module or modules match the task surface area.
3. Read only the relevant `docs/system/modules/<name>.md` files.
4. Use the file:line references inside module files to jump into implementation quickly.
5. When a task spans multiple surfaces, start with the ingress module (`interface`, `web`, or `bin`), then follow the dependency graph toward `hub`, `shared`, and `root`.
