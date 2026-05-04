# meridian-roles

`meridian-roles` is the standalone role-layer service for Meridian. It owns dispatcher roles, prompt overrides, state persistence, and the role GUI, and it returns task results through Meridian's `reply_channel` socket callback instead of polling.

## What ships in v1.2

- `DispatcherRole` for explicit DAG execution and inferred DAG generation from a TaskSpec
- Prompt hot-reload APIs for the system prompt and per-task instruction templates
- Local GUI pages for the dashboard, role detail, prompt editor, and config editor
- A2A client/server transport over Unix sockets
- E2E scenarios for explicit DAGs, inferred mode, prompt updates, restart recovery rehydration, and socket routing

## Install and start

```bash
cd /Users/yzliu/work/Meridian/Meridian-roles
cp .env.example .env.local
npm install
npm run build
npm start
```

Starter local `.env.local` values:

```bash
HUB_SOCKET_PATH=/tmp/hub-socks/hub-core.sock
ROLES_SOCKET_PATH=/tmp/meridian-roles.sock
GUI_PORT=7701
GUI_LISTEN_HOST=127.0.0.1
# STATE_FILE_PATH defaults to ${XDG_STATE_HOME:-$HOME/.local/state}/meridian-roles/state.json
```

If `STATE_FILE_PATH` is left unset, the service writes to `${XDG_STATE_HOME:-$HOME/.local/state}/meridian-roles/state.json`, which persists across reboot. Do **not** point `STATE_FILE_PATH` at `/tmp` or `/var/tmp` on macOS — those directories are wiped on restart and the registry of registered scheduler/dispatcher roles will silently disappear. Managed deployments may override to `/var/lib/meridian-roles/state.json`.

The service boot path is `src/index.ts`. Startup does three things:

1. Starts `A2AServer` on `ROLES_SOCKET_PATH` to receive callback results.
2. Starts the local HTTP GUI/API service.
3. Registers `service:meridian-roles` with the Meridian hub through `A2AClient.start()`.

## Meridian integration

Prerequisites:

- Meridian must already support `reply_channel.channel = "socket"`.
- Meridian Hub must honor `intent: "reply"` for terminal summaries and `intent: "list"` for instance discovery.
- Meridian's hub socket must match `HUB_SOCKET_PATH`.
- The machine must allow writes to `ROLES_SOCKET_PATH` and `STATE_FILE_PATH`.
- Meridian's GUI link patch from worker `N-09` must be present if you want the "Role Config" link inside Meridian.

Recommended `.env.local`:

```bash
HUB_SOCKET_PATH=/tmp/hub-socks/hub-core.sock
ROLES_SOCKET_PATH=/tmp/meridian-roles.sock
GUI_PORT=7701
GUI_LISTEN_HOST=127.0.0.1
# STATE_FILE_PATH defaults to ${XDG_STATE_HOME:-$HOME/.local/state}/meridian-roles/state.json
```

Once the service is up, Meridian sees it as:

- service id: `service:meridian-roles`
- registration intent: `register_service`
- agent card skill id: `role-coordination`
- role detail URL: `http://localhost:7701/role/<thread_id>`

## Socket channel flow

The dispatcher never waits on Meridian through polling. Every task run includes a socket reply channel:

```text
DispatcherRole.dispatchTask()
  -> RoleRunner ctx.sendToHub()
  -> A2AClient.send()
  -> Meridian hub
  -> SocketChannelAdapter
  -> /tmp/meridian-roles.sock
  -> A2AServer.onResult()
  -> RoleRunner.dispatch()
  -> DispatcherRole.onInboundResult()
```

Task execution still uses `intent: "run"` with the socket reply channel. Terminal dispatcher summaries now use `intent: "reply"` with the original `user_reply_channel`. Automatic routing for `target_model_id`, `target_agent_type`, or idle fallback now asks Meridian Hub for `intent: "list"` instance data; explicit `target_thread_id` still wins.

More detail: [`docs/socket-channel-flow.md`](docs/socket-channel-flow.md)

## Agent-dispatcher control plane

The `agent-dispatcher` flow is service-owned end to end:

- Meridian-roles service selects the next eligible worker and launches it through service helpers. The dispatcher prompt stays in control-flow mode and does not bootstrap worker `spawn` / `run` itself.
- Watchdog recovery and explicit continue use the same service-owned continuation path. Dispatcher rehydration remains available as a bounded fallback, not as a parallel primary loop.
- Dispatcher-managed launches derive `spawn_dir` from the dispatch artifacts in code. Operators should treat prompt wording as advisory, not as the enforcement point for repo-root selection.

Operator-facing debugging signals:

- A missing dispatcher thread during detail/continue fetch now demotes lifecycle state immediately instead of leaving the dispatcher visible as `running` until a later reconcile pass.
- Launch transport errors distinguish "request accepted but no structured reply returned" from "request was never sent". Use the reported `trace_id` plus transport/reply-path details when correlating Hub logs.

