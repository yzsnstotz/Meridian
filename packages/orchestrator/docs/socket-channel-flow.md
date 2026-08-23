# Socket Channel Flow

This document traces the full result path from `DispatcherRole` to Meridian and back into `meridian-roles`.

## Sequence diagram

```text
[1] src/roles/definitions/dispatcher.ts :: dispatchTask()
    builds HubMessage with:
    - reply_channel.channel = "socket"
    - reply_channel.chat_id = "service:meridian-roles"
    - reply_channel.socket_path = ROLES_SOCKET_PATH
    - suppress_reply = false

[2] src/roles/role-runner.ts :: RoleContext.sendToHub()
    passes the HubMessage to A2AClient

[3] src/a2a/client.ts :: A2AClient.send()
    queues and flushes the HubMessage to HUB_SOCKET_PATH

[4] Meridian hub
    receives the HubMessage and executes the requested task

[5] Meridian SocketChannelAdapter :: sendIpcMessage()
    writes JSON to reply_channel.socket_path with socket.end(JSON.stringify(payload))

[6] src/a2a/server.ts :: A2AServer.listen()
    accepts the socket callback on ROLES_SOCKET_PATH

[7] src/a2a/server.ts :: A2AServer.handleInbound()
    parses the raw JSON into HubResultSchema

[8] src/roles/role-runner.ts :: RoleRunner.dispatch()
    routes the HubResult by result.thread_id

[9] src/roles/definitions/dispatcher.ts :: onInboundResult()
    matches the task by result.trace_id, updates state, dispatches next tasks,
    and eventually emits the completion summary to user_reply_channel
```

## Step-by-step references

| Step | Component | Code reference | What happens |
|------|-----------|----------------|--------------|
| 1 | Dispatcher build | `src/roles/definitions/dispatcher.ts :: dispatchTask()` | Creates the outbound `HubMessage` for a ready task. |
| 2 | Reply channel shape | `src/roles/definitions/dispatcher.ts :: buildSocketReplyChannel()` | Hard-codes the callback channel to the roles socket. |
| 3 | Service registration | `src/a2a/client.ts :: buildRegisterMessage()` | Registers `service:meridian-roles` with the hub at startup. |
| 4 | Outbound send | `src/a2a/client.ts :: sendFireAndForget()` | Opens the hub socket, writes the JSON payload, and closes. |
| 5 | Inbound socket server | `src/a2a/server.ts :: listen()` | Removes stale socket files and starts the roles callback server. |
| 6 | Inbound parse | `src/a2a/server.ts :: handleInbound()` | Parses the callback JSON into `HubResultSchema`. |
| 7 | Role dispatch | `src/roles/role-runner.ts :: dispatch()` | Finds the active role by `thread_id`. |
| 8 | State transition | `src/roles/definitions/dispatcher.ts :: onInboundResult()` | Marks the task done/failed, persists state, and triggers downstream tasks. |
| 9 | Completion summary | `src/roles/definitions/dispatcher.ts :: maybeSendCompletionSummary()` | Sends the final Markdown summary to the original `user_reply_channel`. |

## Payload contracts

### Outbound task message

`dispatchTask()` sends:

```json
{
  "intent": "run",
  "mode": "bridge",
  "reply_channel": {
    "channel": "socket",
    "chat_id": "service:meridian-roles",
    "socket_path": "/tmp/meridian-roles.sock"
  },
  "suppress_reply": false
}
```

### Inbound callback result

`A2AServer.handleInbound()` expects a `HubResultSchema` payload with:

- `trace_id`
- `thread_id`
- `source`
- `status`
- `content`
- `attachments`
- `timestamp`

The critical join key is `trace_id`. `DispatcherRole.onInboundResult()` uses it to map the callback to the task's stored `result_trace_id`.

## Why the socket matters

The socket callback removes any need for result polling:

- Meridian does not need to know dispatcher internals.
- `meridian-roles` does not need a webhook server reachable outside the host.
- The same transport works for explicit DAG runs and inferred mode.

## Verification

`tests/e2e/scenario-e.ts` validates the key invariants:

- the outbound `reply_channel` is `socket`
- the socket path is `/tmp/meridian-roles.sock`
- the inbound `HubResult.trace_id` matches the dispatch `trace_id`
- the persisted role state stores that same `result_trace_id`
