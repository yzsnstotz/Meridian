# bin
**Source**: `src/bin/`
**Summary**: JSON-first CLI command dispatch for spawning and controlling Meridian agent threads through Meridian's authenticated HTTP API boundary, plus CLI-side API helpers for reachability and request shaping.
**Last Scanned**: 2026-04-16T12:30:00+09:00
**Exports Documented**: 7

`src/bin/meridian-cli.ts` does manual argument parsing instead of using a command framework. Operational commands emit structured JSON on stdout, help text is written to stderr, and failures are normalized into exit codes `0`, `1`, `2`, `3`, and `4`.

## CLI Command Registry

Global flags: `--help` prints root or per-command usage, and `--json` is accepted but ignored because JSON stdout is already the default. Every real subcommand goes through `ensureHubReachable()` before dispatch, so API reachability is the CLI's only public connectivity gate.

| Command | Usage | Options / Inputs | Meridian behavior | Key refs |
|--------|------|---------|--------|--------------|
| `spawn` | `meridian spawn [agent-type] [options]` | Optional positional provider plus `--provider`, `--model`, `--effort`, `--workdir`, `--auto-approve`, `--no-auto-approve`, `--mode` | Defaults the provider to `claude`, validates provider and reasoning effort through Zod-backed schemas, normalizes `a2a` and `agentapi` into bridge mode, then posts a structured JSON body to `/api/spawn` with optional model, effort, spawn directory, and auto-approve overrides. | `src/bin/meridian-cli.ts:103`, `src/bin/meridian-cli.ts:451`, `src/bin/meridian-cli.ts:642` |
| `models` | `meridian models <provider>` | Positional provider or `--provider` | Lists the local provider model catalog for pre-spawn selection while still sharing the CLI's top-level API reachability gate. | `src/bin/meridian-cli.ts:116`, `src/bin/meridian-cli.ts:481`, `src/bin/meridian-cli.ts:642` |
| `kill` | `meridian kill <thread-id>` | Exactly one thread ID | Posts `{ thread_id }` to `/api/kill` and returns `{ "ok": true }` on success. | `src/bin/meridian-cli.ts:120`, `src/bin/meridian-cli.ts:497`, `src/bin/meridian-cli.ts:642` |
| `status` | `meridian status` | No command-specific options | Reads `/api/instances`, then reshapes each live instance into `{ thread_id, type, model, status, uptime }` using the current clock and `created_at`. | `src/bin/meridian-cli.ts:123`, `src/bin/meridian-cli.ts:508`, `src/bin/meridian-cli.ts:642` |
| `send` | `meridian send <thread-id> <message>` | One thread ID plus a non-empty message string | Posts `{ thread_id, content, attachments: [] }` to `/api/run` and treats `success`, `partial`, and `timeout` API-backed hub statuses as acceptable CLI outcomes. | `src/bin/meridian-cli.ts:126`, `src/bin/meridian-cli.ts:528`, `src/bin/meridian-cli.ts:642` |
| `logs` | `meridian logs <thread-id>` | Exactly one thread ID | Reads `/api/history?thread_id=...`, then normalizes the returned history entries into a stable `{ id, event_kind, source, type, content, raw_content, timestamp }` shape for scripts. | `src/bin/meridian-cli.ts:129`, `src/bin/meridian-cli.ts:558`, `src/bin/meridian-cli.ts:642` |
| `autoapprove` | `meridian autoapprove <on|off|status> [--thread <id>]` | Action plus optional `--thread` selector | Resolves an explicit thread or the single active instance through `/api/instances`, reads `/api/autoapprove` for status, and posts `{ thread_id, enabled }` to `/api/autoapprove` for updates. | `src/bin/meridian-cli.ts:132`, `src/bin/meridian-cli.ts:589`, `src/bin/meridian-cli.ts:642` |
| `health` | `meridian health` | No command-specific options | Reads `/api/health` and emits the structured API payload directly; it does not fall back to raw socket or local uptime inference. | `src/bin/meridian-cli.ts:135`, `src/bin/meridian-cli.ts:627`, `src/bin/meridian-cli.ts:642` |

## Exports

**src/bin/hub-connection.ts**

