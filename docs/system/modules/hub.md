# hub
**Source**: `src/hub/`
**Summary**: Core hub orchestration for IPC routing, agent lifecycle, persisted conversation state, pane streaming, and multi-channel result delivery; `index.ts` boots `HubServer` and log retention.
**Last Scanned**: `2026-04-08T14:10:55+09:00`
**Exports Documented**: 47

`src/hub/index.ts` is the non-exported runtime entrypoint. It constructs the default `HubServer`, starts the log-retention worker, and installs `SIGINT`/`SIGTERM` shutdown handling.

## Exports

**src/hub/a2a-websocket-log.ts**

### `appendA2AWebSocketLog(logDir: string, threadId: string, payloadJsonLine: string): void`
- **File**: `src/hub/a2a-websocket-log.ts:8`
- **Purpose**: Appends one JSON-line A2A WebSocket payload to the GUI audit log for a thread.
- **Implementation**: Returns early for blank thread IDs or payloads, ensures `LOG_DIR/GUI` exists, and appends to `a2a-{threadId}.log`. Filesystem errors are swallowed so websocket fanout never fails just because audit logging does.
- **Dependencies**: None
- **Status**: [ADDED 2026-04-08T14:10:55+09:00]

**src/hub/channel-adapter.ts**

### `ChannelAdapter`
- **File**: `src/hub/channel-adapter.ts:3`
- **Purpose**: Defines the transport adapter contract used to deliver hub results over a concrete reply channel.
- **Implementation**: The interface requires a channel discriminator plus `canHandle` and async `send` methods. `ResultSender` relies on this shape to choose the first compatible transport implementation at runtime.
- **Dependencies**: `types`
- **Status**: [ADDED 2026-04-08T14:10:55+09:00]

**src/hub/instance-manager.ts**

### `InstanceStatus`
- **File**: `src/hub/instance-manager.ts:43`
- **Purpose**: Packages an agent registry entry with the latest raw agentapi status payload.
- **Implementation**: `status()` returns this shape after probing the live process and reconciling the registry status with the agent-reported status document.
- **Dependencies**: `types`
- **Status**: [ADDED 2026-04-08T14:10:55+09:00]

### `SessionBinding`
- **File**: `src/hub/instance-manager.ts:48`
- **Purpose**: Describes the outcome of attaching a chat session to a thread.
- **Implementation**: It captures the sanitized session key, the bound `thread_id`, and any previous thread binding that was replaced during the attach call.
- **Dependencies**: `types`
- **Status**: [ADDED 2026-04-08T14:10:55+09:00]

### `ThreadAttachment`
- **File**: `src/hub/instance-manager.ts:54`
- **Purpose**: Summarizes which sessions are attached to a thread and which interface namespace they belong to.
- **Implementation**: `getThreadAttachment()` derives this record from session bindings and infers a single `interface_id` from the attached session keys when possible.
- **Dependencies**: `types`
- **Status**: [ADDED 2026-04-08T14:10:55+09:00]

### `RehydrationResult`
- **File**: `src/hub/instance-manager.ts:59`
- **Purpose**: Reports which persisted threads were restored and which stale threads were pruned during startup recovery.
- **Implementation**: `rehydrateFromState()` fills the two thread ID arrays after probing each persisted instance and discarding entries that no longer answer readiness checks.
- **Dependencies**: `hub/state-store`
- **Status**: [ADDED 2026-04-08T14:10:55+09:00]

### `StreamSpawnResult`
- **File**: `src/hub/instance-manager.ts:64`
- **Purpose**: Carries the subprocess handles used by direct streaming runs.
- **Implementation**: `spawnStreamAgent()` returns the spawned child process together with its readable stdout stream so `HubRouter` can parse live deltas and manage process shutdown.
- **Dependencies**: `types`
- **Status**: [ADDED 2026-04-08T14:10:55+09:00]

### `InstanceManagerOptions`
- **File**: `src/hub/instance-manager.ts:69`
- **Purpose**: Provides constructor overrides for process spawning, readiness probing, pane capture, and model catalog behavior.
- **Implementation**: The options object injects the agentapi binary path, workdir, child-process helpers, socket feature flags, client factory, pane timing knobs, and model catalog dependencies used by the manager.
- **Dependencies**: `config`, `shared/agentapi-client`, `shared/model-catalog`
- **Status**: [ADDED 2026-04-08T14:10:55+09:00]