## Dispatcher usage

Create an explicit dispatcher:

```bash
curl -X POST http://localhost:7701/api/role \
  -H 'Content-Type: application/json' \
  -d '{
    "thread_id": "dispatcher-demo",
    "user_reply_channel": { "channel": "web", "chat_id": "web:demo" },
    "tasks": [
      { "task_id": "A", "instruction": "Collect facts", "depends_on": [] },
      { "task_id": "B", "instruction": "Write summary", "depends_on": ["A"] }
    ]
  }'
```

Inspect the live state:

```bash
curl http://localhost:7701/api/role/dispatcher-demo
curl http://localhost:7701/api/role/dispatcher-demo/prompts
curl http://localhost:7701/api/role/dispatcher-demo/config
```

Edit dispatcher config (`tasks` and `taskspec` only):

```bash
curl -X PATCH http://localhost:7701/api/role/dispatcher-demo/config \
  -H 'Content-Type: application/json' \
  -d '{
    "tasks": [
      { "task_id": "A", "instruction": "Collect facts", "depends_on": [] },
      { "task_id": "B", "instruction": "Write summary", "depends_on": ["A"] }
    ],
    "taskspec": "Optional TaskSpec text"
  }'
```

If any dispatcher task is `running`, the config endpoint returns `409` and the GUI editor becomes read-only until execution is terminal. Prompt content remains on `/role/:thread_id/prompts`.

Patch the system prompt or a task template:

```bash
curl -X PATCH http://localhost:7701/api/role/dispatcher-demo/prompt \
  -H 'Content-Type: application/json' \
  -d '{ "system_prompt": "Use short bullet points." }'

curl -X PATCH http://localhost:7701/api/role/dispatcher-demo/task/B/template \
  -H 'Content-Type: application/json' \
  -d '{ "instruction_template": "Write a five-line release summary." }'
```

Delete a task template override:

```bash
curl -X DELETE http://localhost:7701/api/role/dispatcher-demo/task/B/template
```

Run inferred mode from a TaskSpec:

```bash
curl -X POST http://localhost:7701/api/role \
  -H 'Content-Type: application/json' \
  -d '{
    "thread_id": "dispatcher-infer",
    "taskspec": "1. Inspect the repository.\n2. Draft a release summary after inspection."
  }'
```

## Dispatch model-routing contract

`Model` on each `dispatch_plan.md` worker row supports both legacy code values and inline `model::effort` syntax:

- `CODEX`, `CODEX-HIGH`, `CODEX-XHIGH` (legacy aliases)
- `MODEL::effort`, e.g. `CODEX::high`
- Optional `Reasoning Effort` column, e.g. `xhigh`, `high`, `medium`, `low`

Precedence is:

1. Explicit row `Model` suffix (`CODEX::high`)
2. `Reasoning Effort` column in that row
3. Legend default effort value
4. Legacy alias defaults:
   - `CODEX` → `medium`
   - `CODEX-HIGH` → `high`
   - `CODEX-XHIGH` → `xhigh`

You can also persist a runtime override using `update-status` while a worker is in progress:

```bash
meridian-roles update-status \
  --plan /Users/yzliu/work/Meridian/docs/branch/feat-cli-external-integration/dispatch_plan.md \
  --worker N-07 \
  --status in_progress \
  --thread-id worker-thread-456 \
  --model gpt-5.5 \
  --reasoning-effort high
```

## New role development guide

Use the five-step flow below when you add a new role type:

1. Implement a class that satisfies `BaseRole` in `src/roles/base-role.ts`.
2. Extend `RoleTypeSchema` in `src/types.ts` and add any role-specific config schema.
3. Register the role factory in the service bootstrap so `RoleRegistry.create()` can construct it.
4. Update `src/server/role-handlers.ts` and any GUI routes you need for create/detail flows.
5. Add unit coverage plus an E2E scenario under `tests/e2e/`.

The full walkthrough, including a working `EchoRole` example, is in [`docs/adding-new-role.md`](docs/adding-new-role.md).

## Testing

```bash
npm run lint
npm test
npm run test:e2e
```

`npm run test:e2e` runs the automated `tests/e2e/scenario-*.ts` suite. Demo utilities in `tests/e2e/` are manual helpers and are not part of the CI gate.

Recommended CI gate:

```bash
npm run lint && npm test && npm run test:e2e
```

`npm run test:e2e` currently covers:

- Scenario A: explicit DAG fan-out after the first task completes
- Scenario B: inferred dispatch from a TaskSpec
- Scenario C: prompt hot-reload before the next dispatch
- Scenario D: restart recovery by rehydrating persisted role state before resumed socket callbacks
- Scenario E: socket reply routing with matching `trace_id`