### `HubConnection`
- **File**: `src/bin/hub-connection.ts:12`
- **Purpose**: Describes the verified Meridian API endpoint metadata returned to CLI callers after reachability checks.
- **Implementation**: The interface carries the configured HTTP base URL, whether a bearer token is configured for outbound API requests, and the fixed `"http"` transport discriminator. `connectToHub()` returns this shape so callers can reason about the verified public boundary without importing server internals.
- **Dependencies**: None
- **Status**: `[UPDATED 2026-04-16T12:30:00+09:00]`

### `HubHttpResponse`
- **File**: `src/bin/hub-connection.ts:21`
- **Purpose**: Types the parsed response envelope used by CLI HTTP health checks and future REST calls.
- **Implementation**: The shape preserves the numeric status code, raw Node HTTP headers, and a parsed `unknown` body so higher-level CLI code can pass through JSON payloads without losing transport metadata.
- **Dependencies**: None
- **Status**: `[UPDATED 2026-04-16T12:30:00+09:00]`

### `connectToHub(): Promise<HubConnection>`
- **File**: `src/bin/hub-connection.ts:27`
- **Purpose**: Verifies that the Meridian API boundary is reachable before the CLI dispatches a command.
- **Implementation**: The function probes `MERIDIAN_HTTP` by requesting `/api/health` with the resolved bearer token, treating any HTTP response as proof that the public API boundary is live. If that request cannot connect or times out, it throws a Meridian API reachability error that `runCli()` converts into the CLI's unreachable exit code.
- **Dependencies**: None
- **Status**: `[UPDATED 2026-04-16T12:30:00+09:00]`

### `hubHttpRequest(method: string, path: string, body?: unknown): Promise<HubHttpResponse>`
- **File**: `src/bin/hub-connection.ts:40`
- **Purpose**: Sends an authenticated HTTP request to Meridian and returns a parsed response envelope.
- **Implementation**: The helper resolves the route against `MERIDIAN_HTTP`, strips any `?token=` query from the base URL before building request URLs, reuses either `WEB_GUI_TOKEN` or the `MERIDIAN_HTTP` query token as a bearer token, adds JSON headers only when a body is present, enforces a `10s` timeout, and parses the response body as JSON when possible before falling back to raw text.
- **Dependencies**: None
- **Status**: `[UPDATED 2026-04-16T12:30:00+09:00]`

**src/bin/meridian-cli.ts**

### `CliDependencies`
- **File**: `src/bin/meridian-cli.ts:43`
- **Purpose**: Defines the injected API transport, clock, and output hooks that make the CLI runner testable.
- **Implementation**: The interface bundles Meridian API reachability and request helpers, provider model lookup, the current-time callback, and stdout/stderr writers. `runCli()` and the command handlers use this contract so tests can substitute fake API behavior without forking the process.
- **Dependencies**: `bin/hub-connection`, `types`
- **Status**: `[UPDATED 2026-04-16T12:30:00+09:00]`

### `defaultCliDependencies`
- **File**: `src/bin/meridian-cli.ts:63`
- **Purpose**: Provides the production dependency bundle used by the standalone CLI entrypoint.
- **Implementation**: The constant wires in the exported Meridian API helpers, local provider model catalog lookup, the real clock, and direct stdout/stderr writers. The local `main()` function passes this bundle into `runCli()` when the file is executed as a script.
- **Dependencies**: `bin/hub-connection`
- **Status**: `[UPDATED 2026-04-16T12:30:00+09:00]`

### `runCli(args: string[], deps: CliDependencies = defaultCliDependencies): Promise<number>`
- **File**: `src/bin/meridian-cli.ts:642`
- **Purpose**: Implements the top-level CLI command router for Meridian's local control surface.
- **Implementation**: The function handles root help, rejects unknown commands, prints per-command usage when `--help` is present, verifies Meridian API reachability, and dispatches to the specific spawn, kill, status, send, logs, auto-approve, or health handler. Public operational commands now use only structured HTTP responses from Meridian's API boundary, while uncaught failures are converted into `CliError` instances so the script entrypoint can return stable exit codes and machine-readable error bodies.
- **Dependencies**: `bin/hub-connection`, `types`
- **Status**: `[UPDATED 2026-04-16T12:30:00+09:00]`

## Test Files

- `src/bin/hub-connection.test.ts`
- `src/bin/meridian-cli.test.ts`
