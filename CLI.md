# Meridian-roles CLI

`meridian-roles` is the external CLI for the Meridian role-layer service. It executes tool-gateway tools, writes machine-readable JSON to stdout, and reserves stderr for help text and operator hints.

## Install

```bash
cd /Users/yzliu/work/Meridian/Meridian-roles
npm install
npm run build
npm link
```

Alternative global install flow:

```bash
cd /Users/yzliu/work/Meridian/Meridian-roles
npm install
npm run build
npm install -g .
```

After linking, verify the command is available:

```bash
meridian-roles --help
```

## Usage

```bash
meridian-roles <tool-name> [--param value ...]
```

Flags use kebab-case on the CLI and are translated to the tool's internal snake_case params. Example: `--thread-id` maps to `thread_id`.

Dispatcher runtime prompts prefer the compiled command path `node dist/bin/meridian-tool.js` after `npm run build`. The source `tsx src/bin/meridian-tool.ts` entrypoint is a development fallback only, so long-running dispatcher control should not depend on a `tsx` temp pipe under `/tmp`.

## Output Contract

- stdout: JSON only
- stderr: help text, warnings, operator hints
- success shape: `{ "ok": true, "data": ... }`
- error shape: `{ "ok": false, "error": "..." }`

## Exit Codes

| Code | Meaning |
|------|---------|
| `0` | Success |
| `1` | General CLI, argument, or tool error |
| `3` | Meridian-roles service unreachable for HTTP-backed tools |

Notes:
- `health`, `list-roles`, and `dispatch-start` return exit code `3` when the local Meridian-roles HTTP API is unreachable.
- `kill` always exits `0`; automation should inspect the JSON `ok` field instead of process status alone.

## Environment

The CLI talks to two services:

- Meridian-roles HTTP API for `health`, `list-roles`, and `dispatch-start`
- Meridian hub socket for `spawn`, `run`, `kill`, `notify`, and dispatcher worker execution

| Variable | Default | Purpose |
|----------|---------|---------|
| `MERIDIAN_ROLES_HTTP` | `http://127.0.0.1:${GUI_PORT}` | Base URL for the Meridian-roles HTTP API |
| `GUI_PORT` | `7701` | Default port used when `MERIDIAN_ROLES_HTTP` is unset |
| `GUI_LISTEN_HOST` | unset | Optional HTTP bind host used by the service, for example `127.0.0.1` or `0.0.0.0` |
| `HUB_SOCKET_PATH` | `/tmp/hub-socks/hub-core.sock` | Meridian hub socket path used by hub-backed tools |
| `MERIDIAN_REPLY_CHANNEL` | unset | JSON reply channel for `notify` |
| `MERIDIAN_REPLY_CHANNELS` | unset | JSON array of reply channels for `notify` |
| `ROLES_SOCKET_PATH` | `/tmp/meridian-roles.sock` | Meridian-roles A2A socket path when starting the service locally |
| `STATE_FILE_PATH` | `/var/lib/meridian-roles/state.json` | Persistent role state file for the service |
| `RECONCILE_INTERVAL_MS` | `120000` | Reconciliation interval for stale worker detection |

For local development, prefer a writable state path such as:

```bash
export STATE_FILE_PATH=/tmp/meridian-roles/state.json
```

## Commands

### `spawn`

Launch a coding agent thread through Meridian hub.

Params:
- `--agent-type <type>`: required provider/agent type, for example `codex` or `claude`
- `--mode <bridge|pane_bridge>`: optional bridge mode, default `bridge`
- `--model-id <model-id>`: optional explicit model override
- `--spawn-dir <path>`: optional working directory, defaults to the current working directory
- `--auto-approve <true|false>`: optional Meridian auto-approve flag

Example:

```bash
meridian-roles spawn --agent-type codex --model-id gpt-5.4 --spawn-dir /Users/yzliu/work/Meridian --auto-approve true
```

Typical success payload:

```json
{"ok":true,"data":{"thread_id":"codex_01","agent_type":"codex","mode":"bridge","model_id":"gpt-5.4"}}
```

### `run`

Run a dispatch command file inside an existing thread. This records lifecycle state in the sibling `dispatch_threads.json` file and attempts reconciliation after terminal results.

Params:
- `--thread-id <id>`: required target thread id
- `--command <path>`: required absolute path to the dispatch command file
- `--worker <worker-id>`: required worker id for lifecycle tracking

Example:

```bash
meridian-roles run --thread-id codex_01 --command /Users/yzliu/work/Meridian/docs/branch/feat-cli-external-integration/agent_dispatch_command.md --worker N-07
```

### `kill`

Request Meridian hub to stop a running coding agent thread.

Params:
- `--thread-id <id>`: required thread id

Example:

```bash
meridian-roles kill --thread-id codex_01
```

### `notify`

Send a reply through Meridian's configured reply channel or channels.

Params:
- `--message <text>`: required notification body
- `--urgency <low|normal|high>`: optional priority hint
- `--reply-channel <json>`: optional single reply channel override
- `--reply-channels <json-array>`: optional multi-channel override

Examples:

```bash
meridian-roles notify --message "Dispatch batch complete" --reply-channel '{"channel":"web","chat_id":"web:ops"}'
meridian-roles notify --message "Need manual review" --urgency high --reply-channels '[{"channel":"web","chat_id":"web:ops"},{"channel":"telegram","chat_id":"123"}]'
```

If no explicit flag is passed, `notify` falls back to `MERIDIAN_REPLY_CHANNELS`, then `MERIDIAN_REPLY_CHANNEL`.

### `update-status`

