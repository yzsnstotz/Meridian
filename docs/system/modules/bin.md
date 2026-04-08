# bin
**Source**: `src/bin/`
**Summary**: JSON-first CLI command dispatch for spawning and controlling Meridian agent threads, plus transport helpers that probe hub HTTP first and fall back to the Unix socket.
**Last Scanned**: 2026-04-08T14:58:32+09:00
**Exports Documented**: 8

`src/bin/meridian-cli.ts` does manual argument parsing instead of using a command framework. Operational commands emit structured JSON on stdout, help text is written to stderr, and failures are normalized into exit codes `0`, `1`, `2`, `3`, and `4`.

## CLI Command Registry

Global flags: `--help` prints root or per-command usage, and `--json` is accepted but ignored because JSON stdout is already the default. Every real subcommand goes through `ensureHubReachable()` before dispatch.

| Command | Usage | Options / Inputs | Meridian behavior | Key refs |
|--------|------|---------|--------|--------------|
| `spawn` | `meridian spawn [agent-type] [options]` | Optional positional provider plus `--provider`, `--model`, `--effort`, `--workdir`, `--auto-approve`, `--no-auto-approve`, `--mode` | Defaults the provider to `claude`, validates provider and reasoning effort through Zod-backed schemas, normalizes `a2a` and `agentapi` into bridge mode, then sends socket `intent: "spawn"` with optional model, effort, spawn directory, and auto-approve overrides. | `src/bin/meridian-cli.ts:128`, `src/bin/meridian-cli.ts:422`, `src/bin/meridian-cli.ts:655` |
| `kill` | `meridian kill <thread-id>` | Exactly one thread ID | Sends socket `intent: "kill"` targeting the provided thread and returns `{ "ok": true }` on success. | `src/bin/meridian-cli.ts:142`, `src/bin/meridian-cli.ts:458`, `src/bin/meridian-cli.ts:659` |
| `status` | `meridian status` | No command-specific options | Uses the global socket `list` query, then reshapes each live instance into `{ thread_id, type, model, status, uptime }` using the current clock and `created_at`. | `src/bin/meridian-cli.ts:145`, `src/bin/meridian-cli.ts:478`, `src/bin/meridian-cli.ts:662` |
| `send` | `meridian send <thread-id> <message>` | One thread ID plus a non-empty message string | Sends socket `intent: "run"` with the joined message content and treats `success`, `partial`, and `timeout` hub statuses as acceptable CLI outcomes. | `src/bin/meridian-cli.ts:148`, `src/bin/meridian-cli.ts:495`, `src/bin/meridian-cli.ts:665` |
| `logs` | `meridian logs <thread-id>` | Exactly one thread ID | Sends socket `intent: "history"`, JSON-parses the returned array, and normalizes each entry into a stable `{ id, event_kind, source, type, content, raw_content, timestamp }` shape for scripts. | `src/bin/meridian-cli.ts:151`, `src/bin/meridian-cli.ts:526`, `src/bin/meridian-cli.ts:668` |
| `autoapprove` | `meridian autoapprove <on|off|status> [--thread <id>]` | Action plus optional `--thread` selector | Resolves an explicit thread or the single active instance, uses the list payload for `status`, and otherwise sends socket `intent: "set_auto_approve"` with `"true"` or `"false"` as the content payload. | `src/bin/meridian-cli.ts:154`, `src/bin/meridian-cli.ts:565`, `src/bin/meridian-cli.ts:671` |
| `health` | `meridian health` | No command-specific options | Tries `GET /api/health` over HTTP first; if that fails, it falls back to the socket `list` query plus local socket-file uptime inference and package version reporting. | `src/bin/meridian-cli.ts:157`, `src/bin/meridian-cli.ts:608`, `src/bin/meridian-cli.ts:674` |

## Exports

**src/bin/hub-connection.ts**

### `HubConnection`
- **File**: `src/bin/hub-connection.ts:19`
- **Purpose**: Describes the verified hub endpoint metadata returned to CLI callers after transport discovery.
- **Implementation**: The interface carries the configured HTTP base URL, the optional Unix socket path, and the transport discriminator that says whether HTTP or the socket probe succeeded. `connectToHub()` returns this shape so callers can log or branch on the verified transport without importing hub internals.
- **Dependencies**: None
- **Status**: `[ADDED 2026-04-08T14:58:32+09:00]`