### `InstanceManager`
- **File**: `src/hub/instance-manager.ts:115`
- **Purpose**: Owns agent process lifecycle, session attachments, pane capture, and readiness probing for hub-managed threads.
- **Implementation**: It spawns and restarts agents with socket-or-port endpoint negotiation, supports direct streaming subprocesses, manages tmux-backed `pane_bridge` sessions, and reconciles live processes with persisted state on startup. It also handles terminal input delivery, model switching, socket cleanup, Gemini prompt readiness checks, log capture, and child-process teardown without leaking bindings.
- **Dependencies**: `agents/claude`, `agents/codex`, `agents/cursor`, `agents/gemini`, `config`, `hub/registry`, `hub/state-store`, `logger`, `shared/agentapi-client`, `shared/approval`, `shared/model-catalog`, `shared/terminal-text`, `types`
- **Status**: [ADDED 2026-04-08T14:10:55+09:00]

**src/hub/normalizer.ts**

### `NormalizerContext`
- **File**: `src/hub/normalizer.ts:17`
- **Purpose**: Supplies chat/session defaults needed to turn interface events into hub messages.
- **Implementation**: The router uses these fields to fill composite chat IDs, actor IDs, bot IDs, and fallback thread bindings when a slash command omits them.
- **Dependencies**: `types`
- **Status**: [ADDED 2026-04-08T14:10:55+09:00]

### `normalizeInboundEvent(event: InboundUIEvent, context: NormalizerContext): HubMessage`
- **File**: `src/hub/normalizer.ts:319`
- **Purpose**: Converts an inbound interface event or slash command into a validated `HubMessage`.
- **Implementation**: It parses slash-command arguments for intents like `/spawn`, `/kill`, `/attach`, `/approve`, `/model`, and `/update`, resolves defaults from the current session context, and emits a schema-validated message with a fresh trace ID and normalized reply channel.
- **Dependencies**: `shared/approval`, `types`
- **Status**: [ADDED 2026-04-08T14:10:55+09:00]

**src/hub/output-bus.ts**

### `OutputBusDispatchSink`
- **File**: `src/hub/output-bus.ts:8`
- **Purpose**: Describes a sink callback that receives both the converted A2A message and the original output delta for a trace.
- **Implementation**: `OutputBus` uses this signature for adapter fanout and websocket fanout, allowing sinks to be synchronous or promise-returning.
- **Dependencies**: `shared/a2a-adapter`, `shared/stream-adapter`
- **Status**: [ADDED 2026-04-08T14:10:55+09:00]

### `OutputBusRecordHook`
- **File**: `src/hub/output-bus.ts:14`
- **Purpose**: Describes a hook that records or indexes output before it is delivered.
- **Implementation**: The record hook receives the trace ID, normalized `OutputDelta`, and derived `A2AMessage`, which lets callers persist monitor snapshots without duplicating conversion logic.
- **Dependencies**: `shared/a2a-adapter`, `shared/stream-adapter`
- **Status**: [ADDED 2026-04-08T14:10:55+09:00]

### `OutputBusOptions`
- **File**: `src/hub/output-bus.ts:20`
- **Purpose**: Configures the diff engine, A2A adapter, and optional delivery hooks used by `OutputBus`.
- **Implementation**: Each field is optional so tests and alternate runtimes can replace snapshot diffing, transport conversion, adapter fanout, websocket fanout, or recording behavior independently.
- **Dependencies**: `shared/a2a-adapter`, `shared/diff-engine`, `shared/stream-adapter`
- **Status**: [ADDED 2026-04-08T14:10:55+09:00]

### `OutputBus`
- **File**: `src/hub/output-bus.ts:97`
- **Purpose**: Centralizes streaming-output diffing and fanout to transport sinks, websocket sinks, and record hooks.
- **Implementation**: It converts full snapshots into incremental deltas via `DiffEngine`, normalizes final results and errors into a consistent `OutputDelta`, converts each delta to A2A format, and asynchronously dispatches to every configured sink. Empty non-final deltas are dropped, and `finalize()` clears the diff state for the trace.
- **Dependencies**: `shared/a2a-adapter`, `shared/diff-engine`, `shared/stream-adapter`
- **Status**: [ADDED 2026-04-08T14:10:55+09:00]

**src/hub/pane-broadcaster.ts**

