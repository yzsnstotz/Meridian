# monitor
**Source**: `src/monitor/`
**Summary**: Monitor event schemas, logger/reporter helpers, and the background service that tracks agent threads over SSE with heartbeat fallback.
**Last Scanned**: 2026-04-08T14:44:32+09:00
**Exports Documented**: 13

## Exports

### `MonitorEventSchema`
- **File**: `src/monitor/events.ts:1`
- **Purpose**: Re-exports the canonical Zod schema for monitor event payloads.
- **Implementation**: `events.ts` is a façade over `src/types.ts`, so monitor callers can import the event schema from the module-local path used by the manager and IPC reporter. The schema validates trace IDs, event type, monitor mode, timestamps, optional status metadata, retry counters, free-form details, and error text.
- **Dependencies**: `types`
- **Status**: `[ADDED 2026-04-08T14:44:32+09:00]`

### `MonitorEventTypeSchema`
- **File**: `src/monitor/events.ts:1`
- **Purpose**: Re-exports the allowed monitor event-type enum schema.
- **Implementation**: The underlying enum in `src/types.ts` constrains monitor traffic to `task_completed`, `status_changed`, `heartbeat_missed`, `agent_error`, and `sse_reconnect_failed`, which keeps both the manager and hub-side consumers on the same vocabulary.
- **Dependencies**: `types`
- **Status**: `[ADDED 2026-04-08T14:44:32+09:00]`

### `MonitorModeSchema`
- **File**: `src/monitor/events.ts:1`
- **Purpose**: Re-exports the schema for the monitor transport mode attached to each event.
- **Implementation**: The enum only allows `sse_hook` and `heartbeat`, matching the two execution modes that `MonitorManager` switches between as live streams fail over to polling.
- **Dependencies**: `types`
- **Status**: `[ADDED 2026-04-08T14:44:32+09:00]`

### `MonitorEvent`
- **File**: `src/monitor/events.ts:1`
- **Purpose**: Re-exports the TypeScript type inferred from the monitor event schema.
- **Implementation**: The alias gives the reporter and manager a shared payload contract without duplicating the event shape in the monitor module itself.
- **Dependencies**: `types`
- **Status**: `[ADDED 2026-04-08T14:44:32+09:00]`

### `MonitorEventType`
- **File**: `src/monitor/events.ts:1`
- **Purpose**: Re-exports the string-literal union of supported monitor event types.
- **Implementation**: The type mirrors `MonitorEventTypeSchema`, so monitor code can type-check event emission and parsing without hard-coding string unions separately from the schema.
- **Dependencies**: `types`
- **Status**: `[ADDED 2026-04-08T14:44:32+09:00]`

### `MonitorMode`
- **File**: `src/monitor/events.ts:1`
- **Purpose**: Re-exports the type for the monitor mode recorded on emitted events.
- **Implementation**: The alias narrows mode values to the same `sse_hook` and `heartbeat` states enforced by the Zod schema and used inside the manager task state.
- **Dependencies**: `types`
- **Status**: `[ADDED 2026-04-08T14:44:32+09:00]`

### `createMonitorManager(): MonitorManager`
- **File**: `src/monitor/index.ts:12`
- **Purpose**: Builds the production `MonitorManager` instance used by the standalone monitor service.
- **Implementation**: The helper wires a `MonitorIpcReporter` to the configured hub socket path and passes the heartbeat interval and missed-threshold values from `config` into the manager constructor. It centralizes the default runtime wiring so the service entrypoint does not duplicate reporter setup.
- **Dependencies**: `config`, `monitor/ipc-reporter`, `monitor/monitor`
- **Status**: `[ADDED 2026-04-08T14:44:32+09:00]`