### `HubHttpResponse`
- **File**: `src/bin/hub-connection.ts:28`
- **Purpose**: Types the parsed response envelope used by CLI HTTP health checks and future REST calls.
- **Implementation**: The shape preserves the numeric status code, raw Node HTTP headers, and a parsed `unknown` body so higher-level CLI code can pass through JSON payloads without losing transport metadata.
- **Dependencies**: None
- **Status**: `[ADDED 2026-04-08T14:58:32+09:00]`

### `connectToHub(): Promise<HubConnection>`
- **File**: `src/bin/hub-connection.ts:38`
- **Purpose**: Verifies that the Meridian hub is reachable before the CLI dispatches a command.
- **Implementation**: The function probes `MERIDIAN_HTTP` first by requesting `/api/health`, then falls back to a raw socket connect on `MERIDIAN_SOCKET`. If both probes fail it throws a transport summary error that `runCli()` later converts into the CLI's unreachable exit code.
- **Dependencies**: None
- **Status**: `[ADDED 2026-04-08T14:58:32+09:00]`

### `hubHttpRequest(method: string, path: string, body?: unknown): Promise<HubHttpResponse>`
- **File**: `src/bin/hub-connection.ts:65`
- **Purpose**: Sends an HTTP request to the hub and returns a parsed response envelope.
- **Implementation**: The helper resolves the route against `MERIDIAN_HTTP`, adds JSON headers only when a body is present, enforces a `10s` timeout, and parses the response body as JSON when possible before falling back to raw text. This is used directly by the CLI `health` command before any socket fallback.
- **Dependencies**: None
- **Status**: `[ADDED 2026-04-08T14:58:32+09:00]`

### `hubSocketRequest(message: HubMessage): Promise<HubResult>`
- **File**: `src/bin/hub-connection.ts:116`
- **Purpose**: Sends one hub IPC request over the Unix socket and validates the reply shape.
- **Implementation**: The function delegates transport details to `sendIpcRequest()` and then parses the returned payload with `HubResultSchema` so callers always receive a schema-validated hub result instead of unchecked JSON.
- **Dependencies**: `shared/ipc`, `types`
- **Status**: `[ADDED 2026-04-08T14:58:32+09:00]`

**src/bin/meridian-cli.ts**

### `CliDependencies`
- **File**: `src/bin/meridian-cli.ts:45`
- **Purpose**: Defines the injected transport, clock, version, and output hooks that make the CLI runner testable.
- **Implementation**: The interface bundles hub connection functions, a socket-uptime probe, package version, current-time callback, and stdout/stderr writers. `runCli()` and the command handlers use this contract so tests can substitute fake hub behavior without forking the process.
- **Dependencies**: `bin/hub-connection`, `types`
- **Status**: `[ADDED 2026-04-08T14:58:32+09:00]`

### `defaultCliDependencies`
- **File**: `src/bin/meridian-cli.ts:66`
- **Purpose**: Provides the production dependency bundle used by the standalone CLI entrypoint.
- **Implementation**: The constant wires in the exported hub connection helpers, the env-derived default socket path, a package version discovered from `package.json`, the real clock, and direct stdout/stderr writers. The local `main()` function passes this bundle into `runCli()` when the file is executed as a script.
- **Dependencies**: `bin/hub-connection`
- **Status**: `[ADDED 2026-04-08T14:58:32+09:00]`

### `runCli(args: string[], deps: CliDependencies = defaultCliDependencies): Promise<number>`
- **File**: `src/bin/meridian-cli.ts:637`
- **Purpose**: Implements the top-level CLI command router for Meridian's local control surface.
- **Implementation**: The function handles root help, rejects unknown commands, prints per-command usage when `--help` is present, verifies hub reachability, and dispatches to the specific spawn, kill, status, send, logs, auto-approve, or health handler. Each handler emits JSON output, while uncaught failures are converted into `CliError` instances so the script entrypoint can return stable exit codes and machine-readable error bodies.
- **Dependencies**: `bin/hub-connection`, `types`
- **Status**: `[ADDED 2026-04-08T14:58:32+09:00]`

## Test Files

- None discovered during scan.