### `PaneBroadcasterOptions`
- **File**: `src/hub/pane-broadcaster.ts:33`
- **Purpose**: Configures pane-log watching, timestamps, and flush throttling for websocket broadcast sessions.
- **Implementation**: Callers can override the log directory, clock, `fs.watch` implementation, and throttle interval used to batch pane-log updates.
- **Dependencies**: `config`
- **Status**: [ADDED 2026-04-08T14:10:55+09:00]

### `PaneSubscriptionResult`
- **File**: `src/hub/pane-broadcaster.ts:40`
- **Purpose**: Represents either a successful pane subscription or a typed not-available response.
- **Implementation**: `subscribe()` returns `"subscribed"` when a pane log can be tailed, otherwise it returns a schema-validated `PaneOutputNotAvailable` payload that callers can write directly to the websocket.
- **Dependencies**: `types`
- **Status**: [ADDED 2026-04-08T14:10:55+09:00]

### `PaneBroadcaster`
- **File**: `src/hub/pane-broadcaster.ts:44`
- **Purpose**: Watches `pane-{thread}.log` files and streams new pane output to websocket subscribers and optional push callbacks.
- **Implementation**: It maintains one watcher per thread, supports replaying the last N lines on subscribe, throttles flushes, hashes chunks to suppress duplicates, mirrors GUI-visible pane output into `LOG_DIR/GUI`, and cleans up watchers automatically when sockets close or no subscribers remain.
- **Dependencies**: `config`, `types`
- **Status**: [ADDED 2026-04-08T14:10:55+09:00]

**src/hub/pane-log.ts**

### `appendRunResultToPaneLog(threadId: string, content: string, logDir: string): Promise<boolean>`
- **File**: `src/hub/pane-log.ts:22`
- **Purpose**: Persists final run output into a pane log when pane capture might have missed it.
- **Implementation**: It normalizes the text, scans the recent log tail for exact or last-lines duplicates, and appends a timestamped block only when the content is genuinely new.
- **Dependencies**: `shared/terminal-text`
- **Status**: [ADDED 2026-04-08T14:10:55+09:00]

### `appendUserRunToPaneLog(threadId: string, content: string, logDir: string): Promise<boolean>`
- **File**: `src/hub/pane-log.ts:36`
- **Purpose**: Persists the user’s submitted run prompt into the pane log for `pane_bridge` sessions.
- **Implementation**: It reuses the same deduplicating append path as run results so the pane log remains the single durable record even when tmux capture misses user input frames.
- **Dependencies**: `shared/terminal-text`
- **Status**: [ADDED 2026-04-08T14:10:55+09:00]

**src/hub/registry.ts**

### `InstanceRegistry`
- **File**: `src/hub/registry.ts:6`
- **Purpose**: Stores the in-memory set of active agent instances and mutable per-thread flags.
- **Implementation**: The registry clones records on read and write, logs register/unregister transitions, and exposes targeted patch helpers for status, auto-approve, stream capability, and Codex session ID updates.
- **Dependencies**: `logger`, `types`
- **Status**: [ADDED 2026-04-08T14:10:55+09:00]

**src/hub/result-sender.ts**

### `splitTextForTelegram`
- **File**: `src/hub/result-sender.ts:12`
- **Purpose**: Re-exports the Telegram text chunking helper through the hub module surface.
- **Implementation**: The implementation lives in `src/interface/adapters/telegram-adapter.ts`; this file forwards the symbol so hub callers do not need to import the interface module directly.
- **Dependencies**: `interface/adapters/telegram-adapter`
- **Status**: [ADDED 2026-04-08T14:10:55+09:00]

### `decorateTelegramResultText`
- **File**: `src/hub/result-sender.ts:13`
- **Purpose**: Re-exports the helper that formats hub results for Telegram delivery.
- **Implementation**: The forwarded implementation strips Meridian framing, preserves approval prompts, and adds Telegram-specific affordances such as `/detail` or approval hints.
- **Dependencies**: `interface/adapters/telegram-adapter`
- **Status**: [ADDED 2026-04-08T14:10:55+09:00]

### `resolveTelegramDetailRecord`
- **File**: `src/hub/result-sender.ts:14`
- **Purpose**: Re-exports Telegram detail-cache lookup for `/detail` responses.
- **Implementation**: The implementation lives in the Telegram adapter and resolves the full cached detail text for a trace/thread/chat combination after summary delivery.
- **Dependencies**: `interface/adapters/telegram-adapter`
- **Status**: [ADDED 2026-04-08T14:10:55+09:00]