### `startMonitorService(): Promise<void>`
- **File**: `src/monitor/index.ts:100`
- **Purpose**: Starts the background process that keeps monitor registrations synchronized with the hub.
- **Implementation**: The function instantiates a manager, polls the hub over IPC for the active `AgentInstance` list, and registers, refreshes, or unregisters per-thread monitor tasks as socket paths, PIDs, and statuses change. It also installs a keepalive timer, logs startup and sync failures, and shuts the manager down cleanly on `SIGINT` or `SIGTERM`.
- **Dependencies**: `config`, `shared/ipc`, `types`, `monitor/ipc-reporter`, `monitor/logger`, `monitor/monitor`
- **Status**: `[ADDED 2026-04-08T14:44:32+09:00]`

### `MonitorIpcReporterOptions`
- **File**: `src/monitor/ipc-reporter.ts:6`
- **Purpose**: Configures socket-path and retry policy overrides for IPC event delivery.
- **Implementation**: The interface exposes optional socket-path, max-attempt, base-delay, and max-delay settings, which the reporter resolves against module defaults and `config.HUB_SOCKET_PATH` in its constructor.
- **Dependencies**: `config`, `shared/ipc`, `monitor/events`, `monitor/logger`
- **Status**: `[ADDED 2026-04-08T14:44:32+09:00]`

### `MonitorIpcReporter`
- **File**: `src/monitor/ipc-reporter.ts:23`
- **Purpose**: Sends validated monitor events to the hub over the Unix-socket IPC channel.
- **Implementation**: The class parses each outgoing payload with `MonitorEventSchema`, submits it with `sendIpcMessage()`, and logs success metadata including thread, mode, and socket path. Failures are retried with exponential backoff up to the configured limit, with each failed attempt logged before the reporter throws a final aggregated error.
- **Dependencies**: `config`, `shared/ipc`, `monitor/events`, `monitor/logger`
- **Status**: `[ADDED 2026-04-08T14:44:32+09:00]`

### `getMonitorLogger(): Logger`
- **File**: `src/monitor/logger.ts:8`
- **Purpose**: Returns the singleton logger used by the monitor subsystem.
- **Implementation**: The helper memoizes the logger, creates a dedicated async file logger in production that writes to `monitor.log` under `config.LOG_DIR`, and otherwise falls back to the shared development logger factory. The production logger stamps monitor-specific base fields so later event and sync logs have stable service metadata.
- **Dependencies**: `config`, `logger`
- **Status**: `[ADDED 2026-04-08T14:44:32+09:00]`

### `MonitorManagerOptions`
- **File**: `src/monitor/monitor.ts:52`
- **Purpose**: Configures dependency injection and timing thresholds for `MonitorManager`.
- **Implementation**: The interface allows callers to override the agent client factory, event reporter, heartbeat interval, missed-heartbeat threshold, SSE reconnect limit, and clock function. Those hooks let tests replace networked dependencies while production code falls back to `AgentAPIClient`, `MonitorIpcReporter`, and config-derived timings.
- **Dependencies**: `config`, `shared/agentapi-client`, `types`, `monitor/events`, `monitor/ipc-reporter`
- **Status**: `[ADDED 2026-04-08T14:44:32+09:00]`

### `MonitorManager`
- **File**: `src/monitor/monitor.ts:65`
- **Purpose**: Owns per-thread monitor tasks and converts agent SSE or heartbeat signals into validated monitor events.
- **Implementation**: The class validates each registered `AgentInstance`, creates an `AgentAPIClient`, subscribes to the agent event stream, and tracks state such as mode, last status, missed heartbeats, reconnect counts, and per-thread subscriptions or timers. When SSE subscription or reconnects fail it falls back to heartbeat polling, emits status and failure events through `MonitorEventSchema`, derives or synthesizes trace IDs, downgrades duplicate status noise, and suppresses reporter failures to logging after retries are exhausted.
- **Dependencies**: `config`, `shared/agentapi-client`, `types`, `monitor/events`, `monitor/ipc-reporter`, `monitor/logger`
- **Status**: `[ADDED 2026-04-08T14:44:32+09:00]`

## Test Files

- `src/hub/server.monitor.test.ts`
