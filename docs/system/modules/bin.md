# bin
**Source**: `src/bin/`
**Summary**: JSON-first CLI command dispatch for spawning and controlling Meridian agent threads through Meridian's authenticated HTTP API boundary, plus CLI-side API helpers for reachability and request shaping.
**Last Scanned**: 2026-05-05
**Exports Documented**: 7

`src/bin/meridian-cli.ts` does manual argument parsing instead of using a command framework. Operational commands emit structured JSON on stdout, help text is written to stderr, and failures are normalized into exit codes `0`, `1`, `2`, `3`, and `4`.

## CLI Command Registry

Global flags: `--help` prints root or per-command usage, and `--json` is accepted but ignored because JSON stdout is already the default for most commands. Every real subcommand goes through `ensureHubReachable()` before dispatch, so API reachability is the CLI's only public connectivity gate.

| Command | Usage | Options / Inputs | Meridian behavior | Key refs |
|--------|------|---------|--------|--------------|
| `spawn` | `meridian spawn [agent-type] [options]` | Optional positional provider plus `--provider`, `--model`, `--effort`, `--workdir`, `--auto-approve`, `--no-auto-approve`, `--mode` | Defaults the provider to `claude`, validates provider and reasoning effort through Zod-backed schemas, normalizes `a2a` and `agentapi` into bridge mode, then posts a structured JSON body to `/api/spawn` with optional model, effort, spawn directory, and auto-approve overrides. | `src/bin/meridian-cli.ts:103`, `src/bin/meridian-cli.ts:451`, `src/bin/meridian-cli.ts:642` |
| `models` | `meridian models <provider>` | Positional provider or `--provider` | Lists the local provider model catalog for pre-spawn selection while still sharing the CLI's top-level API reachability gate. | `src/bin/meridian-cli.ts:116`, `src/bin/meridian-cli.ts:481`, `src/bin/meridian-cli.ts:642` |
| `kill` | `meridian kill <thread-id>` | Exactly one thread ID | Posts `{ thread_id }` to `/api/kill` and returns `{ "ok": true }` on success. | `src/bin/meridian-cli.ts:120`, `src/bin/meridian-cli.ts:497`, `src/bin/meridian-cli.ts:642` |
| `list` | `meridian list [--json]` | Optional `--json` flag | Without `--json`: prints a human-readable table of live instances with a `caller=<id>@<HH:MM>Z` column derived from `last_caller`/`last_caller_at`; shows `(none)` when absent. With `--json`: emits `{ ok, instances }` passing through all API fields including `spawned_by`, `last_caller`, and `last_caller_at` without filtering. | `src/bin/meridian-cli.ts` [ADDED 2026-05-05] |
| `status` | `meridian status` | No command-specific options | Reads `/api/instances`, then reshapes each live instance into `{ thread_id, type, model, status, uptime }` using the current clock and `created_at`. | `src/bin/meridian-cli.ts:123`, `src/bin/meridian-cli.ts:508`, `src/bin/meridian-cli.ts:642` |
| `send` | `meridian send <thread-id> <message>` | One thread ID plus a non-empty message string | Posts `{ thread_id, content, attachments: [] }` to `/api/run` and treats `success`, `partial`, and `timeout` API-backed hub statuses as acceptable CLI outcomes. | `src/bin/meridian-cli.ts:126`, `src/bin/meridian-cli.ts:528`, `src/bin/meridian-cli.ts:642` |
| `logs` | `meridian logs <thread-id>` | Exactly one thread ID | Reads `/api/history?thread_id=...`, then normalizes the returned history entries into a stable `{ id, event_kind, source, type, content, raw_content, timestamp }` shape for scripts. | `src/bin/meridian-cli.ts:129`, `src/bin/meridian-cli.ts:558`, `src/bin/meridian-cli.ts:642` |
| `history` | `meridian history <thread-id> [--json]` | Exactly one thread ID; optional `--json` flag | Like `logs` but includes `caller_id` and `caller_label` per entry; `--json` is stripped before thread-ID extraction so the flag does not interfere with positional parsing. Always emits JSON. | `src/bin/meridian-cli.ts` [ADDED 2026-05-05] |
| `autoapprove` | `meridian autoapprove <on|off|status> [--thread <id>]` | Action plus optional `--thread` selector | Resolves an explicit thread or the single active instance through `/api/instances`, reads `/api/autoapprove` for status, and posts `{ thread_id, enabled }` to `/api/autoapprove` for updates. | `src/bin/meridian-cli.ts:132`, `src/bin/meridian-cli.ts:589`, `src/bin/meridian-cli.ts:642` |
| `health` | `meridian health` | No command-specific options | Reads `/api/health` and emits the structured API payload directly; it does not fall back to raw socket or local uptime inference. | `src/bin/meridian-cli.ts:135`, `src/bin/meridian-cli.ts:627`, `src/bin/meridian-cli.ts:642` |
| `caller list` | `meridian caller list [--json]` | Optional `--json` | Without `--json`: prints a human-readable table of all registered callers (`id`, `label`, `kind`, `created_at`, `last_seen_at`, `status`). With `--json`: emits the raw `/api/callers` array. | `src/bin/meridian-cli.ts` [ADDED 2026-05-05] |
| `caller mint` | `meridian caller mint --id <kebab-id> --label <label>` | `--id` (required, `^[a-z][a-z0-9_-]*$`), `--label` (required) | Validates `--id` client-side, posts `{ caller_id, caller_label }` to `POST /api/callers`, then prints `caller_id`, `caller_key`, and a one-time-copy warning to stdout only. `--write-env` is rejected (PM Blocker #2 deferred). | `src/bin/meridian-cli.ts` [ADDED 2026-05-05] |
| `caller rotate` | `meridian caller rotate --id <kebab-id> [--yes]` | `--id` (required), `--yes` to skip confirmation | Prompts for confirmation unless `--yes`; posts to `POST /api/callers/:id/rotate`; prints new `caller_key` to stdout with one-time-copy warning. Built-ins return a server error surfaced by the CLI. | `src/bin/meridian-cli.ts` [ADDED 2026-05-05] |
| `caller revoke` | `meridian caller revoke --id <kebab-id> [--yes]` | `--id` (required), `--yes` to skip confirmation | Prompts for confirmation unless `--yes`; sends `DELETE /api/callers/:id`; prints `revoked_at`. Built-ins return a server error surfaced by the CLI. | `src/bin/meridian-cli.ts` [ADDED 2026-05-05] |

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

### `setCallerIdentity(args: CallerIdentitySetterArgs): void`
- **File**: `src/bin/hub-connection.ts:45`
- **Purpose**: Registers the caller identity used by every subsequent `hubHttpRequest` and `connectToHub` call.
- **Implementation**: Validates `caller_id` / `caller_key` / `caller_label` (all required; empty rejected with `caller_identity_required`) plus optional `caller_version`, and stores them on a module-private slot. `clearCallerIdentity` resets the slot for tests; `hasCallerIdentity` reports whether the CLI is ready to make HTTP calls. Header names follow the canonical case mandated by the wire contract: `X-Meridian-Caller-Id`, `X-Meridian-Caller-Key`, `X-Meridian-Caller-Version`.
- **Dependencies**: `shared/caller-wire`
- **Status**: `[ADDED 2026-05-05]`

### `connectToHub(): Promise<HubConnection>`
- **File**: `src/bin/hub-connection.ts:65`
- **Purpose**: Verifies that the Meridian API boundary is reachable before the CLI dispatches a command.
- **Implementation**: Probes `MERIDIAN_HTTP` by requesting `/api/health` with the resolved bearer token plus the registered caller-identity headers, treating any HTTP response as proof that the public API boundary is live. If that request cannot connect or times out, it throws a Meridian API reachability error that `runCli()` converts into the CLI's unreachable exit code.
- **Dependencies**: `shared/caller-wire`
- **Status**: `[UPDATED 2026-05-05]`

### `hubHttpRequest(method: string, path: string, body?: unknown): Promise<HubHttpResponse>`
- **File**: `src/bin/hub-connection.ts:78`
- **Purpose**: Sends an authenticated HTTP request to Meridian and returns a parsed response envelope.
- **Implementation**: Resolves the route against `MERIDIAN_HTTP`, strips any `?token=` query from the base URL before building request URLs, reuses either `WEB_GUI_TOKEN` or the `MERIDIAN_HTTP` query token as a bearer token, and **always** stamps `X-Meridian-Caller-Id` + `X-Meridian-Caller-Key` (plus optional `X-Meridian-Caller-Version`) from the registered caller identity — throwing `caller_identity_not_set` if `setCallerIdentity` has not run. Adds JSON headers only when a body is present, enforces a `10s` timeout, and parses the response body as JSON when possible before falling back to raw text.
- **Dependencies**: `shared/caller-wire`
- **Status**: `[UPDATED 2026-05-05]`

**src/bin/meridian-cli.ts**

### `CliDependencies`
- **File**: `src/bin/meridian-cli.ts:43`
- **Purpose**: Defines the injected API transport, clock, and output hooks that make the CLI runner testable.
- **Implementation**: The interface bundles Meridian API reachability and request helpers, provider model lookup, the current-time callback, stdout/stderr writers, and a `readLine(prompt) → Promise<string>` hook used by confirmation prompts in `caller rotate` and `caller revoke`. Tests override `readLine` to bypass interactive prompts; `--yes` bypasses it at the call site.
- **Dependencies**: `bin/hub-connection`, `types`
- **Status**: `[UPDATED 2026-05-05]`

### `defaultCliDependencies`
- **File**: `src/bin/meridian-cli.ts:63`
- **Purpose**: Provides the production dependency bundle used by the standalone CLI entrypoint.
- **Implementation**: The constant wires in the exported Meridian API helpers, local provider model catalog lookup, the real clock, and direct stdout/stderr writers. The local `main()` function passes this bundle into `runCli()` when the file is executed as a script. [UPDATED 2026-05-05] `main()` now derives the `meridian-cli` caller key via `deriveBuiltinCallerKey` (from `shared/caller-bootstrap`) and calls `hub-connection`'s `setCallerIdentity` before invoking `runCli()`, so all HTTP requests carry the correct caller identity headers. Throws `bootstrap_key_missing` if `MERIDIAN_INTERNAL_BOOTSTRAP_KEY` is absent.
- **Dependencies**: `bin/hub-connection`, `shared/caller-bootstrap`
- **Status**: `[UPDATED 2026-05-05]`

### `runCli(args: string[], deps: CliDependencies = defaultCliDependencies): Promise<number>`
- **File**: `src/bin/meridian-cli.ts:642`
- **Purpose**: Implements the top-level CLI command router for Meridian's local control surface.
- **Implementation**: The function handles root help, rejects unknown commands, prints per-command usage when `--help` is present, verifies Meridian API reachability, and dispatches to the specific spawn, kill, list, status, send, logs, history, auto-approve, health, or caller handler. The new `list` command is caller-aware; `history` includes `caller_id`/`caller_label` per entry; `caller` dispatches to four subcommands (`list`, `mint`, `rotate`, `revoke`) that hit the `/api/callers*` routes from N-04. Public operational commands use only structured HTTP responses from Meridian's API boundary, while uncaught failures are converted into `CliError` instances so the script entrypoint can return stable exit codes and machine-readable error bodies.
- **Dependencies**: `bin/hub-connection`, `types`
- **Status**: `[UPDATED 2026-05-05]`

## Test Files

- `src/bin/hub-connection.test.ts`
- `src/bin/meridian-cli.test.ts`