### `shouldPushTelegramProactive`
- **File**: `src/hub/result-sender.ts:15`
- **Purpose**: Re-exports the Telegram push-policy guard used for proactive progress delivery.
- **Implementation**: The forwarded helper decides whether a partial result is worth proactively sending to Telegram rather than waiting for an explicit user request.
- **Dependencies**: `interface/adapters/telegram-adapter`
- **Status**: [ADDED 2026-04-08T14:10:55+09:00]

### `TelegramChannelAdapter`
- **File**: `src/hub/result-sender.ts:16`
- **Purpose**: Re-exports the concrete Telegram `ChannelAdapter` implementation used by hub reply delivery.
- **Implementation**: The class itself lives in the interface adapter module; this re-export keeps Telegram delivery wiring available from the hub module boundary.
- **Dependencies**: `interface/adapters/telegram-adapter`
- **Status**: [ADDED 2026-04-08T14:10:55+09:00]

### `ResultSenderOptions`
- **File**: `src/hub/result-sender.ts:17`
- **Purpose**: Re-exports the Telegram adapter options type under a hub-local name.
- **Implementation**: This is an alias of `TelegramAdapterOptions`, allowing callers to configure Telegram sending without importing the interface adapter module directly.
- **Dependencies**: `interface/adapters/telegram-adapter`
- **Status**: [ADDED 2026-04-08T14:10:55+09:00]

### `ResultSender`
- **File**: `src/hub/result-sender.ts:20`
- **Purpose**: Validates a hub result and delivers it through the first adapter that can handle the reply channel.
- **Implementation**: `sendResult()` parses both the result and reply channel with shared schemas, picks a matching adapter by `canHandle()`, and delegates transport-specific sending or throws when no adapter is registered.
- **Dependencies**: `hub/channel-adapter`, `types`
- **Status**: [ADDED 2026-04-08T14:10:55+09:00]

**src/hub/router.ts**

### `MonitorUpdateDispatch`
- **File**: `src/hub/router.ts:92`
- **Purpose**: Describes a due monitor-update delivery for one thread and one reply target.
- **Implementation**: `collectDueMonitorUpdateDispatches()` emits this shape so `HubServer` can group, throttle, and deliver monitor progress updates independently from routing.
- **Dependencies**: `types`
- **Status**: [ADDED 2026-04-08T14:10:55+09:00]

### `ConversationHistoryEntry`
- **File**: `src/hub/router.ts:106`
- **Purpose**: Defines the canonical in-memory conversation record stored per thread.
- **Implementation**: Each entry carries a stable ID and sequence, normalized event kind, summary text, details/raw text, trace metadata, and a `replace_key` used to collapse approval/progress updates into a single evolving record.
- **Dependencies**: `hub/state-store`
- **Status**: [ADDED 2026-04-08T14:10:55+09:00]

### `PushDeliveryTarget`
- **File**: `src/hub/router.ts:129`
- **Purpose**: Identifies a thread-specific push subscriber and the reply channel used to notify it.
- **Implementation**: The router builds these records from its per-thread push-subscription maps so `HubServer` can fan out pane text without re-deriving routing metadata.
- **Dependencies**: `types`
- **Status**: [ADDED 2026-04-08T14:10:55+09:00]

### `HubRouterOptions`
- **File**: `src/hub/router.ts:158`
- **Purpose**: Supplies injectable dependencies for clients, lifecycle management, output dispatch, persistence, and service routing.
- **Implementation**: Tests and alternate runtimes can override the agent client factory, `InstanceManager`, clock, `OutputBus`, persisted state path, and `ServiceRegistry` without changing router logic.
- **Dependencies**: `config`, `hub/instance-manager`, `hub/output-bus`, `hub/service-registry`, `shared/agentapi-client`
- **Status**: [ADDED 2026-04-08T14:10:55+09:00]

### `HubRouter`
- **File**: `src/hub/router.ts:317`
- **Purpose**: Routes normalized hub intents to built-in thread operations or registered services while maintaining thread-local state and conversation history.
- **Implementation**: It initializes from persisted state, handles `run`/`spawn`/`attach`/`push`/`history`/service-registration flows, tracks active runs and cooldowns, records canonical conversation history, and persists every mutation back through `state-store`. For run execution it supports direct streamed subprocesses for supported providers, falls back to agentapi polling when needed, and extracts Meridian summary blocks or stable snapshots to build final or partial results.
- **Dependencies**: `agents/claude`, `agents/codex`, `agents/gemini`, `config`, `hub/instance-manager`, `hub/output-bus`, `hub/registry`, `hub/result-sender`, `hub/service-registry`, `hub/state-store`, `logger`, `shared/agent-output`, `shared/agentapi-client`, `shared/approval`, `shared/ipc`, `shared/stream-adapter`, `shared/stream-parsers/claude`, `shared/stream-parsers/codex`, `shared/stream-parsers/gemini`, `shared/telegram-controls`, `types`
- **Status**: [ADDED 2026-04-08T14:10:55+09:00]

