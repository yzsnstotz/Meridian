# Meridian CLI

`meridian` is the external CLI for the Meridian product. Lifecycle and service
discovery commands work without a running Hub. Agent commands use the Runtime
Web API. The CLI emits machine-readable JSON on stdout and reserves stderr for
usage text and operator hints.

## Install

```bash
cd /path/to/Meridian
npm install
npm run build
npm link
```

After linking, verify the command is available:

```bash
meridian --help
```

## Output Contract

- stdout: JSON only
- stderr: help text, warnings, operator hints
- success shape: `{ "ok": true, ... }`
- error shape: `{ "ok": false, "error": "..." }`

## Exit Codes

| Code | Meaning |
|------|---------|
| `0` | Success |
| `1` | General error |
| `2` | Invalid arguments |
| `3` | Meridian service unreachable |
| `4` | Target thread not found |

## Environment

| Variable | Default | Purpose |
|----------|---------|---------|
| `MERIDIAN_SOCKET` | platform runtime directory | CLI socket fallback when HTTP is unavailable |
| `MERIDIAN_HTTP` | `http://localhost:3000` | CLI HTTP endpoint for Meridian web API |
| `AGENT_WORKDIR` | user home | Default workdir for spawned agents and initial root for GUI repo picking |
| `HUB_SOCKET_PATH` | platform runtime directory | Meridian hub socket path used by the service |
| `WEB_GUI_PORT` | `3000` | Web API / GUI port |
| `WEB_GUI_HOST` | unset | Optional public GUI host |
| `MERIDIAN_CONFIG_DIR` | platform config directory | Config and shared bootstrap-key directory |
| `MERIDIAN_STATE_DIR` | platform state directory | Durable Hub, Orchestrator, and supervisor state |
| `MERIDIAN_RUNTIME_DESCRIPTOR_DIR` | platform runtime directory | Native live service descriptors |
| `MERIDIAN_SERVICE_DECLARATION_DIR` | platform data directory | Native static service declarations |
| `CLAWSO_SERVICE_DECLARATION_DIR` | unset | Clawso Foundation-admitted declaration export |
| `CLAWSO_RUNTIME_DESCRIPTOR_DIR` | unset | Clawso Foundation-admitted runtime-descriptor export |

## Commands

### Native lifecycle

```bash
meridian start
meridian status
meridian doctor
meridian stop
```

The supervisor manages Runtime and Orchestrator as separate processes. Gateway
is deliberately excluded. Registration occurs only after an authenticated
readiness probe succeeds and is removed during shutdown. `status` and `doctor`
do not require Runtime to be reachable.

### Portable service discovery

```bash
meridian service list
meridian service describe org.meridian/runtime
meridian service resolve org.meridian/orchestrator
meridian service doctor
```

Resolution order is explicit URL, service-specific environment, explicit
instance selection, native descriptors, Clawso-admitted descriptors, then
read-only compatibility probes. Discovery does not grant operation permission.

### `meridian spawn <provider> [options]`

Launch an agent instance through Meridian.

Providers:
- `claude`
- `codex`
- `gemini`
- `cursor`

Options:
- `--provider <claude|codex|gemini|cursor>`: explicit provider alias for API payloads
- `--model <model-id>`: override the provider default model
- `--workdir <path>`: absolute working directory; if omitted, Meridian defaults to `AGENT_WORKDIR`
- `--auto-approve`: enable auto-approve
- `--no-auto-approve`: disable auto-approve
- `--mode <bridge|agentapi|pane_bridge|stateless_call>`: transport / execution mode.
  `stateless_call` is Codex-only and runs each request as a fresh `codex exec --json`
  call with read-only sandboxing.

Examples:

```bash
meridian spawn codex --model gpt-5.4 --workdir "$PWD" --auto-approve
meridian spawn claude --model claude-opus-4-6 --workdir "$PWD" --no-auto-approve
meridian spawn gemini --mode bridge --workdir "$PWD"
meridian spawn codex --mode stateless_call --workdir "$PWD"
```

### `meridian models <provider>`

List selectable models for one provider.

Example:

```bash
meridian models codex
```

### `meridian runtime catalog`

Discover the provider/account/model catalog that external integrations can use
to present runtime choices without scraping the Hub UI.

Example:

```bash
meridian runtime catalog
```

The command proxies `GET /api/runtime/catalog` and returns JSON containing:
- `providers[]`: provider id, label, status, account-operation capabilities, visible credentials, default credential id, selectable models, and per-provider error
- `credentials[]`: flattened visible account list with provider, credential id, label, kind, active/revoked status, default flags, host-default flag, and API-key metadata
- `defaults`: provider to selected/default credential id

### `meridian credentials <subcommand>`

Manage credential accounts through the Meridian Web API. Commands emit JSON on
stdout. `credentials api-key` sends the key to the server but never prints the
key value in CLI output.

Subcommands:

```bash
meridian credentials list
meridian credentials oauth-start --label "Work Codex" --mode device
meridian credentials oauth-poll <job-id>
meridian credentials oauth-cancel <job-id>
meridian credentials api-key --label "OpenAI Work" --base-url https://api.openai.com/v1 --model gpt-5.4 --env-var OPENAI_API_KEY --key "$OPENAI_API_KEY"
meridian credentials set-default <credential-id>
meridian credentials revoke <credential-id> --yes
```

### `meridian kill <thread-id>`

Terminate a running thread.

Example:

```bash
meridian kill codex_01
```

### `meridian status --agents`

List running Meridian-managed instances.

Example:

```bash
meridian status --agents
```

### `meridian send <thread-id> <message>`

Send a message into an existing thread.

Examples:

```bash
meridian send codex_01 "Summarize the current repo status."
meridian send claude_02 "Run the test suite and report failures."
```

### `meridian logs <thread-id>`

Fetch the output log stream or retained log history for a thread.

Example:

```bash
meridian logs codex_01
```

### `meridian autoapprove <on|off|status> [--thread <id>]`

Inspect or change auto-approve behavior globally or for a specific thread.

Examples:

```bash
meridian autoapprove status
meridian autoapprove on --thread codex_01
meridian autoapprove off --thread claude_02
```

### `meridian health`

Perform a CLI-level service reachability check against Meridian.

Example:

```bash
meridian health
```

## Typical Flows

Start a worker with explicit provider + model:

```bash
meridian spawn codex --model gpt-5.4 --workdir "$PWD" --auto-approve
```

Discover accounts and models before spawning:

```bash
meridian runtime catalog
meridian spawn codex --model gpt-5.4 --workdir "$PWD" --auto-approve
```

Run a fresh, non-resuming Codex call lane:

```bash
meridian spawn codex --mode stateless_call --workdir "$PWD"
meridian send codex_01 "Summarize the public API surface."
```

Check live threads, send follow-up input, then inspect logs:

```bash
meridian status --agents
meridian send codex_01 "Continue from the last failing test."
meridian logs codex_01
```

Disable auto-approve for a sensitive thread:

```bash
meridian autoapprove off --thread codex_01
```

## Notes

- Meridian CLI talks to the hub through public service interfaces only. It does not import hub internals.
- HTTP is checked first via `MERIDIAN_HTTP`; socket fallback uses `MERIDIAN_SOCKET`.
- External automation should treat stdout as the stable integration surface and ignore stderr unless debugging operator-facing failures.
- Existing standalone Roles state can be copied explicitly with
  `meridian-migrate-roles-state`; see `docs/migration/roles-to-meridian.md`.
