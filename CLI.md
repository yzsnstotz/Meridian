# Meridian CLI

`meridian` is the external CLI for the Meridian hub. It emits machine-readable JSON on stdout and reserves stderr for usage text and operator hints.

## Install

```bash
cd /Users/yzliu/work/Meridian
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
| `MERIDIAN_SOCKET` | `/tmp/hub-core.sock` | CLI socket fallback when HTTP is unavailable |
| `MERIDIAN_HTTP` | `http://localhost:3000` | CLI HTTP endpoint for Meridian web API |
| `AGENT_WORKDIR` | parent of repo root | Default workdir for spawned agents and initial root for GUI repo picking |
| `HUB_SOCKET_PATH` | `/tmp/hub-core.sock` | Meridian hub socket path used by the service |
| `WEB_GUI_PORT` | `3000` | Web API / GUI port |
| `WEB_GUI_HOST` | unset | Optional public GUI host |

## Commands

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
meridian spawn codex --model gpt-5.4 --workdir /Users/yzliu/work/Meridian --auto-approve
meridian spawn claude --model claude-opus-4-6 --workdir /Users/yzliu/work/project --no-auto-approve
meridian spawn gemini --mode bridge --workdir /Users/yzliu/work/sandbox
meridian spawn codex --mode stateless_call --workdir /Users/yzliu/work/Meridian
```

### `meridian kill <thread-id>`

Terminate a running thread.

Example:

```bash
meridian kill codex_01
```

### `meridian status`

List running Meridian-managed instances.

Example:

```bash
meridian status
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
meridian spawn codex --model gpt-5.4 --workdir /Users/yzliu/work/Meridian --auto-approve
```

Run a fresh, non-resuming Codex call lane:

```bash
meridian spawn codex --mode stateless_call --workdir /Users/yzliu/work/Meridian
meridian send codex_01 "Summarize the public API surface."
```

Check live threads, send follow-up input, then inspect logs:

```bash
meridian status
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