**src/hub/server.ts**

### `HubServerOptions`
- **File**: `src/hub/server.ts:44`
- **Purpose**: Configures the socket path and the injected hub routing and delivery components used by the server.
- **Implementation**: The options surface allows callers to replace the router, result sender, pane broadcaster, static service registrations, or output bus while preserving the standard server lifecycle.
- **Dependencies**: `hub/output-bus`, `hub/pane-broadcaster`, `hub/result-sender`, `hub/router`, `types`
- **Status**: [ADDED 2026-04-08T14:10:55+09:00]

### `resolveStaticServiceEndpoints(appConfig: AppConfig = config): ServiceEndpoint[]`
- **File**: `src/hub/server.ts:53`
- **Purpose**: Builds the configured static service-registration list for the hub process.
- **Implementation**: It returns no endpoints unless a coordinator socket path and intents are configured, otherwise it validates and returns a single coordinator `ServiceEndpoint`.
- **Dependencies**: `config`, `types`
- **Status**: [ADDED 2026-04-08T14:10:55+09:00]

### `HubServer`
- **File**: `src/hub/server.ts:135`
- **Purpose**: Runs the hub IPC server, normalizes inbound frames, routes them, and delivers results across socket, Telegram, web, and websocket channels.
- **Implementation**: On startup it rehydrates router state, registers static services, installs monitor/idempotency timers, and wires `OutputBus` hooks for adapter delivery, websocket A2A messages, and history recording. At runtime it handles pane subscribe/unsubscribe frames, priority-queues non-immediate messages, processes monitor events and completion alerts, accumulates pane-output push notifications with deduplication, and reuses router history to send detail-rich final replies.
- **Dependencies**: `config`, `hub/a2a-websocket-log`, `hub/normalizer`, `hub/output-bus`, `hub/pane-broadcaster`, `hub/registry`, `hub/result-sender`, `hub/router`, `hub/socket-adapter`, `interface/adapters/telegram-adapter`, `interface/adapters/web-adapter`, `logger`, `monitor/events`, `shared/a2a-adapter`, `shared/agent-output`, `shared/stream-adapter`, `shared/telegram-controls`, `types`
- **Status**: [ADDED 2026-04-08T14:10:55+09:00]

**src/hub/service-registry.ts**

### `ServiceRegistry`
- **File**: `src/hub/service-registry.ts:3`
- **Purpose**: Tracks external service endpoints and resolves custom intents to the correct callback socket.
- **Implementation**: It validates each registered endpoint, replaces prior registrations for the same service, updates reverse intent lookups on register/unregister, and returns cloned endpoint lists for callers.
- **Dependencies**: `types`
- **Status**: [ADDED 2026-04-08T14:10:55+09:00]

**src/hub/socket-adapter.ts**

### `SocketChannelAdapter`
- **File**: `src/hub/socket-adapter.ts:6`
- **Purpose**: Implements `ChannelAdapter` for IPC socket reply delivery.
- **Implementation**: It only accepts reply channels whose `channel` is `"socket"`, requires a `socket_path`, and forwards the `HubResult` to `sendIpcMessage()`.
- **Dependencies**: `hub/channel-adapter`, `shared/ipc`, `types`
- **Status**: [ADDED 2026-04-08T14:10:55+09:00]

**src/hub/state-store.ts**

### `ConversationEventKindSchema`
- **File**: `src/hub/state-store.ts:14`
- **Purpose**: Defines the allowed persisted conversation event kinds used by hub history.
- **Implementation**: The zod enum is shared by migration logic, persisted-history validation, and router replacement rules for progress, approval, and final reply entries.
- **Dependencies**: `shared/approval`, `types`
- **Status**: [ADDED 2026-04-08T14:10:55+09:00]

### `ConversationEventKind`
- **File**: `src/hub/state-store.ts:15`
- **Purpose**: Provides the TypeScript union for persisted conversation event kinds.
- **Implementation**: It is inferred directly from `ConversationEventKindSchema`, keeping the runtime validator and compile-time event labels in sync.
- **Dependencies**: `shared/approval`, `types`
- **Status**: [ADDED 2026-04-08T14:10:55+09:00]