Update a worker row in a markdown dispatch plan. When a lifecycle store exists, the CLI updates both lifecycle state and plan markdown through `LifecycleStore`.

Params:
- `--plan <path>`: required dispatch plan path
- `--worker <worker-id>`: required worker id
- `--status <in_progress|done|failed>`: required status transition
- `--thread-id <id>`: optional thread id, required when setting `in_progress` if the lifecycle store needs to persist thread ownership

Example:

```bash
meridian-roles update-status --plan /Users/yzliu/work/Meridian/docs/branch/feat-cli-external-integration/dispatch_plan.md --worker N-07 --status done
```

### `resume-worker`

Recover a stuck `🔄` worker in a dispatch plan.

Params:
- `--plan <path>`: required dispatch plan path
- `--worker <worker-id>`: required worker id
- `--action <retry|skip|force-complete>`: optional action, default `retry`
- `--force <true|false>`: required and must be `true` for `force-complete`

Behavior:
- `retry`: resets the worker to pending and kills the current thread if one is recorded
- `skip`: marks the worker as skipped and kills the current thread if one is recorded
- `force-complete`: marks the worker complete and kills the current thread if one is recorded

Examples:

```bash
meridian-roles resume-worker --plan /Users/yzliu/work/Meridian/docs/branch/feat-cli-external-integration/dispatch_plan.md --worker N-07
meridian-roles resume-worker --plan /Users/yzliu/work/Meridian/docs/branch/feat-cli-external-integration/dispatch_plan.md --worker N-07 --action skip
meridian-roles resume-worker --plan /Users/yzliu/work/Meridian/docs/branch/feat-cli-external-integration/dispatch_plan.md --worker N-07 --action force-complete --force true
```

The Meridian-roles GUI exposes the same retry/skip/force-complete actions for running workers and shows stale worker badges sourced from the same dispatch status data.

### `dispatch-status`

Read the dispatch plan plus sibling `dispatch_threads.json`, enrich workers with lifecycle state, and flag stale running workers.

Params:
- `--plan <path>`: required dispatch plan path
- `--stale-threshold <minutes>`: optional stale threshold, default `30`

Example:

```bash
meridian-roles dispatch-status --plan /Users/yzliu/work/Meridian/docs/branch/feat-cli-external-integration/dispatch_plan.md --stale-threshold 45
```

Typical payload fields:
- `workers[]`: plan rows plus `lifecycle_status`, `thread_id`, `last_seen_at`, `stale`, `stale_label`, `stale_duration_minutes`, `stale_duration_human`
- `summary`: `total`, `pending`, `running`, `completed`, `failed`, `skipped`, `stale`

### `dispatch-start`

Start an `agent-dispatcher` session for a dispatch plan. This command requires the local Meridian-roles HTTP service and also depends on Meridian hub because the dispatcher spawns workers through Meridian.

Params:
- `--plan <path>`: required dispatch plan path
- `--model-map <CODE=provider:model,...>`: optional inline model override map
- `--model-map-file <path>`: optional JSON file containing `{ "CODE": { "provider": "...", "model_id": "..." } }`

Rules:
- Pass either `--model-map` or `--model-map-file`, not both.
- The command expects `agent_dispatch_command.md` to live beside the dispatch plan.
- Unknown model codes are kept as overrides and returned as warnings.

Examples:

```bash
meridian-roles dispatch-start --plan /Users/yzliu/work/Meridian/docs/branch/feat-cli-external-integration/dispatch_plan.md --model-map 'CODEX=codex:gpt-5.4,OPUS=claude:claude-opus-4-6'
meridian-roles dispatch-start --plan /Users/yzliu/work/Meridian/docs/branch/feat-cli-external-integration/dispatch_plan.md --model-map-file /tmp/model-map.json
```

Success payload includes:
- `dispatcher_id`
- `dispatcher_thread_id`
- `reply_channels`
- `reply_channel_source`
- `model_map`
- `warnings`
- `dispatch_status`

### `list-roles`

List configured Meridian roles by querying `GET /api/roles`.

Params:
- none

Example:

```bash
meridian-roles list-roles
```

Typical success payload:

```json
{"ok":true,"data":{"roles":[{"thread_id":"dispatcher-demo","role_type":"agent-dispatcher","status":"running","task_count":3}],"count":1}}
```

### `health`

Check Meridian-roles service health by querying `GET /api/health`.

Params:
- none

Example:

```bash
meridian-roles health
```

Typical success payload:

```json
{"ok":true,"data":{"ok":true,"version":"1.2.0","uptime":1295,"agents_count":2,"roles_count":2}}
```

## Common Flows

Verify the CLI and service:

```bash
meridian-roles --help
meridian-roles health
meridian-roles list-roles
```

Start and inspect a dispatch:

```bash
meridian-roles dispatch-start --plan /Users/yzliu/work/Meridian/docs/branch/feat-cli-external-integration/dispatch_plan.md --model-map 'CODEX=codex:gpt-5.4'
meridian-roles dispatch-status --plan /Users/yzliu/work/Meridian/docs/branch/feat-cli-external-integration/dispatch_plan.md
```

Recover a stuck worker:

```bash
meridian-roles resume-worker --plan /Users/yzliu/work/Meridian/docs/branch/feat-cli-external-integration/dispatch_plan.md --worker N-07 --action retry
```

## Notes

- `Meridian` is a runtime dependency for hub-backed tools and for all dispatcher worker execution.
- Parse stdout as the stable machine interface; stderr is for operator-facing usage text.
- If you use `notify`, provide reply channel JSON explicitly or export `MERIDIAN_REPLY_CHANNEL` / `MERIDIAN_REPLY_CHANNELS` first.