### `PersistedHubState`
- **File**: `src/hub/state-store.ts:61`
- **Purpose**: Describes the versioned on-disk hub state snapshot.
- **Implementation**: The type mirrors the validated v2 schema containing instances, session bindings, push subscriptions, and conversation history records that `HubRouter` rehydrates on startup.
- **Dependencies**: `shared/approval`, `types`
- **Status**: [ADDED 2026-04-08T14:10:55+09:00]

### `PersistedPushSubscription`
- **File**: `src/hub/state-store.ts:62`
- **Purpose**: Describes one persisted push-subscription target for a thread.
- **Implementation**: Each record captures the session ID, chat ID, and optional bot ID needed to rebuild push delivery targets after restart.
- **Dependencies**: `shared/approval`, `types`
- **Status**: [ADDED 2026-04-08T14:10:55+09:00]

### `PersistedConversationHistoryEntry`
- **File**: `src/hub/state-store.ts:63`
- **Purpose**: Describes one persisted conversation-history row in the state file.
- **Implementation**: The type stores ordered sequence numbers, event kind, summary/details/raw text, trace metadata, and replace keys so router history can be restored losslessly.
- **Dependencies**: `shared/approval`, `types`
- **Status**: [ADDED 2026-04-08T14:10:55+09:00]

### `buildEmptyPersistedHubState(nowIso: string): PersistedHubState`
- **File**: `src/hub/state-store.ts:185`
- **Purpose**: Creates a fresh empty v2 hub-state snapshot.
- **Implementation**: It returns a fully initialized object with the supplied timestamp and empty instance, session, push-subscription, and conversation-history collections.
- **Dependencies**: `shared/approval`, `types`
- **Status**: [ADDED 2026-04-08T14:10:55+09:00]

### `buildPersistedHubState(nowIso: string, instances: AgentInstance[], sessionBindings: Record<string, string>, pushSubscriptions: Record<string, PersistedPushSubscription[]> = {}, conversationHistory: Record<string, PersistedConversationHistoryEntry[]> = {}): PersistedHubState`
- **File**: `src/hub/state-store.ts:196`
- **Purpose**: Validates and assembles a v2 hub-state snapshot from live registry and history data.
- **Implementation**: The function pipes the supplied instances, bindings, push subscriptions, and conversation history through the zod schema so callers persist only normalized state.
- **Dependencies**: `shared/approval`, `types`
- **Status**: [ADDED 2026-04-08T14:10:55+09:00]

### `loadPersistedHubState(statePath: string, nowIso: string): PersistedHubState`
- **File**: `src/hub/state-store.ts:213`
- **Purpose**: Loads persisted hub state from disk with legacy migration and safe fallback behavior.
- **Implementation**: It reads and parses the JSON file, accepts current v2 state, migrates legacy v1 history entries into the new event model when possible, and returns an empty state on missing files or parse failures.
- **Dependencies**: `shared/approval`, `types`
- **Status**: [ADDED 2026-04-08T14:10:55+09:00]

### `savePersistedHubState(statePath: string, state: PersistedHubState): void`
- **File**: `src/hub/state-store.ts:234`
- **Purpose**: Persists hub state atomically to disk.
- **Implementation**: It ensures the parent directory exists, writes a `.tmp` JSON file with trailing newline, and renames it into place so callers avoid partially written state files.
- **Dependencies**: `shared/approval`, `types`
- **Status**: [ADDED 2026-04-08T14:10:55+09:00]

## Test Files

- `src/hub/a2a-websocket-log.test.ts`
- `src/hub/instance-manager.test.ts`
- `src/hub/normalizer.test.ts`
- `src/hub/output-bus.test.ts`
- `src/hub/pane-broadcaster.test.ts`
- `src/hub/pane-log.test.ts`
- `src/hub/registry.test.ts`
- `src/hub/result-sender.test.ts`
- `src/hub/router.service-registry.test.ts`
- `src/hub/router.test.ts`
- `src/hub/server.idempotency.test.ts`
- `src/hub/server.monitor.test.ts`
- `src/hub/server.priority-queue.test.ts`
- `src/hub/server.reply-history.test.ts`
- `src/hub/service-registry.test.ts`
- `src/hub/socket-adapter.test.ts`
- `src/hub/state-store.test.ts`
